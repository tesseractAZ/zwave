/**
 * Coverage for the two v0.24 surfaces that had none: the Controller's frame
 * counters / reliability meter, and the Heatmap's area arithmetic.
 *
 * Both carry claims that are easy to get quietly wrong — a counter that reads
 * exact but is truncated, a bar labelled "reliability" that fills with its
 * opposite, an area grade computed from a repeater's link rather than the
 * devices in the room. Nothing else in the suite executes either renderer.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderController } from '../src/telnet/screens/controller';
import { renderHeatmap } from '../src/telnet/screens/heatmap';
import { NodeStatus } from '../src/types';
import type { ControllerSnapshot, DataProvider, ScreenCtx } from '../src/types';
import { marginColor, noiseColor } from '../src/telnet/bands';
import { mkNode, mkView, mockData } from './_logHelpers';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

type Stats = NonNullable<ControllerSnapshot['statistics']>;

const NO_ERRORS: Stats = {
  messagesTX: 0, messagesRX: 0, messagesDroppedTX: 0, messagesDroppedRX: 0,
  NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0, timeoutCallback: 0
};

function mkCtrl(statistics: Stats | null): ControllerSnapshot {
  return {
    homeId: 3237998081, nodeId: 1, sdkVersion: '7.19', firmwareVersion: '1.0',
    rfRegion: 'USA', isPrimary: true, isSUC: true, isSISPresent: true,
    manufacturer: 'Zooz', model: 'ZST39', isRebuildingRoutes: false,
    rebuildStartedAt: null, firmwareUpdatesAvailable: 0, backgroundRSSI: [],
    statistics,
  };
}

function ctrlCtx(statistics: Stats | null, cols = 100, rows = 30): ScreenCtx {
  const data: DataProvider = { ...mockData(), controller: () => mkCtrl(statistics) };
  return { view: mkView({ screen: 'controller', cols, rows }), data, visibleNodes: [], filtering: false } as ScreenCtx;
}

const render = (ctx: ScreenCtx): string => renderController(ctx).map(strip).join('\n');

/* ── Controller: counters must never render as a different number ───────── */

test('large frame counters are compacted, never clipped into a smaller number', () => {
  const out = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 1_234_567, messagesRX: 89_432 }));
  // 1234567 character-clipped to fit its cell would read as "12345" or "123456"
  // — an exact-looking number wrong by orders of magnitude.
  assert.ok(/1\.2M/.test(out), `expected a compacted counter, got:\n${out}`);
  assert.ok(!/\b12345\b|\b123456\b/.test(out), `counter was clipped into a wrong value:\n${out}`);
  // Values below the compaction threshold stay exact.
  assert.ok(out.includes('89432'), `small counter should stay exact:\n${out}`);
});

test('the reliability bar fills with reliability, not with the error rate', () => {
  const perfect = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 10_000, messagesRX: 9_000 }));
  const line = perfect.split('\n').find((l) => l.includes('reliability'));
  assert.ok(line, 'no reliability line rendered');
  // A flawless link must show a FULL bar. Filling with the error fraction
  // drained it to empty — the exact inverse of what the label promises.
  assert.ok(/█/.test(line) && !/░/.test(line), `perfect link did not fill the bar: ${line}`);
  // Match the WHOLE number: '100.0% errors'.includes('0.0% errors') is true.
  assert.equal(Number(/([\d.]+)% errors/.exec(line)?.[1]), 0, `expected a zero error rate: ${line}`);

  const bad = render(ctrlCtx({
    ...NO_ERRORS, messagesTX: 100, messagesRX: 0,
    NAK: 40, CAN: 30, timeoutACK: 20, timeoutResponse: 10, timeoutCallback: 0
  }));
  const badLine = bad.split('\n').find((l) => l.includes('reliability'))!;
  assert.ok(/░/.test(badLine), `a failing link should not show a full bar: ${badLine}`);
});

test('the error rate is a fraction of ATTEMPTS and can never exceed 100%', () => {
  // zwave-js counters are DISJOINT: messagesTX counts successes, and NAK/CAN/
  // timeouts/dropped are separate failure tallies. Dividing failures by
  // successes alone yields odds, not a rate — here 900/100 = 900%.
  const out = render(ctrlCtx({
    ...NO_ERRORS, messagesTX: 100, messagesRX: 0,
    messagesDroppedTX: 300, NAK: 300, CAN: 300,
  }));
  const line = out.split('\n').find((l) => l.includes('reliability'))!;
  const pct = Number(/([\d.]+)% errors/.exec(line)?.[1]);
  assert.ok(Number.isFinite(pct), `no error percentage rendered: ${line}`);
  assert.ok(pct <= 100, `error rate exceeded 100%: ${line}`);
  // 900 failures out of 1000 attempts = 90%.
  assert.ok(Math.abs(pct - 90) < 0.5, `expected ~90% errors, got ${pct}: ${line}`);
});

test('every SERIAL failure counter contributes to the error rate', () => {
  // Dropping any single term from the sum previously left the suite green.
  // Each counter is exercised on its own: 1 failure against 99 successes = 1%.
  // `timeoutResponse` is deliberately NOT here — see the test below.
  const COUNTERS = [
    'messagesDroppedTX', 'messagesDroppedRX', 'NAK', 'CAN',
    'timeoutACK', 'timeoutCallback',
  ] as const;
  for (const key of COUNTERS) {
    const out = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 99, [key]: 1 }));
    const line = out.split('\n').find((l) => l.includes('reliability'))!;
    const pct = Number(/([\d.]+)% errors/.exec(line)?.[1]);
    assert.ok(Math.abs(pct - 1) < 0.05,
      `${key} is missing from the error sum (rate read ${pct}%): ${line}`);
  }
  // messagesRX must count toward the denominator too: 1 failure against 99
  // successes split across TX and RX is still 1%.
  const split = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 50, messagesRX: 49, NAK: 1 }));
  const splitLine = split.split('\n').find((l) => l.includes('reliability'))!;
  assert.ok(Math.abs(Number(/([\d.]+)% errors/.exec(splitLine)?.[1]) - 1) < 0.05,
    `messagesRX missing from the denominator: ${splitLine}`);
});

