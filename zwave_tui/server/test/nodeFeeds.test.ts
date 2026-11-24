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
/** A status event of a node object: alive, dead, sleep or wake up. */
type StatusEv = 'dead' | 'alive' | 'sleep' | 'wake up';
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
  emitStatus(n: number, ev: StatusEv): void {
    const o = this.nodes.get(n)!;
    o.st = ev === 'dead' ? 3 : ev === 'alive' ? 4 : ev === 'sleep' ? 1 : 2;
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
  /** Parks the next device registry list. */
  regGate?: Gate | null;
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
      case 'config/device_registry/list': {
        const g = s.regGate;
        if (g) { s.regGate = null; g.arrived = true; await g.wait; }
        if (s.regErr) throw new Error('HA WS error (unknown_error): registry');
        return listRows(s);
      }
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

/** `bootPolled` false: the body starts once the feed set is up, whether or not a roster poll has succeeded.
 *  `boot`: the body starts once it holds instead (a boot rebuild parked, say). */
async function withSim(s: Sim, body: (r: Run) => Promise<void>, opts: { evictAfterMs?: number; bootPolled?: boolean; boot?: (priv: Priv) => boolean } = {}): Promise<void> {
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
    const booted = opts.boot != null ? () => opts.boot!(priv)
      : opts.bootPolled === false ? settled : () => zd.snapshot().length > 0 && priv.lastHomeId != null && settled();
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

/* ── a rebuild a reconnect superseded, and the one that superseded it ──────── */

/** Per-node subscribe lines in the log: a node's own re-subscribe, or one with none subscribed. */
const perNodeLines = (r: Run): number => r.logs.filter((l) => /^live statistics: node \d+'s feeds: /.test(l)).length;
/** The device each node of the sim is filed under in Home Assistant's registry. */
const devOf = (s: Sim, n: number): string => s.reg.getEntry([s.zw.H(n)], s.zw.entry)!.id;

test('a boot rebuild a reconnect superseded, a roster poll landing inside the per-node step of the rebuild that superseded it: no node is subscribed beside that rebuild, and each keeps one feed per node object (v0.79.6 review)', async () => {
  // Before, the superseded run's `finally` cleared rebuildInFlight while the
  // new connection's run still built: the poll subscribed every node into
  // the boot's empty map, which that run then replaced, and every node was
  // left with two feeds of each kind that no re-arm could release.
  const s = baseSim();
  // The boot rebuild (A) parks on node 60's status subscribe.
  s.subGate = { ...gate(), feed: 'status', dev: devOf(s, 60) };
  const ga = s.subGate;
  await withSim(s, async (r) => {
    // The boot poll succeeded while A ran, and stood aside for it.
    assert.equal(perNodeLines(r), 0, 'precondition: no node subscribed beside A');
    // The Core drops the socket. On re-auth the new rebuild (B) parks inside
    // its per-node step, on node 7's status subscribe.
    s.zw.dropAll();
    s.subGate = { ...gate(), feed: 'status', dev: devOf(s, 7) };
    const gb = s.subGate;
    r.ha.fireReady();
    await waitFor(() => gb.arrived);
    // A wakes on the new connection, superseded, and stands down.
    ga.open();
    await waitFor(() => r.logs.some((l) => l === 'subscribe: superseded by a reconnect mid-run — standing down'));
    await sleep(20);
    // A roster poll that answers while B is still subscribing the nodes
    // (network_status awaits the driver; the subscribes answer at once).
    await r.pollOnly();
    await waitFor(() => !r.priv.nodeSubsBusy);
    await sleep(20);
    const beside = perNodeLines(r);
    gb.open();
    await waitFor(r.settled);
    await sleep(5);
    bound(s, [7, 60], 'after B');
    assert.equal(beside, 0, 'no node subscribed beside B');
    // A re-arm releases every handle the books hold.
    r.priv.lastFeedRearmAt = 0;
    await r.priv.rearmStatsFeeds('test');
    await waitFor(r.settled);
    await sleep(5);
    bound(s, [7, 60], 'after a re-arm');
  }, { boot: (p) => ga.arrived && p.lastHomeId != null });
});

test('a re-arm\'s rebuild a reconnect superseded, a roster poll landing inside the per-node step of the rebuild that superseded it: no node is subscribed beside that rebuild, one feed per node object (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    // The re-arm's rebuild (R1) parks on node 7's statistics subscribe, once
    // its node 60 subscribes are made.
    s.subGate = { ...gate(), feed: 'stats', dev: r.zd.deviceIdOf(7)! };
    const g1 = s.subGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => g1.arrived && r.calls(60, 'status') === 2);
    // A reconnect: its rebuild (R2) parks inside its per-node step, on node
    // 60's status subscribe.
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g2 = s.subGate;
    s.zw.dropAll();
    r.ha.fireReady();
    await waitFor(() => g2.arrived);
    g1.open();
    await rearm;                  // R1 superseded, stood down
    await r.pollOnly();
    await waitFor(() => !r.priv.nodeSubsBusy);
    await sleep(5);
    const beside = perNodeLines(r);
    g2.open();
    await waitFor(r.settled);
    await sleep(5);
    bound(s, [7, 60], 'after R2');
    assert.equal(beside, 0, 'no node subscribed beside R2');
  });
});

test('the retry timer firing while a reconnect\'s rebuild superseded a re-arm\'s: it stands aside for the rebuild that superseded it, which subscribes the node once (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.subGate = { ...gate(), feed: 'stats', dev: r.zd.deviceIdOf(7)! };
    const g1 = s.subGate;
    s.failSubs.add(60);           // the re-arm's rebuild (R1) queues node 60 for the retry
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => g1.arrived);
    // A reconnect: its rebuild (R2) parks before it subscribes the nodes.
    s.ctrlGate = gate();
    const cg = s.ctrlGate;
    s.zw.dropAll();
    r.ha.fireReady();
    await waitFor(() => cg.arrived);
    g1.open();
    await rearm;                  // R1 superseded, stood down
    s.failSubs.clear();
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: node 60 queued');
    const c0 = r.calls(60, 'stats');
    await r.priv.retryNodeSubs();
    await sleep(5);
    assert.equal(r.calls(60, 'stats') - c0, 0, 'the retry stood aside');
    cg.open();
    await waitFor(r.settled);
    await sleep(5);
    bound(s, [7, 60], 'after R2');
  });
});

test('a reconnect\'s rebuild that ends before the re-arm\'s it superseded stands down leaves no rebuild in flight once that one has: a node\'s re-subscribe runs at the next poll (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.subGate = { ...gate(), feed: 'stats', dev: r.zd.deviceIdOf(7)! };
    const g1 = s.subGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => g1.arrived);
    const n = r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length;
    s.zw.dropAll();
    r.ha.fireReady();
    await waitFor(() => r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length > n && !r.priv.rebuildInFlight);
    g1.open();
    await rearm;                  // the superseded run stands down last
    assert.equal(r.priv.rebuildInFlight, false, 'no rebuild in flight');
    s.zw.startInterview(7);
    await r.poll();
    assert.equal(r.resubs(), 1, 'node 7 re-subscribed at the poll that read it not ready');
    bound(s, [7, 60], 'after');
  });
});

