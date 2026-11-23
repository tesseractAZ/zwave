/**
 * v0.79.6 — a node's statistics and status feeds when its node object in Home
 * Assistant changes, against a model of Home Assistant 2026.11's zwave_js
 * websocket API and zwave-js-server-python's node objects.
 *
 * The model follows components/zwave_js/api.py and helpers.py, and
 * zwave_js_server/model/controller and model/node: subscribe_node_statistics
 * and subscribe_node_status resolve the device to a node id (the
 * `<home>-<node>` part of its zwave_js identifier, which an orphan's
 * `<home>-<node>-<hw>` also carries) and attach a listener with node.on() to
 * the node object the controller holds for that id then; the statistics
 * subscribe replays the node's current statistics. A node removed (an
 * exclusion, or the failed node a replace removes) leaves the controller, a
 * node added is a new object, and the driver's events reach the object held
 * now, so a listener on an old one hears nothing; nothing is sent on, or
 * closed for, its subscription. A node's status changes only by an alive,
 * dead, sleep or wake up event, which the status feeds bound to its object
 * forward; zwave-js marks a node it adds alive before adding it (Controller.ts:
 * newNode.markAsAlive()), so a new object starts at Alive with no event. A
 * re-interview keeps the object. A driver restart reloads the entry: every
 * node is a new object, and subscribes fail `not_loaded` until it is set up.
 * The device registry is deviceSwapSim's model, without child devices. A
 * reconnect drops every listener: the socket's subscriptions die with it.
 * Every release is counted by subscription, so a handle released twice shows.
 *
 * The poll loop is driven by hand (refreshMs is an hour), so each step is one
 * roster poll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZwaveData } from '../src/zwave/zwaveData';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

const DAY = 86_400_000;
const HOME = 3586281591;
const P1 = '634:20548:13';
const P3 = '29:12:34';
const P7 = '881:3:20';
const NOT_LOADED = 'HA WS error (not_loaded): Config entry E1 not loaded';

/* ── Home Assistant's device registry (deviceSwapSim's model) ─────────────── */
type Main = { id: string; entry: string; ids: string[] };
class Registry {
  devices = new Map<string, Main>();
  deleted = new Map<string, Main>();
  private seq = 0;
  getEntry(ids: string[], entry: string): Main | undefined {
    for (const i of ids) for (const d of this.devices.values()) if (d.entry === entry && d.ids.includes(i)) return d;
    return undefined;
  }
  getOrCreate(entry: string, ids: string[]): Main {
    const d = this.getEntry(ids, entry);
    if (d) { for (const i of ids) if (!d.ids.includes(i)) d.ids.push(i); return d; }
    const del = [...this.deleted.values()].reverse().find((x) => x.entry === entry && x.ids.some((i) => ids.includes(i)));
    const dev: Main = del ? { id: del.id, entry, ids: [...ids] } : { id: `dev-${++this.seq}`, entry, ids: [...ids] };
    if (del) this.deleted.delete(del.id);
    this.devices.set(dev.id, dev);
    return dev;
  }
  remove(id: string): void {
    const d = this.devices.get(id)!;
    this.devices.delete(id);
    this.deleted.set(id, d);
  }
}

