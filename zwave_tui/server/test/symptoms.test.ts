import type { SleeperWatch } from '../src/zwave/missedReport';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSymptoms, heldSymptoms, windowTimeoutRate, rttRestartResidue, rttFoldResidue, RTT_SEED_MAX_MS, type DetectInput, type Symptom, type SymptomState } from '../src/zwave/symptoms';
import { planEpisodeLifecycle } from '../src/zwave/outcomes';
import { diffSymptomLog } from '../src/zwave/zwaveData';
import type { RateNormal, ContNormal, BaselineStore } from '../src/zwave/baselines';
import { NodeStatus, type NodeSnapshot, type ControllerSnapshot } from '../src/types';
import type { EvidenceSample, CoarseBucket, ControllerSample, NodeCoverage } from '../src/zwave/evidenceStore';
import { foldRateRun, type RateRun, type RttSeed } from '../src/zwave/evidenceStore';

const T = 1_000_000_000_000;
const MIN = 60_000;

function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    nodeId: id, deviceId: 'd' + id, name: `Node ${id}`, area: null, status: NodeStatus.Alive,
    statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
    isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
    battery: null, firmware: null, stats: {} as never, entities: [], ...over,
  };
}

function ev(over: Partial<EvidenceSample> = {}): EvidenceSample {
  return {
    t: T, dTx: 100, dTimeout: 0, dDropTx: 0, dRx: 5, dFlaps: 0, dRouteChanges: 0, dS2Resync: 0, fresh: true,
    rtt: 30, rssi: -60, rateKbps: 100, routeKey: 'direct', status: NodeStatus.Alive,
    lastSeen: null, isListening: null, isFrequentListening: null, ...over,
  };
}

/** A window of samples spanning the last `spanMin` minutes (so windowed rates
 *  see traffic ≥ MIN_WINDOW_TX). */
function window(now: number, spanMin: number, per: Partial<EvidenceSample>): EvidenceSample[] {
  const out: EvidenceSample[] = [];
  for (let m = spanMin; m >= 0; m--) out.push(ev({ ...per, t: now - m * MIN }));
  return out;
}

/** A window whose RTT average MOVES on every sample (v0.78.0), ending at `rtt`
 *  0.1 ms a minute: every sample is a raw reading of about its average, which a
 *  held value never is (evidenceStore.rawRttFrames). */
function risingRtt(now: number, spanMin: number, rtt: number): EvidenceSample[] {
  return window(now, spanMin, { fresh: true }).map((s, i, a) => ({ ...s, rtt: Math.round((rtt - 0.1 * (a.length - 1 - i)) * 10) / 10 }));
}

/** A baseline stub whose normals are fully controllable per test. */
function baselineStub(over: Partial<Record<string, unknown>> = {}): BaselineStore {
  const timeout: RateNormal = { rate: 0.02, trials: 500, ready: true, days: 5 };
  const cont: ContNormal = { median: 30, scale: 8, ready: true, days: 5 };
  return {
    path: '/x', observe() {}, resetNode() {}, reset() {}, load() {}, save() {},
    timeoutNormal: () => (over.timeout as RateNormal) ?? timeout,
    rssiNormal: () => (over.rssi as ContNormal) ?? cont,
    rttNormal: () => (over.rtt as ContNormal) ?? cont,
    ...(over.store as object),
  } as unknown as BaselineStore;
}

interface Fixture {
  nodes: NodeSnapshot[];
  recent: Map<number, EvidenceSample[]>;
  ctrl?: ControllerSample[];
  cov?: Map<number, NodeCoverage>;
  baselines?: BaselineStore;
  controller?: ControllerSnapshot | null;
  now?: number;
  sleeperWatch?: (n: NodeSnapshot) => SleeperWatch | null;
  duplicateBursts?: (id: number) => { at: number; n: number }[];
  rttSeed?: Map<number, RttSeed>;
  /** Whether a confirmation probe can reach the node (v0.78.0); absent = no. */
  confirmable?: boolean;
  /** Collects what the detector asks a confirmation for (v0.78.0). */
  suspects?: { id: number; raw: number }[];
}
function input(f: Fixture): DetectInput {
  return {
    now: f.now ?? T,
    nodes: f.nodes,
    controller: f.controller ?? ({ backgroundRSSI: [] } as unknown as ControllerSnapshot),
    baselines: f.baselines ?? baselineStub(),
    latest: (id) => { const r = f.recent.get(id); return r ? r[r.length - 1] : undefined; },
    recent: (id) => f.recent.get(id) ?? [],
    coarse: () => [] as CoarseBucket[],
    controllerSamples: () => f.ctrl ?? [],
    coverage: (id) => f.cov?.get(id) ?? null,
    rateRun: (id) => (f.recent.get(id) ?? []).reduce<RateRun | null>(foldRateRun, null),
    rttSeed: (id) => f.rttSeed?.get(id) ?? null,
    ...(f.confirmable != null ? { rttConfirmable: () => f.confirmable === true } : {}),
    ...(f.suspects ? { rttSuspect: (id: number, fr: { raw: number }) => { f.suspects!.push({ id, raw: fr.raw }); } } : {}),
    recordingSince: () => T - 30 * 86_400_000,
    sleeperWatch: (n) => f.sleeperWatch?.(n) ?? null,
    duplicateBursts: (id) => f.duplicateBursts?.(id) ?? [],
  };
}

/** Run detect enough times for dwell (>5min) to elapse — the caller advances
 *  `now` so a persistent breach graduates from arming to firing. */
function settle(inp: (now: number) => DetectInput, state: SymptomState, now0: number, minutes: number) {
  let last = detectSymptoms(inp(now0), state);
  for (let m = 1; m <= minutes; m++) last = detectSymptoms(inp(now0 + m * MIN), state);
  return last;
}

test('windowTimeoutRate: Σtimeout/Σtx over valid windows, null below the traffic floor', () => {
  assert.equal(windowTimeoutRate([ev({ dTx: 5, dTimeout: 1 })], T), null); // 5 tx < floor
  const r = windowTimeoutRate(window(T, 10, { dTx: 100, dTimeout: 10 }), T);
  assert.ok(r && Math.abs(r.rate - 0.1) < 0.001);
});

test('return-path-degraded fires only after dwell, when the window rate ≫ baseline', () => {
  const nodes = [node(1), node(6)];
  const recent = new Map([[6, window(T + 6 * MIN, 12, { dTx: 100, dTimeout: 30 })]]); // 30% ≫ 2% base
  const inp = (now: number) => input({ nodes, recent: new Map([[6, window(now, 12, { dTx: 100, dTimeout: 30 })]]), now });
  const state: SymptomState = new Map();
  // First tick: arming, not yet fired.
  assert.equal(detectSymptoms(inp(T), state).filter((s) => s.kind === 'return-path-degraded').length, 0);
  const fired = settle(inp, state, T, 6);
  const rp = fired.find((s) => s.kind === 'return-path-degraded');
  assert.ok(rp, 'fired after >5min dwell');
  assert.equal(rp!.nodeId, 6);
  assert.equal(rp!.basis, 'measured');
  void recent;
});

test('return-path-degraded does NOT fire when the baseline is not yet ready (learning)', () => {
  const nodes = [node(1), node(6)];
  const bl = baselineStub({ timeout: { rate: 0, trials: 0, ready: false, days: 1 } });
  const inp = (now: number) => input({ nodes, recent: new Map([[6, window(now, 12, { dTx: 100, dTimeout: 40 })]]), baselines: bl, now });
  const fired = settle(inp, new Map(), T, 8);
  assert.equal(fired.filter((s) => s.kind === 'return-path-degraded').length, 0, 'no relative anomaly without a learned normal');
});

test('dead-flap fires on ≥3 Alive↔Dead transitions in the window', () => {
  const nodes = [node(1), node(6)];
  const inp = (now: number) => input({ nodes, recent: new Map([[6, window(now, 8, { dFlaps: 1 })]]), now }); // 1 flap/min ⇒ ≫3 in 10m
  const fired = settle(inp, new Map(), T, 6);
  const df = fired.find((s) => s.kind === 'dead-flap');
  assert.ok(df && df.severity === 'crit');
});

test('rate-fallback fires on a same-route REGRESSION (100k→9.6k), not on a capability cap', () => {
  const classic = [node(1), node(6), node(7)];
  const lr = [node(1), node(300, { isLongRange: true, nodeId: 300 })];
  // Node 6: the SAME route 'r7' was seen at 100k earlier in the window, now 9.6k → regression.
  const regressed = (now: number) => {
    const early = window(now, 10, { rateKbps: 100, routeKey: 'r7' }).slice(0, 4);
    const late = window(now, 5, { rateKbps: 9.6, routeKey: 'r7' });
    return [...early, ...late];
  };
  const inpReg = (now: number) => input({ nodes: classic, recent: new Map([[6, regressed(now)]]), now });
  // Node 7: ALWAYS 40k on its route (a 40k-capable device) → capability, NOT a regression.
  const inpCap = (now: number) => input({ nodes: classic, recent: new Map([[7, window(now, 10, { rateKbps: 40, routeKey: 'r9' })]]), now });
  const inpL = (now: number) => input({ nodes: lr, recent: new Map([[300, window(now, 8, { rateKbps: 100, routeKey: 'direct' })]]), now });
  assert.ok(settle(inpReg, new Map(), T, 6).some((s) => s.kind === 'rate-fallback' && s.nodeId === 6), 'regression fires');
  assert.equal(settle(inpCap, new Map(), T, 6).filter((s) => s.kind === 'rate-fallback').length, 0, 'capability cap does NOT fire');
  assert.equal(settle(inpL, new Map(), T, 6).filter((s) => s.kind === 'rate-fallback').length, 0, 'LR never fires');
});

test('weak-signal fires for a DIRECT node with thin margin, NOT for a routed one', () => {
  const nodes = [node(1), node(6), node(7)];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      [6, window(now, 8, { rssi: -92, routeKey: 'direct', dTx: 100, dTimeout: 10 })], // thin margin + timeouts → weak
      [7, window(now, 8, { rssi: -92, routeKey: 'r9', dTx: 100, dTimeout: 10 })], // routed: rssi = last hop, must NOT flag
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 6);
  assert.ok(fired.some((s) => s.kind === 'weak-signal' && s.nodeId === 6));
  assert.equal(fired.filter((s) => s.kind === 'weak-signal' && s.nodeId === 7).length, 0);
});