/* ── the retry, a node with no device as last loaded ───────────────────────── */

test('the retry drops a node with no device as last loaded: an old network\'s device the boot load admitted is not retried every minute, the timer stops, and a node later included on its id is subscribed (v0.79.6 review)', async () => {
  const s = baseSim();
  // An unknown controller: Home Assistant keeps the old network's devices
  // under the entry (its orphan sweep is skipped), and node 90 is not on this one.
  s.reg.getOrCreate('E1', ['1111111111-90']);
  await withSim(s, async (r) => {
    const fails = () => r.logs.filter((l) => /subscribe failed \(node 90\)/.test(l)).length;
    assert.equal(r.priv.pendingNodeSubs.has(90), true, 'precondition: the boot rebuild queued node 90');
    await r.poll();
    await r.poll();
    assert.equal(r.zd.deviceIdOf(90) ?? null, null, 'precondition: the load that bound the home id left node 90 out');
    const f0 = fails();
    for (let i = 0; i < 3; i++) { await r.priv.retryNodeSubs(); await sleep(5); }
    assert.equal(fails() - f0, 0, 'no subscribe for an id with no device');
    assert.equal(r.priv.pendingNodeSubs.has(90), false, 'it left the queue');
    assert.equal(r.priv.subRetryTimer, null, 'the timer stopped');
    s.zw.add(90, P3);             // a node of this network included on id 90
    await r.poll();
    await r.poll();
    bound(s, [7, 60, 90], 'included on 90');
  });
});

test('the retry marks a node it drops for having no device: one with a feed made and the other queued is re-subscribed once a load gives its device back (v0.79.6 review)', async () => {
  const s = baseSim();
  s.failFeed.add('60:status');    // the feed set makes node 60's statistics feed and queues its status feed
  await withSim(s, async (r) => {
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: its status feed queued');
    const dev60 = r.zd.deviceIdOf(60)!;
    // A load: a poll that succeeds after a failed one runs one, past the
    // minute's spacing of such loads.
    const load = async (): Promise<void> => {
      skip += 61_000;
      s.statusErr = 'HA WS error (unknown_error): boom';
      await r.pollOnly();
      s.statusErr = undefined;
      await r.poll();
    };
    s.reg.remove(dev60);
    await load();
    assert.equal(r.zd.deviceIdOf(60) ?? null, null, 'precondition: no device as last loaded');
    s.failFeed.clear();
    await r.priv.retryNodeSubs();
    await sleep(5);
    assert.equal(r.priv.pendingNodeSubs.has(60), false, 'it left the queue');
    s.zw.register(60);            // Home Assistant restores the device it deleted
    await load();
    assert.equal(r.zd.deviceIdOf(60), dev60, 'precondition: the same device back, no swap');
    bound(s, [7, 60], 'its device back');
    assert.equal(r.resubs(), 1, 'its feeds re-subscribed once');
  });
});

test('a re-arm\'s rebuild a reconnect superseded failing on the new connection leaves the feed set to the rebuild that superseded it: a roster poll starts no second rebuild beside it, one feed per node object (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    // The re-arm's rebuild (R1) parks on its controller subscribe, which
    // then fails on the new connection (the entry not loaded yet).
    let fail!: (e: Error) => void;
    const wait = new Promise<void>((_, j) => { fail = j; });
    wait.catch(() => {});
    const g1: Gate = { wait, open: () => fail(new Error(NOT_LOADED)), arrived: false };
    s.ctrlGate = g1;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => g1.arrived);
    // A reconnect: its rebuild (R2) parks inside its per-node step.
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(7)! };
    const g2 = s.subGate;
    s.zw.dropAll();
    r.ha.fireReady();
    await waitFor(() => g2.arrived);
    const ctrl0 = s.ctrlFeeds.length;
    g1.open();
    await rearm;                  // R1 failed, superseded
    assert.equal(r.priv.statsSubscribed, true, 'R2 still owns the feed set');
    await r.pollOnly();
    await waitFor(() => !r.priv.nodeSubsBusy);
    await sleep(5);
    assert.equal(s.ctrlFeeds.length - ctrl0, 0, 'no second rebuild beside R2');
    assert.equal(r.priv.rebuildInFlight, true, 'R2 still in flight');
    g2.open();
    await waitFor(r.settled);
    await sleep(5);
    bound(s, [7, 60], 'after R2');
  });
});

/* ── an id back with no device as last loaded ──────────────────────────────── */

/** Registry loads run so far. */
const registryLoads = (r: Run): number => r.logs.filter((l) => l.startsWith('registry join:')).length;
/** A registry load: a roster poll that succeeds after a failed one runs one, past the minute's spacing of such loads. */
async function loadAfterFailedPoll(s: Sim, r: Run): Promise<void> {
  skip += 61_000;
  s.statusErr = 'HA WS error (unknown_error): boom';
  await r.pollOnly();
  s.statusErr = undefined;
  await r.poll();
}

test('a node excluded and included again on its id inside the eviction dwell, a registry load run while it was away: subscribed at the poll that lists it, its feeds on the excluded node released (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.removeNode(60, 'excluded');      // Home Assistant deletes its device
    await r.poll();                       // off the roster: marked
    s.zw.startInterview(7);               // another node re-interviewed meanwhile
    await r.poll();
    s.zw.interview(7, P7);
    skip += 61_000;                       // past the roster loads' spacing
    await r.poll();                       // node 7's ready false→true: a load, with node 60 away
    assert.equal(r.zd.deviceIdOf(60) ?? null, null, 'precondition: the load left node 60 out');
    assert.equal(s.zw.zombies(), 2, 'precondition: node 60\'s feeds on the excluded node object');
    // Included again on 60, its interview running: Home Assistant restores
    // the device it deleted. Before, nothing asked for a load (the id has an
    // own-device record), and rearmNodeFeeds skips a node with no device.
    s.zw.addPending(60);
    await r.poll();
    bound(s, [7, 60], 'back, interviewing');
    assert.ok(r.heard(60), 'it is heard while interviewed');
  });
});

