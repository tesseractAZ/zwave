/**
 * v0.79.5 — the registry loads a device swap is seen at, against a model of
 * Home Assistant 2026.11's device registry and zwave_js registration.
 *
 * The model (Registry, Zwave below) follows helpers/device_registry.py and
 * components/zwave_js/__init__.py: async_get_or_create matches an active
 * device by any identifier and merges, else restores a deleted device of the
 * entry, else an orphaned one, with the identifiers passed in; a restored or
 * new device goes to the end of the list. async_register_node_in_dev_reg
 * strips `<home>-<node>` from a device whose hardware id differs (removing its
 * children) and gives it to an orphan holding the new hardware id; a node is
 * registered without a hardware id before its interview and with one when it
 * becomes ready (async_on_node_ready). The entry's setup registers every node,
 * then removes the devices no node has, unless the controller is unknown (the
 * home id changed under the entry). The list returns devices, then children.
 *
 * The poll loop is driven by hand (refreshMs is an hour), so each step is one
 * roster poll and what it loaded is exact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZwaveData, homeIdOfDevice } from '../src/zwave/zwaveData';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

const MIN = 60_000;
const DAY = 86_400_000;
const TICK = 30_000;
const HOME = 3586281591;
/** The home id of a controller that replaced this network's. */
const HOME_K = 4012345678;
const P1 = '634:20548:13';
const P3 = '29:12:34';
const P7 = '881:3:20';
/** Two different misreads of node 60's hardware ids. */
const PM = '0:0:0';
const PM2 = '0:1:0';

/* ── Home Assistant's device registry ──────────────────────────────────────── */
type Main = { id: string; entry: string; ids: string[] };
type Child = { id: string; entry: string; ids: string[]; parent: string };
type Del = { id: string; entry: string | null; ids: string[]; child: boolean };

class Registry {
  devices = new Map<string, Main>(); // insertion order = the list's order
  children = new Map<string, Child>();
  deleted = new Map<string, Del>();
  private seq = 0;
  newId(): string { return `dev-${++this.seq}`; }
  getEntry(ids: string[], entry: string): Main | undefined {
    for (const i of ids) for (const d of this.devices.values()) if (d.entry === entry && d.ids.includes(i)) return d;
    return undefined;
  }
  getOrCreate(entry: string, ids: string[]): Main {
    const d = this.getEntry(ids, entry);
    if (d) { for (const i of ids) if (!d.ids.includes(i)) d.ids.push(i); return d; }
    let del: Del | undefined;
    for (const i of ids) {
      const all = [...this.deleted.values()].filter((x) => !x.child && x.entry === entry && x.ids.includes(i));
      if (all.length) { del = all[all.length - 1]; break; }
    }
    del ??= [...this.deleted.values()].find((x) => !x.child && x.entry === null && x.ids.some((i) => ids.includes(i)));
    let dev: Main;
    if (del) { this.deleted.delete(del.id); dev = { id: del.id, entry, ids: [...ids] }; } else dev = { id: this.newId(), entry, ids: [...ids] };
    this.devices.set(dev.id, dev);
    return dev;
  }
  childrenOf(id: string): Child[] { return [...this.children.values()].filter((c) => c.parent === id); }
  remove(id: string): void {
    const c = this.children.get(id);
    if (c) { this.children.delete(id); this.deleted.set(id, { id, entry: c.entry, ids: c.ids, child: true }); return; }
    for (const ch of this.childrenOf(id)) this.remove(ch.id);
    const d = this.devices.get(id)!;
    this.devices.delete(id);
    this.deleted.set(id, { id, entry: d.entry, ids: d.ids, child: false });
  }
}

