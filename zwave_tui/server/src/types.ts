/**
 * Shared type contract for the Z-Wave TUI add-on.
 *
 * This file is the load-bearing interface every other module codes against:
 *   • zwave/zwaveData.ts   PRODUCES NodeSnapshot[] / ControllerSnapshot
 *   • zwave/health.ts      MAPS NodeSnapshot -> HealthResult
 *   • telnet/dataProvider  EXPOSES the DataProvider surface to the render loop
 *   • telnet/screens/*     CONSUME (view, DataProvider) -> string[]
 *
 * Keep it stable. Adding optional fields is safe; renaming/removing breaks
 * every consumer at once (which is the point — the typecheck catches it).
 */

/** Z-Wave JS NodeStatus enum (from the driver). */
export enum NodeStatus {
  Unknown = 0,
  Asleep = 1,
  Awake = 2,
  Dead = 3,
  Alive = 4,
}

export const NODE_STATUS_LABEL: Record<number, string> = {
  0: 'unknown',
  1: 'asleep',
  2: 'awake',
  3: 'dead',
  4: 'alive',
};

/** One HA entity belonging to a Z-Wave node. */
export interface NodeEntity {
  entityId: string;
  domain: string; // light | switch | sensor | binary_sensor | button | number | select | update | event | fan
  name?: string;
  // No `state` here (dropped v0.35): the registry roster is identity only and
  // never carried one. Live state is EntityLiveState below, which the Detail
  // screen actually reads — two places to look for a state, one of them always
  // undefined, is worse than one.
}

/** A node entity joined with its CURRENT live state (Detail entity list, v0.22).
 *  `state` is null when the entity is unavailable/unknown or not yet fetched;
 *  `attrs` carries the handful of attributes the renderer formats per-domain
 *  (brightness, current_temperature, unit_of_measurement, current_position …). */
export interface EntityLiveState {
  entityId: string;
  domain: string;
  name: string;
  state: string | null;
  attrs: Record<string, unknown>;
}

/** One Z-Wave device configuration parameter (zwave_js/get_config_parameters). */
export interface ConfigParam {
  key: string; // stable HA param key, e.g. "3-112-0-3"
  label: string; // metadata.label
  value: number | null; // current value
  valueLabel: string | null; // enum label for `value`, when the param is an enum
  unit: string | null;
  writeable: boolean;
  min: number | null;
  max: number | null;
  // ── addressing + options for set_config_parameter (v0.23 writes) ──
  property: number; // config-parameter number
  propertyKey: number | null; // partial-parameter bitmask key, when present
  endpoint: number; // device endpoint (0 = root)
  states: Record<string, string> | null; // enum value→label options, when an enum
}

export type ConfigStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
/** Result of a per-node config-parameter fetch (lazy, cached). */
export interface ConfigParamsResult {
  status: ConfigStatus;
  params: ConfigParam[];
  error?: string;
}

/** Live routing statistics for one route (LWR or NLWR). */
export interface RouteStat {
  repeaters: number[]; // node ids of repeaters in the route (empty = direct)
  protocolDataRate: number | null; // 1=9.6k 2=40k 3=100k 4=LR
  rssi: number | null; // dBm of the route
  repeaterRSSI: number[]; // per-hop rssi
  routeFailedBetween: [number, number] | null; // [a,b] node ids the route failed between
}

/** Per-node link/RF statistics (from subscribe_node_statistics; may be partial). */
export interface NodeStats {
  rtt: number | null; // ms round-trip
  rssi: number | null; // last dBm
  lwr: RouteStat | null; // last working route
  nlwr: RouteStat | null; // next-to-last working route
  commandsTX: number;
  commandsRX: number;
  commandsDroppedTX: number;
  commandsDroppedRX: number;
  timeoutResponse: number;
  lastSeen: number | null; // epoch ms
}

/** Firmware-update status for a node, from its `update.*` firmware entity/-ies. */
export interface FirmwareInfo {
  current: string | null; // installed_version
  latest: string | null; // latest_version
  updateAvailable: boolean; // any firmware target reports an update (state 'on')
  inProgress: boolean; // a firmware update is currently applying
  progressPct: number | null; // update_percentage while inProgress (0..100)
  targets: number; // number of firmware update entities on this node (≥1)
}

