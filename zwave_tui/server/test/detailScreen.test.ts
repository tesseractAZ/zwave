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
const okScore: HealthResult = { score: 90, grade: 'A', state: 'ok', flags: [] };

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
    engineStatus: () => ({ enabled: false, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 0, bands: 6 }),
    efficacyFor: () => null,
    interference: () => ({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
    entityStates: () => o.entityStates ?? [],
    configParams: () => o.configParams ?? { status: 'ready', params: [] },
    openEpisodes: () => [],
    controlArm: () => null,
    autoPingState: () => null,
    requestConfigParams: (id) => o.onRequestConfig?.(id),
  };
  return { data, nodes };
}

const mkView = (cols: number, rows: number, over: Partial<ViewState> = {}): ViewState =>
  ({ screen: 'detail', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, detailScroll: 0, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null, ...over } as ViewState);
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

test('CONFIG PARAMETERS keep their VALUES at every width (v0.27 columnise regression)', () => {
  // Columnising PRE-RENDERED full-width rows deleted every value: configParamRow
  // right-aligns the value at `inner` via lr(), so hstack's left-anchored cut at
  // the narrower column width kept the label and dropped the number — silently,
  // at 80 cols and wider. The section exists to show those values.
  const params = Array.from({ length: 8 }, (_, i) => ({
    key: `8-112-0-${i + 1}`, label: `Parameter ${i + 1}`, value: 100 + i,
    valueLabel: null, unit: null, writeable: true, min: 0, max: 255,
    property: i + 1, propertyKey: null, endpoint: 0, options: [],
  }));
  const { data, nodes } = mkData({ configParams: { status: 'ready', params } as never });
  const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, '');

  for (const cols of [60, 73, 80, 100, 120, 160, 200]) {
    const out = renderDetail(ctx(mkView(cols, 60), data, nodes));
    const text = out.map(strip).join('\n');
    for (const p of params) {
      assert.ok(text.includes(String(p.value)),
        `at ${cols} cols the value ${p.value} for "${p.label}" was dropped from the dossier`);
    }
    assert.equal(out.length, 60, `${cols} cols broke the exact-rows contract`);
  }
});

test('columnize keeps the 80-column terminal single-column (no name collapse)', () => {
  // The split fired from 73 cols up, giving the DEFAULT terminal two ~37-column
  // panes in which entity names became indistinguishable stubs — density bought
  // with information at the one size every operator sees.
  const entityStates = Array.from({ length: 6 }, (_, i) => ({
    entityId: `sensor.kitchen_power_meter_${i}`, domain: 'sensor',
    name: `Kitchen Power Meter Channel ${i}`, state: `${i * 11}`,
    attrs: { unit_of_measurement: 'W' },
  }));
  const { data, nodes } = mkData({ entityStates: entityStates as never });
  const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, '');
  const intact = (cols: number): boolean =>
    renderDetail(ctx(mkView(cols, 60), data, nodes)).map(strip).join('\n')
      .includes('Kitchen Power Meter Channel 0');
  assert.ok(intact(80), 'an 80-col terminal truncated entity names into stubs');
  assert.ok(intact(100), 'a 100-col terminal truncated entity names into stubs');
});

/* ── v0.35: the EVIDENCE section — what the ENGINE can see ─────────────────── */

type Cov = { firstSeenAt: number; samples: number; freshSamples: number; statusFeedLive: boolean; statsFeedLive: boolean };

function withEvidence(cov: Cov | null, coarse: { t0: number; samples: number }[] = []): { data: DataProvider; nodes: NodeSnapshot[] } {
  const d = mkData();
  (d.data as { evidenceCoverage?: (n: number) => Cov | null }).evidenceCoverage = () => cov;
  (d.data as { evidenceCoarse?: (n: number) => { t0: number; samples: number }[] }).evidenceCoarse = () => coarse;
  return d;
}
const evidenceLines = (d: { data: DataProvider; nodes: NodeSnapshot[] }, rows = 60): string[] =>
  renderDetail(ctx(mkView(120, rows), d.data, d.nodes)).map(strip);

test('EVIDENCE names the feeds and the window behind every other number on the screen', () => {
  const out = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 3 * 86_400_000, samples: 500, freshSamples: 450, statusFeedLive: true, statsFeedLive: true },
    [{ t0: Date.now() - 2 * 86_400_000, samples: 10 }],
  ));
  const body = out.join('\n');
  assert.match(body, /EVIDENCE/);
  assert.match(body, /status/);
  assert.match(body, /stats/);
  assert.match(body, /500/, 'the cumulative sample count');
  assert.match(body, /450 \(90% lifetime\)/,
    'fresh is a share AND says it is cumulative — it cannot show current staleness and must not imply it');
  assert.match(body, /3d/, 'how long this node has been watched');
  assert.match(body, /span ·/,
    'the History figure is a SPAN (first bucket to now), not continuous coverage — a gap lives inside it');
});

