import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CATALOG,
  buildMenu,
  buildEntityRows,
  buildConfigRows,
  clampMenuIndex,
  describeAction,
  CONFIRM_WORD,
  type ActionImpact,
} from '../src/telnet/actionsCatalog';
import type { ConfigParam, EntityLiveState } from '../src/types';
import type { ActionKind } from '../src/types';

const KINDS: ActionKind[] = ['ping', 'refreshValues', 'reInterview', 'healNode', 'rebuildAll', 'stopRebuild', 'removeFailed'];
const IMPACTS = new Set<ActionImpact>(['safe', 'caution', 'destructive']);

test('every ActionKind has exactly one catalog descriptor with valid fields', () => {
  assert.equal(new Set(ACTION_CATALOG.map((d) => d.kind)).size, ACTION_CATALOG.length, 'no duplicate kinds');
  for (const k of KINDS) {
    const d = describeAction(k);
    assert.ok(d, `missing descriptor for ${k}`);
    assert.ok(d!.label.length > 0 && d!.desc.length > 0 && d!.impactNote.length > 0, `${k} has empty text`);
    assert.ok(IMPACTS.has(d!.impact), `${k} bad impact`);
    assert.ok(d!.scope === 'device' || d!.scope === 'system');
    assert.equal(d!.needsNode, d!.scope === 'device', `${k} needsNode must match device scope`);
  }
});

test('impact classification: ping safe, rebuildAll + removeFailed destructive', () => {
  assert.equal(describeAction('ping')!.impact, 'safe');
  assert.equal(describeAction('rebuildAll')!.impact, 'destructive');
  assert.equal(describeAction('removeFailed')!.impact, 'destructive');
});

test('buildMenu with a node + idle: device actions enabled, rebuildAll shown, stopRebuild hidden', () => {
  const items = buildMenu({ hasNode: true, rebuilding: false });
  const kinds = items.map((i) => i.desc.kind);
  assert.ok(kinds.includes('rebuildAll'), 'rebuildAll shown while idle');
  assert.ok(!kinds.includes('stopRebuild'), 'stopRebuild hidden while idle');
  assert.ok(items.filter((i) => i.desc.scope === 'device').every((i) => !i.disabled), 'device actions enabled with a node');
});

test('buildMenu while rebuilding: stopRebuild shown, rebuildAll hidden (mutually exclusive)', () => {
  const kinds = buildMenu({ hasNode: true, rebuilding: true }).map((i) => i.desc.kind);
  assert.ok(kinds.includes('stopRebuild'), 'stopRebuild shown while rebuilding');
  assert.ok(!kinds.includes('rebuildAll'), 'rebuildAll hidden while rebuilding');
});

test('buildMenu with no node: device actions present but DISABLED with a reason; system unaffected', () => {
  const items = buildMenu({ hasNode: false, rebuilding: false });
  const device = items.filter((i) => i.desc.scope === 'device');
  assert.ok(device.length > 0);
  assert.ok(device.every((i) => i.disabled && i.reason), 'device actions disabled + reasoned without a node');
  const system = items.filter((i) => i.desc.scope === 'system');
  assert.ok(system.every((i) => !i.disabled), 'system actions never need a node');
});

test('menu is ordered device-first then system', () => {
  const items = buildMenu({ hasNode: true, rebuilding: false });
  const firstSystem = items.findIndex((i) => i.desc.scope === 'system');
  const lastDevice = items.map((i) => i.desc.scope).lastIndexOf('device');
  assert.ok(firstSystem > lastDevice, 'all device rows precede system rows');
});

test('clampMenuIndex bounds into range; empty → 0', () => {
  assert.equal(clampMenuIndex(-3, 5), 0);
  assert.equal(clampMenuIndex(99, 5), 4);
  assert.equal(clampMenuIndex(2, 5), 2);
  assert.equal(clampMenuIndex(2, 0), 0);
});

test('CONFIRM_WORD is the exact string "CONFIRM"', () => {
  assert.equal(CONFIRM_WORD, 'CONFIRM');
});

/* ── v0.23 device-control + config menu builders ──────────────────────────── */

const ent = (over: Partial<EntityLiveState> = {}): EntityLiveState =>
  ({ entityId: 'light.k', domain: 'light', name: 'Kitchen', state: 'on', attrs: {}, ...over });
const cp = (over: Partial<ConfigParam> = {}): ConfigParam =>
  ({ key: '5-112-0-3', label: 'LED', value: 2, valueLabel: 'Off', unit: null, writeable: true, min: 0, max: 3, property: 3, propertyKey: null, endpoint: 0, states: null, ...over });

test('buildEntityRows: one row per (controllable entity, verb); read-only domains produce none', () => {
  const rows = buildEntityRows([
    ent({ domain: 'light', name: 'Kitchen' }),
    ent({ entityId: 'lock.f', domain: 'lock', name: 'Front' }),
    ent({ entityId: 'sensor.p', domain: 'sensor', name: 'Power', state: '42' }), // read-only
    ent({ entityId: 'binary_sensor.m', domain: 'binary_sensor', name: 'Motion' }), // read-only
  ]);
  const labels = rows.map((r) => r.desc.label);
  assert.deepEqual(labels, ['Turn On · Kitchen', 'Turn Off · Kitchen', 'Toggle · Kitchen', 'Lock · Front', 'Unlock · Front']);
  assert.ok(rows.every((r) => r.group === 'control' && r.payload.type === 'entity'));
  // high-stakes unlock is flagged destructive; routine light ops are safe
  const unlock = rows.find((r) => r.desc.label === 'Unlock · Front')!;
  assert.equal(unlock.desc.impact, 'destructive');
  assert.equal(rows.find((r) => r.desc.label === 'Turn On · Kitchen')!.desc.impact, 'safe');
});

test('buildEntityRows: the live state is surfaced in the row description', () => {
  const rows = buildEntityRows([ent({ domain: 'light', name: 'Kitchen', state: 'off' })]);
  assert.match(rows[0].desc.desc, /now: off/);
});

test('buildConfigRows: only WRITEABLE params; payload carries the param', () => {
  const rows = buildConfigRows([
    cp({ label: 'LED', writeable: true, property: 3 }),
    cp({ key: '5-112-0-1', label: 'RO', writeable: false, property: 1 }),
    cp({ key: '5-112-0-9', label: 'Ramp', writeable: true, property: 9, states: null, min: 0, max: 99, unit: 'ms', value: 20, valueLabel: null }),
  ]);
  assert.deepEqual(rows.map((r) => r.desc.label), ['Set · LED', 'Set · Ramp']);
  assert.ok(rows.every((r) => r.group === 'config' && r.desc.kind === 'setConfigParam'));
  const p = rows[0].payload;
  assert.equal(p.type === 'config' && p.param.property, 3);
  // the description mentions the current value + the range/enum hint
  assert.match(rows[1].desc.desc, /0…99 ms/);
});
