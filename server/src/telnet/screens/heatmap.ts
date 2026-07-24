/**
 * SIGNAL HEATMAP BY AREA overlay — v0.3 graphics.
 *
 * A control-room heat strip: every mesh node (controller excluded) is grouped
 * by its HA area and drawn as one graded heat cell, shaded by SNR-margin over
 * the live noise floor. Areas are stacked worst-first so the weakest room is
 * on top.
 *
 *   header   SIGNAL HEATMAP by area          noise -92dBm · 6 areas · 38 nodes
 *   legend   margin ░░▒▒▓▓██ 0→25dB+   · no reading
 *   rows     Garage          ▒▓          μ[██░░░] Back Door ↓ -4dB   3n
 *            Living Room      ▓████████   μ[████░] TV Lamp   ↓+11dB   8n
 *            (no area)        ··          — ·                  —      2n
 *   footer   sorted worst-first · q/Esc back · 1-8 screens
 *
 * Each cell = heatCell(marginFrac), marginFrac = clamp(margin / 25dB). Cells
 * are shaded ░▒▓█ and coloured red→yellow→green by that fraction. Margin =
 * node RSSI − noiseFloor(). RSSI sentinels (127/126/125) and any
 * asleep/dead/unknown node read as "no reading" (grey ·) — their last RSSI is
 * stale, so we never grade them. Each area also shows a mean-margin meter, the
 * worst node (name + margin) and its node count on the right.
 */

import { c, lr, padEnd, padStart, truncate, visLen } from '../ansi';
import { heatCell, meter } from '../gauges';
import {
  NodeStatus,
  type NodeSnapshot,
  type ScreenCtx,
} from '../../types';
import { centeredNotice } from './overview';
import { noiseColor, marginColor } from '../bands';
import { frame, fieldStrip, field } from '../chrome';

/* ── layout constants ──────────────────────────────────────────────────── */

const LABEL_W = 16; // area-name column
const WORST_W = 6; // "↓+11dB" worst-margin field
const COUNT_W = 7; // "4/38n" graded/total node-count field
const MEAN_BAR = 5; // mean-margin meter bar width (→ "μ[█████]" = 8 cells)
const NODE_W = 12; // worst-node name column
const MIN_CELLS = 3; // keep at least this much heat-strip space before adding widgets

/** dB margin that maps to a full-green cell — the top of the heat scale. */
const MARGIN_FULL = 25;

/** RSSI values the driver uses as "no measurement" sentinels. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

/** Unique key standing in for a null area so it can live in a string-keyed Map. */
const NO_AREA = ' no-area';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Margin (dB) → 0..1 heat fraction against the MARGIN_FULL ceiling. */
const marginFrac = (margin: number): number => clamp01(margin / MARGIN_FULL);

export function renderHeatmap(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const H = view.rows;

  // Loading / empty states share the overview's centred card look.
  if (!data.ready()) {
    const err = data.lastError();
    return centeredNotice(view, 'SIGNAL HEATMAP', [
      c.grey('Connecting to Home Assistant…'),
      ...(err ? ['', c.red(truncate(err, Math.min(W - 8, 60)))] : []),
    ], [['1-8', 'SCREENS'], ['Q', 'BACK']]);
  }

  const noise = data.noiseFloor();
  const areas = groupByArea(data.nodes(), noise);
  if (areas.length === 0) {
    return centeredNotice(view, 'SIGNAL HEATMAP', [
      c.grey('No Z-Wave nodes discovered yet'),
    ], [['1-8', 'SCREENS'], ['Q', 'BACK']]);
  }

  const totalNodes = areas.reduce((s, a) => s + a.nodeCount, 0);

  const body: string[] = [legendLine(W)];
  // masthead + rule + telemetry + legend + command bar = 5 chrome rows.
  const areaCap = Math.max(1, H - 5);
  if (areas.length > areaCap) {
    const shown = areaCap - 1; // reserve the last row for the overflow note
    for (let i = 0; i < shown; i++) body.push(areaRow(areas[i], W));
    const more = areas.length - shown;
    body.push(c.grey(`…${more} more area${more === 1 ? '' : 's'} (taller terminal shows all)`));
  } else {
    for (const a of areas) body.push(areaRow(a, W));
  }

  return frame(view, data, {
    title: 'SIGNAL HEATMAP',
    telemetry: fieldStrip(view, [
      field('AREAS', String(areas.length)),
      // The Overview's NODES counts the whole roster; this map deliberately
      // excludes the controller (it has no route-in RSSI to grade). Name the
      // difference rather than showing a smaller number under the same label.
      field('DEVICES', String(totalNodes)),
      field(
        'NOISE',
        data.hasRealNoise() ? `${noise} dBm` : `${noise} dBm assumed`,
        data.hasRealNoise() ? noiseColor(noise) : c.grey,
      ),
      // The whole map is margins over that floor — if it is assumed, every
      // cell and every area grade on this screen is an estimate.
      ...(data.hasRealNoise() ? [] : [c.yellow('margins estimated')]),
      c.grey('sorted worst-first'),
    ]),
    body,
    keys: [['1-8', 'SCREENS'], ['Q', 'BACK']], // no [T] UNITS: this map is dB-margin only (T has no effect here)
  });
}

