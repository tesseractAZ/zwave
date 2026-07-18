import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceStore, COARSE_BUCKET_MS, type EvidenceStoreOptions } from '../src/zwave/evidenceStore';
import { NodeStatus, type NodeStats } from '../src/types';

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zwave-ev-'));
  return join(dir, 'evidence.json');
}

const FIXED = 1_000_000_000_000; // deterministic wall clock
const UP = 3_600_000; // host up 1h — past the boot-grace
const TICK = 10_000; // the sampling cadence the store is configured for

function mkStore(path: string, extra: Partial<EvidenceStoreOptions> = {}) {
  return createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED, uptimeMs: () => UP, ...extra });
}

/** A NodeStats with sensible defaults; override the counters/route per test. */
function stats(over: Partial<NodeStats> = {}): NodeStats {
  return {
    rtt: 30, rssi: -60,
    lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null },
    nlwr: null, commandsTX: 0, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0,
    timeoutResponse: 0, lastSeen: null, ...over,
  };
}

const FRESH = { fresh: true };

/* ── Delta guards — the reason M2 exists ─────────────────────────────────── */

test('first sample for a node has NULL deltas (no baseline yet)', () => {
  const s = mkStore(freshPath());
  const sample = s.record(6, stats({ commandsTX: 100, timeoutResponse: 5 }), NodeStatus.Alive, FRESH, FIXED);
  assert.equal(sample.dTx, null);
  assert.equal(sample.dTimeout, null);
  assert.equal(sample.dDropTx, null);
  assert.equal(sample.dRx, null);
});

test('a second sample yields the correct forward deltas', () => {
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 5, commandsDroppedTX: 1, commandsRX: 90 }), NodeStatus.Alive, FRESH, FIXED);
  const b = s.record(6, stats({ commandsTX: 130, timeoutResponse: 12, commandsDroppedTX: 3, commandsRX: 120 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(b.dTx, 30);
  assert.equal(b.dTimeout, 7);
  assert.equal(b.dDropTx, 2);
  assert.equal(b.dRx, 30);
});

test('RESET GUARD: a backwards counter (driver restart) yields NULL deltas, then re-baselines', () => {
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 500, timeoutResponse: 40 }), NodeStatus.Alive, FRESH, FIXED);
  const after = s.record(6, stats({ commandsTX: 12, timeoutResponse: 1 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(after.dTx, null, 'no fake negative/huge delta across a reset');
  assert.equal(after.dTimeout, null);
  const next = s.record(6, stats({ commandsTX: 20, timeoutResponse: 3 }), NodeStatus.Alive, FRESH, FIXED + 2 * TICK);
  assert.equal(next.dTx, 8);
  assert.equal(next.dTimeout, 2);
});

test('WHOLE-WINDOW invalidation: ONE backwards counter nulls ALL deltas (one driver, one restart)', () => {
  // Design review: per-field nulling let cross-lifetime deltas through — a
  // window that spans a restart is invalid for EVERY counter, including the
  // ones that happen to still read higher than before.
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 40, commandsRX: 500 }), NodeStatus.Alive, FRESH, FIXED);
  const b = s.record(6, stats({ commandsTX: 150, timeoutResponse: 5, commandsRX: 600 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(b.dTimeout, null, 'the backwards counter is null');
  assert.equal(b.dTx, null, 'the still-climbing counter is ALSO null — same invalid window');
  assert.equal(b.dRx, null);
});

test('MAX-WINDOW bound: a gap over ~3 cadences nulls all deltas (not time-attributable)', () => {
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 100 }), NodeStatus.Alive, FRESH, FIXED);
  const late = s.record(6, stats({ commandsTX: 130 }), NodeStatus.Alive, FRESH, FIXED + 10 * TICK);
  assert.equal(late.dTx, null, 'a 100s gap at 10s cadence is not a valid window');
  // and the next regular-cadence sample is valid again.
  const next = s.record(6, stats({ commandsTX: 140 }), NodeStatus.Alive, FRESH, FIXED + 11 * TICK);
  assert.equal(next.dTx, 10);
});

