/**
 * The Z-Wave data layer.
 *
 * Turns Home Assistant's `zwave_js/*` WebSocket surface into the cheap, cached
 * `NodeSnapshot[]` / `ControllerSnapshot` the render loop reads every frame
 * (the `createTuiDataProvider` pattern from ecoflow-panel).
 *
 * Startup sequence:
 *   1. Resolve the config-entry id. If none was supplied (option/env empty),
 *      auto-discover it via `config_entries/get` filtered to `domain==='zwave_js'`
 *      — survives a re-add of the integration.
 *   2. Join the device + entity registries ONCE. Z-Wave JS device identifiers
 *      look like `['zwave_js','<home_id>-<node_id>', ...]`, so the node id is
 *      `Number(identifier.split('-')[1])`; the controller is node 1
 *      (`is_controller_node` / `via_device_id === null`). This gives us the
 *      node_id ↔ device_id ↔ entities map that `network_status` (which only
 *      knows numeric node ids) can't provide.
 *   3. Poll `zwave_js/network_status {entry_id}` every `refreshMs` — the cheapest
 *      complete mesh snapshot (full roster with the 0..4 status enum,
 *      is_routing, is_secure, ready, security class, is_rebuilding_routes). Join
 *      each node against the registry maps → `NodeSnapshot`. Build one
 *      `ControllerSnapshot` from `controller` + the controller device.
 *
 * v0.1 is READ-ONLY and stats are partial: `NodeSnapshot.stats` is all-null and
 * `ControllerSnapshot.statistics` / `backgroundRSSI` are empty. The live
 * `subscribe_node_statistics` / `subscribe_controller_statistics` /
 * `subscribe_events` wiring is v0.2 — see `startLiveStatistics()`.
 *
 * ANTI-FOOTGUN: `zwave_js/network_status` takes `entry_id`, NOT `config_entry_id`
 * (the latter rejects with `invalid_format`).
 */

import type { HaWsClient } from '../ha/haWsClient';
import {
  NodeStatus,
  NODE_STATUS_LABEL,
  type NodeSnapshot,
  type NodeStats,
  type NodeEntity,
  type FirmwareInfo,
  type ControllerSnapshot,
  type RouteStat,
  type LogEvent,
  type LogKind,
  type ActionKind,
  type InterferenceView,
  type EntityLiveState,
  type ConfigParam,
  type ConfigParamsResult,
} from '../types';
import { createHistoryStore, type HistoryStore, type HistoryMap } from './historyStore';
import {
  createEvidenceStore,
  type EvidenceStore,
  type EvidenceSample,
  type CoarseBucket,
  type ControllerSample,
  type RouteFailureEvent,
  type NodeCoverage,
} from './evidenceStore';
import { createDriverWsClient, type DriverWsClient, type BgRssiChannels } from './driverWsClient';
import { createBaselineStore, type BaselineStore } from './baselines';
import { detectSymptoms, symptomaticNodes, armingNodes, type Symptom, type SymptomKind, type SymptomState } from './symptoms';
import { createOutcomeStore, windowMetrics, planEpisodeLifecycle, type OutcomeStore, type Efficacy } from './outcomes';
import { computeInterference } from './interference';

/**
 * Rolling per-node RSSI/RTT sample-ring depth. Shared by the live ring in
 * `onNodeStats` AND the persistence store's `maxSamples`, so the on-disk cap
 * and the in-memory cap can never drift apart.
 */
const HIST_MAX = 60;

/**
 * Activity-log ring depth (in-memory, session-scoped — not persisted). Larger
 * than the v0.2 value so the date filter has real material to work with; 2000
 * events at ~120 B each is ~240 KB, trivial. Oldest fall off the tail.
 */
const LOG_MAX = 2000;

/** Min gap between logged updates of the SAME numeric `sensor` entity (ms). */
const VALUE_SENSOR_MIN_GAP_MS = 10_000;

/** True when a state string is a finite number (telemetry vs a discrete label). */
export function isFiniteNumeric(s: string): boolean {
  if (s === '') return false;
  const n = Number(s);
  return Number.isFinite(n);
}

/** One entry of the entity index: which node an entity belongs to + its label. */
export interface EntityIndexEntry {
  nodeId: number;
  name: string;
  domain: string;
}

/** The value-log payload a state_changed event maps to (null = skip). */
export interface ValueEventPayload {
  nodeId: number;
  text: string;
  entityId: string;
  entityName: string;
  domain: string;
  oldState?: string;
  newState: string;
}

/**
 * Pure mapping: an HA `state_changed` event → a value-log payload, or `null` to
 * skip it. Skips: unknown/untracked entities, entity removals (new_state null),
 * no-op transitions (old===new), and rapid numeric-`sensor` telemetry (throttled
 * to `minGapMs` per entity — discrete events are NEVER throttled). Mutates
 * `lastValueAt` only when it accepts a throttled numeric update. Exported so the
 * mapping + throttle are unit-tested without standing up the whole data layer.
 */
export function mapStateChanged(
  ev: unknown,
  entityIndex: Map<string, EntityIndexEntry>,
  now: number,
  lastValueAt: Map<string, number>,
  minGapMs: number = VALUE_SENSOR_MIN_GAP_MS,
): ValueEventPayload | null {
  const data = (ev as { data?: { entity_id?: string; old_state?: { state?: string } | null; new_state?: { state?: string } | null } } | null)?.data;
  const eid = data?.entity_id;
  if (!eid) return null;
  const idx = entityIndex.get(eid);
  if (!idx) return null; // not a tracked device entity of this mesh
  const oldS = data.old_state?.state ?? undefined;
  const newS = data.new_state?.state ?? undefined;
  if (newS == null) return null; // entity removed — not activity
  if (oldS === newS) return null; // attribute-only change, no state transition
  if (idx.domain === 'sensor' && isFiniteNumeric(newS)) {
    // First-ever update always passes; only rapid REPEAT updates are throttled.
    const last = lastValueAt.get(eid);
    if (last != null && now - last < minGapMs) return null;
    lastValueAt.set(eid, now);
  }
  // The state strings come straight from HA — sanitize before they reach a TUI
  // frame (strip control/ANSI, fold wide chars), same boundary as device names.
  const oldC = oldS != null ? sanitizeLabel(oldS) : undefined;
  const newC = sanitizeLabel(newS);
  return {
    nodeId: idx.nodeId,
    text: `${idx.name}: ${oldC ?? '—'} → ${newC}`,
    entityId: eid,
    entityName: idx.name,
    domain: idx.domain,
    oldState: oldC,
    newState: newC,
  };
}
/** Coarse (long-horizon) ring depth + cadence: 1 downsampled point per minute
 *  × 120 ≈ a 2-hour trend. Shared with the store's `coarseMax`. */
const COARSE_MAX = 120;
const COARSE_INTERVAL_MS = 60_000;
/** v0.22: min gap before a FAILED config-param fetch is retried, so a Detail
 *  screen that re-requests every frame can't hammer a flaky device. */
const CONFIG_RETRY_MS = 15_000;

/* ─── raw HA response shapes (only the fields we read) ──────────────────── */

interface RawNode {
  node_id: number;
  is_routing?: boolean;
  status?: number; // 0..4
  is_secure?: boolean | null;
  ready?: boolean;
  highest_security_class?: number | null;
  is_controller_node?: boolean;
}

interface RawController {
  home_id?: number;
  sdk_version?: string | null;
  own_node_id?: number;
  is_primary?: boolean;
  is_sis_present?: boolean; // NOTE: lowercase 'sis' in the raw key
  is_suc?: boolean;
  firmware_version?: string | null;
  rf_region?: number;
  is_rebuilding_routes?: boolean;
  nodes?: RawNode[];
}

interface RawNetworkStatus {
  controller?: RawController;
}

interface RawDevice {
  id: string;
  identifiers?: unknown;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  area_id?: string | null;
  via_device_id?: string | null;
}

interface RawEntity {
  entity_id: string;
  device_id?: string | null;
  platform?: string;
  disabled_by?: string | null;
  name?: string | null;
  original_name?: string | null;
}

interface RawConfigEntry {
  entry_id: string;
  domain: string;
  state?: string;
}

/** Registry-derived per-node metadata (the half `network_status` lacks). */
interface DeviceRec {
  id: string;
  name: string;
  area: string | null;
  manufacturer: string | null;
  model: string | null;
}

export interface ZwaveDataOptions {
  client: HaWsClient;
  /** Explicit config-entry id; empty/undefined → auto-discover. */
  entryId?: string | null;
  /** network_status poll cadence (ms). */
  refreshMs?: number;
  /** Expensive route/controller-stats cadence (ms) — v0.2 subscriptions. */
  routePollMs?: number;
  /**
   * Path for the persistent RSSI/RTT sparkline history (JSON ring on /data).
   * Empty/null → in-memory only (dev/test). Falls back to `HISTORY_PATH` env.
   */
  historyPath?: string | null;
  /** How often to flush history to disk (ms). Falls back to env; default 30s. */
  historyFlushMs?: number;
  /**
   * Path for the persistent per-node EVIDENCE store (M2 — the symptom engine's
   * time-series substrate; JSON ring on /data). Empty/null → in-memory only.
   * Falls back to `EVIDENCE_PATH` env.
   */
  evidencePath?: string | null;
  /** Evidence sample cadence (ms) — one sample per node per tick. Default = routePollMs. */
  evidenceSampleMs?: number;
  /** How often to flush evidence to disk (ms). Falls back to env; default 30s. */
  evidenceFlushMs?: number;
  /**
   * READ-ONLY zwave-js driver WS (v0.13, DESIGN §2.1) — feeds background RSSI
   * (real noise floor), node lastSeen, and listening/FLiRS flags. Empty/null ⇒
   * disabled; the add-on runs fine without it (dependent telemetry stays null).
   */
  driverWsUrl?: string | null;
  /** Persistent BASELINES store (M3). Empty/null ⇒ in-memory only. */
  baselinesPath?: string | null;
  /** Persistent OUTCOMES ledger (M5). Empty/null ⇒ in-memory (re-learns on restart). */
  outcomesPath?: string | null;
  log?: (msg: string) => void;
}

export interface ZwaveData {
  /** Begin discovery + polling (idempotent). */
  start(): void;
  /** Last cached node roster (sorted by node id). */
  snapshot(): NodeSnapshot[];
  /** Last cached controller snapshot, or null before the first poll. */
  controller(): ControllerSnapshot | null;
  /** True once the first roster load has completed. */
  ready(): boolean;
  /** Last poll/discovery error, or null. */
  lastError(): string | null;
  /** Epoch ms of the last successful roster refresh (null before the first). */
  lastUpdated(): number | null;
  /** Epoch ms of the last statistics event (node or controller), or null. */
  lastStatsUpdated(): number | null;
  /** Rolling RSSI/RTT history for a node (for sparklines). */
  history(nodeId: number): { rssi: number[]; rtt: number[] };
  /** Coarse long-horizon RSSI/RTT trend for a node (~2h). */
  historyLong(nodeId: number): { rssi: number[]; rtt: number[] };
  /** Per-node evidence samples (M2) — windowed counter deltas + instantaneous
   *  values, newest last. Read by the symptom engine (M3). Empty if unavailable. */
  evidence(nodeId: number): EvidenceSample[];
  /** Coarse 30-min evidence buckets (baseline substrate; up to 14 days). */
  evidenceCoarse(nodeId: number): CoarseBucket[];
  /** Controller serial-link evidence samples. */
  evidenceController(): ControllerSample[];
  /** Event-latched route failures for a node (newest last). */
  evidenceRouteFailures(nodeId: number): RouteFailureEvent[];
  /** Coverage metadata — how long/how much the store has observed this node,
   *  plus live subscription state (a coverage hole ≠ node silence). */
  evidenceCoverage(nodeId: number): (NodeCoverage & { statusFeedLive: boolean; statsFeedLive: boolean }) | null;
  /** node id → HA device_id (for mutating actions). */
  deviceIdOf(nodeId: number): string | null;
  /** node id → its ping button entity_id. */
  pingEntityOf(nodeId: number): string | null;
  /** Append an operator-action outcome to the event ring. */
  logAction(severity: LogEvent['severity'], nodeId: number | null, text: string): void;
  /** Event + command log ring (newest first). */
  events(): LogEvent[];
  /** The resolved config-entry id (null until discovered). */
  getEntryId(): string | null;
  /** Engine-detected symptoms (M3), ranked. */
  symptoms(): Symptom[];
  /** Engine enabled + graduated-baseline count (M3 Remedy empty state). */
  engineStatus(): { enabled: boolean; ready: number; total: number };
  /** M5: fold an operator action's outcome into the learning ledger. */
  recordActionOutcome(actionKind: ActionKind, nodeId: number | null, ok: boolean): void;
  /** M5: learned efficacy of an action against a symptom kind (null if off). */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy | null;
  /** M6: interference view (noise floor, serial health, diurnal heatmap). */
  interference(): InterferenceView;
  /** v0.22: a node's entities joined with their current live state (DETAIL). */
  entityStates(nodeId: number): EntityLiveState[];
  /** v0.22: cached config-parameter result for a node (DETAIL). */
  configParams(nodeId: number): ConfigParamsResult;
  /** v0.22: idempotently trigger a node's async config-param fetch. */
  requestConfigParams(nodeId: number): void;
  /** v0.23: drop a node's cached config params after a write (forces re-fetch). */
  invalidateConfigParams(nodeId: number): void;
  /** Stop polling and clear timers. */
  stop(): void;
}

