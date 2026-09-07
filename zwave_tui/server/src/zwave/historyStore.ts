/**
 * Persistent RSSI/RTT sparkline history — a dependency-free ring store.
 *
 * The data layer keeps a small bounded ring of the last N RSSI + RTT samples
 * per node (for the Overview/Detail sparklines). Those rings live in memory, so
 * every add-on restart / HA-Core reconnect / daily power blip wiped them — the
 * sparklines came back empty and took minutes to repopulate.
 *
 * This store persists the rings to a single JSON file on the /data volume and
 * reloads them at boot, so a restart is visually seamless. It deliberately does
 * NOT use `node:sqlite`: the payload is tiny (≈ nodes × N × 2 numbers), and
 * `DatabaseSync` is only stable on Node 24+ (this add-on ships Node 22, where it
 * needs `--experimental-sqlite`). A plain atomic JSON write is simpler, works on
 * any Node, and is far more portable for anyone who installs this add-on later.
 *
 * Durability model:
 *   - Writes use the temp-file + `rename` idiom: serialize → write `<path>.tmp`
 *     → `rename` onto `<path>`. `rename(2)` is atomic within one filesystem, so
 *     a reader never observes a half-written file — it sees either the old or
 *     the new complete content. (We deliberately do NOT `fsync`: this is a
 *     cosmetic display buffer flushed every 30s, and fsync-per-flush would wear
 *     the Pi's SD card for no real benefit. A power loss mid-write can therefore
 *     still lose the last flush or leave a zero-length file — both benign, since
 *     `load()` treats an empty/garbage file as "no history".)
 *   - Reads are defensive: a missing, unreadable, malformed, wrong-schema,
 *     future-dated, or STALE file yields an empty map rather than throwing.
 *     Nothing here is ever allowed to crash the server; the worst case is
 *     "sparklines start empty", which is exactly the pre-persistence behaviour.
 *   - Two staleness guards, because sparkline samples carry no per-point
 *     timestamps — seeding hours-old data would render a stale trend as if live:
 *       (a) A wall-clock guard drops snapshots older than `maxAgeMs`.
 *       (b) A host-boot guard: HAOS/Pi has no battery RTC, so on a power blip
 *           the wall clock freezes at shutdown and only jumps forward once NTP
 *           syncs a moment after boot — long enough that (a) can be fooled into
 *           trusting an hours-stale snapshot. `os.uptime()` (the monotonic
 *           kernel clock, host-wide even inside the container) is immune, so if
 *           the host only just booted we distrust persisted history. A plain
 *           add-on / HA-Core restart leaves host uptime large, so (b) does not
 *           fire there — persistence survives those, as intended.
 */

import type { IdentityChoice, IdentityDecision } from './homeTag';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { readHomeTag, tagToWrite, archiveLiveFile, hasArchiveFor, restoreArchive } from './homeTag';
import type { LogSink } from '../logger';
import { uptime as osUptime } from 'node:os';

/**
 * One node's rolling sample rings (oldest → newest). Two tiers:
 *   - `rssi`/`rtt`   — fine ring (per stats-event), for the recent sparklines.
 *   - `crssi`/`crtt` — coarse ring (1 downsampled point per minute), for the
 *                      long-horizon (~hours) trend.
 */
export interface HistorySample {
  rssi: number[];
  rtt: number[];
  crssi: number[];
  crtt: number[];
}

/** node id → its sample rings. */
export type HistoryMap = Map<number, HistorySample>;

export interface HistoryStoreOptions {
  /** Absolute path on the /data volume, e.g. `/data/history.json`. */
  path: string;
  /** Cap per FINE array (defensive; should match the in-memory ring size). */
  maxSamples?: number;
  /** Cap per COARSE array (long-horizon downsampled ring size). */
  coarseMax?: number;
  /** Discard snapshots whose `savedAt` is older than this (ms). 0 = never. */
  maxAgeMs?: number;
  /**
   * Distrust persisted history when host uptime is below this (ms) — the
   * post-power-loss window where a no-RTC wall clock may still be pre-NTP.
   * 0 = disable the host-boot guard.
   */
  bootGraceMs?: number;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable host-uptime source in ms (tests); defaults to `os.uptime()`. */
  uptimeMs?: () => number;
  /** Widened to LogSink (v0.53.0) so a failed save can claim `error` — it was
   *  the only report of a store that stopped persisting, and it vanished at
   *  `log_level: warning` along with the routine chatter. */
  log?: LogSink;
}

export interface HistoryStore {
  /** The file this store reads/writes (for logging/tests). */
  readonly path: string;
  /** Load persisted rings. Empty on missing / corrupt / wrong-schema / stale. */
  load(): HistoryMap;
  /** Atomically persist the current rings. Best-effort; never throws. */
  save(map: HistoryMap): void;
  /** Bind the live controller identity. The first known id validates whatever
   *  was restored; a CHANGE parks the store (saves latched off, file untouched)
   *  and waits for `resolveIdentity`. Returns true when the caller must drop
   *  its rings — this store holds no state of its own. */
  bindHomeId(id: number): boolean;
  /** The identity decision waiting on the operator, or null. */
  pendingIdentity(): IdentityDecision | null;
  /** Answer it. On `keep` the caller re-runs load() and installs the result. */
  resolveIdentity(choice: IdentityChoice): boolean;
}