/* ── zwave-js-server-python node objects, and zwave_js registration ─────── */
type Listener = HaEventHandler;
/** One node object: what Home Assistant's node.on() binds a feed to. */
class ZObj {
  stats = new Set<Listener>();
  status = new Set<Listener>();
  /** Its statistics counters (a new object starts at zero). */
  tx = 0;
  constructor(public p: string | null, public ready: boolean, public st: number) {}
}
class Zwave {
  nodes = new Map<number, ZObj>();
  /** Every node object made, held or not. */
  objs: ZObj[] = [];
  constructor(public reg: Registry, public entry: string, public home: number) {}
  H(n: number): string { return `${this.home}-${n}`; }
  private make(n: number, p: string | null, ready: boolean, st: number): ZObj {
    const o = new ZObj(p, ready, st);
    this.objs.push(o);
    this.nodes.set(n, o);
    return o;
  }
  register(n: number): Main {
    const node = this.nodes.get(n)!;
    const devId = this.H(n);
    const ext = node.p == null ? null : `${this.home}-${n}-${node.p}`;
    const nodeDev = this.reg.getEntry([devId], this.entry);
    let ids: string[];
    if (ext) {
      if (nodeDev && nodeDev.ids.length === 2 && !nodeDev.ids.includes(ext)) nodeDev.ids = nodeDev.ids.filter((i) => i !== devId);
      const hw = this.reg.getEntry([ext], this.entry);
      if (hw && hw.ids.length === 1) hw.ids.push(devId);
      ids = [devId, ext];
    } else ids = [devId];
    return this.reg.getOrCreate(this.entry, ids);
  }
  /** async_on_node_ready. */
  ready(n: number): void { this.nodes.get(n)!.ready = true; this.register(n); }
  /** Node added and interviewed at once. */
  add(n: number, p: string): void { this.make(n, null, false, 0); this.register(n); this.interview(n, p); }
  /** Node added, its interview running: zwave-js marks a node it just added alive before "node added". */
  addPending(n: number): void { this.make(n, null, false, 4); this.register(n); }
  /** The interview done; a status change on the way is an event, as zwave-js emits one for each. */
  interview(n: number, p: string): void { const o = this.nodes.get(n)!; o.p = p; if (o.st !== 4) this.emitStatus(n, 'alive'); this.ready(n); }
  /** A re-interview starting: the same object reads not ready. */
  startInterview(n: number): void { this.nodes.get(n)!.ready = false; }
  removeNode(n: number, reason: 'replaced' | 'excluded'): void {
    const dev = this.reg.getEntry([this.H(n)], this.entry);
    this.nodes.delete(n);
    if (reason === 'excluded' && dev) this.reg.remove(dev.id);
  }
  /** replace_failed_node: the new node added, its interview running. */
  replacePending(n: number): void { this.removeNode(n, 'replaced'); this.addPending(n); }
  /** replace_failed_node with no roster poll between its steps. */
  replace(n: number, p: string): void { this.removeNode(n, 'replaced'); this.add(n, p); }
  /** A driver restart: every node a new object, read from the driver's cache, not ready yet. */
  restartDriver(): void { for (const [n, o] of [...this.nodes]) this.make(n, o.p, false, o.st); }
  roster(): Array<Record<string, unknown>> {
    return [...this.nodes.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({
      node_id: n, status: x.st, ready: x.ready, is_routing: true, is_secure: false, ...(n === 1 ? { is_controller_node: true } : {}),
    }));
  }
  statsEvent(n: number, o: ZObj): Record<string, unknown> {
    return { source: 'node', event: 'statistics updated', node_id: n, commands_tx: o.tx, commands_rx: o.tx,
      commands_dropped_tx: 0, commands_dropped_rx: 0, timeout_response: 0, rtt: 20, rssi: -60 };
  }
  /** The driver's statistics for node `n`: they reach the object held now. */
  emitStats(n: number): void {
    const o = this.nodes.get(n)!;
    o.tx += 1;
    for (const l of [...o.stats]) l({ type: 'event', event: this.statsEvent(n, o) });
  }
  emitStatus(n: number, ev: 'dead' | 'alive'): void {
    const o = this.nodes.get(n)!;
    o.st = ev === 'dead' ? 3 : 4;
    for (const l of [...o.status]) l({ type: 'event', event: { event: ev, status: o.st, ready: o.ready } });
  }
  /** Feeds bound to the object held for `n` now. */
  live(n: number, feed: 'stats' | 'status'): number { return this.nodes.get(n)?.[feed].size ?? 0; }
  /** Feeds bound to objects no longer held. */
  zombies(): number {
    const held = new Set(this.nodes.values());
    return this.objs.filter((o) => !held.has(o)).reduce((a, o) => a + o.stats.size + o.status.size, 0);
  }
  /** A socket closed: its subscriptions die with it. */
  dropAll(): void { for (const o of this.objs) { o.stats.clear(); o.status.clear(); } }
}

/* ── The add-on's view of it ───────────────────────────────────────────────── */
type Gate = { wait: Promise<void>; open: () => void; arrived: boolean };
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open, arrived: false };
}
interface Sim {
  reg: Registry; zw: Zwave;
  /** network_status fails with this while set. */
  statusErr?: string;
  /** The device registry list fails while set. */
  regErr?: boolean;
  /** Node subscribes fail `not_loaded` while set (the entry is reloading). */
  unloaded?: boolean;
  /** Node ids whose subscribes fail as while a replace has the id free. */
  failSubs: Set<number>;
  /** `<node>:<feed>` subscribes that fail. */
  failFeed: Set<string>;
  /** Parks the next subscribe of this feed by this device id. */
  subGate?: (Gate & { feed: 'stats' | 'status'; dev: string }) | null;
  /** Parks the next release of this node's feed. */
  unsubGate?: (Gate & { feed: 'stats' | 'status'; n: number }) | null;
  /** Parks the next controller statistics subscribe. */
  ctrlGate?: Gate | null;
  /** Per-node subscribes that resolved: node and feed. */
  subCalls: Array<{ n: number; feed: 'stats' | 'status' }>;
  /** Releases per subscription id. */
  released: Map<number, number>;
  /** The controller object now (a driver restart makes another), and the one each controller feed is bound to (null: released). */
  ctrlGen: number;
  ctrlFeeds: Array<number | null>;
}

function listRows(s: Sim): Array<Record<string, unknown>> {
  return [...s.reg.devices.values()].map((d) => ({ id: d.id, identifiers: d.ids.map((i) => ['zwave_js', i]), name: `Dev ${d.id}`,
    area_id: null, config_entry_id: d.entry, config_entries: [d.entry], parent_device_id: null }));
}

