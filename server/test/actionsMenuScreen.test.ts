import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActionsMenu, renderTypeConfirm, renderParamEdit } from '../src/telnet/screens/actionsMenu';
import { buildMenu, buildEntityRows, buildConfigRows } from '../src/telnet/actionsCatalog';
import type { ConfigParam, EntityLiveState } from '../src/types';
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

/* ── v0.23: a long menu (device controls + config) + the value picker ─────── */

const manyEntities: EntityLiveState[] = Array.from({ length: 6 }, (_, i) =>
  ({ entityId: `light.l${i}`, domain: 'light', name: `Light Number ${i}`, state: i % 2 ? 'on' : 'off', attrs: {} }));
const manyParams: ConfigParam[] = Array.from({ length: 8 }, (_, i) =>
  ({ key: `5-112-0-${i}`, label: `Parameter ${i}`, value: i, valueLabel: null, unit: null, writeable: true, min: 0, max: 99, property: i, propertyKey: null, endpoint: 0, states: null }));

test('renderActionsMenu holds the contract with a LONG menu (control + config rows) at every size + cursor', () => {
  const items = [...buildMenu({ hasNode: true, rebuilding: false }), ...buildEntityRows(manyEntities), ...buildConfigRows(manyParams)];
  for (const [cols, rows] of SIZES) {
    for (const index of [0, 6, Math.floor(items.length / 2), items.length - 1]) {
      const lines = renderActionsMenu(view(cols, rows), { items, index, targetLabel: '#16 Kitchen', locked: false });
      assertContract(lines, cols, rows, `long-menu ${cols}x${rows} i=${index}`);
    }
  }
});

test('renderParamEdit honours the contract for enum + numeric modes', () => {
  for (const [cols, rows] of SIZES) {
    const enumOpts = { label: 'LED Indicator', current: '2 (Always off)', isEnum: true, options: [{ value: 0, label: 'On when off' }, { value: 1, label: 'On when on' }, { value: 2, label: 'Always off' }], optionIndex: 2, error: null };
    assertContract(renderParamEdit(view(cols, rows), enumOpts), cols, rows, `paramEdit enum ${cols}x${rows}`);
    const numOpts = { label: 'Ramp Rate', current: '20 ms', isEnum: false, draft: '4', min: 0, max: 99, unit: 'ms', error: 'above the maximum (99)' };
    assertContract(renderParamEdit(view(cols, rows), numOpts), cols, rows, `paramEdit num ${cols}x${rows}`);
  }
});
