/**
 * Write-auth gate + origin allow-list for the Z-Wave TUI add-on.
 *
 * Adapted from ecoflow-panel's auth.ts. Z-Wave TUI is read-only in v0.1
 * (`write_actions_enabled` defaults false), but the same gate protects two
 * surfaces so it's in place before any mutating route ships:
 *
 *   • Any mutating HTTP command route (ping / heal / rebuild — phase 3),
 *     registered with `requireWriteAuth` as a Fastify preHandler.
 *   • The `/console/ws` xterm.js WebSocket upgrade, which `isAllowedOrigin`
 *     gates against cross-origin hijacking.
 *
 * `requireWriteAuth` accepts a request when ANY of three conditions hold:
 *
 *   1. HA Ingress — the Supervisor sets `X-Ingress-Path`, which can't be
 *      forged from outside the hassio network, AND the TCP peer is in the
 *      Supervisor subnet (172.30.32.0/23). Both must hold: the header alone
 *      is forgeable by anything reaching the directly-published LAN port.
 *   2. Same-origin — the ingress UI fetching its own backend.
 *   3. Explicit token — the `X-Zwave-Write-Token` header (constant-time cmp).
 *
 * NOTE: the telnet TUI (:2324) and the `/console` terminal are deliberately
 * UNAUTHENTICATED on the LAN — this module gates only mutating HTTP routes
 * and the ws upgrade. Actuating the mesh is additionally gated by
 * WRITE_ACTIONS_ENABLED at the action layer.
 *
 * The module is side-effect-free at import; token bootstrap runs only when
 * `createAuth` is called.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Build the add-on's same-origin allow-list from host + port. Used by both
 * CORS and the same-origin check. Covers localhost / 127.0.0.1 / the
 * configured hostname / homeassistant.local on both http and https.
 */
export function buildSameOrigins(host: string, port: number): Set<string> {
  return new Set<string>([
    `http://${host}:${port}`,
    `https://${host}:${port}`,
    `http://homeassistant.local:${port}`,
    `https://homeassistant.local:${port}`,
    `http://localhost:${port}`,
    `https://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://127.0.0.1:${port}`,
  ]);
}

/** HA dashboard origins we expect ingress / browsers to come from. */
export const HA_DASHBOARD_ORIGINS = new Set<string>([
  'http://homeassistant.local:8123',
  'https://homeassistant.local:8123',
  'http://homeassistant:8123',
  'https://homeassistant:8123',
  'http://homeassistant.local:8788',
  'https://homeassistant.local:8788',
]);

/**
 * Matches LAN-style HA hosts: 10.x / 127.x / 192.168.x / 172.16-31.x /
 * `*.local` — on ports 8123 or 8788 only. Intentionally narrow — we don't
 * want to match arbitrary internet origins.
 */
export const LAN_ORIGIN_RE =
  /^https?:\/\/(?:(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9-]+\.local):(?:8123|8788)$/;

/** CORS allow-list check — used by the @fastify/cors origin callback and /console/ws. */
export function isAllowedOrigin(origin: string, sameOrigins: Set<string>): boolean {
  if (sameOrigins.has(origin)) return true;
  if (HA_DASHBOARD_ORIGINS.has(origin)) return true;
  if (LAN_ORIGIN_RE.test(origin)) return true;
  return false;
}

/**
 * True when the request's TCP peer is the HA Supervisor (the hassio docker
 * network, 172.30.32.0/23). Genuine Ingress traffic ALWAYS originates from the
 * Supervisor; a request arriving on the directly-published :8788 LAN port
 * presents the real client IP instead.
 *
 * Because the Fastify server runs with trustProxy OFF, `req.ip` is the raw,
 * unspoofable socket peer — not a client-supplied X-Forwarded-For. So this
 * lets `requireWriteAuth` honor the (otherwise trivially forgeable)
 * X-Ingress-Path header ONLY when the request genuinely came through the
 * Supervisor, closing the LAN-forge bypass.
 */
export function isSupervisorSource(ip: string | undefined | null): boolean {
  if (!ip) return false;
  // Node reports IPv4-mapped IPv6 as ::ffff:172.30.32.2 — normalize it.
  const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  // hassio supervisor network 172.30.32.0/23 → 172.30.32.* and 172.30.33.*
  return /^172\.30\.3[23]\.\d{1,3}$/.test(v4);
}

/* ─── token bootstrap ─────────────────────────────────────────────── */

export interface TokenLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Read ZWAVE_WRITE_TOKEN from env; auto-generate + persist if missing.
 * Stored mode-0600 at the supplied path so it survives restarts and is
 * readable only by the add-on user.
 *
 * Returns the resolved token. Logger is optional — when omitted (e.g. from
 * tests) log messages are silently swallowed.
 */
