/**
 * Auto-ping — the engine's FIRST autonomous write.
 *
 * Everything else this engine does is advisory: it detects, it explains, it
 * recommends, and a human presses the key. This module breaks that rule on
 * purpose and narrowly, so the rule stays meaningful everywhere else.
 *
 * Which frames, and why (v0.71.0). Nothing here can remove a node or change a
 * device's configuration, and the frames are chosen per lane:
 *
 *  - the dead-node ladder and an operator's `p` press Home Assistant's ping
 *    button: a NoOp with transmit options 0x01 (ACK only) and one attempt, so
 *    the controller can use only its stored routes;
 *  - the liveness sweep and the verification bursts send one ROUTED READ:
 *    `zwave_js.refresh_value` on the node's own switch/light value, a single
 *    Get with the driver's default options (0x25: ACK, AutoRoute, Explore),
 *    one attempt, at NodeQuery priority.
 *
 * The measurement lanes changed because an unanswered frame marks a working
 * node Dead. On the reference mesh 100 of 106 mains Dead episodes in 67 days
 * began 0.11–3.49 s after one of this module's own unanswered pings — 63 on a
 * sweep probe, 35 on a verification probe. A read adds a controller-computed
 * route to the attempts; no frame sent with its transmit options (0x25) went
 * unanswered in the 39 h driver log — 170 of them: 115 Sets, 35 Gets and 20
 * Nonce Gets (95 % upper bound ≈1.8 %) — but it CAN still go unanswered,
 * and then it marks the node Dead exactly as a ping does, so the kill
 * containment below (`probeDeath`, `probeHoldFrom`) stays. Unlike a ping, a
 * read can make the controller keep a new working route — zwaveData
 * confounds the episodes such a re-route could clear by itself — and its
 * Report can correct a stale Home Assistant state, which may fire automations.
 *
 * WHY THE DWELL IS 10 MINUTES — measured, not guessed.
 *
 * Six dead episodes on the live 39-node mesh over three days:
 *
 *     West Closet Motion      0.8 min  -> self-recovered
 *     Hallway Closet Motion   1.5 min  -> self-recovered
 *     Dining Room Lamp        5.0 min  -> self-recovered
 *     Garage Workroom         5.1 min  -> self-recovered
 *     Garage Workroom       361.4 min  -> cleared by hand
 *     Hallway Closet Motion 531.4 min  -> cleared by hand
 *
 * The distribution has a clean gap: everything that heals itself does so inside
 * ~5 minutes, and everything that gets stuck runs to SIX TO NINE HOURS. A dwell
 * of 10 minutes sits in that gap — long enough never to interrupt the mesh
 * healing itself, short enough to turn a six-hour outage into a ten-minute one.
 *
 * (That evidence nearly went unfound. A 14-day history query came back almost
 * empty and was read as "this mesh never fails" — but Home Assistant's recorder
 * silently DEGRADES a query whose start predates retention, returning one
 * synthesized row per entity rather than an error. The tell is cheap: a SHORTER
 * window returning MORE rows means the longer one is lying. Inside retention the
 * 3-day window returns 534 rows where the 7-day returns 153.)
 *
 * Whether a ping actually clears those long outages is still unproven, so this
 * instruments itself: every attempt is recorded through the M5 outcome ledger
 * against the node's open episode, and `efficacyFor('dead-flap', 'ping')` turns
 * "usually wakes them up" into a measured recovery rate on the REMEDY screen. If
 * the rate comes back poor, the honest answer is to switch this off — and the
 * data will say so.
 *
 * The decision is a PURE function (`decideAutoPings`) taking a snapshot and
 * returning what to do plus why — so every gate below is directly testable, and
 * the runner that performs the side effects stays trivial.
 */

import { NodeStatus, type ControllerSnapshot, type NodeSnapshot } from '../types';

/** Why no ping was issued — surfaced so a quiet engine is never a mystery. */
export type AutoPingSuppression =
  | 'disabled'
  | 'write-actions-off'
  | 'boot-window'
  | 'rebuilding-routes'
  | 'no-capability-data'
  | 'storm'
  /** The controller's receiver is OFF (v0.65.0) — the nightly NVM backup takes
   *  the radio down for ~10 s and soft-resets. A frame sent across that window
   *  cannot be acknowledged, and ONE unacknowledged frame is enough for the
   *  driver to mark a node Dead, which this engine would then report and
   *  remediate. Probing into a switched-off radio measures the radio. */
  | 'controller-rf-off'
  | 'none';

export interface AutoPingConfig {
  enabled: boolean;
  /** The master gate. Auto-ping is a WRITE and obeys it like every other. */
  writeActions: boolean;
  /** How long a node must be Dead before the first ping. */
  afterMs: number;
  /** Attempts per dead episode, after which we stop and leave it to a human. */
  maxAttempts: number;
  /**
   * Probe every MAINS node once per this interval (0 = off).
   *
   * A fixed per-node cadence on `lastStaleAt` since v0.37 — NOT measured from
   * `lastSeen` (this said so until v0.71.0): a reply rate is a fact about a
   * device only if every device is asked at the same interval. It doubles as
   * the silence threshold the sweep line and self-proven attribution are judged
   * against. (Why a sweep at all: on the live mesh 10 of 38 nodes had been
   * silent for 35.7 HOURS while all reporting Alive.)
   */
  staleMs: number;
}

export interface AutoPingState {
  /** nodeId → attempts made during the CURRENT dead episode. */
  attempts: Map<number, number>;
  /** nodeId → epoch ms of the last auto-ping. */
  lastPingAt: Map<number, number>;
  /** nodeId → epoch ms this node was first seen Dead (episode start). */
  deadSince: Map<number, number>;
  /**
   * Nodes THIS RUN has observed Alive (v0.64.3). Decides how a new Dead is dated.
   *
   * v0.50.0 dates a newly-seen Dead from the driver's `lastSeen`, because a node
   * that is already Dead when we first look has been down at least since it was
   * last heard, and dating it from boot restarted the outage clock on every
   * deploy. That reasoning holds only when we did NOT watch it die. For a node we
   * saw Alive, `lastSeen` is just the last time it spoke. The liveness sweep runs
   * every two hours, so for a healthy node that is ~120 min old, and backdating a
   * death we observed made the 10-minute dwell read as long expired: the ladder
   * pinged 60 s after every such death.
   *
   * Only `Alive` counts. `trackEpisodes` runs on every tick, ready roster or not,
   * and `Unknown` is not evidence the node was up.
   */
  seenAlive: Set<number>;
  /**
   * Nodes whose CURRENT Dead episode began while a MEASUREMENT probe of ours to
   * them — a liveness sweep (v0.64.4) or a verification probe (v0.71.0) — was
   * still unanswered, mapped to that probe's lane. The dwell does not apply.
   *
   * The ping verb is a single-attempt NoOp with no route exploration, so on a
   * marginal hop the probe itself fails and the driver marks the node Dead on
   * that frame. Over 49 h of live log, 5 of the 6 Dead flags outside a host
   * reboot landed 0.26–1.74 s after a sweep probe, and the next ping reached
   * the node in 30–50 ms. (The sixth came 26 minutes after its sweep, from a
   * node heard inside the dwell, and healed itself within two minutes — the
   * case the dwell is for, and it still gets it.) A quiet mains node that
   * nothing else addresses cannot heal itself, so for a sweep kill the dwell
   * only held the node down: v0.64.3 turned each ~60 s blip into 11 minutes
   * Dead, a critical `node-down` symptom and six minutes of `degraded`, about
   * 2.5 times a day.
   *
   * VERIFICATION KILLS TOO, since v0.71.0. v0.64.4 kept them out: a burst
   * keeps probing its node every tick, so an immediate retry handed the burst a
   * live node to kill again, and kill, revive, kill is enough Dead crossings
   * for a critical `dead-flap`, whose episode requests another burst. The dwell
   * was the only brake, and it cost the availability it guarded: on 2026-09-22
   * a verification kill was filed as talking on the burst's OWN earlier
   * answers, and a working outlet read Dead for 101 minutes. The loop is now
   * bounded by `probeHoldFrom` instead, so the retry is safe for both lanes.
   *
   * A manual ping stays out too. v0.64.4's reason — its entry was stamped after
   * the HA call returned — is gone: since v0.64.5 it carries the launch stamp,
   * as exact as a sweep's. Two reasons remain. The exemption was granted on
   * measurement, and no manual kill has ever been seen: over the 50.5 h of log
   * reviewed for v0.64.5, HA recorded 1,081 ping-button presses and every one
   * was the engine's. And the exemption discards traffic heard before the
   * death. The give-up notice tells an operator to operate the device and then
   * ping it; if that command clears the Dead flag and a tick sees the node
   * Alive before the ping, the ping's NOP makes a fresh watched death, and for
   * a device that ignores NOPs (v0.42.0) the exemption
   * would trade its Dead-but-talking notice for an immediate retry of the very
   * frame it ignores. The operator is at the keyboard, and pressing `p` again
   * is the retry. A manual ping's miss is still booked when the death is seen
   * (`settleProbeDeath`), and it keeps the dwell, as does the ladder's.
   *
   * `deadSince` still records the observed death, so every age an operator
   * sees stays true; the dwell gate and the traffic check read this set.
   * Cleared on recovery and on roster departure.
   */
  probeDeath: Map<number, 'sweep' | 'verify'>;
  /** nodeId → epoch ms of the last STALE (liveness) probe. */
  lastStaleAt: Map<number, number>;
  /**
   * nodeId → epoch ms of a probe whose ANSWER has not been checked yet (v0.36).
   *
   * The ping verb is an HA `button.press` service call, and HA's zwave_js ping
   * button starts `node.async_ping()` as a background task and returns without
   * waiting for it (this said "awaits" until v0.64.5; it never did), and nothing
   * is raised when the node stays silent. So the promise resolves either way and
   * the `.catch` around it can only ever fire on "this node has no ping button"
   * or a WebSocket transport fault — never on the outcome auto-ping exists to
   * detect. Whether the node ANSWERED is therefore not knowable from the call;
   * it is knowable from the evidence, by asking a moment later whether the
   * node's `lastSeen` moved.
   *
   * Per-PROBE pending list, not a single slot (v0.40): burst spacing (60 s)
   * runs under the answer grace (90 s), so a single slot was overwritten by
   * each new probe before it matured — only the LAST probe of every 5-probe
   * burst was ever judged, and a node dying mid-burst logged five misses as
   * one "1st consecutive miss". Every probe now gets its own judgment, and
   * CARRIES its own self-proven flag: the old per-node flag slot had the same
   * overwrite disease — a newer sweep rewrote the flag before the older probe
   * was judged, so the judgment reported the wrong probe's context. Non-sweep
   * lanes (dead-remediation, verification) carry `self: false`: the flag
   * means "spoke on its own since the last sweep", which only a sweep asks.
   */
  awaitingAnswer: Map<number, { at: number; cls: ProbeClass; lane: ProbeLane; frame?: ProbeFrame }[]>;
  /** nodeId → the `lastSeen` value most recently ATTRIBUTED to one of our own
   *  probe answers (v0.40). The sweep's self-proven flag compares against it:
   *  a lastSeen that has not advanced past our probe's answer is the app
   *  hearing its own echo, not the node speaking on its own.
   *
   *  Two documented edges, both conservative-by-choice: the value is stamped
   *  at JUDGMENT time (up to ~2.5 min after the probe), so a node whose own
   *  report lands inside that window has it attributed to the probe — the
   *  window is genuinely ambiguous (probe-induced supervision chatter lands
   *  there too) and the tiebreak under-credits rather than fabricates; and
   *  the map is in-memory, so the first sweep per node after a restart has
   *  no attribution — which v0.40.2 no longer resolves as self-proof: the
   *  sweep says so and credits nothing until a probe of this run is judged. */
  lastProbeSeen: Map<number, number>;
  /** Nodes already announced as abandoned this outage (v0.36.4), so the notice
   *  fires once rather than every tick for as long as the node stays down. */
  gaveUpAnnounced: Set<number>;
  /**
   * nodeId → CONSECUTIVE unanswered probes (v0.36.5).
   *
   * Measured on the live mesh: excluding one genuinely broken node, 2 probes of
   * ~98 went unanswered — about 2%, one each on two different healthy nodes.
   * Across 35 candidates probed every two hours that is a steady drip of
   * transient misses, and each produced a line textually identical to the
   * fifteenth consecutive failure of a device that was actually down. A count
   * separates them without hiding either.
   */
  missStreak: Map<number, number>;
  /** nodeId → epoch ms of this node's previous VERIFICATION probe (v0.37.1),
   *  so the burst's real spacing is visible in the log. */
  lastVerifyAt: Map<number, number>;
  /**
   * nodeId → consecutive dead-lane LAUNCHES that never left (v0.40.2).
   *
   * A refunded remediation attempt must not become a licence to retry forever.
   * The first cut of this release refunded `attempts` and got exactly that: a
   * pre-release review measured 190 pings in 200 minutes against the ladder's
   * 3, with `attempt 1/3` logged every minute and the give-up notice
   * unreachable — because `tries` never advanced. The node's REMEDIATION
   * budget is still not spent by a packet that never left, but launch
   * failures carry their own budget, and exhausting it says so with a
   * different message: the fault is on our side, not the node's.
   */
  launchFailures: Map<number, number>;
  /** Nodes already announced as unlaunchable this outage (v0.40.2). */
  launchGaveUpAnnounced: Set<number>;
  /** Nodes already announced as Dead-but-talking this outage (v0.42.0). */
  talkingAnnounced: Set<number>;
  /**
   * Nodes owed ONE routed read (v0.70.0): their latest dead-lane ping was judged
   * unanswered. A ping reaches HA and zwave-js-server as an ACK-only NoOp
   * (transmit options 0x01, one attempt), so it can use only the stored routes —
   * LWR, NLWR, then direct. A Get goes out with the driver's default options
   * (ACK|AutoRoute|Explore), so the controller may also compute a route. When
   * every stored route is marginal, a ping cannot reach a node that any real
   * command reaches at once: on 2026-09-22 the ladder spent three pings on an
   * outlet and summoned a human, and a switch command then revived it in 340 ms
   * through a repeater the stored routes did not use. Cleared on recovery and
   * on departure.
   */
  readOwed: Set<number>;
  /** nodeId → routed reads launched this episode, for the give-up line. */
  reads: Map<number, number>;
  /**
   * nodeId → times a routed read REVIVED the node, epoch ms (v0.70.0). Kept
   * across episodes on purpose and aged out after `READ_REVIVAL_WINDOW_MS`: a
   * device that answers Gets but not pings is revived by the read and then
   * killed again by the next NoOp, and because recovery resets the ladder that
   * loop would never summon anyone. Past `READ_REVIVAL_CAP` the read is
   * withheld, the ladder gives up as it did before this release, and the human
   * is told why.
   */
  readRevivals: Map<number, number[]>;
  /**
   * Nodes whose outstanding routed read was sent in an episode that began on
   * our own MEASUREMENT probe (v0.71.0). Its revival is not counted against
   * `READ_REVIVAL_CAP`: that cap bounds a loop in which a NoOp keeps killing a
   * device the read keeps reviving, and a measurement kill is bounded by
   * `probeHoldFrom` and announced by `probeKills` instead. Set or cleared at
   * each read's launch, consumed at its judgment.
   */
  readAfterOwnKill: Set<number>;
  /**
   * nodeId → when a node REVIVED from a death on our own measurement probe
   * (v0.71.0). For `PROBE_KILL_HOLD_MS` after it the sweep does not select the
   * node and its verification probes are not handed out — left owed, not
   * drained. Timed from the recovery, not from the kill: a kill and its revival
   * are two Dead crossings, and a late revival timed from the kill would leave
   * room for a third inside one `dead-flap` window. The ladder is never held.
   */
  probeHoldFrom: Map<number, number>;
  /** nodeId → deaths on our own measurement probes, epoch ms, aged out after
   *  `PROBE_KILL_WINDOW_MS` (v0.71.0). Kept across recoveries: recovery ends
   *  each episode, and this counts episodes. */
  probeKills: Map<number, number[]>;
  /** Nodes whose own-probe kill count reached `PROBE_KILL_WARN_AT` since the
   *  runner last looked, waiting for its one warning (v0.71.0). */
  probeKillWarn: Set<number>;
  /**
   * nodeId → when a measurement READ to it could not be sent (v0.71.0). For
   * `READ_LAUNCH_FALLBACK_MS` its sweep and verification probes use the NoOp
   * ping. The v0.40.2 refund gives a refused sweep its cadence slot back, which
   * keeps the node at the head of the one-per-tick queue, so one refusing entity
   * would otherwise stall the sweep for every other node.
   */
  readLaunchFailedAt: Map<number, number>;
}

