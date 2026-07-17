/**
 * Transport-agnostic input handling for the Z-Wave TUI.
 *
 * Both transports — the raw telnet TCP server (`server.ts`) and the browser
 * xterm.js WebSocket (`wsConsole.ts`) — parse their wire bytes down to the
 * SAME `InputEvent` union (defined in `../types`, re-exported here) and feed
 * them to `applyKey`, so the key bindings live in exactly one place.
 *
 * `applyKey` is a pure-ish function of `(view, ev, data)`: it MUTATES the
 * per-session `ViewState` and returns whether the frame should be redrawn.
 * The heavy lifting the render loop can't afford (health scoring, snapshots)
 * lives behind the cached `DataProvider` accessors, so navigation stays cheap.
 *
 * v0.1 is READ-ONLY: the mutating action keys (p/i/h/R/x) are recognized so
 * the muscle-memory is right, but they no-op with a log line instead of
 * actuating the mesh. `write_actions_enabled` unlocks them in a later phase.
 */

import type { DataProvider, LogEvent, LogRange, NodeSnapshot, ViewState } from '../types';
import { LOG_RANGE_ORDER, SCREENS } from '../types';

// The InputEvent contract is owned by the shared type module; re-export it so
// the transports + session import their event shape from one navigation home.
export type { InputEvent } from '../types';
import type { InputEvent } from '../types';

/** Result of dispatching one key. */
export interface KeyResult {
  /** The view changed — the transport should schedule a `draw()`. */
  redraw: boolean;
  /**
   * `'start'` when the user pressed `/`: the session should enter its
   * filter-capture mode (subsequent printable chars build `view.filter`).
   */
  filter?: 'start';
  /** The user asked to quit from the Overview home — the transport disconnects. */
  quit?: boolean;
}

/** The sort keys, in the order `s` cycles through them. */
const SORT_ORDER: ViewState['sortKey'][] = ['health', 'id', 'name', 'rssi', 'seen'];

/** RSSI sentinels the driver uses for "no reading" — never sort/score on them. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

function effectiveRssi(n: NodeSnapshot): number {
  const r = n.stats.rssi;
  // null / sentinel → treat as worst so "weakest first" surfaces the unknowns.
  if (r == null || RSSI_SENTINELS.has(r)) return -999;
  return r;
}

/**
 * The sorted + filtered node list the overview grid renders and the selection
 * cursor walks. Computed fresh each frame from the cached provider — cheap,
 * because every accessor it touches is a last-cached read.
 */
export function visibleNodes(data: DataProvider, view: ViewState): NodeSnapshot[] {
  const q = view.filter.trim().toLowerCase();
  let list = data.nodes();
  if (q) {
    list = list.filter((n) => {
      return (
        n.name.toLowerCase().includes(q) ||
        String(n.nodeId).includes(q) ||
        (n.manufacturer ?? '').toLowerCase().includes(q) ||
        (n.model ?? '').toLowerCase().includes(q) ||
        n.statusLabel.toLowerCase().includes(q)
      );
    });
  }
  const sorted = [...list];
  const byId = (a: NodeSnapshot, b: NodeSnapshot) => a.nodeId - b.nodeId;
  switch (view.sortKey) {
    case 'health':
      // Worst health first — the whole point of the triage view.
      sorted.sort((a, b) => {
        const d = data.scoreFor(a.nodeId).score - data.scoreFor(b.nodeId).score;
        return d !== 0 ? d : byId(a, b);
      });
      break;
    case 'id':
      sorted.sort(byId);
      break;
    case 'name':
      sorted.sort((a, b) => {
        const d = a.name.localeCompare(b.name);
        return d !== 0 ? d : byId(a, b);
      });
      break;
    case 'rssi':
      // Weakest signal first.
      sorted.sort((a, b) => {
        const d = effectiveRssi(a) - effectiveRssi(b);
        return d !== 0 ? d : byId(a, b);
      });
      break;
    case 'seen':
      // Most stale (oldest / never seen) first.
      sorted.sort((a, b) => {
        const d = (a.stats.lastSeen ?? 0) - (b.stats.lastSeen ?? 0);
        return d !== 0 ? d : byId(a, b);
      });
      break;
  }
  return sorted;
}

