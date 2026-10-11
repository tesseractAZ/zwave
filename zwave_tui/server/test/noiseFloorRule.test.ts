/**
 * One rule for "is this background-RSSI value a noise-floor reading" (v0.75.2).
 *
 * Before it, the screens' floor and their "measured" tags kept -128 dBm while
 * the detectors and the health score dropped it, and the detectors' "measured"
 * flag only asked whether a driver sample existed. So with every channel at the
 * driver's "no signal detected" stand-in the screens showed `-128 dBm
 * (measured)`, the health score used -95, and weak-signal called its -95
 * fallback measured. These tests feed the SAME channels to every consumer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noiseReading, medianNoiseFloor, NOISE_FLOOR_MIN_DBM, DEFAULT_NOISE_FLOOR } from '../src/zwave/health';
import { computeInterference } from '../src/zwave/interference';
import { createTuiDataProvider } from '../src/telnet/dataProvider';
import type { ControllerSnapshot } from '../src/types';

test('noiseReading: finite, negative, and above -120 dBm (v0.75.2)', () => {
  assert.equal(NOISE_FLOOR_MIN_DBM, -120);
  for (const v of [-104, -119.9, -0.5, -60]) assert.equal(noiseReading(v), v, `${v} is a reading`);
  for (const v of [-120, -128, -125, 0, 0.5, 126, 127, Number.NaN, Number.NEGATIVE_INFINITY, null, undefined]) {
    assert.equal(noiseReading(v as number | null | undefined), null, `${v} is not a reading`);
  }
});

test('medianNoiseFloor: the median of the readings in the leading run of channels (v0.75.2)', () => {
  assert.equal(medianNoiseFloor([-104, -104, -101, -93]), -102.5);
  assert.equal(medianNoiseFloor([-125, -104, -101, -93]), -101, '"no signal detected" stand-ins are not readings');
  assert.equal(medianNoiseFloor([0, -104, null, null]), -104, 'nor is the 0 dBm "no value yet" seed');
  assert.equal(medianNoiseFloor([-128, -128, -128, -128]), null, 'no reading: no floor');
  assert.equal(medianNoiseFloor([-103, null, -90]), -103, 'a null ends the leading run');
  assert.equal(medianNoiseFloor([]), null);
});

const CASES: { name: string; channels: (number | null)[] }[] = [
  { name: 'live floor', channels: [-104, -104, -101, -93] },
  { name: 'one channel at "no signal detected"', channels: [-125, -104, -101, -93] },
  { name: 'every channel at "no signal detected"', channels: [-128, -128, -128, -128] },
  { name: 'a "no value yet" seed in front', channels: [0, -104, null, null] },
  { name: 'every channel at the seed', channels: [0, 0, null, null] },
];

function providerFloor(channels: (number | null)[]): { floor: number; measured: boolean } {
  // The controller snapshot carries the leading run (zwaveData.leadingRun).
  const run: number[] = [];
  for (const ch of channels) { if (ch == null) break; run.push(ch); }
  const { provider, stop } = createTuiDataProvider({
    zwaveData: { snapshot: () => [], controller: () => ({ backgroundRSSI: run } as unknown as ControllerSnapshot), events: () => [] } as never,
    refreshMs: 60_000, routePollMs: 60_000, log: () => {},
  });
  try { return { floor: provider.noiseFloor(), measured: provider.hasRealNoise() }; } finally { stop(); }
}

test('the screens, Interference and the shared rule agree on the floor AND on whether it is measured (v0.75.2)', () => {
  for (const { name, channels } of CASES) {
    const m = medianNoiseFloor(channels);
    const p = providerFloor(channels);
    assert.equal(p.measured, m != null, `${name}: "measured" means the floor came from a reading`);
    assert.equal(p.floor, m ?? DEFAULT_NOISE_FLOOR, `${name}: the screens' floor`);
    const iv = computeInterference({
      now: 0, bgChannels: channels, controllerSamples: [], controllerCoarse: [], coarseByNode: new Map(), symptoms: [],
    });
    assert.equal(iv.noise.floor, m, `${name}: Interference's floor`);
    assert.equal(iv.noise.real, m != null, `${name}: Interference's "real"`);
  }
});

test('every floor in the add-on is computed by the one rule — none re-implements it (v0.75.2)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = (p: string): string => readFileSync(resolve(here, '../src', p), 'utf8');
  for (const p of ['telnet/dataProvider.ts', 'zwave/symptoms.ts', 'zwave/interference.ts', 'zwave/evidenceStore.ts']) {
    assert.match(src(p), /medianNoiseFloor\(/, `${p} takes its floor from medianNoiseFloor`);
  }
  assert.match(src('zwave/health.ts'), /const nf = noiseReading\(noiseFloor\) \?\? DEFAULT_NOISE_FLOOR;/, 'the health score validates its floor by the same rule');
  const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code(src('zwave/symptoms.ts')), /hasRealNoise/, 'the detectors read "measured" from the floor, not from whether a sample exists');
  assert.doesNotMatch(code(src('zwave/zwaveData.ts')), /hasRealNoise:/, 'and the data layer no longer supplies a second answer');
});
