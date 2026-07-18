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
  openKeys(): string[];
  /** Currently-open episodes as (key, nodeId, kind) — for the caller's
   *  confirmation-window resolution loop (no key-parsing needed). */
  openEpisodes(): { key: string; nodeId: number | null; kind: SymptomKind }[];
  /** Spontaneous-recovery base rate for a kind (control arm), or null if n too low. */
  baseRate(kind: SymptomKind): number | null;
  /** Learned efficacy of an action against a kind, for the planner. */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy;
  /** How many episodes of this kind ended `refused-misdiagnosis` (false positives). */
  falsePositives(kind: SymptomKind): number;
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
export function windowMetrics(samples: EvidenceSample[], minTx = 5): WindowMetrics {
  let tx = 0, rx = 0, timeouts = 0, flaps = 0, n = 0, freshN = 0;
  const rssis: number[] = [], rtts: number[] = [];
  let rateKbpsMin: number | null = null;
  for (const s of samples) {
    n++;
    if (s.dTx != null) tx += s.dTx;
    if (s.dRx != null) rx += s.dRx;
    if (s.dTimeout != null) timeouts += s.dTimeout;
    if (s.dFlaps != null) flaps += s.dFlaps; // typed non-null, but guard legacy/persisted samples from NaN
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
    flaps,
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
type RecoveryMetric = 'timeout' | 'flap' | 'rssi' | 'rtt' | 'rate' | 'none';

function metricOf(kind: SymptomKind): RecoveryMetric {
  switch (kind) {
    case 'return-path-degraded':
    case 'chronic-return-path':
    case 'quiet-node':
      return 'timeout'; // reply-timeout rate
    case 'dead-flap':
      return 'flap'; // Alive↔Dead transitions stopping
    case 'weak-signal':
      return 'rssi'; // signal strength improving
    case 'rtt-degraded':
      return 'rtt'; // round-trip time dropping
    case 'rate-fallback':
      return 'rate'; // negotiated rate back to 100k
    default:
      // chatty-device, route-churn, ghost-suspect, controller-degraded,
      // mesh-interference: not scorable by a per-node recovery window.
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

export function createOutcomeStore(opts: OutcomeStoreOptions = {}): OutcomeStore {
  const cfg = { ...DEFAULTS, ...clean(opts) };
  const log = opts.log ?? (() => {});
  const open = new Map<string, Episode>();

  // Per-kind control arm (no-action episodes) and per-detector false positives.
  const control = new Map<SymptomKind, Tally>();
  const fp = new Map<SymptomKind, number>();
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
      } else if (ep.verdict === 'unverifiable') {
        // Contributes to NEITHER arm — an honest "we couldn't tell".
      } else if (ep.action == null) {
        // Control arm: a symptom that resolved with no action taken.
        control.set(kind, bump(control.get(kind), ep.verdict === 'improved'));
      } else {
        // Action arm — keyed by (kind, action) to match the un-banded control
        // arm. Time-of-day banding is deliberately NOT applied: it would need
        // n≥MIN per band across 6 bands to learn, and comparing a band-summed
        // action rate against an un-banded base rate is a Simpson's-paradox
        // confound. Both arms stay marginal (a documented diurnal-confound
        // limitation — see baseRate/efficacyFor).
        const ak = aKey(kind, ep.action.kind);
        action.set(ak, bump(action.get(ak), ep.verdict === 'improved'));
      }
      log(`episode ${k} ${ep.verdict}${ep.action ? ' after ' + ep.action.kind : ' (no action)'}`);
      return ep;
    },

    abandon(nodeId, kind): void {
      open.delete(key(nodeId, kind));
    },

    openKeys(): string[] {
      return [...open.keys()];
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
      if (n < cfg.minEpisodes) return { expectedEfficacy: null, n, baseRate: base, beatsSelfHealing: false, ready: false };
      const rate = ok / n;
      // "Beats self-healing" REQUIRES a measured control arm to beat — you cannot
      // out-perform a base rate you have not measured. With no base rate yet the
      // action is `ready` (enough attempts) but NOT distinguishable, so
      // expectedEfficacy stays null and the planner says exactly that.
      const beats = base != null && rate >= base + cfg.minEffect;
      return { expectedEfficacy: beats ? rate : null, n, baseRate: base, beatsSelfHealing: beats, ready: true };
    },

    falsePositives(kind): number {
      return fp.get(kind) ?? 0;
    },

    reset(): void {
      open.clear(); control.clear(); action.clear(); fp.clear();
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
      try {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.toJSON()), 'utf8');
        renameSync(tmp, path);
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
        // Open episodes are intentionally NOT persisted — an episode spanning a
        // restart lost its before-window's continuity and can't yield an honest
        // verdict; it re-opens fresh when the symptom is re-detected.
      };
    },

    loadJSON(raw): void {
      const o = raw as { v?: number; control?: [SymptomKind, Tally][]; action?: [string, Tally][]; fp?: [SymptomKind, number][] };
      if (!o || o.v !== 1) return;
      control.clear(); action.clear(); fp.clear();
      for (const [k, t] of o.control ?? []) if (validTally(t)) control.set(k, t);
      for (const [k, t] of o.action ?? []) if (validTally(t)) action.set(k, t);
      for (const [k, v] of o.fp ?? []) if (Number.isFinite(v) && v >= 0) fp.set(k, v);
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
