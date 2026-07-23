/**
 * Documentation screenshot generator.
 *
 * Renders every TUI screen against a SYNTHETIC demo mesh and writes each frame
 * to `docs/screenshots/<screen>.svg`. The screenshots in the README and DOCS are
 * produced by this script, so they can be regenerated whenever a screen changes:
 *
 *   cd server && npx tsx scripts/gen-screenshots.mts
 *
 * Two deliberate choices:
 *   • **Synthetic data.** The demo mesh below is fictional — no real home's
 *     device names, areas, or home id ever reach the published docs.
 *   • **SVG, not PNG.** The TUI is text; SVG keeps it crisp at any zoom, stays
 *     diffable in git, and renders inline on GitHub in both light and dark mode
 *     (the frame carries its own dark background, like a real terminal).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderScreen } from '../src/telnet/screens/index';
import { renderActionsMenu } from '../src/telnet/screens/actionsMenu';
import { buildMenu, buildEntityRows, buildConfigRows } from '../src/telnet/actionsCatalog';
import { NodeStatus } from '../src/types';
import type {
  ConfigParam,
  ControllerSnapshot,
  DataProvider,
  EntityLiveState,
  HealthResult,
  LogEvent,
  NodeSnapshot,
  NodeStats,
  ScreenCtx,
  ScreenView,
  ViewState,
} from '../src/types';
import type { Symptom } from '../src/zwave/symptoms';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/screenshots');
const COLS = 104;
const ROWS = 22;
/**
 * Fixed clock. The screens compute "last seen" ages and the masthead stamp from
 * `Date.now()`, so we PIN it: without this the demo mesh would render as days
 * stale ("⚠ ROSTER STALE"), and every regeneration would churn the timestamps.
 * Pinning gives frames that look live AND a stable diff.
 */
const NOW = Date.UTC(2026, 4, 14, 9, 41, 0);
Date.now = () => NOW;

/* ── synthetic demo mesh ──────────────────────────────────────────────────── */

const stats = (o: Partial<NodeStats> = {}): NodeStats => ({
  rtt: 32, rssi: -62,
  lwr: { repeaters: [], protocolDataRate: 3, rssi: -62, repeaterRSSI: [], routeFailedBetween: null },
  nlwr: null, commandsTX: 1420, commandsRX: 1399, commandsDroppedTX: 0, commandsDroppedRX: 2,
  timeoutResponse: 3, lastSeen: NOW - 21_000, ...o,
});

interface Demo { id: number; name: string; area: string; score: number; grade: string; flags: string[]; st?: NodeStatus; s?: Partial<NodeStats>; batt?: number; }
const DEMO: Demo[] = [
  { id: 12, name: 'Kitchen Ceiling', area: 'Kitchen', score: 97, grade: 'A', flags: [] },
  { id: 7, name: 'Living Room Lamp', area: 'Living Room', score: 94, grade: 'A', flags: [] },
  { id: 23, name: 'Front Porch Light', area: 'Entry', score: 91, grade: 'A', flags: [],
    s: { lwr: { repeaters: [7], protocolDataRate: 3, rssi: -71, repeaterRSSI: [-64], routeFailedBetween: null } } },
  { id: 31, name: 'Garage Door', area: 'Garage', score: 88, grade: 'B', flags: [] },
  { id: 18, name: 'Office Smart Plug', area: 'Office', score: 84, grade: 'B', flags: [] },
  { id: 44, name: 'Hallway Motion', area: 'Hallway', score: 82, grade: 'B', flags: ['B'], batt: 41,
    s: { rssi: -78, rtt: 96, lwr: { repeaters: [12], protocolDataRate: 2, rssi: -78, repeaterRSSI: [-70], routeFailedBetween: null } } },
  { id: 52, name: 'Bedroom Fan', area: 'Bedroom', score: 76, grade: 'C', flags: ['L'], s: { rtt: 310 } },
  { id: 61, name: 'Patio String Lights', area: 'Patio', score: 68, grade: 'D', flags: ['W'],
    s: { rssi: -89, lwr: { repeaters: [23, 7], protocolDataRate: 2, rssi: -89, repeaterRSSI: [-83, -66], routeFailedBetween: null } } },
  { id: 70, name: 'Basement Leak Sensor', area: 'Basement', score: 59, grade: 'D', flags: ['F', 'B'], batt: 18,
    s: { timeoutResponse: 74, commandsTX: 900, rtt: 480, rssi: -86 } },
  { id: 83, name: 'Utility Closet Switch', area: 'Utility', score: 0, grade: 'F', flags: ['D'], st: NodeStatus.Dead,
    s: { rssi: -95, rtt: null, lastSeen: NOW - 3 * 3600_000, lwr: null } },
  { id: 15, name: 'Dining Room Dimmer', area: 'Dining Room', score: 93, grade: 'A', flags: [] },
  { id: 27, name: 'Entry Door Lock', area: 'Entry', score: 90, grade: 'A', flags: [], batt: 78,
    s: { rssi: -68, rtt: 44 } },
  { id: 38, name: 'Laundry Water Valve', area: 'Utility', score: 86, grade: 'B', flags: [] },
  { id: 49, name: 'Nursery Night Light', area: 'Nursery', score: 80, grade: 'B', flags: ['S'],
    s: { lastSeen: NOW - 40 * 60_000 } },
  { id: 56, name: 'Attic Temp Sensor', area: 'Attic', score: 74, grade: 'C', flags: ['B'], batt: 22,
    s: { rssi: -81, rtt: 120 } },
];

