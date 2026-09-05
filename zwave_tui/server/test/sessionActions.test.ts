import { test } from 'node:test';
import { readFileSync } from 'node:fs';
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
const score: HealthResult = { score: 90, grade: 'A', state: 'ok', flags: [] };

function mkData(controller: ControllerSnapshot | null = null): DataProvider {
  return {
    nodes: () => [node], nodeById: () => node, controller: () => controller, events: () => [], scoreFor: () => score,
    noiseFloor: () => -95, hasRealNoise: () => false, history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }), lastUpdated: () => 0,
    ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 0, bands: 6 }), efficacyFor: () => null, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  openEpisodes: () => [],
  controlArm: () => null,
  autoPingState: () => null,
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
  };
}
const data = mkData();

function mkActions(enabled = true) {
  const calls: string[] = [];
  const ok = (tag: string) => async (n?: number) => { calls.push(n == null ? tag : `${tag}:${n}`); return { ok: true, message: 'ok' }; };
  const runner: ActionRunner = {
    enabled,
    ping: ok('ping'), probe: ok('probe'), refreshValues: ok('refresh'), reInterview: ok('reInterview'),
    healNode: ok('heal'), rebuildAll: ok('rebuildAll'), stopRebuild: ok('stopRebuild'), removeFailed: ok('remove'),
    controlEntity: async (n, eid, verb) => { calls.push(`control:${n}:${eid}:${verb}`); return { ok: true, message: 'ok' }; },
    setConfigParam: async (n, param, value) => { calls.push(`setParam:${n}:${param.property}:${value}`); return { ok: true, message: 'ok' }; },
  };
  return { runner, calls };
}

function mkSession(runner: ActionRunner, d: DataProvider = data) {
  let last = '';
  // `log` MUST be supplied. Without it TuiSession falls back to console.log,
  // and node:test multiplexes its IPC protocol over the child's stdout — a
  // session that logs mid-test corrupts that stream and the runner dies with
  // "Unable to deserialize cloned data", an error that names no test and reads
  // like an unrelated CI flake. (v0.24's on-screen action refusal added a
  // this.log() call, which is what started tripping it.)
  const s = new TuiSession({ write: (x) => { last = x; }, data: d, actions: runner, log: () => {}, width: 100, height: 30 });
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

test("'a' on a node screen opens the DEVICE menu — and it names one device", () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.match(f, /DEVICE ACTIONS/);
  assert.match(f, /target #5 Test Node/, 'the device menu must name its target');
  assert.match(f, /Ping node/);
  assert.match(f, /ARMED/, 'enabled runner → ARMED badge');
  // The blast radius must match the header: a menu naming ONE node may not
  // offer an action that touches all of them.
  assert.doesNotMatch(f, /Rebuild ALL routes/,
    'a mesh-wide action is listed under a header naming a single device');
});

test("'a' on the Controller screen opens the NETWORK menu, with no device target", () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('3')]);      // Controller & Network
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.match(f, /NETWORK ACTIONS/);
  assert.match(f, /whole mesh/, 'the network menu must state its blast radius');
  assert.match(f, /Rebuild ALL routes/);
  assert.doesNotMatch(f, /target #/, 'the network menu must not name a device target');
  assert.doesNotMatch(f, /Ping node/, 'a device action leaked into the network menu');
});

test("'a' on a screen with neither scope says where the actions live", () => {
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('4')]);      // Topology — no node cursor, not the network screen
  s.feed([key('a')]); s.draw();
  const f = strip(last());
  assert.doesNotMatch(f, /DEVICE ACTIONS|NETWORK ACTIONS/, 'opened a mis-scoped menu');
  assert.match(f, /No actions on this screen/, 'the refusal is invisible to the operator');
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

