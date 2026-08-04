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
}

export function createAutoPingState(): AutoPingState {
  return { attempts: new Map(), lastPingAt: new Map(), deadSince: new Map(), lastStaleAt: new Map() };
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
  /** Why nothing was pinged (or 'none' when the gates all passed). */
  suppressed: AutoPingSuppression;
  /** Listening nodes currently Dead — the storm-guard numerator. */
  deadListening: number;
  /** Listening nodes total — the storm-guard denominator. */
  listening: number;
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
  const base = { ping: [] as number[], stale: [] as number[], deadListening: dead.length, listening: listeningNodes.length };

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
  for (const n of dead) {
    const started = input.state.deadSince.get(n.nodeId);
    if (started == null || now - started < config.afterMs) continue;
    const tries = input.state.attempts.get(n.nodeId) ?? 0;
    if (tries >= config.maxAttempts) continue;
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
  }

  return { ...base, ping, stale, suppressed: 'none' };
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
    }
  }
  // A node that vanished from the roster (removed/excluded) must not leak its
  // bookkeeping forever.
  for (const id of [...state.deadSince.keys()]) if (!seen.has(id)) state.deadSince.delete(id);
  for (const id of [...state.attempts.keys()]) if (!seen.has(id)) state.attempts.delete(id);
  for (const id of [...state.lastPingAt.keys()]) if (!seen.has(id)) state.lastPingAt.delete(id);
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

export interface AutoPingRunnerOptions {
  nodes: () => NodeSnapshot[];
  controller: () => ControllerSnapshot | null;
  ready: () => boolean;
  ping: (nodeId: number) => Promise<unknown>;
  /** Writes into the event ring so an autonomous action is never invisible. */
  log: (severity: 'info' | 'warn' | 'error', nodeId: number | null, text: string) => void;
  config: AutoPingConfig;
  tickMs?: number;
  now?: () => number;
}

export function startAutoPing(o: AutoPingRunnerOptions): { stop: () => void; tick: () => void } {
  const now = o.now ?? (() => Date.now());
  const startedAt = now();
  const state = createAutoPingState();
  let lastSuppression: AutoPingSuppression | null = null;

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
    });

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
      o.log('info', nodeId,
        `auto-ping: node ${nodeId} has not been heard from in ` +
        `${Math.round(o.config.staleMs / 60_000)}m — liveness probe`);
      void o.ping(nodeId).catch(() => {
        // A failed liveness probe is the POINT: the driver marks the node Dead
        // and the remediation path takes over with its own dwell and backoff.
        o.log('warn', nodeId, `auto-ping: node ${nodeId} did not answer its liveness probe`);
      });
    }

    for (const nodeId of decision.ping) {
      const attempt = (state.attempts.get(nodeId) ?? 0) + 1;
      noteAttempt(state, nodeId, t);
      o.log('info', nodeId,
        `auto-ping: node ${nodeId} has been Dead past the dwell — probing (attempt ${attempt}/${o.config.maxAttempts})`);
      // Fire and forget: the ping runner records its own outcome into the M5
      // ledger, and a failed probe is information, not an error to escalate.
      void o.ping(nodeId).catch(() => {
        o.log('warn', nodeId, `auto-ping: node ${nodeId} did not answer the probe`);
      });
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