const node = (d: Demo): NodeSnapshot => ({
  nodeId: d.id, deviceId: `demo-${d.id}`, name: d.name, area: d.area,
  status: d.st ?? NodeStatus.Alive, statusLabel: d.st === NodeStatus.Dead ? 'dead' : 'alive',
  ready: true, isRouting: true, isListening: d.batt == null, isLongRange: false, isController: false,
  isSecure: true, securityClass: 'S2 Authenticated', manufacturer: 'Demo Devices', model: 'DM-100',
  battery: d.batt != null ? { level: d.batt, isLow: d.batt <= 25 } : null,
  firmware: { current: '1.12', latest: '1.12', updateAvailable: false, inProgress: false, progressPct: null, targets: 1 },
  stats: stats(d.s), entities: [{ entityId: `light.demo_${d.id}`, domain: 'light', name: d.name }],
});

const controllerNode: NodeSnapshot = {
  ...node({ id: 1, name: '800 Series Controller', area: 'Utility', score: 100, grade: 'A', flags: [] }),
  isController: true, stats: stats({ rssi: null, rtt: null, lwr: null }),
};
const NODES: NodeSnapshot[] = [controllerNode, ...DEMO.map(node)];
const SCORES = new Map<number, HealthResult>(DEMO.map((d) => [d.id, {
  score: d.score, rating: Math.round(d.score / 10), grade: d.grade,
  state: d.score === 0 ? 'dead' : d.score < 70 ? 'flaky' : 'ok', flags: d.flags,
} as HealthResult]));
SCORES.set(1, { score: 100, rating: 10, grade: 'A', state: 'ok', flags: [] });

const CONTROLLER: ControllerSnapshot = {
  homeId: 0xC0FFEE01, nodeId: 1, sdkVersion: '7.21.0', firmwareVersion: '1.8', rfRegion: 'USA',
  isPrimary: true, isSUC: true, isSISPresent: true, manufacturer: 'Demo Devices', model: 'DM-Stick 800LR',
  isRebuildingRoutes: false, rebuildStartedAt: null, firmwareUpdatesAvailable: 0,
  backgroundRSSI: [-101, -103, -99, -102],
  statistics: { messagesTX: 48120, messagesRX: 47908, messagesDroppedTX: 3, messagesDroppedRX: 11, NAK: 0, CAN: 6, timeoutACK: 1, timeoutResponse: 92 },
} as ControllerSnapshot;

