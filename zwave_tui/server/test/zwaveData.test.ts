import { test } from 'node:test';
import type { Symptom } from '../src/zwave/symptoms';
import assert from 'node:assert/strict';
import { diffSymptomLog, statsNodeId, mapRouteRaw, statsCounters, isFreshSample, pickDisplayAttrs, mapConfigParams, mapControllerStats } from '../src/zwave/zwaveData';

// ── statsNodeId: the casing bug that froze all live stats ──────────────────
// HA delivers the INITIAL on-subscribe event with `nodeId` (camelCase) but every
// SUBSEQUENT live push with `node_id` (snake_case). Both must resolve or stats
// freeze at their subscribe-time values.
test('statsNodeId accepts the initial camelCase event (nodeId)', () => {
  assert.equal(statsNodeId({ source: 'node', nodeId: 3 }), 3);
});
test('statsNodeId accepts the live snake_case event (node_id) — the freeze fix', () => {
  assert.equal(statsNodeId({ source: 'node', node_id: 3 }), 3);
});
test('statsNodeId prefers nodeId when both present, and rejects when absent', () => {
  assert.equal(statsNodeId({ nodeId: 5, node_id: 9 }), 5);
  assert.equal(statsNodeId({ source: 'node' }), null);
  assert.equal(statsNodeId(null), null);
  assert.equal(statsNodeId({ nodeId: 'x' }), null);
});

// ── mapRouteRaw: snake_case fields, device_id→node_id, index alignment ──────
const resolve = (dev: unknown) => ({ dev3: 3, dev8: 8 })[String(dev)] ?? 0;

test('mapRouteRaw maps a direct route', () => {
  const r = mapRouteRaw({ repeaters: [], protocol_data_rate: 3, rssi: -84, repeater_rssi: [], route_failed_between: null }, resolve);
  assert.deepEqual(r, { repeaters: [], protocolDataRate: 3, rssi: -84, repeaterRSSI: [], routeFailedBetween: null });
});

test('mapRouteRaw resolves repeater device_ids to node ids and keeps per-hop RSSI aligned', () => {
  const r = mapRouteRaw({ repeaters: ['dev3', 'dev8'], protocol_data_rate: 3, rssi: -73, repeater_rssi: [-68, -83], route_failed_between: null }, resolve);
  assert.ok(r);
  assert.deepEqual(r.repeaters, [3, 8]);
  assert.deepEqual(r.repeaterRSSI, [-68, -83]);
  assert.equal(r.repeaters.length, r.repeaterRSSI.length);
});

test('mapRouteRaw keeps alignment (127 sentinel) when a repeater_rssi entry is missing', () => {
  const r = mapRouteRaw({ repeaters: ['dev3', 'dev8'], repeater_rssi: [-68], protocol_data_rate: 2, rssi: -80, route_failed_between: null }, resolve);
  assert.ok(r);
  assert.deepEqual(r.repeaters, [3, 8]);
  assert.deepEqual(r.repeaterRSSI, [-68, 127]); // second hop → no-reading sentinel, still aligned
});

test('mapRouteRaw resolves route_failed_between device_ids and null-guards', () => {
  const r = mapRouteRaw({ repeaters: [], repeater_rssi: [], protocol_data_rate: 3, rssi: -70, route_failed_between: ['dev3', 'dev8'] }, resolve);
  assert.ok(r);
  assert.deepEqual(r.routeFailedBetween, [3, 8]);
  const r2 = mapRouteRaw({ repeaters: [], repeater_rssi: [], protocol_data_rate: 3, rssi: -70, route_failed_between: null }, resolve);
  assert.ok(r2);
  assert.equal(r2.routeFailedBetween, null);
});

test('mapRouteRaw returns null for a null route', () => {
  assert.equal(mapRouteRaw(null, resolve), null);
});

