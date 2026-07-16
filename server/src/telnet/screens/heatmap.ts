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
 *   footer   sorted worst-first · q/Esc back · 1-6 screens
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
import { frame, fieldStrip, field } from '../chrome';

/* ── layout constants ──────────────────────────────────────────────────── */

const LABEL_W = 16; // area-name column
const WORST_W = 6; // "↓+11dB" worst-margin field
const COUNT_W = 4; // "38n" node-count field
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
    ]);
  }

  const noise = data.noiseFloor();
  const areas = groupByArea(data.nodes(), noise);
  if (areas.length === 0) {
    return centeredNotice(view, 'SIGNAL HEATMAP', [
      c.grey('No Z-Wave nodes discovered yet'),
    ]);
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
      field('NODES', String(totalNodes)),
      field('NOISE', data.hasRealNoise() ? `${noise} dBm` : '—'),
      c.grey('sorted worst-first'),
    ]),
    body,
    keys: [['1-6', 'SCREENS'], ['T', 'UNITS'], ['Q', 'BACK']],
  });
}

/* ── grouping / per-area stats ─────────────────────────────────────────── */

interface AreaCell {
  name: string;
  margin: number | null; // dB over noise floor, or null = no reading
}

interface AreaInfo {
  label: string;
  cells: AreaCell[]; // sorted worst-first; no-reading cells sink to the end
  nodeCount: number;
  minMargin: number | null; // worst real reading in the area
  meanMargin: number | null; // mean of real readings
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

function groupByArea(nodes: NodeSnapshot[], noise: number): AreaInfo[] {
  const groups = new Map<string, AreaCell[]>();
  for (const n of nodes) {
    if (n.isController) continue; // the controller has no route-in RSSI
    const key = n.area ?? NO_AREA;
    const list = groups.get(key) ?? [];
    list.push({ name: n.name, margin: nodeMargin(n, noise) });
    groups.set(key, list);
  }

  const areas: AreaInfo[] = [];
  for (const [key, cells] of groups) {
    // Sort each area's cells worst-first so the weakest links survive an
    // overflow truncation; no-reading cells sink to the end.
    cells.sort((a, b) => {
      if (a.margin == null) return b.margin == null ? 0 : 1;
      if (b.margin == null) return -1;
      return a.margin - b.margin;
    });
    const reals = cells.filter((x) => x.margin != null) as { name: string; margin: number }[];
    const mean =
      reals.length ? Math.round(reals.reduce((s, x) => s + x.margin, 0) / reals.length) : null;
    areas.push({
      label: key === NO_AREA ? '(no area)' : prettyArea(key),
      cells,
      nodeCount: cells.length,
      minMargin: reals.length ? reals[0].margin : null,
      meanMargin: mean,
      worstName: reals.length ? reals[0].name : null,
    });
  }

  // Worst-first: lowest min margin on top; all-asleep areas (no reading) last.
  areas.sort((a, b) => {
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
      : c.grey('↓') + heatColor(a.minMargin)(fmtMargin(a.minMargin));
  const worst = padStart(worstMarginStr, WORST_W);
  const count = padStart(c.grey(`${a.nodeCount}n`), COUNT_W);

  // Space the heat strip may occupy if nothing else is added:
  //   W = LABEL_W + gap + cells + gap + rightBlock
  //   rightBlock(core) = worst + gap + count = WORST_W + 1 + COUNT_W
  let cellsAvail = W - (LABEL_W + 2) - (WORST_W + 1 + COUNT_W);

  // Optional widgets, added outermost-first only while ≥ MIN_CELLS of heat
  // strip survives. Priority: the mean-margin meter (a graphic) beats the
  // worst-node name, which drops first when space is tight.
  let meanPiece = '';
  if (a.meanMargin != null) {
    const p = c.grey('μ[') + meter(marginFrac(a.meanMargin), MEAN_BAR) + c.grey(']');
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
  if (cell.margin == null) return heatCell(0, { none: true });
  // Density from the margin fraction, but COLOR from the same heatColor() bands
  // (17/10/5 dB) the numeric worst-margin text uses, so cell and text agree.
  return heatCell(marginFrac(cell.margin), { color: heatColor(cell.margin) });
}

/* ── colour / format helpers ───────────────────────────────────────────── */

/** SNR-margin heat buckets (green strong → bold-red critical) for numeric text. */
function heatColor(margin: number): (s: string) => string {
  if (margin >= 17) return c.green;
  if (margin >= 10) return c.yellow;
  if (margin >= 5) return c.red;
  return c.redB;
}

function fmtMargin(margin: number): string {
  return `${margin >= 0 ? '+' : ''}${margin}dB`;
}

function noiseColor(noise: number): (s: string) => string {
  if (noise >= -75) return c.red;
  if (noise >= -85) return c.yellow;
  return c.grey;
}

/* ── legend ─────────────────────────────────────────────────────────────── */

/**
 * Gradient legend: a strip of heat cells ramped 0→1 (weak→strong margin) with
 * the dB span it covers, plus the grey "no reading" marker. The ramp width
 * flexes with the terminal so it never crowds a narrow frame.
 */
function legendLine(W: number): string {
  const ramp = Math.max(6, Math.min(14, W - 30));
  let strip = '';
  for (let i = 0; i < ramp; i++) strip += heatCell(ramp === 1 ? 1 : i / (ramp - 1));
  return (
    c.grey('margin ') +
    strip +
    ' ' +
    c.grey(`0→${MARGIN_FULL}dB+`) +
    c.grey('   ') +
    heatCell(0, { none: true }) +
    c.grey(' no reading')
  );
}

