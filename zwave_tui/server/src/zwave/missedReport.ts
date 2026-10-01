/**
 * The missed-report watch for SLEEPING nodes (v0.73.0).
 *
 * A battery device is silent between its reports by design, so silence alone
 * says nothing — unless the device has DECLARED how often it reports. Two
 * declarations are read, both from the driver's own value DB (the driver-WS
 * state dump, then its value events):
 *
 *   - a Wake Up interval (Command Class 132, `wakeUpInterval`, seconds), and
 *   - a Configuration parameter (Command Class 112) whose label names a
 *     heartbeat, in a unit this module can convert.
 *
 * Nothing is learned from traffic. A learned cadence cannot tell a device's
 * timer from a person's routine — a lock used twice a day, a door sensor — and
 * every rule added to make it try raised a new false alarm. A device that
 * declares nothing is not watched, and says so.
 *
 * A node is WATCHED only while all of these hold:
 *   1. it sleeps (the driver reports isListening === false; a node whose
 *      flags are not known yet is not counted as a sleeper at all);
 *   2. it is not Dead (node-down owns a Dead node);
 *   3. its declared interval is readable and > 0;
 *   4. the driver-WS link is live (otherwise every report may not reach us);
 *   5. it has been heard at least once (a silence needs a start).
 *
 * Silence past MISSED_WATCH_MULT × the interval is a `watch`; past
 * MISSED_WARN_MULT × it is a `warn`. The controller's radio goes off for
 * seconds every night (the NVM backup), and a heartbeat sent then is lost with
 * no retry, so a silence that spans a radio-off — or any part of which the
 * driver's log stream (where a radio-off shows) was not watched — is given one
 * more interval before it counts.
 *
 * PURE: the caller supplies the clock and the observations.
 */

import { NodeStatus, type NodeSnapshot } from '../types';

export const MISSED_WATCH_MULT = 1.5;
export const MISSED_WARN_MULT = 2.5;

/** Why a sleeping node is not watched. */
export type UnwatchedReason =
  | 'dead'
  | 'no-declared-interval'
  | 'interval-disabled'
  | 'unit-unknown'
  | 'link-not-live'
  | 'never-heard';

export const UNWATCHED_TEXT: Record<UnwatchedReason, string> = {
  dead: 'Dead (node-down owns it)',
  'no-declared-interval': 'declares no report interval',
  'interval-disabled': 'report interval disabled (0)',
  'unit-unknown': 'report interval in an unknown unit',
  'link-not-live': 'driver link not live',
  'never-heard': 'never heard',
};

/** What a node's value DB declares. */
export type Declared =
  | { ms: number; source: 'wake-up' | 'heartbeat' }
  | { reason: 'no-declared-interval' | 'interval-disabled' | 'unit-unknown' };

/** One value as the zwave-js-server state dump carries it. */
export interface DumpValue {
  commandClass?: unknown;
  endpoint?: unknown;
  property?: unknown;
  propertyKey?: unknown;
  value?: unknown;
  metadata?: { label?: unknown; unit?: unknown } | null;
}

/** Which value holds the declaration, so a later value event can be matched. */
export interface DeclaredRef {
  commandClass: 112 | 132;
  endpoint: number;
  property: string | number;
  propertyKey: string | number | null;
  unitMs: number;
}

export const WAKE_UP_CC = 132;
export const CONFIGURATION_CC = 112;
const HEARTBEAT_LABEL = /heartbeat/i;

/** Milliseconds per unit, or null for a unit this module does not know. */
export function unitMs(unit: unknown): number | null {
  if (typeof unit !== 'string') return null;
  const u = unit.trim().toLowerCase();
  if (/^(s|sec|secs|second|seconds)$/.test(u)) return 1_000;
  if (/^(min|mins|minute|minutes)$/.test(u)) return 60_000;
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return 3_600_000;
  return null;
}

/** The value in a node's dump that declares its report interval. A Wake Up
 *  interval wins over a heartbeat parameter; the first match of each counts. */
export function findDeclared(values: readonly DumpValue[]): { ref: DeclaredRef; value: unknown } | { reason: 'no-declared-interval' | 'unit-unknown' } {
  let heartbeat: { ref: DeclaredRef; value: unknown } | null = null;
  let unknownUnit = false;
  for (const v of values) {
    if (v == null || typeof v !== 'object') continue;
    const prop = v.property;
    if (typeof prop !== 'string' && typeof prop !== 'number') continue;
    const endpoint = typeof v.endpoint === 'number' ? v.endpoint : 0;
    const propertyKey = typeof v.propertyKey === 'string' || typeof v.propertyKey === 'number' ? v.propertyKey : null;
    if (v.commandClass === WAKE_UP_CC && prop === 'wakeUpInterval') {
      // The Wake Up interval is seconds by definition of the CC.
      return { ref: { commandClass: WAKE_UP_CC, endpoint, property: prop, propertyKey, unitMs: 1_000 }, value: v.value };
    }
    if (heartbeat == null && v.commandClass === CONFIGURATION_CC && typeof v.metadata?.label === 'string' && HEARTBEAT_LABEL.test(v.metadata.label)) {
      const u = unitMs(v.metadata.unit);
      if (u == null) { unknownUnit = true; continue; }
      heartbeat = { ref: { commandClass: CONFIGURATION_CC, endpoint, property: prop, propertyKey, unitMs: u }, value: v.value };
    }
  }
  return heartbeat ?? { reason: unknownUnit ? 'unit-unknown' : 'no-declared-interval' };
}

