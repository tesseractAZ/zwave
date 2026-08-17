/**
 * v0.29 — TOPOLOGY per-hop readings, route churn, and the surplus accounting.
 *
 * Topology's waste was measured as HORIZONTAL first: `lr(left, right, cols)`
 * pinned a ~32-column left block and a ~16-column right block to opposite edges
 * of a 200-column row, so ink sat at 30% even at a height where ZERO rows were
 * blank. The fix spends that gutter on `repeaterRSSI[]` — the per-hop readings
 * the screen already held and never drew.
 *
 * Every case below pins a way that could go wrong rather than merely ugly, and
 * each one is a defect this codebase has actually shipped at least once:
 *   • a POSITIVE "no reading" sentinel (127) rendered as the strongest link;
 *   • a 0/0 ratio drawn as a measured 0%;
 *   • a truncation that leaves half of a failed pair, naming an innocent node;
 *   • a count shown without the window that qualifies it;
 *   • an addition that quietly costs a row on the smallest terminal.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderTopology } from '../src/telnet/screens/topology';
import { NodeStatus } from '../src/types';
import type { DataProvider, LogEvent, NodeSnapshot, RouteStat, ScreenCtx } from '../src/types';
import { mkNode, mkView, mockData } from './_logHelpers';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function route(repeaters: number[], rssi: number, repeaterRSSI: number[]): RouteStat {
  return { repeaters, rssi, repeaterRSSI, protocolDataRate: 3, routeFailedBetween: null } as RouteStat;
}

function ctxFor(
  nodes: NodeSnapshot[],
  opts: { cols?: number; rows?: number; signalDisplay?: 'dbm' | 'margin'; events?: LogEvent[] } = {},
): ScreenCtx {
  const view = mkView({
    screen: 'topology',
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 40,
    signalDisplay: opts.signalDisplay ?? 'margin',
  });
  const data: DataProvider = mockData({ nodes, events: opts.events ?? [] });
  return { view, data, visibleNodes: nodes };
}

const lines = (ctx: ScreenCtx): string[] => renderTopology(ctx).map(strip);
const joined = (ctx: ScreenCtx): string => lines(ctx).join('\n');

/* ── trap 1: the "no reading" sentinels are POSITIVE ──────────────────── */

test('a 127 sentinel hop renders as no-data, never as a level', () => {
  // 127/126/125 mean "no reading". They are POSITIVE, so anything that treats
  // them as dBm ranks them as the STRONGEST link on the mesh — a sentinel would
  // be drawn green, at the top of every ordering.
  const n = mkNode({ nodeId: 5, name: 'Sentinel Hop', stats: { ...mkNode().stats, lwr: route([12], -70, [127]) } });
  const rep = mkNode({ nodeId: 12, name: 'Repeater' });
  const out = joined(ctxFor([n, rep], { cols: 160 }));

  assert.ok(/n12\(—\)/.test(out), `sentinel hop must render as an em-dash, got:\n${out}`);
  assert.ok(!/n12\(127\)/.test(out), 'the raw sentinel leaked into the chain');
  assert.ok(!/n12\(\+?\d+\)/.test(out), 'the sentinel was converted into a level');
});

test('sentinel readings are dropped from the repeater aggregate, not folded in', () => {
  // The discriminating case is a repeater whose ONLY reading is a sentinel.
  //
  // The obvious test — one real reading plus one sentinel, assert the sentinel
  // is not the "worst" — cannot fail. `worst` is a Math.min and the sentinels
  // are POSITIVE, so a leaked 127 can never move a minimum: correct and broken
  // code agree on the answer, and the test passes for the wrong reason. (The
  // mutation harness caught exactly that; the first version of this test let
  // `topo-spine-sentinel` survive.)
  //
  // With every reading a sentinel there is nothing to average, so the honest
  // output is no-data — and a leak shows up as a rendered 127.
  const rep = mkNode({ nodeId: 12, name: 'Repeater', isRouting: true });
  const a = mkNode({ nodeId: 5, name: 'A', stats: { ...mkNode().stats, lwr: route([12], -70, [127]) } });
  const b = mkNode({ nodeId: 6, name: 'B', stats: { ...mkNode().stats, lwr: route([12], -70, [126]) } });
  const out = joined(ctxFor([rep, a, b], { cols: 200, rows: 40, signalDisplay: 'dbm' }));

  assert.ok(/worst\s+—\s+n0\/2/.test(out), `all-sentinel aggregate must report 0 of 2 dependents, got:\n${out}`);
  assert.ok(!/\b12[567]\b/.test(out), `a raw sentinel reached the screen:\n${out}`);
});

