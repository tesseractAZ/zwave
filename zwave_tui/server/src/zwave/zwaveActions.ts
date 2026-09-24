/**
 * Mutating remediation actions (v0.3) — ping / refresh / re-interview / rebuild
 * routes / remove-failed. Gated by `write_actions_enabled`; every call logs its
 * outcome into the event ring (source 'you') so the Log screen closes the loop.
 *
 * The exact WS command shapes were probed against the live driver:
 *   ping                 call_service button.press { entity_id }   (one ACK-only NoOp; an unanswered one marks the node Dead)
 *   routed read          call_service zwave_js.refresh_value { entity_id, refresh_all_values: false }
 *                        (one Get; the ladder's follow-up since v0.70.0, the sweep/verification probe since v0.71.0)
 *   refresh values       zwave_js/refresh_node_values { device_id }
 *   re-interview         zwave_js/refresh_node_info { device_id }   (heavy)
 *   heal (rebuild node)  zwave_js/rebuild_node_routes { device_id } (mutating)
 *   rebuild ALL routes   zwave_js/begin_rebuilding_routes { entry_id } (disruptive)
 *   stop rebuild         zwave_js/stop_rebuilding_routes { entry_id }
 *   remove failed        zwave_js/remove_failed_node { device_id }  (destructive)
 *
 * Since v0.72.0 each verb reports what Home Assistant's reply SAYS: a rebuild
 * or stop that returns false did not happen, and a config write that is only
 * `queued` is not confirmed on a listening device. The two long verbs wait 20
 * and 3 minutes for their reply (10 s for the socket), and a timeout there is
 * "outcome unknown", never learned. Every learned verb carries its origin.
 */

import type { HaWsClient } from '../ha/haWsClient';
import { sanitizeEventText } from './zwaveData';
import { NodeStatus, type ActionRunner, type ActionResult, type ActionKind, type ConfigParam, type EntityVerb } from '../types';
import { resolveService, verbLabel } from './entityControl';

/** Who asked for an action: a human at the keyboard, or the engine itself. */
export type ActionOrigin = 'you' | 'engine';

/** Why an action failed (v0.43.1). `refused` means the DRIVER rejected the
 *  premise — the diagnosis was wrong — and is the only failure the ledger may
 *  hold against a detector. Everything else could not run and indicts nothing. */
export type ActionRefusal = 'refused' | 'transport';

/** What an action may have done to the mesh (v0.72.0 second review): `ok` it
 *  reported success; `none` it never reached the driver, or the driver
 *  refused it; `maybe` it reached the driver and did not report success — a
 *  heal that returned false, an outcome unknown, a failure after the send. */
export type ActionEffect = 'ok' | 'none' | 'maybe';

/** Failures that mean nothing was sent. */
// ("HA WS client stopped" is not here: stop() also rejects requests already
// dispatched, so it cannot say nothing left.)
const NOT_SENT = /^HA WS not ready|^HA WS not open|^HA WS client not configured|has no (device|ping button|switch\/light value)|^no zwave_js entry|^write actions are disabled/;

