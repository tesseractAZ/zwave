/**
 * Mutating remediation actions (v0.3) — ping / refresh / re-interview / rebuild
 * routes / remove-failed. Gated by `write_actions_enabled`; every call logs its
 * outcome into the event ring (source 'you') so the Log screen closes the loop.
 *
 * The exact WS command shapes were probed against the live driver:
 *   ping                 call_service button.press { entity_id }   (safe/idempotent)
 *   refresh values       zwave_js/refresh_node_values { device_id }
 *   re-interview         zwave_js/refresh_node_info { device_id }   (heavy)
 *   heal (rebuild node)  zwave_js/rebuild_node_routes { device_id } (mutating)
 *   rebuild ALL routes   zwave_js/begin_rebuilding_routes { entry_id } (disruptive)
 *   stop rebuild         zwave_js/stop_rebuilding_routes { entry_id }
 *   remove failed        zwave_js/remove_failed_node { device_id }  (destructive)
 */

import type { HaWsClient } from '../ha/haWsClient';
import { sanitizeEventText } from './zwaveData';
import type { ActionRunner, ActionResult, ActionKind, ConfigParam, EntityVerb } from '../types';
import { resolveService, verbLabel } from './entityControl';

/** Who asked for an action: a human at the keyboard, or the engine itself. */
export type ActionOrigin = 'you' | 'engine';

/** Why an action failed (v0.43.1). `refused` means the DRIVER rejected the
 *  premise — the diagnosis was wrong — and is the only failure the ledger may
 *  hold against a detector. Everything else could not run and indicts nothing. */
export type ActionRefusal = 'refused' | 'transport';

export interface ActionRunnerOptions {
  client: HaWsClient;
  /** Current zwave_js config-entry id (null until discovered). */
  entryId: () => string | null;
  /** node id → HA device_id (null if unknown). */
  deviceIdOf: (nodeId: number) => string | null;
  /** node id → its `button.*_ping` entity_id (null if none). */
  pingEntityOf: (nodeId: number) => string | null;
  /**
   * Append an outcome line to the event ring.
   *
   * `origin` is the CALLER's provenance, not the runner's (v0.41.0): one runner
   * serves both the operator's typed CONFIRM and auto-ping's autonomous lanes,
   * and attributing its lines to a fixed source made the Log screen tell the
   * operator they had run probes the engine ran. Pre-release review caught the
   * first cut of this fix wired one layer too high — it relabelled auto-ping's
   * narration while `run()`'s own "ping node N → failed" lines, the ones that
   * describe the write and latch RED, still said `operator`.
   */
  log: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string, origin?: ActionOrigin) => void;
  /** M5: structured outcome hook — the outcome ledger attributes the action to
   *  its node's open episodes. Fired AFTER the action resolves. */
  /** `origin` carries WHO ran it (v0.47.0) — the data layer needs it to route a
   *  MANUAL ping into the probe-judging machinery, which the engine already
   *  owns and never applied to the one probe a human actually asked for. */
  onOutcome?: (kind: ActionKind, nodeId: number | null, ok: boolean, refusal?: ActionRefusal, origin?: ActionOrigin) => void;
  /** v0.23: invalidate a node's cached config parameters after a successful write,
   *  so the DETAIL screen re-fetches and shows the new value. */
  onConfigWritten?: (nodeId: number) => void;
  /** v0.35: the node has LEFT the mesh (removeFailed succeeded). Its learned
   *  baselines describe a device that is gone — a later re-include on the same
   *  node id is different hardware, and measuring it against the dead device's
   *  normals is how the engine manufactures symptoms out of a swap. */
  onNodeRemoved?: (nodeId: number) => void;
  enabled: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Z-Wave error codes for `removeFailedNode`, read from @zwave-js/core 15.28.0
 * (`ZWaveErrorCodes`). The enum's own doc comment states why these exist:
 * "Used to identify errors from this library WITHOUT RELYING ON THE SPECIFIC
 * WORDING of the error message."
 */
const ZW_REMOVE_FAILED = 360; // RemoveFailedNode_Failed — FIVE distinct situations
const ZW_REMOVE_NODE_OK = 361; // RemoveFailedNode_NodeOK — the node answered

/**
 * Recover the Z-Wave error code from a driver error that reached us through
 * Home Assistant (v0.43.2).
 *
 * The path is `zwave-js` → `zwave-js-server` → `zwave-js-server-python` → HA's
 * websocket API → this add-on, and it carries the code TWICE, independently:
 *
 *  - `ZWaveError`'s constructor appends a stable suffix to every message —
 *    `appendErrorSuffix()` makes it ` (ZW0361)`, zero-padded to four digits.
 *  - `FailedZWaveCommand` re-states it: `Z-Wave error 361 - <message>`.
 *
 * Either is a machine identifier. Both survive HA's relay verbatim, because
 * `async_handle_failed_command` forwards `err.args[0]` unchanged.
 */
export function zwaveErrorCode(msg: string): number | null {
  const suffix = /\(ZW(\d{4})\)/.exec(msg);
  if (suffix) return Number(suffix[1]);
  const relayed = /Z-Wave error (\d+)\b/.exec(msg);
  return relayed ? Number(relayed[1]) : null;
}

