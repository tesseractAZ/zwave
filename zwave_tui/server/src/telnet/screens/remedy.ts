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
/**
 * The outcome ledger's verdict on one candidate.
 *
 * `blocked` changes the VOICE, not whether we speak (v0.35). Until now the note
 * was rendered for runnable candidates only, on the sound-looking grounds that a
 * green "✓ helped" must never sit under advice that says "NOT recommended". But
 * route-churn's only executable candidate is hardcoded blocked, so the ledger's
 * measurement of it could never reach the screen at all — and the block reason
 * is `lore`, while the ledger is `measured`. Suppressing measurement because it
 * contradicts a prior is exactly backwards: overturning priors is what the
 * learning loop is FOR.
 *
 * So a blocked candidate still reports what was measured — but WITHOUT
 * characterizing the block. `blocked` is one string carrying three different
 * kinds of gate: a planner-authored advisory ("physical-link symptom"), the
 * write-actions master gate, and a hard safety gate (battery/FLiRS probe
 * skip). The first draft said "the block above is lore", which is true only
 * of the first kind — telling an operator a SAFETY gate is unfounded folklore
 * is precisely the reading this note must never produce (v0.35 review). The
 * note now states the measurement and that the block still applies, which is
 * true for all three, and endorses nothing.
 */
function efficacyNote(e: Efficacy | null | undefined, blocked = false): string | null {
  if (!e || !e.ready) return null; // still learning → say nothing (honest)
  const n = Math.round(e.n);
  const base = e.baseRate != null ? ` vs ${Math.round(e.baseRate * 100)}% self-heal` : '';
  // PROVENANCE (v0.36.5). The arms are marginal by design, so `n=6` reads as
  // six nodes agreeing when it may be one node repeating — which is exactly
  // what happened live, a single flapping device teaching the fleet-wide arm
  // past its readiness threshold. Silent when the ledger predates the tracking
  // (0) rather than claiming a node count it does not have.
  const prov = e.nodes > 0 ? ` · ${e.nodes} node${e.nodes === 1 ? '' : 's'}` : '';
  if (e.expectedEfficacy != null) {
    // `n` first (after the headline %) so the trust signal survives truncation.
    const pct = Math.round(e.expectedEfficacy * 100);
    return blocked
      ? c.yellow(`⚠ ledger measured ${pct}% here (n=${n}${prov})${base} — the block above still applies`)
      : c.green(`✓ helped ${pct}% (n=${n}${prov})${base}`);
  }
  return blocked
    ? c.grey(`≈ n=${n}${prov}: measured — not distinguishable from self-healing`)
    : c.grey(`≈ n=${n}${prov}: not distinguishable from self-healing`);
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

/** The two things the outcome ledger knows about a card: whether its actions
 *  work, and whether the detector that raised it has been wrong before. */
interface Ledger {
  efficacyFor: (kind: SymptomKind, action: ActionKind) => Efficacy | null;
  falsePositives: (kind: SymptomKind) => number;
  /** Episodes of this kind the ledger closed unscoreable (v0.36). */
  unverifiable: (kind: SymptomKind) => number;
  /** Of those, on devices that cannot be probed at all (v0.38). */
  unverifiableUnprobeable: (kind: SymptomKind) => number;
  /** Of those, transient blinks — over before the evidence floor filled (v0.39). */
  unverifiableTransient: (kind: SymptomKind) => number;
  /** Of those, undersampled by the node's own cadence (v0.41.2). */
  unverifiableUndersampled: (kind: SymptomKind) => number;
  /** No-action closures confounded by a mid-episode death/remediation (v0.40). */
  confounded: (kind: SymptomKind) => number;
}

function symptomBlock(sym: Symptom, now: number, W: number, nameOf: (id: number) => string, writeActions: boolean, nodeOf: (id: number) => NodeSnapshot | undefined, ledger: Ledger, selected = false): string[] {
  const { efficacyFor } = ledger;
  const rows: string[] = [];
  const who = sym.nodeId != null ? c.cyan(`#${sym.nodeId} ${nameOf(sym.nodeId)}`) : c.blue('MESH');
  // Compact basis GLYPH placed right after severity so it survives truncation at
  // 40 cols — it is the only measured-vs-inferred guardrail and must never be
  // clipped off the row (v0.14 review). Full word repeated on the evidence line.
  const glyph = sym.basis === 'measured' ? c.green('◆') : c.yellow('◇');
  const subsumed = sym.subsumedBy
    ? c.grey(sym.subsumedBy.endsWith(':edge-cluster') ? ' · under edge cluster' : ' · under mesh event')
    : '';
  // Header: cursor · severity · basis-glyph · kind · who · dwell age.
  // The cursor is not decoration — on REMEDY it selects the ACTION TARGET, so
  // the operator must be able to see which node `a`/`p` will act on.
  const cur = selected ? c.cyanB('▶ ') : '  ';
  rows.push(
    truncate(
      `${cur}${SEV_TAG[sym.severity]} ${glyph} ${c.white(sym.kind)}  ${who}  ${c.grey(ago(sym.sinceMs, now) + subsumed)}`,
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
  // The detector's own track record (v0.35). The ledger has counted every
  // episode of this kind an operator closed as `refused-misdiagnosis` since M5,
  // and no screen showed it — a strange omission for an ADVISORY engine, since
  // this is the one number that argues against the card it sits on. Shown only
  // when non-zero: a clean detector says nothing rather than boasting.
  {
    const fp = ledger.falsePositives(sym.kind);
    if (fp > 0) {
      rows.push(truncate(
        '    ' + c.yellow(`⚠ this detector has been refused as a misdiagnosis ${fp}\u00d7`) +
        c.grey(' — weigh the evidence above before acting'), W));
    }
    // What the ledger could not SCORE (v0.36). An empty efficacy table reads
    // exactly like a patient one, so a kind whose episodes all close
    // unscoreable would otherwise look like a detector still gathering data
    // rather than one whose evidence never reaches the verifier's floor. On
    // the live mesh that was every episode of every kind for 39 hours.
    // Two DIFFERENT facts, and one counter used to conflate them (v0.38). Thin
    // evidence is fixable — more probes, a longer window. A device that cannot
    // be probed at all is not: waking a sleeping battery or FLiRS node on a
    // cadence would flatten it, so its windows can never be filled and the
    // verdict is structural. Reported as one number, the permanent kind
    // silently drained the meaning from the fixable one.
    const unver = ledger.unverifiable(sym.kind);
    if (unver > 0) {
      rows.push(truncate(
        '    ' + c.grey(`○ ${unver} past episode${unver === 1 ? '' : 's'} of this kind could not be scored — ` +
          'too few readings to judge recovery'), W));
    }
    const unprobe = ledger.unverifiableUnprobeable(sym.kind);
    if (unprobe > 0) {
      rows.push(truncate(
        '    ' + c.grey(`○ ${unprobe} more on sleeping device${unprobe === 1 ? '' : 's'} that cannot be probed — ` +
          'unscoreable by design, not a gap'), W));
    }
    const transient = ledger.unverifiableTransient(sym.kind);
    if (transient > 0) {
      rows.push(truncate(
        '    ' + c.grey(`○ ${transient} transient blink${transient === 1 ? '' : 's'} — over before the evidence floor filled; ` +
          'unscoreable by design, not a gap'), W));
    }
    const under = ledger.unverifiableUndersampled(sym.kind);
    if (under > 0) {
      rows.push(truncate(
        '    ' + c.grey(`○ ${under} could not be scored at this device's reporting rate — ` +
          'it had the time, never the readings'), W));
    }
    const conf = ledger.confounded(sym.kind);
    if (conf > 0) {
      rows.push(truncate(
        '    ' + c.grey(`○ ${conf} confounded by a mid-episode death or remediation — ` +
          'credited to neither arm'), W));
    }
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
      // M5: the learned efficacy note. Every candidate the ledger can have an
      // opinion about gets one — i.e. every candidate with an action, blocked or
      // not. efficacyNote() carries the blocked framing so a "NOT recommended"
      // row can report a measurement without ever reading as an endorsement.
      if (cand.action != null) {
        const note = efficacyNote(cand.efficacy, cand.blocked != null);
        if (note) rows.push(truncate('        ' + note, W));
      }
    });
  }
  rows.push('');
  return rows;
}

/**
 * Render order: PLAN-OWNERS first, then worst-first (crit → warn → watch), then
 * newest-breaching.
 *
 * The plan-owner rule is load-bearing. A symptom that has been *subsumed* by a
 * mesh-wide or controller-level event renders WITHOUT a recommendation — the
 * owning event carries the fix. But a mesh-interference event is always `warn`
 * while the per-node `dead-flap` symptoms beneath it are always `crit`, so
 * ranking on severity alone floated four recommendation-less criticals above
 * the one card that could actually be acted on, and pushed that card into
 * "1 more symptom not shown". The operator saw four criticals, zero
 * recommendations, and a pointer to an event that was not on the screen.
 *
 * A subsumed symptom is by definition not the thing to act on, so it never
 * displaces the event that owns its remedy.
 */
const SEV_RANK: Record<Symptom['severity'], number> = { crit: 0, warn: 1, watch: 2 };
function bySeverity(a: Symptom, b: Symptom): number {
  return (
    (a.subsumedBy ? 1 : 0) - (b.subsumedBy ? 1 : 0) ||
    SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
    b.sinceMs - a.sinceMs
  );
}

/**
 * The single ordering used by BOTH the renderer and the cursor/action target.
 * They must never disagree: the operator acts on the card they can see, so an
 * index into a differently-sorted list would target the wrong node.
 */
/**
 * Stable identity for a symptom. `Symptom` carries no id — its identity IS the
 * (nodeId, kind) dwell key the detector keys on, and that survives the re-sort
 * the engine performs on every poll.
 */
export function symptomKey(s: Symptom): string {
  return `${s.nodeId ?? 'mesh'}:${s.kind}`;
}

export function sortedSymptoms(symptoms: readonly Symptom[]): Symptom[] {
  return [...symptoms].sort(bySeverity);
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
  const ledger: Ledger = {
    efficacyFor: (kind, action) => data.efficacyFor(kind, action),
    // Optional on the provider (older/mock providers predate it) — absent means
    // "no ledger", which is 0 refusals, NOT "this detector is trustworthy".
    // Same thing either way on screen: the line only renders above zero.
    falsePositives: (kind) => data.falsePositives?.(kind) ?? 0,
    unverifiable: (kind) => data.unverifiableCount?.(kind) ?? 0,
    unverifiableUnprobeable: (kind) => data.unverifiableUnprobeableCount?.(kind) ?? 0,
    unverifiableTransient: (kind) => data.unverifiableTransientCount?.(kind) ?? 0,
    unverifiableUndersampled: (kind) => data.unverifiableUndersampledCount?.(kind) ?? 0,
    confounded: (kind) => data.confoundedCount?.(kind) ?? 0,
  };

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
    const sorted = sortedSymptoms(symptoms);
    // Keep the CURSOR on screen. The cursor picks the action target, so a card
    // the operator cannot see must never be the thing `a`/`p` would act on.
    // Resolve by ANCHOR first: the engine re-sorts this list on every poll, and
    // a bare index would slide the cursor onto whatever now occupies that slot.
    const anchored = view.remedyAnchorId != null
      ? sorted.findIndex((x) => symptomKey(x) === view.remedyAnchorId)
      : -1;
    const cursor = anchored >= 0
      ? anchored
      : Math.max(0, Math.min(view.remedyCursor ?? 0, sorted.length - 1));
    view.remedyCursor = cursor;
    // Re-anchor to the card actually DRAWN. This is the load-bearing write-back:
    // it makes "what you see" and "what `p` acts on" the same symptom, and `p`
    // is the one action that executes with no CONFIRM box.
    view.remedyAnchorId = sorted[cursor] ? symptomKey(sorted[cursor]) : null;
    const headerRows = body.length; // summary + spacer already pushed

    // Smallest window start that both fits and contains the cursor.
    let start = 0;
    for (;;) {
      let used = headerRows;
      let last = start - 1;
      for (let i = start; i < sorted.length; i++) {
        const len = symptomBlock(sorted[i], now, W, nameOf, ctx.actionsEnabled === true, nodeOf, ledger, i === cursor).length;
        const reserve = i < sorted.length - 1 ? 1 : 0;
        if (used + len > bodyCap - reserve && i > start) break;
        used += len;
        last = i;
      }
      if (last >= cursor || start >= cursor) break;
      start += 1;
    }

    let used = headerRows;
    let shown = 0;
    for (let i = start; i < sorted.length; i++) {
      const blk = symptomBlock(sorted[i], now, W, nameOf, ctx.actionsEnabled === true, nodeOf, ledger, i === cursor);
      const remaining = sorted.length - start - shown;
      // Reserve one line for the "N more" footer whenever blocks remain unshown.
      const reserve = remaining > 1 ? 1 : 0;
      if (used + blk.length > bodyCap - reserve && shown > 0) break;
      for (const r of blk) body.push(r);
      used += blk.length;
      shown += 1;
    }
    const hidden = sorted.length - shown;
    if (hidden > 0) {
      // Guarantee the footer is the LAST visible body line even in the degenerate
      // case where a single oversized block already filled the screen: trim the
      // body so footer lands within frame()'s bodyCap, never silently dropped.
      if (body.length > bodyCap - 1) body.length = Math.max(0, bodyCap - 1);
      const above = start;
      const below = hidden - above;
      // Keep the familiar one-sided form when nothing is scrolled off the TOP;
      // only show the two-sided count once the cursor has moved down the list.
      const where = above > 0 ? `▴${above} ▾${below}` : `▾ ${below}`;
      body.push(truncate(c.yellow(`  ${where} more symptom${hidden === 1 ? '' : 's'} not shown`) + c.grey(' — actionable first, then worst; ↑↓ to reach them'), W));
    }
  }

  const right = symptoms.length ? `${symptoms.length} symptom${symptoms.length === 1 ? '' : 's'}` : 'all clear';
  return frame(view, data, {
    title: 'REMEDY',
    rightStatus: right,
    body,
    keys: [
      ['↑↓', 'SYMPTOM'],
      ['A', 'ACTIONS', 1],
      ['1-9', 'SCREENS'],
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
  // "nothing is acted on" was false ON THIS SCREEN: its own command bar
  // advertises [A] ACTIONS and `p` fires a ping immediately. The true claim is
  // about the ENGINE — it recommends and never executes; the operator does.
  return bits.join(c.grey(' · ')) + c.grey('  —  the engine only recommends; you run the actions');
}
