import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionRunner, isNotFailedRefusal, zwaveErrorCode } from '../src/zwave/zwaveActions';
import type { HaWsClient } from '../src/ha/haWsClient';

interface MkOpts { reject?: boolean; noDevice?: boolean; noPing?: boolean; entry?: string | null }
function mk(enabled: boolean, opts: MkOpts = {}) {
  const sent: any[] = [];
  const logs: Array<{ sev: string; nodeId: number | null; text: string; origin?: string }> = [];
  const outcomes: Array<{ kind: string; nodeId: number | null; ok: boolean }> = [];
  const configWritten: number[] = [];
  const removed: number[] = [];
  const client = {
    send: async (cmd: any) => { sent.push(cmd); if (opts.reject) throw new Error('boom'); return null; },
  } as unknown as HaWsClient;
  const runner = createActionRunner({
    client,
    entryId: () => (opts.entry === undefined ? 'entry-1' : opts.entry),
    deviceIdOf: (n) => (opts.noDevice ? null : `dev-${n}`),
    pingEntityOf: (n) => (opts.noPing ? null : `button.node${n}_ping`),
    log: (sev, nodeId, text, origin) => logs.push({ sev, nodeId, text, origin }),
    onOutcome: (kind, nodeId, ok) => outcomes.push({ kind, nodeId, ok }),
    onConfigWritten: (n) => configWritten.push(n),
    onNodeRemoved: (n) => removed.push(n),
    enabled,
  });
  return { runner, sent, logs, outcomes, configWritten, removed };
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

/* ── v0.35: a removed node's learned baselines must not outlive it ─────────── */

test('a SUCCESSFUL removeFailed fires onNodeRemoved', async () => {
  // The node is gone. A later re-include on the same id is different hardware,
  // and measuring it against the dead device's normals is how the engine
  // manufactures symptoms out of a swap.
  const { runner, removed } = mk(true);
  const r = await runner.removeFailed(9);
  assert.equal(r.ok, true);
  assert.deepEqual(removed, [9]);
});

test('a FAILED removeFailed does NOT — the node and its history are still there', async () => {
  const { runner, removed } = mk(true, { reject: true });
  const r = await runner.removeFailed(9);
  assert.equal(r.ok, false);
  assert.deepEqual(removed, [], 'discarding a live node’s learned baselines would be the real damage');
});

test('a disabled runner removes nothing and forgets nothing', async () => {
  const { runner, removed, sent } = mk(false);
  await runner.removeFailed(9);
  assert.deepEqual(sent, []);
  assert.deepEqual(removed, []);
});

/* ── v0.38.1: the probe verb never reaches the ledger ──────────────────────── */

test('probe() pings the node but NEVER fires onOutcome — measurement is not treatment', async () => {
  // The audit finding: all three auto-ping lanes shared the learning ping, so
  // every sweep and every verification burst stamped `ping` onto any open
  // episode. Not one scoreable "(no action)" closure exists in the entire
  // retained log — the control arm was structurally starved and
  // expectedEfficacy could never be computed.
  const { runner, sent, outcomes } = mk(true);
  const r = await runner.probe(6);
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1, 'the NoOp ping is really sent');
  assert.deepEqual(outcomes, [], 'and the ledger never hears about it');
});

test('ping() still learns — the remediation lane is the one place attribution belongs', async () => {
  const { runner, outcomes } = mk(true);
  await runner.ping(6);
  assert.deepEqual(outcomes, [{ kind: 'ping', nodeId: 6, ok: true }]);
});

