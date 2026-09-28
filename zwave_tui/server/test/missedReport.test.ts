import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeStatus, type NodeSnapshot } from '../src/types';
import {
  unitMs, findDeclared, declaredFrom, sleeperWatch, MISSED_WATCH_MULT, MISSED_WARN_MULT,
  type WatchInput, type Declared,
} from '../src/zwave/missedReport';

const NOW = Date.now();
const MIN = 60_000;
const P = 70 * MIN;
const node = (over: Partial<NodeSnapshot> = {}): NodeSnapshot =>
  ({ nodeId: 61, name: 'Hallway Closet Motion', status: NodeStatus.Alive, isListening: false, isController: false,
    stats: { lastSeen: NOW - 10 * MIN }, ...over } as unknown as NodeSnapshot);
const beat: Declared = { ms: P, source: 'heartbeat' };
const inp = (over: Partial<WatchInput> = {}): WatchInput =>
  ({ node: node(), declared: beat, linkLive: true, lastRfOnAt: null, rfWatchSince: NOW - 48 * 3_600_000, now: NOW, ...over });
const silent = (ms: number) => node({ stats: { lastSeen: NOW - ms } } as Partial<NodeSnapshot>);

test('units convert, and an unknown unit is not guessed (v0.73.0)', () => {
  assert.equal(unitMs('minutes'), 60_000);
  assert.equal(unitMs('Minutes '), 60_000);
  assert.equal(unitMs('seconds'), 1_000);
  assert.equal(unitMs('h'), 3_600_000);
  assert.equal(unitMs('x 10 seconds'), null);
  assert.equal(unitMs(undefined), null);
});

test('the declaration is read from a heartbeat parameter or the Wake Up interval, which wins (v0.73.0)', () => {
  const ring = [
    { commandClass: 112, endpoint: 0, property: 2, value: 5, metadata: { label: 'Application Retries' } },
    { commandClass: 112, endpoint: 0, property: 1, value: 70, metadata: { label: 'Heartbeat Interval', unit: 'minutes' } },
  ];
  const r = findDeclared(ring);
  assert.ok('ref' in r);
  assert.deepEqual(declaredFrom(r.ref, r.value), { ms: 70 * MIN, source: 'heartbeat' });
  const w = findDeclared([...ring, { commandClass: 132, endpoint: 0, property: 'wakeUpInterval', value: 3600, metadata: { unit: 'seconds' } }]);
  assert.ok('ref' in w);
  assert.equal(w.ref.commandClass, 132);
  assert.deepEqual(declaredFrom(w.ref, w.value), { ms: 3_600_000, source: 'wake-up' });
  assert.deepEqual(findDeclared([{ commandClass: 112, property: 3, value: 5, metadata: { label: 'LED Indicator' } }]), { reason: 'no-declared-interval' });
  assert.deepEqual(findDeclared([{ commandClass: 112, property: 9, value: 6, metadata: { label: 'Heartbeat Time', unit: 'x 10 seconds' } }]), { reason: 'unit-unknown' });
  assert.deepEqual(findDeclared([]), { reason: 'no-declared-interval' });
});

test('an interval of 0 is disabled, and a non-number is not a declaration (v0.73.0)', () => {
  const ref = { commandClass: 132 as const, endpoint: 0, property: 'wakeUpInterval', propertyKey: null, unitMs: 1_000 };
  assert.deepEqual(declaredFrom(ref, 0), { reason: 'interval-disabled' });
  assert.deepEqual(declaredFrom(ref, null), { reason: 'no-declared-interval' });
  assert.deepEqual(declaredFrom(ref, -5), { reason: 'no-declared-interval' });
  assert.deepEqual(declaredFrom(ref, Number.NaN), { reason: 'no-declared-interval' });
});

test('a mains node or the controller is not a sleeper at all (v0.73.0)', () => {
  assert.equal(sleeperWatch(inp({ node: node({ isListening: true }) })), null);
  assert.equal(sleeperWatch(inp({ node: node({ isController: true }) })), null);
});

test('every way a sleeper is not watched is named (v0.73.0)', () => {
  assert.equal(sleeperWatch(inp({ node: node({ isListening: null }) }))?.reason, 'flags-unknown');
  assert.equal(sleeperWatch(inp({ node: node({ status: NodeStatus.Dead }) }))?.reason, 'dead');
  assert.equal(sleeperWatch(inp({ declared: null }))?.reason, 'no-declared-interval');
  assert.equal(sleeperWatch(inp({ declared: { reason: 'interval-disabled' } }))?.reason, 'interval-disabled');
  assert.equal(sleeperWatch(inp({ linkLive: false }))?.reason, 'link-not-live');
  assert.equal(sleeperWatch(inp({ node: node({ stats: { lastSeen: null } } as Partial<NodeSnapshot>) }))?.reason, 'never-heard');
  const w = sleeperWatch(inp())!;
  assert.equal(w.watched, true);
  assert.equal(w.reason, null);
  const off = sleeperWatch(inp({ linkLive: false, node: silent(10 * P) }))!;
  assert.equal(off.watched, false);
  assert.equal(off.severity, null, 'a blind watch never alarms');
});

test('watch past 1.5 intervals, warn past 2.5 (v0.73.0)', () => {
  assert.equal(MISSED_WATCH_MULT, 1.5);
  assert.equal(MISSED_WARN_MULT, 2.5);
  assert.equal(sleeperWatch(inp({ node: silent(1.5 * P) }))!.severity, null, 'exactly 1.5 intervals is not yet a miss');
  assert.equal(sleeperWatch(inp({ node: silent(1.5 * P + 1) }))!.severity, 'watch');
  assert.equal(sleeperWatch(inp({ node: silent(2.5 * P) }))!.severity, 'watch');
  assert.equal(sleeperWatch(inp({ node: silent(2.5 * P + 1) }))!.severity, 'warn');
  // The Ring sensors run about 1.7 % slow: a healthy 71.2 min gap never trips.
  assert.equal(sleeperWatch(inp({ node: silent(71.2 * MIN) }))!.severity, null);
});

test('a silence spanning a radio-off, or not watched throughout, gets one more interval (v0.73.0)', () => {
  const s = silent(1.6 * P);
  assert.equal(sleeperWatch(inp({ node: s }))!.severity, 'watch');
  const spanned = sleeperWatch(inp({ node: s, lastRfOnAt: NOW - 30 * MIN }))!;
  assert.equal(spanned.severity, null);
  assert.equal(spanned.radioAllowance, true);
  assert.equal(sleeperWatch(inp({ node: s, lastRfOnAt: NOW - 2 * P }))!.severity, 'watch', 'a radio-off before the last report does not count');
  assert.equal(sleeperWatch(inp({ node: s, rfWatchSince: null }))!.severity, null, 'a dark log stream cannot see a radio-off');
  assert.equal(sleeperWatch(inp({ node: s, rfWatchSince: NOW - 10 * MIN }))!.severity, null, 'nor a stream that started after the last report');
  assert.equal(sleeperWatch(inp({ node: silent(2.6 * P), lastRfOnAt: NOW - 30 * MIN }))!.severity, 'watch', 'the allowance is one interval, not a pass');
  assert.equal(sleeperWatch(inp({ node: silent(3.6 * P), lastRfOnAt: NOW - 30 * MIN }))!.severity, 'warn');
});
