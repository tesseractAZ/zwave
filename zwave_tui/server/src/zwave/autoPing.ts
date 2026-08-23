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
   */
  awaitingAnswer: Map<number, number>;
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
}

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

/** How long to wait before judging whether a probe was answered (v0.36).
 *  A ping is a round trip plus a stats push; 90 s is generous for a routed
 *  mesh hop and still well inside one tick of slack. */
const ANSWER_GRACE_MS = 90_000;

export function createAutoPingState(): AutoPingState {
  return { attempts: new Map(), lastPingAt: new Map(), deadSince: new Map(), lastStaleAt: new Map(), awaitingAnswer: new Map(), gaveUpAnnounced: new Set(), missStreak: new Map() };
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
  verifyDue?: () => number[];
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
  /** Why nothing was pinged (or 'none' when the gates all passed). */
  suppressed: AutoPingSuppression;
  /** Listening nodes currently Dead — the storm-guard numerator. */
  deadListening: number;
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
  const base = { ping: [] as number[], stale: [] as number[], verify: [] as number[], gaveUp: [] as number[],
    deadListening: dead.length,
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

  const stormLimit = Math.max(STORM_MIN_NODES, Math.ceil(listeningNodes.length * STORM_FRACTION));
  if (dead.length >= stormLimit) return { ...base, suppressed: 'storm' };

  const ping: number[] = [];
  const gaveUp: number[] = [];
  for (const n of dead) {
    const started = input.state.deadSince.get(n.nodeId);
    if (started == null || now - started < config.afterMs) continue;
    const tries = input.state.attempts.get(n.nodeId) ?? 0;
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
    const wait = BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)];
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
      // A node with no lastSeen yet has never been heard from at all, which is
      // the strongest reason to ask — treat it as maximally stale.
      .filter((x) => x.seen == null || now - x.seen >= config.staleMs)
      // One probe per node per staleMs. Without this a genuinely unreachable
      // node never refreshes lastSeen, stays permanently "due", and would be
      // re-probed on EVERY tick.
      .filter((x) => {
        const last = input.state.lastStaleAt.get(x.id);
        return last == null || now - last >= config.staleMs;
      })
      .sort((a, b) => (a.seen ?? 0) - (b.seen ?? 0)); // stalest first
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
  const verify = (input.verifyDue?.() ?? []).filter((id) => candidates.has(id));

  return { ...base, ping, stale, verify, gaveUp, suppressed: 'none' };
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
): { nodeId: number; answered: boolean; misses: number }[] {
  const seenOf = new Map<number, number | null>();
  for (const n of nodes) seenOf.set(n.nodeId, n.stats?.lastSeen ?? null);
  const out: { nodeId: number; answered: boolean; misses: number }[] = [];
  for (const [nodeId, at] of [...state.awaitingAnswer]) {
    if (now - at < graceMs) continue;
    state.awaitingAnswer.delete(nodeId);
    // A node absent from the roster cannot be judged either way — say nothing
    // rather than call a roster gap a failed probe.
    if (!seenOf.has(nodeId)) continue;
    const seen = seenOf.get(nodeId) ?? null;
    const answered = seen != null && seen >= at;
    // The streak is CONSECUTIVE: one answer resets it, so "3rd miss" always
    // means three in a row rather than three since the beginning of time.
    const misses = answered ? 0 : (state.missStreak.get(nodeId) ?? 0) + 1;
    if (answered) state.missStreak.delete(nodeId);
    else state.missStreak.set(nodeId, misses);
    out.push({ nodeId, answered, misses });
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
      if (!state.deadSince.has(n.nodeId)) state.deadSince.set(n.nodeId, now);
    } else {
      state.deadSince.delete(n.nodeId);
      state.attempts.delete(n.nodeId);
      state.lastPingAt.delete(n.nodeId);
      // Recovery ends the outage, so a device that dies again is announced
      // again rather than being silently remembered as already-reported.
      state.gaveUpAnnounced.delete(n.nodeId);
    }
  }
  // A node that vanished from the roster (removed/excluded) must not leak its
  // bookkeeping forever.
  for (const id of [...state.deadSince.keys()]) if (!seen.has(id)) state.deadSince.delete(id);
  for (const id of [...state.attempts.keys()]) if (!seen.has(id)) state.attempts.delete(id);
  for (const id of [...state.lastPingAt.keys()]) if (!seen.has(id)) state.lastPingAt.delete(id);
  for (const id of [...state.lastStaleAt.keys()]) if (!seen.has(id)) state.lastStaleAt.delete(id);
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
  log2?: ((msg: string) => void) & { debug?: (msg: string) => void };
  config: AutoPingConfig;
  tickMs?: number;
  now?: () => number;
  /** Drain the outcome ledger's pending verification probes (v0.36). Optional:
   *  without it the runner behaves exactly as it did before. */
  verifyRequests?: (now: number) => number[];
}

