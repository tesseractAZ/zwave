import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masthead, titleRule, commandBar, fieldStrip, field, frame, linkState, shedLine } from '../src/telnet/chrome';
import { clipWords, visLen } from '../src/telnet/ansi';
import type { DataProvider, ViewState, ControllerSnapshot } from '../src/types';

const view = (cols: number, rows = 24) => ({ cols, rows }) as ViewState;
const SIZES = [40, 60, 80, 100, 120, 160, 200];

function mockData(over: Partial<DataProvider> = {}): DataProvider {
  const ctrl = { homeId: 3586281591 } as ControllerSnapshot;
  return {
    nodes: () => [], nodeById: () => undefined, controller: () => ctrl, events: () => [],
    scoreFor: () => ({ score: 0, grade: 'F', state: 'unknown', flags: [] }),
    noiseFloor: () => -92, hasRealNoise: () => false, history: () => ({ rssi: [], rtt: [] }),
    historyLong: () => ({ rssi: [], rtt: [] }), lastUpdated: () => Date.now(), ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 0, bands: 6 }), efficacyFor: () => null, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  openEpisodes: () => [],
  controlArm: () => null,
  autoPingState: () => null,
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
    ...over,
  };
}

const okWidth = (s: string, cols: number, label: string) => {
  assert.ok(visLen(s) <= cols, `${label}: width ${visLen(s)} > ${cols}`);
  assert.ok(!s.includes('undefined'), `${label}: leaked "undefined"`);
};

test('masthead / titleRule / commandBar / fieldStrip never exceed cols', () => {
  const now = 1_700_000_000_000;
  for (const cols of SIZES) {
    for (const link of ['online', 'stale', 'offline'] as const) {
      okWidth(masthead(view(cols), { link, homeId: 3586281591, now }), cols, `masthead ${cols} ${link}`);
    }
    okWidth(titleRule(view(cols), 'OVERVIEW', 'END 39 · 2 DIRECT'), cols, `titleRule ${cols}`);
    okWidth(titleRule(view(cols), 'A VERY LONG SCREEN TITLE THAT MUST CLIP', ''), cols, `titleRule-long ${cols}`);
    okWidth(commandBar(view(cols), [['1-6', 'SCREENS'], ['A', 'ACTIONS'], ['Q', 'EXIT']]), cols, `commandBar ${cols}`);
    okWidth(fieldStrip(view(cols), [field('NODES', '39'), field('DEAD', '1'), field('NOISE', '-92 dBm')]), cols, `fieldStrip ${cols}`);
  }
});

test('frame returns EXACTLY view.rows lines, each within cols, across sizes', () => {
  for (const cols of SIZES) {
    for (const rows of [8, 16, 24, 46]) {
      const body = Array.from({ length: 60 }, (_, i) => `row ${i} `.repeat(20)); // deliberately overlong + overflowing
      const out = frame(view(cols, rows), mockData(), {
        title: 'CONTROLLER & NETWORK',
        rightStatus: 'NODE 1 · ZST39 LR',
        telemetry: fieldStrip(view(cols, rows), [field('A', '1'), field('B', '2')]),
        body,
        keys: [['1-6', 'SCREENS'], ['Q', 'BACK']],
      });
      assert.equal(out.length, rows, `frame ${cols}x${rows}: exactly ${rows} rows`);
      out.forEach((l, i) => okWidth(l, cols, `frame ${cols}x${rows} row ${i}`));
    }
  }
});

test('frame pads a short body and still lands the command bar on the last row', () => {
  const out = frame(view(100, 20), mockData(), { title: 'HEATMAP', body: ['one', 'two'], keys: [['Q', 'BACK']] });
  assert.equal(out.length, 20);
  assert.match(out[out.length - 1].replace(/\x1b\[[0-9;?]*m/g, ''), /\[Q\] BACK/);
});

test('linkState: online (fresh) / stale (old) / offline (error)', () => {
  assert.equal(linkState(mockData({ lastError: () => null, lastUpdated: () => Date.now() })), 'online');
  assert.equal(linkState(mockData({ lastError: () => null, lastUpdated: () => Date.now() - 60_000 })), 'stale');
  assert.equal(linkState(mockData({ lastError: () => null, lastUpdated: () => null })), 'stale');
  assert.equal(linkState(mockData({ lastError: () => 'boom' })), 'offline');
});

const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, '');

