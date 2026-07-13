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

function mkStore(path: string, extra: Partial<HistoryStoreOptions> = {}) {
  return createHistoryStore({ path, now: () => FIXED, uptimeMs: () => UP, ...extra });
}

/** Build a HistoryMap; coarse tiers default to []. */
function mapOf(o: Record<number, { rssi: number[]; rtt: number[]; crssi?: number[]; crtt?: number[] }>): HistoryMap {
  return new Map(
    Object.entries(o).map(([k, v]) => [Number(k), { rssi: v.rssi, rtt: v.rtt, crssi: v.crssi ?? [], crtt: v.crtt ?? [] }]),
  );
}

test('round-trips both fine and coarse tiers', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 12: { rssi: [-60, -58], rtt: [30, 28], crssi: [-59, -57, -55], crtt: [29, 27, 25] } }));
  const back = mkStore(path).load();
  assert.deepEqual(back.get(12), { rssi: [-60, -58], rtt: [30, 28], crssi: [-59, -57, -55], crtt: [29, 27, 25] });
});

test('a coarse-only node (no fine samples) still persists', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 7: { rssi: [], rtt: [], crssi: [-70, -68], crtt: [] } }));
  assert.deepEqual(mkStore(path).load().get(7), { rssi: [], rtt: [], crssi: [-70, -68], crtt: [] });
});

test('v1 (fine-only) file still loads — coarse tier starts empty (back-compat)', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: FIXED, nodes: { 3: { rssi: [-50, -52], rtt: [10, 12] } } }));
  assert.deepEqual(mkStore(path).load().get(3), { rssi: [-50, -52], rtt: [10, 12], crssi: [], crtt: [] });
});

test('missing file → empty map (no throw)', () => {
  assert.equal(mkStore(join(tmpdir(), 'zwave-hist-does-not-exist', 'nope.json')).load().size, 0);
});

test('corrupt JSON → empty map (never throws)', () => {
  const path = freshPath();
  writeFileSync(path, '{ this is not json ]]');
  assert.equal(mkStore(path).load().size, 0);
});

test('unsupported schema version → empty map', () => {
  const path = freshPath();
  writeFileSync(path, JSON.stringify({ v: 999, savedAt: FIXED, nodes: { 3: { rssi: [-50], rtt: [10] } } }));
  assert.equal(mkStore(path).load().size, 0);
});

test('stale snapshot (older than maxAgeMs) is discarded; within-window is restored', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 5: { rssi: [-40], rtt: [5] } }));
  assert.equal(mkStore(path, { now: () => FIXED + 2 * 3600_000, maxAgeMs: 3600_000 }).load().size, 0);
  assert.equal(mkStore(path, { now: () => FIXED + 30 * 60_000, maxAgeMs: 3600_000 }).load().size, 1);
});

test('future-dated snapshot (clock stepped back since save) is discarded', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 6: { rssi: [-45], rtt: [7] } }));
  assert.equal(mkStore(path, { now: () => FIXED - 10 * 60_000 }).load().size, 0);
});

test('host-boot guard: fresh snapshot discarded while host uptime < bootGraceMs', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 8: { rssi: [-50], rtt: [9] } }));
  assert.equal(mkStore(path, { uptimeMs: () => 30_000 }).load().size, 0);
  assert.equal(mkStore(path, { uptimeMs: () => 200_000 }).load().size, 1);
  assert.equal(mkStore(path, { uptimeMs: () => 1, bootGraceMs: 0 }).load().size, 1);
});

test('maxAgeMs=0 disables the wall-clock guard', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 9: { rssi: [-33], rtt: [] } }));
  assert.equal(mkStore(path, { now: () => FIXED + 10 * 24 * 3600_000, maxAgeMs: 0 }).load().size, 1);
});

test('load caps fine to maxSamples and coarse to coarseMax (bloat guard)', () => {
  const path = freshPath();
  const big = Array.from({ length: 500 }, (_, i) => -40 - (i % 20));
  writeFileSync(path, JSON.stringify({ v: 2, savedAt: FIXED, nodes: { 4: { rssi: big, rtt: big, crssi: big, crtt: big } } }));
  const h = mkStore(path, { maxSamples: 60, coarseMax: 120 }).load().get(4)!;
  assert.equal(h.rssi.length, 60);
  assert.equal(h.crssi.length, 120);
  assert.deepEqual(h.rssi, big.slice(-60));
  assert.deepEqual(h.crssi, big.slice(-120));
});

test('drops malformed entries: bad ids, non-arrays, NaN, all-empty', () => {
  const path = freshPath();
  writeFileSync(
    path,
    JSON.stringify({
      v: 2,
      savedAt: FIXED,
      nodes: {
        '0': { rssi: [-50], rtt: [] },
        '-3': { rssi: [-50], rtt: [] },
        'abc': { rssi: [-50], rtt: [] },
        '8': { rssi: 'oops', rtt: null, crssi: 'x' },
        '9': { rssi: [-40, 'x', null, NaN, -42], rtt: [] },
        '10': { rssi: [], rtt: [], crssi: [], crtt: [] },
        '11': 42,
      },
    }),
  );
  const back = mkStore(path).load();
  assert.deepEqual([...back.keys()], [9]);
  assert.deepEqual(back.get(9), { rssi: [-40, -42], rtt: [], crssi: [], crtt: [] });
});

test('save is atomic: no .tmp left behind and the target is valid JSON (schema 2)', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 2: { rssi: [-51], rtt: [12], crssi: [-50], crtt: [11] } }));
  assert.equal(existsSync(`${path}.tmp`), false);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.v, 2);
  assert.equal(parsed.savedAt, FIXED);
  assert.deepEqual(parsed.nodes['2'], { rssi: [-51], rtt: [12], crssi: [-50], crtt: [11] });
});

test('save omits all-empty nodes from disk', () => {
  const path = freshPath();
  mkStore(path).save(mapOf({ 1: { rssi: [], rtt: [], crssi: [], crtt: [] }, 2: { rssi: [-50], rtt: [] } }));
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(parsed.nodes), ['2']);
});

test('save never throws on an unwritable path', () => {
  assert.doesNotThrow(() => mkStore('/proc/zwave-cannot-write/history.json').save(mapOf({ 1: { rssi: [-50], rtt: [1] } })));
});
