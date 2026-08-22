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
    engineStatus: () => ({ enabled: true, ready: 3, total: 3 }), efficacyFor, interference: () => ({ noise: { channels: [null,null,null,null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' }, serial: { nakPerH: null, canPerH: null, tmoAckPerH: null, tmoRespPerH: null, band: 'unknown', spanH: 0 }, diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, activeNodes: 0, narrative: '' } }),
  entityStates: () => [], configParams: () => ({ status: 'ready', params: [] }), requestConfigParams: () => {},
  };
}
const mkView = (cols: number, rows: number): ViewState =>
  ({ screen: 'remedy', cols, rows, selected: 0, scroll: 0, filter: '', sortKey: 'id', signalDisplay: 'margin', errorsOnly: false, logCursor: 0, logScroll: 0, logRange: 'all', logAnchorSeq: null } as ViewState);
const ctx = (cols: number, rows: number, symptoms: Symptom[], eff?: DataProvider['efficacyFor']): ScreenCtx =>
  ({ view: mkView(cols, rows), data: data(symptoms, eff), visibleNodes: nodes, filtering: false, actionsEnabled: true });

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
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, ready: true };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/✓ helped 83% \(n=6\) vs 20% self-heal/.test(joined), 'efficacy note shows the win, the base rate, and n');
});

test('M5: a learned-but-not-distinguishable efficacy renders the honest "not distinguishable" note', () => {
  const eff: Eff = { expectedEfficacy: null, n: 8, baseRate: 0.9, ready: true };
  const joined = renderRemedy(ctx(120, 40, [sym()], () => eff)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(/≈ n=8: not distinguishable from self-healing/.test(joined), 'honest null-result note');
});

test('M5: while still learning (not ready) NO efficacy note is shown', () => {
  const eff: Eff = { expectedEfficacy: null, n: 1, baseRate: null, ready: false };
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
  const eff: Eff = { expectedEfficacy: 0.8, n: 10, baseRate: 0.2, ready: true };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.match(joined, /⊘ physical-link symptom/, 'the block is still stated');
  assert.match(joined, /ledger measured 80% here \(n=10\) vs 20% self-heal — the block above still applies/,
    'the measurement reaches the screen AND the block is never undermined');
  assert.ok(!/✓ helped/.test(joined),
    'never as a green endorsement of advice the screen just told you not to take');
  // NOT a bare !/lore/ — the basis TAG legitimately prints "lore" ([physical · lore]).
  // The defect was the NOTE claiming the block's epistemics, so pin that phrase.
  assert.ok(!/block above is lore/.test(joined),
    'and never characterizes the block — blocked carries safety and config gates too');
});

test('a blocked candidate with a NULL result reports it plainly, endorsing nothing', () => {
  const eff: Eff = { expectedEfficacy: null, n: 12, baseRate: 0.5, ready: true };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.match(joined, /measured — not distinguishable from self-healing/);
});

test('a blocked candidate with no opinion yet still says NOTHING', () => {
  const eff: Eff = { expectedEfficacy: null, n: 2, baseRate: null, ready: false };
  const joined = plain(renderRemedy(ctx(140, 40, [sym({ kind: 'route-churn', nodeId: 6 })], () => eff)));
  assert.ok(!/ledger measured|block above|helped|distinguishable/.test(joined),
    'not-ready is silence, blocked or not');
});

test('one plan can carry BOTH voices — green on the runnable, disagreement on the blocked', () => {
  // return-path-degraded plans a runnable candidate AND a blocked one, and the
  // ledger has the same opinion of each. The note must therefore switch VOICE
  // per candidate, not per plan: the reader has to be able to tell which row
  // the measurement is talking about.
  const eff: Eff = { expectedEfficacy: 0.83, n: 6, baseRate: 0.2, ready: true };
  const rows = plain(renderRemedy(ctx(140, 40, [sym()], () => eff))).split('\n');
  assert.ok(rows.some((l) => /✓ helped 83% \(n=6\) vs 20% self-heal/.test(l)),
    'the runnable candidate keeps the plain green note');
  assert.ok(rows.some((l) => /ledger measured 83% here/.test(l) && /block above still applies/.test(l)),
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
