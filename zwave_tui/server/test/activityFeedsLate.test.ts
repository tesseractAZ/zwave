/**
 * v0.79.7 — a state_changed subscribe Home Assistant answers after the
 * client's timeout, over the REAL HaWsClient against a minimal mock Core.
 *
 * Home Assistant handles a connection's commands in order and sends a
 * command's result, then the events of what it registered, down one queue
 * (websocket_api: handle_subscribe_events registers the bus listener and
 * sends the result in the same step). An answer held up past the client's
 * 10 s timeout is therefore a feed Home Assistant made and the add-on gave up
 * on: the client has dropped its handler, so the feed's events reach nothing,
 * and it releases the feed on the socket it went out on (haWsClient,
 * releaseUnanswered). The feed set stands without a state feed, and the
 * retry makes the one that is heard. The mock registers the late feed as it
 * handles the subscribe and keeps sending its events until it is released,
 * so a client that heard it beside the retry's would log every change twice,
 * and one that never released it would leave Home Assistant holding two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createHaWsClient } from '../src/ha/haWsClient';
import { createZwaveData } from '../src/zwave/zwaveData';

const HOME = 3586281591;
const ENTRY = 'E1';
const SWITCH = 'switch.node_seven';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number, why?: () => string): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`waitFor: condition not met in time${why ? ` — ${why()}` : ''}`);
    await sleep(10);
  }
}

interface Core {
  url: string;
  /** state_changed subscriptions Home Assistant holds, by id. */
  stateSubs: Set<number>;
  /** state_changed subscribes received. */
  stateTries: number;
  /** The first one's answer has been sent. */
  lateAnswered: boolean;
  emitState(from: string, to: string): void;
  close(): Promise<void>;
}

async function mockCore(lateMs: number): Promise<Core> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  let sock: WsSocket | null = null;
  const core: Core = {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    stateSubs: new Set(), stateTries: 0, lateAnswered: false,
    emitState: (from, to) => {
      for (const id of core.stateSubs) {
        sock?.send(JSON.stringify({ id, type: 'event', event: { event_type: 'state_changed',
          data: { entity_id: SWITCH, old_state: { state: from }, new_state: { state: to, last_changed: new Date().toISOString() } } } }));
      }
    },
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
  const result = (ws: WsSocket, id: number, r: unknown) => ws.send(JSON.stringify({ id, type: 'result', success: true, result: r }));
  wss.on('connection', (ws) => {
    sock = ws;
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: 'test' }));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown> & { id: number };
      switch (m.type) {
        case 'auth': ws.send(JSON.stringify({ type: 'auth_ok', ha_version: 'test' })); return;
        case 'config_entries/get': return result(ws, m.id, [{ entry_id: ENTRY, domain: 'zwave_js', state: 'loaded', title: 'Z-Wave JS' }]);
        case 'config/device_registry/list':
          return result(ws, m.id, [{ id: 'dev-7', identifiers: [['zwave_js', `${HOME}-7`]], name: 'Node Seven', area_id: null, config_entry_id: ENTRY, config_entries: [ENTRY] }]);
        case 'config/entity_registry/list':
          return result(ws, m.id, [{ entity_id: SWITCH, device_id: 'dev-7', disabled_by: null, platform: 'zwave_js', original_name: 'Node Seven Switch' }]);
        case 'get_states': return result(ws, m.id, [{ entity_id: SWITCH, state: 'on', attributes: {} }]);
        case 'zwave_js/network_status':
          return result(ws, m.id, { client: { server_version: 't' }, controller: { home_id: HOME, own_node_id: 1, nodes: [
            { node_id: 1, status: 4, ready: true, is_routing: true, is_secure: false, is_controller_node: true },
            { node_id: 7, status: 4, ready: true, is_routing: true, is_secure: false },
          ] } });
        case 'subscribe_events':
          if (m.event_type === 'state_changed') {
            core.stateTries += 1;
            // Registered as it is handled, in order with the connection's
            // other commands, so a release sent after it finds it.
            core.stateSubs.add(m.id);
            if (core.stateTries === 1) {
              // Answered once the queue ahead of it drains; its events queue
              // behind the answer, and the test sends none before it.
              setTimeout(() => { result(ws, m.id, null); core.lateAnswered = true; }, lateMs);
              return;
            }
          }
          return result(ws, m.id, null);
        case 'unsubscribe_events':
          core.stateSubs.delete(Number(m.subscription));
          return result(ws, m.id, null);
        default: return result(ws, m.id, null);
      }
    });
  });
  return core;
}

test('a state_changed subscribe answered after the client\'s timeout: the late feed is not heard, and the retry\'s is the one that is (v0.79.7)', { timeout: 60_000 }, async () => {
  const core = await mockCore(10_600);
  const logs: string[] = [];
  let up = 5 * 86_400_000;
  const client = createHaWsClient({ url: core.url, token: 'test-token', log: () => {} });
  const zd = createZwaveData({
    client, refreshMs: 3_600_000, routePollMs: 60_000, evidenceSampleMs: 30 * 60_000,
    historyPath: null, evidencePath: null, baselinesPath: null, outcomesPath: null, autonomyPath: null, driverWsUrl: null,
    log: (m: string) => logs.push(m), uptimeMs: () => up,
  });
  const priv = zd as unknown as { tick: () => Promise<void>; pollTimer: ReturnType<typeof setTimeout> | null; rebuildInFlight: boolean; statsSubscribed: boolean; activityRetryBusy: boolean };
  const rows = () => zd.events().filter((e) => e.kind === 'value').length;
  try {
    client.start();
    zd.start();
    await waitFor(() => logs.some((l) => /^activity subscribe failed/.test(l)) && !priv.rebuildInFlight && priv.statsSubscribed, 20_000, () => logs.join(' | '));
    // The late answer lands; Home Assistant sends the events of the feed it holds.
    await waitFor(() => core.lateAnswered, 5_000);
    await sleep(50);
    const r0 = rows();
    core.emitState('on', 'off');
    await sleep(100);
    assert.equal(rows(), r0, 'precondition: the late feed delivers nothing');
    // A minute on, the roster poll that succeeds makes the state feed.
    up += 61_000;
    if (priv.pollTimer) clearTimeout(priv.pollTimer);
    await priv.tick();
    await waitFor(() => !priv.activityRetryBusy && core.stateTries === 2, 5_000, () => logs.join(' | '));
    await sleep(100);
    const r1 = rows();
    core.emitState('off', 'on');
    await waitFor(() => rows() > r1, 3_000, () => logs.slice(-6).join(' | '));
    await sleep(150);
    assert.equal(rows() - r1, 1, 'one state change, logged once');
    // Home Assistant's side: the late feed is not left registered beside the retry's.
    assert.equal(core.stateSubs.size, 1, `state_changed subscriptions Home Assistant holds: ${core.stateSubs.size}`);
  } finally {
    zd.stop();
    client.stop();
    await core.close();
  }
});
