import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInterference, downsampleMean } from '../src/telnet/screens/interference';
import { visLen } from '../src/telnet/ansi';
import type { DataProvider, ControllerSnapshot, ScreenCtx, ViewState, InterferenceView } from '../src/types';

const now = Date.now();
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;

const cleanView = (over: Partial<InterferenceView> = {}): InterferenceView => ({
  noise: { channels: [-101, -103, -103, -95], floor: -102, real: true, trend: [-101, -102, -103, -102, -101], trendCoarse: [-100, -101, -102, -101, -103, -102], trendCoarseDays: 3, band: 'clean' },
  serial: { nakPerH: 0, canPerH: 0, tmoAckPerH: 0, tmoRespPerH: 2, band: 'healthy', spanH: 6.2 },
  diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h === 18 ? 0.031 : 0.008 })),
  coverageDays: 16,
  correlated: { active: false, degradedNodes: 0, narrative: 'No correlated mesh degradation.' },
  ...over,
});

function data(iv: InterferenceView): DataProvider {
  return {
    interference: () => iv, controller: () => ctrl,
    lastError: () => null, lastUpdated: () => now - 1000, ready: () => true,
  } as unknown as DataProvider;
}
const mkView = (cols: number, rows: number): ViewState =>
  ({ screen: 'interference', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, iv: InterferenceView): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(iv), visibleNodes: [], filtering: false, actionsEnabled: true } as ScreenCtx);