test('an id back on the roster with a record but no device as last loaded asks one registry load, none at the polls after; so does a node whose device Home Assistant deleted while it stays on the roster (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    await loadAfterFailedPoll(s, r);      // a load while node 60 is away
    assert.equal(r.zd.deviceIdOf(60) ?? null, null, 'precondition: no device as last loaded');
    s.zw.addPending(60);
    const l0 = registryLoads(r);
    await r.poll();
    const atReturn = registryLoads(r) - l0;
    for (let i = 0; i < 5; i++) { skip += 2_000; await r.poll(); }
    const after = registryLoads(r) - l0 - atReturn;
    bound(s, [7, 60], 'back, interviewing');
    s.reg.remove(r.zd.deviceIdOf(7)!);    // node 7's device deleted in Home Assistant, node 7 still on the roster
    await loadAfterFailedPoll(s, r);      // the load that drops it
    assert.equal(r.zd.deviceIdOf(7) ?? null, null, 'precondition: node 7 has no device as last loaded');
    const l1 = registryLoads(r);
    for (let i = 0; i < 5; i++) { skip += 2_000; await r.poll(); }
    assert.deepEqual({ atReturn, after, node7: registryLoads(r) - l1 }, { atReturn: 1, after: 0, node7: 1 }, 'registry loads');
  });
});

/* ── a status feed's baseline ──────────────────────────────────────────────── */

test('a re-interviewed node that dies after its old status feed is released and before the new one is attached: the first poll after the new feed answered takes the death as its baseline, so a later replacement by the same product is re-subscribed (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.startInterview(60);              // a re-interview: the same object, not ready, still Alive
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    await r.pollOnly();                   // reads it not ready: its own re-subscribe, parked on the status subscribe
    await waitFor(() => g.arrived);       // its old feeds released, the new statistics feed made
    s.zw.emitStatus(60, 'dead');          // no status listener on the object: no feed hears it
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }   // reads it Dead
    bound(s, [7, 60], 'the failed node');
    s.zw.replacePending(60);              // replace_failed_node by the same product, between two polls
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.interview(60, P1);
    skip += 61_000;
    await r.poll();
    await r.poll();
    assert.equal(r.logs.filter((l) => l.startsWith("node 60's device changed in Home Assistant")).length, 0, 'precondition: no swap');
    bound(s, [7, 60], 'the replacement, ready');
    assert.ok(r.heard(60), 'the replacement is heard');
  });
});

test('a re-interviewed node whose death its old status feed delivers while the re-subscribe releases its statistics feed: the new feed\'s baseline is the first poll after it answered, not the older roster reading, so a later replacement by the same product is re-subscribed (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.startInterview(60);
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };
    const u = s.unsubGate;
    await r.pollOnly();                   // reads it Alive and not ready: its own re-subscribe
    await waitFor(() => u.arrived);       // releasing the statistics feed; the status feed still live, as haWsClient drops only the released feed's handler
    s.zw.emitStatus(60, 'dead');          // delivered on the old status feed, and carried past its release (v0.79.7 review; discarded before)
    u.open();
    await waitFor(r.settled);
    await sleep(5);
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.replacePending(60);
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.interview(60, P1);
    skip += 61_000;
    await r.poll();
    await r.poll();
    bound(s, [7, 60], 'the replacement, ready');
  });
});

test('a re-interviewed node whose death its new status feed hears: a later replacement by the same product is re-subscribed (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.startInterview(60);
    await r.poll();                       // its own re-subscribe, done
    s.zw.emitStatus(60, 'dead');
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.replacePending(60);
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.interview(60, P1);
    skip += 61_000;
    await r.poll();
    await r.poll();
    bound(s, [7, 60], 'the replacement, ready');
  });
});

test('a node that died while the socket was down: the reconnect\'s rebuild seeds its status feed with the status before, the first poll after takes the death as its baseline, and the replacement by the same product of the failed node that read not ready is re-subscribed (v0.79.6 review)', async () => {
  const s = baseSim();
  s.zw.nodes.get(60)!.ready = false;      // its interview never completed: Alive and not ready
  await withSim(s, async (r) => {
    await r.poll();
    s.zw.dropAll();                       // the socket drops, and node 60 dies meanwhile: no feed hears it
    s.zw.emitStatus(60, 'dead');
    await r.reconnect();                  // the rebuild seeds node 60's status feed from the roster: Alive
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }   // reads it Dead
    s.zw.replacePending(60);
    for (let i = 0; i < 3; i++) { skip += 2_000; await r.poll(); }
    s.zw.interview(60, P1);
    skip += 61_000;
    await r.poll();
    await r.poll();
    assert.equal(r.logs.filter((l) => l.startsWith("node 60's device changed in Home Assistant")).length, 0, 'precondition: no swap');
    bound(s, [7, 60], 'the replacement, ready');
  });
});

test('a roster poll while a rebuild has a node\'s status feed still out leaves that feed\'s seed to the rebuild: the revival the new feed hears clears the death the roster fallback counted (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.reconnect();                  // a rebuild: its status feeds answered after the last poll was sent
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');   // a re-arm: its rebuild parks on node 60's status subscribe
    await waitFor(() => g.arrived);
    await r.pollOnly();                   // reads node 60 Alive, with no status feed
    s.zw.emitStatus(60, 'dead');          // its statistics feed is made, its status feed not: no feed hears it
    skip += 2_000;
    await r.pollOnly();                   // reads it Dead: the roster fallback counts the death
    g.open();
    await rearm;
    await waitFor(r.settled);
    await sleep(5);
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
    bound(s, [7, 60], 'after the rebuild');
  });
});

/** The next roster poll's answer and a status event of node `n` read together:
 *  the `ws` client can hand each frame of one read to its handler before the
 *  poll resumes (uncompressed frames), so the event is handled after the
 *  poll's reading was taken and before the poll acts on it. `during` runs
 *  while the poll is out, after its reading. */
function readWithAnswer(r: Run, s: Sim, n: number, ev: 'dead' | 'alive', during?: () => Promise<void>): void {
  const send = r.ha.send.bind(r.ha);
  r.ha.send = (async (cmd: Record<string, unknown>) => {
    const res = await send(cmd);
    if (cmd.type !== 'zwave_js/network_status') return res;
    r.ha.send = send;
    if (during) await during();
    queueMicrotask(() => s.zw.emitStatus(n, ev));
    return res;
  }) as typeof r.ha.send;
}

test('a status event read together with the answer of a poll after the first one since its feed answered is kept: that poll\'s older reading does not replace it, and the next poll re-subscribes nothing (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();                       // node 60's status feed answered before this poll was sent
    readWithAnswer(r, s, 60, 'dead');
    skip += 2_000;
    await r.poll();                       // reads it Alive; the death its feed delivers is handled before the poll acts
    skip += 2_000;
    await r.poll();                       // reads it Dead
    assert.equal(r.resubs(), 0, 'no node re-subscribed');
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
  });
});

test('a status feed that answers while a roster poll is out, and a status event read together with that poll\'s answer: the event is kept, so the revival after it clears the death (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.startInterview(60);
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    await r.pollOnly();                   // reads it not ready: its own re-subscribe, parked on the status subscribe
    await waitFor(() => g.arrived);
    // The next poll: its reading taken, then the status feed answers, then the death.
    readWithAnswer(r, s, 60, 'dead', async () => {
      g.open();
      await waitFor(() => r.priv.statusSubbed.has(60));
    });
    skip += 2_000;
    await r.poll();
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // the revival, heard by the new status feed
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
    bound(s, [7, 60], 'after');
  });
});