/** Which lane issued a probe (v0.40.2). Only the fixed-cadence SWEEP feeds the
 *  persisted reply rate: verification bursts and dead-remediation probes are
 *  symptom-correlated, so folding them into the same denominator destroys the
 *  cross-node comparability the v0.37 sweep was rebuilt to provide (a node
 *  under investigation took 22 probes against every peer's 13). Misses in
 *  every lane still log and still move the streak — a miss is a miss. */
/**
 * Which lane sent a probe. `'manual'` (v0.47.0) is an operator pressing `p`.
 *
 * Only `'sweep'` feeds the persisted reply rate — that gate is the whole point
 * of the type and must not be widened. The manual lane exists so an operator's
 * ping is JUDGED: before this, the engine owned the exact primitive for
 * deciding whether a ping was answered and never applied it to the one probe a
 * human actually asked for, so `p` reported "sent" and then said nothing.
 */
export type ProbeLane = 'sweep' | 'dead' | 'verify' | 'manual' | 'read';

/**
 * What a probe put on the air (v0.71.0). `'ping'` is Home Assistant's ping
 * button — a NoOp, ACK-only (0x01), one attempt, stored routes only. `'read'`
 * is one `zwave_js.refresh_value` Get with the driver's default options (0x25),
 * one attempt, which may also be delivered on a route the controller computes.
 * Both are judged the same way (`lastSeen` past the launch); what an ANSWER
 * means differs, and the persisted reply rate keeps the read subset apart.
 */
export type ProbeFrame = 'read' | 'ping';

/**
 * What the sweep concluded about ONE probe's evidence (v0.49.0).
 *
 * The judgment has always been four-way and only `self-proven` was recorded;
 * the other three were computed, described in a log line, and discarded. So
 * "why is this node's coverage thin" was answerable only by grepping prose out
 * of a container log the TUI cannot read.
 *
 *  - `self-proven`         the node spoke on its own, past our last probe's answer
 *  - `echo-only`           nothing on record beyond what our own probes produced
 *  - `attribution-unknown` heard recently, but this process has no probe history
 *                          to attribute it against (the first sweep after a boot)
 *  - `unheard`             silent past the threshold, with no probe answer either
 */
export type ProbeClass = 'self-proven' | 'echo-only' | 'attribution-unknown' | 'unheard';

/** 1st, 2nd, 3rd, 4th … for the miss-streak label (v0.36.5). */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Append a probe to the node's pending-judgment list (v0.40) — every probe
 *  gets its own entry, so a burst leaves several in flight at once. */
export function pendProbe(state: AutoPingState, nodeId: number, t: number, lane: ProbeLane, cls: ProbeClass = 'unheard', frame: ProbeFrame = 'ping'): void {
  const pending = state.awaitingAnswer.get(nodeId);
  if (pending) pending.push({ at: t, cls, lane, frame });
  else state.awaitingAnswer.set(nodeId, [{ at: t, cls, lane, frame }]);
}

/**
 * Settle a probe LAUNCH (v0.40.2) — the critical half of "did the packet leave".
 *
 * `zwaveActions.run()` catches its own errors and RETURNS `{ ok: false }`; it
 * never re-throws. So the `.catch` these lanes relied on sat on a promise that
 * could not reject, `unpendProbe` never executed in production (zero "could not
 * be probed" lines in 1206 probes across three releases), and every add-on-side
 * failure — HA WS down, Core restarting, no ping button — was judged a moment
 * later as THE NODE failing to answer. An audit caught it red-handed: during a
 * Core restart a node was logged "did NOT answer" while never going Dead,
 * because the button press never reached HA and the driver therefore never
 * attempted a transmission at all.
 *
 * A launch that failed is withdrawn from judgment: the node was never asked.
 */
function settleProbe(
  o: {
    log: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string) => void;
    log2?: ((msg: string) => void) & {
    debug?: (msg: string) => void;
    /** v0.50.0. The TYPE foreclosed severity: every leveled message was paired
     *  with a BARE `log2?.(m)`, so autoPing's two ERROR sites and its WARN site
     *  all reached the container log at info. Adding these members is what lets
     *  a caller actually raise one. */
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  },
  state: AutoPingState,
  nodeId: number,
  t: number,
  launched: Promise<unknown>,
  onFailed?: () => void,
  rejectWhy = 'no ping entity or transport error',
): void {
  const failed = (why: string): void => {
    unpendProbe(state, nodeId, t);
    onFailed?.();
    const m = `auto-ping: node ${nodeId} could not be probed (${why}) — not judged`;
    o.log('warn', nodeId, m);
    // v0.50.0: raise it in the CONTAINER log too, not just the TUI ring.
    (o.log2?.warn ?? o.log2)?.(m);
  };
  void launched.then(
    (res) => {
      // A resolved ActionResult with ok:false is a REFUSED or failed write.
      // `undefined` (the plain-void runners the tests use) is not a failure.
      if ((res as { ok?: unknown } | null | undefined)?.ok === false) failed('write refused or transport error');
    },
    () => failed(rejectWhy),
  );
}

/** Withdraw ONE pending probe after a transport failure — the packet never
 *  left, so there is nothing to judge; the node's other probes stay judged. */
export function unpendProbe(state: AutoPingState, nodeId: number, t: number): void {
  const pending = state.awaitingAnswer.get(nodeId);
  if (!pending) return;
  const i = pending.findIndex((p) => p.at === t);
  if (i >= 0) pending.splice(i, 1);
  if (pending.length === 0) state.awaitingAnswer.delete(nodeId);
}

/** How long to wait before judging whether a probe was answered (v0.36).
 *  A ping is a round trip plus a stats push, a routed read its ACK plus the
 *  Report; 90 s is generous for a routed mesh hop and still well inside one
 *  tick of slack. Exported (v0.71.0): zwaveData attributes a route change to
 *  our measurement read inside the same window. */
export const ANSWER_GRACE_MS = 90_000;

/** How long a node revived from a death on our own measurement probe gets no
 *  sweep or verification probe (v0.71.0). Longer than `dead-flap`'s 10-minute
 *  window, so a kill and its revival — two crossings — cannot be joined by a
 *  third from our own probing inside one window. */
export const PROBE_KILL_HOLD_MS = 15 * 60_000;
/** How long an own-probe kill counts against its node (v0.71.0). */
export const PROBE_KILL_WINDOW_MS = 24 * 60 * 60_000;
/** Own-probe kills of one node inside the window that raise ONE warning
 *  (v0.71.0): once is a lost frame, twice a day is a marginal route. */
export const PROBE_KILL_WARN_AT = 2;
/** How long a node whose measurement read could not be SENT is probed with the
 *  NoOp ping instead (v0.71.0). See `readLaunchFailedAt`. */
export const READ_LAUNCH_FALLBACK_MS = 30 * 60_000;
/** Why a routed read's launch was withdrawn, for the "could not be probed" line. */
const READ_REJECT_WHY = 'no switch/light value to read, or transport error';

/** Is this node inside the post-kill measurement hold at `now` (v0.71.0)? */
export function inProbeHold(state: AutoPingState, nodeId: number, now: number): boolean {
  const at = state.probeHoldFrom.get(nodeId);
  return at != null && now - at < PROBE_KILL_HOLD_MS;
}

/** Own-probe kills of this node inside the window ending at `now` (v0.71.0). */
export function probeKillsWithin(state: AutoPingState, nodeId: number, now: number): number {
  return (state.probeKills.get(nodeId) ?? []).filter((at) => now - at < PROBE_KILL_WINDOW_MS).length;
}

/** Book one death on our own measurement probe (v0.71.0), aging the ring, and
 *  queue the node's one warning when the count reaches `PROBE_KILL_WARN_AT`. */
function recordProbeKill(state: AutoPingState, nodeId: number, at: number): void {
  const kills = [...(state.probeKills.get(nodeId) ?? []).filter((k) => at - k < PROBE_KILL_WINDOW_MS), at];
  state.probeKills.set(nodeId, kills);
  if (kills.length === PROBE_KILL_WARN_AT) state.probeKillWarn.add(nodeId);
}

/** Is this node's measurement frame the NoOp fallback at `now` (v0.71.0)? */
export function readFallbackActive(state: AutoPingState, nodeId: number, now: number): boolean {
  const at = state.readLaunchFailedAt.get(nodeId);
  return at != null && now - at < READ_LAUNCH_FALLBACK_MS;
}

/** How long a routed-read revival counts against its node (v0.70.0). */
export const READ_REVIVAL_WINDOW_MS = 24 * 60 * 60_000;
/** Routed-read revivals per node per window before the read is withheld
 *  (v0.70.0). Two tells "a stored route broke once" from "this device answers
 *  Gets but not pings", and bounds the kill–revive loop the second case would
 *  otherwise run forever. */
export const READ_REVIVAL_CAP = 2;

/** Routed-read revivals of this node inside the window ending at `now`. */
export function readRevivalsWithin(state: AutoPingState, nodeId: number, now: number): number {
  return (state.readRevivals.get(nodeId) ?? []).filter((at) => now - at < READ_REVIVAL_WINDOW_MS).length;
}

export function createAutoPingState(): AutoPingState {
  return { attempts: new Map(), lastPingAt: new Map(), deadSince: new Map(), lastStaleAt: new Map(), awaitingAnswer: new Map(), lastProbeSeen: new Map(), gaveUpAnnounced: new Set(), missStreak: new Map(), lastVerifyAt: new Map(), launchFailures: new Map(), launchGaveUpAnnounced: new Set(), talkingAnnounced: new Set(), seenAlive: new Set(), probeDeath: new Map(), readOwed: new Set(), reads: new Map(), readRevivals: new Map(), readAfterOwnKill: new Set(), probeHoldFrom: new Map(), probeKills: new Map(), probeKillWarn: new Set(), readLaunchFailedAt: new Map() };
}

export interface AutoPingInput {
  now: number;
  /** Episode bookkeeping (see trackEpisodes). */
  state: AutoPingState;
  nodes: NodeSnapshot[];
  controller: ControllerSnapshot | null;
  config: AutoPingConfig;
  /** True inside the post-start window, where statuses are not yet trustworthy. */
  booting: boolean;
  /** When the controller reported its receiver OFF and has not reported it back
   *  on (v0.65.0), or null. See `controllerRfEvent` in driverWsClient. */
  rfOffSince?: number | null;
  /**
   * Nodes the outcome ledger has asked to probe for episode verification
   * (v0.36). Subject to EVERY gate below — a verification probe is a write like
   * any other, and must never reach a mesh auto-ping would have left alone.
   *
   * A THUNK, not an array, and that is load-bearing (v0.36.2). Draining the
   * ledger's queue CONSUMES a probe from the node's burst, so evaluating it
   * while building this input spent the budget on ticks that then returned
   * early at a suppressor — a 5-minute boot window at one tick a minute could
   * exhaust an entire 3-probe burst without a single packet reaching the mesh,
   * and the episode closed `unverifiable` exactly as it had before the fix.
   * Worse, that is precisely when episodes cluster: a restart re-detects many
   * symptoms at once. Resolved below, after every gate has passed.
   */
  verifyDue?: () => { id: number; first: boolean }[];
  /** How many nodes currently have an outstanding verification burst (v0.37.1).
   *  Reported in the probe line so the contention dividing the one-per-tick
   *  queue is visible rather than inferred. */
  verifyOwedCount?: () => number;
  /**
   * Let the DEAD-NODE LADDER act inside the boot window (v0.64.4). The runner
   * sets it whenever the roster is ready.
   *
   * The window names one hazard — every node reads Dead until the first roster
   * poll lands — and `ready()` measures exactly that. Holding the ladder for the
   * rest of a wall-clock five minutes cost availability: after a host reboot on
   * the reference mesh, a mains outlet that missed the driver's single start-up
   * NoOp kept its Home Assistant light and switch unavailable until the
   * ladder's first probe at start + 5 min exactly, about three minutes after
   * the roster was in — and that probe revived it in 104 ms.
   *
   * Nothing else is released. Rebuild, capability data, storm and the dwell
   * still gate the ladder — and inside the window those gates still REPORT
   * `boot-window`, so no start-up alarm is released with it. The driver link is
   * enforced by the candidate rule itself (`isListening` comes only from its
   * flag dump). The sweep and verification lanes serve the whole window: they
   * have no outage to end.
   */
  bootDeadLane?: boolean;
  /** Whether a routed read can be sent to this node at all (v0.70.0): the
   *  runner has a read verb and the node has a switch/light value to read.
   *  Absent ⇒ no reads, exactly the v0.69.0 ladder. */
  canRead?: (nodeId: number) => boolean;
}

