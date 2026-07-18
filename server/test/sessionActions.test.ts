import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TuiSession } from '../src/telnet/session';
import { NodeStatus, type ControllerSnapshot, type DataProvider, type NodeSnapshot, type HealthResult, type ActionRunner } from '../src/types';

const node: NodeSnapshot = {
  nodeId: 5, deviceId: 'd5', name: 'Test Node', area: null, status: NodeStatus.Alive, statusLabel: 'alive',
  ready: true, isRouting: true, isListening: true, isLongRange: false, isController: false, isSecure: true,
  securityClass: 'S2', manufacturer: null, model: null, battery: null, firmware: null,
  stats: { rtt: null, rssi: null, lwr: null, nlwr: null, commandsTX: 0, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null },
  entities: [],
};
const score: HealthResult = { score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] };

function mkData(controller: ControllerSnapshot | null = null): DataProvider {
  return {
    nodes: () => [node], nodeById: () => node, controller: () => controller, events: () => [], scoreFor: () => score,
    noiseFloor: () => -95, hasRealNoise: () => false, history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }), lastUpdated: () => 0,
    ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0 }), efficacyFor: () => null,
  };
}
const data = mkData();

function mkActions(enabled = true) {
  const calls: string[] = [];
  const ok = (tag: string) => async (n?: number) => { calls.push(n == null ? tag : `${tag}:${n}`); return { ok: true, message: 'ok' }; };
  const runner: ActionRunner = {
    enabled,
    ping: ok('ping'), refreshValues: ok('refresh'), reInterview: ok('reInterview'),
    healNode: ok('heal'), rebuildAll: ok('rebuildAll'), stopRebuild: ok('stopRebuild'), removeFailed: ok('remove'),
  };
  return { runner, calls };
}

function mkSession(runner: ActionRunner, d: DataProvider = data) {
  let last = '';
  const s = new TuiSession({ write: (x) => { last = x; }, data: d, actions: runner, width: 100, height: 30 });
  s.draw();
  return { s, last: () => last };
}

const strip = (x: string) => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const key = (ch: string) => ({ type: 'char' as const, ch });
const enter = { type: 'enter' as const };
const esc = { type: 'escape' as const };
const flush = () => new Promise((r) => setImmediate(r));
/** Type the literal word CONFIRM then Enter. */
function typeConfirm(s: TuiSession): void {
  for (const ch of 'CONFIRM') s.feed([key(ch)]);
  s.feed([enter]);
}

/* ── the type-CONFIRM modal ─────────────────────────────────────────────── */

test('a destructive shortcut opens the type-CONFIRM box (not a y/n prompt)', () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('h')]); s.draw();
  const f = strip(last());
  assert.match(f, /CONFIRM/, 'confirm modal shown');
  assert.match(f, /type CONFIRM to arm/i, 'requires typing CONFIRM');
});

test('typing CONFIRM then Enter executes the action exactly once', async () => {
  const { runner, calls } = mkActions();
  const { s } = mkSession(runner);
  s.feed([key('h')]);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['heal:5']);
});

test('Esc cancels the confirm — nothing actuates', async () => {
  const { runner, calls } = mkActions();
  const { s } = mkSession(runner);
  s.feed([key('h')]);
  s.feed([esc]);
  await flush();
  assert.deepEqual(calls, [], 'Esc must not actuate');
});

test('a WRONG confirmation string does NOT execute (buffer resets on submit)', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('x')]); // remove-failed (destructive)
  for (const ch of 'confirm') s.feed([key(ch)]); // lowercase — must not match
  s.feed([enter]);
  await flush();
  assert.deepEqual(calls, [], 'lowercase "confirm" must not arm');
  s.draw();
  assert.match(strip(last()), /CONFIRM/, 'still in the confirm box after a wrong attempt');
  // Now type it correctly → executes.
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['remove:5']);
});

test('ping shortcut stays immediate (safe/idempotent — no confirm)', async () => {
  const { runner, calls } = mkActions();
  const { s } = mkSession(runner);
  s.feed([key('p')]);
  await flush(); await flush();
  assert.deepEqual(calls, ['ping:5']);
});

test('rebuild-ALL requires the typed CONFIRM and then runs', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('R')]); s.draw();
  assert.match(strip(last()), /Rebuild ALL routes/);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['rebuildAll']);
});

test('a disabled runner: destructive shortcuts never actuate', async () => {
  const { runner, calls } = mkActions(false);
  const { s } = mkSession(runner);
  s.feed([key('h')]); s.feed([key('R')]); s.feed([key('x')]);
  await flush();
  assert.deepEqual(calls, []);
});

/* ── the Actions Menu ───────────────────────────────────────────────────── */

test("'a' opens the Actions Menu listing actions with impact badges", () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.match(f, /ACTIONS/);
  assert.match(f, /Ping node/);
  assert.match(f, /Rebuild ALL routes/);
  assert.match(f, /DEVICE ACTIONS/);
  assert.match(f, /SYSTEM-WIDE/);
  assert.match(f, /ARMED/, 'enabled runner → ARMED badge');
});