test('the network menu confirms and runs Rebuild ALL', async () => {
  const { runner, calls } = mkActions();
  const { s } = mkSession(runner);
  s.feed([key('3')]);   // Controller & Network
  s.feed([key('a')]);   // network menu — rebuildAll is the first row while idle
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
  s.feed([key('3')]);              // the rebuild is mesh-wide → NETWORK menu
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
  const s = new TuiSession({ write: (x) => { last = x; }, data, actions: runner, auth: auth as never, peer: 't', log: () => {}, width: 100, height: 30 });
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

test('node actions are refused on screens that show no node cursor', () => {
  // Topology / Heatmap / Controller / Interference are AGGREGATE views: there
  // is no ▶ row on screen. Falling through to the Overview selection meant `p`
  // — the one action that executes with no CONFIRM box — acted on a node the
  // operator could not see and had not chosen. Same defect class as the Remedy
  // targeting fix; this drives the real session rather than restating the rule.
  for (const key of ['1', '2', '3', '4', '5', '8'] as const) {
    const { runner, calls } = mkActions(true);
    const { s } = mkSession(runner);
    s.feed([{ type: 'char', ch: key }]); // switch screen
    s.feed([{ type: 'char', ch: 'p' }]); // ping — safe, so it runs immediately
    const aggregate = ['3', '4', '5', '8'].includes(key); // controller/topology/heatmap/interference
    if (aggregate) {
      assert.deepEqual(calls, [],
        `screen ${key} has no node cursor but still executed ${calls.join(',')}`);
    } else {
      assert.deepEqual(calls, ['ping:5'],
        `screen ${key} shows a node cursor and should have pinged it, got ${calls.join(',')}`);
    }
  }
});

test('refusing a node action says why instead of no-opping silently', () => {
  const { runner } = mkActions(true);
  const { s, last } = mkSession(runner);
  s.feed([{ type: 'char', ch: '4' }]); // Topology — no node cursor
  s.feed([{ type: 'char', ch: 'p' }]);
  s.draw();
  assert.match(strip(last()), /no node cursor/,
    'the refusal is invisible to the operator');
});

test('cancelling a confirm returns to the menu you were IN, not one re-derived', () => {
  // The modals swallow every key, so re-deriving the scope happens to agree
  // today — but that is an accident of dispatch order, not a guarantee. Pin the
  // behaviour so a future dispatch change cannot silently drop the operator
  // into a different menu than the one they opened.
  const { runner, calls } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('3')]);            // Controller → NETWORK menu
  s.feed([key('a')]);
  s.feed([enter]);               // select Rebuild ALL → type-CONFIRM
  s.draw();
  assert.match(strip(last()), /type CONFIRM to arm/i, 'confirm not armed');
  s.feed([{ type: 'escape' }]);  // cancel
  s.draw();
  const f = strip(last());
  assert.match(f, /NETWORK ACTIONS/, `cancel returned to the wrong menu: ${f.split('\n')[0]}`);
  assert.doesNotMatch(f, /DEVICE ACTIONS/, 'cancel dropped into the device menu');
  assert.deepEqual(calls, [], 'cancel must not execute anything');
});

test('INVARIANT: no screen is both network-scoped and cursor-bearing', () => {
  // Two guards in openMenu() are DEFENSIVE and cannot be killed by a mutation
  // test today, because they are observationally equivalent under the current
  // screen mapping:
  //   1. `scope === 'device' ? actionTargetNode() : null` — the network screen
  //      has no node cursor, so actionTargetNode() already returns undefined.
  //   2. `reopen ?? menuScopeForScreen()` — the modals swallow every key, so
  //      the screen cannot change while a confirm is up and re-deriving agrees.
  //
  // Rather than pretend those guards are covered, this test pins the INVARIANT
  // that makes them equivalent. The moment someone gives a network-scoped
  // screen a node cursor — or lets a screen change while a modal is open — this
  // fails and says the guards have become load-bearing.
  const DEVICE_SCREENS = ['overview', 'detail', 'remedy', 'log'];
  const NETWORK_SCREENS = ['controller'];
  for (const s of NETWORK_SCREENS) {
    assert.ok(!DEVICE_SCREENS.includes(s),
      `${s} is now both network-scoped and cursor-bearing — the menuTarget guard in openMenu() is now load-bearing and needs a real test`);
  }

  // And the behaviour that makes #2 equivalent: a modal must swallow a screen
  // key rather than let it through.
  const { runner } = mkActions();
  const { s, last } = mkSession(runner);
  s.feed([key('3')]);            // Controller
  s.feed([key('a')]);            // network menu
  s.feed([enter]);               // → type-CONFIRM modal
  s.feed([key('1')]);            // try to switch screens underneath it
  s.draw();
  assert.match(strip(last()), /type CONFIRM to arm/i,
    'a screen key escaped the confirm modal — the reopen-scope guard is now load-bearing');
});

