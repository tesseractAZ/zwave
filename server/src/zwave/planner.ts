/**
 * Remediation PLANNER (M4, DESIGN.md §3.4) — pure `Symptom → Plan`. It turns a
 * detected symptom into a ranked list of candidate remediations, each with a
 * grounded rationale, a `basis` label (so a lore-grade heuristic never reads
 * like a measurement), a cost tier, and — when it can't run right now — a
 * `blocked` reason.
 *
 * Advisory-first (this milestone): the planner only RECOMMENDS. Nothing here
 * executes; the executor + auto-tier are M5. A candidate that maps to an
 * `ActionKind` can be run by the human through the existing type-CONFIRM
 * Actions Menu; a candidate with `action: null` is PHYSICAL guidance (place a
 * repeater, move the stick) — the majority of correct Z-Wave remediations, and
 * not something software can do.
 *
 * The causal table is grounded in RESEARCH.md and follows the spec-backed
 * remediation ORDER (§4.3): controller/interference → ghost cleanup → traffic
 * hygiene → repeater/placement → targeted rebuild (topology change ONLY) →
 * mesh-wide rebuild (last resort). Route rebuild is deliberately almost never
 * the recommendation — it needs topology-change evidence HA's WS can't provide
 * and "does not fix a physically bad link" (RESEARCH §4.1), so it appears only
 * as a caveated, blocked last resort.
 */

import type { NodeSnapshot, ActionKind, Efficacy } from '../types';
import type { Symptom, SymptomKind } from './symptoms';

/** Evidence-grade of a recommendation — surfaced so the UI can distinguish a
 *  measured fact from a construction-class heuristic (DESIGN §3.4, DR). */
export type Basis = 'spec' | 'source' | 'empirical' | 'lore' | 'inference' | 'learned';

/** Cost/blast-radius tier of a candidate. */
export type Cost = 'physical' | 'safe' | 'caution' | 'disruptive' | 'destructive';

export interface PlanCandidate {
  /** Executable verb (Actions Menu / type-CONFIRM), or null for physical guidance. */
  action: ActionKind | null;
  /** Short recommendation label. */
  title: string;
  /** Grounded explanation — NO numeric dB claims (RESEARCH §1.7). */
  rationale: string;
  basis: Basis;
  cost: Cost;
  /** Why this can't run right now (protocol / gate / precondition), or null. */
  blocked: string | null;
  /** M5 learned efficacy vs the no-action arm — populated for executable
   *  candidates when the outcome ledger has data; null otherwise. */
  efficacy?: Efficacy | null;
}

export interface Plan {
  kind: SymptomKind;
  nodeId: number | null;
  /** One-line headline recommendation. */
  headline: string;
  /** Ranked candidates (best first). */
  candidates: PlanCandidate[];
}

export interface PlanContext {
  /** Is the write-actions master gate on? (executable candidates need it) */
  writeActions: boolean;
  /** M5: learned efficacy lookup (from the outcome ledger). Optional — when
   *  absent, candidates carry no efficacy note (advisory reads as before). */
  efficacyFor?: (kind: SymptomKind, action: ActionKind) => Efficacy | null;
}

const REPEATER_RATIONALE =
  'A device far from the controller or behind an RF-hostile wall (metal, foil, stucco-over-lath) is an RF edge node. A mains-powered repeater on an interior path — or relocating the controller — is the physically correct fix. A route rebuild cannot repair a marginal link and can make it worse by discarding a working route.';

/** LR nodes have NO mesh routing — route/repeater/priority remediations are
 *  invalid (rebuild THROWS on them). Only physical/antenna/power apply.
 *  `nodeId` is the authoritative fallback: node ids ≥ 256 are Long-Range by
 *  protocol, so we can recover the LR fact from the symptom's own nodeId even
 *  when the node snapshot is missing (a roster miss) — never failing OPEN into
 *  offering a route/repeater/rebuild candidate for an LR node. */
