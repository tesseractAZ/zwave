import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteDrop, burstsOf, repeatsFrames, DUP_BURST_MIN, DUP_BIG_BURST, DUP_LOOKBACK_MS, DUP_KEEP } from '../src/zwave/repeatedFrames';
import { duplicateDropNodeId } from '../src/zwave/driverWsClient';

const NOW = Date.now();
const S = 1_000;
const drops = (start: number, n: number, gap = 2 * S) => Array.from({ length: n }, (_, i) => start + i * gap);

test('the driver\'s duplicate-drop line names its node; nothing else does (v0.74.0)', () => {
  const ev = (message: unknown, context: unknown = { type: 'node', source: 'controller', nodeId: 16 }) => ({ event: 'logging', message, context });
  assert.equal(duplicateDropNodeId(ev('Dropping message with invalid payload (Reason: Duplicate command (sequence number 203))')), 16);
  assert.equal(duplicateDropNodeId(ev(['Dropping message with invalid payload (Reason: Duplicate command (s', 'equence number 203))'])), 16, 'a wrapped line still counts');
  assert.equal(duplicateDropNodeId(ev('Dropping message with invalid payload (Reason: something else)')), null);
  assert.equal(duplicateDropNodeId(ev('Dropping message with invalid payload (Reason: Duplicate command)', { type: 'controller' })), null, 'no node context, no node');
  assert.equal(duplicateDropNodeId({ event: 'value updated', message: 'Duplicate command', context: { type: 'node', nodeId: 16 } }), null);
});

test('a burst is five drops inside a minute; the symptom wants two, or one of fifteen (v0.74.0)', () => {
  assert.equal(DUP_BURST_MIN, 5);
  assert.equal(DUP_BIG_BURST, 15);
  assert.deepEqual(burstsOf(drops(NOW - 3_600_000, 4), NOW), [], 'four drops are not a burst');
  assert.deepEqual(burstsOf(drops(NOW - 3_600_000, 5), NOW), [{ at: NOW - 3_600_000, n: 5 }]);
  assert.deepEqual(burstsOf(drops(NOW - 3_600_000, 5, 20 * S), NOW), [], 'five drops over 80 s are not a burst');
  const one = burstsOf(drops(NOW - 3_600_000, 12), NOW);
  assert.equal(repeatsFrames(one), false, 'one burst of twelve (node 50) is not yet a symptom');
  assert.equal(repeatsFrames(burstsOf(drops(NOW - 3_600_000, 20), NOW)), true, 'one of twenty (node 16) is');
  const two = burstsOf([...drops(NOW - 5 * 3_600_000, 5), ...drops(NOW - 3_600_000, 5)], NOW);
  assert.equal(two.length, 2);
  assert.equal(repeatsFrames(two), true);
  assert.deepEqual(burstsOf(drops(NOW - DUP_LOOKBACK_MS - 60 * S, 20), NOW), [], 'past the day it is forgotten');
});

test('the drop record forgets the old and keeps a cap (v0.74.0)', () => {
  let t: number[] = [NOW - DUP_LOOKBACK_MS - S];
  t = noteDrop(t, NOW);
  assert.deepEqual(t, [NOW]);
  for (let i = 0; i < DUP_KEEP + 10; i++) t = noteDrop(t, NOW + i);
  assert.equal(t.length, DUP_KEEP);
});
