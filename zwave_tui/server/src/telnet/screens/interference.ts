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
import { MIN_HOUR_TX } from '../../zwave/interference';
import { sparkline, heatCell, chartRows } from '../gauges';
import { noiseColor, timeoutPctColor } from '../bands';
import type { ScreenCtx, InterferenceView } from '../../types';
import { frame, shedLine } from '../chrome';

type ColorFn = (s: string) => string;

/** Absolute heat scale for the diurnal map: 0 → 5% maps across the four shades.
 *  Above ~5% per-command timeout is well beyond a healthy mesh's ~2%. Absolute,
 *  NOT normalized-to-max — a normalized scale would be baseline-relative, the
 *  exact thing this heatmap exists to avoid. */
const HEAT_MAX = 0.05;

/** dB by which the bucket PEAK must exceed the mean-of-means before the row
 *  calls it out as an EVENT rather than a routine reading. */
const NOISE_PEAK_NOTABLE_DB = 3;

/**
 * The peak callout, split so the CLAIM sits in shedLine's head and the
 * EXPLANATION is a tail token it can shed whole.
 *
 * The first cut of this fix put the whole sentence in the head — and
 * `shedLine`'s head has no whole-token path (`visLen(headRow) > cols` falls
 * straight to `truncate`), so at 80x24 it rendered
 * `peak -94 dBm (4 dB above the mean —` : the same defect v0.51.0 closed in
 * REMEDY, reintroduced one screen over. Caught on the live mesh, not by a test.
 */
function peakHead(peak: number | null, notable: boolean): string {
  if (peak == null) return '';
  const base = `  peak ${Math.round(peak)} dBm`;
  return notable ? c.yellow(base) : c.grey(base);
}

/** The tail token — shed whole, never clipped. */
function peakWhy(peak: number | null, meanOfMeans: number | null, notable: boolean): string[] {
  if (peak == null || meanOfMeans == null || !notable) return [];
  return [c.grey(`(${Math.round(peak - meanOfMeans)} dB above the mean — a burst the mean hides)`)];
}

/** Downsample a series into ≤`cells` mean-of-bin points so a fixed-width
 *  sparkline spans the WHOLE series, not just its last `cells` samples
 *  (`sparkline` tail-slices; a multi-day trend must not silently collapse to its
 *  most-recent tail while its label claims the full span). */