function fakeHa(s: Sim): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  let subSeq = 0;
  const release = (sid: number): void => { s.released.set(sid, (s.released.get(sid) ?? 0) + 1); };
  const send = async (cmd: Record<string, unknown>): Promise<unknown> => {
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: s.zw.entry, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list':
        if (s.regErr) throw new Error('HA WS error (unknown_error): registry');
        return listRows(s);
      case 'config/entity_registry/list': return [];
      case 'get_states': return [];
      case 'zwave_js/network_status':
        if (s.statusErr) throw new Error(s.statusErr);
        return { client: { server_version: 't' }, controller: { home_id: s.zw.home, own_node_id: 1, nodes: s.zw.roster() } };
      default: return null;
    }
  };
  /** api.py's subscribe_node_statistics / subscribe_node_status. */
  const nodeSub = async (feed: 'stats' | 'status', devId: string, on: Listener): Promise<HaSubscription> => {
    const g = s.subGate;
    if (g && g.feed === feed && g.dev === devId) { s.subGate = null; g.arrived = true; await g.wait; }
    if (s.unloaded) throw new Error(`HA WS error (not_loaded): Device ${devId} config entry is not loaded`);
    const dev = s.reg.devices.get(devId);
    if (!dev) throw new Error(`HA WS error (not_found): Device ID ${devId} is not valid`);
    const n = Number(dev.ids[0].split('-')[1]);
    const o = s.zw.nodes.get(n);
    if (!o || s.failSubs.has(n) || s.failFeed.has(`${n}:${feed}`)) throw new Error(`HA WS error (not_found): Node for device ${devId} can't be found`);
    const set = o[feed];
    set.add(on);
    s.subCalls.push({ n, feed });
    if (feed === 'stats') setImmediate(() => { if (set.has(on)) on({ type: 'event', event: s.zw.statsEvent(n, o) }); });
    const sid = ++subSeq;
    return {
      subscriptionId: sid,
      unsubscribe: async () => {
        release(sid);
        const u = s.unsubGate;
        if (u && u.feed === feed && u.n === n) { s.unsubGate = null; u.arrived = true; await u.wait; }
        set.delete(on);
      },
    };
  };
  return {
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => {}, stop: () => {}, reconnect: () => {},
    ready: () => true, whenReady: () => Promise.resolve(),
    onReady: (cb: () => void) => { readyCbs.push(cb); },
    lastError: () => null,
    send,
    subscribe: async (c: Record<string, unknown>, on: HaEventHandler): Promise<HaSubscription> => {
      if (c.type === 'zwave_js/subscribe_node_statistics') return nodeSub('stats', String(c.device_id), on);
      if (c.type === 'zwave_js/subscribe_node_status') return nodeSub('status', String(c.device_id), on);
      const sid = ++subSeq;
      if (c.type === 'zwave_js/subscribe_controller_statistics') {
        const g = s.ctrlGate;
        if (g) { s.ctrlGate = null; g.arrived = true; await g.wait; }
        const k = s.ctrlFeeds.push(s.ctrlGen) - 1;
        return { subscriptionId: sid, unsubscribe: async () => { release(sid); s.ctrlFeeds[k] = null; } };
      }
      return { subscriptionId: sid, unsubscribe: async () => { release(sid); } };
    },
  } as unknown as HaWsClient & { fireReady(): void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(5);
  }
}
const realNow = Date.now.bind(Date);
let skip = 0;

/** The data layer's private state these tests drive (white-box, labelled as such). */
type Priv = {
  tick: () => Promise<void>; pollTimer: ReturnType<typeof setTimeout> | null;
  lastHomeId: number | null; registriesInFlight: Promise<void> | null; rebuildInFlight: boolean;
  statsSubscribed: boolean; nodeSubsBusy: boolean; lastFeedRearmAt: number; lastStatsAt: number | null;
  subRetryTimer: ReturnType<typeof setInterval> | null;
  rearmStatsFeeds: (why: string) => Promise<void>; retryNodeSubs: () => Promise<void>;
  statsByNode: Map<number, { commandsTX: number }>;
  statusSubbed: Set<number>; statsSubbedNodes: Set<number>; pendingNodeSubs: Map<number, string>;
};

interface Run {
  zd: ReturnType<typeof createZwaveData>; logs: string[]; priv: Priv; ha: ReturnType<typeof fakeHa>;
  /** One roster poll, and the feed work it starts, settled. */
  poll: () => Promise<void>;
  /** One roster poll, not waiting for the feed work it starts. */
  pollOnly: () => Promise<void>;
  settled: () => boolean;
  /** An HA reconnect: the old socket's feeds die, the feed set is rebuilt. */
  reconnect: () => Promise<void>;
  /** The driver's next statistics for `n` reach the add-on. */
  heard: (n: number) => boolean;
  /** Per-node re-subscribe lines in the log. */
  resubs: () => number;
  /** Per-node subscribes made for `n`'s feed. */
  calls: (n: number, feed: 'stats' | 'status') => number;
}

/** Nodes 1 (the controller), 7 and 60, each registered and interviewed. */
function baseSim(): Sim {
  const reg = new Registry();
  const zw = new Zwave(reg, 'E1', HOME);
  zw.add(1, '271:1:1');
  zw.add(7, P7);
  zw.add(60, P1);
  return { reg, zw, failSubs: new Set(), failFeed: new Set(), subCalls: [], released: new Map(), ctrlGen: 0, ctrlFeeds: [] };
}

