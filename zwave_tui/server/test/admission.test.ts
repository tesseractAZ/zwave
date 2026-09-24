/**
 * The admission rule (v0.72.0, DESIGN §3.5): which verbs may ever run with no
 * operator present. Nothing is admitted today, and these tests are what keep
 * that a mechanism rather than a sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERB_ADMISSION, AUTO_ADMISSIBLE, NEVER_AUTO, manualBecause, ADMISSION_SUMMARY } from '../src/zwave/admission';
import { planFor } from '../src/zwave/planner';
import type { Symptom, SymptomKind } from '../src/zwave/symptoms';
import { NodeStatus, type ActionKind, type NodeSnapshot } from '../src/types';

const ALL_VERBS: ActionKind[] = ['ping', 'refreshValues', 'reInterview', 'healNode', 'rebuildAll', 'stopRebuild',
  'removeFailed', 'controlEntity', 'setConfigParam', 'routedRead'];

test('every verb has exactly one admission row, and no row names a verb that does not exist', () => {
  assert.deepEqual(Object.keys(VERB_ADMISSION).sort(), [...ALL_VERBS].sort());
  for (const v of ALL_VERBS) assert.equal(VERB_ADMISSION[v].verb, v, `${v}'s row names itself`);
});

test('the admissible set is exactly the verbs with no failure rows — and today that is none (v0.72.0)', () => {
  const passing = ALL_VERBS.filter((v) => VERB_ADMISSION[v].fails.length === 0);
  assert.deepEqual([...AUTO_ADMISSIBLE], passing, 'admitting a verb means deleting its failure rows');
  assert.deepEqual([...AUTO_ADMISSIBLE], []);
  assert.equal(ADMISSION_SUMMARY, 'none admitted (DESIGN §3.5)');
});

test('the never-automatic set is the seven state-changing verbs, and each fails on side effect, blocking or undo (v0.72.0)', () => {
  assert.deepEqual([...NEVER_AUTO].sort(), ['controlEntity', 'healNode', 'reInterview', 'rebuildAll', 'removeFailed', 'setConfigParam', 'stopRebuild']);
  assert.deepEqual(new Set([...NEVER_AUTO, 'ping', 'routedRead', 'refreshValues']), new Set(ALL_VERBS), 'with the three read-class verbs it covers every verb');
  for (const v of NEVER_AUTO) {
    assert.ok(VERB_ADMISSION[v].fails.some((f) => f.p === 'P1' || f.p === 'P3' || f.p === 'P4'), `${v} must fail P1, P3 or P4`);
  }
});

test('the two verbs that already run on their own are named as such, and fail the rule honestly (v0.72.0)', () => {
  const auto = ALL_VERBS.filter((v) => VERB_ADMISSION[v].alreadyAutonomousAs != null).sort();
  assert.deepEqual(auto, ['ping', 'routedRead']);
  assert.deepEqual(VERB_ADMISSION.ping.fails.map((f) => f.p), ['P2', 'P3', 'P5']);
  assert.deepEqual(VERB_ADMISSION.routedRead.fails.map((f) => f.p), ['P1', 'P2', 'P5']);
  for (const v of ALL_VERBS) for (const f of VERB_ADMISSION[v].fails) {
    assert.ok(f.why.length > 20 && f.source.length > 5, `${v} ${f.p}: a reason and a source`);
  }
});

test('every planned action carries a short reason a person runs it (v0.72.0)', () => {
  const now = 1_700_000_000_000;
  const node: NodeSnapshot = { nodeId: 7, deviceId: 'd7', name: 'Node 7', area: null, status: NodeStatus.Alive, statusLabel: 'alive',
    ready: true, isRouting: true, isListening: true, isLongRange: false, isController: false, isSecure: true, securityClass: 'S2',
    manufacturer: null, model: null, battery: null, firmware: null,
    stats: { rtt: 30, rssi: -60, lwr: { repeaters: [], protocolDataRate: 3, rssi: -60, repeaterRSSI: [], routeFailedBetween: null }, nlwr: null,
      commandsTX: 200, commandsRX: 198, commandsDroppedTX: 0, commandsDroppedRX: 1, timeoutResponse: 0, lastSeen: now - 3000 },
    entities: [] };
  const kinds: SymptomKind[] = ['return-path-degraded', 'chronic-return-path', 'dead-flap', 'node-down', 'quiet-node', 'rate-fallback',
    'route-churn', 'rtt-degraded', 'weak-signal', 'chatty-device', 'ghost-suspect', 'controller-degraded', 'edge-cluster',
    'mesh-interference', 's2-desync'];
  let seen = 0;
  for (const kind of kinds) {
    const s: Symptom = { kind, nodeId: kind === 'controller-degraded' || kind === 'mesh-interference' ? null : 7, severity: 'warn',
      sinceMs: now - 600_000, basis: 'measured', evidence: [{ label: 'x', value: 'y' }], narrative: 'n' };
    for (const c of planFor(s, node, { writeActions: true }).candidates) {
      if (c.action == null) continue;
      seen++;
      const why = manualBecause(c.action);
      assert.ok(why.length > 0 && why.length <= 60, `${kind} → ${c.action}: "${why}"`);
    }
  }
  assert.ok(seen > 0, 'fixture guard: some plan offers an action');
});
