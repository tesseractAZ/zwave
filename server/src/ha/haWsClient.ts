/**
 * Home Assistant Core WebSocket client.
 *
 * This is the single connection layer the whole add-on talks to Home Assistant
 * through. Unlike ecoflow-panel's REST `haService`, the Z-Wave TUI needs the
 * *WebSocket* API because `zwave_js/*` exposes live push subscriptions
 * (`subscribe_node_statistics`, `subscribe_controller_statistics`,
 * `subscribe_events`) that REST can't deliver.
 *
 * Two mechanisms, one persistent socket (adapted from ~/.claude-ha/ws-lib.mjs):
 *
 *   1. `send(cmd, timeoutMs)` — request/response. Auto-increments a message id,
 *      writes `{id, ...cmd}`, and resolves on the FIRST `{type:'result', id}`
 *      frame that matches. It CANNOT see `{type:'event'}` pushes.
 *
 *   2. A persistent message router (`handleMessage`) attached ONCE per
 *      connection that demultiplexes every inbound frame: `result` frames go to
 *      the pending-request map, `event` frames go to `registerEventHandler(id,
 *      cb)` — this is what makes `subscribe_*` pushes reachable. `subscribe()`
 *      wires the two together (allocate id → register handler → send the
 *      subscribe command under that id).
 *
 * Auth handshake: on connect HA sends `{type:'auth_required'}`; we reply with
 * `{type:'auth', access_token: SUPERVISOR_TOKEN}` and wait for `{type:'auth_ok'}`.
 *
 * Resilience: application-level heartbeat (WS ping/pong) terminates a wedged
 * session, and the socket auto-reconnects with capped exponential backoff. When
 * `SUPERVISOR_TOKEN` is absent (running the server locally for dev without the
 * token file) the client is a safe no-op: `start()` logs once, `ready()` is
 * false, and `send()`/`subscribe()` reject with a clear message.
 *
 * Production reads `process.env.HA_WS_URL` (default `ws://supervisor/core/websocket`)
 * and `process.env.SUPERVISOR_TOKEN` (auto-injected by Supervisor). For local
 * dev the URL falls back to the Pi (`ws://192.168.5.152:8123/api/websocket`) and
 * the token to `~/.claude-ha/token`.
 */

import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** Minimal shape of an inbound HA WebSocket frame. */
export interface HaMessage {
  id?: number;
  type: string;
  success?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  /** Present on `{type:'event'}` frames — the actual subscription payload. */
  event?: unknown;
  [key: string]: unknown;
}

/**
 * Handler for subscription push frames. Receives the FULL `{id, type:'event',
 * event}` message so callers can read `msg.event` (the zwave_js statistics /
 * state_changed payload).
 */
export type HaEventHandler = (msg: HaMessage) => void;

export type Logger = (msg: string) => void;

export interface HaWsClientOptions {
  /** Override the WS URL. Defaults to env `HA_WS_URL` then the supervisor/dev URL. */
  url?: string;
  /** Override the bearer token. Defaults to env `SUPERVISOR_TOKEN` then the dev token file. */
  token?: string | null;
  /** Line logger (defaults to a no-op). */
  log?: Logger;
}

export interface HaSubscription {
  /** The message id the subscription events arrive under. */
  subscriptionId: number;
  /** Best-effort unsubscribe (removes the local handler + tells HA to stop). */
  unsubscribe: () => Promise<void>;
}

export interface HaWsClient {
  /** Begin connecting (idempotent; no-op when unconfigured). */
  start(): void;
  /** Request/response. Resolves on the first matching `{type:'result', id}`. */
  send<T = unknown>(cmd: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Subscribe helper: registers an event handler then sends the subscribe command. */
  subscribe(cmd: Record<string, unknown>, onEvent: HaEventHandler, timeoutMs?: number): Promise<HaSubscription>;
  /** Register a raw event handler for a known subscription id (low-level primitive). */
  registerEventHandler(id: number, cb: HaEventHandler): void;
  /** Remove a previously-registered event handler. */
  unregisterEventHandler(id: number): void;
  /** Called after every successful (re)authentication — the re-subscribe hook. */
  onReady(cb: () => void): void;
  /** True once authenticated with HA Core. */
  ready(): boolean;
  /** True when a token is present (false = dev no-op mode). */
  isConfigured(): boolean;
  /** Last connection/auth error, or null. */
  lastError(): string | null;
  /** Tear down: stop reconnecting, reject everything in flight, close the socket. */
  stop(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve the bearer token: explicit → env → dev token file (non-production only). */
function resolveToken(explicit?: string | null): string | null {
  if (explicit != null && explicit !== '') return explicit;
  const env = process.env.SUPERVISOR_TOKEN;
  if (env && env.length > 0) return env;
  // Dev convenience: read ~/.claude-ha/token when running outside the container.
  // In the add-on NODE_ENV=production, so this branch never touches the FS there.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const t = readFileSync(join(homedir(), '.claude-ha', 'token'), 'utf8').trim();
      if (t) return t;
    } catch {
      /* no dev token file — fall through to unconfigured no-op */
    }
  }
  return null;
}

/** Resolve the WS URL: explicit → env → supervisor (prod) / Pi (dev). */
function resolveUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.HA_WS_URL) return process.env.HA_WS_URL;
  if (process.env.NODE_ENV !== 'production') return 'ws://192.168.5.152:8123/api/websocket';
  return 'ws://supervisor/core/websocket';
}

