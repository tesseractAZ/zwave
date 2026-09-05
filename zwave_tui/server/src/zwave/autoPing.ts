/**
 * Auto-ping — the engine's FIRST autonomous write.
 *
 * Everything else this engine does is advisory: it detects, it explains, it
 * recommends, and a human presses the key. This module breaks that rule on
 * purpose and narrowly, so the rule stays meaningful everywhere else.
 *
 * Why ping, and only ping. It is already the one action the TUI runs WITHOUT a
 * typed CONFIRM, because it is idempotent and has nothing to undo: a ping to a
 * live node is a no-op, and a ping to a dead one is a probe. Nothing here can
 * remove a node, rewrite a route, or change a device's configuration.
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
   * Probe a MAINS node this long after its own last contact (0 = off).
   *
   * Measured from each node's `lastSeen`, so it is self-balancing: a device that
   * reports on its own keeps resetting the clock and is never probed, while a
   * silent one is checked on a fixed cadence. On the live mesh 10 of 38 nodes
   * had been silent for 35.7 HOURS while all reporting Alive.
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
  /** nodeId → epoch ms of the last STALE (liveness) probe. */
  lastStaleAt: Map<number, number>;
  /**
   * nodeId → epoch ms of a probe whose ANSWER has not been checked yet (v0.36).
   *
   * The ping verb is an HA `button.press` service call, and HA's zwave_js ping
   * button awaits `node.async_ping()`, which returns a boolean and raises
   * nothing when the node stays silent. So the promise resolves either way and
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
  awaitingAnswer: Map<number, { at: number; cls: ProbeClass; lane: ProbeLane }[]>;
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
export type ProbeLane = 'sweep' | 'dead' | 'verify' | 'manual';

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
export function pendProbe(state: AutoPingState, nodeId: number, t: number, lane: ProbeLane, cls: ProbeClass = 'unheard'): void {
  const pending = state.awaitingAnswer.get(nodeId);
  if (pending) pending.push({ at: t, cls, lane });
  else state.awaitingAnswer.set(nodeId, [{ at: t, cls, lane }]);
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
    () => failed('no ping entity or transport error'),
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
 *  A ping is a round trip plus a stats push; 90 s is generous for a routed
 *  mesh hop and still well inside one tick of slack. */
const ANSWER_GRACE_MS = 90_000;

export function createAutoPingState(): AutoPingState {
  return { attempts: new Map(), lastPingAt: new Map(), deadSince: new Map(), lastStaleAt: new Map(), awaitingAnswer: new Map(), lastProbeSeen: new Map(), gaveUpAnnounced: new Set(), missStreak: new Map(), lastVerifyAt: new Map(), launchFailures: new Map(), launchGaveUpAnnounced: new Set(), talkingAnnounced: new Set() };
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
}

export interface AutoPingDecision {
  /** Dead nodes to probe on this tick (remediation). */
  ping: number[];
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
  const base = { ping: [] as number[], stale: [] as number[], verify: [] as number[], verifyFirst: [] as number[], verifyOwed: 0, gaveUp: [] as number[], launchGaveUp: [] as number[], talkingWhileDead: [] as number[],
    deadListening: dead.length, capabilityUnknown,
    listening: listeningNodes.length, staleDue: 0, stalestMs: null as number | null };

  if (!config.enabled) return { ...base, suppressed: 'disabled' };
  // Auto-ping is a write. It obeys the master switch even when its own is on —
  // otherwise "write actions off" would be a false statement about the add-on.
  if (!config.writeActions) return { ...base, suppressed: 'write-actions-off' };
  // Right after start every node reads Dead until the first roster poll lands.
  // Without this the engine would ping the entire mesh on every restart.
  if (booting) return { ...base, suppressed: 'boot-window' };
  // A rebuild is already rewriting routes; nodes drop in and out by design.
  if (controller?.isRebuildingRoutes) return { ...base, suppressed: 'rebuilding-routes' };

