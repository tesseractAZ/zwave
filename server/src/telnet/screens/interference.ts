/**
 * INTERFERENCE screen (M6, DESIGN.md §3.7) — key `8`/`f` (`i` is the
 * re-interview action). The mesh's RF environment on one screen, read from the
 * pre-computed `data.interference()` view (the heavy coarse-bucket fold is
 * memoized in the data layer):
 *
 *   NOISE FLOOR   per-channel 900 MHz background RSSI + a recent trend spark
 *                 (the ~40-min controller ring) AND a `days` spark over the
 *                 persisted multi-day coarse tier, downsampled so its cells span
 *                 the whole retained history — the driver-WS measurement (HA
 *                 strips it). Lower = quieter.
 *   SERIAL LINK   controller host↔stick NAK/CAN/timeout rates, shown APART: a
 *                 serial fault mimics mesh-wide RF trouble.
 *   DIURNAL HEAT  hour-of-day mesh-wide RAW timeout rate — deliberately NOT
 *                 baseline-relative (banded baselines are blind to recurring
 *                 diurnal interference; this is what they absorbed).
 *   CORRELATED    the current mesh-interference state (inferred-by-exclusion).
 *
 * Pure render: exactly `view.rows` lines, each ≤ `view.cols`.
 */

import { c, truncate, padStart } from '../ansi';
import { sparkline, heatCell } from '../gauges';
import type { ScreenCtx, InterferenceView } from '../../types';
import { frame } from '../chrome';

type ColorFn = (s: string) => string;

/** Absolute heat scale for the diurnal map: 0 → 5% maps across the four shades.
 *  Above ~5% per-command timeout is well beyond a healthy mesh's ~2%. Absolute,
 *  NOT normalized-to-max — a normalized scale would be baseline-relative, the
 *  exact thing this heatmap exists to avoid. */
const HEAT_MAX = 0.05;

/** Downsample a series into ≤`cells` mean-of-bin points so a fixed-width
 *  sparkline spans the WHOLE series, not just its last `cells` samples
 *  (`sparkline` tail-slices; a multi-day trend must not silently collapse to its
 *  most-recent tail while its label claims the full span). */
export function downsampleMean(vals: number[], cells: number): number[] {
  if (vals.length <= cells) return vals;
  const out: number[] = [];
  for (let i = 0; i < cells; i++) {
    const lo = Math.floor((i * vals.length) / cells);
    const hi = Math.floor(((i + 1) * vals.length) / cells);
    let sum = 0, n = 0;
    for (let j = lo; j < hi; j++) { sum += vals[j]; n++; }
    out.push(n > 0 ? sum / n : vals[Math.min(lo, vals.length - 1)]);
  }
  return out;
}

const NOISE_COLOR: Record<InterferenceView['noise']['band'], ColorFn> = {
  clean: c.green, elevated: c.yellow, noisy: c.redB, unknown: c.grey,
};
const SERIAL_COLOR: Record<InterferenceView['serial']['band'], ColorFn> = {
  healthy: c.green, strained: c.yellowB, unknown: c.grey,
};

