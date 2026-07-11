/**
 * ANSI terminal primitives for the telnet control-room TUI.
 *
 * Everything here is "visible-width aware": colour escape codes do not count
 * toward layout width, so padding/truncation stays correct after styling.
 * Only BMP single-cell glyphs are used (box-drawing, geometric shapes), so
 * JS string .length matches on-screen columns.
 */

export const ESC = '\x1b';
export const RESET = `${ESC}[0m`;

// Cursor / screen control
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const CLEAR_SCREEN = `${ESC}[2J`;
export const CURSOR_HOME = `${ESC}[H`;
export const CLEAR_EOL = `${ESC}[K`;
export const CLEAR_BELOW = `${ESC}[J`;

// v0.9.5 — alt screen buffer + synchronous output mode. Without these the
// TUI was glitching: partial frames from a previous redraw would leak in
// when a key/NAWS event triggered an extra draw mid-render, and leftover
// content from a wider previous frame would peek through on resize.
//
// `?1049h` puts the terminal in the "alternate screen" — separate from the
// user's scrollback, so our redraws can't smear into earlier output, and
// returning to the primary screen on disconnect cleanly restores whatever
// they had visible before connecting.
//
// `?2026h`...`?2026l` is the standard synchronized-update sequence (Kitty,
// iTerm2, Alacritty, WezTerm, recent VTE). The terminal queues output
// between the bracketing escapes and renders one atomic frame at `2026l`
// — eliminating the "characters appearing during refresh" artifacts. On
// terminals that don't recognize it the sequences are silently consumed
// (they don't render as visible bytes).
export const ENTER_ALT_BUFFER = `${ESC}[?1049h`;
export const EXIT_ALT_BUFFER = `${ESC}[?1049l`;
export const BEGIN_SYNC = `${ESC}[?2026h`;
export const END_SYNC = `${ESC}[?2026l`;

function sgr(codes: number[], s: string): string {
  return `${ESC}[${codes.join(';')}m${s}${RESET}`;
}

/** Atomic styled spans — do not nest (the inner RESET would clear the outer). */
export const c = {
  bold: (s: string) => sgr([1], s),
  dim: (s: string) => sgr([2], s),
  red: (s: string) => sgr([91], s),
  green: (s: string) => sgr([92], s),
  yellow: (s: string) => sgr([93], s),
  blue: (s: string) => sgr([94], s),
  cyan: (s: string) => sgr([96], s),
  white: (s: string) => sgr([97], s),
  grey: (s: string) => sgr([90], s),
  redB: (s: string) => sgr([1, 91], s),
  greenB: (s: string) => sgr([1, 92], s),
  yellowB: (s: string) => sgr([1, 93], s),
  cyanB: (s: string) => sgr([1, 96], s),
  whiteB: (s: string) => sgr([1, 97], s),
  /** Inverse video — used for the selected menu tab / row. */
  invert: (s: string) => sgr([7], s),
  /** Dim cyan on default — section labels. */
  label: (s: string) => sgr([96], s),
};

/** Double-line frame (heavy control-room border) + light internal rules. */
export const BOX = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝',
  h: '═', v: '║',
  lJoint: '╠', rJoint: '╣',
  lh: '─', lv: '│',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** On-screen column count of a string, ignoring ANSI escape codes. */
export function visLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Truncate to a visible width, keeping ANSI codes intact and resetting at the cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (visLen(s) <= width) return s;
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < width) {
    if (s[i] === ESC) {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + RESET;
}

/** Pad (or truncate) to an exact visible width, content left-aligned. */
export function padEnd(s: string, width: number): string {
  const len = visLen(s);
  if (len > width) return truncate(s, width);
  return s + ' '.repeat(width - len);
}

/** Pad (or truncate) to an exact visible width, content right-aligned. */
export function padStart(s: string, width: number): string {
  const len = visLen(s);
  if (len > width) return truncate(s, width);
  return ' '.repeat(width - len) + s;
}

/** Centre content within a visible width. */
export function center(s: string, width: number): string {
  const len = visLen(s);
  if (len >= width) return truncate(s, width);
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + s + ' '.repeat(width - len - left);
}

/** Left content + right content with the gap stretched between them. */
export function lr(left: string, right: string, width: number): string {
  const gap = width - visLen(left) - visLen(right);
  if (gap < 1) return truncate(left + ' ' + right, width);
  return left + ' '.repeat(gap) + right;
}

/** A horizontal meter: filled blocks + empty blocks, coloured by fill fraction. */
export function bar(frac: number, width: number, color: keyof typeof c = 'green'): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const filled = Math.round(f * width);
  return c[color]('█'.repeat(filled)) + c.grey('░'.repeat(Math.max(0, width - filled)));
}
