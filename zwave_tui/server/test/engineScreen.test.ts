/**
 * ENGINE screen (v0.41) — the engine's own runtime, made visible.
 *
 * The gap analysis that motivated this screen found its predecessors' failure
 * mode was never a crash: it was silence. A value computed and never rendered,
 * a bridge member the production provider forgot to wire, a block that only
 * fits at 200 columns. So these tests pin the CONTENT at the modal 80x24, and
 * the production bridge is pinned separately in driverWsClient.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEngine } from '../src/telnet/screens/engine';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type {
  DataProvider, NodeSnapshot, ControllerSnapshot, ScreenCtx, ViewState,
  AutoPingSnapshot, OpenEpisodeSummary, SymptomKind,
} from '../src/types';

const NOW = Date.now();
const node = (id: number): NodeSnapshot => ({
  nodeId: id, deviceId: 'd' + id, name: `Node ${id} Long Name`, area: null, status: NodeStatus.Alive,
  statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
  isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
  battery: null, firmware: null, stats: {} as never, entities: [],
});
const nodes = [node(1), node(7), node(49)];

const AP = (over: Partial<AutoPingSnapshot> = {}): AutoPingSnapshot => ({
  lastTickMs: NOW - 30_000, suppressed: 'none', listening: 35, deadListening: 0,
  staleDue: 4, stalestMs: 90 * 60_000, verifyOwed: 0,
  config: { enabled: true, writeActions: true, afterMs: 600_000, maxAttempts: 3, staleMs: 7_200_000 },
  nodes: [], ...over,
});

function data(over: Partial<DataProvider> = {}): DataProvider {
  return {
    nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id),
    controller: () => ({ homeId: 1 } as ControllerSnapshot), events: () => [],
    scoreFor: () => ({ score: 90, grade: 'A', state: 'ok', flags: [] }),
    noiseFloor: () => -100, hasRealNoise: () => true,
    history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => NOW - 1000, ready: () => true, lastError: () => null, symptoms: () => [],
    engineStatus: () => ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3, band: 0, bands: 6 }), efficacyFor: () => null,
    interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
    entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
    ...over,
  } as DataProvider;
}
const mkView = (cols: number, rows: number): ViewState =>
  ({ screen: 'engine', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, over: Partial<DataProvider> = {}): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(over), visibleNodes: nodes, filtering: false, actionsEnabled: true });
const plain = (lines: string[]): string => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

test('ENGINE holds EXACTLY view.rows lines within view.cols at every size', () => {
  const rich: Partial<DataProvider> = {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 1_800_000, attempts: 2, nextEligibleMs: NOW + 600_000, missStreak: 3, launchFailures: 0, pending: 1, gaveUp: false, launchGaveUp: false, talkingWhileDead: false }] }),
    openEpisodes: () => ([{ key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' as SymptomKind, onsetMs: NOW - 300_000, actionKind: null, confounded: false, beforeFreshN: 4, confirming: true }]),
    controlArm: () => ({ n: 6.2, ok: 5.1, nodes: 3 }),
  };
  for (const [cols, rows] of [[40, 12], [80, 24], [120, 40], [200, 50]] as const) {
    for (const over of [{}, rich]) {
      const lines = renderEngine(ctx(cols, rows, over));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      lines.forEach((l, i) => assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: ${visLen(l)} > ${cols}`));
    }
  }
});

test('at the MODAL 80x24 the operator sees auto-ping state, the live ledger, and a base rate WITH its n', () => {
  // The v0.35 lesson: a disclosure that only fits at 200 columns is not a
  // disclosure. Everything load-bearing must survive the default terminal.
  const joined = plain(renderEngine(ctx(80, 24, {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 1_800_000, attempts: 2, nextEligibleMs: NOW + 600_000, missStreak: 0, launchFailures: 0, pending: 0, gaveUp: false, launchGaveUp: false, talkingWhileDead: false }] }),
    openEpisodes: () => ([{ key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' as SymptomKind, onsetMs: NOW - 300_000, actionKind: null, confounded: false, beforeFreshN: 4, confirming: false }]),
    controlArm: (k) => (k === 'rtt-degraded' ? { n: 6.2, ok: 5.1, nodes: 3 } : null),
  })));
  assert.match(joined, /AUTO-PING/);
  assert.match(joined, /running/, 'suppression state is visible');
  assert.match(joined, /#49/, 'the node the ladder is tracking is named');
  assert.match(joined, /attempt 2\/3/, 'its ladder position is visible');
  assert.match(joined, /#7 rtt-degraded/, 'the open episode is visible');
  assert.match(joined, /degraded — symptom live/, 'and its lifecycle state');
  assert.match(joined, /self-heal 82%/, 'the base rate renders');
  assert.match(joined, /n≈6\.2/, 'ALWAYS with its n — as a WEIGHT, not a tally (v0.43.1)');
});

test('a suppressed engine says WHY, and a disabled one says it is off — neither renders as empty', () => {
  const stormy = plain(renderEngine(ctx(80, 24, { autoPingState: () => AP({ suppressed: 'storm' }) })));
  assert.match(stormy, /suppressed: storm/);
  const off = plain(renderEngine(ctx(80, 24, { autoPingState: () => null })));
  assert.match(off, /off — auto-ping is disabled/);
  assert.ok(!/suppressed/.test(off), 'a disabled feature is not described as suppressed');
});

test('an idle ledger is distinguished from an absent one', () => {
  const idle = plain(renderEngine(ctx(80, 24, { openEpisodes: () => [] })));
  assert.match(idle, /no open episodes/);
  const absent = plain(renderEngine(ctx(80, 24, { openEpisodes: undefined })));
  assert.match(absent, /no outcome ledger/);
});

test('the confirmation window is called out — a node being scored is recovering, not degraded', () => {
  const joined = plain(renderEngine(ctx(100, 30, {
    openEpisodes: () => ([{ key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' as SymptomKind, onsetMs: NOW - 300_000, actionKind: 'ping', confounded: true, beforeFreshN: 5, confirming: true } as OpenEpisodeSummary]),
  })));
  assert.match(joined, /confirming — symptom absent, scoring/);
  assert.match(joined, /confounded — neither arm/,
    'a confounded episode must say so before it says which action it carried — a clipped flag reads as a clean control point');
});

test('a node the add-on cannot SEND to is blamed on us, not on the device (v0.40.2)', () => {
  const joined = plain(renderEngine(ctx(100, 30, {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 600_000, attempts: 0, nextEligibleMs: null, missStreak: 0, launchFailures: 3, pending: 0, gaveUp: false, launchGaveUp: true, talkingWhileDead: false }] }),
  })));
  assert.match(joined, /3 unsent/);
  assert.match(joined, /CANNOT SEND — our fault, not the node's/);
});

/* ── v0.41 render-honesty edits (from the TUI gap analysis) ────────────────── */

