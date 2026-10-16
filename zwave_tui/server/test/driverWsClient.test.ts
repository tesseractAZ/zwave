import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDriverWsClient,
  parseBgRssi,
  parseLastSeen,
  DRIVER_WS_ALLOWLIST,
  DRIVER_SCHEMA_MIN,
  DRIVER_SCHEMA_MAX,
  s2ResyncNodeId,
  controllerRfEvent,
  rfOffActive,
  RF_OFF_MAX_MS,
  type DriverWsCallbacks,
  type LogGap,
  s2Fault,
  refreshQueriesOf,
  stormPauseMs,
  parseDriverLogLevel,
  levelAtLeast,
  parseNodeFilter,
  DRIVER_LOG_LEVELS,
  LOG_GUARD,
  logGapNote,
} from '../src/zwave/driverWsClient';
import { driverHomeGuard, leadingRun } from '../src/zwave/zwaveData';
import { WebSocketServer } from 'ws';
import { mockServer } from './_driverWsMock';

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

function collect() {
  const got = {
    bg: [] as { channels: (number | null)[]; at: number }[],
    seen: [] as { nodeId: number; lastSeen: number }[],
    flags: [] as { nodeId: number; isListening: boolean | null }[],
    homeId: null as number | null,
    s2: [] as number[],
    gaps: [] as LogGap[],
  };
  const callbacks: DriverWsCallbacks = {
    onS2Resync: (nodeId) => got.s2.push(nodeId),
    onDriverLogGap: (g) => got.gaps.push(g),
    onBgRssi: (channels, at) => got.bg.push({ channels, at }),
    onNodeLastSeen: (nodeId, lastSeen) => got.seen.push({ nodeId, lastSeen }),
    onNodeFlags: (nodeId, f) => got.flags.push({ nodeId, isListening: f.isListening }),
    onHomeId: (id) => (got.homeId = id),
  };
  return { got, callbacks };
}

/* ── Handshake + state dump ──────────────────────────────────────────────── */

test('a sleeper\'s declared report interval comes from the dump, then from value events for that value alone (v0.73.0)', async () => {
  const srv = await mockServer();
  const declared: [number, unknown][] = [];
  const c = createDriverWsClient({ url: srv.url, callbacks: { onNodeDeclared: (id, d) => declared.push([id, d]) } });
  c.start();
  try {
    await waitFor(() => declared.length >= 1);
    assert.deepEqual(declared, [[44, { ms: 70 * 60_000, source: 'heartbeat' }]], 'the sleeper only — node 6 listens');
    const valueEvent = (nodeId: number, property: number, newValue: unknown, commandClass = 112) =>
      srv.push({ source: 'node', event: 'value updated', nodeId, args: { commandClass, endpoint: 0, property, newValue, prevValue: 70 } });
    valueEvent(44, 2, 3);            // another parameter on the same node
    valueEvent(6, 1, 60);            // the same parameter number on a node that listens
    valueEvent(44, 1, 60, 132);      // another command class
    valueEvent(44, 1, 60);           // the heartbeat itself
    await waitFor(() => declared.length >= 2);
    await sleep(100);
    assert.deepEqual(declared.slice(1), [[44, { ms: 60 * 60_000, source: 'heartbeat' }]]);
    srv.push({ source: 'node', event: 'value added', nodeId: 44, args: { commandClass: 112, endpoint: 0, property: 1, newValue: 0 } });
    await waitFor(() => declared.length >= 3);
    assert.deepEqual(declared[2], [44, { reason: 'interval-disabled' }]);
  } finally {
    c.stop();
    await srv.close();
  }
});

test('a sleeper that finishes its interview after the dump is watched from its ready event (v0.73.1)', async () => {
  // A node still interviewing is dumped with no values; before v0.73.1 it
  // stayed unwatched until the next reconnect re-sent the dump.
  const srv = await mockServer({ nodes: [{ nodeId: 44, isListening: false, isFrequentListening: true, statistics: {}, values: [] }] });
  const declared: [number, unknown][] = [];
  const c = createDriverWsClient({ url: srv.url, callbacks: { onNodeDeclared: (id, d) => declared.push([id, d]) } });
  c.start();
  try {
    await waitFor(() => declared.length >= 1);
    assert.deepEqual(declared[0], [44, { reason: 'no-declared-interval' }]);
    srv.push({ source: 'node', event: 'ready', nodeId: 44, nodeState: { nodeId: 44, isListening: false, isFrequentListening: true, statistics: {},
      values: [{ commandClass: 112, endpoint: 0, property: 1, value: 70, metadata: { label: 'Heartbeat Interval', unit: 'minutes' } }] } });
    await waitFor(() => declared.length >= 2);
    assert.deepEqual(declared[1], [44, { ms: 70 * 60_000, source: 'heartbeat' }]);
    srv.push({ source: 'node', event: 'value updated', nodeId: 44, args: { commandClass: 112, endpoint: 0, property: 1, newValue: 60 } });
    await waitFor(() => declared.length >= 3);
    assert.deepEqual(declared[2], [44, { ms: 60 * 60_000, source: 'heartbeat' }], 'and its value events are followed from then on');
  } finally {
    c.stop();
    await srv.close();
  }
});

test('a FLiRS node is FLiRS: the server sends its wake-up period as a string (v0.73.4)', async () => {
  const srv = await mockServer({ nodes: [
    { nodeId: 60, isListening: false, isFrequentListening: '1000ms', statistics: {} },
    { nodeId: 61, isListening: false, isFrequentListening: '250ms', statistics: {} },
    { nodeId: 62, isListening: false, isFrequentListening: false, statistics: {} },
    { nodeId: 63, isListening: false, statistics: {} },
  ] });
  const flags = new Map<number, boolean | null>();
  const c = createDriverWsClient({ url: srv.url, callbacks: { onNodeFlags: (id, f) => flags.set(id, f.isFrequentListening) } });
  c.start();
  try {
    await waitFor(() => flags.size >= 4);
    assert.deepEqual([...flags.entries()].sort((a, b) => a[0] - b[0]), [[60, true], [61, true], [62, false], [63, null]]);
  } finally {
    c.stop();
    await srv.close();
  }
});

test('the radio coming back on is remembered, and the log stream says since when it has watched (v0.73.0)', async () => {
  const srv = await mockServer();
  const c = createDriverWsClient({ url: srv.url, callbacks: {} });
  c.start();
  try {
    await waitFor(() => c.rfWatchSince() != null);
    assert.equal(c.lastRfOnAt(), null);
    const before = Date.now();
    srv.push({ source: 'driver', event: 'logging', message: 'Turning RF on...', context: { source: 'controller', type: 'controller' } });
    await waitFor(() => c.lastRfOnAt() != null);
    assert.ok((c.lastRfOnAt() as number) >= before);
    const since = c.rfWatchSince() as number;
    assert.ok(since <= before, 'the stream was watched from before the radio came back');
    srv.dropClient();
    // Strictly later: accepting null here passed the moment the socket dropped.
    await waitFor(() => c.rfWatchSince() != null && (c.rfWatchSince() as number) > since, 8000);
    assert.ok(c.lastRfOnAt() != null, 'the radio history survives a reconnect');
  } finally {
    c.stop();
    await srv.close();
  }
});

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

