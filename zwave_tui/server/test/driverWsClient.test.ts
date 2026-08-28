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
  s2ResyncNodeId,
  type DriverWsCallbacks,
} from '../src/zwave/driverWsClient';
import { driverHomeGuard, leadingRun } from '../src/zwave/zwaveData';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds (or fail after ~4s) — event-driven waits beat fixed
 *  sleeps for the reconnect/log-stream tests, which are timing-sensitive. */
async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time');
    await sleep(25);
  }
}

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
      } else if (m.command === 'start_listening_logs' || m.command === 'stop_listening_logs') {
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
    s2: [] as number[],
  };
  const callbacks: DriverWsCallbacks = {
    onS2Resync: (nodeId) => got.s2.push(nodeId),
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

/* ── v0.26: the S2 SPAN-resync watch (log-stream listening) ──────────────── */

/** A node-attributed controller `logging` event, as zwave-js-server streams it. */
function logEvent(nodeId: number, message: string | string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'driver', event: 'logging', formattedMessage: String(message),
    level: 'info', direction: '  ', primaryTags: `[Node ${String(nodeId).padStart(3, '0')}]`,
    message,
    context: { source: 'controller', type: 'node', nodeId, direction: 'none' },
    ...over,
  };
}

test('s2ResyncNodeId: matches the verified S2 desync family, node-attributed only', () => {
  // Outgoing pair (arrive at the stock `info` driver level).
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message, retrying with SPAN extension...')), 17);
  // The TERMINAL drop line must NOT match: it is always preceded by its own
  // retry line, so counting both scored one failed transmission twice and
  // silently halved the effective S2_ABS threshold (v0.26 review).
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message after re-transmission with SPAN extension, dropping the message.')), null);
  // Incoming family (verbose level, matched in case the operator raises it).
  assert.equal(s2ResyncNodeId(logEvent(8, 'Message authentication failed, cannot decode command. Requesting a nonce...')), 8);
  assert.equal(s2ResyncNodeId(logEvent(8, 'No SPAN is established yet, cannot decode command. Requesting a nonce...')), 8);
  // message may be a string[] — the join must still match.
  assert.equal(s2ResyncNodeId(logEvent(9, ['failed to decode the message,', 'retrying with SPAN extension...'])), 9);
  // NOT matched: un-attributed driver-level lines (no nodeId to charge).
  assert.equal(s2ResyncNodeId({ source: 'driver', event: 'logging', message: 'Dropping message with invalid payload', context: { source: 'driver', direction: 'none' } }), null);
  // NOT matched: node-attributed but not S2.
  assert.equal(s2ResyncNodeId(logEvent(17, 'Timed out while waiting for a response from the node')), null);
  // NOT matched: hostile shapes — junk node id, value context, non-logging event.
  assert.equal(s2ResyncNodeId(logEvent(4001, 'retrying with SPAN extension...')), null);
  assert.equal(s2ResyncNodeId(logEvent(17, 'retrying with SPAN extension...', { context: { source: 'controller', type: 'value', nodeId: 17 } })), null);
  assert.equal(s2ResyncNodeId({ event: 'statistics updated', nodeId: 17 }), null);
});

