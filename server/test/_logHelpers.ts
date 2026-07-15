// Shared fixtures for the activity-log tests. Underscore prefix keeps it out of
// the `test/*.test.ts` glob.
import { NodeStatus } from '../src/types';
import type { DataProvider, LogEvent, NodeSnapshot, ViewState } from '../src/types';

/** A fixed wall clock (local noon, 2026-07-14) so date-range tests are stable. */
export const NOW = new Date(2026, 6, 14, 12, 0, 0).getTime();
export const DAY = 24 * 3600_000;
export const HOUR = 3600_000;

export function mkEvent(p: Partial<LogEvent> = {}): LogEvent {
  const ts = p.ts ?? NOW;
  return {
    // Default seq tracks ts (newer = higher), matching production's monotonic id.
    seq: p.seq ?? ts,
    ts,
    source: 'net',
    severity: 'info',
    kind: 'value',
    nodeId: 7,
    text: 'event',
    ...p,
  };
}

export function mkNode(p: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    nodeId: 7,
    deviceId: 'dev7',
    name: 'Garage Motion',
    area: 'outside',
    status: NodeStatus.Alive,
    statusLabel: 'alive',
    ready: true,
    isRouting: true,
    isListening: true,
    isLongRange: false,
    isController: false,
    isSecure: true,
    securityClass: 'S2',
    manufacturer: 'Zooz',
    model: 'ZSE40',
    battery: null,
    firmware: null,
    stats: {
      rtt: 30,
      rssi: -60,
      lwr: null,
      nlwr: null,
      commandsTX: 0,
      commandsRX: 0,
      commandsDroppedTX: 0,
      commandsDroppedRX: 0,
      timeoutResponse: 0,
      lastSeen: NOW,
    },
    entities: [],
    ...p,
  };
}

export function mkView(p: Partial<ViewState> = {}): ViewState {
  return {
    screen: 'log',
    cols: 120,
    rows: 46,
    selected: 0,
    scroll: 0,
    filter: '',
    sortKey: 'health',
    signalDisplay: 'margin',
    followTail: true,
    errorsOnly: false,
    logCursor: 0,
    logScroll: 0,
    logRange: 'all',
    logAnchorSeq: null,
    ...p,
  };
}

/** Position the log cursor at `idx` the way the UI would — via the anchor seq
 *  (logCursor is derived from it each frame). idx 0 = follow-newest (anchor null). */
export function anchorAt(view: ViewState, list: LogEvent[], idx: number): void {
  view.logCursor = idx;
  view.logAnchorSeq = idx === 0 ? null : list[idx].seq;
}

export function mockData(opts: { events?: LogEvent[]; nodes?: NodeSnapshot[] } = {}): DataProvider {
  const events = opts.events ?? [];
  const nodes = opts.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  return {
    nodes: () => nodes,
    nodeById: (id) => byId.get(id),
    controller: () => null,
    events: () => events,
    scoreFor: () => ({ score: 100, rating: 10, grade: 'A', state: 'ok', flags: [] }),
    noiseFloor: () => -95,
    hasRealNoise: () => false,
    history: () => ({ rssi: [], rtt: [] }),
    historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => NOW,
    ready: () => true,
    lastError: () => null,
  };
}
