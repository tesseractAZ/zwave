/**
 * ZwaveData across reconnect churn — the class-level tests the v0.26
 * assessment found missing (renderHonesty stubs onReady as a no-op, so none of
 * this was provable before): the displayed-lastSeen replay guard, the
 * connection-epoch double-subscribe guard, and the history dirty gate.
 *
 * The fake HaWsClient below is deliberately dumb: canned result per command
 * type, captured event handlers per subscription type so tests push events,
 * and a scriptable onReady so a test can BE the reconnect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZwaveData, type ZwaveData } from '../src/zwave/zwaveData';
import { bandOf, N_BANDS } from '../src/zwave/baselines';
import type { OutcomeStore } from '../src/zwave/outcomes';
import { NodeStatus, type NodeSnapshot } from '../src/types';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';
import { mockServer } from './_driverWsMock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time');
    await sleep(20);
  }
}

const ENTRY = 'entry-1';
const HOME = 3586281591;
/** Lets one test simulate a stick swap / NVM restore — the ONLY thing that
 *  legitimately changes home_id. Reset to null in that test's finally. */
let homeOverride: number | null = null;
/** Set to an error message to make the roster poll fail — a config-entry reload
 *  is the case that matters (v0.65.0). Reset to null in the test's finally. */
let failNetworkStatus: string | null = null;
/** Roster the fake controller reports. Mutable so a test can make a node
 *  LEAVE the network — the eviction path cannot be reached otherwise. */
const NODE7 = { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false };
let rosterNodes: Array<Record<string, unknown>> = [NODE7];
const DEV_ID = 'dev-7';
/** Override for the entity registry (v0.70.0). null = the default single switch. */
let entityRegistry: Array<Record<string, unknown>> | null = null;
/** More rows for get_states (v0.72.0) — the owner's pause toggle. Reset in finally. */
let extraStates: Array<Record<string, unknown>> = [];

function cannedResult(cmd: Record<string, unknown>): unknown {
  switch (cmd.type) {
    case 'config_entries/get':
      return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
    case 'config/device_registry/list':
      return [{ id: DEV_ID, identifiers: [['zwave_js', `${HOME}-7`]], name: 'Node Seven', manufacturer: 'T', model: 'M', area_id: null }];
    case 'config/entity_registry/list':
      return entityRegistry ?? [{ entity_id: 'switch.node_seven', device_id: DEV_ID, disabled_by: null, platform: 'zwave_js', original_name: 'Node Seven Switch' }];
    case 'get_states':
      return [{ entity_id: 'switch.node_seven', state: 'on', attributes: {} }, ...extraStates];
    case 'zwave_js/network_status':
      // A zwave_js config-entry reload (driver restart, add-on update,
      // integration reload) fails exactly this call while it is out (v0.65.0).
      if (failNetworkStatus != null) throw new Error(failNetworkStatus);
      // The roster is built from controller.nodes (not the registry) — the
      // registry only enriches names/entities. Status 4 = Alive.
      return {
        client: { server_version: 't' },
        controller: {
          home_id: homeOverride ?? HOME, own_node_id: 1,
          nodes: rosterNodes,
        },
      };
    default:
      return null;
  }
}

interface FakeHa extends HaWsClient {
  /** Captured live event handlers, keyed by a best-guess feed name. */
  handlers: Map<string, HaEventHandler[]>;
  /** Toggleable connection state, so a test can simulate an OUTAGE without a
   *  reconnect (the idempotency sets survive one; ready() must not). */
  isReady: boolean;
  /** Count of subscriptions ever made, by feed name. */
  subCount: Map<string, number>;
  /** Subscriptions currently LIVE (created and not unsubscribed), by feed. */
  live: Map<string, number>;
  /** Fire onReady callbacks — i.e. simulate (re)connection. */
  fireReady(): void;
  /** Delay every unsubscribe by this long (v0.65.0 review). Production releases
   *  a handle with a WS round trip, and a re-arm releases ~77 of them — so the
   *  roster poll and a reconnect can both land INSIDE the release loop. An
   *  instant fake unsubscribe resolves on a microtask and no timer can
   *  interleave with it, which hides that whole class of race from the tests. */
  unsubDelayMs: number;
  /** Gate: when set, subscribe() for this feed parks until released. Holds
   *  EVERY parked resolver — two runs can be parked at once, and the test must
   *  release both (a last-writer-wins slot silently strands run #1, which
   *  would make even an unguarded double-subscribe invisible). */
  gate: { feed: string | null; releases: Array<() => void>; parked: (() => void) | null };
}

function feedNameOf(cmd: Record<string, unknown>): string {
  if (cmd.type === 'subscribe_events') return String(cmd.event_type ?? 'subscribe_events');
  return String(cmd.type);
}

function fakeHa(): FakeHa {
  const readyCbs: Array<() => void> = [];
  const handlers = new Map<string, HaEventHandler[]>();
  const subCount = new Map<string, number>();
  const live = new Map<string, number>();
  const gate: FakeHa['gate'] = { feed: null, releases: [], parked: null };
  const client: FakeHa = {
    handlers, subCount, live, gate,
    isReady: true,
    unsubDelayMs: 0,
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => { /* the test fires ready explicitly */ },
    stop: () => {},
    reconnect: () => { /* a real client would drop + redial; tests fireReady() */ },
    ready: () => client.isReady,
    whenReady: () => Promise.resolve(),
    onReady: (cb: () => void) => { readyCbs.push(cb); },
    lastError: () => null,
    send: async (cmd: Record<string, unknown>) => cannedResult(cmd),
    subscribe: async (cmd: Record<string, unknown>, onEvent: HaEventHandler): Promise<HaSubscription> => {
      const feed = feedNameOf(cmd);
      if (gate.feed === feed) {
        await new Promise<void>((res) => {
          gate.releases.push(res);
          gate.parked?.();
        });
      }
      handlers.set(feed, [...(handlers.get(feed) ?? []), onEvent]);
      subCount.set(feed, (subCount.get(feed) ?? 0) + 1);
      live.set(feed, (live.get(feed) ?? 0) + 1);
      // A released subscription stops DELIVERING, not just counting (v0.65.0
      // review). Decrementing `live` alone made `handlers` a list of every
      // callback ever created, so a test that fires an event through it could
      // not tell a released feed from a live one — and duplicate delivery, the
      // actual cost of a zombie feed, was unmeasurable. Idempotent: a
      // double-release (the supersede path releases its own handle, and the
      // caller's stand-down walks the same list) must not under-count.
      let released = false;
      return {
        subscriptionId: subCount.size,
        unsubscribe: async () => {
          if (released) return;
          released = true;
          if (client.unsubDelayMs > 0) await sleep(client.unsubDelayMs);
          live.set(feed, Math.max(0, (live.get(feed) ?? 0) - 1));
          handlers.set(feed, (handlers.get(feed) ?? []).filter((h) => h !== onEvent));
        },
      };
    },
  } as unknown as FakeHa;
  return client;
}

function statsEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: {
      source: 'node', event: 'statistics updated', nodeId: 7,
      commands_tx: 10, commands_rx: 9, commands_dropped_tx: 0, commands_dropped_rx: 0,
      timeout_response: 1, rtt: 25, rssi: -62, ...over,
    },
  };
}

function pushStats(ha: FakeHa, ev: Record<string, unknown>): void {
  for (const h of ha.handlers.get('zwave_js/subscribe_node_statistics') ?? []) h(ev as never);
}

async function bootedZwaveData(ha: FakeHa, extra: Record<string, unknown> = {}): Promise<ZwaveData> {
  const zd = createZwaveData({
    client: ha, entryId: ENTRY, refreshMs: 60_000, routePollMs: 60_000,
    historyPath: null, evidencePath: null, driverWsUrl: null,
    log: () => {}, ...extra,
  } as never);
  zd.start();
  ha.fireReady();
  await waitFor(() => (ha.subCount.get('zwave_js/subscribe_node_statistics') ?? 0) >= 1);
  return zd;
}

test('displayed lastSeen: a subscribe REPLAY (no counter movement) does not fabricate freshness', async () => {
  const ha = fakeHa();
  // Fast poll: snapshot() serves the roster built at the LAST refresh tick, so
  // the assertions below need the loop turning over quickly.
  const zd = await bootedZwaveData(ha, { refreshMs: 80, routePollMs: 160 });
  try {
    // First delivery — no counter cache yet, so NO arrival stamp (the driver's
    // own lastSeen covers boot; "no data yet" beats a fabricated "just now").
    pushStats(ha, statsEvent());
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7 && n.stats.commandsTX === 10));
    const first = zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.stats.lastSeen;
    assert.equal(first, null, 'first delivery must not stamp arrival time');

    // Real traffic: counters move → stamped.
    pushStats(ha, statsEvent({ commands_tx: 11 }));
    await waitFor(() => zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.stats.lastSeen != null);
    const stamped = zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.stats.lastSeen!;

    // Reconnect replay: identical counters redelivered → stamp CARRIED, not
    // refreshed. (Pre-v0.26 this read "seen 0s ago" for all 39 nodes.)
    await sleep(60);
    ha.fireReady(); // reconnect: re-subscribe fires, snapshot replays
    await waitFor(() => (ha.subCount.get('zwave_js/subscribe_node_statistics') ?? 0) >= 2);
    pushStats(ha, statsEvent({ commands_tx: 11 }));
    await sleep(60);
    const after = zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.stats.lastSeen;
    assert.equal(after, stamped, `replay refreshed lastSeen (${after} vs ${stamped})`);
  } finally {
    zd.stop();
  }
});

test('epoch guard: a subscribe run spanning a reconnect cannot double-subscribe the activity feed', async () => {
  const ha = fakeHa();
  // Park the FIRST run inside the activity subscribe, exactly where a slow HA
  // would hold it while the socket dies.
  ha.gate.feed = 'state_changed';
  const parked = new Promise<void>((res) => { ha.gate.parked = res; });
  const zd = await bootedZwaveData(ha);
  try {
    await parked; // run #1 is now mid-flight inside subscribeActivityEvents
    ha.fireReady(); // the reconnect: run #2 starts under a new epoch
    // Run #2 must also park (same gate) — release both in close succession.
    // Run #2 must also reach and park at the same gate before we release —
    // otherwise it hasn't yet been exposed to the double-subscribe hazard.
    await waitFor(() => ha.gate.releases.length >= 2);
    ha.gate.feed = null; // stop gating future calls
    for (const r of ha.gate.releases.splice(0)) r();
    await sleep(150);
    // THE INVARIANT: exactly ONE LIVE activity feed. Both runs create a
    // subscription (subCount 2 — unavoidable, the second resolves after the
    // reconnect), but the superseded one must be RELEASED. Left live, it costs
    // HA a fanout of every state change in the whole house for the life of the
    // socket, and double-delivers every activity row until the next disconnect.
    assert.equal(ha.subCount.get('state_changed') ?? 0, 2, 'setup: both runs subscribed');
    assert.equal(
      ha.live.get('state_changed') ?? 0, 1,
      'the superseded run left a ZOMBIE activity subscription live beside the new one',
    );
    // ...and the same must hold for the feeds the FIRST epoch guard did not
    // cover: the controller stats feed and every per-node feed. The v0.26
    // review measured ctrl=2 and two duplicates per node here, unreleasable
    // because those subscribe() handles were discarded.
    assert.equal(
      ha.live.get('zwave_js/subscribe_controller_statistics') ?? 0, 1,
      'the controller statistics feed double-subscribed across the reconnect',
    );
    for (const feed of ['zwave_js/subscribe_node_statistics', 'zwave_js/subscribe_node_status']) {
      assert.ok(
        (ha.live.get(feed) ?? 0) <= 1,
        `${feed} has ${ha.live.get(feed)} live subscriptions for one node — duplicated across the reconnect`,
      );
    }
  } finally {
    zd.stop();
  }
});

test('history dirty gate: an unchanged ring is not rewritten on the flush tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-hist-'));
  const path = join(dir, 'history.json');
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { historyPath: path, historyFlushMs: 80 });
  try {
    // One real sample → dirty → the next tick writes the file.
    pushStats(ha, statsEvent());
    pushStats(ha, statsEvent({ commands_tx: 11 })); // moved ⇒ history sample recorded
    await waitFor(() => existsSync(path), 4000);
    const m1 = statSync(path).mtimeMs;
    // Three idle ticks: nothing new sampled ⇒ the file must not be rewritten.
    await sleep(300);
    const m2 = statSync(path).mtimeMs;
    assert.equal(m2, m1, 'flush rewrote an unchanged history ring (SD-wear regression)');
    // And the gate re-opens on new data.
    pushStats(ha, statsEvent({ commands_tx: 25, rssi: -70 }));
    await waitFor(() => statSync(path).mtimeMs > m1, 4000);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DARK S2 log lane records UNKNOWN, not a fabricated zero (v0.26 review)', async () => {
  // With no driver_ws_url the lane can never listen, so every sample must
  // carry dS2Resync = null. Recording 0 would let "switched off" read as
  // "no resyncs happened", which is what let a storm-stop mid-episode score
  // an `improved` outcome the action never earned.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-s2-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), driverWsUrl: null,
  });
  try {
    pushStats(ha, statsEvent());
    pushStats(ha, statsEvent({ commands_tx: 11 }));
    await waitFor(() => zd.evidence(7).length >= 1, 5000);
    const samples = zd.evidence(7);
    assert.ok(samples.length >= 1, 'no evidence samples recorded');
    for (const s of samples) {
      assert.equal(s.dS2Resync, null,
        `a sample recorded dS2Resync=${s.dS2Resync} while the S2 lane was never listening`);
    }
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── v0.33: ackEvent — the RED-latch release at the data layer ──────────── */

test('ackEvent releases exactly one error latch, refuses non-errors, repeats, and ghosts', async () => {
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha);
  try {
    // Produce one error and one info event through the real path.
    zd.logAction('error', 7, 'boom');
    zd.logAction('info', 7, 'fine');
    const evs = zd.events();
    const err = evs.find((e) => e.severity === 'error' && e.text === 'boom')!;
    const info = evs.find((e) => e.severity === 'info' && e.text === 'fine')!;
    assert.ok(err && info, 'both events must be on the ring');
    assert.equal(err.acked, undefined, 'an error arrives latched (unacked)');

    assert.equal(zd.ackEvent(info.seq), false, 'a non-error has no latch to release');
    assert.equal(info.acked, undefined);

    assert.equal(zd.ackEvent(err.seq), true, 'the first ack releases the latch');
    assert.equal(err.acked, true);
    assert.equal(zd.ackEvent(err.seq), false, 're-acking an acked error is refused');

    assert.equal(zd.ackEvent(999_999_999), false, 'a seq not on the ring is refused');
  } finally {
    zd.stop();
  }
});

