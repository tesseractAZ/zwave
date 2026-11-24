/**
 * A mock Home Assistant Core websocket server for the REAL HaWsClient, with a
 * model of zwave-js-server-python node objects.
 *
 * Model (HA 2026.11 api.py / helpers.py, core websocket_api):
 *  - auth_required → auth → auth_ok.
 *  - Every message id must increase per connection (connection.async_handle:
 *    ERR_ID_REUSE otherwise); a violation is recorded.
 *  - Commands are processed in arrival order (FIFO). Every handler used here
 *    is @callback or an eager async_response with no await before its answer,
 *    so its answer is sent in order — except zwave_js/network_status, which
 *    awaits controller.async_get_state() and so may answer after later
 *    commands (its delay is a knob). The roster is read when it answers.
 *  - subscribe_node_statistics / subscribe_node_status resolve the device id
 *    (helpers.async_get_node_from_device_id: device → first zwave_js
 *    identifier's node id → driver.controller.nodes[id]) and bind a listener
 *    to THAT node object (node.on). The statistics subscribe sends its result
 *    then a replay event. subscribe_controller_statistics binds to the
 *    controller object, and replays too. subscribe_events binds to the bus.
 *  - unsubscribe_events: found in this connection's subscriptions → cleanup +
 *    result; else not_found. Every release is counted by subscription id.
 *  - A socket close runs every subscription's cleanup (connection close).
 *  - A replace is a new node object on the id; a driver restart (entry reload)
 *    makes every node object and the controller object anew.
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

export const HOME = 3586281591;
export const P1 = '634:20548:13';
export const P3 = '29:12:34';
export const P7 = '881:3:20';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── device registry (nodeFeeds.test.ts / deviceSwapSim's model) ───────────── */
export type Main = { id: string; entry: string; ids: string[] };
export class Registry {
  devices = new Map<string, Main>();
  deleted = new Map<string, Main>();
  private seq = 0;
  getEntry(ids: string[], entry: string): Main | undefined {
    for (const i of ids) for (const d of this.devices.values()) if (d.entry === entry && d.ids.includes(i)) return d;
    return undefined;
  }
  getOrCreate(entry: string, ids: string[]): Main {
    const d = this.getEntry(ids, entry);
    if (d) { for (const i of ids) if (!d.ids.includes(i)) d.ids.push(i); return d; }
    const del = [...this.deleted.values()].reverse().find((x) => x.entry === entry && x.ids.some((i) => ids.includes(i)));
    const dev: Main = del ? { id: del.id, entry, ids: [...ids] } : { id: `dev-${++this.seq}`, entry, ids: [...ids] };
    if (del) this.deleted.delete(del.id);
    this.devices.set(dev.id, dev);
    return dev;
  }
  remove(id: string): void {
    const d = this.devices.get(id)!;
    this.devices.delete(id);
    this.deleted.set(id, d);
  }
}

export type Kind = 'ctrl' | 'stats' | 'status' | 'state' | 'notif' | 'other';
export interface Sub { conn: Conn; id: number; kind: Kind; node: number | null; obj: ZObj | CtrlObj | null }

export class ZObj {
  stats = new Set<Sub>();
  status = new Set<Sub>();
  tx = 0;
  constructor(public n: number, public p: string | null, public ready: boolean, public st: number) {}
}
export class CtrlObj {
  stats = new Set<Sub>();
  constructor(public gen: number) {}
}

