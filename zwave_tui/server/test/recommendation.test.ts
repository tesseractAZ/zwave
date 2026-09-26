/**
 * sensor.zwave_tui_recommendation (v0.72.0): escalation, not execution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendation, RECOMMEND_PERSIST_MS, RECOMMENDATION_ATTRS, type RecommendationInput } from '../src/zwave/recommendation';
import { NodeStatus, type NodeSnapshot } from '../src/types';
import type { Symptom, SymptomKind } from '../src/zwave/symptoms';

const NOW = 1_800_000_000_000;
const node = (id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  nodeId: id, deviceId: `d${id}`, name: `Node ${id}`, area: null, status: NodeStatus.Alive, statusLabel: 'alive',
  ready: true, isRouting: true, isListening: true, isLongRange: false, isController: false, isSecure: true, securityClass: 'S2',
  manufacturer: null, model: null, battery: null, firmware: null,
  stats: { rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null,
    commandsTX: 100, commandsRX: 100, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: NOW - 1000 },
  entities: [], ...over,
});
const sym = (kind: SymptomKind, nodeId: number | null, ageMs: number, over: Partial<Symptom> = {}): Symptom => ({
  kind, nodeId, severity: 'warn', sinceMs: NOW - ageMs, basis: 'measured', evidence: [{ label: 'x', value: 'y' }], narrative: 'n', ...over,
});
const apNode = (nodeId: number, over: Record<string, unknown> = {}) => ({
  nodeId, deadSinceMs: null, attempts: 0, missStreak: 0, launchFailures: 0, gaveUp: false, launchGaveUp: false, pending: 0, ...over,
});
const inp = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  symptoms: [], nodeOf: (id) => node(id), writeActions: true, efficacyFor: () => null,
  ap: null, startedAt: NOW - 5 * 3_600_000, now: NOW, ...over,
});
const AP = (nodes: ReturnType<typeof apNode>[], suppressed = 'none') => ({ config: { maxAttempts: 3 }, nodes, suppressed } as never);

test('nothing below the persistence bar: 59:59 is none, 60:00 is not (v0.72.0)', () => {
  assert.equal(RECOMMEND_PERSIST_MS, 60 * 60_000);
  assert.equal(buildRecommendation(inp({ symptoms: [sym('rtt-degraded', 7, RECOMMEND_PERSIST_MS - 1000)] })).state, 'none');
  const r = buildRecommendation(inp({ symptoms: [sym('rtt-degraded', 7, RECOMMEND_PERSIST_MS)] }));
  assert.notEqual(r.state, 'none');
  assert.equal(r.attrs.since, new Date(NOW - RECOMMEND_PERSIST_MS).toISOString());
  assert.equal(r.attrs.node_id, 7);
  assert.equal(r.attrs.node_name, 'Node 7');
});

test('a node the ladder gave up on outranks every symptom (v0.72.0)', () => {
  const r = buildRecommendation(inp({
    symptoms: [sym('dead-flap', 5, 3 * 3_600_000, { severity: 'crit' })],
    ap: AP([apNode(9, { gaveUp: true, deadSinceMs: NOW - 2 * 3_600_000 }), apNode(4, { launchGaveUp: true, deadSinceMs: NOW - 3_600_000 })]),
  }));
  assert.equal(r.state, 'summons');
  assert.equal(r.attrs.node_id, 4, 'the lowest node id');
  assert.equal(r.attrs.others, 1);
  assert.equal(r.attrs.symptom, 'node-down');
});

test('a summons headline says what the ladder did, never that a ping often revives it (v0.72.1)', () => {
  const down = sym('node-down', 7, 2 * 3_600_000, { severity: 'crit' });
  const gave = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 2 * 3_600_000, attempts: 3, gaveUp: true })]) }));
  assert.equal(gave.state, 'summons');
  assert.equal(gave.attrs.headline, 'Node is DOWN — auto-ping gave up after 3 unanswered attempts');
  const one = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 3_600_000, attempts: 1, gaveUp: true })]) }));
  assert.equal(one.attrs.headline, 'Node is DOWN — auto-ping gave up after 1 unanswered attempt');
  const unsent = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 3_600_000, attempts: 0, launchGaveUp: true })]) }));
  assert.equal(unsent.attrs.headline, 'Node is DOWN — auto-ping could not send its pings, so the node itself was not tested');
  const both = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 3_600_000, attempts: 3, gaveUp: true, launchGaveUp: true })]) }));
  assert.match(String(both.attrs.headline), /gave up after 3/, 'a ladder that did test the node says so');
  // Before the ladder gives up the planner's headline still leads.
  const paused = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 2 * 3_600_000, attempts: 1 })], 'paused') }));
  assert.match(String(paused.attrs.headline), /a ping often revives it/);
});

test('the first step is never destructive and never blocked: signal problems and a ghost are physical (v0.72.0)', () => {
  for (const kind of ['rate-fallback', 'chatty-device', 'ghost-suspect'] as SymptomKind[]) {
    const r = buildRecommendation(inp({ symptoms: [sym(kind, 7, 61 * 60_000)] }));
    assert.equal(r.state, 'physical', kind);
    assert.equal(r.attrs.action, null, kind);
    assert.notEqual(r.attrs.cost, 'destructive', kind);
  }
  const ghost = buildRecommendation(inp({ symptoms: [sym('ghost-suspect', 7, 61 * 60_000)] }));
  assert.match(String(ghost.attrs.recommendation), /First confirm the device is truly gone/);
});

test('a device the ladder is still working is physical; once it gives up, a summons (v0.72.0)', () => {
  const down = sym('node-down', 7, 2 * 3_600_000, { severity: 'crit' });
  const working = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 2 * 3_600_000, attempts: 1 })]) }));
  assert.equal(working.state, 'physical');
  assert.equal(working.attrs.action, null);
  const done = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 2 * 3_600_000, attempts: 3, gaveUp: true })]) }));
  assert.equal(done.state, 'summons');
  // Paused, the ladder is NOT working it (v0.72.0 review): its attempts do not move.
  const paused = buildRecommendation(inp({ symptoms: [down], ap: AP([apNode(7, { deadSinceMs: NOW - 2 * 3_600_000, attempts: 1 })], 'paused') }));
  assert.equal(paused.state, 'action', 'the person is asked to act, because nothing else is trying');
});

test('an executable first step makes it an action, with the reason a person runs it (v0.72.0)', () => {
  // dead-flap's plan leads with a ping; rtt-degraded's with a physical check.
  const r = buildRecommendation(inp({ symptoms: [sym('dead-flap', 7, 2 * 3_600_000, { severity: 'crit' })] }));
  assert.equal(r.state, 'action');
  assert.equal(r.attrs.action, 'ping');
  assert.equal(r.attrs.manual_because, "runs only as auto-ping's retry; HA returns no result");
  assert.equal(buildRecommendation(inp({ symptoms: [sym('rtt-degraded', 7, 2 * 3_600_000)] })).state, 'physical');
  const off = buildRecommendation(inp({ writeActions: false, symptoms: [sym('dead-flap', 7, 2 * 3_600_000, { severity: 'crit' })] }));
  assert.equal(off.state, 'physical', 'with write actions off, no verb can be the first step');
});

test('severity, then age, then node id pick the one named; subsumed symptoms are ignored (v0.72.0)', () => {
  const r = buildRecommendation(inp({ symptoms: [
    sym('rtt-degraded', 3, 5 * 3_600_000),
    sym('dead-flap', 9, 2 * 3_600_000, { severity: 'crit' }),
    sym('dead-flap', 8, 2 * 3_600_000, { severity: 'crit' }),
    sym('node-down', 2, 9 * 3_600_000, { severity: 'crit', subsumedBy: 'mesh-interference' }),
  ] }));
  assert.equal(r.attrs.node_id, 8);
  assert.equal(r.attrs.others, 2, 'the subsumed one is not counted');
});

test('automatic is false in every state, and the attribute set is exactly the allowlist (v0.72.0)', () => {
  const cases = [
    inp(),
    inp({ symptoms: [sym('rate-fallback', 7, 2 * 3_600_000)] }),
    inp({ symptoms: [sym('rtt-degraded', 7, 2 * 3_600_000)] }),
    inp({ ap: AP([apNode(9, { gaveUp: true, deadSinceMs: NOW - 3_600_000 })]) }),
  ];
  for (const c of cases) {
    const r = buildRecommendation(c);
    assert.equal(r.attrs.automatic, false, r.state);
    assert.deepEqual(Object.keys(r.attrs), [...RECOMMENDATION_ATTRS], r.state);
    assert.equal(r.attrs.watching_since, new Date(NOW - 5 * 3_600_000).toISOString());
  }
  const none = buildRecommendation(inp());
  for (const k of RECOMMENDATION_ATTRS) {
    if (k === 'friendly_name' || k === 'automatic' || k === 'watching_since') continue;
    assert.equal(none.attrs[k], null, `${k} is null on none`);
  }
});
