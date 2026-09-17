import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStates, startHaStates, ENTITY_DEGRADED, ENTITY_SUMMONS, ENTITY_ENGINE } from '../src/haStates';
import type { DataProvider, Symptom } from '../src/types';

const AP = (over: Record<string, unknown> = {}) => ({
  lastTickMs: 1, suppressed: 'none', listening: 35, deadListening: 0, capabilityUnknown: 0,
  staleDue: 0, stalestMs: null, verifyOwed: 0,
  config: { enabled: true, writeActions: true, afterMs: 1, maxAttempts: 3, staleMs: 1 },
  nodes: [], ...over,
});

// `...over` is load-bearing: the first draft omitted it, so every fixture was a
// warn symptom and the CRITICAL test passed while asserting nothing.
const sym = (over: Partial<Symptom> = {}): Symptom =>
  ({ kind: 'dead-flap', nodeId: 7, severity: 'warn', since: 1, narrative: 'x', basis: 'measured', members: [], ...over } as never);

const data = (over: Partial<DataProvider> = {}): DataProvider => ({
  symptoms: () => [],
  engineStatus: () => ({ enabled: true, ready: 3, total: 38, timeoutReady: 38, rttReady: 22, rssiReady: 22, band: 0, bands: 6 }),
  autoPingState: () => AP() as never,
  ...over,
} as never);

const by = (states: ReturnType<typeof buildStates>, id: string) => states.find((s) => s.entity === id)!;

test('a healthy mesh is NOT degraded — an alert that is always on is not an alert', () => {
  // Deliberately not "any symptom exists": a warn-level symptom on one node is
  // the resting state of a real 39-node mesh.
  const syms = [sym(), sym({ nodeId: 9 })];
  assert.ok(syms.every((x) => x.severity === 'warn'), 'fixture guard: these must really be warn-level');
  const s = buildStates(data({ symptoms: () => syms }));
  assert.equal(by(s, ENTITY_DEGRADED).state, 'off', 'two warn symptoms are not a page-worthy event');
  assert.equal(by(s, ENTITY_SUMMONS).state, '0');
});

test('a node the ladder GAVE UP on is a summons, and it degrades the mesh', () => {
  // The ladder has spent its whole budget and is asking for a person — the one
  // conclusion this engine makes that is not advisory.
  const s = buildStates(data({
    autoPingState: () => AP({ nodes: [
      { nodeId: 49, gaveUp: true, launchGaveUp: false },
      { nodeId: 7, gaveUp: false, launchGaveUp: false },
    ] }) as never,
  }));
  assert.equal(by(s, ENTITY_SUMMONS).state, '1');
  assert.deepEqual(by(s, ENTITY_SUMMONS).attrs.node_ids, [49], 'and it names WHICH node');
  assert.equal(by(s, ENTITY_DEGRADED).state, 'on');
  assert.match(String(by(s, ENTITY_DEGRADED).attrs.reason), /need a human/);
});

test('a CRITICAL symptom degrades the mesh; a warning does not', () => {
  const crit = buildStates(data({ symptoms: () => [sym({ severity: 'crit' as never })] }));
  assert.equal(by(crit, ENTITY_DEGRADED).state, 'on');
  assert.match(String(by(crit, ENTITY_DEGRADED).attrs.reason), /critical/);
});

test('an engine that CANNOT SEE the mesh degrades it — a monitoring gap is not health', () => {
  // `no-capability-data` means the driver-WS flag dump is dark, so auto-ping's
  // candidate set is empty by construction (v0.52.0). Reporting that as healthy
  // is the exact defect that fix closed, one surface over.
  for (const why of ['storm', 'no-capability-data']) {
    const s = buildStates(data({ autoPingState: () => AP({ suppressed: why }) as never }));
    assert.equal(by(s, ENTITY_DEGRADED).state, 'on', `${why} must degrade`);
    assert.equal(by(s, ENTITY_ENGINE).state, `suppressed:${why}`,
      'and the REASON survives — storm and no-capability-data mean opposite things');
  }
  // A benign suppression does not page anyone.
  const boot = buildStates(data({ autoPingState: () => AP({ suppressed: 'boot-window' }) as never }));
  assert.equal(by(boot, ENTITY_DEGRADED).state, 'off', 'a boot window is not an incident');
});

test('the publisher no-ops without a token, and never throws on a Core restart', async () => {
  // Bare dev and the test suite must never reach the network; and when HA Core
  // restarts every POST fails at once — which must not crash the add-on.
  let calls = 0;
  const noToken = startHaStates({ data: data(), fetchImpl: (async () => { calls += 1; return new Response('', { status: 200 }); }) as never });
  await noToken.publishNow();
  noToken.stop();
  assert.equal(calls, 0, 'no token ⇒ no network');

  const logs: string[] = [];
  const failing = startHaStates({
    data: data(), token: 't', log: (m) => logs.push(m),
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as never,
  });
  await failing.publishNow();
  await failing.publishNow();
  failing.stop();
  assert.equal(logs.length, 1, 'a repeated failure is latched, not printed every tick');
  assert.match(logs[0], /not reaching HA/);
});