const EVENTS: LogEvent[] = [
  { seq: 210, ts: NOW - 45_000, source: 'net', severity: 'info', kind: 'value', nodeId: 12, text: 'Kitchen Ceiling: off → on', entityId: 'light.demo_12', entityName: 'Kitchen Ceiling', domain: 'light', oldState: 'off', newState: 'on' },
  { seq: 209, ts: NOW - 190_000, source: 'you', severity: 'info', kind: 'action', nodeId: 31, text: 'open cover.garage_door → ok' },
  { seq: 208, ts: NOW - 240_000, source: 'net', severity: 'warn', kind: 'status', nodeId: 83, text: 'Utility Closet Switch: alive → dead' },
  { seq: 207, ts: NOW - 610_000, source: 'net', severity: 'info', kind: 'value', nodeId: 44, text: 'Hallway Motion: clear → detected', entityId: 'binary_sensor.demo_44', entityName: 'Hallway Motion', domain: 'binary_sensor', oldState: 'off', newState: 'on' },
  { seq: 206, ts: NOW - 900_000, source: 'net', severity: 'error', kind: 'route', nodeId: 70, text: 'Basement Leak Sensor: route failed between n70 ↮ n12', acked: false },
  { seq: 205, ts: NOW - 1_500_000, source: 'you', severity: 'info', kind: 'action', nodeId: 61, text: 'ping node 61 → ok' },
  { seq: 204, ts: NOW - 2_400_000, source: 'net', severity: 'info', kind: 'system', nodeId: null, text: 'activity feed live — watching 26 device entities' },
];

const SYMPTOMS: Symptom[] = [
  { kind: 'return-path-degraded', nodeId: 70, severity: 'crit', sinceMs: NOW - 5 * 3600_000, basis: 'measured',
    evidence: [], narrative: 'Reply-timeout rate 8.2% vs a 0.9% baseline for this time of day, sustained 5 h.' },
  { kind: 'weak-signal', nodeId: 61, severity: 'warn', sinceMs: NOW - 26 * 3600_000, basis: 'measured',
    evidence: [], narrative: 'SNR margin +12 dB over the live noise floor — two hops, both marginal.' },
  { kind: 'dead-flap', nodeId: 83, severity: 'crit', sinceMs: NOW - 2 * 3600_000, basis: 'measured',
    evidence: [], narrative: 'Alive↔Dead 6× in 2 h; currently dead for 3 h.' },
];

const ENTITIES: EntityLiveState[] = [
  { entityId: 'light.kitchen_ceiling', domain: 'light', name: 'Kitchen Ceiling', state: 'on', attrs: { brightness: 178 } },
  { entityId: 'sensor.kitchen_ceiling_power', domain: 'sensor', name: 'Kitchen Ceiling Power', state: '38.4', attrs: { unit_of_measurement: 'W' } },
  { entityId: 'binary_sensor.kitchen_motion', domain: 'binary_sensor', name: 'Kitchen Motion', state: 'on', attrs: { device_class: 'motion' } },
  { entityId: 'update.kitchen_ceiling_firmware', domain: 'update', name: 'Firmware', state: 'off', attrs: {} },
];
const PARAMS: ConfigParam[] = [
  { key: '12-112-0-1', label: 'LED Indicator', value: 2, valueLabel: 'Always off', unit: null, writeable: true, min: 0, max: 3, property: 1, propertyKey: null, endpoint: 0, states: { '0': 'On when off', '1': 'On when on', '2': 'Always off', '3': 'Always on' } },
  { key: '12-112-0-2', label: 'Dim Rate', value: 0, valueLabel: 'Dim quickly', unit: null, writeable: true, min: 0, max: 1, property: 2, propertyKey: null, endpoint: 0, states: { '0': 'Dim quickly', '1': 'Dim slowly' } },
  { key: '12-112-0-9', label: 'Ramp Duration', value: 1500, valueLabel: null, unit: 'ms', writeable: true, min: 0, max: 10000, property: 9, propertyKey: null, endpoint: 0, states: null },
  { key: '12-112-0-11', label: 'Minimum Brightness', value: 12, valueLabel: null, unit: '%', writeable: true, min: 1, max: 99, property: 11, propertyKey: null, endpoint: 0, states: null },
  { key: '12-112-0-12', label: 'Maximum Brightness', value: 99, valueLabel: null, unit: '%', writeable: false, min: 1, max: 99, property: 12, propertyKey: null, endpoint: 0, states: null },
];