export interface AutoPingDecision {
  /** Dead nodes to probe on this tick (remediation). */
  ping: number[];
  /** Dead nodes to send ONE routed read on this tick (v0.70.0). */
  read: number[];
  /**
   * At most ONE stale node to probe on this tick (liveness verification).
   *
   * Deliberately one: 36 mains nodes coming due together would otherwise fire
   * 36 probes in a single second. Spreading them one per tick turns that into a
   * trickle the mesh does not notice, and the stalest goes first so nobody is
   * starved by the cap.
   */
  stale: number[];
  /** Ledger-requested verification probes cleared for this tick (v0.36). */
  verify: number[];
  /** Of those, the nodes whose probe is the FIRST of its burst (v0.38.2) —
   *  from the queue's own bookkeeping, not a time heuristic. */
  verifyFirst: number[];
  /** How many DISTINCT nodes were owed a verification probe when this tick was
   *  decided (v0.37.1) — the contention the one-per-tick queue is dividing. */
  verifyOwed: number;
  /**
   * Nodes whose remediation budget is spent and are STILL Dead (v0.36.4).
   *
   * `maxAttempts` is documented as "after which we stop and leave it to a
   * human" — and until now it did the first half only. The gate was a bare
   * `continue`, and because `attempts` resets solely when a node LEAVES Dead, a
   * node that stays down is abandoned permanently and in silence. Observed
   * live: node 23 exhausted 3/3, then auto-ping said nothing for 80 minutes
   * while the operator had no way to tell "given up" from "resolved" — the last
   * line in the log was a failed probe, and then the log simply moved on.
   *
   * The engine going quiet at exactly the moment a human is needed is the worst
   * possible time for it to go quiet. The runner announces this ONCE per
   * outage; recovery clears the state, so a device that dies again is announced
   * again.
   */
  gaveUp: number[];
  /** Nodes whose dead-lane probe LAUNCH failed maxAttempts times in a row
   *  (v0.40.2) — an add-on-side fault, announced apart from a node that was
   *  genuinely asked and stayed silent. */
  launchGaveUp: number[];
  /** Nodes the driver still flags Dead that were HEARD FROM inside the dwell
   *  (v0.42.0) — demonstrably reachable, so no budget is spent and no human is
   *  summoned. The flag is stale; the traffic is evidence. */
  talkingWhileDead: number[];
  /** Why nothing was pinged (or 'none' when the gates all passed). */
  suppressed: AutoPingSuppression;
  /** Listening nodes currently Dead — the storm-guard numerator. */
  deadListening: number;
  /** Non-controller nodes whose `isListening` is UNKNOWN (v0.52.0). Non-zero
   *  means the candidate set is empty because the driver-WS flag dump is
   *  missing, not because there is nothing to sweep. */
  capabilityUnknown: number;
  /** Listening nodes total — the storm-guard denominator. */
  listening: number;
  /** Nodes past the stale window and off cooldown (before the one-per-tick cap). */
  staleDue: number;
  /** Stalest candidate's silence in ms, or null when nothing is due/known. */
  stalestMs: number | null;
}

/**
 * Backoff between attempts within one dead episode: 10m, 30m, 60m.
 *
 * A node that did not answer the first probe is unlikely to answer a second one
 * seconds later, and a tight retry loop against a genuinely absent device is
 * just avoidable RF traffic on a mesh that other nodes are trying to use.
 */
/* These are the waits BETWEEN attempts, indexed by attempts already made — so
 * at the shipped `max_attempts = 3` only the first two are ever reached: dwell
 * 10 m, then 10 m, then 30 m, and the give-up lands ~50 minutes after death,
 * NOT the ~110 minutes "backoff 10/30/60m" implies. The 60 m rung governs the
 * third wait onward, which an operator can reach by raising max_attempts. Four
 * operator-facing surfaces stated the ladder as if all three rungs always ran
 * (v0.41.2 audit): this comment, the startup banner, the add-on config help,
 * and the DOCS option table. */
const BACKOFF_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];

/**
 * Fraction of listening nodes that may be Dead before auto-ping shuts off.
 *
 * A handful of dead nodes is a device problem. A THIRD of the mesh dead at once
 * is a controller wedge, a driver restart, or Home Assistant reloading — and in
 * that state the useful action is to wait, not to fire dozens of pings into a
 * controller that is already struggling. This is the same reasoning as the
 * driver-WS log storm backstop.
 */
export const STORM_FRACTION = 0.25;
/** Below this many listening nodes a fraction is meaningless — use an absolute. */
const STORM_MIN_NODES = 4;

/**
 * The ONE definition of "a node auto-ping may consider".
 *
 * ASLEEP IS NOT DEAD. Battery and FLiRS devices sleep by design and answer on
 * their own wakeup interval; a ping cannot succeed before then and spends charge
 * to fail. `isListening` is boolean|null — null means "not interviewed yet",
 * which is not the same as mains-powered, so an explicit `=== true` leaves an
 * unknown device alone rather than probing it on an assumption.
 *
 * This lives in one place because it previously lived in THREE — the decision
 * filter, an `isEligible()` helper, and `trackEpisodes` — each of which was
 * individually sufficient. The mutation harness kept reporting the guard as
 * unprotected: removing any single copy changed no observable behaviour, so no
 * test could pin it. Duplicated safety checks are not defence in depth here;
 * they are three ways to believe a rule is enforced while none of them is
 * provably doing it.
 */
export function isPingCandidate(n: NodeSnapshot): boolean {
  return !n.isController && n.isListening === true;
}

export function decideAutoPings(input: AutoPingInput): AutoPingDecision {
  const { now, nodes, controller, config, booting } = input;
  const listeningNodes = nodes.filter(isPingCandidate);
  const dead = listeningNodes.filter((n) => n.status === NodeStatus.Dead);
  // `isListening` is filled ONLY from the driver-WS flag dump, and that map is
  // cleared on a homeId mismatch. With the link dark every node reads null, so
  // the candidate set is empty BY CONSTRUCTION — not because there is nothing
  // to sweep. Counting the unknowns is what separates the two.
  const capabilityUnknown = nodes.filter((n) => !n.isController && n.isListening == null).length;
  const base = { ping: [] as number[], read: [] as number[], stale: [] as number[], verify: [] as number[], verifyFirst: [] as number[], verifyOwed: 0, gaveUp: [] as number[], launchGaveUp: [] as number[], talkingWhileDead: [] as number[],
    deadListening: dead.length, capabilityUnknown,
    listening: listeningNodes.length, staleDue: 0, stalestMs: null as number | null };

  if (!config.enabled) return { ...base, suppressed: 'disabled' };
  // Auto-ping is a write. It obeys the master switch even when its own is on —
  // otherwise "write actions off" would be a false statement about the add-on.
  if (!config.writeActions) return { ...base, suppressed: 'write-actions-off' };
  // Right after start every node reads Dead until the first roster poll lands.
  // Without this the engine would ping the entire mesh on every restart.
  // The dead ladder alone may pass once the roster is ready (v0.64.4) — see
  // `bootDeadLane`; it rejoins the window below, before the measurement lanes.
  if (booting && !input.bootDeadLane) return { ...base, suppressed: 'boot-window' };
  // While the ladder runs inside the window, the gates below still REPORT
  // `boot-window` (v0.64.4 review). `storm` and `no-capability-data` raise
  // `binary_sensor.zwave_tui_degraded` (haStates.ts) and the storm WARN, and
  // until v0.64.4 the window hid both for its whole length. Releasing the ladder
  // must not also release a start-up alarm for a mesh that is still settling.
  const gate = (why: AutoPingSuppression): AutoPingSuppression => (booting ? 'boot-window' : why);
  // A rebuild is already rewriting routes; nodes drop in and out by design.
  if (controller?.isRebuildingRoutes) return { ...base, suppressed: gate('rebuilding-routes') };
  // The radio is off — every lane, not just the sweep. The dead ladder must not
  // ride through it either: its probe is the one that would "confirm" a death
  // the blackout itself caused (v0.65.0).
  if (input.rfOffSince != null) return { ...base, suppressed: gate('controller-rf-off') };

  // A PASS OVER AN EMPTY POPULATION IS NOT AN ALL-CLEAR (v0.52.0). With the
  // driver-WS link dark the engine reported `running · candidates 0 · dead 0 ·
  // no node is in a dead episode` while the roster held six Dead nodes — the
  // ladder cannot arm, and the screen said so in the words it uses for health.
  // Predicated on the UNKNOWN count, not on emptiness: an all-battery mesh has
  // capability data and is genuinely nothing to sweep.
  if (listeningNodes.length === 0 && capabilityUnknown > 0) {
    return { ...base, suppressed: gate('no-capability-data') };
  }

  const stormLimit = Math.max(STORM_MIN_NODES, Math.ceil(listeningNodes.length * STORM_FRACTION));
  if (dead.length >= stormLimit) return { ...base, suppressed: gate('storm') };

  const ping: number[] = [];
  const read: number[] = [];
  const launchGaveUp: number[] = [];
  const gaveUp: number[] = [];
  const talkingWhileDead: number[] = [];
  for (const n of dead) {
    // TRAFFIC OUTRANKS THE FLAG (v0.42.0).
    //
    // `status === Dead` is the driver's REACTIVE opinion: it is set when a
    // transmission fails and cleared only when something succeeds. A node that
    // is heard from — for any reason, including a command an operator ran — is
    // demonstrably reachable at that instant, whatever the flag still says.
    //
    // Learned the hard way on node 49 ("Garage Workroom"): it ignored SIX
    // consecutive pings over ~12 hours (the ladder's three, a manual one, and
    // two more after a restart re-armed the ladder) and was declared
    // node-down — then answered an ordinary on/off command immediately, and
    // came back reading grade A with +25 dB of margin. The ping button issues a
    // NOP, and this device does not answer NOPs. Every conclusion downstream
    // was drawn from the one frame it will not reply to.
    //
    // So: never spend remediation budget, and never summon a human, for a node
    // whose own traffic proves it alive. The dwell is the right window — it is
    // already the engine's definition of "long enough to mean something".
    const heard = n.stats?.lastSeen ?? null;
    // …but not traffic OLDER than a sweep kill (v0.64.4 review). That death was
    // pinned on our probe only because nothing was heard after the probe went
    // out, so the Dead flag is the newer evidence. Without this, a node heard a
    // few minutes before the sweep knocked it Dead was filed as "talking" and
    // waited out the dwell after all.
    const voiceBeforeKill = heard != null && input.state.probeDeath.has(n.nodeId) &&
      heard < (input.state.deadSince.get(n.nodeId) ?? Number.NEGATIVE_INFINITY);
    if (heard != null && now - heard < config.afterMs && !voiceBeforeKill) {
      talkingWhileDead.push(n.nodeId);
      continue;
    }
    const started = input.state.deadSince.get(n.nodeId);
    // A death on this add-on's own unanswered probe skips the dwell (v0.64.4):
    // the dwell protects a node healing itself, and nothing heals a quiet node
    // our own frame knocked Dead. See `probeDeath`.
    if (started == null || (now - started < config.afterMs && !input.state.probeDeath.has(n.nodeId))) continue;
    const tries = input.state.attempts.get(n.nodeId) ?? 0;
    // Launches that never left have their own budget; exhausting it is an
    // add-on-side fault, announced separately (v0.40.2).
    if ((input.state.launchFailures.get(n.nodeId) ?? 0) >= config.maxAttempts) {
      if (!input.state.launchGaveUpAnnounced.has(n.nodeId)) launchGaveUp.push(n.nodeId);
      continue;
    }
    // THE ROUTED READ (v0.70.0). Checked BEFORE the give-up hold, so the last
    // rung's read goes out before any summons, and the hold below then waits for
    // its judgment like any other pending probe. One frame per node per tick;
    // the dwell, talking-while-dead and launch-failure checks above all apply.
    // Withheld once the node has been revived this way `READ_REVIVAL_CAP` times
    // in the window: its stored routes keep failing, and reviving it again would
    // only hand the next ping another kill (since v0.71.0 the next ping is the
    // ladder's or an operator's; the measurement lanes read).
    if (input.state.readOwed.has(n.nodeId) && (input.canRead?.(n.nodeId) ?? false) &&
        readRevivalsWithin(input.state, n.nodeId, now) < READ_REVIVAL_CAP) {
      read.push(n.nodeId);
      continue;
    }
    // Do not announce the give-up while this node still has a probe awaiting
    // judgment (v0.41.2). The answer grace (90 s) exceeds the tick (60 s), so
    // deciding before judging announced "STILL DEAD … needs a human" up to one
    // tick BEFORE the final attempt's own probe could be judged — an ERROR
    // asking for a human that preceded the evidence it rests on.
    //
    // Gating here rather than hoisting the judgment loop above this decision:
    // that reordering was tried and rejected because judging first stamps
    // `lastProbeSeen` before the sweep reads it, so a node's OWN traffic gets
    // attributed to our probe — trading a broad, permanent accuracy loss on
    // every echo-only node for a narrow, rare ordering nicety.
    if (tries >= config.maxAttempts && (input.state.awaitingAnswer.get(n.nodeId)?.length ?? 0) > 0) continue;
    if (tries >= config.maxAttempts) {
      // Budget spent and the node is still down. Say so ONCE — the runner
      // tracks which nodes have already been announced — rather than dropping
      // into a silence indistinguishable from recovery.
      if (!input.state.gaveUpAnnounced.has(n.nodeId)) gaveUp.push(n.nodeId);
      continue;
    }
    const last = input.state.lastPingAt.get(n.nodeId);
    // `tries` is the count of attempts ALREADY made, so the wait after the first
    // is BACKOFF_MS[0]. Indexing by `tries` made the first gap 30m and silently
    // contradicted the 10m/30m/60m ladder this file documents. (Only reachable
    // when tries >= 1: with no previous attempt `last` is undefined and this
    // whole check is skipped.)
    // `Math.max(0, …)` because a REFUNDED attempt (v0.40.2) legitimately puts
    // us here with tries === 0 while `lastPingAt` still stands: indexing at -1
    // yields undefined, `now - last < undefined` is false, and the throttle
    // this line exists to be would silently vanish.
    const wait = BACKOFF_MS[Math.max(0, Math.min(tries - 1, BACKOFF_MS.length - 1))];
    if (last != null && now - last < wait) continue;
    ping.push(n.nodeId);
  }

  // Inside the boot window only the dead ladder was released (v0.64.4; see
  // `bootDeadLane`). Returned BEFORE the verification thunk is resolved, so a
  // gated tick still spends none of the ledger's burst budget (v0.36.2).
  if (booting) return { ...base, ping, read, gaveUp, launchGaveUp, talkingWhileDead, suppressed: 'boot-window' };

  /* ── liveness: a node nobody talks to is never proven alive ───────────
   *
   * Z-Wave JS sets Dead REACTIVELY — only when a transmission FAILS. A node
   * nobody addresses produces no transmissions, so no failures, so it reports
   * Alive indefinitely; a mains device could be unplugged and still read Alive
   * until something tries to reach it. Measured on the live mesh: 10 of 38
   * nodes silent for 35.7 hours, every one of them status Alive.
   *
   * This converts silence into evidence. The node either answers (refreshing
   * lastSeen, and its route/RSSI statistics with it) or the send fails and the
   * driver marks it Dead — at which point the remediation path above owns it.
   */
  const stale: number[] = [];
  if (config.staleMs > 0) {
    const due = listeningNodes
      .filter((n) => n.status !== NodeStatus.Dead) // the dead path owns those
      // …and a node revived from a death on our own probe is left alone for a
      // while (v0.71.0). See `probeHoldFrom`.
      .filter((n) => !inProbeHold(input.state, n.nodeId, now))
      .map((n) => ({ id: n.nodeId, seen: n.stats?.lastSeen ?? null }))
      // EVERY listening node, on a fixed cadence — not only the ones that have
      // gone quiet (v0.37). Skipping talkative nodes saved a little traffic and
      // cost the one thing that makes the answers worth keeping: comparability.
      // A reply rate is a fact about a device only if every device was asked the
      // same question at the same interval; sampled only when a node happened to
      // be silent, it measures how talkative the node is, not how reachable.
      //
      // The cost is small and was measured: on the reference mesh all 35
      // listening candidates were already crossing the silence threshold, so
      // "ask everyone" is barely more traffic than "ask the quiet ones".
      //
      // The cadence gate stays, and is now the ONLY gate: one probe per node per
      // staleMs. Without it an unreachable node never refreshes lastSeen, stays
      // permanently due, and is re-probed on every tick.
      .filter((x) => {
        const last = input.state.lastStaleAt.get(x.id);
        return last == null || now - last >= config.staleMs;
      })
      // Longest-unheard first, so a node whose own traffic has not proved it
      // alive is still asked before one that has been chatting all along.
      .sort((a, b) => (a.seen ?? 0) - (b.seen ?? 0));
    if (due.length) stale.push(due[0].id);
    base.staleDue = due.length;
    base.stalestMs = due.length ? (due[0].seen == null ? null : now - due[0].seen) : null;
  }

  /* ── verification probes (v0.36) ──────────────────────────────────────
   *
   * The outcome ledger asks for these when an episode opens and when its
   * symptom goes absent, because on a quiet node neither window can otherwise
   * reach the verifier's evidence floor and the verdict is `unverifiable`
   * before it is computed. They arrive here rather than going straight out so
   * they pass the SAME ladder as every other autonomous write: master gate,
   * boot window, rebuild, storm — all already applied above.
   *
   * Only nodes that are ping candidates and NOT Dead: a dead node's probes
   * belong to the remediation path above, with its own dwell and backoff.
   */
  const candidates = new Set(listeningNodes.filter((n) => n.status !== NodeStatus.Dead).map((n) => n.nodeId));
  // …nor inside a post-kill hold (v0.71.0). The runner's thunk already leaves a
  // held node's burst OWED rather than drained; this is the backstop for a
  // queue that does not honour the skip.
  for (const id of [...candidates]) if (inProbeHold(input.state, id, now)) candidates.delete(id);
  // Resolved HERE, past every suppressor, so a gated tick never spends the
  // ledger's budget on a probe it is not going to send.
  const verifyEntries = (input.verifyDue?.() ?? []).filter((e) => candidates.has(e.id));
  const verify = verifyEntries.map((e) => e.id);
  const verifyFirst = verifyEntries.filter((e) => e.first).map((e) => e.id);
  base.verifyOwed = input.verifyOwedCount?.() ?? verify.length;

  // One measurement probe per node per tick (v0.40 review): a node owed a
  // verification probe this tick is dropped from the sweep — the verify probe
  // is the same frame (both lanes use the runner's `frameOf`, v0.71.0) and
  // satisfies the sweep's question, while twin
  // same-tick probes shared one `at`, let a transport failure on one lane
  // withdraw the OTHER lane's pending entry, and double-counted one silent
  // instant as two consecutive misses. The node stays due (lastStaleAt is not
  // advanced), so its sweep runs on the next tick if it still owes nothing.
  const verifySet = new Set(verify);
  const staleDeduped = stale.filter((id) => !verifySet.has(id));

  return { ...base, ping, read, stale: staleDeduped, verify, verifyFirst, gaveUp, launchGaveUp, talkingWhileDead, suppressed: 'none' };
}

