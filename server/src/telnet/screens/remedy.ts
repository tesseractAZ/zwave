/**
 * REMEDY screen (M3 + M4, DESIGN.md §3.7) — the engine's advisory surface. Lists
 * the symptoms the detectors found, ranked by severity, each with its evidence,
 * a technician-grade narrative, a `basis` label so an inference never reads like
 * a measurement, and (M4) the planner's ranked RECOMMENDATIONS — each with its
 * own basis + cost, executable ones marked, physical ones described. Still
 * advisory-only: nothing runs from here; executable actions go through the
 * existing Actions Menu (`a`) + type-CONFIRM.
 */

import type { ScreenCtx, Symptom, NodeSnapshot, SymptomKind, ActionKind, Efficacy } from '../../types';
import { c, truncate } from '../ansi';
import { frame } from '../chrome';
import { planFor, type PlanCandidate } from '../../zwave/planner';

/** One-line learned-efficacy note for an executable candidate (M5): a green
 *  "beat self-healing" when it clears the control arm, a grey "not
 *  distinguishable" once enough episodes exist, nothing while still learning. */
function efficacyNote(e: Efficacy | null | undefined): string | null {
  if (!e || !e.ready) return null; // still learning → say nothing (honest)
  const n = Math.round(e.n);
  if (e.expectedEfficacy != null) {
    // `n` first (after the headline %) so the trust signal survives truncation.
    const pct = Math.round(e.expectedEfficacy * 100);
    const base = e.baseRate != null ? ` vs ${Math.round(e.baseRate * 100)}% self-heal` : '';
    return c.green(`✓ helped ${pct}% (n=${n})${base}`);
  }
  return c.grey(`≈ n=${n}: not distinguishable from self-healing`);
}

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

/** Cost-tier tag — physical guidance vs escalating executable blast radius. */
function costTag(cost: PlanCandidate['cost']): string {
  switch (cost) {
    case 'physical': return c.blue('physical');
    case 'safe': return c.green('safe');
    case 'caution': return c.yellow('caution');
    case 'disruptive': return c.yellow('disruptive');
    case 'destructive': return c.redB('destructive');
  }
}

function symptomBlock(sym: Symptom, now: number, W: number, nameOf: (id: number) => string, writeActions: boolean, nodeOf: (id: number) => NodeSnapshot | undefined, efficacyFor: (kind: SymptomKind, action: ActionKind) => Efficacy | null): string[] {
  const rows: string[] = [];
  const who = sym.nodeId != null ? c.cyan(`#${sym.nodeId} ${nameOf(sym.nodeId)}`) : c.blue('MESH');
  // Compact basis GLYPH placed right after severity so it survives truncation at
  // 40 cols — it is the only measured-vs-inferred guardrail and must never be
  // clipped off the row (v0.14 review). Full word repeated on the evidence line.
  const glyph = sym.basis === 'measured' ? c.green('◆') : c.yellow('◇');
  const subsumed = sym.subsumedBy
    ? c.grey(sym.subsumedBy.endsWith(':edge-cluster') ? ' · under edge cluster' : ' · under mesh event')
    : '';
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
  // Narrative — one line of diagnostic context (the plan headline carries the
  // recommendation, so a single line here keeps the block scannable).
  for (const line of wrap(sym.narrative, W - 4).slice(0, 1)) rows.push(truncate('    ' + c.grey(line), W));

  // ── M4: the planner's ranked recommendations (skip subsumed — the mesh event
  // owns the recommendation). Each candidate is ONE line: a marker (▸ executable,
  // · physical), the title, a [cost · basis] tag, and — when blocked — the reason
  // inline (⊘). Only the top candidate carries a rationale line, so a screenful of
  // symptoms stays readable without scrolling.
  if (sym.subsumedBy == null) {
    const plan = planFor(sym, sym.nodeId != null ? nodeOf(sym.nodeId) : undefined, { writeActions, efficacyFor });
    rows.push(truncate('    ' + c.label('▎ ') + c.white(plan.headline), W));
    plan.candidates.slice(0, 3).forEach((cand, i) => {
      const runnable = cand.action != null && cand.blocked == null;
      const marker = cand.action != null ? (runnable ? c.green('▸') : c.grey('▸')) : c.grey('·');
      const tags = `${c.grey('[')}${costTag(cand.cost)}${c.grey(' · ')}${c.grey(cand.basis)}${c.grey(']')}`;
      const block = cand.blocked ? c.grey('  ⊘ ' + cand.blocked) : '';
      rows.push(truncate(`      ${marker} ${c.white(cand.title)} ${tags}${block}`, W));
      // Grounding for the primary recommendation only; "…" signals more detail.
      if (i === 0) {
        const rl = wrap(cand.rationale, W - 8);
        if (rl.length) rows.push(truncate('        ' + c.grey(rl[0] + (rl.length > 1 ? ' …' : '')), W));
      }
      // M5: learned efficacy note — ONLY on a runnable recommendation. A blocked
      // or anti-pattern candidate (e.g. the "rebuild — NOT recommended" row) must
      // never carry a green "✓ helped …" note that contradicts the advice.
      if (runnable) {
        const note = efficacyNote(cand.efficacy);
        if (note) rows.push(truncate('        ' + note, W));
      }
    });
  }
  rows.push('');
  return rows;
}