/* ── grouping / per-area stats ─────────────────────────────────────────── */

interface AreaCell {
  name: string;
  margin: number | null; // dB over noise floor, or null = no reading
  /** True when `margin` came from a LAST-HOP repeater ACK, not this node's own link. */
  routed: boolean;
  /** Confirmed unreachable (NodeStatus.Dead). */
  dead: boolean;
  /** Never contacted / status not reported — NOT the same as confirmed dead. */
  unknown: boolean;
}

interface AreaInfo {
  label: string;
  cells: AreaCell[]; // sorted worst-first; no-reading cells sink to the end
  nodeCount: number;
  /** Nodes contributing a DIRECT reading — the honest denominator for min/mean. */
  gradedCount: number;
  deadCount: number;

  minMargin: number | null; // worst direct reading in the area
  meanMargin: number | null; // mean of direct readings
  worstName: string | null; // node behind minMargin
}

/**
 * Margin (dB over the noise floor) for a node, or null when it has no usable
 * reading: asleep/dead/unknown nodes carry a stale RSSI, and the sentinels
 * 127/126/125 mean "not measured".
 */
function nodeMargin(n: NodeSnapshot, noise: number): number | null {
  if (n.status !== NodeStatus.Alive && n.status !== NodeStatus.Awake) return null;
  const rssi = n.stats.rssi;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) return null;
  return Math.round(rssi - noise);
}

/**
 * True when this node reaches the controller THROUGH a repeater. Its
 * `stats.rssi` is then the last hop's (repeater→controller) ACK reading — a
 * measurement of the repeater's link, not of this device's. It is still worth
 * drawing, but it must not grade the node or the area it sits in.
 */
function isRouted(n: NodeSnapshot): boolean {
  return !n.isLongRange && (n.stats.lwr?.repeaters?.length ?? 0) > 0;
}

function groupByArea(nodes: NodeSnapshot[], noise: number): AreaInfo[] {
  const groups = new Map<string, AreaCell[]>();
  for (const n of nodes) {
    if (n.isController) continue; // the controller has no route-in RSSI
    const key = n.area ?? NO_AREA;
    const list = groups.get(key) ?? [];
    list.push({
      name: n.name,
      margin: nodeMargin(n, noise),
      routed: isRouted(n),
      // Dead and Unknown are DIFFERENT claims. Unknown is also the fallback
      // whenever HA omits a status (zwaveData: `raw.status ?? Unknown`), so
      // painting it "✕ dead" asserts an unreachable node on no evidence — and
      // the Overview, which keeps them apart, would then disagree.
      dead: n.status === NodeStatus.Dead,
      unknown: n.status === NodeStatus.Unknown,
    });
    groups.set(key, list);
  }

  const areas: AreaInfo[] = [];
  for (const [key, cells] of groups) {
    // Sort each area's cells worst-first so the weakest links survive an
    // overflow truncation.
    //
    // Dead and Unknown nodes carry NO margin, so ranking on margin alone sank
    // them to the end — and renderCells() truncates the TAIL. On any area with
    // more nodes than cell columns the ✕ and ○ marks were therefore the FIRST
    // thing discarded while every healthy full block was kept, so a room with
    // dead devices rendered as solid green. Rank by severity of state first.
    const rank = (x: AreaCell): number =>
      x.dead ? 0 : x.unknown ? 1 : x.margin == null ? 3 : 2;
    cells.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.margin == null || b.margin == null) return 0;
      // ASCENDING — weakest first. renderCells() truncates the TAIL, and this
      // whole sort exists so the weak links survive that truncation. It was
      // written descending when the rank tiers were added, which silently made
      // the `+N` overflow drop exactly the cells the operator needs to see.
      return a.margin - b.margin;
    });
    // Only DIRECT readings grade the area. A routed node's last-hop margin
    // describes its repeater, so letting it set the min/mean made a whole area
    // read "strong" on the strength of a link none of its devices actually use.
    const reals = cells.filter((x) => x.margin != null && !x.routed) as { name: string; margin: number }[];
    const mean =
      reals.length ? Math.round(reals.reduce((s, x) => s + x.margin, 0) / reals.length) : null;
    areas.push({
      label: key === NO_AREA ? '(no area)' : prettyArea(key),
      cells,
      nodeCount: cells.length,
      gradedCount: reals.length,
      deadCount: cells.filter((x) => x.dead).length,
      // `reals` follows the cell order above, in which graded readings are
      // already ascending within their rank — but take the min explicitly so
      // this cannot silently depend on the sort again.
      minMargin: reals.length ? Math.min(...reals.map((x) => x.margin)) : null,
      meanMargin: mean,
      worstName: reals.length
        ? reals.reduce((w, x) => (x.margin < w.margin ? x : w)).name
        : null,
    });
  }

  // Worst-first, as an explicit TIER rather than a boolean flag:
  //
  //   0  a confirmed-dead node and NOTHING readable   — the room is gone
  //   1  a confirmed-dead node, something still reads — partly gone
  //   2  graded, ordered by worst margin              — working, ranked
  //   3  nothing readable and nothing dead            — all asleep/unknown/routed
  //
  // Tier 1 exists because an area with a dead device and one healthy device is
  // still a problem: sorting it purely on that healthy margin put a ✕ below
  // every green row. Tier 3 is genuinely uninformative and belongs last, which
  // is why "no reading" alone must never be confused with "dead".
  const tier = (x: AreaInfo): number => {
    if (x.deadCount > 0) return x.gradedCount === 0 ? 0 : 1;
    return x.gradedCount > 0 ? 2 : 3;
  };
  areas.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    // More dead devices is worse, within the tiers where that is the signal.
    if (ta <= 1 && a.deadCount !== b.deadCount) return b.deadCount - a.deadCount;
    const am = a.minMargin ?? Infinity;
    const bm = b.minMargin ?? Infinity;
    if (am !== bm) return am - bm;
    return a.label.localeCompare(b.label);
  });
  return areas;
}