/**
 * Judge whether earlier probes were ANSWERED, from evidence rather than from
 * the service call (v0.36).
 *
 * Returns one entry per probe old enough to judge, and clears it from the
 * pending map. `answered` is true when the node's `lastSeen` advanced past the
 * moment we probed it — the only observable that distinguishes "the probe got
 * through" from "we sent a packet into the dark". Pure: the caller logs.
 */
export function judgeProbeAnswers(
  state: AutoPingState,
  nodes: NodeSnapshot[],
  now: number,
  graceMs = ANSWER_GRACE_MS,
): { nodeId: number; answered: boolean; misses: number; cls: ProbeClass; lane: ProbeLane; frame: ProbeFrame }[] {
  const seenOf = new Map<number, number | null>();
  for (const n of nodes) seenOf.set(n.nodeId, n.stats?.lastSeen ?? null);
  const out: { nodeId: number; answered: boolean; misses: number; cls: ProbeClass; lane: ProbeLane; frame: ProbeFrame }[] = [];
  for (const [nodeId, pending] of [...state.awaitingAnswer]) {
    // Judge EVERY matured probe, oldest first (v0.40) — the entries are
    // appended as registered, which is chronological except for a manual ping
    // registered after an engine probe sent during its call (v0.64.5; normally
    // milliseconds apart, up to ~10 s while the HA WebSocket re-authenticates),
    // and a burst leaves several in flight at once.
    const mature = pending.filter((p) => now - p.at >= graceMs);
    if (mature.length === 0) continue;
    const young = pending.filter((p) => now - p.at < graceMs);
    if (young.length > 0) state.awaitingAnswer.set(nodeId, young);
    else state.awaitingAnswer.delete(nodeId);
    // A node absent from the roster cannot be judged either way — say nothing
    // rather than call a roster gap a failed probe.
    if (!seenOf.has(nodeId)) continue;
    const seen = seenOf.get(nodeId) ?? null;
    for (const { at, cls, lane, frame } of mature) {
      const answered = seen != null && seen >= at;
      // The streak is CONSECUTIVE: one answer resets it, so "3rd miss" always
      // means three in a row rather than three since the beginning of time.
      const misses = answered ? 0 : (state.missStreak.get(nodeId) ?? 0) + 1;
      if (answered) {
        state.missStreak.delete(nodeId);
        // Remember what OUR probe put on the record, so the sweep's
        // self-proven flag can tell the node's own voice from our echo.
        if (seen != null) state.lastProbeSeen.set(nodeId, seen);
      } else {
        state.missStreak.set(nodeId, misses);
      }
      out.push({ nodeId, answered, misses, cls, lane, frame: frame ?? 'ping' });
    }
  }
  return out;
}

/**
 * Drop the probes a controller blackout made unjudgeable (v0.65.0).
 *
 * A probe already ANSWERED before the radio went off keeps its credit — the
 * answer is on the record, and dropping it would lose a true reading. Only the
 * ones still unanswered at the blackout are removed, because the one honest
 * answer available ("did lastSeen move past when we probed") cannot be produced
 * by a receiver that is switched off. Returns how many were dropped.
 */
export function dropBlackoutProbes(state: AutoPingState, nodes: NodeSnapshot[], rfOffSince: number): number {
  const seenOf = new Map<number, number | null>();
  for (const n of nodes) seenOf.set(n.nodeId, n.stats?.lastSeen ?? null);
  let dropped = 0;
  for (const [nodeId, pending] of [...state.awaitingAnswer]) {
    const seen = seenOf.get(nodeId) ?? null;
    const keep = pending.filter((p) => {
      const answered = seen != null && seen >= p.at;
      const unjudgeable = !answered && p.at <= rfOffSince;
      if (unjudgeable) dropped += 1;
      // A routed read the blackout swallowed was never really asked (v0.70.0).
      // Owe it again so it goes out when the gate reopens, instead of letting
      // the give-up hold release on a read that was never judged.
      if (unjudgeable && p.lane === 'read') {
        state.readOwed.add(nodeId);
        state.reads.set(nodeId, Math.max(0, (state.reads.get(nodeId) ?? 1) - 1));
      }
      return !unjudgeable;
    });
    if (keep.length > 0) state.awaitingAnswer.set(nodeId, keep);
    else state.awaitingAnswer.delete(nodeId);
  }
  return dropped;
}

/** How far a driver-WS reconnect's own ping burst reaches (v0.65.0). The live
 *  restarts took 9 s to walk 38 nodes; two minutes is generous and BOUNDED, so
 *  a reconnect can never suppress self-proof indefinitely. */
export const DRIVER_BURST_MS = 120_000;
/** …and a little before the handshake, since the driver pings as it comes up. */
export const DRIVER_BURST_LEAD_MS = 5_000;

/** A probe booked as a MISS because its node went Dead on it (v0.64.4). */
export interface ProbeDeathMiss { nodeId: number; misses: number; cls: ProbeClass; lane: ProbeLane; frame: ProbeFrame }

/**
 * Settle the probes a newly Dead node never answered (v0.64.4).
 *
 * The driver sets Dead on a failed transmission, so a node the runner watched
 * go Dead while one of our probes to it was still unanswered went Dead on that
 * probe. Those probes are judged NOW, as misses, not at the answer grace: the
 * retry the ladder then sends revives the node inside the grace, and
 * `judgeProbeAnswers` would read that revival as the answer to the probe that
 * killed it. v0.50.0–v0.64.2 did exactly that — in one 49-hour window the
 * reference mesh's weakest outlet was credited 25 of 25 sweeps where it had
 * answered about 22.
 *
 * "Unanswered" is the judgment's own test, applied early: not heard since the
 * probe went out. A probe the node answered before dying did not kill it, and
 * stays pending for the ordinary judgment. Every lane's unanswered probe is
 * booked; a MEASUREMENT kill — sweep, or verification since v0.71.0 — exempts
 * the node from the dwell (see `probeDeath`) and counts in `probeKills`; a
 * manual or ladder probe's does neither.
 */
function settleProbeDeath(state: AutoPingState, nodeId: number, lastHeard: number | null, now: number): ProbeDeathMiss[] {
  const pending = state.awaitingAnswer.get(nodeId);
  if (!pending) return [];
  const killed = pending.filter((p) => p.at <= now && (lastHeard == null || lastHeard < p.at));
  if (killed.length === 0) return [];
  const rest = pending.filter((p) => !killed.includes(p));
  if (rest.length > 0) state.awaitingAnswer.set(nodeId, rest);
  else state.awaitingAnswer.delete(nodeId);
  // The NEWEST settled probe decides (entries are appended as registered, which
  // is send order for the engine's lanes): the death followed it most closely.
  // Deciding on "any sweep" let an older sweep entry, still pending after an
  // ordinary lost reply, lend its exemption to a MANUAL kill, which keeps the
  // dwell (see `probeDeath`). A manual ping registers
  // after its call returns, so a sweep sent to the same node during that call
  // can sit before it though sent later (v0.64.5); the manual entry then
  // decides and keeps the dwell — the conservative reading of two frames sent
  // close together (normally milliseconds apart, up to ~10 s while the HA
  // WebSocket re-authenticates).
  const newest = killed[killed.length - 1];
  if (newest.lane === 'sweep' || newest.lane === 'verify') {
    state.probeDeath.set(nodeId, newest.lane);
    recordProbeKill(state, nodeId, now);
  }
  return killed.map(({ cls, lane, frame }) => {
    const misses = (state.missStreak.get(nodeId) ?? 0) + 1;
    state.missStreak.set(nodeId, misses);
    return { nodeId, misses, cls, lane, frame: frame ?? 'ping' };
  });
}

/**
 * Fold the current roster into the episode bookkeeping.
 *
 * A node leaving Dead ENDS its episode and clears its attempt count, so a device
 * that dies again next week gets a fresh budget rather than inheriting an
 * exhausted one. Call once per tick, before deciding.
 *
 * Returns the probes a node was watched going Dead on, already booked as misses
 * (v0.64.4). The runner reports them; nothing else needs to.
 */
