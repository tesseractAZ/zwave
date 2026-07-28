import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLog } from '../src/telnet/screens/log';
import { visLen } from '../src/telnet/ansi';
import type { ScreenCtx } from '../src/types';
import { anchorAt, mkEvent, mkNode, mkView, mockData } from './_logHelpers';

function ctx(over: Partial<ScreenCtx> & { events?: any[]; nodes?: any[] } = {}): ScreenCtx {
  const data = mockData({ events: over.events, nodes: over.nodes });
  return { view: over.view ?? mkView(), data, visibleNodes: [] };
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function assertGeometry(lines: string[], cols: number, rows: number, label: string) {
  assert.equal(lines.length, rows, `${label}: expected ${rows} rows, got ${lines.length}`);
  for (const l of lines) assert.ok(visLen(l) <= cols, `${label}: line exceeds ${cols} cols: "${strip(l)}"`);
  for (const l of lines) assert.ok(!strip(l).includes('undefined'), `${label}: leaked "undefined": "${strip(l)}"`);
}

const sampleEvents = [
  mkEvent({ ts: 1_000, kind: 'value', nodeId: 7, text: 'Garage Motion: clear → detected', entityId: 'binary_sensor.garage_motion', entityName: 'Garage Motion', domain: 'binary_sensor', oldState: 'clear', newState: 'detected' }),
  mkEvent({ ts: 900, kind: 'status', nodeId: 3, severity: 'error', text: 'Kitchen → dead' }),
  mkEvent({ ts: 800, kind: 'route', nodeId: 7, text: 'route → controller' }),
  mkEvent({ ts: 700, kind: 'action', source: 'you', nodeId: 3, text: 'ping ok (31 ms)' }),
  mkEvent({ ts: 600, kind: 'system', nodeId: null, text: 'activity feed live — watching 272 device entities' }),
];
const sampleNodes = [mkNode({ nodeId: 7, name: 'Garage Motion', area: 'outside' }), mkNode({ nodeId: 3, name: 'Kitchen', area: 'kitchen' })];

test('renders EXACTLY view.rows lines, each within view.cols, at many sizes', () => {
  for (const [cols, rows] of [[80, 24], [120, 46], [60, 16], [200, 50], [72, 22], [100, 21]] as const) {
    const lines = renderLog(ctx({ view: mkView({ cols, rows }), events: sampleEvents, nodes: sampleNodes }));
    assertGeometry(lines, cols, rows, `${cols}x${rows}`);
  }
});

test('detail pane appears only when the terminal is tall enough (>=22 rows)', () => {
  const tall = renderLog(ctx({ view: mkView({ cols: 100, rows: 30 }), events: sampleEvents, nodes: sampleNodes })).map(strip).join('\n');
  assert.ok(/Device/.test(tall) && /Entity/.test(tall), 'tall terminal shows the detail pane');
  const short = renderLog(ctx({ view: mkView({ cols: 100, rows: 18 }), events: sampleEvents, nodes: sampleNodes })).map(strip).join('\n');
  assert.ok(!/Device\s/.test(short), 'short terminal hides the detail pane');
});

test('the selected row carries the ▶ cursor and the header counts events + shows the range', () => {
  const lines = renderLog(ctx({ view: mkView({ cols: 120, rows: 30, logCursor: 1 }), events: sampleEvents, nodes: sampleNodes }));
  const joined = lines.map(strip).join('\n');
  assert.ok(joined.includes('▶'), 'a cursor marker is present');
  assert.ok(/ACTIVITY LOG/.test(joined) && /5 EVENTS/i.test(joined), 'title rule shows the count');
  assert.ok(/ALL TIME/i.test(joined), 'title rule shows the active date range');
});

test('the detail pane reflects the selected event: device, entity, and value change', () => {
  const lines = renderLog(ctx({ view: mkView({ cols: 120, rows: 30, logCursor: 0 }), events: sampleEvents, nodes: sampleNodes }));
  const joined = lines.map(strip).join('\n');
  assert.ok(/#7 Garage Motion/.test(joined), 'device line names the node');
  assert.ok(/binary_sensor\.garage_motion/.test(joined), 'entity id shown');
  assert.ok(/clear .* detected/.test(joined), 'old → new value shown');
});

test('errorsOnly header chip + filtered detail (only the error event remains)', () => {
  const lines = renderLog(ctx({ view: mkView({ cols: 120, rows: 30, errorsOnly: true }), events: sampleEvents, nodes: sampleNodes }));
  const joined = lines.map(strip).join('\n');
  assert.ok(/ERRORS/i.test(joined), 'title rule shows the errors chip');
  assert.ok(/1 EVENT/i.test(joined), 'only the 1 error is counted');
  assert.ok(/Kitchen/.test(joined) && !/Garage Motion:/.test(joined), 'non-error rows are filtered out');
});

test('empty ring shows the waiting-for-activity state, still exact geometry', () => {
  for (const [cols, rows] of [[80, 24], [60, 16]] as const) {
    const lines = renderLog(ctx({ view: mkView({ cols, rows }), events: [], nodes: [] }));
    assertGeometry(lines, cols, rows, `empty ${cols}x${rows}`);
    assert.ok(/Waiting for activity/.test(lines.map(strip).join('\n')));
  }
});

test('filtered-to-empty shows the no-match hint (not the waiting state)', () => {
  const lines = renderLog(ctx({ view: mkView({ cols: 100, rows: 24, errorsOnly: true, logRange: 'yesterday' }), events: [mkEvent({ ts: Date.now(), severity: 'info' })] }));
  const joined = lines.map(strip).join('\n');
  assert.ok(/No events match/.test(joined), 'shows the no-match hint');
  assert.ok(!/Waiting for activity/.test(joined));
});

test('the sticky window follows a deep cursor and logScroll is stable across frames', () => {
  const events = Array.from({ length: 40 }, (_, i) => mkEvent({ ts: 5_000 - i, seq: 5_000 - i, text: `e${i}`, nodeId: 7 }));
  const nodes = [mkNode({ nodeId: 7 })];
  const view = mkView({ cols: 100, rows: 24 });
  anchorAt(view, events, 35); // deep, near the oldest
  const data = mockData({ events, nodes });

  const joined = renderLog({ view, data, visibleNodes: [] }).map(strip);
  const cursorRow = joined.findIndex((l) => l.includes('▶'));
  assert.ok(cursorRow > 0, 'the cursor row is visible within the window');
  assert.ok(joined[cursorRow].includes('e35'), 'the ▶ row shows the anchored event');
  assert.ok(view.logScroll > 0, 'the window scrolled down to follow the deep cursor');

  const scroll1 = view.logScroll;
  renderLog({ view, data, visibleNodes: [] });
  assert.equal(view.logScroll, scroll1, 'the sticky window start is stable on the next frame');
});

test('a very narrow terminal still holds the geometry contract', () => {
  const lines = renderLog(ctx({ view: mkView({ cols: 40, rows: 24 }), events: sampleEvents, nodes: sampleNodes }));
  assertGeometry(lines, 40, 24, 'narrow');
});
