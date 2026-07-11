/**
 * OVERVIEW — the home screen.
 *
 * A dense, live, control-room node table sorted worst-health-first, framed by
 * a summary bar up top and a hotkey legend at the bottom. Designed to sit in
 * an 80x24 terminal and stay readable: single-cell glyphs, ANSI-aware column
 * padding, one row per node.
 *
 *   summary  39 nodes · 35 alive · 1 DEAD · 3 asleep · 2 flaky · noise -92dBm
 *   header   ID St Name             Sc  Signal  Hop  Rate  Seen  Bat  Flags
 *   rows     ▶  12 ● Kitchen Lamp   94   +21dB    0   100k    3s   AC
 *              7 ✕ Garage Sensor     0     —      —    —      4d  12%  D B
 *   legend   j/k move · / filter · s sort · ⏎ detail · 1-6 screens · q quit
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
import {
  NodeStatus,
  type HealthResult,
  type NodeSnapshot,
  type ScreenCtx,
  type ViewState,
} from '../../types';

/* ── column layout (single-space separators) ───────────────────────────── */

interface ColSpec {
  w: number;
  align: 'l' | 'r';
}

const COLS: readonly ColSpec[] = [
  { w: 1, align: 'l' }, // cursor
  { w: 4, align: 'r' }, // id
  { w: 2, align: 'l' }, // status glyph
  { w: 16, align: 'l' }, // name
  { w: 3, align: 'r' }, // score
  { w: 7, align: 'r' }, // signal (margin / dbm)
  { w: 4, align: 'r' }, // hop
  { w: 5, align: 'r' }, // rate
  { w: 5, align: 'r' }, // seen
  { w: 4, align: 'r' }, // battery
  { w: 7, align: 'l' }, // flags
];

const CONTENT_W = COLS.reduce((s, col) => s + col.w, 0) + (COLS.length - 1);

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

  const out: string[] = [];
  out.push(truncate(summaryBar(ctx), W));
  out.push(truncate(headerRow(view), W));

  // Body window: everything between header and legend.
  const cap = Math.max(1, H - 3); // summary + header + legend
  const start = windowStart(view.selected, view.scroll, visibleNodes.length, cap);
  const end = Math.min(visibleNodes.length, start + cap);
  const noise = data.noiseFloor();

  for (let i = start; i < end; i++) {
    const n = visibleNodes[i];
    out.push(truncate(nodeRow(n, data.scoreFor(n.nodeId), i === view.selected, noise, view), W));
  }
  // Pad the body so the legend lands on the last row.
  while (out.length < H - 1) out.push('');

  out.push(truncate(legend(visibleNodes.length, start, end), W));
  // Defensive clamp — the session guarantees rows >= 16, but never overrun.
  return out.slice(0, H);
}

/* ── summary bar ───────────────────────────────────────────────────────── */

function summaryBar(ctx: ScreenCtx): string {
  const { data, view, visibleNodes } = ctx;
  const all = data.nodes();
  let alive = 0;
  let dead = 0;
  let asleep = 0;
  let flaky = 0;
  for (const n of all) {
    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) alive++;
    else if (n.status === NodeStatus.Dead) dead++;
    else if (n.status === NodeStatus.Asleep) asleep++;
    if (data.scoreFor(n.nodeId).state === 'flaky') flaky++;
  }
  const noise = data.noiseFloor();

  const left =
    c.whiteB(`${all.length} nodes`) +
    c.grey(' · ') +
    c.green(`${alive} alive`) +
    c.grey(' · ') +
    (dead > 0 ? c.redB(`${dead} DEAD`) : c.grey('0 dead')) +
    c.grey(' · ') +
    (asleep > 0 ? c.cyan(`${asleep} asleep`) : c.grey('0 asleep')) +
    c.grey(' · ') +
    (flaky > 0 ? c.yellow(`${flaky} flaky`) : c.grey('0 flaky')) +
    c.grey(' · ') +
    c.grey('noise ') +
    // Only show a dBm figure when it's a real controller reading — otherwise a
    // '—' (same convention as the deferred Margin/Hop/Rate/Seen columns) rather
    // than presenting the fallback constant as if it were measured.
    (data.hasRealNoise() ? noiseColor(noise)(`${noise}dBm`) : c.grey('—'));

  // Staleness / disconnect band: if the data layer has an error or the last
  // successful refresh is old, say so loudly instead of showing a stale roster
  // as if it were live.
  const err = data.lastError();
  const lu = data.lastUpdated();
  const ageMs = lu != null ? Math.max(0, Date.now() - lu) : null;
  const stale = err != null || (ageMs != null && ageMs > 30_000);

  const range = c.grey(`${visibleNodes.length}`);
  let right: string;
  if (stale) {
    right = c.redB(`⚠ ${err ? 'HA OFFLINE' : 'STALE'}${ageMs != null ? ' ' + fmtAge(ageMs) : ''}`);
  } else if (ctx.filtering || view.filter) {
    // Live filter prompt — visible even with an empty buffer so the mode is
    // never invisible and the next keystroke isn't silently swallowed.
    right = c.yellow(`/${view.filter}`) + (ctx.filtering ? c.yellowB('▏') : '') + ' ' + c.grey('· ') + range;
  } else {
    right = range;
  }

  return lr(left, right, view.cols);
}