test('probe() obeys the master gate like every write', async () => {
  const { runner, sent } = mk(false);
  const r = await runner.probe(6);
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

/* ── v0.41.0: provenance follows the CALLER, not the runner ────────────────── */

test('a probe logs as the ENGINE and an operator ping logs as YOU — from one runner (v0.41.0)', async () => {
  // The first cut of the v0.41 provenance fix was wired one layer too high: it
  // relabelled auto-ping's narration while run()'s own lines — including the
  // RED-latching "→ failed", the one that demands an ACK — still said
  // `operator`. A pre-release review measured half the ring misattributed on a
  // purely autonomous run.
  const { runner, logs } = mk(true);
  await runner.probe(7);
  await runner.ping(7, 'engine');
  await runner.ping(7);
  const probeLines = logs.filter((l) => l.text.startsWith('probe node 7'));
  assert.ok(probeLines.length > 0, 'the probe logged something');
  assert.ok(probeLines.every((l) => l.origin === 'engine'),
    `every line describing an engine probe is the engine's: ${JSON.stringify(probeLines)}`);
  // The FAILURE line is the one that latches RED and demands an ACK — it must
  // carry its origin too, or the operator is asked to acknowledge an error the
  // engine caused.
  const { runner: failing, logs: failLogs } = mk(true, { reject: true });
  await failing.probe(9);
  const failLine = failLogs.find((l) => /→ failed/.test(l.text));
  assert.ok(failLine, `a failing probe logs an error line: ${JSON.stringify(failLogs)}`);
  assert.equal(failLine!.origin, 'engine', 'and it is the engine\'s, not the operator\'s');

  const pings = logs.filter((l) => l.text.startsWith('ping node 7'));
  assert.ok(pings.some((l) => l.origin === 'engine'), "the ladder ping is the engine's");
  assert.ok(pings.some((l) => l.origin === 'you'), 'and an operator ping is still yours');
});

/* ── v0.43.1: a driver REFUSAL is not a transport failure ──────────────────── */

test('removeFailed refused on a live node is classified `refused`; everything else is `transport` (v0.43.1)', async () => {
  // `refused-misdiagnosis` — and with it falsePositives, the one number that
  // argues AGAINST the card it sits on — was unreachable in production: the
  // catch discarded the driver's own words and reported a bare `false`. TWO
  // screens gate a warning on that counter and neither could ever fire.
  const seen: Array<{ kind: string; ok: boolean; refusal?: string }> = [];
  // The classifier is a pure function of (kind, message); exercise it through
  // run() by making the service call throw the driver's exact text.
  const { createActionRunner } = await import('../src/zwave/zwaveActions');
  const build = (throwText: string) => createActionRunner({
    client: { send: async () => { throw new Error(throwText); } } as never,
    entryId: () => 'entry-1',
    deviceIdOf: (n: number) => `dev-${n}`,
    pingEntityOf: (n: number) => `button.node${n}_ping`,
    log: () => {},
    onOutcome: (kind: string, _n: number | null, ok: boolean, refusal?: string) => { seen.push({ kind, ok, refusal }); },
    enabled: true,
  } as never);

  // A VERBATIM zwave-js 15.28.0 message, wrapped as the chain delivers it.
  await build('HA WS error (zwave_error): Z-Wave error 361 - The node could not be removed because it has responded (ZW0361)').removeFailed(5);
  assert.deepEqual(seen.pop(), { kind: 'removeFailed', ok: false, refusal: 'refused' },
    'the driver rejecting the premise indicts the detector');

  seen.length = 0;
  await build('Connection lost').removeFailed(5);
  assert.equal(seen.pop()?.refusal, 'transport',
    'a transport fault indicts nothing — it could not run');

  seen.length = 0;
  await build('Node 5 is not a failed node').healNode(5);
  assert.equal(seen.pop()?.refusal, 'transport',
    'only a DIAGNOSIS-VERIFYING action can be refused in a way that indicts a detector');
});

test('refusals are classified on the Z-Wave ERROR CODE, against real driver messages (v0.43.2)', () => {
  // Every string below is the VERBATIM text zwave-js 15.28.0 emits from
  // Controller.removeFailedNode, wrapped exactly as the chain delivers it:
  //   ZWaveError appends " (ZW0361)"; FailedZWaveCommand prefixes
  //   "Z-Wave error 361 - "; HA's async_handle_failed_command forwards
  //   err.args[0] unchanged; haWsClient prefixes "HA WS error (zwave_error): ".
  // The enum's own comment says these codes exist so callers need not rely on
  // the wording — the previous version of this classifier did, and was wrong.
  const wrap = (code: number, text: string): string =>
    `HA WS error (zwave_error): Z-Wave error ${code} - ${text} (ZW0${code})`;

  // RemoveFailedNode_NodeOK — unambiguous: the node answered.
  assert.ok(isNotFailedRefusal(wrap(361, 'The node could not be removed because it has responded')));

  // RemoveFailedNode_Failed, the node-is-fine cases. The ping path is the MOST
  // LIKELY refusal in practice: zwave-js pings three times before it even asks
  // the controller, and the old classifier missed it entirely.
  assert.ok(isNotFailedRefusal(wrap(360, 'The node removal process could not be started because the node responded to a ping.')));
  // NOT a refusal, despite reading like one: zwave-js pings the node three
  // times BEFORE it asks the controller, and only reaches the response branch
  // that can report NodeNotFound after all three failed. The device is proven
  // silent by then — this is the controller's bookkeeping disagreeing with the
  // driver, and blaming the ghost detector for it would punish a correct call.
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:\n· Node 5 is not in the list of failed nodes')));

  // RemoveFailedNode_Failed, the cases that say NOTHING about the diagnosis.
  assert.ok(!isNotFailedRefusal(wrap(360, 'The removal process could not be completed')));
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:\n· This controller is not the primary controller')));
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:\n· The node removal process is currently busy')));

  // The driver's OWN words are ambiguous here — "busy OR responded". If zwave-js
  // cannot tell which, neither can we, and a detector must not be indicted on it.
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:\n· The controller is busy or the node has responded')));

  // The 360 message is assembled from BITFLAGS: several reasons can co-occur.
  // A transport reason vetoes — if the controller was not primary, the failed-
  // nodes list was never meaningfully consulted.
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:'
    + '\n· This controller is not the primary controller'
    + '\n· Node 5 is not in the list of failed nodes')));

  // Both flags at once (NodeNotFound | RemoveFailed) — still not a refusal.
  assert.ok(!isNotFailedRefusal(wrap(360,
    'The node removal process could not be started due to the following reasons:'
    + '\n· Node 5 is not in the list of failed nodes'
    + '\n· The controller is busy or the node has responded')));

  // Non-Z-Wave failures carry no code at all.
  for (const no of [
    'HA WS error (timeout): Timeout waiting for a response',
    'Connection lost',
    'HA WS error (not_found): Config entry not found',
  ]) assert.ok(!isNotFailedRefusal(no), `must NOT read as a refusal: ${no}`);

  // And the phrasings the OLD classifier invented match nothing, because the
  // driver never emits them — proof the family was fiction, not a near-miss.
  for (const invented of ['Node 5 is not a failed node', 'The node is not currently failed']) {
    assert.ok(!isNotFailedRefusal(`HA WS error (zwave_error): ${invented}`),
      `an invented phrasing with no code must not classify: ${invented}`);
  }
});

