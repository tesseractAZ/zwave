/**
 * READ-ONLY zwave-js driver WebSocket client (v0.13 — DESIGN.md §2.1).
 *
 * Connects to the zwave-js-server the official Z-Wave JS add-on runs on the
 * HA internal network (default `ws://core-zwave-js:3000`) and consumes ONLY
 * passive telemetry: the `start_listening` state dump and its event stream.
 * This is the sole path to the diagnostics HA's WS strips (RESEARCH §3.2/§3.3):
 * per-channel background RSSI (the noise floor — real SNR + interference
 * measurement), node `lastSeen`, and the isListening/FLiRS capability flags.
 *
 * SECURITY POSTURE (non-negotiable, from the design review):
 *  - The socket is UNAUTHENTICATED — treat it as privileged. Nothing received
 *    here is ever proxied or re-exposed (not to the TUI transport, not to
 *    ingress, not verbatim to logs — log types/counts, never payloads).
 *  - CLOSED COMMAND ALLOWLIST, enforced in code: `set_api_schema`,
 *    `start_listening`, and the log-stream pair `start_listening_logs` /
 *    `stop_listening_logs` (v0.26) only. `send()` THROWS on anything else —
 *    no health checks, no pings, no route surgery, nothing that transmits RF.
 *    All mesh-mutating actions stay on the authenticated HA WS. The log pair
 *    is still read-only telemetry: it toggles THIS client's `receiveLogs`
 *    flag server-side and transmits nothing over RF.
 *
 * LOG LISTENING (v0.26 — the S2 SPAN-resync watch). S2 nonce desync surfaces
 * ONLY in driver log lines — no statistics counter moves — so after each state
 * dump we subscribe to the log stream (`start_listening_logs`, top-level since
 * schema 31 < our floor of 32) and match the S2 resync family locally.
 * Deliberately NO server-side `filter`: zwave-js-server's log forwarder is one
 * GLOBAL transport whose first subscriber's filter wins and is silently applied
 * to every other client — a narrow filter from us would corrupt the HA Z-Wave
 * log viewer for the operator. We take the full stream at the driver's current
 * level (the same lines the add-on log shows; the resync retry is `info`, the
 * terminal drop `warn`, so both arrive at the stock level) and drop
 * non-matching lines with one cheap substring test. A storm backstop stops OUR
 * subscription (nobody else's) if the stream runs hot, and log payloads are
 * never re-logged or re-exposed — the matcher returns only a node id.
 *  - Dormant, never fatal: unreachable server / schema mismatch / homeId
 *    mismatch ⇒ the dependent telemetry stays null and detectors that need it
 *    stay dormant (collapse method, never measurement). The add-on never
 *    fails to start because of this client.
 *
 * Protocol (zwave-js-server): on connect the server pushes
 * `{type:'version', homeId, driverVersion, serverVersion, minSchemaVersion,
 * maxSchemaVersion}`. We negotiate `schemaVersion = min(serverMax, OUR_MAX)`,
 * refuse anything below OUR_MIN (=32 — the rebuild-routes command renames land
 * there, our tested floor), then `start_listening` returns the full state and
 * begins the event stream. Schema mismatch is PERMANENT dormancy (a server
 * doesn't change schema mid-life); connection loss is retried with capped
 * exponential backoff; liveness is a WS ping/pong probe (NOT application
 * traffic), so a genuinely idle-but-healthy socket — a 500-series controller
 * with no background-RSSI polling, or a sleeping all-battery mesh — is kept up
 * by pongs, while only a wedged peer that answers neither traffic nor pings is
 * terminated and reconnected.
 */

import WebSocket from 'ws';
import type { LogSink } from '../logger';

/** The ONLY commands this client may ever send. Frozen — see header. */
export const DRIVER_WS_ALLOWLIST: readonly string[] = Object.freeze([
  'set_api_schema',
  'start_listening',
  'start_listening_logs',
  'stop_listening_logs',
]);

/** Schema range this client's parsing is tested against. */
export const DRIVER_SCHEMA_MIN = 32;
export const DRIVER_SCHEMA_MAX = 41;

/** Per-channel background RSSI (dBm, driver-EMA `average`), null = unknown. */
export type BgRssiChannels = (number | null)[];