// ── statsCounters: the delta-fabrication guard (design review) ─────────────
// A malformed event whose counters are missing must be REJECTED, never coerced
// to 0 — a coerced-0 snapshot re-baselines the evidence deltas at zero, and the
// next real event's cumulative counter lands as one giant "valid" delta.
test('statsCounters accepts a fully-numeric event', () => {
  const c = statsCounters({ commands_tx: 100, commands_rx: 90, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 });
  assert.deepEqual(c, { tx: 100, rx: 90, dropTx: 1, dropRx: 0, timeout: 5 });
});
test('statsCounters REJECTS an event with any missing/non-numeric counter', () => {
  assert.equal(statsCounters({ commands_rx: 90, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 }), null);
  assert.equal(statsCounters({ commands_tx: 'x', commands_rx: 90, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 }), null);
  assert.equal(statsCounters({ commands_tx: NaN, commands_rx: 90, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 }), null);
});

test('statsCounters truncates float counters and rejects Infinity', () => {
  const c = statsCounters({ commands_tx: 100.7, commands_rx: 90.2, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 });
  assert.deepEqual(c, { tx: 100, rx: 90, dropTx: 1, dropRx: 0, timeout: 5 });
  assert.equal(statsCounters({ commands_tx: Infinity, commands_rx: 90, commands_dropped_tx: 1, commands_dropped_rx: 0, timeout_response: 5 }), null);
});

// ── isFreshSample: the pseudo-replication guard (design review) ────────────
const sigStats = (over = {}) => ({
  rtt: 30, rssi: -60, lwr: null, nlwr: null,
  commandsTX: 100, commandsRX: 90, commandsDroppedTX: 1, commandsDroppedRX: 0,
  timeoutResponse: 5, lastSeen: 1_000, ...over,
});
test('isFreshSample: lastSeen advanced + counters moved ⇒ fresh', () => {
  assert.equal(isFreshSample({ seen: 500, tx: 90, rx: 80, to: 4, dr: 1 }, sigStats()), true);
});
test('isFreshSample: a re-subscribe redelivery (new lastSeen, SAME counters) is NOT fresh', () => {
  assert.equal(isFreshSample({ seen: 500, tx: 100, rx: 90, to: 5, dr: 1 }, sigStats()), false);
});
test('isFreshSample: no stats event since last sample (same lastSeen) is NOT fresh', () => {
  assert.equal(isFreshSample({ seen: 1_000, tx: 90, rx: 80, to: 4, dr: 1 }, sigStats()), false);
});
test('isFreshSample: the first-ever sample (no signature) is NOT fresh — it is a replay', () => {
  assert.equal(isFreshSample(undefined, sigStats()), false);
});

// ── pickDisplayAttrs (v0.22): whitelist the display-relevant HA attributes ──
test('pickDisplayAttrs keeps only whitelisted keys and drops the rest', () => {
  const out = pickDisplayAttrs({
    brightness: 128,
    percentage: 40, // fan speed — MUST be kept (formatEntityState renders it)
    current_temperature: 72,
    unit_of_measurement: '°F',
    supported_features: 3, // dropped
    hs_color: [30, 50], // dropped
    icon: 'mdi:foo', // dropped
  });
  assert.deepEqual(out, { brightness: 128, percentage: 40, current_temperature: 72, unit_of_measurement: '°F' });
});
test('pickDisplayAttrs sanitizes device-controlled STRING attrs (control/ANSI bytes) but not numbers', () => {
  const out = pickDisplayAttrs({ unit_of_measurement: 'W\x1b[2J', device_class: 'mo\ntion', brightness: 200 });
  assert.ok(!/[\x00-\x1f]/.test(String(out.unit_of_measurement)), 'ESC/control stripped from unit');
  assert.ok(!/[\x00-\x1f]/.test(String(out.device_class)), 'newline stripped from device_class');
  assert.equal(out.brightness, 200, 'numeric attr passes through untouched');
});
test('pickDisplayAttrs returns a fresh object (never aliases the source) + handles undefined', () => {
  const src = { brightness: 10 };
  const out = pickDisplayAttrs(src);
  assert.notEqual(out, src);
  out.brightness = 999;
  assert.equal(src.brightness, 10, 'source not mutated');
  assert.deepEqual(pickDisplayAttrs(undefined), {});
});

