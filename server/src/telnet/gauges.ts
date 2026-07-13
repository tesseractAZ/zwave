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

// Non-finite → 0, else clamped to [0,1]. Guarding NaN here keeps every gauge's
// width contract (a NaN frac must not render "undefined" or collapse to width 0).
const clamp01 = (x: number): number => (Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0);

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
  // A flat (all-equal) series reads as "steady" — a mid-height grey line rather
  // than a red row of lowest blocks (which the relative-scale default would give).
  const flat = hi === lo;
  const blocks = recent
    .map((v) => (flat ? BLOCKS[3] : BLOCKS[Math.min(7, Math.max(0, Math.round(((v - lo) / span) * 7)))]))
    .join('');
  const color = opts.color ?? (flat ? c.grey : zoneColor((recent[recent.length - 1] - lo) / span));

  const pad = width - recent.length; // leading dim dots while history fills
  return (pad > 0 ? c.grey('·'.repeat(pad)) : '') + color(blocks);
}

/**
 * WiFi-style signal strength — `bars` ascending glyphs; the lit fraction is
 * colored (by strength), the rest dim. Fixed width = `bars`.
 */
export function signalBars(frac: number, bars = 4, colorOverride?: ColorFn): string {
  const f = clamp01(frac);
  const lit = Math.round(f * bars);
  // Divisor guarded so bars<=1 can't produce a NaN glyph index ("undefined").
  const glyphs = bars === 4
    ? ['▁', '▃', '▅', '▇']
    : Array.from({ length: bars }, (_, i) => BLOCKS[Math.min(7, Math.floor((i / Math.max(1, bars - 1)) * 7))]);
  const color = colorOverride ?? zoneColor(f);
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

/** A single heat cell — a shade block whose DENSITY tracks the fraction and whose
 *  COLOR is `opts.color` (so callers can align it to their own band) or zoneColor. */
export function heatCell(frac: number, opts: { none?: boolean; color?: ColorFn } = {}): string {
  if (opts.none) return c.grey('·');
  const f = clamp01(frac);
  const shade = SHADES[Math.min(3, Math.floor(f * 4))];
  return (opts.color ?? zoneColor(f))(shade);
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
  // LEFT/RIGHT are ordered bottom→top (index 0 = the bottom dot), so filling
  // indices 0..level lights the column BOTTOM-UP (a low value = a short mark at
  // the cell bottom, matching the block sparkline — not vertically inverted).
  const LEFT = [0x40, 0x04, 0x02, 0x01];
  const RIGHT = [0x80, 0x20, 0x10, 0x08];
  const cells: string[] = [];
  for (let i = 0; i < recent.length; i += 2) {
    let bits = 0;
    const lv = level(recent[i]);
    for (let r = 0; r <= lv; r++) bits |= LEFT[r];
    if (i + 1 < recent.length) {
      const rv = level(recent[i + 1]);
      for (let r = 0; r <= rv; r++) bits |= RIGHT[r];
    }
    cells.push(String.fromCharCode(0x2800 + bits));
  }
  const pad = width - cells.length;
  const color = opts.color ?? zoneColor((recent[recent.length - 1] - lo) / span);
  return (pad > 0 ? c.grey('·'.repeat(pad)) : '') + color(cells.slice(-width).join(''));
}

/** ms → compact elapsed: "45s" / "3m12s" / "1h05m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** A braille spinner glyph for the given epoch-ms (advances at the redraw rate). */
export function spinner(nowMs: number): string {
  return SPIN_FRAMES[Math.floor(nowMs / 120) % SPIN_FRAMES.length];
}
