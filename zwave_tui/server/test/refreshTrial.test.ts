import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  trialGate, candidateBlock, classify, verdictOf, localHour, trialHandle, createRefreshTrial, refreshDiffers, HANDLE_REFUSED,
  TRIAL_TARGET, TRIAL_HARM_MS, TRIAL_MEASURE_MS, TRIAL_KILL_MS, TRIAL_EXCLUDE_MS, TRIAL_DEADLINE_MS, TRIAL_LIVE_MS,
  type TrialEnv, type TrialCandidate, type TrialStateView, type TrialRecord, type ArmTally, type TrialTickContext, type TrialArm,
} from '../src/zwave/refreshTrial';
import type { WindowMetrics, Verdict } from '../src/zwave/outcomes';
import { NOT_SENT } from '../src/zwave/zwaveActions';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const win = (over: Partial<WindowMetrics> = {}): WindowMetrics => ({
  samples: 6, freshN: 6, tx: 6, rx: 6, timeouts: 0, rate: 0, flaps: 0, s2: 0, s2Known: 6, routeChanges: 0, routeKnown: 6,
  rssiMedian: -80, rssiN: 6, rttMedian: 200, rttN: 6, rateKbpsMin: 40, ...over,
});
const env = (over: Partial<TrialEnv> = {}): TrialEnv => ({
  now: T0, enabled: true, writeActions: true, paused: false, operatorBusy: false, homeId: 7,
  autoPing: { suppressed: 'none', lastTickMs: T0 - 30_000 }, hour: 12, lastOperatorAt: null, ...over,
});
const state = (over: Partial<TrialStateView> = {}): TrialStateView => ({ phase: 'running', records: [], exclusions: [], ...over });
const cand = (over: Partial<TrialCandidate> = {}): TrialCandidate => ({
  nodeId: 56, kind: 'rtt-degraded', dwellStartMs: T0 - 15 * MIN, confounded: false, pending: false, acted: false, alive: true, mains: true,
  beforeRttN: 6, refreshQueries: 2, probeReadable: true, ...over,
});
const rec = (over: Partial<TrialRecord> = {}): TrialRecord => ({ id: 1, nodeId: 56, arm: 'held', decidedAt: T0 - 5 * MIN, dwellStartMs: T0 - 20 * MIN, before: win(), ...over });
const reason = (g: ReturnType<typeof trialGate>): string => (g.ok ? 'ok' : g.reason);

test('the global gates, in order; the pause and a running operator action are read directly (v0.75.0)', () => {
  assert.equal(reason(trialGate(state(), env())), 'ok');
  assert.match(reason(trialGate(state(), env({ enabled: false }))), /^off/);
  assert.match(reason(trialGate(state({ phase: 'passed' }), env())), /ended: passed/);
  assert.match(reason(trialGate(state({ latch: { at: T0, reason: 'x' } }), env())), /^latched/);
  assert.equal(reason(trialGate(state(), env({ writeActions: false }))), 'write actions off');
  assert.equal(reason(trialGate(state(), env({ paused: true }))), 'automatic writes paused', 'the pause, before auto-ping has seen it');
  assert.equal(reason(trialGate(state(), env({ homeId: null }))), 'home id unknown');
  assert.match(reason(trialGate(state({ homeId: 8 }), env())), /home id changed/);
  assert.equal(reason(trialGate(state(), env({ autoPing: null }))), 'auto-ping not running');
  assert.equal(reason(trialGate(state(), env({ autoPing: { suppressed: 'none', lastTickMs: T0 - 4 * MIN } }))), 'auto-ping not running', 'a stale snapshot is not a running auto-ping');
  assert.equal(reason(trialGate(state(), env({ autoPing: { suppressed: 'storm', lastTickMs: T0 } }))), 'auto-ping suppressed (storm)');
  assert.equal(reason(trialGate(state(), env({ hour: null }))), 'local time zone unknown');
  assert.equal(reason(trialGate(state(), env({ operatorBusy: true }))), 'an operator action is running');
});