test('a death read together with the answer of the first poll sent since its status feed answered, the node revived before the next poll: the revival clears the death, and nothing is re-subscribed (v0.79.7)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.reconnect();                  // a rebuild: its status feeds answered after the last poll was sent
    readWithAnswer(r, s, 60, 'dead');
    skip += 2_000;
    await r.poll();                       // reads node 60 Alive; the death its feed delivers is handled before the poll acts
    skip += 500;
    s.zw.emitStatus(60, 'alive');         // the revival, heard by its feed
    skip += 1_500;
    await r.poll();
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
    assert.equal(r.resubs(), 0, 'no node re-subscribed');
  });
});

test('a revival read together with the answer of a poll that reads the node Dead: its feed delivered both changes, so nothing is re-subscribed (v0.79.7)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();                       // node 60's status feed answered before this poll was sent
    s.zw.emitStatus(60, 'dead');          // heard by its feed
    readWithAnswer(r, s, 60, 'alive');
    skip += 2_000;
    await r.poll();                       // reads it Dead; the revival its feed delivers is handled before the poll acts
    skip += 2_000;
    await r.poll();                       // reads it Alive
    assert.equal(r.resubs(), 0, 'no node re-subscribed');
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death, cleared by the revival');
    bound(s, [7, 60], 'after');
  });
});

test('a node\'s own re-subscribe whose status subscribe fails, the node dying before the retry: the retried status feed is seeded from the roster\'s latest reading, so a revival before the next poll clears the death the roster fallback counted; a pin of v0.79.6 behaviour, as each poll now re-baselines a live feed (v0.79.7)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.zw.startInterview(60);              // a re-interview: re-subscribed after the next poll
    s.failFeed.add('60:status');
    await r.poll();                       // reads it Alive and not ready; its status re-subscribe fails
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: queued for the retry');
    s.zw.emitStatus(60, 'dead');          // no status feed hears it
    skip += 2_000;
    await r.poll();                       // reads it Dead: the roster fallback counts the death
    s.failFeed.clear();
    await r.priv.retryNodeSubs();
    await waitFor(() => r.priv.statusSubbed.has(60));
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the retried status feed, before the next poll
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
  });
});

test('a death delivered by a status feed a re-arm is still releasing, after a roster poll read the node and before the rebuild made its new status feed: counted once, by the roster fallback; a pin of v0.79.6 behaviour, as each poll now re-baselines a live feed (v0.79.7)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed: its status feed is still held
    const u = s.unsubGate;
    s.ctrlGate = gate();                  // the rebuild a roster poll starts parks before its node subscribes
    const cg = s.ctrlGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    skip += 2_000;
    await r.pollOnly();                   // reads node 60 Alive, with no status feed of the feed set; starts the rebuild
    await waitFor(() => cg.arrived);
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed of the feed set');
    assert.equal(s.zw.live(60, 'status'), 1, 'precondition: the old status feed still delivers');
    s.zw.emitStatus(60, 'dead');
    skip += 2_000;
    await r.pollOnly();                   // reads it Dead: the roster fallback counts the death
    const priv = r.priv as unknown as { flapAccum: Map<number, number>; deadEvents: Array<{ nodeId: number }> };
    const counted = { flaps: priv.flapAccum.get(60) ?? 0, queued: priv.deadEvents.filter((e) => e.nodeId === 60).length };
    u.open();
    cg.open();
    await rearm;
    await waitFor(r.settled);
    await sleep(5);
    assert.deepEqual(counted, { flaps: 1, queued: 1 }, 'the death is counted once');
    bound(s, [7, 60], 'after the rebuild');
  });
});

/** The next network_status: `during` runs after the poll was sent and before
 *  Home Assistant reads the roster for its answer. */
function beforeReading(r: Run, during: () => Promise<void> | void): void {
  const send = r.ha.send.bind(r.ha);
  r.ha.send = (async (cmd: Record<string, unknown>) => {
    if (cmd.type !== 'zwave_js/network_status') return send(cmd);
    r.ha.send = send;
    await during();
    return send(cmd);
  }) as typeof r.ha.send;
}

test('a re-interviewed node whose death its old status feed delivers after a roster poll was sent, its re-subscribe\'s new status feed answering before that poll: the poll\'s reading is the new feed\'s baseline, so a revival before the next poll clears the death (v0.79.7)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.zw.startInterview(60);              // a re-interview: the same node object reads not ready
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-subscribe's release parks on node 60's statistics feed: its old status feed still delivers
    const u = s.unsubGate;
    skip += 2_000;
    await r.pollOnly();                   // reads it Alive and not ready: its own re-subscribe starts, and parks
    await waitFor(() => u.arrived);
    const made = r.calls(60, 'status');
    beforeReading(r, async () => {
      s.zw.emitStatus(60, 'dead');        // the old status feed hears it: the death is queued
      u.open();                           // the release ends; the new status feed is seeded with the death its old feed heard (v0.79.7 review; before, the reading before this poll)
      await waitFor(() => r.calls(60, 'status') > made && r.priv.statusSubbed.has(60));
    });
    skip += 2_000;
    await r.poll();                       // reads it Dead
    const priv = r.priv as unknown as { deadEvents: Array<{ nodeId: number; cleared: boolean }> };
    assert.equal(priv.deadEvents.filter((e) => e.nodeId === 60 && !e.cleared).length, 1, 'precondition: the death its old status feed delivered is queued');
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the new status feed, before the next poll
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the death is cleared by the revival');
    assert.equal(r.resubs(), 1, 'one re-subscribe, at the interview\'s start');
    s.zw.interview(60, P1);
    skip += 2_000;
    await r.poll();
    bound(s, [7, 60], 'after the interview');
  });
});

test('a death read together with the answer of the first roster poll that succeeds, its status feed made before with no reading to seed it: the death is kept as the feed\'s status, and the poll that reads the node Dead re-subscribes nothing (v0.79.7)', async () => {
  const s = baseSim();
  s.statusErr = 'HA WS error (unknown_error): network status';
  await withSim(s, async (r) => {
    await waitFor(() => r.logs.some((l) => l.startsWith('refresh failed: ')));
    const priv = r.priv as unknown as { subStatus: Map<number, number> };
    assert.equal(r.priv.statusSubbed.has(60), true, 'precondition: its status feed answered');
    assert.equal(priv.subStatus.has(60), false, 'precondition: no roster reading to seed it with');
    s.statusErr = undefined;
    readWithAnswer(r, s, 60, 'dead');
    skip += 2_000;
    await r.poll();                       // reads it Alive; the death, its feed's first event, is handled before the poll acts
    skip += 2_000;
    await r.poll();                       // reads it Dead
    assert.equal(r.resubs(), 0, 'no node re-subscribed');
    bound(s, [7, 60], 'after');
  }, { bootPolled: false });
});