/* ── zwave_js registration ─────────────────────────────────────────────────── */
type ZNode = { p: string | null; ready: boolean; status: number };
class Zwave {
  nodes = new Map<number, ZNode>();
  constructor(public reg: Registry, public entry: string, public home: number) {}
  H(n: number): string { return `${this.home}-${n}`; }
  register(n: number): Main {
    const node = this.nodes.get(n)!;
    const devId = this.H(n);
    const ext = node.p == null ? null : `${this.home}-${n}-${node.p}`;
    const nodeDev = this.reg.getEntry([devId], this.entry);
    let ids: string[];
    if (ext) {
      if (nodeDev && nodeDev.ids.length === 2 && !nodeDev.ids.includes(ext)) {
        nodeDev.ids = nodeDev.ids.filter((i) => i !== devId);
        for (const c of this.reg.childrenOf(nodeDev.id)) this.reg.remove(c.id);
      }
      const hw = this.reg.getEntry([ext], this.entry);
      if (hw && hw.ids.length === 1) hw.ids.push(devId);
      ids = [devId, ext];
    } else ids = [devId];
    return this.reg.getOrCreate(this.entry, ids);
  }
  /** async_on_node_ready. */
  ready(n: number): void { this.nodes.get(n)!.ready = true; this.register(n); }
  /** Node added and interviewed at once. */
  add(n: number, p: string, status = 4): void {
    this.nodes.set(n, { p: null, ready: false, status: 0 });
    this.register(n);
    this.nodes.get(n)!.p = p;
    this.nodes.get(n)!.status = status;
    this.ready(n);
  }
  /** Node added, its interview still running (ready false, Unknown). */
  addPending(n: number): void {
    this.nodes.set(n, { p: null, ready: false, status: 0 });
    this.register(n);
  }
  interview(n: number, p: string, status = 4): void {
    const node = this.nodes.get(n)!;
    node.p = p; node.status = status;
    this.ready(n);
  }
  /** Node removed: a replace keeps the device; an exclusion removes it. */
  removeNode(n: number, reason: 'replaced' | 'excluded'): void {
    const dev = this.reg.getEntry([this.H(n)], this.entry);
    this.nodes.delete(n);
    if (reason === 'excluded' && dev) this.reg.remove(dev.id);
  }
  /** replace_failed_node with no roster poll between its steps. */
  replace(n: number, p: string): void { this.removeNode(n, 'replaced'); this.add(n, p); }
  reinterview(n: number, p: string): void { this.nodes.get(n)!.p = p; this.ready(n); }
  /** The entry's setup: every node registered, then (a known controller) the sweep. */
  setup(unknownController = false): void {
    for (const n of this.nodes.keys()) this.ready(n);
    if (unknownController) return;
    const known = new Set([...this.nodes.keys()].map((n) => this.reg.getEntry([this.H(n)], this.entry)?.id));
    for (const d of [...this.reg.devices.values()]) if (d.entry === this.entry && !known.has(d.id)) this.reg.remove(d.id);
  }
  roster(): Array<Record<string, unknown>> {
    return [...this.nodes.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({
      node_id: n, status: x.status, ready: x.ready, is_routing: true, is_secure: false, ...(n === 1 ? { is_controller_node: true } : {}),
    }));
  }
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
  /** Holds the next network_status reply; its roster is read when it opens. */
  statusGate?: Gate | null;
  /** Holds the next device list; its rows are read when the request arrives. */
  devicesGate?: Gate | null;
}

function listRows(s: Sim): Array<Record<string, unknown>> {
  return [
    ...[...s.reg.devices.values()].map((d) => ({ id: d.id, identifiers: d.ids.map((i) => ['zwave_js', i]), name: `Dev ${d.id}`, area_id: null, config_entry_id: d.entry, config_entries: [d.entry], parent_device_id: null })),
    ...[...s.reg.children.values()].map((c) => ({ id: c.id, identifiers: c.ids.map((i) => ['zwave_js', i]), name: `Child ${c.id}`, area_id: null, config_entry_id: c.entry, parent_device_id: c.parent })),
  ];
}

function fakeHa(s: Sim): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  const send = async (cmd: Record<string, unknown>): Promise<unknown> => {
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: s.zw.entry, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list': {
        const rows = listRows(s);
        const g = s.devicesGate;
        if (g) { s.devicesGate = null; g.arrived = true; await g.wait; }
        return rows;
      }
      case 'config/entity_registry/list': return [];
      case 'get_states': return [];
      case 'zwave_js/network_status': {
        const g = s.statusGate;
        if (g) { s.statusGate = null; g.arrived = true; await g.wait; }
        if (s.statusErr) throw new Error(s.statusErr);
        return { client: { server_version: 't' }, controller: { home_id: s.zw.home, own_node_id: 1, nodes: s.zw.roster() } };
      }
      default: return null;
    }
  };
  return {
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => {}, stop: () => {}, reconnect: () => {},
    ready: () => true, whenReady: () => Promise.resolve(),
    onReady: (cb: () => void) => { readyCbs.push(cb); },
    lastError: () => null,
    send,
    subscribe: async (_c: Record<string, unknown>, _on: HaEventHandler): Promise<HaSubscription> => ({ subscriptionId: 1, unsubscribe: async () => {} }),
  } as unknown as HaWsClient & { fireReady(): void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(10);
  }
}
const realNow = Date.now.bind(Date);
let skip = 0;

