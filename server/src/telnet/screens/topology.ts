/**
 * TOPOLOGY / ROUTES overlay.
 *
 * A hop-grouped view of how every end node reaches the controller, built from
 * each node's last-working-route (LWR). Nodes are bucketed by hop count —
 * Direct, 1 hop, 2 hops, … — with Long-Range endpoints and not-yet-routed
 * nodes in their own groups. Each row shows the repeater chain, the negotiated
 * data rate, and the route signal (margin or dBm, following the session toggle).
 *
 *   hops   0 ████ 12   1 ██ 5   2 █ 3   3+ ░ 0
 *   ── Direct to controller (12) ───────────────────────────────────────
 *     n8  Kitchen Lamp    →  direct           100k  ▇▅▃▁ -61dBm
 *   ── 2 hops (3) ──────────────────────────────────────────────────────
 *     n4  Back Bedroom    →  n3→n8            100k  ▇▃▃▁ -74dBm
 *
 * Terminal graphics layered on top of the (unchanged) route data:
 *   • a hop-distribution mini-histogram under the title — Direct/1/2/3+ as
 *     meter() bars scaled to the busiest bucket, coloured by mesh depth;
 *   • a per-node signalBars(4) glyph drawn from the LWR route margin, right
 *     before the numeric signal reading;
 *   • the "Repeater load" bars are meter()s scaled to the heaviest repeater,
 *     coloured red as the load climbs (single-point-of-failure warning).
 * The histogram + per-node bars only appear when the window is wide/tall
 * enough; they degrade off before any value is lost.
 *
 * A pinned "Repeater load" panel at the bottom tallies how many nodes lean on
 * each repeater — a repeater carrying many nodes is a single point of failure,
 * so its count is coloured red. Content that overruns the window collapses to a
 * "…N more" line; the repeater panel is always kept visible.
 *
 * Pure render — dismissed with q/Esc by the session. Every returned line is
 * clamped to `view.cols`; the array is exactly `view.rows` long.
 */

import { BOX, c, lr, truncate } from '../ansi';
import { meter, signalBars } from '../gauges';
import {
  NodeStatus,
  type NodeSnapshot,
  type RouteStat,
  type ScreenCtx,
  type ViewState,
} from '../../types';
import { centeredNotice } from './overview';
import { frame } from '../chrome';

/** A colour wrapper (matches the ansi `c.*` span helpers / gauges ColorFn). */
type ColorFn = (s: string) => string;

/** Driver "no reading" RSSI sentinels — shown as an em-dash, never as a level. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

const DATA_RATE_LABEL: Record<number, string> = {
  1: '9.6k',
  2: '40k',
  3: '100k',
  4: 'LR',
};

export function renderTopology(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const H = view.rows;

  // Loading / error state — same centred card as the overview.
  if (!data.ready()) {
    const err = data.lastError();
    return centeredNotice(view, 'TOPOLOGY / ROUTES', [
      c.grey('Loading route topology…'),
      ...(err ? ['', c.red(truncate(err, Math.min(W - 8, 60)))] : []),
    ]);
  }

  // End nodes only (the controller is node 1 — it has no route to itself).
  const endNodes = data.nodes().filter((n) => !n.isController);
  if (endNodes.length === 0) {
    return centeredNotice(view, 'TOPOLOGY / ROUTES', [
      c.grey('No end nodes in the mesh yet'),
    ]);
  }

  const noise = data.noiseFloor();
  const nameBudget = Math.max(6, Math.min(18, W - 40));

  /* ── bucket every node by hop count ──────────────────────────────────── */
  const byHop = new Map<number, NodeSnapshot[]>();
  const lrNodes: NodeSnapshot[] = [];
  const pending: NodeSnapshot[] = [];
  for (const n of endNodes) {
    if (n.isLongRange) {
      lrNodes.push(n);
      continue;
    }
    const lwr = n.stats.lwr;
    if (!lwr) {
      pending.push(n);
      continue;
    }
    const hops = lwr.repeaters.length;
    let bucket = byHop.get(hops);
    if (!bucket) byHop.set(hops, (bucket = []));
    bucket.push(n);
  }

  const directCount = byHop.get(0)?.length ?? 0;
  let repeatedCount = 0;
  for (const [hops, list] of byHop) if (hops > 0) repeatedCount += list.length;

  // Per-node route signal bars are worth the columns only when the row has room
  // to spare — below this they'd crowd out the chain, so we drop them first.
  const showBars = W >= 72;

  /* ── flat route-tree lines (title-less; group headers separate) ──────── */
  const tree: string[] = [];
  const hopKeys = [...byHop.keys()].sort((a, b) => a - b);
  for (const hops of hopKeys) {
    const list = byHop.get(hops)!.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, hopLabel(hops), list.length));
    for (const n of list) tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget, showBars));
  }
  if (lrNodes.length) {
    lrNodes.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Long-Range (direct to controller)', lrNodes.length));
    for (const n of lrNodes) tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget, showBars));
  }
  if (pending.length) {
    pending.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Route pending', pending.length));
    for (const n of pending) tree.push(nodeLine(view, n, null, noise, nameBudget, showBars));
  }

  /* ── assemble the body: [histogram] + windowed tree + repeater panel ──── */
  const bodyCap = Math.max(1, H - 3); // frame reserves masthead + rule + command bar
  const showHist = bodyCap >= 15 && W >= 64 && directCount + repeatedCount > 0;
  const histLines = showHist ? [hopHistogram(view, byHop, directCount)] : [];
  const panel = repeaterLoadPanel(view, ctx, endNodes, nameBudget).slice(
    0,
    Math.max(1, bodyCap - histLines.length - 2),
  );
  const treeCap = Math.max(1, bodyCap - histLines.length - panel.length);

  const body: string[] = [...histLines];
  if (tree.length <= treeCap) {
    body.push(...tree);
    while (body.length < histLines.length + treeCap) body.push('');
  } else {
    const shown = treeCap - 1; // reserve the last row for the overflow note
    for (let i = 0; i < shown; i++) body.push(tree[i]);
    body.push(c.grey(`  …${tree.length - shown} more (taller terminal shows all)`));
  }
  body.push(...panel);

  const rs =
    c.grey('END ') + c.white(String(endNodes.length)) + c.grey(' · ') +
    c.green(`${directCount} DIRECT`) + c.grey(' · ') + c.white(`${repeatedCount} HOPS`) +
    (lrNodes.length ? c.grey(' · ') + c.blue(`${lrNodes.length} LR`) : '') +
    (pending.length ? c.grey(' · ') + c.yellow(`${pending.length} PEND`) : '');

  return frame(view, data, {
    title: 'TOPOLOGY / ROUTES',
    rightStatus: rs,
    body,
    keys: [['1-8', 'SCREENS'], ['T', 'UNITS'], ['Q', 'BACK']], // Topology honours the dBm↔margin toggle
  });
}

