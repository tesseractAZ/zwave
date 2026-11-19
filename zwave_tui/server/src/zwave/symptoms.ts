/**
 * Symptom engine (M3, DESIGN.md §3.3) — pure functions that turn evidence +
 * baselines into ranked, provenance-carrying symptoms. Advisory-first: this
 * module only DESCRIBES what it sees; it never acts.
 *
 * Structure (from the design review):
 *  - Every detector always COMPUTES; dwell accumulates continuously and is never
 *    reset by another symptom (detection ≠ advice).
 *  - A correlation LADDER classifies mesh-level events by evidence strength —
 *    controller-degraded > flooding > interference(residual) — and demotes (not
 *    deletes) per-node symptoms under an active mesh event via `subsumedBy`.
 *  - Each symptom carries `basis` (measured vs inferred) so the UI never renders
 *    an inference in the same voice as a measurement.
 *
 * The dwell state that must persist across ticks lives in a caller-owned
 * `SymptomState` map (so this module stays pure); `detectSymptoms` reads and
 * updates it and returns the current symptom list.
 */

import type { SleeperWatch } from './missedReport';
import { repeatsFrames, type Burst } from './repeatedFrames';
import type { NodeSnapshot, ControllerSnapshot, NodeStatus } from '../types';
import { NodeStatus as NS } from '../types';
import { rawRttFrames, type EvidenceSample, type CoarseBucket, type ControllerSample, type NodeCoverage, type RateRun, type RttSeed, type RttFrame } from './evidenceStore';
import type { BaselineStore, ContNormal } from './baselines';
import { medianNoiseFloor, DEFAULT_NOISE_FLOOR } from './health';

export type SymptomKind =
  | 'return-path-degraded'
  | 'chronic-return-path'
  | 'dead-flap'
  /**
   * A mains/listening node the driver has marked Dead, past a dwell (v0.37).
   *
   * Distinct from `dead-flap`, which needs three Alive↔Dead transitions and so
   * only ever fires on a node that is oscillating. The ordinary outage — node
   * dies, stays dead, is probed, comes back — produces one or two transitions
   * and was therefore invisible to this engine entirely: the symptom list never
   * mentioned it, and the M5 ledger never opened an episode, which meant
   * auto-ping's own efficacy against deadness could never accrue a single data
   * point. That is a strange gap for the one action allowed to run without a
   * human, whose autonomy this file justifies on the grounds that it
   * instruments itself.
   *
   * Also distinct from `quiet-node`, which is about SILENCE past a cadence on a
   * node that still reads Alive. Deadness is a driver verdict; silence is not.
   */
  | 'node-down'
  /**
   * A mains node that has not been HEARD FROM in far longer than the liveness
   * sweep's own cadence (v0.38) — reserved in DESIGN §3.3 and unemitted until
   * now, the last of the declared-but-unreachable kinds this cycle cleared.
   *
   * Distinct from `node-down`, which is the driver's own verdict after a failed
   * transmission. This fires EARLIER and from the opposite direction: the sweep
   * asks every listening node every `staleMs`, and an answered probe refreshes
   * `lastSeen`. So a mains node whose `lastSeen` has aged past several sweep
   * cadences means the probes are not landing — while the driver, which only
   * marks Dead REACTIVELY, still reports it Alive. That gap is the window in
   * which a node is already unreachable and nothing has said so yet.
   *
   * Gated on `isListening === true`: a battery or FLiRS device is silent
   * between wakeups by design, and calling that a symptom would make every
   * sleeping sensor a standing alert.
   */
  | 'quiet-node'
  /**
   * A SLEEPING node silent past the report interval it declares (v0.73.0):
   * its Wake Up interval, or a Configuration parameter labelled as a
   * heartbeat, read from the driver's value DB. `watch` past 1.5 intervals,
   * `warn` past 2.5, with one more interval when the silence spans the
   * controller's nightly radio-off (see missedReport.ts). The sleeping
   * counterpart of `quiet-node`; nothing is learned from traffic, so a device
   * that declares no interval is never watched.
   */
  | 'missed-report'
  /**
   * A node that keeps repeating its frames (v0.74.0): the driver dropped its S2
   * frames as duplicates in bursts, because the node did not hear the
   * controller's acknowledgement. The link works one way. `watch` while it has
   * had two bursts in 24 h, or one large one (see repeatedFrames.ts).
   */
  | 'repeated-frames'
  | 'rate-fallback'
  | 'route-churn'
  | 's2-desync'
  | 'rtt-degraded'
  | 'weak-signal'
  | 'chatty-device'
  | 'ghost-suspect'
  | 'controller-degraded'
  | 'edge-cluster'
  | 'mesh-interference';

export type Severity = 'watch' | 'warn' | 'crit';

export interface EvidenceRef {
  label: string;
  value: string;
}

export interface Symptom {
  kind: SymptomKind;
  nodeId: number | null; // null = mesh/controller-scoped
  severity: Severity;
  sinceMs: number; // dwell start (epoch ms)
  basis: 'measured' | 'inferred';
  evidence: EvidenceRef[];
  narrative: string;
  /** id of an active mesh-level event this per-node symptom is demoted under. */
  subsumedBy?: string;
  /** For a multi-node symptom (edge-cluster): the affected member node ids.
   *  `nodeId` is then the SHARED node they depend on (the suspect), not a member. */
  members?: number[];
  /** Emitted from a HELD reading (v0.79.1: an rtt-degraded breach between
   *  sweeps). It keeps an episode that is already open alive and is shown, but
   *  never opens one: there is no new evidence to open it on. */
  held?: true;
}

/** Caller-owned dwell state — one entry per (nodeId,kind) currently breaching.
 *  `hits` counts EVALUABLE breaching observations (not wall-clock ticks) so a
 *  "chronic" verdict means the badness was actually seen repeatedly, never just
 *  "first seen N days ago with an unknown quiet middle" (v0.14 review). */
export interface DwellEntry {
  since: number;
  lastSeen: number;
  hits: number;
  /** A matured symptom HELD through a dark lane (v0.76.0: s2-desync). It is not
   *  emitted while held, but stays live for the episode lifecycle and the
   *  activity log, and its 30-min window is judged on recency alone until no
   *  unseen sample is left in it. */
  held?: true;
  /** rtt-degraded (v0.79.1): the newest fresh reading of a MATURED breach —
   *  the average, what was judged against the line after the restart
   *  allowance, its time, and the two newest raw round trips — kept so the
   *  breach can be held and shown through the silence between sweeps, which
   *  outlasts the fine ring. */
  rtt?: { avg: number; judged: number; residue: number; t: number; raw: number[] };
  /** rtt-degraded (v0.79.2): the time of a round trip that would end the hold
   *  and is waiting for its confirmation probe — a normal one with no normal
   *  one behind it, or a slow one read across a route change. While it waits,
   *  silence does not hold the breach. */
  rttDoubt?: number;
}
export type SymptomState = Map<string, DwellEntry>;

export interface DetectInput {
  now: number;
  nodes: NodeSnapshot[];
  controller: ControllerSnapshot | null;
  baselines: BaselineStore;
  /** Latest fine sample per node (newest). */
  latest: (nodeId: number) => EvidenceSample | undefined;
  /** Recent fine ring per node (for windowed rates + flaps). */
  recent: (nodeId: number) => EvidenceSample[];
  coarse: (nodeId: number) => CoarseBucket[];
  controllerSamples: () => ControllerSample[];
  coverage: (nodeId: number) => NodeCoverage | null;
  /** The node's per-route rate run (v0.64.6) — what that route has carried in
   *  acknowledged transmissions, kept by the store so it outlives the fine
   *  window a sweep-only node's next transmission does not arrive inside. */
  rateRun: (nodeId: number) => RateRun | null;
  /** The first fresh RTT reading of the driver's current lifetime (v0.77.1),
   *  which bounds what the restart burst can still add to the average. */
  rttSeed: (nodeId: number) => RttSeed | null;
  /** Whether a one-probe confirmation can ever reach this node (v0.78.0): a
   *  ping candidate on an install whose auto-ping runner exists. Where none can,
   *  rtt-degraded starts on the newest round trip alone. Absent reads as no. */
  rttConfirmable?: (node: NodeSnapshot) => boolean;
  /** Told when the average breaches on ONE slow round trip that nothing backs
   *  yet, on a node a confirmation can reach (v0.78.0). The caller decides
   *  whether a probe may be owed for it; the detector only says so. */
  rttSuspect?: (nodeId: number, frame: RttFrame) => void;
  /** Told on every tick a node's RTT average is over the line, started or not
   *  (v0.78.0). Until then the average alone armed the dwell, and arming is
   *  what kept such a reading out of the baseline; the caller now holds it out
   *  on this. Absent, nothing is told. */
  rttOverLine?: (nodeId: number) => void;
  /** The CONFIGURED liveness-sweep cadence in ms (v0.63.0), or undefined when
   *  the sweep is off. quiet-node's dwell is derived from this rather than from
   *  the default the constant was written against — on an install that
   *  lengthened the cadence, the detector fired before one sweep had asked. */
  sweepMs?: number;
  /** Store-level: epoch ms evidence collection began (coverage floor). */
  recordingSince: () => number | null;
  /** A sleeping node's missed-report watch status, or null for a node that
   *  does not sleep (v0.73.0). */
  sleeperWatch: (node: NodeSnapshot) => SleeperWatch | null;
  /** The node's duplicate-frame bursts in the last 24 h (v0.74.0). */
  duplicateBursts: (nodeId: number) => Burst[];
  // No `hasRealNoise` (removed v0.75.2): whether the floor is measured is read
  // from `controller.backgroundRSSI` by the same rule that computes it.
}