test('BOTH feeds down reads as a MONITORING HOLE, never as a quiet node', () => {
  // The distinction the whole section exists for: every quiet verdict elsewhere
  // on this dossier depends on someone having been listening.
  const out = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 86_400_000, samples: 12, freshSamples: 0, statusFeedLive: false, statsFeedLive: false },
  ));
  assert.match(out.join('\n'), /MONITORING HOLE/);
});

test('feeds up but ZERO samples says so, instead of implying a clean bill', () => {
  const out = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 60_000, samples: 0, freshSamples: 0, statusFeedLive: true, statsFeedLive: true },
  ));
  const body = out.join('\n');
  assert.match(body, /No samples yet/);
  assert.ok(!/MONITORING HOLE/.test(body), 'a live feed with no data yet is not a hole');
});

test('no coarse history renders "none yet", never a fabricated span', () => {
  const out = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 60_000, samples: 4, freshSamples: 4, statusFeedLive: true, statsFeedLive: true }, [],
  ));
  assert.match(out.join('\n'), /none yet/);
});

test('a provider WITHOUT evidence coverage renders exactly as before', () => {
  // The v0.33 bridge lesson, both directions: absent ⇒ no section, present ⇒ it
  // must actually reach the screen.
  const plain = evidenceLines({ ...mkData() });
  assert.ok(!plain.join('\n').includes('EVIDENCE'));
  const wired = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 3600_000, samples: 9, freshSamples: 9, statusFeedLive: true, statsFeedLive: true },
  ));
  assert.ok(wired.join('\n').includes('EVIDENCE'));
});

test('the render contract holds with the EVIDENCE section at every size', () => {
  const d = withEvidence(
    { firstSeenAt: Date.now() - 86_400_000, samples: 500, freshSamples: 100, statusFeedLive: true, statsFeedLive: false },
    [{ t0: Date.now() - 86_400_000, samples: 10 }],
  );
  for (const [cols, rows] of [[200, 60], [120, 40], [100, 24], [80, 24], [64, 20], [40, 12]] as const) {
    const out = renderDetail(ctx(mkView(cols, rows), d.data, d.nodes));
    assert.equal(out.length, rows, `rows at ${cols}x${rows}`);
    for (const l of out) assert.ok(visLen(l) <= cols, `width at ${cols}x${rows}: ${strip(l)}`);
  }
});

/* ── v0.35: the engine's LEARNED yardstick, and the HA device id ───────────── */

type Norm = { median: number; scale: number; ready: boolean; days: number };
function withNormal(rn: Norm | null): { data: DataProvider; nodes: NodeSnapshot[] } {
  const d = withEvidence({ firstSeenAt: Date.now() - 86_400_000, samples: 100, freshSamples: 95, statusFeedLive: true, statsFeedLive: true });
  (d.data as { rssiNormal?: (n: number) => Norm | null }).rssiNormal = () => rn;
  return d;
}

test('a GRADUATED baseline is quoted — the yardstick behind every "below its own normal"', () => {
  const out = evidenceLines(withNormal({ median: -62.4, scale: 3.2, ready: true, days: 9 }));
  const line = out.find((l) => /^\s*Normal/.test(l));
  assert.ok(line, 'the Normal row must render');
  assert.match(line!, /-62 dBm/);
  assert.match(line!, /±3 dB/);
  assert.match(line!, /9d/, 'the days behind it qualify the claim');
  assert.match(line!, /this time-of-day band/,
    'the store keeps a normal per 4h band — unlabelled, the yardstick reads as contradicting itself across the day');
});

test('an UNGRADUATED baseline says "still learning", never quotes a median', () => {
  // Quoting a median nobody should act on is worse than admitting it is early:
  // it looks exactly like a graduated band on screen.
  const out = evidenceLines(withNormal({ median: -71.9, scale: 12, ready: false, days: 1 }));
  const line = out.find((l) => /^\s*Normal/.test(l));
  assert.ok(line, 'the row still renders');
  assert.match(line!, /still learning/);
  assert.ok(!/-72 dBm|-71 dBm/.test(line!), 'no median from an un-graduated band');
});

