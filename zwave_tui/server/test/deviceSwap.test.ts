/**
 * v0.79.5 — another device on a node id that never left the roster.
 *
 * replace_failed_node swaps the node in place: the driver removes the failed
 * node and adds the new one under the same id at once, so the id stays on the
 * roster and the departed-node eviction (5 minutes off the roster) never runs.
 * A replacement Home Assistant registers as another device shows up as a new
 * device_id at the next registry load. These tests pin what that load drops,
 * and what it must not take for a swap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZwaveData, deviceInEntry, hardwareIdOfDevice, type ZwaveDataOptions } from '../src/zwave/zwaveData';
import { buildEntityRows } from '../src/telnet/actionsCatalog';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

const MIN = 60_000;
const DAY = 86_400_000;
const TICK = 30_000;
const ENTRY = 'entry-1';
const HOME = 3586281591;
/** Another network's home id. */
const HOME_B = 4012345678;
/** Hardware ids of three products on node 60, as HA's get_device_id_ext builds them. */
const P1 = `${HOME}-60-634:20548:13`;
const P2 = `${HOME}-60-881:3:20`;
const P3 = `${HOME}-60-29:12:34`;

/** `ids`: the device's zwave_js identifiers; default the node's own `<home>-<node>`.
 *  `entry`: its config entry, listed as `entryShape` says (none listed when
 *  absent). `parent`: a child device's parent device. */
type Dev = { id: string; node: number; ids?: string[]; entry?: string; parent?: string };
interface World {
  roster: Array<Record<string, unknown>>; devices: Dev[]; entities?: Array<Record<string, unknown>>;
  /** get_states: the entities' live states. */
  states?: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  /** How the registry lists a device's config entry: 'id' as HA 2026.9+
   *  (`config_entry_id`, plus `config_entries` on a main device; the default),
   *  'list' as HA before 2026.8 (`config_entries` only). */
  entryShape?: 'id' | 'list';
  /** config_entries/get: the zwave_js entries; default this network's ENTRY, loaded. */
  entriesList?: Array<Record<string, unknown>>;
  /** network_status: the controller's home id; default HOME. */
  home?: number;
  /** network_status fails while set, as when Home Assistant is not answering. */
  statusFail?: boolean;
}

/** A device as Home Assistant's config/device_registry/list sends it. */
function devRow(w: World, d: Dev): Record<string, unknown> {
  const entry = d.entry == null ? {}
    : w.entryShape === 'list' ? { config_entries: [d.entry] }
    : { config_entry_id: d.entry, ...(d.parent == null ? { config_entries: [d.entry] } : {}) };
  return {
    id: d.id, identifiers: (d.ids ?? [`${HOME}-${d.node}`]).map((s) => ['zwave_js', s]), name: `Dev ${d.id}`, area_id: null,
    ...(d.parent != null ? { parent_device_id: d.parent } : {}), ...entry,
  };
}

