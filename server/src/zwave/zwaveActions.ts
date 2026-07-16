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
import type { ActionRunner, ActionResult } from '../types';

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

  /** Run one action: gate → log start → execute → log outcome → result. */
  const run = async (nodeId: number | null, verb: string, fn: () => Promise<void>): Promise<ActionResult> => {
    if (!o.enabled) return { ok: false, message: 'write actions are disabled' };
    o.log('info', nodeId, `${verb} …`);
    try {
      await fn();
      o.log('info', nodeId, `${verb} → ok`);
      return { ok: true, message: `${verb}: ok` };
    } catch (e) {
      const msg = errMsg(e);
      o.log('error', nodeId, `${verb} → failed: ${msg}`);
      return { ok: false, message: msg };
    }
  };

  return {
    enabled: o.enabled,
    ping: (n) =>
      run(n, `ping node ${n}`, async () => {
        const ent = o.pingEntityOf(n);
        if (!ent) throw new Error(`node ${n} has no ping button`);
        await o.client.send({ type: 'call_service', domain: 'button', service: 'press', service_data: { entity_id: ent } });
      }),
    refreshValues: (n) => run(n, `refresh values node ${n}`, () => deviceCmd('zwave_js/refresh_node_values', n)),
    reInterview: (n) => run(n, `re-interview node ${n}`, () => deviceCmd('zwave_js/refresh_node_info', n)),
    healNode: (n) => run(n, `rebuild routes node ${n}`, () => deviceCmd('zwave_js/rebuild_node_routes', n)),
    rebuildAll: () => run(null, 'rebuild ALL routes', () => entryCmd('zwave_js/begin_rebuilding_routes')),
    stopRebuild: () => run(null, 'stop rebuilding routes', () => entryCmd('zwave_js/stop_rebuilding_routes')),
    removeFailed: (n) => run(n, `remove failed node ${n}`, () => deviceCmd('zwave_js/remove_failed_node', n)),
  };
}
