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
scores[6] = { score: 34, grade: 'F', state: 'flaky', flags: ['D', 'S', 'W', 'F', 'R', 'L', 'I', 'B', 'U'] };
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;
const data: DataProvider = {
  nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id), controller: () => ctrl, events: () => [],
  scoreFor: (id) => scores[id] ?? { score: 90, grade: 'A', state: 'ok', flags: [] },
  noiseFloor: () => -92, hasRealNoise: () => true, history: () => ({ rssi: [-60, -59, -58], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
  lastUpdated: () => now - 1200, ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 0, bands: 6 }), efficacyFor: () => null, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  openEpisodes: () => [],
  controlArm: () => null,
  autoPingState: () => null,
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
};
const mkView = (cols: number, rows: number, selected = 5): ViewState => ({ screen: 'overview', cols, rows, selected, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, selected = 5): ScreenCtx => ({ view: mkView(cols, rows, selected), data, visibleNodes: nodes, filtering: false, actionsEnabled: true });

const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, '');

test('signal cell guarded: DEAD → dash (no live margin); ROUTED → neutral grey; DIRECT → health-coloured', () => {
  const deadN = node(2, { name: 'DeadNode', status: NodeStatus.Dead, statusLabel: 'dead', stats: stats({ rssi: -60 }) });
  const routedN = node(3, { name: 'RoutedNode', stats: stats({ rssi: -60, lwr: { repeaters: [10], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null } }) });
  const directN = node(4, { name: 'DirectNode', stats: stats({ rssi: -60 }) }); // margin = -60 - (-92) = +32
  const three = [directN, routedN, deadN];
  const d: DataProvider = { ...data, nodes: () => three, nodeById: (id) => three.find((n) => n.nodeId === id), scoreFor: () => ({ score: 90, grade: 'A', state: 'ok', flags: [] }) };
  // Select the dead node (index 2) so Direct/Routed render in COLOURED form (the
  // selected row uses inverse-video plain cells with no per-cell colour code).
  const raw = renderOverview({ view: mkView(120, 20, 2), data: d, visibleNodes: three, filtering: false, actionsEnabled: true });
  const rowOf = (name: string): string => raw.find((l) => strip(l).includes(name)) ?? '';
  // DEAD: signal is a dash, never a live +NdB margin next to an unreachable status.
  const deadRow = rowOf('DeadNode');
  assert.ok(strip(deadRow).includes('—'), 'dead node signal is a dash');
  assert.ok(!/[+-]\d+dB/.test(strip(deadRow)), 'dead node shows NO live margin value');
  // DIRECT healthy node: margin is GREEN (\x1b[92m).
  assert.match(rowOf('DirectNode'), /\x1b\[92m\+32dB/, 'direct node margin is health-green');
  // ROUTED node: margin is neutral GREY (\x1b[90m), NOT green — it is a last-hop reading.
  assert.match(rowOf('RoutedNode'), /\x1b\[90m\+32dB/, 'routed node margin is neutral grey');
  assert.doesNotMatch(rowOf('RoutedNode'), /\x1b\[92m\+32dB/, 'routed node margin is NOT graded green');
});

test('narrow terminal (60-73 cols) drops rate/seen/batt so the FLAGS column is never clipped', () => {
  for (const cols of [60, 68, 73]) {
    const stripped = renderOverview(ctx(cols, 24)).map(strip);
    assert.ok(stripped.some((l) => /\bFLAGS\b/.test(l)), `${cols} cols: FLAGS header present`);
    assert.ok(!stripped.some((l) => /\bBATT\b/.test(l)), `${cols} cols: BATT dropped (narrow tier)`);
    // Node 6 (all 9 flags) still shows its flag letters — never clipped off the row.
    const row6 = stripped.find((l) => /\bNode 6\b/.test(l)) ?? '';
    assert.ok(/D.*S.*W.*F.*R/.test(row6), `${cols} cols: node 6 flags D/S/W/F/R present, got "${row6.trim()}"`);
  }
});

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
  // Above the floor, the clamp still binds: 60 timeouts of 30 sends is a
  // counter inconsistency, not 200%.
  assert.equal(responseTimeoutPct(stats({ commandsTX: 30, timeoutResponse: 60 })), 100);
  // BEHAVIOUR CHANGE (v0.54.0), not a weakened assertion: below MIN_TX_FOR_RATE
  // the denominator is floored, so 10-of-10 reads 50%, not 100%. The driver's
  // counters reset on restart, so a sub-20 denominator is routine — and an
  // unfloored rate let one timeout out of two sends outrank a node failing 4%
  // of 30,000 on the worst-first roster. The rate stays monotone in evidence.
  assert.equal(responseTimeoutPct(stats({ commandsTX: 10, timeoutResponse: 50 })), 50);
  assert.equal(responseTimeoutPct(stats({ commandsTX: 2, timeoutResponse: 1 })), 5);
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

test('the MESH meter cannot read 100% while the roster grades nodes F (v0.52.0)', () => {
  // Reproduced at v0.51.0: five ALIVE, non-flaky nodes scoring 49/F (weak
  // margin, failed route, 9.6 kbps) rendered
  //   `NODES 39  ONLINE 39  DEAD 0  ASLEEP 0  FLAKY 0  ... MESH ████████ 100%`
  // on the same frame as its own roll-up's `F 5` and `WORST F 49`. The meter
  // subtracted only dead/flaky/unknown, so the scorer's own verdict — the one
  // the operator reads three rows below — was invisible to it.
  const failing: Record<number, HealthResult> = {};
  for (const id of [10, 11, 12, 13, 14]) failing[id] = { score: 49, grade: 'F', state: 'weak', flags: ['W', 'R', 'L'] };
  const d: DataProvider = { ...data, scoreFor: (id) => failing[id] ?? { score: 90, grade: 'A', state: 'ok', flags: [] } };
  const lines = renderOverview({ view: mkView(160, 40), data: d, visibleNodes: nodes, filtering: false, actionsEnabled: true })
    .map(strip);
  const strip5 = lines.find((l) => /NODES\s+\d+/.test(l) && /MESH/.test(l)) ?? '';
  assert.ok(strip5, 'the telemetry strip must render');
  assert.doesNotMatch(strip5, /MESH .*100%/, `five F nodes cannot leave a full-green meter: "${strip5}"`);
  // And the subtracted term is NAMED — a percentage that reconciles against no
  // field on the strip is its own defect.
  assert.match(strip5, /FAILING\s+5/, `the meter's own term must be on the strip: "${strip5}"`);
});

test('a clean fleet still reads 100% — the new term does not double-count (v0.52.0)', () => {
  // Dead (0/F) and Unknown (capped 15/F) also grade F; counting them as
  // `failing` too would subtract the same node twice and land the meter on a
  // percentage matching no count on the strip.
  const lines = renderOverview({ view: mkView(160, 40), data, visibleNodes: nodes, filtering: false, actionsEnabled: true })
    .map(strip);
  const strip5 = lines.find((l) => /NODES\s+\d+/.test(l) && /MESH/.test(l)) ?? '';
  // The base fixture has exactly one flaky node (6) out of 39.
  assert.doesNotMatch(strip5, /FAILING/, `no F node beyond the flaky one: "${strip5}"`);
});

test('a DEAD node is subtracted from the mesh meter once, not twice (v0.52.0)', () => {
  // Dead (0/F) and Unknown (capped 15/F) both grade F. Counting them in the
  // new `failing` term as well as their own would subtract the same node twice
  // and land the meter on a percentage that reconciles against no field on the
  // strip — trading one unreadable number for another.
  const deadNodes = nodes.map((n, i) => (i >= 1 && i <= 4
    ? { ...n, status: NodeStatus.Dead, statusLabel: 'dead' } : n));
  const d: DataProvider = {
    ...data,
    nodes: () => deadNodes,
    nodeById: (id) => deadNodes.find((n) => n.nodeId === id),
    scoreFor: (id) => (id >= 2 && id <= 5
      ? { score: 0, grade: 'F', state: 'dead', flags: ['D'] }
      : { score: 90, grade: 'A', state: 'ok', flags: [] }),
  };
  const lines = renderOverview({ view: mkView(160, 40), data: d, visibleNodes: deadNodes, filtering: false, actionsEnabled: true })
    .map(strip);
  const s5 = lines.find((l) => /NODES\s+\d+/.test(l) && /MESH/.test(l)) ?? '';
  assert.match(s5, /DEAD\s+4/, `fixture must actually produce 4 dead: "${s5}"`);
  // 4 of 39 gone => 35/39 = 90%. Double-counting would give 31/39 = 79%.
  assert.match(s5, /MESH .*\b90%/, `a dead node counts once: "${s5}"`);
  assert.doesNotMatch(s5, /FAILING/, `dead is already its own term: "${s5}"`);
});