/** `bootPolled` false: the body starts once the feed set is up, whether or not a roster poll has succeeded. */
async function withSim(s: Sim, body: (r: Run) => Promise<void>, opts: { evictAfterMs?: number; bootPolled?: boolean } = {}): Promise<void> {
  skip = 0;
  Date.now = () => realNow() + skip;
  const logs: string[] = [];
  const ha = fakeHa(s);
  const bootAt = Date.now() - 5 * DAY;
  const zd = createZwaveData({
    client: ha, refreshMs: 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * 60_000,
    historyPath: null, evidencePath: null, baselinesPath: null, outcomesPath: null, driverWsUrl: null,
    log: (m: string) => logs.push(m), uptimeMs: () => Date.now() - bootAt,
    ...(opts.evictAfterMs != null ? { evictAfterMs: opts.evictAfterMs } : {}),
  });
  const priv = zd as unknown as Priv;
  const settled = () => priv.registriesInFlight == null && !priv.rebuildInFlight && priv.statsSubscribed && !priv.nodeSubsBusy;
  const pollOnly = async () => {
    // The loop's own next poll is an hour away; take it out so a hand-driven
    // poll is the only one, and stop() clears the one this poll schedules.
    if (priv.pollTimer) clearTimeout(priv.pollTimer);
    await priv.tick();
  };
  try {
    zd.start();
    ha.fireReady();
    const booted = opts.bootPolled === false ? settled : () => zd.snapshot().length > 0 && priv.lastHomeId != null && settled();
    await waitFor(booted, 15_000, () => logs.join(' | '));
    await sleep(5);
    await body({
      zd, logs, priv, ha, settled, pollOnly,
      poll: async () => {
        await pollOnly();
        await waitFor(settled, 8000, () => logs.join(' | '));
        await sleep(5); // the replays
      },
      reconnect: async () => {
        const n = logs.filter((l) => l.startsWith('live statistics: subscribed')).length;
        s.zw.dropAll();
        ha.fireReady();
        await waitFor(() => logs.filter((l) => l.startsWith('live statistics: subscribed')).length > n && settled(), 8000, () => logs.join(' | '));
        await sleep(5);
      },
      heard: (n: number) => {
        s.zw.emitStats(n);
        return priv.statsByNode.get(n)?.commandsTX === s.zw.nodes.get(n)!.tx;
      },
      resubs: () => logs.filter((l) => /^live statistics: node \d+'s feeds: re-subscribe /.test(l)).length,
      calls: (n: number, feed: 'stats' | 'status') => s.subCalls.filter((c) => c.n === n && c.feed === feed).length,
    });
  } finally {
    zd.stop();
    Date.now = realNow;
  }
}

/** Each of `ids` has one statistics and one status feed, on the object held
 *  now; none is left on an old one; and no subscription was released twice. */
function bound(s: Sim, ids: number[], why: string): void {
  for (const n of ids) {
    assert.equal(s.zw.live(n, 'stats'), 1, `${why}: node ${n}'s statistics feeds on its node object`);
    assert.equal(s.zw.live(n, 'status'), 1, `${why}: node ${n}'s status feeds on its node object`);
  }
  assert.equal(s.zw.zombies(), 0, `${why}: feeds left on node objects Home Assistant no longer holds`);
  const twice = [...s.released.entries()].filter(([, k]) => k > 1).map(([sid]) => sid);
  assert.deepEqual(twice, [], `${why}: subscriptions released more than once`);
}

/** The controller objects the live controller feeds are bound to. */
const ctrlBound = (s: Sim): number[] => s.ctrlFeeds.filter((g): g is number => g != null);

/* ── the node object changed under the id ──────────────────────────────────── */

test('a replacement (v0.79.6): its feeds are re-subscribed on the new node object once the roster reads it not ready, and again when the swap shows; the old ones are released, and the new device is heard', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    bound(s, [7, 60], 'precondition');
    s.zw.emitStatus(60, 'dead');  // node 60 failed: its feed last heard Dead
    await r.poll();
    // replace_failed_node for both: node 7 by the same product, node 60 by another.
    s.zw.replacePending(7);
    s.zw.replacePending(60);
    await r.poll();
    bound(s, [7, 60], 'read interviewing');
    assert.ok(r.heard(60), 'the replacement is heard while interviewed');
    s.zw.interview(7, P7);
    s.zw.interview(60, P3);
    await r.poll();
    assert.equal(r.logs.filter((l) => l.startsWith("node 60's device changed in Home Assistant")).length, 1, 'precondition: node 60 is a swap');
    bound(s, [7, 60], 'read ready');
    assert.equal(r.calls(7, 'stats'), 2, 'node 7: the feed set, and the interview\'s start');
    assert.equal(r.calls(60, 'stats'), 3, 'node 60: the feed set, the interview\'s start, and the swap');
    assert.ok(r.heard(7) && r.heard(60), 'both replacements heard');
    // The new feed diffs against the replacement's status, not the failed node's.
    skip += 1_000;
    const t0 = Date.now();
    s.zw.emitStatus(60, 'dead');
    s.zw.emitStatus(60, 'alive');
    const deaths = r.zd.drainDeadEvents().filter((d) => d.nodeId === 60 && d.at >= t0);
    assert.equal(deaths.length, 1, 'the replacement\'s Dead crossing is counted');
    assert.equal(deaths[0].feedLive, true);
  });
});

