import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionRunner } from '../src/zwave/zwaveActions';
import type { HaWsClient } from '../src/ha/haWsClient';

interface MkOpts { reject?: boolean; noDevice?: boolean; noPing?: boolean; entry?: string | null }
function mk(enabled: boolean, opts: MkOpts = {}) {
  const sent: any[] = [];
  const logs: Array<{ sev: string; nodeId: number | null; text: string }> = [];
  const client = {
    send: async (cmd: any) => { sent.push(cmd); if (opts.reject) throw new Error('boom'); return null; },
  } as unknown as HaWsClient;
  const runner = createActionRunner({
    client,
    entryId: () => (opts.entry === undefined ? 'entry-1' : opts.entry),
    deviceIdOf: (n) => (opts.noDevice ? null : `dev-${n}`),
    pingEntityOf: (n) => (opts.noPing ? null : `button.node${n}_ping`),
    log: (sev, nodeId, text) => logs.push({ sev, nodeId, text }),
    enabled,
  });
  return { runner, sent, logs };
}

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
