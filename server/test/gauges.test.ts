import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparkline, brailleSparkline, signalBars, meter, gauge, heatCell, vblock, zoneColor } from '../src/telnet/gauges';
import { visLen } from '../src/telnet/ansi';

const W = (s: string) => visLen(s); // visible width, ANSI-stripped

test('sparkline is exactly `width` cells for empty / partial / full / over data', () => {
  for (const width of [1, 4, 8, 20]) {
    assert.equal(W(sparkline([], width)), width, `empty w=${width}`);
    assert.equal(W(sparkline([5], width)), width, `single w=${width}`);
    assert.equal(W(sparkline([1, 2, 3], width)), width, `partial w=${width}`);
    assert.equal(W(sparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], width)), width, `over w=${width}`);
  }
});

test('sparkline maps min→lowest and max→highest block', () => {
  const s = sparkline([0, 100], 2, { min: 0, max: 100 }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(s[0], '▁');
  assert.equal(s[1], '█');
});

test('brailleSparkline is exactly `width` cells', () => {
  for (const width of [1, 4, 10]) {
    assert.equal(W(brailleSparkline([], width)), width);
    assert.equal(W(brailleSparkline([1, 2, 3, 4, 5], width)), width);
    assert.equal(W(brailleSparkline([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], width)), width);
  }
});

test('signalBars width equals bar count; lit count tracks fraction', () => {
  assert.equal(W(signalBars(0.5)), 4);
  assert.equal(W(signalBars(1, 6)), 6);
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  // 4 bars, frac 0 → all dim (grey), frac 1 → all lit; check glyph set is stable width
  assert.equal(strip(signalBars(0)).length, 4);
  assert.equal(strip(signalBars(1)).length, 4);
});

test('meter width == width and fill tracks fraction', () => {
  assert.equal(W(meter(0.5, 10)), 10);
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal((strip(meter(0, 10)).match(/█/g) ?? []).length, 0);
  assert.equal((strip(meter(1, 10)).match(/█/g) ?? []).length, 10);
  assert.equal((strip(meter(0.5, 10)).match(/█/g) ?? []).length, 5);
});

test('meter clamps out-of-range fractions', () => {
  assert.equal(W(meter(-1, 8)), 8);
  assert.equal(W(meter(5, 8)), 8);
});

test('gauge width == barWidth + brackets + space + label', () => {
  assert.equal(W(gauge(0.79, 8, '79')), 8 + 3 + 2); // [ + bar + ] + space + "79"
  assert.equal(W(gauge(1, 5, '100%')), 5 + 3 + 4);
});

test('heatCell and vblock are single cells', () => {
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(W(heatCell(f)), 1);
    assert.equal(W(vblock(f)), 1);
  }
  assert.equal(W(heatCell(0, { none: true })), 1);
});

test('non-finite inputs never break the width contract (NaN/Infinity)', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(W(meter(bad, 10)), 10, `meter(${bad})`);
    assert.equal(W(gauge(bad, 8, 'x')), 8 + 3 + 1, `gauge(${bad})`);
    assert.equal(W(heatCell(bad)), 1, `heatCell(${bad})`);
    assert.equal(W(vblock(bad)), 1, `vblock(${bad})`);
    assert.equal(W(signalBars(bad)), 4, `signalBars(${bad})`);
    assert.equal(W(sparkline([bad, bad], 6)), 6, `sparkline(${bad})`);
  }
  // no literal "undefined" must leak into any gauge
  for (const s of [meter(NaN, 8), heatCell(NaN), signalBars(NaN), signalBars(0.5, 1)]) {
    assert.ok(!s.includes('undefined'), `"${s}" leaked "undefined"`);
  }
});

test('signalBars with degenerate bar counts (0/1) still has the right width', () => {
  assert.equal(W(signalBars(0.5, 1)), 1);
  assert.equal(W(signalBars(1, 1)), 1);
  assert.equal(W(signalBars(0.5, 3)), 3);
});

test('a flat (all-equal) sparkline reads steady (grey), not alarming red', () => {
  const s = sparkline([-50, -50, -50, -50], 4);
  assert.equal(W(s), 4);
  assert.ok(s.includes('90'), 'flat series should be grey (SGR 90), not red'); // c.grey = 90
  assert.ok(!/\x1b\[91m/.test(s), 'flat series must not be red');
});

test('brailleSparkline fills BOTTOM-up (min value lights the bottom dot, not the top)', () => {
  // A single low sample: the lowest level should light dot 7 (bottom, 0x40), not dot 1 (top, 0x01).
  const s = brailleSparkline([0], 1, { min: 0, max: 100 }).replace(/\x1b\[[0-9;]*m/g, '');
  const code = s.codePointAt(0)! - 0x2800;
  assert.ok((code & 0x40) !== 0, 'low value must light the BOTTOM-left dot (0x40)');
  assert.ok((code & 0x01) === 0, 'low value must NOT light the TOP-left dot (0x01)');
});

test('zoneColor is red low / yellow mid / green high (by wrapping color code)', () => {
  const red = zoneColor(0.1)('x');
  const yellow = zoneColor(0.5)('x');
  const green = zoneColor(0.9)('x');
  assert.ok(red.includes('91') || red.includes('31'), 'low → red');
  assert.ok(yellow.includes('93') || yellow.includes('33'), 'mid → yellow');
  assert.ok(green.includes('92') || green.includes('32'), 'high → green');
});