function fakeHa(w: World): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  const result = (cmd: Record<string, unknown>): unknown => {
    switch (cmd.type) {
      case 'config_entries/get': return w.entriesList ?? [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list': return w.devices.map((d) => devRow(w, d));
      case 'config/entity_registry/list': return w.entities ?? [];
      case 'get_states': return w.states ?? [];
      case 'zwave_js/network_status':
        if (w.statusFail) throw new Error('HA WS not ready (auth timeout)');
        return { client: { server_version: 't' }, controller: { home_id: w.home ?? HOME, own_node_id: 1, nodes: w.roster } };
      default: return null;
    }
  };
  return {
    fireReady: () => { for (const cb of [...readyCbs]) cb(); },
    start: () => {}, stop: () => {}, reconnect: () => {},
    ready: () => true, whenReady: () => Promise.resolve(),
    onReady: (cb: () => void) => { readyCbs.push(cb); },
    lastError: () => null,
    send: async (cmd: Record<string, unknown>) => result(cmd),
    subscribe: async (_c: Record<string, unknown>, _on: HaEventHandler): Promise<HaSubscription> => ({ subscriptionId: 1, unsubscribe: async () => {} }),
  } as unknown as HaWsClient & { fireReady(): void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `why`: what the failure message carries besides the timeout. */
async function waitFor(cond: () => boolean, ms = 8000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(20);
  }
}

const realNow = Date.now.bind(Date);
let skip = 0;

/** Node 60 Dead on a host booted 5 days ago: a plain 5-minute node-down. */
const world = (devices: Dev[] = [{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60a', node: 60 }]): World => ({
  roster: [
    { node_id: 1, status: 4, ready: true, is_routing: true, is_controller_node: true },
    { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false },
    { node_id: 60, status: 3, ready: true, is_routing: true, is_secure: false },
  ],
  devices,
});

/** The data layer's private state a swap reaches (white-box, labelled as such). */
type Priv = {
  lastOkAt: number | null; sampleEvidence: () => void; baselines: { resetNode: (id: number) => void };
  statsByNode: Map<number, unknown>; prevSampleSig: Map<number, unknown>; histByNode: Map<number, unknown>;
  histLongByNode: Map<number, unknown>; coarseAccum: Map<number, unknown>; batteryByNode: Map<number, number>;
  firmwareByNode: Map<number, unknown>; sleeperLatch: Map<number, unknown>; dupDrops: Map<number, number[]>;
  trial: unknown; outcomes: { openEpisodes: () => unknown[]; abandon: (n: number, k: string) => void };
};
const STATS = { rtt: 20, rssi: -60, lwr: null, nlwr: null, commandsTX: 1, commandsRX: 1, commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null };

async function withRun(w: World, body: (r: {
  tick: () => boolean; reload: () => Promise<void>; logs: string[]; events: () => string[]; resetCalls: number[];
  /** Registry loads so far. */
  joins: () => number;
  zd: ReturnType<typeof createZwaveData>; priv: Priv;
}) => Promise<void>, extra: Partial<ZwaveDataOptions> = {}): Promise<void> {
  skip = 0;
  Date.now = () => realNow() + skip;
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-swap-'));
  const logs: string[] = [];
  const ha = fakeHa(w);
  const bootAt = Date.now() - 5 * DAY;
  const zd = createZwaveData({
    client: ha, entryId: ENTRY, refreshMs: 100, routePollMs: 60_000, evidenceSampleMs: 30 * MIN,
    historyPath: null, evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), log: (m: string) => logs.push(m),
    uptimeMs: () => Date.now() - bootAt, ...extra,
  });
  try {
    zd.start();
    ha.fireReady();
    // The first roster, under a loaded suite: room, and what the run saw if it never comes.
    await waitFor(() => zd.snapshot().some((n) => n.nodeId === 60), 15_000,
      () => `driver link ${zd.driverWsState()}, last error ${zd.lastError() ?? 'none'}; log: ${logs.join(' | ')}`);
    const priv = zd as unknown as Priv;
    const resetCalls: number[] = [];
    const orig = priv.baselines.resetNode.bind(priv.baselines);
    priv.baselines.resetNode = (id: number) => { resetCalls.push(id); orig(id); };
    const joins = () => logs.filter((l) => l.startsWith('registry join:')).length;
    await body({
      zd, logs, resetCalls, priv, joins,
      tick: () => {
        priv.lastOkAt = Date.now();
        priv.sampleEvidence();
        const up = zd.symptoms().some((s) => s.kind === 'node-down' && s.nodeId === 60);
        skip += TICK;
        return up;
      },
      // An HA reconnect: the registry join is fetched again.
      reload: async () => { const n = joins(); ha.fireReady(); await waitFor(() => joins() > n); },
      events: () => zd.events().map((e) => e.text),
    });
  } finally {
    zd.stop();
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
  }
}

function raise(r: { tick: () => boolean }): void {
  let up = false;
  for (let i = 0; i <= 20 && !up; i++) up = r.tick();
  assert.equal(up, true, 'precondition: node-down raised for node 60');
}

/** The first registry load has landed. */
const joined = (r: { logs: string[] }) => waitFor(() => r.logs.some((l) => l.startsWith('registry join:')));

test('device swap (v0.79.5): another device on an id that stayed on the roster drops the old device\'s raised node-down, baselines and evidence — the new one is not raised while it is interviewed', async () => {
  const w = world();
  await withRun(w, async (r) => {
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    assert.ok(r.zd.evidence(60).length > 0, 'precondition: the old device has evidence');
    // replace_failed_node: the id never leaves the roster; HA registers another device on it.
    w.devices = w.devices.map((d) => (d.node === 60 ? { id: 'dev-60b', node: 60 } : d));
    w.roster = w.roster.map((n) => (n.node_id === 60 ? { ...n, status: 0, ready: false } : n));
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    assert.equal(r.tick(), true, 'before the load: still raised, held through Unknown (the documented limit)');
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the old device\'s baselines are forgotten');
    assert.equal(r.zd.evidence(60).length, 0, 'its evidence is evicted');
    assert.equal(r.tick(), false, 'the new device is not raised while it reads Unknown');
    assert.equal(r.zd.evidence(60).length, 0, 'and its frozen counters are not sampled into the new ring');
    assert.ok(r.events().some((t) => t.includes("node 60's device changed in Home Assistant — its baselines + evidence discarded")), 'on the record');
    assert.ok(r.logs.some((l) => l.startsWith("node 60's device changed in Home Assistant (a replacement, or a misread hardware id)")), r.logs.join('\n'));
    assert.ok(!r.events().some((t) => t === 'node-down cleared'), 'the old device did not recover: no clearance');
  });
});

test('device swap (v0.79.5): a reload with the same devices drops nothing — a raised node-down stays raised', async () => {
  const w = world();
  await withRun(w, async (r) => {
    raise(r);
    w.roster = w.roster.map((n) => (n.node_id === 60 ? { ...n, status: 0 } : n));
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.deepEqual(r.resetCalls, []);
    assert.equal(r.tick(), true, 'held through Unknown, as before');
  });
});

test('device swap (v0.79.5): a device that first appears at a reload, or drops out of the list, is no swap', async () => {
  // null → B: node 60 had no device at the first load.
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }]);
  await withRun(w, async (r) => {
    raise(r);
    w.devices = [...w.devices, { id: 'dev-60b', node: 60 }];
    w.roster = w.roster.map((n) => (n.node_id === 60 ? { ...n, status: 0 } : n));
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.equal(r.tick(), true, 'null → B keeps the raised node-down');
    // B's interview gives it a hardware id: the same device, so no swap.
    w.devices = w.devices.map((d) => (d.node === 60 ? { ...d, ids: [`${HOME}-60`, P1] } : d));
    await r.reload();
    assert.equal(r.tick(), true, 'a hardware id appearing on the device keeps it too');
    // A → null: the device drops out of the list.
    w.devices = w.devices.filter((d) => d.node !== 60);
    await r.reload();
    assert.equal(r.tick(), true, 'A → null keeps it too');
    assert.deepEqual(r.resetCalls, []);
  });
});

test('device swap (v0.79.5): most of the mesh changing device at once is a re-created registry — nothing is dropped; two of three is two replacements', async () => {
  const w = world();
  await withRun(w, async (r) => {
    raise(r);
    w.devices = w.devices.map((d) => ({ id: `${d.id}-re`, node: d.node }));
    await r.reload();
    assert.deepEqual(r.resetCalls, [], 'all 3 of 3 changed: not replacements');
    assert.ok(r.logs.some((l) => l.includes('3 of 3 nodes changed device at once')));
    assert.equal(r.tick(), true, 'still raised');
    // Two of three: replacements, even on a small mesh.
    w.devices = w.devices.map((d) => (d.node === 1 ? d : { id: `${d.id}-x`, node: d.node }));
    await r.reload();
    assert.deepEqual(r.resetCalls.sort((a, b) => a - b), [7, 60]);
    assert.equal(r.tick(), false);
  });
});

test('device swap (v0.79.5): a reload that lists the same devices in another order, hardware ids and all, drops nothing', async () => {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }]);
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    await r.reload();
    w.devices = [w.devices[2]!, w.devices[0]!, w.devices[1]!];
    await r.reload();
    assert.deepEqual(r.resetCalls, []);
    assert.equal(r.tick(), true, 'still raised');
  });
});

