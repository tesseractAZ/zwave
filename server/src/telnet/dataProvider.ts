/**
 * Shared, periodically-refreshed data cache for the Z-Wave TUI.
 *
 * Modelled on ecoflow-panel's `telnet/dataProvider.ts`: it decouples the 1 Hz
 * render tick from the expensive Z-Wave recomputes. The render loop reads only
 * the cheap, last-cached accessors on `DataProvider` — it NEVER recomputes a
 * health score or a noise floor inside `draw()`. This module owns the timers
 * that keep those caches warm:
 *
 *   • a fast `refreshMs` tick that re-snapshots the roster, recomputes the
 *     per-node health scores and the representative noise floor; and
 *   • a slower, self-scheduling `routePollMs` loop that triggers the expensive
 *     route/controller-statistics poll on the underlying data layer (when it
 *     exposes one) and then folds the fresh values into the cache.
 *
 * ONE instance is created in `index.ts` and shared by BOTH transports (telnet
 * TCP + the /console WebSocket). Whoever creates it calls `stop()`; the
 * underlying `zwaveData` layer is stopped separately by its owner.
 */

import type {
  ControllerSnapshot,
  DataProvider,
  HealthResult,
  LogEvent,
  NodeSnapshot,
  Symptom,
} from '../types';
import { scoreNode, DEFAULT_NOISE_FLOOR } from '../zwave/health';

/**
 * The subset of the `zwave/zwaveData` layer this provider consumes. The data
 * layer owns the live WS subscriptions + registry joins and exposes these
 * last-cached accessors; we adapt them into the `DataProvider` the screens use.
 */
export interface ZwaveDataSource {
  /** Current node roster (controller = node 1 included). */
  snapshot(): NodeSnapshot[];
  /** Controller / network-level snapshot, or null before the first load. */
  controller(): ControllerSnapshot | null;
  /** Driver-event + operator-command log ring. */
  events(): LogEvent[];
  /** Has the first roster load completed? Falls back to "roster non-empty". */
  ready?(): boolean;
  /** Last fatal error string, if any. */
  lastError?(): string | null;
  /** Epoch ms of the last SUCCESSFUL roster refresh (null before the first). */
  lastUpdated?(): number | null;
  /** Rolling RSSI/RTT history for a node (for sparklines). */
  history?(nodeId: number): { rssi: number[]; rtt: number[] };
  /** Coarse long-horizon RSSI/RTT trend for a node (~2h). */
  historyLong?(nodeId: number): { rssi: number[]; rtt: number[] };
  /**
   * Optional: trigger an expensive route/controller-statistics refresh. When
   * present it is driven on the `routePollMs` cadence; when absent the data
   * layer is assumed to own its own polling.
   */
  pollRoutes?(): void | Promise<void>;
  /** Engine-detected symptoms (M3), ranked; absent when the engine is off. */
  symptoms?(): Symptom[];
  /** Engine enabled + baseline-readiness (for the Remedy empty state). */
  engineStatus?(): { enabled: boolean; ready: number; total: number };
}

export interface CreateTuiDataProviderOptions {
  zwaveData: ZwaveDataSource;
  /** Fast render-cache refresh cadence (ms). */
  refreshMs?: number;
  /** Slow route/controller-statistics poll cadence (ms). */
  routePollMs?: number;
  log: (msg: string) => void;
}

/** RSSI sentinels the driver uses for "no reading" — excluded from the median. */
const RSSI_SENTINELS = new Set([127, 126, 125]);

/** A neutral score returned for a node we have not scored yet. */
const UNKNOWN_SCORE: HealthResult = {
  score: 0,
  rating: 0,
  grade: 'F',
  state: 'unknown',
  flags: [],
};

