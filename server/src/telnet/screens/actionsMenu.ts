/**
 * ACTIONS MENU overlay + type-CONFIRM modal (v0.9).
 *
 * Two modal renderers, both returning exactly `view.rows` lines ≤ `view.cols`
 * (the width/height contract every screen honours):
 *
 *   renderActionsMenu — the full-frame menu. Device actions and system-wide
 *     actions in labelled groups, each row an impact badge + one-line "what it
 *     does". A header names the current target and flags read-only mode; the
 *     highlighted row is the cursor. Purely informational when write actions
 *     are locked — you can still read every impact.
 *
 *   renderTypeConfirm — the deliberate confirm box. Restates the action, its
 *     target, and its impact, then requires the operator to TYPE the word
 *     CONFIRM before it will arm. Anything less cannot execute.
 */

import { c, lr, padEnd, truncate, visLen } from '../ansi';
import type { ViewState } from '../../types';
import type { ActionImpact, MenuGroup, MenuItem } from '../actionsCatalog';
import { CONFIRM_WORD } from '../actionsCatalog';
import { centeredNotice } from './overview';

/* ── impact styling ────────────────────────────────────────────────────── */

function impactColor(impact: ActionImpact): (s: string) => string {
  if (impact === 'destructive') return c.redB;
  if (impact === 'caution') return c.yellow;
  return c.green;
}

function impactBadge(impact: ActionImpact): string {
  const label = impact === 'destructive' ? 'DESTRUCTIVE' : impact === 'caution' ? 'CAUTION' : 'SAFE';
  // Fixed 13-cell field ("[DESTRUCTIVE]") so the description column aligns.
  return impactColor(impact)(padEnd(`[${label}]`, 13));
}

/* ── the menu overlay ──────────────────────────────────────────────────── */

export interface ActionsMenuOpts {
  items: MenuItem[];
  /** Cursor index into `items`. */
  index: number;
  /** Human label for the current device-action target ("#16 Kitchen") or null. */
  targetLabel: string | null;
  /** write_actions_enabled — false = read-only, actions are locked. */
  locked: boolean;
}

const LABEL_W = 28; // action-label column (wide enough for "Turn Off · <entity>" rows)

export function renderActionsMenu(view: ViewState, opts: ActionsMenuOpts): string[] {
  const W = view.cols;
  const H = view.rows;
  const { items, index, targetLabel, locked } = opts;

  const out: string[] = [];

  // Header: title · target on the left, mode badge on the right. Reserve the
  // badge width first so a long target can never truncate the ARMED/READ-ONLY
  // flag off the end on a narrow terminal.
  const title = c.cyanB('ACTIONS');
  const tgt = targetLabel ? c.grey(' · target ') + c.white(targetLabel) : c.grey(' · no node selected');
  const badge = locked ? c.yellowB('READ-ONLY') : c.greenB('ARMED');
  const headerLeft = truncate(title + tgt, Math.max(0, W - visLen(badge) - 1));
  out.push(truncate(lr(headerLeft, badge, W), W));
  out.push(truncate(c.grey('─'.repeat(Math.max(0, W))), W));

  // Body: flatten items into render entries (group headings interleaved), then
  // WINDOW around the cursor so a long menu (device controls + config params can
  // run to dozens of rows) always keeps the highlighted row on screen.
  const bodyCap = Math.max(1, H - 3); // header + rule + footer
  type Entry = { heading: string } | { item: MenuItem; i: number };
  const entries: Entry[] = [];
  let lastGroup: MenuGroup | null = null;
  for (let i = 0; i < items.length; i++) {
    const g = items[i].group;
    if (g !== lastGroup) {
      lastGroup = g;
      entries.push({ heading: groupHeading(g) });
    }
    entries.push({ item: items[i], i });
  }
  // The render-line index of the cursor's item (fallback 0).
  const cursorLine = entries.findIndex((e) => 'item' in e && e.i === index);
  // Slide a bodyCap-tall window so the cursor line stays inside it.
  let start = 0;
  if (cursorLine >= 0 && entries.length > bodyCap) {
    start = Math.min(Math.max(0, cursorLine - Math.floor(bodyCap / 2)), entries.length - bodyCap);
  }
  const windowEntries = entries.slice(start, start + bodyCap);
  for (const e of windowEntries) {
    out.push('heading' in e ? truncate(c.grey(e.heading), W) : truncate(menuRow(e.item, e.i === index, locked, W), W));
  }

  // Pad so the footer lands on the last row.
  while (out.length < H - 1) out.push('');

  // Footer — with a scroll position hint when the menu overflows.
  const key = (k: string, label: string) => c.cyanB(k) + ' ' + c.grey(label);
  const left = [key('↑↓', 'move'), key('⏎', locked ? 'locked' : 'select'), key('Esc', 'close')].join(c.grey(' · '));
  const more = entries.length > bodyCap ? c.cyan(`${start > 0 ? '▲' : ' '}${start + bodyCap < entries.length ? '▼' : ' '} `) : '';
  const right = locked
    ? c.yellow('enable write_actions_enabled to unlock')
    : more + c.grey(`${items.length} action${items.length === 1 ? '' : 's'}`);
  out.push(truncate(lr(left, right, W), W));

  return out.slice(0, H);
}

