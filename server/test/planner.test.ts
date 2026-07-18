import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFor, planAll, type Plan } from '../src/zwave/planner';
import type { Symptom, SymptomKind } from '../src/zwave/symptoms';
import { NodeStatus } from '../src/types';
import type { NodeSnapshot, NodeStats } from '../src/types';

const now = 1_700_000_000_000;

function stats(over: Partial<NodeStats> = {}): NodeStats {
  return { rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null, commandsTX: 200, commandsRX: 198, commandsDroppedTX: 0, commandsDroppedRX: 1, timeoutResponse: 0, lastSeen: now - 3000, ...over };
}
function node(id: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return { nodeId: id, deviceId: 'd' + id, name: `Node ${id}`, area: null, status: NodeStatus.Alive, statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false, isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null, battery: null, firmware: null, stats: stats(), entities: [], ...over };
}
function sym(kind: SymptomKind, over: Partial<Symptom> = {}): Symptom {
  return { kind, nodeId: 7, severity: 'warn', sinceMs: now - 600_000, basis: 'measured', evidence: [{ label: 'x', value: 'y' }], narrative: 'n', ...over };
}

/** Every SymptomKind the detector union can emit. `as const satisfies` pins each
 *  entry to a valid kind; the `_Missing` guard below fails to COMPILE if a new
 *  SymptomKind is added to the union but not listed here — so a new kind can
 *  never silently escape the invariant loops in this file. */
const ALL_KINDS = [
  'return-path-degraded', 'chronic-return-path', 'dead-flap', 'quiet-node',
  'rate-fallback', 'route-churn', 'rtt-degraded', 'weak-signal', 'chatty-device',
  'ghost-suspect', 'controller-degraded', 'mesh-interference',
] as const satisfies readonly SymptomKind[];
// Compile-time exhaustiveness: if this errors, a SymptomKind is missing above.
type _MissingKind = Exclude<SymptomKind, (typeof ALL_KINDS)[number]>;
const _kindsExhaustive: _MissingKind extends never ? true : ['MISSING SymptomKind(s):', _MissingKind] = true;
void _kindsExhaustive;

const ON = { writeActions: true };
const OFF = { writeActions: false };

test('every SymptomKind yields a plan with a headline and at least one candidate', () => {
  for (const kind of ALL_KINDS) {
    const p = planFor(sym(kind, { nodeId: kind === 'controller-degraded' || kind === 'mesh-interference' ? null : 7 }), node(7), ON);
    assert.ok(p.headline.length > 0, `${kind}: non-empty headline`);
    assert.ok(p.candidates.length >= 1, `${kind}: ≥1 candidate`);
    assert.equal(p.kind, kind);
    for (const c of p.candidates) {
      assert.ok(c.title.length > 0, `${kind}: candidate has a title`);
      assert.ok(c.rationale.length > 0, `${kind}: candidate has a rationale`);
    }
  }
});

test('LOAD-BEARING: a route rebuild (healNode) is NEVER offered as a runnable candidate', () => {
  // RESEARCH §4.1: a rebuild does not fix a physically bad link and deletes
  // manual priority routes. Wherever the planner mentions healNode, it must be
  // blocked (marked "not recommended / will not help"), never runnable.
  for (const kind of ALL_KINDS) {
    for (const ctx of [ON, OFF]) {
      const p = planFor(sym(kind, { nodeId: 7 }), node(7), ctx);
      for (const c of p.candidates) {
        if (c.action === 'healNode') {
          assert.ok(c.blocked != null, `${kind}: healNode candidate must be blocked, got runnable`);
        }
        // rebuildAll (mesh-wide) must never appear from a per-symptom plan at all.
        assert.notEqual(c.action, 'rebuildAll', `${kind}: mesh-wide rebuild must not be a per-symptom candidate`);
      }
    }
  }
});