test('09:00–20:00 local, the operator quiet period, one decision in flight until filed, hourly and daily limits (v0.75.0)', () => {
  assert.match(reason(trialGate(state(), env({ hour: 8 }))), /^outside 09:00–20:00/);
  assert.equal(reason(trialGate(state(), env({ hour: 9 }))), 'ok');
  assert.equal(reason(trialGate(state(), env({ hour: 19 }))), 'ok');
  assert.match(reason(trialGate(state(), env({ hour: 20 }))), /^outside/, '20:00 is outside: the window is half-open');
  assert.equal(reason(trialGate(state(), env({ lastOperatorAt: T0 - 9 * MIN }))), 'operator acted <10m ago');
  assert.equal(reason(trialGate(state(), env({ lastOperatorAt: T0 - 10 * MIN }))), 'ok');
  assert.equal(reason(trialGate(state({ records: [rec({ finalAt: undefined })] }), env())), 'one decision in flight', 'in flight until filed at its horizon');
  const filed = (ago: number, id: number): TrialRecord => rec({ id, nodeId: 100 + id, decidedAt: T0 - ago, finalAt: T0 - ago + 30 * MIN });
  assert.match(reason(trialGate(state({ records: [filed(40 * MIN, 1), filed(50 * MIN, 2)] }), env())), /^hourly limit/);
  assert.equal(reason(trialGate(state({ records: [filed(40 * MIN, 1), filed(61 * MIN, 2)] }), env())), 'ok');
  const day = [1, 2, 3, 4, 5, 6].map((i) => filed(i * 2 * 60 * MIN, i));
  assert.match(reason(trialGate(state({ records: day }), env())), /^daily limit/);
  assert.equal(reason(trialGate(state({ records: day.slice(0, 5) }), env())), 'ok');
  // The clock steps back 6 h: records now dated in the future still count (v0.75.0 review).
  assert.match(reason(trialGate(state({ records: day }), env({ now: T0 - 6 * 60 * MIN }))), /^(hourly|daily) limit/, 'a backward step does not reopen the caps (future-dated records count in both)');
  assert.match(reason(trialGate(state({ records: [filed(40 * MIN, 1), filed(50 * MIN, 2)] }), env({ now: T0 - 60 * MIN }))), /^hourly limit/, 'nor the hourly one');
});

test("a refresh must send more than the probe's own Get (the revisit condition's second half) (v0.75.0)", () => {
  assert.equal(refreshDiffers(null, true), null, 'unknown until the driver dump says');
  assert.equal(refreshDiffers(1, true), false, 'one switch value: the same single Get the probe sends');
  assert.equal(refreshDiffers(2, true), true, 'a meter or a second endpoint: more than the probe');
  assert.equal(refreshDiffers(1, false), true, 'the probe pings this node, a refresh reads it');
  assert.equal(refreshDiffers(0, false), false);
});

test('per-episode eligibility, applied before the coin (v0.75.0)', () => {
  const s = state();
  assert.equal(candidateBlock(s, cand(), T0), null);
  assert.equal(candidateBlock(s, cand({ kind: 'rate-fallback' }), T0), 'not the trial kind');
  assert.equal(candidateBlock(s, cand({ pending: true }), T0), 'recovering');
  assert.equal(candidateBlock(s, cand({ confounded: true }), T0), 'confounded');
  assert.equal(candidateBlock(s, cand({ acted: true }), T0), 'already acted on', 'an action before the decision would bias either arm');
  assert.equal(candidateBlock(s, cand({ dwellStartMs: T0 - TRIAL_LIVE_MS + 1 }), T0), 'live <10m');
  assert.equal(candidateBlock(s, cand({ dwellStartMs: T0 - TRIAL_LIVE_MS }), T0), null, 'exactly ten minutes live is eligible');
  assert.equal(candidateBlock(s, cand({ mains: false }), T0), 'not a mains node');
  assert.equal(candidateBlock(s, cand({ alive: false }), T0), 'not Alive');
  assert.equal(candidateBlock(s, cand({ refreshQueries: null }), T0), 'refresh profile unknown');
  assert.equal(candidateBlock(s, cand({ refreshQueries: 1 }), T0), "its refresh adds nothing to the probe (P5)");
  assert.equal(candidateBlock(s, cand({ beforeRttN: 2 }), T0), 'before-window too thin to score');
  assert.equal(candidateBlock(state({ exclusions: [{ nodeId: 56, until: T0 + 1 }] }), cand(), T0), 'excluded after a direct kill');
  assert.equal(candidateBlock(state({ exclusions: [{ nodeId: 56, until: T0 }] }), cand(), T0), null, 'an exclusion ends at its time');
  // ≤ 1 per node per 24 h, in EITHER arm: the chronic re-arm cannot flood the held arm.
  assert.equal(candidateBlock(state({ records: [rec({ arm: 'held', decidedAt: T0 - 23 * 60 * MIN, finalAt: T0 })] }), cand(), T0), 'node had a trial decision <24h ago');
  assert.equal(candidateBlock(state({ records: [rec({ arm: 'held', decidedAt: T0 - 24 * 60 * MIN, finalAt: T0 })] }), cand(), T0), null);
});

