/**
 * Repeated frames: a link that works one way (v0.74.0).
 *
 * A node that does not hear the controller's acknowledgement sends the same
 * frame again, and the driver drops each S2 copy as a duplicate (it logs
 * `Dropping message with invalid payload (Reason: Duplicate command …)`).
 * The controller hears the node; the node does not hear the controller. On the
 * reference mesh a dimmer switched by an automation repeated one reply 20 times
 * in a minute, and a switch pressed by hand 12 times. A burst's minute starts at
 * its first drop, and the symptom holds for the 24 h its bursts stay inside the
 * lookback.
 *
 * A BURST is DUP_BURST_MIN or more drops from one node within
 * DUP_BURST_WINDOW_MS. The symptom fires while the node has had two bursts in
 * DUP_LOOKBACK_MS, or one of DUP_BIG_BURST or more. Over two measured days that
 * flagged one node of the five that had a single small burst.
 *
 * The drop times are kept in memory only (bounded per node), so a restart
 * starts the count again.
 *
 * PURE: the caller supplies the clock and the drop times.
 */

export const DUP_BURST_WINDOW_MS = 60_000;
export const DUP_BURST_MIN = 5;
export const DUP_BIG_BURST = 15;
export const DUP_LOOKBACK_MS = 24 * 3_600_000;
/** Drop times kept per node; more than the lookback can need at these sizes. */
export const DUP_KEEP = 500;

export interface Burst { at: number; n: number }

/** Record one drop: append, forget what is past the lookback, keep the cap.
 *  Drops dated after `t` (a backward clock step) are discarded as
 *  untrustworthy, as the history store does. */
export function noteDrop(times: number[], t: number): number[] {
  const kept = times.filter((x) => t - x <= DUP_LOOKBACK_MS && x <= t);
  kept.push(t);
  return kept.length > DUP_KEEP ? kept.slice(kept.length - DUP_KEEP) : kept;
}

/** The bursts inside the lookback, oldest first. */
export function burstsOf(times: readonly number[], now: number): Burst[] {
  const recent = times.filter((t) => t <= now && now - t <= DUP_LOOKBACK_MS).sort((a, b) => a - b);
  const out: Burst[] = [];
  let i = 0;
  while (i < recent.length) {
    let j = i;
    while (j < recent.length && recent[j] - recent[i] < DUP_BURST_WINDOW_MS) j++;
    const n = j - i;
    if (n >= DUP_BURST_MIN) { out.push({ at: recent[i], n }); i = j; } else i += 1;
  }
  return out;
}

/** Does this node repeat its frames enough to be a symptom? */
export function repeatsFrames(bursts: readonly Burst[]): boolean {
  return bursts.length >= 2 || bursts.some((b) => b.n >= DUP_BIG_BURST);
}
