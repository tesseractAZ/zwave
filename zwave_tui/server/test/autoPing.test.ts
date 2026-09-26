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
  readRevivalsWithin,
  READ_REVIVAL_CAP,
  READ_REVIVAL_WINDOW_MS,
  PROBE_KILL_HOLD_MS,
  PROBE_KILL_WINDOW_MS,
  PROBE_KILL_WARN_AT,
  READ_LAUNCH_FALLBACK_MS,
  inProbeHold,
  probeKillsWithin,
  readFallbackActive,
  pendProbe,
  unpendProbe,
  noteStale,
  decideAutoPings,
  dropBlackoutProbes,
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
  rfOffSince?: number | null; bootDeadLane?: boolean; canRead?: (id: number) => boolean; paused?: boolean; operatorBusy?: boolean;
} = {}) {
  trackEpisodes(state, nodes, now);
  return decideAutoPings({
    now, state, nodes,
    controller: over.controller ?? null,
    config: over.config ?? cfg(),
    booting: over.booting ?? false,
    // Left undefined by default, so the ~40 callers that rely on the plain
    // boot-window early exit keep their meaning. A test that means to reach a
    // gate BELOW that exit has to release the dead lane explicitly (v0.65.0
    // review) — without it the decision returns at `booting && !bootDeadLane`
    // and the assertion below it is satisfied by the wrong branch.
    bootDeadLane: over.bootDeadLane,
    rfOffSince: over.rfOffSince ?? null,
    paused: over.paused,
    operatorBusy: over.operatorBusy,
    canRead: over.canRead,
    verifyDue: over.verifyDue ? () => over.verifyDue!.map((id) => ({ id, first: true })) : undefined,
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

  // First seen Dead inside the boot window with nothing on record, so its
  // outage is dated from this tick and the DWELL holds it. (Since v0.64.4 the
  // window itself no longer holds the dead ladder once the roster is ready —
  // see "after a restart, a node ALREADY Dead is probed once the roster is ready".)
  clock = T + BOOT_WINDOW_MS - MIN;
  h.tick();
  assert.deepEqual(pinged, [], 'a first sighting with no lastSeen serves its dwell');

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

test('EVERY listening node is swept, chatty ones included (v0.37)', () => {
  // Changed deliberately. Skipping talkative nodes saved a little traffic and
  // cost the one property that makes a reply rate worth keeping: comparability.
  // Sampled only when a node happens to be silent, the rate measures how
  // talkative the node is, not how reachable — so every node is now asked the
  // same question on the same cadence. Measured cost on the reference mesh:
  // all 35 listening candidates were already crossing the threshold anyway.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(51, 30 * MIN)];
  const d = tick(s, nodes, T, { config: staleCfg() });
  assert.deepEqual(d.stale, [51], 'a node heard from 30m ago is still asked');
});

test('the cadence gate still holds — a node is not re-probed within staleMs', () => {
  // The one remaining gate, and the one that matters: without it an unreachable
  // node never refreshes lastSeen, stays permanently due, and is re-probed on
  // every single tick.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(51, 30 * MIN)];
  assert.deepEqual(tick(s, nodes, T, { config: staleCfg() }).stale, [51]);
  noteStale(s, 51, T);
  assert.deepEqual(tick(s, nodes, T + 60 * MIN, { config: staleCfg() }).stale, [],
    'probed an hour ago, cadence is 240m — not due');
  assert.deepEqual(tick(s, nodes, T + 241 * MIN, { config: staleCfg() }).stale, [51],
    'and due again once the cadence has elapsed');
});

test('longest-unheard is still swept FIRST', () => {
  // Ask everyone, but ask the node with no independent proof of life before one
  // that has been chatting all along.
  const s = createAutoPingState();
  const nodes = [node(1, { isController: true }), seen(51, 30 * MIN), seen(52, 300 * MIN)];
  assert.deepEqual(tick(s, nodes, T, { config: staleCfg() }).stale, [52]);
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
  // From v0.37 the sweep asks EVERY node, so at startup every node is due and
  // the queue genuinely counts down — that is not a steady state and the trace
  // SHOULD change through it. The steady state begins once the first pass has
  // drained and every node is on its cadence cooldown.
  const nodes = [node(1, { isController: true }), seen(10, MIN), seen(11, MIN), seen(12, MIN)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'info' && text.includes('candidates=')) info.push(text); },
    config: staleCfg(), tickMs: 1_000_000, now: () => clock,
  });
  // Start PAST the boot window — otherwise the gate opening mid-run is itself a
  // change, and the run is not the steady state this test is about.
  clock = T + BOOT_WINDOW_MS + MIN;
  // Drain the first sweep: three nodes, one probe per tick, plus a tick for the
  // queue to reach empty.
  for (let i = 1; i <= 5; i++) { clock = T + BOOT_WINDOW_MS + i * MIN; h.tick(); }
  const first = info.length;
  for (let i = 6; i <= 12; i++) { clock = T + BOOT_WINDOW_MS + i * MIN; h.tick(); }
  assert.equal(info.length, first, 'once the sweep has drained, a steady state must not re-log every tick');
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
    // TRACE lines only: from v0.37 a probe fires on most ticks and each one
    // legitimately logs, so counting every info line measures probe activity
    // rather than the trace dedup this test is about.
    ping: async () => {}, log: (sev, _n, text) => { if (sev === 'info' && text.includes('candidates=')) info.push(text); },
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
  assert.ok(ring.some((m) => /liveness sweep/.test(m)), 'must reach the event ring');
  assert.ok(server.some((m) => /liveness sweep/.test(m)), 'must ALSO reach the server log');
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
  const probe = lines.find((l) => l.includes('liveness sweep'));
  assert.ok(probe, 'a stale node past the threshold must be probed');
  const silence = 700 + BOOT_WINDOW_MS / MIN + 1;
  // v0.66.0 moved this fixture — a fresh run, so no probe attribution yet —
  // out of the `unheard` arm, and the wording moved with it. What this test
  // pins did NOT move: the line must carry the node's MEASURED silence, with
  // the threshold alongside and labelled as the threshold.
  assert.ok(probe!.includes(`nothing heard for ${Math.round(silence)}m`),
    `measured silence (~${silence}m) must appear, got: ${probe}`);
  assert.ok(probe!.includes('past the 240m threshold'), 'the threshold is context, labelled as such');
  assert.ok(!/heard for 240m/.test(probe!), 'the measured value must not equal-by-construction the threshold');
});

test('a node that proved itself since the last sweep is labelled CONFIRMING, not unheard', async () => {
  // v0.37 asks everyone, so "you were asked" no longer implies "you were
  // silent". The line has to say which, or a confirming probe of a chatty node
  // reads exactly like the discovery of a silent one.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const chatty = node(9, { stats: { lastSeen: T + BOOT_WINDOW_MS } as never });
  const nodes = [node(1, { isController: true }), chatty];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  // Attribution is per-process, so the FIRST sweep after start cannot tell the
  // node's own traffic from a previous run's probe echo — it says so and
  // credits nothing (v0.40.2). Establish attribution with one judged probe,
  // then let the node genuinely speak.
  const T0 = T + BOOT_WINDOW_MS + MIN;
  clock = T0; h.tick();
  const first = lines.find((l) => l.includes('liveness sweep'));
  assert.match(first!, /no probe attribution yet — not credited/,
    `the first sweep of a run must not claim self-proof: ${first}`);
  (chatty.stats as { lastSeen: number | null }).lastSeen = T0 + 5_000;   // answers our probe
  clock = T0 + 2 * MIN; h.tick();                                        // judged → attributed
  (chatty.stats as { lastSeen: number | null }).lastSeen = T0 + 200 * MIN; // then speaks ON ITS OWN
  lines.length = 0;
  clock = T0 + 241 * MIN; h.tick();
  h.stop();
  const probe = lines.find((l) => l.includes('liveness sweep'));
  assert.ok(probe, 'a chatty node is still swept (v0.37)');
  assert.match(probe!, /already heard .* on its own — confirming/,
    `a self-proven node must say so, got: ${probe}`);
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
  // The service call cannot tell us: HA's ping button starts async_ping() in the
  // background and returns, and nothing is raised on silence. lastSeen is the only
  // observable that separates "the probe got through" from "we sent a packet
  // into the dark".
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T + 5_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: true, misses: 0, cls: 'unheard' as const, lane: 'sweep', frame: 'ping' }]);
  assert.equal(s.awaitingAnswer.size, 0, 'and the pending entry is cleared');
});

test('a probe whose node stayed silent is judged UNANSWERED — the signal that never existed', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false, misses: 1, cls: 'unheard' as const, lane: 'sweep', frame: 'ping' }]);
});

test('a node that has NEVER been heard from is unanswered, not silently skipped', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: null } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false, misses: 1, cls: 'unheard' as const, lane: 'sweep', frame: 'ping' }]);
});

test('a probe is NOT judged before its grace period — no verdict on an in-flight round trip', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  assert.deepEqual(judgeProbeAnswers(s, [node(7)], T + 10_000), []);
  assert.equal(s.awaitingAnswer.size, 1, 'still pending, still judgeable later');
});

test('a node that vanished from the roster is judged NEITHER way', () => {
  // A roster gap is not evidence of a failed probe, and calling it one would
  // manufacture exactly the false alarm this signal exists to avoid.
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(8)], T + 120_000);
  assert.deepEqual(out, []);
  assert.equal(s.awaitingAnswer.size, 0, 'but it is dropped rather than pending forever');
});

test('a verification probe is visible in BOTH log destinations, not just the ring', async () => {
  // This file's own rule, one screen up: "An autonomous action must be visible
  // in BOTH." v0.36.0 shipped these to the server log at debug only, and the
  // consequence was immediate — the first live deploy could not be verified
  // from the container log at all, which is the same shape of failure that once
  // had auto-ping itself diagnosed as a no-op.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const pinged: number[] = [];
  const server: string[] = [];
  const ring: string[] = [];
  const nodes = mesh(20);
  const log2 = Object.assign((m: string) => { server.push(m); }, { debug: () => {} });
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async (n) => { pinged.push(n); },
    log: (_s, _n, text) => { ring.push(text); },
    log2,
    verifyRequests: () => [{ id: 100, first: false }],
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  assert.deepEqual(pinged, [100], 'the probe fired');
  assert.ok(ring.some((l) => /verification probe/.test(l)), 'event ring records it');
  assert.ok(server.some((l) => /verification probe/.test(l)),
    `the container log an operator greps must record it too — got ${JSON.stringify(server)}`);
  h.stop();
});

test('an UNANSWERED probe is warned on both destinations; the answered case stays quiet', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const server: string[] = [];
  const debugged: string[] = [];
  // A node that never updates lastSeen: every probe to it goes unanswered.
  const silent = node(100, { stats: { lastSeen: null } as never });
  const nodes = [node(1, { isController: true }), silent];
  const log2 = Object.assign((m: string) => { server.push(m); }, { debug: (m: string) => { debugged.push(m); } });
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: () => {}, log2,
    verifyRequests: () => (clock === T + BOOT_WINDOW_MS + MIN ? [{ id: 100, first: false }] : []),
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();                       // probe fires
  clock += 5 * MIN;               // well past the answer grace
  h.tick();                       // judged
  assert.ok(server.some((l) => /did NOT answer/.test(l)),
    `an unanswered probe is the signal — it must reach the container log: ${JSON.stringify(server)}`);
  assert.ok(!debugged.some((l) => /answered its probe/.test(l)),
    'and a node that never answered must not also be logged as answering');
  h.stop();
});

test('a SUPPRESSED tick does not spend the ledger budget it will not use', () => {
  // The seam defect v0.36.0/.1 shipped: the runner drained the ledger's queue
  // while building the decision input, and decideAutoPings then returned early
  // at a suppressor — so a gated tick consumed a probe from the node's burst
  // without sending one. A 5-minute boot window at one tick a minute could
  // exhaust a whole 3-probe burst silently, and that is exactly when episodes
  // cluster, because a restart re-detects many symptoms at once.
  //
  // Both halves were individually correct and tested; only their JOIN was wrong.
  const nodes = mesh(20);
  for (const [label, over] of [
    ['boot window', { booting: true }],
    ['write actions off', { config: cfg({ writeActions: false }) }],
    ['own switch off', { config: cfg({ enabled: false }) }],
    ['rebuilding routes', { controller: { isRebuildingRoutes: true } as ControllerSnapshot }],
  ] as const) {
    const s = createAutoPingState();
    let drained = 0;
    trackEpisodes(s, nodes, T);
    const d = decideAutoPings({
      now: T, state: s, nodes,
      controller: over.controller ?? null,
      config: over.config ?? cfg(),
      booting: over.booting ?? false,
      verifyDue: () => { drained++; return [{ id: 100, first: true }]; },
    });
    assert.notEqual(d.suppressed, 'none', `${label} should suppress`);
    assert.deepEqual(d.verify, [], `${label}: nothing may be probed`);
    assert.equal(drained, 0, `${label}: the queue must not be drained on a tick that sends nothing`);
  }
});

test('an UNsuppressed tick drains exactly once', () => {
  const s = createAutoPingState();
  const nodes = mesh(20);
  let drained = 0;
  trackEpisodes(s, nodes, T);
  const d = decideAutoPings({
    now: T, state: s, nodes, controller: null, config: cfg(), booting: false,
    verifyDue: () => { drained++; return [{ id: 100, first: true }]; },
  });
  assert.equal(d.suppressed, 'none');
  assert.deepEqual(d.verify, [100]);
  assert.equal(drained, 1, 'drained once, and only once');
});

/* ── v0.36.4: giving up must be SAID, not just done ────────────────────────── */

test('a node that outlives the attempt budget is reported, once', () => {
  // maxAttempts is documented as "after which we stop and leave it to a human".
  // Through v0.36.3 it did the stopping only: a bare `continue`, no log, and
  // `attempts` resets solely when the node LEAVES Dead — so a node that stays
  // down is abandoned permanently and in silence. Observed live on node 23:
  // 3/3 exhausted, then 80 minutes of nothing, with the operator unable to tell
  // "given up" from "resolved" because both look like an absence of lines.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock);                       // observe it Dead
  clock += 11 * MIN; tick(s, nodes, clock);    // attempt 1
  noteAttempt(s, 7, clock);
  clock += 11 * MIN; tick(s, nodes, clock);    // attempt 2
  noteAttempt(s, 7, clock);
  clock += 31 * MIN; tick(s, nodes, clock);    // attempt 3
  noteAttempt(s, 7, clock);

  clock += 61 * MIN;
  const d = tick(s, nodes, clock);
  assert.deepEqual(d.ping, [], 'budget spent — it must stop probing');
  assert.deepEqual(d.gaveUp, [7], 'and it must SAY it has stopped');

  // Announced once: the runner records it, and the notice does not repeat every
  // tick for as long as the node stays down.
  s.gaveUpAnnounced.add(7);
  clock += 10 * MIN;
  assert.deepEqual(tick(s, nodes, clock).gaveUp, [], 'said once, not every minute');
});

test('recovery re-arms the notice, so a device that dies again is reported again', () => {
  const s = createAutoPingState();
  const alive = mesh(20, [node(7)]);
  s.gaveUpAnnounced.add(7);
  s.attempts.set(7, 3);
  trackEpisodes(s, alive, T);
  assert.equal(s.gaveUpAnnounced.has(7), false, 'leaving Dead clears the announcement');
  assert.equal(s.attempts.has(7), false, 'and the budget, as before');
});

test('a node still inside its budget is NOT reported as given up', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock);
  clock += 11 * MIN;
  const d = tick(s, nodes, clock);
  assert.deepEqual(d.ping, [7], 'it is still being probed');
  assert.deepEqual(d.gaveUp, [], 'so it has not been given up on');
});

/* ── v0.36.5: transient miss vs persistent failure ────────────────────────── */

test('the miss streak counts CONSECUTIVE failures and one answer resets it', () => {
  // Measured live: excluding one genuinely broken node, ~2% of probes to healthy
  // nodes went unanswered — a steady drip of ordinary transient loss producing
  // lines textually identical to a device that was actually down.
  const s = createAutoPingState();
  const silent = (t: number) => [node(7, { stats: { lastSeen: t } as never })];
  const miss = (i: number): number => {
    s.awaitingAnswer.set(7, [{ at: T + i * 1000, cls: 'unheard' as const, lane: 'sweep' }]);
    return judgeProbeAnswers(s, silent(T - 60_000), T + i * 1000 + 120_000)[0].misses;
  };
  assert.equal(miss(1), 1, 'first miss');
  assert.equal(miss(2), 2, 'second in a row');
  assert.equal(miss(3), 3, 'third in a row');

  // One answer wipes the streak — "3rd miss" must always mean three in a row,
  // never three since the beginning of time.
  s.awaitingAnswer.set(7, [{ at: T + 10_000, cls: 'unheard' as const, lane: 'sweep' }]);
  const ok = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T + 11_000 } as never })], T + 200_000)[0];
  assert.equal(ok.answered, true);
  assert.equal(ok.misses, 0);
  assert.equal(miss(20), 1, 'and the next failure starts a fresh streak');
});

test('a FIRST miss is info; a streak is a warning — neither is suppressed', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const ring: Array<{ sev: string; text: string }> = [];
  // A node that never updates lastSeen: every probe to it goes unanswered.
  const nodes = [node(1, { isController: true }), node(100, { stats: { lastSeen: null } as never })];
  let due = true;
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {},
    log: (sev, _n, text) => { ring.push({ sev, text }); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    verifyRequests: () => (due ? [{ id: 100, first: false }] : []),
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();   // probe 1
  due = false;
  clock += 5 * MIN; h.tick();                   // judged: 1st miss
  due = true;  clock += MIN; h.tick();          // probe 2
  due = false; clock += 5 * MIN; h.tick();      // judged: 2nd miss

  const misses = ring.filter((r) => /did NOT answer/.test(r.text));
  assert.equal(misses.length, 2, `expected two miss lines, got ${JSON.stringify(misses)}`);
  assert.match(misses[0].text, /1st consecutive miss/);
  assert.equal(misses[0].sev, 'info', 'a single lost packet is not a warning');
  assert.match(misses[1].text, /2nd consecutive miss/);
  assert.equal(misses[1].sev, 'warn', 'a streak is');
  h.stop();
});

test('ordinals read correctly past the awkward teens', async () => {
  const { judgeProbeAnswers: judge } = await import('../src/zwave/autoPing');
  const s = createAutoPingState();
  s.missStreak.set(7, 10);
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  assert.equal(judge(s, [node(7, { stats: { lastSeen: null } as never })], T + 200_000)[0].misses, 11);
});