test('a failed node that read not ready, whose death its status feed hears while a roster poll is out and before Home Assistant reads the roster: that poll reads it Dead, and the next one, reading its replacement by the same product Alive, judges the feed and re-subscribes it; a pin: only an event heard after this poll was sent is set against its reading (v0.79.7)', async () => {
  const s = baseSim();
  s.zw.nodes.get(60)!.ready = false;      // its interview never completed: Alive and not ready
  await withSim(s, async (r) => {
    await r.poll();                       // its status feed answered before this poll was sent
    beforeReading(r, () => { s.zw.emitStatus(60, 'dead'); });
    skip += 2_000;
    await r.poll();                       // reads it Dead: its feed delivered the death before the answer
    assert.equal(r.resubs(), 0, 'precondition: nothing re-subscribed');
    s.zw.replacePending(60);              // the same product, Alive at once and not ready, between two polls
    skip += 2_000;
    await r.poll();                       // reads it Alive: a change its feed did not deliver
    assert.equal(r.resubs(), 1, 'one re-subscribe, at the poll that reads the replacement Alive');
    bound(s, [7, 60], 'read interviewing');
  });
});

test('a replacement\'s death and revival its new status feed hears before the next poll are counted: the feed diffs against the roster\'s status from its answer, not the failed node\'s last event (v0.79.6 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.emitStatus(60, 'dead');          // node 60 failed: its feed last heard Dead
    await r.poll();
    s.zw.replacePending(60);              // replace_failed_node by the same product, Alive at once
    await r.poll();                       // reads it not ready: re-subscribed
    assert.equal(r.resubs(), 1, 'precondition: re-subscribed');
    // Before the next poll, whose reading would be the new feed's baseline.
    skip += 1_000;
    const t0 = Date.now();
    s.zw.emitStatus(60, 'dead');
    s.zw.emitStatus(60, 'alive');
    const deaths = r.zd.drainDeadEvents().filter((d) => d.nodeId === 60 && d.at >= t0);
    assert.equal(deaths.length, 1, 'the replacement\'s Dead crossing is counted');
  });
});


/* ── a status the old feed heard while a node's own re-subscribe released it ─ */

/** The death and revival books for node `n` (white-box). */
type Books = { flapAccum: Map<number, number>; deadEvents: Array<{ nodeId: number; cleared: boolean }>; subStatus: Map<number, number>; releaseHeard: Map<number, number> };
const books = (r: Run, n: number): { flaps: number; queued: number; cleared: number } => {
  const p = r.priv as unknown as Books;
  return {
    flaps: p.flapAccum.get(n) ?? 0,
    queued: p.deadEvents.filter((e) => e.nodeId === n && !e.cleared).length,
    cleared: p.deadEvents.filter((e) => e.nodeId === n && e.cleared).length,
  };
};

/** Node 60's re-interview starts; its own re-subscribe parks on the release of
 *  its statistics feed, and its old status feed, still bound, hears and counts
 *  a death. Returns the parked release. */
async function deathDuringStatsRelease(s: Sim, r: Run): Promise<Gate> {
  await r.poll();
  s.zw.startInterview(60);
  s.unsubGate = { ...gate(), feed: 'stats', n: 60 };
  const u = s.unsubGate;
  skip += 2_000;
  await r.pollOnly();                     // reads it Alive and not ready: its own re-subscribe starts
  await waitFor(() => u.arrived);
  assert.equal(r.priv.statusSubbed.has(60), true, 'precondition: in statusSubbed while its statistics feed is released');
  assert.equal(s.zw.live(60, 'status'), 1, 'precondition: its old status feed still bound');
  s.zw.emitStatus(60, 'dead');
  assert.deepEqual(books(r, 60), { flaps: 1, queued: 1, cleared: 0 }, 'precondition: the old status feed counted the death');
  return u;
}

test('a re-interviewed node whose death its old status feed counts while the re-subscribe releases its statistics feed, a roster poll reading it Dead before the new status feed answers: the death is counted once, and the revival clears it (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    u.open();
    await waitFor(() => g.arrived);
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: out of statusSubbed');
    skip += 2_000;
    await r.pollOnly();                   // reads it Dead with no status feed: the roster fallback
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.deepEqual(books(r, 60), { flaps: 1, queued: 1, cleared: 0 }, 'one death, counted once');
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the new status feed
    assert.equal(r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length, 1, 'the revival clears the death');
    assert.equal(books(r, 60).queued, 0, 'none left queued');
    bound(s, [7, 60], 'after');
  });
});

test('a re-interviewed node whose death its old status feed counts while the re-subscribe releases its statistics feed, its new status subscribe failing: the poll that reads it Dead before the retry counts nothing more (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    s.failFeed.add('60:status');
    u.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.priv.pendingNodeSubs.has(60), true, 'precondition: queued for the retry');
    skip += 2_000;
    await r.poll();                       // reads it Dead with no status feed: the roster fallback
    skip += 2_000;
    await r.poll();
    assert.deepEqual(books(r, 60), { flaps: 1, queued: 1, cleared: 0 }, 'one death, counted once');
  });
});

test('a re-interviewed node whose death its old status feed counts while the re-subscribe releases its statistics feed, no roster poll before the new feeds answer, the node revived before the next poll: the new status feed is seeded with the death, so the revival clears it; a reconnect\'s rebuild before that poll seeds from the roster again (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    u.open();
    await waitFor(() => r.settled() && r.priv.statusSubbed.has(60));
    await sleep(5);
    const seed = (r.priv as unknown as Books).subStatus.get(60);
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the new status feed
    const drained = r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length;
    assert.deepEqual({ drained, ...books(r, 60) }, { drained: 1, flaps: 2, queued: 0, cleared: 0 }, `the death and the revival counted, the death cleared (the new status feed seeded ${seed})`);
    await r.reconnect();                  // the rebuild seeds node 60's status feed from the roster: Alive
    s.zw.emitStatus(60, 'dead');          // heard by the rebuild's status feed
    assert.deepEqual(books(r, 60), { flaps: 3, queued: 1, cleared: 0 }, 'the next death is counted');
    bound(s, [7, 60], 'after');
  });
});

test('a re-interviewed node whose death its old status feed counts while the re-subscribe releases its statistics feed, revived while its new status subscribe is out, which no feed hears: the poll that reads it Alive, as before the death, counts the revival and clears the death, and the next poll counts nothing more (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    u.open();
    await waitFor(() => g.arrived);
    assert.equal(s.zw.live(60, 'status'), 0, 'precondition: no status feed bound');
    s.zw.emitStatus(60, 'alive');         // heard by no feed
    skip += 2_000;
    await r.pollOnly();                   // reads it Alive, the reading before the death
    skip += 2_000;
    await r.pollOnly();                   // reads it Alive again, the new status subscribe still out
    g.open();
    await waitFor(r.settled);
    await sleep(5);
    const drained = r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length;
    assert.deepEqual({ drained, ...books(r, 60) }, { drained: 1, flaps: 2, queued: 0, cleared: 0 }, 'the revival counted once against the death, and the death cleared');
    bound(s, [7, 60], 'after');
  });
});

