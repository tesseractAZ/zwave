/**
 * NODE DETAIL — the per-node dossier overlay (v0.2, live statistics).
 *
 * A full-frame card for the node the operator has selected on the Overview.
 * Five stacked sections inside a double-line border:
 *
 *   header   [8] Kitchen Lamp — alive — 100 (A)          W F
 *   IDENTITY manufacturer/model · security · radio caps · power · area
 *   LIVE LINK status glyph + lastSeen · RTT · RSSI + SNR margin · drop%
 *   ROUTES   LWR (and NLWR) repeater chains, per-hop RSSI, data rate, fails
 *   TRAFFIC  commands TX/RX, dropped TX/RX, response timeouts
 *
 * Everything is coloured by the same health discipline the Overview uses:
 * green healthy, yellow weak, red failing, cyan asleep, grey no-data/mains.
 * The renderer is pure — it reads the cached DataProvider values the session
 * hands it and returns exactly view.rows lines, each ≤ view.cols wide.
 */

import { BOX, c, lr, padEnd, truncate, visLen } from '../ansi';
import {
  NodeStatus,
  type NodeSnapshot,
  type RouteStat,
  type ScreenCtx,
} from '../../types';
import { centeredNotice } from './overview';

/** Driver RSSI sentinels (not-available / saturated / no-signal) — never real dBm. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

/** protocolDataRate → human label (shared vocabulary with the Overview). */
const DATA_RATE_LABEL: Record<number, string> = { 1: '9.6k', 2: '40k', 3: '100k', 4: 'LR' };

/** One-line meaning for each health flag, shown in the footer for this node. */
const FLAG_MEANING: Record<string, string> = {
  D: 'dead',
  S: 'stale',
  W: 'weak signal',
  F: 'flaky TX',
  R: 'route failed',
  L: 'high latency',
  I: 'interview incomplete',
  B: 'battery low',
};