test('PLAUSIBILITY bound: a delta the RF could not physically carry is nulled', () => {
  // The fabrication path: a malformed event coerced to 0 re-baselines, then the
  // next real cumulative value (e.g. 84 000 lifetime commands) lands as one
  // "valid" 10s delta. 84 000 msgs / 10 s >> Z-Wave's ~10-20 msg/s — reject.
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 0 }), NodeStatus.Alive, FRESH, FIXED);
  const fab = s.record(6, stats({ commandsTX: 84_000 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(fab.dTx, null, 'implausible lifetime-sized delta rejected');
});

/* ── Event-derived + instantaneous fields ────────────────────────────────── */

test('flap/route-change accumulators land as concrete per-sample counts', () => {
  const s = mkStore(freshPath());
  const a = s.record(6, stats(), NodeStatus.Alive, { flaps: 3, routeChanges: 2, fresh: true }, FIXED);
  assert.equal(a.dFlaps, 3);
  assert.equal(a.dRouteChanges, 2);
  const b = s.record(6, stats(), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(b.dFlaps, 0, 'defaults to 0 when nothing accumulated');
});

test('fresh flag is recorded; stale samples carry it false', () => {
  const s = mkStore(freshPath());
  assert.equal(s.record(6, stats(), NodeStatus.Alive, { fresh: true }, FIXED).fresh, true);
  assert.equal(s.record(6, stats(), NodeStatus.Alive, { fresh: false }, FIXED + TICK).fresh, false);
  assert.equal(s.record(6, stats(), NodeStatus.Alive, undefined, FIXED + 2 * TICK).fresh, false);
});

test('RSSI error sentinels (≥125) are stored as null, not a fake dBm', () => {
  const s = mkStore(freshPath());
  assert.equal(s.record(6, stats({ rssi: 127 }), NodeStatus.Alive, FRESH, FIXED).rssi, null);
  assert.equal(s.record(6, stats({ rssi: 125 }), NodeStatus.Alive, FRESH, FIXED + TICK).rssi, null);
  assert.equal(s.record(6, stats({ rssi: -70 }), NodeStatus.Alive, FRESH, FIXED + 2 * TICK).rssi, -70);
});

test('route key: direct / repeater chain / null; rate maps to kbps', () => {
  const s = mkStore(freshPath());
  const direct = s.record(6, stats(), NodeStatus.Alive, FRESH, FIXED);
  assert.equal(direct.routeKey, 'direct');
  assert.equal(direct.rateKbps, 100);
  const hopped = s.record(6, stats({ lwr: { repeaters: [7, 9], protocolDataRate: 1, rssi: -70, repeaterRSSI: [], routeFailedBetween: null } }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(hopped.routeKey, 'r7-9');
  assert.equal(hopped.rateKbps, 9.6);
  const noRoute = s.record(6, stats({ lwr: null }), NodeStatus.Alive, FRESH, FIXED + 2 * TICK);
  assert.equal(noRoute.routeKey, null);
  assert.equal(noRoute.rateKbps, null);
});

test('the per-node fine ring is bounded to maxSamples (oldest dropped)', () => {
  const s = mkStore(freshPath(), { maxSamples: 3 });
  for (let i = 0; i < 10; i++) s.record(6, stats({ commandsTX: i * 10 }), NodeStatus.Alive, FRESH, FIXED + i * TICK);
  const ring = s.forNode(6);
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.map((x) => x.t), [FIXED + 7 * TICK, FIXED + 8 * TICK, FIXED + 9 * TICK]);
});

/* ── Coarse tier (the baseline substrate) ────────────────────────────────── */

test('samples fold into 30-min coarse buckets: sums of valid deltas + fresh-only rssi aggregates', () => {
  const s = mkStore(freshPath());
  const t0 = Math.floor(FIXED / COARSE_BUCKET_MS) * COARSE_BUCKET_MS;
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 2, rssi: -60 }), NodeStatus.Alive, FRESH, FIXED);
  s.record(6, stats({ commandsTX: 120, timeoutResponse: 5, rssi: -64 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  // A STALE sample: identical EMA re-recorded — must not pollute rssi aggregates.
  s.record(6, stats({ commandsTX: 120, timeoutResponse: 5, rssi: -64 }), NodeStatus.Alive, { fresh: false }, FIXED + 2 * TICK);
  const buckets = s.coarseForNode(6);
  assert.equal(buckets.length, 1);
  const b = buckets[0];
  assert.equal(b.t0, t0);
  assert.equal(b.n, 3);
  assert.equal(b.freshN, 2);
  assert.equal(b.invalidW, 1, 'the first (baseline-less) sample is an invalid window');
  assert.equal(b.dTx, 20, 'valid deltas summed (20 + 0)');
  assert.equal(b.dTimeout, 3);
  assert.equal(b.rssiN, 2, 'only FRESH rssi observations aggregate');
  assert.equal(b.rssiMin, -64);
  assert.equal(b.rssiMax, -60);
});

test('coarse buckets roll over at the bucket boundary and prune past the horizon', () => {
  const s = mkStore(freshPath(), { coarseHorizonMs: 2 * COARSE_BUCKET_MS });
  s.record(6, stats({ commandsTX: 10 }), NodeStatus.Alive, FRESH, FIXED);
  s.record(6, stats({ commandsTX: 20 }), NodeStatus.Alive, FRESH, FIXED + COARSE_BUCKET_MS);
  s.record(6, stats({ commandsTX: 30 }), NodeStatus.Alive, FRESH, FIXED + 3 * COARSE_BUCKET_MS);
  const buckets = s.coarseForNode(6);
  assert.ok(buckets.length >= 1 && buckets.length <= 2, `pruned to horizon (got ${buckets.length})`);
  assert.equal(buckets[buckets.length - 1].t0, Math.floor((FIXED + 3 * COARSE_BUCKET_MS) / COARSE_BUCKET_MS) * COARSE_BUCKET_MS);
});

/* ── Controller ring ─────────────────────────────────────────────────────── */

test('controller samples run through the same delta + reset guards', () => {
  const s = mkStore(freshPath());
  const ctrl = (over = {}) => ({ messagesTX: 1000, messagesRX: 900, messagesDroppedTX: 1, messagesDroppedRX: 0, NAK: 5, CAN: 2, timeoutACK: 1, timeoutResponse: 3, ...over });
  const a = s.recordController(ctrl(), true, FIXED);
  assert.equal(a.dNak, null, 'first sample: no baseline');
  const b = s.recordController(ctrl({ messagesTX: 1100, NAK: 9 }), true, FIXED + TICK);
  assert.equal(b.dMsgTx, 100);
  assert.equal(b.dNak, 4);
  const reset = s.recordController(ctrl({ messagesTX: 50, NAK: 0 }), true, FIXED + 2 * TICK);
  assert.equal(reset.dMsgTx, null, 'backwards ⇒ whole window null');
  assert.equal(reset.dNak, null);
  assert.equal(b.bg0, null, 'bgRssi reserved (null) until the driver-WS client (v0.13)');
});

/* ── Route failures + coverage ───────────────────────────────────────────── */

test('route failures latch event-driven with a bounded ring', () => {
  const s = mkStore(freshPath());
  for (let i = 0; i < 25; i++) s.recordRouteFailure(6, [7, 9], FIXED + i);
  const ring = s.routeFailures(6);
  assert.equal(ring.length, 20, 'ring bounded');
  assert.deepEqual(ring[ring.length - 1].between, [7, 9]);
});

test('coverage metadata: registerNode + cumulative counts survive ring eviction', () => {
  const s = mkStore(freshPath(), { maxSamples: 2 });
  s.registerNode(6, FIXED);
  for (let i = 0; i < 5; i++) s.record(6, stats({ commandsTX: i }), NodeStatus.Alive, FRESH, FIXED + i * TICK);
  const cov = s.coverage(6)!;
  assert.equal(cov.firstSeenAt, FIXED);
  assert.equal(cov.samples, 5, 'cumulative count, not ring-bounded');
  assert.equal(s.forNode(6).length, 2, 'ring itself is bounded');
  assert.equal(s.recordingSince(), FIXED);
});

/* ── Persistence ─────────────────────────────────────────────────────────── */

test('save → load round-trips EVERY column with null fidelity (fine, coarse, controller, route-fails, coverage)', () => {
  const path = freshPath();
  const s = mkStore(path);
  s.registerNode(6, FIXED);
  // Sample 1: first sample → ALL deltas null; sentinel rssi → null; no route.
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 5, rssi: 127, rtt: null, lwr: null }), NodeStatus.Asleep, { fresh: false }, FIXED);
  // Sample 2: valid deltas, real values, hopped route, events.
  s.record(6, stats({ commandsTX: 140, timeoutResponse: 9, commandsDroppedTX: 2, commandsRX: 130, rssi: -64, rtt: 45.67, lwr: { repeaters: [7, 9], protocolDataRate: 1, rssi: -70, repeaterRSSI: [], routeFailedBetween: null } }), NodeStatus.Alive, { flaps: 1, routeChanges: 2, fresh: true }, FIXED + TICK);
  s.recordController({ messagesTX: 10, messagesRX: 9, messagesDroppedTX: 0, messagesDroppedRX: 0, NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0 }, true, FIXED);
  s.recordController({ messagesTX: 25, messagesRX: 20, messagesDroppedTX: 1, messagesDroppedRX: 0, NAK: 2, CAN: 1, timeoutACK: 0, timeoutResponse: 3 }, true, FIXED + TICK);
  s.recordRouteFailure(6, [7, 9], FIXED);
  s.save();
  const s2 = mkStore(path);
  s2.load();
  const ring = s2.forNode(6);
  assert.equal(ring.length, 2);
  // Full null-fidelity on the first sample.
  assert.deepEqual(
    ring[0],
    { t: FIXED, dTx: null, dTimeout: null, dDropTx: null, dRx: null, dFlaps: 0, dRouteChanges: 0, fresh: false, rtt: null, rssi: null, rateKbps: null, routeKey: null, status: NodeStatus.Asleep, lastSeen: null, isListening: null, isFrequentListening: null },
  );
  // Full value-fidelity on the second (rtt rounded to 0.1 at record time).
  assert.deepEqual(
    ring[1],
    { t: FIXED + TICK, dTx: 40, dTimeout: 4, dDropTx: 2, dRx: 130, dFlaps: 1, dRouteChanges: 2, fresh: true, rtt: 45.7, rssi: -64, rateKbps: 9.6, routeKey: 'r7-9', status: NodeStatus.Alive, lastSeen: null, isListening: null, isFrequentListening: null },
  );
  // Coarse bucket: every aggregate field round-trips.
  const b = s2.coarseForNode(6)[0];
  assert.equal(b.n, 2);
  assert.equal(b.freshN, 1);
  assert.equal(b.invalidW, 1);
  assert.equal(b.dTx, 40);
  assert.equal(b.dTimeout, 4);
  assert.equal(b.flaps, 1);
  assert.equal(b.routeChanges, 2);
  assert.equal(b.rssiN, 1);
  assert.equal(b.rssiMin, -64);
  assert.equal(b.rateMin, 9.6);
  // Controller ring is RESTORED (review: it was write-only before).
  const ctrl = s2.controllerSamples();
  assert.equal(ctrl.length, 2);
  assert.equal(ctrl[1].dMsgTx, 15);
  assert.equal(ctrl[1].dNak, 2);
  assert.equal(ctrl[0].dMsgTx, null, 'controller null-delta fidelity');
  assert.equal(s2.routeFailures(6).length, 1);
  assert.equal(s2.coverage(6)?.samples, 2);
  assert.equal(s2.recordingSince(), FIXED);
});