/** Render order: worst first (crit → warn → watch), newest-breaching as tiebreak,
 *  so a low-severity watch can never bury a critical off the bottom of a
 *  no-scroll screen. */
const SEV_RANK: Record<Symptom['severity'], number> = { crit: 0, warn: 1, watch: 2 };
function bySeverity(a: Symptom, b: Symptom): number {
  return SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.sinceMs - a.sinceMs;
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
  const nodeOf = (id: number): NodeSnapshot | undefined => data.nodeById(id);
  const efficacyFor = (kind: SymptomKind, action: ActionKind): Efficacy | null => data.efficacyFor(kind, action);

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
    // frame() reserves masthead + title-rule + command-bar = 3 lines; the summary
    // + spacer above cost 2 more. The screen does not scroll, so build blocks
    // worst-first and stop before overflowing — an honest footer beats silently
    // dropping a critical off the bottom.
    const bodyCap = Math.max(0, view.rows - 3);
    const sorted = [...symptoms].sort(bySeverity);
    let used = body.length; // summary + spacer already pushed
    let shown = 0;
    for (const sym of sorted) {
      const blk = symptomBlock(sym, now, W, nameOf, ctx.actionsEnabled === true, nodeOf, efficacyFor);
      const remaining = sorted.length - shown;
      // Reserve one line for the "N more" footer whenever blocks remain unshown.
      const reserve = remaining > 1 ? 1 : 0;
      if (used + blk.length > bodyCap - reserve && shown > 0) break;
      for (const r of blk) body.push(r);
      used += blk.length;
      shown += 1;
    }
    if (shown < sorted.length) {
      // Guarantee the footer is the LAST visible body line even in the degenerate
      // case where a single oversized block already filled the screen: trim the
      // body so footer lands within frame()'s bodyCap, never silently dropped.
      if (body.length > bodyCap - 1) body.length = Math.max(0, bodyCap - 1);
      body.push(truncate(c.yellow(`  ▾ ${sorted.length - shown} more symptom${sorted.length - shown === 1 ? '' : 's'} not shown`) + c.grey(' — worst are listed first; widen/heighten the terminal to see all'), W));
    }
  }

  const right = symptoms.length ? `${symptoms.length} symptom${symptoms.length === 1 ? '' : 's'}` : 'all clear';
  return frame(view, data, {
    title: 'REMEDY',
    rightStatus: right,
    body,
    keys: [
      ['1-8', 'SCREENS'],
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