function menuRow(it: MenuItem, cursor: boolean, locked: boolean, W: number): string {
  const dim = it.disabled || locked;
  const arrow = cursor ? c.cyanB('▶') : ' ';
  const label = (dim ? c.grey : c.white)(padEnd(it.desc.label, LABEL_W));
  const badge = dim ? c.grey(padEnd(`[${badgeWord(it.desc.impact)}]`, 13)) : impactBadge(it.desc.impact);

  // The free-text column takes whatever's left; a disabled reason wins over desc.
  const note = it.disabled && it.reason ? `— ${it.reason}` : it.desc.desc;
  const prefix = `${arrow} ${label} ${badge} `;
  const textW = Math.max(0, W - visLen(prefix));
  return prefix + c.grey(truncate(note, textW));
}

function badgeWord(impact: ActionImpact): string {
  return impact === 'destructive' ? 'DESTRUCTIVE' : impact === 'caution' ? 'CAUTION' : 'SAFE';
}

function groupHeading(g: MenuGroup): string {
  switch (g) {
    case 'maintenance':
      return 'DEVICE ACTIONS';
    case 'control':
      return 'DEVICE CONTROLS';
    case 'config':
      return 'CONFIGURATION';
    case 'system':
      return 'SYSTEM-WIDE';
  }
}

/* ── the config value picker (v0.23) ───────────────────────────────────────── */

export interface ParamEditOpts {
  label: string; // parameter name
  current: string; // current value display ("2 (Always off)")
  isEnum: boolean;
  /** enum mode: selectable options + the cursor over them. */
  options?: Array<{ value: number; label: string }>;
  optionIndex?: number;
  /** numeric mode: typed digits + bounds. */
  draft?: string;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  /** validation hint (out of range / not a number), or null. */
  error?: string | null;
}

/**
 * The config value picker — the step between "Set · <param>" in the menu and the
 * type-CONFIRM box. Enum params list their options (↑↓ to choose); numeric params
 * accept typed digits bounded by min/max. Enter proceeds to CONFIRM; Esc cancels.
 */
export function renderParamEdit(view: ViewState, o: ParamEditOpts): string[] {
  const W = view.cols;
  const body: string[] = [
    c.white(o.label),
    c.grey('current: ') + c.white(o.current),
    '',
  ];
  if (o.isEnum && o.options) {
    body.push(c.grey('choose a value:'));
    const idx = o.optionIndex ?? 0;
    // Window the options so a long enum list stays on screen. Size the window to
    // the terminal height (reserve ~10 rows for the box chrome + fixed body +
    // footer) so the "⏎ continue" footer + bottom border never clip on a short
    // (60x16 minimum) terminal.
    const cap = Math.max(1, Math.min(8, view.rows - 10));
    let start = 0;
    if (o.options.length > cap) start = Math.min(Math.max(0, idx - (cap >> 1)), o.options.length - cap);
    for (let i = start; i < Math.min(o.options.length, start + cap); i++) {
      const opt = o.options[i];
      const sel = i === idx;
      const row = `${sel ? c.cyanB('▶ ') : '  '}${(sel ? c.whiteB : c.grey)(`${opt.value}`)}  ${(sel ? c.white : c.grey)(opt.label)}`;
      body.push(row);
    }
  } else {
    const range = o.min != null && o.max != null ? `${o.min}…${o.max}` : 'a whole number';
    body.push(c.grey('range: ') + c.white(range) + (o.unit ? c.grey(' ' + o.unit) : ''));
    body.push('');
    body.push(c.grey('new value: ') + c.whiteB(o.draft || '') + c.cyanB('▉'));
  }
  if (o.error) {
    body.push('');
    body.push(c.yellow(o.error));
  }
  body.push('');
  body.push(c.greenB('⏎ continue') + c.grey('   ·   Esc = cancel'));
  return centeredNotice(view, 'SET PARAMETER', body.map((l) => truncate(l, W)));
}

/* ── the type-CONFIRM modal ────────────────────────────────────────────── */

export interface TypeConfirmOpts {
  label: string; // "Rebuild ALL routes"
  target: string; // "whole mesh (39 nodes)" | "#16 Kitchen Lights"
  impact: ActionImpact;
  desc: string;
  impactNote: string;
  /** What the operator has typed so far toward CONFIRM. */
  buffer: string;
}

export function renderTypeConfirm(view: ViewState, o: TypeConfirmOpts): string[] {
  const W = view.cols;
  const armed = o.buffer === CONFIRM_WORD;
  const titleWord = o.impact === 'destructive' ? '⚠  CONFIRM' : 'CONFIRM';
  const title = impactColor(o.impact)(titleWord);

  // The input field: typed letters, then a caret, padded under the target word
  // length so it reads like a box. Green once it exactly matches.
  const typed = o.buffer;
  const caret = armed ? '' : c.cyanB('▉');
  const field = armed ? c.greenB(CONFIRM_WORD) : c.white(typed) + caret;
  const prompt = armed
    ? c.greenB('▶ press Enter to execute')
    : c.grey('type ') + c.whiteB(CONFIRM_WORD) + c.grey(' to arm:  ') + field;

  const wrapNote = wrap(o.impactNote, Math.min(64, Math.max(20, W - 8)));

  const body: string[] = [
    impactColor(o.impact)(o.label),
    c.grey('target: ') + c.white(o.target),
    '',
    c.grey(o.desc),
    ...wrapNote.map((l) => impactColor(o.impact)(l)),
    '',
    prompt,
    c.grey('Esc = cancel'),
  ];
  return centeredNotice(view, title, body.map((l) => truncate(l, W)));
}

/** Minimal word-wrap for the impact note (no ANSI inside the input string). */
function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