// ── mapConfigParams (v0.22): raw get_config_parameters → sorted ConfigParam[] ──
test('mapConfigParams sorts by property, resolves enum labels, and reads min/max/unit', () => {
  const raw = {
    '3-112-0-16': { property: 16, value: 2, metadata: { label: 'Switch Mode', writeable: true, states: { '0': 'Off', '1': 'On', '2': 'Always off' } } },
    '3-112-0-3': { property: 3, value: 1500, metadata: { label: 'Dim Duration', writeable: true, unit: 'ms', min: 0, max: 10000 } },
  };
  const out = mapConfigParams(raw);
  assert.equal(out.length, 2);
  // sorted by numeric `property` (3 before 16), NOT by the key string.
  assert.equal(out[0].key, '3-112-0-3');
  assert.equal(out[0].label, 'Dim Duration');
  assert.equal(out[0].value, 1500);
  assert.equal(out[0].unit, 'ms');
  assert.equal(out[0].min, 0);
  assert.equal(out[0].max, 10000);
  assert.equal(out[0].valueLabel, null, 'non-enum param has no value label');
  // the enum param resolves its current value to the matching state label.
  assert.equal(out[1].key, '3-112-0-16');
  assert.equal(out[1].value, 2);
  assert.equal(out[1].valueLabel, 'Always off');
  assert.equal(out[1].writeable, true);
});
test('mapConfigParams is defensive: null raw → [], missing metadata/non-writeable/value defaults', () => {
  assert.deepEqual(mapConfigParams(null), []);
  assert.deepEqual(mapConfigParams(undefined), []);
  const out = mapConfigParams({ '1-1-0-1': { property: 1, metadata: {} } });
  assert.equal(out.length, 1);
  assert.equal(out[0].value, null, 'absent value → null');
  assert.equal(out[0].valueLabel, null);
  assert.equal(out[0].writeable, false, 'writeable defaults to false');
  assert.equal(out[0].label, '1-1-0-1', 'label falls back to the key');
});
test('mapConfigParams: an enum value with no matching state label stays null', () => {
  const out = mapConfigParams({ '1-1-0-1': { property: 1, value: 9, metadata: { label: 'X', states: { '0': 'zero' } } } });
  assert.equal(out[0].value, 9);
  assert.equal(out[0].valueLabel, null);
});

test('mapConfigParams carries set-addressing (property/property_key/endpoint) + enum states', () => {
  const raw = {
    '5-112-1-3-255': { property: 3, property_key: 255, endpoint: 1, value: 2, metadata: { label: 'Partial', writeable: true, states: { '0': 'Off', '2': 'Two' } } },
  };
  const out = mapConfigParams(raw);
  assert.equal(out[0].property, 3);
  assert.equal(out[0].propertyKey, 255);
  assert.equal(out[0].endpoint, 1);
  assert.deepEqual(out[0].states, { '0': 'Off', '2': 'Two' });
});
test('mapConfigParams defaults addressing when the raw omits it (property from key tail, endpoint 0)', () => {
  const out = mapConfigParams({ '5-112-0-7': { value: 1, metadata: { label: 'X' } } });
  assert.equal(out[0].property, 7, 'property falls back to the key tail');
  assert.equal(out[0].propertyKey, null);
  assert.equal(out[0].endpoint, 0);
  assert.equal(out[0].states, null);
});