class HaWebSocketClient implements HaWsClient {
  private readonly url: string;
  private readonly token: string | null;
  private readonly log: Logger;

  private ws: WebSocket | null = null;
  private nextId = 1;
  private authenticated = false;
  private started = false;
  private stopped = false;
  private warnedNoToken = false;
  private lastErr: string | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<number, HaEventHandler>();
  private readyWaiters = new Set<ReadyWaiter>();
  private readonly readyCallbacks = new Set<() => void>();

  constructor(opts: HaWsClientOptions = {}) {
    this.url = resolveUrl(opts.url);
    this.token = resolveToken(opts.token);
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.token == null) {
      if (!this.warnedNoToken) {
        this.warnedNoToken = true;
        this.log('SUPERVISOR_TOKEN absent — HA WS client is a no-op (dev mode)');
      }
      return;
    }
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  send<T = unknown>(cmd: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return this.waitReady(timeoutMs).then(() => this.dispatch<T>(this.nextId++, cmd, timeoutMs));
  }

  async subscribe(
    cmd: Record<string, unknown>,
    onEvent: HaEventHandler,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<HaSubscription> {
    await this.waitReady(timeoutMs);
    // Allocate the id and register the handler BEFORE sending so no early push
    // is dropped between the result and the first event.
    const id = this.nextId++;
    this.eventHandlers.set(id, onEvent);
    try {
      await this.dispatch(id, cmd, timeoutMs);
    } catch (e) {
      this.eventHandlers.delete(id);
      throw e;
    }
    return {
      subscriptionId: id,
      unsubscribe: async () => {
        this.eventHandlers.delete(id);
        try {
          await this.send({ type: 'unsubscribe_events', subscription: id });
        } catch {
          /* best-effort; the handler is already gone locally */
        }
      },
    };
  }

  registerEventHandler(id: number, cb: HaEventHandler): void {
    this.eventHandlers.set(id, cb);
  }

  unregisterEventHandler(id: number): void {
    this.eventHandlers.delete(id);
  }

  onReady(cb: () => void): void {
    this.readyCallbacks.add(cb);
    if (this.authenticated) {
      try {
        cb();
      } catch (e) {
        this.log(`onReady callback threw: ${errMsg(e)}`);
      }
    }
  }

  ready(): boolean {
    return this.authenticated;
  }

  isConfigured(): boolean {
    return this.token != null;
  }

  lastError(): string | null {
    return this.lastErr;
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.authenticated = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('HA WS client stopped'));
    }
    this.pending.clear();
    for (const w of this.readyWaiters) w.reject(new Error('HA WS client stopped'));
    this.readyWaiters.clear();
    this.eventHandlers.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /* ─── internals ─────────────────────────────────────────────────────── */