/** Clamp `view.selected` into the current visible list (0 when empty). */
export function clampSelection(view: ViewState, data: DataProvider): void {
  const len = visibleNodes(data, view).length;
  if (len === 0) {
    view.selected = 0;
    return;
  }
  if (view.selected < 0) view.selected = 0;
  if (view.selected > len - 1) view.selected = len - 1;
}

const NOOP: KeyResult = { redraw: false };
const REDRAW: KeyResult = { redraw: true };

/* ─── Activity-log navigation (screen === 'log') ─────────────────────────────
 * The log has its OWN cursor (view.logCursor) over the date/severity-filtered
 * event list, independent of the node-selection cursor. The layout math lives
 * here (not the renderer) so paging and the visible window agree exactly. */

/** Detail-pane height, and the terminal-height floor below which it is hidden. */
export const LOG_DETAIL_ROWS = 9;
const LOG_MIN_ROWS_FOR_DETAIL = 22;

/** Split the log screen's rows into {list, detail}. header(1)+legend(1) always;
 *  a separator(1)+detail block only when the terminal is tall enough. */
export function logLayout(rows: number): { listRows: number; detailRows: number; showDetail: boolean } {
  const showDetail = rows >= LOG_MIN_ROWS_FOR_DETAIL;
  const detailRows = showDetail ? LOG_DETAIL_ROWS : 0;
  // 3 = masthead + title rule + command bar (the shared diagnostic-console frame).
  const chrome = 3 + (showDetail ? 1 + detailRows : 0);
  return { listRows: Math.max(1, rows - chrome), detailRows, showDetail };
}

/** Lower/upper epoch-ms bounds for a date range (local-time day boundaries). */
function rangeBounds(range: LogRange, now: number): { lo: number | null; hi: number | null } {
  const d = new Date(now);
  const startOfDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const today = startOfDay(d);
  switch (range) {
    case 'all':
      return { lo: null, hi: null };
    case 'hour':
      return { lo: now - 3600_000, hi: null };
    case '24h':
      return { lo: now - 24 * 3600_000, hi: null };
    case 'today':
      return { lo: today, hi: null };
    case 'yesterday':
      return { lo: startOfDay(new Date(today - 1)), hi: today };
    case '7d':
      return { lo: now - 7 * 24 * 3600_000, hi: null };
  }
}

/**
 * The events the Log screen shows: the newest-first ring narrowed by the active
 * severity (`errorsOnly`) and date (`logRange`) filters. Pure — the renderer and
 * the input clamp both call it so the cursor and the window never disagree.
 */
export function filteredEvents(data: DataProvider, view: ViewState, now: number = Date.now()): LogEvent[] {
  let list = data.events(); // newest-first
  if (view.errorsOnly) list = list.filter((e) => e.severity === 'error');
  const { lo, hi } = rangeBounds(view.logRange, now);
  if (lo != null) list = list.filter((e) => e.ts >= lo);
  if (hi != null) list = list.filter((e) => e.ts < hi);
  return list;
}

/** Clamp the log cursor into the current filtered list (0 when empty). */
export function clampLogCursor(view: ViewState, count: number): void {
  if (count <= 0) {
    view.logCursor = 0;
    view.logScroll = 0;
    return;
  }
  if (view.logCursor < 0) view.logCursor = 0;
  if (view.logCursor > count - 1) view.logCursor = count - 1;
}

/**
 * Re-derive `logCursor` from the anchored event's `seq` so the highlighted event
 * stays put as new events prepend the (newest-first) ring. `logAnchorSeq === null`
 * follows the newest (cursor pinned to the top). If the anchored event has
 * scrolled out of the filtered list (evicted / filtered away), hold the index
 * and re-anchor to whatever is there now. Call before reading `logCursor`.
 */
export function syncLogCursor(view: ViewState, list: LogEvent[]): void {
  const len = list.length;
  if (len === 0) {
    view.logCursor = 0;
    view.logScroll = 0;
    view.logAnchorSeq = null;
    return;
  }
  if (view.logAnchorSeq == null) {
    view.logCursor = 0; // follow the newest
    return;
  }
  const idx = list.findIndex((e) => e.seq === view.logAnchorSeq);
  if (idx >= 0) {
    view.logCursor = idx;
    return;
  }
  view.logCursor = Math.min(Math.max(0, view.logCursor), len - 1);
  view.logAnchorSeq = view.logCursor === 0 ? null : list[view.logCursor].seq;
}

