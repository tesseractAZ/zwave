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
import type { Socket } from 'node:net';
import type { DataProvider } from '../types';
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
}

/** Concurrent telnet connection cap — bounds resource use (and, with the login
 *  gate, the number of in-flight credential checks). Mirrors the ws console. */
const MAX_TELNET_CONNS = 16;

export function startTelnetServer(opts: TelnetServerOptions): { stop: () => void } {
  const { data, host, port, log, signalDisplay, auth } = opts;
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

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    // Attach an error listener IMMEDIATELY. A socket that errors (e.g. RST) with
    // no 'error' listener throws an uncaught exception that would crash the whole
    // add-on — this must exist before the cap-refuse `end()` and before the
    // per-connection handlers below.
    socket.on('error', () => { /* connection errors are handled by close/endConn */ });
    // Reject beyond the connection cap before doing any per-session work.
    if (conns.size >= MAX_TELNET_CONNS) {
      log(`telnet: connection cap (${MAX_TELNET_CONNS}) reached — refusing ${socket.remoteAddress ?? '?'}`);
      try { socket.end('Too many connections — try again later.\r\n'); } catch { /* ignore */ }
      return;
    }
    const session = new TuiSession({
      write: (payload) => safeWrite(socket, payload),
      data,
      signalDisplay,
      log,
      auth,
      trusted: false, // telnet is direct LAN — never HA-authenticated
      peer: socket.remoteAddress ?? '?',
      onClose: () => { try { socket.end(); } catch { /* already gone */ } },
    });
    const conn: TelnetConn = { socket, session, inbuf: Buffer.alloc(0), timer: null, escTimer: null };
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
    socket.on('data', (d) => onData(conn, d as Buffer));
    socket.on('close', () => endConn(conn));
    socket.on('error', () => endConn(conn));
  });

  server.on('error', (e: any) => log(`telnet: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  return {
    stop: () => {
      for (const conn of [...conns]) endConn(conn);
      server.close();
    },
  };
}