test('a death read together with the answer of the roster poll that starts a node\'s own re-subscribe, the node revived before the next poll: the new status feed is seeded with the death its old feed kept over that poll\'s reading, so the revival clears it (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.zw.startInterview(60);
    readWithAnswer(r, s, 60, 'dead');
    skip += 2_000;
    await r.poll();                       // reads it Alive and not ready; the death its old feed delivers is handled before the poll acts
    assert.equal(r.resubs(), 1, 'precondition: re-subscribed');
    assert.deepEqual(books(r, 60), { flaps: 1, queued: 1, cleared: 0 }, 'precondition: the old status feed counted the death');
    const seed = (r.priv as unknown as Books).subStatus.get(60);
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the new status feed
    const drained = r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length;
    assert.deepEqual({ drained, ...books(r, 60) }, { drained: 1, flaps: 2, queued: 0, cleared: 0 }, `the death and the revival counted, the death cleared (the new status feed seeded ${seed})`);
    bound(s, [7, 60], 'after');
  });
});

test('a status the old status feed heard while a node\'s own re-subscribe released it, the node excluded before any poll read it, evicted, and another node included on the id: the new node\'s first reading is not diffed against it, as the eviction clears it (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    s.zw.removeNode(60, 'excluded');
    u.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal((r.priv as unknown as Partial<Books>).releaseHeard?.get(60), 3, 'precondition: the death is carried');
    skip += 2_000;
    await r.poll();                       // node 60 off the roster
    skip += 6_000;
    await r.poll();
    assert.ok(r.logs.some((l) => l === 'node 60 left the network — evicting its evidence + caches'), 'precondition: evicted');
    s.zw.add(60, P3);                     // another node included on the freed id: Alive
    skip += 2_000;
    await r.poll();                       // its first reading
    assert.equal(books(r, 60).flaps, 0, 'no crossing counted for the new node');
  }, { evictAfterMs: 5_000 });
});

test('a status the old status feed heard while a node\'s own re-subscribe released it, the network changing to another home id whose roster lacks the node, a node later included on the id: its first reading is not diffed against it, as the home id change clears it (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const u = await deathDuringStatsRelease(s, r);
    s.failFeed.add('60:status');
    u.open();
    await waitFor(r.settled);
    await sleep(5);
    assert.equal((r.priv as unknown as Partial<Books>).releaseHeard?.get(60), 3, 'precondition: the death is carried');
    s.zw.removeNode(60, 'replaced');
    s.zw.home = HOME + 1;                 // another network (a stick swap): node 60 not on its roster
    skip += 2_000;
    await r.poll();
    assert.ok(r.logs.some((l) => l.includes('(network changed)')), 'precondition: the home id change is seen');
    s.zw.add(60, P1);                     // a node included on the new network's id 60: Alive
    skip += 2_000;
    await r.poll();                       // its first reading
    assert.equal(books(r, 60).flaps, 0, 'no crossing counted for the new network\'s node');
  });
});

test('a node read Dead by the first roster poll, its status subscribe failed at the boot rebuild: no crossing is counted, as no earlier status is there to diff against; a pin, as the roster fallback now diffs a reading equal to the previous one too (v0.79.7 review)', async () => {
  const s = baseSim();
  s.zw.nodes.get(60)!.st = 3;             // Dead before the add-on starts
  s.failFeed.add('60:status');
  await withSim(s, async (r) => {
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed');
    skip += 2_000;
    await r.poll();
    assert.deepEqual(books(r, 60), { flaps: 0, queued: 0, cleared: 0 }, 'nothing counted');
  });
});

test('a death a status feed of the feed set delivers while a re-arm releases it, after a roster poll was sent, the rebuild\'s status feed answering before that poll: the poll\'s reading, not the older seed, is the new feed\'s baseline, by the live feed\'s send mark, so the revival it hears before the next poll is counted (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed: its status feed is still held
    const u = s.unsubGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    beforeReading(r, async () => {
      s.zw.emitStatus(60, 'dead');        // the old status feed hears it, with no status to diff against
      u.open();                           // the releases go on; the rebuild this poll started makes node 60's status feed, seeded Alive
      await waitFor(() => r.priv.statusSubbed.has(60));
    });
    skip += 2_000;
    await r.pollOnly();                   // reads it Dead
    assert.equal((r.priv as unknown as Books).subStatus.get(60), 3, 'the poll\'s reading is the new feed\'s baseline');
    await rearm;
    await waitFor(r.settled);
    await sleep(5);
    skip += 1_000;
    s.zw.emitStatus(60, 'alive');         // heard by the rebuild's status feed
    assert.equal(books(r, 60).flaps, 1, 'the revival is a crossing');
    bound(s, [7, 60], 'after the rebuild');
  });
});

test('a status a feed a re-arm is still releasing sets on a node whose rebuild status subscribe failed, read since by two roster polls, is not carried by the node\'s own re-subscribe: its new status feed is seeded from the roster, so the death it hears is counted (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
    const u = s.unsubGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    s.failFeed.add('60:status');          // the rebuild's status subscribe of node 60 fails
    skip += 2_000;
    await r.pollOnly();                   // starts the rebuild
    await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
    await sleep(5);
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed made for node 60');
    s.zw.emitStatus(60, 'dead');          // the old status feed, still released, hears it with no status to diff against
    assert.equal((r.priv as unknown as Books).subStatus.get(60), 3, 'precondition: the releasing feed set its status');
    u.open();
    await rearm;
    await waitFor(r.settled);
    await sleep(5);
    skip += 2_000;
    await r.poll();                       // reads it Dead: the roster fallback counts it
    s.zw.emitStatus(60, 'alive');         // heard by no feed
    skip += 2_000;
    await r.poll();                       // reads it Alive: the roster fallback counts it
    assert.deepEqual(books(r, 60), { flaps: 2, queued: 0, cleared: 1 }, 'precondition: both counted by the roster fallback');
    s.failFeed.delete('60:status');
    s.zw.startInterview(60);
    skip += 2_000;
    await r.poll();                       // reads it not ready: its own re-subscribe
    assert.equal(r.resubs(), 1, 'precondition: re-subscribed');
    skip += 1_000;
    s.zw.emitStatus(60, 'dead');          // heard by the new status feed
    assert.deepEqual(books(r, 60), { flaps: 3, queued: 1, cleared: 1 }, 'the death is counted');
    bound(s, [7, 60], 'after');
  });
});

