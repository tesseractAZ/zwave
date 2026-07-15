/**
 * ACTIVITY LOG — the live, scrollable stream of Z-Wave activity (v0.8).
 *
 * A real-time feed of everything the mesh does: device value changes (a light
 * toggles, a sensor reads, a lock changes), node status transitions
 * (alive/dead/asleep), route changes, zwave_js notifications, and operator
 * command outcomes. Newest at the top.
 *
 * Layout (exactly `view.rows` lines, each ≤ `view.cols`):
 *   ┌ header ─ title · N events · [date-range] [errors] ─ cursor pos ┐
 *   │ list   ─ scrollable, cursor-highlighted rows                    │
 *   ├ ─────  (separator, only when the terminal is tall enough)       │
 *   │ detail ─ the selected event's full details + associated device  │
 *   └ legend ─ j/k move · space/b page · ⏎ device · d date · o errors │
 *
 * Navigation lives in `../input` (`applyLogKey`) so the cursor and the visible
 * window are computed from the SAME `filteredEvents`/`logLayout` helpers — the
 * two can never disagree.
 */

import { c, center, lr, padEnd, truncate, visLen } from '../ansi';
import type { DataProvider, LogEvent, ScreenCtx } from '../../types';
import { LOG_RANGE_LABEL } from '../../types';
import { filteredEvents, logLayout, syncLogCursor } from '../input';
import { windowStart } from './overview';

/** Width of the node-reference column ("#7 Garage Sensor"). */
const NODE_W = 18;

export function renderLog(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const H = view.rows;

  const events = filteredEvents(data, view);
  syncLogCursor(view, events);
  const { listRows, detailRows, showDetail } = logLayout(H);

  const out: string[] = [];
  out.push(truncate(headerLine(view, events.length), W));

  // ── list body (exactly listRows lines) ──────────────────────────────────
  if (events.length === 0) {
    const msg =
      view.errorsOnly || view.logRange !== 'all'
        ? [
            c.grey('No events match the current filters.'),
            c.grey(filterSummary(view) + ' — press ') + c.cyanB('d') + c.grey('/') + c.cyanB('o') + c.grey(' to widen'),
          ]
        : [c.grey('Waiting for activity — device, status & route changes appear here live.')];
    const top = Math.max(0, Math.floor((listRows - msg.length) / 2));
    for (let i = 0; i < listRows; i++) {
      const m = i - top;
      out.push(m >= 0 && m < msg.length ? truncate(center(msg[m], W), W) : '');
    }
  } else {
    const start = windowStart(view.logCursor, view.logScroll, events.length, listRows);
    view.logScroll = start; // persist for a proper sticky window next frame
    for (let i = 0; i < listRows; i++) {
      const idx = start + i;
      out.push(idx < events.length ? truncate(eventRow(events[idx], data, W, idx === view.logCursor), W) : '');
    }
  }

  // ── detail pane ──────────────────────────────────────────────────────────
  if (showDetail) {
    out.push(truncate(c.grey('─'.repeat(W)), W));
    const sel = events[view.logCursor];
    for (const line of detailLines(sel, data, W, detailRows)) out.push(truncate(line, W));
  }

  out.push(truncate(legend(view, events.length), W));

  while (out.length < H) out.push('');
  return out.slice(0, H);
}

/* ── header ────────────────────────────────────────────────────────────── */

function headerLine(view: ScreenCtx['view'], total: number): string {
  const left =
    c.cyanB('ACTIVITY LOG') + c.grey(' · ') + c.white(String(total)) + c.grey(total === 1 ? ' event' : ' events');

  const chips: string[] = [];
  chips.push(c.blue(`◷ ${LOG_RANGE_LABEL[view.logRange]}`));
  if (view.errorsOnly) chips.push(c.yellowB('▲ errors only'));
  const right = chips.join(c.grey(' · '));

  return lr(left, right, view.cols);
}

function filterSummary(view: ScreenCtx['view']): string {
  const parts = [LOG_RANGE_LABEL[view.logRange]];
  if (view.errorsOnly) parts.push('errors only');
  return parts.join(', ');
}

/* ── one event row ─────────────────────────────────────────────────────── */

function eventRow(ev: LogEvent, data: DataProvider, W: number, selected: boolean): string {
  const cursor = selected ? c.cyanB('▶') : ' ';
  const time = c.grey(fmtTime(ev.ts));
  const tag = kindTag(ev);
  const node = padEnd(nodeRef(ev.nodeId, data), NODE_W);

  const prefix = `${cursor} ${time} ${tag} ${node} `;
  const textW = Math.max(0, W - visLen(prefix));
  const text = sevColor(ev)(truncate(ev.text, textW));
  return prefix + text;
}

