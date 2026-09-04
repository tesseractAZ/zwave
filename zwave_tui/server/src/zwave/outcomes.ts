/**
 * Outcome LEDGER (M5, DESIGN.md §3.6) — the learning loop's memory. It records
 * every symptom EPISODE (a symptom's lifecycle on one node) whether or not an
 * action was taken, and learns, per symptom kind, two things:
 *
 *   1. the SPONTANEOUS-RECOVERY base rate — how often a symptom of this kind
 *      resolves on its own, with no action (the control arm); and
 *   2. per (kind, action) EFFICACY — how often the symptom resolved after the
 *      operator ran a given action, and whether that beats the base rate by a
 *      minimum effect size.
 *
 * ADVISORY-ONLY (this milestone, per the owner's decision): nothing here
 * executes. The "action arm" is populated by whatever the operator runs through
 * the existing type-CONFIRM Actions Menu; symptoms that resolve untouched are
 * the control arm. The learned `expectedEfficacy` feeds back into the planner so
 * a recommendation can honestly say "beat self-healing in N past episodes" or
 * "not distinguishable from self-healing" — it never triggers an action.
 *
 * The statistics are deliberately conservative (DESIGN §3.6, DR — the
 * "regression-to-mean trap" that the patio lights healing unaided already
 * demonstrated):
 *   • SUCCESS requires the symptom's own per-command rate to fall past its
 *     release threshold AND improve by a minimum EFFECT SIZE — a count dropping
 *     is not success.
 *   • TRAFFIC-MIX COMPARABILITY: the before/after windows must carry a
 *     comparable amount of traffic (tx within a factor band), else the episode
 *     is `unverifiable` — a mesh that went quiet can fake improvement in either
 *     direction.
 *   • A driver REFUSAL (removeFailedNode throws on a live node, rebuild returns
 *     false) is `refused-misdiagnosis`, keyed to the SYMPTOM (it raises that
 *     detector's false-positive tally), and NEVER counts as action efficacy.
 *   • `expectedEfficacy` stays null until the action BEATS the no-action arm,
 *     not merely until minimum-attempts — and always renders with its n.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { ActionKind, Efficacy } from '../types';
import type { SymptomKind } from './symptoms';
import type { EvidenceSample } from './evidenceStore';

export type { Efficacy };

export type Verdict = 'improved' | 'no-change' | 'worse' | 'refused-misdiagnosis' | 'unverifiable';

/** Aggregated metrics over a window of evidence samples. Carries EVERY signal a
 *  symptom kind's recovery might show up in (timeout rate, flaps, RSSI, RTT,
 *  negotiated rate), computed kind-agnostically; `computeVerdict` then reads the
 *  ONE that matches the episode's kind (see `metricOf`). */
export interface WindowMetrics {
  samples: number; // total samples folded
  freshN: number; // samples that carried a new stats event (node was alive & communicating)
  // ── timeout family (return-path, chronic, quiet) ──
  tx: number; // Σ dTx  (successful commands the node was sent)
  rx: number; // Σ dRx
  timeouts: number; // Σ dTimeout (Get replies that never came)
  rate: number | null; // timeouts / tx, or null when tx is too small to be a rate
  // ── other recovery signals ──
  flaps: number; // Σ dFlaps (Alive↔Dead transitions) — dead-flap recovery
  s2: number; // Σ dS2Resync over samples where the log lane WAS listening
  s2Known: number; // COUNT of those samples — the s2 branch's own evidence floor
  routeChanges: number; // Σ dRouteChanges (LWR re-routes) — route-churn recovery
  routeKnown: number; // COUNT of samples whose route was VISIBLE — the route branch's evidence floor
  rssiMedian: number | null; // median of FRESH rssi readings — weak-signal recovery
  rssiN: number; // COUNT of non-null fresh rssi readings behind rssiMedian (its evidence floor)
  rttMedian: number | null; // median of FRESH rtt readings — rtt-degraded recovery
  rttN: number; // COUNT of non-null fresh rtt readings behind rttMedian (its evidence floor)
  rateKbpsMin: number | null; // worst FRESH negotiated rate seen — rate-fallback recovery (null = no fresh reading)
}

/** An open episode as a screen sees it (v0.41). */
export interface OpenEpisodeView {
  key: string;
  nodeId: number | null;
  kind: SymptomKind;
  onsetMs: number;
  /** The action attributed to this episode, if one has been. */
  actionKind: ActionKind | null;
  /** The episode has already been marked confounded (v0.40) — whatever it
   *  closes as, it will be credited to neither arm. */
  confounded: boolean;
  /** freshN of the degraded window as it currently stands, or null. */
  beforeFreshN: number | null;
}

/** One symptom episode: opens on symptom onset, closes on resolution. */
export interface Episode {
  kind: SymptomKind;
  nodeId: number | null;
  onsetMs: number;
  before: WindowMetrics | null; // degraded window at/around onset
  action: { kind: ActionKind; atMs: number; refused: boolean } | null;
  resolvedMs: number | null;
  after: WindowMetrics | null; // settled window after resolution
  verdict: Verdict | null;
  /** The node could not be probed at all (v0.38) — a sleeping battery/FLiRS
   *  device — so an `unverifiable` verdict here is structural, not starvation. */
  unprobeable?: boolean;
  /** The before-window never reached its kind's evidence floor while the
   *  after-window met its own (v0.39) — the node answered everything and the
   *  degraded state simply ended before it could be measured. A transient
   *  blink, unscoreable by construction; not a fixable evidence gap. */
  transient?: boolean;
  /** The before-window never reached its floor and the episode stayed open
   *  LONG ENOUGH that it should have (v0.41.2) — so the limit was this node's
   *  own sampling rate, not the symptom's brevity. Distinct from `transient`,
   *  which claims the state ended quickly; an audit showed that claim is
   *  arithmetically forced for an echo-only node and therefore unearned. */
  undersampled?: boolean;
  /** The node died, or a successful remediation ran on it unattributed (the
   *  confirmation-window skip), while this episode was open (v0.40). A
   *  no-action closure here is not a spontaneous recovery — an audit caught
   *  one booked control-arm `improved` whose clean after-window existed only
   *  because a dead-remediation ping revived the node mid-episode. Credited
   *  to NEITHER arm. */
  confounded?: boolean;
}

/** A decayed tally of episodes, their successes, and their REGRESSIONS. */
interface Tally {
  n: number; // decayed episode count
  ok: number; // decayed count that resolved `improved`
  /**
   * Decayed count that resolved `worse` (v0.44.0).
   *
   * `scoreRecovery` distinguishes `worse` from `no-change` at eight separate
   * sites — a rising timeout rate, new flaps, fresh S2 resyncs, more route
   * changes, lost margin, slower RTT, a dropped negotiated rate — and the
   * tally then threw that distinction away: `bump(t, verdict === 'improved')`
   * folded "made it worse" and "did nothing" into the same miss. An action
   * that harms 40% of the time and one that is merely useless both read as
   * "not distinguishable from self-healing".
   */
  bad: number;
}

export interface OutcomeStoreOptions {
  /** Per-command timeout rate at/under which a node is considered recovered.
   *  Mirrors the detectors' release threshold so "resolved" means the same
   *  thing here as it does to the symptom engine. */
  releaseRate?: number;
  /** Minimum absolute drop in per-command rate to call an action a success
   *  (guards against noise / regression to the mean). */
  minEffect?: number;
  /** Minimum decayed episode count before an efficacy estimate is offered. */
  minEpisodes?: number;
  /** Per-episode exponential decay (older episodes fade). */
  decay?: number;
  /** Persistent path on /data (atomic temp+rename). Absent ⇒ in-memory only. */
  path?: string;
  log?: (msg: string) => void;
}

