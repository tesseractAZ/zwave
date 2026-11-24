/**
 * v0.79.7 — a roster poll's reading and a node's status events, in the order
 * the REAL HaWsClient hands them to the data layer.
 *
 * A mock Home Assistant Core on a real `ws` server (127.0.0.1) answers the
 * commands the data layer sends: config_entries/get, the device and entity
 * registry lists, get_states, zwave_js/network_status, the controller and node
 * subscribes, subscribe_events and unsubscribe_events. A node status feed is a
 * listener on the node, as api.py's node.on(); Home Assistant forwards each
 * status event on every feed bound to the node, and a network_status answer
 * reads each node's status as the answer is made. Every frame the mock sends
 * is encoded here and written to the socket with one write, so a
 * network_status answer and the status event sent right after it can reach
 * the client in one read.
 *
 * `ws` hands each uncompressed frame of one read to its message handler
 * before returning (allowSynchronousEvents, its default), so the event is
 * handled before the poll that awaited the answer resumes. A compressed frame
 * is inflated asynchronously, frame by frame, and the poll resumes first.
 * Each test runs both ways: `perMessageDeflate: false` (frames uncompressed),
 * and permessage-deflate negotiated with server_no_context_takeover, every
 * frame compressed on its own (as aiohttp compresses every message once the
 * extension is agreed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { deflateRawSync, constants as Z } from 'node:zlib';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createHaWsClient, type HaWsClient } from '../src/ha/haWsClient';
import { createZwaveData } from '../src/zwave/zwaveData';

const DAY = 86_400_000;
const HOME = 3586281591;
const ENTRY = 'E1';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 10_000, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(5);
  }
}

type Mode = 'uncompressed' | 'deflate';

/** One server frame: FIN, text, RSV1 when compressed; unmasked, as a server sends. */
function frame(json: string, deflate: boolean): Buffer {
  let p = Buffer.from(json);
  let b0 = 0x81;
  if (deflate) {
    // RFC 7692: a sync-flushed raw deflate stream, its 00 00 ff ff tail removed.
    const z = deflateRawSync(p, { finishFlush: Z.Z_SYNC_FLUSH });
    p = z.subarray(0, z.length - 4);
    b0 = 0xc1;
  }
  let h: Buffer;
  if (p.length < 126) h = Buffer.from([b0, p.length]);
  else if (p.length < 65_536) { h = Buffer.alloc(4); h[0] = b0; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = b0; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}

interface Conn { ws: WsSocket; deflate: boolean; subs: Map<number, { kind: string; node: number | null }> }

class MockCore {
  wss!: WebSocketServer;
  url = '';
  conns: Conn[] = [];
  /** Node id → status (NodeStatus) and ready. Node 1 is the controller. */
  nodes = new Map<number, { st: number; ready: boolean }>([[1, { st: 4, ready: true }], [7, { st: 4, ready: true }], [60, { st: 4, ready: true }]]);
  /** The next network_status answer is read, then this node's status changes
   *  and its status event is sent, in the same write as the answer. */
  withAnswer: { node: number; ev: 'dead' | 'alive' } | null = null;
  constructor(private readonly mode: Mode) {}

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({
      port: 0, host: '127.0.0.1',
      perMessageDeflate: this.mode === 'deflate' ? { serverNoContextTakeover: true } : false,
    });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.url = `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`;
    this.wss.on('connection', (ws) => {
      const c: Conn = { ws, deflate: ws.extensions.includes('permessage-deflate'), subs: new Map() };
      this.conns.push(c);
      ws.on('error', () => {});
      ws.on('close', () => { c.subs.clear(); });
      this.write(c, [{ type: 'auth_required', ha_version: 'test' }]);
      ws.on('message', (d) => this.receive(c, JSON.parse(String(d)) as Record<string, unknown>));
    });
  }

  close(): Promise<void> {
    for (const c of this.conns) { try { c.ws.terminate(); } catch { /* closed */ } }
    return new Promise((r) => this.wss.close(() => r()));
  }

  current(): Conn | null { return this.conns.at(-1) ?? null; }

  /** The frames, one socket write. */
  private write(c: Conn, msgs: Array<Record<string, unknown>>): void {
    const sock = (c.ws as unknown as { _socket: Socket | null })._socket;
    if (sock == null || sock.destroyed) return;
    sock.write(Buffer.concat(msgs.map((m) => frame(JSON.stringify(m), c.deflate))));
  }

  private statusEvents(c: Conn, n: number, ev: string): Array<Record<string, unknown>> {
    const o = this.nodes.get(n)!;
    return [...c.subs.entries()].filter(([, s]) => s.kind === 'status' && s.node === n)
      .map(([id]) => ({ id, type: 'event', event: { event: ev, status: o.st, ready: o.ready } }));
  }

  /** The driver changes node `n`'s status: forwarded on every status feed bound to it. */
  emitStatus(n: number, ev: 'dead' | 'alive'): void {
    this.nodes.get(n)!.st = ev === 'dead' ? 3 : 4;
    const c = this.current();
    if (c) { const evs = this.statusEvents(c, n, ev); if (evs.length) this.write(c, evs); }
  }

  private receive(c: Conn, m: Record<string, unknown>): void {
    const id = m.id as number;
    const ok = (result: unknown = null): Record<string, unknown> => ({ id, type: 'result', success: true, result });
    switch (m.type) {
      case 'auth': return this.write(c, [{ type: 'auth_ok', ha_version: 'test' }]);
      case 'config_entries/get':
        return this.write(c, [ok([{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }])]);
      case 'config/device_registry/list':
        return this.write(c, [ok([...this.nodes.keys()].map((n) => ({ id: `dev-${n}`, identifiers: [['zwave_js', `${HOME}-${n}`]],
          name: `Node ${n}`, area_id: null, config_entry_id: ENTRY, config_entries: [ENTRY], parent_device_id: null })))]);
      case 'config/entity_registry/list':
      case 'get_states':
        return this.write(c, [ok([])]);
      case 'zwave_js/network_status': {
        const nodes = [...this.nodes.entries()].map(([n, o]) => ({ node_id: n, status: o.st, ready: o.ready,
          is_routing: true, is_secure: false, ...(n === 1 ? { is_controller_node: true } : {}) }));
        const answer = ok({ client: { server_version: 't', state: 'connected' }, controller: { home_id: HOME, own_node_id: 1, nodes } });
        const w = this.withAnswer;
        this.withAnswer = null;
        if (w == null) return this.write(c, [answer]);
        // Read, then the change and its event, sent right after the answer.
        this.nodes.get(w.node)!.st = w.ev === 'dead' ? 3 : 4;
        return this.write(c, [answer, ...this.statusEvents(c, w.node, w.ev)]);
      }
      case 'zwave_js/subscribe_node_statistics':
      case 'zwave_js/subscribe_node_status': {
        const n = Number(String(m.device_id).slice('dev-'.length));
        c.subs.set(id, { kind: m.type === 'zwave_js/subscribe_node_status' ? 'status' : 'stats', node: n });
        return this.write(c, [ok()]);
      }
      case 'zwave_js/subscribe_controller_statistics':
      case 'subscribe_events':
        c.subs.set(id, { kind: String(m.type), node: null });
        return this.write(c, [ok()]);
      case 'unsubscribe_events':
        c.subs.delete(Number(m.subscription));
        return this.write(c, [ok()]);
      default:
        return this.write(c, [ok()]);
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Run {
  m: MockCore; client: HaWsClient; zd: ReturnType<typeof createZwaveData>; priv: any; logs: string[];
  /** One roster poll (the loop's own is an hour away), and the feed work it starts, settled. */
  poll: () => Promise<void>;
  /** For each status event the data layer handles: the node, the event, and
   *  whether the poll that last read statuses had acted on its reading yet. */
  heard: Array<{ node: number; ev: string; rosterSentSeq: number }>;
  resubs: () => number;
}

async function withCore(mode: Mode, body: (r: Run) => Promise<void>): Promise<void> {
  const m = new MockCore(mode);
  await m.listen();
  const logs: string[] = [];
  const client = createHaWsClient({ url: m.url, token: 'test-token', log: () => {} });
  const bootAt = Date.now() - 5 * DAY;
  const zd = createZwaveData({
    client, refreshMs: 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * 60_000,
    historyPath: null, evidencePath: null, baselinesPath: null, outcomesPath: null, driverWsUrl: null,
    log: (s: string) => logs.push(s), uptimeMs: () => Date.now() - bootAt,
  });
  const priv = zd as any;
  const cpriv = client as any;
  const heard: Run['heard'] = [];
  const onStatus = priv.onNodeStatusEvent.bind(priv);
  priv.onNodeStatusEvent = (nodeId: number, ev: { event?: string } | null) => {
    heard.push({ node: nodeId, ev: String(ev?.event), rosterSentSeq: priv.rosterSentSeq });
    onStatus(nodeId, ev);
  };
  const quiet = () => priv.registriesInFlight == null && !priv.rebuildInFlight && priv.statsSubscribed && !priv.nodeSubsBusy
    && client.ready() && cpriv.pending.size === 0;
  const settle = async () => { await waitFor(quiet, 10_000, () => logs.slice(-8).join(' | ')); await sleep(20); await waitFor(quiet); };
  const r: Run = {
    m, client, zd, priv, logs, heard,
    poll: async () => {
      if (priv.pollTimer) clearTimeout(priv.pollTimer);
      await priv.tick();
      await settle();
    },
    resubs: () => logs.filter((l) => /^live statistics: node \d+'s feeds: re-subscribe /.test(l)).length,
  };
  try {
    client.start();
    zd.start();
    await waitFor(() => zd.snapshot().length > 0 && priv.lastHomeId != null && quiet(), 10_000, () => logs.join(' | '));
    await settle();
    await body(r);
  } finally {
    zd.stop();
    client.stop();
    await m.close();
  }
}

const deaths = (r: Run) => r.zd.drainDeadEvents().filter((d) => d.nodeId === 60).length;

test('the real client, a death sent right after the answer of the first poll since node 60\'s status feed answered, the node revived before the next poll: uncompressed, the death is handed over before the poll acts on its reading, and either way the revival clears it and nothing is re-subscribed (v0.79.7)', async () => {
  for (const mode of ['uncompressed', 'deflate'] as const) {
    await withCore(mode, async (r) => {
      assert.equal(r.m.current()!.deflate, mode === 'deflate', `${mode}: precondition: permessage-deflate as asked`);
      // A reconnect: the rebuild's status feeds answer after the last poll was sent.
      const built = r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length;
      r.client.reconnect();
      await waitFor(() => r.logs.filter((l) => l.startsWith('live statistics: subscribed')).length > built && r.priv.statusSubbed.has(60));
      await sleep(20);
      r.m.withAnswer = { node: 60, ev: 'dead' };
      const before = r.priv.rosterSentSeq;
      await r.poll();                     // reads node 60 Alive; its death is sent right after the answer
      const death = r.heard.find((h) => h.node === 60 && h.ev === 'dead');
      assert.ok(death, `${mode}: precondition: the death reached the data layer`);
      if (mode === 'uncompressed') assert.equal(death.rosterSentSeq, before, 'uncompressed: the death is handled before the poll acts on its reading');
      else assert.equal(death.rosterSentSeq, r.priv.rosterSentSeq, 'deflate: the poll acts on its reading first');
      r.m.emitStatus(60, 'alive');        // the revival, before the next poll
      await waitFor(() => r.heard.some((h) => h.node === 60 && h.ev === 'alive'));
      await r.poll();
      assert.equal(deaths(r), 1, `${mode}: the death is cleared by the revival`);
      assert.equal(r.resubs(), 0, `${mode}: no node re-subscribed`);
    });
  }
});

test('the real client, a revival sent right after the answer of a poll that reads node 60 Dead: uncompressed, it is handled before the poll acts on its reading, and either way the feed delivered both changes, so nothing is re-subscribed (v0.79.7)', async () => {
  for (const mode of ['uncompressed', 'deflate'] as const) {
    await withCore(mode, async (r) => {
      await r.poll();                     // node 60's status feed answered before this poll was sent
      r.m.emitStatus(60, 'dead');
      await waitFor(() => r.heard.some((h) => h.node === 60 && h.ev === 'dead'));
      r.m.withAnswer = { node: 60, ev: 'alive' };
      const before = r.priv.rosterSentSeq;
      await r.poll();                     // reads it Dead; its revival is sent right after the answer
      const revival = r.heard.find((h) => h.node === 60 && h.ev === 'alive');
      assert.ok(revival, `${mode}: precondition: the revival reached the data layer`);
      if (mode === 'uncompressed') assert.equal(revival.rosterSentSeq, before, 'uncompressed: the revival is handled before the poll acts on its reading');
      else assert.equal(revival.rosterSentSeq, r.priv.rosterSentSeq, 'deflate: the poll acts on its reading first');
      await r.poll();                     // reads it Alive
      assert.equal(r.resubs(), 0, `${mode}: no node re-subscribed`);
      assert.equal(deaths(r), 1, `${mode}: the death, cleared by the revival`);
    });
  }
});
