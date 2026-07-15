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
} from '../types';
import { createHistoryStore, type HistoryStore, type HistoryMap } from './historyStore';

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
    // Fold any pending interval into the coarse ring, then persist BOTH tiers on
    // the way down (SIGTERM from a deploy/restart) so trends resume seamlessly.
    this.rollCoarse();
    this.historyStore?.save(this.buildHistoryMap());
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
      }
      this.prevStatus.set(n.nodeId, n.status);
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

    this.deviceByNodeId = deviceByNodeId;
    this.deviceIdToNodeId = deviceIdToNodeId;
    this.entitiesByDeviceId = entitiesByDeviceId;
    this.entityCount = count;
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
      isListening: null,
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
      // HA's subscribe_controller_statistics event carries no background RSSI,
      // so the per-channel noise floor stays empty (summary shows "noise —").
      backgroundRSSI: [],
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

      // One subscription per end node (node 1 = controller, covered above).
      const nodeDevices = [...this.deviceByNodeId.entries()].filter(([nodeId]) => nodeId !== 1);
      await Promise.all(
        nodeDevices.map(([, dev]) =>
          this.client
            .subscribe({ type: 'zwave_js/subscribe_node_statistics', device_id: dev.id }, (msg) => this.onNodeStats(msg.event))
            .catch((e) => this.log(`node-stats subscribe failed (${dev.id}): ${errMsg(e)}`)),
        ),
      );
      this.log(`live statistics: subscribed controller + ${nodeDevices.length} nodes`);
      await this.subscribeActivityEvents();
      void this.fetchEntityStates();
    } catch (e) {
      this.statsSubscribed = false;
      this.log(`subscribeStatistics failed: ${errMsg(e)}`);
    }
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
    if (this.batteryEntityToNode.size === 0 && this.updateEntityToNode.size === 0) return;
    try {
      const states = await this.client.send<RawEntityState[]>({ type: 'get_states' });
      for (const s of states) {
        const bNode = this.batteryEntityToNode.get(s.entity_id);
        if (bNode != null) {
          const lvl = Number(s.state);
          if (Number.isFinite(lvl)) this.batteryByNode.set(bNode, Math.round(lvl));
        }
      }
      // Rebuilt fresh each pass (a node may have >1 firmware target — aggregated).
      this.firmwareByNode = aggregateFirmware(states, this.updateEntityToNode);
    } catch (e) {
      this.log(`entity states fetch failed: ${errMsg(e)}`);
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

  /** Map a raw node-statistics event → cached NodeStats. */
  private onNodeStats(ev: unknown): void {
    const e = ev as Record<string, unknown> | null;
    if (!e || e.source !== 'node') return;
    const nodeId = statsNodeId(e);
    if (nodeId == null) return;
    this.lastStatsAt = Date.now();
    const prev = this.statsByNode.get(nodeId);
    const stats: NodeStats = {
      rtt: num(e.rtt),
      rssi: num(e.rssi),
      lwr: this.mapRoute(e.lwr),
      nlwr: this.mapRoute(e.nlwr),
      commandsTX: int(e.commands_tx),
      commandsRX: int(e.commands_rx),
      commandsDroppedTX: int(e.commands_dropped_tx),
      commandsDroppedRX: int(e.commands_dropped_rx),
      timeoutResponse: int(e.timeout_response),
      lastSeen: Date.now(),
    };
    this.statsByNode.set(nodeId, stats);

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
    // Log a route change (repeater chain differs) so the mesh's re-routing is visible.
    if (prev && routeKey(prev.lwr) !== routeKey(stats.lwr)) {
      this.pushEvent('net', 'info', 'route', nodeId, `route → ${fmtRoute(stats.lwr)}`);
    }
  }

  /** Map the raw controller-statistics event (note the misspelled key). */
  private onControllerStats(ev: unknown): void {
    const e = ev as Record<string, unknown> | null;
    if (!e || e.source !== 'controller') return;
    this.lastStatsAt = Date.now();
    this.ctrlStats = {
      messagesTX: int(e.messages_tx),
      messagesRX: int(e.messages_rx),
      messagesDroppedTX: int(e.messages_dropped_tx),
      messagesDroppedRX: int(e.messages_dropped_rx),
      NAK: int(e.nak),
      CAN: int(e.can),
      timeoutACK: int(e.timeout_ack),
      timeoutResponse: int(e.timout_response), // driver misspells 'timeout'
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
/** Coerce to a finite integer, defaulting to 0. */
function int(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : 0;
}
/** A non-empty version string (numbers coerced), else null. */
function strOrNull(x: unknown): string | null {
  if (typeof x === 'string') return x.length ? x : null;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
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
    const cur = strOrNull(a.installed_version);
    const lat = strOrNull(a.latest_version);
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
