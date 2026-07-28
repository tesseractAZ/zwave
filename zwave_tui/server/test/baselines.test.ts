import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaselineStore, bandOf, N_BANDS, RSSI_MAD_FLOOR, type BaselineStoreOptions } from '../src/zwave/baselines';
import { NodeStatus } from '../src/types';
import type { EvidenceSample } from '../src/zwave/evidenceStore';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'zwave-bl-')), 'baselines.json');
}
const DAY = 86_400_000;
const NOON = 12 * 3_600_000; // a fixed within-day offset (band 3 of 6)
const T0 = 400 * DAY + NOON; // deterministic base timestamp
const UP = 3_600_000;

function mk(path: string, extra: Partial<BaselineStoreOptions> = {}) {
  return createBaselineStore({ path, now: () => T0, uptimeMs: () => UP, ...extra });
}

/** A minimal fresh evidence sample. */
function sample(over: Partial<EvidenceSample> = {}): EvidenceSample {
  return {
    t: T0, dTx: 100, dTimeout: 0, dDropTx: 0, dRx: 10, dFlaps: 0, dRouteChanges: 0,
    fresh: true, rtt: 30, rssi: -60, rateKbps: 100, routeKey: 'direct',
    status: NodeStatus.Alive, lastSeen: null, isListening: null, isFrequentListening: null, ...over,
  };
}

/** Feed N observations across `days` distinct days so a band can graduate. */
function train(s: ReturnType<typeof createBaselineStore>, id: number, n: number, days: number, per: Partial<EvidenceSample>) {
  for (let i = 0; i < n; i++) {
    const day = Math.floor((i / n) * days);
    s.observe(id, sample({ ...per, t: T0 - (days - day) * DAY }), false);
  }
}

test('bandOf splits the local day into N_BANDS by hour', () => {
  const at = (h: number) => new Date(2026, 0, 15, h, 30, 0).getTime();
  assert.equal(bandOf(at(0)), 0); // midnight → band 0
  assert.equal(bandOf(at(12)), 3); // noon → band 3 of 6 (4h bands)
  assert.equal(bandOf(at(23)), N_BANDS - 1); // last hour → last band
});

test('a band does NOT graduate before MIN_OBS × MIN_DAYS, then does', () => {
  const s = mk(freshPath());
  // 5 obs across 1 day — not enough.
  train(s, 6, 5, 1, { dTimeout: 2 });
  assert.equal(s.timeoutNormal(6, T0)?.ready, false);
  // 30 obs across 4 distinct days — graduates.
  train(s, 6, 30, 4, { dTimeout: 2 });
  const norm = s.timeoutNormal(6, T0)!;
  assert.equal(norm.ready, true);
  assert.ok(norm.rate > 0.01 && norm.rate < 0.05, `learned ~2% rate, got ${norm.rate}`);
});

test('timeout rate ignores invalid/no-traffic windows (null dTx, or dTx below the floor)', () => {
  const s = mk(freshPath());
  train(s, 6, 30, 4, { dTimeout: 5, dTx: 100 }); // rate ~5%
  const before = s.timeoutNormal(6, T0)!.rate;
  // Null-window and tiny-traffic samples must not move the learned rate.
  s.observe(6, sample({ dTx: null, dTimeout: null }), false);
  s.observe(6, sample({ dTx: 1, dTimeout: 1 }), false); // below MIN denominator? still folded (rate uses Σ) — but 1 tx is negligible
  const after = s.timeoutNormal(6, T0)!.rate;
  assert.ok(Math.abs(after - before) < 0.01, 'invalid/tiny windows barely move the baseline');
});

test('rssi baseline learns median + a MAD scale that never drops below the precision floor', () => {
  const s = mk(freshPath());
  // Tight cluster at −60 dBm → true MAD ≈ 0, must floor to RSSI_MAD_FLOOR.
  train(s, 6, 40, 5, { rssi: -60 });
  const n = s.rssiNormal(6, T0)!;
  assert.equal(n.ready, true);
  assert.ok(Math.abs(n.median - (-60)) <= 2, `median near −60, got ${n.median}`);
  assert.ok(n.scale >= RSSI_MAD_FLOOR, `scale floored to ≥${RSSI_MAD_FLOOR}, got ${n.scale}`);
});

