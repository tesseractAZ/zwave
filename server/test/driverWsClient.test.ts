import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  createDriverWsClient,
  parseBgRssi,
  parseLastSeen,
  DRIVER_WS_ALLOWLIST,
  DRIVER_SCHEMA_MIN,
  DRIVER_SCHEMA_MAX,
  type DriverWsCallbacks,
} from '../src/zwave/driverWsClient';
import { driverHomeGuard, leadingRun } from '../src/zwave/zwaveData';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A minimal mock zwave-js-server: records every command the client sends
 * (the allowlist proof), answers the handshake, and lets tests push events.
 */
async function mockServer(over: { minSchema?: number; maxSchema?: number; homeId?: number } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const commands: string[] = [];
  let connections = 0;
  let sock: WsSocket | null = null;
  wss.on('connection', (ws) => {
    connections += 1;
    sock = ws;
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { messageId: string; command: string };
      commands.push(m.command);
      if (m.command === 'set_api_schema') {
        ws.send(JSON.stringify({ type: 'result', messageId: m.messageId, success: true, result: {} }));
      } else if (m.command === 'start_listening') {
        ws.send(JSON.stringify({
          type: 'result', messageId: m.messageId, success: true,
          result: {
            state: {
              controller: { statistics: { backgroundRSSI: { channel0: { average: -101, current: -99 }, channel1: { average: -97, current: -95 }, timestamp: 1 } } },
              nodes: [
                { nodeId: 6, isListening: true, isFrequentListening: false, statistics: { lastSeen: '2026-07-16T20:00:00.000Z' } },
                { nodeId: 44, isListening: false, isFrequentListening: true, statistics: {} },
              ],
            },
          },
        }));
      }
    });
    ws.send(JSON.stringify({
      type: 'version', driverVersion: '15.25.0', serverVersion: '3.10.0',
      homeId: over.homeId ?? 3586281591,
      minSchemaVersion: over.minSchema ?? 0,
      maxSchemaVersion: over.maxSchema ?? 42,
    }));
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    commands,
    connectionCount: () => connections,
    push: (event: unknown) => sock?.send(JSON.stringify({ type: 'event', event })),
    dropClient: () => sock?.terminate(),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

function collect() {
  const got = {
    bg: [] as { channels: (number | null)[]; at: number }[],
    seen: [] as { nodeId: number; lastSeen: number }[],
    flags: [] as { nodeId: number; isListening: boolean | null }[],
    homeId: null as number | null,
  };
  const callbacks: DriverWsCallbacks = {
    onBgRssi: (channels, at) => got.bg.push({ channels, at }),
    onNodeLastSeen: (nodeId, lastSeen) => got.seen.push({ nodeId, lastSeen }),
    onNodeFlags: (nodeId, f) => got.flags.push({ nodeId, isListening: f.isListening }),
    onHomeId: (id) => (got.homeId = id),
  };
  return { got, callbacks };
}

/* ── Handshake + state dump ──────────────────────────────────────────────── */

test('handshake: negotiates min(serverMax, OUR_MAX), starts listening, delivers the state dump', async () => {
  const srv = await mockServer({ maxSchema: 42 });
  const { got, callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks });
  c.start();
  await sleep(600);
  try {
    assert.equal(c.state(), 'live');
    assert.equal(c.schema(), DRIVER_SCHEMA_MAX, 'server max 42 clamps to OUR tested max');
    assert.equal(got.homeId, 3586281591);
    // state dump: bgRssi seeded (averages preferred), flags + lastSeen delivered.
    assert.deepEqual(got.bg[0]?.channels, [-101, -97, null, null]);
    assert.deepEqual(got.flags.map((f) => [f.nodeId, f.isListening]), [[6, true], [44, false]]);
    assert.equal(got.seen[0]?.nodeId, 6);
    assert.equal(got.seen[0]?.lastSeen, Date.parse('2026-07-16T20:00:00.000Z'));
  } finally {
    c.stop();
    await srv.close();
  }
});

