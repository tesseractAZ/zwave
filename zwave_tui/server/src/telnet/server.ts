/**
 * Telnet control-room TUI server for the Z-Wave TUI add-on.
 *
 * A raw TCP server speaking just enough of the telnet protocol to put a
 * standard `telnet` / `nc` client into character-at-a-time mode. Each
 * connection gets a live, keyboard-driven Z-Wave mesh dashboard rendered with
 * ANSI. No dependencies: Node's `net` + hand-rolled telnet negotiation + ANSI.
 *
 * Adapted from ecoflow-panel's `telnet/server.ts`. The telnet transport — TCP
 * + IAC negotiation + NAWS + the alt-screen lifecycle + the IAC byte parser —
 * is preserved; only the per-session data source (`DataProvider`) and the
 * parsed event shapes (our transport-agnostic `SessionEvent`) differ.
 *
 * Bind host is `::` (dual-stack). Gated by `config.telnet.enabled` at the
 * call site (index.ts): when off, this server is never started.
 *
 * SECURITY: the telnet TUI is UNAUTHENTICATED — keep it on a trusted LAN.
 */

import { createServer } from 'node:net';
import { fmtElapsed } from './gauges';
import type { Socket } from 'node:net';
import type { DataProvider, ActionRunner } from '../types';
import type { AuthPolicy } from '../auth/loginPolicy';
import { TuiSession } from './session';
import type { SessionEvent } from './session';
import {
  HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, RESET,
  ENTER_ALT_BUFFER, EXIT_ALT_BUFFER,
} from './ansi';

/* ── Telnet protocol bytes ── */
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const OPT_ECHO = 1;
const OPT_SGA = 3;
const OPT_NAWS = 31;

interface TelnetConn {
  socket: Socket;
  /** Source address, kept for the per-IP connection cap. */
  ip: string;
  /**
   * Epoch ms of the last byte RECEIVED from the peer. Deliberately not "last
   * activity": the server writes a redraw every second, and a write must not
   * count as evidence the peer is alive — the absent peer is exactly what the
   * reclaim sweep exists to detect.
   */
  lastRxAt: number;
  /** Epoch ms the connection was accepted — the teardown line's duration
   *  (v0.50.0), which is what tells a stuck session from a brief one. */
  openedAt: number;
  session: TuiSession;
  inbuf: Buffer;
  timer: NodeJS.Timeout | null;
  /** Idle-flush timer for a lone trailing ESC byte (see onData). */
  escTimer: NodeJS.Timeout | null;
}

/**
 * Parse a raw input buffer into transport-agnostic events, stripping telnet
 * IAC sequences. Incomplete trailing sequences are returned in `rest` to be
 * prepended to the next chunk.
 */
function parseInput(buf: Buffer): { events: SessionEvent[]; rest: Buffer } {
  const events: SessionEvent[] = [];
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i];

    if (b === IAC) {
      if (i + 1 >= n) break; // incomplete
      const cmd = buf[i + 1];
      if (cmd === IAC) {
        i += 2; // escaped 0xFF data byte — ignore
        continue;
      }
      if (cmd === SB) {
        // Sub-negotiation: scan for IAC SE.
        let j = i + 2;
        let seAt = -1;
        let incomplete = false;
        while (j < n) {
          if (buf[j] === IAC) {
            if (j + 1 >= n) {
              incomplete = true;
              break;
            }
            if (buf[j + 1] === SE) {
              seAt = j;
              break;
            }
            j += 2; // IAC IAC (escaped) or IAC <x> inside SB
            continue;
          }
          j++;
        }
        if (incomplete || seAt < 0) break; // wait for the rest
        const sub = buf.subarray(i + 2, seAt);
        if (sub.length >= 5 && sub[0] === OPT_NAWS) {
          events.push({ type: 'resize', w: (sub[1] << 8) | sub[2], h: (sub[3] << 8) | sub[4] });
        }
        i = seAt + 2;
        continue;
      }
      if (cmd >= WILL && cmd <= DONT) {
        if (i + 2 >= n) break; // incomplete — need the option byte
        i += 3; // consume IAC <will/wont/do/dont> <opt>; no reply needed
        continue;
      }
      i += 2; // other 2-byte command (NOP, etc.)
      continue;
    }

    if (b === 0x1b) {
      // ESC — possibly an arrow-key sequence.
      if (i + 1 >= n) break; // wait — could be the start of a sequence
      const b1 = buf[i + 1];
      if (b1 === 0x5b || b1 === 0x4f) {
        // CSI (ESC [) / SS3 (ESC O). Consume the WHOLE sequence: parameter
        // bytes (0x30-0x3F) then intermediate bytes (0x20-0x2F), terminated by
        // a final byte (0x40-0x7E). Emit an arrow only for a BARE CSI/SS3
        // A/B/C/D — anything longer (modified arrows, bracketed paste, mouse
        // reports) is consumed and ignored, not leaked byte-by-byte.
        let j = i + 2;
        while (j < n && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
        while (j < n && buf[j] >= 0x20 && buf[j] <= 0x2f) j++;
        if (j >= n) break; // incomplete — wait for the final byte
        const f = buf[j];
        const dir =
          j === i + 2
            ? f === 0x41 ? 'up' : f === 0x42 ? 'down' : f === 0x43 ? 'right' : f === 0x44 ? 'left' : null
            : null;
        if (dir) events.push({ type: 'arrow', dir });
        i = j + 1; // consume through the final byte
        continue;
      }
      events.push({ type: 'escape' });
      i += 1;
      continue;
    }

    if (b === 13) {
      events.push({ type: 'enter' });
      i += 1;
      if (i < n && (buf[i] === 10 || buf[i] === 0)) i += 1; // swallow LF / NUL after CR
      continue;
    }
    if (b === 10) {
      events.push({ type: 'enter' });
      i += 1;
      continue;
    }
    if (b === 3) {
      events.push({ type: 'ctrlc' });
      i += 1;
      continue;
    }
    if (b === 9) {
      events.push({ type: 'tab' });
      i += 1;
      continue;
    }
    if (b === 8 || b === 127) {
      // Backspace / DEL — normalized to DEL for the filter-capture editor.
      events.push({ type: 'char', ch: '\x7f' });
      i += 1;
      continue;
    }
    if (b >= 32 && b < 127) {
      events.push({ type: 'char', ch: String.fromCharCode(b) });
      i += 1;
      continue;
    }
    i += 1; // skip other control bytes
  }
  return { events, rest: buf.subarray(i) };
}

