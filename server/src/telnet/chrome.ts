/**
 * Diagnostic-console chrome — the formal, shared frame every screen wears.
 *
 * Instrument-panel discipline for an automation diagnostic technician:
 *   • a system MASTHEAD (product ident · link state · home id · timestamp),
 *   • a titled SECTION RULE that names the active screen,
 *   • labelled TELEMETRY fields (UPPERCASE label + value + unit),
 *   • a keycap COMMAND BAR ([K] LABEL) instead of a casual hint legend.
 *
 * Restraint over decoration: uppercase chrome labels, units on every value,
 * semantic colour only (green=ok / amber=warn / red=fault / cyan=info-structure /
 * grey=chrome), precise column alignment. Every helper returns a single line at
 * most `view.cols` wide (callers still own the exact-rows contract).
 */

import { c, lr, truncate, visLen } from './ansi';
import type { DataProvider, ViewState } from '../types';

/** Product identity shown at the far left of the masthead. */
export const PRODUCT = 'ZWAVE·JS MESH DIAGNOSTICS';

export type LinkState = 'online' | 'stale' | 'offline';

const pad2 = (x: number): string => String(x).padStart(2, '0');

/** Formal, log-correlatable local timestamp: YYYY-MM-DD HH:MM:SS. */
export function stamp(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function linkTag(link: LinkState): string {
  if (link === 'online') return c.green('●') + ' ' + c.green('ONLINE');
  if (link === 'stale') return c.yellow('●') + ' ' + c.yellow('STALE');
  return c.red('●') + ' ' + c.red('OFFLINE');
}

/**
 * Row 0 — the system masthead. Product ident on the left; link state, home id
 * (wide terminals only), and the timestamp on the right.
 */
export function masthead(view: ViewState, o: { link: LinkState; homeId: number | null; now: number }): string {
  const parts = [linkTag(o.link)];
  if (view.cols >= 100 && o.homeId != null) parts.push(c.grey('HOME ') + c.white(String(o.homeId)));
  parts.push(c.grey(stamp(o.now)));
  return lr(c.whiteB(PRODUCT), parts.join(c.grey('   ')), view.cols);
}

/**
 * A titled section rule: `── OVERVIEW ─────────────…──── [right]`.
 * `right` (optional) is a status token pinned to the far right (rebuild /
 * filter / count) — it is drawn OUTSIDE the rule so it never gets buried.
 */
export function titleRule(view: ViewState, title: string, right = ''): string {
  const head = c.cyan('── ') + c.whiteB(title) + ' ';
  const rightW = right ? visLen(right) + 2 : 0;
  const fill = Math.max(0, view.cols - visLen(head) - rightW);
  let line = head + c.cyan('─'.repeat(fill));
  if (right) line += '  ' + right;
  return truncate(line, view.cols);
}

/** One labelled telemetry field: `LABEL value` (dim label, coloured value). */
export function field(label: string, value: string, color: (s: string) => string = c.white): string {
  return c.grey(label) + ' ' + color(value);
}

/** A strip of telemetry fields separated by a fixed gutter, clipped to width. */
export function fieldStrip(view: ViewState, fields: string[]): string {
  return truncate(fields.join(c.grey('    ')), view.cols);
}

/** Bottom command bar: `[K] LABEL` keycaps (cyan cap, dim label). */
export function commandBar(view: ViewState, keys: ReadonlyArray<readonly [string, string]>): string {
  const cap = ([k, label]: readonly [string, string]): string => c.cyanB('[' + k + ']') + ' ' + c.grey(label);
  return truncate(keys.map(cap).join('   '), view.cols);
}

/** A plain full-width rule (section divider inside a screen body). */
export function rule(view: ViewState): string {
  return c.grey('─'.repeat(view.cols));
}

/** Roster link state, derived once and shared by every screen's masthead. */
export function linkState(data: DataProvider): LinkState {
  if (data.lastError() != null) return 'offline';
  const lu = data.lastUpdated();
  if (lu == null) return 'stale';
  return Date.now() - lu > 30_000 ? 'stale' : 'online';
}

export interface FrameOpts {
  /** Section name shown in the title rule. */
  title: string;
  /** Optional far-right token on the title rule (status / count / filter). */
  rightStatus?: string;
  /** Optional telemetry strip drawn directly under the rule. */
  telemetry?: string;
  /** Body lines (each already styled + ≤ cols). Padded/clamped to fit. */
  body: string[];
  /** Command-bar keycaps. */
  keys: ReadonlyArray<readonly [string, string]>;
}

/**
 * The whole-screen frame every content screen wears: masthead · titled rule ·
 * [telemetry] · body (padded to fill) · command bar. Returns EXACTLY
 * `view.rows` lines ≤ `view.cols` — the screen only has to supply its body.
 */
export function frame(view: ViewState, data: DataProvider, o: FrameOpts): string[] {
  const out: string[] = [];
  out.push(masthead(view, { link: linkState(data), homeId: data.controller()?.homeId ?? null, now: Date.now() }));
  out.push(titleRule(view, o.title, o.rightStatus ?? ''));
  if (o.telemetry != null) out.push(truncate(o.telemetry, view.cols));
  const top = out.length;
  const bodyCap = Math.max(0, view.rows - top - 1); // reserve the command bar
  for (let i = 0; i < bodyCap; i++) out.push(o.body[i] != null ? truncate(o.body[i], view.cols) : '');
  out.push(commandBar(view, o.keys));
  return out.slice(0, view.rows);
}
