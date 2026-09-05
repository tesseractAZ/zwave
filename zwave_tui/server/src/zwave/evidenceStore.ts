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
 * Driver-WS fields (populated since v0.13 by `driverWsClient`):
 * per-sample lastSeen, controller per-channel bgRssi. Reserving them now means
 * v0.13 lands without a schema migration or baseline re-learn.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { LogSink } from '../logger';
import { uptime as osUptime } from 'node:os';
import { rssiReading } from './health';
import { NodeStatus, type NodeStats, type RouteStat, type ControllerSnapshot } from '../types';

/** The controller serial-link counters (nullable on the snapshot; non-null here). */
type CtrlStats = NonNullable<ControllerSnapshot['statistics']>;

/** RSSI values the driver uses as sentinels, not real dBm (RESEARCH.md §1.11). */
// No local sentinel list: health.rssiReading is the domain rule — RESEARCH.md §1.11.
// (125 no-signal / 126 saturated / 127 not-available are all >= 0, so the rule covers them.)

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
  /** S2 SPAN-resync log events since the previous sample (event-driven, v0.26).
   *  **NULL = the log lane was not listening** (never started, refused, or the
   *  storm backstop stopped it) — an honest unknown, the same discipline the
   *  driver-WS noise floor uses. It must NOT be 0: "switched off" reading as
   *  "none happened" let a storm-stop mid-episode fabricate an `improved`
   *  outcome verdict (v0.26 review). 0 means the lane WAS listening and saw
   *  nothing. */
  dS2Resync: number | null;
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
  /** FLiRS (frequently-listening) capability — driver-WS (v0.13). Distinguishes
   *  a beaming lock (isListening:false, isFrequentListening:true) from a plain
   *  sleeping battery node — load-bearing for the battery/FLiRS executor guard. */
  isFrequentListening: boolean | null;
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
  /** S2 SPAN-resync events folded into this bucket (v0.26). */
  s2: number;
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

/** A 30-min downsampled bucket of the CONTROLLER's background-noise floor — the
 *  long-horizon (multi-day) tier behind the ~40-min fine controller ring, so the
 *  interference screen's noise trend survives restarts and spans days. Each fold
 *  is one sample's median-of-channels floor (dBm); the bucket keeps the sum+count
 *  (→ mean) plus the quietest/noisiest extremes. */
export interface CtrlCoarseBucket {
  t0: number; // bucket start (aligned to COARSE_BUCKET_MS)
  floorN: number; // samples that carried a real noise-floor reading
  floorSum: number; // Σ per-sample median floor (dBm, negative) → mean = floorSum/floorN
  floorMin: number | null; // most-negative (quietest) floor in the bucket
  floorMax: number | null; // least-negative (noisiest) floor in the bucket
}

/** An event-captured route failure (transient — latched on appearance). */
export interface RouteFailureEvent {
  t: number;
  /** [last-functional, first-non-functional] node ids. */
  between: [number, number];
}

/** Per-node coverage metadata — survives ring eviction and restarts. */
/** The sweep's per-probe verdict, mirrored from autoPing's `ProbeClass` — kept
 *  structural rather than imported so the store does not depend on the runner. */
export type ProbeClassLite = 'self-proven' | 'echo-only' | 'attribution-unknown' | 'unheard';

export interface NodeCoverage {
  /** First time this node appeared on the roster (registerNode). */
  firstSeenAt: number;
  /** Cumulative counts since firstSeenAt (not ring-bounded). */
  samples: number;
  freshSamples: number;
  /**
   * Liveness-probe outcomes (v0.37). Cumulative, persisted, never ring-bounded.
   *
   * From v0.37 the liveness sweep asks EVERY listening node on a fixed cadence
   * rather than only the ones that have gone quiet, which is what makes these
   * counts comparable between nodes: the same question, at the same interval,
   * of every device. "Answered 3 of 20" is then a fact about the node rather
   * than about how talkative it happens to be.
   *
   * This measures something the driver's Dead flag cannot. Dead is set
   * REACTIVELY — only when a transmission fails — so a node nobody addresses
   * reads Alive indefinitely; the sweep converts that silence into evidence.
   */
  probesAsked: number;
  probesAnswered: number;
  /**
   * Probes where the node had ALREADY proved itself since the previous sweep,
   * by communicating on its own (v0.37).
   *
   * A high count means the probe is redundant for this device — its own traffic
   * is the liveness evidence and the sweep is only confirming it. That is worth
   * distinguishing from a node whose ONLY proof of life is the probe, because
   * the two look identical in a bare answered/asked ratio.
   */
  probesSelfProven: number;
  /**
   * The other three arms of the SAME four-way judgment (v0.49.0).
   *
   * `probesSelfProven` was the only one ever recorded; the rest were computed,
   * described in a log line, and discarded on every tick — so "why is this
   * node's evidence thin" was answerable only by grepping prose out of a
   * container log the TUI cannot read. They are what separates "this node never
   * speaks except to answer us" from "this node is genuinely silent", and those
   * are opposite conclusions from the same answered/asked ratio.
   */
  probesEchoOnly: number;
  probesAttribUnknown: number;
  probesUnheard: number;
}