test('a replacement no roster poll read (v0.79.6): the swap a load shows re-subscribes its feeds', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.replace(60, P3);         // removed, added and interviewed between two polls
    await r.poll();
    assert.equal(s.zw.live(60, 'stats'), 0, 'precondition: nothing on the roster showed it');
    s.statusErr = 'HA WS error (unknown_error): boom';
    await r.pollOnly();
    s.statusErr = undefined;
    await r.poll();               // succeeds after a failed one: a load, run in this poll
    assert.equal(r.logs.filter((l) => l.startsWith("node 60's device changed in Home Assistant")).length, 1, 'precondition: the swap shows');
    bound(s, [7, 60], 'after the swap');
    assert.ok(r.heard(60));
  });
});

test('a re-interview (v0.79.6): the same node object, re-subscribed once — released first, so it is not heard twice', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.startInterview(7);
    await r.poll();
    bound(s, [7, 60], 'interviewing');
    s.zw.interview(7, P7);
    await r.poll();
    bound(s, [7, 60], 'ready');
    assert.equal(r.calls(7, 'stats'), 2, 'one re-subscribe, at the interview\'s start');
    assert.equal(r.calls(7, 'status'), 2);
    assert.equal(r.calls(60, 'stats'), 1, 'no other node re-subscribed');
    assert.equal(r.resubs(), 1);
    assert.ok(r.heard(7));
  });
});

test('an id off the roster and back (inside the eviction dwell, or evicted), and a node included after the feed set was built, are subscribed (v0.79.6); an evicted node\'s feeds are released', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    // Node 7 excluded, and the same product included on its id inside the
    // eviction dwell, interviewed before the roster next reads it.
    s.zw.removeNode(7, 'excluded');
    await r.poll();
    s.zw.add(7, P7);
    await r.poll();
    assert.equal(r.logs.filter((l) => l.startsWith("node 7's device changed in Home Assistant")).length, 0, 'precondition: no swap');
    bound(s, [7, 60], 'back inside the dwell');
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    skip += 6_000;
    await r.poll();
    assert.ok(r.logs.some((l) => l === 'node 60 left the network — evicting its evidence + caches'), 'precondition: evicted');
    assert.equal(s.zw.zombies(), 0, 'the evicted node\'s feeds are released');
    s.zw.add(60, P3);             // included again on the freed id
    s.zw.add(61, P3);             // a node new to the mesh
    await r.poll();
    bound(s, [7, 60, 61], 'included');
    assert.ok(r.heard(60) && r.heard(61));
  }, { evictAfterMs: 5_000 });
});

/* ── what must not re-subscribe one node at a time ─────────────────────────── */

test('a driver restart costs no per-node re-subscribe (v0.79.6): the re-arm binds every node, and inside the re-arm\'s window the nodes wait for it', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const restart = async (): Promise<void> => {
      s.statusErr = NOT_LOADED;
      s.unloaded = true;
      await r.pollOnly();
      s.zw.restartDriver();
      s.statusErr = undefined;
      s.unloaded = false;
      await r.poll();             // the nodes read not ready
      for (const n of [7, 60]) { s.zw.ready(n); await r.poll(); }
    };
    await restart();
    assert.ok(r.logs.some((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)'), 'precondition: the re-arm ran');
    bound(s, [7, 60], 'after the restart');
    assert.equal(r.resubs(), 0, 'no node re-subscribed on its own');
    // A second restart inside the re-arm's window: the latch holds the re-arm.
    await restart();
    assert.equal(r.resubs(), 0, 'the nodes wait for the re-arm the latch holds');
    r.priv.lastFeedRearmAt = 0;   // the window over
    await r.poll();
    bound(s, [7, 60], 'after the held re-arm');
    assert.equal(r.resubs(), 0);
  });
});

/* ── the retry ─────────────────────────────────────────────────────────────── */