test('the Z-Wave error code is recovered from EITHER encoding the chain provides (v0.43.2)', () => {
  // Two independent carriers, so losing one does not blind the classifier:
  // the ZW#### suffix appended by ZWaveError, and the numeric restatement
  // added by FailedZWaveCommand.
  assert.equal(zwaveErrorCode('… has responded (ZW0361)'), 361, 'suffix alone');
  assert.equal(zwaveErrorCode('Z-Wave error 361 - … has responded'), 361, 'relayed number alone');
  assert.equal(zwaveErrorCode('Z-Wave error 361 - … (ZW0361)'), 361, 'both agree');
  assert.equal(zwaveErrorCode('Connection lost'), null, 'neither present');
  // A refusal is still recognised if only the relayed number survives.
  assert.ok(isNotFailedRefusal('Z-Wave error 361 - The node could not be removed because it has responded'));
});


test('an unmatched remove-failed failure LOGS its wording so the family can be corrected (v0.43.1)', () => {
  // The self-capturing half: the first real refusal on this fleet must leave
  // its verbatim text in the log rather than vanishing into a bare `false`.
  const logs: string[] = [];
  const runner = createActionRunner({
    // A real ZW0360 whose REASON is one the families do not yet cover. Gating
    // on the code is what stops this firing for a dropped socket, where no
    // driver ever spoke and there is nothing to add.
    client: { send: async () => { throw new Error('HA WS error (zwave_error): Z-Wave error 360 - The node removal process could not be started due to the following reasons:\n· Some reason nobody predicted (ZW0360)'); } } as never,
    entryId: () => 'entry-1',
    deviceIdOf: (n: number) => `dev-${n}`,
    pingEntityOf: (n: number) => `button.node${n}_ping`,
    log: (_s: string, _n: number | null, text: string) => { logs.push(text); },
    enabled: true,
  } as never);
  return runner.removeFailed(5).then(() => {
    assert.ok(logs.some((l) => /unclassified ZW0360 reason/.test(l)),
      `the capture must fire: ${JSON.stringify(logs)}`);
    // The FLAG is the new information. The driver's verbatim text is already in
    // the ring via the generic failure line — re-logging it behind a prose
    // preamble is what truncation then ate.
    const verbatim = logs.find((l) => /Some reason nobody predicted/.test(l));
    assert.ok(verbatim, `the verbatim text must be somewhere in the log: ${JSON.stringify(logs)}`);
    assert.match(verbatim, /\(ZW0360\)/, 'including the code suffix that identifies it');
  });
});

test('the self-capture does NOT fire when no driver ever spoke (v0.44.0)', () => {
  // A dropped socket or a timeout carries no Z-Wave error code, so there is no
  // reason string to add to any family — logging "here is the wording to add"
  // for a transport fault is an instruction nobody can act on.
  const logs: string[] = [];
  const runner = createActionRunner({
    client: { send: async () => { throw new Error('HA WS error (timeout): Timeout waiting for a response'); } } as never,
    entryId: () => 'entry-1',
    deviceIdOf: (n: number) => `dev-${n}`,
    pingEntityOf: (n: number) => `button.node${n}_ping`,
    log: (_s: string, _n: number | null, text: string) => { logs.push(text); },
    enabled: true,
  } as never);
  return runner.removeFailed(5).then(() => {
    assert.ok(!logs.some((l) => /unclassified ZW0360/.test(l)),
      `no driver spoke, so nothing to capture: ${JSON.stringify(logs)}`);
  });
});
