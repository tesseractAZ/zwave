/**
 * v0.79.3 — node-down across a restart of this add-on.
 *
 * v0.79.2 gave a node auto-ping does not probe a 90-minute node-down dwell when
 * it read Dead at "the driver's start", and took that start from every driver-WS
 * handshake — this add-on's own first one included. With the dwell state in
 * memory, a deploy while a FLiRS node was already Dead withdrew its raised
 * node-down and held it back for 90 minutes (binary_sensor.zwave_tui_degraded
 * read off meanwhile). These tests pin the repair: only a KNOWN driver start
 * opens the window, and node-down dwells outlive the process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, uptime as osUptime } from 'node:os';
import { join } from 'node:path';
import {
  detectSymptoms, nodeDownCarry, seedNodeDown, DWELL_MS, NODE_DOWN_START_DWELL_MS, NODE_DOWN_START_WINDOW_MS,
  type DetectInput, type DriverStart, type SymptomState,
} from '../src/zwave/symptoms';
import { createEvidenceStore, type EvidenceCarry, type CoarseBucket } from '../src/zwave/evidenceStore';
import { createZwaveData } from '../src/zwave/zwaveData';
import type { BaselineStore, RateNormal, ContNormal } from '../src/zwave/baselines';
import { NodeStatus, type NodeSnapshot, type ControllerSnapshot, type NodeStats } from '../src/types';
import type { HaWsClient, HaEventHandler, HaSubscription } from '../src/ha/haWsClient';
import { mockServer } from './_driverWsMock';
import { buildZwaveDataSource, createTuiDataProvider } from '../src/telnet/dataProvider';
import { buildStates, ENTITY_DEGRADED } from '../src/haStates';

const MIN = 60_000;
const DAY = 86_400_000;
const T = 1_000_000_000_000;
const TICK = 30_000;

/* ── Detector ─────────────────────────────────────────────────────────────── */

function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    nodeId: id, deviceId: 'd' + id, name: `Node ${id}`, area: null, status: NodeStatus.Alive,
    statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
    isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
    battery: null, firmware: null, stats: {} as never, entities: [], ...over,
  };
}
function baselineStub(): BaselineStore {
  const timeout: RateNormal = { rate: 0.02, trials: 500, ready: true, days: 5 };
  const cont: ContNormal = { median: 30, scale: 8, ready: true, days: 5 };
  return {
    path: '/x', observe() {}, resetNode() {}, reset() {}, load() {}, save() {},
    timeoutNormal: () => timeout, rssiNormal: () => cont, rttNormal: () => cont,
  } as unknown as BaselineStore;
}
function input(now: number, nodes: NodeSnapshot[], driverStarts: DriverStart[]): DetectInput {
  return {
    now, nodes,
    controller: { backgroundRSSI: [] } as unknown as ControllerSnapshot,
    baselines: baselineStub(),
    latest: () => undefined, recent: () => [], coarse: () => [] as CoarseBucket[],
    controllerSamples: () => [], coverage: () => null, rateRun: () => null, rttSeed: () => null,
    driverStarts,
    recordingSince: () => now - 30 * DAY,
    sleeperWatch: () => null, duplicateBursts: () => [],
  };
}
const flirs = (status = NodeStatus.Dead) => () => node(60, { status, isListening: false, isFrequentListening: true } as never);

/** Tick every 30 s from `from` for `minutes`: minutes to the first node-down
 *  for node 60, whether it was up on the last tick, and its sinceMs then. */
function run(state: SymptomState, n: () => NodeSnapshot, starts: DriverStart[], from: number, minutes: number) {
  let first: number | null = null; let last = false; let since: number | null = null;
  for (let t = from; t <= from + minutes * MIN; t += TICK) {
    const s = detectSymptoms(input(t, [node(1), n()], starts), state).find((x) => x.kind === 'node-down' && x.nodeId === 60);
    last = s != null;
    if (s) since = s.sinceMs;
    if (first == null && last) first = (t - from) / MIN;
  }
  return { first, last, since };
}