test('ghost-suspect requires PROVEN coverage (dead + zero comms + ≥3 days observed)', () => {
  const nodes = [node(1), node(6, { status: NodeStatus.Dead })];
  const young = new Map([[6, { firstSeenAt: T - 60_000, samples: 5, freshSamples: 0, probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0, probesReadAsked: 0, probesReadAnswered: 0, probeReroutes: 0 }]]);
  const proven = new Map([[6, { firstSeenAt: T - 5 * 86_400_000, samples: 900, freshSamples: 0, probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0, probesReadAsked: 0, probesReadAnswered: 0, probeReroutes: 0 }]]);
  const inpYoung = (now: number) => input({ nodes, recent: new Map([[6, []]]), cov: young, now });
  const inpProven = (now: number) => input({ nodes, recent: new Map([[6, []]]), cov: proven, now });
  assert.equal(settle(inpYoung, new Map(), T, 8).filter((s) => s.kind === 'ghost-suspect').length, 0, 'young store ⇒ no ghost verdict');
  assert.ok(settle(inpProven, new Map(), T, 8).some((s) => s.kind === 'ghost-suspect'), 'proven coverage ⇒ ghost-suspect');
});

test('controller-degraded fires on rising serial NAK/CAN/timeoutACK', () => {
  const nodes = [node(1)];
  const cs = (now: number): ControllerSample[] => [
    { t: now - 2 * MIN, dMsgTx: 100, dMsgDroppedTx: 0, dNak: 4, dCan: 3, dTimeoutAck: 1, dTimeoutResponse: 0, fresh: true, bg0: null, bg1: null, bg2: null, bg3: null },
  ];
  const inp = (now: number) => input({ nodes, recent: new Map(), ctrl: cs(now), now });
  const fired = settle(inp, new Map(), T, 6);
  assert.ok(fired.some((s) => s.kind === 'controller-degraded' && s.nodeId === null));
});

