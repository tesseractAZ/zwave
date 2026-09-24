/**
 * Publish the ENGINE'S CONCLUSIONS as Home Assistant states.
 *
 * WHY THIS EXISTS. `/api/health` answered one question — "is the transport
 * up?" — so a monitor could see the add-on running while the mesh was on fire:
 * every node Dead, the ladder exhausted, and a 200 OK. Everything the engine
 * concludes lived on a telnet screen behind a login gate, which nothing can
 * poll and nobody watches at 3am.
 *
 * WHY STATES RATHER THAN A BUILT-IN NOTIFIER. The add-on could call
 * `notify.mobile_app_*` directly, and it has the permission to. It does not,
 * because that hardcodes a POLICY — who is told, when, how loudly, whether it
 * bypasses Do Not Disturb — into a diagnostic console. Published as states,
 * every conclusion becomes ordinary HA state, and the operator's existing
 * notification setup, automations, dashboards and history all work on it
 * unchanged. A five-line automation beats a config option nobody can bend.
 *
 * SHAPE. These are "unmanaged" states: created over the REST API, with no
 * device and no unique_id, and they do NOT survive an HA Core restart. That is
 * handled by re-publishing on a cadence rather than by adding an MQTT
 * dependency — the add-on is already a long-running process with a tick, so a
 * Core restart self-heals within one interval. Attributes carry the detail; the
 * state itself is always the ONE number or word an automation triggers on.
 */

import type { DataProvider } from './types';
import { buildRecommendation } from './zwave/recommendation';
import { ROUTE_FAIL_RING } from './zwave/evidenceStore';

// (constants below are re-exported through index.ts's startup banner too)

/** How often the states are re-asserted (also the Core-restart self-heal window). */
export const HA_STATE_PUBLISH_MS = 30_000;

/** A publish that neither answers nor refuses is abandoned after this long, so
 *  a hung Core cannot hold a tick open past the next one (v0.68.0). */
export const HA_STATE_PUBLISH_TIMEOUT_MS = 7_000;

/** The entity ids this add-on owns. Renaming one BREAKS every automation built
 *  on it — treat these as published API, not as internal names. */
export const ENTITY_DEGRADED = 'binary_sensor.zwave_tui_degraded';
export const ENTITY_SUMMONS = 'sensor.zwave_tui_summons';
export const ENTITY_SYMPTOMS = 'sensor.zwave_tui_symptoms';
export const ENTITY_ENGINE = 'sensor.zwave_tui_engine';
export const ENTITY_ROUTE_FAILURES = 'sensor.zwave_tui_route_failures';
/** The one problem that needs a person, and the first thing to try (v0.72.0). */
export const ENTITY_RECOMMENDATION = 'sensor.zwave_tui_recommendation';

/** Route failures are counted over a WEEK (v0.68.0). A 24 h window is non-zero
 *  95 % of the time on the reference mesh and never ranks the chronic link above
 *  one or two, which loses the one thing this data is for: telling an operator
 *  which link to go and look at. The window's length does not change recorder
 *  cost — each event is one change entering it and one leaving. */
export const ROUTE_FAIL_WINDOW_MS = 7 * 86_400_000;
const ROUTE_FAIL_LINKS_MAX = 10;

export interface RouteFailureTally {
  events: number;
  links: { between: [number, number]; failures: number }[];
  linkCount: number;
  nodeIds: number[];
  lastAt: number | null;
  /** A full ring whose oldest entry is still inside the window may already
   *  have evicted older in-window failures: the count is then a floor. */
  lowerBound: boolean;
  /** At least one non-controller node was on the roster. Without one there is
   *  nothing to have counted failures FOR, so zero would not be a reading. */
  rosterLoaded: boolean;
}

/** Route failures in the window, tallied by link. Every value is a pure
 *  function of the events INSIDE the window — no tick time, no ages, no
 *  iteration order — so an unchanged week republishes byte-identically and
 *  costs the recorder nothing (v0.68.0). */
