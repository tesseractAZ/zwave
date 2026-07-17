/**
 * Persistent per-node EVIDENCE store (M2, rev 2 — post design-review) — the
 * trustworthy time-series substrate the symptom engine (M3), planner (M4) and
 * outcome learner (M5) read from. DESIGN.md §3.1 is the contract; this file
 * implements it.
 *
 * Two tiers, both first-class:
 *   - FINE ring: one sample / node / tick (default 10 s), ~40 min horizon —
 *     recent-window detectors + the outcome after-window verifier.
 *   - COARSE tier: 30-min buckets × 14 days / node — the baseline substrate.
 *     Staleness is PER-TIER: the 1 h maxAge kills only the fine ring; coarse
 *     buckets are pruned individually to the horizon. Under boot-grace (host
 *     just booted, no-RTC clock may be pre-NTP) the coarse tier + coverage
 *     metadata still load — only the recency-dependent fine ring is dropped,
 *     so a daily power blip cannot wipe two weeks of baseline history.
 *
 * Counter discipline (RESEARCH.md §0/§1.11 + design review):
 *   - The zwave-js counters are CUMULATIVE SINCE DRIVER START; per-window
 *     rates are deltas between snapshots.
 *   - WHOLE-WINDOW invalidation: if ANY counter moved backwards, ALL deltas
 *     for that sample are null — one driver, one restart, one shared lifetime
 *     (per-field nulling let cross-lifetime deltas masquerade as valid).
 *   - MAX-WINDOW bound: a gap > ~3× the cadence since the previous sample
 *     nulls all deltas — long gaps are not time-attributable.
 *   - PLAUSIBILITY bound: a delta exceeding what Z-Wave's shared ~10–20 msg/s
 *     bandwidth could carry in the window is nulled — the backstop against
 *     fabricated deltas (e.g. a malformed event coerced to 0 turning the next
 *     sample into a full-lifetime delta).
 *   - `null` means "cannot know this window" — absence of evidence, never
 *     evidence of health.
 *
 * Event-derived series (the design review's core catch): Alive↔Dead flaps and
 * route changes are EVENT-ACCUMULATED by the caller (subscribe_node_status +
 * the route-change diff) and drained into each sample as concrete counts —
 * level-sampling the status column misses sub-window flaps by construction.
 * `fresh` marks whether a stats event actually arrived in the window; rssi/rtt
 * are re-sampled driver EMAs and carry information ONLY when fresh
 * (pseudo-replication otherwise collapses MAD to 0 downstream).
 *
 * Integrity: the envelope is bound to the controller homeId (a stick swap
 * while the add-on is stopped must not resurrect another network's evidence
 * under new node ids); reset() clears memory AND immediately rewrites disk.
 * Coverage metadata (recordingSince, per-node firstSeenAt + cumulative counts)
 * survives ring eviction so "no evidence rows" is distinguishable from "node
 * never communicated" — the ghost detector depends on that distinction.
 *
 * Reserved fields (null until the v0.13 read-only driver-WS client lands):
 * per-sample lastSeen, controller per-channel bgRssi. Reserving them now means
 * v0.13 lands without a schema migration or baseline re-learn.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { uptime as osUptime } from 'node:os';
import { NodeStatus, type NodeStats, type ControllerSnapshot } from '../types';

/** The controller serial-link counters (nullable on the snapshot; non-null here). */
type CtrlStats = NonNullable<ControllerSnapshot['statistics']>;

/** RSSI values the driver uses as sentinels, not real dBm (RESEARCH.md §1.11). */
const RSSI_SENTINEL_MIN = 125; // 125 no-signal · 126 saturated · 127 not-available

/** protocolDataRate enum → link rate in kbps (4 = Long-Range 100k). */
const RATE_KBPS: Record<number, number> = { 1: 9.6, 2: 40, 3: 100, 4: 100 };

/**
 * One captured fine-tier sample. Counter deltas are `null` for an invalid
 * window (first sample / reset / over-long gap / implausible) — "unknown",
 * never zero. `dFlaps`/`dRouteChanges` are event-accumulator drains and are
 * always concrete. `rtt`/`rssi`/route fields are meaningful ONLY when `fresh`.
 */
export interface EvidenceSample {
  t: number;
  dTx: number | null;
  dTimeout: number | null;
  dDropTx: number | null;
  dRx: number | null;
  /** Alive↔Dead transitions since the previous sample (event-driven). */
  dFlaps: number;
  /** LWR route changes since the previous sample (event-driven). */
  dRouteChanges: number;
  /** Did a stats event arrive since the previous sample? */
  fresh: boolean;
  rtt: number | null;
  rssi: number | null;
  rateKbps: number | null;
  routeKey: string | null;
  status: NodeStatus;
  /** Reserved for the driver-WS client (v0.13); null until then. */
  lastSeen: number | null;
  /** Reserved for the driver-WS client (v0.13); null until then. */
  isListening: boolean | null;
}