test('every probe outcome is REPORTED for the persisted reply rate', async () => {
  // Without this the whole v0.37 feature is inert: probes fire, answers are
  // judged, and nothing reaches the store — leaving exactly the ephemeral log
  // lines v0.36 already had. A mutant that deletes the callback survived a
  // fully-passing suite until this test existed.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const reported: Array<{ id: number; answered: boolean; self: boolean }> = [];
  // Node 9 never updates lastSeen ⇒ its probe goes unanswered and it is not
  // self-proven. Node 10 is heard from continuously ⇒ answered AND self-proven.
  const silent = node(9, { stats: { lastSeen: null } as never });
  const chatty = () => node(10, { stats: { lastSeen: clock } as never });
  let nodes = [node(1, { isController: true }), silent, chatty()];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: () => {},
    onProbeResult: (id, answered, cls) => { reported.push({ id, answered, self: cls === 'self-proven' }); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  // Sweep both (one per tick), then let the answers mature past the grace.
  // Two full rounds: the first establishes probe attribution (v0.40.2 credits
  // nothing until a probe of THIS run has been judged), the second measures.
  for (let round = 0; round < 2; round++) {
    clock = T + BOOT_WINDOW_MS + MIN + round * 300 * MIN;
    nodes = [node(1, { isController: true }), silent, chatty()]; h.tick();
    clock += MIN;     nodes = [node(1, { isController: true }), silent, chatty()]; h.tick();
    clock += 5 * MIN; nodes = [node(1, { isController: true }), silent, chatty()]; h.tick();
  }
  h.stop();

  const nine = reported.find((r) => r.id === 9);
  const ten = [...reported].reverse().find((r) => r.id === 10); // the measured round
  assert.ok(nine, `node 9's outcome must be reported: ${JSON.stringify(reported)}`);
  assert.equal(nine!.answered, false, 'a node that never advanced lastSeen did not answer');
  assert.equal(nine!.self, false, 'and it certainly did not prove itself');
  assert.ok(ten, `node 10's outcome must be reported: ${JSON.stringify(reported)}`);
  assert.equal(ten!.answered, true);
  assert.equal(ten!.self, true, 'a node talking within the cadence is self-proven');
});

test('the verification probe line carries its own spacing and the contention (v0.37.1)', async () => {
  // The diagnostic that makes the burst measurable. Two episodes closed
  // `unverifiable` on live nodes that had received 8 and 5 probes, and the
  // leading hypothesis — that a one-per-tick GLOBAL queue stretches each node's
  // burst past the 5-minute window it must land inside — could not be confirmed,
  // because the add-on log carries no timestamps and the decision trace only
  // prints on change. A fix aimed at an unconfirmed cause is a guess.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const nodes = mesh(20);
  let owed = 2;
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    verifyRequests: () => [{ id: 100, first: false }],
    verifyOwedCount: () => owed,
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  const first = lines.find((l) => /verification probe/.test(l))!;
  assert.match(first, /burst start/, 'the first probe of a burst has no prior gap to report');
  assert.match(first, /, 2 nodes owed\)/, 'and states how many NODES are dividing the queue (v0.72.1: a bare "2 owed" read as this node\'s backlog)');

  lines.length = 0;
  owed = 1;
  clock += 140_000; // two ticks later
  h.tick();
  const second = lines.find((l) => /verification probe/.test(l))!;
  assert.match(second, /\+140s/, `the measured gap must appear, got: ${second}`);
  assert.match(second, /, 1 node owed\)/, `one node is singular, got: ${second}`);
  h.stop();
});

test('the burst-start label comes from the QUEUE, not from a clock (v0.38.2)', async () => {
  // Two generations of time heuristic each lied in an audit: the per-node gap
  // conflated inter-burst pauses with stretched bursts (v0.37.1), then the
  // 4-minute threshold mislabeled the boundary as "+180s" whenever a symptom
  // cleared mid-burst and the open->confirm pause came in UNDER it (v0.37.2) —
  // reading as slow spacing and sending the reviewer down the wrong path a
  // second time. The queue KNOWS which probe starts a burst; the label now
  // rides that flag and no pause of any length can forge or hide a boundary.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const nodes = mesh(20);
  let entry: { id: number; first: boolean } = { id: 100, first: true };
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    verifyRequests: () => [entry], verifyOwedCount: () => 1,
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  const probeLine = (): string => lines.filter((l) => /verification probe/.test(l)).slice(-1)[0];

  clock = T + BOOT_WINDOW_MS + MIN; h.tick();
  assert.match(probeLine(), /burst start/, 'the queue says first — the label agrees');

  entry = { id: 100, first: false };
  clock += 120_000; h.tick();
  assert.match(probeLine(), /\+120s/, 'mid-burst reports the measured spacing');

  // A pause SHORTER than any heuristic threshold, but the queue says a new
  // burst began — the label must follow the queue, not the clock.
  entry = { id: 100, first: true };
  clock += 60_000; h.tick();
  assert.match(probeLine(), /burst start/,
    `a 60s-later first-of-burst is still a burst start: ${probeLine()}`);

  // And a LONG pause mid-burst must NOT forge a boundary.
  entry = { id: 100, first: false };
  clock += 10 * MIN; h.tick();
  assert.match(probeLine(), /\+600s/,
    `a slow mid-burst probe reports its real gap, never a fake boundary: ${probeLine()}`);
  h.stop();
});


/* ── v0.38.1: measurement lanes use the non-learning probe ─────────────────── */

test('the SWEEP and VERIFY lanes use probe(); only the DEAD ladder uses the learning ping()', async () => {
  // Which function a lane calls decides whether the ledger hears about it, and
  // getting it backwards in either direction is a defect: measurement lanes on
  // ping() starve the control arm (the audit finding); the dead ladder on
  // probe() would un-instrument the one autonomous remediation this module's
  // autonomy is justified by.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const pinged: number[] = [];
  const probed: number[] = [];
  const deadNode = dead(7);
  const staleNode = node(50, { stats: { lastSeen: T - 300 * MIN } as never });
  // Background nodes need FRESH lastSeen: a null lastSeen means "never heard",
  // which sorts as maximally stale and would outrank the node under test.
  const nodes = [node(1, { isController: true }), deadNode, staleNode,
    ...Array.from({ length: 18 }, (_v, i) => node(100 + i, { stats: { lastSeen: T + 4 * MIN } as never }))];
  let due = false;
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async (n) => { pinged.push(n); },
    probe: async (n) => { probed.push(n); },
    verifyRequests: () => (due ? [{ id: 100, first: false }] : []),
    log: () => {},
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();       // observe dead; sweep fires for stalest
  clock += 11 * MIN; due = true; h.tick();          // dead ladder due + a verification probe
  h.stop();
  assert.ok(probed.includes(50), `the sweep must use probe(): ${JSON.stringify({ pinged, probed })}`);
  assert.ok(probed.includes(100), 'the verification lane must use probe()');
  assert.ok(pinged.includes(7), 'the dead ladder must use the LEARNING ping()');
  assert.ok(!pinged.includes(50) && !pinged.includes(100), 'and no measurement lane may leak onto it');
});

/* ── v0.40: per-probe judgment + attribution-aware self-proven ─────────────── */

test('every probe in a burst is judged — a dying node logs five misses, not one (v0.40)', () => {
  // The single-slot map meant 60s burst spacing under the 90s grace overwrote
  // each pending judgment: only the LAST probe of every burst was ever judged,
  // and a node dying mid-burst had five consecutive misses recorded as a
  // "1st consecutive miss".
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }, { at: T + 60_000, cls: 'unheard' as const, lane: 'sweep' }, { at: T + 120_000, cls: 'unheard' as const, lane: 'sweep' }, { at: T + 180_000, cls: 'unheard' as const, lane: 'sweep' }, { at: T + 240_000, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 240_000 + 120_000);
  assert.deepEqual(out.map((o) => o.misses), [1, 2, 3, 4, 5], 'five probes, five judgments, one honest streak');
});

test('young probes stay pending while matured ones are judged (v0.40)', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }, { at: T + 60_000, cls: 'unheard' as const, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 100_000);
  assert.equal(out.length, 1, 'only the matured probe is judged');
  assert.deepEqual(s.awaitingAnswer.get(7), [{ at: T + 60_000, cls: 'unheard' as const, lane: 'sweep' }], 'the in-flight probe is still pending');
});

test('an answered probe records what OUR probe put on the record (v0.40)', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, cls: 'unheard' as const, lane: 'sweep' }]);
  judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T + 5_000 } as never })], T + 120_000);
  assert.equal(s.lastProbeSeen.get(7), T + 5_000, 'the attributed lastSeen is remembered for the sweep');
});

test('a node heard ONLY answering our probe is not "on its own" — the echo is not the voice (v0.40)', async () => {
  // The audit's tell: "already heard 120m ago on its own — confirming" was a
  // full staleness threshold of silence described as confirming, because the
  // "heard" event was the node answering the PREVIOUS sweep's probe. For
  // quiet-but-answering nodes the confirming/unheard split was a sticky
  // sub-minute scheduling bias persisted as if it were device behavior.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const results: Array<{ id: number; ok: boolean; self: boolean }> = [];
  const quiet = node(9, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), quiet];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    onProbeResult: (id, ok, cls) => { results.push({ id, ok, self: cls === 'self-proven' }); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  const T0 = T + BOOT_WINDOW_MS + MIN;
  clock = T0; h.tick();                                  // sweep 1 probes node 9
  (quiet.stats as { lastSeen: number | null }).lastSeen = T0 + 5_000; // it answers
  clock = T0 + 2 * MIN; h.tick();                        // judged: answered, attributed
  lines.length = 0;
  clock = T0 + 240 * MIN; h.tick();                      // sweep 2: only contact is our echo
  const echo = lines.find((l) => l.includes('liveness sweep'));
  assert.ok(echo, 'the node is swept again at cadence');
  assert.match(echo!, /nothing heard past our last probe's answer \d+m ago — probing for its own voice/,
    `the echo must not read as the node's own voice: ${echo}`);
  assert.ok(!/on its own — confirming/.test(echo!), 'and never as confirming');

  // Now the node genuinely speaks on its own — confirming returns.
  (quiet.stats as { lastSeen: number | null }).lastSeen = T0 + 242 * MIN;
  lines.length = 0;
  clock = T0 + 481 * MIN; h.tick();                      // due again; heard 239m ago on its own
  const own = lines.find((l) => l.includes('liveness sweep'));
  assert.match(own!, /on its own — confirming/, `a real advance past the echo confirms: ${own}`);
  clock = T0 + 483 * MIN; h.tick();                      // judge the third probe too
  h.stop();
  // The persisted flag followed each probe's OWN context — first sweep true
  // (nothing attributed yet), the echo false, the own-voice sweep true again.
  // Pinning all three also pins that a newer sweep can no longer overwrite an
  // older probe's flag before judgment (the single-slot disease, both maps).
  const flags = results.filter((r) => r.id === 9).map((r) => r.self);
  // First sweep of the run: attribution unknown ⇒ credited to nothing (v0.40.2).
  assert.deepEqual(flags, [false, false, true], `persisted selfProven must match the labels: ${JSON.stringify(results)}`);
});

test('unpendProbe withdraws exactly ONE entry — the failed probe, not the pending list (v0.40 review)', () => {
  // A transport failure on one probe must not discard the judgments owed to
  // the node's other in-flight probes.
  const s = createAutoPingState();
  pendProbe(s, 9, T, 'sweep', 'self-proven');
  pendProbe(s, 9, T + 60_000, 'sweep', 'unheard');
  unpendProbe(s, 9, T + 60_000);
  assert.deepEqual(s.awaitingAnswer.get(9), [{ at: T, cls: 'self-proven' as const, lane: 'sweep', frame: 'ping' as const }],
    'only the failed probe was withdrawn; its sibling still awaits judgment');
  unpendProbe(s, 9, T);
  assert.equal(s.awaitingAnswer.has(9), false, 'the emptied list is cleaned up');
});

test('a node owed a verification probe this tick is dropped from the sweep — one measurement probe per node per tick (v0.40 review)', () => {
  // Twin same-tick probes shared one `at`: a transport failure on one lane
  // withdrew the OTHER lane's entry, and one silent instant counted as two
  // consecutive misses. The verify probe answers the sweep's question.
  const s = createAutoPingState();
  // Node 9 must actually be the sweep queue's head: everyone else was heard a
  // minute ago (a null lastSeen sorts to the very front and would steal it).
  const quiet = node(9, { stats: { lastSeen: T - 300 * MIN } as never });
  const chatty = [node(1, { isController: true }), node(100, { stats: { lastSeen: T - MIN } as never }), node(101, { stats: { lastSeen: T - MIN } as never })];
  const nodes = [...chatty, quiet];
  const s2 = createAutoPingState();
  const control = decideAutoPings({
    now: T, state: s2, nodes, controller: null,
    config: cfg({ staleMs: 240 * MIN }), booting: false,
  });
  assert.deepEqual(control.stale, [9], 'fixture check: without a verify owed, node 9 IS the sweep head');
  const d = decideAutoPings({
    now: T, state: s, nodes, controller: null,
    config: cfg({ staleMs: 240 * MIN }), booting: false,
    verifyDue: () => [{ id: 9, first: true }],
  });
  assert.deepEqual(d.verify, [9], 'the verification probe goes out');
  assert.deepEqual(d.stale, [], 'the sweep stands down for this node this tick');
  assert.ok(d.staleDue >= 1, 'the node is still counted due — it is deferred, not forgotten');
});

test('a probe-echo-only node reads ECHO past the threshold too — the label follows attribution, not boundary jitter (v0.40.1)', async () => {
  // The first v0.40.0 audit caught the recency gate splitting one physical
  // situation into two labels: a node whose probe answer was 119m old read
  // echo, 121m read "unheard for 120m" — sub-minute scheduling jitter, sticky
  // per node (production node 7: 8/10 "unheard" while answering every probe).
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const quiet = node(9, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), quiet];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  const T0 = T + BOOT_WINDOW_MS + MIN;
  clock = T0; h.tick();                                  // sweep 1 probes node 9
  (quiet.stats as { lastSeen: number | null }).lastSeen = T0 + 5_000; // it answers
  clock = T0 + 2 * MIN; h.tick();                        // judged: answered, attributed
  lines.length = 0;
  clock = T0 + 245 * MIN; h.tick();                      // sweep 2: the answer is now PAST the threshold
  h.stop();
  const probe = lines.find((l) => l.includes('liveness sweep'));
  assert.ok(probe, 'the node is swept');
  assert.match(probe!, /nothing heard past our last probe's answer \d+m ago — probing for its own voice/,
    `attribution routes the label even past the threshold, and carries the measured silence: ${probe}`);
  assert.ok(!/unheard for/.test(probe!), 'a node answering our probes is never "unheard"');
});

/* ── v0.40.2: a probe that never left is never judged ───────────────────────── */