/** HA area ids are slugs (e.g. "master_bedroom") — soften underscores for display. */
function prettyArea(area: string): string {
  return area.replace(/_/g, ' ');
}

/* ── one area row ──────────────────────────────────────────────────────── */

function areaRow(a: AreaInfo, W: number): string {
  const label = padEnd(c.white(truncate(a.label, LABEL_W)), LABEL_W);

  // Mandatory right-hand core: worst margin + node count.
  const worstMarginStr =
    a.minMargin == null
      ? c.grey('—')
      : c.grey('↓') + marginColor(a.minMargin)(fmtMargin(a.minMargin));
  const worst = padStart(worstMarginStr, WORST_W);
  // `12n` alone implied all 12 nodes back the grade; `4/12n` says how many
  // actually contributed a direct reading.
  const countTxt = a.gradedCount === a.nodeCount ? `${a.nodeCount}n` : `${a.gradedCount}/${a.nodeCount}n`;
  const count = padStart(c.grey(countTxt), COUNT_W);

  // Space the heat strip may occupy if nothing else is added:
  //   W = LABEL_W + gap + cells + gap + rightBlock
  //   rightBlock(core) = worst + gap + count = WORST_W + 1 + COUNT_W
  let cellsAvail = W - (LABEL_W + 2) - (WORST_W + 1 + COUNT_W);

  // Optional widgets, added outermost-first only while ≥ MIN_CELLS of heat
  // strip survives. Priority: the mean-margin meter (a graphic) beats the
  // worst-node name, which drops first when space is tight.
  let meanPiece = '';
  if (a.meanMargin != null) {
    // Coloured by the SAME band function as the number beside it, the cells and
    // the legend — meter()'s default zoneColor is a different, coarser ramp.
    const p = c.grey('μ[') + meter(marginFrac(a.meanMargin), MEAN_BAR, { color: marginColor(a.meanMargin) }) + c.grey(']');
    if (cellsAvail - (MEAN_BAR + 3) - 1 >= MIN_CELLS) {
      meanPiece = p;
      cellsAvail -= MEAN_BAR + 3 + 1;
    }
  }

  let namePiece = '';
  if (a.worstName) {
    const nm = c.white(truncate(a.worstName, NODE_W));
    const w = visLen(nm);
    if (cellsAvail - w - 1 >= MIN_CELLS) {
      namePiece = nm;
      cellsAvail -= w + 1;
    }
  }

  cellsAvail = Math.max(1, cellsAvail);
  const cellsStr = renderCells(a.cells, cellsAvail);

  // Display order: [mean] [name] worst count.
  const rightBlock = [meanPiece, namePiece, worst, count].filter((p) => p !== '').join(' ');
  return label + ' ' + padEnd(cellsStr, cellsAvail) + ' ' + rightBlock;
}

