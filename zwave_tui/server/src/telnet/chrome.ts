/**
 * Diagnostic-console chrome — the formal, shared frame every screen wears.
 *
 * Instrument-panel discipline for an automation diagnostic technician:
 *   • a system MASTHEAD (product ident · link state · home id · timestamp),
 *   • a titled SECTION RULE that names the active screen,
 *   • labelled TELEMETRY fields (UPPERCASE label + value + unit),
 *   • a keycap COMMAND BAR ([K] LABEL) instead of a casual hint legend.
 *
 * Restraint over decoration: uppercase chrome labels, units on every value,
 * semantic colour only (green=ok / amber=warn / red=fault / cyan=info-structure /
 * grey=chrome), precise column alignment. Every helper returns a single line at
 * most `view.cols` wide (callers still own the exact-rows contract).
 */

import { c, lr, padEnd, truncate, visLen } from './ansi';
import type { DataProvider, ViewState } from '../types';

/** Product identity shown at the far left of the masthead. */
export const PRODUCT = 'ZWAVE·JS MESH DIAGNOSTICS';

export type LinkState = 'online' | 'stale' | 'offline';

const pad2 = (x: number): string => String(x).padStart(2, '0');

/** Formal, log-correlatable local timestamp: YYYY-MM-DD HH:MM:SS. */
export function stamp(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function linkTag(link: LinkState): string {
  if (link === 'online') return c.green('●') + ' ' + c.green('ONLINE');
  if (link === 'stale') return c.yellow('●') + ' ' + c.yellow('STALE');
  return c.red('●') + ' ' + c.red('OFFLINE');
}

/**
 * Row 0 — the system masthead. Product ident on the left; link state, home id
 * (wide terminals only), and the timestamp on the right.
 */
export function masthead(
  view: ViewState,
  o: { link: LinkState; homeId: number | null; now: number; apSuppressed?: string | null },
): string {
  // A SUPPRESSED SWEEP IS A STANDING CONDITION (v0.47.0), and it was legible
  // only on the ENGINE screen. An operator on OVERVIEW watching a node go quiet
  // had no way to know the one autonomous prober had stood down — the mesh
  // looked the same as one being actively watched. Rendered on EVERY screen,
  // and NOTHING when the sweep is running: an always-on chip is noise, and a
  // test that only ever asserts its presence passes for one.
  const chip = o.apSuppressed && o.apSuppressed !== 'none'
    ? c.yellow(`⚠ AUTO-PING ${o.apSuppressed.toUpperCase()}`)
    : null;
  // WHOLE FIELDS, dropped from the END. `lr` truncates the LEFT first but falls
  // back to `truncate(right, width)` once the right side alone exceeds the
  // width — which clips mid-word, and the chip sits at the front of that side.
  // Shed the timestamp, then HOME, and keep the alarm last, exactly the
  // fieldStrip discipline documented above.
  //
  // FIXED fields are never shed — the link state and the alarm. OPTIONAL ones
  // (HOME, the timestamp) go from the end. If even the fixed pair will not fit
  // beside the product name, `lr` shortens the LEFT, which is the right
  // trade: the product ident is legible from the fact you are looking at it.
  const fixed: string[] = [linkTag(o.link), ...(chip ? [chip] : [])];
  // Ordered by what an operator loses least by NOT having: the timestamp shows
  // the frame is live, so it outranks the home id. The old hardcoded
  // `cols >= 100` gate on HOME is gone — it duplicated this ladder's job while
  // making its middle rung unreachable, so the loop below was really a
  // two-state all-or-nothing.
  const optional: string[] = [c.grey(stamp(o.now))];
  if (o.homeId != null) optional.push(c.grey('HOME ') + c.white(String(o.homeId)));
  const sep = c.grey('   ');
  const left = c.whiteB(PRODUCT);
  for (let keep = optional.length; keep >= 0; keep--) {
    const right = [...fixed, ...optional.slice(0, keep)].join(sep);
    if (visLen(left) + 1 + visLen(right) <= view.cols) return lr(left, right, view.cols);
  }
  return lr(left, fixed.join(sep), view.cols);
}

/**
 * A titled section rule: `── OVERVIEW ─────────────…──── [right]`.
 * `right` (optional) is a status token pinned to the far right (rebuild /
 * filter / count) — it is drawn OUTSIDE the rule so it never gets buried.
 *
 * The right token has PRECEDENCE: when the line is too narrow for both, the
 * TITLE is shortened, never the status. The title is also legible from the
 * screen the operator just pressed a key to reach; the status (a filter, a
 * live rebuild, a scroll position) is the part that is only visible here.
 */
export function titleRule(view: ViewState, title: string, right = ''): string {
  const rightW = right ? visLen(right) + 2 : 0;
  let head = c.cyan('── ') + c.whiteB(title) + ' ';
  const headMax = Math.max(0, view.cols - rightW);
  if (visLen(head) > headMax) head = truncate(head, headMax);
  const fill = Math.max(0, view.cols - visLen(head) - rightW);
  let line = head + c.cyan('─'.repeat(fill));
  if (right) line += '  ' + right;
  return truncate(line, view.cols);
}

/** One labelled telemetry field: `LABEL value` (dim label, coloured value). */
export function field(label: string, value: string, color: (s: string) => string = c.white): string {
  return c.grey(label) + ' ' + color(value);
}

/**
 * A strip of telemetry fields separated by a fixed gutter.
 *
 * Degrades by dropping WHOLE fields (and saying how many), never by slicing one
 * in half: a clipped `NOISE -9` reads as a plausible, wrong measurement, which
 * is worse than not showing it at all.
 */
/**
 * Compose `indent + head + tail…` into as many rows as honesty requires
 * (v0.45.0).
 *
 * `fieldStrip` cannot serve here: it measures against `view.cols` with no
 * indent budget and no protected head, and it returns ONE row. The rows this
 * closes carry a head that must never be clipped (a candidate's marker, title
 * and cost tag) followed by tail tokens that are individually load-bearing —
 * a blocked-reason chip, or a list of node ids.
 *
 * The rule is `detail.ts`'s `pushRoute`, generalised: **overflow drops WHOLE
 * tokens with a dim `+N`, never a character clip.** A half-shed `#4` is a
 * different node, and `⊘ RF-link symptom — re-interviewing will not r` reads as
 * a complete sentence that stops making sense.
 *
 * @param wrapTail when a token cannot be shed because it is the whole point of
 *   the row, emit it on continuation rows at the same indent instead of
 *   dropping it — used for the blocked-reason chip, which is the one thing on a
 *   "NOT recommended" row an operator must read.
 */
export function shedLine(
  indent: string,
  head: string,
  tail: string[],
  cols: number,
  wrapTail = false,
): string[] {
  const sep = c.grey(' · ');
  const headRow = indent + head;
  // (a) The head is never shed. If it alone overflows there is nothing to
  //     compose — clip it and say nothing further, rather than emitting a
  //     continuation row under a title the operator cannot read.
  if (visLen(headRow) > cols) return [truncate(headRow, cols)];
  if (tail.length === 0) return [headRow];

  // (b) Shed whole tokens right-to-left, disclosing the count.
  for (let keep = tail.length; keep >= 1; keep--) {
    const dropped = tail.length - keep;
    const line = headRow + '  ' + tail.slice(0, keep).join(sep) + (dropped > 0 ? c.grey(` +${dropped}`) : '');
    if (visLen(line) <= cols) return [line];
  }
  // Nothing fits inline. Disclose the drop on the head row...
  const bare = headRow + c.grey(` +${tail.length}`);
  const headOut = visLen(bare) <= cols ? bare : headRow;
  if (!wrapTail) return [headOut];

  // (c) ...or, when the tail is the point of the row, carry it below. The
  //     continuation is indented one step further so it reads as belonging to
  //     the head rather than as a sibling row.
  const contIndent = indent + '  ';
  const rows = [headRow];
  for (const token of tail) {
    for (const line of wrapWords(token, Math.max(8, cols - visLen(contIndent)))) {
      rows.push(truncate(contIndent + line, cols));
    }
  }
  return rows;
}

/** Greedy word wrap. Splits on whitespace; a single over-long word is emitted
 *  on its own row and clipped by the caller rather than being broken silently. */
export function wrapWords(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && visLen(line) + 1 + visLen(w) > width) { out.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

export function fieldStrip(view: ViewState, fields: string[]): string {
  const gutter = c.grey('    ');
  const all = fields.join(gutter);
  if (visLen(all) <= view.cols) return all;
  for (let n = fields.length - 1; n >= 1; n--) {
    const kept = fields.slice(0, n).join(gutter);
    const dropped = fields.length - n;
    // Try the roomy marker first, then a tight one. The disclosure is what
    // makes the degradation honest, so it is worth a column to keep it.
    for (const lead of ['  ', ' ']) {
      const cand = kept + c.grey(`${lead}+${dropped}`);
      if (visLen(cand) <= view.cols) return cand;
    }
  }
  // No combination leaves room for the "+N" marker. Fall back to as many WHOLE
  // fields as fit without it — an undisclosed drop is a smaller lie than a
  // clipped `NOISE -9`, which reads as a plausible, wrong measurement.
  for (let n = fields.length - 1; n >= 1; n--) {
    const cand = fields.slice(0, n).join(gutter);
    if (visLen(cand) <= view.cols) return cand;
  }
  // Not even one whole field fits: report the count rather than half a value.
  const marker = c.grey(`+${fields.length}`);
  if (fields.length > 0 && visLen(marker) <= view.cols) return marker;
  return '';
}

/**
 * A command-bar keycap: the key, its label, and an optional DROP PRIORITY.
 * Priority 0 (the default) means "protected" — screen/quit/navigation keys the
 * operator needs to leave the screen. A higher number is sacrificed sooner.
 */
export type Keycap = readonly [key: string, label: string, dropPriority?: number];

/** Widest separator that fits, or null if even the tightest one overflows. */
function fitCaps(caps: string[], budget: number, suffix: string): string | null {
  if (caps.length === 0) return null;
  for (const sep of ['   ', '  ', ' ']) {
    const line = caps.join(c.grey(sep)) + suffix;
    if (visLen(line) <= budget) return line;
  }
  return null;
}

/**
 * Bottom command bar: `[K] LABEL` keycaps (cyan cap, dim label).
 *
 * Fits WHOLE keycaps. A bar cut mid-cap is actively misleading — it leaves a
 * dangling `[` that looks like a pressable key while silently hiding the ones
 * that fell off the end (at 80 cols the Overview used to lose both [T] UNITS
 * and [Q] EXIT this way). So when the caps do not fit we, in order:
 *   1. tighten the gutter (3 → 2 → 1 spaces),
 *   2. drop droppable caps, highest `dropPriority` (then rightmost) first,
 *      and disclose the count as a dim `+N`,
 *   3. only if even the protected caps overflow, fall back to a character clip.
 *
 * `reserve` holds back columns for a token the caller appends afterwards.
 */
export function commandBar(view: ViewState, keys: ReadonlyArray<Keycap>, reserve = 0): string {
  const cap = (k: Keycap): string => c.cyanB('[' + k[0] + ']') + ' ' + c.grey(k[1]);
  const budget = Math.max(0, view.cols - Math.max(0, reserve));
  const caps = keys.map(cap);

  const whole = fitCaps(caps, budget, '');
  if (whole != null) return whole;

  // Sacrifice droppable caps: least valuable (highest priority) first, and on a
  // tie the rightmost, so the bar shortens from the end the eye scans last.
  const sacrifice = keys
    .map((k, i) => ({ i, p: k[2] ?? 0 }))
    .filter((o) => o.p > 0)
    .sort((a, b) => b.p - a.p || b.i - a.i)
    .map((o) => o.i);

  const dropped = new Set<number>();
  for (const idx of sacrifice) {
    // Never sacrifice the LAST surviving cap here. Emptying the list makes
    // fitCaps return null for the rest of the loop and the bar collapses to an
    // empty row — strictly worse than one clipped cap, and it silently removes
    // the only affordance on the screen. Leave it for the clip path below.
    if (dropped.size >= keys.length - 1) break;
    dropped.add(idx);
    const kept = caps.filter((_, i) => !dropped.has(i));
    const line = fitCaps(kept, budget, c.grey(` +${dropped.size}`));
    if (line != null) return line;
  }

  // Still overflowing: the PROTECTED caps alone do not fit. Shed them from the
  // FRONT, so the rightmost — [Q], the way out — is the last thing standing.
  const survivors = keys.map((_, i) => i).filter((i) => !dropped.has(i));
  while (survivors.length > 1) {
    dropped.add(survivors.shift()!);
    const line = fitCaps(survivors.map((i) => caps[i]), budget, c.grey(` +${dropped.size}`));
    if (line != null) return line;
  }

  // One cap, and even it is too wide. Clip — but never leave a dangling `[`,
  // which reads as a key that exists and is pressable.
  const only = truncate(caps[survivors[0]] ?? '', budget);
  const open = strip(only).lastIndexOf('[');
  const close = strip(only).lastIndexOf(']');
  return open > close ? truncate(only, Math.max(0, open)) : only;
}

const SGR = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(SGR, '');

/** A plain full-width rule (section divider inside a screen body). */
export function rule(view: ViewState): string {
  return c.grey('─'.repeat(view.cols));
}

/** Roster link state, derived once and shared by every screen's masthead. */
export function linkState(data: DataProvider): LinkState {
  if (data.lastError() != null) return 'offline';
  const lu = data.lastUpdated();
  if (lu == null) return 'stale';
  return Date.now() - lu > 30_000 ? 'stale' : 'online';
}

export interface FrameOpts {
  /** Section name shown in the title rule. */
  title: string;
  /** Optional far-right token on the title rule (status / count / filter). */
  rightStatus?: string;
  /** Optional telemetry strip drawn directly under the rule. */
  telemetry?: string;
  /** Body lines (each already styled + ≤ cols). Padded/clamped to fit. */
  body: string[];
  /** Command-bar keycaps. */
  keys: ReadonlyArray<Keycap>;
  /** Columns to hold back on the command bar for a token the caller appends. */
  keysReserve?: number;
}

/**
 * The whole-screen frame every content screen wears: masthead · titled rule ·
 * [telemetry] · body (padded to fill) · command bar. Returns EXACTLY
 * `view.rows` lines ≤ `view.cols` — the screen only has to supply its body.
 */
export function frame(view: ViewState, data: DataProvider, o: FrameOpts): string[] {
  const out: string[] = [];
  out.push(masthead(view, { link: linkState(data), homeId: data.controller()?.homeId ?? null, now: Date.now(), apSuppressed: data.autoPingState?.()?.suppressed ?? null }));
  out.push(titleRule(view, o.title, o.rightStatus ?? ''));
  if (o.telemetry != null) out.push(truncate(o.telemetry, view.cols));
  const top = out.length;
  const bodyCap = Math.max(0, view.rows - top - 1); // reserve the command bar
  // A body taller than the frame is DISCLOSED, not silently dropped: a screen
  // that quietly loses its last section (Interference's CORRELATED block, the
  // Controller's NETWORK HEALTH roll-up) reads as "nothing to report".
  const hidden = Math.max(0, o.body.length - bodyCap);
  for (let i = 0; i < bodyCap; i++) {
    const isLast = i === bodyCap - 1;
    if (isLast && hidden > 0) {
      out.push(truncate(c.grey(`  ↓ ${hidden + 1} more line${hidden ? 's' : ''} hidden — enlarge the terminal`), view.cols));
    } else {
      out.push(o.body[i] != null ? truncate(o.body[i], view.cols) : '');
    }
  }
  out.push(commandBar(view, o.keys, o.keysReserve ?? 0));
  return out.slice(0, view.rows);
}

/* ── column composition ──────────────────────────────────────────────────── */

/** One column in an `hstack`: its content lines and the columns it occupies. */
export interface StackCol {
  lines: string[];
  w: number;
}

/**
 * Compose columns SIDE BY SIDE into one block of lines.
 *
 * Every screen that wanted two panes was hand-rolling this, which is why none
 * of them did: getting it wrong breaks the frame contract in a way that is
 * invisible until a specific width. The guarantees here are the whole point.
 *
 *   • Output height = the TALLEST column. Shorter columns are blank-filled, so
 *     a ragged pair still yields rectangular rows.
 *   • Every output line is EXACTLY `Σ w + gap × (n−1)` visible columns — each
 *     cell is truncated to its own width and then padded back up to it, so a
 *     long line in one column can never shove the next column rightwards.
 *   • Padding uses padEnd/truncate (ANSI-aware), so SGR codes never count
 *     toward width and a truncated cell cannot leak an unterminated colour into
 *     its neighbour.
 *
 * Columns whose width collapses below 1 are dropped rather than rendered as a
 * sliver — the caller decides breakpoints; this just refuses to draw nonsense.
 */
export function hstack(cols: readonly StackCol[], gap = 2): string[] {
  const live = cols.filter((c) => c.w >= 1);
  if (live.length === 0) return [];
  const height = live.reduce((h, c) => Math.max(h, c.lines.length), 0);
  const sep = ' '.repeat(Math.max(0, gap));
  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    out.push(live.map((c) => padEnd(truncate(c.lines[r] ?? '', c.w), c.w)).join(sep));
  }
  return out;
}

/**
 * Split `total` columns into `n` panes of near-equal width, accounting for the
 * gaps between them. Returns [] when the result would be narrower than `min`
 * per pane — the caller's signal to fall back to fewer panes (or one).
 *
 * Remainder columns go to the LEFTMOST panes, which is where the denser content
 * conventionally sits.
 */
export function splitCols(total: number, n: number, gap = 2, min = 24): number[] {
  if (n < 1) return [];
  const usable = total - gap * (n - 1);
  if (usable < min * n) return [];
  const base = Math.floor(usable / n);
  const extra = usable - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