test('feed badges go DARK when the socket drops — a subscription is not liveness (v0.35 review)', async () => {
  // statusSubbed/statsSubbedNodes mean "a subscribe call once succeeded" and
  // are cleared only by the NEXT epoch's resubscribe run — through an outage
  // they stay populated. Unguarded, the EVIDENCE badges would glow green for
  // the entire duration of the largest monitoring hole there is, and the
  // MONITORING HOLE line (which needs both feeds down) could never fire.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-cov-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), driverWsUrl: null,
  });
  try {
    pushStats(ha, statsEvent());
    await waitFor(() => zd.evidenceCoverage(7) != null, 5000);
    const up = zd.evidenceCoverage(7)!;
    assert.equal(up.statsFeedLive, true, 'subscribed + socket up = live');

    ha.isReady = false; // the outage: socket down, idempotency sets untouched
    const down = zd.evidenceCoverage(7)!;
    assert.equal(down.statusFeedLive, false, 'status badge must go dark with the socket');
    assert.equal(down.statsFeedLive, false, 'stats badge must go dark with the socket');

    ha.isReady = true; // service restored — same sets, badges return
    const back = zd.evidenceCoverage(7)!;
    assert.equal(back.statsFeedLive, true, 'recovery needs no resubscribe to read live again');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── v0.36: the verification-probe queue ───────────────────────────────────── */

test('drainVerifyRequests hands out ONE node per tick, spaced, and stops after the burst', async () => {
  // Three probes is exactly the verifier's evidence floor; they must land as
  // three separate readings across the window, not three packets in a second.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-verify-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const q = zd as unknown as { requestVerification: (n: number) => void };
    q.requestVerification(7);
    const t0 = 1_800_000_000_000;
    assert.deepEqual(zd.drainVerifyRequests(t0).map((e) => e.id), [7], 'first probe is due immediately');
    assert.deepEqual(zd.drainVerifyRequests(t0 + 1_000), [], 'the next is spaced, not back-to-back');
    for (let i = 1; i <= 4; i++) {
      assert.deepEqual(zd.drainVerifyRequests(t0 + i * 80_000).map((e) => e.id), [7], `probe ${i + 1} of the burst`);
    }
    assert.deepEqual(zd.drainVerifyRequests(t0 + 5 * 80_000), [],
      'burst exhausted at five — it does not probe forever');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated requests CAP the outstanding budget — a flapping symptom cannot stack bursts', async () => {
  // Top-up is intended: a second boundary (the symptom going absent) genuinely
  // wants a fresh burst for the after-window. What must never happen is
  // ACCUMULATION — a symptom that flaps ten times must not owe thirty probes.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-verify2-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const q = zd as unknown as { requestVerification: (n: number) => void };
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 10; i++) q.requestVerification(7); // ten flaps, back to back
    let fired = 0;
    for (let i = 0; i < 40; i++) if (zd.drainVerifyRequests(t0 + i * 80_000).length) fired++;
    assert.equal(fired, 5, `ten requests must still owe ONE burst, not fifty probes — fired ${fired}`);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no engine configured the queue is inert — no probes requested at all', async () => {
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 80, routePollMs: 120, driverWsUrl: null });
  try {
    const q = zd as unknown as { requestVerification: (n: number) => void };
    q.requestVerification(7);
    assert.deepEqual(zd.drainVerifyRequests(Date.now()), [],
      'no outcome ledger means nothing to verify — and nothing to write to the mesh for');
  } finally {
    zd.stop();
  }
});

