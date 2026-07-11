/**
 * Runtime configuration for the Z-Wave TUI add-on.
 *
 * This object is the env-bridge: the s6 `run` script translates every HA
 * add-on option into a plain environment variable (via bashio) and exec's
 * the Node server, which reads them here. Nothing in this file talks to HA
 * directly — it only normalizes env into typed knobs the rest of the server
 * consumes.
 *
 * Unlike ecoflow-panel there is NO `dotenv` import: under HA the environment
 * is already populated by the run script, and dotenv is deliberately not a
 * dependency of this add-on. For bare-metal dev, export the vars yourself.
 *
 * Bind hosts default to `::` so Fastify (and the telnet server) listen
 * dual-stack. Node does NOT set IPV6_V6ONLY, so one `::` socket accepts both
 * IPv4 and IPv6. Binding only `0.0.0.0` silently breaks clients that resolve
 * a hostname to its IPv6 address (macOS does this by default for `.local`) —
 * they reach the host's IPv6 stack with no listener and get a TCP RST.
 *
 * Boolean knobs follow the run script's NUMERIC convention: it exports `1` /
 * `0` (never the strings `true` / `false`), so the tests below compare
 * against `'1'` / `'0'` accordingly. Keep the two in lock-step — flipping one
 * without the other makes the knob dead.
 */

import { parseUsers } from './auth/loginPolicy';

const signalDisplay: 'margin' | 'dbm' =
  process.env.SIGNAL_DISPLAY === 'dbm' ? 'dbm' : 'margin';

export const config = {
  /** HA-Ingress HTTP + xterm.js /console port (matches config.yaml ingress_port). */
  port: Number(process.env.PORT ?? 8788),
  /** Dual-stack bind (see file header). Overridden to `::` by the run script. */
  host: process.env.HOST ?? '::',

  /**
   * HA Core WebSocket endpoint the data layer authenticates against with
   * SUPERVISOR_TOKEN. Override to `ws://core-zwave-js:3000` to talk to the
   * zwave-js driver server directly (phase 2).
   */
  haWsUrl: process.env.HA_WS_URL ?? 'ws://supervisor/core/websocket',
  /**
   * Auto-injected by the Supervisor for add-ons with `homeassistant_api: true`.
   * `undefined` in bare dev — the WS client no-ops rather than crashing.
   */
  supervisorToken: process.env.SUPERVISOR_TOKEN,

  /**
   * Optional override of the zwave_js config-entry id. Empty/absent = the
   * data layer auto-discovers it via `config_entries/get` (domain zwave_js).
   */
  entryId: process.env.ZWAVE_ENTRY_ID || null,

  /** ms between live render refreshes / cheap network_status roster polls. */
  refreshMs: Number(process.env.REFRESH_INTERVAL_MS ?? 2000),
  /** ms between EXPENSIVE route / controller-statistics polls (off the 1Hz tick). */
  routePollMs: Number(process.env.ROUTE_POLL_INTERVAL_MS ?? 10000),

  /** Default signal unit: SNR-margin over the live noise floor vs raw dBm. */
  signalDisplay,

  /** Add-on log verbosity, surfaced from bashio to the server logger. */
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Persistent SQLite path on the /data volume (phase 4 history). */
  dbPath: process.env.DB_PATH ?? '/data/zwave.db',
  /** Build stamp promoted from the Docker ARG (reported by /api/version). */
  version: process.env.BUILD_VERSION ?? '0.1.0',

  /**
   * Telnet control-room TUI (:2324). Same dual-stack `::` rationale as the
   * HTTP bind. Gated by `telnet_enabled`; the run script exports `1` / `0`.
   */
  telnet: {
    enabled: process.env.TELNET_ENABLED !== '0',
    host: process.env.TELNET_HOST ?? '::',
    port: Number(process.env.TELNET_PORT ?? 2324),
  },

  /**
   * Master gate for mutating actions (heal / rebuild / re-interview / remove).
   * Defaults OFF: v0.1 is a pure read-only monitor. Run script exports `1`/`0`.
   */
  writeActions: process.env.WRITE_ACTIONS_ENABLED === '1',
  /**
   * Require a second-key / typed confirmation for network-disruptive actions
   * (rebuild-all-routes, remove-failed-node). Defaults ON.
   */
  confirmDestructive: process.env.CONFIRM_DESTRUCTIVE !== '0',

  /**
   * TUI login gate. Direct LAN access (telnet :2324, or :8788 hit directly)
   * requires a configured user when `enabled`. Access via the HA sidebar is
   * already HA-authenticated, so it skips the gate unless `requireOnIngress`.
   * `users` arrives as a JSON array string the run script lifts from
   * /data/options.json. Passwords may be plaintext or `scrypt:<salt>:<hash>`.
   */
  auth: {
    enabled: process.env.AUTH_ENABLED === '1',
    requireOnIngress: process.env.AUTH_REQUIRE_ON_INGRESS === '1',
    users: parseUsers(process.env.ZWAVE_USERS),
    maxAttempts: Number(process.env.AUTH_MAX_ATTEMPTS ?? 3),
    idleLockMin: Number(process.env.AUTH_IDLE_LOCK_MIN ?? 0),
  },
};

export type Config = typeof config;
