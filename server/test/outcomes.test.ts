import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createOutcomeStore, windowMetrics, type WindowMetrics } from '../src/zwave/outcomes';
import type { EvidenceSample } from '../src/zwave/evidenceStore';

// A window with plenty of traffic; rate = timeouts/tx.
const W = (tx: number, timeouts: number, rx = tx): WindowMetrics => ({ tx, rx, timeouts, rate: tx >= 5 ? timeouts / tx : null, samples: 6 });
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
  o.open(1, 'weak-signal', 1000, W(100, 20)); o.resolve(1, 'weak-signal', 2000, W(100, 1));
  assert.equal(o.baseRate('weak-signal'), null, 'one episode is not a base rate');
});

test('action arm: expectedEfficacy stays NULL until the action beats self-healing by the effect size', () => {
  const o = store();
  // Establish a HIGH self-healing base rate: 4/4 no-action episodes improved.
  for (let i = 0; i < 4; i++) { o.open(i, 'rtt-degraded', 1000, W(100, 20)); o.resolve(i, 'rtt-degraded', 2000, W(100, 1)); }
  assert.equal(o.baseRate('rtt-degraded'), 1, 'base rate 100% self-healing');
  // 4 action episodes that also improve — but they cannot BEAT a 100% base rate.
  for (let i = 10; i < 14; i++) {
    o.open(i, 'rtt-degraded', 1000, W(100, 20));
    o.recordAction(i, 'refreshValues', false, 1500);
    o.resolve(i, 'rtt-degraded', 2000, W(100, 1));
  }
  const eff = o.efficacyFor('rtt-degraded', 'refreshValues');
  assert.equal(eff.expectedEfficacy, null, 'cannot beat 100% self-healing → efficacy null');
  assert.equal(eff.beatsSelfHealing, false);
  assert.ok(eff.n >= 4, 'but the episode count is surfaced');
});

test('action arm: efficacy is offered once the action clears the base rate + effect size', () => {
  const o = store();
  // LOW self-healing base: 1/4 no-action improved (25%).
  o.open(0, 'dead-flap', 1000, W(100, 40)); o.resolve(0, 'dead-flap', 2000, W(100, 1));
  for (let i = 1; i < 4; i++) { o.open(i, 'dead-flap', 1000, W(100, 40)); o.resolve(i, 'dead-flap', 2000, W(100, 38)); }
  assert.ok(Math.abs((o.baseRate('dead-flap') ?? 0) - 0.25) < 1e-9);
  // Action arm: 4/4 improved after a ping → 100% ≫ 25% + 5%.
  for (let i = 10; i < 14; i++) {
    o.open(i, 'dead-flap', 1000, W(100, 40));
    o.recordAction(i, 'ping', false, 1500);
    o.resolve(i, 'dead-flap', 2000, W(100, 1));
  }
  const eff = o.efficacyFor('dead-flap', 'ping');
  assert.ok(eff.beatsSelfHealing, 'action beats self-healing');
  assert.ok(eff.expectedEfficacy != null && eff.expectedEfficacy > 0.9, `efficacy ~1.0, got ${eff.expectedEfficacy}`);
  assert.ok(eff.baseRate != null && eff.baseRate < 0.3, 'base rate surfaced for context');
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
  o.open(1, 'weak-signal', 1000, W(100, 10)); // before rate 0.10
  const ep = o.resolve(1, 'weak-signal', 2000, W(100, 40)); // after 0.40 > 0.10*1.5 and > release
  assert.equal(ep?.verdict, 'worse');
});

test('improved requires BOTH the release threshold AND the minimum effect size', () => {
  const o = store();
  // Drops from 0.10 → 0.06: under release (0.075) but only a 0.04 effect (< 0.05) → no-change.
  o.open(1, 'rtt-degraded', 1000, W(100, 10));
  assert.equal(o.resolve(1, 'rtt-degraded', 2000, W(100, 6))?.verdict, 'no-change');
  // Drops from 0.30 → 0.05: clears release AND a 0.25 effect → improved.
  o.open(2, 'rtt-degraded', 1000, W(100, 30));
  assert.equal(o.resolve(2, 'rtt-degraded', 2000, W(100, 5))?.verdict, 'improved');
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
  o.open(7, 'rtt-degraded', 1000, W(100, 40));
  o.open(8, 'dead-flap', 1000, W(100, 40)); // a different node — must NOT be touched
  o.recordAction(7, 'ping', false, 1500);
  // Both of node 7's episodes resolve improved → both credit ping.
  o.resolve(7, 'return-path-degraded', 2000, W(100, 1));
  o.resolve(7, 'rtt-degraded', 2000, W(100, 1));
  // Node 8 resolves with NO action (the ping wasn't for it) → control arm.
  o.resolve(8, 'dead-flap', 2000, W(100, 1));
  assert.equal(o.efficacyFor('return-path-degraded', 'ping').n, 1, 'return-path episode credited ping');
  assert.equal(o.efficacyFor('rtt-degraded', 'ping').n, 1, 'rtt episode credited ping');
  assert.equal(o.efficacyFor('dead-flap', 'ping').n, 0, 'node 8 was NOT credited the ping');
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
  for (let i = 0; i < 4; i++) { o.open(i, 'dead-flap', 1000, W(100, 40)); o.resolve(i, 'dead-flap', 2000, W(100, 1)); }
  const saved = JSON.parse(JSON.stringify(o.toJSON()));
  const o2 = store();
  o2.loadJSON(saved);
  assert.equal(o2.baseRate('dead-flap'), o.baseRate('dead-flap'), 'base rate survives a round-trip');
  // A corrupt tally (ok > n) is dropped, not loaded.
  const o3 = store();
  o3.loadJSON({ v: 1, control: [['dead-flap', { n: 2, ok: 9 }]], action: [], fp: [] });
  assert.equal(o3.baseRate('dead-flap'), null, 'garbage tally rejected');
});

test('fs load/save persists the learned arms atomically across a restart', () => {
  const path = join(tmpdir(), `zwave-outcomes-test-${process.pid}.json`);
  rmSync(path, { force: true });
  try {
    const a = createOutcomeStore({ path, minEpisodes: 4, decay: 0 });
    for (let i = 0; i < 4; i++) { a.open(i, 'dead-flap', 1000, W(100, 40)); a.resolve(i, 'dead-flap', 2000, W(100, 1)); }
    a.save();
    const b = createOutcomeStore({ path, minEpisodes: 4, decay: 0 });
    b.load();
    assert.equal(b.baseRate('dead-flap'), a.baseRate('dead-flap'), 'base rate survived the fs round-trip');
    // A store with no path never touches disk (in-memory only).
    const mem = createOutcomeStore({ minEpisodes: 4, decay: 0 });
    mem.save(); mem.load(); // no-ops, no throw
    assert.equal(mem.baseRate('dead-flap'), null);
  } finally {
    rmSync(path, { force: true });
  }
});

test('decay fades old episodes so a stale success cannot dominate forever', () => {
  const o = createOutcomeStore({ minEpisodes: 1, decay: 0.5 });
  // One old improvement, then three recent failures: decayed rate should be low.
  o.open(1, 'weak-signal', 1000, W(100, 40)); o.resolve(1, 'weak-signal', 2000, W(100, 1)); // improved
  for (let i = 2; i < 5; i++) { o.open(i, 'weak-signal', 1000, W(100, 40)); o.resolve(i, 'weak-signal', 2000, W(100, 39)); }
  const base = o.baseRate('weak-signal');
  assert.ok(base != null && base < 0.2, `heavy decay pushes the stale win down, got ${base}`);
});
