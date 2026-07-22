import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDetail, formatEntityState } from '../src/telnet/screens/detail';
import { pickDisplayAttrs } from '../src/zwave/zwaveData';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type {
  ConfigParamsResult,
  ControllerSnapshot,
  DataProvider,
  EntityLiveState,
  HealthResult,
  NodeSnapshot,
  NodeStats,
  ScreenCtx,
  ViewState,
} from '../src/types';

const now = 1_700_000_000_000;
const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, '');

function stats(over: Partial<NodeStats> = {}): NodeStats {
  return { rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null, commandsTX: 200, commandsRX: 198, commandsDroppedTX: 0, commandsDroppedRX: 1, timeoutResponse: 0, lastSeen: now - 3000, ...over };
}
function node(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return { nodeId: 8, deviceId: 'd8', name: 'Kitchen Lamp', area: 'Kitchen', status: NodeStatus.Alive, statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false, isController: false, isSecure: true, securityClass: 'S2', manufacturer: 'Zooz', model: 'ZEN72', battery: null, firmware: null, stats: stats(), entities: [], ...over };
}
function ent(over: Partial<EntityLiveState> = {}): EntityLiveState {
  return { entityId: 'light.kitchen', domain: 'light', name: 'Kitchen Lamp', state: 'on', attrs: {}, ...over };
}

const ctrl = { homeId: 3586281591 } as ControllerSnapshot;
const okScore: HealthResult = { score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] };

