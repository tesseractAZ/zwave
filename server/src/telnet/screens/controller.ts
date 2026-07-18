/**
 * CONTROLLER & NETWORK overlay — v0.2 live.
 *
 * The whole-network dossier for node 1 (the primary controller) plus a
 * roll-up of the mesh it runs:
 *
 *   title    CONTROLLER & NETWORK                     node 1 · ZST39
 *   IDENTITY manufacturer/model, home id (hex+dec), RF region, fw/SDK,
 *            roles (primary/SUC/SIS), rebuilding-routes flag
 *   TRAFFIC  controller.statistics as a labelled counter grid
 *            (messages TX/RX, dropped TX/RX, NAK, CAN, timeout ACK/resp)
 *   BACKGND  per-channel noise floor — HA doesn't report it, so we say so
 *   HEALTH   A..F grade histogram (bar per band) + alive/dead/asleep and
 *            direct/routed/LR link tallies across the member nodes
 *
 * Style matches overview.ts: single-cell glyphs, ANSI-aware column padding,
 * cyan section rules, grey labels. Returns exactly view.rows lines, each no
 * wider than view.cols.
 */

import {
  c,
  lr,
  padEnd,
  padStart,
  truncate,
  visLen,
} from '../ansi';
import { gauge, meter, fmtElapsed, spinner } from '../gauges';
import {
  NodeStatus,
  type ControllerSnapshot,
  type ScreenCtx,
} from '../../types';
import { centeredNotice } from './overview';
import { frame } from '../chrome';

type ColorFn = (s: string) => string;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function renderController(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const H = view.rows;

  const ctrl = data.controller();
  if (!ctrl) {
    return centeredNotice(view, 'CONTROLLER & NETWORK', [
      c.grey('Controller not loaded yet…'),
    ]);
  }

  // Build the screen as a title line followed by four section blocks; adaptive
  // spacing inserts a blank between blocks only while there's vertical room.
  const blocks: string[][] = [
    identityBlock(ctrl, W),
    // Only present while a rebuild is running — keeps the frame hash static
    // (anti-flicker) when idle, and animates once per 1 Hz redraw otherwise.
    ...(ctrl.isRebuildingRoutes ? [rebuildBlock(ctrl, W)] : []),
    trafficBlock(ctrl, W),
    backgroundBlock(ctrl, data, W),
    healthBlock(ctx, W),
  ];

  // A blank line between each section; frame() pads the remainder.
  const body: string[] = [];
  for (const b of blocks) {
    if (body.length > 0) body.push('');
    body.push(...b);
  }
  // If the roll-up is taller than the frame body, mark the overflow instead of
  // letting frame() silently drop the trailing NETWORK HEALTH tallies.
  const bodyCap = Math.max(1, H - 3); // masthead + rule + command bar
  if (body.length > bodyCap) {
    body.length = Math.max(0, bodyCap - 1);
    body.push(c.grey('  …more (taller terminal shows the full roll-up)'));
  }

  const model = ctrl.model ?? ctrl.manufacturer ?? '—';
  return frame(view, data, {
    title: 'CONTROLLER & NETWORK',
    rightStatus: c.grey(`NODE ${ctrl.nodeId} · `) + c.white(model),
    body,
    keys: [['1-8', 'SCREENS'], ['Q', 'BACK']],
  });
}

/* ── section rule (grey ─── fill after a cyan label) ───────────────────── */

function head(label: string, W: number): string {
  const used = label.length + 1;
  const fill = Math.max(0, W - used);
  return c.label(label) + ' ' + c.grey('─'.repeat(fill));
}

/* ── IDENTITY ──────────────────────────────────────────────────────────── */

