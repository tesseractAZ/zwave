/**
 * Terminal graphics primitives — sparklines, signal bars, zone-colored meters,
 * heat cells, gauges. Every function returns a string of a KNOWN visible width
 * (color codes don't count), so callers can lay them out in fixed columns
 * without the frame ever overflowing.
 *
 * All glyphs are single-cell BMP characters:
 *   block levels  ▁▂▃▄▅▆▇█   (U+2581..U+2588)
 *   shades        ░▒▓█
 *   braille       ⠀..⣿       (U+2800.., 2×4 dot matrix per cell)
 */

import { c } from './ansi';

type ColorFn = (s: string) => string;

/** 8 vertical block levels; index 0 = lowest visible. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const SHADES = ['░', '▒', '▓', '█'] as const;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Traffic-light color by fraction (0 = bad/red, 1 = good/green). */
export function zoneColor(frac: number): ColorFn {
  const f = clamp01(frac);
  if (f >= 0.66) return c.green;
  if (f >= 0.33) return c.yellow;
  return c.red;
}

/** One vertical block glyph for a 0..1 level (empty when ≤ 0). */
export function vblock(frac: number): string {
  if (!(frac > 0)) return ' ';
  return BLOCKS[Math.min(7, Math.floor(clamp01(frac) * 8))];
}

/**
 * Block sparkline — one cell per sample, resampled (last-value bucketed) to
 * `width` cells. Auto-scales to [min,max] of the data unless given. Colored by
 * the LAST value's position in range (recent health), or a fixed color.
 */
export function sparkline(values: number[], width: number, opts: { min?: number; max?: number; color?: ColorFn } = {}): string {
  if (width <= 0) return '';
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length === 0) return c.grey('·'.repeat(width));

  const lo = opts.min ?? Math.min(...vals);
  const hi = opts.max ?? Math.max(...vals);
  const span = hi - lo || 1;

  // Most recent `width` samples; older ones scroll off the left.
  const recent = vals.slice(-width);
  const blocks = recent.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round(((v - lo) / span) * 7)))]).join('');
  const color = opts.color ?? zoneColor((recent[recent.length - 1] - lo) / span);

  const pad = width - recent.length; // leading dim dots while history fills
  return (pad > 0 ? c.grey('·'.repeat(pad)) : '') + color(blocks);
}

/**
 * WiFi-style signal strength — `bars` ascending glyphs; the lit fraction is
 * colored (by strength), the rest dim. Fixed width = `bars`.
 */
export function signalBars(frac: number, bars = 4): string {
  const f = clamp01(frac);
  const lit = Math.round(f * bars);
  const glyphs = bars === 4 ? ['▁', '▃', '▅', '▇'] : Array.from({ length: bars }, (_, i) => BLOCKS[Math.min(7, Math.floor((i / (bars - 1)) * 7))]);
  const color = zoneColor(f);
  let out = '';
  for (let i = 0; i < bars; i++) out += i < lit ? color(glyphs[i]) : c.grey(glyphs[i]);
  return out;
}

/**
 * Horizontal meter — `width` cells, `frac` filled. Zone-colored by fill unless
 * a color is given. `dir:'lowGood'` inverts the color mapping (e.g. drop%).
 */
export function meter(frac: number, width: number, opts: { color?: ColorFn; dir?: 'highGood' | 'lowGood' } = {}): string {
  if (width <= 0) return '';
  const f = clamp01(frac);
  const filled = Math.round(f * width);
  const colorFrac = opts.dir === 'lowGood' ? 1 - f : f;
  const color = opts.color ?? zoneColor(colorFrac);
  return color('█'.repeat(filled)) + c.grey('░'.repeat(Math.max(0, width - filled)));
}

/**
 * Bracketed gauge with a right-aligned label: `[██████░░] 79`. Total visible
 * width = barWidth + 3 + label.length (the brackets + a space).
 */
export function gauge(frac: number, barWidth: number, label: string, opts: { color?: ColorFn; dir?: 'highGood' | 'lowGood' } = {}): string {
  return c.grey('[') + meter(frac, barWidth, opts) + c.grey(']') + ' ' + label;
}

/** A single heat cell — a shade block colored by fraction (heatmap grids). */
export function heatCell(frac: number, opts: { none?: boolean } = {}): string {
  if (opts.none) return c.grey('·');
  const f = clamp01(frac);
  const shade = SHADES[Math.min(3, Math.floor(f * 4))];
  return zoneColor(f)(shade);
}

/**
 * Braille sparkline — 2 samples per cell using the left/right dot columns, for
 * a denser trend in the same width. Falls back to dim when empty.
 */
export function brailleSparkline(values: number[], width: number, opts: { min?: number; max?: number; color?: ColorFn } = {}): string {
  if (width <= 0) return '';
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length === 0) return c.grey('·'.repeat(width));
  const lo = opts.min ?? Math.min(...vals);
  const hi = opts.max ?? Math.max(...vals);
  const span = hi - lo || 1;
  const recent = vals.slice(-(width * 2));
  const level = (v: number): number => Math.min(3, Math.max(0, Math.round(((v - lo) / span) * 3))); // 0..3 (4 dot rows)
  // Braille dot bits: left column = dots 1,2,3,7 (0x01,0x02,0x04,0x40),
  // right column = dots 4,5,6,8 (0x08,0x10,0x20,0x80). Fill bottom-up to level.
  const LEFT = [0x40, 0x04, 0x02, 0x01];
  const RIGHT = [0x80, 0x20, 0x10, 0x08];
  const cells: string[] = [];
  for (let i = 0; i < recent.length; i += 2) {
    let bits = 0;
    const lv = level(recent[i]);
    for (let r = 3; r >= 3 - lv; r--) bits |= LEFT[r];
    if (i + 1 < recent.length) {
      const rv = level(recent[i + 1]);
      for (let r = 3; r >= 3 - rv; r--) bits |= RIGHT[r];
    }
    cells.push(String.fromCharCode(0x2800 + bits));
  }
  const pad = width - cells.length;
  const color = opts.color ?? zoneColor((recent[recent.length - 1] - lo) / span);
  return (pad > 0 ? c.grey('·'.repeat(pad)) : '') + color(cells.slice(-width).join(''));
}