function dbm(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}`;
}

/** Per-hour rate as a heat cell (grey dot when the hour had no real traffic).
 *  Explicit colour: heatCell's DEFAULT zoneColor is built for SNR margin
 *  (high = good = green); a timeout RATE is the opposite (high = bad = red), so
 *  we pass heatColorFor to invert it — else a hot hour would render green. */
function heatFor(rate: number | null): string {
  if (rate == null) return heatCell(0, { none: true });
  return heatCell(rate / HEAT_MAX, { color: heatColorFor(rate) });
}

export function renderInterference(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const iv = data.interference();
  const body: string[] = [];
  const push = (s = ''): void => { body.push(truncate(s, W)); };

  // ── NOISE FLOOR ─────────────────────────────────────────────────────────
  push(c.label('NOISE FLOOR') + c.grey(' — 900 MHz background RSSI (driver-measured)'));
  if (!iv.noise.real) {
    push('  ' + c.grey('◷ unavailable — the read-only driver-WS client is not connected.'));
    push('  ' + c.grey('    (HA strips backgroundRSSI; set driver_ws_url to enable this.)'));
  } else {
    const nc = NOISE_COLOR[iv.noise.band];
    const chans = iv.noise.channels
      .map((v, i) => c.grey(`ch${i} `) + (v == null ? c.grey('—') : c.white(padStart(dbm(v), 4))))
      .join('  ');
    push('  ' + chans + c.grey('   median ') + nc(`${dbm(iv.noise.floor)} dBm`) + '  ' + nc('● ' + iv.noise.band));
    // Fixed −110..−80 dBm scale so a flat quiet floor reads FLAT+LOW and a real
    // rise visibly climbs — an auto-scaled spark would amplify ±1 dB jitter into
    // fake spikes.
    const spark = iv.noise.trend.length >= 2
      ? sparkline(iv.noise.trend, Math.min(24, iv.noise.trend.length), { min: -110, max: -80, color: c.cyan })
      : c.grey('· building trend');
    push('  ' + c.grey('trend ') + spark + c.grey('   lower = quieter · ~-110 dBm near-radio ideal'));
    // Long-horizon floor: the persisted 30-min coarse tier, SAME fixed scale as
    // the fine trend above so the two are directly comparable at a glance.
    if (iv.noise.trendCoarse.length >= 2) {
      const days = iv.noise.trendCoarseDays;
      const span = days >= 1 ? `${days.toFixed(days >= 10 ? 0 : 1)}d` : `${Math.max(1, Math.round(days * 24))}h`;
      // Downsample the full retained series into the 24 drawn cells so the spark
      // actually spans `span`, not just its most-recent 24 buckets (12 h).
      const cells = downsampleMean(iv.noise.trendCoarse, 24);
      const coarseSpark = sparkline(cells, cells.length, { min: -110, max: -80, color: c.cyan });
      push('  ' + c.grey('days  ') + coarseSpark + c.grey(`   ${span} span (persisted 30-min buckets, survives restarts)`));
    } else {
      push('  ' + c.grey('days  ') + c.grey('· building multi-day history'));
    }
  }
  push();

  // ── CONTROLLER SERIAL LINK ──────────────────────────────────────────────
  push(c.label('CONTROLLER SERIAL LINK') + c.grey(' — host ↔ stick'));
  if (iv.serial.band === 'unknown') {
    push('  ' + c.grey('◷ not enough controller-sample history yet.'));
  } else {
    const sc = SERIAL_COLOR[iv.serial.band];
    const rate = (x: number | null): string => (x == null ? '—' : `${Math.round(x)}/h`);
    push(
      '  ' +
      [
        c.grey('NAK ') + c.white(rate(iv.serial.nakPerH)),
        c.grey('CAN ') + c.white(rate(iv.serial.canPerH)),
        c.grey('tmo-ACK ') + c.white(rate(iv.serial.tmoAckPerH)),
        c.grey('reply-tmo ') + c.white(rate(iv.serial.tmoRespPerH)),
      ].join(c.grey(' · ')) + '   ' + sc('● ' + iv.serial.band),
    );
    push('  ' + c.grey(`a serial fault mimics mesh-wide RF trouble — shown apart · ${iv.serial.spanH.toFixed(1)}h window`));
  }
  push();

  // ── DIURNAL HEATMAP ─────────────────────────────────────────────────────
  push(c.label('DIURNAL TIMEOUT-RATE HEATMAP') + c.grey(' — mesh-wide, raw (not baseline-relative)'));
  if (iv.coverageDays < 0.5) {
    push('  ' + c.grey('◷ building — needs coarse history across the day (a few days).'));
  } else {
    push('  ' + c.grey(hourAxis()));
    push('  ' + iv.diurnal.map((d) => heatFor(d.rate)).join(''));
    // Worst hour + legend.
    const worst = [...iv.diurnal].filter((d) => d.rate != null).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
    const worstStr = worst
      ? c.grey('worst ') + c.white(`${String(worst.hour).padStart(2, '0')}:00 `) + heatColorFor(worst.rate ?? 0)(`${((worst.rate ?? 0) * 100).toFixed(1)}%`)
      : c.grey('no rated hours yet');
    push('  ' + worstStr + c.grey(`   ${iv.coverageDays.toFixed(0)} day${iv.coverageDays >= 1.5 ? 's' : ''} · a persistently hot hour = recurring interference`));
  }
  push();

  // ── CORRELATED DEGRADATION ──────────────────────────────────────────────
  // The detector owns the ratio — the narrative carries "degraded X of Y active"
  // when a mesh event is live; we never re-derive a (possibly incoherent) ratio.
  push(c.label('CORRELATED DEGRADATION'));
  if (iv.correlated.active) {
    push('  ' + c.yellowB('⚠ correlated mesh degradation'));
    for (const line of wrap(iv.correlated.narrative, W - 4).slice(0, 2)) push('    ' + c.grey(line));
  } else {
    push('  ' + c.green('✓ ') + c.grey(iv.correlated.narrative));
  }

  // Surface an ACTIVE correlated event in the title rule too — it is the last
  // body section and could be clipped on a short terminal; the title never is.
  const noiseStr = iv.noise.real ? `${iv.noise.band} · ${dbm(iv.noise.floor)} dBm` : 'noise n/a';
  const right = iv.correlated.active ? c.yellowB('⚠ correlated') + c.grey(' · ') + noiseStr : noiseStr;
  return frame(view, data, {
    title: 'INTERFERENCE',
    rightStatus: right,
    body,
    keys: [['1-8', 'SCREENS'], ['Q', 'BACK']],
  });
}

/** A 24-char hour axis with markers at 0/6/12/18/23 aligned under the strip. */
function hourAxis(): string {
  const cells = Array(24).fill(' ');
  for (const h of [0, 6, 12, 18]) {
    const s = String(h);
    for (let i = 0; i < s.length && h + i < 24; i++) cells[h + i] = s[i];
  }
  // 23 marker (two chars would overrun; place a lone '23' ending at col 23).
  cells[22] = '2'; cells[23] = '3';
  return cells.join('');
}

/** Colour a rate for the worst-hour label, matching the heat gradient. */
function heatColorFor(rate: number): ColorFn {
  const f = rate / HEAT_MAX;
  if (f >= 0.75) return c.redB;
  if (f >= 0.5) return c.yellowB;
  if (f >= 0.25) return c.yellow;
  return c.green;
}

/** Naive word-wrap (narratives carry no ANSI). */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) { if (line) out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}
