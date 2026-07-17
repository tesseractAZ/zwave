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
