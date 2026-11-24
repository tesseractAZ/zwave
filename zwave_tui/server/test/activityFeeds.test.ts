/**
 * v0.79.7 — the activity feeds a rebuild of the feed set could not make.
 *
 * The two activity feeds are `subscribe_events` on Home Assistant's core bus:
 * `state_changed` (the value log, the live-state cache Detail's LIVE ENTITIES
 * and the device menu's "now:" read, and the owner's pause toggle) and
 * `zwave_js_notification` (the notification log). websocket_api's
 * handle_subscribe_events registers a bus listener and answers in the same
 * step, so for the administrator the add-on connects as a subscribe fails
 * only by an answer that does not come within the client's timeout or a
 * connection that goes under it. Through v0.79.6 such a failure was logged
 * and left: the rebuild kept its controller and node feeds, a failed
 * state_changed subscribe skipped the notification one, and nothing made
 * either before the next rebuild.
 *
 * The fake below is that bus: a subscribe registers a handler HA delivers to
 * until it is released or its socket closes; a failure or a parked answer is
 * scripted per feed. The poll loop is driven by hand (refreshMs is an hour),
 * and the host's uptime is the test's own clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZwaveData } from '../src/zwave/zwaveData';
import { PAUSE_ENTITY } from '../src/zwave/autonomyPause';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

const HOME = 3586281591;
const ENTRY = 'E1';
const SWITCH = 'switch.node_seven';
const NOT_LOADED = 'HA WS error (not_loaded): Config entry E1 not loaded';
const TIMEOUT = 'HA WS timeout (id 41, subscribe_events)';
/** haWsClient's rejections once the socket is gone: a command out on it, and
 *  one that waited for a socket longer than its bound. */
const CLOSED = 'HA WS connection closed';
const NOT_READY = 'HA WS not ready (auth timeout)';

type Gate = { wait: Promise<void>; open: () => void; arrived: boolean };
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open, arrived: false };
}

interface Ha {
  client: HaWsClient & { fireReady(): void };
  /** Handlers Home Assistant delivers to now, by feed. */
  live: Map<string, Set<HaEventHandler>>;
  /** Subscribes asked of the client, by feed (one while the socket is down included). */
  tries: Map<string, number>;
  /** The socket is up and authenticated: the client's ready(). */
  up: boolean;
  /** Core goes down (v0.79.7 review): the socket closes and its subscriptions
   *  die, a subscribe parked on it fails as closed once let go, and every
   *  command until a reconnect fails as the client's wait for a socket would
   *  once its bound passed (at once here, standing for an outage longer than
   *  it). `up = true` and a reconnect bring it back. */
  down(): void;
  /** Failures still to come, by feed: each fails one subscribe. */
  fail: Map<string, number>;
  /** Parks the next subscribe of a feed until opened. */
  gates: Map<string, Gate>;
  /** Parks the next release. */
  unsubGate: Gate | null;
  /** Releases per subscription. */
  released: Map<number, number>;
  /** get_states reads answered. */
  reads: number;
  /** Home Assistant's states. */
  states: Map<string, string>;
  /** network_status fails with this while set. */
  statusErr: string | null;
  /** A socket closed: its subscriptions die with it. */
  dropAll(): void;
  /** A state change on Home Assistant's bus. */
  emitState(entity: string, from: string, to: string): void;
  emitNotif(label: string): void;
}