test('a refused node action CONSUMES the key and paints the notice', () => {
  // It used to return false: the key fell through to applyKey, which both
  // suppressed the redraw (so the notice never reached the wire on the keypress
  // that caused it) and logged "enable write_actions_enabled" while write
  // actions were ENABLED. Assert the whole chain, not the helper.
  const { runner, calls } = mkActions(true);
  const { s, last } = mkSession(runner);
  s.feed([key('4')]);            // Topology — no node cursor
  s.draw();
  const res = s.feed([key('p')]);
  assert.ok(res.redraw, 'the refusal did not request a redraw — it never reaches the terminal');
  s.draw();
  const f = strip(last());
  assert.match(f, /no target node/, `the refusal is not on screen: ${f.slice(0, 200)}`);
  assert.doesNotMatch(f, /write_actions_enabled/, 'told the operator to enable a setting that IS enabled');
  assert.deepEqual(calls, [], 'a refused action must not execute');
});

test('the refusal reason is TRUE for the screen', () => {
  // Log and Remedy DO carry a per-node cursor. Telling that operator to "pick a
  // node on the Overview" is a false explanation that sends them to the wrong
  // screen — the failure is that the CARD under the cursor is mesh-scoped.
  const { runner } = mkActions(true);
  const { s, last } = mkSession(runner);

  s.feed([key('4')]); s.feed([key('p')]); s.draw();     // Topology: truly no cursor
  assert.match(strip(last()), /no node cursor/, 'aggregate screen got the wrong reason');

  s.feed([{ type: 'escape' }]);                          // dismiss the notice
  s.feed([key('7')]); s.feed([key('p')]); s.draw();      // Remedy: HAS a cursor
  const f = strip(last());
  assert.doesNotMatch(f, /no node cursor/, 'Remedy has a cursor but was told it has none');
  assert.match(f, /not tied to a single node/, `wrong reason on Remedy: ${f.slice(0, 220)}`);
});

test('REMEDY resolves its action target from the symptom under the cursor', () => {
  // Drives the real session. `p` is the one action that runs with NO confirm
  // box, so aiming it at the Overview's selection instead of the card on screen
  // is a safety defect, not a cosmetic one.
  const target = { ...node, nodeId: 83, name: 'Utility Closet Switch' };
  const sym = (nodeId: number, sinceMs: number) => ({
    id: `s${nodeId}`, kind: 'dead-flap', severity: 'crit', nodeId, sinceMs,
    basis: 'measured', evidence: [], narrative: 'flapping', subsumedBy: null,
  });
  const d: DataProvider = {
    ...mkData(),
    nodes: () => [node, target],
    nodeById: (id: number) => (id === 83 ? target : node),
    symptoms: () => [sym(83, 9), sym(5, 8)] as never,
  };
  const { runner, calls } = mkActions(true);
  const { s } = mkSession(runner, d);
  s.feed([key('7')]);                       // Remedy — cursor 0 = the #83 card
  s.feed([key('p')]);                       // safe → immediate
  assert.deepEqual(calls, ['ping:83'],
    `pinged the wrong node: ${calls.join(',') || '(nothing)'} — the Overview holds #5`);
});

test('the REMEDY cursor follows the symptom, not the slot, across a re-sort', () => {
  // The engine re-sorts its symptom list on every poll. A bare index would keep
  // aiming at position N while a DIFFERENT node slid into it — and on this
  // screen that index aims `p`, the one action that runs with no CONFIRM box.
  const nodeA = { ...node, nodeId: 83, name: 'Utility Closet Switch' };
  const nodeB = { ...node, nodeId: 41, name: 'Porch Light' };
  const sym = (nodeId: number, severity: string, sinceMs: number) => ({
    kind: 'dead-flap', nodeId, severity, sinceMs,
    basis: 'measured', evidence: [], narrative: '', subsumedBy: undefined,
  });

  // Both crit; #83 is newer so it sorts FIRST (bySeverity tiebreaks on sinceMs).
  let list = [sym(83, 'crit', 900), sym(41, 'crit', 800)];
  const d: DataProvider = {
    ...mkData(),
    nodes: () => [node, nodeA, nodeB],
    nodeById: (id: number) => (id === 83 ? nodeA : id === 41 ? nodeB : node),
    symptoms: () => list as never,
  };
  const { runner, calls } = mkActions(true);
  const { s } = mkSession(runner, d);
  s.feed([key('7')]);                       // Remedy — cursor 0 = the #83 card
  s.draw();

  // Now #41 becomes the newer breach and takes slot 0. The operator has not
  // touched the keyboard; the card they were looking at is still #83.
  list = [sym(41, 'crit', 950), sym(83, 'crit', 900)];
  s.draw();
  s.feed([key('p')]);
  assert.deepEqual(calls, ['ping:83'],
    `a re-sort re-aimed the no-CONFIRM ping: pinged ${calls.join(',') || '(nothing)'} instead of #83`);
});

