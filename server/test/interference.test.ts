import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInterference, type InterferenceInput } from '../src/zwave/interference';
import type { ControllerSample, CoarseBucket } from '../src/zwave/evidenceStore';
import type { Symptom, SymptomKind } from '../src/zwave/symptoms';

const now = 1_700_000_000_000;

function cs(over: Partial<ControllerSample> = {}): ControllerSample {
  return { t: now, dMsgTx: 100, dMsgDroppedTx: 0, dNak: 0, dCan: 0, dTimeoutAck: 0, dTimeoutResponse: 0, fresh: true, bg0: null, bg1: null, bg2: null, bg3: null, ...over };
}
function bucket(hour: number, dTx: number, dTimeout: number): CoarseBucket {
  return { t0: new Date(2026, 0, 15, hour).getTime(), n: 30, freshN: 30, invalidW: 0, dTx, dTimeout, dDropTx: 0, dRx: dTx, flaps: 0, routeChanges: 0, rssiN: 0, rssiSum: 0, rssiMin: null, rssiMax: null, rttN: 0, rttSum: 0, rateMin: null };
}
function sym(kind: SymptomKind, nodeId: number | null): Symptom {
  return { kind, nodeId, severity: 'warn', sinceMs: now - 600_000, basis: 'measured', evidence: [], narrative: `${kind} narrative.` };
}
function inp(over: Partial<InterferenceInput> = {}): InterferenceInput {
  return { now, bgChannels: null, controllerSamples: [], coarseByNode: new Map(), symptoms: [], activeNodes: 0, ...over };
}

test('noise floor = MEDIAN of valid channels (matches the masthead); band classifies', () => {
  const v = computeInterference(inp({ bgChannels: [-101, -103, -103, -95] }));
  assert.equal(v.noise.floor, -102, 'median of [-95,-101,-103,-103] = (-101 + -103)/2 = -102');
  assert.equal(v.noise.real, true);
  assert.equal(v.noise.band, 'clean'); // <= -98
  assert.equal(computeInterference(inp({ bgChannels: [-92, -94, -93, -95] })).noise.band, 'elevated');
  assert.equal(computeInterference(inp({ bgChannels: [-80, -82, -84, -83] })).noise.band, 'noisy');
});

test('no live bg reading → floor null, real false, band unknown; sentinels ignored', () => {
  const v = computeInterference(inp({ bgChannels: null }));
  assert.equal(v.noise.floor, null);
  assert.equal(v.noise.real, false);
  assert.equal(v.noise.band, 'unknown');
  // Positive sentinels (>=125) and non-negative values are not valid RSSI.
  const s = computeInterference(inp({ bgChannels: [127, 126, null, 0] }));
  assert.equal(s.noise.floor, null, 'no valid negative channel → null');
});

test('noise trend is the per-sample median floor over controller samples that carried bg', () => {
  const samples = [cs({ bg0: -101, bg1: -103 }), cs({ bg0: null }), cs({ bg0: -99, bg1: -101 })];
  const v = computeInterference(inp({ controllerSamples: samples }));
  assert.deepEqual(v.noise.trend, [-102, -100], 'only bg-bearing samples; median each');
});

test('serial band: NAK/CAN/timeoutACK drive "strained"; reply-timeout does NOT', () => {
  const span = 2 * 3_600_000; // 2h between first and last sample
  const healthy = [cs({ t: now }), cs({ t: now + span, dTimeoutResponse: 40 })]; // lots of reply-timeouts, no serial faults
  const vh = computeInterference(inp({ controllerSamples: healthy }));
  assert.equal(vh.serial.band, 'healthy', 'reply-timeout is a per-node signal, not a serial fault');
  assert.ok(vh.serial.tmoRespPerH != null && vh.serial.tmoRespPerH > 0, 'but it is still reported');
  const strained = [cs({ t: now }), cs({ t: now + span, dNak: 20 })];
  assert.equal(computeInterference(inp({ controllerSamples: strained })).serial.band, 'strained');
});