/* ── v0.45.0: shedLine, the shared whole-token composer ────────────────────── */

test('shedLine drops WHOLE tail tokens right-to-left, disclosing the count', () => {
  const ids = ['#4', '#17', '#23', '#31', '#42'];
  const wide = shedLine('  ', 'downstream', ids, 200);
  assert.equal(wide.length, 1);
  assert.match(strip(wide[0]), /#4 · #17 · #23 · #31 · #42$/, 'all of them fit');

  // As the terminal narrows, ids leave WHOLE and the drop is disclosed.
  for (let cols = 20; cols <= 60; cols++) {
    const [row] = shedLine('  ', 'downstream', ids, cols);
    const plain = strip(row);
    assert.ok(plain.length <= cols, `${cols}: overflow — "${plain}"`);
    for (const tok of plain.match(/#\d+/g) ?? []) {
      assert.ok(ids.includes(tok), `${cols}: "${tok}" is a CLIPPED id, not one of the real ones — "${plain}"`);
    }
    const shown = (plain.match(/#\d+/g) ?? []).length;
    if (shown < ids.length && shown > 0) {
      assert.ok(plain.includes(`+${ids.length - shown}`), `${cols}: silent drop — "${plain}"`);
    }
  }
});

test('shedLine never emits a row wider than the terminal, even when the HEAD alone overflows', () => {
  // The head is never SHED — but "never shed" is not "never bounded". Callers
  // that go through frame() are truncated downstream, so this contract is only
  // observable here; a future caller outside frame() would inherit the bug.
  const head = 'X'.repeat(300);
  for (const cols of [10, 40, 80]) {
    const rows = shedLine('    ', head, ['#4', '#17'], cols);
    for (const r of rows) assert.ok(strip(r).length <= cols, `${cols}: "${strip(r).slice(0, 60)}"`);
  }
});

test('shedLine carries a load-bearing tail to a continuation row when asked', () => {
  // The blocked-reason chip is the one thing on a "NOT recommended" row an
  // operator must read; dropping it with a `+1` would be a disclosed lie.
  const reason = '⊘ RF-link symptom — will not repair it';
  const rows = shedLine('      ', 'X'.repeat(50), [reason], 80, true);
  assert.ok(rows.length >= 2, 'it moved below rather than being dropped');
  const joined = rows.map(strip).map((r) => r.trim()).join(' ').replace(/\s+/g, ' ');
  assert.match(joined, /⊘ RF-link symptom — will not repair it/, 'and it arrived WHOLE');
  for (const r of rows) assert.ok(strip(r).length <= 80);
});

test('shedLine without wrapTail discloses the drop instead of carrying it', () => {
  const rows = shedLine('      ', 'X'.repeat(60), ['a very long advisory tail indeed'], 80, false);
  assert.equal(rows.length, 1, 'one row');
  assert.match(strip(rows[0]), /\+1$/, 'and it says something is missing');
});

test('shedLine with no tail is just the head', () => {
  assert.deepEqual(shedLine('  ', 'bare', [], 40).map(strip), ['  bare']);
});

/* ── v0.47.0: the standing auto-ping suppression chip ─────────────────────── */

test('a SUPPRESSED sweep shows a standing chip; a running one shows nothing', () => {
  // Suppression was legible only on the ENGINE screen. An operator on OVERVIEW
  // watching a node go quiet had no way to know the one autonomous prober had
  // stood down — the mesh looked the same as one being actively watched.
  const v = view(120);
  const base = { link: 'online' as const, homeId: 1, now: 1_700_000_000_000 };
  const off = strip(masthead(v, base));
  assert.doesNotMatch(off, /AUTO-PING/, 'absent value ⇒ no chip');
  assert.doesNotMatch(strip(masthead(v, { ...base, apSuppressed: 'none' })), /AUTO-PING/,
    '"none" is not a suppression — an always-on chip is noise');
  const on = strip(masthead(v, { ...base, apSuppressed: 'storm' }));
  assert.match(on, /⚠ AUTO-PING STORM/, `the chip must render: "${on}"`);
});

test('the suppression chip outranks HOME and the timestamp for space', () => {
  // `lr` truncates the LEFT first but falls back to truncating the RIGHT once
  // that side alone exceeds the width — and the chip sits at the front of that
  // side, so a naive join clips the alarm mid-word.
  const base = { link: 'online' as const, homeId: 3586281591, now: 1_700_000_000_000 };
  for (const cols of [40, 56, 72, 80, 100, 120, 200]) {
    const out = strip(masthead(view(cols), { ...base, apSuppressed: 'rebuild' }));
    assert.ok(out.length <= cols, `${cols}: overflow — "${out}"`);
    assert.match(out, /⚠ AUTO-PING REBUILD/,
      `${cols}: the alarm must survive, whole — "${out}"`);
  }
});

test('every masthead field is WHOLE or absent — never a clipped home id', () => {
  const base = { link: 'online' as const, homeId: 3586281591, now: 1_700_000_000_000 };
  // A wide terminal must actually CARRY the optional fields — otherwise
  // "whole or absent" is satisfied vacuously by dropping everything.
  const wide = strip(masthead(view(200), { ...base, apSuppressed: 'storm' }));
  assert.match(wide, /HOME 3586281591/, `wide terminals keep HOME: "${wide}"`);
  assert.match(wide, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'and the timestamp');
  assert.match(wide, /⚠ AUTO-PING STORM/, 'and the alarm');
  // And the ladder DEGRADES rather than collapsing: at 80 columns the home id
  // is shed but the timestamp survives, because a live clock is worth more
  // than an id the operator can read on any other screen. An all-or-nothing
  // fallback would drop both.
  const mid = strip(masthead(view(80), { ...base, apSuppressed: 'storm' }));
  assert.match(mid, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `80 cols keeps the clock: "${mid}"`);
  assert.doesNotMatch(mid, /HOME/, `and sheds the home id: "${mid}"`);
  for (const cols of [40, 56, 72, 80, 100, 120, 200]) {
    const out = strip(masthead(view(cols), { ...base, apSuppressed: 'storm' }));
    if (/HOME/.test(out)) {
      assert.match(out, /HOME 3586281591/, `${cols}: home id clipped — "${out}"`);
    }
    // A timestamp, if present, is complete.
    const ts = /(\d{4}-\d{2}-\d{2}[^ ]*|\d{2}:\d{2}:\d{2})/.exec(out);
    if (ts && /\d{4}-\d{2}-\d{2}/.test(ts[0])) {
      assert.match(out, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `${cols}: timestamp clipped — "${out}"`);
    }
  }
});

test('clipWords marks a shortened string, and the marker cannot read as content (v0.51.0)', () => {
  // The motivating case: a number is the worst thing to clip, because the cut
  // result is itself a valid number. `140…` would still read as "1400", so the
  // marker is SEPARATED — that gap is what makes it a marker.
  const out = clipWords('consumption 812 1240 and climbing', 20);
  assert.ok(visLen(out) <= 20, `never exceeds the budget: "${out}" (${visLen(out)})`);
  assert.match(out, / …$/, `a shortened string carries a separated marker: "${out}"`);
  assert.doesNotMatch(out, /\d…/, 'the marker must never abut a digit — it would read as another digit');
  // A whole word is never cut in half.
  assert.doesNotMatch(out.replace(/ …$/, ''), /\b124$|\b12$/, `no half-number: "${out}"`);
  // Fits already: returned untouched, no marker.
  assert.equal(clipWords('short', 20), 'short');
  // A single over-long token cannot be shed whole — clip it, marker flush,
  // because the cut is already visible INSIDE the word.
  const one = clipWords('supercalifragilisticexpialidocious', 10);
  assert.ok(visLen(one) <= 10, `over-long token still respects the budget: "${one}"`);
  assert.match(one, /…$/, 'an over-long token is still marked');
});
