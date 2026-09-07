/**
 * Bind a persisted learned-state file to the controller that taught it.
 *
 * WHY THIS EXISTS. Three stores — the outcome ledger, the per-node baselines
 * and the history rings — persist to `/data` keyed by NUMERIC NODE ID and
 * nothing else. Swap the Z-Wave stick (or restore a different NVM) and node 23
 * is a different physical device in a different room, but the file still says
 * "node 23". Only `evidenceStore` carried an identity; these three did not, so
 * a swap performed while the add-on was STOPPED silently re-adopted the old
 * network's learning onto the new one. (A swap performed while it was RUNNING
 * was already caught, by the in-memory `lastHomeId` guard in zwaveData — that
 * guard cannot fire across a restart, because `lastHomeId` starts null.)
 *
 * WHY IT ASKS RATHER THAN DECIDING. `evidenceStore`'s answer to a mismatch is
 * `reset()` — correct for evidence, which is a rolling measurement window that
 * refills in hours. The learned tiers are different: an efficacy ledger is the
 * product of months of episodes, and whether it still applies is a question
 * only the operator can answer. A new home id can mean a genuinely different
 * network (a new stick, a different house) OR the SAME physical mesh under a
 * new identity (an NVM backup restored onto replacement hardware) — and in the
 * second case the old learning is not stale, it is exactly right.
 *
 * So a mismatch DECIDES NOTHING. It parks the store in a pending state: memory
 * is wiped so the engine cannot act on another network's learning, saves are
 * latched off so nothing overwrites the file, and the operator is asked. Only
 * their answer moves anything — `fresh` archives the old file and starts over,
 * `keep` re-adopts it under the new identity. Nothing here ever deletes.
 *
 * ── THE TWO RULES THAT MAKE THIS SAFE ─────────────────────────────────────
 *
 * 1. AN ARCHIVE IS NEVER A RENAME TARGET. `archivePathFor` walks a counter
 *    until it finds a name nothing occupies, so parking can only ever ADD a
 *    file. The tempting design — one sidecar per home id, overwritten on each
 *    swap — destroys the older, richer archive on the second swap back, which
 *    is precisely the data this feature exists to keep.
 *
 * 2. IF IT CANNOT ARCHIVE, IT MUST NOT WIPE THE DISK. A failed rename (EACCES,
 *    ENOSPC, a full counter) returns `false`, and the caller then wipes memory
 *    but LATCHES SAVES OFF. That keeps both halves of the contract at once: the
 *    engine stops reading another network's learning, and the file it could not
 *    move is still there when someone looks. A design that wipes anyway and
 *    lets the next flush overwrite is a purge wearing a warning label.
 *
 * ── AND THE ONE THAT MAKES IT WORK AT ALL ─────────────────────────────────
 *
 * The identity must be read from the file INDEPENDENTLY of whether the payload
 * was adopted. Every one of these stores rejects its file on gates that predate
 * this feature — history on a 1h age gate and a 3min boot grace, baselines on a
 * 30-day age gate, outcomes on a strict `v !== 1`. Each of those `return`s
 * before it reaches the payload. Reading the tag after them means that on the
 * exact path this feature exists for — powered down, stick swapped, powered up
 * an hour later — the tag reads null, no conflict is detected, and the next
 * flush overwrites the previous network's file. Loading data and IDENTIFYING
 * data are separate questions; `readHomeTag` answers the second one from the
 * raw parsed object, before any gate that can reject the first.
 */

import { existsSync, renameSync } from 'node:fs';

/** How many same-home archives to try before giving up. Reaching this means
 *  ~50 swaps away from one controller; refusing beats inventing a 51st name. */
const MAX_ARCHIVES = 50;

/**
 * The home id recorded in an already-parsed envelope, or null.
 *
 * `null` means UNKNOWN, never "mismatched": a file written before this feature
 * carries no tag, and the only safe reading of an untagged file is that it
 * belongs to whoever is live now (it is, on every existing install). Treating
 * absent as foreign would archive every user's real data on the upgrade boot.
 */
