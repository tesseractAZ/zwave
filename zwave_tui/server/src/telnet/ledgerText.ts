/**
 * Shared wording for M5 ledger numbers (v0.43.1).
 *
 * REMEDY and ENGINE both print the same two quantities off the same key, and
 * they disagreed about what those quantities MEAN:
 *
 *  - `n` is not a count. `bump()` in outcomes.ts is `n = n*(1-decay) + 1` with
 *    decay 0.03, so it is an exponentially-weighted effective sample size that
 *    saturates near 1/0.03 ≈ 33. REMEDY rounded it to an integer, which is what
 *    manufactured the visible contradiction: seven closures on seven distinct
 *    nodes give n = Σ0.97^i = 6.4005, printed as `n=6 · 7 nodes`.
 *  - `nodes` IS a count, cumulative and deliberately not decayed — and `0`
 *    means UNKNOWN (a ledger written before provenance was tracked), not zero.
 *
 * Both screens now use `n≈` with one decimal, so the notation itself says the
 * number is a weight and not a tally, and both route provenance through the
 * same function so `nodes === 0` cannot be silent on one screen and disclosed
 * on the other.
 */

/**
 * Render an arm's node provenance (v0.41.1, shared v0.43.1).
 *
 * `nodes: 0` means UNKNOWN — NOT "zero nodes agreed". Printing "0 nodes" beside
 * a positive n is a self-contradiction, and it appeared on the live fleet
 * within minutes of the ENGINE screen shipping: `self-heal 100% (n=1.0,
 * 0 nodes)`. The arms are marginal by design, so this number is exactly the one
 * that separates "six nodes agreed" from "one node repeated six times" — it
 * must never assert a count it does not have, and must never stay silent about
 * not having one.
 */
export function provenance(nodes: number, sep = ', '): string {
  return nodes > 0 ? `${sep}${nodes} node${nodes === 1 ? '' : 's'}` : `${sep}sources not recorded`;
}

/**
 * Render the decayed episode weight. `≈` and the decimal are load-bearing: they
 * are what distinguish this from the plain undecayed integers ("N past
 * episodes") that sit beside it in identical styling on the REMEDY card.
 */
export function weight(n: number): string {
  return `n≈${n.toFixed(1)}`;
}

/**
 * Why this symptom kind is NOT measured by the outcome ledger (v0.44.0), or
 * null if it is.
 *
 * The ledger's silence is not neutral. Every other kind on REMEDY accumulates
 * an efficacy record, so a kind that never accumulates one looks like a kind
 * nobody has tried anything on yet — "still learning", indefinitely. For
 * `node-down` that is wrong in a way that matters: the loop is not slow, it is
 * structurally off, and it will never turn on.
 *
 * The string lives here rather than in outcomes.ts because both screens must
 * say the same thing, and because outcomes.ts pulls `node:fs` — a dependency no
 * screen module should acquire. `metricOf` remains the source of truth for
 * WHICH kinds are unscoreable; a test binds the two so they cannot drift.
 *
 * Note `metricOf` returns 'none' for two different reasons — node-down's
 * structural exclusion, and the mesh-scoped kinds that have no per-node
 * recovery metric at all — so the sentence is per-kind and is NOT derived from
 * the metric.
 */
export function unscoreableReason(kind: string): string | null {
  switch (kind) {
    case 'node-down':
      return 'not measured by the ledger: an outage episode ends exactly when the node stops being '
        + 'Dead, so every closure would score as a recovery — there is no control arm to compare against.';
    default:
      return null;
  }
}

/**
 * How a subsumed symptom is described (v0.45.0).
 *
 * REMEDY and the Log both say a symptom is "under" something else, and they
 * said different things: REMEDY distinguished an edge cluster from a mesh
 * event, while the log line called every subsumption "(under mesh event)" —
 * so a node folded into an edge cluster was logged as belonging to an event
 * that did not exist. One function, one answer.
 */
export function subsumptionLabel(subsumedBy: string | undefined, sep: string): string {
  if (!subsumedBy) return '';
  return `${sep}${subsumedBy.endsWith(':edge-cluster') ? 'under edge cluster' : 'under mesh event'}`;
}

/**
 * The first SENTENCE of a narrative — not the text before the first dot
 * (v0.45.0).
 *
 * `narrative.split('.')[0]` was used at two sites, and several narratives
 * interpolate a one-decimal number: `quiet-node` renders "…has not been heard
 * from in 7.2 h", which that split cut to "…has not been heard from in 7" — a
 * truncated, wrong number with its unit stripped, which is precisely the
 * mid-digit clip the house rules forbid.
 *
 * A sentence boundary is a period followed by whitespace or end-of-string, so
 * a decimal point (always followed by a digit) can never be one.
 */
export function firstSentence(text: string): string {
  const m = /^(.*?[.!?])(\s|$)/s.exec(text);
  return (m ? m[1] : text).trim();
}