function fakeHa(): Ha {
  const readyCbs: Array<() => void> = [];
  let sid = 0;
  /** Sockets Core's going down has closed. */
  let downs = 0;
  const ha: Ha = {
    client: null as never,
    live: new Map(), tries: new Map(), fail: new Map(), gates: new Map(), unsubGate: null,
    released: new Map(), reads: 0, states: new Map([[SWITCH, 'on']]), statusErr: null, up: true,
    dropAll: () => { for (const s of ha.live.values()) s.clear(); },
    down: () => { ha.up = false; downs += 1; ha.dropAll(); },
    emitState: (entity, from, to) => {
      for (const h of [...(ha.live.get('state_changed') ?? [])]) {
        h({ type: 'event', event: { data: { entity_id: entity, old_state: { state: from }, new_state: { state: to, last_changed: new Date().toISOString() } } } } as never);
      }
    },
    emitNotif: (label) => {
      for (const h of [...(ha.live.get('zwave_js_notification') ?? [])]) {
        h({ type: 'event', event: { data: { node_id: 7, label, event_label: 'Keypad lock' } } } as never);
      }
    },
  };
  const feedOf = (c: Record<string, unknown>): string => (c.type === 'subscribe_events' ? String(c.event_type) : String(c.type));
  const send = async (cmd: Record<string, unknown>): Promise<unknown> => {
    if (!ha.up) throw new Error(NOT_READY);
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list':
        return [{ id: 'dev-7', identifiers: [['zwave_js', `${HOME}-7`]], name: 'Node Seven', area_id: null, config_entry_id: ENTRY, config_entries: [ENTRY] }];
      case 'config/entity_registry/list':
        return [{ entity_id: SWITCH, device_id: 'dev-7', disabled_by: null, platform: 'zwave_js', original_name: 'Node Seven Switch' }];
      case 'get_states':
        ha.reads += 1;
        return [...ha.states].map(([entity_id, state]) => ({ entity_id, state, attributes: {}, last_changed: new Date().toISOString() }));
      case 'zwave_js/network_status':
        if (ha.statusErr) throw new Error(ha.statusErr);
        return { client: { server_version: 't' }, controller: { home_id: HOME, own_node_id: 1, nodes: [
          { node_id: 1, status: 4, ready: true, is_routing: true, is_secure: false, is_controller_node: true },
          { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false },
        ] } };
      default: return null;
    }
  };
  ha.client = {
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => {}, stop: () => {}, reconnect: () => {},
    ready: () => ha.up, whenReady: () => Promise.resolve(),
    onReady: (cb: () => void) => { readyCbs.push(cb); },
    lastError: () => null,
    send,
    subscribe: async (c: Record<string, unknown>, on: HaEventHandler): Promise<HaSubscription> => {
      const feed = feedOf(c);
      ha.tries.set(feed, (ha.tries.get(feed) ?? 0) + 1);
      if (!ha.up) throw new Error(NOT_READY);
      const sock = downs;
      const g = ha.gates.get(feed);
      if (g) { ha.gates.delete(feed); g.arrived = true; await g.wait; }
      if (sock !== downs) throw new Error(CLOSED);
      const left = ha.fail.get(feed) ?? 0;
      if (left > 0) { ha.fail.set(feed, left - 1); throw new Error(TIMEOUT); }
      const set = ha.live.get(feed) ?? new Set<HaEventHandler>();
      ha.live.set(feed, set);
      set.add(on);
      const id = ++sid;
      return {
        subscriptionId: id,
        unsubscribe: async () => {
          ha.released.set(id, (ha.released.get(id) ?? 0) + 1);
          const u = ha.unsubGate;
          if (u) { ha.unsubGate = null; u.arrived = true; await u.wait; }
          set.delete(on);
        },
      };
    },
  } as unknown as HaWsClient & { fireReady(): void };
  return ha;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(5);
  }
}

/** The data layer's private state these tests drive (white-box, labelled as such). */
type Priv = {
  tick: () => Promise<void>; pollTimer: ReturnType<typeof setTimeout> | null;
  registriesInFlight: Promise<void> | null; rebuildInFlight: boolean; statsSubscribed: boolean;
  nodeSubsBusy: boolean; activityRetryBusy: boolean; lastHomeId: number | null;
  statusSubbed: Set<number>; statsSubbedNodes: Set<number>; activityOwed: Set<string>;
};

interface Run {
  zd: ReturnType<typeof createZwaveData>; ha: Ha; logs: string[]; priv: Priv;
  /** The host's uptime moves on. */
  later: (ms: number) => void;
  /** One roster poll, and the feed work it starts, settled. */
  poll: () => Promise<void>;
  /** One roster poll, not waiting for the feed work it starts. */
  pollOnly: () => Promise<void>;
  settled: () => boolean;
  /** A Home Assistant reconnect: the old socket's feeds die, the feed set is rebuilt. */
  reconnect: () => Promise<void>;
  live: (feed: string) => number;
  tries: (feed: string) => number;
  /** Log-screen rows of one kind since `from`. */
  rows: (kind: string, from?: number) => Array<{ severity: string; text: string }>;
}

async function withHa(ha: Ha, body: (r: Run) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  let up = 5 * 86_400_000;
  const zd = createZwaveData({
    client: ha.client, refreshMs: 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * 60_000,
    historyPath: null, evidencePath: null, baselinesPath: null, outcomesPath: null, autonomyPath: null, driverWsUrl: null,
    log: (m: string) => logs.push(m), uptimeMs: () => up,
  });
  const priv = zd as unknown as Priv;
  const feedsSettled = () => priv.registriesInFlight == null && !priv.rebuildInFlight && priv.statsSubscribed && !priv.nodeSubsBusy;
  const settled = () => feedsSettled() && !priv.activityRetryBusy;
  const pollOnly = async () => {
    if (priv.pollTimer) clearTimeout(priv.pollTimer);
    await priv.tick();
  };
  const rebuilds = () => logs.filter((l) => l.startsWith('live statistics: subscribed')).length;
  try {
    zd.start();
    ha.client.fireReady();
    await waitFor(() => zd.snapshot().length > 0 && priv.lastHomeId != null && settled(), 15_000, () => logs.join(' | '));
    await sleep(5);
    await body({
      zd, ha, logs, priv, settled, pollOnly,
      later: (ms) => { up += ms; },
      poll: async () => {
        await pollOnly();
        await waitFor(settled, 8000, () => logs.join(' | '));
        await sleep(5);
      },
      reconnect: async () => {
        const n = rebuilds();
        ha.dropAll();
        ha.client.fireReady();
        // A retry held out does not hold this up.
        await waitFor(() => rebuilds() > n && feedsSettled(), 8000, () => logs.join(' | '));
        await sleep(5);
      },
      live: (feed) => ha.live.get(feed)?.size ?? 0,
      tries: (feed) => ha.tries.get(feed) ?? 0,
      rows: (kind, from = -1) => zd.events().filter((e) => e.kind === kind && e.seq > from).map((e) => ({ severity: e.severity, text: e.text })),
    });
  } finally {
    zd.stop();
  }
}