export function renderDetail(ctx: ScreenCtx): string[] {
  const { view, data, visibleNodes } = ctx;
  const W = view.cols;
  const H = view.rows;

  // Guard: nothing selected (empty roster / out-of-range index).
  const n = visibleNodes[view.selected];
  if (!n) {
    return centeredNotice(view, 'NODE DETAIL', [c.grey('[no node selected]')]);
  }
  // Guard against a pathologically small frame the box couldn't fit into.
  if (W < 24 || H < 6) {
    return centeredNotice(view, 'NODE DETAIL', [c.grey('terminal too small')]);
  }

  const health = data.scoreFor(n.nodeId);
  const noise = data.noiseFloor();
  const inner = W - 2; // space between the ║ borders

  /* ── build the interior content rows (each a plain/coloured string) ──────── */
  const body: string[] = [];
  const sep = () => body.push(SEP); // marker, framed later

  // Header: identity line + flags pushed to the right edge.
  {
    const st = statusColor(n.status)(n.statusLabel);
    const sc = dead(n)
      ? c.grey('—')
      : scoreColor(health.score)(`${health.score} (${health.grade})`);
    const left =
      c.cyanB(`[${n.nodeId}]`) + ' ' + c.whiteB(n.name) +
      c.grey('  —  ') + st + c.grey('  —  ') + sc;
    const flags = health.flags.length
      ? flagColor(health.flags)(health.flags.join(' '))
      : '';
    body.push(' ' + lr(left, flags, inner - 1));
  }
  sep();

  // IDENTITY — device, security, radio capabilities, power, location.
  body.push(section('IDENTITY'));
  {
    const dev = [n.manufacturer, n.model].filter(Boolean).join(' ').trim();
    body.push(kv('Device', dev || c.grey('unknown device'), inner));

    let sec: string;
    if (n.isSecure === true) {
      sec = c.green('secure') + (n.securityClass ? c.grey(' · ') + c.white(n.securityClass) : '');
    } else if (n.isSecure === false) {
      sec = c.yellow('unencrypted');
    } else {
      sec = c.grey('security unknown');
    }
    body.push(kv('Security', sec, inner));

    const caps: string[] = [];
    caps.push(n.isController ? c.cyanB('controller') : n.isRouting ? c.white('routing') : c.grey('end-device'));
    caps.push(n.isLongRange ? c.blue('Long-Range') : c.grey('mesh'));
    if (n.ready) caps.push(c.grey('interviewed'));
    else caps.push(c.yellow('interviewing'));
    body.push(kv('Radio', caps.join(c.grey(' · ')), inner));

    body.push(kv('Power', powerLabel(n), inner));

    const loc =
      (n.area ? c.white(n.area) : c.grey('no area')) +
      c.grey(' · ') +
      c.grey(`${n.entities.length} entit${n.entities.length === 1 ? 'y' : 'ies'}`);
    body.push(kv('Area', loc, inner));
  }
  sep();

  // LIVE LINK — reachability + RF quality of the last exchange.
  body.push(section('LIVE LINK'));
  {
    const s = n.stats;
    const glyph = statusGlyph(n.status);
    const seen = s.lastSeen != null ? c.grey(`seen ${fmtAge(Date.now() - s.lastSeen)} ago`) : c.grey('never seen');
    const statusVal = glyph.color(glyph.ch + ' ' + n.statusLabel) + c.grey('  ') + seen;
    const rttVal =
      s.rtt == null ? c.grey('—') : rttColor(s.rtt)(`${Math.round(s.rtt)} ms`);
    body.push(twoCol('Status', statusVal, 'RTT', rttVal, inner));

    // RSSI + SNR margin (rssi − noiseFloor). Sentinels read as no-signal.
    const rssi = validRssi(s.rssi);
    let rssiVal: string;
    let marginVal: string;
    if (rssi == null) {
      rssiVal = c.grey('—');
      marginVal = c.grey('—');
    } else {
      rssiVal = rssiColor(rssi)(`${rssi} dBm`);
      const m = rssi - noise;
      marginVal =
        marginColor(m)(`${m >= 0 ? '+' : ''}${m} dB`) +
        (data.hasRealNoise() ? '' : c.grey(' est'));
    }
    body.push(twoCol('RSSI', rssiVal, 'Margin', marginVal, inner));

    // Drop% = (droppedTX + response timeouts) / TX, clamped so the headline and
    // the "N of M" text stay sane even if the driver's counters briefly disagree.
    const denom = Math.max(1, s.commandsTX);
    const drops = Math.min(s.commandsDroppedTX + s.timeoutResponse, s.commandsTX);
    const pct = Math.min(100, (drops / denom) * 100);
    const dropVal =
      s.commandsTX <= 0
        ? c.grey('— (no TX yet)')
        : dropColor(pct)(`${pct.toFixed(1)}%`) +
          c.grey(` (${drops} of ${s.commandsTX} tx)`);
    body.push(kv('Drop', dropVal, inner));
  }
  sep();

  // ROUTES — the last working route (and next-to-last, if present).
  body.push(section('ROUTES'));
  {
    const lwr = n.stats.lwr;
    if (n.isLongRange) {
      // LR nodes talk straight to the controller — no mesh route to show.
      body.push(kv('LWR', c.blue('direct to controller (Long-Range star)'), inner));
    } else if (!lwr) {
      body.push(kv('LWR', c.grey('no route data yet'), inner));
    } else {
      pushRoute(body, 'LWR', lwr, inner);
    }
    // NLWR only when the driver actually reports a fallback route.
    if (!n.isLongRange && n.stats.nlwr) {
      pushRoute(body, 'NLWR', n.stats.nlwr, inner);
    }
  }
  sep();

  // TRAFFIC — command counters (per-node lifetime, from node statistics).
  body.push(section('TRAFFIC'));
  {
    const s = n.stats;
    const dTx = s.commandsDroppedTX > 0 ? c.yellow(String(s.commandsDroppedTX)) : c.grey('0');
    const dRx = s.commandsDroppedRX > 0 ? c.yellow(String(s.commandsDroppedRX)) : c.grey('0');
    const to = s.timeoutResponse > 0 ? c.yellow(String(s.timeoutResponse)) : c.grey('0');
    const line =
      c.label('TX ') + c.white(String(s.commandsTX)) + c.grey(' · ') +
      c.label('RX ') + c.white(String(s.commandsRX)) + c.grey('  ·  ') +
      c.label('dropped ') + c.grey('tx ') + dTx + c.grey(' rx ') + dRx + c.grey('  ·  ') +
      c.label('timeouts ') + to;
    body.push(truncate('  ' + line, inner));
  }

  /* ── frame + fit to exactly H rows ───────────────────────────────────────── */
  return frameToHeight(body, footer(health, inner, ctx.actionsEnabled ?? false), inner, W, H);
}

