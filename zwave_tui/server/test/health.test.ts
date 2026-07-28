import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNode } from '../src/zwave/health';
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
  assert.ok(alive.rating >= 0 && alive.rating <= 10);
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
  assert.ok(!Number.isNaN(r.rating));
});