test('no baseline at all renders no Normal row', () => {
  const out = evidenceLines(withNormal(null));
  assert.ok(!out.some((l) => /^\s*Normal/.test(l)));
});

test('the HA device id is shown — the string an automation needs and HA hides', () => {
  const d = mkData({ node: node({ deviceId: 'abc123def456' }) });
  const out = renderDetail(ctx(mkView(120, 60), d.data, d.nodes)).map(strip);
  assert.ok(out.some((l) => /HA id/.test(l) && /abc123def456/.test(l)), 'device id row present');
});

test('a node whose registry join FAILED shows no empty HA id row', () => {
  const d = mkData({ node: node({ deviceId: '' }) });
  const out = renderDetail(ctx(mkView(120, 60), d.data, d.nodes)).map(strip);
  assert.ok(!out.some((l) => /HA id/.test(l)), 'omit the row rather than print a blank field');
});

test('the fresh-sample share is TONED by how stale it is — not green regardless', () => {
  // Asserted on the raw escape codes, deliberately. Every other test in this
  // file strips ANSI, which made the tone invisible to the suite: a mutant that
  // painted a 5%-fresh feed green survived a fully-passing run.
  const raw = (freshSamples: number): string =>
    renderDetail(ctx(mkView(120, 60), ...(() => {
      const d = withEvidence({ firstSeenAt: Date.now() - 86_400_000, samples: 100, freshSamples, statusFeedLive: true, statsFeedLive: true });
      return [d.data, d.nodes] as const;
    })())).find((l) => /fresh/.test(strip(l))) ?? '';

  const GREEN = '\x1b[92m', YELLOW = '\x1b[93m', RED = '\x1b[91m';
  const healthy = raw(95);
  assert.ok(healthy.includes(GREEN), '95% fresh is green');
  const stale = raw(5);
  assert.ok(stale.includes(RED), `5% fresh must be RED, got: ${JSON.stringify(strip(stale))}`);
  assert.ok(!stale.includes(GREEN), 'and must not ALSO carry green — a mostly-stale feed is not healthy');
  const middling = raw(55);
  assert.ok(middling.includes(YELLOW), '55% fresh is the middle band');
});

test('ZERO samples renders a DASH for the fresh share — never a confident 0%', () => {
  // The pct==null branch is the code that keeps "no measurement" visually
  // distinct from "0% fresh" — the review found it had no assertion and no
  // mutant, which is exactly how such branches rot.
  const out = evidenceLines(withEvidence(
    { firstSeenAt: Date.now() - 60_000, samples: 0, freshSamples: 0, statusFeedLive: true, statsFeedLive: true },
  ));
  const row = out.find((l) => /Samples/.test(l));
  assert.ok(row, 'the Samples row renders');
  assert.match(row!, /—/, 'no measurement is a dash');
  assert.ok(!/\(0% lifetime\)/.test(row!), 'a 0% over zero samples would be a fabricated reading');
});

/* ── v0.37: the liveness sweep's own record ────────────────────────────────── */

type Cov37 = Cov & { probesAsked: number; probesAnswered: number; probesSelfProven: number;
  probesEchoOnly: number; probesAttribUnknown: number; probesUnheard: number };
function withProbes(p: Partial<Cov37>): { data: DataProvider; nodes: NodeSnapshot[] } {
  const d = mkData();
  const cov: Cov37 = {
    firstSeenAt: Date.now() - 7 * 86_400_000, samples: 500, freshSamples: 480,
    statusFeedLive: true, statsFeedLive: true,
    probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0, ...p,
  };
  (d.data as { evidenceCoverage?: (n: number) => Cov37 }).evidenceCoverage = () => cov;
  return d;
}

test('the probe reply rate reaches the screen — a rate collected and never shown is not a measurement', () => {
  const out = evidenceLines(withProbes({ probesAsked: 84, probesAnswered: 81, probesSelfProven: 22, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }));
  const row = out.find((l) => /^\s*Probes/.test(l));
  assert.ok(row, 'the Probes row must render');
  assert.match(row!, /81\/84 answered \(96%\)/);
  assert.match(row!, /22 self-proven/, 'and how many the node had already answered for itself');
});

