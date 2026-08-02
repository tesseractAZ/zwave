/**
 * OVERVIEW — the home screen.
 *
 * A dense, live, control-room node table sorted worst-health-first, framed by
 * a summary bar up top and a hotkey legend at the bottom. Designed to sit in
 * an 80x24 terminal and stay readable: single-cell glyphs, ANSI-aware column
 * padding, one row per node.
 *
 *   summary  39 nodes · 35 alive · 1 DEAD · 3 asleep · 2 flaky · noise -92dBm · mesh ████░░
 *   header   ID St Name             Sc      Signal  Hop  Rate  Seen  Bat  Flags   Trend
 *   rows     ▶  12 ● Kitchen Lamp  █94  ▁▃▅▇  +21dB    0   100k    3s   AC          ▁▂▄▆█
 *              7 ✕ Garage Sensor    —          —      —    —      4d  12%  D B
 *   legend   j/k move · / filter · s sort · ⏎ detail · 1-8 screens · q quit
 *
 * Graphics (from ../gauges) sit ON TOP of the already-correct data: a WiFi
 * signalBars strength cluster in the Signal column, a 1-cell vblock health mark
 * beside the Score, a right-hand RSSI micro-sparkline that only appears on wide
 * terminals (cols ≥ 110), and a mesh-health meter in the summary bar. The
 * selected (inverse-video) row renders every glyph PLAIN — no embedded SGR/RESET
 * would survive inside the invert cleanly — mirroring the existing plain-slice
 * pattern for the name/score cells.
 *
 * Colour discipline follows the health model: green = healthy, yellow = weak,
 * red = dead/failing, cyan = asleep (expected), grey = no-data / mains.
 */

import {
  BOX,
  c,
  center,
  lr,
  padEnd,
  padStart,
  truncate,
  visLen,
} from '../ansi';
import { masthead, titleRule, fieldStrip, field, commandBar, linkState, type Keycap } from '../chrome';
import { responseTimeoutPct } from '../../zwave/health';
import { noiseColor, rssiColor, marginColor, rttColor, timeoutPctColor, WEAK_MARGIN_DB } from '../bands';
import { meter, signalBars, litBars, sparkline, vblock, fmtElapsed, spinner } from '../gauges';
import {
  NodeStatus,
  type DataProvider,
  type HealthResult,
  type NodeSnapshot,
  type ScreenCtx,
  type ViewState,
} from '../../types';

/* ── responsive column layout (single-space separators) ─────────────────── */

type ColKey =
  | 'cursor' | 'id' | 'status' | 'name' | 'score' | 'signal'
  | 'rtt' | 'tmo' | 'hop' | 'route' | 'rate' | 'seen' | 'batt' | 'flags' | 'trend';

interface ColSpec {
  key: ColKey;
  w: number;
  align: 'l' | 'r';
  header: string;
}

/** Extra diagnostic columns unlock as the terminal gets wider. */
const MID_COLS = 104; // + RTT · TMO · TREND
const WIDE_COLS = 140; // + ROUTE, wider name + trend
const NARROW_COLS = 74; // below this, drop rate/seen/batt so FLAGS never clips

/**
 * Build the active columns for this width. The fixed columns are sized to their
 * content; the NODE name column then FLEXES to absorb all remaining width, so
 * the table always fills the terminal instead of stranding the right half.
 */
function layout(W: number, mode: ViewState['signalDisplay'], realNoise = true): ColSpec[] {
  const mid = W >= MID_COLS;
  const wide = W >= WIDE_COLS;
  // Below NARROW_COLS the fixed columns + a readable name can't all fit, and the
  // old flex-floor (name ≥ 14) overflowed the row so truncate() silently clipped
  // FLAGS off the right edge — breaking the "never clip a flag" invariant. Drop
  // the lowest-value columns (rate/seen/batt) in the narrow tier so the triage
  // essentials (id · status · name · score · signal · flags) always fit.
  const narrow = W < NARROW_COLS;
  const cols: ColSpec[] = [];
  const add = (key: ColKey, w: number, align: 'l' | 'r', header: string): void => {
    cols.push({ key, w, align, header });
  };
  add('cursor', 1, 'l', '');
  add('id', 4, 'r', 'ID');
  add('status', 2, 'l', 'ST');
  add('name', 16, 'l', 'NODE'); // flexed below
  add('score', 4, 'r', 'SCR');
  // `MARGIN~` marks a column computed against the ASSUMED noise floor. Every
  // value in it is then an estimate, and one tilde in the header says so once
  // rather than repeating "est" on all 39 rows.
  add('signal', 12, 'r', mode === 'dbm' ? 'RSSI' : realNoise ? 'MARGIN' : 'MARGIN~');
  if (mid) {
    add('rtt', 6, 'r', 'RTT');
    add('tmo', 5, 'r', 'TMO');
  }
  add('hop', 4, 'r', 'HOP');
  if (wide) add('route', 16, 'l', 'ROUTE');
  if (!narrow) {
    add('rate', 5, 'r', 'RATE');
    add('seen', 5, 'r', 'SEEN');
    add('batt', 4, 'r', 'BATT');
  }
  add('flags', 9, 'l', 'FLAGS'); // FLAG_ORDER length — never clip a flag
  if (mid) add('trend', wide ? 16 : 8, 'l', 'TREND');

  // Flex NODE: give it every column left over after the fixed ones + separators.
  const name = cols.find((col) => col.key === 'name')!;
  const fixed = cols.reduce((s, col) => s + col.w, 0) - name.w + (cols.length - 1);
  // Cap raised 40 → 64 (v0.27). At the wide tier the fixed columns + separators
  // total 107, so the old cap saturated contentW at 147 and left 53 columns dead
  // on EVERY body row at 200 cols — measured, 26.5% of the frame. Device names
  // are the one field that genuinely uses the room ("Guest Bedroom Motion
  // Sensor" is 27), and a wider NODE column means fewer names truncate, which is
  // the honesty win as much as the density one. 64 is where real HA device names
  // stop growing; beyond it the column would pad, not inform.
  name.w = Math.max(14, Math.min(64, W - fixed));
  return cols;
}

