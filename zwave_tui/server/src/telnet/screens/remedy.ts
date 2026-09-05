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
import { provenance, weight, unscoreableReason, subsumptionLabel } from '../ledgerText';
import { c, truncate, visLen } from '../ansi';
import { frame, fieldStrip, shedLine } from '../chrome';
import { planFor, type PlanCandidate } from '../../zwave/planner';
import { wilsonLower } from '../../zwave/outcomes';

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
/**
 * How far an action's regression rate must clear the control arm's own before
 * the screen will call it harmful (v0.44.0). The same 0.05 the benefit gate
 * uses (`OutcomeStore` cfg.minEffect), restated here because a screen cannot
 * read the store's config — and deliberately NOT a different, looser number:
 * accusing a remedy of harm is at least as consequential as endorsing it.
 */
const HARM_MIN_EFFECT = 0.05;

function efficacyNote(e: Efficacy | null | undefined, blocked = false, width = Infinity): string | null {
  if (!e) return null;

  // WIDTH-AWARE ASSEMBLY (v0.44.0). This note used to be concatenated and then
  // truncate()d, which clipped a measurement mid-digit at ordinary widths: at
  // 80 columns `· 12 nodes` became `· 1`, a complete-looking and wrong node
  // count. chrome.ts states the rule this screen must follow — an undisclosed
  // drop is a smaller lie than a clipped number that reads as a plausible
  // measurement — so every optional clause is now dropped WHOLE, in a fixed
  // priority order, and the richest form that fits is the one rendered.
  const pick = (forms: string[]): string => {
    for (const f of forms) if (visLen(f) <= width) return f;
    return forms[forms.length - 1];
  };

  const heal = e.baseRate == null ? null : `${Math.round(e.baseRate * 100)}% self-heal`;
  const healProv = e.baseN > 0 ? ` (${weight(e.baseN)}${provenance(e.baseNodes, ' · ')})` : '';

  if (!e.ready) {
    // NOT silence (v0.44.0). "Still learning" and "no ledger at all" were
    // rendered identically — as nothing — while the CONTROL arm for this
    // symptom may be fully measured. The self-heal rate is the operator's
    // actual decision input here: if this kind clears itself 80% of the time,
    // that is worth knowing precisely BECAUSE the action is unproven.
    if (heal == null) return null;
    // An arm nobody has ever run is not "still learning" — there is nothing to
    // learn from. Say what IS known: how the kind behaves untouched.
    if (e.n <= 0) {
      return c.grey(pick([
        `≈ never tried here — this kind self-heals ${Math.round(e.baseRate! * 100)}%${healProv}`,
        `≈ never tried here — self-heals ${Math.round(e.baseRate! * 100)}%`,
        '≈ never tried here',
      ]));
    }
    // A below-readiness arm whose attempts have ONLY made things worse is the
    // arm an operator most needs warned about, and the readiness gate is
    // exactly what was silencing it. Said, hedged honestly as too few.
    const early = e.harmed >= 1 && e.harmed >= e.n - 1e-9
      ? ' — ⚠ every attempt so far made it WORSE (too few to be sure)'
      : e.harmed >= 0.5 ? ` — ⚠ ${weight(e.harmed)} of those made it worse` : '';
    const lead = `≈ still learning this action (${weight(e.n)} of ${e.minN})`;
    // `lead` itself is 38 columns before the 8-column indent, so it does NOT
    // fit a 40-column terminal — the shortest form must drop the readiness
    // fraction rather than let it be clipped to "n≈2".
    return c.grey(pick([
      `${lead} — ${heal}${healProv}${early}`,
      `${lead} — ${heal}${early}`,
      `${lead}${early}`,
      lead,
      `≈ still learning${early}`,
      '≈ still learning',
    ]));
  }

  // NOT Math.round (v0.43.1). `n` is a decayed weight, not a tally: seven
  // closures on seven distinct nodes give 6.4005, which rounded to `n=6` beside
  // `· 7 nodes` — a visible self-contradiction on an ordinary run.
  const n = weight(e.n);
  // PROVENANCE (v0.36.5, shared v0.43.1). The arms are marginal by design, so
  // `n≈6.4` reads as six nodes agreeing when it may be one node repeating.
  const prov = provenance(e.nodes, ' · ');

  // HARM, GATED THE SAME WAY BENEFIT IS (v0.44.0, corrected before release).
  //
  // The first cut compared a bare point ratio against 0.2 with no sampling gate
  // and no control comparison, while the BENEFIT claim requires the Wilson
  // lower bound to clear the base rate by the effect size. That asymmetry made
  // harm the cheaper accusation: one regression on one node at n≈4.7 printed a
  // yellow warning against the planner's own recommendation, and moving that
  // single regression earlier in the sequence made it vanish — the decayed n
  // differs by position alone.
  //
  // Three conditions now, each answering one way it was wrong:
  //   - the bound, not the ratio, must clear the bar (sampling error);
  //   - the bar is the CONTROL arm's own regression rate, not its improvement
  //     rate — if this kind self-worsens 35% of the time, an action that
  //     worsens 21% is better than doing nothing;
  //   - at least two distinct nodes, so one flapping device cannot author it.
  const harmRate = e.n > 0 ? e.harmed / e.n : 0;
  const baseHarmRate = e.baseN > 0 ? e.baseHarmed / e.baseN : null;
  const isHarm = e.nodes >= 2
    && baseHarmRate != null
    && wilsonLower(e.harmed, e.n) >= baseHarmRate + HARM_MIN_EFFECT;
  const harmLong = isHarm
    ? `⚠ made it WORSE in ${Math.round(harmRate * 100)}% of ${weight(e.n)}${prov}` +
      ` — leaving it alone: ${Math.round(baseHarmRate! * 100)}% worse`
    : null;
  const harmShort = isHarm ? `⚠ made it WORSE in ${Math.round(harmRate * 100)}%` : null;

  if (e.expectedEfficacy != null) {
    const pct = Math.round(e.expectedEfficacy * 100);
    // The harm note is APPENDED, never substituted (v0.44.0). Returning early
    // on harm suppressed a granted claim that ENGINE rendered in green from the
    // same ledger row — two screens, one row, opposite conclusions. An action
    // can genuinely help most of the time and hurt some of the time; that is
    // one finding, not two competing ones.
    const head = blocked ? `⚠ ledger measured ${pct}% here` : `✓ helped ${pct}%`;
    const tailBlocked = blocked ? ' — the block above still applies' : '';
    const vs = heal == null ? '' : ` vs ${heal}`;
    // Ordered richest-first. The last entry must fit the NARROWEST supported
    // terminal unaided, because `pick` falls back to it and the caller then
    // truncates — which is the clipping this whole assembly exists to avoid.
    // When both a block and a harm finding are present the block REMINDER is
    // shed first: the block itself is already rendered on the row above, so
    // that clause is a restatement, while the harm is new information.
    const forms = harmShort != null
      ? [
          `${head} (${n}${prov})${vs}${healProv}${tailBlocked} — ${harmLong}`,
          `${head} (${n}${prov})${vs}${tailBlocked} — ${harmLong}`,
          `${head} (${n}${prov})${tailBlocked} — ${harmShort}`,
          `${head}${tailBlocked} — ${harmShort}`,
          `${head} — ${harmShort}`,
          harmLong!,
          harmShort,
        ]
      : [
          `${head} (${n}${prov})${vs}${healProv}${tailBlocked}`,
          `${head} (${n}${prov})${vs}${tailBlocked}`,
          `${head} (${n}${prov})${tailBlocked}`,
          `${head}${tailBlocked}`,
          head,
        ];
    // Yellow whenever the row carries a caveat — a blocked framing or a harm
    // finding must never be rendered in the endorsing green.
    return (blocked || harmShort != null) ? c.yellow(pick(forms)) : c.green(pick(forms));
  }

  if (harmLong != null) {
    return c.yellow(pick([harmLong, harmShort!]));
  }

  // WHY it is not distinguishable (v0.43.1). "Not distinguishable" was the
  // engine's most common verdict and its least explicable: the WILSON LOWER
  // BOUND — not the point estimate — is what must clear the base rate, and by
  // how much. Against the BAR, not the bare base rate: the gate is
  // `lower >= base + minEffect`, so reporting the bound against `base` alone
  // reads as a win beneath a verdict that withheld one.
  const lead = blocked ? `≈ ${n}${prov}: measured — not distinguishable from self-healing`
                       : `≈ ${n}${prov}: not distinguishable from self-healing`;
  const leadShort = `≈ ${n}: not distinguishable`;
  const why = e.lowerBound == null ? ''
    : heal != null && e.bar != null
      ? ` — even pessimistically ${Math.round(e.lowerBound * 100)}%, short of the ` +
        `${Math.round(e.bar * 100)}% bar (${heal} + margin)`
      : ` — even pessimistically ${Math.round(e.lowerBound * 100)}%, and self-heal is not measured yet`;
  return c.grey(pick([`${lead}${why}`, lead, leadShort]));
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
  /** Can the liveness sweep probe this node at all (v0.47.0)? */
  probeable: (nodeId: number) => boolean | null;
  /** Verification probes still owed for THIS node (v0.47.0). */
  verifyOwedFor: (nodeId: number) => number;
}