export interface DriverWsCallbacks {
  /** Controller background RSSI update (channels 0..3, nulls for absent). */
  onBgRssi?: (channels: BgRssiChannels, at: number) => void;
  /** A node's driver-side lastSeen advanced (epoch ms). */
  onNodeLastSeen?: (nodeId: number, lastSeen: number) => void;
  /** Node capability flags from the state dump (listening / FLiRS). */
  onNodeFlags?: (nodeId: number, flags: { isListening: boolean | null; isFrequentListening: boolean | null }) => void;
  /** The server's homeId (from the version handshake) — caller cross-checks vs HA. */
  onHomeId?: (homeId: number) => void;
  /** An S2 SPAN-resync log event was attributed to a node (v0.26). */
  onS2Resync?: (nodeId: number) => void;
}

export interface DriverWsClientOptions {
  /** ws:// URL; empty/null ⇒ the client is permanently disabled. */
  url: string | null;
  callbacks: DriverWsCallbacks;
  /** Widened to LogSink (v0.53.0) for the handshake-timeout line only — every
   *  other site here is deliberately `info`, since the state machine already
   *  reports the link on screen. */
  log?: LogSink;
  /** Reconnect backoff base (ms); doubles per attempt, capped at 60×base. */
  reconnectBaseMs?: number;
  /** Terminate a socket silent for this long (ms). */
  livenessMs?: number;
}

export type DriverWsState =
  | 'disabled'
  | 'connecting'
  | 'handshake'
  | 'live'
  | 'backoff'
  | 'dormant' // permanent (schema mismatch) — no retry until restart
  | 'stopped'; // stop() called — start() can re-establish

export interface DriverWsClient {
  /** Is the S2 log lane ACTUALLY listening right now? False when logs were
   *  never started, were refused, or the storm backstop stopped them. The
   *  consumer records an honest `null` rather than `0` when this is false —
   *  "lane switched off" must never read as "no resyncs happened" (v0.26
   *  review: it converted a switched-off measurement into a recovery). */
  s2LaneLive(): boolean;
  start(): void;
  stop(): void;
  state(): DriverWsState;
  /** One-line status for logs/diagnostics (never includes payload data). */
  status(): string;
  /** The negotiated schema version (null until live). */
  schema(): number | null;
  /** The server's homeId from the handshake (null until known). */
  homeId(): number | null;
}

interface VersionMsg {
  type: 'version';
  homeId?: number;
  driverVersion?: string;
  serverVersion?: string;
  minSchemaVersion?: number;
  maxSchemaVersion?: number;
}

const RSSI_SENTINEL_MIN = 125;

/** Redact userinfo (ws://user:pass@host) before logging a configured URL. */
export function redactUrl(url: string): string {
  return url.replace(/(\/\/)[^/@]*@/, '$1***@');
}

/** A short, control-char-free echo of a server-sent string — never log raw
 *  attacker-controlled payloads verbatim (log flooding / forged log lines). */
export function safeTag(v: unknown, max = 40): string {
  if (typeof v !== 'string') return typeof v === 'number' ? String(v) : '?';
  return v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
}

/** A plausible Z-Wave node id (positive integer in range) or null — a hostile
 *  or buggy server must not grow the driver maps with junk ids. */
export function saneNodeId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4000 ? v : null;
}

/** S2 SPAN-resync matcher (v0.26): the node id a driver `logging` event
 *  attributes an S2 nonce-desync line to, or null for everything else.
 *
 *  Verified against node-zwave-js v15.26.0 sources — the S2 desync family is:
 *   outgoing (device could not decrypt us; controllerLog.logNode → node ctx):
 *    · "failed to decode the message, retrying with SPAN extension..."  (info)
 *    · "failed to decode the message after re-transmission with SPAN
 *       extension, dropping the message."                               (warn)
 *   incoming (we could not decrypt the device; also node-attributed):
 *    · "Message authentication failed|No SPAN is established yet, cannot
 *       decode command. …"                                           (verbose)
 *  The incoming family only streams when the driver log level is `verbose`+;
 *  the outgoing pair arrives at the stock `info` level. Node attribution is
 *  REQUIRED (context.type === 'node' with a sane nodeId) — the un-attributed
 *  driver-level "Dropping message with invalid payload" line is deliberately
 *  NOT matched, so a hostile/buggy server cannot charge resyncs to nobody.
 *  The message text is server-sent: it is matched, never logged or stored. */