// ── Tunables (documented; ship as constants — shareability rule) ─────────────
export const DWELL_MS = 5 * 60_000; // a breach must persist 5 min to surface
/**
 * Counted below-100k readings on one route before rate-fallback may arm
 * (v0.64.6). One is a single-exchange retry, which DESIGN §3.3 names as a
 * confound: on the reference mesh every onset through v0.64.5 was one sweep
 * ping going out at 40 kbit/s with 3 routing attempts, and the next frame was
 * back at 100k. What counts as a reading is decided in evidenceStore.foldRateRun.
 */
const RATE_FALLBACK_MIN_TX = 2;
/**
 * Silence past which a MAINS node is a `quiet-node` (v0.38).
 *
 * Deliberately several times the liveness sweep's default cadence (120 min), so
 * this only fires once at least two sweeps have asked and produced nothing —
 * one unanswered probe is ordinary transient loss, measured at ~2 % on the
 * reference mesh, and would make this a nightly false alarm.
 */
const QUIET_MS = 6 * 60 * 60_000;
/**
 * The multiple of the sweep cadence this dwell represents (v0.63.0).
 *
 * `QUIET_MS` was a hardcoded 6 h chosen as "several times the liveness sweep's
 * DEFAULT cadence (120 min)" — but the cadence is configurable, and on an
 * install that lengthened it this detector fired before even one sweep had
 * asked, which is precisely the false alarm the constant exists to prevent.
 * Derived from the live config instead, with the old value as the floor so no
 * existing install becomes MORE trigger-happy.
 */
const QUIET_SWEEPS = 3;
export const WINDOW_MS = 10 * 60_000; // windowed-rate lookback
const MIN_WINDOW_TX = 20; // minimum successful sends for a rate to be meaningful
const TIMEOUT_RATE_ABS = 0.15; // chronic absolute threshold (health-check rubric)
const TIMEOUT_RATE_MULT = 3; // relative: window rate ≫ this × baseline
export const CHRONIC_DAYS_MS = 2 * 24 * 60_000 * 60; // 2 days sustained → chronic
const RTT_Z = 4; // z-score over route-stratified baseline
/**
 * The fixed RTT ceiling (v0.79.0): a raw round trip over it is slow on any
 * route, so it needs no learned normal to be called slow.
 *
 * WHY A CEILING AT ALL. The learned normal is route-stratified: `baselines.ts`
 * empties a node's RTT bands on every route change, and a band needs about 23
 * fresh readings to graduate — about 12 days for a node that only the 2-hourly
 * sweep talks to. A node that re-routes even once a week therefore never has a
 * normal, and the routed nodes, the ones most likely to degrade, re-route
 * most. On the reference mesh (2026-11-13) 23 of 38 nodes had no graduated RTT
 * band at all. The nodes that slow down are the ones that re-route, so a
 * slowdown tends to arrive with no yardstick. In the days that followed, mains
 * nodes with no graduated band ran 370–880 ms round trips with no verdict, one
 * of them 880 and then 837 ms on consecutive readings.
 *
 * WHY 300 ms. Every graduated line on that mesh was 57–124 ms (median + 4
 * scales), so the ceiling sits more than twice over the highest. Over 14 days
 * of the coarse tier, none of the nine nodes that held one direct route and a
 * graduated normal throughout had two consecutive round trips over 250 ms.
 * Replayed over the same 14 days under the rule below (average over the line,
 * two round trips over it), the ceiling starts 37 breaches on 10 mains nodes,
 * among them a slowdown of 378–525 ms round trips on six consecutive sweeps
 * that no learned line was there to see. A slowdown under the ceiling on a
 * node with no normal is still not flagged: this catches the severe ones.
 *
 * The same start rule applies as against a learned line: the AVERAGE must be
 * over the ceiling, and the two newest raw round trips too. From a 30 ms
 * average that takes several slow round trips in a row (two at 880 and 837 ms,
 * three at 525 ms, five at 400 ms). One frame over about 1.1 s lifts the
 * average over on its own, but it cannot start a breach: the pair rule asks
 * for a confirmation probe, and the probe's answer must be slow too.
 *
 * It applies only where a confirmation probe can reach the node (a mains
 * ping candidate): a sleeping or FLiRS node's round trips can include its
 * wake-up, and the two-round-trip start rule needs the probe to pair them.
 */
export const RTT_CEILING_MS = 300;

/**
 * How far past the sweep's cadence a MATURED rtt-degraded breach is held when
 * no fresh reading is left in the window (v0.79.1).
 *
 * RTT is a level, read only when something talks to the node. On a node only
 * the sweep talks to, the breach's last reading leaves the 10-minute window
 * long before the next one arrives. Until v0.79.1 that cleared the symptom as
 * if the node had recovered: the episode's confirmation burst then found it
 * still slow, a new breach started, and one slowdown became an episode about
 * every 27 minutes, 10 probes each. On the reference mesh one 4.75-hour
 * slowdown became 10 episodes and 113 probes, and the symptom read absent for
 * 43 % of it.
 *
 * Held, the breach stands on its last slow round trip. The hold ends at the
 * configured sweep cadence plus this margin after that round trip; a newer
 * round trip decides it sooner, and the breach lets go as before. A read that
 * comes after the deadline (a pause, a probe hold, a long sweep queue) finds it
 * let go, and the pair rule starts it again. With the sweep off, or on a node
 * no probe can reach, nothing is held.
 */
export const RTT_HOLD_MARGIN_MS = 30 * 60_000;

/**
 * How long a node no probe can reach must read Dead before node-down (v0.79.2).
 *
 * A FLiRS or sleeping node answers on its own schedule. The driver marks it
 * Dead when its own attempt to reach it fails — on the reference mesh, at the
 * driver's start — and it clears at the node's next report: one FLiRS motion
 * sensor read Dead after each of four driver restarts in eight days and came
 * back 13, 38, 46 and 48 minutes later, another once for 9 minutes, and each
 * time node-down raised a critical card and the degraded alarm. The dead-node
 * ladder never probes such a node, so nothing is lost by waiting.
 */
export const NODE_DOWN_UNREACHABLE_DWELL_MS = 90 * 60_000;

/**
 * The line an RTT reading is judged against (v0.79.0), and where it came from.
 *  - `learned`: the band's median + RTT_Z scales.
 *  - `capped`: that learned line was over RTT_CEILING_MS, so the ceiling is
 *    the line (a band can graduate while the node is already slow).
 *  - `ceiling`: the current time-of-day band has not graduated, so the
 *    ceiling alone is the line.
 */
export interface RttYardstick {
  line: number;
  basis: 'learned' | 'capped' | 'ceiling';
}

/**
 * Pick the line for one node (v0.79.0). `norm` is the node's RTT normal for the
 * current time-of-day band (null when the store has never seen the node), and
 * `confirmable` whether a confirmation probe can reach it. Null means the node
 * is not judged at all: no graduated band, and no probe to pair a ceiling
 * breach with.
 *
 * One definition, used by the detector, the engine's coverage count and the
 * DETAIL row, so the three cannot disagree about which nodes are judged.
 */
export function rttYardstick(norm: ContNormal | null, confirmable: boolean): RttYardstick | null {
  if (norm?.ready) {
    const learned = norm.median + RTT_Z * norm.scale;
    // Equal is not over: only a line strictly above the ceiling is capped. A
    // node no probe can reach keeps its learned line, since nothing could pair
    // a ceiling breach for it.
    return confirmable && learned > RTT_CEILING_MS
      ? { line: RTT_CEILING_MS, basis: 'capped' }
      : { line: learned, basis: 'learned' };
  }
  return confirmable ? { line: RTT_CEILING_MS, basis: 'ceiling' } : null;
}
/**
 * The highest first-after-restart RTT the fixed half of `rttRestartResidue`
 * allows for (v0.77.1). The highest restart-seeded reading in the reference
 * mesh's 14-day store, across four driver restarts (10-16..10-26), was about
 * 1.39 s (node 63, rebuilt from a two-reading 30-min bucket and the decay that
 * followed it), and 2 s is the RTT histogram's top finite edge.
 */
export const RTT_SEED_MAX_MS = 2000;

