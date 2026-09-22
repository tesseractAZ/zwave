import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSymptoms, type DetectInput, type SymptomState } from '../src/zwave/symptoms';
import type { BaselineStore } from '../src/zwave/baselines';
import { NodeStatus, type NodeSnapshot, type ControllerSnapshot } from '../src/types';
import type { EvidenceSample, CoarseBucket } from '../src/zwave/evidenceStore';

const T = 1_000_000_000_000;
const MIN = 60_000;
const CAD = 10_000;               // live evidence cadence
const LIVE_FLOOR = [-104, -104, -101, -93]; // a live GetBackgroundRSSI reading → median -102.5

function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return { nodeId: id, deviceId: 'd' + id, name: `Node ${id}`, area: null, status: NodeStatus.Alive, statusLabel: 'alive', ready: true,
    isRouting: true, isListening: true, isLongRange: false, isController: id === 1, isSecure: true, securityClass: 'S2',
    manufacturer: null, model: null, battery: null, firmware: null, stats: {} as never, entities: [], ...over };
}
const bl = { timeoutNormal: () => ({ rate: 0.02, trials: 500, ready: true, days: 5 }), rttNormal: () => ({ median: 30, scale: 8, ready: true, days: 5 }), rssiNormal: () => null } as unknown as BaselineStore;

interface Ev { at: number; dTx: number; dTimeout?: number; dFlaps?: number }
/** The live profile: a sample every 10 s for the ring's 40 min; counters move only on `events`
 *  (a sweep ping ≈ every 80-120 min on this mesh). rssi is the driver EMA, carried on every sample. */
function sparseRing(now: number, rssi: number, events: Ev[], denseTx = 0): EvidenceSample[] {
  const out: EvidenceSample[] = [];
  for (let t = now - 240 * CAD; t <= now; t += CAD) {
    const es = events.filter((x) => x.at > t - CAD && x.at <= t);
    const e = es.length ? { dTx: es.reduce((a, x) => a + x.dTx, 0), dTimeout: es.reduce((a, x) => a + (x.dTimeout ?? 0), 0), dFlaps: es.reduce((a, x) => a + (x.dFlaps ?? 0), 0) } : null;
    const moved = (!!e && e.dTx > 0) || denseTx > 0; // the store: flap-only / timeout-only intervals are NOT fresh
    out.push({ t, dTx: e ? e.dTx : denseTx, dTimeout: e?.dTimeout ?? 0, dDropTx: 0, dRx: 0, dFlaps: e?.dFlaps ?? 0, dRouteChanges: 0, dS2Resync: 0,
      fresh: moved, rtt: 30, rssi, rateKbps: 100, routeKey: 'direct', status: NodeStatus.Alive, lastSeen: null, isListening: null, isFrequentListening: null });
  }
  return out;
}
function inp(now: number, ring: EvidenceSample[], over: Partial<NodeSnapshot> = {}): DetectInput {
  return { now, nodes: [node(1), node(18, over)], controller: { backgroundRSSI: LIVE_FLOOR } as unknown as ControllerSnapshot, baselines: bl,
    latest: () => ring[ring.length - 1], recent: (id) => (id === 18 ? ring : []), coarse: () => [] as CoarseBucket[], controllerSamples: () => [],
    coverage: () => null, rateRun: () => null, recordingSince: () => T - 30 * 86_400_000, hasRealNoise: () => true } as DetectInput;
}
/** Tick every 10 s for `mins` minutes; return every minute a weak-signal was emitted. */
let lastEvidence: unknown = null;
function run(mk: (now: number) => DetectInput, mins: number): number[] {
  const state: SymptomState = new Map(); const hits: number[] = [];
  for (let s = 0; s <= mins * 6; s++) {
    const now = T + s * CAD;
    const out = detectSymptoms(mk(now), state);
    const ws = out.find((x) => x.kind === 'weak-signal' && x.nodeId === 18); if (ws) lastEvidence = ws.evidence;
    if (ws) hits.push(Math.round((s * CAD) / MIN * 10) / 10);
  }
  return hits;
}


const RSSI = -98; // 4.5 dB over the live -102.5 floor
const flapPair: Ev[] = [{ at: T + 2 * MIN, dTx: 0, dFlaps: 1 }, { at: T + 3 * MIN, dTx: 1, dFlaps: 1 }]; // node 18, 09-21 04:29 MST
const sweepOk: Ev[] = [{ at: T + 2 * MIN, dTx: 1 }];

test('weak-signal (v0.69.0): unmeasured window: thin margin + a Dead flap pair fires ~5 min after the failure, clears when it leaves the 30-min lookback', () => {
  const hits = run((now) => inp(now, sparseRing(now, RSSI, flapPair)), 60);
  console.log('A fired', hits[0], '..', hits[hits.length - 1], 'min; evidence', JSON.stringify(lastEvidence));
  assert.ok(hits.length > 0);
  assert.ok(hits[0] >= 7 && hits[0] <= 8.5, `first fire ${hits[0]}`);           // flap-1 at +2 arms, matures +5 later
  assert.ok(hits[hits.length - 1] <= 33.1, `still firing at ${hits[hits.length - 1]}`); // last failure at +3 → expires ~+33
  assert.ok(hits[hits.length - 1] >= 30, `cleared at ${hits[hits.length - 1]} — the breach must outlive the one fresh sample (+3) by more than WINDOW_MS`);
  assert.match(JSON.stringify(lastEvidence), /failed deliveries.*[12] in 30m \(too few sends for a rate\)/);
});
test('weak-signal (v0.69.0): unmeasured window: a thin margin ALONE (sweep ping answered) never fires — corroboration still required', () => {
  assert.deepEqual(run((now) => inp(now, sparseRing(now, RSSI, sweepOk)), 60), []);
});
test('weak-signal (v0.69.0): the bar is unchanged: node 18 at its live worst ACK (-95 → 7.5 dB) with a failure does not fire', () => {
  assert.deepEqual(run((now) => inp(now, sparseRing(now, -95, flapPair)), 60), []);
});
test('weak-signal (v0.69.0): a MEASURED window decides on its rate: 0 % timeouts + a flap does not fire', () => {
  const ring = (now: number) => sparseRing(now, RSSI, [{ at: T + 2 * MIN, dTx: 0, dFlaps: 1 }], 100);
  assert.deepEqual(run((now) => inp(now, ring(now)), 30), []);
});
test('weak-signal (v0.69.0): never co-fires with node-down: a node that is Dead now is excluded', () => {
  assert.deepEqual(run((now) => inp(now, sparseRing(now, RSSI, flapPair), { status: NodeStatus.Dead }), 30), []);
});
test('weak-signal (v0.69.0): routed node: failure + thin margin still does not fire (last-hop rssi)', () => {
  const ring = (now: number) => sparseRing(now, RSSI, flapPair).map((s) => ({ ...s, routeKey: 'r5' }));
  assert.deepEqual(run((now) => inp(now, ring(now)), 30), []);
});
test('weak-signal (v0.69.0): one unanswered Get (dTimeout) corroborates like a flap', () => {
  const hits = run((now) => inp(now, sparseRing(now, RSSI, [{ at: T + 2 * MIN, dTx: 1, dTimeout: 1 }])), 40);
  assert.ok(hits.length > 0);
});
