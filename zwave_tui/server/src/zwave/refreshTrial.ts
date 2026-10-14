/**
 * The pre-registered randomized refresh trial (v0.75.0) — DESIGN.md §3.5.
 *
 * No verb passes the admission rule (admission.ts), and the protocol below is
 * the only path by which one ever could. It asks one question: does sending
 * `zwave_js/refresh_node_values` to a node in a live `rtt-degraded` episode
 * make the node's round trips recover more often than leaving it alone? It
 * answers once, at 30 + 30 scoreable decisions, or retires after 120 days as
 * not measurable here. Running the trial admits nothing: `AutoVerb` stays
 * `never`, and a pass only makes an admission reviewable (DESIGN §3.5: the
 * failure rows deleted in review, a narrowed handle, its own default-off
 * option, the owner's re-consent, and a permanent ≥ ⅓ holdout).
 *
 * The protocol, as built here:
 *  - Each ELIGIBLE episode is randomized at p = 0.5 at the decision tick, and
 *    the assignment is written to disk BEFORE anything is sent. Every gate and
 *    limit below is checked before the coin is thrown, so both arms see the
 *    same filter.
 *  - Eligible means the revisit condition's second half holds for THIS node:
 *    its refresh queries more than the verification lane's single routed-read
 *    Get (a node with one switch value and nothing else would receive the same
 *    frame in both arms, which is admission rule P5), and nothing has acted on
 *    the episode yet.
 *  - Scored at a FIXED horizon, the same in both arms: the before-window is
 *    the episode's degraded window frozen at the decision; a verification
 *    burst is requested for the node at +20 min in BOTH arms; the after-window
 *    is its round trips from +20 to +30 min; the decision is filed at +30 min.
 *    The ledger's episode is kept out of every ledger arm but plays no part in
 *    the score, so nothing the treatment changes about the detector's own
 *    closure can bias the comparison.
 *  - Tallies are plain counts, never decayed, kept apart from every ledger
 *    arm, and the verdict compares the FIRST 30 scoreable decisions of each arm.
 *  - A death within 30 min of the decision is HARM, in both arms, never
 *    "confounded".
 *  - A direct kill — Dead ≤ 5 min after an automatic send that may have left —
 *    excludes the node for 7 days; a second within 7 days latches the trial off
 *    until the owner acts (starts the add-on with the option off).
 *  - Limits: ≤ 1 decision per node per 24 h, ≤ 2 per hour, ≤ 6 per day,
 *    09:00–20:00 local, one in flight (until filed), never within 10 min of an
 *    operator action nor while one runs, only while the owner has not paused
 *    automatic writes, and only while auto-ping runs unsuppressed.
 *
 * The send goes through a NARROWED handle holding refreshValues alone, never
 * the ActionRunner (trialHandle below). Intention to treat: a treated decision
 * whose send was refused or never left stays in the treated arm.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { wilsonLower, MIN_OBS, type Verdict, type WindowMetrics } from './outcomes';
import type { SymptomKind } from './symptoms';
import type { ActionResult } from '../types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The candidate kind: the one with the live-span to support a trial. */
export const TRIAL_KIND: SymptomKind = 'rtt-degraded';
export const TRIAL_P_TREAT = 0.5;
/** Live this long from the dwell start before a decision: the clock the
 *  revisit condition counted (DOCS §9.3). */
export const TRIAL_LIVE_MS = 10 * MIN;
/** The fixed horizon: the after-window runs from MEASURE to HARM. */
export const TRIAL_MEASURE_MS = 20 * MIN;
export const TRIAL_HARM_MS = 30 * MIN;
export const TRIAL_KILL_MS = 5 * MIN;
export const TRIAL_EXCLUDE_MS = 7 * DAY;
export const TRIAL_LATCH_WINDOW_MS = 7 * DAY;
/** Scoreable decisions per arm that the one verdict compares. */
export const TRIAL_TARGET = 30;
export const TRIAL_MIN_EFFECT = 0.05;
export const TRIAL_DEADLINE_MS = 120 * DAY;
export const TRIAL_PER_NODE_MS = 24 * HOUR;
export const TRIAL_MAX_PER_HOUR = 2;
export const TRIAL_MAX_PER_DAY = 6;
/** Local hours a decision may fall in: [from, to). */
export const TRIAL_HOURS = { from: 9, to: 20 } as const;
export const TRIAL_OPERATOR_QUIET_MS = 10 * MIN;
/** For the admission step a pass would make reviewable; the trial itself
 *  sends nothing after its verdict. */
export const TRIAL_POST_PASS_HOLDOUT = 1 / 3;
/** Filed records kept this long, for the per-node, hourly, daily and kill
 *  windows (the longest is 7 days). */