export function trackEpisodes(state: AutoPingState, nodes: NodeSnapshot[], now: number): ProbeDeathMiss[] {
  const settled: ProbeDeathMiss[] = [];
  const seen = new Set<number>();
  for (const n of nodes) {
    if (!isPingCandidate(n)) continue;
    seen.add(n.nodeId);
    if (n.status === NodeStatus.Dead) {
      if (!state.deadSince.has(n.nodeId)) {
        // SEED FROM WHAT THE DRIVER STILL KNOWS (v0.50.0), not from `now`.
        //
        // This state is in-memory, so every add-on restart re-seeded the outage
        // clock at boot — and the driver, which survives our restarts, was
        // holding `lastSeen` two lines from here the whole time. Measured on
        // the live mesh: node 49's "DEAD 19.2h" was counted from a deploy, not
        // from when the device actually stopped answering, and three deploys in
        // 50 minutes each restarted the clock.
        //
        // A node already Dead the first time we look has been down at least
        // since it was last heard. Clamp to `now` so a future or absent
        // lastSeen can never invent an outage longer than our own uptime.
        //
        // …EXCEPT for a death this run watched happen (v0.64.3). See `seenAlive`:
        // for a node we saw Alive, `lastSeen` is its last utterance, not the
        // moment it died, and backdating to it skipped the whole dwell.
        const lastHeard = n.stats?.lastSeen ?? null;
        const watchedDie = state.seenAlive.has(n.nodeId);
        state.deadSince.set(n.nodeId, watchedDie ? now : (lastHeard != null && lastHeard < now ? lastHeard : now));
        // …and a death we watched while a probe of ours was still unanswered is
        // a death ON that probe (v0.64.4). See `probeDeath`.
        if (watchedDie) settled.push(...settleProbeDeath(state, n.nodeId, lastHeard, now));
      }
    } else {
      if (n.status === NodeStatus.Alive) state.seenAlive.add(n.nodeId);
      state.deadSince.delete(n.nodeId);
      state.attempts.delete(n.nodeId);
      state.lastPingAt.delete(n.nodeId);
      // Recovery ends the outage, so a device that dies again is announced
      // again rather than being silently remembered as already-reported.
      state.gaveUpAnnounced.delete(n.nodeId);
      state.launchFailures.delete(n.nodeId);
      state.launchGaveUpAnnounced.delete(n.nodeId);
      state.talkingAnnounced.delete(n.nodeId);
      // …and the probe-death mark (v0.64.4): it described the episode that ended.
      // An episode that began on our own measurement probe starts the hold
      // first (v0.71.0) — from the RECOVERY, see `probeHoldFrom`.
      if (state.probeDeath.has(n.nodeId)) state.probeHoldFrom.set(n.nodeId, now);
      state.probeDeath.delete(n.nodeId);
      // …and the routed-read bookkeeping (v0.70.0). NOT `readRevivals`: that
      // spans episodes by design, to bound a kill–revive loop.
      state.readOwed.delete(n.nodeId);
      state.reads.delete(n.nodeId);
    }
  }
  // A node that vanished from the roster (removed/excluded) must not leak its
  // bookkeeping forever.
  for (const id of [...state.deadSince.keys()]) if (!seen.has(id)) state.deadSince.delete(id);
  for (const id of [...state.attempts.keys()]) if (!seen.has(id)) state.attempts.delete(id);
  for (const id of [...state.lastPingAt.keys()]) if (!seen.has(id)) state.lastPingAt.delete(id);
  for (const id of [...state.lastStaleAt.keys()]) if (!seen.has(id)) state.lastStaleAt.delete(id);
  // …and attribution (v0.40): a re-included device reusing the nodeId must not
  // inherit the departed node's last attributed probe answer.
  for (const id of [...state.lastProbeSeen.keys()]) if (!seen.has(id)) state.lastProbeSeen.delete(id);
  // …and the judgment bookkeeping (v0.40.2): a re-included device reusing the
  // nodeId must not inherit a departed node's miss streak, pending probes, or
  // give-up announcement.
  for (const id of [...state.missStreak.keys()]) if (!seen.has(id)) state.missStreak.delete(id);
  for (const id of [...state.awaitingAnswer.keys()]) if (!seen.has(id)) state.awaitingAnswer.delete(id);
  for (const id of [...state.lastVerifyAt.keys()]) if (!seen.has(id)) state.lastVerifyAt.delete(id);
  for (const id of [...state.gaveUpAnnounced]) if (!seen.has(id)) state.gaveUpAnnounced.delete(id);
  for (const id of [...state.launchFailures.keys()]) if (!seen.has(id)) state.launchFailures.delete(id);
  for (const id of [...state.launchGaveUpAnnounced]) if (!seen.has(id)) state.launchGaveUpAnnounced.delete(id);
  for (const id of [...state.talkingAnnounced]) if (!seen.has(id)) state.talkingAnnounced.delete(id);
  // …and the watched-alive mark (v0.64.3): a re-included device reusing the
  // nodeId must not inherit the departed node's "we saw it alive".
  for (const id of [...state.seenAlive]) if (!seen.has(id)) state.seenAlive.delete(id);
  // …and the probe-death mark (v0.64.4), for the same reason.
  for (const id of [...state.probeDeath.keys()]) if (!seen.has(id)) state.probeDeath.delete(id);
  // …and the routed-read state (v0.70.0), revivals included: a device
  // re-included on the same id is a different device.
  for (const id of [...state.readOwed]) if (!seen.has(id)) state.readOwed.delete(id);
  for (const id of [...state.reads.keys()]) if (!seen.has(id)) state.reads.delete(id);
  for (const id of [...state.readRevivals.keys()]) if (!seen.has(id)) state.readRevivals.delete(id);
  for (const id of [...state.readAfterOwnKill]) if (!seen.has(id)) state.readAfterOwnKill.delete(id);
  // …and the kill containment (v0.71.0): a re-included device must not inherit
  // a departed node's hold, kill history or NoOp fallback.
  for (const id of [...state.probeHoldFrom.keys()]) if (!seen.has(id)) state.probeHoldFrom.delete(id);
  for (const id of [...state.probeKills.keys()]) if (!seen.has(id)) state.probeKills.delete(id);
  for (const id of [...state.probeKillWarn]) if (!seen.has(id)) state.probeKillWarn.delete(id);
  for (const id of [...state.readLaunchFailedAt.keys()]) if (!seen.has(id)) state.readLaunchFailedAt.delete(id);
  return settled;
}

/** Record that a STALE liveness probe was issued. */
export function noteStale(state: AutoPingState, nodeId: number, now: number): void {
  state.lastStaleAt.set(nodeId, now);
}

/** Record that an auto-ping was issued (called by the runner, not the decider). */
export function noteAttempt(state: AutoPingState, nodeId: number, now: number): void {
  state.attempts.set(nodeId, (state.attempts.get(nodeId) ?? 0) + 1);
  state.lastPingAt.set(nodeId, now);
}

/* ── runner ───────────────────────────────────────────────────────────────
 *
 * Thin on purpose: every judgement lives in `decideAutoPings` above, which is
 * pure and directly tested. This only performs the side effects.
 */

/** Suppress for this long after start — every node reads Dead until the first
 *  roster poll lands, and pinging the whole mesh on each restart is exactly the
 *  behaviour that would make an operator disable the feature and never re-enable
 *  it. The dead-node ladder is released as soon as the roster is ready
 *  (v0.64.4, `AutoPingInput.bootDeadLane`); the sweep and verification lanes
 *  serve the whole window. */
export const BOOT_WINDOW_MS = 5 * 60_000;

/** Re-state an UNCHANGED decision at most this often, so a steady state is
 *  still visible without the log becoming a per-minute drumbeat. */
export const TRACE_HEARTBEAT_MS = 30 * 60_000;

export interface AutoPingRunnerOptions {
  nodes: () => NodeSnapshot[];
  controller: () => ControllerSnapshot | null;
  ready: () => boolean;
  ping: (nodeId: number) => Promise<unknown>;
  /** Non-learning ping for the MEASUREMENT lanes — the liveness sweep and the
   *  verification bursts (v0.38.1). Falls back to `ping` when absent so old
   *  tests and callers behave as before, but production must wire it: with the
   *  learning verb, every probe stamps `ping` onto any open episode and the
   *  control arm can never accrue. Only the dead-node remediation ladder keeps
   *  the learning verb, because there the ping genuinely IS the treatment.
   *  Since v0.71.0 it is the measurement lanes' FALLBACK frame: `probeRead`
   *  goes out instead wherever the node has a value to read. */
  probe?: (nodeId: number) => Promise<unknown>;
  /** The measurement lanes' frame (v0.71.0): the same single Get as `read`,
   *  logged as a probe and never learned. Used for a sweep or verification
   *  probe when `canRead` says the node has a value and no launch of it failed
   *  in the last `READ_LAUNCH_FALLBACK_MS`. Absent ⇒ every measurement probe is
   *  the NoOp ping, exactly v0.70.0. */
  probeRead?: (nodeId: number) => Promise<unknown>;
  /** Called BEFORE each sweep or verification probe is sent (v0.71.0), so the
   *  data layer can tell a route change our frame caused from one it merely
   *  revealed. Never for the ladder, its read, or a manual ping. */
  onMeasurementSent?: (nodeId: number, at: number, lane: 'sweep' | 'verify', frame: ProbeFrame) => void;
  /** The measurement probe stamped at `at` never left — its launch was refused
   *  or failed (v0.71.0) — so the stamp must be withdrawn. */
  onMeasurementWithdrawn?: (nodeId: number, at: number) => void;
  /** Drain the Dead transitions the event feed has seen CLEAR since the last
   *  call (v0.71.0): when the node went Dead (`at`, epoch ms) and the node's
   *  `lastSeen` as of that moment (`seen`, from the same feed, so it cannot be
   *  a later frame's). A death that clears between two ticks is invisible to
   *  the level-sampled roster; see the runner. Optional: absent, only
   *  tick-visible deaths are attributed, as before. */
  deaths?: () => { nodeId: number; at: number; seen?: number | null }[];
  /** One routed read for a Dead node whose ladder ping went unanswered
   *  (v0.70.0): a single Get on the node's own switch/light value. Non-learning,
   *  read-only. Absent ⇒ no reads (the v0.69.0 ladder). */
  read?: (nodeId: number) => Promise<unknown>;
  /** Whether the node has a value a routed read can target (v0.70.0). */
  canRead?: (nodeId: number) => boolean;
  /** Writes into the event ring so an autonomous action is never invisible. */
  log: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string) => void;
  /**
   * Optional SERVER logger (stdout / add-on log), distinct from `log` above.
   *
   * These are two different destinations and conflating them cost real time:
   * `log` writes to the in-memory event ring behind the login gate (the TUI Log
   * screen), while this writes to the container log an operator actually greps.
   * Auto-ping originally used only the ring, so every probe it fired was
   * invisible from outside — the feature was diagnosed as a no-op purely because
   * the evidence was in a place the diagnosis never looked. An autonomous action
   * must be visible in BOTH.
   */
  log2?: ((msg: string) => void) & {
    debug?: (msg: string) => void;
    /** v0.50.0. The TYPE foreclosed severity: every leveled message was paired
     *  with a BARE `log2?.(m)`, so autoPing's two ERROR sites and its WARN site
     *  all reached the container log at info. Adding these members is what lets
     *  a caller actually raise one. */
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  config: AutoPingConfig;
  tickMs?: number;
  now?: () => number;
  /** Drain the outcome ledger's pending verification probes (v0.36). Optional:
   *  without it the runner behaves exactly as it did before. `skip` (v0.71.0)
   *  names nodes whose probes must stay OWED rather than be drained — the
   *  post-kill hold — so the ledger's burst budget is not spent on packets
   *  that are never sent (the v0.36.2 disease). */
  verifyRequests?: (now: number, skip?: (nodeId: number) => boolean) => { id: number; first: boolean }[];
  /** Nodes with an outstanding verification burst, for the probe line (v0.37.1). */
  verifyOwedCount?: () => number;
  /** When the controller's receiver went off and has not come back (v0.65.0),
   *  or null. Suppresses every lane, and makes the probes already in flight
   *  unjudgeable rather than missed. */
  rfOffSince?: () => number | null;
  /** When the driver-WS link last completed a handshake (v0.65.0), or null.
   *  A driver restart pings the whole mesh itself, which advances every node's
   *  lastSeen — evidence this add-on cannot attribute to anything it sent. */
  driverReconnectedAt?: () => number | null;
  /** One liveness-probe outcome, for the persisted per-node reply rate (v0.37).
   *  `selfProven` = the node had already communicated on its own since the
   *  previous sweep, so the probe was confirming rather than discovering. */
  /** `cls` is the FOUR-way verdict (v0.49.0), not a self-proven boolean — the
   *  other three arms were computed and discarded on every tick. `frame`
   *  (v0.71.0) is what the probe put on the air, because an answered read and
   *  an answered ping are different facts. */
  onProbeResult?: (nodeId: number, answered: boolean, cls: ProbeClass, frame: ProbeFrame) => void;
}

/**
 * A read-only view of auto-ping's live state (v0.41).
 *
 * The engine's ONE autonomous write had no accessor anywhere in the codebase:
 * suppression, the dwell/attempt/backoff position of every Dead node, miss
 * streaks, the sweep backlog and the verification debt were all computed every
 * tick and reachable only by tailing the container log. A gap analysis called
 * that the largest single class-A hole in the TUI, and it is the state an
 * operator most needs when the mesh misbehaves.
 */
export interface AutoPingSnapshot {
  /** null until the first tick has run. */
  lastTickMs: number | null;
  suppressed: AutoPingSuppression;
  listening: number;
  deadListening: number;
  /** See AutoPingDecision.capabilityUnknown (v0.52.0). */
  capabilityUnknown: number;
  /** null when the last pass was SUPPRESSED and never computed them — a
   *  structural absence rendered as `0` reads as a measurement (v0.41.0). */
  staleDue: number | null;
  stalestMs: number | null;
  verifyOwed: number | null;
  /** Config echoed back, so the screen never has to guess the active policy. */
  config: AutoPingConfig;
  nodes: AutoPingNodeState[];
}