export function routeFailureTally(data: DataProvider, now: number): RouteFailureTally {
  const out: RouteFailureTally = { events: 0, links: [], linkCount: 0, nodeIds: [], lastAt: null, lowerBound: false, rosterLoaded: false };
  if (typeof data.routeFailures !== 'function' || typeof data.nodes !== 'function') return out;
  const byPair = new Map<string, { between: [number, number]; failures: number }>();
  const nodes = new Set<number>();
  for (const n of data.nodes()) {
    if (n.isController) continue;
    out.rosterLoaded = true;
    const ring = data.routeFailures(n.nodeId) ?? [];
    for (const f of ring) {
      if (now - f.t >= ROUTE_FAIL_WINDOW_MS) continue;
      out.events += 1;
      nodes.add(n.nodeId);
      if (out.lastAt == null || f.t > out.lastAt) out.lastAt = f.t;
      const key = `${f.between[0]}>${f.between[1]}`;
      const link = byPair.get(key) ?? { between: [f.between[0], f.between[1]] as [number, number], failures: 0 };
      link.failures += 1;
      byPair.set(key, link);
    }
    if (ring.length >= ROUTE_FAIL_RING && now - Math.min(...ring.map((f) => f.t)) < ROUTE_FAIL_WINDOW_MS) out.lowerBound = true;
  }
  const ranked = [...byPair.values()].sort((a, b) =>
    b.failures - a.failures || a.between[0] - b.between[0] || a.between[1] - b.between[1]);
  out.links = ranked.slice(0, ROUTE_FAIL_LINKS_MAX);
  out.linkCount = ranked.length;
  out.nodeIds = [...nodes].sort((a, b) => a - b);
  return out;
}

export interface HaStatesOptions {
  data: DataProvider;
  /** Base of HA's REST API. Absent (bare dev) ⇒ the publisher no-ops. */
  baseUrl?: string;
  token?: string;
  /** The add-on logger, or any bare sink. `warn` is used when the caller has
   *  one: a publish failure is the one line here that must outlive
   *  `log_level: warning` (v0.66.1). */
  log?: ((msg: string) => void) & { warn?: (msg: string) => void };
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** The master gate (v0.72.0): the recommendation names a verb only when the
   *  operator could run it. */
  writeActions: boolean;
  /** When this add-on started — the recommendation's persistence clock. */
  startedAt?: number;
}

/** What buildStates needs beyond the data (v0.72.0). */
export interface BuildOpts {
  writeActions: boolean;
  startedAt: number;
}

/** One published entity. */
export interface StatePost {
  entity: string;
  state: string;
  attrs: Record<string, unknown>;
}

/**
 * Everything the engine concluded, as the four values an automation triggers
 * on. PURE — the caller does the I/O, so this is testable without a network.
 */
/** The statistics feed is dead once nothing has arrived for this long — the
 *  same threshold the TUI's own stale-feed chip uses (v0.65.0). */
const STATS_FEED_DEAD_MS = 10 * 60_000;