test('parseBgRssi: the int8 range bounds a reading; the "no value yet" seed is absent when trailing, kept when interior; saturation stays 0 dBm (v0.75.1)', () => {
  // zwave-js parseRSSI reads an int8: nothing below -128 dBm is a reading.
  assert.deepEqual(parseBgRssi({ channel0: { average: -128, current: -95 } }), [-128, null, null, null], '-128 is the floor of the range, still a reading');
  assert.deepEqual(parseBgRssi({ channel0: { average: -128.5, current: -95 } }), [-95, null, null, null], 'below the range falls back to current');
  assert.equal(parseBgRssi({ channel0: { average: -400, current: -300 } }), null);
  // averageRSSI returns 0 for a first reading that is "not available".
  const seed = { average: 0, current: 127 };
  const real = (v: number) => ({ average: v, current: v });
  assert.deepEqual(parseBgRssi({ channel0: real(-103), channel1: real(-104), channel2: seed, channel3: seed }), [-103, -104, null, null],
    'trailing long-range channels the controller reports as not available are absent, not 0 dBm');
  assert.deepEqual(parseBgRssi({ channel0: seed, channel1: real(-104) }), [0, -104, null, null],
    'an interior one keeps its 0, so channel 1 survives the leading run');
  assert.deepEqual(parseBgRssi({ channel0: real(-103), channel1: { average: 0, current: 126 } }), [-103, 0, null, null],
    'a saturated receiver (current 126) averages as 0 dBm, and that is a reading');
  assert.equal(parseBgRssi({ channel0: seed, channel1: seed }), null, 'nothing yet on any channel: no reading at all');
  assert.deepEqual(parseBgRssi({ channel0: real(-103), channel1: { average: -40, current: 127 } }), [-103, -40, null, null],
    'a real average beside a momentary "not available" is still a reading');
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

test('s2ResyncNodeId: the outgoing SPAN retry, node-attributed only — the verbose incoming family is not a resync (v0.76.0)', () => {
  // Outgoing pair (arrive at the stock `info` driver level).
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message, retrying with SPAN extension...')), 17);
  // The TERMINAL drop line must NOT match: it is always preceded by its own
  // retry line, so counting both scored one failed transmission twice and
  // silently halved the effective S2_ABS threshold (v0.26 review).
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message after re-transmission with SPAN extension, dropping the message.')), null);
  // A drop line wrapped by zwave-js's 80-column cut, even inside the guard
  // phrase, is still not a second resync (v0.76.0: matching ignores the cut).
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message after re-transmission with SPAN extens\nion, dropping the message.')), null);
  assert.equal(s2ResyncNodeId(logEvent(17, 'failed to decode the message after re-trans\nmission with SPAN extension, dropping the message.')), null);
  // The INCOMING family streams only at verbose and finer (after every driver
  // restart, and for every frame out of SPAN step): counting it made the
  // absolute S2_ABS count depend on the log level (v0.76.0). Not a resync.
  for (const m of ['Message authentication failed, cannot decode command. Requesting a \nnonce...',
    'No SPAN is established yet, cannot decode command. Requesting a non\nce...',
    'Message authentication failed, cannot decode command.',
    'Message authentication failed, cannot decode command. Aborting the \nS2 bootstrapping process...']) {
    assert.equal(s2ResyncNodeId(logEvent(8, m, { level: 'verbose' })), null, m);
  }
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
    srv.push(logEvent(3, 'No SPAN is established yet, cannot decode command. Requesting a nonce...', { level: 'verbose' }));
    srv.push(logEvent(3, 'failed to decode the message, retrying with SPAN extension...'));
    await waitFor(() => got.s2.length === 2); // 1 from before the drop + this one; the incoming line is not a resync
    assert.equal(got.s2[1], 3);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('every driver logging event reaches the archive callback — but not once the storm guard has PAUSED the stream (v0.75.4)', async () => {
  const srv = await mockServer();
  const seen: Record<string, unknown>[] = [];
  const client = createDriverWsClient({ url: srv.url, callbacks: { onDriverLog: (ev) => seen.push(ev) }, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => srv.commands.includes('start_listening_logs'));
    srv.push(logEvent(60, 'Value updated: 112-0-8 0 => 3'));
    await waitFor(() => seen.length === 1);
    assert.equal(seen[0].event, 'logging', 'the event itself, for the archive to format and redact');
    for (let i = 0; i < 3005; i++) srv.push(logEvent(6, 'SERIAL » 0x01…'));
    await waitFor(() => srv.commands.includes('stop_listening_logs'));
    const atStop = seen.length;
    srv.push(logEvent(60, 'after the stop'));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(seen.length, atStop, 'a paused stream archives nothing more');
    assert.ok(atStop <= 3001, `at most the metered allowance reached the archive (${atStop})`);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('storm guard: a hot stream pauses OUR subscription, drops what is in flight unmatched and counted, and resumes on its own — no reconnect (v0.76.0)', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const archived: Record<string, unknown>[] = [];
  const client = createDriverWsClient({ url: srv.url, callbacks: { ...callbacks, onDriverLog: (ev) => archived.push(ev) }, reconnectBaseMs: 60, logGuard: { perMin: 50, pauseBaseMs: 1500 } });
  client.start();
  try {
    await waitFor(() => srv.commands.includes('start_listening_logs') && client.s2LaneLive());
    // A radio-off reading taken before the storm, then a burst over the limit.
    srv.push({ source: 'driver', event: 'logging', level: 'info', message: 'Turning RF off...', context: { source: 'controller', type: 'controller' } });
    for (let i = 0; i < 60; i++) srv.push(logEvent(6, 'SERIAL » 0x01…'));
    await waitFor(() => srv.commands.includes('stop_listening_logs'));
    const paused = got.gaps.find((x) => x.kind === 'paused') as Extract<LogGap, { kind: 'paused' }>;
    assert.ok(paused, 'a paused note');
    assert.equal(paused.trip, 1);
    assert.equal(paused.limit, 50);
    assert.equal(paused.count, 51);
    assert.equal(client.s2LaneFault(), 'storm-paused');
    assert.equal(client.s2LaneLive(), false, 'the lane reads unknown while paused');
    assert.equal(client.rfWatchSince(), null);
    const resumeAt = client.s2LaneResumeAt() as number;
    assert.ok(resumeAt >= paused.at + 1400 && resumeAt <= paused.at + 1600, 'the resume time is the pause plus its length');
    assert.notEqual(client.controllerRfOffSince(), null, 'a reading taken before the pause keeps its deadline');
    assert.equal(archived.length, 50, 'the meter\'s allowance reached the archive, the tripping line did not');
    // A real S2 line in flight while paused is counted, never matched.
    srv.push(logEvent(17, 'failed to decode the message, retrying with SPAN extension...'));
    await sleep(100);
    assert.deepEqual(got.s2, []);
    // It resumes on its own: a second subscribe on the SAME connection.
    await waitFor(() => srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    assert.equal(srv.connectionCount(), 1, 'no reconnect');
    await waitFor(() => client.s2LaneLive());
    const resumed = got.gaps.find((x) => x.kind === 'resumed') as Extract<LogGap, { kind: 'resumed' }>;
    assert.equal(resumed.dropped, 12, 'the tripping line, the ten after it and the S2 line');
    assert.equal(resumed.trip, 1);
    srv.push(logEvent(17, 'failed to decode the message, retrying with SPAN extension...'));
    await waitFor(() => got.s2.length === 1);
    assert.deepEqual(got.s2, [17], 'the resumed stream is metered from zero and matched');
    assert.deepEqual(got.gaps.map((x) => x.kind), ['subscribed', 'paused', 'resumed']);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('a reconnect while paused re-subscribes once; the old pause timer dies with the connection and the ladder starts again (v0.76.0)', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, logGuard: { perMin: 20, pauseBaseMs: 1500 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'line'));
    await waitFor(() => srv.commands.includes('stop_listening_logs'));
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    await sleep(1700);
    assert.equal(srv.commands.filter((c) => c === 'start_listening_logs').length, 2, 'no stale resume from the old connection');
    assert.equal(client.s2LaneLive(), true);
    assert.equal(client.s2LaneFault(), null);
    const kinds = got.gaps.map((x) => x.kind);
    assert.ok(kinds.indexOf('ended') > kinds.indexOf('paused'), 'the paused stream ends with its connection');
    assert.equal((got.gaps.find((x) => x.kind === 'ended') as Extract<LogGap, { kind: 'ended' }>).reason, 'connection closed');
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'line'));
    await waitFor(() => got.gaps.filter((x) => x.kind === 'paused').length === 2);
    assert.equal((got.gaps.filter((x) => x.kind === 'paused')[1] as Extract<LogGap, { kind: 'paused' }>).trip, 1, 'a new connection starts the ladder again');
  } finally {
    client.stop();
    await srv.close();
  }
});

test('storm guard backoff: consecutive pauses double, a calm stream starts the ladder again (v0.76.0)', async () => {
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, logGuard: { perMin: 20, pauseBaseMs: 300, pauseMaxMs: 1200, calmMs: 2500 } });
  client.start();
  try {
    const resumes = () => got.gaps.filter((x) => x.kind === 'resumed').length;
    await waitFor(() => client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'line'));
    await waitFor(() => resumes() === 1 && client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'line'));
    await waitFor(() => resumes() === 2 && client.s2LaneLive());
    await sleep(2600);
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'line'));
    await waitFor(() => got.gaps.filter((x) => x.kind === 'paused').length === 3);
    const p = got.gaps.filter((x) => x.kind === 'paused') as Extract<LogGap, { kind: 'paused' }>[];
    assert.deepEqual(p.map((x) => [x.trip, x.resumeAt - x.at]), [[1, 300], [2, 600], [1, 300]]);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('storm guard at debug: a burst carrying debug lines pauses for the cap; only a QUIETER reported level resumes it early (v0.76.0)', async () => {
  const srv = await mockServer({ logLevel: 'info' });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, logGuard: { perMin: 20, pauseBaseMs: 300, pauseMaxMs: 60_000 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'SERIAL » 0x01…', { level: 'debug' }));
    await waitFor(() => srv.commands.includes('stop_listening_logs'));
    const p = got.gaps.find((x) => x.kind === 'paused') as Extract<LogGap, { kind: 'paused' }>;
    assert.equal(p.resumeAt - p.at, 60_000, 'the cap at once');
    assert.equal(p.level, 'debug', 'judged on the lines, not the reported info');
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'silly' } });
    await waitFor(() => got.gaps.some((x) => x.kind === 'level'));
    await sleep(500);
    assert.equal(srv.commands.filter((c) => c === 'start_listening_logs').length, 1, 'a louder level does not resume the storm');
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'verbose' } });
    await waitFor(() => srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    await waitFor(() => got.gaps.some((x) => x.kind === 'resumed'));
  } finally {
    client.stop();
    await srv.close();
  }
});