/** A single Z-Wave node as the TUI sees it (controller = node 1). */
export interface NodeSnapshot {
  nodeId: number;
  deviceId: string; // HA device_registry id
  name: string; // friendly name (name_by_user || name)
  area: string | null; // HA area id
  status: NodeStatus; // 0..4
  statusLabel: string; // NODE_STATUS_LABEL[status]
  ready: boolean;
  isRouting: boolean;
  isListening: boolean | null; // false = sleeping/FLiRS
  isLongRange: boolean; // nodeId >= 256 (LR)
  isController: boolean; // node 1
  isSecure: boolean | null;
  securityClass: string | null;
  manufacturer: string | null;
  model: string | null;
  battery: { level: number; isLow: boolean } | null; // null = mains-powered
  firmware: FirmwareInfo | null; // null = no firmware update entity / unknown
  stats: NodeStats;
  entities: NodeEntity[];
}

/** Controller / network-level snapshot (node 1). */
export interface ControllerSnapshot {
  homeId: number | null;
  nodeId: number; // own_node_id (1)
  sdkVersion: string | null;
  firmwareVersion: string | null;
  rfRegion: string | null;
  isPrimary: boolean;
  isSUC: boolean;
  isSISPresent: boolean;
  manufacturer: string | null;
  model: string | null;
  isRebuildingRoutes: boolean;
  rebuildStartedAt: number | null; // epoch ms the current rebuild-routes began (null = idle)
  firmwareUpdatesAvailable: number; // fleet count: nodes with a firmware update available
  backgroundRSSI: number[]; // per-channel noise floor (dBm), ch0..n
  statistics: {
    messagesTX: number;
    messagesRX: number;
    messagesDroppedTX: number;
    messagesDroppedRX: number;
    NAK: number;
    CAN: number;
    timeoutACK: number;
    timeoutResponse: number; // note: driver misspells the raw key 'timout_response'
    // Nullable: HA forwards `timeout_callback` (RESEARCH §1.5), but treating a
    // missing one as a malformed event would reject the WHOLE statistics
    // payload and freeze every counter on this screen.
    timeoutCallback: number | null;
  } | null;
}

/** Health scoring output for one node. */
export interface HealthResult {
  score: number; // 0..100
  grade: string; // A..F
  state: 'ok' | 'weak' | 'flaky' | 'asleep' | 'dead' | 'unknown';
  flags: string[]; // e.g. ['W','F'] — single-char flags rendered in the table
}

/** The category of a log event — drives the glyph, colour, and detail pane. */
export type LogKind =
  | 'status' // node alive/dead/asleep/awake transition
  | 'route' // last-working-route (repeater chain) change
  | 'value' // a device entity's state changed (light on, sensor read, lock…)
  | 'notification' // a zwave_js_notification (entry control, keypad, tamper…)
  | 'action' // operator command outcome (ping/heal/rebuild/…)
  | 'symptom' // engine-detected mesh/node symptom (M3)
  | 'system'; // add-on/connection lifecycle

// Type-only import (no runtime cycle): the symptom engine's output shape, read
// by DataProvider.symptoms() and the REMEDY screen.
import type { Symptom, SymptomKind } from './zwave/symptoms';
export type { Symptom, SymptomKind, Severity } from './zwave/symptoms';

/** M5 learned efficacy of an action against a symptom kind — read by the planner
 *  so a recommendation can say "beat self-healing N×" or "not distinguishable". */
export interface Efficacy {
  /** P(improved | action), but null until it beats the no-action arm with enough n. */
  expectedEfficacy: number | null;
  /** Decayed episode count backing the estimate. */
  n: number;
  /** The kind's spontaneous-recovery base rate (control arm), for context. */
  baseRate: number | null;
  /**
   * How many DISTINCT nodes fed this action arm (v0.36.5); 0 when unknown
   * (a ledger file written before this was tracked).
   *
   * The arms are marginal by design, so one pathological device can saturate
   * one — observed live, a single flapping node taught the fleet-wide
   * (rtt-degraded, ping) arm six episodes on its own. `n=6` reads as six nodes
   * agreeing when it was one node repeating, and only this number tells them
   * apart.
   */
  nodes: number;
  // NOTE: there is deliberately no `beatsSelfHealing` flag (dropped v0.35). It
  // was `expectedEfficacy != null` by construction — two fields encoding one
  // fact, read by nothing but its own tests, and one refactor away from
  // disagreeing with each other about whether an action works.
  /** Enough episodes to have an opinion at all (n ≥ min). Distinguishes
   *  "still learning" from "learned: not distinguishable from self-healing". */
  ready: boolean;
}