/** One controller-level sample (serial-link health), same delta discipline. */
export interface ControllerSample {
  t: number;
  dMsgTx: number | null;
  dMsgDroppedTx: number | null;
  dNak: number | null;
  dCan: number | null;
  dTimeoutAck: number | null;
  dTimeoutResponse: number | null;
  fresh: boolean;
  /** Reserved per-channel background RSSI (v0.13); null until then. */
  bg0: number | null;
  bg1: number | null;
  bg2: number | null;
  bg3: number | null;
}

/** One 30-minute coarse bucket — the baseline substrate (DESIGN §3.2). */
export interface CoarseBucket {
  /** Bucket start (aligned to COARSE_BUCKET_MS). */
  t0: number;
  /** Samples folded in / how many were fresh / how many had invalid windows. */
  n: number;
  freshN: number;
  invalidW: number;
  /** Sums of VALID deltas only. */
  dTx: number;
  dTimeout: number;
  dDropTx: number;
  dRx: number;
  flaps: number;
  routeChanges: number;
  /** Aggregates over FRESH rssi/rtt observations only. */
  rssiN: number;
  rssiSum: number;
  rssiMin: number | null;
  rssiMax: number | null;
  rttN: number;
  rttSum: number;
  /** Worst (lowest) negotiated rate seen in the bucket. */
  rateMin: number | null;
}

/** An event-captured route failure (transient — latched on appearance). */
export interface RouteFailureEvent {
  t: number;
  /** [last-functional, first-non-functional] node ids. */
  between: [number, number];
}

/** Per-node coverage metadata — survives ring eviction and restarts. */
export interface NodeCoverage {
  /** First time this node appeared on the roster (registerNode). */
  firstSeenAt: number;
  /** Cumulative counts since firstSeenAt (not ring-bounded). */
  samples: number;
  freshSamples: number;
}

export type EvidenceMap = Map<number, EvidenceSample[]>;

/** Extra per-sample inputs the caller accumulates event-driven. */
export interface SampleExtras {
  flaps?: number;
  routeChanges?: number;
  fresh?: boolean;
}

export interface EvidenceStoreOptions {
  path: string;
  /** Fine-ring cap per node. */
  maxSamples?: number;
  /** Expected sampling cadence (ms) — drives the max-window bound. */
  cadenceMs?: number;
  /** Fine-tier only: discard persisted fine rings older than this. 0 = never. */
  maxAgeMs?: number;
  /** Coarse-tier horizon (ms) — buckets older than this are pruned. */
  coarseHorizonMs?: number;
  /** Distrust recency (fine tier) when host uptime is below this. 0 = off. */
  bootGraceMs?: number;
  /** Plausibility cap for counter deltas (messages/second). */
  maxDeltaPerSec?: number;
  now?: () => number;
  uptimeMs?: () => number;
  log?: (msg: string) => void;
}

export interface EvidenceStore {
  readonly path: string;
  /** Register a roster node for coverage tracking (idempotent). */
  registerNode(nodeId: number, at?: number): void;
  /**
   * Remove ALL evidence for a node that left the network (excluded/replaced).
   * Node-id reuse after replace_failed_node must start from a clean slate —
   * inherited history would merge two physical devices' evidence and
   * pre-satisfy the ghost detector's coverage precondition (review).
   */
  evictNode(nodeId: number): void;
  /** Capture one fine sample + fold it into the coarse tier. Never throws. */
  record(nodeId: number, stats: NodeStats, status: NodeStatus, extras?: SampleExtras, at?: number): EvidenceSample;
  /** Capture one controller sample through the same delta guards. */
  recordController(stats: CtrlStats, fresh: boolean, at?: number): ControllerSample;
  /** Latch a route failure the moment it appears (event-driven, deduped by caller). */
  recordRouteFailure(nodeId: number, between: [number, number], at?: number): void;
  forNode(nodeId: number): EvidenceSample[];
  coarseForNode(nodeId: number): CoarseBucket[];
  controllerSamples(): ControllerSample[];
  routeFailures(nodeId: number): RouteFailureEvent[];
  coverage(nodeId: number): NodeCoverage | null;
  /** Store-level: when evidence collection first began (survives restarts). */
  recordingSince(): number | null;
  all(): EvidenceMap;
  /**
   * Bind the live controller home id. On mismatch with persisted/loaded
   * evidence the store resets (memory + disk) — different network, different
   * node-id meanings.
   */
  bindHomeId(homeId: number): void;
  /** Load persisted state. Boot-grace drops only the fine tier. */
  load(): EvidenceMap;
  /** Persist (dirty-flagged; no-op when nothing changed). Never throws. */
  save(): void;
  /** Drop everything (memory) and immediately rewrite disk. */
  reset(): void;
}

/* ── On-disk columnar shapes ────────────────────────────────────────────── */

interface FineCols {
  t: number[];
  dTx: (number | null)[];
  dTo: (number | null)[];
  dDr: (number | null)[];
  dRx: (number | null)[];
  dF: number[];
  dRC: number[];
  fr: (0 | 1)[];
  rtt: (number | null)[];
  rssi: (number | null)[];
  rate: (number | null)[];
  rk: (string | null)[];
  st: number[];
  ls: (number | null)[];
  il: (0 | 1 | null)[];
}