export class World {
  reg = new Registry();
  entry = 'E1';
  home = HOME;
  loaded = true;
  nodes = new Map<number, ZObj>();
  objs: ZObj[] = [];
  ctrl = new CtrlObj(0);
  ctrls: CtrlObj[] = [this.ctrl];
  bus = new Set<Sub>();
  H(n: number): string { return `${this.home}-${n}`; }
  private make(n: number, p: string | null, ready: boolean, st: number): ZObj {
    const o = new ZObj(n, p, ready, st);
    this.objs.push(o);
    this.nodes.set(n, o);
    return o;
  }
  register(n: number): Main {
    const node = this.nodes.get(n)!;
    const devId = this.H(n);
    const ext = node.p == null ? null : `${this.home}-${n}-${node.p}`;
    const nodeDev = this.reg.getEntry([devId], this.entry);
    let ids: string[];
    if (ext) {
      if (nodeDev && nodeDev.ids.length === 2 && !nodeDev.ids.includes(ext)) nodeDev.ids = nodeDev.ids.filter((i) => i !== devId);
      const hw = this.reg.getEntry([ext], this.entry);
      if (hw && hw.ids.length === 1) hw.ids.push(devId);
      ids = [devId, ext];
    } else ids = [devId];
    return this.reg.getOrCreate(this.entry, ids);
  }
  ready(n: number): void { this.nodes.get(n)!.ready = true; this.register(n); this.emitStatus(n, 'ready'); }
  add(n: number, p: string): void { this.make(n, null, false, 0); this.register(n); this.interview(n, p); }
  addPending(n: number): void { this.make(n, null, false, 4); this.register(n); }
  interview(n: number, p: string): void { const o = this.nodes.get(n)!; o.p = p; if (o.st !== 4) this.emitStatus(n, 'alive'); this.ready(n); }
  startInterview(n: number): void { this.nodes.get(n)!.ready = false; }
  removeNode(n: number, reason: 'replaced' | 'excluded'): void {
    const dev = this.reg.getEntry([this.H(n)], this.entry);
    this.nodes.delete(n);
    if (reason === 'excluded' && dev) this.reg.remove(dev.id);
  }
  replacePending(n: number): void { this.removeNode(n, 'replaced'); this.addPending(n); }
  replace(n: number, p: string): void { this.removeNode(n, 'replaced'); this.add(n, p); }
  /** A driver restart: every node a new object (not ready), a new controller. */
  restartDriver(): void {
    for (const [n, o] of [...this.nodes]) this.make(n, o.p, false, o.st);
    this.ctrl = new CtrlObj(this.ctrl.gen + 1);
    this.ctrls.push(this.ctrl);
  }
  roster(): Array<Record<string, unknown>> {
    return [...this.nodes.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({
      node_id: n, status: x.st, ready: x.ready, is_routing: true, is_secure: false, ...(n === 1 ? { is_controller_node: true } : {}),
    }));
  }
  statsEvent(n: number, o: ZObj): Record<string, unknown> {
    return { source: 'node', event: 'statistics updated', node_id: n, commands_tx: o.tx, commands_rx: o.tx,
      commands_dropped_tx: 0, commands_dropped_rx: 0, timeout_response: 0, rtt: 20, rssi: -60, lwr: null, nlwr: null };
  }
  ctrlEvent(): Record<string, unknown> {
    return { event: 'statistics updated', source: 'controller', messages_tx: 1, messages_rx: 1, messages_dropped_tx: 0,
      messages_dropped_rx: 0, nak: 0, can: 0, timeout_ack: 0, timeout_response: 0, timeout_callback: 0 };
  }
  emitStats(n: number): void {
    const o = this.nodes.get(n)!;
    o.tx += 1;
    for (const s of [...o.stats]) s.conn.send({ id: s.id, type: 'event', event: this.statsEvent(n, o) });
  }
  emitStatus(n: number, ev: 'dead' | 'alive' | 'ready'): void {
    const o = this.nodes.get(n)!;
    if (ev === 'dead') o.st = 3;
    if (ev === 'alive') o.st = 4;
    for (const s of [...o.status]) s.conn.send({ id: s.id, type: 'event', event: { event: ev, status: o.st, ready: o.ready } });
  }
  emitCtrl(): void { for (const s of [...this.ctrl.stats]) s.conn.send({ id: s.id, type: 'event', event: this.ctrlEvent() }); }
}

export class Conn {
  subs = new Map<number, Sub>();
  lastId = 0;
  open = true;
  chain: Promise<void> = Promise.resolve();
  /** Messages received and not yet answered (network_status included). */
  inflight = 0;
  frames: Record<string, unknown>[] = [];
  /** One-way network latency for frames HA sends (order kept: equal timers fire in order). */
  latencyMs = 0;
  constructor(public idx: number, public ws: WsSocket) {}
  send(o: Record<string, unknown>): void {
    if (!this.open) return;
    const data = JSON.stringify(o);
    const go = () => { if (this.open) { try { this.ws.send(data); } catch { /* closed */ } } };
    if (this.latencyMs > 0) setTimeout(go, this.latencyMs); else go();
  }
}

/** What a hook asks for one incoming command. */
export interface Act {
  /** Terminate the socket on receipt, the command unprocessed. */
  drop?: boolean;
  /** Process and answer it, then terminate the socket. */
  dropAfter?: boolean;
  /** Park its processing (and, FIFO, every later command's) until this settles. */
  hold?: Promise<void>;
  /** Answer it with this error instead (code, message). */
  fail?: [string, string];
}
export type Hook = (c: Conn, m: Record<string, unknown>, k: number) => Act | void | null;