/** Per-node auto-ping state — only nodes the engine is actually tracking. */
export interface AutoPingNodeState {
  nodeId: number;
  /** Dead since (ms epoch), or null when the node is not in a dead episode. */
  deadSinceMs: number | null;
  /** Remediation attempts spent this episode. */
  attempts: number;
  /** Earliest ms epoch the ladder may probe again, or null when it may now. */
  nextEligibleMs: number | null;
  /** Consecutive unanswered probes (any lane). */
  missStreak: number;
  /** Consecutive probe LAUNCHES that never left this add-on (v0.40.2). */
  launchFailures: number;
  /** Probes awaiting judgment right now. */
  pending: number;
  /** The ladder has abandoned this node to a human. */
  gaveUp: boolean;
  /** The add-on could not send at all, maxAttempts in a row (v0.40.2). */
  launchGaveUp: boolean;
  /** The driver flags this node Dead, but it was heard from inside the dwell
   *  (v0.42.0) — the flag is stale and the node is reachable. */
  talkingWhileDead: boolean;
  /** Routed reads launched this episode (v0.70.0). */
  reads: number;
  /** An unanswered ladder ping is waiting on its one routed read (v0.70.0). */
  readOwed: boolean;
  /** Times a routed read revived this node in the last 24 h (v0.70.0). */
  readRevivals24h: number;
  /** Deaths on our own sweep or verification probes in the last 24 h (v0.71.0). */
  probeKills24h: number;
  /** When the post-kill measurement hold lifts, epoch ms, or null (v0.71.0). */
  probeHeldUntilMs: number | null;
}

/** How a lane reads in a probe line (v0.71.0). */
const LANE_WORD: Record<ProbeLane, string> = { sweep: 'sweep', verify: 'verification', dead: 'ladder', manual: 'manual', read: 'ladder' };
/** How a frame reads in a probe line (v0.71.0). */
function frameWord(frame: ProbeFrame): string {
  return frame === 'read' ? 'routed read' : 'NoOp ping';
}
/** The suffix every miss line carries (v0.71.0): which lane, which frame. */
function probeWord(lane: ProbeLane, frame: ProbeFrame): string {
  return ` — ${LANE_WORD[lane]} ${frameWord(frame)}`;
}