test('the retry (v0.79.6): it subscribes (before, it marked the feeds live and made none), keeps its handles by node so a re-arm releases them, stands aside while a rebuild runs, uses the device as last loaded, and leaves a node off the roster to its return', async () => {
  // Kept by node.
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: queued for the retry');
      s.failSubs.clear();
      await r.priv.retryNodeSubs();
      await sleep(5);
      bound(s, [7, 60], 'retried');
      r.priv.lastFeedRearmAt = 0;
      await r.priv.rearmStatsFeeds('test');
      await waitFor(r.settled);
      bound(s, [7, 60], 'after a re-arm');
    });
  }
  // Not beside a rebuild.
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      s.failSubs.clear();
      s.ctrlGate = gate();
      const g = s.ctrlGate;
      const n = r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length;
      s.zw.dropAll();
      r.ha.fireReady();           // a reconnect, its rebuild parked
      await waitFor(() => g.arrived);
      await r.priv.retryNodeSubs();
      assert.equal(r.calls(60, 'stats'), 0, 'the retry stood aside');
      g.open();
      await waitFor(() => r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length > n && r.settled());
      await sleep(5);
      bound(s, [7, 60], 'the rebuild subscribed it');
    });
  }
  // The device as last loaded.
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      const oldDev = r.zd.deviceIdOf(60)!;
      s.zw.replacePending(60);
      await r.poll();
      s.zw.interview(60, P3);
      await r.poll();             // the swap: node 60's device is another
      assert.notEqual(r.zd.deviceIdOf(60), oldDev, 'precondition: a new device');
      assert.equal(r.logs.filter((l) => l.startsWith('node-stats subscribe failed (node 60)')).length, 1,
        'a node queued for the retry is left to it: the polls made no subscribe of their own');
      s.reg.remove(oldDev);       // the orphan deleted in Home Assistant
      s.failSubs.clear();
      await r.priv.retryNodeSubs();
      await sleep(5);
      bound(s, [7, 60], 'retried by the new device');
    });
  }
  // Not a node off the roster: subscribed once it is back.
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      const failed = () => r.logs.filter((l) => l.startsWith('node-stats subscribe failed (node 60)')).length;
      s.zw.removeNode(60, 'excluded');
      await r.poll();
      s.failSubs.clear();
      await r.priv.retryNodeSubs();
      assert.equal(failed(), 1, 'no subscribe for a node off the roster');
      assert.equal(r.priv.pendingNodeSubs.has(60), false, 'it left the queue');
      s.zw.add(60, P1);
      await r.poll();
      bound(s, [7, 60], 'back on the roster');
    });
  }
});

/* ── a status change the feed did not deliver ──────────────────────────────── */

test('a replacement of a failed node that read not ready (v0.79.6): no interview start, absence or swap shows, and the status its feed did not deliver re-subscribes it', async () => {
  const s = baseSim();
  // zwave-js: a node restored from its cache reads ready only once it is
  // known not dead (NodeReadyMachine), so one dead since the driver started
  // reads Dead and not ready, and its replacement never reads ready → not ready.
  const o = s.zw.nodes.get(60)!;
  o.ready = false;
  o.st = 3;
  await withSim(s, async (r) => {
    await r.poll();               // its status feed is live from before this poll
    s.zw.replacePending(60);      // the same product, Alive at once, between two polls
    await r.poll();
    assert.equal(r.resubs(), 1, 'one re-subscribe, at the poll that reads it Alive');
    bound(s, [7, 60], 'read interviewing');
    s.zw.interview(60, P1);
    await r.poll();
    assert.equal(r.logs.filter((l) => l.startsWith("node 60's device changed in Home Assistant")).length, 0, 'precondition: no swap');
    bound(s, [7, 60], 'read ready');
    assert.ok(r.heard(60), 'the replacement is heard');
    assert.equal(r.resubs(), 1);
  });
});

test('a driver restart whose nodes change status before the re-arm\'s feeds are made costs no per-node re-subscribe (v0.79.6): a feed made since the previous poll is not judged by a change it may have missed', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.statusErr = NOT_LOADED;
    s.unloaded = true;
    await r.pollOnly();
    s.zw.restartDriver();
    for (const n of [7, 60]) s.zw.nodes.get(n)!.st = 0; // read from the driver's cache: Unknown
    s.statusErr = undefined;
    s.unloaded = false;
    s.ctrlGate = gate();
    const cg = s.ctrlGate;
    await r.pollOnly();           // reads them Unknown and not ready; the re-arm starts after it
    await waitFor(() => cg.arrived);
    // The restarted driver marks them alive before the re-arm subscribes
    // them: no feed hears it.
    for (const n of [7, 60]) s.zw.emitStatus(n, 'alive');
    cg.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.ok(r.logs.some((l) => l === 'live statistics: re-subscribing (zwave_js config entry reloaded)'), 'precondition: the re-arm ran');
    await r.poll();               // reads them Alive: a change the new feeds did not deliver
    for (const n of [7, 60]) { s.zw.ready(n); await r.poll(); }
    assert.equal(r.resubs(), 0, 'no node re-subscribed on its own');
    bound(s, [7, 60], 'after the restart');
  });
});

/* ── the retry, beside a node's own re-subscribe ───────────────────────────── */

test('the retry (v0.79.6): before any roster poll succeeded it keeps a node with one feed made and the other queued, and makes the other', async () => {
  const s = baseSim();
  s.failFeed.add('60:status');
  s.statusErr = 'HA WS error (unknown_error): boom';
  await withSim(s, async (r) => {
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: its status feed queued');
    assert.equal(r.zd.snapshot().length, 0, 'precondition: no roster poll has succeeded');
    s.failFeed.clear();
    await r.priv.retryNodeSubs();
    s.statusErr = undefined;
    await r.poll();
    await r.poll();
    bound(s, [7, 60], 'retried before the first roster');
  }, { bootPolled: false });
});