export interface ActionRunnerOptions {
  client: HaWsClient;
  /** Current zwave_js config-entry id (null until discovered). */
  entryId: () => string | null;
  /** node id → HA device_id (null if unknown). */
  deviceIdOf: (nodeId: number) => string | null;
  /** node id → its `button.*_ping` entity_id (null if none). */
  pingEntityOf: (nodeId: number) => string | null;
  /** node id → the switch/light value entity a routed read targets (v0.70.0). */
  readEntityOf?: (nodeId: number) => string | null;
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
  /** `sentAt` is when `run()` LAUNCHED the action, read before the call is
   *  awaited (v0.64.5); passed on success. Home Assistant's ping button starts
   *  the driver's ping in the background and returns, so the node's answer and
   *  HA's reply race — a stamp read after the call resolves can post-date an
   *  answer that won, and the probe judge (`lastSeen >= at`) books it a miss. */
  /** `aliveAtLaunch` (v0.72.0): the node's status was Alive when the action
   *  was sent — read, like `sentAt`, before the call is awaited; Unknown and
   *  Asleep are not alive. The ledger counts
   *  a death after an action only against a node that was alive for it. */
  onOutcome?: (kind: ActionKind, nodeId: number | null, ok: boolean, refusal?: ActionRefusal, origin?: ActionOrigin, sentAt?: number, aliveAtLaunch?: boolean) => void;
  /** A learned verb is about to be sent (v0.72.0) — BEFORE the await, so the
   *  ledger can date its harm windows from the launch and hold an episode's
   *  close while an action on its node is still running. Paired with
   *  `onSettled`, which fires once the call returns, fails or times out. */
  onLaunch?: (kind: ActionKind, nodeId: number | null, origin: ActionOrigin, at: number, aliveAtLaunch: boolean) => void;
  onSettled?: (kind: ActionKind, nodeId: number | null, origin: ActionOrigin, at: number, settledAt: number, effect: ActionEffect) => void;
  /** node id → its current status, or null when unknown (v0.72.0). */
  statusOf?: (nodeId: number) => NodeStatus | null;
  /** node id → mains/FLiRS (true), sleeping (false) or unknown (v0.72.0): a
   *  config write HA reports `queued` means opposite things for the two. */
  listeningOf?: (nodeId: number) => boolean | null;
  /** v0.23: invalidate a node's cached config parameters after a successful write,
   *  so the DETAIL screen re-fetches and shows the new value. */
  onConfigWritten?: (nodeId: number) => void;
  /** v0.35: the node has LEFT the mesh (removeFailed succeeded). Its learned
   *  baselines describe a device that is gone — a later re-include on the same
   *  node id is different hardware, and measuring it against the dead device's
   *  normals is how the engine manufactures symptoms out of a swap. */
  onNodeRemoved?: (nodeId: number) => void;
  /** Clock for `sentAt` (v0.64.5). It must be the clock auto-ping judges with:
   *  both default to `Date.now`, so production passes neither, and a test that
   *  injects one injects the other. */
  now?: () => number;
  enabled: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * How long a single-device route rebuild may take to answer (v0.72.0): up to
 * five neighbour-discovery attempts of about 123 s each, plus the route
 * deletion and assignment steps (zwave-js Controller.ts). The default 10 s
 * reported a heal still running as "failed".
 */
export const HEAL_TIMEOUT_MS = 20 * 60_000;
/** remove_failed_node pings the node up to three times first (v0.72.0). */
export const REMOVE_FAILED_TIMEOUT_MS = 3 * 60_000;
/** Every verb still waits at most this long for the socket itself. */
export const READY_TIMEOUT_MS = 10_000;

/** What a verb's result says, read from the reply rather than assumed. */
type Interpretation = { ok: true; note?: string } | { ok: false; message: string };

const HEAL_FALSE = 'did not complete — the driver returned false (the node did not answer, or neighbour discovery or route deletion failed); its routes may be partly changed';
const HEAL_TRUE_NOTE = 'driver reports success; a failed return-route assignment is not reported';
const REBUILD_FALSE = 'not started — a route rebuild is already running';
const STOP_FALSE = 'nothing to stop — no route rebuild was running';

/** A boolean reply: false is the driver saying it did not do it. */
const boolResult = (falseMsg: string, trueNote?: string) => (r: unknown): Interpretation =>
  r === false ? { ok: false, message: falseMsg } : { ok: true, ...(trueNote ? { note: trueNote } : {}) };

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
  const now = o.now ?? (() => Date.now());
  // The reply is RETURNED (v0.72.0): a route rebuild that returns false did not
  // happen, and until now that false was discarded and reported as "ok".
  const deviceCmd = async (type: string, nodeId: number, replyMs?: number): Promise<unknown> => {
    const dev = o.deviceIdOf(nodeId);
    if (!dev) throw new Error(`node ${nodeId} has no device`);
    return o.client.send({ type, device_id: dev }, replyMs == null ? undefined : { readyMs: READY_TIMEOUT_MS, replyMs });
  };
  const entryCmd = async (type: string): Promise<unknown> => {
    const entry = o.entryId();
    if (!entry) throw new Error('no zwave_js entry');
    return o.client.send({ type, entry_id: entry });
  };
  /**
   * Every single-device rebuild or removal still running (v0.72.0), keyed by
   * launch. A SET, not one slot: after Esc, or from a second session, two can
   * run at once, and the first to finish must not end auto-ping's stand-down
   * for the other. An entry whose outcome came back UNKNOWN is kept until its
   * own reply bound has passed from the launch — the driver may still be
   * rebuilding after Home Assistant stopped waiting.
   */
  const inFlight = new Map<number, { kind: 'healNode' | 'removeFailed'; nodeId: number; since: number; until: number | null }>();
  let launchSeq = 0;
  const liveInFlight = (): { kind: 'healNode' | 'removeFailed'; nodeId: number; since: number } | null => {
    const t = now();
    let first: { kind: 'healNode' | 'removeFailed'; nodeId: number; since: number } | null = null;
    for (const [k, e] of inFlight) {
      if (e.until != null && t >= e.until) { inFlight.delete(k); continue; }
      if (first == null || e.since < first.since) first = { kind: e.kind, nodeId: e.nodeId, since: e.since };
    }
    return first;
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
    fn: () => Promise<unknown>,
    learn = true,
    origin: ActionOrigin = 'you',
    opts: {
      /** Read the reply: a verb whose driver call reports "did not" (v0.72.0). */
      interpret?: (r: unknown) => Interpretation;
      /** A timeout or dropped socket means "unknown", not "failed" (v0.72.0). */
      unknownAfterMs?: number;
      /** Auto-ping stands down while this runs (v0.72.0). */
      busy?: 'healNode' | 'removeFailed';
    } = {},
  ): Promise<ActionResult> => {
    if (!o.enabled) return { ok: false, message: 'write actions are disabled' };
    o.log('info', nodeId, `${verb} …`, origin);
    // Read BEFORE the call is awaited (v0.64.5) — see `onOutcome`. The node's
    // answer can beat HA's reply, so a stamp read after `await fn()` can
    // post-date it, and the judge books an answered ping as a miss.
    const sentAt = now();
    // …and so is the node's status (v0.72.0): a node the action revives reads
    // Alive after the await, which would count the ladder's pings on Dead nodes
    // as actions on live ones.
    // Alive, strictly: Unknown is not evidence of life, and a sleeping node
    // cannot be "killed" by an action it never received.
    const st = nodeId == null ? null : (o.statusOf?.(nodeId) ?? null);
    const aliveAtLaunch = st === NodeStatus.Alive;
    const seq = ++launchSeq;
    if (opts.busy && nodeId != null) inFlight.set(seq, { kind: opts.busy, nodeId, since: sentAt, until: null });
    let unknownOutcome = false;
    let effect: ActionEffect = 'maybe';
    if (learn) o.onLaunch?.(kind, nodeId, origin, sentAt, aliveAtLaunch);
    try {
      const reply = await fn();
      const v: Interpretation = opts.interpret ? opts.interpret(reply) : { ok: true };
      if (!v.ok) {
        // The driver said it did not. Nothing ran that the ledger could score,
        // so it indicts nothing ('transport'), exactly as a failed call does.
        o.log('error', nodeId, `${verb} → ${v.message}`, origin);
        if (learn) o.onOutcome?.(kind, nodeId, false, 'transport', origin);
        return { ok: false, message: `${verb}: ${v.message}` };
      }
      effect = 'ok';
      o.log('info', nodeId, `${verb} → ok${v.note ? ` — ${v.note}` : ''}`, origin);
      if (learn) o.onOutcome?.(kind, nodeId, true, undefined, origin, sentAt, aliveAtLaunch);
      return { ok: true, message: `${verb}: ok${v.note ? ` — ${v.note}` : ''}` };
    } catch (e) {
      // SANITIZED: this is whatever an HA service call threw, and session.ts
      // puts it straight into the on-screen action-result card.
      const msg = sanitizeEventText(errMsg(e));
      // HOME ASSISTANT STOPPED WAITING; THE DRIVER DID NOT (v0.72.0). A reply
      // timeout or a dropped socket on a long verb says nothing about what the
      // driver did — it may still be deleting and reassigning routes. Reported
      // as unknown, and never learned: neither "it worked" nor "it failed" is
      // a claim the evidence supports.
      if (opts.unknownAfterMs != null && (/^HA WS timeout/.test(msg) || /^HA WS connection closed/.test(msg))) {
        const why = /^HA WS timeout/.test(msg)
          ? `Home Assistant did not answer within ${Math.round(opts.unknownAfterMs / 60_000)} min`
          : 'the connection to Home Assistant closed while waiting';
        const m = `outcome unknown — ${why}; the driver may still be working`;
        o.log('warn', nodeId, `${verb} → ${m}`, origin);
        unknownOutcome = true;
        return { ok: false, unknown: true, message: `${verb}: ${m}` };
      }
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
      // A refusal changed nothing, and neither did a call that never left.
      if (refusal === 'refused' || NOT_SENT.test(msg)) effect = 'none';
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
      // With the launch stamp (v0.72.0): a refusal, too, is dated from when it
      // was asked, so an episode that opened during the call is not indicted.
      if (learn) o.onOutcome?.(kind, nodeId, false, refusal, origin, sentAt);
      return { ok: false, message: msg };
    } finally {
      // Only THIS launch's entry; an unknown one stays until its reply bound.
      const e = inFlight.get(seq);
      if (e && unknownOutcome && opts.unknownAfterMs != null) e.until = sentAt + opts.unknownAfterMs;
      else inFlight.delete(seq);
      // An unknown outcome settles when its reply bound would have: the
      // driver may be working until then, and the ledger's windows follow it.
      if (learn) {
        o.onSettled?.(kind, nodeId, origin, sentAt,
          unknownOutcome && opts.unknownAfterMs != null ? Math.max(now(), sentAt + opts.unknownAfterMs) : now(), effect);
      }
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
    refreshValues: (n, origin = 'you') => run('refreshValues', n, `refresh values node ${n}`, () => deviceCmd('zwave_js/refresh_node_values', n), true, origin),
    // ROUTED READ (v0.70.0) — one Get on the node's own switch/light value.
    // NOT `refreshValues`: zwave_js/refresh_node_values runs the driver's
    // refresh task, which returns before querying anything when the node is
    // Dead (zwave-js Node.ts: "Sleeping and dead nodes cannot be queried"), and
    // HA reports success anyway — on the one node this verb exists for, it
    // would send nothing. `refresh_value` goes through Node.pollValue, which
    // sends the Get regardless of status, with the driver's default transmit
    // options (ACK|AutoRoute|Explore) where a ping is ACK-only. It changes no
    // state. HA returns before the frame is on the air, so success here proves
    // only that the request was queued: the answer is judged from lastSeen.
    // Never learned: the ledger is first-action-wins, and the ladder's ping is
    // always that first action; in the measurement lanes (v0.71.0, purpose
    // 'probe') the read is the instrument, which v0.38.1 keeps off the ledger.
    routedRead: (n, purpose = 'revive') =>
      run('routedRead', n, purpose === 'probe' ? `probe node ${n} (routed read)` : `routed read node ${n}`, async () => {
        const ent = o.readEntityOf?.(n) ?? null;
        if (!ent) throw new Error(`node ${n} has no switch/light value to read`);
        await o.client.send({ type: 'call_service', domain: 'zwave_js', service: 'refresh_value', service_data: { entity_id: ent, refresh_all_values: false } });
      }, /* learn: never, see above */ false, /* origin */ 'engine'),
    reInterview: (n, origin = 'you') => run('reInterview', n, `re-interview node ${n}`, () => deviceCmd('zwave_js/refresh_node_info', n), true, origin),
    healNode: (n, origin = 'you') => run('healNode', n, `rebuild routes node ${n}`,
      () => deviceCmd('zwave_js/rebuild_node_routes', n, HEAL_TIMEOUT_MS), true, origin,
      { interpret: boolResult(HEAL_FALSE, HEAL_TRUE_NOTE), unknownAfterMs: HEAL_TIMEOUT_MS, busy: 'healNode' }),
    rebuildAll: (origin = 'you') => run('rebuildAll', null, 'rebuild ALL routes',
      () => entryCmd('zwave_js/begin_rebuilding_routes'), true, origin, { interpret: boolResult(REBUILD_FALSE) }),
    stopRebuild: (origin = 'you') => run('stopRebuild', null, 'stop rebuilding routes',
      () => entryCmd('zwave_js/stop_rebuilding_routes'), true, origin, { interpret: boolResult(STOP_FALSE) }),
    removeFailed: async (n, origin = 'you') => {
      const res = await run('removeFailed', n, `remove failed node ${n}`,
        () => deviceCmd('zwave_js/remove_failed_node', n, REMOVE_FAILED_TIMEOUT_MS), true, origin,
        { unknownAfterMs: REMOVE_FAILED_TIMEOUT_MS, busy: 'removeFailed' });
      // Only on success — a failed removal leaves the node, and its history, in
      // place; and an UNKNOWN one (v0.72.0) may not have happened at all.
      if (res.ok) o.onNodeRemoved?.(n);
      return res;
    },
    operatorActionInFlight: () => liveInFlight(),
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
          const reply = await o.client.send(cmd);
          o.onConfigWritten?.(n); // drop the stale cache so DETAIL re-fetches the new value
          return reply;
        },
        false, // operator config write — not a remediation, never learned
        'you',
        { interpret: (r) => configResult(r, o.listeningOf?.(n) ?? null) },
      ),
  };
}

/**
 * What HA's `set_config_parameter` status means (v0.72.0).
 *
 * `accepted`: the device confirmed. `queued`: the driver did not get a
 * confirmation before HA stopped waiting. For a SLEEPING device that is the
 * normal path — it applies the value at its next wake-up. For a listening one
 * it means the device was, or went, offline while HA waited, and the write was
 * most likely dropped: reporting "queued" as success there would be a false
 * reassurance about a failed write.
 */
export function configResult(r: unknown, listening: boolean | null): Interpretation {
  const status = (r as { status?: unknown } | null)?.status;
  if (status === 'accepted') return { ok: true };
  if (status === 'queued') {
    return listening === false
      ? { ok: true, note: 'queued — the device applies it at its next wake-up' }
      : { ok: false, message: 'not confirmed — the device was or went offline while Home Assistant waited; the value may not be set; re-read it' };
  }
  return { ok: true, note: 'Home Assistant returned no status' };
}