const KEEP_MS = 8 * DAY;
/** auto-ping's snapshot must be this fresh to count as running. */
const AUTO_PING_FRESH_MS = 3 * MIN;
/** The pause and a route rebuild are sampled at each tick (every 10 s by
 *  default); a longer gap inside a decision's window means either could have
 *  come and gone unseen, so the decision is unscoreable. */
export const TRIAL_WATCH_GAP_MS = 2 * MIN;

export type TrialArm = 'treated' | 'held';
export type TrialPhase = 'running' | 'passed' | 'failed' | 'retired';
export type TrialClose = 'scored' | 'harm' | 'unscoreable' | 'lost';
export type SendResult = 'pending' | 'ok' | 'not-sent' | 'failed';
/** How a latch is cleared, so the screen can say what to do. */
export type LatchClear = 'restart-with-option-off' | 'move-file-aside' | 'set-trial-path' | 'make-data-writable';

export interface TrialRecord {
  id: number;
  nodeId: number;
  arm: TrialArm;
  decidedAt: number;
  dwellStartMs: number;
  /** The before-window as it stood at the decision, frozen. */
  before: WindowMetrics;
  send?: { at: number; result: SendResult; message?: string };
  /** When the +20 min verification burst was requested, and whether accepted. */
  measure?: { at: number; accepted: boolean };
  /** First Dead crossing within TRIAL_HARM_MS of the decision. */
  deathAt?: number;
  directKill?: boolean;
  /** Something outside the trial touched the node or the mesh inside the
   *  window (owner's pause, a route rebuild, an operator action): unscoreable. */
  disturbed?: string;
  lostWhy?: string;
  after?: WindowMetrics | null;
  verdict?: Verdict | null;
  close?: TrialClose;
  finalAt?: number;
}

export interface ArmTally {
  /** Scoreable decisions counted toward the verdict (scored + harm), first
   *  TRIAL_TARGET only. */
  n: number;
  /** Of those, scored `improved`. */
  ok: number;
  worse: number;
  deaths: number;
  unscoreable: number;
  lost: number;
  /** Scoreable decisions after this arm reached the target (shown, not
   *  compared: the verdict is first 30 against first 30). */
  over: number;
}

export interface TrialVerdict {
  at: number;
  pass: boolean;
  treated: { n: number; ok: number; deaths: number; lower: number };
  held: { n: number; ok: number; deaths: number; rate: number };
  why: string;
}

interface TrialFile {
  v: 1;
  homeId?: number;
  startedAt: number;
  phase: TrialPhase;
  verdict?: TrialVerdict;
  nextId: number;
  records: TrialRecord[];
  tally: Record<TrialArm, ArmTally>;
  kills: { nodeId: number; at: number }[];
  exclusions: { nodeId: number; until: number }[];
  latch?: { at: number; reason: string };
}

const emptyTally = (): ArmTally => ({ n: 0, ok: 0, worse: 0, deaths: 0, unscoreable: 0, lost: 0, over: 0 });

// ─── the narrowed handle ────────────────────────────────────────────────────

/** Everything the trial can send. Holds refreshValues and nothing else. */
export interface RefreshTrialHandle {
  readonly refreshValues: (nodeId: number) => Promise<ActionResult>;
}
type OnlyRefresh = [Exclude<keyof RefreshTrialHandle, 'refreshValues'>] extends [never] ? true : never;
const _pinHandle: OnlyRefresh = true;
void _pinHandle;

/** The suffix every refusal by the handle carries: nothing left the add-on. */
export const HANDLE_REFUSED = '— refresh not sent';

/** Build the handle from ONE function, never the runner, so this module can
 *  reach no other verb. `refuse` is checked at send time and returns why not
 *  (the owner's pause; a node that is not Alive, since zwave-js returns from a
 *  refresh of a Dead node before querying anything while Home Assistant still
 *  reports success), or null to send. */
export function trialHandle(refresh: (nodeId: number) => Promise<ActionResult>, refuse: (nodeId: number) => string | null): RefreshTrialHandle {
  return Object.freeze({
    refreshValues: (nodeId: number): Promise<ActionResult> => {
      const why = refuse(nodeId);
      return why == null ? refresh(nodeId) : Promise.resolve({ ok: false, message: `${why} ${HANDLE_REFUSED}` });
    },
  });
}

// ─── pure decision rules ────────────────────────────────────────────────────

export interface TrialEnv {
  now: number;
  enabled: boolean;
  writeActions: boolean;
  /** The owner's pause, read directly — never through auto-ping's last pass,
   *  which lags by up to its 60 s tick. */
  paused: boolean;
  /** An operator action the runner is still waiting on (a heal, a removal). */
  operatorBusy: boolean;
  homeId: number | null;
  autoPing: { suppressed: string; lastTickMs: number | null } | null;
  /** Local hour 0–23, or null when the zone is unknown. */
  hour: number | null;
  lastOperatorAt: number | null;
}

