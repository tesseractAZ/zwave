/**
 * Z-Wave TUI — server bootstrap.
 *
 * Wires the whole add-on together:
 *   HA Core WS client  ──▶  zwaveData (roster/discovery)  ──▶  TuiDataProvider
 *                                                               │
 *                          ┌────────────────────────────────────┤
 *                          ▼                                    ▼
 *                   telnet server (:2324)            xterm.js /console (:8788, ingress)
 *
 * One shared DataProvider feeds BOTH transports; each opens its own TuiSession
 * over it. Everything the render loop reads is a cheap cached accessor — the
 * expensive Z-Wave polling happens on the provider's own timers.
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCompress from '@fastify/compress';
import fastifyCors from '@fastify/cors';

import { config } from './config';
import { createLogger } from './logger';
import { createAuth, ingressRedirectTarget, isAllowedOrigin, isSupervisorSource, pinSupervisorAddress } from './auth';
import { createAuthPolicy, describeTelnetAuth } from './auth/loginPolicy';
import { createHaWsClient } from './ha/haWsClient';
import { createZwaveData } from './zwave/zwaveData';
import { createActionRunner } from './zwave/zwaveActions';
import { createTuiDataProvider, type ZwaveDataSource } from './telnet/dataProvider';
import { registerWsConsole } from './telnet/wsConsole';
import { startTelnetServer } from './telnet/server';
import type { LogEvent } from './types';

/* ── logging ─────────────────────────────────────────────────────────────
 * One sink for the data layer, provider and transports — now honouring the
 * `log_level` option, which until v0.25.0 was parsed and then read by nobody
 * (see logger.ts). Still callable as `log(msg)` for the informational stream;
 * `log.warn` / `log.error` survive a raised threshold. */
const log = createLogger(config.logLevel);