test('a RESOLVED {ok:false} withdraws the probe from judgment — run() returns, it does not throw (v0.40.2)', async () => {
  // The critical defect: zwaveActions.run() catches its own errors and RETURNS
  // {ok:false}, so the .catch every lane relied on sat on a promise that could
  // not reject. unpendProbe never executed in production, and every add-on-side
  // failure — HA WS down, Core restarting, no ping button — was judged a moment
  // later as THE NODE failing to answer.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const reported: Array<{ id: number; answered: boolean }> = [];
  const quiet = node(9, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), quiet];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    // Exactly what the production runner does on a transport fault.
    ping: async () => ({ ok: false, message: 'HA WS not ready' }),
    probe: async () => ({ ok: false, message: 'HA WS not ready' }),
    log: (_s, _n, text) => { lines.push(text); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    onProbeResult: (id, answered) => { reported.push({ id, answered }); },
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();
  await new Promise((r) => setImmediate(r));       // let the resolution settle
  clock += 5 * MIN; h.tick();                       // past the answer grace
  h.stop();
  assert.ok(lines.some((l) => /could not be probed .* — not judged/.test(l)),
    `the failed launch must say so: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /did NOT answer/.test(l)),
    `a packet that never left must NOT be blamed on the node: ${JSON.stringify(lines)}`);
  assert.deepEqual(reported, [], 'and nothing reaches the persisted reply rate');
});

test('a failed launch refunds the remediation attempt but is itself BOUNDED (v0.40.2)', async () => {
  // Two failures in one: noteAttempt fires before the call, so without a refund
  // an HA restart spends a node's budget on packets never transmitted — but the
  // first cut of that refund handed back `attempts` AND the backoff clock,
  // which a pre-release review measured as 190 pings in 200 minutes with
  // "attempt 1/3" logged every minute and the give-up unreachable. Both
  // properties are pinned here: the node's remediation budget survives, and the
  // engine does not spin.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let launches = 0;
  const launchAt: number[] = [];
  const lines: string[] = [];
  const nodes = [node(1, { isController: true }), dead(7)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => { launches++; launchAt.push(clock); return { ok: false, message: 'HA WS not ready' }; },
    log: (_s, _n, text) => { lines.push(text); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg({ maxAttempts: 3 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();          // establishes deadSince
  for (let i = 0; i < 200; i++) {                       // 200 minutes, one tick each
    clock += MIN; h.tick();
    await new Promise((r) => setImmediate(r));          // let each launch settle
  }
  h.stop();
  assert.ok(launches <= 4, `a failing launch must not spin: ${launches} launches in 200 ticks`);
  // The BOUND alone does not prove throttling — a budget of 3 also stops a
  // once-per-tick loop after 3 ticks. The SPACING is what the backoff buys.
  for (let i = 1; i < launchAt.length; i++) {
    assert.ok(launchAt[i] - launchAt[i - 1] >= 10 * MIN,
      `retries must respect the backoff ladder, got ${(launchAt[i] - launchAt[i - 1]) / MIN}m apart`);
  }
  assert.ok(!lines.some((l) => /did not answer \d+ ping/.test(l)),
    'the NODE must not be blamed for a packet that never left this add-on');
  assert.ok(lines.some((l) => /could not be probed 3× in a row/.test(l)),
    `the add-on-side fault must announce itself: ${JSON.stringify(lines.slice(-3))}`);
  assert.ok(lines.every((l) => !/attempt [23]\/3/.test(l)),
    'and the remediation budget is never spent by a launch that never left');
});

test('only the SWEEP lane feeds the persisted reply rate — verification probes are symptom-correlated (v0.40.2)', async () => {
  // staleMs 0 disables the sweep entirely, so the ONLY probes in this run are
  // verification ones — nothing here may reach the comparable reply rate, on
  // either the answered or the missed judgment path.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const reported: number[] = [];
  const quiet = node(9, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), quiet];
  let due: { id: number; first: boolean }[] = [];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async () => {},
    log: () => {}, log2: Object.assign(() => {}, { debug: () => {} }),
    onProbeResult: (id) => { reported.push(id); },
    verifyRequests: () => { const d = due; due = []; return d; },
    config: cfg({ staleMs: 0 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; due = [{ id: 9, first: true }]; h.tick();
  (quiet.stats as { lastSeen: number | null }).lastSeen = clock + 5_000;
  clock += 5 * MIN; h.tick();                       // judged ANSWERED
  assert.deepEqual(reported, [], 'an ANSWERED verification probe must not move the comparable reply rate');
  due = [{ id: 9, first: true }]; clock += MIN; h.tick();
  clock += 5 * MIN; h.tick();                       // judged MISSED
  h.stop();
  assert.deepEqual(reported, [], 'nor a missed one');
});

test('roster departure prunes the judgment bookkeeping too (v0.40.2)', () => {
  const s = createAutoPingState();
  const nodes = mesh(3, [node(77)]);
  tick(s, nodes, T);
  s.missStreak.set(77, 2);
  s.gaveUpAnnounced.add(77);
  s.lastVerifyAt.set(77, T);
  pendProbe(s, 77, T, 'sweep');
  trackEpisodes(s, mesh(3), T + MIN);               // node 77 leaves the roster
  assert.equal(s.missStreak.has(77), false, 'a re-included id must not inherit a miss streak');
  assert.equal(s.awaitingAnswer.has(77), false);
  assert.equal(s.gaveUpAnnounced.has(77), false);
  assert.equal(s.lastVerifyAt.has(77), false);
});

test('a sweep launch that never left does not cost the node its cadence slot (v0.40.2)', async () => {
  // noteStale books the cadence clock before the call, so an unrefunded failure
  // makes the node wait a full staleMs having never actually been asked.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let launches = 0;
  let failing = true;
  const quiet = node(9, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), quiet];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => { launches++; return failing ? { ok: false, message: 'HA WS not ready' } : undefined; },
    probe: async () => { launches++; return failing ? { ok: false, message: 'HA WS not ready' } : undefined; },
    log: () => {}, log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();       // sweep launch fails
  await new Promise((r) => setImmediate(r));
  assert.equal(launches, 1);
  failing = false;
  clock += MIN; h.tick();                           // next tick: still due, asked again
  await new Promise((r) => setImmediate(r));
  h.stop();
  assert.equal(launches, 2, 'the node keeps its slot in the sweep queue');
});

test('the auto-ping snapshot reports the engine\'s REAL state, not defaults (v0.41)', async () => {
  // The ENGINE screen renders straight off this. A snapshot frozen at defaults
  // would show a permanently idle, unsuppressed engine however the real one
  // behaves — a screen that lies is worse than no screen.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  // A third of the mesh dead trips the storm suppressor.
  const deadOnes = Array.from({ length: 8 }, (_v, i) => dead(200 + i));
  const nodes = mesh(20, deadOnes);
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: () => {}, log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  assert.equal(h.snapshot().lastTickMs, null, 'before the first pass it says so rather than inventing one');
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();
  const snap = h.snapshot();
  h.stop();
  assert.equal(snap.suppressed, 'storm', 'the real suppression reason reaches the snapshot');
  // A suppressed pass returns BEFORE reading the sweep and verify queues, so
  // reporting 0 there would assert an empty backlog nothing looked at.
  assert.equal(snap.staleDue, null, 'an unread queue is null, never a fabricated 0');
  assert.equal(snap.verifyOwed, null);
  assert.equal(snap.lastTickMs, clock);
  assert.ok(snap.deadListening >= 8, `the real dead count reaches the snapshot: ${snap.deadListening}`);
  assert.ok(snap.nodes.some((n) => n.deadSinceMs != null), 'and per-node ladder state is populated');
});

test('the give-up waits for the final probe to be JUDGED — an ERROR must not precede its evidence (v0.41.2)', async () => {
  // The answer grace (90s) exceeds the tick (60s), so the decision pass that
  // exhausts the budget runs one tick before the last probe can be judged.
  // Announcing "STILL DEAD — needs a human" there puts the ERROR ahead of the
  // evidence it rests on.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const nodes = [node(1, { isController: true }), dead(7)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg({ maxAttempts: 1 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();        // deadSince
  clock += 30 * MIN; h.tick();                       // attempt 1/1 fires, probe pends
  const atLaunch = lines.filter((l) => /did not answer \d+ ping/.test(l)).length;
  assert.equal(atLaunch, 0, 'no give-up while the probe is still in flight');
  clock += 30 * MIN; h.tick();                       // probe matures and is judged
  clock += MIN; h.tick();                            // now the budget is provably spent
  h.stop();
  const miss = lines.findIndex((l) => /did NOT answer/.test(l));
  const gave = lines.findIndex((l) => /did not answer \d+ ping/.test(l));
  assert.ok(gave >= 0, `the give-up still fires: ${JSON.stringify(lines)}`);
  assert.ok(miss >= 0 && miss < gave,
    `the evidence must precede the verdict: miss@${miss} gave@${gave}`);
});

/* ── v0.42.0: traffic outranks the driver's Dead flag ─────────────────────── */

test('a node that reads Dead but was HEARD inside the dwell is never probed or given up on (v0.42.0)', () => {
  // Node 49 ("Garage Workroom") ignored SIX consecutive pings over ~12 hours
  // and was declared node-down — then answered an ordinary on/off command
  // immediately and came back grade A with +25 dB of margin. The ping button
  // issues a NOP; that device does not answer NOPs. `status === Dead` is the
  // driver's REACTIVE opinion, but traffic is evidence.
  const s = createAutoPingState();
  const talking = dead(49, { stats: { lastSeen: T + 55 * MIN } as never });
  const nodes = mesh(20, [talking]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 60 * MIN);           // long past the 10m dwell
  assert.deepEqual(d.ping, [], 'no remediation budget is spent on a node that is talking');
  assert.deepEqual(d.gaveUp, [], 'and no human is summoned');
  assert.deepEqual(d.talkingWhileDead, [49], 'the stale flag is reported instead');
});

test('a node that reads Dead and is genuinely SILENT is still probed (v0.42.0)', () => {
  // The guard must not swallow the case the ladder exists for.
  const s = createAutoPingState();
  const silent = dead(49, { stats: { lastSeen: T - 5 * 60 * MIN } as never });
  const nodes = mesh(20, [silent]);
  tick(s, nodes, T);
  const d = tick(s, nodes, T + 60 * MIN);
  assert.deepEqual(d.ping, [49], 'a genuinely silent dead node is still remediated');
  assert.deepEqual(d.talkingWhileDead, []);
});

test('the stale-flag notice is announced ONCE per outage and cleared on recovery (v0.42.0)', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  let nodes = [node(1, { isController: true }), dead(49, { stats: { lastSeen: T } as never })];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  nodes = [node(1, { isController: true }), dead(49, { stats: { lastSeen: clock } as never })];
  h.tick(); h.tick();                                // twice — must announce once
  const said = lines.filter((l) => /reads Dead but was heard/.test(l));
  assert.equal(said.length, 1, `announced once per outage: ${JSON.stringify(said)}`);
  assert.match(said[0], /trusting the traffic over the flag/);
  // Recovery clears the latch, so a later outage is announced again.
  nodes = [node(1, { isController: true }), node(49, { stats: { lastSeen: clock } as never })];
  h.tick();
  clock += 60 * MIN;
  nodes = [node(1, { isController: true }), dead(49, { stats: { lastSeen: clock } as never })];
  h.tick(); h.tick();
  h.stop();
  assert.equal(lines.filter((l) => /reads Dead but was heard/.test(l)).length, 2,
    'a fresh outage is announced again');
});

test('the give-up says what it MEASURED — unanswered NOPs, not unreachability (v0.42.0)', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const nodes = [node(1, { isController: true }), dead(7)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => { lines.push(text); },
    log2: Object.assign(() => {}, { debug: () => {} }),
    config: cfg({ maxAttempts: 1 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();
  clock += 30 * MIN; h.tick();
  clock += 30 * MIN; h.tick();
  clock += MIN; h.tick();
  h.stop();
  const gave = lines.find((l) => /giving up/.test(l));
  assert.ok(gave, `the give-up fires: ${JSON.stringify(lines)}`);
  assert.match(gave!, /NOT that it is unreachable/, 'it must not overclaim');
  assert.match(gave!, /try OPERATING the device/, 'and it leads with the step that actually works');
  assert.ok(!/ 1 pings| 1 NOP frames/.test(gave!), `plural agreement: ${gave}`);
});

test('notePending registers a MANUAL probe that never feeds the persisted reply rate (v0.47.0)', async () => {
  // The `lane === 'sweep'` gate is the whole point of the lane type. A manual
  // ping already reaches the ledger's ACTION arm via the runner's `learn: true`,
  // so routing it into onProbeResult would double-attribute it — and it would
  // reintroduce the symptom-correlated skew v0.40.2 removed, since an operator
  // pings exactly the nodes they suspect.
  //
  // Driven through the RUNNER's own notePending: the DEFAULT lane is what is
  // under test, and calling pendProbe directly supplies the lane explicitly and
  // so proves nothing about it.
  const { startAutoPing } = await import('../src/zwave/autoPing');
  let clock = T;
  const results: { id: number; ok: boolean }[] = [];
  const nodes = mesh(20, []);
  const h = startAutoPing({
    nodes: () => nodes,
    controller: () => null,
    ready: () => true,
    ping: async () => {},
    log: () => {},
    config: cfg(),
    tickMs: 1_000_000,
    now: () => clock,
    onProbeResult: (id, ok) => { results.push({ id, ok }); },
  });
  try {
    // Node 100 is in `mesh`'s roster — a node ABSENT from it is refused by the
    // judge ("a roster gap is not a failed probe"), which would make this pass
    // for the wrong reason.
    h.notePending(100);
    assert.ok(nodes.some((n) => n.nodeId === 100), 'precondition: the node is on the roster');
    // Let the answer grace elapse so the probe is actually judged.
    clock = T + 30 * MIN;
    h.tick();
    assert.deepEqual(results, [],
      `a MANUAL probe must never reach onProbeResult: ${JSON.stringify(results)}`);
  } finally { h.stop(); }
});

test('the manual lane is labelled as such, so the sweep gate can exclude it (v0.47.0)', () => {
  const st = createAutoPingState();
  pendProbe(st, 7, 1000, 'manual');
  const owed = st.awaitingAnswer.get(7) ?? [];
  assert.equal(owed.length, 1, 'the probe is owed an answer');
  assert.equal(owed[0].lane, 'manual');
  assert.notEqual(owed[0].lane, 'sweep', 'that lane feeds the persisted rate');
});


test('auto-ping RAISES its leveled messages in the container log, not only the ring (v0.50.0)', async () => {
  // The log2 TYPE foreclosed severity — `((msg) => void) & { debug? }` has no
  // warn/error members — so every leveled message was paired with a BARE
  // `log2?.(m)` and autoPing's two ERROR sites and its WARN site all reached
  // the container log at info. The ring carried the severity; the surface an
  // operator greps did not.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  const raised: { level: string; msg: string }[] = [];
  const log2 = Object.assign((m: string) => raised.push({ level: 'info', msg: m }), {
    debug: (m: string) => raised.push({ level: 'debug', msg: m }),
    warn: (m: string) => raised.push({ level: 'warn', msg: m }),
    error: (m: string) => raised.push({ level: 'error', msg: m }),
  });
  // A STORM: enough mains nodes Dead that the sweep stands down. That warning
  // is the one message this file calls "worth saying out loud", and it was the
  // ONLY auto-ping message with no log2 companion at all — announced on a
  // screen behind the login gate and nowhere an operator greps.
  let clock = T;
  const nodes = [node(1, { isController: true }), ...Array.from({ length: 12 }, (_, i) => dead(20 + i))];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: () => {}, log2,
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  try {
    clock = T + BOOT_WINDOW_MS + 30 * MIN;
    h.tick();
  } finally { h.stop(); }

  // Match the WARNING's own words — `/suppressed:/` alone also matches the
  // routine decision trace, which is deliberately debug.
  const storm = raised.find((r) => /mains nodes are Dead/.test(r.msg));
  assert.ok(storm, `the storm warning must reach the container log at all: ${JSON.stringify(raised.map((r) => r.msg.slice(0, 40)))}`);
  assert.equal(storm.level, 'warn', 'and it must arrive AS a warning, not downgraded to info');
});

test('the LADDER\'s own remediation probe reaches the server log too (v0.50.0)', async () => {
  // Sibling of the sweep test above — and the site that was actually unprotected.
  // The mutant guarding this had an anchor matching THREE call sites; `replace`
  // takes the first, so for its whole life it only ever mutated the routine
  // sweep. Retargeting it to the engine's own autonomous write showed the write
  // could be removed from the container log with every test still green.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const ring: string[] = [];
  const server: string[] = [];
  const nodes = [node(1, { isController: true }), dead(7)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, log: (_s, _n, text) => ring.push(text),
    log2: Object.assign((m: string) => server.push(m), { debug: () => {} }),
    config: cfg(), tickMs: 1_000_000, now: () => clock,
  });
  h.tick();                                   // observe it Dead
  clock = T + BOOT_WINDOW_MS + 60 * MIN;      // past the boot window AND the dwell
  h.tick();
  const probing = /past the dwell — probing \(attempt/;
  assert.ok(ring.some((m) => probing.test(m)), `must reach the event ring: ${ring.join(' | ')}`);
  assert.ok(server.some((m) => probing.test(m)),
    `must ALSO reach the server log — this is the engine's own autonomous write: ${server.join(' | ')}`);
  h.stop();
});

test('a node already Dead at first sight is dated from when it was last HEARD (v0.50.0)', () => {
  // `deadSince` lives only in memory, so every restart re-dated every Dead node
  // to boot. Measured live: six deploys in one evening each pushed node 49's
  // "needs a human" summons a fresh dwell into the future, and the screen's
  // "DEAD 19.2h" was 19.2 hours of UPTIME, not of silence. The driver still
  // knows when it last heard the node — ask it instead of assuming.
  const s = createAutoPingState();
  const heard = T - 90 * MIN;                       // silent an hour and a half
  const nodes = mesh(20, [dead(7, { stats: { lastSeen: heard } as never })]);
  const d = tick(s, nodes, T);
  assert.equal(s.deadSince.get(7), heard,
    `the outage is dated from the last contact, not from our boot: ${s.deadSince.get(7)} vs ${heard}`);
  // And the consequence that matters: the dwell is ALREADY satisfied, so a node
  // that has been down for 90 minutes is remediated now, not in another ten.
  assert.deepEqual(d.ping, [7], 'a long-dead node is not made to serve its dwell again');
});

test('a future lastSeen cannot fabricate an outage older than our uptime (v0.50.0)', () => {
  // Clock skew between the driver host and this process is real (a 7-hour
  // lastSeen skew already cost a day of misreading). A lastSeen in the future
  // would date the outage forward, so `now - deadSince` goes NEGATIVE and the
  // screen would render a nonsense age. Clamp to now: we cannot claim an outage
  // longer than we have been watching.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(8, { stats: { lastSeen: T + 60 * MIN } as never })]);
  trackEpisodes(s, nodes, T);
  assert.equal(s.deadSince.get(8), T, 'a future contact is clamped to now');
  assert.ok((s.deadSince.get(8) as number) <= T, 'never dates an outage into the future');
});

test('a Dead node with NO lastSeen on record is dated from now (v0.50.0)', () => {
  // The seeding must still work when the driver knows nothing — "never heard"
  // is not a licence to invent an outage of unbounded length.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(9)]);                // node() defaults lastSeen: null
  trackEpisodes(s, nodes, T);
  assert.equal(s.deadSince.get(9), T);
});

test('an empty candidate set from MISSING capability data is not an all-clear (v0.52.0)', () => {
  // `isListening` is filled ONLY from the driver-WS flag dump, and that map is
  // cleared on a homeId mismatch. With the link dark every node reads null, so
  // isPingCandidate is false fleet-wide and the ladder cannot arm — while the
  // engine reported `running · candidates 0 · dead 0` over a roster holding
  // six Dead nodes. The population was empty BY CONSTRUCTION, not because
  // there was nothing to sweep.
  const s = createAutoPingState();
  const blind = [node(1, { isController: true }),
    ...Array.from({ length: 8 }, (_, i) => dead(20 + i, { isListening: null as unknown as boolean }))];
  const d = tick(s, blind, T + 60 * MIN);
  assert.equal(d.suppressed, 'no-capability-data',
    `an unknowable population must suppress, not report a clean pass: ${d.suppressed}`);
  assert.equal(d.capabilityUnknown, 8, 'and must say how many nodes it could not classify');
  assert.deepEqual(d.ping, [], 'nothing is probed on a population it cannot assemble');
});

test('an all-BATTERY mesh is genuinely nothing to sweep, not a monitoring gap (v0.52.0)', () => {
  // The gate keys on the UNKNOWN count, not on emptiness: a mesh whose nodes
  // are all sleeping battery devices HAS capability data and correctly reports
  // an ordinary empty pass.
  const s = createAutoPingState();
  const batt = [node(1, { isController: true }),
    ...Array.from({ length: 6 }, (_, i) => node(30 + i, { isListening: false }))];
  const d = tick(s, batt, T + 60 * MIN);
  assert.notEqual(d.suppressed, 'no-capability-data',
    'known-not-listening is a measurement, not a missing one');
  assert.equal(d.capabilityUnknown, 0);
});

/* ── v0.64.3: a death the runner WATCHED gets the full dwell ─────────── */

test('a node the runner watched die gets the FULL dwell — its death is not backdated to lastSeen (v0.64.3)', () => {
  // The live defect. The 2-hourly liveness sweep pings a healthy node whose
  // lastSeen is its answer to the PREVIOUS sweep, ~120 min earlier. The ping
  // misses, the driver marks the node Dead, and dating that death from lastSeen
  // made the 10-minute dwell read as long expired: the ladder pinged 60 s later,
  // six times out of six on the live mesh.
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);                       // seen Alive
  const died = mesh(20, [dead(7, heard)]);
  assert.deepEqual(tick(s, died, T + MIN).ping, [], 'not probed on the tick it is first seen dead');
  assert.equal(s.deadSince.get(7), T + MIN, 'dated from the observed death, not from lastSeen');
  assert.deepEqual(tick(s, died, T + MIN + 9 * MIN).ping, [], 'still inside the dwell');
  assert.deepEqual(tick(s, died, T + MIN + 11 * MIN).ping, [7], 'past the dwell');
});

test('Unknown is not evidence a node was up: Unknown then Dead is still backdated (v0.64.3)', () => {
  // trackEpisodes runs on every tick whether or not the roster is ready, so a
  // status that proves nothing must not earn observed-death dating.
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, { status: NodeStatus.Unknown, ...heard })]), T);
  tick(s, mesh(20, [dead(7, heard)]), T + MIN);
  assert.equal(s.deadSince.get(7), T - 120 * MIN, 'only an observed Alive changes how a death is dated');
});

test('recovering and dying again is dated from the second death, not from lastSeen (v0.64.3)', () => {
  const s = createAutoPingState();
  tick(s, mesh(20, [node(7, { stats: { lastSeen: T - 120 * MIN } as never })]), T);
  tick(s, mesh(20, [dead(7, { stats: { lastSeen: T - 120 * MIN } as never })]), T + MIN);
  tick(s, mesh(20, [node(7, { stats: { lastSeen: T + 20 * MIN } as never })]), T + 20 * MIN);   // recovered
  tick(s, mesh(20, [dead(7, { stats: { lastSeen: T + 20 * MIN } as never })]), T + 30 * MIN);   // dies again
  assert.equal(s.deadSince.get(7), T + 30 * MIN, 'the second watched death is dated from itself');
});

test('a departed node leaves no watched-alive mark for a re-included nodeId (v0.64.3)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);            // seen Alive
  tick(s, mesh(20), T + MIN);                        // removed from the roster
  tick(s, mesh(20, [dead(7, heard)]), T + 2 * MIN);  // a new device reusing id 7, first seen Dead
  assert.equal(s.deadSince.get(7), T - 120 * MIN, 'treated as a first sighting, so v0.50.0 dating applies');
});

/* ── v0.64.4: a death on OUR OWN probe is not an outage ──────────────── */

test('a node that goes Dead on our own unanswered probe is retried without the dwell (v0.64.4)', () => {
  // The live shape, 5 of 5 deaths in 49 h: the sweep's single-attempt NoOp
  // fails, the driver marks the node Dead on that frame, and the next ping
  // answers in milliseconds. A quiet mains node cannot heal itself, so the
  // dwell only kept it Dead — for 11 minutes under v0.64.3.
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);                        // seen Alive
  pendProbe(s, 7, T + 30_000, 'sweep', 'echo-only');             // our sweep goes out
  const died = mesh(20, [dead(7, heard)]);
  const settled = trackEpisodes(s, died, T + MIN);               // Dead on the next tick
  assert.deepEqual(settled, [{ nodeId: 7, misses: 1, cls: 'echo-only', lane: 'sweep', frame: 'ping' }],
    'the probe that knocked it Dead is booked as a MISS');
  assert.equal(s.awaitingAnswer.has(7), false, 'and is no longer pending judgment');
  assert.equal(s.missStreak.get(7), 1, 'and moves the consecutive-miss streak like any miss');
  assert.equal(s.deadSince.get(7), T + MIN, 'the outage clock still reads the observed death');
  const d = decideAutoPings({ now: T + MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false });
  assert.deepEqual(d.ping, [7], 'retried on the tick the death is seen, not ten minutes later');
});

test('a probe the node ANSWERED before dying did not kill it (v0.64.4)', () => {
  const s = createAutoPingState();
  tick(s, mesh(20, [node(7, { stats: { lastSeen: T - 120 * MIN } as never })]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');
  const answered = { stats: { lastSeen: T + 10_050 } as never };  // it answered…
  tick(s, mesh(20, [node(7, answered)]), T + 30_000);
  assert.deepEqual(trackEpisodes(s, mesh(20, [dead(7, answered)]), T + MIN), [],   // …then died
    'an answered probe is not what knocked the node Dead');
  assert.equal(s.awaitingAnswer.get(7)?.length, 1, 'it stays pending for the ordinary judgment');
  assert.equal(s.probeDeath.has(7), false, 'and the death keeps its dwell');
});

test('only a death the runner WATCHED is put on its probe — Unknown then Dead is not (v0.64.4)', () => {
  // An unready roster reads placeholders; a Dead that follows one is not a
  // transition this run observed, whatever happens to be pending.
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, { status: NodeStatus.Unknown, ...heard })]), T);
  pendProbe(s, 7, T + 10_000, 'manual');
  assert.deepEqual(trackEpisodes(s, mesh(20, [dead(7, heard)]), T + MIN), []);
  assert.equal(s.probeDeath.has(7), false);
  assert.equal(s.awaitingAnswer.get(7)?.length, 1, 'the probe is left for the ordinary judgment');
});

