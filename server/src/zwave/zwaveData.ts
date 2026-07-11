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
  type ControllerSnapshot,
} from '../types';

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
  private deviceByNodeId = new Map<number, DeviceRec>();
  private entitiesByDeviceId = new Map<string, NodeEntity[]>();
  private entityCount = 0;

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
    this.entryId = seed !== '' ? seed : null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.startLiveStatistics(); // v0.2 hook — currently a no-op
    void this.tick();
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

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
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
    this.lastNodes = ctrl.nodes.map((n) => this.buildNode(n)).sort((a, b) => a.nodeId - b.nodeId);
    this.lastController = this.buildController(ctrl);
    this.lastErr = null;
    this.isReady = true;
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
        name: d.name_by_user || d.name || `Node ${nodeId}`,
        area: d.area_id ?? null,
        manufacturer: d.manufacturer ?? null,
        model: d.model ?? null,
      });
      deviceIdToNodeId.set(d.id, nodeId);
    }

    const entitiesByDeviceId = new Map<string, NodeEntity[]>();
    let count = 0;
    for (const e of entities) {
      if (e.platform !== 'zwave_js') continue;
      if (e.disabled_by != null) continue; // skip disabled diagnostics — keep the list meaningful
      if (!e.device_id || !deviceIdToNodeId.has(e.device_id)) continue;
      const list = entitiesByDeviceId.get(e.device_id) ?? [];
      list.push({
        entityId: e.entity_id,
        domain: e.entity_id.split('.')[0],
        name: e.original_name ?? e.name ?? undefined,
      });
      entitiesByDeviceId.set(e.device_id, list);
      count++;
    }

    this.deviceByNodeId = deviceByNodeId;
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
      // v0.2 hook: read sensor.<slug>_battery_level via get_states for battery nodes.
      battery: null,
      stats: emptyStats(),
      entities: dev ? this.entitiesByDeviceId.get(dev.id) ?? [] : [],
    };
  }

  private buildController(raw: RawController): ControllerSnapshot {
    const dev = this.deviceByNodeId.get(raw.own_node_id ?? 1) ?? this.deviceByNodeId.get(1);
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
      isRebuildingRoutes: raw.is_rebuilding_routes === true,
      // v0.2 hook: subscribe_controller_statistics.background_rssi (per-channel noise floor).
      backgroundRSSI: [],
      // v0.2 hook: subscribe_controller_statistics counters. Map the raw
      // misspelled 'timout_response' key → statistics.timeoutResponse then.
      statistics: null,
    };
  }

  /**
   * v0.2 HOOK — live statistics + push status.
   *
   * When enabled this will, after each (re)auth (`client.onReady`):
   *   • `client.subscribe({type:'zwave_js/subscribe_controller_statistics', entry_id}, …)`
   *     → controller counters + per-channel background RSSI.
   *   • per node `client.subscribe({type:'zwave_js/subscribe_node_statistics', device_id}, …)`
   *     → live rtt / rssi / lwr / nlwr / TX-RX counters, throttled to `routePollMs`
   *     for the expensive route recompute.
   *   • `client.subscribe({type:'subscribe_events', event_type:'state_changed'}, …)`
   *     filtered to `*_node_status` → push alive/dead/asleep transitions.
   *
   * v0.1 leaves it a no-op so the roster poll alone is the source of truth.
   */
  private startLiveStatistics(): void {
    this.log(`live statistics deferred to v0.2 (route poll cadence ${this.routePollMs}ms)`);
  }
}

/** Construct and start the Z-Wave data layer. The caller owns `stop()`. */
export function createZwaveData(opts: ZwaveDataOptions): ZwaveData {
  const impl = new ZwaveDataImpl(opts);
  impl.start();
  return impl;
}