function contentW(cols: readonly ColSpec[]): number {
  return cols.reduce((s, col) => s + col.w, 0) + (cols.length - 1);
}

export function renderOverview(ctx: ScreenCtx): string[] {
  const { view, data, visibleNodes } = ctx;
  const W = view.cols;
  const H = view.rows;

  // Empty / loading states get a centred notice card.
  if (!data.ready()) {
    const err = data.lastError();
    return centeredNotice(view, 'Z-WAVE TUI', [
      c.grey('Connecting to Home Assistant…'),
      ...(err ? ['', c.red(truncate(err, Math.min(W - 8, 60)))] : []),
    ], [['Q', 'EXIT']]);
  }
  if (visibleNodes.length === 0) {
    // `/` is still legal here (it is how the operator edits the filter that
    // emptied the roster), so this card MUST render the capture state — a
    // capture with no echo swallows every later keystroke, including the [Q]
    // on this very command bar, with nothing on screen to explain it.
    // `filter.trim()` matches what visibleNodes() actually applies — a
    // whitespace-only filter narrows nothing, so blaming it for an empty
    // roster (and offering to CLEAR it) would be a fabricated explanation.
    const active = view.filter.trim() !== '';
    const reason = c.grey(active
      ? `No nodes match “${view.filter}”`
      : 'No Z-Wave nodes discovered yet');
    // The capture is drawn IN ADDITION to the reason, never instead of it: with
    // a genuinely empty mesh, replacing it left the operator editing a filter
    // that was not responsible for anything.
    const body = ctx.filtering
      // Esc "clear", not "cancel": capture is not a transaction — it edits
      // view.filter in place and Esc discards the whole filter. The keycap one
      // row below says CLEAR, and the two must not disagree.
      ? [reason, '', c.grey('FILTER ') + c.yellow(`“${view.filter}”`) + c.yellowB('▏'), c.grey('⏎ apply · Esc clear')]
      : [reason];
    // Esc is offered explicitly: with every node filtered out this card is the
    // whole screen, and clearing the filter is the only way back to a roster.
    const keys: Keycap[] = active || ctx.filtering
      ? [['/', 'FILTER'], ['Esc', 'CLEAR'], ['1-8', 'SCREENS'], ['Q', 'EXIT']]
      : [['/', 'FILTER'], ['1-8', 'SCREENS'], ['Q', 'EXIT']];
    return centeredNotice(view, 'NO NODES', body, keys);
  }

  const cols = layout(W, view.signalDisplay, data.hasRealNoise());

  const out: string[] = [];
  // Chrome: masthead · titled rule · telemetry strip · column header.
  out.push(masthead(view, { link: linkState(data), homeId: data.controller()?.homeId ?? null, now: Date.now() }));
  out.push(titleRule(view, 'OVERVIEW', rightStatus(ctx)));
  out.push(telemetryStrip(ctx));
  out.push(truncate(headerRow(view, cols), W));

  // Body window: between the column header and the command bar (4 chrome rows
  // above + 1 command bar below).
  const cap = Math.max(1, H - 5);
  const start = windowStart(view.selected, view.scroll, visibleNodes.length, cap);
  // Write the clamped window back (the Log screen's logScroll pattern). Without
  // this the roster re-derives `start` from a stale scroll on every redraw, so
  // paging never sticks and the cursor snaps back to the bottom row.
  view.scroll = start;
  const end = Math.min(visibleNodes.length, start + cap);
  const noise = data.noiseFloor();

  for (let i = start; i < end; i++) {
    const n = visibleNodes[i];
    out.push(
      truncate(
        nodeRow(n, data.scoreFor(n.nodeId), i === view.selected, noise, view, data, cols),
        W,
      ),
    );
  }
  // MESH ROLL-UP (v0.27) — earns the rows the roster does not need.
  //
  // Funded STRICTLY by surplus: it is drawn only when every visible node
  // already has a row AND rows are left over, so it can never push the roster
  // into scrolling. Before this, those rows were padded with '' — 16 of them at
  // 200x60 on a 39-node mesh, measured.
  //
  // Deliberately NOT included, each for a reason found in review:
  //  · no RF-headroom distribution — it would bucket nodes by `stats.rssi`,
  //    which this very file (see signalDisplay) refuses to health-colour for a
  //    ROUTED node because the value is the last-hop repeater→controller ACK,
  //    not the device's own link. A distribution over it would imply precision
  //    the source does not have.
  //  · no extra command-bar/telemetry token — adding one changes what
  //    fieldStrip drops at 80 and 120 cols, i.e. it would cost information on
  //    small terminals to decorate large ones.
  const surplus = (H - 1) - out.length;
  const panel = surplus > 0 && end >= visibleNodes.length && start === 0
    ? meshRollUp(ctx, W, surplus)
    : [];
  // Pad FIRST so the roll-up sits directly above the command bar: the blank gap
  // separates it from the roster instead of floating it mid-frame.
  while (out.length < H - 1 - panel.length) out.push('');
  for (const line of panel) out.push(truncate(line, W));
  // Pad the body so the command bar lands on the last row.
  while (out.length < H - 1) out.push('');

  // POSITION, not window size: `(12–28/39)` says where you are in the roster.
  // The old `(end-start)/total` reported how many rows happened to fit, which
  // never changed as you scrolled and so told the operator nothing.
  const more = end < visibleNodes.length || start > 0 ? ` (${start + 1}–${end}/${visibleNodes.length})` : '';
  const moreTok = more ? c.grey(more) : '';
  // Reserve the counter's columns so commandBar drops WHOLE keycaps to make
  // room, instead of the bar and counter fighting over the same last row.
  out.push(truncate(commandBar(view, [
    ['1-8', 'SCREENS'], ['↑↓', 'NAV'], ['⏎', 'INSPECT'], ['A', 'ACTIONS', 1],
    ['/', 'FILTER', 2], ['S', 'SORT', 3], ['T', 'UNITS', 4], ['Q', 'EXIT'],
  ], visLen(moreTok)) + moreTok, W));
  // Defensive clamp — the session guarantees rows >= 16, but never overrun.
  return out.slice(0, H);
}