test('device swap (v0.79.5): the re-created-registry guard counts every changed device, one carrying a known hardware id included — the nodes with none are not reset one by one, and the guard is logged', async () => {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }]);
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    // Every device id new; node 60 keeps its hardware id, nodes 1 and 7 have none.
    w.devices = [{ id: 'n-1', node: 1 }, { id: 'n-7', node: 7 }, { id: 'n-60', node: 60, ids: [`${HOME}-60`, P1] }];
    await r.reload();
    assert.deepEqual(r.resetCalls, [], 'nothing dropped');
    assert.ok(r.logs.some((l) => l.includes('3 of 3 nodes changed device at once')), r.logs.join('\n'));
    assert.equal(r.tick(), true, 'still raised');
  });
});

test('device swap (v0.79.5): an id the departed branch evicted is no swap at the next load — another product included on it, on the device id Home Assistant restores, keeps what it built since; a later swap is still one', async () => {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60a', node: 60, ids: [`${HOME}-60`, P1] }]);
  await withRun(w, async (r) => {
    await joined(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    // Excluded: HA deletes its device.
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.node !== 60);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    // Another product included on the id: HA restores dev-60a with the new hardware id. Dead, raised.
    w.devices = [...w.devices, { id: 'dev-60a', node: 60, ids: [`${HOME}-60`, P2] }];
    w.roster = [...w.roster, { ...gone }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60));
    raise(r);
    const before = r.resetCalls.length;
    await r.reload();
    assert.equal(r.resetCalls.length, before, 'not forgotten twice');
    assert.equal(r.tick(), true, 'the new device\'s node-down stays raised');
    // The mark is spent at that load: a later replace by another product is a swap.
    const others = w.devices.filter((d) => d.node !== 60);
    w.devices = [...others, { id: 'dev-60a', node: 60, ids: [P2] }, { id: 'dev-60c', node: 60, ids: [`${HOME}-60`, P3] }];
    await r.reload();
    assert.equal(r.resetCalls.length, before + 1);
    assert.equal(r.tick(), false, 'dropped, then a fresh 5-minute dwell');
  }, { evictAfterMs: 1 });
});

test('device swap (v0.79.5): the old device\'s readings go too — sparklines, coarse sums, battery, firmware, the sleeper latch, duplicate bursts, the sample signature; the other nodes\' stay', async () => {
  const w = world();
  await withRun(w, async (r) => {
    const maps = ['prevSampleSig', 'histByNode', 'histLongByNode', 'coarseAccum', 'batteryByNode', 'firmwareByNode', 'sleeperLatch', 'dupDrops'] as const;
    for (const m of maps) for (const id of [7, 60]) (r.priv[m] as Map<number, unknown>).set(id, m === 'batteryByNode' ? 50 : m === 'dupDrops' ? [1] : {});
    w.devices = w.devices.map((d) => (d.node === 60 ? { id: 'dev-60b', node: 60 } : d));
    await r.reload();
    for (const m of maps) {
      assert.equal((r.priv[m] as Map<number, unknown>).has(60), false, `${m}: node 60's is dropped`);
      assert.equal((r.priv[m] as Map<number, unknown>).has(7), true, `${m}: node 7's is kept`);
    }
  });
});

test('device swap (v0.79.5): the old device\'s open episodes are abandoned and the refresh trial\'s open decision dropped, counted on the record', async () => {
  const w = world();
  await withRun(w, async (r) => {
    const abandoned: Array<[number, string]> = [];
    const dropped: unknown[][] = [];
    const ocOpen = r.priv.outcomes.openEpisodes.bind(r.priv.outcomes);
    const ocAbandon = r.priv.outcomes.abandon.bind(r.priv.outcomes);
    r.priv.outcomes.openEpisodes = () => [
      { key: '60:rtt-degraded', nodeId: 60, kind: 'rtt-degraded' },
      { key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' },
    ];
    r.priv.outcomes.abandon = (n: number, k: string) => { abandoned.push([n, k]); };
    r.priv.trial = new Proxy({}, { get: (_t, k) => (k === 'dropOpen' ? (...a: unknown[]) => { dropped.push(a); } : () => undefined) });
    try {
      w.devices = w.devices.map((d) => (d.node === 60 ? { id: 'dev-60b', node: 60 } : d));
      await r.reload();
    } finally {
      r.priv.outcomes.openEpisodes = ocOpen;
      r.priv.outcomes.abandon = ocAbandon;
      r.priv.trial = null;
    }
    assert.deepEqual(abandoned, [[60, 'rtt-degraded']], 'only node 60\'s');
    assert.deepEqual(dropped.map((a) => a.slice(0, 2)), [[60, 'its device changed in Home Assistant']]);
    assert.ok(r.events().includes("1 in-flight episode + node 60's baselines discarded — its device changed in Home Assistant"), r.events().join(' | '));
  });
});

/* ── The node's own device holds its slot (v0.79.5) ───────────────────────── */

/** Node 60's own device `dev-60`, identified `<home>-60`. */
const own = (): Dev[] => [{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60 }];

test('device swap (v0.79.5): an endpoint child device filed under the node is no swap — appended at a reload, then pruned at a later one, the node keeps its own device and its raised node-down', async () => {
  const w = world(own());
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    // Home Assistant files an endpoint child device, `<home>-<node>-<endpoint>`, after its parent.
    w.devices = [...w.devices, { id: 'dev-60-ep2', node: 60, ids: [`${HOME}-60-2`] }];
    await r.reload();
    assert.deepEqual(r.resetCalls, [], 'a child appearing is no replacement');
    assert.equal(r.zd.deviceIdOf(60), 'dev-60', 'the node\'s own device holds its slot');
    assert.equal(r.tick(), true, 'the raised node-down stays raised');
    // A re-interview prunes the child.
    w.devices = w.devices.filter((d) => d.id !== 'dev-60-ep2');
    await r.reload();
    assert.deepEqual(r.resetCalls, [], 'nor is the child going');
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.equal(r.tick(), true, 'still raised');
    assert.ok(!r.events().some((t) => t.includes('device changed')), r.events().join(' | '));
  });
});

