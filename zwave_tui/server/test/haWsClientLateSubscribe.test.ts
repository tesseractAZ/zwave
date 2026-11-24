/**
 * A subscribe Home Assistant answers after the client's reply timeout
 * (v0.79.7). Home Assistant handles one connection's commands in the order
 * they arrive (websocket_api http.py `_async_websocket_command_phase` →
 * connection.py `async_handle`), has no command to cancel one, and its
 * subscribe handlers register the subscription while they handle the command
 * (`handle_subscribe_events`; the zwave_js `subscribe_*` handlers, started
 * eagerly by `async_response`). So a subscribe the client gave up on still
 * registers when Home Assistant reaches it, under an id the client no longer
 * routes. The client releases it on the socket it went out on, where the
 * release lands after it; a socket that closes takes its subscriptions with
 * it (`async_handle_close`).
 *
 * Each test runs against a real `ws` server on 127.0.0.1 that models that
 * order: one chain of commands per connection, a subscribe registered when
 * its turn comes, `unsubscribe_events` answered `not_found` for an id that
 * is not live on that connection, every subscription dropped at a close, and
 * Home Assistant's rule that a connection's ids must increase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createHaWsClient, type HaWsClient } from '../src/ha/haWsClient';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 6000, why = ''): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor: condition not met in time ${why}`);
    await sleep(10);
  }
}

type Frame = Record<string, unknown>;

interface Conn {
  ws: WsSocket;
  open: boolean;
  /** Every frame received, on receipt (before its turn comes). */
  frames: Frame[];
  /** Subscriptions live on this connection, by id. */
  live: Set<number>;
  /** Answers sent to unsubscribe_events: subscription id → success. */
  releases: Array<{ subscription: number; ok: boolean }>;
  lastId: number;
  chain: Promise<void>;
}

/** What the test asks of one command: park the connection's chain on it
 *  (and so every command after it), and how a subscribe is answered. */
interface Turn {
  hold?: Promise<void>;
  answer?: 'ok' | 'error';
}

interface Core {
  url: string;
  conns: Conn[];
  idReuse: string[];
  /** Consulted once per command after auth. */
  plan: (c: number, m: Frame) => Turn | null;
  close(): Promise<void>;
}

async function core(): Promise<Core> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const h: Core = {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    conns: [],
    idReuse: [],
    plan: () => null,
    close: () => new Promise<void>((r) => {
      for (const c of h.conns) { try { c.ws.terminate(); } catch { /* closed */ } }
      wss.close(() => r());
    }),
  };
  wss.on('connection', (ws) => {
    const idx = h.conns.length;
    const c: Conn = { ws, open: true, frames: [], live: new Set(), releases: [], lastId: 0, chain: Promise.resolve() };
    h.conns.push(c);
    // A closed connection's subscriptions go with it (async_handle_close).
    ws.on('close', () => { c.open = false; c.live.clear(); });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'test' }));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Frame;
      c.frames.push(m);
      if (m.type === 'auth') { ws.send(JSON.stringify({ type: 'auth_ok', ha_version: 'test' })); return; }
      const turn = h.plan(idx, m);
      c.chain = c.chain.then(async () => {
        if (turn?.hold) await turn.hold;
        if (!c.open) return;
        const id = m.id as number;
        const reply = (o: Frame) => { if (c.open) ws.send(JSON.stringify({ id, ...o })); };
        if (typeof id !== 'number' || id <= c.lastId) {
          h.idReuse.push(`conn ${idx}: id ${String(id)} after ${c.lastId}`);
          reply({ type: 'result', success: false, error: { code: 'id_reuse', message: 'Identifier values have to increase.' } });
          return;
        }
        c.lastId = id;
        if (m.type === 'subscribe_events') {
          if (turn?.answer === 'error') {
            reply({ type: 'result', success: false, error: { code: 'unknown_error', message: 'refused' } });
            return;
          }
          c.live.add(id);
          reply({ type: 'result', success: true, result: null });
          // A replay pushed at once, as subscribe_node_statistics sends one
          // right after its result: it is on the wire before any release.
          reply({ type: 'event', event: { replay: true } });
        } else if (m.type === 'unsubscribe_events') {
          const sid = Number(m.subscription);
          const ok = c.live.delete(sid);
          c.releases.push({ subscription: sid, ok });
          if (ok) reply({ type: 'result', success: true, result: null });
          else reply({ type: 'result', success: false, error: { code: 'not_found', message: 'Subscription not found.' } });
        } else {
          reply({ type: 'result', success: true, result: { echo: m.type } });
        }
      });
    });
  });
  return h;
}