test('the retry and a node\'s own re-subscribe stand aside for each other, and the retry for a feed set torn down (v0.79.6): one feed per node object', async () => {
  // The retry out: the poll's re-subscribe of the same node waits.
  {
    const s = baseSim();
    s.failFeed.add('60:status');
    await withSim(s, async (r) => {
      assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: its status feed queued');
      s.failFeed.clear();
      s.zw.startInterview(60);    // and a mark for it at the next poll
      s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
      const g = s.subGate;
      const retry = r.priv.retryNodeSubs();
      await waitFor(() => g.arrived);
      await r.pollOnly();
      await sleep(20);
      assert.equal(r.resubs(), 0, 'the poll\'s re-subscribe waited');
      g.open();
      await retry;
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'the retry done');
      await r.poll();             // the mark is newer than its statistics feed: re-subscribed now
      assert.equal(r.resubs(), 1);
      bound(s, [7, 60], 'after');
    });
  }
  // A node's re-subscribe out: the retry waits.
  {
    const s = baseSim();
    s.failFeed.add('60:status');
    await withSim(s, async (r) => {
      s.failFeed.clear();
      s.zw.startInterview(60);
      s.unsubGate = { ...gate(), feed: 'stats', n: 60 };
      const u = s.unsubGate;
      await r.pollOnly();         // node 60's re-subscribe, parked releasing its statistics feed
      await waitFor(() => u.arrived);
      await r.priv.retryNodeSubs();
      assert.equal(r.calls(60, 'status'), 0, 'the retry stood aside');
      u.open();
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'after');
    });
  }
  // A reconnect whose rebuild failed before it subscribed the nodes: the
  // retry waits for the next rebuild, which subscribes every node.
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      s.failSubs.clear();
      s.regErr = true;
      s.zw.dropAll();
      r.ha.fireReady();
      await waitFor(() => r.logs.some((l) => l.startsWith('subscribeStatistics failed')) && !r.priv.rebuildInFlight);
      await r.priv.retryNodeSubs();
      assert.equal(r.calls(60, 'stats'), 0, 'the retry stood aside');
      s.regErr = false;
      await r.poll();             // the poll starts the rebuild
      bound(s, [7, 60], 'the rebuild subscribed it');
    });
  }
});

test('a node\'s own re-subscribe that fails is left to the retry timer (v0.79.6)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    assert.equal(r.priv.subRetryTimer, null, 'precondition: nothing queued at boot');
    s.zw.startInterview(60);
    s.failSubs.add(60);
    await r.poll();
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'queued');
    assert.notEqual(r.priv.subRetryTimer, null, 'the retry timer runs');
    s.failSubs.clear();
    await r.priv.retryNodeSubs();
    await sleep(5);
    bound(s, [7, 60], 'retried');
  });
});

test('the controller node gets no per-node feeds (v0.79.6): the controller statistics feed is its feed', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    await r.poll();
    assert.equal(r.calls(1, 'stats') + r.calls(1, 'status'), 0);
  });
});

test('a re-arm releases each node\'s feeds once (v0.79.6): an eviction after a re-arm whose rebuild failed releases nothing again', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    s.regErr = true;
    r.priv.lastFeedRearmAt = 0;
    await r.priv.rearmStatsFeeds('test');
    assert.ok(r.logs.some((l) => l.startsWith('subscribeStatistics failed')), 'precondition: the rebuild failed at the registry load');
    s.regErr = false;
    skip += 6 * 60_000;
    await r.poll();               // the eviction, and the rebuild this poll starts
    assert.ok(r.logs.some((l) => l === 'node 60 left the network — evicting its evidence + caches'), 'precondition: evicted');
    bound(s, [7], 'after');
  });
});

/* ── the dead-feed watchdog ────────────────────────────────────────────────── */

test('feeds a node\'s own re-subscribe or the retry made stamp no arrival on the fleet\'s liveness clock (v0.79.6), replay or live; the feed set\'s events do', async () => {
  {
    const s = baseSim();
    await withSim(s, async (r) => {
      skip += 20_000;             // past the feed set's replay window
      assert.ok(r.heard(7));
      const at = r.priv.lastStatsAt;
      assert.ok(at != null, 'precondition: a feed-set event stamped it');
      skip += 30_000;
      s.zw.startInterview(60);
      await r.poll();
      assert.equal(r.calls(60, 'stats'), 2, 'precondition: re-subscribed, and replayed');
      assert.ok(r.heard(60), 'its new feed delivers');
      assert.equal(r.priv.lastStatsAt, at, 'neither its replay nor its live event stamped it');
      assert.ok(r.heard(7));
      assert.ok(r.priv.lastStatsAt! > at!, 'a feed-set event does');
    });
  }
  {
    const s = baseSim();
    s.failSubs.add(60);
    await withSim(s, async (r) => {
      skip += 20_000;
      assert.ok(r.heard(7));
      const at = r.priv.lastStatsAt;
      skip += 30_000;
      s.failSubs.clear();
      await r.priv.retryNodeSubs();
      await sleep(5);
      assert.equal(r.calls(60, 'stats'), 1, 'precondition: retried, and replayed');
      assert.ok(r.heard(60));
      assert.equal(r.priv.lastStatsAt, at, 'the retried feed stamped nothing');
    });
  }
});

