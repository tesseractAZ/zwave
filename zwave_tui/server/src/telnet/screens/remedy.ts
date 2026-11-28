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
import { c, clipWords, truncate, visLen } from '../ansi';
import { frame, fieldStrip, shedLine, wrapWords } from '../chrome';
import { planFor, type PlanCandidate } from '../../zwave/planner';
import { summonsHeadline } from '../../zwave/recommendation';
import type { AutoPingNodeState } from '../../zwave/autoPing';
import { wilsonLower, metricOf } from '../../zwave/outcomes';
import { RTT_CEILING_MS } from '../../zwave/symptoms';

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
    // A below-readiness arm whose attempts have ONLY made things worse is the
    // arm an operator most needs warned about, and the readiness gate is
    // exactly what was silencing it. Said, hedged honestly as too few.
    const early = e.harmed >= 1 && e.harmed >= e.n - 1e-9
      ? ' — ⚠ every attempt so far made it WORSE (too few to be sure)'
      : e.harmed >= 0.5 ? ` — ⚠ ${weight(e.harmed)} of those made it worse` : '';
    // The warning without its hedge (v0.80.0), so it outlasts the readiness
    // fraction at 80 columns: the fraction beside it already says "too few".
    // Where even that does not fit, a rung that keeps the warning comes ahead
    // of the bare fraction: `≈ still learning — ⚠ every try made it WORSE` at
    // 60 columns, and below the fraction the warning alone after the `≈`, which
    // fits 40.
    const earlyShort = e.harmed >= 1 && e.harmed >= e.n - 1e-9
      ? ' — ⚠ every try made it WORSE'
      : e.harmed >= 0.5 ? ` — ⚠ ${weight(e.harmed)} made it worse` : '';
    const lead = `≈ still learning this action (${weight(e.n)} of ${e.minN})`;
    // NO CONTROL ARM IS NOT NO ATTEMPTS (v0.80.0). This returned null whenever
    // the kind's self-heal rate was unmeasured, before `n` or the harm warning
    // above were looked at — so an arm tried 2.9 times, every one of them
    // making it worse, rendered the same silence as one never tried at all.
    // Only an arm with no attempts and no base rate has nothing to say.
    if (heal == null) {
      if (e.n <= 0) return null;
      return c.grey(pick([
        `${lead} — self-heal not yet measured${early}`,
        `${lead}${early}`,
        `${lead}${earlyShort}`,
        ...(early ? [`≈ still learning${earlyShort}`] : []),
        lead,
        ...(early ? [`≈${earlyShort.slice(2)}`] : []),
        `≈ still learning${early}`,
        '≈ still learning',
      ]));
    }
    // An arm nobody has ever run is not "still learning" — there is nothing to
    // learn from. Say what IS known: how the kind behaves untouched.
    if (e.n <= 0) {
      return c.grey(pick([
        `≈ never tried here — this kind self-heals ${Math.round(e.baseRate! * 100)}%${healProv}`,
        `≈ never tried here — self-heals ${Math.round(e.baseRate! * 100)}%`,
        '≈ never tried here',
      ]));
    }
    // `lead` itself is 38 columns before the 8-column indent, so it does NOT
    // fit a 40-column terminal — the shortest form must drop the readiness
    // fraction rather than let it be clipped to "n≈2".
    return c.grey(pick([
      `${lead} — ${heal}${healProv}${early}`,
      `${lead} — ${heal}${early}`,
      `${lead}${early}`,
      `${lead}${earlyShort}`,
      ...(early ? [`≈ still learning${earlyShort}`] : []),
      lead,
      ...(early ? [`≈${earlyShort.slice(2)}`] : []),
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
          // SHORTER RUNGS THAT STILL SAY BLOCKED (v0.55.0). Simply refusing to
          // shed the long qualifier only moved the defect: the row then
          // exceeded the width and the CALLER truncated it to "— the block
          // above still", a clipped clause, which is the same §12.10 violation
          // one layer down. These forms are whole sentences that fit the floor.
          ...(blocked ? [`⚠ ledger measured ${pct}% — still blocked`, `⚠ measured ${pct}% — blocked`] : []),
          // THE QUALIFIER IS NOT AN OPTIONAL RUNG ON THIS LADDER (v0.55.0).
          // Every other rung sheds something the operator can live without; the
          // block reminder is not one of them. Falling through to bare `head`
          // rendered `⚠ ledger measured 100% here` alone under a SAFETY-gated
          // action — the endorsement-shaped reading this note exists to prevent.
          // MEASURED band where it mattered: 60-66 columns depending on the
          // percentage's digit count, which is the supported FLOOR (session.ts
          // clamps to [60,200]) — a narrow HA ingress sidebar sits exactly there.
          // Scoped to the no-harm ladder only: the harm ladder above still sheds
          // this clause first, because a harm finding is NEW information while
          // the block is already rendered on the row above.
          ...(blocked ? [] : [head]),
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
  /** No-action closures confounded by a mid-episode death/remediation (v0.40),
   *  or a re-route by our own measurement read (v0.71.0), during the episode or,
   *  since v0.78.0, just before it opened. */
  confounded: (kind: SymptomKind) => number;
  /** Can the liveness sweep probe this node at all (v0.47.0)? */
  probeable: (nodeId: number) => boolean | null;
  /** Verification probes still owed for THIS node (v0.47.0). */
  verifyOwedFor: (nodeId: number) => number;
  /** An auto-ping runner exists (v0.79.9). Without one no verification probe
   *  is sent, and none is booked (zwaveData.requestVerification). */
  laneLive: boolean;
  /** The dead-node ladder's per-node state; empty with no runner (v0.79.9). */
  apNodes: () => readonly AutoPingNodeState[];
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
const PRIORITY = /priority route/i;

/**
 * The caveat a candidate must show, whole, in `width` columns (v0.80.0), or
 * null when its rationale carries none. The sentence naming priority routes
 * comes first — it is the side effect an operator cannot undo — then any other
 * CAVEAT sentence. A sentence that does not fit gives way to the clause inside
 * it that carries the caveat, marked `… ` as part of a longer sentence; past
 * that, clipWords of the clause.
 */
function caveatText(rationale: string, width: number): string | null {
  if (width <= 0) return null;
  const sentences = rationale.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((x) => PRIORITY.test(x)) ?? sentences.find((x) => CAVEAT.test(x));
  if (hit == null) return null;
  if (visLen(hit) <= width) return hit;
  const re = PRIORITY.test(hit) ? PRIORITY : CAVEAT;
  const clause = hit.split(/;\s+|\s+—\s+|,\s+(?=and |but )/).find((x) => re.test(x)) ?? hit;
  return clipWords(clause === hit ? hit : `… ${clause}`, width);
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
  // One TOKEN per measurement (v0.80.0). This row was one join and a blind
  // truncate, so at 80 columns weak-signal's `failed deliveries 13 …` lost its
  // window and rtt-degraded's restart allowance stopped mid-word. shedLine
  // drops whole measurements with a `+N`, and carries them to continuation
  // rows only where not even the first one fits beside the basis word.
  {
    const basisWord = sym.basis === 'measured' ? c.green('measured') : c.yellow('inferred');
    // The two-space separator the row always used (v0.80.0): several values
    // carry a ` · ` of their own (`38±6ms · capped at 300ms`), and a qualifier
    // set off by the same mark reads as a separate measurement.
    rows.push(...shedLine('    ', basisWord, sym.evidence.map((e) => `${c.label(e.label)} ${c.white(e.value)}`), W, /* wrapTail */ true, c.grey('  ·  ')));
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
  // WHOLE FORMS, NEVER A BLIND CUT (v0.80.0). Each tally line below was one
  // sentence and a `truncate`, so at 80 columns they ended `weigh the evidence
  // a`, `too few readings to ju`, `probe re-` — the count survived and the
  // clause explaining it stopped mid-word. Each now picks the longest whole
  // form that fits, with clipWords as the floor. No line wraps: the screen
  // does not scroll, and a taller card would push the plan off the frame.
  const tally = (forms: string[], tone: (x: string) => string = c.grey): string =>
    '    ' + tone(clipWords(forms.find((f) => visLen(f) <= W - 4) ?? forms[forms.length - 1], W - 4));
  {
    const fp = ledger.falsePositives(sym.kind);
    if (fp > 0) {
      rows.push(tally([
        `⚠ this detector has been refused as a misdiagnosis ${fp}\u00d7 — weigh the evidence above before acting`,
        `⚠ this detector has been refused as a misdiagnosis ${fp}\u00d7 — weigh the evidence`,
        `⚠ refused as a misdiagnosis ${fp}\u00d7 — weigh the evidence`,
        `⚠ refused as misdiagnosis ${fp}\u00d7`,
      ], c.yellow));
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
      const eps = `past episode${unver === 1 ? '' : 's'}`;
      rows.push(tally([
        `○ ${unver} ${eps} of this kind could not be scored — too few readings to judge recovery`,
        `○ ${unver} ${eps} could not be scored — too few readings to judge recovery`,
        `○ ${unver} ${eps} could not be scored — too few readings`,
        `○ ${unver} unscoreable — too few readings`,
        `○ ${unver} unscoreable`,
      ]));
    }
    const unprobe = ledger.unverifiableUnprobeable(sym.kind);
    if (unprobe > 0) {
      const dev = `sleeping device${unprobe === 1 ? '' : 's'}`;
      rows.push(tally([
        `○ ${unprobe} more on ${dev} that cannot be probed — unscoreable by design, not a gap`,
        `○ ${unprobe} more on ${dev} that cannot be probed — by design`,
        `○ ${unprobe} unprobeable — unscoreable by design`,
        `○ ${unprobe} unprobeable — by design`,
      ]));
    }
    const transient = ledger.unverifiableTransient(sym.kind);
    if (transient > 0) {
      const blinks = `transient blink${transient === 1 ? '' : 's'}`;
      rows.push(tally([
        `○ ${transient} ${blinks} — over before the evidence floor filled; unscoreable by design, not a gap`,
        `○ ${transient} ${blinks} — over before the evidence floor filled`,
        `○ ${transient} ${blinks} — unscoreable by design`,
        `○ ${transient} ${blinks}`,
      ]));
    }
    const under = ledger.unverifiableUndersampled(sym.kind);
    if (under > 0) {
      rows.push(tally([
        `○ ${under} could not be scored at this device's reporting rate — it had the time, never the readings`,
        `○ ${under} could not be scored at this device's reporting rate`,
        `○ ${under} undersampled — the device reports too rarely`,
        `○ ${under} undersampled`,
      ]));
    }
    const conf = ledger.confounded(sym.kind);
    if (conf > 0) {
      rows.push(tally([
        `○ ${conf} confounded — credited to neither arm (a death, remediation or probe re-route during or just before the episode)`,
        `○ ${conf} confounded — credited to neither arm (a death, remediation or probe re-route)`,
        `○ ${conf} confounded — credited to neither arm`,
        `○ ${conf} confounded`,
      ]));
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
      rows.push(tally([
        '○ this device cannot be probed (sleeping/FLiRS) — its evidence windows can never be filled, so outcomes here stay unscoreable',
        '○ this device cannot be probed (sleeping/FLiRS) — outcomes here stay unscoreable',
        '○ cannot be probed (sleeping/FLiRS) — unscoreable here',
        '○ cannot be probed — unscoreable',
      ]));
    } else if (!ledger.laneLive && unscoreableReason(sym.kind) == null && metricOf(sym.kind) !== 'none') {
      // NO RUNNER, NO VERIFICATION LANE (v0.79.9): index.ts starts both
      // together. Each kind's evidence floor counts readings of its own signal
      // from any traffic, not only probe replies, so an episode of a kind with
      // a recovery metric can still be scored: unaided, not ruled out. A kind
      // whose metric is 'none' (ghost-suspect, chatty-device, edge-cluster)
      // has no recovery for any traffic to score, so its card gets no such
      // line. "Pending" would promise probes nothing sends.
      const forms = [
        '    ○ auto-ping is off — no verification probes are sent; any score must come from the node’s other traffic',
        '    ○ auto-ping off — any score must come from other traffic',
        '    ○ auto-ping off: no verify probes',
      ];
      rows.push(c.grey(clipWords(forms.find((f) => visLen(f) <= W) ?? forms[forms.length - 1], W)));
    } else if (owed > 0) {
      const probes = `verification probe${owed === 1 ? '' : 's'}`;
      rows.push(tally([
        `○ ${owed} ${probes} still owed — the score is pending, not absent`,
        `○ ${owed} ${probes} still owed — score pending`,
        `○ ${owed} verify probe${owed === 1 ? '' : 's'} owed — pending`,
      ]));
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
    // A LADDER THAT SPENT ITS ATTEMPTS (v0.79.9). The planner's node-down
    // headline says a ping often revives the node: true before the ladder
    // runs, false once it gave up. The HA sensor's summons says what the
    // ladder did, and so does this card now, in the same words.
    const spent = sym.kind === 'node-down'
      ? ledger.apNodes().find((n) => n.nodeId === sym.nodeId && (n.gaveUp || n.launchGaveUp))
      : undefined;
    // The sensor's words where they fit, then shorter whole forms of the same
    // claim; clipWords is only the floor. "Not tested", and the forms that say
    // no ping left, only where none did: once a ping went unanswered, every
    // width says so.
    const tried = spent?.attempts ?? 0;
    const spentForms = spent == null ? [] : spent.launchGaveUp && !spent.gaveUp
      ? (tried === 0
        ? [summonsHeadline(spent),
          'Node is DOWN — auto-ping could not send its pings; node not tested',
          'Node is DOWN — auto-ping could not send its pings',
          'DOWN — auto-ping pings not sent']
        : [summonsHeadline(spent),
          `Node is DOWN — auto-ping could not send its pings; ${tried} went unanswered`,
          `Node is DOWN — ${tried} unanswered, then pings not sent`,
          `DOWN — ${tried} unanswered, then unsent`,
          `DOWN — ${tried} unanswered`])
      : [summonsHeadline(spent),
        `Node is DOWN — auto-ping gave up after ${tried} attempt${tried === 1 ? '' : 's'}`,
        `DOWN — auto-ping gave up (${tried} ${tried === 1 ? 'try' : 'tries'})`,
        'DOWN — auto-ping gave up'];
    // The planner's headline the same way (v0.80.0): its own words, then its
    // short form where it has one, clipWords as the floor — edge-cluster's
    // ended `not each no` at 80 under a blind truncate.
    const headForms = spent ? spentForms : [plan.headline, ...(plan.headlineShort ? [plan.headlineShort] : [])];
    rows.push('    ' + c.label('▎ ') + c.white(clipWords(headForms.find((f) => visLen(f) <= W - 6) ?? headForms[headForms.length - 1], W - 6)));
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
      // A SHORT TITLE BEFORE A SHED TAG (v0.80.0). Four titles are 70-80
      // columns, so with the 8-column indent they overflowed 80 on their own:
      // shedLine clipped the head and the `+1` that discloses the shed tag went
      // with it — mesh-interference's survey row ended `measurement needed to`
      // with its `[physical · inference]` silently gone. The order: the title
      // with its tag, the short title with its tag, either with `+1`, and the
      // short title clipped to whole words with `+1` as the floor.
      const titles = [cand.title, ...(cand.short ? [cand.short] : [])];
      const fits = (h: string): boolean => visLen('      ' + h) <= W;
      const headOf = (t: string): string => `${marker} ${c.white(t)}`;
      const head = titles.map((t) => `${headOf(t)} ${tags}`).find(fits)
        ?? titles.map((t) => headOf(t) + c.grey(' +1')).find(fits)
        ?? headOf(clipWords(titles[titles.length - 1], Math.max(1, W - 6 - 2 - 3))) + c.grey(' +1');
      rows.push(...shedLine(
        '      ',
        head,
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
      // THE CAVEAT IS CHOSEN BY SENTENCE (v0.80.0), not by wrapped line. A
      // wrap can split "priority" from "routes", and the line picked then lost
      // its object — healNode read `…deletes any manually-set priority …` at 80
      // — while the 8-space indent ate the ` …` at 120. The sentence that names
      // priority routes wins; one too wide gives way to its own clause, and
      // clipWords at W-8 is the floor, so the marker always fits.
      const caveat = caveatText(cand.rationale, W - 8);
      const ground = caveat ?? (i === 0 ? clipWords(cand.rationale, W - 8) : null);
      if (ground != null && ground !== '') rows.push('        ' + c.grey(ground));
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

/** Which of REMEDY's five no-symptom states the body rendered (v0.52.0). */
type EmptyState = 'disabled' | 'no-nodes' | 'learning' | 'partial' | 'clear';

/** Total by construction: a new EmptyState fails the typecheck until it is
 *  given a token, rather than quietly inheriting "all clear". */
const EMPTY_TOKEN: Record<EmptyState, string> = {
  clear: 'all clear',
  disabled: 'engine off',
  'no-nodes': 'no roster',
  learning: 'learning',
  partial: 'no symptoms · partial coverage',
};

export function renderRemedy(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const W = view.cols;
  const now = Date.now();
  const symptoms = data.symptoms();
  const nameOf = (id: number): string => data.nodeById(id)?.name ?? `Node ${id}`;
  const nodeOf = (id: number): NodeSnapshot | undefined => data.nodeById(id);
  // An auto-ping runner exists (v0.79.9): its snapshot is null exactly when
  // index.ts started none. A CAPABILITY, so it stays true while paused or
  // suppressed — the runner can write again without a keypress.
  const autonomous = (data.autoPingState?.() ?? null) != null;
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
    laneLive: autonomous,
    apNodes: () => data.autoPingState?.()?.nodes ?? [],
  };

  /**
   * Which empty state the body actually rendered — so the title rule agrees
   * with the paragraph two rows below it (v0.52.0).
   *
   * The rule read `all clear` in ALL FIVE no-symptom states, including
   * `● Engine disabled.` and the PERMANENT partial-coverage state whose own
   * body says, in as many words, that it is "a statement about COVERAGE, not
   * health". The one word an operator scans first contradicted the paragraph
   * that exists to stop them reading it that way.
   *
   * A total Record, not a ternary chain: adding a sixth empty state becomes a
   * TYPE ERROR instead of silently inheriting the previous branch's claim.
   */
  let empty: EmptyState | null = null;

  const body: string[] = [];
  if (symptoms.length === 0) {
    // Three honest, DISTINCT empty states (v0.14 review): engine off vs still
    // learning vs genuinely all-healthy — never rendered identically.
    const eng = data.engineStatus();
    body.push('');
    // A paragraph hard-wrapped for 80 columns, re-flowed where it is wider
    // than the terminal (v0.80.0): kept line for line where every line fits,
    // so the familiar text is unchanged, and word-wrapped otherwise — at 40
    // columns the all-clear's first line was cut blind, and at 60 the
    // disabled and no-nodes paragraphs were. Each of the five empty states'
    // paragraphs goes through it, and the two-line ceiling note; the one-line
    // notes pick from ladders of their own.
    const para = (lines: string[]): string[] => (lines.every((l) => visLen(l) <= W)
      ? lines
      : wrapWords(lines.map((l) => l.trim()).join(' '), Math.max(8, W - 4)).map((l) => '    ' + l));
    if (!eng.enabled) {
      empty = 'disabled';
      body.push(c.yellow('    ● Engine disabled.'));
      body.push('');
      body.push(...para([
        '    The symptom engine is not running on this install (no baselines',
        '    store configured), so nothing is being diagnosed.',
      ]).map((l) => c.grey(l)));
    } else if (eng.total === 0) {
      // The engine is on and has nothing to be on ABOUT (v0.43.1). Every count
      // below is 0/0, which passes all three "fully graduated" comparisons —
      // so this used to render the green all-clear, asserting three graduated
      // series and a measurement band from zero observations. That is the state
      // at boot, before the first roster poll returns.
      empty = 'no-nodes';
      body.push(c.cyan('    ◷ No nodes yet.'));
      body.push('');
      body.push(...para([
        '    The engine is running but the roster is empty — nothing has been',
        '    measured, so nothing can be diagnosed or cleared. This is normal',
        '    for the first seconds after a restart.',
      ]).map((l) => c.grey(l)));
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
      // The longest whole form that fits, clipWords as the floor (v0.80.0).
      const fitForm = (forms: string[]): string =>
        '    ' + clipWords((forms.find((f) => visLen(f) <= W) ?? forms[forms.length - 1]).slice(4), W - 4);
      const counts = (): string[] => [
        c.grey(`      timeouts ${eng.timeoutReady}/${eng.total}`),
        // v0.80.0: nodes whose 10-minute window is too thin to RATE timeouts —
        // the return-path detectors skip them, so `timeouts 33/39` alone read
        // as 33 nodes judged. Its own field beside the series it qualifies.
        ...(eng.timeoutWindowBlind > 0 ? [c.grey(`unmeasured ${eng.timeoutWindowBlind}`)] : []),
        c.grey(`rtt ${eng.rttReady}/${eng.total}`),
        // v0.79.0: rtt nodes with no learned band whom the fixed ceiling still
        // judges. Its own field, so the rtt count keeps meaning "learned".
        ...(eng.rttCeiling > 0 ? [c.grey(`ceiling-only ${eng.rttCeiling}`)] : []),
        c.grey(`rssi ${eng.rssiReady}/${eng.total}`),
      ];
      // NOT BLIND, NOT LEARNED (v0.79.0). An rtt node with no graduated band is
      // still judged where a probe can reach it, against a fixed ceiling, so
      // "would not be flagged" stopped being true of it — but only a severe
      // slowdown clears that ceiling, so it is not covered either.
      const ceilingNote = (): string[] => (eng.rttCeiling > 0
        ? para([
          `    rtt: ${eng.rttCeiling} with no learned normal are held to a fixed ${RTT_CEILING_MS} ms`,
          '    ceiling meanwhile, so only a severe slowdown is flagged there.',
        ]).map((l) => c.grey(l))
        : []);
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
        ? [c.grey(fitForm([
          `    (rssi is short on ${rssiShort} — a dossier yardstick only, it arms no detector.)`,
          `    (rssi short on ${rssiShort} — a dossier yardstick, arms no detector.)`,
          `    (rssi short on ${rssiShort}: arms no detector.)`,
          `    (rssi short on ${rssiShort}: dossier only.)`,
        ]))]
        : []);
      // The thin windows, in the partial and learning states too (v0.80.0).
      // The all-clear has counted them since v0.79.9; the partial state is the
      // one a routed mesh sits in, and its counts said nothing about them.
      const unmeasuredNote = (): string[] => (eng.timeoutWindowBlind > 0
        ? [c.grey(fitForm([
          `    timeout: ${eng.timeoutWindowBlind} too quiet in 10 min to rate — the return-path detectors skip them.`,
          `    timeout: ${eng.timeoutWindowBlind} too quiet in 10 min to rate — return-path detectors skip them.`,
          `    timeout: ${eng.timeoutWindowBlind} too quiet to rate; return-path skips them.`,
          `    timeout: ${eng.timeoutWindowBlind} too quiet in 10 min to rate.`,
          `    timeout: ${eng.timeoutWindowBlind} too quiet to rate.`,
        ]))]
        : []);
      const episodeLine = (): string[] => {
        const openEps = data.openEpisodes() ?? [];
        if (openEps.length === 0) return [];
        const confirming = openEps.filter((e) => e.confirming).length;
        const n = openEps.length;
        const plural = n === 1 ? '' : 's';
        const long = confirming > 0 ? ` (${confirming} in the confirmation window)` : '';
        const short = confirming > 0 ? ` (${confirming} confirming)` : '';
        // SHEDS PROSE, NEVER THE TWO LOAD-BEARING TOKENS (v0.55.0): the
        // confirming count, and the pointer to the screen that holds the
        // episodes. Built at 120 columns and never rendered at the modal 80,
        // the single form came back as `...— se` — a sentence stopping
        // mid-word with the pointer gone, which is exactly what DOCS §12.10
        // forbids of a bare truncate(). clipWords is the floor beneath the
        // ladder so even the shortest form cannot clip mid-token.
        const forms = [
          `    ◷ The ledger is still scoring ${n} episode${plural}${long} — see ENGINE.`,
          `    ◷ The ledger is still scoring ${n} episode${plural}${short} — see ENGINE.`,
          `    ◷ Ledger scoring ${n} episode${plural}${short} — see ENGINE.`,
          `    ◷ Scoring ${n} episode${plural}${short} — ENGINE.`,
          `    ◷ ${n} open, ${confirming} confirming — ENGINE.`,
        ];
        return [c.grey(clipWords(forms.find((f) => f.length <= W) ?? forms[forms.length - 1], W))];
      };

      if (eng.timeoutReady === 0 && eng.rttReady === 0) {
        empty = 'learning';
        // NOTHING has graduated. Deliberately silent about symptoms: with no
        // learned detector able to fire, "no symptoms" would describe the
        // instrument. The fixed RTT ceiling (v0.79.0) still flags a severe
        // slowdown, which ceilingNote() says, so the sentence below names the
        // LEARNED detectors when the ceiling is judging anyone.
        body.push(c.cyan(pickHead([
          `    ◷ Learning — no detector has a learned yardstick yet for ${bandLabel(eng)}:`,
          `    ◷ Learning — no yardstick yet for ${bandLabel(eng, true)}:`,
          `    ◷ Learning — none yet, ${bandLabel(eng, true)}:`,
        ])));
        body.push('');
        body.push(fieldStrip(view, counts()));
        body.push('');
        body.push(...para([
          '    Each node’s normal is learned per series and per time-of-day band,',
          '    from the evidence stream across several distinct days, before its',
          eng.rttCeiling > 0
            ? '    learned detectors may fire. Nothing here is a health claim yet.'
            : '    detectors may fire. Nothing here is a health claim yet.',
        ]).map((l) => c.grey(l)));
        // The counts above carry `unmeasured N` here too (v0.80.0), so the line
        // that says what it means follows the paragraph, as in the partial state.
        body.push(...unmeasuredNote());
        body.push(...ceilingNote());
      } else if (blind.length > 0) {
        empty = 'partial';
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
        body.push(...para([
          `    No learned yardstick in this band: ${which} of ${eng.total} nodes.`,
          eng.rttCeiling > 0
            ? '    A degradation on those nodes may go unflagged, so this is a'
            : '    A degradation on those nodes would not be flagged, so this is a',
          '    statement about COVERAGE, not health. Baselines reset on a route',
          '    change, so routed nodes may never graduate.',
        ]).map((l) => c.grey(l)));
        body.push(...unmeasuredNote());
        body.push(...ceilingNote());
        body.push(...rssiNote());
        body.push(...episodeLine());
      } else {
        // FULL coverage in this band. "All clear" is a claim about the WHOLE
        // engine, and this screen only knows about live symptoms (v0.43.1).
        empty = 'clear';
        // A whole headline at every width (v0.80.0): at 40 columns the one
        // form was cut mid-word. clipWords is the floor below the ladder.
        const clearForms = [
          `    ✓ All clear — ${eng.total} nodes learned, no symptoms detected.`,
          `    ✓ All clear — ${eng.total} learned, no symptoms.`,
          '    ✓ All clear — no symptoms.',
        ];
        body.push(c.green(clipWords(clearForms.find((f) => visLen(f) <= W) ?? clearForms[clearForms.length - 1], W)));
        body.push('');
        body.push(...para([
          '    Every node has a graduated timeout and rtt baseline — the two',
          '    that arm a detector —',
        ]).map((l) => c.grey(l)));
        // WHAT THE BRANCH CHECKED (v0.79.9): `symptoms.length === 0`, so no
        // symptom is firing. "None is currently anomalous" claimed a judgment
        // the engine cannot make on a node whose 10-minute window is too thin.
        const bandLine = `    for ${bandLabel(eng)}, and no symptom is firing.`;
        body.push(c.grey(visLen(bandLine) <= W ? bandLine
          : `    for ${bandLabel(eng, true)}, no symptom firing.`));
        // Those thin windows, as a count with no verdict word beside the ✓.
        if (eng.timeoutWindowBlind > 0) {
          const b = eng.timeoutWindowBlind;
          const forms = [
            `    (${b} of ${eng.total}: too little traffic in 10 min to rate timeouts.)`,
            `    (${b} of ${eng.total}: too quiet in 10 min to rate timeouts.)`,
            `    (${b}/${eng.total} too quiet to rate timeouts.)`,
          ];
          body.push(c.grey(clipWords(forms.find((f) => visLen(f) <= W) ?? forms[forms.length - 1], W)));
        }
        body.push(...rssiNote());
        const eps = episodeLine();
        if (eps.length) body.push(...eps);
        else if (autonomous) {
          // A runner can write with no keypress (v0.79.9): "nothing is acted
          // on" would be false. Stated as a capability, true while paused.
          const forms = [
            '    New symptoms surface here; the engine can also write on its own (ENGINE).',
            '    The engine can also write on its own (ENGINE).',
            '    The engine can write on its own.',
          ];
          body.push(c.grey(clipWords(forms.find((f) => visLen(f) <= W) ?? forms[forms.length - 1], W)));
        } else {
          const forms = [
            '    New symptoms will surface here — advisory-first, nothing is acted on.',
            '    New symptoms surface here; nothing is acted on.',
            '    Advisory-first: nothing is acted on.',
          ];
          body.push(c.grey(clipWords(forms.find((f) => visLen(f) <= W) ?? forms[forms.length - 1], W)));
        }
      }
    }
  } else {
    const crit = symptoms.filter((s) => s.severity === 'crit').length;
    const warn = symptoms.filter((s) => s.severity === 'warn').length;
    body.push(truncate(c.grey('  ') + summaryLine(crit, warn, symptoms.length, autonomous, W), W));
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

  // `null` is not a state — it is the ABSENCE of one, so the rule carries no
  // verdict rather than inheriting the last branch's claim.
  const right = symptoms.length
    ? `${symptoms.length} symptom${symptoms.length === 1 ? '' : 's'}`
    : empty ? EMPTY_TOKEN[empty] : '';
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

function summaryLine(crit: number, warn: number, total: number, autonomous = false, W = Infinity): string {
  const bits: string[] = [];
  if (crit) bits.push(c.redB(`${crit} critical`));
  if (warn) bits.push(c.yellow(`${warn} warning`));
  const watch = total - crit - warn;
  if (watch) bits.push(c.grey(`${watch} watch`));
  // "nothing is acted on" was false ON THIS SCREEN: its own command bar
  // advertises [A] ACTIONS and `p` fires a ping immediately. The true claim is
  // about the ENGINE — it recommends and never executes; the operator does.
  // WITH A RUNNER THAT IS FALSE (v0.79.9): auto-ping and the refresh trial
  // write with no keypress. Stated as a capability, so it holds while auto-ping
  // is paused or suppressed; the tail is shed whole, never cut mid-claim.
  const head = bits.join(c.grey(' · '));
  if (autonomous) {
    const tail = ['  —  the engine can also write on its own; see ENGINE', '  —  the engine can also write on its own']
      .find((t) => visLen('  ' + head + t) <= W) ?? '';
    return head + c.grey(tail);
  }
  // The advisory tail sheds the same way (v0.79.9): cut blind, one warning's
  // row read "you run the acti" at 60 columns.
  const advisory = ['  —  the engine only recommends; you run the actions', '  —  the engine only recommends']
    .find((t) => visLen('  ' + head + t) <= W) ?? '';
  return head + c.grey(advisory);
}