/** The far-right status token on the OVERVIEW rule: rebuild / filter / stale. */
function rightStatus(ctx: ScreenCtx): string {
  const { data, view } = ctx;
  // An ACTIVE filter capture outranks everything: it is the only cue that the
  // operator's keystrokes are being swallowed into a filter rather than acted
  // on. Burying it under a rebuild spinner or a stale-roster warning left them
  // typing into an invisible field.
  if (ctx.filtering) {
    return c.grey('FILTER ') + c.yellow(`“${view.filter}”`) + c.yellowB('▏');
  }
  const err = data.lastError();
  const lu = data.lastUpdated();
  const ageMs = lu != null ? Math.max(0, Date.now() - lu) : null;
  if (err != null || (ageMs != null && ageMs > 30_000)) {
    return c.redB(`⚠ ${err ? 'LINK LOST' : 'ROSTER STALE'}${ageMs != null ? ' ' + fmtAge(ageMs) : ''}`);
  }
  const ctrl = data.controller();
  if (ctrl?.isRebuildingRoutes === true) {
    const el = ctrl.rebuildStartedAt != null ? ' ' + fmtElapsed(Date.now() - ctrl.rebuildStartedAt) : '';
    return c.cyanB(`${spinner(Date.now())} REBUILDING ROUTES${el}`);
  }
  // `.trim()`, matching visibleNodes() and the empty-roster card: a
  // whitespace-only filter narrows nothing and must not be advertised as live.
  if (ctx.filtering || view.filter.trim()) {
    return c.grey('FILTER ') + c.yellow(`“${view.filter}”`) + (ctx.filtering ? c.yellowB('▏') : '');
  }
  return '';
}

/* ── telemetry strip ───────────────────────────────────────────────────── */

/** The labelled, unit-bearing status fields under the OVERVIEW rule. */
function telemetryStrip(ctx: ScreenCtx): string {
  const { data, view } = ctx;
  const all = data.nodes();
  let online = 0;
  let dead = 0;
  let asleep = 0;
  let flaky = 0;
  let unknown = 0;
  for (const n of all) {
    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) online++;
    else if (n.status === NodeStatus.Dead) dead++;
    else if (n.status === NodeStatus.Asleep) asleep++;
    else if (n.status === NodeStatus.Unknown) unknown++;
    if (data.scoreFor(n.nodeId).state === 'flaky') flaky++;
  }
  const noise = data.noiseFloor();
  // Unknown nodes counted as healthy here: health.ts gives them the state
  // 'unknown' (not 'flaky') and only NodeStatus.Dead subtracts, so a node the
  // controller has never heard from inflated the mesh percentage.
  const meshFrac = all.length > 0
    ? Math.max(0, all.length - dead - flaky - unknown) / all.length
    : 0;

  const fields = [
    field('NODES', String(all.length), c.whiteB),
    field('ONLINE', String(online), c.green),
    field('DEAD', String(dead), dead > 0 ? c.redB : c.grey),
    field('ASLEEP', String(asleep), asleep > 0 ? c.cyan : c.grey),
    field('FLAKY', String(flaky), flaky > 0 ? c.yellow : c.grey),
    ...(unknown > 0 ? [field('UNKNOWN', String(unknown), c.yellow)] : []),
    // Showing '—' hid the fact that the MARGIN column is still being computed
    // — against the assumed floor. Name the assumption instead of hiding it.
    // ROUND for display, and band the DISPLAYED value (the RTT rule): the
    // driver's channel median is fractional (-95.062 on the live mesh), so
    // this field spelt the same floor differently from the Interference
    // screen's rounded copy — one reading, two representations.
    field(
      'NOISE',
      data.hasRealNoise() ? `${Math.round(noise)} dBm` : `${Math.round(noise)} dBm assumed`,
      data.hasRealNoise() ? noiseColor(Math.round(noise)) : c.grey,
    ),
    c.grey('MESH ') + meter(meshFrac, 8) + c.grey(` ${Math.round(meshFrac * 100)}%`),
  ];
  return fieldStrip(view, fields);
}

