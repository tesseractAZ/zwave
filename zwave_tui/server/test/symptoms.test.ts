import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSymptoms, windowTimeoutRate, type DetectInput, type SymptomState } from '../src/zwave/symptoms';
import type { RateNormal, ContNormal, BaselineStore } from '../src/zwave/baselines';
import { NodeStatus, type NodeSnapshot, type ControllerSnapshot } from '../src/types';
import type { EvidenceSample, CoarseBucket, ControllerSample, NodeCoverage } from '../src/zwave/evidenceStore';

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
    t: T, dTx: 100, dTimeout: 0, dDropTx: 0, dRx: 5, dFlaps: 0, dRouteChanges: 0, fresh: true,
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
  hasRealNoise?: boolean;
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
    recordingSince: () => T - 30 * 86_400_000,
    hasRealNoise: () => f.hasRealNoise ?? true,
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
  const young = new Map([[6, { firstSeenAt: T - 60_000, samples: 5, freshSamples: 0 }]]);
  const proven = new Map([[6, { firstSeenAt: T - 5 * 86_400_000, samples: 900, freshSamples: 0 }]]);
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
    const w = window(now, 10, { rtt: 400, fresh: true });
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