/** The data layer's private state these tests drive (white-box, labelled as such). */
type Priv = {
  lastOkAt: number | null; sampleEvidence: () => void; statsByNode: Map<number, unknown>;
  tick: () => Promise<void>; pollTimer: ReturnType<typeof setTimeout> | null;
  lastHomeId: number | null; registriesInFlight: Promise<void> | null; rebuildInFlight: boolean;
  rearmStatsFeeds: (why: string) => Promise<void>;
};
const STATS = { rtt: 20, rssi: -60, lwr: null, nlwr: null, commandsTX: 1, commandsRX: 1, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null };

interface Run {
  zd: ReturnType<typeof createZwaveData>; logs: string[]; priv: Priv; ha: ReturnType<typeof fakeHa>;
  /** Registry loads so far. */
  joins: () => number;
  /** One roster poll, as the poll loop runs it (success and failure paths). */
  poll: () => Promise<void>;
  /** An HA reconnect: its registry load, settled. */
  reconnect: () => Promise<void>;
  /** Node `n`'s device-change lines in the log. */
  swaps: (n: number) => number;
  /** One engine tick; whether node `n`'s node-down is raised after it. */
  tick: (n: number) => boolean;
  /** One fresh evidence sample for node `n`. */
  build: (n: number) => void;
  cleared: (n: number) => boolean;
}

/** Nodes 1 (the controller), 7 and 60 (Dead), each registered and interviewed. */
function baseSim(): Sim {
  const reg = new Registry();
  const zw = new Zwave(reg, 'E1', HOME);
  zw.add(1, '271:1:1');
  zw.add(7, P7);
  zw.add(60, P1, 3);
  return { reg, zw };
}

async function withSim(s: Sim, body: (r: Run) => Promise<void>, evictAfterMs?: number): Promise<void> {
  skip = 0;
  Date.now = () => realNow() + skip;
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-swapsim-'));
  const logs: string[] = [];
  const ha = fakeHa(s);
  const bootAt = Date.now() - 5 * DAY;
  const zd = createZwaveData({
    client: ha, refreshMs: 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * MIN,
    historyPath: null, evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), log: (m: string) => logs.push(m),
    uptimeMs: () => Date.now() - bootAt, ...(evictAfterMs != null ? { evictAfterMs } : {}),
  });
  const priv = zd as unknown as Priv;
  const joins = () => logs.filter((l) => l.startsWith('registry join:')).length;
  const settled = () => priv.registriesInFlight == null && !priv.rebuildInFlight;
  try {
    zd.start();
    ha.fireReady();
    await waitFor(() => zd.snapshot().length > 0 && priv.lastHomeId != null && joins() >= 1 && settled(), 15_000, () => logs.join(' | '));
    await body({
      zd, logs, priv, ha, joins,
      poll: async () => {
        // The loop's own next poll is an hour away; take it out so a hand-driven
        // poll is the only one, and stop() clears the one this poll schedules.
        if (priv.pollTimer) clearTimeout(priv.pollTimer);
        await priv.tick();
      },
      reconnect: async () => {
        const n = joins();
        ha.fireReady();
        await waitFor(() => joins() > n && settled(), 8000, () => logs.join(' | '));
      },
      swaps: (n: number) => logs.filter((l) => l.startsWith(`node ${n}'s device changed in Home Assistant`)).length,
      tick: (n: number) => {
        priv.lastOkAt = Date.now();
        priv.sampleEvidence();
        const up = zd.symptoms().some((x) => x.kind === 'node-down' && x.nodeId === n);
        skip += TICK;
        return up;
      },
      build: (n: number) => {
        priv.statsByNode.set(n, { ...STATS, commandsTX: Math.floor(Math.random() * 1e6) });
        priv.lastOkAt = Date.now();
        priv.sampleEvidence();
      },
      cleared: (n: number) => zd.events().some((e) => e.text === 'node-down cleared' && e.nodeId === n),
    });
  } finally {
    zd.stop();
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
  }
}