test('node-down start window (v0.79.3): a death first seen inside a known start span, or up to NODE_DOWN_START_WINDOW_MS after its end, waits 90 min; one before the span or later waits 5', () => {
  assert.equal(NODE_DOWN_START_WINDOW_MS, 10 * MIN);
  assert.equal(NODE_DOWN_START_DWELL_MS, 90 * MIN);
  // A Z-Wave JS restart seen over the link: the server ended the link at T and
  // handshook again at T + 4 min.
  const span = [{ from: T, to: T + 4 * MIN }];
  assert.equal(run(new Map(), flirs(), span, T + 2 * MIN, 95).first, 90, 'inside the span');
  assert.equal(run(new Map(), flirs(), span, T + 13 * MIN, 95).first, 90, '9 min after its end');
  assert.equal(run(new Map(), flirs(), span, T + 15 * MIN, 10).first, 5, '11 min after its end');
  assert.equal(run(new Map(), flirs(), span, T - MIN, 10).first, 5, 'before the link was ended');
  assert.equal(run(new Map(), flirs(), [], T, 10).first, 5, 'no known start');
  // Any known start qualifies: a boot days ago does not hide a restart since.
  assert.equal(run(new Map(), flirs(), [{ from: T - 5 * DAY, to: T - 5 * DAY }, ...span], T + 2 * MIN, 95).first, 90, 'the later of two starts');
  assert.equal(run(new Map(), flirs(), [{ from: T - 5 * DAY, to: T - 5 * DAY }], T + 2 * MIN, 10).first, 5, 'a boot days ago opens nothing');
});

test('node-down carry (v0.79.3): a node-down raised before a restart is raised on the next run\'s first tick, with its own since', () => {
  const before: SymptomState = new Map();
  const r0 = run(before, flirs(), [{ from: T - 5 * DAY, to: T - 5 * DAY }], T - 60 * MIN, 30);
  assert.equal(r0.first, 5, 'precondition: raised in the old run');
  const carried = nodeDownCarry(before);
  assert.deepEqual(carried, [{ nodeId: 60, since: T - 60 * MIN, latched: true }]);
  const after: SymptomState = new Map();
  assert.equal(seedNodeDown(after, carried, () => true, T), 1);
  const r = run(after, flirs(), [], T, 5);
  assert.equal(r.first, 0, 'raised on the first tick: no withdrawn alarm');
  assert.equal(r.since, T - 60 * MIN, 'and still dated from the outage, not the restart');
});

test('node-down carry (v0.79.3): a start death still waiting at a deploy waits 90 min from its own onset, not from the deploy nor at 5', () => {
  const boot = [{ from: T - MIN, to: T - MIN }];
  const before: SymptomState = new Map();
  assert.equal(run(before, flirs(), boot, T + MIN, 30).first, null, 'precondition: a start death, not yet raised');
  const after: SymptomState = new Map();
  seedNodeDown(after, nodeDownCarry(before), () => true, T + 32 * MIN);
  // The next run reads the same boot: at its first tick (T + 32 min) the
  // death is 31 min old, so it is raised 59 min later.
  const r = run(after, flirs(), boot, T + 32 * MIN, 65);
  assert.equal(r.first, 59, 'raised at onset + 90 min');
  assert.equal(r.since, T + MIN);
});

test('node-down carry (v0.79.3): a carried dwell is re-judged — a node that now reads Alive drops it on the first tick', () => {
  const after: SymptomState = new Map();
  seedNodeDown(after, [{ nodeId: 60, since: T - DAY, latched: true }], () => true, T);
  const r = run(after, flirs(NodeStatus.Alive), [], T, 2);
  assert.equal(r.first, null);
  assert.equal(after.has('60:node-down'), false, 'the dwell is gone');
});

