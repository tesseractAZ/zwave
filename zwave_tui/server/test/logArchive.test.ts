/**
 * The durable log archive (v0.75.4): the add-on's log and the driver's log
 * stream in daily files, redacted, compressed when finished, pruned by age and
 * by size, and never lost to a failed write without saying so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync, existsSync, statSync, utimesSync, promises as fsp } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogArchive, redactLine, driverEventText, dayOf, ARCHIVE_BUFFER_MAX, readBackupHold, ARCHIVE_HOLD_MAX_MS, type BackupHold } from '../src/logArchive';
import { intEnv } from '../src/config';

const T = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400_000;
const mk = (over: Partial<Parameters<typeof createLogArchive>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-archive-'));
  const clock = { now: T };
  const warned: string[] = [];
  const noted: string[] = [];
  const a = createLogArchive({ dir, days: 14, maxBytes: 200 * 1024 * 1024, driver: true, now: () => clock.now, warn: (m) => warned.push(m), note: (m) => noted.push(m), timers: false, ...over });
  return { a, dir, clock, warned, noted, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8');

test('the add-on log: one ISO-stamped line per entry, in the UTC day\'s file', async () => {
  const h = mk();
  try {
    h.a.tui('[zwave-tui] Z-Wave TUI v0.75.4 starting — HA ws://supervisor/core/websocket\n');
    h.a.tui('[zwave-tui] WARNING: something   \n');
    await h.a.flush();
    assert.equal(read(h.dir, 'zwave-tui-2026-10-14.log'),
      '2026-10-14T12:00:00.000Z [zwave-tui] Z-Wave TUI v0.75.4 starting — HA ws://supervisor/core/websocket\n' +
      '2026-10-14T12:00:00.000Z [zwave-tui] WARNING: something\n');
  } finally { h.done(); }
});

test('the driver stream: the formatted message, ANSI off, a multi-line entry kept as one; off when log_archive_driver is off', async () => {
  const h = mk();
  try {
    h.a.driver({ source: 'driver', event: 'logging', formattedMessage: '\x1b[32m2026-10-14 05:00:00.000 INFO CNTRLR: [Node 060] Value updated: 112-0-8 0 => 3\x1b[39m\n' });
    h.a.driver({ source: 'driver', event: 'logging', formattedMessage: ['line one', 'line two'] });
    h.a.driver({ source: 'driver', event: 'logging', level: 'warn', primaryTags: '[Node 007]', message: 'no formatted text' });
    h.a.driver({ source: 'driver', event: 'logging' });
    await h.a.flush();
    assert.equal(read(h.dir, 'zwave-js-2026-10-14.log'),
      '2026-10-14T12:00:00.000Z 2026-10-14 05:00:00.000 INFO CNTRLR: [Node 060] Value updated: 112-0-8 0 => 3\n' +
      '2026-10-14T12:00:00.000Z line one\n    line two\n' +
      '2026-10-14T12:00:00.000Z WARN [Node 007] no formatted text\n');
  } finally { h.done(); }
  const off = mk({ driver: false });
  try {
    off.a.driver({ formattedMessage: 'x' });
    off.a.tui('[zwave-tui] kept');
    await off.a.flush();
    assert.deepEqual(readdirSync(off.dir), ['zwave-tui-2026-10-14.log'], 'only the add-on log');
    assert.equal(off.a.status().driver, false);
  } finally { off.done(); }
});

test('secrets are cut before anything is buffered — both log shapes, and a secret CC with an unknown property', () => {
  // zwave-js masks these itself; this is the second layer, for a shape it misses.
  assert.equal(redactLine('[Node 012] [~] [User Code] userCode[3]: 1234 => 5678'), '[Node 012] [~] [User Code] userCode[3] (redacted)');
  assert.equal(redactLine('[Node 012] Value updated: 99-0-userCode-3 1234 => 5678'), '[Node 012] Value updated: 99-0-userCode-3 (redacted)');
  assert.equal(redactLine('[Node 012] [+] [User Code] adminCode: 246810'), '[Node 012] [+] [User Code] adminCode (redacted)');
  assert.equal(redactLine('[Node 014] [~] [User Credential] credential[65537]: abcd => efgh'), '[Node 014] [~] [User Credential] credential[65537] (redacted)');
  assert.equal(redactLine('[Node 014] [~] [User Credential] adminPinCode: 9999'), '[Node 014] [~] [User Credential] adminPinCode (redacted)');
  assert.equal(redactLine('[Node 014] [~] [User Credential] someFutureSecret: 4242'), '[Node 014] [~] [User Credential] (redacted)', 'fails closed');
  assert.equal(redactLine('DSK 12345-23456-34567-45678-56789-01234-12345-23456 pending'), 'DSK (redacted DSK) pending');
  assert.equal(redactLine('key 0x0123456789abcdef0123456789ABCDEF set'), 'key (redacted key) set');
  assert.equal(redactLine('auth eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ok'), 'auth (redacted token) ok');
  assert.equal(redactLine('Authorization: Bearer abc.def-123'), 'Authorization: Bearer (redacted)');
  const plain = '[Node 060] Value updated: 112-0-8 0 => 3';
  assert.equal(redactLine(plain), plain, 'an ordinary value change is untouched');
});

test('the redaction reaches the file', async () => {
  const h = mk();
  try {
    h.a.driver({ formattedMessage: 'INFO CNTRLR: [Node 012] [~] [User Code] userCode[1]: 1111 => 2222' });
    h.a.tui('[zwave-tui] token Bearer secret-value');
    await h.a.flush();
    const all = read(h.dir, 'zwave-js-2026-10-14.log') + read(h.dir, 'zwave-tui-2026-10-14.log');
    assert.doesNotMatch(all, /1111|2222|secret-value/);
  } finally { h.done(); }
});

test('an entry is filed under its own UTC day across midnight', async () => {
  const h = mk();
  try {
    h.clock.now = Date.UTC(2026, 9, 14, 23, 59, 59, 900);
    h.a.tui('[zwave-tui] before');
    h.clock.now = Date.UTC(2026, 9, 15, 0, 0, 0, 100);
    h.a.tui('[zwave-tui] after');
    await h.a.flush();
    assert.match(read(h.dir, 'zwave-tui-2026-10-14.log'), /before/);
    assert.match(read(h.dir, 'zwave-tui-2026-10-15.log'), /after/);
    assert.equal(dayOf(h.clock.now), '2026-10-15');
  } finally { h.done(); }
});

test('housekeeping: finished days gzipped, older than the window deleted, today never touched', async () => {
  const h = mk({ days: 3 });
  try {
    for (const [d, s] of [['2026-10-10', 'zwave-tui'], ['2026-10-11', 'zwave-js'], ['2026-10-12', 'zwave-js'], ['2026-10-13', 'zwave-tui']] as const) {
      writeFileSync(join(h.dir, `${s}-${d}.log`), `${d} ${s}\n`);
    }
    writeFileSync(join(h.dir, 'unrelated.txt'), 'kept');
    h.a.tui('[zwave-tui] today');
    await h.a.flush();
    await h.a.housekeep();
    assert.deepEqual(readdirSync(h.dir).sort(), ['unrelated.txt', 'zwave-js-2026-10-12.log.gz', 'zwave-tui-2026-10-13.log.gz', 'zwave-tui-2026-10-14.log'],
      '3 days kept (12, 13, 14) — 10-11 is the 4th day back and goes; finished days compressed; other files left alone');
    assert.equal(gunzipSync(readFileSync(join(h.dir, 'zwave-tui-2026-10-13.log.gz'))).toString(), '2026-10-13 zwave-tui\n');
  } finally { h.done(); }
});

test('the size cap deletes the oldest whole files first, and never today\'s', async () => {
  const h = mk({ days: 30, maxBytes: 2500 });
  try {
    const big = 'x'.repeat(1000);
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13']) writeFileSync(join(h.dir, `zwave-js-${d}.log.gz`), big);
    writeFileSync(join(h.dir, 'zwave-js-2026-10-14.log'), big + big + big);
    await h.a.housekeep();
    assert.deepEqual(readdirSync(h.dir).sort(), ['zwave-js-2026-10-14.log'], 'today alone is over the cap: every older file goes, and today stays');
  } finally { h.done(); }
  const h2 = mk({ days: 30, maxBytes: 2500 });
  try {
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13']) writeFileSync(join(h2.dir, `zwave-js-${d}.log.gz`), 'y'.repeat(1000));
    await h2.a.housekeep();
    assert.deepEqual(readdirSync(h2.dir).sort(), ['zwave-js-2026-10-12.log.gz', 'zwave-js-2026-10-13.log.gz'], 'only as many as needed, oldest first');
  } finally { h2.done(); }
});

test('off: 0 days or no directory writes nothing and says so', async () => {
  for (const over of [{ days: 0 }, { dir: null }]) {
    const h = mk(over);
    try {
      h.a.tui('[zwave-tui] x');
      h.a.driver({ formattedMessage: 'y' });
      await h.a.flush();
      await h.a.housekeep();
      h.a.flushSync();
      assert.deepEqual(readdirSync(h.dir), []);
      assert.equal(h.a.status().enabled, false);
    } finally { h.done(); }
  }
});

test('a failed write holds the lines, warns once, and writes them — with a count of any it had to drop — when it can', async (tc) => {
  if (process.getuid?.() === 0) { tc.skip('root ignores directory permissions'); return; }
  const h = mk();
  try {
    h.a.tui('[zwave-tui] first');
    await h.a.flush();
    chmodSync(h.dir, 0o555);
    try {
      // A read-only folder still lets an existing file grow; it is a NEW day's
      // file that cannot be created. Fill past the per-stream buffer there, so
      // the oldest held lines are dropped.
      h.clock.now = T + DAY;
      const line = '[zwave-tui] ' + 'z'.repeat(1000);
      const n = Math.ceil(ARCHIVE_BUFFER_MAX / 1000) + 50;
      for (let i = 0; i < n; i++) h.a.tui(line);
      h.a.tui('[zwave-tui] held');
      await h.a.flush();
      await h.a.flush();
      assert.equal(h.warned.length, 1, 'said once, not per flush');
      assert.match(h.warned[0], /cannot write zwave-tui/);
      assert.ok(h.a.status().dropped > 0, 'the overflow is counted');
    } finally { chmodSync(h.dir, 0o755); }
    await h.a.flush();
    const tomorrow = read(h.dir, 'zwave-tui-2026-10-15.log');
    assert.match(tomorrow, /held/, 'the held line was written once the folder was writable');
    const todayText = existsSync(join(h.dir, 'zwave-tui-2026-10-14.log')) ? read(h.dir, 'zwave-tui-2026-10-14.log') : '';
    assert.match(todayText + tomorrow, /\[archive\] \d+ line\(s\) lost while the archive could not be written/, 'and the loss is written down');
    assert.equal((todayText + tomorrow).match(/\[archive\]/g)?.length, 1, 'once');
  } finally { h.done(); }
});

test('flushSync writes what is buffered at once — the exit path', () => {
  const h = mk();
  try {
    h.a.tui('[zwave-tui] FATAL: the reason for the crash');
    h.a.flushSync();
    assert.match(read(h.dir, 'zwave-tui-2026-10-14.log'), /the reason for the crash/);
    assert.ok(statSync(join(h.dir, 'zwave-tui-2026-10-14.log')).size > 0);
  } finally { h.done(); }
});

/** A message as zwave-js prints it: cut at 80 columns wherever the column
 *  falls (core/log/format.ts formatLogMessage), continuations indented. */
