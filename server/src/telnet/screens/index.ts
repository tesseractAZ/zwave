/**
 * Screen registry + render dispatcher for the Z-Wave control-room TUI.
 *
 * This replaces ecoflow-panel's plant/index.ts. It is deliberately thin:
 *
 *   • renderScreen(ctx)      pure (ScreenCtx) -> string[] dispatch on the
 *                            active view. Each screen returns one string per
 *                            terminal row; the TuiSession concatenates, hashes
 *                            and writes them (anti-flicker draw loop).
 *
 * The filter + sort that turns the raw roster into the ordered list is
 * `visibleNodes()` in ./input.ts — the session builds a ScreenCtx once per frame
 * with it and hands the SAME array to every screen, so "selected index" means
 * the same node everywhere.
 *
 * Nothing here recomputes Z-Wave state — the DataProvider accessors already
 * return cached values (see telnet/dataProvider). Screens are pure render.
 */

import type { ScreenCtx, ScreenView } from '../../types';
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

// NOTE: the sorted+filtered node list is produced by `visibleNodes()` in
// ./input.ts — the single source of truth the session renders from. A duplicate
// buildVisibleNodes/makeScreenCtx used to live here and diverged (opposite RSSI
// tiebreak); it was removed to keep one implementation.
