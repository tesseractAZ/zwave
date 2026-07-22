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
    ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0 }), efficacyFor: () => null, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
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
    controlEntity: async (n, eid, verb) => { calls.push(`control:${n}:${eid}:${verb}`); return { ok: true, message: 'ok' }; },
    setConfigParam: async (n, param, value) => { calls.push(`setParam:${n}:${param.property}:${value}`); return { ok: true, message: 'ok' }; },
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

/* ── v0.23 device control + config writes through the Actions Menu ─────────── */

import type { EntityLiveState, ConfigParam } from '../src/types';

const light: EntityLiveState = { entityId: 'light.test', domain: 'light', name: 'Test Light', state: 'on', attrs: {} };
const lock: EntityLiveState = { entityId: 'lock.front', domain: 'lock', name: 'Front Door', state: 'locked', attrs: {} };
const enumParam: ConfigParam = { key: '5-112-0-3', label: 'LED Indicator', value: 2, valueLabel: 'Always off', unit: null, writeable: true, min: 0, max: 3, property: 3, propertyKey: null, endpoint: 0, states: { '0': 'On when off', '1': 'On when on', '2': 'Always off', '3': 'Always on' } };
const numParam: ConfigParam = { key: '5-112-0-9', label: 'Ramp Rate', value: 20, valueLabel: null, unit: 'ms', writeable: true, min: 0, max: 99, property: 9, propertyKey: null, endpoint: 0, states: null };
const roParam: ConfigParam = { key: '5-112-0-1', label: 'Read Only', value: 1, valueLabel: null, unit: null, writeable: false, min: 0, max: 1, property: 1, propertyKey: null, endpoint: 0, states: null };
// Degenerate: writeable enum whose states map is EMPTY (malformed device metadata).
const emptyEnumParam: ConfigParam = { key: '5-112-0-7', label: 'Bad Enum', value: 0, valueLabel: null, unit: null, writeable: true, min: 0, max: 5, property: 7, propertyKey: null, endpoint: 0, states: {} };
// Writeable numeric with NO device-reported bounds.
const noBoundsParam: ConfigParam = { key: '5-112-0-8', label: 'No Bounds', value: 0, valueLabel: null, unit: null, writeable: true, min: null, max: null, property: 8, propertyKey: null, endpoint: 0, states: null };

function mkDeviceData(): DataProvider {
  return { ...mkData(), entityStates: () => [light, lock], configParams: () => ({ status: 'ready', params: [enumParam, numParam, roParam, emptyEnumParam, noBoundsParam] }) };
}
const down = { type: 'arrow' as const, dir: 'down' as const };
/** Drive the menu cursor down until the highlighted (▶) row contains `needle`. */
function seek(s: TuiSession, last: () => string, needle: string): boolean {
  for (let i = 0; i < 60; i++) {
    const row = strip(last()).split('\n').find((l) => l.includes('▶'));
    if (row && row.includes(needle)) return true;
    s.feed([down]); s.draw();
  }
  return false;
}

test('menu offers DEVICE CONTROLS + CONFIGURATION groups for the node', () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.match(f, /DEVICE CONTROLS/);
  assert.match(f, /CONFIGURATION/);
  assert.match(f, /Turn Off · Test Light/);
  assert.match(f, /Unlock · Front Door/);
  assert.match(f, /Set · LED Indicator/);
  assert.doesNotMatch(f, /Read Only/, 'a non-writeable param is never offered for editing');
});

test('menu → Turn Off a light → CONFIRM executes controlEntity(off) exactly once', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Turn Off · Test Light'), 'found the Turn Off row');
  s.feed([enter]); s.draw(); // → CONFIRM box
  assert.match(strip(last()), /type CONFIRM to arm/i);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['control:5:light.test:off']);
});

test('menu → Unlock (high-stakes) still requires the typed CONFIRM', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Unlock · Front Door'));
  s.feed([enter]); s.draw();
  const f = strip(last());
  assert.match(f, /CONFIRM/);
  assert.match(f, /UNLOCKS/i, 'the confirm box warns it unlocks the door');
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['control:5:lock.front:unlock']);
});

test('menu → Set an ENUM param → pick a value → CONFIRM writes it', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Set · LED Indicator'));
  s.feed([enter]); s.draw(); // → value picker (enum)
  assert.match(strip(last()), /SET PARAMETER/);
  assert.match(strip(last()), /Always off/); // current value present
  // cursor starts on the current value (2 "Always off"); move up to value 0.
  s.feed([{ type: 'arrow', dir: 'up' }, { type: 'arrow', dir: 'up' }]); s.draw();
  s.feed([enter]); s.draw(); // choose → CONFIRM box
  assert.match(strip(last()), /type CONFIRM to arm/i);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['setParam:5:3:0']);
});

test('menu → Set a NUMERIC param → type a value → CONFIRM writes it; out-of-range is rejected', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Set · Ramp Rate'));
  s.feed([enter]); s.draw(); // → value picker (numeric)
  // too big first → rejected with a hint, no CONFIRM
  for (const ch of '500') s.feed([key(ch)]);
  s.feed([enter]); s.draw();
  assert.match(strip(last()), /SET PARAMETER/, 'still in the picker after an out-of-range value');
  assert.match(strip(last()), /maximum/i);
  // clear + type a valid 42
  for (let i = 0; i < 3; i++) s.feed([key('\x7f')]);
  for (const ch of '42') s.feed([key(ch)]);
  s.feed([enter]); s.draw(); // → CONFIRM
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['setParam:5:9:42']);
});

test('device control is locked in read-only mode (no controlEntity/setConfigParam)', async () => {
  const { runner, calls } = mkActions(false); // write actions disabled
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.match(strip(last()), /READ-ONLY/);
  seek(s, last, 'Turn Off · Test Light');
  s.feed([enter]); s.draw();
  await flush();
  assert.deepEqual(calls, [], 'nothing actuates while read-only');
});

/* ── v0.23 hardening (adversarial-review defensive fixes) ─────────────────── */

test('a writeable enum param with an EMPTY states map falls back to numeric entry (no crash on Enter)', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Set · Bad Enum'));
  s.feed([enter]); s.draw();
  const f = strip(last());
  assert.match(f, /new value/, 'degenerate enum uses the numeric picker, not an empty option list');
  assert.doesNotMatch(f, /choose a value/);
  for (const ch of '3') s.feed([key(ch)]);
  s.feed([enter]); s.draw();
  assert.match(strip(last()), /type CONFIRM to arm/i);
  typeConfirm(s);
  await flush(); await flush();
  assert.deepEqual(calls, ['setParam:5:7:3']);
});

test('a numeric param with NO device bounds still rejects an absurd (out-of-int32) value', async () => {
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner, mkDeviceData());
  s.feed([key('a')]); s.draw();
  assert.ok(seek(s, last, 'Set · No Bounds'));
  s.feed([enter]); s.draw();
  for (const ch of '99999999999') s.feed([key(ch)]);
  s.feed([enter]); s.draw();
  assert.match(strip(last()), /out of range/i, 'sanity floor rejects the absurd value');
  await flush();
  assert.deepEqual(calls, [], 'nothing written');
});