export class MockHa {
  wss!: WebSocketServer;
  url = '';
  conns: Conn[] = [];
  hooks: Hook[] = [];
  /** unsubscribe_events received, by subscription id (any connection). */
  releases = new Map<number, number>();
  /** unsubscribe_events for an id not live on that connection. */
  releaseMisses = 0;
  idReuse: string[] = [];
  /** One-way network latency, both directions. */
  latencyMs = 0;
  /** network_status answers wait this long (it awaits the driver). */
  statusDelayMs = 0;
  /** Node ids whose subscribes fail not_found; `<node>:<feed>` likewise. */
  failSubs = new Set<number>();
  failFeed = new Set<string>();
  /** Total commands received (all connections, after auth), for the k-th-message hooks. */
  seen = 0;
  /** Auth answers: 'ok', or 'drop' (accept, auth_ok, then close after `flapMs`). */
  authMode: { mode: 'ok' | 'flap'; flapMs: number } = { mode: 'ok', flapMs: 0 };
  /** Every subscribe processed: kind, node, connection. */
  subLog: Array<{ conn: number; id: number; kind: Kind; node: number | null }> = [];
  constructor(public w: World) {}

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.url = `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`;
    this.wss.on('connection', (ws) => {
      const c = new Conn(this.conns.length, ws);
      c.latencyMs = this.latencyMs;
      this.conns.push(c);
      ws.on('close', () => this.closed(c));
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'test' }));
      ws.on('message', (d) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(d)) as Record<string, unknown>; } catch { return; }
        const go = () => { if (!c.open) return; c.frames.push(m); this.receive(c, m); };
        if (this.latencyMs > 0) { c.inflight += 1; setTimeout(() => { c.inflight -= 1; go(); }, this.latencyMs); } else go();
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.conns) { try { c.ws.terminate(); } catch { /* */ } }
    return new Promise((r) => this.wss.close(() => r()));
  }

  current(): Conn | null { const c = this.conns[this.conns.length - 1]; return c && c.open ? c : null; }
  drop(): void { const c = this.current(); if (c) c.ws.terminate(); }
  busy(): boolean { return this.conns.some((c) => c.open && c.inflight > 0); }

  private closed(c: Conn): void {
    if (!c.open) return;
    c.open = false;
    for (const s of c.subs.values()) this.cleanup(s);
    c.subs.clear();
  }

  private cleanup(s: Sub): void {
    if (s.obj instanceof ZObj) { s.obj.stats.delete(s); s.obj.status.delete(s); }
    else if (s.obj instanceof CtrlObj) s.obj.stats.delete(s);
    this.w.bus.delete(s);
  }

  private receive(c: Conn, m: Record<string, unknown>): void {
    if (m.type === 'auth') {
      c.send({ type: 'auth_ok', ha_version: 'test' });
      if (this.authMode.mode === 'flap') setTimeout(() => { try { c.ws.terminate(); } catch { /* */ } }, this.authMode.flapMs);
      return;
    }
    const k = ++this.seen;
    let act: Act | null = null;
    for (const h of [...this.hooks]) { const a = h(c, m, k); if (a) { act = a; break; } }
    if (act?.drop) { this.closed(c); c.ws.terminate(); return; }
    c.inflight += 1;
    c.chain = c.chain.then(async () => {
      try {
        if (act?.hold) await act.hold.catch(() => {});
        if (!c.open) return;
        this.process(c, m, act);
      } finally {
        if (m.type !== 'zwave_js/network_status') c.inflight -= 1;
      }
      if (act?.dropAfter) setImmediate(() => { this.closed(c); try { c.ws.terminate(); } catch { /* */ } });
    });
  }

  private process(c: Conn, m: Record<string, unknown>, act: Act | null): void {
    const id = m.id as number;
    const ok = (result: unknown = null) => c.send({ id, type: 'result', success: true, result });
    const err = (code: string, message: string) => c.send({ id, type: 'result', success: false, error: { code, message } });
    if (typeof id !== 'number' || id <= c.lastId) {
      this.idReuse.push(`conn ${c.idx}: id ${String(id)} after ${c.lastId} (${String(m.type)})`);
      if (m.type === 'zwave_js/network_status') c.inflight -= 1;
      err('id_reuse', 'Identifier values have to increase.');
      return;
    }
    c.lastId = id;
    if (act?.fail) { if (m.type === 'zwave_js/network_status') c.inflight -= 1; err(act.fail[0], act.fail[1]); return; }
    const w = this.w;
    switch (m.type) {
      case 'config_entries/get':
        return ok([{ entry_id: w.entry, domain: 'zwave_js', state: w.loaded ? 'loaded' : 'not_loaded', title: 'Z-Wave JS' }]);
      case 'config/device_registry/list':
        return ok([...w.reg.devices.values()].map((d) => ({ id: d.id, identifiers: d.ids.map((i) => ['zwave_js', i]), name: `Dev ${d.id}`,
          area_id: null, config_entry_id: d.entry, config_entries: [d.entry], parent_device_id: null })));
      case 'config/entity_registry/list': return ok([]);
      case 'get_states': return ok([]);
      case 'zwave_js/network_status': {
        if (m.entry_id !== w.entry) { c.inflight -= 1; return err('not_found', `Config entry ${String(m.entry_id)} not found`); }
        if (!w.loaded) { c.inflight -= 1; return err('not_loaded', `Config entry ${w.entry} not loaded`); }
        const d = this.statusDelayMs;
        void (async () => {
          if (d > 0) await sleep(d);
          c.inflight -= 1;
          if (!c.open) return;
          if (!w.loaded) return err('not_loaded', `Config entry ${w.entry} not loaded, driver not ready`);
          ok({ client: { server_version: 't', state: 'connected' }, controller: { home_id: w.home, own_node_id: 1, nodes: w.roster() } });
        })();
        return;
      }
      case 'zwave_js/subscribe_controller_statistics': {
        if (m.entry_id !== w.entry) return err('not_found', 'Config entry not found');
        if (!w.loaded) return err('not_loaded', `Config entry ${w.entry} not loaded`);
        const s: Sub = { conn: c, id, kind: 'ctrl', node: null, obj: w.ctrl };
        w.ctrl.stats.add(s);
        c.subs.set(id, s);
        this.subLog.push({ conn: c.idx, id, kind: 'ctrl', node: null });
        ok();
        c.send({ id, type: 'event', event: w.ctrlEvent() });
        return;
      }
      case 'zwave_js/subscribe_node_statistics':
      case 'zwave_js/subscribe_node_status': {
        const feed = m.type === 'zwave_js/subscribe_node_statistics' ? 'stats' : 'status';
        const devId = String(m.device_id);
        const dev = w.reg.devices.get(devId);
        if (!dev) return err('not_found', `Device ID ${devId} is not valid`);
        if (dev.entry !== w.entry) return err('not_found', `Device ${devId} is not from an existing zwave_js config entry`);
        if (!w.loaded) return err('not_loaded', `Device ${devId} config entry is not loaded`);
        const n = Number(dev.ids[0].split('-')[1]);
        const o = w.nodes.get(n);
        if (!o || this.failSubs.has(n) || this.failFeed.has(`${n}:${feed}`)) return err('not_found', `Node for device ${devId} can't be found`);
        const s: Sub = { conn: c, id, kind: feed, node: n, obj: o };
        o[feed].add(s);
        c.subs.set(id, s);
        this.subLog.push({ conn: c.idx, id, kind: feed, node: n });
        ok();
        if (feed === 'stats') c.send({ id, type: 'event', event: w.statsEvent(n, o) });
        return;
      }
      case 'subscribe_events': {
        const kind: Kind = m.event_type === 'state_changed' ? 'state' : m.event_type === 'zwave_js_notification' ? 'notif' : 'other';
        const s: Sub = { conn: c, id, kind, node: null, obj: null };
        w.bus.add(s);
        c.subs.set(id, s);
        this.subLog.push({ conn: c.idx, id, kind, node: null });
        return ok();
      }
      case 'unsubscribe_events': {
        const sid = Number(m.subscription);
        this.releases.set(sid, (this.releases.get(sid) ?? 0) + 1);
        const s = c.subs.get(sid);
        if (!s) { this.releaseMisses += 1; return err('not_found', 'Subscription not found.'); }
        c.subs.delete(sid);
        this.cleanup(s);
        return ok();
      }
      default:
        return ok(null);
    }
  }
}

/** Nodes 1 (the controller), 7 and 60, registered and interviewed. */
export function baseWorld(): World {
  const w = new World();
  w.add(1, '271:1:1');
  w.add(7, P7);
  w.add(60, P1);
  return w;
}
