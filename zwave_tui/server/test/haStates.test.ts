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
