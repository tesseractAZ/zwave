import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInterference } from '../src/telnet/screens/interference';
import { visLen } from '../src/telnet/ansi';
import type { DataProvider, ControllerSnapshot, ScreenCtx, ViewState, InterferenceView } from '../src/types';

const now = Date.now();
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;

const cleanView = (over: Partial<InterferenceView> = {}): InterferenceView => ({
  noise: { channels: [-101, -103, -103, -95], floor: -102, real: true, trend: [-101, -102, -103, -102, -101], band: 'clean' },
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
  ({ screen: 'interference', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', followTail: true, errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, iv: InterferenceView): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(iv), visibleNodes: [], filtering: false, actionsEnabled: true } as ScreenCtx);

test('INTERFERENCE holds EXACTLY view.rows lines within view.cols at every size + state', () => {
  const views = [
    cleanView(),
    cleanView({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], band: 'unknown' } }), // no driver-WS
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
  const iv = cleanView({ noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], band: 'unknown' } });
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
    return lines.find((l) => /[░▒▓█]/.test(l) && !/[A-Za-z]/.test(l))?.trim() ?? '';
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

test('correlated degradation is called out with the degraded/active ratio', () => {
  const iv = cleanView({ correlated: { active: true, degradedNodes: 4, narrative: 'Correlated mesh degradation (4 of 11 active) likely from RF interference.' } });
  const joined = renderInterference(ctx(100, 30, iv)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/⚠ correlated mesh degradation/.test(joined), 'correlated state flagged');
  assert.ok(/4 of 11 active/.test(joined), 'the DETECTOR\'s own coherent ratio (from the narrative) is shown');
});