function raise(r: Run, n: number): void {
  r.priv.statsByNode.set(n, { ...STATS });
  let up = false;
  for (let i = 0; i <= 20 && !up; i++) up = r.tick(n);
  assert.equal(up, true, `precondition: node-down raised for node ${n}`);
}

const alive = (r: Run, n: number) => r.zd.snapshot().some((x) => x.nodeId === n && x.status === 4);
/** Statistics rebuilds finished so far (a re-arm's ends with one). */
const rebuilt = (r: Run) => r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length;

/* ── T1: a node's ready false→true asks for a load, run in the same poll ───── */

test('registry loads (v0.79.5): a replace by another product while everything runs is acted on in the poll that reads the replacement ready — before the roster is published, so the failed device\'s raised node-down is not logged as cleared; what the replacement builds afterwards is kept', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    raise(r, 60);
    // replace_failed_node by another product: the new node is added, then interviewed.
    s.zw.removeNode(60, 'replaced');
    s.zw.addPending(60);
    await r.poll();
    assert.equal(r.zd.snapshot().find((x) => x.nodeId === 60)?.ready, false, 'precondition: read while interviewing');
    s.zw.interview(60, P3, 4);
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'the ready change asked for one load, run in that poll');
    assert.equal(r.swaps(60), 1, 'the swap is acted on in that poll');
    assert.ok(alive(r, 60), 'the roster published in that poll reads the replacement Alive');
    assert.equal(r.zd.snapshot().find((x) => x.nodeId === 60)!.deviceId, r.zd.deviceIdOf(60), 'built from the load: the new device');
    assert.equal(r.tick(60), false, 'the failed device\'s node-down is not carried onto the replacement');
    assert.equal(r.cleared(60), false, 'nor logged as cleared');
    for (let i = 0; i < 4; i++) r.build(60);
    const built = r.zd.evidence(60).length;
    assert.ok(built > 0, 'precondition: the replacement has evidence of its own');
    await r.reconnect();
    assert.equal(r.swaps(60), 1, 'no second swap at the next load');
    assert.ok(r.zd.evidence(60).length >= built, 'the replacement\'s own evidence is kept');
  });
});

test('registry loads (v0.79.5): every node reading ready again in one poll (a driver restart) is one load; a node whose ready flaps costs one load a minute at most — a change inside the spacing waits for the first poll past it', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    for (const x of s.zw.nodes.values()) { x.ready = false; x.status = 0; }
    await r.poll();
    for (const x of s.zw.nodes.values()) { x.ready = true; x.status = 4; }
    let n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'every node ready again: one load');
    // Node 7 flaps inside the minute.
    n = r.joins();
    for (let i = 0; i < 3; i++) {
      s.zw.nodes.get(7)!.ready = false;
      await r.poll();
      s.zw.nodes.get(7)!.ready = true;
      await r.poll();
    }
    assert.equal(r.joins(), n, 'held: no load inside the spacing');
    skip += 61_000;
    await r.poll();
    assert.equal(r.joins(), n + 1, 'the held change is loaded at the first poll past the spacing');
    skip += 61_000;
    await r.poll();
    assert.equal(r.joins(), n + 1, 'and only once');
  });
});

test('registry loads (v0.79.5): a node excluded and another product included on its id inside the eviction dwell, already interviewed when the roster next reads it, is a swap in that poll — an id off the roster reads not ready', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    raise(r, 60);
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    assert.ok(!r.zd.snapshot().some((x) => x.nodeId === 60), 'precondition: off the roster');
    // Included and interviewed between two polls: HA restores the deleted device id with P3's hardware id.
    s.zw.add(60, P3, 4);
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1);
    assert.equal(r.swaps(60), 1, 'the restored device with other hardware is a swap, in this poll');
    assert.equal(r.tick(60), false);
    assert.equal(r.cleared(60), false);
  });
});

