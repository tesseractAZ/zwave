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

import type { DataProvider, NodeSnapshot, ViewState } from '../types';
import { SCREENS } from '../types';

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
    // ── log-screen toggles (harmless everywhere; wired now, surfaced in v0.2) ──
    case 'F':
      view.followTail = !view.followTail;
      return REDRAW;
    case 'o':
      view.errorsOnly = !view.errorsOnly;
      return REDRAW;
    // ── mutating actions — READ-ONLY in v0.1: recognized, but no-op ──────────
    case 'p':
    case 'i':
    case 'h':
    case 'R':
    case 'x':
      log(`read-only in v0.1: '${ch}' action disabled (enable write_actions to unlock)`);
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