test('the aggregate sample count excludes sentinels', () => {
  // This is the ONLY observable effect of the sentinel filter, which is why the
  // count exists. `worst` is a Math.min and the sentinels are positive, so they
  // can never be the minimum; they also sit far above any weak margin, so the
  // "weak" tally is blind to them too. If a sentinel leaks in, the sample size
  // is the single number that moves.
  const rep = mkNode({ nodeId: 12, name: 'Repeater' });
  const real = mkNode({ nodeId: 5, name: 'Real', stats: { ...mkNode().stats, lwr: route([12], -70, [-64]) } });
  const sent = mkNode({ nodeId: 6, name: 'Sentinel', stats: { ...mkNode().stats, lwr: route([12], -70, [127]) } });
  const out = joined(ctxFor([rep, real, sent], { cols: 200, rows: 40, signalDisplay: 'dbm' }));

  assert.ok(/worst\s+-64\s+n1\/2/.test(out), `one usable reading of two dependents must report n1/2, got:\n${out}`);
  assert.ok(!/n2\/2/.test(out), 'the sentinel was counted as a usable sample');
});

/* ── trap 2: a stale dependent is not live evidence ───────────────────── */

test('DEAD dependents do not contribute their last-seen reading to the aggregate', () => {
  // nodeLine refuses to grade a dead node's telemetry as live. An aggregate that
  // silently folds it back in would undo exactly that, and it would do so where
  // it is least visible — inside a summary statistic.
  const rep = mkNode({ nodeId: 12, name: 'Repeater' });
  const alive = mkNode({ nodeId: 5, name: 'Alive', stats: { ...mkNode().stats, lwr: route([12], -70, [-60]) } });
  const dead = mkNode({
    nodeId: 6,
    name: 'Dead',
    status: NodeStatus.Dead,
    stats: { ...mkNode().stats, lwr: route([12], -95, [-99]) },
  });

  const withDead = joined(ctxFor([rep, alive, dead], { cols: 200, rows: 40, signalDisplay: 'dbm' }));
  const withoutDead = joined(ctxFor([rep, alive], { cols: 200, rows: 40, signalDisplay: 'dbm' }));

  const worst = (s: string): string | null => (s.match(/worst\s+(-?\d+)/) ?? [])[1] ?? null;
  assert.equal(
    worst(withDead),
    worst(withoutDead),
    'a dead node’s stale -99 reading changed the live aggregate',
  );
});

/* ── trap 3: there is deliberately no failure rate ───────────────────── */

test('the repeater aggregate publishes NO failure rate', () => {
  // Sigma(timeoutResponse)/Sigma(commandsTX) over a repeater's dependents looks
  // like a per-repeater reliability figure and is not one: those are per-node
  // LIFETIME totals spanning every route the node has ever used, so a node
  // routed via two repeaters charges 100% of its failures to BOTH, and a
  // repeater that joined the route a minute ago inherits everything from before
  // it was involved. The driver exposes no per-link counter, so no rate is the
  // honest output. (A first cut shipped this ratio; the review caught it.)
  const rep = mkNode({ nodeId: 12, name: 'Repeater' });
  const busy = mkNode({
    nodeId: 5,
    name: 'Busy',
    stats: { ...mkNode().stats, commandsTX: 1000, timeoutResponse: 250, lwr: route([12], -70, [-64]) },
  });
  const out = joined(ctxFor([rep, busy], { cols: 200, rows: 40 }));

  assert.ok(!/tmo/.test(out), `a failure rate reappeared on the spine:\n${out}`);
  assert.ok(!/25\.0%/.test(out), 'a lifetime timeout ratio was attributed to the repeater');
});

/* ── the unit toggle: one row must not mix units ──────────────────────── */