/* ─── label maps (zwave-js enums) ───────────────────────────────────────── */

const SECURITY_CLASS_LABEL: Record<number, string> = {
  [-1]: 'None',
  0: 'S2 Unauthenticated',
  1: 'S2 Authenticated',
  2: 'S2 Access Control',
  7: 'S0 Legacy',
};

const RF_REGION_LABEL: Record<number, string> = {
  0: 'Europe',
  1: 'USA',
  2: 'Australia/New Zealand',
  3: 'Hong Kong',
  5: 'India',
  6: 'Israel',
  7: 'Russia',
  8: 'China',
  9: 'USA (Long Range)',
  11: 'Europe (Long Range)',
  32: 'Default (EU)',
  254: 'Unknown',
};

function securityClassLabel(n: number | null | undefined): string | null {
  if (n == null) return null;
  return SECURITY_CLASS_LABEL[n] ?? `class ${n}`;
}

function rfRegionLabel(n: number | null | undefined): string | null {
  if (n == null) return null;
  return RF_REGION_LABEL[n] ?? `region ${n}`;
}

/**
 * Sanitize an externally-sourced label (Z-Wave node/entity names come from the
 * device database and user renames — untrusted). Strips C0 control bytes + DEL
 * (which includes ESC 0x1b, so a crafted name can't inject ANSI escapes into a
 * TUI frame) and caps the length so one long name can't blow the layout.
 */
function sanitizeLabel(s: string): string {
  return s
    // Strip C0 + DEL + C1 controls (incl. ESC 0x1b and the 8-bit CSI 0x9b) so a
    // crafted device name can't inject ANSI escapes into a TUI frame.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    // Fold wide / astral code points (CJK, Hangul, kana, fullwidth, emoji, and
    // lone surrogates) to a single-cell placeholder so they can't desync the
    // fixed-width column accounting.
    .replace(/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\ud800-\udfff]/g, '?')
    .slice(0, 48);
}

/** All-null stats — v0.1 has no live statistics subscription yet. */
function emptyStats(): NodeStats {
  return {
    rtt: null,
    rssi: null,
    lwr: null,
    nlwr: null,
    commandsTX: 0,
    commandsRX: 0,
    commandsDroppedTX: 0,
    commandsDroppedRX: 0,
    timeoutResponse: 0,
    lastSeen: null,
  };
}

