import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionRunner, isNotFailedRefusal, zwaveErrorCode } from '../src/zwave/zwaveActions';
import type { HaWsClient } from '../src/ha/haWsClient';

interface MkOpts { reject?: boolean; noDevice?: boolean; noPing?: boolean; noRead?: boolean; entry?: string | null }
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
    readEntityOf: (n) => (opts.noRead ? null : `switch.node${n}`),
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

/* ── v0.64.5: the launch is stamped BEFORE the call is awaited ─────────────── */

test('ping() stamps sentAt before the service call resolves, not after (v0.64.5)', async () => {
  // Home Assistant's ping button starts the driver's ping in the background and
  // returns, so the node's answer and HA's reply race. A stamp read after
  // `await fn()` post-dates an answer that won, and the probe judge
  // (`lastSeen >= at`) then books an answered manual ping as "did NOT answer".
  let clock = 1_000;
  let clockAtSend = -1;
  const seen: Array<{ ok: boolean; sentAt?: number }> = [];
  const runner = createActionRunner({
    // The call takes 250 ms on the injected clock.
    client: { send: async () => { clockAtSend = clock; clock += 250; return null; } } as unknown as HaWsClient,
    entryId: () => 'entry-1',
    deviceIdOf: (n) => `dev-${n}`,
    pingEntityOf: (n) => `button.node${n}_ping`,
    log: () => {},
    onOutcome: (_kind, _n, ok, _refusal, _origin, sentAt) => { seen.push({ ok, sentAt }); },
    now: () => clock,
    enabled: true,
  });
  const r = await runner.ping(7);
  assert.equal(r.ok, true);
  assert.equal(clock, 1_250, 'precondition: the call consumed time on the injected clock');
  assert.deepEqual(seen, [{ ok: true, sentAt: 1_000 }], 'stamped at launch, not at resolution (1250)');
  assert.ok(seen[0].sentAt! <= clockAtSend, 'the stamp does not post-date the send');
});

test('the default launch clock is the WALL clock auto-ping judges with (v0.64.5)', async () => {
  // Production passes no `now` to either module, so both must fall back to the
  // same clock. A monotonic clock here would put every manual stamp decades
  // before any `lastSeen`, and every manual ping would be credited as answered.
  const seen: Array<number | undefined> = [];
  const runner = createActionRunner({
    client: { send: async () => null } as unknown as HaWsClient,
    entryId: () => 'entry-1',
    deviceIdOf: (n) => `dev-${n}`,
    pingEntityOf: (n) => `button.node${n}_ping`,
    log: () => {},
    onOutcome: (_kind, _n, _ok, _refusal, _origin, sentAt) => { seen.push(sentAt); },
    enabled: true,
  });
  const before = Date.now();
  await runner.ping(7);
  const after = Date.now();
  assert.equal(seen.length, 1);
  assert.ok(typeof seen[0] === 'number' && seen[0] >= before && seen[0] <= after,
    `sentAt ${seen[0]} must be a Date.now reading between ${before} and ${after}`);
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

test('a routed read is ONE refresh_value on the node\'s own value — never a Set, never refresh_node_values (v0.70.0)', async () => {
  const { runner, sent, outcomes } = mk(true);
  const r = await runner.routedRead(18);
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [{ type: 'call_service', domain: 'zwave_js', service: 'refresh_value',
    service_data: { entity_id: 'switch.node18', refresh_all_values: false } }],
    'refresh_node_values sends NOTHING to a Dead node, and refresh_all_values would read far more than one value');
  assert.equal(outcomes.length, 0, 'never learned: the ladder\'s ping is the episode\'s recorded action');
});

test('a routed read obeys the master gate and refuses a node with nothing to read (v0.70.0)', async () => {
  const off = mk(false);
  assert.equal((await off.runner.routedRead(18)).ok, false, 'write actions off');
  assert.equal(off.sent.length, 0);
  const none = mk(true, { noRead: true });
  const r = await none.runner.routedRead(18);
  assert.equal(r.ok, false, 'no readable value');
  assert.match(r.message, /no switch\/light value to read/);
  assert.equal(none.sent.length, 0, 'and nothing reaches the mesh');
});

test('a MEASUREMENT read is the same ONE refresh_value, logged as "probe node N (routed read)" by the engine, never learned (v0.71.0)', async () => {
  const { runner, sent, logs, outcomes } = mk(true);
  const r = await runner.routedRead(18, 'probe');
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [{ type: 'call_service', domain: 'zwave_js', service: 'refresh_value',
    service_data: { entity_id: 'switch.node18', refresh_all_values: false } }], 'the very same Get as the ladder read');
  assert.ok(logs.some((l) => /probe node 18 \(routed read\)/.test(l.text) && l.origin === 'engine'),
    `named as a probe, and as the engine's: ${JSON.stringify(logs)}`);
  assert.ok(!logs.some((l) => /^routed read node 18/.test(l.text)), 'not as the ladder\'s read');
  assert.equal(outcomes.length, 0, 'the instrument is never the recorded treatment');
  const ladder = mk(true);
  await ladder.runner.routedRead(18);
  assert.ok(ladder.logs.some((l) => /routed read node 18/.test(l.text)), 'the default purpose keeps the v0.70.0 line');
});

