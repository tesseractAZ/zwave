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
};
const mkView = (screen: ViewState['screen'] = 'overview'): ViewState => ({
  screen, cols: 100, rows: 30, selected: 0, scroll: 0, filter: '',
  sortKey: 'health', signalDisplay: 'margin', followTail: true, errorsOnly: false,
  logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null,
});
const char = (ch: string) => ({ type: 'char' as const, ch });

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