  // A PASS OVER AN EMPTY POPULATION IS NOT AN ALL-CLEAR (v0.52.0). With the
  // driver-WS link dark the engine reported `running · candidates 0 · dead 0 ·
  // no node is in a dead episode` while the roster held six Dead nodes — the
  // ladder cannot arm, and the screen said so in the words it uses for health.
  // Predicated on the UNKNOWN count, not on emptiness: an all-battery mesh has
  // capability data and is genuinely nothing to sweep.
  if (listeningNodes.length === 0 && capabilityUnknown > 0) {
    return { ...base, suppressed: 'no-capability-data' };
  }

  const stormLimit = Math.max(STORM_MIN_NODES, Math.ceil(listeningNodes.length * STORM_FRACTION));
  if (dead.length >= stormLimit) return { ...base, suppressed: 'storm' };

  const ping: number[] = [];
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
    if (heard != null && now - heard < config.afterMs) {
      talkingWhileDead.push(n.nodeId);
      continue;
    }
    const started = input.state.deadSince.get(n.nodeId);
    if (started == null || now - started < config.afterMs) continue;
    const tries = input.state.attempts.get(n.nodeId) ?? 0;
    // Launches that never left have their own budget; exhausting it is an
    // add-on-side fault, announced separately (v0.40.2).
    if ((input.state.launchFailures.get(n.nodeId) ?? 0) >= config.maxAttempts) {
      if (!input.state.launchGaveUpAnnounced.has(n.nodeId)) launchGaveUp.push(n.nodeId);
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
  // Resolved HERE, past every suppressor, so a gated tick never spends the
  // ledger's budget on a probe it is not going to send.
  const verifyEntries = (input.verifyDue?.() ?? []).filter((e) => candidates.has(e.id));
  const verify = verifyEntries.map((e) => e.id);
  const verifyFirst = verifyEntries.filter((e) => e.first).map((e) => e.id);
  base.verifyOwed = input.verifyOwedCount?.() ?? verify.length;

  // One measurement probe per node per tick (v0.40 review): a node owed a
  // verification probe this tick is dropped from the sweep — the verify probe
  // is the same NoOp ping and satisfies the sweep's question, while twin
  // same-tick probes shared one `at`, let a transport failure on one lane
  // withdraw the OTHER lane's pending entry, and double-counted one silent
  // instant as two consecutive misses. The node stays due (lastStaleAt is not
  // advanced), so its sweep runs on the next tick if it still owes nothing.
  const verifySet = new Set(verify);
  const staleDeduped = stale.filter((id) => !verifySet.has(id));

  return { ...base, ping, stale: staleDeduped, verify, verifyFirst, gaveUp, launchGaveUp, talkingWhileDead, suppressed: 'none' };
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
): { nodeId: number; answered: boolean; misses: number; cls: ProbeClass; lane: ProbeLane }[] {
  const seenOf = new Map<number, number | null>();
  for (const n of nodes) seenOf.set(n.nodeId, n.stats?.lastSeen ?? null);
  const out: { nodeId: number; answered: boolean; misses: number; cls: ProbeClass; lane: ProbeLane }[] = [];
  for (const [nodeId, pending] of [...state.awaitingAnswer]) {
    // Judge EVERY matured probe, oldest first (v0.40) — the entries are
    // appended chronologically, and a burst leaves several in flight at once.
    const mature = pending.filter((p) => now - p.at >= graceMs);
    if (mature.length === 0) continue;
    const young = pending.filter((p) => now - p.at < graceMs);
    if (young.length > 0) state.awaitingAnswer.set(nodeId, young);
    else state.awaitingAnswer.delete(nodeId);
    // A node absent from the roster cannot be judged either way — say nothing
    // rather than call a roster gap a failed probe.
    if (!seenOf.has(nodeId)) continue;
    const seen = seenOf.get(nodeId) ?? null;
    for (const { at, cls, lane } of mature) {
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
      out.push({ nodeId, answered, misses, cls, lane });
    }
  }
  return out;
}

/**
 * Fold the current roster into the episode bookkeeping.
 *
 * A node leaving Dead ENDS its episode and clears its attempt count, so a device
 * that dies again next week gets a fresh budget rather than inheriting an
 * exhausted one. Call once per tick, before deciding.
 */
export function trackEpisodes(state: AutoPingState, nodes: NodeSnapshot[], now: number): void {
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
        const lastHeard = n.stats?.lastSeen ?? null;
        state.deadSince.set(n.nodeId, lastHeard != null && lastHeard < now ? lastHeard : now);
      }
    } else {
      state.deadSince.delete(n.nodeId);
      state.attempts.delete(n.nodeId);
      state.lastPingAt.delete(n.nodeId);
      // Recovery ends the outage, so a device that dies again is announced
      // again rather than being silently remembered as already-reported.
      state.gaveUpAnnounced.delete(n.nodeId);
      state.launchFailures.delete(n.nodeId);
      state.launchGaveUpAnnounced.delete(n.nodeId);
      state.talkingAnnounced.delete(n.nodeId);
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
 *  it. */
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
   *  the learning verb, because there the ping genuinely IS the treatment. */
  probe?: (nodeId: number) => Promise<unknown>;
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
   *  without it the runner behaves exactly as it did before. */
  verifyRequests?: (now: number) => { id: number; first: boolean }[];
  /** Nodes with an outstanding verification burst, for the probe line (v0.37.1). */
  verifyOwedCount?: () => number;
  /** One liveness-probe outcome, for the persisted per-node reply rate (v0.37).
   *  `selfProven` = the node had already communicated on its own since the
   *  previous sweep, so the probe was confirming rather than discovering. */
  /** `cls` is the FOUR-way verdict (v0.49.0), not a self-proven boolean — the
   *  other three arms were computed and discarded on every tick. */
  onProbeResult?: (nodeId: number, answered: boolean, cls: ProbeClass) => void;
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
}

