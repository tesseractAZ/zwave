import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStateChanged, isFiniteNumeric, type EntityIndexEntry } from '../src/zwave/zwaveData';

function index(entries: Record<string, EntityIndexEntry>): Map<string, EntityIndexEntry> {
  return new Map(Object.entries(entries));
}

/** Build an HA state_changed event payload. */
function sc(entity_id: string, oldS: string | null | undefined, newS: string | null | undefined) {
  return {
    data: {
      entity_id,
      old_state: oldS === undefined ? undefined : oldS === null ? null : { state: oldS },
      new_state: newS === undefined ? undefined : newS === null ? null : { state: newS },
    },
  };
}

const IDX = index({
  'binary_sensor.garage_motion': { nodeId: 7, name: 'Garage Motion', domain: 'binary_sensor' },
  'sensor.garage_power': { nodeId: 7, name: 'Garage Power', domain: 'sensor' },
  'lock.front_door': { nodeId: 9, name: 'Front Door', domain: 'lock' },
});

test('maps a tracked discrete transition to a value payload with old→new text', () => {
  const out = mapStateChanged(sc('binary_sensor.garage_motion', 'off', 'on'), IDX, 1000, new Map());
  assert.ok(out);
  assert.equal(out!.nodeId, 7);
  assert.equal(out!.entityId, 'binary_sensor.garage_motion');
  assert.equal(out!.domain, 'binary_sensor');
  assert.equal(out!.oldState, 'off');
  assert.equal(out!.newState, 'on');
  assert.equal(out!.text, 'Garage Motion: off → on');
});

test('a missing old_state renders an em-dash source', () => {
  const out = mapStateChanged(sc('lock.front_door', undefined, 'locked'), IDX, 1000, new Map());
  assert.equal(out!.text, 'Front Door: — → locked');
});

test('skips: untracked entity, no-op transition, entity removal, and missing entity_id', () => {
  assert.equal(mapStateChanged(sc('light.not_zwave', 'off', 'on'), IDX, 1000, new Map()), null);
  assert.equal(mapStateChanged(sc('lock.front_door', 'locked', 'locked'), IDX, 1000, new Map()), null);
  assert.equal(mapStateChanged(sc('lock.front_door', 'locked', null), IDX, 1000, new Map()), null); // removed
  assert.equal(mapStateChanged({ data: { old_state: { state: 'x' }, new_state: { state: 'y' } } }, IDX, 1000, new Map()), null);
  assert.equal(mapStateChanged(null, IDX, 1000, new Map()), null);
});

test('numeric sensor telemetry is throttled per-entity; discrete entities are never throttled', () => {
  const last = new Map<string, number>();
  const gap = 10_000;
  // First numeric update accepted; a second within the gap is dropped; after the gap, accepted.
  assert.ok(mapStateChanged(sc('sensor.garage_power', '100', '120'), IDX, 0, last, gap));
  assert.equal(mapStateChanged(sc('sensor.garage_power', '120', '140'), IDX, 5_000, last, gap), null);
  assert.ok(mapStateChanged(sc('sensor.garage_power', '140', '160'), IDX, 10_000, last, gap));
  // A discrete binary_sensor is exempt even when hammered within the gap.
  const last2 = new Map<string, number>();
  assert.ok(mapStateChanged(sc('binary_sensor.garage_motion', 'off', 'on'), IDX, 0, last2, gap));
  assert.ok(mapStateChanged(sc('binary_sensor.garage_motion', 'on', 'off'), IDX, 100, last2, gap));
});

test('a non-numeric sensor state (text/enum) is NOT throttled', () => {
  const last = new Map<string, number>();
  const idx = index({ 'sensor.mode': { nodeId: 5, name: 'Mode', domain: 'sensor' } });
  assert.ok(mapStateChanged(sc('sensor.mode', 'home', 'away'), idx, 0, last, 10_000));
  assert.ok(mapStateChanged(sc('sensor.mode', 'away', 'night'), idx, 100, last, 10_000));
});

test('state strings are sanitized — no ANSI/control chars reach the frame', () => {
  const idx = index({ 'sensor.evil': { nodeId: 5, name: 'Evil', domain: 'binary_sensor' } });
  const out = mapStateChanged(sc('sensor.evil', 'off', '\x1b[31mred\x07\x00'), idx, 1000, new Map());
  assert.ok(out);
  // The ESC/BEL/NUL bytes are gone (so no ANSI sequence can form); the residual
  // "[31m" is now harmless literal text.
  assert.ok(!/[\x00-\x1f\x7f]/.test(out!.newState!), 'control chars stripped from newState');
  assert.ok(!/[\x00-\x1f\x7f]/.test(out!.text), 'control chars stripped from text');
  assert.ok(/red/.test(out!.newState!) && !out!.newState!.includes('\x1b'));
});

test('isFiniteNumeric distinguishes telemetry from labels', () => {
  for (const s of ['0', '12.5', '-40', '1e3', '100']) assert.equal(isFiniteNumeric(s), true, s);
  for (const s of ['', 'on', 'off', 'detected', 'unavailable', 'NaN', 'locked']) assert.equal(isFiniteNumeric(s), false, s);
});