test('Long-Range nodes never receive a route/repeater/heal candidate (rebuild THROWS on LR)', () => {
  const lr = node(300, { isLongRange: true });
  for (const kind of ALL_KINDS) {
    const p = planFor(sym(kind, { nodeId: 300 }), lr, ON);
    for (const c of p.candidates) {
      assert.notEqual(c.action, 'healNode', `${kind}: no heal on LR`);
      assert.ok(!/repeater/i.test(c.title), `${kind}: no repeater title on LR ("${c.title}")`);
    }
  }
});

test('with write-actions OFF, every executable candidate is blocked; physical guidance stays available', () => {
  for (const kind of ALL_KINDS) {
    const p = planFor(sym(kind, { nodeId: 7 }), node(7), OFF);
    for (const c of p.candidates) {
      if (c.action != null) assert.ok(c.blocked != null, `${kind}: executable "${c.title}" must be blocked when writeActions off`);
    }
    // Every plan still offers at least one physical (action:null) recommendation
    // OR an executable — never leaves the operator with an empty, all-blocked list
    // that gives no guidance.
    assert.ok(p.candidates.some((c) => c.action === null), `${kind}: at least one physical/advisory candidate`);
  }
});

test('with write-actions ON, a benign executable unblocks (refreshValues on a mains node)', () => {
  const p = planFor(sym('return-path-degraded', { nodeId: 7 }), node(7), ON);
  const refresh = p.candidates.find((c) => c.action === 'refreshValues');
  assert.ok(refresh, 'return-path plan offers refreshValues');
  assert.equal(refresh!.blocked, null, 'refreshValues is runnable when writeActions on and node is mains-powered');
});

test('probe actions (ping) are blocked on battery/FLiRS nodes even with write-actions ON', () => {
  const batt = node(7, { battery: { level: 40, isLow: false } });
  const flirs = node(8, { isListening: false });
  for (const n of [batt, flirs]) {
    const p = planFor(sym('dead-flap', { nodeId: n.nodeId }), n, ON);
    const ping = p.candidates.find((c) => c.action === 'ping');
    assert.ok(ping, 'dead-flap plan offers a ping');
    assert.ok(ping!.blocked != null && /battery|FLiRS/i.test(ping!.blocked), `ping blocked on battery/FLiRS (${p.nodeId})`);
  }
});

test('ghost-suspect removal is destructive and executable — never a physical no-op, always verify-first', () => {
  const p = planFor(sym('ghost-suspect', { nodeId: 7 }), node(7), ON);
  const rm = p.candidates.find((c) => c.action === 'removeFailed');
  assert.ok(rm, 'ghost-suspect offers removeFailed');
  assert.equal(rm!.cost, 'destructive', 'removeFailed is tier destructive');
  assert.ok(/verify|confirm|gone|truly/i.test(rm!.rationale), 'rationale insists on verifying first');
  // And a physical "confirm it is really gone" step precedes destruction.
  assert.ok(p.candidates.some((c) => c.action === null), 'ghost-suspect includes a non-destructive confirmation step');
});

test('no candidate fabricates a numeric dB / dBm claim (RESEARCH §1.7 — inferences must not read as measurements)', () => {
  // A number followed by dB or dBm, with or without a space. Covers the LR and
  // inferred branches too — not just the non-LR/measured happy path.
  const dbRe = /-?\d+(\.\d+)?\s?dBm?\b/i;
  const probe = [node(7), node(300, { isLongRange: true })]; // non-LR + LR candidate paths
  for (const kind of ALL_KINDS) {
    for (const n of probe) {
      for (const basis of ['measured', 'inferred'] as const) {
        const p = planFor(sym(kind, { nodeId: n.nodeId, basis }), n, ON);
        for (const c of p.candidates) {
          const text = `${c.title} ${c.rationale}`;
          assert.ok(!dbRe.test(text), `${kind}/${n.nodeId}/${basis}: candidate leaks a numeric dB figure ("${text.slice(0, 60)}…")`);
        }
      }
    }
  }
});