interface CoarseCols {
  t0: number[];
  n: number[];
  fN: number[];
  iW: number[];
  dTx: number[];
  dTo: number[];
  dDr: number[];
  dRx: number[];
  fl: number[];
  rc: number[];
  rN: number[];
  rS: number[];
  rMin: (number | null)[];
  rMax: (number | null)[];
  ttN: number[];
  ttS: number[];
  rate: (number | null)[];
}

interface CtrlCols {
  t: number[];
  dTx: (number | null)[];
  dDr: (number | null)[];
  nak: (number | null)[];
  can: (number | null)[];
  tAck: (number | null)[];
  tRes: (number | null)[];
  fr: (0 | 1)[];
  bg0: (number | null)[];
  bg1: (number | null)[];
  bg2: (number | null)[];
  bg3: (number | null)[];
}

interface Persisted {
  v: number;
  savedAt: number;
  homeId: number | null;
  recordingSince: number | null;
  nodes: Record<string, FineCols>;
  coarse: Record<string, CoarseCols>;
  controller: CtrlCols | null;
  routeFails: Record<string, { t: number[]; a: number[]; b: number[] }>;
  meta: Record<string, { firstSeenAt: number; samples: number; fresh: number }>;
}

const SCHEMA_V = 2;
const DEFAULT_MAX_SAMPLES = 240; // ~40 min at the 10 s cadence
const DEFAULT_CADENCE_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // fine tier only
export const COARSE_BUCKET_MS = 30 * 60 * 1000;
const DEFAULT_COARSE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_BOOT_GRACE_MS = 180 * 1000;
/** Z-Wave's shared bandwidth is ~10–20 msg/s mesh-wide; 40/s per node is safely impossible. */
const DEFAULT_MAX_DELTA_PER_SEC = 40;
/** Max-window bound = this many cadences without a sample ⇒ deltas not attributable. */
const MAX_WINDOW_CADENCES = 3;
const ROUTE_FAIL_RING = 20;
const CTRL_MAX_SAMPLES = 240;

interface CounterSnapshot {
  t: number;
  tx: number;
  timeout: number;
  dropTx: number;
  rx: number;
}

interface CtrlSnapshot {
  t: number;
  msgTx: number;
  msgDroppedTx: number;
  nak: number;
  can: number;
  timeoutAck: number;
  timeoutResponse: number;
}

function cleanRssi(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= RSSI_SENTINEL_MIN) return null;
  return v;
}

