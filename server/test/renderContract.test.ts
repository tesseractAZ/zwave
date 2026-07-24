/**
 * The whole-TUI render contract, swept rather than spot-checked.
 *
 * Every screen promises to return EXACTLY `view.rows` lines, each at most
 * `view.cols` visible columns, for any terminal the session will accept — and
 * to keep that promise while empty, while filtering, and at sizes no real
 * terminal would use. Individual screen tests each cover their own happy path;
 * this file is the cross-cutting sweep that catches a shared-chrome change
 * breaking a screen nobody thought to re-test.
 *
 * It also pins two invariants that are easy to violate silently:
 *   • the selected Overview row is inverse-video and must contain NO embedded
 *     SGR (an inner RESET would tear the highlight bar mid-row);
 *   • the Remedy cursor window must terminate and always keep the cursor on
 *     screen, because that cursor selects the ACTION TARGET.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { visLen } from '../src/telnet/ansi';
import { renderOverview } from '../src/telnet/screens/overview';
import { renderDetail } from '../src/telnet/screens/detail';
import { renderTopology } from '../src/telnet/screens/topology';
import { renderHeatmap } from '../src/telnet/screens/heatmap';
import { renderController } from '../src/telnet/screens/controller';
import { renderRemedy } from '../src/telnet/screens/remedy';
import { NodeStatus } from '../src/types';
import type { ControllerSnapshot, ScreenCtx, ViewState } from '../src/types';
import { mkNode, mkView, mockData } from './_logHelpers';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const CTRL: ControllerSnapshot = {
  homeId: 1, nodeId: 1, sdkVersion: '7.19', firmwareVersion: '1.0', rfRegion: 'USA',
  isPrimary: true, isSUC: true, isSISPresent: true, manufacturer: 'Zooz', model: 'ZST39',
  isRebuildingRoutes: false, rebuildStartedAt: null, firmwareUpdatesAvailable: 0,
  backgroundRSSI: [],
  statistics: {
    messagesTX: 5, messagesRX: 5, messagesDroppedTX: 0, messagesDroppedRX: 0,
    NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0, timeoutCallback: 0
  },
};

// One node of every status, plus a routed one — the states whose rendering
// diverges (dead greys its RF cells, unknown gets its own mark, routed is
// neutral because its RSSI belongs to a repeater).
const NODES = [
  mkNode({ nodeId: 3, name: 'Alive Node' }),
  mkNode({ nodeId: 9, name: 'Dead Node', status: NodeStatus.Dead, statusLabel: 'dead' }),
  mkNode({ nodeId: 11, name: 'Unknown Node', status: NodeStatus.Unknown, statusLabel: 'unknown' }),
  mkNode({ nodeId: 12, name: 'Asleep Node', status: NodeStatus.Asleep, statusLabel: 'asleep' }),
  mkNode({
    nodeId: 13, name: 'Routed Node',
    stats: { ...mkNode().stats, lwr: { repeaters: [3], rssi: -70, protocolDataRate: 3, repeaterRSSI: [], routeFailedBetween: null } },
  }),
];

const SCREENS: [ViewState['screen'], (ctx: ScreenCtx) => string[]][] = [
  ['overview', renderOverview],
  ['detail', renderDetail],
  ['topology', renderTopology],
  ['heatmap', renderHeatmap],
  ['controller', renderController],
  ['remedy', renderRemedy],
];

// Includes 1 and 2 columns (absurd, but the contract is unconditional), the
// documented 60x16 floor and its neighbours, the 80-col default, and 400 wide.
const COLS = [1, 2, 5, 10, 20, 24, 40, 59, 60, 61, 79, 80, 104, 140, 200, 400];
const ROWS = [1, 2, 3, 5, 6, 8, 16, 22, 24, 50];

test('every screen holds the exact-rows / max-cols contract at any size', () => {
  let checked = 0;
  for (const [screen, render] of SCREENS) {
    for (const cols of COLS) {
      for (const rows of ROWS) {
        for (const filtering of [false, true]) {
          for (const empty of [false, true]) {
            const nodes = empty ? [] : NODES;
            const data = { ...mockData({ nodes }), controller: () => CTRL };
            const view = mkView({ screen, cols, rows, filter: filtering ? 'zz' : '', selected: 1 });
            const ctx = { view, data, visibleNodes: nodes, filtering, actionsEnabled: false } as ScreenCtx;
            checked++;

            const out = render(ctx);
            assert.equal(out.length, rows,
              `${screen} returned ${out.length} lines at ${cols}x${rows} (filtering=${filtering}, empty=${empty})`);
            for (const line of out) {
              assert.ok(visLen(line) <= cols,
                `${screen} line is ${visLen(line)} wide at cols=${cols}: ${JSON.stringify(strip(line).slice(0, 80))}`);
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 3000, `sweep degenerated to ${checked} cases`);
});

test('the selected Overview row carries no SGR inside the inverse-video span', () => {
  const nodes = Array.from({ length: 6 }, (_, i) => mkNode({ nodeId: i + 3, name: `Node ${i}` }));
  for (const cols of [60, 80, 104, 140, 200]) {
    for (const selected of [0, 3, 5]) {
      const view = mkView({ screen: 'overview', cols, rows: 24, selected });
      const rows = renderOverview({ view, data: mockData({ nodes }), visibleNodes: nodes, filtering: false } as ScreenCtx);
      const row = rows.find((r) => r.includes('\x1b[7m'));
      assert.ok(row, `no inverse-video row at cols=${cols}, selected=${selected}`);
      const inner = row.slice(row.indexOf('\x1b[7m') + 4);
      const end = inner.indexOf('\x1b[0m');
      const body = end >= 0 ? inner.slice(0, end) : inner;
      // An embedded SGR/RESET terminates the highlight early, tearing the bar.
      assert.ok(!/\x1b\[/.test(body),
        `SGR inside the invert at cols=${cols}, selected=${selected}: ${JSON.stringify(body.slice(0, 80))}`);
    }
  }
});

test('the Remedy cursor window terminates and always keeps the cursor visible', () => {
  const syms = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`, kind: 'dead-flap', severity: 'crit', nodeId: i + 1, sinceMs: 1000 - i,
    basis: 'measured', evidence: [], narrative: 'n', subsumedBy: null,
  })) as never[];
  const data = { ...mockData({ nodes: NODES }), symptoms: () => syms };

  for (const rows of [8, 12, 16, 24, 40]) {
    for (let cursor = 0; cursor < syms.length; cursor++) {
      const view = mkView({ screen: 'remedy', cols: 100, rows, remedyCursor: cursor });
      const out = renderRemedy({ view, data, visibleNodes: NODES, filtering: false, actionsEnabled: false } as ScreenCtx);
      // The cursor selects the ACTION TARGET, so a card off screen would mean
      // `a`/`p` acting on something the operator cannot see.
      assert.ok(out.map(strip).join('\n').includes('▶'),
        `cursor ${cursor} scrolled off screen at rows=${rows}`);
      assert.equal(view.remedyCursor, cursor, 'renderer moved the cursor it was asked to show');
    }
  }
});
