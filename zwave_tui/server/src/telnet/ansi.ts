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
// C0 controls + DEL + **C1** (U+0080–U+009F). After the SGR codes above are
// accounted for, anything left in these ranges occupies no column but WILL
// wreck the frame (a stray \n splits one row into two, \r rewinds it, \b eats a
// cell). Width math must not count them, and truncate() drops them so they can
// never reach the wire.
//
// ★ C1 was missing until v0.24.4, so that last promise was false for exactly
//   the bytes that matter most: U+009B is an 8-bit CSI and U+009D an 8-bit OSC,
//   and xterm.js on the /console path EXECUTES both. The data-boundary
//   sanitizer already strips \x7f-\x9f and names "the 8-bit CSI 0x9b" as the
//   reason — this backstop, the thing that is supposed to catch whatever the
//   boundary missed, did not. Any string reaching a frame without passing
//   sanitizeLabel/sanitizeEventText therefore had no backstop at all.
const CTL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const IS_CTL = /[\x00-\x1f\x7f-\x9f]/; // non-global: safe for single-character tests

/** On-screen column count of a string, ignoring ANSI escape codes. */
export function visLen(s: string): number {
  return s.replace(ANSI_RE, '').replace(CTL_RE, '').length;
}

/** Truncate to a visible width, keeping ANSI codes intact and resetting at the cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  // Fast path: already fits and carries no frame-breaking control noise.
  if (visLen(s) <= width && !IS_CTL.test(s.replace(ANSI_RE, ''))) return s;
  let out = '';
  let vis = 0;
  let i = 0;
  let clipped = false;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    // Zero-width control noise: drop it rather than let it break the row.
    if (IS_CTL.test(s[i])) { i++; continue; }
    if (vis >= width) { clipped = true; break; }
    out += s[i];
    vis++;
    i++;
  }
  return clipped ? out + RESET : out;
}

/**
 * Clip to a visible width by dropping WHOLE WORDS, marking the loss with `…`.
 *
 * `truncate` cuts mid-character and says nothing, which on prose is merely
 * ugly but on a VALUE is a lie: an Activity Log row reading `812 → 1240` came
 * back as `812 → 12`, a different, entirely plausible number, on the same
 * frame whose Detail row showed the true one. This is `shedLine`'s whole-token
 * rule (chrome.ts) applied to a single string that has no tokens to shed.
 *
 * TWO columns are reserved, not one. The marker is separated by a space
 * because `140…` cannot be read as "140, and more" rather than "1400" — the
 * gap is what makes the marker a marker instead of another digit. Do not
 * reclaim that column.
 *
 * A single over-long word cannot be shed whole, so it is clipped and the
 * marker sits flush: the cut is already visible INSIDE the word, so there is
 * no ambiguity for the space to resolve.
 */
export function clipWords(s: string, width: number): string {
  if (width <= 0) return '';
  if (visLen(s) <= width && !IS_CTL.test(s.replace(ANSI_RE, ''))) return s;
  const budget = width - 2;
  if (budget <= 0) return truncate(s, width);
  let out = '';
  let vis = 0;
  for (const part of s.split(/(\s+)/)) {
    const n = visLen(part);
    if (vis + n > budget) break;
    out += part;
    vis += n;
  }
  out = out.replace(/\s+$/, '');
  // `truncate` restores the control-byte scrub this function's split bypasses.
  if (!out) return truncate(s, width - 1) + '…';
  return truncate(out, budget) + ' …';
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

/**
 * Left content + right content with the gap stretched between them.
 *
 * When the two cannot both fit, the RIGHT side is kept whole and the LEFT is
 * shortened. The right operand is nearly always the live one — a value, a
 * status, a count — while the left is a static label the operator can infer.
 * (The old behaviour clipped the right operand away entirely.)
 */
export function lr(left: string, right: string, width: number): string {
  const gap = width - visLen(left) - visLen(right);
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  const rw = visLen(right);
  if (rw >= width) return truncate(right, width);
  return truncate(left, Math.max(0, width - rw - 1)) + ' ' + right;
}