test('a node that mostly MISSES its probes is toned as such', () => {
  // Asserted on the escape codes: the tone is the finding, and stripping ANSI
  // is how a mutant painting everything green survived a fully-passing run once.
  const raw = (asked: number, answered: number): string => {
    const d = withProbes({ probesAsked: asked, probesAnswered: answered });
    return renderDetail(ctx(mkView(120, 60), d.data, d.nodes)).find((l) => /Probes/.test(strip(l))) ?? '';
  };
  assert.ok(raw(20, 20).includes('\x1b[92m'), '100% is green');
  assert.ok(raw(20, 3).includes('\x1b[91m'), '15% is red');
  assert.ok(!raw(20, 3).includes('\x1b[92m'), 'and not also green');
});

test('a node never swept renders WHY, and never 0/0 as a rate (v0.47.0)', () => {
  // The original invariant stands: 0 of 0 is not a reliability of zero, it is
  // an absence of evidence, and rendering it as a RATE would be a fabricated
  // reading. What changed (v0.47.0) is that the absence used to render as
  // NOTHING, which conflated four different statements — see below.
  const out = evidenceLines(withProbes({ probesAsked: 0 }));
  const row = out.find((l) => /^\s*Probes/.test(l));
  assert.ok(row, 'the row must exist and explain itself');
  assert.doesNotMatch(row, /0\/0|\(0%\)/, 'never a fabricated rate');
  assert.match(row, /no probe evidence|not a sweep candidate/);
});

test('the four zero-probe states are told APART (v0.47.0)', () => {
  // "Sweep not running", "device can never be probed", "sweep suppressed" and
  // "due but not yet reached" all rendered as a blank row. The first two are
  // PERMANENT and the last two are TRANSIENT — an operator staring at a blank
  // row cannot tell whether waiting will help.
  const AP = (over: Record<string, unknown> = {}): unknown => ({
    lastTickMs: Date.now(), suppressed: 'none', listening: 35, deadListening: 0,
    staleDue: 0, stalestMs: null, verifyOwed: 0,
    config: { enabled: true, writeActions: true, afterMs: 600_000, maxAttempts: 3, staleMs: 7_200_000 },
    nodes: [], ...over,
  });
  const withAp = (ap: unknown, node?: Partial<NodeSnapshot>) => {
    const d = withProbes({ probesAsked: 0 });
    if (node) { const n = d.nodes[0]; Object.assign(n, node); }
    (d.data as { autoPingState?: () => unknown }).autoPingState = () => ap;
    return renderDetail(ctx(mkView(120, 60), d.data, d.nodes)).map(strip)
      .find((l) => /^\s*Probes/.test(l)) ?? '';
  };
  assert.match(withAp(null), /sweep is not running/);
  assert.match(withAp(AP({ config: { enabled: true, writeActions: true, afterMs: 1, maxAttempts: 3, staleMs: 0 } })), /sweep is disabled/);
  assert.match(withAp(AP({ suppressed: 'storm' })), /sweep suppressed \(storm\)/);
  assert.match(withAp(AP()), /due, but the sweep has not reached this node/);
  // A sleeping device is NOT a candidate, and that outranks every transient
  // reason — waiting will never produce evidence for it.
  assert.match(withAp(AP({ suppressed: 'storm' }), { isListening: false, isRouting: false }),
    /not a sweep candidate — sleeping device, never probed/);
  // THE CONTROLLER is never a sweep candidate either, however listening it is —
  // `isPingCandidate` is `!isController && isListening === true`, and that
  // first half is exactly what a hand-rolled copy in this screen would drop.
  // DETAIL can select it (it renders a `controller` capability tag), so this is
  // reachable, not hypothetical.
  assert.match(withAp(AP(), { isController: true, isListening: true }),
    /not a sweep candidate/, 'the controller is not swept, however listening');
});

test('self-proven is omitted when there is none, not printed as zero', () => {
  const out = evidenceLines(withProbes({ probesAsked: 10, probesAnswered: 10, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }));
  const row = out.find((l) => /^\s*Probes/.test(l))!;
  assert.match(row, /10\/10 answered/);
  assert.ok(!/self-proven/.test(row));
});

test('the lifetime-tally caveat follows the RATIO it qualifies, not the self-proven count (v0.45.0)', () => {
  // The pre-v0.40.2 blend inflated probesAsked/probesAnswered for exactly the
  // nodes under investigation — an effect entirely independent of whether any
  // self-proven credit ever landed. So a node with a fully blended history and
  // ZERO self-proven credits was the worst case, and the one case that got no
  // caveat at all.
  const out = evidenceLines(withProbes({ probesAsked: 40, probesAnswered: 31, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }));
  assert.ok(out.some((l) => /lifetime tally/.test(l)),
    `a blended history with no self-proven credit is the WORST case: ${JSON.stringify(out.filter((l) => /Probe/i.test(l)))}`);
});