test('registry loads (v0.79.5): a replace made while Home Assistant was restarting, answered with failed polls until the integration was set up, is a swap in the first poll that succeeds — not left to the next reconnect', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    raise(r, 60);
    // HA stops; the driver replaces node 60 by another product meanwhile.
    s.statusErr = 'HA WS error (unknown_command): Unknown command.';
    s.zw.nodes.set(60, { p: P3, ready: true, status: 4 });
    await r.reconnect(); // HA back: the reconnect's load reads the registry as stored
    assert.equal(r.swaps(60), 0, 'precondition: the stored registry shows no swap');
    await r.poll();      // the integration not set up yet
    s.zw.setup();        // setup: node 60 re-registered with P3's hardware id, the orphan swept
    s.statusErr = undefined;
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'the poll that succeeds after failed ones loads the registry');
    assert.equal(r.swaps(60), 1);
    assert.equal(r.tick(60), false);
    assert.equal(r.cleared(60), false, 'the failed device\'s node-down is not logged as cleared');
    skip += 61_000;
    await r.poll();
    assert.equal(r.joins(), n + 1, 'no further load once one was sent after the failures');
  });
});

test('registry loads (v0.79.5): a zwave_js entry reload a poll saw (not_loaded) is loaded by the poll that succeeds after it; the re-arm that follows loads nothing more', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    raise(r, 60);
    s.zw.nodes.set(60, { p: P3, ready: true, status: 4 });
    s.statusErr = 'HA WS error (not_loaded): Config entry E1 not loaded';
    await r.poll();
    s.zw.setup();
    s.statusErr = undefined;
    const n = r.joins();
    const k = rebuilt(r);
    await r.poll();
    assert.equal(r.swaps(60), 1, 'the swap is acted on in that poll');
    assert.equal(r.joins(), n + 1);
    await waitFor(() => r.logs.some((l) => l.includes('re-subscribing (zwave_js config entry reloaded)')), 8000, () => r.logs.join(' | '));
    await waitFor(() => rebuilt(r) > k, 8000, () => r.logs.join(' | '));
    assert.equal(r.joins(), n + 1, 'the re-arm for a reload a poll saw asks for no second load');
    assert.equal(r.cleared(60), false);
  });
});

test('registry loads (v0.79.5): a re-arm for a dead feed, with no reload seen, reloads the registry — a reload quicker than a poll re-registers nodes too', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    const n = r.joins();
    const k = rebuilt(r);
    await r.priv.rearmStatsFeeds('no statistics from any node for 10m');
    assert.ok(rebuilt(r) > k, 'precondition: the re-arm ran');
    assert.equal(r.joins(), n + 1);
  });
});

test('registry loads (v0.79.5): a fetch already out when the roster asks does not serve the ask — the poll fetches again and acts on the swap', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    raise(r, 60);
    s.zw.removeNode(60, 'replaced');
    s.zw.addPending(60);
    await r.poll(); // read while interviewing
    // The next poll's roster reply is held; a reconnect's fetch goes out meanwhile, before the interview ends.
    const sg = gate();
    s.statusGate = sg;
    const p = r.poll();
    await waitFor(() => sg.arrived);
    const dg = gate();
    s.devicesGate = dg;
    r.ha.fireReady();
    await waitFor(() => dg.arrived);
    s.zw.interview(60, P3, 4); // ready, registered with P3's hardware id
    sg.open();
    await sleep(20); // the poll reads the ready change and joins the fetch that is out
    dg.open();
    await p;
    assert.equal(r.swaps(60), 1, 'the swap is acted on in that poll');
    assert.equal(r.cleared(60), false);
  });
});

/* ── T2: a roster node with no record asks for one load ────────────────────── */

test('registry loads (v0.79.5): a node first included since the last load asks for one, so a later replace by another product is a swap', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.add(70, P1);
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'the unrecorded node asked for a load');
    r.build(70); r.build(70);
    assert.ok(r.zd.evidence(70).length > 0, 'precondition');
    s.zw.replace(70, P3); // no poll between its steps
    await r.reconnect();
    assert.equal(r.swaps(70), 1);
    assert.equal(r.zd.evidence(70).length, 0, 'the failed device\'s evidence goes');
  });
});

