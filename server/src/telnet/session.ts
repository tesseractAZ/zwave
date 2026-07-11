/**
 * Transport-agnostic Z-Wave TUI session driver.
 *
 * Adapted from ecoflow-panel's `telnet/session.ts`. The anti-flicker draw loop
 * (frame-hash skip, BEGIN/END_SYNC wrapping, draw serialization) and the resize
 * clamp are kept byte-for-byte; only the screen registry + render dispatch are
 * swapped to drive OUR screens: it owns a per-session `ViewState`, dispatches
 * keys through `applyKey` (from `./input`), and renders with `renderScreen`
 * (from `./screens`) against the cached `DataProvider`.
 *
 * The driver knows nothing about sockets. It takes:
 *   • a `write(data: string)` sink (the transport pipes this to the wire);
 *   • a `data` provider — the shared, timer-refreshed `DataProvider`; and
 *   • an initial size.
 *
 * It owns: the session view-state (screen/selection/filter/sort), the
 * frame-hash anti-flicker, the draw-serialization (no overlapping writes), the
 * key → state-transition logic, and the `/`-filter capture mode. The transports
 * own: byte parsing, connection lifecycle, and any protocol negotiation.
 */

import type { DataProvider, ScreenCtx, ViewState } from '../types';
import { applyKey, clampSelection, visibleNodes } from './input';
import type { InputEvent } from './input';
import { renderScreen } from './screens/index';
import {
  HIDE_CURSOR, CURSOR_HOME, CLEAR_EOL, CLEAR_BELOW,
  BEGIN_SYNC, END_SYNC,
} from './ansi';

/**
 * A parsed terminal event as the session consumes it: a shared `InputEvent`
 * (the key), plus an out-of-band `resize` the transports deliver from telnet
 * NAWS / the xterm JSON control message (the shared `InputEvent` union
 * deliberately has no resize member).
 */