const spark = (base: number, n: number, amp: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.round(base + Math.sin(i / 2.3) * amp + Math.cos(i / 1.7) * (amp / 2)));

const DATA: DataProvider = {
  nodes: () => NODES,
  nodeById: (id) => NODES.find((n) => n.nodeId === id),
  controller: () => CONTROLLER,
  events: () => EVENTS,
  scoreFor: (id) => SCORES.get(id) ?? { score: 90, rating: 9, grade: 'A', state: 'ok', flags: [] },
  noiseFloor: () => -101,
  hasRealNoise: () => true,
  history: () => ({ rssi: spark(-62, 40, 4), rtt: spark(34, 40, 8) }),
  historyLong: () => ({ rssi: spark(-63, 90, 5), rtt: [] }),
  lastUpdated: () => NOW - 1_200,
  ready: () => true,
  lastError: () => null,
  symptoms: () => SYMPTOMS,
  engineStatus: () => ({ enabled: true, ready: 10, total: 11 }),
  efficacyFor: (_k, a) => (a === 'ping' ? { expectedEfficacy: 0.71, n: 7, baseRate: 0.22, beatsSelfHealing: true, ready: true } : null),
  interference: () => ({
    noise: { channels: [-101, -103, -99, -102], floor: -101, real: true, trend: spark(-101, 40, 2), trendCoarse: spark(-100, 60, 3), trendCoarseDays: 12, band: 'clean' },
    serial: { nakPerH: 0, canPerH: 0.4, tmoAckPerH: 0.1, tmoRespPerH: 2.1, band: 'healthy', spanH: 168 },
    diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, rate: h >= 17 && h <= 20 ? 0.031 : 0.004 + (h % 5) * 0.0015, samples: 60 })),
    coverageDays: 12,
    correlated: { active: false, degradedNodes: 2, activeNodes: 10, narrative: 'No correlated mesh degradation.' },
  }) as never,
  entityStates: () => ENTITIES,
  configParams: () => ({ status: 'ready', params: PARAMS }),
  requestConfigParams: () => {},
};

const view = (screen: ScreenView, over: Partial<ViewState> = {}): ViewState => ({
  screen, cols: COLS, rows: ROWS, selected: 1, scroll: 0, filter: '', sortKey: 'health',
  signalDisplay: 'margin', followTail: true, errorsOnly: false, detailScroll: 0,
  logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null, ...over,
} as ViewState);

const ctx = (v: ViewState): ScreenCtx => ({ view: v, data: DATA, visibleNodes: NODES, filtering: false, actionsEnabled: true });

/* ── ANSI → SVG ───────────────────────────────────────────────────────────── */

const PALETTE: Record<number, string> = {
  90: '#7d8590', 91: '#ff7b72', 92: '#3fb950', 93: '#d29922', 94: '#58a6ff',
  96: '#39c5cf', 97: '#e6edf3', 39: '#e6edf3',
};
const BG = '#0d1117';
const CW = 8.4;  // 14px monospace advance (0.6em) — frame width only; text lays out naturally
const CH = 18;   // line height
const PAD = 14;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Run { text: string; fg: string; bold: boolean; invert: boolean }

function parseLine(line: string): Run[] {
  const runs: Run[] = [];
  let fg = PALETTE[39], bold = false, invert = false, buf = '';
  const flush = () => { if (buf) { runs.push({ text: buf, fg, bold, invert }); buf = ''; } };
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = line.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (m) {
        flush();
        for (const c of (m[1] || '0').split(';').map(Number)) {
          if (c === 0) { fg = PALETTE[39]; bold = false; invert = false; }
          else if (c === 1) bold = true;
          else if (c === 7) invert = true;
          else if (PALETTE[c]) fg = PALETTE[c];
        }
        i += m[0].length; continue;
      }
    }
    buf += line[i]; i++;
  }
  flush();
  return runs;
}