export function downsampleMean(vals: readonly number[], cells: number): number[] {
  // Copy on pass-through: the input may be a READONLY view (history()), and
  // this function promises a fresh mutable array either way.
  if (vals.length <= cells) return [...vals];
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
  const H = view.rows;
  const iv = data.interference();
  // Rows this screen may spend beyond its compact form. The screen's own
  // measured problem was VERTICAL: at 200x60 it drew 842 characters and left 44
  // rows blank, because two multi-day series were each compressed into a single
  // sparkline row. Surplus rows are spent DRAWING THAT DATA at a resolution it
  // can actually be read at — this adds ink from readings already collected and
  // persisted, rather than moving existing ink around.
  const compactRows = 20; // the pre-v0.28 body height, measured
  const surplus = Math.max(0, (H - 3) - compactRows);
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
    // The NUMBER is coloured by the shared dBm bands (bands.ts) so the same
    // reading looks the same here as on the Overview, Controller and Heatmap —
    // it previously took the engine's BAND colour, which made a quiet -95 dBm
    // floor render green here and grey everywhere else. The band badge keeps
    // its own colour: it is the engine's classification, a different claim.
    const floorC = iv.noise.floor == null ? c.grey : noiseColor(iv.noise.floor);
    push('  ' + chans + c.grey('   median ') + floorC(`${dbm(iv.noise.floor)} dBm`) + '  ' + nc('● ' + iv.noise.band));
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
      // Tall frames draw the persisted history as a real chart: more cells
      // ACROSS (so more of the retained series is represented, not just the
      // newest 24 buckets) and rows DOWN (so a 2 dB drift is visible instead of
      // rounded into one glyph). The fixed -110..-80 scale is kept so this and
      // the fine trend above stay directly comparable.
      // THE PEAK IS NOT A CHART DECORATION (v0.56.0). Each bucket's noisiest
      // sample is folded and persisted, and was averaged away before it reached
      // the screen — so a five-minute burst diluted across 30 quiet minutes
      // drew a flat line. v0.49.0 reported it, but only INSIDE the chart gate
      // below, which needs `surplus >= 6`: at the modal 80x24 there is no chart
      // and there was therefore no callout, so a measured 40 dB burst rendered
      // BYTE-IDENTICAL to a flat trend — the exact symptom the fix was for.
      const maxes = iv.noise.trendCoarseMax;
      const peak = maxes.length ? Math.max(...maxes) : null;
      const meanOfMeans = iv.noise.trendCoarse.length
        ? iv.noise.trendCoarse.reduce((a, b) => a + b, 0) / iv.noise.trendCoarse.length
        : null;
      const notable = peak != null && meanOfMeans != null && peak - meanOfMeans >= NOISE_PEAK_NOTABLE_DB;
      const chartH = surplus >= 12 ? 6 : surplus >= 6 ? 4 : 0;
      if (chartH > 0) {
        const w = Math.max(24, Math.min(iv.noise.trendCoarse.length, W - 12));
        const cells = downsampleMean(iv.noise.trendCoarse, w);
        const rows = chartRows(cells, w, chartH, { min: -110, max: -80, color: c.cyan });
        // THE PEAK, ALONGSIDE THE MEAN (v0.49.0). Each bucket's noisiest sample
        // is folded and persisted and was averaged away before it reached here,
        // so a five-minute burst diluted across 30 quiet minutes drew a flat
        // line — and the burst is the event worth seeing. Reported as a number
        // rather than a second chart: two overlaid series on an 8-level glyph
        // ramp would imply a resolution the ramp does not have.
        // WHOLE TOKENS (v0.56.0): this was one concatenation ending in `push`'s
        // blind truncate, which cut `(23 dB above the mean...` to `(2` — a
        // number that reads as complete and is off by an order of magnitude.
        for (const l of shedLine(
          '  ',
          c.grey(`days  ${span} span`) + peakHead(peak, notable),
          [...peakWhy(peak, meanOfMeans, notable), c.grey('(persisted 30-min buckets, survives restarts)')],
          W,
          // NOT wrapped: a continuation row costs the CORRELATED DEGRADATION
          // hedge its third line at 80x24 (v0.51.0 pinned that hedge because
          // losing it turns a guess into a verdict). These tails shed with `+N`
          // instead — disclosed, and free.
          /* wrapTail */ false,
        )) body.push(l);
        rows.forEach((line, i) => {
          // Label the scale ends only — an axis tick per row would imply a
          // precision the 8-level glyph does not have.
          const tag = i === 0 ? ' -80 ' : i === rows.length - 1 ? '-110 ' : '     ';
          push('  ' + c.grey(tag) + line);
        });
      } else {
        const cells = downsampleMean(iv.noise.trendCoarse, 24);
        const coarseSpark = sparkline(cells, cells.length, { min: -110, max: -80, color: c.cyan });
        // THE MODAL TERMINAL LANDS HERE. Whole-token shedding, and the peak is
        // in the protected head: at 80x24 a 40 dB burst used to be invisible
        // because the callout lived only in the chart branch above.
        for (const l of shedLine(
          '  ',
          c.grey('days  ') + coarseSpark + c.grey(`   ${span} span`) + peakHead(peak, notable),
          [...peakWhy(peak, meanOfMeans, notable), c.grey('(persisted 30-min buckets, survives restarts)')],
          W,
          // NOT wrapped: a continuation row costs the CORRELATED DEGRADATION
          // hedge its third line at 80x24 (v0.51.0 pinned that hedge because
          // losing it turns a guess into a verdict). These tails shed with `+N`
          // instead — disclosed, and free.
          /* wrapTail */ false,
        )) body.push(l);
      }
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
    // A 24-cell heat strip answers "which hour is hot" but not "by how much".
    // With rows to spare, draw the rates as a chart above the strip: same 24
    // hours, same data, at a resolution that shows the shape of the day.
    const dH = surplus >= 12 ? 5 : surplus >= 6 ? 3 : 0;
    if (dH > 0) {
      // ABSOLUTE scale and PER-HOUR band colour — the same HEAT_MAX and
      // heatColorFor the strip below uses. The first version auto-scaled to the
      // peak in flat yellow, which is precisely what this screen's own comment
      // forbids: on a uniformly healthy mesh every hour became a solid warning
      // block above a strip showing all-clear green, for the same 24 numbers.
      // Nulls stay null so an unrated hour draws the no-data dot, matching the
      // strip's `·` instead of asserting a measured 0%.
      const rates = iv.diurnal.map((d) => (d.rate == null ? null : d.rate * 100));
      const rows = chartRows(rates, 24, dH, {
        min: 0,
        max: HEAT_MAX * 100,
        colorFor: (v) => heatColorFor(v / 100),
      });
      const capTag = `${(HEAT_MAX * 100).toFixed(0)}%+`.padStart(5) + ' ';
      rows.forEach((line, i) => {
        const tag = i === 0 ? capTag : i === rows.length - 1 ? '   0% ' : '      ';
        push('  ' + c.grey(tag) + line);
      });
      push('  ' + '      ' + c.grey(hourAxis()));
      push('  ' + '      ' + iv.diurnal.map((d) => heatFor(d.rate)).join(''));
    } else {
      push('  ' + c.grey(hourAxis()));
      push('  ' + iv.diurnal.map((d) => heatFor(d.rate)).join(''));
    }
    // Worst hour + legend.
    // THE DENOMINATOR IS THE STORY (v0.49.0). `tx` is computed, carried across
    // the provider boundary and rendered nowhere, so the "worst hour" was
    // picked on rate alone — and at the MIN_HOUR_TX floor of 20 a SINGLE
    // timeout is a 5% rate, which is exactly HEAT_MAX. One dropped frame in a
    // quiet hour therefore won "worst hour" outright over a genuinely bad hour
    // with thousands of transmissions behind it.
    //
    // Prefer hours with at least median traffic; fall back to the plain max so
    // the line never disappears, and SAY when the winner is thin.
    const rated = iv.diurnal.filter((d) => d.rate != null);
    const medTx = rated.length
      ? [...rated].map((d) => d.tx).sort((a, b) => a - b)[Math.floor(rated.length / 2)]
      : 0;
    const solid = rated.filter((d) => d.tx >= medTx);
    const pool = solid.length >= 3 ? solid : rated;
    const worst = [...pool].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
    const thin = worst != null && worst.tx < 4 * MIN_HOUR_TX;
    const worstStr = worst
      ? c.grey('worst ') + c.white(`${String(worst.hour).padStart(2, '0')}:00 `) +
        heatColorFor(worst.rate ?? 0)(`${((worst.rate ?? 0) * 100).toFixed(1)}%`) +
        c.grey(` of ${worst.tx} tx`) +
        (thin ? c.yellow(' — thin hour, one timeout moves this a lot') : '')
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
    // NOT capped (v0.51.0). The old `.slice(0, 2)` dropped, at 80 columns, the
    // entire hedge — "treat as a lead, not a verdict" — from a symptom whose
    // basis is 'inferred' and whose basis this screen never renders, leaving a
    // guess reading as a finding. At the modal 80x24 the body is 19 of 21 rows,
    // so the third line is free; where it is not, frame() substitutes its own
    // "N more lines hidden" row, which DISCLOSES the loss instead of hiding it.
    for (const line of wrap(iv.correlated.narrative, W - 4)) push('    ' + c.grey(line));
    // A companion count, NOT the event's reach (v0.35, reworded on review).
    // `degradedNodes` counts distinct nodes carrying ANY per-node symptom right
    // now — including faults with no relationship to this event (a dead-flap,
    // an S2 storm). Calling that the event's "scope" over-claimed what the
    // detector correlated, so it is labelled as what it is: the mesh-wide
    // symptom count while the event runs. Still worth a row — it is the
    // difference between "an RF event, and otherwise healthy" and "an RF event
    // on top of three unrelated fires".
    if (iv.correlated.degradedNodes > 0) {
      const k = iv.correlated.degradedNodes;
      push('    ' + c.grey('meanwhile · ') + c.white(String(k)) +
        c.grey(` node${k === 1 ? '' : 's'} symptomatic across ALL detectors — not necessarily this event`));
    }
  } else if (iv.correlated.degradedNodes > 0) {
    // A GREEN ✓ IS THE ALL-CLEAR MARK (v0.52.0), and this branch's narrative
    // names degraded nodes. `active` is "correlated into a mesh event";
    // `degradedNodes` counts ANY per-node symptom, so a single weak-signal
    // gives active=false with degradedNodes=1 — and the screen ticked a line
    // reading "1 node degraded, but not correlated into a mesh event."
    // Not correlated is not the same as nothing wrong.
    push('  ' + c.grey('· ') + c.grey(iv.correlated.narrative));
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
    keys: [['1-9', 'SCREENS'], ['Q', 'BACK']],
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
/**
 * Colour for an hourly timeout RATE.
 *
 * DELIBERATELY NOT the shared `timeoutPctColor`. That band grades ONE NODE's
 * lifetime timeout percentage; this grades a MESH-WIDE hourly aggregate —
 * every node's timeouts over every node's TX in that hour. A 5% hour across the
 * whole mesh is already severe, well before the per-node band would call 5%
 * anything but acceptable, so sharing the ramp would desensitise the aggregate
 * exactly where it matters. Different population, different scale (HEAT_MAX),
 * and the axis legend states the scale it is drawn on.
 */
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