  private connect(): void {
    if (this.stopped) return;
    this.authenticated = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.lastErr = errMsg(e);
      this.log(`failed to open ${this.url}: ${this.lastErr}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.log(`connected to ${this.url}; awaiting auth`);
    });
    ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    ws.on('pong', () => {
      this.pongReceived = true;
    });
    ws.on('error', (err: Error) => {
      this.lastErr = errMsg(err);
      this.log(`ws error: ${this.lastErr}`);
      // A 'close' event follows; reconnect is scheduled there to avoid double-scheduling.
    });
    ws.on('close', (code: number) => this.handleClose(code));
  }

  /** THE persistent message router — attached once per socket. */
  private handleMessage(raw: WebSocket.RawData): void {
    let msg: HaMessage;
    try {
      msg = JSON.parse(raw.toString()) as HaMessage;
    } catch {
      return; // ignore non-JSON frames
    }
    switch (msg.type) {
      case 'auth_required':
        this.sendAuth();
        return;
      case 'auth_ok':
        this.handleAuthOk();
        return;
      case 'auth_invalid':
        this.handleAuthInvalid(msg);
        return;
      case 'result':
        this.handleResult(msg);
        return;
      case 'event':
        this.handleEvent(msg);
        return;
      case 'pong':
        // HA application-level pong; liveness uses WS-frame ping/pong instead.
        return;
      default:
        return;
    }
  }

  private sendAuth(): void {
    if (!this.ws || this.token == null) return;
    try {
      this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
    } catch (e) {
      this.log(`failed to send auth: ${errMsg(e)}`);
    }
  }

  private handleAuthOk(): void {
    this.authenticated = true;
    this.reconnectAttempts = 0;
    this.lastErr = null;
    this.log('authenticated with HA Core WebSocket');
    this.startHeartbeat();
    // Release everyone waiting on the first authentication.
    const waiters = this.readyWaiters;
    this.readyWaiters = new Set();
    for (const w of waiters) w.resolve();
    // Notify re-subscribe hooks (subscriptions from a prior connection are dead).
    for (const cb of this.readyCallbacks) {
      try {
        cb();
      } catch (e) {
        this.log(`onReady callback threw: ${errMsg(e)}`);
      }
    }
  }

  private handleAuthInvalid(msg: HaMessage): void {
    this.lastErr = `auth_invalid: ${msg.message ? String(msg.message) : 'token rejected'}`;
    this.log(this.lastErr);
    // Let the socket close and back off; a rotated token may authenticate next time.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private handleResult(msg: HaMessage): void {
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.success === false) {
      const err = msg.error;
      p.reject(new Error(`HA WS error (${err?.code ?? 'unknown'}): ${err?.message ?? JSON.stringify(msg.error)}`));
    } else {
      p.resolve(msg.result);
    }
  }

  private handleEvent(msg: HaMessage): void {
    if (typeof msg.id !== 'number') return;
    const cb = this.eventHandlers.get(msg.id);
    if (!cb) return;
    try {
      cb(msg);
    } catch (e) {
      this.log(`event handler for id ${msg.id} threw: ${errMsg(e)}`);
    }
  }

  private handleClose(code?: number): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    this.authenticated = false;
    this.stopHeartbeat();
    // Fail everything in flight — the connection that owned those ids is gone.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('HA WS connection closed'));
    }
    this.pending.clear();
    // Subscription ids are per-connection; drop the handlers. onReady() fires on
    // the next auth so callers can re-establish subscriptions (v0.2).
    this.eventHandlers.clear();
    if (this.stopped) return;
    this.log(`connection closed${code != null ? ` (code ${code})` : ''}; reconnecting`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.reconnectAttempts);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(BASE_BACKOFF_MS, Math.round(base + jitter));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (!this.pongReceived) {
        // No pong since the last tick — the session is wedged. Terminate hard
        // (skips the TCP close handshake) so 'close' fires and we reconnect.
        this.log('heartbeat timeout — terminating wedged socket');
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      this.pongReceived = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Resolve once authenticated; rejects on timeout / unconfigured / stopped. */
  private waitReady(timeoutMs: number): Promise<void> {
    if (this.authenticated) return Promise.resolve();
    if (this.token == null) {
      return Promise.reject(new Error('HA WS client not configured (SUPERVISOR_TOKEN absent)'));
    }
    if (this.stopped) return Promise.reject(new Error('HA WS client stopped'));
    if (!this.started) this.start();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const entry: ReadyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      timer = setTimeout(() => {
        this.readyWaiters.delete(entry);
        reject(new Error('HA WS not ready (auth timeout)'));
      }, timeoutMs);
      this.readyWaiters.add(entry);
    });
  }

  private dispatch<T>(id: number, cmd: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || !this.authenticated) {
        reject(new Error('HA WS not open'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA WS timeout (id ${id}, ${String(cmd.type)})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
        timer,
      });
      try {
        ws.send(JSON.stringify({ id, ...cmd }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

/** Construct an HA Core WebSocket client. Call `start()` before `send()`. */
export function createHaWsClient(opts: HaWsClientOptions = {}): HaWsClient {
  return new HaWebSocketClient(opts);
}
