/**
 * A minimal mock zwave-js-server, shared by the driver-WS client tests and the
 * zwaveData tests that need a REAL driver-WS link (v0.65.0 review).
 *
 * It lives here rather than inside one test file because the producer side of
 * two readings — the driver-restart stamp and the controller RF-off state —
 * has to be driven through `createZwaveData` to be pinned at all. Stubbing
 * those readings in the consumer's tests proves the consumer and nothing else:
 * deleting the line that writes the stamp left the whole suite green.
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

/**
 * A minimal mock zwave-js-server: records every command the client sends
 * (the allowlist proof), answers the handshake, and lets tests push events.
 */
export async function mockServer(over: { minSchema?: number; maxSchema?: number; homeId?: number } = {}) {
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

