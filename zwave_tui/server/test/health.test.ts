import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNode, rssiReading } from '../src/zwave/health';
import { NodeStatus, type NodeSnapshot, type NodeStats } from '../src/types';

const emptyStats = (over: Partial<NodeStats> = {}): NodeStats => ({
  rtt: null, rssi: null, lwr: null, nlwr: null,
  commandsTX: 0, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0,
  timeoutResponse: 0, lastSeen: null, ...over,
});

const makeNode = (over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  nodeId: 5, deviceId: 'd5', name: 'Node 5', area: null,
  status: NodeStatus.Alive, statusLabel: 'alive', ready: true,
  isRouting: true, isListening: true, isLongRange: false, isController: false,
  isSecure: true, securityClass: 'S2', manufacturer: 'ACME', model: 'X',
  battery: null, firmware: null, stats: emptyStats(), entities: [], ...over,
});

const NOISE = -95;

test('dead node scores 0 / F / dead with a D flag', () => {
  const r = scoreNode(makeNode({ status: NodeStatus.Dead, statusLabel: 'dead' }), NOISE);
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'F');
  assert.equal(r.state, 'dead');
  assert.ok(r.flags.includes('D'));
});

test('unknown node is capped low', () => {
  const r = scoreNode(makeNode({ status: NodeStatus.Unknown, statusLabel: 'unknown', ready: false }), NOISE);
  assert.ok(r.score <= 20, `expected capped-low score, got ${r.score}`);
  assert.equal(r.state, 'unknown');
});

test('alive node scores above a dead one and yields a valid grade', () => {
  const alive = scoreNode(makeNode(), NOISE);
  const dead = scoreNode(makeNode({ status: NodeStatus.Dead, statusLabel: 'dead' }), NOISE);
  assert.ok(alive.score > dead.score);
  assert.match(alive.grade, /^[A-F]$/);
  assert.ok(alive.score >= 0 && alive.score <= 100, 'the score is the only published health scalar');
});

test('battery is a separate lane: low battery flags B but does not change the RF score', () => {
  const mains = scoreNode(makeNode({ battery: null }), NOISE);
  const lowBat = scoreNode(makeNode({ battery: { level: 10, isLow: true } }), NOISE);
  assert.ok(lowBat.flags.includes('B'), 'low battery raises B flag');
  assert.equal(lowBat.score, mains.score, 'battery must not drag the RF score');
});

const fw = (over = {}) => ({ current: '1.0', latest: '1.0', updateAvailable: false, inProgress: false, progressPct: null, targets: 1, ...over });

test('firmware update is advisory: flags U without changing the RF score', () => {
  const base = scoreNode(makeNode({ firmware: fw() }), NOISE);
  const upd = scoreNode(makeNode({ firmware: fw({ updateAvailable: true, latest: '1.2' }) }), NOISE);
  assert.ok(!base.flags.includes('U'), 'no U when firmware is current');
  assert.ok(upd.flags.includes('U'), 'update available raises U flag');
  assert.equal(upd.score, base.score, 'firmware must not drag the RF score');
});

test('U flag appears across states (dead / unknown / controller / healthy)', () => {
  const up = { firmware: fw({ updateAvailable: true }) };
  assert.ok(scoreNode(makeNode({ status: NodeStatus.Dead, statusLabel: 'dead', ...up }), NOISE).flags.includes('U'));
  assert.ok(scoreNode(makeNode({ isController: true, nodeId: 1, ...up }), NOISE).flags.includes('U'));
  assert.ok(scoreNode(makeNode({ stats: emptyStats(), ready: false, ...up }), NOISE).flags.includes('U'));
});

