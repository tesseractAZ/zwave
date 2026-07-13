import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryStore, type HistoryMap, type HistoryStoreOptions } from '../src/zwave/historyStore';

/** A fresh, isolated history.json path in a throwaway temp dir. */
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zwave-hist-'));
  return join(dir, 'history.json');
}

const FIXED = 1_000_000_000_000; // fixed wall clock so save/load ages are deterministic
const UP = 3600_000; // "host up 1h" — well past the boot-grace, so guard (b) won't fire

/**
 * Build a store with deterministic test defaults (fixed clock, large host
 * uptime). Per-test overrides via `extra` exercise the individual guards.
 */
function mkStore(path: string, extra: Partial<HistoryStoreOptions> = {}) {
  return createHistoryStore({ path, now: () => FIXED, uptimeMs: () => UP, ...extra });
}

/** Build a HistoryMap from a plain object literal. */
function mapOf(o: Record<number, { rssi: number[]; rtt: number[] }>): HistoryMap {
  return new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
}

test('round-trips node rings byte-for-byte (values + keys preserved)', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 12: { rssi: [-60, -58, -55], rtt: [30, 28, 33] }, 7: { rssi: [-70], rtt: [] } }));

  const back = mkStore(path).load();
  assert.deepEqual([...back.keys()].sort((a, b) => a - b), [7, 12]);
  assert.deepEqual(back.get(12), { rssi: [-60, -58, -55], rtt: [30, 28, 33] });
  assert.deepEqual(back.get(7), { rssi: [-70], rtt: [] });
});

test('missing file → empty map (no throw)', () => {
  const store = mkStore(join(tmpdir(), 'zwave-hist-does-not-exist', 'nope.json'));
  assert.equal(store.load().size, 0);
});

test('corrupt JSON → empty map (never throws)', () => {
  const path = freshPath();
  writeFileSync(path, '{ this is not json ]]');
  assert.equal(mkStore(path).load().size, 0);
});

test('wrong schema version → empty map', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 999, savedAt: FIXED, nodes: { 3: { rssi: [-50], rtt: [10] } } }));
  assert.equal(mkStore(path).load().size, 0);
});

test('stale snapshot (older than maxAgeMs) is discarded; within-window is restored', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 5: { rssi: [-40], rtt: [5] } }));
  // Load 2h later with a 1h max age → discarded.
  assert.equal(mkStore(path, { now: () => FIXED + 2 * 3600_000, maxAgeMs: 3600_000 }).load().size, 0);
  // Same file, but within the age window → restored.
  assert.equal(mkStore(path, { now: () => FIXED + 30 * 60_000, maxAgeMs: 3600_000 }).load().size, 1);
});

test('future-dated snapshot (clock stepped back since save) is discarded', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 6: { rssi: [-45], rtt: [7] } })); // savedAt = FIXED
  // Load with an EARLIER wall clock → ageMs < 0 → discard.
  assert.equal(mkStore(path, { now: () => FIXED - 10 * 60_000 }).load().size, 0);
});

test('host-boot guard: fresh snapshot is discarded while host uptime < bootGraceMs', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 8: { rssi: [-50], rtt: [9] } })); // savedAt = FIXED, "fresh"
  // Host up only 30s (< 180s default) → pre-NTP clock suspect → discard even
  // though the wall-clock age (0) looks fresh.
  assert.equal(mkStore(path, { uptimeMs: () => 30_000 }).load().size, 0);
  // Once the host has been up past the grace, the same fresh snapshot restores.
  assert.equal(mkStore(path, { uptimeMs: () => 200_000 }).load().size, 1);
  // bootGraceMs=0 disables the guard entirely.
  assert.equal(mkStore(path, { uptimeMs: () => 1, bootGraceMs: 0 }).load().size, 1);
});

test('maxAgeMs=0 disables the wall-clock guard (loads regardless of age)', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 9: { rssi: [-33], rtt: [] } }));
  assert.equal(mkStore(path, { now: () => FIXED + 10 * 24 * 3600_000, maxAgeMs: 0 }).load().size, 1);
});

test('load caps each series to maxSamples (guards a bloated file)', () => {
  const path = freshPath();
  const big = Array.from({ length: 500 }, (_, i) => -40 - (i % 20));
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: FIXED, nodes: { 4: { rssi: big, rtt: big } } }));
  const back = mkStore(path, { maxSamples: 60 }).load();
  const h = back.get(4)!;
  assert.equal(h.rssi.length, 60);
  assert.equal(h.rtt.length, 60);
  // Keeps the MOST RECENT samples (tail), not the head.
  assert.deepEqual(h.rssi, big.slice(-60));
});

test('drops malformed entries: bad ids, non-arrays, NaN/non-finite, empty rings', () => {
  const path = freshPath();
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      savedAt: FIXED,
      nodes: {
        '0': { rssi: [-50], rtt: [] },          // id 0 → dropped (must be > 0)
        '-3': { rssi: [-50], rtt: [] },          // negative id → dropped
        'abc': { rssi: [-50], rtt: [] },         // non-numeric key → dropped
        '8': { rssi: 'oops', rtt: null },        // non-array series → both empty → dropped
        '9': { rssi: [-40, 'x', null, NaN, -42], rtt: [] }, // non-finite filtered out
        '10': { rssi: [], rtt: [] },             // empty rings → dropped
        '11': 42,                                // non-object → dropped
      },
    }),
  );
  const back = mkStore(path).load();
  assert.deepEqual([...back.keys()], [9]);
  assert.deepEqual(back.get(9), { rssi: [-40, -42], rtt: [] });
});

test('save is atomic: no .tmp left behind and the target is valid JSON', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 2: { rssi: [-51, -52], rtt: [12] } }));
  assert.equal(existsSync(`${path}.tmp`), false, 'temp file must be renamed away');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.v, 1);
  assert.equal(parsed.savedAt, FIXED);
  assert.deepEqual(parsed.nodes['2'], { rssi: [-51, -52], rtt: [12] });
});

test('save omits empty-ring nodes from disk', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 1: { rssi: [], rtt: [] }, 2: { rssi: [-50], rtt: [] } }));
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(parsed.nodes), ['2']);
});

test('save never throws on an unwritable path', () => {
  const store = mkStore('/proc/zwave-cannot-write/history.json');
  assert.doesNotThrow(() => store.save(mapOf({ 1: { rssi: [-50], rtt: [1] } })));
});
