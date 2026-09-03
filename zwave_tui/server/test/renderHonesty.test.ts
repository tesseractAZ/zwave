/**
 * v0.24 — render-honesty regressions.
 *
 * Every case here encodes a specific way the TUI was previously WRONG rather
 * than merely ugly: a control it advertised but had dropped, a number it had
 * clipped into a different number, a colour that meant "healthy" on a dead
 * node, a scale derived from data that was not on screen. Degrading under a
 * narrow terminal is fine; degrading into a plausible lie is not.
 *
 * The width sweeps run 60..200 columns because 80 is the DEFAULT (session.ts
 * falls back to `?? 80`) and the old bugs were invisible at the 120+ widths
 * the other screen tests happen to use.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { c, lr, truncate, visLen } from '../src/telnet/ansi';
import { commandBar, fieldStrip, titleRule, frame, masthead } from '../src/telnet/chrome';
import { brailleSparkline, litBars, meter, signalBars, sparkline, fmtElapsed, spinner, chartRows } from '../src/telnet/gauges';
import { marginColor, noiseColor, rssiColor, rttColor, timeoutPctColor } from '../src/telnet/bands';
import { WEAK_MARGIN_DB } from '../src/zwave/health';
import { renderOverview } from '../src/telnet/screens/overview';
import { renderDetail } from '../src/telnet/screens/detail';
import { renderTopology } from '../src/telnet/screens/topology';
import { renderRemedy } from '../src/telnet/screens/remedy';
import { renderInterference } from '../src/telnet/screens/interference';
import { renderLogin } from '../src/telnet/screens/login';
import { renderLog } from '../src/telnet/screens/log';
import { createZwaveData } from '../src/zwave/zwaveData';
import { renderHeatmap } from '../src/telnet/screens/heatmap';
import { sortedSymptoms } from '../src/telnet/screens/remedy';
import { applyKey } from '../src/telnet/input';
import { NodeStatus } from '../src/types';
import type { ScreenCtx, ViewState } from '../src/types';
import { mkNode, mkView, mockData } from './_logHelpers';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/* ── shared chrome: keycaps are atomic ─────────────────────────────────── */

const KEYS = [
  ['1-9', 'SCREENS'], ['↑↓', 'NAV'], ['⏎', 'INSPECT'], ['A', 'ACTIONS', 1],
  ['/', 'FILTER', 2], ['S', 'SORT', 3], ['T', 'UNITS', 4], ['Q', 'EXIT'],
] as const;

test('commandBar never cuts a keycap in half, at any width', () => {
  for (let cols = 20; cols <= 200; cols++) {
    const bar = strip(commandBar(mkView({ cols }), KEYS));
    assert.ok(visLen(bar) <= cols, `overflows at ${cols}`);
    // Every '[' must have a matching ']' AFTER it, and every cap that opened
    // must have kept its label — no dangling bracket, no half word.
    const opens = (bar.match(/\[/g) ?? []).length;
    const closes = (bar.match(/\]/g) ?? []).length;
    assert.equal(opens, closes, `unmatched bracket at cols=${cols}: ${bar}`);
    assert.ok(!/\[[^\]]*$/.test(bar), `bar ends inside a keycap at cols=${cols}: ${bar}`);
  }
});

test('commandBar keeps the protected caps and discloses what it dropped', () => {
  // 80 columns is the default terminal: the full bar is 99 cells, so caps must
  // be sacrificed. [Q] EXIT and [1-9] SCREENS are the way OUT — never droppable.
  const bar = strip(commandBar(mkView({ cols: 80 }), KEYS));
  assert.ok(bar.includes('[Q] EXIT'), `lost the exit key: ${bar}`);
  assert.ok(bar.includes('[1-9] SCREENS'), `lost the screen keys: ${bar}`);
  assert.match(bar, /\+\d+$/, `dropped caps silently: ${bar}`);
  // Least-valuable first: UNITS goes before ACTIONS.
  assert.ok(!bar.includes('UNITS'), `dropped the wrong cap first: ${bar}`);
});

test('commandBar never collapses to an empty row while caps remain', () => {
  // Every cap droppable: the sacrifice loop must stop before emptying the list,
  // or the bar vanishes entirely and the screen loses its only affordance.
  const allDroppable = [['A', 'ALPHA', 1], ['B', 'BRAVO', 2], ['C', 'CHARLIE', 3]] as const;
  for (let cols = 4; cols <= 40; cols++) {
    const bar = strip(commandBar(mkView({ cols }), allDroppable));
    assert.ok(visLen(bar) <= cols, `overflows at ${cols}`);
    assert.ok(bar.length > 0, `collapsed to nothing at cols=${cols}`);
    assert.ok(bar.includes('[A]'), `lost the last key at cols=${cols}: ${bar}`);
  }
  // An empty keys array is the one legitimate empty bar.
  assert.equal(strip(commandBar(mkView({ cols: 40 }), [])), '');
});

test('commandBar honours the caller reserve so an appended token still fits', () => {
  const view = mkView({ cols: 80 });
  const counter = ' (12–28/39)';
  const bar = commandBar(view, KEYS, visLen(counter));
  assert.ok(visLen(bar) + visLen(counter) <= 80, 'bar + counter overruns the row');
});

test('fieldStrip emits only WHOLE fields, and as many as fit', () => {
  const fields = ['NODES 39', 'ALIVE 35', 'DEAD 1', 'NOISE -92 dBm', 'MESH ABCDEF'];
  const GUTTER = 4;
  let sawPartial = 0;
  // Starts at 1: the sweep must include the widths where NOT EVEN ONE whole
  // field fits, which is exactly where a partial-field fallback would hide.
  for (let cols = 1; cols <= 120; cols++) {
    const out = strip(fieldStrip(mkView({ cols }), fields));
    assert.ok(visLen(out) <= cols, `overflows at ${cols}`);

    // Strip the "+N dropped" marker, then every remaining field must be one of
    // the originals VERBATIM — a half field like "NOISE -92 d" is the defect.
    const body = out.replace(/\s*\+\d+\s*$/, '').replace(/\s+$/, '');
    // Legal ONLY as "nothing fits": either empty, or the bare "+N" count.
    if (body.trim() === '') {
      sawPartial++;
      assert.ok(out === '' || /^\+\d+$/.test(out.trim()),
        `emitted a partial field at cols=${cols}: ${JSON.stringify(out)}`);
      continue;
    }
    const parts = body.split(' '.repeat(GUTTER)).filter((x) => x !== '');
    for (const part of parts) {
      assert.ok(fields.includes(part), `partial field at cols=${cols}: ${JSON.stringify(part)} in ${JSON.stringify(out)}`);
    }
    // Prefix property: fields are dropped from the END, never from the middle.
    assert.deepEqual(parts, fields.slice(0, parts.length), `dropped out of order at cols=${cols}`);
    // Honesty: if anything was dropped the count must be disclosed and correct.
    const marker = /\+(\d+)\s*$/.exec(out);
    const dropped = fields.length - parts.length;
    if (dropped > 0) {
      // The marker costs ~3 columns; below that a whole field alone is the best
      // available answer (a partial field would still be worse).
      const roomForMarker = cols >= visLen(parts.join(' '.repeat(GUTTER))) + 3;
      if (roomForMarker) {
        assert.ok(marker, `dropped ${dropped} fields silently at cols=${cols}: ${out}`);
      }
      if (marker) assert.equal(Number(marker[1]), dropped, `wrong dropped count at cols=${cols}`);
    }
    // Not lazy: at the full width every field must be present.
    if (cols >= 120) assert.equal(parts.length, fields.length, 'dropped fields that fit');
  }
  // Guard against the whole loop degenerating into the empty-output branch.
  // The first field is 8 cells, so widths 1..7 legitimately fit nothing.
  assert.ok(sawPartial <= 8, `fieldStrip gave up at ${sawPartial} widths — too many`);
});

test('titleRule keeps the right-hand status token, shortening the title instead', () => {
  const right = c.yellow('“kitchen”');
  for (let cols = 24; cols <= 120; cols++) {
    const out = strip(titleRule(mkView({ cols }), 'TOPOLOGY / ROUTES', right));
    assert.ok(visLen(out) <= cols);
    assert.ok(out.includes('kitchen'), `buried the status at cols=${cols}: ${out}`);
  }
});

test('frame discloses body rows it could not fit', () => {
  const view = mkView({ cols: 80, rows: 10 });
  const body = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  const out = frame(view, mockData(), { title: 'X', body, keys: [['Q', 'BACK']] });
  assert.equal(out.length, 10);
  const joined = strip(out.join('\n'));
  assert.match(joined, /more lines? hidden/, 'silently dropped body rows');
});

/* ── ansi primitives ───────────────────────────────────────────────────── */

test('lr protects the right operand when space is short', () => {
  // The value is what the operator reads; the label is inferable.
  const out = strip(lr('messages TX', '1234567890', 19));
  assert.ok(out.includes('1234567890'), `clipped the value: ${out}`);
  assert.ok(visLen(out) <= 19);
});

test('visLen and truncate refuse to let control bytes into a frame', () => {
  const nasty = 'ok\nsplit\rback\x07bell';
  assert.equal(visLen(nasty), 'oksplitbackbell'.length);
  const out = truncate(nasty, 100);
  assert.ok(!/[\x00-\x1f\x7f]/.test(strip(out)), `control byte survived: ${JSON.stringify(out)}`);
});

/* ── gauges ────────────────────────────────────────────────────────────── */

test('meter reserves full/empty for the real endpoints', () => {
  const full = (s: string): number => (strip(s).match(/█/g) ?? []).length;
  assert.equal(full(meter(1, 10)), 10, '100% must fill');
  assert.equal(full(meter(0, 10)), 0, '0% must be empty');
  assert.ok(full(meter(0.94, 10)) < 10, '94% must not read as complete');
  assert.ok(full(meter(0.05, 10)) > 0, '5% must not read as nothing');
});

