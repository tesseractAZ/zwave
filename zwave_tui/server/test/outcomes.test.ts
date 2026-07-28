import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createOutcomeStore, windowMetrics, planEpisodeLifecycle, type WindowMetrics } from '../src/zwave/outcomes';
import type { EvidenceSample } from '../src/zwave/evidenceStore';
import type { SymptomKind } from '../src/zwave/symptoms';

// A window with plenty of traffic; rate = timeouts/tx. Extra recovery signals
// default to "no data" so the timeout-metric tests are unaffected.
const W = (tx: number, timeouts: number, rx = tx, over: Partial<WindowMetrics> = {}): WindowMetrics =>
  ({ tx, rx, timeouts, rate: tx >= 5 ? timeouts / tx : null, samples: 6, freshN: 6, flaps: 0,
     rssiMedian: null, rssiN: 0, rttMedian: null, rttN: 0, rateKbpsMin: null, ...over });
// Windows that carry a specific non-timeout recovery signal, with enough observations
// of THAT signal to clear its evidence floor (MIN_OBS / MIN_LIVE = 3).
const WF = (flaps: number): WindowMetrics => W(50, 0, 50, { flaps, freshN: 6 }); // dead-flap (after-window is live)
const WR = (rssiMedian: number): WindowMetrics => W(50, 0, 50, { rssiMedian, rssiN: 6, freshN: 6 }); // weak-signal
const WT = (rttMedian: number): WindowMetrics => W(50, 0, 50, { rttMedian, rttN: 6, freshN: 6 }); // rtt-degraded
const WK = (rateKbpsMin: number): WindowMetrics => W(50, 0, 50, { rateKbpsMin, freshN: 6 }); // rate-fallback
const store = () => createOutcomeStore({ releaseRate: 0.075, minEffect: 0.05, minEpisodes: 4, decay: 0 }); // decay 0 = exact counting for tests

test('windowMetrics sums deltas and leaves rate null below the tx floor (never a fabricated 0/0)', () => {
  const s = (dTx: number, dTimeout: number, dRx = dTx): EvidenceSample => ({ dTx, dTimeout, dRx } as unknown as EvidenceSample);
  const busy = windowMetrics([s(50, 5), s(50, 5)]);
  assert.equal(busy.tx, 100);
  assert.equal(busy.timeouts, 10);
  assert.equal(busy.rate, 0.1);
  const quiet = windowMetrics([s(2, 0)]); // tx below the floor
  assert.equal(quiet.rate, null, 'no rate on trivial traffic');
});

test('windowMetrics: flaps fold over ALL samples; rssi/rtt/rate are FRESH-only (a stale carry-forward is not an observation)', () => {
  // Full samples so the defensive guards see real fields (dFlaps non-null, fresh flag honoured).
  const es = (o: Partial<EvidenceSample>): EvidenceSample =>
    ({ dTx: 10, dRx: 10, dTimeout: 0, dDropTx: 0, dFlaps: 0, dRouteChanges: 0,
       fresh: false, rtt: null, rssi: null, rateKbps: null, ...o } as EvidenceSample);
  const m = windowMetrics([
    es({ dFlaps: 2, fresh: true,  rssi: -90, rtt: 200, rateKbps: 100 }),
    es({ dFlaps: 1, fresh: false, rssi: -50, rtt: 10,  rateKbps: 40 }),  // NOT fresh → rssi/rtt/rate ALL ignored…
    es({ dFlaps: 3, fresh: true,  rssi: -80, rtt: 120, rateKbps: 100 }), // …but dFlaps still folds
  ]);
  assert.equal(m.flaps, 6, 'flaps accumulate across every sample, fresh or not');
  assert.equal(m.freshN, 2, 'two fresh samples');
  assert.equal(m.rssiMedian, -85, 'median of the two FRESH rssi (−90, −80); the −50 stale read is excluded');
  assert.equal(m.rssiN, 2, 'two fresh rssi observations behind the median');
  assert.equal(m.rttMedian, 160, 'median of the two FRESH rtt (200, 120); the stale 10 is excluded');
  assert.equal(m.rttN, 2, 'two fresh rtt observations behind the median');
  assert.equal(m.rateKbpsMin, 100, 'worst FRESH negotiated rate (100); the stale non-fresh 40 does NOT count');
});

