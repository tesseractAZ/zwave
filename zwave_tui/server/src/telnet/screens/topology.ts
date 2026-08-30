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

import { BOX, c, lr, truncate, visLen } from '../ansi';
import { fmtElapsed, meter, signalBars } from '../gauges';
import {
  NodeStatus,
  type NodeSnapshot,
  type RouteStat,
  type ScreenCtx,
  type ViewState,
} from '../../types';
import { centeredNotice } from './overview';
import { frame } from '../chrome';
import { rssiColor, marginColor, rssiReading, WEAK_MARGIN_DB } from '../bands';

/** A colour wrapper (matches the ansi `c.*` span helpers / gauges ColorFn). */
type ColorFn = (s: string) => string;


/**
 * Width at which the row can afford per-hop readings and the reroute tokens.
 * Below it the screen renders exactly as it did before they existed — the same
 * surplus-funding rule the Overview roll-up and Controller blocks follow.
 */
const WIDE_COLS = 100;

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
    ], [['1-9', 'SCREENS'], ['Q', 'BACK']]);
  }

  // End nodes only (the controller is node 1 — it has no route to itself).
  const endNodes = data.nodes().filter((n) => !n.isController);
  if (endNodes.length === 0) {
    return centeredNotice(view, 'TOPOLOGY / ROUTES', [
      c.grey('No end nodes in the mesh yet'),
    ], [['1-9', 'SCREENS'], ['Q', 'BACK']]);
  }

  const noise = data.noiseFloor();
  const hasRealNoise = data.hasRealNoise();
  // The 18-col ceiling was hit at every width ≥58 while ~150 columns sat idle to
  // the right, and `truncate` marks a cut with nothing (it only re-emits RESET),
  // so long names were silently shortened into different, plausible names.
  const nameBudget = Math.max(6, Math.min(W >= 120 ? 28 : 18, W - 40));

  /* ── observed route churn ─────────────────────────────────────────────── */
  // ONE gate for the per-row ↻ tokens and the header span that qualifies them.
  // Gating them apart would render bare counts on 72-99 column frames with the
  // span nowhere on screen — an unqualified "↻7" is exactly the reading this
  // must not produce, and at W<100 the existing rightStatus already leaves no
  // room for the span (its overflow clips the TITLE, not the filler).
  const showChurn = W >= WIDE_COLS;
  const reroutes = new Map<number, number>();
  let churnSpanMs: number | null = null;
  if (showChurn) {
    let oldest = Infinity;
    for (const e of data.events()) {
      if (e.ts < oldest) oldest = e.ts;
      if (e.kind === 'route' && e.nodeId != null) {
        reroutes.set(e.nodeId, (reroutes.get(e.nodeId) ?? 0) + 1);
      }
    }
    // The window is bounded by the OLDEST event of ANY kind — that is how far
    // back the ring can see at all. Without it "0 reroutes" reads as "stable"
    // when it may only mean the add-on restarted a minute ago.
    if (Number.isFinite(oldest)) churnSpanMs = Math.max(0, Date.now() - oldest);
  }

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
    for (const n of list)
      tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget, showBars, hasRealNoise, reroutes.get(n.nodeId) ?? 0));
  }
  if (lrNodes.length) {
    lrNodes.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Long-Range (direct to controller)', lrNodes.length));
    for (const n of lrNodes)
      tree.push(nodeLine(view, n, n.stats.lwr, noise, nameBudget, showBars, hasRealNoise, reroutes.get(n.nodeId) ?? 0));
  }
  if (pending.length) {
    pending.sort((a, b) => a.nodeId - b.nodeId);
    tree.push(groupHeader(view, 'Route pending', pending.length));
    for (const n of pending)
      tree.push(nodeLine(view, n, null, noise, nameBudget, showBars, hasRealNoise, reroutes.get(n.nodeId) ?? 0));
  }

  /* ── assemble the body: [histogram] + windowed tree + repeater panel ──── */
  const bodyCap = Math.max(1, H - 3); // frame reserves masthead + rule + command bar
  const showHist = bodyCap >= 15 && W >= 64 && directCount + repeatedCount > 0;
  const histLines = showHist ? [hopHistogram(view, byHop, directCount)] : [];
  // Two passes, because panel height and tree capacity define each other. Pass 1
  // sizes the panel at its floor to learn how many rows the tree leaves over;
  // pass 2 spends exactly those rows on repeaters that would otherwise be hidden
  // behind a "+N". Growing the panel by s shrinks treeCap by s, so the padding
  // loop below simply has less to pad — the tree never loses a row it was using
  // and never flips into scroll mode on account of this.
  const panelCap = Math.max(1, bodyCap - histLines.length - 2);
  const basePanel = repeaterLoadPanel(view, ctx, endNodes, nameBudget, noise, 0).slice(0, panelCap);
  const surplus = Math.max(0, bodyCap - histLines.length - basePanel.length - tree.length);
  const panel =
    surplus > 0
      ? repeaterLoadPanel(view, ctx, endNodes, nameBudget, noise, surplus).slice(0, panelCap)
      : basePanel;
  // ROUTE STABILITY is funded ONLY by rows the tree would otherwise leave blank
  // (v0.34). On a tall terminal this screen padded ~40 % of its height with
  // empty rows (32 of 80 at 200x80, measured) while the one quantity a topology
  // screen most wants — does this path HOLD? — sat unread in the evidence
  // store. Shelving the existing blocks into columns was tried, measured and
  // reverted in v0.29: a sparse screen wants DATA, not rearrangement.
  //
  // Strictly leftover-funded: when the tree needs to scroll there is no pad to
  // spend, `padRows` is 0, and this panel does not exist — the tree never loses
  // a row to it. Same rule as the repeater panel above.
  const treeCapBase = Math.max(1, bodyCap - histLines.length - panel.length);
  const padRows = Math.max(0, treeCapBase - tree.length);
  // Route FAILURES get FIRST claim on the pad (v0.35). This is the
  // persisted `routeFailedBetween` history the evidence store has recorded
  // since v0.13 and NO screen has ever drawn — the one quantity that names a
  // suspect LINK rather than a suspect node. On a healthy mesh it is empty
  // and costs nothing; when a link is failing it is the most specific thing
  // this screen can say.
  //
  // First claim, but a BOUNDED one: on a 38-node mesh the stability panel will
  // happily list every churning node and consume the entire surplus, so a
  // strictly-more-actionable finding must not be the one that gets squeezed
  // out. Half the pad (floor 3) is enough for the ranked links plus the
  // "+N more" disclosure, and stability keeps the rest — neither starves.
  const failCap = Math.min(padRows, Math.max(3, Math.floor(padRows / 2)));
  const failures = failCap >= 3 ? routeFailurePanel(view, ctx, endNodes, nameBudget, failCap) : [];
  const stabPad = Math.max(0, padRows - failures.length);
  const stability = stabPad >= 3 ? routeStabilityPanel(view, ctx, endNodes, nameBudget, stabPad) : [];
  const treeCap = Math.max(1, treeCapBase - stability.length - failures.length);

  const body: string[] = [...histLines];
  if (tree.length <= treeCap) {
    body.push(...tree);
    while (body.length < histLines.length + treeCap) body.push('');
    body.push(...failures);
    body.push(...stability);
    view.topologyScroll = 0;
  } else {
    // The tree SCROLLS. It is ordered shallowest-first, so a fixed window from
    // index 0 always kept the (many, healthy) direct rows and always cut the
    // deep-hop, Long-Range and route-pending groups — exactly the anomalies
    // this screen exists to show. Worse, the old "taller terminal shows all"
    // note was false: 39 nodes need ~45 lines and rows clamp well below that.
    const shown = treeCap - 1; // reserve the last row for the position note
    const maxScroll = Math.max(0, tree.length - shown);
    const scroll = Math.max(0, Math.min(view.topologyScroll ?? 0, maxScroll));
    view.topologyScroll = scroll; // clamp + write back (detail.ts's pattern)
    for (let i = scroll; i < scroll + shown && i < tree.length; i++) body.push(tree[i]);
    const above = scroll;
    const below = Math.max(0, tree.length - scroll - shown);
    const where = above > 0 ? `▴${above} ▾${below}` : `▾ ${below}`;
    body.push(c.grey(`  ${where} more · ↑↓ scroll · ${scroll + 1}–${Math.min(tree.length, scroll + shown)}/${tree.length}`));
  }
  body.push(...panel);

  // A rebuild REWRITES the very routes this screen is drawing, so the tree is a
  // snapshot of something mid-change. Controller shows the rebuild; here it is
  // a provenance caveat on everything above.
  const rebuilding = data.controller()?.isRebuildingRoutes === true;

  let churnTok = '';
  if (showChurn && churnSpanMs != null) {
    let total = 0;
    for (const k of reroutes.values()) total += k;
    // Count AND window, always together, and never divided into a rate: the ring
    // is capped and session-scoped, so a per-hour figure would extrapolate from
    // a window whose start is just "when the add-on last booted".
    churnTok =
      c.grey(' · ') +
      (total > 0 ? c.white(`${total} REROUTES`) : c.grey('0 REROUTES')) +
      c.grey(`/${fmtElapsed(churnSpanMs)}`);
  }

  const rs =
    c.grey('END ') + c.white(String(endNodes.length)) + c.grey(' · ') +
    c.green(`${directCount} DIRECT`) + c.grey(' · ') + c.white(`${repeatedCount} HOPS`) +
    (lrNodes.length ? c.grey(' · ') + c.blue(`${lrNodes.length} LR`) : '') +
    (pending.length ? c.grey(' · ') + c.yellow(`${pending.length} PEND`) : '') +
    churnTok +
    (rebuilding ? c.grey(' · ') + c.yellow('REBUILDING') : '');

  return frame(view, data, {
    title: 'TOPOLOGY / ROUTES',
    rightStatus: rs,
    body,
    // Topology honours the dBm↔margin toggle, and now scrolls its route tree.
    keys: [['↑↓', 'SCROLL'], ['1-9', 'SCREENS'], ['T', 'UNITS', 1], ['Q', 'BACK']],
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
  hasRealNoise: boolean,
  reroutes = 0,
): string {
  // A DEAD/UNKNOWN node's route telemetry is the last reading taken BEFORE it
  // stopped answering. Rendering it live-green put a healthy rate and a full
  // 4-bar signal on a node that is not there. ASLEEP is a normal, expected
  // state — it gets its own cyan marker rather than looking identical to alive.
  const isDead = n.status === NodeStatus.Dead;
  const isUnknown = n.status === NodeStatus.Unknown;
  // Both mean "this telemetry is not live", but they are different claims:
  // Unknown is "never contacted / not reported", not "confirmed unreachable".
  // Marking them identically contradicted the Overview, which keeps them apart.
  const stale = isDead || isUnknown;
  const asleep = n.status === NodeStatus.Asleep;
  const mark = isDead ? c.red('✕') : isUnknown ? c.grey('○') : asleep ? c.cyan('◐') : c.green('●');
  const idColor = stale ? c.grey : n.isLongRange ? c.blue : c.white;
  const nameColor = stale ? c.grey : asleep ? c.cyan : c.white;

  // On a MULTI-HOP route `lwr.rssi` is the last hop's (repeater→controller) ACK
  // reading — it describes that repeater's link, not this device's. Grading it
  // as the node's own signal made a distant, weakly-heard node look strong.
  const routed = !n.isLongRange && (lwr?.repeaters.length ?? 0) > 0;

  // signalBars(4) drawn from the same LWR margin the numeric cell reports, so
  // the glyph and the number always agree; dropped on narrow terminals.
  const bars = showBars ? routeSignalBars(view, lwr, noise, stale || routed) + ' ' : '';
  // Deliberately NOT a band colour: rerouting is the mesh doing its job, so a
  // count must not be dressed as a warning. Neutral, like the HOPS tally.
  const churn = reroutes > 0 ? ' ' + c.grey('↻') + c.white(String(reroutes)) : '';
  const right =
    rateCell(lwr, stale) + '  ' + bars + signalCell(view, lwr, noise, stale, routed, hasRealNoise) + churn;

  const head =
    ' ' +
    mark +
    ' ' +
    idColor(`n${n.nodeId}`) +
    ' ' +
    nameColor(truncate(n.name, nameBudget)) +
    '  ' +
    c.grey('→') +
    '  ';
  // The chain is sized against what is ACTUALLY left after the right block, so
  // it degrades itself in whole tokens instead of being blind-cut by lr(). The
  // -1 is lr's minimum single-space gap.
  const budget = view.cols - visLen(head) - visLen(right) - 1;
  return lr(head + chainStr(n, lwr, view, noise, stale || routed, budget), right, view.cols);
}

/**
 * A 4-cell WiFi-style strength glyph for the route, driven by the LWR margin
 * (rssi − noise floor). The fill fraction is bucketed to line the bars' colour
 * up with the numeric margin thresholds (≥17dB green · 5-16 yellow · <5 red).
 * No usable reading → dim placeholder bars (keeps the column aligned).
 */
function routeSignalBars(view: ViewState, lwr: RouteStat | null, noise: number, neutral = false): string {
  const rssi = rssiReading(lwr?.rssi);
  if (rssi == null) return c.grey('▁▃▅▇');
  const margin = Math.round(rssi - noise);
  let frac: number;
  if (margin >= 17) frac = 1; // 4 bars
  else if (margin >= 5) frac = 0.5; // 2 bars
  else if (margin >= -3) frac = 0.25; // 1 bar
  else frac = 0.1; // ~0 bars
  // Color the bars with the SAME band the numeric cell uses, so glyph and number
  // agree in BOTH margin and dBm display modes.
  const color = neutral ? c.grey : view.signalDisplay === 'dbm' ? rssiColor(rssi) : marginColor(margin);
  return signalBars(frac, 4, color);
}

/**
 * One hop's OWN reading, rendered in whatever unit the row is already using.
 *
 * `repeaterRSSI[i]` is the strength measured AT repeater i — the per-link
 * quantity nodeLine's comment says the row lacks. Detail renders it too
 * (`routeChain`), but its idiom is NOT portable here unchanged: Detail has no
 * unit toggle, and this screen's rule (see routeSignalBars) is that every
 * number on a row uses the same band AND the same unit in both modes. A raw
 * `-93` beside a `+11dB` cell would be two units on one row.
 *
 * Sentinels are "no reading", and they are POSITIVE (127/126/125) — passing one
 * through as a level would render the strongest link on the mesh.
 */
function hopReading(
  view: ViewState,
  rssi: number | null | undefined,
  noise: number,
  neutral: boolean,
): string {
  const v = rssiReading(rssi);
  if (v == null) return c.grey('—');
  if (view.signalDisplay === 'dbm') return (neutral ? c.grey : rssiColor(v))(String(v));
  const margin = Math.round(v - noise);
  return (neutral ? c.grey : marginColor(margin))(`${margin >= 0 ? '+' : ''}${margin}`);
}

/**
 * The repeater chain, annotated with each hop's own reading and degraded as a
 * sequence of WHOLE tokens to fit `budget`.
 *
 * It cannot be left to `lr()` to trim. lr truncates the LEFT on overflow, and
 * the left is where this cell lives, so a long chain came back as `⚠n153↮n1` —
 * HALF a failed pair, which detail.ts documents as worse than naming neither
 * end. Every step below drops a complete unit, so a partial route can never be
 * mistaken for a real one:
 *
 *   n31(-93)→n23(-84)→n12(-62) ⚠n31↮n23   full
 *   n31→n23→n12 ⚠n31↮n23                  readings dropped
 *   n31→…→n12 ⚠n31↮n23                    middle elided (… says so)
 *   3 hops ⚠n31↮n23                       chain collapsed to its length
 *   … then, and only then, the marker itself weakens:
 *   n31→n23→n12 ⚠                         pair unnameable → warn WITHOUT naming
 *   3 hops                                nothing fits but the shape
 *
 * The ORDER matters as much as the steps: the search holds the full marker and
 * degrades the chain under it before it will weaken the marker. Which link
 * failed is worth more than what the healthy hops measured.
 */
function chainStr(
  n: NodeSnapshot,
  lwr: RouteStat | null,
  view: ViewState,
  noise: number,
  neutral: boolean,
  budget: number,
): string {
  if (n.isLongRange) return c.blue('direct');
  if (!lwr) return c.grey('pending');
  const hops = lwr.repeaters;
  if (hops.length === 0) return c.green('direct');

  const ids = hops.map((r) => `n${r}`);
  const body = c.white;

  // Widest first; the first candidate that fits wins. The annotated form is
  // offered only on wide frames: on an 80-column row the readings would fit on
  // a 1-hop route and vanish on a 3-hop one, so the same screen would change
  // what a chain MEANS with the length of a name. Surplus-funded, like the rest.
  const annotated =
    view.cols >= WIDE_COLS
      ? [
          ids
            .map(
              (id, i) =>
                body(id) + c.grey('(') + hopReading(view, lwr.repeaterRSSI?.[i], noise, neutral) + c.grey(')'),
            )
            .join(c.grey('→')),
        ]
      : [];
  const chains: string[] = [
    ...annotated,
    ids.map((id) => body(id)).join(c.grey('→')),
    ...(ids.length > 2 ? [body(ids[0]) + c.grey('→…→') + body(ids[ids.length - 1])] : []),
    body(`${ids.length} hop${ids.length === 1 ? '' : 's'}`),
  ];

  // The failure marker degrades independently — naming ONE end is never an option.
  const markers: string[] = [];
  if (lwr.routeFailedBetween) {
    const [a, b] = lwr.routeFailedBetween;
    markers.push(' ' + c.red(`⚠n${a}↮n${b}`), ' ' + c.red('⚠'), '');
  } else {
    markers.push('');
  }

  // Markers OUTER, chains INNER — the failure marker outranks the readings.
  //
  // The first cut nested these the other way round, so the first fit was always
  // "widest chain, weakest marker": at 100 columns a fully annotated chain
  // rendered beside a bare ⚠ while the previous release had named the pair, with
  // nine columns still free. That inverted the ladder in this function's own
  // docstring and told the operator a link had failed without saying which,
  // in order to keep per-hop numbers it could have dropped instead.
  let last = '';
  for (const marker of markers) {
    for (const chain of chains) {
      const s = chain + marker;
      if (visLen(s) <= budget) return s;
      last = s;
    }
  }
  // Nothing fits the budget: return the narrowest form rather than a blind cut.
  return last;
}

function rateCell(lwr: RouteStat | null, stale = false): string {
  const dr = lwr?.protocolDataRate ?? null;
  if (dr == null) return c.grey('—');
  // An unrecognised rate is UNKNOWN, not a Long-Range link — blue is reserved
  // for LR and made an unmapped code read as the fastest tier on the mesh.
  const known = DATA_RATE_LABEL[dr];
  if (known == null) return c.grey('?');
  const color = stale ? c.grey : dr >= 4 ? c.blue : dr >= 3 ? c.green : dr === 2 ? c.yellow : c.red;
  return color(known);
}

function signalCell(
  view: ViewState,
  lwr: RouteStat | null,
  noise: number,
  stale = false,
  routed = false,
  hasRealNoise = true,
): string {
  const rssi = rssiReading(lwr?.rssi);
  if (rssi == null) return c.grey('—');
  const neutral = stale || routed;
  if (view.signalDisplay === 'dbm') {
    return (neutral ? c.grey : rssiColor(rssi))(`${rssi}dBm`);
  }
  const margin = Math.round(rssi - noise); // margin above the noise floor (fractional floor → round)
  // `est` marks a margin measured against the ASSUMED noise floor rather than a
  // real one read from the driver — without it an estimate reads as a reading.
  const est = hasRealNoise ? '' : c.grey(' est');
  return (neutral ? c.grey : marginColor(margin))(`${margin >= 0 ? '+' : ''}${margin}dB`) + est;
}

/* ── repeater-load panel (single-point-of-failure indicator) ─────────────── */

/**
 * What the mesh's routing has actually DONE, over days — the quantity no screen
 * held (v0.34).
 *
 * Reads the same `dRouteChanges` accumulator the `route-churn` detector sums,
 * via the persisted coarse tier. Its purpose is as much epistemic as visual:
 * route-churn has carried a detector and a planner card since v0.30 and has
 * never once fired here, and until this panel there was no way to tell whether
 * the mesh is genuinely stable or the detector simply cannot see. A measured
 * "zero re-routes across N nodes over Xh" answers that; an empty screen did not.
 *
 * ZERO IS A FINDING, NOT AN EMPTY STATE. When nothing has moved, that is one
 * confident line — not 38 rows each reading "0", which would spend the whole
 * budget restating the same fact. Only when paths HAVE moved does the panel
 * rank them, worst-first, because then the identity of the unstable node is the
 * information.
 */
/**
 * Which LINK broke — the persisted route-failure history (v0.35).
 *
 * `routeFailedBetween` is transient on the live stats object (the next OK
 * transmission overwrites it), which is why the evidence store latches every
 * occurrence to disk. It has done so since v0.13 and nothing has ever read it
 * back: the add-on has been recording exactly which pair a transmission died
 * between, and showing the operator nothing.
 *
 * A node-level symptom says "n44 is unreliable". This says "n44's traffic died
 * between n12 and n44, six times" — which is a different and far more
 * actionable claim, because it names the hop to go look at.
 *
 * Empty on a healthy mesh, and it costs zero rows there.
 */
function routeFailurePanel(
  view: ViewState,
  ctx: ScreenCtx,
  endNodes: NodeSnapshot[],
  nameBudget: number,
  budget: number,
): string[] {
  if (typeof ctx.data.routeFailures !== 'function' || budget < 3) return [];
  // Tally by the PAIR, not by the reporting node: one marginal link shows up in
  // several nodes' histories, and the pair is the thing to go fix.
  const byPair = new Map<string, { a: number; b: number; n: number; last: number }>();
  for (const n of endNodes) {
    for (const f of ctx.data.routeFailures(n.nodeId) ?? []) {
      const [a, b] = f.between;
      const k = `${a}>${b}`;
      const cur = byPair.get(k);
      if (cur) { cur.n += 1; cur.last = Math.max(cur.last, f.t); }
      else byPair.set(k, { a, b, n: 1, last: f.t });
    }
  }
  if (byPair.size === 0) return [];

  const ranked = [...byPair.values()].sort((x, y) => y.n - x.n || y.last - x.last);
  // Header takes 1 row; the disclosure line exists ONLY when something is cut,
  // and it replaces exactly one link row. The first version subtracted the
  // disclosure twice (capacity = budget - 2, then slice(capacity - 1)), and
  // because failCap pins budget to 3 for every padRows in 3..7 — the DEFAULT
  // 80x24 frame — the panel rendered a header and "+7 more" while naming ZERO
  // links (v0.35 review, confirmed by three independent reproductions). A
  // disclosure line above nothing is "+7 more" than the zero it showed.
  const fitCap = Math.max(1, budget - 1);
  const canDisclose = ranked.length > fitCap;
  const shown = canDisclose ? ranked.slice(0, Math.max(1, budget - 2)) : ranked;
  const lines = [groupHeader(view, 'Route failures', byPair.size)];
  const nameOf = (id: number): string => {
    const n = ctx.data.nodeById(id);
    return n ? truncate(n.name, Math.max(6, Math.floor(nameBudget / 2))) : `n${id}`;
  };
  for (const f of shown) {
    const tone = f.n >= 5 ? c.red : f.n >= 2 ? c.yellow : c.grey;
    const left = '  ' + c.white(`n${f.a}`) + c.grey(' ⇢ ') + c.white(`n${f.b}`) +
      c.grey('  ' + nameOf(f.a) + ' → ' + nameOf(f.b));
    const right = tone(`${f.n} failure${f.n === 1 ? '' : 's'}`) +
      c.grey(` · last ${fmtElapsed(Math.max(0, Date.now() - f.last))} ago`);
    lines.push(lr(left, right, view.cols));
  }
  if (canDisclose) {
    lines.push(c.grey(`  +${ranked.length - shown.length} more link(s) — by failure count, most first`));
  }
  return lines.slice(0, budget);
}

function routeStabilityPanel(
  view: ViewState,
  ctx: ScreenCtx,
  endNodes: NodeSnapshot[],
  nameBudget: number,
  budget: number,
): string[] {
  if (typeof ctx.data.routeStability !== 'function' || budget < 3) return [];
  const rows: { node: NodeSnapshot; changes: number; hours: number }[] = [];
  for (const n of endNodes) {
    const s = ctx.data.routeStability(n.nodeId);
    if (s && s.hours > 0) rows.push({ node: n, changes: s.changes, hours: s.hours });
  }
  // No coarse history yet (fresh install, or the store is off) — say so rather
  // than render a confident zero over an empty measurement.
  if (rows.length === 0) return [];

  // The SHORTEST window, not the longest. The label sits next to a count of
  // ALL nodes, so it must be the window every one of them actually has —
  // per-node coarse rings start at each node's own first fold, so a node
  // included yesterday holds far less than its siblings. Taking the max
  // credited the whole fleet with the oldest node's history, which is the
  // precise way this panel could 'outrun its window' — the thing its own
  // docstring promises it cannot do. Worst-of is the project's rule for a
  // chained claim (DESIGN §3.4).
  const hours = Math.min(...rows.map((r) => r.hours));
  const span = hours >= 48 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
  const total = rows.reduce((a, r) => a + r.changes, 0);
  const lines = [groupHeader(view, 'Route stability', rows.length)];

  if (total === 0) {
    lines.push(
      '  ' +
        c.green('every path held') +
        c.grey(` — ${rows.length} node(s), ${span} measured, zero re-routes`),
    );
    return lines.slice(0, budget);
  }

  // Rank by the SAME per-day rate the row displays. Sorting by raw count
  // contradicted this panel's own stated reason for showing a rate: 10
  // re-routes over 10 days (1/day) outranked 4 over 2 hours (48/day), so
  // 'worst-first' put the worst node second.
  const perDayOf = (r: { changes: number; hours: number }): number =>
    r.changes / Math.max(1 / 24, r.hours / 24);
  const ranked = rows
    .filter((r) => r.changes > 0)
    .sort((a, b) => perDayOf(b) - perDayOf(a) || b.changes - a.changes || a.node.nodeId - b.node.nodeId);
  // Same disclosure arithmetic as routeFailurePanel, for the same reason: the
  // pre-v0.35 version double-subtracted the disclosure row, so a small budget
  // rendered "+N more" over an empty list. Pre-existing here since v0.34 — the
  // v0.35 failCap split just widened the small-budget band it hid in.
  const fitCap = Math.max(1, budget - 1);
  const canDisclose = ranked.length > fitCap;
  const shown = canDisclose ? ranked.slice(0, Math.max(1, budget - 2)) : ranked;
  const max = perDayOf(ranked[0]);

  for (const r of shown) {
    // Per-DAY rate, not the raw count: a 6-hour-old store and a 6-day-old one
    // are not comparable by total, and the detector's own threshold is a RATE.
    const perDay = perDayOf(r);
    const tone = perDay >= 12 ? c.red : perDay >= 4 ? c.yellow : c.green;
    const left = '  ' + c.white(`n${r.node.nodeId}`) + ' ' + c.white(truncate(r.node.name, nameBudget));
    const right =
      meter(perDayOf(r) / max, 8, { color: tone }) +
      ' ' +
      tone(`${r.changes} re-route${r.changes === 1 ? '' : 's'}`) +
      c.grey(` · ${perDay < 1 ? '<1' : Math.round(perDay)}/day`);
    lines.push(lr(left, right, view.cols));
  }
  if (canDisclose) {
    const rest = ranked.length - shown.length;
    lines.push(c.grey(`  +${rest} more node(s) with re-routes — by count, most first`));
  } else if (lines.length < budget) {
    lines.push(c.grey(`  ${rows.length - ranked.length} node(s) held every path · ${span} measured`));
  }
  return lines.slice(0, budget);
}

function repeaterLoadPanel(
  view: ViewState,
  ctx: ScreenCtx,
  endNodes: NodeSnapshot[],
  nameBudget: number,
  noise: number,
  surplus: number,
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

  const ranked = [...load.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  // The cap used to be a flat 5 while the header reported the true total, so
  // repeaters stayed hidden even when blank pad rows sat directly beneath them.
  // It is surplus-funded now — and the accounting has to include the "+N more"
  // line itself. A first cut added that line unconditionally and it cost a node
  // row at 80x24, which is the whole failure mode this rule exists to stop: the
  // panel grew by one and the tree lost one. So the explicit disclosure appears
  // only when surplus pays for it; with no surplus the panel is byte-identical
  // and the header's own count (which reports the true total) carries the
  // disclosure, exactly as it did before.
  const capacity = 5 + Math.max(0, surplus);
  const canDisclose = surplus > 0;
  const shown =
    ranked.length > capacity && canDisclose
      ? ranked.slice(0, capacity - 1)
      : ranked.slice(0, capacity);
  const max = ranked[0][1];

  const lines = [groupHeader(view, 'Repeater load', load.size)];
  for (const [id, k] of shown) {
    const node = ctx.data.nodeById(id);
    const name = node ? node.name : '(unknown)';
    // SPOF colouring: unlike a health meter, a FULL bar here is BAD — many nodes
    // leaning on one repeater — so the colour is driven by load, not fill.
    const textColor = k >= 5 ? c.red : k >= 3 ? c.yellow : c.green;
    const left =
      '  ' + c.white(`n${id}`) + ' ' + c.white(truncate(name, nameBudget)) + spineDetail(view, ctx, id, noise);
    const right =
      meter(k / max, 8, { color: textColor }) +
      ' ' +
      textColor(`carries ${k} ${k === 1 ? 'node' : 'nodes'}`);
    lines.push(lr(left, right, view.cols));
  }
  if (canDisclose && shown.length < ranked.length) {
    lines.push(c.grey(`  +${ranked.length - shown.length} more repeater(s) — by load, heaviest first`));
  }
  return lines;
}

/**
 * What a repeater's own dependents actually see — the quantity no screen holds.
 *
 * The same physical repeater appears in many routes and contributes one inbound
 * reading to each; Detail sees one node, Overview one row, Heatmap one area, so
 * nothing aggregates them. Three traps, all of which have bitten this codebase:
 *
 *  1. The "no reading" sentinels are POSITIVE (127/126/125). Feeding them to a
 *     min/median reports 127 as the strongest link on the mesh, so they are
 *     dropped before any statistic is taken — not clamped, dropped.
 *  2. A DEAD/UNKNOWN dependent's reading is the last one taken before it went
 *     away. nodeLine already refuses to grade that as live; an aggregate that
 *     quietly folds it back in would undo exactly that.
 *  3. There is deliberately NO failure-rate here. Σtimeout/Σsent over the
 *     dependents looks like a per-repeater reliability figure and is not one:
 *     `timeoutResponse`/`commandsTX` are per-node LIFETIME totals covering
 *     every route that node has ever used, so a node routed through two
 *     repeaters charges 100% of its failures to BOTH, and a repeater that
 *     joined the route a minute ago inherits all of the node's history from
 *     before it was involved — the same history the ↻ token on that row says
 *     was accumulated elsewhere. The driver exposes no per-LINK counter, so
 *     the honest move is to show no rate rather than a confident wrong one.
 */
function spineDetail(view: ViewState, ctx: ScreenCtx, repeaterId: number, noise: number): string {
  if (view.cols < 120) return ''; // surplus-only; narrow frames keep the plain row
  const readings: number[] = [];
  let weak = 0;
  let deps = 0;
  for (const n of ctx.data.nodes()) {
    if (n.isController) continue;
    const lwr = n.stats.lwr;
    const i = lwr?.repeaters.indexOf(repeaterId) ?? -1;
    if (!lwr || i < 0) continue;
    deps += 1; // every dependent, matching the row's own "carries N nodes"
    if (n.status === NodeStatus.Dead || n.status === NodeStatus.Unknown) continue; // trap 2
    const r = lwr.repeaterRSSI?.[i];
    if (rssiReading(r) != null) { // trap 1
      readings.push(r);
      if (r - noise < WEAK_MARGIN_DB) weak += 1;
    }
  }

  const parts: string[] = [];
  // The sample count is part of the claim. "worst -91" over one reading and over
  // nine are different statements, and the operator cannot tell them apart from
  // the value alone. It also makes the sentinel filter above observable: without
  // it the count inflates, which is the only way a dropped sentinel can show —
  // a positive sentinel can never be the minimum, and never falls below a weak
  // margin, so `worst` and `weak` are both blind to it.
  // n is written as live/total so it reconciles with the "carries N nodes" on
  // the same row: those differ whenever a dependent is dead, asleep-with-no-
  // reading, or reporting a sentinel, and an unexplained mismatch on one line
  // reads as a bug in one of the two numbers.
  const n = c.grey(` n${readings.length}/${deps}`);
  if (readings.length) {
    parts.push(c.grey('worst ') + hopReading(view, Math.min(...readings), noise, false) + n);
    if (weak > 0) parts.push(c.yellow(`${weak} weak`));
  } else {
    parts.push(c.grey('worst —') + n);
  }
  return '  ' + c.grey('· ') + parts.join(c.grey(' · '));
}