export type EvidenceMap = Map<number, EvidenceSample[]>;

/** Extra per-sample inputs the caller accumulates event-driven. */
export interface SampleExtras {
  flaps?: number;
  routeChanges?: number;
  /** S2 SPAN-resync events since the last sample (v0.26). `null` ⇒ the lane
   *  was not listening (unknown); absent ⇒ same. */
  s2Resyncs?: number | null;
  fresh?: boolean;
  /** Driver-WS telemetry (v0.13); absent ⇒ recorded null (honest unknown). */
  lastSeen?: number | null;
  isListening?: boolean | null;
  isFrequentListening?: boolean | null;
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
  /** Widened to LogSink (v0.53.0) so a failed save can claim `error` — it was
   *  the only report of a store that stopped persisting, and it vanished at
   *  `log_level: warning` along with the routine chatter. */
  log?: LogSink;
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
  /** Capture one controller sample through the same delta guards. `bg` is the
   *  driver-WS per-channel background RSSI (v0.13); omitted ⇒ nulls. */
  recordController(stats: CtrlStats, fresh: boolean, at?: number, bg?: (number | null)[] | null): ControllerSample;
  /** Latch a route failure the moment it appears (event-driven, deduped by caller). */
  recordRouteFailure(nodeId: number, between: [number, number], at?: number): void;
  forNode(nodeId: number): EvidenceSample[];
  coarseForNode(nodeId: number): CoarseBucket[];
  controllerSamples(): ControllerSample[];
  /** The long-horizon (multi-day) controller noise-floor tier (30-min buckets). */
  controllerCoarse(): CtrlCoarseBucket[];
  routeFailures(nodeId: number): RouteFailureEvent[];
  coverage(nodeId: number): NodeCoverage | null;
  /** Record one liveness-probe outcome for a node (v0.37). `selfProven` means
   *  the node had already communicated on its own since the previous sweep. */
  recordProbe(nodeId: number, answered: boolean, cls: ProbeClassLite, at?: number): void;
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
  /** Optional: absent in pre-v0.26 snapshots (revives as 0s). */
  dS2?: (number | null)[];
  fr: (0 | 1)[];
  rtt: (number | null)[];
  rssi: (number | null)[];
  rate: (number | null)[];
  rk: (string | null)[];
  st: number[];
  ls: (number | null)[];
  il: (0 | 1 | null)[];
  ifl: (0 | 1 | null)[];
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
  /** Optional: absent in pre-v0.26 snapshots (revives as 0s). */
  s2?: number[];
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

interface CtrlCoarseCols {
  t0: number[];
  fN: number[]; // floorN
  fS: number[]; // floorSum
  fMin: (number | null)[];
  fMax: (number | null)[];
}

interface Persisted {
  v: number;
  savedAt: number;
  homeId: number | null;
  recordingSince: number | null;
  nodes: Record<string, FineCols>;
  coarse: Record<string, CoarseCols>;
  controller: CtrlCols | null;
  /** Optional (added within v2, read defensively): the long-horizon controller
   *  noise-floor tier. Absent in a pre-tier v2 file ⇒ the tier loads empty. */
  controllerCoarse?: CtrlCoarseCols | null;
  routeFails: Record<string, { t: number[]; a: number[]; b: number[] }>;
  meta: Record<string, { firstSeenAt: number; samples: number; fresh: number; pa?: number; pk?: number; ps?: number; pe?: number; pu?: number; pn?: number }>;
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

/**
 * The CANONICAL RSSI domain rule, not a local copy of it.
 *
 * This enumerated the driver's sentinel markers (>= 125) and let everything
 * below through — so `0 dBm`, and any positive reading short of the sentinel
 * band, was folded into the baselines and the persisted envelopes as if it
 * were a real measurement. A received-signal strength is negative by physics;
 * `health.rssiReading` has said so since v0.10 and is what every SCREEN uses.
 * A store that admits values its own renderer would reject writes a lie that
 * outlives the sample (v0.53.0 → v0.54.0).
 */
function cleanRssi(v: number | null | undefined): number | null {
  return rssiReading(v);
}

/**
 * The ONE definition of "which path is this node reached by".
 *
 * NULL MEANS UNKNOWN, AND UNKNOWN IS NOT A ROUTE. The driver may report node
 * statistics with no `lwr` at all — after a re-interview, on a partial stats
 * event, or simply before the first successful transmission. That is LOST
 * VISIBILITY, not a change of path, and the distinction is the whole point of
 * returning `null` rather than a string: `'direct'` is a fact about the mesh,
 * `null` is a fact about our knowledge of it. This is the same discipline as
 * `dS2Resync: null` ("the log lane was not listening") versus `0` ("it was
 * listening and saw nothing").
 *
 * It lives here, exported, because a SECOND copy in zwaveData used to collapse
 * both cases to `''`. Under that copy a routed node whose `lwr` blinked scored
 * TWO route changes — one when the data vanished and one when it returned —
 * and route-churn fires at four. Two driver hiccups could therefore light up
 * every routed node at once with an entirely fabricated symptom. Two
 * definitions of one concept is a bug with a delay on it.
 */
export function routeKeyOfLwr(lwr: RouteStat | null | undefined): string | null {
  if (!lwr) return null;
  const reps = Array.isArray(lwr.repeaters) ? lwr.repeaters : [];
  return reps.length === 0 ? 'direct' : 'r' + reps.join('-');
}

/**
 * Did the mesh actually re-route this node between two statistics events?
 *
 * A pure predicate rather than an inline comparison at the call site, because
 * the call site is a private method on the live data layer and a guard nothing
 * can reach is a guard nothing can prove. The rule it encodes — a change is
 * only a change when BOTH endpoints are known — is the entire fix, so it gets
 * to be a function with tests rather than two `!= null` clauses in a condition.
 */
export function isRouteChange(
  before: RouteStat | null | undefined,
  after: RouteStat | null | undefined,
): boolean {
  const a = routeKeyOfLwr(before);
  const b = routeKeyOfLwr(after);
  return a != null && b != null && a !== b;
}

function routeKeyOf(stats: NodeStats): string | null {
  return routeKeyOfLwr(stats.lwr);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The per-sample noise floor: median of the finite negative values in the
 *  LEADING contiguous run of channels (a null ends the run — the driver's own
 *  convention). Byte-for-byte identical to interference.ts `medianFloor`, so the
 *  persisted coarse trend and the live fine trend never disagree on "the floor".
 *  Kept here (not imported) so the store stays free of the interference module. */
function medFloor(chs: (number | null)[]): number | null {
  const run: number[] = [];
  for (const ch of chs) { if (ch == null) break; run.push(ch); }
  const v = run.filter((x) => Number.isFinite(x) && x < 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A zeroed coverage record. One constructor, so a new counter cannot be added
 *  to the type and forgotten at one of the three construction sites. */
function emptyMeta(t: number): NodeCoverage {
  return {
    firstSeenAt: t, samples: 0, freshSamples: 0,
    probesAsked: 0, probesAnswered: 0, probesSelfProven: 0,
    probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0,
  };
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
  const log: LogSink = opts.log ?? (() => {});

  const fine: EvidenceMap = new Map();
  const coarse = new Map<number, CoarseBucket[]>();
  const ctrlRing: ControllerSample[] = [];
  const ctrlCoarse: CtrlCoarseBucket[] = []; // long-horizon controller noise-floor tier
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
        flaps: 0, routeChanges: 0, s2: 0, rssiN: 0, rssiSum: 0, rssiMin: null, rssiMax: null,
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
    if (s.dS2Resync != null) b.s2 += s.dS2Resync; // null = lane dark, not zero
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

  /** Fold one controller noise-floor reading into the 30-min coarse tier. Mirrors
   *  `foldCoarse`'s single-ring bucketing + backward-clock discipline + prune. */
  function foldCtrlCoarse(t: number, floor: number): void {
    const t0 = Math.floor(t / COARSE_BUCKET_MS) * COARSE_BUCKET_MS;
    const last = ctrlCoarse.length > 0 ? ctrlCoarse[ctrlCoarse.length - 1] : null;
    let b: CtrlCoarseBucket | null = null;
    if (last && last.t0 === t0) {
      b = last;
    } else if (last && t0 < last.t0) {
      // Backward clock step: fold into a nearby exact-match bucket or drop the
      // fold (never append an out-of-order/duplicate t0).
      for (let i = ctrlCoarse.length - 1; i >= 0 && i >= ctrlCoarse.length - 4; i--) {
        if (ctrlCoarse[i].t0 === t0) { b = ctrlCoarse[i]; break; }
        if (ctrlCoarse[i].t0 < t0) break;
      }
      if (!b) return;
    }
    if (!b) {
      b = { t0, floorN: 0, floorSum: 0, floorMin: null, floorMax: null };
      ctrlCoarse.push(b);
      const cutoff = t - coarseHorizonMs;
      while (ctrlCoarse.length > 0 && ctrlCoarse[0].t0 < cutoff) ctrlCoarse.shift();
    }
    b.floorN += 1;
    b.floorSum += floor;
    b.floorMin = b.floorMin == null ? floor : Math.min(b.floorMin, floor);
    b.floorMax = b.floorMax == null ? floor : Math.max(b.floorMax, floor);
  }

  /** Sort a loaded controller-coarse ring by t0 and merge duplicate-t0 buckets. */
  function normalizeCtrlCoarse(ring: CtrlCoarseBucket[]): CtrlCoarseBucket[] {
    ring.sort((a, b) => a.t0 - b.t0);
    const out: CtrlCoarseBucket[] = [];
    for (const b of ring) {
      const prev = out[out.length - 1];
      if (!prev || prev.t0 !== b.t0) { out.push(b); continue; }
      prev.floorN += b.floorN;
      prev.floorSum += b.floorSum;
      prev.floorMin = prev.floorMin == null ? b.floorMin : b.floorMin == null ? prev.floorMin : Math.min(prev.floorMin, b.floorMin);
      prev.floorMax = prev.floorMax == null ? b.floorMax : b.floorMax == null ? prev.floorMax : Math.max(prev.floorMax, b.floorMax);
    }
    return out;
  }

  /** A bucket that witnessed nothing (no fresh obs, no events, no traffic) is omitted on disk. */
  function bucketWorthPersisting(b: CoarseBucket): boolean {
    return (
      b.freshN > 0 || b.flaps > 0 || b.routeChanges > 0 || b.s2 > 0 || b.invalidW > 0 ||
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
      last.s2 += b.s2;
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
      meta.set(nodeId, emptyMeta(t));
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
        dS2Resync: extras?.s2Resyncs ?? null,
        fresh,
        rtt: stats.rtt != null && Number.isFinite(stats.rtt) ? Math.round(stats.rtt * 10) / 10 : null,
        rssi: cleanRssi(stats.rssi),
        rateKbps: stats.lwr?.protocolDataRate != null ? RATE_KBPS[stats.lwr.protocolDataRate] ?? null : null,
        routeKey: routeKeyOf(stats),
        status,
        lastSeen: extras?.lastSeen ?? null, // driver-WS (v0.13); null when absent
        isListening: extras?.isListening ?? null,
        isFrequentListening: extras?.isFrequentListening ?? null,
      };
      lastCounters.set(nodeId, cur);
      const ring = fine.get(nodeId) ?? [];
      ring.push(sample);
      if (ring.length > maxSamples) ring.splice(0, ring.length - maxSamples);
      fine.set(nodeId, ring);
      foldCoarse(nodeId, sample, d.invalid);
      const m = meta.get(nodeId) ?? emptyMeta(t);
      m.samples += 1;
      if (fresh) m.freshSamples += 1;
      meta.set(nodeId, m);
      dirty = true;
      return sample;
    },

    recordController(stats, fresh, at, bg): ControllerSample {
      const bg0 = bg?.[0] ?? null;
      const bg1 = bg?.[1] ?? null;
      const bg2 = bg?.[2] ?? null;
      const bg3 = bg?.[3] ?? null;
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
        s = { t, ...invalidOut, fresh, bg0, bg1, bg2, bg3 };
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
          bg0, bg1, bg2, bg3, // driver-WS noise floor (v0.13); nulls when absent
        };
      }
      lastCtrl = cur;
      ctrlRing.push(s);
      if (ctrlRing.length > CTRL_MAX_SAMPLES) ctrlRing.splice(0, ctrlRing.length - CTRL_MAX_SAMPLES);
      // Fold the noise floor into the long-horizon tier (bg is already staleness-
      // gated to null upstream, so a non-null median = a real, recent reading).
      const floor = medFloor([bg0, bg1, bg2, bg3]);
      if (floor != null) foldCtrlCoarse(t, floor);
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
    controllerCoarse: () => ctrlCoarse,
    routeFailures: (nodeId) => routeFails.get(nodeId) ?? [],
    recordProbe(nodeId, answered, cls, at): void {
      const t = at ?? now();
      const m = meta.get(nodeId) ?? emptyMeta(t);
      m.probesAsked += 1;
      if (answered) m.probesAnswered += 1;
      // Exactly one arm per probe: the four are mutually exclusive by
      // construction upstream, and counting two would make the shares sum past
      // the asked total.
      if (cls === 'self-proven') m.probesSelfProven += 1;
      else if (cls === 'echo-only') m.probesEchoOnly += 1;
      else if (cls === 'attribution-unknown') m.probesAttribUnknown += 1;
      else m.probesUnheard += 1;
      meta.set(nodeId, m);
      dirty = true;
    },
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
      ctrlCoarse.length = 0;
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
        //
        // v0.40: grace lifts only for a clock that PROVABLY CARRIED through
        // the outage — age reading strictly greater than this boot's uptime
        // plus a minute of slack, which only a clock that kept running while
        // the host was down can show (the Pi 5's RTC held to 0.2 s across a
        // 59-minute cut while the uptime-only guard dropped the fine ring
        // anyway). A file-restored RTC-less clock reads age ≈ uptime and
        // stays under grace, exactly as before v0.40. See historyStore for
        // the shared rationale and the save-cadence-bounded residual.
        const clockCarried = ageMs > uptimeMs() + 60_000;
        const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs && !clockCarried;
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
        if (grace) log(`evidence: host up ${Math.round(uptimeMs() / 1000)}s without proof the clock carried through the outage — loading coarse tier only`);
        else if (fineTooOld) log(`evidence: snapshot is ${Math.round(ageMs / 60000)}m old — fine ring discarded, coarse tier kept`);

        // Coverage metadata.
        if (obj.meta && typeof obj.meta === 'object') {
          for (const [k, v] of Object.entries(obj.meta)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0 || !v || typeof v !== 'object') continue;
            const fm = v as { firstSeenAt?: unknown; samples?: unknown; fresh?: unknown; pa?: unknown; pk?: unknown; ps?: unknown; pe?: unknown; pu?: unknown; pn?: unknown };
            if (typeof fm.firstSeenAt !== 'number') continue;
            const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
            meta.set(id, {
              firstSeenAt: fm.firstSeenAt,
              samples: typeof fm.samples === 'number' ? fm.samples : 0,
              freshSamples: typeof fm.fresh === 'number' ? fm.fresh : 0,
              // Absent in pre-v0.37 files — an older store simply starts these at 0.
              probesAsked: num(fm.pa), probesAnswered: num(fm.pk), probesSelfProven: num(fm.ps),
              // Absent in pre-v0.49.0 files — an older store starts these at 0
              // rather than being rejected, so an upgrade keeps its history.
              probesEchoOnly: num(fm.pe), probesAttribUnknown: num(fm.pu), probesUnheard: num(fm.pn),
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
                s2: cols.s2?.[i] ?? 0,
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
        // Controller noise-floor coarse tier — age-judgment-free history (like the
        // node coarse tier): loaded regardless of grace/staleness, pruned to
        // horizon (skip pruning under grace — the clock is untrusted). Optional
        // key: a pre-tier v2 file simply loads it empty.
        if (obj.controllerCoarse && Array.isArray(obj.controllerCoarse.t0)) {
          const cc = obj.controllerCoarse;
          const cutoff = now() - coarseHorizonMs;
          const ring: CtrlCoarseBucket[] = [];
          for (let i = 0; i < cc.t0.length; i++) {
            const t0 = cc.t0[i];
            if (typeof t0 !== 'number' || !Number.isFinite(t0)) continue;
            if (!grace && t0 < cutoff) continue;
            ring.push({
              t0,
              floorN: cc.fN?.[i] ?? 0,
              floorSum: cc.fS?.[i] ?? 0,
              floorMin: numOrNull(cc.fMin?.[i]),
              floorMax: numOrNull(cc.fMax?.[i]),
            });
          }
          if (ring.length > 0) ctrlCoarse.push(...normalizeCtrlCoarse(ring));
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
                dS2Resync: typeof cols.dS2?.[i] === 'number' ? cols.dS2[i] : null,
                fresh: cols.fr?.[i] === 1,
                rtt: numOrNull(cols.rtt?.[i]),
                rssi: numOrNull(cols.rssi?.[i]),
                rateKbps: numOrNull(cols.rate?.[i]),
                routeKey: typeof cols.rk?.[i] === 'string' ? cols.rk[i] : null,
                status: typeof st === 'number' && st >= 0 && st <= 4 ? (st as NodeStatus) : NodeStatus.Unknown,
                lastSeen: numOrNull(cols.ls?.[i]),
                isListening: cols.il?.[i] == null ? null : cols.il[i] === 1,
                isFrequentListening: cols.ifl?.[i] == null ? null : cols.ifl[i] === 1,
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
          const cols: FineCols = { t: [], dTx: [], dTo: [], dDr: [], dRx: [], dF: [], dRC: [], dS2: [], fr: [], rtt: [], rssi: [], rate: [], rk: [], st: [], ls: [], il: [], ifl: [] };
          for (const s of ring.slice(-maxSamples)) {
            cols.t.push(s.t);
            cols.dTx.push(s.dTx);
            cols.dTo.push(s.dTimeout);
            cols.dDr.push(s.dDropTx);
            cols.dRx.push(s.dRx);
            cols.dF.push(s.dFlaps);
            cols.dRC.push(s.dRouteChanges);
            cols.dS2!.push(s.dS2Resync);
            cols.fr.push(s.fresh ? 1 : 0);
            cols.rtt.push(s.rtt);
            cols.rssi.push(s.rssi);
            cols.rate.push(s.rateKbps);
            cols.rk.push(s.routeKey);
            cols.st.push(s.status);
            cols.ls.push(s.lastSeen);
            cols.il.push(s.isListening == null ? null : s.isListening ? 1 : 0);
            cols.ifl.push(s.isFrequentListening == null ? null : s.isFrequentListening ? 1 : 0);
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
          const cols: CoarseCols = { t0: [], n: [], fN: [], iW: [], dTx: [], dTo: [], dDr: [], dRx: [], fl: [], rc: [], s2: [], rN: [], rS: [], rMin: [], rMax: [], ttN: [], ttS: [], rate: [] };
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
            cols.s2!.push(b.s2);
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
        // Controller noise-floor coarse tier — pruned to horizon at save time
        // (mirrors the node coarse tier); empty buckets are omitted.
        let controllerCoarse: CtrlCoarseCols | null = null;
        const keepCtrl = ctrlCoarse.filter((b) => b.floorN > 0 && b.t0 >= now() - coarseHorizonMs);
        if (keepCtrl.length > 0) {
          controllerCoarse = { t0: [], fN: [], fS: [], fMin: [], fMax: [] };
          for (const b of keepCtrl) {
            controllerCoarse.t0.push(b.t0);
            controllerCoarse.fN.push(b.floorN);
            controllerCoarse.fS.push(b.floorSum);
            controllerCoarse.fMin.push(b.floorMin);
            controllerCoarse.fMax.push(b.floorMax);
          }
        }
        const rf: Persisted['routeFails'] = {};
        for (const [id, ring] of routeFails) {
          if (ring.length === 0) continue;
          rf[String(id)] = { t: ring.map((x) => x.t), a: ring.map((x) => x.between[0]), b: ring.map((x) => x.between[1]) };
        }
        const metaOut: Persisted['meta'] = {};
        for (const [id, m] of meta) {
          metaOut[String(id)] = { firstSeenAt: m.firstSeenAt, samples: m.samples, fresh: m.freshSamples, pa: m.probesAsked, pk: m.probesAnswered, ps: m.probesSelfProven, pe: m.probesEchoOnly, pu: m.probesAttribUnknown, pn: m.probesUnheard };
        }
        const payload: Persisted = {
          v: SCHEMA_V,
          savedAt: now(),
          homeId,
          recordingSince: since,
          nodes,
          coarse: coarseOut,
          controller,
          controllerCoarse,
          routeFails: rf,
          meta: metaOut,
        };
        writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        renameSync(tmp, path);
        dirty = false;
      } catch (e) {
        (log.error ?? log)(`evidence: save failed (${(e as Error).message})`);
      }
    },

    reset(): void {
      fine.clear();
      coarse.clear();
      ctrlRing.length = 0;
      ctrlCoarse.length = 0;
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