const MIN = 60_000;
const lastSeq = (r: Run): number => r.zd.events()[0]?.seq ?? -1;
/** One state change reaches the log once: one feed heard, not two. */
function heardOnce(r: Run, why: string): void {
  const from = lastSeq(r);
  r.ha.emitState(SWITCH, 'on', 'off');
  assert.equal(r.rows('value', from).length, 1, `${why}: one state change, logged ${r.rows('value', from).length} times`);
  r.ha.emitState(SWITCH, 'off', 'on');
}
function noReleasedTwice(ha: Ha, why: string): void {
  const twice = [...ha.released].filter(([, k]) => k > 1).map(([id]) => id);
  assert.deepEqual(twice, [], `${why}: subscriptions released more than once`);
}

test('a rebuild whose state_changed subscribe fails keeps its feeds, makes the notification feed, says so, and makes the state feed a minute on, reading again what it missed (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  await withHa(ha, async (r) => {
    assert.ok(r.logs.some((l) => /^activity subscribe failed/.test(l)), 'precondition: the subscribe failed');
    assert.equal(r.live('state_changed'), 0);
    // The rebuild stands: the controller and node feeds, and the other activity feed.
    assert.equal(r.live('zwave_js/subscribe_controller_statistics'), 1);
    assert.ok(r.priv.statsSubbedNodes.has(7) && r.priv.statusSubbed.has(7), 'node 7 keeps its feeds');
    assert.equal(r.live('zwave_js_notification'), 1, 'the notification feed is a try of its own');
    const down = r.rows('system').filter((e) => e.text.startsWith('activity feed'));
    assert.deepEqual(down.map((e) => [e.severity, e.text]),
      [['warn', 'activity feed down — its state_changed subscribe failed; retried after a minute']], 'the Log screen says the feed is down, and nothing says it is live');
    const nodeTries = r.tries('zwave_js/subscribe_node_statistics');
    // While it is down: a device changes, and the owner pauses from Home Assistant.
    ha.states.set(SWITCH, 'off');
    ha.states.set(PAUSE_ENTITY, 'on');
    ha.emitState(SWITCH, 'on', 'off');
    assert.equal(r.zd.entityStates(7)[0].state, 'on', 'precondition: no feed heard it');
    r.later(30_000);
    await r.poll();
    assert.equal(r.tries('state_changed'), 1, 'not tried again within the minute');
    r.later(31_000);
    const reads = ha.reads;
    const from = lastSeq(r);
    await r.poll();
    assert.equal(r.tries('state_changed'), 2, 'tried again a minute on');
    assert.equal(r.live('state_changed'), 1, 'the state feed is made');
    assert.equal(r.live('zwave_js_notification'), 1, 'the notification feed is not made twice');
    assert.equal(r.tries('zwave_js_notification'), 1);
    assert.deepEqual(r.rows('system', from).filter((e) => e.text.startsWith('activity feed')).map((e) => [e.severity, e.text]),
      [['info', 'activity feed live — watching 1 device entities']]);
    assert.ok(ha.reads > reads, 'the states are read again');
    await waitFor(() => r.zd.entityStates(7)[0].state === 'off', 2000, () => JSON.stringify(r.zd.entityStates(7)));
    assert.deepEqual(r.zd.autonomyPause()?.by, ['ha'], 'the pause turned on while the feed was down is read');
    heardOnce(r, 'after the retry');
    // Nothing owed: no more tries, and the node feeds were left as they were.
    r.later(MIN + 1_000);
    await r.poll();
    assert.equal(r.tries('state_changed'), 2);
    assert.equal(r.tries('zwave_js/subscribe_node_statistics'), nodeTries, 'no node feed made again for it');
    assert.equal(r.live('zwave_js/subscribe_node_statistics'), 1);
    noReleasedTwice(ha, 'end');
  });
});

