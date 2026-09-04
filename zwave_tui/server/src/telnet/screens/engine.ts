/**
 * ENGINE screen (v0.41) — key `9`. The learned-remediation engine's own state.
 *
 * A gap analysis of this TUI found its largest single class of defect here: the
 * engine had grown far past its screens. Auto-ping — the one thing this add-on
 * does WITHOUT a human pressing a key — had no accessor anywhere in the
 * codebase, so its suppression state, ladder position, miss streaks and probe
 * debt were reachable only by tailing the container log. The M5 ledger was
 * write-only from the operator's chair: episodes opened, ran and closed with
 * their verdicts going to stdout, so REMEDY could read "All clear" while an
 * experiment was mid-flight, and `baseRate` — the number that makes every
 * efficacy claim mean anything — had no render path at all.
 *
 * This screen is the answer to one question: what is the engine doing right
 * now, and what has it learned? It renders three blocks, ordered so that
 * truncation on a small terminal drops the least operational content last:
 *
 *   AUTO-PING   the autonomous write — live suppression, fleet counts, and one
 *               row per node the ladder is actually tracking.
 *   LEDGER LIVE the open episodes, with the confirmation window called out (a
 *               node being scored is recovering, not degraded).
 *   LEARNED     per kind: the control arm WITH its n, the action arms with
 *               their efficacy, and the unscoreable tallies apart from both.
 *
 * Honesty rules this screen keeps: every rate carries its n; a disabled feature
 * says so rather than rendering empty; and a counter that is zero because
 * nothing happened is never shown as if it were a measurement.
 *
 * Pure render: builds a body and hands it to `frame`, which owns the
 * exactly-`view.rows` contract and discloses anything it cannot fit.
 */

import { c, truncate, visLen } from '../ansi';
import { provenance, weight } from '../ledgerText';
import { frame } from '../chrome';
import type { ScreenCtx, SymptomKind, ActionKind } from '../../types';

/** Kinds worth a LEARNED row — the ledger only scores these. */
const SCORED_KINDS: SymptomKind[] = [
  'return-path-degraded', 'chronic-return-path', 'quiet-node', 'dead-flap',
  's2-desync', 'weak-signal', 'rtt-degraded', 'rate-fallback', 'route-churn',
];

/** Actions the ledger can carry an arm for. */
const ARM_ACTIONS: ActionKind[] = ['ping', 'refreshValues', 'reInterview', 'healNode'];

/**
 * Join `bits` under a width budget WITHOUT splitting one (v0.41.0).
 *
 * Pre-release review caught the first cut clipping mid-number — a measured 41%
 * rendered as `4`, and a node's "GAVE UP — needs a human" vanished entirely at
 * the modal 80x24 because it sat last. A truncated label is a nuisance; a
 * truncated NUMBER is a false reading, and a dropped alarm is worse than both.
 * Bits are emitted whole, in priority order, and anything that does not fit is
 * DISCLOSED as a count rather than silently lost.
 */
function fitBits(prefix: string, bits: string[], width: number): string {
  const sep = ' · ';
  let out = prefix;
  let shown = 0;
  for (const b of bits) {
    const more = bits.length - shown - 1;
    // Reserve room for the overflow marker unless this is the last bit.
    const tail = more > 0 ? sep + `+${more}` : '';
    const candidate = out + (shown === 0 ? '' : sep) + b;
    if (visLen(candidate) + visLen(tail) > width) break;
    out = candidate;
    shown++;
  }
  const dropped = bits.length - shown;
  if (dropped > 0) out += (shown === 0 ? '' : sep) + c.grey(`+${dropped}`);
  return out;
}