test('a verification burst carries MARGIN over the evidence floor (v0.37.2)', async () => {
  // v0.36 used exactly MIN_OBS (3) on the reasoning that the floor is "no more
  // traffic than required". Measured in production that leaves no room for the
  // ordinary: three readings must all land, be sampled, and carry a non-null
  // RTT inside one 300s window, from a burst already spanning ~240s at the
  // effective 120s tick-rounded spacing. One lost probe — ~2% of probes on this
  // mesh — and the window holds 2 of 3 and fails closed.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-burst-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const q = zd as unknown as { requestVerification: (n: number) => void };
    q.requestVerification(7);
    const t0 = 1_800_000_000_000;
    let fired = 0;
    for (let i = 0; i < 40; i++) if (zd.drainVerifyRequests(t0 + i * 80_000).length) fired++;
    assert.ok(fired >= 4, `a burst must exceed the 3-reading floor, got ${fired}`);
    assert.equal(fired, 5, 'five: margin for one lost probe plus tick jitter');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a burst SPANS LESS than the window it must fill — the check that was missing twice', async () => {
  // The defect this pins, stated as arithmetic so it survives any later change
  // to the constants: a burst is useless if it takes longer to deliver than the
  // window that measures it. v0.36 chose the count against MIN_OBS and never
  // checked the span against WINDOW_MS; at the then-effective 120s spacing a
  // 5-probe burst ran 480s against a 300s window, so probes 1-2 aged out before
  // 4-5 arrived and the window never held more than two or three readings.
  // Adding probes lengthened the stream without filling the window.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-span-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const TICK = 60_000, WINDOW = 5 * 60_000;
    const q = zd as unknown as { requestVerification: (n: number) => void };
    q.requestVerification(7);
    const t0 = 1_800_000_000_000;
    const fired: number[] = [];
    for (let i = 0; i < 40; i++) {
      const at = t0 + i * TICK;
      if (zd.drainVerifyRequests(at).some((e) => e.id === 7)) fired.push(at);
    }
    assert.ok(fired.length >= 3, `a burst must clear the evidence floor, got ${fired.length}`);
    const span = fired[fired.length - 1] - fired[0];
    assert.ok(span < WINDOW,
      `the burst spans ${span / 1000}s but the window is ${WINDOW / 1000}s — every probe past the ` +
      `window's edge is one the verdict can never see`);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every contending node STARTS its burst promptly — a delayed burst misses its window', async () => {
  // The invariant one-per-tick breaks, and the one a span check cannot see.
  // Draining one node per tick is FIFO (Map iteration is insertion-ordered), so
  // each burst stays contiguous and tight — but node B's burst does not BEGIN
  // until node A's five probes are done, five minutes later. A confirmation
  // burst is timed to land inside a specific 300s window; starting it five
  // minutes late puts every probe past the window's edge, where the verdict
  // can never see them. Tight but late is exactly as useless as spread out.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-start-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const TICK = 60_000;
    const q = zd as unknown as { requestVerification: (n: number) => void };
    for (const id of [7, 8, 9, 10]) q.requestVerification(id);
    const t0 = 1_800_000_000_000;
    const firstAt = new Map<number, number>();
    for (let i = 0; i < 40; i++) {
      const at = t0 + i * TICK;
      for (const { id } of zd.drainVerifyRequests(at)) if (!firstAt.has(id)) firstAt.set(id, at);
    }
    assert.equal(firstAt.size, 4, 'all four nodes must get a burst');
    for (const [id, at] of firstAt) {
      const delayTicks = (at - t0) / TICK;
      assert.ok(delayTicks <= 1,
        `node ${id} waited ${delayTicks} ticks to start its burst — a confirmation burst ` +
        'is timed to a specific window, and a late start puts every probe outside it');
    }
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CONTENTION does not stretch a burst past its window', async () => {
  // The other half, and why tightening the spacing alone was not enough:
  // releasing one node per tick globally re-serialises the bursts, so with N
  // nodes owed each one's probes land N ticks apart and the burst outgrows the
  // window again — undoing the fix that had just been applied.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-cont-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const TICK = 60_000, WINDOW = 5 * 60_000;
    const q = zd as unknown as { requestVerification: (n: number) => void };
    for (const id of [7, 8, 9, 10]) q.requestVerification(id);
    const t0 = 1_800_000_000_000;
    const seen = new Map<number, number[]>();
    for (let i = 0; i < 40; i++) {
      const at = t0 + i * TICK;
      for (const { id } of zd.drainVerifyRequests(at)) {
        seen.set(id, [...(seen.get(id) ?? []), at]);
      }
    }
    for (const [id, times] of seen) {
      assert.ok(times.length >= 3, `node ${id} got only ${times.length} probes`);
      const span = times[times.length - 1] - times[0];
      assert.ok(span < WINDOW,
        `with four nodes competing, node ${id}'s burst spans ${span / 1000}s > ${WINDOW / 1000}s window`);
    }
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an UNPROBEABLE node opens NO episode at all (v0.38.1)', async () => {
  // Supersedes the v0.38 test that asserted the structural counter accrued for
  // this case. The audit showed a sleeping node churning 16 unverifiable
  // episodes in one buffer — every one unscoreable BY CONSTRUCTION, since no
  // lane may probe the device to fill its windows. The fix moved upstream: the
  // episode never opens, so there is nothing to count. The resolve-time flag
  // and its counter remain (pinned at the outcomes-store level) for the one
  // edge they still cover — a node whose isListening flips mid-episode.
  //
  // The fixture's node 7 carries no `is_listening`, which parses to null under
  // the strict-boolean rule, so it is NOT a ping candidate.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-noep-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7), 4000);
    assert.notEqual(zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.isListening, true,
      'fixture precondition: node 7 must be non-listening');

    const priv = zd as unknown as { updateEpisodes: (s: unknown[], now: number) => void };
    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' };
    priv.updateEpisodes([symptom], t0);
    priv.updateEpisodes([], t0 + 60_000);
    priv.updateEpisodes([], t0 + 12 * 60_000);

    assert.equal(zd.unverifiableUnprobeableCount('rtt-degraded'), 0,
      'no episode opened, so nothing accrues — the churn is gone at the source');
    assert.equal(zd.unverifiableCount('rtt-degraded'), 0);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node whose isListening FLIPS mid-episode still resolves as unprobeable (v0.38.1)', async () => {
  // The one case the resolve-time flag still covers now that unprobeable nodes
  // never open episodes: the episode opened while the node was listening, and
  // by resolve time it is not (a re-interview can change capability flags, and
  // a re-included device can come back different). Without this test the
  // caller-side mutant — hardcoding `unprobeable = false` — survives a green
  // suite, and the structural counter silently loses its last live feeder.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-flip-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7), 4000);
    const real = zd.snapshot();
    const asListening = real.map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
    const asSleeping = real.map((n) => (n.nodeId === 7 ? { ...n, isListening: false } : n));
    const shadow = zd as unknown as { snapshot: () => NodeSnapshot[]; updateEpisodes: (s: unknown[], now: number) => void };

    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' };
    shadow.snapshot = () => asListening;      // listening at OPEN — the gate admits it
    shadow.updateEpisodes([symptom], t0);
    shadow.snapshot = () => asSleeping;       // capability flipped mid-episode
    shadow.updateEpisodes([], t0 + 60_000);
    shadow.updateEpisodes([], t0 + 12 * 60_000);  // past CONFIRM_MS -> resolve

    assert.equal(zd.unverifiableUnprobeableCount('rtt-degraded'), 1,
      'the flip is judged at RESOLVE, so the closure lands in the structural counter');
    assert.equal(zd.unverifiableCount('rtt-degraded'), 0);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first-of-burst flag is true EXACTLY once per burst (v0.38.2)', async () => {
  // The label rides this flag; a flag that is always true hides real spacing,
  // and one that is always false hides every boundary — both directions killed.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-first-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const q = zd as unknown as { requestVerification: (n: number) => void };
    q.requestVerification(7);
    const t0 = 1_800_000_000_000;
    const flags: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      for (const e of zd.drainVerifyRequests(t0 + i * 80_000)) if (e.id === 7) flags.push(e.first);
    }
    assert.equal(flags.length, 5, 'the whole burst drained');
    assert.deepEqual(flags, [true, false, false, false, false],
      'first on probe 1, and ONLY probe 1');

    q.requestVerification(7); // a new boundary → a new burst
    const flags2: boolean[] = [];
    for (let i = 12; i < 24; i++) {
      for (const e of zd.drainVerifyRequests(t0 + i * 80_000)) if (e.id === 7) flags2.push(e.first);
    }
    assert.equal(flags2[0], true, 'the next burst announces itself too');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ENGINE write lands in the ring as the engine, not as the operator (v0.41)', async () => {
  // Auto-ping routes its log through this sink. Before v0.41 it shared the
  // operator's, so the Log screen attributed every autonomous probe to the
  // human. NOTE: this pins the SINK; the index.ts wiring that points auto-ping
  // at it is not reachable from a test and is guarded only by review.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-prov-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    zd.logEngineAction('info', 7, 'node 7 probed by the ladder');
    zd.logAction('info', 7, 'node 7 pinged by you');
    // The ROUTER is what index.ts actually calls — the seam a pre-release
    // review caught wired wrong, with autonomous probes logging as operator.
    zd.logByOrigin('error', 7, 'routed as engine', 'engine');
    zd.logByOrigin('info', 7, 'routed as you', 'you');
    zd.logByOrigin('info', 7, 'routed by default', undefined);
    const evs = zd.events();
    const eng = evs.find((e) => e.text.includes('by the ladder'));
    const you = evs.find((e) => e.text.includes('by you'));
    assert.equal(eng?.source, 'engine', 'an autonomous write is the engine\'s');
    assert.equal(you?.source, 'you', 'and an operator action is still yours');
    assert.equal(evs.find((e) => e.text === 'routed as engine')?.source, 'engine',
      'the router sends engine-origin lines to the engine sink');
    assert.equal(evs.find((e) => e.text === 'routed as you')?.source, 'you');
    assert.equal(evs.find((e) => e.text === 'routed by default')?.source, 'you',
      'an unmarked caller is the operator — the conservative default');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node going DEAD mid-episode is marked confounded by the data layer — the ledger cannot see status (v0.40)', async () => {
  // The audited exemplar: rtt-degraded → node death → dead-remediation revival
  // → booked "improved (no action)". The ledger's guard needs the mark, and
  // only this layer owns node status; a deleted call-site line would leave the
  // guard permanently inert with every gate green (the v0.33 class).
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-confound-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7), 4000);
    const real = zd.snapshot();
    const asAlive = real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    const asDead = real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Dead, isListening: true } : n));
    const shadow = zd as unknown as {
      snapshot: () => NodeSnapshot[];
      updateEpisodes: (s: unknown[], now: number) => void;
      outcomes: { markConfounded: (n: number | null, k: string) => void };
    };
    const marked: Array<[number | null, string]> = [];
    const orig = shadow.outcomes.markConfounded.bind(shadow.outcomes);
    shadow.outcomes.markConfounded = (n, k) => { marked.push([n, k]); orig(n, k); };

    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' };
    shadow.snapshot = () => asAlive;
    shadow.updateEpisodes([symptom], t0);          // episode opens, node alive
    assert.equal(marked.length, 0, 'an alive node is never marked');
    // A dead-flap episode on the same node opens too — Dead status is that
    // symptom's own DEFINITION, so it must NEVER be marked (v0.40 review,
    // critical): marking it would starve the dead-flap control arm forever.
    const flapSymptom = { kind: 'dead-flap', nodeId: 7, severity: 'crit', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' };
    shadow.updateEpisodes([symptom, flapSymptom], t0 + 30_000);
    shadow.snapshot = () => asDead;
    shadow.updateEpisodes([symptom, flapSymptom], t0 + 60_000); // node goes Dead mid-episode
    assert.ok(marked.some(([n, k]) => n === 7 && k === 'rtt-degraded'),
      `the Dead transition must mark the open episode confounded: ${JSON.stringify(marked)}`);
    // The ENGINE screen reads `confirming` to tell "degraded right now" from
    // "recovered, being scored" — and pendingResolve lives HERE, not in the
    // ledger, so the join is this layer's job (v0.41).
    {
      const openNow = zd.openEpisodes();
      assert.ok(openNow != null, 'a configured ledger returns a list, never null');
      const ep7 = openNow.find((e) => e.nodeId === 7 && e.kind === 'rtt-degraded');
      assert.ok(ep7, `the open episode is visible to a screen: ${JSON.stringify(openNow)}`);
      assert.equal(ep7!.confirming, false, 'symptom still live ⇒ not in its confirmation window');
      shadow.updateEpisodes([], t0 + 70_000);          // symptom goes absent
      const after = zd.openEpisodes()?.find((e) => e.nodeId === 7 && e.kind === 'rtt-degraded');
      assert.equal(after?.confirming, true, 'absent symptom ⇒ confirming, joined from pendingResolve');
      shadow.updateEpisodes([symptom], t0 + 80_000);   // and back, for the checks below
    }
    assert.ok(!marked.some(([, k]) => k === 'dead-flap'),
      `dead-flap is its own definition, never a confound: ${JSON.stringify(marked)}`);

    // A Dead excursion that opens and closes BETWEEN two level samples is
    // invisible to the status read, but the event-driven flap counter saw it
    // (v0.40.2). A death is a death whether or not it straddled a boundary.
    marked.length = 0;
    shadow.snapshot = () => asAlive;                       // status reads Alive again
    // Drive the REAL producer: the event-driven accumulator the driver feeds,
    // drained by sampleEvidence into the per-tick carry the guard reads. Setting
    // the carry directly would prove the guard's branch and nothing about the
    // wiring that fills it (the v0.33 dead-path class).
    const priv = zd as unknown as {
      flapAccum: Map<number, number>;
      flapsThisTick: Map<number, number>;
      statsByNode: Map<number, unknown>;
      lastOkAt: number | null;
      sampleEvidence: () => void;
    };
    priv.flapAccum.set(7, 2);
    // The drain skips a node with no cached stats (fabricating zero counters
    // would poison the delta guards), and bails entirely on a stale cache.
    priv.statsByNode.set(7, {
      rtt: 30, rssi: -60, lwr: null, nlwr: null, commandsTX: 10, commandsRX: 10,
      commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: Date.now(),
    } as never);
    priv.lastOkAt = Date.now();
    priv.sampleEvidence();
    assert.ok(marked.some(([n, k]) => n === 7 && k === 'rtt-degraded'),
      `a sub-tick death must still confound: ${JSON.stringify(marked)}`);
    // …and the carry is consumed, not latched: a later pass with no new flap
    // must not keep confounding every episode on this node forever.
    assert.equal(priv.flapsThisTick.size, 0, 'the per-tick carry is cleared after use');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused removeFailed reaches the ledger as refused-misdiagnosis; a transport failure does not (v0.43.1)', async () => {
  // The blanket `if (!ok) return;` made falsePositives structurally 0 forever.
  // Both directions matter: recording every failure would fabricate accusations
  // against detectors, which is the harm the old conservatism protected.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-refusal-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7), 4000);
    // An unprobeable node opens NO episode (v0.38.1), so the node must read as
    // a ping candidate for the ledger to have anything to attribute to.
    const real = zd.snapshot();
    const asListening = real.map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
    const shadow = zd as unknown as {
      snapshot: () => NodeSnapshot[];
      updateEpisodes: (s: unknown[], now: number) => void;
    };
    shadow.snapshot = () => asListening;
    const t0 = 1_800_000_000_000;
    const sym = { kind: 'ghost-suspect', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' };

    shadow.updateEpisodes([sym], t0);
    // On the episodes' clock, like the refusal below: otherwise the ledger's
    // "opened after the action" rule confounds the episode and this assertion
    // would pass whether or not the transport failure was stopped.
    zd.recordActionOutcome('removeFailed', 7, false, 'transport', 'you', t0 + 1_000);
    shadow.updateEpisodes([], t0 + 60_000);
    shadow.updateEpisodes([], t0 + 12 * 60_000);
    assert.equal(zd.falsePositives('ghost-suspect'), 0,
      'a transport failure must never be held against a detector');

    shadow.updateEpisodes([sym], t0 + 20 * 60_000);
    // On the episodes' clock (v0.72.0): the ledger keeps an episode that opened
    // AFTER the action was sent out of it, so the stamp must be comparable.
    zd.recordActionOutcome('removeFailed', 7, false, 'refused', 'you', t0 + 20 * 60_000 + 1_000);
    shadow.updateEpisodes([], t0 + 21 * 60_000);
    shadow.updateEpisodes([], t0 + 33 * 60_000);
    assert.equal(zd.falsePositives('ghost-suspect'), 1,
      'a driver REFUSAL is the detector being wrong, and the ledger records it');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── v0.43.1: engineStatus counts three series, not one ────────────────────── */

test('engineStatus counts EACH baseline series from its own store, not from timeouts', async () => {
  // The pre-v0.43.1 predicate was one line — `timeoutNormal(...)?.ready` — and
  // REMEDY rendered it as "every node has a graduated baseline". A fleet whose
  // RSSI series had never graduated read fully learned. Stub the three series
  // apart so a count that is secretly the timeout count cannot hide.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-engstat-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  const seen = { timeout: 0, rtt: 0, rssi: 0 };
  const inner = zd as unknown as { baselines: unknown };
  const real = inner.baselines;
  try {
    inner.baselines = {
      timeoutNormal: () => { seen.timeout += 1; return { ready: true }; },
      rttNormal: () => { seen.rtt += 1; return { ready: false }; },
      rssiNormal: () => { seen.rssi += 1; return { ready: false }; },
    };
    const eng = zd.engineStatus();
    assert.ok(eng.total > 0, 'the fixture has scoreable nodes');
    assert.equal(eng.timeoutReady, eng.total, 'timeout series graduated fleet-wide');
    assert.equal(eng.rttReady, 0, 'rtt series is NOT inferred from timeouts');
    assert.equal(eng.rssiReady, 0, 'rssi series is NOT inferred from timeouts');
    assert.equal(eng.ready, eng.timeoutReady, 'the legacy alias still means what it meant');
    assert.equal(seen.rssi, eng.total, 'the rssi store was actually consulted, once per node');
    assert.equal(seen.rtt, eng.total, 'and so was the rtt store');
    assert.equal(eng.bands, N_BANDS, 'the band count is the real one, not a fallback');
    assert.equal(eng.band, bandOf(Date.now()), 'the band NAMED is the band the counts were measured in');
  } finally {
    // Restore here, not after the asserts: a failing assertion used to skip the
    // restore, and `zd.stop()` then threw a TypeError from the stub — which was
    // the only message reported, hiding the real failure.
    inner.baselines = real;
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the data layer applies the refusal SCOPE it computes, and only to refusals', async () => {
  // Three wiring facts the ledger-level tests cannot see, because they call the
  // store directly and the bug would live in the caller:
  //   1. the computed scope actually reaches recordAction;
  //   2. an action no detector offered indicts nothing at all;
  //   3. SUCCESS attribution stays node-wide — scoping it would starve every
  //      action arm whose kind did not happen to name the action.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-refscope-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const oc = (zd as unknown as { outcomes: OutcomeStore }).outcomes;
    const W0 = { tx: 100, rx: 100, timeouts: 40, rate: 0.4, samples: 6, freshN: 6, flaps: 0, s2: 0, s2Known: 6,
      routeChanges: 0, routeKnown: 6, rssiMedian: null, rssiN: 0, rttMedian: null, rttN: 0, rateKbpsMin: null };
    const W1 = { ...W0, timeouts: 1, rate: 0.01 };

    // (1) + the scope itself: a refused removeFailed on a node that is BOTH a
    // ghost-suspect and has a degraded return path.
    for (let i = 0; i < 4; i++) {
      const id = 200 + i;
      oc.open(id, 'ghost-suspect', 1000, W0);
      oc.open(id, 'return-path-degraded', 1000, W0);
      zd.recordActionOutcome('removeFailed', id, false, 'refused');
      oc.resolve(id, 'ghost-suspect', Date.now() + 1, W1);
      oc.resolve(id, 'return-path-degraded', Date.now() + 1, W1);
    }
    assert.equal(oc.falsePositives('ghost-suspect'), 4, 'the detector that called it a ghost is indicted');
    assert.equal(oc.falsePositives('return-path-degraded'), 0,
      'the unrelated detector is NOT — the controller said nothing about the return path');

    // (2) an action no plan offers: refusing it indicts no detector anywhere.
    oc.open(300, 'ghost-suspect', 1000, W0);
    zd.recordActionOutcome('ping', 300, false, 'refused');
    oc.resolve(300, 'ghost-suspect', Date.now() + 1, W1);
    assert.equal(oc.falsePositives('ghost-suspect'), 4, 'unchanged — no detector asked for a ping');

    // (3) success stays node-wide.
    oc.open(400, 'chronic-return-path', 1000, W0);
    oc.open(400, 'return-path-degraded', 1000, W0);
    zd.recordActionOutcome('ping', 400, true);
    oc.resolve(400, 'chronic-return-path', Date.now() + 1, W1);
    oc.resolve(400, 'return-path-degraded', Date.now() + 1, W1);
    assert.ok(oc.efficacyFor('chronic-return-path', 'ping').n > 0, 'credited');
    assert.ok(oc.efficacyFor('return-path-degraded', 'ping').n > 0,
      'credited too — a successful action may well have fixed both');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an episode closure reaches the LOG RING, and `worse` lifts to warn (v0.44.0)', async () => {
  // Every verdict the engine ever scored had exactly one sink: container
  // stdout — which the TUI cannot read and no operator sees. The onset of a
  // symptom was already a ring event; its closure is the other half.
  // Driven through the REAL lifecycle, not by calling pushEvent: the severity
  // decision lives in the resolve loop, and a stub proves nothing about it.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-closure-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    // Node 7 is non-listening in the fixture and the v0.38.1 gate admits no
    // episode for an unprobeable node — shadow it listening, as the
    // capability-flip test above does.
    const real = zd.snapshot();
    const asListening = real.map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
    const shadow = zd as unknown as { snapshot: () => NodeSnapshot[]; updateEpisodes: (s: unknown[], now: number) => void };
    shadow.snapshot = () => asListening;
    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0 - 600_000,
      basis: 'measured', evidence: [], narrative: 'n' };
    shadow.updateEpisodes([symptom], t0);            // opens
    shadow.updateEpisodes([], t0 + 60_000);          // goes absent → confirmation window
    shadow.updateEpisodes([], t0 + 12 * 60_000);     // window elapses → resolves
    const closures = zd.events().filter((e) => /closed/.test(e.text));
    assert.ok(closures.length > 0,
      `a closure must reach the ring: ${JSON.stringify(zd.events().slice(0, 6).map((e) => e.text))}`);
    const c0 = closures[0];
    assert.equal(c0.kind, 'symptom', 'same kind as the ONSET event, so the Log pairs them');
    assert.equal(c0.source, 'engine', 'the engine said it — not the network, not the operator');
    assert.match(c0.text, /rtt-degraded closed /, 'and it names the kind and the verdict');
    // Never `error`: the errorsOnly filter is for things that FAILED, and a
    // closure verdict is a measurement.
    assert.notEqual(c0.severity, 'error');
    assert.ok(c0.severity === 'info' || c0.severity === 'warn');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a `worse` closure is logged at WARN — a regression at info is one nobody sees (v0.44.0)', async () => {
  // Driven through the REAL resolve loop by forcing the windows the verdict is
  // computed from: a timeout rate that rises sharply across the episode scores
  // `worse`, and that verdict must lift the ring event's severity.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-worse-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const real = zd.snapshot();
    const asListening = real.map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
    const W = (timeouts: number) => ({ tx: 100, rx: 100, timeouts, rate: timeouts / 100, samples: 6,
      freshN: 6, flaps: 0, s2: 0, s2Known: 6, routeChanges: 0, routeKnown: 6,
      rssiMedian: null, rssiN: 0, rttMedian: null, rttN: 0, rateKbpsMin: null });
    let degraded = false;
    const shadow = zd as unknown as {
      snapshot: () => NodeSnapshot[];
      updateEpisodes: (s: unknown[], now: number) => void;
      nodeWindow: (id: number | null, now: number) => unknown;
      degradedWindow: (id: number | null, since: number, now: number) => unknown;
    };
    shadow.snapshot = () => asListening;
    // The BEFORE window comes from degradedWindow (captured at open), the AFTER
    // window from nodeWindow (computed at resolve) — both must be driven.
    shadow.degradedWindow = () => W(2);
    // `return-path-degraded` scores on the TIMEOUT rate — the metric this
    // window actually carries. (rtt-degraded scores on RTT and would close
    // `unverifiable` here, which is the ledger correctly refusing to guess.)
    // BEFORE: a healthy 2% timeout rate. AFTER: 60% — unambiguously worse.
    shadow.nodeWindow = () => (degraded ? W(60) : W(2));

    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'return-path-degraded', nodeId: 7, severity: 'warn', sinceMs: t0 - 600_000,
      basis: 'measured', evidence: [], narrative: 'n' };
    shadow.updateEpisodes([symptom], t0);
    degraded = true;
    shadow.updateEpisodes([], t0 + 60_000);
    shadow.updateEpisodes([], t0 + 12 * 60_000);

    const worse = zd.events().find((e) => /closed worse/.test(e.text));
    assert.ok(worse, `a worse closure must reach the ring: ${JSON.stringify(zd.events().map((e) => e.text).slice(0, 6))}`);
    assert.equal(worse.severity, 'warn',
      'a regression logged at info is a regression nobody sees');
    // Still not `error` — the errorsOnly filter is for things that FAILED.
    assert.notEqual(worse.severity, 'error');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('an install with NO outcome ledger reports null, not an empty list (v0.44.0)', async () => {
  // ENGINE has two branches — "no outcome ledger, the learning loop is off" and
  // "no open episodes, the healthy steady state" — and the first was
  // UNREACHABLE: this returned [] for both, so a dead learning loop rendered as
  // a clean bill of health. The distinction survived only in a test mock that
  // omitted the member, which is how optionality hides a dead feature.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-noledger-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    assert.ok(zd.openEpisodes() != null, 'a configured ledger returns a list');
    // Now take the ledger away, exactly as an install with no baselines store has it.
    (zd as unknown as { outcomes: unknown }).outcomes = null;
    assert.equal(zd.openEpisodes(), null,
      'no ledger must be distinguishable from an idle one — they render differently and must');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight episodes discarded by a mesh-identity change are COUNTED, not dropped silently (v0.44.0)', async () => {
  // A stick swap or NVM restore changes home_id, and every node-id-keyed cache
  // — including the outcome ledger — is wiped, because id 7 on the new network
  // is different hardware. That is correct. What was wrong is that in-flight
  // experiments vanished with nothing on any screen or in the log saying they
  // had ever existed.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-identity-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    // Two open episodes, then the identity flips underneath them.
    const oc = (zd as unknown as { outcomes: OutcomeStore }).outcomes;
    const W0 = { tx: 100, rx: 100, timeouts: 40, rate: 0.4, samples: 6, freshN: 6, flaps: 0, s2: 0,
      s2Known: 6, routeChanges: 0, routeKnown: 6, rssiMedian: null, rssiN: 0, rttMedian: null, rttN: 0, rateKbpsMin: null };
    oc.open(7, 'return-path-degraded', 1000, W0);
    oc.open(8, 'rtt-degraded', 1000, W0);
    assert.equal(oc.openEpisodes().length, 2, 'two experiments in flight');

    // Flip the network underneath it, through the real refresh path — the
    // canned controller now reports a different home_id, exactly as a stick
    // swap or NVM restore does.
    homeOverride = HOME + 1;
    await (zd as unknown as { refresh: () => Promise<void> }).refresh();

    const notice = zd.events().find((e) => /in-flight episode/.test(e.text));
    assert.ok(notice, `the loss must be on the record: ${JSON.stringify(zd.events().map((e) => e.text).slice(0, 8))}`);
    assert.match(notice.text, /2 in-flight episodes discarded/, 'and it must say HOW MANY');
    assert.equal(notice.source, 'engine');
    assert.equal(notice.kind, 'system', 'a cache reset is a system event, not a symptom');
  } finally {
    homeOverride = null;
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a MANUAL ping is registered for judging; an engine one is not double-pended (v0.47.0)', async () => {
  // The engine has owned the primitive for deciding whether a ping was answered
  // since v0.36 and never applied it to the one probe a human actually asked
  // for — `p` reported "sent" and then said nothing, which is the weakest claim
  // on the screen: "sent" is not "answered". An engine ping is already pended
  // by its own lane; pending it again here would double-attribute it.
  //
  // The runner's launch stamp travels with it (v0.64.5). HA's ping button
  // starts the driver's ping and returns, so the answer can beat HA's reply;
  // a probe pended at the hook's own clock then post-dated it and was judged a
  // miss.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-manual-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const pended: Array<[number, number | undefined]> = [];
    zd.setProbeNotePending((n, sentAt) => pended.push([n, sentAt]));

    zd.recordActionOutcome('ping', 7, true, undefined, 'you', 1_234);
    assert.deepEqual(pended, [[7, 1_234]], 'an operator ping is owed an answer, dated from its launch');

    zd.recordActionOutcome('ping', 8, true, undefined, 'engine', 2_000);
    assert.deepEqual(pended, [[7, 1_234]], 'an engine ping is pended by its OWN lane, never twice');

    // A ping that never left does not owe an answer.
    zd.recordActionOutcome('ping', 9, false, 'transport', 'you');
    assert.deepEqual(pended, [[7, 1_234]], 'a failed send is not an outstanding probe');

    // And no other action is a probe.
    zd.recordActionOutcome('healNode', 10, true, undefined, 'you', 3_000);
    assert.deepEqual(pended, [[7, 1_234]], 'only a ping is a probe');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('baselineHold reports the quarantine the tick computes, and ranks symptomatic first (v0.48.0)', async () => {
  // The engine computed these two sets on every detector pass and stored them
  // NOWHERE, so DETAIL rendered "still learning · 3d so far" for a node whose
  // learning is FROZEN — the baseline is deliberately not folded while a
  // symptom is live or arming, so that day count is not advancing.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-hold-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const inner = zd as unknown as {
      lastQuarantineSym: Set<number>;
      lastQuarantineArm: Set<number>;
    };
    // Nothing held: the screen must render nothing rather than claim learning
    // is running when it cannot know.
    inner.lastQuarantineSym = new Set();
    inner.lastQuarantineArm = new Set();
    assert.equal(zd.baselineHold(7), null);

    inner.lastQuarantineArm = new Set([7]);
    assert.equal(zd.baselineHold(7), 'arming');

    inner.lastQuarantineSym = new Set([7]);
    assert.equal(zd.baselineHold(7), 'symptomatic',
      'a live symptom outranks an arming one when BOTH apply — it is the stronger statement');

    assert.equal(zd.baselineHold(999), null, 'a node in neither set is not held');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine tick RETAINS the quarantine it builds (v0.48.0)', async () => {
  // Driven through the real detector pass, not by assigning the fields: the
  // defect was that the tick computed these two sets and threw them away.
  // A node the driver has marked Dead past its dwell fires `node-down`, which
  // puts it in the symptomatic set — so a NON-EMPTY result is what proves the
  // assignment happened, and an `instanceof Set` check would pass vacuously.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-hold2-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const real = zd.snapshot();
    const deadListening = real.map((n) => (n.nodeId === 7
      ? { ...n, isListening: true, status: NodeStatus.Dead, statusLabel: 'dead' } : n));
    const priv = zd as unknown as {
      runEngine: (now: number) => void;
      lastNodes: NodeSnapshot[];
      lastQuarantineSym: Set<number>;
    };
    // runEngine reads `lastNodes`, NOT snapshot() — the detector runs on the
    // roster the last poll produced.
    priv.lastNodes = deadListening;

    // Two passes: the first arms the dwell, the second is past it.
    const t0 = Date.now();
    priv.runEngine(t0);
    priv.runEngine(t0 + 60 * 60_000);

    const live = zd.symptoms().filter((x) => x.nodeId === 7);
    assert.ok(live.length > 0, `precondition: a symptom must be live — ${JSON.stringify(zd.symptoms())}`);
    assert.ok(priv.lastQuarantineSym.has(7),
      `the computed quarantine must be RETAINED, not discarded — got ${JSON.stringify([...priv.lastQuarantineSym])}`);
    assert.equal(zd.baselineHold(7), 'symptomatic', 'and it reaches the accessor');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a departed node discarding its learning is visible IN THE TUI (v0.53.0)', async () => {
  // Eviction throws away weeks of learned baselines, the persisted evidence
  // ring and any in-flight ledger episode. The sibling home-id purge pushes a
  // Log event; this path only wrote to stdout, so from inside the TUI — which
  // cannot read the container log — the loss was invisible.
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 40, routePollMs: 80, evictAfterMs: 1 });
  try {
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7));
    // Drop node 7 from the roster and let the eviction window elapse.
    // Add a second node, let it register, then remove ONLY it — an empty
    // roster is (correctly) treated as a transient poll glitch, not a mass
    // exodus, so the eviction path needs a surviving roster to run against.
    rosterNodes = [NODE7, { node_id: 8, status: 4, ready: true, is_routing: true, is_secure: false }];
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 8), 4000);
    rosterNodes = [NODE7];
    await waitFor(() => zd.events().some((e) => /left the network/.test(e.text)), 4000);
    const ev = zd.events().find((e) => /left the network/.test(e.text))!;
    assert.match(ev.text, /node 8/, `the id belongs in the TEXT, frozen at push time: ${ev.text}`);
    assert.match(ev.text, /baselines/, 'the event must name what was discarded');
    // nodeId is NULL on purpose: the Log's node column resolves LIVE against
    // the roster, and this is the one path built FOR node-id reuse — a
    // nodeId here would print the REPLACEMENT device's name.
    assert.equal(ev.nodeId, null, 'the row must not resolve against a future occupant of this id');
  } finally { zd.stop(); rosterNodes = [NODE7]; }
});

