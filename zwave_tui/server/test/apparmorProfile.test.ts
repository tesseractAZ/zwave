/**
 * Invariants of zwave_tui/apparmor.txt (v0.74.4). A compile (CI job
 * "apparmor") proves only that the parser accepts the file; these pin what the
 * profile must keep doing, so an edit cannot quietly re-break what a sibling
 * add-on learned the hard way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raw = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../apparmor.txt'), 'utf8');
/** Rule lines only: comments and blank lines removed, indentation trimmed. */
const rules = raw.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '');

test('exactly one column-0 profile, named zwave_tui, with the Supervisor flags (v0.74.4)', () => {
  const col0 = raw.split('\n').filter((l) => /^profile\s/.test(l));
  assert.deepEqual(col0, ['profile zwave_tui flags=(attach_disconnected,mediate_deleted) {'], 'the Supervisor refuses more than one column-0 profile line');
  assert.ok(raw.startsWith('#include <tunables/global>'));
  assert.ok(rules.includes('#include <abstractions/base>') || raw.includes('#include <abstractions/base>'));
});

test('the three blanket grants stay: s6 re-reads /init on stop (v0.74.4)', () => {
  for (const g of ['file,', 'signal,', 'network,']) assert.ok(rules.includes(g), `missing ${g}`);
});

test('capabilities are an exact allow list; the dangerous ones are audit-denied (v0.74.4)', () => {
  const allowed = rules.filter((r) => /^capability\s/.test(r)).map((r) => r.replace(/^capability\s+|,$/g, '')).sort();
  assert.deepEqual(allowed, ['chown', 'dac_override', 'fowner', 'fsetid', 'kill', 'setgid', 'setuid']);
  assert.ok(!rules.includes('capability,'), 'no blanket capability grant');
  for (const c of ['net_raw', 'setfcap', 'sys_admin', 'sys_module', 'sys_rawio', 'sys_ptrace', 'net_admin', 'dac_read_search', 'bpf']) {
    assert.ok(rules.includes(`audit deny capability ${c},`), `missing audit deny ${c}`);
  }
});

test('write-locks use "wl" on the shipped trees, never "wal" (v0.74.4)', () => {
  for (const t of ['/init wl,', '/bin/{,**} wl,', '/sbin/{,**} wl,', '/lib/{,**} wl,', '/usr/{,**} wl,', '/app/{,**} wl,']) {
    assert.ok(rules.includes(`audit deny ${t}`), `missing write-lock ${t}`);
  }
  assert.ok(!rules.some((r) => /\bdeny\b.*\s[rwlkmix]*a[rwlkmix]*w|\bdeny\b.*\s[rwlkmix]*w[rwlkmix]*a/.test(r.replace(/[{}*,/]/g, ' '))), 'a mask holding both a and w is rejected by the parser');
});

test('no deny touches the PID1 trees, /run, /tmp, /data or /config (v0.74.4; /config since v0.75.4, the log archive)', () => {
  const denies = rules.filter((r) => /\bdeny\b/.test(r));
  for (const tree of ['/command', '/package', '/etc/s6-overlay', '/run', '/tmp', '/data', '/config']) {
    assert.ok(!denies.some((r) => r.includes(` ${tree}`)), `a deny on ${tree} risks an invisible init crash-loop or breaks the stores`);
  }
});

test('ptrace: only trace is denied, never a bare deny (v0.74.4)', () => {
  assert.ok(rules.includes('audit deny ptrace (trace),'));
  assert.ok(!rules.some((r) => /deny ptrace,$/.test(r)), 'a bare deny ptrace also removes the base read, silently');
});
