import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRemedy } from '../src/telnet/screens/remedy';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type { DataProvider, NodeSnapshot, ControllerSnapshot, ScreenCtx, ViewState, Symptom, SymptomKind } from '../src/types';
import type { AutoPingSnapshot, AutoPingNodeState } from '../src/zwave/autoPing';
import { buildRecommendation } from '../src/zwave/recommendation';

const now = Date.now();
function node(id: number): NodeSnapshot {
  return {
    nodeId: id, deviceId: 'd' + id, name: `Node ${id} Longish Name`, area: null, status: NodeStatus.Alive,
    statusLabel: 'alive', ready: true, isRouting: true, isListening: true, isLongRange: false,
    isController: id === 1, isSecure: true, securityClass: 'S2', manufacturer: null, model: null,
    battery: null, firmware: null, stats: {} as never, entities: [],
  };
}
const nodes = [node(1), node(6), node(7)];
const ctrl = { homeId: 3586281591 } as ControllerSnapshot;

type Eff = ReturnType<DataProvider['efficacyFor']>;
function data(symptoms: Symptom[], efficacyFor: DataProvider['efficacyFor'] = () => null): DataProvider {
  return {
    pendingIdentity: () => null,
    resolveIdentityDecision: () => false,
    autonomyPause: () => null, pauseAutonomy: () => ({ by: ["tui"], since: 0, reason: "" }), resumeAutonomy: () => ({ resumed: false, stillPausedBy: null }), autonomyPauseOverdue: () => false,
    sleeperWatches: () => [],
    actorArms: () => [], pooledArm: () => null, liveSpan: () => null, routeSymptomsAfter: () => 0,
    nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id), controller: () => ctrl, events: () => [],
    scoreFor: () => ({ score: 90, grade: 'A', state: 'ok', flags: [] }),
    noiseFloor: () => -100, hasRealNoise: () => true, history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => now - 1000, ready: () => true, lastError: () => null, symptoms: () => symptoms,
    engineStatus: () => ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 3, rttCeiling: 0, rssiReady: 3, band: 0, bands: 6 }), efficacyFor, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseMin: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  openEpisodes: () => [],
  controlArm: () => null,
  autoPingState: () => null,
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
  };
}
const mkView = (cols: number, rows: number): ViewState =>
  ({ screen: 'remedy', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, symptoms: Symptom[], eff?: DataProvider['efficacyFor']): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(symptoms, eff), visibleNodes: nodes, filtering: false, actionsEnabled: true });
/** Same ctx with the engine's learned-baseline counts overridden (v0.43.1). */
const engCtx = (cols: number, rows: number, eng: ReturnType<DataProvider['engineStatus']>): ScreenCtx =>
  ({ view: mkView(cols, rows), data: { ...data([]), engineStatus: () => eng }, visibleNodes: nodes, filtering: false, actionsEnabled: true });
/** ctx with an arbitrary symptom list at an arbitrary size. */
const engCtx2 = (cols: number, rows: number, syms: Symptom[]): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(syms), visibleNodes: nodes, filtering: false, actionsEnabled: true });
const CAVEAT_RE = /deletes|discards|priority route|half-interviewed|comes back|re-churn/i;
const ENG = { enabled: true as const, ready: 3, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 3, rttCeiling: 0, rssiReady: 3, band: 3, bands: 6 };

const sym = (over: Partial<Symptom> = {}): Symptom => ({
  kind: 'return-path-degraded', nodeId: 6, severity: 'warn', sinceMs: now - 20 * 60_000, basis: 'measured',
  evidence: [{ label: 'timeout rate (10m)', value: '31.0% of 120 tx' }, { label: 'own baseline', value: '2.0%' }],
  narrative: 'Node 6 reply-timeout rate is well above its own normal — a return-path problem. A mains repeater on an interior path usually helps.', ...over,
});

test('Remedy holds EXACTLY view.rows lines within view.cols at every size (empty + populated)', () => {
  const lists: Symptom[][] = [
    [],
    [sym({ severity: 'crit', kind: 'dead-flap' }), sym(), sym({ nodeId: null, kind: 'mesh-interference', basis: 'inferred' })],
  ];
  for (const syms of lists) {
    for (const [cols, rows] of [[40, 12], [80, 24], [120, 40], [200, 50]] as const) {
      const lines = renderRemedy(ctx(cols, rows, syms));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      lines.forEach((l, i) => assert.ok(visLen(l) <= cols, `${cols}x${rows} row ${i}: width ${visLen(l)} > ${cols}`));
    }
  }
});

