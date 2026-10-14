/**
 * The Supervisor's backup hooks (v0.76.0): rootfs/usr/bin/zwave-tui-backup-hook.
 *
 * backup_pre sets a hold file in /tmp and backup_post clears it; while the hold
 * is fresh the log archive renames and deletes nothing, so the Supervisor's copy
 * of the folder cannot fail. Any non-zero exit drops the WHOLE add-on from the
 * backup, so every path must exit 0. Each phase is recorded in the day's archive
 * file while the archive is on, because the Supervisor logs a hook's output only
 * on a failure. These run the shipped script itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync, utimesSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDON = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = resolve(ADDON, 'rootfs/usr/bin/zwave-tui-backup-hook');

const sandbox = (archiveDays: number | null = 14) => {
  const d = mkdtempSync(join(tmpdir(), 'zwtui-hook-'));
  mkdirSync(join(d, 'logs'));
  const opts = join(d, 'options.json');
  if (archiveDays != null) writeFileSync(opts, JSON.stringify({ log_archive_days: archiveDays, log_archive_max_mb: 200 }));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LOG_ARCHIVE_HOLD: join(d, 'hold'), LOG_ARCHIVE_DIR: join(d, 'logs'), LOG_ARCHIVE_OPTIONS: opts };
  return {
    d, env,
    hook: (arg?: string, over: Record<string, string> = {}) => spawnSync('sh', arg == null ? [HOOK] : [HOOK, arg], { env: { ...env, ...over }, encoding: 'utf8' }),
    dayFiles: () => readdirSync(join(d, 'logs')).filter((n) => /^zwave-tui-\d{4}-\d{2}-\d{2}\.log$/.test(n)),
    lines: () => readdirSync(join(d, 'logs')).flatMap((n) => readFileSync(join(d, 'logs', n), 'utf8').trim().split('\n')).filter(Boolean),
    done: () => rmSync(d, { recursive: true, force: true }),
  };
};

test('backup_pre sets the hold and backup_post clears it; each records its phase in the day\'s archive file, under a name housekeeping keeps (v0.76.0)', () => {
  assert.ok(readFileSync(HOOK, 'utf8').startsWith('#!/bin/sh\n'));
  const s = sandbox();
  try {
    const pre = s.hook('pre');
    assert.equal(pre.status, 0);
    assert.ok(existsSync(s.env.LOG_ARCHIVE_HOLD));
    const files = s.dayFiles();
    assert.equal(files.length, 1);
    const day = /^zwave-tui-(\d{4}-\d{2}-\d{2})\.log$/.exec(files[0])![1];
    assert.match(s.lines()[0], new RegExp(`^${day}T\\d{2}:\\d{2}:\\d{2}Z \\[backup\\] backup started: archive housekeeping paused$`));
    const post = s.hook('post');
    assert.equal(post.status, 0);
    assert.ok(!existsSync(s.env.LOG_ARCHIVE_HOLD));
    assert.match(s.lines().at(-1)!, /\[backup\] backup finished: archive housekeeping resumed$/);
  } finally { s.done(); }
});

test('every path exits 0 — a non-zero exit would drop the whole add-on from the backup (v0.76.0)', () => {
  const s = sandbox();
  try {
    const noFolder = s.hook('pre', { LOG_ARCHIVE_HOLD: join(s.d, 'missing', 'hold') });
    assert.equal(noFolder.status, 0, 'a hold that cannot be set');
    assert.match(s.lines().at(-1)!, /the hold could not be set/);
    for (const arg of ['pre', 'post']) {
      assert.equal(s.hook(arg, { LOG_ARCHIVE_DIR: join(s.d, 'gone') }).status, 0, `${arg} with no archive folder`);
    }
    assert.ok(!existsSync(join(s.d, 'gone')), 'and the folder is not created');
    rmSync(join(s.d, 'logs'), { recursive: true }); mkdirSync(join(s.d, 'logs'));
    for (const arg of [undefined, 'bogus']) {
      assert.equal(s.hook(arg).status, 0, `argument ${arg ?? '(none)'}`);
      assert.ok(!existsSync(s.env.LOG_ARCHIVE_HOLD));
    }
    assert.deepEqual(s.lines(), [], 'an unknown phase writes nothing');
    assert.equal(s.hook('post').status, 0, 'post with no hold');
  } finally { s.done(); }
});

test('with the archive off, the hooks still hold housekeeping but write nothing into its folder (v0.76.0)', () => {
  for (const days of [0, null]) {
    const s = sandbox(days);
    try {
      assert.equal(s.hook('pre').status, 0);
      assert.ok(existsSync(s.env.LOG_ARCHIVE_HOLD));
      assert.equal(s.hook('post').status, 0);
      assert.deepEqual(s.dayFiles(), [], `log_archive_days ${days ?? '(no options file)'}: no file`);
    } finally { s.done(); }
  }
});

test('an evidence line that cannot be written still exits 0 (v0.76.0)', (tc) => {
  if (process.getuid?.() === 0) { tc.skip('root ignores directory permissions'); return; }
  const s = sandbox();
  try {
    chmodSync(join(s.d, 'logs'), 0o555);
    try {
      assert.equal(s.hook('pre').status, 0, 'a read-only archive folder');
      assert.ok(existsSync(s.env.LOG_ARCHIVE_HOLD), 'and the hold is still set');
      assert.equal(s.hook('post').status, 0);
    } finally { chmodSync(join(s.d, 'logs'), 0o755); }
  } finally { s.done(); }
});

test('a hold left by an earlier backup is refreshed, not kept stale (v0.76.0)', () => {
  const s = sandbox();
  try {
    writeFileSync(s.env.LOG_ARCHIVE_HOLD, '');
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(s.env.LOG_ARCHIVE_HOLD, old, old);
    assert.equal(s.hook('pre').status, 0);
    assert.ok(Math.abs(statSync(s.env.LOG_ARCHIVE_HOLD).mtimeMs - Date.now()) < 60_000);
  } finally { s.done(); }
});