test('mapConfigParams parses property BY POSITION for a partial-param key (not the last segment)', () => {
  // Partial-param key "<node>-<cc>-<endpoint>-<property>-<propertyKey>", raw omits property.
  const out = mapConfigParams({ '5-112-1-7-255': { value: 1, metadata: { label: 'Partial' } } });
  assert.equal(out[0].property, 7, 'property is the 4th segment, not the propertyKey tail');
  assert.equal(out[0].propertyKey, 255, 'propertyKey parsed from the 5th segment');
  assert.equal(out[0].endpoint, 0);
});

/* ── controller-statistics raw mapping (v0.26: zero tests through 5 releases) ── */

test('controller stats: accepts BOTH the misspelled and corrected timeout_response keys', () => {
  const base = {
    source: 'controller', messages_tx: 100, messages_rx: 90, messages_dropped_tx: 1,
    messages_dropped_rx: 2, nak: 3, can: 4, timeout_ack: 5,
  };
  // HA ships the misspelling today; an upstream fix must not zero the field.
  const misspelled = mapControllerStats({ ...base, timout_response: 7 });
  const corrected = mapControllerStats({ ...base, timeout_response: 7 });
  assert.equal(misspelled?.timeoutResponse, 7, 'the misspelled key HA actually sends');
  assert.equal(corrected?.timeoutResponse, 7, 'the corrected key a future HA may send');
  // And the misspelled key wins only by ?? order — both present, same value path.
  assert.equal(mapControllerStats({ ...base, timout_response: 7, timeout_response: 9 })?.timeoutResponse, 7);
});

test('controller stats: a malformed event is REJECTED, never coerced to zeros', () => {
  const base = {
    source: 'controller', messages_tx: 100, messages_rx: 90, messages_dropped_tx: 1,
    messages_dropped_rx: 2, nak: 3, can: 4, timeout_ack: 5, timout_response: 6,
  };
  assert.ok(mapControllerStats(base), 'control: the well-formed event maps');
  // Each required counter, when non-numeric, must reject the WHOLE event —
  // zeros would re-baseline the evidence deltas and fabricate a giant delta.
  for (const key of ['messages_tx', 'messages_rx', 'messages_dropped_tx', 'messages_dropped_rx', 'nak', 'can', 'timeout_ack'] as const) {
    assert.equal(mapControllerStats({ ...base, [key]: 'not-a-number' }), null, `${key} non-numeric must reject`);
    assert.equal(mapControllerStats({ ...base, [key]: undefined }), null, `${key} absent must reject`);
  }
  assert.equal(mapControllerStats({ ...base, timout_response: undefined }), null, 'BOTH timeout spellings absent must reject');
  assert.equal(mapControllerStats({ ...base, source: 'node' }), null, 'non-controller event must not map');
  assert.equal(mapControllerStats(null), null);
});

test('controller stats: optional timeout_callback null-safe; counters truncated to integers', () => {
  const base = {
    source: 'controller', messages_tx: 100.9, messages_rx: 90, messages_dropped_tx: 1,
    messages_dropped_rx: 2, nak: 3, can: 4, timeout_ack: 5, timout_response: 6,
  };
  const noCb = mapControllerStats(base);
  assert.equal(noCb?.timeoutCallback, null, 'absent optional counter maps to null, not rejection');
  assert.equal(noCb?.messagesTX, 100, 'fractional counter truncated');
  assert.equal(mapControllerStats({ ...base, timeout_callback: 8.7 })?.timeoutCallback, 8);
});

/* ── v0.45.0: a symptom's whole life reaches the Log ──────────────────────── */

const symFix = (over: Partial<Symptom> = {}): Symptom => ({
  kind: 'rtt-degraded', nodeId: 7, severity: 'warn', sinceMs: 1000, basis: 'measured',
  evidence: [], narrative: 'Node 7 round-trip time is above its own normal. More detail here.', ...over,
});