const wrapped = (prefix: string, message: string): string => {
  const lines: string[] = [];
  let rest = message;
  let width = 80 - prefix.length - 1;
  while (rest.length) { lines.push(rest.slice(0, width)); rest = rest.slice(width); width = 78; }
  return prefix + lines.join('\n' + ' '.repeat(prefix.length));
};

test('a DSK, a property name or a token split by zwave-js\'s 80-column wrap is still redacted', () => {
  const DSK = '12345-23456-34567-45678-56789-01234-12345-23456';
  const P = '2026-10-14T05:00:00.000Z CNTRLR   ';
  // The two messages that print a DSK (zwave-js Controller.ts).
  const failed = wrapped(P, `SmartStart inclusion failed for DSK ${DSK} (attempt 1/5).`);
  const disabled = wrapped(P, `Provisioning entry for DSK ${DSK} has been disabled after 5 failed inclusion attempts.`);
  assert.ok(failed.includes('\n') && !failed.includes(DSK), 'the fixture really splits the DSK');
  for (const e of [failed, disabled]) {
    const out = redactLine(driverEventText({ formattedMessage: e })!);
    assert.doesNotMatch(out, /\d{5}/, `no DSK digits survive: ${out}`);
    assert.match(out, /\(redacted DSK\)/);
  }
  const joined = (e: string) => redactLine(driverEventText({ formattedMessage: e })!).replace(/\n\s+/g, '');
  assert.match(joined(failed), /\(redacted DSK\) \(attempt 1\/5\)\.$/, 'the text after it is kept');
  assert.match(joined(disabled), /\(redacted DSK\) has been disabled after 5 failed inclusion attempts\.$/);
  // A wrap that falls just before the DSK, eating the space before it.
  assert.equal(redactLine(`for DSK\n     ${DSK} ok`), 'for DSK\n     (redacted DSK) ok');
  // A property name cut in two.
  assert.equal(redactLine('[Node 012] [~] [User Code] userCo\n          de[3]: 1234 => 5678'), '[Node 012] [~] [User Code] userCo\n          de[3] (redacted)');
  // A key, a JWT and a bearer token cut in two.
  assert.doesNotMatch(redactLine('key 0123456789abcdef01234\n    56789ABCDEF set'), /0123|CDEF/);
  assert.doesNotMatch(redactLine('auth eyJhbGciOi.eyJzd\n    WIiOi.c2lnbmF0dXJl ok'), /eyJ|c2ln/);
  assert.equal(redactLine('Bearer\n    abc.def'), 'Bearer\n    (redacted)');
});