test('load rejects a wrong-schema file', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: FIXED, nodes: { 6: [] } }));
  const s = mkStore(path);
  s.load();
  assert.equal(s.all().size, 0);
});

test('controller noise-floor coarse tier round-trips (mean/min/max), fresh-only leading-run floor, no-bg samples skipped', () => {
  const path = freshPath();
  const s = mkStore(path);
  const cstat = (over = {}) => ({ messagesTX: 1000, messagesRX: 900, messagesDroppedTX: 0, messagesDroppedRX: 0, NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0, ...over });
  // Two bg readings in the same 30-min bucket. A trailing null ends the driver's
  // leading channel run → each per-sample floor = median of the run.
  s.recordController(cstat(), true, FIXED, [-100, -102, null, null]); // floor = median(-100,-102) = -101
  s.recordController(cstat({ messagesTX: 1010 }), true, FIXED + TICK, [-98, -104, null, null]); // floor = -101
  s.recordController(cstat({ messagesTX: 1020 }), true, FIXED + 2 * TICK, null); // no bg → no floor folded
  s.save();
  const s2 = mkStore(path);
  s2.load();
  const cc = s2.controllerCoarse();
  assert.equal(cc.length, 1, 'all samples share one 30-min bucket');
  assert.equal(cc[0].floorN, 2, 'only the two bg-bearing samples are counted');
  assert.equal(cc[0].floorSum, -202, 'Σ per-sample median floor');
  assert.equal(cc[0].floorMin, -101);
  assert.equal(cc[0].floorMax, -101);
});