/* ── header ────────────────────────────────────────────────────────────── */

function headerRow(_view: ViewState, cols: readonly ColSpec[]): string {
  return c.grey(joinCells(cols.map((col) => col.header), cols));
}

/* ── one node row ──────────────────────────────────────────────────────── */

function nodeRow(
  n: NodeSnapshot,
  health: HealthResult,
  selected: boolean,
  noise: number,
  view: ViewState,
  data: DataProvider,
  cols: readonly ColSpec[],
): string {
  const nameW = cols.find((col) => col.key === 'name')?.w ?? 16;
  const trendW = cols.find((col) => col.key === 'trend')?.w ?? 8;
  const g = statusGlyph(n.status);
  const isDead = dead(n);
  const score = scoreDisplay(health.score, isDead);
  const sig = signalDisplay(n, noise, view.signalDisplay);
  const rtt = rttCell(n);
  const tmo = timeoutCell(n);
  const hop = hopCell(n);
  const route = routeCell(n);
  const rate = rateCell(n);
  const seen = seenCell(n);
  const bat = batteryCell(n);
  const flags = flagsCell(health.flags);
  const trend = sparkCell(data, n.nodeId, trendW);

  // Coloured form (normal rows) and plain form (the inverse-video selected row —
  // no embedded SGR/RESET can survive the invert), keyed so the responsive
  // column set drives both without positional drift.
  // A DEAD/UNKNOWN node's RF cells are the LAST READING BEFORE it stopped
  // answering — they are history, not health. Painting them with the live
  // health ramp put a full-green signal, RTT and rate next to a red `✕ dead`
  // marker, which reads as "this node is fine". Stale telemetry goes neutral
  // grey; the cells that legitimately describe a dead node (status, seen,
  // battery, flags) keep their own colour, because they are what explains it.
  const staleRf = isDead ? c.grey : null;
  const rf = (color: (s: string) => string, t: string): string => (staleRf ?? color)(t);

  const colored: Record<ColKey, string> = {
    cursor: ' ',
    id: idColor(n)(String(n.nodeId)),
    status: g.color(g.ch),
    name: n.status === NodeStatus.Dead ? c.grey(truncate(n.name, nameW)) : truncate(n.name, nameW),
    score: score.colored,
    signal: staleRf ? staleRf(sig.plain) : sig.colored,
    rtt: rf(rtt.color, rtt.t),
    tmo: rf(tmo.color, tmo.t),
    hop: rf(hop.color, hop.t),
    route: rf(route.color, route.t),
    rate: rf(rate.color, rate.t),
    seen: seen.color(seen.t),
    batt: bat.color(bat.t),
    flags: flags.color(flags.t),
    trend: staleRf ? staleRf(trend.plain) : trend.colored,
  };
  if (selected) {
    const plain: Record<ColKey, string> = {
      cursor: '▶', id: String(n.nodeId), status: g.ch, name: n.name.slice(0, nameW),
      score: score.plain, signal: sig.plain, rtt: rtt.t, tmo: tmo.t, hop: hop.t,
      route: route.t, rate: rate.t, seen: seen.t, batt: bat.t, flags: flags.t, trend: trend.plain,
    };
    // DEFENSE: every plain cell is hard-sliced to its column width BEFORE joinCells,
    // so joinCells' padStart/padEnd can only ever PAD — never truncate() (which
    // appends an ANSI RESET that would break the inverse-video bar mid-row).
    const cells = cols.map((col) => plain[col.key].slice(0, col.w));
    return c.invert(padEnd(joinCells(cells, cols), contentW(cols)));
  }
  return joinCells(cols.map((col) => colored[col.key]), cols);
}

/* ── cell formatters ───────────────────────────────────────────────────── */

interface Cell {
  t: string;
  color: (s: string) => string;
}

/** A graphic cell that has a coloured form (normal rows) and a plain form
 *  (the inverse-video selected row — no embedded SGR/RESET). Both forms are
 *  the SAME fixed visible width so column layout never shifts. */