test('per-hop readings follow the dBm/margin toggle, like every other number on the row', () => {
  // Detail's routeChain idiom is NOT portable here unchanged: Detail has no unit
  // toggle. A raw "-93" beside this screen's "+11dB" cell is two units on one row.
  const n = mkNode({ nodeId: 5, name: 'Node', stats: { ...mkNode().stats, lwr: route([12], -70, [-64]) } });
  const rep = mkNode({ nodeId: 12, name: 'Rep' });

  const dbm = joined(ctxFor([n, rep], { cols: 160, signalDisplay: 'dbm' }));
  assert.ok(/n12\(-64\)/.test(dbm), `dBm mode must show the raw reading, got:\n${dbm}`);

  // noiseFloor() is -95 in the mock, so -64 is a +31 dB margin.
  const margin = joined(ctxFor([n, rep], { cols: 160, signalDisplay: 'margin' }));
  assert.ok(/n12\(\+31\)/.test(margin), `margin mode must show the margin, got:\n${margin}`);
  assert.ok(!/n12\(-64\)/.test(margin), 'a raw dBm reading leaked into margin mode');
});

/* ── whole-token degradation: never half of a failed pair ─────────────── */

test('a chain squeezed for width never names one end of a failed pair', () => {
  // lr() truncates the LEFT, and the chain lives on the left, so a blind clip
  // returned things like "⚠n153↮" — half a pair, which reads as naming an
  // innocent node. Every degradation step must drop a WHOLE token.
  const lwr = { ...route([31, 23, 12, 44], -70, [-93, -84, -62, -70]), routeFailedBetween: [153, 1] } as RouteStat;
  const n = mkNode({ nodeId: 5, name: 'A Very Long Node Name Indeed', stats: { ...mkNode().stats, lwr } });
  const reps = [31, 23, 12, 44, 153, 1].map((id) => mkNode({ nodeId: id, name: `R${id}` }));

  for (let cols = 60; cols <= 200; cols++) {
    const out = lines(ctxFor([n, ...reps], { cols, rows: 30 }));
    const row = out.find((l) => /\bn5\b/.test(l));
    if (!row) continue;
    const hasA = /n153/.test(row);
    const hasB = /↮n1\b/.test(row);
    assert.equal(hasA, hasB, `half a failed pair at ${cols} cols: ${row}`);
  }
});

test('the failed pair outranks the per-hop readings when both will not fit', () => {
  // The original assertion above (hasA === hasB) is satisfied by false === false,
  // so it passed happily while the renderer dropped the pair ENTIRELY to keep the
  // readings — the review caught that. The ladder's whole point is the priority:
  // the marker degrades only after the chain has run out of room to give.
  const lwr = { ...route([131, 123, 112, 144], -70, [-100, -100, -100, -100]), routeFailedBetween: [231, 232] } as RouteStat;
  const n = mkNode({ nodeId: 5, name: 'Back Bedroom Motion', stats: { ...mkNode().stats, lwr } });
  const reps = [131, 123, 112, 144].map((id) => mkNode({ nodeId: id, name: `R${id}` }));

  for (let cols = 100; cols <= 200; cols++) {
    const row = lines(ctxFor([n, ...reps], { cols, rows: 30, signalDisplay: 'dbm' })).find((l) => /\bn5\b/.test(l));
    if (!row || !/⚠/.test(row)) continue;
    // Wherever the annotated form survives, the pair must be named too: the
    // readings cost more columns than the pair does, so keeping them while
    // dropping it is never the right trade.
    if (/\(-100\)/.test(row)) {
      assert.ok(/n231↮n232/.test(row), `readings kept but the failed pair dropped at ${cols} cols: ${row}`);
    }
  }
});

/* ── churn: the count and the window that qualifies it are one unit ───── */

const routeEvents = (nodeId: number, k: number, ts: number): LogEvent[] =>
  Array.from({ length: k }, (_v, i) => ({
    seq: i + 1,
    ts,
    source: 'net' as const,
    severity: 'info' as const,
    kind: 'route' as const,
    nodeId,
    text: 'route changed',
  }));

