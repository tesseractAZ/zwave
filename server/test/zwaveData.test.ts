import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsNodeId, mapRouteRaw } from '../src/zwave/zwaveData';

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
