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
    engineStatus: () => ({ enabled: true, ready: 3, total: 3, timeoutReady: 3, rttReady: 3, rssiReady: 3, band: 0, bands: 6 }), efficacyFor, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
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
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/✓ helped 83% \(n≈6\.0 · 3 nodes\) vs 20% self-heal/.test(joined),
    'the note shows the win, the base rate, n, AND how many nodes taught it');
});

test('M5: a learned-but-not-distinguishable efficacy renders the honest "not distinguishable" note', () => {
  const eff: Eff = { expectedEfficacy: null, n: 8, baseRate: 0.9, nodes: 3, ready: true, lowerBound: null, bar: null };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/≈ n≈8\.0 · 3 nodes: not distinguishable from self-healing/.test(joined), 'honest null-result note');
});

test('M5: while still learning (not ready) NO efficacy note is shown', () => {
  const eff: Eff = { expectedEfficacy: null, n: 1, baseRate: null, nodes: 3, ready: false, lowerBound: null, bar: null };
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
  const eff: Eff = { expectedEfficacy: 0.8, n: 10, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null };
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
  const eff: Eff = { expectedEfficacy: null, n: 12, baseRate: 0.5, nodes: 3, ready: true, lowerBound: null, bar: null };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.match(joined, /measured — not distinguishable from self-healing/);
});

test('a blocked candidate with no opinion yet still says NOTHING', () => {
  const eff: Eff = { expectedEfficacy: null, n: 2, baseRate: null, nodes: 3, ready: false, lowerBound: null, bar: null };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.ok(!/ledger measured|block above|helped|distinguishable/.test(joined),
    'not-ready is silence, blocked or not');
});

test('one plan can carry BOTH voices — green on the runnable, disagreement on the blocked', () => {
  // return-path-degraded plans a runnable candidate AND a blocked one, and the
  // ledger has the same opinion of each. The note must therefore switch VOICE
  // per candidate, not per plan: the reader has to be able to tell which row
  // the measurement is talking about.
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, nodes: 3, ready: true, lowerBound: null, bar: null };
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
  const solo: Eff = { expectedEfficacy: null, n: 6, baseRate: 0.2, nodes: 1, ready: true, lowerBound: null, bar: null };
  const broad: Eff = { expectedEfficacy: null, n: 6, baseRate: 0.2, nodes: 6, ready: true, lowerBound: null, bar: null };
  assert.match(plain(renderRemedy(ctx(140, 40, [sym()], () => solo))), /n≈6\.0 · 1 node:/);
  assert.match(plain(renderRemedy(ctx(140, 40, [sym()], () => broad))), /n≈6\.0 · 6 nodes:/);
});

test('a ledger that predates the tracking SAYS SO rather than falling silent (v0.43.1)', () => {
  // A pre-v0.36.5 file has no provenance recorded. Rendering "1 node" would be
  // a fabricated claim about evidence breadth — but silence was not honest
  // either: it is indistinguishable from a screen that simply omits the count,
  // and ENGINE has said "sources not recorded" for the same row since v0.41.1.
  // Two screens, one ledger key, two different stories. Now one function.
  const old: Eff = { expectedEfficacy: 0.9, n: 8, baseRate: 0.2, nodes: 0, ready: true, lowerBound: null, bar: null };
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
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: 0.6, nodes: 3, ready: true, lowerBound: 0.52, bar: 0.65 });
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
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: 0.6, nodes: 3, ready: true, lowerBound: 0.63, bar: 0.65 });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  const line = joined.split('\n').find((l) => /not distinguishable/.test(l)) ?? '';
  assert.match(line, /short of the 65% bar/, `the bar must be named: "${line.trim()}"`);
  assert.doesNotMatch(line, /63% vs 60%/, 'never a bare bound-beats-base comparison under a withheld verdict');
});

test('with no measured base rate the withheld claim says THAT, not a false comparison (v0.43.1)', () => {
  const eff = (): Eff => ({ expectedEfficacy: null, n: 9, baseRate: null, nodes: 2, ready: true, lowerBound: 0.44, bar: null });
  const joined = plain(renderRemedy(ctx(200, 40, [sym()], eff)));
  assert.match(joined, /even pessimistically 44%, and self-heal is not measured yet/);
});

test('a full TIMEOUT baseline with an empty RSSI baseline is NOT "every node learned" (v0.43.1)', () => {
  // The pre-v0.43.1 count was timeouts only. A fleet whose RSSI series has
  // never graduated rendered the green all-clear and the sentence "Every node
  // has a graduated baseline" — a claim over three series from one series.
  const joined = plain(renderRemedy(engCtx(200, 40, { ...ENG, rssiReady: 0, rttReady: 1 })));
  assert.doesNotMatch(joined, /All clear/, 'the green all-clear is NOT taken while a series is still learning');
  assert.match(joined, /Learning/);
  assert.match(joined, /timeouts 3\/3/);
  assert.match(joined, /rtt 1\/3/);
  assert.match(joined, /rssi 0\/3/);
});

test('every baseline count names the time-of-day band it was measured in (v0.43.1)', () => {
  // bandOf() = hour / (24 / N_BANDS), so band 3 of 6 is 12:00–16:00. The counts
  // are true only for that band; a node can read learned at 03:00 and unlearned
  // at 15:00 with nothing having changed.
  const learning = plain(renderRemedy(engCtx(200, 40, { ...ENG, rssiReady: 0, band: 3 })));
  assert.match(learning, /12:00–16:00/, `band named while learning: ${learning.slice(0, 400)}`);
  const clear = plain(renderRemedy(engCtx(200, 40, { ...ENG, band: 5 })));
  assert.match(clear, /All clear/);
  assert.match(clear, /20:00–24:00/, 'and named on the all-clear too');
});

test('all three series graduated in this band DOES reach the all-clear (v0.43.1)', () => {
  const joined = plain(renderRemedy(engCtx(200, 40, ENG)));
  assert.match(joined, /✓ All clear/);
  assert.match(joined, /graduated timeout, rtt and rssi baseline/);
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
  const lines = plain(renderRemedy(engCtx(40, 12, { ...ENG, rssiReady: 0, band: 3 }))).split('\n');
  const head = lines.find((l) => /Learning/.test(l)) ?? '';
  assert.match(head, /12–16h/, `band qualifier lost at 40 cols: "${head.trim()}"`);
  // Wide terminals keep the full form.
  const wide = plain(renderRemedy(engCtx(120, 24, { ...ENG, rssiReady: 0, band: 3 }))).split('\n');
  assert.match(wide.find((l) => /Learning/.test(l)) ?? '', /12:00–16:00/);
  // And the qualifier survives EVERY width in between — never silently dropped.
  for (let cols = 40; cols <= 200; cols += 1) {
    const h = plain(renderRemedy(engCtx(cols, 24, { ...ENG, rssiReady: 0, band: 3 }))).split('\n')
      .find((l) => /Learning/.test(l)) ?? '';
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