test('device swap (v0.79.5): an endpoint child listed before its parent does not take the slot, and its pruning later is no swap', async () => {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }]);
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    const others = w.devices.filter((d) => d.node !== 60);
    w.devices = [...others, { id: 'dev-60-ep1', node: 60, ids: [`${HOME}-60-1`], parent: 'dev-60' }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60', 'the parent listed after its child takes the slot');
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }];
    await r.reload();
    assert.deepEqual(r.resetCalls, []);
    assert.equal(r.tick(), true, 'still raised');
  });
});

/** A replace by another product as Home Assistant's registry shows it: the old
 *  device keeps only `<home>-<node>-<mfr>:<type>:<id>` (the stripped orphan,
 *  kept until the integration's next setup) and the new one is added with
 *  `<home>-<node>`. Both are filed under node 60. */
async function replacedByAnotherProduct(orphanFirst: boolean): Promise<void> {
  const X = `${HOME}-60-634:20548:13`;
  const Y = `${HOME}-60-881:3:20`;
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, X] }]);
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    const orphan: Dev = { id: 'dev-60', node: 60, ids: [X] };
    const fresh: Dev = { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, Y] };
    const others = w.devices.filter((d) => d.node !== 60);
    w.devices = orphanFirst ? [...others, orphan, fresh] : [...others, fresh, orphan];
    w.roster = w.roster.map((n) => (n.node_id === 60 ? { ...n, status: 0, ready: false } : n));
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the swap is caught');
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b', 'the new device holds the slot, not the orphan');
    assert.equal(r.tick(), false, 'the new device is not raised while it reads Unknown');
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'no repeat at a later load');
    // The integration's next setup removes the orphan.
    w.devices = [...others, fresh];
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'nor when the orphan is swept');
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b');
  });
}

test('device swap (v0.79.5): a replace by another product with the stripped orphan listed first — the new device takes the slot and the swap is caught', async () => {
  await replacedByAnotherProduct(true);
});

test('device swap (v0.79.5): a replace by another product with the stripped orphan listed last — the new device still takes the slot and the swap is caught', async () => {
  await replacedByAnotherProduct(false);
});

test('device swap (v0.79.5): an entity on an endpoint child device maps to its node (the routed-read target), though the child never holds the node\'s slot', async () => {
  const w = world([...own(), { id: 'dev-60-ep2', node: 60, ids: [`${HOME}-60-2`] }]);
  w.entities = [{
    entity_id: 'switch.dev_60_ep2', device_id: 'dev-60-ep2', disabled_by: null, platform: 'zwave_js',
    original_name: 'Endpoint 2', unique_id: `${HOME}.60-37-2-currentValue`,
  }];
  await withRun(w, async (r) => {
    await joined(r);
    assert.equal(r.zd.deviceIdOf(60), 'dev-60', 'the child listed after its parent does not take the slot');
    assert.equal(r.zd.readEntityOf(60), 'switch.dev_60_ep2', 'the child\'s switch is node 60\'s');
  });
});

/* ── Another zwave_js config entry (v0.79.5) ──────────────────────────────── */

test('deviceInEntry (v0.79.5): a device is this network\'s when an entry field names the entry; one that lists none is kept, and every device while the entry is not known', () => {
  assert.equal(deviceInEntry({ id: 'd', config_entries: ['e1'], config_entry_id: 'e1' }, 'e1'), true);
  assert.equal(deviceInEntry({ id: 'd', config_entries: ['e2'], config_entry_id: 'e2' }, 'e1'), false);
  assert.equal(deviceInEntry({ id: 'd', config_entry_id: 'e2' }, 'e1'), false, 'a child device lists config_entry_id only');
  assert.equal(deviceInEntry({ id: 'd', config_entries: ['e2'] }, 'e1'), false, 'HA before 2026.8 lists config_entries only');
  assert.equal(deviceInEntry({ id: 'd', config_entries: ['e2', 'e1'] }, 'e1'), true);
  assert.equal(deviceInEntry({ id: 'd' }, 'e1'), true, 'no entry listed: kept');
  assert.equal(deviceInEntry({ id: 'd', config_entry_id: 'e2' }, null), true, 'the entry not known yet: kept');
});

for (const shape of ['id', 'list'] as const) {
  test(`device swap (v0.79.5): another zwave_js config entry's devices are not this network's — appended at a reload, its controller and node 60 take no slot and drop nothing (${shape === 'id' ? 'HA 2026.9+ entry fields, with a child device' : 'HA before 2026.8: config_entries only'})`, async () => {
    const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60a', node: 60 }].map((d) => ({ ...d, entry: ENTRY })));
    w.entryShape = shape;
    await withRun(w, async (r) => {
      await joined(r);
      r.priv.statsByNode.set(60, { ...STATS });
      raise(r);
      // Network B (another home id) is listed after this network's devices.
      const relayDev = shape === 'id' ? 'B-60-ep1' : 'B-60';
      w.devices = [
        ...w.devices,
        { id: 'B-ctrl', node: 1, ids: [`${HOME_B}-1`], entry: 'entry-B' },
        { id: 'B-60', node: 60, ids: [`${HOME_B}-60`], entry: 'entry-B' },
        ...(shape === 'id' ? [{ id: 'B-60-ep1', node: 60, ids: [`${HOME_B}-60-1`], entry: 'entry-B', parent: 'B-60' }] : []),
      ];
      w.entities = [{
        entity_id: 'switch.b_relay', device_id: relayDev, disabled_by: null, platform: 'zwave_js',
        original_name: 'B relay', unique_id: `${HOME_B}.60-37-1-currentValue`,
      }];
      await r.reload();
      assert.deepEqual(r.resetCalls, [], 'no swap');
      assert.equal(r.zd.deviceIdOf(60), 'dev-60a', 'node 60 keeps this network\'s device');
      assert.equal(r.zd.deviceIdOf(1), 'dev-1', 'and the controller its own');
      assert.equal(r.zd.readEntityOf(60), null, 'network B\'s switch is not node 60\'s routed-read target');
      assert.deepEqual(r.zd.entityStates(60), [], 'nor on its entity list');
      assert.ok(r.zd.evidence(60).length > 0, 'node 60 keeps its evidence');
      assert.equal(r.tick(), true, 'and its raised node-down');
    });
  });
}