test('the driver log level comes from the state dump and log config updated events, and only a known name is kept (v0.76.0)', async () => {
  const srv = await mockServer({ logLevel: 'info' });
  const { got, callbacks } = collect();
  const lines: string[] = [];
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, log: (m: string) => lines.push(m) });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    assert.equal(client.driverLogLevel(), 'info');
    assert.ok(lines.some((l) => /state dump processed \(2 nodes, bgRSSI present, driver log level info\)/.test(l)));
    assert.ok(lines.some((l) => /log stream active \(S2 SPAN-resync watch; driver log level info\)/.test(l)));
    assert.equal((got.gaps.find((x) => x.kind === 'subscribed') as Extract<LogGap, { kind: 'subscribed' }>).level, 'info');
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'verbose' } });
    await waitFor(() => client.driverLogLevel() === 'verbose');
    assert.ok(lines.some((l) => /driver log level info → verbose/.test(l)));
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'LOUD' } });
    srv.push({ source: 'driver', event: 'log config updated', config: null });
    // A valid sentinel behind them: frames arrive in order, so once it lands
    // the two before it were processed — and ignored.
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'debug' } });
    await waitFor(() => client.driverLogLevel() === 'debug');
    assert.deepEqual(got.gaps.filter((x) => x.kind === 'level').map((x) => {
      const l = x as Extract<LogGap, { kind: 'level' }>;
      return [l.from, l.to];
    }), [['info', 'verbose'], ['verbose', 'debug']]);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('silence after verbose lines: one re-subscribe per silent stretch; the lane reads silent until a line arrives (v0.76.0)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 400 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push({ source: 'driver', event: 'logging', level: 'verbose', message: '[REQ] [GetBackgroundRSSI]', context: { source: 'driver', direction: 'outbound' } });
    await waitFor(() => srv.commands.filter((c) => c === 'start_listening_logs').length === 2);
    assert.equal(srv.commands.filter((c) => c === 'stop_listening_logs').length, 1);
    await waitFor(() => got.gaps.filter((x) => x.kind === 'subscribed').length === 2);
    assert.deepEqual(got.gaps.map((x) => x.kind), ['subscribed', 'silent', 'subscribed']);
    assert.equal((got.gaps[2] as Extract<LogGap, { kind: 'subscribed' }>).after, 'silence');
    assert.equal(client.s2LaneFault(), 'silent');
    assert.equal(client.s2LaneLive(), false);
    assert.equal(client.rfWatchSince(), null);
    await sleep(1200);
    assert.equal(srv.commands.filter((c) => c === 'stop_listening_logs').length, 1, 'one attempt per silent stretch');
    srv.push(logEvent(6, 'line'));
    await waitFor(() => client.s2LaneLive());
    assert.equal(client.s2LaneFault(), null);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('silence is normal at info, and the reported level does not arm the watchdog — only verbose lines received do (v0.76.0)', async () => {
  for (const level of ['info', 'verbose']) {
    const srv = await mockServer({ logLevel: level });
    const { callbacks } = collect();
    const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 400 } });
    client.start();
    try {
      await waitFor(() => client.s2LaneLive());
      srv.push(logEvent(6, 'an info line')); // the stream carries info lines only
      await sleep(1500);
      assert.equal(srv.commands.filter((c) => c === 'stop_listening_logs').length, 0, `${level}: no re-subscribe`);
      assert.equal(client.s2LaneLive(), true);
      assert.equal(client.s2LaneFault(), null);
    } finally {
      client.stop();
      await srv.close();
    }
  }
});