function client(url: string): HaWsClient {
  return createHaWsClient({ url, token: 'test-token', log: () => {} });
}

/** Rejections no caller handled, for the length of a test. */
function unhandled(): { seen: unknown[]; off: () => void } {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on('unhandledRejection', on);
  return { seen, off: () => process.off('unhandledRejection', on) };
}

const subscribes = (c: Conn) => c.frames.filter((f) => f.type === 'subscribe_events');
const releasesSent = (c: Conn) => c.frames.filter((f) => f.type === 'unsubscribe_events');
const idsOf = (c: Conn) => c.frames.filter((f) => typeof f.id === 'number').map((f) => f.id as number);

test('a subscribe Home Assistant registers after the reply timeout is released on its socket, after it, and its events reach no handler (v0.79.7)', async () => {
  const h = await core();
  let free!: () => void;
  const held = new Promise<void>((r) => { free = r; });
  let first = true;
  h.plan = (_c, m) => (m.type === 'subscribe_events' && first ? (first = false, { hold: held }) : null);
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const heard: unknown[] = [];
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, (ev) => heard.push(ev), 80), /^Error: HA WS timeout/);
    // Given up on; Home Assistant has not reached it yet.
    const conn = h.conns[0];
    const subId = subscribes(conn)[0].id as number;
    await waitFor(() => releasesSent(conn).length === 1, 2000, 'the release is sent when the client gives up');
    free();
    await waitFor(() => conn.releases.length === 1, 2000, 'Home Assistant reaches the release');
    assert.deepEqual([...conn.live], [], 'nothing the client holds no handle for is live on the connection');
    assert.deepEqual(conn.releases, [{ subscription: subId, ok: true }], 'released once, after it registered');
    const rel = releasesSent(conn)[0];
    assert.ok((rel.id as number) > subId, 'the release goes out under a later id');
    await sleep(50);
    assert.deepEqual(heard, [], 'the replay sent before the release landed reached no handler');
    // The connection is still the client's, and a subscribe answered in time
    // is kept: the release named only the one given up on.
    const got: unknown[] = [];
    const sub = await c.subscribe({ type: 'subscribe_events', event_type: 'zwave_js_notification' }, (ev) => got.push(ev), 2000);
    await waitFor(() => got.length === 1, 2000, 'the next subscription hears its events');
    assert.deepEqual([...conn.live], [sub.subscriptionId]);
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('two subscribes given up on behind a busy Core: the one that failed answers the release not_found, the one that registered is released, the client stays usable (v0.79.7)', async () => {
  const h = await core();
  let free!: () => void;
  const held = new Promise<void>((r) => { free = r; });
  let n = 0;
  // The first subscribe parks the chain and is refused when its turn comes;
  // the second waits behind it and registers.
  h.plan = (_c, m) => {
    if (m.type !== 'subscribe_events') return null;
    n += 1;
    return n === 1 ? { hold: held, answer: 'error' } : null;
  };
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const a = assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    const b = assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'zwave_js_notification' }, () => {}, 80), /HA WS timeout/);
    await a;
    await b;
    const conn = h.conns[0];
    const [sa, sb] = subscribes(conn).map((f) => f.id as number);
    free();
    await waitFor(() => conn.releases.length === 2, 2000, 'both releases reached');
    assert.deepEqual(conn.releases, [{ subscription: sa, ok: false }, { subscription: sb, ok: true }]);
    assert.deepEqual([...conn.live], []);
    // A not_found answer to a release leaves the client consistent.
    assert.deepEqual(await c.send({ type: 'ping-ish' }, 2000), { echo: 'ping-ish' });
    const ids = idsOf(conn);
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'ids leave in increasing order');
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('the socket drops before Home Assistant reaches a subscribe given up on: its release went on that socket only, and the next connection carries none (v0.79.7)', async () => {
  const h = await core();
  // Home Assistant never reaches anything after the first subscribe on the
  // first connection: the socket drops first.
  const never = new Promise<void>(() => {});
  h.plan = (ci, m) => (ci === 0 && m.type === 'subscribe_events' ? { hold: never } : null);
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    const c0 = h.conns[0];
    const subId = subscribes(c0)[0].id as number;
    await waitFor(() => releasesSent(c0).length === 1, 2000, 'the release is sent on the open socket');
    assert.equal(releasesSent(c0)[0].subscription, subId);
    c0.ws.terminate();
    await waitFor(() => h.conns.length === 2 && c.ready(), 8000, 'reconnected');
    const c1 = h.conns[1];
    const got: unknown[] = [];
    const sub = await c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, (ev) => got.push(ev), 2000);
    await waitFor(() => got.length === 1, 2000, 'the new connection hears its subscription');
    await sleep(50);
    assert.deepEqual(releasesSent(c1), [], 'no release on a connection the subscribe never went out on');
    assert.deepEqual([...c1.live], [sub.subscriptionId]);
    assert.equal((c as unknown as { pending: Map<number, unknown> }).pending.size, 0, 'the release still out at the drop was settled with it');
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('a re-authentication between two subscribes given up on: each is released on its own connection, under ids that keep increasing (v0.79.7)', async () => {
  const h = await core();
  const never = new Promise<void>(() => {});
  let free!: () => void;
  const held = new Promise<void>((r) => { free = r; });
  h.plan = (ci, m) => {
    if (m.type !== 'subscribe_events') return null;
    if (ci === 0) return { hold: never };
    return subscribes(h.conns[1]).length === 1 ? { hold: held } : null;
  };
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    const c0 = h.conns[0];
    await waitFor(() => releasesSent(c0).length === 1, 2000, 'released on the first connection');
    c0.ws.terminate();
    await waitFor(() => h.conns.length === 2 && c.ready(), 8000, 'authenticated again');
    const c1 = h.conns[1];
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    const s1 = subscribes(c1)[0].id as number;
    await waitFor(() => releasesSent(c1).length === 1, 2000, 'released on the second connection');
    free();
    await waitFor(() => c1.releases.length === 1, 2000, 'Home Assistant reaches it');
    assert.deepEqual(c1.releases, [{ subscription: s1, ok: true }], 'the second connection releases its own subscribe, and only it');
    assert.deepEqual([...c1.live], []);
    const before = Math.max(...idsOf(c0));
    assert.ok(idsOf(c1).every((id) => id > before), 'ids on the new connection are above every id the old one carried');
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('send() is unchanged: a command given up on at its reply timeout sends nothing more (v0.79.7)', async () => {
  const h = await core();
  let free!: () => void;
  const held = new Promise<void>((r) => { free = r; });
  let first = true;
  h.plan = () => (first ? (first = false, { hold: held }) : null);
  const c = client(h.url);
  try {
    c.start();
    await waitFor(() => c.ready());
    await assert.rejects(c.send({ type: 'zwave_js/rebuild_node_routes', device_id: 'd' }, 80), (e: unknown) => {
      // zwaveActions reads this message as an unknown outcome.
      assert.ok(e instanceof Error && /^HA WS timeout/.test(e.message));
      return true;
    });
    free();
    await sleep(150);
    const conn = h.conns[0];
    assert.deepEqual(conn.frames.filter((f) => f.type !== 'auth').map((f) => f.type), ['zwave_js/rebuild_node_routes']);
    // …and a subscribe given up on releases, on the same client.
    const held2 = new Promise<void>(() => {});
    h.plan = (_c, m) => (m.type === 'subscribe_events' ? { hold: held2 } : null);
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    await waitFor(() => releasesSent(conn).length === 1, 2000, 'the subscribe is released');
  } finally {
    c.stop();
    await h.close();
  }
});

test('the release leaves in the same turn as the timeout: ahead of anything the caller sends once it hears of the rejection (v0.79.7)', async () => {
  const h = await core();
  const never = new Promise<void>(() => {});
  h.plan = (_c, m) => (m.type === 'subscribe_events' ? { hold: never } : null);
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    // The caller's first reaction to the rejection is another command.
    await c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80)
      .then(() => assert.fail('the subscribe must time out'), () => { void c.send({ type: 'after' }, 2000).catch(() => {}); });
    const conn = h.conns[0];
    await waitFor(() => conn.frames.some((f) => f.type === 'after'), 2000, 'the caller\'s command arrives');
    await sleep(30);
    assert.deepEqual(conn.frames.filter((f) => f.type !== 'auth').map((f) => f.type), ['subscribe_events', 'unsubscribe_events', 'after'],
      'the release goes right behind the subscribe, before the caller has heard of the timeout');
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('a reply bound that passes while the socket is closing (terminated, its close event not yet run) sends no release, on that socket or the next (v0.79.7)', async () => {
  const h = await core();
  const never = new Promise<void>(() => {});
  h.plan = (_ci, m) => (m.type === 'subscribe_events' ? { hold: never } : null);
  const c = client(h.url);
  const cpriv = c as unknown as { ws: { readyState: number } | null; pending: Map<number, unknown> };
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    // Two timers of one duration set in one turn run in one pass of the timers
    // phase, in the order set: the terminate first, then the subscribe's reply
    // bound, before the socket's close callback can run (libuv's close phase).
    let stateAtTimeout = -1;
    setTimeout(() => { c.reconnect(); stateAtTimeout = cpriv.ws?.readyState ?? -1; }, 120);
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 120), /^Error: HA WS timeout/,
      'the reply bound ran before the close event: the gap was reached');
    assert.equal(stateAtTimeout, 2, 'precondition: the socket was CLOSING when the bound passed');
    await waitFor(() => h.conns.length === 2 && c.ready(), 8000, 'reconnected');
    const c1 = h.conns[1];
    await c.send({ type: 'ping-ish' }, 2000);
    await sleep(50);
    assert.deepEqual(releasesSent(h.conns[0]), [], 'nothing went out on the closing socket');
    assert.deepEqual(releasesSent(c1), [], 'and nothing on the next one');
    assert.equal(cpriv.pending.size, 0);
    // The control: on an open socket, a subscribe given up on is released.
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    const s1 = subscribes(c1)[0].id as number;
    await waitFor(() => releasesSent(c1).length === 1, 2000, 'released on the open socket');
    assert.equal(releasesSent(c1)[0].subscription, s1);
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('stop() with a release still unanswered: it is settled with the rest, and nothing rejects unhandled (v0.79.7)', async () => {
  const h = await core();
  const never = new Promise<void>(() => {});
  h.plan = (_c, m) => (m.type === 'subscribe_events' ? { hold: never } : null);
  const c = client(h.url);
  const cpriv = c as unknown as { pending: Map<number, unknown> };
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    await assert.rejects(c.subscribe({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, 80), /HA WS timeout/);
    await waitFor(() => releasesSent(h.conns[0]).length === 1, 2000, 'the release is out, unanswered behind the held subscribe');
    assert.equal(cpriv.pending.size, 1, 'precondition: the release waits for its answer');
    c.stop();
    await sleep(50);
    assert.equal(cpriv.pending.size, 0);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});