test('an Entry Control notification loses its event data — arm/disarm keypads send the PIN', () => {
  const entry = driverEventText({ formattedMessage: '« [Node 044] [REQ] [ApplicationCommand]\n  └─[EntryControlCCNotification]\n      sequence number: 7\n      data type:       ASCII\n      event type:      DisarmAll\n      event data:      2468' })!;
  const out = redactLine(entry);
  assert.doesNotMatch(out, /2468/);
  assert.match(out, /event type:\s+DisarmAll\n\s+event data: \(redacted\)$/, 'the event type stays: it is what a review needs');
  const other = 'INFO CNTRLR: [Node 044] notification event data: 2468';
  assert.equal(redactLine(other), other, 'only inside an Entry Control notification');
});

/** An appender that lands `allow` bytes, then fails like a full disk. */
const shortDisk = (allow: { bytes: number }) => async (path: string) => {
  const fh = await fsp.open(path, 'a');
  return {
    write: async (b: Buffer, off: number) => {
      if (allow.bytes === Infinity) return fh.write(b, off);
      if (allow.bytes <= 0) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      const n = Math.min(allow.bytes, b.length - off);
      allow.bytes -= n;
      return fh.write(b, off, n);
    },
    close: () => fh.close(),
  } as never;
};

test('a write that fails part-way resumes where it stopped: nothing repeated, nothing torn', async () => {
  // 80 bytes: the first 64-byte line lands whole, the second is cut in two.
  const allow = { bytes: 80 };
  const h = mk({ openAppend: shortDisk(allow) });
  try {
    for (const w of ['alpha', 'bravo', 'charlie']) h.a.tui(`[zwave-tui] ${w} ${'.'.repeat(20)}`);
    await h.a.flush();
    assert.equal(h.warned.length, 1, 'the failure is reported');
    allow.bytes = Infinity;
    await h.a.flush();
    const text = read(h.dir, 'zwave-tui-2026-10-14.log');
    assert.equal(text, ['alpha', 'bravo', 'charlie'].map((w) => `2026-10-14T12:00:00.000Z [zwave-tui] ${w} ${'.'.repeat(20)}\n`).join(''));
    assert.equal(h.a.status().dropped, 0);
  } finally { h.done(); }
});

