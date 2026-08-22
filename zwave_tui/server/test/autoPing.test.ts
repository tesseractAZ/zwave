/**
 * Auto-ping — the engine's first autonomous write.
 *
 * Every gate below is a SAFETY property, not a preference, so each gets a test
 * that fails if the gate is removed. The decision is a pure function precisely
 * so this is possible: no timers, no HA, no sockets.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  createAutoPingState,
  noteStale,
  decideAutoPings,
  noteAttempt,
  trackEpisodes,
  judgeProbeAnswers,
  type AutoPingConfig,
  type AutoPingState,
} from '../src/zwave/autoPing';
import { NodeStatus, type ControllerSnapshot, type NodeSnapshot } from '../src/types';

const MIN = 60_000;
const T = 1_760_000_000_000;

function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    nodeId: id, deviceId: 'd' + id, name: `Node ${id}`, area: null, status: NodeStatus.Alive,
    statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
    isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
    battery: null, firmware: null, stats: { lastSeen: null } as never, entities: [],
    ...over,
  };
}
const dead = (id: number, over: Partial<NodeSnapshot> = {}) =>
  node(id, { status: NodeStatus.Dead, ...over });

const cfg = (over: Partial<AutoPingConfig> = {}): AutoPingConfig => ({
  enabled: true, writeActions: true, afterMs: 10 * MIN, maxAttempts: 3, staleMs: 0, ...over,
});

/** A mesh with `live` healthy listening nodes plus whatever else is passed. */
function mesh(live: number, extra: NodeSnapshot[] = []): NodeSnapshot[] {
  const out: NodeSnapshot[] = [node(1, { isController: true })];
  for (let i = 0; i < live; i++) out.push(node(100 + i));
  return [...out, ...extra];
}

/** Drive one tick: track episodes, then decide. */
function tick(state: AutoPingState, nodes: NodeSnapshot[], now: number, over: {
  config?: AutoPingConfig; controller?: ControllerSnapshot | null; booting?: boolean; verifyDue?: number[];
} = {}) {
  trackEpisodes(state, nodes, now);
  return decideAutoPings({
    now, state, nodes,
    controller: over.controller ?? null,
    config: over.config ?? cfg(),
    booting: over.booting ?? false,
    verifyDue: over.verifyDue,
  });
}

/* ── the master gates ─────────────────────────────────────────────────── */

test('does nothing while its own switch is off (the shipped default)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN, { config: cfg({ enabled: false }) });
  assert.deepEqual(d.ping, []);
  assert.equal(d.suppressed, 'disabled');
});

test('obeys write_actions_enabled even when its own switch is on', () => {
  // Auto-ping IS a write. If it fired with write actions off, the add-on's own
  // "read-only" claim would be false.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN, { config: cfg({ writeActions: false }) });
  assert.deepEqual(d.ping, []);
  assert.equal(d.suppressed, 'write-actions-off');
});

/* ── what may be pinged at all ────────────────────────────────────────── */

test('never pings a sleeping battery node — asleep is not dead', () => {
  // A FLiRS/battery device sleeps BY DESIGN and answers on its own wakeup
  // interval. A ping cannot succeed before then and spends battery to fail.
  const s = createAutoPingState();
  const nodes = mesh(20, [node(8, { status: NodeStatus.Asleep, isListening: false })]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 60 * MIN);
  assert.deepEqual(d.ping, [], 'a sleeping node must never be auto-pinged');
});

test('never pings a DEAD battery node either (not always-listening)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(9, { isListening: false })]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 60 * MIN);
  assert.deepEqual(d.ping, []);
});

test('never pings a node whose listening capability is unknown', () => {
  // isListening === null means "not interviewed yet", which is not a licence to
  // probe it on an assumption.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(10, { isListening: null as unknown as boolean })]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 60 * MIN);
  assert.deepEqual(d.ping, []);
});

/* ── timing ───────────────────────────────────────────────────────────── */