test('a pre-tier v2 file (no controllerCoarse key) loads with an empty controller-coarse tier (back-compat)', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 2, savedAt: FIXED, homeId: null, recordingSince: FIXED, nodes: {}, coarse: {}, controller: null, routeFails: {}, meta: {} }));
  const s = mkStore(path);
  s.load();
  assert.equal(s.controllerCoarse().length, 0, 'absent key → empty tier, no crash');
});

test('the controller noise-floor tier survives BOOT-GRACE (multi-day history is not wiped by a power blip)', () => {
  const path = freshPath();
  const writer = mkStore(path);
  writer.recordController({ messagesTX: 1000, messagesRX: 900, messagesDroppedTX: 0, messagesDroppedRX: 0, NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0 }, true, FIXED, [-100, -102, null, null]);
  writer.save();
  const booting = createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED + 60_000, uptimeMs: () => 5_000, bootGraceMs: 180_000 });
  booting.load();
  assert.equal(booting.controllerCoarse().length, 1, 'the persisted noise-floor tier is age-judgment-free history');
  assert.equal(booting.controllerCoarse()[0].floorN, 1);
});

test('a stale snapshot loses the FINE ring but KEEPS the coarse tier (per-tier staleness)', () => {
  const path = freshPath();
  const old = createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED - 2 * 60 * 60 * 1000, uptimeMs: () => UP });
  old.record(6, stats({ commandsTX: 10, rssi: -60 }), NodeStatus.Alive, FRESH, FIXED - 2 * 60 * 60 * 1000);
  old.save();
  const s = mkStore(path); // now() is 2h later; fine maxAge is 1h
  s.load();
  assert.equal(s.forNode(6).length, 0, 'fine ring discarded (2h > 1h maxAge)');
  assert.equal(s.coarseForNode(6).length, 1, 'coarse bucket is valid history, not stale state');
});

