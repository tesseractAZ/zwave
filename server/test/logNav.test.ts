import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyKey, logLayout, syncLogCursor } from '../src/telnet/input';
import { LOG_RANGE_ORDER } from '../src/types';
import type { InputEvent } from '../src/types';
import { anchorAt, mkEvent, mkNode, mkView, mockData } from './_logHelpers';

const arrow = (dir: 'up' | 'down' | 'left' | 'right'): InputEvent => ({ type: 'arrow', dir });
const ch = (c: string): InputEvent => ({ type: 'char', ch: c });
const enter: InputEvent = { type: 'enter' };

/** N events, all newest-first, node 7 associated. */
function manyEvents(n: number) {
  return Array.from({ length: n }, (_, i) => mkEvent({ ts: 1_000_000 - i, text: `e${i}`, nodeId: 7 }));
}

test('j / down move the log cursor toward older; k / up move back; edges are no-ops', () => {
  const data = mockData({ events: manyEvents(5) });
  const v = mkView({ logCursor: 0 });
  assert.equal(applyKey(v, ch('j'), data).redraw, true);
  assert.equal(v.logCursor, 1);
  assert.equal(applyKey(v, arrow('down'), data).redraw, true);
  assert.equal(v.logCursor, 2);
  applyKey(v, ch('k'), data);
  assert.equal(v.logCursor, 1);
  applyKey(v, arrow('up'), data);
  assert.equal(v.logCursor, 0);
  // At the top, up is a no-op (no redraw).
  assert.equal(applyKey(v, ch('k'), data).redraw, false);
  assert.equal(v.logCursor, 0);
});

test('G jumps to oldest, g back to newest', () => {
  const data = mockData({ events: manyEvents(30) });
  const v = mkView({ logCursor: 0 });
  applyKey(v, ch('G'), data);
  assert.equal(v.logCursor, 29);
  applyKey(v, ch('g'), data);
  assert.equal(v.logCursor, 0);
  // g at the top is a no-op.
  assert.equal(applyKey(v, ch('g'), data).redraw, false);
});

test('space pages by (listRows-1), clamped at the bottom; b pages back', () => {
  const data = mockData({ events: manyEvents(100) });
  const v = mkView({ rows: 24, logCursor: 0 });
  const page = logLayout(24).listRows - 1;
  applyKey(v, ch(' '), data);
  assert.equal(v.logCursor, page);
  applyKey(v, ch('b'), data);
  assert.equal(v.logCursor, 0);
  // Space near the end clamps to the last index, never past it.
  const v2 = mkView({ rows: 24 });
  anchorAt(v2, manyEvents(100), 98);
  applyKey(v2, ch(' '), data);
  assert.equal(v2.logCursor, 99);
});

test('d cycles the date range through LOG_RANGE_ORDER and resets the cursor', () => {
  const data = mockData({ events: manyEvents(5) });
  const v = mkView({ logRange: 'all', logCursor: 3 });
  for (let i = 1; i <= LOG_RANGE_ORDER.length; i++) {
    applyKey(v, ch('d'), data);
    assert.equal(v.logRange, LOG_RANGE_ORDER[i % LOG_RANGE_ORDER.length]);
  }
  assert.equal(v.logCursor, 0); // reset on filter change
});

test('o toggles errorsOnly, resets the cursor, and re-scopes navigation to the filtered list', () => {
  const events = [
    mkEvent({ ts: 5, text: 'ok', severity: 'info' }),
    mkEvent({ ts: 4, text: 'bad', severity: 'error' }),
    mkEvent({ ts: 3, text: 'ok2', severity: 'info' }),
  ];
  const data = mockData({ events });
  const v = mkView({ logCursor: 2 });
  applyKey(v, ch('o'), data);
  assert.equal(v.errorsOnly, true);
  assert.equal(v.logCursor, 0);
  // Only 1 error now → G lands on index 0, not 2.
  applyKey(v, ch('G'), data);
  assert.equal(v.logCursor, 0);
});