test('waits the configured dwell before the first ping', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  assert.deepEqual(tick(s, nodes, T + 9 * MIN).ping, [], 'too early');
  assert.deepEqual(tick(s, nodes, T + 11 * MIN).ping, [7], 'past the dwell');
});

test('backs off between attempts and stops at the cap', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);

  const first = tick(s, nodes, T + 11 * MIN);
  assert.deepEqual(first.ping, [7]);
  noteAttempt(s, 7, T + 11 * MIN);

  // 10m backoff after attempt 1
  assert.deepEqual(tick(s, nodes, T + 15 * MIN).ping, [], 'inside the first backoff');
  assert.deepEqual(tick(s, nodes, T + 22 * MIN).ping, [7], 'past the first backoff');
  noteAttempt(s, 7, T + 22 * MIN);

  // 30m backoff after attempt 2
  assert.deepEqual(tick(s, nodes, T + 40 * MIN).ping, [], 'inside the second backoff');
  assert.deepEqual(tick(s, nodes, T + 60 * MIN).ping, [7], 'past the second backoff');
  noteAttempt(s, 7, T + 60 * MIN);

  // cap reached — hand it to a human rather than retry forever
  assert.deepEqual(tick(s, nodes, T + 600 * MIN).ping, [], 'attempt cap must hold');
});

test('recovery clears the episode, so a later failure gets a fresh budget', () => {
  const s = createAutoPingState();
  const down = mesh(20, [dead(7)]);
  tick(s, down, T);
  tick(s, down, T + 11 * MIN);
  noteAttempt(s, 7, T + 11 * MIN);
  noteAttempt(s, 7, T + 30 * MIN);
  noteAttempt(s, 7, T + 90 * MIN);
  assert.deepEqual(tick(s, down, T + 200 * MIN).ping, [], 'cap reached');

  // it comes back…
  const up = mesh(20, [node(7)]);
  tick(s, up, T + 210 * MIN);
  assert.equal(s.attempts.has(7), false, 'recovery must clear the attempt count');

  // …and dies again a week later
  tick(s, down, T + 10_000 * MIN);
  assert.deepEqual(tick(s, down, T + 10_011 * MIN).ping, [7], 'a new episode gets a fresh budget');
});

/* ── suppressors ──────────────────────────────────────────────────────── */

test('storm guard: a mesh-wide outage suppresses ALL pings', () => {
  // A third of the mesh dead at once is a controller wedge or a driver restart.
  // Firing 20 pings into a struggling controller makes it worse, and none of
  // those nodes has an individual fault to probe.
  const s = createAutoPingState();
  const deadOnes = Array.from({ length: 8 }, (_v, i) => dead(200 + i));
  const nodes = mesh(20, deadOnes);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN);
  assert.deepEqual(d.ping, []);
  assert.equal(d.suppressed, 'storm');
  assert.ok(d.deadListening >= Math.ceil(d.listening * 0.25), 'fixture must actually trip the guard');
});

test('a couple of dead nodes is NOT a storm', () => {
  const s = createAutoPingState();
  const nodes = mesh(40, [dead(300), dead(301)]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN);
  assert.equal(d.suppressed, 'none');
  assert.deepEqual(d.ping.sort(), [300, 301]);
});

test('a tiny mesh uses the absolute floor, not the fraction', () => {
  // On a 4-node mesh, 25% is 1 — one dead node would read as a "storm" and
  // disable the feature exactly where it is cheapest to act.
  const s = createAutoPingState();
  const nodes = mesh(3, [dead(400)]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN);
  assert.equal(d.suppressed, 'none', '1 of 4 dead must not count as a storm');
  assert.deepEqual(d.ping, [400]);
});

test('suppressed during the boot window', () => {
  // Right after start every node reads Dead until the first roster poll lands.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 30 * MIN, { booting: true });
  assert.deepEqual(d.ping, []);
  assert.equal(d.suppressed, 'boot-window');
});