function identityBlock(ctrl: ControllerSnapshot, W: number): string[] {
  const KL = 13; // left-column key width
  const KR = 11; // right-column key width

  const homeId =
    ctrl.homeId != null
      ? c.whiteB('0x' + (ctrl.homeId >>> 0).toString(16).toUpperCase().padStart(8, '0')) +
        // The redundant decimal is dropped on narrow terminals so grid2 can't clip it.
        (W >= 72 ? c.grey(` (${ctrl.homeId >>> 0})`) : '')
      : c.grey('—');

  const roles = [
    ctrl.isPrimary ? c.green('primary') : c.yellow('secondary'),
    ctrl.isSUC ? c.green('SUC') : c.grey('no SUC'),
    ctrl.isSISPresent ? c.green('SIS') : c.grey('no SIS'),
  ].join(c.grey(' · '));

  const rebuild = ctrl.isRebuildingRoutes
    ? c.yellowB('rebuilding…')
    : c.grey('idle');

  // Fleet firmware: count of nodes reporting an available update. Phrased so a
  // pre-poll 0 reads "none pending" (honest) rather than claiming "all current".
  const fwUpd =
    ctrl.firmwareUpdatesAvailable > 0
      ? c.blue(`${ctrl.firmwareUpdatesAvailable} node(s) — update available`)
      : c.grey('none pending');

  return [
    head('IDENTITY', W),
    grid2(kv('Manufacturer', val(ctrl.manufacturer), KL), kv('Home ID', homeId, KR), W),
    grid2(kv('Model', val(ctrl.model), KL), kv('RF Region', val(ctrl.rfRegion), KR), W),
    grid2(kv('Firmware', val(ctrl.firmwareVersion), KL), kv('SDK', val(ctrl.sdkVersion), KR), W),
    grid2(kv('Roles', roles, KL), kv('Rebuild', rebuild, KR), W),
    grid2(kv('Node FW', fwUpd, KL), kv('', '', KR), W),
  ];
}

function val(s: string | null): string {
  return s ? c.white(s) : c.grey('—');
}

/* ── rebuild-routes banner (present only while rebuilding) ─────────────────
 * HA exposes only the is_rebuilding_routes boolean — no per-node progress — so
 * this shows honest ELAPSED time + an indeterminate sweep, never a fake %. */

function rebuildBlock(ctrl: ControllerSnapshot, W: number): string[] {
  const elapsed = ctrl.rebuildStartedAt != null ? fmtElapsed(Date.now() - ctrl.rebuildStartedAt) : '—';
  return [
    head('REBUILD ROUTES', W),
    '  ' + c.yellowB(`${spinner(Date.now())} rebuilding`) + c.grey(' · elapsed ') + c.white(elapsed),
    '  ' + indeterminateBar(Math.max(8, Math.min(W - 4, 48))),
    c.grey('  network reoptimizing — some nodes may be briefly unresponsive'),
  ];
}

/** A sweeping indeterminate bar (fixed visible width = `width` cells). */
function indeterminateBar(width: number): string {
  const w = Math.max(4, width);
  const win = Math.max(2, Math.round(w / 5));
  const pos = Math.floor(Date.now() / 400) % w; // ~2.5 cells/sec at the 1 Hz redraw
  let s = '';
  for (let i = 0; i < w; i++) {
    s += (i - pos + w) % w < win ? c.cyanB('▓') : c.grey('░');
  }
  return s;
}

/* ── TRAFFIC (controller.statistics) ───────────────────────────────────── */

function trafficBlock(ctrl: ControllerSnapshot, W: number): string[] {
  const st = ctrl.statistics;
  const cell = (label: string, v: number | null, err: boolean) =>
    statCell(label, counter(v, err), Math.floor(W / 4));

  const row1 = [
    cell('messages TX', st ? st.messagesTX : null, false),
    cell('messages RX', st ? st.messagesRX : null, false),
    cell('dropped TX', st ? st.messagesDroppedTX : null, true),
    cell('dropped RX', st ? st.messagesDroppedRX : null, true),
  ].join('');

  const row2 = [
    cell('NAK', st ? st.NAK : null, true),
    cell('CAN', st ? st.CAN : null, true),
    cell('timeout ACK', st ? st.timeoutACK : null, true),
    cell('timeout resp', st ? st.timeoutResponse : null, true),
  ].join('');

  const label = st ? 'TRAFFIC' : 'TRAFFIC (not reported)';
  const lines = [head(label, W), row1, row2];

  // Small reliability indicator: fraction of all frames that errored
  // (dropped + NAK/CAN + timeouts) vs total messages. Low is good.
  if (st) lines.push(trafficHealthLine(st, W));
  return lines;
}