test('the caveat is never cut mid-claim — a short form exists for narrow terminals (v0.45.0)', () => {
  const d = withProbes({ probesAsked: 40, probesAnswered: 31, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 });
  for (const cols of [80, 100, 120, 160, 200]) {
    const lines = renderDetail(ctx(mkView(cols, 60), d.data, d.nodes)).map(strip);
    const row = lines.find((l) => /lifetime tally/.test(l));
    assert.ok(row, `${cols} cols: the caveat must render`);
    // It ends on a complete claim, never mid-word.
    assert.ok(/boot credits\s*$|pre-v0\.40\.2\s*$/.test(row),
      `${cols} cols: the caveat is cut mid-claim — "${row.trim()}"`);
    assert.ok(visLen(row) <= cols, `${cols} cols: overflow`);
  }
});

test('a node with NO probes carries no caveat at all (v0.45.0)', () => {
  const out = evidenceLines(withProbes({ probesAsked: 0, probesAnswered: 0, probesSelfProven: 0, probesEchoOnly: 0, probesAttribUnknown: 0, probesUnheard: 0 }));
  assert.ok(!out.some((l) => /lifetime tally/.test(l)), 'nothing to qualify');
});


/* ── v0.48.0: the dossier states what the engine actually knows ───────────── */

/** withProbes + arbitrary extra provider members. */
function withYard(over: Record<string, unknown>, node?: Partial<NodeSnapshot>) {
  const d = withProbes({ probesAsked: 10, probesAnswered: 10 });
  if (node) Object.assign(d.nodes[0], node);
  Object.assign(d.data as unknown as Record<string, unknown>, over);
  return d;
}
const yardLines = (d: { data: DataProvider; nodes: NodeSnapshot[] }, cols = 140): string[] =>
  renderDetail(ctx(mkView(cols, 60), d.data, d.nodes)).map(strip);

test('all THREE learned yardsticks reach the dossier, not just the one that arms nothing', () => {
  // rssi was bridged and rtt/timeout were not — backwards, since
  // `grep -n 'baselines\.' symptoms.ts` returns exactly timeoutNormal and
  // rttNormal. The two numbers every "above its own normal" verdict is measured
  // against were the two the screen could not show.
  const out = yardLines(withYard({
    rssiNormal: () => ({ median: -62, scale: 3, ready: true, days: 9 }),
    rttNormal: () => ({ median: 41, scale: 7, ready: true, days: 9 }),
    timeoutNormal: () => ({ rate: 0.021, trials: 480, ready: true, days: 9 }),
  }));
  const norms = out.filter((l) => /Normal|Norm /.test(l));
  assert.ok(norms.some((l) => /-62 dBm ±3 dB · 9d · this time-of-day band/.test(l)),
    `rssi: ${JSON.stringify(norms)}`);
  assert.ok(norms.some((l) => /41 ms ±7 ms · 9d · this time-of-day band/.test(l)),
    `rtt: ${JSON.stringify(norms)}`);
  assert.ok(norms.some((l) => /2\.1% of ≈480 tx · 9d · this time-of-day band/.test(l)),
    `timeout: ${JSON.stringify(norms)}`);
});

test('an un-graduated yardstick says so instead of quoting a median', () => {
  const out = yardLines(withYard({ rttNormal: () => ({ median: 41, scale: 7, ready: false, days: 2 }) }));
  const row = out.find((l) => /Norm RTT/.test(l)) ?? '';
  assert.match(row, /still learning · 2d so far — not yet a yardstick/);
  assert.doesNotMatch(row, /41 ms/, 'a median nobody should act on yet is not quoted');
});

test('a node whose learning is PAUSED says so — "3d so far" is not advancing', () => {
  // The baseline is deliberately not folded while a symptom is live or arming
  // (it must not chase the pathology), so a held node's day count is frozen and
  // the row implied it was still climbing. The engine computed this set every
  // tick and stored it nowhere.
  for (const [hold, want] of [
    ['symptomatic', /a symptom is live, so the baseline is not folding/],
    ['arming', /arming a symptom, so the baseline is held/],
  ] as const) {
    const out = yardLines(withYard({ baselineHold: () => hold })).join('\n');
    assert.match(out, /Learning is PAUSED/, `${hold}: the hold must render`);
    assert.match(out, want, `${hold}: and say WHICH hold`);
  }
  assert.doesNotMatch(yardLines(withYard({ baselineHold: () => null })).join('\n'),
    /Learning is PAUSED/, 'a node that is learning says nothing');
});

