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
import { noiseColor } from '../bands';

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
    ], [['1-8', 'SCREENS'], ['Q', 'BACK']]);
  }

  // Build the screen as a title line followed by four section blocks; adaptive
  // spacing inserts a blank between blocks only while there's vertical room.
  // Surplus is measured against the compact body that will ACTUALLY be drawn.
  // A fixed baseline ignored the CONDITIONAL rebuild block (4 rows + its
  // separator), so during a route rebuild the gate over-counted free rows by 5
  // and the new blocks pushed NETWORK HEALTH's link tally into the overflow
  // marker — evicting pre-existing content to make room for an addition.
  const surplus = surplusRows(H, ctrl.isRebuildingRoutes);
  const blocks: string[][] = [
    identityBlock(ctrl, W),
    // Only present while a rebuild is running — keeps the frame hash static
    // (anti-flicker) when idle, and animates once per 1 Hz redraw otherwise.
    ...(ctrl.isRebuildingRoutes ? [rebuildBlock(ctrl, W)] : []),
    trafficBlock(ctrl, W),
    backgroundBlock(ctrl, data, W),
    healthBlock(ctx, W),
    // Spend spare rows on data this screen has always had access to and never
    // drew (v0.28). Both answer questions the lifetime counters above cannot,
    // and both stay off a short frame entirely.
    ...(surplus >= 4 ? [serialRateBlock(ctx, W)] : []),
    ...(surplus >= 9 ? [meshSymptomBlock(ctx, W)] : []),
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
    // The Controller screen IS the network view, so it owns the mesh-wide
    // actions — `a` here opens NETWORK ACTIONS, not the device menu.
    keys: [['A', 'NETWORK ACTIONS', 1], ['1-8', 'SCREENS'], ['Q', 'BACK']],
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

  // COMPACT FORMS at the narrow floor. grid2() hard-truncates each half, and at
  // 60 columns the SIS term fell off the end entirely — so a controller WITH a
  // SIS and one WITHOUT rendered byte-identically. A shorter spelling keeps the
  // distinction rather than silently dropping it.
  const tight = W < 72;
  const roles = [
    ctrl.isPrimary ? c.green(tight ? 'pri' : 'primary') : c.yellow(tight ? 'sec' : 'secondary'),
    ctrl.isSUC ? c.green('SUC') : c.grey(tight ? '!SUC' : 'no SUC'),
    ctrl.isSISPresent ? c.green('SIS') : c.grey(tight ? '!SIS' : 'no SIS'),
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
  const cellW = Math.floor(W / 4);
  // RESPONSIVE LABELS. lr() protects the value and shortens the label, which is
  // right — but at 60 columns that clipped "messages TX"/"messages RX" to two
  // cells both reading "messages" with different numbers beside them. A short
  // form that still carries the distinguishing part is used when the cell is
  // too narrow for the long one.
  const cell = (label: string, short: string, v: number | null, err: boolean) => {
    const value = counter(v, err);
    const text = visLen(label) + visLen(value) + 1 <= cellW - 1 ? label : short;
    return statCell(text, value, cellW);
  };

  const row1 = [
    cell('messages TX', 'msgs TX', st ? st.messagesTX : null, false),
    cell('messages RX', 'msgs RX', st ? st.messagesRX : null, false),
    cell('dropped TX', 'drop TX', st ? st.messagesDroppedTX : null, true),
    cell('dropped RX', 'drop RX', st ? st.messagesDroppedRX : null, true),
  ].join('');

  const row2 = [
    cell('NAK', 'NAK', st ? st.NAK : null, true),
    cell('CAN', 'CAN', st ? st.CAN : null, true),
    cell('timeout ACK', 'tmo ACK', st ? st.timeoutACK : null, true),
    cell('timeout cb', 'tmo cb', st ? st.timeoutCallback : null, true),
  ].join('');

  const row3 = [
    // Labelled to say what it is: a NODE reply timeout that the controller
    // reports, not a fault on the serial link — so it is deliberately absent
    // from the reliability rate below.
    cell('node reply tmo', 'node tmo', st ? st.timeoutResponse : null, true),
  ].join('');

  // Name what these actually count: frames on the host↔stick serial link, not
  // mesh traffic. Read as "TRAFFIC" they were mistaken for RF activity.
  const label = st ? 'CONTROLLER FRAMES (host↔stick, lifetime)' : 'CONTROLLER FRAMES (not reported)';
  const lines = [head(label, W), row1, row2, row3];

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
  // DENOMINATOR = successes + failures.
  //
  // zwave-js's ControllerStatistics counters are DISJOINT: `messagesTX` counts
  // messages *successfully sent*, and messagesDropped/NAK/CAN/timeoutACK/
  // timeoutResponse are separate failure tallies — not a subset of it. So the
  // total number of attempts is successes + failures, and dividing failures by
  // successes alone yields ODDS, not a rate: it overstates every value and can
  // exceed 100%. (v0.24 briefly made that mistake on the theory that the totals
  // already included the errors. They do not.)
  const messages = st.messagesTX + st.messagesRX;
  // TRUE SERIAL FAULTS only. This block is labelled host↔stick, so its
  // reliability must describe that link. `timeoutResponse` is the controller
  // waiting on a NODE — a mesh symptom that merely surfaces in controller
  // statistics — and interference.ts already excludes it from the serial band
  // for exactly this reason. Folding it in here made the two screens disagree
  // about what a serial fault is. It is still shown as its own counter above.
  const errors =
    st.messagesDroppedTX +
    st.messagesDroppedRX +
    st.NAK +
    st.CAN +
    st.timeoutACK +
    // A callback timeout IS host↔stick (the controller never called back), so
    // it belongs here — and omitting it let a pure callback-timeout wedge, a
    // classic sick stick, render as a full green bar reading 0.0% errors.
    (st.timeoutCallback ?? 0);
  const denom = messages + errors;

  // Nothing has crossed the serial link yet: there is no rate to report, and a
  // full green bar reading "0.0% errors" would assert a perfect link on no
  // evidence at all.
  if (denom === 0) {
    return c.grey('reliability ') + c.grey('— no frames yet');
  }

  const frac = clamp01(errors / denom);
  const pct = frac * 100;
  // A counter HA did not report is NOT a zero. Summing null as 0 let the bar
  // claim a rate it cannot actually compute, so the gap is disclosed.
  const partial = st.timeoutCallback == null ? c.grey(' (partial)') : '';
  // Never round a nonzero error rate down to a flat "0.00%" — a rate that small
  // is still not none, and the counters beside it show a nonzero total.
  const pctStr = pct === 0 ? '0.0' : pct < 0.01 ? '<0.01' : pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
  const label = errColor(frac)(`${pctStr}% errors`);
  const barW = Math.max(6, Math.min(20, W - 34));
  // The bar is labelled "reliability", so it must FILL with the success rate.
  // Filling it with the error fraction drained the bar to empty on a perfect
  // link — the exact inverse of what the label promised.
  return c.grey('reliability ') + gauge(1 - frac, barW, label, { color: errColor(frac) }) + partial;
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

/**
 * Compact a large counter: 12345 → "12345", 1234567 → "1.2M".
 *
 * Lifetime frame counters reach seven figures, and a character-clipped
 * `1234567` renders as `12345` — a number that looks exact and is wrong by two
 * orders of magnitude. An explicit k/M/G suffix is approximate but says so.
 */
function fmtCount(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a < 100_000) return String(v);
  if (a < 1_000_000) return `${Math.round(v / 1000)}k`;
  if (a < 1_000_000_000) return `${(v / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0)}M`;
  return `${(v / 1_000_000_000).toFixed(1)}G`;
}

/** Format a counter — mains white for volume, yellow when an error count is nonzero. */
function counter(v: number | null, err: boolean): string {
  if (v == null) return c.grey('—');
  if (!err) return c.whiteB(fmtCount(v));
  return v > 0 ? c.yellow(fmtCount(v)) : c.grey('0');
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
        // Fill AND colour from the same reading: gauge()'s default zoneColor
        // grades the quietness fraction on a different ramp than the label's
        // noiseColor, so a noisy channel drew a reassuring bar beside a red
        // number. One value, one colour (bands.ts).
        gauge(noiseQuietFrac(r), chBarW, noiseColor(r)(`${r}dBm`), { color: noiseColor(r) }),
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
      // Fill AND label from the same band function. gauge()'s default zoneColor
      // grades quietness on an unrelated ramp, so a noisy floor drew a
      // reassuring bar beside its own red number — the same defect fixed on the
      // per-channel gauges above, missed on this one.
      gauge(noiseQuietFrac(noise), refBarW, noiseColor(noise)(`${noise}dBm`), { color: noiseColor(noise) }) +
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
  let unknown = 0;
  let direct = 0;
  let routed = 0;
  let longRange = 0;
  let pending = 0;
  let scoreSum = 0;

  for (const n of members) {
    const h = data.scoreFor(n.nodeId);
    const g = h.grade as Grade;
    if (g in counts) counts[g]++;
    scoreSum += h.score;

    if (n.status === NodeStatus.Alive || n.status === NodeStatus.Awake) alive++;
    else if (n.status === NodeStatus.Dead) dead++;
    else if (n.status === NodeStatus.Asleep) asleep++;
    // Unknown had no bucket, so the line below read as a PARTITION that did not
    // add up: nodes the controller has never heard from simply vanished, and a
    // reassuring grey "0 dead" sat beside them.
    else unknown++;

    if (n.isLongRange) longRange++;
    else if (n.stats.lwr) {
      if (n.stats.lwr.repeaters.length > 0) routed++;
      else direct++;
    } else pending++; // no route resolved yet — counted, not dropped
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
    (asleep > 0 ? c.cyan(`${asleep} asleep`) : c.grey('0 asleep')) +
    // Only shown when nonzero: on a healthy mesh it is noise, but when it is
    // nonzero the tallies must still sum to the total.
    (unknown > 0 ? c.grey(' · ') + c.yellow(`${unknown} unknown`) : '');

  const linkLine =
    c.grey('links ') +
    c.white(`${direct} direct`) +
    c.grey(' · ') +
    c.white(`${routed} routed`) +
    c.grey(' · ') +
    (longRange > 0 ? c.blue(`${longRange} LR`) : c.grey('0 LR')) +
    // These read as a partition of the member nodes, so a node whose route has
    // not resolved yet must be counted rather than silently dropped — the
    // tallies did not sum to the total beside them.
    (pending > 0 ? c.grey(' · ') + c.yellow(`${pending} no route`) : '');

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

/**
 * Rows this screen may spend beyond its compact form.
 *
 * The baseline is measured (26 rows) and MUST include the conditional
 * REBUILD ROUTES block when it is present — it costs 4 rows plus a separator,
 * and ignoring it made the gate over-count free rows during a rebuild.
 */
function surplusRows(H: number, rebuilding: boolean): number {
  const baseline = 26 + (rebuilding ? 5 : 0);
  return Math.max(0, (H - 3) - baseline);
}

/**
 * RECENT RATES — the same serial faults as CONTROLLER FRAMES, per hour.
 *
 * The counters above are LIFETIME: "63 reply timeouts" says nothing about
 * whether the link is failing now or accumulated that over a month of healthy
 * operation. The rates answer exactly that, and the screen already had them —
 * `interference().serial` was read only by the Interference screen.
 *
 * A null rate means the window holds too little history to divide by; it is
 * shown as "—", never as zero.
 */
function serialRateBlock(ctx: ScreenCtx, W: number): string[] {
  const sr = ctx.data.interference().serial;
  const out = [head('RECENT RATES (per hour)', W)];
  if (sr.band === 'unknown' || sr.spanH <= 0) {
    out.push('  ' + c.grey('◷ building — needs a longer window of controller samples'));
    return out;
  }
  const cell = (label: string, v: number | null): string =>
    c.grey(label + ' ') + (v == null ? c.grey('—') : c.white(v < 10 ? v.toFixed(1) : String(Math.round(v))));
  out.push('  ' + [
    cell('NAK', sr.nakPerH), cell('CAN', sr.canPerH),
    cell('tmo-ACK', sr.tmoAckPerH), cell('reply-tmo', sr.tmoRespPerH),
  ].join(c.grey('  ·  ')));
  out.push('  ' + c.grey(`over ${sr.spanH.toFixed(0)}h — lifetime totals above cannot say whether a fault is CURRENT`));
  return out;
}

/**
 * ACTIVE MESH EVENTS — the engine's network-scoped symptoms (nodeId === null),
 * which are exactly the ones a per-node screen can never show. Per-node
 * symptoms are deliberately excluded: they belong on REMEDY, and duplicating
 * them here would put the same finding in two places with two row budgets.
 *
 * Silence is reported as silence — a healthy mesh renders one honest line, not
 * a padded panel.
 */
function meshSymptomBlock(ctx: ScreenCtx, W: number): string[] {
  const mesh = ctx.data.symptoms().filter((s) => s.nodeId == null);
  const out = [head('ACTIVE MESH EVENTS', W)];
  if (mesh.length === 0) {
    out.push('  ' + c.green('✓ ') + c.grey('no mesh-scoped symptoms open'));
    return out;
  }
  for (const sym of mesh.slice(0, 4)) {
    const sev = sym.severity === 'crit' ? c.red : sym.severity === 'warn' ? c.yellow : c.cyan;
    // `basis` is load-bearing: 'inferred' means the engine reasoned to this
    // from correlation, not measurement. Dropping it let a mesh-interference
    // lead read as a confirmed reading — the distinction the Remedy screen
    // makes explicitly, and this panel must not quietly erase.
    const basis = sym.basis === 'measured' ? '' : c.grey(` (${sym.basis})`);
    const room = Math.max(20, W - 26 - visLen(strip(basis)));
    out.push('  ' + sev('● ') + c.white(sym.kind) + basis +
             c.grey('  ' + truncate(sym.narrative.split('.')[0], room)));
  }
  if (mesh.length > 4) out.push('  ' + c.grey(`+${mesh.length - 4} more — [7] REMEDY`));
  return out;
}

const SGR = /\x1b\[[0-9;]*m/g;
const strip = (x: string): string => x.replace(SGR, '');