/** Error-rate meter derived from the counter grid; the counters stay authoritative. */
function trafficHealthLine(
  st: NonNullable<ControllerSnapshot['statistics']>,
  W: number,
): string {
  const messages = st.messagesTX + st.messagesRX;
  const errors =
    st.messagesDroppedTX +
    st.messagesDroppedRX +
    st.NAK +
    st.CAN +
    st.timeoutACK +
    st.timeoutResponse;
  const denom = messages + errors;
  const frac = denom > 0 ? errors / denom : 0;
  const pct = frac * 100;
  const pctStr = pct > 0 && pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  const label = errColor(frac)(`${pctStr}% errors`);
  const barW = Math.max(6, Math.min(20, W - 34));
  return c.grey('reliability ') + gauge(frac, barW, label, { dir: 'lowGood' });
}

function errColor(frac: number): ColorFn {
  if (frac < 0.02) return c.green;
  if (frac < 0.1) return c.yellow;
  return c.red;
}

/** One counter cell: grey label on the left, value right-aligned, 1-col gutter. */
function statCell(label: string, value: string, cellW: number): string {
  return padEnd(lr(c.grey(label), value, Math.max(1, cellW - 1)), cellW);
}

/** Format a counter — mains white for volume, yellow when an error count is nonzero. */
function counter(v: number | null, err: boolean): string {
  if (v == null) return c.grey('—');
  if (!err) return c.whiteB(String(v));
  return v > 0 ? c.yellow(String(v)) : c.grey('0');
}

/* ── BACKGROUND RSSI ───────────────────────────────────────────────────── */

function backgroundBlock(
  ctrl: ControllerSnapshot,
  data: ScreenCtx['data'],
  W: number,
): string[] {
  const lines = [head('BACKGROUND RSSI', W)];

  if (ctrl.backgroundRSSI.length > 0) {
    // Future-proof: if HA ever reports per-channel noise, show each channel as
    // a quiet-is-good gauge (full/green = quiet floor), wrapped to fit W.
    const chBarW = W >= 100 ? 8 : 6;
    const tokens = ctrl.backgroundRSSI.map(
      (r, i) =>
        c.grey(`ch${i} `) +
        gauge(noiseQuietFrac(r), chBarW, noiseColor(r)(`${r}dBm`)),
    );
    lines.push(...packTokens(tokens, W, 2));
  } else {
    lines.push(
      c.grey('per-channel noise floor: ') + c.yellow('not reported by HA'),
    );
  }

  // The representative floor the SNR-margin math actually uses (data.noiseFloor),
  // shown with a quiet-is-good reference meter so the margin baseline is visible
  // even when HA reports no per-channel noise.
  const noise = data.noiseFloor();
  const tag = data.hasRealNoise() ? c.grey(' (measured)') : c.grey(' (assumed fallback)');
  const refBarW = Math.max(6, Math.min(14, W - 40));
  lines.push(
    c.grey('margin ref ') +
      gauge(noiseQuietFrac(noise), refBarW, noiseColor(noise)(`${noise}dBm`)) +
      tag,
  );

  return lines;
}

/** Quiet floor is good: −100 dBm → 1.0 (full), −40 dBm → 0.0 (empty). */
function noiseQuietFrac(dbm: number): number {
  return clamp01((-40 - dbm) / 60);
}