test('recovery clears the probe-death mark — the next, unprovoked death serves its dwell (v0.64.4)', () => {
  const s = createAutoPingState();
  const old = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, old)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');
  trackEpisodes(s, mesh(20, [dead(7, old)]), T + MIN);              // knocked Dead by our probe
  const back = { stats: { lastSeen: T + MIN + 50 } as never };
  tick(s, mesh(20, [node(7, back)]), T + 2 * MIN);                   // revived
  const d = tick(s, mesh(20, [dead(7, back)]), T + 30 * MIN);        // dies again, nothing of ours pending
  assert.deepEqual(d.ping, [], 'an unprovoked death keeps the dwell');
});

test('a departed node leaves no probe-death mark for a re-included nodeId (v0.64.4)', () => {
  const s = createAutoPingState();
  const old = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, old)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');
  trackEpisodes(s, mesh(20, [dead(7, old)]), T + MIN);
  tick(s, mesh(20), T + 2 * MIN);                                    // excluded from the mesh
  const d = tick(s, mesh(20, [dead(7)]), T + 3 * MIN);               // a new device on id 7, never heard
  assert.deepEqual(d.ping, [], 'a first sighting with no lastSeen serves the dwell from now');
});

test('the sweep probe that knocked a node Dead is booked UNANSWERED, though the retry revives it (v0.64.4)', async () => {
  // v0.50.0–v0.64.2 retried one tick after the death, the revival advanced
  // lastSeen inside the 90 s answer grace, and the probe that killed the node
  // was booked ANSWERED: the reference mesh's weakest outlet read 25/25 for
  // a true ~22/25.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const reported: { id: number; answered: boolean }[] = [];
  const pinged: number[] = [];
  const probed: number[] = [];
  const ring: string[] = [];
  const old = { stats: { lastSeen: T - 120 * MIN } as never };
  let nodes = [node(1, { isController: true }), node(7, old)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async (n) => { pinged.push(n); }, probe: async (n) => { probed.push(n); },
    log: (_sev, _id, text) => { ring.push(text); },
    onProbeResult: (id, answered) => { reported.push({ id, answered }); },
    config: cfg({ staleMs: 120 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();                        // the sweep asks node 7
  assert.deepEqual(probed, [7]);
  clock += MIN; nodes = [node(1, { isController: true }), dead(7, old)];
  h.tick();                                                          // Dead on that frame
  assert.deepEqual(pinged, [7], 'the ladder retries on the tick the death is seen');
  assert.ok(ring.some((m) => /went Dead with our sweep probe to it unanswered — probing without the dwell \(attempt 1\/3\)/.test(m)),
    `the retry says why it skipped the dwell, and claims no cause: ${ring.join(' | ')}`);
  assert.ok(ring.some((m) => /did NOT answer its probe \(1st consecutive miss — the node has since been marked Dead\)/.test(m)),
    `and the miss is on the record: ${ring.join(' | ')}`);
  const revived = clock + 40;
  // (The retry lands here. When it does NOT, the next rung says so plainly —
  // see "a sweep kill whose retry fails says so on the next rung".)
  clock += MIN; nodes = [node(1, { isController: true }), node(7, { stats: { lastSeen: revived } as never })];
  h.tick();                                                          // the retry landed
  clock += 5 * MIN; h.tick();                                        // every pending probe has matured
  h.stop();
  assert.deepEqual(reported, [{ id: 7, answered: false }],
    'the sweep that killed it is a miss, reported exactly once');
});

test('a VERIFICATION probe that knocks a node Dead is a miss, is retried without the dwell, and stays out of the reply rate (v0.71.0)', async () => {
  // v0.64.4 kept the dwell for a burst kill, to stop kill–revive–kill; on
  // 2026-09-22 that dwell held a working outlet Dead for 101 minutes. The loop
  // is bounded by the post-kill hold now (see the hold tests below).
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const reported: number[] = [];
  const pinged: number[] = [];
  const lines: string[] = [];
  const old = { stats: { lastSeen: T - 120 * MIN } as never };
  let nodes = [node(1, { isController: true }), node(9, old)];
  let due: { id: number; first: boolean }[] = [];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async (n) => { pinged.push(n); }, probe: async () => {},
    log: () => {}, log2: Object.assign((m: string) => { lines.push(m); }, { warn: (m: string) => { lines.push(m); } }),
    onProbeResult: (id) => { reported.push(id); },
    verifyRequests: () => { const d = due; due = []; return d; },
    config: cfg({ staleMs: 0 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; due = [{ id: 9, first: true }]; h.tick();
  clock += MIN; nodes = [node(1, { isController: true }), dead(9, old)]; h.tick();
  h.stop();
  assert.deepEqual(pinged, [9], 'a burst kill is retried on the tick the death is seen');
  assert.ok(lines.some((l) => /node 9 went Dead with our verification probe to it unanswered — probing without the dwell \(attempt 1\/3\)/.test(l)),
    `the retry names the lane that killed it: ${JSON.stringify(lines)}`);
  assert.deepEqual(reported, [], 'a verification probe is symptom-correlated and stays out of the comparable rate');
});

/* ── v0.64.4: the boot window holds the measurement lanes, not the ladder ─ */

test('inside the boot window the DEAD ladder may act; the measurement lanes still wait (v0.64.4)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7, { stats: { lastSeen: T - 90 * MIN } as never })]);  // down before we started
  trackEpisodes(s, nodes, T);
  let drained = 0;
  const d = decideAutoPings({ now: T, state: s, nodes, controller: null, config: cfg({ staleMs: 120 * MIN }),
    booting: true, bootDeadLane: true, verifyDue: () => { drained++; return [{ id: 100, first: true }]; } });
  assert.deepEqual(d.ping, [7], 'a node down since before the restart is probed now, not at start + 5 min');
  assert.equal(d.suppressed, 'boot-window', 'the window still stands for everything else');
  assert.deepEqual(d.stale, [], 'the sweep waits out the window');
  assert.deepEqual(d.verify, [], 'so do verification probes');
  assert.equal(drained, 0, "and a gated tick spends none of the ledger's verification budget");
});

test('the released ladder obeys every gate, and inside the window they still REPORT boot-window (v0.64.4 review)', () => {
  // `storm` and `no-capability-data` raise binary_sensor.zwave_tui_degraded
  // (haStates.ts). The window hid both for its whole length before v0.64.4, and
  // releasing the ladder must not release a start-up alarm with it.
  const old = { stats: { lastSeen: T - 90 * MIN } as never };
  const decide = (nodes: NodeSnapshot[], booting: boolean, controller: ControllerSnapshot | null = null) => {
    const s = createAutoPingState();
    trackEpisodes(s, nodes, T);
    return decideAutoPings({ now: T, state: s, nodes, controller, config: cfg(), booting, bootDeadLane: true });
  };
  const storm = mesh(6, [dead(7, old), dead(8, old), dead(9, old), dead(10, old)]);
  assert.deepEqual([decide(storm, true).suppressed, decide(storm, true).ping], ['boot-window', []]);
  assert.equal(decide(storm, false).suppressed, 'storm', 'after the window it is a storm again');
  const blind = [node(1, { isController: true }), ...Array.from({ length: 6 }, (_, i) => dead(20 + i, { isListening: null as unknown as boolean }))];
  assert.equal(decide(blind, true).suppressed, 'boot-window', 'no start-up degraded for a driver link still connecting');
  assert.equal(decide(blind, false).suppressed, 'no-capability-data');
  const rebuilding = { isRebuildingRoutes: true } as unknown as ControllerSnapshot;
  assert.deepEqual([decide(mesh(20, [dead(7, old)]), true, rebuilding).suppressed, decide(mesh(20, [dead(7, old)]), true, rebuilding).ping],
    ['boot-window', []]);
});

test('traffic heard BEFORE a sweep kill does not make the node "talking" (v0.64.4 review)', () => {
  // The kill was pinned on our probe only because nothing was heard after it
  // went out, so the Dead flag is the newer evidence.
  const s = createAutoPingState();
  const recent = { stats: { lastSeen: T - 3 * MIN } as never };     // heard three minutes ago
  tick(s, mesh(20, [node(7, recent)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');
  const died = mesh(20, [dead(7, recent)]);
  trackEpisodes(s, died, T + MIN);
  const d = decideAutoPings({ now: T + MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false });
  assert.deepEqual(d.talkingWhileDead, [], 'a voice from before the kill is older than the Dead flag');
  assert.deepEqual(d.ping, [7], 'so the retry goes out on the tick the death is seen');
  // …while traffic AFTER the death still outranks the flag, exactly as before.
  const spoke = mesh(20, [dead(7, { stats: { lastSeen: T + MIN + 30_000 } as never })]);
  trackEpisodes(s, spoke, T + 2 * MIN);
  const d2 = decideAutoPings({ now: T + 2 * MIN, state: s, nodes: spoke, controller: null, config: cfg(), booting: false });
  assert.deepEqual(d2.talkingWhileDead, [7], 'a voice newer than the death is still trusted over the flag');
});

test('a MANUAL ping pending at a death is booked a miss, but only a measurement-lane kill skips the dwell (v0.71.0)', () => {
  // v0.64.4 kept manual kills out for their loose send stamp. v0.64.5 dates a
  // manual ping from its launch, and they stay out anyway: no manual kill has
  // been observed, and `probeDeath` would discard the traffic heard before the
  // death — which can be the operator's own command, the v0.42.0 evidence that
  // the flag is stale. See `probeDeath`.
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);
  pendProbe(s, 7, T + 10_000, 'manual');
  const died = mesh(20, [dead(7, heard)]);
  assert.deepEqual(trackEpisodes(s, died, T + MIN).map((x) => x.lane), ['manual'], 'the miss is still booked');
  assert.equal(s.probeDeath.has(7), false);
  assert.deepEqual(decideAutoPings({ now: T + MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false }).ping, []);
});

test('the probe NEAREST the death decides the exemption — an older pending sweep lends none to a MANUAL kill (v0.71.0)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');          // an ordinary lost reply, still pending
  pendProbe(s, 7, T + 70_000, 'manual');                       // the operator's ping the node died on
  const died = mesh(20, [dead(7, heard)]);
  assert.deepEqual(trackEpisodes(s, died, T + 2 * MIN).map((x) => x.lane), ['sweep', 'manual'], 'both are misses');
  assert.equal(s.probeDeath.has(7), false, 'but a manual kill keeps the dwell');
  assert.equal(probeKillsWithin(s, 7, T + 2 * MIN), 0, 'and is not counted as our own probe kill');
  assert.deepEqual(decideAutoPings({ now: T + 2 * MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false }).ping, []);
});

test('…and when the NEAREST probe is a verification probe, the lane it records is verify (v0.71.0)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');
  pendProbe(s, 7, T + 70_000, 'verify');
  const died = mesh(20, [dead(7, heard)]);
  assert.deepEqual(trackEpisodes(s, died, T + 2 * MIN).map((x) => x.lane), ['sweep', 'verify']);
  assert.equal(s.probeDeath.get(7), 'verify', 'the newest decides, and names its lane');
  assert.deepEqual(decideAutoPings({ now: T + 2 * MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false }).ping, [7]);
});

test('an ANSWERED older probe stays pending while the unanswered newer one is settled (v0.64.4 review)', () => {
  const s = createAutoPingState();
  tick(s, mesh(20, [node(7, { stats: { lastSeen: T - 120 * MIN } as never })]), T);
  pendProbe(s, 7, T + 10_000, 'verify');                       // answered…
  const answered = { stats: { lastSeen: T + 10_050 } as never };
  pendProbe(s, 7, T + 70_000, 'sweep', 'echo-only');          // …then a sweep it never answered
  const died = mesh(20, [dead(7, answered)]);
  assert.deepEqual(trackEpisodes(s, died, T + 2 * MIN).map((x) => x.lane), ['sweep']);
  assert.deepEqual(s.awaitingAnswer.get(7)?.map((p) => p.lane), ['verify'], 'the answered probe waits for its ordinary judgment');
  assert.equal(s.probeDeath.has(7), true, 'and the sweep kill earns the exemption');
});

test('settlement touches only probes already sent, and leaves the rest pending (v0.64.4 review)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only');          // sent and unanswered: settled
  pendProbe(s, 7, T + 5 * MIN, 'manual');                      // dated after this tick (only a clock step does that): not yet sent
  assert.deepEqual(trackEpisodes(s, mesh(20, [dead(7, heard)]), T + MIN).map((x) => x.lane), ['sweep']);
  assert.deepEqual(s.awaitingAnswer.get(7)?.map((p) => p.lane), ['manual'], 'the unsettled entry stays pending');
});

/* ── v0.64.5: a manual ping is dated from its launch, not from HA's return ── */