/* ── v0.64.6 ──────────────────────────────────────────────────────────────── */

test('displayed lastSeen: only a counter that proves the node was HEARD stamps arrival — timeout and dropped-TX do not (v0.64.6)', async () => {
  // zwave-js moves timeoutResponse when the node did NOT answer a command that
  // expected a reply (the report timeout plus its round-trip time after its
  // acknowledgement, in its own statistics event); stamping that as "heard"
  // credited silence as an answer.
  // commandsDroppedTX is excluded defensively (see the onNodeStats comment).
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 80, routePollMs: 160 });
  const S = () => zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)?.stats;
  try {
    pushStats(ha, statsEvent());                                          // first delivery: cached, no stamp
    await waitFor(() => S()?.commandsTX === 10);
    pushStats(ha, statsEvent({ commands_tx: 11 }));                       // an acknowledged send: heard
    await waitFor(() => S()?.lastSeen != null);
    let stamp = S()!.lastSeen!;
    await sleep(25);
    pushStats(ha, statsEvent({ commands_tx: 11, timeout_response: 2 }));  // a reply that never came
    await waitFor(() => S()?.timeoutResponse === 2);
    assert.equal(S()!.lastSeen, stamp, 'a response timeout is the node NOT answering');
    await sleep(25);
    pushStats(ha, statsEvent({ commands_tx: 11, timeout_response: 2, commands_dropped_tx: 1 }));   // the dropped-TX counter moved
    await waitFor(() => S()?.commandsDroppedTX === 1);
    assert.equal(S()!.lastSeen, stamp, 'a failed send is not hearing from the node');
    await sleep(25);
    pushStats(ha, statsEvent({ commands_tx: 11, timeout_response: 2, commands_dropped_tx: 1, commands_dropped_rx: 1 }));   // an undecodable frame FROM the node
    await waitFor(() => (S()?.lastSeen ?? 0) > stamp);
    stamp = S()!.lastSeen!;
    await sleep(25);
    pushStats(ha, statsEvent({ commands_tx: 11, timeout_response: 2, commands_dropped_tx: 1, commands_dropped_rx: 1, commands_rx: 10 }));   // a frame from the node
    await waitFor(() => (S()?.lastSeen ?? 0) > stamp);
  } finally {
    zd.stop();
  }
});

const THIN_RTT = { samples: 6, freshN: 1, tx: 5, rx: 5, timeouts: 0, rate: null, flaps: 0, s2: 0, s2Known: 6, routeChanges: 0, routeKnown: 6, rssiMedian: null, rssiN: 0, rttMedian: 400, rttN: 1, rateKbpsMin: 100 };
const FULL_RTT = { ...THIN_RTT, freshN: 6, rttMedian: 30, rttN: 6 };

/** Shadow the windows the ledger scores so only the LIFECYCLE timing decides
 *  the transient/undersampled split: a before-window that never fills, an
 *  after-window that does, and node 7 listening (the v0.38.1 episode gate). */
function liveSpanShadow(zd: ZwaveData): { updateEpisodes: (s: unknown[], now: number) => void } {
  const asListening = zd.snapshot().map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
  const shadow = zd as unknown as { snapshot: () => NodeSnapshot[]; degradedWindow: () => unknown; nodeWindow: () => unknown; updateEpisodes: (s: unknown[], now: number) => void };
  shadow.snapshot = () => asListening;
  shadow.degradedWindow = () => ({ ...THIN_RTT });
  shadow.nodeWindow = () => ({ ...FULL_RTT });
  return shadow;
}

async function ledgerZd(prefix: string): Promise<{ zd: ZwaveData; dir: string }> {
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  return { zd, dir };
}

