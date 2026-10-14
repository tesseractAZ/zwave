/**
 * Durable log archive (v0.75.4) — the add-on's own log and the Z-Wave JS
 * driver's log stream, in daily files in the add-on's config folder.
 *
 * WHY. HAOS fixes the systemd journal at 500 MB (`SystemMaxUse=500M` in a
 * read-only /etc/systemd/journald.conf, with no persisted drop-in), and the
 * busiest writer on the host decides how far back it reaches — about 41 h on
 * the reference host. A log review more than a day and a half after the last
 * one loses the gap for good. This archive keeps `log_archive_days` of both
 * streams, independent of the journal.
 *
 * WHERE. `LOG_ARCHIVE_DIR` (the run script exports /config/logs: the add-on's
 * `addon_config` folder, which the host shows as /addon_configs/<slug>/logs and
 * the SSH add-on can read without docker). `backup_exclude: logs/*` keeps it
 * out of backups.
 *
 * SECRETS. zwave-js already masks lock user codes, admin codes, credentials
 * and PINs in its CC log entries, and does not log a change of any value it
 * marks `secret`. This is a second layer, for whatever a driver version, a CC
 * or a line shape lets through: everything after a secret property name is
 * cut, an Entry Control notification loses its event data (zwave-js masks it
 * only for Enter and cached keys, and arming keypads send the PIN with
 * arm/disarm), and SmartStart DSKs, 128-bit key-shaped hex strings, JWTs and
 * bearer tokens are replaced. zwave-js hard-wraps its text at 80 columns
 * mid-token, so every pattern is also matched across those wraps. The cut fails
 * closed: a line that mentions a secret property keeps nothing after it.
 *
 * FAILURE. Writes count their bytes, so a write that fails part-way resumes
 * where it stopped instead of repeating what landed. Unwritten lines are held
 * (up to ARCHIVE_BUFFER_MAX per stream, oldest dropped and counted), the
 * failure is reported once per ARCHIVE_WARN_EVERY_MS, and the next flush
 * retries; the first write that succeeds again records how many lines were
 * lost. A folder removed under a running add-on is recreated. Nothing here can
 * throw into the caller.
 */
import { promises as fsp, appendFileSync, mkdirSync, createReadStream, createWriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export type ArchiveStream = 'zwave-tui' | 'zwave-js';
const STREAMS: readonly ArchiveStream[] = ['zwave-tui', 'zwave-js'];

export const ARCHIVE_FLUSH_MS = 2_000;
export const ARCHIVE_HOUSEKEEP_MS = 60 * 60_000;
/** Bytes held per stream while writes fail; older lines are dropped past it. */
export const ARCHIVE_BUFFER_MAX = 1 << 20;
export const ARCHIVE_WARN_EVERY_MS = 10 * 60_000;
const FILE_RE = /^(zwave-tui|zwave-js)-(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/;
/** A compression a crash interrupted (housekeeping is serialized, so any found is stale). */
const TMP_RE = /^(?:zwave-tui|zwave-js)-\d{4}-\d{2}-\d{2}\.log\.gz\.tmp$/;

export interface LogArchiveOptions {
  /** Directory for the files; null = off. */
  dir: string | null;
  /** Days kept, today included; 0 = off. */
  days: number;
  /** Cap on the archive's total size, oldest whole files deleted first. */
  maxBytes: number;
  /** Archive the driver's log stream as well as the add-on's own log. */
  driver: boolean;
  now?: () => number;
  /** Must not log back into the archive's caller (the run uses stdout). */
  warn?: (msg: string) => void;
  /** Timers off — tests drive flush() and housekeep() themselves. */
  timers?: boolean;
  /** Opens a file for appending (tests inject short writes). */
  openAppend?: (path: string) => Promise<Pick<FileHandle, 'write' | 'close'>>;
}

export interface LogArchiveStatus {
  enabled: boolean;
  driver: boolean;
  dir: string | null;
  days: number;
  maxBytes: number;
  dropped: number;
  lastError: string | null;
}

export interface LogArchive {
  /** One line of the add-on's own log (as the logger writes it). */
  tui(line: string): void;
  /** One driver `logging` event from the driver WebSocket. */
  driver(ev: Record<string, unknown>): void;
  flush(): Promise<void>;
  /** Gzip finished days, then prune by age and by total size. */
  housekeep(): Promise<void>;
  /** Flush and stop the timers. */
  close(): Promise<void>;
  /** Last resort for an exiting process: write what is buffered, synchronously. */
  flushSync(): void;
  status(): LogArchiveStatus;
}

/** UTC day key of an epoch-ms instant. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// A secret property in either of the two shapes a value change is logged in:
// the driver's `[User Code] userCode[3]: …` and zwave-js-server's
// `99-0-userCode-3 …`. Everything after the first match is cut.
const SECRET_PROP = /\b(?:userCode|adminCode|adminPinCode|credential)\b(?:\[[^\]]*\]|-[\w]+)?/;
const SECRET_CC = /\[(?:User Code|User Credential)\]/;
// An Entry Control notification's event data (the last field zwave-js prints).
const ENTRY_CONTROL = /EntryControlCCNotification/;
const EVENT_DATA = /event data:/;
// Replaced wherever they appear. Digit/hex lookarounds, not \b: a wrap can
// glue a token to the word before it.
const REPLACE: readonly (readonly [RegExp, string])[] = [
  [/(?<!\d)\d{5}(?:-\d{5}){7}(?!\d)/g, '(redacted DSK)'],
  [/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{32}(?![0-9a-fA-F])/g, '(redacted key)'],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '(redacted token)'],
  [/(?<=\bBearer\s+)\S+/gi, '(redacted)'],
];

/**
 * The views a pattern is matched in: the text as written, and the text with
 * every line break and the indent after it removed — zwave-js cuts its text at
 * 80 columns wherever the column falls, so a DSK or a property name can be
 * split across two lines. `at[i]` is the index in `s` of view character `i`.
 */
function views(s: string): { t: string; at: number[] | null }[] {
  let flat = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      while (s[i + 1] === ' ' || s[i + 1] === '\t') i++;
      continue;
    }
    flat += s[i];
    at.push(i);
  }
  return [{ t: s, at: null }, { t: flat, at }];
}