test('gap notes: subscribed, refused with the code, ended when the link drops or stops (v0.76.0)', async () => {
  const refused = await mockServer({ refuseLogs: true });
  const r = collect();
  const c1 = createDriverWsClient({ url: refused.url, callbacks: r.callbacks, reconnectBaseMs: 60 });
  c1.start();
  try {
    await waitFor(() => r.got.gaps.some((x) => x.kind === 'refused'));
    assert.equal((r.got.gaps.find((x) => x.kind === 'refused') as Extract<LogGap, { kind: 'refused' }>).code, 'unknown_command');
    assert.equal(c1.s2LaneFault(), 'refused');
  } finally {
    c1.stop();
    await refused.close();
  }
  const srv = await mockServer();
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && client.s2LaneLive());
    client.stop();
    const g = got.gaps.map((x) => (x.kind === 'ended' ? `ended:${x.reason}` : x.kind));
    assert.deepEqual(g, ['subscribed', 'ended:connection closed', 'subscribed', 'ended:stopped']);
  } finally {
    client.stop();
    await srv.close();
  }
});

/* ── v0.76.0 review: the watchdog across reconnects, levels, the node filter ── */

const verboseLine = { source: 'driver', event: 'logging', level: 'verbose', message: '[REQ] [GetBackgroundRSSI]', context: { source: 'driver', direction: 'outbound' } };
const starts = (srv: { commands: string[] }) => srv.commands.filter((c) => c === 'start_listening_logs').length;
const stops = (srv: { commands: string[] }) => srv.commands.filter((c) => c === 'stop_listening_logs').length;

test('a silence still unresolved when the link drops carries to the next subscription on the same network; its watch starts at the first line (v0.76.0 review)', async () => {
  // HA keeps its log subscription after debug logging is turned off, so a
  // forwarder a Z-Wave JS UI capture detached stays started — and detached —
  // across our reconnect: a fresh subscription brings nothing back.
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 400 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push(verboseLine);
    await waitFor(() => starts(srv) === 2 && client.s2LaneFault() === 'silent' && got.gaps.filter((x) => x.kind === 'subscribed').length === 2);
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && got.gaps.filter((x) => x.kind === 'subscribed').length === 3);
    assert.equal(client.s2LaneFault(), 'silent', 'the verdict carried: no line has come back');
    assert.equal(client.s2LaneLive(), false);
    assert.equal(client.rfWatchSince(), null);
    await sleep(1000);
    assert.equal(stops(srv), 1, 'still one re-subscribe per silent stretch');
    const before = Date.now();
    srv.push(logEvent(6, 'line'));
    await waitFor(() => client.s2LaneLive());
    assert.ok(client.rfWatchSince()! >= before, 'watched from the first line, not from the re-subscribe');
  } finally {
    client.stop();
    await srv.close();
  }
});

test('the first line after a silence re-subscribe starts the watch — the dark stretch between them is not watched (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 400 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push(verboseLine);
    await waitFor(() => starts(srv) === 2 && client.s2LaneFault() === 'silent');
    await sleep(300);
    const before = Date.now();
    srv.push(logEvent(6, 'line'));
    await waitFor(() => client.s2LaneLive());
    assert.ok(client.rfWatchSince()! >= before, `watch ${client.rfWatchSince()} began before the line at ${before}`);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('a carried silence is dropped by a server now reporting below verbose, or by another network (v0.76.0 review)', async () => {
  for (const next of [{ logLevel: 'info' }, { homeId: 1234 }]) {
    const srv = await mockServer({ logLevel: 'verbose' });
    const { got, callbacks } = collect();
    const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 400 } });
    client.start();
    try {
      await waitFor(() => client.s2LaneLive());
      srv.push(verboseLine);
      await waitFor(() => starts(srv) === 2 && client.s2LaneFault() === 'silent');
      srv.configure(next);
      srv.dropClient();
      await waitFor(() => srv.connectionCount() === 2 && got.gaps.filter((x) => x.kind === 'subscribed').length === 3);
      assert.equal(client.s2LaneFault(), null, `${JSON.stringify(next)}: nothing carried`);
      assert.equal(client.s2LaneLive(), true);
    } finally {
      client.stop();
      await srv.close();
    }
  }
});

test('an armed watchdog arms the next subscription on the same network: a forwarder that detached just before a reconnect is still noticed (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  let lines = 0;
  const client = createDriverWsClient({ url: srv.url, callbacks: { ...callbacks, onDriverLog: () => { lines += 1; } }, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 600 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push(verboseLine);
    await waitFor(() => lines === 1);
    srv.dropClient(); // before the watchdog's ten minutes
    await waitFor(() => srv.connectionCount() === 2 && client.s2LaneLive());
    assert.equal(stops(srv), 0);
    // The new subscription carries no line at all.
    await waitFor(() => got.gaps.some((x) => x.kind === 'silent'), 4000);
    assert.equal(client.s2LaneFault(), 'silent');
    // The note is emitted before the stop is sent: wait for the server to see it.
    await waitFor(() => stops(srv) === 1);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('a drop to info with no event disarms the watchdog on the first info line long after the last verbose one; one right behind it does not (v0.76.0 review)', async () => {
  for (const [gapMs, fires] of [[350, false], [0, true]] as const) {
    const srv = await mockServer({ logLevel: 'verbose' });
    const { got, callbacks } = collect();
    const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 500, verboseRecentMs: 200 } });
    client.start();
    try {
      await waitFor(() => client.s2LaneLive());
      srv.push(verboseLine);
      if (gapMs) await sleep(gapMs);
      srv.push(logEvent(6, 'an info line'));
      await sleep(1500);
      assert.equal(got.gaps.some((x) => x.kind === 'silent'), fires, `info line ${gapMs} ms after the verbose one`);
      assert.equal(stops(srv), fires ? 1 : 0);
    } finally {
      client.stop();
      await srv.close();
    }
  }
});

test('a reported level below verbose disarms the watchdog at once — before any line says so (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  let lines = 0;
  const client = createDriverWsClient({ url: srv.url, callbacks: { ...callbacks, onDriverLog: () => { lines += 1; } }, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { silenceMs: 500 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push(verboseLine);
    await waitFor(() => lines === 1);
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    await waitFor(() => client.driverLogLevel() === 'info');
    await sleep(1500);
    assert.ok(!got.gaps.some((x) => x.kind === 'silent'), 'silence at info is normal');
    assert.equal(stops(srv), 0);
  } finally {
    client.stop();
    await srv.close();
  }
});

test('a stream resumed after a storm pause is not judged silent on the lines before the pause (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, livenessMs: 1200, logGuard: { perMin: 20, pauseBaseMs: 700, silenceMs: 400 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push({ ...verboseLine });
    await waitFor(() => got.gaps.some((x) => x.kind === 'resumed'));
    await sleep(800); // no line after the resume, for longer than silenceMs
    assert.ok(!got.gaps.some((x) => x.kind === 'silent'), 'disarmed until a verbose line arrives on the resumed stream');
  } finally {
    client.stop();
    await srv.close();
  }
});