test('an ONSET is logged once, not on every tick (v0.45.0)', () => {
  const a = diffSymptomLog(new Map(), [symFix()]);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].severity, 'warn');
  assert.match(a.events[0].text, /^rtt-degraded: Node 7 round-trip time is above its own normal\.$/,
    'the FIRST SENTENCE, whole');
  const b = diffSymptomLog(a.next, [symFix()]);
  assert.deepEqual(b.events, [], 'an unchanged symptom says nothing further');
});

test('an ESCALATION is logged; a de-escalation is silent (v0.45.0)', () => {
  // A symptom that appeared, escalated watch → crit and cleared produced ONE
  // line — the least severe thing that ever happened — and the operator had no
  // way to know it had ended. Escalation is news; "it got less bad" is not, and
  // logging it would double the volume on a flapping node.
  const a = diffSymptomLog(new Map(), [symFix({ severity: 'watch' })]);
  const b = diffSymptomLog(a.next, [symFix({ severity: 'crit' })]);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].severity, 'error', 'crit maps to error');
  assert.match(b.events[0].text, /escalated watch → crit/);
  const c2 = diffSymptomLog(b.next, [symFix({ severity: 'watch' })]);
  assert.deepEqual(c2.events, [], 'a de-escalation updates state silently');
  // ...and having gone back down, a re-escalation is news again.
  const d = diffSymptomLog(c2.next, [symFix({ severity: 'crit' })]);
  assert.equal(d.events.length, 1, 'the stored severity really was lowered');
});

test('a CLEARED symptom is logged at info, never at its old severity (v0.45.0)', () => {
  // A symptom ENDING is good news. A red line saying so reads as a fault.
  const a = diffSymptomLog(new Map(), [symFix({ severity: 'crit' })]);
  assert.equal(a.events[0].severity, 'error');
  const b = diffSymptomLog(a.next, []);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].severity, 'info', 'a clearance is not a fault');
  assert.equal(b.events[0].nodeId, 7, 'and it names the node, which a Set could not');
  assert.match(b.events[0].text, /rtt-degraded cleared/);
  assert.equal(b.next.size, 0, 'the key is pruned');
});

test('the log line names the RIGHT subsumption, and never cuts a decimal (v0.45.0)', () => {
  // Two defects on one string. It called EVERY subsumption "(under mesh event)"
  // while REMEDY distinguished an edge cluster — so a node folded into a
  // cluster was logged as belonging to an event that did not exist. And
  // `narrative.split('.')[0]` cut a one-decimal number in half: a node silent
  // 7.2 h logged "…has not been heard from in 7".
  const cluster = diffSymptomLog(new Map(), [symFix({ subsumedBy: '9:edge-cluster' })]);
  assert.match(cluster.events[0].text, /under edge cluster/);
  const mesh = diffSymptomLog(new Map(), [symFix({ subsumedBy: 'mesh:mesh-interference' })]);
  assert.match(mesh.events[0].text, /under mesh event/);

  const quiet = diffSymptomLog(new Map(), [symFix({
    kind: 'quiet-node',
    narrative: 'Node 7 has not been heard from in 7.2 h, well past its own cadence. It may be asleep.',
  })]);
  assert.match(quiet.events[0].text, /in 7\.2 h/, `the decimal must survive: ${quiet.events[0].text}`);
  assert.doesNotMatch(quiet.events[0].text, /in 7,|in 7 /, 'never cut mid-number');
});

test('two symptoms sharing a node are tracked apart, and mesh-scoped ones get their own key (v0.45.0)', () => {
  const a = diffSymptomLog(new Map(), [
    symFix({ kind: 'rtt-degraded' }),
    symFix({ kind: 'route-churn' }),
    symFix({ kind: 'mesh-interference', nodeId: null }),
  ]);
  assert.equal(a.events.length, 3);
  assert.equal(a.next.size, 3);
  const b = diffSymptomLog(a.next, [symFix({ kind: 'rtt-degraded' })]);
  assert.equal(b.events.length, 2, 'the other two cleared');
  assert.ok(b.events.every((e) => /cleared/.test(e.text)));
});