test('a per-row reroute token never appears without the span that qualifies it', () => {
  // An unqualified "7 reroutes" reads as a rate. The ring is capped and resets
  // on boot, so the count is meaningless without the window it was seen over —
  // which is why ONE gate drives both, and this sweep is the proof.
  const n = mkNode({ nodeId: 5, name: 'Churner', stats: { ...mkNode().stats, lwr: route([12], -70, [-64]) } });
  const rep = mkNode({ nodeId: 12, name: 'Rep' });
  const events = routeEvents(5, 7, Date.now() - 3_600_000);

  for (let cols = 60; cols <= 200; cols++) {
    const out = joined(ctxFor([n, rep], { cols, rows: 30, events }));
    if (/↻/.test(out)) {
      assert.ok(/REROUTES\//.test(out), `row token with no qualifying span at ${cols} cols`);
    }
  }
});

test('a node that has not rerouted gets no token at all, not a zero', () => {
  // "↻0" is a claim about a window the operator cannot see. Absence is honest.
  const quiet = mkNode({ nodeId: 5, name: 'Steady', stats: { ...mkNode().stats, lwr: route([12], -70, [-64]) } });
  const rep = mkNode({ nodeId: 12, name: 'Rep' });
  const out = lines(ctxFor([quiet, rep], { cols: 160, rows: 30, events: routeEvents(99, 3, Date.now() - 60_000) }));
  const row = out.find((l) => /\bn5\b/.test(l))!;
  assert.ok(!/↻/.test(row), `a node with no reroutes drew a token: ${row}`);
});

test('the reroute total is never divided into a rate', () => {
  const n = mkNode({ nodeId: 5, name: 'Churner', stats: { ...mkNode().stats, lwr: route([12], -70, [-64]) } });
  const out = joined(ctxFor([n], { cols: 160, rows: 30, events: routeEvents(5, 7, Date.now() - 3_600_000) }));
  assert.ok(/7 REROUTES\//.test(out), `expected a count over a span, got:\n${out}`);
  assert.ok(!/\/h\b|per hour|\/hr/.test(out), 'the count was extrapolated into a rate');
});

/* ── surplus accounting: additions must not cost a row ────────────────── */

test('with no surplus the repeater panel does not grow — no "+N more" line', () => {
  // The first cut of this feature added the disclosure line unconditionally and
  // it cost a node row at 80x24: the panel grew by one, the tree lost one. The
  // header count already reports the true total, so with no surplus that IS the
  // disclosure.
  const reps = [11, 12, 13, 14, 15, 16, 17].map((id) => mkNode({ nodeId: id, name: `Rep${id}` }));
  const deps = Array.from({ length: 12 }, (_v, i) =>
    mkNode({
      nodeId: 100 + i,
      name: `Dep${i}`,
      stats: { ...mkNode().stats, lwr: route([11 + (i % 7)], -70, [-64]) },
    }),
  );
  const out = joined(ctxFor([...reps, ...deps], { cols: 80, rows: 24 }));
  assert.ok(!/more repeater\(s\)/.test(out), `disclosure line appeared with no surplus:\n${out}`);
});

test('the frame stays exactly rows tall and within cols at every size', () => {
  const reps = [11, 12, 13].map((id) => mkNode({ nodeId: id, name: `Rep${id}` }));
  const deps = Array.from({ length: 20 }, (_v, i) =>
    mkNode({
      nodeId: 100 + i,
      name: `Dependent Node With A Long Name ${i}`,
      stats: { ...mkNode().stats, lwr: route([11 + (i % 3)], -70, [-64]) },
    }),
  );
  const nodes = [...reps, ...deps];
  const events = routeEvents(100, 4, Date.now() - 900_000);
  for (const cols of [60, 72, 80, 99, 100, 120, 160, 200]) {
    for (const rows of [16, 24, 40, 60, 80]) {
      const out = renderTopology(ctxFor(nodes, { cols, rows, events }));
      assert.equal(out.length, rows, `row count wrong at ${cols}x${rows}`);
      for (const l of out) {
        assert.ok(strip(l).length <= cols, `line overflows ${cols} cols at ${cols}x${rows}: ${strip(l)}`);
      }
    }
  }
});

test('a driver 0 is a missing reading, not the strongest link on the mesh', () => {
  // FOUND ON THE LIVE MESH, 2026-08-02. Node 30 came back with
  // repeaterRSSI [0, 0] while every genuine reading on the network sat between
  // -68 and -86 dBm. 0 is not in the documented sentinel set (127/126/125), so
  // every call site that ENUMERATED those markers let it through, and it
  // rendered as "+100" — the strongest link on a screen whose real hops read
  // +14..+32.
  //
  // The guard is now the domain rule (a reading is a finite NEGATIVE number),
  // which cannot go stale the next time the driver adds a marker.
  const n = mkNode({ nodeId: 30, name: 'Dining Room Lamp', stats: { ...mkNode().stats, lwr: route([3, 5], -68, [0, 0]) } });
  const reps = [3, 5].map((id) => mkNode({ nodeId: id, name: `R${id}` }));
  const out = joined(ctxFor([n, ...reps], { cols: 200, rows: 40 }));

  assert.ok(/n3\(—\)/.test(out) && /n5\(—\)/.test(out), `a 0 hop must read as no-data, got:\n${out}`);
  assert.ok(!/\+100/.test(out), 'a 0 reading was rendered as a +100 dB margin');
  assert.ok(!/n[35]\(0\)/.test(out), 'the raw 0 leaked into the chain');
});

test('a 0 reading never enters the repeater aggregate', () => {
  const rep = mkNode({ nodeId: 12, name: 'Repeater' });
  const zero = mkNode({ nodeId: 5, name: 'Zero', stats: { ...mkNode().stats, lwr: route([12], -70, [0]) } });
  const real = mkNode({ nodeId: 6, name: 'Real', stats: { ...mkNode().stats, lwr: route([12], -70, [-74]) } });
  const out = joined(ctxFor([rep, zero, real], { cols: 200, rows: 40, signalDisplay: 'dbm' }));

  assert.ok(/worst\s+-74\s+n1\/2/.test(out), `only the real reading counts, got:\n${out}`);
  assert.ok(!/worst\s+0\b/.test(out), 'a 0 became the reported worst reading');
});

/* ── v0.34: route stability — the measurement that answers "never fired" ──── */

/** 38 end nodes at mixed hop depths — enough to overflow a short frame and to
 *  leave pad on a tall one, which is exactly the surplus rule under test. */
function bigMesh(): NodeSnapshot[] {
  return Array.from({ length: 38 }, (_v, i) => {
    const id = i + 2;
    const hops = i % 3;
    return mkNode({
      nodeId: id, name: 'Node ' + id, isController: false,
      stats: { rtt: 30, rssi: -60, nlwr: null, commandsTX: 100, commandsRX: 90,
        commandsDroppedTX: 0, commandsDroppedRX: 0, timeoutResponse: 0, lastSeen: Date.now(),
        lwr: route(Array.from({ length: hops }, (_x, k) => 2 + k), -62, [-60]) } as never,
    });
  });
}
const visLen = (s: string): number => strip(s).length;

function withStability(
  nodes: NodeSnapshot[],
  rs: (id: number) => { changes: number; hours: number } | null,
  opts: { cols?: number; rows?: number } = {},
): ScreenCtx {
  const ctx = ctxFor(nodes, opts);
  (ctx.data as { routeStability?: (id: number) => { changes: number; hours: number } | null }).routeStability = rs;
  return ctx;
}

test('ZERO re-routes is ONE confident finding, never 38 rows of "0"', () => {
  // The whole point: route-churn has never fired, and until this panel there
  // was no way to tell "the mesh is stable" from "the detector cannot see".
  const out = lines(withStability(bigMesh(), () => ({ changes: 0, hours: 72 }), { cols: 200, rows: 80 }));
  const body = out.join('\n');
  assert.match(body, /Route stability/, 'the panel must appear when there is pad to fund it');
  assert.match(body, /every path held/, 'zero must read as a finding');
  assert.match(body, /zero re-routes/);
  assert.match(body, /3d measured/, 'the measured span qualifies the claim');
  const zeroRows = out.filter((l) => /re-route/.test(l) && /\b0\b/.test(l));
  assert.equal(zeroRows.length, 0, 'must not spend the budget restating 0 per node');
});

test('nodes that DID re-route are named and ranked, worst first', () => {
  const out = lines(withStability(bigMesh(), (id) =>
    ({ changes: id === 7 ? 9 : id === 12 ? 3 : 0, hours: 72 }), { cols: 200, rows: 80 }));
  const body = out.join('\n');
  assert.match(body, /Route stability/);
  const n7 = out.findIndex((l) => /\bn7\b/.test(l) && /re-route/.test(l));
  const n12 = out.findIndex((l) => /\bn12\b/.test(l) && /re-route/.test(l));
  assert.ok(n7 >= 0 && n12 >= 0, 'both churning nodes must be named');
  assert.ok(n7 < n12, 'the worst node ranks first');
  assert.match(body, /held every path/, 'the stable remainder is still accounted for');
});

test('NO coarse history renders NOTHING — never a confident zero over no data', () => {
  const out = lines(withStability(bigMesh(), () => ({ changes: 0, hours: 0 }), { cols: 200, rows: 80 }));
  assert.ok(!out.join('\n').includes('Route stability'),
    'an empty measurement must not render as "every path held"');
});

test('a provider without routeStability renders exactly as before', () => {
  const plain = lines(ctxFor(bigMesh(), { cols: 200, rows: 80 }));
  assert.ok(!plain.join('\n').includes('Route stability'));
});

test('the panel is LEFTOVER-funded — a scrolling tree never loses a row to it', () => {
  // 80x24: the tree already overflows, so there is no pad to spend. The panel
  // must not exist, and the frame must be unchanged from the no-provider case.
  const withRs = lines(withStability(bigMesh(), () => ({ changes: 4, hours: 72 }), { cols: 80, rows: 24 }));
  const without = lines(ctxFor(bigMesh(), { cols: 80, rows: 24 }));
  assert.deepEqual(withRs, without, 'no surplus ⇒ byte-identical frame');
});

test('render contract holds with the panel across sizes', () => {
  for (const [cols, rows] of [[200, 80], [160, 40], [120, 30], [100, 24], [80, 24], [64, 20]] as const) {
    const out = renderTopology(withStability(bigMesh(), (id) =>
      ({ changes: id % 4, hours: 50 }), { cols, rows }));
    assert.equal(out.length, rows, `row count at ${cols}x${rows}`);
    for (const l of out) assert.ok(visLen(l) <= cols, `width at ${cols}x${rows}: ${strip(l)}`);
  }
});

/* ── v0.34 audit fixes: the three defects the fixtures hid ───────────────── */

test('the span is the SHORTEST window — a claim cannot outrun its weakest node', () => {
  // Every earlier fixture passed a CONSTANT `hours`, where max === min, so a
  // max-vs-min swap was invisible to the whole suite. Per-node coarse rings
  // start at each node's own first fold, so this case is ordinary, not exotic:
  // one long-lived node and two recently-included ones.
  const nodes = bigMesh().slice(0, 3);
  const hoursById: Record<number, number> = { 2: 240, 3: 0.5, 4: 0.5 };
  const out = lines(withStability(nodes, (id) => ({ changes: 0, hours: hoursById[id] ?? 0.5 }),
    { cols: 200, rows: 80 }));
  const body = out.join('\n');
  assert.match(body, /every path held/);
  assert.ok(!/10d measured/.test(body),
    `must not credit 3 nodes with the oldest node's 10-day window: ${body.match(/every path held[^\n]*/)?.[0]}`);
  assert.match(body, /1h measured/, 'the shortest window is the honest one');
});

test('ranking is by the per-DAY RATE the row displays, not the raw count', () => {
  // 10 re-routes over 10 days = 1/day; 4 over 2 hours = 48/day. Sorting by raw
  // count puts the genuinely unstable node SECOND — contradicting the panel's
  // own reason for showing a rate at all.
  const nodes = bigMesh().slice(0, 4);
  const spec: Record<number, { changes: number; hours: number }> = {
    2: { changes: 10, hours: 240 }, // 1/day
    3: { changes: 4, hours: 2 },    // 48/day — the real problem
    4: { changes: 0, hours: 240 },
    5: { changes: 0, hours: 240 },
  };
  const out = lines(withStability(nodes, (id) => spec[id] ?? { changes: 0, hours: 240 },
    { cols: 200, rows: 80 }));
  const n3 = out.findIndex((l) => /\bn3\b/.test(l) && /re-route/.test(l));
  const n2 = out.findIndex((l) => /\bn2\b/.test(l) && /re-route/.test(l));
  assert.ok(n3 >= 0 && n2 >= 0, 'both churning nodes must be listed');
  assert.ok(n3 < n2, `48/day must rank above 1/day — got n3 at ${n3}, n2 at ${n2}`);
});
