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
import { bandOf } from './baselines';

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

/** One symptom episode: opens on symptom onset, closes on resolution. */
export interface Episode {
  kind: SymptomKind;
  nodeId: number | null;
  band: number; // time-of-day context band (shared with baselines)
  onsetMs: number;
  before: WindowMetrics | null; // degraded window at/around onset
  action: { kind: ActionKind; atMs: number; refused: boolean } | null;
  resolvedMs: number | null;
  after: WindowMetrics | null; // settled window after resolution
  verdict: Verdict | null;
}

/** A decayed tally of episodes and their successes. */
interface Tally {
  n: number; // decayed episode count
  ok: number; // decayed count that resolved `improved`
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
  recordAction(nodeId: number | null, actionKind: ActionKind, refused: boolean, atMs: number, skip?: (key: string) => boolean): void;
  /** Close an episode: the symptom resolved. Computes + folds the verdict. */
  resolve(nodeId: number | null, kind: SymptomKind, resolvedMs: number, after: WindowMetrics | null): Episode | null;
  /** Drop an open episode without a verdict (e.g. node left the roster). */
  abandon(nodeId: number | null, kind: SymptomKind): void;
  /** Keys of currently-open episodes (`${nodeId}:${kind}`). */
  /** Currently-open episodes as (key, nodeId, kind) — for the caller's
   *  confirmation-window resolution loop (no key-parsing needed). */
  openEpisodes(): { key: string; nodeId: number | null; kind: SymptomKind }[];
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
type RecoveryMetric = 'timeout' | 'flap' | 'rssi' | 'rtt' | 'rate' | 's2' | 'route' | 'none';

function metricOf(kind: SymptomKind): RecoveryMetric {
  switch (kind) {
    case 'return-path-degraded':
    case 'chronic-return-path':
    case 'quiet-node':
      return 'timeout'; // reply-timeout rate
    case 'dead-flap':
      return 'flap'; // Alive↔Dead transitions stopping
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
const MIN_OBS = 3; // minimum non-null rssi/rtt readings behind a trustworthy median
const MIN_LIVE = 3; // minimum FRESH samples proving the node is alive & communicating (flap after-window)
const RSSI_MIN_GAIN = 4; // dB — a meaningful signal-strength improvement
const RTT_DROP_FRAC = 0.25; // ≥25% faster …
const RTT_MIN_DROP_MS = 20; // … AND at least this many ms (guards tiny-baseline noise)

/** Score an episode's recovery by its kind's metric. Each branch keeps the same
 *  honesty contract as the timeout metric: an incomparable / evidence-poor pair
 *  is `unverifiable` (never a fabricated win), and a regression is `worse`. Every
 *  branch gates on evidence of ITS OWN signal (rssiN/rttN readings, fresh-only
 *  rateKbps, live after-window for flaps) — never the shared freshN. */
function scoreRecovery(m: RecoveryMetric, before: WindowMetrics, after: WindowMetrics, releaseRate: number, minEffect: number): Verdict {
  switch (m) {
    case 'timeout': {
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
      // mistaken for a recovery.
      if (before.flaps < 1 || after.freshN < MIN_LIVE) return 'unverifiable';
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
      // the action never earned (v0.26 review).
      if (before.s2 < 1 || before.s2Known < 1) return 'unverifiable';
      if (after.s2Known < MIN_LIVE) return 'unverifiable'; // lane dark ⇒ unknown, never "improved"
      if (after.freshN < MIN_LIVE) return 'unverifiable';
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
      if (before.routeChanges < 1 || before.routeKnown < 1) return 'unverifiable';
      if (after.routeKnown < MIN_LIVE) return 'unverifiable'; // route invisible ⇒ unknown, never "improved"
      if (after.freshN < MIN_LIVE) return 'unverifiable';
      if (after.routeChanges > before.routeChanges) return 'worse';
      return after.routeChanges === 0 ? 'improved' : 'no-change';
    }
    case 'rssi': {
      if (before.rssiMedian == null || after.rssiMedian == null || before.rssiN < MIN_OBS || after.rssiN < MIN_OBS) return 'unverifiable';
      const gain = after.rssiMedian - before.rssiMedian; // higher (less negative) = stronger
      if (gain <= -RSSI_MIN_GAIN) return 'worse';
      return gain >= RSSI_MIN_GAIN ? 'improved' : 'no-change';
    }
    case 'rtt': {
      if (before.rttMedian == null || after.rttMedian == null || before.rttN < MIN_OBS || after.rttN < MIN_OBS) return 'unverifiable';
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
  // Per (kind ▸ action ▸ band) action arm.
  const action = new Map<string, Tally>();

  const key = (nodeId: number | null, kind: SymptomKind): string => `${nodeId ?? 'mesh'}:${kind}`;
  const aKey = (kind: SymptomKind, act: ActionKind): string => `${kind}|${act}`;

  const bump = (t: Tally | undefined, improved: boolean): Tally => {
    const cur = t ?? { n: 0, ok: 0 };
    const keep = 1 - cfg.decay;
    return { n: cur.n * keep + 1, ok: cur.ok * keep + (improved ? 1 : 0) };
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
      open.set(k, { kind, nodeId, band: bandOf(onsetMs), onsetMs, before, action: null, resolvedMs: null, after: null, verdict: null });
    },

    recordAction(nodeId, actionKind, refused, atMs, skip): void {
      // Attribute to EVERY open episode on this node (an action targets a node;
      // any of its active symptoms could be the one it addresses). First action
      // per episode wins — a later action can't cleanly be credited. Skip
      // episodes whose symptom already went absent (confirmation window): an
      // action there would steal credit for a spontaneous recovery.
      const prefix = `${nodeId ?? 'mesh'}:`;
      for (const [k, ep] of open) {
        if (!k.startsWith(prefix)) continue;
        if (skip?.(k)) continue;
        if (ep.action == null) ep.action = { kind: actionKind, atMs, refused };
      }
    },

    resolve(nodeId, kind, resolvedMs, after): Episode | null {
      const k = key(nodeId, kind);
      const ep = open.get(k);
      if (!ep) return null;
      open.delete(k);
      ep.resolvedMs = resolvedMs;
      ep.after = after;
      ep.verdict = computeVerdict(ep);

      if (ep.verdict === 'refused-misdiagnosis') {
        fp.set(kind, (fp.get(kind) ?? 0) + 1);
        dirty = true;
      } else if (ep.verdict === 'unverifiable') {
        // Contributes to NEITHER arm — an honest "we couldn't tell". COUNTED
        // though (v0.36): an unscoreable episode is not nothing, it is the
        // ledger telling you its evidence was too thin, and that fact has to
        // reach a screen or a structurally-inert loop looks like a patient one.
        unver.set(kind, (unver.get(kind) ?? 0) + 1);
        dirty = true;
      } else if (ep.action == null) {
        // Control arm: a symptom that resolved with no action taken.
        control.set(kind, bump(control.get(kind), ep.verdict === 'improved'));
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
        action.set(ak, bump(action.get(ak), ep.verdict === 'improved'));
        noteNode(armNodes, ak, ep.nodeId);
        dirty = true;
      }
      log(`episode ${k} ${ep.verdict}${ep.action ? ' after ' + ep.action.kind : ' (no action)'}`);
      return ep;
    },

    abandon(nodeId, kind): void {
      open.delete(key(nodeId, kind));
    },

    openEpisodes(): { key: string; nodeId: number | null; kind: SymptomKind }[] {
      return [...open.entries()].map(([k, ep]) => ({ key: k, nodeId: ep.nodeId, kind: ep.kind }));
    },

    baseRate(kind): number | null {
      const t = control.get(kind);
      if (!t || t.n < cfg.minEpisodes) return null;
      return t.ok / t.n;
    },

    efficacyFor(kind, act): Efficacy {
      const base = this.baseRate(kind);
      const t = action.get(aKey(kind, act));
      const n = t?.n ?? 0, ok = t?.ok ?? 0;
      const nodes = armNodes.get(aKey(kind, act))?.size ?? 0;
      if (n < cfg.minEpisodes) return { expectedEfficacy: null, n, baseRate: base, nodes, ready: false };
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
      const beats = base != null && wilsonLower(ok, n) >= base + cfg.minEffect;
      return { expectedEfficacy: beats ? rate : null, n, baseRate: base, nodes, ready: true };
    },

    falsePositives(kind): number {
      return fp.get(kind) ?? 0;
    },

    unverifiable(kind): number {
      return unver.get(kind) ?? 0;
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
      open.clear(); control.clear(); action.clear(); fp.clear(); unver.clear(); armNodes.clear(); controlNodes.clear();
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
        armNodes: [...armNodes.entries()].map(([k, v]) => [k, [...v]] as [string, number[]]),
        controlNodes: [...controlNodes.entries()].map(([k, v]) => [k, [...v]] as [SymptomKind, number[]]),
        // Open episodes are intentionally NOT persisted — an episode spanning a
        // restart lost its before-window's continuity and can't yield an honest
        // verdict; it re-opens fresh when the symptom is re-detected.
      };
    },

    loadJSON(raw): void {
      const o = raw as { v?: number; control?: [SymptomKind, Tally][]; action?: [string, Tally][]; fp?: [SymptomKind, number][]; unver?: [SymptomKind, number][]; armNodes?: [string, number[]][]; controlNodes?: [SymptomKind, number[]][] };
      if (!o || o.v !== 1) return;
      control.clear(); action.clear(); fp.clear(); unver.clear(); armNodes.clear(); controlNodes.clear();
      for (const [k, t] of o.control ?? []) if (validTally(t)) control.set(k, t);
      for (const [k, t] of o.action ?? []) if (validTally(t)) action.set(k, t);
      for (const [k, v] of o.fp ?? []) if (Number.isFinite(v) && v >= 0) fp.set(k, v);
      // Absent in pre-v0.36 files — an older ledger simply starts this counter at 0.
      for (const [k, v] of o.unver ?? []) if (Number.isFinite(v) && v >= 0) unver.set(k, v);
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
  return !!t && Number.isFinite(t.n) && Number.isFinite(t.ok) && t.n >= 0 && t.ok >= 0 && t.ok <= t.n + 1e-9;
}

/** Drop undefined option keys so `{...DEFAULTS, ...opts}` never overwrites a
 *  default with undefined. */
function clean(o: OutcomeStoreOptions): Partial<OutcomeStoreOptions> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'log') out[k] = v;
  return out;
}
