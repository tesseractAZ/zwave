/**
 * NODE DETAIL — the per-node dossier (v0.22, scrollable full-screen).
 *
 * A full-frame card for the node the operator has selected on the Overview.
 * Stacked sections, top to bottom:
 *
 *   header        [8] Kitchen Lamp — alive — 100 (A)          W F
 *   IDENTITY      manufacturer/model · security · radio caps · power · area
 *   LIVE LINK     status glyph + lastSeen · RTT · RSSI + SNR margin · timeout %
 *   LIVE ENTITIES every HA entity on the node + its CURRENT state (v0.22)
 *   CONFIG PARAMS the device's Z-Wave configuration parameters (v0.22)
 *   ROUTES        LWR (and NLWR) repeater chains, per-hop RSSI, data rate, fails
 *   TRAFFIC       commands TX/RX, dropped TX/RX, response timeouts
 *
 * The dossier is taller than a terminal, so it SCROLLS: `view.detailScroll` is
 * the first visible body row. The renderer clamps it to the real range and
 * writes the clamped value back (same sticky-window pattern the Log screen
 * uses). `↑↓`/`j`/`k` scroll; `<`/`>` step to the adjacent node (top of its
 * dossier). The flag legend is pinned at the very bottom, outside the scroll.
 *
 * Everything is coloured by the same health discipline the Overview uses:
 * green healthy, yellow weak, red failing, cyan asleep/info, grey no-data/mains.
 * The renderer is pure aside from the documented scroll write-back; it reads the
 * cached DataProvider values and returns exactly view.rows lines ≤ view.cols.
 */

import { c, lr, padEnd, truncate, visLen } from '../ansi';
import { gauge, meter, signalBars, sparkline } from '../gauges';
import {
  NodeStatus,
  type ConfigParam,
  type ConfigParamsResult,
  type EntityLiveState,
  type FirmwareInfo,
  type NodeSnapshot,
  type RouteStat,
  type ScreenCtx,
} from '../../types';
import { centeredNotice } from './overview';
import { frame } from '../chrome';
import { responseTimeoutPct } from '../../zwave/health';

/** Driver RSSI sentinels (not-available / saturated / no-signal) — never real dBm. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

/** protocolDataRate → human label (shared vocabulary with the Overview). */
const DATA_RATE_LABEL: Record<number, string> = { 1: '9.6k', 2: '40k', 3: '100k', 4: 'LR' };