test('device swap (v0.79.5): with the entry discovered, not configured, another entry\'s devices listed first take no slot — and a replace on that network is no swap here', async () => {
  const w = world([
    { id: 'B-ctrl', node: 1, ids: [`${HOME_B}-1`], entry: 'entry-B' },
    { id: 'B-60', node: 60, ids: [`${HOME_B}-60`, `${HOME_B}-60-634:20548:13`], entry: 'entry-B' },
    { id: 'dev-1', node: 1, entry: ENTRY }, { id: 'dev-7', node: 7, entry: ENTRY },
    { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1], entry: ENTRY },
  ]);
  w.entriesList = [
    { entry_id: 'entry-B', domain: 'zwave_js', state: 'not_loaded', title: 'B' },
    { entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'A' },
  ];
  await withRun(w, async (r) => {
    await joined(r);
    assert.ok(r.logs.includes(`discovered zwave_js entry_id=${ENTRY}`), r.logs.join('\n'));
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.equal(r.zd.deviceIdOf(1), 'dev-1');
    raise(r);
    // Network B's node 60 is replaced by another product.
    w.devices = w.devices.filter((d) => d.id !== 'B-60').concat([{ id: 'B-60x', node: 60, ids: [`${HOME_B}-60`], entry: 'entry-B' }]);
    await r.reload();
    assert.deepEqual(r.resetCalls, []);
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.equal(r.tick(), true, 'node 60 keeps its raised node-down');
  }, { entryId: null });
});

/* ── The own device the held state belongs to (v0.79.5) ──────────────────── */

/** An earlier replace by another product left the stripped orphan dev-60a
 *  (only `<home>-60-<P1>`, kept until the integration's next setup); P2's own
 *  device dev-60b holds the slot. */
const withOrphan = (): Dev[] => [{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60a', node: 60, ids: [P1] }, { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, P2] }];
/** Node 60 on its own device dev-60 with P1's hardware id, nothing else filed under it. */
const ownP1 = (): Dev[] => [{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }];

test('device swap (v0.79.5): an orphan that holds the slot after an eviction does not stand for the next device — one included on the id after that load, on the device id Home Assistant restores, keeps its own raised node-down at the next', async () => {
  const w = world(withOrphan());
  await withRun(w, async (r) => {
    await joined(r);
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b', 'precondition: P2\'s own device holds the slot');
    const gone = w.roster.find((n) => n.node_id === 60)!;
    // P2 excluded: HA removes its device (with its children); the orphan stays.
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.id !== 'dev-60b');
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    const evicted = r.resetCalls.length;
    await r.reload(); // an HA reconnect while the id is empty
    assert.equal(r.zd.deviceIdOf(60), 'dev-60a', 'only the orphan is listed: it holds the slot');
    // P3, another product, is included on the id: HA restores dev-60b with P3's
    // hardware id. It reads Dead and is raised.
    w.devices = [...w.devices, { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, P3] }];
    w.roster = [...w.roster, { ...gone }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60));
    raise(r);
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b');
    assert.equal(r.resetCalls.length, evicted, 'P3\'s own state is not dropped');
    assert.equal(r.tick(), true, 'its node-down stays raised');
    assert.ok(!r.events().some((t) => t.includes('device changed')), r.events().join(' | '));
  }, { evictAfterMs: 1 });
});

test('device swap (v0.79.5): another product included on the id inside the eviction dwell, around a load that lists only the orphan, is a swap — Home Assistant gives it back the excluded device\'s id with the new hardware id; judged at the load that lists it, not at the orphan\'s', async () => {
  const w = world(withOrphan());
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r); // P2 Dead, raised
    const gone = w.roster.find((n) => n.node_id === 60)!;
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.id !== 'dev-60b');
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    await r.reload(); // inside the 5-minute dwell: no eviction
    assert.equal(r.zd.deviceIdOf(60), 'dev-60a', 'only the orphan is listed');
    assert.deepEqual(r.resetCalls, [], 'the orphan holding the slot is no swap');
    // P3 included on the id, restored onto dev-60b, interviewed (Unknown).
    w.devices = [...w.devices, { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, P3] }];
    w.roster = [...w.roster, { ...gone, status: 0, ready: false }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b');
    assert.deepEqual(r.resetCalls, [60], 'P3 is compared against P2: P2\'s state goes, once');
    assert.equal(r.tick(), false, 'P2\'s raised node-down is not carried onto P3 while it is interviewed');
    assert.equal(r.zd.evidence(60).length, 0, 'nor its evidence');
  });
});

test('device swap (v0.79.5): another product included on a freed id inside the eviction dwell, with no load between, is a swap — on the device id Home Assistant restores, told apart by its hardware id', async () => {
  const w = world(ownP1());
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    // Excluded: HA deletes dev-60.
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.node !== 60);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    // Another product included on the id: dev-60 restored with P3's hardware id.
    w.devices = [...w.devices, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P3] }];
    w.roster = [...w.roster, { ...gone, status: 0, ready: false }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'P1\'s state goes, once');
    assert.equal(r.tick(), false, 'P1\'s raised node-down is not held onto P3');
    assert.equal(r.zd.evidence(60).length, 0);
  });
});

test('device swap (v0.79.5): the restored device listed before its interview, with no hardware id, keeps the one its record holds — the load that lists the new hardware id is the swap', async () => {
  const w = world(ownP1());
  await withRun(w, async (r) => {
    await joined(r);
    raise(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.node !== 60);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    // P3 included: listed on the restored dev-60 before its interview, with no
    // hardware id to file yet (inferred).
    w.devices = [...w.devices, { id: 'dev-60', node: 60 }];
    w.roster = [...w.roster, { ...gone, status: 0, ready: false }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.deepEqual(r.resetCalls, [], 'no hardware id to judge by yet');
    // The interview gives dev-60 P3's hardware id.
    w.devices = w.devices.map((d) => (d.node === 60 ? { ...d, ids: [`${HOME}-60`, P3] } : d));
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'compared against P1\'s, the one the record held');
    assert.equal(r.tick(), false);
  });
});