/** The end (exclusive, in `s`) of the first match of `re` in any view, or -1. */
function endOf(vs: { t: string; at: number[] | null }[], re: RegExp): number {
  let end = -1;
  for (const v of vs) {
    const m = re.exec(v.t);
    if (!m) continue;
    const last = m.index + m[0].length - 1;
    const e = (v.at ? v.at[last] : last) + 1;
    if (end < 0 || e < end) end = e;
  }
  return end;
}

/** Remove secrets from one log line (exported for tests). */
export function redactLine(line: string): string {
  let vs = views(line);
  // 1. Cuts: everything after the first secret marker goes.
  let cut = endOf(vs, SECRET_PROP);
  if (cut < 0) {
    // A User Code / User Credential line whose property is not one of the four
    // (a future secret value): keep the tags, drop the payload after them.
    cut = endOf(vs, SECRET_CC);
  }
  if (endOf(vs, ENTRY_CONTROL) >= 0) {
    const e = endOf(vs, EVENT_DATA);
    if (e >= 0 && (cut < 0 || e < cut)) cut = e;
  }
  let s = line;
  if (cut >= 0) {
    s = line.slice(0, cut);
    vs = views(s);
  }
  // 2. Replacements, as spans of `s` (a span that crosses a wrap takes the
  // wrap with it); the earlier rule wins an overlap.
  const spans: { a: number; b: number; label: string }[] = [];
  for (const [re, label] of REPLACE) {
    for (const v of vs) {
      for (const m of v.t.matchAll(re)) {
        const i = m.index;
        const j = i + m[0].length - 1;
        const a = v.at ? v.at[i] : i;
        const b = (v.at ? v.at[j] : j) + 1;
        if (!spans.some((x) => a < x.b && b > x.a)) spans.push({ a, b, label });
      }
    }
  }
  spans.sort((x, y) => x.a - y.a);
  let out = '';
  let from = 0;
  for (const x of spans) {
    out += s.slice(from, x.a) + x.label;
    from = x.b;
  }
  out += s.slice(from);
  return cut >= 0 ? `${out} (redacted)` : out;
}

/** The text of a driver `logging` event, or null when it carries none. */
export function driverEventText(ev: Record<string, unknown>): string | null {
  const f = ev.formattedMessage;
  let text: string | null = null;
  if (typeof f === 'string' && f.trim()) text = f;
  else if (Array.isArray(f) && f.every((x) => typeof x === 'string')) text = f.join('\n');
  else if (typeof ev.message === 'string' && ev.message.trim()) {
    const level = typeof ev.level === 'string' ? `${ev.level.toUpperCase()} ` : '';
    const tags = typeof ev.primaryTags === 'string' ? `${ev.primaryTags} ` : '';
    text = `${level}${tags}${ev.message}`;
  }
  if (text == null) return null;
  // ANSI colour off; a multi-line entry stays one entry, continuation indented.
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '').replace(/\r?\n/g, '\n    ');
}

/** One buffered line (or, after a short write, the unwritten tail of one). */
interface Pending { day: string; data: Buffer }
/** One day's lines for one file, as written; `written` counts bytes landed. */
interface Group { day: string; parts: Buffer[]; marker: number; data: Buffer; written: number }

