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
import { createEvidenceStore, DRIVER_DROP_CARRY_MS, type EvidenceCarry } from '../src/zwave/evidenceStore';
import { createZwaveData, type ZwaveDataOptions } from '../src/zwave/zwaveData';
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
    latest: () => undefined, recent: () => [],
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
  assert.deepEqual(carried, [{ nodeId: 60, since: T - 60 * MIN, latched: true, start: false }]);
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
  seedNodeDown(after, [{ nodeId: 60, since: T - DAY, latched: true, start: false }], () => true, T);
  const r = run(after, flirs(NodeStatus.Alive), [], T, 2);
  assert.equal(r.first, null);
  assert.equal(after.has('60:node-down'), false, 'the dwell is gone');
});

test('seedNodeDown (v0.79.3): only nodes `keep` admits, never over an entry this run holds, and a since ahead of now is taken as now', () => {
  const s: SymptomState = new Map();
  s.set('7:node-down', { since: T - MIN, lastSeen: T, hits: 3 });
  const n = seedNodeDown(s, [
    { nodeId: 7, since: T - DAY, latched: true, start: false },
    { nodeId: 8, since: T - DAY, latched: false, start: false },
    { nodeId: 9, since: T + 10 * MIN, latched: true, start: true },
  ], (id) => id !== 8, T);
  assert.equal(n, 1);
  assert.deepEqual(s.get('7:node-down'), { since: T - MIN, lastSeen: T, hits: 3 }, 'this run\'s own entry is kept');
  assert.equal(s.has('8:node-down'), false, 'a node off the roster is not seeded');
  assert.deepEqual(s.get('9:node-down'), { since: T, lastSeen: T, hits: 1, latched: true, start: true }, 'a since ahead of the clock is taken as now; the flags are kept');
  const s2: SymptomState = new Map();
  seedNodeDown(s2, [{ nodeId: 5, since: T - DAY, latched: true, start: false }], () => true, T);
  assert.deepEqual(s2.get('5:node-down'), { since: T - DAY, lastSeen: T, hits: 1, latched: true }, 'Dead as of the restart, as far as this run knows');
  // Only node-down entries are carried.
  s.set('7:rtt-degraded', { since: T, lastSeen: T, hits: 1 });
  s.set('75:flapping', { since: T, lastSeen: T, hits: 1 }); // cut by the suffix's length it would read as node 7
  assert.deepEqual(nodeDownCarry(s).map((c) => c.nodeId).sort(), [7, 9]);
});

test('node-down (v0.79.3): Unknown is no reading — a raised node-down stays raised through it, a waiting one keeps its onset; Alive ends it', () => {
  // Raised, then a driver restart reads the node Unknown for a tick.
  const state: SymptomState = new Map();
  assert.equal(run(state, flirs(), [], T, 6).first, 5);
  const held = detectSymptoms(input(T + 7 * MIN, [node(1), flirs(NodeStatus.Unknown)()], []), state).find((x) => x.kind === 'node-down');
  assert.ok(held, 'still raised while Unknown');
  assert.equal(held!.sinceMs, T);
  assert.equal(held!.evidence[0]!.value, 'Unknown now; Dead for 6m before', 'Dead time only, to the last Dead reading');
  assert.match(held!.narrative, /status is now Unknown, which is no reading/);
  assert.equal(run(state, flirs(), [], T + 8 * MIN, 0).first, 0, 'raised as it reads Dead again');
  assert.equal(run(state, flirs(NodeStatus.Alive), [], T + 9 * MIN, 0).first, null);
  assert.equal(state.has('60:node-down'), false, 'Alive ends it');
  // A start death waiting: an Unknown tick 20 min in does not restart its dwell.
  const span = [{ from: T - MIN, to: T - MIN }];
  const w: SymptomState = new Map();
  assert.equal(run(w, flirs(), span, T, 19.5).first, null);
  detectSymptoms(input(T + 20 * MIN, [node(1), flirs(NodeStatus.Unknown)()], span), w);
  assert.equal(w.get('60:node-down')?.since, T, 'the onset is kept');
  assert.equal(run(w, flirs(), span, T + 20.5 * MIN, 75).first, 69.5, 'raised at onset + 90 min');
});

test('node-down (v0.79.3): a start death stays one — a later driver restart cannot shorten its 90-minute dwell', () => {
  const st: SymptomState = new Map();
  assert.equal(run(st, flirs(), [{ from: T, to: T + MIN }], T + 2 * MIN, 22).first, null, 'a start death under restart A');
  // Restart B is now the only one known (in memory, or after a deploy that carried only B).
  assert.equal(run(st, flirs(), [{ from: T + 25 * MIN, to: T + 26 * MIN }], T + 24.5 * MIN, 70).first, 67.5, 'raised at onset + 90 min');
});

test('node-down (v0.79.5): the host\'s boot is judged at a death\'s first reading only — a forward clock step during its 5-minute dwell does not make a real outage a start death', () => {
  // Uptime runs in true time. The wall clock is 1 min behind it until a step
  // 1 min into a death first read 10.5 min after the boot. The boot span is
  // now − uptime on every tick, as driverStarts() gives it, so after the step
  // it sits 9.5 min before the onset, inside the window.
  const behind = MIN;
  const deadAt = 10.5 * MIN;
  const onset = T + deadAt - behind;
  const state: SymptomState = new Map();
  let raised: number | null = null;
  for (let up = deadAt; up <= deadAt + 100 * MIN && raised == null; up += TICK) {
    const wall = T + up - (up < deadAt + MIN ? behind : 0);
    const boot = wall - up;
    const out = detectSymptoms(input(wall, [node(1), flirs()()], [{ from: boot, to: boot, boot: true }]), state);
    if (out.some((s) => s.kind === 'node-down' && s.nodeId === 60)) raised = (wall - onset) / MIN;
  }
  assert.equal(raised, 5, 'raised at its 5-minute dwell (0.79.3 and 0.79.4: 90)');
  assert.equal(state.get('60:node-down')?.start, undefined, 'never judged a start death');
  // A marked boot is still judged at the first reading: a death first read 2
  // min after it waits 90 min, not 5.
  assert.equal(run(new Map(), flirs(), [{ from: T - MIN, to: T - MIN, boot: true }], T + MIN, 95).first, 90, 'a death 2 min after a marked boot is a start death');
});