test('registry loads (v0.79.5): an evicted node whose eviction a reconnect consumed while it was away asks for a load when it is back, so a later replace is a swap', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    skip += 6 * MIN;
    await r.poll();
    assert.ok(r.logs.some((l) => l.startsWith('node 60 left the network')), 'precondition: evicted');
    await r.reconnect(); // consumes the eviction while node 60 is away
    s.zw.add(60, P1);    // re-included, on the device id HA restores
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'back with no record: one load');
    assert.equal(r.swaps(60), 0, 'the return is no swap');
    r.build(60); r.build(60);
    s.zw.replace(60, P3);
    await r.reconnect();
    assert.equal(r.swaps(60), 1);
    assert.equal(r.zd.evidence(60).length, 0);
  });
});

test('registry loads (v0.79.5): an evicted id back on the roster before any load asks for one, in the poll that reads it back', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.removeNode(60, 'excluded');
    await r.poll();
    skip += 6 * MIN;
    await r.poll();
    assert.ok(r.logs.some((l) => l.startsWith('node 60 left the network')), 'precondition: evicted');
    s.zw.add(60, P1);
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1);
    assert.equal(r.swaps(60), 0);
  });
});

test('registry loads (v0.79.5): a roster node Home Assistant never registers asks once while it stays on the roster, and once more after it leaves and comes back', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.nodes.set(80, { p: null, ready: true, status: 4 }); // on the roster, no device
    let n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'one ask');
    for (let i = 0; i < 3; i++) await r.poll();
    assert.equal(r.joins(), n + 1, 'not one per poll');
    s.zw.nodes.delete(80);
    await r.poll();
    s.zw.nodes.set(80, { p: null, ready: false, status: 0 }); // back, not ready: no ready change to ask for
    n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'back on the roster: asks again');
  });
});

/* ── T3: home-tagged records, and the bound network's devices only ─────────── */

/** A controller with another home id behind the same entry: the old network's
 *  devices stay listed (an unknown controller skips the setup sweep), node 1 re-registered. */
function newController(s: Sim): void {
  s.zw.home = HOME_K;
  s.zw.nodes.clear();
  s.zw.nodes.set(1, { p: '271:1:1', ready: true, status: 4 });
  s.zw.setup(true);
}

test('registry loads (v0.79.5): a home-id change under the same entry, the old network\'s devices kept — they hold no slot, and a node the new network includes on a reused id is no swap at the next load', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    newController(s);
    const n = r.joins();
    await r.poll(); // the home-id change
    assert.ok(r.logs.some((l) => l.startsWith(`controller home_id ${HOME} → ${HOME_K}`)), r.logs.join('\n'));
    assert.equal(r.joins(), n, 'the poll that reads the new home id loads nothing itself: the home-id branch asks for the load');
    await r.poll(); // the load it asked for
    assert.equal(r.joins(), n + 1);
    assert.equal(r.zd.deviceIdOf(60), null, 'the old network\'s node 60 holds no slot');
    assert.equal(r.zd.deviceIdOf(7), null);
    s.zw.add(7, P7);
    await r.poll();
    const dev7 = r.zd.deviceIdOf(7);
    assert.ok(dev7 != null && dev7 === s.zw.reg.getEntry([`${HOME_K}-7`], 'E1')?.id, `node 7 is on the new network's device (${dev7})`);
    r.build(7); r.build(7);
    const ev = r.zd.evidence(7).length;
    await r.reconnect();
    assert.equal(r.swaps(7), 0);
    assert.ok(r.zd.evidence(7).length >= ev, 'its evidence is kept');
  });
});

test('registry loads (v0.79.5): after the migrate_unique_id repair sweeps the old network\'s devices, the new network including node 60 is no swap', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    newController(s);
    await r.poll();
    await r.poll();
    s.zw.setup(false); // the repair fixed: the entry reloads and sweeps
    await r.reconnect();
    s.zw.add(7, P7); s.zw.add(60, P1);
    await r.poll();
    r.build(60); r.build(60);
    const ev = r.zd.evidence(60).length;
    await r.reconnect();
    assert.equal(r.swaps(60), 0);
    assert.ok(r.zd.evidence(60).length >= ev);
  });
});

test('registry loads (v0.79.5): a Home Assistant restart onto a new controller, its load landing before the roster shows the new home id, logs no swap', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    newController(s);
    await r.reconnect(); // the reconnect's load: the home id bound is still the old one
    await r.poll();      // the home-id change
    await r.poll();
    assert.equal(r.swaps(1) + r.swaps(7) + r.swaps(60), 0, r.logs.join('\n'));
  });
});

