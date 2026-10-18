/**
 * The SSH TUI transport (v0.77.0): logins with the login gate's users, password
 * only; refusal while the gate is off; the per-peer backoff; one terminal per
 * connection, no exec; the host key generated once and kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { startSshServer, loadOrCreateHostKey, hostKeyFingerprint, parseInput } from '../src/telnet/server';
import { createAuthPolicy, hashPassword } from '../src/auth/loginPolicy';
import { mkNode, mockData } from './_logHelpers';

const KEY = ssh2.utils.generateKeyPairSync('ed25519').private;
const USER = { username: 'operator', password: hashPassword('right-horse') };
const policy = (o: Partial<Parameters<typeof createAuthPolicy>[0]> = {}) =>
  createAuthPolicy({ enabled: true, requireOnIngress: false, users: [USER], maxAttempts: 2, idleLockMin: 0, ...o });
let nextPort = 25300 + Math.floor(Math.random() * 300);

function serve(auth: ReturnType<typeof createAuthPolicy>, lines: string[] = []) {
  const port = nextPort++;
  const log = Object.assign((m: string) => { lines.push(m); }, { warn: (m: string) => { lines.push(`WARN ${m}`); } });
  const srv = startSshServer({ data: mockData({ nodes: [mkNode()] }), host: '127.0.0.1', port, log: log as never, hostKey: KEY, signalDisplay: 'margin', auth });
  return { port, srv, lines };
}

/** Log in; resolve with what happened (no throw). */
function login(port: number, password: string, opts: { shell?: boolean; exec?: string; cols?: number } = {}): Promise<{ ok: boolean; err?: string; out: string; execOk?: boolean; resizeOut?: string }> {
  return new Promise((done) => {
    const c = new ssh2.Client();
    let out = '';
    let over = false;
    const fin = (r: { ok: boolean; err?: string; execOk?: boolean; resizeOut?: string }) => { if (over) return; over = true; c.end(); done({ out, ...r }); };
    c.on('error', (e) => fin({ ok: false, err: e.message }));
    c.on('ready', () => {
      if (opts.exec) {
        c.exec(opts.exec, (e) => fin({ ok: true, execOk: !e }));
        return;
      }
      if (!opts.shell) { fin({ ok: true }); return; }
      c.shell({ cols: opts.cols ?? 100, rows: 30, term: 'xterm-256color' }, (e, stream) => {
        if (e) { fin({ ok: true, err: e.message }); return; }
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        setTimeout(() => {
          const before = out.length;
          stream.setWindow(40, 140, 0, 0);
          setTimeout(() => fin({ ok: true, resizeOut: out.slice(before) }), 600);
        }, 600);
      });
    });
    c.connect({ host: '127.0.0.1', port, username: 'operator', password, readyTimeout: 4000, tryKeyboard: false });
    setTimeout(() => fin({ ok: false, err: 'timeout' }), 6000);
  });
}

test('a login-gate user logs in over SSH with a password and gets the TUI; a window change redraws (v0.77.0)', async () => {
  const { port, srv, lines } = serve(policy());
  try {
    const r = await login(port, 'right-horse', { shell: true });
    assert.equal(r.ok, true, r.err);
    assert.match(r.out, /\x1b\[\?1049h/, 'the alternate screen opens');
    assert.match(r.out, /ZWAVE/, 'and a TUI frame is drawn');
    // A frame is rows joined by CRLF; the widest row follows the terminal's width.
    const widest = (t: string) => Math.max(0, ...t.split(/\r\n|\x1b\[H/).map((row) => [...row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length));
    assert.ok(widest(r.out.slice(0, r.out.length - (r.resizeOut ?? '').length)) <= 100, 'drawn at the 100 columns the pty asked for');
    assert.ok(widest(r.resizeOut ?? '') > 100, `a window change to 140 columns redraws wider: ${widest(r.resizeOut ?? '')}`);
    assert.ok(lines.some((l) => /^ssh: login from 127\.0\.0\.1/.test(l)), lines.join(' | '));
    assert.ok(!lines.some((l) => /operator|right-horse/.test(l)), 'never the username or password in the log');
  } finally { srv.stop(); }
});

test('a wrong password is refused, and past auth_max_attempts the peer backs off — even with the right one (v0.77.0)', async () => {
  const { port, srv, lines } = serve(policy({ maxAttempts: 2 }));
  try {
    assert.equal((await login(port, 'wrong-1')).ok, false);
    assert.equal((await login(port, 'wrong-2')).ok, false);
    const r = await login(port, 'right-horse');
    assert.equal(r.ok, false, 'blocked while backing off');
    assert.ok(lines.some((l) => /failed login from 127\.0\.0\.1$/.test(l)), 'a known user is not named');
    assert.ok(lines.some((l) => /backing off \d+ s after failed attempts/.test(l)), lines.join(' | '));
  } finally { srv.stop(); }
});

test('with the login gate off, or no user, every SSH login is refused and the log says why once per connection (v0.77.0)', async () => {
  for (const p of [policy({ enabled: false }), policy({ users: [] })]) {
    const { port, srv, lines } = serve(p);
    try {
      const r = await login(port, 'right-horse');
      assert.equal(r.ok, false);
      const warns = lines.filter((l) => /^WARN ssh: login from 127\.0\.0\.1 refused — the login gate is off or has no users/.test(l));
      assert.equal(warns.length, 1, lines.join(' | '));
    } finally { srv.stop(); }
  }
});

test('exec is refused: the port serves the TUI and nothing else (v0.77.0)', async () => {
  const { port, srv } = serve(policy());
  try {
    const r = await login(port, 'right-horse', { exec: 'cat /data/options.json' });
    assert.equal(r.ok, true);
    assert.equal(r.execOk, false);
  } finally { srv.stop(); }
});

test('the host key is generated once, kept 0600, reused, and a broken one is replaced with a warning (v0.77.0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwtui-hostkey-'));
  const path = join(dir, 'ssh_host_ed25519_key');
  const lines: string[] = [];
  const log = Object.assign((m: string) => { lines.push(m); }, { warn: (m: string) => { lines.push(`WARN ${m}`); } });
  try {
    const a = loadOrCreateHostKey(path, log as never);
    assert.match(a.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(lines.some((l) => l === `ssh: generated a new host key (${a.fingerprint})`));
    const b = loadOrCreateHostKey(path, log as never);
    assert.equal(b.fingerprint, a.fingerprint, 'kept across restarts');
    assert.equal(hostKeyFingerprint(b.key), a.fingerprint);
    writeFileSync(path, 'not a key');
    const c = loadOrCreateHostKey(path, log as never);
    assert.notEqual(c.fingerprint, a.fingerprint);
    assert.ok(lines.some((l) => /^WARN ssh: the host key at .* could not be read/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseInput decodes keys and passes 0xFF as nothing — no telnet IAC handling (v0.77.0)', () => {
  const { events, rest } = parseInput(Buffer.from([0x71, 0x1b, 0x5b, 0x41, 0x0d, 0xff, 0x09]));
  assert.deepEqual(events, [{ type: 'char', ch: 'q' }, { type: 'arrow', dir: 'up' }, { type: 'enter' }, { type: 'tab' }]);
  assert.equal(rest.length, 0);
});
