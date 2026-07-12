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

/** An event/log line (driver event or operator command outcome). */
export interface LogEvent {
  ts: number; // epoch ms
  source: 'net' | 'you'; // driver event vs operator action
  severity: 'info' | 'warn' | 'error';
  nodeId: number | null;
  text: string;
  acked?: boolean; // RED latch: an error stays until acknowledged
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
  lastUpdated(): number | null; // epoch ms of the last successful roster refresh
  ready(): boolean; // has the first roster load completed?
  lastError(): string | null;
}

/** Which screen is active. Overview is home; the rest are overlays. */
export type ScreenView =
  | 'overview'
  | 'detail'
  | 'controller'
  | 'topology'
  | 'heatmap'
  | 'log';

export const SCREENS: ScreenView[] = [
  'overview',
  'detail',
  'controller',
  'topology',
  'heatmap',
  'log',
];

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
  /** Require a confirm step for mutating (non-ping) actions. */
  readonly confirmDestructive: boolean;
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