/**
 * How far above `median` a node's RTT average can still be pushed by what the
 * driver measured right after it started (v0.77.1).
 *
 * The average lives in driver memory only, so every restart re-seeds it with
 * one measurement taken inside the restart's own burst, and each acknowledged
 * transmission after that keeps 0.75 of it (the source is cited at
 * evidenceStore.rawRttOf). With `commandsTX` measurements in the average the seed
 * still weighs 0.75^(commandsTX − 1), so a seed of at most RTT_SEED_MAX_MS adds
 * at most 0.75^(commandsTX − 1) × (RTT_SEED_MAX_MS − median).
 *
 * When the store holds the first fresh reading of this lifetime (`seed`: the
 * average `a0` at `k0` transmissions), everything measured up to it adds
 * exactly 0.75^(commandsTX − k0) × (a0 − median), and the smaller of the two is
 * used. Most nodes' first reading after a restart is already normal (27–33 of
 * 38 per restart on the reference mesh), so their allowance is gone within a
 * few transmissions. The store carries the seed over an add-on restart
 * (v0.77.3); when it cannot, `a0` is the first reading after that restart,
 * whose excess this then allows for at that reading, up to the ceiling — all
 * of it while the lifetime is young.
 *
 * On the reference mesh the large seeds were about 0.7–1.4 s on nodes that sit
 * at 20–60 ms and decayed along that curve (node 63 after the 10-24 restart:
 * about 1390 → 1046 → 798 → 612 → … → 65 ms by its 17th reading). Every fresh
 * stats event from such a quiet node re-tripped rtt-degraded for hours: nine
 * 5–8 min blips in the 5 h after that restart, against 1–7 symptom onsets a
 * day before.
 *
 * No transmission yet in this lifetime (commandsTX 0, which is also what a node
 * with no statistics reads) means no measurement for the seed to be in, so no
 * allowance: a reading still held from before the restart is not this
 * lifetime's.
 */
export function rttRestartResidue(commandsTX: number, median: number, seed?: RttSeed | null): number {
  if (!Number.isFinite(commandsTX) || commandsTX < 1) return 0;
  const k = Math.floor(commandsTX);
  const ceiling = 0.75 ** (k - 1) * Math.max(0, RTT_SEED_MAX_MS - median);
  if (!seed || seed.k0 > k) return ceiling;
  return Math.min(ceiling, 0.75 ** (k - seed.k0) * Math.max(0, seed.a0 - median));
}

/**
 * What the RTT baseline fold holds a reading `rtt` back on (v0.77.3): the
 * restart residue against the band's median, or, when the band has learned
 * nothing, against the node's own average since the seed. The detector
 * (v0.79.0) takes this allowance for a graduated band, where it is exactly
 * `rttRestartResidue` against that band's median, and for an empty one. For a
 * band that has not graduated it passes no normal, so the seed is measured
 * against the average since the seed even where this fold uses the median.
 *
 * A band with any data has a median of at least 5 ms (the first bin's centre);
 * an empty one reports 0. A route change empties every band of a node, so a
 * re-routed node measured against 0 had its whole round trip counted as
 * restart and a normal reading held until 0.75^(commandsTX − k0) × a0 fell
 * under 8 ms (live 10-28: four of 38 nodes held for that alone). An empty band
 * is never ready, so this only ever cost learning.
 *
 * Instead: with r = 0.75^(commandsTX − k0), the average is r × a0 plus (1 − r)
 * × the weighted mean of what the driver measured after the seed, so that mean
 * is (rtt − r × a0) / (1 − r), free of everything measured up to k0. Against it
 * the seed's share of `rtt` is exactly rtt − mean: about zero for a node whose
 * seed was normal, the decaying excess for one whose seed was not. At the seed
 * reading itself nothing has been measured since, and a node with no seed has
 * nothing to measure it against, so both are held against 0 while the restart
 * can still be in them.
 *
 * Like the bound itself, this takes the reading's count and average to be from
 * the same statistics event, with one measurement per transmission. A sample
 * that caught commandsTX moved ahead of the average (the settle rule keeps most
 * out) reads the seed as the node's own average and lets one reading into an
 * empty band; the old measure against 0 held it.
 */
export function rttFoldResidue(commandsTX: number, rtt: number, norm: { median: number } | null, seed: RttSeed | null): number {
  if (norm != null && norm.median > 0) return rttRestartResidue(commandsTX, norm.median, seed);
  if (!seed || Math.floor(commandsTX) <= seed.k0) return rttRestartResidue(commandsTX, 0, seed);
  const r = 0.75 ** (Math.floor(commandsTX) - seed.k0);
  return rttRestartResidue(commandsTX, (rtt - r * seed.a0) / (1 - r), seed);
}
const WEAK_MARGIN_DB = 7; // direct-node weak-signal margin
const WEAK_TIMEOUT_RATE = 0.05; // weak-signal corroboration on a MEASURED window (≥ MIN_WINDOW_TX sends)
// weak-signal corroboration on an UNMEASURED window: a delivery-failure EVENT this recent.
// = MAX_DETECTOR_WINDOW_MS in evidenceStore, so the fine ring is guaranteed to hold it.
export const WEAK_EVENT_LOOKBACK_MS = 30 * 60_000;
const FLAPS_WINDOW = 3; // ≥3 Alive↔Dead transitions in the window
// Route churn: the mesh re-deciding how to reach a node. A single change is
// normal (that IS the mesh healing); repeated changes inside one window mean it
// cannot settle. Set above FLAPS_WINDOW because a route change is a cheaper,
// more common event than a Dead transition — 2 would fire on healthy re-routing.
const ROUTE_CHURN_WINDOW = 4; // ≥4 LWR changes in the window
const S2_WINDOW_MS = 30 * 60_000; // S2 SPAN-resync lookback (sparser than counters)
const S2_ABS = 12; // resyncs in the window before it is a symptom (occasional resync is normal S2)
const S2_WARN_MULT = 3; // 3× the threshold escalates watch → warn
// Recency conjunct = DWELL_MS, deliberately: a recency window LONGER than the
// dwell recreates the illusory-dwell flaw in miniature (a burst stays "recent"
// past the dwell and matures anyway). An ongoing storm at ≥12/30m has events
// in any 5-min slice; one that pauses longer has, for now, stopped.
const S2_RECENT_MS = DWELL_MS;
const RX_FLOOD_MULT = 20; // dRx rate orders-of-magnitude over the mesh median
const GHOST_MIN_COVERAGE_MS = 3 * 24 * 60_000 * 60; // ≥3 days observed, zero comms
const CTRL_DEGRADED_ABS = 5; // controller NAK+CAN+timeoutACK per window
const MESH_ACTIVE_FRACTION = 0.35; // fire: ≥35% of ACTIVE nodes degraded
const MESH_RELEASE_FRACTION = 0.2; // hold: stays active until it dips below this (hysteresis)
const MESH_MIN_ACTIVE = 8; // never call it "mesh-wide" on a handful of active nodes
const MESH_MIN_DEGRADED = 3; // and never on a coincidental pair
const CHRONIC_MIN_HITS = 400; // evaluable-bad observations before "chronic" (≫ wall-clock alone)
const EDGE_MIN_MEMBERS = 2; // a shared-repeater cluster needs ≥2 degrading dependents (a single is a per-node symptom)
const EDGE_SUFFIX = ':edge-cluster'; // dwell-key suffix for edge-cluster (for stale-key cleanup)

function key(nodeId: number | null, kind: SymptomKind): string {
  return `${nodeId ?? 'mesh'}:${kind}`;
}

/** Update dwell for a (node,kind) breach; return the dwell-start once it has
 *  persisted ≥ DWELL_MS, else null (still arming). Clears when not breaching. */
function dwell(state: SymptomState, k: string, breaching: boolean, now: number, dwellMs = DWELL_MS): number | null {
  if (!breaching) {
    state.delete(k);
    return null;
  }
  const e = state.get(k);
  if (!e) {
    state.set(k, { since: now, lastSeen: now, hits: 1 });
    return null;
  }
  e.lastSeen = now;
  e.hits += 1;
  return now - e.since >= dwellMs ? e.since : null;
}

/** Whether a round trip was read across a route change (v0.79.2): the sample
 *  that carried it, or the next one (the trailing statistics emit carries the
 *  route), reported one. */
function routeChangedOn(samples: EvidenceSample[], t: number): boolean {
  return samples.some((s) => s.t >= t && s.t - t <= ROUTE_READ_SPAN_MS && (s.dRouteChanges ?? 0) > 0);
}
const ROUTE_READ_SPAN_MS = 15_000;

/** The newest sample within the window that is FRESH and has a usable value —
 *  so a dwell gated on a per-tick freshness flag isn't reset every non-fresh
 *  tick (v0.14 review: rtt/weak-signal almost never matured). */
function latestFresh<T>(samples: EvidenceSample[], now: number, pick: (s: EvidenceSample) => T | null, windowMs = WINDOW_MS): T | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (now - s.t > windowMs) break;
    if (!s.fresh) continue;
    const v = pick(s);
    if (v != null) return v;
  }
  return null;
}

/** Windowed timeout rate over a node's recent fine ring — Σtimeout/Σtx across
 *  valid windows, null when traffic is below the meaningfulness floor. */
export function windowTimeoutRate(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): { rate: number; tx: number } | null {
  let tx = 0;
  let to = 0;
  for (const s of samples) {
    if (now - s.t > windowMs) continue;
    if (s.dTx == null || s.dTimeout == null) continue; // invalid window
    tx += s.dTx;
    to += s.dTimeout;
  }
  if (tx < MIN_WINDOW_TX) return null;
  return { rate: to / tx, tx };
}

/** Count Alive↔Dead flap transitions in the window (event-driven dFlaps). */
function windowFlaps(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): number {
  let f = 0;
  for (const s of samples) if (now - s.t <= windowMs) f += s.dFlaps;
  return f;
}