/** ms → a compact age. Never fabricates precision it does not have. */
function age(ms: number | null): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function renderEngine(ctx: ScreenCtx): string[] {
  const { view, data } = ctx;
  const now = Date.now();
  const body: string[] = [];
  const push = (s: string): void => { body.push(truncate(s, view.cols)); };
  const wide = view.cols >= 100;

  /* ── AUTO-PING ─────────────────────────────────────────────────────────── */
  push(c.label('AUTO-PING') + c.grey('  — the engine\'s one autonomous write'));
  const ap = data.autoPingState() ?? null;
  if (!ap) {
    push('  ' + c.grey('◷ off — auto-ping is disabled, or write actions are off. Nothing here probes the mesh.'));
  } else if (ap.lastTickMs == null) {
    push('  ' + c.grey('◷ started, but has not completed a decision pass yet.'));
  } else {
    const sup = ap.suppressed === 'none'
      ? c.green('running')
      : c.yellow(`suppressed: ${ap.suppressed}`);
    push('  ' + sup + c.grey(`  · last pass ${age(now - ap.lastTickMs)} ago`) +
      c.grey(`  · dwell ${Math.round(ap.config.afterMs / 60_000)}m, max ${ap.config.maxAttempts}/outage`) +
      (ap.config.staleMs > 0 ? c.grey(`, sweep ${Math.round(ap.config.staleMs / 60_000)}m`) : c.grey(', sweep off')));
    // `—` where the pass never computed a queue: a suppressed tick returns
    // before the sweep and verify queues are read, and printing 0 there would
    // assert an empty backlog the engine never looked at.
    const num = (v: number | null): string => (v == null ? c.grey('—') : c.white(String(v)));
    push('  ' + c.grey('candidates ') + c.white(String(ap.listening)) +
      c.grey('  dead ') + (ap.deadListening > 0 ? c.red(String(ap.deadListening)) : c.white('0')) +
      c.grey('  sweep-due ') + num(ap.staleDue) +
      (ap.staleDue != null && ap.stalestMs != null ? c.grey(` (stalest ${age(ap.stalestMs)})`) : '') +
      c.grey('  verify-owed ') + num(ap.verifyOwed));
    // Only nodes the ladder is actually tracking — a row per healthy node would
    // bury the two that matter.
    const tracked = ap.nodes.filter((n) =>
      n.deadSinceMs != null || n.attempts > 0 || n.missStreak > 0 ||
      n.launchFailures > 0 || n.gaveUp || n.launchGaveUp);
    if (tracked.length === 0) {
      push('  ' + c.grey('○ no node is in a dead episode, a miss streak, or a launch failure.'));
    } else {
      for (const n of tracked.slice(0, 8)) {
        const name = data.nodeById?.(n.nodeId)?.name ?? `node ${n.nodeId}`;
        // ALARMS FIRST. These two are the only rows that ask for a human, so
        // they must survive a narrow terminal; everything after them is
        // context that can be dropped with a disclosed count.
        const bits: string[] = [];
        if (n.gaveUp) bits.push(c.red('GAVE UP — needs a human'));
        if (n.launchGaveUp) bits.push(c.red('CANNOT SEND — our fault, not the node\'s'));
        if (n.talkingWhileDead) bits.push(c.yellow('reads Dead but TALKING — stale flag'));
        if (n.deadSinceMs != null) bits.push(c.red(`DEAD ${age(now - n.deadSinceMs)}`));
        if (n.launchFailures > 0) bits.push(c.red(`${n.launchFailures} unsent`));
        if (n.attempts > 0) bits.push(c.yellow(`attempt ${n.attempts}/${ap.config.maxAttempts}`));
        if (n.missStreak > 0) bits.push(c.yellow(`${n.missStreak} miss${n.missStreak === 1 ? '' : 'es'}`));
        // Only meaningful while the ladder still intends to retry: a node it
        // has abandoned has no next attempt, whatever the backoff clock says.
        if (!n.gaveUp && n.nextEligibleMs != null && n.nextEligibleMs > now) {
          bits.push(c.grey(`next in ${age(n.nextEligibleMs - now)}`));
        }
        if (n.pending > 0) bits.push(c.grey(`${n.pending} awaiting`));
        push(fitBits('  ' + c.cyan(`#${n.nodeId} ${wide ? name : name.slice(0, 16)}`) + '  ', bits, view.cols));
      }
      if (tracked.length > 8) push('  ' + c.grey(`○ ${tracked.length - 8} more tracked node(s)`));
    }
  }

  /* ── DRIVER LINK ───────────────────────────────────────────────────────── */
  // The driver-WS socket is where bgRSSI, S2-resync detection and the REAL
  // lastSeen come from. Its status accessor existed from the day the client
  // shipped and nothing read it, so a dormant or schema-mismatched socket
  // degraded three signals silently (v0.43.0).
  const ws = data.driverWsStatus?.();
  if (ws) {
    // Classify on the STATE, never on the sentence (v0.43.0). A first cut
    // pattern-matched the human line and quietly rendered three unhealthy
    // states as benign: the initial 'not started', and every backoff line,
    // whose text is `${reason} — retry in Ns (attempt N)` and need contain
    // none of the words a regex looks for. 'live' is the only healthy state.
    const st = data.driverWsState?.() ?? 'disabled';
    const tone = st === 'live' ? c.grey : st === 'connecting' || st === 'handshake' ? c.grey : c.yellow;
    push(fitBits(c.label('DRIVER LINK') + '  ', [tone(st), c.grey(ws)], view.cols));
    // THE CAUSE, ON ITS OWN ROW (v0.47.0). A homeId mismatch PURGES driver
    // telemetry, and the operator saw only the bare word `stopped` — the one
    // fact that explains it, and names the misconfiguration behind it, sat in a
    // field no screen read.
    //
    // Its own row rather than a bit: at 80 columns the label, the state and the
    // client's prose already fill the line, so as a bit the fault was the thing
    // shed. An alarm that disappears exactly when the line is busy is not an
    // alarm. There is ample vertical room here.
    const fault = data.driverLinkFault?.() ?? null;
    if (fault) push('  ' + c.yellow(`⚠ ${fault}`));
    push('');
  }

  /* ── LEDGER: LIVE ──────────────────────────────────────────────────────── */
  push('');
  push(c.label('LEDGER — LIVE') + c.grey('  — episodes the engine is measuring right now'));
  const open = data.openEpisodes() ?? null;
  if (open == null) {
    push('  ' + c.grey('◷ no outcome ledger — the learning loop is off.'));
  } else if (open.length === 0) {
    push('  ' + c.grey('○ no open episodes. Nothing is being measured (this is the healthy steady state).'));
  } else {
    for (const ep of open.slice(0, 6)) {
      const who = ep.nodeId == null ? c.blue('MESH') : c.cyan(`#${ep.nodeId}`);
      // Ordered by what an operator loses least by having truncated: the
      // lifecycle state and the arm this episode will (or will not) feed come
      // FIRST, because a clipped "confounded" reads as a clean control point —
      // the v0.35 lesson about the basis glyph, applied to the ledger.
      const bits: string[] = [];
      bits.push(ep.confirming
        ? c.green('confirming — symptom absent, scoring')
        : c.yellow('degraded — symptom live'));
      if (ep.confounded) bits.push(c.grey('confounded — neither arm'));
      else if (ep.actionKind) bits.push(c.white(`action: ${ep.actionKind}`));
      else bits.push(c.grey('no action — control arm'));
      bits.push(c.grey(`open ${age(now - ep.onsetMs)}`));
      if (ep.beforeFreshN != null) bits.push(c.grey(`fresh=${ep.beforeFreshN}`));
      push(fitBits('  ' + who + ' ' + c.white(ep.kind) + '  ', bits, view.cols));
    }
    if (open.length > 6) push('  ' + c.grey(`○ ${open.length - 6} more open episode(s)`));
  }

  /* ── LEDGER: LEARNED ───────────────────────────────────────────────────── */
  push('');
  push(c.label('LEARNED') + c.grey('  — every rate with the n behind it'));
  const legendAt = body.length; // filled in below, only if a weight is printed
  let anyLearned = false;
  for (const kind of SCORED_KINDS) {
    const arm = data.controlArm(kind) ?? null;
    const unver = data.unverifiableCount?.(kind) ?? 0;
    const transient = data.unverifiableTransientCount?.(kind) ?? 0;
    const under = data.unverifiableUndersampledCount?.(kind) ?? 0;
    const unprobe = data.unverifiableUnprobeableCount?.(kind) ?? 0;
    const conf = data.confoundedCount?.(kind) ?? 0;
    const fp = data.falsePositives?.(kind) ?? 0;
    const arms = ARM_ACTIONS
      .map((a) => ({ a, e: data.efficacyFor(kind, a) }))
      .filter((x) => x.e != null && x.e.n > 0);
    const nothing = (arm == null || arm.n === 0) && arms.length === 0 &&
      unver + transient + under + unprobe + conf + fp === 0;
    if (nothing) continue;
    anyLearned = true;
    const parts: string[] = [];
    if (arm != null && arm.n > 0) {
      // The base rate ALWAYS with its n and its provenance: a self-heal rate
      // from one node is not a fact about the kind.
      // The control arm's OWN regressions too (v0.44.0): a kind that
      // self-heals 60% and self-worsens 30% is a different animal from one
      // that self-heals 60% and stalls 40%, and `controlArm().bad` was being
      // tallied, persisted and plumbed end-to-end while no screen showed it.
      const armHarm = arm.bad >= 0.5 ? `, ${weight(arm.bad)} worse` : '';
      // THE SAME READINESS RULE THE STORE APPLIES (v0.50.0). This printed
      // `ok / n` gated only on `n > 0`, while `outcomes.baseRate()` returns
      // NULL below `minEpisodes` — so one tally produced `self-heal 100%
      // (n≈1.0)` here and nothing at all for REMEDY and the planner. Live on
      // 2026-09-03: `route-churn self-heal 100% (n≈1.0, sources not recorded)`,
      // a rate from ONE episode with its provenance unknown.
      //
      // Showing `n` beside it was the old defence, and v0.43.1 settled that it
      // is not enough — which is exactly why the ACTION arm says
      // "still learning (n≈2.0 of 4)" rather than quoting a percentage.
      if (arm.n + 1e-9 < arm.minN) {
        parts.push(c.grey(`self-heal still learning (${weight(arm.n)} of ${arm.minN}${provenance(arm.nodes)})`));
      } else {
        parts.push(c.white(`self-heal ${Math.round((arm.ok / arm.n) * 100)}%`) +
          c.grey(` (${weight(arm.n)}${provenance(arm.nodes)}${armHarm})`));
      }
    } else {
      parts.push(c.grey('self-heal not yet measured'));
    }
    // BITS CARRY A PRIORITY (v0.44.0). fitBits drops whole bits from the right,
    // so at 80 columns the regression count — the longest bit and the one that
    // argues against acting — was the first thing to disappear, leaving the
    // benign arms on screen. Sorting the ARMS was not enough: the self-heal bit
    // and the earlier arms still consumed the width first. AUTO-PING already
    // orders alarm-first for exactly this reason; this now does too.
    //
    //   0 = a measured regression      1 = an arm's own verdict
    //   2 = the kind's background rate   3 = a bound
    //
    // The control arm sits BELOW the action arms deliberately: when a harm
    // finding and an efficacy both need the line, the kind's background
    // self-heal rate is the context, not the subject, and 80 columns cannot
    // hold all three.
    const pri: number[] = parts.map(() => 2);
    const bit = (text: string, p: number): void => { parts.push(text); pri.push(p); };
    for (const { a, e } of arms) {
      // The regression count is its OWN bit, not concatenated into the arm's
      // (v0.44.0): welded together they pushed the whole arm past 80 columns
      // and fitBits dropped ALL of it, so the modal terminal lost both the
      // efficacy and the harm. Separate bits degrade one at a time.
      if (e!.expectedEfficacy != null) {
        bit(c.green(`${a} ${Math.round(e!.expectedEfficacy * 100)}%`) +
          c.grey(` (${weight(e!.n)}${provenance(e!.nodes)})`), 1);
        // The bound ON A GRANTED CLAIM. The point estimate is the honest best
        // guess, but it is not what earned the claim — this is. `at 95%` is not
        // decoration: a naked second percentage beside a point estimate reads
        // as a range endpoint of unknown kind.
        if (e!.lowerBound != null) bit(c.grey(`${a} ≥${Math.round(e!.lowerBound * 100)}% at 95%`), 3);
      } else if (!e!.ready) {
        // THIRD STATE (v0.44.0). An arm below readiness was rendered with the
        // same words as one that was measured and found wanting — "not
        // distinguishable" reads as a learned verdict, and it was being applied
        // to arms nobody had tried often enough to judge. Its provenance rides
        // along: a below-readiness arm is exactly where "one node repeated
        // three times" is most likely.
        bit(c.grey(`${a} still learning (${weight(e!.n)} of ${e!.minN}${provenance(e!.nodes)})`), 1);
      } else if (e!.bar == null) {
        // FOURTH STATE (v0.44.0). "Not distinguishable" asserts a comparison
        // was made and came out level. With no control arm measured, no
        // comparison was performed at all — REMEDY has said so since v0.43.1
        // and this screen was still claiming the verdict.
        bit(c.grey(`${a} measured, no control arm yet (${weight(e!.n)}${provenance(e!.nodes)})`), 1);
      } else {
        // Provenance on the withheld arm too (v0.43.1): "one node repeated six
        // times" is exactly the shape that fails to distinguish itself.
        bit(c.grey(`${a} not distinguishable (${weight(e!.n)}${provenance(e!.nodes)})`), 1);
      }
      // Its own bit, and marked as the decayed weight it is — this screen's
      // legend says bare numbers are cumulative node counts.
      if (e!.harmed >= 0.5) bit(c.yellow(`${a}: ${weight(e!.harmed)} worse`), 0);
    }
    push('  ' + c.white(kind));
    // Stable sort by priority: regressions survive a narrow terminal, bounds
    // are shed first. `map`+`sort` on indices keeps the within-priority order.
    const laid = parts.map((t, i) => ({ t, p: pri[i], i }))
      .sort((x, y) => x.p - y.p || x.i - y.i).map((b) => b.t);
    push(fitBits('    ', laid, view.cols));
    const tallies: string[] = [];
    if (unver > 0) tallies.push(`${unver} unscoreable (thin evidence)`);
    if (transient > 0) tallies.push(`${transient} transient blink${transient === 1 ? '' : 's'}`);
    if (under > 0) tallies.push(`${under} undersampled (node reports too rarely)`);
    if (unprobe > 0) tallies.push(`${unprobe} unprobeable`);
    if (conf > 0) tallies.push(`${conf} confounded`);
    if (fp > 0) tallies.push(`${fp} refused as misdiagnosis`);
    if (tallies.length) push('    ' + c.grey('○ ' + tallies.join(' · ')));
  }
  if (!anyLearned) {
    push('  ' + c.grey('○ nothing learned yet — no episode of any scored kind has closed.'));
  } else {
    // The only place either screen says what these two numbers ARE (v0.43.1):
    // one is a decaying weight, the other a running total, printed side by side
    // in identical styling with nothing to tell them apart. Inserted rather
    // than pushed so it sits under the LEARNED label — and only when a weight
    // is actually on screen, since explaining an absent notation is noise.
    // The short form keeps the saturation figure, which is the part a
    // truncating terminal was cutting off.
    const full = '  n≈ is recent-weighted and saturates near 33; node counts are cumulative';
    body.splice(legendAt, 0, c.grey(visLen(full) <= view.cols ? full : '  n≈ decays, saturates ~33; nodes cumulative'));
  }

  return frame(view, data, {
    title: 'ENGINE',
    body,
    keys: [['1-9', 'SCREENS'], ['Q', 'BACK']],
  });
}
