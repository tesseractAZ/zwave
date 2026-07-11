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
import { renderLogin } from './screens/login';
import type { AuthPolicy } from '../auth/loginPolicy';
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
  /** Login policy. When absent/disabled, the session opens straight into the TUI. */
  auth?: AuthPolicy;
  /** Connection is pre-authenticated (e.g. via HA Ingress) — skips the login
   *  gate unless the policy sets `requireOnIngress`. Defaults to false. */
  trusted?: boolean;
  /** Peer IP — used in auth log lines AND as the throttle key. */
  peer?: string;
  /** Transport callback to drop the connection (used on login lockout). */
  onClose?: () => void;
}

/** Session lifecycle mode: the login gate, the live TUI, or a terminal deny. */
type SessionMode = 'login' | 'tui' | 'denied';

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

  /* ── auth / login gate ─────────────────────────────────────────────────── */
  private readonly auth?: AuthPolicy;
  private readonly peer: string;
  /** True when THIS connection must pass the login gate (drives idle re-lock). */
  private readonly authRequired: boolean;
  private mode: SessionMode = 'tui';
  private loginStage: 'user' | 'pass' = 'user';
  private loginUser = '';
  private loginPass = '';
  private loginAttempts = 0;
  private loginError = '';
  private deniedMsg = '';
  /** True while an async credential check is in flight (input is ignored). */
  private verifying = false;
  /** Transport callback to drop the connection (e.g. on login lockout). */
  private readonly onClose?: () => void;
  /** Epoch ms of the last keystroke — drives the idle re-lock. */
  private lastActivity = Date.now();

  constructor(opts: TuiSessionOptions) {
    this.write = opts.write;
    this.data = opts.data;
    this.log = opts.log ?? ((m) => console.log(m));
    this.auth = opts.auth;
    this.peer = opts.peer ?? '?';
    this.onClose = opts.onClose;
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

    // Decide whether this connection faces the login gate. Trusted (ingress)
    // connections skip it unless the policy explicitly requires it there.
    const trusted = opts.trusted ?? false;
    this.authRequired = !!this.auth?.enabled && (!trusted || !!this.auth?.requireOnIngress);
    if (this.authRequired) {
      if (!this.auth!.hasUsers()) {
        // Misconfiguration: auth on, but no users. Fail CLOSED for untrusted
        // access rather than silently allowing it.
        this.mode = 'denied';
        this.deniedMsg = 'No users configured — set the "users" option in the add-on config.';
        this.log(`auth: connection from ${this.peer} denied — auth enabled but no users configured`);
      } else {
        this.mode = 'login';
      }
    }
  }

  /** Reset the login capture buffers back to the username field. */
  private resetLogin(): void {
    this.loginStage = 'user';
    this.loginUser = '';
    this.loginPass = '';
  }

  /**
   * Login-mode keystroke handling. Returns true when the frame should redraw.
   * The password submit kicks off an ASYNC verify (`submitPassword`) so the
   * scrypt work never blocks the event loop; that path redraws (and, on
   * lockout, closes) through its own callbacks.
   */
  private handleLoginKey(ev: InputEvent): boolean {
    // Ignore all input while an async credential check is in flight.
    if (this.verifying) return false;

    if (ev.type === 'enter') {
      if (this.loginStage === 'user') {
        if (this.loginUser.length > 0) { this.loginStage = 'pass'; this.loginError = ''; return true; }
        return false;
      }
      void this.submitPassword();
      return true;
    }
    if (ev.type === 'escape') {
      this.resetLogin();
      this.loginError = '';
      return true;
    }
    if (ev.type === 'char') {
      const ch = ev.ch;
      if (ch === '\x7f' || ch === '\b') {
        if (this.loginStage === 'user') this.loginUser = this.loginUser.slice(0, -1);
        else this.loginPass = this.loginPass.slice(0, -1);
        return true;
      }
      if (ch >= ' ' && ch < '\x7f') {
        if (this.loginStage === 'user') {
          if (this.loginUser.length < 64) this.loginUser += ch;
        } else if (this.loginPass.length < 128) {
          this.loginPass += ch;
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Verify the submitted credentials. Async (scrypt off the event loop). A
   * shared per-peer throttle enforces escalating backoff across reconnects, so
   * dropping the socket and reconnecting does not reset the brute-force budget.
   * Redraws through `draw()`; drops the connection through `onClose` on lockout.
   */
  private async submitPassword(): Promise<void> {
    if (this.verifying || !this.auth) return;

    // Refuse (without spending a scrypt) while this peer is in backoff.
    const blockedMs = this.auth.blockedMsFor(this.peer);
    if (blockedMs > 0) {
      this.loginError = `Too many attempts — wait ${Math.ceil(blockedMs / 1000)}s.`;
      this.resetLogin();
      this.draw();
      return;
    }

    const user = this.loginUser;
    const pass = this.loginPass;
    this.verifying = true;
    this.loginError = '';
    this.draw(); // show "Checking…"

    let ok = false;
    try {
      ok = await this.auth.verify(user, pass);
    } catch {
      ok = false;
    }
    this.verifying = false;

    if (ok) {
      this.auth.registerSuccess(this.peer);
      this.log(`auth: login OK for "${user}" from ${this.peer}`);
      this.mode = 'tui';
      this.resetLogin();
      this.loginError = '';
      this.lastFrameHash = ''; // force a full first paint of the TUI
      this.draw();
      return;
    }

    this.auth.registerFailure(this.peer);
    this.loginAttempts += 1;
    this.log(`auth: login FAILED for "${user}" from ${this.peer} (${this.loginAttempts}/${this.auth.maxAttempts})`);
    this.resetLogin();
    if (this.loginAttempts >= this.auth.maxAttempts) {
      this.loginError = 'Too many failed attempts.';
      this.draw();
      this.onClose?.();
      return;
    }
    this.loginError = 'Invalid username or password.';
    this.draw();
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
      // ctrl-c is the universal disconnect — even inside login or filter capture.
      if (ev.type === 'ctrlc') return { quit: true };

      // Terminal deny state: the message is shown, any key disconnects.
      if (this.mode === 'denied') return { quit: true };

      this.lastActivity = Date.now();

      // Login gate — nothing reaches the TUI until credentials pass. The
      // password submit runs async; lockout drops the socket via onClose.
      if (this.mode === 'login') {
        if (this.handleLoginKey(ev)) dirty = true;
        continue;
      }

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
    if (this.mode === 'login' || this.mode === 'denied') {
      return renderLogin({
        cols: this.view.cols,
        rows: this.view.rows,
        title: 'Z-Wave TUI',
        stage: this.loginStage,
        username: this.loginUser,
        passwordLen: this.loginPass.length,
        error: this.loginError,
        denied: this.mode === 'denied',
        deniedMsg: this.deniedMsg,
        checking: this.verifying,
      });
    }
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
    // Idle re-lock: an authenticated session with no keystrokes for the
    // configured window drops back to the login gate. Only applies when this
    // connection actually passed the gate (trusted/ingress sessions are exempt).
    if (
      this.mode === 'tui' &&
      this.authRequired &&
      this.auth &&
      this.auth.idleLockMs > 0 &&
      Date.now() - this.lastActivity > this.auth.idleLockMs
    ) {
      this.mode = 'login';
      this.resetLogin();
      this.loginError = 'Session locked (idle) — please log in again.';
      this.lastFrameHash = '';
    }

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