/** One-line meaning for each health flag, shown in the footer for this node. */
const FLAG_MEANING: Record<string, string> = {
  D: 'dead',
  S: 'stale',
  W: 'weak signal',
  F: 'response timeouts',
  R: 'route failed',
  L: 'high latency',
  I: 'interview incomplete',
  B: 'battery low',
  U: 'firmware update',
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
  const inner = W - 2; // interior width (2 = the left/right gutter)

  // Kick the lazy per-node config-parameter fetch (idempotent + throttled in the
  // data layer). The result surfaces on a later frame via data.configParams().
  data.requestConfigParams(n.nodeId);

  /* ── build the full (unwindowed) interior content rows ───────────────────── */
  const body: string[] = [];
  const sep = () => body.push(SEP); // marker → a full-width rule when rendered
  const pushG = (s: string | null): void => {
    if (s != null) body.push(s); // graphic augment; null ⇒ didn't fit its columns
  };

  // Flagship graphic — a wide health gauge. The node's identity, status, and
  // score live in the title rule (chrome), so they aren't repeated here.
  if (!dead(n)) pushG(healthGauge(health.score, health.grade, inner));
  sep();

  // IDENTITY — device, security, radio capabilities, power, location.
  body.push(section('IDENTITY'));
  {
    const dev = [n.manufacturer, n.model].filter(Boolean).join(' ').trim();
    body.push(kv('Device', dev || c.grey('unknown device'), inner));
    const fwRow = firmwareRow(n.firmware, inner);
    if (fwRow) body.push(fwRow);

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
    // Battery gauge for battery-powered nodes (level% also shown in Power text).
    if (n.battery != null) {
      pushG(batteryGauge(n.battery.level, n.battery.isLow, inner));
    }

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

    // RSSI + SNR margin (rssi − noiseFloor). Sentinels read as no-signal. A
    // DEAD/UNKNOWN node's cached RSSI is stale (it hasn't answered) → '—', so the
    // dossier never shows a strong signal beside an unreachable status. A ROUTED
    // node's `stats.rssi` is the LAST-HOP (repeater→controller) ACK reading, not
    // the device's own signal, so it is shown NEUTRAL grey rather than health-
    // coloured — mirroring the score's refusal to grade it (health.ts).
    const rssi = dead(n) ? null : validRssi(s.rssi);
    const routed = !n.isLongRange && (s.lwr?.repeaters?.length ?? 0) > 0;
    let rssiVal: string;
    let marginVal: string;
    if (rssi == null) {
      rssiVal = c.grey('—');
      marginVal = c.grey('—');
    } else {
      const m = rssi - noise;
      const rc = routed ? c.grey : rssiColor(rssi);
      const mc = routed ? c.grey : marginColor(m);
      rssiVal = rc(`${rssi} dBm`) + (routed ? c.grey(' last-hop') : '');
      marginVal = mc(`${m >= 0 ? '+' : ''}${m} dB`) + (data.hasRealNoise() ? '' : c.grey(' est'));
    }
    body.push(twoCol('RSSI', rssiVal, 'Margin', marginVal, inner));

    // Graphics: SNR-margin quality meter + RSSI/RTT trend sparklines. Skip the
    // live SNR meter for a routed node (its margin is last-hop, not the device's);
    // the historical trends below stay, being clearly past readings.
    if (rssi != null && !routed) pushG(snrRow(rssi - noise, data.hasRealNoise(), inner));
    const hist = data.history(n.nodeId);
    const rssiHist = hist.rssi.filter((v) => Number.isFinite(v) && !RSSI_SENTINELS.has(v));
    const rttHist = hist.rtt.filter((v) => Number.isFinite(v) && v >= 0);
    pushG(trendRow('Signal', rssiHist, 'dBm', lastColor(rssiHist, rssiColor), inner));
    pushG(trendRow('Latency', rttHist, 'ms', lastColor(rttHist, rttColor), inner));
    // Long-horizon coarse RSSI trend (~2h, 1 pt/min); needs a few points first.
    const longRssi = data.historyLong(n.nodeId).rssi.filter((v) => Number.isFinite(v) && !RSSI_SENTINELS.has(v));
    if (longRssi.length >= 3) pushG(trendRow('Sig 2h', longRssi, 'dBm', lastColor(longRssi, rssiColor), inner));

    // Response-timeout % via the SHARED responseTimeoutPct — the same figure the
    // Overview TMO column shows. Numerator is timeoutResponse (ACKed Get whose
    // reply was lost), NOT commandsDroppedTX (RESEARCH.md §0); the raw drop
    // counters live honestly in the TRAFFIC section below.
    const pct = responseTimeoutPct(s);
    const timeouts = Math.min(s.timeoutResponse, s.commandsTX);
    let dropVal =
      pct == null
        ? c.grey('— (no TX yet)')
        : dropColor(pct)(`${pct.toFixed(1)}%`) +
          c.grey(` (${timeouts} of ${s.commandsTX} tx)`);
    if (pct != null) {
      const va = inner - 11;
      const dm = meter(pct / 100, 8, { dir: 'lowGood', color: dropColor(pct) });
      if (va - visLen(dropVal) >= 10) dropVal = lr(dropVal, dm, va);
    }
    body.push(kv('Timeouts', dropVal, inner));
  }
  sep();

  // LIVE ENTITIES — every HA entity on this node + its CURRENT state (v0.22).
  {
    const ents = [...data.entityStates(n.nodeId)].sort(
      (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name),
    );
    body.push(section('LIVE ENTITIES') + c.grey(`  ${ents.length}`));
    if (ents.length === 0) {
      body.push(note('no entities on this node', inner));
    } else {
      for (const e of ents) body.push(entityRow(e, inner));
    }
  }
  sep();

  // CONFIG PARAMETERS — the device's Z-Wave configuration values (v0.22).
  {
    const cfg = data.configParams(n.nodeId);
    body.push(section('CONFIG PARAMETERS') + configCountTag(cfg));
    for (const row of configRows(cfg, inner)) body.push(row);
  }
  sep();

  // ROUTES — the last working route (and next-to-last, if present).
  body.push(section('ROUTES'));
  {
    const lwr = n.stats.lwr;
    if (n.isLongRange) {
      body.push(kv('LWR', c.blue('direct to controller (Long-Range star)'), inner));
    } else if (!lwr) {
      body.push(kv('LWR', c.grey('no route data yet'), inner));
    } else {
      pushRoute(body, 'LWR', lwr, inner);
    }
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

  /* ── window the body into the scrollable content area ────────────────────── */
  // frame() reserves masthead + rule + command bar (3 rows). We reserve one more
  // for the flag legend pinned at the bottom, and scroll everything else.
  const bodyCap = Math.max(1, H - 3);
  const contentRows = Math.max(1, bodyCap - 1);
  const rows = body.map((r) => (r === SEP ? c.grey('─'.repeat(W)) : r));
  const total = rows.length;
  const maxScroll = Math.max(0, total - contentRows);
  let scroll = view.detailScroll ?? 0;
  if (!Number.isFinite(scroll) || scroll < 0) scroll = 0;
  if (scroll > maxScroll) scroll = maxScroll;
  view.detailScroll = scroll; // write back the clamped offset (sticky-window pattern)

  const windowRows = rows.slice(scroll, scroll + contentRows);
  while (windowRows.length < contentRows) windowRows.push('');
  windowRows.push(flagLegend(health.flags, W));

  const st = statusColor(n.status)(n.statusLabel.toUpperCase());
  const sc = dead(n) ? c.grey('—') : scoreColor(health.score)(`${health.score} (${health.grade})`);
  // Scroll position rides in the title-rule status token when the dossier
  // overflows — arrows show which directions have more content.
  const scrollInfo =
    total > contentRows
      ? c.grey(' · ') +
        c.cyan(`${scroll > 0 ? '▲' : ' '}${scroll < maxScroll ? '▼' : ' '} ${scroll + 1}–${Math.min(total, scroll + contentRows)}/${total}`)
      : '';
  const keys: Array<readonly [string, string]> = [
    ['↑↓', 'SCROLL'],
    ['< >', 'NODE'],
    ['A', 'ACTIONS'],
    ['1-8', 'SCREENS'],
    ['Q', 'BACK'],
  ];
  return frame(view, data, {
    title: `NODE #${n.nodeId} · ${n.name}`,
    rightStatus: st + c.grey(' · ') + c.grey('SCORE ') + sc + scrollInfo,
    body: windowRows,
    keys,
  });
}

/** Per-node flag legend, pinned at the bottom of the Detail body. */
function flagLegend(flags: string[], W: number): string {
  if (!flags.length) return c.grey(' RF health nominal');
  const meanings = flags.map((f) => flagColor([f])(f) + c.grey(' ' + (FLAG_MEANING[f] ?? '?'))).join(c.grey(' · '));
  return truncate(' ' + c.grey('FLAGS: ') + meanings, W);
}

/* ── LIVE ENTITIES (v0.22) ───────────────────────────────────────────────── */

/** Short, fixed-width domain tag; long HA domains are abbreviated so the entity
 *  name column stays aligned. */
const DOMAIN_ABBREV: Record<string, string> = {
  binary_sensor: 'binary',
  input_boolean: 'switch',
  input_number: 'number',
  input_select: 'select',
  device_tracker: 'tracker',
  media_player: 'media',
};

function domainTag(domain: string): string {
  return DOMAIN_ABBREV[domain] ?? domain;
}

/**
 * One entity as a two-column row: `  <domain> <name>            <live state>`.
 * The live-state value is protected — the name is truncated first so the state
 * (the thing the operator is checking) always survives a narrow terminal.
 */
function entityRow(e: EntityLiveState, inner: number): string {
  const value = formatEntityState(e);
  const left = '  ' + c.grey(padEnd(domainTag(e.domain), 7)) + ' ' + c.white(e.name);
  const leftBudget = Math.max(1, inner - visLen(value) - 1);
  return lr(truncate(left, leftBudget), value, inner);
}

/**
 * Format an entity's CURRENT state for display, per HA domain: on/off, dimmer
 * %, sensor value+unit, climate mode/setpoint, cover position, lock state, …
 * Pure + exported so the per-domain vocabulary is unit-testable without a mesh.
 */
export function formatEntityState(e: EntityLiveState): string {
  const s = e.state;
  if (s == null) return c.grey('—');
  if (s === 'unavailable') return c.grey('unavailable');
  if (s === 'unknown') return c.grey('unknown');
  const a = e.attrs;
  switch (e.domain) {
    case 'light': {
      if (s !== 'on') return c.grey(s);
      const br = numAttr(a.brightness);
      const pct = br != null ? c.grey(` · ${Math.round((br / 255) * 100)}%`) : '';
      return c.green('on') + pct;
    }
    case 'switch':
    case 'input_boolean':
    case 'automation':
      return s === 'on' ? c.green('on') : c.grey('off');
    case 'fan': {
      if (s !== 'on') return c.grey(s);
      const p = numAttr(a.percentage);
      return c.green('on') + (p != null ? c.grey(` · ${Math.round(p)}%`) : '');
    }
    case 'lock':
      return s === 'locked' ? c.green('locked') : c.yellow(s); // unlocked / jammed
    case 'cover': {
      const pos = numAttr(a.current_position);
      const posTxt = pos != null ? c.grey(` · ${Math.round(pos)}%`) : '';
      const col = s === 'closed' ? c.green : s === 'open' ? c.yellow : c.cyan;
      return col(s) + posTxt;
    }
    case 'binary_sensor':
      return formatBinary(s, strAttr(a.device_class));
    case 'sensor': {
      const unit = strAttr(a.unit_of_measurement);
      if (isNumericStr(s)) return c.white(s) + (unit ? c.grey(' ' + unit) : '');
      return c.white(s); // enum / text sensor
    }
    case 'climate': {
      if (s === 'off') return c.grey('off');
      const cur = numAttr(a.current_temperature);
      const set = numAttr(a.temperature);
      const bits: string[] = [];
      if (set != null) bits.push(`set ${set}°`);
      if (cur != null) bits.push(`now ${cur}°`);
      return c.cyan(s) + (bits.length ? c.grey(' · ' + bits.join(' · ')) : '');
    }
    case 'update':
      return s === 'on' ? c.blue('update available') : c.grey('up to date');
    case 'button':
    case 'event': {
      const age = ageOfTimestamp(s);
      return age ? c.grey('last ' + age + ' ago') : c.grey(s);
    }
    default:
      return c.white(s);
  }
}

/** binary_sensor state → a device-class-aware phrase (motion, door, leak, …). */
function formatBinary(state: string, deviceClass: string | undefined): string {
  const on = state === 'on';
  switch (deviceClass) {
    case 'motion':
    case 'occupancy':
    case 'presence':
      return on ? c.yellow('detected') : c.grey('clear');
    case 'door':
    case 'window':
    case 'garage_door':
    case 'opening':
      return on ? c.yellow('open') : c.green('closed');
    case 'connectivity':
      return on ? c.green('connected') : c.red('disconnected');
    case 'moisture':
      return on ? c.red('wet') : c.green('dry');
    case 'smoke':
    case 'gas':
    case 'carbon_monoxide':
      return on ? c.redB('DETECTED') : c.green('clear');
    case 'problem':
    case 'safety':
      return on ? c.red('problem') : c.green('ok');
    case 'tamper':
      return on ? c.red('tamper') : c.grey('ok');
    case 'battery':
      return on ? c.red('low') : c.green('ok');
    case 'lock':
      return on ? c.yellow('unlocked') : c.green('locked');
    default:
      return on ? c.yellow('on') : c.grey('off');
  }
}

/* ── CONFIG PARAMETERS (v0.22) ───────────────────────────────────────────── */

/** A small count/status tag appended to the CONFIG PARAMETERS section header. */
function configCountTag(cfg: ConfigParamsResult): string {
  switch (cfg.status) {
    case 'ready':
      return c.grey(`  ${cfg.params.length}`);
    case 'loading':
    case 'idle':
      return c.grey('  …');
    case 'error':
      return c.yellow('  !');
    default:
      return '';
  }
}

/** The CONFIG PARAMETERS body rows for the node — a status line, or one row per
 *  parameter once the (lazy) fetch has resolved. */
function configRows(cfg: ConfigParamsResult, inner: number): string[] {
  if (cfg.status === 'idle' || cfg.status === 'loading') {
    return [note('loading configuration…', inner)];
  }
  if (cfg.status === 'error') {
    return [note('configuration unavailable' + (cfg.error ? `: ${cfg.error}` : ''), inner, c.yellow)];
  }
  if (cfg.params.length === 0) {
    return [note('no configurable parameters', inner)];
  }
  return cfg.params.map((p) => configParamRow(p, inner));
}

/**
 * One config parameter as a two-column row: `  <label>   <value unit · meaning>`.
 * The value (with its enum meaning) is protected; the label truncates first.
 * Non-writeable parameters carry a dim `(ro)` marker.
 */
function configParamRow(p: ConfigParam, inner: number): string {
  const valTxt =
    p.value == null
      ? c.grey('—')
      : c.whiteB(String(p.value)) + (p.unit ? c.grey(' ' + p.unit) : '');
  const enumTxt = p.valueLabel ? c.grey(' · ') + c.cyan(p.valueLabel) : '';
  const value = valTxt + enumTxt;
  const ro = p.writeable ? '' : c.grey(' (ro)');
  const left = '  ' + c.white(p.label) + ro;
  const leftBudget = Math.max(1, inner - visLen(value) - 1);
  return lr(truncate(left, leftBudget), value, inner);
}

/** An indented, dim note line (empty-state / status inside a section). */
function note(text: string, inner: number, color: (s: string) => string = c.grey): string {
  return truncate('    ' + color(text), inner);
}

/* ── graphic builders (each returns an inner-width string, or null if it can't
      fit its columns and should be skipped) ───────────────────────────────── */

/** Wide health gauge echoing the header score/grade, coloured by score. */
function healthGauge(score: number, grade: string, inner: number): string | null {
  const plain = `${score} ${grade}`;
  const barW = Math.min(16, inner - 1 - 3 - plain.length); // 1 indent + '[' ']' + ' '
  if (barW < 6) return null;
  return ' ' + gauge(score / 100, barW, scoreColor(score)(plain), { color: scoreColor(score) });
}

/** Battery charge gauge (level% also shown in the Power text row). */
function batteryGauge(level: number, isLow: boolean, inner: number): string | null {
  const plain = `${level}%`;
  const barW = Math.min(16, inner - 11 - 3 - plain.length); // kv indent(11) + '[' ']' + ' '
  if (barW < 6) return null;
  const col = level <= 25 || isLow ? c.red : level <= 50 ? c.yellow : c.green;
  return kv('Battery', gauge(level / 100, barW, col(plain), { color: col }), inner);
}

/** SNR-margin zone meter — margin (dBm above noise) mapped onto a 0..25 dB scale. */
function snrRow(margin: number, realNoise: boolean, inner: number): string | null {
  const label = `${margin >= 0 ? '+' : ''}${margin} dB` + (realNoise ? '' : ' est');
  const barW = Math.min(16, inner - 11 - 1 - label.length);
  if (barW < 6) return null;
  const bar = meter(margin / 25, barW, { color: marginColor(margin) });
  return kv('SNR', bar + ' ' + c.grey(label), inner);
}

/**
 * Trend sparkline row: auto-scaled sparkline + a "min…max unit" range caption.
 * Drops the caption, then the whole row, as the columns shrink. Colour tracks
 * the latest sample's health (so a rising RTT never reads falsely green).
 */
function trendRow(
  label: string,
  values: number[],
  unit: string,
  color: ((s: string) => string) | undefined,
  inner: number,
): string | null {
  const va = inner - 11; // value columns after the kv label cell
  if (va < 10) return null;
  let ann = '';
  if (values.length) {
    const mn = Math.round(Math.min(...values));
    const mx = Math.round(Math.max(...values));
    ann = mn === mx ? `${mn} ${unit}` : `${mn}…${mx} ${unit}`;
  }
  let sparkW = Math.min(56, va - (ann ? ann.length + 1 : 0));
  if (sparkW < 8) {
    ann = '';
    sparkW = Math.min(56, va);
  }
  if (sparkW < 8) return null;
  const val = sparkline(values, sparkW, { color }) + (ann ? ' ' + c.grey(ann) : '');
  return kv(label, val, inner);
}

/** Colour a graphic by the newest sample's health band (undefined if no data). */
function lastColor(
  values: number[],
  band: (v: number) => (s: string) => string,
): ((s: string) => string) | undefined {
  return values.length ? band(values[values.length - 1]) : undefined;
}

/** Map a hop RSSI (dBm) to a 0..1 signal strength for the route signal bars. */
function rssiStrength(dbm: number): number {
  return Math.max(0, Math.min(1, (dbm + 100) / 60)); // -100 dBm → 0, -40 dBm → 1
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
  let chain = routeChain(route, true);
  if (visLen(chain) + visLen(tail) > inner - 11) chain = routeChain(route, false);
  body.push(kv(label, chain + tail, inner));
}

/**
 * Build "controller ← n3 ← n8 ← node", each repeater annotated with its
 * repeaterRSSI[] hop reading and (when `bars`) a WiFi-style signal-strength
 * glyph derived from that reading. Empty repeaters ⇒ a direct link.
 */
function routeChain(route: RouteStat, bars: boolean): string {
  const reps = Array.isArray(route.repeaters) ? route.repeaters : [];
  const arrow = c.grey(' ← ');
  const parts: string[] = [c.grey('controller')];
  reps.forEach((r, i) => {
    const hop = route.repeaterRSSI?.[i];
    const valid = hop != null && Number.isFinite(hop) && !RSSI_SENTINELS.has(hop);
    const ann = valid ? c.grey('(') + rssiColor(hop!)(`${hop}`) + c.grey(')') : '';
    const sig = bars && valid ? signalBars(rssiStrength(hop!), 3) : '';
    parts.push(c.white('n' + r) + ann + sig);
  });
  parts.push(c.whiteB('node'));
  const chain = parts.join(arrow);
  return reps.length === 0 ? chain + c.grey('  · direct') : chain;
}

/* ── section / row builders (return the INNER content string) ────────────── */

const SEP = '\x00SEP'; // sentinel: this body entry is a full-width rule, not content

function section(title: string): string {
  return ' ' + c.cyanB(title);
}

/** Label + value row, label column fixed at 8 cols, indented 2. */
function kv(k: string, v: string, inner: number): string {
  const labelCell = k ? c.label(k.padEnd(8)) : ' '.repeat(8);
  const left = '  ' + labelCell + ' ';
  return truncate(left + v, inner);
}

/** Two label/value pairs on one row: left pair, right pair. */
function twoCol(k1: string, v1: string, k2: string, v2: string, inner: number): string {
  const left = c.label(k1.padEnd(8)) + ' ' + v1;
  const right = c.label(k2.padEnd(7)) + ' ' + v2;
  return truncate('  ' + lr(left, right, inner - 2), inner);
}

/** Firmware row: version + update/in-progress advisory (null → row omitted). */
function firmwareRow(fw: FirmwareInfo | null, inner: number): string | null {
  if (!fw) return null;
  const cur = fw.current ?? '?';
  if (fw.inProgress) {
    const pct = fw.progressPct != null ? ` ${Math.round(fw.progressPct)}%` : '';
    return kv('Firmware', c.blue(`updating${pct}…`) + c.grey(` (installed ${cur})`), inner);
  }
  if (fw.updateAvailable) {
    return kv('Firmware', c.white(cur) + c.blue(` → ${fw.latest ?? '?'} ⬆ update`), inner);
  }
  const tgt = fw.targets > 1 ? c.grey(` · ${fw.targets} targets`) : '';
  return kv('Firmware', c.white(cur) + c.grey(' · up to date') + tgt, inner);
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
  if (has('U')) return c.blue; // firmware update available — advisory, not a fault
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

/** A finite numeric attribute value, or null (attrs are `unknown`-typed). */
function numAttr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A string attribute value, or undefined. */
function strAttr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Does a state string read as a finite number (a numeric sensor reading)? */
function isNumericStr(s: string): boolean {
  return s.trim() !== '' && Number.isFinite(Number(s));
}

/** Relative age of an ISO-timestamp state (button/event last-fired), or null. */
function ageOfTimestamp(s: string): string | null {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return fmtAge(Date.now() - t);
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
