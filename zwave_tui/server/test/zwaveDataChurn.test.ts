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
import { mkdtempSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZwaveData, type ZwaveData } from '../src/zwave/zwaveData';
import { bandOf, N_BANDS } from '../src/zwave/baselines';
import type { OutcomeStore } from '../src/zwave/outcomes';
import { NodeStatus, type NodeSnapshot } from '../src/types';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

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
/** Roster the fake controller reports. Mutable so a test can make a node
 *  LEAVE the network — the eviction path cannot be reached otherwise. */
const NODE7 = { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false };
let rosterNodes: Array<Record<string, unknown>> = [NODE7];
const DEV_ID = 'dev-7';

function cannedResult(cmd: Record<string, unknown>): unknown {
  switch (cmd.type) {
    case 'config_entries/get':
      return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
    case 'config/device_registry/list':
      return [{ id: DEV_ID, identifiers: [['zwave_js', `${HOME}-7`]], name: 'Node Seven', manufacturer: 'T', model: 'M', area_id: null }];
    case 'config/entity_registry/list':
      return [{ entity_id: 'switch.node_seven', device_id: DEV_ID, disabled_by: null, platform: 'zwave_js', original_name: 'Node Seven Switch' }];
    case 'get_states':
      return [{ entity_id: 'switch.node_seven', state: 'on', attributes: {} }];
    case 'zwave_js/network_status':
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
      return {
        subscriptionId: subCount.size,
        unsubscribe: async () => { live.set(feed, Math.max(0, (live.get(feed) ?? 0) - 1)); },
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
    zd.recordActionOutcome('removeFailed', 7, false, 'transport');
    shadow.updateEpisodes([], t0 + 60_000);
    shadow.updateEpisodes([], t0 + 12 * 60_000);
    assert.equal(zd.falsePositives('ghost-suspect'), 0,
      'a transport failure must never be held against a detector');

    shadow.updateEpisodes([sym], t0 + 20 * 60_000);
    zd.recordActionOutcome('removeFailed', 7, false, 'refused');
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
  // on the screen: HA returns before the node answers, so "sent" is not
  // "answered". An engine ping is already pended by its own lane; pending it
  // again here would double-attribute it.
  const ha = fakeHa();
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-manual-'));
  const zd = await bootedZwaveData(ha, {
    refreshMs: 80, routePollMs: 120, evidenceSampleMs: 80,
    evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: null,
  });
  try {
    const pended: number[] = [];
    zd.setProbeNotePending((n) => pended.push(n));

    zd.recordActionOutcome('ping', 7, true, undefined, 'you');
    assert.deepEqual(pended, [7], 'an operator ping is owed an answer');

    zd.recordActionOutcome('ping', 8, true, undefined, 'engine');
    assert.deepEqual(pended, [7], 'an engine ping is pended by its OWN lane, never twice');

    // A ping that never left does not owe an answer.
    zd.recordActionOutcome('ping', 9, false, 'transport', 'you');
    assert.deepEqual(pended, [7], 'a failed send is not an outstanding probe');

    // And no other action is a probe.
    zd.recordActionOutcome('healNode', 10, true, undefined, 'you');
    assert.deepEqual(pended, [7], 'only a ping is a probe');
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