test('a status a feed a re-arm is still releasing sets on a node whose rebuild status subscribe failed, read since by two roster polls, does not seed the status feed the retry makes: the roster\'s reading does, so the death it hears is counted (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
    const u = s.unsubGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    s.failFeed.add('60:status');          // the rebuild's status subscribe of node 60 fails
    skip += 2_000;
    await r.pollOnly();                   // starts the rebuild
    await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
    await sleep(5);
    s.zw.emitStatus(60, 'dead');          // the old status feed, still released, hears it with no status to diff against
    u.open();
    await rearm;
    await waitFor(r.settled);
    await sleep(5);
    skip += 2_000;
    await r.poll();                       // reads it Dead: the roster fallback counts it
    s.zw.emitStatus(60, 'alive');         // heard by no feed
    skip += 2_000;
    await r.poll();                       // reads it Alive: the roster fallback counts it
    assert.deepEqual(books(r, 60), { flaps: 2, queued: 0, cleared: 1 }, 'precondition: both counted by the roster fallback');
    assert.equal((r.priv as unknown as Books).subStatus.get(60), 3, 'precondition: the status the releasing feed set is still held');
    s.failFeed.delete('60:status');
    await r.priv.retryNodeSubs();         // the retry makes node 60's status feed
    await waitFor(() => r.priv.statusSubbed.has(60) && r.settled());
    skip += 1_000;
    s.zw.emitStatus(60, 'dead');          // heard by the retry's status feed
    assert.deepEqual(books(r, 60), { flaps: 3, queued: 1, cleared: 1 }, 'the death is counted');
    bound(s, [7, 60], 'after');
  });
});

/** Node 60 with only a statistics feed of its own (the rebuild's status
 *  subscribe failed) and a status feed of the previous feed set a re-arm is
 *  still releasing, which delivers: its re-interview starts its own
 *  re-subscribe, and while that releases the statistics feed the node dies,
 *  heard by that feed alone, which counts nothing (no status to diff against).
 *  The poll after the release reads it Dead with no status feed; the new
 *  status subscribe fails again, or answers after that poll acted. Returns
 *  the crossings and deaths counted from the death on. */
async function strayDeathDuringOwnResubscribe(s: Sim, r: Run, statusFailsAgain: boolean): Promise<{ flaps: number; queued: number }> {
  await r.poll();
  s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
  const u1 = s.unsubGate;
  r.priv.lastFeedRearmAt = 0;
  const rearm = r.priv.rearmStatsFeeds('test');
  await waitFor(() => u1.arrived);
  s.failFeed.add('60:status');            // the rebuild's status subscribe of node 60 fails
  skip += 2_000;
  await r.pollOnly();                     // starts the rebuild
  await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
  await sleep(5);
  assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed of its own');
  assert.equal(r.priv.statsSubbedNodes.has(60), true, 'precondition: the rebuild made its statistics feed');
  assert.equal(s.zw.live(60, 'status'), 1, 'precondition: the releasing status feed still delivers');
  skip += 2_000;
  await r.poll();                         // reads it Alive
  s.zw.startInterview(60);
  s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // its own re-subscribe's release of the rebuild's statistics feed parks
  const u2 = s.unsubGate;
  let g: Gate | null = null;
  if (!statusFailsAgain) {
    s.failFeed.delete('60:status');
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    g = s.subGate;
  }
  skip += 2_000;
  await r.pollOnly();                     // reads it not ready: its own re-subscribe starts
  await waitFor(() => u2.arrived);
  const pre = books(r, 60);
  s.zw.emitStatus(60, 'dead');            // heard only by the releasing status feed
  assert.deepEqual(books(r, 60), pre, 'precondition: the releasing feed counted nothing');
  u2.open();
  if (g) await waitFor(() => g!.arrived);
  else { await waitFor(() => !r.priv.nodeSubsBusy); await sleep(5); }
  assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed now');
  skip += 2_000;
  await r.pollOnly();                     // reads it Dead with no status feed: the roster fallback
  if (g) g.open();
  await sleep(10);
  const counted = { flaps: books(r, 60).flaps - pre.flaps, queued: books(r, 60).queued - pre.queued };
  u1.open();
  await rearm;
  await waitFor(() => !r.priv.nodeSubsBusy && !r.priv.rebuildInFlight);
  return counted;
}

test('a death only a status feed a re-arm is still releasing hears, while the own re-subscribe of a node with no status feed of its own releases its statistics feed, its new status subscribe failing again: the roster fallback counts it once, as the status that feed set is not carried (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    assert.deepEqual(await strayDeathDuringOwnResubscribe(s, r, true), { flaps: 1, queued: 1 }, 'the death is counted once');
  });
});

test('a death only a status feed a re-arm is still releasing hears, while the own re-subscribe of a node with no status feed of its own releases its statistics feed, its new status subscribe answering after the poll that reads it Dead acted: the roster fallback counts it once (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    assert.deepEqual(await strayDeathDuringOwnResubscribe(s, r, false), { flaps: 1, queued: 1 }, 'the death is counted once');
  });
});

test('a status a feed a re-arm is still releasing sets on a node with no status feed of its own after the 60 s retry sent its status subscribe, then a change no feed hears: the retry\'s feed, answering during the registry load of the poll that marks the node, keeps that older status, and the node\'s own re-subscribe does not carry it, as it was heard before that poll\'s send; the new status feed is seeded from the roster, so the next death is counted (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
    const u = s.unsubGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    s.failFeed.add('60:status');          // the rebuild's status subscribe of node 60 fails
    skip += 2_000;
    await r.pollOnly();                   // starts the rebuild
    await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
    await sleep(5);
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed of its own');
    // The retry sends node 60's status subscribe; its answer is held.
    s.failFeed.delete('60:status');
    s.subGate = { ...gate(), feed: 'status', dev: r.zd.deviceIdOf(60)! };
    const g = s.subGate;
    const retry = r.priv.retryNodeSubs();
    await waitFor(() => g.arrived);
    s.zw.emitStatus(60, 'dead');          // heard by the releasing feed alone, after the retry's send
    assert.equal((r.priv as unknown as Books).subStatus.get(60), 3, 'precondition: the releasing feed set its status');
    u.open();
    await rearm;
    assert.equal(s.zw.live(60, 'status'), 0, 'precondition: no status feed bound');
    s.zw.emitStatus(60, 'alive');         // heard by no feed
    // A poll that succeeds after a failed one runs a registry load; it reads
    // node 60 Alive and not ready, which marks it.
    skip += 61_000;
    s.statusErr = 'HA WS error (unknown_error): boom';
    await r.pollOnly();
    s.statusErr = undefined;
    s.zw.startInterview(60);
    s.regGate = gate();
    const rg = s.regGate;
    skip += 2_000;
    const p = r.pollOnly();
    await waitFor(() => rg.arrived);
    g.open();                             // the retry's status feed answers during that load
    await retry;
    assert.equal(r.priv.statusSubbed.has(60), true, 'precondition: node 60 has a status feed of its own');
    assert.equal((r.priv as unknown as Books).subStatus.get(60), 3, 'precondition: the retry\'s feed kept the older status');
    rg.open();
    await p;                              // node 60's own re-subscribe follows the poll
    await waitFor(r.settled);
    await sleep(5);
    assert.equal(r.resubs(), 1, 'precondition: re-subscribed');
    const pre = books(r, 60);
    skip += 1_000;
    s.zw.emitStatus(60, 'dead');          // heard by the new status feed
    assert.deepEqual({ flaps: books(r, 60).flaps - pre.flaps, queued: books(r, 60).queued - pre.queued }, { flaps: 1, queued: 1 }, 'the death is counted');
    bound(s, [7, 60], 'after');
  });
});

