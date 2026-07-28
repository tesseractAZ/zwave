/**
 * Origin / trust helpers for the HTTP + WebSocket surface.
 *
 *   • `buildSameOrigins` + `isAllowedOrigin` — the CORS allow-list, also used
 *     by the `/console/ws` upgrade to block cross-site WebSocket hijacking.
 *   • `pinSupervisorAddress` + `isSupervisorSource` — the Ingress trust
 *     boundary: whether a request genuinely came from the HA Supervisor.
 *
 * ★ v0.24.4 REMOVED a write-token gate (`requireWriteAuth`, `tokenEquals`,
 *   `loadOrCreateWriteToken`) that this docstring used to describe in detail as
 *   protecting "any mutating HTTP command route". There are no mutating HTTP
 *   routes — every action goes through the TUI, gated by `write_actions_enabled`
 *   plus a typed CONFIRM. The gate was registered on ZERO routes and
 *   `tokenEquals` had no caller, yet the bootstrap still wrote a long-lived
 *   secret to /data on every boot. A control that authorises nothing while
 *   persisting a secret is worse than none: it implies a protection that does
 *   not exist. If HTTP write routes are ever added, bring the gate back
 *   TOGETHER with a test that asserts it 401s an unauthenticated request.
 *
 *   Existing installs may still have a stale `/data/zwave-write-token.txt`.
 *   It authorises nothing and can be deleted.
 */

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
 * True when the request's TCP peer is the HA Supervisor ITSELF.
 *
 * ★ This used to test the whole 172.30.32.0/23 hassio bridge — which is where
 *   EVERY sibling add-on container lives, not just the Supervisor. Because
 *   :8788 is ingress-only (not in `ports:`), every peer that can open the
 *   socket at all was already inside that /23, so
 *       !!headers['x-ingress-path'] && isSupervisorSource(req.ip)
 *   degenerated to "did the client send a header it chooses" — a control that
 *   could not fire. Any sibling add-on (or an SSRF in one) got a login-free
 *   operator session, and `trusted` sessions are also exempt from the idle
 *   re-lock. Verified by driving the real wiring from a 172.30.33.9 peer: full
 *   TUI, no login gate.
 *
 *   Now pinned to the addresses `supervisor` actually resolves to (the add-on
 *   already dials that host for the Core WebSocket, so it always resolves).
 *   Resolution failure FAILS CLOSED: nothing is treated as ingress, so the
 *   operator logs in as they would from the LAN.
 *
 * Because the Fastify server runs with trustProxy OFF, `req.ip` is the raw,
 * unspoofable socket peer — not a client-supplied X-Forwarded-For. So this
 * is what makes the (otherwise trivially forgeable) X-Ingress-Path header
 * meaningful: it is honoured ONLY when the peer is genuinely the Supervisor.
 */
/** Addresses `supervisor` resolves to. Empty until resolved ⇒ fail closed. */
const supervisorIps = new Set<string>();

/** Normalize Node's IPv4-mapped IPv6 form (::ffff:172.30.32.2). */
function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/**
 * Resolve the Supervisor's address(es) once at startup. Call before serving.
 * Returns the addresses pinned, so the caller can log what it trusts.
 */
export async function pinSupervisorAddress(
  log: (m: string) => void = () => {},
  lookup: (host: string) => Promise<string[]> = defaultLookup,
): Promise<string[]> {
  try {
    const ips = (await lookup('supervisor')).map(normalizeIp).filter(Boolean);
    supervisorIps.clear();
    for (const ip of ips) supervisorIps.add(ip);
    if (ips.length > 0) log(`auth: ingress trust pinned to supervisor at ${ips.join(', ')}`);
    else log('auth: supervisor did not resolve — ingress trust DISABLED (login required)');
    return ips;
  } catch (e) {
    supervisorIps.clear();
    log(`auth: supervisor lookup failed (${(e as Error).message}) — ingress trust DISABLED (login required)`);
    return [];
  }
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const rs = await lookup(host, { all: true });
  return rs.map((r) => r.address);
}

/** TEST SEAM: set the pinned addresses directly. */
export function setSupervisorAddressesForTest(ips: readonly string[]): void {
  supervisorIps.clear();
  for (const ip of ips) supervisorIps.add(normalizeIp(ip));
}

export function isSupervisorSource(ip: string | undefined | null): boolean {
  if (!ip) return false;
  if (supervisorIps.size === 0) return false; // unresolved ⇒ trust nothing
  return supervisorIps.has(normalizeIp(ip));
}

/* ─── preHandler factory ──────────────────────────────────────────── */

export interface Auth {
  /** Same-origin allow-list (add-on host + port + localhost + HA). */
  sameOrigins: Set<string>;
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
}

/** Build the origin allow-list and its CORS callback. Side-effect free. */
export function createAuth(opts: AuthOptions): Auth {
  const sameOrigins = buildSameOrigins(opts.host, opts.port);

  const corsOriginCallback = (
    origin: string | undefined,
    cb: (err: Error | null, allow: boolean) => void,
  ): void => {
    if (!origin) return cb(null, true); // same-origin, curl, server-side
    if (isAllowedOrigin(origin, sameOrigins)) return cb(null, true);
    return cb(null, false);
  };

  return { sameOrigins, corsOriginCallback };
}