test('windowMetrics: a window with only STALE (non-fresh) samples yields null rssi/rtt/rate — never a stale-derived metric', () => {
  const stale = (o: Partial<EvidenceSample>): EvidenceSample =>
    ({ dTx: 10, dRx: 10, dTimeout: 0, dDropTx: 0, dFlaps: 0, dRouteChanges: 0,
       fresh: false, rtt: 12, rssi: -70, rateKbps: 40, ...o } as EvidenceSample);
  const m = windowMetrics([stale({}), stale({}), stale({})]); // node went quiet: every read is a carry-forward
  assert.equal(m.freshN, 0);
  assert.equal(m.rssiMedian, null, 'no fresh rssi → null, not the stale −70');
  assert.equal(m.rttMedian, null, 'no fresh rtt → null, not the stale 12');
  assert.equal(m.rateKbpsMin, null, 'no fresh rate → null, not the stale 40 (would otherwise fabricate a verdict)');
  assert.equal(m.rssiN, 0);
  assert.equal(m.rttN, 0);
});

test('windowMetrics: a legacy/persisted sample missing dFlaps folds without NaN', () => {
  const legacy = { dTx: 10, dRx: 10, dTimeout: 0 } as unknown as EvidenceSample; // pre-dFlaps shape
  const m = windowMetrics([legacy]);
  assert.equal(m.flaps, 0, 'a missing dFlaps contributes 0, never NaN');
  assert.equal(m.rssiMedian, null);
  assert.equal(m.rttMedian, null);
  assert.equal(m.rateKbpsMin, null);
});

test('control arm: a symptom that resolves with NO action builds the spontaneous-recovery base rate', () => {
  const o = store();
  // 5 no-action episodes: 3 self-heal (improved), 2 stay bad (no-change).
  for (let i = 0; i < 3; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 20)); o.resolve(i, 'return-path-degraded', 2000, W(100, 2)); }
  for (let i = 3; i < 5; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 20)); o.resolve(i, 'return-path-degraded', 2000, W(100, 18)); }
  const base = o.baseRate('return-path-degraded');
  assert.ok(base != null && Math.abs(base - 3 / 5) < 1e-9, `base rate 3/5, got ${base}`);
});

test('base rate is null until minEpisodes are seen (no confident claim from n=1)', () => {
  const o = store();
  o.open(1, 'return-path-degraded', 1000, W(100, 20)); o.resolve(1, 'return-path-degraded', 2000, W(100, 1));
  assert.equal(o.baseRate('return-path-degraded'), null, 'one episode is not a base rate');
});

test('action arm: expectedEfficacy stays NULL until the action beats self-healing by the effect size', () => {
  const o = store();
  // Establish a HIGH self-healing base rate: 4/4 no-action episodes improved.
  for (let i = 0; i < 4; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 20)); o.resolve(i, 'return-path-degraded', 2000, W(100, 1)); }
  assert.equal(o.baseRate('return-path-degraded'), 1, 'base rate 100% self-healing');
  // 4 action episodes that also improve — but they cannot BEAT a 100% base rate.
  for (let i = 10; i < 14; i++) {
    o.open(i, 'return-path-degraded', 1000, W(100, 20));
    o.recordAction(i, 'refreshValues', false, 1500);
    o.resolve(i, 'return-path-degraded', 2000, W(100, 1));
  }
  const eff = o.efficacyFor('return-path-degraded', 'refreshValues');
  assert.equal(eff.expectedEfficacy, null, 'cannot beat 100% self-healing → efficacy null');
  assert.equal(eff.beatsSelfHealing, false);
  assert.ok(eff.n >= 4, 'but the episode count is surfaced');
});

test('action arm: efficacy is offered once the action clears the base rate + effect size', () => {
  const o = store();
  // LOW self-healing base: 1/4 no-action improved (25%).
  o.open(0, 'return-path-degraded', 1000, W(100, 40)); o.resolve(0, 'return-path-degraded', 2000, W(100, 1));
  for (let i = 1; i < 4; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 40)); o.resolve(i, 'return-path-degraded', 2000, W(100, 38)); }
  assert.ok(Math.abs((o.baseRate('return-path-degraded') ?? 0) - 0.25) < 1e-9);
  // Action arm: 4/4 improved after a ping → 100% ≫ 25% + 5%.
  for (let i = 10; i < 14; i++) {
    o.open(i, 'return-path-degraded', 1000, W(100, 40));
    o.recordAction(i, 'ping', false, 1500);
    o.resolve(i, 'return-path-degraded', 2000, W(100, 1));
  }
  const eff = o.efficacyFor('return-path-degraded', 'ping');
  assert.ok(eff.beatsSelfHealing, 'action beats self-healing');
  assert.ok(eff.expectedEfficacy != null && eff.expectedEfficacy > 0.9, `efficacy ~1.0, got ${eff.expectedEfficacy}`);
  assert.ok(eff.baseRate != null && eff.baseRate < 0.3, 'base rate surfaced for context');
});