export function s2ResyncNodeId(ev: Record<string, unknown>): number | null {
  if (ev.event !== 'logging') return null;
  const ctx = ev.context as Record<string, unknown> | undefined;
  if (!ctx || typeof ctx !== 'object' || ctx.type !== 'node') return null;
  const nodeId = saneNodeId(ctx.nodeId);
  if (nodeId == null) return null;
  const raw = ev.message;
  const msg = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').join('\n') : '';
  // ONE resync = ONE count. The outgoing family emits TWO lines for a single
  // failed transmission — the `retrying with SPAN extension...` attempt and,
  // if the retry also fails, `...after re-transmission with SPAN extension,
  // dropping the message.` Counting both double-scored every terminal failure
  // and silently halved the effective S2_ABS threshold, so match only the
  // ATTEMPT line and let the drop line fall through (it is always preceded by
  // its own retry line, so nothing is lost).
  if (msg.includes('re-transmission with SPAN extension')) return null;
  if (msg.includes('SPAN extension')) return nodeId;
  if (msg.includes('cannot decode command')) return nodeId;
  return null;
}

/** A finite, non-sentinel dBm value or null. */
function cleanDbm(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v >= RSSI_SENTINEL_MIN) return null;
  return v;
}

/**
 * zwave-js-server serializes lastSeen as an ISO string (sometimes epoch).
 *
 * THE STRING CARRIES NO TIMEZONE, AND IT IS UTC. Measured live 2026-08-05: the
 * driver reported `"2026-08-06T04:25:48.921"` for a node heard 21 minutes
 * earlier at 21:25 MST — that is 04:25 UTC with the `Z` missing. ECMA-262
 * parses a date-TIME string without an offset as LOCAL time, so on a plant in
 * MST every naked timestamp landed SEVEN HOURS IN THE FUTURE. A future
 * lastSeen makes a node's computed silence negative, which quietly corrupts
 * every consumer of "how long since this node spoke" — the liveness probe's
 * due test, the displayed last-seen, the evidence samples.
 *
 * So: an ISO date-time with no explicit offset gets `Z` appended before
 * parsing. Strings that DO carry an offset (`Z` or ±hh:mm) are honoured as-is
 * — if a future driver starts emitting proper offsets, nothing changes.
 */