test("a ROUTED node's RSSI normal is labelled last-hop, and loses its health colour", () => {
  // `stats.rssi` is the signal from whatever repeater relayed the frame, so for
  // a routed node this row describes a link the device is not on either end of.
  const lwr = { repeaters: [4], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null };
  const rn = { rssiNormal: () => ({ median: -62, scale: 3, ready: true, days: 9 }) };
  const routed = yardLines(withYard(rn, { stats: { ...node().stats, lwr } as never }), 160)
    .find((l) => /^\s*Normal\s/.test(l)) ?? '';
  assert.match(routed, /last-hop, not the device/, `routed: "${routed}"`);
  const direct = yardLines(withYard(rn), 160).find((l) => /^\s*Normal\s/.test(l)) ?? '';
  assert.doesNotMatch(direct, /last-hop/, `a direct node's rssi IS the device's: "${direct}"`);
});

test('the EVIDENCE verdict is PINNED outside the scroll window (v0.48.0)', () => {
  // The EVIDENCE block is LAST in a dossier that does not fit 80x24 for any
  // device shape, so its verdict was unreachable without scrolling — and an
  // operator who never scrolls never learns the node is unmonitored.
  const d = withProbes({ probesAsked: 5, probesAnswered: 5, statusFeedLive: false, statsFeedLive: false });
  for (const rows of [24, 30, 46]) {
    const out = renderDetail(ctx(mkView(100, rows), d.data, d.nodes)).map(strip);
    assert.equal(out.length, rows, `${rows}: exact rows`);
    // Row 2 is the telemetry slot, directly under the title rule and OUTSIDE
    // the scroll window.
    assert.match(out[2], /BOTH FEEDS DOWN/,
      `${rows}: the verdict must be pinned, not scrolled — got "${out[2]}"`);
  }
  // Scrolled to the bottom, it is STILL there.
  const scrolled = renderDetail({ ...ctx(mkView(100, 24), d.data, d.nodes),
    view: { ...mkView(100, 24), detailScroll: 999 } } as never).map(strip);
  assert.match(scrolled[2], /BOTH FEEDS DOWN/, 'scrolling cannot move it');
});

test('a healthy node pins NOTHING — the slot is for a verdict, not a heading (v0.48.0)', () => {
  const d = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (d.data as unknown as Record<string, unknown>).lastStatsUpdated = () => Date.now();
  const out = renderDetail(ctx(mkView(100, 24), d.data, d.nodes)).map(strip);
  assert.doesNotMatch(out[2], /⚠/, `nothing to pin: "${out[2]}"`);
  assert.equal(out.length, 24);
});

test('a SUBSCRIBED but silent stats feed is called out (v0.48.0)', () => {
  // The feed badges prove a subscription exists; they say nothing about whether
  // statistics are arriving. `lastStatsUpdated` is the only number that can,
  // and it reached /api/health and no screen.
  const d = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (d.data as unknown as Record<string, unknown>).lastStatsUpdated = () => Date.now() - 47 * 60_000;
  const out = renderDetail(ctx(mkView(120, 40), d.data, d.nodes)).map(strip);
  assert.match(out[2], /No statistics fleet-wide for 47m/, 'the pin carries it');
  assert.match(out[2], /subscribed, but nothing is arriving/);
  // At 40 rows the in-body row is BELOW the window ("1–35/36") — which is the
  // exact condition the pin exists for. Give it room and it is there too.
  const tall = renderDetail(ctx(mkView(120, 60), d.data, d.nodes)).map(strip).join('\n');
  assert.match(tall, /No statistics fleet-wide for 47m — the feed is subscribed but silent/,
    'and the dossier still reads coherently when scrolled');

  // A single missed event is not a dead feed.
  (d.data as unknown as Record<string, unknown>).lastStatsUpdated = () => Date.now() - 3 * 60_000;
  assert.doesNotMatch(renderDetail(ctx(mkView(120, 40), d.data, d.nodes)).map(strip).join('\n'),
    /subscribed but silent/, 'headroom over the poll cadence');
});

