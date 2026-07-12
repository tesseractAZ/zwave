import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TuiSession } from '../src/telnet/session';
import { NodeStatus, type DataProvider, type NodeSnapshot, type HealthResult, type ActionRunner } from '../src/types';

const node: NodeSnapshot = {
  nodeId: 5, deviceId: 'd5', name: 'Test Node', area: null, status: NodeStatus.Alive, statusLabel: 'alive',
  ready: true, isRouting: true, isListening: true, isLongRange: false, isController: false, isSecure: true,
  securityClass: 'S2', manufacturer: null, model: null, battery: null,
  stats: { rtt: null, rssi: null, lwr: null, nlwr: null, commandsTX: 0, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null },
  entities: [],
};
const score: HealthResult = { score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] };
const data: DataProvider = {
  nodes: () => [node], nodeById: () => node, controller: () => null, events: () => [], scoreFor: () => score,
  noiseFloor: () => -95, hasRealNoise: () => false, lastUpdated: () => 0, lastStatsUpdated: () => 0,
  ready: () => true, lastError: () => null,
};

function mkActions(confirmDestructive: boolean) {
  const calls: string[] = [];
  const ok = async () => ({ ok: true, message: 'ok' });
  const runner: ActionRunner = {
    enabled: true, confirmDestructive,
    ping: async (n) => { calls.push(`ping:${n}`); return { ok: true, message: 'ok' }; },
    refreshValues: ok, reInterview: ok,
    healNode: async (n) => { calls.push(`heal:${n}`); return { ok: true, message: 'ok' }; },
    rebuildAll: async () => { calls.push('rebuildAll'); return { ok: true, message: 'ok' }; },
    stopRebuild: ok,
    removeFailed: async (n) => { calls.push(`remove:${n}`); return { ok: true, message: 'ok' }; },
  };
  return { runner, calls };
}
const mkSession = (runner: ActionRunner) => {
  let last = '';
  const s = new TuiSession({ write: (d) => { last = d; }, data, actions: runner, width: 100, height: 30 });
  s.draw();
  return { s, last: () => last };
};
const strip = (x: string) => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const key = (ch: string) => ({ type: 'char' as const, ch });
const flush = () => new Promise((r) => setImmediate(r));

test('destructive heal requires confirmation; cancel does NOT execute', async () => {
  const { runner, calls } = mkActions(true);
  const { s, last } = mkSession(runner);
  s.feed([key('h')]); s.draw();
  assert.match(strip(last()), /CONFIRM ACTION/);
  assert.deepEqual(calls, [], 'must not run before confirmation');
  s.feed([key('n')]); // cancel
  await flush();
  assert.deepEqual(calls, [], 'cancel must NOT actuate the mesh');
});

test('confirming with y executes the heal exactly once', async () => {
  const { runner, calls } = mkActions(true);
  const { s } = mkSession(runner);
  s.feed([key('h')]);
  s.feed([key('y')]);
  await flush(); await flush();
  assert.deepEqual(calls, ['heal:5']);
});

test('rebuild-all and remove-failed ALWAYS confirm, even with confirm_destructive off', async () => {
  const { runner, calls } = mkActions(false); // confirmDestructive OFF
  const { s, last } = mkSession(runner);
  s.feed([key('R')]); s.draw();
  assert.match(strip(last()), /CONFIRM ACTION/, 'rebuild-all forces confirm regardless of the flag');
  s.feed([key('n')]);
  await flush();
  assert.deepEqual(calls, []);
  s.feed([key('x')]); s.draw();
  assert.match(strip(last()), /CONFIRM ACTION/, 'remove-failed forces confirm regardless of the flag');
});

test('ping is immediate (no confirm) since it is safe/idempotent', async () => {
  const { runner, calls } = mkActions(true);
  const { s } = mkSession(runner);
  s.feed([key('p')]);
  await flush(); await flush();
  assert.deepEqual(calls, ['ping:5']);
});

test('a disabled runner never intercepts the keys (session leaves them to applyKey)', async () => {
  const { runner, calls } = mkActions(true);
  const off: ActionRunner = { ...runner, enabled: false };
  const { s } = mkSession(off);
  s.feed([key('h')]); s.feed([key('R')]);
  await flush();
  assert.deepEqual(calls, [], 'no actions when disabled');
});