test('the silence watchdog writes one line when it arms or disarms, and logWatch reports the lane (v0.76.1)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { callbacks } = collect();
  const lines: string[] = [];
  let n = 0;
  const client = createDriverWsClient({ url: srv.url, callbacks: { ...callbacks, onDriverLog: () => { n += 1; } }, reconnectBaseMs: 60, log: (m: string) => lines.push(m), logGuard: { verboseRecentMs: 200 } });
  client.start();
  const watch = () => lines.filter((l) => /silence watchdog/.test(l));
  try {
    await waitFor(() => client.s2LaneLive());
    assert.deepEqual(client.logWatch(), { level: 'verbose', laneLive: true, watchdogArmed: false }, 'no verbose line yet');
    srv.push(verboseLine);
    srv.push(verboseLine);
    await waitFor(() => n === 2);
    assert.deepEqual(watch(), ['driver-ws: silence watchdog armed — verbose lines are arriving'], 'one line, not one per line');
    assert.equal(client.logWatch().watchdogArmed, true);
    await sleep(300);
    srv.push(logEvent(6, 'an info line'));
    await waitFor(() => n === 3);
    assert.equal(watch()[1], 'driver-ws: silence watchdog disarmed — no verbose line in the 0s before this one');
    srv.push(verboseLine);
    await waitFor(() => n === 4);
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    await waitFor(() => client.driverLogLevel() === 'info');
    assert.deepEqual(watch().slice(2), ['driver-ws: silence watchdog armed — verbose lines are arriving', 'driver-ws: silence watchdog disarmed — level info']);
    assert.deepEqual(client.logWatch(), { level: 'info', laneLive: true, watchdogArmed: false });
  } finally {
    client.stop();
    await srv.close();
  }
});

test('the storm pause is judged on the lines received: a reported debug level with verbose lines takes the first rung (v0.76.0 review)', async () => {
  for (const [line, rung, level] of [[{ level: 'verbose' }, 300, 'verbose'], [{ level: undefined }, 60_000, 'debug']] as const) {
    const srv = await mockServer({ logLevel: 'debug' });
    const { got, callbacks } = collect();
    const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60, logGuard: { perMin: 20, pauseBaseMs: 300, pauseMaxMs: 60_000 } });
    client.start();
    try {
      await waitFor(() => client.s2LaneLive());
      for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'x', line));
      await waitFor(() => got.gaps.some((x) => x.kind === 'paused'));
      const p = got.gaps.find((x) => x.kind === 'paused') as Extract<LogGap, { kind: 'paused' }>;
      assert.equal(p.resumeAt - p.at, rung, `lines ${JSON.stringify(line)}: the ladder`);
      assert.equal(p.level, level, 'the reported level only when the lines carry none');
    } finally {
      client.stop();
      await srv.close();
    }
  }
});

test('the node filter follows log config updated, before the level check; a change starts a new S2 window and leaves the RF watch alone (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'info', nodeFilter: [6, 44] });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    const rf = client.rfWatchSince()!;
    assert.equal(client.s2WatchSince(), rf, 'no change yet: the same watch');
    await sleep(20);
    const before = Date.now();
    // Same level as the dump: the filter is still read.
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info', nodeFilter: [6] } });
    await waitFor(() => client.logNodeFilter()?.size === 1);
    assert.equal(client.rfWatchSince(), rf, 'the RF watch is not a node line');
    assert.ok(client.s2WatchSince()! >= before, 'S2 counts start a new window');
    // The whole config is sent and JSON drops an unset filter: absent = every node.
    // Same size, another node: still a change.
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info', nodeFilter: [44] } });
    await waitFor(() => client.logNodeFilter()?.has(44) === true);
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    await waitFor(() => client.logNodeFilter() === null);
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'verbose' } });
    await waitFor(() => client.driverLogLevel() === 'verbose');
    assert.deepEqual(got.gaps.filter((x) => x.kind === 'filter').map((x) => (x as Extract<LogGap, { kind: 'filter' }>).nodes), [1, 1, null], 'one note per change');
  } finally {
    client.stop();
    await srv.close();
  }
});

test('the ended note reports the loudest level the connection received, whatever reset the watchdog since (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'debug' });
  const { got, callbacks } = collect();
  let lines = 0;
  const client = createDriverWsClient({ url: srv.url, callbacks: { ...callbacks, onDriverLog: () => { lines += 1; } }, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push(logEvent(6, 'x', { level: 'debug' }));
    await waitFor(() => lines === 1);
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    await waitFor(() => client.driverLogLevel() === 'info');
    srv.dropClient();
    await waitFor(() => got.gaps.some((x) => x.kind === 'ended'));
    assert.equal((got.gaps.find((x) => x.kind === 'ended') as Extract<LogGap, { kind: 'ended' }>).level, 'debug');
  } finally {
    client.stop();
    await srv.close();
  }
});

test('below info the lane is dark and says why; back at info its watch starts at the change (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'info' });
  const { callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'warn' } });
    await waitFor(() => client.driverLogLevel() === 'warn');
    assert.equal(client.s2LaneFault(), 'level');
    assert.equal(client.s2LaneLive(), false);
    assert.equal(client.rfWatchSince(), null);
    assert.equal(client.s2WatchSince(), null);
    await sleep(20);
    const before = Date.now();
    srv.push({ source: 'driver', event: 'log config updated', config: { level: 'info' } });
    await waitFor(() => client.s2LaneLive());
    assert.ok(client.rfWatchSince()! >= before, 'what came before the change was not watched');
    assert.equal(client.s2LaneFault(), null);
  } finally {
    client.stop();
    await srv.close();
  }
  const low = await mockServer({ logLevel: 'error' });
  const c2 = createDriverWsClient({ url: low.url, callbacks: {}, reconnectBaseMs: 60 });
  c2.start();
  try {
    await waitFor(() => c2.state() === 'live' && c2.s2LaneFault() === 'level');
    assert.equal(c2.rfWatchSince(), null, 'a dump below info: dark from the start');
  } finally {
    c2.stop();
    await low.close();
  }
});

test('a socket already CLOSING: the storm resume and the watchdog wait for the close — no false refusal, no silence, and the lane ends with its note (v0.76.0 review)', async () => {
  const srv = await mockServer({ logLevel: 'verbose' });
  const { got, callbacks } = collect();
  const client = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60_000, logGuard: { perMin: 20, pauseBaseMs: 300 } });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    for (let i = 0; i < 25; i++) srv.push(logEvent(6, 'x'));
    await waitFor(() => client.s2LaneFault() === 'storm-paused');
    srv.holdClose();
    await sleep(700); // the 300 ms resume timer fires while the close hangs
    assert.equal(client.state(), 'live', 'the close has not landed');
    assert.equal(client.s2LaneFault(), 'storm-paused', 'not a refusal');
    srv.dropClient();
    await waitFor(() => got.gaps.some((x) => x.kind === 'ended'));
    assert.ok(!got.gaps.some((x) => x.kind === 'refused'));
  } finally {
    srv.dropClient();
    client.stop();
    await srv.close();
  }
  const s2 = await mockServer({ logLevel: 'verbose' });
  const r = collect();
  const c2 = createDriverWsClient({ url: s2.url, callbacks: r.callbacks, reconnectBaseMs: 60_000, livenessMs: 1200, logGuard: { silenceMs: 400 } });
  c2.start();
  try {
    await waitFor(() => c2.s2LaneLive());
    s2.push(verboseLine);
    await sleep(100);
    s2.holdClose();
    await sleep(1000);
    assert.equal(c2.state(), 'live');
    assert.ok(!r.got.gaps.some((x) => x.kind === 'silent'), 'no silence verdict on a socket that is closing');
    assert.equal(c2.s2LaneFault(), null);
  } finally {
    s2.dropClient(); // the paused server side never reads the client's FIN
    c2.stop();
    await s2.close();
  }
});