export interface OutcomeStore {
  /** Open an episode for a symptom that just appeared. Idempotent per key. */
  open(nodeId: number | null, kind: SymptomKind, onsetMs: number, before: WindowMetrics | null): void;
  /** Attribute an operator action to EVERY open episode on this node (the
   *  operator picks an action for a node, not a specific symptom). First action
   *  per episode wins the attribution. `skip(key)` excludes episodes whose
   *  symptom has already gone absent (in the caller's confirmation window) — an
   *  action taken after the symptom already cleared must NOT be credited for the
   *  spontaneous recovery. */
  recordAction(
    nodeId: number | null,
    actionKind: ActionKind,
    refused: boolean,
    atMs: number,
    skip?: (key: string) => boolean,
    /**
     * Restrict attribution to these symptom kinds (v0.43.1).
     *
     * An action targets a NODE, so a success is fairly credited to any of that
     * node's open episodes — the action may well have fixed all of them. A
     * REFUSAL is the opposite: the driver rejected one specific premise ("this
     * node is failed"), which indicts only the detector that asserted it. A
     * node that is both `ghost-suspect` and `rtt-degraded` must not have its
     * RTT detector marked a false positive because the controller said the
     * node is not failed — the driver said nothing whatever about RTT.
     */
    onlyKinds?: ReadonlySet<SymptomKind>,
  ): void;
  /** Close an episode: the symptom resolved. Computes + folds the verdict. */
  resolve(nodeId: number | null, kind: SymptomKind, resolvedMs: number, after: WindowMetrics | null, opts?: { unprobeable?: boolean }): Episode | null;
  /** Drop an open episode without a verdict (e.g. node left the roster). */
  abandon(nodeId: number | null, kind: SymptomKind): void;
  /** Keys of currently-open episodes (`${nodeId}:${kind}`). */
  /** Currently-open episodes as (key, nodeId, kind) — for the caller's
   *  confirmation-window resolution loop (no key-parsing needed). */
  openEpisodes(): { key: string; nodeId: number | null; kind: SymptomKind }[];
  /** Open episodes WITH the context a screen needs (v0.41): when the episode
   *  started, and whether an action has been attributed to it yet. Until now
   *  the ledger's live workload was invisible — REMEDY could read "All clear"
   *  while an experiment was mid-flight. */
  openEpisodeDetails(): OpenEpisodeView[];
  /** The control arm itself, with the provenance behind it (v0.41). `baseRate`
   *  returns the ratio and nothing else; `controlNodes` was tracked, persisted
   *  and restored but had NO getter, so the one number that makes every
   *  efficacy claim meaningful could not be shown with its n or its sources. */
  controlArm(kind: SymptomKind): { n: number; ok: number; bad: number; nodes: number; minN: number } | null;
  /** Spontaneous-recovery base rate for a kind (control arm), or null if n too low. */
  baseRate(kind: SymptomKind): number | null;
  /** Learned efficacy of an action against a kind, for the planner. */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy;
  /** How many episodes of this kind ended `refused-misdiagnosis` (false positives). */
  falsePositives(kind: SymptomKind): number;
  /**
   * How many episodes of this kind closed `unverifiable` — the ledger's own
   * record of evidence it could not score (v0.36).
   *
   * This is the counter that would have made a silent failure loud. Over a
   * 39-hour live window every one of 16 closed episodes returned `unverifiable`
   * and therefore fed NEITHER arm, while the screens showed only an empty
   * efficacy table that reads identically to "still learning". A ledger that
   * cannot verify anything must SAY so, not look patient.
   */
  unverifiable(kind: SymptomKind): number;
  /**
   * Episodes closed `unverifiable` on a node that CANNOT BE PROBED (v0.38).
   *
   * Counted apart from the fixable kind, because they are different facts and a
   * single number conflated them. A battery or FLiRS device is never probed by
   * any lane — waking it on a cadence would flatten it — so its windows can
   * never be filled and its episodes are unscoreable BY CONSTRUCTION. That is
   * neither a fault nor something more evidence would fix, and letting it
   * accumulate in the same counter drained the meaning from a signal built to
   * flag evidence starvation, which IS fixable.
   */
  unverifiableUnprobeable(kind: SymptomKind): number;
  /** Of the unverifiable, transient blinks: the before-window never reached its
   *  kind's floor while the after-window met its own (v0.39) — the degraded
   *  state ended before it could be measured. Unscoreable by construction. */
  unverifiableTransient(kind: SymptomKind): number;
  /** Of the unverifiable, episodes that stayed open long enough to be measured
   *  and still could not be (v0.41.2) — the node reports too rarely to score at
   *  all, which is a different fact from "it was over quickly". */
  unverifiableUndersampled(kind: SymptomKind): number;
  /** Scoreable no-action closures whose node died or was remediated
   *  mid-episode (v0.40) — credited to neither arm. */
  confounded(kind: SymptomKind): number;
  /** Mark the open episode confounded: its node went Dead while the episode
   *  was open (v0.40). The data layer owns node status; the ledger cannot see
   *  it. The unattributed-action path marks itself inside recordAction. */
  markConfounded(nodeId: number | null, kind: SymptomKind): void;
  /**
   * Replace an OPEN episode's before-window with a better-evidenced one (v0.36).
   *
   * A sparse node's before-window may hold a single reading at open time, which
   * the verifier's evidence floor will later reject. When verification probes
   * subsequently fill the degraded window, this swaps the poorer window for the
   * richer one — same degraded period, more observations. Refuses to act on a
   * resolved episode, and never accepts a window with FEWER usable readings, so
   * it can only ever improve the evidence behind a verdict.
   */
  refineBefore(nodeId: number | null, kind: SymptomKind, window: WindowMetrics | null): boolean;
  /** Load the learned arms from `path` (no-op if unset/missing/corrupt). */
  load(): void;
  /** Atomically persist the learned arms to `path` (no-op if unset). */
  save(): void;
  /** Wipe ALL state — open episodes and learned arms (a different network
   *  invalidates the learned efficacy; mirrors baselines.reset()). */
  reset(): void;
  /** Pure serialize / restore (the fs wrappers above delegate to these). */
  toJSON(): unknown;
  loadJSON(raw: unknown): void;
}

/** Median of a numeric list, or null if empty. */
function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Aggregate a window of samples into EVERY recovery signal. `minTx` below which
 *  a timeout rate is not meaningful → rate stays null (never a fabricated 0/0).
 *  RSSI/RTT are taken from FRESH samples only (a re-sampled EMA carries no new
 *  information); flaps are event-driven counts; rateKbps is the worst seen. */
/**
 * The samples belonging to an episode's DEGRADED span (v0.36).
 *
 * From one window BEFORE the breach that armed the symptom through to `now`.
 * Not the plain trailing window: a symptom surfaces at dwell maturity, and the
 * dwell equals the lookback, so a trailing window opened at emission starts
 * exactly where the firing observation ends — the reading that proved the node
 * degraded was excluded from the evidence for its own episode, and on a node
 * too quiet to speak twice in five minutes that left the window empty and the
 * verdict `unverifiable` before it was computed.
 *
 * Every sample in this span belongs to the same live symptom, so widening to
 * cover the breach adds no other state — only the readings that were the point.
 */
