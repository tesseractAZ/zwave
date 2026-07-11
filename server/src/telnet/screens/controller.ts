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
  bar,
  c,
  lr,
  padEnd,
  padStart,
  truncate,
} from '../ansi';
import {
  NodeStatus,
  type ControllerSnapshot,
  type ScreenCtx,
} from '../../types';
import { centeredNotice } from './overview';

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
    trafficBlock(ctrl, W),
    backgroundBlock(ctrl, data, W),
    healthBlock(ctx, W),
  ];

  const out: string[] = [titleLine(ctrl, W)];
  let spare = H - 1 - blocks.reduce((s, b) => s + b.length, 0);
  for (const b of blocks) {
    if (spare > 0) {
      out.push('');
      spare--;
    }
    out.push(...b);
  }

  // Fill to H rows, then defensively clamp width + height (never overrun cols).
  while (out.length < H) out.push('');
  return out.slice(0, H).map((l) => truncate(l, W));
}

/* ── title ─────────────────────────────────────────────────────────────── */

function titleLine(ctrl: ControllerSnapshot, W: number): string {
  const left = c.cyanB('CONTROLLER & NETWORK');
  const model = ctrl.model ?? ctrl.manufacturer ?? '—';
  const right = c.grey(`node ${ctrl.nodeId} · `) + c.white(model);
  return lr(left, right, W);
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
      ? c.whiteB(
          '0x' + (ctrl.homeId >>> 0).toString(16).toUpperCase().padStart(8, '0'),
        ) + c.grey(` (${ctrl.homeId >>> 0})`)
      : c.grey('—');

  const roles = [
    ctrl.isPrimary ? c.green('primary') : c.yellow('secondary'),
    ctrl.isSUC ? c.green('SUC') : c.grey('no SUC'),
    ctrl.isSISPresent ? c.green('SIS') : c.grey('no SIS'),
  ].join(c.grey(' · '));

  const rebuild = ctrl.isRebuildingRoutes
    ? c.yellowB('rebuilding…')
    : c.grey('idle');

  return [
    head('IDENTITY', W),
    grid2(kv('Manufacturer', val(ctrl.manufacturer), KL), kv('Home ID', homeId, KR), W),
    grid2(kv('Model', val(ctrl.model), KL), kv('RF Region', val(ctrl.rfRegion), KR), W),
    grid2(kv('Firmware', val(ctrl.firmwareVersion), KL), kv('SDK', val(ctrl.sdkVersion), KR), W),
    grid2(kv('Roles', roles, KL), kv('Rebuild', rebuild, KR), W),
  ];
}

function val(s: string | null): string {
  return s ? c.white(s) : c.grey('—');
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
  return [head(label, W), row1, row2];
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
    // Future-proof: if HA ever reports per-channel noise, show it.
    const chans = ctrl.backgroundRSSI
      .map((r, i) => c.grey(`ch${i} `) + noiseColor(r)(`${r}dBm`))
      .join(c.grey('  '));
    lines.push(chans);
  } else {
    lines.push(
      c.grey('per-channel noise floor: ') + c.yellow('not reported by HA'),
    );
  }

  // The representative floor the SNR-margin math actually uses (data.noiseFloor).
  const noise = data.noiseFloor();
  const tag = data.hasRealNoise() ? c.grey(' (measured)') : c.grey(' (assumed fallback)');
  lines.push(c.grey('margin reference: ') + noiseColor(noise)(`${noise}dBm`) + tag);

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

  for (const n of members) {
    const g = data.scoreFor(n.nodeId).grade as Grade;
    if (g in counts) counts[g]++;

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
  const maxCount = Math.max(1, ...GRADES.map((g) => counts[g]));
  const barW = Math.max(8, Math.min(40, W - 30));

  const rows = GRADES.map((g) => {
    const n = counts[g];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    return (
      gradeLetter(g) +
      ' ' +
      bar(n / maxCount, barW, gradeBarColor(g)) +
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

  return [head(`NETWORK HEALTH (${total})`, W), ...rows, statusLine, linkLine];
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

function gradeBarColor(g: Grade): keyof typeof c {
  switch (g) {
    case 'A':
    case 'B':
      return 'green';
    case 'C':
    case 'D':
      return 'yellow';
    default:
      return 'red';
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
