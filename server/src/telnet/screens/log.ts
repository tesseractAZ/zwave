/**
 * EVENT & COMMAND LOG overlay — v0.2 live.
 *
 * The scrolling stream of driver events (dead/alive/wake/route-change) and
 * operator command outcomes, newest-first. Each row is:
 *
 *   HH:MM:SS  [net] ✕  #7 Garage Sensor   node is dead (no ACK)
 *   └ time    └ src └ severity glyph  └ node ref   └ text (severity-coloured)
 *
 * A header line carries the live follow-tail / errors-only mode so those
 * session toggles are never invisible; a footer legend surfaces the keys.
 * Colour discipline matches the rest of the TUI: info white, warn yellow,
 * error red (unacked errors bold — the RED-latch emphasis). Newest at top,
 * windowed to the terminal height. Dismissed with q/Esc by the session.
 */

import { c, center, lr, padEnd, truncate, visLen } from '../ansi';
import type { DataProvider, LogEvent, ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

/** Width of the node-reference column ("#7 Garage Sensor"). */
const NODE_W = 15;

export function renderLog(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const H = view.rows;

  const all = data.events();

  // Nothing has happened yet — the specified empty-state card.
  if (all.length === 0) {
    return centeredNotice(view, 'EVENT & COMMAND LOG', [
      c.grey('No events yet — node status changes and route changes will appear here.'),
    ]);
  }

  // errorsOnly narrows the stream to the RED lines; the header still reports
  // both counts so the filter is obvious.
  const shown = view.errorsOnly ? all.filter((e) => e.severity === 'error') : all;

  const out: string[] = [];
  out.push(truncate(headerLine(view, shown.length, all.length), W));

  // Body window: everything between the header and the legend. events() is
  // newest-first, so slicing from the front keeps the newest at the top.
  const cap = Math.max(1, H - 2); // header + legend
  if (shown.length === 0) {
    // errorsOnly is on but the stream is currently clean.
    out.push(truncate(center(c.grey('No error events — press o to show all severities.'), W), W));
  } else {
    const end = Math.min(shown.length, cap);
    for (let i = 0; i < end; i++) {
      out.push(truncate(eventRow(shown[i], data, W), W));
    }
  }

  // Pad the body so the legend lands on the last row.
  while (out.length < H - 1) out.push('');
  out.push(truncate(legend(view, shown.length, cap), W));

  // Defensive clamp — never overrun the row budget.
  return out.slice(0, H);
}

/* ── header ────────────────────────────────────────────────────────────── */

function headerLine(view: ScreenCtx['view'], shown: number, total: number): string {
  // Left: title + how many rows are in view vs the full stream.
  const count = view.errorsOnly ? `${shown}/${total}` : `${total}`;
  const left =
    c.cyanB('EVENT & COMMAND LOG') +
    c.grey(' · ') +
    c.white(count) +
    c.grey(total === 1 ? ' event' : ' events');

  // Right: the live filter mode. (The stream always auto-follows newest-first;
  // there's no scrollback yet, so no follow/pause toggle is shown.)
  const right = view.errorsOnly ? c.yellowB('errors only') : c.grey('all severities');

  return lr(left, right, view.cols);
}

/* ── one event row ─────────────────────────────────────────────────────── */

function eventRow(ev: LogEvent, data: DataProvider, W: number): string {
  const time = c.grey(fmtTime(ev.ts));
  const tag = sourceTag(ev.source);
  const glyph = sevGlyph(ev.severity);
  const node = padEnd(nodeRef(ev.nodeId, data), NODE_W);

  // Fixed prefix (single-space separators). Its visible width is deterministic,
  // so the remaining width for the free-text column is exact.
  const prefix = `${time} ${tag} ${glyph} ${node} `;
  const textW = Math.max(0, W - visLen(prefix));
  const text = sevColor(ev)(truncate(ev.text, textW));

  return prefix + text;
}

/* ── cell formatters ───────────────────────────────────────────────────── */

function sourceTag(source: LogEvent['source']): string {
  // Operator actions stand out from ambient network chatter.
  return source === 'you' ? c.cyanB('[you]') : c.grey('[net]');
}

function sevGlyph(sev: LogEvent['severity']): string {
  if (sev === 'error') return c.red('✕');
  if (sev === 'warn') return c.yellow('▲');
  return c.grey('·');
}

function sevColor(ev: LogEvent): (s: string) => string {
  if (ev.severity === 'error') {
    // Unacked errors ride the RED latch — bold until acknowledged.
    return ev.acked ? c.red : c.redB;
  }
  if (ev.severity === 'warn') return c.yellow;
  return c.white;
}

function nodeRef(nodeId: number | null, data: DataProvider): string {
  if (nodeId == null) return c.grey(''); // network-wide event — no node column
  const n = data.nodeById(nodeId);
  const name = n ? n.name : `node ${nodeId}`;
  // Colour just the id; padEnd (ANSI-aware) trims the name to the column.
  return c.cyan(`#${nodeId}`) + ' ' + c.white(name);
}

function fmtTime(ts: number): string {
  const d = new Date(ts); // app-runtime clock (allowed)
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ── legend ────────────────────────────────────────────────────────────── */

function legend(view: ScreenCtx['view'], shown: number, cap: number): string {
  const key = (k: string, label: string) => c.cyanB(k) + ' ' + c.grey(label);
  const left = [
    key('o', view.errorsOnly ? 'all' : 'errors'),
    key('q/Esc', 'close'),
  ].join(c.grey(' · '));

  // How many older lines fall off the bottom of the window.
  const hidden = Math.max(0, shown - cap);
  const right = hidden > 0 ? c.grey(`↓ +${hidden} older`) : c.grey('· end');

  return lr(left, right, view.cols);
}
