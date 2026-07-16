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
import type { ActionImpact, MenuItem } from '../actionsCatalog';
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

const LABEL_W = 20; // action-label column

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

  // Body: grouped rows with a section header when the scope changes.
  let lastScope: string | null = null;
  const bodyCap = Math.max(1, H - 3); // header + rule + footer
  let rowsUsed = 0;
  for (let i = 0; i < items.length && rowsUsed < bodyCap; i++) {
    const it = items[i];
    if (it.desc.scope !== lastScope) {
      lastScope = it.desc.scope;
      if (rowsUsed < bodyCap) {
        const heading = lastScope === 'device' ? 'DEVICE ACTIONS' : 'SYSTEM-WIDE';
        out.push(truncate(c.grey(heading), W));
        rowsUsed++;
      }
    }
    if (rowsUsed >= bodyCap) break;
    out.push(truncate(menuRow(it, i === index, locked, W), W));
    rowsUsed++;
  }

  // Pad so the footer lands on the last row.
  while (out.length < H - 1) out.push('');

  // Footer.
  const key = (k: string, label: string) => c.cyanB(k) + ' ' + c.grey(label);
  const left = [key('↑↓', 'move'), key('⏎', locked ? 'locked' : 'select'), key('Esc', 'close')].join(c.grey(' · '));
  const right = locked ? c.yellow('enable write_actions_enabled to unlock') : c.grey(`${items.length} action${items.length === 1 ? '' : 's'}`);
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
