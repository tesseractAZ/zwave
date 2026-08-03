/**
 * HA Core WebSocket client — reconnect, auth, routing, backoff.
 *
 * This file exists because of the v0.26 assessment: the client had NO test
 * file at all, which meant the exact path exercised by the real 2026-07-31
 * zwave-js-update churn (connect → auth → subscribe → 1006 close → reconnect
 * → re-subscribe, ≥14 cycles) was entirely unproven. Every test here runs
 * against a real `ws` server on an ephemeral port — no monkey-patched sockets.
 *
 * Also pins the v0.26 backoff fix: attempts used to reset on `auth_ok`, so a
 * flapping Core (auth_ok then drop, forever) was rejoined at ~1s spacing for
 * as long as the flap lasted. Now the reset requires sustained stability
 * (STABLE_AFTER_MS), which no test can wait out — so the pinned behaviour is
 * the load-bearing half: the spacing between rejoin attempts GROWS while the
 * server keeps flapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createHaWsClient, type HaWsClient } from '../src/ha/haWsClient';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time');
    await sleep(25);
  }
}

interface MockHa {
  url: string;
  /** Every socket the server has accepted, in order. */
  socks: WsSocket[];
  /** Epoch-ms timestamps of each accepted connection (backoff spacing proof). */
  connectedAt: number[];
  /** Raw frames received per connection index. */
  frames: Record<string, unknown>[][];
  /** Auth behaviour knob: 'ok' completes the handshake, 'drop' closes the
   *  socket right AFTER auth_ok (the flapping-Core shape). */
  mode: { auth: 'ok' | 'ok-then-drop' };
  close(): Promise<void>;
}

/** A minimal mock HA Core: real WS server, real auth handshake. */
async function mockHa(): Promise<MockHa> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const m: MockHa = {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    socks: [], connectedAt: [], frames: [], mode: { auth: 'ok' },
    close: () => new Promise((r) => wss.close(() => r())),
  };
  wss.on('connection', (ws) => {
    const idx = m.socks.length;
    m.socks.push(ws);
    m.connectedAt.push(Date.now());
    m.frames.push([]);
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'test' }));
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as Record<string, unknown>;
      m.frames[idx].push(msg);
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', ha_version: 'test' }));
        if (m.mode.auth === 'ok-then-drop') {
          // A restarting Core: completes auth then the process goes away.
          setTimeout(() => ws.terminate(), 30);
        }
      }
    });
  });
  return m;
}

function client(url: string): HaWsClient {
  return createHaWsClient({ url, token: 'test-token', log: () => {} });
}

test('auth handshake: sends the token, becomes ready, routes send() results by id', async () => {
  const m = await mockHa();
  const c = client(m.url);
  try {
    c.start();
    await waitFor(() => c.ready());
    const auth = m.frames[0].find((f) => f.type === 'auth');
    assert.ok(auth, 'client never sent the auth frame');
    assert.equal(auth!.access_token, 'test-token');

    // send(): the FIRST matching {type:'result', id} resolves it — including
    // when an unrelated result for another id arrives first.
    const p = c.send({ type: 'ping-ish' });
    await waitFor(() => m.frames[0].some((f) => f.type === 'ping-ish'));
    const sent = m.frames[0].find((f) => f.type === 'ping-ish')!;
    const id = sent.id as number;
    m.socks[0].send(JSON.stringify({ id: id + 999, type: 'result', success: true, result: 'WRONG' }));
    m.socks[0].send(JSON.stringify({ id, type: 'result', success: true, result: { ok: 1 } }));
    assert.deepEqual(await p, { ok: 1 });
  } finally {
    c.stop();
    await m.close();
  }
});

test('subscription events route to their handler; pending send() rejects on close', async () => {
  const m = await mockHa();
  const c = client(m.url);
  try {
    c.start();
    await waitFor(() => c.ready());

    const got: unknown[] = [];
    const subP = c.subscribe({ type: 'subscribe_events' }, (ev) => got.push(ev));
    await waitFor(() => m.frames[0].some((f) => f.type === 'subscribe_events'));
    const subId = m.frames[0].find((f) => f.type === 'subscribe_events')!.id as number;
    m.socks[0].send(JSON.stringify({ id: subId, type: 'result', success: true, result: null }));
    await subP;
    m.socks[0].send(JSON.stringify({ id: subId, type: 'event', event: { n: 1 } }));
    m.socks[0].send(JSON.stringify({ id: subId + 5, type: 'event', event: { n: 'foreign' } }));
    await waitFor(() => got.length >= 1);
    // The handler receives the whole frame; the foreign-id event is dropped by
    // the router (no handler registered under subId+5), never reaching us.
    assert.equal(got.length, 1, 'exactly one event — the foreign id was routed away');
    assert.deepEqual((got[0] as { event: unknown }).event, { n: 1 });

    // A request in flight when the socket dies must reject, not hang forever —
    // callers (refresh loop) key their own recovery off that rejection.
    const dangling = c.send({ type: 'never-answered' });
    await waitFor(() => m.frames[0].some((f) => f.type === 'never-answered'));
    m.socks[0].terminate(); // 1006: no close frame — the churn's exact shape
    await assert.rejects(dangling, /closed|connection/i);
  } finally {
    c.stop();
    await m.close();
  }
});