/** Greedy-wrap already-styled tokens into lines whose visible width stays ≤ W. */
function packTokens(tokens: string[], W: number, gapN: number): string[] {
  const gap = ' '.repeat(gapN);
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const t of tokens) {
    const tW = visLen(t);
    if (cur === '') {
      cur = t;
      curW = tW;
    } else if (curW + gapN + tW <= W) {
      cur += gap + t;
      curW += gapN + tW;
    } else {
      lines.push(cur);
      cur = t;
      curW = tW;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

function noiseColor(noise: number): (s: string) => string {
  if (noise >= -75) return c.red;
  if (noise >= -85) return c.yellow;
  return c.grey;
}

/* ── NETWORK HEALTH DISTRIBUTION ───────────────────────────────────────── */

const GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
type Grade = (typeof GRADES)[number];

function healthBlock(ctx: ScreenCtx, W: number): string[] {
  const { data } = ctx;
  // Exclude the controller (node 1) — this is the mesh it serves, not itself.
  const members = data.nodes().filter((n) => !n.isController);

  if (members.length === 0) {
    return [head('NETWORK HEALTH', W), c.grey('no member nodes yet')];
  }

  const counts: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let alive = 0;
  let dead = 0;
  let asleep = 0;
  let direct = 0;
  let routed = 0;
  let longRange = 0;
  let scoreSum = 0;

  for (const n of members) {
    const h = data.scoreFor(n.nodeId);
    const g = h.grade as Grade;
    if (g in counts) counts[g]++;
    scoreSum += h.score;

    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) alive++;
    else if (n.status === NodeStatus.Dead) dead++;
    else if (n.status === NodeStatus.Asleep) asleep++;

    if (n.isLongRange) longRange++;
    else if (n.stats.lwr) {
      if (n.stats.lwr.repeaters.length > 0) routed++;
      else direct++;
    }
  }

  const total = members.length;
  const meanScore = total > 0 ? Math.round(scoreSum / total) : 0;
  const maxCount = Math.max(1, ...GRADES.map((g) => counts[g]));
  const barW = Math.max(8, Math.min(40, W - 30));

  // Big network-health gauge — the mesh's mean member score, coloured by the
  // same health thresholds the Overview uses (≥80 green, ≥40 yellow, else red).
  const gaugeBarW = Math.max(8, Math.min(24, W - 22));
  const meanColor = colorForScore(meanScore);
  const meanLine =
    c.grey('mean score ') +
    gauge(meanScore / 100, gaugeBarW, meanColor(`${meanScore} avg`), {
      color: meanColor,
    });

  const rows = GRADES.map((g) => {
    const n = counts[g];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    return (
      gradeLetter(g) +
      ' ' +
      meter(n / maxCount, barW, { color: gradeMeterColor(g) }) +
      '  ' +
      c.white(padStart(String(n), 3)) +
      '  ' +
      c.grey(padStart(`${pct}%`, 4))
    );
  });

  const statusLine =
    c.grey('nodes ') +
    c.whiteB(String(total)) +
    c.grey('  ·  ') +
    c.green(`${alive} alive`) +
    c.grey(' · ') +
    (dead > 0 ? c.redB(`${dead} dead`) : c.grey('0 dead')) +
    c.grey(' · ') +
    (asleep > 0 ? c.cyan(`${asleep} asleep`) : c.grey('0 asleep'));

  const linkLine =
    c.grey('links ') +
    c.white(`${direct} direct`) +
    c.grey(' · ') +
    c.white(`${routed} routed`) +
    c.grey(' · ') +
    (longRange > 0 ? c.blue(`${longRange} LR`) : c.grey('0 LR'));

  return [
    head(`NETWORK HEALTH (${total})`, W),
    meanLine,
    ...rows,
    statusLine,
    linkLine,
  ];
}

/** Score → colour, matching the Overview's health thresholds. */
function colorForScore(score: number): ColorFn {
  if (score >= 80) return c.green;
  if (score >= 40) return c.yellow;
  return c.red;
}

function gradeLetter(g: Grade): string {
  switch (g) {
    case 'A':
      return c.greenB(g);
    case 'B':
      return c.green(g);
    case 'C':
      return c.yellow(g);
    case 'D':
      return c.yellowB(g);
    default:
      return c.redB(g);
  }
}

/** Per-grade meter fill colour (distinct shade per band). */
function gradeMeterColor(g: Grade): ColorFn {
  switch (g) {
    case 'A':
      return c.greenB;
    case 'B':
      return c.green;
    case 'C':
      return c.yellow;
    case 'D':
      return c.yellowB;
    default:
      return c.redB;
  }
}

/* ── layout helpers ────────────────────────────────────────────────────── */

/** grey key (padded) immediately followed by an already-styled value. */
function kv(key: string, value: string, keyW: number): string {
  return c.grey(padEnd(key, keyW)) + value;
}

/** Two equal columns with a single-space gutter; never exceeds W visible cols. */
function grid2(a: string, b: string, W: number): string {
  const leftW = Math.floor((W - 1) / 2);
  return padEnd(truncate(a, leftW), leftW) + ' ' + truncate(b, W - leftW - 1);
}