test('a record files harm before anything else, then lost, then disturbed, then the verdict (v0.75.0)', () => {
  assert.equal(classify(rec({ deathAt: T0, lostWhy: 'restart', disturbed: 'x', verdict: 'improved' })), 'harm');
  assert.equal(classify(rec({ lostWhy: 'restart', verdict: 'improved' })), 'lost');
  assert.equal(classify(rec({ disturbed: 'operator action in the window', verdict: 'improved' })), 'unscoreable');
  for (const v of ['improved', 'no-change', 'worse'] as const) assert.equal(classify(rec({ verdict: v })), 'scored');
  assert.equal(classify(rec({ verdict: 'unverifiable' })), 'unscoreable');
  assert.equal(classify(rec({ verdict: null })), 'unscoreable');
});

const tally = (n: number, ok: number, deaths = 0): ArmTally => ({ n, ok, worse: 0, deaths, unscoreable: 0, lost: 0, over: 0 });

test('one verdict at 30 + 30: Wilson lower bound vs held + 5 points, and the death margin (v0.75.0)', () => {
  assert.equal(verdictOf({ treated: tally(TRIAL_TARGET, 30), held: tally(TRIAL_TARGET - 1, 0) }, T0), null, 'both arms must reach the target');
  const pass = verdictOf({ treated: tally(30, 27), held: tally(30, 9) }, T0)!;
  assert.equal(pass.pass, true, `lower ${pass.treated.lower} vs held ${pass.held.rate}`);
  const flat = verdictOf({ treated: tally(30, 12), held: tally(30, 10) }, T0)!;
  assert.equal(flat.pass, false);
  assert.match(flat.why, /lower bound/);
  const harmful = verdictOf({ treated: tally(30, 27, 3), held: tally(30, 9, 1) }, T0)!;
  assert.equal(harmful.pass, false);
  assert.match(harmful.why, /deaths 3 > held 1 \+ 1/);
  assert.equal(verdictOf({ treated: tally(30, 27, 2), held: tally(30, 9, 1) }, T0)!.pass, true, 'one more death than held is tolerated');
  const thin = verdictOf({ treated: tally(30, 20), held: tally(30, 14) }, T0)!;
  assert.ok(thin.treated.lower >= thin.held.rate && thin.treated.lower < thin.held.rate + 0.05, `fixture: lower ${thin.treated.lower} in [${thin.held.rate}, +0.05)`);
  assert.equal(thin.pass, false, 'better than held, but not by five points at the lower bound');
});

test('the local hour needs a zone; without one the trial sends nothing (v0.75.0)', () => {
  assert.equal(localHour(Date.UTC(2026, 9, 11, 19, 30), 'America/Phoenix'), 12);
  assert.equal(localHour(Date.UTC(2026, 9, 11, 19, 30), 'UTC'), 19);
  assert.equal(localHour(T0, undefined), null);
  assert.equal(localHour(T0, 'Not/AZone'), null);
});

test('the handle holds refreshValues alone, frozen, and refuses at send time with a reason (v0.75.0)', async () => {
  const sent: number[] = [];
  const h = trialHandle(async (n) => { sent.push(n); return { ok: true, message: 'ok' }; }, (n) => (n === 9 ? 'node 9 is not Alive' : n === 8 ? 'automatic writes paused' : null));
  assert.deepEqual(Object.keys(h), ['refreshValues']);
  assert.ok(Object.isFrozen(h));
  assert.equal((await h.refreshValues(5)).ok, true);
  for (const n of [9, 8]) {
    const r = await h.refreshValues(n);
    assert.equal(r.ok, false);
    assert.ok(r.message.endsWith(HANDLE_REFUSED));
  }
  assert.deepEqual(sent, [5], 'a refused node gets nothing at all');
});