/** An event/log line (driver event or operator command outcome). */
export interface LogEvent {
  seq: number; // monotonic id (newest = highest) — a STABLE selection anchor as the ring grows
  ts: number; // epoch ms
  source: 'net' | 'you'; // driver event vs operator action
  severity: 'info' | 'warn' | 'error';
  kind: LogKind;
  nodeId: number | null;
  text: string;
  acked?: boolean; // RED latch: an error stays until acknowledged
  // ── optional enrichment (the detail pane + device association read these) ──
  entityId?: string; // the HA entity that changed (value events)
  entityName?: string; // its friendly name
  domain?: string; // light | switch | sensor | binary_sensor | lock | climate…
  oldState?: string; // previous entity state (value events)
  newState?: string; // new entity state (value events)
}

/**
 * The read surface the render loop consumes each frame. Implemented by
 * telnet/dataProvider. Accessors return the last CACHED values — never
 * recompute inside draw().
 */
export interface DataProvider {
  nodes(): NodeSnapshot[];
  nodeById(nodeId: number): NodeSnapshot | undefined;
  controller(): ControllerSnapshot | null;
  events(): LogEvent[];
  /**
   * Acknowledge an error event by its `seq` — release its RED latch (v0.33).
   * Returns true only when the event exists, is an error, and was not already
   * acked. The ring is ONE shared control-room log, so an ack clears the latch
   * for every session — acknowledged means a human has seen it, not this
   * terminal has. Optional so read-only harnesses/mocks need not provide it;
   * the Log screen no-ops when it is absent.
   */
  ackEvent?(seq: number): boolean;
  scoreFor(nodeId: number): HealthResult;
  noiseFloor(): number; // representative background RSSI (dBm) for SNR-margin math
  hasRealNoise(): boolean; // true when noiseFloor() is a real reading, not the fallback
  history(nodeId: number): { rssi: readonly number[]; rtt: readonly number[] }; // rolling fine trend (READONLY view — do not mutate)
  historyLong(nodeId: number): { rssi: readonly number[]; rtt: readonly number[] }; // coarse long-horizon (~2h) trend
  /**
   * Measured route stability for a node, from the persisted coarse tier (v0.34).
   *
   * `route-churn` has had a detector and a planner card since v0.30 and has
   * never fired on the reference mesh — and until now there was no way to tell
   * whether that meant "the mesh is stable" or "the detector cannot see". This
   * exposes the SAME `dRouteChanges` accumulator the detector sums, over the
   * multi-day coarse window, so the absence is a measurement rather than an
   * assumption.
   *
   * `null` when no evidence store is configured. `hours: 0` means the store is
   * present but has no coarse history for this node yet — which must render as
   * "no history", never as "0 changes".
   */
  routeStability?(nodeId: number): { changes: number; hours: number } | null;
  /**
   * Persisted route-failure events for a node (v0.35): each carries the PAIR
   * the transmission died between, which is the one thing a topology screen
   * most wants and never had — "the route failed" is a symptom, "it failed
   * between n3 and n7" names the suspect link. Recorded since v0.13 and read
   * by nothing until now.
   */
  routeFailures?(nodeId: number): { t: number; between: [number, number] }[];
  /**
   * What the engine can actually SEE for this node (v0.35).
   *
   * The evidence store has tracked cumulative sample counts and feed liveness
   * per node since M2 and no screen has read them back. That matters more than
   * it sounds: "no evidence for n27" from a node whose status/stats feeds are
   * DOWN is a monitoring hole, and rendering it the same as genuine node
   * silence is how a blind spot passes for a clean bill of health.
   *
   * `firstSeenAt`/`samples`/`freshSamples` are cumulative since roster
   * registration and survive both ring eviction and restarts.
   */
  evidenceCoverage?(nodeId: number): {
    firstSeenAt: number;
    samples: number;
    freshSamples: number;
    statusFeedLive: boolean;
    statsFeedLive: boolean;
    /** Liveness-sweep outcomes (v0.37): every listening node asked the same
     *  question on the same cadence, which is what makes the rate a fact about
     *  the node rather than about how talkative it is. */
    probesAsked: number;
    probesAnswered: number;
    /** Of those, how many the node had already answered for itself by
     *  communicating since the previous sweep. */
    probesSelfProven: number;
  } | null;
  /** Persisted long-horizon buckets for a node (v0.35) — the tier that outlives
   *  the fine ring, so the dossier can state the window behind its numbers. */
  evidenceCoarse?(nodeId: number): { t0: number; samples: number; routeChanges?: number }[];
  lastUpdated(): number | null; // epoch ms of the last successful roster refresh
  ready(): boolean; // has the first roster load completed?
  lastError(): string | null;
  /** Engine-detected symptoms (M3), ranked; empty when the engine is off or
   *  nothing is wrong. Read by the REMEDY screen. */
  symptoms(): Symptom[];
  /** Engine state: enabled + graduated-baseline count, for the REMEDY empty
   *  state to tell "off" from "learning" from "all healthy". */
  engineStatus(): { enabled: boolean; ready: number; total: number };
  /** M5 learned efficacy of an action against a symptom kind, or null when the
   *  outcome ledger is off / has no estimate yet. Read by the REMEDY screen so
   *  the planner's candidates can carry an evidence-backed efficacy note. */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy | null;
  /**
   * How many episodes of this symptom kind the outcome ledger closed as
   * `refused-misdiagnosis` (v0.35) — the engine's own tally of when this
   * detector cried wolf.
   *
   * Recorded since M5 and read by nothing, which is a strange gap for an
   * ADVISORY engine: the one number that says "be sceptical of this card" was
   * the one the card would not show you.
   */
  falsePositives?(kind: SymptomKind): number;
  /**
   * How many episodes of this kind the ledger closed `unverifiable` (v0.36).
   *
   * The counter that makes a structurally-inert learning loop legible. An
   * empty efficacy table reads identically whether the ledger is patiently
   * gathering data or has been discarding every episode it ever closed; this
   * is the number that tells those two apart, and on the live mesh it was 16
   * out of 16 before anything surfaced it.
   */
  unverifiableCount?(kind: SymptomKind): number;
  /** Of those, episodes on a node that cannot be probed at all (v0.38) — a
   *  sleeping battery/FLiRS device, whose windows can never be filled. A
   *  different fact from thin evidence, and previously indistinguishable. */
  unverifiableUnprobeableCount?(kind: SymptomKind): number;
  /**
   * The engine's LEARNED RSSI normal for a node (v0.35): median, MAD-derived
   * scale, whether it has graduated, and the days behind it.
   *
   * BAND-DEPENDENT: the store keeps a separate normal per 4-hour time-of-day
   * band, and this answers for the band containing NOW — the same call at 3am
   * and 3pm legitimately returns different yardsticks. Any rendering must say
   * so, or the baseline reads as contradicting itself across the day.
   *
   * This is the yardstick every per-node signal verdict is measured against.
   * It was computed and persisted since M3 and readable from nothing, which
   * made "n27's signal is below its own normal" an unfalsifiable claim on
   * screen — the operator could see the verdict but never the baseline.
   */
  rssiNormal?(nodeId: number): { median: number; scale: number; ready: boolean; days: number } | null;
  /** M6 interference view (cached) — the noise floor, its trend, controller
   *  serial-link health, the diurnal timeout-rate heatmap, and the current
   *  correlated-degradation state. Read by the INTERFERENCE screen. */
  interference(): InterferenceView;
  /** v0.22: a node's entities joined with their CURRENT live state (light on/off,
   *  sensor readings, dimmer level …). Read by the DETAIL screen. Empty when the
   *  node has no entities or states haven't loaded yet. */
  entityStates(nodeId: number): EntityLiveState[];
  /** v0.22: the node's Z-Wave configuration parameters (lazy per-node fetch;
   *  status reflects idle/loading/ready/error/unsupported). Read by DETAIL. */
  configParams(nodeId: number): ConfigParamsResult;
  /** v0.22: idempotently trigger the (async) config-parameter fetch for a node —
   *  the DETAIL screen calls this when a node is shown; the result surfaces via
   *  configParams() on a later frame. No-op if already loading/loaded. */
  requestConfigParams(nodeId: number): void;
}