export function startAutoPing(o: AutoPingRunnerOptions): { stop: () => void; tick: () => void } {
  const now = o.now ?? (() => Date.now());
  const startedAt = now();
  const state = createAutoPingState();
  let lastSuppression: AutoPingSuppression | null = null;
  let lastTrace = '';
  let lastTraceAt = 0;

  const tick = (): void => {
    const t = now();
    const nodes = o.nodes();
    trackEpisodes(state, nodes, t);
    const decision = decideAutoPings({
      now: t,
      state,
      nodes,
      controller: o.controller(),
      config: o.config,
      // Not ready == no trustworthy roster yet, which is the same hazard as the
      // post-start window, so it counts as booting rather than as "no nodes".
      booting: !o.ready() || t - startedAt < BOOT_WINDOW_MS,
      verifyDue: () => o.verifyRequests?.(t) ?? [],
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
    const changed = trace !== lastTrace;
    if (changed || t - lastTraceAt >= TRACE_HEARTBEAT_MS) {
      o.log('info', null, trace);
      o.log2?.(trace);
      lastTrace = trace;
      lastTraceAt = t;
    }

    // A storm is the one suppression worth saying out loud, and worth saying
    // ONCE — it means a quarter of the mesh is down, which the operator wants to
    // know about even though the engine is deliberately doing nothing.
    if (decision.suppressed === 'storm' && lastSuppression !== 'storm') {
      o.log('warn', null,
        `auto-ping suppressed: ${decision.deadListening}/${decision.listening} mains nodes are Dead — ` +
        'that is a controller-level event, not per-device, so probing them would only add traffic');
    }
    lastSuppression = decision.suppressed;

    for (const nodeId of decision.stale) {
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
      const msg = `auto-ping: node ${nodeId} unheard for ${silence} ` +
        `(threshold ${Math.round(o.config.staleMs / 60_000)}m) — liveness probe`;
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // The service call resolving proves only that HA ACCEPTED the request —
      // its ping button returns a boolean and raises nothing when the node
      // stays silent, so the answer is judged from evidence a moment later
      // (judgeProbeAnswers). The catch here is left for what it can actually
      // catch: no ping button, or a WS transport fault.
      state.awaitingAnswer.set(nodeId, t);
      void o.ping(nodeId).catch(() => {
        state.awaitingAnswer.delete(nodeId);
        const m = `auto-ping: node ${nodeId} could not be probed (no ping entity or transport error)`;
        o.log('warn', nodeId, m); o.log2?.(m);
      });
    }

    for (const nodeId of decision.ping) {
      const attempt = (state.attempts.get(nodeId) ?? 0) + 1;
      noteAttempt(state, nodeId, t);
      const msg = `auto-ping: node ${nodeId} has been Dead past the dwell — ` +
        `probing (attempt ${attempt}/${o.config.maxAttempts})`;
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      // Fire and forget: the ping runner records its own outcome into the M5
      // ledger, and a failed probe is information, not an error to escalate.
      state.awaitingAnswer.set(nodeId, t);
      void o.ping(nodeId).catch(() => {
        state.awaitingAnswer.delete(nodeId);
        const m = `auto-ping: node ${nodeId} could not be probed (no ping entity or transport error)`;
        o.log('warn', nodeId, m); o.log2?.(m);
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
      const msg = `auto-ping: node ${nodeId} verification probe (episode evidence)`;
      o.log('info', nodeId, msg);
      o.log2?.(msg);
      state.awaitingAnswer.set(nodeId, t);
      void o.ping(nodeId).catch(() => {
          state.awaitingAnswer.delete(nodeId);
          const m = `auto-ping: node ${nodeId} could not be probed (no ping entity or transport error)`;
          o.log('warn', nodeId, m); o.log2?.(m);
        });
    }

    /* ── nodes the engine has given up on (v0.36.4) ──────────────────────
     * maxAttempts means "stop and leave it to a human", and for four releases
     * it did the stopping without the leaving-it-to-a-human. ERROR severity on
     * both destinations: this is the one auto-ping message that asks for
     * action rather than reporting activity.
     */
    for (const nodeId of decision.gaveUp) {
      state.gaveUpAnnounced.add(nodeId);
      const m = `auto-ping: node ${nodeId} is STILL DEAD after ${o.config.maxAttempts} attempts — ` +
        `giving up, this one needs a human (try a manual ping first; it often works when the ladder has expired)`;
      o.log('error', nodeId, m);
      o.log2?.(m);
    }

    /* ── did the earlier probes actually land? (v0.36) ────────────────────
     * The one honest answer available: did the node's lastSeen move past the
     * moment we probed it. An unanswered probe is the signal auto-ping exists
     * to produce, and until now it could not be observed at all.
     */
    for (const { nodeId, answered, misses } of judgeProbeAnswers(state, nodes, t)) {
      // The expected case stays at debug — one line per probe on every healthy
      // node is several hundred a day saying "as designed", which is the noise
      // that trains an operator to stop reading. The UNANSWERED case below is
      // the signal, and it is warn on both destinations.
      if (answered) { o.log2?.debug?.(`auto-ping: node ${nodeId} answered its probe`); continue; }
      // A FIRST miss is information; a streak is a warning. Measured on the live
      // mesh, healthy nodes drop about 2% of probes to ordinary transient loss,
      // so warning on every one of those would put a steady drip of false alarm
      // beside the genuine article and teach an operator to skim past both. The
      // count is in the text either way — this suppresses nothing, it only
      // stops calling a single lost packet a warning.
      const ord = ordinal(misses);
      const m = `auto-ping: node ${nodeId} did NOT answer its probe ` +
        `(${ord} consecutive miss, lastSeen did not advance)`;
      o.log(misses >= 2 ? 'warn' : 'info', nodeId, m);
      o.log2?.(m);
    }
  };

  const timer = setInterval(tick, o.tickMs ?? 60_000);
  // Node keeps the process alive for a bare interval; this one must not.
  if (typeof timer.unref === 'function') timer.unref();
  // `tick` is exposed so a test can drive the runner deterministically instead
  // of racing a timer. A first version of the runner test stopped the handle
  // before the interval could fire and then asserted nothing had been pinged —
  // which was true, and proved nothing.
  return { stop: () => clearInterval(timer), tick };
}