interface GraphicCell {
  colored: string;
  plain: string;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function statusGlyph(status: NodeStatus): { ch: string; color: (s: string) => string } {
  switch (status) {
    case NodeStatus.Alive:
      return { ch: '●', color: c.green };
    case NodeStatus.Awake:
      return { ch: '●', color: c.greenB };
    case NodeStatus.Asleep:
      return { ch: '◐', color: c.cyan };
    case NodeStatus.Dead:
      return { ch: '✕', color: c.redB };
    default:
      return { ch: '○', color: c.grey };
  }
}

function idColor(n: NodeSnapshot): (s: string) => string {
  if (n.isController) return c.cyanB;
  if (n.isLongRange) return c.blue;
  return c.white;
}

function scoreColor(score: number): (s: string) => string {
  if (score >= 80) return c.green;
  if (score >= 40) return c.yellow;
  return c.red;
}

/**
 * Score cell = a 1-cell vblock health mark + the 0..100 number, exactly 4 wide.
 * The number stays authoritative; the vblock is a redundant at-a-glance level.
 * Dead/unknown nodes show a right-aligned '—' (no fabricated level).
 */
function scoreDisplay(score: number, isDead: boolean): GraphicCell {
  if (isDead) {
    const cell = padStart('—', 4);
    return { colored: c.grey(cell), plain: cell };
  }
  // Math.round guards the width contract: a fractional score must never spill
  // past 3 digits (which would force a truncate() → embedded RESET in the plain
  // selected row). Documented scores are already integers, so this is a no-op.
  const glyph = vblock(score / 100); // plain single-cell block (' ' at 0)
  const num = padStart(String(Math.round(score)), 3);
  const cell = glyph + num; // 4 visible cells, no ANSI
  return { colored: scoreColor(score)(cell), plain: cell };
}

/* ── signal (bars + margin/dbm) ────────────────────────────────────────── */

const BAR_GLYPHS = ['▁', '▃', '▅', '▇'] as const;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Map a signal metric to a 0..1 strength fraction whose zoneColor thresholds
 * (0.66 green / 0.33 yellow) land exactly on the existing health thresholds:
 * value ≥ green → [0.66,1]; value in [yellow,green) → [0.33,0.66); below → <0.33.
 * `yellow < green` (higher value = better).
 */
function bandFrac(v: number, yellow: number, green: number): number {
  const span = Math.max(1, green - yellow);
  const f =
    v >= green
      ? 0.66 + ((v - green) / span) * 0.34
      : 0.33 + ((v - yellow) / span) * 0.33;
  // Floor ABOVE zero: bandFrac is only ever called with a PRESENT reading, and
  // litBars maps frac 0 to zero lit bars — the "no signal at all" rendering.
  // The red ramp hits 0 at exactly (yellow − span), so any link that far under
  // the anchor fell off a cliff into looking absent; moving the shared anchor
  // 5 → 7 dB (v0.26) surfaced what the old anchor happened to hide. 0.02 keeps
  // it deep red while guaranteeing the 1-bar floor on both bar forms.
  return Math.max(0.02, clamp01(f));
}

/** Plain (uncoloured) ascending bars — lit glyphs then spaces — for the
 *  inverse-video selected row, so level still reads without any SGR. */
function barsPlain(frac: number, bars = 4): string {
  // Shares litBars() with signalBars so the plain and coloured forms can never
  // disagree on how many bars a given signal lights.
  const lit = litBars(frac, bars);
  let out = '';
  for (let i = 0; i < bars; i++) out += i < lit ? BAR_GLYPHS[i] : ' ';
  return out; // width = bars
}

/**
 * Signal cell = signalBars(4) + ' ' + a right-aligned dB label, exactly 12 wide.
 * Bars reflect the SAME quantity coloured by the label (SNR margin in 'margin'
 * mode, RSSI in 'dbm' mode) so glyph and text always agree. No reading → blank
 * bars + '—' (the same convention every reading column uses when there is no
 * reading).
 */
function signalDisplay(n: NodeSnapshot, noise: number, mode: ViewState['signalDisplay']): GraphicCell {
  const rssi = n.stats.rssi;
  const dash = (): GraphicCell => {
    const label = padStart('—', 7);
    return { colored: '    ' + ' ' + c.grey(label), plain: '    ' + ' ' + label };
  };
  // A DEAD/UNKNOWN node's last RSSI is stale — it hasn't answered, so grading its
  // cached reading as a live signal contradicts the ✕/'—' the same row shows
  // (matches the heatmap's no-reading guard + the score's DEAD→0 gate).
  const stale = n.status === NodeStatus.Dead || n.status === NodeStatus.Unknown;
  if (rssi == null || RSSI_SENTINELS.has(rssi) || stale) return dash();
  // For a ROUTED node, `stats.rssi` is the controller-measured ACK RSSI of the
  // LAST hop (repeater→controller), NOT the device's own signal — health-colouring
  // it "would be confidently wrong" (health.ts). Show it in neutral grey so it
  // never masquerades as the device's signal band.
  const routed = !n.isLongRange && (n.stats.lwr?.repeaters?.length ?? 0) > 0;

  let text: string;
  let colorFn: (s: string) => string;
  let frac: number;
  if (mode === 'dbm') {
    text = `${rssi}dBm`;
    colorFn = rssiColor(rssi);
    frac = bandFrac(rssi, -88, -70);
  } else {
    // ROUND before formatting. The driver's noise floor is fractional
    // (-95.062 live), so `rssi - noise` produced "+35.062dB" — 9 chars, which
    // the defensive cap below then sliced to "+35.062", silently amputating the
    // UNIT and leaving a bare number that reads as an exact measurement. This
    // is the exact defect class the release exists to remove, found on the live
    // 39-node mesh; no synthetic fixture has a fractional floor.
    const margin = Math.round(rssi - noise);
    text = `${margin >= 0 ? '+' : ''}${margin}dB`;
    colorFn = marginColor(margin);
    // The yellow anchor is the SHARED weak-margin threshold, not a private
    // literal. This cell carried a 5 that predated bands.ts and drifted from
    // WEAK_MARGIN_DB=7 — a 6 dB link lit a second bar here while the number
    // beside it, the W flag and every other margin surface called it weak.
    frac = bandFrac(margin, WEAK_MARGIN_DB, 17);
  }
  // Defensive cap: keep the label ≤ 7 so padStart never has to truncate() (that
  // would append a RESET into the plain selected-row string). Realistic ranges
  // are already ≤ 7 ("-128dBm" / "+110dB").
  if (text.length > 7) text = text.slice(0, 7);

  // Colour the glyph with the LABEL's band function, not signalBars' internal
  // zoneColor: `frac` is a coarse 2-threshold ramp while marginColor now has
  // four bands, so between 5 and 10 dB the bars read yellow beside a red number.
  const bars = signalBars(frac, 4, routed ? c.grey : colorFn);
  const label = routed ? c.grey(text) : colorFn(text);
  const colored = bars + ' ' + padStart(label, 7);
  const plain = barsPlain(frac, 4) + ' ' + padStart(text, 7);
  return { colored, plain }; // 4 + 1 + 7 = 12 visible
}

/* ── rssi micro-sparkline (mid+ terminals) ─────────────────────────────── */

/**
 * `width`-cell RSSI trend sparkline. Auto-scales to the node's own history window
 * and degrades to dim dots when empty/short (sparkline() handles that). The plain
 * form (selected row) strips ANSI so the block SHAPE still reads inside the
 * inverse-video bar with no embedded RESET.
 */
function sparkCell(data: DataProvider, nodeId: number, width: number): GraphicCell {
  // Drop RSSI sentinels (125/126/127) from the trend, and color the sparkline by
  // the LAST sample's ABSOLUTE band (rssiColor) — not the relative-window default,
  // which would paint a healthy-but-flat node red and contradict every other column.
  const hist = data.history(nodeId).rssi.filter((v) => !RSSI_SENTINELS.has(v));
  const color = hist.length ? rssiColor(hist[hist.length - 1]) : undefined;
  const colored = sparkline(hist, width, color ? { color } : {});
  return { colored, plain: stripAnsi(colored) }; // exactly `width` visible cells
}

/* ── link-quality columns (mid+ terminals) ─────────────────────────────── */

/** Round-trip latency, ms → coloured band. No reading → '—'. The driver reports
 *  FRACTIONAL ms, so ROUND before formatting or "123.4ms" (7 cells) overruns the
 *  6-cell column and gets truncate()d (→ garbled value + a RESET in the selected row). */
function rttCell(n: NodeSnapshot): Cell {
  const rtt = n.stats.rtt;
  if (rtt == null || rtt < 0) return { t: '—', color: c.grey };
  const r = Math.round(rtt);
  const t = r >= 1000 ? `${(r / 1000).toFixed(1)}s` : `${r}ms`;
  return { t, color: rttColor(r) };
}

/** Response-timeout rate (shared with Detail via responseTimeoutPct). This is
 *  timeoutResponse/commandsTX — NOT commandsDroppedTX, which is near-silent for
 *  RF loss (RESEARCH.md §0). No traffic → '—'. */
function timeoutCell(n: NodeSnapshot): Cell {
  const pct = responseTimeoutPct(n.stats);
  if (pct == null) return { t: '—', color: c.grey };
  const t = `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
  return { t, color: timeoutPctColor(pct) };
}

/** Last-working-route hop chain, compacted to fit. Direct → 'direct'. */
function routeCell(n: NodeSnapshot): Cell {
  if (n.isLongRange) return { t: 'direct·LR', color: c.blue };
  const lwr = n.stats.lwr;
  if (!lwr) return { t: '—', color: c.grey };
  const reps = lwr.repeaters;
  if (reps.length === 0) return { t: 'direct', color: c.green };
  // ≤2 hops shown fully; more collapse to "n<first>→+N" so it always fits ≤16.
  const t = reps.length <= 2 ? reps.map((r) => `n${r}`).join('→') : `n${reps[0]}→+${reps.length - 1}`;
  return { t, color: reps.length >= 3 ? c.yellow : c.white };
}

function hopCell(n: NodeSnapshot): Cell {
  if (n.isLongRange) return { t: '·LR', color: c.blue };
  const lwr = n.stats.lwr;
  if (!lwr) return { t: '—', color: c.grey };
  const hops = lwr.repeaters.length;
  const color = hops === 0 ? c.green : hops >= 3 ? c.yellow : c.white;
  return { t: String(hops), color };
}

const DATA_RATE_LABEL: Record<number, string> = {
  1: '9.6k',
  2: '40k',
  3: '100k',
  4: 'LR',
};

function rateCell(n: NodeSnapshot): Cell {
  const dr = n.stats.lwr?.protocolDataRate ?? null;
  if (dr == null) return { t: '—', color: c.grey };
  const label = DATA_RATE_LABEL[dr] ?? '?';
  const color = dr >= 3 ? c.green : dr === 2 ? c.yellow : c.red;
  return { t: label, color };
}

function seenCell(n: NodeSnapshot): Cell {
  const ls = n.stats.lastSeen;
  if (ls == null) return { t: '—', color: c.grey };
  const ageMs = Math.max(0, Date.now() - ls);
  const t = fmtAge(ageMs);
  // Sleeping nodes are expected to be quiet — never flag their staleness.
  if (n.status === NodeStatus.Asleep) return { t, color: c.grey };
  const s = ageMs / 1000;
  const color = s < 120 ? c.green : s < 3600 ? c.white : s < 21600 ? c.yellow : c.red;
  return { t, color };
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function batteryCell(n: NodeSnapshot): Cell {
  if (n.battery) {
    const lvl = n.battery.level;
    const color = lvl <= 25 ? c.red : lvl <= 50 ? c.yellow : c.green;
    return { t: `${lvl}%`, color };
  }
  // No level yet (v0.1 reads no battery CC). Don't claim "AC" for a device that
  // exposes a battery entity — that would be wrong for battery sensors.
  const isBattery = n.entities.some((e) => /_battery/i.test(e.entityId));
  return isBattery ? { t: 'bat', color: c.grey } : { t: 'AC', color: c.grey };
}

function flagsCell(flags: string[]): Cell {
  const t = flags.join('');
  if (!t) return { t: '', color: c.grey };
  const has = (f: string) => flags.includes(f);
  const color =
    has('D') || has('F') || has('R')
      ? c.red
      : has('W') || has('B') || has('L')
        ? c.yellow
        : has('S')
          ? c.cyan
          : has('U')
            ? c.blue
            : c.grey;
  return { t, color };
}

/* ── centred notice card (shared with the stub overlays) ───────────────── */

/**
 * A centred, framed card — used for the Overview's loading / empty states and
 * reused by detail/controller/topology/heatmap/log for their genuine empty and
 * terminal-too-small states, so they all share one look. Returns exactly `view.rows` lines,
 * each no wider than `view.cols`.
 */
export function centeredNotice(
  view: ViewState,
  title: string,
  bodyLines: string[],
  keys?: ReadonlyArray<Keycap>,
): string[] {
  const W = view.cols;
  const H = view.rows;

  const widths = [title.length, ...bodyLines.map(visLen)];
  const inner = Math.min(Math.max(...widths, 12) + 4, Math.max(12, W - 6));
  const boxW = inner + 2;

  const boxLines: string[] = [];
  boxLines.push(c.cyan(BOX.tl + BOX.h.repeat(inner) + BOX.tr));
  boxLines.push(c.cyan(BOX.v) + center(c.cyanB(title), inner) + c.cyan(BOX.v));
  boxLines.push(c.cyan(BOX.lJoint + BOX.lh.repeat(inner) + BOX.rJoint));
  for (const line of bodyLines) {
    boxLines.push(c.cyan(BOX.v) + center(line, inner) + c.cyan(BOX.v));
  }
  boxLines.push(c.cyan(BOX.bl + BOX.h.repeat(inner) + BOX.br));

  const leftPad = ' '.repeat(Math.max(0, Math.floor((W - boxW) / 2)));
  // A notice that occupies the WHOLE screen must still say how to leave it.
  // Without a command bar the empty states were dead ends: the box named no
  // key, and the [Q] the operator reached for had never been advertised.
  const reserve = keys ? 1 : 0;
  const topPad = Math.max(0, Math.floor((H - reserve - boxLines.length) / 2));

  const out: string[] = [];
  for (let i = 0; i < topPad; i++) out.push('');
  for (const line of boxLines) out.push(truncate(leftPad + line, W));
  while (out.length < H - reserve) out.push('');
  if (keys) out.push(commandBar(view, keys));
  return out.slice(0, H);
}

/* ── shared helpers ────────────────────────────────────────────────────── */

const RSSI_SENTINELS = new Set([127, 126, 125]);

function dead(n: NodeSnapshot): boolean {
  return n.status === NodeStatus.Dead || n.status === NodeStatus.Unknown;
}

/**
 * Pad each cell to its column width (ANSI-aware) and join with single spaces.
 * Works for both styled cells and plain text — padStart/padEnd measure visible
 * width, so colour codes don't skew the layout. Graphic cells are pre-sized to
 * their column width, so the pad is a no-op for them.
 */
function joinCells(cells: string[], cols: readonly ColSpec[]): string {
  return cells
    .map((cell, i) => (cols[i].align === 'r' ? padStart(cell, cols[i].w) : padEnd(cell, cols[i].w)))
    .join(' ');
}

export function windowStart(selected: number, scroll: number, total: number, cap: number): number {
  let start = Number.isFinite(scroll) ? scroll : 0;
  if (selected < start) start = selected;
  if (selected >= start + cap) start = selected - cap + 1;
  const max = Math.max(0, total - cap);
  return Math.max(0, Math.min(start, max));
}

/**
 * The FLOOR of each grade's score band (health.ts gradeFor: A>=90, B>=80, C>=70,
 * D>=55, else F), so the roll-up's distribution is coloured by the SAME
 * scoreColor the roster cell uses.
 *
 * A private letter→colour table was a THIRD mapping and it disagreed with the
 * roster. Inventing a midpoint instead was no better: a made-up 30 for grade D
 * coloured it RED while the roster painted an actual 55-score D node YELLOW —
 * the test caught exactly that. The band floor is the one representative score
 * that is real ("at least this bad") rather than assumed, and it keeps every
 * letter on the same side of scoreColor's thresholds as its members.
 */
const GRADE_FLOOR: Record<string, number> = { A: 90, B: 80, C: 70, D: 55, F: 0 };

/**
 * Compact mesh roll-up for the Overview's surplus rows. Returns AT MOST
 * `budget` lines; returns [] when the budget cannot hold the smallest useful
 * form, so the caller simply keeps its blank padding.
 *
 * Membership matches the Controller screen's NETWORK HEALTH block exactly —
 * node 1 excluded, because this is the mesh the controller serves, not the
 * controller itself. Two screens showing two different "mesh" totals would be
 * a worse defect than the blank rows this replaces.
 */
function meshRollUp(ctx: ScreenCtx, W: number, budget: number): string[] {
  const { data } = ctx;
  const members = data.nodes().filter((n) => !n.isController);
  // 1 rule + 1 status row + 1 grade row is the smallest form worth drawing.
  if (budget < 4 || members.length === 0) return [];

  let alive = 0, dead = 0, asleep = 0, unknown = 0;
  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const scored: { name: string; score: number; grade: string }[] = [];
  for (const n of members) {
    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) alive += 1;
    else if (n.status === NodeStatus.Dead) dead += 1;
    else if (n.status === NodeStatus.Asleep) asleep += 1;
    else unknown += 1;
    const h = data.scoreFor(n.nodeId);
    if (h.grade in grades) grades[h.grade] += 1;
    scored.push({ name: n.name, score: h.score, grade: h.grade });
  }

  const out: string[] = [];
  out.push(c.grey('─'.repeat(Math.max(0, W))));
  // Degrade by dropping WHOLE tokens with a disclosed `+N`, not by clipping.
  // A hard truncate at W produced a complete-LOOKING status line with, say, the
  // UNKNOWN count silently absent and nothing to signal the loss — exactly the
  // failure fieldStrip exists to prevent, and the WORST line below already
  // discloses its own remainder.
  out.push(fieldStrip({ ...ctx.view, cols: W }, [
    c.cyanB(' MESH') + c.grey(`  ${members.length} nodes (excl. controller)`),
    c.green(`${alive} alive`),
    ...(dead ? [c.red(`${dead} dead`)] : []),
    ...(asleep ? [c.cyan(`${asleep} asleep`)] : []),
    ...(unknown ? [c.yellow(`${unknown} unknown`)] : []),
  ]));
  out.push(
    c.grey(' HEALTH ') +
    (['A', 'B', 'C', 'D', 'F'] as const)
      .map((g) => scoreColor(GRADE_FLOOR[g])(`${g} ${grades[g]}`))
      .join(c.grey(' · ')),
  );

  // Worst nodes, only while rows remain. Sorted ascending by score; ties keep
  // roster order, so the list is stable frame to frame.
  // Worst nodes, only while rows remain. Ascending by score; ties keep roster
  // order, so the list is stable frame to frame. One node PER ROW when the
  // budget allows — a per-row form fits the node's name untruncated and reads
  // as a work queue; the packed one-line form is the fallback when rows are
  // tight. Never padded: the list is however many non-A nodes actually exist.
  const room = budget - out.length;
  const worstAll = scored.filter((x) => x.grade !== 'A').sort((a, b) => a.score - b.score);
  if (room >= 2 && worstAll.length > 0) {
    // Prefer the PER-ROW form and fill whatever rows exist, disclosing the
    // remainder — packing into one line while rows sit blank below wastes the
    // very space this panel exists to use. The packed form survives only for a
    // budget too small for a header plus one entry.
    if (room >= 3) {
      const shown = worstAll.slice(0, room - 1);
      const rest = worstAll.length - shown.length;
      out.push(c.grey(' WORST') + (rest > 0 ? c.grey(`  (${shown.length} of ${worstAll.length})`) : ''));
      for (const x of shown) {
        out.push('   ' + scoreColor(x.score)(`${x.grade} ${String(x.score).padStart(3)}`) +
                 '  ' + c.white(truncate(x.name, Math.max(10, W - 14))));
      }
    } else {
      const packed = worstAll.slice(0, Math.min(room - 1, 5));
      out.push(
        c.grey(' WORST  ') +
        packed.map((x) => scoreColor(x.score)(`${truncate(x.name, 22)} ${x.score}`)).join(c.grey('  ')) +
        (worstAll.length > packed.length ? c.grey(`  +${worstAll.length - packed.length}`) : ''),
      );
    }
  }
  return out.slice(0, budget);
}


