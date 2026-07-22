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
import type { ActionRunner, ActionResult, ActionKind, ConfigParam, EntityVerb } from '../types';
import { resolveService, verbLabel } from './entityControl';

export interface ActionRunnerOptions {
  client: HaWsClient;
  /** Current zwave_js config-entry id (null until discovered). */
  entryId: () => string | null;
  /** node id → HA device_id (null if unknown). */
  deviceIdOf: (nodeId: number) => string | null;
  /** node id → its `button.*_ping` entity_id (null if none). */
  pingEntityOf: (nodeId: number) => string | null;
  /** Append an outcome line to the event ring (source 'you'). */
  log: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string) => void;
  /** M5: structured outcome hook — the outcome ledger attributes the action to
   *  its node's open episodes. Fired AFTER the action resolves. */
  onOutcome?: (kind: ActionKind, nodeId: number | null, ok: boolean) => void;
  /** v0.23: invalidate a node's cached config parameters after a successful write,
   *  so the DETAIL screen re-fetches and shows the new value. */
  onConfigWritten?: (nodeId: number) => void;
  enabled: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  ): Promise<ActionResult> => {
    if (!o.enabled) return { ok: false, message: 'write actions are disabled' };
    o.log('info', nodeId, `${verb} …`);
    try {
      await fn();
      o.log('info', nodeId, `${verb} → ok`);
      if (learn) o.onOutcome?.(kind, nodeId, true);
      return { ok: true, message: `${verb}: ok` };
    } catch (e) {
      const msg = errMsg(e);
      o.log('error', nodeId, `${verb} → failed: ${msg}`);
      if (learn) o.onOutcome?.(kind, nodeId, false);
      return { ok: false, message: msg };
    }
  };

  return {
    enabled: o.enabled,
    ping: (n) =>
      run('ping', n, `ping node ${n}`, async () => {
        const ent = o.pingEntityOf(n);
        if (!ent) throw new Error(`node ${n} has no ping button`);
        await o.client.send({ type: 'call_service', domain: 'button', service: 'press', service_data: { entity_id: ent } });
      }),
    refreshValues: (n) => run('refreshValues', n, `refresh values node ${n}`, () => deviceCmd('zwave_js/refresh_node_values', n)),
    reInterview: (n) => run('reInterview', n, `re-interview node ${n}`, () => deviceCmd('zwave_js/refresh_node_info', n)),
    healNode: (n) => run('healNode', n, `rebuild routes node ${n}`, () => deviceCmd('zwave_js/rebuild_node_routes', n)),
    rebuildAll: () => run('rebuildAll', null, 'rebuild ALL routes', () => entryCmd('zwave_js/begin_rebuilding_routes')),
    stopRebuild: () => run('stopRebuild', null, 'stop rebuilding routes', () => entryCmd('zwave_js/stop_rebuilding_routes')),
    removeFailed: (n) => run('removeFailed', n, `remove failed node ${n}`, () => deviceCmd('zwave_js/remove_failed_node', n)),
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
