import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFirmware, type RawEntityState } from '../src/zwave/zwaveData';

// node 5 has one firmware entity; node 7 has two targets (_firmware + _firmware_2).
const MAP = new Map<string, number>([
  ['update.node5_firmware', 5],
  ['update.node7_firmware', 7],
  ['update.node7_firmware_2', 7],
]);

const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): RawEntityState => ({
  entity_id,
  state,
  attributes,
});

test('single target, up to date → no update, versions captured, targets 1', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'off', { installed_version: '1.70', latest_version: '1.70' })], MAP);
  assert.deepEqual(fw.get(5), { current: '1.70', latest: '1.70', updateAvailable: false, inProgress: false, progressPct: null, targets: 1 });
});

test('single target, update available (state on) → updateAvailable with installed→latest', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'on', { installed_version: '5.54', latest_version: '5.60' })], MAP);
  const f = fw.get(5)!;
  assert.equal(f.updateAvailable, true);
  assert.equal(f.current, '5.54');
  assert.equal(f.latest, '5.60');
});

test('in progress → inProgress + progressPct from update_percentage', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'on', { installed_version: '5.54', latest_version: '5.60', in_progress: true, update_percentage: 42 })], MAP);
  const f = fw.get(5)!;
  assert.equal(f.inProgress, true);
  assert.equal(f.progressPct, 42);
});

test('in progress with null update_percentage → progressPct stays null (no 0% lie)', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'on', { in_progress: true, update_percentage: null })], MAP);
  assert.equal(fw.get(5)!.inProgress, true);
  assert.equal(fw.get(5)!.progressPct, null);
});

test('multi-target: any target on → updateAvailable, targets counted, versions from the updating one', () => {
  const fw = aggregateFirmware(
    [
      st('update.node7_firmware', 'off', { installed_version: '1.0', latest_version: '1.0' }),
      st('update.node7_firmware_2', 'on', { installed_version: '2.0', latest_version: '2.5' }),
    ],
    MAP,
  );
  const f = fw.get(7)!;
  assert.equal(f.updateAvailable, true);
  assert.equal(f.targets, 2);
  assert.equal(f.current, '2.0'); // the target WITH the update wins the displayed versions
  assert.equal(f.latest, '2.5');
});

test('multi-target all current → no update, targets 2, versions from the first', () => {
  const fw = aggregateFirmware(
    [
      st('update.node7_firmware', 'off', { installed_version: '1.0', latest_version: '1.0' }),
      st('update.node7_firmware_2', 'off', { installed_version: '3.3', latest_version: '3.3' }),
    ],
    MAP,
  );
  const f = fw.get(7)!;
  assert.equal(f.updateAvailable, false);
  assert.equal(f.targets, 2);
  assert.equal(f.current, '1.0');
});

test('entities not in the map are ignored (add-on/integration update.* entities)', () => {
  const fw = aggregateFirmware(
    [st('update.z_wave_js_update', 'on', { installed_version: '1.5.0', latest_version: '1.6.0' }), st('sensor.node5_battery', '80')],
    MAP,
  );
  assert.equal(fw.size, 0);
});

test('missing attributes → nulls, never throws', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'off')], MAP);
  assert.deepEqual(fw.get(5), { current: null, latest: null, updateAvailable: false, inProgress: false, progressPct: null, targets: 1 });
});

test('numeric version attributes are coerced to strings', () => {
  const fw = aggregateFirmware([st('update.node5_firmware', 'off', { installed_version: 1.7, latest_version: 1.7 })], MAP);
  assert.equal(fw.get(5)!.current, '1.7');
});

test('firmware version strings are sanitized (device-reported, reach the Detail frame)', () => {
  const fw = aggregateFirmware(
    [st('update.node5_firmware', 'off', { installed_version: '1.7\n0\x1b[2J', latest_version: '1.70' })],
    MAP,
  );
  const cur = fw.get(5)!.current!;
  assert.ok(!/[\x00-\x1f]/.test(cur), 'control/ESC bytes stripped from installed_version');
});