/* ── hop-distribution histogram ──────────────────────────────────────────── */

/**
 * A one-line distribution of nodes by hop depth: Direct / 1 / 2 / 3+ rendered
 * as meter() bars scaled to the busiest bucket, coloured by depth (deeper = a
 * longer, more fragile path). Purely a visual summary of the counts already in
 * the title bar — the numbers stay authoritative.
 */
function hopHistogram(
  view: ViewState,
  byHop: Map<number, NodeSnapshot[]>,
  directCount: number,
): string {
  const W = view.cols;
  const h1 = byHop.get(1)?.length ?? 0;
  const h2 = byHop.get(2)?.length ?? 0;
  let h3 = 0;
  for (const [hops, list] of byHop) if (hops >= 3) h3 += list.length;

  const buckets: { label: string; count: number; color: ColorFn }[] = [
    { label: '0', count: directCount, color: c.green },
    { label: '1', count: h1, color: c.green },
    { label: '2', count: h2, color: c.yellow },
    { label: '3+', count: h3, color: c.red },
  ];
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const barW = W >= 100 ? 8 : W >= 80 ? 6 : 4;

  const cells = buckets.map(
    (b) =>
      c.grey(b.label) +
      ' ' +
      meter(b.count / max, barW, { color: b.color }) +
      ' ' +
      c.white(String(b.count)),
  );
  const line = '  ' + c.grey('hops') + '  ' + cells.join(c.grey('   '));
  return truncate(line, W);
}

/* ── group section header (── Title (n) ─────────) ───────────────────────── */

function groupHeader(view: ViewState, title: string, count: number): string {
  const W = view.cols;
  // Visible cost before the fill: "── " + title + " (" + count + ") ".
  const used = 7 + title.length + String(count).length;
  const fillN = Math.max(0, W - used);
  const line =
    c.cyan('──') +
    ' ' +
    c.cyanB(title) +
    ' ' +
    c.grey(`(${count})`) +
    ' ' +
    c.cyan(BOX.lh.repeat(fillN));
  return truncate(line, W);
}

function hopLabel(hops: number): string {
  if (hops === 0) return 'Direct to controller';
  return hops === 1 ? '1 hop' : `${hops} hops`;
}

/* ── one node row: "  nID Name  →  chain          rate   signal" ──────────── */