test('no screen or detector claims a probe that may never have been sent (v0.41)', async () => {
  // The quiet-node narrative asserted "the sweep has asked and nothing has come
  // back" on installs where auto-ping is off by default, where the sweep is
  // disabled by staleMs=0, or where the one-node-per-tick queue simply has not
  // reached that node. A rendered measurement claim about a probe never sent.
  const { readFileSync } = await import('node:fs');
  const symptoms = readFileSync(new URL('../src/zwave/symptoms.ts', import.meta.url), 'utf8');
  assert.ok(!/the sweep has asked/.test(symptoms),
    'the quiet-node narrative must not assert a probe was sent');
  const planner = readFileSync(new URL('../src/zwave/planner.ts', import.meta.url), 'utf8');
  assert.ok(!/auto-ping may already have/.test(planner),
    'the planner must not assert auto-ping behaviour it cannot check');
});

/* ── v0.41.0 pre-release review fixes ─────────────────────────────────────── */

test('a GAVE UP alarm survives the modal 80x24 — an alarm dropped to truncation is worse than a clipped label', () => {
  // The first cut put the two human-summoning flags LAST, so at 80 cols they
  // vanished entirely while cosmetic context survived.
  const joined = plain(renderEngine(ctx(80, 24, {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 9_000_000, attempts: 3, nextEligibleMs: NOW + 600_000, missStreak: 7, launchFailures: 2, pending: 3, gaveUp: true, launchGaveUp: false, talkingWhileDead: false }] }),
  })));
  assert.match(joined, /GAVE UP — needs a human/, 'the alarm survives a narrow terminal');
});