test('the pinned row is BUDGETED — no spurious "more lines hidden" (v0.48.0)', () => {
  // frame() spends an extra row for telemetry, but detail.ts sizes its OWN
  // body. Without the matching subtraction the body is one row too long and
  // frame discloses a hidden line that is not actually hidden.
  const d = withProbes({ probesAsked: 5, probesAnswered: 5, statusFeedLive: false, statsFeedLive: false });
  for (const rows of [24, 30, 46, 60]) {
    const out = renderDetail(ctx(mkView(120, rows), d.data, d.nodes)).map(strip);
    assert.equal(out.length, rows, `${rows}: exact rows`);
    const hidden = out.find((l) => /more line/.test(l));
    // At 60 rows the dossier fits, so any "hidden" disclosure is spurious.
    if (rows >= 60) {
      assert.ok(!hidden, `${rows}: nothing is hidden, so nothing should say so — "${hidden}"`);
    }
  }
});

test('a stale-feed pin does not fire on a single missed statistics event (v0.48.0)', () => {
  const d = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (d.data as unknown as Record<string, unknown>).lastStatsUpdated = () => Date.now() - 3 * 60_000;
  const out = renderDetail(ctx(mkView(120, 40), d.data, d.nodes)).map(strip);
  assert.doesNotMatch(out[2], /nothing is arriving/,
    `3 minutes is one missed event at a ~2-minute cadence, not a dead feed — "${out[2]}"`);
  // ...and it DOES fire once the silence clears the headroom.
  (d.data as unknown as Record<string, unknown>).lastStatsUpdated = () => Date.now() - 12 * 60_000;
  assert.match(renderDetail(ctx(mkView(120, 40), d.data, d.nodes)).map(strip)[2], /nothing is arriving/);
});

test('the timeout yardstick marks its DECAYED trials count as a weight (v0.48.1)', () => {
  // `r.trials = r.trials * (1 - DECAY) + trials` — a weight, not a tally. It
  // rendered live as `4.4% of 184.865275555814 tx`: fifteen decimals of
  // precision the number does not have. Same rule v0.43.1 set for the ledger's
  // `n` — a decayed weight is never printed as an exact count.
  const out = yardLines(withYard({
    timeoutNormal: () => ({ rate: 0.044, trials: 184.865275555814, ready: true, days: 10 }),
  }));
  const row = out.find((l) => /Norm TMO/.test(l)) ?? '';
  assert.match(row, /4\.4% of ≈185 tx/, `weight, rounded and marked: "${row}"`);
  assert.doesNotMatch(row, /184\.86/, 'never the raw float');
});

test('every EVIDENCE label fits the 8-column cell so the values align (v0.48.1)', () => {
  // kv() pads the label to 8; a longer one overflows and pushes its value out
  // of the column every other row lines up on. `Normal RTT` (10) did exactly
  // that live.
  const out = yardLines(withYard({
    rssiNormal: () => ({ median: -62, scale: 3, ready: true, days: 9 }),
    rttNormal: () => ({ median: 41, scale: 7, ready: true, days: 9 }),
    timeoutNormal: () => ({ rate: 0.021, trials: 480, ready: true, days: 9 }),
  }), 160);
  const cols = out.filter((l) => /^\s{2}(Normal|Norm |Samples|Probes|Feeds)/.test(l))
    .map((l) => l.indexOf(l.trim().split(/\s{2,}/)[1] ?? ''));
  const starts = new Set(cols.filter((i) => i > 0));
  assert.equal(starts.size, 1, `values must start in ONE column, got ${JSON.stringify([...starts])}`);
});

/* ── v0.49.0: the coarse tier reaches a screen ────────────────────────────── */

const CB = (over: Record<string, number | null> = {}): Record<string, number | null> => ({
  t0: 0, n: 10, freshN: 8, invalidW: 0, dTx: 100, dTimeout: 2,
  rssiN: 10, rssiSum: -650, rssiMin: -70, rssiMax: -60,
  rttN: 10, rttSum: 400, rttMin: 30, rttMax: 55, rateMin: 100,
  dFlaps: 0, dS2Resync: 0, dRouteChanges: 0, ...over,
});

test('the persisted RF ENVELOPE reaches the dossier — not just its mean (v0.49.0)', () => {
  // 14 of the 18 CoarseBucket fields had zero consumers. The mean is the least
  // useful of them: a node whose signal collapsed for an hour has the same mean
  // as one that never moved, and the WORST is the reading being looked for.
  const d = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (d.data as unknown as Record<string, unknown>).evidenceCoarse = () => [
    CB({ rssiMin: -70, rssiMax: -60, rateMin: 100 }),
    CB({ t0: 1, rssiMin: -91, rssiMax: -62, rateMin: 40 }),
  ];
  const out = renderDetail(ctx(mkView(160, 60), d.data, d.nodes)).map(strip);
  const row = out.find((l) => /Long RF/.test(l)) ?? '';
  assert.match(row, /-91…-60 dBm/, `the ENVELOPE, not the mean: "${row}"`);
  assert.match(row, /worst rate 40k/, 'and the worst negotiated rate');
});