interface DataOver {
  node?: NodeSnapshot;
  entityStates?: EntityLiveState[];
  configParams?: ConfigParamsResult;
  onRequestConfig?: (n: number) => void;
}
function mkData(o: DataOver = {}): { data: DataProvider; nodes: NodeSnapshot[] } {
  const n = o.node ?? node();
  const nodes = [n];
  const data: DataProvider = {
    nodes: () => nodes,
    nodeById: (id) => nodes.find((x) => x.nodeId === id),
    controller: () => ctrl,
    events: () => [],
    scoreFor: () => okScore,
    noiseFloor: () => -92,
    hasRealNoise: () => true,
    history: () => ({ rssi: [-60, -59, -58], rtt: [30, 31] }),
    historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => now - 1000,
    ready: () => true,
    lastError: () => null,
    symptoms: () => [],
    engineStatus: () => ({ enabled: false, ready: 0, total: 0 }),
    efficacyFor: () => null,
    interference: () => ({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
    entityStates: () => o.entityStates ?? [],
    configParams: () => o.configParams ?? { status: 'ready', params: [] },
    requestConfigParams: (id) => o.onRequestConfig?.(id),
  };
  return { data, nodes };
}

const mkView = (cols: number, rows: number, over: Partial<ViewState> = {}): ViewState =>
  ({ screen: 'detail', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', followTail: true, errorsOnly: false, detailScroll: 0, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null, ...over } as ViewState);
const ctx = (view: ViewState, data: DataProvider, nodes: NodeSnapshot[]): ScreenCtx =>
  ({ view, data, visibleNodes: nodes, filtering: false, actionsEnabled: true });

/* ── formatEntityState: the per-domain live-state vocabulary ───────────────── */

test('formatEntityState: light on/off + dimmer %', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'light', state: 'off' }))), 'off');
  assert.equal(strip(formatEntityState(ent({ domain: 'light', state: 'on' }))), 'on');
  assert.equal(strip(formatEntityState(ent({ domain: 'light', state: 'on', attrs: { brightness: 128 } }))), 'on · 50%');
});
test('formatEntityState: switch/fan', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'switch', state: 'on' }))), 'on');
  assert.equal(strip(formatEntityState(ent({ domain: 'switch', state: 'off' }))), 'off');
  assert.equal(strip(formatEntityState(ent({ domain: 'fan', state: 'on', attrs: { percentage: 66 } }))), 'on · 66%');
});
test('fan speed survives the data-layer whitelist end-to-end (regression: percentage was stripped)', () => {
  // The bug: pickDisplayAttrs dropped `percentage`, so the fan branch always saw
  // undefined and rendered bare "on". Feed a fan's raw attrs THROUGH the whitelist.
  const cached = pickDisplayAttrs({ percentage: 40, supported_features: 48 });
  assert.equal(strip(formatEntityState(ent({ domain: 'fan', state: 'on', attrs: cached }))), 'on · 40%');
});
test('formatEntityState: binary_sensor is device-class aware', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'binary_sensor', state: 'on', attrs: { device_class: 'motion' } }))), 'detected');
  assert.equal(strip(formatEntityState(ent({ domain: 'binary_sensor', state: 'off', attrs: { device_class: 'motion' } }))), 'clear');
  assert.equal(strip(formatEntityState(ent({ domain: 'binary_sensor', state: 'on', attrs: { device_class: 'door' } }))), 'open');
  assert.equal(strip(formatEntityState(ent({ domain: 'binary_sensor', state: 'off', attrs: { device_class: 'door' } }))), 'closed');
  // unknown device_class → generic on/off
  assert.equal(strip(formatEntityState(ent({ domain: 'binary_sensor', state: 'on', attrs: {} }))), 'on');
});
test('formatEntityState: sensor shows value + unit; enum sensor shows the string', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'sensor', state: '72', attrs: { unit_of_measurement: '°F' } }))), '72 °F');
  assert.equal(strip(formatEntityState(ent({ domain: 'sensor', state: 'idle', attrs: {} }))), 'idle');
});
test('formatEntityState: climate mode + setpoint/current', () => {
  const s = strip(formatEntityState(ent({ domain: 'climate', state: 'cool', attrs: { temperature: 74, current_temperature: 75 } })));
  assert.equal(s, 'cool · set 74° · now 75°');
  assert.equal(strip(formatEntityState(ent({ domain: 'climate', state: 'off', attrs: {} }))), 'off');
});
test('formatEntityState: cover open/closed + position', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'cover', state: 'open', attrs: { current_position: 100 } }))), 'open · 100%');
  assert.equal(strip(formatEntityState(ent({ domain: 'cover', state: 'closed', attrs: {} }))), 'closed');
});
test('formatEntityState: lock + update + unavailable/null', () => {
  assert.equal(strip(formatEntityState(ent({ domain: 'lock', state: 'locked' }))), 'locked');
  assert.equal(strip(formatEntityState(ent({ domain: 'lock', state: 'unlocked' }))), 'unlocked');
  assert.equal(strip(formatEntityState(ent({ domain: 'update', state: 'on' }))), 'update available');
  assert.equal(strip(formatEntityState(ent({ domain: 'update', state: 'off' }))), 'up to date');
  assert.equal(strip(formatEntityState(ent({ domain: 'sensor', state: null }))), '—');
  assert.equal(strip(formatEntityState(ent({ domain: 'sensor', state: 'unavailable' }))), 'unavailable');
});

/* ── screen: exact geometry + section presence ─────────────────────────────── */