test('a rebuild whose notification subscribe fails: only that feed is made a minute on, the state feed stays one (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('zwave_js_notification', 1);
  await withHa(ha, async (r) => {
    assert.equal(r.live('state_changed'), 1);
    assert.equal(r.live('zwave_js_notification'), 0, 'precondition: the notification subscribe failed');
    const booted = r.rows('system').filter((e) => e.text.startsWith('activity feed')).map((e) => [e.severity, e.text]);
    const reads = ha.reads;
    r.later(MIN);
    const from = lastSeq(r);
    await r.poll();
    assert.equal(r.live('zwave_js_notification'), 1, 'the notification feed is made');
    assert.equal(r.tries('state_changed'), 1, 'the live state feed is not subscribed again');
    assert.equal(r.live('state_changed'), 1);
    // Said, in the add-on log and on the Log screen, not dropped unlogged.
    assert.ok(r.logs.some((l) => /^activity subscribe failed \(zwave_js_notification\): HA WS timeout/.test(l)), 'the failure is logged');
    assert.deepEqual(booted, [['info', 'activity feed live — watching 1 device entities; notifications down, retried after a minute']]);
    assert.deepEqual(r.rows('system', from).map((e) => e.text), ['activity feed live — watching 1 device entities']);
    assert.equal(ha.reads, reads, 'no state read for a notification feed');
    const n0 = lastSeq(r);
    ha.emitNotif('Access Control');
    assert.equal(r.rows('notification', n0).length, 1, 'a notification reaches the log once');
    heardOnce(r, 'after the retry');
  });
});

test('a retry that fails is tried again a minute after it, not sooner, and one at a time (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 2);
  await withHa(ha, async (r) => {
    r.later(MIN);
    await r.poll();
    assert.equal(r.tries('state_changed'), 2, 'the first retry ran');
    assert.equal(r.live('state_changed'), 0, 'and failed');
    r.later(MIN - 1_000);
    await r.poll();
    assert.equal(r.tries('state_changed'), 2, 'a minute from the retry, not from the rebuild');
    r.later(1_000);
    // This one is held: a poll while it is out starts no second.
    const g = gate();
    ha.gates.set('state_changed', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    r.later(MIN);
    await r.pollOnly();
    await sleep(20);
    assert.equal(r.tries('state_changed'), 3, 'one retry out at a time');
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.live('state_changed'), 1);
    heardOnce(r, 'after the held retry');
    noReleasedTwice(ha, 'end');
  });
});

test('a re-arm releases the activity feed the retry made: one feed after it (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    await r.poll();
    assert.equal(r.live('state_changed'), 1, 'precondition: the retry made it');
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    await r.poll();
    assert.ok(r.logs.some((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)'), 'precondition: the re-arm ran');
    assert.equal(r.live('state_changed'), 1, 'the retry\'s feed is released by the re-arm');
    assert.equal(r.live('zwave_js_notification'), 1);
    heardOnce(r, 'after the re-arm');
    noReleasedTwice(ha, 'end');
  });
});

for (const at of ['while the re-arm releases the feed set', 'once the re-arm\'s rebuild has begun'] as const) {
  test(`a re-arm while the retry is out: its feed, answered ${at}, is released and the rebuild's kept (v0.79.7)`, async () => {
    const ha = fakeHa();
    ha.fail.set('state_changed', 1);
    await withHa(ha, async (r) => {
      r.later(MIN);
      const g = gate();
      ha.gates.set('state_changed', g);
      await r.pollOnly();
      await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
      ha.statusErr = NOT_LOADED;
      await r.pollOnly();
      ha.statusErr = null;
      // The re-arm runs, and is held where the answer lands.
      const hold = gate();
      if (at === 'while the re-arm releases the feed set') ha.unsubGate = hold;
      else ha.gates.set('zwave_js/subscribe_controller_statistics', hold);
      await r.pollOnly();
      await waitFor(() => hold.arrived, 2000, () => r.logs.join(' | '));
      g.open();
      await waitFor(() => !r.priv.activityRetryBusy);
      await sleep(5);
      hold.open();
      await waitFor(r.settled);
      await sleep(5);
      assert.equal(r.live('state_changed'), 1, 'one state feed: the rebuild\'s');
      assert.equal(r.live('zwave_js_notification'), 1);
      heardOnce(r, 'after the re-arm');
      // The one kept is the one a re-arm releases.
      ha.statusErr = NOT_LOADED;
      await r.pollOnly();
      ha.statusErr = null;
      (r.priv as unknown as { lastFeedRearmAt: number }).lastFeedRearmAt = 0;
      await r.poll();
      assert.equal(r.live('state_changed'), 1, 'after a second re-arm');
      noReleasedTwice(ha, 'end');
    });
  });
}