test('evidence quality is reported only when some windows were VOID (v0.49.0)', () => {
  // `invalidW` counts windows whose counter arithmetic was void — a driver
  // restart or an over-long gap. Folded, persisted, read by nobody: a node
  // whose evidence is largely garbage looked identical to one whose is clean.
  const clean = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (clean.data as unknown as Record<string, unknown>).evidenceCoarse = () => [CB({ invalidW: 0 })];
  assert.doesNotMatch(renderDetail(ctx(mkView(160, 60), clean.data, clean.nodes)).map(strip).join('\n'),
    /invalid/, 'a permanent "0 invalid" trains an operator to stop reading the row');

  const dirty = withProbes({ probesAsked: 5, probesAnswered: 5 });
  (dirty.data as unknown as Record<string, unknown>).evidenceCoarse = () => [CB({ n: 10, invalidW: 4 })];
  const row = renderDetail(ctx(mkView(160, 60), dirty.data, dirty.nodes)).map(strip)
    .find((l) => /Windows/.test(l)) ?? '';
  assert.match(row, /4 of 10 invalid \(40%\)/, `the share: "${row}"`);
  assert.match(row, /counter arithmetic void/);
});

test('the four-way probe judgment reaches the screen, not just its one recorded arm (v0.49.0)', () => {
  // Only `self-proven` was ever recorded; the other three were computed,
  // described in a log line, and discarded every tick. They separate "never
  // speaks except to answer us" from "genuinely silent" — opposite readings of
  // the SAME answered/asked ratio.
  const d = withProbes({ probesAsked: 40, probesAnswered: 31, probesSelfProven: 5,
    probesEchoOnly: 22, probesUnheard: 9, probesAttribUnknown: 4 });
  const row = renderDetail(ctx(mkView(180, 60), d.data, d.nodes)).map(strip)
    .find((l) => /Probe cls/.test(l)) ?? '';
  assert.match(row, /22 echo-only/, `echo-only: "${row}"`);
  assert.match(row, /9 unheard/);
  assert.match(row, /4 unattributed/);

  // A node with only self-proven probes says nothing extra.
  const quiet = withProbes({ probesAsked: 10, probesAnswered: 10, probesSelfProven: 10 });
  assert.doesNotMatch(renderDetail(ctx(mkView(180, 60), quiet.data, quiet.nodes)).map(strip).join('\n'),
    /Probe cls/, 'no news is no row');
});

test('the coarse RTT trend renders beside its RSSI twin (v0.49.0)', () => {
  // Accumulated, persisted, restored AND bridged — and read by no screen. Its
  // RSSI twin has rendered since v0.41; this is the same data on the same
  // horizon for the series that actually arms a detector.
  const d = mkData();
  (d.data as unknown as Record<string, unknown>).historyLong = () => ({
    rssi: [-70, -68, -66, -65, -64],
    rtt: [40, 55, 48, 120, 61],
  });
  const out = renderDetail(ctx(mkView(140, 60), d.data, d.nodes)).map(strip);
  assert.ok(out.some((l) => /Sig long/.test(l)), 'precondition: the RSSI twin renders');
  assert.ok(out.some((l) => /RTT long/.test(l)),
    `the coarse RTT trend must render: ${JSON.stringify(out.filter((l) => /long/.test(l)))}`);
  const row = out.find((l) => /RTT long/.test(l)) ?? '';
  assert.match(row, /40…120 ms/, `with its own range: "${row}"`);
});

test('a DEAD node greys its long RTT trend like every other row (v0.49.0)', () => {
  // Shipping the raw band colour once already drew health-green sparklines
  // under a greyed `RSSI —` for a dead node.
  const d = mkData({ node: node({ status: NodeStatus.Dead, statusLabel: 'dead' }) });
  (d.data as unknown as Record<string, unknown>).historyLong = () => ({
    rssi: [-70, -68, -66], rtt: [40, 42, 41],
  });
  const raw = renderDetail(ctx(mkView(140, 60), d.data, d.nodes));
  const row = raw.find((l) => /RTT long/.test(strip(l))) ?? '';
  assert.ok(row, 'the row renders');
  assert.doesNotMatch(row, /\x1b\[9[23]m/, `a dead node's trend is not health-coloured: "${strip(row)}"`);
});