test('a MANUAL ping answered before HA replied is judged answered — pended at its launch (v0.64.5)', async () => {
  // HA's ping button starts the driver's ping and returns, so the node's answer
  // and HA's reply race. This is the case the answer wins: it is on record
  // before the operator's `p` can register the probe. Node 8 is the control: the
  // same answer, pended at registration as v0.47.0–v0.64.4 did, is judged a
  // miss — so the fixture discriminates, and the judgment provably ran.
  const { startAutoPing } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const answeredBeforeReply = { stats: { lastSeen: T + 40 } as never };  // the ACK at 40 ms; HA's reply lands at 250 ms
  const nodes = mesh(20, [node(7, answeredBeforeReply), node(8, answeredBeforeReply)]);
  const h = startAutoPing({
    nodes: () => nodes,
    controller: () => null,
    ready: () => true,
    ping: async () => {},
    log: (_sev, _n, text) => { lines.push(text); },
    config: cfg(),
    tickMs: 1_000_000,
    now: () => clock,
  });
  try {
    clock = T + 250;                     // Home Assistant's call has returned
    h.notePending(7, 'manual', T);       // dated from its launch
    h.notePending(8, 'manual');          // the old stamp: registration time
    clock = T + 2 * MIN;                 // past the 90 s answer grace
    h.tick();
    assert.deepEqual(lines.filter((l) => /node 7 did NOT answer/.test(l)), [],
      `an answer that beat the reply is an answer: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter((l) => /node 8 did NOT answer/.test(l)).length, 1,
      `control: a post-return stamp books the same answer as a miss: ${JSON.stringify(lines)}`);
  } finally { h.stop(); }
});

test('end to end: the runner stamps a manual ping at launch and auto-ping credits an answer that beat the reply (v0.64.5)', async () => {
  // The real runner and the real auto-ping on one injected clock. The hook
  // stands in for index.ts and zwaveData, each pinned on its own, and forwards
  // the stamp exactly as they do.
  const { startAutoPing } = await import('../src/zwave/autoPing');
  const { createActionRunner } = await import('../src/zwave/zwaveActions');
  let clock = T;
  const lines: string[] = [];
  const stats = { lastSeen: T - 120 * MIN };
  const nodes = mesh(20, [node(7, { stats: stats as never })]);
  const ap = startAutoPing({
    nodes: () => nodes,
    controller: () => null,
    ready: () => true,
    ping: async () => {},
    log: (_sev, _n, text) => { lines.push(text); },
    config: cfg(),
    tickMs: 1_000_000,
    now: () => clock,
  });
  const runner = createActionRunner({
    client: {
      send: async () => {
        clock += 40;
        stats.lastSeen = clock;          // the NoOp is ACKed 40 ms in…
        clock += 210;                    // …and Home Assistant's reply arrives 250 ms after the press
        return null;
      },
    } as never,
    entryId: () => 'entry-1',
    deviceIdOf: (n) => `dev-${n}`,
    pingEntityOf: (n) => `button.node${n}_ping`,
    log: () => {},
    onOutcome: (kind, n, ok, _refusal, origin, sentAt) => {
      if (ok && kind === 'ping' && n != null && origin === 'you') ap.notePending(n, 'manual', sentAt);
    },
    now: () => clock,
    enabled: true,
  });
  try {
    assert.equal((await runner.ping(7)).ok, true);
    assert.equal(ap.snapshot().nodes.find((n) => n.nodeId === 7)?.pending, 1, 'the manual probe is owed an answer');
    clock += 2 * MIN;
    ap.tick();
    assert.deepEqual(lines.filter((l) => /node 7 did NOT answer/.test(l)), [],
      `answered before the reply: ${JSON.stringify(lines)}`);
    assert.equal(ap.snapshot().nodes.find((n) => n.nodeId === 7), undefined,
      'judged and cleared, with no miss on the streak');
  } finally { ap.stop(); }
});

test('a manual ping answered before HA replied is not blamed for a LATER death (v0.64.5)', async () => {
  // `settleProbeDeath` applies the judge's own test (`lastHeard < at`) at the
  // death. With the post-return stamp, a node that answered the manual ping and
  // then went Dead for some other reason inside the grace had that ping booked
  // as the probe it died on.
  const { startAutoPing } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  let nodes = mesh(20, [node(7, { stats: { lastSeen: T - 120 * MIN } as never })]);
  const h = startAutoPing({
    nodes: () => nodes,
    controller: () => null,
    ready: () => true,
    ping: async () => {},
    log: (_sev, _n, text) => { lines.push(text); },
    config: cfg(),
    tickMs: 1_000_000,
    now: () => clock,
  });
  try {
    h.tick();                                                     // T: watched Alive
    clock = T + 250;
    h.notePending(7, 'manual', T);                                // launched at T…
    nodes = mesh(20, [dead(7, { stats: { lastSeen: T + 40 } as never })]); // …answered at T + 40, then Dead
    clock = T + MIN;                                              // the death is seen inside the grace
    h.tick();
    assert.deepEqual(lines.filter((l) => /node 7 did NOT answer/.test(l)), [],
      `an answered probe did not kill the node: ${JSON.stringify(lines)}`);
    assert.equal(h.snapshot().nodes.find((n) => n.nodeId === 7)?.pending, 1,
      'it waits for its ordinary judgment');
  } finally { h.stop(); }
});

test('after a restart, a node ALREADY Dead is probed once the roster is ready — not at start + 5 min (v0.64.4)', async () => {
  // The 09-13 host reboot on the reference mesh: an outlet missed the driver's
  // single start-up NoOp, and its Home Assistant light and switch stayed
  // unavailable until the ladder's first probe at start + 5 min exactly —
  // about three minutes after the roster was in. That probe revived it in 104 ms.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let ready = false;
  const pinged: number[] = [];
  const probed: number[] = [];
  const ring: string[] = [];
  const nodes = mesh(20, [dead(7, { stats: { lastSeen: T - 30 * MIN } as never })]);
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => ready,
    ping: async (n) => { pinged.push(n); }, probe: async (n) => { probed.push(n); },
    log: (_sev, _id, text) => { ring.push(text); },
    config: cfg({ staleMs: 120 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + MIN; h.tick();
  assert.deepEqual(pinged, [], 'an unready roster is still no evidence at all');
  ready = true; clock = T + 2 * MIN; h.tick();
  assert.ok(clock - T < BOOT_WINDOW_MS, 'this tick is inside the window');
  assert.deepEqual(pinged, [7], 'probed on the first tick with a ready roster');
  assert.deepEqual(probed, [], 'while the sweep still waits the window out');
  assert.ok(ring.some((m) => /suppressed: boot-window \(dead ladder open, probing 1\)/.test(m)),
    `the trace must not read plain "suppressed" beside a probe going out: ${ring.join(' | ')}`);
  h.stop();
});

test('a sweep kill whose retry fails says so on the next rung — no second "without the dwell" (v0.64.4 review)', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const ring: string[] = [];
  const old = { stats: { lastSeen: T - 120 * MIN } as never };
  let nodes = [node(1, { isController: true }), node(7, old)];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async () => {},
    log: (_sev, _id, text) => { ring.push(text); },
    config: cfg({ staleMs: 120 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS + MIN; h.tick();                        // the sweep
  clock += MIN; nodes = [node(1, { isController: true }), dead(7, old)]; h.tick();   // killed; attempt 1
  for (let i = 0; i < 10; i++) { clock += MIN; h.tick(); }            // stays Dead through the 10 m backoff
  for (let i = 0; i < 35; i++) { clock += MIN; h.tick(); }            // … and the 30 m one
  h.stop();
  assert.equal(ring.filter((m) => /probing without the dwell/.test(m)).length, 1, `only the first retry skips the dwell: ${ring.join(' | ')}`);
  assert.ok(ring.some((m) => /node 7 is still Dead after the immediate retry — probing \(attempt 2\/3\)/.test(m)),
    `the second rung names itself: ${ring.join(' | ')}`);
  // v0.72.1: the third rung said "after the immediate retry" too.
  assert.equal(ring.filter((m) => /after the immediate retry/.test(m)).length, 1, `only the second rung follows the immediate retry: ${ring.join(' | ')}`);
  assert.ok(ring.some((m) => /node 7 is still Dead after attempt 2 — probing \(attempt 3\/3\)/.test(m)),
    `the third rung names the attempt before it: ${ring.join(' | ')}`);
});

/* ── v0.65.0: the controller's receiver goes down every night ──────────────
 * The nightly NVM backup turns the radio off for ~10 s and soft-resets. A frame
 * sent across that window cannot be acknowledged, and ONE unacknowledged sweep
 * frame is enough for the driver to mark a node Dead (the 2026-09-15 audit).
 */

test('a receiver that is OFF suppresses every lane, the dead ladder included (v0.65.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const live = tick(s, nodes, T + 30 * MIN);
  assert.deepEqual(live.ping, [7], 'precondition: the ladder would probe node 7 right now');
  const d = tick(s, nodes, T + 30 * MIN, { rfOffSince: T + 29 * MIN });
  assert.deepEqual(d.ping, [], 'nothing is sent into a switched-off receiver');
  assert.equal(d.suppressed, 'controller-rf-off');
});

test('the blackout still reports boot-window while the mesh is settling (v0.65.0)', () => {
  // Same discipline as storm/no-capability-data (v0.64.4): releasing a lane
  // inside the boot window must not release a start-up alarm.
  const s = createAutoPingState();
  // `bootDeadLane` is what makes this test reach the RF gate at all: without it
  // the decision returns at the plain boot-window exit above it, and the mutant
  // that drops the `gate()` wrapper survives a green suite (v0.65.0 review).
  const d = tick(s, mesh(20, [dead(7)]), T, { booting: true, bootDeadLane: true, rfOffSince: T - 1_000 });
  assert.equal(d.suppressed, 'boot-window');
});

test('a probe still unanswered when the receiver went off is DROPPED, never booked as a miss (v0.65.0)', () => {
  const s = createAutoPingState();
  pendProbe(s, 7, T, 'sweep', 'unheard');
  const nodes = [node(7, { stats: { lastSeen: T - MIN } as never })];
  assert.equal(dropBlackoutProbes(s, nodes, T + 5_000), 1);
  assert.equal(s.awaitingAnswer.get(7), undefined, 'nothing is left to judge');
  assert.equal(s.missStreak.get(7), undefined, 'and no miss streak was started');
  assert.deepEqual(judgeProbeAnswers(s, nodes, T + 5 * MIN), [], 'the ordinary judgment has nothing to say either');
});

test('a probe ANSWERED before the blackout keeps its credit (v0.65.0)', () => {
  // The answer is already on the record; dropping it would lose a true reading.
  const s = createAutoPingState();
  pendProbe(s, 7, T, 'sweep', 'echo-only');
  const nodes = [node(7, { stats: { lastSeen: T + 1_000 } as never })];
  assert.equal(dropBlackoutProbes(s, nodes, T + 5_000), 0);
  const judged = judgeProbeAnswers(s, nodes, T + 5 * MIN);
  assert.equal(judged.length, 1);
  assert.equal(judged[0].answered, true);
});

test('a probe sent after the receiver went off is left to the ordinary judgment (v0.65.0)', () => {
  // The suppression means this should not happen. If it ever does, the miss is
  // real against a radio we know was off — no special rule is invented here.
  const s = createAutoPingState();
  pendProbe(s, 7, T + 10_000, 'sweep', 'unheard');
  const nodes = [node(7, { stats: { lastSeen: T - MIN } as never })];
  assert.equal(dropBlackoutProbes(s, nodes, T + 5_000), 0);
  assert.equal(s.awaitingAnswer.get(7)?.length, 1);
});

test("the driver's own restart burst is not the node's voice — it credits nothing (v0.65.0)", async () => {
  // A driver restart pings the whole mesh itself, advancing every node's
  // lastSeen within seconds. Attribution cannot tell that from the node
  // speaking, and the 2026-09-15 audit measured the cost of guessing: 28
  // fabricated `self-proven` credits from two restarts in 23 h, into a counter
  // that is persisted and never decays.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let reconnAt: number | null = null;
  const results: { nodeId: number; cls: string }[] = [];
  const n7 = node(7, { stats: { lastSeen: T } as never });
  const seen = (v: number) => { (n7.stats as unknown as { lastSeen: number | null }).lastSeen = v; };
  const nodes = [node(1, { isController: true }), n7];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async () => {}, log: () => {},
    config: cfg({ staleMs: 60 * MIN }), tickMs: 1_000_000, now: () => clock,
    onProbeResult: (nodeId, _answered, cls) => results.push({ nodeId, cls }),
    driverReconnectedAt: () => reconnAt,
  });
  // A probe's class is recorded when it is JUDGED, not when it is launched, so
  // each phase below sends a probe and then lets it mature into an answer.
  const sweepThenAnswer = (): void => {
    h.tick();                                   // sweep launches, class decided now
    clock += 2 * MIN;                           // past the answer grace
    seen(clock - 1_000);                        // the node answers it
    h.tick();                                   // judged → onProbeResult(cls)
  };
  // 1. First sweep: nothing is attributable yet, so nothing is credited.
  clock = T + BOOT_WINDOW_MS + MIN;
  sweepThenAnswer();
  assert.equal(results.at(-1)?.cls, 'attribution-unknown', 'no probe history yet (v0.40.2)');
  // 2. CONTROL: the node speaks on its own, past our probe's answer.
  clock += 61 * MIN;
  seen(clock - 1_000);
  sweepThenAnswer();
  assert.equal(results.at(-1)?.cls, 'self-proven', 'fixture guard: this is what a real self-proof looks like');
  // 3. TREATMENT: the same advance, but the driver just reconnected — the
  //    lastSeen it wrote is the driver's own restart ping, not the node's voice.
  clock += 61 * MIN;
  reconnAt = clock - 10_000;
  seen(clock - 9_000);
  h.tick();
  clock += 2 * MIN;
  seen(clock - 1_000);
  h.tick();
  assert.equal(results.at(-1)?.cls, 'attribution-unknown', 'an advance inside the restart burst credits nothing');
  // 4. …and the doubt EXPIRES. A reconnect must not suppress self-proof for the
  //    life of the process — long after the burst, the node's voice is its own.
  clock += 61 * MIN;
  seen(clock - 1_000);
  sweepThenAnswer();
  assert.equal(results.at(-1)?.cls, 'self-proven', 'the burst window is bounded, not a permanent doubt');
  // 5. …and BOUNDED at a size the live restarts justify. The 2026-09-15
  //    restarts walked 38 nodes in 9 s; the deadline only has to outlast that
  //    plus the add-on's own reconnect, and a window measured in tens of
  //    minutes would refuse legitimate self-proof after every driver restart.
  //    Without a value assertion this constant is pinned against REMOVAL only:
  //    widening it to 30 min leaves the whole suite green (v0.65.0 review).
  const { DRIVER_BURST_MS, DRIVER_BURST_LEAD_MS } = await import('../src/zwave/autoPing');
  assert.ok(DRIVER_BURST_MS >= 30_000 && DRIVER_BURST_MS <= 5 * MIN,
    `generous over the measured ~9 s burst, but bounded (is ${DRIVER_BURST_MS} ms)`);
  assert.ok(DRIVER_BURST_LEAD_MS > 0 && DRIVER_BURST_LEAD_MS <= MIN,
    'the driver pings as it comes up, so the window leads the anchor — by seconds, not minutes');
  h.stop();
});

test('a run with no attribution yet cannot call a node genuinely silent (v0.66.0)', async () => {
  // `unheard` is not a shrug. The dossier states it as the OPPOSITE reading of
  // echo-only — "this node is genuinely silent" against "it never speaks except
  // to answer us" — and books it into a ledger that is persisted and never
  // decays. Deciding it needs `attributed`, which is per-PROCESS, so at a boot
  // the four-way chain fell through to it by default. The 2026-09-17 log review
  // measured that default: 24 nodes were booked `unheard` at the 07:11 boot and
  // all 24 came back `echo-only` at their very next sweep — each had answered
  // the very probe its mark was written against.
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  const STALE = 240 * MIN;
  const harness = (n: NodeSnapshot) => {
    // Created AT T so the boot window is anchored there, then advanced past it
    // — startAutoPing stamps the window when it is called, and a handle built
    // after the window has notionally passed is still inside its own.
    let clock = T;
    const results: { nodeId: number; cls: string }[] = [];
    const lines: string[] = [];
    const h = startAutoPing({
      nodes: () => [node(1, { isController: true }), n], controller: () => null, ready: () => true,
      ping: async () => {}, probe: async () => {}, log: (_s, _n, text) => { lines.push(text); },
      config: cfg({ staleMs: STALE }), tickMs: 1_000_000, now: () => clock,
      onProbeResult: (nodeId, _answered, cls) => results.push({ nodeId, cls }),
    });
    clock = T + BOOT_WINDOW_MS + MIN;
    const seen = (v: number | null) => { (n.stats as unknown as { lastSeen: number | null }).lastSeen = v; };
    // A class is decided when the probe is LAUNCHED and reported when it is
    // JUDGED, so each phase sends one and then lets it mature into an answer.
    const sweepThenAnswer = (): void => {
      h.tick();
      clock += 2 * MIN;
      seen(clock - 1_000);
      h.tick();
    };
    return { results, lines, h, seen, sweepThenAnswer, at: () => clock, wait: (ms: number) => { clock += ms; } };
  };

  // 1. THE FIX. A node silent past the threshold, on a run that has not yet had
  //    a probe answered: the echo-only discriminator cannot be computed, so the
  //    honest answer is that attribution is unknown — NOT that the node is
  //    silent. This is the live case: every one of the 24 answered next sweep.
  {
    const t = harness(node(7, { stats: { lastSeen: T - 300 * MIN } as never }));
    t.sweepThenAnswer();
    assert.equal(t.results.at(-1)?.cls, 'attribution-unknown',
      'no attribution yet ⇒ the silence cannot be told from our own echo');
    assert.ok(t.lines.some((l) => /nothing heard for \d+m, past the 240m threshold/.test(l)),
      `the measured silence must survive the reclassification: ${t.lines.join(' | ')}`);
    t.h.stop();
  }

  // 2. REACHABILITY — nothing on record at all. A node that has never been
  //    heard has no attribution question to be unsure about, so the negative
  //    stays available. A guard that makes its own negative unreachable is its
  //    own defect in this engine.
  {
    const t = harness(node(8));
    t.sweepThenAnswer();
    assert.equal(t.results.at(-1)?.cls, 'unheard',
      'never heard at all is genuinely unheard, attribution or no attribution');
    t.h.stop();
  }

  // 3. REACHABILITY — the honest negative, earned. Once a probe of OURS has
  //    been answered, `attributed` exists; a node that then speaks on its own
  //    and afterwards goes quiet past the threshold is silent on evidence, and
  //    is still called silent.
  {
    const t = harness(node(9, { stats: { lastSeen: T } as never }));
    t.sweepThenAnswer();                       // establishes attribution for this run
    assert.equal(t.results.at(-1)?.cls, 'attribution-unknown', 'setup: the first sweep is unattributable');
    t.seen(t.at() + 1_000);                    // the node speaks on its own, past our answer
    t.wait(STALE + 10 * MIN);                  // …and then goes quiet, past the threshold
    t.sweepThenAnswer();
    assert.equal(t.results.at(-1)?.cls, 'unheard',
      'spoke on its own, then nothing for longer than the threshold — silent on the evidence');
    t.h.stop();
  }
});

test('a driver restart the driver-WS never reconnects to still refuses attribution (v0.65.0 review)', async () => {
  // The anchor used to be the add-on's OWN driver-WS handshake, and a driver
  // restart is the event most likely to take that link down. In the 2026-09-15
  // audit the second restart's reconnect ladder stopped after attempt 2 and
  // never handshook again, so `driverReconnectedAt()` stayed 22 h stale while
  // 25 of the 28 fabricated credits were booked — the rule as shipped removed
  // 3 of them. zwaveData now also anchors on the config-entry reload, which is
  // seen on the HA socket; this pins the consumer's half: a STALE anchor must
  // not be what decides it.
  const { startAutoPing, BOOT_WINDOW_MS, DRIVER_BURST_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let reconnAt: number | null = null;
  const results: { nodeId: number; cls: string }[] = [];
  const n7 = node(7, { stats: { lastSeen: T } as never });
  const seen = (v: number) => { (n7.stats as unknown as { lastSeen: number | null }).lastSeen = v; };
  const nodes = [node(1, { isController: true }), n7];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async () => {}, log: () => {},
    config: cfg({ staleMs: 60 * MIN }), tickMs: 1_000_000, now: () => clock,
    onProbeResult: (nodeId, _answered, cls) => results.push({ nodeId, cls }),
    driverReconnectedAt: () => reconnAt,
  });
  const sweepThenAnswer = (): void => {
    h.tick();
    clock += 2 * MIN;
    seen(clock - 1_000);
    h.tick();
  };
  clock = T + BOOT_WINDOW_MS + MIN;
  sweepThenAnswer();                       // establish attribution for this run
  clock += 61 * MIN;
  // The restart is signalled by an anchor that is FRESH, however it was
  // obtained — a handshake, or the config-entry reload when no handshake comes.
  reconnAt = clock - 10_000;
  seen(clock - 9_000);
  h.tick();
  clock += 2 * MIN;
  seen(clock - 1_000);
  h.tick();
  assert.equal(results.at(-1)?.cls, 'attribution-unknown', 'setup: a fresh anchor refuses the credit');
  // Now the audited failure: the same mesh-wide advance, but the only anchor on
  // offer is the previous restart's, hours old. Nothing may be credited on the
  // strength of an anchor that cannot describe this burst.
  clock += 61 * MIN;
  const staleAnchor = clock - 22 * 60 * MIN;
  assert.ok(clock - staleAnchor > DRIVER_BURST_MS, 'setup: the anchor is long expired');
  reconnAt = staleAnchor;
  seen(clock - 1_000);
  sweepThenAnswer();
  assert.equal(results.at(-1)?.cls, 'self-proven',
    'a stale anchor must not suppress — it is inert, which is why a LIVE second anchor is required');
  h.stop();
});

test('the runner reads the RF-off reading: it suppresses, and drops what was in flight (v0.65.0)', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let rf: number | null = null;
  const probed: number[] = [];
  const n7 = node(7, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), n7];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async (n) => { probed.push(n); }, log: () => {},
    config: cfg({ staleMs: 60 * MIN }), tickMs: 1_000_000, now: () => clock,
    rfOffSince: () => rf,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  assert.deepEqual(probed, [7], 'precondition: the sweep probes it while the radio is up');
  assert.equal(h.snapshot().nodes.find((n) => n.nodeId === 7)?.pending, 1, 'and that probe is awaiting judgment');
  // The radio goes down before the answer could arrive.
  rf = clock + 1_000;
  clock += 5 * MIN;
  h.tick();
  assert.equal(h.snapshot().suppressed, 'controller-rf-off');
  assert.deepEqual(probed, [7], 'nothing new is sent into a switched-off receiver');
  const st = h.snapshot().nodes.find((n) => n.nodeId === 7);
  assert.equal(st?.pending ?? 0, 0, 'the unanswerable probe was dropped');
  assert.equal(st?.missStreak ?? 0, 0, 'and the blackout booked no miss against the node');
  h.stop();
});

/* ── v0.70.0: the routed read ─────────────────────────────────────────────
 *
 * An HA/zwave-js-server ping is an ACK-only NoOp (transmit options 0x01, one
 * attempt), so it can use only the stored routes. A Get goes out with the
 * driver's default options and may auto-route. On 2026-09-22 the ladder spent
 * three pings on an outlet and summoned a human; a switch command then revived
 * it in 340 ms through a repeater the stored routes did not use. */

const yes = () => true;

test('an unanswered ladder ping earns ONE routed read, instead of a ping, on the next tick (v0.70.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock, { canRead: yes });
  clock += 11 * MIN;
  assert.deepEqual(tick(s, nodes, clock, { canRead: yes }).ping, [7], 'fixture guard: rung 1 is a ping');
  noteAttempt(s, 7, clock);
  s.readOwed.add(7);                              // the judgment loop does this on a judged miss
  clock += 2 * MIN;
  const d = tick(s, nodes, clock, { canRead: yes });
  assert.deepEqual(d.read, [7], 'the owed read goes out');
  assert.deepEqual(d.ping, [], 'and no ping in the same tick — one frame per node per tick');
});

test('with no readable value the ladder is exactly the v0.69.0 ladder (v0.70.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock);
  s.readOwed.add(7);
  clock += 11 * MIN;
  const d = tick(s, nodes, clock, { canRead: () => false });
  assert.deepEqual(d.read, [], 'nothing to read, so no read');
  assert.deepEqual(d.ping, [7], 'and the ping goes out as it always did');
  assert.deepEqual(tick(s, nodes, clock).read, [], 'an input without canRead never reads');
});

test('the final rung reads BEFORE the give-up, and the give-up waits for the read (v0.70.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock, { canRead: yes });
  s.attempts.set(7, 3);                           // budget spent
  s.readOwed.add(7);                              // …and the last ping was judged unanswered
  clock += 61 * MIN;
  const d = tick(s, nodes, clock, { canRead: yes });
  assert.deepEqual(d.read, [7], 'the last rung still gets its read');
  assert.deepEqual(d.gaveUp, [], 'nobody is summoned while a read is owed');
  s.readOwed.delete(7);
  pendProbe(s, 7, clock, 'read');                 // the runner pends the read it sent
  assert.deepEqual(tick(s, nodes, clock + MIN, { canRead: yes }).gaveUp, [], 'nor while it awaits judgment');
  s.awaitingAnswer.delete(7);                     // judged, unanswered
  assert.deepEqual(tick(s, nodes, clock + 3 * MIN, { canRead: yes }).gaveUp, [7], 'then the summons, as before');
});

test('two routed-read revivals in 24 h withhold the read, so a kill–revive loop ends in a summons (v0.70.0)', () => {
  // A device that answers Gets but not pings is revived by the read and killed
  // again by the next NoOp; recovery resets the ladder, so without a bound the
  // loop never reaches a human.
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  let clock = T;
  tick(s, nodes, clock, { canRead: yes });
  clock += 11 * MIN;
  s.readOwed.add(7);
  s.readRevivals.set(7, [clock - 5 * 60 * MIN, clock - 60 * MIN]);
  assert.equal(readRevivalsWithin(s, 7, clock), READ_REVIVAL_CAP, 'fixture guard: at the cap');
  const d = tick(s, nodes, clock, { canRead: yes });
  assert.deepEqual(d.read, [], 'the read is withheld at the cap');
  assert.deepEqual(d.ping, [7], 'and the ladder carries on with pings, toward the summons');
  // …but the window ages out.
  s.readRevivals.set(7, [clock - READ_REVIVAL_WINDOW_MS - MIN, clock - 60 * MIN]);
  assert.equal(readRevivalsWithin(s, 7, clock), 1, 'a revival older than the window no longer counts');
  assert.deepEqual(tick(s, nodes, clock, { canRead: yes }).read, [7], 'below the cap the read is back');
});

test('every gate that holds the ladder holds the read too (v0.70.0)', () => {
  const owed = (): AutoPingState => {
    const s = createAutoPingState();
    tick(s, mesh(20, [dead(7)]), T, { canRead: yes });
    s.readOwed.add(7);
    return s;
  };
  const at = T + 11 * MIN;
  const nodes = mesh(20, [dead(7)]);
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes }).read, [7], 'fixture guard: ungated, it reads');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, config: cfg({ enabled: false }) }).read, [], 'disabled');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, config: cfg({ writeActions: false }) }).read, [], 'write actions off');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, rfOffSince: at - 1000 }).read, [], 'controller RF off');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, controller: { isRebuildingRoutes: true } as never }).read, [], 'rebuilding routes');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, booting: true }).read, [], 'boot window, roster not ready');
  assert.deepEqual(tick(owed(), nodes, at, { canRead: yes, booting: true, bootDeadLane: true }).read, [7],
    'boot window with the dead lane released reads exactly as the ladder pings');
  const storm = mesh(8, [dead(7), dead(8), dead(9), dead(10)]);
  const ss = createAutoPingState(); tick(ss, storm, T, { canRead: yes }); ss.readOwed.add(7);
  assert.deepEqual(tick(ss, storm, at, { canRead: yes }).read, [], 'storm');
});

test('battery and FLiRS nodes never get a routed read (v0.70.0)', () => {
  for (const over of [{ isListening: false }, { isListening: false, isFrequentListening: true } as never]) {
    const s = createAutoPingState();
    const nodes = mesh(20, [dead(7, over)]);
    tick(s, nodes, T, { canRead: yes });
    s.readOwed.add(7);
    assert.deepEqual(tick(s, nodes, T + 11 * MIN, { canRead: yes }).read, [], `not a ping candidate: ${JSON.stringify(over)}`);
  }
});

test('a routed read swallowed by the RF blackout is owed again; a ping is not (v0.70.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7), dead(8)]);
  pendProbe(s, 7, T, 'read');
  s.reads.set(7, 1);
  pendProbe(s, 8, T, 'dead');
  assert.equal(dropBlackoutProbes(s, nodes, T + 5_000), 2, 'fixture guard: both were in flight');
  assert.ok(s.readOwed.has(7), 'the read was never really asked, so it is owed again');
  assert.equal(s.reads.get(7), 0, 'and not counted as sent');
  assert.equal(s.readOwed.has(8), false, 'a dropped ping earns no read — only a JUDGED miss does');
});

test('recovery clears the owed read but keeps the revival history; departure clears both (v0.70.0)', () => {
  const s = createAutoPingState();
  s.readOwed.add(7); s.reads.set(7, 2); s.readRevivals.set(7, [T]);
  trackEpisodes(s, mesh(20, [node(7)]), T + MIN);
  assert.equal(s.readOwed.has(7), false, 'recovered: nothing is owed');
  assert.equal(s.reads.has(7), false, 'and the per-episode count resets');
  assert.deepEqual(s.readRevivals.get(7), [T], 'but revivals span episodes — that is what bounds the loop');
  trackEpisodes(s, mesh(20), T + 2 * MIN);
  assert.equal(s.readRevivals.has(7), false, 'a node that left the roster takes its history with it');
});

/* ── v0.70.0: the routed read, through the real runner ─────────────────── */

async function ladder(over: { read?: boolean; readResult?: unknown; nodes?: NodeSnapshot[]; staleMs?: number } = {}) {
  const { startAutoPing } = await import('../src/zwave/autoPing');
  let clock = T;
  const n7 = over.nodes ? over.nodes.find((n) => n.nodeId === 7)! : dead(7);
  const nodes = over.nodes ?? mesh(20, [n7]);
  const pings: number[] = [];
  const reads: { id: number; at: number }[] = [];
  const lines: { at: number; text: string }[] = [];
  const warns: string[] = [];
  const results: unknown[] = [];
  const push = (m: string) => lines.push({ at: clock, text: m });
  const log2 = Object.assign(push, { warn: (m: string) => { warns.push(m); push(m); }, error: push, debug: () => {} });
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async (id: number) => { pings.push(id); }, probe: async () => {},
    ...(over.read === false ? {} : {
      read: async (id: number) => { reads.push({ id, at: clock }); return over.readResult; },
      canRead: () => true,
    }),
    log: () => {}, log2,
    config: cfg({ staleMs: over.staleMs ?? 0, afterMs: 10 * MIN, maxAttempts: 3 }), tickMs: 1_000_000, now: () => clock,
    onProbeResult: (...a: unknown[]) => { results.push(a); },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    h, n7, pings, reads, lines, warns, results,
    at: () => clock,
    seen: (v: number | null) => { (n7.stats as unknown as { lastSeen: number | null }).lastSeen = v; },
    status: (st: NodeStatus) => { (n7 as unknown as { status: NodeStatus }).status = st; },
    async step(mins = 1) { for (let i = 0; i < mins; i++) { h.tick(); await flush(); clock += MIN; } },
    async until(pred: () => boolean, max = 400) { for (let i = 0; i < max && !pred(); i++) await this.step(); },
    node7: () => h.snapshot().nodes.find((n) => n.nodeId === 7),
  };
}

test('the runner sends the read only AFTER the ping is judged, once per rung, and never as a ping (v0.70.0)', async () => {
  const L = await ladder();
  await L.until(() => L.pings.length === 1);
  const pingAt = L.at() - MIN;
  await L.until(() => L.reads.length === 1);
  assert.ok(L.reads[0].at - pingAt >= 90_000, `the read waits for the ping's answer grace (${(L.reads[0].at - pingAt) / 1000}s)`);
  assert.equal(L.pings.length, 1, 'the tick that reads does not also ping');
  assert.ok(L.lines.some((l) => /sending one routed read/.test(l.text)), 'the read is said out loud');
  await L.step(6);
  assert.equal(L.reads.length, 1, 'one read per rung — not one per tick while the backoff runs');
  L.h.stop();
});

test('a read the node answers revives it and says so; recovery then clears the rung (v0.70.0)', async () => {
  const L = await ladder();
  await L.until(() => L.reads.length === 1);
  L.seen(L.reads[0].at + 1_000);                 // the Get was ACKed
  await L.until(() => L.lines.some((l) => /answered our routed read/.test(l.text)), 10);
  assert.ok(L.lines.some((l) => /answered our routed read after its ping went unanswered/.test(l.text)), 'the revival is attributed in the log');
  assert.equal(L.node7()?.readRevivals24h, 1, 'and counted');
  L.status(NodeStatus.Alive);
  await L.step();
  assert.equal(L.node7()?.readOwed ?? false, false, 'nothing is owed once it is Alive');
  assert.equal(L.node7()?.reads ?? 0, 0, 'and the per-episode count reset');
  assert.equal(L.results.length, 0, 'a read never reaches the persisted reply rate');
  L.h.stop();
});

test('a node that ignores pings AND reads is summoned after the last read is judged, and the line says so (v0.70.0)', async () => {
  const L = await ladder();
  await L.until(() => L.lines.some((l) => /giving up/.test(l.text)));
  const gaveUp = L.lines.find((l) => /giving up/.test(l.text))!;
  assert.equal(L.pings.length, 3, 'three pings, as before');
  assert.equal(L.reads.length, 3, 'one read per rung');
  assert.ok(gaveUp.at - L.reads[2].at >= 90_000, 'nobody is summoned before the last read could be answered');
  assert.match(gaveUp.text, /did not answer 3 pings or 3 routed reads — giving up/);
  assert.match(gaveUp.text, /3 NOP frames and 3 single-attempt Gets that could auto-route/);
  L.h.stop();
});

test('without a read verb the ladder and its give-up text are exactly v0.69.0 (v0.70.0)', async () => {
  const L = await ladder({ read: false });
  await L.until(() => L.lines.some((l) => /giving up/.test(l.text)));
  const gaveUp = L.lines.find((l) => /giving up/.test(l.text))!;
  assert.equal(L.reads.length, 0);
  assert.match(gaveUp.text, /did not answer 3 pings — giving up\. That means it ignored 3 NOP frames, NOT that it is unreachable: try OPERATING the device \(a real command often lands when pings do not\), then a manual ping, then check its power\./);
  L.h.stop();
});

test('a read that never leaves is un-counted and NOT retried, and spends no ladder budget (v0.70.0)', async () => {
  const L = await ladder({ readResult: { ok: false, message: 'no entity' } });
  await L.until(() => L.reads.length === 1);
  await L.step();
  assert.equal(L.node7()?.reads, 0, 'a read that never left is not counted as sent');
  assert.equal(L.node7()?.attempts, 1, 'the ping budget is untouched');
  assert.equal(L.node7()?.launchFailures, 0, 'and it is not a failure to probe');
  assert.ok(L.warns.some((w) => /no switch\/light value to read, or transport error/.test(w)) ||
    L.lines.some((l) => /could not be probed/.test(l.text)), 'the failed launch is reported, with a reason that fits a read');
  await L.step(8);
  assert.equal(L.reads.length, 1, 'and it is not re-sent every tick — the next one needs the next ping to miss');
  L.h.stop();
});

test('a second routed-read revival in 24 h raises a WARN and withholds the next read (v0.70.0)', async () => {
  const L = await ladder();
  for (let cycle = 1; cycle <= 2; cycle++) {
    const before = L.reads.length;
    await L.until(() => L.reads.length === before + 1);
    L.seen(L.at());
    await L.until(() => L.lines.filter((l) => /answered our routed read/.test(l.text)).length === cycle, 10);
    L.status(NodeStatus.Alive);
    await L.step(2);
    L.status(NodeStatus.Dead);                   // it dies again, on nothing of ours
  }
  assert.equal(L.warns.filter((w) => /revived by a routed read 2 times in 24 h after its ladder pings went unanswered — its stored routes keep failing/.test(w)).length, 1,
    'the loop is named, once');
  const readsAtCap = L.reads.length;
  await L.until(() => L.lines.some((l) => /giving up/.test(l.text)));
  assert.equal(L.reads.length, readsAtCap, 'past the cap no further read goes out');
  assert.match(L.lines.find((l) => /giving up/.test(l.text))!.text, /revived it 2 times in the last 24 h after its pings went unanswered, so the read is withheld: its stored routes keep failing where a computed one got through/);
  L.h.stop();
});

test('a SWEEP miss never earns a routed read — only a judged ladder ping does (v0.70.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  const L = await ladder({ nodes: [node(1, { isController: true }), n7], staleMs: 60 * MIN });
  await L.until(() => L.lines.some((l) => /node 7 did NOT answer its probe/.test(l.text)), 20);
  assert.ok(L.lines.some((l) => /node 7 did NOT answer its probe/.test(l.text)), 'fixture guard: the sweep probe was judged a miss');
  assert.equal(L.node7()?.readOwed ?? false, false, 'no read is owed for a sweep miss');
  assert.equal(L.reads.length, 0);
  L.h.stop();
});

/* ── v0.71.0: the measurement lanes send a routed read; our own kills are contained ── */

type RigCall = { verb: 'ping' | 'probe' | 'probeRead' | 'read' | 'sent' | 'withdrawn'; id: number; at: number; lane?: string; frame?: string };

/** The real runner with every v0.71.0 hook recorded. The clock starts past the
 *  boot window, so the measurement lanes are open from the first tick. */
async function rig(over: {
  nodes: NodeSnapshot[];
  staleMs?: number;
  canRead?: (id: number) => boolean;
  probeRead?: boolean;
  readResult?: (id: number) => unknown;
  ladderReadResult?: (id: number) => unknown;
  verify?: (now: number, skip?: (id: number) => boolean) => { id: number; first: boolean }[];
  deaths?: () => { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[];
}) {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const calls: RigCall[] = [];
  const lines: string[] = [];
  const warns: string[] = [];
  const results: unknown[][] = [];
  const log2 = Object.assign((m: string) => { lines.push(m); },
    { warn: (m: string) => { warns.push(m); lines.push(m); }, error: (m: string) => { lines.push(m); }, debug: () => {} });
  const h = startAutoPing({
    nodes: () => over.nodes, controller: () => null, ready: () => true,
    ping: async (id) => { calls.push({ verb: 'ping', id, at: clock }); },
    probe: async (id) => { calls.push({ verb: 'probe', id, at: clock }); },
    read: async (id) => { calls.push({ verb: 'read', id, at: clock }); return over.ladderReadResult?.(id); },
    ...(over.probeRead === false ? {} : {
      probeRead: async (id: number) => { calls.push({ verb: 'probeRead', id, at: clock }); return over.readResult?.(id); },
    }),
    canRead: over.canRead ?? (() => true),
    onMeasurementSent: (id, at, lane, frame) => { calls.push({ verb: 'sent', id, at, lane, frame }); },
    onMeasurementWithdrawn: (id, at) => { calls.push({ verb: 'withdrawn', id, at }); },
    verifyRequests: over.verify,
    deaths: over.deaths,
    log: () => {}, log2,
    onProbeResult: (...a: unknown[]) => { results.push(a); },
    config: cfg({ staleMs: over.staleMs ?? 0 }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS;
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    h, calls, lines, warns, results,
    at: () => clock,
    set: (t: number) => { clock = t; },
    async step(mins = 1) { for (let i = 0; i < mins; i++) { h.tick(); await flush(); clock += MIN; } },
    snap: (id: number) => h.snapshot().nodes.find((n) => n.nodeId === id),
    of: (verb: RigCall['verb'], id?: number) => calls.filter((c) => c.verb === verb && (id == null || c.id === id)),
  };
}
const setStatus = (n: NodeSnapshot, st: NodeStatus) => { (n as unknown as { status: NodeStatus }).status = st; };
const setSeen = (n: NodeSnapshot, v: number | null) => { (n.stats as unknown as { lastSeen: number | null }).lastSeen = v; };

test('the SWEEP and VERIFY lanes send the routed read through probeRead() when the node has a value to read; the DEAD ladder still pings (v0.71.0)', async () => {
  const nodes = [node(1, { isController: true }), dead(7), node(50, { stats: { lastSeen: T - 300 * MIN } as never }),
    ...Array.from({ length: 18 }, (_v, i) => node(100 + i, { stats: { lastSeen: T + 30 * MIN } as never }))];
  let due = false;
  const R = await rig({ nodes, staleMs: 240 * MIN, verify: () => (due ? [{ id: 100, first: false }] : []) });
  await R.step();                                   // observe the dead node; the sweep asks the stalest
  R.set(R.at() + 10 * MIN); due = true; await R.step(); // the ladder is due, and a verification probe
  R.h.stop();
  assert.deepEqual(R.of('probeRead').map((c) => c.id).sort((a, b) => a - b), [50, 100],
    `both measurement lanes read: ${JSON.stringify(R.calls)}`);
  assert.deepEqual(R.of('probe'), [], 'no NoOp goes out from a measurement lane that can read');
  assert.deepEqual(R.of('ping').map((c) => c.id), [7], 'the dead ladder keeps the learning ping');
  assert.deepEqual(R.of('read'), [], 'and the measurement read is not the ladder read verb');
});

test('a node with no switch/light value is swept by the NoOp probe(), and each line names its frame (v0.71.0)', async () => {
  const nodes = [node(1, { isController: true }), node(50, { stats: { lastSeen: T - 300 * MIN } as never }),
    node(100, { stats: { lastSeen: T + 30 * MIN } as never })];
  let due = false;
  const R = await rig({ nodes, staleMs: 240 * MIN, canRead: (id) => id !== 50,
    verify: () => (due ? [{ id: 100, first: true }] : []) });
  await R.step();
  due = true; await R.step();
  R.h.stop();
  assert.deepEqual(R.of('probe').map((c) => c.id), [50], 'the node with nothing to read gets the NoOp');
  assert.deepEqual(R.of('probeRead').map((c) => c.id), [100]);
  assert.ok(R.lines.some((l) => /^auto-ping: node 50 liveness sweep .* — NoOp ping \(no switch\/light value to read\)$/.test(l)),
    `the sweep line says which frame and why: ${JSON.stringify(R.lines)}`);
  assert.ok(R.lines.some((l) => /^auto-ping: node 100 verification probe \(episode evidence, burst start, \d+ nodes? owed\) — routed read$/.test(l)));
});

test('without probeRead the measurement lines carry no frame suffix, exactly v0.70.0 (v0.71.0)', async () => {
  const nodes = [node(1, { isController: true }), node(50, { stats: { lastSeen: T - 300 * MIN } as never })];
  const R = await rig({ nodes, staleMs: 240 * MIN, probeRead: false });
  await R.step();
  R.h.stop();
  const line = R.lines.find((l) => /node 50 liveness sweep/.test(l));
  assert.ok(line && !/ — (routed read|NoOp ping)/.test(line), `no suffix without a read verb: ${line}`);
  assert.deepEqual(R.of('probe').map((c) => c.id), [50]);
});

test('onProbeResult carries the frame — read for a routed-read sweep, answered or missed; ping for a NoOp one (v0.71.0)', async () => {
  const run = async (probeRead: boolean, answer: boolean) => {
    const n50 = node(50, { stats: { lastSeen: T - 300 * MIN } as never });
    const R = await rig({ nodes: [node(1, { isController: true }), n50], staleMs: 240 * MIN, probeRead });
    await R.step();
    if (answer) setSeen(n50, R.at() - MIN + 500);  // answered 0.5 s after it went out
    await R.step(2);
    R.h.stop();
    missLines.push(...R.lines.filter((l) => /did NOT answer its probe/.test(l)));
    return R.results.map((r) => [r[0], r[1], r[3]]);
  };
  const missLines: string[] = [];
  assert.deepEqual(await run(true, true), [[50, true, 'read']]);
  assert.deepEqual(await run(true, false), [[50, false, 'read']]);
  assert.deepEqual(await run(false, true), [[50, true, 'ping']]);
  assert.deepEqual(missLines.map((l) => / — [a-z]+ [a-zA-Z ]+$/.exec(l)?.[0]), [' — sweep routed read'],
    'the one miss line names its lane and frame');
});

test('a sweep READ that knocks its node Dead is a sweep miss with frame read, retried without the dwell, never a read revival (v0.71.0)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  tick(s, mesh(20, [node(7, heard)]), T);
  pendProbe(s, 7, T + 30_000, 'sweep', 'echo-only', 'read');
  const died = mesh(20, [dead(7, heard)]);
  assert.deepEqual(trackEpisodes(s, died, T + MIN), [{ nodeId: 7, misses: 1, cls: 'echo-only', lane: 'sweep', frame: 'read' }]);
  assert.equal(s.probeDeath.get(7), 'sweep');
  assert.equal(probeKillsWithin(s, 7, T + MIN), 1, 'counted as our own kill');
  assert.equal(s.readOwed.has(7), false, 'it owes no ladder read — the ladder pings first');
  const d = decideAutoPings({ now: T + MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false, canRead: () => true });
  assert.deepEqual([d.ping, d.read], [[7], []], 'the retry is the ladder ping, on the tick the death is seen');
});

test('an RF blackout drops an unanswered sweep read unjudged and owes no ladder read (v0.71.0)', () => {
  const s = createAutoPingState();
  pendProbe(s, 7, T, 'sweep', 'unheard', 'read');
  assert.equal(dropBlackoutProbes(s, [node(7, { stats: { lastSeen: T - MIN } as never })], T + 5_000), 1);
  assert.equal(s.awaitingAnswer.has(7), false, 'dropped, not judged');
  assert.equal(s.readOwed.has(7), false, 'a sweep read is not the ladder\'s read, so nothing is re-owed');
});

test('a burst kill is not filed as "talking" on the burst\'s own earlier answers (v0.71.0)', () => {
  // 2026-09-22 22:46: the burst's first probes were answered, the next one
  // killed the outlet, and those answers — traffic from BEFORE the kill — filed
  // it as talking, so the ladder waited out the dwell.
  const s = createAutoPingState();
  tick(s, mesh(20, [node(7, { stats: { lastSeen: T - 120 * MIN } as never })]), T);
  pendProbe(s, 7, T + 60_000, 'verify');
  pendProbe(s, 7, T + 120_000, 'verify');
  const died = mesh(20, [dead(7, { stats: { lastSeen: T + 60_050 } as never })]);   // answered the first
  trackEpisodes(s, died, T + 3 * MIN);
  assert.equal(s.probeDeath.get(7), 'verify', 'the unanswered burst probe killed it');
  const d = decideAutoPings({ now: T + 3 * MIN, state: s, nodes: died, controller: null, config: cfg(), booting: false });
  assert.deepEqual(d.talkingWhileDead, [], 'its own earlier answer is older than the kill');
  assert.deepEqual(d.ping, [7], 'so it is retried at once');
});

test('a node revived from a death on our own probe gets no sweep or verification probe for PROBE_KILL_HOLD_MS; the ladder is not held (v0.71.0)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  const only = (n: NodeSnapshot) => [node(1, { isController: true }), n];
  tick(s, only(node(7, heard)), T);
  pendProbe(s, 7, T + 10_000, 'sweep', 'echo-only', 'read');
  trackEpisodes(s, only(dead(7, heard)), T + MIN);                  // killed by our read
  const back = { stats: { lastSeen: T + MIN + 5_000 } as never };
  const rec = T + 2 * MIN;
  trackEpisodes(s, only(node(7, back)), rec);                        // revived by the retry
  assert.equal(s.probeHoldFrom.get(7), rec, 'the hold is timed from the RECOVERY, not the kill');
  const at = (t: number, verify: boolean) => decideAutoPings({ now: t, state: s, nodes: only(node(7, back)), controller: null,
    config: cfg({ staleMs: 5 * MIN }), booting: false, verifyDue: () => (verify ? [{ id: 7, first: true }] : []) });
  const held = at(rec + PROBE_KILL_HOLD_MS - MIN, true);
  assert.deepEqual([held.stale, held.verify], [[], []], 'no sweep and no verification probe inside the hold');
  assert.equal(inProbeHold(s, 7, rec + PROBE_KILL_HOLD_MS - 1), true);
  assert.equal(inProbeHold(s, 7, rec + PROBE_KILL_HOLD_MS), false);
  assert.deepEqual(at(rec + PROBE_KILL_HOLD_MS, true).verify, [7], 'the verification probe goes out when the hold lifts');
  assert.deepEqual(at(rec + PROBE_KILL_HOLD_MS, false).stale, [7], 'and so does the sweep');
  // An UNPROVOKED death inside the hold: nothing of ours was pending, so it
  // serves the dwell — and the ladder then acts, hold or no hold.
  const d2 = rec + MIN;
  const quiet = { stats: { lastSeen: T - 120 * MIN } as never };
  trackEpisodes(s, only(dead(7, quiet)), d2);
  assert.equal(s.probeDeath.has(7), false, 'nothing of ours was pending');
  const deadAt = (t: number) => decideAutoPings({ now: t, state: s, nodes: only(dead(7, quiet)), controller: null, config: cfg(), booting: false });
  assert.deepEqual([deadAt(d2).ping, deadAt(d2).talkingWhileDead], [[], []], 'it serves the dwell (fixture: not "talking")');
  assert.equal(inProbeHold(s, 7, d2 + 10 * MIN), true, 'fixture guard: the dwell ends INSIDE the hold');
  assert.deepEqual(deadAt(d2 + 10 * MIN).ping, [7], 'and the ladder is never held');
});

test('kill, retry and hold keep our own probes under dead-flap\'s three crossings in any 10-minute window (v0.71.0)', async () => {
  // The worst case: a verification burst owed on EVERY tick, a 5-minute sweep,
  // and a node that dies on every measurement frame and revives on every ladder
  // frame. Without the hold this is the kill–revive–kill loop v0.64.4 refused
  // the immediate retry for.
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let skipped = 0;
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 5 * MIN,
    verify: (_now, skip) => { if (skip?.(7)) { skipped++; return []; } return [{ id: 7, first: false }]; } });
  const flips: number[] = [];
  let seen = 0;
  let kills = 0;
  for (let i = 0; i < 180; i++) {
    await R.step();
    const sentAt = R.at() - MIN;
    const fresh = R.calls.slice(seen);
    seen = R.calls.length;
    const wasDead = n7.status === NodeStatus.Dead;
    if (fresh.some((c) => (c.verb === 'probeRead' || c.verb === 'probe') && c.id === 7)) setStatus(n7, NodeStatus.Dead);
    if (fresh.some((c) => (c.verb === 'ping' || c.verb === 'read') && c.id === 7)) {
      setStatus(n7, NodeStatus.Alive);
      setSeen(n7, sentAt + 500);
    }
    const isDead = n7.status === NodeStatus.Dead;
    if (isDead !== wasDead) { flips.push(R.at()); if (isDead) kills++; }
  }
  R.h.stop();
  assert.ok(kills >= 3, `fixture guard: our probes did kill the node repeatedly (${kills})`);
  assert.ok(skipped > 0, 'the runner asks the queue to leave a held node\'s burst owed');
  for (const f of flips) {
    const inWindow = flips.filter((x) => x >= f && x < f + 10 * MIN).length;
    assert.ok(inWindow <= 2, `≤2 Dead crossings in any 10-minute window, got ${inWindow} from ${f}`);
  }
  assert.equal(R.warns.filter((w) => /node 7 went Dead on this add-on's own probes 2 times in 24 h/.test(w)).length, 1,
    'the marginal route is named once');
  assert.ok(R.lines.some((l) => /did NOT answer its probe \(1st consecutive miss — the node has since been marked Dead\) — (sweep|verification) routed read$/.test(l)),
    'each miss line names its lane and frame');
});

test('two own-probe kills of one node in 24 h queue ONE warning; a third does not; an old kill does not count; a manual kill never counts (v0.71.0)', () => {
  const s = createAutoPingState();
  const heard = { stats: { lastSeen: T - 120 * MIN } as never };
  const alive = mesh(20, [node(7, heard)]);
  const died = mesh(20, [dead(7, heard)]);
  const killAt = (t: number, lane: 'sweep' | 'verify' | 'manual') => {
    trackEpisodes(s, alive, t - MIN);
    pendProbe(s, 7, t - 30_000, lane);
    trackEpisodes(s, died, t);
  };
  s.probeKills.set(7, [T - PROBE_KILL_WINDOW_MS - MIN]);             // a kill from yesterday
  killAt(T, 'sweep');
  assert.equal(probeKillsWithin(s, 7, T), 1, 'the day-old kill aged out');
  assert.equal(s.probeKillWarn.has(7), false);
  killAt(T + 60 * MIN, 'manual');
  assert.equal(probeKillsWithin(s, 7, T + 60 * MIN), 1, 'a manual kill is not ours to count');
  killAt(T + 120 * MIN, 'verify');
  assert.equal(probeKillsWithin(s, 7, T + 120 * MIN), PROBE_KILL_WARN_AT);
  assert.equal(s.probeKillWarn.has(7), true, 'the second one queues the warning');
  s.probeKillWarn.clear();
  killAt(T + 180 * MIN, 'sweep');
  assert.equal(s.probeKillWarn.has(7), false, 'the third does not repeat it');
});

test('a departed node takes its probe hold, kill history, warning and read-fallback mark with it (v0.71.0)', () => {
  const s = createAutoPingState();
  s.probeHoldFrom.set(7, T); s.probeKills.set(7, [T]); s.probeKillWarn.add(7);
  s.readLaunchFailedAt.set(7, T); s.readAfterOwnKill.add(7); s.probeDeath.set(7, 'sweep');
  trackEpisodes(s, mesh(20), T + MIN);
  assert.deepEqual([s.probeHoldFrom.has(7), s.probeKills.has(7), s.probeKillWarn.has(7), s.readLaunchFailedAt.has(7),
    s.readAfterOwnKill.has(7), s.probeDeath.has(7)], [false, false, false, false, false, false]);
});

test('a routed read that could not be sent is withdrawn and refunded, the node falls back to the NoOp ping for READ_LAUNCH_FALLBACK_MS, and the sweep does not stall (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 400 * MIN } as never });
  const n8 = node(8, { stats: { lastSeen: T - 300 * MIN } as never });
  let refuse = true;
  const R = await rig({ nodes: [node(1, { isController: true }), n7, n8], staleMs: 120 * MIN,
    readResult: (id) => (id === 7 && refuse ? { ok: false, message: 'no entity' } : undefined) });
  await R.step();                                                     // 7 is read — and refused
  assert.deepEqual(R.of('probeRead').map((c) => c.id), [7]);
  assert.ok(R.lines.some((l) => /node 7: a routed read could not be sent — its sweep and verification probes use the NoOp ping for the next 30m/.test(l)));
  assert.deepEqual(R.of('withdrawn').map((c) => [c.id, c.at]), [[7, R.of('sent', 7)[0].at]], 'its measurement stamp is withdrawn, so no later frame inherits it');
  await R.step();                                                     // refunded: 7 again, by NoOp
  assert.deepEqual(R.of('probe').map((c) => c.id), [7], 'the refunded slot goes out as the fallback NoOp');
  assert.ok(R.lines.some((l) => /node 7 liveness sweep .* — NoOp ping \(a routed read could not be sent in the last 30m\)$/.test(l)));
  await R.step();                                                     // and the queue moves on
  assert.deepEqual(R.of('probeRead').map((c) => c.id), [7, 8], 'the sweep did not stall on 7');
  refuse = false;
  R.set(R.at() + 120 * MIN);
  await R.step(2);
  R.h.stop();
  assert.equal(R.of('probeRead', 7).length, 2, `past the fallback 7 is read again: ${JSON.stringify(R.calls)}`);
  assert.ok(READ_LAUNCH_FALLBACK_MS < 120 * MIN, 'fixture guard: the cadence outlasts the fallback');
});

