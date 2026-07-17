/**
 * REMEDY screen (M3, DESIGN.md §3.7) — the engine's advisory surface. Lists the
 * symptoms the detectors have found, ranked by severity, each with its evidence,
 * a technician-grade narrative, and a `basis` label so an inference never reads
 * like a measurement. Advisory-only: M3 recommends nothing to *do* here (that is
 * M4's planner); this screen is where the operator VALIDATES that the symptoms
 * are right over the advisory-first weeks.
 */

import type { ScreenCtx, Symptom } from '../../types';
import { c, truncate, visLen, padEnd } from '../ansi';
import { frame } from '../chrome';

const SEV_TAG: Record<Symptom['severity'], string> = {
  crit: c.redB('CRIT'),
  warn: c.yellow('WARN'),
  watch: c.grey('WATCH'),
};

function ago(sinceMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** One header line + its evidence + narrative for a symptom (2–4 rows). */
function symptomBlock(sym: Symptom, now: number, W: number, nameOf: (id: number) => string): string[] {
  const rows: string[] = [];
  const who = sym.nodeId != null ? c.cyan(`#${sym.nodeId} ${nameOf(sym.nodeId)}`) : c.blue('MESH');
  // Compact basis GLYPH placed right after severity so it survives truncation at
  // 40 cols — it is the only measured-vs-inferred guardrail and must never be
  // clipped off the row (v0.14 review). Full word repeated on the evidence line.
  const glyph = sym.basis === 'measured' ? c.green('◆') : c.yellow('◇');
  const subsumed = sym.subsumedBy ? c.grey(' · under mesh event') : '';
  // Header: severity · basis-glyph · kind · who · dwell age.
  rows.push(
    truncate(
      `${SEV_TAG[sym.severity]} ${glyph} ${c.white(sym.kind)}  ${who}  ${c.grey(ago(sym.sinceMs, now) + subsumed)}`,
      W,
    ),
  );
  // Evidence line — leads with the full basis word (measured/inferred), then the
  // grey label = value pairs.
  {
    const basisWord = sym.basis === 'measured' ? c.green('measured') : c.yellow('inferred');
    const parts = [basisWord, ...sym.evidence.map((e) => `${c.label(e.label)} ${c.white(e.value)}`)];
    rows.push(truncate('    ' + parts.join(c.grey('  ·  ')), W));
  }
  // Narrative — wrapped to width across up to 2 rows.
  for (const line of wrap(sym.narrative, W - 4).slice(0, 2)) rows.push(truncate('    ' + c.grey(line), W));
  rows.push('');
  return rows;
}

/** Naive word-wrap on plain text (narratives carry no ANSI). */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      if (line) out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}

export function renderRemedy(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const now = Date.now();
  const symptoms = data.symptoms();
  const nameOf = (id: number): string => data.nodeById(id)?.name ?? `Node ${id}`;

  const body: string[] = [];
  if (symptoms.length === 0) {
    // Three honest, DISTINCT empty states (v0.14 review): engine off vs still
    // learning vs genuinely all-healthy — never rendered identically.
    const eng = data.engineStatus();
    body.push('');
    if (!eng.enabled) {
      body.push(c.yellow('    ● Engine disabled.'));
      body.push('');
      body.push(c.grey('    The symptom engine is not running on this install (no baselines'));
      body.push(c.grey('    store configured), so nothing is being diagnosed.'));
    } else if (eng.ready < eng.total) {
      body.push(c.cyan(`    ◷ Learning — ${eng.ready}/${eng.total} nodes have a graduated baseline.`));
      body.push('');
      body.push(c.grey('    Each node’s normal is learned from the evidence stream across'));
      body.push(c.grey('    several distinct days before its detectors may fire. No symptoms'));
      body.push(c.grey('    can be reported for a node until then — this is by design, not a fault.'));
    } else {
      body.push(c.green(`    ✓ All clear — ${eng.total} nodes learned, no symptoms detected.`));
      body.push('');
      body.push(c.grey('    Every node has a graduated baseline and none is currently anomalous.'));
      body.push(c.grey('    New symptoms will surface here — advisory-first, nothing is acted on.'));
    }
  } else {
    const crit = symptoms.filter((s) => s.severity === 'crit').length;
    const warn = symptoms.filter((s) => s.severity === 'warn').length;
    body.push(truncate(c.grey('  ') + summaryLine(crit, warn, symptoms.length), W));
    body.push('');
    for (const sym of symptoms) {
      for (const r of symptomBlock(sym, now, W, nameOf)) body.push(r);
    }
  }

  const right = symptoms.length ? `${symptoms.length} symptom${symptoms.length === 1 ? '' : 's'}` : 'all clear';
  return frame(view, data, {
    title: 'REMEDY',
    rightStatus: right,
    body,
    keys: [
      ['1-7', 'SCREENS'],
      ['Q', 'BACK'],
    ],
  });
}

function summaryLine(crit: number, warn: number, total: number): string {
  const bits: string[] = [];
  if (crit) bits.push(c.redB(`${crit} critical`));
  if (warn) bits.push(c.yellow(`${warn} warning`));
  const watch = total - crit - warn;
  if (watch) bits.push(c.grey(`${watch} watch`));
  return bits.join(c.grey(' · ')) + c.grey('  —  advisory only; nothing is acted on');
}

void padEnd;
void visLen;