/** Extract the numeric node id from a device's zwave_js identifiers. */
function nodeIdOfDevice(d: RawDevice): number | null {
  const ids = d.identifiers;
  if (!Array.isArray(ids)) return null;
  for (const id of ids) {
    // Each identifier is a tuple like ['zwave_js', '<home_id>-<node_id>...'].
    if (Array.isArray(id) && id[0] === 'zwave_js' && typeof id[1] === 'string') {
      const n = Number(id[1].split('-')[1]);
      if (Number.isInteger(n)) return n;
    }
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class ZwaveDataImpl implements ZwaveData {
  private readonly client: HaWsClient;
  private readonly refreshMs: number;
  private readonly routePollMs: number;
  private readonly log: (msg: string) => void;

  private entryId: string | null;
  private registriesLoaded = false;
  /** True when the entry_id was explicitly configured (not auto-discovered) —
   *  a seeded id is never cleared by the self-heal path. */
  private entrySeeded = false;
  private lastOkAt: number | null = null;
  private deviceByNodeId = new Map<number, DeviceRec>();
  private deviceIdToNodeId = new Map<string, number>();
  private entitiesByDeviceId = new Map<string, NodeEntity[]>();
  private entityCount = 0;
  /** v0.8 entity_id → {node, friendly name, domain} for the activity log's
   *  state_changed → value-event mapping. Only ENABLED zwave entities land here
   *  (disabled ones emit no state), so this covers exactly what can fire. */
  private entityIndex = new Map<string, { nodeId: number; name: string; domain: string }>();
  /** Last time a chatty numeric `sensor` entity was logged — throttles telemetry
   *  streams so one power/energy sensor can't flood the activity ring. Discrete
   *  events (binary_sensor/lock/light/…) are NEVER throttled. */
  private lastValueAt = new Map<string, number>();

  // v0.2 live statistics, merged into each NodeSnapshot / ControllerSnapshot.
  private statsByNode = new Map<number, NodeStats>();
  /** v0.4 rolling per-node RSSI/RTT history for sparklines (bounded ring). */
  private histByNode = new Map<number, { rssi: number[]; rtt: number[] }>();
  /** v0.5 disk persistence for `histByNode` (null → in-memory only). */
  private readonly historyStore: HistoryStore | null;
  private readonly historyFlushMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** v0.7 coarse long-horizon ring (1 downsampled pt/min) + its interval mean
   *  accumulator (per node, since the last coarse tick). */
  private histLongByNode = new Map<number, { rssi: number[]; rtt: number[] }>();
  private coarseAccum = new Map<number, { rssiSum: number; rssiN: number; rttSum: number; rttN: number }>();
  private coarseTimer: ReturnType<typeof setInterval> | null = null;
  /** M2 evidence store (null → in-memory only) + its sample/flush cadence timers. */
  private readonly evidenceStore: EvidenceStore | null;
  private readonly evidenceSampleMs: number;
  private readonly evidenceFlushMs: number;
  private evidenceSampleTimer: ReturnType<typeof setInterval> | null = null;
  private evidenceFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Event-driven per-node accumulators, drained into each evidence sample
   *  (DESIGN §3.1): Alive↔Dead transitions must be counted from EVENTS —
   *  level-sampling the roster status misses sub-window flaps by construction. */
  private flapAccum = new Map<number, number>();
  private routeChangeAccum = new Map<number, number>();
  /** Nodes with a live `subscribe_node_status` subscription (flap source).
   *  Nodes NOT in this set fall back to the 2 s roster diff for flap counting. */
  private statusSubbed = new Set<number>();
  /** Last status seen by the node-status SUBSCRIPTION (not the roster poll). */
  private subStatus = new Map<number, NodeStatus>();
  /** Freshness signature at the previous evidence sample: fresh requires BOTH
   *  a new stats event (lastSeen advanced) AND counter movement — a
   *  (re)subscribe redelivers the current snapshot with a fresh lastSeen but
   *  unchanged counters, which must NOT count as an observation (review). */
  private prevSampleSig = new Map<number, SampleSig>();
  /** Nodes with a live node-STATISTICS subscription (per-feed retry tracking). */
  private statsSubbedNodes = new Set<number>();
  /** Roster ids currently absent → first-absent timestamp (eviction timer). */
  private missingSince = new Map<number, number>();
  /** ctrlStats object identity at the previous evidence sample (freshness). */
  private prevCtrlStatsRef: ControllerSnapshot['statistics'] = null;
  /** Devices whose per-node subscriptions failed — retried on a slow timer. */
  private pendingNodeSubs = new Map<number, string>();
  private subRetryTimer: ReturnType<typeof setInterval> | null = null;
  /** v0.13 read-only driver-WS telemetry (null = disabled). */
  private readonly driverWs: DriverWsClient | null;
  /** Latest driver background RSSI (per-channel averages) + arrival time. */
  private driverBgRssi: { channels: BgRssiChannels; at: number } | null = null;
  /** Driver-side lastSeen per node (epoch ms — REAL last communication). */
  private driverLastSeen = new Map<number, number>();
  /** Driver-reported capability flags per node. */
  private driverListening = new Map<number, { isListening: boolean | null; isFrequentListening: boolean | null }>();
  /** homeId the driver server reported — cross-checked against HA's. */
  private driverHomeId: number | null = null;
  /** Latched once a driver/HA homeId mismatch is proven (permanent this run —
   *  the driver_ws_url points at a different network; a config fix + restart
   *  clears it). Once set, ALL driver telemetry is rejected. */
  private driverHomeMismatch = false;
  /** M3 engine: learned baselines, dwell state, and the last computed symptoms. */
  private readonly baselines: BaselineStore | null;
  private readonly symptomState: SymptomState = new Map();
  private lastSymptoms: Symptom[] = [];
  /** Keys of symptoms already logged, so only NEW ones emit a log line. */
  private loggedSymptomKeys = new Set<string>();
  /** M5 outcome LEDGER (learned efficacy vs the no-action control arm). */
  private readonly outcomes: OutcomeStore | null;
  /** Symptom key → first tick it went absent, for the confirmation-window before
   *  an episode is resolved (an improvement must HOLD, not just blink). */
  private readonly pendingResolve = new Map<string, number>();
  private outcomesFlushTimer: ReturnType<typeof setInterval> | null = null;
  private baselineFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** M6 interference view, memoized on the sample cadence (heavy coarse fold). */
  private lastInterference: { at: number; view: InterferenceView } | null = null;
  /** Controller home_id from the last poll — a change means a different Z-Wave
   *  network (stick swap / different NVM backup), so node-keyed caches alias. */
  private lastHomeId: number | null = null;
  /** Epoch ms the current rebuild-routes began (null = idle) — set on the
   *  is_rebuilding_routes false→true edge so the UI can show elapsed time. */
  private rebuildStartedAt: number | null = null;
  private ctrlStats: ControllerSnapshot['statistics'] = null;
  /** Battery level (%) per node, from get_states of the *_battery entities. */
  private batteryByNode = new Map<number, number>();
  /** Battery-level sensor entity_id → node id (built with the registry join). */
  private batteryEntityToNode = new Map<string, number>();
  /** node id → its `button.*_ping` entity_id (for the ping action). */
  private pingEntityByNode = new Map<number, string>();
  /** node id → its `update.*` firmware entity_ids (a node may have >1 target). */
  private updateEntitiesByNode = new Map<number, string[]>();
  /** `update.*` firmware entity_id → node id (for the get_states join). */
  private updateEntityToNode = new Map<string, number>();
  /** Firmware-update status per node, from get_states of the update entities. */
  private firmwareByNode = new Map<number, FirmwareInfo>();
  /** v0.22: LIVE state per entity_id (state string + selected attributes),
   *  seeded from get_states and kept fresh by the state_changed subscription.
   *  Read by entityStates(node) — the DETAIL screen's live entity list. */
  private stateByEntityId = new Map<string, { state: string; attrs: Record<string, unknown> }>();
  /** v0.22: lazy per-node config-parameter cache (zwave_js/get_config_parameters).
   *  Keyed by node id; absent = never requested. A fetch flips it through
   *  loading → ready|error|unsupported so the DETAIL screen can show progress. */
  private configByNode = new Map<number, ConfigParamsResult>();
  /** v0.22: epoch ms of the last config-param fetch attempt per node — throttles
   *  error retries so a Detail screen that re-requests every frame can't hammer. */
  private configFetchAt = new Map<number, number>();
  /** Epoch ms of the last statistics event (node or controller) — freeze/health probe. */
  private lastStatsAt: number | null = null;
  /** Node status from the previous poll — diffed to log alive/dead/wake events. */
  private prevStatus = new Map<number, NodeStatus>();
  /** Event + command log ring (newest first), consumed by the Log screen. */
  private logRing: LogEvent[] = [];
  /** Monotonic event-id source (see pushEvent). Session-scoped; resets on boot. */
  private logSeq = 0;
  /** True once statistics subscriptions are live on the CURRENT connection. */
  private statsSubscribed = false;

  private lastNodes: NodeSnapshot[] = [];
  private lastController: ControllerSnapshot | null = null;
  private isReady = false;
  private lastErr: string | null = null;

  private started = false;
  private stopped = false;
  private errStreak = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ZwaveDataOptions) {
    this.client = opts.client;
    this.refreshMs = opts.refreshMs ?? Number(process.env.REFRESH_INTERVAL_MS ?? 2000);
    this.routePollMs = opts.routePollMs ?? Number(process.env.ROUTE_POLL_INTERVAL_MS ?? 10_000);
    this.log = opts.log ?? (() => {});
    const seed = opts.entryId ?? process.env.ZWAVE_ENTRY_ID ?? '';
    this.entrySeeded = seed !== '';
    this.entryId = this.entrySeeded ? seed : null;

    // Persistent sparkline history: seed the in-memory rings from the last
    // on-disk snapshot so a restart isn't visually empty. Disabled (null) in
    // dev/test where no path is configured.
    const histPath = (opts.historyPath ?? process.env.HISTORY_PATH) || null;
    // A garbage HISTORY_FLUSH_MS must fall back to the default, not NaN (which
    // would silently disable the periodic flush via the `> 0` guard in start()).
    const flushMs = opts.historyFlushMs ?? Number(process.env.HISTORY_FLUSH_MS ?? 30_000);
    this.historyFlushMs = Number.isFinite(flushMs) ? flushMs : 30_000;
    this.historyStore = histPath
      ? createHistoryStore({ path: histPath, maxSamples: HIST_MAX, log: this.log })
      : null;
    if (this.historyStore) {
      for (const [id, h] of this.historyStore.load()) {
        this.histByNode.set(id, { rssi: h.rssi, rtt: h.rtt });
        if (h.crssi.length || h.crtt.length) this.histLongByNode.set(id, { rssi: h.crssi, rtt: h.crtt });
      }
    }

    // M2 evidence store: the symptom engine's persistent per-node time series.
    // Sampled on its own cadence (default = the route-poll cadence) from the
    // latest cached stats, so windows are regular even though the driver pushes
    // statistics event-driven. load() restores prior samples; the in-memory
    // counter baselines re-establish on the first post-restart sample per node.
    const evPath = (opts.evidencePath ?? process.env.EVIDENCE_PATH) || null;
    const evSample = opts.evidenceSampleMs ?? Number(process.env.EVIDENCE_SAMPLE_MS ?? this.routePollMs);
    this.evidenceSampleMs = Number.isFinite(evSample) && evSample > 0 ? evSample : this.routePollMs;
    // Flush is dirty-flagged in the store; 5 min default bounds crash loss to a
    // few samples without grinding SD cards with full-file rewrites (DR).
    const evFlush = opts.evidenceFlushMs ?? Number(process.env.EVIDENCE_FLUSH_MS ?? 300_000);
    this.evidenceFlushMs = Number.isFinite(evFlush) ? evFlush : 300_000;
    this.evidenceStore = evPath
      ? createEvidenceStore({ path: evPath, cadenceMs: this.evidenceSampleMs, log: this.log })
      : null;
    this.evidenceStore?.load();
    // M3 engine: per-node learned baselines (persisted; boot-grace KEEPS them).
    const blPath = (opts.baselinesPath ?? process.env.BASELINES_PATH) || null;
    this.baselines = blPath ? createBaselineStore({ path: blPath, log: this.log }) : null;
    this.baselines?.load();
    this.log(`M3 engine: ${this.baselines ? 'baselines enabled' : 'baselines disabled (no BASELINES_PATH)'}`);
    // M5 outcome ledger — only meaningful when the engine (baselines+evidence)
    // runs, so gate it on the same substrate. Persists if OUTCOMES_PATH is set,
    // else in-memory (re-learns after a restart — honest, not a fault).
    const ocPath = (opts.outcomesPath ?? process.env.OUTCOMES_PATH) || undefined;
    this.outcomes = this.baselines ? createOutcomeStore({ path: ocPath, log: this.log }) : null;
    this.outcomes?.load();
    this.log(`M5 engine: ${this.outcomes ? `outcome learning enabled${ocPath ? ' (persisted)' : ' (in-memory)'}` : 'outcome learning off (no baselines)'}`);
    // v0.13: READ-ONLY driver-WS telemetry client (DESIGN §2.1). Dormant-not-
    // fatal by construction; its feeds are guarded by the homeId cross-check
    // (a misconfigured URL pointing at a DIFFERENT network's server must never
    // pollute this network's evidence).
    const driverUrl = (opts.driverWsUrl ?? process.env.DRIVER_WS_URL ?? '').trim() || null;
    this.driverWs = driverUrl
      ? createDriverWsClient({
          url: driverUrl,
          log: this.log,
          callbacks: {
            onHomeId: (id) => {
              this.driverHomeId = id;
            },
            onBgRssi: (channels, at) => {
              if (!this.driverHomeOk()) return;
              this.driverBgRssi = { channels, at };
            },
            onNodeLastSeen: (nodeId, seen) => {
              if (!this.driverHomeOk()) return;
              const prev = this.driverLastSeen.get(nodeId);
              if (prev == null || seen > prev) this.driverLastSeen.set(nodeId, seen);
            },
            onNodeFlags: (nodeId, flags) => {
              if (!this.driverHomeOk()) return;
              this.driverListening.set(nodeId, flags);
            },
          },
        })
      : null;
  }

  /** Combine the fine + coarse rings into the store's two-tier shape. */
  private buildHistoryMap(): HistoryMap {
    const m: HistoryMap = new Map();
    const ids = new Set<number>([...this.histByNode.keys(), ...this.histLongByNode.keys()]);
    for (const id of ids) {
      const fine = this.histByNode.get(id) ?? { rssi: [], rtt: [] };
      const coarse = this.histLongByNode.get(id) ?? { rssi: [], rtt: [] };
      m.set(id, { rssi: fine.rssi, rtt: fine.rtt, crssi: coarse.rssi, crtt: coarse.rtt });
    }
    return m;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    // Every (re)authentication reloads the registry join (an HA Core restart
    // can rename/re-area devices) and re-establishes the statistics
    // subscriptions (they are per-connection and die when the socket closes).
    this.client.onReady(() => {
      this.registriesLoaded = false;
      this.statsSubscribed = false;
      void this.subscribeStatistics();
    });
    void this.tick();

    // Periodically flush the sparkline rings to /data so a restart is seamless.
    // `.unref()` keeps this timer from holding the event loop open at shutdown.
    if (this.historyStore && !this.flushTimer && this.historyFlushMs > 0) {
      this.flushTimer = setInterval(() => {
        this.historyStore!.save(this.buildHistoryMap());
      }, this.historyFlushMs);
      this.flushTimer.unref?.();
    }

    // Coarse downsampler: once a minute, fold each node's interval mean into its
    // long-horizon ring. Always runs (in-memory even without a store) so the
    // Detail long-trend sparkline works regardless of persistence.
    if (!this.coarseTimer) {
      this.coarseTimer = setInterval(() => this.rollCoarse(), COARSE_INTERVAL_MS);
      this.coarseTimer.unref?.();
    }

    // M2 evidence: sample every node with cached stats on a regular cadence, and
    // periodically flush the store to /data. Both timers `.unref()` so they never
    // hold the event loop open at shutdown.
    this.driverWs?.start();
    if (this.baselines && !this.baselineFlushTimer) {
      this.baselineFlushTimer = setInterval(() => this.baselines!.save(), 5 * 60_000);
      this.baselineFlushTimer.unref?.();
    }
    if (this.outcomes && !this.outcomesFlushTimer) {
      this.outcomesFlushTimer = setInterval(() => this.outcomes!.save(), 5 * 60_000);
      this.outcomesFlushTimer.unref?.();
    }
    if (this.evidenceStore) {
      if (!this.evidenceSampleTimer && this.evidenceSampleMs > 0) {
        this.evidenceSampleTimer = setInterval(() => this.sampleEvidence(), this.evidenceSampleMs);
        this.evidenceSampleTimer.unref?.();
      }
      if (!this.evidenceFlushTimer && this.evidenceFlushMs > 0) {
        this.evidenceFlushTimer = setInterval(() => this.evidenceStore!.save(), this.evidenceFlushMs);
        this.evidenceFlushTimer.unref?.();
      }
    }
  }

  /**
   * Record one evidence sample per node that has reported statistics, from the
   * latest cached NodeStats and the authoritative roster status.
   *
   * DISCIPLINES (DESIGN §3.1, from the design review):
   *  - WEDGE GUARD: when the roster feed itself is stale (no successful poll
   *    within ~2× refreshMs) the whole tick is SKIPPED — a gap in the ring is
   *    honest; re-recording stale caches under fresh timestamps fabricates
   *    healthy-looking windows.
   *  - FRESHNESS: `fresh` is true iff a stats event arrived since the previous
   *    sample (stats.lastSeen advanced). rssi/rtt are driver EMAs — re-sampling
   *    them without a new event is pseudo-replication, which downstream
   *    collapses MAD to 0. Baselines must ingest fresh samples only.
   *  - FLAPS/ROUTE CHANGES are drained from EVENT-driven accumulators — the
   *    status column in the sample is dwell context only; sub-window Alive↔Dead
   *    flaps are invisible to level-sampling by construction.
   *  - COVERAGE: every roster node is registered (even before its first stats
   *    event) so "no evidence rows" is distinguishable from "node unknown".
   */
  /**
   * May driver-WS telemetry be applied? Only when the driver server's homeId
   * matches HA's. We are OPTIMISTIC while either side is still unknown (the
   * driver's fast state dump often lands before HA's first network_status
   * poll), so data admitted during that startup window must be PURGED the
   * moment a mismatch becomes provable — otherwise a driver_ws_url pointing at
   * a DIFFERENT Z-Wave network would leave that network's lastSeen/isListening
   * aliased under this network's node ids for the life of the process (v0.13
   * review, high). On first mismatch we also QUIESCE the client so it stops
   * parsing the foreign event stream entirely.
   */
  private driverHomeOk(): boolean {
    const g = driverHomeGuard(this.driverHomeId, this.lastHomeId, this.driverHomeMismatch);
    if (g.newlyMismatched) {
      // First provable mismatch: the URL is misconfigured. Latch it, scrub every
      // datum admitted during the optimistic acceptance window, and stop the
      // client so it stops parsing the foreign network's event stream.
      this.driverHomeMismatch = true;
      this.driverBgRssi = null;
      this.driverLastSeen.clear();
      this.driverListening.clear();
      this.driverWs?.stop();
      this.log(`driver-ws: server homeId ${this.driverHomeId} ≠ HA homeId ${this.lastHomeId} — telemetry PURGED + client stopped (check driver_ws_url)`);
    }
    return g.ok;
  }

  /** Driver-WS status line for logs/diagnostics (never payload data). */
  driverWsStatus(): string {
    return this.driverWs?.status() ?? 'disabled (no driver_ws_url)';
  }

  private sampleEvidence(): void {
    if (!this.evidenceStore) return;
    const now = Date.now();
    // Wedge guard: don't synthesize samples out of a stale cache.
    if (this.lastOkAt == null || now - this.lastOkAt > Math.max(2 * this.refreshMs, 10_000)) return;
    for (const n of this.lastNodes) {
      this.evidenceStore.registerNode(n.nodeId, now);
      const stats = this.statsByNode.get(n.nodeId);
      // A node with NO cached stats yet cannot produce a sample (fabricating
      // zero counters would poison the delta guards). Its flap/route events
      // stay accumulated and drain into its FIRST real sample — attributed to
      // a longer-than-usual window, whose length is visible via the t gap.
      if (!stats) continue;
      const prev = this.prevSampleSig.get(n.nodeId);
      const fresh = isFreshSample(prev, stats);
      this.prevSampleSig.set(n.nodeId, {
        seen: stats.lastSeen ?? 0, tx: stats.commandsTX, rx: stats.commandsRX,
        to: stats.timeoutResponse, dr: stats.commandsDroppedTX,
      });
      const flaps = this.flapAccum.get(n.nodeId) ?? 0;
      const routeChanges = this.routeChangeAccum.get(n.nodeId) ?? 0;
      this.flapAccum.delete(n.nodeId);
      this.routeChangeAccum.delete(n.nodeId);
      // Driver-WS telemetry (v0.13): the REAL last-communication time and the
      // listening/FLiRS capability — null when the client is absent/dormant.
      const drvSeen = this.driverLastSeen.get(n.nodeId) ?? null;
      const drvFlags = this.driverListening.get(n.nodeId);
      this.evidenceStore.record(
        n.nodeId, stats, n.status,
        { flaps, routeChanges, fresh, lastSeen: drvSeen, isListening: drvFlags?.isListening ?? null, isFrequentListening: drvFlags?.isFrequentListening ?? null },
        now,
      );
    }
    // Controller serial-link sample through the same delta guards, carrying the
    // driver-WS noise floor when it is FRESH (driver auto-polls ~30s on idle;
    // a stale reading is recorded as null, not re-used — honest unknown).
    if (this.ctrlStats) {
      const ctrlFresh = this.ctrlStats !== this.prevCtrlStatsRef;
      this.prevCtrlStatsRef = this.ctrlStats;
      const bg =
        this.driverBgRssi && now - this.driverBgRssi.at <= 90_000 && this.driverHomeOk()
          ? this.driverBgRssi.channels
          : null;
      this.evidenceStore.recordController(this.ctrlStats, ctrlFresh, now, bg);
    }
    this.runEngine(now);
  }

  /**
   * M3 engine tick: detect symptoms from the current evidence + baselines, log
   * newly-appeared ones to the Activity Log, then fold the just-recorded samples
   * into the baselines — QUARANTINING nodes that currently have a symptom so the
   * baseline never chases the pathology (DESIGN §3.2/§3.3).
   */
  private runEngine(now: number): void {
    if (!this.evidenceStore || !this.baselines) return;
    const ev = this.evidenceStore;
    const bl = this.baselines;
    const symptoms = detectSymptoms(
      {
        now,
        nodes: this.lastNodes,
        controller: this.lastController,
        baselines: bl,
        latest: (id) => { const r = ev.forNode(id); return r.length ? r[r.length - 1] : undefined; },
        recent: (id) => ev.forNode(id),
        coarse: (id) => ev.coarseForNode(id),
        controllerSamples: () => ev.controllerSamples(),
        coverage: (id) => ev.coverage(id),
        recordingSince: () => ev.recordingSince(),
        hasRealNoise: () =>
          this.driverBgRssi != null && now - this.driverBgRssi.at <= 90_000 && this.driverHomeOk(),
      },
      this.symptomState,
    );
    this.lastSymptoms = symptoms;
    // Log NEW symptoms once (source 'net', kind 'symptom'); prune resolved keys.
    const live = new Set<string>();
    for (const sym of symptoms) {
      const k = `${sym.nodeId ?? 'mesh'}:${sym.kind}`;
      live.add(k);
      if (!this.loggedSymptomKeys.has(k)) {
        this.loggedSymptomKeys.add(k);
        const sev = sym.severity === 'crit' ? 'error' : sym.severity === 'warn' ? 'warn' : 'info';
        this.pushEvent('net', sev, 'symptom', sym.nodeId, `${sym.kind}${sym.subsumedBy ? ' (under mesh event)' : ''}: ${sym.narrative.split('.')[0]}`);
      }
    }
    for (const k of [...this.loggedSymptomKeys]) if (!live.has(k)) this.loggedSymptomKeys.delete(k);
    // M5: advance the outcome ledger's episode lifecycle off the same signal.
    this.updateEpisodes(symptoms, now);
    // Fold the freshest sample per node into the baselines, quarantining nodes
    // that are SYMPTOMATIC OR ARMING (any active dwell) — folding the pre-dwell
    // breach would ratchet the baseline toward the pathology (v0.14 review).
    const quarantine = symptomaticNodes(symptoms);
    for (const id of armingNodes(this.symptomState)) quarantine.add(id);
    for (const n of this.lastNodes) {
      if (n.isController) continue;
      const ring = ev.forNode(n.nodeId);
      if (ring.length === 0) continue;
      bl.observe(n.nodeId, ring[ring.length - 1], quarantine.has(n.nodeId));
    }
  }

  /** M5 episode lifecycle (called each engine tick). Opens an episode when a
   *  NON-subsumed symptom appears (a subsumed one's fate belongs to the mesh
   *  event, so counting it would pollute the base rate), and resolves it only
   *  after the symptom has stayed gone for a CONFIRMATION window — a blink of
   *  improvement is not a recovery, and the extra dwell also lets the
   *  after-window settle past the transition. */
  private updateEpisodes(symptoms: Symptom[], now: number): void {
    const oc = this.outcomes;
    if (!oc) return;
    const CONFIRM_MS = 10 * 60_000;
    const { toOpen, toResolve } = planEpisodeLifecycle(symptoms, oc.openEpisodes(), this.pendingResolve, now, CONFIRM_MS);
    // Capture the degraded before-window at onset and the settled after-window
    // at resolution (well past the transition, thanks to the confirm window).
    for (const s of toOpen) oc.open(s.nodeId, s.kind, now, this.nodeWindow(s.nodeId, now));
    for (const r of toResolve) oc.resolve(r.nodeId, r.kind, now, this.nodeWindow(r.nodeId, now));
  }

  /** The per-command reliability window for a node (last 5 min of evidence), for
   *  episode before/after scoring. Mesh-scoped symptoms have no per-node
   *  evidence → null (rendered `unverifiable` rather than fabricated).
   *
   *  SCOPING LIMITATION (M5): success is scored by the per-command TIMEOUT rate
   *  — the primary reliability signal, apt for the return-path / timeout family.
   *  A symptom kind whose recovery does NOT show up as a timeout-rate change
   *  (e.g. a purely RSSI-based weak-signal, or rate-fallback where the node still
   *  responds) simply yields no measurable improvement → its episodes read
   *  `unverifiable`/`no-change` and accrue no efficacy. That is honest (no false
   *  claim), just incomplete; per-kind recovery metrics are a future refinement. */
  private nodeWindow(nodeId: number | null, now: number): ReturnType<typeof windowMetrics> | null {
    if (nodeId == null || !this.evidenceStore) return null;
    const WINDOW_MS = 5 * 60_000;
    const ring = this.evidenceStore.forNode(nodeId).filter((s) => now - s.t <= WINDOW_MS);
    return ring.length ? windowMetrics(ring) : null;
  }

  /** Attribute an operator action's outcome to the ledger (M5). Called by the
   *  ActionRunner AFTER each action. A driver refusal of a diagnosis-verifying
   *  action (removeFailed on a live node) is `refused` → refused-misdiagnosis;
   *  a plain failed action (couldn't run) is NOT attributed as "taken". */
  recordActionOutcome(actionKind: ActionKind, nodeId: number | null, ok: boolean): void {
    // Mesh-wide actions (rebuildAll/stopRebuild, nodeId == null) are NOT
    // attributed: they can't be credited to any single node's episode without
    // confounding, so they are deliberately dropped from the ledger.
    if (!this.outcomes || nodeId == null) return;
    // Only SUCCESSFUL operator actions become episode data. A FAILED action is
    // not "taken", and we intentionally do NOT infer `refused-misdiagnosis` from
    // a failure here: the operator-action hook cannot distinguish a genuine
    // driver refusal ("node is not failed") from a transient WS/connectivity
    // error, and a node-scoped stamp would wrongly mark non-ghost symptoms. That
    // verdict is reserved for a future executor that receives structured driver
    // errors (§3.5); here we stay conservative and never fabricate a false
    // positive against a detector.
    if (!ok) return;
    // Do not credit an action against an episode whose symptom already went
    // absent (it's in the confirmation window recovering on its own).
    const skip = (key: string): boolean => this.pendingResolve.has(key);
    this.outcomes.recordAction(nodeId, actionKind, false, Date.now(), skip);
  }

  /** Learned efficacy of an action against a symptom kind (M5) — for the planner. */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy | null {
    return this.outcomes ? this.outcomes.efficacyFor(kind, action) : null;
  }

  /** Engine-detected symptoms (M3), ranked; [] when the engine is off. */
  symptoms(): Symptom[] {
    return this.lastSymptoms;
  }

  /** M6 interference view — memoized on the ~10s sample cadence. The diurnal
   *  aggregation folds every node's coarse buckets (~26k), so it must NOT run
   *  per render frame (the screen redraws at 1 Hz). */
  interference(): InterferenceView {
    const now = Date.now();
    if (this.lastInterference && now - this.lastInterference.at < 10_000) return this.lastInterference.view;
    const bgChannels =
      this.driverBgRssi && now - this.driverBgRssi.at <= 90_000 && this.driverHomeOk()
        ? this.driverBgRssi.channels
        : null;
    const coarseByNode = new Map<number, import('./evidenceStore').CoarseBucket[]>();
    if (this.evidenceStore) {
      for (const n of this.lastNodes) {
        if (n.isController) continue;
        const cb = this.evidenceStore.coarseForNode(n.nodeId);
        if (cb.length) coarseByNode.set(n.nodeId, cb);
      }
    }
    const controllerSamples = this.evidenceStore ? this.evidenceStore.controllerSamples() : [];
    const controllerCoarse = this.evidenceStore ? this.evidenceStore.controllerCoarse() : [];
    const view = computeInterference({ now, bgChannels, controllerSamples, controllerCoarse, coarseByNode, symptoms: this.lastSymptoms });
    this.lastInterference = { at: now, view };
    return view;
  }

  /** Honest engine state for the Remedy screen: whether the engine is enabled,
   *  and how many nodes have a graduated timeout baseline vs total — so the
   *  screen can distinguish "off" / "still learning" / "all healthy". */
  engineStatus(): { enabled: boolean; ready: number; total: number } {
    if (!this.baselines) return { enabled: false, ready: 0, total: 0 };
    const now = Date.now();
    let ready = 0;
    let total = 0;
    for (const n of this.lastNodes) {
      if (n.isController) continue;
      total += 1;
      if (this.baselines.timeoutNormal(n.nodeId, now)?.ready) ready += 1;
    }
    return { enabled: true, ready, total };
  }

  /** Fold each node's since-last-tick interval mean into its coarse ring. */
  private rollCoarse(): void {
    for (const [id, a] of this.coarseAccum) {
      const coarse = this.histLongByNode.get(id) ?? { rssi: [], rtt: [] };
      if (a.rssiN > 0) {
        coarse.rssi.push(Math.round(a.rssiSum / a.rssiN));
        if (coarse.rssi.length > COARSE_MAX) coarse.rssi.shift();
      }
      if (a.rttN > 0) {
        coarse.rtt.push(Math.round(a.rttSum / a.rttN));
        if (coarse.rtt.length > COARSE_MAX) coarse.rtt.shift();
      }
      this.histLongByNode.set(id, coarse);
    }
    this.coarseAccum.clear();
  }

  snapshot(): NodeSnapshot[] {
    return this.lastNodes;
  }

  controller(): ControllerSnapshot | null {
    return this.lastController;
  }

  ready(): boolean {
    return this.isReady;
  }

  lastError(): string | null {
    return this.lastErr;
  }

  getEntryId(): string | null {
    return this.entryId;
  }

  lastUpdated(): number | null {
    return this.lastOkAt;
  }

  /* ── action-runner resolvers (v0.3) ─────────────────────────────────────── */
  deviceIdOf(nodeId: number): string | null {
    return this.deviceByNodeId.get(nodeId)?.id ?? null;
  }
  pingEntityOf(nodeId: number): string | null {
    return this.pingEntityByNode.get(nodeId) ?? null;
  }
  /** Append an operator-action outcome to the event ring (source 'you'). */
  logAction(severity: LogEvent['severity'], nodeId: number | null, text: string): void {
    this.pushEvent('you', severity, 'action', nodeId, text);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.coarseTimer) {
      clearInterval(this.coarseTimer);
      this.coarseTimer = null;
    }
    if (this.evidenceSampleTimer) {
      clearInterval(this.evidenceSampleTimer);
      this.evidenceSampleTimer = null;
    }
    if (this.evidenceFlushTimer) {
      clearInterval(this.evidenceFlushTimer);
      this.evidenceFlushTimer = null;
    }
    if (this.subRetryTimer) {
      clearInterval(this.subRetryTimer);
      this.subRetryTimer = null;
    }
    this.driverWs?.stop();
    // Fold any pending interval into the coarse ring, then persist BOTH tiers on
    // the way down (SIGTERM from a deploy/restart) so trends resume seamlessly.
    this.rollCoarse();
    this.historyStore?.save(this.buildHistoryMap());
    // Persist the evidence store as-is. Deliberately NO final sample: the caches
    // may be minutes stale by shutdown, and a stale snapshot under a fresh
    // timestamp would fabricate a healthy-looking window (DR).
    this.evidenceStore?.save();
    if (this.baselineFlushTimer) {
      clearInterval(this.baselineFlushTimer);
      this.baselineFlushTimer = null;
    }
    this.baselines?.save();
    if (this.outcomesFlushTimer) {
      clearInterval(this.outcomesFlushTimer);
      this.outcomesFlushTimer = null;
    }
    this.outcomes?.save();
  }

  /* ─── polling ──────────────────────────────────────────────────────── */

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let ok = false;
    try {
      ok = await this.refresh();
    } catch (e) {
      this.lastErr = errMsg(e);
      this.log(`refresh failed: ${this.lastErr}`);
      ok = false;
    }
    if (this.stopped) return;
    if (ok) {
      this.errStreak = 0;
      this.scheduleNext(this.refreshMs);
    } else {
      // Back off on repeated failure (e.g. dev without token, HA restarting) so
      // we don't spin the socket; capped so recovery stays timely.
      this.errStreak++;
      // Self-heal: after a few consecutive failures on an AUTO-DISCOVERED entry,
      // the id may be stale (the integration was removed + re-added, minting a
      // new entry_id + device_ids). Force a fresh discovery + registry reload.
      // A user-configured (seeded) entry is left alone.
      if (this.errStreak >= 3 && !this.entrySeeded && this.entryId) {
        this.log('repeated failures — re-discovering zwave_js entry + reloading registries');
        this.entryId = null;
        this.registriesLoaded = false;
        // The old entry's statistics subscriptions are stale/orphaned — drop the
        // frozen stats and re-subscribe once the new registry loads (below).
        this.statsSubscribed = false;
        this.statsByNode.clear();
        this.batteryByNode.clear();
        this.firmwareByNode.clear();
        // v0.22 live-state + config caches are keyed by the OLD network's
        // entity_ids / node ids — drop them so a re-discovered mesh starts clean.
        this.stateByEntityId.clear();
        this.configByNode.clear();
        this.configFetchAt.clear();
        // Force a clean reconnect so the old (still-open-socket) subscriptions —
        // controller/node stats, state_changed, notifications — are RELEASED
        // (handleClose clears the event handlers) before onReady re-subscribes.
        // Without this, re-subscribing on the same socket double-delivers every
        // activity event. It also short-circuits a wedged session's 30s heartbeat.
        this.client.reconnect();
        // NOTE: histByNode + histLongByNode are intentionally NOT cleared. They are keyed by Z-Wave
        // node id (stable across a config-entry re-discovery) and is display-only,
        // so preserving it keeps the sparkline trend continuous through a wedge —
        // the whole point of the v0.5 persistence. New samples push out old ones.
      }
      const backoff = this.refreshMs * 2 ** Math.min(this.errStreak, 5);
      this.scheduleNext(Math.max(this.refreshMs, Math.min(30_000, backoff)));
    }
  }

  private async refresh(): Promise<boolean> {
    const entryId = await this.ensureEntryId();
    if (!entryId) {
      this.lastErr = 'no zwave_js config entry found';
      return false;
    }
    await this.ensureRegistries();
    // Recover statistics subscriptions after a self-heal re-discovery (onReady
    // won't fire without a Core-WS reconnect). No-op on the normal path where
    // onReady already subscribed.
    if (!this.statsSubscribed) void this.subscribeStatistics();
    // ANTI-FOOTGUN: entry_id, NOT config_entry_id.
    const net = await this.client.send<RawNetworkStatus>({
      type: 'zwave_js/network_status',
      entry_id: entryId,
    });
    const ctrl = net?.controller;
    if (!ctrl || !Array.isArray(ctrl.nodes)) {
      this.lastErr = 'network_status returned no controller/nodes';
      return false;
    }
    if (ctrl.nodes.length === 0) {
      // A degenerate empty roster would wipe the last-good view; keep it and
      // surface the condition instead (there is always at least the controller).
      this.lastErr = 'network_status returned an empty node list';
      return false;
    }
    const nodes = ctrl.nodes.map((n) => this.buildNode(n)).sort((a, b) => a.nodeId - b.nodeId);
    // Diff status vs the previous poll → log alive/dead/asleep transitions.
    for (const n of nodes) {
      const prev = this.prevStatus.get(n.nodeId);
      if (prev !== undefined && prev !== n.status) {
        const sev = n.status === NodeStatus.Dead ? 'error' : 'info';
        this.pushEvent('net', sev, 'status', n.nodeId, `${n.name} → ${n.statusLabel}`);
        // Flap-count FALLBACK for nodes without a live node-status subscription
        // (subscribe failed + retry pending). The event feed is the primary
        // source — feeding both would double-count the same transition.
        if (!this.statusSubbed.has(n.nodeId)) {
          const crossedDead = (prev === NodeStatus.Dead) !== (n.status === NodeStatus.Dead);
          if (crossedDead) this.flapAccum.set(n.nodeId, (this.flapAccum.get(n.nodeId) ?? 0) + 1);
        }
      }
      this.prevStatus.set(n.nodeId, n.status);
    }
    // Departed-node eviction (review): a node absent from the roster for 5+
    // minutes has left the network (excluded / replace_failed_node). Its
    // evidence must be EVICTED — node-id reuse would otherwise merge two
    // physical devices' histories and pre-satisfy the ghost detector's
    // coverage precondition. 5-min dwell rides out transient roster glitches.
    {
      const present = new Set(nodes.map((n) => n.nodeId));
      const now = Date.now();
      for (const id of [...this.prevStatus.keys()]) {
        if (present.has(id)) {
          this.missingSince.delete(id);
          continue;
        }
        const since = this.missingSince.get(id);
        if (since == null) {
          this.missingSince.set(id, now);
        } else if (now - since > 5 * 60_000) {
          this.log(`node ${id} left the network — evicting its evidence + caches`);
          this.evidenceStore?.evictNode(id);
          this.statsByNode.delete(id);
          this.histByNode.delete(id);
          this.histLongByNode.delete(id);
          this.coarseAccum.delete(id);
          this.batteryByNode.delete(id);
          this.firmwareByNode.delete(id);
          // v0.22 config cache is node-id-keyed too — a reused id would otherwise
          // keep serving the DEPARTED device's parameters (the 'ready' state is
          // terminal, never re-fetched), and buildRegistryMaps' prune can't help
          // because the reused id IS present in the new registry.
          this.configByNode.delete(id);
          this.configFetchAt.delete(id);
          // Live-state is entity-id-keyed (new devices mint new entity_ids, so no
          // cross-device aliasing), but drop the departed device's entries so they
          // don't linger if the registry never reloads.
          const depDev = this.deviceByNodeId.get(id);
          if (depDev) {
            for (const e of this.entitiesByDeviceId.get(depDev.id) ?? []) this.stateByEntityId.delete(e.entityId);
          }
          this.flapAccum.delete(id);
          this.routeChangeAccum.delete(id);
          this.subStatus.delete(id);
          this.statusSubbed.delete(id);
          this.statsSubbedNodes.delete(id);
          this.pendingNodeSubs.delete(id);
          this.prevSampleSig.delete(id);
          this.prevStatus.delete(id);
          this.missingSince.delete(id);
          this.driverLastSeen.delete(id);
          this.driverListening.delete(id);
          // M5: abandon any open episodes for the departed node — their after-
          // window would be empty, and a node-id reuse after replace_failed_node
          // must start clean (mirrors the evidence eviction).
          if (this.outcomes) {
            for (const ep of this.outcomes.openEpisodes()) {
              if (ep.nodeId === id) { this.outcomes.abandon(ep.nodeId, ep.kind); this.pendingResolve.delete(ep.key); }
            }
          }
        }
      }
    }
    this.lastNodes = nodes;
    this.lastController = this.buildController(ctrl);
    // Network-identity guard: the per-node stats + sparkline history are keyed
    // by numeric node id. If the controller's home_id changes, those ids now
    // refer to a DIFFERENT physical network (stick swap / different NVM backup
    // restore), so the caches would alias one node's data onto another. Drop
    // them on an identity change only — NOT on a plain reconnect, where home_id
    // is stable (that's what lets v0.5 persistence survive an HA-Core restart).
    const homeId = this.lastController.homeId;
    if (homeId != null) {
      if (this.lastHomeId != null && homeId !== this.lastHomeId) {
        this.log(`controller home_id ${this.lastHomeId} → ${homeId} (network changed) — resetting caches + registries`);
        this.statsByNode.clear();
        this.batteryByNode.clear();
        this.histByNode.clear();
        this.histLongByNode.clear();
        this.coarseAccum.clear();
        this.firmwareByNode.clear();
        // v0.22 live-state + config caches belong to the OLD network's entities.
        this.stateByEntityId.clear();
        this.configByNode.clear();
        this.configFetchAt.clear();
        // Evidence accumulators are node-id-keyed too.
        this.flapAccum.clear();
        this.routeChangeAccum.clear();
        this.subStatus.clear();
        this.prevSampleSig.clear();
        this.missingSince.clear();
        // The controller cache belongs to the OLD network — post-reset samples
        // must not be recorded from its counters (review).
        this.ctrlStats = null;
        this.prevCtrlStatsRef = null;
        // Driver-WS telemetry is node-id-keyed too; the homeId guard will
        // re-validate feeds against the NEW network.
        this.driverBgRssi = null;
        this.driverLastSeen.clear();
        this.driverListening.clear();
        // M3 engine state is node-id-keyed — a different network invalidates it.
        this.baselines?.reset();
        this.symptomState.clear();
        this.lastSymptoms = [];
        this.loggedSymptomKeys.clear();
        // M5 ledger is per-mesh too — wipe episodes + learned efficacy AND
        // persist the empty state, else a restart would reload the OLD network's
        // learning from /data (the reset must write THROUGH to disk).
        this.outcomes?.reset();
        this.outcomes?.save();
        this.pendingResolve.clear();
        // M6 interference view is derived from this network's evidence — drop the
        // memoized snapshot so it recomputes against the new network immediately.
        this.lastInterference = null;
        // The new network gets a fresh homeId cross-check; restart the driver
        // client so it re-handshakes and re-validates (start() after stop() is
        // supported — see driverWsClient.stop()).
        this.driverHomeMismatch = false;
        this.driverWs?.stop();
        this.driverWs?.start();
        this.prevStatus.clear(); // else the first poll logs spurious status transitions
        // The registry-derived maps (entityIndex/deviceByNodeId/…) are now stale:
        // the new network's entity_ids won't be in entityIndex, so the activity
        // log's value capture would go DARK. Force a full re-discovery + a clean
        // re-subscribe against the new device_ids via a reconnect (onReady resets
        // registriesLoaded + statsSubscribed and rebuilds everything — and, as in
        // the self-heal path, this releases the old subscriptions cleanly).
        this.registriesLoaded = false;
        this.client.reconnect();
      }
      this.lastHomeId = homeId;
      // Bind the live network identity to the evidence store: on the FIRST
      // known home id this validates any restored evidence against it (a stick
      // swapped while the add-on was stopped must not resurrect the previous
      // network's history under new node ids); on a live change it resets +
      // rewrites disk. No-op when unchanged.
      this.evidenceStore?.bindHomeId(homeId);
    }
    this.lastErr = null;
    this.isReady = true;
    this.lastOkAt = Date.now();
    return true;
  }

  private async ensureEntryId(): Promise<string | null> {
    if (this.entryId) return this.entryId;
    const entries = await this.client.send<RawConfigEntry[]>({ type: 'config_entries/get' });
    const zwave = (entries ?? []).filter((e) => e.domain === 'zwave_js');
    const chosen = zwave.find((e) => e.state === 'loaded') ?? zwave[0];
    this.entryId = chosen?.entry_id ?? null;
    if (this.entryId) this.log(`discovered zwave_js entry_id=${this.entryId}`);
    return this.entryId;
  }

  private async ensureRegistries(): Promise<void> {
    if (this.registriesLoaded) return;
    const [devices, entities] = await Promise.all([
      this.client.send<RawDevice[]>({ type: 'config/device_registry/list' }),
      this.client.send<RawEntity[]>({ type: 'config/entity_registry/list' }),
    ]);
    this.buildRegistryMaps(devices ?? [], entities ?? []);
    this.registriesLoaded = true;
    this.log(`registry join: ${this.deviceByNodeId.size} z-wave nodes, ${this.entityCount} entities`);
  }

  private buildRegistryMaps(devices: RawDevice[], entities: RawEntity[]): void {
    const deviceByNodeId = new Map<number, DeviceRec>();
    const deviceIdToNodeId = new Map<string, number>();
    for (const d of devices) {
      const nodeId = nodeIdOfDevice(d);
      if (nodeId == null) continue;
      deviceByNodeId.set(nodeId, {
        id: d.id,
        name: sanitizeLabel(d.name_by_user || d.name || `Node ${nodeId}`),
        // Sanitize these too — they reach the Detail/Controller frames and are
        // externally sourced (device DB / user config).
        area: d.area_id ? sanitizeLabel(d.area_id) : null,
        manufacturer: d.manufacturer ? sanitizeLabel(d.manufacturer) : null,
        model: d.model ? sanitizeLabel(d.model) : null,
      });
      deviceIdToNodeId.set(d.id, nodeId);
    }

    const entitiesByDeviceId = new Map<string, NodeEntity[]>();
    // Rebuilt fresh on every (re)join so a removed node leaves no stale mapping.
    this.updateEntitiesByNode.clear();
    this.updateEntityToNode.clear();
    this.entityIndex.clear();
    let count = 0;
    for (const e of entities) {
      if (e.platform !== 'zwave_js') continue;
      if (e.disabled_by != null) continue; // skip disabled diagnostics — keep the list meaningful
      if (!e.device_id || !deviceIdToNodeId.has(e.device_id)) continue;
      const domain = e.entity_id.split('.')[0];
      const friendly = sanitizeLabel(e.original_name ?? e.name ?? '') || undefined;
      const list = entitiesByDeviceId.get(e.device_id) ?? [];
      list.push({ entityId: e.entity_id, domain, name: friendly });
      entitiesByDeviceId.set(e.device_id, list);
      // Index for the activity log's state_changed → value-event mapping.
      this.entityIndex.set(e.entity_id, {
        nodeId: deviceIdToNodeId.get(e.device_id)!,
        name: friendly ?? e.entity_id,
        domain,
      });
      count++;
      // Remember the battery-level sensor so we can read its % from get_states.
      if (e.entity_id.startsWith('sensor.') && /battery/i.test(e.entity_id)) {
        this.batteryEntityToNode.set(e.entity_id, deviceIdToNodeId.get(e.device_id)!);
      }
      // Remember the ping button for the v0.3 ping action.
      if (e.entity_id.startsWith('button.') && /ping/i.test(e.entity_id)) {
        this.pingEntityByNode.set(deviceIdToNodeId.get(e.device_id)!, e.entity_id);
      }
      // Remember the firmware update entity/-ies (device_class 'firmware', read
      // from get_states). These are `zwave_js`-platform update.* entities on a
      // node device — the add-on/integration `update.*` entities are a different
      // platform and aren't on a node device, so they never land here.
      if (e.entity_id.startsWith('update.')) {
        const nid = deviceIdToNodeId.get(e.device_id)!;
        const arr = this.updateEntitiesByNode.get(nid) ?? [];
        arr.push(e.entity_id);
        this.updateEntitiesByNode.set(nid, arr);
        this.updateEntityToNode.set(e.entity_id, nid);
      }
    }

    const oldDeviceByNodeId = this.deviceByNodeId; // captured BEFORE overwrite (device-change eviction)
    this.deviceByNodeId = deviceByNodeId;
    this.deviceIdToNodeId = deviceIdToNodeId;
    this.entitiesByDeviceId = entitiesByDeviceId;
    this.entityCount = count;
    // v0.22: prune live-state to what the fresh registry still knows, so entities
    // removed from the mesh can't leak memory across registry reloads (surviving
    // entries are kept — no Detail flicker).
    for (const eid of this.stateByEntityId.keys()) {
      if (!this.entityIndex.has(eid)) this.stateByEntityId.delete(eid);
    }
    // v0.22: evict the node-id-keyed config cache whenever a node's backing HA
    // device_id CHANGES — not just when the node departs. This is the robust
    // close for node-id reuse (replace_failed_node / fast exclude→include keeps
    // the id but swaps the device: A→B) AND for a node that had no device at
    // first Detail view and later gained one (null→present) — a stale 'ready' or
    // terminal 'unsupported' entry would otherwise serve the wrong device or stay
    // stuck forever (both confirmed by adversarial review). Absent→null is a
    // change too, so this also subsumes the plain removed-node prune.
    for (const nid of this.configByNode.keys()) {
      const oldDevId = oldDeviceByNodeId.get(nid)?.id ?? null;
      const newDevId = deviceByNodeId.get(nid)?.id ?? null;
      if (oldDevId !== newDevId) {
        this.configByNode.delete(nid);
        this.configFetchAt.delete(nid);
      }
    }
  }

  private buildNode(raw: RawNode): NodeSnapshot {
    const nodeId = raw.node_id;
    const dev = this.deviceByNodeId.get(nodeId);
    const status = (raw.status ?? NodeStatus.Unknown) as NodeStatus;
    const isController = raw.is_controller_node === true || nodeId === 1;
    return {
      nodeId,
      deviceId: dev?.id ?? '',
      name: dev?.name ?? `Node ${nodeId}`,
      area: dev?.area ?? null,
      status,
      statusLabel: NODE_STATUS_LABEL[status] ?? 'unknown',
      ready: raw.ready === true,
      isRouting: raw.is_routing === true,
      // network_status doesn't expose is_listening; v0.2 derives it from the
      // node's CC info (FLiRS/sleeping). null = unknown, not "listening".
      // HA network_status omits is_listening; the driver-WS state dump (v0.13)
      // supplies it — the battery/FLiRS guards and quiet-node detector need it.
      isListening: this.driverListening.get(raw.node_id)?.isListening ?? null,
      isLongRange: nodeId >= 256,
      isController,
      isSecure: raw.is_secure ?? null,
      securityClass: securityClassLabel(raw.highest_security_class),
      manufacturer: dev?.manufacturer ?? null,
      model: dev?.model ?? null,
      battery: this.batteryByNode.has(nodeId)
        ? { level: this.batteryByNode.get(nodeId)!, isLow: this.batteryByNode.get(nodeId)! <= 25 }
        : null,
      firmware: this.firmwareByNode.get(nodeId) ?? null,
      stats: this.statsByNode.get(nodeId) ?? emptyStats(),
      entities: dev ? this.entitiesByDeviceId.get(dev.id) ?? [] : [],
    };
  }

  private buildController(raw: RawController): ControllerSnapshot {
    const dev = this.deviceByNodeId.get(raw.own_node_id ?? 1) ?? this.deviceByNodeId.get(1);
    // Track the rebuild-routes start on the false→true edge; clear when it ends.
    // HA exposes only the boolean (no per-node progress), so the UI shows honest
    // elapsed time, never a fabricated percentage.
    const rebuilding = raw.is_rebuilding_routes === true;
    if (rebuilding) {
      this.rebuildStartedAt ??= Date.now();
    } else {
      this.rebuildStartedAt = null;
    }
    return {
      homeId: raw.home_id ?? null,
      nodeId: raw.own_node_id ?? 1,
      sdkVersion: raw.sdk_version ?? null,
      firmwareVersion: raw.firmware_version ?? null,
      rfRegion: rfRegionLabel(raw.rf_region),
      isPrimary: raw.is_primary === true,
      isSUC: raw.is_suc === true,
      isSISPresent: raw.is_sis_present === true,
      manufacturer: dev?.manufacturer ?? null,
      model: dev?.model ?? null,
      isRebuildingRoutes: rebuilding,
      rebuildStartedAt: this.rebuildStartedAt,
      firmwareUpdatesAvailable: [...this.firmwareByNode.values()].filter((f) => f.updateAvailable).length,
      // HA strips background RSSI at its WS boundary; the driver-WS client
      // (v0.13) restores it. Staleness-gated: a reading older than 90s (the
      // driver polls every ~30s when idle) reverts to [] → "noise —", never a
      // re-used stale floor.
      backgroundRSSI:
        this.driverBgRssi && Date.now() - this.driverBgRssi.at <= 90_000 && this.driverHomeOk()
          ? leadingRun(this.driverBgRssi.channels)
          : [],
      statistics: this.ctrlStats,
    };
  }

  /** Rolling event/command log (newest first) for the Log screen. */
  events(): LogEvent[] {
    return this.logRing;
  }

  private pushEvent(
    source: LogEvent['source'],
    severity: LogEvent['severity'],
    kind: LogKind,
    nodeId: number | null,
    text: string,
    extra?: Partial<Pick<LogEvent, 'entityId' | 'entityName' | 'domain' | 'oldState' | 'newState'>>,
  ): void {
    // `seq` is a monotonic id (newest = highest) so the Log screen can anchor its
    // selection to an event identity that survives new events prepending.
    this.logRing.unshift({ seq: this.logSeq++, ts: Date.now(), source, severity, kind, nodeId, text, ...extra });
    if (this.logRing.length > LOG_MAX) this.logRing.length = LOG_MAX;
  }

  /**
   * Establish the live statistics subscriptions on the current connection.
   * Idempotent per connection; re-run on every (re)auth via `onReady`.
   * Subscribing delivers each node's CURRENT statistics immediately, so the
   * roster fully populates within seconds with no pinging.
   */
  private async subscribeStatistics(): Promise<void> {
    if (this.statsSubscribed) return;
    this.statsSubscribed = true;
    try {
      const entryId = await this.ensureEntryId();
      if (!entryId) { this.statsSubscribed = false; return; }
      await this.ensureRegistries();

      await this.client.subscribe(
        { type: 'zwave_js/subscribe_controller_statistics', entry_id: entryId },
        (msg) => this.onControllerStats(msg.event),
      );

      // Two subscriptions per end node (node 1 = controller, covered above):
      // statistics (counters/routes) + node status (the EVENT-driven flap
      // source — the roster poll only sees transitions that survive 2 s).
      const nodeDevices = [...this.deviceByNodeId.entries()].filter(([nodeId]) => nodeId !== 1);
      this.statusSubbed.clear();
      this.statsSubbedNodes.clear();
      this.subStatus.clear();
      this.pendingNodeSubs.clear();
      await Promise.all(nodeDevices.map(([nodeId, dev]) => this.subscribeNode(nodeId, dev.id)));
      this.log(`live statistics: subscribed controller + ${nodeDevices.length} nodes (${this.statusSubbed.size} status feeds)`);
      // Failed per-node subscriptions are retried on a slow timer — a silent
      // .catch-and-forget hole in coverage is exactly what the ghost detector
      // must never inherit (DR).
      if (this.pendingNodeSubs.size > 0 && !this.subRetryTimer) {
        this.subRetryTimer = setInterval(() => void this.retryNodeSubs(), 60_000);
        this.subRetryTimer.unref?.();
      }
      await this.subscribeActivityEvents();
      void this.fetchEntityStates();
    } catch (e) {
      this.statsSubscribed = false;
      this.log(`subscribeStatistics failed: ${errMsg(e)}`);
    }
  }

  /** Subscribe one node's statistics + status feeds; failures queue for retry.
   *  PER-FEED idempotent (review): a retry must only re-attempt the feed that
   *  actually failed — re-subscribing a live feed leaks a duplicate
   *  subscription per retry and double-counts every event thereafter. */
  private async subscribeNode(nodeId: number, deviceId: string): Promise<void> {
    let ok = true;
    if (!this.statsSubbedNodes.has(nodeId)) {
      try {
        await this.client.subscribe(
          { type: 'zwave_js/subscribe_node_statistics', device_id: deviceId },
          (msg) => this.onNodeStats(msg.event),
        );
        this.statsSubbedNodes.add(nodeId);
      } catch (e) {
        ok = false;
        this.log(`node-stats subscribe failed (node ${nodeId}): ${errMsg(e)}`);
      }
    }
    if (!this.statusSubbed.has(nodeId)) {
      try {
        await this.client.subscribe(
          { type: 'zwave_js/subscribe_node_status', device_id: deviceId },
          (msg) => this.onNodeStatusEvent(nodeId, msg.event),
        );
        // Seed the event-feed state from the roster so the FIRST event after
        // subscribing diffs against the node's known status instead of being
        // swallowed (review: a real Alive→Dead as the first event counted 0).
        if (!this.subStatus.has(nodeId)) {
          const known = this.prevStatus.get(nodeId);
          if (known != null) this.subStatus.set(nodeId, known);
        }
        this.statusSubbed.add(nodeId);
      } catch (e) {
        ok = false;
        this.statusSubbed.delete(nodeId);
        this.log(`node-status subscribe failed (node ${nodeId}): ${errMsg(e)}`);
      }
    }
    if (!ok) this.pendingNodeSubs.set(nodeId, deviceId);
    else this.pendingNodeSubs.delete(nodeId);
  }

  private async retryNodeSubs(): Promise<void> {
    if (this.pendingNodeSubs.size === 0) {
      if (this.subRetryTimer) {
        clearInterval(this.subRetryTimer);
        this.subRetryTimer = null;
      }
      return;
    }
    const pending = [...this.pendingNodeSubs.entries()];
    await Promise.all(pending.map(([nodeId, deviceId]) => this.subscribeNode(nodeId, deviceId)));
  }

  /**
   * Event-driven node-status feed (`zwave_js/subscribe_node_status`) — the flap
   * source. Counts every transition ACROSS the Dead boundary into `flapAccum`,
   * drained per evidence sample. Nodes without a live feed fall back to the 2 s
   * roster diff (which misses sub-2 s flaps — better than nothing, worse than
   * events; the set membership records which source a node is on).
   */
  private onNodeStatusEvent(nodeId: number, ev: unknown): void {
    const e = ev as Record<string, unknown> | null;
    if (!e) return;
    const name = typeof e.event === 'string' ? e.event : null;
    const next: NodeStatus | null =
      name === 'dead' ? NodeStatus.Dead
      : name === 'alive' ? NodeStatus.Alive
      : name === 'sleep' ? NodeStatus.Asleep
      : name === 'wake up' ? NodeStatus.Awake
      : null; // 'ready' and unknown events are not status transitions
    if (next == null) return;
    const prev = this.subStatus.get(nodeId);
    this.subStatus.set(nodeId, next);
    if (prev == null) return; // first observation — no transition yet
    const crossedDead = (prev === NodeStatus.Dead) !== (next === NodeStatus.Dead);
    if (crossedDead) this.flapAccum.set(nodeId, (this.flapAccum.get(nodeId) ?? 0) + 1);
  }

  /**
   * v0.8 activity log: subscribe to device value changes (`state_changed`,
   * filtered to this mesh's entities) + `zwave_js_notification`. Re-established
   * on every (re)auth via the same `subscribeStatistics` path, so a reconnect
   * resumes the live feed. Notifications are best-effort (the event type may
   * never fire on a given mesh); the state feed is the primary source.
   */
  private async subscribeActivityEvents(): Promise<void> {
    try {
      await this.client.subscribe(
        { type: 'subscribe_events', event_type: 'state_changed' },
        (msg) => this.onStateChanged(msg.event),
      );
      await this.client
        .subscribe(
          { type: 'subscribe_events', event_type: 'zwave_js_notification' },
          (msg) => this.onZwaveNotification(msg.event),
        )
        .catch(() => {
          /* best-effort — some meshes never emit notifications */
        });
      // A visible marker in the activity log itself so a (re)connect is legible
      // right where the user is watching — useful given the WS can wedge.
      this.pushEvent('net', 'info', 'system', null, `activity feed live — watching ${this.entityIndex.size} device entities`);
      this.log(`activity log: subscribed state_changed + notifications (${this.entityIndex.size} entities)`);
    } catch (e) {
      this.log(`activity subscribe failed: ${errMsg(e)}`);
    }
  }

  /** Map an HA `state_changed` event → a `value` activity-log entry (tracked
   *  zwave entities only). Ignores no-op churn and throttles numeric telemetry. */
  private onStateChanged(ev: unknown): void {
    // (1) Keep the LIVE-state cache fresh for tracked entities — done FIRST and
    // unconditionally, so attribute-only changes (a dimmer level moving while
    // state stays "on") and throttled/no-op sensor updates still refresh Detail.
    this.updateLiveState(ev);
    // (2) The value-log mapping (throttled, skips no-op transitions).
    const m = mapStateChanged(ev, this.entityIndex, Date.now(), this.lastValueAt);
    if (!m) return;
    this.pushEvent('net', 'info', 'value', m.nodeId, m.text, {
      entityId: m.entityId,
      entityName: m.entityName,
      domain: m.domain,
      oldState: m.oldState,
      newState: m.newState,
    });
  }

  /** Refresh {@link stateByEntityId} from a raw `state_changed` event, for tracked
   *  mesh entities only. Drops removals (new_state null) so the last known good
   *  state lingers rather than vanishing mid-frame. */
  private updateLiveState(ev: unknown): void {
    const d = (ev as { data?: { entity_id?: string; new_state?: { state?: string; attributes?: Record<string, unknown> } | null } } | null)?.data;
    const eid = d?.entity_id;
    if (!eid || !this.entityIndex.has(eid)) return;
    const ns = d?.new_state;
    if (!ns || typeof ns.state !== 'string') return; // removal / malformed — keep prior
    // Sanitize the device-controlled state string before it can reach a TUI frame
    // (strips control/ESC bytes + folds wide chars — same boundary as the value
    // log, notifications, and device names; an un-sanitized state could inject a
    // newline/ANSI and corrupt the exact-rows frame).
    this.stateByEntityId.set(eid, { state: sanitizeLabel(ns.state), attrs: pickDisplayAttrs(ns.attributes) });
  }

  /** Map a `zwave_js_notification` event → a `notification` log entry (defensive:
   *  the payload shape varies by notification type/CC). */
  private onZwaveNotification(ev: unknown): void {
    const d = (ev as { data?: Record<string, unknown> } | null)?.data;
    if (!d) return;
    const nodeId = typeof d.node_id === 'number' ? d.node_id : null;
    const label = String(d.label ?? d.event_label ?? d.command_class_name ?? 'notification');
    const val = d.event_label ?? d.event ?? d.value ?? d.parameters;
    const raw = val != null && String(val) !== label ? `${label}: ${String(val).slice(0, 48)}` : label;
    this.pushEvent('net', 'info', 'notification', nodeId, sanitizeLabel(raw));
  }

  /**
   * Read slow-moving entity states in one get_states pass: battery levels AND
   * firmware-update status. Both change rarely, so this rides the same cadence
   * as the battery poll (called after each registry (re)load / on reconnect).
   */
  private async fetchEntityStates(): Promise<void> {
    // entityIndex ⊇ (battery ∪ update ∪ every other tracked mesh entity); an
    // empty index means the registry hasn't loaded yet — nothing to seed.
    if (this.entityIndex.size === 0) return;
    try {
      const states = await this.client.send<RawEntityState[]>({ type: 'get_states' });
      for (const s of states) {
        const bNode = this.batteryEntityToNode.get(s.entity_id);
        if (bNode != null) {
          const lvl = Number(s.state);
          if (Number.isFinite(lvl)) this.batteryByNode.set(bNode, Math.round(lvl));
        }
        // Seed the LIVE-state cache for every tracked mesh entity (v0.22). The
        // state_changed subscription keeps it fresh after this; this pass fills
        // in everything that isn't currently transitioning.
        if (this.entityIndex.has(s.entity_id)) {
          this.stateByEntityId.set(s.entity_id, { state: sanitizeLabel(s.state), attrs: pickDisplayAttrs(s.attributes) });
        }
      }
      // Rebuilt fresh each pass (a node may have >1 firmware target — aggregated).
      this.firmwareByNode = aggregateFirmware(states, this.updateEntityToNode);
    } catch (e) {
      this.log(`entity states fetch failed: ${errMsg(e)}`);
    }
  }

  /** v0.22: a node's entities joined with their current live state. Order follows
   *  the registry entity order; entities with no state yet read `state: null`. */
  entityStates(nodeId: number): EntityLiveState[] {
    const devId = this.deviceIdOf(nodeId);
    const ents = devId ? this.entitiesByDeviceId.get(devId) ?? [] : [];
    return ents.map((e) => {
      const live = this.stateByEntityId.get(e.entityId);
      return {
        entityId: e.entityId,
        domain: e.domain,
        name: e.name ?? e.entityId,
        state: live ? live.state : null,
        attrs: live ? live.attrs : {},
      };
    });
  }

  /** v0.22: cached config-parameter result for a node (idle until first request). */
  configParams(nodeId: number): ConfigParamsResult {
    return this.configByNode.get(nodeId) ?? { status: 'idle', params: [] };
  }

  /** v0.23: drop a node's cached config parameters so the next requestConfigParams
   *  re-fetches — called after a successful set_config_parameter write. */
  invalidateConfigParams(nodeId: number): void {
    this.configByNode.delete(nodeId);
    this.configFetchAt.delete(nodeId);
  }

  /** v0.22: idempotently kick off a config-parameter fetch. No-op while loading,
   *  already-ready, or unsupported; errors retry after CONFIG_RETRY_MS. */
  requestConfigParams(nodeId: number): void {
    const cur = this.configByNode.get(nodeId);
    if (cur && (cur.status === 'loading' || cur.status === 'ready' || cur.status === 'unsupported')) return;
    if (cur?.status === 'error' && Date.now() - (this.configFetchAt.get(nodeId) ?? 0) < CONFIG_RETRY_MS) return;
    void this.fetchConfigParams(nodeId);
  }

  /** Async body of {@link requestConfigParams}. Fire-and-forget; never throws. */
  private async fetchConfigParams(nodeId: number): Promise<void> {
    const devId = this.deviceIdOf(nodeId);
    this.configFetchAt.set(nodeId, Date.now());
    if (!devId) {
      this.configByNode.set(nodeId, { status: 'unsupported', params: [], error: 'no HA device for this node' });
      return;
    }
    this.configByNode.set(nodeId, { status: 'loading', params: [] });
    try {
      const raw = await this.client.send<Record<string, RawConfigParam>>({ type: 'zwave_js/get_config_parameters', device_id: devId });
      this.configByNode.set(nodeId, { status: 'ready', params: mapConfigParams(raw) });
    } catch (e) {
      this.configByNode.set(nodeId, { status: 'error', params: [], error: errMsg(e) });
      this.log(`config params fetch failed for node ${nodeId}: ${errMsg(e)}`);
    }
  }

  /** Epoch ms of the last statistics event (node or controller), or null. */
  lastStatsUpdated(): number | null {
    return this.lastStatsAt;
  }

  /** Rolling RSSI/RTT history for a node (for sparklines). Empty when unknown. */
  history(nodeId: number): { rssi: number[]; rtt: number[] } {
    const h = this.histByNode.get(nodeId);
    return h ? { rssi: [...h.rssi], rtt: [...h.rtt] } : { rssi: [], rtt: [] };
  }

  /** Coarse long-horizon RSSI/RTT trend (1 pt/min ≈ 2h). Empty when unknown. */
  historyLong(nodeId: number): { rssi: number[]; rtt: number[] } {
    const h = this.histLongByNode.get(nodeId);
    return h ? { rssi: [...h.rssi], rtt: [...h.rtt] } : { rssi: [], rtt: [] };
  }

  /** Per-node evidence samples (M2). A copy, newest last; [] when none/no store. */
  evidence(nodeId: number): EvidenceSample[] {
    return this.evidenceStore ? [...this.evidenceStore.forNode(nodeId)] : [];
  }

  evidenceCoarse(nodeId: number): CoarseBucket[] {
    return this.evidenceStore ? [...this.evidenceStore.coarseForNode(nodeId)] : [];
  }

  evidenceController(): ControllerSample[] {
    return this.evidenceStore ? [...this.evidenceStore.controllerSamples()] : [];
  }

  evidenceRouteFailures(nodeId: number): RouteFailureEvent[] {
    return this.evidenceStore ? [...this.evidenceStore.routeFailures(nodeId)] : [];
  }

  evidenceCoverage(nodeId: number): (NodeCoverage & { statusFeedLive: boolean; statsFeedLive: boolean }) | null {
    const cov = this.evidenceStore?.coverage(nodeId);
    if (!cov) return null;
    // Subscription state is part of coverage (DESIGN §3.1): "no evidence" from
    // a node whose feeds are DOWN is a monitoring hole, not node silence.
    return { ...cov, statusFeedLive: this.statusSubbed.has(nodeId), statsFeedLive: this.statsSubbedNodes.has(nodeId) };
  }

  /** Map a raw node-statistics event → cached NodeStats. */
  private onNodeStats(ev: unknown): void {
    const e = ev as Record<string, unknown> | null;
    if (!e || e.source !== 'node') return;
    const nodeId = statsNodeId(e);
    if (nodeId == null) return;
    // COUNTER VALIDATION (DR): a malformed event whose counters are missing
    // must be REJECTED, not coerced to 0 — a coerced-0 snapshot re-baselines
    // the evidence deltas at zero, and the next real event's cumulative value
    // then lands as one giant fabricated "valid" delta. Skip the event whole;
    // the previous cached stats stay authoritative.
    const counters = statsCounters(e);
    if (!counters) {
      this.log(`node ${nodeId}: malformed statistics event (non-numeric counters) — ignored`);
      return;
    }
    this.lastStatsAt = Date.now();
    const prev = this.statsByNode.get(nodeId);
    const stats: NodeStats = {
      rtt: num(e.rtt),
      rssi: num(e.rssi),
      lwr: this.mapRoute(e.lwr),
      nlwr: this.mapRoute(e.nlwr),
      commandsTX: counters.tx,
      commandsRX: counters.rx,
      commandsDroppedTX: counters.dropTx,
      commandsDroppedRX: counters.dropRx,
      timeoutResponse: counters.timeout,
      lastSeen: Date.now(),
    };
    this.statsByNode.set(nodeId, stats);
    // routeFailedBetween is TRANSIENT (overwritten on the next OK transmission)
    // — latch it into the evidence store the moment it appears/changes (DR).
    const rf = stats.lwr?.routeFailedBetween ?? stats.nlwr?.routeFailedBetween ?? null;
    const prevRf = prev?.lwr?.routeFailedBetween ?? prev?.nlwr?.routeFailedBetween ?? null;
    // `prev` required: the first event per connection is a REPLAY of driver
    // state — latching its (possibly old) pair would fabricate a fresh
    // failure timestamp on every restart (review).
    if (prev && rf && (!prevRf || rf[0] !== prevRf[0] || rf[1] !== prevRf[1])) {
      this.evidenceStore?.recordRouteFailure(nodeId, rf);
    }

    // Append to the rolling history (skip RSSI sentinels 125/126/127), and
    // accumulate the same samples into the coarse interval mean (rollCoarse
    // folds them into the long-horizon ring once a minute).
    const h = this.histByNode.get(nodeId) ?? { rssi: [], rtt: [] };
    const acc = this.coarseAccum.get(nodeId) ?? { rssiSum: 0, rssiN: 0, rttSum: 0, rttN: 0 };
    if (stats.rssi != null && stats.rssi < 0 && stats.rssi > -128) {
      h.rssi.push(stats.rssi);
      if (h.rssi.length > HIST_MAX) h.rssi.shift();
      acc.rssiSum += stats.rssi;
      acc.rssiN += 1;
    }
    if (stats.rtt != null && stats.rtt >= 0) {
      h.rtt.push(stats.rtt);
      if (h.rtt.length > HIST_MAX) h.rtt.shift();
      acc.rttSum += stats.rtt;
      acc.rttN += 1;
    }
    this.histByNode.set(nodeId, h);
    this.coarseAccum.set(nodeId, acc);
    // Log a route change (repeater chain differs) so the mesh's re-routing is
    // visible — and count it into the evidence accumulator (route churn).
    if (prev && routeKey(prev.lwr) !== routeKey(stats.lwr)) {
      this.pushEvent('net', 'info', 'route', nodeId, `route → ${fmtRoute(stats.lwr)}`);
      this.routeChangeAccum.set(nodeId, (this.routeChangeAccum.get(nodeId) ?? 0) + 1);
    }
  }

  /** Map the raw controller-statistics event (note the misspelled key). */
  private onControllerStats(ev: unknown): void {
    const e = ev as Record<string, unknown> | null;
    if (!e || e.source !== 'controller') return;
    // Same rejection rule as node counters (DR): a malformed event coerced to
    // zeros would re-baseline the controller evidence deltas and fabricate a
    // giant delta on the next real event. ALL counters must be numeric.
    // timeout_response: HA's dev source misspells the key 'timout_response';
    // accept either spelling so an upstream fix can't zero the field forever.
    const msgTx = num(e.messages_tx);
    const msgRx = num(e.messages_rx);
    const msgDropTx = num(e.messages_dropped_tx);
    const msgDropRx = num(e.messages_dropped_rx);
    const nak = num(e.nak);
    const can = num(e.can);
    const tAck = num(e.timeout_ack);
    const tRes = num(e.timout_response) ?? num(e.timeout_response);
    if (msgTx == null || msgRx == null || msgDropTx == null || msgDropRx == null ||
        nak == null || can == null || tAck == null || tRes == null) {
      this.log('controller: malformed statistics event (non-numeric counters) — ignored');
      return;
    }
    this.lastStatsAt = Date.now();
    this.ctrlStats = {
      messagesTX: Math.trunc(msgTx),
      messagesRX: Math.trunc(msgRx),
      messagesDroppedTX: Math.trunc(msgDropTx),
      messagesDroppedRX: Math.trunc(msgDropRx),
      NAK: Math.trunc(nak),
      CAN: Math.trunc(can),
      timeoutACK: Math.trunc(tAck),
      timeoutResponse: Math.trunc(tRes),
    };
  }

  /** Convert a raw route (repeaters as HA device_ids) → RouteStat (node ids). */
  private mapRoute(r: unknown): RouteStat | null {
    return mapRouteRaw(r, (devId) => this.deviceIdToNodeId.get(String(devId)) ?? 0);
  }
}