test('a reconnect while the retry is out: its answer on the new connection is released; the new connection has one feed (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    const g = gate();
    ha.gates.set('state_changed', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    await r.reconnect();
    assert.equal(r.live('state_changed'), 1, 'the new connection\'s rebuild made one');
    g.open();
    await waitFor(() => !r.priv.activityRetryBusy);
    await sleep(5);
    assert.equal(r.live('state_changed'), 1, 'the retry\'s late answer is released');
    heardOnce(r, 'after the reconnect');
    r.later(MIN);
    await r.poll();
    assert.equal(r.tries('state_changed'), 3, 'nothing owed on the new connection');
    noReleasedTwice(ha, 'end');
  });
});

test('the retry stands aside while a rebuild runs or the feed set is being released, and sends nothing then (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    await r.poll();
    assert.equal(r.live('state_changed'), 1, 'precondition: the retry made it');
    // Owed again: a reconnect whose rebuild cannot make it.
    ha.fail.set('state_changed', 1);
    await r.reconnect();
    assert.equal(r.live('state_changed'), 0, 'precondition: owed on the new connection');
    r.later(MIN);
    // A second reconnect's rebuild is held, and a roster poll runs beside it.
    const hold = gate();
    ha.gates.set('zwave_js/subscribe_controller_statistics', hold);
    ha.dropAll();
    r.ha.client.fireReady();
    await waitFor(() => hold.arrived);
    const before = r.tries('state_changed');
    await r.pollOnly();
    await sleep(20);
    assert.equal(r.tries('state_changed'), before, 'no retry beside a rebuild in flight');
    hold.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.live('state_changed'), 1, 'one feed: the rebuild\'s');
    heardOnce(r, 'after the held rebuild');
    // Owed again, then an entry reload: the poll that re-arms releases the feed set.
    ha.fail.set('state_changed', 1);
    await r.reconnect();
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    r.later(MIN);
    const rel = gate();
    ha.unsubGate = rel;
    const before2 = r.tries('state_changed');
    await r.pollOnly();
    await waitFor(() => rel.arrived);
    await sleep(20);
    assert.equal(r.tries('state_changed'), before2, 'no retry while the re-arm releases the feed set');
    rel.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.tries('state_changed'), before2 + 1, 'the re-arm\'s rebuild made it');
    assert.equal(r.live('state_changed'), 1);
    heardOnce(r, 'after the re-arm');
    noReleasedTwice(ha, 'end');
  });
});

