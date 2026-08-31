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
  ActionKind,
  ConfigParamsResult,
  ControllerSnapshot,
  DataProvider,
  Efficacy,
  EntityLiveState,
  HealthResult,
  InterferenceView,
  LogEvent,
  NodeSnapshot,
  Symptom,
  SymptomKind,
  AutoPingSnapshot,
  OpenEpisodeSummary,
} from '../types';
import type { CoarseBucket } from '../zwave/evidenceStore';
import type { DriverWsState } from '../zwave/driverWsClient';
import { scoreNode, DEFAULT_NOISE_FLOOR, rssiReading } from '../zwave/health';

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
  /**
   * Release an error's RED latch by seq (shared across sessions).
   *
   * REQUIRED, not optional. v0.33 declared this optional here so mocks need not
   * supply it — and the production bridge in index.ts then silently omitted it,
   * so `zwaveData.ackEvent?.(seq) ?? false` resolved to `false` on every real
   * keypress and the shipped `M` key did nothing for two releases. Optionality
   * on the SOURCE (which has exactly one production implementation) buys
   * nothing and costs the compiler's ability to enforce the bridge.
   */
  ackEvent(seq: number): boolean;
  /** Measured route stability from the coarse tier (v0.34). REQUIRED — see ackEvent. */
  routeStability(nodeId: number): { changes: number; hours: number } | null;
  /** Persisted route-failure events: which LINK broke, not just that one did (v0.35). */
  routeFailures(nodeId: number): { t: number; between: [number, number] }[];
  /** What the engine can SEE for a node (v0.35). REQUIRED — see ackEvent. */
  evidenceCoverage(nodeId: number): {
    firstSeenAt: number; samples: number; freshSamples: number;
    statusFeedLive: boolean; statsFeedLive: boolean;
    probesAsked: number; probesAnswered: number; probesSelfProven: number;
  } | null;
  /** Long-horizon buckets for a node (v0.35). REQUIRED — see ackEvent. */
  evidenceCoarse(nodeId: number): CoarseBucket[];
  /** Ledger tally of `refused-misdiagnosis` closes for a kind (v0.35). REQUIRED — see ackEvent. */
  falsePositives(kind: SymptomKind): number;
  /** Episodes of this kind closed `unverifiable` (v0.36). REQUIRED — see ackEvent. */
  unverifiableCount(kind: SymptomKind): number;
  /** Of those, on unprobeable nodes (v0.38). REQUIRED — see ackEvent. */
  unverifiableUnprobeableCount(kind: SymptomKind): number;
  /** Of those, transient blinks — over before the floor filled (v0.39). REQUIRED — see ackEvent. */
  unverifiableTransientCount(kind: SymptomKind): number;
  /** Of those, undersampled by the node's own cadence (v0.41.2). REQUIRED — see ackEvent. */
  unverifiableUndersampledCount(kind: SymptomKind): number;
  /** No-action closures confounded by a mid-episode death/remediation (v0.40). REQUIRED — see ackEvent. */
  confoundedCount(kind: SymptomKind): number;
  /** The ledger's live workload (v0.41). REQUIRED — see ackEvent. */
  openEpisodes(): OpenEpisodeSummary[];
  /** Control arm with provenance (v0.41). REQUIRED — see ackEvent. */
  controlArm(kind: SymptomKind): { n: number; ok: number; nodes: number } | null;
  /** Auto-ping runtime state (v0.41), null when off. REQUIRED — see ackEvent. */
  autoPingState(): AutoPingSnapshot | null;
  /** Driver-WS lifecycle line (v0.43.0). REQUIRED — see ackEvent. */
  driverWsStatus(): string;
  /** Structured link state (v0.43.0). REQUIRED — see ackEvent. */
  driverWsState(): DriverWsState;
  /** Learned RSSI normal for a node (v0.35). REQUIRED — see ackEvent. */
  rssiNormal(nodeId: number): { median: number; scale: number; ready: boolean; days: number } | null;
  /** Has the first roster load completed? Falls back to "roster non-empty". */
  ready?(): boolean;
  /** Last fatal error string, if any. */
  lastError?(): string | null;
  /** Epoch ms of the last SUCCESSFUL roster refresh (null before the first). */
  lastUpdated?(): number | null;
  /** Rolling RSSI/RTT history for a node (for sparklines). */
  history?(nodeId: number): { rssi: readonly number[]; rtt: readonly number[] };
  /** Coarse long-horizon RSSI/RTT trend for a node (~2h). */
  historyLong?(nodeId: number): { rssi: readonly number[]; rtt: readonly number[] };
  /**
   * Optional: trigger an expensive route/controller-statistics refresh. When
   * present it is driven on the `routePollMs` cadence; when absent the data
   * layer is assumed to own its own polling.
   */
  pollRoutes?(): void | Promise<void>;
  /** Engine-detected symptoms (M3), ranked. REQUIRED so a source adapter can't
   *  silently omit it (v0.14: it did, and the whole Remedy screen read "engine
   *  disabled" even though the engine was running). */
  symptoms(): Symptom[];
  /** Engine enabled + baseline-readiness (for the Remedy empty state). REQUIRED. */
  engineStatus(): { enabled: boolean; ready: number; total: number };
  /** M5 learned action efficacy (null when the ledger is off / no estimate). REQUIRED. */
  efficacyFor(kind: SymptomKind, action: ActionKind): Efficacy | null;
  /** M6 interference view (noise floor + serial health + diurnal heatmap). REQUIRED. */
  interference(): InterferenceView;
  /** v0.22: a node's entities joined with current live state (DETAIL). REQUIRED. */
  entityStates(nodeId: number): EntityLiveState[];
  /** v0.22: cached config-parameter result for a node (DETAIL). REQUIRED. */
  configParams(nodeId: number): ConfigParamsResult;
  /** v0.22: idempotently trigger a node's async config-param fetch. REQUIRED. */
  requestConfigParams(nodeId: number): void;
}

