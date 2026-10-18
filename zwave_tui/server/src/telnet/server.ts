/**
 * SSH control-room TUI server for the Z-Wave TUI add-on (v0.77.0; telnet until
 * v0.76.1).
 *
 * Each login gets the live, keyboard-driven Z-Wave mesh dashboard rendered with
 * ANSI, over an encrypted channel. Logins use the login gate's own users
 * (`auth_enabled`, `users`; auth/loginPolicy.ts), password only, with its
 * per-peer backoff. With the gate off, or no user configured, every login is
 * refused and the add-on log says why: an SSH port that admits anyone would
 * only look safer than the telnet port it replaces.
 *
 * TCP stays ours: a plain `net` server applies the connection caps, keep-alive
 * and the idle reclaim before handing each socket to ssh2 (`injectSocket`), so
 * a refused or abandoned peer is closed on our schedule, never on the peer's.
 * The host key (ed25519) is generated once and kept in /data; its fingerprint
 * is logged at every start, to compare with what a client shows on first
 * connect.
 *
 * Bind host is `::` (dual-stack). Gated by `config.ssh.enabled` at the call
 * site (index.ts): when off, this server is never started.
 */
import { createServer, type Socket } from 'node:net';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import type { AuthContext, Connection, ParsedKey, ServerChannel } from 'ssh2';
import type { LogSink } from '../logger';
import { fmtElapsed } from './gauges';
import type { DataProvider, ActionRunner } from '../types';
import type { AuthPolicy } from '../auth/loginPolicy';
import { TuiSession } from './session';
import type { SessionEvent } from './session';
import {
  HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN, RESET,
  ENTER_ALT_BUFFER, EXIT_ALT_BUFFER,
} from './ansi';

const { Server: SshServer, utils: sshUtils } = ssh2;

interface SshConn {
  socket: Socket;
  /** Source address, kept for the per-IP connection cap and the login backoff. */
  ip: string;
  /** Epoch ms of the last byte RECEIVED on the connection (keystrokes, window
   *  changes, the client's keep-alives). Writes never count: the 1 Hz redraw
   *  must not keep an absent peer alive. */
  lastRxAt: number;
  /** Epoch ms the TCP connection was accepted (for the teardown line). */
  openedAt: number;
  client: Connection | null;
  /** The login gate's username once authenticated; never logged. */
  user: string | null;
  stream: ServerChannel | null;
  session: TuiSession | null;
  inbuf: Buffer;
  timer: NodeJS.Timeout | null;
  /** Idle-flush timer for a lone trailing ESC byte (see onData). */
  escTimer: NodeJS.Timeout | null;
  /** The gate-off refusal is logged once per connection, not per attempt. */
  gateNoted: boolean;
  closed: boolean;
}

/**
 * Parse a raw input buffer into transport-agnostic key events. An incomplete
 * trailing escape sequence is returned in `rest`, to be prepended to the next
 * chunk. (Until v0.77.0 this also stripped telnet IAC sequences; SSH delivers
 * the terminal's bytes as they are, and its window size out of band.)
 */
export function parseInput(buf: Buffer): { events: SessionEvent[]; rest: Buffer } {
  const events: SessionEvent[] = [];
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i];

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

export interface SshServerOptions {
  data: DataProvider;
  host: string;
  port: number;
  log: LogSink;
  /** The host key, OpenSSH format (see loadOrCreateHostKey). */
  hostKey: string;
  signalDisplay?: 'margin' | 'dbm';
  auth?: AuthPolicy;
  actions?: ActionRunner;
  /** Close a connection that has RECEIVED nothing for this long (default 30 min). */
  idleTimeoutMs?: number;
  keepAliveMs?: number;
}

/** Concurrent connection caps: the global one bounds resource use, the per-IP
 *  one keeps a single host from starving every operator. */
const MAX_CONNS = 16;
const MAX_CONNS_PER_IP = 4;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const KEEPALIVE_MS = 60_000;

/** How long a refused socket may linger before it is destroyed (v0.50.0). */
export const REFUSE_LINGER_MS = 1_000;

/**
 * Refuse a connection and RECLAIM IT ON OUR SCHEDULE (v0.50.0): `end()` alone
 * is a half-close, and a peer that never sends FIN pinned one descriptor per
 * refusal on the very branch whose job is to shed load. Say goodbye, then take
 * it back.
 */
export function refuseSocket(
  socket: Pick<Socket, 'end' | 'destroy' | 'once'>,
  msg: string,
  lingerMs: number = REFUSE_LINGER_MS,
): void {
  const kill = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } }, lingerMs);
  kill.unref?.();
  socket.once('close', () => clearTimeout(kill));
  try { socket.end(msg); } catch { /* ignore */ }
}