test('stormPauseMs: 5 → 10 → 20 → 40 → 60 min, capped; debug and silly take the full hour at once (v0.76.0)', () => {
  assert.equal(stormPauseMs(1, 'info'), 300_000);
  assert.equal(stormPauseMs(2, 'verbose'), 600_000);
  assert.equal(stormPauseMs(3, null), 1_200_000);
  assert.equal(stormPauseMs(4, 'info'), 2_400_000);
  assert.equal(stormPauseMs(5, 'info'), 3_600_000);
  assert.equal(stormPauseMs(40, 'info'), 3_600_000);
  assert.equal(stormPauseMs(1, 'debug'), 3_600_000);
  assert.equal(stormPauseMs(1, 'silly'), 3_600_000);
  assert.equal(stormPauseMs(0, 'info'), 300_000);
  assert.equal(stormPauseMs(2, 'info', { pauseBaseMs: 100, pauseMaxMs: 400 }), 200);
  assert.equal(LOG_GUARD.perMin, 3000);
});

test('parseDriverLogLevel, levelAtLeast and parseNodeFilter: only the seven zwave-js names, quietest first; sane node ids (v0.76.0)', () => {
  assert.deepEqual([...DRIVER_LOG_LEVELS], ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);
  assert.equal(parseDriverLogLevel('verbose'), 'verbose');
  assert.equal(parseDriverLogLevel('silly'), 'silly');
  for (const v of ['VERBOSE', 'loud', 4, undefined, null]) assert.equal(parseDriverLogLevel(v), null);
  assert.equal(levelAtLeast('verbose', 'verbose'), true);
  assert.equal(levelAtLeast('info', 'verbose'), false);
  assert.equal(levelAtLeast('debug', 'verbose'), true);
  assert.equal(levelAtLeast(null, 'verbose'), false);
  assert.equal(parseNodeFilter(undefined), null);
  assert.equal(parseNodeFilter('5'), null, 'not an array: no filter');
  // zwave-js: `if (!nodeFilter) return true; return nodeFilter.includes(id)` —
  // a filter present but empty, or holding only junk ([NaN] serialises as
  // [null]), logs NO node: an empty set, never "every node".
  assert.deepEqual([...(parseNodeFilter([]) ?? ['every'])], [], 'empty: no node logged');
  assert.deepEqual([...(parseNodeFilter([null, 'abc']) ?? ['every'])], [], 'all junk: no node logged');
  assert.deepEqual([...(parseNodeFilter([7, 'x', 4001, 12]) ?? [])], [7, 12]);
});

test('logGapNote: every kind reads as a sentence with its numbers (v0.76.0)', () => {
  assert.equal(logGapNote({ kind: 'paused', at: 0, count: 3001, windowMs: 12_000, perMin: 15005, limit: 3000, resumeAt: 300_000, trip: 1, level: 'debug' }),
    'driver log stream paused by the storm guard: 3001 lines in 12s (≈15005/min, limit 3000/min, level debug) — resumes in 5m00s (pause 1)');
  assert.match(logGapNote({ kind: 'resumed', at: 0, pausedMs: 3_600_000, dropped: 37, trip: 5 }),
    /^driver log stream resumed after 1h00m \(pause 5\) — 37 line\(s\) that arrived during the pause were dropped/);
  assert.equal(logGapNote({ kind: 'subscribed', at: 0, level: 'info', after: 'connect' }), 'driver log stream subscribed — driver log level info');
  assert.match(logGapNote({ kind: 'subscribed', at: 0, level: null, after: 'silence' }), /re-subscribed after silence — driver log level unknown/);
  assert.match(logGapNote({ kind: 'silent', at: 0, silentMs: 600_000, level: 'verbose' }), /no driver log line for 10m00s after verbose lines — re-subscribing once/);
  assert.match(logGapNote({ kind: 'level', at: 0, from: 'info', to: 'verbose' }), /^driver log level info → verbose/);
  assert.match(logGapNote({ kind: 'refused', at: 0, code: 'unknown_command' }), /refused by the server \(unknown_command\)/);
  assert.equal(logGapNote({ kind: 'filter', at: 0, nodes: 2 }), 'driver log node filter → 2 node(s) — S2 counts start a new window');
  assert.match(logGapNote({ kind: 'filter', at: 0, nodes: null }), /^driver log node filter → every node/);
  assert.match(logGapNote({ kind: 'silent', at: 0, silentMs: 600_000, level: 'verbose' }), /or the level lowered with no event/);
  assert.match(logGapNote({ kind: 'ended', at: 0, reason: 'stopped', level: 'verbose' }), /^driver log stream ended \(stopped\) — loudest level received verbose/);
});