test('seedNodeDown (v0.79.3): only nodes `keep` admits, never over an entry this run holds, and a since ahead of now is taken as now', () => {
  const s: SymptomState = new Map();
  s.set('7:node-down', { since: T - MIN, lastSeen: T, hits: 3 });
  const n = seedNodeDown(s, [
    { nodeId: 7, since: T - DAY, latched: true },
    { nodeId: 8, since: T - DAY, latched: false },
    { nodeId: 9, since: T + 10 * MIN, latched: true },
  ], (id) => id !== 8, T);
  assert.equal(n, 1);
  assert.deepEqual(s.get('7:node-down'), { since: T - MIN, lastSeen: T, hits: 3 }, 'this run\'s own entry is kept');
  assert.equal(s.has('8:node-down'), false, 'a node off the roster is not seeded');
  assert.deepEqual(s.get('9:node-down'), { since: T, lastSeen: T, hits: 1, latched: true }, 'a clock behind the save cannot postpone it');
  // Only node-down entries are carried.
  s.set('7:rtt-degraded', { since: T, lastSeen: T, hits: 1 });
  s.set('75:flapping', { since: T, lastSeen: T, hits: 1 }); // cut by the suffix's length it would read as node 7
  assert.deepEqual(nodeDownCarry(s).map((c) => c.nodeId).sort(), [7, 9]);
});

/* ── Evidence store ───────────────────────────────────────────────────────── */

const UP = 5 * DAY;
function stats(): NodeStats {
  return {
    rtt: 30, rssi: -60, lwr: null, nlwr: null, commandsTX: 1, commandsRX: 1, commandsDroppedTX: 0,
    commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null,
  } as unknown as NodeStats;
}
function freshPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-'));
  return { dir, path: join(dir, 'evidence.json') };
}
const CARRY: EvidenceCarry = {
  nodeDown: [{ nodeId: 60, since: T - DAY, latched: true }, { nodeId: 61, since: T - 2 * MIN, latched: false }],
  driverStart: { from: T - 20 * MIN, to: T - 19 * MIN },
};