test('a 30-second blink closes TRANSIENT through the real lifecycle — the confirmation window is not live time (v0.64.6)', async () => {
  const { zd, dir } = await ledgerZd('zwtui-blink-');
  try {
    assert.notEqual(zd.openEpisodes(), null, 'precondition: this install has an outcome ledger');
    assert.ok(zd.snapshot().some((n) => n.nodeId === 7), 'precondition: node 7 is on the roster');
    const shadow = liveSpanShadow(zd);
    const t0 = 1_800_000_000_000;
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0 - 5 * 60_000, basis: 'measured', evidence: [], narrative: 'n' };
    shadow.updateEpisodes([symptom], t0);                        // opens at dwell maturity
    shadow.updateEpisodes([], t0 + 30_000);                      // first absence, 30 s later
    shadow.updateEpisodes([], t0 + 30_000 + 10 * 60_000);        // the confirmation window elapses → resolves
    assert.equal(zd.unverifiableTransientCount('rtt-degraded'), 1, 'a blink is transient');
    assert.equal(zd.unverifiableUndersampledCount('rtt-degraded'), 0, 'not a reporting-rate problem');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a starved episode LIVE past the burst span still closes UNDERSAMPLED — measured from the dwell start, not the open tick (v0.64.6)', async () => {
  const { zd, dir } = await ledgerZd('zwtui-starved-');
  try {
    assert.notEqual(zd.openEpisodes(), null, 'precondition: this install has an outcome ledger');
    const shadow = liveSpanShadow(zd);
    const t0 = 1_800_000_000_000;
    // The dwell started 7 min before the open tick (the episode opened 2 min
    // after maturity); the reading ages out 3.5 min after the open.
    const symptom = { kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0 - 7 * 60_000, basis: 'measured', evidence: [], narrative: 'n' };
    shadow.updateEpisodes([symptom], t0);
    shadow.updateEpisodes([symptom], t0 + 3 * 60_000);
    shadow.updateEpisodes([], t0 + 3.5 * 60_000);
    shadow.updateEpisodes([], t0 + 13.5 * 60_000);
    assert.equal(zd.unverifiableUndersampledCount('rtt-degraded'), 1, 'it had the time, never the readings');
    assert.equal(zd.unverifiableTransientCount('rtt-degraded'), 0);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-v0.64.6 ledger's discarded split reaches the LOG RING, not only stdout (v0.64.6)", async () => {
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-legacysplit-'));
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ v: 1, control: [], action: [], fp: [], unver: [], unverUnprobe: [],
    unverTransient: [['rtt-degraded', 1]], unverUndersampled: [['rtt-degraded', 6]] }));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const note = zd.events().find((e) => /transient\/undersampled tallies reset/.test(e.text));
    assert.ok(note, `the discard must be visible in the TUI: ${JSON.stringify(zd.events().slice(0, 8).map((e) => e.text))}`);
    assert.match(note!.text, /^7 /, 'count first — the row clips at 80 columns');
    assert.equal(note!.source, 'engine');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine reads the STORE's rate run — a persistent same-route fallback fires through the real detector pass (v0.64.6)", async () => {
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-raterun-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 60_000,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const priv = zd as unknown as {
      runEngine: (now: number) => void;
      lastNodes: NodeSnapshot[];
      evidenceStore: { record: (id: number, stats: unknown, status: NodeStatus, extras: unknown, at: number) => unknown };
    };
    priv.lastNodes = zd.snapshot().map((n) => (n.nodeId === 7 ? { ...n, isListening: true } : n));
    const t0 = Date.now();
    const st = (commandsTX: number, protocolDataRate: number) => ({
      rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null,
      commandsTX, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null,
    });
    const rec = (tx: number, rate: number, at: number) => priv.evidenceStore.record(7, st(tx, rate), NodeStatus.Alive, { fresh: true }, at);
    rec(0, 3, t0 - 10 * 60_000);    // counter baseline
    rec(1, 3, t0 - 9 * 60_000);     // an acknowledged transmission at 100k
    rec(2, 2, t0 - 8 * 60_000);     // below 100k
    rec(3, 2, t0 - 7 * 60_000);     // a second, separate one
    priv.runEngine(t0 - 7 * 60_000);   // arms the dwell
    priv.runEngine(t0);                // past it
    assert.ok(zd.symptoms().some((x) => x.kind === 'rate-fallback' && x.nodeId === 7),
      `the production detector must read the store's rate run: ${JSON.stringify(zd.symptoms())}`);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node is not sampled inside zwave-js\'s statistics throttle window — once, never twice in a row (v0.64.6 review)', async () => {
  // zwave-js emits a transmission's commandsTX in the leading edge of its 250 ms
  // statistics throttle and the route rate that transmission produced in a
  // trailing event; a sample between them reads the previous frame's rate.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-settle-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 60_000,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const priv = zd as unknown as {
      lastOkAt: number | null; sampleEvidence: () => void;
      statsByNode: Map<number, { commandsTX: number }>; evidenceStore: { forNode: (id: number) => unknown[] };
    };
    const sample = () => { priv.lastOkAt = Date.now(); priv.sampleEvidence(); };
    pushStats(ha, statsEvent());
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7 && n.stats.commandsTX === 10));
    await sleep(350);                                       // well past the throttle window
    sample();
    const n0 = priv.evidenceStore.forNode(7).length;
    assert.ok(n0 >= 1, 'precondition: a settled node is sampled');
    pushStats(ha, statsEvent({ commands_tx: 11 }));         // a transmission's leading statistics event
    await waitFor(() => priv.statsByNode.get(7)?.commandsTX === 11);
    sample();
    assert.equal(priv.evidenceStore.forNode(7).length, n0, 'sampled inside the throttle window: deferred to the next tick');
    sample();
    assert.equal(priv.evidenceStore.forNode(7).length, n0 + 1, 'but only one tick — the next sample is taken');
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-v0.64.6 ledger RESUMED from its archive announces the discarded split in the Log ring too (v0.64.6 review)", async () => {
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-resume-split-'));
  // The live ledger belongs to another controller; this controller's own ledger,
  // written before v0.64.6, is archived beside it.
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ v: 1, homeId: 12345, control: [] }));
  writeFileSync(join(dir, `outcomes.home-${HOME}.json`), JSON.stringify({ v: 1, homeId: HOME, control: [],
    unverTransient: [['rtt-degraded', 2]], unverUndersampled: [['rtt-degraded', 3]] }));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    await waitFor(() => zd.pendingIdentity() != null);
    assert.equal(zd.events().some((e) => /tallies reset/.test(e.text)), false, 'precondition: nothing was discarded at boot');
    zd.resolveIdentityDecision('resume');
    const note = zd.events().find((e) => /transient\/undersampled tallies reset/.test(e.text));
    assert.ok(note, `the resume's discard must reach the Log: ${JSON.stringify(zd.events().slice(0, 8).map((e) => e.text))}`);
    assert.match(note!.text, /^5 /);
  } finally {
    zd.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── v0.65.0: the statistics feeds must survive a config-entry reload ─────── */

test('a zwave_js config-entry RELOAD re-arms the statistics feeds (v0.65.0)', async () => {
  // The 2026-09-15 live audit: a driver restart reloads the config entry, which
  // orphans every node-statistics subscription on HA's side — the listener is
  // bound to the Node objects of the driver that just went away. Nothing
  // re-armed them, so the engine ran blind for 22 h 48 m of a 23 h window while
  // auto-ping kept logging healthy verdicts off the separate driver-WS feed.
  const ha = fakeHa();
  const lines: string[] = [];
  const zd = await bootedZwaveData(ha, { refreshMs: 60, log: (m: string) => lines.push(m) });
  const feed = 'zwave_js/subscribe_node_statistics';
  try {
    await waitFor(() => (ha.subCount.get(feed) ?? 0) >= 1);
    const subsBefore = ha.subCount.get(feed) ?? 0;
    const liveBefore = ha.live.get(feed) ?? 0;
    assert.ok(liveBefore >= 1, 'precondition: the node feed is live');

    failNetworkStatus = 'HA WS error (not_loaded): Config entry 01KQ5 not loaded';
    await waitFor(() => lines.some((l) => /refresh failed/.test(l)));
    failNetworkStatus = null;

    await waitFor(() => (ha.subCount.get(feed) ?? 0) > subsBefore, 4000);
    assert.ok(lines.some((l) => /live statistics: re-subscribing \(zwave_js config entry reloaded\)/.test(l)),
      `the re-arm must say why: ${JSON.stringify(lines.slice(-6))}`);
    assert.equal(ha.live.get(feed), liveBefore,
      'the orphaned subscriptions are RELEASED, not left doubled on the socket');
    // …and so are the ACTIVITY feeds (v0.65.0 review). These are
    // `subscribe_events` on HA's core bus, NOT zwave_js Node listeners, so a
    // config-entry reload does not orphan them — the re-arm rebuilds on the
    // same live socket, and without retaining their handles it left a whole
    // -house `state_changed` fanout behind on every single re-arm. The stats
    // feed alone passing is why this shipped: it is the only one asserted above.
    assert.equal(ha.live.get('state_changed') ?? 0, 1,
      'the re-arm left a ZOMBIE whole-house activity feed live beside the new one');
    assert.equal(ha.live.get('zwave_js_notification') ?? 0, 1,
      'the re-arm left a ZOMBIE notification feed live beside the new one');
    // The cost of a zombie, measured rather than inferred: one state change in
    // the house must produce ONE activity row, not one per surviving feed.
    const rowsBefore = zd.events().length;
    for (const h of [...(ha.handlers.get('state_changed') ?? [])]) {
      h({ event: { data: { entity_id: 'switch.node_seven', old_state: { state: 'on' }, new_state: { state: 'off' } } } } as never);
    }
    assert.equal(zd.events().length - rowsBefore, 1,
      'one state change logged more than once — the activity feed is doubled');
  } finally {
    failNetworkStatus = null;
    zd.stop();
  }
});

test('a SECOND config-entry reload inside the throttle window is not swallowed (v0.65.0 review)', async () => {
  // The latch used to be cleared at the CALL SITE, before `rearmStatsFeeds`
  // consulted its 10-minute throttle. Two reloads close together — an add-on
  // update, a driver crash loop, a Core restart followed by a Z-Wave JS restart
  // — therefore spent the latch on a call that returned immediately having done
  // nothing, leaving the second reload's orphaned feeds with no scheduled
  // repair at all. The latch now survives a throttled call and is consumed by
  // the re-arm that actually runs.
  const ha = fakeHa();
  const lines: string[] = [];
  const zd = await bootedZwaveData(ha, { refreshMs: 60, log: (m: string) => lines.push(m) });
  const priv = zd as unknown as { entryReloadSeen: boolean; lastFeedRearmAt: number };
  try {
    // Reload #1 — re-arms, and arms the throttle.
    failNetworkStatus = 'HA WS error (not_loaded): Config entry 01KQ5 not loaded';
    await waitFor(() => lines.some((l) => /refresh failed/.test(l)));
    failNetworkStatus = null;
    await waitFor(() => lines.some((l) => /re-subscribing \(zwave_js config entry reloaded\)/.test(l)), 4000);

    // Reload #2, inside the throttle window. The re-arm cannot run yet — but
    // the request must SURVIVE, or nothing ever rebuilds these feeds.
    lines.length = 0;
    failNetworkStatus = 'HA WS error (not_loaded): Config entry 01KQ5 not loaded';
    await waitFor(() => lines.some((l) => /refresh failed/.test(l)));
    failNetworkStatus = null;
    await sleep(300);   // several successful ticks, all throttled out
    assert.equal(lines.filter((l) => /re-subscribing/.test(l)).length, 0,
      'setup: the throttle must still be holding the second re-arm');
    assert.equal(priv.entryReloadSeen, true,
      'the throttled call spent the latch — the second reload is now unrepairable');

    // Let the window expire: the latched reload rebuilds on the next poll,
    // rather than waiting out the watchdog's separate ten minutes of silence.
    priv.lastFeedRearmAt = 0;
    await waitFor(() => lines.some((l) => /re-subscribing \(zwave_js config entry reloaded\)/.test(l)), 4000);
    assert.equal(priv.entryReloadSeen, false, 'the latch is consumed by the re-arm that RAN');
  } finally {
    failNetworkStatus = null;
    zd.stop();
  }
});

test('two rebuilds never run at once on ONE connection (v0.65.0 review)', async () => {
  // The re-arm force-cleared `statsSubscribed` — the "a run owns this
  // connection" flag — and called straight into `subscribeStatistics`. Both
  // runs then captured the SAME epoch, so `superseded()` was false for both and
  // neither stood down: the v0.26 double subscribe, back on a socket that never
  // closed. Reproduced on the green tree at controller 2, node_statistics 2,
  // node_status 2, state_changed 3, and the loser's ~77 handles discarded
  // unreleasable because `ownedStatsSubs` is assigned, not merged.
  //
  // Both interleavings are real and both are exercised here:
  //  · a rebuild is PARKED inside a subscribe (a slow Core) when the reload
  //    latch fires — the re-arm must not clear the flag under it;
  //  · releasing a handle is a WS round trip, so the roster poll lands inside
  //    the re-arm's release loop — the flag must still be held across it.
  const feeds = [
    'zwave_js/subscribe_controller_statistics',
    'zwave_js/subscribe_node_statistics',
    'zwave_js/subscribe_node_status',
    'state_changed',
    'zwave_js_notification',
  ];
  const ha = fakeHa();
  const lines: string[] = [];
  // Park the first rebuild inside the controller subscribe, exactly where a
  // slow HA holds it, and fire the re-arm beside it.
  ha.gate.feed = 'zwave_js/subscribe_controller_statistics';
  const parked = new Promise<void>((res) => { ha.gate.parked = res; });
  const zd = createZwaveData({
    client: ha, entryId: ENTRY, refreshMs: 40, routePollMs: 60_000,
    historyPath: null, evidencePath: null, driverWsUrl: null,
    log: (m: string) => lines.push(m),
  } as never);
  const priv = zd as unknown as { entryReloadSeen: boolean; lastFeedRearmAt: number };
  try {
    zd.start();
    ha.fireReady();
    await parked;                   // rebuild #1 is mid-flight
    priv.lastFeedRearmAt = 0;
    priv.entryReloadSeen = true;    // a reload lands while it is still building
    await sleep(200);               // several ticks fire the re-arm beside it
    // The request must not be SPENT by a re-arm that stood aside — otherwise
    // deferring is just the swallowed-reload defect wearing a guard's clothes.
    assert.equal(priv.entryReloadSeen, true,
      'the deferred re-arm threw the reload away instead of leaving it latched');
    ha.gate.feed = null;
    for (const r of ha.gate.releases.splice(0)) r();
    await sleep(200);
    for (const feed of feeds) {
      assert.equal(ha.live.get(feed) ?? 0, 1,
        `${feed}: ${ha.live.get(feed)} live feeds — a re-arm ran beside a rebuild in flight`);
    }

    // Now the release-loop interleaving, on a settled connection.
    ha.unsubDelayMs = 60;
    priv.lastFeedRearmAt = 0;
    await waitFor(() => lines.some((l) => /re-subscribing/.test(l)), 4000);
    await sleep(600);               // the loop, the polls and the rebuild settle
    ha.unsubDelayMs = 0;
    for (const feed of feeds) {
      assert.equal(ha.live.get(feed) ?? 0, 1,
        `${feed}: ${ha.live.get(feed)} live feeds — the poll rebuilt inside the release loop`);
    }
  } finally {
    ha.unsubDelayMs = 0;
    ha.gate.feed = null;
    for (const r of ha.gate.releases.splice(0)) r();
    zd.stop();
  }
});

test('the re-arm REPLAY after a driver restart carries lastSeen, it does not restamp it (v0.65.0 review)', async () => {
  // A driver restart is what reloads the config entry, and zwave-js holds node
  // statistics in memory only — the new driver starts every counter at zero.
  // The cached counters deliberately survive the re-arm, so the replay arrives
  // with every counter BELOW the cache. Read as movement, that stamped "heard
  // just now" on the whole roster at once, including the nodes the new driver
  // could not reach: the v0.26 "seen 0s ago for all 39 nodes" fabrication, and
  // the fabricated self-proven credits fix #2 exists to stop, regenerated by
  // fix #1 on the one path guaranteed to run right after a driver restart.
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 80, routePollMs: 160 });
  const seenOf = () => zd.snapshot().find((n: NodeSnapshot) => n.nodeId === 7)!.stats.lastSeen;
  try {
    pushStats(ha, statsEvent());                          // first delivery: no stamp
    await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7 && n.stats.commandsTX === 10));
    pushStats(ha, statsEvent({ commands_tx: 11 }));       // real traffic: stamped
    await waitFor(() => seenOf() != null);
    const stamped = seenOf()!;

    // The new driver's replay: every counter re-based at zero.
    await sleep(60);
    pushStats(ha, statsEvent({ commands_tx: 0, commands_rx: 0, commands_dropped_rx: 0, commands_dropped_tx: 0, timeout_response: 0 }));
    await sleep(80);
    assert.equal(seenOf(), stamped,
      'a counter that went BACKWARDS is a new driver, not a transmission — the stamp must be carried');

    // POSITIVE CONTROL: the guard must not simply freeze the stamp. The next
    // genuine increment, from the new driver's own zero baseline, stamps.
    pushStats(ha, statsEvent({ commands_tx: 1, commands_rx: 0, commands_dropped_rx: 0, commands_dropped_tx: 0, timeout_response: 0 }));
    await waitFor(() => seenOf() !== stamped);
    assert.ok(seenOf()! > stamped, 'a real increment after the restart must stamp arrival');
  } finally {
    zd.stop();
  }
});

test('the driver-WS readings reach the engine through zwaveData, not only the client (v0.65.0 review)', async () => {
  // The producer side of both v0.65.0 driver-WS readings had no test at all:
  // deleting `driverWsConnAt = Date.now()` from the handshake callback, or
  // returning null from either accessor, left the whole suite green. The
  // consumers were pinned with injected stubs, which prove the consumer and
  // nothing about the wiring — the "wire it to the production bridge" hole.
  const srv = await mockServer();          // homeId matches HOME, so the guard passes
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 60, driverWsUrl: srv.url });
  try {
    const t0 = Date.now();
    await waitFor(() => zd.driverReconnectedAt() != null, 6000);
    const first = zd.driverReconnectedAt()!;
    assert.ok(first >= t0 - 1_000, 'the handshake must stamp when the driver came up, not some default');

    // The blackout reading has to cross the same hop.
    assert.equal(zd.controllerRfOffSince(), null, 'precondition: the radio is up');
    srv.push({ event: 'logging', context: { type: 'controller' }, message: 'Turning RF off...' });
    await waitFor(() => zd.controllerRfOffSince() != null, 6000);
    srv.push({ event: 'logging', context: { type: 'controller' }, message: 'Turning RF on...' });
    await waitFor(() => zd.controllerRfOffSince() == null, 6000);

    // A SECOND driver restart must move the stamp. A stamp that is merely
    // non-null is inert against the very burst it exists to describe: the
    // window is measured from it, so a stale one matches nothing.
    await sleep(30);
    srv.dropClient();
    await waitFor(() => (zd.driverReconnectedAt() ?? 0) > first, 6000);
  } finally {
    zd.stop();
    await srv.close();
  }
});

test('a config-entry reload anchors the driver-restart burst window even with the driver-WS dark (v0.65.0 review)', async () => {
  // `driverReconnectedAt()` used to read ONLY the driver-WS version handshake.
  // A driver restart is the event most likely to take that link down, and in
  // the 2026-09-15 audit the second restart's reconnect ladder stopped after
  // attempt 2 and never handshook again — leaving the reading 22 h stale while
  // 25 of the 28 fabricated self-proven credits were booked. The reload is the
  // teardown half of the same restart, seen on the HA socket, which stayed up.
  const ha = fakeHa();
  const lines: string[] = [];
  const zd = await bootedZwaveData(ha, { refreshMs: 60, log: (m: string) => lines.push(m) });
  try {
    assert.equal(zd.driverReconnectedAt(), null,
      'precondition: no driver-WS link, so no handshake stamp exists');
    const t0 = Date.now();
    failNetworkStatus = 'HA WS error (not_loaded): Config entry 01KQ5 not loaded';
    await waitFor(() => lines.some((l) => /refresh failed/.test(l)));
    failNetworkStatus = null;
    const at = zd.driverReconnectedAt();
    assert.ok(at != null && at >= t0, 'the reload must anchor the restart-burst window');
  } finally {
    failNetworkStatus = null;
    zd.stop();
  }
});

test('a feed that silently stops delivering is re-armed on its own — absence is not success (v0.65.0)', async () => {
  // The positive control. Whatever kills the feed — including a cause nobody
  // has seen yet — ends here, because silence is CHECKED rather than assumed
  // benign. Without it the add-on cannot tell "a quiet mesh" from "no data".
  const ha = fakeHa();
  const lines: string[] = [];
  const zd = await bootedZwaveData(ha, { refreshMs: 60, log: (m: string) => lines.push(m) });
  const feed = 'zwave_js/subscribe_node_statistics';
  try {
    await waitFor(() => (ha.subCount.get(feed) ?? 0) >= 1);
    const subsBefore = ha.subCount.get(feed) ?? 0;
    const priv = zd as unknown as { lastStatsAt: number | null };
    priv.lastStatsAt = Date.now() - 25 * 60_000;   // nothing from ANY node for 25 min
    await waitFor(() => (ha.subCount.get(feed) ?? 0) > subsBefore, 4000);
    assert.ok(lines.some((l) => /re-subscribing \(no statistics from any node for \d+m\)/.test(l)),
      `the watchdog must name the silence: ${JSON.stringify(lines.slice(-6))}`);
    // …ONCE per dead-feed window. A re-subscribe that fails to revive the feed
    // must not become a per-tick reconnect storm against a recovering Core.
    const afterFirst = ha.subCount.get(feed) ?? 0;
    priv.lastStatsAt = Date.now() - 25 * 60_000;
    await sleep(400);
    assert.equal(ha.subCount.get(feed) ?? 0, afterFirst, 'the re-arm is throttled, not repeated every tick');
  } finally {
    zd.stop();
  }
});

test('a feed that has never delivered anything is NOT re-armed in a loop (v0.65.0)', async () => {
  // lastStatsAt is null before the first event ever arrives. Treating that as a
  // dead feed would re-subscribe on every tick of a mesh that is merely new.
  const ha = fakeHa();
  const lines: string[] = [];
  const zd = await bootedZwaveData(ha, { refreshMs: 60, log: (m: string) => lines.push(m) });
  const feed = 'zwave_js/subscribe_node_statistics';
  try {
    await waitFor(() => (ha.subCount.get(feed) ?? 0) >= 1);
    const subsBefore = ha.subCount.get(feed) ?? 0;
    await sleep(400);   // several refresh ticks with no statistics event at all
    assert.equal(ha.subCount.get(feed) ?? 0, subsBefore, 'no re-arm without evidence the feed ever worked');
    assert.equal(lines.filter((l) => /re-subscribing/.test(l)).length, 0);
  } finally {
    zd.stop();
  }
});