test('the dump\'s log node filter is kept: a node outside it logs nothing (v0.76.0)', async () => {
  const srv = await mockServer({ nodeFilter: [6, 44] });
  const client = createDriverWsClient({ url: srv.url, callbacks: {}, reconnectBaseMs: 60 });
  client.start();
  try {
    await waitFor(() => client.s2LaneLive());
    assert.deepEqual([...(client.logNodeFilter() ?? [])], [6, 44]);
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
      pendingIdentity: () => null,
      resolveIdentityDecision: () => false,
    autonomyPause: () => null, pauseAutonomy: () => ({ by: ["tui"], since: 0, reason: "" }), resumeAutonomy: () => ({ resumed: false, stillPausedBy: null }), autonomyPauseOverdue: () => false,
    sleeperWatches: () => [],
    actorArms: () => [], pooledArm: () => null, liveSpan: () => null, routeSymptomsAfter: () => 0,
      ackEvent: (seq: number) => seq === 42,
      routeStability: (n: number) => ({ changes: n, hours: 48 }),
      // v0.35 additions — each one an exemplar from the SAME family the hole
      // came from: a capability the data layer implements and a screen reads.
      routeFailures: (n: number) => [{ t: 1000 + n, between: [n, n + 1] as [number, number] }],
      evidenceCoverage: (n: number) => ({ firstSeenAt: n, samples: n * 2, freshSamples: n, statusFeedLive: true, statsFeedLive: false }),
      // THE REAL BUCKET SHAPE (v0.63.1). This carried `rttMin`/`rttMax`/`dFlaps`
      // /`dS2Resync`/`dRouteChanges` — members production does not have — and
      // omitted `dDropTx`/`dRx`/`flaps`/`routeChanges`/`s2`, which it does. The
      // enclosing `as never` hid all of it, so a test written to pin the
      // bridge's REQUIRED-ness was asserting against a fiction.
      evidenceCoarse: (n: number) => [{ t0: n, n: 5, freshN: 4, invalidW: 1, dTx: 90, dTimeout: 3, dDropTx: 1, dRx: 85, flaps: 0, routeChanges: 1, s2: 0, rssiN: 6, rssiSum: -390, rssiMin: -72, rssiMax: -58, rttN: 6, rttSum: 300, rateMin: 40 }],
      falsePositives: (k: string) => (k === 'route-churn' ? 4 : 0),
      unverifiableCount: (k: string) => (k === 'rtt-degraded' ? 16 : 0),
      unverifiableTransientCount: (k: string) => (k === 'rtt-degraded' ? 5 : 0),
      unverifiableUndersampledCount: (k: string) => (k === 'rtt-degraded' ? 4 : 0),
      confoundedCount: (k: string) => (k === 'rtt-degraded' ? 2 : 0),
      openEpisodes: () => [{ key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded', onsetMs: 1, actionKind: null, confounded: false, beforeFreshN: 4, confirming: true }],
      controlArm: (k: string) => (k === 'rtt-degraded' ? { n: 6, ok: 5, bad: 0, nodes: 3, minN: 4 } : null),
      driverWsStatus: () => 'live (schema 41)',
      driverWsState: () => 'backoff',
      s2LaneFault: () => 'storm-paused',
      s2LaneResumeAt: () => 1234,
      driverLogWatch: () => ({ level: 'verbose', laneLive: false, watchdogArmed: true }),
      autoPingState: () => ({ lastTickMs: 42, suppressed: 'storm', listening: 35, deadListening: 1, staleDue: 2, stalestMs: 60, verifyOwed: 3, config: { enabled: true, writeActions: true, afterMs: 1, maxAttempts: 3, staleMs: 1 }, nodes: [] }),
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
    // Assert a field the OLD shape never had. `t0` alone passes for either,
    // which is why these tests did not catch the fiction in the first place.
    const cb = provider.provider.evidenceCoarse?.(7) ?? [];
    assert.equal(cb.length, 1, 'the coarse tier crosses the bridge');
    assert.equal(cb[0].t0, 7);
    assert.equal(cb[0].rssiMin, -72, 'the RF content crosses too — not just the timestamp');
    assert.equal(cb[0].invalidW, 1);
    assert.equal(provider.provider.falsePositives?.('route-churn'), 4);
    assert.equal(provider.provider.falsePositives?.('dead-flap'), 0, 'and carries a real 0, not a default one');
    assert.equal(provider.provider.unverifiableCount?.('rtt-degraded'), 16);
    assert.equal(provider.provider.unverifiableCount?.('dead-flap'), 0);
    assert.equal(provider.provider.unverifiableTransientCount?.('rtt-degraded'), 5, 'the v0.39 member crosses the bridge');
    assert.equal(provider.provider.unverifiableUndersampledCount?.('rtt-degraded'), 4, 'the v0.41.2 member crosses the bridge');
    assert.equal(provider.provider.unverifiableTransientCount?.('dead-flap'), 0);
    assert.equal(provider.provider.confoundedCount?.('rtt-degraded'), 2, 'the v0.40 member crosses the bridge');
    // v0.41: the ENGINE screen's three members. A screen reading an optional
    // provider member the production bridge forgot to wire renders a silent
    // blank — the v0.33 dead-M-key class, which this whole release is about.
    assert.equal(provider.provider.openEpisodes()?.length, 1, 'openEpisodes crosses the bridge');
    assert.equal(provider.provider.controlArm?.('rtt-degraded')?.n, 6, 'controlArm crosses the bridge');
    assert.equal(provider.provider.s2LaneFault?.(), 'storm-paused', 's2LaneFault crosses the bridge');
    assert.equal(provider.provider.s2LaneResumeAt?.(), 1234, 's2LaneResumeAt crosses the bridge (v0.76.0)');
    assert.deepEqual(provider.provider.driverLogWatch?.(), { level: 'verbose', laneLive: false, watchdogArmed: true }, 'driverLogWatch crosses the bridge (v0.76.1)');
    assert.equal(provider.provider.autoPingState?.()?.suppressed, 'storm', 'autoPingState crosses the bridge');
    assert.equal(provider.provider.driverWsStatus?.(), 'live (schema 41)', 'driverWsStatus crosses the bridge');
    assert.equal(provider.provider.driverWsState?.(), 'backoff', 'driverWsState crosses the bridge');
    assert.equal(provider.provider.confoundedCount?.('dead-flap'), 0);
    assert.deepEqual(provider.provider.rssiNormal?.(62), { median: -62, scale: 3, ready: true, days: 7 });
  } finally {
    provider.stop();
  }
});

test('a peer that upgrades and PONGS but never handshakes is torn down (v0.53.0)', async () => {
  // The liveness probe measures `lastMsgAt`, which `sock.on('pong')` refreshes.
  // So a server that completes the WS upgrade, answers every ping, and never
  // answers `start_listening` looked healthy forever: state stuck at
  // `handshake`, no evidence stream, no reconnect, for the life of the process.
  // The handshake needs its own clock, measured from OPEN — which nothing
  // refreshes — and it must be tested FIRST so the reason is accurate.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  let connections = 0;
  wss.on('connection', (ws) => {
    connections += 1;
    // Answer the version handshake, then go deliberately mute — but keep
    // answering protocol pings, which is what defeated the liveness probe.
    ws.send(JSON.stringify({ type: 'version', driverVersion: '15.0.0', serverVersion: '3.0.0', minSchemaVersion: 32, maxSchemaVersion: 41, homeId: 1 }));
    ws.on('message', () => { /* never resolves start_listening */ });
  });
  const logs: string[] = [];
  const c = createDriverWsClient({
    url: `ws://127.0.0.1:${port}`,
    callbacks: collect().callbacks,
    reconnectBaseMs: 20,
    livenessMs: 300,
    log: (m: string) => logs.push(m),
  } as never);
  c.start();
  await new Promise((r) => setTimeout(r, 1600));
  c.stop();
  wss.close();
  assert.ok(logs.some((l) => /handshake never completed/.test(l)),
    `a wedged handshake must be named as such: ${logs.join(' | ')}`);
  assert.ok(connections >= 2, `and must reconnect, not sit forever: ${connections} connections`);
});


test('the S2 lane names WHY it is dark — storm-paused, refused, silent — and stays quiet while pending (v0.62.0; v0.76.0)', () => {
  const F = (o: Partial<Parameters<typeof s2Fault>[0]>) => s2Fault({ logsAcked: true, logsMsgId: 'm1', stormPaused: false, silent: false, live: true, ...o });
  // Live and acked: nothing to say.
  assert.equal(F({}), null);
  // The storm guard paused it — s2-desync detection is OFF while the socket is
  // still `live`, so every screen went on saying the link was fine.
  assert.equal(F({ stormPaused: true }), 'storm-paused');
  // The server refused the subscription.
  assert.equal(F({ logsAcked: false, logsMsgId: null }), 'refused');
  // Silent after verbose lines: a detached forwarder (v0.76.0).
  assert.equal(F({ silent: true }), 'silent');
  assert.equal(F({ silent: true, live: false }), null);
  // Below info the lines it counts are never written (v0.76.0) — the cause
  // that explains a silence too, so it is named first; a pause or a refusal
  // still outranks it.
  assert.equal(F({ levelLow: true }), 'level');
  assert.equal(F({ levelLow: true, silent: true }), 'level');
  assert.equal(F({ levelLow: true, stormPaused: true }), 'storm-paused');
  assert.equal(F({ levelLow: true, logsAcked: false, logsMsgId: null }), 'refused');
  assert.equal(F({ levelLow: true, live: false }), null);
  // PENDING is not a fault: a normal connect is in flight, and a fault row on
  // every reconnect is the always-on chip this codebase keeps refusing to add.
  assert.equal(F({ logsAcked: false }), null);
  // Not live at all: the DRIVER LINK row already says so — do not double-report.
  assert.equal(F({ logsAcked: false, logsMsgId: null, live: false }), null);
});

/* ── v0.65.0: the controller's receiver going down ────────────────────────── */

test('controllerRfEvent reads only the controller\'s own lines, starting with the phrase — verbose dumps and debug value lines cannot flip the gate (v0.65.0; v0.76.0)', () => {
  const ctl = { source: 'controller', type: 'controller' };
  const ev = (message: unknown, ctx: unknown = ctl, level = 'info') =>
    ({ event: 'logging', level, message, ...(ctx !== undefined ? { context: ctx } : {}) }) as Record<string, unknown>;
  assert.equal(controllerRfEvent(ev('Turning RF off...')), 'off');
  assert.equal(controllerRfEvent(ev('Turning RF on...')), 'on');
  assert.equal(controllerRfEvent(ev('Turning RF\noff...')), 'off', 'the 80-column cut can fall anywhere');
  // A verbose DRIVER dump can carry a device- or user-set string (a node name).
  assert.equal(controllerRfEvent(ev('[REQ] [SendData]\n  └─[NodeNamingAndLocationCCNameSet]\n      name: Turning RF on...', { source: 'driver', direction: 'outbound' }, 'verbose')), null);
  // So can a debug value line.
  assert.equal(controllerRfEvent(ev('name: "Hall" => "Turning RF off..."', { source: 'controller', type: 'value', nodeId: 7 }, 'debug')), null);
  assert.equal(controllerRfEvent({ event: 'logging', message: 'Turning RF off...' }), null, 'no context is not the controller');
  assert.equal(controllerRfEvent(ev('Node 7 is named Turning RF off...')), null, 'the phrase must start the line');
  assert.equal(controllerRfEvent(ev('Error turning RF on: timeout')), null);
});

test('a NODE-attributed line can never switch the sweep off (v0.65.0)', () => {
  // The message text is server-sent. A node's own message must not be able to
  // suppress this add-on's write lane fleet-wide.
  const ev = { event: 'logging', context: { type: 'node', nodeId: 7 }, message: 'Turning RF off...' } as Record<string, unknown>;
  assert.equal(controllerRfEvent(ev), null);
});

test('controllerRfEvent ignores everything that is not a logging event (v0.65.0)', () => {
  assert.equal(controllerRfEvent({ event: 'statistics updated', message: 'Turning RF off...' } as never), null);
  assert.equal(controllerRfEvent({ event: 'logging', message: 'Querying node 7...' } as never), null);
  assert.equal(controllerRfEvent({ event: 'logging' } as never), null);
});

test('the RF-off reading EXPIRES, so a missed `on` cannot suppress forever (v0.65.0)', () => {
  // The blackout is ~10 s. One dropped log line must not switch the sweep off
  // until the add-on restarts — holds need deadlines.
  const T0 = 1_760_000_000_000;
  const up = { live: true, logsAcked: true };
  assert.ok(RF_OFF_MAX_MS >= 60_000 && RF_OFF_MAX_MS <= 10 * 60_000, 'generous, but bounded');
  assert.equal(rfOffActive(T0, T0 + 5_000, up), T0, 'inside the blackout it holds');
  assert.equal(rfOffActive(T0, T0 + RF_OFF_MAX_MS - 1, up), T0, 'right up to the deadline');
  assert.equal(rfOffActive(T0, T0 + RF_OFF_MAX_MS, up), null, 'and expires on it');
  assert.equal(rfOffActive(null, T0, up), null, 'nothing observed is not a blackout');
});

test('a reading nobody can refresh is not trusted: a dark link or a refused lane reads null; a storm pause keeps it to its deadline (v0.65.0; v0.76.0)', () => {
  // The `Turning RF on` that ends the blackout arrives on the same lane. With
  // the link down or the subscription refused we would never see it, so the
  // hold must not stand. A storm PAUSE leaves the subscription acknowledged,
  // and the reading keeps its own two-minute deadline (v0.76.0).
  const T0 = 1_760_000_000_000;
  assert.equal(rfOffActive(T0, T0 + 1_000, { live: false, logsAcked: true }), null);
  assert.equal(rfOffActive(T0, T0 + 1_000, { live: true, logsAcked: false }), null);
  assert.equal(rfOffActive(T0, T0 + 1_000, { live: true, logsAcked: true }), T0);
  assert.equal(rfOffActive(T0, T0 + RF_OFF_MAX_MS, { live: true, logsAcked: true }), null);
});

test('the client tracks the controller taking its radio down, and forgets it on reconnect (v0.65.0)', async () => {
  const srv = await mockServer();
  const { callbacks } = collect();
  const c = createDriverWsClient({ url: srv.url, callbacks, reconnectBaseMs: 60 });
  c.start();
  try {
    await waitFor(() => c.state() === 'live');
    await waitFor(() => srv.commands.includes('start_listening_logs'));
    assert.equal(c.controllerRfOffSince(), null, 'nothing observed yet is not a blackout');

    srv.push({ event: 'logging', context: { type: 'controller' }, message: 'Turning RF off...' });
    await waitFor(() => c.controllerRfOffSince() != null);
    srv.push({ event: 'logging', context: { type: 'controller' }, message: 'Turning RF on...' });
    await waitFor(() => c.controllerRfOffSince() == null);

    // A blackout observed on the OLD connection says nothing about the new one,
    // and the `Turning RF on` that ends it is lost while we are disconnected.
    srv.push({ event: 'logging', context: { type: 'controller' }, message: 'Turning RF off...' });
    await waitFor(() => c.controllerRfOffSince() != null);
    srv.dropClient();
    await waitFor(() => srv.connectionCount() === 2 && c.state() === 'live');
    assert.equal(c.controllerRfOffSince(), null, 'the hold does not survive a reconnect');
  } finally {
    c.stop();
    await srv.close();
  }
});


test('refreshQueriesOf counts the CC instances a user refresh queries — one switch value is the probe\'s own Get (v0.75.0)', () => {
  const v = (commandClass: number, endpoint = 0, property: string | number = 'currentValue') => ({ commandClass, endpoint, property });
  assert.equal(refreshQueriesOf([]), null, 'no values yet: unknown');
  assert.equal(refreshQueriesOf([v(0x26), v(0x26, 0, 'targetValue'), v(0x70, 0, 3), v(0x86, 0, 'firmwareVersions')]), 1, 'a dimmer: one Multilevel Switch instance, whatever else it has');
  assert.equal(refreshQueriesOf([v(0x25), v(0x32, 0, 'value-65537')]), 2, 'a metering plug: switch + meter');
  assert.equal(refreshQueriesOf([v(0x25, 1), v(0x25, 2)]), 2, 'two endpoints, two Gets');
  assert.equal(refreshQueriesOf([v(0x71, 0, 'Home Security')]), 0, 'Notification is not counted: its refresh queries only pull-mode nodes');
});


test('the state dump reports each node\'s refresh profile: unknown without values, zero for configuration alone (v0.75.0)', async () => {
  const srv = await mockServer();
  const got: [number, number | null][] = [];
  const c = createDriverWsClient({ url: srv.url, callbacks: { onNodeRefreshQueries: (id, q) => got.push([id, q]) } });
  c.start();
  try {
    await waitFor(() => got.length >= 2);
    assert.deepEqual(got.sort((a, b) => a[0] - b[0]), [[6, null], [44, 0]]);
  } finally {
    c.stop();
    await srv.close();
  }
});