test('1006 churn: reconnects, fires onReady per connection, subscriptions work on the new socket', async () => {
  const m = await mockHa();
  const c = client(m.url);
  try {
    let readyFires = 0;
    c.onReady(() => { readyFires += 1; });
    c.start();
    await waitFor(() => c.ready());
    assert.equal(readyFires, 1);

    m.socks[0].terminate();
    await waitFor(() => m.socks.length >= 2 && c.ready(), 8000);
    assert.equal(readyFires, 2, 'onReady must re-fire on the NEW connection (re-subscribe hook)');

    // The new socket is fully usable: subscribe and receive.
    const got: unknown[] = [];
    const subP = c.subscribe({ type: 'subscribe_events' }, (ev) => got.push(ev));
    const last = m.socks.length - 1;
    await waitFor(() => m.frames[last].some((f) => f.type === 'subscribe_events'));
    const subId = m.frames[last].find((f) => f.type === 'subscribe_events')!.id as number;
    m.socks[last].send(JSON.stringify({ id: subId, type: 'result', success: true, result: null }));
    await subP;
    m.socks[last].send(JSON.stringify({ id: subId, type: 'event', event: { alive: true } }));
    await waitFor(() => got.length === 1);
  } finally {
    c.stop();
    await m.close();
  }
});

test('a flapping Core does NOT earn a backoff reset on auth_ok — rejoin spacing grows', async () => {
  // Pre-v0.26, handleAuthOk zeroed reconnectAttempts, so every rejoin landed
  // ~1s after the drop no matter how long the flap lasted. Now the reset waits
  // for sustained stability, so consecutive rejoin gaps must GROW (1s, 2s, 4s
  // nominal, ±20% jitter). Loose bounds keep the test honest under jitter+CI.
  const m = await mockHa();
  m.mode.auth = 'ok-then-drop';
  const c = client(m.url);
  try {
    c.start();
    await waitFor(() => m.socks.length >= 4, 15_000);
    const gap1 = m.connectedAt[1] - m.connectedAt[0];
    const gap3 = m.connectedAt[3] - m.connectedAt[2];
    // gap1 ≈ base (≤1.3s+overhead); gap3 ≈ 4×base under growth, ≈1×base under
    // the old reset-on-auth_ok bug. The discriminating claim is the RATIO.
    assert.ok(gap3 > gap1 * 2, `backoff did not grow across a flap: gap1=${gap1}ms gap3=${gap3}ms`);
  } finally {
    c.stop();
    await m.close();
  }
});

test('stop() is final: no zombie reconnect after stop', async () => {
  const m = await mockHa();
  const c = client(m.url);
  try {
    c.start();
    await waitFor(() => c.ready());
    const before = m.socks.length;
    c.stop();
    m.socks[before - 1].terminate();
    await sleep(2500); // longer than base backoff — a zombie would have rejoined
    assert.equal(m.socks.length, before, 'client reconnected after stop()');
  } finally {
    await m.close();
  }
});

test('stop() while the socket is still CONNECTING does not crash the process', async () => {
  // Found by CI on the v0.29.0 release build, not by this suite: the flapping-
  // Core test above tore down mid-handshake and the run died with
  // "WebSocket was closed before the connection was established".
  //
  // stop() calls removeAllListeners() and then close(). On a CONNECTING socket
  // ws emits 'error' — and with the handler just removed, EventEmitter RE-THROWS
  // it as an uncaught exception on a later tick, which the try/catch around
  // close() never sees. In production that is a crash on shutdown whenever a
  // reconnect happens to be in flight, i.e. exactly during the churn this
  // client exists to survive.
  //
  // A plain TCP listener accepts the connection and never completes the upgrade,
  // so the client is reliably still CONNECTING when stop() lands.
  const { createServer } = await import('node:net');
  // Hold the accepted sockets: srv.close() waits for open connections, and the
  // client's socket is still open by design here, so without destroying them
  // the close callback never fires and the test file hangs.
  const accepted: Array<{ destroy: () => void }> = [];
  const srv = createServer((sock) => { accepted.push(sock); /* never respond */ });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;

  const seen: unknown[] = [];
  const onUncaught = (e: unknown) => seen.push(e);
  process.on('uncaughtException', onUncaught);
  const c = createHaWsClient({ url: `ws://127.0.0.1:${port}`, token: 't', log: () => {} });
  try {
    c.start();
    await sleep(150);   // handshake is open and unanswered
    c.stop();
    await sleep(500);   // give the async 'error' a chance to surface
    assert.deepEqual(seen, [], `stop() raised: ${seen.map(String).join('; ')}`);
  } finally {
    process.off('uncaughtException', onUncaught);
    for (const sock of accepted) sock.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