export function loadOrCreateWriteToken(
  writeTokenPath: string,
  log: TokenLogger = { info: () => {}, warn: () => {} },
): string {
  const envTok = process.env.ZWAVE_WRITE_TOKEN;
  if (envTok && envTok.length >= 16) return envTok;
  // TOCTOU hardening (CodeQL js/file-system-race): read directly instead of
  // exists→read→write — ENOENT lands in the same catch the old existsSync
  // false-branch skipped to, so absent/unreadable/too-short all regenerate.
  try {
    const t = readFileSync(writeTokenPath, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {
    /* fall through to regenerate */
  }
  const fresh = randomUUID();
  try {
    mkdirSync(dirname(writeTokenPath), { recursive: true });
    writeFileSync(writeTokenPath, fresh + '\n', { mode: 0o600 });
    try {
      chmodSync(writeTokenPath, 0o600);
    } catch {
      /* best-effort */
    }
    log.info(
      `zwave-tui: write-token auto-generated and saved to ${writeTokenPath} — ` +
        `required for write endpoints from cross-origin clients`,
    );
  } catch (e: any) {
    log.warn(
      `zwave-tui: could not persist write-token to ${writeTokenPath}: ` +
        `${e?.message ?? e}. Token still active in memory for this run.`,
    );
  }
  return fresh;
}

/**
 * Constant-time string compare; safe for unequal lengths.
 *
 * When the lengths differ we still perform a same-length timingSafeEqual
 * against a zero scratch buffer so the function runs in length-independent
 * time — without that branch an attacker could probe the token length by
 * measuring response time.
 */
export function tokenEquals(provided: string, expectedBuf: Buffer): boolean {
  const b = Buffer.from(provided, 'utf8');
  if (b.length !== expectedBuf.length) {
    const scratch = Buffer.alloc(expectedBuf.length);
    timingSafeEqual(expectedBuf, scratch);
    return false;
  }
  return timingSafeEqual(expectedBuf, b);
}

/* ─── preHandler factory ──────────────────────────────────────────── */

export interface Auth {
  /** The resolved write token (env-provided or auto-generated). */
  token: string;
  /** Absolute path the token was persisted to. */
  tokenPath: string;
  /** Same-origin allow-list (add-on host + port + localhost + HA). */
  sameOrigins: Set<string>;
  /** Pre-built buffer for constant-time compare. */
  tokenBuf: Buffer;
  /** The Fastify preHandler that enforces write auth. */
  requireWriteAuth: (
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => void;
  /** CORS origin callback for `@fastify/cors`. */
  corsOriginCallback: (
    origin: string | undefined,
    cb: (err: Error | null, allow: boolean) => void,
  ) => void;
}

export interface AuthOptions {
  /** Add-on host (defaults to env HOST or "::"). */
  host: string;
  /** Add-on port. */
  port: number;
  /** Directory to persist the auto-generated token under (default /data). */
  dataDir?: string;
  /** Optional logger (defaults to silent — tests skip the chatter). */
  log?: TokenLogger;
}

/**
 * Build the auth object — runs token bootstrap, prepares helpers, and returns
 * a ready-to-register preHandler. Side-effects (token file I/O) happen only
 * on this call, not at module import.
 */
export function createAuth(opts: AuthOptions): Auth {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? '/data';
  const tokenPath = resolve(dataDir, 'zwave-write-token.txt');
  const sameOrigins = buildSameOrigins(opts.host, opts.port);
  const token = loadOrCreateWriteToken(tokenPath, opts.log);
  const tokenBuf = Buffer.from(token, 'utf8');

  const requireWriteAuth = (
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ): void => {
    // 1. HA Ingress — the Supervisor sets X-Ingress-Path. That header ALONE is
    //    forgeable by anything reaching the directly-published :2324/LAN port,
    //    so we additionally pin the TCP source to the Supervisor network
    //    (req.ip is the unspoofable socket peer; trustProxy is off). Both must
    //    hold for the ingress bypass.
    if (req.headers['x-ingress-path'] && isSupervisorSource(req.ip)) return done();

    // 2. Same-origin: the ingress UI fetching its own backend.
    const origin = req.headers.origin?.toString();
    if (origin && sameOrigins.has(origin)) return done();

    // 3. Explicit token.
    const provided = req.headers['x-zwave-write-token']?.toString();
    if (provided && tokenEquals(provided, tokenBuf)) return done();

    reply.code(401).send({
      error: 'write-auth-required',
      hint: 'set X-Zwave-Write-Token header or use HA ingress',
    });
  };

  const corsOriginCallback = (
    origin: string | undefined,
    cb: (err: Error | null, allow: boolean) => void,
  ): void => {
    if (!origin) return cb(null, true); // same-origin, curl, server-side
    if (isAllowedOrigin(origin, sameOrigins)) return cb(null, true);
    return cb(null, false);
  };

  return { token, tokenPath, sameOrigins, tokenBuf, requireWriteAuth, corsOriginCallback };
}
