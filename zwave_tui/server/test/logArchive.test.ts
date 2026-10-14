/**
 * The durable log archive (v0.75.4): the add-on's log and the driver's log
 * stream in daily files, redacted, compressed when finished, pruned by age and
 * by size, and never lost to a failed write without saying so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync, existsSync, statSync, promises as fsp } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogArchive, redactLine, driverEventText, dayOf, ARCHIVE_BUFFER_MAX } from '../src/logArchive';
import { intEnv } from '../src/config';

const T = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400_000;
const mk = (over: Partial<Parameters<typeof createLogArchive>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-archive-'));
  const clock = { now: T };
  const warned: string[] = [];
  const a = createLogArchive({ dir, days: 14, maxBytes: 200 * 1024 * 1024, driver: true, now: () => clock.now, warn: (m) => warned.push(m), timers: false, ...over });
  return { a, dir, clock, warned, done: () => rmSync(dir, { recursive: true, force: true }) };
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