test('CORRELATION GATE: many active nodes degrading together ⇒ mesh event that SUBSUMES per-node symptoms', () => {
  // 6 active nodes, all with high timeout rates ≫ baseline → each breaches;
  // ≥35% (here 100%) ⇒ mesh-interference, and per-node rows get subsumedBy.
  const ids = [6, 7, 8, 9, 10, 11, 12, 13, 14]; // ≥ MESH_MIN_ACTIVE (8) active nodes
  const nodes = [node(1), ...ids.map((i) => node(i))];
  const inp = (now: number) => input({
    nodes,
    recent: new Map(ids.map((i) => [i, window(now, 12, { dTx: 100, dTimeout: 40 })])),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  const mesh = fired.find((s) => s.kind === 'mesh-interference');
  assert.ok(mesh, 'mesh-interference fired');
  const perNode = fired.filter((s) => s.kind === 'return-path-degraded');
  assert.ok(perNode.length > 0);
  assert.ok(perNode.every((s) => s.subsumedBy === 'mesh'), 'per-node symptoms demoted under the mesh event');
});

test('a single node degrading does NOT trigger a mesh event', () => {
  const nodes = [node(1), node(6), node(7), node(8), node(9), node(10)];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      [6, window(now, 12, { dTx: 100, dTimeout: 40 })], // only #6 bad
      [7, window(now, 12, { dTx: 100, dTimeout: 0 })],
      [8, window(now, 12, { dTx: 100, dTimeout: 0 })],
      [9, window(now, 12, { dTx: 100, dTimeout: 0 })],
      [10, window(now, 12, { dTx: 100, dTimeout: 0 })],
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  assert.equal(fired.filter((s) => s.kind === 'mesh-interference').length, 0);
  const rp = fired.find((s) => s.kind === 'return-path-degraded');
  assert.ok(rp && rp.subsumedBy == null, 'the lone symptom is not subsumed');
});

import { armingNodes } from '../src/zwave/symptoms';

test('armingNodes returns nodes with ANY active dwell (arming OR fired) — the quarantine set', () => {
  const nodes = [node(1), node(6)];
  const state: SymptomState = new Map();
  const inp = (now: number) => input({ nodes, recent: new Map([[6, window(now, 12, { dTx: 100, dTimeout: 40 })]]), now });
  // After ONE tick, #6 is ARMING (breach recorded, not yet emitted).
  detectSymptoms(inp(T), state);
  assert.ok(armingNodes(state).has(6), 'an arming (pre-dwell) node is in the quarantine set');
  assert.equal(detectSymptoms(inp(T), state).filter((s) => s.kind === 'return-path-degraded').length, 0, 'not yet surfaced');
});

test('a non-fresh latest sample does NOT reset the rtt-degraded dwell (fresh-window stability)', () => {
  const nodes = [node(1), node(6)];
  const bl = baselineStub({ rtt: { median: 30, scale: 8, ready: true, days: 5 } });
  // High RTT on FRESH samples, but the NEWEST sample each tick is non-fresh
  // (no new stats event). latestFresh must still find the fresh high-RTT sample.
  const win = (now: number): EvidenceSample[] => {
    const w = risingRtt(now, 10, 400);
    w.push(ev({ t: now, rtt: 400, fresh: false })); // newest = non-fresh
    return w;
  };
  const inp = (now: number) => input({ nodes, recent: new Map([[6, win(now)]]), baselines: bl, now });
  assert.ok(settle(inp, new Map(), T, 6).some((s) => s.kind === 'rtt-degraded'), 'matured despite non-fresh latest ticks');
});

test('mesh gate needs ≥ MESH_MIN_DEGRADED (3) — a coincidental PAIR among many active nodes does not fire', () => {
  const ids = [6, 7, 8, 9, 10, 11, 12, 13, 14];
  const nodes = [node(1), ...ids.map((i) => node(i))];
  const inp = (now: number) => input({
    nodes,
    recent: new Map(ids.map((i) => [i, window(now, 12, { dTx: 100, dTimeout: i <= 7 ? 40 : 0 })])), // only #6,#7 bad
    now,
  });
  assert.equal(settle(inp, new Map(), T, 8).filter((s) => s.kind === 'mesh-interference').length, 0, 'a pair is not a mesh event');
});

// ── edge-cluster: 2–4 nodes sharing ONE healthy upstream repeater ────────────
import type { NodeStats } from '../src/types';

/** Real link stats naming the node's upstream repeater list (the edge-cluster
 *  detector reads `lwr.repeaters`; the base `node()` helper leaves stats empty,
 *  which is exactly why the existing detectors that read `recent()` are
 *  unaffected and never spuriously cluster). */
function st(repeaters: number[]): NodeStats {
  return { rtt: 30, rssi: -60, lwr: { repeaters, protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null, commandsTX: 200, commandsRX: 198, commandsDroppedTX: 0, commandsDroppedRX: 1, timeoutResponse: 0, lastSeen: null };
}
const BAD = { dTx: 100, dTimeout: 40 }; // 40% timeout ≫ 2% baseline → degrading
const OK = { dTx: 100, dTimeout: 0 }; // healthy, active

test('EDGE-CLUSTER: ≥2 degrading nodes sharing a HEALTHY repeater ⇒ one cluster on the shared node; members subsumed', () => {
  // #6,#7,#8 all route through repeater #10 and are degrading; #10 is itself
  // healthy. Only 4 active nodes (< MESH_MIN_ACTIVE=8), so the mesh gate can't fire.
  const nodes = [
    node(1),
    node(10, { stats: st([]) }), // the shared repeater (direct to controller), healthy
    node(6, { stats: st([10]) }),
    node(7, { stats: st([10]) }),
    node(8, { stats: st([10]) }),
  ];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      [10, window(now, 12, OK)], // repeater healthy → eligible as a cluster head
      [6, window(now, 12, BAD)],
      [7, window(now, 12, BAD)],
      [8, window(now, 12, BAD)],
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  const cluster = fired.find((s) => s.kind === 'edge-cluster');
  assert.ok(cluster, 'edge-cluster fired');
  assert.equal(cluster!.nodeId, 10, 'the cluster is keyed to the shared repeater (the actionable node)');
  assert.deepEqual(cluster!.members, [6, 7, 8], 'the degrading downstream members');
  assert.equal(fired.filter((s) => s.kind === 'mesh-interference').length, 0, 'not mesh-wide');
  // Members collapse under the cluster (not N independent faults on the screen).
  const members = fired.filter((s) => s.kind === 'return-path-degraded' && [6, 7, 8].includes(s.nodeId as number));
  assert.ok(members.length >= 1 && members.every((s) => s.subsumedBy === '10:edge-cluster'), 'members subsumed under the cluster');

  // The ids live on `members` ONLY (v0.45.0). They were also interpolated into
  // this evidence string, which rides a truncate()d row — so `#6, #7, #8`
  // clipped to `#6, #7, #` or worse, `#6, #7, #1`, naming a node that is not
  // in the cluster. A count survives truncation intact; the identities get
  // their own shed row on REMEDY.
  const ev = cluster!.evidence.find((e) => e.label === 'degraded downstream');
  assert.ok(ev, 'the downstream evidence row exists');
  assert.equal(ev.value, '3 node(s)', `count only, no id list: "${ev.value}"`);
  assert.doesNotMatch(ev.value, /#\d/, 'an id in a truncated string is an id that can clip');
});

test('EDGE-CLUSTER: a lone degrading dependent under a shared repeater is NOT a cluster (needs ≥2)', () => {
  const nodes = [node(1), node(10, { stats: st([]) }), node(6, { stats: st([10]) }), node(7, { stats: st([10]) })];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      [10, window(now, 12, OK)],
      [6, window(now, 12, BAD)], // only #6 degrading
      [7, window(now, 12, OK)],
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  assert.equal(fired.filter((s) => s.kind === 'edge-cluster').length, 0, 'a single dependent is not a cluster');
  const rp = fired.find((s) => s.kind === 'return-path-degraded' && s.nodeId === 6);
  assert.ok(rp && rp.subsumedBy == null, 'the lone per-node symptom stands on its own');
});

test('EDGE-CLUSTER: if the shared repeater is ITSELF degrading, no cluster fires (the head must look healthy)', () => {
  // A repeater that is also failing already explains the downstream via its own
  // per-node card — the "silent shared dependency" signal does not apply.
  const nodes = [node(1), node(10, { stats: st([]) }), node(6, { stats: st([10]) }), node(7, { stats: st([10]) }), node(8, { stats: st([10]) })];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      [10, window(now, 12, BAD)], // repeater ITSELF degrading
      [6, window(now, 12, BAD)],
      [7, window(now, 12, BAD)],
      [8, window(now, 12, BAD)],
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  assert.equal(fired.filter((s) => s.kind === 'edge-cluster').length, 0, 'a degrading head is not a cluster head');
  assert.ok(fired.some((s) => s.kind === 'return-path-degraded' && s.nodeId === 10), 'the repeater surfaces its own per-node fault instead');
});

test('EDGE-CLUSTER: a mesh-wide event SUPPRESSES the cluster (mesh owns the story)', () => {
  // 8 degrading dependents through #10 → broad enough to trip the mesh gate; the
  // cluster yields and the members subsume under the mesh event, not the cluster.
  const memIds = [2, 3, 4, 5, 6, 7, 8, 9];
  const nodes = [node(1), node(10, { stats: st([]) }), ...memIds.map((i) => node(i, { stats: st([10]) }))];
  const inp = (now: number) => input({
    nodes,
    recent: new Map<number, EvidenceSample[]>([
      [10, window(now, 12, OK)],
      ...memIds.map((i) => [i, window(now, 12, BAD)] as [number, EvidenceSample[]]),
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 8);
  assert.ok(fired.some((s) => s.kind === 'mesh-interference'), 'mesh-interference fired (broad degradation)');
  assert.equal(fired.filter((s) => s.kind === 'edge-cluster').length, 0, 'edge-cluster suppressed under a mesh event');
  const mem = fired.find((s) => s.kind === 'return-path-degraded' && s.nodeId === 2);
  assert.ok(mem && mem.subsumedBy === 'mesh', 'members subsume under the MESH event, not the cluster');
});

/* ── v0.26: s2-desync + the recency conjuncts (illusory-dwell fix) ───────── */

test('s2-desync: a SUSTAINED resync storm matures after dwell; 3× escalates to warn', () => {
  const nodes = [node(1), node(17)];
  // ~1.3 resyncs/min sliding with `now` — an ongoing storm (≥12 per 30m).
  // ~0.5/min sliding with `now` → ~15 per 30 m: over the 12 threshold, under
  // the 36 warn line. (Fractional per-sample counts are fine for the sum.)
  const inp = (now: number) => input({ nodes, recent: new Map([[17, window(now, 31, { dS2Resync: 0.5 })]]), now });
  const state: SymptomState = new Map();
  assert.equal(detectSymptoms(inp(T), state).filter((s) => s.kind === 's2-desync').length, 0, 'arming, not fired');
  const fired = settle(inp, state, T, 6);
  const s2 = fired.find((s) => s.kind === 's2-desync');
  assert.ok(s2, 'sustained storm fires after >5min dwell');
  assert.equal(s2!.nodeId, 17);
  assert.equal(s2!.severity, 'watch');
  // 3× the threshold escalates.
  const hot = (now: number) => input({ nodes, recent: new Map([[17, window(now, 31, { dS2Resync: 2 })]]), now });
  const hotFired = settle(hot, new Map(), T, 6);
  assert.equal(hotFired.find((s) => s.kind === 's2-desync')!.severity, 'warn');
});

/** A ring the way sampleEvidence fills it (v0.76.0 review): one sample a
 *  minute appended at the head, so known samples age out while unknown ones
 *  arrive — the lane is dark for t in [darkFrom, darkTo), and the first sample
 *  after a resume is still unknown, its window spanning the gap. */
function ring(now: number, rate: (t: number) => number, darkFrom = Infinity, darkTo = Infinity): EvidenceSample[] {
  const out: EvidenceSample[] = [];
  for (let m = 31; m >= 0; m--) {
    const t = now - m * MIN;
    out.push(ev({ t, dS2Resync: t >= darkFrom && t < darkTo ? null : rate(t) }));
  }
  return out;
}
const s2Of = (out: ReturnType<typeof detectSymptoms>) => out.find((x) => x.kind === 's2-desync');

test('s2-desync: a lane that goes dark one sample at a time HOLDS a matured symptom through a 5-min pause — same onset after resume, no episode churn (v0.76.0 review)', () => {
  const nodes = [node(1), node(17)];
  // ~15 per 30 min both ways: a fractional rate, and one resync every other minute.
  for (const [what, rate] of [['fractional', () => 0.5], ['alternating 0/1', (t: number) => (Math.round((t - T) / MIN) % 2 === 0 ? 1 : 0)]] as const) {
    const inp = (now: number) => input({ nodes, recent: new Map([[17, ring(now, rate, T + 7 * MIN, T + 13 * MIN)]]), now });
    const state: SymptomState = new Map();
    const first = s2Of(settle(inp, state, T, 6));
    assert.ok(first, `${what}: the storm matured`);
    for (let m = 7; m <= 45; m++) {
      const out = s2Of(detectSymptoms(inp(T + m * MIN), state));
      assert.ok(state.has('17:s2-desync'), `${what} m${m}: never cleared`);
      assert.equal(state.get('17:s2-desync')!.since, first!.sinceMs, `${what} m${m}: never re-armed`);
      if (m >= 14) assert.equal(out?.sinceMs, first!.sinceMs, `${what} m${m}: emitted with its original onset`);
    }
  }
});

test('s2-desync: an ARMED key is dropped by a hold — maturing on resume from its pre-dark start would be a dwell nobody watched (v0.76.0 review)', () => {
  const nodes = [node(1), node(17)];
  const at = (now: number, r: EvidenceSample[]) => detectSymptoms(input({ nodes, recent: new Map([[17, r]]), now }), state);
  const state: SymptomState = new Map();
  at(T, ring(T, () => 0.5));
  assert.equal(state.get('17:s2-desync')?.since, T, 'armed');
  at(T + MIN, ring(T + MIN, () => 0.5, T - 4 * MIN, T + 2 * MIN)); // the recent slice unseen
  assert.ok(!state.has('17:s2-desync'), 'an armed key is not held');
  at(T + 2 * MIN, ring(T + 2 * MIN, () => 0.5));
  assert.equal(state.get('17:s2-desync')?.since, T + 2 * MIN, 'it arms afresh');
});

test('s2-desync: a long pause lets a held symptom go a whole window after it last breached (v0.76.0 review)', () => {
  const nodes = [node(1), node(17)];
  const inp = (now: number) => input({ nodes, recent: new Map([[17, ring(now, () => 0.5, T + 7 * MIN)]]), now });
  const state: SymptomState = new Map();
  settle(inp, state, T, 6);
  let lastSeen = 0;
  for (let m = 7; m <= 50; m++) {
    detectSymptoms(inp(T + m * MIN), state);
    const e = state.get('17:s2-desync');
    if (!e) {
      assert.ok(T + m * MIN - lastSeen > 30 * MIN, `m${m}: let go only past its deadline`);
      return;
    }
    if (!e.held) lastSeen = e.lastSeen;
    else assert.ok(T + m * MIN - e.lastSeen <= 30 * MIN, `m${m}: held within the deadline`);
  }
  assert.fail('a hold has a deadline');
});

test('s2-desync: after a hold, a storm still under way that reads below the threshold on a partly unseen window is kept; a fully seen quiet slice clears it (v0.76.0 review)', () => {
  const nodes = [node(1), node(17)];
  // 0.5/min until T+31, then nothing; dark from T+7 to T+20 (13 min): on
  // resume the known sum is ~9.5, under the 12 threshold.
  const inp = (now: number) => input({ nodes, recent: new Map([[17, ring(now, (t) => (t < T + 31 * MIN ? 0.5 : 0), T + 7 * MIN, T + 20 * MIN)]]), now });
  const state: SymptomState = new Map();
  const first = s2Of(settle(inp, state, T, 6))!;
  for (let m = 7; m <= 30; m++) {
    const out = s2Of(detectSymptoms(inp(T + m * MIN), state));
    if (m >= 21) {
      assert.equal(out?.sinceMs, first.sinceMs, `m${m}: kept with its onset`);
      assert.match(out!.evidence[0].value, /\(part of it unseen\)$/, `m${m}: and says the count is partial`);
    }
  }
  let cleared = -1;
  for (let m = 31; m <= 40 && cleared < 0; m++) {
    if (!s2Of(detectSymptoms(inp(T + m * MIN), state)) && !state.has('17:s2-desync')) cleared = m;
  }
  assert.equal(cleared, 36, 'cleared once a fully seen 5-min slice shows no resync');
});

test('s2-desync: the post-hold carry lasts only while the window still holds an unseen sample — then the threshold judges again (v0.76.0 review)', () => {
  const nodes = [node(1), node(17)];
  // Resumes at 0.3/min: recent resyncs every minute, but ~9.3 per 30 min, under 12.
  const inp = (now: number) => input({ nodes, recent: new Map([[17, ring(now, (t) => (t < T + 20 * MIN ? 0.5 : 0.3), T + 7 * MIN, T + 20 * MIN)]]), now });
  const state: SymptomState = new Map();
  settle(inp, state, T, 6);
  for (let m = 7; m <= 49; m++) detectSymptoms(inp(T + m * MIN), state);
  assert.ok(state.has('17:s2-desync'), 'm49: the unseen sample at T+19 is still in the window — carried');
  detectSymptoms(inp(T + 50 * MIN), state);
  assert.ok(!state.has('17:s2-desync'), 'm50: fully seen, and under the threshold');
});

test('heldSymptoms names what a dark lane holds; the episode lifecycle keeps it open without opening one, and the activity log does not call it cleared (v0.76.0 review)', () => {
  const state: SymptomState = new Map([
    ['17:s2-desync', { since: T, lastSeen: T, hits: 6, held: true }],
    ['18:s2-desync', { since: T, lastSeen: T, hits: 6 }],
    ['mesh:mesh-interference', { since: T, lastSeen: T, hits: 6, held: true }],
  ]);
  assert.deepEqual(heldSymptoms(state), [{ key: '17:s2-desync', nodeId: 17, kind: 's2-desync' }], 'held node keys only');
  const pending = new Map<string, number>();
  const open = [{ key: '17:s2-desync', nodeId: 17, kind: 's2-desync' as const }];
  for (let m = 0; m <= 30; m++) {
    const plan = planEpisodeLifecycle([{ nodeId: 17, kind: 's2-desync', held: true }, { nodeId: 19, kind: 's2-desync', held: true }], open, pending, T + m * MIN, 10 * MIN);
    assert.deepEqual(plan.toResolve, [], `m${m}: a held episode does not close`);
    assert.deepEqual(plan.toOpen, [], `m${m}: and a held symptom opens none`);
  }
  const logged = new Map([['17:s2-desync', { severity: 'watch' as const, nodeId: 17, kind: 's2-desync' as const }]]);
  const held = diffSymptomLog(logged, [], new Set(['17:s2-desync']));
  assert.deepEqual(held.events, [], 'not "cleared" while held');
  assert.ok(held.next.has('17:s2-desync'), 'and not logged as new on resume');
  assert.deepEqual(diffSymptomLog(logged, []).events.map((e) => e.text), ['s2-desync cleared']);
});

test('s2-desync: a single burst that STOPPED never matures (recency conjunct)', () => {
  const nodes = [node(1), node(17)];
  // 15 resyncs in one old sample; quiet padding keeps the ring populated. The
  // burst is inside the 30-min lookback the whole test, but outside the 5-min
  // recency slice — pre-fix semantics (lookback alone) would fire at T+5m.
  const burst = [
    ...window(T, 31, { dS2Resync: 0 }).slice(0, -1),
    ev({ dS2Resync: 15, t: T - 6 * MIN }),
  ];
  const inp = (now: number) => input({ nodes, recent: new Map([[17, burst]]), now });
  const fired = settle(inp, new Map(), T, 8);
  assert.equal(fired.filter((s) => s.kind === 's2-desync').length, 0, 'a dead burst must not mature into "persistent"');
});

test('dead-flap: a burst outside the dwell horizon de-asserts (recency conjunct)', () => {
  const nodes = [node(1), node(6)];
  // 3 flaps, all 8-9 minutes ago: inside the 10-min lookback, outside the
  // 5-min recency slice. Pre-fix this armed at T and fired at T+5m.
  const stale = [
    ...window(T, 12, { dFlaps: 0 }).slice(0, -3),
    ev({ dFlaps: 2, t: T - 9 * MIN }),
    ev({ dFlaps: 1, t: T - 8 * MIN }),
  ];
  const inp = (now: number) => input({ nodes, recent: new Map([[6, stale]]), now });
  const fired = settle(inp, new Map(), T, 6);
  assert.equal(fired.filter((s) => s.kind === 'dead-flap').length, 0, 'stale flap burst must not fire');
  // Control: the same 3 flaps with one INSIDE the recency slice still fires.
  const live = [
    ...window(T, 12, { dFlaps: 0 }).slice(0, -3),
    ev({ dFlaps: 2, t: T - 9 * MIN }),
    ev({ dFlaps: 1, t: T - 1 * MIN }),
  ];
  void live;
  // An ONGOING storm: all three flaps slide with `now`, so the window keeps
  // seeing 3 and the newest is always inside the dwell horizon.
  const liveInp = (now: number) => input({
    nodes,
    recent: new Map([[6, [
      ...window(now, 12, { dFlaps: 0 }).slice(0, -3),
      ev({ dFlaps: 2, t: now - 4 * MIN }),
      ev({ dFlaps: 1, t: now - 1 * MIN }),
    ]]]),
    now,
  });
  const state: SymptomState = new Map();
  const liveFired = settle(liveInp, state, T, 6);
  assert.ok(liveFired.find((s) => s.kind === 'dead-flap'), 'an ONGOING flap storm still fires');
});

test('return-path-degraded: a rate whose bad half went quiet de-asserts (recency conjunct)', () => {
  const nodes = [node(1), node(6)];
  // Heavy timeouts 8-12 minutes ago, clean traffic since: the 10-min windowed
  // rate stays anomalous for a while, but zero timeouts in the last 5 min
  // means the problem is history — pre-fix the dwell matured on it anyway.
  const cold = (now: number) => {
    const samples = window(now, 12, { dTx: 100, dTimeout: 0 }).map((s) =>
      now - s.t >= 8 * MIN ? { ...s, dTimeout: 60 } : s,
    );
    return input({ nodes, recent: new Map([[6, samples]]), now });
  };
  const fired = settle(cold, new Map(), T, 6);
  assert.equal(fired.filter((s) => s.kind === 'return-path-degraded').length, 0, 'cold timeout burst must not mature');
});

test('rtt-degraded: one old in-window outlier does not arm; a RECENT outlier does where no confirmation can reach the node', () => {
  const nodes = [node(1), node(6)];
  // Newest FRESH rtt reading is a 300ms outlier — but it is 7 minutes old.
  // (v0.78.0: over a held 30 ms average, so it is a raw round trip, and the
  // node is not confirmable, so one slow round trip may start the breach.)
  const stale = [
    ...window(T, 12, { rtt: 30, fresh: false }).slice(0, -1),
    ev({ rtt: 300, fresh: true, t: T - 7 * MIN }),
  ];
  const staleInp = (now: number) => input({ nodes, recent: new Map([[6, stale]]), now });
  assert.equal(settle(staleInp, new Map(), T, 6).filter((s) => s.kind === 'rtt-degraded').length, 0, 'a 7-min-old outlier must not arm the dwell');
  // The same outlier kept fresh within the dwell horizon fires.
  const liveInp = (now: number) => input({
    nodes,
    recent: new Map([[6, [...window(now, 12, { rtt: 30, fresh: false }).slice(0, -1), ev({ rtt: 300, fresh: true, t: now - MIN })]]]),
    now,
  });
  const state: SymptomState = new Map();
  assert.ok(settle(liveInp, state, T, 6).find((s) => s.kind === 'rtt-degraded'), 'a recent outlier still fires');
});

test('dead-flap: a finished burst de-asserts — the dwell cannot mature on stale evidence (v0.26)', () => {
  const state: SymptomState = new Map();
  const T9 = T + 9 * 60_000;
  // Three flaps in ONE old sample — inside the 10-min lookback but outside the
  // 5-min dwell horizon by evaluation time. Pre-v0.26 the windowed count kept
  // "breaching" for the whole lookback, so the dwell matured off a burst that
  // had already stopped.
  const burst = [
    ev({ t: T9 - 8 * 60_000, dFlaps: 3, fresh: true }),
    ...window(T9, 4, { dFlaps: 0 }),
  ];
  const inp = (now: number): DetectInput =>
    input({ nodes: [node(5)], recent: new Map([[5, burst]]), now });
  // Arm with the burst 2 min old (recent → legitimately breaching), a full
  // 6 min before the final evaluation — enough for the dwell to elapse, so a
  // reverted conjunct (still "breaching" at T9) WOULD fire and be caught.
  detectSymptoms(inp(T9 - 6 * 60_000), state);
  // …then evaluate with the burst 8 min stale: the recency conjunct must have
  // DE-ASSERTED the breach, so no dead-flap fires despite the elapsed dwell.
  const out = detectSymptoms(inp(T9), state);
  assert.ok(!out.some((sy) => sy.kind === 'dead-flap'),
    'a stale flap burst matured a "persistent" dead-flap through the dwell');

  // Control: same totals but flapping STILL ACTIVE inside the dwell horizon.
  const active = [
    ev({ t: T9 - 8 * 60_000, dFlaps: 2, fresh: true }),
    ev({ t: T9 - 2 * 60_000, dFlaps: 1, fresh: true }),
  ];
  const st2: SymptomState = new Map();
  const inp2 = (now: number): DetectInput =>
    input({ nodes: [node(5)], recent: new Map([[5, active]]), now });
  detectSymptoms(inp2(T9 - 6 * 60_000), st2);
  const out2 = detectSymptoms(inp2(T9), st2);
  assert.ok(out2.some((sy) => sy.kind === 'dead-flap'), 'control: an ACTIVE flap pattern must still fire');
});

test('rtt-degraded still fires for a node that talks less often than the dwell (v0.26 regression guard)', () => {
  // A v0.26 draft gated this detector on `now - obs.t <= DWELL_MS`. Since
  // dwell() stamps `since` at the tick the reading lands, maturing needs
  // `now - since >= DWELL_MS` while that conjunct needs the reading to be
  // NEWER than DWELL_MS — satisfiable only if a second fresh breaching reading
  // arrives inside the same 5 minutes. Any battery or low-traffic node
  // reporting every 6-10 min could then never fire again. RTT is a LEVEL, not
  // an event count: latestFresh already bounds staleness at WINDOW_MS.
  const T2 = T + 30 * 60_000;
  const norm = baselineStub({ rttNormal: () => ({ ready: true, median: 30, scale: 8 }) });
  // ONE fresh breaching observation, 8 minutes old — inside WINDOW_MS(10m),
  // older than DWELL_MS(5m). This is the ONLY reading a 10-min-cadence node has.
  // (v0.78.0: one 300 ms round trip over a settled 30 ms average, on a node no
  // confirmation can reach, so the newest round trip alone starts the breach.)
  const sparse = [ev({ t: T2 - 40 * 60_000, rtt: 30, fresh: true }), ev({ t: T2 - 8 * 60_000, rtt: 97.5, dTx: 1, fresh: true })];
  const inp = (now: number): DetectInput =>
    input({ nodes: [node(9)], recent: new Map([[9, sparse]]), baselines: norm, now });
  detectSymptoms(inp(T2 - 7 * 60_000), new Map()); // arm
  const state: SymptomState = new Map();
  detectSymptoms(inp(T2 - 7 * 60_000), state);
  const out = detectSymptoms(inp(T2 - 60_000), state); // dwell elapsed
  assert.ok(out.some((s) => s.kind === 'rtt-degraded'),
    'a sparsely-reporting node with a sustained bad RTT never surfaced');
});

/* ── rtt-degraded vs a driver restart's seed (v0.77.1) ─────────────────────
 *
 * zwave-js re-seeds each node's RTT average on every restart with one
 * measurement from the restart burst; on the reference mesh that seed sat at
 * 0.7–1.3 s against a 20–60 ms normal and re-tripped rtt-degraded for hours.
 * `commandsTX` counts the measurements in the average, so the seed's leftover
 * is bounded by 0.75^(commandsTX−1) × (RTT_SEED_MAX_MS − median).
 */

/** A node whose driver has sent `tx` acknowledged transmissions since it started. */
const txNode = (id: number, tx: number): NodeSnapshot => node(id, { stats: { commandsTX: tx } as never });
/** Six minutes of a node at `rtt` against `median`±8, after `tx` transmissions;
 *  `seed` is the first fresh reading the store saw in this driver lifetime. */
const rttRun = (tx: number, rtt: number, seed?: RttSeed, median = 30) => {
  const bl = baselineStub({ rtt: { median, scale: 8, ready: true, days: 5 } });
  const state: SymptomState = new Map();
  const inp = (now: number) => input({
    nodes: [node(1), txNode(6, tx)], recent: new Map([[6, risingRtt(now, 10, rtt)]]), baselines: bl, now,
    rttSeed: seed ? new Map([[6, seed]]) : undefined,
  });
  const fired = settle(inp, state, T, 6).find((s) => s.kind === 'rtt-degraded');
  return { fired, state };
};
const rttFires = (tx: number, rtt: number, seed?: RttSeed, median?: number): Symptom | undefined => rttRun(tx, rtt, seed, median).fired;

test('rttRestartResidue: the seed weighs 0.75^(commandsTX−1); no transmission yet, no allowance', () => {
  assert.equal(rttRestartResidue(1, 30), RTT_SEED_MAX_MS - 30, 'one measurement IS the seed');
  assert.equal(rttRestartResidue(2, 30), 0.75 * (RTT_SEED_MAX_MS - 30));
  assert.equal(rttRestartResidue(12, 30), 0.75 ** 11 * (RTT_SEED_MAX_MS - 30));
  assert.equal(rttRestartResidue(12.9, 30), rttRestartResidue(12, 30), 'a counter is whole');
  assert.equal(rttRestartResidue(1, RTT_SEED_MAX_MS + 5), 0, 'a median above the ceiling leaves nothing to allow');
  // emptyStats() reads commandsTX 0, and so does a driver that has not sent yet:
  // no measurement in this lifetime, so a held reading is from before it.
  assert.equal(rttRestartResidue(0, 30), 0, 'no transmission in this lifetime, nothing for a seed to be in');
  assert.equal(rttRestartResidue(Number.NaN, 30), 0);
  assert.equal(rttRestartResidue(undefined as never, 30), 0);
  assert.ok(rttRestartResidue(30, 30) < 1, 'it has decayed to nothing by the 30th transmission');
});

test('rttRestartResidue: the first reading seen this lifetime bounds what came before it exactly', () => {
  // a0 at k0 is 0.75^(k−k0) of the average at k, so that much of the excess is the past.
  assert.equal(rttRestartResidue(9, 54, { k0: 1, a0: 1390 }), 0.75 ** 8 * (1390 - 54), 'tighter than the ceiling');
  assert.equal(rttRestartResidue(7, 27, { k0: 2, a0: 27 }), 0, 'a normal first reading leaves no allowance');
  assert.equal(rttRestartResidue(7, 27, { k0: 2, a0: 20 }), 0, 'nor does one below the median');
  assert.equal(rttRestartResidue(4, 30, { k0: 1, a0: 2600 }), rttRestartResidue(4, 30), 'the ceiling still caps a seed above 2 s');
  assert.equal(rttRestartResidue(40, 30, { k0: 38, a0: 900 }), rttRestartResidue(40, 30),
    'a reading first seen mid-lifetime never widens the ceiling');
  assert.equal(rttRestartResidue(5, 30, { k0: 9, a0: 30 }), rttRestartResidue(5, 30), 'a seed from a later count is not this lifetime\'s');
});

test('rttFoldResidue: a band with a median is the yardstick, as for the detector (v0.77.3)', () => {
  const seed = { k0: 3, a0: 900 };
  assert.equal(rttFoldResidue(4, 900, { median: 25 }, seed), rttRestartResidue(4, 25, seed));
  assert.equal(rttFoldResidue(4, 900, { median: 5 }, seed), rttRestartResidue(4, 5, seed), 'the first bin\'s centre is a median');
});

test('rttFoldResidue: an empty band measures the seed against what the driver averaged after it (v0.77.3)', () => {
  // With r = 0.75^(k − k0) the average is r·a0 + (1 − r)·mean-since-seed, so
  // the seed's share of the reading is reading − mean-since-seed.
  for (const norm of [{ median: 0 }, null]) {
    assert.equal(rttFoldResidue(4, 900, norm, { k0: 3, a0: 900 }), 0, 'steady since a normal seed: nothing');
    assert.equal(rttFoldResidue(8, 40, norm, { k0: 3, a0: 40 }), 0, 'not 0.75^5 × 40 = 9.5 ms against a median of 0');
    // Node 63's 1390 ms seed over ~25 ms, one transmission on: the mean since
    // it is (1048.8 − 0.75 × 1390) / 0.25 = 25.2, and the seed's share 1023.6.
    assert.ok(Math.abs(rttFoldResidue(2, 1048.8, norm, { k0: 1, a0: 1390 }) - 1023.6) < 1e-9);
    assert.ok(Math.abs(rttFoldResidue(10, 127.5, norm, { k0: 1, a0: 1390 }) - (127.5 - (127.5 - 0.75 ** 9 * 1390) / (1 - 0.75 ** 9))) < 1e-9);
  }
});

test('rttFoldResidue: the seed reading, and a node with no seed, are measured against 0 (v0.77.3)', () => {
  // Nothing has been measured since the seed, so it cannot be told from the
  // restart; held while the ceiling says the restart can still be in it.
  assert.equal(rttFoldResidue(3, 40, { median: 0 }, { k0: 3, a0: 40 }), 40);
  assert.equal(rttFoldResidue(25, 40, { median: 0 }, { k0: 25, a0: 40 }), rttRestartResidue(25, 0), 'capped by the ceiling');
  assert.equal(rttFoldResidue(3, 40, null, null), rttRestartResidue(3, 0));
  assert.equal(rttFoldResidue(2, 40, null, { k0: 3, a0: 40 }), rttRestartResidue(2, 0), 'a seed from a later count is no seed');
  assert.equal(rttFoldResidue(0, 40, null, { k0: 1, a0: 40 }), 0, 'no transmission, no allowance');
});

test('rtt-degraded: a seed-sized reading right after a driver restart neither fires nor arms; the same reading on a settled average fires', () => {
  // 600 ms against 30±8. After 3 transmissions the seed can still add
  // 0.5625 × 1970 ≈ 1108 ms; after 500 it can add nothing.
  const early = rttRun(3, 600);
  assert.equal(early.fired, undefined, 'the restart seed alone explains it');
  assert.equal(early.state.has('6:rtt-degraded'), false, 'no dwell is kept');
  assert.equal(armingNodes(early.state).has(6), false, 'so the node is not arming, and its baselines are not frozen');
  assert.ok(rttFires(500, 600), 'a settled average that high is the link');
});

test('rtt-degraded: a node whose first reading after the restart was normal gets its full sensitivity back', () => {
  // 27±8, first reading 27 ms at tx 2, then the link degrades: 237 ms at tx 7.
  // The ceiling alone would allow 0.75^6 × 1973 ≈ 351 ms and hide it.
  assert.ok(rttFires(7, 237, { k0: 2, a0: 27 }, 27), 'nothing the restart measured explains 237 ms');
  assert.equal(rttFires(7, 237, undefined, 27), undefined, 'the ceiling alone would have hidden it');
});

test('rtt-degraded: under a large seed, the excess measured after it still fires', () => {
  // 54±8 (threshold 86), seed 1390 at tx 1. At tx 9 a normal link reads
  // 54 + 0.75^8 × 1336 ≈ 187.8 and the allowance is exactly that 133.8.
  const seed = { k0: 1, a0: 1390 };
  assert.equal(rttFires(9, 187, seed, 54), undefined, 'the seed decaying on a normal link is quiet');
  assert.ok(rttFires(9, 248, seed, 54), '60 ms of new excess over the decay fires (248 − 133.8 > 86)');
  assert.equal(rttFires(9, 248, undefined, 54), undefined, 'the 2 s ceiling (195 ms here) would have hidden it');
});

test('rtt-degraded: a large real slowdown still fires inside the restart window, and says how much it allowed for', () => {
  // 12 transmissions in: allowance 0.75^11 × 1970 ≈ 83 ms; 400 − 83 is far over 30 + 4×8.
  const s = rttFires(12, 400);
  assert.ok(s, 'an excess beyond anything the seed could add is not hidden');
  assert.deepEqual(s.evidence.find((e) => e.label === 'restart allowance'),
    { label: 'restart allowance', value: '83ms (12 tx since driver start)' });
  assert.equal(rttFires(500, 400)?.evidence.some((e) => e.label === 'restart allowance'), false,
    'a settled average carries no allowance row');
});

test('rtt-degraded: the allowance is subtracted before the usual test, to the millisecond', () => {
  // threshold 30 + 4×8 = 62; allowance at 12 tx = 0.75^11 × 1970 = 83.20 ms.
  assert.equal(rttFires(12, 145), undefined, '145 − 83.20 = 61.80 is under 62');
  assert.ok(rttFires(12, 146), '146 − 83.20 = 62.80 is over 62');
});

/* ── rtt-degraded needs two slow round trips (v0.78.0) ─────────────────────
 *
 * The driver's average keeps 0.75 of itself per transmission, so ONE frame
 * above median + 16 scales lifts it over median + 4 scales alone. 14 of 30
 * episodes in 14 days on the reference mesh were that, each spending a burst.
 */

/** A sparse ring that follows the driver's rule: a settled `base` average 30
 *  minutes before the first round trip, then each round trip as its own
 *  sample (one transmission each), its average rounded as the driver does. */
function trips(base: number, list: { t: number; raw: number }[]): EvidenceSample[] {
  let avg = base;
  const out = [ev({ t: list[0].t - 30 * MIN, rtt: base, dTx: 1 })];
  for (const f of list) {
    avg = Math.round((0.75 * avg + 0.25 * f.raw) * 10) / 10;
    out.push(ev({ t: f.t, rtt: avg, dTx: 1 }));
  }
  return out;
}
/** Run the detector each minute over [from, to] against 30±8 (line 62) and
 *  report what rtt-degraded did. `ring(now)` gives the samples seen at `now`. */
function rttTicks(ring: (now: number) => EvidenceSample[], from: number, to: number, confirmable?: boolean) {
  const state: SymptomState = new Map();
  const suspects: { id: number; raw: number }[] = [];
  const asked: number[] = [];
  let fired: Symptom | undefined;
  let firstAt: number | null = null;
  let armedAt: number | null = null;
  for (let now = from; now <= to; now += MIN) {
    const before = suspects.length;
    const out = detectSymptoms(input({ nodes: [node(1), node(6)], recent: new Map([[6, ring(now).filter((x) => x.t <= now)]]), now, confirmable, suspects }), state);
    if (suspects.length > before) asked.push(now);
    if (armedAt == null && state.has('6:rtt-degraded')) armedAt = now;
    const f = out.find((x) => x.kind === 'rtt-degraded');
    if (f && firstAt == null) { firstAt = now; fired = f; }
  }
  return { fired, firstAt, armedAt, suspects, asked, state };
}

test('rtt-degraded: one slow round trip asks for a confirmation and starts nothing (v0.78.0)', () => {
  // 300 ms over 30: the average reads 97.5 against a line of 62 for ten minutes.
  const r = rttTicks(() => trips(30, [{ t: T, raw: 300 }]), T, T + 9 * MIN, true);
  assert.equal(r.firstAt, null, 'one slow round trip is not a slowdown');
  assert.equal(r.armedAt, null, 'nor does it arm the dwell');
  assert.ok(r.suspects.length > 0, 'the caller is asked for a second look');
  assert.ok(r.suspects.every((x) => x.id === 6 && x.raw === 300), 'about that round trip');
});

test('rtt-degraded: a slow second round trip starts the dwell where it lands, and fires five minutes later (v0.78.0)', () => {
  const ring = () => trips(30, [{ t: T, raw: 300 }, { t: T + MIN, raw: 280 }]);
  const r = rttTicks(ring, T, T + 8 * MIN, true);
  assert.equal(r.armedAt, T + MIN, 'the dwell starts on the second round trip, not before');
  assert.equal(r.firstAt, T + 6 * MIN, 'and matures DWELL_MS after it');
  assert.equal(r.fired!.sinceMs, T + MIN);
  assert.deepEqual(r.asked, [T], 'a confirmation is asked only while one round trip stands alone');
  assert.deepEqual(r.fired!.evidence.find((e) => e.label === 'newest round trips'), { label: 'newest round trips', value: '280, 300ms' });
});

test('rtt-degraded: a normal round trip after the slow one ends the question while the average is still high (v0.78.0)', () => {
  // 696 then 27: the average still reads 154.1 > 62, the tail of one frame.
  const r = rttTicks(() => trips(30, [{ t: T, raw: 696 }, { t: T + MIN, raw: 27 }]), T, T + 9 * MIN, true);
  assert.equal(r.firstAt, null);
  assert.equal(r.armedAt, null);
  assert.deepEqual(r.asked, [T], 'nothing more is asked once the newest round trip is normal');
});

test('rtt-degraded: the two NEWEST round trips decide, and both must be over the line (v0.78.0)', () => {
  // All three already in the ring at the first look: two slow ones, then a normal one.
  const late = rttTicks(() => trips(30, [{ t: T - 3 * MIN, raw: 300 }, { t: T - 2 * MIN, raw: 300 }, { t: T - MIN, raw: 27 }]), T, T + 7 * MIN, true);
  assert.equal(late.armedAt, null, 'two slow round trips behind a normal one start nothing');
  const older = rttTicks(() => trips(30, [{ t: T - 2 * MIN, raw: 300 }, { t: T - MIN, raw: 60 }]), T, T + 7 * MIN, true);
  assert.equal(older.armedAt, null, '300 then 60 (under 62): the newest is not slow');
  assert.deepEqual(older.asked, [], 'and nothing is asked');
  const newer = rttTicks(() => trips(30, [{ t: T - 2 * MIN, raw: 60 }, { t: T - MIN, raw: 300 }]), T, T + 7 * MIN, true);
  assert.equal(newer.armedAt, null, '60 then 300: the one before it is not slow');
  assert.ok(newer.asked.length > 0, 'so the slow one asks for a confirmation');
});

test('rtt-degraded: once started, the average alone holds the breach through a normal round trip, and asks nothing more (v0.78.0)', () => {
  // 300, 280 start it at T+1; 27 at T+2 leaves the average at 114.1 > 62, and
  // a lone slow 300 after it at T+3 is part of a breach already running.
  const ring = (now: number) => trips(30, [{ t: T, raw: 300 }, { t: T + MIN, raw: 280 }, { t: T + 2 * MIN, raw: 27 }, { t: T + 3 * MIN, raw: 300 }]).filter((x) => x.t <= now);
  const r = rttTicks(ring, T, T + 7 * MIN, true);
  assert.equal(r.firstAt, T + 6 * MIN, 'a level is not re-proven on every frame');
  assert.deepEqual(r.fired!.evidence.find((e) => e.label === 'newest round trips')!.value, '300, 27ms');
  assert.deepEqual(r.asked, [T], 'a running breach asks for no confirmation');
});

test('rtt-degraded: where no confirmation can reach the node, the newest round trip alone starts it, never a normal one (v0.78.0)', () => {
  const one = rttTicks(() => trips(30, [{ t: T, raw: 300 }]), T, T + 6 * MIN, false);
  assert.equal(one.firstAt, T + 5 * MIN, 'one slow round trip fires, as it did before v0.78.0');
  assert.deepEqual(one.asked, [], 'and nothing is asked for a node no probe can reach');
  const refuted = rttTicks(() => trips(30, [{ t: T, raw: 696 }, { t: T + MIN, raw: 27 }]), T + MIN, T + 9 * MIN, false);
  assert.equal(refuted.armedAt, null, 'but never on the tail of one after a normal round trip');
});

test('rtt-degraded: an average whose round trips have left the window starts nothing (v0.78.0)', () => {
  // A 300 ms round trip 12 minutes ago, then receive-only statistics events
  // (fresh, no transmission) keep the 97.5 average "fresh" inside the window.
  const ring = (now: number) => [
    ...trips(30, [{ t: T - 12 * MIN, raw: 300 }]),
    ...[3, 2, 1, 0].map((m) => ev({ t: now - m * MIN, rtt: 97.5, dTx: 0 })),
  ];
  for (const confirmable of [false, true]) {
    const r = rttTicks(ring, T, T + 7 * MIN, confirmable);
    assert.equal(r.armedAt, null, `confirmable=${confirmable}: an old round trip held up by receive-only events is not a reading`);
    assert.deepEqual(r.asked, []);
  }
});

test('rtt-degraded: a restart seed is not a round trip, with or without the allowance (v0.78.0)', () => {
  // A driver restart (counters reset: dTx null, no average yet), then a 900 ms
  // seed. Node 6 carries no commandsTX, so the restart allowance is 0 here.
  const ring = (now: number) => [
    ev({ t: T - 40 * MIN, rtt: 25, dTx: 1 }),
    ev({ t: T - 2 * MIN, rtt: null, dTx: null }),
    ev({ t: T - MIN, rtt: 900, dTx: 1 }),
    ...(now >= T + MIN ? [ev({ t: T + MIN, rtt: 681.3, dTx: 1 })] : []),
  ];
  for (const confirmable of [false, true]) {
    const r = rttTicks(ring, T, T + 7 * MIN, confirmable);
    assert.equal(r.armedAt, null, `confirmable=${confirmable}: neither the seed nor the 25 ms after it starts anything`);
    assert.deepEqual(r.asked, []);
  }
});

test('rtt-degraded: strictly alternating slow and normal round trips never start it, a known cost of the rule (v0.78.0)', () => {
  // 200 / 25 every 30 s holds the average near 110, well over 62, but the two
  // newest round trips are never both slow. v0.77.3 fired here at 5 minutes.
  // Random intermittent slowness pairs within a few frames and is held by the
  // average from there; only a strict alternation is never corroborated.
  const list = Array.from({ length: 24 }, (_v, i) => ({ t: T + i * 30_000, raw: i % 2 ? 25 : 200 }));
  const r = rttTicks((now) => trips(30, list).filter((x) => x.t <= now), T, T + 12 * MIN, true);
  assert.equal(r.armedAt, null);
  assert.ok(r.asked.length > 0, 'each slow one still asks; the confirmation is what can pair it');
});

/* ── route-churn: a SymptomKind that existed but was never emitted ────────
 *
 * v0.30.0. `route-churn` had a full planner card (planner.ts) and outcomes
 * handling since the planner was written, but NO detector ever produced it —
 * `grep "kind: 'route-churn'"` over src/ returned 0 — so REMEDY could never
 * surface it and the card was unreachable. The evidence had been collected the
 * whole time: `dRouteChanges` is an event-accumulator drain on every sample,
 * exactly like `dFlaps`.
 */

test('route-churn fires on ≥4 LWR route changes in the window', () => {
  const nodes = [node(1), node(7)];
  const inp = (now: number) =>
    input({ nodes, recent: new Map([[7, window(now, 8, { dRouteChanges: 1 })]]), now });
  const fired = settle(inp, new Map(), T, 6);
  const rc = fired.find((s) => s.kind === 'route-churn');
  assert.ok(rc, 'route-churn never fired despite sustained re-routing');
  assert.equal(rc!.severity, 'warn');
  assert.equal(rc!.basis, 'measured', 'route changes are counted events, not inferred');
  assert.match(rc!.evidence[0].value, /in 10m/);
});

test('route-churn does NOT fire on normal healing (below the threshold)', () => {
  // One to three re-routes IS the mesh working. Firing there would make every
  // ordinary heal look like a fault.
  //
  // The fixture SLIDES with `now`: three changes always sitting in the last
  // three minutes. That matters — a fixture pinned at T ages out of the recency
  // window as settle() advances, so the RECENCY conjunct blocks it and the
  // threshold is never the thing under test. (The mutation harness caught
  // exactly that: `ROUTE_CHURN_WINDOW = 1` survived the pinned version.)
  const nodes = [node(1), node(7)];
  const inp = (now: number) =>
    input({
      nodes,
      recent: new Map([[7, [
        ev({ dRouteChanges: 1, t: now - 3 * MIN }),
        ev({ dRouteChanges: 1, t: now - 2 * MIN }),
        ev({ dRouteChanges: 1, t: now - 1 * MIN }),
      ]]]),
      now,
    });
  const fired = settle(inp, new Map(), T, 6);
  assert.equal(fired.filter((s) => s.kind === 'route-churn').length, 0,
    'sustained 3-in-window is below the threshold and must stay quiet');
});

test('route-churn never fires for a Long-Range node', () => {
  // LR holds ONE direct link to the controller and has no mesh routes to churn.
  // The planner card already says a report there is a data quirk — firing would
  // make the screen argue with itself.
  const nodes = [node(1), node(9, { isLongRange: true })];
  const inp = (now: number) =>
    input({ nodes, recent: new Map([[9, window(now, 8, { dRouteChanges: 1 })]]), now });
  const fired = settle(inp, new Map(), T, 6);
  assert.equal(fired.filter((s) => s.kind === 'route-churn').length, 0,
    'a Long-Range node has no routes to churn');
});

test('route-churn de-asserts when the churn stops (recency conjunct)', () => {
  // Changes inside the 10-min lookback but outside the 5-min recency slice must
  // not keep an old burst asserted — the same rule dead-flap follows.
  const nodes = [node(1), node(7)];
  const stale = [
    ...window(T, 12, { dRouteChanges: 0 }).slice(0, -3),
    ev({ dRouteChanges: 3, t: T - 9 * MIN }),
    ev({ dRouteChanges: 2, t: T - 8 * MIN }),
  ];
  const inp = (now: number) => input({ nodes, recent: new Map([[7, stale]]), now });
  const fired = settle(inp, new Map(), T, 6);
  assert.equal(fired.filter((s) => s.kind === 'route-churn').length, 0,
    'a stale churn burst must not stay asserted');
});

/* ── v0.37: node-down — the ordinary outage the engine could not see ───────── */

test('node-down fires for a node the driver marked Dead, past the dwell', () => {
  // The gap this closes: `dead-flap` needs THREE Alive↔Dead transitions, so the
  // ordinary outage — node dies, stays dead, gets probed, comes back — produced
  // one or two and was invisible to the symptom engine entirely. It never
  // appeared on REMEDY and never opened an M5 episode, which is why auto-ping's
  // own efficacy against deadness could not accrue a single data point.
  const nodes = [node(1), node(6, { status: NodeStatus.Dead })];
  const inp = (now: number) => input({ nodes, recent: new Map([[6, []]]), now });
  const fired = settle(inp, new Map(), T, 8);
  const s = fired.find((x) => x.kind === 'node-down' && x.nodeId === 6);
  assert.ok(s, 'a Dead node must surface as a symptom');
  assert.equal(s!.severity, 'crit');
  assert.equal(s!.basis, 'measured', 'Dead is a driver VERDICT, not an inference from silence');
});

test('node-down does NOT fire for an Alive node, however quiet', () => {
  // Silence is `quiet-node`'s territory and is explicitly not proof of failure.
  // Deadness is a driver verdict; conflating them would turn every sleeping
  // device into a critical alert.
  const nodes = [node(1), node(6)];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  assert.equal(fired.filter((x) => x.kind === 'node-down').length, 0);
});

test('node-down needs the dwell — a momentary Dead reading does not surface', () => {
  const nodes = [node(1), node(6, { status: NodeStatus.Dead })];
  const one = detectSymptoms(input({ nodes, recent: new Map([[6, []]]), now: T }), new Map());
  assert.equal(one.filter((x) => x.kind === 'node-down').length, 0,
    'first observation arms the dwell; it must not emit yet');
});

test('a dead node does NOT feed the mesh-correlation gate', () => {
  // A dead node contributes no RF readings, so counting it as "degrading" would
  // let one dead device look like an environmental event across the mesh.
  const nodes = [node(1), ...Array.from({ length: 12 }, (_v, i) => node(10 + i, { status: NodeStatus.Dead }))];
  const recent = new Map<number, EvidenceSample[]>(nodes.filter((n) => !n.isController).map((n) => [n.nodeId, [] as EvidenceSample[]]));
  const fired = settle((now: number) => input({ nodes, recent: new Map(recent), now }), new Map(), T, 8);
  assert.ok(fired.some((x) => x.kind === 'node-down'), 'the individual outages surface');
  assert.equal(fired.filter((x) => x.kind === 'mesh-interference').length, 0,
    'but twelve dead nodes are not an RF-environment event');
});

/* ── v0.38: quiet-node — silence past the sweep's own cadence ──────────────── */

test('quiet-node fires for a MAINS node unheard far past the sweep cadence', () => {
  // The last declared-but-unemitted kind. It fires EARLIER than node-down and
  // from the opposite direction: the sweep asks every listening node and an
  // answered probe refreshes lastSeen, so silence this long means the probes
  // are not landing — while the driver still says Alive, because it marks Dead
  // only when a transmission it attempted fails.
  const nodes = [node(1), node(6, { stats: { lastSeen: T - 8 * 3600_000 } as never })];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  const s = fired.find((x) => x.kind === 'quiet-node' && x.nodeId === 6);
  assert.ok(s, 'a mains node silent for 8h must surface');
  assert.equal(s!.severity, 'warn');
  assert.match(s!.evidence[0].value, /h ago/);
});

test('a SLEEPING device is never quiet-node, however long it is silent', () => {
  // Battery and FLiRS devices are silent between wakeups by design, and calling
  // that a symptom would make every sleeping sensor a standing alert.
  const nodes = [node(1), node(6, { isListening: false, stats: { lastSeen: T - 48 * 3600_000 } as never })];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  assert.equal(fired.filter((x) => x.kind === 'quiet-node').length, 0);
});

test('a node with NO lastSeen at all is not accused of silence', () => {
  // Absence of a reading is not evidence of silence — it may simply never have
  // been heard from since a restart cleared the roster. Fail closed.
  const nodes = [node(1), node(6, { stats: { lastSeen: null } as never })];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  assert.equal(fired.filter((x) => x.kind === 'quiet-node').length, 0);
});

test('a node already DEAD gets node-down, not both cards', () => {
  const nodes = [node(1), node(6, { status: NodeStatus.Dead, stats: { lastSeen: T - 8 * 3600_000 } as never })];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  assert.ok(fired.some((x) => x.kind === 'node-down'), 'the driver verdict wins');
  assert.equal(fired.filter((x) => x.kind === 'quiet-node').length, 0,
    'two cards for one fault is worse than one');
});

test('recent contact keeps a mains node quiet-node-free', () => {
  const nodes = [node(1), node(6, { stats: { lastSeen: T - 30 * 60_000 } as never })];
  const fired = settle((now: number) => input({ nodes, recent: new Map([[6, []]]), now }), new Map(), T, 8);
  assert.equal(fired.filter((x) => x.kind === 'quiet-node').length, 0);
});

test('weak-signal treats an UNKNOWN route as NOT direct — fail closed (v0.54.0)', () => {
  // A null routeKey means the statistics event carried no `lwr`, not that the
  // node is direct. This detector coerced it to 'direct', then asserted
  // "(direct route)" with basis 'measured' about a route it never observed —
  // and the margin it reported may be a REPEATER's last hop, not the device's.
  // rate-fallback already fails closed on this identical value.
  const nodes = [node(1), node(6), node(7)];
  const inp = (now: number) => input({
    nodes,
    recent: new Map([
      // Known-direct: still fires, so the guard did not just disable the lane.
      [6, window(now, 8, { rssi: -92, routeKey: 'direct', dTx: 100, dTimeout: 10 })],
      // Route UNKNOWN: identical signal, but nothing established it is direct.
      [7, window(now, 8, { rssi: -92, routeKey: null, dTx: 100, dTimeout: 10 })],
    ]),
    now,
  });
  const fired = settle(inp, new Map(), T, 6);
  assert.ok(fired.some((s) => s.kind === 'weak-signal' && s.nodeId === 6),
    'a KNOWN-direct thin margin must still fire');
  assert.equal(fired.filter((s) => s.kind === 'weak-signal' && s.nodeId === 7).length, 0,
    'an unknown route must not be asserted as direct');
});

test('one `lwr` blink does not stop weak-signal ever maturing (v0.54.0)', () => {
  // The route must come from the newest FRESH sample that HAS one, not the raw
  // newest. dwell() clears on any non-breaching tick, and the evidence cadence
  // is ~10 s, so gating on the raw last sample means a single statistics event
  // arriving without `lwr` — the v0.47.0 nullable-routeKey shape, which is
  // common — resets the dwell every time and the detector never matures.
  const nodes = [node(1), node(6)];
  const inp = (now: number) => {
    const w = window(now, 8, { rssi: -92, routeKey: 'direct', dTx: 100, dTimeout: 10 });
    // The NEWEST sample carries no route — the blink.
    w[w.length - 1] = { ...w[w.length - 1], routeKey: null };
    return input({ nodes, recent: new Map([[6, w]]), now });
  };
  const fired = settle(inp, new Map(), T, 6);
  assert.ok(fired.some((s) => s.kind === 'weak-signal' && s.nodeId === 6),
    'a route the node has held all window is still its route when one event omits it');
});

test('quiet-node\'s dwell follows the CONFIGURED sweep, not the default (v0.63.0)', () => {
  // QUIET_MS was "several times the sweep's DEFAULT cadence (120 min)" — but
  // the cadence is configurable, and on an install that lengthened it this
  // detector fired before even one sweep had asked, which is exactly the false
  // alarm the constant exists to prevent.
  const nodes = [node(1), node(6, { stats: { lastSeen: T - 8 * 3600_000 } as never })];
  const run = (sweepMs?: number) => settle(
    (now: number) => ({ ...input({ nodes, recent: new Map([[6, []]]), now }), sweepMs } as never),
    new Map(), T, 8);

  // POSITIVE CONTROL. Asserting an absence proves nothing unless the same
  // fixture can produce the presence — the first draft of this test asserted
  // only the absence and passed for a fixture that could never fire at all.
  assert.ok(run(undefined).some((x) => x.kind === 'quiet-node' && x.nodeId === 6),
    'control: at the default cadence, 8 h of silence DOES fire quiet-node');

  // A 4-hour sweep means only two sweeps have asked in 8 h; the dwell is three.
  assert.equal(run(4 * 3600_000).filter((x) => x.kind === 'quiet-node').length, 0,
    'a lengthened sweep must lengthen the dwell — otherwise this fires before one sweep asked');
});

/* ── v0.64.6: rate-fallback needs a PERSISTENT regression, not one retried frame ── */

type RateMark = { at: number; rate?: number; routeKey?: string | null; fresh?: boolean; dTx?: number; dDropTx?: number };
/** Node 6's samples as the store records them: a mark is a tick where something
 *  landed (by default an acknowledged transmission — fresh, dTx 1); every other
 *  minute copies the cached rate and route with fresh false and dTx 0. */
function rateTimeline(from: number, to: number, marks: RateMark[]): EvidenceSample[] {
  const byT = new Map(marks.map((x) => [x.at, x]));
  const times = new Set<number>(marks.map((x) => x.at));
  for (let t = from; t <= to; t += MIN) times.add(t);
  let rate: number | null = 100;
  let routeKey: string | null = 'direct';
  const out: EvidenceSample[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const x = byT.get(t);
    if (x?.rate !== undefined) rate = x.rate;
    if (x?.routeKey !== undefined) routeKey = x.routeKey;
    out.push(ev({ t, rateKbps: routeKey == null ? null : rate, routeKey,
      fresh: x ? (x.fresh ?? true) : false, dTx: x ? (x.dTx ?? 1) : 0, dDropTx: x?.dDropTx ?? 0, dRx: 0 }));
  }
  return out;
}
/** Drive the detector once a minute (minutes relative to T) with one carried
 *  dwell state; return node 6's live rate-fallback at each minute it was live. */
function rateFallbackMinutes(samples: EvidenceSample[], fromMin: number, toMin: number) {
  const state: SymptomState = new Map();
  const hits: { minute: number; sym: ReturnType<typeof detectSymptoms>[number] }[] = [];
  for (let m = fromMin; m <= toMin; m++) {
    const now = T + m * MIN;
    const out = detectSymptoms(input({ nodes: [node(1), node(6)], recent: new Map([[6, samples.filter((s) => s.t <= now)]]), now }), state);
    const sym = out.find((x) => x.kind === 'rate-fallback' && x.nodeId === 6);
    if (sym) hits.push({ minute: m, sym });
  }
  return hits;
}

test('ONE retried frame is a single-exchange retry, not a regression — rate-fallback never arms (v0.64.6)', () => {
  // The live shape (nodes 4, 13, 3): one sweep ping at 40 kbit/s with 3 routing
  // attempts, then silence. Through v0.64.5 the store's copies of that one rate
  // matured the symptom by themselves and held it ~30 min.
  const samples = rateTimeline(T - 20 * MIN, T + 35 * MIN, [{ at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 }]);
  assert.deepEqual(rateFallbackMinutes(samples, 0, 35).map((h) => h.minute), []);
});

test('a fresh tick that only RECEIVED re-reads the cached rate — it is not a second transmission (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 35 * MIN, [
    { at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 },
    ...[3, 6, 9, 12].map((m) => ({ at: T + m * MIN, fresh: true, dTx: 0 })),
  ]);
  assert.deepEqual(rateFallbackMinutes(samples, 0, 35).map((h) => h.minute), []);
});

test('a second SEPARATE acknowledged transmission below 100k confirms it — the dwell runs from there (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 12 * MIN, [{ at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 }, { at: T + 2 * MIN, rate: 40 }]);
  const hits = rateFallbackMinutes(samples, 0, 12);
  assert.equal(hits.some((h) => h.minute <= 6), false, `not before the dwell has run from the second reading: ${JSON.stringify(hits.map((h) => h.minute))}`);
  const at8 = hits.find((h) => h.minute === 8);
  assert.ok(at8, `live by T+8: ${JSON.stringify(hits.map((h) => h.minute))}`);
  assert.equal(at8!.sym.severity, 'watch');
  assert.equal(at8!.sym.evidence[0].value, '40k');
});

test('two transmit reports seconds apart are ONE exchange — they do not confirm each other (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 35 * MIN, [{ at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 }, { at: T + 10_000, rate: 40 }]);
  assert.deepEqual(rateFallbackMinutes(samples, 0, 35).map((h) => h.minute), []);
});

test('the newest acknowledged reading decides — one 100k transmission clears it on that tick (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 12 * MIN, [
    { at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 }, { at: T + 2 * MIN, rate: 40 }, { at: T + 9 * MIN, rate: 100 },
  ]);
  const minutes = rateFallbackMinutes(samples, 0, 12).map((h) => h.minute);
  assert.ok(minutes.includes(8), `live before the 100k reading: ${JSON.stringify(minutes)}`);
  assert.equal(minutes.some((m) => m >= 9), false, 'gone on the tick the link is back at 100k, not 30 min later');
});