test('a REPLAYED statistics snapshot is not proof the feed is alive (v0.67.0)', async () => {
  // `lastStatsAt` is what the dead-feed watchdog AND the degraded sensor both
  // measure silence against, and it was stamped unconditionally — including
  // for the snapshots every (re)subscribe replays. So a re-arm that did NOT
  // revive the feed still zeroed the blindness clock: sustained blindness
  // became a 10-minute sawtooth that the alarm could never latch on.
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 60 });
  const feed = 'zwave_js/subscribe_node_statistics';
  try {
    await waitFor(() => (ha.handlers.get(feed)?.length ?? 0) >= 1);
    const priv = zd as unknown as { lastStatsAt: number | null; statsReplayUntil: number };
    const fire = (tx: number): void => {
      for (const h of ha.handlers.get(feed) ?? []) {
        h({ event: { source: 'node', node_id: 7, nodeId: 7, commands_tx: tx, commands_rx: 1,
          commands_dropped_tx: 0, commands_dropped_rx: 0, timeout_response: 0 } } as never);
      }
    };
    // The window is opened by the SUBSCRIBE path itself, not only by this test
    // poking the field — boot just subscribed, so it must already be armed.
    assert.ok(priv.statsReplayUntil > 0, 'subscribeStatistics must open the replay window');
    // 1. INSIDE the replay window: the snapshot describes the past.
    priv.lastStatsAt = Date.now() - 20 * 60_000;
    const stale = priv.lastStatsAt;
    priv.statsReplayUntil = Date.now() + 15_000;
    fire(11);
    assert.equal(priv.lastStatsAt, stale,
      'a replayed snapshot must not zero the blindness clock — that is the sawtooth');
    // 2. OUTSIDE it, the very same event is the feed proving itself alive.
    priv.statsReplayUntil = 0;
    fire(12);
    assert.ok(priv.lastStatsAt != null && priv.lastStatsAt > stale,
      'a real post-replay event must still mark the feed alive, or the alarm false-fires');
    // 3. The CONTROLLER's snapshot is replayed by every re-subscribe too, and
    //    it writes the same fleet clock — so it carries the same guard.
    const ctrlFeed = 'zwave_js/subscribe_controller_statistics';
    await waitFor(() => (ha.handlers.get(ctrlFeed)?.length ?? 0) >= 1);
    const fireCtrl = (tx: number): void => {
      for (const h of ha.handlers.get(ctrlFeed) ?? []) {
        h({ event: { source: 'controller', messages_tx: tx, messages_rx: 1, messages_dropped_tx: 0,
          messages_dropped_rx: 0, nak: 0, can: 0, timeout_ack: 0, timeout_response: 0, timeout_callback: 0 } } as never);
      }
    };
    priv.lastStatsAt = stale;
    priv.statsReplayUntil = Date.now() + 15_000;
    fireCtrl(5);
    assert.equal(priv.lastStatsAt, stale, "the controller's replay must not zero the clock either");
    priv.statsReplayUntil = 0;
    fireCtrl(6);
    assert.ok(priv.lastStatsAt != null && priv.lastStatsAt > stale,
      'and a real controller event still marks the feed alive');
  } finally {
    zd.stop();
  }
});

test('a node too quiet to rate is reported as UNMEASURED, not clear (v0.67.0)', async () => {
  // `windowTimeoutRate` returns null below MIN_WINDOW_TX and all three of its
  // consumers skip silently, so "38/38 ready" concealed nodes that nothing was
  // measuring. Unmeasured is a third state and it has to be published.
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { refreshMs: 60 });
  try {
    await waitFor(() => zd.snapshot().length > 0);
    const inner = zd as unknown as { evidence: (id: number) => unknown[]; baselines: unknown };
    const realEv = inner.evidence;
    const realBl = inner.baselines;
    try {
      // The engine reports `enabled: false` without a baselines store, and that
      // shape has no per-node loop at all.
      inner.baselines = { timeoutNormal: () => ({ ready: true }), rttNormal: () => ({ ready: true }),
        rssiNormal: () => ({ ready: true }) };
      inner.evidence = () => [];                       // no traffic at all to rate
      const blind = zd.engineStatus();
      assert.ok(blind.total > 0, 'fixture guard: there are scoreable nodes');
      assert.equal(blind.timeoutWindowBlind, blind.total, 'every unrateable node is counted');
      const now = Date.now();
      // …and a node with real traffic past the floor is NOT counted.
      inner.evidence = () => Array.from({ length: 25 }, (_, i) => ({ t: now - i * 1000, dTx: 1, dTimeout: 0 }));
      assert.equal(zd.engineStatus().timeoutWindowBlind, 0, 'a node above the floor is measured, not blind');
    } finally {
      inner.evidence = realEv;
      inner.baselines = realBl;
    }
  } finally {
    zd.stop();
  }
});

test('a routed read targets the node\'s own switch value, and nothing that merely LOOKS like one (v0.70.0)', async () => {
  const ent = (entity_id: string, unique_id: string, over: Record<string, unknown> = {}) =>
    ({ entity_id, unique_id, device_id: DEV_ID, disabled_by: null, platform: 'zwave_js', original_name: entity_id, ...over });
  const cases: Array<[string, Array<Record<string, unknown>>, string | null]> = [
    ['the switch currentValue', [ent('switch.node_seven', `${HOME}.7-37-0-currentValue`)], 'switch.node_seven'],
    ['a multilevel light', [ent('light.node_seven', `${HOME}.7-38-0-currentValue`)], 'light.node_seven'],
    // Both orders: "lowest wins" must not be "first wins" or "last wins" in disguise.
    ['the lowest endpoint wins (listed last)', [ent('switch.node_seven_2', `${HOME}.7-37-2-currentValue`), ent('switch.node_seven_1', `${HOME}.7-37-1-currentValue`)], 'switch.node_seven_1'],
    ['the lowest endpoint wins (listed first)', [ent('switch.node_seven_1', `${HOME}.7-37-1-currentValue`), ent('switch.node_seven_2', `${HOME}.7-37-2-currentValue`)], 'switch.node_seven_1'],
    ['a config-parameter switch (CC 112) is not a value to read', [ent('switch.node_seven_led', `${HOME}.7-112-0-3`)], null],
    ['node-level entities are not values', [ent('sensor.node_seven_node_status', `${HOME}.7.node_status`), ent('button.node_seven_ping', `${HOME}.7.ping`)], null],
    ['a switch_as_x wrapper is a different platform', [ent('light.node_seven', `${HOME}.7-37-0-currentValue`, { platform: 'switch_as_x' })], null],
    ['a value id naming ANOTHER node is refused', [ent('switch.node_seven', `${HOME}.9-37-0-currentValue`)], null],
    ['a disabled entity is ignored', [ent('switch.node_seven', `${HOME}.7-37-0-currentValue`, { disabled_by: 'user' })], null],
    ['no unique_id at all', [ent('switch.node_seven', '', { unique_id: undefined })], null],
  ];
  for (const [label, reg, want] of cases) {
    entityRegistry = reg;
    const ha = fakeHa();
    const zd = await bootedZwaveData(ha, { refreshMs: 60 });
    try {
      await waitFor(() => zd.snapshot().length > 0);
      assert.equal(zd.readEntityOf(7), want, label);
    } finally {
      zd.stop();
      entityRegistry = null;
    }
  }
});

/* ── v0.71.0: a route our own read changed, and the runner's death feed ──── */

/** A zwaveData with an evidence store and a ledger, plus the private handles
 *  the v0.71.0 tests drive. */
async function rerouteZd(prefix: string) {
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const logged: string[] = [];
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
    log: (m: string) => { logged.push(m); },
  });
  await waitFor(() => zd.snapshot().some((n: NodeSnapshot) => n.nodeId === 7), 4000);
  const priv = zd as unknown as {
    ourTxReport: Map<number, { until: number }>;
    noteDeadCrossing: (id: number, died: boolean) => void;
    measurementReroutes: Set<number>;
    routeChangeAccum: Map<number, number>;
    statusSubbed: Set<number>;
    lastOkAt: number | null;
    sampleEvidence: () => void;
    snapshot: () => NodeSnapshot[];
    updateEpisodes: (s: unknown[], now: number) => void;
    outcomes: { markConfounded: (n: number | null, k: string) => void };
  };
  const direct = { repeaters: [], rssi: -80, repeater_rssi: [], route_failed_between: null, protocol_data_rate: 2 };
  const failedOver = { repeaters: ['dev-9'], rssi: -60, repeater_rssi: [-58], route_failed_between: [DEV_ID, 'dev-9'], protocol_data_rate: 3 };
  const quietChange = { repeaters: ['dev-9'], rssi: -60, repeater_rssi: [-58], route_failed_between: null, protocol_data_rate: 3 };
  let tx = 10;
  let last: Record<string, unknown> = direct;
  const route = (lwr: Record<string, unknown>) => { tx += 1; last = lwr; pushStats(ha, statsEvent({ commands_tx: tx, commands_rx: tx, lwr })); };
  /** The shape zwave-js's statistics throttle gives one TX report on a quiet
   *  node: the counter increment at once, with the OLD route, then the route
   *  that report carried in the trailing emit ~250 ms later, counters unchanged. */
  const split = (lwr: Record<string, unknown>) => {
    tx += 1;
    pushStats(ha, statsEvent({ commands_tx: tx, commands_rx: tx - 1, lwr: last }));
    last = lwr;
    pushStats(ha, statsEvent({ commands_tx: tx, commands_rx: tx, lwr }));
  };
  route(direct);                                                       // the first event is a replay: the baseline route
  return { ha, dir, zd, priv, logged, route, split, direct, failedOver, quietChange,
    stop: () => { zd.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a SWEEP routed read that fails over is ours: logged, counted into the node\'s reroutes, and kept out of route churn (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-');
  try {
    const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.route(R.failedOver);
    assert.equal(R.priv.measurementReroutes.has(7), true, 'marked for the confound guard');
    assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0, 'not route CHURN: our own failover is not the mesh re-routing');
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes, 1, 'counted into the persisted stored-route failovers');
    assert.ok(R.logged.some((l) => /auto-ping: node 7's stored route failed on our sweep routed read and the controller delivered it by another/.test(l)),
      JSON.stringify(R.logged));
  } finally { R.stop(); }
});

test('a route change our read did NOT cause — a NoOp probe, a read past the grace, a read that did not fail over, or no probe at all — is route churn as before and confounds nothing (v0.71.0)', async () => {
  const cases: Array<[string, (zd: ZwaveData) => void, 'failedOver' | 'quietChange']> = [
    ['a NoOp cannot compute a route', (zd) => zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'ping'), 'failedOver'],
    ['a read long past the answer grace', (zd) => zd.noteMeasurementProbe(7, Date.now() - 100_000, 'sweep', 'read'), 'failedOver'],
    ['a read that did not fail over only REVEALED the change', (zd) => zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read'), 'quietChange'],
    ['no probe of ours at all', () => {}, 'failedOver'],
  ];
  for (const [label, arrange, lwr] of cases) {
    const R = await rerouteZd('zwtui-reroute-not-');
    try {
      const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
      arrange(R.zd);
      R.route(lwr === 'failedOver' ? R.failedOver : R.quietChange);
      assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0 + 1, `${label}: still route churn`);
      assert.equal(R.priv.measurementReroutes.has(7), false, `${label}: not ours`);
      assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes ?? 0, 0, `${label}: not a stored-route failover of ours`);
    } finally { R.stop(); }
  }
});

test('a VERIFICATION read that fails over is ours, but only the sweep feeds the persisted reroute count (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-verify-');
  try {
    R.zd.noteMeasurementProbe(7, Date.now(), 'verify', 'read');
    R.route(R.failedOver);
    assert.equal(R.priv.measurementReroutes.has(7), true, 'it still confounds');
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes ?? 0, 0, 'a symptom-correlated burst stays out of the comparable count');
    assert.ok(R.logged.some((l) => /failed on our verification routed read/.test(l)));
  } finally { R.stop(); }
});

test('our read\'s failover confounds the node\'s open rate, RTT, signal, return-path and route-churn episodes — not dead-flap, quiet-node or s2-desync — and is consumed by one engine pass (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-confound-');
  try {
    const real = R.priv.snapshot();
    const asAlive = real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    R.priv.snapshot = () => asAlive;
    const marked: Array<[number | null, string]> = [];
    const orig = R.priv.outcomes.markConfounded.bind(R.priv.outcomes);
    R.priv.outcomes.markConfounded = (n, k) => { marked.push([n, k]); orig(n, k); };
    const t0 = 1_800_000_000_000;
    const kinds = ['rate-fallback', 'rtt-degraded', 'weak-signal', 'return-path-degraded', 'chronic-return-path',
      'dead-flap', 'route-churn', 'quiet-node', 's2-desync'];
    const syms = kinds.map((kind) => ({ kind, nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }));
    R.priv.updateEpisodes(syms, t0);                                    // episodes open, nothing re-routed
    assert.equal(marked.length, 0, 'fixture guard: nothing is confounded before the failover');
    const open = new Set((R.zd.openEpisodes() ?? []).filter((e) => e.nodeId === 7).map((e) => e.kind));
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.route(R.failedOver);
    R.priv.updateEpisodes(syms, t0 + 60_000);
    assert.deepEqual([...open].sort(), [...kinds].sort(), 'fixture guard: every kind has an open episode');
    const hit = [...new Set(marked.filter(([n]) => n === 7).map(([, k]) => k))].sort();
    assert.deepEqual(hit, ['chronic-return-path', 'rate-fallback', 'return-path-degraded', 'route-churn', 'rtt-degraded', 'weak-signal'],
      'the kinds a new route can clear by itself, and route-churn, whose accumulator our failover is kept out of');
    R.priv.lastOkAt = Date.now();
    R.priv.sampleEvidence();
    assert.equal(R.priv.measurementReroutes.size, 0, 'consumed by the engine pass, not latched');
  } finally { R.stop(); }
});

test('recordProbeResult forwards the frame, and evidenceCoverage carries the read counters (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-probe-frame-');
  try {
    R.zd.recordProbeResult(7, true, 'echo-only', 'read');
    R.zd.recordProbeResult(7, false, 'echo-only', 'read');
    R.zd.recordProbeResult(7, true, 'echo-only', 'ping');
    const cov = R.zd.evidenceCoverage(7)!;
    assert.deepEqual([cov.probesAsked, cov.probesAnswered, cov.probesReadAsked, cov.probesReadAnswered], [3, 2, 2, 1]);
  } finally { R.stop(); }
});

test('each Alive→Dead transition reaches the runner once — from the status feed, or the roster diff for a node without one (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-deaths-');
  try {
    R.zd.drainDeadEvents();
    const feed = (event: string) => { for (const h of R.ha.handlers.get('zwave_js/subscribe_node_status') ?? []) h({ event: { event } } as never); };
    R.route(R.direct);                                                 // a counted TX: the node now has a lastSeen
    const seenBefore = (R.priv as unknown as { statsByNode: Map<number, { lastSeen: number | null }> }).statsByNode.get(7)?.lastSeen ?? null;
    assert.ok(seenBefore != null, 'fixture guard: a real lastSeen to carry');
    feed('alive'); feed('dead');
    assert.deepEqual(R.zd.drainDeadEvents(), [], 'a death not yet seen to clear stays with the roster — the runner must not book it twice');
    feed('alive'); feed('alive');
    const first = R.zd.drainDeadEvents();
    assert.deepEqual(first.map((d) => d.nodeId), [7], 'one death, one entry, once it cleared — a revival is not a death');
    assert.ok(Math.abs(first[0].at - Date.now()) < 5_000, 'stamped when it was seen');
    assert.equal(first[0].seen, seenBefore, "it carries the node's lastSeen as of the death");
    assert.equal(first[0].feedLive, true, 'with its statistics feed live');
    assert.ok(first[0].clearedAt != null && first[0].clearedAt >= first[0].at, 'and when the feed saw it clear');
    assert.deepEqual(R.zd.drainDeadEvents(), [], 'drained, not latched');
    // The roster-diff fallback, for a node whose status subscription failed.
    R.priv.statusSubbed.delete(7);
    rosterNodes = [{ ...NODE7, status: 3 }];
    await waitFor(() => R.zd.snapshot().find((n) => n.nodeId === 7)?.status === NodeStatus.Dead, 4000);
    assert.deepEqual(R.zd.drainDeadEvents(), [], 'still Dead: not handed over');
    rosterNodes = [NODE7];
    await waitFor(() => R.zd.snapshot().find((n) => n.nodeId === 7)?.status === NodeStatus.Alive, 4000);
    assert.deepEqual(R.zd.drainDeadEvents().map((d) => d.nodeId), [7], 'the fallback feeds it too, once it cleared');
  } finally {
    rosterNodes = [NODE7];
    R.stop();
  }
});