/** On-disk shape. `v` gates format changes; v1 (fine-only) still loads. */
interface Persisted {
  v: number;
  savedAt: number;
  /** Controller this was learned on. OPTIONAL and deliberately NOT a schema
   *  bump — `v` is an exact allowlist here, so bumping it would discard every
   *  existing install's rings. Absent (pre-v0.64 file) reads as UNKNOWN, which
   *  is adopted, not archived. Same shape as evidenceStore's `laneEpoch`. */
  homeId?: number | null;
  nodes: Record<string, { rssi: number[]; rtt: number[]; crssi?: number[]; crtt?: number[] }>;
}

const SCHEMA_V = 2; // 2 adds the coarse tier; v1 (fine-only) still loads.
const DEFAULT_MAX_SAMPLES = 60;
const DEFAULT_COARSE_MAX = 120;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1h — covers any normal restart.
const DEFAULT_BOOT_GRACE_MS = 180 * 1000; // 3min — covers boot→addon-start→NTP.

export function createHistoryStore(opts: HistoryStoreOptions): HistoryStore {
  const path = opts.path;
  const tmp = `${path}.tmp`;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const coarseMax = opts.coarseMax ?? DEFAULT_COARSE_MAX;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const bootGraceMs = opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const uptimeMs = opts.uptimeMs ?? (() => osUptime() * 1000);
  const log: LogSink = opts.log ?? (() => {});

  /** Identity read from the file — set even when the payload is REJECTED by a
   *  gate below, because the age gate is exactly what fires on a stick swap. */
  let loadedHomeId: number | null = null;
  /** Identity of the live controller, once one is known. */
  let boundHomeId: number | null = null;
  /** Latched when a foreign file could not be moved aside: memory is wiped so
   *  the engine is safe, but the disk is left alone so nothing is lost. */
  let persistBlocked = false;
  /** The foreign id awaiting an operator decision (null = none pending). */
  let pendingPrevious: number | null = null;
  /** A decision is open (pendingPrevious is legitimately null for a returning
   *  stick, so it cannot double as the flag). */
  let pendingAsked = false;

  /** Coerce an arbitrary value into a bounded array of finite numbers. */
  const cleanSeries = (a: unknown, cap: number): number[] => {
    if (!Array.isArray(a)) return [];
    const out: number[] = [];
    for (const x of a) {
      if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
    }
    // Keep only the most-recent `cap` (guards against a bloated file).
    return out.length > cap ? out.slice(out.length - cap) : out;
  };

  return {
    path,

    load(): HistoryMap {
      const map: HistoryMap = new Map();
      try {
        if (!existsSync(path)) return map;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return map;
        const obj = parsed as Partial<Persisted>;
        // IDENTITY FIRST — before every gate below, all of which `return`.
        // The 1h age gate and the 3min boot grace both fire on the exact
        // scenario this tag exists for (powered down, stick swapped, powered
        // up later); reading the tag after them would leave it null, find no
        // conflict, and let the next flush overwrite the old network's file.
        loadedHomeId = readHomeTag(obj);
        // v1 (fine-only) still loads — its coarse tier just starts empty and
        // fills over time. Anything else is an unknown format → start fresh.
        if (obj.v !== 1 && obj.v !== 2) {
          log(`history: schema ${String(obj.v)} unsupported — starting fresh`);
          return map;
        }
        const savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : 0;
        const ageMs = now() - savedAt;
        // Guard (b), v0.40: early boot alone no longer discards. The premise
        // ("no battery RTC, clock may be hours stale pre-NTP") is falsified on
        // this hardware — through a 59-minute power cut the Pi 5's RTC held
        // time to within 0.2 s, and this guard threw the sparklines away ~20 s
        // AFTER NTP had confirmed the clock. The trusted case is a clock that
        // PROVABLY CARRIED THROUGH THE OUTAGE: an age reading strictly greater
        // than this boot's uptime plus a minute of slack, which only a clock
        // that kept running while the host was down can show. A pre-NTP
        // RTC-less clock restores either near epoch (age negative) or from a
        // shutdown-time file (age ≈ uptime) — both fail this test and start
        // fresh, exactly as before v0.40 (these rings carry no per-point
        // timestamps, so a wrongly-admitted stale ring could not self-heal
        // after the NTP step; the carried proof is what makes admission safe).
        // Residual: an unclean cut more than the save cadence after the last
        // flush lets a file-restored clock read as carried by the flush-to-cut
        // gap — bounded by the dirty-save cadence, not by the outage.
        const clockCarried = savedAt > 0 && ageMs > uptimeMs() + 60_000;
        if (bootGraceMs > 0 && uptimeMs() < bootGraceMs && !clockCarried) {
          log(`history: host up ${Math.round(uptimeMs() / 1000)}s without proof the clock carried through the outage — starting fresh`);
          return map;
        }
        // Guard (a): wall-clock age. `ageMs < 0` = future-dated (clock stepped
        // backwards since the save) — equally untrustworthy, so also discard.
        if (maxAgeMs > 0 && (savedAt <= 0 || ageMs < 0 || ageMs > maxAgeMs)) {
          const why = savedAt <= 0 ? 'has no savedAt' : ageMs < 0 ? 'is future-dated' : `is ${Math.round(ageMs / 60000)}m old`;
          log(`history: snapshot ${why} — starting fresh`);
          return map;
        }
        const nodes = obj.nodes;
        if (!nodes || typeof nodes !== 'object') return map;
        for (const [k, v] of Object.entries(nodes)) {
          const id = Number(k);
          if (!Number.isInteger(id) || id <= 0) continue;
          if (!v || typeof v !== 'object') continue;
          const s = v as { rssi?: unknown; rtt?: unknown; crssi?: unknown; crtt?: unknown };
          const rssi = cleanSeries(s.rssi, maxSamples);
          const rtt = cleanSeries(s.rtt, maxSamples);
          const crssi = cleanSeries(s.crssi, coarseMax); // absent in v1 → []
          const crtt = cleanSeries(s.crtt, coarseMax);
          if (rssi.length === 0 && rtt.length === 0 && crssi.length === 0 && crtt.length === 0) continue;
          map.set(id, { rssi, rtt, crssi, crtt });
        }
        log(`history: restored ${map.size} node(s) from ${path}`);
      } catch (e) {
        log(`history: load failed (${(e as Error).message}) — starting fresh`);
        return new Map();
      }
      return map;
    },

    bindHomeId(id: number): boolean {
      if (boundHomeId === id) return false;
      // Two triggers, not one — see the note in baselines.ts: a RETURNING stick
      // has an archive but nothing live to conflict with.
      const conflict = loadedHomeId != null && loadedHomeId !== id;
      const returning = loadedHomeId !== id && hasArchiveFor(path, id);
      boundHomeId = id;
      if (!conflict && !returning) {
        // Untagged or already ours — adopt, and stamp the tag from here on.
        loadedHomeId = id;
        return false;
      }
      // Park — decide nothing. See homeTag.ts.
      pendingPrevious = loadedHomeId;
      pendingAsked = true;
      persistBlocked = true;
      return true; // caller drops its rings — they belong to the old network
    },

    pendingIdentity(): IdentityDecision | null {
      if (!pendingAsked || boundHomeId == null) return null;
      return { previous: pendingPrevious, live: boundHomeId, resumable: hasArchiveFor(path, boundHomeId) };
    },

    resolveIdentity(choice: IdentityChoice): boolean {
      if (!pendingAsked || boundHomeId == null) return false;
      if (choice === 'fresh' && !archiveLiveFile(path, pendingPrevious, (m) => log(m))) return false;
      if (choice === 'resume' && !restoreArchive(path, boundHomeId, pendingPrevious, (m) => log(m))) return false;
      loadedHomeId = boundHomeId;
      pendingPrevious = null;
      pendingAsked = false;
      persistBlocked = false;
      // On `keep` the CALLER re-runs load() and installs the rings: this store
      // holds no state of its own, so there is nothing here to restore. Note the
      // rings are age-gated at 1h, so a decision taken later than that reloads
      // nothing — acceptable, because these are cosmetic sparklines rather than
      // learned state, and saying so beats pretending the reload is lossless.
      return true;
    },

    save(map: HistoryMap): void {
      // A foreign file we could not archive is still on disk — do not let a
      // routine flush do what the archive refused to risk.
      if (persistBlocked) return;
      try {
        const nodes: Persisted['nodes'] = {};
        for (const [id, h] of map) {
          if (!Number.isInteger(id) || id <= 0) continue;
          const rssi = h.rssi.slice(-maxSamples);
          const rtt = h.rtt.slice(-maxSamples);
          const crssi = h.crssi.slice(-coarseMax);
          const crtt = h.crtt.slice(-coarseMax);
          if (rssi.length === 0 && rtt.length === 0 && crssi.length === 0 && crtt.length === 0) continue;
          nodes[String(id)] = { rssi, rtt, crssi, crtt };
        }
        const payload: Persisted = { v: SCHEMA_V, savedAt: now(), homeId: tagToWrite(boundHomeId, loadedHomeId), nodes };
        // Atomic: write temp on the SAME dir/fs, then rename onto the target.
        writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        renameSync(tmp, path);
      } catch (e) {
        (log.error ?? log)(`history: save failed (${(e as Error).message})`);
      }
    },
  };
}
