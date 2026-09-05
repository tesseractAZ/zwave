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
  const young = new Map([[6, { firstSeenAt: T - 60_000, samples: 5, freshSamples: 0, probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }]]);
  const proven = new Map([[6, { firstSeenAt: T - 5 * 86_400_000, samples: 900, freshSamples: 0, probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }]]);
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

test('rtt-degraded: one old in-window outlier does not arm; a RECENT outlier does', () => {
  const nodes = [node(1), node(6)];
  // Newest FRESH rtt reading is a 300ms outlier — but it is 7 minutes old.
  const stale = [
    ...window(T, 12, { rtt: null, fresh: false }).slice(0, -1),
    ev({ rtt: 300, fresh: true, t: T - 7 * MIN }),
  ];
  const staleInp = (now: number) => input({ nodes, recent: new Map([[6, stale]]), now });
  assert.equal(settle(staleInp, new Map(), T, 6).filter((s) => s.kind === 'rtt-degraded').length, 0, 'a 7-min-old outlier must not arm the dwell');
  // The same outlier kept fresh within the dwell horizon fires.
  const liveInp = (now: number) => input({
    nodes,
    recent: new Map([[6, [...window(now, 12, { rtt: null, fresh: false }).slice(0, -1), ev({ rtt: 300, fresh: true, t: now - MIN })]]]),
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
  const sparse = [ev({ t: T2 - 8 * 60_000, rtt: 300, fresh: true })];
  const inp = (now: number): DetectInput =>
    input({ nodes: [node(9)], recent: new Map([[9, sparse]]), baselines: norm, now });
  detectSymptoms(inp(T2 - 7 * 60_000), new Map()); // arm
  const state: SymptomState = new Map();
  detectSymptoms(inp(T2 - 7 * 60_000), state);
  const out = detectSymptoms(inp(T2 - 60_000), state); // dwell elapsed
  assert.ok(out.some((s) => s.kind === 'rtt-degraded'),
    'a sparsely-reporting node with a sustained bad RTT never surfaced');
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