test('a send cut short by a NONCE REPORT rewrites the cached rate but is not a reading — neither a reset nor the reported rate (v0.64.6)', () => {
  // A send cut short because the node's S0 nonce report or S2 SOS nonce report
  // arrived before the ACK reports NoAck, still rewrites the route rate, and
  // moves commandsDroppedTX but not commandsTX (zwave-js 15.27.1). Any other
  // premature response aborts the transaction before either.
  const samples = rateTimeline(T - 20 * MIN, T + 10 * MIN, [
    { at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 },
    { at: T + 1 * MIN, rate: 100, dTx: 0, dDropTx: 1 },
    { at: T + 2 * MIN, rate: 40 },
    { at: T + 6 * MIN, rate: 100, dTx: 0, dDropTx: 1 },
  ]);
  const at8 = rateFallbackMinutes(samples, 0, 10).find((h) => h.minute === 8);
  assert.ok(at8, 'the nonce-cut sends neither reset nor cleared it');
  assert.equal(at8!.sym.evidence[0].value, '40k', "it reports the run's newest reading, not the nonce-cut send's 100k");
  assert.equal(at8!.sym.severity, 'watch');
});

test('a NEW route carries no 100k capability — a reroute onto a 40k path is not a same-route regression (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 20 * MIN, [
    { at: T - 20 * MIN, rate: 100, routeKey: 'r7' }, { at: T, rate: 40, routeKey: 'r9' }, { at: T + 2 * MIN, rate: 40, routeKey: 'r9' },
  ]);
  assert.deepEqual(rateFallbackMinutes(samples, 0, 20).map((h) => h.minute), []);
});

