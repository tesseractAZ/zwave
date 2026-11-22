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
import { createZwaveData, type ZwaveDataOptions } from '../src/zwave/zwaveData';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';

const MIN = 60_000;
const DAY = 86_400_000;
const TICK = 30_000;
const ENTRY = 'entry-1';
const HOME = 3586281591;

/** `ids`: the device's zwave_js identifiers; default the node's own `<home>-<node>`. */
type Dev = { id: string; node: number; ids?: string[] };
interface World { roster: Array<Record<string, unknown>>; devices: Dev[]; entities?: Array<Record<string, unknown>> }

function fakeHa(w: World): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  const result = (cmd: Record<string, unknown>): unknown => {
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list':
        return w.devices.map((d) => ({ id: d.id, identifiers: (d.ids ?? [`${HOME}-${d.node}`]).map((s) => ['zwave_js', s]), name: `Dev ${d.id}`, area_id: null }));
      case 'config/entity_registry/list': return w.entities ?? [];
      case 'get_states': return [];
      case 'zwave_js/network_status':
        return { client: { server_version: 't' }, controller: { home_id: HOME, own_node_id: 1, nodes: w.roster } };
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
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error('waitFor: condition not met in time');
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
    await waitFor(() => zd.snapshot().some((n) => n.nodeId === 60));
    const priv = zd as unknown as Priv;
    const resetCalls: number[] = [];
    const orig = priv.baselines.resetNode.bind(priv.baselines);
    priv.baselines.resetNode = (id: number) => { resetCalls.push(id); orig(id); };
    const joins = () => logs.filter((l) => l.startsWith('registry join:')).length;
    await body({
      zd, logs, resetCalls, priv,
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
    assert.ok(r.events().some((t) => t.includes('node 60 is another device')), 'on the record');
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

test('device swap (v0.79.5): an id the departed branch evicted is no swap at the next load — what the new device built since is kept; a later swap is still one', async () => {
  const w = world();
  await withRun(w, async (r) => {
    const gone = w.roster.find((n) => n.node_id === 60)!;
    w.roster = w.roster.filter((n) => n.node_id !== 60);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    await waitFor(() => r.logs.some((l) => l.startsWith('node 60 left the network')));
    // Re-included: another device, Dead, raised before HA reconnects.
    w.devices = w.devices.map((d) => (d.node === 60 ? { id: 'dev-60b', node: 60 } : d));
    w.roster = [...w.roster, { ...gone }];
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60));
    raise(r);
    const before = r.resetCalls.length;
    await r.reload();
    assert.equal(r.resetCalls.length, before, 'not forgotten twice');
    assert.equal(r.tick(), true, 'the new device\'s node-down stays raised');
    // The mark is spent at that load: a later swap on the id is one.
    w.devices = w.devices.map((d) => (d.node === 60 ? { id: 'dev-60c', node: 60 } : d));
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
    assert.deepEqual(dropped.map((a) => a.slice(0, 2)), [[60, 'another device took the id']]);
    assert.ok(r.events().includes("1 in-flight episode + node 60's baselines discarded — another device took the id"), r.events().join(' | '));
  });
});

/* ── The node's own device holds its slot (v0.79.5) ───────────────────────── */

/** Node 60's own device `dev-60`, identified `<home>-60`. */
const own = (): Dev[] => [{ id: 'dev-1', node: 1 }, { id: 'dev-7', node: 7 }, { id: 'dev-60', node: 60 }];
const joined = (r: { logs: string[] }) => waitFor(() => r.logs.some((l) => l.startsWith('registry join:')));

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
    assert.ok(!r.events().some((t) => t.includes('another device')), r.events().join(' | '));
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