test('a bit is rendered WHOLE or not at all — a clipped percentage is a false reading', () => {
  // A measured 41% rendering as `4` is not a truncation, it is a wrong number.
  // fitBits emits whole bits in priority order and discloses the rest as +N.
  for (const cols of [60, 70, 80, 90, 100, 140]) {
    const raw = renderEngine(ctx(cols, 24, {
      controlArm: () => ({ n: 6.25, ok: 2.5, nodes: 4 }),
      efficacyFor: () => ({ expectedEfficacy: 0.41, n: 12.5, baseRate: 0.4, nodes: 3, ready: true, blocked: null } as never),
    })).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const line = raw.find((l) => l.includes('self-heal')) ?? '';
    if (line.includes('self-heal')) {
      assert.match(line, /self-heal \d+% \(n≈6\.3, 4 nodes\)/,
        `${cols} cols: the self-heal bit must be whole: "${line}"`);
    }
    // Any action-arm percentage present must carry its complete n, never a
    // half-written one.
    const armed = raw.find((l) => /ping \d+%/.test(l));
    if (armed) assert.match(armed, /ping \d+% \(n≈12\.5, 3 nodes\)/, `${cols} cols: "${armed}"`);
    // And an overflow is DISCLOSED rather than silently dropped.
    for (const l of raw) assert.ok(!/·\s*$/.test(l), `${cols} cols: dangling separator: "${l}"`);
  }
});

test('a suppressed pass reports its queues as NOT COMPUTED, never as measured zeros', () => {
  // decideAutoPings returns before reading the sweep/verify queues when
  // suppressed, so 0 there asserts an empty backlog nothing looked at.
  const joined = plain(renderEngine(ctx(100, 30, {
    autoPingState: () => AP({ suppressed: 'storm', staleDue: null, verifyOwed: null, stalestMs: null }),
  })));
  assert.match(joined, /sweep-due —/, 'an uncomputed queue reads as —');
  assert.match(joined, /verify-owed —/);
  assert.ok(!/sweep-due 0/.test(joined), 'never a fabricated zero');
});

test('a node the ladder has ABANDONED shows no next retry — it has no next attempt', () => {
  const joined = plain(renderEngine(ctx(120, 30, {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 9_000_000, attempts: 3, nextEligibleMs: NOW + 3_000_000, missStreak: 0, launchFailures: 0, pending: 0, gaveUp: true, launchGaveUp: false, talkingWhileDead: false }] }),
  })));
  assert.match(joined, /GAVE UP/);
  assert.ok(!/next in/.test(joined), 'a given-up node is not promised a retry');
});

test('an arm whose node provenance was never recorded says so — 0 is unknown, not zero (v0.41.1)', () => {
  // Seen on the live fleet minutes after this screen shipped:
  //   route-churn  self-heal 100% (n≈1.0, 0 nodes)
  // Efficacy.nodes is 0 when UNKNOWN (a ledger written before provenance was
  // tracked). Beside a positive n, "0 nodes" is a self-contradiction — and this
  // is the number that separates "six nodes agreed" from "one node repeated".
  const joined = plain(renderEngine(ctx(120, 30, {
    controlArm: (k) => (k === 'route-churn' ? { n: 1.0, ok: 1.0, nodes: 0 } : null),
  })));
  assert.match(joined, /self-heal 100% \(n≈1\.0, sources not recorded\)/,
    `unknown provenance must say so: ${joined}`);
  assert.ok(!/0 nodes/.test(joined), 'never asserts a measured zero');
});

