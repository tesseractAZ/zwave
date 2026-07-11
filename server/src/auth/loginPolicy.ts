/**
 * TUI login policy — username/password auth for the terminal interface.
 *
 * Users + passwords are set in the add-on configuration (the `users` list).
 * This module turns that config into a verifier. It is transport-agnostic:
 * both the telnet server and the xterm `/console` construct a `TuiSession`
 * with the policy, and the session renders a login gate before the TUI when
 * auth is required for that connection.
 *
 * TRUST MODEL
 *   • Over HA Ingress (the sidebar), Home Assistant has ALREADY authenticated
 *     the user — the add-on sees an `X-Ingress-Path` header from the Supervisor
 *     network. Such connections are "trusted" and skip the login unless
 *     `auth_require_on_ingress` is set.
 *   • Direct LAN access (telnet :2324) is NOT HA-authenticated, so it gets the
 *     login gate whenever `auth_enabled`.
 *
 * SECURITY PROPERTIES (hardened after an adversarial review)
 *   • Passwords are normalized to scrypt at startup, so `verify()` ALWAYS runs
 *     exactly one scrypt — a valid-username hit and a missing-username miss cost
 *     the same (no timing-based user enumeration), whether the operator
 *     configured a plaintext password or a `scrypt:<salt>:<hash>` string.
 *   • `verify()` is ASYNC (uses `crypto.scrypt`, not `scryptSync`) so credential
 *     checking never blocks the single Node event loop.
 *   • A shared per-peer throttle (`blockedMsFor`/`registerFailure`) enforces
 *     escalating backoff ACROSS connections, so dropping and reconnecting does
 *     not reset the brute-force budget.
 */

import { scrypt, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface UserRecord {
  username: string;
  /** Plaintext, or `scrypt:<saltHex>:<hashHex>`. Normalized to scrypt at build. */
  password: string;
}

export interface AuthPolicyConfig {
  enabled: boolean;
  requireOnIngress: boolean;
  users: UserRecord[];
  maxAttempts: number;
  idleLockMin: number;
}

export interface AuthPolicy {
  enabled: boolean;
  requireOnIngress: boolean;
  maxAttempts: number;
  /** Idle re-lock threshold in ms (0 = never). */
  idleLockMs: number;
  /** At least one usable user configured? */
  hasUsers(): boolean;
  /** Constant-cost async credential check (always runs exactly one scrypt). */
  verify(username: string, password: string): Promise<boolean>;
  /** Remaining backoff (ms) before `peer` may attempt a login again (0 = now). */
  blockedMsFor(peer: string): number;
  /** Record a failed attempt for `peer`; arms escalating backoff past maxAttempts. */
  registerFailure(peer: string): void;
  /** Clear a peer's failure record after a successful login. */
  registerSuccess(peer: string): void;
}

const SCRYPT_KEYLEN = 32;
/** Cap the throttle map so a flood of distinct peers can't grow it unbounded. */
const MAX_THROTTLE_ENTRIES = 4096;
/** Backoff once a peer passes maxAttempts: 5s, then doubling, capped at 5 min. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;

/** Promise wrapper over the non-blocking crypto.scrypt. */
function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

/** Parse the `users` option (a JSON array string from the run script). */
export function parseUsers(json: string | undefined | null): UserRecord[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: UserRecord[] = [];
  for (const u of raw) {
    if (u && typeof u === 'object') {
      const username = String((u as Record<string, unknown>).username ?? '').trim();
      const password = String((u as Record<string, unknown>).password ?? '');
      if (username.length > 0) out.push({ username, password });
    }
  }
  return out;
}

/** Build a scrypt hash string for a plaintext password. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Normalize a stored password to canonical `scrypt:salt:hash` form. */
function normalizeStored(password: string): string {
  return password.startsWith('scrypt:') ? password : hashPassword(password);
}

/** Verify a provided password against a stored `scrypt:salt:hash` value (async). */
async function verifyScrypt(provided: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scryptAsync(provided, salt, expected.length);
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createAuthPolicy(cfg: AuthPolicyConfig): AuthPolicy {
  // username → canonical scrypt hash (plaintext is hashed once, here at startup).
  const byName = new Map<string, string>();
  for (const u of cfg.users) {
    if (u.username && u.username.length > 0) byName.set(u.username, normalizeStored(u.password));
  }
  // A random real hash for the username-miss path — same scrypt cost as a hit,
  // so response time never reveals whether a username exists.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'));

  const maxAttempts = Number.isFinite(cfg.maxAttempts) ? Math.max(1, Math.floor(cfg.maxAttempts)) : 3;
  const idleLockMin = Number.isFinite(cfg.idleLockMin) ? Math.max(0, Math.floor(cfg.idleLockMin)) : 0;

  // peer IP → { fails, until }. Shared across telnet + console so reconnecting
  // does not reset the budget.
  const throttle = new Map<string, { fails: number; until: number }>();

  return {
    enabled: !!cfg.enabled,
    requireOnIngress: !!cfg.requireOnIngress,
    maxAttempts,
    idleLockMs: idleLockMin * 60_000,
    hasUsers: () => byName.size > 0,

    verify: async (username, password) => {
      const stored = byName.get(username) ?? dummyHash;
      const ok = await verifyScrypt(password, stored);
      // The dummy path must never authenticate, even in the (astronomically
      // unlikely) event of a collision.
      return byName.has(username) && ok;
    },

    blockedMsFor: (peer) => {
      const e = throttle.get(peer);
      return e ? Math.max(0, e.until - Date.now()) : 0;
    },

    registerFailure: (peer) => {
      const e = throttle.get(peer) ?? { fails: 0, until: 0 };
      e.fails += 1;
      if (e.fails >= maxAttempts) {
        const over = e.fails - maxAttempts;
        e.until = Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** over);
      }
      throttle.set(peer, e);
      if (throttle.size > MAX_THROTTLE_ENTRIES) {
        const oldest = throttle.keys().next().value;
        if (oldest !== undefined) throttle.delete(oldest);
      }
    },

    registerSuccess: (peer) => {
      throttle.delete(peer);
    },
  };
}