test('a future-dated snapshot is discarded entirely (bogus clock at save)', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 2, savedAt: FIXED + 60_000, homeId: null, recordingSince: FIXED, nodes: {}, coarse: { 6: { t0: [FIXED], n: [1], fN: [1], iW: [0], dTx: [1], dTo: [0], dDr: [0], dRx: [0], fl: [0], rc: [0], rN: [1], rS: [-60], rMin: [-60], rMax: [-60], ttN: [0], ttS: [0], rate: [100] } }, controller: null, routeFails: {}, meta: {} }));
  const s = mkStore(path);
  s.load();
  assert.equal(s.coarseForNode(6).length, 0);
});

test('BOOT-GRACE loads the coarse tier + coverage but drops the fine ring (daily power blip must not wipe baselines)', () => {
  const path = freshPath();
  const writer = mkStore(path);
  writer.registerNode(6, FIXED - 1000);
  writer.record(6, stats({ commandsTX: 10, rssi: -60 }), NodeStatus.Alive, FRESH, FIXED);
  writer.save();
  const booting = createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED + 60_000, uptimeMs: () => 5_000, bootGraceMs: 180_000 });
  booting.load();
  assert.equal(booting.forNode(6).length, 0, 'fine ring distrusted under boot-grace');
  assert.equal(booting.coarseForNode(6).length, 1, 'coarse tier survives the power blip');
  assert.equal(booting.coverage(6)?.firstSeenAt, FIXED - 1000, 'coverage survives too');
});