test('evidence carry (v0.79.3): node-down dwells and the newest driver restart round-trip; the restored carry is taken once', () => {
  const { dir, path } = freshPath();
  try {
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => CARRY });
    a.load();
    a.bindHomeId(42);
    a.record(6, stats(), NodeStatus.Alive);
    a.save();
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(file.nodeDown, { 60: { s: T - DAY, l: 1 }, 61: { s: T - 2 * MIN } });
    assert.deepEqual(file.driverStart, { f: T - 20 * MIN, t: T - 19 * MIN });
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + MIN, uptimeMs: () => UP + MIN });
    b.load();
    b.bindHomeId(42);
    assert.deepEqual(b.takeCarry(), CARRY, 'same boot: all of it');
    assert.equal(b.takeCarry(), null, 'once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): on another boot the node-down dwells still load but the driver restart does not — under boot grace and from an old file too', () => {
  const { dir, path } = freshPath();
  try {
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => CARRY });
    a.load();
    a.record(6, stats(), NodeStatus.Alive);
    a.save();
    // The host restarted and has been up 40 s, its clock not proven to have
    // carried through (inside the 180 s boot grace: the fine ring is dropped).
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + 50_000, uptimeMs: () => 40_000, bootGraceMs: 180_000 });
    b.load();
    assert.deepEqual(b.takeCarry(), { nodeDown: CARRY.nodeDown, driverStart: null }, 'under boot grace');
    // The same file read 3 hours on (past the fine ring's 60-min age).
    const c = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + 3 * 60 * MIN, uptimeMs: () => 40_000, bootGraceMs: 180_000 });
    c.load();
    assert.deepEqual(c.takeCarry(), { nodeDown: CARRY.nodeDown, driverStart: null }, 'from an old file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): a save before the engine takes the carry writes it back; after, it writes the engine\'s; another network drops it', () => {
  const { dir, path } = freshPath();
  try {
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => CARRY });
    a.load(); a.bindHomeId(42); a.record(6, stats(), NodeStatus.Alive); a.save();
    const mine: EvidenceCarry = { nodeDown: [{ nodeId: 63, since: T, latched: true }], driverStart: null };
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + MIN, uptimeMs: () => UP + MIN, carry: () => mine });
    b.load(); b.bindHomeId(42); b.record(6, stats(), NodeStatus.Alive); b.save();
    let file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(file.nodeDown as object).sort(), ['60', '61'], 'not yet taken: what was restored');
    assert.deepEqual(file.driverStart, { f: T - 20 * MIN, t: T - 19 * MIN });
    b.takeCarry(); b.record(6, stats(), NodeStatus.Alive); b.save();
    file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(file.nodeDown, { 63: { s: T, l: 1 } }, 'taken: the engine\'s own');
    assert.equal(file.driverStart, undefined);
    // Another network: the restored carry is dropped with the evidence.
    const c = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + 2 * MIN, uptimeMs: () => UP + 2 * MIN });
    c.load(); c.bindHomeId(99);
    assert.equal(c.takeCarry(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): a change in the carry alone saves the store; an unchanged one with no new sample writes nothing', () => {
  const { dir, path } = freshPath();
  try {
    let carry: EvidenceCarry = CARRY;
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => carry });
    a.load(); a.record(6, stats(), NodeStatus.Alive); a.save();
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + MIN, uptimeMs: () => UP + MIN, carry: () => carry });
    b.load();
    const mark = (): void => writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), mark: 1 }));
    const marked = (): boolean => (JSON.parse(readFileSync(path, 'utf8')) as { mark?: number }).mark === 1;
    mark(); b.save();
    assert.equal(marked(), true, 'restored and unchanged, no sample: nothing written');
    b.takeCarry();
    mark(); b.save();
    assert.equal(marked(), true, 'taken, and the engine\'s carry is the same: nothing written');
    carry = { ...CARRY, driverStart: { from: T + 30_000, to: T + 35_000 } };
    b.save();
    assert.equal(marked(), false, 'a new driver restart alone is written');
    assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as { driverStart: unknown }).driverStart, { f: T + 30_000, t: T + 35_000 });
    mark(); b.save();
    assert.equal(marked(), true, 'and once only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): malformed entries are skipped, an inverted span is not a start', () => {
  const { dir, path } = freshPath();
  try {
    const bad = { nodeDown: [{ nodeId: 0, since: T, latched: true }, { nodeId: 5, since: -1, latched: true }, { nodeId: 6, since: T, latched: false }], driverStart: { from: T, to: T - MIN } };
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => bad });
    a.load(); a.record(6, stats(), NodeStatus.Alive); a.save();
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP });
    b.load();
    assert.deepEqual(b.takeCarry(), { nodeDown: [{ nodeId: 6, since: T, latched: false }], driverStart: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Production-wired: createZwaveData restarted over one evidence file ───── */

const ENTRY = 'entry-1';
const HOME = 3586281591;
function fakeHa(roster: Array<Record<string, unknown>>): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  const result = (cmd: Record<string, unknown>): unknown => {
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list': return [];
      case 'config/entity_registry/list': return [];
      case 'get_states': return [];
      case 'zwave_js/network_status':
        return { client: { server_version: 't' }, controller: { home_id: HOME, own_node_id: 1, nodes: roster } };
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
    subscribe: async (_cmd: Record<string, unknown>, _on: HaEventHandler): Promise<HaSubscription> => ({ subscriptionId: 1, unsubscribe: async () => {} }),
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
const ROSTER = [
  { node_id: 1, status: 4, ready: true, is_routing: true, is_controller_node: true },
  { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false },
  { node_id: 60, status: 3, ready: true, is_routing: true, is_secure: false },
];
const DUMP = [
  { nodeId: 7, isListening: true, isFrequentListening: false, statistics: {} },
  { nodeId: 60, isListening: false, isFrequentListening: true, statistics: {} },
];

/** The wall clock runs on, plus whatever the test skips ahead: monotonic, so
 *  stamps from one run stay behind the next run's. */
const realNow = Date.now.bind(Date);
let skip = 0;
function useClock(): () => void {
  skip = 0;
  Date.now = () => realNow() + skip;
  return () => { Date.now = realNow; };
}

type Run = { zd: ReturnType<typeof createZwaveData>; tick: () => boolean; degraded: () => string; stop: () => void };
/** Every run started and not yet stopped: a test's finally stops them all, so a
 *  failing assertion cannot leave a live client holding the mock server open. */
const live = new Set<Run>();
function stopAll(): void {
  for (const r of [...live]) r.stop();
}
/** `bootAt` null: production's own uptime source. */
async function startRun(dir: string, url: string, bootAt: number | null, logs: string[] = [], o: { roster?: Array<Record<string, unknown>>; uptimeMs?: () => number } = {}): Promise<Run> {
  const roster = o.roster ?? ROSTER;
  const ha = fakeHa(roster);
  const uptimeMs = o.uptimeMs ?? (bootAt == null ? undefined : () => Date.now() - bootAt);
  const zd = createZwaveData({
    client: ha, entryId: ENTRY, refreshMs: 100, routePollMs: 60_000, evidenceSampleMs: 30 * MIN,
    historyPath: null, evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: url, log: (m: string) => logs.push(m),
    ...(uptimeMs ? { uptimeMs } : {}),
  } as never);
  zd.start();
  ha.fireReady();
  await waitFor(() => zd.driverWsState() === 'live');
  const want = roster.find((n) => n.node_id === 60)!.status === 3 ? NodeStatus.Dead : NodeStatus.Alive;
  await waitFor(() => zd.snapshot().some((n) => n.nodeId === 60 && n.status === want && n.isListening === false));
  const priv = zd as unknown as { lastOkAt: number | null; sampleEvidence: () => void };
  const { provider, stop: stopProvider } = createTuiDataProvider({ zwaveData: buildZwaveDataSource(zd as never), refreshMs: 60_000, log: () => {} } as never);
  const run: Run = {
    zd,
    // One evidence tick (the engine runs in it), then 30 s on.
    tick: () => {
      priv.lastOkAt = Date.now();
      priv.sampleEvidence();
      const up = zd.symptoms().some((s) => s.kind === 'node-down' && s.nodeId === 60);
      skip += TICK;
      return up;
    },
    degraded: () => buildStates(provider, Date.now(), { writeActions: false, startedAt: Date.now() }).find((x) => x.entity === ENTITY_DEGRADED)!.state,
    stop() {
      if (!live.delete(this)) return;
      stopProvider();
      zd.stop();
    },
  };
  live.add(run);
  return run;
}
/** Minutes of ticks to the first node-down for node 60, or null. */
function ticksTo(r: Run, minutes: number): number | null {
  for (let i = 0; i <= minutes * 2; i++) if (r.tick()) return i / 2;
  return null;
}

test('restart (v0.79.3, production-wired): a deploy while a FLiRS node is Dead and raised — the next run raises it on its first tick and degraded never reads off', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY; // the host and the driver up for days
  try {
    const a = await startRun(dir, srv.url, bootAt);
    assert.equal(ticksTo(a, 10), 5, 'precondition: raised at 5 min in the first run');
    assert.equal(a.degraded(), 'on');
    a.stop(); // SIGTERM: the evidence store saves, the carry with it
    // A node removed while the add-on was down: carried, but off the roster.
    const path = join(dir, 'evidence.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { nodeDown: Record<string, unknown> };
    assert.deepEqual(Object.keys(file.nodeDown), ['60']);
    file.nodeDown['99'] = { s: Date.now() - DAY, l: 1 };
    writeFileSync(path, JSON.stringify(file));
    skip += MIN;
    const logs: string[] = [];
    const b = await startRun(dir, srv.url, bootAt, logs);
    assert.equal(b.tick(), true, 'raised on the next run\'s first tick');
    assert.equal(b.degraded(), 'on', 'degraded stays on across the deploy');
    assert.ok(logs.some((l) => /node-down: carried 1 dwell\(s\) across the restart \(1 already raised\)/.test(l)), logs.join('\n'));
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): with nothing carried, this add-on\'s own start is not a driver start — an already-Dead FLiRS node is raised at 5 min, not 90 (v0.79.2)', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    const r = await startRun(dir, srv.url, Date.now() - 5 * DAY);
    const handshake = r.zd.driverReconnectedAt();
    assert.ok(handshake != null && Date.now() - handshake < 60_000, 'the handshake stamp still moves (auto-ping\'s burst refusal reads it)');
    assert.equal(ticksTo(r, 10), 5);
    assert.deepEqual(r.zd.driverStarts().map((s) => Math.round((Date.now() - s.to) / DAY)), [5], 'the only known start is the boot, 5 days ago');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a host reboot is a driver start — a FLiRS node Dead at it waits 90 min', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    const r = await startRun(dir, srv.url, Date.now() - 40_000); // up 40 s
    assert.equal(ticksTo(r, 95), 90);
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a start death still waiting at a deploy on the same boot waits 90 min from its onset — no false alarm at the deploy', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 40_000;
  try {
    const a = await startRun(dir, srv.url, bootAt);
    assert.equal(ticksTo(a, 30), null, 'precondition: 30 min in, still waiting');
    a.stop();
    skip += MIN;
    const b = await startRun(dir, srv.url, bootAt);
    // 30.5 min of ticks plus the minute between runs: 58.5 more to onset + 90.
    assert.equal(ticksTo(b, 65), 58.5);
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a Z-Wave JS restart seen over the link is a known start, spanning the drop to the re-handshake, and is carried to the next run on this boot', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  try {
    const logs: string[] = [];
    const a = await startRun(dir, srv.url, bootAt, logs);
    a.tick();
    assert.equal(a.zd.driverStarts().length, 1, 'only the boot');
    const dropAt = Date.now();
    srv.dropClient(); // the server ends the link: the driver went away
    await waitFor(() => srv.connectionCount() === 2 && a.zd.driverWsState() === 'live', 15_000);
    const starts = a.zd.driverStarts();
    assert.equal(starts.length, 2);
    assert.ok(starts[1]!.from >= dropAt && starts[1]!.to <= Date.now(), JSON.stringify(starts));
    assert.ok(starts[1]!.to - starts[1]!.from >= 4000, 'from the drop, not the re-handshake (the first retry waits 5 s)');
    assert.ok(logs.some((l) => /the server ended the link \d+s ago and is back — a driver start/.test(l)));
    a.stop();
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { driverStart?: { f: number; t: number } };
    assert.deepEqual(file.driverStart, { f: starts[1]!.from, t: starts[1]!.to });
    skip += 2 * MIN; // the host's uptime runs on with its clock
    const b = await startRun(dir, srv.url, bootAt);
    b.tick();
    assert.deepEqual(b.zd.driverStarts().slice(1), [starts[1]], 'the next run on this boot knows it');
    // A restart that run sees itself is newer, and is what it carries on.
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 4 && b.zd.driverWsState() === 'live', 15_000);
    const newer = b.zd.driverStarts().find((s) => s.from > starts[1]!.to)!;
    assert.ok(newer != null, JSON.stringify(b.zd.driverStarts()));
    b.stop();
    const file2 = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { driverStart?: { f: number; t: number } };
    assert.deepEqual(file2.driverStart, { f: newer.from, t: newer.to });
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): the boot is read as a start once, at the engine\'s first tick — a wall clock that then jumps ahead of uptime does not move it off a start death', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    // A host up 40 s whose uptime runs in real time while the wall clock steps
    // ahead 30 s a tick (as an NTP step does on a host without a clock
    // battery). Read again each tick, now - uptime would slide past the death's
    // onset within two ticks and drop it to the 5-minute dwell.
    const r0 = realNow();
    const r = await startRun(dir, srv.url, null, [], { uptimeMs: () => 40_000 + (realNow() - r0) });
    assert.equal(ticksTo(r, 95), 90, 'a start death at the reboot waits 90 min');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): by default the boot is the host\'s own, from os.uptime()', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    const r = await startRun(dir, srv.url, null);
    r.tick();
    const boot = r.zd.driverStarts()[0]!;
    assert.ok(Math.abs(boot.to - (realNow() - osUptime() * 1000)) < 3000, `${boot.to} vs ${realNow() - osUptime() * 1000}`);
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
