import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filteredEvents, clampLogCursor, logLayout, LOG_DETAIL_ROWS } from '../src/telnet/input';
import { mkEvent, mkView, mockData, NOW, HOUR, DAY } from './_logHelpers';

// A deterministic spread of events around the fixed NOW (local noon 2026-07-14).
const eNow = mkEvent({ ts: NOW, text: 'now' });
const e30m = mkEvent({ ts: NOW - 30 * 60_000, text: '30m' });
const e2h = mkEvent({ ts: NOW - 2 * HOUR, text: '2h', severity: 'error' });
const eYday = mkEvent({ ts: new Date(2026, 6, 13, 15, 0, 0).getTime(), text: 'yesterday 3pm' });
const e2d = mkEvent({ ts: new Date(2026, 6, 12, 10, 0, 0).getTime(), text: '2 days', severity: 'error' });
// events() is newest-first
const ALL = [eNow, e30m, e2h, eYday, e2d];

function texts(list: { text: string }[]): string[] {
  return list.map((e) => e.text);
}

test('range "all" returns the whole ring; "hour" only the last hour', () => {
  const data = mockData({ events: ALL });
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: 'all' }), NOW)), ['now', '30m', '2h', 'yesterday 3pm', '2 days']);
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: 'hour' }), NOW)), ['now', '30m']);
});

test('range "24h" and "7d" honour their windows', () => {
  const data = mockData({ events: ALL });
  // yesterday 3pm → today noon = 21h (in); 2 days → out
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: '24h' }), NOW)), ['now', '30m', '2h', 'yesterday 3pm']);
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: '7d' }), NOW)), ['now', '30m', '2h', 'yesterday 3pm', '2 days']);
});

test('range "today" keeps only calendar-today; "yesterday" only calendar-yesterday', () => {
  const data = mockData({ events: ALL });
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: 'today' }), NOW)), ['now', '30m', '2h']);
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: 'yesterday' }), NOW)), ['yesterday 3pm']);
});

test('a midnight event lands in "today", not "yesterday" (boundary is inclusive-low)', () => {
  const midnight = new Date(2026, 6, 14, 0, 0, 0).getTime();
  const data = mockData({ events: [mkEvent({ ts: midnight, text: 'midnight' })] });
  assert.deepEqual(texts(filteredEvents(data, mkView({ logRange: 'today' }), NOW)), ['midnight']);
  assert.equal(filteredEvents(data, mkView({ logRange: 'yesterday' }), NOW).length, 0);
});

test('errorsOnly narrows to error severity, and composes with a date range', () => {
  const data = mockData({ events: ALL });
  assert.deepEqual(texts(filteredEvents(data, mkView({ errorsOnly: true }), NOW)), ['2h', '2 days']);
  // errors AND today → only the 2h error
  assert.deepEqual(texts(filteredEvents(data, mkView({ errorsOnly: true, logRange: 'today' }), NOW)), ['2h']);
});

test('empty ring yields an empty filtered list for every range', () => {
  const data = mockData({ events: [] });
  for (const logRange of ['all', 'hour', '24h', 'today', 'yesterday', '7d'] as const) {
    assert.equal(filteredEvents(data, mkView({ logRange }), NOW).length, 0);
  }
});

test('clampLogCursor keeps the cursor inside the list, and resets on empty', () => {
  const v = mkView({ logCursor: 99, logScroll: 40 });
  clampLogCursor(v, 10);
  assert.equal(v.logCursor, 9);
  clampLogCursor(v, 0);
  assert.equal(v.logCursor, 0);
  assert.equal(v.logScroll, 0);
  const v2 = mkView({ logCursor: -5 });
  clampLogCursor(v2, 10);
  assert.equal(v2.logCursor, 0);
});

test('logLayout splits rows into list+detail, shows detail only when tall enough', () => {
  // Tall terminal → detail pane present; list = rows - header - legend - sep - detail.
  const tall = logLayout(46);
  assert.equal(tall.showDetail, true);
  assert.equal(tall.detailRows, LOG_DETAIL_ROWS);
  assert.equal(1 + tall.listRows + 1 + tall.detailRows + 1, 46); // header+list+sep+detail+legend
  // Short terminal → no detail pane; list = rows - header - legend.
  const short = logLayout(16);
  assert.equal(short.showDetail, false);
  assert.equal(short.detailRows, 0);
  assert.equal(1 + short.listRows + 1, 16);
  // Never returns a zero/negative list height even on a tiny terminal.
  assert.ok(logLayout(3).listRows >= 1);
  assert.ok(logLayout(1).listRows >= 1);
});