/* ── route rendering ─────────────────────────────────────────────────────── */

/**
 * Push one route as a single row: the repeater chain, then rate / route-RSSI /
 * a route-failed marker. The failed marker is placed first after the chain so a
 * narrow-terminal truncation can never drop it before the (advisory) rate/rssi.
 */
function pushRoute(body: string[], label: string, route: RouteStat, inner: number): void {
  const bits: string[] = [];
  if (route.routeFailedBetween) {
    const [a, b] = route.routeFailedBetween;
    bits.push(c.red(`⚠ failed n${a}↮n${b}`));
  }
  const rate = route.protocolDataRate;
  if (rate != null) {
    const rl = DATA_RATE_LABEL[rate] ?? '?';
    bits.push((rate >= 3 ? c.green : rate === 2 ? c.yellow : c.red)(rl));
  }
  const rssi = validRssi(route.rssi);
  if (rssi != null) bits.push(rssiColor(rssi)(`${rssi} dBm`));

  const tail = bits.length ? c.grey('  ·  ') + bits.join(c.grey(' · ')) : '';
  body.push(kv(label, routeChain(route) + tail, inner));
}

/**
 * Build "controller ← n3 ← n8 ← node", each repeater annotated with its
 * repeaterRSSI[] hop reading. Empty repeaters ⇒ a direct link.
 */
function routeChain(route: RouteStat): string {
  const reps = Array.isArray(route.repeaters) ? route.repeaters : [];
  const arrow = c.grey(' ← ');
  const parts: string[] = [c.grey('controller')];
  reps.forEach((r, i) => {
    const hop = route.repeaterRSSI?.[i];
    const ann =
      hop != null && Number.isFinite(hop) && !RSSI_SENTINELS.has(hop)
        ? c.grey('(') + rssiColor(hop)(`${hop}`) + c.grey(')')
        : '';
    parts.push(c.white('n' + r) + ann);
  });
  parts.push(c.whiteB('node'));
  const chain = parts.join(arrow);
  return reps.length === 0 ? chain + c.grey('  · direct') : chain;
}

/* ── section / row builders (return the INNER content string) ────────────── */

const SEP = '\x00SEP'; // sentinel: this body entry is a ╠──╣ rule, not content

function section(title: string): string {
  return ' ' + c.cyanB(title);
}

/** Label + value row, label column fixed at 9 cols, indented 2. */
function kv(k: string, v: string, inner: number): string {
  const labelCell = k ? c.label(k.padEnd(8)) : ' '.repeat(8);
  const left = '  ' + labelCell + ' ';
  // Truncate the value so the row never exceeds the inner width.
  return truncate(left + v, inner);
}

/** Two label/value pairs on one row: left pair, right pair. */
function twoCol(k1: string, v1: string, k2: string, v2: string, inner: number): string {
  const left = c.label(k1.padEnd(8)) + ' ' + v1;
  const right = c.label(k2.padEnd(7)) + ' ' + v2;
  return truncate('  ' + lr(left, right, inner - 2), inner);
}

/** Power lane: a battery entity (or a reported level) ⇒ battery, else mains. */
function powerLabel(n: NodeSnapshot): string {
  if (n.battery != null) {
    const lvl = n.battery.level;
    const col = lvl <= 25 || n.battery.isLow ? c.red : lvl <= 50 ? c.yellow : c.green;
    return col(`battery-powered · ${lvl}%`);
  }
  const isBattery = n.entities.some((e) => /_battery/i.test(e.entityId));
  return isBattery ? c.cyan('battery-powered') : c.grey('mains (AC)');
}

/* ── framing: wrap content in the double border, fit to H rows ───────────── */