/** M6 interference-watch view — a pre-computed summary the INTERFERENCE screen
 *  renders purely (aggregating the coarse buckets per frame would be too heavy). */
export interface InterferenceView {
  /** Background 900 MHz noise floor (dBm) — the driver-WS measurement. */
  noise: {
    channels: (number | null)[]; // per-channel ch0..3 current
    floor: number | null; // representative floor (null when no real reading)
    real: boolean; // true = a live driver-WS reading, false = fallback/absent
    trend: number[]; // recent representative-floor samples (~40-min fine ring, for a sparkline)
    /** Long-horizon (multi-day) floor: one point per 30-min coarse bucket, oldest
     *  first — the persisted tier, so the trend survives restarts and spans days. */
    trendCoarse: number[];
    /** Days of coarse noise-floor history behind `trendCoarse` (honest "n days" label). */
    trendCoarseDays: number;
    band: 'clean' | 'elevated' | 'noisy' | 'unknown';
  };
  /** Controller serial-link health (host↔stick), as per-hour event rates. */
  serial: {
    nakPerH: number | null;
    canPerH: number | null;
    tmoAckPerH: number | null;
    tmoRespPerH: number | null;
    band: 'healthy' | 'strained' | 'unknown';
    spanH: number; // hours of controller-sample history backing the rates
  };
  /** Diurnal (hour-of-day) mesh-wide RAW timeout rate — never baseline-relative;
   *  a persistently hot hour reveals recurring interference the bands absorbed. */
  diurnal: { hour: number; rate: number | null; tx: number }[]; // length 24
  /** Days of coarse history backing the heatmap (for an honest "n days" label). */
  coverageDays: number;
  /** Current correlated-degradation state. When a mesh event is active the
   *  `narrative` carries the DETECTOR's own coherent "degraded X of Y active"
   *  ratio. `degradedNodes` is a plain count of distinct nodes carrying ANY
   *  per-node symptom (controller-degraded and edge-cluster excluded) — read
   *  by the inactive narrative, and from v0.35 also rendered during an ACTIVE
   *  event as the mesh-wide symptom count. It is NOT the event's reach: nodes
   *  with unrelated faults are in it, which is why the screen labels it
   *  "across ALL detectors" rather than as scope. */
  correlated: {
    active: boolean;
    degradedNodes: number;
    narrative: string;
  };
}