test('log stream: subscribed after live, S2 events attributed, non-S2 dropped, resubscribed per connection', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.state() === 'live');
    await waitFor(() => srv.commands.includes('start_listening_logs'));

    // ONE failed transmission emits BOTH lines — the retry attempt and, when
    // the retry also fails, the terminal drop. Only the ATTEMPT counts: scoring
    // both double-counted every terminal failure and silently halved the
    // effective S2_ABS threshold (v0.26 review).
    srv.push(logEvent(17, 'failed to decode the message, retrying with SPAN extension...'));
    srv.push(logEvent(17, 'failed to decode the message after re-transmission with SPAN extension, dropping the message.'));
    srv.push(logEvent(6, 'value updated: currentValue 99')); // chatty non-S2 line
    await waitFor(() => got.s2.length === 1);
    assert.deepEqual(got.s2, [17], 'one failed transmission must count exactly once');

    // The subscription is per-connection: a drop + reconnect must re-issue it.
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && client.state() === 'live');
    await waitFor(() => srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    srv.push(logEvent(3, 'No SPAN is established yet, cannot decode command. Requesting a nonce...'));
    await waitFor(() => got.s2.length === 2); // 1 from before the drop + this one
    assert.equal(got.s2[1], 3);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('log-stream storm guard: a hot stream stops OUR subscription and stays quiet until reconnect', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => srv.commands.includes('start_listening_logs'));
    // Blow past the per-minute cap with cheap non-matching lines (the guard
    // counts EVERY logging event — a driver switched to debug/silly).
    for (let i = 0; i < 3005; i++) srv.push(logEvent(6, 'SERIAL » 0x01…'));
    await waitFor(() => srv.commands.includes('stop_listening_logs'));
    // After the stop, even a REAL S2 line must be ignored (we told the server
    // to stop; anything still in flight is drained unmatched).
    srv.push(logEvent(17, 'failed to decode the message, retrying with SPAN extension...'));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(got.s2.length, 0, 'no attribution after the storm stop');
    // A reconnect re-arms the watch.
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    srv.push(logEvent(17, 'failed to decode the message, retrying with SPAN extension...'));
    await waitFor(() => got.s2.length === 1);
  } finally {
    client.stop();
    await srv.close();
  }
});

/* ── v0.32.1 — the two defects found in the 2026-08-05 live log ─────────── */

test('parseLastSeen: a timezone-NAKED ISO date-time is UTC, not local', () => {
  // Measured live: the driver reported "2026-08-06T04:25:48.921" for a node
  // heard at 21:25 MST — 04:25 UTC with the Z missing. Date.parse reads a
  // no-offset date-time as LOCAL, which shifted every lastSeen 7 hours into
  // the future on the plant (TZ=America/Phoenix) and corrupted every silence
  // computation downstream: the 240-minute liveness probe behaved as an
  // 11-hour one, while logging "240m" for every node.
  const naked = '2026-08-06T04:25:48.921';
  assert.equal(parseLastSeen(naked), Date.parse(naked + 'Z'),
    'no offset ⇒ interpret as UTC');
  // Seconds precision, no millis — same rule.
  assert.equal(parseLastSeen('2026-08-06T04:25:48'), Date.parse('2026-08-06T04:25:48Z'));
  // An EXPLICIT offset is honoured untouched — if a future driver starts
  // sending proper offsets, we must not double-shift it.
  assert.equal(parseLastSeen('2026-08-06T04:25:48.921Z'), Date.parse('2026-08-06T04:25:48.921Z'));
  assert.equal(parseLastSeen('2026-08-06T04:25:48-07:00'), Date.parse('2026-08-06T04:25:48-07:00'));
  // Date-only strings are already UTC per ECMA-262 — the regex must not
  // touch them (appending Z to a date-only string would be a parse error).
  assert.equal(parseLastSeen('2026-08-06'), Date.parse('2026-08-06'));
});