test('ENGINE shows a node whose Dead flag its own traffic contradicts (v0.42.0)', () => {
  const joined = plain(renderEngine(ctx(120, 30, {
    autoPingState: () => AP({ nodes: [{ nodeId: 49, deadSinceMs: NOW - 600_000, attempts: 0, nextEligibleMs: null, missStreak: 0, launchFailures: 0, pending: 0, gaveUp: false, launchGaveUp: false, talkingWhileDead: true }] }),
  })));
  assert.match(joined, /reads Dead but TALKING — stale flag/);
});

test('ENGINE classifies the driver link on its STATE, never on the prose (v0.43.0)', () => {
  // driverWsStatus() existed from the day the client shipped and NOTHING read
  // it — that socket feeds bgRSSI, S2-resync detection and the real lastSeen.
  // The first cut of this fix pattern-matched the human sentence, which reads
  // three unhealthy states as benign: the initial 'not started', and every
  // backoff line (`${reason} — retry in Ns (attempt N)`), whose text need
  // contain none of the words a regex looks for.
  const live = plain(renderEngine(ctx(120, 30, {
    driverWsStatus: () => 'live (schema 41, home 3586281591)', driverWsState: () => 'live',
  })));
  assert.match(live, /DRIVER LINK/);
  assert.match(live, /live — live \(schema 41/);

  // Every non-live state must stand out — including the two the prose hides.
  for (const [st, line] of [
    ['dormant', 'schema mismatch (server max 38 < our min 39)'],
    ['backoff', 'connect failed (ECONNREFUSED) — retry in 8s (attempt 3)'],
    ['stopped', 'not started'],
    ['disabled', 'disabled (no driver_ws_url)'],
  ] as const) {
    const raw = renderEngine(ctx(120, 30, { driverWsStatus: () => line, driverWsState: () => st }))
      .find((l) => /DRIVER LINK/.test(l)) ?? '';
    assert.ok(/\x1b\[93m/.test(raw), `${st} must be highlighted, not rendered as healthy: ${JSON.stringify(raw)}`);
    assert.ok(raw.includes(st), `and must name the state: ${JSON.stringify(raw)}`);
  }
  const rawOk = renderEngine(ctx(120, 30, { driverWsStatus: () => 'live (schema 41)', driverWsState: () => 'live' }))
    .find((l) => /DRIVER LINK/.test(l)) ?? '';
  assert.ok(!/\x1b\[93m/.test(rawOk), `a healthy link is not highlighted: ${JSON.stringify(rawOk)}`);
});

test('the n≈ legend renders only where a weight is on screen, and fits narrow terminals (v0.43.1)', () => {
  // A legend explaining a notation that appears nowhere is noise, and at 40
  // cols the long form truncated away the saturation figure it exists to give.
  const empty = plain(renderEngine(ctx(120, 30)));
  assert.match(empty, /nothing learned yet/);
  assert.doesNotMatch(empty, /recent-weighted|decays, saturates/,
    'no weight on screen ⇒ no legend explaining one');

  const learned: Partial<DataProvider> = {
    controlArm: (k) => (k === 'rtt-degraded' ? { n: 6.2, ok: 5.1, nodes: 3 } : null),
  };
  for (const cols of [40, 60, 80, 100, 140, 200]) {
    const joined = plain(renderEngine(ctx(cols, 30, learned)));
    const line = joined.split('\n').find((l) => /n≈ /.test(l) && !/self-heal|not distinguishable/.test(l));
    assert.ok(line, `${cols} cols: legend missing entirely`);
    assert.match(line, /33/, `${cols} cols: the saturation figure was truncated away — "${line.trim()}"`);
    assert.ok(plain([line]).length <= cols, `${cols} cols: legend overflows`);
  }
});