test('Enter jumps to the selected event’s node Detail and selects that node', () => {
  const nodes = [mkNode({ nodeId: 3, name: 'Kitchen' }), mkNode({ nodeId: 7, name: 'Garage' })];
  const events = [mkEvent({ ts: 2, seq: 2, nodeId: 7 }), mkEvent({ ts: 1, seq: 1, nodeId: 3 })];
  const data = mockData({ events, nodes });
  const v = mkView();
  anchorAt(v, events, 1); // the node-3 event
  const r = applyKey(v, enter, data);
  assert.equal(r.redraw, true);
  assert.equal(v.screen, 'detail');
  // node 3 is index 0 in the id-agnostic visibleNodes; selection points at it
  assert.equal(data.nodes()[v.selected].nodeId, 3);
});

test('Enter on a network-wide event (no node) stays on the log', () => {
  const data = mockData({ events: [mkEvent({ nodeId: null })] });
  const v = mkView();
  const r = applyKey(v, enter, data);
  assert.equal(v.screen, 'log');
  assert.equal(r.redraw, false);
});

test('a stale cursor is clamped before it moves (list shrank underneath it)', () => {
  const data = mockData({ events: manyEvents(3) });
  const v = mkView({ logCursor: 999 });
  applyKey(v, ch('k'), data); // any nav clamps first
  assert.ok(v.logCursor <= 2);
});

test('non-log keys fall through: 1 switches screen, q backs out to overview', () => {
  const data = mockData({ events: manyEvents(3) });
  const v = mkView({ screen: 'log' });
  applyKey(v, ch('1'), data); // screen 1 = overview
  assert.equal(v.screen, 'overview');
  const v2 = mkView({ screen: 'log' });
  applyKey(v2, ch('q'), data);
  assert.equal(v2.screen, 'overview'); // q on an overlay backs out, does not quit
});

test('a scrolled selection stays on the SAME event as new events prepend (no drift)', () => {
  const older = manyEvents(5);
  const v = mkView();
  anchorAt(v, older, 2); // highlight older[2]
  const targetSeq = older[2].seq;
  // three newer events stream in at the head of the newest-first ring
  const withNew = [
    mkEvent({ ts: 3_000_000, seq: 3_000_000, text: 'n1' }),
    mkEvent({ ts: 2_900_000, seq: 2_900_000, text: 'n2' }),
    mkEvent({ ts: 2_800_000, seq: 2_800_000, text: 'n3' }),
    ...older,
  ];
  syncLogCursor(v, withNew);
  assert.equal(withNew[v.logCursor].seq, targetSeq, 'same event still highlighted');
  assert.equal(v.logCursor, 5, 'cursor followed the event down by the 3 inserted above it');
});

test('cursor pinned to the top (follow-tail) tracks the newest as events prepend', () => {
  const older = manyEvents(5);
  const v = mkView(); // anchor null = follow-tail
  syncLogCursor(v, older);
  assert.equal(v.logCursor, 0);
  const withNew = [mkEvent({ ts: 9_000_000, seq: 9_000_000, text: 'newest' }), ...older];
  syncLogCursor(v, withNew);
  assert.equal(v.logCursor, 0);
  assert.equal(withNew[0].text, 'newest', 'still shows the newest');
});

test('an anchored event that scrolls out of the ring falls back to a clamped cursor', () => {
  const older = manyEvents(5);
  const v = mkView();
  anchorAt(v, older, 4); // the oldest event
  const shrunk = manyEvents(3); // does not contain older[4].seq
  syncLogCursor(v, shrunk);
  assert.equal(v.logCursor, 2, 'clamped to the last available row');
  assert.ok(v.logAnchorSeq === shrunk[2].seq, 're-anchored to a live event');
});

test('navigation on an empty log never throws and leaves the cursor at 0', () => {
  const data = mockData({ events: [] });
  const v = mkView();
  for (const k of [ch('j'), ch('k'), ch('G'), ch('g'), ch(' '), ch('b'), enter]) {
    assert.doesNotThrow(() => applyKey(v, k, data));
  }
  assert.equal(v.logCursor, 0);
});