test('an entry reload whose re-arm its window holds off does not hold the activity feeds: a reload leaves them as they are (v0.79.7)', async () => {
  const ha = fakeHa();
  await withHa(ha, async (r) => {
    // A re-arm whose rebuild cannot make the state feed: owed, and the window starts.
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    ha.fail.set('state_changed', 1);
    await r.poll();
    assert.equal(r.logs.filter((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)').length, 1, 'precondition: the re-arm ran');
    assert.equal(r.live('state_changed'), 0, 'precondition: owed');
    // A second reload inside the window: latched, the re-arm held off.
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    r.later(MIN);
    await r.poll();
    assert.equal(r.logs.filter((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)').length, 1, 'precondition: the second re-arm is held');
    assert.equal((r.priv as unknown as { entryReloadSeen: boolean }).entryReloadSeen, true, 'precondition: still latched');
    assert.equal(r.live('state_changed'), 1, 'the state feed is made while the re-arm waits');
    heardOnce(r, 'before the held re-arm');
    // The re-arm, once its window ends, releases it with the rest.
    (r.priv as unknown as { lastFeedRearmAt: number }).lastFeedRearmAt = 0;
    await r.poll();
    assert.equal(r.live('state_changed'), 1, 'after the re-arm');
    heardOnce(r, 'after the re-arm');
    noReleasedTwice(ha, 'end');
  });
});

test('a retry of both feeds whose second answer comes after a re-arm rebuilt the feed set: the state feed it made is released with the rest, not heard beside the rebuild\'s (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  ha.fail.set('zwave_js_notification', 1);
  await withHa(ha, async (r) => {
    assert.equal(r.live('state_changed'), 0, 'precondition: both owed');
    assert.equal(r.live('zwave_js_notification'), 0, 'precondition: both owed');
    r.later(MIN);
    // The retry makes the state feed; its notification subscribe is held.
    const g = gate();
    ha.gates.set('zwave_js_notification', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    assert.equal(r.live('state_changed'), 1, 'precondition: the retry made the state feed');
    // An entry reload: the poll after it re-arms, on the same socket.
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    const rearms = () => r.logs.filter((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)').length;
    await r.pollOnly();
    await waitFor(() => rearms() === 1 && !r.priv.rebuildInFlight && r.priv.statsSubscribed, 4000, () => r.logs.join(' | '));
    await sleep(5);
    // The retry's second answer has not come yet: one state change, one row.
    heardOnce(r, 'after the re-arm, the retry still out');
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.live('state_changed'), 1, 'one state feed');
    assert.equal(r.live('zwave_js_notification'), 1, 'one notification feed');
    heardOnce(r, 'after the retry ended');
    noReleasedTwice(ha, 'end');
  });
});

test('a retry that fails again adds no Log row and reads no states (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 2);
  await withHa(ha, async (r) => {
    r.later(MIN);
    const from = lastSeq(r);
    const reads = ha.reads;
    await r.poll();
    assert.equal(r.tries('state_changed'), 2, 'precondition: the retry ran');
    assert.equal(r.live('state_changed'), 0, 'precondition: and failed');
    assert.deepEqual(r.rows('system', from).map((e) => e.text), [], 'a failed retry adds no Log row');
    assert.equal(ha.reads, reads, 'a failed retry reads no states');
    assert.equal(r.logs.filter((l) => /^activity subscribe failed \(state_changed\)/.test(l)).length, 2, 'each failed attempt is logged');
  });
});

test('a retry of both feeds that makes one: the other stays owed, alone, and the Log screen says which (v0.79.7)', async () => {
  for (const second of ['state_changed', 'zwave_js_notification'] as const) {
    const ha = fakeHa();
    ha.fail.set('state_changed', 1);
    ha.fail.set('zwave_js_notification', 1);
    await withHa(ha, async (r) => {
      assert.deepEqual(r.rows('system').filter((e) => e.text.startsWith('activity feed')).map((e) => e.text),
        ['activity feed down — its state_changed and notification subscribes failed; retried after a minute'], `${second}: precondition`);
      ha.fail.set(second, 1);
      r.later(MIN);
      let from = lastSeq(r);
      let reads = ha.reads;
      await r.poll();
      const made = second === 'state_changed' ? 'zwave_js_notification' : 'state_changed';
      assert.equal(r.live(made), 1, `${second}: the other feed is made`);
      assert.equal(r.live(second), 0, `${second}: this one failed again`);
      assert.deepEqual(r.rows('system', from).map((e) => e.text), [second === 'state_changed'
        ? 'activity feed down — its state_changed subscribe failed; retried after a minute'
        : 'activity feed live — watching 1 device entities; notifications down, retried after a minute'], `${second}: the row says what is still down`);
      assert.equal(ha.reads > reads, made === 'state_changed', `${second}: the states are read when, and only when, the state feed is made`);
      const triesMade = r.tries(made);
      r.later(MIN);
      from = lastSeq(r);
      reads = ha.reads;
      await r.poll();
      assert.equal(r.tries(made), triesMade, `${second}: the live feed is not subscribed again`);
      assert.equal(r.live(second), 1, `${second}: the last one owed is made`);
      assert.equal(r.live(made), 1, `${second}: and the other stays one`);
      assert.deepEqual(r.rows('system', from).map((e) => e.text), ['activity feed live — watching 1 device entities'], `${second}: all made`);
      assert.equal(ha.reads > reads, second === 'state_changed', `${second}: read again only for the state feed`);
      heardOnce(r, `${second}: end`);
      const n0 = lastSeq(r);
      ha.emitNotif('Access Control');
      assert.equal(r.rows('notification', n0).length, 1, `${second}: a notification reaches the log once`);
      noReleasedTwice(ha, `${second}: end`);
    });
  }
});

test('a retry that fails after a re-arm rebuilt the feed set leaves what that rebuild owes as it is (v0.79.7)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    const g = gate();
    ha.gates.set('state_changed', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    ha.statusErr = NOT_LOADED;
    await r.pollOnly();
    ha.statusErr = null;
    await r.pollOnly();
    await waitFor(() => r.logs.includes('live statistics: re-subscribing (zwave_js config entry reloaded)') && !r.priv.rebuildInFlight && r.priv.statsSubscribed, 4000, () => r.logs.join(' | '));
    assert.equal(r.live('state_changed'), 1, 'precondition: the re-arm\'s rebuild made the state feed');
    // The retry's answer, held since before the re-arm, is a failure.
    ha.fail.set('state_changed', 1);
    const from = lastSeq(r);
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.deepEqual(r.rows('system', from).map((e) => e.text), [], 'no row says a live feed is down');
    const tries = r.tries('state_changed');
    r.later(MIN);
    await r.poll();
    assert.equal(r.tries('state_changed'), tries, 'nothing owed: the live state feed is not made again');
    assert.equal(r.live('state_changed'), 1);
    heardOnce(r, 'end');
    noReleasedTwice(ha, 'end');
  });
});

/* ── Core down under a rebuild or a retry (v0.79.7 review) ───────────────── */

const LIVE_ROW = [['info', 'activity feed live — watching 1 device entities']];
/** The activity feeds' Log-screen rows since `from`. */
const feedRows = (r: Run, from: number): string[][] =>
  r.rows('system', from).filter((e) => e.text.startsWith('activity feed')).map((e) => [e.severity, e.text]);

/** A reconnect whose rebuild is held at `feed`'s subscribe; Core goes down
 *  there, the held subscribe is let go, and the rebuild ends on the dead socket. */
async function downDuringRebuild(r: Run, feed: string): Promise<void> {
  const g = gate();
  r.ha.gates.set(feed, g);
  r.ha.dropAll();
  r.ha.client.fireReady();
  await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
  r.ha.down();
  g.open();
  await waitFor(() => !r.priv.rebuildInFlight, 2000, () => r.logs.join(' | '));
  await sleep(5);
}

/** Core back: a reconnect, its rebuild made on the new socket. */
async function coreBack(r: Run): Promise<void> {
  r.ha.up = true;
  await r.reconnect();
}

test('Core going down while a reconnect\'s rebuild has its state_changed subscribe out, and staying down: the notification feed is not tried on the dead socket, both are owed, and no Log row names a retry; the rebuild after the reconnect makes both and says so (v0.79.7 review)', async () => {
  const ha = fakeHa();
  await withHa(ha, async (r) => {
    const from = lastSeq(r);
    const lines = r.logs.length;
    const notif = r.tries('zwave_js_notification');
    await downDuringRebuild(r, 'state_changed');
    const said = r.logs.slice(lines);
    assert.ok(said.includes(`activity subscribe failed (state_changed): ${CLOSED}`), `precondition: the held subscribe failed with its socket — ${said.join(' | ')}`);
    assert.ok(!said.some((l) => /superseded/.test(l)), 'precondition: the rebuild ended on the dead socket, not superseded');
    assert.equal(r.tries('zwave_js_notification'), notif, 'the notification feed is not tried on a socket that is gone');
    assert.deepEqual([...r.priv.activityOwed], ['state_changed', 'zwave_js_notification'], 'both feeds are owed');
    assert.deepEqual(feedRows(r, from), [], 'no row while the socket is down: no retry runs then');
    assert.deepEqual(said.filter((l) => l.startsWith('activity log:')), [], 'no add-on log line names a retry');
    await coreBack(r);
    assert.deepEqual(feedRows(r, from), LIVE_ROW, 'the rebuild after the reconnect makes both feeds, and its row is the only one');
    assert.equal(r.live('state_changed'), 1);
    assert.equal(r.live('zwave_js_notification'), 1);
    assert.equal(r.priv.activityOwed.size, 0, 'nothing owed on the new connection');
    heardOnce(r, 'after the reconnect');
    noReleasedTwice(ha, 'end');
  });
});

test('Core going down while a reconnect\'s rebuild has a node statistics subscribe out, and staying down: the state feed fails on the dead socket, the notification feed is not tried, and no Log row names a retry; the rebuild after the reconnect makes every feed and says so (v0.79.7 review)', async () => {
  const ha = fakeHa();
  await withHa(ha, async (r) => {
    const from = lastSeq(r);
    const lines = r.logs.length;
    const state = r.tries('state_changed');
    const notif = r.tries('zwave_js_notification');
    await downDuringRebuild(r, 'zwave_js/subscribe_node_statistics');
    const said = r.logs.slice(lines);
    assert.ok(said.includes(`node-stats subscribe failed (node 7): ${CLOSED}`), `precondition: the held node subscribe failed with its socket — ${said.join(' | ')}`);
    assert.ok(said.includes(`activity subscribe failed (state_changed): ${NOT_READY}`), 'precondition: the state feed failed waiting for a socket');
    assert.ok(!said.some((l) => /superseded/.test(l)), 'precondition: the rebuild ended on the dead socket, not superseded');
    assert.equal(r.tries('state_changed'), state + 1, 'precondition: the state feed was asked once');
    assert.equal(r.tries('zwave_js_notification'), notif, 'the notification feed is not tried on a socket that is gone');
    assert.deepEqual([...r.priv.activityOwed], ['state_changed', 'zwave_js_notification'], 'both feeds are owed');
    assert.deepEqual(feedRows(r, from), [], 'no row while the socket is down: no retry runs then');
    assert.deepEqual(said.filter((l) => l.startsWith('activity log:')), [], 'no add-on log line names a retry');
    await coreBack(r);
    assert.deepEqual(feedRows(r, from), LIVE_ROW, 'the rebuild after the reconnect makes both feeds, and its row is the only one');
    assert.ok(r.priv.statsSubbedNodes.has(7) && r.priv.statusSubbed.has(7), 'node 7\'s feeds are made');
    assert.equal(r.live('state_changed'), 1);
    assert.equal(r.live('zwave_js_notification'), 1);
    heardOnce(r, 'after the reconnect');
    noReleasedTwice(ha, 'end');
  });
});

test('a retry of both feeds whose notification subscribe fails as Core goes down, after it made the state feed: no row says the state feed is live on the dead socket; the rebuild after the reconnect makes both and says so (v0.79.7 review)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  ha.fail.set('zwave_js_notification', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    const g = gate();
    ha.gates.set('zwave_js_notification', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    assert.equal(r.live('state_changed'), 1, 'precondition: the retry made the state feed');
    const from = lastSeq(r);
    ha.down();
    g.open();
    await waitFor(() => !r.priv.activityRetryBusy, 2000, () => r.logs.join(' | '));
    await sleep(5);
    assert.ok(r.logs.includes(`activity subscribe failed (zwave_js_notification): ${CLOSED}`), 'precondition: the held subscribe failed with its socket');
    assert.deepEqual(feedRows(r, from), [], 'no row says a feed is live on a socket that is gone');
    await coreBack(r);
    assert.deepEqual(feedRows(r, from), LIVE_ROW, 'the rebuild after the reconnect makes both feeds, and its row is the only one');
    assert.equal(r.live('state_changed'), 1);
    assert.equal(r.live('zwave_js_notification'), 1);
    assert.equal(r.priv.activityOwed.size, 0, 'nothing owed on the new connection');
    heardOnce(r, 'after the reconnect');
    noReleasedTwice(ha, 'end');
  });
});