test('onMeasurementSent fires BEFORE the send for sweep and verification probes of either frame, never for the ladder, its read or a manual ping (v0.71.0)', async () => {
  const nodes = [node(1, { isController: true }), dead(7), node(50, { stats: { lastSeen: T - 300 * MIN } as never }),
    node(60, { stats: { lastSeen: T - 200 * MIN } as never })];
  const R = await rig({ nodes, staleMs: 240 * MIN, canRead: (id) => id !== 60,
    verify: (now) => (now >= T + 7 * MIN && now < T + 8 * MIN ? [{ id: 60, first: true }] : []) });
  await R.step(3);
  R.h.notePending(50, 'manual', R.at());
  R.set(R.at() + 10 * MIN);
  for (let i = 0; i < 6 && R.of('read', 7).length === 0; i++) await R.step();
  R.h.stop();
  assert.equal(R.of('read', 7).length, 1, 'fixture guard: the ladder read went out');
  const idx = (verb: RigCall['verb'], id: number) => R.calls.findIndex((c) => c.verb === verb && c.id === id);
  assert.ok(idx('sent', 50) >= 0 && idx('sent', 50) < idx('probeRead', 50), 'stamped before the read goes out');
  assert.ok(idx('sent', 60) >= 0 && idx('sent', 60) < idx('probe', 60), 'and before a NoOp one');
  assert.deepEqual(R.of('sent').map((c) => [c.id, c.lane, c.frame]), [[50, 'sweep', 'read'], [60, 'sweep', 'ping'], [60, 'verify', 'ping']]);
  assert.equal(R.of('sent', 7).length, 0, 'neither the ladder ping nor its read is a measurement');
  assert.ok(R.of('ping', 7).length > 0, 'fixture guard: the ladder did ping 7');
});

