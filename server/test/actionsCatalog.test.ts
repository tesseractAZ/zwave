import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CATALOG,
  buildMenu,
  clampMenuIndex,
  describeAction,
  CONFIRM_WORD,
  type ActionImpact,
} from '../src/telnet/actionsCatalog';
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
