import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionRunner } from '../src/zwave/zwaveActions';
import type { HaWsClient } from '../src/ha/haWsClient';

interface MkOpts { reject?: boolean; noDevice?: boolean; noPing?: boolean; entry?: string | null }
function mk(enabled: boolean, opts: MkOpts = {}) {
  const sent: any[] = [];
  const logs: Array<{ sev: string; nodeId: number | null; text: string }> = [];
  const outcomes: Array<{ kind: string; nodeId: number | null; ok: boolean }> = [];
  const configWritten: number[] = [];
  const client = {
    send: async (cmd: any) => { sent.push(cmd); if (opts.reject) throw new Error('boom'); return null; },
  } as unknown as HaWsClient;
  const runner = createActionRunner({
    client,
    entryId: () => (opts.entry === undefined ? 'entry-1' : opts.entry),
    deviceIdOf: (n) => (opts.noDevice ? null : `dev-${n}`),
    pingEntityOf: (n) => (opts.noPing ? null : `button.node${n}_ping`),
    log: (sev, nodeId, text) => logs.push({ sev, nodeId, text }),
    onOutcome: (kind, nodeId, ok) => outcomes.push({ kind, nodeId, ok }),
    onConfigWritten: (n) => configWritten.push(n),
    enabled,
  });
  return { runner, sent, logs, outcomes, configWritten };
}

const param = (over: Partial<import('../src/types').ConfigParam> = {}): import('../src/types').ConfigParam => ({
  key: '5-112-0-3', label: 'LED', value: 2, valueLabel: 'Always off', unit: null, writeable: true,
  min: 0, max: 3, property: 3, propertyKey: null, endpoint: 0, states: { '0': 'Off', '2': 'Always off' }, ...over,
});

test('a DISABLED runner never sends a command', async () => {
  const { runner, sent, logs } = mk(false);
  for (const p of [runner.ping(3), runner.healNode(3), runner.rebuildAll(), runner.removeFailed(3)]) {
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.message, /disabled/);
  }
  assert.equal(sent.length, 0, 'no WS command may reach the mesh when disabled');
  assert.equal(logs.length, 0);
});

test('ping presses the node ping button entity', async () => {
  const { runner, sent, logs } = mk(true);
  const r = await runner.ping(3);
  assert.equal(r.ok, true);
  const call = sent.find((c) => c.type === 'call_service');
  assert.equal(call.domain, 'button');
  assert.equal(call.service, 'press');
  assert.equal(call.service_data.entity_id, 'button.node3_ping');
  assert.ok(logs.some((l) => l.text.includes('→ ok')));
});

test('node-scoped commands use the resolved device_id', async () => {
  const { runner, sent } = mk(true);
  await runner.healNode(5);
  await runner.reInterview(5);
  await runner.refreshValues(5);
  await runner.removeFailed(5);
  const has = (type: string) => sent.some((c) => c.type === type && c.device_id === 'dev-5');
  assert.ok(has('zwave_js/rebuild_node_routes'), 'heal → rebuild_node_routes');
  assert.ok(has('zwave_js/refresh_node_info'), 're-interview → refresh_node_info');
  assert.ok(has('zwave_js/refresh_node_values'), 'refresh → refresh_node_values');
  assert.ok(has('zwave_js/remove_failed_node'), 'remove → remove_failed_node');
});

test('network-wide commands use the entry_id', async () => {
  const { runner, sent } = mk(true);
  await runner.rebuildAll();
  await runner.stopRebuild();
  assert.ok(sent.some((c) => c.type === 'zwave_js/begin_rebuilding_routes' && c.entry_id === 'entry-1'));
  assert.ok(sent.some((c) => c.type === 'zwave_js/stop_rebuilding_routes' && c.entry_id === 'entry-1'));
});

test('a failed command is reported + logged as error, never thrown', async () => {
  const { runner, logs } = mk(true, { reject: true });
  const r = await runner.healNode(5);
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
  assert.ok(logs.some((l) => l.sev === 'error'));
});