test('a death a status feed a re-arm is still releasing hears while the own re-subscribe of a node with a status feed of its own makes the new feeds, a roster poll reading it Dead before the new status feed answers: counted once, by the roster fallback, as the re-subscribe dropped the status the old feed held (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
    const u = s.unsubGate;
    r.priv.lastFeedRearmAt = 0;
    const rearm = r.priv.rearmStatsFeeds('test');
    await waitFor(() => u.arrived);
    skip += 2_000;
    await r.pollOnly();                   // starts the rebuild: node 60 gets feeds of its own
    await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
    await sleep(5);
    assert.equal(r.priv.statusSubbed.has(60), true, 'precondition: a status feed of its own');
    assert.equal(s.zw.live(60, 'status'), 2, 'precondition: the releasing status feed is still bound beside it');
    skip += 2_000;
    await r.poll();                       // reads it Alive
    s.zw.startInterview(60);
    s.subGate = { ...gate(), feed: 'stats', dev: r.zd.deviceIdOf(60)! };  // its own re-subscribe's new statistics subscribe is held
    const g = s.subGate;
    skip += 2_000;
    await r.pollOnly();                   // reads it not ready: its own re-subscribe starts
    await waitFor(() => g.arrived);
    assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: its old feeds released');
    assert.equal(s.zw.live(60, 'status'), 1, 'precondition: only the releasing status feed is bound');
    const pre = books(r, 60);
    s.zw.emitStatus(60, 'dead');          // heard by the releasing feed alone
    skip += 2_000;
    await r.pollOnly();                   // reads it Dead with no status feed: the roster fallback
    g.open();
    await waitFor(() => !r.priv.nodeSubsBusy);
    await sleep(5);
    assert.deepEqual({ flaps: books(r, 60).flaps - pre.flaps, queued: books(r, 60).queued - pre.queued }, { flaps: 1, queued: 1 }, 'the death is counted once');
    u.open();
    await rearm;
    await waitFor(r.settled);
  });
});

/** Node 60 with only a statistics feed of its own (the rebuild's status
 *  subscribe failed, and fails again) and a status feed of the previous feed
 *  set a re-arm is still releasing, which delivers. `before` are the status
 *  events that feed hears before the roster poll that reads the node not
 *  ready (its first counts no crossing: the node has no status), `during` the
 *  ones it hears while the node's own re-subscribe releases its statistics
 *  feed; then a poll reads the node with no status feed of its own. Returns
 *  the crossings and deaths counted from the first event on. */
async function strayChainDuringOwnResubscribe(s: Sim, r: Run, before: StatusEv[], during: StatusEv[]): Promise<{ flaps: number; queued: number }> {
  await r.poll();
  s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // the re-arm's releases park on node 60's statistics feed
  const u1 = s.unsubGate;
  r.priv.lastFeedRearmAt = 0;
  const rearm = r.priv.rearmStatsFeeds('test');
  await waitFor(() => u1.arrived);
  s.failFeed.add('60:status');            // the rebuild's status subscribe of node 60 fails
  skip += 2_000;
  await r.pollOnly();                     // starts the rebuild
  await waitFor(() => r.priv.statsSubscribed && !r.priv.rebuildInFlight && !r.priv.nodeSubsBusy);
  await sleep(5);
  assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed of its own');
  assert.equal(s.zw.live(60, 'status'), 1, 'precondition: the releasing status feed still delivers');
  skip += 2_000;
  await r.poll();                         // reads it Alive
  const pre = books(r, 60);
  for (const ev of before) s.zw.emitStatus(60, ev);
  s.zw.startInterview(60);
  s.unsubGate = { ...gate(), feed: 'stats', n: 60 };  // its own re-subscribe's release of the rebuild's statistics feed parks
  const u2 = s.unsubGate;
  skip += 2_000;
  await r.pollOnly();                     // reads it not ready: its own re-subscribe starts
  await waitFor(() => u2.arrived);
  for (const ev of during) s.zw.emitStatus(60, ev);
  u2.open();
  await waitFor(() => !r.priv.nodeSubsBusy);
  await sleep(5);
  assert.equal(r.priv.statusSubbed.has(60), false, 'precondition: no status feed now');
  skip += 2_000;
  await r.pollOnly();                     // the roster fallback
  await sleep(10);
  const b = books(r, 60);
  u1.open();
  await rearm;
  await waitFor(() => !r.priv.nodeSubsBusy && !r.priv.rebuildInFlight);
  return { flaps: b.flaps - pre.flaps, queued: b.queued - pre.queued };
}

test('a death only a status feed a re-arm is still releasing hears, read by the poll that starts the own re-subscribe of a node with no status feed of its own, and the revival that feed hears while the re-subscribe releases the statistics feed: each crossing counted once, as the status the revival set counted from the death and is carried (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    assert.deepEqual(await strayChainDuringOwnResubscribe(s, r, ['dead'], ['alive']), { flaps: 2, queued: 0 }, 'a death and a revival, nothing queued');
  });
});

test('a death, a revival and a death a status feed a re-arm is still releasing hears while the own re-subscribe of a node with no status feed of its own releases the statistics feed, the node read Dead after: one death queued, as the last status, counted from the first, is carried (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    assert.equal((await strayChainDuringOwnResubscribe(s, r, [], ['dead', 'alive', 'dead'])).queued, 1, 'one dead node, one death queued');
  });
});

test('a wake up a status feed a re-arm is still releasing hears as its first event, and a sleep after it, while the own re-subscribe of a node with no status feed of its own that read Dead releases the statistics feed: the revival counted once and the death cleared, as the sleep counts no crossing and the status is not carried (v0.79.7 review)', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    await r.poll();
    s.zw.emitStatus(60, 'dead');            // its own status feed counts the death
    skip += 2_000;
    await r.poll();                         // reads it Dead
    const pre = books(r, 60);
    await strayChainDuringOwnResubscribe(s, r, [], ['wake up', 'sleep']);
    const b = books(r, 60);
    assert.equal(b.flaps - pre.flaps, 1, 'the revival counted once');
    assert.equal(b.queued, 0, 'no death queued for the node, asleep');
  });
});