/**
 * Does this driver error mean "the node is NOT failed" — i.e. the controller
 * refused the premise rather than failing to act on it? (v0.43.2)
 *
 * Rewritten against the ACTUAL zwave-js source (Controller.js `removeFailedNode`,
 * 15.28.0). The previous version guessed at phrasings and was wrong three ways:
 * it invented strings the driver never emits ("is not a failed node"), it
 * missed the single MOST LIKELY refusal (zwave-js pings the node three times
 * first and reports "responded to a ping"), and it read the driver's own
 * explicitly AMBIGUOUS reason ("The controller is busy or the node has
 * responded") as a definite refusal.
 *
 * `RemoveFailedNode_NodeOK` (361) is unambiguous: the removal was aborted
 * because the node answered. `RemoveFailedNode_Failed` (360) is NOT — it covers
 * five different outcomes, only two of which say anything about the diagnosis:
 *
 *   REFUSAL   "…could not be started because the node responded to a ping."
 *   REFUSAL   "· Node N is not in the list of failed nodes"
 *   transport "· This controller is not the primary controller"
 *   transport "· The node removal process is currently busy"
 *   transport "· The controller is busy or the node has responded"  ← ambiguous
 *   transport "The removal process could not be completed"
 *
 * The 360 message is assembled from BITFLAGS, so several reasons can appear at
 * once. A refusal is claimed only when a node-is-fine reason is present and no
 * transport reason is: if the controller was not primary, the failed-nodes list
 * was never meaningfully consulted, and blaming the detector would be a
 * fabrication.
 */
export function isNotFailedRefusal(msg: string): boolean {
  const code = zwaveErrorCode(msg);
  if (code === ZW_REMOVE_NODE_OK) return true;
  if (code !== ZW_REMOVE_FAILED) return false;
  // Ambiguous or unrelated-to-the-diagnosis reasons veto the whole message.
  // Exactly ONE 360 message means the device answered, and there is no veto to
  // apply (settled v0.44.0 by reading zwave-js's control flow, not its wording):
  //
  //   - `…could not be started because the node responded to a ping.` is a
  //     STANDALONE message, thrown before the controller is asked anything.
  //   - every other 360 is the bitflag composite, whose bullet reasons are all
  //     either transport faults or the controller's own bookkeeping.
  //
  // `· Node N is not in the list of failed nodes` reads like a refusal and is
  // not one: removeFailedNode pings the node up to THREE times first and only
  // reaches the composite after every ping FAILED, so the device has already
  // been proven silent. That is the controller disagreeing with the driver —
  // calling it a refusal would indict the ghost-suspect detector for being
  // RIGHT.
  //
  // Because the one refusal message cannot co-occur with the composite's
  // bullets, no veto list is needed. An earlier draft carried one; the mutation
  // harness showed every entry was unreachable, and unreachable defensive code
  // is a claim the tests cannot check.
  return /responded to a ping/i.test(msg);
}