test('held lines overflow one line at a time, and the marker counts exactly the lines dropped', async () => {
  const allow = { bytes: 0 };
  const h = mk({ openAppend: shortDisk(allow) });
  try {
    const line = (i: number) => `[zwave-tui] ${String(i).padStart(5, '0')} ${'z'.repeat(960)}`;
    const per = Buffer.byteLength(`2026-10-14T12:00:00.000Z ${line(0)}\n`);
    const fit = Math.floor(ARCHIVE_BUFFER_MAX / per);
    let i = 0;
    for (; i < fit - 2; i++) h.a.tui(line(i));
    await h.a.flush();                      // fails: every line is put back
    for (let k = 0; k < 7; k++, i++) h.a.tui(line(i));
    const dropped = h.a.status().dropped;
    assert.equal(dropped, 5, 'the 5 oldest lines past the cap, not the whole put-back block');
    allow.bytes = Infinity;
    await h.a.flush();
    const text = read(h.dir, 'zwave-tui-2026-10-14.log');
    assert.match(text, /\[archive\] 5 line\(s\) lost while the archive could not be written/);
    assert.equal(text.split('\n').filter((l) => l.includes('[zwave-tui] ')).length, i - 5, 'every other line is written');
    assert.doesNotMatch(text, /\[zwave-tui\] 00004 /, 'the dropped ones are the oldest');
    assert.match(text, /\[zwave-tui\] 00005 /);
    h.a.tui('[zwave-tui] after');
    await h.a.flush();
    assert.equal(read(h.dir, 'zwave-tui-2026-10-14.log').match(/\[archive\]/g)?.length, 1, 'a reported loss is settled, not reported again');
  } finally { h.done(); }
});

test('a line a short write landed whole is not held again — an empty leftover would be counted as a lost line', async () => {
  const line = (i: number) => `[zwave-tui] ${String(i).padStart(5, '0')} ${'z'.repeat(960)}`;
  const per = Buffer.byteLength(`2026-10-14T12:00:00.000Z ${line(0)}\n`);
  const allow = { bytes: per };             // line 0 lands whole, then the disk is full
  const h = mk({ openAppend: shortDisk(allow) });
  try {
    h.a.tui(line(0));
    h.a.tui(line(1));
    await h.a.flush();
    const fit = Math.floor(ARCHIVE_BUFFER_MAX / per);
    for (let i = 2; i < 2 + fit; i++) h.a.tui(line(i));  // one line over the cap
    assert.equal(h.a.status().dropped, 1, 'exactly line 1 is dropped');
    allow.bytes = Infinity;
    await h.a.flush();
    const text = read(h.dir, 'zwave-tui-2026-10-14.log');
    assert.match(text, /\[archive\] 1 line\(s\) lost/);
    assert.equal((text.match(/\[zwave-tui\] 00000 /g) ?? []).length, 1, 'line 0 once');
  } finally { h.done(); }
});

test('a folder removed under a running add-on is made again', async () => {
  const h = mk();
  try {
    h.a.tui('[zwave-tui] one');
    await h.a.flush();
    rmSync(h.dir, { recursive: true, force: true });
    h.a.tui('[zwave-tui] two');
    await h.a.flush();                      // ENOENT: held
    await h.a.flush();                      // the folder is made again
    assert.match(read(h.dir, 'zwave-tui-2026-10-14.log'), /two/);
  } finally { h.done(); }
});

test('housekeeping: a late line for a compressed day joins it as a gzip member; a crashed compression is cleared', async () => {
  const h = mk();
  try {
    writeFileSync(join(h.dir, 'zwave-tui-2026-10-13.log.gz'), gzipSync('early\n'));
    writeFileSync(join(h.dir, 'zwave-tui-2026-10-13.log'), 'late\n');
    writeFileSync(join(h.dir, 'zwave-js-2026-10-12.log.gz.tmp'), 'half');
    await h.a.housekeep();
    assert.deepEqual(readdirSync(h.dir).sort(), ['zwave-tui-2026-10-13.log.gz']);
    assert.equal(gunzipSync(readFileSync(join(h.dir, 'zwave-tui-2026-10-13.log.gz'))).toString(), 'early\nlate\n');
  } finally { h.done(); }
});

test('the size cap reaches a file dated after today (a clock that ran ahead) — it can never age out', async () => {
  const h = mk({ days: 30, maxBytes: 2500 });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-13.log.gz'), 'x'.repeat(100));
    writeFileSync(join(h.dir, 'zwave-js-2026-11-20.log.gz'), 'x'.repeat(2000));
    writeFileSync(join(h.dir, 'zwave-js-2026-10-14.log'), 'x'.repeat(1000));
    await h.a.housekeep();
    assert.deepEqual(readdirSync(h.dir).sort(), ['zwave-js-2026-10-14.log']);
  } finally { h.done(); }
});

test('flushSync writes what a flush took and has not written yet, before the exit line, once', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const parked = new Promise<void>((r) => { entered = r; });
  const h = mk({ openAppend: async (p) => { entered(); await gate; return fsp.open(p, 'a'); } });
  try {
    h.a.tui('[zwave-tui] taken by the flush');
    const pending = h.a.flush();
    await parked;                           // it has taken the line and waits to open the file
    assert.equal(existsSync(join(h.dir, 'zwave-tui-2026-10-14.log')), false, 'nothing written yet');
    h.a.tui('[zwave-tui] FATAL: why it stopped');
    h.a.flushSync();
    release();
    await pending;
    assert.equal(read(h.dir, 'zwave-tui-2026-10-14.log'),
      '2026-10-14T12:00:00.000Z [zwave-tui] taken by the flush\n2026-10-14T12:00:00.000Z [zwave-tui] FATAL: why it stopped\n');
  } finally { h.done(); }
});

