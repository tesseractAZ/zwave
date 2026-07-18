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
import { bandOf, N_BANDS } from './baselines';

export type { Efficacy };

export type Verdict = 'improved' | 'no-change' | 'worse' | 'refused-misdiagnosis' | 'unverifiable';

/** Aggregated per-command metrics over a window of evidence samples. */
export interface WindowMetrics {
  tx: number; // Σ dTx  (successful commands the node was sent)
  rx: number; // Σ dRx
  timeouts: number; // Σ dTimeout (Get replies that never came — the reliability signal)
  /** timeouts / tx, or null when tx is too small to be a rate. */
  rate: number | null;
  samples: number;
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
   *  per episode wins the attribution. */
  recordAction(nodeId: number | null, actionKind: ActionKind, refused: boolean, atMs: number): void;
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
  efficacyFor(kind: SymptomKind, action: ActionKind, band?: number): Efficacy;
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

/** Aggregate a window of samples into per-command metrics. `minTx` below which
 *  a rate is not meaningful → rate stays null (never a fabricated 0/0). */
export function windowMetrics(samples: EvidenceSample[], minTx = 5): WindowMetrics {
  let tx = 0, rx = 0, timeouts = 0, n = 0;
  for (const s of samples) {
    if (s.dTx != null) tx += s.dTx;
    if (s.dRx != null) rx += s.dRx;
    if (s.dTimeout != null) timeouts += s.dTimeout;
    n++;
  }
  return { tx, rx, timeouts, rate: tx >= minTx ? timeouts / tx : null, samples: n };
}

const DEFAULTS = { releaseRate: 0.075, minEffect: 0.05, minEpisodes: 4, decay: 0.03 } as const;

// Traffic-mix comparability: the two windows must both carry real traffic and be
// within this factor of each other, else improvement is not attributable.
const MIN_WINDOW_TX = 5;
const TRAFFIC_FACTOR = 3;
// A rate that grew past this factor of the before-rate is a regression, not noise.
const WORSE_FACTOR = 1.5;

function comparable(a: WindowMetrics, b: WindowMetrics): boolean {
  if (a.tx < MIN_WINDOW_TX || b.tx < MIN_WINDOW_TX) return false;
  const hi = Math.max(a.tx, b.tx), lo = Math.min(a.tx, b.tx);
  return hi <= lo * TRAFFIC_FACTOR;
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
  const aKey = (kind: SymptomKind, act: ActionKind, band: number): string => `${kind}|${act}|${band}`;

  const bump = (t: Tally | undefined, improved: boolean): Tally => {
    const cur = t ?? { n: 0, ok: 0 };
    const keep = 1 - cfg.decay;
    return { n: cur.n * keep + 1, ok: cur.ok * keep + (improved ? 1 : 0) };
  };

  const computeVerdict = (ep: Episode): Verdict => {
    if (ep.action?.refused) return 'refused-misdiagnosis';
    if (!ep.before || !ep.after || ep.before.rate == null || ep.after.rate == null) return 'unverifiable';
    if (!comparable(ep.before, ep.after)) return 'unverifiable';
    if (ep.after.rate > ep.before.rate * WORSE_FACTOR && ep.after.rate > cfg.releaseRate) return 'worse';
    const improved = ep.after.rate <= cfg.releaseRate && ep.before.rate - ep.after.rate >= cfg.minEffect;
    return improved ? 'improved' : 'no-change';
  };

  return {
    open(nodeId, kind, onsetMs, before): void {
      const k = key(nodeId, kind);
      if (open.has(k)) return; // one open episode per key (matches the detector lifecycle)
      open.set(k, { kind, nodeId, band: bandOf(onsetMs), onsetMs, before, action: null, resolvedMs: null, after: null, verdict: null });
    },

    recordAction(nodeId, actionKind, refused, atMs): void {
      // Attribute to EVERY open episode on this node (an action targets a node;
      // any of its active symptoms could be the one it addresses). First action
      // per episode wins — a later action can't cleanly be credited.
      const prefix = `${nodeId ?? 'mesh'}:`;
      for (const [k, ep] of open) {
        if (!k.startsWith(prefix)) continue;
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
        // Action arm, keyed to the coarse context band.
        const ak = aKey(kind, ep.action.kind, ep.band);
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

    efficacyFor(kind, act, band): Efficacy {
      const base = this.baseRate(kind);
      // Sum the action arm across bands, or a specific band when given.
      let n = 0, ok = 0;
      for (let b = 0; b < N_BANDS; b++) {
        if (band != null && b !== band) continue;
        const t = action.get(aKey(kind, act, b));
        if (t) { n += t.n; ok += t.ok; }
      }
      if (n < cfg.minEpisodes) return { expectedEfficacy: null, n, baseRate: base, beatsSelfHealing: false, ready: false };
      const rate = ok / n;
      // Beats self-healing = clears the base rate (or a floor when base unknown)
      // by the minimum effect size. Until then expectedEfficacy stays null so
      // the planner renders "not distinguishable from self-healing".
      const bar = (base ?? 0) + cfg.minEffect;
      const beats = rate >= bar;
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