/** Windowed LWR route-change count — the `dRouteChanges` event-accumulator
 *  drain, summed the same way windowFlaps sums `dFlaps`. */
function windowRouteChanges(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): number {
  let r = 0;
  for (const s of samples) if (now - s.t <= windowMs) r += s.dRouteChanges;
  return r;
}

/** Windowed S2 SPAN-resync count. `null` samples mean the log lane was NOT
 *  listening — they are skipped, and a window with no listening sample at all
 *  yields `null` (unknown) rather than 0, so a dormant lane can never look
 *  like a clean one. */
function windowS2(samples: EvidenceSample[], now: number, windowMs = S2_WINDOW_MS): number | null {
  let n = 0;
  let known = 0;
  for (const s of samples) {
    if (now - s.t > windowMs || s.dS2Resync == null) continue;
    n += s.dS2Resync;
    known += 1;
  }
  return known > 0 ? n : null;
}

/** RECENCY CONJUNCT (v0.26, assessment fix): a windowed breach must also show
 *  evidence inside the recent sub-window, or it de-asserts. Without this, the
 *  lookback (10–30 min) outlives the 5-min dwell, so ONE transient burst stays
 *  "breaching" for the whole lookback and matures a "persistent" symptom off
 *  evidence that already stopped — the dwell was armed by the calendar, not by
 *  the mesh. */
function hadRecent(samples: EvidenceSample[], now: number, recentMs: number, pick: (s: EvidenceSample) => number): boolean {
  for (const s of samples) if (now - s.t <= recentMs && pick(s) > 0) return true;
  return false;
}

/** Windowed dRx rate (reports/min) — for chatty-device detection. */
function windowRxRate(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): number | null {
  let rx = 0;
  let spanMs = 0;
  let first: number | null = null;
  for (const s of samples) {
    if (now - s.t > windowMs) continue;
    if (s.dRx == null) continue;
    rx += s.dRx;
    if (first == null) first = s.t;
    spanMs = s.t - first;
  }
  if (spanMs < 60_000) return null;
  return rx / (spanMs / 60_000);
}

const RATE_LABEL: Record<number, string> = { 1: '9.6k', 2: '40k', 3: '100k', 4: 'LR-100k' };

/** Poisson upper-tail-ish anomaly: is observing ≥ `obs` events surprising under
 *  expected `exp`? Cheap proxy: obs beyond exp by ≥ mult× and ≥ a floor margin. */
function rateAnomalous(windowRate: number, baseRate: number, mult: number): boolean {
  // Guard the near-zero baseline: require an absolute floor too so a baseline of
  // 0.001 doesn't make 0.01 "10× anomalous".
  return windowRate >= Math.max(baseRate * mult, TIMEOUT_RATE_ABS * 0.5) && windowRate > baseRate + 0.02;
}

/**
 * The main entry point. Returns the current symptom list (dwell-gated) and
 * mutates `state` for the next tick. Pure w.r.t. the inputs otherwise.
 */