export function buildStates(data: DataProvider, now: number = Date.now(), bo: BuildOpts = { writeActions: false, startedAt: now }): StatePost[] {
  const syms = data.symptoms();
  const crit = syms.filter((s) => s.severity === 'crit').length;
  const warn = syms.filter((s) => s.severity === 'warn').length;
  const ap = data.autoPingState?.() ?? null;
  const eng = data.engineStatus();
  // A held identity decision is degraded by the EXISTING definition — the
  // engine is structurally unable to do its job: it is running with no learned
  // state and cannot resume until a person answers. It is also the only engine
  // condition here that never resolves on its own, which is precisely what an
  // alert is for; everything else eventually clears itself.
  const ident = data.pendingIdentity?.() ?? null;

  // A node the ladder GAVE UP on is the engine's only actual summons: it has
  // spent its whole budget and is asking for a person. Everything else here is
  // advisory, and an alert that fires on advice is an alert nobody reads.
  const summonsNodes = (ap?.nodes ?? [])
    .filter((n) => n.gaveUp || n.launchGaveUp)
    .map((n) => n.nodeId);

  // The engine's own one-word state. `suppressed:<why>` is deliberately NOT
  // collapsed to "off": `storm` and `no-capability-data` mean opposite things
  // to whoever is woken up by this — one is the mesh failing, the other is the
  // add-on unable to see the mesh at all.
  const engineState = ident != null
    ? 'awaiting-identity-decision'
    : !eng.enabled
      ? 'disabled'
    : ap == null
      ? 'no-auto-ping'
      : ap.suppressed === 'none'
        ? 'running'
        : `suppressed:${ap.suppressed}`;

  // DEGRADED is the single boolean worth an automation, and it is deliberately
  // NOT "any symptom exists" — a warn-level symptom on one node is the normal
  // resting state of a real 39-node mesh, and an alert that is always on is not
  // an alert. It fires on: a summons, a critical symptom, or the engine being
  // structurally unable to do its job.
  // THE ENGINE GOING BLIND is the strongest case of "structurally unable to do
  // its job", and it was the one case nothing published. A zwave_js config-entry
  // reload orphans the statistics subscriptions, and in the 2026-09-15 live audit
  // this sensor read `off` for 22 h 48 m while every detector starved and every
  // episode closed `unverifiable` (v0.65.0). Only meaningful once the feed has
  // delivered something: a fresh start has nothing to have gone silent.
  const statsAt = data.lastStatsUpdated?.() ?? null;
  const statsSilentMs = statsAt == null ? null : now - statsAt;
  const statsBlind = statsSilentMs != null && statsSilentMs > STATS_FEED_DEAD_MS;
  const rf = routeFailureTally(data, now);
  // A PAUSE IS NOT SILENCE FOREVER (v0.72.0). While paused nothing is sent, so
  // a mains device that fails without traffic is not noticed — quiet-node fires
  // only after max(6 h, 3 sweeps) plus its dwell, and then for every idle mains
  // node. Past PAUSE_ESCALATE_MS the pause
  // itself is the degraded condition. A fresh pause raises nothing: it is what
  // the owner asked for.
  const pause = data.autonomyPause();
  // Only a pause that stops something (v0.72.0 review): with auto-ping not
  // running at all — absent, disabled, or behind the master gate — a pause
  // changes nothing. A transient suppressor ranked above it (a heal, a
  // rebuild, the boot window) does not clear an overdue pause (second review):
  // the alarm would flap; storm and no-capability raise degraded themselves.
  const pauseOverdue = pause != null && ap != null && ap.suppressed !== 'disabled' &&
    ap.suppressed !== 'write-actions-off' && data.autonomyPauseOverdue(now);
  const degraded = summonsNodes.length > 0
    || crit > 0
    || ident != null
    || statsBlind
    || pauseOverdue
    || (ap != null && (ap.suppressed === 'storm' || ap.suppressed === 'no-capability-data'));

  return [
    {
      entity: ENTITY_DEGRADED,
      state: degraded ? 'on' : 'off',
      attrs: {
        friendly_name: 'Z-Wave TUI degraded',
        device_class: 'problem',
        // THE HEARTBEAT (v0.66.0). Every other value here describes the MESH.
        // This one describes the PUBLISHER, and without it this sensor cannot
        // fail loudly — which is the one thing an alert entity must do.
        //
        // HA's `async_set_internal` takes a fast path when the incoming state
        // AND attributes both equal what it already holds: it updates
        // `last_reported` in place, fires EVENT_STATE_REPORTED, and returns.
        // `last_changed` and `last_updated` never move. That event is listed in
        // EVENTS_EXCLUDED_FROM_MATCH_ALL, `subscribe_entities` carries only
        // state_changed, and the REST/WS payload is served from a cached dict
        // the fast path never invalidates — so `last_reported` reads frozen
        // everywhere except an in-process template render. A healthy mesh and a
        // DEAD add-on were therefore byte-identical from every surface an
        // automation can reach: the 2026-09-17 log review found this entity
        // reading `off` / `reason: none` with last_updated frozen for two days,
        // across a full add-on restart it never noticed.
        //
        // A value that moves each cycle makes `same_attr` false, so HA builds a
        // fresh State and `last_updated` advances on every surface. `last_changed`
        // survives it by construction (`last_changed = old_state.last_changed if
        // same_state else None`), so "how long has it been off" is not lost.
        //
        // QUANTIZED to the minute rather than stamped per tick: the recorder
        // writes a row per change, and 30 s publishes would book 2 880 rows a
        // day on a Raspberry Pi to carry a freshness signal that nothing reads
        // faster than the ten-minute dead-feed watchdog.
        published_at: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
        reason: !degraded
          ? 'none'
          : ident != null
            ? `mesh identity changed (${ident.previous} → ${ident.live}) — awaiting Keep or Start-fresh`
            : statsBlind
            ? `statistics feed silent ${Math.round((statsSilentMs ?? 0) / 60_000)}m — the engine is blind`
            : summonsNodes.length > 0
            ? `${summonsNodes.length} node(s) need a human`
            : crit > 0
              ? `${crit} critical symptom(s)`
              // A storm or a blind add-on names itself (third review): an
              // overdue pause must not hide what the mesh is doing.
              : pauseOverdue && ap?.suppressed !== 'storm' && ap?.suppressed !== 'no-capability-data'
                ? `automatic writes paused ${Math.round((now - pause!.since) / 3_600_000)}h (by ${pause!.by.join(' + ')}) — nothing checks the mesh`
                : `auto-ping ${engineState}`,
      },
    },
    {
      entity: ENTITY_SUMMONS,
      state: String(summonsNodes.length),
      attrs: {
        friendly_name: 'Z-Wave TUI nodes needing a human',
        unit_of_measurement: 'nodes',
        node_ids: summonsNodes,
      },
    },
    {
      entity: ENTITY_SYMPTOMS,
      state: String(syms.length),
      attrs: {
        friendly_name: 'Z-Wave TUI live symptoms',
        unit_of_measurement: 'symptoms',
        critical: crit,
        warning: warn,
        kinds: [...new Set(syms.map((s) => s.kind))],
      },
    },
    {
      entity: ENTITY_ENGINE,
      state: engineState,
      attrs: {
        friendly_name: 'Z-Wave TUI engine',
        // Coverage is a statement about the INSTRUMENT, and an operator
        // deciding whether to trust a quiet screen needs it (v0.46.0).
        detectors_ready: eng.timeoutReady,
        // Not clear — unmeasured: the return-path detectors skip a node whose
        // 10-minute window holds too few transmissions to rate (v0.67.0).
        detectors_unmeasured: eng.timeoutWindowBlind,
        detectors_total: eng.total,
        rtt_ready: eng.rttReady,
        // v0.72.0: who paused the autonomous writes, and since when.
        paused_by: pause?.by ?? null,
        paused_since: pause == null ? null : new Date(pause.since).toISOString(),
        auto_remediation: 'none-admitted',
      },
    },
    // ROUTE FAILURES (v0.68.0). Recorded per node since v0.3x and shown on the
    // topology screen, but never published — so the richest link-level evidence
    // this engine holds was invisible to every automation and dashboard. The
    // reference mesh logs ~3.3 a day (128 in 66 days, 25 of 39 nodes). It does
    // NOT feed `degraded`: any threshold low enough to catch one bad link is on
    // most of the time there, and a failure followed by a working reroute is
    // the mesh healing itself. It says WHERE to look, not how bad things are.
    {
      entity: ENTITY_ROUTE_FAILURES,
      // A blind feed records nothing, so its zero would be a false all-clear.
      // NOR does a roster that has not loaded yet (v0.68.1): the first publish
      // after every restart runs before the first roster poll, and v0.68.0
      // sent `0` for ~30 s each boot — a false all-clear written into HA
      // history on every restart, then "corrected" to the real count.
      state: statsBlind || !rf.rosterLoaded ? 'unknown' : String(rf.events),
      attrs: {
        friendly_name: 'Z-Wave TUI route failures (7 d)',
        unit_of_measurement: 'failures',
        window_days: ROUTE_FAIL_WINDOW_MS / 86_400_000,
        links: rf.links,
        link_count: rf.linkCount,
        node_ids: rf.nodeIds,
        // An EVENT time, not the tick: it moves only when a failure arrives.
        last_failure_at: rf.lastAt == null ? null : new Date(rf.lastAt).toISOString(),
        lower_bound: rf.lowerBound,
      },
    },
    // THE ONE PROBLEM THAT NEEDS A PERSON (v0.72.0) — see recommendation.ts.
    // Its attributes are an exact allowlist, and none of them moves per tick,
    // so an unchanged recommendation republishes byte-identically.
    (() => {
      const r = buildRecommendation({
        symptoms: syms,
        nodeOf: (id) => data.nodeById(id),
        writeActions: bo.writeActions,
        efficacyFor: (k, a) => data.efficacyFor(k, a),
        ap,
        startedAt: bo.startedAt,
        now,
      });
      return { entity: ENTITY_RECOMMENDATION, state: r.state, attrs: { ...r.attrs } };
    })(),
  ];
}