test('efficacy CANNOT claim to beat self-healing with no measured control arm (base rate null)', () => {
  const o = store();
  // 4 action episodes, ALL improved — but ZERO no-action episodes → base unknown.
  for (let i = 0; i < 4; i++) {
    o.open(i, 'return-path-degraded', 1000, W(100, 40));
    o.recordAction(i, 'refreshValues', false, 1500);
    o.resolve(i, 'return-path-degraded', 2000, W(100, 1));
  }
  const eff = o.efficacyFor('return-path-degraded', 'refreshValues');
  assert.equal(o.baseRate('return-path-degraded'), null, 'no control arm measured');
  assert.equal(eff.ready, true, 'enough attempts to have an opinion');
  assert.equal(eff.beatsSelfHealing, false, 'but cannot BEAT an unmeasured base rate');
  assert.equal(eff.expectedEfficacy, null, 'so no efficacy claim — "not distinguishable"');
});

test('refused action → refused-misdiagnosis, keyed to the SYMPTOM, never counted as efficacy', () => {
  const o = store();
  for (let i = 0; i < 4; i++) {
    o.open(i, 'ghost-suspect', 1000, W(100, 40));
    o.recordAction(i, 'removeFailed', true /* refused */, 1500);
    const ep = o.resolve(i, 'ghost-suspect', 2000, W(100, 1));
    assert.equal(ep?.verdict, 'refused-misdiagnosis');
  }
  assert.equal(o.falsePositives('ghost-suspect'), 4, 'detector false-positive tally rises');
  const eff = o.efficacyFor('ghost-suspect', 'removeFailed');
  assert.equal(eff.n, 0, 'refusals contribute NOTHING to action efficacy');
  assert.equal(eff.expectedEfficacy, null);
});

test('unverifiable: an after-window with incomparable traffic cannot be scored (either direction)', () => {
  const o = store();
  // Before: busy (tx 100). After: mesh went quiet (tx 8) — 100/8 > 3× → not comparable.
  o.open(1, 'return-path-degraded', 1000, W(100, 30));
  const ep = o.resolve(1, 'return-path-degraded', 2000, W(8, 0));
  assert.equal(ep?.verdict, 'unverifiable');
  // Contributes to NEITHER arm.
  assert.equal(o.baseRate('return-path-degraded'), null);
});

test('unverifiable: a null-rate window (no traffic at all) is not improvement', () => {
  const o = store();
  o.open(1, 'rtt-degraded', 1000, W(100, 30));
  const ep = o.resolve(1, 'rtt-degraded', 2000, W(2, 0)); // tx below floor → rate null
  assert.equal(ep?.verdict, 'unverifiable');
});

test('worse: a rate that climbed past the WORSE factor is recorded as a regression', () => {
  const o = store();
  o.open(1, 'return-path-degraded', 1000, W(100, 10)); // before rate 0.10
  const ep = o.resolve(1, 'return-path-degraded', 2000, W(100, 40)); // after 0.40 > 0.10*1.5 and > release
  assert.equal(ep?.verdict, 'worse');
});

test('improved requires BOTH the release threshold AND the minimum effect size', () => {
  const o = store();
  // Drops from 0.10 → 0.06: under release (0.075) but only a 0.04 effect (< 0.05) → no-change.
  o.open(1, 'return-path-degraded', 1000, W(100, 10));
  assert.equal(o.resolve(1, 'return-path-degraded', 2000, W(100, 6))?.verdict, 'no-change');
  // Drops from 0.30 → 0.05: clears release AND a 0.25 effect → improved.
  o.open(2, 'return-path-degraded', 1000, W(100, 30));
  assert.equal(o.resolve(2, 'return-path-degraded', 2000, W(100, 5))?.verdict, 'improved');
});