/**
 * Resolve the node id from a raw statistics event. ★ HA delivers the INITIAL
 * (on-subscribe) event with `nodeId` (camelCase) but every SUBSEQUENT live push
 * with `node_id` (snake_case) — accept both or the stats freeze at their
 * subscribe-time values. Exported so a test pins this exact behaviour.
 */
export function statsNodeId(ev: Record<string, unknown> | null | undefined): number | null {
  if (!ev) return null;
  if (typeof ev.nodeId === 'number') return ev.nodeId;
  if (typeof ev.node_id === 'number') return ev.node_id;
  return null;
}

/**
 * Pure route mapper: HA repeaters/route_failed_between are device_id strings —
 * `resolve` maps them to node ids. repeaters + repeaterRSSI stay index-aligned
 * (127 = the driver's "no reading" sentinel). Exported for testing.
 */
export function mapRouteRaw(r: unknown, resolve: (dev: unknown) => number): RouteStat | null {
  const raw = r as Record<string, unknown> | null;
  if (!raw) return null;
  const rawReps = Array.isArray(raw.repeaters) ? raw.repeaters : [];
  const rawRssi = Array.isArray(raw.repeater_rssi) ? raw.repeater_rssi : [];
  const repeaters: number[] = [];
  const repeaterRSSI: number[] = [];
  for (let i = 0; i < rawReps.length; i++) {
    repeaters.push(resolve(rawReps[i]));
    repeaterRSSI.push(num(rawRssi[i]) ?? 127);
  }
  const rfb = raw.route_failed_between;
  return {
    repeaters,
    protocolDataRate: num(raw.protocol_data_rate),
    rssi: num(raw.rssi),
    repeaterRSSI,
    routeFailedBetween: Array.isArray(rfb) && rfb.length === 2 ? [resolve(rfb[0]), resolve(rfb[1])] : null,
  };
}