export function readHomeTag(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const v = (parsed as { homeId?: unknown }).homeId;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The tag to WRITE, given what is bound and what was loaded.
 *
 * Deliberately prefers the loaded tag over null: the stores flush on timers
 * (history every 120s) and a controller poll may not have bound an id yet, so a
 * naive `homeId: bound` would rewrite a correctly-tagged file as untagged. By
 * the absent-means-adopt rule above, that untagged file is then silently
 * adopted on the next boot — the tag erases itself and the guard evaporates.
 */
export function tagToWrite(bound: number | null, loaded: number | null): number | null {
  return bound ?? loaded ?? null;
}

/**
 * A free archive path for `path`, or null if `MAX_ARCHIVES` are taken.
 *
 * `/data/outcomes.json` → `/data/outcomes.home-3586281591.json`, then
 * `…home-3586281591.2.json`, `.3.json`, … Never returns an existing path, so a
 * rename onto it cannot clobber.
 */
export function archivePathFor(
  path: string,
  homeId: number | null,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const { stem, ext } = splitStem(path);
  // `null` means the live file carried no tag (a pre-upgrade file). It still
  // must not be overwritten, so it is parked under an honest label rather than
  // an invented id.
  const label = homeId == null ? 'unknown' : String(homeId);
  for (let n = 1; n <= MAX_ARCHIVES; n++) {
    const candidate = n === 1
      ? `${stem}.home-${label}${ext}`
      : `${stem}.home-${label}.${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The most recent archive belonging to `homeId`, or null if it has none.
 *
 * "Most recent" is the HIGHEST index, because `archivePathFor` always takes the
 * first free name — so `.2` was written after `.1`. Picking the lowest would
 * hand a returning controller its OLDEST learning while the newer generation
 * sat unused beside it, which is the failure this function exists to prevent.
 */
export function latestArchiveFor(
  path: string,
  homeId: number,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const { stem, ext } = splitStem(path);
  let found: string | null = null;
  for (let n = 1; n <= MAX_ARCHIVES; n++) {
    const candidate = n === 1
      ? `${stem}.home-${homeId}${ext}`
      : `${stem}.home-${homeId}.${n}${ext}`;
    if (exists(candidate)) found = candidate;
  }
  return found;
}

/** Does this controller have learning parked from a previous stint? */
export function hasArchiveFor(
  path: string,
  homeId: number,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return latestArchiveFor(path, homeId, exists) != null;
}

/**
 * Split a path into stem + extension, treating a dot as an extension ONLY when
 * it is in the basename. A dot in a parent directory ("/data/v1.2/outcomes") is
 * not an extension, and splitting there would emit the home tag into the middle
 * of a directory name — a path whose parent does not exist, so the rename
 * throws and (without the latch) the next flush overwrites what it failed to
 * move. Shared by both callers so the rule has exactly ONE definition: the
 * mutation harness flagged the copy-paste as an ambiguous anchor, which is the
 * same duplication showing up as a testing problem.
 */
function splitStem(path: string): { stem: string; ext: string } {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const hasExt = dot > slash && dot > 0;
  return hasExt ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: '' };
}

/** What the operator can answer. */
export type IdentityChoice = 'fresh' | 'keep' | 'resume';

/** A decision awaiting the operator. `previous` is null when the live file
 *  carried no learning to conflict with — a returning stick with an archive. */
export interface IdentityDecision {
  previous: number | null;
  live: number;
  /** This controller has archived learning from a previous stint. */
  resumable: boolean;
}

/** Injectable fs seam — the tests drive these without touching a real disk. */
export interface ArchiveFs {
  exists: (p: string) => boolean;
  rename: (from: string, to: string) => void;
}

const REAL_FS: ArchiveFs = { exists: existsSync, rename: renameSync };

/**
 * Move `path` aside so it survives the wipe that follows. Returns true when the
 * previous network's file is safe (INCLUDING when there was no file at all —
 * nothing to lose is not a failure), false when the caller must latch saves off
 * rather than let a flush overwrite what could not be moved.
 */
export function archiveLiveFile(
  path: string,
  foreignHomeId: number | null,
  log: (msg: string) => void,
  fs: ArchiveFs = REAL_FS,
): boolean {
  try {
    if (!fs.exists(path)) return true; // nothing on disk — nothing at risk
    const dest = archivePathFor(path, foreignHomeId, fs.exists);
    if (dest == null) {
      log(`home-tag: ${MAX_ARCHIVES} archives already exist for home ${foreignHomeId ?? 'unknown'} — ${path} left in place, saves disabled`);
      return false;
    }
    fs.rename(path, dest);
    log(`home-tag: ${path} kept as ${dest} (home ${foreignHomeId ?? 'unknown'})`);
    return true;
  } catch (e) {
    log(`home-tag: could not archive ${path} (${(e as Error).message}) — left in place, saves disabled`);
    return false;
  }
}

/**
 * Put a returning controller's own archived learning back into service.
 *
 * A stick that comes back is the case the archive existed for, and it is the
 * one where BOTH other answers are wrong: `keep` would adopt whatever the
 * interim controller learned about different hardware, and `fresh` would begin
 * from zero while this controller's own months of learning sat in the same
 * directory. So it gets its own answer.
 *
 * ORDER IS THE SAFETY. The live file is parked FIRST; only then is the archive
 * moved into place. If the parking fails there is nowhere safe to put what is
 * currently live, so nothing moves at all and the caller stays pending —
 * restoring over it would trade one network's learning for another's.
 */
export function restoreArchive(
  path: string,
  homeId: number,
  previous: number | null,
  log: (msg: string) => void,
  fs: ArchiveFs = REAL_FS,
): boolean {
  try {
    const src = latestArchiveFor(path, homeId, fs.exists);
    if (src == null) return false; // nothing to resume — not a failure, a no-op
    // Park what is live now (there may be nothing, which is fine).
    if (!archiveLiveFile(path, previous, log, fs)) return false;
    fs.rename(src, path);
    log(`home-tag: resumed home ${homeId} from ${src}`);
    return true;
  } catch (e) {
    log(`home-tag: could not resume home ${homeId} (${(e as Error).message}) — nothing was changed`);
    return false;
  }
}