test('missing device / ping entity / entry → clean error, no crash', async () => {
  assert.equal((await mk(true, { noDevice: true }).runner.healNode(5)).ok, false);
  assert.equal((await mk(true, { noPing: true }).runner.ping(3)).ok, false);
  assert.equal((await mk(true, { entry: null }).runner.rebuildAll()).ok, false);
});

/* ── v0.23 device control + config writes ──────────────────────────────────── */

test('controlEntity calls the domain-correct service with the entity_id', async () => {
  const { runner, sent } = mk(true);
  await runner.controlEntity(8, 'light.kitchen', 'off');
  await runner.controlEntity(8, 'lock.front_door', 'unlock');
  await runner.controlEntity(8, 'cover.garage', 'open');
  const call = (i: number) => sent.filter((c) => c.type === 'call_service')[i];
  assert.deepEqual([call(0).domain, call(0).service, call(0).service_data.entity_id], ['homeassistant', 'turn_off', 'light.kitchen']);
  assert.deepEqual([call(1).domain, call(1).service, call(1).service_data.entity_id], ['lock', 'unlock', 'lock.front_door']);
  assert.deepEqual([call(2).domain, call(2).service, call(2).service_data.entity_id], ['cover', 'open_cover', 'cover.garage']);
});

test('controlEntity rejects a verb invalid for the entity domain (no bad service call)', async () => {
  const { runner, sent } = mk(true);
  const r = await runner.controlEntity(8, 'lock.front_door', 'on'); // a lock has no turn_on
  assert.equal(r.ok, false);
  assert.equal(sent.filter((c) => c.type === 'call_service').length, 0, 'no service call for an invalid verb');
});

test('controlEntity is NOT attributed to the M5 outcome ledger (operator op, not remediation)', async () => {
  const { runner, outcomes } = mk(true);
  await runner.controlEntity(8, 'switch.lamp', 'toggle');
  assert.equal(outcomes.length, 0, 'device control never feeds the learning ledger');
});

test('setConfigParam sends device_id + property + value and invalidates the cache', async () => {
  const { runner, sent, configWritten, outcomes } = mk(true);
  const r = await runner.setConfigParam(5, param(), 0);
  assert.equal(r.ok, true);
  const cmd = sent.find((c) => c.type === 'zwave_js/set_config_parameter');
  assert.equal(cmd.device_id, 'dev-5');
  assert.equal(cmd.property, 3);
  assert.equal(cmd.value, 0);
  assert.deepEqual(configWritten, [5], 'the node cache is invalidated after a successful write');
  assert.equal(outcomes.length, 0, 'config write is not a remediation');
});

test('setConfigParam includes property_key + endpoint only when present', async () => {
  const { runner, sent } = mk(true);
  await runner.setConfigParam(5, param({ propertyKey: 255, endpoint: 1 }), 1);
  const cmd = sent.find((c) => c.type === 'zwave_js/set_config_parameter');
  assert.equal(cmd.property_key, 255);
  assert.equal(cmd.endpoint, 1);
  const { runner: r2, sent: s2 } = mk(true);
  await r2.setConfigParam(5, param(), 0); // propertyKey null, endpoint 0
  const c2 = s2.find((c) => c.type === 'zwave_js/set_config_parameter');
  assert.ok(!('property_key' in c2), 'no property_key key when null');
  assert.ok(!('endpoint' in c2), 'no endpoint key when 0');
});

test('setConfigParam on a node with no device → error, no send, no cache invalidation', async () => {
  const { runner, sent, configWritten } = mk(true, { noDevice: true });
  const r = await runner.setConfigParam(5, param(), 0);
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
  assert.deepEqual(configWritten, [], 'no invalidation when the write never happened');
});

test('a DISABLED runner blocks controlEntity + setConfigParam too', async () => {
  const { runner, sent } = mk(false);
  assert.equal((await runner.controlEntity(8, 'light.x', 'on')).ok, false);
  assert.equal((await runner.setConfigParam(5, param(), 0)).ok, false);
  assert.equal(sent.length, 0);
});