test('INTERFERENCE holds EXACTLY view.rows lines within view.cols at every size + state', () => {
  const views = [
    cleanView(),
    cleanView({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' } }), // no driver-WS
    cleanView({ coverageDays: 0.1, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 0, rate: null })) }), // building
    cleanView({ correlated: { active: true, degradedNodes: 4, narrative: 'Several nodes degraded together (4 of 11 active) — likely an RF-environment event.' } }),
  ];
  for (const iv of views) {
    for (const [cols, rows] of [[60, 16], [96, 24], [120, 40], [200, 50]] as const) {
      const lines = renderInterference(ctx(cols, rows, iv));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      lines.forEach((l, i) => {
        assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: width ${visLen(l)} > ${cols}`);
        assert.ok(!l.includes('undefined'), `${cols}x${rows} row ${i}: leaked "undefined"`);
      });
    }
  }
});

test('a clean mesh shows the measured floor, healthy serial, and no correlated degradation', () => {
  const joined = renderInterference(ctx(100, 30, cleanView())).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/median -102 dBm/.test(joined), 'measured floor shown');
  assert.ok(/● clean/.test(joined), 'clean band');
  assert.ok(/● healthy/.test(joined), 'healthy serial');
  assert.ok(/✓ No correlated mesh degradation/.test(joined), 'clean correlated state');
  assert.ok(/worst 18:00 3\.1%/.test(joined), 'worst diurnal hour surfaced');
});

test('without the driver-WS client the noise floor honestly reads unavailable, not fabricated', () => {
  const iv = cleanView({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' } });
  const joined = renderInterference(ctx(100, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/unavailable/.test(joined), 'says unavailable');
  assert.ok(!/median .* dBm/.test(joined), 'no fabricated floor number');
});

test('a sparse-history mesh shows the heatmap as "building", not an empty grid of fake zeros', () => {
  const iv = cleanView({ coverageDays: 0.2, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 0, rate: null })) });
  const joined = renderInterference(ctx(100, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/building/.test(joined), 'diurnal heatmap building message');
});

test('the diurnal heat scale is ABSOLUTE, not normalized-to-max (the core honesty property)', () => {
  const stripOf = (iv: InterferenceView): string => {
    const lines = renderInterference(ctx(100, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    // The heat strip is the 24-char run of shade/·/space cells (no letters).
    // Take the LAST such line: v0.28 draws the diurnal rates as a chart ABOVE
    // the strip, and those rows are also block glyphs with no letters, so a
    // first-match finder now grabs the chart. The strip is the final shaded row
    // on the screen (CORRELATED below it is prose).
    return [...lines].reverse().find((l) => /[░▒▓█]/.test(l) && !/[A-Za-z]/.test(l))?.trim() ?? '';
  };
  // A mesh whose rate never exceeds ~1% must render ALL light cells — a
  // normalized-to-max scale would blow the 1% peak up to a full █ block.
  const cool = stripOf(cleanView({ coverageDays: 16, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: 0.008 })) }));
  assert.ok(/░/.test(cool), 'cool mesh renders light cells');
  assert.ok(!/[▓█]/.test(cool), `1% everywhere must NOT render a dark cell (absolute scale), got "${cool}"`);
  // A genuine 5%+ hour DOES reach a full block on the same fixed scale.
  const hot = stripOf(cleanView({ coverageDays: 16, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h === 12 ? 0.06 : 0.008 })) }));
  assert.ok(/█/.test(hot), `a real 6% hour reaches a full block, got "${hot}"`);
});

test('diurnal heat colour is not inverted — a HOT hour is red, a cool mesh is green', () => {
  const rawStrip = (iv: InterferenceView): string => {
    // Keep ANSI; grab the heat-strip line (shade cells, no letters after strip).
    const lines = renderInterference(ctx(100, 30, iv));
    // LAST match — see the note in the absolute-scale test above.
    return [...lines].reverse().find((l) => /[░▒▓█]/.test(l) && !/[A-Za-z]/.test(l.replace(/\x1b\[[0-9;]*m/g, ''))) ?? '';
  };
  const hot = rawStrip(cleanView({ coverageDays: 16, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h === 12 ? 0.06 : 0.008 })) }));
  assert.ok(/\x1b\[(1;)?91m[░▒▓█]/.test(hot), 'a 6% hour renders a RED shade cell (bad = red)');
  const cool = rawStrip(cleanView({ coverageDays: 16, diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: 0.008 })) }));
  assert.ok(/\x1b\[92m[░▒▓█]/.test(cool), 'a quiet mesh renders GREEN shade cells (good = green)');
  assert.ok(!/\x1b\[(1;)?91m[░▒▓█]/.test(cool), 'and NOT red — the colour must not be inverted');
});

test('an active correlated event is surfaced in the title rule (never clipped on a short screen)', () => {
  const iv = cleanView({ correlated: { active: true, degradedNodes: 4, narrative: 'Correlated (4 of 11 active).' } });
  const titleLine = renderInterference(ctx(100, 12, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))[1]; // the title rule
  assert.ok(/⚠ correlated/.test(titleLine), 'the alarm shows in the title even when the body section is clipped');
});

test('correlated degradation is called out with the degraded/active ratio', () => {
  const iv = cleanView({ correlated: { active: true, degradedNodes: 4, narrative: 'Correlated mesh degradation (4 of 11 active) likely from RF interference.' } });
  const joined = renderInterference(ctx(100, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/⚠ correlated mesh degradation/.test(joined), 'correlated state flagged');
  assert.ok(/4 of 11 active/.test(joined), 'the DETECTOR\'s own coherent ratio (from the narrative) is shown');
});

test('downsampleMean bins a long series into ≤cells means spanning the WHOLE series (not just the tail)', () => {
  // First half noisy (-90), second half quiet (-100). A tail-slice (the old bug)
  // would show only the quiet recent half; downsampling must surface BOTH.
  const vals = Array.from({ length: 100 }, (_, i) => (i < 50 ? -90 : -100));
  const ds = downsampleMean(vals, 24);
  assert.equal(ds.length, 24, 'reduced to the cell count');
  assert.equal(ds[0], -90, 'first cell reflects the OLDEST buckets — not lost to a tail slice');
  assert.equal(ds[ds.length - 1], -100, 'last cell reflects the newest');
  // A short series passes through unchanged (no binning needed).
  assert.deepEqual(downsampleMean([-100, -101], 24), [-100, -101]);
});

test('tall frames draw the persisted series as CHARTS, and add ink rather than moving it', () => {
  // The screen's problem was vertical: a six-day noise history and a 24-hour
  // diurnal profile were each compressed into ONE sparkline row, so data that
  // is collected and persisted across restarts was shown at a resolution that
  // could not answer the question it was collected for. Surplus rows now draw
  // them properly. The load-bearing property is that this ADDS characters —
  // rearranging content can never change the ink count, so a chart that merely
  // moved things would not show up here.
  const iv = cleanView({
    coverageDays: 6,
    diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h >= 18 && h <= 21 ? 0.09 : 0.01 })),
  });
  (iv.noise as { trendCoarse: number[]; trendCoarseDays: number }).trendCoarse =
    Array.from({ length: 200 }, (_, i) => -98 + Math.round(6 * Math.sin(i / 9)));
  (iv.noise as { trendCoarseDays: number }).trendCoarseDays = 6;

  const inkOf = (cols: number, rows: number): number =>
    renderInterference(ctx(cols, rows, iv))
      .reduce((n, l) => n + l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s/g, '').length, 0);

  const small = inkOf(80, 24);
  const tall = inkOf(200, 60);
  assert.ok(tall > small * 1.5,
    `a tall frame must draw substantially more, got ${small} -> ${tall}`);

  // …and the compact form is untouched: below the surplus threshold the screen
  // renders exactly as it did, so a small terminal pays nothing for this.
  const lines80 = renderInterference(ctx(80, 24, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.equal(lines80.length, 24);
  const chartish = lines80.filter((l) => /^\s+(-?\d+|\d+\.\d%)\s+[█▁▂▃▄▅▆▇ ]+$/.test(l)).length;
  assert.equal(chartish, 0, 'the 80x24 frame grew a chart it has no room for');

  // Every row still honours the frame contract at the tall size.
  for (const line of renderInterference(ctx(200, 60, iv))) {
    assert.ok(line.replace(/\x1b\[[0-9;]*m/g, '').length <= 200, 'a chart row overflowed the frame');
  }
});

/** The diurnal chart's rows only — between its section header and its hour
 *  axis. A looser "block glyphs, no letters" match also catches the NOISE
 *  chart, whose full blocks are legitimate on its own -110..-80 scale. */
function diurnalChart(cols: number, rows: number, iv: InterferenceView): string[] {
  const lines = renderInterference(ctx(cols, rows, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const head = lines.findIndex((l) => l.includes('DIURNAL'));
  const axis = lines.findIndex((l, k) => k > head && /\b0\b.*\b6\b.*\b12\b/.test(l));
  return head < 0 || axis < 0 ? [] : lines.slice(head + 1, axis);
}

test('the diurnal CHART uses the same absolute scale as the strip beneath it', () => {
  // The first version auto-scaled to the peak in flat yellow — exactly what
  // this screen's HEAT_MAX comment forbids. On a uniformly healthy mesh every
  // hour became a solid warning block sitting directly above a strip showing
  // all-clear light cells, for the SAME 24 numbers.
  const cool = cleanView({
    coverageDays: 6,
    diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: 0.008 })),
  });
  const chart = diurnalChart(100, 60, cool);
  assert.ok(chart.length > 0, 'the diurnal chart did not render on a tall frame');
  assert.equal(chart.filter((l) => /█/.test(l)).length, 0,
    `a 0.8% mesh drew FULL blocks — the chart is normalized, not absolute:\n${chart.join('\n')}`);

  // …and a genuinely hot hour DOES reach the top on the same fixed scale.
  const hot = cleanView({
    coverageDays: 6,
    diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h === 12 ? 0.06 : 0.008 })),
  });
  assert.ok(diurnalChart(100, 60, hot).some((l) => /█/.test(l)),
    'a real 6% hour must reach a full block on the absolute scale');
});

test('the diurnal chart marks an UNRATED hour as no-data, never as a measured 0%', () => {
  // `rate: null` means "too little traffic to rate", which the strip renders as
  // a grey dot. Substituting 0 drew a measured floor value that was never
  // observed — directly above the dot saying otherwise.
  const sparse = cleanView({
    coverageDays: 6,
    diurnal: Array.from({ length: 24 }, (_, h) => ({ hour: h, tx: 200, rate: h < 10 ? null : 0.03 })),
  });
  const baseline = diurnalChart(100, 60, sparse).find((l) => /^\s+0%\s/.test(l));
  assert.ok(baseline, 'chart baseline row not found');
  const cols = baseline!.replace(/^\s+0%\s/, '');
  assert.equal(cols.slice(0, 10), '·'.repeat(10),
    `unrated hours drew bars instead of no-data dots: ${JSON.stringify(cols.slice(0, 14))}`);
});

/* ── v0.35 (Z3-i): the correlated event states its SCOPE ───────────────────── */

test('an ACTIVE event reports how many distinct nodes are symptomatic', () => {
  // degradedNodes was computed for every view since M6 and only ever reached
  // the screen through the INACTIVE narrative — i.e. it went dark at exactly
  // the moment the operator needed to know how far the event reached.
  const iv = cleanView({ correlated: { active: true, degradedNodes: 7, narrative: 'Correlated mesh degradation (4 of 11 active).' } });
  const joined = renderInterference(ctx(120, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(joined, /4 of 11 active/, "the detector's own ratio still leads");
  assert.match(joined, /meanwhile · 7 nodes symptomatic across ALL detectors — not necessarily this event/,
    'labelled as the mesh-wide symptom count, NEVER as the event reach — unrelated faults are in this number');
});

test('an active event with no distinct count adds no companion line', () => {
  const iv = cleanView({ correlated: { active: true, degradedNodes: 0, narrative: 'Correlated mesh degradation.' } });
  const joined = renderInterference(ctx(120, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(!/meanwhile ·/.test(joined));
});

test('the INACTIVE case is untouched — the narrative still owns the count', () => {
  const iv = cleanView({ correlated: { active: false, degradedNodes: 2, narrative: '2 nodes degraded, but not correlated into a mesh event.' } });
  const joined = renderInterference(ctx(120, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(joined, /2 nodes degraded, but not correlated/);
  assert.ok(!/meanwhile ·/.test(joined), 'no duplicate count when the narrative already states it');
});

test('the companion line singularises, and the exact-rows contract still holds', () => {
  const iv = cleanView({ correlated: { active: true, degradedNodes: 1, narrative: 'Correlated mesh degradation (1 of 9 active).' } });
  const joined = renderInterference(ctx(120, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(joined, /1 node symptomatic across ALL detectors/);
  for (const [cols, rows] of [[60, 16], [96, 24], [120, 40], [200, 50]] as const) {
    const lines = renderInterference(ctx(cols, rows, iv));
    assert.equal(lines.length, rows, `${cols}x${rows}`);
    for (const l of lines) assert.ok(visLen(l) <= cols, `${cols}x${rows}`);
  }
});