export interface TrialCandidate {
  nodeId: number;
  kind: SymptomKind;
  dwellStartMs: number;
  confounded: boolean;
  /** In its confirmation window: the symptom already went absent. */
  pending: boolean;
  /** An action has already been attributed to the episode. */
  acted: boolean;
  alive: boolean;
  /** A mains, listening node (auto-ping's probe candidate). */
  mains: boolean;
  /** rtt readings in the before-window as it stands. */
  beforeRttN: number;
  /** CC instances a user refresh of the node queries (driver dump), or null
   *  when not known yet. */
  refreshQueries: number | null;
  /** The verification lane reads a value on this node (one routed-read Get);
   *  false means it sends a NoOp ping instead. */
  probeReadable: boolean;
}

export type Gate = { ok: true } | { ok: false; reason: string };

export interface TrialStateView {
  homeId?: number;
  phase: TrialPhase;
  latch?: { at: number; reason: string };
  records: readonly TrialRecord[];
  exclusions: readonly { nodeId: number; until: number }[];
}

const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** The gates that do not depend on the episode, in the order they are shown. */
export function trialGate(s: TrialStateView, e: TrialEnv): Gate {
  if (!e.enabled) return { ok: false, reason: 'off (refresh_trial_enabled)' };
  if (s.phase !== 'running') return { ok: false, reason: `ended: ${s.phase}` };
  if (s.latch) return { ok: false, reason: `latched: ${s.latch.reason}` };
  if (!e.writeActions) return { ok: false, reason: 'write actions off' };
  if (e.paused) return { ok: false, reason: 'automatic writes paused' };
  if (e.homeId == null) return { ok: false, reason: 'home id unknown' };
  if (s.homeId != null && s.homeId !== e.homeId) return { ok: false, reason: 'home id changed — trial parked' };
  if (!e.autoPing || e.autoPing.lastTickMs == null || e.now - e.autoPing.lastTickMs > AUTO_PING_FRESH_MS) {
    return { ok: false, reason: 'auto-ping not running' };
  }
  if (e.autoPing.suppressed !== 'none') return { ok: false, reason: `auto-ping suppressed (${e.autoPing.suppressed})` };
  if (e.hour == null) return { ok: false, reason: 'local time zone unknown' };
  if (e.hour < TRIAL_HOURS.from || e.hour >= TRIAL_HOURS.to) return { ok: false, reason: `outside ${hh(TRIAL_HOURS.from)}–${hh(TRIAL_HOURS.to)}` };
  if (e.operatorBusy) return { ok: false, reason: 'an operator action is running' };
  if (e.lastOperatorAt != null && e.now - e.lastOperatorAt < TRIAL_OPERATOR_QUIET_MS) return { ok: false, reason: 'operator acted <10m ago' };
  if (s.records.some((r) => r.finalAt == null)) return { ok: false, reason: 'one decision in flight' };
  // A record dated after now (a backward clock step) still counts: the caps
  // fail closed under skew and are unchanged when the clock is right.
  const decided = (win: number): number => s.records.filter((r) => e.now - r.decidedAt < win).length;
  if (decided(HOUR) >= TRIAL_MAX_PER_HOUR) return { ok: false, reason: `hourly limit (${TRIAL_MAX_PER_HOUR})` };
  if (decided(DAY) >= TRIAL_MAX_PER_DAY) return { ok: false, reason: `daily limit (${TRIAL_MAX_PER_DAY})` };
  return { ok: true };
}

/** Does a refresh of this node send something the verification lane does not
 *  already send to both arms (DESIGN §3.5 revisit condition, second half)? */
export function refreshDiffers(refreshQueries: number | null, probeReadable: boolean): boolean | null {
  if (refreshQueries == null) return null;
  return probeReadable ? refreshQueries >= 2 : refreshQueries >= 1;
}

/** Why this episode may not be decided, or null when it may. */
export function candidateBlock(s: TrialStateView, c: TrialCandidate, now: number): string | null {
  if (c.kind !== TRIAL_KIND) return 'not the trial kind';
  if (c.pending) return 'recovering';
  if (c.confounded) return 'confounded';
  if (c.acted) return 'already acted on';
  if (now - c.dwellStartMs < TRIAL_LIVE_MS) return 'live <10m';
  if (!c.mains) return 'not a mains node';
  if (!c.alive) return 'not Alive';
  const d = refreshDiffers(c.refreshQueries, c.probeReadable);
  if (d == null) return 'refresh profile unknown';
  if (!d) return "its refresh adds nothing to the probe (P5)";
  if (c.beforeRttN < MIN_OBS) return 'before-window too thin to score';
  const ex = s.exclusions.find((x) => x.nodeId === c.nodeId && x.until > now);
  if (ex) return 'excluded after a direct kill';
  if (s.records.some((r) => r.nodeId === c.nodeId && now - r.decidedAt < TRIAL_PER_NODE_MS)) return 'node had a trial decision <24h ago';
  return null;
}