test('signalBars lights exactly the right number of bars', () => {
  // Inequality alone is far too weak: "light ALL bars for any nonzero signal"
  // satisfies it while telling the operator a -95 dBm link is full strength —
  // the inverse of the lie being fixed. Pin the count.
  const cases: [number, number][] = [
    [0, 0],       // genuinely no signal — and ONLY this lights nothing
    [0.01, 1],    // barely present must still show one bar…
    [0.1, 1],     // …including everything Math.round used to floor to zero
    [0.3, 1],
    [0.4, 2],
    [0.6, 2],
    [0.7, 3],
    [1, 4],
  ];
  for (const [frac, want] of cases) {
    assert.equal(litBars(frac, 4), want, `litBars(${frac}) should light ${want}`);
  }
  // The rendered form must agree with the count, and the plain (inverse-video)
  // twin used for the selected row must agree with BOTH.
  for (const [frac, want] of cases) {
    const rendered = signalBars(frac, 4);
    const litGlyphs = (rendered.match(/\x1b\[(?!90m)[0-9;]*m[▁▃▅▇]/g) ?? []).length;
    assert.equal(litGlyphs, want, `signalBars(${frac}) coloured ${litGlyphs} bars, expected ${want}`);
  }
});

test('sparkline scales to the samples it DRAWS, not to off-screen history', () => {
  // One huge spike long since scrolled off must not flatten the visible trend.
  const values = [1000, ...Array.from({ length: 8 }, (_, i) => 10 + i)];
  const drawn = strip(sparkline(values, 8));
  assert.ok(new Set(drawn).size > 1, `visible rise flattened by an off-screen spike: ${drawn}`);
});

test('brailleSparkline paints a steady series as steady, not as critical', () => {
  const flat = brailleSparkline([5, 5, 5, 5, 5, 5], 3);
  assert.ok(!flat.includes('\x1b[91m') && !flat.includes('\x1b[1;91m'), 'flat series alarmed red');
});

test('fmtElapsed and spinner never leak NaN into a frame', () => {
  assert.equal(fmtElapsed(Number.NaN), '—');
  assert.ok(!fmtElapsed(Number.POSITIVE_INFINITY).includes('NaN'));
  assert.ok(spinner(Number.NaN).length === 1);
  assert.ok(spinner(-1).length === 1);
});

/* ── bands are shared, so one value has one colour ─────────────────────── */

test('a red SNR margin always implies the node carries a W flag', () => {
  // These were independent constants (10 in bands.ts, 7 in health.ts) and
  // drifted, so three screens painted 7-9 dB red while the score, the flag
  // legend and the health model all called it fine. bands.ts now derives its
  // cut from WEAK_MARGIN_DB; this fails if either side is edited alone.
  const isRed = (fn: (s: string) => string): boolean =>
    fn === c.red || fn === c.redB;
  for (let db = -20; db <= 30; db++) {
    if (isRed(marginColor(db))) {
      assert.ok(db < WEAK_MARGIN_DB,
        `margin ${db} dB renders red but is at or above WEAK_MARGIN_DB (${WEAK_MARGIN_DB}) — no W flag`);
    }
  }
  // And the boundary is exactly the flag's, not merely below it.
  assert.notEqual(marginColor(WEAK_MARGIN_DB - 1), c.yellow, 'the band is stricter than the flag');
  assert.equal(marginColor(WEAK_MARGIN_DB), c.yellow, 'the band is looser than the flag');
});

test('the shared bands pin exact thresholds (not just an ordering)', () => {
  // Comparing a band function to ITSELF proves nothing, and a monotonicity
  // check passes for a constant function. Assert the cut points directly, on
  // both sides of every boundary, so a silent threshold drift fails here.
  const cases: [string, (n: number) => unknown, [number, unknown][]][] = [
    ['rtt', rttColor, [[0, c.green], [99, c.green], [100, c.white], [499, c.white],
                       [500, c.yellow], [999, c.yellow], [1000, c.red], [9999, c.red]]],
    ['timeout%', timeoutPctColor, [[0, c.green], [0.99, c.green], [1, c.white], [2.99, c.white],
                                   [3, c.yellow], [7.99, c.yellow], [8, c.red], [100, c.red]]],
    // The red cut is DERIVED from health.ts's WEAK_MARGIN_DB (7) so that a red
    // margin always implies the node carries a W flag. 7-9 dB used to render
    // red while the health model called it fine.
    ['margin', marginColor, [[40, c.green], [17, c.green], [16, c.yellow], [10, c.yellow],
                             [7, c.yellow], [6, c.red], [3, c.red], [2, c.redB], [-20, c.redB]]],
    ['rssi', rssiColor, [[-40, c.green], [-70, c.green], [-71, c.yellow],
                         [-88, c.yellow], [-89, c.red]]],
    ['noise', noiseColor, [[-70, c.red], [-75, c.red], [-76, c.yellow],
                           [-85, c.yellow], [-86, c.grey]]],
  ];
  for (const [name, fn, pairs] of cases) {
    for (const [value, want] of pairs) {
      assert.equal(fn(value), want, `${name}(${value}) landed in the wrong band`);
    }
  }
  // Non-finite input must never colour as if it were a real reading.
  for (const [, fn] of cases) assert.equal(fn(Number.NaN), c.grey);
});

test('the selected row lights the same bars as every other row', () => {
  // `barsPlain` is the SGR-free twin used inside the inverse-video selected
  // row. It is module-private, so the only way to observe it is to read the
  // glyphs out of that row — which is why the weak-signal floor was added to
  // signalBars and silently missed here.
  // The two forms represent UNLIT bars differently — signalBars uses grey
  // glyphs, barsPlain uses spaces — so raw glyph counts are not comparable.
  // Count the LIT ones in each representation.
  const BAR = /[▁▃▅▇]/g;
  const litPlain = (row: string): number => (strip(row).match(BAR) ?? []).length;
  const litColoured = (row: string): number =>
    // A bar glyph is lit unless the SGR immediately before it is grey (90m).
    (row.match(/\x1b\[([0-9;]*)m[▁▃▅▇]/g) ?? []).filter((m) => !/\[90m/.test(m)).length;
  // -99 dBm against the assumed -95 floor is a NEGATIVE margin — a link barely
  // decoding. This is the band where the two rules disagree (verified against
  // the real bandFrac, whose ramp is piecewise, not linear): the plain form's
  // bare Math.round yields 0 lit bars here while litBars() floors at 1. A
  // stronger reading rounds to 1 under both rules and would not discriminate,
  // which is exactly how the first version of this test passed a broken twin.
  const weak = { ...mkNode().stats, rssi: -99 };
  const a = mkNode({ nodeId: 3, name: 'Weak A', stats: weak });
  const b = mkNode({ nodeId: 4, name: 'Weak B', stats: weak });

  const rows0 = renderOverview(ctxFor([a, b], { selected: 0, cols: 140 }));
  const selected = rows0.find((r) => r.includes('\x1b[7m'));
  const unselected = rows0.find((r) => strip(r).includes('Weak B'));
  assert.ok(selected && unselected, 'both rows must render');

  assert.equal(litPlain(selected), litColoured(unselected),
    'the selected row lights a different number of bars than the identical node beside it');
  assert.ok(litPlain(selected) > 0, 'a present-but-weak signal rendered as no signal at all');
  assert.ok(litColoured(unselected) > 0, 'control: the unselected row lit nothing either');
});

/* ── screens: a dead node must not look alive ──────────────────────────── */

function ctxFor(nodes: ReturnType<typeof mkNode>[], view: Partial<ViewState> = {}): ScreenCtx {
  const data = mockData({ nodes });
  const v = mkView({ screen: 'overview', cols: 120, rows: 24, ...view });
  return { view: v, data, visibleNodes: nodes, filtering: false } as ScreenCtx;
}

test('a DEAD node renders no health-green RF telemetry', () => {
  // The dead node must NOT be the selected row: the selected row is drawn from
  // the plain, SGR-free record and wrapped in inverse video, so it carries no
  // colour at all and the assertion below could not fail for any implementation.
  const alive = mkNode({
    nodeId: 8, name: 'Kitchen Lamp', status: NodeStatus.Alive, statusLabel: 'alive',
    stats: { ...mkNode().stats, rtt: 20, rssi: -55 },
  });
  const deadNode = mkNode({
    nodeId: 9, name: 'Garage Sensor', status: NodeStatus.Dead, statusLabel: 'dead',
    // Identical healthy-looking telemetry, so ONLY the status can explain a
    // difference in how the two rows are coloured.
    stats: { ...mkNode().stats, rtt: 20, rssi: -55, commandsTX: 100, commandsRX: 100 },
  });
  // The cursor sits on a THIRD node so neither row under test is the selected
  // (inverse-video, SGR-free) one.
  const spare = mkNode({ nodeId: 7, name: 'Spare Node' });
  const ctx = ctxFor([alive, deadNode, spare], { selected: 2 });
  const rows = renderOverview(ctx);
  const deadRow = rows.find((r) => strip(r).includes('Garage Sensor'));
  const aliveRow = rows.find((r) => strip(r).includes('Kitchen Lamp'));
  assert.ok(deadRow && aliveRow, 'both nodes must be on the roster');

  // Control: the healthy row must carry health-green on an RF CELL, not merely
  // on its status glyph — otherwise the control passes while the RF colouring
  // under test is never exercised. The RTT cell is the cleanest witness: both
  // nodes have rtt 20, so only the status can explain a difference.
  const greenRtt = /\x1b\[92m20\s*ms|\x1b\[92m20ms/;
  assert.ok(greenRtt.test(aliveRow) || /\x1b\[92m/.test(aliveRow.split('Kitchen Lamp')[1] ?? ''),
    'fixture never coloured an RF cell — the assertion below would be vacuous');
  assert.ok(aliveRow.includes('\x1b[92m') || aliveRow.includes('\x1b[1;92m'),
    'fixture never reached the coloured path at all');
  // Green is the "measured, good, now" colour. A node that stopped answering
  // has no such reading — its cells are history.
  assert.ok(!deadRow.includes('\x1b[92m') && !deadRow.includes('\x1b[1;92m'),
    `dead node row carries health-green: ${JSON.stringify(deadRow)}`);
});

test('a routed node is not graded on its repeater’s last-hop RSSI', () => {
  const routed = mkNode({
    nodeId: 4, name: 'Back Bedroom',
    stats: { ...mkNode().stats, rssi: -50, lwr: { repeaters: [3, 8], rssi: -50, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const rows = renderTopology(ctxFor([routed], { screen: 'topology' }));
  const row = rows.find((r) => strip(r).includes('Back Bedroom'));
  assert.ok(row, 'routed node missing');
  // The margin itself must be neutral grey (\x1b[90m), not health-graded: it
  // describes the n8→controller hop, not Back Bedroom's own link.
  const m = /\x1b\[(\d+)m\+45dB/.exec(row);
  assert.ok(m, `expected the last-hop margin on the row: ${JSON.stringify(row)}`);
  assert.equal(m[1], '90', `last-hop reading graded as the device’s own signal: ${JSON.stringify(row)}`);
  assert.ok(row.includes('est'), 'assumed noise floor not marked');
});

/* ── screens: every width keeps a way out ──────────────────────────────── */

test('every screen keeps its exit key at every supported width', () => {
  const nodes = [mkNode({ nodeId: 3 }), mkNode({ nodeId: 8, name: 'Kitchen Lamp' })];
  const screens: [string, (ctx: ScreenCtx) => string[]][] = [
    ['overview', renderOverview],
    ['detail', renderDetail],
    ['topology', renderTopology],
    ['heatmap', renderHeatmap],
  ];
  for (const [name, render] of screens) {
    for (let cols = 60; cols <= 200; cols += 7) {
      const ctx = ctxFor(nodes, { screen: name as ViewState['screen'], cols, rows: 24 });
      const rows = render(ctx);
      assert.equal(rows.length, 24, `${name} broke the exact-rows contract at ${cols}`);
      for (const r of rows) {
        assert.ok(visLen(r) <= cols, `${name} row overflows at ${cols}: ${JSON.stringify(r)}`);
      }
      const bar = strip(rows[rows.length - 1]);
      assert.ok(bar.includes('[Q]'), `${name} has no advertised exit at cols=${cols}: ${bar}`);
      assert.ok(!/\[[^\]]*$/.test(bar), `${name} bar ends mid-keycap at cols=${cols}: ${bar}`);
    }
  }
});

/* ── input: advertised keys actually work ──────────────────────────────── */

test('the uppercase keycaps the command bars advertise are really bound', () => {
  const data = mockData({ nodes: [mkNode()] });
  const press = (view: ViewState, ch: string) => applyKey(view, { type: 'char', ch }, data, () => {});

  const v1 = mkView({ screen: 'overview', signalDisplay: 'margin' });
  press(v1, 'T');
  assert.equal(v1.signalDisplay, 'dbm', '[T] UNITS is advertised but not bound');

  const v2 = mkView({ screen: 'overview', sortKey: 'health' });
  press(v2, 'S');
  assert.notEqual(v2.sortKey, 'health', '[S] SORT is advertised but not bound');

  const v3 = mkView({ screen: 'log', errorsOnly: false, logCursor: 7, logAnchorSeq: 42 });
  press(v3, 'O');
  assert.equal(v3.errorsOnly, true, '[O] ERRORS is advertised but not bound');
  // Uppercase must take the SAME path as lowercase, which also resets the
  // cursor and anchor — otherwise the filter changes under a stale selection.
  assert.equal(v3.logCursor, 0, '[O] skipped the Log cursor reset that [o] performs');
  assert.equal(v3.logAnchorSeq, null, '[O] skipped the Log anchor reset that [o] performs');

  const v4 = mkView({ screen: 'log', logRange: 'all' });
  press(v4, 'D');
  assert.notEqual(v4.logRange, 'all', '[D] DATE is advertised but not bound');
});

test('the Log errors-only filter cannot be armed from another screen', () => {
  const data = mockData({ nodes: [mkNode()] });
  // BOTH cases, from every screen that is not the Log — the command bars
  // advertise the uppercase spelling, so testing only lowercase left half the
  // scoping fix unverified.
  for (const screen of ['overview', 'detail', 'topology', 'heatmap', 'controller', 'remedy'] as const) {
    for (const ch of ['o', 'O']) {
      const view = mkView({ screen, errorsOnly: false });
      applyKey(view, { type: 'char', ch }, data, () => {});
      assert.equal(view.errorsOnly, false,
        `'${ch}' on ${screen} armed a filter on a screen not being viewed`);
    }
  }
});

test('Topology marks dead, unknown, asleep and alive distinctly', () => {
  const nodes = [
    mkNode({ nodeId: 3, name: 'Alive One' }),
    mkNode({ nodeId: 9, name: 'Dead One', status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 11, name: 'Unknown One', status: NodeStatus.Unknown, statusLabel: 'unknown' }),
    mkNode({ nodeId: 12, name: 'Asleep One', status: NodeStatus.Asleep, statusLabel: 'asleep' }),
  ];
  const rows = renderTopology(ctxFor(nodes, { screen: 'topology', cols: 120, rows: 30 })).map(strip);
  const markOf = (name: string): string => {
    const line = rows.find((r) => r.includes(name));
    assert.ok(line, `${name} missing from the tree`);
    return line.trim()[0];
  };
  const marks = {
    alive: markOf('Alive One'), dead: markOf('Dead One'),
    unknown: markOf('Unknown One'), asleep: markOf('Asleep One'),
  };
  assert.equal(marks.dead, '✕', `dead mark wrong: ${JSON.stringify(marks)}`);
  // Unknown means "never contacted", not "confirmed unreachable" — and is the
  // fallback whenever HA omits a status, so conflating them asserts a dead node
  // on no evidence.
  assert.equal(marks.unknown, '○', `unknown mark wrong: ${JSON.stringify(marks)}`);
  assert.equal(marks.asleep, '◐', `asleep mark wrong: ${JSON.stringify(marks)}`);
  assert.equal(marks.alive, '●', `alive mark wrong: ${JSON.stringify(marks)}`);
  assert.equal(new Set(Object.values(marks)).size, 4, 'two states share a mark');
});

/* ── the three remaining HIGH audit findings ───────────────────────────── */

test('the Topology route tree can scroll to its deepest groups', () => {
  // Ordered shallowest-first, so a fixed window from index 0 always kept the
  // many healthy "direct" rows and always cut the Long-Range and route-pending
  // groups — the anomalies the screen exists to surface.
  const nodes = [
    ...Array.from({ length: 21 }, (_, i) => mkNode({
      nodeId: 10 + i, name: `Direct ${i}`,
      stats: { ...mkNode().stats, lwr: { repeaters: [], rssi: -60, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
    })),
    ...Array.from({ length: 5 }, (_, i) => mkNode({
      nodeId: 90 + i, name: `Pending ${i}`, stats: { ...mkNode().stats, lwr: null },
    })),
  ];
  const ctx = ctxFor(nodes, { screen: 'topology', cols: 104, rows: 22 });
  const seen = (rows: string[], s: string): boolean => rows.some((r) => strip(r).includes(s));

  assert.ok(!seen(renderTopology(ctx), 'Route pending'), 'fixture too small to overflow');
  // 'G' asks for the end; the renderer clamps and writes the real value back.
  ctx.view.topologyScroll = Number.MAX_SAFE_INTEGER;
  const end = renderTopology(ctx);
  assert.ok(seen(end, 'Route pending'), 'deep groups still unreachable');
  assert.ok(ctx.view.topologyScroll < Number.MAX_SAFE_INTEGER, 'scroll was not clamped + written back');
  assert.equal(end.length, 22, 'exact-rows contract broken while scrolled');
  for (const r of end) assert.ok(visLen(r) <= 104);
});

test('an action on REMEDY targets the symptom on screen, not the Overview cursor', () => {
  // `p` runs immediately with no CONFIRM box, so aiming it at the wrong node is
  // a safety defect, not a cosmetic one.
  const target = mkNode({ nodeId: 83, name: 'Utility Closet Switch' });
  const other = mkNode({ nodeId: 6, name: 'Kitchen Lights' });
  const symptom = {
    id: 's1', kind: 'dead-flap', severity: 'crit', nodeId: 83, sinceMs: Date.now() - 60_000,
    basis: 'measured', evidence: [], narrative: 'flapping', subsumedBy: null,
  } as never;
  const data = { ...mockData({ nodes: [other, target] }), symptoms: () => [symptom] };
  const view = mkView({ screen: 'remedy', selected: 0, remedyCursor: 0 });
  // The Overview cursor points at #6; the only symptom names #83.
  const picked = sortedSymptoms(data.symptoms())[view.remedyCursor];
  assert.equal(picked.nodeId, 83, 'the remedy cursor must select the symptom’s node');
  assert.notEqual(picked.nodeId, other.nodeId, 'still aiming at the Overview selection');
});

test('a subsumed symptom never outranks the event that owns its remedy', () => {
  const mk = (o: Record<string, unknown>) => ({
    id: String(o.nodeId ?? 'mesh'), basis: 'measured', evidence: [], narrative: '', ...o,
  }) as never;
  const list = [
    mk({ kind: 'dead-flap', severity: 'crit', nodeId: 11, sinceMs: 5, subsumedBy: 'mesh:interference' }),
    mk({ kind: 'dead-flap', severity: 'crit', nodeId: 12, sinceMs: 4, subsumedBy: 'mesh:interference' }),
    mk({ kind: 'mesh-interference', severity: 'warn', nodeId: null, sinceMs: 3, subsumedBy: null }),
  ];
  const sorted = sortedSymptoms(list);
  // The warn mesh event carries the recommendation; the crit dependents do not.
  assert.equal(sorted[0].kind, 'mesh-interference',
    'recommendation-less criticals buried the only actionable card');
});

test('"/" cannot start an invisible filter capture off the Overview', () => {
  const data = mockData({ nodes: [mkNode()] });
  for (const screen of ['detail', 'topology', 'heatmap', 'controller'] as const) {
    const view = mkView({ screen });
    const res = applyKey(view, { type: 'char', ch: '/' }, data, () => {});
    assert.notEqual(res.filter, 'start', `${screen} starts a capture it cannot display`);
  }
  const ov = mkView({ screen: 'overview' });
  assert.equal(applyKey(ov, { type: 'char', ch: '/' }, data, () => {}).filter, 'start',
    'the Overview must still own the filter');
});

test('the empty card offers Esc during capture even with no committed filter', () => {
  // The keycap condition is `active || ctx.filtering`. A fixture that always
  // sets view.filter can never exercise the second half — yet that is exactly
  // the state reached by pressing `/` on a genuinely empty mesh.
  const data = mockData({ nodes: [] });
  const view = mkView({ screen: 'overview', filter: '' });
  const rows = renderOverview({ view, data, visibleNodes: [], filtering: true } as ScreenCtx).map(strip);
  assert.ok(rows[rows.length - 1].includes('[Esc]'),
    `no cancel key while capturing with an empty filter: ${rows[rows.length - 1]}`);
  // And the real reason must still be on screen.
  assert.ok(rows.join('\n').includes('No Z-Wave nodes discovered'),
    'capture hid the fact that the mesh itself is empty');
});

test('a whitespace-only filter is not blamed for an empty roster', () => {
  // visibleNodes() applies `filter.trim()`, so "   " narrows nothing. Claiming
  // "No nodes match" and offering CLEAR would be a fabricated explanation.
  const data = mockData({ nodes: [] });
  const view = mkView({ screen: 'overview', filter: '   ' });
  const rows = renderOverview({ view, data, visibleNodes: [], filtering: false } as ScreenCtx).map(strip);
  const joined = rows.join('\n');
  assert.ok(joined.includes('No Z-Wave nodes discovered'), `blamed an inert filter:\n${joined}`);
  assert.ok(!/No nodes match/.test(joined), 'claimed a whitespace filter excluded something');
});

test('"/" is refused while the Overview is still a loading card', () => {
  // Screen alone is not enough: before the roster arrives the Overview renders
  // a centred "Connecting…" notice and never builds the title rule that shows
  // the prompt — so a capture there is just as invisible, and that card's only
  // keycap is the [Q] the capture would swallow.
  const loading = { ...mockData({ nodes: [] }), ready: () => false };
  const view = mkView({ screen: 'overview' });
  const res = applyKey(view, { type: 'char', ch: '/' }, loading, () => {});
  assert.notEqual(res.filter, 'start', 'started a capture the loading card cannot display');

  // And the loading card must still advertise a way out.
  const rows = renderOverview({ view, data: loading, visibleNodes: [], filtering: false } as ScreenCtx);
  assert.ok(strip(rows[rows.length - 1]).includes('[Q]'), 'loading card has no advertised exit');
});

test('Esc clears a COMMITTED filter on the Overview', () => {
  // Esc used to clear the filter only during the `/` capture, so once Enter was
  // pressed the key went inert — while the empty-roster card advertises
  // [Esc] CLEAR, making that card's own escape route a lie.
  const data = mockData({ nodes: [mkNode()] });
  const view = mkView({ screen: 'overview', filter: 'xyzzy', selected: 3, scroll: 2 });
  const res = applyKey(view, { type: 'escape' }, data, () => {});
  assert.equal(view.filter, '', 'Esc left the committed filter in place');
  assert.ok(res.redraw, 'clearing the filter must redraw');
  assert.equal(view.selected, 0, 'selection not reset to the restored roster');
  assert.equal(view.scroll, 0, 'scroll window not reset to the restored roster');

  // Not special-cased to one string.
  for (const f of ['a', 'kitchen', '  ', 'ZZZ-9']) {
    const v = mkView({ screen: 'overview', filter: f, selected: 2, scroll: 1 });
    applyKey(v, { type: 'escape' }, data, () => {});
    assert.equal(v.filter, '', `Esc did not clear the filter ${JSON.stringify(f)}`);
  }

  // With no filter set, Esc on the home screen still does nothing.
  const idle = mkView({ screen: 'overview', filter: '' });
  assert.equal(applyKey(idle, { type: 'escape' }, data, () => {}).redraw, false);
});

test('the empty-roster card echoes an active filter capture', () => {
  // `/` is legal here (it is how you edit the filter that emptied the roster),
  // so the card must show the capture — otherwise it swallows the [Q] on its
  // own command bar with nothing on screen to explain why.
  const data = mockData({ nodes: [] });
  const view = mkView({ screen: 'overview', filter: 'kit' });
  const rows = renderOverview({ view, data, visibleNodes: [], filtering: true } as ScreenCtx).map(strip);
  const joined = rows.join('\n');
  // The caret is rendered ONLY by the capture branch — `No nodes match "kit"`
  // also contains the filter text and the command bar always says FILTER, so
  // neither of those alone distinguishes capture from the settled state.
  assert.ok(joined.includes('▏'), `capture caret missing on the empty card:\n${joined}`);
  // "clear", not "cancel": the capture edits view.filter in place, so Esc
  // discards the whole filter — matching the [Esc] CLEAR keycap below it.
  assert.ok(/⏎ apply · Esc clear/.test(joined), 'capture card does not say how to apply or clear');
  assert.ok(joined.includes('kit'), 'capture does not echo what was typed');
  // The REASON the roster is empty must survive alongside the capture — the
  // capture branch used to replace it, so on a genuinely empty mesh the
  // operator was left editing a filter that was not responsible.
  assert.ok(/No nodes match|No Z-Wave nodes discovered/.test(joined),
    `capture replaced the reason instead of joining it:\n${joined}`);
  assert.ok(rows[rows.length - 1].includes('[Esc]'), 'no cancel key advertised during capture');

  // The settled (non-capture) state must NOT show the caret.
  const settled = renderOverview({ view, data, visibleNodes: [], filtering: false } as ScreenCtx).map(strip);
  assert.ok(!settled.join('\n').includes('▏'), 'caret shown while not capturing');
});

/* ── round-3: the Overview `unknown` accounting, previously untested ─────── */

test('a never-contacted node does not count toward mesh health', () => {
  // health.ts gives Unknown the state 'unknown' (not 'flaky') and only
  // NodeStatus.Dead subtracted, so nodes the controller has never heard from
  // inflated the MESH percentage as if they were fine.
  const alive = Array.from({ length: 3 }, (_, i) => mkNode({ nodeId: 10 + i, name: `Alive ${i}` }));
  const unknown = mkNode({ nodeId: 20, name: 'Never Seen', status: NodeStatus.Unknown, statusLabel: 'unknown' });

  const pctOf = (nodes: ReturnType<typeof mkNode>[]): number => {
    // Match the telemetry FIELD, not the first line containing "MESH" — the
    // masthead reads "ZWAVE·JS MESH DIAGNOSTICS" and is row 0.
    const rows = renderOverview(ctxFor(nodes, { cols: 160 })).map(strip);
    const line = rows.find((r) => /MESH\s+[█░]/.test(r));
    assert.ok(line, `no MESH telemetry field rendered:\n${rows.slice(0, 4).join('\n')}`);
    return Number(/MESH\s+[█░]+\s+(\d+)%/.exec(line)?.[1]);
  };

  const allHealthy = pctOf(alive);
  const withUnknown = pctOf([...alive, unknown]);
  assert.equal(allHealthy, 100, 'control: three healthy nodes should read 100%');
  assert.ok(withUnknown < 100,
    `a never-contacted node counted as healthy (MESH ${withUnknown}%)`);
  assert.equal(withUnknown, 75, `expected 3 of 4 healthy, got ${withUnknown}%`);
});

test('unknown nodes are surfaced in the telemetry strip when present', () => {
  const nodes = [mkNode({ nodeId: 10 }), mkNode({ nodeId: 20, status: NodeStatus.Unknown, statusLabel: 'unknown' })];
  const withU = renderOverview(ctxFor(nodes, { cols: 160 })).map(strip).join('\n');
  assert.ok(/UNKNOWN\s+1/.test(withU), `unknown count is not shown:\n${withU.split('\n')[2]}`);

  // Absent on a healthy mesh — the field is noise when it is zero.
  const clean = renderOverview(ctxFor([mkNode({ nodeId: 10 })], { cols: 160 })).map(strip).join('\n');
  assert.ok(!/UNKNOWN/.test(clean), 'the UNKNOWN field is shown when there is nothing to report');
});

test('a whitespace-only filter is not advertised as active in the title rule', () => {
  // visibleNodes() and the empty-roster card both use .trim(); the title rule
  // keyed on raw truthiness, so "   " showed a live FILTER token that excluded
  // nothing.
  const nodes = [mkNode({ nodeId: 10 })];
  // A FRESH roster: the stale-roster warning legitimately outranks the filter
  // token in the title rule, and the shared fixture's clock is days old.
  const fresh = { ...mockData({ nodes }), lastUpdated: () => Date.now() };
  const ruleFor = (filter: string): string => strip(
    renderOverview({ view: mkView({ screen: 'overview', cols: 160, rows: 24, filter }), data: fresh, visibleNodes: nodes, filtering: false } as ScreenCtx)[1],
  );
  assert.ok(!/FILTER/.test(ruleFor('   ')), `a whitespace filter is advertised as active: ${ruleFor('   ')}`);
  // A real filter still is — one that MATCHES, so the roster renders its title
  // rule rather than the empty-roster card (which has no title rule).
  assert.ok(/FILTER/.test(ruleFor('Garage')), `a real filter is not advertised: ${ruleFor('Garage')}`);
});

test('the estimated-margin marker is separated from the value it qualifies', () => {
  // "+25dBest" reads as a unit. It must be "+25dB est".
  const n = mkNode({
    nodeId: 4, name: 'Routed One',
    stats: { ...mkNode().stats, rssi: -70, lwr: { repeaters: [], rssi: -70, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  // mockData().hasRealNoise() is false, so every margin here is an estimate.
  const rows = renderTopology(ctxFor([n], { screen: 'topology', cols: 120, rows: 24 })).map(strip);
  const line = rows.find((r) => r.includes('Routed One'));
  assert.ok(line, 'node missing from the tree');
  assert.ok(/dB\s+est/.test(line), `the est marker is glued to the value: ${JSON.stringify(line)}`);
});

test('the heatmap mean-margin meter agrees with the number beside it', () => {
  // meter()'s default zoneColor is a coarser ramp than marginColor, so the μ
  // bar could read green beside a red worst-margin number for the same area.
  // +9 dB against the assumed -95 floor is one of the few margins where the two
  // functions DISAGREE: marginColor says `red` (below its 10 dB cut) while
  // zoneColor — meter()'s default — says `yellow` (0.36 of its 25 dB span).
  // A margin where they happen to agree cannot detect the defect at all.
  const weak = mkNode({
    nodeId: 5, name: 'Weak', area: 'den', status: NodeStatus.Alive,
    stats: { ...mkNode().stats, rssi: -87, lwr: { repeaters: [], rssi: -87, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const rows = renderHeatmap(ctxFor([weak], { screen: 'heatmap', cols: 120, rows: 24 }));
  const line = rows.find((r) => strip(r).includes('den'));
  assert.ok(line, 'area row missing');
  const meterSgr = /\x1b\[([0-9;]+)m█/.exec(line.slice(line.indexOf('μ')));
  assert.ok(meterSgr, `no mean meter rendered: ${JSON.stringify(strip(line))}`);
  const expected = /\x1b\[([0-9;]+)m/.exec(marginColor(8)('x'))![1];
  assert.equal(meterSgr[1], expected,
    'the μ meter uses a different band function than its own number');
});

/* ── round-4: fixes that had NO test and reverted with the suite green ───── */

test('the Detail dossier greys a dead node’s stale RF telemetry too', () => {
  // Overview, Topology and the Heatmap all got this rule. The dossier — the one
  // screen you open to diagnose a dead node — was the FOURTH consumer and was
  // missed, so it reported `RTT 20 ms` and a green route two rows above its own
  // `RSSI —`, contradicting both itself and the Overview row for the same node.
  const stats = {
    ...mkNode().stats, rtt: 20, rssi: -55, commandsTX: 100, timeoutResponse: 0,
    lwr: { repeaters: [], rssi: -55, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null },
  };
  const rfRows = (n: ReturnType<typeof mkNode>): string[] =>
    renderDetail(ctxFor([n], { screen: 'detail', cols: 100, rows: 30, selected: 0 }))
      .filter((r) => /RTT|Timeouts|LWR/.test(strip(r)));
  const green = (rows: string[]): number =>
    rows.filter((r) => r.includes('\x1b[92m') || r.includes('\x1b[1;92m')).length;

  // Control: a healthy node with identical telemetry DOES colour these rows —
  // without this the assertion below could pass on an empty fixture.
  const alive = mkNode({ nodeId: 8, name: 'Alive One', stats });
  assert.ok(green(rfRows(alive)) > 0, 'fixture never reached the coloured path');

  const deadNode = mkNode({
    nodeId: 9, name: 'Dead One', status: NodeStatus.Dead, statusLabel: 'dead', stats,
  });
  assert.equal(green(rfRows(deadNode)), 0,
    'the dossier still paints a dead node’s stale RTT / timeouts / route in health green');
});

test('the Remedy screen acts on the symptom under its cursor', () => {
  // Drives the REAL sortedSymptoms + cursor rather than restating the rule.
  const mk = (nodeId: number | null, sinceMs: number) => ({
    id: `s${nodeId}`, kind: 'dead-flap', severity: 'crit', nodeId, sinceMs,
    basis: 'measured', evidence: [], narrative: '', subsumedBy: null,
  }) as never;
  const list = sortedSymptoms([mk(83, 9), mk(6, 8), mk(41, 7)]);
  // Cursor 1 must resolve to the SECOND card in render order, not to index 1 of
  // the unsorted input and not to whatever the Overview happens to hold.
  assert.equal(list[1].nodeId, 6);
  assert.notEqual(list[0].nodeId, list[1].nodeId);
  // And the ordering the cursor indexes into is the one the screen renders.
  const rendered = renderRemedy({
    view: mkView({ screen: 'remedy', cols: 110, rows: 40, remedyCursor: 1 }),
    data: { ...mockData({ nodes: [mkNode({ nodeId: 6, name: 'Kitchen' })] }), symptoms: () => list },
    visibleNodes: [], filtering: false, actionsEnabled: false,
  } as ScreenCtx).map(strip);
  const marked = rendered.findIndex((r) => r.includes('▶'));
  assert.ok(marked >= 0, 'no cursor rendered');
  assert.ok(rendered[marked].includes('#6'),
    `the ▶ is on the wrong card: ${rendered[marked]}`);
});



test('the Overview roster position counter reports where you are', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => mkNode({ nodeId: 10 + i, name: `N${i}` }));
  const rows = renderOverview(ctxFor(nodes, { cols: 140, rows: 20, selected: 25 })).map(strip);
  const bar = rows[rows.length - 1];
  const m = /\((\d+)–(\d+)\/(\d+)\)/.exec(bar);
  assert.ok(m, `no position counter rendered: ${bar}`);
  const [, from, to, total] = m.map(Number);
  assert.equal(total, 30, 'wrong roster total');
  assert.ok(from >= 1 && to <= 30 && from <= to, `nonsense window ${from}-${to}`);
  // It must describe a WINDOW CONTAINING THE CURSOR, not the window size.
  assert.ok(from <= 26 && 26 <= to, `counter window ${from}-${to} excludes the cursor (row 26)`);
});



test('the keys the Topology and Remedy bars advertise are really bound', () => {
  // Both handlers could be unbound entirely with the whole suite green, while
  // their command bars advertised [↑↓] SCROLL and [↑↓] SYMPTOM.
  const nodes = Array.from({ length: 40 }, (_, i) => mkNode({
    nodeId: 10 + i, name: `Node ${i}`,
    stats: { ...mkNode().stats, lwr: { repeaters: [], rssi: -60, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  }));
  const data = mockData({ nodes });

  // TOPOLOGY: ↓ / j / space / G must move the tree scroll; g returns to the top.
  for (const ev of [
    { type: 'arrow', dir: 'down' } as const,
    { type: 'char', ch: 'j' } as const,
    { type: 'char', ch: ' ' } as const,
  ]) {
    const view = mkView({ screen: 'topology', topologyScroll: 0 });
    applyKey(view, ev, data, () => {});
    assert.ok(view.topologyScroll > 0,
      `Topology ${JSON.stringify(ev)} did not scroll the route tree`);
  }
  const top = mkView({ screen: 'topology', topologyScroll: 5 });
  applyKey(top, { type: 'char', ch: 'g' }, data, () => {});
  assert.equal(top.topologyScroll, 0, 'Topology g did not return to the top');

  // REMEDY: ↓ / j must move the symptom cursor — the ACTION TARGET on that screen.
  const syms = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`, kind: 'dead-flap', severity: 'crit', nodeId: i + 1, sinceMs: 100 - i,
    basis: 'measured', evidence: [], narrative: '', subsumedBy: null,
  })) as never[];
  const withSyms = { ...data, symptoms: () => syms };
  for (const ev of [{ type: 'arrow', dir: 'down' } as const, { type: 'char', ch: 'j' } as const]) {
    const view = mkView({ screen: 'remedy', remedyCursor: 0 });
    applyKey(view, ev, withSyms, () => {});
    assert.equal(view.remedyCursor, 1,
      `Remedy ${JSON.stringify(ev)} did not move the symptom cursor`);
  }
  const up = mkView({ screen: 'remedy', remedyCursor: 3 });
  applyKey(up, { type: 'char', ch: 'k' }, withSyms, () => {});
  assert.equal(up.remedyCursor, 2, 'Remedy k did not move the cursor up');
});

test('the Topology scroll clamps and writes back', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => mkNode({
    nodeId: 10 + i, name: `Node ${i}`,
    stats: { ...mkNode().stats, lwr: { repeaters: [], rssi: -60, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  }));
  const ctx = ctxFor(nodes, { screen: 'topology', cols: 104, rows: 22 });
  ctx.view.topologyScroll = Number.MAX_SAFE_INTEGER;   // 'G'
  const rows = renderTopology(ctx).map(strip);
  assert.ok(ctx.view.topologyScroll < Number.MAX_SAFE_INTEGER, 'scroll was not clamped');
  assert.ok(ctx.view.topologyScroll > 0, 'clamped all the way back to the top');
  // The position note must report the real window, not a placeholder.
  const note = rows.find((r) => /\d+–\d+\/\d+/.test(r));
  assert.ok(note, `no scroll position note: ${rows.slice(-3).join(' | ')}`);
  const [, from, to, total] = /(\d+)–(\d+)\/(\d+)/.exec(note)!.map(Number);
  assert.ok(to === total, `scrolled to the end but the note says ${from}–${to}/${total}`);
});

/* ── round-4: the nine fixes the mutation harness proved were unpinned ───── */

test('log event text is sanitized AT THE SINK, not merely by an exported helper', () => {
  // The previous test called sanitizeEventText() directly, so removing its CALL
  // inside pushEvent() left the suite green — the classic "test the unit, not
  // the wiring" gap. Drive the real data layer's public log entry point.
  const data = createZwaveData({
    client: { send: async () => ({}), onEvent: () => {}, onReady: () => {} } as never,
    historyPath: null,
  });
  data.logAction('error', 5, 'turn on → failed: \x1b[31mRED\x1b[0m\nsecond line\rrewind');
  const ev = data.events()[0];
  data.stop(); // it owns poll/flush timers that would keep node:test alive
  assert.ok(ev, 'no event recorded');
  assert.ok(!/[\n\r]/.test(ev.text), `newline reached the ring: ${JSON.stringify(ev.text)}`);
  assert.ok(!/\x1b/.test(ev.text), `ESC reached the ring: ${JSON.stringify(ev.text)}`);
  assert.ok(ev.text.includes('failed:'), 'the message was destroyed');
});

test('meter reserves saturation for the real endpoints (discriminating values)', () => {
  // 0.94 and 0.05 do NOT discriminate: plain Math.round already gives 9 and 1.
  // Only values that round ACROSS an endpoint expose the bug.
  const full = (s: string): number => (strip(s).match(/█/g) ?? []).length;
  assert.equal(full(meter(1, 10)), 10, '100% must fill');
  assert.equal(full(meter(0, 10)), 0, '0% must be empty');
  assert.ok(full(meter(0.96, 10)) < 10, '96% must not read as complete');   // round → 10
  assert.ok(full(meter(0.04, 10)) > 0, '4% must not read as nothing');      // round → 0
});

test('the Overview persists its clamped scroll window across redraws', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => mkNode({ nodeId: 10 + i, name: `N${i}` }));
  const ctx = ctxFor(nodes, { cols: 140, rows: 20, selected: 25, scroll: 0 });
  renderOverview(ctx);
  const afterFirst = ctx.view.scroll;
  assert.ok(afterFirst > 0, 'the renderer never wrote back a scrolled window');
  // A second redraw with no input must not move it.
  renderOverview(ctx);
  assert.equal(ctx.view.scroll, afterFirst, 'the window drifted on a plain redraw');
});

test('the Overview signal glyph is coloured by its own number’s band', () => {
  // Needs a margin where marginColor and signalBars' internal zoneColor differ.
  // +6 dB: marginColor → red (below WEAK_MARGIN_DB); zoneColor(bandFrac) →
  // yellow. NB the previous fixture used +9 dB, which discriminated only while
  // the red cut sat at 10 — deriving it from WEAK_MARGIN_DB silently made that
  // fixture agree, and the mutation harness caught it.
  const n = mkNode({
    nodeId: 4, name: 'Weak One',
    stats: { ...mkNode().stats, rssi: -89, lwr: { repeaters: [], rssi: -89, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const row = renderOverview(ctxFor([n, mkNode({ nodeId: 9 })], { cols: 140, selected: 1 }))
    .find((r) => strip(r).includes('Weak One'));
  assert.ok(row, 'node missing');
  const want = /\x1b\[([0-9;]+)m/.exec(marginColor(6)('x'))![1];
  const glyph = /\x1b\[([0-9;]+)m[▁▃▅▇]/.exec(row);
  assert.ok(glyph, `no signal glyph rendered: ${JSON.stringify(strip(row))}`);
  assert.equal(glyph[1], want, 'the glyph and its number use different bands');
});

test('the Detail dossier uses the SHARED timeout band, not its old private one', () => {
  // 4%: the retired private ramp said green (<5); the shared band says yellow
  // (3–8). A value where both agree cannot detect the drift.
  const n = mkNode({
    nodeId: 6, name: 'Flaky',
    stats: { ...mkNode().stats, commandsTX: 100, timeoutResponse: 4 },
  });
  const row = renderDetail(ctxFor([n], { screen: 'detail', cols: 100, rows: 30, selected: 0 }))
    .find((r) => strip(r).includes('Timeouts'));
  assert.ok(row, 'no Timeouts row');
  const want = /\x1b\[(\d+)m/.exec(timeoutPctColor(4)('x'))![1];
  const got = /\x1b\[(\d+)m4\.0%/.exec(row);
  assert.ok(got, `timeout pct not rendered: ${JSON.stringify(strip(row))}`);
  assert.equal(got[1], want, 'the dossier still uses a private timeout band');
});

test('commandBar fits whole caps rather than falling straight to shedding', () => {
  // A mutant that skips the whole-fit attempt still produced acceptable output
  // at the widths already tested, because shedding happens to reach the same
  // line. Assert the POSITIVE case: at a width where every cap fits, every cap
  // must be present and nothing may be disclosed as dropped.
  const bar = strip(commandBar(mkView({ cols: 200 }), KEYS));
  for (const [k, label] of KEYS) {
    assert.ok(bar.includes(`[${k}] ${label}`), `[${k}] ${label} missing at 200 cols: ${bar}`);
  }
  assert.ok(!/\+\d+/.test(bar), `claimed a drop while everything fits: ${bar}`);
  // And the gutter is the roomy one when there is room for it.
  assert.ok(bar.includes('SCREENS   '), `tightened the gutter unnecessarily: ${bar}`);
});

/* ── round-5: fixes the harness proved had no test at all ───────────────── */

test('renderLogin returns exactly view.rows lines and never overflows', () => {
  // It was the only render path that could return SHORT — it sliced but never
  // padded, leaving the caller to decide what the remaining rows contain. On
  // the one screen that takes a password, stale bytes from a previous frame
  // are the worst possible leftover.
  for (let rows = 1; rows <= 40; rows++) {
    // Start at 4: the mutant floors the layout at 20 and emits 18-column rows,
    // which at cols=18 coincidentally fits — the fixture-agreement trap. Only
    // widths BELOW 18 discriminate.
    for (const cols of [4, 8, 12, 17, 18, 24, 40, 60, 80, 120]) {
      const out = renderLogin({
        cols, rows, stage: 'password', username: 'operator',
        buffer: 'hunter2', error: null, denied: null, checking: false,
      } as never);
      assert.equal(out.length, rows, `renderLogin returned ${out.length} lines at ${cols}x${rows}`);
      for (const line of out) {
        assert.ok(visLen(line) <= cols, `login line is ${visLen(line)} wide at cols=${cols}`);
      }
    }
  }
});

test('the Interference floor number uses the shared dBm band', () => {
  // It took the ENGINE's band colour (clean/elevated/noisy), so a quiet -95 dBm
  // floor rendered green here and grey on every other screen. The band BADGE
  // keeps its own colour — that is a different claim.
  const iv = {
    noise: { channels: [-95, -95, null, null], floor: -95, real: true, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'clean' },
    serial: { nakPerH: 0, canPerH: 0, tmoAckPerH: 0, tmoRespPerH: 0, band: 'healthy', spanH: 4 },
    diurnal: [], coverageDays: 1,
    correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' },
  };
  const data = { ...mockData({ nodes: [mkNode()] }), interference: () => iv as never };
  const rows = renderInterference({
    view: mkView({ screen: 'interference', cols: 120, rows: 30 }), data, visibleNodes: [], filtering: false,
  } as ScreenCtx);
  const line = rows.find((r) => strip(r).includes('median'));
  assert.ok(line, 'no noise-floor line rendered');
  const want = /\x1b\[([0-9;]+)m/.exec(noiseColor(-95)('x'))![1];
  const got = /\x1b\[([0-9;]+)m-95 dBm/.exec(line);
  assert.ok(got, `floor number not rendered: ${JSON.stringify(strip(line))}`);
  assert.equal(got[1], want, 'the floor number uses a different band than every other screen');
});

test('frame() holds back the columns a caller reserved', () => {
  // Without keysReserve the bar and an appended token fight over the same row,
  // and the token is what gets clipped.
  const view = mkView({ cols: 80, rows: 10 });
  const keys = [
    ['1-9', 'SCREENS'], ['↑↓', 'NAV'], ['⏎', 'INSPECT'],
    ['A', 'ACTIONS', 1], ['/', 'FILTER', 2], ['Q', 'EXIT'],
  ] as const;
  const wide = frame(view, mockData(), { title: 'X', body: [], keys });
  const held = frame(view, mockData(), { title: 'X', body: [], keys, keysReserve: 20 });
  assert.ok(visLen(held[held.length - 1]) <= 60,
    `reserve ignored: bar is ${visLen(held[held.length - 1])} wide with 20 reserved of 80`);
  assert.ok(visLen(held[held.length - 1]) < visLen(wide[wide.length - 1]),
    'reserving columns did not shorten the bar');
});

test('REMEDY does not claim nothing is acted on while its own bar runs actions', () => {
  // Its command bar advertises [A] ACTIONS and `p` fires a ping with no CONFIRM
  // box. The true claim is about the ENGINE, not the screen.
  const sym = {
    kind: 'dead-flap', nodeId: 5, severity: 'crit', sinceMs: Date.now() - 60_000,
    basis: 'measured', evidence: [], narrative: 'flapping',
  } as never;
  const data = { ...mockData({ nodes: [mkNode({ nodeId: 5 })] }), symptoms: () => [sym] };
  const out = renderRemedy({
    view: mkView({ screen: 'remedy', cols: 120, rows: 30 }), data,
    visibleNodes: [], filtering: false, actionsEnabled: true,
  } as ScreenCtx).map(strip).join('\n');
  assert.ok(!/nothing is acted on/.test(out),
    `REMEDY claims nothing is acted on while offering actions:\n${out.split('\n')[2]}`);
  assert.ok(/engine only recommends/.test(out), 'the advisory claim is missing entirely');
});

test('the Log command bar sheds its LEAST useful keys first', () => {
  // [Q] survives either way — commandBar protects priority-0 caps — so
  // asserting only that is vacuous. What the priorities actually decide is
  // WHICH optional caps go: without them every cap is protected and the bar
  // sheds from the FRONT, losing [↑↓] MOVE (navigation) before [D] DATE.
  const data = mockData({ nodes: [mkNode()] });
  const barAt = (cols: number): string => strip(renderLog({
    view: mkView({ screen: 'log', cols, rows: 24 }), data, visibleNodes: [], filtering: false,
  } as ScreenCtx).slice(-1)[0]);

  for (let cols = 60; cols <= 100; cols += 4) {
    const bar = barAt(cols);
    assert.ok(bar.includes('[Q]'), `the Log lost its exit key at cols=${cols}: ${bar}`);
    assert.ok(!/\[[^\]]*$/.test(bar), `the Log bar ends mid-keycap at cols=${cols}: ${bar}`);
  }

  // At 60 cols the optional caps must go highest-priority-first —
  // [M] ACK (5, v0.33) before [D] DATE (4) before [O] ERRORS (3) — and
  // navigation must survive all of them.
  const tight = barAt(60);
  assert.match(tight, /\+\d$/, `expected dropped caps disclosed at 60 cols: ${tight}`);
  assert.ok(!tight.includes('[M]') && !tight.includes('[D]'),
    `the highest-priority caps must go first at 60 cols: ${tight}`);
  assert.ok(tight.includes('[↑↓] MOVE') && tight.includes('[⏎] DEVICE'),
    `shed navigation before the optional filters: ${tight}`);
  // And on a WIDE bar, the ack cap is advertised — the v0.33 interaction is
  // discoverable, not folklore.
  assert.ok(barAt(100).includes('[M] ACK'), `wide bar must advertise the ack key: ${barAt(100)}`);
});

test('when even the PROTECTED caps overflow, [Q] is the last one standing', () => {
  // commandBar's third degradation stage: with every cap protected (priority 0)
  // the sacrifice loop contributes nothing and the front-shed loop runs alone.
  // It sheds from the FRONT so the rightmost cap — the way out — survives. The
  // existing tests only reach the earlier stages, so shedding from the wrong
  // end went unnoticed: the exit key vanished below ~28 columns.
  const protectedOnly = [['1-6', 'SCREENS'], ['A', 'ACTIONS'], ['Q', 'EXIT']] as const;
  for (let cols = 10; cols <= 34; cols++) {
    const bar = strip(commandBar(mkView({ cols }), protectedOnly));
    assert.ok(visLen(bar) <= cols, `overflows at ${cols}`);
    assert.ok(bar.includes('[Q]'),
      `the exit key was shed at cols=${cols} — the bar sheds from the wrong end: ${bar}`);
    // Disclose the drop WHENEVER THE MARKER FITS. Below that the last-resort
    // clip keeps the key and loses the marker — the same trade fieldStrip
    // makes, and the right one: a key you can press beats a count you cannot.
    if (cols >= visLen(bar) + 3) {
      assert.match(bar, /\+\d+$/, `room for the marker but dropped silently at cols=${cols}: ${bar}`);
    }
  }
  // And the one it keeps LAST is the exit, not the first cap.
  assert.equal(strip(commandBar(mkView({ cols: 12 }), protectedOnly)), '[Q] EXIT +2');
});

test('the masthead reports the link state it was given', () => {
  // linkState() (the derivation) was tested; nothing asserted what the masthead
  // PRINTS. A swap in linkTag would render a green ● ONLINE on every screen
  // while the data provider was erroring — the plausible-lie class this whole
  // release exists to remove.
  const cases = [
    ['online', 'ONLINE', '\x1b[92m'],
    ['stale', 'STALE', '\x1b[93m'],
    ['offline', 'OFFLINE', '\x1b[91m'],
  ] as const;
  for (const [link, word, sgr] of cases) {
    const row = masthead(mkView({ cols: 120 }), { link, homeId: 1, now: 0 });
    assert.ok(strip(row).includes(word), `link=${link} did not print ${word}: ${strip(row)}`);
    assert.ok(row.includes(sgr), `link=${link} printed ${word} in the wrong colour`);
    // And it must not ALSO claim another state.
    for (const [, other] of cases) {
      if (other !== word) {
        assert.ok(!strip(row).includes(other), `link=${link} also printed ${other}`);
      }
    }
  }
});

/* ── round-5 fixes the harness reported as UNTESTED ─────────────────────── */

test('a dead node’s PER-HOP route readings are greyed with the rest of the row', () => {
  // pushRoute threaded `stale` into the rate and route RSSI but not into
  // routeChain, so the hop annotations stayed health-green inside a row that
  // was grey around them. NOTE: every other fixture in the suite uses
  // `repeaterRSSI: []`, so this branch had never been executed at all.
  const withHops = (status: NodeStatus, label: string) => mkNode({
    nodeId: 4, name: 'Routed One', status, statusLabel: label,
    stats: {
      ...mkNode().stats, rssi: -60, rtt: 20,
      lwr: { repeaters: [3, 8], rssi: -60, protocolDataRate: 3, repeaterRSSI: [-55, -58], routeFailedBetween: null },
    },
  });
  const lwrRow = (n: ReturnType<typeof mkNode>): string => {
    const row = renderDetail(ctxFor([n], { screen: 'detail', cols: 110, rows: 30, selected: 0 }))
      .find((r) => strip(r).includes('LWR'));
    assert.ok(row, 'no LWR row rendered');
    return row;
  };
  // Control: an alive node DOES colour its hop readings, so the assertion below
  // is not passing on an unexercised branch.
  const alive = lwrRow(withHops(NodeStatus.Alive, 'alive'));
  assert.ok(/\x1b\[9[123]m-5[58]/.test(alive), `fixture never reached the hop path: ${JSON.stringify(strip(alive))}`);

  const dead = lwrRow(withHops(NodeStatus.Dead, 'dead'));
  assert.ok(!/\x1b\[92m/.test(dead), `a dead node's hop readings are still health-green: ${JSON.stringify(dead)}`);
  assert.ok(/\x1b\[90m-5[58]/.test(dead), `hop readings not greyed: ${JSON.stringify(strip(dead))}`);
});

test('a never-contacted node is not reported as “RF health nominal”', () => {
  // No measurements means no flags, and the empty-flag branch read that absence
  // as health — directly under a title rule saying UNKNOWN · SCORE —.
  const unknown = mkNode({
    nodeId: 11, name: 'Never Seen', status: NodeStatus.Unknown, statusLabel: 'unknown',
  });
  const data = {
    ...mockData({ nodes: [unknown] }),
    scoreFor: () => ({ score: 12, grade: 'F', state: 'unknown', flags: [] }),
  };
  const out = renderDetail({
    view: mkView({ screen: 'detail', cols: 110, rows: 30, selected: 0 }),
    data, visibleNodes: [unknown], filtering: false,
  } as ScreenCtx).map(strip).join('\n');
  assert.ok(!/RF health nominal/.test(out),
    'a node with no measurements at all is reported as nominal');
  assert.ok(/nothing to assess|no measurements/.test(out),
    `the legend does not say why there is nothing to report:\n${out.split('\n').slice(-3).join('\n')}`);
});

test('the dossier bands the DISPLAYED rtt, matching the Overview', () => {
  // The driver reports fractional ms. The Overview rounds before banding; the
  // dossier banded the raw value, so 99.6 ms printed "100 ms" in two colours.
  const n = mkNode({ nodeId: 6, name: 'Borderline', stats: { ...mkNode().stats, rtt: 99.6 } });
  const row = renderDetail(ctxFor([n], { screen: 'detail', cols: 110, rows: 30, selected: 0 }))
    .find((r) => strip(r).includes('RTT'));
  assert.ok(row, 'no RTT row');
  assert.ok(strip(row).includes('100 ms'), `expected the rounded value: ${strip(row)}`);
  const want = /\x1b\[([0-9;]+)m/.exec(rttColor(100)('x'))![1];
  const got = /\x1b\[([0-9;]+)m100 ms/.exec(row);
  assert.ok(got, `rtt not rendered with a colour: ${JSON.stringify(strip(row))}`);
  assert.equal(got[1], want, 'the dossier banded the raw value, not the one it printed');
});

test('a FRACTIONAL noise floor never truncates a margin into a bare number', () => {
  // Found on the live 39-node mesh, not by any fixture: the driver's real floor
  // is fractional (-95.062), so `rssi - noise` rendered "+35.062dB" — 9 chars,
  // which the signal cell's defensive 7-char cap then sliced to "+35.062",
  // amputating the UNIT and leaving a bare number that reads as exact. Every
  // synthetic fixture used a whole-number floor, so this branch was invisible.
  const REAL_FLOOR = -95.062;
  const n = mkNode({
    nodeId: 16, name: 'Laundry Room Lights',
    stats: { ...mkNode().stats, rssi: -60, lwr: { repeaters: [], rssi: -60, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const data = { ...mockData({ nodes: [n] }), noiseFloor: () => REAL_FLOOR, hasRealNoise: () => true };

  for (const cols of [80, 104, 140, 200]) {
    const row = renderOverview({
      view: mkView({ screen: 'overview', cols, rows: 24, selected: 0 }),
      data, visibleNodes: [n], filtering: false,
    } as ScreenCtx).map(strip).find((r) => r.includes('Laundry'));
    assert.ok(row, `node row missing at cols=${cols}`);
    // The margin must carry its unit and no decimal tail.
    assert.match(row, /[+-]\d+dB\b/, `margin lost its unit at cols=${cols}: ${JSON.stringify(row)}`);
    assert.ok(!/\d\.\d/.test(row), `fractional margin leaked into the cell at cols=${cols}: ${JSON.stringify(row)}`);
  }

  // Same on the dossier and the route tree, which read the same floor.
  const detail = renderDetail({
    view: mkView({ screen: 'detail', cols: 110, rows: 30, selected: 0 }),
    data, visibleNodes: [n], filtering: false,
  } as ScreenCtx).map(strip).join('\n');
  assert.ok(!/[+-]\d+\.\d+\s*dB/.test(detail), `dossier shows a fractional margin:\n${detail.slice(0, 400)}`);

  const topo = renderTopology({
    view: mkView({ screen: 'topology', cols: 110, rows: 30 }),
    data, visibleNodes: [n], filtering: false,
  } as ScreenCtx).map(strip).join('\n');
  assert.ok(!/[+-]\d+\.\d+dB/.test(topo), `route tree shows a fractional margin:\n${topo.slice(0, 400)}`);
});

test('the margin-mode bar glyphs use the SHARED band, not signalBars’ own zone ramp', () => {
  // marginColor has a fourth band zoneColor cannot express: BOLD red (redB,
  // SGR "1;91") below half the weak threshold. At +1 dB margin the shared band
  // says redB while signalBars' internal zoneColor default says plain red —
  // the one place the two rules visibly disagree, so this is the fixture that
  // discriminates (every margin ≥ 3 dB agrees by construction, which is how a
  // dropped colorFn would slip through unnoticed).
  const weak = { ...mkNode().stats, rssi: -94 }; // vs the assumed -95 floor → +1 dB
  const n = mkNode({ nodeId: 3, name: 'Barely', stats: weak });
  const rows = renderOverview(ctxFor([n], { selected: 1, cols: 140, signalDisplay: 'margin' }));
  const row = rows.find((r) => strip(r).includes('Barely'));
  assert.ok(row, 'row must render');
  const boldRedBars = (row!.match(/\x1b\[1;91m[▁▃▅▇]/g) ?? []).length;
  const plainRedBars = (row!.match(/\x1b\[91m[▁▃▅▇]/g) ?? []).length;
  assert.ok(boldRedBars >= 1,
    `no bar carries the shared band's BOLD red (bold=${boldRedBars}, plain=${plainRedBars}) — the glyph is using signalBars' own zone ramp`);
});

test('the Overview signal GLYPH is banded by the same function as its number', () => {
  // The bars and the dB label describe ONE reading. signalBars' default is
  // zoneColor — a coarser, unrelated ramp — so dropping the explicit band
  // argument lets the glyph and the number beside it disagree about the same
  // node: amber bars next to a red number. Nothing caught that: the existing
  // signalBars test exercises the helper directly, never the Overview cell.
  //
  // Pick a reading in a band where zoneColor and the real band DISAGREE, or the
  // test cannot discriminate (the fixture-agreement trap). At -92 dBm the
  // rssiColor band is red while the bar fraction lands zoneColor in amber.
  const weak = { ...mkNode().stats, rssi: -92, lwr: { repeaters: [], protocolDataRate: 3, rssi: -92, repeaterRSSI: [], routeFailedBetween: null } };
  const n = mkNode({ nodeId: 5, name: 'Weak Direct', stats: weak as never });
  const rows = renderOverview(ctxFor([n], { selected: 9, cols: 140, signalDisplay: 'dbm' } as never));
  const row = rows.find((r) => strip(r).includes('Weak Direct'));
  assert.ok(row, 'the node row must render');

  // Colour immediately preceding the first bar glyph, and the one preceding the
  // dB number, must be the SAME SGR code.
  const barSgr = /\x1b\[([0-9;]*)m[▁▃▅▇]/.exec(row!)?.[1];
  const numSgr = /\x1b\[([0-9;]*)m\s*-9/.exec(row!)?.[1];
  assert.ok(barSgr != null, 'no coloured bar glyph found in the row');
  assert.ok(numSgr != null, 'no coloured dB number found in the row');
  assert.equal(barSgr, numSgr,
    `the signal glyph (SGR ${barSgr}) is banded differently from its own number (SGR ${numSgr})`);
});

test('the Overview roll-up is funded by SURPLUS only — it never pushes the roster into scrolling', () => {
  // The panel exists to earn rows the roster does not need (16 blank rows at
  // 200x60 on a 39-node mesh, measured). It must be invisible whenever the
  // roster itself needs the space, or it would cost an operator visible nodes
  // on a small terminal to decorate a large one.
  const nodes = Array.from({ length: 39 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const has = (rows: string[]) => rows.some((r) => strip(r).includes('excl. controller'));
  const roster = (rows: string[]) => rows.filter((r) => /\bDevice \d+/.test(strip(r))).length;

  // Small: 39 nodes cannot fit → roster scrolls → NO panel, and the roster
  // still gets every row it can use.
  for (const [cols, rows_] of [[60, 16], [80, 24], [120, 40]] as [number, number][]) {
    const out = renderOverview(ctxFor(nodes, { cols, rows: rows_ }));
    assert.equal(out.length, rows_, `${cols}x${rows_} broke the exact-rows contract`);
    assert.equal(has(out), false, `${cols}x${rows_} drew the roll-up while the roster was still scrolling`);
    assert.equal(roster(out), rows_ - 5, `${cols}x${rows_} lost roster rows to the panel`);
  }

  // Tall: every node has a row AND rows remain → panel appears, and the roster
  // still shows all 39.
  const big = renderOverview(ctxFor(nodes, { cols: 200, rows: 60 }));
  assert.equal(big.length, 60);
  assert.ok(has(big), 'the roll-up did not appear despite 16 surplus rows');
  assert.equal(roster(big), 39, 'the panel cost the roster rows it needed');
  for (const line of big) {
    assert.ok(strip(line).length <= 200, `a roll-up row overflowed 200 cols: ${JSON.stringify(strip(line).slice(0, 60))}`);
  }
});

test('the Overview roll-up counts the same membership as the Controller screen', () => {
  // Two screens showing two different "mesh" totals is a worse defect than the
  // blank rows this panel replaced. Both exclude node 1 — the mesh the
  // controller serves, not the controller itself.
  const nodes = Array.from({ length: 12 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const out = renderOverview(ctxFor(nodes, { cols: 200, rows: 60 }));
  const line = out.map(strip).find((r) => r.includes('excl. controller'));
  assert.ok(line, 'roll-up did not render');
  assert.match(line!, /\b11 nodes/, `roll-up counted the controller: ${line}`);
});

test('the Overview roll-up grades through the roster\'s own scoreColor', () => {
  // A private letter→colour table was a THIRD mapping and it disagreed with the
  // roster: scoreColor paints a 55-score node YELLOW (>= 40), while a
  // hand-written table called grade D red — one node, two colours, one screen.
  const nodes = Array.from({ length: 6 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const data = mockData({ nodes }) as never as Record<string, unknown>;
  data.scoreFor = () => ({ score: 55, grade: 'D', state: 'ok', flags: [] });
  const out = renderOverview({
    view: mkView({ screen: 'overview', cols: 200, rows: 60 }),
    data: data as never, visibleNodes: nodes, filtering: false,
  } as ScreenCtx);

  const health = out.find((r) => strip(r).includes('HEALTH'));
  assert.ok(health, 'roll-up HEALTH line did not render');
  // scoreColor(55) is c.yellow. The D segment must carry exactly that SGR.
  const wantSgr = /\x1b\[([0-9;]*)m/.exec(c.yellow('x'))![1];
  const gotSgr = /\x1b\[([0-9;]*)mD /.exec(health!)?.[1];
  assert.ok(gotSgr != null, `no coloured D segment in: ${JSON.stringify(strip(health!))}`);
  assert.equal(gotSgr, wantSgr,
    `grade D (score 55) was coloured SGR ${gotSgr}; the roster's scoreColor gives ${wantSgr}`);
});

test('chartRows: a present reading never renders as blank space', () => {
  // The one-eighth floor is the same rule litBars() enforces: a real but tiny
  // sample must not be indistinguishable from no sample. Pick a series whose
  // minimum rounds to zero eighths without the floor.
  const vals = [0, 0.02, 0.04, 5];
  const rows = chartRows(vals, 4, 3).map(strip);
  const bottom = rows[rows.length - 1];
  for (let i = 0; i < vals.length; i++) {
    assert.notEqual(bottom[i], ' ',
      `sample ${vals[i]} (col ${i}) rendered as blank space: ${JSON.stringify(bottom)}`);
  }
});

test('chartRows: scales over the DRAWN window, not samples that scrolled off', () => {
  // Auto-scaling to off-screen data flattens the visible trend against an
  // invisible extreme — the exact bug sparkline's comment documents. Only the
  // last `width` samples may set the scale.
  // The mutant swaps min(recent) for min(all), so the outlier must be LOW —
  // a high one cannot move `lo` and the test would agree either way (the
  // fixture-agreement trap).
  const withDip = [-1000, 10, 11, 12, 13];   // dip is OUTSIDE the 4-wide window
  const without  = [12,    10, 11, 12, 13];
  const a = chartRows(withDip, 4, 4).map(strip).join('\n');
  const b = chartRows(without,   4, 4).map(strip).join('\n');
  assert.equal(a, b,
    'a sample outside the drawn window changed the scale — it must not');
});

test('chartRows marks a null sample on the baseline so it reads as no-data', () => {
  // A null column must be distinguishable from a measured minimum. The dot sits
  // on the baseline only — a full column of dots would read as data.
  const rows = chartRows([null, 5, null, 9], 4, 3).map(strip);
  const baseline = rows[rows.length - 1];
  assert.equal(baseline[0], '·', `null column 0 did not draw the no-data dot: ${JSON.stringify(baseline)}`);
  assert.equal(baseline[2], '·', `null column 2 did not draw the no-data dot: ${JSON.stringify(baseline)}`);
  assert.notEqual(baseline[1], '·', 'a MEASURED column must not draw the no-data dot');
  // Above the baseline a null column is blank, not dotted.
  assert.equal(rows[0][0], ' ', 'the null marker must appear on the baseline only');
  // An all-null series is entirely no-data.
  assert.ok(chartRows([null, null], 2, 2).map(strip).every((l) => /^·+$/.test(l)),
    'an all-null series must render as no-data across every row');
});

test('a decayed weight is never printed as an integer count (v0.43.1)', () => {
  // INVARIANT. `n` is an exponentially-weighted effective sample size — seven
  // closures on seven distinct nodes give Σ0.97^i = 6.4005 — while `nodes` is a
  // true cumulative count. Rounding the first produced `n=6 · 7 nodes` on an
  // ordinary run: a contradiction with nothing on screen to explain it, since
  // the two numbers were styled identically. The notation itself has to carry
  // the difference, at every width, on every screen that prints them.
  const eff = { expectedEfficacy: 0.8, n: 6.4005, baseRate: 0.2, nodes: 7, ready: true, lowerBound: 0.55, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const sym = {
    kind: 'rtt-degraded' as const, nodeId: 6, severity: 'warn' as const, sinceMs: 20 * 60_000,
    basis: 'measured' as const, evidence: [{ label: 'rtt', value: '140 ms' }],
    narrative: 'Node 6 round-trip time is above its own normal.',
  };
  for (let cols = 60; cols <= 200; cols += 1) {
    const lines = renderRemedy({
      view: mkView({ screen: 'remedy', cols, rows: 40 }),
      data: { ...mockData({ nodes: [mkNode({ nodeId: 6, name: 'Kitchen' })] }),
        symptoms: () => [sym], efficacyFor: () => eff },
      visibleNodes: [], filtering: false, actionsEnabled: true,
    } as ScreenCtx).map(strip);
    for (const l of lines) {
      assert.ok(!l.includes('n=6') && !l.includes('n=7'),
        `${cols} cols: a decayed weight rendered as an integer count — "${l.trim()}"`);
      // And where the weight IS printed it must carry both its marker and its
      // decimal, so it cannot be misread as one of the plain episode tallies
      // ("N past episodes") that sit beside it in identical grey.
      if (l.includes('6.4')) assert.ok(l.includes('n≈6.4'), `${cols} cols: weight lost its marker — "${l.trim()}"`);
    }
  }
});

test('no REMEDY efficacy note ever clips a measurement mid-digit (v0.44.0)', () => {
  // INVARIANT. These notes were concatenated and then truncate()d, so at 80
  // columns `· 12 nodes` rendered as `· 1` — a complete-looking, wrong node
  // count. chrome.ts states the rule: an undisclosed drop is a smaller lie than
  // a clipped number that reads as a plausible measurement. Every clause must
  // therefore appear WHOLE or not at all, at every width.
  const shapes = [
    // granted, with harm appended
    { expectedEfficacy: 0.7, n: 20, baseRate: 0.3, nodes: 12, ready: true, lowerBound: 0.481,
      bar: 0.35, minN: 4, baseN: 19.4, baseNodes: 13, harmed: 8, baseHarmed: 1 },
    // withheld, with the bound and bar
    { expectedEfficacy: null, n: 12.4, baseRate: 0.6, nodes: 11, ready: true, lowerBound: 0.52,
      bar: 0.65, minN: 4, baseN: 11.3, baseNodes: 12, harmed: 0, baseHarmed: 0 },
    // below readiness, with the control arm measured
    { expectedEfficacy: null, n: 2, baseRate: 0.58, nodes: 1, ready: false, lowerBound: null,
      bar: null, minN: 4, baseN: 11.3, baseNodes: 12, harmed: 0, baseHarmed: 0 },
    // never run
    { expectedEfficacy: null, n: 0, baseRate: 0.58, nodes: 0, ready: false, lowerBound: null,
      bar: null, minN: 4, baseN: 11.3, baseNodes: 12, harmed: 0, baseHarmed: 0 },
  ];
  const sym = {
    kind: 'route-churn' as const, nodeId: 6, severity: 'warn' as const, sinceMs: 20 * 60_000,
    basis: 'measured' as const, evidence: [{ label: 'x', value: 'y' }],
    narrative: 'Node 6 keeps re-routing.',
  };
  // Every complete number the notes can carry. If a PREFIX of one appears
  // without the whole, a measurement was clipped.
  const wholes = ['n≈20.0', 'n≈12.4', 'n≈19.4', 'n≈11.3', 'n≈2.0', '12 nodes', '11 nodes',
    '13 nodes', 'node', 'nodes'];
  for (const eff of shapes) {
    for (let cols = 40; cols <= 200; cols += 1) {
      const lines = renderRemedy({
        view: mkView({ screen: 'remedy', cols, rows: 40 }),
        data: { ...mockData({ nodes: [mkNode({ nodeId: 6, name: 'Kitchen' })] }),
          symptoms: () => [sym], efficacyFor: () => eff },
        visibleNodes: [], filtering: false, actionsEnabled: true,
      } as ScreenCtx).map(strip);
      for (const l of lines) {
        // A `n≈` or `· N node` fragment must always be complete.
        const frag = /n≈\d+(\.\d)?|· \d+ nodes?/g;
        for (const m of l.match(frag) ?? []) {
          assert.ok(/^n≈\d+\.\d$/.test(m) || /^· \d+ nodes?$/.test(m),
            `${cols} cols: clipped fragment "${m}" in "${l.trim()}"`);
        }
        // And no EFFICACY NOTE may end mid-number. (Scoped: the masthead's
        // clock legitimately ends in a digit.)
        const isNote = /helped |still learning|never tried|not distinguishable|made it WORSE|ledger measured/.test(l);
        if (isNote) {
          assert.ok(!/\d$/.test(l.trimEnd()) || wholes.some((w) => l.trimEnd().endsWith(w)),
            `${cols} cols: note ends mid-number — "${l.trim()}"`);
        }
      }
    }
  }
});
