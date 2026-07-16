/**
 * Composite RF health model for a single Z-Wave node.
 *
 * `scoreNode(node, noiseFloor)` maps one {@link NodeSnapshot} to a
 * {@link HealthResult}: a 0..100 score, a 0..10 rating, an A..F grade, a
 * discrete `state`, and a set of single-char `flags`. It is a pure function —
 * the render loop calls it every frame via `DataProvider.scoreFor()`, so it
 * must never throw and must be robust to null/partial statistics.
 *
 * DESIGN (merged from the mesh + ops TUI designs):
 *
 *   Hard gates (evaluated first, before any lane math):
 *     • DEAD   → score 0 (the node is unreachable; nothing else matters).
 *     • UNKNOWN status OR missing stats → score capped at 15, state 'unknown'.
 *     • ASLEEP within its wake interval is NOT penalised — a sleeping FLiRS /
 *       battery node is *supposed* to be unreachable, so its Reachability lane
 *       is credited in full.
 *
 *   Weighted RF lanes (each earns 0..1 of its weight; sum = 100):
 *     • Reachability 30%  — lastSeen staleness vs an expected freshness window.
 *     • Signal       25%  — (RSSI − noiseFloor) SNR margin. W flag < 7 dB.
 *     • Route        20%  — hop count / data rate / rtt / routeFailedBetween.
 *     • TX Reliability 20% — (droppedTX + timeoutResponse) / commandsTX. F flag > 15%.
 *     • Interview     5%  — node fully interviewed (`ready`). I flag if not.
 *
 *   Long-Range (nodeId ≥ 256) nodes talk *directly* to the controller in a
 *   star — mesh routing is meaningless — so the 20% Route weight is
 *   redistributed evenly into Signal (→35%) and TX Reliability (→30%).
 *
 *   RSSI sentinels 127 / 126 / 125 (not-available / saturated / no-signal) are
 *   excluded from the margin math rather than treated as real dBm.
 *
 *   Battery is a SEPARATE, ADVISORY lane: a low battery raises a B flag but is
 *   NEVER folded into the RF score — a healthy radio on a dying cell is still a
 *   healthy radio, and conflating the two hides both problems.
 *
 * Flags are single chars, rendered in the Overview table:
 *   D dead · S stale (reachability) · W weak signal · F flaky/failed TX ·
 *   R route failed · I interview incomplete · B battery low.
 */

import { NodeStatus, type NodeSnapshot, type NodeStats, type HealthResult } from '../types';

// ── Tunables ────────────────────────────────────────────────────────────────

/** RSSI values the driver uses as sentinels, not real dBm (excluded from math). */
const RSSI_SENTINELS = new Set([125, 126, 127]);

/** Fallback background-RSSI when the caller can't supply a real noise floor. */
/** Fallback noise floor (dBm) when the controller reports no background RSSI.
 *  Shared with dataProvider so the scorer's margin math and the displayed noise
 *  agree on one value. */
export const DEFAULT_NOISE_FLOOR = -95;

/** SNR margin (dB) below which the Signal lane raises the W flag. */
const WEAK_MARGIN_DB = 7;

/** Margin window mapped onto [0,1]. The W threshold (7 dB) lands at the midpoint. */
const SIGNAL_MARGIN_LO = 0;
const SIGNAL_MARGIN_HI = 14;

/** TX error fraction above which the F (flaky/failed) flag fires. */
const TX_ERR_THRESHOLD = 0.15;

/** TX error fraction that scores the reliability lane to zero. */
const TX_ERR_FLOOR = 0.3;

/** Battery percent at/under which the advisory B flag fires. */
const BATTERY_LOW_PCT = 25;

/** Reachability freshness window (ms): full credit up to FRESH, zero by STALE. */
const REACH_FRESH_MS = 30 * 60_000; // 30 min → still fresh
const REACH_STALE_MS = 6 * 60 * 60_000; // 6 h → fully stale
/** Age past which the S (stale) flag fires. */
const STALE_FLAG_MS = 2 * 60 * 60_000; // 2 h

/** Round-trip window (ms) mapped onto the route lane. */
const RTT_LO_MS = 100;
const RTT_HI_MS = 1000;

/** UNKNOWN hard-gate score ceiling. */
const UNKNOWN_SCORE_CAP = 15;

/** LR (nodeId ≥ 256) threshold. */
const LR_NODE_ID = 256;

/** Documented render order for the flag column. */
const FLAG_ORDER = ['D', 'S', 'W', 'F', 'R', 'L', 'I', 'B', 'U'] as const;