/**
 * Render up to `avail` node heat cells. Overflow collapses the tail into a grey
 * "+N" marker so the worst-first ordering keeps the weak links visible.
 */
function renderCells(cells: AreaCell[], avail: number): string {
  if (cells.length <= avail) {
    return cells.map(cellGlyph).join('');
  }
  // Largest `shown` whose cells + exact "+N" marker still fit in `avail`.
  let shown = avail;
  while (shown > 0 && shown + 1 + String(cells.length - shown).length > avail) {
    shown--;
  }
  const hidden = cells.length - shown;
  return cells.slice(0, shown).map(cellGlyph).join('') + c.grey(`+${hidden}`);
}

function cellGlyph(cell: AreaCell): string {
  // A dead node is not "no reading" — it is a reading of a different, worse
  // kind, and it gets its own mark instead of the same dot an asleep node gets.
  if (cell.dead) return c.red('✕');
  // Unknown is genuinely unmeasured, not confirmed-bad: its own neutral mark.
  if (cell.unknown) return c.grey('○');
  if (cell.margin == null) return heatCell(0, { none: true });
  // A routed node's margin belongs to its repeater: drawn, but neutral, so it
  // never contributes colour that would be read as this area's signal quality.
  if (cell.routed) return c.grey('▒');
  // Density from the margin fraction, but COLOR from the same marginColor() bands
  // (17/10/5 dB) the numeric worst-margin text uses, so cell and text agree.
  return heatCell(marginFrac(cell.margin), { color: marginColor(cell.margin) });
}

/* ── colour / format helpers ───────────────────────────────────────────── */

function fmtMargin(margin: number): string {
  return `${margin >= 0 ? '+' : ''}${margin}dB`;
}

/* ── legend ─────────────────────────────────────────────────────────────── */

/**
 * Gradient legend: a strip of heat cells ramped 0→1 (weak→strong margin) with
 * the dB span it covers, plus the grey "no reading" marker. The ramp width
 * flexes with the terminal so it never crowds a narrow frame.
 */
/**
 * The heat legend, fitted to the terminal.
 *
 * Every glyph on this screen means nothing without its key, so the legend
 * degrades by dropping WHOLE keys (rightmost first) and shrinking the ramp —
 * never by letting frame() clip the tail. A fixed budget silently amputated the
 * newest key the moment one was added.
 */
function legendLine(W: number): string {
  // MOST ALARMING FIRST. Keys are shed from the END, so this order decides
  // which glyph loses its explanation first on a narrow terminal. `✕ dead` was
  // last and therefore first to go — the one mark an operator most needs
  // decoded. "no reading" is the most self-evident and goes first.
  const KEYS: [string, string][] = [
    [c.red('✕'), ' dead'],
    [c.grey('○'), ' unknown'],
    [c.grey('▒'), ' via repeater'],
    [heatCell(0, { none: true }), ' no reading'],
  ];
  const gap = 3;
  const head = (ramp: number): string => {
    let strip = '';
    for (let i = 0; i < ramp; i++) {
      // Colour the ramp with the SAME band function the cells use. heatCell's
      // default is gauges.zoneColor (3 bands at 16.5/8.25 dB) while every real
      // cell goes through marginColor (4 bands at 17/10/5 incl. redB) — so the
      // key disagreed with the map at 0–4 dB and at 9 dB, and the map's most
      // alarming colour never appeared in its own legend at all.
      const frac = ramp === 1 ? 1 : i / (ramp - 1);
      strip += heatCell(frac, { color: marginColor(frac * MARGIN_FULL) });
    }
    return c.grey('margin ') + strip + ' ' + c.grey(`0→${MARGIN_FULL}dB+`);
  };
  const keyW = (k: [string, string]): number => gap + 1 + k[1].length;

  // KEYS OUTER, ramp INNER. The keys are what make the glyphs on the map
  // readable; the ramp is decoration that merely needs to be wide enough to
  // show a gradient. Searching ramp-first returned the WIDEST ramp with the
  // FEWEST keys — at the default 80 columns that dropped "✕ dead" while
  // leaving 7 columns unused, so the most alarming mark on the screen had no
  // explanation. Prefer every key, then shrink the ramp to pay for them.
  for (let n = KEYS.length; n >= 0; n--) {
    for (let ramp = 14; ramp >= 4; ramp--) {
      const width = visLen(head(ramp)) + KEYS.slice(0, n).reduce((sum, k) => sum + keyW(k), 0);
      if (width <= W) {
        return head(ramp) + KEYS.slice(0, n).map((k) => c.grey(' '.repeat(gap)) + k[0] + c.grey(k[1])).join('');
      }
    }
  }
  return truncate(head(4), W);
}