export interface CreateTuiDataProviderOptions {
  zwaveData: ZwaveDataSource;
  /** Fast render-cache refresh cadence (ms). */
  refreshMs?: number;
  /** Slow route/controller-statistics poll cadence (ms). */
  routePollMs?: number;
  log: (msg: string) => void;
}


/** A neutral score returned for a node we have not scored yet. */
const UNKNOWN_SCORE: HealthResult = {
  score: 0,
  grade: 'F',
  state: 'unknown',
  flags: [],
};

/** Median of the controller's per-channel background RSSI, sentinel-filtered. */
function computeNoiseFloor(controller: ControllerSnapshot | null): number {
  const raw = controller?.backgroundRSSI ?? [];
  const vals = raw.filter(
    (v) => rssiReading(v) != null,
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
/**
 * Build the ZwaveDataSource bridge the add-on runs on.
 *
 * EXTRACTED SO IT CAN BE TESTED (v0.34). It used to be an object literal inside
 * index.ts's `main()`, which is unreachable from a test because importing
 * index.ts starts the server. That made the one bridge production actually uses
 * the only un-covered link in the chain — and it is exactly where v0.33's ack
 * key and v0.34's route stability were dropped: wired everywhere else, omitted
 * here, silently returning false/null on every real keypress.
 *
 * Every member forwards straight through; the value of this function is that a
 * test can now assert that it does.
 */
export function buildZwaveDataSource(zd: ZwaveDataSource): ZwaveDataSource {
  return {
    snapshot: () => zd.snapshot(),
    controller: () => zd.controller(),
    events: () => zd.events(),
    ready: () => zd.ready?.() ?? true,
    lastError: () => zd.lastError?.() ?? null,
    lastUpdated: () => zd.lastUpdated?.() ?? Date.now(),
    history: (n) => zd.history?.(n) ?? { rssi: [], rtt: [] },
    historyLong: (n) => zd.historyLong?.(n) ?? { rssi: [], rtt: [] },
    symptoms: () => zd.symptoms?.() ?? [],
    engineStatus: () => zd.engineStatus?.() ?? { enabled: false, ready: 0, total: 0 },
    efficacyFor: (k, a) => zd.efficacyFor?.(k, a) ?? null,
    interference: () => zd.interference?.() ?? null,
    entityStates: (n) => zd.entityStates?.(n) ?? [],
    configParams: (n) => zd.configParams?.(n) ?? [],
    requestConfigParams: (n) => zd.requestConfigParams?.(n),
    ackEvent: (seq) => zd.ackEvent(seq),
    routeStability: (n) => zd.routeStability(n),
    routeFailures: (n) => zd.routeFailures(n),
    evidenceCoverage: (n) => zd.evidenceCoverage(n),
    evidenceCoarse: (n) => zd.evidenceCoarse(n),
    falsePositives: (k) => zd.falsePositives(k),
    unverifiableCount: (k) => zd.unverifiableCount(k),
    unverifiableUnprobeableCount: (k) => zd.unverifiableUnprobeableCount(k),
    unverifiableTransientCount: (k) => zd.unverifiableTransientCount(k),
    unverifiableUndersampledCount: (k) => zd.unverifiableUndersampledCount(k),
    confoundedCount: (k) => zd.confoundedCount(k),
    openEpisodes: () => zd.openEpisodes(),
    controlArm: (k) => zd.controlArm(k),
    autoPingState: () => zd.autoPingState(),
    driverWsStatus: () => zd.driverWsStatus(),
    driverWsState: () => zd.driverWsState(),
    rssiNormal: (n) => zd.rssiNormal(n),
  };
}

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
      (v) => rssiReading(v) != null,
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
    ackEvent: (seq) => zwaveData.ackEvent(seq),
    routeStability: (nodeId) => zwaveData.routeStability(nodeId),
    routeFailures: (nodeId) => zwaveData.routeFailures(nodeId),
    evidenceCoverage: (nodeId) => zwaveData.evidenceCoverage(nodeId),
    evidenceCoarse: (nodeId) => zwaveData.evidenceCoarse(nodeId),
    falsePositives: (kind) => zwaveData.falsePositives(kind),
    unverifiableCount: (kind) => zwaveData.unverifiableCount(kind),
    unverifiableUnprobeableCount: (kind) => zwaveData.unverifiableUnprobeableCount(kind),
    unverifiableTransientCount: (kind) => zwaveData.unverifiableTransientCount(kind),
    unverifiableUndersampledCount: (kind) => zwaveData.unverifiableUndersampledCount(kind),
    confoundedCount: (kind) => zwaveData.confoundedCount(kind),
    openEpisodes: () => zwaveData.openEpisodes(),
    controlArm: (kind) => zwaveData.controlArm(kind),
    autoPingState: () => zwaveData.autoPingState(),
    driverWsStatus: () => zwaveData.driverWsStatus(),
    driverWsState: () => zwaveData.driverWsState(),
    rssiNormal: (nodeId) => zwaveData.rssiNormal(nodeId),
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
    efficacyFor: (kind, action) => zwaveData.efficacyFor?.(kind, action) ?? null,
    interference: () => zwaveData.interference(),
    entityStates: (n) => zwaveData.entityStates(n),
    configParams: (n) => zwaveData.configParams(n),
    requestConfigParams: (n) => zwaveData.requestConfigParams(n),
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