test('the trial module cannot reach the runner; index.ts builds the handle, the pause refusal, the kill classifier and the operator clock (v0.75.0)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../src/zwave/refreshTrial.ts'), 'utf8');
  assert.ok(!/from '\.\/zwaveActions'/.test(src), 'refreshTrial.ts must not import the action runner');
  assert.ok(!/ActionRunner/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')), 'nor name its type in code');
  const idx = readFileSync(resolve(here, '../src/index.ts'), 'utf8');
  assert.match(idx, /trialHandle\(\(n\) => actions\.refreshValues\(n, 'trial'\), \(n\) =>\s+!client\.ready\(\) \? 'HA WS not ready'\s+: zwaveData\.autonomyPause\(\) != null \? 'automatic writes paused'/);
  assert.ok(NOT_SENT.test('HA WS not ready'), 'a socket not yet authenticated refuses as provably not sent');
  assert.match(idx, /notSent: \(m\) => NOT_SENT\.test\(m\),/);
  assert.match(idx, /if \(origin == null \|\| origin === 'you'\) trialRef\?\.noteOperatorAction\(Date\.now\(\), nodeId\);/);
  assert.match(idx, /zwaveData\.attachRefreshTrial\(trial, \{ writeActions: config\.writeActions, operatorBusy: \(\) => actions\.operatorActionInFlight\(\) != null \}\);/);
});

// ── the store ───────────────────────────────────────────────────────────────