function nodeLine(
  view: ViewState,
  n: NodeSnapshot,
  lwr: RouteStat | null,
  noise: number,
  nameBudget: number,
  showBars: boolean,
): string {
  const dead = n.status === NodeStatus.Dead;
  const idColor = dead ? c.grey : n.isLongRange ? c.blue : c.white;
  const nameColor = dead ? c.grey : c.white;

  const left =
    '  ' +
    idColor(`n${n.nodeId}`) +
    ' ' +
    nameColor(truncate(n.name, nameBudget)) +
    '  ' +
    c.grey('→') +
    '  ' +
    chainStr(n, lwr);
  // signalBars(4) drawn from the same LWR margin the numeric cell reports, so
  // the glyph and the number always agree; dropped on narrow terminals.
  const bars = showBars ? routeSignalBars(view, lwr, noise) + ' ' : '';
  const right = rateCell(lwr) + '  ' + bars + signalCell(view, lwr, noise);
  return lr(left, right, view.cols);
}

/**
 * A 4-cell WiFi-style strength glyph for the route, driven by the LWR margin
 * (rssi − noise floor). The fill fraction is bucketed to line the bars' colour
 * up with the numeric margin thresholds (≥17dB green · 5-16 yellow · <5 red).
 * No usable reading → dim placeholder bars (keeps the column aligned).
 */
function routeSignalBars(view: ViewState, lwr: RouteStat | null, noise: number): string {
  const rssi = lwr?.rssi ?? null;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) return c.grey('▁▃▅▇');
  const margin = rssi - noise;
  let frac: number;
  if (margin >= 17) frac = 1; // 4 bars
  else if (margin >= 5) frac = 0.5; // 2 bars
  else if (margin >= -3) frac = 0.25; // 1 bar
  else frac = 0.1; // ~0 bars
  // Color the bars with the SAME band the numeric cell uses, so glyph and number
  // agree in BOTH margin and dBm display modes.
  const color = view.signalDisplay === 'dbm' ? rssiColor(rssi) : marginColor(margin);
  return signalBars(frac, 4, color);
}

/** The repeater chain: "direct", "n3→n8", plus a red ⚠ if the route failed. */
function chainStr(n: NodeSnapshot, lwr: RouteStat | null): string {
  if (n.isLongRange) return c.blue('direct');
  if (!lwr) return c.grey('pending');
  let s =
    lwr.repeaters.length === 0
      ? c.green('direct')
      : c.white(lwr.repeaters.map((r) => `n${r}`).join('→'));
  if (lwr.routeFailedBetween) {
    const [a, b] = lwr.routeFailedBetween;
    s += ' ' + c.red(`⚠n${a}↮n${b}`);
  }
  return s;
}

function rateCell(lwr: RouteStat | null): string {
  const dr = lwr?.protocolDataRate ?? null;
  if (dr == null) return c.grey('—');
  const label = DATA_RATE_LABEL[dr] ?? '?';
  const color = dr >= 4 ? c.blue : dr >= 3 ? c.green : dr === 2 ? c.yellow : c.red;
  return color(label);
}

function signalCell(view: ViewState, lwr: RouteStat | null, noise: number): string {
  const rssi = lwr?.rssi ?? null;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) return c.grey('—');
  if (view.signalDisplay === 'dbm') return rssiColor(rssi)(`${rssi}dBm`);
  const margin = rssi - noise; // margin above the noise floor
  return marginColor(margin)(`${margin >= 0 ? '+' : ''}${margin}dB`);
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

/* ── repeater-load panel (single-point-of-failure indicator) ─────────────── */

function repeaterLoadPanel(
  view: ViewState,
  ctx: ScreenCtx,
  endNodes: NodeSnapshot[],
  nameBudget: number,
): string[] {
  // Tally how many nodes route THROUGH each repeater node-id.
  const load = new Map<number, number>();
  for (const n of endNodes) {
    for (const r of n.stats.lwr?.repeaters ?? []) {
      load.set(r, (load.get(r) ?? 0) + 1);
    }
  }

  if (load.size === 0) {
    return [
      groupHeader(view, 'Repeater load', 0),
      '  ' + c.grey('flat mesh — every node reaches the controller directly'),
    ];
  }

  const top = [...load.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5);
  const max = top[0][1];

  const lines = [groupHeader(view, 'Repeater load', load.size)];
  for (const [id, k] of top) {
    const node = ctx.data.nodeById(id);
    const name = node ? node.name : '(unknown)';
    // SPOF colouring: unlike a health meter, a FULL bar here is BAD — many nodes
    // leaning on one repeater — so the colour is driven by load, not fill.
    const textColor = k >= 5 ? c.red : k >= 3 ? c.yellow : c.green;
    const left = '  ' + c.white(`n${id}`) + ' ' + c.white(truncate(name, nameBudget));
    const right =
      meter(k / max, 8, { color: textColor }) +
      ' ' +
      textColor(`carries ${k} ${k === 1 ? 'node' : 'nodes'}`);
    lines.push(lr(left, right, view.cols));
  }
  return lines;
}