test('a route the driver no longer reports is not asserted as regressed (v0.64.6)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 12 * MIN, [
    { at: T - 20 * MIN, rate: 100 }, { at: T, rate: 40 }, { at: T + 2 * MIN, rate: 40 },
    { at: T + 9 * MIN, routeKey: null, fresh: false, dTx: 0 },
  ]);
  const minutes = rateFallbackMinutes(samples, 0, 12).map((h) => h.minute);
  assert.ok(minutes.includes(8), `live while the route was visible: ${JSON.stringify(minutes)}`);
  assert.equal(minutes.some((m) => m >= 9), false, 'fail-closed once it is not');
});

test('a 9.6k same-route regression is a WARNING — even after a send cut short by a nonce report rewrites the cached rate to 100k (v0.64.6 review)', () => {
  const samples = rateTimeline(T - 20 * MIN, T + 10 * MIN, [
    { at: T - 20 * MIN, rate: 100 }, { at: T, rate: 9.6 }, { at: T + 2 * MIN, rate: 9.6 },
    { at: T + 6 * MIN, rate: 100, dTx: 0, dDropTx: 1 },
  ]);
  const at8 = rateFallbackMinutes(samples, 0, 10).find((h) => h.minute === 8);
  assert.ok(at8, 'live at T+8');
  assert.equal(at8!.sym.severity, 'warn', 'severity follows the run\'s reading, not the newest sample');
  assert.equal(at8!.sym.evidence[0].value, '9.6k');
});

