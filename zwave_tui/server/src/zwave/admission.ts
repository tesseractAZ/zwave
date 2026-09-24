/**
 * The admission rule for automatic remediation (v0.72.0) — DESIGN.md §3.5.
 *
 * The executor tier was specified and deliberately not built. v0.72.0 decides
 * it instead of deferring it: a verb may run with no operator present only if it
 * passes five properties AS THIS ADD-ON IS WIRED, and this table records, verb
 * by verb, every property it fails and the source line that fails it.
 *
 *   P1  no effect on a device, or on Home Assistant state that automations
 *       trigger on
 *   P2  an in-band result: the add-on can tell, from the call, what happened
 *   P3  a fixed frame count, at no more than Normal priority, with no
 *       queue-blocking controller command
 *   P4  nothing persistent to undo
 *   P5  an effect the outcome ledger can measure apart from what the control
 *       arm already receives
 *
 * Nothing passes, so nothing is admitted — and the empty set is pinned by the
 * type checker, not by a comment: `AutoVerb` is `never`. Two verbs predate the
 * rule and fail it — the dead-node ladder's ping and the sweep's routed read.
 * They keep running only as auto-ping, under its gates and the pause, and the
 * table says so (`alreadyAutonomousAs`) rather than pretending they pass.
 *
 * EVIDENCE QUALIFIES EFFICACY, NEVER SAFETY. `NEVER_AUTO` is a fixed set that no
 * option, ledger reading or efficacy claim reaches: a repair that deletes routes,
 * wipes an interview, removes a device, switches a load or rewrites a setting
 * does not become safe because it measured well.
 *
 * Any future admission must, all of: delete that verb's failure rows here in
 * review; pass the pre-registered randomized trial recorded in DESIGN §3.5; be
 * handed to an executor only as a narrowed handle holding the admitted verbs,
 * never the ActionRunner; sit behind its own default-off option, independent of
 * write_actions_enabled; and be re-consented to by the owner.
 */

import type { ActionKind } from '../types';

export type AdmissionProperty = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export interface AdmissionFailure {
  p: AdmissionProperty;
  /** One plain sentence. */
  why: string;
  /** Where it fails, at source. */
  source: string;
}

export interface AdmissionRow {
  verb: ActionKind;
  fails: AdmissionFailure[];
  /** The autonomous path this verb already runs under, or null. */
  alreadyAutonomousAs: string | null;
  /** Why a person runs it, in at most 60 characters — shown beside a plan. */
  manualBecause: string;
}

/** The whole table. A `Record` over `ActionKind`, so a new verb cannot ship
 *  without a row. */
