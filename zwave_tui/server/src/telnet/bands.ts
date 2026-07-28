/**
 * Canonical colour bands for the metrics that appear on more than one screen.
 *
 * WHY THIS FILE EXISTS: every screen used to carry its own private copy of
 * these thresholds, and the copies had drifted. The same 600 ms RTT was yellow
 * on the Overview and red on the Detail dossier; the same 4% response-timeout
 * rate was yellow on one and green on the other; the SNR margin ramp had three
 * bands in one place and four in another. An operator comparing two screens
 * could not tell whether a colour change meant the value changed or only the
 * screen did — which makes colour, the fastest triage signal in the whole TUI,
 * untrustworthy.
 *
 * One value ⇒ one colour, everywhere. Import from here; never re-declare a band.
 *
 * Colour vocabulary (shared with the health model):
 *   green  nominal · white acceptable · yellow degraded · red faulty ·
 *   redB   critical · grey no reading / not applicable
 */

import { c } from './ansi';
import { WEAK_MARGIN_DB } from '../zwave/health';

export type ColorFn = (s: string) => string;

/**
 * Round-trip time to the node, in ms. Four bands: the `white` tier matters
 * because a 100–500 ms Z-Wave RTT is entirely normal for a routed node and
 * should not be painted as a warning.
 */
export function rttColor(ms: number): ColorFn {
  if (!Number.isFinite(ms) || ms < 0) return c.grey;
  if (ms < 100) return c.green;
  if (ms < 500) return c.white;
  if (ms < 1000) return c.yellow;
  return c.red;
}

/**
 * Response-timeout rate (`timeoutResponse / commandsTX`) as a PERCENT.
 *
 * This is the mesh's real RF-failure signal — `commandsDroppedTX` does not
 * count RF ACK failures, so it stays near zero even on a node that is failing.
 * The bands are tight because a few percent of unanswered commands is already
 * a node worth looking at.
 */
export function timeoutPctColor(pct: number): ColorFn {
  if (!Number.isFinite(pct)) return c.grey;
  if (pct < 1) return c.green;
  if (pct < 3) return c.white;
  if (pct < 8) return c.yellow;
  return c.red;
}

/** Raw received signal strength, dBm. */
export function rssiColor(dbm: number): ColorFn {
  if (!Number.isFinite(dbm)) return c.grey;
  if (dbm >= -70) return c.green;
  if (dbm >= -88) return c.yellow;
  return c.red;
}

/**
 * SNR margin (rssi − noise floor), dB — how far above the noise the link sits.
 *
 * The red cut is DERIVED from health.ts's `WEAK_MARGIN_DB`, not chosen here, so
 * that "red margin" and "carries a W flag" can never disagree. They were
 * independent constants (10 here, 7 there) and drifted apart: a node at 8 dB
 * rendered red on three screens while the health model, the score and the flag
 * legend all called it fine.
 *
 * Below roughly half that margin a link is not merely weak — it is close to not
 * decoding at all — which earns the bolder redB.
 */
export function marginColor(db: number): ColorFn {
  if (!Number.isFinite(db)) return c.grey;
  if (db >= 17) return c.green;
  if (db >= WEAK_MARGIN_DB) return c.yellow;
  if (db >= Math.floor(WEAK_MARGIN_DB / 2)) return c.red;
  return c.redB;
}

/**
 * Background noise floor, dBm — quiet is good, so the ramp runs the other way.
 * Grey (not green) is "nominal": a quiet floor is the unremarkable case.
 */
export function noiseColor(dbm: number): ColorFn {
  if (!Number.isFinite(dbm)) return c.grey;
  if (dbm >= -75) return c.red;
  if (dbm >= -85) return c.yellow;
  return c.grey;
}