test('stop() while the socket is still CONNECTING does not crash the process', async () => {
  // The 2026-08-05 21:25 crash: SIGTERM arrived while the driver socket was
  // mid-reconnect; teardownSocket stripped the listeners and terminate()d a
  // CONNECTING socket, and ws emits 'error' ("closed before the connection
  // was established") on a LATER tick — an unhandled 'error' event, which
  // killed Node mid-shutdown. The fix is a no-op error listener attached
  // after removeAllListeners; this test fails as an uncaughtException crash
  // without it.
  const died: unknown[] = [];
  const onUncaught = (e: unknown) => { died.push(e); };
  process.on('uncaughtException', onUncaught);
  try {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): guaranteed unroutable, so the socket
    // sits in CONNECTING until it times out — exactly the crash window.
    const c = createDriverWsClient({ url: 'ws://192.0.2.1:3000', callbacks: {} });
    c.start();
    await sleep(50);          // let connect() create the socket
    c.stop();                 // terminate() a CONNECTING socket
    await sleep(200);         // the fatal 'error' fired on a later tick
    assert.deepEqual(died, [], 'teardown must not leak an unhandled error event');
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

/* ── v0.34: the bridge-completeness guard ────────────────────────────────── */

test('ZwaveDataSource forwards EVERY capability the data layer implements', async () => {
  // THE DEFECT THIS EXISTS FOR: v0.33 shipped an `M` ack key that did nothing
  // and v0.34 a panel that never rendered, because both were wired through
  // dataProvider.ts while the ONE bridge the running add-on builds (index.ts)
  // omitted them — and the members were declared OPTIONAL on ZwaveDataSource,
  // so the compiler said nothing. Unit tests passed because their mocks
  // attached the methods directly, exercising a path production never uses.
  //
  // The structural fix is that the members are now REQUIRED, so omitting one is
  // a compile error. This test pins the intent so nobody re-adds the `?`.
  const src = await import('../src/telnet/dataProvider');
  // buildZwaveDataSource IS the object index.ts hands the provider — testing the
  // provider against a hand-rolled source would exercise a path production does
  // not use, which is precisely how the original hole stayed invisible.
  const bridged = src.buildZwaveDataSource({
      snapshot: () => [], controller: () => null, events: () => [], ready: () => true,
      lastError: () => null, lastUpdated: () => Date.now(),
      history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
      symptoms: () => [], engineStatus: () => null, efficacyFor: () => null,
      interference: () => null, entityStates: () => [], configParams: () => [],
      requestConfigParams: () => {},
      ackEvent: (seq: number) => seq === 42,
      routeStability: (n: number) => ({ changes: n, hours: 48 }),
      // v0.35 additions — each one an exemplar from the SAME family the hole
      // came from: a capability the data layer implements and a screen reads.
      routeFailures: (n: number) => [{ t: 1000 + n, between: [n, n + 1] as [number, number] }],
      evidenceCoverage: (n: number) => ({ firstSeenAt: n, samples: n * 2, freshSamples: n, statusFeedLive: true, statsFeedLive: false }),
      evidenceCoarse: (n: number) => [{ t0: n, samples: n }],
      falsePositives: (k: string) => (k === 'route-churn' ? 4 : 0),
      unverifiableCount: (k: string) => (k === 'rtt-degraded' ? 16 : 0),
      unverifiableTransientCount: (k: string) => (k === 'rtt-degraded' ? 5 : 0),
      confoundedCount: (k: string) => (k === 'rtt-degraded' ? 2 : 0),
      rssiNormal: (n: number) => ({ median: -n, scale: 3, ready: true, days: 7 }),
  } as never);
  const provider = src.createTuiDataProvider({
    zwaveData: bridged, refreshMs: 60_000, routePollMs: 60_000, log: () => {},
  });
  try {
    assert.equal(provider.provider.ackEvent?.(42), true, 'ack must reach the data layer');
    assert.equal(provider.provider.ackEvent?.(1), false, 'and carry its real answer back');
    assert.deepEqual(provider.provider.routeStability?.(7), { changes: 7, hours: 48 });
    assert.deepEqual(provider.provider.routeFailures?.(7), [{ t: 1007, between: [7, 8] }]);
    assert.deepEqual(provider.provider.evidenceCoverage?.(7),
      { firstSeenAt: 7, samples: 14, freshSamples: 7, statusFeedLive: true, statsFeedLive: false });
    assert.deepEqual(provider.provider.evidenceCoarse?.(7), [{ t0: 7, samples: 7 }]);
    assert.equal(provider.provider.falsePositives?.('route-churn'), 4);
    assert.equal(provider.provider.falsePositives?.('dead-flap'), 0, 'and carries a real 0, not a default one');
    assert.equal(provider.provider.unverifiableCount?.('rtt-degraded'), 16);
    assert.equal(provider.provider.unverifiableCount?.('dead-flap'), 0);
    assert.equal(provider.provider.unverifiableTransientCount?.('rtt-degraded'), 5, 'the v0.39 member crosses the bridge');
    assert.equal(provider.provider.unverifiableTransientCount?.('dead-flap'), 0);
    assert.equal(provider.provider.confoundedCount?.('rtt-degraded'), 2, 'the v0.40 member crosses the bridge');
    assert.equal(provider.provider.confoundedCount?.('dead-flap'), 0);
    assert.deepEqual(provider.provider.rssiNormal?.(62), { median: -62, scale: 3, ready: true, days: 7 });
  } finally {
    provider.stop();
  }
});