/**
 * Is an episode in its confirmation window ready for its AFTER-window probes?
 *
 * The after-window is a trailing `windowMs` slice taken at RESOLVE, which
 * happens `confirmMs` after the symptom went absent. v0.36.0 requested the
 * confirmation burst the moment the symptom cleared — so its readings were
 * `confirmMs - burstLength` old by the time the window was cut, and every one
 * of them had aged out of the very window they existed to fill. The episode
 * then scored `unverifiable` with three perfectly good answered probes sitting
 * just outside the frame.
 *
 * Probing only once the pending age has reached `confirmMs - windowMs` puts the
 * whole burst inside the slice that will actually be measured.
 *
 * Deliberately NOT solved by widening the after-window instead: the confirm
 * dwell exists so the after-window settles past the recovery transition, and
 * stretching it back over the whole confirmation period would re-admit exactly
 * the unsettled readings that dwell is there to exclude.
 */
export function confirmBurstDue(
  pendingSinceMs: number,
  now: number,
  confirmMs: number,
  windowMs: number,
): boolean {
  return now - pendingSinceMs >= Math.max(0, confirmMs - windowMs);
}

export function degradedSpan(
  samples: EvidenceSample[],
  sinceMs: number,
  now: number,
  windowMs: number,
): EvidenceSample[] {
  const from = Math.min(sinceMs, now) - windowMs;
  return samples.filter((s) => s.t >= from && s.t <= now);
}

export function windowMetrics(samples: EvidenceSample[], minTx = 5): WindowMetrics {
  let tx = 0, rx = 0, timeouts = 0, flaps = 0, s2 = 0, s2Known = 0, n = 0, freshN = 0;
  let routeChanges = 0, routeKnown = 0;
  const rssis: number[] = [], rtts: number[] = [];
  let rateKbpsMin: number | null = null;
  for (const s of samples) {
    n++;
    if (s.dTx != null) tx += s.dTx;
    if (s.dRx != null) rx += s.dRx;
    if (s.dTimeout != null) timeouts += s.dTimeout;
    if (s.dFlaps != null) flaps += s.dFlaps; // typed non-null, but guard legacy/persisted samples from NaN
    // dS2Resync is null when the driver-WS log lane was NOT listening. Count
    // only listening samples, and count HOW MANY — the s2 verdict needs its
    // own liveness evidence, not the HA-stats freshN of a different transport.
    if (s.dS2Resync != null) { s2 += s.dS2Resync; s2Known += 1; }
    // Route churn needs the SAME visibility discipline as the S2 lane, for a
    // reason created by the route-key fix itself: a node whose `lwr` goes dark
    // now (correctly) scores ZERO route changes, because a route we cannot see
    // has not moved. Counting only the changes would make that silence
    // indistinguishable from a settled path, and the after-window of a blinded
    // node would score as a cure. `routeKnown` is the count of samples where a
    // route was actually on record.
    if (typeof s.dRouteChanges === 'number') routeChanges += s.dRouteChanges;
    if (s.routeKey != null) routeKnown += 1;
    // rssi/rtt/rateKbps are re-sampled from the driver's cached stats and carry
    // NEW information ONLY when the sample is fresh — a re-read of the same cached
    // value is not an observation (evidenceStore: "route fields meaningful ONLY
    // when fresh"). Fold all three under the fresh gate so a quiet node cannot
    // manufacture a metric from stale carry-forwards.
    if (s.fresh) {
      freshN++;
      if (s.rssi != null) rssis.push(s.rssi);
      if (s.rtt != null) rtts.push(s.rtt);
      if (s.rateKbps != null) rateKbpsMin = rateKbpsMin == null ? s.rateKbps : Math.min(rateKbpsMin, s.rateKbps);
    }
  }
  return {
    samples: n, freshN,
    tx, rx, timeouts, rate: tx >= minTx ? timeouts / tx : null,
    flaps, s2, s2Known, routeChanges, routeKnown,
    rssiMedian: median(rssis), rssiN: rssis.length,
    rttMedian: median(rtts), rttN: rtts.length,
    rateKbpsMin,
  };
}

const DEFAULTS = { releaseRate: 0.075, minEffect: 0.05, minEpisodes: 4, decay: 0.03 } as const;

// Traffic-mix comparability: the two windows must both carry real traffic and be
// within this factor of each other, else improvement is not attributable.
const MIN_WINDOW_TX = 5;
const TRAFFIC_FACTOR = 3;
// A rate that grew past this factor of the before-rate is a regression, not noise.
const WORSE_FACTOR = 1.5;

function comparable(a: WindowMetrics, b: WindowMetrics): boolean {
  // Comparability is on TX only — it is the denominator of the per-command rate
  // being compared, so a large TX shift is what actually poisons the rate. RX is
  // deliberately NOT gated: a SET-only node legitimately has near-zero unsolicited
  // RX, and requiring RX-comparability would wrongly mark all such nodes
  // `unverifiable`. (An RX-collapse-while-TX-steady case is a rare uncovered edge,
  // documented rather than papered over with a guard that breaks SET-only nodes.)
  if (a.tx < MIN_WINDOW_TX || b.tx < MIN_WINDOW_TX) return false;
  const hi = Math.max(a.tx, b.tx), lo = Math.min(a.tx, b.tx);
  return hi <= lo * TRAFFIC_FACTOR;
}

// ── Per-kind recovery metric ────────────────────────────────────────────────
// A symptom's recovery shows up in a DIFFERENT signal depending on its kind, on
// a different scale. Scoring every episode by the timeout rate (the original M5
// behaviour) meant non-timeout kinds could never register improvement. Each kind
// is mapped to the signal its recovery actually moves.
export type RecoveryMetric = 'timeout' | 'flap' | 'rssi' | 'rtt' | 'rate' | 's2' | 'route' | 'none';

export function metricOf(kind: SymptomKind): RecoveryMetric {
  switch (kind) {
    case 'return-path-degraded':
    case 'chronic-return-path':
    case 'quiet-node':
      return 'timeout'; // reply-timeout rate
    case 'dead-flap':
      return 'flap'; // Alive↔Dead transitions stopping
    case 'node-down':
      // NOT scoreable by this ledger, and the reason is structural rather than
      // a missing signal — see DOCS §9.9. Two independent problems compound:
      //
      //  (1) An episode closes only when the symptom goes absent, and node-down
      //      is absent exactly when the node stops being Dead. So every closure
      //      is a recovery: `ok === n`, baseRate 1.0, and the Wilson gate needs
      //      `>= base + minEffect` = 1.05, which wilsonLower(n,n) approaches
      //      from below and never reaches at ANY n. An arm that cannot ever
      //      credit the action is not a measurement.
      //  (2) Even given a failure exit, auto-ping is applied NON-RANDOMLY: it
      //      probes only outages that already survived its dwell. The control
      //      arm would fill with fast self-heals and the action arm with the
      //      hard cases, so any difference would be selection, not efficacy.
      //
      // `none` is the honest answer until there is a design that measures it.
      return 'none';
    case 's2-desync':
      return 's2'; // SPAN resyncs subsiding
    case 'weak-signal':
      return 'rssi'; // signal strength improving
    case 'rtt-degraded':
      return 'rtt'; // round-trip time dropping
    case 'rate-fallback':
      return 'rate'; // negotiated rate back to 100k
    case 'route-churn':
      return 'route'; // LWR re-routes subsiding
    default:
      // TWO different reasons live here, and conflating them is exactly how
      // route-churn stayed mis-justified for two minor versions:
      //   • genuinely multi-node / mesh-scoped — controller-degraded,
      //     edge-cluster, mesh-interference — no single per-node recovery
      //     window can score them;
      //   • per-node, but with NO metric whose movement means recovery —
      //     chatty-device (a flooder that stops looks identical to one that went
      //     silent) and ghost-suspect (the remedy REMOVES the node, so there is
      //     nothing left to measure afterwards). Both carry a concrete nodeId,
      //     so calling them "mesh-scoped" was factually false.
      // Either way the honest verdict is unverifiable.
      //
      // route-churn USED to sit in this list under that same justification, and
      // the justification was simply wrong for it: it is emitted per node, with
      // a nodeId, backed by a per-node event accumulator — structurally
      // identical to s2-desync, which was always scored. Its remedies being
      // physical is no reason to refuse to measure them; weak-signal and
      // s2-desync are physical too and are scored on their own signal.
      return 'none';
  }
}