test('response-reliability lane: high timeoutResponse raises F and drags the score', () => {
  // 30 timeouts over 100 sends = 30% → at/above the lane floor: F flag, flaky state.
  const flaky = scoreNode(makeNode({ stats: emptyStats({ commandsTX: 100, timeoutResponse: 30 }) }), NOISE);
  const clean = scoreNode(makeNode({ stats: emptyStats({ commandsTX: 100, timeoutResponse: 0 }) }), NOISE);
  assert.ok(flaky.flags.includes('F'), 'high response-timeout rate raises F');
  assert.equal(flaky.state, 'flaky');
  assert.ok(flaky.score < clean.score, 'timeouts drag the RF score down');
});

test('response-reliability lane IGNORES commandsDroppedTX (RESEARCH.md §0 regression guard)', () => {
  // A node with a large drop count but ZERO response timeouts must NOT be flagged
  // F or scored down — commandsDroppedTX is near-silent for RF loss and noisy
  // otherwise, so the old (droppedTX+timeouts) lane would have false-alarmed here.
  const clean = scoreNode(makeNode({ stats: emptyStats({ commandsTX: 100, timeoutResponse: 0 }) }), NOISE);
  const dropsButNoTimeouts = scoreNode(
    makeNode({ stats: emptyStats({ commandsTX: 100, commandsDroppedTX: 40, timeoutResponse: 0 }) }),
    NOISE,
  );
  assert.ok(!dropsButNoTimeouts.flags.includes('F'), 'droppedTX alone must not raise F');
  assert.equal(dropsButNoTimeouts.score, clean.score, 'droppedTX must not drag the RF score');
});

test('ROUTED node: rssi is the LAST HOP, not the device — Signal scores neutral, never W (RESEARCH §1.3)', () => {
  // Same terrible RSSI, two topologies: direct ⇒ it describes the device's link
  // (W fires); routed ⇒ it describes repeater→controller (neutral, no W).
  const lwrRouted = { repeaters: [7], protocolDataRate: 3, rssi: -93, repeaterRSSI: [], routeFailedBetween: null };
  const lwrDirect = { repeaters: [], protocolDataRate: 3, rssi: -93, repeaterRSSI: [], routeFailedBetween: null };
  const routed = scoreNode(makeNode({ stats: emptyStats({ rssi: -93, lwr: lwrRouted }) }), NOISE);
  const direct = scoreNode(makeNode({ stats: emptyStats({ rssi: -93, lwr: lwrDirect }) }), NOISE);
  assert.ok(direct.flags.includes('W'), 'direct node with 2dB margin raises W');
  assert.ok(!routed.flags.includes('W'), 'routed node must NOT raise W off last-hop RSSI');
  assert.ok(routed.score > direct.score, 'routed node is not penalized for its repeater’s margin');
});

test('Long-Range node scores without error', () => {
  const r = scoreNode(makeNode({ nodeId: 300, isLongRange: true }), NOISE);
  assert.ok(Number.isFinite(r.score));
  assert.match(r.grade, /^[A-F]$/);
});

test('null / partial stats never produce NaN', () => {
  const r = scoreNode(makeNode({ stats: emptyStats({ rssi: null, rtt: null }) }), NOISE);
  assert.ok(Number.isFinite(r.score));
  assert.ok(r.score >= 0 && r.score <= 100, 'and stays in band');
});

test('a NEVER-MEASURED Alive node reads unknown — not a fabricated 84/B "ok" (v0.26)', () => {
  // The emptyStats() fingerprint: no lastSeen, zero traffic, no RF reading.
  // Pre-v0.26 the `!stats` gate was unreachable (buildNode always substitutes
  // emptyStats()), so this node flowed through the neutral lanes to 84/B with
  // "RF health nominal" — an asserted unmeasured B-grade during monitoring
  // holes (add-on boot before the first replay, failed per-node subscription,
  // roster node with no HA device entry).
  const r = scoreNode(makeNode({ stats: emptyStats() }), NOISE);
  assert.equal(r.state, 'unknown', `never-measured node read state "${r.state}"`);
  assert.ok(r.score <= 15, `never-measured node scored ${r.score} (docs promise ≤15)`);
  // A node with ANY evidence of contact is scored normally: a cached RSSI is a
  // real measurement even with zeroed counters (counters reset on driver
  // restart; readings survive).
  const seen = scoreNode(makeNode({ stats: emptyStats({ rssi: -60 }) }), NOISE);
  assert.notEqual(seen.state, 'unknown', 'a cached RSSI is evidence of contact');
});