test('READ-ONLY proof: only allowlisted commands ever cross the wire', async () => {
  const srv = await mockServer();
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks });
  c.start();
  await sleep(600);
  try {
    assert.ok(srv.commands.length >= 2, 'handshake commands were sent');
    for (const cmd of srv.commands) {
      assert.ok(DRIVER_WS_ALLOWLIST.includes(cmd), `'${cmd}' must be on the allowlist`);
    }
    assert.ok(!srv.commands.some((x) => /ping|health|route|node\.|controller\./.test(x)), 'no active/diagnostic commands');
  } finally {
    c.stop();
    await srv.close();
  }
});

test('schema mismatch (old server) ⇒ PERMANENT dormancy, no commands, no retry loop', async () => {
  const srv = await mockServer({ maxSchema: DRIVER_SCHEMA_MIN - 1 });
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 50 });
  c.start();
  await sleep(500);
  try {
    assert.equal(c.state(), 'dormant');
    assert.equal(srv.commands.length, 0, 'nothing sent to a schema-incompatible server');
    assert.match(c.status(), /schema mismatch/);
  } finally {
    c.stop();
    await srv.close();
  }
});

/* ── Event stream ────────────────────────────────────────────────────────── */

test('controller statistics events update the noise floor; node events update lastSeen', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks });
  c.start();
  await sleep(600);
  const before = got.bg.length;
  srv.push({ source: 'controller', event: 'statistics updated', statistics: { backgroundRSSI: { channel0: { average: -88, current: -80 }, channel1: { average: -102, current: -100 }, timestamp: 2 } } });
  srv.push({ source: 'node', event: 'statistics updated', nodeId: 6, statistics: { lastSeen: '2026-07-16T21:30:00.000Z' } });
  // Irrelevant events must be ignored silently.
  srv.push({ source: 'node', event: 'value updated', nodeId: 6, args: {} });
  await sleep(400);
  try {
    assert.equal(got.bg.length, before + 1);
    assert.deepEqual(got.bg[got.bg.length - 1].channels, [-88, -102, null, null]);
    const last = got.seen[got.seen.length - 1];
    assert.deepEqual([last.nodeId, last.lastSeen], [6, Date.parse('2026-07-16T21:30:00.000Z')]);
  } finally {
    c.stop();
    await srv.close();
  }
});

test('reconnects after the server drops the connection (fresh handshake on a new socket)', async () => {
  const srv = await mockServer();
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 80 });
  try {
    c.start();
    await sleep(500);
    assert.equal(c.state(), 'live');
    assert.equal(srv.connectionCount(), 1);
    srv.dropClient();
    // Racing the intermediate 'backoff' state is inherently flaky with a fast
    // base; assert the deterministic outcome instead: a SECOND connection with
    // a full re-handshake, ending live again.
    await sleep(900);
    assert.ok(srv.connectionCount() >= 2, 'a new connection was made after the drop');
    assert.equal(c.state(), 'live', 'reconnected + re-handshaken');
  } finally {
    c.stop();
    await srv.close();
  }
});

test('empty URL ⇒ permanently disabled; start() is a no-op', () => {
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: '', callbacks });
  c.start();
  assert.equal(c.state(), 'disabled');
  assert.match(c.status(), /disabled/);
  c.stop();
});

test('start() after stop() re-establishes the client (restart symmetry)', async () => {
  const srv = await mockServer();
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 80 });
  try {
    c.start();
    await sleep(500);
    assert.equal(c.state(), 'live');
    assert.equal(srv.connectionCount(), 1);
    c.stop();
    assert.equal(c.state(), 'stopped');
    // The previously-latent restart bug: start() no-op'd forever after stop().
    c.start();
    await sleep(500);
    assert.equal(c.state(), 'live', 'restarted');
    assert.ok(srv.connectionCount() >= 2, 'a fresh connection was made on restart');
  } finally {
    c.stop();
    await srv.close();
  }
});

test('a handshake with no schema range ⇒ dormant with an honest message (not "schema mismatch 0..0")', async () => {
  const srv = await mockServer({ maxSchema: 0 });
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 50 });
  c.start();
  await sleep(400);
  try {
    assert.equal(c.state(), 'dormant');
    assert.match(c.status(), /unrecognized handshake/);
  } finally {
    c.stop();
    await srv.close();
  }
});