// Evidence floors. Each metric must gate on observations of ITS OWN signal, not
// on a shared "fresh sample" count — a fresh sample routinely carries a null
// rssi/rtt (no-signal sentinels), so freshN over-counts usable readings and a
// median-of-one could otherwise pass as robust.
/**
 * How long an episode must stay open before a starved before-window stops
 * meaning "it was over quickly" and starts meaning "we cannot sample this node
 * fast enough" (v0.41.2).
 *
 * The verification burst is 5 probes at ~60 s of effective spacing, so an
 * episode that lives past ~5 minutes has had every opportunity the engine can
 * create to fill its degraded window. If the floor is STILL unmet after that,
 * the shortfall is the device's cadence, not the symptom's duration — and an
 * audit found the difference matters: for a node whose only fresh readings are
 * its 120-minute sweep replies, `transient` was arithmetically guaranteed, so
 * the line "degraded state ended before its evidence floor" was asserted on
 * evidence that could not distinguish it from "we only ever got one look".
 */
const UNDERSAMPLED_AFTER_MS = 5 * 60_000;

const MIN_OBS = 3; // minimum non-null rssi/rtt readings behind a trustworthy median
const MIN_LIVE = 3; // minimum FRESH samples proving the node is alive & communicating (flap after-window)
const RSSI_MIN_GAIN = 4; // dB — a meaningful signal-strength improvement
const RTT_DROP_FRAC = 0.25; // ≥25% faster …
const RTT_MIN_DROP_MS = 20; // … AND at least this many ms (guards tiny-baseline noise)

/** Per-SIDE evidence floors, factored out of `scoreRecovery` so the resolve
 *  path can ask WHICH side of an `unverifiable` verdict starved (v0.39). The
 *  distinction carries meaning: a before-side failure with a fed after-window
 *  means the degraded state ended before it could be measured (a transient),
 *  while an after-side failure is a gap more evidence could have filled. Joint
 *  checks (the timeout tx-ratio) are not floors and stay in `scoreRecovery`:
 *  they compare the sides to each other, so neither side alone can fail them. */
export function sideFloorMet(m: RecoveryMetric, w: WindowMetrics | null, side: 'before' | 'after'): boolean {
  if (w == null) return false;
  switch (m) {
    case 'timeout':
      return w.rate != null && w.tx >= MIN_WINDOW_TX;
    case 'flap':
      // Event drain: the before-window needs only prior flapping; the
      // after-window must prove the node ALIVE (see scoreRecovery's comments,
      // which remain the rationale of record for every branch here).
      return side === 'before' ? w.flaps >= 1 : w.freshN >= MIN_LIVE;
    case 's2':
      return side === 'before' ? w.s2 >= 1 && w.s2Known >= 1 : w.s2Known >= MIN_LIVE && w.freshN >= MIN_LIVE;
    case 'route':
      return side === 'before' ? w.routeChanges >= 1 && w.routeKnown >= 1 : w.routeKnown >= MIN_LIVE && w.freshN >= MIN_LIVE;
    case 'rssi':
      return w.rssiMedian != null && w.rssiN >= MIN_OBS;
    case 'rtt':
      return w.rttMedian != null && w.rttN >= MIN_OBS;
    case 'rate':
      return w.rateKbpsMin != null;
    case 'none':
      return false;
  }
}

/** Score an episode's recovery by its kind's metric. Each branch keeps the same
 *  honesty contract as the timeout metric: an incomparable / evidence-poor pair
 *  is `unverifiable` (never a fabricated win), and a regression is `worse`. Every
 *  branch gates on evidence of ITS OWN signal (rssiN/rttN readings, fresh-only
 *  rateKbps, live after-window for flaps) — never the shared freshN. The floors
 *  themselves live in `sideFloorMet` (single source of truth with the resolve
 *  path's transient classification); each branch keeps only its comparison. */
function scoreRecovery(m: RecoveryMetric, before: WindowMetrics, after: WindowMetrics, releaseRate: number, minEffect: number): Verdict {
  if (!sideFloorMet(m, before, 'before') || !sideFloorMet(m, after, 'after')) return 'unverifiable';
  switch (m) {
    case 'timeout': {
      // rate null-checks re-stated for TS narrowing only — the floor already
      // ran in sideFloorMet. comparable() is the joint tx-ratio check.
      if (before.rate == null || after.rate == null || !comparable(before, after)) return 'unverifiable';
      if (after.rate > before.rate * WORSE_FACTOR && after.rate > releaseRate) return 'worse';
      return after.rate <= releaseRate && before.rate - after.rate >= minEffect ? 'improved' : 'no-change';
    }
    case 'flap': {
      // flaps are concrete event drains (fresh-independent), so the before-window
      // needs only prior flapping (flaps ≥ 1) — NOT a fresh-sample floor, which a
      // mostly-Dead flapping node rarely meets. The after-window, though, must
      // prove the node is ALIVE and communicating (MIN_LIVE fresh samples), so a
      // node that simply went hard-dead (0 flaps because 0 transitions) is not
      // mistaken for a recovery. Both floors enforced in sideFloorMet.
      if (after.flaps > before.flaps) return 'worse';
      return after.flaps === 0 ? 'improved' : 'no-change'; // a clean, live after-window = flapping stopped
    }
    case 's2': {
      // Same discipline as 'flap': resyncs are concrete event drains, so the
      // before-window needs only prior evidence (s2 ≥ 1). The after-window must
      // prove the node is still ALIVE and communicating — otherwise a node that
      // went silent (0 resyncs because 0 traffic) reads as a cure. Absence of
      // failure is only recovery when there was something to fail.
      // …and the S2 LANE'S OWN liveness, which freshN cannot carry: freshN
      // measures the HA-statistics transport, while dS2Resync comes from the
      // driver-WS log lane, and the two fail independently. Without s2Known,
      // a storm-stop or an operator log-level change mid-episode switched the
      // measurement off and the resulting run of zeros scored as a recovery
      // the action never earned (v0.26 review). All floors in sideFloorMet.
      if (after.s2 > before.s2) return 'worse';
      return after.s2 === 0 ? 'improved' : 'no-change';
    }
    case 'route': {
      // Same discipline as 's2', and for the same reason. Re-routes are event
      // drains, so the before-window needs only prior evidence (≥1 change) —
      // but BOTH windows must also prove the route was VISIBLE, or a node whose
      // `lwr` went dark scores a run of zeros and reads as settled. And the
      // after-window must prove the node is still alive: a node that stopped
      // talking altogether cannot re-route, and that is not a cure either.
      // All floors in sideFloorMet.
      if (after.routeChanges > before.routeChanges) return 'worse';
      return after.routeChanges === 0 ? 'improved' : 'no-change';
    }
    case 'rssi': {
      // Null-checks for TS narrowing only — the MIN_OBS floors ran in sideFloorMet.
      if (before.rssiMedian == null || after.rssiMedian == null) return 'unverifiable';
      const gain = after.rssiMedian - before.rssiMedian; // higher (less negative) = stronger
      if (gain <= -RSSI_MIN_GAIN) return 'worse';
      return gain >= RSSI_MIN_GAIN ? 'improved' : 'no-change';
    }
    case 'rtt': {
      // Null-checks for TS narrowing only — the MIN_OBS floors ran in sideFloorMet.
      if (before.rttMedian == null || after.rttMedian == null) return 'unverifiable';
      if (after.rttMedian >= before.rttMedian * WORSE_FACTOR) return 'worse';
      return after.rttMedian <= before.rttMedian * (1 - RTT_DROP_FRAC) && before.rttMedian - after.rttMedian >= RTT_MIN_DROP_MS
        ? 'improved' : 'no-change';
    }
    case 'rate': {
      // rateKbpsMin is fresh-only (windowMetrics), so a non-null value already
      // means ≥1 fresh negotiated-rate reading; a purely-stale (quiet) window is
      // null → unverifiable, matching the other signals' fail-closed rule.
      if (before.rateKbpsMin == null || after.rateKbpsMin == null) return 'unverifiable';
      if (after.rateKbpsMin < before.rateKbpsMin) return 'worse';
      return before.rateKbpsMin < 100 && after.rateKbpsMin >= 100 ? 'improved' : 'no-change';
    }
    case 'none':
      return 'unverifiable';
  }
}

