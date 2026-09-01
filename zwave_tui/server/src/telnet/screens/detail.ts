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
import { downsampleMean } from './interference';
import { frame, hstack, splitCols, type Keycap, type StackCol } from '../chrome';
import { responseTimeoutPct } from '../../zwave/health';
import { rssiColor, marginColor, rttColor, timeoutPctColor, rssiReading } from '../bands';


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
  // Guard against a pathologically small frame the box couldn't fit into. This
  // runs FIRST: below ~6 rows there is no room for a command bar either.
  if (W < 24 || H < 6) {
    return centeredNotice(view, 'NODE DETAIL', [c.grey(n ? 'terminal too small' : '[no node selected]')]);
  }
  if (!n) {
    // Name the REASON. A filter committed on the Overview can empty the roster,
    // and the bare "[no node selected]" card gave no hint that a filter was why.
    const why = view.filter
      ? `No node matches “${view.filter}”`
      : 'No node selected — pick one on the Overview';
    return centeredNotice(view, 'NODE DETAIL', [c.grey(why)], [['1-9', 'SCREENS'], ['Q', 'BACK']]);
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
    // The HA device_registry id (v0.35). Carried on every snapshot since v0.3
    // and displayed nowhere — while being the exact string you need for a
    // `device_id:` target in an automation or a template, and one that HA's own
    // UI makes awkward to copy. Shown last: identity you occasionally need,
    // not a number you read at a glance. Omitted when the registry join failed
    // rather than printing an empty field.
    if (n.deviceId) body.push(kv('HA id', c.grey(n.deviceId), inner));
  }
  sep();

  // LIVE LINK — reachability + RF quality of the last exchange.
  body.push(section('LIVE LINK'));
  {
    const s = n.stats;
    const glyph = statusGlyph(n.status);
    const seen = s.lastSeen != null ? c.grey(`seen ${fmtAge(Date.now() - s.lastSeen)} ago`) : c.grey('never seen');
    const statusVal = glyph.color(glyph.ch + ' ' + n.statusLabel) + c.grey('  ') + seen;
    // A DEAD/UNKNOWN node's cached RTT is the last reading BEFORE it stopped
    // answering. Overview, Topology and the Heatmap all grey their stale RF
    // cells; this dossier — the one screen you open to diagnose a dead node —
    // was the fourth consumer of that rule and never got it, so it reported
    // `RTT 20 ms` in health green two rows above its own `RSSI —`.
    // Band the DISPLAYED value, not the raw one. The driver reports fractional
    // milliseconds; the Overview rounds before banding, so 99.6 ms printed
    // "100 ms" in two different colours on two screens for one reading.
    const rttShown = s.rtt == null ? null : Math.round(s.rtt);
    const rttVal =
      rttShown == null ? c.grey('—')
        : dead(n) ? c.grey(`${rttShown} ms`)
        : rttColor(rttShown)(`${rttShown} ms`);
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
      // Rounded before display: the live noise floor is fractional, so an
      // unrounded margin renders as "+35.062 dB" and can overflow its cell.
      const m = Math.round(rssi - noise);
      const rc = routed ? c.grey : rssiColor(rssi);
      const mc = routed ? c.grey : marginColor(m);
      rssiVal = rc(`${rssi} dBm`) + (routed ? c.grey(' last-hop') : '');
      marginVal = mc(`${m >= 0 ? '+' : ''}${m} dB`) + (data.hasRealNoise() ? '' : c.grey(' est'));
    }
    body.push(twoCol('RSSI', rssiVal, 'Margin', marginVal, inner));

    // Graphics: SNR-margin quality meter + RSSI/RTT trend sparklines. Skip the
    // live SNR meter for a routed node (its margin is last-hop, not the device's);
    // the historical trends below stay, being clearly past readings.
    if (rssi != null && !routed) pushG(snrRow(Math.round(rssi - noise), data.hasRealNoise(), inner));
    const hist = data.history(n.nodeId);
    const rssiHist = hist.rssi.filter((v) => rssiReading(v) != null);
    const rttHist = hist.rtt.filter((v) => Number.isFinite(v) && v >= 0);
    // Same stale rule as the RTT/RSSI/Timeouts rows around them: a DEAD/UNKNOWN
    // node's history rings end at its last healthy answer (kept on purpose,
    // zwaveData never clears them), and lastColor graded that final sample —
    // so the dossier drew health-green sparklines directly under its own
    // greyed `RSSI —`, while the Overview greyed the identical trend cell for
    // the same node. Grey EXPLICITLY: `undefined` would hand sparkline its
    // relative zoneColor default, not neutrality.
    const trendColor = (vals: number[], band: (v: number) => (s: string) => string) =>
      dead(n) ? c.grey : lastColor(vals, band);
    pushG(trendRow('Signal', rssiHist, 'dBm', trendColor(rssiHist, rssiColor), inner));
    pushG(trendRow('Latency', rttHist, 'ms', trendColor(rttHist, rttColor), inner));
    // Long-horizon coarse RSSI trend (~2h, 1 pt/min); needs a few points first.
    const longRssi = data.historyLong(n.nodeId).rssi.filter((v) => rssiReading(v) != null);
    // NOT a fixed span (v0.41): the coarse ring is 1 point per minute of the
    // node's OWN samples, so 120 points is two hours on a chatty node and five
    // days on the quiet ones this detector exists for. Label what it is — a
    // long-horizon trend — rather than a duration nothing measures.
    if (longRssi.length >= 3) pushG(trendRow('Sig long', longRssi, 'dBm', trendColor(longRssi, rssiColor), inner));

    // Response-timeout % via the SHARED responseTimeoutPct — the same figure the
    // Overview TMO column shows. Numerator is timeoutResponse (ACKed Get whose
    // reply was lost), NOT commandsDroppedTX (RESEARCH.md §0); the raw drop
    // counters live honestly in the TRAFFIC section below.
    const pct = responseTimeoutPct(s);
    const timeouts = Math.min(s.timeoutResponse, s.commandsTX);
    // Same rule, and the SHARED band (this had a fourth private copy of the
    // timeout thresholds — 5/15 — that bands.ts was meant to retire).
    const tmoColor = dead(n) ? c.grey : timeoutPctColor(pct ?? 0);
    let dropVal =
      pct == null
        ? c.grey('— (no TX yet)')
        : tmoColor(`${pct.toFixed(1)}%`) + c.grey(` (${timeouts} of ${s.commandsTX} tx)`);
    if (pct != null) {
      const va = inner - 11;
      const dm = meter(pct / 100, 8, { dir: 'lowGood', color: tmoColor });
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
      // Multi-up on wide frames (v0.27). Entity rows are short, so at 200 cols
      // a one-per-line list wasted most of the width AND pushed everything
      // below it off the visible window — the dossier scrolls, so rows spent
      // here are rows the operator has to page past. Two or three columns cut
      // the section's height by the same factor and reveal more of the node.
      for (const line of columnize(ents, (e, w) => entityRow(e, w), inner)) body.push(line);
    }
  }
  sep();

  // CONFIG PARAMETERS — the device's Z-Wave configuration values (v0.22).
  {
    const cfg = data.configParams(n.nodeId);
    body.push(section('CONFIG PARAMETERS') + configCountTag(cfg));
    // Same treatment: a device with 20+ parameters is otherwise 20+ rows of a
    // scrolling document, each using a fraction of the available width. Only
    // the PARAMETER ROWS are columnised — status/empty notes stay full width so
    // an explanation is never split across a column boundary.
    if (cfg.status === 'ready' && cfg.params.length > 1) {
      // Columnise the PARAMS, re-rendering each at its own column width.
      // Passing pre-rendered full-width rows through columnize was a real
      // defect: configParamRow right-aligns the value at `inner` via lr(), so
      // hstack's left-anchored cut at the narrower column width deleted every
      // VALUE while the labels still rendered — silent, undisclosed loss of the
      // only content the section exists to show, at 80 cols and wider.
      for (const line of columnize(cfg.params, (prm, w) => configParamRow(prm, w), inner)) {
        body.push(line);
      }
    } else {
      // Status/empty notes and the single-param case stay full width, so an
      // explanation is never split across a column boundary.
      for (const row of configRows(cfg, inner)) body.push(row);
    }
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
      pushRoute(body, 'LWR', lwr, inner, dead(n));
    }
    if (!n.isLongRange && n.stats.nlwr) {
      pushRoute(body, 'NLWR', n.stats.nlwr, inner, dead(n));
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

  // EVIDENCE — what the ENGINE can see for this node (v0.35). Everything above
  // is what the node reports; this is whether anyone was listening. The store
  // has tracked it since M2 and no screen has ever read it back.
  {
    const cov = data.evidenceCoverage?.(n.nodeId) ?? null;
    const coarse = data.evidenceCoarse?.(n.nodeId) ?? [];
    if (cov) {
      sep();
      body.push(section('EVIDENCE'));
      const feeds =
        feedTag('status', cov.statusFeedLive) + c.grey(' · ') + feedTag('stats', cov.statsFeedLive);
      const watched = fmtAge(Date.now() - cov.firstSeenAt);
      body.push(twoCol('Feeds', feeds, 'Watched', c.white(watched), inner));
      // Fresh vs total is CUMULATIVE since first sight — a chronic share, not
      // a now-reading (the counters are lifetime, so it cannot move fast). It
      // is labelled "lifetime" for exactly that reason: a node that went stale
      // yesterday still shows last month's green here, and pretending
      // otherwise was the review's finding, not a feature (v0.35).
      const pct = cov.samples > 0 ? Math.round((cov.freshSamples / cov.samples) * 100) : null;
      const freshTone = pct == null ? c.grey : pct >= 80 ? c.green : pct >= 40 ? c.yellow : c.red;
      const samples =
        c.white(String(cov.samples)) +
        c.grey(' · fresh ') + freshTone(pct == null ? '—' : `${cov.freshSamples} (${pct}% lifetime)`);
      const span =
        coarse.length > 0
          // "span", deliberately: first-bucket-to-now, NOT continuous coverage —
          // a gap in observation lives inside this number (v0.35 review).
          ? c.white(fmtAge(Date.now() - coarse[0].t0) + ' span') + c.grey(` · ${coarse.length} bucket(s)`)
          : c.grey('none yet');
      body.push(twoCol('Samples', samples, 'History', span, inner));
      // The LIVENESS SWEEP's verdict on this node (v0.37). Every listening node
      // is asked the same question on the same cadence, so this rate is a fact
      // about the device rather than about how talkative it is — which is
      // exactly what a sample taken only when a node happened to be silent
      // could never be. It also measures something the driver cannot: Dead is
      // set REACTIVELY, only on a failed transmission, so a node nobody
      // addresses reads Alive indefinitely.
      if (cov.probesAsked > 0) {
        const pct = Math.round((cov.probesAnswered / cov.probesAsked) * 100);
        const tone = pct >= 95 ? c.green : pct >= 75 ? c.yellow : c.red;
        // Probes the node had already answered for itself are called out: a
        // device whose own traffic keeps proving it alive is in a different
        // condition from one whose only evidence is the probe, and a bare
        // answered/asked ratio hides that difference entirely.
        const self = cov.probesSelfProven > 0
          ? c.grey(` · ${cov.probesSelfProven} self-proven`)
          : '';
        // These counters are CUMULATIVE across the add-on's whole life and are
        // deliberately never migrated, so on a long-lived install they blend
        // definitions that changed under them (v0.41.2): before v0.40.2 every
        // lane fed the denominator, not just the fixed-cadence sweep, and every
        // restart credited one fabricated "self-proven" per node from the
        // previous process's own probe echoes. An audit found 13 of 35 nodes
        // whose ONLY self-proven credit is one such boot wave. The number is
        // still the best evidence there is — but it is a lifetime tally, not a
        // clean measurement, and the screen must not present it as the latter.
        // Gated on the ratio it QUALIFIES (v0.45.0), not on the self-proven
        // counter. The pre-v0.40.2 blend inflated probesAsked/probesAnswered
        // for exactly the nodes under investigation — an effect independent of
        // whether any self-proven credit ever landed — so a node with a fully
        // blended history and zero self-proven credits was the worst case and
        // the one case that got no caveat at all. Two forms, because the long
        // one clips at the modal 80 columns and a caveat cut mid-claim is a
        // sentence that stops meaning what it says.
        const caveatLong = ' — lifetime tally; pre-v0.40.2 counts blend probe lanes and boot credits';
        const caveatShort = ' — lifetime tally; mixed probe lanes pre-v0.40.2';
        // kv() spends 11 columns on its indent + label cell before the value,
        // and the caveat row is emitted through it — so the budget is
        // `inner - 11`, not `inner`. Getting that wrong is what let the long
        // form be chosen at 80 columns and then clipped by kv itself.
        const KV_GUTTER = 11;
        const caveat = cov.probesAsked > 0
          ? c.grey(inner - KV_GUTTER >= caveatLong.trim().length ? caveatLong : caveatShort)
          : '';
        body.push(kv('Probes', tone(`${cov.probesAnswered}/${cov.probesAsked} answered (${pct}%)`) + self, inner));
        if (caveat) body.push(kv('', c.grey(caveat.trim()), inner));
      }
      // The engine's LEARNED yardstick for this node. Every per-node signal
      // verdict ("below its own normal") is measured against this and it was
      // readable from nowhere, which made those verdicts unfalsifiable on
      // screen: you could see the accusation but never the baseline. An
      // un-graduated band says so rather than quoting a median nobody should
      // act on yet.
      const rn = data.rssiNormal?.(n.nodeId) ?? null;
      if (rn) {
        const band = rn.ready
          ? c.white(`${Math.round(rn.median)} dBm`) + c.grey(` ±${Math.round(rn.scale)} dB`) +
            // The store keeps a separate normal per 4-hour time-of-day band and
            // this row answers for the band you are IN — ask at 3am and at 3pm
            // and the yardstick legitimately differs. Unlabelled, that reads as
            // the baseline contradicting itself (v0.35 review).
            c.grey(` · ${rn.days}d · this time-of-day band`)
          : c.yellow('still learning') + c.grey(` · ${rn.days}d so far — not yet a yardstick`);
        body.push(kv('Normal', band, inner));
      }
      // A node the engine cannot see must SAY so here, because every quiet
      // verdict elsewhere on this screen silently depends on it.
      if (!cov.statusFeedLive && !cov.statsFeedLive) {
        body.push(note('Both feeds are down — silence from this node is a MONITORING HOLE, not health', inner, c.red));
      } else if (cov.samples === 0) {
        body.push(note('No samples yet — the engine has nothing to judge this node on', inner, c.yellow));
      }
    }
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
  windowRows.push(flagLegend(health.flags, W, health.state));

  const st = statusColor(n.status)(n.statusLabel.toUpperCase());
  const sc = dead(n) ? c.grey('—') : scoreColor(health.score)(`${health.score} (${health.grade})`);
  // Scroll position rides in the title-rule status token when the dossier
  // overflows — arrows show which directions have more content.
  const scrollInfo =
    total > contentRows
      ? c.grey(' · ') +
        c.cyan(`${scroll > 0 ? '▲' : ' '}${scroll < maxScroll ? '▼' : ' '} ${scroll + 1}–${Math.min(total, scroll + contentRows)}/${total}`)
      : '';
  const keys: Keycap[] = [
    ['↑↓', 'SCROLL'],
    ['< >', 'NODE', 2],
    ['A', 'ACTIONS', 1],
    ['1-9', 'SCREENS'],
    ['Q', 'BACK'],
  ];
  return frame(view, data, {
    title: `NODE #${n.nodeId} · ${n.name}`,
    rightStatus: st + c.grey(' · ') + c.grey('SCORE ') + sc + scrollInfo,
    body: windowRows,
    keys,
  });
}

/** A live/down badge for one evidence feed (v0.35). */
function feedTag(name: string, live: boolean): string {
  return live ? c.green('\u25cf ' + name) : c.red('\u25cb ' + name);
}

/** Per-node flag legend, pinned at the bottom of the Detail body. */
function flagLegend(flags: string[], W: number, state?: string): string {
  if (!flags.length) {
    // A node the controller has never contacted raises NO flags — it has no
    // measurements to raise them from — so "nominal" asserted health from an
    // absence, directly under a title rule reading UNKNOWN · SCORE —.
    if (state === 'unknown') return c.grey(' no measurements yet — nothing to assess');
    if (state === 'dead') return c.grey(' unreachable — the readings above are its last, not current');
    return c.grey(' RF health nominal');
  }
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
  // Downsample so the drawing spans the WHOLE series. sparkline() tail-slices
  // to `width`, so the 120-sample coarse ring behind this ≤56-cell row drew
  // only its newest ~56 minutes while the (then 'Sig 2h') label and the min…max
  // caption (computed over the full series, above) both claimed two hours —
  // an hour-long RF sag was invisible in the very graphic captioned with it.
  // interference.ts documents this exact trap and built downsampleMean for it.
  const val = sparkline(downsampleMean(values, sparkW), sparkW, { color }) + (ann ? ' ' + c.grey(ann) : '');
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
 * Push one route as a single row: the repeater chain, then a route-failed
 * marker / data rate / route RSSI. The failed marker leads the tail and is
 * never shed while any tail token renders.
 *
 * Overflow drops WHOLE tokens with a dim `+N` disclosure (the commandBar /
 * fieldStrip idiom) — never a character clip. Dropping the signal bars used to
 * be the ONLY step before kv()'s blind truncate, which at the documented
 * 80-col default rendered a 4-repeater LWR's 100k rate as a bare '1' and a
 * route RSSI of -70 dBm as '-70 d' (or '-7') — clipped numbers that read as
 * plausible, wrong values on exactly the rows an operator studies for the
 * weakest multi-hop nodes.
 */
function pushRoute(body: string[], label: string, route: RouteStat, inner: number, stale = false): void {
  // The failed-route alert is not droppable; rate/RSSI are advisory and shed
  // from the right when the columns run out.
  const alert = route.routeFailedBetween
    ? c.red(`⚠ failed n${route.routeFailedBetween[0]}↮n${route.routeFailedBetween[1]}`)
    : null;
  const bits: string[] = [];
  const rate = route.protocolDataRate;
  if (rate != null) {
    const rl = DATA_RATE_LABEL[rate] ?? '?';
    bits.push((stale ? c.grey : rate >= 3 ? c.green : rate === 2 ? c.yellow : c.red)(rl));
  }
  const rssi = validRssi(route.rssi);
  if (rssi != null) bits.push((stale ? c.grey : rssiColor(rssi))(`${rssi} dBm`));

  const budget = inner - 11; // kv() spends 11 columns on indent + label cell
  const tailOf = (keep: number): string => {
    const tokens = [...(alert ? [alert] : []), ...bits.slice(0, keep)];
    const tail = tokens.length ? c.grey('  ·  ') + tokens.join(c.grey(' · ')) : '';
    // Disclose what fell off: a route row silently missing its rate/RSSI reads
    // as "this route HAS no rate/RSSI", which is a different claim.
    const dropped = bits.length - keep;
    return tail + (dropped > 0 ? c.grey(` +${dropped}`) : '');
  };
  // Chain forms, richest first: hop bars + RSSI → hop RSSI only → bare hop ids
  // → interior hops collapsed to a count (the Overview's `n3→+N` idiom). Every
  // form now carries `stale` — the old no-bars retry dropped it, so a dead
  // node's per-hop readings sprang back to health-green the moment the row got
  // narrow enough to shed its bars.
  const chains = [
    routeChain(route, true, stale),
    routeChain(route, false, stale),
    routeChain(route, false, stale, false),
    routeChainCollapsed(route),
  ];
  // Pass 1 — shed chain decoration, keep every tail token: rate and route RSSI
  // are measurements; the bars and per-hop annotations are redundant renderings
  // of readings the chain itself still names.
  for (const chain of chains) {
    const line = chain + tailOf(bits.length);
    if (visLen(line) <= budget) {
      body.push(kv(label, line, inner));
      return;
    }
  }
  // Pass 2 — barest chains, shedding tail tokens right-to-left with the `+N`.
  for (const chain of [chains[2], chains[3]]) {
    for (let keep = bits.length - 1; keep >= 0; keep--) {
      const line = chain + tailOf(keep);
      if (visLen(line) <= budget) {
        body.push(kv(label, line, inner));
        return;
      }
    }
  }
  // Nothing fits whole — a pathologically narrow frame. Keep the alert in a
  // short whole-word form ('⚠ failed n12' names half the failed pair, which is
  // worse than naming neither; a bare '⚠' explains nothing), disclose the rest
  // as a count, and let kv()'s truncate stand as the width backstop — the only
  // text it can still clip is chain scaffolding, not a measurement.
  const alertShort = alert ? c.grey('  ·  ') + c.red('⚠ failed') : '';
  const mark = bits.length ? c.grey(` +${bits.length}`) : '';
  body.push(kv(label, routeChainCollapsed(route) + alertShort + mark, inner));
}

/**
 * Build "controller ← n3 ← n8 ← node", each repeater annotated with its
 * repeaterRSSI[] hop reading and (when `bars`) a WiFi-style signal-strength
 * glyph derived from that reading. Empty repeaters ⇒ a direct link.
 */
function routeChain(route: RouteStat, bars: boolean, stale = false, hopAnn = true): string {
  const reps = Array.isArray(route.repeaters) ? route.repeaters : [];
  const arrow = c.grey(' ← ');
  const parts: string[] = [c.grey('controller')];
  reps.forEach((r, i) => {
    const hop = route.repeaterRSSI?.[i];
    const valid = rssiReading(hop) != null;
    // Same stale rule as the rate + route RSSI in the row above: pushRoute
    // threaded `stale` in but never passed it here, so a dead node's PER-HOP
    // readings stayed health-green inside a row already greyed around them.
    const hopColor = stale ? c.grey : rssiColor(hop!);
    const ann = hopAnn && valid ? c.grey('(') + hopColor(`${hop}`) + c.grey(')') : '';
    // Coloured by the SAME band function as the dBm printed immediately before
    // it — signalBars' default zoneColor is a coarser, unrelated ramp, so the
    // glyph and the number beside it could disagree about the same hop.
    const sig = bars && valid ? signalBars(rssiStrength(hop!), 3, hopColor) : '';
    parts.push(c.white('n' + r) + ann + sig);
  });
  parts.push(c.whiteB('node'));
  const chain = parts.join(arrow);
  return reps.length === 0 ? chain + c.grey('  · direct') : chain;
}

/**
 * Barest chain form: the first repeater named, the remaining interior hops
 * collapsed to a dim `+N` (the Overview's idiom). When columns are scarce the
 * load-bearing facts are "routed, via n3, N hops deep" — per-hop readings are
 * already gone by the time pushRoute reaches for this form, and a chain that
 * silently dropped WHICH repeater leads the path would send an operator to the
 * wrong device.
 */
function routeChainCollapsed(route: RouteStat): string {
  const reps = Array.isArray(route.repeaters) ? route.repeaters : [];
  const arrow = c.grey(' ← ');
  if (reps.length === 0) return c.grey('controller') + arrow + c.whiteB('node') + c.grey('  · direct');
  const parts = [c.grey('controller'), c.white('n' + reps[0])];
  if (reps.length > 1) parts.push(c.grey(`+${reps.length - 1}`));
  parts.push(c.whiteB('node'));
  return parts.join(arrow);
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
  return rssiReading(v);
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

/**
 * Lay a list of short rows into as many columns as the width honestly supports.
 *
 * Returns single-column output unchanged below the two-column threshold, so
 * narrow terminals are untouched. Reading order is COLUMN-MAJOR (fill the first
 * column top-to-bottom, then the next), which keeps the existing sort order
 * scannable down the left edge instead of zig-zagging across it.
 *
 * `render(item, w)` draws one item at the per-column width — passing the width
 * through matters, because the row builders truncate to it, and a row built for
 * the full frame would be cut mid-value by hstack instead of by its own
 * truncation rules.
 */
function columnize<T>(items: readonly T[], render: (item: T, w: number) => string, inner: number): string[] {
  const GAP = 3;
  // 56, not 34. At 34 the split fired from 73 columns up, so the DEFAULT 80-col
  // terminal got two ~37-column panes and entity/parameter names collapsed to
  // near-indistinguishable stubs — density bought with information, and a
  // regression at the one size every operator sees. 56 keeps 80 and 120 cols
  // single-column (where the full-width row is already the better read) and
  // splits only from ~115 up, where a pane still holds a real name and value.
  const MIN_COL = 56;
  const n = Math.max(1, Math.min(3, Math.floor((inner + GAP) / (MIN_COL + GAP))));
  if (n === 1 || items.length < 2) return items.map((it) => render(it, inner));

  const widths = splitCols(inner, Math.min(n, items.length), GAP, MIN_COL);
  if (widths.length === 0) return items.map((it) => render(it, inner));

  // Never open more columns than there are items to fill them — a trailing
  // blank column is just padding wearing a layout's clothes.
  const nCols = Math.min(n, items.length);
  const per = Math.ceil(items.length / nCols);
  const cols: StackCol[] = widths.slice(0, nCols).map((w, i) => ({
    w,
    lines: items.slice(i * per, (i + 1) * per).map((it) => render(it, w)),
  }));
  return hstack(cols, GAP);
}
