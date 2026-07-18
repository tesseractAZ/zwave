/**
 * INTERFERENCE view (M6, DESIGN.md §3.7) — a pure summary of the mesh's RF
 * environment for the INTERFERENCE screen. Nothing here detects or acts; it
 * assembles what the evidence store + driver-WS already measured into one
 * cached, render-ready view:
 *
 *   • the background 900 MHz NOISE FLOOR (per channel + a representative value)
 *     and its recent trend — the only path to real interference measurement
 *     (HA's WS strips backgroundRSSI; the driver-WS client, v0.13, restores it);
 *   • CONTROLLER SERIAL-LINK health (host↔stick NAK/CAN/timeout rates) — a
 *     serial fault masquerades as mesh-wide RF trouble, so it is shown apart;
 *   • a DIURNAL (hour-of-day) heatmap of the mesh-wide RAW timeout rate, summed
 *     across every node's coarse buckets. This is deliberately NOT
 *     baseline-relative (DESIGN, DR): time-of-day-banded baselines are blind to
 *     recurring diurnal interference by construction, so this heatmap is the
 *     human's view of exactly what the bands absorbed — a persistently hot hour
 *     (a smart meter at 02:00, a baby monitor overnight) stands out;
 *   • the current CORRELATED-degradation state from the mesh-interference
 *     detector — inferred-by-exclusion until the noise floor corroborates it.
 *
 * Interpretation thresholds are rules-of-thumb for 800-series 900 MHz Z-Wave: a
 * background floor near −100 dBm is quiet; the near-radio ideal is ≈ −110.
 */

import type { InterferenceView } from '../types';
import type { ControllerSample, CoarseBucket } from './evidenceStore';
import type { Symptom } from './symptoms';

/** Leading contiguous run of non-null channels (a null ends the run) — the
 *  driver's channel convention. Inlined (not imported from zwaveData) to avoid a
 *  module cycle; identical to zwaveData.leadingRun. */
function leadingRun(channels: (number | null)[]): number[] {
  const out: number[] = [];
  for (const ch of channels) {
    if (ch == null) break;
    out.push(ch);
  }
  return out;
}

export interface InterferenceInput {
  now: number;
  /** Current per-channel background RSSI (ch0..3), or null when no live reading. */
  bgChannels: (number | null)[] | null;
  /** Controller serial-link samples (newest last) — bg trend + serial rates. */
  controllerSamples: ControllerSample[];
  /** Per-node coarse buckets (30-min × 14-day) for the diurnal heatmap. */
  coarseByNode: Map<number, CoarseBucket[]>;
  /** Live symptoms — the correlated-degradation state + degraded-node count. */
  symptoms: Symptom[];
}

const HOURS = 24;
const MIN_HOUR_TX = 20; // below this, an hour's rate is not meaningful → null
const MIN_SERIAL_SAMPLES = 2;

/** Classify a background RSSI floor (dBm). Higher (less negative) = noisier. */
function noiseBand(floor: number | null, real: boolean): InterferenceView['noise']['band'] {
  if (!real || floor == null) return 'unknown';
  if (floor <= -98) return 'clean';
  if (floor <= -88) return 'elevated';
  return 'noisy';
}

/** MEDIAN of the representative channels, IDENTICAL to the masthead's
 *  computeNoiseFloor: take the leading contiguous run of channels (the driver's
 *  own convention — a null ends the run), then median the finite, non-sentinel,
 *  negative values. Matching exactly avoids showing two different "noise floor"
 *  numbers on two screens. */