test('drainVerifyRequests leaves a SKIPPED node\'s burst owed, and hands it out once the skip lifts (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-verify-skip-');
  try {
    (R.zd as unknown as { requestVerification: (n: number) => void }).requestVerification(7);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 10; i++) assert.deepEqual(R.zd.drainVerifyRequests(t0 + i * 80_000, (id) => id === 7), [], 'held: nothing handed out');
    assert.equal(R.zd.verifyOwedCount(), 1, 'and nothing spent — the burst is still owed');
    const got: number[] = [];
    for (let i = 10; i < 20; i++) got.push(...R.zd.drainVerifyRequests(t0 + i * 80_000).map((e) => e.id));
    assert.equal(got.length, 5, `the whole burst goes out after the hold: ${JSON.stringify(got)}`);
  } finally { R.stop(); }
});

test('only the statistics event carrying OUR read\'s TX report can be ours — a later frame\'s failover inside the grace is route churn (v0.71.0)', async () => {
  // zwave-js rewrites lwr from every frame's TX report: the ladder's retry, an
  // operator's ping or an automation's command 30 s after our read would all
  // look like our read's failover to a 90 s window alone.
  const R = await rerouteZd('zwtui-reroute-ours-');
  try {
    const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.route(R.direct);                                                 // our read's own report: delivered, no change
    R.route(R.failedOver);                                             // someone else's frame fails over
    assert.equal(R.priv.measurementReroutes.has(7), false, 'the stamp was consumed by our own frame');
    assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0 + 1, 'the later failover is ordinary route churn');
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes ?? 0, 0);
  } finally { R.stop(); }
});

test('a node marked Dead drops its measurement stamp — the next frame to reach it is not our probe\'s report (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-dead-');
  try {
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    for (const h of R.ha.handlers.get('zwave_js/subscribe_node_status') ?? []) { h({ event: { event: 'alive' } } as never); h({ event: { event: 'dead' } } as never); }
    R.route(R.failedOver);                                             // the ladder's frame, after the death
    assert.equal(R.priv.measurementReroutes.has(7), false, 'an unacknowledged read was not delivered, by any route');
  } finally { R.stop(); }
});

test('the route event in the Log ring says when the failover was our read\'s (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-ring-');
  try {
    R.zd.noteMeasurementProbe(7, Date.now(), 'verify', 'read');
    R.route(R.failedOver);
    const ev = R.zd.events().filter((e) => e.kind === 'route' && e.nodeId === 7).map((e) => e.text);
    assert.ok(ev.some((x) => /^route → .* \(our verification routed read failed over \d+s after it went out\)$/.test(x)), JSON.stringify(ev));
  } finally { R.stop(); }
});

test('the death queue is bounded when nothing drains it — auto-ping off means no reader (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-deaths-cap-');
  try {
    const feed = (event: string) => { for (const h of R.ha.handlers.get('zwave_js/subscribe_node_status') ?? []) h({ event: { event } } as never); };
    feed('alive');
    for (let i = 0; i < 260; i++) { feed('dead'); feed('alive'); }
    const q = (R.zd as unknown as { deadEvents: unknown[] }).deadEvents;
    assert.equal(q.length, 200, 'held at the cap, oldest dropped');
    assert.equal(R.zd.drainDeadEvents().length, 200);
  } finally { R.stop(); }
});

test('a statistics event that moves no TX counter does not consume the stamp — the node\'s own report is not our read\'s TX report (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-rx-');
  try {
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    pushStats(R.ha, statsEvent({ commands_tx: 11, commands_rx: 11, rssi: -55, lwr: R.direct }));   // no TX movement (an RSSI refresh)
    R.route(R.failedOver);                                             // then our read's own TX report
    assert.equal(R.priv.measurementReroutes.has(7), true, 'our read\'s failover is still ours');
  } finally { R.stop(); }
});

test('our read\'s failover is attributed when the throttle SPLITS its TX report — counters first, the route 250 ms later (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-split-');
  try {
    const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.split(R.failedOver);
    assert.equal(R.priv.measurementReroutes.has(7), true, 'the trailing emit carries our read\'s route');
    assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0, 'and it is not route churn');
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes, 1);
    assert.ok(R.logged.some((l) => /its open rate, RTT, signal, return-path and route-churn episodes are confounded$/.test(l)), JSON.stringify(R.logged));
  } finally { R.stop(); }
});

test('the trailing window closes: once the counters move again, or after its deadline, a failover is not ours (v0.71.0)', async () => {
  const moved = await rerouteZd('zwtui-reroute-moved-');
  try {
    const churn0 = moved.priv.routeChangeAccum.get(7) ?? 0;
    moved.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    moved.split(moved.direct);                                          // our read: delivered on the stored route
    moved.split(moved.failedOver);                                      // the next frame's report fails over
    assert.equal(moved.priv.measurementReroutes.has(7), false, 'another frame\'s TX report is not ours');
    assert.equal(moved.priv.routeChangeAccum.get(7) ?? 0, churn0 + 1);
  } finally { moved.stop(); }
  const late = await rerouteZd('zwtui-reroute-late-');
  try {
    late.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    pushStats(late.ha, statsEvent({ commands_tx: 12, commands_rx: 11, lwr: late.direct }));   // our counters…
    late.priv.ourTxReport.get(7)!.until = Date.now() - 1;                                        // …and the window lapses
    pushStats(late.ha, statsEvent({ commands_tx: 12, commands_rx: 12, lwr: late.failedOver }));
    assert.equal(late.priv.measurementReroutes.has(7), false, 'a route arriving after the window is not attributed');
  } finally { late.stop(); }
});

test('a read whose launch was refused withdraws its stamp — a later frame\'s failover is route churn (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-withdrawn-');
  try {
    const at = Date.now();
    R.zd.noteMeasurementProbe(7, at, 'sweep', 'read');
    R.zd.clearMeasurementProbe(7, at - 1);                              // a different stamp: kept
    R.zd.clearMeasurementProbe(7, at);                                  // this one never left
    R.route(R.failedOver);
    assert.equal(R.priv.measurementReroutes.has(7), false);
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes ?? 0, 0);
  } finally { R.stop(); }
  const kept = await rerouteZd('zwtui-reroute-kept-');
  try {
    const at = Date.now();
    kept.zd.noteMeasurementProbe(7, at, 'sweep', 'read');
    kept.zd.clearMeasurementProbe(7, at - 1);
    kept.route(kept.failedOver);
    assert.equal(kept.priv.measurementReroutes.has(7), true, 'only the matching stamp is withdrawn');
  } finally { kept.stop(); }
});

test('the stamp counts dropped TX too — an RX-only report on a node with past drops does not consume it (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-drops-');
  try {
    pushStats(R.ha, statsEvent({ commands_tx: 12, commands_rx: 12, commands_dropped_tx: 2, lwr: R.direct }));
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    pushStats(R.ha, statsEvent({ commands_tx: 12, commands_rx: 13, commands_dropped_tx: 2, lwr: R.direct }));   // the node's own report
    pushStats(R.ha, statsEvent({ commands_tx: 13, commands_rx: 14, commands_dropped_tx: 2, lwr: R.failedOver })); // our read
    assert.equal(R.priv.measurementReroutes.has(7), true);
  } finally { R.stop(); }
});

test('a revival clears only THAT node\'s queued deaths (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-deaths-other-');
  try {
    R.zd.drainDeadEvents();
    R.priv.noteDeadCrossing(9, true);                                   // node 9 dies and stays Dead
    R.priv.noteDeadCrossing(7, true);
    R.priv.noteDeadCrossing(7, false);                                  // node 7 revives
    assert.deepEqual(R.zd.drainDeadEvents().map((d) => d.nodeId), [7], "node 9's death is not handed over by node 7's revival");
  } finally { R.stop(); }
});

test('one TX report is judged once — a second route change inside its trailing window is route churn (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-once-');
  try {
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.route(R.failedOver);                                              // ours, judged
    const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
    // Back to direct inside the window, still failed over (unknown repeater ids all resolve to 0, so a
    // second repeater would read as the same route).
    pushStats(R.ha, statsEvent({ commands_tx: 12, commands_rx: 12, lwr: { ...R.direct, route_failed_between: [DEV_ID, 'dev-9'] } }));
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes, 1, 'not counted twice');
    assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0 + 1);
  } finally { R.stop(); }
});

test('an event whose counters moved by MORE than one TX report is not attributed — its route is a later frame\'s (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-coalesced-');
  try {
    const churn0 = R.priv.routeChangeAccum.get(7) ?? 0;
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    pushStats(R.ha, statsEvent({ commands_tx: 13, commands_rx: 13, lwr: R.failedOver }));   // ours + another, coalesced
    assert.equal(R.priv.measurementReroutes.has(7), false);
    assert.equal(R.priv.routeChangeAccum.get(7) ?? 0, churn0 + 1, 'the later frame\'s failover is churn');
  } finally { R.stop(); }
});

test('a refused read also withdraws a TX report already taken for its own (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-reroute-refused-held-');
  try {
    const at = Date.now();
    R.zd.noteMeasurementProbe(7, at, 'sweep', 'read');
    pushStats(R.ha, statsEvent({ commands_tx: 12, commands_rx: 11, lwr: R.direct }));   // another frame's counters…
    R.zd.clearMeasurementProbe(7, at);                                                  // …then HA refuses our read
    pushStats(R.ha, statsEvent({ commands_tx: 12, commands_rx: 12, lwr: R.failedOver })); // that frame's route
    assert.equal(R.priv.measurementReroutes.has(7), false, 'a read that never left owns no TX report');
    assert.equal(R.zd.evidenceCoverage(7)?.probeReroutes ?? 0, 0);
  } finally { R.stop(); }
});

test('a death on a node whose statistics feed is not live says so — its lastSeen is no reading (v0.71.0)', async () => {
  const R = await rerouteZd('zwtui-deaths-feed-');
  try {
    R.zd.drainDeadEvents();
    (R.zd as unknown as { statsSubbedNodes: Set<number> }).statsSubbedNodes.delete(7);
    R.priv.noteDeadCrossing(7, true);
    R.priv.noteDeadCrossing(7, false);
    assert.deepEqual(R.zd.drainDeadEvents().map((d) => d.feedLive), [false]);
  } finally { R.stop(); }
});

/* ── v0.72.0: the owner's pause reaches the data layer ─────────────────── */

test('the HA pause toggle is read from get_states even before the registry loads, and its state_changed is never a value row (v0.72.0)', async () => {
  const { PAUSE_ENTITY } = await import('../src/zwave/autonomyPause');
  const ha = fakeHa();
  entityRegistry = [];
  extraStates = [{ entity_id: PAUSE_ENTITY, state: 'on', attributes: {}, last_changed: '2026-09-23T14:02:00.000Z' }];
  const zd = await bootedZwaveData(ha);
  try {
    await waitFor(() => zd.autonomyPause() != null);
    assert.deepEqual(zd.autonomyPause()?.by, ['ha']);
    const since = zd.autonomyPause()!.since;
    assert.ok(Math.abs(since - Date.now()) < 60_000, 'aged from when this add-on first saw it pausing, not last_changed');
    const before = zd.events().length;
    for (const h of [...(ha.handlers.get('state_changed') ?? [])]) {
      h({ event: { data: { entity_id: PAUSE_ENTITY, old_state: { state: 'on' }, new_state: { state: 'off', last_changed: '2026-09-23T15:00:00.000Z' } } } } as never);
    }
    assert.equal(zd.autonomyPause(), null, 'off clears the HA source');
    const added = zd.events().slice(0, zd.events().length - before);
    assert.ok(added.every((e) => e.kind !== 'value'), `the toggle is not logged as a device value: ${JSON.stringify(added)}`);
    assert.ok(added.some((e) => e.source === 'engine' && e.severity === 'warn' && /autonomy: RESUMED/.test(e.text)),
      'the transition reaches the Log ring at WARN');
  } finally {
    entityRegistry = null;
    extraStates = [];
    zd.stop();
  }
});