test('serial band unknown with fewer than two fresh samples', () => {
  assert.equal(computeInterference(inp({ controllerSamples: [cs()] })).serial.band, 'unknown');
  assert.equal(computeInterference(inp({ controllerSamples: [] })).serial.band, 'unknown');
});

test('diurnal heatmap: raw mesh-wide timeout rate per hour-of-day, summed across nodes', () => {
  const coarse = new Map<number, CoarseBucket[]>();
  // Node 7 + node 8 both have buckets at hour 2 (hot) and hour 14 (cool).
  coarse.set(7, [bucket(2, 100, 20), bucket(14, 100, 1)]);
  coarse.set(8, [bucket(2, 100, 10), bucket(14, 100, 1)]);
  const v = computeInterference(inp({ coarseByNode: coarse }));
  assert.equal(v.diurnal.length, 24);
  // hour 2: (20+10)/(100+100) = 0.15
  assert.ok(Math.abs((v.diurnal[2].rate ?? -1) - 0.15) < 1e-9, `hour 2 rate 0.15, got ${v.diurnal[2].rate}`);
  // hour 14: 2/200 = 0.01
  assert.ok(Math.abs((v.diurnal[14].rate ?? -1) - 0.01) < 1e-9);
  // an hour with no buckets → null (no fabricated rate)
  assert.equal(v.diurnal[9].rate, null);
});

test('diurnal: an hour below the minimum-traffic floor reads null, never a fabricated 0/0', () => {
  const coarse = new Map<number, CoarseBucket[]>([[7, [bucket(3, 5, 0)]]]); // tx 5 < MIN_HOUR_TX (20)
  const v = computeInterference(inp({ coarseByNode: coarse }));
  assert.equal(v.diurnal[3].rate, null, 'trivial traffic → no rate');
  assert.equal(v.diurnal[3].tx, 5, 'but the tx count is preserved');
});

test('coverageDays spans the coarse buckets', () => {
  const coarse = new Map<number, CoarseBucket[]>([[7, [
    { ...bucket(2, 100, 1), t0: new Date(2026, 0, 1, 2).getTime() },
    { ...bucket(2, 100, 1), t0: new Date(2026, 0, 15, 2).getTime() },
  ]]]);
  const v = computeInterference(inp({ coarseByNode: coarse }));
  assert.ok(Math.abs(v.coverageDays - 14) < 0.1, `~14 days, got ${v.coverageDays}`);
});

test('correlated: mesh-interference symptom → active; degradedNodes counts distinct per-node symptoms (not controller)', () => {
  const symptoms = [
    sym('mesh-interference', null),
    sym('return-path-degraded', 7),
    sym('rtt-degraded', 7), // same node → counted once
    sym('weak-signal', 8),
    sym('controller-degraded', null), // excluded
  ];
  const v = computeInterference(inp({ symptoms, activeNodes: 11 }));
  assert.equal(v.correlated.active, true);
  assert.equal(v.correlated.degradedNodes, 2, 'nodes 7 and 8 (rtt on 7 dedups; controller excluded)');
  assert.equal(v.correlated.activeNodes, 11);
  assert.ok(/mesh-interference/.test(v.correlated.narrative));
});

test('correlated: no mesh symptom → inactive with an honest narrative', () => {
  const clean = computeInterference(inp({ symptoms: [] }));
  assert.equal(clean.correlated.active, false);
  assert.ok(/No correlated/.test(clean.correlated.narrative));
  const some = computeInterference(inp({ symptoms: [sym('weak-signal', 5)] }));
  assert.equal(some.correlated.active, false);
  assert.ok(/not correlated/.test(some.correlated.narrative), 'degraded-but-uncorrelated is stated honestly');
});

test('empty input yields sensible defaults (no throw, unknown bands)', () => {
  const v = computeInterference(inp());
  assert.equal(v.noise.band, 'unknown');
  assert.equal(v.serial.band, 'unknown');
  assert.equal(v.diurnal.length, 24);
  assert.equal(v.coverageDays, 0);
  assert.equal(v.correlated.active, false);
});
