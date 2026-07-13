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

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { uptime as osUptime } from 'node:os';

/** One node's rolling RSSI + RTT sample rings (oldest → newest). */
export interface HistorySample {
  rssi: number[];
  rtt: number[];
}

/** node id → its sample rings. */
export type HistoryMap = Map<number, HistorySample>;

export interface HistoryStoreOptions {
  /** Absolute path on the /data volume, e.g. `/data/history.json`. */
  path: string;
  /** Cap per array (defensive; should match the in-memory ring size). */
  maxSamples?: number;
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
  log?: (msg: string) => void;
}

export interface HistoryStore {
  /** The file this store reads/writes (for logging/tests). */
  readonly path: string;
  /** Load persisted rings. Empty on missing / corrupt / wrong-schema / stale. */
  load(): HistoryMap;
  /** Atomically persist the current rings. Best-effort; never throws. */
  save(map: HistoryMap): void;
}

/** On-disk shape. `v` gates forward/backward-incompatible format changes. */
interface Persisted {
  v: number;
  savedAt: number;
  nodes: Record<string, { rssi: number[]; rtt: number[] }>;
}

const SCHEMA_V = 1;
const DEFAULT_MAX_SAMPLES = 60;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1h — covers any normal restart.
const DEFAULT_BOOT_GRACE_MS = 180 * 1000; // 3min — covers boot→addon-start→NTP.

export function createHistoryStore(opts: HistoryStoreOptions): HistoryStore {
  const path = opts.path;
  const tmp = `${path}.tmp`;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const bootGraceMs = opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const uptimeMs = opts.uptimeMs ?? (() => osUptime() * 1000);
  const log = opts.log ?? (() => {});

  /** Coerce an arbitrary value into a bounded array of finite numbers. */
  const cleanSeries = (a: unknown): number[] => {
    if (!Array.isArray(a)) return [];
    const out: number[] = [];
    for (const x of a) {
      if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
    }
    // Keep only the most-recent maxSamples (guards against a bloated file).
    return out.length > maxSamples ? out.slice(out.length - maxSamples) : out;
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
        if (obj.v !== SCHEMA_V) {
          log(`history: schema ${String(obj.v)} ≠ ${SCHEMA_V} — starting fresh`);
          return map;
        }
        // Guard (b): host just booted → wall clock may be pre-NTP (no RTC), so
        // any "fresh"-looking savedAt is untrustworthy. See the file header.
        if (bootGraceMs > 0 && uptimeMs() < bootGraceMs) {
          log(`history: host up ${Math.round(uptimeMs() / 1000)}s (< ${Math.round(bootGraceMs / 1000)}s) — clock may be pre-NTP, starting fresh`);
          return map;
        }
        // Guard (a): wall-clock age. `ageMs < 0` = future-dated (clock stepped
        // backwards since the save) — equally untrustworthy, so also discard.
        const savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : 0;
        const ageMs = now() - savedAt;
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
          const rssi = cleanSeries((v as { rssi?: unknown }).rssi);
          const rtt = cleanSeries((v as { rtt?: unknown }).rtt);
          if (rssi.length === 0 && rtt.length === 0) continue;
          map.set(id, { rssi, rtt });
        }
        log(`history: restored ${map.size} node(s) from ${path}`);
      } catch (e) {
        log(`history: load failed (${(e as Error).message}) — starting fresh`);
        return new Map();
      }
      return map;
    },

    save(map: HistoryMap): void {
      try {
        const nodes: Persisted['nodes'] = {};
        for (const [id, h] of map) {
          if (!Number.isInteger(id) || id <= 0) continue;
          const rssi = h.rssi.slice(-maxSamples);
          const rtt = h.rtt.slice(-maxSamples);
          if (rssi.length === 0 && rtt.length === 0) continue;
          nodes[String(id)] = { rssi, rtt };
        }
        const payload: Persisted = { v: SCHEMA_V, savedAt: now(), nodes };
        // Atomic: write temp on the SAME dir/fs, then rename onto the target.
        writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        renameSync(tmp, path);
      } catch (e) {
        log(`history: save failed (${(e as Error).message})`);
      }
    },
  };
}