// ── Per-kind recovery metrics: each kind is scored by the signal its fix moves ──
test('dead-flap is scored by FLAPS: a clean after-window (0 flaps) is improved, more flaps is worse', () => {
  const o = store();
  o.open(7, 'dead-flap', 1000, WF(6)); assert.equal(o.resolve(7, 'dead-flap', 2000, WF(0))?.verdict, 'improved');
  o.open(8, 'dead-flap', 1000, WF(6)); assert.equal(o.resolve(8, 'dead-flap', 2000, WF(3))?.verdict, 'no-change'); // still flapping
  o.open(9, 'dead-flap', 1000, WF(2)); assert.equal(o.resolve(9, 'dead-flap', 2000, WF(5))?.verdict, 'worse');
  // A timeout-rate drop must NOT count as a dead-flap recovery (wrong metric).
  o.open(10, 'dead-flap', 1000, W(100, 40, 100, { flaps: 4 }));
  assert.equal(o.resolve(10, 'dead-flap', 2000, W(100, 1, 100, { flaps: 4 }))?.verdict, 'no-change', 'timeout drop ≠ flap recovery');
});

test('weak-signal is scored by RSSI: a ≥4 dB gain is improved, a ≥4 dB drop is worse', () => {
  const o = store();
  o.open(7, 'weak-signal', 1000, WR(-90)); assert.equal(o.resolve(7, 'weak-signal', 2000, WR(-84))?.verdict, 'improved'); // +6 dB
  o.open(8, 'weak-signal', 1000, WR(-90)); assert.equal(o.resolve(8, 'weak-signal', 2000, WR(-88))?.verdict, 'no-change'); // +2 dB
  o.open(9, 'weak-signal', 1000, WR(-84)); assert.equal(o.resolve(9, 'weak-signal', 2000, WR(-90))?.verdict, 'worse'); // -6 dB
  // No fresh RSSI readings → unverifiable, never a fabricated verdict.
  o.open(10, 'weak-signal', 1000, WR(-90));
  assert.equal(o.resolve(10, 'weak-signal', 2000, W(50, 0, 50, { rssiMedian: null }))?.verdict, 'unverifiable');
});

test('rtt-degraded is scored by RTT: a ≥25% AND ≥20 ms drop is improved', () => {
  const o = store();
  o.open(7, 'rtt-degraded', 1000, WT(200)); assert.equal(o.resolve(7, 'rtt-degraded', 2000, WT(120))?.verdict, 'improved'); // 40% + 80 ms
  o.open(8, 'rtt-degraded', 1000, WT(200)); assert.equal(o.resolve(8, 'rtt-degraded', 2000, WT(190))?.verdict, 'no-change'); // 5%
  o.open(9, 'rtt-degraded', 1000, WT(100)); assert.equal(o.resolve(9, 'rtt-degraded', 2000, WT(180))?.verdict, 'worse'); // ≥1.5×
});

test('rate-fallback is scored by NEGOTIATED RATE: 40k→100k is improved, dropping further is worse', () => {
  const o = store();
  o.open(7, 'rate-fallback', 1000, WK(40)); assert.equal(o.resolve(7, 'rate-fallback', 2000, WK(100))?.verdict, 'improved');
  o.open(8, 'rate-fallback', 1000, WK(40)); assert.equal(o.resolve(8, 'rate-fallback', 2000, WK(40))?.verdict, 'no-change');
  o.open(9, 'rate-fallback', 1000, WK(40)); assert.equal(o.resolve(9, 'rate-fallback', 2000, WK(9.6))?.verdict, 'worse');
});

test('a kind with no per-node recovery metric (chatty-device) is always unverifiable', () => {
  const o = store();
  o.open(7, 'chatty-device', 1000, W(100, 40)); // even a big timeout drop
  assert.equal(o.resolve(7, 'chatty-device', 2000, W(100, 1))?.verdict, 'unverifiable');
});

// ── Per-signal evidence floors: each metric gates on observations of ITS OWN
// signal, not a shared fresh-sample count (v0.19 review) ──
test('weak-signal: a median built from too few rssi readings (rssiN < MIN_OBS) is unverifiable, even with plenty of fresh samples', () => {
  const o = store();
  // freshN is high (the node communicated), but only ONE fresh sample carried a
  // non-null rssi (the rest hit the no-signal sentinel) → a median of n=1 must
  // NOT drive a verdict.
  const oneReading = (rssiMedian: number): WindowMetrics => W(50, 0, 50, { rssiMedian, rssiN: 1, freshN: 6 });
  o.open(7, 'weak-signal', 1000, oneReading(-90));
  assert.equal(o.resolve(7, 'weak-signal', 2000, oneReading(-84))?.verdict, 'unverifiable', 'one reading per side is not evidence');
  // Same +6 dB gain, but with MIN_OBS readings behind each median → now scorable.
  o.open(8, 'weak-signal', 1000, WR(-90));
  assert.equal(o.resolve(8, 'weak-signal', 2000, WR(-84))?.verdict, 'improved');
});