export function startAutoPing(o: AutoPingRunnerOptions): {
  stop: () => void;
  tick: () => void;
  snapshot: () => AutoPingSnapshot;
  notePending: (nodeId: number, lane?: ProbeLane) => void;
} {
  const now = o.now ?? (() => Date.now());
  const startedAt = now();
  const state = createAutoPingState();
  // Kept for `snapshot()` — the runtime state an operator cannot otherwise see.
  let lastDecision: AutoPingDecision | null = null;
  let lastTickMs: number | null = null;
  let lastSuppression: AutoPingSuppression | null = null;
  let lastTrace = '';
  let lastTraceAt = 0;

  const tick = (): void => {
    const t = now();
    const nodes = o.nodes();
    trackEpisodes(state, nodes, t);
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
      verifyDue: () => o.verifyRequests?.(t) ?? [],
      verifyOwedCount: () => o.verifyOwedCount?.() ?? 0,
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
        ? `probing ${decision.ping.length + decision.stale.length}`
        : 'suppressed: ' + decision.suppressed}`;
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
      `${decision.ping.length + decision.stale.length > 0}`;
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
      // Unknown attribution is NOT self-proven: an unbacked credit is worse
      // than a missing one, and it persists (v0.40.2).
      const selfProven = heardRecently && spokeOnItsOwn && attributed != null;
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
      const attributionUnknown = attributed == null && heardRecently;
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
          ? `(heard ${silence} ago, but this run has no probe attribution yet — not credited)`
          : selfProven
            ? `(already heard ${silence} ago on its own — confirming)`
            : echoOnly
              ? `(nothing heard past our last probe's answer ${silence} ago — probing for its own voice)`
              : `(unheard for ${silence}, threshold ${Math.round(o.config.staleMs / 60_000)}m)`);
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
      // stays silent, so the answer is judged from evidence a moment later
      // (judgeProbeAnswers). The catch here is left for what it can actually
      // catch: no ping button, or a WS transport fault.
      //
      // MEASUREMENT lane: the non-learning probe (v0.38.1). With the learning
      // verb, every sweep stamped `ping` onto any open episode and the control
      // arm could never accrue — the instrument was the recorded treatment.
      // `noteStale` above booked the cadence clock; a launch that never left
      // must give it back too, or the node waits a full staleMs having never
      // been asked (v0.40.2).
      pendProbe(state, nodeId, t, 'sweep', cls);
      settleProbe(o, state, nodeId, t, (o.probe ?? o.ping)(nodeId), () => {
        if (priorStale == null) state.lastStaleAt.delete(nodeId);
        else state.lastStaleAt.set(nodeId, priorStale);
      });
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
      const msg = `auto-ping: node ${nodeId} has been Dead past the dwell — ` +
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
      const sinceMs = prevVerify == null ? null : t - prevVerify;
      state.lastVerifyAt.set(nodeId, t);
      const gap = decision.verifyFirst.includes(nodeId) || sinceMs == null
        ? 'burst start'
        : `+${Math.round(sinceMs / 1000)}s`;
      const msg = `auto-ping: node ${nodeId} verification probe (episode evidence, ${gap}, ${decision.verifyOwed} owed)`;
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // MEASUREMENT lane too (v0.38.1) — a verification probe exists to fill
      // the evidence window, and recording it as the remediation would make
      // the verdict about the measurement rather than the recovery.
      const priorVerify = state.lastVerifyAt.get(nodeId);
      pendProbe(state, nodeId, t, 'verify');
      settleProbe(o, state, nodeId, t, (o.probe ?? o.ping)(nodeId), () => {
        if (priorVerify == null) state.lastVerifyAt.delete(nodeId);
        else state.lastVerifyAt.set(nodeId, priorVerify);
      });
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
      const m = `auto-ping: node ${nodeId} did not answer ${tries} ping${tries === 1 ? '' : 's'} — giving up. ` +
        `That means it ignored ${tries} NOP frame${tries === 1 ? '' : 's'}, NOT that it is unreachable: ` +
        `try OPERATING the device (a real command often lands when pings do not), then a manual ping, then check its power.`;
      o.log('error', nodeId, m);
      (o.log2?.error ?? o.log2)?.(m);
    }

    /* ── did the earlier probes actually land? (v0.36) ────────────────────
     * The one honest answer available: did the node's lastSeen move past the
     * moment we probed it. An unanswered probe is the signal auto-ping exists
     * to produce, and until now it could not be observed at all.
     */
    for (const { nodeId, answered, misses, cls, lane } of judgeProbeAnswers(state, nodes, t)) {
      // The expected case stays at debug — one line per probe on every healthy
      // node is several hundred a day saying "as designed", which is the noise
      // that trains an operator to stop reading. The UNANSWERED case below is
      // the signal, and it is warn on both destinations.
      if (answered) {
        // Only the fixed-cadence sweep feeds the persisted reply rate (v0.40.2).
        if (lane === 'sweep') o.onProbeResult?.(nodeId, true, cls);
        o.log2?.debug?.(`auto-ping: node ${nodeId} answered its probe`);
        continue;
      }
      // A FIRST miss is information; a streak is a warning. Measured on the live
      // mesh, healthy nodes drop about 2% of probes to ordinary transient loss,
      // so warning on every one of those would put a steady drip of false alarm
      // beside the genuine article and teach an operator to skim past both. The
      // count is in the text either way — this suppresses nothing, it only
      // stops calling a single lost packet a warning.
      if (lane === 'sweep') o.onProbeResult?.(nodeId, false, cls);
      const ord = ordinal(misses);
      const m = `auto-ping: node ${nodeId} did NOT answer its probe ` +
        `(${ord} consecutive miss, lastSeen did not advance)`;
      o.log(misses >= 2 ? 'warn' : 'info', nodeId, m);
      (misses >= 2 ? (o.log2?.warn ?? o.log2) : o.log2)?.(m);
    }
  };

  const snapshot = (): AutoPingSnapshot => {
    const ids = new Set<number>([
      ...state.deadSince.keys(), ...state.attempts.keys(), ...state.missStreak.keys(),
      ...state.launchFailures.keys(), ...state.awaitingAnswer.keys(), ...state.gaveUpAnnounced,
      ...state.launchGaveUpAnnounced, ...state.talkingAnnounced,
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
   */
  const notePending = (nodeId: number, lane: ProbeLane = 'manual'): void => {
    pendProbe(state, nodeId, now(), lane);
  };

  return { stop: () => clearInterval(timer), tick, snapshot, notePending };
}
