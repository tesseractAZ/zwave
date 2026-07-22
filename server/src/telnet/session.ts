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

import type { DataProvider, NodeSnapshot, ScreenCtx, ViewState, ActionRunner, ActionKind, ConfigParam, EntityVerb } from '../types';
import { applyKey, clampSelection, filteredEvents, syncLogCursor, visibleNodes } from './input';
import type { InputEvent } from './input';
import { renderScreen } from './screens/index';
import { renderLogin } from './screens/login';
import { centeredNotice } from './screens/overview';
import { buildMenu, buildEntityRows, buildConfigRows, clampMenuIndex, describeAction, CONFIRM_WORD } from './actionsCatalog';
import type { MenuItem, ActionImpact } from './actionsCatalog';
import { renderActionsMenu, renderTypeConfirm, renderParamEdit } from './screens/actionsMenu';
import { c } from './ansi';
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
  /** Mutating-action runner (v0.3). Present only when write_actions_enabled. */
  actions?: ActionRunner;
}

/** Session lifecycle mode: the login gate, the live TUI, or a terminal deny. */
type SessionMode = 'login' | 'tui' | 'denied';

/** A mutating action awaiting confirmation / in flight. */
interface PendingAction {
  kind: ActionKind;
  nodeId: number | null;
  label: string; // human title, e.g. "Rebuild ALL routes" / "Ping node — #16 Kitchen"
  target: string; // "whole mesh (39 nodes)" | "#16 Kitchen Lights"
  impact: ActionImpact; // drives the confirm colour + wording
  desc: string; // what it does (one line)
  impactNote: string; // the consequence (shown in the confirm box)
  // v0.23 payloads — set for the device-control / config-write kinds only.
  entityId?: string;
  verb?: EntityVerb;
  param?: ConfigParam;
  value?: number;
}

/** The transient config value-picker state (between menu-select and CONFIRM). */
interface ParamEdit {
  nodeId: number;
  param: ConfigParam;
  /** enum options (value+label) when the param is an enum, else null. */
  options: Array<{ value: number; label: string }> | null;
  optionIndex: number; // cursor over enum options
  draft: string; // typed digits for a numeric param
  error: string | null; // validation hint
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

  /* ── action state (v0.3 / v0.9) ─────────────────────────────────────────── */
  private readonly actions?: ActionRunner;
  /** A mutating action awaiting the typed-CONFIRM (null = not confirming). */
  private pendingAction: PendingAction | null = null;
  /** v0.23 config value-picker, shown between menu-select and CONFIRM (null = off). */
  private paramEdit: ParamEdit | null = null;
  /** What the operator has typed so far toward CONFIRM (type-to-arm modal). */
  private confirmBuffer = '';
  /** The confirm was launched from the Actions Menu → reopen it on cancel. */
  private confirmFromMenu = false;
  /** True while an action's WS call is in flight. */
  private actionInFlight = false;
  /** Transient outcome card ("✓/✗ …"), dismissed by the next keypress. */
  private actionNotice: string | null = null;
  /** Label of the action currently in flight (for the "working" card). */
  private actionRunningLabel = '';
  /* ── actions menu (v0.9) ─────────────────────────────────────────────────── */
  /** True while the Actions Menu overlay is open. */
  private menuOpen = false;
  /** Cursor index into the FROZEN menu snapshot. */
  private menuIndex = 0;
  /** The menu is a point-in-time snapshot taken when it opens, so streaming
   *  events / a rebuild flipping mid-menu can't silently move rows or the target
   *  under the cursor. Both are captured in openMenu() and cleared on close. */
  private menuTarget: NodeSnapshot | null = null;
  private menuSnapshot: MenuItem[] = [];
  /** Epoch ms of the last keystroke — drives the idle re-lock. */
  private lastActivity = Date.now();

  constructor(opts: TuiSessionOptions) {
    this.write = opts.write;
    this.data = opts.data;
    this.log = opts.log ?? ((m) => console.log(m));
    this.auth = opts.auth;
    this.peer = opts.peer ?? '?';
    this.onClose = opts.onClose;
    this.actions = opts.actions;
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
      detailScroll: 0,
      logCursor: 0,
      logScroll: 0,
      logRange: 'all',
      logAnchorSeq: null,
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
    // Drop any in-progress `/` filter capture so keys typed right after an idle
    // re-lock aren't silently swallowed into the node filter once back in the TUI.
    this.filtering = false;
    // SECURITY: also abandon any open menu / armed type-CONFIRM. This runs on the
    // idle re-lock AND on a fresh login, so a half-armed destructive action can
    // NEVER survive the authentication boundary — a re-authenticated operator
    // must re-open the menu and re-type CONFIRM from scratch.
    this.resetActionState();
  }