function isLR(node: NodeSnapshot | undefined, nodeId?: number | null): boolean {
  if (node) return node.isLongRange || node.nodeId >= 256;
  return nodeId != null && nodeId >= 256;
}
/** Battery/FLiRS nodes must not receive test-frame-heavy actions (§4.6). */
function isBatteryOrFlirs(node: NodeSnapshot | undefined): boolean {
  return !!node && (node.battery != null || node.isListening === false);
}

/** Gate an executable candidate: returns a TERSE blocked-reason (rendered as an
 *  inline chip on the Remedy card) or null. Safety gates FAIL CLOSED: when the
 *  node snapshot is missing (a roster miss — the symptom outlived the node in
 *  the roster) we cannot prove a probe is safe, so we withhold it rather than
 *  assume a mains, always-listening node. */
function gateExecutable(node: NodeSnapshot | undefined, ctx: PlanContext, opts: { probes?: boolean } = {}): string | null {
  if (!ctx.writeActions) return 'write actions off';
  if (opts.probes) {
    if (node === undefined) return 'node not in roster — probe withheld';
    if (isBatteryOrFlirs(node)) return 'battery/FLiRS — probe skipped';
  }
  return null;
}

/** The repeater-placement physical candidate — the recurring first-line fix. */
function repeaterCandidate(): PlanCandidate {
  return { action: null, title: 'Add/relocate a repeater on an interior path', rationale: REPEATER_RATIONALE, basis: 'lore', cost: 'physical', blocked: null };
}