test('BOOT-GRACE with the clock BEHIND savedAt (the no-RTC reboot norm) still keeps the coarse tier', () => {
  // Review (high): the future-dated check ran BEFORE boot-grace, so a restored
  // pre-NTP clock a few minutes behind the last flush wiped 14 days of coarse
  // baselines + coverage on every power blip — the exact loss the grace path
  // exists to prevent.
  const path = freshPath();
  const writer = mkStore(path);
  writer.registerNode(6, FIXED - 1000);
  writer.record(6, stats({ commandsTX: 10, rssi: -60 }), NodeStatus.Alive, FRESH, FIXED);
  writer.save(); // savedAt = FIXED
  const booting = createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED - 4 * 60_000, uptimeMs: () => 5_000, bootGraceMs: 180_000 });
  booting.load();
  assert.equal(booting.coarseForNode(6).length, 1, 'coarse tier survives a behind-savedAt boot clock');
  assert.equal(booting.coverage(6)?.firstSeenAt, FIXED - 1000, 'coverage survives');
  assert.equal(booting.forNode(6).length, 0, 'fine ring still distrusted');
  // Outside grace, a future-dated file IS discarded (clock trusted then).
  const trusted = createEvidenceStore({ path, cadenceMs: TICK, now: () => FIXED - 4 * 60_000, uptimeMs: () => UP, bootGraceMs: 180_000 });
  trusted.load();
  assert.equal(trusted.coarseForNode(6).length, 0, 'future-dated + trusted clock ⇒ discard');
});

test('BACKWARD CLOCK STEP across a bucket boundary never creates duplicate/out-of-order coarse buckets', () => {
  // Review (medium): the fold fast path appended an earlier-t0 bucket after a
  // later one, then a duplicate t0 — corrupting every node ring at once.
  const s = mkStore(freshPath());
  const boundary = (Math.floor(FIXED / COARSE_BUCKET_MS) + 1) * COARSE_BUCKET_MS;
  s.record(6, stats({ commandsTX: 10 }), NodeStatus.Alive, FRESH, boundary - 5_000); // bucket A
  s.record(6, stats({ commandsTX: 20 }), NodeStatus.Alive, FRESH, boundary + 2_000); // bucket B
  s.record(6, stats({ commandsTX: 30 }), NodeStatus.Alive, FRESH, boundary - 3_000); // NTP step-back → bucket A again
  s.record(6, stats({ commandsTX: 40 }), NodeStatus.Alive, FRESH, boundary + 7_000); // forward → bucket B again
  const t0s = s.coarseForNode(6).map((b) => b.t0);
  const sorted = [...t0s].sort((a, b) => a - b);
  assert.deepEqual(t0s, sorted, 'ring stays monotonic');
  assert.equal(new Set(t0s).size, t0s.length, 'no duplicate t0 buckets');
});

test('equal/backwards record() timestamps yield null deltas (windowMs <= 0)', () => {
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 100 }), NodeStatus.Alive, FRESH, FIXED);
  const same = s.record(6, stats({ commandsTX: 110 }), NodeStatus.Alive, FRESH, FIXED);
  assert.equal(same.dTx, null, 'zero-width window is not attributable');
  const back = s.record(6, stats({ commandsTX: 120 }), NodeStatus.Alive, FRESH, FIXED - 1_000);
  assert.equal(back.dTx, null, 'negative window is not attributable');
});