test('a toggle absent from a full read keeps a remembered pause; a deletion event forgets it (v0.72.0 review)', async () => {
  const { PAUSE_ENTITY } = await import('../src/zwave/autonomyPause');
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-pause-absent-'));
  const path = join(dir, 'autonomy.json');
  // Seeded, so the assertion below cannot pass on "never remembered" (the
  // first cut of this test did exactly that).
  writeFileSync(path, JSON.stringify({ v: 1, tui: null, ha: { last: 'on', at: 1, since: 1 } }));
  const ha = fakeHa();
  const zd = await bootedZwaveData(ha, { autonomyPath: path });
  try {
    await waitFor(() => /missing from Home Assistant's states/.test(zd.autonomyPause()?.reason ?? ''));
    assert.deepEqual(zd.autonomyPause()?.by, ['ha'], 'the full read ran and did not unpause');
    for (const h of [...(ha.handlers.get('state_changed') ?? [])]) {
      h({ event: { data: { entity_id: PAUSE_ENTITY, old_state: { state: 'on' }, new_state: null } } } as never);
    }
    assert.equal(zd.autonomyPause(), null, 'deleted');
    const { readFileSync } = await import('node:fs');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).ha, null, 'and forgotten on disk');
  } finally { zd.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('an action is dated from its LAUNCH: a symptom that cleared while it ran is credited to it, and the episode waits for it (v0.72.0 review)', async () => {
  const R = await rerouteZd('zwtui-launch-');
  try {
    const real = R.priv.snapshot();
    R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    const oc = (R.zd as unknown as { outcomes: { openEpisodeDetails: () => { kind: string; actionKind: string | null; confounded: boolean }[] } }).outcomes;
    const t0 = 1_800_000_000_000;
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    R.priv.updateEpisodes(sym, t0);
    R.zd.noteActionLaunched('healNode', 7, 'you', t0 + 60_000, true);          // a long heal starts
    R.priv.updateEpisodes([], t0 + 2 * 60_000);                               // the symptom clears DURING it
    R.priv.updateEpisodes([], t0 + 20 * 60_000);                              // confirmation window long past…
    assert.equal(oc.openEpisodeDetails().length, 1, '…but the episode waits for the heal');
    R.zd.recordActionOutcome('healNode', 7, true, undefined, 'you', t0 + 60_000, true);
    R.zd.noteActionSettled('healNode', 7, 'you', t0 + 60_000, t0 + 20 * 60_000);
    assert.equal(oc.openEpisodeDetails()[0].actionKind, 'healNode', 'credited: it cleared after the heal was sent');
    assert.equal(oc.openEpisodeDetails()[0].confounded, false);
    R.priv.updateEpisodes([], t0 + 29 * 60_000);
    assert.equal(oc.openEpisodeDetails().length, 1, 'the confirmation window restarts at the settle (second review)…');
    R.priv.updateEpisodes([], t0 + 31 * 60_000);
    assert.equal(oc.openEpisodeDetails().length, 0, '…and it closes a full window after it');
  } finally { R.stop(); }
});

test('FLiRS counts as listening for commands; a sleeper does not; unknown stays unknown (v0.72.0 review)', async () => {
  const R = await rerouteZd('zwtui-flirs-');
  try {
    const dl = (R.zd as unknown as { driverListening: Map<number, { isListening: boolean | null; isFrequentListening: boolean | null }> }).driverListening;
    dl.set(7, { isListening: false, isFrequentListening: true });
    assert.equal(R.zd.listensForCommands(7), true);
    dl.set(7, { isListening: false, isFrequentListening: false });
    assert.equal(R.zd.listensForCommands(7), false);
    dl.set(7, { isListening: false, isFrequentListening: null });
    assert.equal(R.zd.listensForCommands(7), null);
    dl.delete(7);
    assert.equal(R.zd.listensForCommands(7), null);
  } finally { R.stop(); }
});

test('entering a pause clears what verification owed, and nothing is owed while paused (v0.72.0)', async () => {
  const R = await rerouteZd('zwtui-pause-owed-');
  try {
    const req = (R.zd as unknown as { requestVerification: (n: number) => boolean }).requestVerification.bind(R.zd);
    assert.equal(req(7), true);
    assert.equal(R.zd.verifyOwedCount(), 1, 'precondition: a burst is owed');
    R.zd.pauseAutonomy('tui');
    assert.equal(R.zd.verifyOwedCount(), 0, 'the pause cleared it');
    assert.equal(req(7), false, 'refused while paused');
    assert.equal(R.zd.verifyOwedCount(), 0);
    assert.deepEqual(R.zd.resumeAutonomy(), { resumed: true, stillPausedBy: null });
    assert.equal(req(7), true, 'accepted again once resumed');
  } finally { R.stop(); }
});

test('an episode open during a pause is confounded — it got none of the checks the baseline gets (v0.72.0)', async () => {
  const R = await rerouteZd('zwtui-pause-confound-');
  try {
    const real = R.priv.snapshot();
    const asAlive = real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    R.priv.snapshot = () => asAlive;
    const marked: Array<[number | null, string]> = [];
    const orig = R.priv.outcomes.markConfounded.bind(R.priv.outcomes);
    R.priv.outcomes.markConfounded = (n, k) => { marked.push([n, k]); orig(n, k); };
    const t0 = 1_800_000_000_000;
    const syms = ['rtt-degraded', 'dead-flap'].map((kind) => ({ kind, nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }));
    R.priv.updateEpisodes(syms, t0);
    assert.equal(marked.length, 0, 'running: nothing confounded');
    R.zd.pauseAutonomy('tui');
    R.priv.updateEpisodes(syms, t0 + 30_000);
    assert.equal(marked.length, 0, 'auto-ping off: the pause changes nothing these episodes would have received (v0.72.0 review)');
    R.zd.setAutoPingSnapshot(() => ({ suppressed: 'paused' }) as never);
    R.priv.updateEpisodes(syms, t0 + 60_000);
    assert.deepEqual([...new Set(marked.map(([n, k]) => `${n}:${k}`))].sort(), ['7:dead-flap', '7:rtt-degraded'],
      'every open episode, dead-flap included: the pause is external to what it measures');
  } finally { R.stop(); }
});

test('a check burst the pause refused is still owed when the pause lifts inside its window (v0.72.0)', async () => {
  const R = await rerouteZd('zwtui-pause-burst-');
  try {
    const real = R.priv.snapshot();
    const asAlive = real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    R.priv.snapshot = () => asAlive;
    const t0 = 1_800_000_000_000;
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    R.priv.updateEpisodes(sym, t0);                 // open (and its onset burst)
    R.priv.updateEpisodes([], t0 + 60_000);         // gone → confirmation window
    R.zd.pauseAutonomy('tui');
    assert.equal(R.zd.verifyOwedCount(), 0, 'the pause cleared the onset burst');
    R.priv.updateEpisodes([], t0 + 60_000 + 6 * 60_000); // the after-window burst comes due while paused
    assert.equal(R.zd.verifyOwedCount(), 0, 'refused while paused');
    R.zd.resumeAutonomy();
    R.priv.updateEpisodes([], t0 + 60_000 + 7 * 60_000);
    assert.equal(R.zd.verifyOwedCount(), 1, 'the refused burst was not marked sent: it goes out after the resume');
  } finally { R.stop(); }
});

test('the ledger learns WHO acted, dated from the launch; a death ≤15 min after an operator action is counted, a later one is not (v0.72.0)', async () => {
  const R = await rerouteZd('zwtui-actor-');
  try {
    const real = R.priv.snapshot();
    let status = NodeStatus.Alive;
    R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status, isListening: true } : n));
    const oc = (R.zd as unknown as { outcomes: { openEpisodeDetails: () => { kind: string; actionKind: string | null; confounded: boolean }[];
      actorArms: (k: string) => { origin: string; killedAfter: number }[] } }).outcomes;
    const t0 = 1_800_000_000_000;
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    R.priv.updateEpisodes(sym, t0);
    R.zd.recordActionOutcome('refreshValues', 7, true, undefined, 'you', t0 + 1_000, true);
    assert.equal(oc.openEpisodeDetails()[0].actionKind, 'refreshValues', 'attributed at the launch stamp');
    status = NodeStatus.Dead;
    R.priv.updateEpisodes(sym, t0 + 1_000 + 5 * 60_000);
    assert.equal(oc.actorArms('rtt-degraded').find((x) => x.origin === 'you')?.killedAfter, 1, 'Dead 5 min after: counted');
    assert.equal(oc.openEpisodeDetails()[0].confounded, true, 'and confounded');
  } finally { R.stop(); }
  const Q = await rerouteZd('zwtui-actor-late-');
  try {
    const real = Q.priv.snapshot();
    let status = NodeStatus.Alive;
    Q.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status, isListening: true } : n));
    const oc = (Q.zd as unknown as { outcomes: { actorArms: (k: string) => { origin: string; killedAfter: number }[] } }).outcomes;
    const t0 = 1_800_000_000_000;
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    Q.priv.updateEpisodes(sym, t0);
    Q.zd.recordActionOutcome('refreshValues', 7, true, undefined, 'you', t0 + 1_000, true);
    status = NodeStatus.Dead;
    Q.priv.updateEpisodes(sym, t0 + 1_000 + 20 * 60_000);
    assert.equal(oc.actorArms('rtt-degraded').length, 0, 'Dead 20 min after: not charged');
  } finally { Q.stop(); }
});

test('a death on one of OUR measurement probes is not charged to the operator\'s action (v0.72.0)', async () => {
  const R = await rerouteZd('zwtui-own-kill-');
  try {
    const real = R.priv.snapshot();
    R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Dead, isListening: true } : n));
    const oc = (R.zd as unknown as { outcomes: { actorArms: (k: string) => { origin: string; killedAfter: number }[] } }).outcomes;
    const t0 = Date.now();
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    R.priv.updateEpisodes(sym, t0);
    R.zd.recordActionOutcome('refreshValues', 7, true, undefined, 'you', t0 + 1, true);
    R.zd.noteMeasurementProbe(7, Date.now(), 'sweep', 'read');
    R.priv.noteDeadCrossing(7, true);           // died with our probe unanswered
    R.priv.updateEpisodes(sym, t0 + 60_000);
    assert.equal(oc.actorArms('rtt-degraded').find((x) => x.origin === 'you')?.killedAfter ?? 0, 0);
  } finally { R.stop(); }
});

/* ── v0.72.0 second review ─────────────────────────────────────────────── */

async function episodeRig(prefix: string) {
  const R = await rerouteZd(prefix);
  const real = R.priv.snapshot();
  R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
  const oc = (R.zd as unknown as { outcomes: { openEpisodeDetails: () => { kind: string; actionKind: string | null; confounded: boolean }[] } }).outcomes;
  const t0 = 1_800_000_000_000;
  const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
  R.priv.updateEpisodes(sym, t0);
  return { R, oc, t0, sym };
}

test('a heal that reached the driver but did not report success confounds the node\'s episodes (second review)', async () => {
  const E = await episodeRig('zwtui-maybe-');
  try {
    E.R.zd.noteActionLaunched('healNode', 7, 'you', E.t0 + 1_000, true);
    E.R.zd.noteActionSettled('healNode', 7, 'you', E.t0 + 1_000, E.t0 + 90_000, 'maybe');
    assert.equal(E.oc.openEpisodeDetails()[0].confounded, true, 'it cannot close as a spontaneous recovery');
  } finally { E.R.stop(); }
  const F = await episodeRig('zwtui-none-');
  try {
    F.R.zd.noteActionLaunched('healNode', 7, 'you', F.t0 + 1_000, true);
    F.R.zd.noteActionSettled('healNode', 7, 'you', F.t0 + 1_000, F.t0 + 2_000, 'none');
    assert.equal(F.oc.openEpisodeDetails()[0].confounded, false, 'a call that never left changes nothing');
  } finally { F.R.stop(); }
});

test('two learned actions that overlapped on a node credit neither — the reply order decides nothing (second review)', async () => {
  // On the REAL clock (the overlap check reads Date.now() at the reply, as in
  // production): with a synthetic episode clock the ledger's opened-after rule
  // confounded the episode and the test passed with the overlap rule removed.
  const R = await rerouteZd('zwtui-overlap-');
  const real = R.priv.snapshot();
  R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
  const oc = (R.zd as unknown as { outcomes: { openEpisodeDetails: () => { kind: string; actionKind: string | null; confounded: boolean }[] } }).outcomes;
  const t0 = Date.now() - 10 * 60_000;
  R.priv.updateEpisodes([{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }], t0);
  const E = { R, oc };
  try {
    const now = Date.now();
    E.R.zd.noteActionLaunched('healNode', 7, 'you', now - 60_000, true);   // a long heal, left running after Esc
    E.R.zd.noteActionLaunched('ping', 7, 'you', now - 30_000, true);
    E.R.zd.recordActionOutcome('ping', 7, true, undefined, 'you', now - 30_000, true); // the ping answers first
    const ep = E.oc.openEpisodeDetails()[0];
    assert.equal(ep.actionKind, null, 'the ping does not take the heal\'s credit');
    assert.equal(ep.confounded, true);
  } finally { E.R.stop(); }
});

test('a mesh-wide rebuild holds every episode open and confounds it (second review)', async () => {
  const E = await episodeRig('zwtui-meshrebuild-');
  try {
    const lc = E.R.zd as unknown as { lastController: Record<string, unknown> | null };
    lc.lastController = { ...(lc.lastController ?? {}), isRebuildingRoutes: true };
    E.R.priv.updateEpisodes([], E.t0 + 60_000);
    E.R.priv.updateEpisodes([], E.t0 + 30 * 60_000);
    assert.equal(E.oc.openEpisodeDetails().length, 1, 'held while the controller rebuilds');
    assert.equal(E.oc.openEpisodeDetails()[0].confounded, true);
    lc.lastController = { ...lc.lastController, isRebuildingRoutes: false };
    E.R.priv.updateEpisodes([], E.t0 + 31 * 60_000);             // the rebuild ends here
    E.R.priv.updateEpisodes([], E.t0 + 40 * 60_000);
    assert.equal(E.oc.openEpisodeDetails().length, 1, 'a full confirmation window after the rebuild ended');
    E.R.priv.updateEpisodes([], E.t0 + 42 * 60_000);
    assert.equal(E.oc.openEpisodeDetails().length, 0);
  } finally { E.R.stop(); }
});

test('an after-window burst sent while an action ran is sent again once it settles (second review)', async () => {
  const E = await episodeRig('zwtui-burst-hold-');
  try {
    // Probes are spaced per node, so each drain call must move the clock on.
    const drain = () => { let t = Date.now() + 10 * 86_400_000; while (E.R.zd.drainVerifyRequests(t).length) t += 3_600_000; };
    E.R.priv.updateEpisodes([], E.t0 + 60_000);                      // symptom gone: confirmation starts
    drain();
    E.R.priv.updateEpisodes([], E.t0 + 6 * 60_000 + 1_000);          // the after-window burst goes out on the old clock…
    assert.equal(E.R.zd.verifyOwedCount(), 1, 'fixture guard: the burst was sent before the heal');
    drain();
    E.R.zd.noteActionLaunched('healNode', 7, 'you', E.t0 + 7 * 60_000, true);   // …then a heal starts
    E.R.priv.updateEpisodes([], E.t0 + 10 * 60_000);                 // held: that burst no longer fits
    E.R.zd.noteActionSettled('healNode', 7, 'you', E.t0 + 7 * 60_000, E.t0 + 12 * 60_000, 'ok');
    E.R.priv.updateEpisodes([], E.t0 + 13 * 60_000);
    assert.equal(E.R.zd.verifyOwedCount(), 0, 'not yet: the settled after-window starts 5 min after the settle');
    E.R.priv.updateEpisodes([], E.t0 + 17 * 60_000 + 1_000);
    assert.equal(E.R.zd.verifyOwedCount(), 1, 'sent again, inside the settled after-window');
  } finally { E.R.stop(); }
});

test('a Home Assistant reconnect resets the toggle\'s reading order (second and third review)', async () => {
  const { PAUSE_ENTITY } = await import('../src/zwave/autonomyPause');
  const ha = fakeHa();
  extraStates = [{ entity_id: PAUSE_ENTITY, state: 'off', attributes: {}, last_changed: '2026-01-01T00:00:00.000Z' }];
  const zd = await bootedZwaveData(ha);
  const fetchStates = (zd as unknown as { fetchEntityStates: () => Promise<void> }).fetchEntityStates.bind(zd);
  try {
    await waitFor(() => (ha.handlers.get('state_changed') ?? []).length > 0);
    for (const h of [...(ha.handlers.get('state_changed') ?? [])]) {
      h({ event: { data: { entity_id: PAUSE_ENTITY, old_state: null, new_state: { state: 'on', last_changed: new Date().toISOString() } } } } as never);
    }
    assert.deepEqual(zd.autonomyPause()?.by, ['ha'], 'the live event pauses');
    await fetchStates();
    assert.deepEqual(zd.autonomyPause()?.by, ['ha'], 'a state list older than that event is ignored');
    ha.fireReady();
    await waitFor(() => zd.autonomyPause() == null, 4000);   // the new connection's full read applies
  } finally { extraStates = []; zd.stop(); }
});

test('an episode that opens while an UNKNOWN heal may still be running is confounded; a never-sent heal holds nothing (third review)', async () => {
  const R = await rerouteZd('zwtui-maybe-later-');
  try {
    const real = R.priv.snapshot();
    R.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    const oc = (R.zd as unknown as { outcomes: { openEpisodeDetails: () => { kind: string; confounded: boolean }[] } }).outcomes;
    const t0 = 1_800_000_000_000;
    R.zd.noteActionLaunched('healNode', 7, 'you', t0, true);
    R.zd.noteActionSettled('healNode', 7, 'you', t0, t0 + 20 * 60_000, 'maybe');     // closed socket: unknown until t0+20m
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0 + 5 * 60_000, basis: 'measured', evidence: [], narrative: '' }];
    R.priv.updateEpisodes(sym, t0 + 6 * 60_000);                                   // opens after the return
    R.priv.updateEpisodes(sym, t0 + 7 * 60_000);
    assert.equal(oc.openEpisodeDetails()[0].confounded, true);
  } finally { R.stop(); }
  const Q = await rerouteZd('zwtui-none-hold-');
  try {
    const real = Q.priv.snapshot();
    Q.priv.snapshot = () => real.map((n) => (n.nodeId === 7 ? { ...n, status: NodeStatus.Alive, isListening: true } : n));
    const oc = (Q.zd as unknown as { outcomes: { openEpisodeDetails: () => unknown[] } }).outcomes;
    const t0 = 1_800_000_000_000;
    const sym = [{ kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: t0, basis: 'measured', evidence: [], narrative: '' }];
    Q.priv.updateEpisodes(sym, t0);
    Q.zd.noteActionLaunched('healNode', 7, 'you', t0 + 1_000, true);
    // A socket that never came up: the call failed after its 10 s ready wait —
    // long enough that a kept hold would push the close past the window below.
    Q.zd.noteActionSettled('healNode', 7, 'you', t0 + 1_000, t0 + 5 * 60_000, 'none');
    Q.priv.updateEpisodes([], t0 + 60_000);
    Q.priv.updateEpisodes([], t0 + 11 * 60_000 + 1_000);
    assert.equal(oc.openEpisodeDetails().length, 0, 'nothing held: the heal never left');
  } finally { Q.stop(); }
});

test('a quick action between two ticks still re-arms the after-window burst (third review)', async () => {
  const E = await episodeRig('zwtui-quick-burst-');
  try {
    const drain = () => { let t = Date.now() + 10 * 86_400_000; while (E.R.zd.drainVerifyRequests(t).length) t += 3_600_000; };
    E.R.priv.updateEpisodes([], E.t0 + 60_000);
    drain();
    E.R.priv.updateEpisodes([], E.t0 + 6 * 60_000 + 1_000);
    assert.equal(E.R.zd.verifyOwedCount(), 1, 'fixture guard: burst sent');
    drain();
    E.R.zd.noteActionLaunched('ping', 7, 'you', E.t0 + 7 * 60_000, true);
    E.R.zd.noteActionSettled('ping', 7, 'you', E.t0 + 7 * 60_000, E.t0 + 7 * 60_000 + 2_000, 'ok'); // between ticks
    E.R.priv.updateEpisodes([], E.t0 + 12 * 60_000 + 3_000);
    assert.equal(E.R.zd.verifyOwedCount(), 1, 'the burst is sent again for the settled after-window');
  } finally { E.R.stop(); }
});