export type SessionEvent =
  | InputEvent
  | { type: 'resize'; w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface TuiSessionOptions {
  /** Transport sink — the driver writes ANSI frames here. */
  write: (data: string) => void;
  /** Live, shared, timer-refreshed data accessors. */
  data: DataProvider;
  /** Initial terminal size. */
  width?: number;
  height?: number;
  /** Initial signal-unit default (from the add-on config; toggled with `t`). */
  signalDisplay?: 'margin' | 'dbm';
  /** Sink for read-only action notices. Defaults to console. */
  log?: (msg: string) => void;
}

/**
 * One TUI session: the render/input state machine. Construct one per
 * connection; drive it with `feed()`, `resize()`, and the 1 Hz `draw()` tick.
 */
export class TuiSession {
  private readonly write: (data: string) => void;
  private readonly data: DataProvider;
  private readonly log: (msg: string) => void;

  /** The entire per-session view-state the screens + input map operate on. */
  private readonly view: ViewState;

  /** True while the `/` filter-capture mode is active (session-owned, not in
   *  ViewState): printable keys build `view.filter`, Enter commits, Esc cancels. */
  private filtering = false;

  /** true while a frame is being written; prevents overlapping draws from
   *  interleaving (e.g. a resize event triggering a mid-frame redraw on top of
   *  the periodic 1 s redraw). Cleared as soon as write returns. */
  private drawing = false;
  /** a redraw was requested while drawing was in flight; honor it immediately
   *  after the current frame finishes so input still feels instant. */
  private drawPending = false;
  /** hash of the last successfully-written frame body. When the next render
   *  produces the same body, we skip the write entirely (zero flicker). */
  private lastFrameHash = '';

  constructor(opts: TuiSessionOptions) {
    this.write = opts.write;
    this.data = opts.data;
    this.log = opts.log ?? ((m) => console.log(m));
    this.view = {
      screen: 'overview',
      cols: clamp(opts.width ?? 80, 60, 200),
      rows: clamp(opts.height ?? 24, 16, 80),
      selected: 0,
      scroll: 0,
      filter: '',
      sortKey: 'health',
      signalDisplay: opts.signalDisplay ?? 'margin',
      followTail: true,
      errorsOnly: false,
    };
  }

  /**
   * Set the terminal size. Clamps to the supported range. Returns true if the
   * size changed (caller should redraw).
   */
  resize(w: number, h: number): boolean {
    if (!(w > 0 && h > 0)) return false;
    const nw = clamp(w, 60, 200);
    const nh = clamp(h, 16, 80);
    if (nw === this.view.cols && nh === this.view.rows) return false;
    this.view.cols = nw;
    this.view.rows = nh;
    return true;
  }

  /**
   * Apply a batch of parsed events. Returns one of:
   *   • { redraw: true }   — state changed, the transport should `draw()`;
   *   • { quit: true }     — the user asked to disconnect (ctrl-c);
   *   • { }                — nothing to do.
   * Resize events are applied here too (the telnet transport delivers window
   * size via NAWS; the WS transport via a synthetic 'resize' event).
   */
  feed(events: SessionEvent[]): { redraw?: boolean; quit?: boolean } {
    let dirty = false;
    for (const ev of events) {
      if (ev.type === 'resize') {
        if (this.resize(ev.w, ev.h)) dirty = true;
        continue;
      }
      // ctrl-c is the universal disconnect — even inside filter capture.
      if (ev.type === 'ctrlc') return { quit: true };

      if (this.filtering) {
        if (this.handleFilterKey(ev)) dirty = true;
        continue;
      }

      const r = applyKey(this.view, ev, this.data, this.log);
      if (r.filter === 'start') {
        this.filtering = true;
        dirty = true;
      }
      if (r.redraw) dirty = true;
    }
    return dirty ? { redraw: true } : {};
  }

  /**
   * Filter-capture keystroke handling. Printable chars append to the live
   * substring filter; Backspace/DEL delete; Enter commits; Esc cancels + clears.
   * Any change resets the selection to the top of the (now re-filtered) list.
   */
  private handleFilterKey(ev: InputEvent): boolean {
    if (ev.type === 'enter') {
      this.filtering = false;
      clampSelection(this.view, this.data);
      return true;
    }
    if (ev.type === 'escape') {
      this.filtering = false;
      this.view.filter = '';
      this.view.selected = 0;
      return true;
    }
    if (ev.type === 'char') {
      const ch = ev.ch;
      if (ch === '\x7f' || ch === '\b') {
        if (this.view.filter.length === 0) return false;
        this.view.filter = this.view.filter.slice(0, -1);
        this.view.selected = 0;
        return true;
      }
      // Only accept printable characters into the filter buffer.
      if (ch >= ' ' && ch < '\x7f') {
        this.view.filter += ch;
        this.view.selected = 0;
        return true;
      }
      return false;
    }
    // Arrows / tab while capturing — swallowed (stay in filter mode).
    return false;
  }

  /** Build the array of frame lines for the current state. */
  private renderLines(): string[] {
    const vis = visibleNodes(this.data, this.view);
    // Defensive clamp — the roster can shrink between frames (a node drops out
    // of the filter, or leaves the mesh) and leave `selected` past the end.
    if (vis.length === 0) {
      this.view.selected = 0;
    } else if (this.view.selected > vis.length - 1) {
      this.view.selected = vis.length - 1;
    }
    const ctx: ScreenCtx = { view: this.view, data: this.data, visibleNodes: vis };
    return renderScreen(ctx);
  }

  /**
   * Render + write one frame. Serializes against any in-flight write and
   * skips the write when the frame body is byte-identical to the previous one.
   */
  draw(): void {
    // Serialize frames. If a draw is already in flight, mark a pending redraw
    // and bail. The completing frame will run the pending one on its way out.
    if (this.drawing) {
      this.drawPending = true;
      return;
    }
    this.drawing = true;
    this.drawPending = false;
    try {
      const lines = this.renderLines();

      // Build the FRAME BODY (without sync escapes) and hash it.
      //   • CURSOR_HOME at the top, per-line CLEAR_EOL, trailing CLEAR_BELOW
      //     together cover every transition cleanly without a blank-and-repaint.
      //   • If the new body is byte-identical to the previous one, skip the
      //     write entirely.
      let body = HIDE_CURSOR + CURSOR_HOME;
      for (let i = 0; i < lines.length; i++) {
        body += lines[i] + CLEAR_EOL;
        if (i < lines.length - 1) body += '\r\n';
      }
      body += CLEAR_BELOW;

      // Cheap stable 32-bit FNV-1a hash of the body — plenty discriminative
      // for a ~2-4 KB UTF-8 string, and avoids node:crypto on the hot path.
      let hash = 2166136261;
      for (let i = 0; i < body.length; i++) {
        hash ^= body.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      const hashStr = hash.toString(36);
      if (hashStr === this.lastFrameHash) {
        // Identical frame — no write, no terminal work, no flicker.
        return;
      }
      this.lastFrameHash = hashStr;
      // Wrap each frame in synchronized-output escapes so terminals that
      // support mode 2026 buffer all output and flip atomically. Others treat
      // the escapes as no-ops.
      this.write(BEGIN_SYNC + body + END_SYNC);
    } finally {
      this.drawing = false;
      // Honor a pending redraw queued during this frame, on the next tick so
      // we don't grow the call stack on rapid keypress + interval coincidence.
      if (this.drawPending) {
        this.drawPending = false;
        setImmediate(() => this.draw());
      }
    }
  }
}
