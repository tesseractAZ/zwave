import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masthead, titleRule, commandBar, fieldStrip, field, frame, linkState } from '../src/telnet/chrome';
import { visLen } from '../src/telnet/ansi';
import type { DataProvider, ViewState, ControllerSnapshot } from '../src/types';

const view = (cols: number, rows = 24) => ({ cols, rows }) as ViewState;
const SIZES = [40, 60, 80, 100, 120, 160, 200];

function mockData(over: Partial<DataProvider> = {}): DataProvider {
  const ctrl = { homeId: 3586281591 } as ControllerSnapshot;
  return {
    nodes: () => [], nodeById: () => undefined, controller: () => ctrl, events: () => [],
    scoreFor: () => ({ score: 0, rating: 0, grade: 'F', state: 'unknown', flags: [] }),
    noiseFloor: () => -92, hasRealNoise: () => false, history: () => ({ rssi: [], rtt: [] }),
    historyLong: () => ({ rssi: [], rtt: [] }), lastUpdated: () => Date.now(), ready: () => true, lastError: () => null, symptoms: () => [], engineStatus: () => ({ enabled: false, ready: 0, total: 0 }), efficacyFor: () => null,
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