export function detectSymptoms(input: DetectInput, state: SymptomState): Symptom[] {
  const { now, nodes, baselines } = input;
  const out: Symptom[] = [];
  // Correlation-gate substrate: RAW (pre-dwell) per-node RF degradation, so the
  // mesh gate has its OWN dwell decoupled from per-node dwell (design review:
  // detection ≠ advice; the gate must not wait two stacked dwells to fire).
  const degradingNow = new Map<number, boolean>();
  const markDegrading = (id: number, cond: boolean): void => {
    if (cond) degradingNow.set(id, true);
  };

  // ── controller-degraded (deterministic serial-link evidence) ──────────────
  let controllerEvent: string | null = null;
  {
    const cs = input.controllerSamples();
    const recent = cs.filter((s) => now - s.t <= WINDOW_MS && s.fresh);
    let nak = 0;
    let can = 0;
    let tack = 0;
    let any = false;
    for (const s of recent) {
      if (s.dNak != null) { nak += s.dNak; any = true; }
      if (s.dCan != null) can += s.dCan;
      if (s.dTimeoutAck != null) tack += s.dTimeoutAck;
    }
    const total = nak + can + tack;
    const breaching = any && total >= CTRL_DEGRADED_ABS;
    const since = dwell(state, key(null, 'controller-degraded'), breaching, now);
    if (since != null) {
      controllerEvent = 'ctrl';
      out.push({
        kind: 'controller-degraded', nodeId: null, severity: total >= CTRL_DEGRADED_ABS * 3 ? 'crit' : 'warn',
        sinceMs: since, basis: 'measured',
        evidence: [{ label: 'serial NAK/CAN/tmoACK', value: `${nak}/${can}/${tack} in 10m` }],
        narrative: 'Controller serial link is struggling (host↔stick). Suspect the stick: USB-2 port + a passive extension cable away from USB-3, or relocate it — not a per-node RF fault.',
      });
    }
  }

  // ── per-node detectors ────────────────────────────────────────────────────
  for (const node of nodes) {
    if (node.isController) continue;
    const id = node.nodeId;
    const samples = input.recent(id);
    const last = input.latest(id);
    let breaching = false;

    // dead-flap — the hard RF-failure event, from the event-driven flap counter.
    {
      const flaps = windowFlaps(samples, now);
      // Recency conjunct: still flapping within the dwell horizon (see hadRecent).
      const b = flaps >= FLAPS_WINDOW && hadRecent(samples, now, DWELL_MS, (s) => s.dFlaps);
      markDegrading(id, b);
      const since = dwell(state, key(id, 'dead-flap'), b, now);
      if (since != null) {
        breaching = true;
        out.push({
          kind: 'dead-flap', nodeId: id, severity: 'crit', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'Alive↔Dead flaps', value: `${flaps} in 10m` }],
          narrative: `${node.name} is flapping between Alive and Dead — a hard link failure. Runbook: ping → power-cycle the device → exclude/re-include. A route rebuild cannot repair a node that can't be reached.`,
        });
      }
    }

    // quiet-node — heard from far past the sweep's cadence (v0.38). The sweep
    // asks every listening node every staleMs and an answered probe refreshes
    // lastSeen, so silence this long means probes are not landing — yet the
    // driver still says Alive, because Dead is set only on a failed
    // transmission it actually attempted.
    {
      const seen = node.stats?.lastSeen ?? null;
      // Mains only, and never for a node already Dead — node-down owns that,
      // and stacking both on one device would be two cards for one fault.
      const eligible = node.isListening === true && node.status !== NS.Dead;
      // A node with NO lastSeen at all is not evidence of silence: it may
      // simply never have been heard from since a restart cleared the roster.
      // Fail closed rather than accuse on absence.
      const quietMs = Math.max(QUIET_MS, (input.sweepMs ?? 0) * QUIET_SWEEPS);
      const b = eligible && seen != null && now - seen >= quietMs;
      const since = dwell(state, key(id, 'quiet-node'), b, now);
      if (since != null) {
        breaching = true;
        const silentH = Math.round(((now - (seen as number)) / 3_600_000) * 10) / 10;
        out.push({
          kind: 'quiet-node', nodeId: id, severity: 'warn', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'last heard', value: `${silentH}h ago` }],
          narrative: `${node.name} is a mains node that has not been heard from in ${silentH}h, far past the liveness sweep's cadence. The driver still reports it Alive because it marks a node Dead only when a transmission it attempted fails. Silence this long on a device that never sleeps is the earlier signal.`,
        });
      }
    }

    // missed-report — a sleeping node silent past its DECLARED report
    // interval (v0.73.0). The decision is missedReport.ts's; this block only
    // dwells it and words it.
    {
      const w = input.sleeperWatch(node);
      const b = w != null && w.severity != null;
      const since = dwell(state, key(id, 'missed-report'), b, now);
      if (since != null && w != null && w.severity != null && w.periodMs != null && w.silentMs != null) {
        breaching = true;
        const periodMin = Math.round(w.periodMs / 60_000);
        const silentMin = Math.round(w.silentMs / 60_000);
        const what = w.source === 'wake-up' ? 'Wake Up interval' : 'heartbeat interval';
        out.push({
          kind: 'missed-report', nodeId: id, severity: w.severity, sinceMs: since, basis: 'measured',
          evidence: [
            { label: 'last heard', value: `${silentMin} min ago` },
            { label: 'declared', value: `${what} ${periodMin} min` },
          ],
          narrative: `${node.name} is a sleeping device that declares a ${what} of ${periodMin} min and has not been heard from in ${silentMin} min.` +
            (w.radioAllowance ? ' One extra interval was allowed because a controller radio-off, or a stretch the driver\'s log stream did not watch, falls inside the silence, and a report sent then can be lost.' : '') +
            ' A battery that has run down, or a device out of range, stops reporting before the driver can mark it Dead.',
        });
      }
    }

    // repeated-frames — a link that works one way (v0.74.0). The bursts are
    // repeatedFrames.ts's; this block dwells and words them.
    {
      const bursts = input.duplicateBursts(id);
      const b = node.status !== NS.Dead && repeatsFrames(bursts);
      const since = dwell(state, key(id, 'repeated-frames'), b, now);
      if (since != null) {
        breaching = true;
        const largest = Math.max(...bursts.map((x) => x.n));
        out.push({
          kind: 'repeated-frames', nodeId: id, severity: 'watch', sinceMs: since, basis: 'measured',
          evidence: [
            { label: 'bursts (24 h)', value: String(bursts.length) },
            { label: 'largest burst', value: `${largest} repeats in 1 min` },
          ],
          narrative: `${node.name} repeated the same frame up to ${largest} times within a minute, ${bursts.length === 1 ? 'once' : `${bursts.length} times`} in the last 24 hours, and the driver dropped the copies as duplicates. A device repeats a frame when it does not hear the controller's acknowledgement, so the controller hears this node but its replies do not reliably reach it: the link works one way. Each burst also crowds the mesh for everyone.`,
        });
      }
    }

    // node-down — the ordinary outage (v0.37). Dead is set REACTIVELY by the
    // driver (only on a failed transmission), so this is a measured verdict
    // about the node, not an inference from silence. Deliberately dwelled
    // SHORTER than auto-ping's probe threshold so the episode is already open
    // when the probe fires and the M5 ledger can attribute it — the whole point
    // of the kind is that the one autonomous action becomes measurable.
    {
      const b = node.status === NS.Dead;
      // NOT markDegrading: a dead node contributes no RF readings, and feeding
      // it to the mesh-correlation gate would let a single dead device look
      // like environmental degradation.
      // A node no probe can reach (FLiRS or sleeping, v0.79.2) dwells for
      // NODE_DOWN_UNREACHABLE_DWELL_MS: the driver marks it Dead when its own
      // attempt fails, after a restart above all, and it clears at the node's
      // next report. The dead-node ladder never probes it, so the short dwell
      // that opens an episode before that probe buys nothing here.
      const since = dwell(state, key(id, 'node-down'), b, now, node.isListening === false ? NODE_DOWN_UNREACHABLE_DWELL_MS : DWELL_MS);
      if (since != null) {
        breaching = true;
        const downFor = Math.max(0, Math.round((now - since) / 60_000));
        out.push({
          kind: 'node-down', nodeId: id, severity: 'crit', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'driver status', value: `Dead for ${downFor}m` }],
          narrative: `${node.name} is marked Dead by the driver — a transmission to it failed and has not since succeeded. Silence alone would not prove this; the status is a measured verdict. A ping often revives a node whose radio is still there.`,
        });
      }
    }

    // s2-desync — S2 SPAN-resync storm (v0.26). Nonce desync surfaces ONLY in
    // route-churn — the mesh cannot settle on a path to this node.
    //
    // v0.30.0: this SymptomKind has existed since the planner was written, with
    // a full remediation card and outcomes handling — but nothing ever emitted
    // it, so the card was unreachable and REMEDY could never surface churn. The
    // evidence was already being collected the whole time: `dRouteChanges` is an
    // event-accumulator drain on every sample, exactly like `dFlaps`.
    //
    // Long-Range nodes are EXCLUDED. They hold one direct link to the controller
    // and have no mesh routes to churn, so a change there is a data quirk — the
    // planner card already says so, and firing on it would make the screen argue
    // with itself.
    if (!node.isLongRange) {
      const churn = windowRouteChanges(samples, now);
      const b = churn >= ROUTE_CHURN_WINDOW && hadRecent(samples, now, DWELL_MS, (x) => x.dRouteChanges);
      markDegrading(id, b);
      const since = dwell(state, key(id, 'route-churn'), b, now);
      if (since != null) {
        breaching = true;
        out.push({
          kind: 'route-churn', nodeId: id, severity: 'warn', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'LWR route changes', value: `${churn} in 10m` }],
          narrative: `${node.name} keeps being re-routed — the mesh cannot settle on a stable path. Usually one intermediate repeater is marginal, or there is intermittent interference on that path. A rebuild re-shuffles the same unstable links and the churn returns.`,
        });
      }
    }

    // driver log events (no statistics counter moves), fed via the driver-ws
    // log listener into the same event-accumulator discipline as flaps. An
    // occasional resync is normal S2 behaviour after a missed frame; a storm
    // means the link is dropping frames faster than the nonce sync can hold —
    // usually marginal RF on a secure link, sometimes a rebooting device.
    // Absolute threshold (like chronic-return-path): resyncs are rare-normal,
    // so a baseline would learn a bad link as "its normal" and never fire.
    {
      const s2 = windowS2(samples, now);
      const k2 = key(id, 's2-desync');
      const e = state.get(k2);
      const recentPos = hadRecent(samples, now, S2_RECENT_MS, (s) => s.dS2Resync ?? 0);
      const recentDark = samples.some((s) => now - s.t <= S2_RECENT_MS && s.dS2Resync == null);
      // The lane goes dark one sample at a time while the known ones age out of
      // the window (v0.76.0: a storm pause, a silent or refused lane, a level
      // below info), so the recent slice turns unseen long before the whole
      // window does. Unseen with no resync in it says nothing either way: a
      // MATURED s2-desync is HELD as it stands — neither cleared (a fresh dwell
      // and a new episode on resume) nor advanced (there is nothing to emit) —
      // and lets go once nothing has breached for a whole window: holds need
      // deadlines. An ARMED one is dropped: maturing on resume from its pre-dark
      // start would be a dwell nobody watched.
      if (s2 == null || (!recentPos && recentDark)) {
        markDegrading(id, false);
        if (e) {
          if (e.lastSeen - e.since < DWELL_MS || now - e.lastSeen > S2_WINDOW_MS) state.delete(k2);
          else e.held = true;
        }
      } else {
        // After a hold, the window's known sum covers only part of it, and a
        // storm that never stopped reads under the threshold: a held key lets go
        // only on a fully seen recent slice with no resync, until no unseen
        // sample is left in the window.
        const unseen = samples.some((s) => now - s.t <= S2_WINDOW_MS && s.dS2Resync == null);
        const carried = e?.held === true && unseen;
        if (e && !unseen) delete e.held;
        const b = recentPos && (carried || s2 >= S2_ABS);
        markDegrading(id, b);
        const since = dwell(state, k2, b, now);
        if (since != null) {
          breaching = true;
          out.push({
            kind: 's2-desync', nodeId: id, severity: s2 >= S2_ABS * S2_WARN_MULT ? 'warn' : 'watch',
            sinceMs: since, basis: 'measured',
            evidence: [{ label: 'S2 SPAN resyncs', value: `${s2} in 30m${unseen ? ' (part of it unseen)' : ''}` }],
            narrative: `${node.name} is repeatedly losing S2 nonce sync — the encrypted link is dropping frames faster than SPAN resynchronisation can hold. Usually marginal RF on a secure link (distance, interference), occasionally a device that keeps rebooting. Fix the link quality; re-interviewing or rebuilding routes does not repair RF.`,
          });
        }
      }
    }

    // return-path-degraded (relative) + chronic-return-path (absolute).
    {
      const w = windowTimeoutRate(samples, now);
      const norm = baselines.timeoutNormal(id, now);
      if (w) {
        // Recency conjunct: a rate whose bad half has scrolled past the dwell
        // horizon (zero timeouts in the last 5 min) is history, not a breach.
        const stillTimingOut = hadRecent(samples, now, DWELL_MS, (s) => s.dTimeout ?? 0);
        const relBreach = (norm?.ready ? rateAnomalous(w.rate, norm.rate, TIMEOUT_RATE_MULT) : false) && stillTimingOut;
        markDegrading(id, relBreach || w.rate >= TIMEOUT_RATE_ABS);
        const since = dwell(state, key(id, 'return-path-degraded'), relBreach, now);
        if (since != null) {
          breaching = true;
          out.push({
            kind: 'return-path-degraded', nodeId: id, severity: w.rate >= TIMEOUT_RATE_ABS ? 'warn' : 'watch',
            sinceMs: since, basis: 'measured',
            evidence: [
              { label: 'timeout rate (10m)', value: `${(w.rate * 100).toFixed(1)}% of ${w.tx} tx` },
              { label: 'own baseline', value: `${((norm?.rate ?? 0) * 100).toFixed(1)}%` },
            ],
            narrative: `${node.name}'s reply-timeout rate is well above its own normal — a return-path problem: the node acknowledges the request but its report is lost. Typical of a marginal link (distance, an RF-hostile wall) rather than a routing-table issue.`,
          });
        }
        // Chronic-absolute: sustained high rate regardless of baseline. Requires
        // both wall-clock age AND repeated EVALUABLE-bad observations (hits), so
        // a node quiet for 2 days then briefly bad is NOT called "chronic since
        // setup" (v0.14 review). The chronic dwell is only advanced on evaluable
        // windows (this `if (w)` block), so hits accrue only when we can see it.
        const chronicBreach = w.rate >= TIMEOUT_RATE_ABS;
        const ck = key(id, 'chronic-return-path');
        const cSince = dwell(state, ck, chronicBreach, now);
        const cHits = state.get(ck)?.hits ?? 0;
        if (cSince != null && now - cSince >= CHRONIC_DAYS_MS && cHits >= CHRONIC_MIN_HITS) {
          breaching = true;
          out.push({
            kind: 'chronic-return-path', nodeId: id, severity: 'warn', sinceMs: cSince, basis: 'measured',
            evidence: [{ label: 'timeout rate (sustained)', value: `${(w.rate * 100).toFixed(1)}% for ${Math.floor((now - cSince) / 86_400_000)}d` }],
            narrative: `${node.name} has been chronically slow to respond for days — bad since it was set up, not a recent change. Consider repeater coverage or relocating the device.`,
          });
        }
      }
    }

    // rate-fallback — a SAME-ROUTE REGRESSION that PERSISTS (v0.64.6). The route
    // the node is on now must have carried an acknowledged transmission at 100k,
    // and at least RATE_FALLBACK_MIN_TX separate acknowledged transmissions since
    // that route's newest 100k reading must have gone below it (DESIGN §3.3:
    // "persistently below 100k"; a single-exchange retry is a confound). A route
    // never seen at 100k is capability, not a fault, and cannot fire (fail-closed;
    // RESEARCH §2.2); a route change starts over with no capability, and a route
    // the driver no longer reports is not asserted as regressed. Through v0.64.5
    // this scanned 30 min of samples for any sub-100k value — but the store copies
    // the cached rate onto every sample, so ONE retried frame matured the symptom
    // on its own and held it ~30 min after the link was back at 100k.
    {
      const run = input.rateRun(id);
      const b = !node.isLongRange && run != null && last?.routeKey === run.routeKey &&
        run.sawHundred && run.belowTx >= RATE_FALLBACK_MIN_TX;
      markDegrading(id, b);
      const since = dwell(state, key(id, 'rate-fallback'), b, now);
      if (since != null) {
        breaching = true;
        // The run's newest reading, not the newest sample: a send cut short by
        // the node's S0 nonce report or S2 SOS nonce report also rewrites the
        // cached rate without being a reading.
        const rate = run?.rateKbps ?? null;
        const proto = rate === 9.6 ? 1 : rate === 40 ? 2 : 0;
        out.push({
          kind: 'rate-fallback', nodeId: id, severity: rate === 9.6 ? 'warn' : 'watch',
          sinceMs: since, basis: 'measured',
          evidence: [{ label: 'negotiated rate', value: RATE_LABEL[proto] ?? `${rate}k` }, { label: 'route', value: last?.routeKey ?? '—' }],
          narrative: `${node.name} regressed below 100 kbps on a route that previously sustained it — a degraded link on that path (not a device whose ceiling is 40k/9.6k, which this detector excludes).`,
        });
      }
    }

    // rtt-degraded — route-stratified median ≫ baseline, or, where the current
    // time-of-day band has not graduated, a fixed ceiling (v0.79.0, `rttYardstick`). Uses the
    // newest FRESH RTT in the window (not `last`), so a non-fresh tick doesn't
    // reset the dwell.
    {
      const norm = baselines.rttNormal(id, now);
      const confirmable = input.rttConfirmable?.(node) === true;
      const yard = rttYardstick(norm, confirmable);
      const obs = latestFresh(samples, now, (s) => (s.rtt != null && s.rtt >= 0 ? { rtt: s.rtt, t: s.t } : null));
      // NO recency conjunct here — RTT is a LEVEL, not an event count.
      //
      // v0.26 briefly added `now - obs.t <= DWELL_MS`, which silently disabled
      // this detector for any node that communicates less often than every
      // 5 minutes: dwell() stamps `since` on the tick the reading lands, so
      // maturing needs `now - since >= DWELL_MS` while the conjunct needs
      // `now - obs.t <= DWELL_MS` — satisfiable only if a SECOND fresh
      // breaching reading arrives inside the same 5 minutes. A battery or
      // low-traffic node reporting every 6-10 min could never fire again.
      //
      // The staleness bound the conjunct was reaching for already exists:
      // latestFresh only scans within WINDOW_MS, so the newest fresh reading
      // is at most 10 min old, and for a level signal the newest reading IS
      // the current best estimate — unlike flaps/timeouts/resyncs, where a
      // count from a burst that has stopped is stale evidence of a past event.
      // That bound applies to STARTING a breach. A matured one outlives the
      // window on its last slow round trip for a bounded time (v0.79.1, the
      // hold below): silence is not a reading, so it cannot end a level.
      //
      // The reading is tested with the restart's seed taken out (v0.77.1): an
      // excess that seed alone could produce is the restart, not the link.
      // Against a GRADUATED band's median (v0.79.0), which is exactly the
      // v0.77.1 allowance. A band that has not graduated is measured against
      // what the driver averaged after the seed instead, even when it holds a
      // few readings: its median is not a yardstick, and the ceiling judges the
      // node. Against 0, or against a few-reading median, a slow node's own
      // slow seed would be allowed for nearly in full, and the ceiling would
      // sleep for hours after every restart. (The baseline fold still
      // uses the median of a band with data; that is a learning question, not
      // a verdict.)
      const residue = obs != null ? rttFoldResidue(node.stats.commandsTX, obs.rtt, norm?.ready ? norm : null, input.rttSeed(id)) : 0;
      const b = !!(yard && obs != null && obs.rtt - residue > yard.line);
      // ONE SLOW ROUND TRIP IS NOT A LEVEL (v0.78.0). The average keeps 0.75 of
      // itself per transmission, so one frame above median + 16 scales lifts it
      // over the line alone, and a larger one keeps it there: a 700 ms frame on
      // 25±8 ms holds it over for six readings, its own and five more.
      // In the 13-day reference archive 14 of 30 rtt-degraded episodes were one
      // such frame, and their verification bursts spent 140 probes on it.
      // A breach therefore STARTS only when the two newest raw round trips in
      // the window are both over the same line; one that nothing backs asks the
      // caller for one confirmation probe. Where no probe can ever reach the
      // node, the newest round trip alone starts it. Once started, the average
      // alone holds it, as before: a level is not re-proven on every frame.
      const rk = key(id, 'rtt-degraded');
      // HELD THROUGH SILENCE (v0.79.1, RTT_HOLD_MARGIN_MS). A matured breach
      // with no fresh reading left in the window stands on its last SLOW round
      // trip, judged against the yardstick of now, for at most the sweep's
      // cadence plus the margin after it, and not on a Dead node (node-down
      // owns that one, and the sweep does not read a Dead node). It is shown,
      // marked held: it keeps its episode open and can open none.
      // Only a slow round trip carries a breach into the hold. The driver's
      // average keeps 0.75 of itself per transmission, so a sweep-only node that
      // has recovered still reads over the line for several sweeps on its
      // average alone, and a hold kept on the average showed such a node as
      // degraded for hours. A newer round trip under the line drops the kept
      // reading, so the next silence clears the breach as before v0.79.1 and its
      // closing burst measures the node. An armed breach keeps nothing.
      const kept = state.get(rk)?.rtt;
      const doubt = state.get(rk)?.rttDoubt;
      const holdMs = confirmable && input.sweepMs ? input.sweepMs + RTT_HOLD_MARGIN_MS : 0;
      const held = obs == null && kept != null && doubt == null && yard != null && node.status !== NS.Dead && now - kept.t <= holdMs && kept.judged > yard.line;
      const line = b ? yard!.line : Infinity;
      const frames = b ? rawRttFrames(samples).filter((f) => now - f.t <= WINDOW_MS) : [];
      const r1 = frames[frames.length - 1];
      const r2 = frames[frames.length - 2];
      const slow = r1 != null && r1.raw > line;
      const pair = slow && r2 != null && r2.raw > line;
      const armed = state.has(rk);
      if (b) input.rttOverLine?.(id);
      if (b && !armed && slow && !pair && confirmable) input.rttSuspect?.(id, r1);
      const since = held ? state.get(rk)!.since : dwell(state, rk, b && (armed || pair || (slow && !confirmable)), now);
      if (since != null) {
        const e = state.get(rk)!;
        // Live, the reading shown is timed from its newest round trip, and it is
        // kept for a hold only while that round trip is slow (above).
        const live = held ? null : { avg: obs!.rtt, judged: obs!.rtt - residue, residue, t: r1?.t ?? obs!.t, raw: frames.slice(-2).reverse().map((f) => f.raw) };
        if (live != null) {
          // CONFIRMED BOTH WAYS (v0.79.2). A breach starts on two slow round
          // trips, and the hold now ends on two normal ones. One normal round
          // trip, or one slow one read across a route change, owes one
          // confirmation probe and keeps the kept reading meanwhile; while it
          // waits the breach is not held, so a confirmation that never comes
          // lets it go at the window's end as before. On the reference mesh a
          // lone 178 ms read on a node still at 493 ms, and a 1194 ms read taken
          // as a node re-routed, each split or stretched one slowdown.
          const rerouted = r1 != null && routeChangedOn(samples, r1.t);
          if (slow && !rerouted) { e.rtt = live; delete e.rttDoubt; }
          else if (r1 != null && !slow && r2 != null && r2.raw <= line) { delete e.rtt; delete e.rttDoubt; }
          else if (r1 != null && e.rtt != null && confirmable) { e.rttDoubt = r1.t; input.rttSuspect?.(id, r1); }
          else if (r1 != null && !slow) delete e.rtt;
        }
        const shown = held ? e.rtt! : live!;
        const ageMin = Math.round((now - shown.t) / 60_000);
        breaching = true;
        out.push({
          kind: 'rtt-degraded', nodeId: id, severity: 'watch', sinceMs: since, basis: 'measured',
          ...(held ? { held: true as const } : {}),
          evidence: [
            { label: 'RTT', value: held ? `${Math.round(shown.avg)}ms · ${ageMin}m ago` : `${Math.round(shown.avg)}ms` },
            // The yardstick it was judged against (v0.79.0): a ceiling breach
            // has no baseline to show, and printing the empty band's 0±8 would
            // claim one.
            yard!.basis === 'ceiling'
              ? { label: 'ceiling', value: `${RTT_CEILING_MS}ms · no normal for this band yet` }
              : { label: 'baseline', value: `${Math.round(norm!.median)}±${Math.round(norm!.scale)}ms${yard!.basis === 'capped' ? ` · capped at ${RTT_CEILING_MS}ms` : ''}` },
            ...(shown.residue >= 1 ? [{ label: 'restart allowance', value: `${Math.round(shown.residue)}ms (${node.stats.commandsTX} tx since driver start)` }] : []),
            // Last (v0.78.0): REMEDY cuts the evidence row at the screen's width,
            // and the yardstick must not be what falls off.
            ...(shown.raw.length > 0 ? [{ label: 'newest round trips', value: `${shown.raw.map((x) => Math.round(x)).join(', ')}ms` }] : []),
          ],
          narrative: (yard!.basis === 'learned'
            ? `${node.name}'s round-trip time is far above its normal for this route and time of day.`
            : yard!.basis === 'capped'
              ? `${node.name}'s round trips are over ${RTT_CEILING_MS} ms, slow on any route, although the normal learned for this route and time of day is wide enough to allow them.`
              : `${node.name}'s round trips are over ${RTT_CEILING_MS} ms, slow on any route. Its current route has no learned normal for this time of day yet (the RTT normal restarts on every route change), so the fixed ceiling is the yardstick.`)
            + (held ? ` No round trip has been measured for ${ageMin} min; the breach is held on the last slow one.` : ''),
        });
      }
    }

    // weak-signal — DIRECT nodes only (a routed node's rssi is its LAST HOP, not
    // the device). Requires timeout CORROBORATION (DESIGN §3.3): a thin margin
    // that isn't actually costing deliveries is not yet a problem. Uses the
    // newest fresh RSSI (dwell-stable). Honest basis: 'measured' only when the
    // noise floor is a real reading; against the −95 fallback it is 'inferred'.
    {
      // UNKNOWN IS NOT A ROUTE (v0.54.0). A null routeKey means the statistics
      // event carried no `lwr`, not that the node is direct — the same value
      // rate-fallback already treats fail-closed. This detector then asserted
      // "(direct route)" with basis 'measured' about a route it never saw, and
      // the margin it reported was a REPEATER's last hop, not the device's.
      // Resolved through latestFresh, not the raw `last`: dwell() clears on any
      // non-breaching tick, so gating on the newest sample would let one `lwr`
      // blink (the v0.47.0 nullable-routeKey shape) reset the dwell and stop
      // this detector maturing at all.
      const w = windowTimeoutRate(samples, now);
      // UNMEASURED IS NOT "NOT SUFFERING". Under MIN_WINDOW_TX sends there is no
      // rate, and on a mesh whose per-node traffic is the sweep ping that is every
      // node, always — so `w != null &&` made this detector unreachable. A failed
      // delivery is still an EVENT the store records: a send that exhausted its
      // retries marks the node Dead (dFlaps — RESEARCH §0's reliable RF-failure
      // signal; it moves no counter), and an ACKed reply-expecting send that went
      // unanswered moves dTimeout. One such event inside the lookback corroborates,
      // and the level inputs read the same lookback so the breach does not clear
      // ten minutes after the one fresh sample a sparse node produces. A measured
      // window still decides on its rate. Never for a node that is Dead now:
      // node-down owns that, and two cards for one fault is noise.
      const lookback = w != null ? WINDOW_MS : WEAK_EVENT_LOOKBACK_MS;
      const routeKey = latestFresh(samples, now, (s) => s.routeKey, lookback);
      const routed = routeKey !== 'direct';
      const rssi = latestFresh(samples, now, (s) => s.rssi, lookback);
      const { floor, measured: realFloor } = representativeFloor(input);
      const margin = rssi != null ? rssi - floor : null;
      let failures = 0;
      for (const s of samples) if (now - s.t <= WEAK_EVENT_LOOKBACK_MS) failures += s.dFlaps + (s.dTimeout ?? 0);
      const timeoutCorrob = w != null ? w.rate >= WEAK_TIMEOUT_RATE : failures > 0 && node.status !== NS.Dead;
      const b = !routed && !node.isLongRange && margin != null && margin < WEAK_MARGIN_DB && timeoutCorrob;
      const since = dwell(state, key(id, 'weak-signal'), b, now);
      if (since != null) {
        markDegrading(id, true);
        out.push({
          kind: 'weak-signal', nodeId: id, severity: 'watch', sinceMs: since,
          basis: realFloor ? 'measured' : 'inferred',
          evidence: [
            { label: 'SNR margin', value: `${Math.round(margin!)}dB${realFloor ? '' : ' (vs assumed −95 floor)'}` },
            w != null
              ? { label: 'timeouts', value: `${(w.rate * 100).toFixed(0)}%` }
              : { label: 'failed deliveries', value: `${failures} in 30m (too few sends for a rate)` },
          ],
          narrative: `${node.name} (direct route) has a thin signal margin over the noise floor and is losing replies — the classic RF-marginal-link pattern for a device far from the controller or behind an RF-hostile wall.`,
        });
      }
    }

    // chatty-device — dRx flood vs the mesh median (computed once below).
    // (breach evaluated in the second pass; see meshRxMedian.)

    // ghost-suspect — coverage-PROVEN, zero comms (destructive rec ⇒ strict).
    // INTENTIONALLY conservative (v0.14 review, accepted): keying on cumulative
    // freshSamples===0 flags only NEVER-communicated dead nodes, so a device
    // that once worked then died is NOT called a ghost here. That is the safe
    // bias — the eventual remediation (remove-failed) is destructive, and a
    // missed ghost costs far less than wrongly recommending removal of a real
    // device. A once-working dead node surfaces as dead-flap / plain-dead instead.
    {
      const cov = input.coverage(id);
      const rec = input.recordingSince();
      const observedMs = cov ? now - cov.firstSeenAt : rec ? now - rec : 0;
      const dead = node.status === NS.Dead;
      const noComms = cov != null && cov.freshSamples === 0;
      const b = dead && noComms && observedMs >= GHOST_MIN_COVERAGE_MS;
      const since = dwell(state, key(id, 'ghost-suspect'), b, now);
      if (since != null) {
        out.push({
          kind: 'ghost-suspect', nodeId: id, severity: 'warn', sinceMs: since, basis: 'inferred',
          evidence: [{ label: 'observed', value: `${Math.floor(observedMs / 86_400_000)}d, 0 successful comms` }],
          narrative: `${node.name} has been dead with no successful communication for days — possibly a ghost (a device removed without exclusion). Removing a failed node is destructive and only succeeds if the controller already considers it failed; verify before confirming.`,
        });
        breaching = true;
      }
    }

    void breaching; // per-node dwell drives emission; the gate uses degradingNow
  }

  // ── chatty-device (needs the mesh median) ─────────────────────────────────
  const rxRates = nodes
    .filter((n) => !n.isController)
    .map((n) => windowRxRate(input.recent(n.nodeId), now))
    .filter((r): r is number => r != null && r > 0)
    .sort((a, b) => a - b);
  const rxMedian = rxRates.length ? rxRates[rxRates.length >> 1] : 0;
  let floodNode: number | null = null;
  for (const node of nodes) {
    if (node.isController) continue;
    const rr = windowRxRate(input.recent(node.nodeId), now);
    const b = rr != null && rxMedian > 0 && rr >= rxMedian * RX_FLOOD_MULT && rr >= 6; // ≥6 reports/min AND ≫ median
    const since = dwell(state, key(node.nodeId, 'chatty-device'), b, now);
    if (since != null) {
      floodNode = node.nodeId;
      out.push({
        kind: 'chatty-device', nodeId: node.nodeId, severity: 'watch', sinceMs: since, basis: 'measured',
        evidence: [{ label: 'report rate', value: `${rr!.toFixed(1)}/min vs mesh ${rxMedian.toFixed(1)}/min` }],
        narrative: `${node.name} is flooding the mesh with reports (orders of magnitude over the median). Tune its reporting thresholds (change-based, not timed) or re-include without S0 — traffic like this degrades everyone.`,
      });
    }
  }

  // ── correlation ladder: is this a MESH-level event? ───────────────────────
  // Breadth over ACTIVE nodes, with hard floors so a coincidental pair on a
  // quiet mesh can't be called mesh-wide (v0.14 review: the K=2 dichotomy), and
  // HYSTERESIS (fire high, release low) so a momentary breadth dip doesn't drop
  // the event — which would regress the Remedy screen to N independent faults.
  const meshKey = key(null, 'mesh-interference');
  const wasMeshActive = state.has(meshKey);
  const activeNodes = nodes.filter((n) => !n.isController && input.recent(n.nodeId).some((s) => now - s.t <= WINDOW_MS && s.dTx != null && s.dTx > 0));
  const degradedActive = activeNodes.filter((n) => degradingNow.get(n.nodeId)).length;
  const frac = activeNodes.length > 0 ? degradedActive / activeNodes.length : 0;
  const threshold = wasMeshActive ? MESH_RELEASE_FRACTION : MESH_ACTIVE_FRACTION;
  const meshBreach =
    activeNodes.length >= MESH_MIN_ACTIVE && degradedActive >= MESH_MIN_DEGRADED && frac >= threshold;
  const meshSince = dwell(state, meshKey, meshBreach && !controllerEvent, now);

  let meshEventId: string | null = controllerEvent;
  if (meshSince != null) {
    meshEventId = 'mesh';
    // Disambiguate: flooding (a chatty offender) vs interference (the residual).
    if (floodNode != null) {
      out.push({
        kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: meshSince, basis: 'measured',
        evidence: [{ label: 'active nodes degraded', value: `${degradedActive}/${activeNodes.length}` }, { label: 'flooding node', value: `#${floodNode}` }],
        narrative: `Many nodes degraded together AND node #${floodNode} is flooding the mesh — the likely cause is that traffic, not RF interference. Fix the chatty device first.`,
      });
    } else {
      out.push({
        kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: meshSince, basis: 'inferred',
        evidence: [{ label: 'active nodes degraded', value: `${degradedActive}/${activeNodes.length} in the same window` }],
        narrative: 'Many nodes degraded together with no controller-serial or flooding cause — likely an RF-environment event (interference). No noise-floor measurement is used to confirm this yet; treat as a lead, not a verdict.',
      });
    }
  }

  // ── edge-cluster: a small correlated subset sharing ONE upstream repeater ──
  // The middle scale between a per-node symptom and a mesh-wide event: when the
  // degradation is NOT mesh-wide but ≥EDGE_MIN_MEMBERS nodes that all route
  // through a COMMON repeater are degrading together — AND that repeater itself
  // looks healthy — the shared dependency (its link, power, or placement) is the
  // single likely cause, not each node individually. Requiring the repeater to be
  // NON-degrading is the sharp signal: a repeater that is itself failing already
  // shows its own card, and the interesting case is the SILENT shared dependency.
  // Suppressed entirely while a mesh/controller event owns the story.
  const edgeReps = new Set<number>(); // repeater ids that head a matured cluster this tick
  const edgeClusters: { rep: number; repName: string; key: string; members: number[]; since: number }[] = [];
  if (!meshEventId) {
    const nodeById = new Map(nodes.map((n) => [n.nodeId, n] as const));
    // repeater id → degrading downstream member node ids that route through it.
    const byRepeater = new Map<number, Set<number>>();
    for (const node of nodes) {
      if (node.isController) continue;
      if (!degradingNow.get(node.nodeId)) continue; // only genuinely-degrading dependents
      const reps = new Set<number>();
      for (const rt of [node.stats.lwr, node.stats.nlwr]) {
        if (rt) for (const r of rt.repeaters) reps.add(r);
      }
      for (const r of reps) {
        if (r === node.nodeId) continue; // never cluster a node under itself
        if (!nodeById.has(r) || nodeById.get(r)!.isController) continue; // head must be a known, non-controller node
        if (degradingNow.get(r)) continue; // ← the head repeater must itself look healthy
        (byRepeater.get(r) ?? byRepeater.set(r, new Set()).get(r)!).add(node.nodeId);
      }
    }
    // Greedy DISJOINT assignment: largest cluster first (tie: repeater id asc), so
    // a node routed through two shared repeaters is credited to exactly ONE
    // cluster — never double-counted, double-subsumed, or double-carded.
    const candidates = [...byRepeater.entries()]
      .filter(([, m]) => m.size >= EDGE_MIN_MEMBERS)
      .sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
    const claimed = new Set<number>();
    for (const [rep, memberSet] of candidates) {
      const members = [...memberSet].filter((m) => !claimed.has(m)).sort((a, b) => a - b);
      if (members.length < EDGE_MIN_MEMBERS) continue; // dropped below quorum after earlier claims
      members.forEach((m) => claimed.add(m));
      const k = key(rep, 'edge-cluster');
      const since = dwell(state, k, true, now);
      edgeReps.add(rep);
      if (since != null) edgeClusters.push({ rep, repName: nodeById.get(rep)?.name ?? `#${rep}`, key: k, members, since });
    }
  }
  // Clear the dwell for any edge-cluster key that lost quorum, vanished, or was
  // superseded by a mesh event this tick — else a stale `since` would let a
  // re-formed cluster mature instantly (and the map would leak keys).
  {
    const stale: string[] = [];
    for (const k of state.keys()) {
      if (k.endsWith(EDGE_SUFFIX) && !edgeReps.has(Number(k.slice(0, -EDGE_SUFFIX.length)))) stale.push(k);
    }
    for (const k of stale) state.delete(k);
  }
  // Emit matured clusters and COLLAPSE their members' per-node RF faults under the
  // cluster (mirrors the mesh subsumption) so the operator sees one shared cause,
  // not N scattered cards. chatty-device is exempt (a flooding member is its own
  // story), as is the head repeater (nodeId), which is never a member.
  for (const { rep, repName, key: clusterKey, members, since } of edgeClusters) {
    out.push({
      kind: 'edge-cluster', nodeId: rep, members, severity: 'warn', sinceMs: since, basis: 'measured',
      evidence: [
        { label: 'shared repeater', value: `#${rep} ${repName}` },
        // COUNT ONLY (v0.45.0). The id list lived here too and was the copy
        // that lied: this string rides the evidence line, which `truncate`
        // cuts mid-list, so a clipped `#23` rendered as `#2` — an innocent
        // node named as degraded. The identities now have their own row on
        // REMEDY, shed as whole tokens; a count survives truncation intact.
        { label: 'degraded downstream', value: `${members.length} node(s)` },
      ],
      narrative: `${members.length} nodes that all route through repeater #${rep} (${repName}) are degrading together while the rest of the mesh is healthy, and that repeater itself is not flagged — the shared dependency (its link, power, or placement) is the likely common cause, not each node individually. Check that repeater before touching the downstream devices.`,
    });
    for (const s of out) {
      if (s.nodeId != null && s.kind !== 'chatty-device' && s.kind !== 'edge-cluster' && members.includes(s.nodeId)) {
        s.subsumedBy = clusterKey;
      }
    }
  }

  // Detection ≠ advice: under an active mesh event, DEMOTE per-node symptoms
  // (annotate, never delete) so the operator sees one event, not N faults.
  if (meshEventId) {
    for (const s of out) {
      if (s.nodeId != null && s.kind !== 'chatty-device') s.subsumedBy = meshEventId;
    }
  }

  // Rank: crit > warn > watch, then mesh/controller first, then by dwell age.
  const sevRank: Record<Severity, number> = { crit: 0, warn: 1, watch: 2 };
  out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.nodeId == null ? -1 : 1) - (b.nodeId == null ? -1 : 1) || a.sinceMs - b.sinceMs);
  return out;
}