test('suppressed while the controller is rebuilding routes', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const ctrl = { isRebuildingRoutes: true } as unknown as ControllerSnapshot;
  const d = tick(s, nodes, T + 30 * MIN, { controller: ctrl });
  assert.deepEqual(d.ping, []);
  assert.equal(d.suppressed, 'rebuilding-routes');
});

/* ── bookkeeping hygiene ──────────────────────────────────────────────── */

test('a removed node does not leak episode state forever', () => {
  const s = createAutoPingState();
  tick(s, mesh(20, [dead(7)]), T);
  assert.equal(s.deadSince.has(7), true);
  trackEpisodes(s, mesh(20), T + MIN); // node 7 excluded from the mesh
  assert.equal(s.deadSince.has(7), false, 'bookkeeping for a departed node must be dropped');
});

/* ── runner: the side-effecting half ──────────────────────────────────── */

test('the runner suppresses inside its boot window, then probes after it', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const pinged: number[] = [];
  const nodes = mesh(20, [dead(7)]);
  const h = startAutoPing({
    nodes: () => nodes,
    controller: () => null,
    ready: () => true,
    ping: async (n) => { pinged.push(n); },
    log: () => {},
    config: cfg(),
    tickMs: 1_000_000,        // inert; we drive tick() ourselves
    now: () => clock,
  });

  // Node has been Dead well past the dwell, but we are inside the boot window:
  // right after start every node reads Dead until the first roster poll lands.
  clock = T + BOOT_WINDOW_MS - MIN;
  h.tick();
  assert.deepEqual(pinged, [], 'must stay silent inside the boot window');

  // Past the boot window, the same node is now probed.
  clock = T + BOOT_WINDOW_MS + 20 * MIN;
  h.tick();
  assert.deepEqual(pinged, [7], 'must probe once the boot window has elapsed');
  h.stop();
});

test('the runner does not probe until the roster is ready', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let ready = false;
  const pinged: number[] = [];
  const nodes = mesh(20, [dead(7)]);
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => ready,
    ping: async (n) => { pinged.push(n); }, log: () => {},
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + 20 * MIN;
  h.tick();
  assert.deepEqual(pinged, [], 'an unready roster is not evidence a node is down');

  // `deadSince` starts when the runner first OBSERVES the node down — it cannot
  // know when the device actually died — so the dwell still has to elapse from
  // here. That is deliberately conservative: after a restart a node gets a fresh
  // dwell rather than being probed the instant the roster arrives.
  ready = true;
  h.tick();
  assert.deepEqual(pinged, [], 'the dwell restarts from first observation');
  clock += 20 * MIN;
  h.tick();
  assert.deepEqual(pinged, [7]);
  h.stop();
});

test('the runner announces a storm once, not on every tick', async () => {
  // A quarter of the mesh down is worth saying — and worth saying ONCE.
  // Repeating it each minute would bury the Log screen during exactly the
  // incident an operator is trying to read.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const warned: string[] = [];
  const nodes = mesh(20, Array.from({ length: 8 }, (_v, i) => dead(200 + i)));
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'warn') warned.push(text); },
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + 20 * MIN;
  h.tick(); h.tick(); h.tick();
  assert.equal(warned.length, 1, `storm announced ${warned.length}x — must be once per onset`);
  assert.match(warned[0], /suppressed/);
  h.stop();
});


/* ── liveness probe: silence is not evidence of life ──────────────────── */

const seen = (id: number, agoMs: number | null, over: Partial<NodeSnapshot> = {}) =>
  node(id, { stats: { lastSeen: agoMs == null ? null : T - agoMs } as never, ...over });

const STALE = 240 * MIN;
const staleCfg = (over: Partial<AutoPingConfig> = {}) => cfg({ staleMs: STALE, ...over });

test('probes a mains node that has been silent past the window', () => {
  // Z-Wave marks a node Dead only when a SEND FAILS. A node nobody addresses is
  // never proven alive — measured on the live mesh: 10 of 38 silent for 35.7h,
  // every one reporting Alive.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(50, 5 * 60 * MIN)];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.deepEqual(d.stale, [50]);
});