// ── v0.76.0 fixtures: zwave-js 15.31.1 lines as zwave-js-server 3.11.0 forwards them
// (formattedMessage = the transport's printLogMessage output, no colour). A CC
// dump is rendered by formatLogPayload (core/src/log/formatPayload.ts) and every
// line after the first is indented 33 columns: 24 for the timestamp, 7 for the
// label, 2 for the direction (core/src/log/format.ts printLogMessage).
const C = '\n' + ' '.repeat(33);
const TS = '2026-10-14 05:00:00.123';
const REI = '0x5f3c9a1e0b7d24c68e1f03a9b2d47c5e';
const SEI = '0x9d2e4b7a1c3f5e8d0a6b2c4e7f1a3d5b';
const NONCE_IN = `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}│ RSSI: -72 dBm${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    SOS:              true${C}    MOS:              false${C}    receiver entropy: ${REI}`;
const NONCE_OUT = `${TS} DRIVER » [Node 012] [REQ] [SendDataBridge]                               [P: Immediate]${C}│ source node id:   1${C}│ transmit options: 0x25${C}│ callback id:      33${C}└─[Security2CCNonceReport]${C}    sequence number:  45${C}    SOS:              true${C}    MOS:              false${C}    receiver entropy: ${REI}`;
const SPAN_IN = `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}│ RSSI: -71 dBm${C}└─[Security2CCMessageEncapsulation]${C}  │ sequence number: 124${C}  │ security class:  S2_Authenticated${C}  ├─[SPAN]${C}  │   sender EI: ${SEI}${C}  └─[BinarySwitchCCReport]${C}      current value: true`;
// An S2 message carrying only extensions (Security2CC.ts:1648), so SPAN is the last child.
const SPAN_ONLY = `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}│ RSSI: -71 dBm${C}└─[Security2CCMessageEncapsulation]${C}  │ sequence number: 124${C}  │ security class:  S2_Authenticated${C}  └─[SPAN]${C}      sender EI: ${SEI}`;
const archived = (f: string) => redactLine(driverEventText({ formattedMessage: f })!);

test('verbose S2: a Nonce Report\'s receiver entropy and a SPAN extension\'s sender EI are kept — both go over the air in clear', () => {
  for (const f of [NONCE_IN, NONCE_OUT, SPAN_IN, SPAN_ONLY]) {
    const t = driverEventText({ formattedMessage: f })!;
    assert.equal(redactLine(t), t, `nothing in this entry is a secret:\n${f}`);
  }
  assert.ok(archived(NONCE_IN).endsWith(`receiver entropy: ${REI}`));
  assert.ok(archived(SPAN_IN).includes(`sender EI: ${SEI}\n`));
});

