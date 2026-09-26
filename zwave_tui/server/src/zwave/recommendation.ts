/**
 * The one thing that needs a person, as a Home Assistant sensor (v0.72.0).
 *
 * ESCALATION, NOT EXECUTION. No verb is admitted to run on its own
 * (admission.ts), so a problem the engine cannot solve by itself has to reach
 * the owner — and until now it reached only a screen nobody was looking at.
 * `sensor.zwave_tui_recommendation` names ONE problem and the first thing to
 * try, so a notification automation has a single state to trigger on:
 *
 *   summons   auto-ping gave up on a device — it spent its whole budget
 *   action    a symptom has lasted RECOMMEND_PERSIST_MS; its first step is a
 *             verb the Actions Menu runs (behind the typed CONFIRM)
 *   physical  the same, but the first step is something only a person can do
 *   none      nothing has lasted that long
 *
 * `automatic` is the literal `false` in every state: nothing here runs.
 *
 * A notification never leads with an irreversible step: the first candidate
 * that is neither blocked nor destructive is the one named. And a device the
 * dead-node ladder is still working is `physical`, not a prompt to act — the
 * engine is already trying, and a person pressing a key on top of it would only
 * confound what it learns.
 *
 * PURE: the caller supplies the clock and the data.
 */

import type { NodeSnapshot, Efficacy, ActionKind } from '../types';
import type { Symptom, SymptomKind } from './symptoms';
import type { AutoPingSnapshot, AutoPingNodeState } from './autoPing';
import { planFor, type PlanCandidate } from './planner';
import { manualBecause } from './admission';

/** How long a symptom must last before it is worth a person's attention
 *  (v0.72.0). Most symptoms on the reference mesh clear by themselves well
 *  inside it. */
export const RECOMMEND_PERSIST_MS = 60 * 60_000;

export type RecommendationState = 'summons' | 'action' | 'physical' | 'none';

/** The exact attribute set, in order — nothing else may be published. */
export const RECOMMENDATION_ATTRS = [
  'friendly_name', 'node_id', 'node_name', 'symptom', 'severity', 'since', 'headline',
  'recommendation', 'cost', 'action', 'automatic', 'manual_because', 'others', 'watching_since',
] as const;

export interface RecommendationInput {
  symptoms: Symptom[];
  nodeOf: (nodeId: number) => NodeSnapshot | undefined;
  writeActions: boolean;
  efficacyFor?: (kind: SymptomKind, action: ActionKind) => Efficacy | null;
  ap: AutoPingSnapshot | null;
  /** When this add-on started: symptom dwell state is in memory, so every
   *  start restarts the persistence clock, and the sensor says so. */
  startedAt: number;
  now: number;
}

export interface Recommendation {
  state: RecommendationState;
  attrs: Record<(typeof RECOMMENDATION_ATTRS)[number], unknown>;
}

const SEVERITY_RANK: Record<Symptom['severity'], number> = { crit: 0, warn: 1, watch: 2 };

/** The headline for a summons (v0.72.1). The planner's node-down headline
 *  says a ping often revives the node — true before the ladder runs, false
 *  once it has spent its attempts. A ladder whose launches never left the
 *  add-on did not test the node at all, and says so. */
function summonsHeadline(g: AutoPingNodeState): string {
  if (g.launchGaveUp && !g.gaveUp) return 'Node is DOWN — auto-ping could not send its pings, so the node itself was not tested';
  return `Node is DOWN — auto-ping gave up after ${g.attempts} unanswered attempt${g.attempts === 1 ? '' : 's'}`;
}

/** The first candidate a notification may lead with. */
function firstStep(cands: PlanCandidate[], physicalOnly: boolean): PlanCandidate | null {
  return cands.find((c) => c.blocked == null && c.cost !== 'destructive' && (!physicalOnly || c.action == null)) ?? null;
}

export function buildRecommendation(i: RecommendationInput): Recommendation {
  const iso = (t: number | null): string | null => (t == null ? null : new Date(t).toISOString());
  const base = (): Recommendation['attrs'] => ({
    friendly_name: 'Z-Wave TUI recommendation',
    node_id: null, node_name: null, symptom: null, severity: null, since: null, headline: null,
    recommendation: null, cost: null, action: null,
    automatic: false,
    manual_because: null, others: null,
    watching_since: iso(i.startedAt),
  });
  const ctx = { writeActions: i.writeActions, efficacyFor: i.efficacyFor };
  const fill = (s: Symptom, state: 'summons' | 'action' | 'physical', step: PlanCandidate | null, headline: string, others: number): Recommendation => {
    const a = base();
    const node = s.nodeId == null ? undefined : i.nodeOf(s.nodeId);
    a.node_id = s.nodeId;
    a.node_name = node?.name ?? null;
    a.symptom = s.kind;
    a.severity = s.severity;
    // No "minutes persisting" attribute (v0.72.0 review): one that moves every
    // minute makes every publish a new state row and fires every attribute
    // trigger. `since` carries it, and does not move.
    a.since = iso(s.sinceMs);
    a.headline = headline;
    a.recommendation = step?.title ?? null;
    a.cost = step?.cost ?? null;
    a.action = step?.action ?? null;
    a.manual_because = step?.action != null ? manualBecause(step.action) : null;
    a.others = others;
    return { state, attrs: a };
  };

  // 1. SUMMONS: the ladder spent its budget. Same set haStates counts.
  const given = (i.ap?.nodes ?? []).filter((n) => n.gaveUp || n.launchGaveUp).sort((x, y) => x.nodeId - y.nodeId);
  if (given.length > 0) {
    const g = given[0];
    const s: Symptom = i.symptoms.find((x) => x.kind === 'node-down' && x.nodeId === g.nodeId)
      ?? { kind: 'node-down', nodeId: g.nodeId, severity: 'crit', sinceMs: g.deadSinceMs ?? i.now, basis: 'measured', evidence: [], narrative: '' };
    const plan = planFor(s, i.nodeOf(g.nodeId), ctx);
    return fill(s, 'summons', firstStep(plan.candidates, true), summonsHeadline(g), given.length - 1);
  }

  // 2. The oldest, most severe symptom that has lasted long enough.
  const due = i.symptoms
    .filter((s) => s.subsumedBy == null && i.now - s.sinceMs >= RECOMMEND_PERSIST_MS)
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || x.sinceMs - y.sinceMs ||
      (x.nodeId ?? -1) - (y.nodeId ?? -1));
  if (due.length === 0) return { state: 'none', attrs: base() };
  const s = due[0];
  const plan = planFor(s, s.nodeId == null ? undefined : i.nodeOf(s.nodeId), ctx);
  // A device the dead-node ladder is still working: the engine is already
  // trying, so the only useful step for a person is a physical one.
  // Only while auto-ping is actually running (v0.72.0 review): paused or
  // otherwise suppressed, its attempt count does not move, and "the engine is
  // already trying" would be false for as long as that lasts.
  const worked = s.kind === 'node-down' && i.ap?.suppressed === 'none' && (i.ap?.nodes ?? []).some((n) =>
    n.nodeId === s.nodeId && n.deadSinceMs != null && !n.gaveUp && !n.launchGaveUp && n.attempts < (i.ap?.config.maxAttempts ?? 0));
  const step = firstStep(plan.candidates, worked);
  return fill(s, step?.action != null && !worked ? 'action' : 'physical', step, plan.headline, due.length - 1);
}