test('the twin-lane dedup still sends ONE measurement probe per node per tick with probeRead wired (v0.71.0)', async () => {
  const R = await rig({ nodes: [node(1, { isController: true }), node(50, { stats: { lastSeen: T - 300 * MIN } as never })],
    staleMs: 240 * MIN, verify: () => [{ id: 50, first: true }] });
  await R.step();
  R.h.stop();
  assert.equal(R.of('probeRead', 50).length, 1, 'one frame, which answers both questions');
  assert.deepEqual(R.of('sent').map((c) => c.lane), ['verify']);
});

test('the snapshot reports the probe hold and own-probe kills (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN });
  await R.step();                                                     // swept by a read…
  setStatus(n7, NodeStatus.Dead);                                     // …which killed it
  await R.step();                                                     // seen Dead: retried
  setStatus(n7, NodeStatus.Alive); setSeen(n7, R.at() - MIN + 300);
  const rec = R.at();
  await R.step(4);                                                    // seen Alive: the hold starts; the retry is judged
  R.h.stop();
  assert.equal(R.snap(7)?.pending ?? 0, 0, 'fixture guard: nothing is pending, so only the hold keeps the row');
  assert.equal(R.snap(7)?.missStreak ?? 0, 0);
  assert.equal(R.snap(7)?.probeKills24h, 1);
  assert.equal(R.snap(7)?.probeHeldUntilMs, rec + PROBE_KILL_HOLD_MS);
});

test('a death that clears between two ticks is still booked as our probe\'s kill — counted and held — and the probe is judged answered (v0.71.0)', async () => {
  // A Get can do what a NoOp cannot: the node takes it, the ACK is lost, the
  // driver marks it Dead on the NoAck — and the node's own Report revives it
  // before the next tick. Level-sampled, that death never happened.
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 5 * MIN,
    deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  assert.deepEqual(R.of('probeRead').map((c) => c.id), [7]);
  feed = [{ nodeId: 7, at: sentAt + 400, seen: T - 300 * MIN, clearedAt: sentAt + 700 }];   // Dead on the NoAck, unanswered…
  setSeen(n7, sentAt + 700);                                          // …Alive on its Report
  await R.step();
  assert.ok(R.lines.some((l) => /node 7 went Dead 0s after our sweep routed read and was Alive again before the next tick \(revived 0\.3s later — a lost ACK, most likely: its Report revives it\) — no sweep or verification probe for 15m$/.test(l)),
    JSON.stringify(R.lines));
  assert.equal(R.snap(7)?.probeKills24h, 1, 'counted');
  const readsAfter = R.of('probeRead', 7).length;
  await R.step(13);
  assert.equal(R.of('probeRead', 7).length, readsAfter, 'and held: no measurement probe inside the hold');
  await R.step(3);
  R.h.stop();
  assert.ok(R.of('probeRead', 7).length > readsAfter, 'until it lifts');
  assert.deepEqual(R.results.map((r) => [r[0], r[1], r[3]]).slice(0, 1), [[7, true, 'read']],
    'the probe is ANSWERED: its Report proves the Get arrived');
  assert.equal(R.lines.filter((l) => /did NOT answer/.test(l)).length, 0, 'no miss is booked for it');
});

test('a between-tick death is not ours when the node\'s newest pending probe is manual, or when the tick itself saw it Dead (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 0,
    deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  R.h.notePending(7, 'manual', R.at());
  feed = [{ nodeId: 7, at: R.at() + 300 }];
  setSeen(n7, R.at() + 600);
  await R.step();
  R.h.stop();
  assert.equal(R.snap(7)?.probeKills24h ?? 0, 0, 'an operator\'s ping is not a measurement');
  // Seen Dead at the tick as well as on the feed: trackEpisodes owns it, and
  // it is counted ONCE.
  const m7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed2: { nodeId: number; at: number; seen?: number | null }[] = [];
  const R2 = await rig({ nodes: [node(1, { isController: true }), m7], staleMs: 240 * MIN,
    deaths: () => { const f = feed2; feed2 = []; return f; } });
  await R2.step();
  feed2 = [{ nodeId: 7, at: R2.at() - MIN + 400 }];
  setStatus(m7, NodeStatus.Dead);
  await R2.step();
  R2.h.stop();
  assert.equal(R2.snap(7)?.probeKills24h, 1, 'one death, one kill');
});

test('a read revival after a death on our own measurement probe does not spend the read cap; the line says why (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN });
  await R.step();                                                     // swept by a read…
  setStatus(n7, NodeStatus.Dead);                                     // …which killed it
  for (let i = 0; i < 12 && R.of('read', 7).length === 0; i++) await R.step();   // retry ping unanswered → ladder read
  assert.equal(R.of('read', 7).length, 1, 'fixture guard: the ladder read went out');
  const readAt = R.of('read', 7)[0].at;
  setSeen(n7, readAt + 400);                                          // the read revived it
  await R.step();
  setStatus(n7, NodeStatus.Alive);
  await R.step(3);
  R.h.stop();
  assert.ok(R.lines.some((l) => /answered our routed read after its ping went unanswered .* it went Dead on our own probe, so this revival does not count against the 2-per-24 h read cap/.test(l)),
    JSON.stringify(R.lines.filter((l) => /routed read/.test(l))));
  assert.equal(R.snap(7)?.readRevivals24h ?? 0, 0, 'the cap is untouched');
});

test('a verification probe that could not be sent gives back the PREVIOUS burst stamp, so the next gap is measured from a probe that left (v0.71.0)', async () => {
  let n = 0;
  const R = await rig({ nodes: [node(1, { isController: true }), node(100, { stats: { lastSeen: T + 60 * MIN } as never })],
    probeRead: true, readResult: () => (n++ === 1 ? { ok: false, message: 'refused' } : undefined),
    verify: () => [{ id: 100, first: false }] });
  await R.step(3);
  R.h.stop();
  const gaps = R.lines.filter((l) => /node 100 verification probe/.test(l)).map((l) => /\+(\d+)s/.exec(l)?.[1] ?? 'start');
  assert.deepEqual(gaps, ['start', '60', '120'], `the third gap is from the first probe, not the refused one: ${JSON.stringify(R.lines)}`);
  assert.deepEqual(R.of('probe').map((c) => c.id), [100], 'and a refused verification read moves the node to the NoOp fallback');
  assert.deepEqual(R.of('withdrawn').map((c) => c.id), [100], 'and withdraws its measurement stamp');
  assert.equal(R.of('withdrawn')[0].at, R.of('sent', 100)[1].at, 'the stamp of the probe that never left');
});

test('a read whose launch failed in an own-kill episode lends no cap exemption to a later, unprovoked one (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let refuseLadderRead = true;
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN,
    ladderReadResult: () => (refuseLadderRead ? { ok: false, message: 'refused' } : undefined) });
  await R.step();                                                     // swept by a read…
  setStatus(n7, NodeStatus.Dead);                                     // …which killed it
  for (let i = 0; i < 12 && R.of('read', 7).length === 0; i++) await R.step();
  assert.equal(R.of('read', 7).length, 1, 'fixture guard: the own-kill episode\'s ladder read was attempted');
  await R.step();                                                     // its launch failed: never judged
  setStatus(n7, NodeStatus.Alive); setSeen(n7, R.at());               // revived by something else
  await R.step(20);                                                   // recovery; the hold runs out
  refuseLadderRead = false;
  setStatus(n7, NodeStatus.Dead);                                     // an UNPROVOKED death
  for (let i = 0; i < 30 && R.of('read', 7).length === 1; i++) await R.step();
  assert.equal(R.of('read', 7).length, 2, 'fixture guard: the unprovoked episode\'s read went out');
  setSeen(n7, R.of('read', 7)[1].at + 400);                           // and revived it
  await R.step(3);
  R.h.stop();
  assert.equal(R.snap(7)?.readRevivals24h, 1, 'an unprovoked revival spends the cap — the old episode\'s mark did not leak into it');
});

/* ── v0.71.0 review: a death between ticks is ours only if our probe went unanswered ── */

/** One sweep probe to node 7 at the first tick, then a death fed between ticks. */
async function blip(over: { canRead?: boolean; seen: (sentAt: number) => number | null; deathAfter: number; manualAfter?: number; revivedAfter?: number }) {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN,
    canRead: () => over.canRead ?? true, deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  if (over.manualAfter != null) R.h.notePending(7, 'manual', sentAt + over.manualAfter);
  const seen = over.seen(sentAt);
  if (seen != null) setSeen(n7, seen);
  feed = [{ nodeId: 7, at: sentAt + over.deathAfter, seen, clearedAt: sentAt + (over.revivedAfter ?? over.deathAfter + 300) }];
  if (over.revivedAfter != null) setSeen(n7, sentAt + over.revivedAfter);   // what revived it
  await R.step();
  await R.step(2);
  R.h.stop();
  return { R, sentAt };
}