test('rtt-degraded: a median built from too few rtt readings (rttN < MIN_OBS) is unverifiable', () => {
  const o = store();
  const oneReading = (rttMedian: number): WindowMetrics => W(50, 0, 50, { rttMedian, rttN: 1, freshN: 6 });
  o.open(7, 'rtt-degraded', 1000, oneReading(200));
  assert.equal(o.resolve(7, 'rtt-degraded', 2000, oneReading(120))?.verdict, 'unverifiable', 'one reading per side is not evidence');
});

test('rate-fallback: a purely-stale (quiet) after-window has null rateKbpsMin → unverifiable, never a stale-derived verdict', () => {
  const o = store();
  // The node went quiet after the fix: no fresh negotiated-rate reading landed in
  // the after-window, so rateKbpsMin is null. A sticky pre-fix 40k must NOT be
  // scored as evidence.
  o.open(7, 'rate-fallback', 1000, WK(40));
  assert.equal(o.resolve(7, 'rate-fallback', 2000, W(50, 0, 50, { rateKbpsMin: null }))?.verdict, 'unverifiable');
});

test('dead-flap: a fresh-poor but genuinely-flapping before-window is NOT dropped — the before-window needs only prior flapping', () => {
  const o = store();
  // A mostly-Dead flapping node emits few fresh stats events in the onset window
  // (freshN low), but its flap COUNT is concrete. Recovery must still register
  // when the after-window is clean AND live.
  const flappyOnset = W(50, 0, 50, { flaps: 6, freshN: 1 }); // real flapping, few fresh reads
  const healedLive = W(50, 0, 50, { flaps: 0, freshN: 6 }); // recovered, communicating
  o.open(7, 'dead-flap', 1000, flappyOnset);
  assert.equal(o.resolve(7, 'dead-flap', 2000, healedLive)?.verdict, 'improved');
});

test('dead-flap: a node that went HARD-DEAD after (0 flaps but 0 fresh liveness) is unverifiable, not a fabricated recovery', () => {
  const o = store();
  const flappyOnset = W(50, 0, 50, { flaps: 6, freshN: 6 });
  const silent = W(50, 0, 50, { flaps: 0, freshN: 0 }); // 0 flaps ONLY because it stopped transitioning — dead, not healed
  o.open(7, 'dead-flap', 1000, flappyOnset);
  assert.equal(o.resolve(7, 'dead-flap', 2000, silent)?.verdict, 'unverifiable', 'no after-liveness → cannot claim recovery');
});

test('open is idempotent per key; abandon drops without a verdict; openKeys tracks lifecycle', () => {
  const o = store();
  o.open(7, 'dead-flap', 1000, W(100, 40));
  o.open(7, 'dead-flap', 1500, W(50, 20)); // second open ignored
  assert.deepEqual(o.openKeys(), ['7:dead-flap']);
  o.abandon(7, 'dead-flap');
  assert.deepEqual(o.openKeys(), []);
  assert.equal(o.resolve(7, 'dead-flap', 2000, W(100, 1)), null, 'resolving an abandoned episode is a no-op');
});

test('an action with no matching open symptom is not an episode datum', () => {
  const o = store();
  o.recordAction(9, 'ping', false, 1000); // no open episode
  o.open(9, 'dead-flap', 1100, W(100, 40));
  const ep = o.resolve(9, 'dead-flap', 2000, W(100, 1));
  assert.equal(ep?.action, null, 'the stray action was not attributed');
});

