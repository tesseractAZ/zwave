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
import type { NodeSnapshot } from '../src/types';
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
          home_id: HOME, own_node_id: 1,
          nodes: [{ node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false }],
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
    assert.deepEqual(zd.drainVerifyRequests(t0), [7], 'first probe is due immediately');
    assert.deepEqual(zd.drainVerifyRequests(t0 + 1_000), [], 'the next is spaced, not back-to-back');
    for (let i = 1; i <= 4; i++) {
      assert.deepEqual(zd.drainVerifyRequests(t0 + i * 80_000), [7], `probe ${i + 1} of the burst`);
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
      if (zd.drainVerifyRequests(at).includes(7)) fired.push(at);
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
      for (const id of zd.drainVerifyRequests(at)) if (!firstAt.has(id)) firstAt.set(id, at);
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
      for (const id of zd.drainVerifyRequests(at)) {
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