test('a chatty node is never probed — the clock is per-node', () => {
  // This is what makes the cadence self-balancing: a device that reports on its
  // own keeps resetting its own last-contact time and costs nothing.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(51, 30 * MIN)];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.deepEqual(d.stale, [], 'a node heard from 30m ago is not stale at 240m');
});

test('a node never heard from at all is treated as maximally stale', () => {
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(52, null)];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.deepEqual(d.stale, [52], 'no lastSeen is the strongest reason to ask');
});

test('at most ONE liveness probe per tick, stalest first', () => {
  // 36 mains nodes coming due together would otherwise fire 36 probes in one
  // second. The cap turns that into a trickle; ordering stops anyone starving.
  const s = createAutoPingState();
  const nodes = [
    node(1, { isController: true }),
    seen(60, 5 * 60 * MIN),
    seen(61, 40 * 60 * MIN),   // stalest
    seen(62, 9 * 60 * MIN),
  ];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.equal(d.stale.length, 1, 'never more than one liveness probe per tick');
  assert.deepEqual(d.stale, [61], 'the stalest node goes first');
});

test('an unreachable node is not re-probed every tick', () => {
  // THE flooding failure mode: a node that never answers never refreshes
  // lastSeen, so it stays permanently "due" and would be probed on every tick
  // forever.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(70, 5 * 60 * MIN)];
  assert.deepEqual(tick(s, nodes, T, { config: staleCfg() }).stale, [70]);
  noteStale(s, 70, T);
  assert.deepEqual(tick(s, nodes, T + 60 * MIN, { config: staleCfg() }).stale, [], 'inside the cooldown');
  assert.deepEqual(tick(s, nodes, T + STALE + MIN, { config: staleCfg() }).stale, [70], 'one probe per window');
});

test('the liveness probe never touches sleeping or dead nodes', () => {
  const s = createAutoPingState();
  const nodes = [
    node(1, { isController: true }),
    seen(80, 50 * 60 * MIN, { isListening: false }),                  // battery
    seen(81, 50 * 60 * MIN, { status: NodeStatus.Dead }),             // remediation owns it
  ];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.deepEqual(d.stale, [], 'battery sleeps by design; a Dead node belongs to the other path');
});

test('the liveness probe obeys every gate auto-ping obeys', () => {
  const nodes = [node(1, { isController: true }), seen(90, 50 * 60 * MIN)];
  for (const [label, over] of [
    ['write actions off', { config: staleCfg({ writeActions: false }) }],
    ['own switch off', { config: staleCfg({ enabled: false }) }],
    ['boot window', { booting: true, config: staleCfg() }],
    ['rebuilding', { controller: { isRebuildingRoutes: true } as unknown as ControllerSnapshot, config: staleCfg() }],
  ] as const) {
    const s = createAutoPingState();
    assert.deepEqual(tick(s, nodes, T, over as never).stale, [], `must be suppressed: ${label}`);
  }
});

test('staleMs = 0 disables the liveness probe entirely', () => {
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(95, 500 * 60 * MIN)];
  assert.deepEqual(tick(s, nodes, T, { config: staleCfg({ staleMs: 0 }) }).stale, []);
});

/* ── the decision trace ───────────────────────────────────────────────── */

test('the runner reports WHY it did nothing, not just when it acts', async () => {
  // The defect this exists for: an enabled, healthy runner that emitted an
  // EMPTY log whether it had nothing to do or was broken. Those two states must
  // never again look identical.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const info: string[] = [];
  const nodes = mesh(20, [dead(7)]);
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'info') info.push(text); },
    config: staleCfg(), tickMs: 1_000_000, now: () => clock,
  });

  clock = T + MIN;            // inside the boot window
  h.tick();
  assert.equal(info.length, 1, 'the very first decision must be stated');
  assert.match(info[0], /suppressed: boot-window/, `got: ${info[0]}`);
  assert.match(info[0], /candidates=\d+/, 'the trace must carry its inputs');

  clock = T + BOOT_WINDOW_MS + MIN;   // gate opens — a CHANGE, so it re-states
  h.tick();
  assert.ok(info.length >= 2, 'a change of decision must be reported');
  assert.doesNotMatch(info[info.length - 1], /boot-window/);
  h.stop();
});

