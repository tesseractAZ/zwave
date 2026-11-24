/**
 * Commands Home Assistant registers as subscriptions (v0.79.8):
 * zwave_js `refresh_node_info` (a re-interview) and `remove_failed_node`.
 *
 * Home Assistant 2026.11.2's handlers (components/zwave_js/api.py) set
 * `connection.subscriptions[msg id]` and attach their listeners (the node's
 * interview events; the controller's "node removed") before they await the
 * driver, and nothing removes the entry when they answer: a FailedCommand
 * answer only drops the listeners (`async_handle_failed_command`). Through
 * v0.79.7 the add-on sent both through send(), so each left a subscription on
 * the connection for its life. `unsubscribe_events` pops any entry
 * (websocket_api commands.py `handle_unsubscribe_events`), and
 * zwave-js-server-python 0.74.0's unsubscribe callables are idempotent
 * (event.py: `if callback in listeners`), so a release after an error answer
 * is safe.
 *
 * The core here is a real `ws` server on 127.0.0.1 modelling that: commands
 * taken in arrival order, the two commands registering as their turn comes
 * and answering once the driver is done, without holding the commands after
 * them (`async_response` starts the handler eagerly); `unsubscribe_events`
 * answered `not_found` for an id not live on that connection; every
 * subscription dropped at a close; and ids that must increase.
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
const SUB_COMMANDS = new Set(['zwave_js/refresh_node_info', 'zwave_js/remove_failed_node']);

interface Conn {
  ws: WsSocket;
  open: boolean;
  frames: Frame[];
  /** connection.subscriptions, by id. */
  live: Set<number>;
  releases: Array<{ subscription: number; ok: boolean }>;
  lastId: number;
}

/** How the driver answers one subscription command: after `driver` settles, with a result or a FailedCommand. */
interface Driver { driver?: Promise<void>; fail?: string }

interface Core {
  url: string;
  conns: Conn[];
  idReuse: string[];
  plan: (m: Frame) => Driver | null;
  close(): Promise<void>;
}

async function core(): Promise<Core> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const h: Core = {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    conns: [], idReuse: [], plan: () => null,
    close: () => new Promise<void>((r) => {
      for (const c of h.conns) { try { c.ws.terminate(); } catch { /* closed */ } }
      wss.close(() => r());
    }),
  };
  wss.on('connection', (ws) => {
    const c: Conn = { ws, open: true, frames: [], live: new Set(), releases: [], lastId: 0 };
    const idx = h.conns.push(c) - 1;
    ws.on('close', () => { c.open = false; c.live.clear(); });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'test' }));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Frame;
      c.frames.push(m);
      if (m.type === 'auth') { ws.send(JSON.stringify({ type: 'auth_ok', ha_version: 'test' })); return; }
      const id = m.id as number;
      const reply = (o: Frame) => { if (c.open) ws.send(JSON.stringify({ id, ...o })); };
      if (typeof id !== 'number' || id <= c.lastId) {
        h.idReuse.push(`conn ${idx}: id ${String(id)} after ${c.lastId}`);
        reply({ type: 'result', success: false, error: { code: 'id_reuse', message: 'Identifier values have to increase.' } });
        return;
      }
      c.lastId = id;
      if (SUB_COMMANDS.has(String(m.type))) {
        // connection.subscriptions[msg id] = async_cleanup, then the driver's await.
        c.live.add(id);
        const plan = h.plan(m) ?? {};
        void (async () => {
          await plan.driver;
          // An interview event under the id, as forward_event sends one.
          reply({ type: 'event', event: { event: 'interview completed' } });
          if (plan.fail) reply({ type: 'result', success: false, error: { code: 'zwave_error', message: plan.fail } });
          else reply({ type: 'result', success: true, result: null });
        })();
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
  return h;
}

function client(url: string): HaWsClient {
  return createHaWsClient({ url, token: 'test-token', log: () => {} });
}

function unhandled(): { seen: unknown[]; off: () => void } {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on('unhandledRejection', on);
  return { seen, off: () => process.off('unhandledRejection', on) };
}

const releasesSent = (c: Conn) => c.frames.filter((f) => f.type === 'unsubscribe_events');
const commandOf = (c: Conn, type: string) => c.frames.find((f) => f.type === type)!;

