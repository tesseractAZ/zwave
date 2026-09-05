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

/* ── v0.35: the detail pane stops discarding the friendly name ─────────────── */

test('the Entity row leads with the FRIENDLY name, id as the secondary', () => {
  // The name was captured on every value event and thrown away at the render.
  // A pane whose whole job is "which thing did this?" answered with a slug.
  const ev = mkEvent({
    kind: 'value', entityId: 'sensor.node_27_illuminance',
    entityName: 'Back Porch Motion · Illuminance', domain: 'sensor',
  });
  const line = renderLog(ctx({ view: mkView({ cols: 140, rows: 30 }), events: [ev], nodes: sampleNodes }))
    .map(strip).find((l) => /^\s*Entity/.test(l));
  assert.ok(line, 'the Entity row must render');
  assert.match(line!, /Back Porch Motion/, 'the name is what the operator recognises');
  assert.match(line!, /sensor\.node_27_illuminance/, 'the id stays — it is what you type into HA');
  assert.ok(line!.indexOf('Back Porch Motion') < line!.indexOf('sensor.node_27'),
    'name first: the id is the footnote, not the headline');
});

test('an event with NO captured name still shows the id — never a blank row', () => {
  const ev = mkEvent({ kind: 'value', entityId: 'switch.unnamed', domain: 'switch' });
  const line = renderLog(ctx({ view: mkView({ cols: 140, rows: 30 }), events: [ev], nodes: sampleNodes }))
    .map(strip).find((l) => /^\s*Entity/.test(l));
  assert.ok(line && /switch\.unnamed/.test(line), `id must survive: ${line}`);
});

test('at 80 columns the ID survives whole — the name yields, never the id (v0.35 review)', () => {
  // field() truncates blindly from the right, so leading with a long name
  // pushed the id past the cut — clipping `sensor.node_27_illumina…` into a
  // DIFFERENT plausible id. The id is what you type into HA; it must never be
  // mangled. When both cannot fit, the name is dropped, not the id's tail.
  const ev = mkEvent({
    kind: 'value', entityId: 'sensor.node_27_illuminance_lux_reading',
    entityName: 'Back Porch Motion · Illuminance (calibrated)', domain: 'sensor',
  });
  const line = renderLog(ctx({ view: mkView({ cols: 80, rows: 30 }), events: [ev], nodes: sampleNodes }))
    .map(strip).find((l) => /^\s*Entity/.test(l));
  assert.ok(line, 'the Entity row renders');
  assert.ok(line!.includes('sensor.node_27_illuminance_lux_reading'),
    `the FULL id must survive at 80 cols: ${JSON.stringify(line)}`);
});

test('on a WIDE frame both still fit and the name still leads', () => {
  const ev = mkEvent({
    kind: 'value', entityId: 'sensor.node_27_illuminance',
    entityName: 'Back Porch Motion', domain: 'sensor',
  });
  const line = renderLog(ctx({ view: mkView({ cols: 140, rows: 30 }), events: [ev], nodes: sampleNodes }))
    .map(strip).find((l) => /^\s*Entity/.test(l))!;
  assert.ok(line.indexOf('Back Porch Motion') < line.indexOf('sensor.node_27_illuminance'),
    'name first when it fits — the v0.35 behaviour is width-gated, not reverted');
});

test('an ENGINE-initiated write is attributed to the engine, never to the operator (v0.41)', () => {
  // Auto-ping logged through the operator sink, so every autonomous probe and
  // every give-up notice rendered as "operator" — an activity log claiming the
  // human did what the engine did. Provenance is the one thing it must not
  // fabricate.
  const ev = mkEvent({ ts: 700, kind: 'action', source: 'engine', nodeId: 3, text: 'node 3 probed' });
  const lines = renderLog(ctx({ view: mkView({ cols: 120, rows: 30, logCursor: 0 }), events: [ev], nodes: sampleNodes }));
  const joined = lines.map(strip).join('\n');
  const typeRow = lines.map(strip).find((l) => /Type/.test(l)) ?? '';
  assert.match(typeRow, /engine \(auto\)/, `an engine write says so: ${typeRow}`);
  assert.ok(!/operator/.test(typeRow), `and is never labelled operator: ${typeRow}`);
});