export const VERB_ADMISSION: Readonly<Record<ActionKind, AdmissionRow>> = {
  ping: {
    verb: 'ping',
    fails: [
      { p: 'P2', why: "Home Assistant's ping button runs the ping as a background task and drops whether the node responded.", source: 'ha/button.py:95-97' },
      { p: 'P3', why: 'A ping is sent at Ping priority, above Normal, so it goes ahead of the house\'s own commands.', source: 'zwave-js NoOperationCC.ts:26-37, MessagePriority.ts:17-28' },
      { p: 'P5', why: 'As a remedy its effect cannot be scored — node-down is not scored by design — and it began 100 of 106 mains Dead episodes on the reference mesh.', source: 'outcomes.ts metricOf; DESIGN §3.5 (v0.71.0 amendment)' },
    ],
    alreadyAutonomousAs: 'auto-ping dead-node ladder',
    manualBecause: "runs only as auto-ping's retry; HA returns no result",
  },
  routedRead: {
    verb: 'routedRead',
    fails: [
      { p: 'P1', why: "A Report that corrects a stale Home Assistant state is a state change, and automations react to it.", source: 'ha/entity.py:106-128' },
      { p: 'P2', why: 'zwave_js.refresh_value only dispatches the poll; its errors are logged, not returned.', source: 'ha/services.py:788-797, ha/entity.py:106-128' },
      { p: 'P5', why: 'Every probeable episode in both arms already receives it: five reads when it opens and five when it confirms.', source: 'zwaveData.ts VERIFY_BURST and the verification lane' },
    ],
    alreadyAutonomousAs: 'auto-ping sweep, verification and ladder',
    manualBecause: "runs only as auto-ping's check; HA returns no result",
  },
  refreshValues: {
    verb: 'refreshValues',
    fails: [
      { p: 'P1', why: 'A refreshed value that corrects a stale Home Assistant state fires state-triggered automations.', source: 'ha/entity.py:106-128' },
      { p: 'P2', why: 'Home Assistant sends the refresh with wait_for_result=False, so the call returns before anything is on the air.', source: 'zwave-js-server-python model/node/__init__.py:622-626' },
      { p: 'P5', why: "On 35 of the 38 nodes it is the routed read's single Get, which the verification lane already sends to both arms.", source: 'zwave-js Node.ts:2514-2521; live CC inventory' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'HA returns no result; same Get the checks already send',
  },
  reInterview: {
    verb: 'reInterview',
    fails: [
      { p: 'P1', why: 'It clears the stored values and leaves the entities unavailable until it finishes.', source: 'zwave-js Node.ts:1051-1186' },
      { p: 'P4', why: 'It writes lifeline associations and configuration to the device, which cannot be put back.', source: 'zwave-js Node.ts:1051-1186' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: "wipes the device's stored details; cannot be undone",
  },
  healNode: {
    verb: 'healNode',
    fails: [
      { p: 'P1', why: 'It deletes every return route to the node, priority routes included.', source: 'zwave-js Controller.ts:5220-5241, 5939' },
      { p: 'P2', why: 'A true result can hide a failed, unretried SUC-return-route assignment.', source: 'zwave-js Controller.ts:5215-5218' },
      { p: 'P3', why: 'Neighbour discovery blocks the send queue for about two minutes per attempt, up to five attempts.', source: 'zwave-js AddNodeToNetworkRequest.ts:82-99, Controller.ts:7676-7712' },
      { p: 'P4', why: 'The routes it deleted cannot be restored.', source: 'zwave-js Controller.ts:5220-5241' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'deletes routes and stalls the mesh; cannot be undone',
  },
  rebuildAll: {
    verb: 'rebuildAll',
    fails: [
      { p: 'P1', why: 'It rebuilds the routes of every listening node, one after another.', source: 'zwave-js Controller.ts:4806-5044' },
      { p: 'P3', why: 'Each node blocks the send queue during its neighbour discovery.', source: 'zwave-js Controller.ts:4806-5044' },
      { p: 'P4', why: 'Every route it rewrites, priority routes included, is lost.', source: 'zwave-js Controller.ts:4806-5044' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'rewrites every route in the mesh; cannot be undone',
  },
  stopRebuild: {
    verb: 'stopRebuild',
    fails: [
      { p: 'P4', why: 'It can abort a node between deleting its routes and assigning new ones.', source: 'zwave-js Controller.ts:5049-5074' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'can strand a device mid-rebuild',
  },
  removeFailed: {
    verb: 'removeFailed',
    fails: [
      { p: 'P4', why: 'Removal is permanent: the device must be reset and included again by hand.', source: 'zwave-js Controller.ts:6545-6680' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'permanent; the device must be re-added by hand',
  },
  controlEntity: {
    verb: 'controlEntity',
    fails: [
      { p: 'P1', why: 'It switches, dims, locks or opens a real device.', source: 'zwaveActions.ts controlEntity' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: 'switches a real load',
  },
  setConfigParam: {
    verb: 'setConfigParam',
    fails: [
      { p: 'P1', why: "It changes how the device behaves.", source: 'zwave-js ConfigurationCC.ts:502-648' },
      { p: 'P4', why: "The value persists in the device's own memory.", source: 'zwave-js ConfigurationCC.ts:502-648' },
    ],
    alreadyAutonomousAs: null,
    manualBecause: "changes the device's saved settings",
  },
};

/**
 * The verbs admitted to run automatically: none. `never` rather than a literal
 * union, so admitting one is a type change a reviewer sees, and the pin below
 * fails to compile the moment this stops being empty.
 */
export type AutoVerb = never;
export const AUTO_ADMISSIBLE: readonly AutoVerb[] = [];
const _pinEmpty: [AutoVerb] extends [never] ? true : never = true;
void _pinEmpty;

/**
 * Verbs no option, ledger reading or efficacy claim may ever run automatically.
 * Evidence can show a repair helps; it cannot show that deleting routes,
 * wiping an interview, removing a device, switching a load or rewriting a
 * setting is safe with nobody watching.
 */
export const NEVER_AUTO: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'healNode', 'rebuildAll', 'stopRebuild', 'removeFailed', 'reInterview', 'controlEntity', 'setConfigParam',
]);

/** Why a person — not the engine — runs this verb, in ≤ 60 characters. */
export function manualBecause(v: ActionKind): string {
  return VERB_ADMISSION[v].manualBecause;
}

/** What the TUI and the published engine state say about automatic remediation. */
export const ADMISSION_SUMMARY = 'none admitted (DESIGN §3.5)';
