/**
 * The ledger's side of the refresh trial (v0.75.0): a trial episode's
 * before-window is frozen at the decision, it files into no arm, and the
 * trial's send is credited to nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomeStore, type WindowMetrics } from '../src/zwave/outcomes';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const WT = (rttMedian: number, freshN = 6): WindowMetrics => ({
  tx: 50, rx: 50, timeouts: 0, rate: 0, samples: 6, freshN, flaps: 0, s2: 0, s2Known: 6, routeChanges: 0, routeKnown: 6,
  rssiMedian: null, rssiN: 0, rttMedian, rttN: 6, rateKbpsMin: 40,
});
const store = () => createOutcomeStore({ releaseRate: 0.075, minEffect: 0.05, minEpisodes: 4, decay: 0 });

test('markTrial freezes the before-window and hands it over once (v0.75.0)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  const b = oc.markTrial(56, 'rtt-degraded', 'held');
  assert.equal(b?.rttMedian, 300);
  assert.equal(oc.refineBefore(56, 'rtt-degraded', WT(500, 9)), false, 'a frozen before-window is not refined');
  assert.equal(oc.markTrial(56, 'rtt-degraded', 'treated'), null, 'decided once');
  assert.equal(oc.markTrial(57, 'rtt-degraded', 'held'), null, 'no open episode, nothing to hand over');
  assert.equal(oc.openEpisodeDetails()[0].trial, 'held');
  assert.equal(oc.openEpisodeDetails()[0].beforeRttN, 6);
  const ep = oc.resolve(56, 'rtt-degraded', T0 + 30 * MIN, WT(100))!;
  assert.equal(ep.before?.rttMedian, 300, 'scored against the window as it stood at the decision');
});

test('a held trial episode files into no arm; its live span still counts (v0.75.0)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.markTrial(56, 'rtt-degraded', 'held');
  const ep = oc.resolve(56, 'rtt-degraded', T0 + 30 * MIN, WT(100), { absentSinceMs: T0 + 20 * MIN })!;
  assert.equal(ep.verdict, 'improved');
  assert.equal(oc.controlArm('rtt-degraded'), null, 'kept out of the control arm');
  assert.equal(oc.liveSpan('rtt-degraded', T0 + 30 * MIN)?.scored.reduce((a, b) => a + b, 0), 1);
});

test('the trial send is the treated episode\'s alone: no arm, and every other episode on the node is confounded (v0.75.0)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.open(56, 'rate-fallback', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.markTrial(56, 'rtt-degraded', 'treated');
  oc.recordAction(56, 'refreshValues', false, T0 + MIN, undefined, undefined, { origin: 'trial', aliveAtAction: true });
  const ep = oc.resolve(56, 'rtt-degraded', T0 + 30 * MIN, WT(100))!;
  assert.equal(ep.action?.origin, 'trial');
  assert.equal(oc.pooledArm('rtt-degraded', 'refreshValues'), null, 'not in the pooled arm');
  assert.deepEqual(oc.actorArms('rtt-degraded'), [], 'not in any actor arm');
  const other = oc.resolve(56, 'rate-fallback', T0 + 30 * MIN, WT(100))!;
  assert.equal(other.confounded, true, "the trial's send is no other episode's treatment");
  assert.equal(oc.confounded('rate-fallback'), 1);
});

test('a refused trial send changes nothing on the ledger (v0.75.0)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.open(56, 'rate-fallback', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.markTrial(56, 'rtt-degraded', 'treated');
  oc.recordAction(56, 'refreshValues', true, T0 + MIN, undefined, undefined, { origin: 'trial' });
  assert.equal(oc.resolve(56, 'rtt-degraded', T0 + 30 * MIN, WT(100))!.action, null);
  assert.notEqual(oc.resolve(56, 'rate-fallback', T0 + 30 * MIN, WT(100))!.confounded, true);
});

test('an operator action on a trial episode spoils the comparison (v0.75.0)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.markTrial(56, 'rtt-degraded', 'held');
  oc.recordAction(56, 'healNode', false, T0 + MIN, undefined, undefined, { origin: 'you', aliveAtAction: true });
  const ep = oc.resolve(56, 'rtt-degraded', T0 + 30 * MIN, WT(100))!;
  assert.equal(ep.confounded, true);
  assert.equal(ep.action, null, 'and it is not the held episode\'s action');
  assert.equal(oc.pooledArm('rtt-degraded', 'healNode'), null);
});

test('deaths and route episodes after a trial launch are the trial\'s to count, not the ledger\'s (v0.75.0)', () => {
  const oc = store();
  oc.noteLaunch(56, 'refreshValues', T0, { origin: 'trial', alive: true });
  oc.noteSettled(56, T0, T0 + 1_000);
  oc.open(56, 'rate-fallback', T0 + MIN, WT(300), { dwellStartMs: T0 + 30_000 });
  assert.equal(oc.routeSymptomsAfter('refreshValues', 'trial'), 0, 'no route harm booked for the trial');
  oc.noteDeadAfterAction(56, 'rate-fallback', T0 + 2 * MIN);
  assert.ok(oc.actorArms('rate-fallback').every((a) => a.killedAfter === 0), 'no death booked against the trial in the ledger');
});


test('markTrial refuses an episode something already acted on; score() is the ledger\'s own rule (v0.75.0 review)', () => {
  const oc = store();
  oc.open(56, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.recordAction(56, 'refreshValues', false, T0 + MIN, undefined, undefined, { origin: 'you', aliveAtAction: true });
  assert.equal(oc.openEpisodeDetails()[0].actionKind, 'refreshValues', 'fixture: the operator action is on the episode, unconfounded');
  assert.equal(oc.markTrial(56, 'rtt-degraded', 'held'), null, 'held, it would score the operator\'s treatment as a control');
  assert.equal(oc.score('rtt-degraded', WT(300), WT(100)), 'improved');
  assert.equal(oc.score('rtt-degraded', WT(300), WT(290)), 'no-change');
  assert.equal(oc.score('rtt-degraded', WT(300), null), 'unverifiable');
});

test("a death after someone else's action on a trial episode is still that actor's (v0.75.0 review)", () => {
  const oc = store();
  oc.open(7, 'rtt-degraded', T0, WT(300), { dwellStartMs: T0 - 5 * MIN });
  oc.markTrial(7, 'rtt-degraded', 'held');
  oc.noteLaunch(7, 'healNode', T0 + 5 * MIN, { origin: 'you', alive: true });
  oc.noteDeadAfterAction(7, 'rtt-degraded', T0 + 7 * MIN);
  const heal = oc.actorArms('rtt-degraded').find((a) => a.action === 'healNode' && a.origin === 'you');
  assert.equal(heal?.killedAfter, 1, "the trial does not take the operator's death off the ledger");
});