test('planFor tolerates an ABSENT node snapshot (roster miss) and still fails CLOSED', () => {
  // The Remedy screen calls planFor with node===undefined when a symptom outlives
  // its node in the roster. LR must still be recovered from the nodeId (≥256), and
  // a ping probe must be WITHHELD (we cannot prove the absent node is mains).
  const lrPlan = planFor(sym('weak-signal', { nodeId: 300 }), undefined, ON);
  for (const c of lrPlan.candidates) {
    assert.notEqual(c.action, 'healNode', 'no heal for an absent LR node');
    assert.ok(!/repeater/i.test(c.title), 'no repeater for an absent LR node');
  }
  const deadPlan = planFor(sym('dead-flap', { nodeId: 42 }), undefined, ON);
  const ping = deadPlan.candidates.find((c) => c.action === 'ping');
  assert.ok(ping && ping.blocked != null && /roster/i.test(ping.blocked), 'ping withheld on an absent node (fail closed)');
  // A non-LR absent node still yields a sane, non-empty plan.
  const mains = planFor(sym('rtt-degraded', { nodeId: 7 }), undefined, ON);
  assert.ok(mains.candidates.length >= 1 && mains.headline.length > 0, 'absent mains node still gets a plan');
});

test('mesh-interference: inferred vs measured split — inferred is unconfirmed & basis "inference", measured points at the flooder', () => {
  const inferred = planFor(sym('mesh-interference', { nodeId: null, basis: 'inferred' }), undefined, ON);
  assert.ok(/unconfirmed|likely/i.test(inferred.headline), 'inferred headline is hedged');
  assert.ok(inferred.candidates.some((c) => c.basis === 'inference'), 'inferred plan carries an inference-basis candidate');
  assert.ok(inferred.candidates.some((c) => /survey|measurement|noise/i.test(c.rationale)), 'inferred plan asks for a measurement to confirm');

  const measured = planFor(sym('mesh-interference', { nodeId: null, basis: 'measured' }), undefined, ON);
  assert.ok(/flooding|device/i.test(measured.headline), 'measured headline names a flooding device');
  assert.ok(measured.candidates.some((c) => /flooding|chatty|reporting/i.test(c.rationale)), 'measured plan points at the flooder');
});

test('M5: efficacyFor is attached to EXECUTABLE candidates only (physical guidance is unscored)', () => {
  const eff = { expectedEfficacy: 0.9, n: 6, baseRate: 0.2, beatsSelfHealing: true, ready: true };
  const calls: string[] = [];
  const ctx = { writeActions: true, efficacyFor: (k: SymptomKind, a: string) => { calls.push(`${k}:${a}`); return eff; } };
  const p = planFor(sym('return-path-degraded', { nodeId: 7 }), node(7), ctx);
  for (const c of p.candidates) {
    if (c.action != null) assert.deepEqual(c.efficacy, eff, `executable "${c.title}" carries efficacy`);
    else assert.ok(c.efficacy == null, `physical "${c.title}" has no efficacy`);
  }
  // Looked up per (symptom kind, action) — never for physical (null-action) rows.
  assert.ok(calls.every((s) => s.startsWith('return-path-degraded:')));
  assert.ok(calls.length >= 1 && !calls.some((s) => s.endsWith(':null')));
});

test('M5: with no efficacyFor in context, candidates carry no efficacy (advisory reads as before)', () => {
  const p = planFor(sym('dead-flap', { nodeId: 7 }), node(7), ON);
  assert.ok(p.candidates.every((c) => c.efficacy == null), 'no efficacy without a lookup');
});

test('planAll skips symptoms subsumed under a mesh event (their recommendation is the mesh event’s)', () => {
  const symptoms: Symptom[] = [
    sym('weak-signal', { nodeId: 7 }),
    sym('rtt-degraded', { nodeId: 8, subsumedBy: 'mesh-1' }),
    sym('mesh-interference', { nodeId: null, basis: 'inferred' }),
  ];
  const nodeOf = (id: number): NodeSnapshot | undefined => node(id);
  const plans: Plan[] = planAll(symptoms, nodeOf, ON);
  assert.equal(plans.length, 2, 'the subsumed rtt-degraded is dropped');
  assert.ok(!plans.some((p) => p.nodeId === 8), 'node 8 (subsumed) produces no standalone plan');
});
