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
import { masthead, titleRule, fieldStrip, field, commandBar, linkState } from '../chrome';
import { responseTimeoutPct } from '../../zwave/health';
import { meter, signalBars, sparkline, vblock, fmtElapsed, spinner } from '../gauges';
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

/**
 * Build the active columns for this width. The fixed columns are sized to their
 * content; the NODE name column then FLEXES to absorb all remaining width, so
 * the table always fills the terminal instead of stranding the right half.
 */
function layout(W: number, mode: ViewState['signalDisplay']): ColSpec[] {
  const mid = W >= MID_COLS;
  const wide = W >= WIDE_COLS;
  const cols: ColSpec[] = [];
  const add = (key: ColKey, w: number, align: 'l' | 'r', header: string): void => {
    cols.push({ key, w, align, header });
  };
  add('cursor', 1, 'l', '');
  add('id', 4, 'r', 'ID');
  add('status', 2, 'l', 'ST');
  add('name', 16, 'l', 'NODE'); // flexed below
  add('score', 4, 'r', 'SCR');
  add('signal', 12, 'r', mode === 'dbm' ? 'RSSI' : 'MARGIN');
  if (mid) {
    add('rtt', 6, 'r', 'RTT');
    add('tmo', 5, 'r', 'TMO');
  }
  add('hop', 4, 'r', 'HOP');
  if (wide) add('route', 16, 'l', 'ROUTE');
  add('rate', 5, 'r', 'RATE');
  add('seen', 5, 'r', 'SEEN');
  add('batt', 4, 'r', 'BATT');
  add('flags', 9, 'l', 'FLAGS'); // FLAG_ORDER length — never clip a flag
  if (mid) add('trend', wide ? 16 : 8, 'l', 'TREND');

  // Flex NODE: give it every column left over after the fixed ones + separators.
  const name = cols.find((col) => col.key === 'name')!;
  const fixed = cols.reduce((s, col) => s + col.w, 0) - name.w + (cols.length - 1);
  name.w = Math.max(14, Math.min(40, W - fixed));
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
    ]);
  }
  if (visibleNodes.length === 0) {
    const msg = view.filter
      ? `No nodes match “${view.filter}”`
      : 'No Z-Wave nodes discovered yet';
    return centeredNotice(view, 'NO NODES', [c.grey(msg)]);
  }

  const cols = layout(W, view.signalDisplay);

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
  // Pad the body so the command bar lands on the last row.
  while (out.length < H - 1) out.push('');

  const more = end < visibleNodes.length || start > 0 ? ` (${end - start}/${visibleNodes.length})` : '';
  // The scroll counter is concatenated AFTER commandBar()'s own truncate, so the
  // combined line must be re-clipped to W or it overruns the primary screen.
  out.push(truncate(commandBar(view, [
    ['1-8', 'SCREENS'], ['↑↓', 'NAV'], ['⏎', 'INSPECT'], ['A', 'ACTIONS'],
    ['/', 'FILTER'], ['S', 'SORT'], ['T', 'UNITS'], ['Q', 'EXIT'],
  ]) + (more ? c.grey(more) : ''), W));
  // Defensive clamp — the session guarantees rows >= 16, but never overrun.
  return out.slice(0, H);
}

/** The far-right status token on the OVERVIEW rule: rebuild / filter / stale. */
function rightStatus(ctx: ScreenCtx): string {
  const { data, view } = ctx;
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
  if (ctx.filtering || view.filter) {
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
  for (const n of all) {
    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) online++;
    else if (n.status === NodeStatus.Dead) dead++;
    else if (n.status === NodeStatus.Asleep) asleep++;
    if (data.scoreFor(n.nodeId).state === 'flaky') flaky++;
  }
  const noise = data.noiseFloor();
  const meshFrac = all.length > 0 ? Math.max(0, all.length - dead - flaky) / all.length : 0;

  const fields = [
    field('NODES', String(all.length), c.whiteB),
    field('ONLINE', String(online), c.green),
    field('DEAD', String(dead), dead > 0 ? c.redB : c.grey),
    field('ASLEEP', String(asleep), asleep > 0 ? c.cyan : c.grey),
    field('FLAKY', String(flaky), flaky > 0 ? c.yellow : c.grey),
    field('NOISE', data.hasRealNoise() ? `${noise} dBm` : '—', data.hasRealNoise() ? noiseColor(noise) : c.grey),
    c.grey('MESH ') + meter(meshFrac, 8) + c.grey(` ${Math.round(meshFrac * 100)}%`),
  ];
  return fieldStrip(view, fields);
}