/** Coerce to a finite number or null. */
function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * The homeId cross-check decision (pure — the side-effecting purge/stop live in
 * `driverHomeOk`). OPTIMISTIC while either id is unknown (the driver's state
 * dump often precedes HA's first poll); once both are known a mismatch is
 * PROVEN and latches permanently (`latched`). Returns `newlyMismatched` on the
 * transition so the caller purges the acceptance-window data exactly once.
 */
export function driverHomeGuard(
  driverHomeId: number | null,
  haHomeId: number | null,
  latched: boolean,
): { ok: boolean; newlyMismatched: boolean } {
  if (latched) return { ok: false, newlyMismatched: false };
  if (driverHomeId == null || haHomeId == null) return { ok: true, newlyMismatched: false };
  if (driverHomeId === haHomeId) return { ok: true, newlyMismatched: false };
  return { ok: false, newlyMismatched: true };
}

/**
 * The leading contiguous run of present per-channel values. Background-RSSI
 * channels 0/1 are mandatory and 2/3 optional+trailing (RESEARCH §1.5), so the
 * consumer renders each entry as `ch<index>` — compacting with filter() would
 * misattribute ch1 as ch0 when ch0 is absent. Stopping at the first gap keeps
 * every surviving entry at its true channel index.
 */
export function leadingRun(channels: (number | null)[]): number[] {
  const out: number[] = [];
  for (const c of channels) {
    if (c == null) break;
    out.push(c);
  }
  return out;
}
/** Coerce to a finite integer, defaulting to 0. */
function int(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : 0;
}

/**
 * Validate a node-statistics event's cumulative counters. ALL five must be
 * finite numbers or the event is rejected (`null`) — coercing a missing field
 * to 0 re-baselines the evidence deltas at zero, and the next real event's
 * cumulative counter then lands as one giant fabricated "valid" delta (DR).
 * Exported for tests.
 */
/** The freshness signature captured at the previous evidence sample. */
export interface SampleSig {
  seen: number;
  tx: number;
  rx: number;
  to: number;
  dr: number;
}

/**
 * Is this sample a genuine OBSERVATION? Requires BOTH conjuncts (review):
 *  - a stats event arrived since the previous sample (lastSeen advanced), AND
 *  - at least one counter moved — a (re)subscribe redelivers the current
 *    snapshot under a fresh lastSeen with unchanged counters; treating that as
 *    an observation is the pseudo-replication leak that collapses MAD to 0.
 * First-ever sample (no signature) is NOT fresh — there is no baseline to
 * distinguish an observation from a replay.
 */
export function isFreshSample(prev: SampleSig | undefined, stats: NodeStats): boolean {
  if (prev == null) return false;
  const seen = stats.lastSeen ?? 0;
  const seenAdvanced = seen > 0 && seen !== prev.seen;
  const countersMoved =
    stats.commandsTX !== prev.tx || stats.commandsRX !== prev.rx ||
    stats.timeoutResponse !== prev.to || stats.commandsDroppedTX !== prev.dr;
  return seenAdvanced && countersMoved;
}

export function statsCounters(
  e: Record<string, unknown>,
): { tx: number; rx: number; dropTx: number; dropRx: number; timeout: number } | null {
  const tx = num(e.commands_tx);
  const rx = num(e.commands_rx);
  const dropTx = num(e.commands_dropped_tx);
  const dropRx = num(e.commands_dropped_rx);
  const timeout = num(e.timeout_response);
  if (tx == null || rx == null || dropTx == null || dropRx == null || timeout == null) return null;
  return { tx: Math.trunc(tx), rx: Math.trunc(rx), dropTx: Math.trunc(dropTx), dropRx: Math.trunc(dropRx), timeout: Math.trunc(timeout) };
}
/** A non-empty version string (numbers coerced), else null. */
function strOrNull(x: unknown): string | null {
  if (typeof x === 'string') return x.length ? x : null;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
}

/** strOrNull + sanitizeLabel, for device-reported strings that reach a TUI frame
 *  (firmware versions). Strips control/ESC bytes + folds wide chars; null stays null. */
function sanitizeStrOrNull(x: unknown): string | null {
  const s = strOrNull(x);
  return s == null ? null : sanitizeLabel(s);
}

/** Minimal shape of a get_states entry we read (battery level, firmware update). */
export interface RawEntityState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

/**
 * Aggregate firmware update entities → per-node {@link FirmwareInfo}. Pure, so
 * the multi-target logic is unit-testable (a node can expose several `update.*`
 * firmware entities, e.g. `_firmware` + `_firmware_2`):
 *   - `updateAvailable` if ANY target is `on`; `inProgress` if ANY is applying.
 *   - displayed versions come from a target that has an update / is applying,
 *     else the first target (targets carry identical versions when all current).
 * Entities absent from `updateEntityToNode` are ignored.
 */
export function aggregateFirmware(
  states: RawEntityState[],
  updateEntityToNode: Map<string, number>,
): Map<number, FirmwareInfo> {
  const fw = new Map<number, FirmwareInfo>();
  for (const s of states) {
    const nodeId = updateEntityToNode.get(s.entity_id);
    if (nodeId == null) continue;
    const a = s.attributes ?? {};
    const on = s.state === 'on';
    const inProg = a.in_progress === true;
    const pct = typeof a.update_percentage === 'number' ? a.update_percentage : null;
    // installed_version/latest_version are device-reported and reach the Detail
    // IDENTITY frame — sanitize them like every other HA-string display path.
    const cur = sanitizeStrOrNull(a.installed_version);
    const lat = sanitizeStrOrNull(a.latest_version);
    const acc: FirmwareInfo =
      fw.get(nodeId) ?? { current: null, latest: null, updateAvailable: false, inProgress: false, progressPct: null, targets: 0 };
    acc.targets += 1;
    if (on) acc.updateAvailable = true;
    if (inProg) {
      acc.inProgress = true;
      if (pct != null) acc.progressPct = Math.max(acc.progressPct ?? 0, pct);
    }
    if (on || inProg || acc.current == null) {
      acc.current = cur;
      acc.latest = lat;
    }
    fw.set(nodeId, acc);
  }
  return fw;
}
/** Attributes the DETAIL screen may format per-domain (light dimmer level,
 *  climate temps, cover position, sensor unit/class …). Everything else in an
 *  HA state's `attributes` blob (icons, colour arrays, supported_features
 *  bitmasks) is dropped so the live-state cache stays small and predictable. */
const DISPLAY_ATTR_KEYS = [
  'brightness', // light dimmer, 0..255
  'percentage', // fan speed, 0..100
  'color_mode',
  'current_temperature', // climate
  'temperature', // climate setpoint (single)
  'target_temp_high',
  'target_temp_low',
  'hvac_action',
  'current_humidity',
  'fan_mode',
  'preset_mode',
  'current_position', // cover, 0..100
  'is_closed',
  'unit_of_measurement', // sensor
  'device_class', // sensor / binary_sensor / cover semantics
  'friendly_name',
] as const;

/** Keep only the display-relevant attributes from a raw HA `attributes` blob.
 *  Pure + exported so the whitelist is unit-testable. Returns a fresh object
 *  (never aliases the source) with only present keys. */
export function pickDisplayAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs) return out;
  for (const k of DISPLAY_ATTR_KEYS) {
    const v = attrs[k];
    if (v === undefined) continue;
    // String attrs (unit, device_class, friendly_name, hvac_action …) are device-
    // controlled and reach a TUI frame — sanitize at this boundary (same rule as
    // every other HA-string path). Numbers/booleans pass through untouched.
    out[k] = typeof v === 'string' ? sanitizeLabel(v) : v;
  }
  return out;
}