/**
 * Wilson score interval LOWER bound at ~95% (z=1.96) for a binomial rate.
 *
 * The green "✓ helped X%" advisory used the RAW success rate, so at the minimum
 * n a fluke reads as proof: 4/4 successes is a point estimate of 100% but the
 * true rate could plausibly be barely above half — a coin-flip dressed as a
 * verdict (v0.26 assessment fix). Gating the claim on the Wilson LOWER bound
 * means "even pessimistically, this beats leaving it alone." Wilson (not
 * normal-approx) because it stays sane at the small n and extreme rates this
 * feature lives at.
 */
export function wilsonLower(ok: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = ok / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export function createOutcomeStore(opts: OutcomeStoreOptions = {}): OutcomeStore {
  const cfg = { ...DEFAULTS, ...clean(opts) };
  const log = opts.log ?? (() => {});
  const open = new Map<string, Episode>();
  /** Learned-arm state changed since the last successful save (v0.26 review).
   *  outcomes.ts was the ONLY persisted store without this — its own docs
   *  claimed it had one — so it rewrote the whole file 288×/day regardless.
   *  baselines.ts and evidenceStore.ts both open save() with the same guard. */
  let dirty = false;

  // Per-kind control arm (no-action episodes) and per-detector false positives.
  const control = new Map<SymptomKind, Tally>();
  const fp = new Map<SymptomKind, number>();
  // Episodes closed `unverifiable`, per kind — see the interface docstring.
  const unver = new Map<SymptomKind, number>();
  /** Unscoreable on a node we are not allowed to probe — see the interface. */
  const unverUnprobe = new Map<SymptomKind, number>();
  // Episodes closed `unverifiable` because the degraded state ended before the
  // before-window could reach its kind's floor, while the after-window met its
  // own (v0.39) — transient blinks, unscoreable by construction.
  const unverTransient = new Map<SymptomKind, number>();
  // Episodes that lived long enough to be measured and still could not be —
  // the node's own reporting cadence is the binding constraint (v0.41.2).
  const unverUndersampled = new Map<SymptomKind, number>();
  // Scoreable no-action closures whose node died or was remediated
  // mid-episode (v0.40) — credited to neither arm; see Episode.confounded.
  const confoundedTally = new Map<SymptomKind, number>();
  /**
   * Which DISTINCT nodes fed each arm (v0.36.5).
   *
   * The arms are marginal by design — keyed by kind, or by kind|action — so a
   * single pathological device can saturate one. Observed live within hours of
   * the ledger starting to work: node 23 flapped a dozen times and taught the
   * fleet-wide (rtt-degraded, ping) arm six no-change episodes entirely on its
   * own, past `minEpisodes`. The statistics were honest and the provenance was
   * invisible: `n=6` reads as six nodes agreeing when it was one node repeating.
   *
   * Cumulative and deliberately NOT decayed: this answers "how broad is the
   * evidence", which does not get narrower with age the way a rate does.
   */
  const armNodes = new Map<string, Set<number>>();
  const controlNodes = new Map<SymptomKind, Set<number>>();
  const noteNode = (m: Map<string, Set<number>>, k: string, nodeId: number | null): void => {
    if (nodeId == null) return; // a mesh-scoped episode is not a node
    const set = m.get(k) ?? new Set<number>();
    set.add(nodeId); m.set(k, set);
  };
  // Per (kind ▸ action) action arm — deliberately NOT banded; see the note in resolve().
  const action = new Map<string, Tally>();

  const key = (nodeId: number | null, kind: SymptomKind): string => `${nodeId ?? 'mesh'}:${kind}`;
  const aKey = (kind: SymptomKind, act: ActionKind): string => `${kind}|${act}`;

  // Takes the VERDICT, not a boolean (v0.44.0): a boolean cannot carry the
  // difference between "did nothing" and "made it worse".
  const bump = (t: Tally | undefined, verdict: Verdict): Tally => {
    const cur = t ?? { n: 0, ok: 0, bad: 0 };
    const keep = 1 - cfg.decay;
    return {
      n: cur.n * keep + 1,
      ok: cur.ok * keep + (verdict === 'improved' ? 1 : 0),
      bad: cur.bad * keep + (verdict === 'worse' ? 1 : 0),
    };
  };

  const computeVerdict = (ep: Episode): Verdict => {
    if (ep.action?.refused) return 'refused-misdiagnosis';
    if (!ep.before || !ep.after) return 'unverifiable';
    // Score by the recovery signal that THIS symptom kind's fix actually moves.
    return scoreRecovery(metricOf(ep.kind), ep.before, ep.after, cfg.releaseRate, cfg.minEffect);
  };

  return {
    open(nodeId, kind, onsetMs, before): void {
      const k = key(nodeId, kind);
      if (open.has(k)) return; // one open episode per key (matches the detector lifecycle)
      open.set(k, { kind, nodeId, onsetMs, before, action: null, resolvedMs: null, after: null, verdict: null });
    },

    recordAction(nodeId, actionKind, refused, atMs, skip, onlyKinds): void {
      // Attribute to EVERY open episode on this node (an action targets a node;
      // any of its active symptoms could be the one it addresses). First action
      // per episode wins — a later action can't cleanly be credited. Skip
      // episodes whose symptom already went absent (confirmation window): an
      // action there would steal credit for a spontaneous recovery.
      const prefix = `${nodeId ?? 'mesh'}:`;
      for (const [k, ep] of open) {
        if (!k.startsWith(prefix)) continue;
        // A refusal indicts only the detectors that ASKED for this action
        // (v0.43.1) — see `onlyKinds` on the interface. Success attribution is
        // deliberately unscoped and keeps the node-wide behaviour above.
        if (onlyKinds && !onlyKinds.has(ep.kind)) continue;
        if (skip?.(k)) {
          // The action ran on this node while this episode was already in its
          // confirmation window — not attributable, but not ignorable either
          // (v0.40): the recovery about to be booked "no action" may exist
          // only because this action revived the node. Confounded: the
          // spontaneous-recovery claim is dead, whatever the verdict.
          ep.confounded = true;
          continue;
        }
        if (ep.action == null) ep.action = { kind: actionKind, atMs, refused };
      }
    },

    markConfounded(nodeId, kind): void {
      // The node went Dead while this episode was open (v0.40) — whatever the
      // windows end up showing, "it recovered on its own" is no longer a clean
      // control observation. Marked by the data layer, which owns node status.
      const ep = open.get(key(nodeId, kind));
      if (ep) ep.confounded = true;
    },

    resolve(nodeId, kind, resolvedMs, after, resolveOpts): Episode | null {
      const k = key(nodeId, kind);
      const ep = open.get(k);
      if (!ep) return null;
      open.delete(k);
      ep.resolvedMs = resolvedMs;
      ep.after = after;
      // Recorded at RESOLVE, not at open: probeability is a property of the
      // device the caller knows and the ledger does not.
      if (resolveOpts?.unprobeable) ep.unprobeable = true;
      ep.verdict = computeVerdict(ep);

      if (ep.verdict === 'refused-misdiagnosis') {
        fp.set(kind, (fp.get(kind) ?? 0) + 1);
        dirty = true;
      } else if (ep.verdict === 'unverifiable' && ep.unprobeable) {
        // Structural: no amount of further evidence can arrive, because we are
        // not permitted to ask this device for any.
        unverUnprobe.set(kind, (unverUnprobe.get(kind) ?? 0) + 1);
        dirty = true;
      } else if (ep.verdict === 'unverifiable') {
        // Contributes to NEITHER arm — an honest "we couldn't tell". COUNTED
        // though (v0.36): an unscoreable episode is not nothing, it is the
        // ledger telling you its evidence was too thin, and that fact has to
        // reach a screen or a structurally-inert loop looks like a patient one.
        //
        // Two different facts hide inside a starved verdict, and conflating
        // them drains the fixable signal — the same defect class the v0.38
        // unprobeable split fixed, forced here by the 08-27 exemplar
        // (`before fresh=1 | after fresh=5` on a node that answered all ten
        // probes): a before-window that never reached its kind's floor WHILE
        // the after-window met its own means the degraded state ended before
        // it could be measured. refineBefore correctly stops refining once
        // the symptom clears, so no amount of probing can ever fill that
        // window — a transient blink, not a gap more evidence could fix.
        // Only an after-side starvation stays in the fixable counter.
        //
        // …and only when the metric's lane was actually WATCHING (v0.39
        // review): the route/s2 before-floors conjoin symptom presence with
        // lane visibility, and a dark lane is a fixable, operator-actionable
        // evidence problem — hours of real churn under a dark LWR lane must
        // not close as "over before the floor filled". A null before-window
        // fails the same way: with zero evidence there is no basis to claim
        // the state was brief.
        const m = metricOf(kind);
        // How long the degraded state actually persisted. A starved before
        // window on a LONG episode is a sampling limit, not brevity.
        const openMs = ep.resolvedMs != null ? ep.resolvedMs - ep.onsetMs : 0;
        const laneVisible = ep.before != null
          && (m === 'route' ? ep.before.routeKnown >= 1 : m === 's2' ? ep.before.s2Known >= 1 : true);
        if (laneVisible && !sideFloorMet(m, ep.before, 'before') && sideFloorMet(m, ep.after, 'after')) {
          if (openMs >= UNDERSAMPLED_AFTER_MS) {
            // It had the time; it never had the readings.
            ep.undersampled = true;
            unverUndersampled.set(kind, (unverUndersampled.get(kind) ?? 0) + 1);
          } else {
            ep.transient = true;
            unverTransient.set(kind, (unverTransient.get(kind) ?? 0) + 1);
          }
        } else {
          unver.set(kind, (unver.get(kind) ?? 0) + 1);
        }
        dirty = true;
      } else if (ep.confounded) {
        // NOT an observation of EITHER arm (v0.40, widened v0.44.0): the node
        // died or an unattributed remediation ran on it while the episode was
        // open, so neither "recovered with no action" nor "the action did it"
        // is a claim the evidence supports. In the audited exemplar the clean
        // after-window existed only because a dead-remediation ping revived the
        // node.
        //
        // The v0.40 rationale — "a confounded non-improvement would bias the
        // arm exactly as dishonestly in the other direction" — was written for
        // the control arm and applies verbatim to the action arm, which was
        // still being fed. It applies DOUBLY now that `bad` exists: a node
        // dying mid-episode generates re-routes and S2 resyncs by
        // construction, and `worse` for the route and s2 metrics is literally
        // `after.X > before.X` — so a death could manufacture a harm verdict
        // against whatever action happened to be in flight.
        confoundedTally.set(kind, (confoundedTally.get(kind) ?? 0) + 1);
        dirty = true;
      } else if (ep.action == null) {
        // Control arm: a symptom that resolved with no action taken.
        control.set(kind, bump(control.get(kind), ep.verdict));
        noteNode(controlNodes as unknown as Map<string, Set<number>>, kind, ep.nodeId);
        dirty = true;
      } else {
        // Action arm — keyed by (kind, action) to match the un-banded control
        // arm. Time-of-day banding is deliberately NOT applied: it would need
        // n≥MIN per band across 6 bands to learn, and comparing a band-summed
        // action rate against an un-banded base rate is a Simpson's-paradox
        // confound. Both arms stay marginal (a documented diurnal-confound
        // limitation — see baseRate/efficacyFor).
        const ak = aKey(kind, ep.action.kind);
        action.set(ak, bump(action.get(ak), ep.verdict));
        noteNode(armNodes, ak, ep.nodeId);
        dirty = true;
      }
      // The per-window evidence counts ride the closure line (v0.38.2). Three
      // rtt-degraded episodes on probed, answering nodes closed `unverifiable`
      // in one audit window while rate-fallback scored 6-for-6 under identical
      // probes — and the log could not say WHICH floor failed or by how much,
      // so the candidate mechanisms (stats events omitting rtt vs the sampling
      // cadence collapsing probes vs the before-window refinement stopping
      // early) were indistinguishable. A verdict that cannot show its
      // arithmetic invites another guessed fix; this cycle has had four.
      // The counts prove the FLOORS were met; they do not show WHY the verdict
      // came out as it did — the rtt branch decides on medians, the flap/s2/
      // route branches on event counts, the timeout branch on a rate. An audit
      // put it plainly: a closure line printing only counts is equally
      // consistent with `improved`, `no-change` AND `worse`. Since a resolved
      // episode is never persisted, this line is the ONLY lasting record of the
      // verdict's inputs, so it now carries the deciding quantity too (v0.40.2).
      // One decimal, not Math.round: the rtt branch decides on a 25% drop AND a
      // 20 ms floor, so a rounded median can contradict the verdict printed
      // beside it at the threshold.
      const num = (x: number | null, unit = ''): string => (x == null ? '–' : `${x.toFixed(1)}${unit}`);
      // s2Known / routeKnown ride along because they are the s2 and route
      // branches' OWN evidence floors — without them `s2=0` reads identically
      // for "no resyncs happened" and "the lane was not listening", which is
      // the exact blind spot the v0.26 review created those counters to close.
      // `tx` likewise: it is the timeout family's denominator and the input to
      // the comparability gate, so without it an `unverifiable` timeout verdict
      // cannot be told from a scored one.
      const win = (w: WindowMetrics | null): string =>
        w == null
          ? 'none'
          : `fresh=${w.freshN} rtt=${w.rttN}/${num(w.rttMedian, 'ms')} rssi=${w.rssiN}/${num(w.rssiMedian)} ` +
            `rate=${w.rateKbpsMin != null ? w.rateKbpsMin : 'n'} flaps=${w.flaps} s2=${w.s2}/${w.s2Known} ` +
            `rt=${w.routeChanges}/${w.routeKnown} tx=${w.tx} tmo=${w.rate == null ? '–' : (w.rate * 100).toFixed(1) + '%'}`;
      const tag = ep.undersampled
        ? ' (undersampled — this node reports too rarely to reach the floor, whatever the duration)'
        : ep.transient
        ? ' (transient — degraded state ended before its evidence floor)'
        : ep.confounded && ep.action == null && ep.verdict !== 'unverifiable' && ep.verdict !== 'refused-misdiagnosis'
          ? ' (confounded — the node died or was remediated mid-episode; credited to neither arm)'
          : '';
      log(`episode ${k} ${ep.verdict}${ep.action ? ' after ' + ep.action.kind : ' (no action)'} [before ${win(ep.before)} | after ${win(ep.after)}]${tag}`);
      return ep;
    },

    abandon(nodeId, kind): void {
      open.delete(key(nodeId, kind));
    },

    openEpisodes(): { key: string; nodeId: number | null; kind: SymptomKind }[] {
      return [...open.entries()].map(([k, ep]) => ({ key: k, nodeId: ep.nodeId, kind: ep.kind }));
    },

    openEpisodeDetails(): OpenEpisodeView[] {
      return [...open.entries()].map(([k, ep]) => ({
        key: k,
        nodeId: ep.nodeId,
        kind: ep.kind,
        onsetMs: ep.onsetMs,
        actionKind: ep.action?.kind ?? null,
        confounded: ep.confounded === true,
        beforeFreshN: ep.before?.freshN ?? null,
      }));
    },

    controlArm(kind): { n: number; ok: number; bad: number; nodes: number; minN: number } | null {
      const t = control.get(kind);
      if (!t) return null;
      // `minN` rides along (v0.50.0) so a screen can apply the SAME readiness
      // rule `baseRate()` applies two functions below. Without it ENGINE
      // rendered `self-heal 100% (n≈1.0)` for an arm whose rate this store
      // refuses to publish at all.
      return { n: t.n, ok: t.ok, bad: t.bad, nodes: controlNodes.get(kind)?.size ?? 0, minN: cfg.minEpisodes };
    },

    baseRate(kind): number | null {
      const t = control.get(kind);
      if (!t || t.n < cfg.minEpisodes) return null;
      return t.ok / t.n;
    },

    efficacyFor(kind, act): Efficacy {
      const base = this.baseRate(kind);
      const t = action.get(aKey(kind, act));
      const n = t?.n ?? 0, ok = t?.ok ?? 0, harmed = t?.bad ?? 0;
      const nodes = armNodes.get(aKey(kind, act))?.size ?? 0;
      // The CONTROL arm's own evidence (v0.44.0). `baseRate` was published as a
      // bare percentage while the action arm beside it carried n and provenance
      // — so "vs 80% self-heal" could be four episodes on one node, and the
      // screen had no way to say so. Same two numbers, same meaning, same
      // renderer.
      const ct = control.get(kind);
      const baseN = ct?.n ?? 0;
      const baseHarmed = ct?.bad ?? 0;
      const baseNodes = controlNodes.get(kind)?.size ?? 0;
      const minN = cfg.minEpisodes;
      if (n < cfg.minEpisodes) {
        return { expectedEfficacy: null, n, baseRate: base, nodes, ready: false, lowerBound: null, bar: null, minN, baseN, baseNodes, harmed, baseHarmed };
      }
      const rate = ok / n;
      // "Beats self-healing" REQUIRES a measured control arm to beat — you cannot
      // out-perform a base rate you have not measured. With no base rate yet the
      // action is `ready` (enough attempts) but NOT distinguishable, so
      // expectedEfficacy stays null and the planner says exactly that.
      //
      // SAMPLING-ERROR GATE (v0.26): claim victory only when the Wilson lower
      // bound — not the fragile point estimate — clears the base rate by the
      // min effect. This is what stops a 4/4 fluke from printing a confident
      // green "✓ helped 100%". The DISPLAYED efficacy stays the point estimate
      // (honest best guess) but is shown only once the lower bound earns it.
      // The bound CROSSES the boundary now (v0.43.1). It decided every claim
      // this engine makes and was thrown away at the return, so a screen could
      // show "helped 75%" with no way to say how pessimistic the evidence
      // allows that to be — and, more often, could not explain why a visibly
      // good-looking arm was still withheld.
      const lower = wilsonLower(ok, n);
      const bar = base == null ? null : base + cfg.minEffect;
      const beats = bar != null && lower >= bar;
      return { expectedEfficacy: beats ? rate : null, n, baseRate: base, nodes, ready: true, lowerBound: lower, bar, minN, baseN, baseNodes, harmed, baseHarmed };
    },

    falsePositives(kind): number {
      return fp.get(kind) ?? 0;
    },

    unverifiable(kind): number {
      return unver.get(kind) ?? 0;
    },

    unverifiableUnprobeable(kind): number {
      return unverUnprobe.get(kind) ?? 0;
    },

    unverifiableTransient(kind): number {
      return unverTransient.get(kind) ?? 0;
    },

    unverifiableUndersampled(kind): number {
      return unverUndersampled.get(kind) ?? 0;
    },

    confounded(kind): number {
      return confoundedTally.get(kind) ?? 0;
    },

    refineBefore(nodeId, kind, window): boolean {
      if (!window) return false;
      const ep = open.get(key(nodeId, kind));
      // Only an OPEN, unresolved episode: once a verdict is computed the
      // evidence behind it is history and must not be rewritten.
      if (!ep || ep.resolvedMs != null || ep.verdict != null) return false;
      // Strictly-better only. `freshN` is the count of samples that actually
      // carried new information, which is what every evidence floor gates on.
      const had = ep.before?.freshN ?? -1;
      if (window.freshN <= had) return false;
      ep.before = window;
      dirty = true;
      return true;
    },

    reset(): void {
      open.clear(); control.clear(); action.clear(); fp.clear(); unver.clear(); unverUnprobe.clear(); unverTransient.clear(); unverUndersampled.clear(); confoundedTally.clear(); armNodes.clear(); controlNodes.clear();
      // WITHOUT THIS the caller's `reset(); save();` is a silent no-op (v0.44.0)
      // — save() returns early on a false `dirty`, so the OLD mesh's ledger
      // stayed on disk after a stick swap and a restart reloaded it onto the
      // new network's node ids. The identity-change log event announced a wipe
      // that had not been persisted.
      dirty = true;
    },

    load(): void {
      const path = opts.path;
      if (!path || !existsSync(path)) return;
      try {
        this.loadJSON(JSON.parse(readFileSync(path, 'utf8')));
        log(`outcomes: restored ${control.size} kind(s) + ${action.size} action arm(s)`);
      } catch (e) {
        log(`outcomes: load failed (${e instanceof Error ? e.message : String(e)}) — starting fresh`);
      }
    },

    save(): void {
      const path = opts.path;
      if (!path) return;
      if (!dirty) return; // nothing learned since the last write (v0.26)
      try {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.toJSON()), 'utf8');
        renameSync(tmp, path);
        dirty = false; // cleared only on a SUCCESSFUL write — a failed save
                       // must retry on the next tick, not silently drop state.
      } catch (e) {
        log(`outcomes: save failed (${e instanceof Error ? e.message : String(e)})`);
      }
    },

    toJSON(): unknown {
      return {
        v: 1,
        control: [...control.entries()],
        action: [...action.entries()],
        fp: [...fp.entries()],
        unver: [...unver.entries()],
        unverUnprobe: [...unverUnprobe.entries()],
        unverTransient: [...unverTransient.entries()],
        unverUndersampled: [...unverUndersampled.entries()],
        confounded: [...confoundedTally.entries()],
        armNodes: [...armNodes.entries()].map(([k, v]) => [k, [...v]] as [string, number[]]),
        controlNodes: [...controlNodes.entries()].map(([k, v]) => [k, [...v]] as [SymptomKind, number[]]),
        // Open episodes are intentionally NOT persisted — an episode spanning a
        // restart lost its before-window's continuity and can't yield an honest
        // verdict; it re-opens fresh when the symptom is re-detected.
      };
    },

    loadJSON(raw): void {
      const o = raw as { v?: number; control?: [SymptomKind, Tally][]; action?: [string, Tally][]; fp?: [SymptomKind, number][]; unver?: [SymptomKind, number][]; unverUnprobe?: [SymptomKind, number][]; unverTransient?: [SymptomKind, number][]; unverUndersampled?: [SymptomKind, number][]; confounded?: [SymptomKind, number][]; armNodes?: [string, number[]][]; controlNodes?: [SymptomKind, number[]][] };
      if (!o || o.v !== 1) return;
      control.clear(); action.clear(); fp.clear(); unver.clear(); unverUnprobe.clear(); unverTransient.clear(); unverUndersampled.clear(); confoundedTally.clear(); armNodes.clear(); controlNodes.clear();
      for (const [k, t] of o.control ?? []) if (validTally(t)) control.set(k, normalizeTally(t));
      for (const [k, t] of o.action ?? []) if (validTally(t)) action.set(k, normalizeTally(t));
      for (const [k, v] of o.fp ?? []) if (Number.isFinite(v) && v >= 0) fp.set(k, v);
      // Absent in pre-v0.36 files — an older ledger simply starts this counter at 0.
      for (const [k, v] of o.unver ?? []) if (Number.isFinite(v) && v >= 0) unver.set(k, v);
      for (const [k, v] of o.unverUnprobe ?? []) if (Number.isFinite(v) && v >= 0) unverUnprobe.set(k, v);
      for (const [k, v] of o.unverTransient ?? []) if (Number.isFinite(v) && v >= 0) unverTransient.set(k, v);
      for (const [k, v] of o.unverUndersampled ?? []) if (Number.isFinite(v) && v >= 0) unverUndersampled.set(k, v);
      for (const [k, v] of o.confounded ?? []) if (Number.isFinite(v) && v >= 0) confoundedTally.set(k, v);
      // Absent in pre-v0.36.5 files: an older ledger simply reports 0 nodes,
      // which the renderer treats as "provenance unknown" rather than as one.
      for (const [k, v] of o.armNodes ?? []) if (Array.isArray(v)) armNodes.set(k, new Set(v.filter((x) => Number.isFinite(x))));
      for (const [k, v] of o.controlNodes ?? []) if (Array.isArray(v)) controlNodes.set(k, new Set(v.filter((x) => Number.isFinite(x))));
    },
  };
}