test('a timeout-only coarse bucket IS persisted (worth predicate includes dTimeout/dDropTx)', () => {
  const path = freshPath();
  const s = mkStore(path);
  // Craft a bucket whose only signal is a timeout delta on stale samples:
  // fresh=false, no flaps, no tx growth… only timeoutResponse moved.
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 0 }), NodeStatus.Alive, { fresh: false }, FIXED);
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 4 }), NodeStatus.Alive, { fresh: false }, FIXED + TICK);
  s.save();
  const s2 = mkStore(path);
  s2.load();
  assert.equal(s2.coarseForNode(6).length, 1, 'timeout-only bucket must not be dropped on save');
  assert.equal(s2.coarseForNode(6)[0].dTimeout, 4);
});

test('load survives a corrupt / truncated JSON file (starts fresh, never throws)', () => {
  const path = freshPath();
  writeFileSync(path, '{"v":2,"savedAt":1700000000000,"nodes":{"6":{"t":[17'); // truncated mid-stream
  const s = mkStore(path);
  assert.doesNotThrow(() => s.load());
  assert.equal(s.all().size, 0);
  writeFileSync(path, 'not json at all');
  assert.doesNotThrow(() => s.load());
  assert.equal(s.all().size, 0);
});

test('evictNode removes ALL evidence for a departed node (id reuse starts clean)', () => {
  const s = mkStore(freshPath());
  s.registerNode(6, FIXED);
  s.record(6, stats({ commandsTX: 100 }), NodeStatus.Alive, FRESH, FIXED);
  s.record(6, stats({ commandsTX: 120 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  s.recordRouteFailure(6, [7, 9], FIXED);
  s.evictNode(6);
  assert.equal(s.forNode(6).length, 0);
  assert.equal(s.coarseForNode(6).length, 0);
  assert.equal(s.routeFailures(6).length, 0);
  assert.equal(s.coverage(6), null, 'coverage gone — a reused id must re-earn it');
  // Counter baseline cleared too: the reused id re-baselines (null deltas).
  const post = s.record(6, stats({ commandsTX: 5 }), NodeStatus.Alive, FRESH, FIXED + 2 * TICK);
  assert.equal(post.dTx, null);
});

test('homeId binding: a stick swap while stopped discards the restored evidence', () => {
  const path = freshPath();
  const a = mkStore(path);
  a.bindHomeId(1111);
  a.record(6, stats({ commandsTX: 10 }), NodeStatus.Alive, FRESH, FIXED);
  a.save();
  const b = mkStore(path);
  b.load();
  assert.equal(b.forNode(6).length, 1, 'restored while identity unknown');
  b.bindHomeId(2222); // live poll reveals a DIFFERENT network
  assert.equal(b.forNode(6).length, 0, 'previous network evidence discarded');
  assert.equal(b.coarseForNode(6).length, 0);
  // and the discard is durable — a crash cannot resurrect it.
  const c = mkStore(path);
  c.load();
  assert.equal(c.forNode(6).length, 0, 'reset was written through to disk');
});

test('bindHomeId with the SAME id keeps everything (plain reconnects are not identity changes)', () => {
  const path = freshPath();
  const a = mkStore(path);
  a.bindHomeId(1111);
  a.record(6, stats({ commandsTX: 10 }), NodeStatus.Alive, FRESH, FIXED);
  a.save();
  const b = mkStore(path);
  b.load();
  b.bindHomeId(1111);
  assert.equal(b.forNode(6).length, 1);
});

test('save is dirty-flagged: an unchanged store does not rewrite the file', () => {
  const path = freshPath();
  const s = mkStore(path);
  s.record(6, stats({ commandsTX: 10 }), NodeStatus.Alive, FRESH, FIXED);
  s.save();
  const stamp1 = readFileSync(path, 'utf8');
  writeFileSync(path, stamp1 + ' '); // perturb on disk
  s.save(); // nothing recorded since — must be a no-op
  assert.equal(readFileSync(path, 'utf8'), stamp1 + ' ', 'no rewrite when clean');
});

test('SIZE BUDGET (enforced, not asserted): a GENUINELY worst-case node stays bounded', () => {
  // Review: the earlier version of this test under-populated columns and the
  // budget number was fiction. This one fills EVERY column with maximal-width
  // values: 6-digit lifetime counters, fractional rtt, hopped route keys,
  // multiple samples per coarse bucket so all aggregates are non-trivial.
  const path = freshPath();
  const s = mkStore(path, { coarseHorizonMs: 14 * 24 * 60 * 60 * 1000 });
  const start = FIXED - 14 * 24 * 60 * 60 * 1000;
  let tx = 900_000, rx = 800_000, to = 90_000, dr = 10_000;
  for (let b = 0; b < 672; b++) {
    for (let k = 0; k < 3; k++) { // 3 samples per bucket → real sums/mins/maxes
      const t = start + b * COARSE_BUCKET_MS + k * TICK;
      tx += 180; rx += 150; to += 12; dr += 3;
      s.record(1, stats({
        commandsTX: tx, commandsRX: rx, timeoutResponse: to, commandsDroppedTX: dr,
        rssi: -60 - (b % 35), rtt: 123.4 + (b % 50),
        lwr: { repeaters: [17, 23, 31], protocolDataRate: 1, rssi: -70, repeaterRSSI: [], routeFailedBetween: null },
      }), NodeStatus.Alive, { flaps: 2, routeChanges: 2, fresh: true }, t);
    }
  }
  for (let i = 0; i < 240; i++) {
    tx += 180; rx += 150; to += 12; dr += 3;
    s.record(1, stats({
      commandsTX: tx, commandsRX: rx, timeoutResponse: to, commandsDroppedTX: dr,
      rssi: -87, rtt: 456.7,
      lwr: { repeaters: [17, 23, 31], protocolDataRate: 1, rssi: -70, repeaterRSSI: [], routeFailedBetween: null },
    }), NodeStatus.Alive, { flaps: 1, routeChanges: 1, fresh: true }, FIXED - (240 - i) * TICK);
  }
  for (let i = 0; i < 20; i++) s.recordRouteFailure(1, [17, 23], FIXED - i * TICK);
  s.save();
  const bytes = readFileSync(path, 'utf8').length;
  assert.ok(bytes < 80_000, `one worst-case node serialized to ${bytes}B — budget is 80KB/node (≈3MB @ 39 nodes, documented linear scaling)`);
});

test('load drops malformed columnar entries but keeps well-formed ones', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({
    v: 2, savedAt: FIXED, homeId: null, recordingSince: FIXED,
    nodes: {
      6: { t: [FIXED], dTx: [5], dTo: [1], dDr: [0], dRx: [3], dF: [0], dRC: [0], fr: [1], rtt: [30], rssi: [-60], rate: [100], rk: ['direct'], st: [4], ls: [null] },
      7: { t: ['bogus'], dTx: [1] }, // malformed t → sample dropped, node empty
      0: { t: [FIXED] }, // invalid node id → dropped
    },
    coarse: {}, controller: null, routeFails: {}, meta: {},
  }));
  const s = mkStore(path);
  s.load();
  assert.equal(s.forNode(6).length, 1);
  assert.equal(s.forNode(6)[0].dTx, 5);
  assert.equal(s.forNode(7).length, 0);
  assert.equal(s.all().size, 1);
});

test('reset() drops rings AND counter baselines (post-reset first sample re-baselines)', () => {
  const s = mkStore(freshPath());
  s.record(6, stats({ commandsTX: 100, timeoutResponse: 5 }), NodeStatus.Alive, FRESH, FIXED);
  s.record(6, stats({ commandsTX: 130, timeoutResponse: 9 }), NodeStatus.Alive, FRESH, FIXED + TICK);
  assert.equal(s.forNode(6).length, 2);
  s.reset();
  assert.equal(s.forNode(6).length, 0);
  assert.equal(s.all().size, 0);
  const post = s.record(6, stats({ commandsTX: 200, timeoutResponse: 12 }), NodeStatus.Alive, FRESH, FIXED + 2 * TICK);
  assert.equal(post.dTx, null, 'baselines cleared — no bogus delta leaks across the reset');
});