/* ── v0.65.0: a blind engine is a degraded mesh ───────────────────────────── */

test('a statistics feed that has gone SILENT degrades the mesh — the engine is blind (v0.65.0)', () => {
  // The 2026-09-15 audit: a zwave_js config-entry reload orphaned the feeds and
  // this sensor read `off` for 22 h 48 m while every detector starved. An
  // add-on whose evidence has stopped arriving is not a healthy mesh.
  const s = buildStates(data({ lastStatsUpdated: () => Date.now() - 42 * 60_000 } as never));
  assert.equal(by(s, ENTITY_DEGRADED).state, 'on');
  assert.match(String(by(s, ENTITY_DEGRADED).attrs.reason), /statistics feed silent 42m/);
});

test('a feed that is merely quiet for a few minutes does NOT degrade the mesh (v0.65.0)', () => {
  const s = buildStates(data({ lastStatsUpdated: () => Date.now() - 3 * 60_000 } as never));
  assert.equal(by(s, ENTITY_DEGRADED).state, 'off');
});

test('a feed that has never delivered anything is not called silent (v0.65.0)', () => {
  // A fresh start has nothing to have gone quiet — absence of a reading is not
  // a reading of absence.
  const s = buildStates(data({ lastStatsUpdated: () => null } as never));
  assert.equal(by(s, ENTITY_DEGRADED).state, 'off');
  assert.equal(by(s, ENTITY_DEGRADED).attrs.reason, 'none');
});

test('an unchanged healthy mesh still publishes a CHANGED attribute set — the sensor must be able to fail (v0.66.0)', () => {
  // THE defect this pins. HA's `async_set_internal` fast-paths a write whose
  // state and attributes both match what it holds: `last_reported` moves in
  // place, `last_changed`/`last_updated` do not, and that event reaches neither
  // the recorder, nor `subscribe_entities`, nor the REST payload (a cached dict
  // the fast path never invalidates). So a healthy mesh and a DEAD add-on were
  // byte-identical from every surface an automation can reach — the 2026-09-17
  // log review found this entity `off` with last_updated frozen two days, across
  // a full add-on restart. The publisher has to move something itself.
  const healthy = data();
  const a = by(buildStates(healthy, 1_760_000_000_000), ENTITY_DEGRADED);
  const b = by(buildStates(healthy, 1_760_000_000_000 + 61_000), ENTITY_DEGRADED);
  assert.equal(a.state, b.state, 'fixture guard: the mesh itself must be unchanged between the two');
  assert.equal(a.attrs.reason, b.attrs.reason, 'fixture guard: …and its reason unchanged too');
  assert.notDeepEqual(a.attrs, b.attrs,
    'a minute apart on an unchanged mesh must still differ, or HA files it as no-change and the entity goes mute');
});

test('the heartbeat is QUANTIZED to the minute, so it cannot flood the recorder (v0.66.0)', () => {
  // The recorder writes a row per change. At the 30 s publish cadence an
  // unquantized stamp books 2 880 rows a day on a Raspberry Pi to carry a
  // freshness signal nothing reads faster than the 10-minute dead-feed
  // watchdog. Quantizing is what makes the heartbeat affordable, so it is a
  // property, not an implementation detail.
  const healthy = data();
  const base = 1_760_000_000_000;
  const at = (ms: number) => String(by(buildStates(healthy, ms), ENTITY_DEGRADED).attrs.published_at);
  assert.match(at(base), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/, 'a whole minute, in ISO 8601');
  assert.equal(at(base + 1_000), at(base + 29_000),
    'two publishes inside the same minute must be identical — that is the whole saving');
  assert.notEqual(at(base), at(base + 61_000), '…and it must still move once the minute turns');
});

test('the heartbeat reports the PUBLISHER, not the mesh — it moves even while degraded (v0.66.0)', () => {
  // A heartbeat that only ran while healthy would go quiet at exactly the
  // moment the operator needs to know the add-on is still the one saying so.
  const sick = data({ lastStatsUpdated: () => 1_760_000_000_000 - 42 * 60_000 } as never);
  const a = by(buildStates(sick, 1_760_000_000_000), ENTITY_DEGRADED);
  const b = by(buildStates(sick, 1_760_000_000_000 + 61_000), ENTITY_DEGRADED);
  assert.equal(a.state, 'on', 'fixture guard: this fixture must really be degraded');
  assert.notEqual(a.attrs.published_at, b.attrs.published_at, 'the heartbeat does not stop when the mesh is sick');
});