/**
 * TX drop rate (%) — the ONE definition shared by the Overview DROP column and
 * the Detail 'Drop' row so the same node never shows two figures. Failures =
 * dropped transmits + response timeouts, over attempted commands; null when the
 * node has sent nothing yet.
 */
export function txDropPct(stats: NodeStats): number | null {
  const tx = stats.commandsTX;
  if (tx <= 0) return null;
  const drops = Math.min(stats.commandsDroppedTX + stats.timeoutResponse, tx);
  return Math.min(100, (drops / tx) * 100);
}

// ── Small numeric helpers ────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear ramp: `lo` → 0, `hi` → 1, clamped to [0,1]. Robust to lo === hi. */
function linstep(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return x >= hi ? 1 : 0;
  return clamp((x - lo) / (hi - lo), 0, 1);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** A finite RSSI in real dBm range, or null if absent / a sentinel. */
function validRssi(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (RSSI_SENTINELS.has(v)) return null;
  return v;
}

/** A..F grade band from a 0..100 score. */
function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

/** Sort raw flags into the documented render order and drop dupes. */
function orderFlags(flags: Set<string>): string[] {
  const out: string[] = [];
  for (const f of FLAG_ORDER) if (flags.has(f)) out.push(f);
  return out;
}

// ── Scorer ───────────────────────────────────────────────────────────────────

/**
 * Score one node's RF health. Pure and total — never throws; a missing/partial
 * stats object degrades to state 'unknown' with a sensible low score rather
 * than an exception.
 */
export function scoreNode(node: NodeSnapshot, noiseFloor: number): HealthResult {
  const stats = node.stats;

  // Battery is advisory and lane-independent — compute once, append to any state.
  const batteryLow =
    node.battery != null &&
    (node.battery.level <= BATTERY_LOW_PCT || node.battery.isLow === true);
  // Firmware-update-available is likewise advisory: it flags maintenance, never
  // a fault, so like 'B' it appends to any state WITHOUT changing the score.
  const updateAvail = node.firmware?.updateAvailable === true;

  // ── Gate 1: DEAD → 0. Nothing else is meaningful once the node is unreachable.
  if (node.status === NodeStatus.Dead) {
    const flags = new Set<string>(['D']);
    if (batteryLow) flags.add('B');
    if (updateAvail) flags.add('U');
    return { score: 0, rating: 0, grade: 'F', state: 'dead', flags: orderFlags(flags) };
  }

  // ── Gate 2a: no statistics at all → we simply don't know. Sensible low score.
  if (!stats) {
    const flags = new Set<string>();
    if (!node.ready) flags.add('I');
    if (batteryLow) flags.add('B');
    if (updateAvail) flags.add('U');
    const score = 10; // ≤ UNKNOWN_SCORE_CAP by construction
    return {
      score,
      rating: Math.round(score / 10),
      grade: gradeFor(score),
      state: 'unknown',
      flags: orderFlags(flags),
    };
  }

  // ── Controller (node 1): its health lives on the Controller screen, not here.
  // It has no upstream link/route to score, so a live controller is simply OK.
  if (node.isController && (node.status === NodeStatus.Alive || node.status === NodeStatus.Awake)) {
    const flags = new Set<string>();
    if (batteryLow) flags.add('B'); // controllers are mains-powered, but stay honest
    if (updateAvail) flags.add('U');
    return { score: 100, rating: 10, grade: 'A', state: 'ok', flags: orderFlags(flags) };
  }

  const isLR = node.isLongRange || node.nodeId >= LR_NODE_ID;
  const isAsleep = node.status === NodeStatus.Asleep;
  const flags = new Set<string>();

  // ── Lane: Reachability (30%).
  // The controller's alive-poll (network_status) is AUTHORITATIVE: an Alive/Awake
  // node is reachable and earns full credit — regardless of how long ago we last
  // received detailed STATISTICS (those push only on node activity, so a
  // quiet-but-alive mains node must NOT decay into a false 'S' stale flag).
  // The lastSeen-age decay + S flag are reserved for a node NOT confirmed alive.
  const aliveNow = node.status === NodeStatus.Alive || node.status === NodeStatus.Awake;
  let reachFrac: number;
  if (isAsleep || aliveNow) {
    reachFrac = 1;
  } else if (stats.lastSeen == null) {
    reachFrac = 0.5;
  } else {
    const age = Math.max(0, Date.now() - stats.lastSeen);
    reachFrac =
      age <= REACH_FRESH_MS
        ? 1
        : clamp((REACH_STALE_MS - age) / (REACH_STALE_MS - REACH_FRESH_MS), 0, 1);
    if (age > STALE_FLAG_MS) flags.add('S');
  }

  // ── Lane: Signal (25%, 35% for LR) — SNR margin over the live noise floor.
  const nf =
    Number.isFinite(noiseFloor) && noiseFloor < 0 && noiseFloor > -120
      ? noiseFloor
      : DEFAULT_NOISE_FLOOR;
  const rssi = validRssi(stats.rssi) ?? validRssi(stats.lwr?.rssi ?? null);
  let signalFrac: number;
  if (rssi == null) {
    signalFrac = 0.7; // no usable RSSI (all sentinels/null): neutral, can't flag weak
  } else {
    const margin = rssi - nf;
    signalFrac = linstep(margin, SIGNAL_MARGIN_LO, SIGNAL_MARGIN_HI);
    if (margin < WEAK_MARGIN_DB) flags.add('W');
  }

  // ── Lane: Route (20%; folded away for LR star nodes).
  // hop count + data rate + rtt, hard-docked when a route failed between two nodes.
  let routeFrac = 0;
  if (!isLR) {
    const lwr = stats.lwr;
    if (!lwr) {
      routeFrac = 0.7; // no route info yet: neutral
    } else {
      const hops = Array.isArray(lwr.repeaters) ? lwr.repeaters.length : 0;
      const hopFrac = clamp(1 - hops * 0.2, 0.2, 1); // direct → 1, each hop −0.2
      const rate = lwr.protocolDataRate;
      const rateFrac =
        rate === 3 || rate === 4 ? 1 : rate === 2 ? 0.6 : rate === 1 ? 0.3 : 0.7;
      const rttFrac = stats.rtt == null ? 0.7 : 1 - linstep(stats.rtt, RTT_LO_MS, RTT_HI_MS);
      let base = mean([hopFrac, rateFrac, rttFrac]);
      const failed =
        lwr.routeFailedBetween != null || stats.nlwr?.routeFailedBetween != null;
      if (failed) {
        base *= 0.4;
        flags.add('R');
      }
      routeFrac = base;
    }
  }

  // Latency advisory: a sustained multi-second round-trip is worth surfacing
  // even when the weighted route lane alone can't drop the grade.
  if (stats.rtt != null && stats.rtt > RTT_HI_MS) flags.add('L');

  // ── Lane: TX Reliability (20%, 30% for LR) — dropped + timed-out over sent.
  let txFrac: number;
  let flaky = false;
  if (stats.commandsTX <= 0) {
    txFrac = 0.85; // nothing sent yet: give the benefit of the doubt, no flag
  } else {
    const errRate =
      (stats.commandsDroppedTX + stats.timeoutResponse) / stats.commandsTX;
    txFrac = 1 - linstep(errRate, 0, TX_ERR_FLOOR);
    if (errRate > TX_ERR_THRESHOLD) {
      flags.add('F');
      flaky = true;
    }
  }

  // ── Lane: Interview (5%) — is the node fully interviewed?
  const interviewFrac = node.ready ? 1 : 0;
  if (!node.ready) flags.add('I');

  // ── Battery + firmware (advisory) — never folded into the RF score.
  if (batteryLow) flags.add('B');
  if (updateAvail) flags.add('U');

  // ── Weighted composite. LR redistributes the Route weight into Signal + TX.
  const w = isLR
    ? { reach: 0.3, signal: 0.35, route: 0, tx: 0.3, interview: 0.05 }
    : { reach: 0.3, signal: 0.25, route: 0.2, tx: 0.2, interview: 0.05 };

  let score = Math.round(
    100 *
      (reachFrac * w.reach +
        signalFrac * w.signal +
        routeFrac * w.route +
        txFrac * w.tx +
        interviewFrac * w.interview),
  );
  score = clamp(score, 0, 100);

  // ── Gate 2b: UNKNOWN status caps the score regardless of the lanes.
  if (node.status === NodeStatus.Unknown) score = Math.min(score, UNKNOWN_SCORE_CAP);

  // ── State (first match wins). Problems outrank the benign 'asleep' descriptor,
  // but 'asleep' still outranks a merely-weak last-known signal.
  const weak = flags.has('W');
  let state: HealthResult['state'];
  if (node.status === NodeStatus.Unknown) state = 'unknown';
  else if (flaky) state = 'flaky';
  else if (isAsleep) state = 'asleep';
  else if (weak) state = 'weak';
  else state = 'ok';

  return {
    score,
    rating: clamp(Math.round(score / 10), 0, 10),
    grade: gradeFor(score),
    state,
    flags: orderFlags(flags),
  };
}