test('a node-scoped action attributes to ALL that node’s open episodes (not just one kind)', () => {
  const o = store();
  // Node 7 has TWO active symptoms; one operator ping targets the node.
  o.open(7, 'return-path-degraded', 1000, W(100, 40));
  o.open(7, 'chronic-return-path', 1000, W(100, 40));
  o.open(8, 'quiet-node', 1000, W(100, 40)); // a different node — must NOT be touched
  o.recordAction(7, 'ping', false, 1500);
  // Both of node 7's episodes resolve improved → both credit ping.
  o.resolve(7, 'return-path-degraded', 2000, W(100, 1));
  o.resolve(7, 'chronic-return-path', 2000, W(100, 1));
  // Node 8 resolves with NO action (the ping wasn't for it) → control arm.
  o.resolve(8, 'quiet-node', 2000, W(100, 1));
  assert.equal(o.efficacyFor('return-path-degraded', 'ping').n, 1, 'return-path episode credited ping');
  assert.equal(o.efficacyFor('chronic-return-path', 'ping').n, 1, 'chronic-return-path episode credited ping');
  assert.equal(o.efficacyFor('quiet-node', 'ping').n, 0, 'node 8 was NOT credited the ping');
});

test('an action is NOT credited to an episode already in the confirmation window (skip predicate)', () => {
  const o = store();
  o.open(7, 'dead-flap', 1000, W(100, 40));
  // The symptom went absent; the caller marks its key as "pending resolution".
  o.recordAction(7, 'ping', false, 1500, (key) => key === '7:dead-flap');
  const ep = o.resolve(7, 'dead-flap', 2000, W(100, 1));
  assert.equal(ep?.action, null, 'the action taken during recovery was not credited');
  // Same setup WITHOUT skipping → the action IS attributed.
  const o2 = store();
  o2.open(7, 'dead-flap', 1000, W(100, 40));
  o2.recordAction(7, 'ping', false, 1500);
  assert.equal(o2.resolve(7, 'dead-flap', 2000, W(100, 1))?.action?.kind, 'ping');
});

test('openEpisodes exposes (key,nodeId,kind) for the confirmation-window resolution loop', () => {
  const o = store();
  o.open(7, 'rtt-degraded', 1000, W(100, 40));
  o.open(null, 'mesh-interference', 1000, null);
  const eps = o.openEpisodes().sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(eps, [
    { key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' },
    { key: 'mesh:mesh-interference', nodeId: null, kind: 'mesh-interference' },
  ]);
});

test('persistence round-trips the learned arms and rejects a corrupt tally', () => {
  const o = store();
  for (let i = 0; i < 4; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 40)); o.resolve(i, 'return-path-degraded', 2000, W(100, 1)); }
  assert.equal(o.baseRate('return-path-degraded'), 1, 'arm is non-trivially populated before round-trip');
  const saved = JSON.parse(JSON.stringify(o.toJSON()));
  const o2 = store();
  o2.loadJSON(saved);
  assert.equal(o2.baseRate('return-path-degraded'), o.baseRate('return-path-degraded'), 'base rate survives a round-trip');
  // A corrupt tally (ok > n) is dropped, not loaded.
  const o3 = store();
  o3.loadJSON({ v: 1, control: [['dead-flap', { n: 2, ok: 9 }]], action: [], fp: [] });
  assert.equal(o3.baseRate('dead-flap'), null, 'garbage tally rejected');
});

// ── planEpisodeLifecycle: the confirmation-window decision (the HIGH-value gap) ──
type Sym = { nodeId: number | null; kind: SymptomKind; subsumedBy?: string | null };
const openEp = (nodeId: number | null, kind: SymptomKind) => ({ key: `${nodeId ?? 'mesh'}:${kind}`, nodeId, kind });

test('lifecycle: a new non-subsumed symptom is opened; a subsumed one opens NO episode', () => {
  const syms: Sym[] = [
    { nodeId: 7, kind: 'rtt-degraded' },
    { nodeId: 8, kind: 'weak-signal', subsumedBy: 'mesh-1' },
  ];
  const { toOpen } = planEpisodeLifecycle(syms, [], new Map(), 1000, 600_000);
  assert.deepEqual(toOpen, [{ nodeId: 7, kind: 'rtt-degraded' }], 'only the independent symptom opens');
});

