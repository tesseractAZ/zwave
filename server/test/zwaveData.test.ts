import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsNodeId, mapRouteRaw, statsCounters, isFreshSample } from '../src/zwave/zwaveData';

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