test('a NODE reply timeout does not count against the host↔stick link', () => {
  // `timeoutResponse` is the controller waiting on a node — a mesh symptom that
  // merely surfaces in controller statistics. interference.ts already excludes
  // it from the serial band; this block is labelled host↔stick, so its
  // reliability must agree rather than blaming the serial link for RF loss.
  const out = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 99, timeoutResponse: 50 }));
  const line = out.split('\n').find((l) => l.includes('reliability'))!;
  assert.equal(Number(/([\d.]+)% errors/.exec(line)?.[1]), 0,
    `a node reply timeout was charged to the serial link: ${line}`);
  // It must still be VISIBLE, and named for what it is.
  assert.ok(/node reply/i.test(out), `the node-reply-timeout counter vanished:\n${out}`);
  assert.ok(out.includes('50'), 'the node-reply-timeout count is not shown');
});

test('no frames yet reports no rate rather than a green perfect link', () => {
  // Errors recorded but nothing successfully exchanged: the old guard fell to
  // `frac = 0` and drew a full green bar labelled "0.0% errors" — a perfect
  // link asserted in precisely the state where nothing is working.
  const out = render(ctrlCtx({ ...NO_ERRORS, NAK: 5, timeoutACK: 3 }));
  const line = out.split('\n').find((l) => l.includes('reliability'))!;
  // 8 failures, 0 successes → 8 of 8 attempts failed. (Match the WHOLE token:
  // "100.0% errors" contains "0.0% errors" as a substring.)
  const pct = Number(/([\d.]+)% errors/.exec(line)?.[1]);
  assert.equal(pct, 100, `failures with no successes should read 100%: ${line}`);
  assert.ok(!/█/.test(line), `drew a filled reliability bar on a fully failing link: ${line}`);

  const idle = render(ctrlCtx({ ...NO_ERRORS }));
  const idleLine = idle.split('\n').find((l) => l.includes('reliability'))!;
  assert.ok(/no frames yet/.test(idleLine), `expected an explicit no-data state: ${idleLine}`);
});

test('the counter block names what it actually counts', () => {
  const out = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 10 }));
  // These are host↔stick serial frames, not mesh RF traffic; a bare "TRAFFIC"
  // heading was read as radio activity.
  assert.ok(/host.?stick/i.test(out), `counter block does not say what it counts:\n${out}`);
});

/* ── Heatmap: an area's grade must come from the devices in it ──────────── */

function heatCtx(nodes: ReturnType<typeof mkNode>[], cols = 100, rows = 24, realNoise = true): ScreenCtx {
  const data: DataProvider = { ...mockData({ nodes }), hasRealNoise: () => realNoise };
  return { view: mkView({ screen: 'heatmap', cols, rows }), data, visibleNodes: nodes, filtering: false } as ScreenCtx;
}