/** PURE episode-lifecycle decision (extracted from zwaveData so the
 *  confirmation-window logic is unit-testable). Given the current symptoms, the
 *  ledger's open episodes, and a mutable `pending` map (key → first-absent ms),
 *  returns which episodes to OPEN and which to RESOLVE. Rules:
 *   • a non-subsumed symptom with no open episode → OPEN (a subsumed symptom's
 *     fate belongs to its mesh event, so it opens no episode of its own);
 *   • an open episode whose symptom is present again → its pending timer is
 *     cleared (a blink of absence does not resolve it);
 *   • an open episode absent through the whole `confirmMs` window → RESOLVE. */
export function planEpisodeLifecycle(
  symptoms: { nodeId: number | null; kind: SymptomKind; subsumedBy?: string | null }[],
  openEpisodes: { key: string; nodeId: number | null; kind: SymptomKind }[],
  pending: Map<string, number>,
  now: number,
  confirmMs: number,
): { toOpen: { nodeId: number | null; kind: SymptomKind }[]; toResolve: { nodeId: number | null; kind: SymptomKind; key: string }[] } {
  const epKey = (nodeId: number | null, kind: SymptomKind): string => `${nodeId ?? 'mesh'}:${kind}`;
  // A symptom is "live" (must NOT resolve) whenever it is present — INCLUDING
  // when it is merely subsumed under a mesh event. Subsumption demotes the
  // recommendation, it does not mean the symptom recovered. Only genuine absence
  // resolves an episode.
  const live = new Set<string>();
  for (const s of symptoms) {
    const k = epKey(s.nodeId, s.kind);
    live.add(k);
    pending.delete(k); // present again → cancel any pending resolution
  }
  const openSet = new Set(openEpisodes.map((e) => e.key));
  const toOpen: { nodeId: number | null; kind: SymptomKind }[] = [];
  for (const s of symptoms) {
    if (s.subsumedBy != null) continue;
    if (!openSet.has(epKey(s.nodeId, s.kind))) toOpen.push({ nodeId: s.nodeId, kind: s.kind });
  }
  const toResolve: { nodeId: number | null; kind: SymptomKind; key: string }[] = [];
  for (const ep of openEpisodes) {
    if (live.has(ep.key)) continue;
    const since = pending.get(ep.key) ?? now;
    pending.set(ep.key, since);
    if (now - since >= confirmMs) {
      toResolve.push({ nodeId: ep.nodeId, kind: ep.kind, key: ep.key });
      pending.delete(ep.key);
    }
  }
  return { toOpen, toResolve };
}