function medianFloor(channels: (number | null)[] | null | undefined): number | null {
  if (!channels) return null;
  const vals = leadingRun(channels)
    .filter((v) => Number.isFinite(v) && v < 0)
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

export function computeInterference(input: InterferenceInput): InterferenceView {
  // ── Noise floor + trend ────────────────────────────────────────────────
  const channels = input.bgChannels ?? [null, null, null, null];
  const floor = medianFloor(channels); // median — matches the masthead noiseFloor
  const real = floor != null;
  const band = noiseBand(floor, real);
  // Trend = per-channel median per controller sample that carried a bg reading.
  const trend: number[] = [];
  for (const s of input.controllerSamples) {
    const m = medianFloor([s.bg0, s.bg1, s.bg2, s.bg3]);
    if (m != null) trend.push(m);
  }

  // ── Controller serial-link health ──────────────────────────────────────
  const cs = input.controllerSamples.filter((s) => s.fresh);
  let nak = 0, can = 0, tmoAck = 0, tmoResp = 0, spanMs = 0;
  if (cs.length >= MIN_SERIAL_SAMPLES) {
    spanMs = Math.max(0, cs[cs.length - 1].t - cs[0].t);
    // Fencepost: sum deltas from the SECOND sample on. cs[0]'s delta covers the
    // window BEFORE the span (up to cs[0].t) and must not be attributed to it;
    // each of cs[1..last]'s deltas covers a sub-window inside [cs[0].t, last].
    for (let i = 1; i < cs.length; i++) {
      const s = cs[i];
      nak += s.dNak ?? 0; can += s.dCan ?? 0;
      tmoAck += s.dTimeoutAck ?? 0; tmoResp += s.dTimeoutResponse ?? 0;
    }
  }
  const spanH = spanMs / 3_600_000;
  const perH = (x: number): number | null => (spanH > 0 ? x / spanH : null);
  const nakPerH = perH(nak), canPerH = perH(can), tmoAckPerH = perH(tmoAck), tmoRespPerH = perH(tmoResp);
  // "strained": any of the true serial-fault counters (NAK/CAN/timeoutACK) is
  // non-trivial. timeoutResponse is a per-node reply timeout, NOT a serial
  // fault, so it is reported but does NOT set the band.
  let serialBand: InterferenceView['serial']['band'] = 'unknown';
  if (spanH > 0) {
    const worst = Math.max(nakPerH ?? 0, canPerH ?? 0, tmoAckPerH ?? 0);
    serialBand = worst >= 5 ? 'strained' : 'healthy';
  }

  // ── Diurnal heatmap (raw mesh-wide timeout rate by hour-of-day) ─────────
  const toByHour = new Array<number>(HOURS).fill(0);
  const txByHour = new Array<number>(HOURS).fill(0);
  let minT0 = Infinity, maxT0 = -Infinity;
  for (const buckets of input.coarseByNode.values()) {
    for (const b of buckets) {
      const h = new Date(b.t0).getHours(); // LOCAL hour-of-day
      if (h < 0 || h >= HOURS) continue;
      toByHour[h] += b.dTimeout;
      txByHour[h] += b.dTx;
      if (b.t0 < minT0) minT0 = b.t0;
      if (b.t0 > maxT0) maxT0 = b.t0;
    }
  }
  const diurnal = toByHour.map((to, hour) => ({
    hour,
    tx: txByHour[hour],
    rate: txByHour[hour] >= MIN_HOUR_TX ? to / txByHour[hour] : null,
  }));
  const coverageDays = Number.isFinite(minT0) ? Math.max(0, (maxT0 - minT0) / 86_400_000) : 0;

  // ── Correlated degradation ─────────────────────────────────────────────
  // The mesh-interference detector owns the coherent "degraded X of Y active"
  // ratio (its narrative carries it). We do NOT re-derive a ratio here — a
  // separately-computed numerator/denominator can be incoherent (X > Y, X of 0).
  // We only count distinct symptomatic nodes for the honest inactive-case label.
  const mesh = input.symptoms.find((s) => s.kind === 'mesh-interference');
  const degradedNodes = new Set(
    input.symptoms.filter((s) => s.nodeId != null && s.kind !== 'controller-degraded').map((s) => s.nodeId),
  ).size;
  const correlated = {
    active: mesh != null,
    degradedNodes,
    narrative: mesh
      ? mesh.narrative
      : degradedNodes > 0
        ? `${degradedNodes} node${degradedNodes === 1 ? '' : 's'} degraded, but not correlated into a mesh event.`
        : 'No correlated mesh degradation.',
  };

  return {
    noise: { channels, floor, real, trend, band },
    serial: { nakPerH, canPerH, tmoAckPerH, tmoRespPerH, band: serialBand, spanH },
    diurnal,
    coverageDays,
    correlated,
  };
}