test('empty state distinguishes all-healthy (all baselines ready) from the title all-clear', () => {
  const lines = renderRemedy(ctx(100, 24, [])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(lines.some((l) => /All clear/.test(l)), 'all-healthy copy (3/3 ready)');
  assert.ok(lines.some((l) => /all clear/.test(l)), 'title token');
});

test('a symptom renders its kind, node, evidence, basis, and dwell age', () => {
  const lines = renderRemedy(ctx(120, 30, [sym()])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const joined = lines.join('\n');
  assert.ok(/return-path-degraded/.test(joined), 'kind shown');
  assert.ok(/#6/.test(joined), 'node shown');
  assert.ok(/31\.0% of 120 tx/.test(joined), 'evidence value shown');
  assert.ok(/measured/.test(joined), 'basis label shown');
  assert.ok(/20m/.test(joined), 'dwell age shown');
});

test('an inferred mesh symptom is labelled "inferred", and a subsumed one is marked', () => {
  const syms = [sym({ nodeId: null, kind: 'mesh-interference', basis: 'inferred' }), sym({ subsumedBy: 'mesh' })];
  const joined = renderRemedy(ctx(120, 30, syms)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/MESH/.test(joined), 'mesh-scoped symptom shows MESH');
  assert.ok(/inferred/.test(joined), 'inferred basis shown');
  assert.ok(/under mesh event/.test(joined), 'subsumed symptom annotated');
});

test('M4: a symptom renders the planner headline and at least one ranked, cost-tagged recommendation', () => {
  const joined = renderRemedy(ctx(120, 40, [sym()])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  // `▎` is the plan-headline bar — unique to a rendered plan (never in a narrative).
  assert.ok(/▎/.test(joined), 'a plan block is rendered');
  assert.ok(/\[(physical|safe|caution|disruptive|destructive) · /.test(joined), 'a candidate carries a cost·basis tag');
  // The anti-footgun is visible: rebuild is present only as NOT-recommended.
  assert.ok(/NOT recommended/.test(joined), 'rebuild is surfaced only as not-recommended');
});

test('M4: on a screen too short for all symptoms, the worst survive and the overflow footer is honest', () => {
  // 2 crit, 1 warn, 2 watch — deliberately more than a 20-row screen holds.
  const syms: Symptom[] = [
    sym({ severity: 'watch', kind: 'weak-signal', nodeId: 6, sinceMs: now - 6 * 60_000 }),
    sym({ severity: 'crit', kind: 'dead-flap', nodeId: 6, sinceMs: now - 4 * 60_000 }),
    sym({ severity: 'watch', kind: 'rtt-degraded', nodeId: 7, sinceMs: now - 5 * 60_000 }),
    sym({ severity: 'crit', kind: 'controller-degraded', nodeId: null, sinceMs: now - 3 * 60_000 }),
    sym({ severity: 'warn', kind: 'return-path-degraded', nodeId: 7, sinceMs: now - 20 * 60_000 }),
  ];
  const rows = 20;
  const plain = renderRemedy(ctx(100, rows, syms)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.equal(plain.length, rows, 'exact-rows contract holds under overflow');

  // Which severities got a rendered header, in render order?
  const RANK: Record<string, number> = { CRIT: 0, WARN: 1, WATCH: 2 };
  const shownSev = plain.map((l) => (l.match(/^\s*(?:▶\s*)?(CRIT|WARN|WATCH)\b/) ?? [])[1]).filter(Boolean) as string[];
  assert.ok(shownSev.length >= 1 && shownSev.length < syms.length, 'some but not all symptoms shown');
  // Worst-first: render order is non-decreasing in severity rank (no watch before a crit).
  for (let i = 1; i < shownSev.length; i++) {
    assert.ok(RANK[shownSev[i]] >= RANK[shownSev[i - 1]], `severity order preserved at ${i} (${shownSev.join(',')})`);
  }
  // Retention: the shown set is a prefix of the severity-sorted list — so every
  // crit is shown before any warn is, and no watch displaces a crit.
  assert.equal(shownSev[0], 'CRIT', 'the worst symptom is shown first');

  // The footer count is honest: shown + "N more" === total.
  const footer = plain.find((l) => /▾ \d+ more symptom/.test(l));
  assert.ok(footer, 'an honest overflow footer is present');
  const n = Number((footer!.match(/▾ (\d+) more/) ?? [])[1]);
  assert.equal(shownSev.length + n, syms.length, `footer count honest: ${shownSev.length} shown + ${n} more === ${syms.length}`);
});

test('M4: the overflow footer survives even when one oversized block fills a tiny screen', () => {
  // Two symptoms, a screen so short even one block overflows: the footer must
  // still be the last visible line, never silently dropped.
  const syms: Symptom[] = [
    sym({ severity: 'crit', kind: 'dead-flap', nodeId: 6 }),
    sym({ severity: 'warn', kind: 'return-path-degraded', nodeId: 7 }),
  ];
  const rows = 9;
  const plain = renderRemedy(ctx(100, rows, syms)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.equal(plain.length, rows, 'exact-rows contract holds');
  assert.ok(plain.some((l) => /▾ \d+ more symptom/.test(l)), 'footer present despite an oversized first block');
});

test('M5: a learned "beat self-healing" efficacy renders a green note on the executable candidate', () => {
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/✓ helped 83% \(n≈6\.0 · 3 nodes\) vs 20% self-heal/.test(joined),
    'the note shows the win, the base rate, n, AND how many nodes taught it');
});

test('M5: a learned-but-not-distinguishable efficacy renders the honest "not distinguishable" note', () => {
  const eff: Eff = { expectedEfficacy: null, n: 8, baseRate: 0.9, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/≈ n≈8\.0 · 3 nodes: not distinguishable from self-healing/.test(joined), 'honest null-result note');
});

test('M5: while still learning (not ready) NO efficacy note is shown', () => {
  const eff: Eff = { expectedEfficacy: null, n: 1, baseRate: null, nodes: 3, ready: false, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(!/helped|not distinguishable/.test(joined), 'says nothing until it has an opinion');
});

test('M4: a subsumed symptom shows NO recommendation (its plan defers to the mesh event)', () => {
  // Only the subsumed symptom present, on a tall screen so nothing is clipped.
  const joined = renderRemedy(ctx(120, 40, [sym({ subsumedBy: 'mesh' })])).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/under mesh event/.test(joined), 'subsumed symptom still shown');
  // No plan bar and no cost tag — the recommendation defers to the mesh event.
  // (The narrative may mention "repeater", so we anchor on plan-only markers.)
  assert.ok(!/▎/.test(joined), 'no plan headline bar for a subsumed symptom');
  assert.ok(!/\[(physical|safe|caution|disruptive|destructive) · /.test(joined), 'no candidate cost tags either');
});

/* ── v0.35 (Z2): the ledger's verdict reaches BLOCKED candidates too ───────── */

const plain = (s: string[]): string => s.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

test('a BLOCKED candidate now reports what was measured — without judging the block', () => {
  // route-churn's ONLY executable candidate is hardcoded blocked, so until
  // v0.35 the ledger's measurement of the very same action was unreachable.
  // The note reports the measurement and that the block still applies — it
  // must NOT characterize the block (an earlier draft said "the block above is
  // lore", which read as calling a SAFETY gate unfounded folklore whenever the
  // block came from gateExecutable rather than the planner's advisory text).
  const eff: Eff = { expectedEfficacy: 0.8, n: 10, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.match(joined, /⊘ physical-link symptom/, 'the block is still stated');
  assert.match(joined, /ledger measured 80% here \(n≈10\.0 · 3 nodes\) vs 20% self-heal — the block above still applies/,
    'the measurement reaches the screen AND the block is never undermined');
  assert.ok(!/✓ helped/.test(joined),
    'never as a green endorsement of advice the screen just told you not to take');
  // NOT a bare !/lore/ — the basis TAG legitimately prints "lore" ([physical · lore]).
  // The defect was the NOTE claiming the block's epistemics, so pin that phrase.
  assert.ok(!/block above is lore/.test(joined),
    'and never characterizes the block — blocked carries safety and config gates too');
});

test('a blocked candidate with a NULL result reports it plainly, endorsing nothing', () => {
  const eff: Eff = { expectedEfficacy: null, n: 12, baseRate: 0.5, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.match(joined, /measured — not distinguishable from self-healing/);
});

test('a blocked candidate with no opinion yet still says NOTHING', () => {
  const eff: Eff = { expectedEfficacy: null, n: 2, baseRate: null, nodes: 3, ready: false, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.ok(!/ledger measured|block above|helped|distinguishable/.test(joined),
    'not-ready is silence, blocked or not');
});

test('one plan can carry BOTH voices — green on the runnable, disagreement on the blocked', () => {
  // return-path-degraded plans a runnable candidate AND a blocked one, and the
  // ledger has the same opinion of each. The note must therefore switch VOICE
  // per candidate, not per plan: the reader has to be able to tell which row
  // the measurement is talking about.
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const rows = plain(renderRemedy(ctx(140, 40, [sym()], () => eff))).split('\n');
  assert.ok(rows.some((l) => /✓ helped 83% \(n≈6\.0 · 3 nodes\) vs 20% self-heal/.test(l)),
    'the runnable candidate keeps the plain green note');
  assert.ok(rows.some((l) => /ledger measured 83% here \(n≈6\.0 · 3 nodes\)/.test(l) && /block above still applies/.test(l)),
    'the blocked candidate gets the measurement-plus-block framing');
  assert.ok(!rows.some((l) => /✓ helped/.test(l) && /ledger measured/.test(l)),
    'and never both on one row');
});

/* ── v0.35 (Z3-e): the detector's own track record ─────────────────────────── */

function withFp(fp: number, symptoms: Symptom[] = [sym()]): ScreenCtx {
  const cx = ctx(140, 40, symptoms);
  (cx.data as { falsePositives?: (k: SymptomKind) => number }).falsePositives = () => fp;
  return cx;
}

test('a detector that has been refused as a misdiagnosis says so ON the card', () => {
  // The ledger has counted these since M5 and no screen showed them — the one
  // number that argues against the card it sits on was the one kept off it.
  const joined = plain(renderRemedy(withFp(3)));
  assert.match(joined, /refused as a misdiagnosis 3×/);
  assert.match(joined, /weigh the evidence above before acting/);
});

test('a CLEAN detector says nothing — no boast, no zero row', () => {
  const joined = plain(renderRemedy(withFp(0)));
  assert.ok(!/misdiagnosis/.test(joined), 'zero refusals is silence');
});

test('a provider with NO ledger renders exactly as a clean one', () => {
  const joined = plain(renderRemedy(ctx(140, 40, [sym()])));
  assert.ok(!/misdiagnosis/.test(joined),
    'absent ledger means no data, which must never render as a warning');
});

test('the exact-rows contract survives the extra warning row at every size', () => {
  for (const [cols, rows] of [[140, 40], [120, 24], [100, 18], [80, 12], [40, 9]] as const) {
    const cx = withFp(5, [sym({ severity: 'crit', kind: 'dead-flap' }), sym(), sym({ nodeId: 7 })]);
    cx.view.cols = cols; cx.view.rows = rows;
    const out = renderRemedy(cx);
    assert.equal(out.length, rows, `rows at ${cols}x${rows}`);
    for (const l of out) assert.ok(l.replace(/\x1b\[[0-9;]*m/g, '').length <= cols, `width at ${cols}x${rows}`);
  }
});

/* ── v0.36: the ledger admits what it could not score ──────────────────────── */

function withUnver(n: number, symptoms: Symptom[] = [sym()]): ScreenCtx {
  const cx = ctx(140, 40, symptoms);
  (cx.data as { unverifiableCount?: (k: SymptomKind) => number }).unverifiableCount = () => n;
  return cx;
}

test('a kind whose episodes all closed UNSCOREABLE says so on the card', () => {
  // An empty efficacy table reads exactly like a patient one. On the live mesh
  // 16 of 16 episodes closed unscoreable and every screen looked like an engine
  // still gathering data.
  const joined = plain(renderRemedy(withUnver(16)));
  assert.match(joined, /16 past episodes of this kind could not be scored/);
  assert.match(joined, /too few readings to judge recovery/);
});

test('it singularises, and a ledger with nothing unscoreable stays silent', () => {
  assert.match(plain(renderRemedy(withUnver(1))), /1 past episode of this kind could not be scored/);
  assert.ok(!/could not be scored/.test(plain(renderRemedy(withUnver(0)))),
    'zero unscoreable is silence, not a boast');
});

test('a provider with NO ledger renders exactly as a clean one', () => {
  assert.ok(!/could not be scored/.test(plain(renderRemedy(ctx(140, 40, [sym()])))),
    'absent ledger means no data, which must never render as a warning');
});

test('the exact-rows contract survives the extra unscoreable row at every size', () => {
  for (const [cols, rows] of [[140, 40], [120, 24], [100, 18], [80, 12], [40, 9]] as const) {
    const cx = withUnver(7, [sym({ severity: 'crit', kind: 'dead-flap' }), sym(), sym({ nodeId: 7 })]);
    cx.view.cols = cols; cx.view.rows = rows;
    const out = renderRemedy(cx);
    assert.equal(out.length, rows, `rows at ${cols}x${rows}`);
    for (const l of out) assert.ok(l.replace(/\x1b\[[0-9;]*m/g, '').length <= cols, `width at ${cols}x${rows}`);
  }
});

/* ── v0.36.5: provenance — one node repeating is not six nodes agreeing ────── */

test('the note says how many DISTINCT nodes taught the arm', () => {
  // Observed live within hours of the ledger starting to work: one flapping
  // device produced six no-change episodes and pushed the fleet-wide
  // (rtt-degraded, ping) arm past its readiness threshold on its own. The
  // statistics were honest; the provenance was invisible.
  const solo: Eff = { expectedEfficacy: null, n: 6, baseRate: 0.2, nodes: 1, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const broad: Eff = { expectedEfficacy: null, n: 6, baseRate: 0.2, nodes: 6, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  assert.match(plain(renderRemedy(ctx(140, 40, [sym()], () => solo))), /n≈6\.0 · 1 node:/);
  assert.match(plain(renderRemedy(ctx(140, 40, [sym()], () => broad))), /n≈6\.0 · 6 nodes:/);
});

test('a ledger that predates the tracking SAYS SO rather than falling silent (v0.43.1)', () => {
  // A pre-v0.36.5 file has no provenance recorded. Rendering "1 node" would be
  // a fabricated claim about evidence breadth — but silence was not honest
  // either: it is indistinguishable from a screen that simply omits the count,
  // and ENGINE has said "sources not recorded" for the same row since v0.41.1.
  // Two screens, one ledger key, two different stories. Now one function.
  const old: Eff = { expectedEfficacy: 0.9, n: 8, baseRate: 0.2, nodes: 0, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  const joined = plain(renderRemedy(ctx(140, 40, [sym()], () => old)));
  assert.match(joined, /✓ helped 90% \(n≈8\.0 · sources not recorded\) vs 20% self-heal/);
  assert.ok(!/\d+ nodes?/.test(joined.split('\n').find((l) => /helped 90%/.test(l)) ?? ''),
    'names the gap rather than inventing a count');
});

test('the card distinguishes “too few readings” from “cannot be probed”', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { unverifiableCount?: (k: SymptomKind) => number }).unverifiableCount = () => 3;
  (cx.data as { unverifiableUnprobeableCount?: (k: SymptomKind) => number }).unverifiableUnprobeableCount = () => 9;
  const joined = plain(renderRemedy(cx));
  assert.match(joined, /3 past episodes of this kind could not be scored — too few readings/);
  assert.match(joined, /9 more on sleeping devices that cannot be probed — unscoreable by design/);
});

test('the sleeping-device line is silent when there are none', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { unverifiableCount?: (k: SymptomKind) => number }).unverifiableCount = () => 3;
  (cx.data as { unverifiableUnprobeableCount?: (k: SymptomKind) => number }).unverifiableUnprobeableCount = () => 0;
  assert.ok(!/cannot be probed/.test(plain(renderRemedy(cx))));
});

test('a transient blink renders its own unscoreable-by-design row (v0.39)', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { unverifiableCount?: (k: SymptomKind) => number }).unverifiableCount = () => 3;
  (cx.data as { unverifiableTransientCount?: (k: SymptomKind) => number }).unverifiableTransientCount = () => 2;
  const joined = plain(renderRemedy(cx));
  assert.match(joined, /2 transient blinks — over before the evidence floor filled; unscoreable by design/);
});

test('the transient-blink line is silent at zero (v0.39)', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { unverifiableCount?: (k: SymptomKind) => number }).unverifiableCount = () => 3;
  (cx.data as { unverifiableTransientCount?: (k: SymptomKind) => number }).unverifiableTransientCount = () => 0;
  assert.ok(!/transient blink/.test(plain(renderRemedy(cx))));
});

test('a confounded closure renders its own credited-to-neither-arm row (v0.40)', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { confoundedCount?: (k: SymptomKind) => number }).confoundedCount = () => 2;
  assert.match(plain(renderRemedy(cx)), /2 confounded — credited to neither arm \(a death, remediation or probe re-route during or just before the episode\)/);
  // The verdict leads (v0.78.0): a narrower terminal cuts the causes, not it.
  const narrow = ctx(60, 40, [sym()]);
  (narrow.data as { confoundedCount?: (k: SymptomKind) => number }).confoundedCount = () => 2;
  assert.match(plain(renderRemedy(narrow)), /2 confounded — credited to neither arm/);
});

test('the confounded line is silent at zero (v0.40)', () => {
  const cx = ctx(140, 40, [sym()]);
  (cx.data as { confoundedCount?: (k: SymptomKind) => number }).confoundedCount = () => 0;
  assert.ok(!/confounded/.test(plain(renderRemedy(cx))));
});

test('"All clear" does not claim the engine is idle while the ledger is still scoring (v0.43.1)', () => {
  // An episode in its confirmation window has NO live symptom by construction,
  // so REMEDY's symptom-only view could print an unqualified all-clear while
  // the ledger was mid-experiment on several nodes.
  const cx = ctx(120, 30, []);
  (cx.data as { openEpisodes?: () => unknown[] }).openEpisodes = () => ([
    { key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded', onsetMs: now - 300_000, actionKind: null, confounded: false, beforeFreshN: 4, confirming: true },
    { key: '9:rate-fallback', nodeId: 9, kind: 'rate-fallback', onsetMs: now - 60_000, actionKind: null, confounded: false, beforeFreshN: 2, confirming: false },
  ]);
  const joined = plain(renderRemedy(cx));
  assert.match(joined, /All clear/, 'the symptom claim itself is still true');
  assert.match(joined, /still scoring 2 episodes \(1 in the confirmation window\)/,
    `the ledger's live workload must be disclosed: ${joined.slice(-500)}`);
});

test('with no open episodes the all-clear reads exactly as before (v0.43.1)', () => {
  const cx = ctx(120, 30, []);
  (cx.data as { openEpisodes?: () => unknown[] }).openEpisodes = () => [];
  const joined = plain(renderRemedy(cx));
  assert.match(joined, /New symptoms will surface here/);
  assert.ok(!/still scoring/.test(joined));
});

test('a withheld efficacy claim EXPLAINS itself with the bound that withheld it (v0.43.1)', () => {
  // "Not distinguishable" is the engine's most common verdict and was its least
  // explicable: the Wilson LOWER bound decides it, and that number was computed
  // and discarded at the ledger boundary. An operator looking at an arm that
  // plainly succeeded most of the time had no way to see how far short it fell.
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: 0.6, nodes: 3, ready: true, lowerBound: 0.52, bar: 0.65, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /not distinguishable from self-healing/);
  assert.match(joined, /even pessimistically 52%, short of the 65% bar \(60% self-heal \+ margin\)/,
    `the deciding bound must be shown: ${joined.slice(0, 600)}`);
});

test('the explanation reports the BAR, so it never reads as a win under a loss (v0.43.1)', () => {
  // The gate is `lower >= base + minEffect`, not `lower >= base`. An arm whose
  // bound sits between the two is withheld — and reporting it against the bare
  // base rate printed "even pessimistically 63% vs 60% self-heal" directly
  // under "not distinguishable from self-healing": two numbers that say the
  // arm won, beneath a verdict that says it did not.
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: 0.6, nodes: 3, ready: true, lowerBound: 0.63, bar: 0.65, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  const line = joined.split('\n').find((l) => /not distinguishable/.test(l)) ?? '';
  assert.match(line, /short of the 65% bar/, `the bar must be named: "${line.trim()}"`);
  assert.doesNotMatch(line, /63% vs 60%/, 'never a bare bound-beats-base comparison under a withheld verdict');
});

test('with no measured base rate the withheld claim says THAT, not a false comparison (v0.43.1)', () => {
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: null, nodes: 2, ready: true, lowerBound: 0.44, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /even pessimistically 44%, and self-heal is not measured yet/);
});

test('a full TIMEOUT baseline with an empty RSSI baseline is NOT "every node learned" (v0.43.1)', () => {
  // The pre-v0.43.1 count was timeouts only. A fleet whose RSSI series has
  // never graduated rendered the green all-clear and the sentence "Every node
  // has a graduated baseline" — a claim over three series from one series.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, rssiReady: 0, rttReady: 1 })));
  assert.doesNotMatch(joined, /All clear/, 'the green all-clear is NOT taken while a series is still learning');
  // COPY CHANGE, not a relaxed invariant (v0.46.0): this fixture is PARTIAL
  // coverage — some series graduated, some did not — which now has its own
  // state. It used to read "Learning", implying a convergence that on a routed
  // mesh never arrives. Every load-bearing assertion below is unchanged.
  assert.match(joined, /partial detector coverage/);
  assert.match(joined, /timeouts 3\/3/);
  assert.match(joined, /rtt 1\/3/);
  assert.match(joined, /rssi 0\/3/);
});

test('every baseline count names the time-of-day band it was measured in (v0.43.1)', () => {
  // bandOf() = hour / (24 / N_BANDS), so band 3 of 6 is 12:00–16:00. The counts
  // are true only for that band; a node can read learned at 03:00 and unlearned
  // at 15:00 with nothing having changed.
  const learning = plain(renderRemedy(engCtx(200, 40, { ...ENG, rttReady: 1, band: 3 })));
  assert.match(learning, /12:00–16:00/, `band named while learning: ${learning.slice(0, 400)}`);
  const clear = plain(renderRemedy(engCtx(200, 40, { ...ENG, band: 5 })));
  assert.match(clear, /All clear/);
  assert.match(clear, /20:00–24:00/, 'and named on the all-clear too');
});

test('both DETECTOR series graduated in this band reaches the all-clear (v0.43.1, narrowed v0.47.0)', () => {
  const joined = plain(renderRemedy(engCtx(200, 40, ENG)));
  assert.match(joined, /✓ All clear/);
  assert.match(joined, /graduated timeout and rtt baseline/);
});

test('an ungraduated RSSI baseline does not block the all-clear — it arms no detector (v0.47.0)', () => {
  // `grep -n 'baselines\.' src/zwave/symptoms.ts` returns exactly timeoutNormal
  // and rttNormal. rssiNormal has ZERO detector consumers — weak-signal uses an
  // absolute 7 dB margin over the measured floor. v0.46.0 gated a DETECTION
  // claim on it, and told the operator a degradation "would not be flagged" on
  // nodes where nothing was blind at all.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, rssiReady: 0 })));
  assert.match(joined, /✓ All clear/, `rssi must not gate detection: ${joined.slice(0, 800)}`);
  assert.match(joined, /rssi is short on 3/, 'but it is still reported...');
  assert.match(joined, /arms no detector/, '...and described for what it is');
});

test('the banded empty states hold the exact row contract at every size (v0.43.1)', () => {
  for (const eng of [ENG, { ...ENG, rssiReady: 0, rttReady: 2 }]) {
    for (const [cols, rows] of [[40, 12], [80, 24], [120, 40], [200, 50]] as const) {
      const lines = renderRemedy(engCtx(cols, rows, eng));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      for (const l of lines) assert.ok(plain([l]).length <= cols, `${cols}x${rows}: line fits`);
    }
  }
});

test('a narrow terminal DROPS a baseline count rather than clipping it mid-number (v0.43.1)', () => {
  // At 40 cols the fixed-width counts line clipped to `rssi 1` where the truth
  // was 12/39 — a plausible, wrong measurement, which chrome.ts calls a bigger
  // lie than a disclosed drop. Every count that renders must be WHOLE, in
  // order, with an optional disclosed "+N" for what was dropped. A
  // prefix-truncated line ("… rssi 1", or a severed "rss") fails this outright.
  for (let cols = 40; cols <= 120; cols += 1) {
    const lines = plain(renderRemedy(engCtx(cols, 24,
      { ...ENG, total: 39, timeoutReady: 39, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 12 }))).split('\n');
    const counts = lines.find((l) => /timeouts/.test(l));
    assert.ok(counts != null, `${cols} cols: the counts line vanished entirely`);
    assert.match(counts,
      /^\s*timeouts 39\/39(\s+rtt 1\/39)?(\s+rssi 12\/39)?(\s+\+\d+)?\s*$/,
      `${cols} cols: a baseline count was clipped rather than dropped — "${counts}"`);
    assert.ok(counts.length <= cols, `${cols} cols: counts line overflows`);
  }
});


test('the LEARNING headline keeps its band qualifier at the narrowest terminal (v0.43.1)', () => {
  // Losing the band turns the headline back into the timeless assertion this
  // release exists to eliminate. 40x12 is the narrowest supported size.
  // The fixture is PARTIAL coverage, so as of v0.46.0 the headline is the
  // partial-coverage one. The invariant under test is unchanged: whatever the
  // headline says, it must never lose its band qualifier to truncation.
  // Match the headline by its GLYPH, not its words: the ladder sheds words at
  // narrow widths, and pinning the wording here would make the test fail for a
  // shorter-but-still-honest headline while missing a dropped band qualifier.
  const HEAD = /^\s*[◷◑]/;
  const lines = plain(renderRemedy(engCtx(40, 12, { ...ENG, rttReady: 1, band: 3 }))).split('\n');
  const head = lines.find((l) => HEAD.test(l)) ?? '';
  assert.match(head, /12–16h/, `band qualifier lost at 40 cols: "${head.trim()}"`);
  // Wide terminals keep the full form.
  const wide = plain(renderRemedy(engCtx(120, 24, { ...ENG, rttReady: 1, band: 3 }))).split('\n');
  assert.match(wide.find((l) => HEAD.test(l)) ?? '', /12:00–16:00/);
  // And the qualifier survives EVERY width in between — never silently dropped.
  for (let cols = 40; cols <= 200; cols += 1) {
    const h = plain(renderRemedy(engCtx(cols, 24, { ...ENG, rttReady: 1, band: 3 }))).split('\n')
      .find((l) => HEAD.test(l)) ?? '';
    assert.ok(/12:00–16:00|12–16h/.test(h), `${cols} cols lost the band: "${h.trim()}"`);
  }
});

test('an engine with an EMPTY roster does not render an all-clear (v0.43.1)', () => {
  // total === 0 passes all three "fully graduated" comparisons (0 < 0 is
  // false), so the green branch asserted three graduated series and a
  // measurement band from zero observations — the state at boot, before the
  // first roster poll returns.
  const joined = plain(renderRemedy(engCtx(120, 30,
    { enabled: true, ready: 0, total: 0, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0, band: 2, bands: 6 })));
  assert.doesNotMatch(joined, /All clear/, 'nothing measured cannot be cleared');
  assert.doesNotMatch(joined, /graduated timeout, rtt and rssi/, 'nor claimed as graduated');
  assert.match(joined, /No nodes yet/);
  for (const [cols, rows] of [[40, 12], [200, 50]] as const) {
    const lines = renderRemedy(engCtx(cols, rows,
      { enabled: true, ready: 0, total: 0, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0, band: 2, bands: 6 }));
    assert.equal(lines.length, rows, `${cols}x${rows}: exact rows`);
    for (const l of lines) assert.ok(plain([l]).length <= cols, `${cols}x${rows}: fits`);
  }
});

test('the self-heal rate carries its OWN n and node count (v0.44.0)', () => {
  // "vs 20% self-heal" shipped as a bare percentage beside an action arm that
  // carried n≈ and provenance. Four episodes on one flapping node and four on
  // four distinct nodes rendered identically — and the control arm is the
  // number the operator is being asked to beat.
  const eff = (): Eff => ({ expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true,
    lowerBound: 0.55, bar: 0.25, minN: 4, baseN: 9.4, baseNodes: 5, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /vs 20% self-heal \(n≈9\.4 · 5 nodes\)/,
    `the control arm must carry its own evidence: ${joined.slice(0, 700)}`);
});

test('an unrecorded control weight omits the parenthetical rather than printing n≈0.0 (v0.44.0)', () => {
  // baseRate() withholds below minEpisodes, so a non-null rate with a zero
  // weight cannot arise live — it means a ledger written before the weight was
  // tracked. "n≈0.0" would state a measurement of nothing.
  const eff = (): Eff => ({ expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true,
    lowerBound: 0.55, bar: 0.25, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /vs 20% self-heal/);
  assert.doesNotMatch(joined, /n≈0\.0/, 'never a measurement of nothing');
});

test('an action below readiness says SO, and still reports the self-heal rate (v0.44.0)', () => {
  // "still learning" and "no ledger at all" both rendered as silence, while the
  // CONTROL arm may be fully measured — and that rate is precisely the decision
  // input when the action itself is unproven.
  const eff = (): Eff => ({ expectedEfficacy: null, n: 2, baseRate: 0.8, nodes: 1, ready: false,
    lowerBound: null, bar: null, minN: 4, baseN: 12.5, baseNodes: 6, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /still learning this action \(n≈2\.0 of 4\)/);
  assert.match(joined, /80% self-heal \(n≈12\.5 · 6 nodes\)/);
  // It must NOT borrow the vocabulary of a measured verdict.
  assert.doesNotMatch(joined, /not distinguishable/, 'an unjudged arm is not a judged one');
});

test('no ledger at all is still silence, not a fabricated learning notice (v0.44.0)', () => {
  const eff = (): Eff => ({ expectedEfficacy: null, n: 0, baseRate: null, nodes: 0, ready: false,
    lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.doesNotMatch(joined, /still learning this action/,
    'with no control arm and no attempts there is nothing to report');
});

test('a structurally unscoreable kind SAYS so, permanently (v0.44.0)', () => {
  // node-down accumulates no efficacy record ever. Silence there is not
  // neutral: every other kind does accumulate one, so the absence reads as
  // "still learning" — indefinitely. The loop is not slow, it is off.
  const joined = plain(renderRemedy(ctx(200, 40, [sym({ kind: 'node-down', nodeId: 6 })])));
  assert.match(joined, /not measured by the ledger/,
    `node-down must disclose why it has no ledger: ${joined.slice(0, 800)}`);
  assert.match(joined, /no control arm to compare against/);
  // A scoreable kind must NOT carry the notice.
  const ok = plain(renderRemedy(ctx(200, 40, [sym({ kind: 'rtt-degraded' })])));
  assert.doesNotMatch(ok, /not measured by the ledger/);
});

test('an action measured as HARMFUL says so instead of quoting an efficacy (v0.44.0)', () => {
  // The one number on the card that can argue against an action the planner is
  // offering. `worse` used to be folded into `no-change`, so this rendered as
  // "not distinguishable from self-healing".
  const eff = (): Eff => ({ expectedEfficacy: null, n: 10, baseRate: 0.3, nodes: 4, ready: true,
    lowerBound: 0.1, bar: 0.35, minN: 4, baseN: 8, baseNodes: 4, harmed: 4, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /made it WORSE in 40% of n≈10\.0 · 4 nodes/,
    `the harm rate must lead: ${joined.slice(0, 800)}`);
  assert.doesNotMatch(joined, /not distinguishable from self-healing/,
    'harm is not the same finding as inefficacy');
});

test('an occasional regression does NOT trigger the harm warning (v0.44.0)', () => {
  const eff = (): Eff => ({ expectedEfficacy: 0.7, n: 10, baseRate: 0.3, nodes: 4, ready: true,
    lowerBound: 0.45, bar: 0.35, minN: 4, baseN: 8, baseNodes: 4, harmed: 1, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.doesNotMatch(joined, /made it WORSE/, 'one regression in ten is not a harm finding');
  assert.match(joined, /✓ helped 70%/);
});

/* ── v0.44.0: harm must be as hard to claim as benefit ─────────────────────── */

test('a SINGLE regression on one node does NOT author a harm warning (v0.44.0)', () => {
  // The pre-release defect, reproduced exactly: 4 no-change then 1 worse gives
  // n≈4.709 and harmed 1.0, a bare ratio of 21% — over the old 0.2 threshold.
  // Moving that same regression earlier in the sequence changed the decayed n
  // and made the warning vanish, so ORDER ALONE decided whether the screen
  // accused a remedy. The bound now decides instead.
  const eff = (): Eff => ({ expectedEfficacy: null, n: 4.709, baseRate: 0.3, nodes: 1, ready: true,
    lowerBound: 0.1, bar: 0.35, minN: 4, baseN: 9, baseNodes: 4, harmed: 1, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.doesNotMatch(joined, /made it WORSE/,
    `one regression at n≈4.7 must not accuse: ${joined.slice(0, 700)}`);
});

test('one flapping node cannot author a harm warning on its own (v0.44.0)', () => {
  // Plenty of evidence by weight, all of it from a single device — the exact
  // shape that taught the fleet-wide arm past its threshold in v0.36.5.
  const solo = (): Eff => ({ expectedEfficacy: null, n: 20, baseRate: 0.3, nodes: 1, ready: true,
    lowerBound: 0.1, bar: 0.35, minN: 4, baseN: 20, baseNodes: 5, harmed: 12, baseHarmed: 0 });
  assert.doesNotMatch(plain(renderRemedy(ctx(200, 40, [sym()], solo))), /made it WORSE/);
  const broad = (): Eff => ({ ...(solo() as NonNullable<Eff>), nodes: 5 });
  assert.match(plain(renderRemedy(ctx(200, 40, [sym()], broad))), /made it WORSE in 60%/);
});

test('an action that worsens LESS often than doing nothing is not called harmful (v0.44.0)', () => {
  // The comparison the first cut got wrong: it measured the action's REGRESSION
  // rate against the control's IMPROVEMENT rate — two different quantities. If
  // the symptom self-worsens 40% of the time, an action that worsens 21% is
  // better than leaving it alone, and saying otherwise steers the operator away
  // from a remedy that helps.
  const eff = (): Eff => ({ expectedEfficacy: null, n: 20, baseRate: 0.1, nodes: 6, ready: true,
    lowerBound: 0.1, bar: 0.15, minN: 4, baseN: 20, baseNodes: 6, harmed: 4.2, baseHarmed: 8 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.doesNotMatch(joined, /made it WORSE/,
    `21% worse against a 40% self-worsening baseline is an improvement: ${joined.slice(0, 700)}`);
});

test('a harm finding names what LEAVING IT ALONE does — the same quantity (v0.44.0)', () => {
  const eff = (): Eff => ({ expectedEfficacy: null, n: 20, baseRate: 0.3, nodes: 6, ready: true,
    lowerBound: 0.1, bar: 0.35, minN: 4, baseN: 20, baseNodes: 6, harmed: 12, baseHarmed: 1 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /made it WORSE in 60% of n≈20\.0 · 6 nodes — leaving it alone: 5% worse/,
    `both numbers must be regression rates: ${joined.slice(0, 700)}`);
});

test('a harm finding never SUPPRESSES a granted efficacy claim (v0.44.0)', () => {
  // An action can genuinely help most of the time and hurt some of the time.
  // Returning early on harm hid a claim ENGINE simultaneously rendered in green
  // from the same ledger row — two screens, one row, opposite conclusions.
  const eff = (): Eff => ({ expectedEfficacy: 0.7, n: 20, baseRate: 0.3, nodes: 6, ready: true,
    lowerBound: 0.481, bar: 0.35, minN: 4, baseN: 20, baseNodes: 6, harmed: 8, baseHarmed: 1 });
  const joined = plain(renderRemedy(ctx(220, 40, [sym()], eff)));
  assert.match(joined, /helped 70%/, `the earned claim must survive: ${joined.slice(0, 800)}`);
  assert.match(joined, /made it WORSE in 40%/, 'and the harm must still be said');
});

test('a below-readiness arm whose every attempt regressed says so, hedged (v0.44.0)', () => {
  // The readiness gate was silencing precisely the arm an operator most needs
  // warned about: three attempts, three regressions, and the screen said only
  // "still learning".
  const eff = (): Eff => ({ expectedEfficacy: null, n: 3, baseRate: 0.5, nodes: 2, ready: false,
    lowerBound: null, bar: null, minN: 4, baseN: 9, baseNodes: 4, harmed: 3, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /every attempt so far made it WORSE \(too few to be sure\)/,
    `an all-regressions arm must speak below readiness: ${joined.slice(0, 700)}`);
});

test('an action NEVER RUN here says that, not "still learning" (v0.44.0)', () => {
  const eff = (): Eff => ({ expectedEfficacy: null, n: 0, baseRate: 0.58, nodes: 0, ready: false,
    lowerBound: null, bar: null, minN: 4, baseN: 4.7, baseNodes: 5, harmed: 0, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /never tried here — this kind self-heals 58%/);
  assert.doesNotMatch(joined, /still learning this action \(n≈0\.0/,
    'an arm nobody ran is not one that is learning');
});

test('the unscoreable disclosure WRAPS rather than being cut mid-word (v0.44.0)', () => {
  // The sentence needs ~185 columns. Emitted as one truncate()'d row it was cut
  // mid-word at every realistic terminal, so the disclosure disclosed nothing.
  for (const cols of [80, 100, 120]) {
    const lines = plain(renderRemedy(engCtx2(cols, 40, [sym({ kind: 'node-down', nodeId: 6 })]))).split('\n');
    // Normalize the wrap indentation before matching — the sentence spans rows.
    const joined = lines.map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
    assert.match(joined, /not measured by the ledger/, `${cols} cols: the lead must render`);
    assert.match(joined, /no control arm to compare against/,
      `${cols} cols: the REASON must survive, not just the lead — "${lines.filter((l) => /ledger/.test(l)).join(' | ')}"`);
    for (const l of lines) assert.ok(l.length <= cols, `${cols} cols: overflow`);
  }
});

test('a BLOCKED candidate is never rendered in the endorsing green (v0.44.0)', () => {
  // Colour is load-bearing here: green is the endorsement, and a candidate the
  // planner has blocked must never wear it however good the measurement is.
  // A harm finding disqualifies green for the same reason.
  const good = (): Eff => ({ expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true,
    lowerBound: 0.55, bar: 0.25, minN: 4, baseN: 9, baseNodes: 5, harmed: 0, baseHarmed: 0 });
  // route-churn's rebuild candidate is BLOCKED — its measurement renders as a
  // yellow caveat, never as an endorsement.
  const rawBlocked = renderRemedy(ctx(200, 40, [sym({ kind: 'route-churn' })], good)).join('\n');
  const blockedLine = rawBlocked.split('\n').find((l) => /ledger measured/.test(l));
  assert.ok(blockedLine, 'the blocked candidate carries a measurement');
  assert.ok(!/\x1b\[92m/.test(blockedLine), `a blocked row must not be green: ${blockedLine}`);
  assert.ok(/\x1b\[93m/.test(blockedLine), 'it is yellow — a measurement under a caveat');

  const raw = renderRemedy(ctx(200, 40, [sym()], good)).join('\n');
  const plainGood = raw.split('\n').find((l) => /✓ helped 83%/.test(l));
  assert.ok(plainGood && /\x1b\[92m/.test(plainGood), 'an unblocked, harmless win IS green');

  // And a win that also carries a measured harm rate is not green either.
  const harmful = (): Eff => ({ ...(good() as NonNullable<Eff>), harmed: 8, n: 20, nodes: 6, baseHarmed: 1, baseN: 20 });
  const rawHarm = renderRemedy(ctx(220, 40, [sym()], harmful)).join('\n');
  const harmLine = rawHarm.split('\n').find((l) => /helped 83%/.test(l));
  assert.ok(harmLine, 'the claim survives');
  assert.ok(!/\x1b\[92m/.test(harmLine), 'but a measured regression rate disqualifies green');
});

/* ── v0.45.0: nothing is clipped into a plausible lie ─────────────────────── */

test('cluster member ids are DROPPED whole, never clipped into an innocent node (v0.45.0)', () => {
  // `Symptom.members` was populated by the edge-cluster detector and read by
  // NOTHING; the ids survived only inside an evidence string that truncate()
  // cut mid-list, so `#4, #17, #23` became `#4, #17, #2` — naming a node that
  // is not degraded. A half-shed id is a different device.
  const members = [4, 17, 23, 31, 42, 55, 61];
  for (let cols = 40; cols <= 200; cols += 1) {
    const lines = plain(renderRemedy(engCtx2(cols, 40,
      [sym({ kind: 'edge-cluster', nodeId: 9, members })]))).split('\n');
    const row = lines.find((l) => /downstream/.test(l));
    assert.ok(row, `${cols} cols: the members row must render`);
    // Every id that appears must be one of the real ones, WHOLE.
    for (const m of row.match(/#\d+/g) ?? []) {
      assert.ok(members.includes(Number(m.slice(1))),
        `${cols} cols: "${m}" is not a member — an id was clipped into an innocent node: "${row.trim()}"`);
    }
    // And what fell off is disclosed.
    const shown = (row.match(/#\d+/g) ?? []).length;
    if (shown < members.length) {
      assert.ok(row.includes(`+${members.length - shown}`),
        `${cols} cols: ${members.length - shown} ids dropped without disclosure: "${row.trim()}"`);
    }
    assert.ok(row.length <= cols, `${cols} cols: overflow`);
  }
});

test('a blocked reason reaches the operator WHOLE, on a continuation row if it must (v0.45.0)', () => {
  // This row ended in truncate() with the ⊘ reason last, so at 80 columns the
  // longest blocked candidate came back as a sentence that stops making sense —
  // on the one row whose entire job is to say why NOT to act.
  for (const cols of [80, 100, 120, 160]) {
    const joined = plain(renderRemedy(engCtx2(cols, 40, [sym({ kind: 's2-desync', nodeId: 6 })])));
    const norm = joined.split('\n').map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
    // UNCONDITIONAL: the reason must ARRIVE, inline or on a continuation row.
    // Skipping when the chip is absent is what let a dropped chip pass.
    assert.match(norm, /⊘ RF-link symptom — will not repair it/,
      `${cols} cols: the blocked reason must arrive whole — "${norm.slice(0, 500)}"`);
  }
});

test('an over-long head still respects the terminal width (v0.45.0)', () => {
  // shedLine never sheds the head — but "never shed" is not "never bounded".
  const long = 'X'.repeat(400);
  for (const cols of [40, 80, 120]) {
    const lines = plain(renderRemedy(engCtx2(cols, 40,
      [sym({ kind: 'edge-cluster', nodeId: 9, members: [4, 17], narrative: long })]))).split('\n');
    for (const l of lines) assert.ok(l.length <= cols, `${cols} cols: overflow — "${l.slice(0, 90)}"`);
  }
});



test('a caveat below the top candidate is grounded; a plain rationale is not (v0.45.0)', () => {
  // Two behaviours in one gate. (a) a candidate at index >= 1 gets a line if
  // its rationale carries a caveat; (b) it does NOT otherwise — planner blocks
  // every executable when write actions are off, so grounding all three would
  // blow the row budget on a read-only install.
  const joined = plain(renderRemedy(engCtx2(160, 40, [sym({ kind: 'route-churn', nodeId: 6 })])));
  const grounded = joined.split('\n').filter((l) => /^ {8}\S/.test(l) && !/helped|distinguishable|still learning|never tried|WORSE|ledger measured|⊘/.test(l));
  assert.ok(grounded.length >= 2,
    `the second candidate's caveat must be grounded too: ${JSON.stringify(grounded)}`);
  assert.ok(grounded.some((l) => CAVEAT_RE.test(l)),
    `at least one grounding line is the caveat: ${JSON.stringify(grounded)}`);
  // And not EVERY candidate gets one.
  assert.ok(grounded.length <= 3, `grounding must stay bounded: ${JSON.stringify(grounded)}`);
});

test('a destructive caveat is grounded wherever its candidate ranks (v0.45.0)', () => {
  // The grounding line was gated on `i === 0`, so a caveat on a second-ranked
  // candidate rendered at NO terminal size and widening never helped. route-churn
  // ranks the repeater advice first and the rebuild second.
  const joined = plain(renderRemedy(engCtx2(160, 40, [sym({ kind: 'route-churn', nodeId: 6 })])));
  assert.match(joined, /re-churn|priority route|deletes/i,
    `the rebuild's caveat must render: ${joined.slice(0, 900)}`);
});

test('EVERY symptom kind holds the width contract at the narrowest terminal (v0.45.0)', () => {
  // shedLine never sheds the head — but "never shed" is not "never bounded".
  // chatty-device's longest candidate title is 71 columns before its cost tags,
  // so at 40 columns the head alone overflows and must still be clipped.
  const KINDS: SymptomKind[] = [
    'return-path-degraded', 'chronic-return-path', 'dead-flap', 'node-down', 'quiet-node',
    'rate-fallback', 'route-churn', 'rtt-degraded', 'weak-signal', 'chatty-device',
    'ghost-suspect', 'controller-degraded', 'edge-cluster', 'mesh-interference', 's2-desync',
  ];
  for (const kind of KINDS) {
    const nodeId = kind === 'controller-degraded' || kind === 'mesh-interference' ? null : 6;
    for (const [cols, rows] of [[40, 12], [56, 20], [80, 24], [120, 40]] as const) {
      const lines = renderRemedy(engCtx2(cols, rows, [sym({ kind, nodeId, members: kind === 'edge-cluster' ? [4, 17, 23] : undefined })]));
      assert.equal(lines.length, rows, `${kind} ${cols}x${rows}: exactly ${rows} rows`);
      for (const l of lines) {
        assert.ok(plain([l]).length <= cols, `${kind} ${cols}x${rows}: width — "${plain([l]).slice(0, 90)}"`);
      }
    }
  }
});

test('a candidate whose rationale carries NO caveat gets no grounding line (v0.45.0)', () => {
  // dead-flap has two candidates and no caveat below the top one, so exactly
  // ONE grounding line may render. The over-broad form the spec warned against
  // — grounding every candidate — would render two here, and three on any card
  // where the planner blocks every executable (a read-only install).
  const lines = plain(renderRemedy(engCtx2(160, 40, [sym({ kind: 'dead-flap', nodeId: 6 })]))).split('\n');
  const grounded = lines.filter((l) => /^ {8}\S/.test(l)
    && !/helped|distinguishable|still learning|never tried|WORSE|ledger measured|⊘/.test(l));
  assert.equal(grounded.length, 1,
    `only the top candidate is grounded here: ${JSON.stringify(grounded.map((l) => l.trim().slice(0, 60)))}`);
});

/* ── v0.46.0: coverage is not health ──────────────────────────────────────── */

test('partial baseline coverage is NOT rendered as "Learning" forever (v0.46.0)', () => {
  // MEASURED on the live mesh 2026-08-31: rssi/rtt converge on the
  // DIRECT-routed subset (23 of 38), never on `total`, because a route change
  // resets both across all six bands and they fold only on FRESH samples
  // (~1.5-3.3 per band per day against MIN_OBS 20). "Learning" implied a
  // convergence that never arrives; the honest state names the blind detectors.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 1 })));
  assert.doesNotMatch(joined, /All clear/, 'still not the green all-clear');
  assert.match(joined, /partial detector coverage/);
  // Only the DETECTOR-arming series count as blindness (v0.47.0) — rssi arms
  // none, so it is reported separately rather than as a missing detector.
  assert.match(joined, /No learned yardstick in this band: rtt \(2\) of 3 nodes/,
    `the blind detectors must be NAMED with counts: ${joined.slice(0, 900)}`);
  assert.match(joined, /rssi is short on 2 — a dossier yardstick only/);
  assert.match(joined, /COVERAGE, not health/, 'it must refuse the health claim outright');
});

test('rtt nodes held to the fixed ceiling are counted apart, and the screen stops saying they would not be flagged (v0.79.0)', () => {
  // 1 of 3 graduated, 2 judged against the ceiling only. "would not be
  // flagged" was true of an ungraduated node until the ceiling; it is not now,
  // and "covered" would be false too.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 2, rssiReady: 3 })));
  assert.match(joined, /partial detector coverage/, 'still partial: a ceiling is not a learned normal');
  assert.match(joined, /rtt 1\/3\s+ceiling-only 2\s+rssi 3\/3/, 'its own count, between rtt and rssi');
  assert.match(joined, /may go unflagged/);
  assert.doesNotMatch(joined, /would not be flagged/);
  assert.match(joined, /rtt: 2 with no learned normal are held to a fixed 300 ms\s+ceiling meanwhile, so only a severe slowdown is flagged there\./);
  // With none held to it, the old sentence is still the true one.
  const none = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 3 })));
  assert.match(none, /would not be flagged/);
  assert.doesNotMatch(none, /ceiling/);
  // Nothing learned at all: the ceiling is still said.
  const learning = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 3, rssiReady: 0 })));
  assert.match(learning, /no detector has a learned yardstick yet/);
  assert.match(learning, /rtt: 3 with no learned normal are held to a fixed 300 ms/);
  // With the ceiling judging, only the LEARNED detectors are still waiting.
  assert.match(learning, /before its\s+learned detectors may fire\./);
  const learningNoCeiling = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 })));
  assert.match(learningNoCeiling, /before its\s+detectors may fire\./);
  assert.doesNotMatch(learningNoCeiling, /learned detectors may fire/);
  // And the row contract holds at every size with the extra field and lines.
  for (const [cols, rows] of [[40, 12], [56, 20], [80, 24], [120, 40]] as const) {
    const lines = renderRemedy(engCtx(cols, rows, { ...ENG, total: 39, timeoutReady: 39, timeoutWindowBlind: 0, rttReady: 10, rttCeiling: 25, rssiReady: 12 }));
    assert.equal(lines.length, rows);
    for (const l of lines) assert.ok(plain([l]).length <= cols, `${cols}x${rows}: width`);
  }
});

test('zero coverage says LEARNING and makes no symptom claim at all (v0.46.0)', () => {
  // With no detector able to fire, "no symptoms" would describe the instrument,
  // not the mesh.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 })));
  assert.match(joined, /no detector has a learned yardstick yet/);
  assert.doesNotMatch(joined, /No symptoms/, 'nothing detectable ⇒ no symptom claim');
  assert.doesNotMatch(joined, /All clear/);
});

test('the open-episode disclosure survives PARTIAL coverage (v0.46.0)', () => {
  // The v0.43.1 disclosure sat only in the green branch — behind a gate this
  // mesh cannot pass, so in production it was unreachable. Same shape as the
  // v0.36 inert learning loop: a feature wired, tested, and structurally dead.
  const eng = { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 1 };
  const ctxP: ScreenCtx = { view: mkView(200, 40),
    data: { ...data([]), engineStatus: () => eng,
      openEpisodes: () => ([{ key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded' as SymptomKind,
        onsetMs: now - 300_000, actionKind: null, confounded: false, beforeFreshN: 4, confirming: true }]) },
    visibleNodes: nodes, filtering: false, actionsEnabled: true };
  const joined = plain(renderRemedy(ctxP));
  assert.match(joined, /partial detector coverage/, 'precondition: this is the partial branch');
  assert.match(joined, /still scoring 1 episode/,
    `partial coverage must still disclose open episodes: ${joined.slice(0, 900)}`);
  assert.match(joined, /1 in the confirmation window/);
});

test('every empty state holds the row contract at all sizes (v0.46.0)', () => {
  const states = [
    { ...ENG, total: 3, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 },  // zero coverage
    { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 1 },  // partial
    { ...ENG, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 3, rttCeiling: 0, rssiReady: 3 },  // full
    { enabled: true as const, ready: 0, total: 0, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0, band: 2, bands: 6 },
  ];
  for (const eng of states) {
    for (const [cols, rows] of [[40, 12], [56, 20], [80, 24], [120, 40], [200, 50]] as const) {
      const lines = renderRemedy(engCtx(cols, rows, eng));
      assert.equal(lines.length, rows, `${cols}x${rows}: exactly ${rows} rows`);
      for (const l of lines) assert.ok(plain([l]).length <= cols, `${cols}x${rows}: width`);
    }
  }
});

/* ── v0.47.0: why a card has no score ─────────────────────────────────────── */

test('an UNPROBEABLE node says its evidence can never be filled (v0.47.0)', () => {
  // Its episodes close `unverifiable` by construction — the sweep skips
  // sleeping devices entirely — so "no measurement yet" and "no measurement is
  // possible" rendered identically. Only the second is permanent.
  const ctxU: ScreenCtx = { view: mkView(200, 40),
    data: { ...data([sym({ kind: 'node-down', nodeId: 6 })]), probeable: () => false },
    visibleNodes: nodes, filtering: false, actionsEnabled: true };
  const joined = plain(renderRemedy(ctxU));
  assert.match(joined, /cannot be probed \(sleeping\/FLiRS\)/);
  assert.match(joined, /can never be filled/, 'permanence is the point');
});

test('a node with probes OWED says the score is pending, not absent (v0.47.0)', () => {
  const ctxO: ScreenCtx = { view: mkView(200, 40),
    data: { ...data([sym()]), probeable: () => true, verifyOwedFor: () => 3, autoPingState: () => ({ suppressed: 'none', nodes: [] }) as never },
    visibleNodes: nodes, filtering: false, actionsEnabled: true };
  const joined = plain(renderRemedy(ctxO));
  assert.match(joined, /3 verification probes still owed — the score is pending, not absent/);
});

test('a probeable node with nothing owed says NOTHING extra (v0.47.0)', () => {
  const ctxQ: ScreenCtx = { view: mkView(200, 40),
    data: { ...data([sym()]), probeable: () => true, verifyOwedFor: () => 0 },
    visibleNodes: nodes, filtering: false, actionsEnabled: true };
  const joined = plain(renderRemedy(ctxQ));
  assert.doesNotMatch(joined, /cannot be probed|still owed/, 'no news is no line');
});

test('a provider that predates probeability claims nothing about it (v0.47.0)', () => {
  // `null` is UNKNOWN, not false. Rendering "cannot be probed" for a provider
  // that simply does not implement the accessor would explain a missing score
  // with a fact nobody established.
  const joined = plain(renderRemedy(ctx(200, 40, [sym({ kind: 'node-down', nodeId: 6 })])));
  assert.doesNotMatch(joined, /cannot be probed/);
});

test('a candidate\'s [cost · basis] tag is whole or shed, never a half bracket (v0.51.0)', () => {
  // shedLine's HEAD has no whole-token path — an over-wide head is handed to a
  // blind truncate — so at the modal 80 columns the longest candidate ended
  // `[physical`, silently dropping ` · lore]`. That is the difference between
  // "we measured this" and "this is folklore", lost with no disclosure, and an
  // unbalanced bracket on top.
  for (const cols of [40, 56, 80, 100, 120, 200]) {
    const lines = renderRemedy(ctx(cols, 24, [sym({ kind: 'dead-flap' })]))
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    for (const l of lines) {
      const opens = (l.match(/\[/g) ?? []).length;
      const closes = (l.match(/\]/g) ?? []).length;
      assert.equal(opens, closes,
        `${cols} cols: a candidate row must never carry a half-open tag: "${l}"`);
    }
  }
});

test('the REMEDY title rule never contradicts the empty state its own body rendered (v0.52.0)', () => {
  // The rule read `all clear` in ALL FIVE no-symptom states — including
  // `● Engine disabled.` and the PERMANENT partial-coverage state whose own
  // body says, in as many words, "a statement about COVERAGE, not health".
  // The one word an operator scans first contradicted the paragraph two rows
  // below that exists to stop them reading it that way. Confirmed live on the
  // 39-node mesh at v0.51.0: `── REMEDY ──… all clear` over
  // `◑ No symptoms — partial detector coverage for the 16:00-20:00 band`.
  const E = (over: Partial<ReturnType<DataProvider['engineStatus']>>) =>
    ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 3, rttCeiling: 0, rssiReady: 3, band: 0, bands: 6, ...over });
  const CASES: Array<[string, ReturnType<DataProvider['engineStatus']>, RegExp, RegExp]> = [
    ['engine off',  E({ enabled: false }),                              /engine off/,      /Engine disabled/],
    ['no roster',   E({ total: 0, ready: 0, timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 }), /no roster/, /No nodes yet/],
    ['learning',    E({ timeoutReady: 0, timeoutWindowBlind: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 }),  /learning/,        /Learning/],
    ['partial',     E({ timeoutReady: 3, timeoutWindowBlind: 0, rttReady: 1, rttCeiling: 0, rssiReady: 1 }),  /partial coverage/, /partial detector coverage/],
    ['all clear',   E({}),                                              /all clear/,       /All clear/],
  ];
  for (const [label, eng, titleRe, bodyRe] of CASES) {
    const lines = renderRemedy(engCtx(120, 30, eng)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const rule = lines.find((l) => /REMEDY/.test(l)) ?? '';
    const joined = lines.join('\n');
    assert.match(rule, titleRe, `${label}: the rule must name THIS state, not inherit one: "${rule}"`);
    assert.match(joined, bodyRe, `${label}: fixture must actually reach the intended branch`);
    // The specific contradiction that motivated this: a green verdict in the
    // rule above a body that says coverage is incomplete.
    if (label !== 'all clear') {
      assert.doesNotMatch(rule, /all clear/i, `${label}: must NOT claim all clear: "${rule}"`);
    }
  }
});

test('a blocked efficacy note keeps its qualifier at the supported width FLOOR (v0.55.0)', () => {
  // session.ts clamps the terminal to [60,200], and a narrow HA ingress sidebar
  // sits at the bottom of that. The no-harm ladder fell through to a bare head,
  // so at 60-66 columns the row rendered `⚠ ledger measured 100% here` alone —
  // a measurement under a SAFETY-gated action with nothing saying the action is
  // BLOCKED. That is the endorsement-shaped reading this note exists to prevent.
  // route-churn's ONLY executable candidate is hardcoded blocked — the fixture
  // the existing blocked-note tests use.
  const eff: Eff = { expectedEfficacy: 1.0, n: 10, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null, minN: 4, baseN: 0, baseNodes: 0, harmed: 0, baseHarmed: 0 };
  let rendered = 0;
  for (const cols of [60, 62, 64, 66, 70, 80, 120, 160]) {
    const lines = renderRemedy(ctx(cols, 30, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff))
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const row = lines.find((l) => /ledger measured/.test(l));
    if (!row) continue;
    rendered += 1;
    // The WORDING may shorten — the CLAIM may not. Whichever rung fits, the row
    // must still say the action is blocked, and must say it in a whole clause.
    assert.match(row, /still blocked|blocked$|block above still applies/,
      `${cols}: a blocked measurement must never render without its qualifier: "${row.trim()}"`);
    assert.doesNotMatch(row, /above still$|applie$|block abov$/,
      `${cols}: and the qualifier must not itself be clipped: "${row.trim()}"`);
  }
  // Without this the loop could `continue` at every width and prove nothing —
  // the exact way an earlier test in this repo passed for the wrong reason.
  assert.ok(rendered >= 3, `the note must actually render somewhere: rendered at ${rendered} widths`);
});

test('the open-episode disclosure keeps its ENGINE pointer at every width (v0.55.0)', () => {
  // Built at 120 columns and never rendered at the modal 80, where the single
  // form came back as `...— se`: a sentence stopping mid-word with the pointer
  // to the screen that holds the episodes gone.
  for (const cols of [60, 72, 80, 100, 120, 200]) {
    const cx = ctx(cols, 30, []);
    (cx.data as { openEpisodes?: () => unknown[] }).openEpisodes = () => ([
      { key: '7:rtt-degraded', nodeId: 7, kind: 'rtt-degraded', onsetMs: now - 300_000, actionKind: null, confounded: false, beforeFreshN: 4, confirming: true },
      { key: '9:rate-fallback', nodeId: 9, kind: 'rate-fallback', onsetMs: now - 60_000, actionKind: null, confounded: false, beforeFreshN: 2, confirming: false },
    ]);
    const lines = renderRemedy(cx).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const row = lines.find((l) => /scoring|open,/.test(l) && /episode|confirming/.test(l));
    assert.ok(row, `${cols}: the disclosure must render`);
    assert.match(row, /ENGINE/,
      `${cols}: the pointer is the actionable half — it must survive: "${row.trim()}"`);
    assert.doesNotMatch(row, /— se$|windo$/, `${cols}: no mid-word cut: "${row.trim()}"`);
  }
});

/* ── v0.79.9: class-F re-check — what REMEDY says it measured ─────────── */

/** A ladder entry for one node; every field the runner reports. */
const apNode = (o: Partial<AutoPingNodeState>): AutoPingNodeState => ({
  nodeId: 6, deadSinceMs: null, attempts: 0, nextEligibleMs: null, missStreak: 0, launchFailures: 0, pending: 0,
  gaveUp: false, launchGaveUp: false, talkingWhileDead: false, reads: 0, readOwed: false, readRevivals24h: 0,
  probeKills24h: 0, probeHeldUntilMs: null, ...o,
});
/** A running auto-ping's snapshot — non-null is what "a runner exists" means. */
const apSnap = (nodes: AutoPingNodeState[] = [], suppressed: AutoPingSnapshot['suppressed'] = 'none'): AutoPingSnapshot => ({
  lastTickMs: now - 30_000, suppressed, listening: 2, deadListening: 0, capabilityUnknown: 0,
  staleDue: 1, stalestMs: 3_600_000, verifyOwed: 0,
  config: { enabled: true, writeActions: true, afterMs: 10 * 60_000, maxAttempts: 3, staleMs: 120 * 60_000 },
  nodes,
});
const ctxWith = (cols: number, rows: number, syms: Symptom[], over: Partial<DataProvider> = {}): ScreenCtx =>
  ({ view: mkView(cols, rows), data: { ...data(syms), ...over }, visibleNodes: nodes, filtering: false, actionsEnabled: true });
const fits = (lines: string[], cols: number, label: string): void =>
  lines.forEach((l, i) => assert.ok(visLen(l) <= cols, `${label} row ${i}: width ${visLen(l)} > ${cols}`));

test('with no auto-ping runner a card says no verification probe is sent, never that its score is pending (v0.79.9)', () => {
  // Only the runner drains the verification queue, and index.ts starts it only
  // with auto-ping AND write actions on. "Pending" promised probes nothing sends.
  // Each kind's evidence floor counts readings of its own signal from any
  // traffic, not only probe replies, so an episode of a kind with a recovery
  // metric can still be scored.
  const owed = (cols: number, s: Symptom, over: Partial<DataProvider> = {}): string[] =>
    renderRemedy(ctxWith(cols, 40, [s], { probeable: () => true, verifyOwedFor: () => 3, ...over }));
  const j = plain(owed(200, sym()));
  assert.match(j, /○ auto-ping is off — no verification probes are sent; any score must come from the node’s other traffic/);
  assert.doesNotMatch(j, /score is pending/, 'no runner: nothing will pay the debt');
  // Control: with a runner the owed line is the true one, unchanged.
  const run = plain(owed(200, sym(), { autoPingState: () => apSnap() }));
  assert.match(run, /3 verification probes still owed — the score is pending, not absent/);
  assert.doesNotMatch(run, /auto-ping is off/);
  // A kind the ledger never scores keeps its own reason, and is not blamed on auto-ping.
  const down = plain(owed(200, sym({ kind: 'node-down', severity: 'crit' })));
  assert.match(down, /not measured by the ledger/);
  assert.doesNotMatch(down, /auto-ping is off/);
  // Whole at every width: one of its three forms, never a cut sentence.
  const forms = [
    '○ auto-ping is off — no verification probes are sent; any score must come from the node’s other traffic',
    '○ auto-ping off — any score must come from other traffic',
    '○ auto-ping off: no verify probes',
  ];
  for (const cols of [40, 60, 80, 120]) {
    const lines = owed(cols, sym());
    fits(lines, cols, `${cols}`);
    const row = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => l.includes('○ auto-ping')) ?? '';
    assert.ok(forms.includes(row.trim()), `${cols}: "${row}" is a whole form`);
  }
});

test('with no auto-ping runner only a card of a kind with a recovery metric says auto-ping is off (v0.79.9)', () => {
  // ghost-suspect, chatty-device and edge-cluster have metric 'none': no
  // traffic scores their recovery, so "any score must come from the node's
  // other traffic" was false on every such card of the default install. No
  // runner books no debt, so verifyOwedFor is 0 here.
  const card = (s: Symptom): string =>
    plain(renderRemedy(ctxWith(200, 40, [s], { probeable: () => true, verifyOwedFor: () => 0 })));
  for (const kind of ['ghost-suspect', 'chatty-device', 'edge-cluster'] as const) {
    const j = card(sym({ kind, nodeId: 6 }));
    assert.match(j, new RegExp(kind), `fixture guard: the ${kind} card rendered`);
    assert.doesNotMatch(j, /auto-ping is off|auto-ping off/, `${kind}: no recovery metric, no claim a score can come`);
    assert.doesNotMatch(j, /score is pending/, `${kind}`);
  }
  // Control: a kind with a recovery metric still says it, with no debt booked.
  assert.match(card(sym({ kind: 'return-path-degraded' })),
    /○ auto-ping is off — no verification probes are sent; any score must come from the node’s other traffic/);
});

test('with no runner the summary line sheds its advisory tail whole, never cut mid-claim (v0.79.9)', () => {
  // Cut blind, one warning's row read "the engine only recommends; you run the acti" at 60 columns.
  const summary = (lines: string[]): string =>
    lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => /critical|warning/.test(l)) ?? '';
  const one = [sym()];
  const three = [sym({ kind: 'node-down', severity: 'crit' }), sym({ nodeId: 7 }), sym({ nodeId: 7, kind: 'route-churn', severity: 'watch' })];
  assert.match(summary(renderRemedy(ctxWith(60, 30, one))), /^ {2}1 warning {2}— {2}the engine only recommends$/);
  assert.match(summary(renderRemedy(ctxWith(80, 30, three))), /^ {2}1 critical · 1 warning · 1 watch {2}— {2}the engine only recommends$/);
  assert.match(summary(renderRemedy(ctxWith(40, 30, one))), /^ {2}1 warning$/, 'no room for the claim: the whole tail goes');
  assert.match(summary(renderRemedy(ctxWith(120, 30, three))), /1 watch {2}— {2}the engine only recommends; you run the actions$/);
  for (const cols of [40, 60, 80, 120]) {
    for (const syms of [one, three]) {
      const lines = renderRemedy(ctxWith(cols, 30, syms));
      fits(lines, cols, `${cols}`);
      const l = summary(lines);
      assert.ok(/(?:warning|watch|critical)(?: {2}— {2}the engine only recommends(?:; you run the actions)?)?$/.test(l), `${cols}: whole or absent: "${l}"`);
    }
  }
});

test('with a runner the summary line says the engine can also write on its own, paused too, never that it only recommends (v0.79.9)', () => {
  // Auto-ping's ladder and sweep, and the refresh trial, write with no keypress.
  // A capability, so it is as true while paused as while running.
  const down = sym({ kind: 'node-down', severity: 'crit' });
  const summary = (lines: string[]): string =>
    lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => /critical/.test(l)) ?? '';
  // Control: no runner, the anchored advisory line, byte for byte.
  assert.match(summary(renderRemedy(ctxWith(120, 30, [down]))), /1 critical {2}— {2}the engine only recommends; you run the actions$/);
  for (const ap of [apSnap(), apSnap([], 'paused')]) {
    const line = summary(renderRemedy(ctxWith(100, 24, [down], { autoPingState: () => ap })));
    assert.match(line, /1 critical {2}— {2}the engine can also write on its own; see ENGINE$/, `${ap.suppressed}: ${line}`);
    assert.doesNotMatch(line, /only recommends/);
  }
  // At the modal 80 columns with all three severities the tail sheds its
  // pointer whole; narrower, the whole tail goes, never half of it.
  const three = [down, sym({ nodeId: 7 }), sym({ nodeId: 7, kind: 'route-churn', severity: 'watch' })];
  const at80 = summary(renderRemedy(ctxWith(80, 30, three, { autoPingState: () => apSnap() })));
  assert.match(at80, /1 critical · 1 warning · 1 watch {2}— {2}the engine can also write on its own$/);
  for (const cols of [40, 60]) {
    for (const syms of [[down], three]) {
      const lines = renderRemedy(ctxWith(cols, 30, syms, { autoPingState: () => apSnap() }));
      fits(lines, cols, `${cols}`);
      const l = summary(lines);
      assert.ok(/the engine can also write on its own$/.test(l) || !/engine/.test(l), `${cols}: whole or absent: "${l}"`);
    }
  }
});

test('the all-clear claims what its branch checked: no symptom firing, thin timeout windows counted, and no "nothing is acted on" under a runner (v0.79.9)', () => {
  // The branch tests `symptoms.length === 0`. "None is currently anomalous" was
  // a judgment no detector made on a node whose 10-minute window held fewer
  // than MIN_WINDOW_TX sends: both return-path detectors skip it.
  const blind = plain(renderRemedy(engCtx(80, 30, { ...ENG, timeoutWindowBlind: 2 })));
  assert.match(blind, /✓ All clear — 3 nodes learned, no symptoms detected\./, 'fixture guard: the green branch');
  assert.doesNotMatch(blind, /anomalous/);
  assert.match(blind, /for the 12:00–16:00 band, and no symptom is firing\./);
  assert.match(blind, /\(2 of 3: too little traffic in 10 min to rate timeouts\.\)/, 'a count, no verdict word');
  assert.doesNotMatch(blind, /not clear/);
  // Control: no thin window, no note.
  assert.doesNotMatch(plain(renderRemedy(engCtx(80, 30, ENG))), /too little traffic|too quiet/);
  // Under a runner "nothing is acted on" is false; without one it stays.
  const clear = (cols: number, over: Partial<DataProvider>): string[] =>
    renderRemedy({ view: mkView(cols, 30), data: { ...data([]), engineStatus: () => ENG, ...over }, visibleNodes: nodes, filtering: false, actionsEnabled: true });
  const ran = plain(clear(80, { autoPingState: () => apSnap() }));
  assert.doesNotMatch(ran, /nothing is acted on/);
  assert.match(ran, /New symptoms surface here; the engine can also write on its own \(ENGINE\)\./);
  assert.match(plain(clear(80, {})), /New symptoms will surface here — advisory-first, nothing is acted on\./, 'control: no runner');
  // Every new row is one of its whole forms at every width, 38 thin of 38.
  const eng38 = { ...ENG, total: 38, timeoutReady: 38, rttReady: 38, rssiReady: 38, timeoutWindowBlind: 38 };
  for (const cols of [40, 60, 80, 120]) {
    const lines = clear(cols, { engineStatus: () => eng38, autoPingState: () => apSnap() });
    fits(lines, cols, `${cols}`);
    const txt = plain(lines);
    assert.doesNotMatch(txt, /…/, `${cols}: nothing clipped mid-claim`);
    assert.match(txt, /\(38(?: of |\/)38:? too (?:little traffic in 10 min|quiet in 10 min|quiet) to rate timeouts\.\)/, `${cols}`);
    assert.match(txt, /(?:the )?engine can (?:also )?write on its own/i, `${cols}`);
  }
});

test('a node-down card whose ladder gave up says what the ladder did, in the HA summons words (v0.79.9)', () => {
  // "A ping often revives it" is true before the ladder runs and false once it
  // has spent its attempts. The recommendation sensor already swaps it.
  const down = sym({ kind: 'node-down', severity: 'crit', nodeId: 6 });
  const card = (cols: number, ap: AutoPingSnapshot | null): string[] =>
    renderRemedy(ctxWith(cols, 30, [down], { autoPingState: () => ap })).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  // What sensor.zwave_tui_recommendation publishes for the same input.
  const sensor = (ap: AutoPingSnapshot): string => String(buildRecommendation({
    symptoms: [down], nodeOf: (id) => nodes.find((n) => n.nodeId === id), writeActions: true, ap, startedAt: now - 86_400_000, now,
  }).attrs.headline);
  const gave = apNode({ deadSinceMs: now - 90 * 60_000, attempts: 3, gaveUp: true });
  const g = card(80, apSnap([gave]));
  assert.ok(g.some((l) => l.includes('▎ ' + sensor(apSnap([gave])))), 'the summons headline, verbatim');
  assert.ok(g.some((l) => /▎ Node is DOWN — auto-ping gave up after 3 unanswered attempts$/.test(l)));
  assert.ok(!g.some((l) => /a ping often revives it/.test(l)));
  const sent = apNode({ deadSinceMs: now - 90 * 60_000, attempts: 0, launchGaveUp: true });
  assert.ok(card(120, apSnap([sent])).some((l) => l.includes('▎ ' + sensor(apSnap([sent])))), 'a ladder that could not send says so');
  // Launches that ran out after a ping went unanswered: that ping did test the
  // node, so the card, like the sensor, says how many, never "not tested".
  const after = apNode({ deadSinceMs: now - 90 * 60_000, attempts: 1, launchGaveUp: true });
  const a = card(120, apSnap([after]));
  assert.ok(a.some((l) => l.includes('▎ ' + sensor(apSnap([after])))), 'the summons headline, verbatim');
  assert.ok(a.some((l) => /▎ Node is DOWN — auto-ping could not send its pings after 1 unanswered attempt$/.test(l)));
  assert.doesNotMatch(a.join('\n'), /not tested/);
  // Narrower, one whole form of the same claim: never a clipped one.
  const one = apNode({ deadSinceMs: now - 90 * 60_000, attempts: 1, gaveUp: true });
  const forms: Array<[AutoPingNodeState, Record<number, string>]> = [
    [sent, { 40: 'DOWN — auto-ping pings not sent', 60: 'Node is DOWN — auto-ping could not send its pings',
      80: 'Node is DOWN — auto-ping could not send its pings; node not tested' }],
    [after, { 40: 'DOWN — 1 unanswered, then unsent', 60: 'Node is DOWN — 1 unanswered, then pings not sent',
      80: 'Node is DOWN — auto-ping could not send its pings; 1 went unanswered' }],
    [gave, { 40: 'DOWN — auto-ping gave up (3 tries)', 60: 'Node is DOWN — auto-ping gave up after 3 attempts',
      80: 'Node is DOWN — auto-ping gave up after 3 unanswered attempts' }],
    [one, { 40: 'DOWN — auto-ping gave up (1 try)', 60: 'Node is DOWN — auto-ping gave up after 1 attempt',
      80: 'Node is DOWN — auto-ping gave up after 1 unanswered attempt' }],
  ];
  for (const [ap, at] of forms) {
    for (const cols of [40, 60, 80]) {
      const lines = renderRemedy(ctxWith(cols, 30, [down], { autoPingState: () => apSnap([ap]) }));
      fits(lines, cols, `${cols}`);
      const row = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).find((l) => /▎ (?:Node is )?DOWN — (?:auto-ping|\d+ unanswered)/.test(l)) ?? '';
      assert.equal(row.slice(row.indexOf('▎ ') + 2), at[cols], `${cols} attempts=${ap.attempts}${ap.gaveUp ? ' gave up' : ''}: "${row}"`);
    }
  }
  // Once a ping went unanswered, no width says that none left, with a count
  // too wide for the short forms included.
  for (const attempts of [1, 2, 12]) {
    const ap = apNode({ deadSinceMs: now - 90 * 60_000, attempts, launchGaveUp: true });
    for (const cols of [40, 60, 80, 120]) {
      const lines = renderRemedy(ctxWith(cols, 30, [down], { autoPingState: () => apSnap([ap]) }));
      fits(lines, cols, `${cols} attempts=${attempts}`);
      const text = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
      assert.doesNotMatch(text, /DOWN — auto-ping pings not sent|could not send its pings$|not tested/m, `${cols} attempts=${attempts}`);
      assert.match(text, new RegExp(`${attempts} (?:went )?unanswered`), `${cols} attempts=${attempts}: the count`);
    }
  }
  // Controls: a ladder still working, no runner, and another node's give-up.
  for (const ap of [apSnap([apNode({ deadSinceMs: now - 20 * 60_000, attempts: 1 })]), null, apSnap([apNode({ nodeId: 7, attempts: 3, gaveUp: true })])]) {
    assert.ok(card(80, ap).some((l) => /▎ Node is DOWN — the driver proved it, a ping often revives it/.test(l)), JSON.stringify(ap?.nodes ?? null));
  }
});

test('with no runner the all-clear ends on one whole form at every width, never cut blind (v0.79.9)', () => {
  // Pushed unfitted, the frame cut it to "— adv" at 40 columns and to
  // "nothing" at 60, as it cut the summary's tail to "you run the acti".
  const at: Record<number, string> = {
    40: '    Advisory-first: nothing is acted on.',
    60: '    New symptoms surface here; nothing is acted on.',
    80: '    New symptoms will surface here — advisory-first, nothing is acted on.',
    120: '    New symptoms will surface here — advisory-first, nothing is acted on.',
  };
  for (const cols of [40, 60, 80, 120]) {
    const lines = renderRemedy({ view: mkView(cols, 30), data: { ...data([]), engineStatus: () => ENG }, visibleNodes: nodes, filtering: false, actionsEnabled: true });
    fits(lines, cols, `${cols}`);
    const txt = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(txt.some((l) => /✓ All clear/.test(l)), `${cols}: fixture guard: the green branch`);
    const row = txt.find((l) => /nothing is acted on/.test(l)) ?? '';
    assert.equal(row, at[cols], `${cols}: "${row}"`);
  }
});

test('the quiet-node card grounds itself on what the detector checked, not on traffic never attempted (v0.79.9)', () => {
  // With the sweep on every mains node is asked once a cadence, and quiet-node
  // fires only after three cadences: traffic WAS attempted, and the ladder may
  // already count misses. The detector's own test is `status !== Dead`.
  const q = sym({ kind: 'quiet-node', nodeId: 6, evidence: [{ label: 'last heard', value: '8.1h ago' }] });
  for (const cols of [80, 200]) {
    const lines = renderRemedy(ctxWith(cols, 40, [q], { autoPingState: () => apSnap([apNode({ missStreak: 2 })]) }))
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.doesNotMatch(lines.join('\n'), /no traffic was attempted/);
    const row = lines.find((l) => /hasn’t communicated/.test(l)) ?? '';
    assert.match(row, /The node hasn’t communicated in a while, yet it is not marked Dead/, `${cols}: "${row}"`);
  }
});

/* ── v0.80.0: what the engine knows, whole at 80 columns ─────────────────── */

const PARTIAL = { enabled: true as const, ready: 33, total: 39, timeoutReady: 33, timeoutWindowBlind: 0, rttReady: 23, rttCeiling: 9, rssiReady: 30, band: 3, bands: 6 };

test('partial coverage counts the nodes too quiet to rate timeouts, beside the timeout count (v0.80.0)', () => {
  // `timeouts 33/39` read as 33 nodes judged while the two return-path
  // detectors skip every node whose 10-minute window holds under 20 sends —
  // and the output was byte-identical for timeoutWindowBlind 0 and 39.
  const quiet = plain(renderRemedy(engCtx(80, 24, { ...PARTIAL, timeoutWindowBlind: 38 })));
  assert.match(quiet, /timeouts 33\/39\s+unmeasured 38\s+rtt 23\/39/, `the token follows the series it qualifies: ${quiet}`);
  assert.match(quiet, /timeout: 38 too quiet in 10 min to rate — return-path detectors skip them\./, quiet);
  assert.match(plain(renderRemedy(engCtx(120, 24, { ...PARTIAL, timeoutWindowBlind: 38 }))), /— the return-path detectors skip them\./);
  const none = plain(renderRemedy(engCtx(80, 24, PARTIAL)));
  assert.doesNotMatch(none, /unmeasured|too quiet/, 'no thin window ⇒ neither the token nor the line');
  assert.notEqual(quiet, none, 'the screen changes with timeoutWindowBlind');
});

test('a below-readiness arm with NO measured control arm still speaks — its harm warning included (v0.80.0)', () => {
  // `if (heal == null) return null` ran before the n check and the harm
  // warning: n≈2.9 with every attempt worse rendered the same silence as n=0.
  const harmed = (): Eff => ({ expectedEfficacy: null, n: 2.9, baseRate: null, nodes: 2, ready: false,
    lowerBound: null, bar: null, minN: 4, baseN: 1, baseNodes: 1, harmed: 2.9, baseHarmed: 0 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], harmed)));
  assert.match(joined, /still learning this action \(n≈2\.9 of 4\) — self-heal not yet measured — ⚠ every attempt so far made it WORSE/, joined);
  // At 80 the clauses go before the warning does: it keeps its place beside the readiness fraction.
  assert.match(plain(renderRemedy(ctx(80, 40, [sym()], harmed))), /still learning this action \(n≈2\.9 of 4\) — ⚠ every try made it WORSE\n/);
  // The measured-control branch sheds the same way.
  const withBase = (): Eff => ({ ...harmed()!, baseRate: 0.6, baseN: 6, baseNodes: 3 });
  assert.match(plain(renderRemedy(ctx(80, 40, [sym()], withBase))), /still learning this action \(n≈2\.9 of 4\) — ⚠ every try made it WORSE\n/);
  // At 60, the session's minimum, neither branch falls back to the bare
  // fraction: the warning outlasts it. At 40 the warning stands alone after `≈`.
  const note = (W: number, e: () => Eff): string =>
    plain(renderRemedy(ctx(W, 40, [sym()], e))).split('\n').find((l) => /^ {8}≈ /.test(l)) ?? '';
  for (const e of [harmed, withBase]) {
    assert.match(note(60, e), /WORSE|made it worse/, `60: "${note(60, e)}"`);
    assert.equal(note(60, e), '        ≈ still learning — ⚠ every try made it WORSE');
    assert.equal(note(40, e), '        ≈ ⚠ every try made it WORSE');
  }
  // A partial harm sheds the same way: its count stays with the warning.
  const some = (): Eff => ({ ...harmed()!, harmed: 1.5 });
  const someBase = (): Eff => ({ ...withBase()!, harmed: 1.5 });
  for (const e of [some, someBase]) {
    assert.equal(note(60, e), '        ≈ still learning — ⚠ n≈1.5 made it worse');
    assert.equal(note(40, e), '        ≈ ⚠ n≈1.5 made it worse');
  }
  // Control: with no harm the 60-column note is the readiness fraction, unchanged,
  // and at 40 the bare `≈ still learning` — no warning rung without a warning.
  const clean = (): Eff => ({ ...withBase()!, harmed: 0 });
  assert.equal(note(60, clean), '        ≈ still learning this action (n≈2.9 of 4)');
  assert.equal(note(40, clean), '        ≈ still learning');
  assert.equal(note(40, (): Eff => ({ ...harmed()!, harmed: 0 })), '        ≈ still learning');
  // Control: no attempts and no base rate is still no note.
  const never = (): Eff => ({ ...harmed()!, n: 0, harmed: 0, nodes: 0 });
  assert.doesNotMatch(plain(renderRemedy(ctx(120, 40, [sym()], never))), /≈ still learning|never tried/);
});

test('REMEDY tally lines end on whole words at 80x24, and the plan still renders under five of them (v0.80.0)', () => {
  // Each was one sentence and a blind truncate: `weigh the evidence a`,
  // `too few readings to ju`, `probe re-`.
  const d: DataProvider = { ...data([sym({ kind: 'rtt-degraded', evidence: [{ label: 'RTT', value: '412ms' }] })]),
    falsePositives: () => 2, unverifiableCount: () => 3, unverifiableUnprobeableCount: () => 1,
    unverifiableTransientCount: () => 4, unverifiableUndersampledCount: () => 5, confoundedCount: () => 6 };
  const lines = renderRemedy({ view: mkView(80, 24), data: d, visibleNodes: nodes, filtering: false, actionsEnabled: true })
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const tallies = lines.filter((l) => /^ {4}(⚠ |○ \d)/.test(l));
  assert.equal(tallies.length, 6, `all six tallies render: ${JSON.stringify(tallies)}`);
  const ends = [/acting$|evidence$|misdiagnosis 2×$/, /recovery$|readings$|unscoreable$/, /not a gap$|by design$/,
    /not a gap$|floor filled$|by design$|blinks$/, /readings$|reporting rate$|too rarely$|undersampled$/, /episode\)$|re-route\)$|neither arm$|confounded$/];
  tallies.forEach((t, i) => assert.match(t.trimEnd(), ends[i], `tally ${i} must end on a whole clause: "${t}"`));
  assert.ok(lines.some((l) => /▎ /.test(l)), 'the plan headline still renders');
  assert.ok(lines.some((l) => /^ {6}[▸·] /.test(l)), 'and at least one candidate');
});

test('every empty state, its ceiling note and the all-clear headline are whole at 40 and 60 columns (v0.80.0)', () => {
  // `Every node has a graduated timeout a` at 40: the first of two hard-wrapped
  // lines was cut blind, and the rssi note likewise. The disabled and no-nodes
  // paragraphs were cut at 60, the session's minimum, the ceiling note's second
  // line ended `slowdown is …`, and the ✓ headline stopped mid-word at 40.
  const words = (W: number, eng: ReturnType<DataProvider['engineStatus']>): { lines: string[]; text: string } => {
    const lines = renderRemedy(engCtx(W, 30, eng)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    fits(lines, W, `${W}`);
    for (const l of lines) assert.doesNotMatch(l, / …$/, `${W}: no paragraph line is clipped: "${l}"`);
    return { lines, text: lines.slice(3, -1).map((l) => l.trim()).filter(Boolean).join(' ') };
  };
  const OFF = { ...ENG, enabled: false, total: 0, ready: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0 };
  const NONE = { ...ENG, total: 0, ready: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0 };
  const LEARN = { ...ENG, total: 39, ready: 0, timeoutReady: 0, rttReady: 0, rttCeiling: 9, rssiReady: 0 };
  const CEILING = /rtt: 9 with no learned normal are held to a fixed 300 ms ceiling meanwhile, so only a severe slowdown is flagged there\./;
  for (const W of [40, 60]) {
    const clear = words(W, { ...ENG, rssiReady: 1 });
    assert.match(clear.text, /Every node has a graduated timeout and rtt baseline — the two that arm a detector —/, `${W}: ${clear.text}`);
    assert.match(clear.text, /\(rssi (is )?short on 2[:—]/, `${W}: the rssi note is a whole form: ${clear.text}`);
    for (const l of clear.lines) assert.doesNotMatch(l, /graduated timeout a$|rtt bas$|— th$/, `${W}: no line ends mid-word: "${l}"`);
    assert.match(words(W, OFF).text, /The symptom engine is not running on this install \(no baselines store configured\), so nothing is being diagnosed\./, `${W}: disabled`);
    assert.match(words(W, NONE).text, /The engine is running but the roster is empty — nothing has been measured, so nothing can be diagnosed or cleared\. This is normal for the first seconds after a restart\./, `${W}: no nodes`);
    assert.match(words(W, LEARN).text, CEILING, `${W}: learning`);
    assert.match(words(W, PARTIAL).text, CEILING, `${W}: partial`);
  }
  // The ✓ headline: its own words where they fit, then shorter whole forms.
  const head = (W: number, total: number): string => words(W, { ...ENG, total, ready: total, timeoutReady: total, rttReady: total, rssiReady: total })
    .lines.find((l) => /✓ All clear/.test(l)) ?? '';
  assert.equal(head(60, 39), '    ✓ All clear — 39 nodes learned, no symptoms detected.');
  assert.equal(head(50, 39), '    ✓ All clear — 39 learned, no symptoms.');
  assert.equal(head(40, 39), '    ✓ All clear — no symptoms.');
  // At 80 the familiar lines are unchanged.
  const wide = plain(renderRemedy(engCtx(80, 30, ENG)));
  assert.match(wide, /\n {4}✓ All clear — 3 nodes learned, no symptoms detected\.\n/);
  assert.match(wide, /\n {4}Every node has a graduated timeout and rtt baseline — the two\n {4}that arm a detector —\n/);
  assert.match(plain(renderRemedy(engCtx(80, 30, OFF))), /\n {4}The symptom engine is not running on this install \(no baselines\n {4}store configured\), so nothing is being diagnosed\.\n/);
  assert.match(plain(renderRemedy(engCtx(80, 30, LEARN))), /\n {4}rtt: 9 with no learned normal are held to a fixed 300 ms\n {4}ceiling meanwhile, so only a severe slowdown is flagged there\.\n/);
});

test('the learning state says what its `unmeasured N` means, on a line of its own (v0.80.0)', () => {
  // The counts strip carried `unmeasured 38` in the learning state too, and
  // only the partial state had the line explaining it.
  const LEARN = { ...ENG, total: 39, ready: 0, timeoutReady: 0, rttReady: 0, rttCeiling: 0, rssiReady: 0 };
  const quiet = plain(renderRemedy(engCtx(80, 24, { ...LEARN, timeoutWindowBlind: 38 })));
  assert.match(quiet, /◷ Learning/, 'fixture guard: the learning branch');
  assert.match(quiet, /timeouts 0\/39\s+unmeasured 38/, quiet);
  assert.match(quiet, /\n {4}timeout: 38 too quiet in 10 min to rate — return-path detectors skip them\.\n/, quiet);
  assert.match(plain(renderRemedy(engCtx(120, 24, { ...LEARN, timeoutWindowBlind: 38 }))), /— the return-path detectors skip them\./);
  // It follows the paragraph, and comes before the ceiling note.
  const both = plain(renderRemedy(engCtx(80, 24, { ...LEARN, timeoutWindowBlind: 38, rttCeiling: 9 }))).split('\n');
  const para = both.findIndex((l) => /Nothing here is a health claim yet/.test(l));
  const line = both.findIndex((l) => /too quiet in 10 min to rate/.test(l));
  const ceil = both.findIndex((l) => /^ {4}rtt: 9 with no learned normal/.test(l));
  assert.ok(para >= 0 && line === para + 1 && ceil === line + 1, `order: ${para}, ${line}, ${ceil}`);
  // Control: no thin window, neither the token nor the line.
  assert.doesNotMatch(plain(renderRemedy(engCtx(80, 24, LEARN))), /unmeasured|too quiet/);
});

test('the evidence row sheds whole measurements, never one cut mid-value (v0.80.0)', () => {
  const rtt = sym({ kind: 'rtt-degraded', evidence: [
    { label: 'RTT', value: '412ms' },
    { label: 'baseline', value: '38±6ms · capped at 300ms' },
    { label: 'restart allowance', value: '41ms (212 tx since driver start)' },
    { label: 'newest round trips', value: '380, 402, 455ms' },
  ] });
  const weak = sym({ kind: 'weak-signal', evidence: [
    { label: 'SNR margin', value: '4dB' },
    { label: 'failed deliveries', value: '13 in 30m (too few sends for a rate)' },
  ] });
  for (const s of [rtt, weak]) {
    const lines = plain(renderRemedy(ctx(80, 30, [s]))).split('\n');
    const row = lines.find((l) => /^ {4}measured /.test(l)) ?? '';
    // Every label printed is followed by its WHOLE value.
    for (const e of s.evidence) {
      if (row.includes(e.label + ' ')) assert.ok(row.includes(`${e.label} ${e.value}`), `"${e.label}" is whole or absent: "${row}"`);
    }
    assert.ok(row.includes(`${s.evidence[0].label} ${s.evidence[0].value}`), `the first measurement leads: "${row}"`);
    const shown = s.evidence.filter((e) => row.includes(`${e.label} ${e.value}`)).length;
    if (shown < s.evidence.length) assert.match(row, new RegExp(`\\+${s.evidence.length - shown}$`), `a shed one is counted: "${row}"`);
  }
  // At 40 the first measurement still fits beside the basis word; the rest is counted.
  const narrow = plain(renderRemedy(ctx(40, 30, [weak]))).split('\n').find((l) => /^ {4}measured/.test(l)) ?? '';
  assert.equal(narrow, '    measured  SNR margin 4dB +1');
});

test('the evidence row sets its measurements apart with `  ·  `, never the ` · ` a value carries inside itself (v0.80.0)', () => {
  // `baseline 38±6ms · capped at 300ms` is ONE measurement; with shedLine's
  // ` · ` between tokens too, `capped at 300ms` read as a measurement of its own.
  const rtt = sym({ kind: 'rtt-degraded', evidence: [
    { label: 'RTT', value: '412ms' },
    { label: 'baseline', value: '38±6ms · capped at 300ms' },
    { label: 'newest round trips', value: '380, 402, 455ms' },
  ] });
  const row = (W: number): string => plain(renderRemedy(ctx(W, 30, [rtt]))).split('\n').find((l) => /^ {4}measured /.test(l)) ?? '';
  assert.equal(row(120), '    measured  RTT 412ms  ·  baseline 38±6ms · capped at 300ms  ·  newest round trips 380, 402, 455ms');
  // The wider mark is counted when it sheds: at 80 the third measurement goes, whole, with +1.
  assert.equal(row(80), '    measured  RTT 412ms  ·  baseline 38±6ms · capped at 300ms +1');
});

test('an over-80 candidate title keeps its [cost · basis] tag through a short form (v0.80.0)', () => {
  // The survey row was 87 columns with its indent: shedLine clipped the head
  // at `measurement needed to` and the `+1` disclosing the tag went with it.
  const mesh = sym({ kind: 'mesh-interference', nodeId: null, basis: 'inferred', evidence: [{ label: 'active nodes degraded', value: '9/30 in the same window' }] });
  const at80 = plain(renderRemedy(ctx(80, 30, [mesh])));
  assert.match(at80, /· Survey the RF environment — measurement needed \[physical · inference\]/, at80);
  const at120 = plain(renderRemedy(ctx(120, 30, [mesh])));
  assert.match(at120, /Survey the RF environment \(900 MHz interferers\) — measurement needed to confirm \[physical · inference\]/);
  // At 40 even the short form cannot keep its tag: whole words and a `+1`.
  const at40 = plain(renderRemedy(ctx(40, 30, [mesh]))).split('\n');
  assert.match(at40.find((l) => /Survey/.test(l)) ?? '', /^ {6}· Survey the RF .*\+1$/);
  // The plan headline the same way: its short form at 80, whole words at 40.
  assert.match(at40.find((l) => /▎ /.test(l)) ?? '', /^ {4}▎ Correlated mesh degradation — …$/);
  const edge = sym({ kind: 'edge-cluster', members: [7] });
  const head80 = plain(renderRemedy(ctx(80, 30, [edge]))).split('\n').find((l) => /▎ /.test(l)) ?? '';
  assert.equal(head80, '    ▎ Correlated cluster on a shared route — check the common relay');
  assert.match(plain(renderRemedy(ctx(120, 30, [edge]))), /▎ Correlated cluster on a shared route — check the common relay, not each node\n/);
});

test('every rebuild (healNode) candidate on REMEDY names priority routes at 80 and 120 columns (v0.80.0)', () => {
  // Picked by wrapped line, the caveat lost its object — `…deletes any
  // manually-set priority …` at 80 — and route-churn's never named it at all.
  const kinds: SymptomKind[] = ['route-churn', 'rate-fallback', 'return-path-degraded', 'chronic-return-path', 'weak-signal', 'rtt-degraded'];
  for (const W of [80, 120]) {
    for (const kind of kinds) {
      const lines = plain(renderRemedy(ctx(W, 40, [sym({ kind })]))).split('\n');
      const at = lines.findIndex((l) => /▸ Rebuild routes/.test(l));
      if (at < 0) continue;
      const below = lines.slice(at + 1, at + 4);
      const row = below.find((l) => /priority route/i.test(l));
      assert.ok(row, `${kind} at ${W}: the rebuild's caveat names priority routes:\n${lines.slice(at, at + 4).join('\n')}`);
      assert.match(row!, /[.)]$| …$/, `${kind} at ${W}: and ends whole: "${row}"`);
    }
  }
  const seen = kinds.filter((kind) => plain(renderRemedy(ctx(120, 40, [sym({ kind })]))).includes('▸ Rebuild routes'));
  assert.ok(seen.length >= 4, `fixture: most of these kinds carry a rebuild candidate: ${seen.join(', ')}`);
});