function validTally(t: Tally): boolean {
  // `bad` is absent in pre-v0.44.0 files, and absent is not invalid — an older
  // ledger simply has no record of regressions. `normalizeTally` supplies 0.
  const bad = (t as Partial<Tally> | undefined)?.bad;
  const badOk = bad === undefined || (Number.isFinite(bad) && bad >= 0 && bad <= t.n + 1e-9);
  // `ok + bad <= n` is the joint invariant bump() guarantees (a closure scores
  // improved OR worse, never both); without it a corrupt file can seat two
  // contradicting rates in the same tally.
  const jointOk = t.ok + (bad ?? 0) <= t.n + 1e-9;
  return !!t && Number.isFinite(t.n) && Number.isFinite(t.ok) && t.n >= 0 && t.ok >= 0 && t.ok <= t.n + 1e-9 && badOk && jointOk;
}

/** Fill in `bad` for tallies restored from a pre-v0.44.0 ledger. */
function normalizeTally(t: Tally): Tally {
  return { n: t.n, ok: t.ok, bad: Number.isFinite(t.bad) ? t.bad : 0 };
}

/** Drop undefined option keys so `{...DEFAULTS, ...opts}` never overwrites a
 *  default with undefined. */
function clean(o: OutcomeStoreOptions): Partial<OutcomeStoreOptions> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'log') out[k] = v;
  return out;
}