interface Harness {
  dir: string;
  path: string;
  clock: { now: number };
  sends: { n: number; fileAtSend: string }[];
  frozen: { n: number; arm: TrialArm }[];
  measured: { n: number; at: number }[];
  windows: { n: number; from: number; to: number }[];
  verdict: { v: Verdict };
  make: (over?: Partial<Parameters<typeof createRefreshTrial>[0]>) => ReturnType<typeof createRefreshTrial>;
  ctx: (cands: TrialCandidate[], over?: Partial<TrialTickContext>) => TrialTickContext;
  done: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-trial-'));
  const path = join(dir, 'refresh_trial.json');
  const h: Harness = {
    dir, path, clock: { now: T0 }, sends: [], frozen: [], measured: [], windows: [], verdict: { v: 'improved' },
    make: (over = {}) => createRefreshTrial({
      enabled: true, path,
      handle: trialHandle(async (n) => {
        h.sends.push({ n, fileAtSend: existsSync(path) ? readFileSync(path, 'utf8') : '' });
        return { ok: true, message: 'ok' };
      }, () => null),
      log: () => {}, warn: () => {},
      rand: () => 0.1, hourOf: () => 12, now: () => h.clock.now, ...over,
    }),
    ctx: (cands, over = {}) => ({
      now: h.clock.now, homeId: 7, writeActions: true, paused: false, operatorBusy: false,
      autoPing: { suppressed: 'none', lastTickMs: h.clock.now },
      candidates: cands, profile: { mains: 35, differs: 3, unknown: 0 },
      freeze: (n, arm) => { h.frozen.push({ n, arm }); return win(); },
      measure: (n) => { h.measured.push({ n, at: h.clock.now }); return true; },
      window: (n, from, to) => { h.windows.push({ n, from, to }); return win({ rttMedian: 100 }); },
      score: () => h.verdict.v,
      ...over,
    }),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
  return h;
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const at = (h: Harness, t: ReturnType<typeof createRefreshTrial>, ms: number, cands: TrialCandidate[] = [], over: Partial<TrialTickContext> = {}): void => {
  h.clock.now = ms;
  t.tick(h.ctx(cands, over));
};
/** Tick once a minute up to `to` — a window the engine watched throughout. */
const walk = (h: Harness, t: ReturnType<typeof createRefreshTrial>, to: number, over: Partial<TrialTickContext> = {}): void => {
  for (let ms = h.clock.now + MIN; ms < to; ms += MIN) at(h, t, ms, [], over);
  at(h, t, to, [], over);
};

test('a decision is written to disk BEFORE the send, and the held arm sends nothing (v0.75.0)', async () => {
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    assert.equal(h.sends.length, 1);
    const atSend = JSON.parse(h.sends[0].fileAtSend);
    assert.equal(atSend.records[0].arm, 'treated', 'the assignment was on disk when the handle was called');
    assert.equal(atSend.records[0].send.result, 'pending');
    assert.deepEqual(h.frozen, [{ n: 56, arm: 'treated' }], 'the ledger episode was frozen and handed over');
    assert.equal(JSON.parse(readFileSync(h.path, 'utf8')).records[0].send.result, 'ok', 'the result is written back');
  } finally { h.done(); }
  const h2 = harness();
  try {
    const t2 = h2.make({ rand: () => 0.9 });
    t2.tick(h2.ctx([cand({ nodeId: 11 })]));
    await flush();
    assert.equal(h2.sends.length, 0);
    assert.equal(t2.view().open?.arm, 'held');
    assert.equal(JSON.parse(readFileSync(h2.path, 'utf8')).records[0].send, undefined);
  } finally { h2.done(); }
});

test('the fixed horizon: a burst at +20 min in BOTH arms, scored on +20..+30, filed at +30 (v0.75.0)', async () => {
  for (const r of [0.1, 0.9]) {
    const h = harness();
    try {
      const t = h.make({ rand: () => r });
      t.tick(h.ctx([cand()]));
      await flush();
      walk(h, t, T0 + TRIAL_MEASURE_MS - 1);
      assert.deepEqual(h.measured, [], 'not before +20');
      at(h, t, T0 + TRIAL_MEASURE_MS);
      assert.deepEqual(h.measured, [{ n: 56, at: T0 + TRIAL_MEASURE_MS }], `the measurement burst goes out in the ${r < 0.5 ? 'treated' : 'held'} arm too`);
      walk(h, t, T0 + TRIAL_HARM_MS - 1);
      assert.equal(t.view().open?.nodeId, 56, 'still in flight until +30');
      assert.deepEqual(h.windows, []);
      at(h, t, T0 + TRIAL_HARM_MS);
      assert.deepEqual(h.windows, [{ n: 56, from: T0 + TRIAL_MEASURE_MS, to: T0 + TRIAL_HARM_MS }]);
      const arm = r < 0.5 ? 'treated' : 'held';
      assert.deepEqual([t.view()[arm].n, t.view()[arm].ok], [1, 1]);
      assert.equal(t.view().open, null);
    } finally { h.done(); }
  }
});

test('a death inside 30 minutes is harm and is never scored; disturbances make it unscoreable (v0.75.0)', async () => {
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    t.onDead(56, T0 + 29 * MIN);
    assert.deepEqual(t.view().exclusions, [], 'a death 29 minutes after the send is harm, not a direct kill');
    at(h, t, T0 + TRIAL_HARM_MS);
    assert.deepEqual(h.windows, [], 'harm is not scored');
    assert.deepEqual([t.view().treated.n, t.view().treated.ok, t.view().treated.deaths], [1, 0, 1]);
  } finally { h.done(); }
  const cases: [string, (h: Harness, t: ReturnType<typeof createRefreshTrial>) => void][] = [
    ['paused', (h, t) => { walk(h, t, T0 + 4 * MIN); at(h, t, T0 + 5 * MIN, [], { paused: true }); }],
    ['rebuild', (h, t) => { walk(h, t, T0 + 4 * MIN); at(h, t, T0 + 5 * MIN, [], { autoPing: { suppressed: 'rebuilding-routes', lastTickMs: T0 + 5 * MIN } }); }],
    ['operator on the node', (h, t) => { walk(h, t, T0 + 10 * MIN); t.noteOperatorAction(T0 + 10 * MIN, 56); at(h, t, T0 + 11 * MIN); }],
    ['operator mesh-wide', (h, t) => { walk(h, t, T0 + 10 * MIN); t.noteOperatorAction(T0 + 10 * MIN, null); at(h, t, T0 + 11 * MIN); }],
    // The engine tick stalls (its wedge guard) from +25 to +31.5: a pause or a
    // rebuild could have come and gone unseen, so the window was not watched.
    ['a gap in the watch', (h, t) => { walk(h, t, T0 + 25 * MIN); at(h, t, T0 + 31.5 * MIN); }],
  ];
  for (const [name, disturb] of cases) {
    const hh = harness();
    try {
      const t = hh.make();
      t.tick(hh.ctx([cand()]));
      await flush();
      disturb(hh, t);
      walk(hh, t, Math.max(hh.clock.now, T0 + TRIAL_HARM_MS));
      assert.deepEqual([t.view().treated.n, t.view().treated.unscoreable], [0, 1], `${name}: unscoreable`);
      assert.deepEqual(hh.windows, [], `${name}: never scored`);
    } finally { hh.done(); }
  }
  const h3 = harness();
  try {
    const t = h3.make();
    t.tick(h3.ctx([cand()]));
    await flush();
    walk(h3, t, T0 + 10 * MIN);
    t.noteOperatorAction(T0 + 10 * MIN, 99);
    walk(h3, t, T0 + TRIAL_HARM_MS);
    assert.equal(t.view().treated.n, 1, 'an operator action on another node does not touch this one');
  } finally { h3.done(); }
  // An operator action inside the window is stamped, so a late tick still sees
  // it — after the window's end, and after its +60 s grace (v0.75.0 review).
  const h4 = harness();
  try {
    const t = h4.make({ rand: () => 0.9 });
    t.tick(h4.ctx([cand()]));
    await flush();
    walk(h4, t, T0 + 29 * MIN);
    at(h4, t, T0 + TRIAL_HARM_MS - 10_000);
    t.noteOperatorAction(T0 + TRIAL_HARM_MS - 5_000, 56);
    at(h4, t, T0 + TRIAL_HARM_MS + 65_000); // 75 s after the last tick: watched, but past the grace
    assert.deepEqual([t.view().held.n, t.view().held.unscoreable], [0, 1], 'the stamp is caught at the late filing tick');
  } finally { h4.done(); }
});