test('menu → select ping → type-CONFIRM → executes (menu ping is NOT immediate)', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('a')]);      // open menu (index 0 = ping)
  s.feed([enter]);         // select ping → arms type-CONFIRM
  s.draw();
  assert.match(strip(last()), /type CONFIRM to arm/i, 'menu ping still requires CONFIRM');
  assert.deepEqual(calls, [], 'not yet executed');
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['ping:5']);
});

test('menu navigation reaches Rebuild ALL and confirms it', async () => {
  const { runner, calls } = mkActions();
  const { s } = mkSession(runner);
  s.feed([key('a')]);
  // device rows: ping,refresh,reInterview,heal,removeFailed (5) then rebuildAll at idx 5.
  for (let i = 0; i < 5; i++) s.feed([{ type: 'arrow', dir: 'down' }]);
  s.feed([enter]);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['rebuildAll']);
});

test('read-only: menu opens (informational) but selecting does NOT execute', async () => {
  const { runner, calls } = mkActions(false); // disabled
  const { s, last } = mkSession(runner);
  s.feed([key('a')]); s.draw();
  assert.match(strip(last()), /READ-ONLY/, 'locked badge shown');
  s.feed([enter]); // try to select
  await flush();
  assert.deepEqual(calls, [], 'read-only menu must not actuate');
  s.draw();
  assert.match(strip(last()), /Read-only/i, 'explains why it is locked');
});

test('stopRebuild appears in the menu only while a rebuild is in progress', () => {
  const rebuilding = { isRebuildingRoutes: true } as unknown as ControllerSnapshot;
  const { runner } = mkActions();
  const { s, last } = mkSession(runner, mkData(rebuilding));
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.match(f, /Stop route rebuild/, 'stopRebuild shown while rebuilding');
  assert.doesNotMatch(f, /Rebuild ALL routes/, 'rebuildAll hidden while rebuilding');
});

test('Esc closes the menu back to the normal screen', () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('a')]); s.draw();
  assert.match(strip(last()), /ACTIONS/);
  s.feed([esc]); s.draw();
  assert.doesNotMatch(strip(last()), /SYSTEM-WIDE/, 'menu closed');
});

/* ── review regressions (v0.9) ──────────────────────────────────────────── */

test('the menu FREEZES its target at open — a roster change cannot redirect the action', async () => {
  const { runner, calls } = mkActions();
  const nodeB: NodeSnapshot = { ...node, nodeId: 9, deviceId: 'd9', name: 'Other Node' };
  let current = node; // starts on node 5
  const d: DataProvider = { ...mkData(), nodes: () => [current], nodeById: (id) => (id === 9 ? nodeB : node) };
  const { s } = mkSession(runner, d);
  s.feed([key('a')]);       // open menu → target frozen = node 5
  current = nodeB;          // selection/roster now points at node 9
  s.feed([enter]);          // select Ping against the FROZEN target
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['ping:5'], 'must actuate the node frozen at open, not the drifted one');
});

test('SECURITY: an armed CONFIRM does NOT survive an idle re-lock + re-login', async () => {
  const { runner, calls } = mkActions();
  const auth = {
    enabled: true, requireOnIngress: false, idleLockMs: 1,
    hasUsers: () => true, verify: async () => true,
    blockedMsFor: () => 0, registerFailure: () => {}, registerSuccess: () => {},
  };
  let last = '';
  const s = new TuiSession({ write: (x) => { last = x; }, data, actions: runner, auth: auth as never, peer: 't', width: 100, height: 30 });
  s.draw();
  const login = async () => {
    for (const ch of 'user') s.feed([key(ch)]);
    s.feed([enter]);
    for (const ch of 'pw') s.feed([key(ch)]);
    s.feed([enter]);
    await flush(); await flush();
  };
  await login();
  // Operator A arms a DESTRUCTIVE action and fully types CONFIRM — but walks away
  // without pressing Enter (buffer === 'CONFIRM', the most dangerous armed state).
  s.feed([key('x')]);                        // removeFailed → type-CONFIRM
  for (const ch of 'CONFIRM') s.feed([key(ch)]);
  // Idle re-lock fires on the next draw past idleLockMs.
  await new Promise((r) => setTimeout(r, 15));
  s.draw();
  assert.doesNotMatch(strip(last), /type CONFIRM to arm/i, 're-lock must hide the armed confirm');
  // Operator B re-authenticates and a single stray Enter must NOT fire A's action.
  await login();
  s.feed([enter]);
  await flush(); await flush();
  assert.deepEqual(calls, [], 'a half-armed destructive action must never survive the auth boundary');
  s.draw();
  assert.doesNotMatch(strip(last), /type CONFIRM to arm/i, 'no stale confirm after re-auth');
});