test('the CONTROLLER grades A/100, not F — its branch precedes the never-measured gate (v0.26)', () => {
  // Node 1 is deliberately excluded from per-node statistics subscriptions, so
  // it ALWAYS carries emptyStats() and matches the never-measured fingerprint
  // exactly. Ordering the gates the other way graded every mesh's controller
  // F/unknown on the roster (v0.26 review reproduced score 10 / grade F).
  const ctrl = scoreNode(makeNode({ nodeId: 1, isController: true, stats: emptyStats() }), NOISE);
  assert.equal(ctrl.grade, 'A', `a live controller graded ${ctrl.grade}`);
  assert.equal(ctrl.score, 100);
  assert.equal(ctrl.state, 'ok');
  // A DEAD controller is still dead — the branch is gated on Alive/Awake.
  const dead = scoreNode(makeNode({ nodeId: 1, isController: true, status: NodeStatus.Dead, stats: emptyStats() }), NOISE);
  assert.equal(dead.state, 'dead');
});

test('rssiReading is the single definition of "is this a reading"', () => {
  // The list of reserved markers can only ever be as current as the last driver
  // release: 0 was NOT in the documented set (127/126/125) and reached the
  // screen as a +100 dB margin. The domain rule cannot go stale — received
  // signal strength on this radio is always negative.
  for (const real of [-1, -50, -68, -86, -128]) {
    assert.equal(rssiReading(real), real, `${real} dBm is a real reading`);
  }
  for (const marker of [0, 125, 126, 127, 1, 100]) {
    assert.equal(rssiReading(marker), null, `${marker} is not a reading`);
  }
  for (const absent of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(rssiReading(absent as number | null | undefined), null, `${String(absent)} is not a reading`);
  }
});

test('a thin denominator cannot outrank a large one (v0.54.0)', () => {
  // The driver's counters RESET on restart, so a 1-6 tx denominator is routine.
  // Without a floor, ONE timeout out of two sends read 50%, raised F, set state
  // 'flaky', and outranked a node failing 4% of 30,000 on the worst-first
  // roster — one packet of evidence beating twelve hundred.
  const thin = scoreNode(makeNode({ nodeId: 9, stats: emptyStats({ commandsTX: 2, timeoutResponse: 1 }) }), NOISE);
  // 5,000 of 30,000 = 16.7%, over TX_ERR_THRESHOLD. Floored, the thin node
  // reads 5% — so the comparison is now between two rates rather than between
  // a rate and an artefact. (Before the floor the thin node read FIFTY percent.)
  const busy = scoreNode(makeNode({ nodeId: 10, stats: emptyStats({ commandsTX: 30_000, timeoutResponse: 5_000 }) }), NOISE);
  assert.ok(!thin.flags.includes('F'),
    `1 timeout of 2 sends is not decisive evidence: ${JSON.stringify(thin)}`);
  assert.notEqual(thin.state, 'flaky', 'and must not be branded flaky on it');
  assert.ok(busy.flags.includes('F'), 'a node failing 16.7% of 30,000 sends IS flaky');
  assert.ok(thin.score > busy.score,
    `the busy node with 5000 real failures must rank worse: thin=${thin.score} busy=${busy.score}`);
  // But decisive thin evidence still counts: 19 of 19 is not silenced.
  const decisive = scoreNode(makeNode({ nodeId: 11, stats: emptyStats({ commandsTX: 19, timeoutResponse: 19 }) }), NOISE);
  assert.ok(decisive.flags.includes('F'),
    `19 timeouts out of 19 sends IS decisive: ${JSON.stringify(decisive)}`);
});