test('an entry reload no poll saw, one node re-subscribed on its own meanwhile (v0.79.6): its feed does not hold the dead-feed watchdog off, and the feed set is rebuilt, the controller\'s included', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    skip += 20_000;               // past the feed set's replay window
    assert.ok(r.heard(7));
    assert.deepEqual(ctrlBound(s), [0], 'precondition: one controller feed');
    // Home Assistant sets zwave_js up again between two polls: every node
    // object is new, the controller's too. Node 60 still reads not ready at
    // the next poll; node 7 is ready again by then.
    s.zw.restartDriver();
    s.zw.nodes.get(7)!.ready = true;
    s.ctrlGen = 1;
    await r.poll();
    assert.equal(r.resubs(), 1, 'precondition: node 60 re-subscribed on its own');
    assert.equal(s.zw.live(7, 'stats'), 0, 'precondition: node 7\'s feeds are on a node object Home Assistant no longer holds');
    skip += 11 * 60_000;
    assert.ok(r.heard(60), 'node 60 keeps reporting');
    await r.poll();
    assert.ok(r.logs.some((l) => /^live statistics: re-subscribing \(no statistics from any node for \d+m\)$/.test(l)), r.logs.join(' | '));
    bound(s, [7, 60], 'after the watchdog');
    assert.deepEqual(ctrlBound(s), [1], 'the controller feed is bound to the new controller, and only there');
  });
});

/* ── a node's re-subscribe across a reconnect or a rebuild ─────────────────── */

test('a node\'s re-subscribe that resolves after a reconnect, or after a re-arm began, is released and not kept (v0.79.6); one whose release a rebuild overtook leaves the rebuild\'s bookkeeping', async () => {
  for (const across of ['reconnect', 're-arm'] as const) {
    const s = baseSim();
    await withSim(s, async (r) => {
      const dev7 = r.zd.deviceIdOf(7)!;
      s.subGate = { ...gate(), feed: 'status', dev: dev7 };
      const sg = s.subGate;
      s.zw.startInterview(7);
      await r.pollOnly();
      await waitFor(() => sg.arrived);
      s.ctrlGate = gate();
      const cg = s.ctrlGate;
      if (across === 'reconnect') { s.zw.dropAll(); r.ha.fireReady(); } else { r.priv.lastFeedRearmAt = 0; void r.priv.rearmStatsFeeds('test'); }
      await waitFor(() => cg.arrived);   // the rebuild parked before it subscribes the nodes
      sg.open();
      await waitFor(() => !r.priv.nodeSubsBusy);
      cg.open();
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], across);
      assert.equal(r.priv.statusSubbed.has(7), true);
    });
  }
  {
    const s = baseSim();
    await withSim(s, async (r) => {
      s.unsubGate = { ...gate(), feed: 'stats', n: 7 };
      const ug = s.unsubGate;
      s.zw.startInterview(7);
      await r.pollOnly();
      await waitFor(() => ug.arrived);   // node 7's re-subscribe, releasing its old feed
      r.priv.lastFeedRearmAt = 0;
      await r.priv.rearmStatsFeeds('test');
      await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight);
      ug.open();
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'the release done');
      assert.equal(r.priv.statusSubbed.has(7), true, 'the rebuild\'s status feed still reads live');
      assert.equal(r.priv.statsSubbedNodes.has(7), true, 'the rebuild\'s statistics feed still reads live');
    });
  }
});

test('a node\'s re-subscribe waits for a rebuild running or about to, and runs one at a time (v0.79.6)', async () => {
  // A reconnect's rebuild parked before it subscribes the nodes.
  {
    const s = baseSim();
    await withSim(s, async (r) => {
      s.ctrlGate = gate();
      const cg = s.ctrlGate;
      s.zw.dropAll();
      r.ha.fireReady();
      await waitFor(() => cg.arrived);
      s.zw.startInterview(7);
      await r.pollOnly();
      cg.open();
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'the rebuild subscribed node 7');
      assert.equal(r.resubs(), 0, 'the node waited for it');
    });
  }
  // A re-arm releasing the old feed set.
  {
    const s = baseSim();
    await withSim(s, async (r) => {
      s.unsubGate = { ...gate(), feed: 'stats', n: 60 };
      const ug = s.unsubGate;
      r.priv.lastFeedRearmAt = 0;
      const rearm = r.priv.rearmStatsFeeds('test');
      await waitFor(() => ug.arrived);
      s.zw.startInterview(7);
      await r.pollOnly();
      ug.open();
      await rearm;
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'the re-arm subscribed node 7');
    });
  }
  // A poll while one node's re-subscribe is out.
  {
    const s = baseSim();
    await withSim(s, async (r) => {
      s.subGate = { ...gate(), feed: 'stats', dev: r.zd.deviceIdOf(7)! };
      const sg = s.subGate;
      s.zw.startInterview(7);
      await r.pollOnly();
      await waitFor(() => sg.arrived);
      await r.pollOnly();
      sg.open();
      await waitFor(r.settled);
      await sleep(5);
      bound(s, [7, 60], 'one re-subscribe');
      assert.equal(r.calls(7, 'stats'), 2);
    });
  }
});