/** How a record files at its horizon. */
export function classify(r: TrialRecord): TrialClose {
  if (r.deathAt != null) return 'harm';
  if (r.lostWhy != null) return 'lost';
  if (r.disturbed != null) return 'unscoreable';
  return r.verdict === 'improved' || r.verdict === 'no-change' || r.verdict === 'worse' ? 'scored' : 'unscoreable';
}

/** The one verdict, or null until both arms reach the target. */
export function verdictOf(t: Record<TrialArm, ArmTally>, now: number): TrialVerdict | null {
  if (t.treated.n < TRIAL_TARGET || t.held.n < TRIAL_TARGET) return null;
  const lower = wilsonLower(t.treated.ok, t.treated.n);
  const rate = t.held.ok / t.held.n;
  const efficacy = lower >= rate + TRIAL_MIN_EFFECT;
  const harm = t.treated.deaths <= t.held.deaths + 1;
  const pass = efficacy && harm;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const why = pass
    ? `treated lower bound ${pct(lower)} ≥ held ${pct(rate)} + 5 pts, deaths ${t.treated.deaths} ≤ ${t.held.deaths} + 1`
    : !efficacy
      ? `treated lower bound ${pct(lower)} < held ${pct(rate)} + 5 pts`
      : `treated deaths ${t.treated.deaths} > held ${t.held.deaths} + 1`;
  return {
    at: now, pass, why,
    treated: { n: t.treated.n, ok: t.treated.ok, deaths: t.treated.deaths, lower },
    held: { n: t.held.n, ok: t.held.ok, deaths: t.held.deaths, rate },
  };
}

/** The local hour of `ms` in the process's zone (TZ), or null when the
 *  process has no zone set: the trial then sends nothing rather than guess. */
export function localHour(ms: number, tz: string | undefined = process.env.TZ): number | null {
  if (!tz) return null;
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms));
    const n = Number(h);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  } catch {
    return null;
  }
}

// ─── the store ──────────────────────────────────────────────────────────────

export interface TrialTickContext {
  now: number;
  homeId: number | null;
  writeActions: boolean;
  paused: boolean;
  operatorBusy: boolean;
  autoPing: { suppressed: string; lastTickMs: number | null } | null;
  candidates: readonly TrialCandidate[];
  /** Mains nodes, and how many of them a refresh would send more to than the
   *  verification lane (for the screen; the rule is per candidate). */
  profile: { mains: number; differs: number; unknown: number };
  /** Mark the ledger's open episode as a trial episode of this arm and return
   *  its before-window frozen; null when the episode is gone or acted on. */
  freeze: (nodeId: number, arm: TrialArm) => WindowMetrics | null;
  /** Ask the verification lane for a burst on this node; true if accepted. */
  measure: (nodeId: number) => boolean;
  /** The node's evidence window [from, to]. */
  window: (nodeId: number, from: number, to: number) => WindowMetrics | null;
  /** The ledger's verdict rule for rtt-degraded. */
  score: (before: WindowMetrics, after: WindowMetrics | null) => Verdict;
}

export interface TrialView {
  enabled: boolean;
  phase: TrialPhase;
  startedAt: number | null;
  deadlineAt: number | null;
  target: number;
  treated: ArmTally;
  held: ArmTally;
  latch: { at: number; reason: string; clear: LatchClear } | null;
  exclusions: { nodeId: number; until: number }[];
  open: { nodeId: number; arm: TrialArm; decidedAt: number; send: SendResult | null } | null;
  /** Why no episode was decided at the last tick; null after a decision. */
  idle: string | null;
  verdict: TrialVerdict | null;
  decided24h: number;
  /** From the last tick; null before the first. */
  profile: { mains: number; differs: number; unknown: number } | null;
}

export interface RefreshTrial {
  tick(ctx: TrialTickContext): void;
  onDead(nodeId: number, at: number): void;
  /** The node left the mesh (nodeId) or the mesh changed (null): every open
   *  decision on it files as lost. */
  dropOpen(nodeId: number | null, why: string, now: number): void;
  noteOperatorAction(at: number, nodeId: number | null): void;
  view(now?: number): TrialView;
  save(): boolean;
}