  /** Abandon every action-overlay sub-state (menu, armed confirm, notice).
   *  actionInFlight is left alone: an already-dispatched WS command can't be
   *  recalled, and its outcome card is simply hidden behind the login screen. */
  private resetActionState(): void {
    this.pendingAction = null;
    this.paramEdit = null;
    this.confirmBuffer = '';
    this.confirmFromMenu = false;
    this.menuOpen = false;
    this.menuTarget = null;
    this.menuSnapshot = [];
    this.actionNotice = null;
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
      this.loginAttempts = 0; // fresh budget for any future idle re-lock
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

      // An action is in flight — swallow keys until it resolves.
      if (this.actionInFlight) continue;

      // The config value-picker (v0.23) owns keys until a value is chosen/cancelled.
      if (this.paramEdit != null) {
        this.handleParamEditKey(ev);
        dirty = true;
        continue;
      }

      // A pending action awaits the typed CONFIRM.
      if (this.pendingAction != null) {
        this.handleTypeConfirmKey(ev);
        dirty = true;
        continue;
      }

      // A finished-action outcome card is up — any key dismisses it.
      if (this.actionNotice != null) {
        this.actionNotice = null;
        dirty = true;
        continue;
      }

      // The Actions Menu overlay owns navigation until it's closed.
      if (this.menuOpen) {
        if (this.handleMenuKey(ev)) dirty = true;
        continue;
      }

      // Open the Actions Menu ('a') — available even in read-only mode, where it
      // is purely informational (you can read every action's impact; execution
      // stays locked behind write_actions_enabled).
      if (this.actions && ev.type === 'char' && (ev.ch === 'a' || ev.ch === 'A')) {
        this.openMenu();
        dirty = true;
        continue;
      }

      // Mutating-action shortcut keys (only when write actions are enabled).
      if (this.actions?.enabled && ev.type === 'char' && this.handleActionKey(ev.ch)) {
        dirty = true;
        continue;
      }

      const r = applyKey(this.view, ev, this.data, this.log);
      if (r.quit) return { quit: true }; // 'q' from the Overview home disconnects
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

  /* ── mutating actions (v0.3) ────────────────────────────────────────────── */

  /** The node an action key targets: the highlighted LOG event's node on the Log
   *  screen (matching Enter), else the Overview selection cursor. Prevents a key
   *  pressed on the Log from silently actuating the invisible node cursor. */
  private actionTargetNode(): NodeSnapshot | undefined {
    if (this.view.screen === 'log') {
      const list = filteredEvents(this.data, this.view);
      syncLogCursor(this.view, list);
      const ev = list[this.view.logCursor];
      return ev?.nodeId != null ? this.data.nodeById(ev.nodeId) : undefined;
    }
    return visibleNodes(this.data, this.view)[this.view.selected];
  }

  /** Route a shortcut action key to a request. Returns true if consumed. */
  private handleActionKey(ch: string): boolean {
    switch (ch) {
      case 'p': return this.beginAction('ping', true); // safe → immediate
      case 'i': return this.beginAction('reInterview', false);
      case 'h': return this.beginAction('healNode', false);
      case 'x': return this.beginAction('removeFailed', false);
      case 'R': return this.beginAction('rebuildAll', false);
      default: return false;
    }
  }

  /**
   * Begin an action by kind — the single entry point for BOTH the menu and the
   * shortcut keys. A `safe` action fired from a shortcut (`immediate`) runs at
   * once; everything else — and everything launched from the menu — arms the
   * type-CONFIRM box. Returns false (a no-op) when a device action has no target.
   */
  private beginAction(kind: ActionKind, immediate: boolean, node?: NodeSnapshot): boolean {
    const d = describeAction(kind);
    if (!d || !this.actions) return false;
    // Device actions use the EXPLICIT node when supplied (the menu passes its
    // frozen target); shortcuts pass none and resolve the live selection.
    const tgt = d.needsNode ? (node ?? this.actionTargetNode()) : undefined;
    if (d.needsNode && !tgt) return false;
    const nodeId = tgt?.nodeId ?? null;
    const label = d.needsNode ? `${d.label} — #${nodeId} ${tgt!.name}` : d.label;
    const target = d.needsNode ? `#${nodeId} ${tgt!.name}` : `whole mesh (${this.data.nodes().length} nodes)`;
    const action: PendingAction = { kind, nodeId, label, target, impact: d.impact, desc: d.desc, impactNote: d.impactNote };
    if (immediate && d.impact === 'safe') {
      void this.executeAction(action);
    } else {
      this.pendingAction = action;
      this.confirmBuffer = '';
    }
    return true;
  }

  /* ── actions menu (v0.9) ─────────────────────────────────────────────────── */

  /** Open the menu, FREEZING the target node + item list at this instant so that
   *  streaming Log events or a rebuild starting/stopping mid-menu can't move a
   *  row (or the target) out from under the cursor before the operator selects. */
  private openMenu(): void {
    this.menuTarget = this.actionTargetNode() ?? null;
    const items = buildMenu({
      hasNode: this.menuTarget != null,
      rebuilding: this.data.controller()?.isRebuildingRoutes ?? false,
    });
    // v0.23: append device-control + config-edit rows for the target node. These
    // are frozen at open time (same snapshot discipline as the catalog rows).
    if (this.menuTarget) {
      const nodeId = this.menuTarget.nodeId;
      this.data.requestConfigParams(nodeId); // warm the cache for next time
      items.push(...buildEntityRows(this.data.entityStates(nodeId)));
      items.push(...buildConfigRows(this.data.configParams(nodeId).params));
    }
    this.menuSnapshot = items;
    this.menuIndex = 0;
    this.menuOpen = true;
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.menuTarget = null;
    this.menuSnapshot = [];
  }

  /** Menu navigation over the FROZEN snapshot. Returns true when it changed. */
  private handleMenuKey(ev: InputEvent): boolean {
    const items = this.menuSnapshot;
    this.menuIndex = clampMenuIndex(this.menuIndex, items.length);
    if (ev.type === 'escape' || (ev.type === 'char' && (ev.ch === 'q' || ev.ch === 'Q' || ev.ch === 'a' || ev.ch === 'A'))) {
      this.closeMenu();
      return true;
    }
    const move = (delta: number): boolean => {
      this.menuIndex = clampMenuIndex(this.menuIndex + delta, items.length);
      return true;
    };
    if (ev.type === 'arrow' && ev.dir === 'down') return move(1);
    if (ev.type === 'arrow' && ev.dir === 'up') return move(-1);
    if (ev.type === 'char' && ev.ch === 'j') return move(1);
    if (ev.type === 'char' && ev.ch === 'k') return move(-1);
    if (ev.type === 'enter') {
      this.selectMenuItem(items[this.menuIndex]);
      return true;
    }
    return false;
  }

  /** Enter on a menu row: arm the type-CONFIRM (against the frozen target), or
   *  explain why it's locked. */
  private selectMenuItem(item: MenuItem | undefined): void {
    if (!item) return;
    if (!this.actions?.enabled) {
      // Read-only: the menu already shows a READ-ONLY badge; make the block
      // explicit so a keypress isn't silently ignored.
      this.closeMenu();
      this.actionNotice = '✗  Read-only — set write_actions_enabled in the add-on config to unlock actions.';
      return;
    }
    if (item.disabled) return; // the reason is shown inline on the row
    const node = this.menuTarget ?? undefined; // frozen at open time
    const p = item.payload;
    if (p.type === 'catalog') {
      this.closeMenu();
      this.confirmFromMenu = true;
      this.beginAction(p.kind, false, node); // menu always requires the typed CONFIRM
    } else if (p.type === 'entity' && node) {
      this.closeMenu();
      this.confirmFromMenu = true;
      this.beginEntityAction(node, item, p.entityId, p.verb);
    } else if (p.type === 'config' && node) {
      this.closeMenu();
      this.confirmFromMenu = true;
      this.openParamEdit(node.nodeId, p.param);
    }
  }

  /** Arm the type-CONFIRM for a device-control action (frozen entity + verb). */
  private beginEntityAction(node: NodeSnapshot, item: MenuItem, entityId: string, verb: EntityVerb): void {
    this.pendingAction = {
      kind: 'controlEntity',
      nodeId: node.nodeId,
      label: `${item.desc.label} — #${node.nodeId} ${node.name}`,
      target: `${entityId} · #${node.nodeId} ${node.name}`,
      impact: item.desc.impact,
      desc: item.desc.desc,
      impactNote: item.desc.impactNote,
      entityId,
      verb,
    };
    this.confirmBuffer = '';
  }

  /* ── config value picker (v0.23) ─────────────────────────────────────────── */

  /** Open the value picker for a writeable config parameter. */
  private openParamEdit(nodeId: number, param: ConfigParam): void {
    const options = param.states
      ? Object.entries(param.states)
          .map(([v, label]) => ({ value: Number(v), label }))
          .filter((o) => Number.isFinite(o.value))
          .sort((a, b) => a.value - b.value)
      : null;
    // Start the enum cursor on the current value when it is one of the options.
    let optionIndex = 0;
    if (options && param.value != null) {
      const at = options.findIndex((o) => o.value === param.value);
      if (at >= 0) optionIndex = at;
    }
    this.paramEdit = { nodeId, param, options, optionIndex, draft: '', error: null };
  }

  /** Keystrokes for the config value picker. Enum → ↑↓ choose; numeric → type
   *  digits (bounded by min/max). Enter proceeds to the CONFIRM box; Esc → menu. */
  private handleParamEditKey(ev: InputEvent): void {
    const pe = this.paramEdit;
    if (!pe) return;
    if (ev.type === 'escape') {
      this.paramEdit = null;
      if (this.confirmFromMenu) {
        this.confirmFromMenu = false;
        this.openMenu();
      }
      return;
    }
    if (pe.options) {
      // Enum mode — move the cursor / pick.
      const move = (d: number) => {
        pe.optionIndex = Math.min(pe.options!.length - 1, Math.max(0, pe.optionIndex + d));
      };
      if (ev.type === 'arrow' && ev.dir === 'down') return move(1);
      if (ev.type === 'arrow' && ev.dir === 'up') return move(-1);
      if (ev.type === 'char' && ev.ch === 'j') return move(1);
      if (ev.type === 'char' && ev.ch === 'k') return move(-1);
      if (ev.type === 'enter') this.commitParamEdit(pe.options[pe.optionIndex].value);
      return;
    }
    // Numeric mode.
    if (ev.type === 'enter') {
      const v = Number(pe.draft);
      if (pe.draft === '' || pe.draft === '-' || !Number.isFinite(v)) {
        pe.error = 'enter a whole number';
        return;
      }
      if (pe.param.min != null && v < pe.param.min) {
        pe.error = `below the minimum (${pe.param.min})`;
        return;
      }
      if (pe.param.max != null && v > pe.param.max) {
        pe.error = `above the maximum (${pe.param.max})`;
        return;
      }
      this.commitParamEdit(Math.trunc(v));
      return;
    }
    if (ev.type === 'char') {
      const ch = ev.ch;
      if (ch === '\x7f' || ch === '\b') {
        pe.draft = pe.draft.slice(0, -1);
        pe.error = null;
        return;
      }
      // Digits, plus a leading minus for signed parameters.
      if ((ch >= '0' && ch <= '9') || (ch === '-' && pe.draft === '')) {
        if (pe.draft.length < 11) pe.draft += ch;
        pe.error = null;
      }
    }
  }

  /** A value was chosen in the picker → arm the type-CONFIRM for the write. */
  private commitParamEdit(value: number): void {
    const pe = this.paramEdit;
    if (!pe) return;
    const node = this.data.nodeById(pe.nodeId);
    const nodeName = node?.name ?? `#${pe.nodeId}`;
    const enumLabel = pe.param.states?.[String(value)];
    const shown = enumLabel ? `${value} (${enumLabel})` : `${value}${pe.param.unit ? ' ' + pe.param.unit : ''}`;
    this.paramEdit = null;
    this.pendingAction = {
      kind: 'setConfigParam',
      nodeId: pe.nodeId,
      label: `Set "${pe.param.label}" = ${shown} — #${pe.nodeId} ${nodeName}`,
      target: `#${pe.nodeId} ${nodeName} · parameter ${pe.param.property}`,
      impact: 'caution',
      desc: `Write "${pe.param.label}" = ${shown}.`,
      impactNote:
        'Writes this Z-Wave configuration parameter to the device. Recoverable — you can set it back, but a wrong value can change how the device behaves.',
      param: pe.param,
      value,
    };
    this.confirmBuffer = '';
    // confirmFromMenu stays true so Esc at the CONFIRM box returns to the menu.
  }

  /* ── type-CONFIRM modal (v0.9) ───────────────────────────────────────────── */

  /** Capture keystrokes for the "type CONFIRM" arming box. */
  private handleTypeConfirmKey(ev: InputEvent): void {
    if (ev.type === 'escape') {
      this.cancelConfirm();
      return;
    }
    if (ev.type === 'enter') {
      if (this.confirmBuffer === CONFIRM_WORD) {
        const a = this.pendingAction!;
        this.pendingAction = null;
        this.confirmBuffer = '';
        this.confirmFromMenu = false;
        void this.executeAction(a);
      } else {
        this.confirmBuffer = ''; // wrong / incomplete — reset so it is retyped cleanly
      }
      return;
    }
    if (ev.type === 'char') {
      const ch = ev.ch;
      if (ch === '\x7f' || ch === '\b') {
        this.confirmBuffer = this.confirmBuffer.slice(0, -1);
        return;
      }
      // Accept only printable chars, and never grow past the target word length.
      if (ch >= ' ' && ch < '\x7f' && this.confirmBuffer.length < CONFIRM_WORD.length) this.confirmBuffer += ch;
      return;
    }
    // arrows / tab ignored — stay in the confirm box.
  }

  /** Cancel the pending confirm; reopen the menu (re-snapshotting a fresh target
   *  + item list) if that is where it came from. */
  private cancelConfirm(): void {
    this.pendingAction = null;
    this.confirmBuffer = '';
    if (this.confirmFromMenu) {
      this.confirmFromMenu = false;
      this.openMenu();
    }
  }

  private async executeAction(action: PendingAction): Promise<void> {
    if (!this.actions) return;
    this.actionInFlight = true;
    this.actionRunningLabel = action.label;
    this.lastFrameHash = '';
    this.draw();
    const a = this.actions;
    let res: { ok: boolean; message: string };
    try {
      switch (action.kind) {
        case 'ping': res = await a.ping(action.nodeId!); break;
        case 'refreshValues': res = await a.refreshValues(action.nodeId!); break;
        case 'reInterview': res = await a.reInterview(action.nodeId!); break;
        case 'healNode': res = await a.healNode(action.nodeId!); break;
        case 'rebuildAll': res = await a.rebuildAll(); break;
        case 'stopRebuild': res = await a.stopRebuild(); break;
        case 'removeFailed': res = await a.removeFailed(action.nodeId!); break;
        case 'controlEntity': res = await a.controlEntity(action.nodeId!, action.entityId!, action.verb!); break;
        case 'setConfigParam': res = await a.setConfigParam(action.nodeId!, action.param!, action.value!); break;
        default: res = { ok: false, message: 'unknown action' };
      }
    } catch (e) {
      res = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.actionInFlight = false;
    this.actionNotice = res.ok ? `✓  ${action.label}` : `✗  ${res.message}`;
    this.lastFrameHash = '';
    this.draw();
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
    // Config value picker (v0.23) — shown between menu-select and the CONFIRM box.
    if (this.paramEdit != null) {
      const pe = this.paramEdit;
      const cur = pe.param.value == null
        ? '—'
        : pe.param.valueLabel
          ? `${pe.param.value} (${pe.param.valueLabel})`
          : `${pe.param.value}${pe.param.unit ? ' ' + pe.param.unit : ''}`;
      return renderParamEdit(this.view, {
        label: pe.param.label,
        current: cur,
        isEnum: pe.options != null,
        options: pe.options ?? undefined,
        optionIndex: pe.optionIndex,
        draft: pe.draft,
        min: pe.param.min,
        max: pe.param.max,
        unit: pe.param.unit,
        error: pe.error,
      });
    }
    // Action modals: type-CONFIRM → working → outcome → menu (v0.3 / v0.9).
    if (this.pendingAction != null) {
      const a = this.pendingAction;
      return renderTypeConfirm(this.view, {
        label: a.label,
        target: a.target,
        impact: a.impact,
        desc: a.desc,
        impactNote: a.impactNote,
        buffer: this.confirmBuffer,
      });
    }
    if (this.actionInFlight) {
      return centeredNotice(this.view, 'WORKING', [c.yellow(this.actionRunningLabel || 'running…'), '', c.grey('sending command to the mesh…')]);
    }
    if (this.actionNotice != null) {
      const ok = this.actionNotice.startsWith('✓');
      return centeredNotice(this.view, 'RESULT', [(ok ? c.green : c.red)(this.actionNotice), '', c.grey('press any key to continue · see the Log screen for history')]);
    }
    if (this.menuOpen) {
      this.menuIndex = clampMenuIndex(this.menuIndex, this.menuSnapshot.length);
      return renderActionsMenu(this.view, {
        items: this.menuSnapshot,
        index: this.menuIndex,
        targetLabel: this.menuTarget ? `#${this.menuTarget.nodeId} ${this.menuTarget.name}` : null,
        locked: !this.actions?.enabled,
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
    const ctx: ScreenCtx = {
      view: this.view,
      data: this.data,
      visibleNodes: vis,
      filtering: this.filtering,
      actionsEnabled: this.actions?.enabled ?? false,
    };
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
      this.loginAttempts = 0; // restore the full retry budget on re-lock
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
