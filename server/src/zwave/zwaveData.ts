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
  type RouteStat,
  type LogEvent,
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
  /** Epoch ms of the last successful roster refresh (null before the first). */
  lastUpdated(): number | null;
  /** Epoch ms of the last statistics event (node or controller), or null. */
  lastStatsUpdated(): number | null;
  /** Rolling RSSI/RTT history for a node (for sparklines). */
  history(nodeId: number): { rssi: number[]; rtt: number[] };
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

  // v0.2 live statistics, merged into each NodeSnapshot / ControllerSnapshot.
  private statsByNode = new Map<number, NodeStats>();
  /** v0.4 rolling per-node RSSI/RTT history for sparklines (bounded ring). */
  private histByNode = new Map<number, { rssi: number[]; rtt: number[] }>();
  private ctrlStats: ControllerSnapshot['statistics'] = null;
  /** Battery level (%) per node, from get_states of the *_battery entities. */
  private batteryByNode = new Map<number, number>();
  /** Battery-level sensor entity_id → node id (built with the registry join). */
  private batteryEntityToNode = new Map<string, number>();
  /** node id → its `button.*_ping` entity_id (for the ping action). */
  private pingEntityByNode = new Map<number, string>();
  /** Epoch ms of the last statistics event (node or controller) — freeze/health probe. */
  private lastStatsAt: number | null = null;
  /** Node status from the previous poll — diffed to log alive/dead/wake events. */
  private prevStatus = new Map<number, NodeStatus>();
  /** Event + command log ring (newest first), consumed by the Log screen. */
  private logRing: LogEvent[] = [];
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
    this.pushLog('you', severity, nodeId, text);
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
        this.pushLog('net', sev, n.nodeId, `${n.name} → ${n.statusLabel}`);
      }
      this.prevStatus.set(n.nodeId, n.status);
    }
    this.lastNodes = nodes;
    this.lastController = this.buildController(ctrl);
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
    let count = 0;
    for (const e of entities) {
      if (e.platform !== 'zwave_js') continue;
      if (e.disabled_by != null) continue; // skip disabled diagnostics — keep the list meaningful
      if (!e.device_id || !deviceIdToNodeId.has(e.device_id)) continue;
      const list = entitiesByDeviceId.get(e.device_id) ?? [];
      list.push({
        entityId: e.entity_id,
        domain: e.entity_id.split('.')[0],
        name: sanitizeLabel(e.original_name ?? e.name ?? '') || undefined,
      });
      entitiesByDeviceId.set(e.device_id, list);
      count++;
      // Remember the battery-level sensor so we can read its % from get_states.
      if (e.entity_id.startsWith('sensor.') && /battery/i.test(e.entity_id)) {
        this.batteryEntityToNode.set(e.entity_id, deviceIdToNodeId.get(e.device_id)!);
      }
      // Remember the ping button for the v0.3 ping action.
      if (e.entity_id.startsWith('button.') && /ping/i.test(e.entity_id)) {
        this.pingEntityByNode.set(deviceIdToNodeId.get(e.device_id)!, e.entity_id);
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
      stats: this.statsByNode.get(nodeId) ?? emptyStats(),
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

  private pushLog(source: LogEvent['source'], severity: LogEvent['severity'], nodeId: number | null, text: string): void {
    this.logRing.unshift({ ts: Date.now(), source, severity, nodeId, text });
    if (this.logRing.length > 300) this.logRing.length = 300;
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
      void this.fetchBatteryLevels();
    } catch (e) {
      this.statsSubscribed = false;
      this.log(`subscribeStatistics failed: ${errMsg(e)}`);
    }
  }

  /** Read battery-level sensor states once (levels move slowly; re-read on reconnect). */
  private async fetchBatteryLevels(): Promise<void> {
    if (this.batteryEntityToNode.size === 0) return;
    try {
      const states = await this.client.send<Array<{ entity_id: string; state: string }>>({ type: 'get_states' });
      for (const s of states) {
        const nodeId = this.batteryEntityToNode.get(s.entity_id);
        if (nodeId == null) continue;
        const lvl = Number(s.state);
        if (Number.isFinite(lvl)) this.batteryByNode.set(nodeId, Math.round(lvl));
      }
    } catch (e) {
      this.log(`battery levels fetch failed: ${errMsg(e)}`);
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

    // Append to the rolling history (skip RSSI sentinels 125/126/127).
    const HIST_MAX = 60;
    const h = this.histByNode.get(nodeId) ?? { rssi: [], rtt: [] };
    if (stats.rssi != null && stats.rssi < 0 && stats.rssi > -128) {
      h.rssi.push(stats.rssi);
      if (h.rssi.length > HIST_MAX) h.rssi.shift();
    }
    if (stats.rtt != null && stats.rtt >= 0) {
      h.rtt.push(stats.rtt);
      if (h.rtt.length > HIST_MAX) h.rtt.shift();
    }
    this.histByNode.set(nodeId, h);
    // Log a route change (repeater chain differs) so the mesh's re-routing is visible.
    if (prev && routeKey(prev.lwr) !== routeKey(stats.lwr)) {
      this.pushLog('net', 'info', nodeId, `route → ${fmtRoute(stats.lwr)}`);
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
