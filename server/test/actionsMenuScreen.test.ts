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
          // BOTH scopes: the network menu has a different header and a much
          // shorter item list, so the device sweep alone would not exercise it.
          for (const scope of ['device', 'network'] as const) {
          const items = buildMenu({ scope, hasNode, rebuilding });
          for (const index of [0, Math.floor(items.length / 2), items.length - 1]) {
            const lines = renderActionsMenu(view(cols, rows), {
              scope,
              items,
              index,
              targetLabel: hasNode ? '#16 A Very Long Node Name That Should Truncate Cleanly' : null,
              locked,
            });
            assertContract(lines, cols, rows, `menu ${scope} ${cols}x${rows} rb=${rebuilding} node=${hasNode} lock=${locked} i=${index}`);
          }
          }
        }
      }
    }
  }
});

test('the menu header always states its blast radius, at every width', () => {
  // A menu that does not say what it will touch is the defect the scope split
  // exists to remove — and the header is the first thing truncation eats.
  for (const [cols, rows] of SIZES) {
    const dev = renderActionsMenu(view(cols, rows), {
      scope: 'device', items: buildMenu({ scope: 'device', hasNode: true, rebuilding: false }),
      index: 0, targetLabel: '#16 Kitchen', locked: false,
    }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    const net = renderActionsMenu(view(cols, rows), {
      scope: 'network', items: buildMenu({ scope: 'network', hasNode: false, rebuilding: false }),
      index: 0, targetLabel: null, locked: false,
    }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

    // At the supported floor and above, each menu must be identifiable.
    if (cols >= 40) {
      assert.ok(/DEVICE/.test(dev), `device menu unidentifiable at ${cols}: ${dev.split('\n')[0]}`);
      assert.ok(/NETWORK/.test(net), `network menu unidentifiable at ${cols}: ${net.split('\n')[0]}`);
    }
    // The network menu must NEVER imply a single-device target, at any width.
    // Match the WORD, not "target #" — an empty label still renders "· target ",
    // which reads as a target the operator cannot see.
    assert.ok(!/target/.test(net), `network menu implied a device target at ${cols}: ${net.split('\n')[0]}`);
    assert.ok(/whole mesh/.test(net) || cols < 30, `network menu did not state its scope at ${cols}`);

    // A DEVICE menu with no node must SAY so — rendering a bare "· target "
    // with nothing after it reads as a target the operator cannot make out.
    const noNode = renderActionsMenu(view(cols, rows), {
      scope: 'device', items: buildMenu({ scope: 'device', hasNode: false, rebuilding: false }),
      index: 0, targetLabel: null, locked: false,
    }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    if (cols >= 40) {
      assert.ok(/no node selected/.test(noNode),
        `device menu with no node did not say so at ${cols}: ${noNode.split('\n')[0]}`);
    }
    assert.ok(!/target\s*$/m.test(noNode.split('\n')[0]),
      `device menu rendered an empty target label at ${cols}`);
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
  const items = [...buildMenu({ scope: 'device', hasNode: true, rebuilding: false }), ...buildEntityRows(manyEntities), ...buildConfigRows(manyParams)];
  for (const [cols, rows] of SIZES) {
    for (const index of [0, 6, Math.floor(items.length / 2), items.length - 1]) {
      const lines = renderActionsMenu(view(cols, rows), { scope: 'device', items, index, targetLabel: '#16 Kitchen', locked: false });
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

test('renderParamEdit keeps the footer visible for a many-option enum on the 60x16 minimum terminal', () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ value: i, label: `Option number ${i}` }));
  const lines = renderParamEdit(view(60, 16), { label: 'Big Enum', current: '0', isEnum: true, options, optionIndex: 6, error: null });
  const text = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')).join('\n');
  assert.match(text, /continue/, 'the ⏎ continue footer is not clipped off a short terminal');
});
