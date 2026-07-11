/**
 * TOPOLOGY / ROUTES overlay.
 *
 * A hop-grouped view of how every end node reaches the controller, built from
 * each node's last-working-route (LWR). Nodes are bucketed by hop count —
 * Direct, 1 hop, 2 hops, … — with Long-Range endpoints and not-yet-routed
 * nodes in their own groups. Each row shows the repeater chain, the negotiated
 * data rate, and the route signal (margin or dBm, following the session toggle).
 *
 *   ── Direct to controller (12) ───────────────────────────────────────
 *     n8  Kitchen Lamp    →  direct              100k   -61dBm
 *   ── 2 hops (3) ──────────────────────────────────────────────────────
 *     n4  Back Bedroom    →  n3→n8               100k   -74dBm
 *
 * A pinned "Repeater load" panel at the bottom tallies how many nodes lean on
 * each repeater — a repeater carrying many nodes is a single point of failure,
 * so its count is coloured red. Content that overruns the window collapses to a
 * "…N more" line; the repeater panel is always kept visible.
 *
 * Pure render — dismissed with q/Esc by the session. Every returned line is
 * clamped to `view.cols`; the array is exactly `view.rows` long.
 */

import { BOX, bar, c, lr, truncate } from '../ansi';
import {
  NodeStatus,
  type NodeSnapshot,
  type RouteStat,
  type ScreenCtx,
  type ViewState,
} from '../../types';
import { centeredNotice } from './overview';

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

  /* ── flat route-tree lines (title-less; group headers separate) ──────── */
  const tree: string[] = [];
  const hopKeys = [...byHop.keys()].sort((a, b) => a - b);
  for (const hops of hopKeys) {
    const list = byHop.get(hops)!.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, hopLabel(hops), list.length));
    for (const n of list) tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget));
  }
  if (lrNodes.length) {
    lrNodes.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Long-Range (direct to controller)', lrNodes.length));
    for (const n of lrNodes) tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget));
  }
  if (pending.length) {
    pending.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Route pending', pending.length));
    for (const n of pending) tree.push(nodeLine(view, n, null, noise, nameBudget));
  }

  /* ── repeater-load panel (pinned to the bottom, kept in a small budget) ─ */
  const panel = repeaterLoadPanel(view, ctx, endNodes, nameBudget).slice(
    0,
    Math.max(1, H - 3),
  );

  /* ── assemble: title row + windowed tree + pinned panel = exactly H ───── */
  const out: string[] = [];
  out.push(truncate(titleBar(view, endNodes.length, directCount, repeatedCount, lrNodes.length, pending.length), W));

  const bodyCap = Math.max(1, H - 1 - panel.length);
  if (tree.length <= bodyCap) {
    for (const line of tree) out.push(truncate(line, W));
    while (out.length < 1 + bodyCap) out.push('');
  } else {
    const shown = bodyCap - 1; // reserve the last body row for the overflow note
    for (let i = 0; i < shown; i++) out.push(truncate(tree[i], W));
    out.push(truncate(c.grey(`  …${tree.length - shown} more`), W));
  }
  for (const line of panel) out.push(truncate(line, W));

  return out.slice(0, H);
}

/* ── title / summary bar ─────────────────────────────────────────────────── */

function titleBar(
  view: ViewState,
  total: number,
  direct: number,
  repeated: number,
  lr_: number,
  pend: number,
): string {
  const parts = [
    c.whiteB(`${total} nodes`),
    c.green(`${direct} direct`),
    c.white(`${repeated} repeated`),
    ...(lr_ > 0 ? [c.blue(`${lr_} LR`)] : []),
    ...(pend > 0 ? [c.yellow(`${pend} pending`)] : []),
  ];
  return lr(c.cyanB('TOPOLOGY / ROUTES'), parts.join(c.grey(' · ')), view.cols);
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
  const right = rateCell(lwr) + '  ' + signalCell(view, lwr, noise);
  return lr(left, right, view.cols);
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
    const barColor = k >= 5 ? 'red' : k >= 3 ? 'yellow' : 'green';
    const textColor = k >= 5 ? c.red : k >= 3 ? c.yellow : c.green;
    const left = '  ' + c.white(`n${id}`) + ' ' + c.white(truncate(name, nameBudget));
    const right =
      bar(k / max, 8, barColor) +
      ' ' +
      textColor(`carries ${k} ${k === 1 ? 'node' : 'nodes'}`);
    lines.push(lr(left, right, view.cols));
  }
  return lines;
}
