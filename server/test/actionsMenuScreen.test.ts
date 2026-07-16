import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActionsMenu, renderTypeConfirm } from '../src/telnet/screens/actionsMenu';
import { buildMenu } from '../src/telnet/actionsCatalog';
import { visLen } from '../src/telnet/ansi';
import type { ViewState } from '../src/types';

/** The overlays only read cols/rows off the view; a minimal cast is enough. */
const view = (cols: number, rows: number) => ({ cols, rows }) as ViewState;
const SIZES: [number, number][] = [
  [40, 12], // narrow
  [80, 24],
  [100, 30],
  [160, 46], // wide
];

function assertContract(lines: string[], cols: number, rows: number, label: string): void {
  assert.equal(lines.length, rows, `${label}: exactly ${rows} rows (got ${lines.length})`);
  for (let i = 0; i < lines.length; i++) {
    assert.ok(visLen(lines[i]) <= cols, `${label}: row ${i} width ${visLen(lines[i])} > ${cols}`);
    assert.ok(!lines[i].includes('undefined'), `${label}: row ${i} leaked "undefined"`);
  }
}

test('renderActionsMenu honours the width/height contract across sizes + states', () => {
  for (const [cols, rows] of SIZES) {
    for (const rebuilding of [false, true]) {
      for (const hasNode of [false, true]) {
        for (const locked of [false, true]) {
          const items = buildMenu({ hasNode, rebuilding });
          for (const index of [0, Math.floor(items.length / 2), items.length - 1]) {
            const lines = renderActionsMenu(view(cols, rows), {
              items,
              index,
              targetLabel: hasNode ? '#16 A Very Long Node Name That Should Truncate Cleanly' : null,
              locked,
            });
            assertContract(lines, cols, rows, `menu ${cols}x${rows} rb=${rebuilding} node=${hasNode} lock=${locked} i=${index}`);
          }
        }
      }
    }
  }
});

test('renderTypeConfirm honours the contract for every impact + buffer state', () => {
  const impacts = ['safe', 'caution', 'destructive'] as const;
  const buffers = ['', 'CON', 'CONFIRM', 'CONFIRX'];
  for (const [cols, rows] of SIZES) {
    for (const impact of impacts) {
      for (const buffer of buffers) {
        const lines = renderTypeConfirm(view(cols, rows), {
          label: 'Rebuild ALL routes — a deliberately long label to stress truncation',
          target: 'whole mesh (39 nodes)',
          impact,
          desc: 'Rebuild mesh routes for every node in the network.',
          impactNote: 'DISRUPTIVE: the whole mesh recomputes routes and is degraded for many minutes. Battery nodes update on their next wake.',
          buffer,
        });
        assertContract(lines, cols, rows, `confirm ${cols}x${rows} ${impact} buf="${buffer}"`);
      }
    }
  }
});