/** Which screen is active. Overview is home; the rest are overlays. */
export type ScreenView =
  | 'overview'
  | 'detail'
  | 'controller'
  | 'topology'
  | 'heatmap'
  | 'log'
  | 'remedy'
  | 'interference';

export const SCREENS: ScreenView[] = [
  'overview',
  'detail',
  'controller',
  'topology',
  'heatmap',
  'log',
  'remedy',
  'interference',
];

/** Log-screen date window. `all` = the whole in-memory ring. */
export type LogRange = 'all' | 'hour' | '24h' | 'today' | 'yesterday' | '7d';

/** Human labels for the log date ranges (header chip + tests). */
export const LOG_RANGE_LABEL: Record<LogRange, string> = {
  all: 'all time',
  hour: 'last hour',
  '24h': 'last 24h',
  today: 'today',
  yesterday: 'yesterday',
  '7d': 'last 7 days',
};

/** Order the `d` key cycles the log date ranges. */
export const LOG_RANGE_ORDER: LogRange[] = ['all', 'hour', '24h', 'today', 'yesterday', '7d'];

/** Per-session view state passed to screen renderers. */
export interface ViewState {
  screen: ScreenView;
  cols: number;
  rows: number;
  selected: number; // index into the sorted node list
  scroll: number;
  filter: string; // substring filter on the overview
  sortKey: 'health' | 'id' | 'name' | 'rssi' | 'seen';
  signalDisplay: 'margin' | 'dbm';
  errorsOnly: boolean; // log screen
  // ── Detail screen: dossier scroll offset (v0.22) ──
  detailScroll: number; // index of the first visible dossier row (renderer clamps + writes back)
  remedyCursor: number; // selected symptom card on REMEDY — this is the ACTION TARGET there
  /**
   * Identity of the symptom under the Remedy cursor, so a re-sort between
   * frames cannot slide the cursor onto a different node. A bare index aims
   * `p` — which runs with no CONFIRM box — at whatever now occupies that slot.
   * Null = follow the top card. (Same discipline as `logAnchorSeq`.)
   */
  remedyAnchorId: string | null;
  topologyScroll: number; // index of the first visible route-tree row (renderer clamps + writes back)
  // ── Log screen navigation (independent of the node cursor) ──
  logCursor: number; // DERIVED index into the FILTERED event list (0 = newest)
  logScroll: number; // index of the first visible event row (sticky window)
  logRange: LogRange; // active date-window filter
  /** The `seq` of the highlighted event — the STABLE selection anchor, re-derived
   *  into logCursor each frame so new events prepending don't drift the cursor.
   *  `null` = follow the newest (cursor pinned to the top). */
  logAnchorSeq: number | null;
}

