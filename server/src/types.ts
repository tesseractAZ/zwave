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
  state?: string;
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
  } | null;
}

/** Health scoring output for one node. */
export interface HealthResult {
  score: number; // 0..100
  rating: number; // 0..10
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
  /** True once the action's success rate clears baseRate by the min effect size. */
  beatsSelfHealing: boolean;
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
  scoreFor(nodeId: number): HealthResult;
  noiseFloor(): number; // representative background RSSI (dBm) for SNR-margin math
  hasRealNoise(): boolean; // true when noiseFloor() is a real reading, not the fallback
  history(nodeId: number): { rssi: number[]; rtt: number[] }; // rolling fine trend for sparklines
  historyLong(nodeId: number): { rssi: number[]; rtt: number[] }; // coarse long-horizon (~2h) trend
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
}

/** Which screen is active. Overview is home; the rest are overlays. */
export type ScreenView =
  | 'overview'
  | 'detail'
  | 'controller'
  | 'topology'
  | 'heatmap'
  | 'log'
  | 'remedy';

export const SCREENS: ScreenView[] = [
  'overview',
  'detail',
  'controller',
  'topology',
  'heatmap',
  'log',
  'remedy',
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
  followTail: boolean; // log screen
  errorsOnly: boolean; // log screen
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

/** The kinds of mutating action the TUI can request. */
export type ActionKind =
  | 'ping'
  | 'refreshValues'
  | 'reInterview'
  | 'healNode'
  | 'rebuildAll'
  | 'stopRebuild'
  | 'removeFailed';

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
