import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKey } from '../src/telnet/input';
import { NodeStatus, type DataProvider, type NodeSnapshot, type ViewState, type HealthResult } from '../src/types';

const node: NodeSnapshot = {
  nodeId: 3, deviceId: 'd3', name: 'Node 3', area: null,
  status: NodeStatus.Alive, statusLabel: 'alive', ready: true,
  isRouting: true, isListening: true, isLongRange: false, isController: false,
  isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
  battery: null, firmware: null, stats: {
    rtt: null, rssi: null, lwr: null, nlwr: null, commandsTX: 0, commandsRX: 0,
    commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: null,
  }, entities: [],
};
const score: HealthResult = { score: 79, rating: 8, grade: 'C', state: 'ok', flags: [] };
const data: DataProvider = {
  nodes: () => [node], nodeById: () => node, controller: () => null, events: () => [],
  scoreFor: () => score, noiseFloor: () => -95, hasRealNoise: () => false, history: () => ({ rssi: [], rtt: [] }),
  historyLong: () => ({ rssi: [], rtt: [] }), lastUpdated: () => 0, ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0 }), efficacyFor: () => null, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
};
const mkView = (screen: ViewState['screen'] = 'overview'): ViewState => ({
  screen, cols: 100, rows: 30, selected: 0, scroll: 0, filter: '',
  sortKey: 'health', signalDisplay: 'margin', followTail: true, errorsOnly: false,
  detailScroll: 0, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null,
});
const char = (ch: string) => ({ type: 'char' as const, ch });

/** A 3-node roster for Detail node-stepping tests. */
function mkMultiNodeData(): DataProvider {
  const nodes: NodeSnapshot[] = [3, 4, 5].map((id) => ({ ...node, nodeId: id, deviceId: 'd' + id, name: 'Node ' + id }));
  return { ...data, nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id) };
}

test('number keys 1-6 select the right screen', () => {
  const v = mkView();
  applyKey(v, char('4'), data); assert.equal(v.screen, 'topology');
  applyKey(v, char('1'), data); assert.equal(v.screen, 'overview');
});
test('c jumps to Controller, e jumps to Log', () => {
  const v = mkView();
  applyKey(v, char('c'), data); assert.equal(v.screen, 'controller');
  applyKey(v, char('e'), data); assert.equal(v.screen, 'log');
});
test('Enter opens Detail for the selected node', () => {
  const v = mkView();
  applyKey(v, { type: 'enter' }, data); assert.equal(v.screen, 'detail');
});
test('q on the Overview home signals quit', () => {
  const v = mkView('overview');
  const r = applyKey(v, char('q'), data);
  assert.equal(r.quit, true);
});
test('q on an overlay returns to Overview (does NOT quit)', () => {
  const v = mkView('controller');
  const r = applyKey(v, char('q'), data);
  assert.equal(v.screen, 'overview');
  assert.ok(!r.quit);
});
test('Esc on an overlay returns to Overview', () => {
  const v = mkView('heatmap');
  applyKey(v, { type: 'escape' }, data);
  assert.equal(v.screen, 'overview');
});
test('/ requests filter-capture mode', () => {
  const v = mkView();
  const r = applyKey(v, char('/'), data);
  assert.equal(r.filter, 'start');
});
test('s cycles the sort key', () => {
  const v = mkView();
  applyKey(v, char('s'), data); assert.equal(v.sortKey, 'id');
});
test('read-only action keys are no-ops in v0.1', () => {
  const v = mkView();
  for (const k of ['p', 'i', 'h', 'R', 'x']) {
    const r = applyKey(v, char(k), data);
    assert.ok(!r.quit && !r.redraw, `${k} should be a no-op`);
    assert.equal(v.screen, 'overview');
  }
});

/* ── Detail screen: dossier scroll + node stepping (v0.22) ─────────────────── */

test('Detail: j/k and arrows scroll the dossier (NOT the node selection)', () => {
  const v = mkView('detail');
  v.selected = 0;
  applyKey(v, char('j'), data);
  assert.equal(v.detailScroll, 1, 'j scrolls down');
  assert.equal(v.selected, 0, 'j does NOT move node selection on Detail');
  applyKey(v, { type: 'arrow', dir: 'down' }, data);
  assert.equal(v.detailScroll, 2, 'arrow-down scrolls');
  applyKey(v, char('k'), data);
  assert.equal(v.detailScroll, 1, 'k scrolls up');
  // never below zero
  applyKey(v, char('k'), data);
  applyKey(v, char('k'), data);
  assert.equal(v.detailScroll, 0, 'scroll clamps at 0');
});

test('Detail: < and > step to the adjacent node and reset the scroll to the top', () => {
  const md = mkMultiNodeData();
  const v = mkView('detail');
  v.selected = 0;
  v.detailScroll = 7;
  applyKey(v, char('>'), md);
  assert.equal(v.selected, 1, '> advances the node');
  assert.equal(v.detailScroll, 0, 'new node starts at the top');
  applyKey(v, char('<'), md);
  assert.equal(v.selected, 0, '< steps back');
  // unshifted aliases , and . work too
  applyKey(v, char('.'), md);
  assert.equal(v.selected, 1, '. is an alias for >');
  applyKey(v, char(','), md);
  assert.equal(v.selected, 0, ', is an alias for <');
});

test('Detail: g jumps to top, G requests the bottom (renderer clamps)', () => {
  const v = mkView('detail');
  v.detailScroll = 5;
  applyKey(v, char('g'), data);
  assert.equal(v.detailScroll, 0, 'g → top');
  applyKey(v, char('G'), data);
  assert.ok(v.detailScroll > 0, 'G requests a large offset the renderer will clamp');
});

test('Detail: Enter into Detail resets the scroll to the top', () => {
  const v = mkView('overview');
  v.detailScroll = 20;
  applyKey(v, { type: 'enter' }, data);
  assert.equal(v.screen, 'detail');
  assert.equal(v.detailScroll, 0, 'drilling in starts at the top');
});

test('Detail: number/letter screen switches still work (not swallowed by scroll)', () => {
  const v = mkView('detail');
  applyKey(v, char('1'), data);
  assert.equal(v.screen, 'overview', 'screen switch falls through to the generic handler');
});

test('entering Detail via its screen number (2) resets the scroll to the top', () => {
  const v = mkView('overview');
  v.detailScroll = 15; // stale offset from a previous, taller node
  applyKey(v, char('2'), data);
  assert.equal(v.screen, 'detail', "'2' selects the Detail screen");
  assert.equal(v.detailScroll, 0, 'stale offset cleared so the dossier opens at the top');
});