test('every other 32-hex value is still redacted: the MPAN state, a key, a public label out of its place or shape', () => {
  const K = '0x00112233445566778899aabbccddeeff';
  const cases: [string, string][] = [
    // NODE_ENV=development prints these as hex (Security2/Extension.ts MPANExtension, Security2CC.ts MessageEncapsulation).
    ['MPAN state', `${TS} DRIVER » [Node 012] [REQ] [SendDataBridge]${C}└─[Security2CCMessageEncapsulation]${C}  │ sequence number: 124${C}  ├─[MPAN]${C}  │   group ID:   3${C}  │   MPAN state: ${K}${C}  └─[BinarySwitchCCSet]${C}      target value: true`],
    ['key', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCMessageEncapsulation]${C}  │ sequence number: 9${C}  │ key:             ${K}${C}  └─[BinarySwitchCCReport]${C}      current value: true`],
    ['sender EI under another tag', `${TS} DRIVER » [Node 012] [REQ] [SendDataBridge]${C}└─[Security2CCMessageEncapsulation]${C}  ├─[MPAN]${C}  │   sender EI: ${K}${C}  └─[BinarySwitchCCSet]${C}      target value: true`],
    ['receiver entropy outside a Nonce Report', `${TS} DRIVER » [Node 012] [REQ] [SendDataBridge]${C}└─[Security2CCNonceGet]${C}    sequence number:  5${C}    receiver entropy: ${K}`],
    ['receiver entropy that is not the last line', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    receiver entropy: ${K}${C}    plaintext:        0x6303`],
    ['sender EI followed by more than a tree line', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCMessageEncapsulation]${C}  ├─[SPAN]${C}  │   sender EI: ${K}${C}  │   payload: 0x01`],
    ['upper-case hex (buffer2hex writes lower case)', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    receiver entropy: ${K.toUpperCase().replace('0X', '0x')}`],
    ['no 0x prefix', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    receiver entropy: ${K.slice(2)}`],
    ['another line of a Nonce Report block', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    MOS:              ${K}${C}    receiver entropy: ${REI}`],
    ['receiver entropy under a later tag', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}  └─[BinarySwitchCCReport]${C}    receiver entropy: ${K}`],
    ['a value a wrap has split', `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCNonceReport]${C}    sequence number:  123${C}    receiver entropy: ${K.slice(0, 18)}${C}    ${K.slice(18)}`],
  ];
  for (const [what, f] of cases) {
    const out = archived(f);
    assert.match(out, /\(redacted key\)/, `${what}: ${out}`);
    assert.doesNotMatch(out, /8899aabb|8899AABB/, `${what}: no part of the value survives`);
  }
});

const SERIAL_SHORT = `${TS} SERIAL » 0x0108001303012501257f                                              (10 bytes)`;
// 54 bytes: the formatter puts 65 hex digits and the length on the first line, the rest below.
const SERIAL_LONG = `${TS} SERIAL « 0x012a00a800010c1c9f037b00ababababababababababababababababababababa (54 bytes)${C}babababababababababababababababababababc5b5`;
// A non-secure User Code Report from a lock: the code (ASCII "1234") is plaintext in the frame.
const SERIAL_USER_CODE = `${TS} SERIAL « 0x011100a800010c08630301013132333400c4                              (18 bytes)`;
const serialEv = (formattedMessage: string, direction = 'inbound') => ({ source: 'driver', event: 'logging', label: 'SERIAL', level: 'debug', context: { source: 'serial', direction }, formattedMessage });

test('SERIAL (debug): a frame keeps its direction, length and header — the payload never reaches the archive', async () => {
  assert.equal(driverEventText(serialEv(SERIAL_SHORT, 'outbound')), `${TS} SERIAL » 0x01080013…                                              (10 bytes)`);
  assert.equal(driverEventText(serialEv(SERIAL_LONG)), `${TS} SERIAL « 0x012a00a8… (54 bytes)`, 'the wrapped tail is payload');
  assert.doesNotMatch(driverEventText(serialEv(SERIAL_USER_CODE))!, /31323334/, 'a plaintext user code');
  // ACK / NAK / CAN carry no payload and are kept as they are; a discarded run keeps its first bytes.
  for (const l of [`${TS} SERIAL « [ACK]                                                                   (0x06)`, `${TS} SERIAL » [NAK]                                                                   (0x15)`, `${TS} SERIAL « [CAN]                                                                   (0x18)`]) {
    assert.equal(driverEventText(serialEv(l)), l);
  }
  assert.equal(driverEventText(serialEv(`${TS} SERIAL « [DISCARDED] invalid data 0x0a0b0c0d0e0f101112131415                 (12 bytes)`)),
    `${TS} SERIAL « [DISCARDED] invalid data 0x0a0b0c0d…                 (12 bytes)`);
  // Any one of the three marks is enough (a forwarder that drops the others).
  assert.equal(driverEventText({ label: 'SERIAL', level: 'debug', message: '0x0108001303012501257f' }), 'DEBUG 0x01080013…', 'the label alone');
  assert.equal(driverEventText({ context: { source: 'serial' }, level: 'debug', message: '0x0108001303012501257f' }), 'DEBUG 0x01080013…', 'the context alone');
  assert.equal(driverEventText({ formattedMessage: SERIAL_LONG }), `${TS} SERIAL « 0x012a00a8… (54 bytes)`, 'the text alone');
  // The text mark is the forwarder's exact shape: "SERIAL" further along a line is not one.
  const notSerial = `${TS} CNTRLR   [Node 005] name: x SERIAL « 0x0102030405060708090a`;
  assert.equal(driverEventText({ formattedMessage: notSerial }), notSerial);
  // Only SERIAL entries: a multi-line DRIVER dump is kept whole.
  assert.equal(driverEventText({ label: 'DRIVER', context: { source: 'driver' }, formattedMessage: SPAN_IN }), SPAN_IN.replace(/\n/g, '\n    '));
  // And that is what reaches the file.
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-archive-'));
  try {
    const a = createLogArchive({ dir, days: 14, maxBytes: 1 << 30, driver: true, now: () => Date.UTC(2026, 9, 14, 12), timers: false });
    a.driver(serialEv(SERIAL_LONG));
    a.driver(serialEv(SERIAL_USER_CODE));
    await a.flush();
    const text = readFileSync(join(dir, 'zwave-js-2026-10-14.log'), 'utf8');
    assert.match(text, /SERIAL « 0x012a00a8… \(54 bytes\)\n/);
    assert.doesNotMatch(text, /abab|31323334/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a frame the driver could not parse keeps its reason, header and length — logged at warn, so at the default info level too', () => {
  const dump = `${TS} DRIVER   Dropping message with invalid payload (Reason: x):${C}0x012a00a800010c1c9f037b00abababababababababababababababababababababababababab${C}ababababababababababababababc5b5`;
  assert.equal(driverEventText({ formattedMessage: dump }), `${TS} DRIVER   Dropping message with invalid payload (Reason: x):\n    ${' '.repeat(33)}0x012a00a8… (54 bytes)`);
  // A hex value at the end of a CC dump is a field, not a dump: kept (SecurityCC.ts S0 Nonce Report).
  const s0 = `${TS} DRIVER « [Node 007] [REQ] [BridgeApplicationCommand]${C}│ RSSI: -65 dBm${C}└─[SecurityCCNonceReport]${C}    nonce: 0x1122334455667788`;
  assert.equal(driverEventText({ formattedMessage: s0 }), s0.replace(/\n/g, '\n    '));
});

test('a raw payload or event-parameters value in a CC dump keeps its first four bytes and its length (v0.76.0)', () => {
  const notif = `${TS} DRIVER « [Node 044] [REQ] [BridgeApplicationCommand]${C}└─[NotificationCCReport]${C}    notification type: Access Control${C}    event parameters:  0x630301013132333400`;
  assert.equal(driverEventText({ formattedMessage: notif }), notif.replace(/\n/g, '\n    ').replace('0x630301013132333400', '0x63030101… (9 bytes)'));
  const unknown = `${TS} DRIVER « [Node 044] [REQ] [BridgeApplicationCommand]${C}└─[CommandClass]${C}    payload: 0x${'31'.repeat(28)}${C}    ${'32'.repeat(10)}`;
  assert.equal(driverEventText({ formattedMessage: unknown }), `${TS} DRIVER « [Node 044] [REQ] [BridgeApplicationCommand]\n    ${' '.repeat(33)}└─[CommandClass]\n    ${' '.repeat(33)}    payload: 0x31313131… (38 bytes)`, 'a wrapped value is one value');
  const short = `${TS} DRIVER « [Node 044] [REQ] [BridgeApplicationCommand]${C}└─[CommandClass]${C}    payload: 0x0102`;
  assert.equal(driverEventText({ formattedMessage: short }), short.replace(/\n/g, '\n    '), 'four bytes or fewer stay');
});

test('an S2 public key is replaced — it carries the DSK — wrapped or not (v0.76.0)', () => {
  const PK = 'a1'.repeat(16) + 'b2'.repeat(16);
  const one = `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCPublicKeyReport]${C}    is including node: false${C}    public key: 0x${PK}`;
  const wrapped = `${TS} DRIVER « [Node 012] [REQ] [BridgeApplicationCommand]${C}└─[Security2CCPublicKeyReport]${C}    is including node: false${C}    public key: 0x${PK.slice(0, 30)}${C}${PK.slice(30)}`;
  for (const f of [one, wrapped]) {
    const out = archived(f);
    assert.match(out, /\(redacted public key\)/);
    assert.doesNotMatch(out, /a1a1|b2b2/);
  }
});


// ── v0.76.0: the backup hold ──
/** A hold file outside the archive folder, with its mtime `ago` ms before T. */
const holdAt = (ago: number) => {
  const d = mkdtempSync(join(tmpdir(), 'zwtui-hold-'));
  const p = join(d, 'zwave-tui-backup.hold');
  writeFileSync(p, '');
  utimesSync(p, (T - ago) / 1000, (T - ago) / 1000);
  return { p, done: () => rmSync(d, { recursive: true, force: true }) };
};
/** A scripted hold reader: the queued states first, then `rest`. */
const scripted = (first: BackupHold['state'][]) => {
  const s = { queue: [...first], rest: 'fresh' as BackupHold['state'], calls: 0 };
  return { s, readHold: async (): Promise<BackupHold> => { s.calls++; return { state: s.queue.length ? s.queue.shift()! : s.rest, mtimeMs: T - 1000 }; } };
};
const sizes = (dir: string) => readdirSync(dir).sort().map((n) => `${n}:${statSync(join(dir, n)).size}`);

test('a backup hold: a fresh hold stops housekeeping before it starts — nothing compressed, deleted or capped, not even a temp file (v0.76.0)', async () => {
  const hold = holdAt(5_000);
  const h = mk({ days: 3, holdPath: hold.p });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-13.log'), 'day13\n');
    writeFileSync(join(h.dir, 'zwave-js-2026-10-10.log.gz'), 'old');
    const before = sizes(h.dir);
    await h.a.housekeep();
    assert.deepEqual(sizes(h.dir), before);
    assert.equal(h.noted.length, 1);
    assert.match(h.noted[0], /a backup is running \(hold set 5 s ago\)/);
    assert.deepEqual(h.warned, []);
  } finally { h.done(); hold.done(); }
});

test('a backup that starts during a pass: the compression is not committed, the pass ends there, and the next pass finishes each day exactly once (v0.76.0)', async () => {
  const r = scripted(['none', 'fresh']);
  const h = mk({ days: 3, readHold: r.readHold });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-13.log'), 'day13\n');
    writeFileSync(join(h.dir, 'zwave-tui-2026-10-12.log'), 'day12\n');
    writeFileSync(join(h.dir, 'zwave-js-2026-10-10.log.gz'), 'old');
    await h.a.housekeep();
    const names = readdirSync(h.dir);
    assert.equal(names.filter((n) => n.endsWith('.gz.tmp')).length, 1, 'one compression started, none committed, and the pass stopped there');
    for (const n of ['zwave-js-2026-10-13.log', 'zwave-tui-2026-10-12.log', 'zwave-js-2026-10-10.log.gz']) assert.ok(names.includes(n), `${n} untouched`);
    assert.equal(h.noted.length, 1, 'one note for the held pass');
    r.s.rest = 'none';
    await h.a.housekeep();
    assert.deepEqual(readdirSync(h.dir).sort(), ['zwave-js-2026-10-13.log.gz', 'zwave-tui-2026-10-12.log.gz']);
    assert.equal(gunzipSync(readFileSync(join(h.dir, 'zwave-js-2026-10-13.log.gz'))).toString(), 'day13\n', 'each day, once');
    assert.equal(gunzipSync(readFileSync(join(h.dir, 'zwave-tui-2026-10-12.log.gz'))).toString(), 'day12\n');
    assert.deepEqual(h.warned, []);
  } finally { h.done(); }
});

test('a backup that starts before retention: an old day is not deleted (v0.76.0)', async () => {
  const r = scripted(['none']);
  const h = mk({ days: 3, readHold: r.readHold });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-10.log.gz'), 'old');
    await h.a.housekeep();
    assert.ok(existsSync(join(h.dir, 'zwave-js-2026-10-10.log.gz')));
  } finally { h.done(); }
});

test('a temp file already gone when housekeeping clears it is not an error (v0.76.0)', async () => {
  let calls = 0;
  let dir = '';
  const h = mk({ readHold: async () => {
    calls++;
    // The second read is the temp-file guard: the file vanishes just before its unlink.
    if (calls === 2) rmSync(join(dir, 'zwave-js-2026-10-12.log.gz.tmp'), { force: true });
    return { state: 'none', mtimeMs: 0 };
  } });
  dir = h.dir;
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-12.log.gz.tmp'), 'half');
    await h.a.housekeep();
    assert.ok(calls >= 2);
    assert.deepEqual(h.warned, [], 'ENOENT on a stale temp file is no failure');
  } finally { h.done(); }
});

test('a backup that starts before the size cap: the cap deletes nothing (v0.76.0)', async () => {
  const r = scripted(['none']);
  const h = mk({ days: 30, maxBytes: 2500, readHold: r.readHold });
  try {
    for (const d of ['2026-10-11', '2026-10-12', '2026-10-13']) writeFileSync(join(h.dir, `zwave-js-${d}.log.gz`), 'x'.repeat(1000));
    await h.a.housekeep();
    assert.equal(readdirSync(h.dir).length, 3);
  } finally { h.done(); }
});

test('a crashed compression\'s temp file is cleared only when no backup holds the folder (v0.76.0)', async () => {
  const r = scripted(['none']);
  const h = mk({ readHold: r.readHold });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-12.log.gz.tmp'), 'half');
    await h.a.housekeep();
    assert.ok(existsSync(join(h.dir, 'zwave-js-2026-10-12.log.gz.tmp')));
  } finally { h.done(); }
});

test('readBackupHold: absent, fresh, and stale 60 min away in either direction (v0.76.0)', async () => {
  assert.equal(ARCHIVE_HOLD_MAX_MS, 3_600_000);
  const d = mkdtempSync(join(tmpdir(), 'zwtui-hold-'));
  try {
    const p = join(d, 'hold');
    assert.equal((await readBackupHold(null, T)).state, 'none');
    assert.equal((await readBackupHold(p, T)).state, 'none', 'no file');
    writeFileSync(p, '');
    const at = async (mt: number) => { utimesSync(p, mt / 1000, mt / 1000); return (await readBackupHold(p, T)).state; };
    assert.equal(await at(T), 'fresh');
    assert.equal(await at(T - 3_599_000), 'fresh');
    assert.equal(await at(T - 3_600_000), 'stale', 'the edge is stale');
    assert.equal(await at(T - 3_601_000), 'stale');
    assert.equal(await at(T + 1_000), 'fresh');
    assert.equal(await at(T + 3_601_000), 'stale', 'a clock stepped back cannot stretch a hold');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a stale hold is ignored and reported once — backup_post never ran (v0.76.0)', async () => {
  const hold = holdAt(2 * 3_600_000);
  const h = mk({ holdPath: hold.p });
  try {
    writeFileSync(join(h.dir, 'zwave-js-2026-10-13.log'), 'day13\n');
    await h.a.housekeep();
    await h.a.housekeep();
    assert.ok(existsSync(join(h.dir, 'zwave-js-2026-10-13.log.gz')), 'housekeeping went on');
    assert.equal(h.warned.length, 1);
    assert.match(h.warned[0], /ignoring a backup hold dated 120 min ago \(the limit is 60 min; backup_post never ran, or the clock moved\)/);
  } finally { h.done(); hold.done(); }
});

test('appends to today\'s file go on while a backup holds the folder (v0.76.0)', async () => {
  const hold = holdAt(0);
  const h = mk({ holdPath: hold.p });
  try {
    h.a.tui('[zwave-tui] during a backup');
    await h.a.flush();
    assert.match(read(h.dir, 'zwave-tui-2026-10-14.log'), /during a backup/);
  } finally { h.done(); hold.done(); }
});

test('a note is an [archive] line in its stream\'s file, in order with the lines around it; the driver stream\'s notes follow log_archive_driver (v0.76.0)', async () => {
  const h = mk();
  try {
    h.a.driver({ formattedMessage: 'before' });
    h.a.note('zwave-js', 'driver log stream paused by the storm guard');
    h.a.driver({ formattedMessage: 'after' });
    h.a.note('zwave-tui', 'tui note');
    await h.a.flush();
    assert.equal(read(h.dir, 'zwave-js-2026-10-14.log'),
      '2026-10-14T12:00:00.000Z before\n2026-10-14T12:00:00.000Z [archive] driver log stream paused by the storm guard\n2026-10-14T12:00:00.000Z after\n');
    assert.match(read(h.dir, 'zwave-tui-2026-10-14.log'), /\[archive\] tui note\n$/);
  } finally { h.done(); }
  const off = mk({ driver: false });
  try {
    off.a.note('zwave-js', 'x');
    await off.a.flush();
    assert.deepEqual(readdirSync(off.dir), [], 'no driver file when the driver stream is off');
  } finally { off.done(); }
});

test('driverEventText: no text, no entry', () => {
  assert.equal(driverEventText({}), null);
  assert.equal(driverEventText({ formattedMessage: '   ' }), null);
  assert.equal(driverEventText({ formattedMessage: [1, 2] }), null);
});

test('intEnv: an integer option clamped to its schema range; junk is the default, never NaN', () => {
  assert.equal(intEnv('14', 0, 0, 60), 14);
  assert.equal(intEnv('99', 0, 0, 60), 60);
  assert.equal(intEnv('-3', 0, 0, 60), 0);
  assert.equal(intEnv('7.6', 0, 0, 60), 8);
  assert.equal(intEnv('abc', 5, 0, 60), 5);
  assert.equal(intEnv('', 5, 0, 60), 5);
  assert.equal(intEnv(undefined, 5, 0, 60), 5);
});