/** Median of the controller's per-channel background RSSI, sentinel-filtered. */
function computeNoiseFloor(controller: ControllerSnapshot | null): number {
  const raw = controller?.backgroundRSSI ?? [];
  const vals = raw.filter(
    (v) => Number.isFinite(v) && !RSSI_SENTINELS.has(v) && v < 0,
  );
  if (vals.length === 0) return DEFAULT_NOISE_FLOOR;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Start the shared refresh timers and return a `{ provider, stop }` pair. The
 * provider's accessors return the latest cached values; `stop()` clears the
 * timers this module owns (not the underlying data layer).
 */
export function createTuiDataProvider(opts: CreateTuiDataProviderOptions): {
  provider: DataProvider;
  stop: () => void;
} {
  const { zwaveData, log } = opts;
  const refreshMs = opts.refreshMs ?? 2000;
  const routePollMs = opts.routePollMs ?? 10_000;

  let cachedNodes: NodeSnapshot[] = [];
  let cachedById = new Map<number, NodeSnapshot>();
  let cachedController: ControllerSnapshot | null = null;
  let cachedEvents: LogEvent[] = [];
  let cachedScores = new Map<number, HealthResult>();
  let cachedNoiseFloor = DEFAULT_NOISE_FLOOR;
  let cachedHasNoise = false;
  let cachedLastUpdated: number | null = null;
  let cachedReady = false;
  let cachedError: string | null = null;

  let stopped = false;
  let routeTimer: NodeJS.Timeout | null = null;

  /** Re-snapshot the roster and recompute the derived caches. Cheap + sync. */
  const recompute = (): void => {
    let nodes: NodeSnapshot[];
    let controller: ControllerSnapshot | null;
    try {
      nodes = zwaveData.snapshot();
      controller = zwaveData.controller();
      cachedEvents = zwaveData.events();
    } catch (e: any) {
      log(`dataProvider: snapshot read failed: ${e?.message ?? e}`);
      return; // keep the last good caches rather than clobbering with garbage
    }

    const noise = computeNoiseFloor(controller);
    const scores = new Map<number, HealthResult>();
    const byId = new Map<number, NodeSnapshot>();
    for (const n of nodes) {
      byId.set(n.nodeId, n);
      try {
        scores.set(n.nodeId, scoreNode(n, noise));
      } catch (e: any) {
        log(`dataProvider: scoreNode(${n.nodeId}) failed: ${e?.message ?? e}`);
        scores.set(n.nodeId, UNKNOWN_SCORE);
      }
    }

    cachedNodes = nodes;
    cachedById = byId;
    cachedController = controller;
    cachedScores = scores;
    cachedNoiseFloor = noise;
    cachedHasNoise = (controller?.backgroundRSSI ?? []).some(
      (v) => Number.isFinite(v) && !RSSI_SENTINELS.has(v) && v < 0,
    );
    cachedLastUpdated = zwaveData.lastUpdated?.() ?? cachedLastUpdated;
    cachedReady = zwaveData.ready?.() ?? nodes.length > 0;
    cachedError = zwaveData.lastError?.() ?? null;
  };

  // Prime the caches immediately so the very first frame has data (or an empty
  // roster) instead of nulls, then keep them warm on the fast tick.
  recompute();
  const refreshTimer = setInterval(recompute, refreshMs);

  // Self-scheduling slow poll: fast-retry until the first good poll lands, then
  // relax to the configured cadence. Only runs when the data layer exposes a
  // route poll — otherwise the layer owns its own polling and we just refresh.
  const scheduleRoutePoll = (delayMs: number): void => {
    routeTimer = setTimeout(async () => {
      if (stopped) return;
      let ok = true;
      try {
        await zwaveData.pollRoutes?.();
      } catch (e: any) {
        ok = false;
        log(`dataProvider: route poll failed: ${e?.message ?? e}`);
      }
      recompute();
      if (!stopped) scheduleRoutePoll(ok ? routePollMs : Math.min(routePollMs, 2000));
    }, delayMs);
  };
  if (typeof zwaveData.pollRoutes === 'function') scheduleRoutePoll(500);

  const provider: DataProvider = {
    nodes: () => cachedNodes,
    nodeById: (nodeId) => cachedById.get(nodeId),
    controller: () => cachedController,
    events: () => cachedEvents,
    scoreFor: (nodeId) => cachedScores.get(nodeId) ?? UNKNOWN_SCORE,
    noiseFloor: () => cachedNoiseFloor,
    hasRealNoise: () => cachedHasNoise,
    history: (n) => zwaveData.history?.(n) ?? { rssi: [], rtt: [] },
    historyLong: (n) => zwaveData.historyLong?.(n) ?? { rssi: [], rtt: [] },
    lastUpdated: () => cachedLastUpdated,
    ready: () => cachedReady,
    lastError: () => cachedError,
    symptoms: () => zwaveData.symptoms?.() ?? [],
    engineStatus: () => zwaveData.engineStatus?.() ?? { enabled: false, ready: 0, total: 0 },
  };

  return {
    provider,
    stop: () => {
      stopped = true;
      clearInterval(refreshTimer);
      if (routeTimer) clearTimeout(routeTimer);
    },
  };
}