test('device swap (v0.79.5): a load that lists no device on the id leaves its record — another product included after it, on the device id Home Assistant restores, is still a swap', async () => {
  const w = world(ownP1());
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.node !== 60);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    await r.reload(); // nothing listed on the id, inside the dwell
    assert.deepEqual(r.resetCalls, []);
    w.devices = [...w.devices, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P3] }];
    w.roster = [...w.roster, { ...gone, status: 0, ready: false }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === 0));
    await r.reload();
    assert.deepEqual(r.resetCalls, [60]);
    assert.equal(r.tick(), false);
  });
});

test('device swap (v0.79.5): an evicted id back on the roster asks for a registry load — a replace by another product before Home Assistant reconnects is then a swap', async () => {
  const w = world(ownP1());
  await withRun(w, async (r) => {
    await joined(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    const others = w.devices.filter((d) => d.node !== 60);
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = others;
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    const evicted = r.resetCalls.length;
    // Back on the roster, on dev-60 restored with its own hardware id.
    const n = r.joins();
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P1] }];
    w.roster = [...w.roster, { ...gone }];
    await waitFor(() => r.joins() > n, 5000, () => `no registry load after the return; log: ${r.logs.join(' | ')}`);
    assert.equal(r.resetCalls.length, evicted, 'the return is no swap');
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    // replace_failed_node by another product: dev-60 stripped to an orphan, the node on dev-60b.
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [P1] }, { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, P3] }];
    w.roster = w.roster.map((x) => (x.node_id === 60 ? { ...x, status: 0, ready: false } : x));
    await waitFor(() => r.zd.snapshot().some((x) => x.nodeId === 60 && x.status === 0));
    await r.reload();
    assert.equal(r.resetCalls.length, evicted + 1, 'one swap');
    assert.equal(r.tick(), false, 'the raised node-down is dropped');
    assert.equal(r.zd.evidence(60).length, 0);
  }, { evictAfterMs: 1 });
});

/* ── A misread interview (v0.79.5) ────────────────────────────────────────── */

test('hardwareIdOfDevice (v0.79.5): HA\'s `<home_id>-<node_id>-<mfr>:<type>:<id>`, decimal integers; not the node\'s own id, an endpoint child\'s or another domain\'s', () => {
  const dev = (...ids: string[]) => ({ id: 'd', identifiers: ids.map((x) => ['zwave_js', x]) });
  assert.equal(hardwareIdOfDevice(dev(`${HOME}-60`, `${HOME}-60-634:20548:13`)), `${HOME}-60-634:20548:13`);
  assert.equal(hardwareIdOfDevice(dev(`${HOME}-60-0:0:13`)), `${HOME}-60-0:0:13`, 'a stripped orphan carries it alone');
  assert.equal(hardwareIdOfDevice(dev(`${HOME}-60`)), null);
  assert.equal(hardwareIdOfDevice(dev(`${HOME}-60-2`)), null);
  assert.equal(hardwareIdOfDevice(dev(`${HOME}-60-g1`)), null);
  assert.equal(hardwareIdOfDevice({ id: 'd', identifiers: [['other', `${HOME}-60-634:20548:13`]] }), null);
});

/** Node 60's real hardware ids, and the ids a misread interview reports. */
const HW_REAL = `${HOME}-60-634:20548:13`;
const HW_MISREAD = `${HOME}-60-0:0:13`;
/** Node 60 Alive throughout, on its own device with its real hardware id. */
function misreadWorld(): World {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }]);
  w.roster = w.roster.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : n));
  return w;
}

test('device swap (v0.79.5): a misread interview is taken for a swap once in an add-on run — the correct read that hands the id back to the orphan keeps what was built since', async () => {
  const w = misreadWorld();
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    for (let i = 0; i < 4; i++) r.tick();
    assert.ok(r.zd.evidence(60).length > 0, 'precondition: node 60 has evidence');
    const others = w.devices.filter((d) => d.node !== 60);
    // The misread, as HA files it: `<home>-60` stripped from dev-60, the node on a new device.
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [HW_REAL] }, { id: 'dev-60m', node: 60, ids: [`${HOME}-60`, HW_MISREAD] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60m');
    assert.deepEqual(r.resetCalls, [60], 'the misread is taken for a swap: the stated limit');
    r.priv.statsByNode.set(60, { ...STATS });
    for (let i = 0; i < 4; i++) r.tick();
    const built = r.zd.evidence(60).length;
    assert.ok(built > 0, 'precondition: evidence rebuilt');
    // The correct read: `<home>-60` stripped from dev-60m and given back to the orphan dev-60.
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }, { id: 'dev-60m', node: 60, ids: [HW_MISREAD] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.deepEqual(r.resetCalls, [60], 'the known hardware id coming back is no swap');
    assert.ok(r.zd.evidence(60).length >= built, 'what was built since is kept');
  });
});

test('device swap (v0.79.5): once the integration\'s setup has removed the orphan, the correct read files the node back on the orphan\'s own id, which Home Assistant restores — its known hardware id makes that no swap either', async () => {
  const w = misreadWorld();
  await withRun(w, async (r) => {
    await joined(r);
    const others = w.devices.filter((d) => d.node !== 60);
    // The misread; the setup sweep has removed the orphan dev-60 since.
    w.devices = [...others, { id: 'dev-60m', node: 60, ids: [`${HOME}-60`, HW_MISREAD] }];
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the misread: once');
    // The correct read: dev-60m stripped to an orphan, dev-60 restored with the real hardware id.
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }, { id: 'dev-60m', node: 60, ids: [HW_MISREAD] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.deepEqual(r.resetCalls, [60], 'not twice');
  });
});