function routeKeyOf(stats: NodeStats): string | null {
  const lwr = stats.lwr;
  if (!lwr) return null;
  const reps = Array.isArray(lwr.repeaters) ? lwr.repeaters : [];
  return reps.length === 0 ? 'direct' : 'r' + reps.join('-');
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function createEvidenceStore(opts: EvidenceStoreOptions): EvidenceStore {
  const path = opts.path;
  const tmp = `${path}.tmp`;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS;
  const maxWindowMs = cadenceMs * MAX_WINDOW_CADENCES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const coarseHorizonMs = opts.coarseHorizonMs ?? DEFAULT_COARSE_HORIZON_MS;
  const bootGraceMs = opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const maxDeltaPerSec = opts.maxDeltaPerSec ?? DEFAULT_MAX_DELTA_PER_SEC;
  const now = opts.now ?? Date.now;
  const uptimeMs = opts.uptimeMs ?? (() => osUptime() * 1000);
  const log = opts.log ?? (() => {});

  const fine: EvidenceMap = new Map();
  const coarse = new Map<number, CoarseBucket[]>();
  const ctrlRing: ControllerSample[] = [];
  const routeFails = new Map<number, RouteFailureEvent[]>();
  const meta = new Map<number, NodeCoverage>();
  const lastCounters = new Map<number, CounterSnapshot>();
  let lastCtrl: CtrlSnapshot | null = null;
  let homeId: number | null = null;
  let loadedHomeId: number | null = null;
  let since: number | null = null;
  let dirty = false;
  let implausibleLogged = false;

  /**
   * Windowed deltas with the three guards. Returns null-everything when the
   * window is invalid; the boolean reports whether it was invalid (for the
   * coarse tier's invalidW count).
   */
  function guardedDeltas(prev: CounterSnapshot | undefined, cur: CounterSnapshot):
    { dTx: number | null; dTimeout: number | null; dDropTx: number | null; dRx: number | null; invalid: boolean } {
    if (!prev) return { dTx: null, dTimeout: null, dDropTx: null, dRx: null, invalid: true };
    const windowMs = cur.t - prev.t;
    // Over-long or non-positive window: deltas are not time-attributable.
    if (windowMs <= 0 || windowMs > maxWindowMs) {
      return { dTx: null, dTimeout: null, dDropTx: null, dRx: null, invalid: true };
    }
    // Whole-window invalidation: ANY counter backwards ⇒ driver restart ⇒ all null.
    if (cur.tx < prev.tx || cur.timeout < prev.timeout || cur.dropTx < prev.dropTx || cur.rx < prev.rx) {
      return { dTx: null, dTimeout: null, dDropTx: null, dRx: null, invalid: true };
    }
    const dTx = cur.tx - prev.tx;
    const dTimeout = cur.timeout - prev.timeout;
    const dDropTx = cur.dropTx - prev.dropTx;
    const dRx = cur.rx - prev.rx;
    // Plausibility: more messages than the RF could physically carry ⇒ fabricated.
    const cap = (windowMs / 1000) * maxDeltaPerSec;
    if (dTx > cap || dTimeout > cap || dDropTx > cap || dRx > cap) {
      if (!implausibleLogged) {
        implausibleLogged = true;
        log(`evidence: implausible counter delta (window ${Math.round(windowMs / 1000)}s, cap ${Math.round(cap)}) — nulling; check the stats feed`);
      }
      return { dTx: null, dTimeout: null, dDropTx: null, dRx: null, invalid: true };
    }
    return { dTx, dTimeout, dDropTx, dRx, invalid: false };
  }

  /** Fold one sample into its node's 30-min coarse bucket. */
  function foldCoarse(nodeId: number, s: EvidenceSample, invalid: boolean): void {
    const t0 = Math.floor(s.t / COARSE_BUCKET_MS) * COARSE_BUCKET_MS;
    const ring = coarse.get(nodeId) ?? [];
    const last = ring.length > 0 ? ring[ring.length - 1] : null;
    let b: CoarseBucket | null = null;
    if (last && last.t0 === t0) {
      b = last;
    } else if (last && t0 < last.t0) {
      // BACKWARD CLOCK STEP (review): a sample landing in an EARLIER bucket
      // than the ring's last must never append out-of-order/duplicate t0s —
      // one NTP step-back would corrupt every node's persisted ring at once.
      // Fold into the existing exact-match bucket if it's nearby; otherwise
      // drop the fold (the fine tier already nulls this sample's deltas).
      for (let i = ring.length - 1; i >= 0 && i >= ring.length - 4; i--) {
        if (ring[i].t0 === t0) { b = ring[i]; break; }
        if (ring[i].t0 < t0) break;
      }
      if (!b) return;
    }
    if (!b) {
      b = {
        t0, n: 0, freshN: 0, invalidW: 0, dTx: 0, dTimeout: 0, dDropTx: 0, dRx: 0,
        flaps: 0, routeChanges: 0, rssiN: 0, rssiSum: 0, rssiMin: null, rssiMax: null,
        rttN: 0, rttSum: 0, rateMin: null,
      };
      ring.push(b);
      // Prune to horizon on bucket rollover (cheap: only when a bucket is born).
      const cutoff = s.t - coarseHorizonMs;
      while (ring.length > 0 && ring[0].t0 < cutoff) ring.shift();
      coarse.set(nodeId, ring);
    }
    b.n += 1;
    if (s.fresh) b.freshN += 1;
    if (invalid) b.invalidW += 1;
    if (s.dTx != null) b.dTx += s.dTx;
    if (s.dTimeout != null) b.dTimeout += s.dTimeout;
    if (s.dDropTx != null) b.dDropTx += s.dDropTx;
    if (s.dRx != null) b.dRx += s.dRx;
    b.flaps += s.dFlaps;
    b.routeChanges += s.dRouteChanges;
    // rssi/rtt carry information only when fresh (pseudo-replication guard).
    if (s.fresh && s.rssi != null) {
      b.rssiN += 1;
      b.rssiSum += s.rssi;
      b.rssiMin = b.rssiMin == null ? s.rssi : Math.min(b.rssiMin, s.rssi);
      b.rssiMax = b.rssiMax == null ? s.rssi : Math.max(b.rssiMax, s.rssi);
    }
    if (s.fresh && s.rtt != null) {
      b.rttN += 1;
      b.rttSum += Math.round(s.rtt);
    }
    if (s.fresh && s.rateKbps != null) {
      b.rateMin = b.rateMin == null ? s.rateKbps : Math.min(b.rateMin, s.rateKbps);
    }
  }

  /** A bucket that witnessed nothing (no fresh obs, no events, no traffic) is omitted on disk. */
  function bucketWorthPersisting(b: CoarseBucket): boolean {
    return (
      b.freshN > 0 || b.flaps > 0 || b.routeChanges > 0 || b.invalidW > 0 ||
      b.dTx > 0 || b.dRx > 0 || b.dTimeout > 0 || b.dDropTx > 0
    );
  }

  /** Sort a loaded coarse ring by t0 and merge duplicate-t0 buckets (repairs
   *  rings written by the pre-fix foldCoarse after a backward clock step). */
  function normalizeCoarseRing(ring: CoarseBucket[]): CoarseBucket[] {
    ring.sort((a, b) => a.t0 - b.t0);
    const out: CoarseBucket[] = [];
    for (const b of ring) {
      const last = out[out.length - 1];
      if (!last || last.t0 !== b.t0) {
        out.push(b);
        continue;
      }
      last.n += b.n;
      last.freshN += b.freshN;
      last.invalidW += b.invalidW;
      last.dTx += b.dTx;
      last.dTimeout += b.dTimeout;
      last.dDropTx += b.dDropTx;
      last.dRx += b.dRx;
      last.flaps += b.flaps;
      last.routeChanges += b.routeChanges;
      last.rssiN += b.rssiN;
      last.rssiSum += b.rssiSum;
      last.rssiMin = last.rssiMin == null ? b.rssiMin : b.rssiMin == null ? last.rssiMin : Math.min(last.rssiMin, b.rssiMin);
      last.rssiMax = last.rssiMax == null ? b.rssiMax : b.rssiMax == null ? last.rssiMax : Math.max(last.rssiMax, b.rssiMax);
      last.rttN += b.rttN;
      last.rttSum += b.rttSum;
      last.rateMin = last.rateMin == null ? b.rateMin : b.rateMin == null ? last.rateMin : Math.min(last.rateMin, b.rateMin);
    }
    return out;
  }

  return {
    path,

    registerNode(nodeId, at): void {
      if (!Number.isInteger(nodeId) || nodeId <= 0) return;
      if (meta.has(nodeId)) return;
      const t = at ?? now();
      meta.set(nodeId, { firstSeenAt: t, samples: 0, freshSamples: 0 });
      if (since == null) since = t;
      dirty = true;
    },

    evictNode(nodeId): void {
      const had = fine.delete(nodeId);
      const hadC = coarse.delete(nodeId);
      routeFails.delete(nodeId);
      meta.delete(nodeId);
      lastCounters.delete(nodeId);
      if (had || hadC) dirty = true;
    },

    record(nodeId, stats, status, extras, at): EvidenceSample {
      const t = at ?? now();
      if (since == null) since = t;
      const cur: CounterSnapshot = {
        t,
        tx: stats.commandsTX,
        timeout: stats.timeoutResponse,
        dropTx: stats.commandsDroppedTX,
        rx: stats.commandsRX,
      };
      const prev = lastCounters.get(nodeId);
      const d = guardedDeltas(prev, cur);
      const fresh = extras?.fresh ?? false;
      const sample: EvidenceSample = {
        t,
        dTx: d.dTx,
        dTimeout: d.dTimeout,
        dDropTx: d.dDropTx,
        dRx: d.dRx,
        dFlaps: extras?.flaps ?? 0,
        dRouteChanges: extras?.routeChanges ?? 0,
        fresh,
        rtt: stats.rtt != null && Number.isFinite(stats.rtt) ? Math.round(stats.rtt * 10) / 10 : null,
        rssi: cleanRssi(stats.rssi),
        rateKbps: stats.lwr?.protocolDataRate != null ? RATE_KBPS[stats.lwr.protocolDataRate] ?? null : null,
        routeKey: routeKeyOf(stats),
        status,
        lastSeen: null, // reserved (v0.13)
        isListening: null, // reserved (v0.13)
      };
      lastCounters.set(nodeId, cur);
      const ring = fine.get(nodeId) ?? [];
      ring.push(sample);
      if (ring.length > maxSamples) ring.splice(0, ring.length - maxSamples);
      fine.set(nodeId, ring);
      foldCoarse(nodeId, sample, d.invalid);
      const m = meta.get(nodeId) ?? { firstSeenAt: t, samples: 0, freshSamples: 0 };
      m.samples += 1;
      if (fresh) m.freshSamples += 1;
      meta.set(nodeId, m);
      dirty = true;
      return sample;
    },

    recordController(stats, fresh, at): ControllerSample {
      const t = at ?? now();
      const cur: CtrlSnapshot = {
        t,
        msgTx: stats.messagesTX,
        msgDroppedTx: stats.messagesDroppedTX,
        nak: stats.NAK,
        can: stats.CAN,
        timeoutAck: stats.timeoutACK,
        timeoutResponse: stats.timeoutResponse,
      };
      let s: ControllerSample;
      const invalidOut = { dMsgTx: null, dMsgDroppedTx: null, dNak: null, dCan: null, dTimeoutAck: null, dTimeoutResponse: null } as const;
      // Serial-link plausibility (review: 'same delta discipline' means the
      // controller gets the fabrication backstop too). The host↔stick serial
      // link carries more than any one node's RF, so the cap is looser — but a
      // lifetime-sized jump is still orders of magnitude beyond it.
      const ctrlCap = lastCtrl ? ((cur.t - lastCtrl.t) / 1000) * maxDeltaPerSec * 10 : 0;
      if (!lastCtrl || cur.t - lastCtrl.t <= 0 || cur.t - lastCtrl.t > maxWindowMs ||
          cur.msgTx < lastCtrl.msgTx || cur.msgDroppedTx < lastCtrl.msgDroppedTx ||
          cur.nak < lastCtrl.nak || cur.can < lastCtrl.can ||
          cur.timeoutAck < lastCtrl.timeoutAck || cur.timeoutResponse < lastCtrl.timeoutResponse ||
          cur.msgTx - lastCtrl.msgTx > ctrlCap) {
        s = { t, ...invalidOut, fresh, bg0: null, bg1: null, bg2: null, bg3: null };
      } else {
        s = {
          t,
          dMsgTx: cur.msgTx - lastCtrl.msgTx,
          dMsgDroppedTx: cur.msgDroppedTx - lastCtrl.msgDroppedTx,
          dNak: cur.nak - lastCtrl.nak,
          dCan: cur.can - lastCtrl.can,
          dTimeoutAck: cur.timeoutAck - lastCtrl.timeoutAck,
          dTimeoutResponse: cur.timeoutResponse - lastCtrl.timeoutResponse,
          fresh,
          bg0: null, bg1: null, bg2: null, bg3: null, // reserved (v0.13)
        };
      }
      lastCtrl = cur;
      ctrlRing.push(s);
      if (ctrlRing.length > CTRL_MAX_SAMPLES) ctrlRing.splice(0, ctrlRing.length - CTRL_MAX_SAMPLES);
      dirty = true;
      return s;
    },

    recordRouteFailure(nodeId, between, at): void {
      if (!Number.isInteger(nodeId) || nodeId <= 0) return;
      const ring = routeFails.get(nodeId) ?? [];
      ring.push({ t: at ?? now(), between });
      if (ring.length > ROUTE_FAIL_RING) ring.splice(0, ring.length - ROUTE_FAIL_RING);
      routeFails.set(nodeId, ring);
      dirty = true;
    },

    forNode: (nodeId) => fine.get(nodeId) ?? [],
    coarseForNode: (nodeId) => coarse.get(nodeId) ?? [],
    controllerSamples: () => ctrlRing,
    routeFailures: (nodeId) => routeFails.get(nodeId) ?? [],
    coverage: (nodeId) => meta.get(nodeId) ?? null,
    recordingSince: () => since,
    all: () => fine,

    bindHomeId(id: number): void {
      if (homeId === id) return;
      const conflict = (loadedHomeId != null && loadedHomeId !== id) || (homeId != null && homeId !== id);
      homeId = id;
      loadedHomeId = id;
      if (conflict) {
        log(`evidence: controller home id changed — discarding evidence for the previous network`);
        this.reset();
      }
    },

    load(): EvidenceMap {
      fine.clear();
      coarse.clear();
      ctrlRing.length = 0;
      routeFails.clear();
      meta.clear();
      lastCounters.clear();
      lastCtrl = null;
      try {
        if (!existsSync(path)) return fine;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return fine;
        const obj = parsed as Partial<Persisted>;
        if (obj.v !== SCHEMA_V) {
          log(`evidence: schema ${String(obj.v)} unsupported — starting fresh`);
          return fine;
        }
        const savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : 0;
        const ageMs = now() - savedAt;
        // GRACE FIRST (review: the ordering here was a data-destroyer). On a
        // no-RTC host the boot clock restores BEHIND the last flush's savedAt,
        // so ageMs < 0 at load time is the NORMAL post-power-blip state — it
        // means the clock is bogus NOW, not that the file is bad. Under grace,
        // recency judgments (future-dated, fine-ring age) are all untrusted;
        // only an unstamped file (bogus at SAVE time) is discarded outright.
        const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs;
        if (savedAt <= 0) {
          log('evidence: snapshot has no savedAt — starting fresh');
          return fine;
        }
        if (!grace && ageMs < 0) {
          log('evidence: snapshot is future-dated (clock trusted) — starting fresh');
          return fine;
        }
        loadedHomeId = typeof obj.homeId === 'number' ? obj.homeId : null;
        if (homeId != null && loadedHomeId != null && loadedHomeId !== homeId) {
          log(`evidence: persisted home id ${loadedHomeId} ≠ live ${homeId} — starting fresh`);
          return fine;
        }
        since = typeof obj.recordingSince === 'number' ? obj.recordingSince : null;
        // Boot-grace: the coarse tier + coverage metadata are age-judgment-free
        // history — load them; drop only the recency-dependent fine ring.
        const fineTooOld = grace || (maxAgeMs > 0 && ageMs > maxAgeMs) || ageMs < 0;
        if (grace) log(`evidence: host up ${Math.round(uptimeMs() / 1000)}s — clock untrusted, loading coarse tier only`);
        else if (fineTooOld) log(`evidence: snapshot is ${Math.round(ageMs / 60000)}m old — fine ring discarded, coarse tier kept`);

        // Coverage metadata.
        if (obj.meta && typeof obj.meta === 'object') {
          for (const [k, v] of Object.entries(obj.meta)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0 || !v || typeof v !== 'object') continue;
            const fm = v as { firstSeenAt?: unknown; samples?: unknown; fresh?: unknown };
            if (typeof fm.firstSeenAt !== 'number') continue;
            meta.set(id, {
              firstSeenAt: fm.firstSeenAt,
              samples: typeof fm.samples === 'number' ? fm.samples : 0,
              freshSamples: typeof fm.fresh === 'number' ? fm.fresh : 0,
            });
          }
        }
        // Coarse tier (pruned to horizon).
        if (obj.coarse && typeof obj.coarse === 'object') {
          const cutoff = now() - coarseHorizonMs;
          for (const [k, cols] of Object.entries(obj.coarse)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0 || !cols || !Array.isArray(cols.t0)) continue;
            const ring: CoarseBucket[] = [];
            for (let i = 0; i < cols.t0.length; i++) {
              const t0 = cols.t0[i];
              if (typeof t0 !== 'number' || !Number.isFinite(t0)) continue;
              if (!grace && t0 < cutoff) continue; // prune (skip pruning under grace — clock untrusted)
              ring.push({
                t0,
                n: cols.n?.[i] ?? 0,
                freshN: cols.fN?.[i] ?? 0,
                invalidW: cols.iW?.[i] ?? 0,
                dTx: cols.dTx?.[i] ?? 0,
                dTimeout: cols.dTo?.[i] ?? 0,
                dDropTx: cols.dDr?.[i] ?? 0,
                dRx: cols.dRx?.[i] ?? 0,
                flaps: cols.fl?.[i] ?? 0,
                routeChanges: cols.rc?.[i] ?? 0,
                rssiN: cols.rN?.[i] ?? 0,
                rssiSum: cols.rS?.[i] ?? 0,
                rssiMin: numOrNull(cols.rMin?.[i]),
                rssiMax: numOrNull(cols.rMax?.[i]),
                rttN: cols.ttN?.[i] ?? 0,
                rttSum: cols.ttS?.[i] ?? 0,
                rateMin: numOrNull(cols.rate?.[i]),
              });
            }
            if (ring.length > 0) coarse.set(id, normalizeCoarseRing(ring));
          }
        }
        // Controller ring — restored symmetrically with save() (review: it was
        // write-only, silently dropped on every restart).
        if (obj.controller && Array.isArray(obj.controller.t)) {
          const c = obj.controller;
          for (let i = 0; i < c.t.length && i < CTRL_MAX_SAMPLES; i++) {
            const t = c.t[i];
            if (typeof t !== 'number' || !Number.isFinite(t)) continue;
            ctrlRing.push({
              t,
              dMsgTx: numOrNull(c.dTx?.[i]),
              dMsgDroppedTx: numOrNull(c.dDr?.[i]),
              dNak: numOrNull(c.nak?.[i]),
              dCan: numOrNull(c.can?.[i]),
              dTimeoutAck: numOrNull(c.tAck?.[i]),
              dTimeoutResponse: numOrNull(c.tRes?.[i]),
              fresh: c.fr?.[i] === 1,
              bg0: numOrNull(c.bg0?.[i]),
              bg1: numOrNull(c.bg1?.[i]),
              bg2: numOrNull(c.bg2?.[i]),
              bg3: numOrNull(c.bg3?.[i]),
            });
          }
        }
        // Route-failure rings (small, kept both tiers' rules aside — event history).
        if (obj.routeFails && typeof obj.routeFails === 'object') {
          for (const [k, v] of Object.entries(obj.routeFails)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0 || !v || !Array.isArray(v.t)) continue;
            const ring: RouteFailureEvent[] = [];
            for (let i = 0; i < v.t.length && i < ROUTE_FAIL_RING; i++) {
              if (typeof v.t[i] !== 'number' || typeof v.a?.[i] !== 'number' || typeof v.b?.[i] !== 'number') continue;
              ring.push({ t: v.t[i], between: [v.a[i], v.b[i]] });
            }
            if (ring.length > 0) routeFails.set(id, ring);
          }
        }
        // Fine tier — only when the clock is trusted AND the snapshot is recent.
        if (!grace && !fineTooOld && obj.nodes && typeof obj.nodes === 'object') {
          for (const [k, cols] of Object.entries(obj.nodes)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0 || !cols || !Array.isArray(cols.t)) continue;
            const ring: EvidenceSample[] = [];
            for (let i = 0; i < cols.t.length; i++) {
              const t = cols.t[i];
              if (typeof t !== 'number' || !Number.isFinite(t)) continue;
              const st = cols.st?.[i];
              ring.push({
                t,
                dTx: numOrNull(cols.dTx?.[i]),
                dTimeout: numOrNull(cols.dTo?.[i]),
                dDropTx: numOrNull(cols.dDr?.[i]),
                dRx: numOrNull(cols.dRx?.[i]),
                dFlaps: typeof cols.dF?.[i] === 'number' ? cols.dF[i] : 0,
                dRouteChanges: typeof cols.dRC?.[i] === 'number' ? cols.dRC[i] : 0,
                fresh: cols.fr?.[i] === 1,
                rtt: numOrNull(cols.rtt?.[i]),
                rssi: numOrNull(cols.rssi?.[i]),
                rateKbps: numOrNull(cols.rate?.[i]),
                routeKey: typeof cols.rk?.[i] === 'string' ? cols.rk[i] : null,
                status: typeof st === 'number' && st >= 0 && st <= 4 ? (st as NodeStatus) : NodeStatus.Unknown,
                lastSeen: numOrNull(cols.ls?.[i]),
                isListening: cols.il?.[i] == null ? null : cols.il[i] === 1,
              });
            }
            const bounded = ring.length > maxSamples ? ring.slice(ring.length - maxSamples) : ring;
            if (bounded.length > 0) fine.set(id, bounded);
          }
        }
        log(`evidence: restored ${coarse.size} node(s) coarse${grace || fineTooOld ? '' : ` + ${fine.size} fine`} from ${path}`);
      } catch (e) {
        log(`evidence: load failed (${(e as Error).message}) — starting fresh`);
        fine.clear();
        coarse.clear();
        meta.clear();
        routeFails.clear();
      }
      dirty = false;
      return fine;
    },

    save(): void {
      if (!dirty) return;
      try {
        const nodes: Persisted['nodes'] = {};
        for (const [id, ring] of fine) {
          if (!Number.isInteger(id) || id <= 0 || ring.length === 0) continue;
          const cols: FineCols = { t: [], dTx: [], dTo: [], dDr: [], dRx: [], dF: [], dRC: [], fr: [], rtt: [], rssi: [], rate: [], rk: [], st: [], ls: [], il: [] };
          for (const s of ring.slice(-maxSamples)) {
            cols.t.push(s.t);
            cols.dTx.push(s.dTx);
            cols.dTo.push(s.dTimeout);
            cols.dDr.push(s.dDropTx);
            cols.dRx.push(s.dRx);
            cols.dF.push(s.dFlaps);
            cols.dRC.push(s.dRouteChanges);
            cols.fr.push(s.fresh ? 1 : 0);
            cols.rtt.push(s.rtt);
            cols.rssi.push(s.rssi);
            cols.rate.push(s.rateKbps);
            cols.rk.push(s.routeKey);
            cols.st.push(s.status);
            cols.ls.push(s.lastSeen);
            cols.il.push(s.isListening == null ? null : s.isListening ? 1 : 0);
          }
          nodes[String(id)] = cols;
        }
        const coarseOut: Persisted['coarse'] = {};
        // Prune at save time too (review: prune-on-birth alone lets a node that
        // stopped sampling serve beyond-horizon buckets forever).
        const saveCutoff = now() - coarseHorizonMs;
        for (const [id, ring] of coarse) {
          if (!Number.isInteger(id) || id <= 0) continue;
          const keep = ring.filter((b) => bucketWorthPersisting(b) && b.t0 >= saveCutoff);
          if (keep.length === 0) continue;
          const cols: CoarseCols = { t0: [], n: [], fN: [], iW: [], dTx: [], dTo: [], dDr: [], dRx: [], fl: [], rc: [], rN: [], rS: [], rMin: [], rMax: [], ttN: [], ttS: [], rate: [] };
          for (const b of keep) {
            cols.t0.push(b.t0);
            cols.n.push(b.n);
            cols.fN.push(b.freshN);
            cols.iW.push(b.invalidW);
            cols.dTx.push(b.dTx);
            cols.dTo.push(b.dTimeout);
            cols.dDr.push(b.dDropTx);
            cols.dRx.push(b.dRx);
            cols.fl.push(b.flaps);
            cols.rc.push(b.routeChanges);
            cols.rN.push(b.rssiN);
            cols.rS.push(b.rssiSum);
            cols.rMin.push(b.rssiMin);
            cols.rMax.push(b.rssiMax);
            cols.ttN.push(b.rttN);
            cols.ttS.push(b.rttSum);
            cols.rate.push(b.rateMin);
          }
          coarseOut[String(id)] = cols;
        }
        let controller: CtrlCols | null = null;
        if (ctrlRing.length > 0) {
          controller = { t: [], dTx: [], dDr: [], nak: [], can: [], tAck: [], tRes: [], fr: [], bg0: [], bg1: [], bg2: [], bg3: [] };
          for (const s of ctrlRing) {
            controller.t.push(s.t);
            controller.dTx.push(s.dMsgTx);
            controller.dDr.push(s.dMsgDroppedTx);
            controller.nak.push(s.dNak);
            controller.can.push(s.dCan);
            controller.tAck.push(s.dTimeoutAck);
            controller.tRes.push(s.dTimeoutResponse);
            controller.fr.push(s.fresh ? 1 : 0);
            controller.bg0.push(s.bg0);
            controller.bg1.push(s.bg1);
            controller.bg2.push(s.bg2);
            controller.bg3.push(s.bg3);
          }
        }
        const rf: Persisted['routeFails'] = {};
        for (const [id, ring] of routeFails) {
          if (ring.length === 0) continue;
          rf[String(id)] = { t: ring.map((x) => x.t), a: ring.map((x) => x.between[0]), b: ring.map((x) => x.between[1]) };
        }
        const metaOut: Persisted['meta'] = {};
        for (const [id, m] of meta) {
          metaOut[String(id)] = { firstSeenAt: m.firstSeenAt, samples: m.samples, fresh: m.freshSamples };
        }
        const payload: Persisted = {
          v: SCHEMA_V,
          savedAt: now(),
          homeId,
          recordingSince: since,
          nodes,
          coarse: coarseOut,
          controller,
          routeFails: rf,
          meta: metaOut,
        };
        writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        renameSync(tmp, path);
        dirty = false;
      } catch (e) {
        log(`evidence: save failed (${(e as Error).message})`);
      }
    },

    reset(): void {
      fine.clear();
      coarse.clear();
      ctrlRing.length = 0;
      routeFails.clear();
      meta.clear();
      lastCounters.clear();
      lastCtrl = null;
      since = null;
      loadedHomeId = homeId;
      // Rewrite disk NOW — a crash between reset and the next flush must not
      // resurrect the previous network's evidence.
      dirty = true;
      this.save();
    },
  };
}