function toSvg(lines: string[], title: string): string {
  const w = Math.round(COLS * CW + PAD * 2);
  const h = Math.round(lines.length * CH + PAD * 2);
  const body: string[] = [];
  lines.forEach((line, r) => {
    const yTop = PAD + r * CH;
    const y = yTop + CH - 5;
    const runs = parseLine(line);
    if (runs.length === 0) return;
    // ONE <text> per line, colour switched with <tspan>, and NO per-run x. The
    // font is monospace, so its own advance keeps the columns aligned — trying to
    // position each run from an assumed cell width (or forcing textLength) drifts
    // or stretches glyphs whenever the viewer resolves a different mono font.
    const inv = runs.find((x) => x.invert);
    if (inv) {
      // The TUI inverts the WHOLE selected row, so one full-width bar is exact.
      body.push(`<rect x="${PAD}" y="${yTop}" width="${(COLS * CW).toFixed(1)}" height="${CH}" fill="${inv.fg}"/>`);
    }
    const spans = runs
      .map((run) => `<tspan fill="${run.invert ? BG : run.fg}"${run.bold ? ' font-weight="700"' : ''}>${esc(run.text)}</tspan>`)
      .join('');
    // Pin each line to its exact cell width with UNIFORM glyph scaling. Every
    // line scales by the same ratio (CW / the font's real advance), so the column
    // grid is preserved exactly while the frame always fits its declared width —
    // whatever monospace font the viewer happens to resolve.
    const cells = runs.reduce((n, r) => n + r.text.length, 0);
    const tl = ` textLength="${(cells * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs"`;
    body.push(`<text x="${PAD}" y="${y.toFixed(1)}"${tl} xml:space="preserve">${spans}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect width="${w}" height="${h}" rx="8" fill="${BG}"/>
<g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="14" xml:space="preserve">
${body.join('\n')}
</g>
</svg>
`;
}

/* ── render + write ───────────────────────────────────────────────────────── */

const shots: Array<[string, string[], string]> = [
  ['overview', renderScreen(ctx(view('overview'))), 'Overview — live node table, worst health first'],
  // Scrolled so the frame lands on the v0.22 sections that make Detail distinctive.
  ['detail', renderScreen(ctx(view('detail', { selected: 1, detailScroll: 15 }))), 'Detail — per-node dossier with live entity state and config parameters'],
  ['controller', renderScreen(ctx(view('controller'))), 'Controller — radio health, noise floor, counters'],
  ['topology', renderScreen(ctx(view('topology'))), 'Topology — hop-grouped route tree'],
  ['heatmap', renderScreen(ctx(view('heatmap'))), 'Heatmap — nodes by area, graded by SNR margin'],
  ['log', renderScreen(ctx(view('log'))), 'Log — driver events, value changes and command outcomes'],
  ['remedy', renderScreen(ctx(view('remedy'))), 'Remedy — engine diagnoses and ranked recommendations'],
  ['interference', renderScreen(ctx(view('interference'))), 'Interference — noise floor, serial health, diurnal heatmap'],
];

// The Actions Menu is a modal, not a screen — render it separately.
const menuItems = [
  ...buildMenu({ hasNode: true, rebuilding: false }),
  ...buildEntityRows([
    { entityId: 'light.kitchen_ceiling', domain: 'light', name: 'Kitchen Ceiling', state: 'on', attrs: {} },
    { entityId: 'lock.front_door', domain: 'lock', name: 'Front Door', state: 'locked', attrs: {} },
    { entityId: 'cover.garage_door', domain: 'cover', name: 'Garage Door', state: 'closed', attrs: {} },
  ]),
  ...buildConfigRows(PARAMS),
];
shots.push(['actions-menu',
  renderActionsMenu(view('overview'), { items: menuItems, index: menuItems.findIndex((i) => i.desc.label.startsWith('Unlock')), targetLabel: '#12 Kitchen Ceiling', locked: false }),
  'Actions Menu — mesh maintenance, device controls and configuration, all behind a typed CONFIRM']);

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, lines, title] of shots) {
  const file = resolve(OUT_DIR, `${name}.svg`);
  writeFileSync(file, toSvg(lines, title));
  console.log(`  wrote ${name}.svg  (${lines.length} rows)`);
}
console.log(`\n${shots.length} screenshots → ${OUT_DIR}`);