test('liveness: a healthy but app-idle socket survives on ping/pong (500-series / quiet-mesh regression)', async () => {
  const srv = await mockServer();
  const { callbacks } = collect();
  // After the handshake the mock sends NO app messages (as a 500-series
  // controller or a sleeping all-battery mesh would). The ws server auto-pongs
  // our pings, so the socket must be recognized as healthy and NOT churned —
  // the bug this fix prevents was terminating it every livenessMs.
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200 });
  try {
    c.start();
    await sleep(400);
    assert.equal(c.state(), 'live');
    const first = srv.connectionCount();
    await sleep(1900); // > livenessMs of app silence — pings keep it alive
    assert.equal(c.state(), 'live', 'stayed live on ping/pong');
    assert.equal(srv.connectionCount(), first, 'no churn: the healthy idle socket was not terminated');
  } finally {
    c.stop();
    await srv.close();
  }
});

/* ── Parser units ────────────────────────────────────────────────────────── */

test('parseLastSeen: ISO string, epoch number, garbage', () => {
  assert.equal(parseLastSeen('2026-07-16T20:00:00.000Z'), Date.parse('2026-07-16T20:00:00.000Z'));
  assert.equal(parseLastSeen(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseLastSeen('not a date'), null);
  assert.equal(parseLastSeen(null), null);
  assert.equal(parseLastSeen(-5), null);
});

test('parseBgRssi: averages preferred, current fallback, sentinels rejected, all-null ⇒ null', () => {
  assert.deepEqual(
    parseBgRssi({ channel0: { average: -101, current: -95 }, channel1: { current: -97 }, timestamp: 1 }),
    [-101, -97, null, null],
  );
  // RSSI error sentinels (≥125) must never surface as a fake dBm.
  assert.deepEqual(parseBgRssi({ channel0: { average: 127, current: -95 } }), [-95, null, null, null]);
  assert.equal(parseBgRssi({ channel0: { average: 127, current: 126 } }), null);
  assert.equal(parseBgRssi(null), null);
  assert.equal(parseBgRssi({}), null);
});

/* ── Pure guard helpers (extracted for regression coverage) ──────────────── */

test('driverHomeGuard: optimistic until both ids known, then strict, then latched', () => {
  // Startup acceptance window: either id unknown ⇒ admit.
  assert.deepEqual(driverHomeGuard(null, null, false), { ok: true, newlyMismatched: false });
  assert.deepEqual(driverHomeGuard(111, null, false), { ok: true, newlyMismatched: false });
  assert.deepEqual(driverHomeGuard(null, 111, false), { ok: true, newlyMismatched: false });
  // Both known + match ⇒ admit.
  assert.deepEqual(driverHomeGuard(111, 111, false), { ok: true, newlyMismatched: false });
  // Both known + differ ⇒ FIRST detection flips newlyMismatched (caller purges).
  assert.deepEqual(driverHomeGuard(111, 222, false), { ok: false, newlyMismatched: true });
  // Already latched ⇒ reject, no repeat purge.
  assert.deepEqual(driverHomeGuard(111, 222, true), { ok: false, newlyMismatched: false });
  // A latch even survives ids momentarily reading equal again (permanent this run).
  assert.deepEqual(driverHomeGuard(111, 111, true), { ok: false, newlyMismatched: false });
});

test('leadingRun: keeps channel index integrity by stopping at the first gap', () => {
  assert.deepEqual(leadingRun([-101, -97, null, null]), [-101, -97]); // ch2/3 absent
  assert.deepEqual(leadingRun([-101, -97, -95, -93]), [-101, -97, -95, -93]);
  assert.deepEqual(leadingRun([null, -97, null, null]), []); // ch0 absent ⇒ never mislabel ch1 as ch0
  assert.deepEqual(leadingRun([-101, null, -95, null]), [-101]); // interior gap ⇒ stop (honest)
  assert.deepEqual(leadingRun([]), []);
});