test('node-down (v0.79.5): a driver restart span is still judged on every tick — a death first read while the link is down is a start death once the re-handshake sets the span', () => {
  const state: SymptomState = new Map();
  const boot: DriverStart = { from: T - 5 * DAY, to: T - 5 * DAY, boot: true };
  // The server ended the link at T; node 60 reads Dead from T + 1 min, and the
  // re-handshake at T + 3 min sets the span {T, T + 3 min}.
  assert.equal(run(state, flirs(), [boot], T + MIN, 1.5).first, null, 'link down: no span yet');
  assert.equal(run(state, flirs(), [boot, { from: T, to: T + 3 * MIN }], T + 3 * MIN, 90).first, 88, 'raised at onset + 90 min, not 5');
});

test('node-down carry (v0.79.3): the start verdict is carried — a waiting start death seeded with no start known still waits 90 min from its onset', () => {
  const before: SymptomState = new Map();
  run(before, flirs(), [{ from: T - MIN, to: T - MIN }], T, 10);
  const carried = nodeDownCarry(before);
  assert.deepEqual(carried, [{ nodeId: 60, since: T, latched: false, start: true }]);
  const after: SymptomState = new Map();
  seedNodeDown(after, carried, () => true, T + 12 * MIN);
  assert.equal(run(after, flirs(), [], T + 12 * MIN, 80).first, 78);
});

test('node-down carry (v0.79.5): a carried dwell is not judged against the boot again — its first reading was in the run that saved it, so a clock step across the deploy does not make it a start death', () => {
  // Saved waiting at T, 30 min after the boot. The wall clock then steps 25
  // min ahead of uptime across the deploy, so now − uptime reads 5 min before
  // the onset.
  const after: SymptomState = new Map();
  seedNodeDown(after, [{ nodeId: 60, since: T, latched: false, start: false }], () => true, T + 2 * MIN);
  const boot: DriverStart = { from: T - 5 * MIN, to: T - 5 * MIN, boot: true };
  assert.equal(run(after, flirs(), [boot], T + 2 * MIN, 10).first, 3, 'raised at onset + 5 min (0.79.4: 90)');
});

test('seedNodeDown (v0.79.3): a raised node-down whose since is ahead of the clock is raised on the first tick, dated from the restart', () => {
  const s: SymptomState = new Map();
  seedNodeDown(s, [{ nodeId: 60, since: T + 10 * MIN, latched: true, start: false }], () => true, T);
  const r = run(s, flirs(), [], T, 1);
  assert.equal(r.first, 0);
  assert.equal(r.since, T);
});