/** The declaration a value holds, in ms. */
export function declaredFrom(ref: DeclaredRef, value: unknown): Declared {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { reason: 'no-declared-interval' };
  if (value === 0) return { reason: 'interval-disabled' };
  return { ms: value * ref.unitMs, source: ref.commandClass === WAKE_UP_CC ? 'wake-up' : 'heartbeat' };
}

export interface SleeperWatch {
  nodeId: number;
  watched: boolean;
  reason: UnwatchedReason | null;
  /** The declared interval, when one was read. */
  periodMs: number | null;
  source: 'wake-up' | 'heartbeat' | null;
  /** Time since the node was last heard, while watched. */
  silentMs: number | null;
  /** One more interval was allowed for a radio-off inside the silence. */
  radioAllowance: boolean;
  severity: 'watch' | 'warn' | null;
}

export interface WatchInput {
  node: NodeSnapshot;
  /** null = the dump has not declared anything for this node yet. */
  declared: Declared | null;
  linkLive: boolean;
  /** When the controller radio last came back on, or null if never seen. */
  lastRfOnAt: number | null;
  /** Since when the driver's log stream, where a radio-off shows, has been
   *  watched without a break; null while it is dark. */
  rfWatchSince: number | null;
  now: number;
}

/** What the watch last raised for a node, held until it reports again. */
export interface WatchLatch { seen: number; periodMs: number; severity: 'watch' | 'warn' }

const RANK = { watch: 1, warn: 2 } as const;

/** Hold a raised severity until the node reports or its declared interval
 *  changes (v0.73.4 review). The radio-off allowance is evidence about a
 *  heartbeat that MIGHT be lost; one that arrives after a threshold was
 *  crossed cannot explain the miss that crossed it, yet it widened the
 *  threshold and cleared the symptom — logged "cleared" with no report. The
 *  same happened when the log stream went dark or reconnected. A blind or
 *  Dead reading leaves the latch as it is. */
export function latchWatch(w: SleeperWatch, seen: number | null, prev: WatchLatch | undefined): { w: SleeperWatch; next: WatchLatch | undefined } {
  if (!w.watched) return { w, next: prev };
  if (seen == null || w.periodMs == null) return { w, next: undefined };
  const same = prev != null && prev.seen === seen && prev.periodMs === w.periodMs;
  const held = same && prev != null && (w.severity == null || RANK[prev.severity] > RANK[w.severity]) ? prev.severity : w.severity;
  return { w: held === w.severity ? w : { ...w, severity: held }, next: held == null ? undefined : { seen, periodMs: w.periodMs, severity: held } };
}

/** A sleeping node's watch status, or null for a node that does not sleep. */
export function sleeperWatch(i: WatchInput): SleeperWatch | null {
  const n = i.node;
  // Unknown flags are not a sleeper (v0.73.4 review): before the first driver
  // dump, every mains node was counted and listed as "sleep flags unknown".
  if (n.isController || n.isListening !== false) return null;
  const base: SleeperWatch = { nodeId: n.nodeId, watched: false, reason: null, periodMs: null, source: null, silentMs: null, radioAllowance: false, severity: null };
  const d = i.declared;
  if (d != null && 'ms' in d) { base.periodMs = d.ms; base.source = d.source; }
  const not = (reason: UnwatchedReason): SleeperWatch => ({ ...base, reason });
  if (n.status === NodeStatus.Dead) return not('dead');
  if (d == null) return not('no-declared-interval');
  if (!('ms' in d)) return not(d.reason);
  if (!i.linkLive) return not('link-not-live');
  const seen = n.stats?.lastSeen ?? null;
  if (seen == null || !Number.isFinite(seen)) return not('never-heard');
  const silentMs = Math.max(0, i.now - seen);
  const radioAllowance = i.rfWatchSince == null || i.rfWatchSince > seen || (i.lastRfOnAt != null && i.lastRfOnAt > seen);
  const extra = radioAllowance ? d.ms : 0;
  const severity = silentMs > MISSED_WARN_MULT * d.ms + extra ? 'warn'
    : silentMs > MISSED_WATCH_MULT * d.ms + extra ? 'watch'
      : null;
  return { ...base, watched: true, silentMs, radioAllowance, severity };
}