function noiseColor(noise: number): (s: string) => string {
  if (noise >= -75) return c.red;
  if (noise >= -85) return c.yellow;
  return c.grey;
}

/* ── header ────────────────────────────────────────────────────────────── */

function headerRow(view: ViewState): string {
  const sig = view.signalDisplay === 'dbm' ? 'RSSI' : 'Margin';
  const cells = ['', 'ID', 'St', 'Name', 'Sc', sig, 'Hop', 'Rate', 'Seen', 'Bat', 'Flags'];
  return c.grey(joinCells(cells));
}

/* ── one node row ──────────────────────────────────────────────────────── */

function nodeRow(
  n: NodeSnapshot,
  health: HealthResult,
  selected: boolean,
  noise: number,
  view: ViewState,
): string {
  const glyph = statusGlyph(n.status);
  const sig = signalCell(n, noise, view.signalDisplay);
  const hop = hopCell(n);
  const rate = rateCell(n);
  const seen = seenCell(n);
  const bat = batteryCell(n);
  const flags = flagsCell(health.flags);

  const plain = [
    selected ? '▶' : ' ',
    String(n.nodeId),
    glyph.ch,
    // Plain slice (no ANSI): the selected row is wrapped in c.invert, and an
    // embedded RESET from truncate() would end the highlight bar early.
    n.name.slice(0, 16),
    dead(n) ? '—' : String(health.score),
    sig.t,
    hop.t,
    rate.t,
    seen.t,
    bat.t,
    flags.t,
  ];

  if (selected) {
    // Render plain + invert the whole row so the highlight bar is clean (no
    // nested SGR fights the invert). Health colours are dropped on the
    // selected row by design — the inverse video carries the emphasis.
    return c.invert(padEnd(joinCells(plain), CONTENT_W));
  }

  const colored = [
    ' ',
    idColor(n)(String(n.nodeId)),
    glyph.color(glyph.ch),
    n.status === NodeStatus.Dead ? c.grey(truncate(n.name, 16)) : truncate(n.name, 16),
    dead(n) ? c.grey('—') : scoreColor(health.score)(String(health.score)),
    sig.color(sig.t),
    hop.color(hop.t),
    rate.color(rate.t),
    seen.color(seen.t),
    bat.color(bat.t),
    flags.color(flags.t),
  ];
  return joinCells(colored);
}

/* ── cell formatters ───────────────────────────────────────────────────── */

interface Cell {
  t: string;
  color: (s: string) => string;
}

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

function signalCell(n: NodeSnapshot, noise: number, mode: ViewState['signalDisplay']): Cell {
  const rssi = n.stats.rssi;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) return { t: '—', color: c.grey };
  if (mode === 'dbm') {
    return { t: `${rssi}dBm`, color: rssiColor(rssi) };
  }
  const margin = rssi - noise;
  const t = `${margin >= 0 ? '+' : ''}${margin}dB`;
  return { t, color: marginColor(margin) };
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
    has('D') || has('F') || has('R') ? c.red : has('W') || has('B') ? c.yellow : has('S') ? c.cyan : c.grey;
  return { t, color };
}

/* ── legend ────────────────────────────────────────────────────────────── */

function legend(total: number, start: number, end: number): string {
  const up = start > 0 ? c.cyan('↑') : c.grey('·');
  const down = end < total ? c.cyan('↓') : c.grey('·');
  const key = (k: string, label: string) => c.cyanB(k) + ' ' + c.grey(label);
  const parts = [
    key('j/k', 'move'),
    key('/', 'filter'),
    key('s', 'sort'),
    key('⏎', 'detail'),
    key('1-6', 'screens'),
    key('q', 'quit'),
  ];
  const left = `${up}${down} ` + parts.join(c.grey(' · '));
  return left;
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
 * width, so colour codes don't skew the layout.
 */
function joinCells(cells: string[]): string {
  return cells
    .map((cell, i) => (COLS[i].align === 'r' ? padStart(cell, COLS[i].w) : padEnd(cell, COLS[i].w)))
    .join(' ');
}

function windowStart(selected: number, scroll: number, total: number, cap: number): number {
  let start = Number.isFinite(scroll) ? scroll : 0;
  if (selected < start) start = selected;
  if (selected >= start + cap) start = selected - cap + 1;
  const max = Math.max(0, total - cap);
  return Math.max(0, Math.min(start, max));
}