test('a direct kill excludes the node 7 days; a second within 7 days latches until an owner restart with the option off (v0.75.0)', async () => {
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    t.onDead(56, T0 + TRIAL_KILL_MS);
    assert.deepEqual(t.view().exclusions, [{ nodeId: 56, until: T0 + TRIAL_KILL_MS + TRIAL_EXCLUDE_MS }]);
    assert.equal(t.view().latch, null);
    at(h, t, T0 + TRIAL_HARM_MS);
    at(h, t, T0 + 2 * 60 * MIN, [cand({ nodeId: 11, dwellStartMs: T0 + 100 * MIN })]);
    await flush();
    t.onDead(11, h.clock.now + MIN);
    assert.match(t.view().latch?.reason ?? '', /second direct kill/);
    assert.equal(t.view().latch?.clear, 'restart-with-option-off');
    assert.match(h.make().view().latch?.reason ?? '', /second direct kill/, 'the latch survives a restart with the trial on');
    h.make({ enabled: false });
    assert.equal(h.make().view().latch, null, 'and clears only when the add-on starts with the option off');
  } finally { h.done(); }
});

test('a failed send that may have left counts as a kill; a provable not-sent does not; a held death never does (v0.75.0)', async () => {
  const mk = (h: Harness, result: { ok: boolean; message: string }) => h.make({
    handle: trialHandle(async () => result, () => null),
    notSent: (m) => /^HA WS not ready/.test(m),
  });
  const h = harness();
  try {
    const t = mk(h, { ok: false, message: 'HA WS timeout (id 9, zwave_js/refresh_node_values)' });
    t.tick(h.ctx([cand()]));
    await flush();
    t.onDead(56, T0 + MIN);
    assert.equal(t.view().exclusions.length, 1, 'a timeout proves nothing about the send');
  } finally { h.done(); }
  const h2 = harness();
  try {
    const t = mk(h2, { ok: false, message: 'HA WS not ready' });
    t.tick(h2.ctx([cand()]));
    await flush();
    t.onDead(56, T0 + MIN);
    assert.deepEqual(t.view().exclusions, [], 'nothing left the add-on');
    at(h2, t, T0 + TRIAL_HARM_MS);
    assert.equal(t.view().treated.deaths, 1, 'but the death is still harm, by intention to treat');
  } finally { h2.done(); }
  const h3 = harness();
  try {
    const t = h3.make({ rand: () => 0.9 });
    t.tick(h3.ctx([cand()]));
    t.onDead(56, T0 + MIN);
    assert.deepEqual(t.view().exclusions, [], 'nothing was sent in the held arm');
  } finally { h3.done(); }
});