export function createLogArchive(o: LogArchiveOptions): LogArchive {
  const now = o.now ?? Date.now;
  const warn = o.warn ?? ((m: string) => { process.stdout.write(`[zwave-tui] WARNING: ${m}\n`); });
  const openAppend = o.openAppend ?? ((path: string) => fsp.open(path, 'a'));
  const enabled = o.dir != null && o.days > 0;
  const dir = o.dir;
  const buf: Record<ArchiveStream, Pending[]> = { 'zwave-tui': [], 'zwave-js': [] };
  const held: Record<ArchiveStream, number> = { 'zwave-tui': 0, 'zwave-js': 0 };
  const lost: Record<ArchiveStream, number> = { 'zwave-tui': 0, 'zwave-js': 0 };
  // Taken by a flush and not yet written: flushSync writes what is left of them.
  const inflight: Record<ArchiveStream, Group[]> = { 'zwave-tui': [], 'zwave-js': [] };
  let dropped = 0;
  let lastError: string | null = null;
  let lastWarnAt = -Infinity;
  let chain: Promise<void> = Promise.resolve();
  let lastDay: string | null = null;
  let madeDir = false;
  const timers: NodeJS.Timeout[] = [];

  const fileOf = (s: ArchiveStream, day: string, gz = false): string => join(dir!, `${s}-${day}.log${gz ? '.gz' : ''}`);

  const fail = (what: string, e: unknown): void => {
    lastError = `${what}: ${(e as Error)?.message ?? String(e)}`;
    if (now() - lastWarnAt >= ARCHIVE_WARN_EVERY_MS) {
      lastWarnAt = now();
      warn(`log archive: ${lastError} — lines are held and retried`);
    }
  };

  /** Hold at most ARCHIVE_BUFFER_MAX per stream: the oldest lines go, counted. */
  const trim = (s: ArchiveStream): void => {
    while (held[s] > ARCHIVE_BUFFER_MAX && buf[s].length > 1) {
      const x = buf[s].shift()!;
      held[s] -= x.data.length;
      lost[s] += 1;
      dropped += 1;
    }
  };

  const push = (s: ArchiveStream, text: string): void => {
    if (!enabled) return;
    const t = now();
    const data = Buffer.from(`${new Date(t).toISOString()} ${redactLine(text)}\n`);
    buf[s].push({ day: dayOf(t), data });
    held[s] += data.length;
    trim(s);
  };

  /** Take everything buffered for a stream, grouped by day (oldest first); the
   *  first group leads with the loss marker when lines were dropped. */
  const take = (s: ArchiveStream): Group[] => {
    const items = buf[s];
    buf[s] = [];
    held[s] = 0;
    const groups: Group[] = [];
    for (const p of items) {
      const g = groups[groups.length - 1];
      if (g && g.day === p.day) g.parts.push(p.data);
      else groups.push({ day: p.day, parts: [p.data], marker: 0, data: Buffer.alloc(0), written: 0 });
    }
    if (groups.length > 0 && lost[s] > 0) {
      groups[0].marker = lost[s];
      groups[0].parts.unshift(Buffer.from(`${new Date(now()).toISOString()} [archive] ${lost[s]} line(s) lost while the archive could not be written\n`));
    }
    for (const g of groups) g.data = Buffer.concat(g.parts);
    return groups;
  };

  /** The marker's count is settled once any of it lands; a later loss gets the next marker. */
  const settle = (s: ArchiveStream, g: Group): void => {
    if (g.marker > 0 && g.written > 0) { lost[s] -= g.marker; g.marker = 0; }
  };

  /** Put back, line by line and ahead of anything newer, what these groups did not write. */
  const putBack = (s: ArchiveStream, groups: Group[]): void => {
    const back: Pending[] = [];
    for (const g of groups) {
      let off = 0;
      g.parts.forEach((part, k) => {
        const end = off + part.length;
        // An unwritten marker is rebuilt by the next take(), with the count then.
        if (end > g.written && !(k === 0 && g.marker > 0)) {
          back.push({ day: g.day, data: off >= g.written ? part : part.subarray(g.written - off) });
        }
        off = end;
      });
    }
    buf[s] = [...back, ...buf[s]];
    held[s] = buf[s].reduce((a, x) => a + x.data.length, 0);
    trim(s);
  };

  const write = async (path: string, g: Group): Promise<void> => {
    const fh = await openAppend(path);
    try {
      while (g.written < g.data.length) {
        const { bytesWritten } = await fh.write(g.data, g.written);
        if (bytesWritten <= 0) throw new Error('short write');
        g.written += bytesWritten;
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
  };

  const doFlush = async (): Promise<void> => {
    if (!enabled) return;
    try {
      if (!madeDir) { await fsp.mkdir(dir!, { recursive: true }); madeDir = true; }
    } catch (e) { fail('cannot create the directory', e); return; }
    for (const s of STREAMS) {
      const groups = take(s);
      inflight[s] = groups;
      for (let i = 0; i < groups.length; i++) {
        try {
          await write(fileOf(s, groups[i].day), groups[i]);
          settle(s, groups[i]);
        } catch (e) {
          // The folder was removed under us: make it again on the next flush.
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') madeDir = false;
          settle(s, groups[i]);
          putBack(s, groups.slice(i));
          fail(`cannot write ${s}`, e);
          break;
        }
      }
      inflight[s] = [];
    }
    const today = dayOf(now());
    if (lastDay != null && today !== lastDay) void housekeep();
    lastDay = today;
  };

  const flush = (): Promise<void> => (chain = chain.then(doFlush, doFlush));

  const gzipFile = async (from: string, to: string, append: boolean): Promise<void> => {
    const tmp = `${to}.tmp`;
    await pipeline(createReadStream(from), createGzip(), createWriteStream(tmp));
    // A late line for a day already compressed (held through a failing write
    // across midnight) becomes one more gzip member; zcat reads them in order.
    if (append) {
      await fsp.appendFile(to, await fsp.readFile(tmp));
      await fsp.unlink(tmp);
    } else await fsp.rename(tmp, to);
    await fsp.unlink(from);
  };

  const doHousekeep = async (): Promise<void> => {
    if (!enabled) return;
    let names: string[];
    try { names = await fsp.readdir(dir!); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') fail('cannot list the directory', e);
      return;
    }
    const today = dayOf(now());
    // 1. Finished days are compressed; an interrupted compression is discarded.
    for (const n of names) {
      if (TMP_RE.test(n)) {
        try { await fsp.unlink(join(dir!, n)); } catch (e) { fail(`cannot delete ${n}`, e); }
        continue;
      }
      const m = FILE_RE.exec(n);
      if (!m || m[3] || m[2] >= today) continue;
      const gz = `${n}.gz`;
      try { await gzipFile(join(dir!, n), join(dir!, gz), names.includes(gz)); } catch (e) { fail(`cannot compress ${n}`, e); }
    }
    try { names = await fsp.readdir(dir!); } catch { return; }
    // 2. Older than the window: deleted.
    const oldest = dayOf(now() - (o.days - 1) * 86_400_000);
    const kept: { name: string; day: string; size: number }[] = [];
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (!m) continue;
      if (m[2] < oldest) {
        try { await fsp.unlink(join(dir!, n)); } catch (e) { fail(`cannot delete ${n}`, e); }
        continue;
      }
      try { kept.push({ name: n, day: m[2], size: (await fsp.stat(join(dir!, n))).size }); } catch { /* raced */ }
    }
    // 3. Over the size cap: oldest whole files go first; today's never. A file
    // dated after today (a clock that ran ahead) cannot age out, so the cap
    // reaches it last but does reach it.
    let total = kept.reduce((a, f) => a + f.size, 0);
    kept.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name < b.name ? -1 : 1));
    for (const f of kept) {
      if (total <= o.maxBytes) break;
      if (f.day === today) continue;
      try { await fsp.unlink(join(dir!, f.name)); total -= f.size; } catch (e) { fail(`cannot delete ${f.name}`, e); }
    }
  };

  const housekeep = (): Promise<void> => (chain = chain.then(doHousekeep, doHousekeep));

  if (enabled && o.timers !== false) {
    const f = setInterval(() => { void flush(); }, ARCHIVE_FLUSH_MS);
    const h = setInterval(() => { void housekeep(); }, ARCHIVE_HOUSEKEEP_MS);
    f.unref(); h.unref();
    timers.push(f, h);
    void housekeep();
  }

  return {
    tui(line) {
      push('zwave-tui', line.replace(/\s+$/, ''));
    },
    driver(ev) {
      if (!o.driver) return;
      const text = driverEventText(ev);
      if (text != null) push('zwave-js', text);
    },
    flush,
    housekeep,
    async close() {
      for (const t of timers) clearInterval(t);
      await flush();
    },
    flushSync() {
      if (!enabled) return;
      try {
        mkdirSync(dir!, { recursive: true });
        for (const s of STREAMS) {
          // What a flush took and has not finished writing comes first, so the
          // line that explains an exit follows the lines before it.
          for (const g of [...inflight[s], ...take(s)]) {
            if (g.written >= g.data.length) continue;
            appendFileSync(fileOf(s, g.day), g.data.subarray(g.written));
            g.written = g.data.length;
            settle(s, g);
          }
          inflight[s] = [];
        }
      } catch { /* exiting: nothing more can be done */ }
    },
    status: () => ({ enabled, driver: enabled && o.driver, dir, days: o.days, maxBytes: o.maxBytes, dropped, lastError }),
  };
}
