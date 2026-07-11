import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNode } from '../src/zwave/health';
import { NodeStatus, type NodeSnapshot, type NodeStats } from '../src/types';

const emptyStats = (over: Partial<NodeStats> = {}): NodeStats => ({
  rtt: null, rssi: null, lwr: null, nlwr: null,
  commandsTX: 0, commandsRX: 0, commandsDroppedTX: 0, commandsDroppedRX: 0,
  timeoutResponse: 0, lastSeen: null, ...over,
});

const makeNode = (over: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  nodeId: 5, deviceId: 'd5', name: 'Node 5', area: null,
  status: NodeStatus.Alive, statusLabel: 'alive', ready: true,
  isRouting: true, isListening: true, isLongRange: false, isController: false,
  isSecure: true, securityClass: 'S2', manufacturer: 'ACME', model: 'X',
  battery: null, stats: emptyStats(), entities: [], ...over,
});

const NOISE = -95;

test('dead node scores 0 / F / dead with a D flag', () => {
  const r = scoreNode(makeNode({ status: NodeStatus.Dead, statusLabel: 'dead' }), NOISE);
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'F');
  assert.equal(r.state, 'dead');
  assert.ok(r.flags.includes('D'));
});

test('unknown node is capped low', () => {
  const r = scoreNode(makeNode({ status: NodeStatus.Unknown, statusLabel: 'unknown', ready: false }), NOISE);
  assert.ok(r.score <= 20, `expected capped-low score, got ${r.score}`);
  assert.equal(r.state, 'unknown');
});

test('alive node scores above a dead one and yields a valid grade', () => {
  const alive = scoreNode(makeNode(), NOISE);
  const dead = scoreNode(makeNode({ status: NodeStatus.Dead, statusLabel: 'dead' }), NOISE);
  assert.ok(alive.score > dead.score);
  assert.match(alive.grade, /^[A-F]$/);
  assert.ok(alive.rating >= 0 && alive.rating <= 10);
});

test('battery is a separate lane: low battery flags B but does not change the RF score', () => {
  const mains = scoreNode(makeNode({ battery: null }), NOISE);
  const lowBat = scoreNode(makeNode({ battery: { level: 10, isLow: true } }), NOISE);
  assert.ok(lowBat.flags.includes('B'), 'low battery raises B flag');
  assert.equal(lowBat.score, mains.score, 'battery must not drag the RF score');
});

test('Long-Range node scores without error', () => {
  const r = scoreNode(makeNode({ nodeId: 300, isLongRange: true }), NOISE);
  assert.ok(Number.isFinite(r.score));
  assert.match(r.grade, /^[A-F]$/);
});

test('null / partial stats never produce NaN', () => {
  const r = scoreNode(makeNode({ stats: emptyStats({ rssi: null, rtt: null }) }), NOISE);
  assert.ok(Number.isFinite(r.score));
  assert.ok(!Number.isNaN(r.rating));
});