/* ── a state read needs a socket (v0.79.8) ─────────────────────────────────── */

/** get_states asked of the client, answered or not. */
function countStateReads(ha: Ha): { n: number } {
  const asks = { n: 0 };
  const send = ha.client.send.bind(ha.client);
  ha.client.send = ((c: Record<string, unknown>, t?: unknown) => {
    if (c.type === 'get_states') asks.n += 1;
    return (send as (c: Record<string, unknown>, t?: unknown) => Promise<unknown>)(c, t);
  }) as typeof ha.client.send;
  return asks;
}

test('Core going down while a reconnect\'s rebuild has a node statistics subscribe out: the rebuild, ending on the dead socket, starts no state read; the rebuild after the reconnect reads once (v0.79.8)', async () => {
  const ha = fakeHa();
  await withHa(ha, async (r) => {
    const asks = countStateReads(ha);
    const lines = r.logs.length;
    await downDuringRebuild(r, 'zwave_js/subscribe_node_statistics');
    const said = r.logs.slice(lines);
    assert.ok(said.includes(`activity subscribe failed (state_changed): ${NOT_READY}`), 'precondition: the state feed failed waiting for a socket');
    await sleep(10);
    assert.equal(asks.n, 0, 'no state read started on a socket that is gone');
    assert.deepEqual(r.logs.slice(lines).filter((l) => l.startsWith('entity states fetch failed')), [], 'no failed read logged (through v0.79.7 the read waited for a socket and failed)');
    await coreBack(r);
    await sleep(10);
    assert.equal(asks.n, 1, 'the rebuild after the reconnect reads the states once');
  });
});