function frameToHeight(
  body: string[],
  footerContent: string,
  inner: number,
  W: number,
  H: number,
): string[] {
  const vL = c.cyan(BOX.v);
  const frame = (content: string) =>
    content === SEP
      ? c.cyan(BOX.lJoint + BOX.lh.repeat(inner) + BOX.rJoint)
      : vL + padEnd(content, inner) + vL;
  const emptyRow = vL + ' '.repeat(inner) + vL;

  const capacity = H - 2; // interior rows between top & bottom borders
  const footerRow = frame(footerContent);

  // Reserve the last interior row for the footer; fit/pad the rest. If the body
  // doesn't fit, show a "…N more" marker instead of silently dropping sections.
  const contentCap = Math.max(0, capacity - 1);
  let interior: string[];
  if (body.length > contentCap && contentCap >= 1) {
    interior = body.slice(0, contentCap - 1).map(frame);
    interior.push(frame(c.grey(`  …${body.length - (contentCap - 1)} more rows (widen the terminal)`)));
  } else {
    interior = body.slice(0, contentCap).map(frame);
    while (interior.length < contentCap) interior.push(emptyRow);
  }
  if (capacity >= 1) interior.push(footerRow);

  const out: string[] = [];
  out.push(topBorder(inner, 'NODE DETAIL'));
  out.push(...interior);
  out.push(c.cyan(BOX.bl + BOX.h.repeat(inner) + BOX.br));

  // Defensive: guarantee exactly H rows, each ≤ W visible columns.
  const clamped = out.slice(0, H).map((l) => truncate(l, W));
  while (clamped.length < H) clamped.push('');
  return clamped;
}

/** Top border with the title inlaid: ╔═ NODE DETAIL ═══…═╗ */
function topBorder(inner: number, title: string): string {
  const fill = Math.max(0, inner - 3 - title.length); // ═ + ' ' + title + ' ' + fill
  return (
    c.cyan(BOX.tl + BOX.h) + ' ' + c.cyanB(title) + ' ' +
    c.cyan(BOX.h.repeat(fill) + BOX.tr)
  );
}

/** Footer: this node's flag meanings on the left, dismiss hint on the right. */
function footer(health: { flags: string[] }, inner: number, actionsEnabled: boolean): string {
  // When write actions are on, the footer advertises the per-node actions;
  // otherwise it shows the node's flag meanings.
  const key = (k: string, label: string) => c.cyanB(k) + c.grey(' ' + label);
  const left = actionsEnabled
    ? c.grey('actions: ') +
      [key('p', 'ping'), key('i', 're-interview'), key('h', 'heal'), key('x', 'remove')].join(c.grey(' · '))
    : health.flags.length
      ? c.grey('flags: ') +
        health.flags
          .map((f) => flagColor([f])(f) + c.grey(' ' + (FLAG_MEANING[f] ?? '?')))
          .join(c.grey(' · '))
      : c.grey('RF health nominal');
  const right = c.cyanB('q') + c.grey('/') + c.cyanB('Esc') + c.grey(' back');
  return ' ' + lr(left, right, inner - 1);
}

/* ── colour helpers (mirror the Overview health discipline) ──────────────── */

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

function statusColor(status: NodeStatus): (s: string) => string {
  switch (status) {
    case NodeStatus.Alive:
    case NodeStatus.Awake:
      return c.green;
    case NodeStatus.Asleep:
      return c.cyan;
    case NodeStatus.Dead:
      return c.redB;
    default:
      return c.grey;
  }
}

function scoreColor(score: number): (s: string) => string {
  if (score >= 80) return c.green;
  if (score >= 40) return c.yellow;
  return c.red;
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

function rttColor(rtt: number): (s: string) => string {
  if (rtt <= 100) return c.green;
  if (rtt <= 500) return c.yellow;
  return c.red;
}

function dropColor(pct: number): (s: string) => string {
  if (pct < 5) return c.green;
  if (pct < 15) return c.yellow;
  return c.red;
}

function flagColor(flags: string[]): (s: string) => string {
  const has = (f: string) => flags.includes(f);
  if (has('D') || has('F') || has('R')) return c.red;
  if (has('W') || has('B') || has('L')) return c.yellow;
  if (has('S')) return c.cyan;
  return c.grey;
}

/* ── small utilities ─────────────────────────────────────────────────────── */

function validRssi(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || RSSI_SENTINELS.has(v)) return null;
  return v;
}

function dead(n: NodeSnapshot): boolean {
  return n.status === NodeStatus.Dead || n.status === NodeStatus.Unknown;
}

function fmtAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
