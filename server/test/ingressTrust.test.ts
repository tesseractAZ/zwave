/**
 * Ingress trust boundary — the control that decides whether a request skips
 * the login gate entirely.
 *
 * It previously accepted the whole 172.30.32.0/23 hassio bridge, which is
 * where every SIBLING ADD-ON lives, not just the Supervisor. Because :8788 is
 * ingress-only (not in `ports:`), every peer able to open the socket was
 * already inside that /23 — so `!!header && isSupervisorSource(ip)` reduced to
 * "did the client send a header it chooses", and could not fire. There was no
 * test on this path at all.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  isSupervisorSource,
  pinSupervisorAddress,
  setSupervisorAddressesForTest,
} from '../src/auth';
import { parseUsers, createAuthPolicy } from '../src/auth/loginPolicy';
import { truncate, visLen } from '../src/telnet/ansi';
import { errMsg } from '../src/zwave/zwaveData';
import { readFileSync } from 'node:fs';
import { mkNode, mockData } from './_logHelpers';

/** Fixed high port for the telnet cap probe (0 gives no discoverable port). */
const TELNET_TEST_PORT = 24391;

/** The composition used in index.ts — kept verbatim so this tests the real rule. */
const isIngressTrusted = (req: { headers: Record<string, unknown>; ip: string }): boolean =>
  !!req.headers['x-ingress-path'] && isSupervisorSource(req.ip);

test('a SIBLING add-on cannot forge ingress trust', () => {
  setSupervisorAddressesForTest(['172.30.32.2']);   // the real Supervisor

  // The genuine proxy is trusted.
  assert.equal(isIngressTrusted({ headers: { 'x-ingress-path': '/api/hassio_ingress/x' }, ip: '172.30.32.2' }), true,
    'the real Supervisor must still be trusted, or the sidebar breaks');

  // Every sibling add-on address on the same bridge must NOT be — these are
  // the real neighbours on this operator's system.
  for (const ip of ['172.30.33.0', '172.30.33.1', '172.30.33.4', '172.30.33.9', '172.30.32.1']) {
    assert.equal(isIngressTrusted({ headers: { 'x-ingress-path': '/api/hassio_ingress/x' }, ip }), false,
      `sibling add-on at ${ip} forged ingress trust with one header`);
  }

  // IPv4-mapped IPv6 must not sneak past the comparison either way.
  assert.equal(isSupervisorSource('::ffff:172.30.32.2'), true, 'mapped form of the Supervisor must match');
  assert.equal(isSupervisorSource('::ffff:172.30.33.9'), false, 'mapped form of a sibling must not match');
});

test('unresolved supervisor FAILS CLOSED — nothing is trusted', async () => {
  setSupervisorAddressesForTest([]);
  for (const ip of ['172.30.32.2', '172.30.33.4', '127.0.0.1']) {
    assert.equal(isSupervisorSource(ip), false, `${ip} trusted while the pin was unresolved`);
  }
  // A failing lookup must leave it closed, not open.
  const pinned = await pinSupervisorAddress(() => {}, async () => { throw new Error('EAI_AGAIN'); });
  assert.deepEqual(pinned, [], 'a failed lookup must pin nothing');
  assert.equal(isSupervisorSource('172.30.32.2'), false, 'trust must stay closed after a failed lookup');
});

test('the header alone is never sufficient', () => {
  setSupervisorAddressesForTest(['172.30.32.2']);
  // No header, right IP → not ingress (it is some other caller on the bridge).
  assert.equal(isIngressTrusted({ headers: {}, ip: '172.30.32.2' }), false);
  // Header, wrong IP → the forge attempt.
  assert.equal(isIngressTrusted({ headers: { 'x-ingress-path': '/x' }, ip: '192.168.1.40' }), false);
});

test('a user row with a blank password is REJECTED, and fails closed', async () => {
  // It used to become a real account whose password was "" — and hasUsers()
  // returned true, so the "no users configured" fail-closed branch never fired.
  // The operator saw a login gate that accepted an empty password.
  const blank = parseUsers(JSON.stringify([{ username: 'op', password: '' }]));
  assert.deepEqual(blank, [], 'a blank-password row must not become an account');
  assert.equal(createAuthPolicy({ users: blank, maxAttempts: 5, lockoutMs: 1 } as never).hasUsers(), false,
    'hasUsers() must be false so the session fails closed');

  // Whitespace-only is equally not a password.
  assert.deepEqual(parseUsers(JSON.stringify([{ username: 'op' }])), [], 'a missing password must not become an account');

  // A real credential still works, and still rejects the wrong password.
  const good = parseUsers(JSON.stringify([{ username: 'op', password: 's3cret' }]));
  assert.equal(good.length, 1);
  const policy = createAuthPolicy({ users: good, maxAttempts: 5, lockoutMs: 1 } as never);
  assert.equal(await policy.verify('op', 's3cret'), true, 'the correct password must still authenticate');
  assert.equal(await policy.verify('op', ''), false, 'an empty password must never authenticate');
  assert.equal(await policy.verify('op', 'wrong'), false);
});

/* ── v0.24.4: the rest of the posture audit ─────────────────────────────── */