test('a decision in flight across a restart, or on a node that leaves, files as lost and is never re-sent (v0.75.0)', async () => {
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    h.clock.now = T0 + 5 * MIN;
    const t2 = h.make();
    assert.equal(t2.view().open, null, 'not in flight after a restart');
    assert.equal(t2.view().treated.lost, 1);
    at(h, t2, T0 + 6 * MIN, [cand()]);
    await flush();
    assert.equal(h.sends.length, 1, 'the same node is not decided again within 24 h');
  } finally { h.done(); }
  const h2 = harness();
  try {
    const t = h2.make();
    t.tick(h2.ctx([cand()]));
    await flush();
    t.dropOpen(56, 'node left the mesh', T0 + MIN);
    assert.equal(t.view().treated.lost, 1);
    assert.equal(t.view().open, null);
    at(h2, t, T0 + 2 * 60 * MIN, [cand({ nodeId: 11, dwellStartMs: T0 + 100 * MIN })]);
    await flush();
    t.dropOpen(null, 'mesh identity changed', h2.clock.now + MIN);
    assert.equal(t.view().treated.lost, 2, 'a mesh change drops every open decision');
  } finally { h2.done(); }
});

test('an unreadable or malformed file latches with its own remedy, never crashes, and is left untouched (v0.75.0)', async () => {
  for (const content of ['{not json', JSON.stringify({ v: 1, startedAt: T0, phase: 'running', nextId: 2, records: [null], tally: { treated: tally(0, 0), held: tally(0, 0) }, kills: [], exclusions: [] })]) {
    const h = harness();
    try {
      writeFileSync(h.path, content);
      const t = h.make();
      t.tick(h.ctx([cand()]));
      await flush();
      assert.equal(h.sends.length, 0);
      assert.equal(t.view().latch?.clear, 'move-file-aside');
      assert.equal(readFileSync(h.path, 'utf8'), content);
      assert.equal(h.make({ enabled: false }).view().latch?.clear, 'move-file-aside', 'a restart with the option off does not clear an unreadable file');
    } finally { h.done(); }
  }
  const h2 = harness();
  try {
    const t = h2.make({ path: join(h2.dir, 'missing-dir', 'refresh_trial.json') });
    t.tick(h2.ctx([cand()]));
    await flush();
    assert.equal(h2.sends.length, 0, 'an assignment that could not be persisted is never sent');
    assert.equal(t.view().latch?.clear, 'make-data-writable');
    const t3 = h2.make({ path: null });
    t3.tick(h2.ctx([cand()]));
    await flush();
    assert.equal(h2.sends.length, 0);
    assert.equal(t3.view().latch?.clear, 'set-trial-path');
  } finally { h2.done(); }
});

test('the verdict compares the first 30 of each arm; later ones are counted apart (v0.75.0)', async () => {
  const h = harness();
  try {
    writeFileSync(h.path, JSON.stringify({
      v: 1, startedAt: T0 - 10 * 24 * 60 * MIN, phase: 'running', nextId: 61, records: [],
      tally: { treated: tally(30, 25, 2), held: tally(29, 9, 1) }, kills: [], exclusions: [],
    }));
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    t.onDead(56, T0 + MIN);
    at(h, t, T0 + TRIAL_HARM_MS);
    assert.deepEqual([t.view().treated.n, t.view().treated.deaths, t.view().treated.over], [30, 2, 1], 'a death past the target does not move the compared deaths');
    assert.equal(t.view().phase, 'running', 'held is still at 29');
  } finally { h.done(); }
});