/** Move the cursor to an absolute index and re-anchor (index 0 = follow newest). */
function setLogCursor(view: ViewState, list: LogEvent[], idx: number): KeyResult {
  const len = list.length;
  if (len === 0) return NOOP;
  const next = Math.max(0, Math.min(len - 1, idx));
  const changed = next !== view.logCursor;
  view.logCursor = next;
  view.logAnchorSeq = next === 0 ? null : list[next].seq;
  return changed ? REDRAW : NOOP;
}

/** Point the node-selection cursor at a specific node (clearing the filter so
 *  it is guaranteed visible) — used to jump from a log event to its device. */
function selectNodeById(view: ViewState, data: DataProvider, nodeId: number): void {
  view.filter = '';
  const idx = visibleNodes(data, view).findIndex((n) => n.nodeId === nodeId);
  view.selected = idx >= 0 ? idx : 0;
}

/**
 * Handle a key while the Log screen is active. Returns a KeyResult when it owns
 * the key, or `null` to let the generic handler run (screen switch, q, Esc…).
 */
function applyLogKey(view: ViewState, ev: InputEvent, data: DataProvider): KeyResult | null {
  const list = filteredEvents(data, view);
  syncLogCursor(view, list); // resolve the anchor → a valid cursor first

  if (ev.type === 'arrow') {
    if (ev.dir === 'down') return setLogCursor(view, list, view.logCursor + 1);
    if (ev.dir === 'up') return setLogCursor(view, list, view.logCursor - 1);
    return NOOP; // left/right reserved on the log
  }
  if (ev.type === 'enter') {
    // Jump to the selected event's associated device (its Node Detail screen).
    const sel = list[view.logCursor];
    if (sel && sel.nodeId != null && data.nodeById(sel.nodeId)) {
      selectNodeById(view, data, sel.nodeId);
      view.screen = 'detail';
      return REDRAW;
    }
    return NOOP;
  }
  if (ev.type !== 'char') return null; // escape/tab/ctrlc → generic

  const page = Math.max(1, logLayout(view.rows).listRows - 1);
  switch (ev.ch) {
    case 'j':
      return setLogCursor(view, list, view.logCursor + 1);
    case 'k':
      return setLogCursor(view, list, view.logCursor - 1);
    case ' ': // space — page toward older
      return setLogCursor(view, list, view.logCursor + page);
    case 'b': // page toward newer
      return setLogCursor(view, list, view.logCursor - page);
    case 'g': // jump to newest + resume follow-tail
      return setLogCursor(view, list, 0);
    case 'G': // jump to oldest
      return setLogCursor(view, list, list.length - 1);
    case 'o': // severity filter (errors only) — reset to newest + follow
      view.errorsOnly = !view.errorsOnly;
      view.logCursor = 0;
      view.logScroll = 0;
      view.logAnchorSeq = null;
      return REDRAW;
    case 'd': { // cycle the date-range filter — reset to newest + follow
      const i = LOG_RANGE_ORDER.indexOf(view.logRange);
      view.logRange = LOG_RANGE_ORDER[(i + 1) % LOG_RANGE_ORDER.length];
      view.logCursor = 0;
      view.logScroll = 0;
      view.logAnchorSeq = null;
      return REDRAW;
    }
    case '/': // node-substring filter is meaningless here — swallow it
      return NOOP;
    default:
      return null; // 1-6 / q / c / e / t … → generic handler
  }
}

/**
 * Apply one input event to the session view-state.
 *
 * @param view  the per-session ViewState (mutated in place)
 * @param ev    the parsed, transport-agnostic input event
 * @param data  the cached data provider (for selection clamping)
 * @param log   sink for the read-only action notices (defaults to console)
 */