/** Transport-agnostic input event (telnet & xterm feed the same shapes). */
export type InputEvent =
  | { type: 'char'; ch: string }
  | { type: 'arrow'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'escape' }
  | { type: 'ctrlc' };

/** Outcome of a remediation action. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

/** The kinds of mutating action the TUI can request. The first seven are
 *  mesh-maintenance verbs (M5 remediation ledger tracks these); the last two are
 *  v0.23 operator device-control ops (NOT remediation — never fed to the ledger). */
export type ActionKind =
  | 'ping'
  | 'refreshValues'
  | 'reInterview'
  | 'healNode'
  | 'rebuildAll'
  | 'stopRebuild'
  | 'removeFailed'
  | 'controlEntity'
  | 'setConfigParam';

/** A device-control verb (v0.23). Domain→service mapping lives in
 *  `zwave/entityControl.ts`; this union is the vocabulary. */
export type EntityVerb = 'on' | 'off' | 'toggle' | 'lock' | 'unlock' | 'open' | 'close';

/**
 * Mutating-action surface (v0.3). Implemented by the data layer, passed to the
 * session ONLY when `write_actions_enabled`. Every method logs its outcome into
 * the event ring so the Log screen closes the loop. Node-scoped actions take a
 * node id; network-wide ones take none.
 */
export interface ActionRunner {
  /** Master gate — false = read-only, the session must not offer actions. */
  readonly enabled: boolean;
  ping(nodeId: number): Promise<ActionResult>;
  refreshValues(nodeId: number): Promise<ActionResult>;
  reInterview(nodeId: number): Promise<ActionResult>;
  healNode(nodeId: number): Promise<ActionResult>;
  rebuildAll(): Promise<ActionResult>;
  stopRebuild(): Promise<ActionResult>;
  removeFailed(nodeId: number): Promise<ActionResult>;
  /** v0.23: actuate a device entity (on/off/toggle/lock/unlock/open/close) via
   *  call_service. `nodeId` is for logging/attribution only; the entity's domain
   *  (from `entityId`) selects the service. */
  controlEntity(nodeId: number, entityId: string, verb: EntityVerb): Promise<ActionResult>;
  /** v0.23: write a Z-Wave configuration parameter (zwave_js/set_config_parameter). */
  setConfigParam(nodeId: number, param: ConfigParam, value: number): Promise<ActionResult>;
}

/** Context handed to each screen renderer. */
export interface ScreenCtx {
  view: ViewState;
  data: DataProvider;
  /** sorted+filtered node list the overview/selection operate on */
  visibleNodes: NodeSnapshot[];
  /** true while the `/` filter-capture mode is active (shows the live prompt) */
  filtering?: boolean;
  /** true when mutating actions (ping/heal/…) are available (write_actions on) */
  actionsEnabled?: boolean;
}