test('an unchanged decision is not repeated every tick', async () => {
  // Emitting the same line every 60s would bury the log it exists to clarify.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const info: string[] = [];
  // Every node heard from a minute ago ⇒ nothing due, nothing changes. (A mesh
  // of all-null lastSeen is NOT steady: each tick probes one and puts it on
  // cooldown, so stale-due genuinely counts down and the trace SHOULD change.)
  const nodes = [node(1, { isController: true }), seen(10, MIN), seen(11, MIN), seen(12, MIN)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'info') info.push(text); },
    config: staleCfg(), tickMs: 1_000_000, now: () => clock,
  });
  // Start PAST the boot window — otherwise the gate opening mid-run is itself a
  // change, and the run is not the steady state this test is about.
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  const first = info.length;
  for (let i = 2; i <= 6; i++) { clock = T + BOOT_WINDOW_MS + i * MIN; h.tick(); }
  assert.equal(info.length, first, 'a steady state must not re-log every tick');
  h.stop();
});

test('a steady state is still re-stated on the heartbeat', async () => {
  // Silence must never be the only evidence that the runner is alive.
  const { startAutoPing, TRACE_HEARTBEAT_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const info: string[] = [];
  const nodes = [node(1, { isController: true }), seen(10, MIN), seen(11, MIN)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'info') info.push(text); },
    config: staleCfg(), tickMs: 1_000_000, now: () => clock,
  });
  h.tick();
  const first = info.length;
  clock = T + TRACE_HEARTBEAT_MS + MIN;
  h.tick();
  assert.equal(info.length, first + 1, 'the heartbeat must re-state an unchanged decision');
  h.stop();
});