test('a routeKey change RESETS the rssi/rtt baselines (a new route is a different reality)', () => {
  const s = mk(freshPath());
  train(s, 6, 40, 5, { rssi: -60, routeKey: 'direct' });
  assert.equal(s.rssiNormal(6, T0)!.ready, true);
  // One sample on a NEW route resets the histogram → no longer ready.
  s.observe(6, sample({ rssi: -80, routeKey: 'r7' }), false);
  assert.equal(s.rssiNormal(6, T0)!.ready, false, 'route change wiped the learned rssi normal');
});

test('QUARANTINE: a symptomatic node does not update its baseline (no chasing the pathology)', () => {
  const s = mk(freshPath());
  train(s, 6, 30, 4, { dTimeout: 2 }); // ~2% normal
  const base = s.timeoutNormal(6, T0)!.rate;
  // 50 bad observations while quarantined must NOT move the baseline.
  for (let i = 0; i < 50; i++) s.observe(6, sample({ dTimeout: 60 }), true);
  assert.equal(s.timeoutNormal(6, T0)!.rate, base, 'quarantined observations were ignored');
});

test('stale/only-non-fresh rssi samples do not train the continuous baseline (pseudo-replication guard)', () => {
  const s = mk(freshPath());
  for (let i = 0; i < 50; i++) s.observe(6, sample({ rssi: -60, fresh: false, t: T0 - (i % 5) * DAY }), false);
  assert.equal(s.rssiNormal(6, T0)!.ready, false, 'non-fresh samples never graduate the rssi band');
});

test('persistence: baselines round-trip', () => {
  const path = freshPath();
  const s = mk(path);
  train(s, 6, 40, 5, { dTimeout: 3, rssi: -62 });
  s.save();
  const s2 = mk(path);
  s2.load();
  assert.equal(s2.timeoutNormal(6, T0)?.ready, true);
  assert.equal(s2.rssiNormal(6, T0)?.ready, true);
  assert.ok(Math.abs(s2.rssiNormal(6, T0)!.median - (-62)) <= 2);
});

test('BOOT-GRACE KEEPS baselines (opposite of the evidence fine ring — they are age-judgment-free)', () => {
  const path = freshPath();
  const s = mk(path);
  train(s, 6, 40, 5, { dTimeout: 3 });
  s.save();
  // Reload during boot-grace (tiny uptime): baselines MUST survive — a daily
  // power blip cannot be allowed to wipe weeks of learning.
  const booting = createBaselineStore({ path, now: () => T0, uptimeMs: () => 5_000, bootGraceMs: 180_000 });
  booting.load();
  assert.equal(booting.timeoutNormal(6, T0)?.ready, true, 'baselines survived boot-grace');
});

test('resetNode drops one node; reset() drops all + rewrites disk', () => {
  const path = freshPath();
  const s = mk(path);
  train(s, 6, 40, 5, { dTimeout: 3 });
  train(s, 7, 40, 5, { dTimeout: 3 });
  s.resetNode(6);
  assert.equal(s.timeoutNormal(6, T0), null);
  assert.equal(s.timeoutNormal(7, T0)?.ready, true);
  s.reset();
  assert.equal(s.timeoutNormal(7, T0), null);
  const reloaded = mk(path);
  reloaded.load();
  assert.equal(reloaded.timeoutNormal(7, T0), null, 'reset was written through to disk');
});

test('load survives a corrupt file and a wrong-length histogram without throwing', () => {
  const path = freshPath();
  writeFileSync(path, '{"v":1,"savedAt":' + T0 + ',"nodes":{"6":{"timeout":"bad","rssi":[{"bins":[1,2]}]}}}');
  const s = mk(path);
  assert.doesNotThrow(() => s.load());
  // Malformed node coerces to an empty (not-ready) baseline, never a crash.
  assert.equal(s.timeoutNormal(6, T0)?.ready, false);
});