export interface RefreshTrialOptions {
  enabled: boolean;
  path: string | null;
  handle: RefreshTrialHandle | null;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  /** The Log screen's ring, for decisions and kills (source engine). */
  ring?: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string) => void;
  /** True when a failed send's message proves nothing left the add-on (the
   *  runner's NOT_SENT family). A failure it does not recognise may have left,
   *  and counts toward the kill window. */
  notSent?: (message: string) => boolean;
  rand?: () => number;
  hourOf?: (ms: number) => number | null;
  now?: () => number;
}

const finite = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
const obj = (x: unknown): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x);

function sane(o: unknown): o is TrialFile {
  if (!obj(o)) return false;
  const f = o as Partial<TrialFile>;
  const tallyOk = (t: unknown): boolean => obj(t) && ['n', 'ok', 'worse', 'deaths', 'unscoreable', 'lost'].every((k) => finite(t[k]))
    && (t.over === undefined || finite(t.over));
  const recOk = (r: unknown): boolean => obj(r) && finite(r.id) && finite(r.nodeId) && finite(r.decidedAt) && finite(r.dwellStartMs)
    && (r.arm === 'treated' || r.arm === 'held') && obj(r.before)
    && (r.send === undefined || (obj(r.send) && finite(r.send.at) && typeof r.send.result === 'string'))
    && (r.finalAt === undefined || finite(r.finalAt));
  const pairOk = (x: unknown, k: string): boolean => obj(x) && finite(x.nodeId) && finite(x[k]);
  return f.v === 1 && finite(f.startedAt) && finite(f.nextId)
    && (f.phase === 'running' || f.phase === 'passed' || f.phase === 'failed' || f.phase === 'retired')
    && Array.isArray(f.records) && f.records.every(recOk)
    && Array.isArray(f.kills) && f.kills.every((k) => pairOk(k, 'at'))
    && Array.isArray(f.exclusions) && f.exclusions.every((x) => pairOk(x, 'until'))
    && obj(f.tally) && tallyOk(f.tally.treated) && tallyOk(f.tally.held)
    && (f.latch === undefined || (obj(f.latch) && finite(f.latch.at) && typeof f.latch.reason === 'string'));
}