test('the verdict ends the trial; the deadline retires it (v0.75.0)', async () => {
  const h = harness();
  try {
    writeFileSync(h.path, JSON.stringify({
      v: 1, startedAt: T0 - 10 * 24 * 60 * MIN, phase: 'running', nextId: 61, records: [],
      tally: { treated: tally(30, 27), held: tally(30, 9) }, kills: [], exclusions: [],
    }));
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    assert.equal(t.view().phase, 'passed');
    assert.equal(h.sends.length, 0, 'nothing more is sent after the verdict');
  } finally { h.done(); }
  const h2 = harness();
  try {
    writeFileSync(h2.path, JSON.stringify({
      v: 1, startedAt: T0 - TRIAL_DEADLINE_MS, phase: 'running', nextId: 1, records: [],
      tally: { treated: tally(3, 1), held: tally(2, 0) }, kills: [], exclusions: [],
    }));
    const t = h2.make();
    t.tick(h2.ctx([cand()]));
    await flush();
    assert.equal(t.view().phase, 'retired');
    assert.equal(h2.sends.length, 0);
  } finally { h2.done(); }
});

test('off: no file, nothing decided; on a mesh of plain switches it says why nothing happens (v0.75.0)', async () => {
  const h = harness();
  try {
    const t = h.make({ enabled: false });
    t.tick(h.ctx([cand()]));
    await flush();
    assert.equal(existsSync(h.path), false);
    assert.equal(h.sends.length, 0);
    assert.equal(t.view().enabled, false);
    assert.equal(t.view().startedAt, null);
  } finally { h.done(); }
  const h2 = harness();
  try {
    const t = h2.make();
    t.tick(h2.ctx([cand({ refreshQueries: 1 })], { profile: { mains: 35, differs: 0, unknown: 0 } }));
    await flush();
    assert.equal(h2.sends.length, 0);
    assert.match(t.view().idle ?? '', /refresh adds nothing to the probe \(P5\)/);
    t.tick(h2.ctx([], { profile: { mains: 35, differs: 0, unknown: 0 } }));
    assert.match(t.view().idle ?? '', /no mains node's refresh differs from the probe \(P5, 0 of 35\)/);
    assert.deepEqual(t.view().profile, { mains: 35, differs: 0, unknown: 0 });
  } finally { h2.done(); }
});

test('a direct kill counts after a restart filed the decision as lost; a second one still latches (v0.75.0 review)', async () => {
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    h.clock.now = T0 + MIN;
    const t2 = h.make(); // the add-on restarts one minute after the send
    assert.equal(t2.view().treated.lost, 1);
    t2.onDead(56, T0 + 3 * MIN);
    assert.deepEqual(t2.view().exclusions, [{ nodeId: 56, until: T0 + 3 * MIN + TRIAL_EXCLUDE_MS }], 'the kill rule is safety, not scoring');
    assert.equal(t2.view().treated.deaths, 0, 'a lost decision is not re-filed as harm');
    t2.onDead(56, T0 + 4 * MIN);
    assert.equal(t2.view().exclusions.length, 1, 'one kill per decision');
    at(h, t2, T0 + 2 * 60 * MIN, [cand({ nodeId: 11, dwellStartMs: T0 + 100 * MIN })]);
    await flush();
    h.clock.now += MIN;
    const t3 = h.make();
    t3.onDead(11, h.clock.now + MIN);
    assert.match(t3.view().latch?.reason ?? '', /second direct kill/, 'two kills in 7 days latch, restarts or not');
  } finally { h.done(); }
});

test('a kill that cannot reach disk latches this run and is saved once /data is writable again (v0.75.0 review)', async (tc) => {
  if (process.getuid?.() === 0) { tc.skip('root ignores directory permissions'); return; }
  const h = harness();
  try {
    const t = h.make();
    t.tick(h.ctx([cand()]));
    await flush();
    chmodSync(h.dir, 0o555);
    try {
      t.onDead(56, T0 + MIN);
      assert.equal(t.view().latch?.clear, 'make-data-writable', 'not durable, so latched now');
    } finally { chmodSync(h.dir, 0o755); }
    at(h, t, T0 + 2 * MIN);
    assert.equal(JSON.parse(readFileSync(h.path, 'utf8')).exclusions.length, 1, 'the next tick writes the kill');
  } finally { h.done(); }
});
