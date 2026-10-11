/**
 * The AppArmor label this process runs under (v0.74.4).
 *
 * A profile the host parser rejects is not reported anywhere the owner looks:
 * the Supervisor can start the add-on under docker-default, or keep a stale
 * profile until the next host boot (apparmor.txt, LOADING). Reading the label
 * at startup puts the answer in the add-on log, where a log review sees it
 * without host access.
 *
 * Newer kernels expose the label per LSM (`attr/apparmor/current`); older ones
 * only through the shared `attr/current`. The first readable one wins.
 */

import { readFileSync } from 'node:fs';

export const LABEL_PATHS = ['/proc/self/attr/apparmor/current', '/proc/self/attr/current'] as const;

export interface AppArmorLabel {
  /** The label as the kernel reports it, e.g. `local_zwave_tui (enforce)`. */
  label: string;
  /** True only for a named profile in enforce mode. */
  enforcing: boolean;
}

export function appArmorLabel(read: (path: string) => string = (p) => readFileSync(p, 'utf8')): AppArmorLabel {
  for (const p of LABEL_PATHS) {
    let raw: string;
    try {
      raw = read(p);
    } catch {
      continue;
    }
    const label = raw.replace(/\0/g, '').trim();
    if (label === '') continue;
    return { label, enforcing: /\(enforce\)$/.test(label) && !label.startsWith('unconfined') };
  }
  return { label: 'unknown (not readable)', enforcing: false };
}