/* ── missed-report (v0.73.0) ────────────────────────────────────────────── */

test('missed-report: a sleeper past its declared interval fires after the dwell, with its evidence (v0.73.0)', () => {
  const P = 70 * MIN;
  const sleeper = node(61, { isListening: false, name: 'Hallway Closet Motion' });
  let sev: 'watch' | 'warn' | null = 'watch';
  const watch = (n: NodeSnapshot) => (n.nodeId !== 61 ? null : {
    nodeId: 61, watched: true, reason: null, periodMs: P, source: 'heartbeat' as const,
    silentMs: 1.6 * P, radioAllowance: false, severity: sev,
  });
  const state: SymptomState = new Map();
  const inp = (now: number) => input({ now, nodes: [sleeper], recent: new Map(), sleeperWatch: watch });
  assert.equal(detectSymptoms(inp(T), state).filter((s) => s.kind === 'missed-report').length, 0, 'arming, not fired');
  const fired = settle(inp, state, T, 6).filter((s) => s.kind === 'missed-report');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].severity, 'watch');
  assert.equal(fired[0].nodeId, 61);
  assert.deepEqual(fired[0].evidence, [{ label: 'last heard', value: '112 min ago' }, { label: 'declared', value: 'heartbeat interval 70 min' }]);
  sev = 'warn';
  assert.equal(detectSymptoms(inp(T + 7 * MIN), state).find((s) => s.kind === 'missed-report')?.severity, 'warn');
  sev = null;
  assert.equal(detectSymptoms(inp(T + 8 * MIN), state).filter((s) => s.kind === 'missed-report').length, 0, 'a report clears it at once');
});

test('repeated-frames: a node repeating its frames fires after the dwell, never on a Dead node (v0.74.0)', () => {
  const T0 = T;
  const big = [{ at: T0 - 3_600_000, n: 20 }];
  const inp = (now: number, status = NodeStatus.Alive) => input({ now, nodes: [node(16, { status, name: 'Laundry Room Lights' })], recent: new Map(), duplicateBursts: (id) => (id === 16 ? big : []) });
  const state: SymptomState = new Map();
  assert.equal(detectSymptoms(inp(T0), state).filter((s) => s.kind === 'repeated-frames').length, 0, 'arming');
  const fired = settle(inp, state, T0, 6).filter((s) => s.kind === 'repeated-frames');
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].evidence, [{ label: 'bursts (24 h)', value: '1' }, { label: 'largest burst', value: '20 repeats in 1 min' }]);
  const dead: SymptomState = new Map();
  assert.equal(settle((n) => inp(n, NodeStatus.Dead), dead, T0, 6).filter((s) => s.kind === 'repeated-frames').length, 0, 'node-down owns a Dead node');
});