async function main(): Promise<void> {
  log(`Z-Wave TUI v${config.version} starting — HA ${config.haWsUrl}`);

  // 1) HA Core WebSocket (SUPERVISOR_TOKEN auth; no-ops if unconfigured in dev).
  const client = createHaWsClient({
    url: config.haWsUrl,
    token: config.supervisorToken ?? null,
    log,
  });
  client.start();

  // 2) Z-Wave data layer — entry-id auto-discovery + network_status roster poll.
  const zwaveData = createZwaveData({
    client,
    entryId: config.entryId,
    refreshMs: config.refreshMs,
    routePollMs: config.routePollMs,
    historyPath: config.historyPath,
    historyFlushMs: config.historyFlushMs,
    evidencePath: config.evidencePath,
    evidenceFlushMs: config.evidenceFlushMs,
    driverWsUrl: config.driverWsUrl,
    baselinesPath: config.baselinesPath,
    outcomesPath: config.outcomesPath,
    log,
  });
  zwaveData.start();

  // 3) Bridge ZwaveData → ZwaveDataSource. events() serves the live ring that
  //    feeds the Log screen; everything else maps straight through.
  const source: ZwaveDataSource = {
    snapshot: () => zwaveData.snapshot(),
    controller: () => zwaveData.controller(),
    events: (): LogEvent[] => zwaveData.events(),
    ready: () => zwaveData.ready(),
    lastError: () => zwaveData.lastError(),
    lastUpdated: () => zwaveData.lastUpdated(),
    history: (n) => zwaveData.history(n),
    historyLong: (n) => zwaveData.historyLong(n),
    symptoms: () => zwaveData.symptoms(),
    engineStatus: () => zwaveData.engineStatus(),
    efficacyFor: (kind, action) => zwaveData.efficacyFor(kind, action),
    interference: () => zwaveData.interference(),
    entityStates: (n) => zwaveData.entityStates(n),
    configParams: (n) => zwaveData.configParams(n),
    requestConfigParams: (n) => zwaveData.requestConfigParams(n),
  };

  // 4) Shared, timer-refreshed render cache both transports read.
  const { provider, stop: stopProvider } = createTuiDataProvider({
    zwaveData: source,
    refreshMs: config.refreshMs,
    routePollMs: config.routePollMs,
    log,
  });

  // 4b) Mutating-action runner (v0.3), gated by write_actions_enabled. Outcomes
  //     are logged into the event ring (Log screen). Passed to the transports
  //     only so the session can offer actions when enabled.
  const actions = createActionRunner({
    client,
    entryId: () => zwaveData.getEntryId(),
    deviceIdOf: (n) => zwaveData.deviceIdOf(n),
    pingEntityOf: (n) => zwaveData.pingEntityOf(n),
    log: (sev, nodeId, text) => zwaveData.logAction(sev, nodeId, text),
    // M5: feed operator-action outcomes into the learning ledger.
    onOutcome: (kind, nodeId, ok) => zwaveData.recordActionOutcome(kind, nodeId, ok),
    // v0.23: after a config write, drop the stale cache so DETAIL re-fetches.
    onConfigWritten: (nodeId) => zwaveData.invalidateConfigParams(nodeId),
    enabled: config.writeActions,
  });
  log(
    config.writeActions
      ? 'write actions ENABLED (each requires a typed CONFIRM) — ping/refresh/re-interview/heal/rebuild/remove'
      : 'write actions disabled (read-only) — set write_actions_enabled to unlock',
  );

  // 5) Auth — the CORS allow-list + the /console/ws upgrade origin check.
  //    (The write-token gate this used to bootstrap was removed in v0.24.4:
  //    it was registered on zero routes and still wrote a secret to /data.)
  const auth = createAuth({ host: config.host, port: config.port });

  // TUI login policy — gates direct (non-ingress) telnet + console access.
  const loginPolicy = createAuthPolicy(config.auth);
  if (loginPolicy.enabled) {
    log(
      `login gate ENABLED (${config.auth.users.length} user(s)` +
        `${loginPolicy.requireOnIngress ? ', required on ingress too' : ', trusted over HA ingress'}` +
        `${loginPolicy.idleLockMs > 0 ? `, idle-lock ${config.auth.idleLockMin}m` : ''})`,
    );
    if (!loginPolicy.hasUsers()) {
      log.warn('login gate WARNING: auth_enabled but no users configured — direct LAN access will be denied');
    }
  }
  // Ingress requests carry X-Ingress-Path AND originate from the Supervisor
  // subnet (req.ip is the unspoofable socket peer; trustProxy is off).
  // Pin ingress trust to the Supervisor's REAL address before serving. Until
  // this resolves, isSupervisorSource() returns false for everything, so a
  // request arriving mid-startup is treated as untrusted (login required)
  // rather than trusted-by-default.
  await pinSupervisorAddress(log);

  const isIngressTrusted = (req: { headers: Record<string, unknown>; ip: string }): boolean =>
    !!req.headers['x-ingress-path'] && isSupervisorSource(req.ip);

  // 6) HTTP + ingress console.
  const app = Fastify({ trustProxy: false });
  await app.register(fastifyCompress);
  await app.register(fastifyCors, { origin: auth.corsOriginCallback });
  // Cap inbound ws frames: the console only carries keystrokes + tiny resize
  // JSON, so 64 KiB is generous. Without this the default is 100 MiB, which a
  // single frame could weaponize into an OOM/stall.
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  registerWsConsole({
    app,
    data: provider,
    log,
    isOriginAllowed: (origin) => isAllowedOrigin(origin ?? '', auth.sameOrigins),
    signalDisplay: config.signalDisplay,
    auth: loginPolicy,
    isTrusted: isIngressTrusted,
    actions,
  });

  // Ingress landing → the terminal console.
  //
  // The redirect MUST carry the ingress prefix. Home Assistant loads the panel
  // at `/api/hassio_ingress/<token>/`, and a bare `/console` is an absolute-path
  // redirect: the browser drops the prefix and asks HA itself for `/console`,
  // which HA does not serve. The sidebar panel therefore rendered a bare
  // "404: Not Found" inside an otherwise-working Home Assistant — the address
  // bar still on /local_zwave_tui, so the failure looked like a broken panel
  // registration rather than a redirect that had thrown its own path away.
  //
  // The rest of the console page was already ingress-safe (relative asset URLs,
  // a WS URL derived from location.pathname); this one line was not.
  app.get('/', (req, reply) => reply.redirect(ingressRedirectTarget(req.headers['x-ingress-path'])));
  app.get('/api/version', () => ({ version: config.version }));
  app.get('/api/health', (_req, reply) => {
    const healthy = client.ready() && provider.ready() && !provider.lastError();
    reply.code(healthy ? 200 : 503).send({
      ok: healthy,
      ready: provider.ready(),
      nodes: provider.nodes().length,
      haReady: client.ready(),
      lastUpdated: provider.lastUpdated(),
      lastStatsUpdated: zwaveData.lastStatsUpdated(),
      error: provider.lastError(),
    });
  });

  // 7) Telnet transport (opt-in).
  let telnet: { stop: () => void } | null = null;
  if (config.telnet.enabled) {
    telnet = startTelnetServer({
      data: provider,
      host: config.telnet.host,
      port: config.telnet.port,
      log,
      signalDisplay: config.signalDisplay,
      auth: loginPolicy,
      actions,
    });
    // Report the policy this listener ACTUALLY enforces. The suffix used to be
    // the hardcoded string "(no auth — trusted LAN only)", printed whether or
    // not the login gate was on — so on an authenticated deployment the startup
    // log stated the opposite of the truth about a security control, and on an
    // unauthenticated one it was right only by accident.
    log(`telnet TUI on ${config.telnet.host}:${config.telnet.port} ${describeTelnetAuth(loginPolicy.enabled)}`);
  } else {
    log('telnet TUI disabled (telnet_enabled=false) — /console only');
  }

  await app.listen({ host: config.host, port: config.port });
  log(`HTTP + /console on ${config.host}:${config.port} — ingress ready`);

  // 8) Graceful shutdown — stop the transports, timers, and sockets in order.
  let closing = false;
  const shutdown = (sig: string): void => {
    if (closing) return;
    closing = true;
    log(`${sig} — shutting down`);
    try { telnet?.stop(); } catch { /* ignore */ }
    try { stopProvider(); } catch { /* ignore */ }
    try { zwaveData.stop(); } catch { /* ignore */ }
    try { client.stop(); } catch { /* ignore */ }
    app.close().finally(() => process.exit(0));
    // Hard backstop if Fastify hangs on close.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  log(`FATAL: ${msg}`);
  process.exit(1);
});