/** The SHA256 fingerprint of a host key, as `ssh` and `ssh-keygen -lf` print it. */
export function hostKeyFingerprint(key: string): string {
  const parsed = sshUtils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  const k = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  return 'SHA256:' + createHash('sha256').update(k.getPublicSSH()).digest('base64').replace(/=+$/, '');
}

/**
 * The host key at `path`, generated (ed25519) on first use and written 0600
 * through a rename. A file that does not parse is replaced, and the add-on log
 * says so: clients will warn that the host key changed.
 */
export function loadOrCreateHostKey(path: string, log: LogSink): { key: string; fingerprint: string } {
  if (existsSync(path)) {
    try {
      const key = readFileSync(path, 'utf8');
      return { key, fingerprint: hostKeyFingerprint(key) };
    } catch (e) {
      (log.warn ?? log)(`ssh: the host key at ${path} could not be read (${(e as Error).message}) — generating a new one; clients will warn that the host key changed`);
    }
  }
  const key = sshUtils.generateKeyPairSync('ed25519').private;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  renameSync(tmp, path);
  const fingerprint = hostKeyFingerprint(key);
  log(`ssh: generated a new host key (${fingerprint})`);
  return { key, fingerprint };
}

export function startSshServer(opts: SshServerOptions): { stop: () => void } {
  const { data, host, port, log, signalDisplay, auth, actions } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_MS;
  const conns = new Set<SshConn>();
  /** Sockets handed to ssh2 and not yet matched to its connection, by peer address:port. */
  const pending = new Map<string, SshConn>();

  const write = (conn: SshConn, payload: string): void => {
    try {
      if (conn.stream && !conn.stream.destroyed && conn.stream.writable) conn.stream.write(payload);
    } catch { /* peer vanished mid-write — the close handler cleans up */ }
  };

  const endConn = (conn: SshConn): void => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    for (const [k, c] of pending) if (c === conn) pending.delete(k);
    log(`ssh: client ${conn.ip} disconnected after ${fmtElapsed(Date.now() - conn.openedAt)} (${conns.size} active)`);
    if (conn.timer) { clearInterval(conn.timer); conn.timer = null; }
    if (conn.escTimer) { clearTimeout(conn.escTimer); conn.escTimer = null; }
    if (conn.stream) {
      write(conn, SHOW_CURSOR + RESET + EXIT_ALT_BUFFER + '\r\n');
      try { conn.stream.exit(0); conn.stream.end(); } catch { /* ignore */ }
    }
    try { conn.client?.end(); } catch { /* ignore */ }
    refuseSocket(conn.socket, '');
  };

  const onData = (conn: SshConn, chunk: Buffer): void => {
    const session = conn.session;
    if (!session) return;
    if (conn.escTimer) { clearTimeout(conn.escTimer); conn.escTimer = null; }
    conn.inbuf = conn.inbuf.length ? Buffer.concat([conn.inbuf, chunk]) : chunk;
    if (conn.inbuf.length > 4096) conn.inbuf = conn.inbuf.subarray(conn.inbuf.length - 64); // drop runaway garbage
    const { events, rest } = parseInput(conn.inbuf);
    conn.inbuf = Buffer.from(rest);
    const r = session.feed(events);
    if (r.quit) { endConn(conn); return; }
    if (r.redraw) session.draw();
    // A lone ESC is the Escape key unless more bytes follow within 60 ms.
    if (conn.inbuf.length === 1 && conn.inbuf[0] === 0x1b) {
      conn.escTimer = setTimeout(() => {
        conn.escTimer = null;
        if (!(conn.inbuf.length === 1 && conn.inbuf[0] === 0x1b)) return;
        conn.inbuf = Buffer.alloc(0);
        const rr = session.feed([{ type: 'escape' }]);
        if (rr.quit) { endConn(conn); return; }
        if (rr.redraw) session.draw();
      }, 60);
    }
  };

  /** Password only, against the login gate's users, with its per-peer backoff.
   *  Usernames are never logged: a password typed into that field would be. */
  const authenticate = async (conn: SshConn, ctx: AuthContext): Promise<void> => {
    if (!auth?.enabled || !auth.hasUsers()) {
      if (!conn.gateNoted) {
        conn.gateNoted = true;
        (log.warn ?? log)(`ssh: login from ${conn.ip} refused — the login gate is off or has no users; turn on auth_enabled and add a user`);
      }
      ctx.reject([]);
      return;
    }
    if (ctx.method !== 'password') { ctx.reject(['password']); return; }
    const wait = auth.blockedMsFor(conn.ip);
    if (wait > 0) {
      log(`ssh: login from ${conn.ip} refused — backing off ${Math.ceil(wait / 1000)} s after failed attempts`);
      ctx.reject(['password']);
      return;
    }
    const ok = await auth.verify(ctx.username, ctx.password);
    if (conn.closed) return;
    if (ok) {
      auth.registerSuccess(conn.ip);
      conn.user = ctx.username;
      ctx.accept();
      return;
    }
    auth.registerFailure(conn.ip);
    log(`ssh: failed login from ${conn.ip}${auth.knows(ctx.username) ? '' : ' (unknown user)'}`);
    ctx.reject(['password']);
  };

  /** One terminal per connection: a pty (optional — 80×24 without one), then a
   *  shell. exec, subsystems (sftp) and port forwarding are refused. */
  const onSession = (conn: SshConn, accept: () => import('ssh2').Session): void => {
    const sess = accept();
    let w = 80;
    let h = 24;
    sess.on('pty', (ok, _no, info) => { w = info.cols || w; h = info.rows || h; ok?.(); });
    sess.on('window-change', (ok, _no, info) => {
      ok?.();
      if (conn.session && info.cols && info.rows) {
        const r = conn.session.feed([{ type: 'resize', w: info.cols, h: info.rows }]);
        if (r.redraw) conn.session.draw();
      }
    });
    sess.on('exec', (_ok, no) => no?.());
    sess.on('subsystem', (_ok, no) => no?.());
    sess.on('shell', (ok, no) => {
      if (conn.session || conn.closed) { no?.(); return; }
      const stream = ok();
      conn.stream = stream;
      conn.session = new TuiSession({
        write: (payload) => write(conn, payload),
        data,
        width: w,
        height: h,
        signalDisplay,
        log,
        auth,
        actions,
        trusted: false, // direct LAN — never HA-authenticated
        preAuthenticated: true, // SSH checked the login gate's credentials
        peer: conn.ip,
        onClose: () => endConn(conn),
      });
      write(conn, ENTER_ALT_BUFFER + HIDE_CURSOR + CLEAR_SCREEN);
      conn.session.draw();
      conn.timer = setInterval(() => conn.session?.draw(), 1000);
      stream.on('data', (d: Buffer) => onData(conn, d));
      stream.on('close', () => endConn(conn));
      stream.on('error', () => endConn(conn));
    });
  };

  const ssh = new SshServer({ hostKeys: [opts.hostKey], ident: 'zwave-tui' }, (client, info) => {
    client.on('error', () => { /* handled by close */ });
    const conn = pending.get(`${info.ip}|${info.port}`);
    if (!conn || conn.closed) { client.end(); return; }
    pending.delete(`${info.ip}|${info.port}`);
    conn.client = client;
    client.on('authentication', (ctx) => { void authenticate(conn, ctx); });
    client.on('ready', () => {
      log(`ssh: login from ${conn.ip} (${conns.size} active)`);
      client.on('session', (accept) => onSession(conn, accept));
    });
    client.on('close', () => endConn(conn));
  });
  ssh.on('error', () => { /* per-connection errors end that connection */ });

  const refuse = (socket: Socket, why: string): void => {
    log(why);
    refuseSocket(socket, '');
  };

  const server = createServer((socket) => {
    // An error listener FIRST: an RST on a socket with none crashes the add-on.
    socket.on('error', () => { /* handled by close */ });
    socket.setNoDelay(true);
    const ip = socket.remoteAddress ?? '?';
    if (conns.size >= MAX_CONNS) { refuse(socket, `ssh: connection cap (${MAX_CONNS}) reached — refusing ${ip}`); return; }
    let sameIp = 0;
    for (const c of conns) if (c.ip === ip) sameIp += 1;
    if (sameIp >= MAX_CONNS_PER_IP) { refuse(socket, `ssh: per-IP cap (${MAX_CONNS_PER_IP}) reached — refusing ${ip}`); return; }
    // Half-open peers (yanked cable, expired NAT entry) never send a FIN.
    socket.setKeepAlive(true, keepAliveMs);
    const conn: SshConn = { socket, ip, lastRxAt: Date.now(), openedAt: Date.now(), client: null, user: null, stream: null, session: null, inbuf: Buffer.alloc(0), timer: null, escTimer: null, gateNoted: false, closed: false };
    conns.add(conn);
    log(`ssh: client connected from ${ip} (${conns.size} active)`);
    pending.set(`${ip}|${socket.remotePort}`, conn);
    socket.once('close', () => endConn(conn));
    socket.on('data', () => { conn.lastRxAt = Date.now(); });
    ssh.injectSocket(socket);
  });

  // A listen failure means the LAN port never opened, and nothing else says so.
  server.on('error', (e: Error) => (log.error ?? log)(`ssh: server error: ${e?.message ?? e}`));
  server.listen(port, host);

  // Reclaim connections that have RECEIVED nothing for idleTimeoutMs, including
  // ones that never finished logging in. One timer covers every peer.
  const sweepMs = Math.min(60_000, Math.max(50, Math.floor(idleTimeoutMs / 2)));
  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const conn of [...conns]) {
      if (conn.lastRxAt > cutoff) continue;
      log(`ssh: idle ${idleTimeoutMs}ms with no inbound data — closing ${conn.ip}`);
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
