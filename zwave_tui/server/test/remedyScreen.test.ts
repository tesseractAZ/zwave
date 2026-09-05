import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRemedy } from '../src/telnet/screens/remedy';
import { visLen } from '../src/telnet/ansi';
import { NodeStatus } from '../src/types';
import type { DataProvider, NodeSnapshot, ControllerSnapshot, ScreenCtx, ViewState, Symptom, SymptomKind } from '../src/types';

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
    nodes: () => nodes, nodeById: (id) => nodes.find((n) => n.nodeId === id), controller: () => ctrl, events: () => [],
    scoreFor: () => ({ score: 90, grade: 'A', state: 'ok', flags: [] }),
    noiseFloor: () => -100, hasRealNoise: () => true, history: () => ({ rssi: [], rtt: [] }), historyLong: () => ({ rssi: [], rtt: [] }),
    lastUpdated: () => now - 1000, ready: () => true, lastError: () => null, symptoms: () => symptoms,
    engineStatus: () => ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3, band: 0, bands: 6 }), efficacyFor, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseMax: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
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
const ENG = { enabled: true as const, ready: 3, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3, band: 3, bands: 6 };

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
  assert.match(plain(renderRemedy(cx)), /2 confounded by a mid-episode death or remediation — credited to neither arm/);
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
      { ...ENG, total: 39, timeoutReady: 39, rttReady: 1, rssiReady: 12 }))).split('\n');
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
    { enabled: true, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 2, bands: 6 })));
  assert.doesNotMatch(joined, /All clear/, 'nothing measured cannot be cleared');
  assert.doesNotMatch(joined, /graduated timeout, rtt and rssi/, 'nor claimed as graduated');
  assert.match(joined, /No nodes yet/);
  for (const [cols, rows] of [[40, 12], [200, 50]] as const) {
    const lines = renderRemedy(engCtx(cols, rows,
      { enabled: true, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 2, bands: 6 }));
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
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 3, rttReady: 1, rssiReady: 1 })));
  assert.doesNotMatch(joined, /All clear/, 'still not the green all-clear');
  assert.match(joined, /partial detector coverage/);
  // Only the DETECTOR-arming series count as blindness (v0.47.0) — rssi arms
  // none, so it is reported separately rather than as a missing detector.
  assert.match(joined, /No detector yardstick in this band: rtt \(2\) of 3 nodes/,
    `the blind detectors must be NAMED with counts: ${joined.slice(0, 900)}`);
  assert.match(joined, /rssi is short on 2 — a dossier yardstick only/);
  assert.match(joined, /COVERAGE, not health/, 'it must refuse the health claim outright');
});

test('zero coverage says LEARNING and makes no symptom claim at all (v0.46.0)', () => {
  // With no detector able to fire, "no symptoms" would describe the instrument,
  // not the mesh.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, total: 3, timeoutReady: 0, rttReady: 0, rssiReady: 0 })));
  assert.match(joined, /no detector has a yardstick yet/);
  assert.doesNotMatch(joined, /No symptoms/, 'nothing detectable ⇒ no symptom claim');
  assert.doesNotMatch(joined, /All clear/);
});

test('the open-episode disclosure survives PARTIAL coverage (v0.46.0)', () => {
  // The v0.43.1 disclosure sat only in the green branch — behind a gate this
  // mesh cannot pass, so in production it was unreachable. Same shape as the
  // v0.36 inert learning loop: a feature wired, tested, and structurally dead.
  const eng = { ...ENG, total: 3, timeoutReady: 3, rttReady: 1, rssiReady: 1 };
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
    { ...ENG, total: 3, timeoutReady: 0, rttReady: 0, rssiReady: 0 },  // zero coverage
    { ...ENG, total: 3, timeoutReady: 3, rttReady: 1, rssiReady: 1 },  // partial
    { ...ENG, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3 },  // full
    { enabled: true as const, ready: 0, total: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0, band: 2, bands: 6 },
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
    data: { ...data([sym()]), probeable: () => true, verifyOwedFor: () => 3 },
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
    ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3, band: 0, bands: 6, ...over });
  const CASES: Array<[string, ReturnType<DataProvider['engineStatus']>, RegExp, RegExp]> = [
    ['engine off',  E({ enabled: false }),                              /engine off/,      /Engine disabled/],
    ['no roster',   E({ total: 0, ready: 0, timeoutReady: 0, rttReady: 0, rssiReady: 0 }), /no roster/, /No nodes yet/],
    ['learning',    E({ timeoutReady: 0, rttReady: 0, rssiReady: 0 }),  /learning/,        /Learning/],
    ['partial',     E({ timeoutReady: 3, rttReady: 1, rssiReady: 1 }),  /partial coverage/, /partial detector coverage/],
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