test('registry loads (v0.79.5): an add-on started on a registry that holds an older network\'s devices loads again once the home id is bound — the older network\'s node 60 then holds no slot; the new network\'s node 60 is no swap, is recorded at once, and its own replacement is one', async () => {
  const s = baseSim();
  newController(s);
  await withSim(s, async (r) => {
    assert.equal(r.zd.deviceIdOf(60), 'dev-3', 'precondition: the first load, before the home id was known, admitted the older network\'s device');
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n + 1, 'the poll after the bind loads again');
    assert.equal(r.zd.deviceIdOf(60), null, 'with the home id known, the older network\'s node 60 holds no slot');
    s.zw.add(60, P1); // the new network includes node 60
    await r.poll();
    assert.equal(r.swaps(60), 0, 'the older network\'s record on the id is not this device\'s');
    r.build(60); r.build(60);
    s.zw.replace(60, P3); // no poll between its steps
    await r.reconnect();
    assert.equal(r.swaps(60), 1, 'recorded when it joined, so its own replacement is a swap');
    assert.equal(r.zd.evidence(60).length, 0);
  });
});

test('registry loads (v0.79.5): with the bound home id\'s devices not listed at all, every device is admitted, as before the home id is known', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    // Every device re-spelled under another home id while the roster still reports HOME.
    for (const d of s.reg.devices.values()) d.ids = d.ids.map((i) => i.replace(String(HOME), String(HOME_K)));
    await r.reconnect();
    assert.equal(r.zd.deviceIdOf(60), 'dev-3', 'admitted: no device of the bound home id is listed');
    assert.equal(r.swaps(60), 0, 'another home id\'s device is not compared with the record');
  });
});

test('registry loads (v0.79.5): another zwave_js entry\'s devices listed after this network\'s at a run\'s first load, before the home id is known, take no slot — and that load asks for no second one', async () => {
  const s = baseSim();
  // A second network on its own entry, registered after this one's devices.
  const other = new Zwave(s.reg, 'E2', HOME_K);
  other.add(1, '271:1:1');
  other.add(60, P7);
  await withSim(s, async (r) => {
    assert.equal(r.zd.deviceIdOf(60), 'dev-3', 'this network\'s node 60 holds the slot at the first load');
    assert.equal(r.zd.deviceIdOf(1), 'dev-1');
    const n = r.joins();
    await r.poll();
    assert.equal(r.joins(), n, 'no other home id was admitted: nothing to load again');
  });
});

test('homeIdOfDevice (v0.79.5): the home id of the identifier the node id is read from; none for a provisioning entry, a node id past the ceiling or another domain', () => {
  const dev = (...ids: string[]) => ({ id: 'd', identifiers: ids.map((x) => ['zwave_js', x]) });
  assert.equal(homeIdOfDevice(dev(`${HOME}-60`)), String(HOME));
  assert.equal(homeIdOfDevice(dev(`${HOME}-60-634:20548:13`)), String(HOME));
  assert.equal(homeIdOfDevice(dev(`${HOME}-60-2`)), String(HOME));
  assert.equal(homeIdOfDevice(dev('provision_12345-67890')), null);
  assert.equal(homeIdOfDevice(dev(`${HOME}-4001`)), null, 'past the Long Range ceiling: no node, so no home id');
  assert.equal(homeIdOfDevice({ id: 'd', identifiers: [['other', `${HOME}-60`]] }), null);
});

/* ── A misread interview, twice in one run (the stated limit) ──────────────── */

test('registry loads (v0.79.5): two different misreads in one run cost two resets — once for each misread value; the same misread again costs none', async () => {
  const s = baseSim();
  await withSim(s, async (r) => {
    s.zw.reinterview(60, PM);
    await r.reconnect();
    s.zw.reinterview(60, P1);
    await r.reconnect();
    assert.equal(r.swaps(60), 1, 'the first misread');
    s.zw.reinterview(60, PM2);
    await r.reconnect();
    s.zw.reinterview(60, P1);
    await r.reconnect();
    assert.equal(r.swaps(60), 2, 'another misread value: another reset');
    s.zw.reinterview(60, PM);
    await r.reconnect();
    s.zw.reinterview(60, P1);
    await r.reconnect();
    assert.equal(r.swaps(60), 2, 'a value already seen: none');
  });
});