test('device swap (v0.79.5): the same misread again is no swap, its hardware id being known — a replace by another product after it still is', async () => {
  const w = misreadWorld();
  await withRun(w, async (r) => {
    await joined(r);
    const others = w.devices.filter((d) => d.node !== 60);
    const misread = (): Dev[] => [...others, { id: 'dev-60', node: 60, ids: [HW_REAL] }, { id: 'dev-60m', node: 60, ids: [`${HOME}-60`, HW_MISREAD] }];
    w.devices = misread();
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the misread');
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }, { id: 'dev-60m', node: 60, ids: [HW_MISREAD] }];
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the correct read');
    w.devices = misread();
    await r.reload();
    assert.deepEqual(r.resetCalls, [60], 'the same misread again');
    // replace_failed_node by another product: dev-60m stripped too, the node on dev-60z.
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [HW_REAL] }, { id: 'dev-60m', node: 60, ids: [HW_MISREAD] }, { id: 'dev-60z', node: 60, ids: [`${HOME}-60`, P3] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60z');
    assert.deepEqual(r.resetCalls, [60, 60], 'the replace');
  });
});

test('device swap (v0.79.5): an add-on restart between a misread and the correct read costs a second reset — the hardware ids are held in memory only (the stated limit)', async () => {
  const w = misreadWorld();
  const others = w.devices.filter((d) => d.node !== 60);
  // This run starts on the registry the misread left.
  w.devices = [...others, { id: 'dev-60', node: 60, ids: [HW_REAL] }, { id: 'dev-60m', node: 60, ids: [`${HOME}-60`, HW_MISREAD] }];
  await withRun(w, async (r) => {
    await joined(r);
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }, { id: 'dev-60m', node: 60, ids: [HW_MISREAD] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60');
    assert.deepEqual(r.resetCalls, [60], 'the correct read is taken for a swap: this run never saw HW_REAL');
  });
});

test('device swap (v0.79.5): the hardware ids a node carried are forgotten when its eviction is consumed (off the roster 5 minutes, then a load) — a later replace by a unit of that product is a swap', async () => {
  const w = world([{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] }]);
  await withRun(w, async (r) => {
    await joined(r);
    const gone = w.roster.find((n) => n.node_id === 60)!;
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    w.devices = w.devices.filter((d) => d.node !== 60);
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    // Another product is included on the id, on dev-60 restored with its hardware id; the load after the eviction is no swap.
    w.devices = [...w.devices, { id: 'dev-60', node: 60, ids: [`${HOME}-60`, P2] }];
    w.roster = [...w.roster, { ...gone }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60));
    await r.reload();
    const before = r.resetCalls.length;
    raise(r);
    // replace_failed_node with a unit of the product the id had before it was
    // evicted: HA strips dev-60 to an orphan and files the node under a new device.
    const others = w.devices.filter((d) => d.node !== 60);
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [P2] }, { id: 'dev-60c', node: 60, ids: [`${HOME}-60`, HW_REAL] }];
    await r.reload();
    assert.equal(r.zd.deviceIdOf(60), 'dev-60c');
    assert.equal(r.resetCalls.length, before + 1, 'a swap: the ids from before the eviction are not this device\'s');
    assert.equal(r.tick(), false, 'the interim device\'s raised node-down goes with it');
  }, { evictAfterMs: 1 });
});

/* ── Another network or config entry (v0.79.5) ────────────────────────────── */

/** Network B's devices on node ids 1, 7 and 60, with no entry listed unless `entry` is given. */
const networkB = (entry?: string): Dev[] => [
  { id: 'B-1', node: 1, ids: [`${HOME_B}-1`], ...(entry ? { entry } : {}) },
  { id: 'B-7', node: 7, ids: [`${HOME_B}-7`], ...(entry ? { entry } : {}) },
  { id: 'B-60', node: 60, ids: [`${HOME_B}-60`, `${HOME_B}-60-29:12:34`], ...(entry ? { entry } : {}) },
];
const comparedLines = (logs: string[]) => logs.filter((l) => l.startsWith('device swap:') || l.includes('device changed in Home Assistant'));

test('device swap (v0.79.5): a home-id change starts the own-device records afresh — the new network\'s devices, loaded after it, are not compared with the old network\'s', async () => {
  const w = world(ownP1());
  await withRun(w, async (r) => {
    await joined(r);
    const n = r.joins();
    // Another controller behind the same entry: its home id, and its devices in the registry.
    w.home = HOME_B;
    w.devices = networkB();
    await waitFor(() => r.logs.some((l) => l.startsWith(`controller home_id ${HOME} → ${HOME_B}`)), 8000, () => r.logs.join(' | '));
    await waitFor(() => r.joins() > n, 8000, () => r.logs.join(' | '));
    assert.equal(r.zd.deviceIdOf(60), 'B-60');
    assert.deepEqual(comparedLines(r.logs), []);
    assert.deepEqual(r.resetCalls, []);
  });
});

