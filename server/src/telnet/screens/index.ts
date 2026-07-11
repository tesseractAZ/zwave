/**
 * Screen registry + render dispatcher for the Z-Wave control-room TUI.
 *
 * This replaces ecoflow-panel's plant/index.ts. It is deliberately thin:
 *
 *   • renderScreen(ctx)      pure (ScreenCtx) -> string[] dispatch on the
 *                            active view. Each screen returns one string per
 *                            terminal row; the TuiSession concatenates, hashes
 *                            and writes them (anti-flicker draw loop).
 *   • buildVisibleNodes()    the filter + sort that turns the raw roster into
 *                            the ordered list the Overview table and the
 *                            selection cursor operate on. The session builds a
 *                            ScreenCtx once per frame with this and hands the
 *                            SAME array to every screen — so "selected index"
 *                            means the same node everywhere.
 *
 * Nothing here recomputes Z-Wave state — the DataProvider accessors already
 * return cached values (see telnet/dataProvider). Screens are pure render.
 */

import type {
  DataProvider,
  NodeSnapshot,
  ScreenCtx,
  ScreenView,
  ViewState,
} from '../../types';
import { renderOverview } from './overview';
import { renderDetail } from './detail';
import { renderController } from './controller';
import { renderTopology } from './topology';
import { renderHeatmap } from './heatmap';
import { renderLog } from './log';

export { SCREENS } from '../../types';

/** Human labels for the tab strip / legends (keyed by screen id). */
export const SCREEN_LABEL: Record<ScreenView, string> = {
  overview: 'Overview',
  detail: 'Detail',
  controller: 'Controller',
  topology: 'Topology',
  heatmap: 'Heatmap',
  log: 'Log',
};

/**
 * Render the active screen. Overview is the home node list; the others pop
 * over it as overlays. Returns the array of content rows (no trailing
 * newline) — the caller joins + writes.
 */
export function renderScreen(ctx: ScreenCtx): string[] {
  switch (ctx.view.screen) {
    case 'overview':
      return renderOverview(ctx);
    case 'detail':
      return renderDetail(ctx);
    case 'controller':
      return renderController(ctx);
    case 'topology':
      return renderTopology(ctx);
    case 'heatmap':
      return renderHeatmap(ctx);
    case 'log':
      return renderLog(ctx);
    default: {
      // Exhaustiveness guard — a new ScreenView must be wired above or this
      // fails the typecheck.
      const _never: never = ctx.view.screen;
      void _never;
      return renderOverview(ctx);
    }
  }
}

/**
 * Build the sorted + filtered node list the Overview table and the selection
 * cursor operate on. Pure over (DataProvider snapshot, ViewState) — the
 * session calls this each frame and stores the result on ScreenCtx.
 *
 * The controller (node 1) is included in the roster so the summary bar's
 * "N nodes" matches the real device count and node 1 is reachable from the
 * cursor; its own dedicated screen is a separate overlay.
 */
export function buildVisibleNodes(
  data: DataProvider,
  view: ViewState,
): NodeSnapshot[] {
  const all = data.nodes();
  const needle = view.filter.trim().toLowerCase();
  const filtered = needle ? all.filter((n) => matchesFilter(n, needle)) : all.slice();

  const noise = data.noiseFloor();
  const cmp = comparatorFor(view.sortKey, data, noise);
  // Stable-ish: a nodeId tie-break inside the comparator keeps ordering
  // deterministic frame-to-frame so the anti-flicker hash stays quiet.
  filtered.sort(cmp);
  return filtered;
}

/**
 * Convenience for the session: assemble a full ScreenCtx from the live data
 * provider + current view state in one call.
 */
export function makeScreenCtx(data: DataProvider, view: ViewState): ScreenCtx {
  return { view, data, visibleNodes: buildVisibleNodes(data, view) };
}

/* ── internals ─────────────────────────────────────────────────────────── */

function matchesFilter(n: NodeSnapshot, needle: string): boolean {
  return (
    String(n.nodeId).includes(needle) ||
    n.name.toLowerCase().includes(needle) ||
    n.statusLabel.toLowerCase().includes(needle) ||
    (n.manufacturer != null && n.manufacturer.toLowerCase().includes(needle)) ||
    (n.model != null && n.model.toLowerCase().includes(needle)) ||
    (n.area != null && n.area.toLowerCase().includes(needle))
  );
}

type Cmp = (a: NodeSnapshot, b: NodeSnapshot) => number;

function comparatorFor(
  sortKey: ViewState['sortKey'],
  data: DataProvider,
  noise: number,
): Cmp {
  const byId: Cmp = (a, b) => a.nodeId - b.nodeId;
  switch (sortKey) {
    case 'id':
      return byId;
    case 'name':
      return (a, b) => a.name.localeCompare(b.name) || byId(a, b);
    case 'rssi':
      // Weakest signal first: lowest SNR margin at the top. Sentinel / absent
      // RSSI sorts to the bottom (nothing actionable to see).
      return (a, b) => marginOf(a, noise) - marginOf(b, noise) || byId(a, b);
    case 'seen':
      // Most-stale first: oldest lastSeen at the top; never-seen sorts first.
      return (a, b) => seenOf(a) - seenOf(b) || byId(a, b);
    case 'health':
    default:
      // Worst health first (DEAD -> 0, unknown capped low). Ascending score.
      return (a, b) => data.scoreFor(a.nodeId).score - data.scoreFor(b.nodeId).score || byId(a, b);
  }
}

const RSSI_SENTINELS = new Set([127, 126, 125]);

function marginOf(n: NodeSnapshot, noise: number): number {
  const rssi = n.stats.rssi;
  if (rssi == null || RSSI_SENTINELS.has(rssi)) return Number.POSITIVE_INFINITY;
  return rssi - noise;
}

function seenOf(n: NodeSnapshot): number {
  return n.stats.lastSeen == null ? Number.NEGATIVE_INFINITY : n.stats.lastSeen;
}