test('Detail holds EXACTLY view.rows lines within view.cols at every size', () => {
  const entities = Array.from({ length: 8 }, (_, i) => ent({ entityId: `sensor.s${i}`, domain: 'sensor', name: `Sensor ${i}`, state: String(i), attrs: { unit_of_measurement: 'x' } }));
  const params = Array.from({ length: 8 }, (_, i) => ({ key: `1-1-0-${i}`, label: `Param ${i}`, value: i, valueLabel: null, unit: null, writeable: true, min: 0, max: 10, property: i, propertyKey: null, endpoint: 0, states: null }));
  const { data, nodes } = mkData({ entityStates: entities, configParams: { status: 'ready', params } });
  for (const [cols, rows] of [[40, 12], [72, 20], [80, 24], [120, 46], [200, 50]] as const) {
    const lines = renderDetail(ctx(mkView(cols, rows), data, nodes));
    assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
    lines.forEach((l, i) => {
      assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: width ${visLen(l)} > ${cols}`);
      assert.ok(!l.includes('undefined'), `${cols}x${rows} row ${i}: leaked "undefined"`);
    });
  }
});

test('Detail renders the LIVE ENTITIES section with formatted state', () => {
  const { data, nodes } = mkData({ entityStates: [ent({ domain: 'light', name: 'Kitchen Lamp', state: 'on', attrs: { brightness: 255 } })] });
  const out = renderDetail(ctx(mkView(100, 46), data, nodes)).map(strip).join('\n');
  assert.match(out, /LIVE ENTITIES/);
  assert.match(out, /Kitchen Lamp/);
  assert.match(out, /on · 100%/);
});

test('Detail renders CONFIG PARAMETERS with value + enum meaning', () => {
  const params = [{ key: '3-112-0-16', label: 'Switch Mode', value: 2, valueLabel: 'Always off', unit: null, writeable: true, min: null, max: null, property: 16, propertyKey: null, endpoint: 0, states: { '0': 'On', '2': 'Always off' } }];
  const { data, nodes } = mkData({ configParams: { status: 'ready', params } });
  const out = renderDetail(ctx(mkView(100, 46), data, nodes)).map(strip).join('\n');
  assert.match(out, /CONFIG PARAMETERS/);
  assert.match(out, /Switch Mode/);
  assert.match(out, /Always off/);
});

test('Detail requests config params for the shown node (lazy fetch trigger)', () => {
  let requested: number | null = null;
  const { data, nodes } = mkData({ onRequestConfig: (n) => { requested = n; } });
  renderDetail(ctx(mkView(100, 46), data, nodes));
  assert.equal(requested, 8, 'requestConfigParams called with the node id');
});

test('Detail config status: loading / error / empty each show an honest line', () => {
  const load = renderDetail(ctx(mkView(100, 46), mkData({ configParams: { status: 'loading', params: [] } }).data, mkData().nodes)).map(strip).join('\n');
  assert.match(load, /loading configuration/);
  const err = renderDetail(ctx(mkView(100, 46), mkData({ configParams: { status: 'error', params: [], error: 'boom' } }).data, mkData().nodes)).map(strip).join('\n');
  assert.match(err, /configuration unavailable: boom/);
  const empty = renderDetail(ctx(mkView(100, 46), mkData({ configParams: { status: 'ready', params: [] } }).data, mkData().nodes)).map(strip).join('\n');
  assert.match(empty, /no configurable parameters/);
});

/* ── scroll model ──────────────────────────────────────────────────────────── */

test('Detail clamps an over-scrolled offset and writes it back into the view', () => {
  const entities = Array.from({ length: 30 }, (_, i) => ent({ entityId: `sensor.s${i}`, domain: 'sensor', name: `Sensor ${i}`, state: String(i) }));
  const { data, nodes } = mkData({ entityStates: entities });
  const view = mkView(100, 20, { detailScroll: 9999 });
  renderDetail(ctx(view, data, nodes));
  assert.ok(view.detailScroll < 9999, 'over-scroll was clamped');
  assert.ok(view.detailScroll >= 0, 'clamp stays non-negative');
});

test('Detail scrolling reveals different content rows', () => {
  const entities = Array.from({ length: 30 }, (_, i) => ent({ entityId: `sensor.s${i}`, domain: 'sensor', name: `RowMarker${i}`, state: String(i) }));
  const { data, nodes } = mkData({ entityStates: entities });
  const top = renderDetail(ctx(mkView(100, 20, { detailScroll: 0 }), data, nodes)).map(strip).join('\n');
  const down = renderDetail(ctx(mkView(100, 20, { detailScroll: 12 }), data, nodes)).map(strip).join('\n');
  assert.notEqual(top, down, 'scrolling changes the visible window');
});

test('Detail shows a scroll position token only when the dossier overflows', () => {
  const big = mkData({ entityStates: Array.from({ length: 40 }, (_, i) => ent({ entityId: `sensor.s${i}`, domain: 'sensor', name: `S${i}`, state: String(i) })) });
  const over = renderDetail(ctx(mkView(120, 16), big.data, big.nodes)).map(strip).join('\n');
  assert.match(over, /\d+–\d+\/\d+/, 'a "a–b/N" scroll token appears when overflowing');
});
