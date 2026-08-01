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
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => { /* the test fires ready explicitly */ },
    stop: () => {},
    reconnect: () => { /* a real client would drop + redial; tests fireReady() */ },
    ready: () => true,
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