test('nodeDownCarry (v0.79.5): while running, a dwell still on its 5-minute dwell is left out; raised ones and start deaths are kept', () => {
  const s: SymptomState = new Map();
  s.set('7:node-down', { since: T - 2 * MIN, lastSeen: T, hits: 4 });
  s.set('8:node-down', { since: T - DAY, lastSeen: T, hits: 9, latched: true });
  s.set('9:node-down', { since: T - 20 * MIN, lastSeen: T, hits: 40, start: true });
  assert.deepEqual(nodeDownCarry(s, false).map((c) => c.nodeId).sort(), [8, 9], 'what a flush or a prompt save writes');
  assert.deepEqual(nodeDownCarry(s, true).map((c) => c.nodeId).sort(), [7, 8, 9], 'what the shutdown save writes');
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
  nodeDown: [{ nodeId: 60, since: T - DAY, latched: true, start: false }, { nodeId: 61, since: T - 2 * MIN, latched: false, start: true }],
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
    assert.deepEqual(file.nodeDown, { 60: { s: T - DAY, l: 1 }, 61: { s: T - 2 * MIN, st: 1 } });
    assert.deepEqual(file.driverStart, { f: T - 20 * MIN, t: T - 19 * MIN });
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + MIN, uptimeMs: () => UP + MIN });
    b.load();
    b.bindHomeId(42);
    assert.deepEqual(b.takeCarry(), { ...CARRY, homeId: 42 }, 'same boot: all of it, with the network it belongs to');
    assert.equal(b.takeCarry(), null, 'once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): on another boot only the raised node-down dwells load, and no driver restart — under boot grace and from an old file too', () => {
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
    // 61 was still waiting: it began before this boot's own driver start.
    assert.deepEqual(b.takeCarry(), { homeId: null, nodeDown: [CARRY.nodeDown[0]], driverStart: null }, 'under boot grace');
    // The same file read 3 hours on (past the fine ring's 60-min age).
    const c = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T + 3 * 60 * MIN, uptimeMs: () => 40_000, bootGraceMs: 180_000 });
    c.load();
    assert.deepEqual(c.takeCarry(), { homeId: null, nodeDown: [CARRY.nodeDown[0]], driverStart: null }, 'from an old file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): a save before the engine takes the carry writes it back; after, it writes the engine\'s; another network drops it', () => {
  const { dir, path } = freshPath();
  try {
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => CARRY });
    a.load(); a.bindHomeId(42); a.record(6, stats(), NodeStatus.Alive); a.save();
    const mine: EvidenceCarry = { nodeDown: [{ nodeId: 63, since: T, latched: true, start: false }], driverStart: null };
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
    carry = { ...CARRY, nodeDown: [...CARRY.nodeDown].reverse() };
    mark(); b.save();
    assert.equal(marked(), true, 'the same dwells in another order: nothing written');
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

test('evidence carry (v0.79.3): a carry for another network than the store\'s is not written', () => {
  const { dir, path } = freshPath();
  try {
    let carry: EvidenceCarry = { ...CARRY, homeId: 7 };
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => carry });
    a.load(); a.bindHomeId(42); a.takeCarry(); a.record(6, stats(), NodeStatus.Alive); a.save();
    let file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(file.nodeDown, undefined, 'the engine still holds network 7\'s state');
    assert.equal(file.driverStart, undefined);
    carry = { ...CARRY, homeId: 42 };
    a.save();
    file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(file.nodeDown as object).sort(), ['60', '61']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.3): malformed entries are skipped, an inverted span is not a start', () => {
  const { dir, path } = freshPath();
  try {
    const bad = { nodeDown: [{ nodeId: 0, since: T, latched: true, start: false }, { nodeId: 5, since: -1, latched: true, start: false }, { nodeId: 6, since: T, latched: false, start: false }], driverStart: { from: T, to: T - MIN }, driverDrop: -1 };
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP, carry: () => bad });
    a.load(); a.record(6, stats(), NodeStatus.Alive); a.save();
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => T, uptimeMs: () => UP });
    b.load();
    assert.equal(b.carriedDriverDrop(), null, 'a drop before the epoch is no drop');
    assert.deepEqual(b.takeCarry(), { homeId: null, nodeDown: [{ nodeId: 6, since: T, latched: false, start: false }], driverStart: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.5): an open driver drop is written at every save and written back until taken; it loads on the same boot within DRIVER_DROP_CARRY_MS of the save, not later, not on another boot', () => {
  const { dir, path } = freshPath();
  try {
    assert.equal(DRIVER_DROP_CARRY_MS, NODE_DOWN_START_WINDOW_MS, 'one window');
    let t = T; let up = UP;
    const drop = T - 30_000;
    const read = (): { driverDrop?: number; savedAt: number } => JSON.parse(readFileSync(path, 'utf8')) as { driverDrop?: number; savedAt: number };
    const a = createEvidenceStore({ path, cadenceMs: 10_000, now: () => t, uptimeMs: () => up, carry: () => ({ ...CARRY, driverDrop: drop }) });
    a.load(); a.takeCarry(); a.record(6, stats(), NodeStatus.Alive); a.save();
    assert.equal(read().driverDrop, drop);
    t += 5 * MIN; up += 5 * MIN;
    a.save(); // no sample and the same carry: written anyway while the drop is open
    assert.equal(read().savedAt, t, 'the save time follows the open drop, so it is the stop');
    const at = (dt: number, upNow = up + dt) => { const s = createEvidenceStore({ path, cadenceMs: 10_000, now: () => t + dt, uptimeMs: () => upNow }); s.load(); return s; };
    const b = at(9 * MIN);
    assert.equal(b.carriedDriverDrop(), drop, 'down 9 minutes: carried');
    assert.equal(at(11 * MIN).carriedDriverDrop(), null, 'down 11 minutes: not carried');
    assert.equal(at(MIN, 40_000).carriedDriverDrop(), null, 'another boot: not carried');
    // Until the engine takes the carry the drop written is the driver client's:
    // seeded with the restored one, it ends it at its first handshake.
    let liveDrop: number | null = drop;
    let liveStart: { from: number; to: number } | null = null;
    const c = createEvidenceStore({ path, cadenceMs: 10_000, now: () => t + MIN, uptimeMs: () => up + MIN, carry: () => ({ nodeDown: [], driverStart: liveStart, driverDrop: liveDrop }) });
    c.load(); c.save();
    assert.equal(read().driverDrop, drop, 'not yet taken, the client still holds it: written');
    assert.equal(read().savedAt, t + MIN, 'with this save\'s time');
    liveDrop = null; liveStart = { from: drop, to: t + MIN };
    c.save();
    const back = JSON.parse(readFileSync(path, 'utf8')) as { driverDrop?: number; driverStart?: { f: number; t: number }; nodeDown?: Record<string, unknown> };
    assert.equal(back.driverDrop, undefined, 'the client ended it at its handshake: not written back as open');
    assert.deepEqual(back.driverStart, { f: drop, t: t + MIN }, 'the span the handshake closed it into');
    assert.deepEqual(Object.keys(back.nodeDown ?? {}).sort(), CARRY.nodeDown.map((d) => String(d.nodeId)).sort(), 'the dwells still the restored ones');
    c.takeCarry(); c.record(6, stats(), NodeStatus.Alive); c.save();
    assert.equal(read().driverDrop, undefined, 'taken: the engine\'s, closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evidence carry (v0.79.5): a save the open driver drop forces before the home id is bound keeps the tag the file was loaded with — the next run on another network still discards the old network\'s evidence and node-down', () => {
  const { dir, path } = freshPath();
  try {
    const A = 3586281591;
    const B = A + 1;
    let t = T; let up = UP;
    const drop = T - 30_000;
    const read = (): { homeId: number | null; savedAt: number; nodeDown?: Record<string, unknown> } =>
      JSON.parse(readFileSync(path, 'utf8')) as { homeId: number | null; savedAt: number; nodeDown?: Record<string, unknown> };
    // Run 1, bound to A: node 60 raised, and the server ended the driver link.
    const a = createEvidenceStore({
      path, cadenceMs: 10_000, now: () => t, uptimeMs: () => up,
      carry: () => ({ homeId: A, nodeDown: [{ nodeId: 60, since: T - 10 * MIN, latched: true, start: false }], driverStart: null, driverDrop: drop }),
    });
    a.load(); a.bindHomeId(A); a.takeCarry();
    a.record(60, stats(), NodeStatus.Dead); a.save();
    const f1 = read();
    assert.equal(f1.homeId, A, 'precondition: tagged A');
    t += MIN; up += MIN;
    // Run 2 never binds (HA's zwave_js not loaded). The driver client holds
    // the carried drop, so its save is forced past the dirty gate.
    let clientDrop: number | null = null;
    const b = createEvidenceStore({ path, cadenceMs: 10_000, now: () => t, uptimeMs: () => up, carry: () => ({ homeId: null, nodeDown: [], driverStart: null, driverDrop: clientDrop }) });
    b.load();
    clientDrop = b.carriedDriverDrop();
    assert.equal(clientDrop, drop, 'precondition: the drop is carried');
    b.save();
    const f2 = read();
    assert.ok(f2.savedAt > f1.savedAt, 'precondition: run 2 wrote the file');
    assert.ok(f2.nodeDown?.['60'] != null, 'precondition: with run 1\'s node-down');
    assert.equal(f2.homeId, A, 'the tag the file was loaded with, not null');
    t += MIN; up += MIN;
    // Run 3 binds another network.
    const logs: string[] = [];
    const c = createEvidenceStore({ path, cadenceMs: 10_000, now: () => t, uptimeMs: () => up, log: (m: string) => { logs.push(m); } });
    c.load();
    assert.ok(c.forNode(60).length > 0, 'precondition: restored while the identity is unknown');
    c.bindHomeId(B);
    assert.ok(logs.some((l) => l.includes('controller home id changed — discarding evidence for the previous network')), logs.join('\n'));
    assert.equal(c.forNode(60).length, 0, 'network A\'s evidence is not network B\'s');
    assert.equal(c.coverage(60), null);
    assert.equal(c.takeCarry(), null, 'nor its node-down');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Production-wired: createZwaveData restarted over one evidence file ───── */

const ENTRY = 'entry-1';
const HOME = 3586281591;
/** `down`: HA's zwave_js reports no network (the entry not loaded), so no home id is bound. */
function fakeHa(roster: Array<Record<string, unknown>>, home: () => number = () => HOME, down: () => boolean = () => false): HaWsClient & { fireReady(): void } {
  const readyCbs: Array<() => void> = [];
  const result = (cmd: Record<string, unknown>): unknown => {
    switch (cmd.type) {
      case 'config_entries/get': return [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }];
      case 'config/device_registry/list': return [];
      case 'config/entity_registry/list': return [];
      case 'get_states': return [];
      case 'zwave_js/network_status':
        if (down()) throw new Error('not_loaded');
        return { client: { server_version: 't' }, controller: { home_id: home(), own_node_id: 1, nodes: roster } };
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
/** `why`: what the failure message carries besides the timeout. */
async function waitFor(cond: () => boolean, ms = 8000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
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
/** Every run started and not yet stopped, registered the moment it starts (a
 *  failure in startRun's own waits included): a test's finally stops them all,
 *  so a failing assertion cannot leave a live client holding the server open. */
const live = new Set<() => void>();
function stopAll(): void {
  for (const stop of [...live]) stop();
}
/** `bootAt` null: production's own uptime source. `awaitReady` false: return
 *  as soon as it is started, without waiting for the driver link or the roster. */
async function startRun(dir: string, url: string, bootAt: number | null, logs: string[] = [], o: { roster?: Array<Record<string, unknown>>; uptimeMs?: () => number; home?: () => number; down?: () => boolean; awaitReady?: boolean; extra?: Partial<ZwaveDataOptions> } = {}): Promise<Run> {
  const roster = o.roster ?? ROSTER;
  const ha = fakeHa(roster, o.home, o.down);
  const uptimeMs = o.uptimeMs ?? (bootAt == null ? undefined : () => Date.now() - bootAt);
  const opts: ZwaveDataOptions = {
    client: ha, entryId: ENTRY, refreshMs: 100, routePollMs: 60_000, evidenceSampleMs: 30 * MIN,
    historyPath: null, evidencePath: join(dir, 'evidence.json'), baselinesPath: join(dir, 'baselines.json'),
    outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: url, log: (m: string) => { logs.push(m); },
    ...(uptimeMs ? { uptimeMs } : {}),
    ...(o.extra ?? {}),
  };
  const zd = createZwaveData(opts);
  let stopProvider: (() => void) | null = null;
  const stop = (): void => {
    if (!live.delete(stop)) return;
    stopProvider?.();
    zd.stop();
  };
  live.add(stop);
  zd.start();
  ha.fireReady();
  if (o.awaitReady !== false) {
    // The first handshake and the dump after it, under a loaded suite: room
    // for one 5 s reconnect backoff, and what the link did if they never come.
    // `logs` holds the run's lines whether or not the caller passed an array.
    const linkLog = () => `driver link ${zd.driverWsState()}; ${logs.filter((l) => l.startsWith('driver-ws:')).join(' | ') || 'no driver-ws: lines'}`;
    await waitFor(() => zd.driverWsState() === 'live', 15_000, linkLog);
    const want = roster.find((n) => n.node_id === 60)!.status === 3 ? NodeStatus.Dead : NodeStatus.Alive;
    await waitFor(() => zd.snapshot().some((n) => n.nodeId === 60 && n.status === want && n.isListening === false), 15_000, linkLog);
  }
  const priv = zd as unknown as { lastOkAt: number | null; sampleEvidence: () => void };
  const tdp = createTuiDataProvider({ zwaveData: buildZwaveDataSource(zd as never), refreshMs: 60_000, log: () => {} } as never);
  const provider = tdp.provider;
  stopProvider = tdp.stop;
  return {
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
    stop,
  };
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
    assert.equal(b.zd.engineStatus().ran, false, 'before its first tick the engine has not run: Home Assistant is sent nothing yet');
    assert.equal(b.tick(), true, 'raised on the next run\'s first tick');
    assert.equal(b.zd.engineStatus().ran, true);
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
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { nodeDown?: Record<string, { l?: number; st?: number }> };
    assert.deepEqual(file.nodeDown?.['60'] && { l: file.nodeDown['60'].l, st: file.nodeDown['60'].st }, { l: 1, st: 1 }, 'raised: on disk at once, so a power cut and a reboot keep it');
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
    assert.deepEqual(starts[1], { from: starts[1]!.from, to: starts[1]!.to }, 'a restart is not marked as the boot: it is judged on every tick');
    assert.ok(logs.some((l) => /the link ended \d+s ago, not by this add-on, and is back — a driver start/.test(l)));
    a.tick();
    const early = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { driverStart?: { f: number; t: number } };
    assert.deepEqual(early.driverStart, { f: starts[1]!.from, t: starts[1]!.to }, 'on disk at the next tick, before any stop or flush');
    a.stop();
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { driverStart?: { f: number; t: number } };
    assert.deepEqual(file.driverStart, { f: starts[1]!.from, t: starts[1]!.to });
    skip += 2 * MIN; // the host's uptime runs on with its clock
    const b = await startRun(dir, srv.url, bootAt);
    b.tick();
    assert.deepEqual(b.zd.driverStarts().slice(1), [{ from: starts[1]!.from, to: starts[1]!.to }], 'the next run on this boot knows it, unmarked');
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

test('restart (v0.79.3, production-wired): a start death is judged at its first reading — a wall clock that then jumps ahead of uptime does not cut its 90 minutes', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    // A host up 40 s whose uptime runs in real time while the wall clock steps
    // ahead 30 s a tick (as an NTP step does on a host without a clock
    // battery): within two ticks now - uptime slides past the death's onset,
    // and only the verdict taken at its first reading keeps the 90 minutes.
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

test('restart (v0.79.3, production-wired): a death first seen after the wall clock jumped ahead of uptime is judged on uptime — 1 min after the boot it is a start death', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
  try {
    // Uptime runs in real time; the wall clock is 12.5 min ahead of it by the
    // time node 60 first reads Dead. A boot fixed at the first tick would put
    // that death 13 min after the boot and dwell 5 min.
    const r0 = realNow();
    const r = await startRun(dir, srv.url, null, [], { roster, uptimeMs: () => 40_000 + (realNow() - r0) });
    assert.equal(ticksTo(r, 12), null, 'Alive while the clock runs ahead');
    roster.find((n) => n.node_id === 60)!.status = 3;
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Dead));
    assert.equal(ticksTo(r, 95), 90);
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a forward clock step during a death\'s 5-minute dwell does not make it a start death — the boot was judged at its first reading', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    // Uptime runs in true time and is 10.5 min at the start; the wall clock is
    // 1 min behind it until NTP steps it forward 1 min into node 60's death.
    // After the step now − uptime sits 9.5 min before the death's onset.
    let lag = MIN;
    const trueBoot = Date.now() + lag - 10.5 * MIN;
    const r = await startRun(dir, srv.url, null, [], { uptimeMs: () => Date.now() + lag - trueBoot });
    let first: number | null = null;
    for (let i = 0; i <= 95 * 2 && first == null; i++) {
      if (i === 2) { skip += lag; lag = 0; } // the step, after 1 min of ticks
      if (r.tick()) first = i / 2;
    }
    assert.equal(first, 4, 'raised at its 5-minute dwell: 4 min of ticks and the 1-min step (0.79.3 and 0.79.4: 89)');
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
    assert.ok(Math.abs(boot.to - (Date.now() - osUptime() * 1000)) < 3000, `${boot.to} vs ${Date.now() - osUptime() * 1000}`);
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): across a host reboot a start death still waiting starts again inside the new boot\'s window — no alarm at the reboot', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    const a = await startRun(dir, srv.url, Date.now() - 40_000);
    assert.equal(ticksTo(a, 30), null, 'precondition: a start death at boot 1, waiting');
    const saved = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { nodeDown?: Record<string, { st?: number }> };
    assert.equal(saved.nodeDown?.['60']?.st, 1, 'the start death is on disk before any stop or flush');
    a.stop();
    skip += 5 * MIN;
    // The host restarted: up 40 s again.
    const b = await startRun(dir, srv.url, Date.now() - 40_000);
    assert.equal(ticksTo(b, 95), 90, 'waits 90 min from its first reading on the new boot');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a raised node-down reaches disk at once and outlives a host reboot — raised again on the new boot\'s first tick', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  try {
    const a = await startRun(dir, srv.url, Date.now() - 5 * DAY);
    assert.equal(ticksTo(a, 10), 5, 'precondition: raised at 5 min');
    // Before any stop or flush: a power cut now would not lose it.
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { nodeDown?: Record<string, { l?: number }> };
    assert.equal(file.nodeDown?.['60']?.l, 1, 'saved when it was raised');
    a.stop();
    skip += 5 * MIN;
    const b = await startRun(dir, srv.url, Date.now() - 40_000); // rebooted
    assert.equal(b.tick(), true, 'raised on the first tick of the new boot');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a change of network while running does not write the old network\'s node-down under the new one', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  let home = HOME;
  try {
    const r = await startRun(dir, srv.url, Date.now() - 5 * DAY, [], { home: () => home });
    assert.equal(ticksTo(r, 10), 5, 'precondition: raised on network 1');
    const path = join(dir, 'evidence.json');
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> }).nodeDown?.['60'] != null, true);
    home = HOME + 1; // the controller was swapped: another network
    await waitFor(() => (JSON.parse(readFileSync(path, 'utf8')) as { homeId?: number }).homeId === HOME + 1);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> };
    assert.deepEqual(Object.keys(file.nodeDown ?? {}), [], 'the reset wrote no carry of network 1');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a carried node-down that ends on the first tick is saved at once — a power cut cannot bring the stale latch back', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  try {
    const a = await startRun(dir, srv.url, bootAt);
    assert.equal(ticksTo(a, 10), 5, 'precondition: raised');
    a.stop();
    skip += MIN;
    // The node came back while the add-on was down.
    const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
    const b = await startRun(dir, srv.url, bootAt, [], { roster });
    assert.equal(b.tick(), false, 'Alive: the carried node-down is dropped');
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { nodeDown?: Record<string, unknown> };
    assert.equal(file.nodeDown?.['60'], undefined, 'and that is on disk before any stop or flush');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): the prompt save is spaced a minute apart — a flapping start death does not rewrite the store every tick', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => ({ ...n }));
  const path = join(dir, 'evidence.json');
  const has60 = (): boolean => (JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> }).nodeDown?.['60'] != null;
  try {
    const r = await startRun(dir, srv.url, Date.now() - 40_000, [], { roster });
    r.tick(); // a start death: saved at once
    assert.equal(has60(), true);
    roster.find((n) => n.node_id === 60)!.status = 4;
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Alive));
    r.tick(); // 30 s later: it ended, but the last save was under a minute ago
    assert.equal(has60(), true, 'not saved again within the minute');
    r.tick(); // a minute after the save
    assert.equal(has60(), false, 'saved once the minute is up');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a dwell still on its 5-minute dwell is not written while running — a crash restart after it ended does not bring it back', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => ({ ...n }));
  const path = join(dir, 'evidence.json');
  const bootAt = Date.now() - 5 * DAY; // no start window: the 5-minute dwell
  try {
    const a = await startRun(dir, srv.url, bootAt, [], { roster });
    for (let i = 0; i < 6; i++) assert.equal(a.tick(), false, 'precondition: still waiting');
    (a.zd as unknown as { evidenceStore: { save(): void } }).evidenceStore.save(); // the 15-minute flush lands here
    const flushed = JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> };
    assert.equal(flushed.nodeDown?.['60'], undefined, 'the flush does not write it');
    roster.find((n) => n.node_id === 60)!.status = 4;
    await waitFor(() => a.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Alive));
    assert.equal(a.tick(), false, 'it ended');
    const atCrash = readFileSync(path); // the disk as a crash leaves it: no shutdown save
    a.stop();
    writeFileSync(path, atCrash);
    skip += 2 * MIN; // s6 restarts the process; the death is now 5.5 min behind
    roster.find((n) => n.node_id === 60)!.status = 3; // and the node dies again
    const b = await startRun(dir, srv.url, bootAt, [], { roster });
    assert.equal(b.tick(), false, 'the new death is not raised at once with the old onset');
    assert.equal(ticksTo(b, 10), 4.5, 'it waits its own 5 minutes');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a deploy during a 5-minute dwell keeps its onset, and the next run\'s first tick takes it off the disk', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const path = join(dir, 'evidence.json');
  const bootAt = Date.now() - 5 * DAY;
  try {
    const a = await startRun(dir, srv.url, bootAt);
    for (let i = 0; i < 6; i++) assert.equal(a.tick(), false, 'precondition: still waiting');
    a.stop(); // SIGTERM: the shutdown save writes the waiting dwell
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, { l?: number; st?: number }> };
    assert.deepEqual(saved.nodeDown?.['60'] && { l: saved.nodeDown['60'].l, st: saved.nodeDown['60'].st }, { l: undefined, st: undefined }, 'written at the stop, neither raised nor a start death');
    skip += MIN;
    const b = await startRun(dir, srv.url, bootAt);
    assert.equal(b.tick(), false, '4 min after its onset');
    const after = JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> };
    assert.equal(after.nodeDown?.['60'], undefined, 'off the disk at the first tick, so a crash from here cannot bring it back');
    assert.equal(ticksTo(b, 10), 0.5, 'raised 5 min after its own onset, not 5 min after the deploy');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): the first tick\'s write-out of a deploy\'s carry does not start the minute — a raise right after it reaches disk at once', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const path = join(dir, 'evidence.json');
  const nd = (): Record<string, { l?: number }> => (JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, { l?: number }> }).nodeDown ?? {};
  const bootAt = Date.now() - 5 * DAY;
  try {
    const a = await startRun(dir, srv.url, bootAt);
    for (let i = 0; i < 8; i++) assert.equal(a.tick(), false, 'precondition: still waiting'); // onset + 4 min
    a.stop(); // a deploy: the shutdown save writes the waiting dwell
    skip += 30_000;
    const b = await startRun(dir, srv.url, bootAt);
    assert.equal(b.tick(), false, '4.5 min after its onset');
    assert.equal(nd()['60'], undefined, 'written out at the first tick');
    assert.equal(b.tick(), true, 'raised at onset + 5 min, 30 s after the write-out');
    assert.equal(nd()['60']?.l, 1, 'and on disk at once, not a minute after the write-out');
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): the prompt save is spaced on the host\'s uptime — a wall clock stepped back right after a save does not hold the next one off', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => ({ ...n }));
  const path = join(dir, 'evidence.json');
  const has60 = (): boolean => (JSON.parse(readFileSync(path, 'utf8')) as { nodeDown?: Record<string, unknown> }).nodeDown?.['60'] != null;
  let up = 40_000; // the host's uptime: moved by hand, a tick at a time; it never steps
  try {
    const r = await startRun(dir, srv.url, null, [], { roster, uptimeMs: () => up });
    r.tick(); up += TICK; // a start death at boot + 40 s: saved at once
    assert.equal(has60(), true);
    skip -= 10 * MIN; // NTP steps the wall clock back 10 minutes
    roster.find((n) => n.node_id === 60)!.status = 4;
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Alive));
    r.tick(); up += TICK; // 30 s of uptime later: it ended, but the last save was under a minute ago
    assert.equal(has60(), true, 'not saved again within the minute');
    r.tick(); up += TICK; // a minute of uptime after the save, 9 minutes behind it on the wall clock
    assert.equal(has60(), false, 'saved once the minute of uptime is up');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.3, production-wired): a node that left the network takes its dwells with it — a device reusing the id is not raised while it reads Unknown', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => ({ ...n }));
  try {
    const logs: string[] = [];
    const r = await startRun(dir, srv.url, Date.now() - 5 * DAY, logs, { roster, extra: { evictAfterMs: 1 } });
    assert.equal(ticksTo(r, 10), 5, 'precondition: raised');
    const i = roster.findIndex((n) => n.node_id === 60);
    const [gone] = roster.splice(i, 1);
    await waitFor(() => !r.zd.snapshot().some((n) => n.nodeId === 60));
    // Two roster polls, missing then evicted: waited on, not timed, as a
    // loaded host can run fewer polls than the clock allows.
    await waitFor(() => logs.some((l) => l.startsWith('node 60 left the network')), 8000, () => logs.join(' | '));
    roster.push({ ...gone!, status: 0 }); // the id comes back, as a new device being interviewed
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Unknown));
    assert.equal(r.tick(), false, 'no node-down for the new device');
    r.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a deploy while Z-Wave JS is down carries the link the server ended — the next run\'s first handshake is a driver start, and a FLiRS death at it waits 90 min, not 5', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
  const path = join(dir, 'evidence.json');
  try {
    const a = await startRun(dir, srv.url, bootAt, [], { roster });
    a.tick();
    const dropAt = Date.now();
    srv.dropClient(); // Z-Wave JS goes down
    await waitFor(() => a.zd.driverWsState() === 'backoff');
    a.stop(); // the deploy, before it is back
    const file = JSON.parse(readFileSync(path, 'utf8')) as { driverDrop?: number; savedAt: number; driverStart?: unknown };
    assert.ok(file.driverDrop != null && file.driverDrop >= dropAt && file.driverDrop <= file.savedAt, `the open drop is on disk: ${file.driverDrop}`);
    assert.equal(file.driverStart, undefined, 'and no closed span yet');
    skip += MIN;
    // Still down when the next run starts, back at its first retry; node 60
    // then reads Dead: a FLiRS start death.
    srv.configure({ dropBeforeVersion: 1 });
    roster.find((n) => n.node_id === 60)!.status = 3;
    const logs: string[] = [];
    const b = await startRun(dir, srv.url, bootAt, logs, { roster });
    const starts = b.zd.driverStarts();
    assert.equal(starts.length, 2, JSON.stringify(starts));
    assert.equal(starts[1]!.from, file.driverDrop, 'from the drop the previous run saw');
    assert.ok(starts[1]!.to > file.savedAt + MIN, 'to this run\'s first handshake');
    assert.ok(logs.some((l) => /had not come back when this add-on stopped/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /the link ended \d+s ago, not by this add-on, and is back — a driver start/.test(l)));
    assert.equal(ticksTo(b, 95), 90, 'a start death: 90 minutes');
    b.stop();
    const after = JSON.parse(readFileSync(path, 'utf8')) as { driverDrop?: number; driverStart?: { f: number; t: number } };
    assert.equal(after.driverDrop, undefined, 'closed: no longer open');
    assert.deepEqual(after.driverStart, { f: starts[1]!.from, t: starts[1]!.to }, 'carried on as the restart it was');
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a link the server ended is not carried past DRIVER_DROP_CARRY_MS of the add-on being down — the next run\'s own first handshake is no driver start', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
  try {
    const a = await startRun(dir, srv.url, bootAt, [], { roster });
    a.tick();
    srv.dropClient();
    await waitFor(() => a.zd.driverWsState() === 'backoff');
    a.stop();
    skip += DRIVER_DROP_CARRY_MS + MIN; // down 11 minutes
    roster.find((n) => n.node_id === 60)!.status = 3;
    const b = await startRun(dir, srv.url, bootAt, [], { roster });
    assert.equal(b.zd.driverStarts().length, 1, 'only the boot');
    assert.equal(ticksTo(b, 10), 5);
    b.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a run that ended the carried drop at its handshake and is stopped before its first engine tick writes the span, not the drop as open', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
  const path = join(dir, 'evidence.json');
  try {
    const a = await startRun(dir, srv.url, bootAt, [], { roster });
    a.tick();
    srv.dropClient();
    await waitFor(() => a.zd.driverWsState() === 'backoff');
    a.stop();
    const drop = (JSON.parse(readFileSync(path, 'utf8')) as { driverDrop: number }).driverDrop;
    skip += MIN;
    const b = await startRun(dir, srv.url, bootAt, [], { roster });
    const span = b.zd.driverStarts()[1]!;
    assert.equal(span.from, drop);
    skip += 30 * MIN; // HA's roster stale: no engine tick in this run
    b.stop();
    const file = JSON.parse(readFileSync(path, 'utf8')) as { driverDrop?: number; driverStart?: { f: number; t: number } };
    assert.equal(file.driverDrop, undefined, 'ended at the handshake: not written back as open');
    assert.deepEqual(file.driverStart, { f: span.from, t: span.to }, 'the span the handshake closed');
    skip += MIN;
    roster.find((n) => n.node_id === 60)!.status = 3;
    const c = await startRun(dir, srv.url, bootAt, [], { roster });
    assert.equal(c.zd.driverStarts().length, 1, 'no drop carried');
    assert.equal(ticksTo(c, 95), 5, 'the driver started 32 minutes before: the 5-minute dwell');
    c.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart (v0.79.5, production-wired): a run that never binds a home id and is stopped with the driver link still down keeps the file\'s tag — the next run on another network discards the old evidence and does not raise its node-down', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const bootAt = Date.now() - 5 * DAY;
  const path = join(dir, 'evidence.json');
  type File = { homeId: number | null; savedAt: number; driverDrop?: number; nodeDown?: Record<string, unknown> };
  const read = (): File => JSON.parse(readFileSync(path, 'utf8')) as File;
  try {
    const a = await startRun(dir, srv.url, bootAt);
    assert.equal(ticksTo(a, 10), 5, 'precondition: node 60 raised on network HOME');
    srv.configure({ dropBeforeVersion: 1000 }); // Z-Wave JS goes down and stays down
    srv.dropClient();
    await waitFor(() => a.zd.driverWsState() === 'backoff');
    a.stop();
    const f1 = read();
    assert.equal(f1.homeId, HOME, 'precondition: tagged HOME');
    skip += MIN;
    // Restarted within DRIVER_DROP_CARRY_MS; HA's zwave_js reports no network
    // for the whole run, so no home id is bound.
    const logsB: string[] = [];
    const b = await startRun(dir, srv.url, bootAt, logsB, { down: () => true, awaitReady: false });
    await waitFor(() => logsB.some((l) => /driver-ws: a link the server ended/.test(l)));
    await sleep(500);
    b.stop();
    const f2 = read();
    assert.ok(f2.savedAt > f1.savedAt, 'precondition: the open drop forced the stop\'s save');
    assert.ok(f2.driverDrop != null && f2.nodeDown?.['60'] != null, `precondition: the drop and node 60's node-down written back: ${JSON.stringify(f2)}`);
    assert.equal(f2.homeId, HOME, 'the tag the file was loaded with, not null');
    skip += MIN;
    // A controller with another network comes up; its node 60 reads Dead.
    srv.configure({ dropBeforeVersion: 0, homeId: HOME + 1 });
    const logsC: string[] = [];
    const c = await startRun(dir, srv.url, bootAt, logsC, { home: () => HOME + 1 });
    assert.ok(logsC.some((l) => l.includes('evidence: controller home id changed — discarding evidence for the previous network')), logsC.join('\n'));
    assert.equal(c.tick(), false, 'network HOME\'s node-down is not raised on network HOME+1');
    c.stop();
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('driver link (v0.79.5, production-wired): a wedged link the liveness check ends is reconnected and is no driver start — the stamp auto-ping reads moves, a death after it keeps the 5-minute dwell, and a deploy in the backoff carries no drop', async () => {
  const restore = useClock();
  const srv = await mockServer({ nodes: DUMP });
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-wired-'));
  const roster = ROSTER.map((n) => (n.node_id === 60 ? { ...n, status: 4 } : { ...n }));
  try {
    const logs: string[] = [];
    const r = await startRun(dir, srv.url, Date.now() - 5 * DAY, logs, { roster, extra: { driverWsLivenessMs: 800 } });
    const h0 = r.zd.driverReconnectedAt()!;
    srv.stall(); // the server stops answering: no traffic, no pong
    await waitFor(() => logs.some((l) => /no pong\/traffic — terminating wedged socket/.test(l)), 5000);
    // At least 2: a reconnect handshake slower than the 800 ms handshake clock
    // (a loaded host) is ended and retried, and that is this add-on's own end too.
    // That retry's backoff doubles (attempts resets only at live): 5 s, about
    // 1 s of handshake clock, then 10 s. The wait covers one slow retry.
    await waitFor(() => srv.connectionCount() >= 2 && r.zd.driverWsState() === 'live', 25_000);
    assert.ok(r.zd.driverReconnectedAt()! > h0, 'the handshake stamp moves (auto-ping\'s burst refusal)');
    assert.equal(r.zd.driverStarts().length, 1, 'only the boot: a link this add-on ended is no driver start');
    assert.ok(!logs.some((l) => /a driver start for the node-down start window/.test(l)), logs.join('\n'));
    roster.find((n) => n.node_id === 60)!.status = 3;
    await waitFor(() => r.zd.snapshot().some((n) => n.nodeId === 60 && n.status === NodeStatus.Dead));
    assert.equal(ticksTo(r, 10), 5, 'a death after the reconnect keeps the 5-minute dwell');
    // A deploy lands in the backoff. The ticks' clock skip (5.5 min past the
    // link's last traffic) ends the link at the next liveness check, which is
    // this add-on's own teardown; the stall keeps a reply or a pong from
    // moving the idle clock before that check.
    srv.stall();
    await waitFor(() => r.zd.driverWsState() === 'backoff', 5000);
    assert.ok(logs.filter((l) => /no pong\/traffic — terminating wedged socket/.test(l)).length >= 2, 'the liveness check ended the link again');
    r.stop();
    const file = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as { driverDrop?: number };
    assert.equal(file.driverDrop, undefined, 'a link this add-on ended is not carried as a drop');
  } finally {
    stopAll();
    restore();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine status (v0.79.3): with no evidence store the engine never runs, so it reads as run — Home Assistant is not held back for ever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-carry-'));
  try {
    const zd = createZwaveData({
      client: fakeHa(ROSTER), entryId: ENTRY, historyPath: null, evidencePath: null,
      baselinesPath: join(dir, 'baselines.json'), outcomesPath: join(dir, 'outcomes.json'), driverWsUrl: '', log: () => {},
    } as never);
    try {
      const st = zd.engineStatus();
      assert.equal(st.enabled, true);
      assert.equal(st.ran, true);
    } finally {
      zd.stop(); // the constructor arms flush timers: an unstopped instance holds the process open
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