test('a re-interview through sendSubscription: answered, then released on its socket under a later id, so nothing stays registered on the connection; through send() the same command stays registered (v0.79.8)', async () => {
  const h = await core();
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const conn = h.conns[0];
    // The model's premise, through send(): registered, and left so.
    assert.deepEqual(await c.send({ type: 'zwave_js/refresh_node_info', device_id: 'd1' }, 2000), null);
    const leaked = commandOf(conn, 'zwave_js/refresh_node_info').id as number;
    await sleep(30);
    assert.deepEqual([...conn.live], [leaked], 'precondition: send() leaves it registered');
    assert.equal(releasesSent(conn).length, 0, 'precondition: send() sends nothing more');
    conn.live.clear();
    // Through sendSubscription.
    assert.deepEqual(await c.sendSubscription({ type: 'zwave_js/refresh_node_info', device_id: 'd2' }, 2000), null, 'resolves with the result, as send() does');
    const cmd = conn.frames.filter((f) => f.type === 'zwave_js/refresh_node_info')[1];
    await waitFor(() => conn.releases.length === 1, 2000, 'Home Assistant reaches the release');
    assert.deepEqual(conn.releases, [{ subscription: cmd.id as number, ok: true }], 'the command\'s own id released, once');
    assert.ok((releasesSent(conn)[0].id as number) > (cmd.id as number), 'under a later id');
    assert.deepEqual([...conn.live], [], 'nothing left registered');
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('a remove failed node answered with a driver error: the error reaches the caller as from send(), and the subscription Home Assistant leaves registered is released (v0.79.8)', async () => {
  const h = await core();
  h.plan = () => ({ fail: 'Z-Wave error 361 - The node could not be removed because it has responded (ZW0361)' });
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const conn = h.conns[0];
    await assert.rejects(c.sendSubscription({ type: 'zwave_js/remove_failed_node', device_id: 'd1' }, 2000),
      /^Error: HA WS error \(zwave_error\): Z-Wave error 361 /);
    const cmd = commandOf(conn, 'zwave_js/remove_failed_node');
    await waitFor(() => conn.releases.length === 1, 2000, 'Home Assistant reaches the release');
    assert.deepEqual(conn.releases, [{ subscription: cmd.id as number, ok: true }]);
    assert.deepEqual([...conn.live], []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('a subscription command given up on at its reply timeout while the driver still works: it rejects `HA WS timeout` (an unknown outcome to the action runner), and is released at once, ahead of the answer that comes later (v0.79.8)', async () => {
  const h = await core();
  let done!: () => void;
  const driver = new Promise<void>((r) => { done = r; });
  h.plan = () => ({ driver });
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const conn = h.conns[0];
    await assert.rejects(c.sendSubscription({ type: 'zwave_js/remove_failed_node', device_id: 'd1' }, { readyMs: 2000, replyMs: 80 }),
      /^Error: HA WS timeout \(id \d+, zwave_js\/remove_failed_node\)/);
    const cmd = commandOf(conn, 'zwave_js/remove_failed_node');
    await waitFor(() => conn.releases.length === 1, 2000, 'the release lands while the driver works');
    assert.deepEqual(conn.releases, [{ subscription: cmd.id as number, ok: true }]);
    assert.deepEqual([...conn.live], [], 'nothing registered while the driver works on');
    done();                               // the answer comes, unwaited for
    await sleep(50);
    assert.equal(releasesSent(conn).length, 1, 'released once: the late answer sends no second release');
    // The connection stays the client's.
    assert.deepEqual(await c.send({ type: 'ping_like' }, 2000), { echo: 'ping_like' });
    assert.deepEqual(h.idReuse, []);
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});

test('the socket drops before a subscription command is answered: it rejects as from send(), and no release goes on the next connection, which never held it (v0.79.8)', async () => {
  const h = await core();
  h.plan = () => ({ driver: new Promise<void>(() => {}) });
  const c = client(h.url);
  const u = unhandled();
  try {
    c.start();
    await waitFor(() => c.ready());
    const p = c.sendSubscription({ type: 'zwave_js/refresh_node_info', device_id: 'd1' }, 2000);
    await waitFor(() => h.conns[0].live.size === 1, 2000, 'registered');
    h.conns[0].ws.terminate();
    await assert.rejects(p, /^Error: HA WS connection closed/);
    await waitFor(() => c.ready() && h.conns.length === 2, 8000, 'the client reconnects');
    await sleep(50);
    assert.equal(releasesSent(h.conns[1]).length, 0, 'nothing released on the new connection');
    assert.deepEqual(u.seen, []);
  } finally {
    u.off();
    c.stop();
    await h.close();
  }
});