export function applyKey(
  view: ViewState,
  ev: InputEvent,
  data: DataProvider,
  log: (msg: string) => void = (m) => console.log(m),
): KeyResult {
  // The Log screen owns navigation (its own cursor/filters). It only handles the
  // keys that mean something there; anything else falls through to the generic
  // handler below (screen switch 1-6, q/Esc back, c/t, ctrl-c…).
  if (view.screen === 'log') {
    const r = applyLogKey(view, ev, data);
    if (r) return r;
  }

  // Escape → dismiss any overlay back to the Overview home.
  if (ev.type === 'escape') {
    if (view.screen !== 'overview') {
      view.screen = 'overview';
      return REDRAW;
    }
    return NOOP;
  }

  // Enter → drill into the Node Detail overlay for the selected node.
  if (ev.type === 'enter') {
    if (visibleNodes(data, view).length === 0) return NOOP;
    if (view.screen !== 'detail') {
      view.screen = 'detail';
      return REDRAW;
    }
    return NOOP;
  }

  // Arrow keys move the selection cursor (up/down); left/right are reserved.
  if (ev.type === 'arrow') {
    if (ev.dir === 'down') return moveSelection(view, data, +1);
    if (ev.dir === 'up') return moveSelection(view, data, -1);
    return NOOP;
  }

  // Tab / ctrl-c are handled by the session (mode/quit); ignore here.
  if (ev.type === 'tab' || ev.type === 'ctrlc') return NOOP;

  // Remaining case: a printable character.
  const ch = ev.ch;

  // Number keys 1..6 select a screen.
  if (ch >= '1' && ch <= '9') {
    const idx = Number(ch) - 1;
    if (idx < SCREENS.length) {
      if (view.screen !== SCREENS[idx]) {
        view.screen = SCREENS[idx];
        return REDRAW;
      }
      return NOOP;
    }
    return NOOP;
  }

  switch (ch) {
    case 'j':
      return moveSelection(view, data, +1);
    case 'k':
      return moveSelection(view, data, -1);
    case 'q':
    case 'Q':
      // On an overlay, back out to the Overview; on the Overview home, quit
      // (matches the "q quit" legend + docs; Ctrl-C also disconnects anywhere).
      if (view.screen !== 'overview') {
        view.screen = 'overview';
        return REDRAW;
      }
      return { redraw: false, quit: true };
    case 'c':
      // Jump to the Controller & Network screen.
      if (view.screen !== 'controller') {
        view.screen = 'controller';
        return REDRAW;
      }
      return NOOP;
    case 'e':
      // Jump to the Event & Command Log screen.
      if (view.screen !== 'log') {
        view.screen = 'log';
        return REDRAW;
      }
      return NOOP;
    case 'y':
      // Jump to the Remedy (engine symptoms) screen.
      if (view.screen !== 'remedy') {
        view.screen = 'remedy';
        return REDRAW;
      }
      return NOOP;
    case '/':
      // Hand control to the session's filter-capture loop.
      return { redraw: true, filter: 'start' };
    case 's': {
      const i = SORT_ORDER.indexOf(view.sortKey);
      view.sortKey = SORT_ORDER[(i + 1) % SORT_ORDER.length];
      view.selected = 0;
      view.scroll = 0;
      return REDRAW;
    }
    case 't':
      view.signalDisplay = view.signalDisplay === 'margin' ? 'dbm' : 'margin';
      return REDRAW;
    // ── Log-screen errors-only filter (the stream always auto-follows). ──
    case 'o':
      view.errorsOnly = !view.errorsOnly;
      return REDRAW;
    // ── mutating actions — handled by the session ONLY when write_actions is
    //    enabled (it intercepts these before applyKey). If we reach here, write
    //    actions are off, so they are recognized but no-op with a hint. ────────
    case 'p':
    case 'i':
    case 'h':
    case 'R':
    case 'x':
      log(`'${ch}' is a mutating action — enable "write_actions_enabled" in the add-on config to unlock`);
      return NOOP;
    default:
      return NOOP;
  }
}

function moveSelection(view: ViewState, data: DataProvider, delta: number): KeyResult {
  const len = visibleNodes(data, view).length;
  if (len === 0) return NOOP;
  const next = Math.max(0, Math.min(len - 1, view.selected + delta));
  if (next === view.selected) return NOOP;
  view.selected = next;
  return REDRAW;
}