/**
 * Start the publisher. Returns a stop handle; no-ops without a token, so bare
 * dev and the test suite never reach the network.
 */
/** The reason a refusal gives, if it gives one (v0.69.0). A bare "HTTP 400"
 *  took a full investigation to identify as the Supervisor's own "System is not
 *  ready with state: shutdown" during a host reboot — the answer was in the body
 *  all along. Bounded, JSON `message` preferred, never throws: a failing publish
 *  must not fail harder because its error page is odd. */
export async function failureReason(res: { text?: () => Promise<string> }): Promise<string> {
  try {
    if (typeof res.text !== 'function') return '';
    const body = (await res.text()).slice(0, 2_000).trim();
    if (!body) return '';
    let msg = body;
    try {
      const j = JSON.parse(body) as { message?: unknown };
      if (typeof j?.message === 'string') msg = j.message;
    } catch { /* not JSON — use the text */ }
    msg = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
    return msg ? `: ${msg}` : '';
  } catch {
    return '';
  }
}

export function startHaStates(
  opts: HaStatesOptions,
): { stop: () => void; publishNow: () => Promise<void> } {
  const log: NonNullable<HaStatesOptions['log']> = opts.log ?? ((): void => {});
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? 'http://supervisor/core/api';
  const startedAt = opts.startedAt ?? Date.now();
  let lastErr: string | null = null;

  const publishOnce = async (): Promise<void> => {
    if (!opts.token) return;
    let tickErr: string | null = null;
    let failed = 0;
    let total = 0;
    for (const s of buildStates(opts.data, Date.now(), { writeActions: opts.writeActions, startedAt })) {
      total += 1;
      try {
        const res = await doFetch(`${base}/states/${s.entity}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ state: s.state, attributes: s.attrs }),
          signal: AbortSignal.timeout(HA_STATE_PUBLISH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}${await failureReason(res)}`);
      } catch (e) {
        // KEEP GOING (v0.68.0). This used to `return`, so one entity HA
        // rejected — a 400 on one payload — silently stopped the other three
        // from publishing for as long as it kept failing. Each entity is an
        // independent conclusion; one bad write must not mute the rest.
        failed += 1;
        tickErr ??= e instanceof Error ? e.message : String(e);
      }
    }
    if (tickErr == null) { lastErr = null; return; }
    // Report only when the message CHANGES: a Core restart makes every tick
    // fail, and a line per tick would bury the log this add-on spent three
    // releases making readable (cf. the store save-failure latch). The latch is
    // the MESSAGE, never the count beside it — a count that wobbles between
    // ticks would defeat it and re-log the same outage every 30 s.
    if (tickErr !== lastErr) {
      lastErr = tickErr;
      // WARN, not info (v0.66.1). "Engine conclusions are not reaching HA"
      // is the whole product failing, and at `log_level: warning` — the
      // setting an operator picks to quiet a chatty add-on — it was the one
      // thing filtered out. The sink stays optional: tests and bare dev pass a
      // plain function, which is called exactly as before.
      (log.warn ?? log)(`ha-states: publish failed (${tickErr}) for ${failed} of ${total} entities — engine conclusions are not reaching HA`);
    }
  };

  // ONE TICK AT A TIME (v0.68.0). The loop now tries every entity, so a Core
  // that hangs rather than refuses costs up to four timeouts per tick — longer
  // than the interval — and ticks would pile up. A call that arrives while one
  // is in flight JOINS it rather than being dropped: a caller awaiting a
  // publish must see that publish finish, not return before it started.
  let current: Promise<void> | null = null;
  const publishNow = (): Promise<void> => (current ??= publishOnce().finally(() => { current = null; }));

  const timer = setInterval(() => { void publishNow(); }, opts.intervalMs ?? HA_STATE_PUBLISH_MS);
  timer.unref?.();
  void publishNow();
  return { stop: () => clearInterval(timer), publishNow };
}