export function createActionRunner(o: ActionRunnerOptions): ActionRunner {
  const deviceCmd = async (type: string, nodeId: number): Promise<void> => {
    const dev = o.deviceIdOf(nodeId);
    if (!dev) throw new Error(`node ${nodeId} has no device`);
    await o.client.send({ type, device_id: dev });
  };
  const entryCmd = async (type: string): Promise<void> => {
    const entry = o.entryId();
    if (!entry) throw new Error('no zwave_js entry');
    await o.client.send({ type, entry_id: entry });
  };

  /**
   * Run one action: gate → log start → execute → log + (optionally) LEARN → result.
   * `learn` is false for operator device-control ops (controlEntity/setConfigParam):
   * toggling a light or setting a parameter is NOT a mesh remediation, so it must
   * never be attributed to an open symptom episode in the M5 outcome ledger.
   */
  const run = async (
    kind: ActionKind,
    nodeId: number | null,
    verb: string,
    fn: () => Promise<void>,
    learn = true,
    origin: ActionOrigin = 'you',
  ): Promise<ActionResult> => {
    if (!o.enabled) return { ok: false, message: 'write actions are disabled' };
    o.log('info', nodeId, `${verb} …`, origin);
    try {
      await fn();
      o.log('info', nodeId, `${verb} → ok`, origin);
      if (learn) o.onOutcome?.(kind, nodeId, true, undefined, origin);
      return { ok: true, message: `${verb}: ok` };
    } catch (e) {
      // SANITIZED: this is whatever an HA service call threw, and session.ts
      // puts it straight into the on-screen action-result card.
      const msg = sanitizeEventText(errMsg(e));
      o.log('error', nodeId, `${verb} → failed: ${msg}`, origin);
      // A driver REFUSAL is not a transport failure (v0.43.1). The ledger's
      // `refused-misdiagnosis` verdict — and with it `falsePositives`, the one
      // number that argues AGAINST the card it sits on — was unreachable in
      // production because this catch discarded the driver's own words and
      // reported a bare `false`. Two screens gate a warning on that counter
      // and neither could ever fire.
      //
      // Deliberately NARROW: only a DIAGNOSIS-VERIFYING action can be refused
      // in a way that indicts the detector. `removeFailed` on a node the
      // driver says is alive means the ghost-suspect call was wrong. Every
      // other action, and every transport fault, stays 'transport' — inferring
      // a false positive from an ordinary failure would fabricate exactly the
      // accusation this counter exists to make honestly.
      const refusal: ActionRefusal =
        kind === 'removeFailed' && isNotFailedRefusal(msg) ? 'refused' : 'transport';
      // SELF-CAPTURING (v0.43.1). The patterns below are a best reading of how
      // the driver phrases "this node is not failed"; the exact production
      // string has NOT been observed, and a family this narrow silently
      // under-matching is the failure mode that kept `refused-misdiagnosis`
      // unreachable in the first place. So every removeFailed failure that does
      // NOT classify logs its verbatim text: the first real refusal on this
      // fleet puts the true wording in the log, where it can be read and the
      // family corrected — rather than being lost to a bare `false` again.
      // Only a 360 can carry a REASON STRING the families do not yet cover
      // (v0.44.0). Gating on the code stops this firing for a dropped socket or
      // a timeout, where no driver ever spoke and there is nothing to add.
      if (kind === 'removeFailed' && refusal === 'transport' && zwaveErrorCode(msg) === ZW_REMOVE_FAILED) {
        // A FLAG, not a copy. The generic failure path below already logs
        // `remove failed node N → failed: <msg>`, so the driver's verbatim text
        // is in the ring either way; what was missing is a marker saying this
        // particular 360 reason is one the classifier does not recognise.
        // An earlier draft re-logged the message behind a long prose preamble,
        // which truncation then ate — sinking the very wording it existed to
        // capture.
        o.log('warn', nodeId, 'remove-failed: unclassified ZW0360 reason — see the failure line below', origin);
      }
      if (learn) o.onOutcome?.(kind, nodeId, false, refusal, origin);
      return { ok: false, message: msg };
    }
  };

  return {
    enabled: o.enabled,
    ping: (n, origin = 'you') =>
      run('ping', n, `ping node ${n}`, async () => {
        const ent = o.pingEntityOf(n);
        if (!ent) throw new Error(`node ${n} has no ping button`);
        await o.client.send({ type: 'call_service', domain: 'button', service: 'press', service_data: { entity_id: ent } });
      }, /* learn */ true, origin),
    probe: (n) =>
      run('ping', n, `probe node ${n}`, async () => {
        const ent = o.pingEntityOf(n);
        if (!ent) throw new Error(`node ${n} has no ping button`);
        await o.client.send({ type: 'call_service', domain: 'button', service: 'press', service_data: { entity_id: ent } });
      }, /* learn */ false, /* origin */ 'engine'),
    refreshValues: (n) => run('refreshValues', n, `refresh values node ${n}`, () => deviceCmd('zwave_js/refresh_node_values', n)),
    reInterview: (n) => run('reInterview', n, `re-interview node ${n}`, () => deviceCmd('zwave_js/refresh_node_info', n)),
    healNode: (n) => run('healNode', n, `rebuild routes node ${n}`, () => deviceCmd('zwave_js/rebuild_node_routes', n)),
    rebuildAll: () => run('rebuildAll', null, 'rebuild ALL routes', () => entryCmd('zwave_js/begin_rebuilding_routes')),
    stopRebuild: () => run('stopRebuild', null, 'stop rebuilding routes', () => entryCmd('zwave_js/stop_rebuilding_routes')),
    removeFailed: async (n) => {
      const res = await run('removeFailed', n, `remove failed node ${n}`, () => deviceCmd('zwave_js/remove_failed_node', n));
      if (res.ok) o.onNodeRemoved?.(n); // only on success — a failed removal leaves the node, and its history, in place
      return res;
    },
    controlEntity: (n, entityId, verb: EntityVerb) =>
      run(
        'controlEntity',
        n,
        `${verbLabel(verb).toLowerCase()} ${entityId}`,
        async () => {
          const domain = entityId.split('.')[0];
          const svc = resolveService(domain, verb);
          if (!svc) throw new Error(`cannot ${verb} a ${domain} entity`);
          await o.client.send({ type: 'call_service', domain: svc.domain, service: svc.service, service_data: { entity_id: entityId } });
        },
        false, // operator device control — not a remediation, never learned
      ),
    setConfigParam: (n, param: ConfigParam, value: number) =>
      run(
        'setConfigParam',
        n,
        `set "${param.label}" = ${value}`,
        async () => {
          const dev = o.deviceIdOf(n);
          if (!dev) throw new Error(`node ${n} has no device`);
          const cmd: Record<string, unknown> = {
            type: 'zwave_js/set_config_parameter',
            device_id: dev,
            property: param.property,
            value,
          };
          if (param.propertyKey != null) cmd.property_key = param.propertyKey;
          if (param.endpoint) cmd.endpoint = param.endpoint;
          await o.client.send(cmd);
          o.onConfigWritten?.(n); // drop the stale cache so DETAIL re-fetches the new value
        },
        false, // operator config write — not a remediation, never learned
      ),
  };
}