export interface TelnetServerOptions {
  /** The shared, timer-refreshed data provider (created once in index.ts). */
  data: DataProvider;
  host: string;
  port: number;
  log: (msg: string) => void;
  /** Initial signal-unit default passed through to each session. */
  signalDisplay?: 'margin' | 'dbm';
  /** Login policy. Telnet is always direct LAN — never trusted — so an enabled
   *  policy always gates it. */
  auth?: AuthPolicy;
  /** Mutating-action runner (v0.3), present only when write_actions_enabled. */
  actions?: ActionRunner;
  /**
   * Read-inactivity timeout and TCP keepalive, in ms. Production never sets
   * these — the defaults below are the shipped values. They exist so tests can
   * drive the reclaim path with a short timeout instead of asserting that a
   * line of source exists, which is what the v0.24.4 test did: deleting BOTH
   * `setKeepAlive` and `setTimeout` left all 497 tests green.
   */
  idleTimeoutMs?: number;
  keepAliveMs?: number;
}

/** Concurrent telnet connection cap — bounds resource use (and, with the login
 *  gate, the number of in-flight credential checks). Mirrors the ws console. */
const MAX_TELNET_CONNS = 16;
/**
 * Per-source-IP cap. Without it, ONE host could take every slot: the global cap
 * is all that stood between a single LAN machine and a total denial of the TUI
 * to every operator.
 */
const MAX_CONNS_PER_IP = 4;
/**
 * Reclaim a socket that goes quiet. A peer that connects and then sends nothing
 * — never even negotiating telnet — used to hold its slot FOREVER: no
 * setTimeout, no keepalive, and the only timers on a connection were the 60 ms
 * ESC flush and the 1 Hz redraw, neither of which reclaims anything. 16 silent
 * sockets denied the TUI permanently. Generous, because a legitimate operator
 * may sit and watch a screen for a long time without typing — the 1 Hz redraw
 * writes to the socket but does not reset a READ timeout, so this must be long
 * enough not to evict someone who is simply reading.
 */
const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Detect half-open peers (yanked cable, NAT drop) that never send a FIN. */
const KEEPALIVE_MS = 60_000;

export const REFUSE_LINGER_MS = 1_000;

/**
 * Say goodbye to a refused socket, then TAKE THE FD BACK.
 *
 * `end()` is a HALF-close: it sends our FIN and leaves the descriptor ours
 * until the peer closes its own side. A refused socket also joins no `conns`
 * set, so neither the active counter nor the idle sweep can ever see it — the
 * one branch whose entire job is to SHED load was the one that leaked.
 *
 * Module scope, and the socket is a narrow structural type, because the
 * invariant here has NO observable on the wire: a peer cannot distinguish a
 * half-closed server from a destroyed one, so the only honest place to assert
 * it is against the decision itself.
 */