export function createRefreshTrial(o: RefreshTrialOptions): RefreshTrial {
  const nowOf = o.now ?? Date.now;
  const rand = o.rand ?? ((): number => randomInt(0, 2 ** 32) / 2 ** 32);
  const hourOf = o.hourOf ?? ((ms: number): number | null => localHour(ms));
  const notSent = (m: string): boolean => m.endsWith(HANDLE_REFUSED) || (o.notSent?.(m) ?? false);
  let lastOperatorAt: number | null = null;
  /** Operator action stamps in the last day, per node (null = mesh-wide). */
  let operatorStamps: { at: number; nodeId: number | null }[] = [];
  let idle: string | null = 'not ticked yet';
  let lastProfile: TrialView['profile'] = null;
  /** A latch the trial could not write, or a file it must not overwrite. */
  let memLatch: { at: number; reason: string; clear: LatchClear } | null = null;
  let st: TrialFile | null = null;
  /** The previous housekeeping pass, to see a gap in the watch. */
  let lastTickAt: number | null = null;
  /** A change that did not reach disk; retried on every tick. */
  let unsaved = false;

  const fresh = (now: number): TrialFile => ({
    v: 1, startedAt: now, phase: 'running', nextId: 1, records: [],
    tally: { treated: emptyTally(), held: emptyTally() }, kills: [], exclusions: [],
  });

  const save = (): boolean => {
    if (!o.path || !st) return false; // nowhere to persist: never "saved", so nothing is ever sent
    try {
      const tmp = `${o.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(st), 'utf8');
      renameSync(tmp, o.path);
      unsaved = false;
      return true;
    } catch (e) {
      unsaved = true;
      o.warn(`refresh trial: could not save ${o.path} (${(e as Error).message}) — the trial sends nothing until it can`);
      return false;
    }
  };

  // ── load ──
  {
    const now = nowOf();
    if (o.path && existsSync(o.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(o.path, 'utf8'));
        if (!sane(parsed)) throw new Error('unrecognised content');
        const loaded = parsed;
        for (const t of [loaded.tally.treated, loaded.tally.held]) t.over ??= 0;
        // A decision cannot outlive a restart: the outage hid its after-window
        // and any death in its harm window. Lost, and counted; a death already
        // recorded still files as harm.
        for (const r of loaded.records) {
          if (r.finalAt != null) continue;
          r.lostWhy ??= 'restart';
        }
        st = loaded;
      } catch (e) {
        // Fail closed: an unreadable trial file sends nothing, and is NOT
        // overwritten — its tallies may be the only record of the experiment.
        st = null;
        memLatch = { at: now, reason: `trial file unreadable (${(e as Error).message})`, clear: 'move-file-aside' };
        o.warn(`refresh trial: ${o.path} is unreadable — the trial is latched off and the file left untouched; move it aside to start a new trial`);
      }
    }
    if (st) {
      let changed = false;
      for (const r of st.records) {
        if (r.finalAt == null && r.lostWhy != null) { finalizeOn(st, r, now); changed = true; }
      }
      if (st.latch && !o.enabled) {
        o.log(`refresh trial: latch cleared — the add-on started with refresh_trial_enabled off (latched ${new Date(st.latch.at).toISOString()}: ${st.latch.reason})`);
        delete st.latch;
        changed = true;
      }
      if (changed) save();
    } else if (o.enabled && !memLatch) {
      if (!o.path) {
        memLatch = { at: now, reason: 'no trial file path (TRIAL_PATH)', clear: 'set-trial-path' };
        o.warn('refresh trial: enabled but TRIAL_PATH is unset — an assignment could not be persisted before a send, so the trial is latched off');
      } else {
        st = fresh(now);
        if (save()) o.log(`refresh trial: started — deadline ${new Date(now + TRIAL_DEADLINE_MS).toISOString().slice(0, 10)}`);
        else { st = null; memLatch = { at: now, reason: 'trial file not writable', clear: 'make-data-writable' }; }
      }
    }
  }

  function finalizeOn(file: TrialFile, r: TrialRecord, now: number): void {
    const c = classify(r);
    r.close = c;
    r.finalAt = now;
    const t = file.tally[r.arm];
    if (c === 'scored' || c === 'harm') {
      if (t.n >= TRIAL_TARGET) t.over += 1;
      else {
        t.n += 1;
        if (c === 'harm') t.deaths += 1;
        else if (r.verdict === 'improved') t.ok += 1;
        else if (r.verdict === 'worse') t.worse += 1;
      }
    } else if (c === 'unscoreable') t.unscoreable += 1;
    else t.lost += 1;
    o.log(`refresh trial: decision #${r.id} node ${r.nodeId} (${r.arm}) filed ${c}` +
      (c === 'scored' ? ` — ${r.verdict}` : c === 'lost' ? ` — ${r.lostWhy}` : c === 'unscoreable' ? ` — ${r.disturbed ?? r.verdict ?? 'no verdict'}` : '') +
      ` · treated ${file.tally.treated.n}/${TRIAL_TARGET} held ${file.tally.held.n}/${TRIAL_TARGET}`);
  }

  /** Measure, watch and file every open decision; then retention, verdict and
   *  deadline. Returns whether anything changed. */
  const housekeeping = (ctx: TrialTickContext): boolean => {
    if (!st) return false;
    const now = ctx.now;
    const prevTick = lastTickAt;
    lastTickAt = now;
    let changed = false;
    for (const r of st.records) {
      if (r.finalAt != null) continue;
      const end = r.decidedAt + TRIAL_HARM_MS;
      // Anything outside the trial that touched this node or the mesh inside
      // the window spoils the comparison, in either arm. Operator actions are
      // stamped, so they are caught at any tick; the pause and a rebuild are
      // levels, seen only while the window is watched, and a gap in the watch
      // inside the window is itself a disturbance (v0.75.0 review).
      if (r.disturbed == null) {
        const op = operatorStamps.find((x) => x.at >= r.decidedAt && x.at <= end && (x.nodeId == null || x.nodeId === r.nodeId));
        const gapFrom = prevTick ?? r.decidedAt;
        const unwatched = now - gapFrom > TRIAL_WATCH_GAP_MS && gapFrom < end && now > r.decidedAt;
        const inWindow = now <= end + 60_000;
        const why = op ? 'operator action in the window'
          : unwatched ? `window not watched (${Math.round((now - gapFrom) / 1000)}s between ticks)`
          : inWindow && ctx.paused ? 'automatic writes paused in the window'
          : inWindow && ctx.autoPing?.suppressed === 'rebuilding-routes' ? 'route rebuild in the window'
          : null;
        if (why) { r.disturbed = why; changed = true; }
      }
      if (r.measure == null && now >= r.decidedAt + TRIAL_MEASURE_MS) {
        r.measure = { at: now, accepted: ctx.measure(r.nodeId) };
        changed = true;
      }
      if (now >= end) {
        if (r.lostWhy == null && r.deathAt == null && r.disturbed == null) {
          r.after = ctx.window(r.nodeId, r.decidedAt + TRIAL_MEASURE_MS, end);
          r.verdict = ctx.score(r.before, r.after ?? null);
        }
        finalizeOn(st, r, now);
        changed = true;
      }
    }
    const before = st.records.length;
    st.records = st.records.filter((r) => r.finalAt == null || now - r.decidedAt < KEEP_MS);
    st.kills = st.kills.filter((k) => now - k.at < TRIAL_LATCH_WINDOW_MS);
    st.exclusions = st.exclusions.filter((x) => x.until > now);
    operatorStamps = operatorStamps.filter((x) => now - x.at < DAY);
    if (st.records.length !== before) changed = true;
    if (st.phase === 'running') {
      const v = verdictOf(st.tally, now);
      if (v) {
        st.verdict = v;
        st.phase = v.pass ? 'passed' : 'failed';
        o.warn(`refresh trial: VERDICT ${v.pass ? 'PASS' : 'FAIL'} — ${v.why}. Nothing more is sent; admission needs review and re-consent (DESIGN §3.5)`);
        changed = true;
      } else if (now - st.startedAt >= TRIAL_DEADLINE_MS) {
        st.phase = 'retired';
        o.warn(`refresh trial: retired after ${TRIAL_DEADLINE_MS / DAY} days without a verdict — not measurable here`);
        changed = true;
      }
    }
    return changed;
  };

  const sendResultOf = (r: ActionResult): SendResult => (r.ok ? 'ok' : notSent(r.message) ? 'not-sent' : 'failed');

  return {
    tick(ctx): void {
      const now = ctx.now;
      lastProfile = { ...ctx.profile };
      if (!st) { idle = memLatch ? `latched: ${memLatch.reason}` : 'off (refresh_trial_enabled)'; return; }
      if (unsaved) save();
      const changed = housekeeping(ctx);
      const view: TrialStateView = { ...st, ...(memLatch ? { latch: memLatch } : {}) };
      const g = trialGate(view, {
        now, enabled: o.enabled, writeActions: ctx.writeActions, paused: ctx.paused, operatorBusy: ctx.operatorBusy,
        homeId: ctx.homeId, autoPing: ctx.autoPing, hour: hourOf(now), lastOperatorAt,
      });
      if (!g.ok) { idle = g.reason; if (changed) save(); return; }
      // The oldest eligible episode first: deterministic, and blind to the arm.
      let pick: TrialCandidate | null = null;
      let firstWhy: string | null = null;
      for (const c of [...ctx.candidates].sort((a, b) => a.dwellStartMs - b.dwellStartMs || a.nodeId - b.nodeId)) {
        if (c.kind !== TRIAL_KIND) continue;
        const why = candidateBlock(st, c, now);
        if (why == null) { pick = c; break; }
        firstWhy ??= `node ${c.nodeId}: ${why}`;
      }
      if (!pick) {
        idle = firstWhy ?? (ctx.profile.differs === 0 && ctx.profile.mains > 0
          ? `no mains node's refresh differs from the probe (P5, 0 of ${ctx.profile.mains})`
          : 'no rtt-degraded episode');
        if (changed) save();
        return;
      }
      if (st.homeId == null && ctx.homeId != null) st.homeId = ctx.homeId;
      const arm: TrialArm = rand() < TRIAL_P_TREAT ? 'treated' : 'held';
      const before = ctx.freeze(pick.nodeId, arm);
      if (!before) { idle = `node ${pick.nodeId}: episode gone or acted on at decision`; if (changed) save(); return; }
      const rec: TrialRecord = {
        id: st.nextId, nodeId: pick.nodeId, arm, decidedAt: now, dwellStartMs: pick.dwellStartMs,
        before: structuredClone(before),
        ...(arm === 'treated' ? { send: { at: now, result: 'pending' as const } } : {}),
      };
      st.nextId += 1;
      st.records.push(rec);
      // Persisted BEFORE any send. A store that cannot be written sends
      // nothing, ever again this run.
      if (!save()) {
        memLatch = { at: now, reason: 'trial file not writable', clear: 'make-data-writable' };
        rec.send = undefined;
        rec.lostWhy = 'not persisted';
        finalizeOn(st, rec, now);
        idle = `latched: ${memLatch.reason}`;
        return;
      }
      idle = null;
      const msg = `decision #${rec.id} node ${rec.nodeId} rtt-degraded → ${arm.toUpperCase()}` +
        (arm === 'treated' ? ' (refresh values sent)' : ' (held: nothing sent)') +
        ` · live ${Math.round((now - pick.dwellStartMs) / MIN)}m · before rtt ${before.rttMedian?.toFixed(1) ?? '–'}ms n=${before.rttN} · scored at +30m`;
      o.log(`refresh trial: ${msg}`);
      o.ring?.('info', rec.nodeId, `trial ${msg}`);
      if (arm === 'treated') {
        const send = rec.send!;
        const h = o.handle;
        const done = (res: SendResult, m?: string): void => {
          send.result = res;
          if (m) send.message = m.slice(0, 160);
          if (st && st.records.includes(rec)) save();
          if (res !== 'ok') o.log(`refresh trial: decision #${rec.id} node ${rec.nodeId} send ${res}${m ? ` (${m})` : ''} — stays treated (intention to treat)`);
        };
        if (!h) done('not-sent', `no handle ${HANDLE_REFUSED}`);
        else h.refreshValues(rec.nodeId).then((r) => done(sendResultOf(r), r.ok ? undefined : r.message), (e: unknown) => done('failed', String(e)));
      }
    },

    onDead(nodeId, at): void {
      if (!st) return;
      let changed = false;
      let killed = false;
      for (const r of st.records) {
        if (r.nodeId !== nodeId) continue;
        // Harm is scoring: an open decision, once, inside its window.
        if (r.finalAt == null && r.deathAt == null && at >= r.decidedAt && at - r.decidedAt <= TRIAL_HARM_MS) {
          r.deathAt = at;
          changed = true;
          o.warn(`refresh trial: node ${nodeId} went Dead ${Math.round((at - r.decidedAt) / 1000)}s after decision #${r.id} (${r.arm}) — counted as harm`);
        }
        const s = r.send;
        // A kill is safety, apart from scoring: it holds for a decision already
        // filed as lost (a restart or a dropped node inside the 5 minutes) as
        // much as for an open one (v0.75.0 review). It counts any send that may
        // have left: ok, still pending, or a failure that does not prove nothing
        // was sent (a reply timeout, a dropped socket). Only a provable
        // not-sent is excused.
        if (!r.directKill && r.arm === 'treated' && s && s.result !== 'not-sent' && at >= s.at && at - s.at <= TRIAL_KILL_MS) {
          r.directKill = true;
          changed = true;
          killed = true;
          const prior = st.kills.filter((k) => at - k.at < TRIAL_LATCH_WINDOW_MS);
          st.kills.push({ nodeId, at });
          st.exclusions.push({ nodeId, until: at + TRIAL_EXCLUDE_MS });
          o.ring?.('error', nodeId, `trial: node went Dead ≤5m after an automatic refresh — excluded for 7 days`);
          if (prior.length > 0) {
            st.latch = { at, reason: 'a second direct kill within 7 days' };
            o.warn(`refresh trial: LATCHED — a second direct kill within 7 days. Nothing is sent until the add-on starts with refresh_trial_enabled off`);
            o.ring?.('error', nodeId, 'trial LATCHED: second direct kill within 7 days — set refresh_trial_enabled off to clear');
          } else {
            o.warn(`refresh trial: direct kill — node ${nodeId} excluded until ${new Date(at + TRIAL_EXCLUDE_MS).toISOString()}`);
          }
        }
      }
      // A kill that cannot reach disk would be forgotten by a restart with the
      // option still on: latch this run, and keep retrying the save.
      if (changed && !save() && killed) {
        memLatch ??= { at, reason: 'a direct kill could not be saved', clear: 'make-data-writable' };
      }
    },

    dropOpen(nodeId, why, now): void {
      if (!st) return;
      let changed = false;
      for (const r of st.records) {
        if (r.finalAt != null || (nodeId != null && r.nodeId !== nodeId)) continue;
        r.lostWhy ??= why;
        finalizeOn(st, r, now);
        changed = true;
      }
      if (changed) save();
    },

    noteOperatorAction(at, nodeId): void {
      if (lastOperatorAt == null || at > lastOperatorAt) lastOperatorAt = at;
      operatorStamps.push({ at, nodeId });
      if (operatorStamps.length > 500) operatorStamps = operatorStamps.slice(-500);
    },

    view(now = nowOf()): TrialView {
      const open = st?.records.find((r) => r.finalAt == null) ?? null;
      const latch = memLatch ?? (st?.latch ? { ...st.latch, clear: 'restart-with-option-off' as const } : null);
      return {
        enabled: o.enabled,
        phase: st?.phase ?? 'running',
        startedAt: st?.startedAt ?? null,
        deadlineAt: st ? st.startedAt + TRIAL_DEADLINE_MS : null,
        target: TRIAL_TARGET,
        treated: st ? { ...st.tally.treated } : emptyTally(),
        held: st ? { ...st.tally.held } : emptyTally(),
        latch,
        exclusions: st ? st.exclusions.filter((x) => x.until > now).map((x) => ({ ...x })) : [],
        open: open ? { nodeId: open.nodeId, arm: open.arm, decidedAt: open.decidedAt, send: open.send?.result ?? null } : null,
        idle,
        verdict: st?.verdict ?? null,
        decided24h: st ? st.records.filter((r) => now - r.decidedAt < DAY).length : 0,
        profile: lastProfile,
      };
    },

    save,
  };
}