/** Representative noise floor for margin math — the controller's measured floor
 *  if present, else the −95 dBm fallback — and whether it was measured. ONE
 *  source for both (v0.75.2): the "measured" basis had come from whether a
 *  driver sample existed at all, so a −95 fallback was labelled measured. */
function representativeFloor(input: DetectInput): { floor: number; measured: boolean } {
  const m = medianNoiseFloor(input.controller?.backgroundRSSI ?? []);
  return { floor: m ?? DEFAULT_NOISE_FLOOR, measured: m != null };
}

/** The set of node ids with an ACTIVE (non-subsumed) symptom — for quarantine
 *  (baselines must not learn while a node is symptomatic). */
export function symptomaticNodes(symptoms: Symptom[]): Set<number> {
  const s = new Set<number>();
  for (const sym of symptoms) if (sym.nodeId != null) s.add(sym.nodeId);
  return s;
}

/**
 * Node ids with ANY active dwell entry — i.e. currently breaching a detector,
 * whether or not it has matured to a surfaced symptom. This is the correct
 * quarantine set (v0.14 review): the DESIGN invariant is that windows INSIDE a
 * symptom's dwell are excluded from the baseline, but the arming window (5 min
 * of breach before emission) is exactly "inside the dwell" — folding those bad
 * samples ratchets the baseline toward the pathology and desensitizes the very
 * detector that would catch it next time.
 */
/** Symptoms HELD through a dark lane (v0.76.0): not emitted — there is nothing
 *  to show — but still live, so the episode lifecycle and the activity log
 *  neither close them during a storm pause nor reopen them on resume. */
export function heldSymptoms(state: SymptomState): { key: string; nodeId: number; kind: SymptomKind }[] {
  const out: { key: string; nodeId: number; kind: SymptomKind }[] = [];
  for (const [k, e] of state) {
    if (e.held !== true) continue;
    const i = k.indexOf(':');
    const id = Number(k.slice(0, i));
    if (Number.isInteger(id) && id > 0) out.push({ key: k, nodeId: id, kind: k.slice(i + 1) as SymptomKind });
  }
  return out;
}

export function armingNodes(state: SymptomState): Set<number> {
  const s = new Set<number>();
  for (const k of state.keys()) {
    const idPart = k.slice(0, k.indexOf(':'));
    const id = Number(idPart);
    if (Number.isInteger(id) && id > 0) s.add(id);
  }
  return s;
}