test('a clipped VALUE never reads as a different, complete value (v0.51.0)', () => {
  // The cardinal case: at the modal 80x24 a value change of `812 → 1240` came
  // back as `812 → 12`. Not a truncation an operator can SEE — a plausible
  // number, and the same frame's Detail row showed the true one, so the screen
  // contradicted itself. This is shedLine's whole-token rule (which stopped
  // `#23` clipping to the innocent `#2`) applied to a string with no tokens.
  const ev = mkEvent({
    ts: 1_000, kind: 'value', nodeId: 7,
    text: 'Garage Power Meter reported consumption: 812 → 1240 and the meter is still climbing',
    entityId: 'sensor.garage_power', entityName: 'Garage Power Meter',
  });
  const lines = renderLog(ctx({ events: [ev], nodes: [mkNode({ nodeId: 7, name: 'Garage Power Meter' })],
    view: mkView({ cols: 80, rows: 24 }) }));
  const joined = lines.map(strip).join('\n');
  const row = lines.map(strip).find((l) => /Garage Power Meter reported/.test(l)) ?? '';
  assert.ok(row, `the event row must render: ${joined.slice(0, 400)}`);
  // The row is short of the full text at 80 cols — that is fine. What is NOT
  // fine is ending mid-number with nothing saying so.
  if (!row.includes('1240')) {
    assert.ok(/…/.test(row), `a shortened row must carry the marker: "${row}"`);
    assert.ok(!/\b12\s*$/.test(row.replace(/…\s*$/, '')),
      `must not end on a truncated number that reads as complete: "${row}"`);
  }
  assertGeometry(lines, 80, 24, 'value clip');
});

test('the Detail pane spends its own blank rows before it drops text (v0.51.0)', () => {
  // Detail is the LAST field, so the rows the fixed fields left unused are its
  // own — and 3–5 of 9 sat blank while the tail of an action failure was cut at
  // W−10 with no marker. The list row above clips harder, and no key scrolls
  // either, so that tail existed NOWHERE on screen.
  const long = 'Failed to perform the action zwave_js.ping. Node 23 did not acknowledge the command '
    + 'and the controller reported a transmit failure after three attempts on route 1-14-23.';
  const lines = renderLog(ctx({
    events: [mkEvent({ ts: 1_000, kind: 'action', source: 'you', nodeId: 23, severity: 'error', text: long })],
    nodes: [mkNode({ nodeId: 23, name: 'Back Door' })],
    view: mkView({ cols: 80, rows: 24 }),
  }));
  // Normalise the wrap indent — the point is the text SURVIVES, on whatever row.
  const joined = lines.map(strip).join(' ').replace(/\s+/g, ' ');
  assert.match(joined, /did not acknowledge the command/, `the pane must wrap, not clip: ${joined}`);
  // Anything still dropped must be disclosed, never silently cut.
  const detailIdx = lines.findIndex((l) => /Detail/.test(strip(l)));
  assert.ok(detailIdx >= 0, 'a Detail row must exist');
  const tail = lines.slice(detailIdx).map(strip).join(' ').replace(/\s+/g, ' ');
  if (!tail.includes('route 1-14-23')) {
    assert.match(tail, /\+\d+/, `an incomplete Detail must carry "+N": ${tail}`);
  }
  assertGeometry(lines, 80, 24, 'detail wrap');
});

test('the event count carries the window it was observed over (v0.51.0)', () => {
  // The ring drops its tail at LOG_MAX with no counter and no marker, so
  // `247 EVENTS · LAST 7 DAYS` read as one claim when it is two: the label is
  // what was ASKED for, the count is over whatever the ring still holds.
  const now = Date.now();
  const lines = renderLog(ctx({
    events: [mkEvent({ ts: now - 3_600_000, kind: 'system', nodeId: null, text: 'oldest' }),
             mkEvent({ ts: now - 1_000, kind: 'system', nodeId: null, text: 'newest' })],
    view: mkView({ cols: 120, rows: 30 }),
  }));
  const joined = lines.map(strip).join('\n');
  assert.match(joined, /2 EVENTS\/\S+/, `the count must carry its observed span: ${joined.slice(0, 300)}`);
});

test('a Detail too long even for its own slack discloses the remainder (v0.51.0)', () => {
  // Wrapping into the blank rows buys a lot, but not everything: sanitizeEventText
  // caps at 300 chars and a narrow pane can still run out. Running out is fine.
  // Running out SILENTLY is the defect - the same rule shedLine applies.
  const long = Array.from({ length: 60 }, (_, i) => `clause${i}`).join(' and then ');
  const lines = renderLog(ctx({
    events: [mkEvent({ ts: 1_000, kind: 'action', source: 'you', nodeId: 3, severity: 'error', text: long })],
    nodes: [mkNode({ nodeId: 3, name: 'Kitchen' })],
    view: mkView({ cols: 60, rows: 24 }),
  }));
  const detailIdx = lines.findIndex((l) => /Detail/.test(strip(l)));
  assert.ok(detailIdx >= 0, 'a Detail row must exist');
  // EXCLUDE the command bar. It sheds its own keycaps with "+N", so a naive
  // slice-to-end passes whether or not the Detail pane discloses anything —
  // the first version of this test did exactly that and a mutant caught it.
  const pane = lines.slice(detailIdx)
    .map(strip)
    .filter((l) => !/\[[^\]]+\]\s/.test(l) && !/SCREENS|CLOSE/.test(l));
  const tail = pane.join(' ');
  assert.match(tail, /\+\d+/, `an over-long Detail must disclose "+N" in the PANE: ${tail}`);
  assertGeometry(lines, 60, 24, 'detail overflow');
});