/* ── cell formatters ───────────────────────────────────────────────────── */

/** A 3-letter, colour-coded category tag — scannable at a glance. */
function kindTag(ev: LogEvent): string {
  switch (ev.kind) {
    case 'value':
      return c.cyan('val');
    case 'status':
      return ev.severity === 'error' ? c.redB('sts') : c.white('sts');
    case 'route':
      return c.grey('rte');
    case 'notification':
      return c.yellow('ntf');
    case 'action':
      return c.cyanB('act');
    case 'system':
      return c.grey('sys');
  }
}

function sevColor(ev: LogEvent): (s: string) => string {
  if (ev.severity === 'error') return ev.acked ? c.red : c.redB;
  if (ev.severity === 'warn') return c.yellow;
  return c.white;
}

function nodeRef(nodeId: number | null, data: DataProvider): string {
  if (nodeId == null) return c.grey('— network');
  const n = data.nodeById(nodeId);
  const name = n ? n.name : `node ${nodeId}`;
  return c.cyan(`#${nodeId}`) + ' ' + c.white(name);
}

/* ── detail pane ───────────────────────────────────────────────────────── */

function detailLines(ev: LogEvent | undefined, data: DataProvider, W: number, rows: number): string[] {
  const lines: string[] = [];
  if (!ev) {
    lines.push(c.grey('  (no event selected)'));
  } else {
    lines.push(field('Time', `${c.white(fmtDateTime(ev.ts))}  ${c.grey('· ' + relTime(ev.ts))}`, W));
    lines.push(
      field(
        'Type',
        `${kindWord(ev)} ${c.grey('·')} ${sevWord(ev.severity)} ${c.grey('·')} ${ev.source === 'you' ? c.cyan('operator') : c.grey('network')}`,
        W,
      ),
    );
    lines.push(field('Device', deviceLine(ev.nodeId, data), W));
    if (ev.entityId) {
      lines.push(field('Entity', `${c.white(ev.entityId)} ${c.grey('(' + (ev.domain ?? '?') + ')')}`, W));
    }
    if (ev.oldState != null || ev.newState != null) {
      lines.push(field('Change', `${c.grey(ev.oldState ?? '—')} ${c.cyan('→')} ${c.white(ev.newState ?? '—')}`, W));
    }
    lines.push(field('Detail', sevColor(ev)(ev.text), W));
  }
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows);
}

function field(label: string, value: string, W: number): string {
  return truncate(`  ${c.grey(padEnd(label, 8))}${value}`, W);
}

function deviceLine(nodeId: number | null, data: DataProvider): string {
  if (nodeId == null) return c.grey('network-wide (no associated node)');
  const n = data.nodeById(nodeId);
  const name = n ? n.name : `node ${nodeId}`;
  const area = n?.area ? c.grey(' · area ' + n.area) : '';
  const status = n ? c.grey(' · ' + n.statusLabel) : '';
  return c.cyan(`#${nodeId}`) + ' ' + c.white(name) + area + status;
}

function kindWord(ev: LogEvent): string {
  const map: Record<LogEvent['kind'], string> = {
    value: 'value change',
    status: 'node status',
    route: 'route change',
    notification: 'notification',
    action: 'operator action',
    system: 'system',
  };
  return c.white(map[ev.kind]);
}

function sevWord(sev: LogEvent['severity']): string {
  if (sev === 'error') return c.red('error');
  if (sev === 'warn') return c.yellow('warning');
  return c.grey('info');
}

/* ── legend ────────────────────────────────────────────────────────────── */

function legend(view: ScreenCtx['view'], total: number): string {
  const key = (k: string, label: string) => c.cyanB(k) + ' ' + c.grey(label);
  const left = [
    key('j/k', 'move'),
    key('␣/b', 'page'),
    key('⏎', 'device'),
    key('d', 'date'),
    key('o', 'errors'),
    key('q', 'close'),
  ].join(c.grey(' · '));

  // Cursor position within the filtered stream.
  const right = total > 0 ? c.grey(`${view.logCursor + 1}/${total}`) : c.grey('0/0');
  return lr(left, right, view.cols);
}

/* ── time helpers (app-runtime clock — allowed) ────────────────────────── */

function p2(x: number): string {
  return String(x).padStart(2, '0');
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtTime(ts)}`;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