export function refuseSocket(
  socket: Pick<Socket, 'end' | 'destroy' | 'once'>,
  msg: string,
  lingerMs: number = REFUSE_LINGER_MS,
): void {
  // Bounds a peer that stalls the flush by never reading.
  const kill = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, lingerMs);
  // Do not hold the process open for a socket we are discarding.
  kill.unref?.();
  // A peer that closes on cue costs us nothing — do not fire a stray destroy.
  socket.once('close', () => clearTimeout(kill));
  try { socket.end(msg); } catch { /* ignore */ }
}

export function startTelnetServer(opts: TelnetServerOptions): { stop: () => void } {
  const { data, host, port, log, signalDisplay, auth, actions } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  const conns = new Set<TelnetConn>();

  const safeWrite = (socket: Socket, payload: string | Buffer) => {
    try {
      if (!socket.destroyed && socket.writable) socket.write(payload);
    } catch {
      /* peer vanished mid-write — the close handler will clean up */
    }
  };

  const endConn = (conn: TelnetConn) => {
    if (!conns.has(conn)) return;
    conns.delete(conn);
    // A SESSION'S END IS ON THE RECORD (v0.50.0). 165 "client connected" lines
    // in the corpus and ZERO teardown lines: no session's end, duration or
    // cause of death was recorded anywhere, so "are connections accumulating"
    // could only be answered by reading a counter on the NEXT connect line —
    // and a session that ended silently was indistinguishable from one still
    // open. The remaining count is the number that answers the leak question
    // directly.
    log(`telnet: client ${conn.ip} disconnected after ${fmtElapsed(Date.now() - conn.openedAt)} (${conns.size} active)`);
    if (conn.timer) {
      clearInterval(conn.timer);
      conn.timer = null;
    }
    if (conn.escTimer) {
      clearTimeout(conn.escTimer);
      conn.escTimer = null;
    }
    try {
      if (!conn.socket.destroyed) {
        // Restore the user's primary screen buffer + cursor on exit so their
        // terminal returns to whatever was visible before they ran `telnet`.
        // Without ?1049l the alt-buffer remains active and they'd see a blank
        // terminal until they manually re-enter primary mode.
        conn.socket.write(SHOW_CURSOR + RESET + EXIT_ALT_BUFFER + '\r\n');
        conn.socket.end();
      }
    } catch {
      /* ignore */
    }
  };

  const onData = (conn: TelnetConn, chunk: Buffer) => {
    // New bytes arrived — any pending lone-ESC was actually the start of a
    // sequence, so cancel its idle flush.
    if (conn.escTimer) { clearTimeout(conn.escTimer); conn.escTimer = null; }
    conn.inbuf = conn.inbuf.length ? Buffer.concat([conn.inbuf, chunk]) : chunk;
    if (conn.inbuf.length > 4096) conn.inbuf = conn.inbuf.subarray(conn.inbuf.length - 64); // drop runaway garbage
    const { events, rest } = parseInput(conn.inbuf);
    conn.inbuf = Buffer.from(rest);
    const r = conn.session.feed(events);
    if (r.quit) {
      endConn(conn);
      return;
    }
    if (r.redraw) conn.session.draw();
    // parseInput holds back a lone trailing ESC (it can't yet tell a bare Escape
    // keypress from the start of an arrow sequence). Flush it as a real Escape
    // after a short idle so a single Esc isn't dead until the next keystroke.
    if (conn.inbuf.length === 1 && conn.inbuf[0] === 0x1b) {
      conn.escTimer = setTimeout(() => {
        conn.escTimer = null;
        if (!(conn.inbuf.length === 1 && conn.inbuf[0] === 0x1b)) return;
        conn.inbuf = Buffer.alloc(0);
        const rr = conn.session.feed([{ type: 'escape' }]);
        if (rr.quit) { endConn(conn); return; }
        if (rr.redraw) conn.session.draw();
      }, 60);
    }
  };

  /**
   * Refuse a connection and RECLAIM IT ON OUR SCHEDULE (v0.50.0).
   *
   * Both cap branches used to `socket.end(...)` and return. That is a
   * HALF-close: our write side shuts down, but the readable half and the file
   * descriptor stay ours until the PEER sends FIN. And because the refusal
   * returns before `setKeepAlive` and never joins `conns`, the kernel never
   * probes the peer and the idle sweep — which walks `conns` — can never see
   * it. A peer that simply never closes (an attacker, or a half-open host whose
   * NAT entry expired) pinned one fd per refusal, without limit, on the exact
   * branch whose job is to SHED load. Measured live at v0.49.1: 30 sockets held
   * against 4 accepted sessions.
   *
   * Say goodbye, then take it back.
   */
  const refuse = (socket: Socket, why: string, msg: string): void => {
    log(why);
    refuseSocket(socket, msg);
  };

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    // Attach an error listener IMMEDIATELY. A socket that errors (e.g. RST) with
    // no 'error' listener throws an uncaught exception that would crash the whole
    // add-on — this must exist before the cap-refuse `end()` and before the
    // per-connection handlers below.
    socket.on('error', () => { /* connection errors are handled by close/endConn */ });
    // Reject beyond the connection cap before doing any per-session work.
    if (conns.size >= MAX_TELNET_CONNS) {
      refuse(socket, `telnet: connection cap (${MAX_TELNET_CONNS}) reached — refusing ${socket.remoteAddress ?? '?'}`,
        'Too many connections — try again later.\r\n');
      return;
    }
    // Per-IP cap: the global cap alone let ONE host starve every operator.
    const peerIp = socket.remoteAddress ?? '?';
    let sameIp = 0;
    for (const c of conns) if (c.ip === peerIp) sameIp += 1;
    if (sameIp >= MAX_CONNS_PER_IP) {
      refuse(socket, `telnet: per-IP cap (${MAX_CONNS_PER_IP}) reached — refusing ${peerIp}`,
        'Too many connections from your address — try again later.\r\n');
      return;
    }
    // Half-open peers (yanked cable, expired NAT entry) never send a FIN, so
    // ask the kernel to probe them.
    socket.setKeepAlive(true, keepAliveMs);
    // NOTE: the idle reclaim is the `sweep` interval below, NOT
    // `socket.setTimeout`. v0.24.4 used setTimeout and claimed in a comment
    // that it "fires on READ inactivity, so the server's own 1 Hz redraw does
    // not keep a dead socket alive". That is not how Node behaves: the socket
    // timer is reset by reads AND writes, so the redraw refreshed it forever
    // and the timeout could never fire. The feature was inert from the day it
    // shipped, and the test that covered it only grepped for the source line.
    const session = new TuiSession({
      write: (payload) => safeWrite(socket, payload),
      data,
      signalDisplay,
      log,
      auth,
      actions,
      trusted: false, // telnet is direct LAN — never HA-authenticated
      peer: peerIp,
      onClose: () => { try { socket.end(); } catch { /* already gone */ } },
    });
    const conn: TelnetConn = { socket, ip: peerIp, session, inbuf: Buffer.alloc(0), timer: null, escTimer: null, lastRxAt: Date.now(), openedAt: Date.now() };
    conns.add(conn);
    log(`telnet: client connected from ${socket.remoteAddress ?? '?'} (${conns.size} active)`);

    // Negotiate character-at-a-time mode + ask for the window size.
    socket.write(
      Buffer.from([
        IAC, WILL, OPT_ECHO,
        IAC, WILL, OPT_SGA,
        IAC, DO, OPT_SGA,
        IAC, DO, OPT_NAWS,
      ]),
    );
    // Enter alt-screen buffer so we don't pollute the user's scrollback and our
    // frame boundaries can't smear into earlier output.
    safeWrite(socket, ENTER_ALT_BUFFER + HIDE_CURSOR + CLEAR_SCREEN);
    session.draw();
    conn.timer = setInterval(() => session.draw(), 1000);

    // node:net never delivers strings on a socket without setEncoding(); the
    // @types/node ≥ 22.19 union of `string | Buffer` is a theoretical-only
    // possibility for our setup, so coerce to keep the inner signature tight.
    socket.on('data', (d) => { conn.lastRxAt = Date.now(); onData(conn, d as Buffer); });
    socket.on('close', () => endConn(conn));
    socket.on('error', () => endConn(conn));
  });

  server.on('error', (e: any) => log(`telnet: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  // Reclaim connections that have RECEIVED nothing for idleTimeoutMs. Runs on
  // its own cadence rather than per-socket so one timer covers every peer.
  // unref()'d so it can never hold the process open on its own.
  const sweepMs = Math.min(60_000, Math.max(50, Math.floor(idleTimeoutMs / 2)));
  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const conn of [...conns]) {
      if (conn.lastRxAt > cutoff) continue;
      log(`telnet: idle ${idleTimeoutMs}ms with no inbound data — closing ${conn.ip}`);
      endConn(conn);
    }
  }, sweepMs);
  sweep.unref?.();

  return {
    stop: () => {
      clearInterval(sweep);
      for (const conn of [...conns]) endConn(conn);
      server.close();
    },
  };
}