const ISO_NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
export function parseLastSeen(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const t = Date.parse(ISO_NO_OFFSET.test(v) ? v + 'Z' : v);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

/** Extract channels 0..3 (driver-EMA `average`) from a backgroundRSSI blob. */
export function parseBgRssi(bg: unknown): BgRssiChannels | null {
  if (!bg || typeof bg !== 'object') return null;
  const o = bg as Record<string, unknown>;
  const chan = (k: string): number | null => {
    const c = o[k];
    if (!c || typeof c !== 'object') return null;
    const cc = c as Record<string, unknown>;
    // Prefer the driver's own EMA (`average`) — the canonical floor estimate;
    // fall back to `current` when average is absent.
    return cleanDbm(cc.average) ?? cleanDbm(cc.current);
  };
  const channels: BgRssiChannels = [chan('channel0'), chan('channel1'), chan('channel2'), chan('channel3')];
  return channels.some((c) => c != null) ? channels : null;
}

export function createDriverWsClient(opts: DriverWsClientOptions): DriverWsClient {
  const url = (opts.url ?? '').trim() || null;
  const log: LogSink = opts.log ?? (() => {});
  const cb = opts.callbacks;
  const reconnectBaseMs = opts.reconnectBaseMs ?? 5_000;
  const reconnectMaxMs = reconnectBaseMs * 60; // ~5 min at the default base
  const livenessMs = opts.livenessMs ?? 5 * 60_000;

  let ws: WebSocket | null = null;
  let state: DriverWsState = url ? 'connecting' : 'disabled';
  let stopped = !url;
  let started = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let lastMsgAt = 0;
  let negotiatedSchema: number | null = null;
  let serverHomeId: number | null = null;
  let statusLine = url ? 'not started' : 'disabled (no driver_ws_url)';
  let msgId = 0;
  /** Log-stream state — all per-connection, reset in connect(). */
  let logsMsgId: string | null = null; // messageId of our start_listening_logs
  /** True only between a successful start_listening_logs ack and the next
   *  disconnect / storm-stop — the S2 lane's liveness (see s2LaneLive). */
  let logsAcked = false;
  let logStormStopped = false; // storm backstop tripped (until next reconnect)
  let logEvWindowStart = 0; // rolling 60 s window for the storm meter
  let logEvCount = 0;

  /** The allowlist gate — defense in depth; nothing else may ever be sent.
   *  `extra` is spread FIRST so the checked `command`/`messageId` always win —
   *  a colliding `extra.command` can never override the allowlisted value
   *  (v0.13 review: spread-order allowlist bypass). */
  function send(command: string, extra: Record<string, unknown> = {}): string | null {
    if (!DRIVER_WS_ALLOWLIST.includes(command)) {
      throw new Error(`driver-ws: command '${command}' is not on the read-only allowlist`);
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const messageId = `dw-${++msgId}`;
    ws.send(JSON.stringify({ ...extra, command, messageId }));
    return messageId;
  }

  function setState(s: DriverWsState, line: string): void {
    const changed = state !== s || statusLine !== line;
    state = s;
    statusLine = line;
    if (changed) log(`driver-ws: ${line}`);
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || state === 'dormant') return;
    attempts += 1;
    const delay = Math.min(reconnectBaseMs * 2 ** Math.min(attempts - 1, 10), reconnectMaxMs);
    setState('backoff', `${reason} — retry in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function teardownSocket(): void {
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
    if (ws) {
      ws.removeAllListeners();
      // The no-op error listener is NOT optional. `terminate()` on a socket
      // still in CONNECTING makes ws emit 'error' ("WebSocket was closed
      // before the connection was established") ASYNCHRONOUSLY — on a later
      // tick, via emitErrorAndClose — so the try/catch below never sees it,
      // and with the listeners stripped above the EventEmitter re-throws it
      // as an uncaught exception. That exact sequence crashed the add-on
      // mid-shutdown on 2026-08-05 21:25 (HA core restart → watchdog SIGTERM
      // while the driver socket was mid-reconnect → teardown → crash). The
      // store saves survived (they run synchronously before the event loop
      // turns), but the process died with a stack instead of exiting cleanly,
      // aborting the rest of shutdown (app.close, exit 0). Same defect class
      // as haWsClient.stop() (v0.29 fix); this is the second copy.
      ws.on('error', () => { /* teardown: outcome irrelevant */ });
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      ws = null;
    }
  }

  function connect(): void {
    if (stopped || state === 'dormant' || !url) return;
    teardownSocket();
    logsMsgId = null;
    logStormStopped = false;
    logsAcked = false;
    logEvWindowStart = 0;
    logEvCount = 0;
    setState('connecting', `connecting to ${redactUrl(url)}`);
    let sock: WebSocket;
    try {
      sock = new WebSocket(url, { maxPayload: 32 * 1024 * 1024, handshakeTimeout: 10_000 });
    } catch (e) {
      scheduleReconnect(`connect failed (${(e as Error).message})`);
      return;
    }
    ws = sock;
    sock.on('open', () => {
      lastMsgAt = Date.now();
      setState('handshake', 'connected — waiting for version handshake');
      // Liveness via WS PING/PONG, not application traffic. A quiet all-battery
      // mesh (or a 500-series controller with no GetBackgroundRSSI) legitimately
      // sends NO app messages for long stretches — killing that healthy socket
      // every livenessMs would churn reconnects all night (v0.13 review). So we
      // probe with a protocol ping at the half-interval and only terminate if
      // NEITHER an app message NOR a pong arrives within livenessMs.
      // Check at a quarter-interval so a probe ping (at half the timeout) and
      // its pong land WELL before the terminate threshold — otherwise the ping
      // and terminate ticks coincide and a healthy socket is a coin-flip.
      const checkMs = Math.max(250, Math.min(livenessMs / 4, 30_000));
      // THE HANDSHAKE HAS ITS OWN CLOCK (v0.53.0). The liveness probe above
      // measures `lastMsgAt`, which a PONG refreshes — so a peer that upgrades
      // and answers pings but never completes `start_listening` looked healthy
      // forever and sat in `handshake` for the life of the process, with no
      // evidence stream and no reconnect. Measure from OPEN, which nothing
      // refreshes, and test it FIRST so the operator gets the accurate reason.
      const openedAt = Date.now();
      const handshakeMs = Math.min(livenessMs, 30_000);
      livenessTimer = setInterval(() => {
        if (state !== 'live' && Date.now() - openedAt > handshakeMs) {
          (log.error ?? log)('driver-ws: handshake never completed — terminating socket for reconnect');
          teardownSocket();
          scheduleReconnect('handshake timeout');
          return;
        }
        const idle = Date.now() - lastMsgAt;
        if (idle > livenessMs) {
          log('driver-ws: no pong/traffic — terminating wedged socket for reconnect');
          teardownSocket();
          scheduleReconnect('liveness timeout');
        } else if (idle >= livenessMs / 2 && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch {
            /* ping on a closing socket — the close handler will reconnect */
          }
        }
      }, checkMs);
      livenessTimer.unref?.();
    });
    sock.on('pong', () => {
      lastMsgAt = Date.now(); // a live-but-idle socket answers pings — healthy
    });
    sock.on('message', (raw: WebSocket.RawData) => {
      lastMsgAt = Date.now();
      try {
        onMessage(JSON.parse(String(raw)) as Record<string, unknown>);
      } catch {
        // Never log payloads — the socket is privileged. Count-only note.
        log('driver-ws: unparseable frame ignored');
      }
    });
    sock.on('error', (e: Error) => {
      // 'close' follows; reconnect scheduled there.
      log(`driver-ws: socket error (${e.message})`);
    });
    sock.on('close', () => {
      teardownSocket();
      if (state !== 'dormant' && !stopped) scheduleReconnect('connection closed');
    });
  }

  function onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'version': {
        const v = m as unknown as VersionMsg;
        const serverMin = typeof v.minSchemaVersion === 'number' ? v.minSchemaVersion : 0;
        const serverMax = typeof v.maxSchemaVersion === 'number' ? v.maxSchemaVersion : 0;
        if (typeof v.homeId === 'number') {
          serverHomeId = v.homeId;
          cb.onHomeId?.(v.homeId);
        }
        if (serverMax <= 0) {
          // No usable schema range ⇒ not a zwave-js-server we understand (wrong
          // endpoint, or a malformed/garbage handshake). Dormant, not a crash.
          teardownSocket();
          setState('dormant', 'unrecognized handshake (no schema range) — driver telemetry dormant');
          return;
        }
        const negotiated = Math.min(serverMax, DRIVER_SCHEMA_MAX);
        if (negotiated < DRIVER_SCHEMA_MIN || serverMin > negotiated) {
          // Permanent: a server's schema range doesn't change mid-life. Refusing
          // outside the tested range beats parsing frames we don't understand.
          teardownSocket();
          setState('dormant', `schema mismatch (server ${serverMin}..${serverMax}, tested ${DRIVER_SCHEMA_MIN}..${DRIVER_SCHEMA_MAX}) — driver telemetry dormant`);
          return;
        }
        negotiatedSchema = negotiated;
        send('set_api_schema', { schemaVersion: negotiated });
        send('start_listening');
        setState('handshake', `negotiated schema ${negotiated} (driver ${safeTag(v.driverVersion)}, server ${safeTag(v.serverVersion)}) — starting listener`);
        return;
      }
      case 'result': {
        const success = m.success === true;
        const result = (m.result ?? null) as Record<string, unknown> | null;
        if (success && result && typeof result === 'object' && 'state' in result) {
          onStateDump((result as { state?: unknown }).state);
          attempts = 0;
          setState('live', `live (schema ${negotiatedSchema}, home ${serverHomeId ?? '?'})`);
          // Subscribe to the log stream only once the listener is LIVE — a
          // connection that dies during handshake never requests logs. The
          // subscription is per-connection (like start_listening) and is
          // re-established on every reconnect by landing here again.
          logsMsgId = send('start_listening_logs');
          return;
        }
        if (m.messageId === logsMsgId && logsMsgId != null) {
          // Log listening is OPTIONAL telemetry: a refusal degrades the S2
          // watch to dormant, it never touches the main listener.
          log(success
            ? 'driver-ws: log stream active (S2 SPAN-resync watch)'
            : `driver-ws: log stream unavailable (${safeTag(m.errorCode ?? 'refused')}) — S2 watch dormant`);
          logsAcked = success;
          if (!success) logsMsgId = null;
          return;
        }
        if (!success) {
          log(`driver-ws: command failed (${safeTag(m.errorCode ?? 'unknown')})`);
        }
        return;
      }
      case 'event': {
        onEvent((m.event ?? null) as Record<string, unknown> | null);
        return;
      }
      default:
        return; // unknown frame types are ignored, never logged verbatim
    }
  }

  function onStateDump(stateBlob: unknown): void {
    if (!stateBlob || typeof stateBlob !== 'object') return;
    const s = stateBlob as Record<string, unknown>;
    // Controller: seed background RSSI if the driver already has a reading.
    const ctrl = s.controller as Record<string, unknown> | undefined;
    const ctrlStats = ctrl?.statistics as Record<string, unknown> | undefined;
    const bg = parseBgRssi(ctrlStats?.backgroundRSSI);
    if (bg) cb.onBgRssi?.(bg, Date.now());
    // Nodes: capability flags + initial lastSeen.
    const nodes = Array.isArray(s.nodes) ? s.nodes : [];
    let flagged = 0;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const node = n as Record<string, unknown>;
      const nodeId = saneNodeId(node.nodeId);
      if (nodeId == null) continue;
      cb.onNodeFlags?.(nodeId, {
        isListening: typeof node.isListening === 'boolean' ? node.isListening : null,
        isFrequentListening: node.isFrequentListening === true ? true : node.isFrequentListening === false ? false : null,
      });
      flagged += 1;
      const stats = node.statistics as Record<string, unknown> | undefined;
      const seen = parseLastSeen(stats?.lastSeen);
      if (seen != null) cb.onNodeLastSeen?.(nodeId, seen);
    }
    log(`driver-ws: state dump processed (${flagged} nodes, bgRSSI ${bg ? 'present' : 'absent'})`);
  }

  /** One streamed driver log line. Storm-metered, matched, and dropped —
   *  the payload is never stored, logged, or forwarded (privileged socket). */
  const LOG_STORM_PER_MIN = 3000;
  function onLoggingEvent(ev: Record<string, unknown>): void {
    if (logStormStopped) return; // stop was sent; drain whatever is in flight
    const now = Date.now();
    if (now - logEvWindowStart >= 60_000) {
      logEvWindowStart = now;
      logEvCount = 0;
    }
    logEvCount += 1;
    if (logEvCount > LOG_STORM_PER_MIN) {
      // The driver was likely switched to debug/silly. OUR unsubscribe only
      // clears this client's receiveLogs flag — other subscribers (the HA log
      // viewer) are untouched. Re-arms on the next reconnect.
      logStormStopped = true;
      send('stop_listening_logs');
      log(`driver-ws: log stream storm (>${LOG_STORM_PER_MIN}/min — driver log level raised?) — S2 watch paused until reconnect`);
      return;
    }
    const nodeId = s2ResyncNodeId(ev);
    if (nodeId != null) cb.onS2Resync?.(nodeId);
  }

  function onEvent(ev: Record<string, unknown> | null): void {
    if (!ev) return;
    if (ev.event === 'logging') {
      onLoggingEvent(ev);
      return;
    }
    if (ev.source === 'controller' && ev.event === 'statistics updated') {
      const stats = ev.statistics as Record<string, unknown> | undefined;
      const bg = parseBgRssi(stats?.backgroundRSSI);
      if (bg) cb.onBgRssi?.(bg, Date.now());
      return;
    }
    if (ev.source === 'node' && ev.event === 'statistics updated') {
      const nodeId = saneNodeId(ev.nodeId);
      if (nodeId == null) return;
      const stats = ev.statistics as Record<string, unknown> | undefined;
      const seen = parseLastSeen(stats?.lastSeen);
      if (seen != null) cb.onNodeLastSeen?.(nodeId, seen);
      return;
    }
    // Every other event type (values, notifications, inclusion …) is ignored:
    // HA's authenticated WS remains the source of truth for all of it.
  }

  return {
    s2LaneLive(): boolean {
      // Every way the lane can be dark, in one predicate: never started, the
      // server refused it, the storm backstop stopped it, or the socket is not
      // currently live. Callers record `null` (unknown) rather than 0 when this
      // is false.
      return logsAcked && !logStormStopped && state === 'live';
    },
    start(): void {
      if (!url) {
        setState('disabled', 'disabled (no driver_ws_url)');
        return;
      }
      if (started) return; // already running — idempotent
      started = true;
      stopped = false;
      // A dormant latch (schema mismatch) is per-server and permanent; a fresh
      // start() is a deliberate re-establish (e.g. after a home-id change), so
      // clear it and let the handshake re-decide.
      if (state === 'dormant') setState('connecting', `connecting to ${redactUrl(url)}`);
      connect();
    },
    stop(): void {
      stopped = true;
      started = false; // allow a later start() to re-establish (restart symmetry)
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      teardownSocket();
      setState(url ? 'stopped' : 'disabled', 'stopped');
    },
    state: () => state,
    status: () => statusLine,
    schema: () => negotiatedSchema,
    homeId: () => serverHomeId,
  };
}
