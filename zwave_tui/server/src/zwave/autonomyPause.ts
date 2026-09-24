/**
 * One pause for every autonomous write (v0.72.0).
 *
 * The add-on sends frames on its own in exactly one place — auto-ping's sweep,
 * verification lane and dead-node ladder — and no automatic remediation is
 * admitted (admission.ts). This is the one switch that stops all of it, from
 * either side:
 *
 *   tui  `Z` on ENGINE, or Controller 3 → A. Persisted, so a restart stays
 *        paused. No expiry: the owner resumes it, not a clock.
 *   ha   `input_boolean.zwave_tui_pause_autonomy`, read from Home Assistant's
 *        state feed. The owner creates the helper; the add-on only reads it.
 *
 * Either source pauses; resuming one never lifts the other — except that a TUI
 * resume forgets a toggle that has gone missing (there is no switch left).
 *
 * FAIL CLOSED, every way this can be unsure:
 *  - an unreadable, malformed or unknown-version file reads as paused by tui;
 *  - a toggle that has been seen and then reads `unavailable`/`unknown` is on;
 *  - a toggle seen before this run is on until this run reads it (the state
 *    feed can fail to start, and the dead-node ladder is exempt from the boot
 *    window) — unless its last reading was `off`.
 *
 * A pause is not silence forever: once it is older than PAUSE_ESCALATE_MS it
 * raises `binary_sensor.zwave_tui_degraded` (haStates.ts) while auto-ping is
 * running for it to stop, because while nothing is sent a mains device that
 * fails without traffic is not noticed.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { LogSink } from '../logger';

export const PAUSE_ENTITY = 'input_boolean.zwave_tui_pause_autonomy';

/** A pause older than this raises the degraded alarm (v0.72.0). */
export const PAUSE_ESCALATE_MS = 24 * 3_600_000;

export type PauseSource = 'tui' | 'ha';

export interface PauseState {
  by: PauseSource[];
  /** Epoch ms of the OLDEST source still pausing. */
  since: number;
  reason: string;
  /** The HA source pauses only because its toggle went MISSING (v0.72.0
   *  second review): there is no toggle to turn off, so the exits are to
   *  recreate the helper (off) or to resume from the TUI, which forgets it. */
  haMissing?: boolean;
}

interface HaMemory {
  /** The last reading this add-on saw — persisted so a restart starts from it. */
  last: string;
  /** HA's `last_changed` for that reading. It orders readings — a snapshot
   *  older than the event already applied is ignored — and nothing else: HA
   *  restamps it on every restart and on an on → unavailable → on blip. */
  at: number;
  /** When THIS add-on first saw the toggle pausing (v0.72.0 review). Kept
   *  through later on / unavailable / missing readings and across restarts of
   *  either side; cleared only by `off` or deletion. It is the pause's age. */
  since?: number | null;
}

interface PauseFile {
  v: 1;
  tui: { since: number } | null;
  ha?: HaMemory | null;
}

export interface AutonomyPause {
  load(): void;
  state(): PauseState | null;
  /** Idempotent: an existing tui pause keeps its original `since`. */
  pauseTui(): PauseState;
  /** A new Home Assistant connection (v0.72.0 second review): readings are
   *  ordered only within one connection, never against a persisted stamp. */
  newConnection(): void;
  resumeTui(): { resumed: boolean; stillPausedBy: 'ha' | null };
  /** A reading of PAUSE_ENTITY. `changedAt` is the state's `last_changed` (or
   *  the time of the reading, lacking one). `state: null` from an EVENT is a
   *  deletion; from a FULL read it is only an absence, which does not unpause
   *  a toggle last seen pausing (HA lists `input_boolean` late at startup). */
  noteHa(state: string | null, changedAt: number, o?: { source?: 'event' | 'full'; now?: number }): void;
  /** True when a pause has outlived PAUSE_ESCALATE_MS. */
  overdue(now: number): boolean;
}