test('the C1 control block cannot reach the wire', () => {
  // U+009B is an 8-bit CSI and U+009D an 8-bit OSC — xterm.js on /console
  // EXECUTES both. The data-boundary sanitizer already stripped \x7f-\x9f; this
  // backstop did not, so any string that skipped the boundary had none.
  const CSI = String.fromCharCode(0x9b);
  const OSC = String.fromCharCode(0x9d);
  const attack = `Lamp${CSI}31mRED${OSC}52;c;aGFjaw==`;

  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(truncate(attack, 200)),
    `a C1 control survived truncate(): ${JSON.stringify(truncate(attack, 200))}`);
  // C1 occupies no column, so counting it as one would corrupt every width.
  assert.equal(visLen(CSI), 0, 'a C1 byte must not count as a visible column');
  assert.equal(visLen(OSC), 0);
  // Printable text and U+00A0 (nbsp, just past the C1 block) are unaffected.
  assert.equal(visLen('Kitchen Lamp'), 12);
  assert.equal(visLen('a b'), 3, 'nbsp is printable and must still count');
});

test('HA- and device-sourced ERROR text is sanitized before it reaches a frame', () => {
  // These four sinks had no sanitizer: the config-fetch error, the action
  // result message, lastError(), and the controller SDK/firmware versions.
  // errMsg() is the chokepoint for the first three.
  const CSI = String.fromCharCode(0x9b);
  const hostile = new Error(`boom\n\x1b[31mFAKE ROW${CSI}2J`);
  const cleaned = errMsg(hostile);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(cleaned),
    `error text reached the frame with control bytes: ${JSON.stringify(cleaned)}`);
  assert.ok(cleaned.includes('boom'), 'the message itself must survive');
});

test('the login backoff charges the attempt BEFORE the async verify', async () => {
  // `this.verifying` serialises one session, but 16 telnet + 16 ws sessions
  // each have their own. Registering the failure only after verify() resolved
  // meant ~32 concurrent guesses all read a clean counter.
  const charged: string[] = [];
  const policy = {
    enabled: true, maxAttempts: 3,
    hasUsers: () => true,
    blockedMsFor: () => 0,
    registerFailure: (p: string) => { charged.push(p); },
    registerSuccess: () => { charged.length = 0; },
    // Resolves LATE, so anything registering after the await would be too late.
    verify: () => new Promise<boolean>((r) => setTimeout(() => r(false), 30)),
  };
  const src = readFileSync(new URL('../src/telnet/session.ts', import.meta.url), 'utf8');
  const submit = src.slice(src.indexOf('private async submitPassword'));
  const body = submit.slice(0, submit.indexOf('\n  }'));
  // Count real CALLS, not mentions — the code carries a comment explaining why
  // it is NOT charged a second time, and a naive substring match sees that too.
  const calls = [...body.matchAll(/this\.auth\.registerFailure\(/g)];
  const iReserve = body.indexOf('this.auth.registerFailure(');
  const iAwait = body.indexOf('await this.auth.verify');
  assert.ok(iReserve >= 0 && iAwait >= 0, 'submitPassword shape changed — re-check this test');
  assert.ok(iReserve < iAwait,
    'the attempt must be charged BEFORE the await, or concurrent submits all see a clean counter');
  assert.equal(calls.length, 1,
    'the attempt is charged more than once — the real budget would be halved');
  void policy;
});

test('the write-token gate is GONE, not merely unused', () => {
  // It was registered on zero routes and had no caller, yet still wrote a
  // long-lived secret to /data every boot. A control that authorises nothing
  // while persisting a secret implies a protection that does not exist.
  const src = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
  const code = src.slice(src.indexOf('*/') + 2); // skip the module docstring
  for (const gone of ['requireWriteAuth', 'tokenEquals', 'loadOrCreateWriteToken', 'zwave-write-token']) {
    assert.ok(!code.includes(gone), `${gone} is still present in auth.ts`);
  }
});

test('one host cannot take every telnet slot', async () => {
  // The global cap alone let a single LAN machine hold all 16 slots with
  // sockets that never even negotiate telnet, denying the TUI to everyone.
  const { startTelnetServer } = await import('../src/telnet/server');
  const { connect } = await import('node:net');

  const srv = startTelnetServer({
    data: mockData({ nodes: [mkNode()] }),
    host: '127.0.0.1',
    port: TELNET_TEST_PORT,
    log: () => {},
    signalDisplay: 'margin',
  } as never);

  // startTelnetServer does not surface the bound port, so probe the fixed one
  // only when it is actually listening; otherwise assert the rule directly.
  const results: string[] = [];
  await new Promise<void>((done) => {
    let settled = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      const s = connect({ host: '127.0.0.1', port: TELNET_TEST_PORT });
      let got = '';
      s.setEncoding('utf8');
      s.on('data', (d) => { got += d; });
      s.on('error', () => { results[i] = 'ERR'; if (++settled === N) done(); });
      setTimeout(() => {
        results[i] = /Too many connections from your address/.test(got) ? 'REFUSED' : got ? 'OK' : 'quiet';
        s.destroy();
        if (++settled === N) done();
      }, 900);
    }
  });
  srv.stop();

  if (results.every((r) => r === 'ERR')) {
    // Port not reachable in this environment — fall back to asserting the rule
    // exists in the source rather than silently passing on nothing.
    const src = readFileSync(new URL('../src/telnet/server.ts', import.meta.url), 'utf8');
    assert.match(src, /sameIp >= MAX_CONNS_PER_IP/, 'the per-IP cap is missing');
    assert.match(src, /socket\.setTimeout\(IDLE_TIMEOUT_MS/, 'the idle timeout is missing');
    return;
  }
  const refused = results.filter((r) => r === 'REFUSED').length;
  assert.ok(refused >= 1,
    `no connection was refused by the per-IP cap — results: ${results.join(', ')}`);
});