const routed = (id: number, area: string, rssi: number) => mkNode({
  nodeId: id, name: `Routed ${id}`, area, status: NodeStatus.Alive,
  stats: { ...mkNode().stats, rssi, lwr: { repeaters: [2], rssi, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
});
const direct = (id: number, area: string, rssi: number) => mkNode({
  nodeId: id, name: `Direct ${id}`, area, status: NodeStatus.Alive,
  stats: { ...mkNode().stats, rssi, lwr: { repeaters: [], rssi, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
});

test('a routed node does not grade its area — the denominator says so', () => {
  // A strong last-hop reading belongs to the repeater. If it graded the area,
  // a room full of weakly-heard devices would read as excellent.
  const rows = renderHeatmap(heatCtx([
    direct(10, 'kitchen', -90), // genuinely weak, the only real reading
    routed(11, 'kitchen', -40), // repeater's strong link — must not count
    routed(12, 'kitchen', -40),
  ])).map(strip);
  const line = rows.find((r) => r.includes('kitchen'));
  assert.ok(line, 'area row missing');
  assert.ok(/1\/3n/.test(line), `denominator should show 1 of 3 graded: ${line}`);
  // -90 against the -95 floor is a +5 dB margin: the area's worst, and its
  // grade. The routed nodes' -40 dBm would be +55 dB — a value that CAN appear
  // if the filter regresses, so this assertion has teeth in both directions.
  assert.ok(/\+5dB/.test(line), `area graded on the repeater's link, not its devices: ${line}`);
  assert.ok(!/\+55dB/.test(line), `the repeater's last-hop reading graded the area: ${line}`);
  assert.ok(!/Routed/.test(line), `a routed node was named as the area's worst: ${line}`);
});

test('an area with only routed nodes is ungraded, not silently healthy', () => {
  const rows = renderHeatmap(heatCtx([routed(20, 'patio', -40)])).map(strip);
  const line = rows.find((r) => r.includes('patio'))!;
  assert.ok(/0\/1n/.test(line), `expected 0 of 1 graded: ${line}`);
  assert.ok(/—/.test(line), `expected an explicit no-reading marker: ${line}`);
});

test('an all-dead area sorts to the TOP, not below every healthy one', () => {
  const dead = mkNode({
    nodeId: 30, name: 'Dead One', area: 'utility',
    status: NodeStatus.Dead, statusLabel: 'dead',
  });
  const rows = renderHeatmap(heatCtx([direct(31, 'kitchen', -60), dead])).map(strip);
  const iUtility = rows.findIndex((r) => r.includes('utility'));
  const iKitchen = rows.findIndex((r) => r.includes('kitchen'));
  assert.ok(iUtility >= 0 && iKitchen >= 0, 'both areas must render');
  // An all-dead area has no margin to sort on; `?? Infinity` used to bury the
  // most alarming row on the map underneath every healthy one.
  assert.ok(iUtility < iKitchen, 'an all-dead area was sorted below a healthy one');
});

test('a Dead node renders the ✕ mark, distinct from every other state', () => {
  const nodes = [
    mkNode({ nodeId: 40, area: 'utility', status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 41, area: 'attic', status: NodeStatus.Unknown, statusLabel: 'unknown' }),
    mkNode({ nodeId: 42, area: 'porch', status: NodeStatus.Asleep, statusLabel: 'asleep' }),
    routed(43, 'shed', -60),
  ];
  const rows = renderHeatmap(heatCtx(nodes, 120, 30)).map(strip);
  const cellOf = (area: string): string => {
    const line = rows.find((r) => r.includes(area));
    assert.ok(line, `${area} row missing`);
    // The heat cell sits immediately after the padded 16-column label.
    return line.slice(17).trim()[0];
  };
  const marks = { dead: cellOf('utility'), unknown: cellOf('attic'), asleep: cellOf('porch'), routed: cellOf('shed') };
  assert.equal(marks.dead, '✕', `dead cell wrong: ${JSON.stringify(marks)}`);
  assert.equal(marks.unknown, '○', `unknown cell wrong: ${JSON.stringify(marks)}`);
  assert.equal(marks.routed, '▒', `routed cell wrong: ${JSON.stringify(marks)}`);
  assert.equal(new Set(Object.values(marks)).size, 4, `two states share a cell mark: ${JSON.stringify(marks)}`);
});

test('an area where nothing answers stays at the top even with an Unknown node', () => {
  // The dead/unknown split narrowed the flag the all-unreachable sort keys on,
  // so ONE Unknown node in a dead area sank it below every healthy area — the
  // exact burial the sort exists to prevent. A single-Dead-node fixture cannot
  // see this: deadCount === nodeCount holds trivially.
  const nodes = [
    direct(50, 'kitchen', -60),
    mkNode({ nodeId: 51, area: 'utility', status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 52, area: 'utility', status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 53, area: 'utility', status: NodeStatus.Unknown, statusLabel: 'unknown' }),
  ];
  const rows = renderHeatmap(heatCtx(nodes, 120, 30)).map(strip);
  const iUtility = rows.findIndex((r) => r.includes('utility'));
  const iKitchen = rows.findIndex((r) => r.includes('kitchen'));
  assert.ok(iUtility >= 0 && iKitchen >= 0, 'both areas must render');
  assert.ok(iUtility < iKitchen,
    'a dead area with one Unknown node sorted below a healthy one');
});

test('dead marks survive cell overflow instead of being dropped first', () => {
  // Cells truncate from the TAIL. Dead/Unknown carry no margin, so ranking on
  // margin alone sank them to the end — the ✕ marks were the first thing
  // discarded and a room with dead devices rendered as solid green.
  const many = [
    ...Array.from({ length: 30 }, (_, i) => direct(100 + i, 'hall', -55)),
    mkNode({ nodeId: 200, area: 'hall', status: NodeStatus.Dead, statusLabel: 'dead' }),
  ];
  const rows = renderHeatmap(heatCtx(many, 80, 24)).map(strip);
  const line = rows.find((r) => r.includes('hall'))!;
  assert.ok(line.includes('+'), 'fixture did not overflow the cell strip');
  assert.ok(line.includes('✕'), `the dead mark was truncated away: ${line}`);
});

test('Unknown is marked apart from Dead', () => {
  const unknown = mkNode({
    nodeId: 40, name: 'Never Seen', area: 'attic',
    status: NodeStatus.Unknown, statusLabel: 'unknown',
  });
  const rows = renderHeatmap(heatCtx([unknown])).map(strip);
  const line = rows.find((r) => r.includes('attic'))!;
  // Unknown means "not yet contacted", and is also the fallback when HA omits a
  // status — painting it ✕ asserts an unreachable node on no evidence.
  assert.ok(line.includes('○'), `unknown node should carry its own mark: ${line}`);
  assert.ok(!line.includes('✕'), `unknown node marked as dead: ${line}`);
});

test('the heat legend explains every glyph it can afford to', () => {
  const KEYS = ['no reading', 'via repeater', 'unknown', 'dead'];
  let prevCount = -1;
  for (let cols = 60; cols <= 160; cols++) {
    const rows = renderHeatmap(heatCtx([direct(50, 'den', -60)], cols)).map(strip);
    const legend = rows.find((r) => r.includes('margin '));
    assert.ok(legend, `legend missing at cols=${cols}`);
    assert.ok(legend.length <= cols, `legend overflows at cols=${cols}`);

    // Whole keys only — no exemptions. A clipped "via repeat" or "dea" leaves a
    // glyph on the map with a half-word next to it.
    const present = KEYS.filter((k) => legend.includes(k));
    for (const k of KEYS) {
      const stem = k.slice(0, Math.max(3, k.length - 2));
      if (legend.includes(stem)) {
        assert.ok(legend.includes(k), `legend key cut mid-word at cols=${cols}: ${legend}`);
      }
    }
    // It must show SOMETHING, and never fewer keys as the terminal gets wider.
    assert.ok(present.length >= 1, `legend showed no keys at all at cols=${cols}: ${legend}`);
    assert.ok(present.length >= prevCount, `legend lost a key going wider at cols=${cols}`);
    prevCount = present.length;

    // At the stock 80-column terminal every key must fit — the search used to
    // prefer a wide ramp and drop "✕ dead", leaving the map's most alarming
    // mark unexplained with columns to spare.
    if (cols >= 80) {
      assert.equal(present.length, KEYS.length,
        `only ${present.length}/4 keys at cols=${cols} (${legend.length} used): ${legend}`);
    }
  }
});

test('the legend ramp is coloured by the same bands as the cells', () => {
  // heatCell's DEFAULT colour is gauges.zoneColor (3 bands at 16.5/8.25 dB)
  // while every real cell is drawn with marginColor (4 bands at 17/10/5,
  // including redB). A key coloured by a different function than the map it
  // explains is worse than no key — and redB never appeared in the ramp at all.
  const rows = renderHeatmap(heatCtx([direct(60, 'den', -60)], 140, 24));
  const legend = rows.find((r) => strip(r).includes('margin '))!;
  // Pull the SGR + shade pairs out of the ramp and compare each to the band
  // function the cells use at the margin that ramp position represents.
  // Scope to the RAMP: the '▒ via repeater' key is also a shade glyph and would
  // otherwise be parsed as a ramp cell, shifting every index.
  const rampOnly = legend.slice(0, legend.indexOf('0\u2192'));
  const pairs = [...rampOnly.matchAll(/\x1b\[([0-9;]*)m([░▒▓█])/g)];
  assert.ok(pairs.length >= 4, `no ramp found in the legend: ${strip(legend)}`);
  const codeOf = (fn: (s: string) => string): string => /\x1b\[([0-9;]*)m/.exec(fn('x'))![1];
  const RAMP_MAX = 25; // MARGIN_FULL
  const seen = new Set(pairs.map((m) => m[1]));
  // The most alarming colour on the map must appear in its own key.
  assert.ok(seen.has(codeOf(marginColor(0))), `the critical band is missing from the ramp: ${[...seen]}`);
  // And each drawn cell must match marginColor at its own position.
  pairs.forEach((m, i) => {
    const frac = pairs.length === 1 ? 1 : i / (pairs.length - 1);
    assert.equal(m[1], codeOf(marginColor(frac * RAMP_MAX)),
      `ramp cell ${i} uses a different band function than the map's cells`);
  });
});

test('every glyph the heatmap can draw has a legend key', () => {
  // Legend and renderer must not drift apart: a mark with no key is unreadable.
  const nodes = [
    direct(1, 'a', -60),
    routed(2, 'b', -60),
    mkNode({ nodeId: 3, area: 'c', status: NodeStatus.Unknown, statusLabel: 'unknown' }),
    mkNode({ nodeId: 4, area: 'd', status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 5, area: 'e', status: NodeStatus.Asleep, statusLabel: 'asleep' }),
  ];
  const rows = renderHeatmap(heatCtx(nodes, 140, 30)).map(strip);
  const legend = rows.find((r) => r.includes('margin '))!;
  for (const [glyph, key] of [['·', 'no reading'], ['▒', 'via repeater'], ['○', 'unknown'], ['✕', 'dead']] as const) {
    assert.ok(legend.includes(glyph) && legend.includes(key),
      `legend is missing the ${key} key (${glyph}): ${legend}`);
  }
});

test('an assumed noise floor is disclosed on the heatmap', () => {
  const rows = renderHeatmap(heatCtx([direct(60, 'den', -60)], 120, 24, false)).map(strip);
  const joined = rows.join('\n');
  // Every cell and every grade here is a margin over that floor.
  assert.ok(/assumed/.test(joined), `assumed floor not disclosed:\n${rows.slice(0, 5).join('\n')}`);
  assert.ok(/estimated/.test(joined), `margins not flagged as estimates`);
});

/* ── round-3: the `unknown` accounting, which had NO coverage at all ─────── */

test('NETWORK HEALTH status tallies sum to the node count', () => {
  // The line reads as a partition. Unknown had no bucket, so nodes the
  // controller has never heard from silently vanished from it while a
  // reassuring grey "0 dead" sat beside them.
  const nodes = [
    mkNode({ nodeId: 2, status: NodeStatus.Alive, statusLabel: 'alive' }),
    mkNode({ nodeId: 3, status: NodeStatus.Dead, statusLabel: 'dead' }),
    mkNode({ nodeId: 4, status: NodeStatus.Asleep, statusLabel: 'asleep' }),
    mkNode({ nodeId: 5, status: NodeStatus.Unknown, statusLabel: 'unknown' }),
    mkNode({ nodeId: 6, status: NodeStatus.Unknown, statusLabel: 'unknown' }),
  ];
  const data: DataProvider = { ...mockData({ nodes }), controller: () => mkCtrl(NO_ERRORS) };
  const out = renderController({
    view: mkView({ screen: 'controller', cols: 120, rows: 40 }), data, visibleNodes: nodes, filtering: false,
  } as ScreenCtx).map(strip).join('\n');

  const line = out.split('\n').find((l) => /\balive\b/.test(l) && /\bdead\b/.test(l));
  assert.ok(line, `no status tally line rendered:\n${out}`);
  const total = Number(/nodes\s+(\d+)/.exec(line)?.[1]);
  const parts = ['alive', 'dead', 'asleep', 'unknown']
    .map((k) => Number(new RegExp(`(\\d+)\\s+${k}`).exec(line)?.[1] ?? 0));
  assert.equal(parts.reduce((a, b) => a + b, 0), total,
    `tallies do not sum to the node count: ${line}`);
  assert.ok(/2 unknown/.test(line), `unknown nodes are missing from the partition: ${line}`);
});

test('NETWORK HEALTH link tallies also sum to the node count', () => {
  // Same partition problem one line below: a node whose route has not resolved
  // yet was dropped from direct/routed/LR entirely.
  const withRoute = (id: number, reps: number[]) => mkNode({
    nodeId: id,
    stats: { ...mkNode().stats, lwr: { repeaters: reps, rssi: -60, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const nodes = [
    withRoute(2, []), withRoute(3, [2]),
    mkNode({ nodeId: 4, isLongRange: true }),
    mkNode({ nodeId: 5, stats: { ...mkNode().stats, lwr: null } }), // no route yet
  ];
  const data: DataProvider = { ...mockData({ nodes }), controller: () => mkCtrl(NO_ERRORS) };
  const out = renderController({
    view: mkView({ screen: 'controller', cols: 120, rows: 40 }), data, visibleNodes: nodes, filtering: false,
  } as ScreenCtx).map(strip).join('\n');
  const line = out.split('\n').find((l) => /\bdirect\b/.test(l) && /\brouted\b/.test(l));
  assert.ok(line, `no link tally line rendered:\n${out}`);
  const parts = ['direct', 'routed', 'LR', 'no route']
    .map((k) => Number(new RegExp(`(\\d+)\\s+${k}`).exec(line)?.[1] ?? 0));
  assert.equal(parts.reduce((a, b) => a + b, 0), nodes.length,
    `link tallies do not sum to the node count: ${line}`);
});

test('a counter HA did not report is disclosed, not counted as zero', () => {
  // timeoutCallback is nullable because a missing field must not reject the
  // whole statistics event — but summing null as 0 let the bar claim a rate it
  // cannot actually compute.
  const partial = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 100, timeoutCallback: null }));
  const line = partial.split('\n').find((l) => l.includes('reliability'))!;
  assert.ok(/partial/.test(line), `an unreported counter was silently treated as zero: ${line}`);
  // The counter cell itself must show "no reading", not 0.
  const cbLine = partial.split('\n').find((l) => /tmo cb|timeout cb/.test(l))!;
  assert.ok(/—/.test(cbLine), `a missing counter rendered as a real value: ${cbLine}`);

  const full = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 100, timeoutCallback: 0 }));
  assert.ok(!/partial/.test(full.split('\n').find((l) => l.includes('reliability'))!),
    'a fully-reported link was marked partial');
});

test('each counter cell is wired to its own field', () => {
  // Distinct values, so a mis-wired label (timeout cb was wired to timeoutACK)
  // shows up as a duplicate rather than hiding behind equal numbers.
  const out = render(ctrlCtx({
    messagesTX: 11, messagesRX: 22, messagesDroppedTX: 33, messagesDroppedRX: 44,
    NAK: 55, CAN: 66, timeoutACK: 77, timeoutResponse: 88, timeoutCallback: 99,
  }));
  for (const [label, value] of [
    ['messages TX', '11'], ['messages RX', '22'], ['dropped TX', '33'], ['dropped RX', '44'],
    ['NAK', '55'], ['CAN', '66'], ['timeout ACK', '77'], ['timeout cb', '99'], ['node reply tmo', '88'],
  ] as const) {
    const line = out.split('\n').find((l) => l.includes(label));
    assert.ok(line, `counter cell "${label}" is missing:\n${out}`);
    const seen = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)`).exec(line)?.[1];
    assert.equal(seen, value, `"${label}" is wired to the wrong field (shows ${seen}, expected ${value})`);
  }
});

test('counter labels stay distinguishable at the narrow floor', () => {
  // lr() protects the VALUE and shortens the label, which at 60 columns clipped
  // "messages TX"/"messages RX" to two cells both reading "messages".
  for (const cols of [60, 70, 80, 100]) {
    const out = render(ctrlCtx({ ...NO_ERRORS, messagesTX: 1_234_567, messagesRX: 987_654 }, cols));
    const line = out.split('\n').find((l) => /msgs TX|messages TX/.test(l))!;
    assert.ok(/TX/.test(line) && /RX/.test(line),
      `TX/RX disambiguator clipped away at cols=${cols}: ${line}`);
    const labels = line.match(/[a-z]+ [TR]X/gi) ?? [];
    assert.equal(new Set(labels).size, labels.length,
      `two counter cells share a label at cols=${cols}: ${line}`);
  }
});

/* ── round-3: heatmap area tiers, at the boundaries the old fixture missed ── */

test('an area with dead nodes stays on top whatever else is in it', () => {
  // The predicate has now been keyed too narrowly twice — on `dead`, then on
  // `dead || unknown`. Each time ONE node of an unanticipated kind sank the
  // mesh's only dead room to the bottom of a map labelled "sorted worst-first".
  const dead = (id: number, area: string) =>
    mkNode({ nodeId: id, area, status: NodeStatus.Dead, statusLabel: 'dead' });
  const others: [string, ReturnType<typeof mkNode>][] = [
    ['asleep', mkNode({ nodeId: 90, area: 'utility', status: NodeStatus.Asleep, statusLabel: 'asleep' })],
    ['unknown', mkNode({ nodeId: 91, area: 'utility', status: NodeStatus.Unknown, statusLabel: 'unknown' })],
    ['routed', routed(92, 'utility', -40)],
    ['healthy', direct(93, 'utility', -55)],
  ];
  for (const [what, extra] of others) {
    const nodes = [direct(80, 'kitchen', -60), dead(81, 'utility'), dead(82, 'utility'), extra];
    const rows = renderHeatmap(heatCtx(nodes, 120, 30)).map(strip);
    const iU = rows.findIndex((r) => r.includes('utility'));
    const iK = rows.findIndex((r) => r.includes('kitchen'));
    assert.ok(iU >= 0 && iK >= 0, `both areas must render (${what})`);
    assert.ok(iU < iK, `a dead area sank below a healthy one because of one ${what} node`);
  }
});

test('an area that is merely unreadable sorts LAST, not first', () => {
  // The mirror of the rule above: "no reading" must never be confused with
  // "dead", or every asleep room would crowd out the real faults.
  for (const status of [NodeStatus.Asleep, NodeStatus.Unknown]) {
    const nodes = [
      direct(70, 'kitchen', -60),
      mkNode({ nodeId: 71, area: 'attic', status, statusLabel: 'x' }),
    ];
    const rows = renderHeatmap(heatCtx(nodes, 120, 30)).map(strip);
    assert.ok(rows.findIndex((r) => r.includes('attic')) > rows.findIndex((r) => r.includes('kitchen')),
      `an all-${NodeStatus[status]} area was hoisted above a graded one`);
  }
});

test('the legend sheds its LEAST alarming key first', () => {
  // Keys are dropped from the end, so `✕ dead` being last meant the one mark an
  // operator most needs decoded lost its explanation first.
  let lastCount = 5;
  for (let cols = 60; cols <= 90; cols++) {
    const legend = renderHeatmap(heatCtx([direct(50, 'den', -60)], cols)).map(strip)
      .find((r) => r.includes('margin '))!;
    const present = ['dead', 'unknown', 'via repeater', 'no reading'].filter((k) => legend.includes(k));
    // Whatever survives must be a PREFIX of the alarm-ordered list.
    assert.deepEqual(present, ['dead', 'unknown', 'via repeater', 'no reading'].slice(0, present.length),
      `keys shed out of alarm order at cols=${cols}: ${legend}`);
    assert.ok(present.length <= lastCount || cols === 60, 'key count grew then shrank');
    lastCount = Math.max(lastCount, present.length);
    if (present.length > 0) assert.equal(present[0], 'dead', `the dead key was shed first at cols=${cols}`);
  }
});

test('the per-channel noise gauge fills with its own band colour', () => {
  // gauge()'s default zoneColor grades the QUIETNESS fraction on an unrelated
  // ramp, so a noisy channel drew a reassuring bar beside its own red number.
  // -90 dBm discriminates: noiseColor says grey, zoneColor(0.50) says yellow.
  const ctrl = mkCtrl(NO_ERRORS);
  const withBg: ControllerSnapshot = { ...ctrl, backgroundRSSI: [-90, -90] };
  const data: DataProvider = { ...mockData(), controller: () => withBg, hasRealNoise: () => true };
  const out = renderController({
    view: mkView({ screen: 'controller', cols: 120, rows: 40 }), data, visibleNodes: [], filtering: false,
  } as ScreenCtx);
  const line = out.find((r) => /ch\s*0|-90dBm/.test(strip(r)));
  assert.ok(line, `no per-channel gauge rendered:\n${out.map(strip).join('\n')}`);
  const want = /\x1b\[([0-9;]+)m/.exec(noiseColor(-90)('x'))![1];
  const bar = /\x1b\[([0-9;]+)m[█░]/.exec(line);
  assert.ok(bar, `no gauge fill found: ${JSON.stringify(strip(line))}`);
  assert.equal(bar[1], want, 'the gauge fill uses a different band than its own number');
});

test('the weakest cell survives overflow truncation', () => {
  // renderCells() truncates the TAIL, so the intra-rank sort must be ASCENDING
  // (weakest first). It was written descending when the rank tiers were added,
  // which made the `+N` overflow drop exactly the links the sort exists to keep.
  const strong = Array.from({ length: 30 }, (_, i) => direct(100 + i, 'hall', -55));
  const weak = mkNode({
    nodeId: 200, name: 'Weak Link', area: 'hall', status: NodeStatus.Alive,
    stats: { ...mkNode().stats, rssi: -93, lwr: { repeaters: [], rssi: -93, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  });
  const line = renderHeatmap(heatCtx([...strong, weak], 80, 24)).map(strip)
    .find((r) => r.includes('hall'));
  assert.ok(line, 'area row missing');
  assert.ok(/\+\d+/.test(line), 'fixture did not overflow the cell strip');
  // The lightest shade is the weakest reading; it must be at the HEAD of the
  // strip, before the '+N' marker that swallows the tail.
  const cells = line.slice(17).split('+')[0];
  assert.ok(cells.includes('░'), `the weakest cell was truncated away: ${JSON.stringify(line)}`);
  assert.equal(cells.trim()[0], '░', `weakest cell is not first: ${JSON.stringify(cells.slice(0, 12))}`);
});

test('a controller WITH a SIS never renders identically to one WITHOUT', () => {
  // grid2 hard-truncates each half; at the 60-column floor the SIS term fell
  // off entirely, so all four role combinations collapsed to two lines.
  for (const cols of [60, 66, 72, 80, 120]) {
    const seen = new Map<string, string>();
    for (const isSUC of [true, false]) {
      for (const isSISPresent of [true, false]) {
        const ctrl: ControllerSnapshot = { ...mkCtrl(NO_ERRORS), isPrimary: true, isSUC, isSISPresent };
        const data: DataProvider = { ...mockData(), controller: () => ctrl };
        const line = renderController({
          view: mkView({ screen: 'controller', cols, rows: 40 }), data, visibleNodes: [], filtering: false,
        } as ScreenCtx).map(strip).find((r) => r.includes('Roles'));
        assert.ok(line, `no Roles line at cols=${cols}`);
        const key = line.trim();
        const prev = seen.get(key);
        assert.ok(prev == null,
          `at ${cols} cols, SUC=${isSUC}/SIS=${isSISPresent} renders identically to ${prev}: ${key}`);
        seen.set(key, `SUC=${isSUC}/SIS=${isSISPresent}`);
      }
    }
  }
});

test('the heatmap does not label its own population with the Overview’s name', () => {
  // The map excludes the controller; the Overview's NODES includes it. Showing
  // a smaller number under the same label reads as a discrepancy in the data.
  const rows = renderHeatmap(heatCtx([direct(10, 'den', -60)], 120, 24)).map(strip);
  const strip3 = rows.find((r) => /AREAS/.test(r));
  assert.ok(strip3, 'no telemetry strip');
  assert.ok(/DEVICES/.test(strip3), `heatmap still labels its count NODES: ${strip3}`);
  assert.ok(!/\bNODES\b/.test(strip3), `heatmap reuses the Overview's NODES label: ${strip3}`);
});

test('heatmap: surplus rows expand areas into their real DEVICES, never into padding', () => {
  // The map is structurally one row per AREA, so 38 devices collapsed into ~8
  // rows and a tall frame went mostly blank (measured 4% ink / 54 blank rows at
  // 200x60). Surplus rows now name the devices behind each grade, weakest
  // first — data groupByArea already computes and used to discard.
  const AREAS = ['kitchen', 'garage', 'hallway', 'office'];
  const nodes = Array.from({ length: 21 }, (_, i) => mkNode({
    nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0,
    area: AREAS[i % AREAS.length],
    stats: { ...mkNode().stats, rssi: -60 - (i % 25) } as never,
  }));
  const ctx = (cols: number, rows: number): ScreenCtx => ({
    view: mkView({ screen: 'heatmap', cols, rows }), data: mockData({ nodes }),
    visibleNodes: nodes, filtering: false,
  } as ScreenCtx);
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  // Tall frame: device rows appear, and every one names a REAL node.
  const tall = renderHeatmap(ctx(200, 60));
  assert.equal(tall.length, 60, 'exact-rows contract broken');
  const deviceRows = tall.map(strip).filter((r) => /^\s{4}\S\s+(\+|-|\s)?\d+dB|^\s{4}·\s+dead/.test(r));
  assert.ok(deviceRows.length > 0, 'no device rows drawn despite ~47 surplus rows');
  for (const r of deviceRows) {
    assert.match(r, /Device \d+/, `a device row named no real node: ${JSON.stringify(r)}`);
  }
  for (const line of tall) {
    assert.ok(strip(line).length <= 200, `row overflowed 200 cols: ${JSON.stringify(strip(line).slice(0, 50))}`);
  }

  // Short frame: NO expansion — the area strips must not lose rows to devices.
  const short = renderHeatmap(ctx(80, 24));
  assert.equal(short.length, 24);
  const shortAreas = short.map(strip).filter((r) => AREAS.some((a) => r.startsWith(a)));
  const tallAreas = tall.map(strip).filter((r) => AREAS.some((a) => r.startsWith(a)));
  assert.equal(shortAreas.length, tallAreas.length,
    'expansion cost the map one of its area strips');
});

test('heatmap expansion budgets its "+N more" row — no false "enlarge the terminal"', () => {
  // expandArea emits ONE MORE row than its budget whenever it discloses a
  // remainder. Budgeting only the device rows over-spent the surplus by one row
  // per area, so the body overran the frame, chrome's overflow note replaced the
  // last rows, and at 80x24 whole AREA STRIPS vanished while the telemetry still
  // claimed all of them — misdirecting the operator to enlarge a terminal that
  // had fit the map a release earlier.
  const AREAS = ['kitchen', 'garage', 'hallway', 'office', 'patio', 'attic'];
  const nodes = Array.from({ length: 37 }, (_, i) => mkNode({
    nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0,
    area: AREAS[i % AREAS.length],
    stats: { ...mkNode().stats, rssi: -60 - (i % 25) } as never,
  }));
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  for (const [cols, rows] of [[60, 16], [80, 24], [80, 40], [100, 30], [120, 40], [200, 60]] as [number, number][]) {
    const out = renderHeatmap({
      view: mkView({ screen: 'heatmap', cols, rows }), data: mockData({ nodes }),
      visibleNodes: nodes, filtering: false,
    } as ScreenCtx);
    assert.equal(out.length, rows, `${cols}x${rows} broke the exact-rows contract`);
    const overflowed = out.some((l) => /more lines hidden|enlarge the terminal/.test(strip(l)));
    assert.equal(overflowed, false,
      `${cols}x${rows} printed the overflow note — the expansion over-spent its budget`);
    // Every area must still have its strip: the map may not trade an area for
    // device detail.
    const strips = AREAS.filter((a) => out.some((l) => strip(l).startsWith(a))).length;
    assert.equal(strips, AREAS.length, `${cols}x${rows} lost ${AREAS.length - strips} area strip(s)`);
  }
});

test('controller: spare rows draw REAL unused data, and never on a short frame', () => {
  // The screen read only controller() / nodes() / scoreFor(). Two things it
  // always had access to and never drew answer questions its lifetime counters
  // cannot: interference().serial gives per-hour RATES (a lifetime "63 reply
  // timeouts" cannot say whether the link is failing NOW), and the engine's
  // network-scoped symptoms are exactly the ones a per-node screen can't show.
  const nodes = Array.from({ length: 12 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const data = mockData({ nodes }) as never as Record<string, unknown>;
  data.controller = () => mkCtrl(NO_ERRORS);
  data.interference = () => ({
    noise: { channels: [null, null, null, null], floor: null, real: false, trend: [], trendCoarse: [], trendCoarseDays: 0, band: 'unknown' },
    serial: { nakPerH: 0.4, canPerH: 3.2, tmoAckPerH: 0.1, tmoRespPerH: 4.8, band: 'healthy', spanH: 36 },
    diurnal: [], coverageDays: 0, correlated: { active: false, degradedNodes: 0, narrative: '' },
  });
  data.symptoms = () => [{
    kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: Date.now() - 9e5,
    basis: 'inferred', evidence: [], narrative: 'Many nodes degraded together with no serial cause.',
  }];
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const render = (cols: number, rows: number): string[] => renderController({
    view: mkView({ screen: 'controller', cols, rows }), data: data as never,
    visibleNodes: nodes, filtering: false,
  } as ScreenCtx);

  const tall = render(200, 60).map(strip).join('\n');
  assert.match(tall, /RECENT RATES/, 'per-hour serial rates were not drawn on a tall frame');
  assert.match(tall, /4\.8/, 'the reply-timeout RATE value is missing');
  assert.match(tall, /ACTIVE MESH EVENTS/, 'mesh-scoped symptoms were not drawn');
  assert.match(tall, /mesh-interference/, 'the open mesh symptom is not named');

  // A short frame must be untouched — these blocks are surplus-funded.
  const small = render(80, 24);
  assert.equal(small.length, 24);
  const smallTxt = small.map(strip).join('\n');
  assert.doesNotMatch(smallTxt, /RECENT RATES|ACTIVE MESH EVENTS/,
    'a surplus-only block appeared on an 80x24 frame');
  // Contrast at the SAME width so only the row budget differs — this is what
  // makes the assertion about the surplus gate rather than about width.
  assert.match(render(80, 60).map(strip).join('\n'), /RECENT RATES/,
    'the same 80-col frame with rows to spare must draw the block');
  // …and just BELOW the threshold, at a height where the compact body still
  // fits. At 80x24 the roll-up already overflows, and that truncation would
  // hide an unwanted block instead of proving it was never added.
  const justUnder = render(80, 32).map(strip).join('\n');
  assert.doesNotMatch(justUnder, /RECENT RATES/,
    'the block appeared with no surplus to fund it');
  assert.doesNotMatch(justUnder, /more \(taller terminal/,
    'setup check: 80x32 must fit without overflow, or the assertion above proves nothing');
  // NOT asserted: absence of the "…more (taller terminal)" note. That note is
  // PRE-EXISTING and deliberate — the roll-up genuinely does not fit 24 rows,
  // and the screen discloses it rather than silently dropping the tail. It
  // appears identically on main with these blocks absent, so asserting it away
  // would pin a behaviour this change neither caused nor should fix.
});

test('controller: ACTIVE MESH EVENTS excludes PER-NODE symptoms', () => {
  // Network-scoped symptoms are the ones a per-node screen cannot show; per-node
  // findings belong on REMEDY. Listing both would put one finding in two places
  // with two row budgets, and would make this panel unbounded on a bad mesh.
  const nodes = Array.from({ length: 12 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const data = mockData({ nodes }) as never as Record<string, unknown>;
  data.controller = () => mkCtrl(NO_ERRORS);
  data.symptoms = () => [
    { kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: 1, basis: 'inferred', evidence: [], narrative: 'Mesh-wide event.' },
    { kind: 'return-path-degraded', nodeId: 7, severity: 'warn', sinceMs: 1, basis: 'measured', evidence: [], narrative: 'Node seven reply timeouts.' },
  ];
  const out = renderController({
    view: mkView({ screen: 'controller', cols: 200, rows: 60 }), data: data as never,
    visibleNodes: nodes, filtering: false,
  } as ScreenCtx).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(out, /mesh-interference/, 'the network-scoped symptom is missing');
  assert.doesNotMatch(out, /return-path-degraded/,
    'a PER-NODE symptom leaked into the mesh-scoped panel');
});

test('controller: a healthy mesh reports silence as silence, not a padded panel', () => {
  const nodes = Array.from({ length: 12 }, (_, i) =>
    mkNode({ nodeId: i + 1, name: `Device ${i + 1}`, isController: i === 0 }));
  const data = mockData({ nodes }) as never as Record<string, unknown>;
  data.controller = () => mkCtrl(NO_ERRORS);
  data.symptoms = () => []; // healthy
  const out = renderController({
    view: mkView({ screen: 'controller', cols: 200, rows: 60 }), data: data as never,
    visibleNodes: nodes, filtering: false,
  } as ScreenCtx).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(out, /no mesh-scoped symptoms open/,
    'an empty symptom set must say so in one line rather than render an empty panel');
});