test('the MENU refusal reason is true for a cursor-bearing screen', () => {
  // buildMenu is the SECOND consumer of the explanation the `p` path already
  // got right. Log and Remedy DO carry a per-node cursor; telling that operator
  // to "select a node first (Overview/Detail)" sends them to the wrong screen.
  const rowsFor = (screen: string): string => {
    const { runner } = mkActions(true);
    const { s, last } = mkSession(runner, { ...mkData(), symptoms: () => [] });
    s.feed([key(screen)]);
    s.feed([key('a')]);
    s.draw();
    return strip(last());
  };
  // Remedy (7) with no symptoms: a device menu with no resolvable target.
  const remedy = rowsFor('7');
  assert.doesNotMatch(remedy, /select a node first/,
    `Remedy has a cursor but was told to go to the Overview:\n${remedy.slice(0, 300)}`);
  // The row is clipped at the test terminal's width, so match the part that
  // survives rather than the full sentence.
  assert.match(remedy, /item under the cursor/,
    `wrong menu reason on Remedy:\n${remedy.slice(0, 300)}`);
});

test('SECURITY: a notice DETAIL line does not survive an idle re-lock', async () => {
  // resetActionState() runs on the auth boundary and clears the notice, but the
  // detail line is a SEPARATE field. Leaving it set let one action's
  // explanation reappear under a different action's notice — after a
  // re-authentication, so potentially in front of a different operator.
  const { runner } = mkActions(true);
  // idleLockMs must be long enough that the login keystrokes and the setup
  // draws cannot themselves trip the re-lock (any draw >idleLockMs after the
  // last key re-locks, and on a loaded CI runner a 1 ms budget is routinely
  // exceeded MID-login — an intermittent CI failure, caught before merge).
  // The boundary is crossed explicitly below by advancing lastActivity.
  const auth = {
    enabled: true, requireOnIngress: false, idleLockMs: 60_000,
    hasUsers: () => true, verify: async () => true,
    blockedMsFor: () => 0, registerFailure: () => {}, registerSuccess: () => {},
  };
  let last = '';
  const s = new TuiSession({
    write: (x) => { last = x; }, data, actions: runner,
    auth: auth as never, peer: 't', log: () => {}, width: 100, height: 30,
  });
  s.draw();
  const login = async () => {
    for (const ch of 'user') s.feed([key(ch)]);
    s.feed([enter]);
    for (const ch of 'pw') s.feed([key(ch)]);
    s.feed([enter]);
    await flush(); await flush();
  };
  await login();

  // Produce a notice WITH a detail line: a refused action on an aggregate screen.
  s.feed([key('4')]);            // Topology — no node cursor
  s.feed([key('p')]);
  s.draw();
  assert.match(strip(last), /no node cursor/, 'setup: expected a two-line refusal notice');

  // Cross the authentication boundary DETERMINISTICALLY: rewind the session's
  // last-activity stamp past the idle window instead of racing a wall clock.
  (s as unknown as { lastActivity: number }).lastActivity = Date.now() - 120_000;
  s.draw();
  await login();

  // A notice raised AFTER the boundary must not inherit the previous detail.
  s.feed([key('1')]);            // Overview — HAS a cursor, so a different reason
  s.draw();
  const after = strip(last);
  assert.doesNotMatch(after, /no node cursor/,
    `a stale detail line survived the auth boundary:\n${after.slice(0, 300)}`);

  // Settle the async credential check kicked off by the re-login above. Without
  // this the promise resolves AFTER the test returns and touches a session the
  // runner has torn down, which surfaced as an intermittent
  // "Unable to deserialize cloned data" from node:test — an IPC error, not an
  // assertion, so it named no test and looked like an unrelated CI flake.
  await flush(); await flush();
});

