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

// (constants below are re-exported through index.ts's startup banner too)

/** How often the states are re-asserted (also the Core-restart self-heal window). */
export const HA_STATE_PUBLISH_MS = 30_000;

/** The entity ids this add-on owns. Renaming one BREAKS every automation built
 *  on it — treat these as published API, not as internal names. */
export const ENTITY_DEGRADED = 'binary_sensor.zwave_tui_degraded';
export const ENTITY_SUMMONS = 'sensor.zwave_tui_summons';
export const ENTITY_SYMPTOMS = 'sensor.zwave_tui_symptoms';
export const ENTITY_ENGINE = 'sensor.zwave_tui_engine';

export interface HaStatesOptions {
  data: DataProvider;
  /** Base of HA's REST API. Absent (bare dev) ⇒ the publisher no-ops. */
  baseUrl?: string;
  token?: string;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
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
export function buildStates(data: DataProvider): StatePost[] {
  const syms = data.symptoms();
  const crit = syms.filter((s) => s.severity === 'crit').length;
  const warn = syms.filter((s) => s.severity === 'warn').length;
  const ap = data.autoPingState?.() ?? null;
  const eng = data.engineStatus();

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
  const engineState = !eng.enabled
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
  const degraded = summonsNodes.length > 0
    || crit > 0
    || (ap != null && (ap.suppressed === 'storm' || ap.suppressed === 'no-capability-data'));

  return [
    {
      entity: ENTITY_DEGRADED,
      state: degraded ? 'on' : 'off',
      attrs: {
        friendly_name: 'Z-Wave TUI degraded',
        device_class: 'problem',
        reason: !degraded
          ? 'none'
          : summonsNodes.length > 0
            ? `${summonsNodes.length} node(s) need a human`
            : crit > 0
              ? `${crit} critical symptom(s)`
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
        detectors_total: eng.total,
        rtt_ready: eng.rttReady,
      },
    },
  ];
}

/**
 * Start the publisher. Returns a stop handle; no-ops without a token, so bare
 * dev and the test suite never reach the network.
 */
export function startHaStates(
  opts: HaStatesOptions,
): { stop: () => void; publishNow: () => Promise<void> } {
  const log = opts.log ?? ((): void => {});
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl ?? 'http://supervisor/core/api';
  let lastErr: string | null = null;

  const publishNow = async (): Promise<void> => {
    if (!opts.token) return;
    for (const s of buildStates(opts.data)) {
      try {
        const res = await doFetch(`${base}/states/${s.entity}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ state: s.state, attributes: s.attrs }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        lastErr = null;
      } catch (e) {
        // Report only when the message CHANGES: a Core restart makes every tick
        // fail, and an ERROR per entity per 30 s would bury the log this add-on
        // spent three releases making readable (cf. the store save-failure latch).
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== lastErr) {
          lastErr = msg;
          log(`ha-states: publish failed (${msg}) — engine conclusions are not reaching HA`);
        }
        return;
      }
    }
  };

  const timer = setInterval(() => { void publishNow(); }, opts.intervalMs ?? HA_STATE_PUBLISH_MS);
  timer.unref?.();
  void publishNow();
  return { stop: () => clearInterval(timer), publishNow };
}
