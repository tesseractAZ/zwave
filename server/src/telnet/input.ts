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
import { sortedSymptoms, symptomKey } from './screens/remedy';
import type { Symptom } from '../zwave/symptoms';

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
      view.detailScroll = 0; // start the dossier at the top
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
    case 'o':
    case 'O': // severity filter (errors only) — reset to newest + follow
      view.errorsOnly = !view.errorsOnly;
      view.logCursor = 0;
      view.logScroll = 0;
      view.logAnchorSeq = null;
      return REDRAW;
    case 'd':
    case 'D': { // cycle the date-range filter — reset to newest + follow
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
 * Handle a key while the Node Detail screen is active. Owns the dossier scroll
 * (`↑`/`↓`/`j`/`k`, page `space`/`b`, `g`/`G`) and node stepping (`<`/`>` and
 * their unshifted `,`/`.` aliases). Returns a KeyResult when it owns the key, or
 * `null` to let the generic handler run (screen switch, q/Esc, actions…).
 */
/**
 * Handle a key on the TOPOLOGY screen: scroll the route tree. The renderer
 * clamps `topologyScroll` and writes the real value back, so `G` can simply
 * ask for "the end" without this handler knowing the tree's length.
 */
function applyTopologyKey(view: ViewState, ev: InputEvent): KeyResult | null {
  const page = Math.max(1, view.rows - 6);
  const move = (delta: number): KeyResult => {
    const cur = view.topologyScroll ?? 0;
    const next = Math.max(0, cur + delta);
    if (next === cur) return NOOP;
    view.topologyScroll = next;
    return REDRAW;
  };
  if (ev.type === 'arrow') {
    if (ev.dir === 'down') return move(+1);
    if (ev.dir === 'up') return move(-1);
    return NOOP;
  }
  if (ev.type !== 'char') return null;
  switch (ev.ch) {
    case 'j': return move(+1);
    case 'k': return move(-1);
    case ' ': return move(page);
    case 'b': return move(-page);
    case 'g':
      if ((view.topologyScroll ?? 0) === 0) return NOOP;
      view.topologyScroll = 0;
      return REDRAW;
    case 'G':
      view.topologyScroll = Number.MAX_SAFE_INTEGER;
      return REDRAW;
    case '/': return NOOP; // no filter prompt here — swallow it
    default: return null;
  }
}

/**
 * Clamp the REMEDY cursor into the current symptom list.
 *
 * Symptoms appear and disappear between engine polls, so a stored index can
 * outlive the card it pointed at — and on REMEDY that index selects the ACTION
 * TARGET, so a stale one would aim a command at the wrong node.
 */
export function syncRemedyCursor(view: ViewState, list: readonly Symptom[]): void {
  if (list.length === 0) {
    view.remedyCursor = 0;
    view.remedyAnchorId = null;
    return;
  }
  // ANCHOR WINS. The engine re-sorts this list on every poll, so re-deriving
  // the cursor from a stored index alone would slide it onto whatever now sits
  // in that slot — and on this screen the cursor aims `p`, which runs with no
  // CONFIRM box. Follow the identity; fall back to the clamped index only when
  // the symptom it named has resolved and left the list.
  if (view.remedyAnchorId != null) {
    const at = list.findIndex((x) => symptomKey(x) === view.remedyAnchorId);
    if (at >= 0) {
      view.remedyCursor = at;
      return;
    }
    view.remedyAnchorId = null; // it is gone — fall through to the index
  }
  view.remedyCursor = Math.max(0, Math.min(view.remedyCursor ?? 0, list.length - 1));
  // ADOPT on first resolve. Without this the opening frame has no anchor, so a
  // re-sort before the operator's first keypress would still slide the target —
  // which is the whole defect. What you see on the first frame is what `p` acts
  // on, until you deliberately move.
  const at = list[view.remedyCursor];
  if (at) view.remedyAnchorId = symptomKey(at);
}

/**
 * Handle a key on the REMEDY screen: move the symptom cursor. Everything else
 * (screen switch, q/Esc, the action shortcuts) falls through to the generic
 * handler, which now targets the SELECTED symptom's node.
 */
function applyRemedyKey(view: ViewState, ev: InputEvent, data: DataProvider): KeyResult | null {
  const list = sortedSymptoms(data.symptoms());
  const count = list.length;
  const move = (delta: number): KeyResult => {
    if (count === 0) return NOOP;
    const next = Math.max(0, Math.min((view.remedyCursor ?? 0) + delta, count - 1));
    if (next === (view.remedyCursor ?? 0)) return NOOP;
    view.remedyCursor = next;
    // Re-anchor on every deliberate move: the operator has just chosen THIS
    // card, so that identity is what the cursor should follow from here.
    view.remedyAnchorId = list[next] ? symptomKey(list[next]) : null;
    return REDRAW;
  };
  if (ev.type === 'arrow') {
    if (ev.dir === 'down') return move(+1);
    if (ev.dir === 'up') return move(-1);
    return NOOP;
  }
  if (ev.type !== 'char') return null;
  switch (ev.ch) {
    case 'j': return move(+1);
    case 'k': return move(-1);
    case 'g': return move(-count);
    case 'G': return move(count);
    case '/': return NOOP; // no filter prompt here — swallow it
    default: return null;
  }
}

function applyDetailKey(view: ViewState, ev: InputEvent, data: DataProvider): KeyResult | null {
  const page = Math.max(1, view.rows - 4); // ≈ one content-height page

  if (ev.type === 'arrow') {
    if (ev.dir === 'down') return scrollDetail(view, +1);
    if (ev.dir === 'up') return scrollDetail(view, -1);
    return NOOP; // left/right reserved on Detail
  }
  if (ev.type !== 'char') return null; // enter/escape/tab/ctrlc → generic

  switch (ev.ch) {
    case 'j':
      return scrollDetail(view, +1);
    case 'k':
      return scrollDetail(view, -1);
    case ' ': // page down
      return scrollDetail(view, page);
    case 'b': // page up
      return scrollDetail(view, -page);
    case 'g': // top
      if ((view.detailScroll ?? 0) === 0) return NOOP;
      view.detailScroll = 0;
      return REDRAW;
    case 'G': // bottom — the renderer clamps this to the real max
      view.detailScroll = Number.MAX_SAFE_INTEGER;
      return REDRAW;
    case '<':
    case ',':
      return browseNode(view, data, -1);
    case '>':
    case '.':
      return browseNode(view, data, +1);
    case '/': // no filter prompt on the dossier — swallow it (Log's precedent)
      return NOOP;
    default:
      return null; // a/A, 1-9, q, c, e, y, f, t, p/i/h/R/x, … → generic
  }
}

/** Move the dossier scroll offset by `delta` rows (clamped ≥ 0; the renderer
 *  clamps the upper bound and writes back the real value). */
function scrollDetail(view: ViewState, delta: number): KeyResult {
  const cur = view.detailScroll ?? 0;
  const next = Math.max(0, cur + delta);
  if (next === cur) return NOOP;
  view.detailScroll = next;
  return REDRAW;
}

/** Step the node cursor by `delta` and reset the dossier to the top of the new
 *  node (so `<`/`>` browsing always lands you at the header). */
function browseNode(view: ViewState, data: DataProvider, delta: number): KeyResult {
  const len = visibleNodes(data, view).length;
  if (len === 0) return NOOP;
  const next = Math.max(0, Math.min(len - 1, view.selected + delta));
  if (next === view.selected) return NOOP;
  view.selected = next;
  view.detailScroll = 0;
  return REDRAW;
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

  // The Detail screen owns vertical scroll (its dossier is taller than the
  // frame) + node stepping. It claims arrows/j/k/</>; everything else (screen
  // switch, q/Esc, a, …) falls through to the generic handler below.
  if (view.screen === 'detail') {
    const r = applyDetailKey(view, ev, data);
    if (r) return r;
  }

  // TOPOLOGY owns its route-tree scroll (the tree is taller than the frame on
  // any real mesh). Everything it does not claim falls through.
  if (view.screen === 'topology') {
    const r = applyTopologyKey(view, ev);
    if (r) return r;
  }

  // REMEDY owns a symptom cursor, because that cursor is what the action keys
  // target on this screen. Everything it does not claim falls through.
  if (view.screen === 'remedy') {
    const r = applyRemedyKey(view, ev, data);
    if (r) return r;
  }

  // Escape → dismiss any overlay back to the Overview home.
  if (ev.type === 'escape') {
    if (view.screen !== 'overview') {
      view.screen = 'overview';
      return REDRAW;
    }
    // On the Overview home, Esc CLEARS a committed filter. Esc previously only
    // cleared one during the `/` capture, so once the operator pressed Enter the
    // key went inert — and the empty-roster card advertises `[Esc] CLEAR`, which
    // made that card's own escape route a lie. (The card is the one place this
    // strands you: with every node filtered out there is nothing to select.)
    if (view.filter) {
      view.filter = '';
      view.selected = 0;
      view.scroll = 0;
      return REDRAW;
    }
    return NOOP;
  }

  // Enter → drill into the Node Detail overlay for the selected node.
  if (ev.type === 'enter') {
    if (visibleNodes(data, view).length === 0) return NOOP;
    if (view.screen !== 'detail') {
      view.screen = 'detail';
      view.detailScroll = 0; // start the dossier at the top
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
        // Entering Detail via its screen number starts the dossier at the top,
        // matching the Enter / log-jump / node-step entry paths (a stale offset
        // from a previous, taller node would otherwise open mid-dossier).
        if (SCREENS[idx] === 'detail') view.detailScroll = 0;
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
    case 'f':
      // Jump to the interFerence (RF environment) screen. ('i' is the
      // re-interview action shortcut, so interference uses 'f' + the 8 key.)
      if (view.screen !== 'interference') {
        view.screen = 'interference';
        return REDRAW;
      }
      return NOOP;
    case '/':
      // Filter capture is only ever VISIBLE on the Overview — that screen owns
      // the prompt, the live echo and the [/] FILTER keycap. Starting a capture
      // from a screen with no prompt swallowed every subsequent keystroke with
      // nothing on the frame to say so, including the [Q] the operator was
      // pressing to escape. Elsewhere it is a no-op (the Log's precedent).
      //
      // The SCREEN is not sufficient: while the roster is still loading the
      // Overview renders a centred "Connecting…" card and never builds the
      // title rule that shows the prompt, so a capture there is just as
      // invisible — and that card's only keycap is the [Q] it would swallow.
      if (view.screen !== 'overview' || !data.ready()) return NOOP;
      return { redraw: true, filter: 'start' };
    // `s`/`S` and `t`/`T` are advertised as UPPERCASE keycaps ([S] SORT,
    // [T] UNITS), so both cases must work — binding only the lowercase made
    // the printed keycap a lie for anyone who took it literally.
    case 's':
    case 'S': {
      const i = SORT_ORDER.indexOf(view.sortKey);
      view.sortKey = SORT_ORDER[(i + 1) % SORT_ORDER.length];
      view.selected = 0;
      view.scroll = 0;
      return REDRAW;
    }
    case 't':
    case 'T':
      view.signalDisplay = view.signalDisplay === 'margin' ? 'dbm' : 'margin';
      return REDRAW;
    // ── Log-screen errors-only filter (the stream always auto-follows). ──
    case 'o':
    case 'O':
      // The Log owns this key (applyLogKey, which also resets the cursor and
      // anchor). Reaching here means we are NOT on the Log, and toggling that
      // screen's filter from another one silently hid events the operator would
      // only discover on arriving there.
      return NOOP;
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