/* ── v0.72.0: results read from the reply, long verbs, actor, launch status ── */

import { HEAL_TIMEOUT_MS, REMOVE_FAILED_TIMEOUT_MS, READY_TIMEOUT_MS, configResult } from '../src/zwave/zwaveActions';
import { NodeStatus } from '../src/types';

function rig(reply: (cmd: any) => unknown, over: { status?: NodeStatus | null; listening?: boolean | null } = {}) {
  const sent: Array<{ cmd: any; timeout: unknown }> = [];
  const logs: Array<{ sev: string; text: string; origin?: string }> = [];
  const outcomes: Array<{ kind: string; ok: boolean; refusal?: string; origin?: string; sentAt?: number; alive?: boolean }> = [];
  const removed: number[] = [];
  let status: NodeStatus | null = over.status === undefined ? NodeStatus.Alive : over.status;
  let clock = 1_000;
  let inFlightSeen: unknown = 'unread';
  const client = {
    send: async (cmd: any, timeout?: unknown) => {
      sent.push({ cmd, timeout });
      inFlightSeen = runner.operatorActionInFlight();
      status = NodeStatus.Alive; // the action "revives" it: the launch status must already be read
      clock += 5_000;
      const r = reply(cmd);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as HaWsClient;
  const runner = createActionRunner({
    client, entryId: () => 'entry-1', deviceIdOf: (n) => `dev-${n}`, pingEntityOf: (n) => `button.node${n}_ping`,
    log: (sev, _n, text, origin) => logs.push({ sev, text, origin }),
    onOutcome: (kind, _n, ok, refusal, origin, sentAt, alive) => outcomes.push({ kind, ok, refusal, origin, sentAt, alive }),
    onNodeRemoved: (n) => removed.push(n),
    statusOf: () => status, listeningOf: () => (over.listening === undefined ? true : over.listening),
    now: () => clock, enabled: true,
  });
  return { runner, sent, logs, outcomes, removed, inFlight: () => inFlightSeen };
}

test('a heal that returns FALSE did not happen, and is never booked as success (v0.72.0)', async () => {
  const R = rig(() => false);
  const r = await R.runner.healNode(5);
  assert.equal(r.ok, false);
  assert.match(r.message, /did not complete — the driver returned false/);
  assert.ok(R.logs.some((l) => l.sev === 'error' && /returned false/.test(l.text)));
  assert.deepEqual(R.outcomes.map((o) => [o.ok, o.refusal]), [[false, 'transport']], 'indicts nothing, credits nothing');
  const t = rig(() => true);
  const ok = await t.runner.healNode(5);
  assert.equal(ok.ok, true);
  assert.match(ok.message, /driver reports success; a failed return-route assignment is not reported/);
});

test('rebuild-all and stop-rebuild read their boolean too (v0.72.0)', async () => {
  const a = await rig(() => false).runner.rebuildAll();
  assert.equal(a.ok, false);
  assert.match(a.message, /not started — a route rebuild is already running/);
  const b = await rig(() => false).runner.stopRebuild();
  assert.equal(b.ok, false);
  assert.match(b.message, /nothing to stop — no route rebuild was running/);
  assert.equal((await rig(() => true).runner.rebuildAll()).ok, true);
});

test('a config write HA reports QUEUED is not confirmed on a mains device, and waits for wake-up on a sleeping one (v0.72.0)', async () => {
  const p = param();
  const mains = await rig(() => ({ status: 'queued' }), { listening: true }).runner.setConfigParam(5, p, 1);
  assert.equal(mains.ok, false);
  assert.match(mains.message, /not confirmed — the device was or went offline while Home Assistant waited; the value may not be set; re-read it/);
  const unknown = await rig(() => ({ status: 'queued' }), { listening: null }).runner.setConfigParam(5, p, 1);
  assert.equal(unknown.ok, false, 'an unknown device type is not assumed asleep');
  const sleepy = await rig(() => ({ status: 'queued' }), { listening: false }).runner.setConfigParam(5, p, 1);
  assert.equal(sleepy.ok, true);
  assert.match(sleepy.message, /queued — the device applies it at its next wake-up/);
  assert.equal((await rig(() => ({ status: 'accepted' })).runner.setConfigParam(5, p, 1)).message.endsWith(': ok'), true);
  assert.match((await rig(() => null).runner.setConfigParam(5, p, 1)).message, /Home Assistant returned no status/);
  assert.deepEqual(configResult({ status: 'accepted' }, true), { ok: true });
});

test('heal and remove-failed wait long for the reply but only 10 s for the socket; nothing else changes (v0.72.0)', async () => {
  const R = rig(() => true);
  await R.runner.healNode(5);
  await R.runner.removeFailed(5);
  await R.runner.reInterview(5);
  await R.runner.refreshValues(5);
  await R.runner.rebuildAll();
  const by = (t: string) => R.sent.find((s) => s.cmd.type === t)!.timeout;
  assert.deepEqual(by('zwave_js/rebuild_node_routes'), { readyMs: READY_TIMEOUT_MS, replyMs: HEAL_TIMEOUT_MS });
  assert.deepEqual(by('zwave_js/remove_failed_node'), { readyMs: READY_TIMEOUT_MS, replyMs: REMOVE_FAILED_TIMEOUT_MS });
  assert.equal(HEAL_TIMEOUT_MS, 1_200_000);
  assert.equal(REMOVE_FAILED_TIMEOUT_MS, 180_000);
  for (const t of ['zwave_js/refresh_node_info', 'zwave_js/refresh_node_values', 'zwave_js/begin_rebuilding_routes']) {
    assert.equal(by(t), undefined, `${t} keeps the default`);
  }
});

test('a heal Home Assistant stopped waiting for is UNKNOWN — not failed, not learned (v0.72.0)', async () => {
  for (const err of ['HA WS timeout (id 9, zwave_js/rebuild_node_routes)', 'HA WS connection closed']) {
    const R = rig(() => new Error(err));
    const r = await R.runner.healNode(5);
    assert.equal(r.ok, false);
    assert.equal(r.unknown, true);
    assert.match(r.message, /outcome unknown — .*; the driver may still be working/);
    assert.ok(R.logs.some((l) => l.sev === 'warn' && /outcome unknown/.test(l.text)), 'warn, not a red failure');
    assert.deepEqual(R.outcomes, [], 'never learned');
  }
  const x = rig(() => new Error('HA WS timeout (id 3, zwave_js/remove_failed_node)'));
  const r = await x.runner.removeFailed(5);
  assert.equal(r.unknown, true);
  assert.deepEqual(x.removed, [], 'an unknown removal never forgets the node');
  const other = rig(() => new Error('HA WS timeout (id 4, zwave_js/refresh_node_info)'));
  assert.notEqual((await other.runner.reInterview(5)).unknown, true, 'only the two long verbs read a timeout as unknown');
});

test('every learned verb carries its origin, and the launch status is read BEFORE the await (v0.72.0)', async () => {
  const R = rig(() => true, { status: NodeStatus.Dead });
  await R.runner.healNode(5, 'engine');
  assert.deepEqual([R.outcomes[0].origin, R.outcomes[0].alive, R.outcomes[0].sentAt], ['engine', false, 1_000],
    'Dead at launch, though the node answered by the time the call returned');
  const S = rig(() => true);
  await S.runner.refreshValues(5, 'engine');
  await S.runner.reInterview(5, 'engine');
  await S.runner.removeFailed(5, 'engine');
  await S.runner.rebuildAll('engine');
  await S.runner.stopRebuild('engine');
  await S.runner.healNode(5);
  assert.deepEqual(S.outcomes.map((o) => o.origin), ['engine', 'engine', 'engine', 'engine', 'engine', 'you']);
  assert.ok(S.outcomes.slice(0, 3).every((o) => o.alive === true));
});

test('a one-node rebuild or removal is IN FLIGHT while it runs, and cleared after — even when it throws (v0.72.0)', async () => {
  const R = rig(() => true);
  await R.runner.healNode(5);
  assert.deepEqual(R.inFlight(), { kind: 'healNode', nodeId: 5, since: 1_000 });
  assert.equal(R.runner.operatorActionInFlight(), null);
  const T = rig(() => new Error('boom'));
  await T.runner.removeFailed(6);
  assert.equal((T.inFlight() as { kind: string }).kind, 'removeFailed');
  assert.equal(T.runner.operatorActionInFlight(), null, 'cleared in a finally');
  const P = rig(() => null);
  await P.runner.ping(5);
  assert.equal(P.inFlight(), null, 'a ping is not one');
});

/* ── v0.72.0 review: every rebuild is tracked on its own; launch and settle ── */

function deferredRig() {
  const pending: Array<{ cmd: any; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const hooks: string[] = [];
  let clock = 1_000;
  const client = {
    send: (cmd: any) => new Promise((resolve, reject) => { pending.push({ cmd, resolve, reject }); }),
  } as unknown as HaWsClient;
  const runner = createActionRunner({
    client, entryId: () => 'entry-1', deviceIdOf: (n) => `dev-${n}`, pingEntityOf: (n) => `button.node${n}_ping`,
    log: () => {}, statusOf: () => NodeStatus.Alive, now: () => clock, enabled: true,
    onLaunch: (kind, n, origin, at, alive) => hooks.push(`launch ${kind} ${n} ${origin} ${at} ${alive}`),
    onSettled: (kind, n, origin, at, settledAt) => hooks.push(`settled ${kind} ${n} ${at} ${settledAt}`),
  });
  return { runner, pending, hooks, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test('two rebuilds at once: the first to finish does not end the stand-down for the other (v0.72.0 review)', async () => {
  const R = deferredRig();
  const h5 = R.runner.healNode(5);
  R.tick(1_000);
  const h7 = R.runner.healNode(7);
  assert.equal(R.runner.operatorActionInFlight()?.nodeId, 5, 'the oldest running is reported');
  R.pending[0].resolve(true);
  await h5;
  assert.equal(R.runner.operatorActionInFlight()?.nodeId, 7, 'heal 7 still holds auto-ping off');
  R.pending[1].resolve(true);
  await h7;
  assert.equal(R.runner.operatorActionInFlight(), null);
});

test('an UNKNOWN heal keeps the stand-down until its own reply bound has passed (v0.72.0 review)', async () => {
  const R = deferredRig();
  const h = R.runner.healNode(5);
  R.tick(60_000);
  R.pending[0].reject(new Error('HA WS connection closed'));
  const r = await h;
  assert.equal(r.unknown, true);
  assert.equal(R.runner.operatorActionInFlight()?.nodeId, 5, 'the driver may still be rebuilding');
  R.tick(HEAL_TIMEOUT_MS - 60_000 - 1);
  assert.equal(R.runner.operatorActionInFlight()?.nodeId, 5);
  R.tick(1);
  assert.equal(R.runner.operatorActionInFlight(), null, 'released at launch + HEAL_TIMEOUT_MS');
  assert.deepEqual(R.hooks, ['launch healNode 5 you 1000 true', `settled healNode 5 1000 ${1_000 + HEAL_TIMEOUT_MS}`],
    'the ledger is told the launch before the await, and an unknown settles at its reply bound');
});

test('launch comes before the await for every learned verb and never for device control; Unknown status is not alive (v0.72.0 review)', async () => {
  const R = deferredRig();
  const p = R.runner.ping(5);
  assert.equal(R.hooks.length, 1, 'fired before the reply');
  R.pending[0].resolve(null);
  await p;
  const c = R.runner.controlEntity(5, 'light.x', 'on');
  R.pending[1].resolve(null);
  await c;
  assert.equal(R.hooks.filter((x) => x.startsWith('launch')).length, 1, 'device control is not a remediation');
  const U = rig(() => true, { status: NodeStatus.Unknown });
  await U.runner.healNode(5);
  assert.equal(U.outcomes[0].alive, false, 'Unknown is not evidence of life');
});

test('each settle says what the action may have done: ok, none (never sent / refused) or maybe (second review)', async () => {
  const eff = async (reply: (cmd: any) => unknown, verb: (r: ReturnType<typeof createActionRunner>) => Promise<unknown>, over: { noDevice?: boolean } = {}) => {
    const effects: string[] = [];
    const client = { send: async (cmd: any) => { const r = reply(cmd); if (r instanceof Error) throw r; return r; } } as unknown as HaWsClient;
    const runner = createActionRunner({
      client, entryId: () => 'e', deviceIdOf: (n) => (over.noDevice ? null : `dev-${n}`), pingEntityOf: () => 'button.p', log: () => {},
      statusOf: () => NodeStatus.Alive, enabled: true, onSettled: (_k, _n, _o, _a, _s, e) => effects.push(e),
    });
    await verb(runner);
    return effects[0];
  };
  assert.equal(await eff(() => true, (r) => r.healNode(5)), 'ok');
  assert.equal(await eff(() => false, (r) => r.healNode(5)), 'maybe', 'returned false: its routes may be partly changed');
  assert.equal(await eff(() => new Error('HA WS connection closed'), (r) => r.healNode(5)), 'maybe', 'unknown');
  assert.equal(await eff(() => new Error('HA WS timeout (id 3, zwave_js/refresh_node_info)'), (r) => r.reInterview(5)), 'maybe', 'sent, then timed out');
  assert.equal(await eff(() => null, (r) => r.healNode(5), { noDevice: true }), 'none', 'never sent');
  assert.equal(await eff(() => new Error('HA WS not ready (auth timeout)'), (r) => r.healNode(5)), 'none');
  assert.equal(await eff(() => new Error('Z-Wave error 361 - removal aborted (ZW0361)'), (r) => r.removeFailed(5)), 'none', 'a refusal changed nothing');
});

test('the HA client\'s own pre-send failures are "none", not "maybe" (third review)', async () => {
  for (const [err, want] of [['HA WS not open', 'none'], ['HA WS client not configured (SUPERVISOR_TOKEN absent)', 'none'], ['HA WS client stopped', 'maybe']] as const) {
    const effects: string[] = [];
    const client = { send: async () => { throw new Error(err); } } as unknown as HaWsClient;
    const runner = createActionRunner({ client, entryId: () => 'e', deviceIdOf: (n) => `dev-${n}`, pingEntityOf: () => 'b', log: () => {},
      statusOf: () => NodeStatus.Alive, enabled: true, onSettled: (_k, _n, _o, _a, _s, e) => effects.push(e) });
    await runner.healNode(5);
    assert.equal(effects[0], want, err);
  }
});