/** Build the plan for one symptom. Pure. */
export function planFor(symptom: Symptom, node: NodeSnapshot | undefined, ctx: PlanContext): Plan {
  const nodeId = symptom.nodeId;
  const lr = isLR(node, nodeId);
  const candidates: PlanCandidate[] = [];
  let headline = '';

  switch (symptom.kind) {
    case 'return-path-degraded':
    case 'chronic-return-path':
    case 'weak-signal':
    case 'rtt-degraded': {
      headline = lr
        ? 'Long-Range link — improve placement/antenna (no mesh route to change)'
        : 'Improve the RF path — a repeater or relocation, not a rebuild';
      if (lr) {
        candidates.push({ action: null, title: 'Move the device or the controller / improve antenna', rationale: 'Long-Range nodes talk directly to the controller (no repeaters, no routes). The only fixes are physical: relocate the device or the controller, or improve the antenna. The radio manages its own transmit power.', basis: 'spec', cost: 'physical', blocked: null });
      } else {
        candidates.push(repeaterCandidate());
        // A benign re-poll can confirm the current values without touching routes.
        candidates.push({ action: 'refreshValues', title: 'Refresh values (re-poll, non-mutating)', rationale: 'Re-reads the node’s current values without changing any route. Confirms the live state; it does not fix a marginal link.', basis: 'source', cost: 'safe', blocked: gateExecutable(node, ctx) });
        // Rebuild is the anti-pattern here — offered only to say NOT to.
        candidates.push({ action: 'healNode', title: 'Rebuild routes — NOT recommended here', rationale: 'Rebuilding routes does not fix a physically marginal link and can regress a working route; it also deletes any manually-set priority routes. Only use it after devices were physically moved/added/removed.', basis: 'source', cost: 'disruptive', blocked: 'no topology change — won’t help' });
      }
      break;
    }

    case 'rate-fallback': {
      headline = 'Route regressed below 100k — repeater/placement on that path';
      if (lr) {
        candidates.push({ action: null, title: 'Physical placement (Long-Range has no route to change)', rationale: 'Rate fallback does not apply to Long-Range (100k-only, star topology). If seen, it is a data quirk — no route remediation exists.', basis: 'spec', cost: 'physical', blocked: null });
      } else {
        candidates.push(repeaterCandidate());
        candidates.push({ action: 'healNode', title: 'Rebuild routes (only if a device moved)', rationale: 'A rebuild re-discovers neighbours and may find a faster route IF the topology actually changed — but it deletes manual priority routes and won’t conjure a repeater that isn’t there.', basis: 'source', cost: 'disruptive', blocked: 'no topology change' });
      }
      break;
    }

    case 'route-churn': {
      headline = lr
        ? 'Long-Range — no routes to churn (treat as a data quirk)'
        : 'Route keeps changing — a marginal repeater or intermittent interference';
      if (lr) {
        candidates.push({ action: null, title: 'Physical placement (Long-Range has no mesh routes)', rationale: 'Long-Range nodes hold a single direct link to the controller — there are no routes to churn. If reported here, treat it as a data quirk, not a routing fault.', basis: 'spec', cost: 'physical', blocked: null });
      } else {
        candidates.push({ action: null, title: 'Firm up the marginal repeater on that path', rationale: 'Constant re-routing means the mesh cannot settle on a stable path — usually one intermediate repeater is marginal, or there is intermittent RF interference on the route. Improve or relocate the suspect repeater. A rebuild only re-shuffles the same unstable links and the churn resumes.', basis: 'lore', cost: 'physical', blocked: null });
        candidates.push({ action: 'healNode', title: 'Rebuild routes — NOT recommended (will re-churn)', rationale: 'Rebuilding discards the current routes and re-discovers neighbours, but if the underlying link is marginal the churn simply comes back. Fix the physical path first; it also deletes any manual priority routes.', basis: 'source', cost: 'disruptive', blocked: 'physical-link symptom — won’t settle it' });
      }
      break;
    }

    case 'dead-flap': {
      headline = 'Reachability runbook — a rebuild cannot repair an unreachable node';
      candidates.push({ action: 'ping', title: 'Ping the node (confirm reachability)', rationale: 'A quick reachability probe. If it fails, the node is genuinely unreachable — the next steps are physical.', basis: 'source', cost: 'safe', blocked: gateExecutable(node, ctx, { probes: true }) });
      candidates.push({ action: null, title: 'Power-cycle the device, then exclude/re-include if it persists', rationale: 'A flapping/dead node’s first fix is a physical power cycle. A route rebuild’s first step is to query the node — which a dead node cannot answer — so rebuild cannot help here.', basis: 'lore', cost: 'physical', blocked: null });
      break;
    }

    case 'quiet-node': {
      headline = 'Node is quiet — confirm reachability before assuming a fault';
      candidates.push({ action: 'ping', title: 'Ping (consented reachability check)', rationale: 'The node hasn’t communicated in a while, but no traffic was attempted — silence is not proof of failure. A single consented ping confirms reachability. (It can mark a truly-marginal node dead, so it is not run automatically.)', basis: 'source', cost: 'caution', blocked: gateExecutable(node, ctx, { probes: true }) });
      // Always-available guidance so a quiet node never renders as a single
      // blocked ping with no next step (esp. write-actions off): silence is often
      // benign, and the physical checks below need no software action.
      candidates.push({ action: null, title: 'Check it is powered and in range before assuming a fault', rationale: 'Silence is often not a fault: a battery or FLiRS device may simply be between wakeups, and a mains device may have lost power or been unplugged. Confirm power and placement before any intervention — a healthy sleeper can look identical to a dead node until it next reports.', basis: 'lore', cost: 'physical', blocked: null });
      break;
    }

    case 'chatty-device': {
      headline = 'Tune the device’s reporting — it is flooding the mesh';
      candidates.push({ action: null, title: 'Reduce its reporting (change-based, not timed) or re-include without S0', rationale: 'A device sending orders of magnitude more reports than the mesh median degrades everyone. Fix the cause: raise its reporting thresholds, prefer change-based over timed reports, and avoid S0 security on sensors (it triples the airtime). These are device-config changes, done in the Z-Wave JS UI.', basis: 'source', cost: 'physical', blocked: null });
      candidates.push({ action: 'reInterview', title: 'Re-interview (after changing its config)', rationale: 'Re-reads the device’s capabilities and config — useful after you change its reporting parameters, not a fix on its own.', basis: 'source', cost: 'caution', blocked: gateExecutable(node, ctx) });
      break;
    }

    case 'ghost-suspect': {
      headline = 'Possible ghost — verify before the destructive removal';
      candidates.push({ action: 'removeFailed', title: 'Remove failed node (DESTRUCTIVE — verify first)', rationale: 'Removing a failed node deletes it from the controller and only succeeds if the controller already considers it failed — a responding device cannot be removed this way. This is destructive and permanent: confirm the device is genuinely gone (excluded/factory-reset without exclusion) before running it. Never automated.', basis: 'source', cost: 'destructive', blocked: gateExecutable(node, ctx) });
      candidates.push({ action: null, title: 'First confirm the device is truly gone', rationale: 'If the device still exists, power-cycle it and check whether it rejoins before removing anything. A wrongly-removed real device must be re-included from scratch.', basis: 'lore', cost: 'physical', blocked: null });
      break;
    }

    case 'controller-degraded': {
      headline = 'Controller serial link is struggling — fix the stick side';
      candidates.push({ action: null, title: 'USB-2 port + a short passive extension, away from USB-3; relocate the stick', rationale: 'Rising serial NAK/CAN/timeouts are a host↔stick problem, not a per-node RF fault. Z-Wave sticks are prone to USB-3 broadband interference — move it to a USB-2 port on a short passive extension cable, away from USB-3 ports and metal, ideally central.', basis: 'source', cost: 'physical', blocked: null });
      break;
    }

    case 'mesh-interference': {
      headline = symptom.basis === 'inferred'
        ? 'Correlated mesh degradation — likely RF interference (unconfirmed)'
        : 'Correlated mesh degradation — a flooding device is the likely cause';
      if (symptom.basis === 'inferred') {
        candidates.push({ action: null, title: 'Survey the RF environment (900 MHz interferers) — measurement needed to confirm', rationale: 'Many nodes degraded together with no controller-serial or flooding cause points to an RF-environment event. Common 900 MHz interferers: a utility smart meter, older cordless phones/baby monitors, LoRa/Sidewalk. Confirming this needs a noise-floor reading; treat this as a lead, not a verdict.', basis: 'inference', cost: 'physical', blocked: null });
      } else {
        candidates.push({ action: null, title: 'Fix the flooding device first (see its chatty-device card)', rationale: 'The correlated degradation coincides with a device flooding the mesh — that traffic is the likely cause, not RF interference. Tune the offender’s reporting before looking further.', basis: 'source', cost: 'physical', blocked: null });
      }
      break;
    }

    default: {
      headline = 'No specific remediation — see the symptom detail';
      candidates.push({ action: null, title: 'Observe', rationale: 'This symptom has no specific recommended action yet.', basis: 'inference', cost: 'physical', blocked: null });
    }
  }

  // M5: attach learned efficacy to the executable candidates (physical guidance
  // isn't an action the ledger can score). Purely additive — the recommendation
  // ORDER is unchanged this milestone; efficacy is shown, not yet used to rank.
  if (ctx.efficacyFor) {
    for (const c of candidates) {
      if (c.action != null) c.efficacy = ctx.efficacyFor(symptom.kind, c.action);
    }
  }
  return { kind: symptom.kind, nodeId, headline, candidates };
}

/** Build plans for a list of symptoms (skips ones subsumed under a mesh event —
 *  their recommendation is the mesh event's, per DESIGN §3.3). */
export function planAll(symptoms: Symptom[], nodeOf: (id: number) => NodeSnapshot | undefined, ctx: PlanContext): Plan[] {
  return symptoms.filter((s) => s.subsumedBy == null).map((s) => planFor(s, s.nodeId != null ? nodeOf(s.nodeId) : undefined, ctx));
}