/**
 * Rationale text that must reach the operator wherever its candidate ranks
 * (v0.45.0) — irreversible side effects and known failure modes.
 *
 * The grounding line used to render for `i === 0` only, so a destructive
 * caveat on a second-ranked candidate was invisible at every terminal size.
 * Matching on the CAVEAT rather than on the index keeps the row budget while
 * making sure the sentence an operator cannot afford to miss is the one that
 * survives.
 */
const CAVEAT = /deletes|discards|priority route|half-interviewed|comes back|re-churn/i;

function symptomBlock(sym: Symptom, now: number, W: number, nameOf: (id: number) => string, writeActions: boolean, nodeOf: (id: number) => NodeSnapshot | undefined, ledger: Ledger, selected = false): string[] {
  const { efficacyFor } = ledger;
  const rows: string[] = [];
  const who = sym.nodeId != null ? c.cyan(`#${sym.nodeId} ${nameOf(sym.nodeId)}`) : c.blue('MESH');
  // Compact basis GLYPH placed right after severity so it survives truncation at
  // 40 cols — it is the only measured-vs-inferred guardrail and must never be
  // clipped off the row (v0.14 review). Full word repeated on the evidence line.
  const glyph = sym.basis === 'measured' ? c.green('◆') : c.yellow('◇');
  const subsumed = sym.subsumedBy
    ? c.grey(subsumptionLabel(sym.subsumedBy, ' · '))
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
  // MEMBERS, as atomic tokens (v0.45.0). `Symptom.members` was populated by the
  // edge-cluster detector and read by NOTHING; the ids survived only inside an
  // evidence string that `truncate` cut mid-list — so `#4, #17, #23` became
  // `#4, #17, #2`, naming an innocent node as degraded. shedLine drops whole
  // ids with a `+N`, because a half-shed id is a different device.
  if (sym.members?.length) {
    rows.push(...shedLine('    ', c.grey('downstream'), sym.members.map((m) => c.white(`#${m}`)), W));
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
  // WHY there are no ledger rows at all, for kinds where that is permanent
  // (v0.44.0). Silence here is not neutral: every other kind accumulates an
  // efficacy record, so a kind that never accumulates one reads as "still
  // learning", indefinitely. For node-down the loop is not slow — it is
  // structurally off, and will never turn on. UNGATED on the ledger counters,
  // because the whole point is that they will always be zero.
  // WHY THIS CARD HAS NO SCORE, when the reason is about the NODE rather than
  // the kind (v0.47.0). A node the sweep can never probe accumulates evidence
  // that can never be filled, so its episodes close `unverifiable` by
  // construction — and until now the card said nothing, leaving "no measurement
  // yet" indistinguishable from "no measurement is possible".
  if (sym.nodeId != null) {
    const canProbe = ledger.probeable(sym.nodeId);
    const owed = ledger.verifyOwedFor(sym.nodeId);
    if (canProbe === false) {
      rows.push(truncate('    ' + c.grey(
        '○ this device cannot be probed (sleeping/FLiRS) — its evidence windows ' +
        'can never be filled, so outcomes here stay unscoreable'), W));
    } else if (owed > 0) {
      rows.push(truncate('    ' + c.grey(
        `○ ${owed} verification probe${owed === 1 ? '' : 's'} still owed — the score is pending, not absent`), W));
    }
  }
  const noScore = unscoreableReason(sym.kind);
  // WRAPPED, not truncated (v0.44.0). The sentence needs ~185 columns; emitted
  // as one truncate()'d row it was cut mid-word at every realistic terminal, so
  // the disclosure disclosed nothing. There is ample vertical room here.
  if (noScore) {
    for (const line of wrap(`○ ${noScore}`, W - 4)) rows.push(truncate('    ' + c.grey(line), W));
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
      // The BLOCKED CHIP is never clipped (v0.45.0). This row was one
      // concatenation ending in `truncate`, and the ⊘ reason sits last — so at
      // the 80-column default the longest blocked candidate came back as
      // `⊘ RF-link symptom — re-interviewing will not r`: a sentence that stops
      // making sense on the one row whose entire job is to say why NOT to act.
      // shedLine carries it to a continuation row instead.
      // THE TAG IS ALL-OR-NOTHING (v0.51.0). shedLine's HEAD has no whole-token
      // degradation path — `if (visLen(headRow) > cols) return [truncate(...)]`
      // — so at the modal 80 columns the longest candidate ended `[physical`,
      // an unbalanced bracket that silently dropped ` · lore]`: the candidate's
      // provenance, the difference between "we measured this" and "this is
      // folklore". Shed it whole with `+1` instead, the same convention
      // detail.ts uses. Measured over a 750-scenario sweep: 474 clipped rows to
      // 0, with no card lost at 80x24 and none at 40 either.
      const headBase = `${marker} ${c.white(cand.title)}`;
      const tagged = `${headBase} ${tags}`;
      rows.push(...shedLine(
        '      ',
        visLen('      ' + tagged) <= W ? tagged : headBase + c.grey(' +1'),
        cand.blocked ? [c.grey('⊘ ' + cand.blocked)] : [],
        W,
        /* wrapTail */ true,
      ));
      // GROUNDING is no longer gated on index alone (v0.45.0). `i === 0` meant
      // a candidate at index >= 1 rendered its rationale at NO terminal size —
      // so healNode's "DELETES any manually-set priority routes" was
      // unreachable whenever something else ranked above it, and widening the
      // terminal never helped. A caveat earns its line wherever it sits.
      //
      // Deliberately NOT `i === 0 || cand.blocked != null`: planner.ts blocks
      // EVERY executable when write actions are off, so on a read-only install
      // that form would ground all three candidates on every card and blow the
      // row budget.
      const rl = wrap(cand.rationale, W - 8);
      const caveatLine = rl.find((l) => CAVEAT.test(l));
      if (i === 0 || caveatLine != null) {
        const pick = i === 0 ? (caveatLine ?? rl[0]) : caveatLine;
        if (pick != null) rows.push(truncate('        ' + c.grey(pick + (rl.length > 1 ? ' …' : '')), W));
      }
      // M5: the learned efficacy note. Every candidate the ledger can have an
      // opinion about gets one — i.e. every candidate with an action, blocked or
      // not. efficacyNote() carries the blocked framing so a "NOT recommended"
      // row can report a measurement without ever reading as an endorsement.
      if (cand.action != null) {
        // The note is assembled to FIT — 8 columns of indent — so a narrow
        // terminal drops a whole clause instead of half a number.
        const note = efficacyNote(cand.efficacy, cand.blocked != null, W - 8);
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

/**
 * Names the time-of-day band a baseline count was measured in (v0.43.1).
 *
 * Every graduation count `engineStatus` returns is scoped to the band
 * containing NOW — `bandOf` in baselines.ts is `hour / (24 / N_BANDS)` — and
 * the screen used to state those counts as timeless facts. With the default
 * six bands this reads "the 12:00–16:00 band"; the arithmetic is derived from
 * `bands` so it stays honest if that constant ever moves.
 */
function bandLabel(eng: { band: number; bands: number }, compact = false): string {
  if (!Number.isFinite(eng.bands) || eng.bands <= 0) return 'this time of day';
  const width = 24 / eng.bands;
  if (!Number.isInteger(width)) return `band ${eng.band + 1}/${eng.bands}`;
  const from = eng.band * width;
  // The last band ends at 24:00, not 00:00 — a range that appears to wrap back
  // to its own start reads as zero-length. `from + width` never exceeds 24.
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  // The compact form exists so the qualifier SURVIVES a 40-column terminal.
  // Truncation drops it from the right-hand end, and a headline that has lost
  // its band is exactly the timeless assertion this release removes.
  return compact ? `${from}–${from + width}h` : `the ${hh(from)}–${hh(from + width)} band`;
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
    // `null` means the provider predates these (v0.47.0) — NOT "false". A
    // fabricated "cannot be probed" would explain a missing score with a fact
    // nobody established.
    probeable: (nodeId) => data.probeable?.(nodeId) ?? null,
    verifyOwedFor: (nodeId) => data.verifyOwedFor?.(nodeId) ?? 0,
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
    } else if (eng.total === 0) {
      // The engine is on and has nothing to be on ABOUT (v0.43.1). Every count
      // below is 0/0, which passes all three "fully graduated" comparisons —
      // so this used to render the green all-clear, asserting three graduated
      // series and a measurement band from zero observations. That is the state
      // at boot, before the first roster poll returns.
      body.push(c.cyan('    ◷ No nodes yet.'));
      body.push('');
      body.push(c.grey('    The engine is running but the roster is empty — nothing has been'));
      body.push(c.grey('    measured, so nothing can be diagnosed or cleared. This is normal'));
      body.push(c.grey('    for the first seconds after a restart.'));
    } else {
      // Which DETECTORS cannot judge every node in THIS band, and on how many.
      //
      // Only two of the three series arm a detector: `grep -n 'baselines\.'
      // src/zwave/symptoms.ts` returns exactly `timeoutNormal` and `rttNormal`.
      // `rssiNormal` has ZERO detector consumers — weak-signal compares against
      // an absolute 7 dB margin over the measured noise floor, never the
      // learned baseline — so its only readers are the DETAIL dossier row and
      // the counter below.
      //
      // v0.46.0 got this wrong twice: it gated the green all-clear on rssi
      // readiness, making a DETECTION claim depend on a series that arms no
      // detector, and it said of every blind column that "a degradation on
      // those nodes would not be flagged", which is false for rssi. Coverage is
      // per node, per series, per band — and only the arming series bear on
      // whether something can be caught.
      const blind = ([
        ['timeout', eng.total - eng.timeoutReady],
        ['rtt', eng.total - eng.rttReady],
      ] as const).filter(([, n]) => n > 0);
      const rssiShort = eng.total - eng.rssiReady;
      // Richest headline that FITS. The band qualifier is the part that must
      // survive — a headline without it is the timeless assertion v0.43.1
      // removed — so the ladder sheds words, never the band.
      const pickHead = (forms: string[]): string => {
        for (const f of forms) if (visLen(f) <= W) return f;
        return forms[forms.length - 1];
      };
      const counts = (): string[] => [
        c.grey(`      timeouts ${eng.timeoutReady}/${eng.total}`),
        c.grey(`rtt ${eng.rttReady}/${eng.total}`),
        c.grey(`rssi ${eng.rssiReady}/${eng.total}`),
      ];
      // The ledger's open episodes belong to EVERY no-symptom state, not just
      // the green one (v0.46.0). An episode in its confirmation window has no
      // live symptom by construction, so any empty state can be hiding one.
      // Gating this on FULL coverage put it behind a gate this mesh cannot
      // pass — see the partial-coverage branch below.
      // rssi is reported wherever it is short, but never counted as blindness:
      // it arms no detector, so an ungraduated rssi baseline costs the DOSSIER a
      // row and costs detection nothing. It belongs under the all-clear as much
      // as under partial coverage — "everything is graduated" would otherwise be
      // read as covering it.
      const rssiNote = (): string[] => (rssiShort > 0
        ? [truncate(c.grey(`    (rssi is short on ${rssiShort} — a dossier yardstick only, it arms no detector.)`), W)]
        : []);
      const episodeLine = (): string[] => {
        const openEps = data.openEpisodes() ?? [];
        if (openEps.length === 0) return [];
        const confirming = openEps.filter((e) => e.confirming).length;
        return [truncate(c.grey(`    ◷ The ledger is still scoring ${openEps.length} episode${openEps.length === 1 ? '' : 's'}` +
          (confirming > 0 ? ` (${confirming} in the confirmation window)` : '') + ' — see ENGINE.'), W)];
      };

      if (eng.timeoutReady === 0 && eng.rttReady === 0) {
        // NOTHING has graduated. Deliberately silent about symptoms: with no
        // detector able to fire, "no symptoms" would describe the instrument.
        body.push(c.cyan(pickHead([
          `    ◷ Learning — no detector has a yardstick yet for ${bandLabel(eng)}:`,
          `    ◷ Learning — no yardstick yet for ${bandLabel(eng, true)}:`,
          `    ◷ Learning — none yet, ${bandLabel(eng, true)}:`,
        ])));
        body.push('');
        body.push(fieldStrip(view, counts()));
        body.push('');
        body.push(c.grey('    Each node’s normal is learned per series and per time-of-day band,'));
        body.push(c.grey('    from the evidence stream across several distinct days, before its'));
        body.push(c.grey('    detectors may fire. Nothing here is a health claim yet.'));
      } else if (blind.length > 0) {
        // PARTIAL COVERAGE (v0.46.0) — the steady state on any mesh with routed
        // nodes, and the state v0.44.0 rendered as "Learning" forever.
        //
        // MEASURED on this fleet 2026-08-31: the ceiling is 23 of 38, the
        // DIRECT-routed subset, not 38. `baselines.observe()` resets rssi/rtt
        // across all six bands on any route change (by design — a new route
        // legitimately shifts both), and those series fold only on FRESH
        // samples: ~410-922 fresh of 363,586 lifetime ≈ 1.5-3.3 per band per
        // day against MIN_OBS 20. So a repeater-routed node must hold ONE route
        // for ~2 weeks to graduate a single band, and the green gate needs all
        // 15 routed nodes to do it simultaneously — in a mesh whose own
        // route-churn detector fires. That gate does not close.
        //
        // "Learning" implied a convergence that never arrives. This says what
        // is actually true: no symptoms are firing, AND some detectors cannot
        // fire at all — which is a statement about COVERAGE, not health.
        body.push(c.cyan(pickHead([
          `    ◑ No symptoms — partial detector coverage for ${bandLabel(eng)}:`,
          `    ◑ No symptoms — partial coverage, ${bandLabel(eng, true)}:`,
          `    ◑ No symptoms — partial, ${bandLabel(eng, true)}:`,
        ])));
        body.push('');
        body.push(fieldStrip(view, counts()));
        body.push('');
        const which = blind.map(([name, n]) => `${name} (${n})`).join(', ');
        body.push(truncate(c.grey(`    No detector yardstick in this band: ${which} of ${eng.total} nodes.`), W));
        body.push(c.grey('    A degradation on those nodes would not be flagged, so this is a'));
        body.push(c.grey('    statement about COVERAGE, not health. Baselines reset on a route'));
        body.push(c.grey('    change, so routed nodes may never graduate.'));
        body.push(...rssiNote());
        body.push(...episodeLine());
      } else {
        // FULL coverage in this band. "All clear" is a claim about the WHOLE
        // engine, and this screen only knows about live symptoms (v0.43.1).
        body.push(c.green(`    ✓ All clear — ${eng.total} nodes learned, no symptoms detected.`));
        body.push('');
        body.push(truncate(c.grey('    Every node has a graduated timeout and rtt baseline — the two'), W));
        body.push(truncate(c.grey('    that arm a detector —'), W));
        const bandLine = `    for ${bandLabel(eng)}, and none is currently anomalous.`;
        body.push(c.grey(visLen(bandLine) <= W ? bandLine
          : `    for ${bandLabel(eng, true)}, none anomalous.`));
        body.push(...rssiNote());
        const eps = episodeLine();
        if (eps.length) body.push(...eps);
        else body.push(c.grey('    New symptoms will surface here — advisory-first, nothing is acted on.'));
      }
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
