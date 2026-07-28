/**
 * Entity control mapping (v0.23) — the pure, testable core of "turn this device
 * on/off / lock / open" from the TUI. Maps an HA entity's domain + a requested
 * verb to the exact `call_service` (domain, service) the ActionRunner invokes.
 *
 * Scope (owner-chosen, v0.23): EVERY controllable domain, including locks and
 * garage doors — all still gated behind the write-actions master switch AND the
 * type-CONFIRM step in the Actions Menu. This module only *names* the service;
 * it performs no I/O and grants no authority of its own.
 */

import type { EntityVerb } from '../types';

export type { EntityVerb };

export interface EntityService {
  domain: string;
  service: string;
}

/**
 * Controllable domains → the verbs offered for each, in menu order. A domain
 * absent from this table is read-only (sensors, buttons, climate, updates …):
 * the Actions Menu simply won't offer controls for it.
 */
export const CONTROLLABLE_VERBS: Record<string, readonly EntityVerb[]> = {
  light: ['on', 'off', 'toggle'],
  switch: ['on', 'off', 'toggle'],
  fan: ['on', 'off', 'toggle'],
  input_boolean: ['on', 'off', 'toggle'],
  siren: ['on', 'off', 'toggle'],
  cover: ['open', 'close', 'toggle'],
  lock: ['lock', 'unlock'],
};

/** The verbs available for an entity domain (empty = not controllable). */
export function verbsFor(domain: string): readonly EntityVerb[] {
  return CONTROLLABLE_VERBS[domain] ?? [];
}

/** Is an entity domain controllable at all? */
export function isControllable(domain: string): boolean {
  return domain in CONTROLLABLE_VERBS;
}

/**
 * Resolve (domain, verb) → the HA service to call, or null when the pair isn't
 * valid (verb not offered for that domain / domain not controllable). Generic
 * on/off/toggle route through `homeassistant.*` (works across light/switch/fan/
 * input_boolean/siren); covers and locks use their own domain services.
 */
export function resolveService(domain: string, verb: EntityVerb): EntityService | null {
  const verbs = CONTROLLABLE_VERBS[domain];
  if (!verbs || !verbs.includes(verb)) return null;
  switch (verb) {
    case 'on':
      return { domain: 'homeassistant', service: 'turn_on' };
    case 'off':
      return { domain: 'homeassistant', service: 'turn_off' };
    case 'toggle':
      // cover has no homeassistant.toggle semantics that always match — use its own.
      return domain === 'cover'
        ? { domain: 'cover', service: 'toggle' }
        : { domain: 'homeassistant', service: 'toggle' };
    case 'lock':
      return { domain: 'lock', service: 'lock' };
    case 'unlock':
      return { domain: 'lock', service: 'unlock' };
    case 'open':
      return { domain: 'cover', service: 'open_cover' };
    case 'close':
      return { domain: 'cover', service: 'close_cover' };
  }
}

/** Human imperative label for a verb (menu row + confirm title). */
export function verbLabel(verb: EntityVerb): string {
  switch (verb) {
    case 'on':
      return 'Turn On';
    case 'off':
      return 'Turn Off';
    case 'toggle':
      return 'Toggle';
    case 'lock':
      return 'Lock';
    case 'unlock':
      return 'Unlock';
    case 'open':
      return 'Open';
    case 'close':
      return 'Close';
  }
}

/**
 * Is this verb a "high-stakes" actuation (unlocking a lock, opening a
 * garage/cover)? Drives the destructive/caution badge + confirm wording — a
 * light toggle is routine, unlocking a door is not.
 */
export function isHighStakes(domain: string, verb: EntityVerb): boolean {
  if (domain === 'lock') return verb === 'unlock';
  if (domain === 'cover') return verb === 'open' || verb === 'toggle';
  return false;
}