test('lifecycle: an absent symptom is NOT resolved until it stays gone through the confirm window', () => {
  const open = [openEp(7, 'dead-flap')];
  const pending = new Map<string, number>();
  const confirm = 600_000;
  // Tick 1: symptom absent → pending timer starts, nothing resolves yet.
  let r = planEpisodeLifecycle([], open, pending, 1_000, confirm);
  assert.equal(r.toResolve.length, 0, 'a blink of absence does not resolve');
  assert.equal(pending.get('7:dead-flap'), 1_000);
  // Tick 2: still absent but before the window elapses → still pending.
  r = planEpisodeLifecycle([], open, pending, 1_000 + confirm - 1, confirm);
  assert.equal(r.toResolve.length, 0);
  // Tick 3: absent past the window → resolve, pending cleared.
  r = planEpisodeLifecycle([], open, pending, 1_000 + confirm, confirm);
  assert.deepEqual(r.toResolve, [{ nodeId: 7, kind: 'dead-flap', key: '7:dead-flap' }]);
  assert.equal(pending.has('7:dead-flap'), false, 'pending cleared on resolve');
});

test('lifecycle: a symptom that becomes SUBSUMED (still present) is NOT resolved — subsumption ≠ recovery', () => {
  const open = [openEp(8, 'weak-signal')];
  const pending = new Map<string, number>();
  const confirm = 600_000;
  // The symptom is now subsumed under a mesh event but STILL present.
  const syms: Sym[] = [{ nodeId: 8, kind: 'weak-signal', subsumedBy: 'mesh-1' }];
  const r = planEpisodeLifecycle(syms, open, pending, 1_000, confirm);
  assert.equal(r.toResolve.length, 0, 'a subsumed-but-present symptom does not resolve');
  assert.equal(pending.has('8:weak-signal'), false, 'and it is treated as live (no pending timer)');
  assert.equal(r.toOpen.length, 0, 'nor re-opened (already open)');
  // Even well past the confirm window, still present-but-subsumed → still open.
  const r2 = planEpisodeLifecycle(syms, open, pending, 1_000 + confirm * 2, confirm);
  assert.equal(r2.toResolve.length, 0, 'still not resolved while present');
});

test('lifecycle: a symptom that REAPPEARS inside the window cancels its pending resolution', () => {
  const open = [openEp(7, 'dead-flap')];
  const pending = new Map<string, number>();
  const confirm = 600_000;
  planEpisodeLifecycle([], open, pending, 1_000, confirm); // absent → pending
  assert.equal(pending.has('7:dead-flap'), true);
  const r = planEpisodeLifecycle([{ nodeId: 7, kind: 'dead-flap' }], open, pending, 1_500, confirm); // back
  assert.equal(pending.has('7:dead-flap'), false, 'reappearance clears pending');
  assert.equal(r.toResolve.length, 0, 'and it is not resolved');
  assert.equal(r.toOpen.length, 0, 'nor re-opened (already open)');
});

test('fs load/save persists the learned arms atomically across a restart', () => {
  const path = join(tmpdir(), `zwave-outcomes-test-${process.pid}.json`);
  rmSync(path, { force: true });
  try {
    const a = createOutcomeStore({ path, minEpisodes: 4, decay: 0 });
    for (let i = 0; i < 4; i++) { a.open(i, 'return-path-degraded', 1000, W(100, 40)); a.resolve(i, 'return-path-degraded', 2000, W(100, 1)); }
    a.save();
    assert.equal(a.baseRate('return-path-degraded'), 1, 'arm is non-trivially populated before save');
    const b = createOutcomeStore({ path, minEpisodes: 4, decay: 0 });
    b.load();
    assert.equal(b.baseRate('return-path-degraded'), a.baseRate('return-path-degraded'), 'base rate survived the fs round-trip');
    // A store with no path never touches disk (in-memory only).
    const mem = createOutcomeStore({ minEpisodes: 4, decay: 0 });
    mem.save(); mem.load(); // no-ops, no throw
    assert.equal(mem.baseRate('return-path-degraded'), null);
  } finally {
    rmSync(path, { force: true });
  }
});

test('decay fades old episodes so a stale success cannot dominate forever', () => {
  const o = createOutcomeStore({ minEpisodes: 1, decay: 0.5 });
  // One old improvement, then three recent failures: decayed rate should be low.
  o.open(1, 'return-path-degraded', 1000, W(100, 40)); o.resolve(1, 'return-path-degraded', 2000, W(100, 1)); // improved
  for (let i = 2; i < 5; i++) { o.open(i, 'return-path-degraded', 1000, W(100, 40)); o.resolve(i, 'return-path-degraded', 2000, W(100, 39)); }
  const base = o.baseRate('return-path-degraded');
  assert.ok(base != null && base < 0.2, `heavy decay pushes the stale win down, got ${base}`);
});