test('a retry of both feeds whose notification subscribe fails as Core goes down, after it made the state feed: it starts no state read on the dead socket; the rebuild after the reconnect reads once (v0.79.8)', async () => {
  const ha = fakeHa();
  ha.fail.set('state_changed', 1);
  ha.fail.set('zwave_js_notification', 1);
  await withHa(ha, async (r) => {
    r.later(MIN);
    const g = gate();
    ha.gates.set('zwave_js_notification', g);
    await r.pollOnly();
    await waitFor(() => g.arrived, 2000, () => r.logs.join(' | '));
    assert.equal(r.live('state_changed'), 1, 'precondition: the retry made the state feed');
    const asks = countStateReads(ha);
    const lines = r.logs.length;
    ha.down();
    g.open();
    await waitFor(() => !r.priv.activityRetryBusy, 2000, () => r.logs.join(' | '));
    await sleep(10);
    assert.ok(r.logs.includes(`activity subscribe failed (zwave_js_notification): ${CLOSED}`), 'precondition: the held subscribe failed with its socket');
    assert.equal(asks.n, 0, 'no state read started on a socket that is gone');
    assert.deepEqual(r.logs.slice(lines).filter((l) => l.startsWith('entity states fetch failed')), [], 'no failed read logged (through v0.79.7 the read waited for a socket and failed)');
    await coreBack(r);
    await sleep(10);
    assert.equal(asks.n, 1, 'the rebuild after the reconnect reads the states once');
  });
});
