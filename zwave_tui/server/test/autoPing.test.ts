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
  pendProbe,
  unpendProbe,
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
  assert.ok(probe!.includes(`unheard for ${Math.round(silence)}m`),
    `measured silence (~${silence}m) must appear, got: ${probe}`);
  assert.ok(probe!.includes('threshold 240m'), 'the threshold is context, labelled as such');
  assert.ok(!/unheard for 240m/.test(probe!), 'the measured value must not equal-by-construction the threshold');
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
  // The service call cannot tell us: HA's ping button awaits async_ping(), which
  // returns a boolean and raises nothing on silence. lastSeen is the only
  // observable that separates "the probe got through" from "we sent a packet
  // into the dark".
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T + 5_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: true, misses: 0, self: false, lane: 'sweep' }]);
  assert.equal(s.awaitingAnswer.size, 0, 'and the pending entry is cleared');
});

test('a probe whose node stayed silent is judged UNANSWERED — the signal that never existed', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false, misses: 1, self: false, lane: 'sweep' }]);
});

test('a node that has NEVER been heard from is unanswered, not silently skipped', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: null } as never })], T + 120_000);
  assert.deepEqual(out, [{ nodeId: 7, answered: false, misses: 1, self: false, lane: 'sweep' }]);
});

test('a probe is NOT judged before its grace period — no verdict on an in-flight round trip', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
  assert.deepEqual(judgeProbeAnswers(s, [node(7)], T + 10_000), []);
  assert.equal(s.awaitingAnswer.size, 1, 'still pending, still judgeable later');
});

test('a node that vanished from the roster is judged NEITHER way', () => {
  // A roster gap is not evidence of a failed probe, and calling it one would
  // manufacture exactly the false alarm this signal exists to avoid.
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
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
    s.awaitingAnswer.set(7, [{ at: T + i * 1000, self: false, lane: 'sweep' }]);
    return judgeProbeAnswers(s, silent(T - 60_000), T + i * 1000 + 120_000)[0].misses;
  };
  assert.equal(miss(1), 1, 'first miss');
  assert.equal(miss(2), 2, 'second in a row');
  assert.equal(miss(3), 3, 'third in a row');

  // One answer wipes the streak — "3rd miss" must always mean three in a row,
  // never three since the beginning of time.
  s.awaitingAnswer.set(7, [{ at: T + 10_000, self: false, lane: 'sweep' }]);
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
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
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
    onProbeResult: (id, answered, self) => { reported.push({ id, answered, self }); },
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
  assert.match(first, /2 owed/, 'and states how many nodes are dividing the queue');

  lines.length = 0;
  clock += 140_000; // two ticks later
  h.tick();
  const second = lines.find((l) => /verification probe/.test(l))!;
  assert.match(second, /\+140s/, `the measured gap must appear, got: ${second}`);
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
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }, { at: T + 60_000, self: false, lane: 'sweep' }, { at: T + 120_000, self: false, lane: 'sweep' }, { at: T + 180_000, self: false, lane: 'sweep' }, { at: T + 240_000, self: false, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 240_000 + 120_000);
  assert.deepEqual(out.map((o) => o.misses), [1, 2, 3, 4, 5], 'five probes, five judgments, one honest streak');
});

test('young probes stay pending while matured ones are judged (v0.40)', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }, { at: T + 60_000, self: false, lane: 'sweep' }]);
  const out = judgeProbeAnswers(s, [node(7, { stats: { lastSeen: T - 60_000 } as never })], T + 100_000);
  assert.equal(out.length, 1, 'only the matured probe is judged');
  assert.deepEqual(s.awaitingAnswer.get(7), [{ at: T + 60_000, self: false, lane: 'sweep' }], 'the in-flight probe is still pending');
});

test('an answered probe records what OUR probe put on the record (v0.40)', () => {
  const s = createAutoPingState();
  s.awaitingAnswer.set(7, [{ at: T, self: false, lane: 'sweep' }]);
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
    onProbeResult: (id, ok, self) => { results.push({ id, ok, self }); },
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
  pendProbe(s, 9, T, 'sweep', true);
  pendProbe(s, 9, T + 60_000, 'sweep', false);
  unpendProbe(s, 9, T + 60_000);
  assert.deepEqual(s.awaitingAnswer.get(9), [{ at: T, self: true, lane: 'sweep' }],
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