test('INVARIANT: every path that sets a notice also settles its detail line', () => {
  // The two fields must move together: a detail line that outlives its notice
  // reappears under the NEXT one, attributing one action's explanation to a
  // different action. Rendering-level tests cannot see this — every current
  // path happens to settle both — so the property is enforced structurally,
  // which also makes it fail the moment a new notice path forgets.
  const src = readFileSync(new URL('../src/telnet/session.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const orphans: string[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*this\.actionNotice = /.test(line)) return;
    // The detail must be settled within the same small block. 8 lines, not 4:
    // the resetActionState site carries a comment explaining WHY it clears, and
    // a window that cannot span an explanation punishes documenting the reason.
    const near = lines.slice(i, i + 8).join('\n');
    if (!/this\.actionNoticeDetail\s*=/.test(near)) {
      orphans.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
    }
  });
  assert.deepEqual(orphans, [],
    'a notice is set without settling its detail line — the stale-line guard in ' +
    'resetActionState() is now load-bearing and needs its own test:\n' + orphans.join('\n'));
});

test('the RESULT modal never collapses two opposite driver verdicts into one line (v0.51.0)', async () => {
  // The three ZW0360 outcomes are the motivating family. `centeredNotice` fed
  // one long line to `center`, which falls through to a blind truncate at ~71
  // visible chars, so all three rendered as the SAME sentence cut at the same
  // word — and the verdict the operator needed was always in the part that
  // fell off. The error CODE survived, which made it look complete.
  const MESSAGES = [
    'HA WS error (zwave_error): Z-Wave error 360 - The node was removed from the network successfully (ZW0360)',
    'HA WS error (zwave_error): Z-Wave error 360 - The node was NOT removed and is still part of the network (ZW0360)',
    'HA WS error (zwave_error): Z-Wave error 360 - The node may or may not have been removed; the controller cannot tell (ZW0360)',
  ];
  const seen: string[] = [];
  for (const message of MESSAGES) {
    const { runner } = mkActions();
    runner.ping = async () => ({ ok: false, message });
    let out = '';
    // The MODAL terminal, set through the constructor — `view` is private, and
    // the width is the whole point of this test.
    const s = new TuiSession({ write: (x) => { out = x; }, data, actions: runner, log: () => {}, width: 80, height: 24 });
    (s as never as { actionNotice: string | null }).actionNotice = `✗  ${message}`;
    (s as never as { actionNoticeDetail: string | null }).actionNoticeDetail = null;
    s.draw();
    const last = () => out;
    // Strip the modal's own box rules so a wrapped clause reads as one string.
    const shown = strip(last()).replace(/[║╔╗╚╝╠╣═─│]/g, ' ').replace(/\s+/g, ' ');
    seen.push(shown);
    // The distinguishing clause must be on screen SOMEWHERE in the modal.
    const tail = message.slice(message.indexOf('360 - ') + 6, message.indexOf(' (ZW0360)'));
    assert.ok(shown.includes(tail.slice(0, 40)),
      `the verdict must survive: expected "${tail.slice(0, 40)}" in\n${shown.slice(0, 700)}`);
  }
  // And the three frames must not be identical to each other.
  assert.equal(new Set(seen).size, 3, 'three opposite outcomes must render three different frames');
});

test('a THROWN action error is capped and scrubbed like every other (v0.51.0)', async () => {
  // Every other failure goes through sanitizeEventText in zwaveActions; the
  // catch in runAction did not, so the one path that carries a raw exception
  // reached the modal uncapped and unscrubbed - and the modal's row budget
  // assumes the 300-char cap holds.
  const { runner } = mkActions();
  const CTL = String.fromCharCode(7, 27, 13);
  runner.ping = async () => { throw new Error('boom' + CTL + 'x'.repeat(500)); };
  let out = '';
  const s = new TuiSession({ write: (x) => { out = x; }, data, actions: runner, log: () => {}, width: 80, height: 24 });
  s.draw();
  s.feed([key('p')]);
  await flush(); await flush();
  const notice = (s as never as { actionNotice: string | null }).actionNotice ?? '';
  assert.ok(notice.length <= 320, `the message must be capped: ${notice.length} chars`);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(notice),
    'control bytes must be scrubbed before they reach a frame');
});