/** Raw shape of one entry in a `zwave_js/get_config_parameters` response. */
interface RawConfigParam {
  property?: number;
  property_key?: number | null;
  endpoint?: number;
  value?: unknown;
  metadata?: {
    label?: string;
    type?: string;
    unit?: string | null;
    writeable?: boolean;
    min?: number | null;
    max?: number | null;
    states?: Record<string, string> | null;
  };
}

/** Map a raw `zwave_js/get_config_parameters` object → a sorted, display-ready
 *  {@link ConfigParam}[]. Pure + exported for unit testing. Params are sorted by
 *  the numeric `property` (then key) so the DETAIL list is stable; the current
 *  value's enum label is resolved from `metadata.states` when present. */
export function mapConfigParams(raw: Record<string, RawConfigParam> | null | undefined): ConfigParam[] {
  if (!raw || typeof raw !== 'object') return [];
  const params: ConfigParam[] = [];
  for (const [key, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const meta = p.metadata ?? {};
    const value = typeof p.value === 'number' ? p.value : null;
    const states = meta.states && typeof meta.states === 'object' ? meta.states : null;
    const valueLabel = value != null && states ? states[String(value)] ?? null : null;
    // Enum options with sanitized labels (for the v0.23 value picker).
    const statesSan = states
      ? Object.fromEntries(Object.entries(states).map(([k, v]) => [k, sanitizeLabel(String(v))]))
      : null;
    // property addresses the parameter for set_config_parameter; prefer the raw
    // field, else the key's last segment ("<node>-<cc>-<endpoint>-<property>").
    const property = typeof p.property === 'number' ? p.property : Number(key.split('-').pop()) || 0;
    params.push({
      key,
      label: sanitizeLabel(String(meta.label ?? key)),
      value,
      valueLabel: valueLabel != null ? sanitizeLabel(valueLabel) : null,
      unit: meta.unit ? sanitizeLabel(String(meta.unit)) : null,
      writeable: meta.writeable === true,
      min: typeof meta.min === 'number' ? meta.min : null,
      max: typeof meta.max === 'number' ? meta.max : null,
      property,
      propertyKey: typeof p.property_key === 'number' ? p.property_key : null,
      endpoint: typeof p.endpoint === 'number' ? p.endpoint : 0,
      states: statesSan,
    });
  }
  params.sort((a, b) => {
    const pa = typeof raw[a.key]?.property === 'number' ? (raw[a.key]!.property as number) : 0;
    const pb = typeof raw[b.key]?.property === 'number' ? (raw[b.key]!.property as number) : 0;
    return pa - pb || a.key.localeCompare(b.key);
  });
  return params;
}

/** Stable key of a route's repeater chain, for change detection. */
function routeKey(r: RouteStat | null): string {
  return r ? r.repeaters.join('>') : '';
}
/** Human route summary for the log ("direct" or "3→7→…"). */
function fmtRoute(r: RouteStat | null): string {
  if (!r) return 'unknown';
  return r.repeaters.length ? r.repeaters.join('→') : 'direct';
}

/** Construct and start the Z-Wave data layer. The caller owns `stop()`. */
export function createZwaveData(opts: ZwaveDataOptions): ZwaveData {
  const impl = new ZwaveDataImpl(opts);
  impl.start();
  return impl;
}
