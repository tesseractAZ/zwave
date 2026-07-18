import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderOverview } from '../src/telnet/screens/overview';
import { responseTimeoutPct } from '../src/zwave/health';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type { DataProvider, NodeSnapshot, HealthResult, ControllerSnapshot, ScreenCtx, ViewState, NodeStats } from '../src/types';

const now = 1_700_000_000_000;
function stats(over: Partial<NodeStats> = {}): NodeStats {
  return { rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null, commandsTX: 200, commandsRX: 198, commandsDroppedTX: 0, commandsDroppedRX: 1, timeoutResponse: 0, lastSeen: now - 3000, ...over };
}
function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return { nodeId: id, deviceId: 'd' + id, name: `Node ${id} With A Fairly Long Name`, area: null, status: NodeStatus.Alive, statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false, isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null, battery: null, firmware: null, stats: stats(), entities: [], ...over };
}
// 39-node roster so scrolling fires the command-bar "(n/N)" counter.
const nodes = Array.from({ length: 39 }, (_, i) => node(i + 1, i === 5 ? { stats: stats({ rtt: 234.5, commandsTX: 100, commandsDroppedTX: 2, timeoutResponse: 8 }) } : {}));
const scores: Record<number, HealthResult> = {};
// Node 6 carries ALL NINE flags — the widest FLAGS cell + the selected row.
scores[6] = { score: 34, rating: 3, grade: 'F', state: 'flaky', flags: ['D', 'S', 'W', 'F', 'R', 'L', 'I', 'B', 'U'] };
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;
const data: DataProvider = {
  nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id), controller: () => ctrl, events: () => [],
  scoreFor: (id) => scores[id] ?? { score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] },
  noiseFloor: () => -92, hasRealNoise: () => true, history: () => ({ rssi: [-60, -59, -58], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
  lastUpdated: () => now - 1200, ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0 }), efficacyFor: () => null,
};
const mkView = (cols: number, rows: number, selected = 5): ViewState => ({ screen: 'overview', cols, rows, selected, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', followTail: true, errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, selected = 5): ScreenCtx => ({ view: mkView(cols, rows, selected), data, visibleNodes: nodes, filtering: false, actionsEnabled: true });

test('Overview holds EXACTLY view.rows lines within view.cols at every size (incl. the scrolling command bar)', () => {
  for (const [cols, rows] of [[40, 12], [72, 20], [80, 24], [100, 30], [120, 46], [200, 50]] as const) {
    const lines = renderOverview(ctx(cols, rows));
    assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
    lines.forEach((l, i) => {
      assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: width ${visLen(l)} > ${cols}`);
      assert.ok(!l.includes('undefined'), `${cols}x${rows} row ${i}: leaked "undefined"`);
    });
  }
});

test('the selected inverse-video row embeds NO ANSI RESET (9 flags + fractional RTT — the exact hazards)', () => {
  // Select node 6 (all 9 flags) on a wide terminal that shows RTT/TMO/ROUTE.
  const idx6 = nodes.findIndex((n) => n.nodeId === 6);
  const lines = renderOverview(ctx(160, 46, idx6));
  const sel = lines.find((l) => l.startsWith('\x1b[7m'));
  assert.ok(sel, 'a selected inverse-video row is present');
  // A clean invert is ESC[7m <plain text, no ESC> ESC[0m — one RESET, at the end.
  const inner = sel!.replace(/^\x1b\[7m/, '').replace(/\x1b\[0m$/, '');
  assert.ok(!inner.includes('\x1b'), 'no embedded SGR/RESET inside the inverse span');
});

test('rttCell rounds fractional RTT so it fits its column (234.5 → "235ms")', () => {
  const lines = renderOverview(ctx(160, 46, 0)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(lines.some((l) => /\b235ms\b/.test(l)), 'node 6 shows a rounded 235ms');
  assert.ok(!lines.some((l) => /234\.5/.test(l)), 'no fractional ms leaks through');
});

test('responseTimeoutPct: timeoutResponse / TX, null when no traffic, clamped ≤100', () => {
  assert.equal(responseTimeoutPct(stats({ commandsTX: 0, timeoutResponse: 0 })), null);
  assert.equal(responseTimeoutPct(stats({ commandsTX: 100, timeoutResponse: 8 })), 8);
  assert.equal(responseTimeoutPct(stats({ commandsTX: 100, timeoutResponse: 0 })), 0);
  assert.equal(responseTimeoutPct(stats({ commandsTX: 10, timeoutResponse: 50 })), 100); // clamped
});

test('responseTimeoutPct IGNORES commandsDroppedTX (RESEARCH.md §0 regression guard)', () => {
  // The whole point of v0.11: commandsDroppedTX is near-silent for RF loss and
  // noisy otherwise, so a node with a huge drop count but ZERO response timeouts
  // must read a healthy 0% — it must NOT inflate the metric the way the old
  // (droppedTX + timeouts)/TX definition did.
  assert.equal(responseTimeoutPct(stats({ commandsTX: 100, commandsDroppedTX: 40, timeoutResponse: 0 })), 0);
  // And droppedTX must not change a timeout-driven reading either.
  assert.equal(responseTimeoutPct(stats({ commandsTX: 100, commandsDroppedTX: 40, timeoutResponse: 8 })), 8);
});