test('device swap (v0.79.5): the self-heal finding another config entry starts the own-device records afresh — that entry\'s devices are not compared with the old entry\'s at the load before its home id is read', async () => {
  const w = world(ownP1().map((d) => ({ ...d, entry: ENTRY })));
  await withRun(w, async (r) => {
    await joined(r);
    const n = r.joins();
    // Home Assistant stops answering; meanwhile the integration was removed and
    // another network added on a new entry.
    w.statusFail = true;
    w.entriesList = [{ entry_id: 'entry-2', domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
    w.devices = networkB('entry-2');
    w.home = HOME_B;
    await waitFor(() => r.logs.some((l) => l.startsWith('repeated failures')), 8000, () => r.logs.join(' | '));
    w.statusFail = false;
    await waitFor(() => r.logs.some((l) => l.startsWith(`controller home_id ${HOME} → ${HOME_B}`)), 8000, () => r.logs.join(' | '));
    // Two loads: the one under the new entry, before the home id is read, and the one the home-id change asks for.
    await waitFor(() => r.joins() >= n + 2, 8000, () => r.logs.join(' | '));
    assert.ok(r.logs.includes('discovered zwave_js entry_id=entry-2'), r.logs.join('\n'));
    assert.equal(r.zd.deviceIdOf(60), 'B-60');
    assert.deepEqual(comparedLines(r.logs), []);
    assert.deepEqual(r.resetCalls, []);
  }, { entryId: null });
});

test('device swap (v0.79.5): the self-heal finding another config entry for the same controller (the integration re-added) starts the own-device records afresh — a device id that comes back new is not compared with the old entry\'s', async () => {
  const w = world(ownP1().map((d) => ({ ...d, entry: ENTRY })));
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    const n = r.joins();
    w.statusFail = true;
    // Re-added on a new entry: Home Assistant restores the orphaned device ids
    // it still holds; node 60's comes back new, with no hardware id listed.
    w.entriesList = [{ entry_id: 'entry-2', domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
    w.devices = [{ id: 'dev-1', node: 1, entry: 'entry-2' }, { id: 'dev-7', node: 7, entry: 'entry-2' }, { id: 'dev-60n', node: 60, entry: 'entry-2' }];
    await waitFor(() => r.logs.some((l) => l.startsWith('repeated failures')), 8000, () => r.logs.join(' | '));
    w.statusFail = false;
    await waitFor(() => r.joins() > n && r.zd.deviceIdOf(60) === 'dev-60n', 8000, () => r.logs.join(' | '));
    assert.ok(r.logs.includes('discovered zwave_js entry_id=entry-2'), r.logs.join('\n'));
    assert.deepEqual(comparedLines(r.logs), []);
    assert.deepEqual(r.resetCalls, []);
  }, { entryId: null });
});

test('device swap (v0.79.5): the self-heal finding the same config entry keeps the own-device records — a replace made while Home Assistant was not answering is a swap at the load after it', async () => {
  const w = world(ownP1().map((d) => ({ ...d, entry: ENTRY })));
  await withRun(w, async (r) => {
    await joined(r);
    r.priv.statsByNode.set(60, { ...STATS });
    raise(r);
    const n = r.joins();
    w.statusFail = true;
    // replace_failed_node by another product meanwhile: dev-60 stripped to an orphan, the node on dev-60b.
    const others = w.devices.filter((d) => d.node !== 60);
    w.devices = [...others, { id: 'dev-60', node: 60, ids: [P1], entry: ENTRY }, { id: 'dev-60b', node: 60, ids: [`${HOME}-60`, P3], entry: ENTRY }];
    await waitFor(() => r.logs.some((l) => l.startsWith('repeated failures')), 8000, () => r.logs.join(' | '));
    w.statusFail = false;
    await waitFor(() => r.joins() > n, 8000, () => r.logs.join(' | '));
    assert.equal(r.logs.filter((l) => l === `discovered zwave_js entry_id=${ENTRY}`).length, 2, 'the entry was discovered again');
    assert.equal(r.zd.deviceIdOf(60), 'dev-60b');
    assert.deepEqual(r.resetCalls, [60], 'the swap is caught');
    assert.equal(r.tick(), false, 'the raised node-down goes with the old device');
  }, { entryId: null });
});

/* ── The node's entity list (v0.79.5) ─────────────────────────────────────── */

/** From HA 2026.11 each labelled relay's switch is on a child device of the
 *  node's own device; node-level entities stay on the parent. A stripped
 *  orphan is listed too, and a child device whose parent is the orphan. */
function relayWorld(): World {
  const w = world([
    { id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 },
    { id: 'dev-60', node: 60, ids: [`${HOME}-60`, HW_REAL] },
    { id: 'dev-60-old', node: 60, ids: [`${HOME}-60-881:3:20`] },
    { id: 'dev-60-ep1', node: 60, ids: [`${HOME}-60-1`], parent: 'dev-60' },
    { id: 'dev-60-ep2', node: 60, ids: [`${HOME}-60-2`], parent: 'dev-60' },
    { id: 'dev-60-old-ep3', node: 60, ids: [`${HOME}-60-3`], parent: 'dev-60-old' },
  ]);
  const ent = (entityId: string, deviceId: string, uniqueId: string | null) => ({
    entity_id: entityId, device_id: deviceId, disabled_by: null, platform: 'zwave_js', original_name: null, unique_id: uniqueId,
  });
  w.entities = [
    ent('sensor.relay_node_status', 'dev-60', `${HOME}.60.node_status`),
    ent('switch.relay_1', 'dev-60-ep1', `${HOME}.60-37-1-currentValue`),
    ent('switch.old_relay', 'dev-60-old', null),
    ent('switch.old_relay_3', 'dev-60-old-ep3', null),
    ent('switch.relay_2', 'dev-60-ep2', `${HOME}.60-37-2-currentValue`),
  ];
  return w;
}
const RELAY_ENTITIES = ['sensor.relay_node_status', 'switch.relay_1', 'switch.relay_2'];

test('device swap (v0.79.5): the node\'s entity list is its own device\'s and its endpoint children\'s — both relays are listed and get Actions rows; the orphan\'s entity and its child\'s are left out', async () => {
  const w = relayWorld();
  await withRun(w, async (r) => {
    await joined(r);
    assert.equal(r.zd.deviceIdOf(60), 'dev-60', 'the node\'s own device holds the slot');
    assert.deepEqual(r.zd.entityStates(60).map((e) => e.entityId), RELAY_ENTITIES);
    assert.deepEqual(r.zd.snapshot().find((n) => n.nodeId === 60)!.entities.map((e) => e.entityId), RELAY_ENTITIES);
    const rows = buildEntityRows(r.zd.entityStates(60)).map((x) => x.desc.label);
    for (const sw of ['switch.relay_1', 'switch.relay_2']) assert.ok(rows.some((l) => l.endsWith(`· ${sw}`)), `${sw}: ${rows.join(' | ')}`);
    assert.ok(!rows.some((l) => l.includes('old_relay')), rows.join(' | '));
  });
});

test('device swap (v0.79.5): a node that leaves the network takes its endpoint children\'s live states with it', async () => {
  const w = relayWorld();
  w.states = RELAY_ENTITIES.map((e) => ({ entity_id: e, state: 'on', attributes: {} }));
  await withRun(w, async (r) => {
    await joined(r);
    await waitFor(() => r.zd.entityStates(60).length === 3 && r.zd.entityStates(60).every((e) => e.state === 'on'));
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    assert.deepEqual(r.zd.entityStates(60).map((e) => [e.entityId, e.state]), RELAY_ENTITIES.map((e) => [e, null]));
  }, { evictAfterMs: 1 });
});