export function createAutonomyPause(opts: {
  path: string | null;
  log: LogSink;
  now?: () => number;
  onChange?: (s: PauseState | null) => void;
}): AutonomyPause {
  const now = opts.now ?? Date.now;
  const log = opts.log;
  const warn = (m: string): void => (log.warn ?? log)(m);
  let tui: { since: number; reason: string } | null = null;
  // The HA source. `mem` is what survives a restart; `readThisRun` separates
  // "the toggle said so" from "the toggle said so last time".
  let mem: HaMemory | null = null;
  let readThisRun = false;
  // The ordering floor for readings: the newest `last_changed` applied on this
  // connection. In memory only — compared against a persisted stamp, one
  // reading stamped ahead of real time would drop every later one, the owner
  // turning the pause ON included (second review).
  let orderFloor: number | null = null;

  const haPaused = (): { since: number; reason: string } | null => {
    if (mem == null) return null;
    const since = mem.since ?? mem.at;
    if (!readThisRun) {
      // Known from a previous run, not yet read in this one.
      return mem.last === 'off' ? null : { since, reason: `${PAUSE_ENTITY} not read yet this run (last: ${mem.last})` };
    }
    if (mem.last === 'off') return null;
    return {
      since,
      reason: mem.last === 'on' ? `${PAUSE_ENTITY} is on`
        : mem.last === 'missing' ? `${PAUSE_ENTITY} missing from Home Assistant's states (last seen pausing)`
        : `pause toggle ${mem.last}`,
    };
  };

  const compute = (): PauseState | null => {
    const h = haPaused();
    if (!tui && !h) return null;
    const by: PauseSource[] = [];
    if (tui) by.push('tui');
    if (h) by.push('ha');
    return {
      by,
      since: Math.min(tui?.since ?? Infinity, h?.since ?? Infinity),
      reason: [tui?.reason, h?.reason].filter(Boolean).join('; '),
      ...(h != null && mem?.last === 'missing' ? { haMissing: true } : {}),
    };
  };

  let last = compute();
  const key = (s: PauseState | null): string => (s ? s.by.join('+') : '');
  const changed = (): void => {
    const next = compute();
    if (key(next) === key(last)) { last = next; return; }
    const prev = last;
    last = next;
    if (next && !prev) {
      warn(`autonomy: PAUSED by ${next.by.join(' + ')} — auto-ping's sweep, verification and dead-node ladder send nothing until resumed (${next.reason})`);
    } else if (!next) {
      warn(`autonomy: RESUMED — auto-ping sends again at its next tick`);
    } else {
      const gone = prev!.by.filter((b) => !next.by.includes(b));
      const added = next.by.filter((b) => !prev!.by.includes(b));
      warn(`autonomy: ${gone.length ? `RESUMED by ${gone.join(' + ')}` : `PAUSED by ${added.join(' + ')}`} (still paused by ${next.by.join(' + ')})`);
    }
    opts.onChange?.(next);
  };

  const persist = (): void => {
    if (!opts.path) return;
    const body: PauseFile = { v: 1, tui: tui ? { since: tui.since } : null, ha: mem };
    try {
      const tmp = `${opts.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(body), 'utf8');
      renameSync(tmp, opts.path);
    } catch (e) {
      // The pause holds in memory; only a restart could lose it.
      (log.error ?? log)(`autonomy: pause file save failed (${e instanceof Error ? e.message : String(e)}) — the pause holds until the add-on restarts`);
    }
  };

  const unreadable = (why: string): void => {
    tui = { since: now(), reason: 'pause file unreadable — paused until resumed' };
    warn(`autonomy: ${opts.path} ${why} — paused until resumed (Controller 3 → A)`);
    // Rewritten valid (v0.72.0 review), so the pause keeps its age across a
    // restart instead of starting again from zero every time.
    persist();
  };

  return {
    load(): void {
      if (!opts.path) return;
      let raw: string;
      try {
        raw = readFileSync(opts.path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; // never paused
        unreadable(`unreadable (${e instanceof Error ? e.message : String(e)})`);
        changed();
        return;
      }
      try {
        const f = JSON.parse(raw) as Partial<PauseFile> | null;
        const tuiOk = f?.tui === null || (typeof f?.tui === 'object' && Number.isFinite(f?.tui?.since));
        const haOk = f?.ha == null || (typeof f.ha === 'object' && typeof f.ha.last === 'string' && Number.isFinite(f.ha.at) &&
          (f.ha.since == null || Number.isFinite(f.ha.since)));
        if (f == null || f.v !== 1 || !tuiOk || !haOk) {
          unreadable(`has an unknown shape or version`);
        } else {
          tui = f.tui ? { since: f.tui.since, reason: 'paused from the TUI' } : null;
          mem = f.ha ?? null;
        }
      } catch {
        unreadable('is not valid JSON');
      }
      changed();
    },

    state: () => last,

    pauseTui(): PauseState {
      if (!tui) {
        tui = { since: now(), reason: 'paused from the TUI' };
        persist();
        changed();
      }
      return last!;
    },

    resumeTui() {
      // A MISSING toggle is forgotten by a TUI resume (second review): there is
      // no toggle left to turn off, and the typed CONFIRM is the owner's act.
      const forgetMissing = mem?.last === 'missing';
      const resumed = tui != null || forgetMissing;
      if (resumed) {
        tui = null;
        if (forgetMissing) mem = null;
        persist();
        changed();
      }
      return { resumed, stillPausedBy: last?.by.includes('ha') ? 'ha' : null };
    },

    newConnection(): void {
      orderFloor = null;
    },

    noteHa(state: string | null, at: number, o = {}): void {
      const source = o.source ?? 'event';
      const t = o.now ?? now();
      readThisRun = true;
      // A reading older than the one applied is stale — a full read's
      // snapshot landing after a newer state_changed (v0.72.0 review).
      // Only a full state LIST can be stale (third review): a state_changed
      // event is pushed as it happens, so it is never dropped on its stamp —
      // a backward step of HA's clock must not swallow the owner turning the
      // pause on. The floor is the newest event applied on this connection.
      if (state != null && source === 'full' && orderFloor != null && at < orderFloor) {
        warn(`autonomy: ignored a state-list reading of ${PAUSE_ENTITY} (${state}) older than an event already applied`);
        changed();
        return;
      }
      if (state != null && source === 'event') orderFloor = Math.max(orderFloor ?? at, at);
      if (state == null && source === 'event') {
        // Deleted: the toggle no longer exists, so it can neither pause nor be
        // remembered as pausing.
        if (mem != null) { mem = null; persist(); }
        changed();
        return;
      }
      if (state == null) {
        // Absent from a full read. Nothing remembered, or last seen off: no
        // effect. Last seen pausing: stay paused — fail closed.
        if (mem == null || mem.last === 'off') { if (mem != null) { mem = null; persist(); } changed(); return; }
        state = 'missing';
        at = mem.at;
      }
      const prev = mem;
      // The age is CARRIED from the previous reading — one mechanism, so a
      // pause keeps its age through on / unavailable / missing readings — and
      // started only at the first reading that pauses.
      mem = { last: state, at, since: prev?.since ?? null };
      const nowPausing = haPaused() != null;
      if (nowPausing && mem.since == null) mem.since = t;
      if (!nowPausing) mem.since = null;
      if (prev == null || prev.last !== mem.last || prev.at !== mem.at || prev.since !== mem.since) persist();
      changed();
    },

    overdue(t: number): boolean {
      return last != null && t - last.since >= PAUSE_ESCALATE_MS;
    },
  };
}