function noiseColor(noise: number): (s: string) => string {
  if (noise >= -75) return c.red;
  if (noise >= -85) return c.yellow;
  return c.grey;
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
  const colored: Record<ColKey, string> = {
    cursor: ' ',
    id: idColor(n)(String(n.nodeId)),
    status: g.color(g.ch),
    name: n.status === NodeStatus.Dead ? c.grey(truncate(n.name, nameW)) : truncate(n.name, nameW),
    score: score.colored,
    signal: sig.colored,
    rtt: rtt.color(rtt.t),
    tmo: tmo.color(tmo.t),
    hop: hop.color(hop.t),
    route: route.color(route.t),
    rate: rate.color(rate.t),
    seen: seen.color(seen.t),
    batt: bat.color(bat.t),
    flags: flags.color(flags.t),
    trend: trend.colored,
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
  return clamp01(f);
}

/** Plain (uncoloured) ascending bars — lit glyphs then spaces — for the
 *  inverse-video selected row, so level still reads without any SGR. */
function barsPlain(frac: number, bars = 4): string {
  const lit = Math.round(clamp01(frac) * bars);
  let out = '';
  for (let i = 0; i < bars; i++) out += i < lit ? BAR_GLYPHS[i] : ' ';
  return out; // width = bars
}

/**
 * Signal cell = signalBars(4) + ' ' + a right-aligned dB label, exactly 12 wide.
 * Bars reflect the SAME quantity coloured by the label (SNR margin in 'margin'
 * mode, RSSI in 'dbm' mode) so glyph and text always agree. No reading → blank
 * bars + '—' (same convention as the deferred columns).
 */
function signalDisplay(n: NodeSnapshot, noise: number, mode: ViewState['signalDisplay']): GraphicCell {
  const rssi = n.stats.rssi;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) {
    const label = padStart('—', 7);
    return { colored: '    ' + ' ' + c.grey(label), plain: '    ' + ' ' + label };
  }

  let text: string;
  let colorFn: (s: string) => string;
  let frac: number;
  if (mode === 'dbm') {
    text = `${rssi}dBm`;
    colorFn = rssiColor(rssi);
    frac = bandFrac(rssi, -88, -70);
  } else {
    const margin = rssi - noise;
    text = `${margin >= 0 ? '+' : ''}${margin}dB`;
    colorFn = marginColor(margin);
    frac = bandFrac(margin, 5, 17);
  }
  // Defensive cap: keep the label ≤ 7 so padStart never has to truncate() (that
  // would append a RESET into the plain selected-row string). Realistic ranges
  // are already ≤ 7 ("-128dBm" / "+110dB").
  if (text.length > 7) text = text.slice(0, 7);

  const colored = signalBars(frac, 4) + ' ' + padStart(colorFn(text), 7);
  const plain = barsPlain(frac, 4) + ' ' + padStart(text, 7);
  return { colored, plain }; // 4 + 1 + 7 = 12 visible
}

function rssiColor(rssi: number): (s: string) => string {
  if (rssi >= -70) return c.green;
  if (rssi >= -88) return c.yellow;
  return c.red;
}

function marginColor(margin: number): (s: string) => string {
  if (margin >= 17) return c.green;
  if (margin >= 5) return c.yellow;
  return c.red;
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
  const color = r < 100 ? c.green : r < 500 ? c.white : r < 1000 ? c.yellow : c.red;
  return { t, color };
}

/** Response-timeout rate (shared with Detail via responseTimeoutPct). This is
 *  timeoutResponse/commandsTX — NOT commandsDroppedTX, which is near-silent for
 *  RF loss (RESEARCH.md §0). No traffic → '—'. */
function timeoutCell(n: NodeSnapshot): Cell {
  const pct = responseTimeoutPct(n.stats);
  if (pct == null) return { t: '—', color: c.grey };
  const t = `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
  const color = pct < 1 ? c.green : pct < 3 ? c.white : pct < 8 ? c.yellow : c.red;
  return { t, color };
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
 * reused verbatim by the v0.2 stub overlays (detail/controller/topology/
 * heatmap/log) so they all share one look. Returns exactly `view.rows` lines,
 * each no wider than `view.cols`.
 */
export function centeredNotice(view: ViewState, title: string, bodyLines: string[]): string[] {
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
  const topPad = Math.max(0, Math.floor((H - boxLines.length) / 2));

  const out: string[] = [];
  for (let i = 0; i < topPad; i++) out.push('');
  for (const line of boxLines) out.push(truncate(leftPad + line, W));
  while (out.length < H) out.push('');
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