test('a between-tick death AFTER the node answered our probe is not ours — not counted, not held (v0.71.0)', async () => {
  // A verification burst probes its node about once a tick; a flap of the
  // node's own 40 s after it answered one is the node's, not our probe's.
  const { R } = await blip({ seen: (at) => at + 200, deathAfter: 40_000 });
  assert.equal(R.snap(7)?.probeKills24h ?? 0, 0);
  assert.equal(R.snap(7)?.probeHeldUntilMs ?? null, null);
  assert.ok(!R.lines.some((l) => /went Dead .* after our/.test(l)), JSON.stringify(R.lines));
});

test('a between-tick death past the answer grace, or before the probe went out, is not ours (v0.71.0)', async () => {
  const late = await blip({ seen: () => T - 300 * MIN, deathAfter: 95_000 });
  assert.equal(late.R.snap(7)?.probeKills24h ?? 0, 0, 'a death 95 s after an unjudged probe is not blamed on it');
  const early = await blip({ seen: () => T - 300 * MIN, deathAfter: -5_000 });
  assert.equal(early.R.snap(7)?.probeKills24h ?? 0, 0, 'a death before the probe went out cannot be its');
});

test('the NEWEST probe before a between-tick death decides — a manual ping sent after the sweep takes the blame (v0.71.0)', async () => {
  const { R } = await blip({ seen: () => T - 300 * MIN, deathAfter: 20_000, manualAfter: 10_000 });
  assert.equal(R.snap(7)?.probeKills24h ?? 0, 0, "the operator's ping was the nearer frame, and a manual kill is never ours");
});

test('a between-tick NoOp kill is a MISS — the traffic that revived the node is not the ping\'s answer (v0.71.0)', async () => {
  const { R } = await blip({ canRead: false, seen: () => T - 300 * MIN, deathAfter: 400, revivedAfter: 30_000 });
  assert.equal(R.snap(7)?.probeKills24h, 1, 'counted as our kill');
  assert.ok(R.snap(7)?.probeHeldUntilMs != null, 'and held');
  assert.deepEqual(R.results.map((r) => [r[0], r[1], r[3]]), [[7, false, 'ping']], 'booked unanswered, once — never later credited as answered');
  const quick = await blip({ canRead: false, seen: () => T - 300 * MIN, deathAfter: 400, revivedAfter: 700 });
  assert.deepEqual(quick.R.results.map((r) => [r[0], r[1], r[3]]), [[7, false, 'ping']], 'even revived at once: a NoOp is never answered');
  const miss = R.lines.find((l) => /did NOT answer its probe/.test(l)) ?? '';
  assert.match(miss, /1st consecutive miss — it went Dead 0s after our sweep NoOp ping and was Alive again before the next tick; a NoOp gets no reply, so that was not an answer\) — no sweep or verification probe for 15m — sweep NoOp ping$/);
});

test('a burst whose first probe was answered and whose second killed the node counts ONE kill when the tick also saw it Dead (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 0,
    verify: () => [{ id: 7, first: false }], deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();                                                     // verify 1 goes out…
  const first = R.at() - MIN;
  setSeen(n7, first + 200);                                           // …and is answered
  await R.step();                                                     // verify 2 goes out…
  const second = R.at() - MIN;
  setStatus(n7, NodeStatus.Dead);                                     // …and kills it
  feed = [{ nodeId: 7, at: second + 400, seen: first + 200 }];        // the feed saw it too, and saw it clear
  await R.step();
  R.h.stop();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'one death, one kill');
  assert.equal(R.warns.filter((w) => /own probes 2 times/.test(w)).length, 0, 'and no repeat-kill warning from one death');
});

test('a sweep READ whose node the tick sees Dead reaches the reply rate as a missed READ (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN });
  await R.step();
  setStatus(n7, NodeStatus.Dead);
  await R.step();
  R.h.stop();
  assert.deepEqual(R.results.map((r) => [r[0], r[1], r[3]]), [[7, false, 'read']], 'the read subset sees the kill');
  assert.ok(R.lines.some((l) => /did NOT answer its probe \(1st consecutive miss — the node has since been marked Dead\) — sweep routed read$/.test(l)));
});

test('each miss line names the exact lane and frame, and a NoOp launch failure is not a read fallback (v0.71.0)', async () => {
  // Verification lane, read frame, settled on the death.
  const n9 = node(9, { stats: { lastSeen: T - 300 * MIN } as never });
  let due = true;
  const V = await rig({ nodes: [node(1, { isController: true }), n9], staleMs: 0, verify: () => (due ? [{ id: 9, first: true }] : []) });
  await V.step(); due = false;
  setStatus(n9, NodeStatus.Dead);
  await V.step();
  V.h.stop();
  assert.ok(V.lines.some((l) => /node 9 did NOT answer its probe \(1st consecutive miss — the node has since been marked Dead\) — verification routed read$/.test(l)),
    JSON.stringify(V.lines));
  // Sweep lane, NoOp frame, judged at the grace.
  const n8 = node(8, { stats: { lastSeen: T - 300 * MIN } as never });
  const N = await rig({ nodes: [node(1, { isController: true }), n8], staleMs: 240 * MIN, canRead: () => false });
  await N.step(3);
  N.h.stop();
  assert.ok(N.lines.some((l) => /node 8 did NOT answer its probe \(1st consecutive miss, lastSeen did not advance\) — sweep NoOp ping$/.test(l)),
    JSON.stringify(N.lines));
  // A NoOp that could not be sent is refunded, but it is not a failed READ.
  const n6 = node(6, { stats: { lastSeen: T - 300 * MIN } as never });
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  const lines: string[] = [];
  const h = startAutoPing({
    nodes: () => [node(1, { isController: true }), n6], controller: () => null, ready: () => true,
    ping: async () => {}, probe: async () => ({ ok: false, message: 'no ping button' }),
    probeRead: async () => {}, canRead: () => false,
    log: () => {}, log2: Object.assign((m: string) => { lines.push(m); }, { warn: (m: string) => { lines.push(m); } }),
    config: cfg({ staleMs: 240 * MIN }), tickMs: 1_000_000, now: () => clock,
  });
  clock = T + BOOT_WINDOW_MS; h.tick(); await new Promise((r) => setImmediate(r));
  h.stop();
  assert.ok(lines.some((l) => /node 6 could not be probed/.test(l)), 'fixture guard: the NoOp launch failed');
  assert.ok(!lines.some((l) => /a routed read could not be sent/.test(l)), 'and it is not reported as a read that could not be sent');
});

test('a ladder READ settled on a later death is labelled a routed read, not a NoOp (v0.71.0)', async () => {
  const n7 = dead(7, { stats: { lastSeen: T - 300 * MIN } as never });
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 0 });
  for (let i = 0; i < 20 && R.of('read', 7).length === 0; i++) await R.step();
  assert.equal(R.of('read', 7).length, 1, 'fixture guard: the ladder read went out');
  setStatus(n7, NodeStatus.Alive);                                    // seen Alive before its answer lands…
  await R.step();
  setStatus(n7, NodeStatus.Dead);                                     // …and Dead again with the read unanswered
  await R.step();
  R.h.stop();
  assert.ok(R.lines.some((l) => /node 7 did NOT answer its probe \(\d+(st|nd|rd|th) consecutive miss — the node has since been marked Dead\) — ladder routed read$/.test(l)),
    JSON.stringify(R.lines.filter((l) => /did NOT answer/.test(l))));
});

test('a between-tick kill is still judged when the node is Dead AGAIN at the tick on a later death (v0.71.0)', async () => {
  // The first death cleared (the feed hands it over); a second, unrelated one
  // left the node Dead at the tick. trackEpisodes reads the lastSeen the revival
  // moved and books nothing, so only the feed can book the first death.
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN, canRead: () => false,
    deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  feed = [{ nodeId: 7, at: sentAt + 400, seen: T - 300 * MIN }];     // death 1, unanswered, then cleared
  setSeen(n7, sentAt + 20_000);                                       // revived by its own report
  setStatus(n7, NodeStatus.Dead);                                     // death 2, on something else
  await R.step();
  setStatus(n7, NodeStatus.Alive);
  await R.step(3);
  R.h.stop();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'our kill is counted');
  assert.deepEqual(R.results.map((r) => [r[0], r[1], r[3]]), [[7, false, 'ping']], 'the NoOp is a miss, never credited as answered');
  assert.ok(R.lines.some((l) => /went Dead 0s after our sweep NoOp ping and came back, and is Dead again at this tick on something later/.test(l)),
    JSON.stringify(R.lines.filter((l) => /went Dead/.test(l))));
});

test('a between-tick VERIFICATION NoOp kill stays out of the reply rate, and the miss streak carries into the next miss (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  let due = true;
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 0, canRead: () => false,
    verify: () => (due ? [{ id: 7, first: true }] : []), deaths: () => { const f = feed; feed = []; return f; } });
  await R.step(); due = false;
  const sentAt = R.at() - MIN;
  feed = [{ nodeId: 7, at: sentAt + 400, seen: null }];                // no lastSeen on record: nothing answered it
  setSeen(n7, sentAt + 20_000);
  await R.step();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'a death with no lastSeen on record is still blamed');
  assert.deepEqual(R.results, [], 'a verification probe is symptom-correlated: never in the comparable rate');
  // A later judged miss continues the streak the between-tick miss started.
  R.set(R.at() + 16 * MIN);
  due = true; await R.step(); due = false;
  await R.step(3);
  R.h.stop();
  assert.ok(R.lines.some((l) => /node 7 did NOT answer its probe \(2nd consecutive miss, lastSeen did not advance\)/.test(l)),
    JSON.stringify(R.lines.filter((l) => /did NOT answer/.test(l))));
});

test('a between-tick READ kill revived long after the death is a MISS — something else revived it, and the Get was never delivered (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN, deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  feed = [{ nodeId: 7, at: sentAt + 400, seen: T - 300 * MIN, clearedAt: sentAt + 25_000 }];
  setSeen(n7, sentAt + 25_000);                                       // the outlet's own power report
  await R.step(3);
  R.h.stop();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'still our kill');
  assert.deepEqual(R.results.map((r) => [r[0], r[1], r[3]]), [[7, false, 'read']], 'booked a missed READ, never credited as answered');
  assert.ok(R.lines.some((l) => /revived 25s later, too late to be the Get's own Report, so that was not an answer\) — no sweep or verification probe for 15m — sweep routed read$/.test(l)),
    JSON.stringify(R.lines.filter((l) => /did NOT answer/.test(l))));
});

test('a between-tick death is not blamed when the node\'s statistics feed is not live, and one read is never booked twice (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN, deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  feed = [{ nodeId: 7, at: sentAt + 40_000, seen: null, clearedAt: sentAt + 40_300, feedLive: false }];
  await R.step();
  assert.equal(R.snap(7)?.probeKills24h ?? 0, 0, 'with no live statistics feed, an answered probe cannot be told from an unanswered one');
  R.h.stop();
  // Two cleared deaths inside one read's grace, `seen` frozen before it: ONE kill.
  const m7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed2: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R2 = await rig({ nodes: [node(1, { isController: true }), m7], staleMs: 240 * MIN, deaths: () => { const f = feed2; feed2 = []; return f; } });
  await R2.step();
  const s2 = R2.at() - MIN;
  feed2 = [
    { nodeId: 7, at: s2 + 400, seen: T - 300 * MIN, clearedAt: s2 + 700 },
    { nodeId: 7, at: s2 + 30_000, seen: T - 300 * MIN, clearedAt: s2 + 30_300 },
  ];
  await R2.step();
  R2.h.stop();
  assert.equal(R2.snap(7)?.probeKills24h, 1, 'one read, one kill');
  assert.equal(R2.warns.filter((w) => /own probes 2 times/.test(w)).length, 0);
});

test('a read the feed already booked is not booked again when a later tick sees the node Dead with it unanswered (v0.71.0)', async () => {
  const n7 = node(7, { stats: { lastSeen: T - 300 * MIN } as never });
  let feed: { nodeId: number; at: number; seen?: number | null; clearedAt?: number | null; feedLive?: boolean }[] = [];
  const R = await rig({ nodes: [node(1, { isController: true }), n7], staleMs: 240 * MIN, deaths: () => { const f = feed; feed = []; return f; } });
  await R.step();
  const sentAt = R.at() - MIN;
  feed = [{ nodeId: 7, at: sentAt + 400, seen: T - 300 * MIN, clearedAt: sentAt + 700 }];   // booked, left pending
  await R.step();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'fixture guard: the feed booked it');
  setStatus(n7, NodeStatus.Dead);                                     // the roster, whose lastSeen lags, sees it Dead
  await R.step();
  R.h.stop();
  assert.equal(R.snap(7)?.probeKills24h, 1, 'one read, one kill');
});

/* ── v0.72.0: the owner's pause ───────────────────────────────────────────
 * One switch for every autonomous write. It sends nothing on any lane, and it
 * ranks BELOW the suppressions that raise the degraded alarm.
 */

test('a pause stops every lane — the dead ladder, the sweep and verification (v0.72.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const live = tick(s, nodes, T + 30 * MIN, { config: staleCfg(), verifyDue: [105] });
  assert.deepEqual(live.ping, [7], 'precondition: the ladder would probe node 7 right now');
  assert.ok(live.stale.length > 0 && live.verify.length > 0, 'precondition: the sweep and verification lanes have work');
  const d = tick(s, nodes, T + 30 * MIN, { config: staleCfg(), verifyDue: [105], paused: true });
  assert.equal(d.suppressed, 'paused');
  assert.deepEqual([d.ping, d.read, d.stale, d.verify], [[], [], [], []], 'nothing is sent');
  // Inside the boot window, where the ladder alone is released, too.
  const b = tick(createAutoPingState(), nodes, T, { booting: true, bootDeadLane: true, paused: true });
  assert.equal(b.suppressed, 'paused');
  assert.deepEqual(b.ping, []);
});

test('a pause follows write-actions-off, rebuild, RF-off, no-capability-data and storm (v0.72.0)', () => {
  const nodes = mesh(20, [dead(7)]);
  const at = (over: Parameters<typeof tick>[3], ns = nodes) => tick(createAutoPingState(), ns, T, { paused: true, ...over }).suppressed;
  assert.equal(at({ config: cfg({ writeActions: false }) }), 'write-actions-off');
  assert.equal(at({ controller: { isRebuildingRoutes: true } as never }), 'rebuilding-routes');
  assert.equal(at({ rfOffSince: T - 1000 }), 'controller-rf-off');
  const blind = [node(1, { isController: true }), node(9, { isListening: null })];
  assert.equal(at({}, blind), 'no-capability-data', 'a pause must not hide the add-on going blind');
  const storm = mesh(8, [dead(20), dead(21), dead(22), dead(23)]);
  assert.equal(at({}, storm), 'storm', 'nor a storm');
  assert.equal(at({}), 'paused');
});

test('the runner reads the pause: nothing new is sent, and a probe already out is still judged (v0.72.0)', async () => {
  const { startAutoPing, BOOT_WINDOW_MS } = await import('../src/zwave/autoPing');
  let clock = T;
  let paused = false;
  const probed: number[] = [];
  const logs: string[] = [];
  const n7 = node(7, { stats: { lastSeen: T } as never });
  const nodes = [node(1, { isController: true }), n7];
  const h = startAutoPing({
    nodes: () => nodes, controller: () => null, ready: () => true,
    ping: async () => {}, probe: async (n) => { probed.push(n); }, log: (_s, _n, m) => { logs.push(m); },
    config: cfg({ staleMs: 60 * MIN }), tickMs: 1_000_000, now: () => clock,
    paused: () => paused,
  });
  clock = T + BOOT_WINDOW_MS + MIN;
  h.tick();
  assert.deepEqual(probed, [7], 'precondition: the sweep probes it');
  paused = true;
  setSeen(n7, clock + 2_000); // its answer lands during the pause
  clock += 2 * MIN; // past ANSWER_GRACE_MS, so the probe is mature
  h.tick();
  assert.equal(h.snapshot().suppressed, 'paused');
  assert.deepEqual(probed, [7], 'nothing new is sent');
  const st = h.snapshot().nodes.find((n) => n.nodeId === 7);
  assert.equal(st?.pending ?? 0, 0, 'the probe already out was judged');
  assert.equal(st?.missStreak ?? 0, 0, 'and judged answered');
  clock += 2 * 3_600_000;
  h.tick();
  assert.deepEqual(probed, [7], 'hours later, still nothing');
  paused = false;
  clock += MIN;
  h.tick();
  assert.deepEqual(probed, [7, 7], 'resumed: the sweep sends again at the next tick');
  h.stop();
});

test('auto-ping stands down while the operator waits on a one-node rebuild or removal (v0.72.0)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  const live = tick(s, nodes, T + 30 * MIN, { config: staleCfg(), verifyDue: [105] });
  assert.deepEqual(live.ping, [7], 'precondition');
  const d = tick(s, nodes, T + 30 * MIN, { config: staleCfg(), verifyDue: [105], operatorBusy: true });
  assert.equal(d.suppressed, 'operator-action');
  assert.deepEqual([d.ping, d.read, d.stale, d.verify], [[], [], [], []]);
  const b = tick(createAutoPingState(), nodes, T, { booting: true, bootDeadLane: true, operatorBusy: true });
  assert.equal(b.suppressed, 'boot-window', 'reported as the boot window while the mesh settles, like a rebuild');
  assert.deepEqual(b.ping, []);
});

test('operator-action ranks below storm and no-capability-data, and above the pause (v0.72.0 review)', () => {
  const at = (over: Parameters<typeof tick>[3], ns: NodeSnapshot[]) => tick(createAutoPingState(), ns, T, { operatorBusy: true, ...over }).suppressed;
  const storm = mesh(8, [dead(20), dead(21), dead(22), dead(23)]);
  assert.equal(at({}, storm), 'storm', 'a chain of heals must not hide a storm');
  const blind = [node(1, { isController: true }), node(9, { isListening: null })];
  assert.equal(at({}, blind), 'no-capability-data');
  assert.equal(at({ paused: true }, mesh(20)), 'operator-action');
});

test('while paused, a node that already spent its budget is still announced as given up — escalation sends nothing (v0.72.0 review)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(7)]);
  tick(s, nodes, T);
  s.attempts.set(7, 3);                 // the ladder's whole budget, already spent
  const d = tick(s, nodes, T + 3 * 3_600_000, { paused: true });
  assert.equal(d.suppressed, 'paused');
  assert.deepEqual(d.ping, [], 'still nothing sent');
  assert.deepEqual(d.gaveUp, [7], 'but the summons is not held for the length of the pause');
});

test('paused, a node whose budget is spent and whose last step is an owed read still gives up (second review)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(49)]);
  tick(s, nodes, T);
  s.attempts.set(49, 3);
  s.readOwed.add(49);
  const live = tick(s, nodes, T + 3 * 3_600_000, { canRead: () => true });
  assert.deepEqual(live.read, [49], 'precondition: unpaused, the read goes first');
  const d = tick(s, nodes, T + 3 * 3_600_000, { canRead: () => true, paused: true });
  assert.deepEqual([d.read, d.gaveUp], [[], [49]], 'paused, the read cannot go, so the summons is not held');
});

test('paused, a spent node is not given up while a probe to it still awaits its answer (third review)', () => {
  const s = createAutoPingState();
  const nodes = mesh(20, [dead(49)]);
  tick(s, nodes, T);
  s.attempts.set(49, 3);
  s.readOwed.add(49);
  s.awaitingAnswer.set(49, [{ at: T + 3 * 3_600_000 - 10_000, cls: 'echo-only', lane: 'manual' } as never]);
  const d = tick(s, nodes, T + 3 * 3_600_000, { canRead: () => true, paused: true });
  assert.deepEqual(d.gaveUp, [], 'its answer grace runs first');
});
