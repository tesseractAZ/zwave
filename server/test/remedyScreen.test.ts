import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRemedy } from '../src/telnet/screens/remedy';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type { DataProvider, NodeSnapshot, ControllerSnapshot, ScreenCtx, ViewState, Symptom } from '../src/types';

const now = Date.now();
function node(id: number): NodeSnapshot {
  return {
    nodeId: id, deviceId: 'd' + id, name: `Node ${id} Longish Name`, area: null, status: NodeStatus.Alive,
    statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
    isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
    battery: null, firmware: null, stats: {} as never, entities: [],
  };
}
const nodes = [node(1), node(6), node(7)];
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;

function data(symptoms: Symptom[]): DataProvider {
  return {
    nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id), controller: () => ctrl, events: () => [],
    scoreFor: () => ({ score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] }),
    noiseFloor: () => -100, hasRealNoise: () => true, history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => now - 1000, ready: () => true, lastError: () => null, symptoms: () => symptoms,
    engineStatus: () => ({ enabled: true, ready: 3, total: 3 }),
  };
}
const mkView = (cols: number, rows: number): ViewState =>
  ({ screen: 'remedy', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', followTail: true, errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, symptoms: Symptom[]): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(symptoms), visibleNodes: nodes, filtering: false, actionsEnabled: true });

const sym = (over: Partial<Symptom> = {}): Symptom => ({
  kind: 'return-path-degraded', nodeId: 6, severity: 'warn', sinceMs: now - 20 * 60_000, basis: 'measured',
  evidence: [{ label: 'timeout rate (10m)', value: '31.0% of 120 tx' }, { label: 'own baseline', value: '2.0%' }],
  narrative: 'Node 6 reply-timeout rate is well above its own normal — a return-path problem. A mains repeater on an interior path usually helps.', ...over,
});

test('Remedy holds EXACTLY view.rows lines within view.cols at every size (empty + populated)', () => {
  const lists: Symptom[][] = [
    [],
    [sym({ severity: 'crit', kind: 'dead-flap' }), sym(), sym({ nodeId: null, kind: 'mesh-interference', basis: 'inferred' })],
  ];
  for (const syms of lists) {
    for (const [cols, rows] of [[40, 12], [80, 24], [120, 40], [200, 50]] as const) {
      const lines = renderRemedy(ctx(cols, rows, syms));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      lines.forEach((l, i) => assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: width ${visLen(l)} > ${cols}`));
    }
  }
});

test('empty state distinguishes all-healthy (all baselines ready) from the title all-clear', () => {
  const lines = renderRemedy(ctx(100, 24, [])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(lines.some((l) => /All clear/.test(l)), 'all-healthy copy (3/3 ready)');
  assert.ok(lines.some((l) => /all clear/.test(l)), 'title token');
});

test('a symptom renders its kind, node, evidence, basis, and dwell age', () => {
  const lines = renderRemedy(ctx(120, 30, [sym()])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const joined = lines.join('\n');
  assert.ok(/return-path-degraded/.test(joined), 'kind shown');
  assert.ok(/#6/.test(joined), 'node shown');
  assert.ok(/31\.0% of 120 tx/.test(joined), 'evidence value shown');
  assert.ok(/measured/.test(joined), 'basis label shown');
  assert.ok(/20m/.test(joined), 'dwell age shown');
});

test('an inferred mesh symptom is labelled "inferred", and a subsumed one is marked', () => {
  const syms = [sym({ nodeId: null, kind: 'mesh-interference', basis: 'inferred' }), sym({ subsumedBy: 'mesh' })];
  const joined = renderRemedy(ctx(120, 30, syms)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/MESH/.test(joined), 'mesh-scoped symptom shows MESH');
  assert.ok(/inferred/.test(joined), 'inferred basis shown');
  assert.ok(/under mesh event/.test(joined), 'subsumed symptom annotated');
});