test('an autonomous action is visible in the SERVER log, not only the event ring', async () => {
  // The bug this pins: `log` writes to the in-memory event ring behind the login
  // gate, while operators grep the container log. Auto-ping used only the ring,
  // so 34 real probes were invisible from outside and the feature was diagnosed
  // as a no-op — the evidence existed, in a place the diagnosis never looked.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const ring: string[] = [];
  const server: string[] = [];
  const nodes = [node(1, { isController: true }), seen(77, 500 * MIN)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => ring.push(text),
    log2: Object.assign((m: string) => server.push(m), { debug: () => {} }),
    config: staleCfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  assert.ok(ring.some((m) => /liveness probe/.test(m)), 'must reach the event ring');
  assert.ok(server.some((m) => /liveness probe/.test(m)), 'must ALSO reach the server log');
  h.stop();
});

test('the probe log line reports MEASURED silence, never just the threshold', async () => {
  // The line used to print `staleMs` itself, so every probe claimed exactly
  // "240m" regardless of truth. That constant hid a 7-hour lastSeen parsing
  // skew for a full day: nodes 11 hours silent were logged as "240m", and
  // nothing in the log could contradict it. The message now carries the
  // node's measured silence with the threshold alongside for context.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  // The background nodes need FRESH lastSeen — a null lastSeen means "never
  // heard", which sorts as maximally stale and would outrank the node under
  // test (that ordering is correct behaviour, pinned elsewhere).
  const fresh = (id: number) => node(id, { stats: { lastSeen: T + 4 * MIN } as never });
  const nodes = [node(1, { isController: true }), fresh(100), fresh(101),
    node(9, { stats: { lastSeen: T - 700 * MIN } as never })];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  h.stop();
  const probe = lines.find((l) => l.includes('liveness probe'));
  assert.ok(probe, 'a stale node past the threshold must be probed');
  const silence = 700 + BOOT_WINDOW_MS / MIN + 1;
  assert.ok(probe!.includes(`unheard for ${Math.round(silence)}m`),
    `measured silence (~${silence}m) must appear, got: ${probe}`);
  assert.ok(probe!.includes('threshold 240m'), 'the threshold is context, labelled as such');
  assert.ok(!/unheard for 240m/.test(probe!), 'the measured value must not equal-by-construction the threshold');
});

/* ── v0.36: verification probes ride the SAME gate ladder ──────────────────── */

test('a ledger verification request is cleared when every gate passes', () => {
  const s = createAutoPingState();
  const nodes = mesh(20);
  const d = tick(s, nodes, T, { verifyDue: [100, 101] });
  assert.deepEqual(d.verify, [100, 101]);
});

test('verification probes obey EVERY suppressor auto-ping obeys', () => {
  // The whole reason these route through here instead of going straight out: a
  // verification probe is a write, and must never reach a mesh that auto-ping
  // itself would have left alone.
  const nodes = mesh(20);
  for (const [label, over] of [
    ['own switch off', { config: cfg({ enabled: false }) }],
    ['write actions off', { config: cfg({ writeActions: false }) }],
    ['boot window', { booting: true }],
    ['rebuilding routes', { controller: { isRebuildingRoutes: true } as ControllerSnapshot }],
  ] as const) {
    const s = createAutoPingState();
    const d = tick(s, nodes, T, { ...over, verifyDue: [100] });
    assert.deepEqual(d.verify, [], `verification leaked past: ${label}`);
    assert.notEqual(d.suppressed, 'none');
  }
});

test('a DEAD node is never verification-probed — the remediation path owns it', () => {
  // Otherwise the two lanes would race: remediation has a dwell, a backoff and
  // a 3-attempt budget, and verification has none of that.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  const d = tick(s, nodes, T, { verifyDue: [7, 100] });
  assert.deepEqual(d.verify, [100], 'the dead node is dropped, the live one kept');
});

test('a verification request for an unknown node is dropped, not fabricated', () => {
  const s = createAutoPingState();
  const d = tick(s, createAutoPingState() && mesh(20), T, { verifyDue: [999] });
  assert.deepEqual(d.verify, []);
});

test('a storm suppresses verification along with everything else', () => {
  const s = createAutoPingState();
  const many = Array.from({ length: 12 }, (_v, i) => dead(200 + i));
  const nodes = mesh(6, many);
  const d = tick(s, nodes, T, { verifyDue: [100] });
  assert.equal(d.suppressed, 'storm');
  assert.deepEqual(d.verify, []);
});

/* ── v0.36: a probe's ANSWER is judged from evidence, not from the call ────── */

test('a probe whose node lastSeen advanced is judged ANSWERED', () => {
  // The service call cannot tell us: HA's ping button awaits async_ping(), which
  // returns a boolean and raises nothing on silence. lastSeen is the only
  // observable that separates "the probe got through" from "we sent a packet
  // into the dark".
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, T);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T + 5_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: true }]);
  assert.equal(s.awaitingAnswer.size, 0, 'and the pending entry is cleared');
});

test('a probe whose node stayed silent is judged UNANSWERED — the signal that never existed', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, T);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false }]);
});

test('a node that has NEVER been heard from is unanswered, not silently skipped', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, T);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: null } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false }]);
});

test('a probe is NOT judged before its grace period — no verdict on an in-flight round trip', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, T);
  assert.deepEqual(judgeProbeAnswers(s, [node(7)], T + 10_000), []);
  assert.equal(s.awaitingAnswer.size, 1, 'still pending, still judgeable later');
});

test('a node that vanished from the roster is judged NEITHER way', () => {
  // A roster gap is not evidence of a failed probe, and calling it one would
  // manufacture exactly the false alarm this signal exists to avoid.
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, T);
  const out = judgeProbeAnswers(s, [node(8)], T + 120_000);
  assert.deepEqual(out, []);
  assert.equal(s.awaitingAnswer.size, 0, 'but it is dropped rather than pending forever');
});