export function startAutoPing(o: AutoPingRunnerOptions): {
  stop: () => void;
  tick: () => void;
  snapshot: () => AutoPingSnapshot;
  notePending: (nodeId: number, lane?: ProbeLane, at?: number) => void;
} {
  const now = o.now ?? (() => Date.now());
  const startedAt = now();
  const state = createAutoPingState();
  // Kept for `snapshot()` — the runtime state an operator cannot otherwise see.
  let lastDecision: AutoPingDecision | null = null;
  let lastTickMs: number | null = null;
  let lastSuppression: AutoPingSuppression | null = null;
  /** The blackout whose dropped probes were already announced (v0.65.0). */
  let lastRfOffLogged: number | null = null;
  let lastTrace = '';
  let lastTraceAt = 0;

  /** The frame a MEASUREMENT probe of this node sends at `at` (v0.71.0). The
   *  sweep and the verification lanes both ask here, so the twin-lane dedup
   *  still holds: whichever lane goes, it asks the same question. */
  const frameOf = (id: number, at: number): ProbeFrame =>
    o.probeRead != null && (o.canRead?.(id) ?? false) && !readFallbackActive(state, id, at) ? 'read' : 'ping';
  const measure = (frame: ProbeFrame, id: number): Promise<unknown> =>
    frame === 'read' ? o.probeRead!(id) : (o.probe ?? o.ping)(id);
  /** What each measurement line says it sent, and why a ping when reads are on. */
  const frameNote = (frame: ProbeFrame, id: number, at: number): string =>
    frame === 'read' ? ' — routed read'
      : o.probeRead == null ? ''
      : readFallbackActive(state, id, at)
        ? ` — NoOp ping (a routed read could not be sent in the last ${Math.round(READ_LAUNCH_FALLBACK_MS / 60_000)}m)`
        : ' — NoOp ping (no switch/light value to read)';
  const readLaunchFailed = (id: number, at: number): void => {
    state.readLaunchFailedAt.set(id, at);
    const m = `auto-ping: node ${id}: a routed read could not be sent — its sweep and verification probes ` +
      `use the NoOp ping for the next ${Math.round(READ_LAUNCH_FALLBACK_MS / 60_000)}m`;
    o.log('info', id, m);
    o.log2?.(m);
  };

  const tick = (): void => {
    const t = now();
    const nodes = o.nodes();
    // Episode bookkeeping first. A node that went Dead on one of our own probes
    // comes back with that probe already booked as a MISS (v0.64.4), reported
    // here exactly as the judgment loop below reports any other miss.
    for (const s of trackEpisodes(state, nodes, t)) {
      // Only the fixed-cadence sweep feeds the persisted reply rate (v0.40.2).
      if (s.lane === 'sweep') o.onProbeResult?.(s.nodeId, false, s.cls, s.frame);
      const m = `auto-ping: node ${s.nodeId} did NOT answer its probe ` +
        `(${ordinal(s.misses)} consecutive miss — the node has since been marked Dead)` + probeWord(s.lane, s.frame);
      o.log(s.misses >= 2 ? 'warn' : 'info', s.nodeId, m);
      (s.misses >= 2 ? (o.log2?.warn ?? o.log2) : o.log2)?.(m);
    }
    // DEATHS BETWEEN TICKS (v0.71.0). trackEpisodes LEVEL-samples status once a
    // tick, so a node that goes Dead and comes back inside one tick never reaches
    // it. Two things revive a node that fast. Any frame FROM a Dead node marks it
    // Alive, so a node that reports on its own clears a NoOp kill by itself. And
    // a Get can clear its own: the node takes the frame, its ACK is lost, the
    // driver marks it Dead on the NoAck, and the node's Report then marks it
    // Alive again. The event feed counts both crossings into dead-flap and the
    // confound guard, so the containment must count them too, or a burst could
    // make such pairs without the hold ever arming. The feed hands over only
    // deaths it has seen CLEAR, so a Dead node the roster has not caught up with
    // is left to trackEpisodes. Nothing here can book a probe twice:
    // settleProbeDeath, which ran above, removes every probe it books, and a
    // probe the node answered fails the at-death test below. So a node that is
    // Dead AGAIN at this tick — on a later death — still has its earlier one
    // judged here, which trackEpisodes, reading the lastSeen that revival moved,
    // cannot do.
    for (const d of o.deaths?.() ?? []) {
      // settleProbeDeath's own test, applied at the death: a probe the node had
      // answered before it died did not kill it, and one sent after it cannot.
      const pending = state.awaitingAnswer.get(d.nodeId) ?? [];
      const before = pending.filter((p) => p.at <= d.at && d.at - p.at <= ANSWER_GRACE_MS && (d.seen == null || d.seen < p.at));
      const newest = before[before.length - 1];
      if (newest == null || (newest.lane !== 'sweep' && newest.lane !== 'verify')) continue;
      recordProbeKill(state, d.nodeId, d.at);
      state.probeHoldFrom.set(d.nodeId, t);
      const frame = newest.frame ?? 'ping';
      const back = state.deadSince.has(d.nodeId) ? 'came back, and is Dead again at this tick on something later' : 'was Alive again before the next tick';
      const after = `${Math.max(0, Math.round((d.at - newest.at) / 1000))}s after our ${LANE_WORD[newest.lane]} ${frameWord(frame)}`;
      const hold = `no sweep or verification probe for ${Math.round(PROBE_KILL_HOLD_MS / 60_000)}m`;
      if (frame === 'read') {
        // The read stays pending and is judged as usual: its Report is what
        // revived the node, and a Report proves the Get arrived — ANSWERED.
        const m = `auto-ping: node ${d.nodeId} went Dead ${after} and ${back} ` +
          `(a lost ACK, most likely: its Report revives it) — ${hold}`;
        o.log('info', d.nodeId, m);
        o.log2?.(m);
        continue;
      }
      // A NoOp gets no reply, so whatever revived the node — its own report, or
      // another sender's acknowledged frame — was not an answer. Settle the ping
      // as a miss now, as settleProbeDeath does, or the judgment would read that
      // traffic as the answer (the v0.64.4 credit leak, reopened).
      const rest = pending.filter((p) => p !== newest);
      if (rest.length > 0) state.awaitingAnswer.set(d.nodeId, rest);
      else state.awaitingAnswer.delete(d.nodeId);
      const misses = (state.missStreak.get(d.nodeId) ?? 0) + 1;
      state.missStreak.set(d.nodeId, misses);
      if (newest.lane === 'sweep') o.onProbeResult?.(d.nodeId, false, newest.cls, frame);
      const m = `auto-ping: node ${d.nodeId} did NOT answer its probe (${ordinal(misses)} consecutive miss — ` +
        `it went Dead ${after} and ${back}; a NoOp gets no reply, so that was not an answer) — ${hold}` + probeWord(newest.lane, frame);
      o.log(misses >= 2 ? 'warn' : 'info', d.nodeId, m);
      (misses >= 2 ? (o.log2?.warn ?? o.log2) : o.log2)?.(m);
    }
    // ONE warning when a node's own-probe kills reach the threshold (v0.71.0).
    for (const id of state.probeKillWarn) {
      const w = `auto-ping: node ${id} went Dead on this add-on's own probes ${PROBE_KILL_WARN_AT} times in 24 h ` +
        `(each followed by ${Math.round(PROBE_KILL_HOLD_MS / 60_000)}m with no sweep or verification probe) — ` +
        `its routes are marginal; consider rebuilding its routes, or moving it or a repeater`;
      o.log('warn', id, w);
      (o.log2?.warn ?? o.log2)?.(w);
    }
    state.probeKillWarn.clear();
    lastTickMs = t;
    const decision = lastDecision = decideAutoPings({
      now: t,
      state,
      nodes,
      controller: o.controller(),
      config: o.config,
      // Not ready == no trustworthy roster yet, which is the same hazard as the
      // post-start window, so it counts as booting rather than as "no nodes".
      booting: !o.ready() || t - startedAt < BOOT_WINDOW_MS,
      bootDeadLane: o.ready(),
      verifyDue: () => o.verifyRequests?.(t, (id) => inProbeHold(state, id, t)) ?? [],
      verifyOwedCount: () => o.verifyOwedCount?.() ?? 0,
      rfOffSince: o.rfOffSince?.() ?? null,
      canRead: (id) => o.read != null && (o.canRead?.(id) ?? false),
    });

    // DECISION TRACE.
    //
    // v0.31.1. Until now the runner spoke only when it ACTED, which made "there
    // was nothing to do" and "this is broken" produce byte-identical logs — an
    // empty one. That is exactly the state the feature was found in: enabled,
    // healthy, and silently doing nothing, with no way to tell which gate was
    // closing without reading the source and guessing.
    //
    // Emitted on CHANGE (so a transition is never missed) plus a slow heartbeat
    // (so a steady state is still visible), at info level — the operator should
    // not have to raise log_level to find out whether an autonomous feature is
    // alive. `log.debug` carries every tick for real debugging.
    const trace =
      `auto-ping: candidates=${decision.listening} dead=${decision.deadListening} ` +
      `stale-due=${decision.staleDue}` +
      (decision.stalestMs != null ? ` stalest=${Math.round(decision.stalestMs / 60_000)}m` : '') +
      ` -> ${decision.suppressed === 'none'
        ? `probing ${decision.ping.length + decision.read.length + decision.stale.length}`
        : 'suppressed: ' + decision.suppressed +
          // v0.64.4: the dead ladder can act inside the boot window. Without this
          // the trace said "suppressed" beside a probe going out.
          (decision.ping.length + decision.read.length > 0 ? ` (dead ladder open, probing ${decision.ping.length + decision.read.length})` : '')}`;
    o.log2?.debug?.(trace);
    // Dedup on the SHAPE of the decision, not its exact text (v0.37). The
    // sweep now asks every node, so `stale-due` and `stalest` churn on every
    // single tick as the queue advances — deduping on the whole line would
    // turn a change-plus-heartbeat trace into a per-minute drumbeat, which is
    // the noise this dedup exists to prevent. What an operator needs to see
    // change is the suppression state, the dead count, the candidate count,
    // and whether anything is being probed at all; the exact queue depth is
    // detail, and rides the debug line every tick regardless.
    const traceKey = `${decision.listening}|${decision.deadListening}|${decision.suppressed}|` +
      `${decision.ping.length + decision.read.length + decision.stale.length > 0}`;
    const changed = traceKey !== lastTrace;
    if (changed || t - lastTraceAt >= TRACE_HEARTBEAT_MS) {
      o.log('info', null, trace);
      o.log2?.(trace);
      lastTrace = traceKey;
      lastTraceAt = t;
    }

    // A storm is the one suppression worth saying out loud, and worth saying
    // ONCE — it means a quarter of the mesh is down, which the operator wants to
    // know about even though the engine is deliberately doing nothing.
    if (decision.suppressed === 'storm' && lastSuppression !== 'storm') {
      const stormMsg =
        `auto-ping suppressed: ${decision.deadListening}/${decision.listening} mains nodes are Dead — ` +
        'that is a controller-level event, not per-device, so probing them would only add traffic';
      o.log('warn', null, stormMsg);
      // The one message this file calls "worth saying out loud" was the ONLY
      // auto-ping message with no log2 companion (v0.50.0) — so a quarter of the
      // mesh going down was announced on a screen behind the login gate and
      // NOWHERE an operator greps.
      (o.log2?.warn ?? o.log2)?.(stormMsg);
    }
    lastSuppression = decision.suppressed;

    for (const nodeId of decision.stale) {
      // Captured BEFORE noteStale books the cadence clock, or the refund below
      // hands back the value this sweep just booked (v0.40.2) — the same
      // capture-order trap the dead lane's attempt refund fell into.
      const priorStale = state.lastStaleAt.get(nodeId);
      const frame = frameOf(nodeId, t);
      noteStale(state, nodeId, t);
      // MEASURED silence, never the threshold. This line used to print
      // `config.staleMs` — so every probe claimed exactly "240m" regardless of
      // truth, which hid a 7-hour timestamp-parsing skew for a full day: nodes
      // 11 hours silent were logged as "240m", and the constant reading gave
      // no hint the number was fabricated. decision.stale holds at most ONE
      // node (the queue head), so stalestMs is exactly this node's silence.
      const silence = decision.stalestMs == null
        ? 'never (no lastSeen on record)'
        : `${Math.round(decision.stalestMs / 60_000)}m`;
      // Did this node already prove itself since the last sweep? From v0.37 the
      // sweep asks everyone, so the answer is no longer implied by being asked
      // — and it is the difference between "the probe is this node's only
      // evidence of life" and "the probe is confirming what its own traffic
      // already showed".
      // Measured against the CADENCE, not against the previous probe time. Two
      // earlier attempts were wrong: reading lastStaleAt after noteStale
      // compares against NOW (nothing is ever newer, so every node reads as
      // unheard), and treating a never-probed node as self-proven declares a
      // device silent for eleven hours to be confirming itself. "Did it speak
      // within one sweep interval" needs no probe history and is true on the
      // first sweep as readily as the hundredth.
      //
      // …and against ATTRIBUTION (v0.40): a probe answer advances lastSeen
      // too, so cadence alone counted the app's own echo as the node's voice.
      // An audit caught the tell — "already heard 120m ago on its own —
      // confirming" is a full threshold of silence described as confirming,
      // and for quiet-but-answering nodes the confirming/unheard split was a
      // sticky sub-minute scheduling bias, persisted as if it were device
      // behavior. Self-proven now additionally requires lastSeen to have
      // advanced PAST what our own last answered probe put on the record.
      const seenAt = nodes.find((x) => x.nodeId === nodeId)?.stats?.lastSeen ?? null;
      const attributed = state.lastProbeSeen.get(nodeId) ?? null;
      const heardRecently = seenAt != null && t - seenAt < o.config.staleMs;
      const spokeOnItsOwn = seenAt != null && (attributed == null || seenAt > attributed);
      // …and against the DRIVER's own voice (v0.65.0). A driver restart pings
      // the whole mesh to re-establish it, which advances every node's lastSeen
      // within seconds. That is a third party's probe: attribution cannot tell
      // it from the node speaking, and v0.40.2 already settled what to do with
      // an advance we cannot attribute — say so and credit nothing. The live
      // audit of 2026-09-15 measured the alternative: 28 fabricated
      // `self-proven` credits from two restarts in 23 h, into a counter that is
      // persisted and never decays.
      const reconnAt = o.driverReconnectedAt?.() ?? null;
      const inReconnectBurst = reconnAt != null && seenAt != null
        && seenAt >= reconnAt - DRIVER_BURST_LEAD_MS && seenAt <= reconnAt + DRIVER_BURST_MS;
      // Unknown attribution is NOT self-proven: an unbacked credit is worse
      // than a missing one, and it persists (v0.40.2).
      const selfProven = heardRecently && spokeOnItsOwn && attributed != null && !inReconnectBurst;
      // The ECHO label is routed by attribution alone, NOT by recency
      // (v0.40.1): a probe-echo-only node whose answer is 119 minutes old and
      // one whose answer is 121 minutes old are the same physical situation,
      // and the first audit of v0.40.0 caught the recency gate splitting them
      // — "unheard for 120m" on a node answering every probe, decided by
      // sub-minute scheduling jitter, sticky per node. "Unheard" is reserved
      // for nodes with nothing on record past what our own probes produced,
      // and no probe answer of ours to point to either.
      const echoOnly = attributed != null && seenAt != null && seenAt <= attributed;
      // Attribution is per-PROCESS, so on the first sweep after a restart we
      // cannot tell the node's own traffic from the previous process's probe
      // echoes. v0.40/v0.40.1 resolved that ambiguity as "on its own" and
      // credited it — an audit measured the cost: 35 fabricated `confirming`
      // labels and 35 false self-proven credits into a persisted, never-decaying
      // counter, once per boot, fleet-wide. Say what is actually known instead,
      // and credit nothing (v0.40.2).
      //
      // …in BOTH directions (v0.66.0). v0.40.2 fixed the positive arm and left
      // the negative one standing: `echoOnly` cannot be computed without
      // `attributed`, so with none the four-way chain fell through to
      // `unheard` — and `unheard` is not a shrug. It is the dossier's claim
      // that this node "is genuinely silent", stated there as the OPPOSITE
      // reading of echo-only, and counted into a ledger that is persisted and
      // never decays. The 2026-09-17 log review measured the cost: at the
      // 07:11 boot 24 nodes were booked `unheard`, and all 24 were classified
      // `echo-only` at their very next sweep — each had answered the very
      // probe its mark was written against. Missing attribution is missing
      // attribution whichever direction it would have pointed.
      //
      // `seenAt != null` keeps the honest negative reachable: a node with
      // NOTHING on record has no attribution question to be unsure about.
      const attributionUnknown = (attributed == null && seenAt != null)
        || (heardRecently && inReconnectBurst && spokeOnItsOwn);
      // ONE VALUE, in the SAME precedence the label below uses (v0.49.0). The
      // sweep's judgment is FOUR-way and only the `self-proven` arm was ever
      // recorded — the other three were computed, described in the log line,
      // and thrown away every tick. Deriving the string FROM this value is half
      // the point: a separate boolean and a separate message can disagree, and
      // for four releases the only way to know which arm fired was to read
      // prose out of a container log.
      const cls: ProbeClass = attributionUnknown ? 'attribution-unknown'
        : selfProven ? 'self-proven'
        : echoOnly ? 'echo-only'
        : 'unheard';
      const msg = `auto-ping: node ${nodeId} liveness sweep ` +
        (attributionUnknown
          ? (inReconnectBurst && attributed != null
            ? `(heard ${silence} ago, inside the driver's own restart burst — not attributable, not credited)`
            : heardRecently
              ? `(heard ${silence} ago, but this run has no probe attribution yet — not credited)`
              // Past the threshold and unattributable is NOT the same statement
              // as heard-just-now and unattributable, and collapsing the two
              // would hide a genuinely quiet node behind the fix for the
              // fabricated ones (v0.66.0).
              : `(nothing heard for ${silence}, past the ${Math.round(o.config.staleMs / 60_000)}m threshold, but this run has no probe attribution to tell silence from our own echo — not credited)`)
          : selfProven
            ? `(already heard ${silence} ago on its own — confirming)`
            : echoOnly
              ? `(nothing heard past our last probe's answer ${silence} ago — probing for its own voice)`
              : `(unheard for ${silence}, threshold ${Math.round(o.config.staleMs / 60_000)}m)`) +
        frameNote(frame, nodeId, t);
      // DELIBERATELY still info on BOTH sinks (re-affirmed v0.50.0).
      //
      // 941 of these in 50 hours is 71.6% of the add-on log, and an audit
      // proposed demoting them to debug. That trade was refused: the test
      // "an autonomous action is visible in the SERVER log, not only the event
      // ring" pins this line at info because auto-ping ONCE wrote only to the
      // ring, 34 real probes were invisible from outside, and the feature was
      // diagnosed as a no-op — the evidence existed, in a place the diagnosis
      // never looked. Demoting to debug reinstates exactly that at the DEFAULT
      // log level.
      //
      // The actual harm the audit found was that the one ERROR asking for a
      // human was BYTE-IDENTICAL to these. That is fixed at the sink instead:
      // logger.ts now writes the severity, so `grep ERROR` finds it among them.
      // Volume you can filter is not the same problem as signal you cannot see.
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // The service call resolving proves only that HA ACCEPTED the request —
      // its ping button returns a boolean and raises nothing when the node
      // stays silent, and refresh_value returns before its Get is on the air —
      // so the answer is judged from evidence a moment later
      // (judgeProbeAnswers). The catch here is left for what it can actually
      // catch: no ping button or value to read, or a WS transport fault. A read
      // that could not be sent also moves this node to the NoOp for a while
      // (v0.71.0), or its refunded slot would hold the queue's head.
      //
      // MEASUREMENT lane: the non-learning probe (v0.38.1). With the learning
      // verb, every sweep stamped `ping` onto any open episode and the control
      // arm could never accrue — the instrument was the recorded treatment.
      // `noteStale` above booked the cadence clock; a launch that never left
      // must give it back too, or the node waits a full staleMs having never
      // been asked (v0.40.2).
      pendProbe(state, nodeId, t, 'sweep', cls, frame);
      o.onMeasurementSent?.(nodeId, t, 'sweep', frame);
      settleProbe(o, state, nodeId, t, measure(frame, nodeId), () => {
        if (priorStale == null) state.lastStaleAt.delete(nodeId);
        else state.lastStaleAt.set(nodeId, priorStale);
        o.onMeasurementWithdrawn?.(nodeId, t);
        if (frame === 'read') readLaunchFailed(nodeId, t);
      }, frame === 'read' ? READ_REJECT_WHY : undefined);
    }

    for (const nodeId of decision.ping) {
      // Captured BEFORE noteAttempt so a refund restores the PRE-attempt
      // count — reading it afterwards would hand back the value the attempt
      // had just spent (v0.40.2). `lastPingAt` is deliberately NOT refunded:
      // it is the backoff clock, and giving it back turns a persistent launch
      // failure into a once-per-tick ping loop.
      const priorTries = state.attempts.get(nodeId);
      const attempt = (state.attempts.get(nodeId) ?? 0) + 1;
      noteAttempt(state, nodeId, t);
      // v0.64.4: a sweep kill skips the dwell, so do not claim the dwell ran —
      // and say only what was measured (the node went Dead with our probe to it
      // unanswered), which is a correlation, not a verdict on the cause.
      const killedBy = state.probeDeath.get(nodeId);
      const msg = state.probeDeath.has(nodeId)
        ? (attempt === 1
          ? `auto-ping: node ${nodeId} went Dead with our ${killedBy === 'verify' ? 'verification' : 'sweep'} probe to it unanswered — probing without the dwell `
          : `auto-ping: node ${nodeId} is still Dead after the immediate retry — probing `) +
          `(attempt ${attempt}/${o.config.maxAttempts})`
        : `auto-ping: node ${nodeId} has been Dead past the dwell — ` +
          `probing (attempt ${attempt}/${o.config.maxAttempts})`;
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // Fire and forget: the ping runner records its own outcome into the M5
      // ledger, and a failed probe is information, not an error to escalate.
      // This lane DELIBERATELY keeps the learning verb (v0.38.1): a ping fired
      // at a dead node past its dwell is a remediation attempt, and its
      // attribution is the self-instrumentation this module's autonomy is
      // justified by. The measurement lanes above use the non-learning probe.
      // The attempt was booked BEFORE the call (noteAttempt above), so a launch
      // that never left must give it back (v0.40.2) — otherwise an HA restart
      // silently spends a node's 3-attempt remediation budget on packets that
      // were never transmitted, and the ladder gives up on a node it never
      // actually probed.
      pendProbe(state, nodeId, t, 'dead');
      settleProbe(o, state, nodeId, t, o.ping(nodeId), () => {
        if (priorTries == null) state.attempts.delete(nodeId);
        else state.attempts.set(nodeId, priorTries);
        state.launchFailures.set(nodeId, (state.launchFailures.get(nodeId) ?? 0) + 1);
      });
    }

    // ROUTED READS (v0.70.0) — one per unanswered ladder ping. Judged by the
    // same evidence as every probe (lastSeen advancing past the moment it went
    // out), because HA's refresh_value returns before the Get is on the air: the
    // service result proves nothing. A launch that never left is un-counted and
    // NOT owed again — re-owing it would recreate the v0.40.2 retry loop — and
    // spends neither the attempt budget nor `launchFailures`.
    for (const nodeId of decision.read) {
      state.readOwed.delete(nodeId);
      // Its revival is judged later, after recovery has cleared `probeDeath`, so
      // whether this episode began on our own measurement probe is captured now.
      if (state.probeDeath.has(nodeId)) state.readAfterOwnKill.add(nodeId);
      else state.readAfterOwnKill.delete(nodeId);
      state.reads.set(nodeId, (state.reads.get(nodeId) ?? 0) + 1);
      const m = `auto-ping: node ${nodeId} did not answer its ladder ping — sending one routed read ` +
        `(a single Get with the driver's default routing, which may auto-route; a ping can use only the stored routes)`;
      o.log('info', nodeId, m);
      o.log2?.(m);
      pendProbe(state, nodeId, t, 'read', 'unheard', 'read');
      settleProbe(o, state, nodeId, t, o.read!(nodeId), () => {
        state.reads.set(nodeId, Math.max(0, (state.reads.get(nodeId) ?? 1) - 1));
      }, 'no switch/light value to read, or transport error');
    }

    /* ── verification probes (v0.36) ─────────────────────────────────────
     * Requested by the outcome ledger at an episode's two scoring moments.
     *
     * Logged to BOTH destinations, like every other autonomous write in this
     * file. v0.36.0 put these on the server log at DEBUG only, reasoning that
     * three probes per boundary would swamp the add-on log — arithmetic that
     * does not survive contact with the mesh: roughly 60 verification probes
     * per 39 hours against ~635 liveness probes is about a tenth more, not a
     * flood. The cost of being wrong that way is the exact failure this file
     * already documents one screen up: auto-ping was once diagnosed as a no-op
     * purely because its evidence sat somewhere the diagnosis never looked.
     * A new autonomous write is precisely the thing that must be greppable.
     */
    for (const nodeId of decision.verify) {
      // Carry the gap since this node's PREVIOUS verification probe (v0.37.1).
      // A burst wants its probes inside one 5-minute window, but the queue hands
      // out one node per tick GLOBALLY, so with several nodes owed bursts each
      // one's probes stretch further apart — and the log could not show it,
      // because the add-on log has no timestamps and the decision trace only
      // prints on change. Without this number the spacing is unmeasurable from
      // outside and any fix would be aimed at a story rather than a cause.
      // Burst boundary from GROUND TRUTH, not a time heuristic (v0.38.2).
      // Two generations of heuristic each lied in an audit: v0.37.1's
      // per-node gap conflated inter-burst pauses with stretched bursts, and
      // v0.37.2's 4-minute threshold mislabeled the boundary as "+180s"
      // whenever a symptom cleared mid-burst and the open→confirm pause came
      // in UNDER it — reading as slow spacing and sending the reviewer (me)
      // down the wrong path a second time. The queue knows which probe starts
      // a burst; the label now comes from its bookkeeping and cannot drift.
      const prevVerify = state.lastVerifyAt.get(nodeId);
      const frame = frameOf(nodeId, t);
      const sinceMs = prevVerify == null ? null : t - prevVerify;
      state.lastVerifyAt.set(nodeId, t);
      const gap = decision.verifyFirst.includes(nodeId) || sinceMs == null
        ? 'burst start'
        : `+${Math.round(sinceMs / 1000)}s`;
      const msg = `auto-ping: node ${nodeId} verification probe (episode evidence, ${gap}, ${decision.verifyOwed} owed)` + frameNote(frame, nodeId, t);
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // MEASUREMENT lane too (v0.38.1) — a verification probe exists to fill
      // the evidence window, and recording it as the remediation would make
      // the verdict about the measurement rather than the recovery.
      // The refund restores the stamp from BEFORE this probe (v0.71.0). It read
      // the map after the set above, so it put back this probe's own stamp and
      // the next burst gap was measured from a probe that never left — the
      // capture-order trap the sweep and ladder refunds document.
      pendProbe(state, nodeId, t, 'verify', 'unheard', frame);
      o.onMeasurementSent?.(nodeId, t, 'verify', frame);
      settleProbe(o, state, nodeId, t, measure(frame, nodeId), () => {
        if (prevVerify == null) state.lastVerifyAt.delete(nodeId);
        else state.lastVerifyAt.set(nodeId, prevVerify);
        o.onMeasurementWithdrawn?.(nodeId, t);
        if (frame === 'read') readLaunchFailed(nodeId, t);
      }, frame === 'read' ? READ_REJECT_WHY : undefined);
    }

    /* ── nodes the engine has given up on (v0.36.4) ──────────────────────
     * maxAttempts means "stop and leave it to a human", and for four releases
     * it did the stopping without the leaving-it-to-a-human. ERROR severity on
     * both destinations: this is the one auto-ping message that asks for
     * action rather than reporting activity.
     */
    // A node the driver still calls Dead that is demonstrably talking. Said
    // once per outage, like the give-up: it is the difference between "your
    // device is gone" and "the flag is stale", and an operator chasing the
    // former when it is the latter wastes a trip to the garage (v0.42.0).
    for (const nodeId of decision.talkingWhileDead) {
      if (state.talkingAnnounced.has(nodeId)) continue;
      state.talkingAnnounced.add(nodeId);
      const m = `auto-ping: node ${nodeId} reads Dead but was heard from within the dwell — ` +
        `trusting the traffic over the flag; no probe spent, no human needed`;
      o.log('info', nodeId, m);
      o.log2?.(m);
    }
    for (const nodeId of decision.launchGaveUp) {
      state.launchGaveUpAnnounced.add(nodeId);
      const m = `auto-ping: node ${nodeId} could not be probed ${o.config.maxAttempts}× in a row — ` +
        `the probe never left this add-on (no ping entity, or HA unreachable). This is OUR fault, not the node's; ` +
        `the remediation ladder is untouched and will resume when a probe can be sent.`;
      o.log('error', nodeId, m);
      (o.log2?.error ?? o.log2)?.(m);
    }
    for (const nodeId of decision.gaveUp) {
      state.gaveUpAnnounced.add(nodeId);
      // Say only what was measured: N unanswered PINGS. A ping is a NOP, and a
      // device can ignore NOPs while honouring ordinary commands — node 49 did
      // exactly that for 12 hours (v0.42.0). Operating the device is a stronger
      // reachability test than any number of pings, and it is the step that
      // actually worked, so it leads.
      const tries = o.config.maxAttempts;
      const reads = state.reads.get(nodeId) ?? 0;
      const revived = readRevivalsWithin(state, nodeId, t);
      const pl = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;
      // v0.70.0: say which frames were ignored. With no read sent (the node has
      // no switch/light value, or reads are off) the pre-v0.70.0 text stands.
      const m = revived >= READ_REVIVAL_CAP
        ? `auto-ping: node ${nodeId} did not answer ${pl(tries, 'ping')} — giving up. ` +
          `A routed read has revived it ${revived} times in the last 24 h after its pings went unanswered, so the read is withheld: ` +
          `its stored routes keep failing where a computed one got through. Consider rebuilding its routes, or moving it or a repeater.`
        : reads > 0
          ? `auto-ping: node ${nodeId} did not answer ${pl(tries, 'ping')} or ${pl(reads, 'routed read')} — giving up. ` +
            `That means it ignored ${pl(tries, 'NOP frame')} and ${pl(reads, 'single-attempt Get')} that could auto-route, NOT that it is unreachable: ` +
            `try OPERATING the device (a command gets up to 3 send attempts), then check its power, then consider rebuilding its routes.`
          : `auto-ping: node ${nodeId} did not answer ${pl(tries, 'ping')} — giving up. ` +
            `That means it ignored ${pl(tries, 'NOP frame')}, NOT that it is unreachable: ` +
            `try OPERATING the device (a real command often lands when pings do not), then a manual ping, then check its power.`;
      o.log('error', nodeId, m);
      (o.log2?.error ?? o.log2)?.(m);
    }

    /* ── did the earlier probes actually land? (v0.36) ────────────────────
     * The one honest answer available: did the node's lastSeen move past the
     * moment we probed it. An unanswered probe is the signal auto-ping exists
     * to produce, and until now it could not be observed at all.
     */
    // A probe still unanswered when the controller's receiver went off cannot
    // be answered: the radio is not listening. Judging it would book a miss the
    // blackout caused, and a sweep miss kills a node (v0.65.0). Drop those
    // probes instead — no credit, no miss, no streak.
    const rfOff = o.rfOffSince?.() ?? null;
    if (rfOff != null) {
      const dropped = dropBlackoutProbes(state, nodes, rfOff);
      if (dropped > 0 && lastRfOffLogged !== rfOff) {
        lastRfOffLogged = rfOff;
        const m = `auto-ping: controller receiver off — ${dropped} in-flight probe(s) dropped unjudged (an unanswered frame here is the radio, not the node)`;
        o.log('info', null, m);
        o.log2?.(m);
      }
    } else if (lastRfOffLogged !== null) {
      lastRfOffLogged = null;
    }
    for (const { nodeId, answered, misses, cls, lane, frame } of judgeProbeAnswers(state, nodes, t)) {
      // An unanswered LADDER ping earns one routed read (v0.70.0). Only the dead
      // lane: sweep and verification probes target live nodes, and a miss there
      // hands the node to the ladder, whose own ping comes first.
      if (lane === 'dead' && !answered) state.readOwed.add(nodeId);
      if (lane === 'read') {
        const ownKill = state.readAfterOwnKill.delete(nodeId);
        if (answered && ownKill) {
          // A death on our own measurement probe (v0.71.0): bounded by the hold
          // and counted in `probeKills`, so it does not spend the cap below.
          const m = `auto-ping: node ${nodeId} answered our routed read after its ping went unanswered — ` +
            `its stored routes are suspect (the controller found another); it went Dead on our own probe, so this ` +
            `revival does not count against the ${READ_REVIVAL_CAP}-per-24 h read cap`;
          o.log('info', nodeId, m);
          o.log2?.(m);
        } else if (answered) {
          const revivals = [...(state.readRevivals.get(nodeId) ?? []).filter((at) => t - at < READ_REVIVAL_WINDOW_MS), t];
          state.readRevivals.set(nodeId, revivals);
          const m = `auto-ping: node ${nodeId} answered our routed read after its ping went unanswered — ` +
            `its stored routes are suspect (the controller found another)`;
          o.log('info', nodeId, m);
          o.log2?.(m);
          if (revivals.length === READ_REVIVAL_CAP) {
            const w = `auto-ping: node ${nodeId} has now been revived by a routed read ${revivals.length} times in 24 h ` +
              `after its ladder pings went unanswered — its stored routes keep failing. Further routed reads are withheld ` +
              `for the rest of the window, so its next death ends in a summons; consider rebuilding its routes.`;
            o.log('warn', nodeId, w);
            (o.log2?.warn ?? o.log2)?.(w);
          }
        } else {
          const m = `auto-ping: node ${nodeId} did NOT answer our routed read (${ordinal(misses)} consecutive miss, lastSeen did not advance)`;
          // Same first-miss-is-information rule as a ping miss (v0.36.5).
          const streak = misses >= 2;
          o.log(streak ? 'warn' : 'info', nodeId, m);
          (streak ? (o.log2?.warn ?? o.log2) : o.log2)?.(m);
        }
        continue;
      }
      // The expected case stays at debug — one line per probe on every healthy
      // node is several hundred a day saying "as designed", which is the noise
      // that trains an operator to stop reading. The UNANSWERED case below is
      // the signal, and it is warn on both destinations.
      if (answered) {
        // Only the fixed-cadence sweep feeds the persisted reply rate (v0.40.2).
        if (lane === 'sweep') o.onProbeResult?.(nodeId, true, cls, frame);
        o.log2?.debug?.(`auto-ping: node ${nodeId} answered its probe`);
        continue;
      }
      // A FIRST miss is information; a streak is a warning. Measured on the live
      // mesh, healthy nodes drop some probes to ordinary transient loss (about
      // 2 % of NoOps in v0.36.5's sample; 0.24 % — 2 of 817 — in v0.71.0's),
      // so warning on every one of those would put a steady drip of false alarm
      // beside the genuine article and teach an operator to skim past both. The
      // count is in the text either way — this suppresses nothing, it only
      // stops calling a single lost packet a warning.
      if (lane === 'sweep') o.onProbeResult?.(nodeId, false, cls, frame);
      const ord = ordinal(misses);
      const m = `auto-ping: node ${nodeId} did NOT answer its probe ` +
        `(${ord} consecutive miss, lastSeen did not advance)` + probeWord(lane, frame);
      o.log(misses >= 2 ? 'warn' : 'info', nodeId, m);
      (misses >= 2 ? (o.log2?.warn ?? o.log2) : o.log2)?.(m);
    }
  };

  const snapshot = (): AutoPingSnapshot => {
    const ids = new Set<number>([
      ...state.deadSince.keys(), ...state.attempts.keys(), ...state.missStreak.keys(),
      ...state.launchFailures.keys(), ...state.awaitingAnswer.keys(), ...state.gaveUpAnnounced,
      ...state.launchGaveUpAnnounced, ...state.talkingAnnounced, ...state.readOwed, ...state.reads.keys(),
      ...state.probeHoldFrom.keys(), ...state.probeKills.keys(),
    ]);
    const nodes: AutoPingNodeState[] = [...ids].sort((a, b) => a - b).map((nodeId) => {
      const attempts = state.attempts.get(nodeId) ?? 0;
      const last = state.lastPingAt.get(nodeId);
      // Mirrors the ladder's own arithmetic (see decideAutoPings) rather than
      // re-deriving it: a screen that disagrees with the engine about when the
      // next probe is due would be worse than no screen.
      const wait = BACKOFF_MS[Math.max(0, Math.min(attempts - 1, BACKOFF_MS.length - 1))];
      return {
        nodeId,
        deadSinceMs: state.deadSince.get(nodeId) ?? null,
        attempts,
        nextEligibleMs: last == null ? null : last + wait,
        missStreak: state.missStreak.get(nodeId) ?? 0,
        launchFailures: state.launchFailures.get(nodeId) ?? 0,
        pending: state.awaitingAnswer.get(nodeId)?.length ?? 0,
        gaveUp: state.gaveUpAnnounced.has(nodeId),
        launchGaveUp: state.launchGaveUpAnnounced.has(nodeId),
        talkingWhileDead: state.talkingAnnounced.has(nodeId),
        reads: state.reads.get(nodeId) ?? 0,
        readOwed: state.readOwed.has(nodeId),
        readRevivals24h: lastTickMs == null ? 0 : readRevivalsWithin(state, nodeId, lastTickMs),
        probeKills24h: lastTickMs == null ? 0 : probeKillsWithin(state, nodeId, lastTickMs),
        probeHeldUntilMs: lastTickMs != null && inProbeHold(state, nodeId, lastTickMs)
          ? state.probeHoldFrom.get(nodeId)! + PROBE_KILL_HOLD_MS : null,
      };
    });
    return {
      lastTickMs,
      suppressed: lastDecision?.suppressed ?? 'none',
      listening: lastDecision?.listening ?? 0,
      deadListening: lastDecision?.deadListening ?? 0,
      capabilityUnknown: lastDecision?.capabilityUnknown ?? 0,
      // A suppressed pass returns before the sweep/verify queues are read, so
      // their fields are structural zeros, not counts. Say "not computed".
      staleDue: lastDecision == null || lastDecision.suppressed !== 'none' ? null : lastDecision.staleDue,
      stalestMs: lastDecision?.stalestMs ?? null,
      verifyOwed: lastDecision == null || lastDecision.suppressed !== 'none' ? null : lastDecision.verifyOwed,
      config: o.config,
      nodes,
    };
  };

  const timer = setInterval(tick, o.tickMs ?? 60_000);
  // Node keeps the process alive for a bare interval; this one must not.
  if (typeof timer.unref === 'function') timer.unref();
  // `tick` is exposed so a test can drive the runner deterministically instead
  // of racing a timer. A first version of the runner test stopped the handle
  // before the interval could fire and then asserted nothing had been pinged —
  // which was true, and proved nothing.
  /**
   * Register a probe this module did not send (v0.47.0), so the answer-judging
   * machinery applies to it.
   *
   * Deliberately NOT routed into `onProbeResult`: the `lane === 'sweep'` gates
   * below are load-bearing. A manual ping already reaches the ledger's ACTION
   * arm through the runner's `learn: true`, so feeding it here too would
   * double-attribute it — and it would reintroduce the symptom-correlated skew
   * v0.40.2 removed, since an operator pings exactly the nodes they suspect.
   * Its only effects are the answered/unanswered log line and the miss streak.
   *
   * `at` is when the caller LAUNCHED the probe (v0.64.5), read from the clock
   * this runner judges with — both are `Date.now` in production. The manual
   * path can only register once Home Assistant's call has returned. HA's ping
   * button starts the driver's ping in the background and returns, so the
   * node's answer and HA's reply race, and when the answer wins it is already
   * on record. Stamped at `now()` instead, the entry post-dated that answer and
   * `lastSeen >= at` judged an answered ping a miss. Omitted, it is `now()`.
   */
  const notePending = (nodeId: number, lane: ProbeLane = 'manual', at?: number): void => {
    pendProbe(state, nodeId, at ?? now(), lane);
  };

  return { stop: () => clearInterval(timer), tick, snapshot, notePending };
}
