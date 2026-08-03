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

import { ingressRedirectTarget } from '../src/auth';
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
  // Header, wrong IP → the forge attempt. Uses an RFC 5737 documentation
  // address (TEST-NET-1) so no real LAN range appears in the repo.
  assert.equal(isIngressTrusted({ headers: { 'x-ingress-path': '/x' }, ip: '192.0.2.40' }), false);
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

test('concurrent sessions all contend for ONE backoff counter', async () => {
  // `this.verifying` serialises ONE session, but the transports allow 16 telnet
  // + 16 ws concurrently and each has its own flag. Charging the failure only
  // after `verify()` resolved meant every session that submitted before the
  // first failure landed read a still-clean counter — ~32 guesses evaluated
  // with the backoff contributing nothing.
  //
  // Driven for REAL, through four live sessions. The previous version of this
  // test built exactly this policy mock and then threw it away to grep
  // session.ts for the call order, so it asserted nothing about behaviour.
  const { TuiSession } = await import('../src/telnet/session');

  const charged: string[] = [];
  /** How many failures had been charged at the moment each verify STARTED. */
  const chargedWhenVerifyBegan: number[] = [];
  let releaseVerify: (() => void) | null = null;
  const allBlocked = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });

  const policy = {
    enabled: true,
    maxAttempts: 3,
    requireOnIngress: false,
    idleLockMs: 0,
    hasUsers: () => true,
    blockedMsFor: () => 0,
    registerFailure: (p: string) => { charged.push(p); },
    registerSuccess: () => { charged.length = 0; },
    // Every verify parks here until all four have STARTED, which is precisely
    // the concurrent window the backoff has to survive.
    verify: async () => {
      chargedWhenVerifyBegan.push(charged.length);
      if (chargedWhenVerifyBegan.length === SESSIONS) releaseVerify?.();
      await allBlocked;
      return false;
    },
  };

  const SESSIONS = 4;
  const sessions = Array.from({ length: SESSIONS }, (_, i) =>
    new TuiSession({
      write: () => {},
      data: mockData({ nodes: [mkNode()] }),
      auth: policy as never,
      peer: `10.0.0.${i + 1}`,
      log: () => {},
      width: 100,
      height: 30,
    } as never));

  for (const s of sessions) {
    for (const ch of 'user') s.feed([{ type: 'char', ch }]);
    s.feed([{ type: 'enter' }]);
    for (const ch of 'guess') s.feed([{ type: 'char', ch }]);
    s.feed([{ type: 'enter' }]);   // fires submitPassword() — does NOT await
  }

  // Let all four reach their verify() call.
  await allBlocked;
  await new Promise((r) => setImmediate(r));

  assert.equal(chargedWhenVerifyBegan.length, SESSIONS,
    'not every session reached verify — the test did not exercise concurrency');
  assert.deepEqual(
    chargedWhenVerifyBegan,
    [1, 2, 3, 4],
    'each concurrent submit must see the counter already carrying every earlier ' +
      'attempt. All-zeros means the failure is charged AFTER the await, so ' +
      `${SESSIONS} guesses ran against a clean counter. Saw: ${JSON.stringify(chargedWhenVerifyBegan)}`,
  );
  assert.deepEqual(charged, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
    'each peer must be charged exactly once');
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
    // The server did not come up on this host at all — say so instead of
    // passing. A previous version fell back to grepping the source here, which
    // asserted nothing about behaviour AND never actually ran (deleting the
    // per-IP cap still left the suite green through this branch).
    assert.fail('telnet server never accepted a connection — the cap was not exercised');
  }
  const refused = results.filter((r) => r === 'REFUSED').length;
  assert.ok(refused >= 1,
    `no connection was refused by the per-IP cap — results: ${results.join(', ')}`);
});

test('a silent socket is reclaimed by the idle timeout', async () => {
  // A peer that connects and sends NOTHING — never even negotiating telnet —
  // used to hold its slot forever: no read timeout, no keepalive, and the only
  // per-connection timers (the 60 ms ESC flush, the 1 Hz redraw) reclaim
  // nothing. 16 such sockets denied the TUI permanently.
  //
  // Driven with a 250 ms timeout via the test-only option. The v0.24.4 test
  // asserted only that the SOURCE LINE existed, and did so from a branch that
  // never executed — deleting both socket options left 497 tests green.
  const { startTelnetServer } = await import('../src/telnet/server');
  const { connect } = await import('node:net');

  const logs: string[] = [];
  const srv = startTelnetServer({
    data: mockData({ nodes: [mkNode()] }),
    host: '127.0.0.1',
    port: TELNET_TEST_PORT + 1,
    log: (m: string) => { logs.push(m); },
    signalDisplay: 'margin',
    idleTimeoutMs: 250,
  } as never);

  const closedWithin = await new Promise<boolean>((done) => {
    const s = connect({ host: '127.0.0.1', port: TELNET_TEST_PORT + 1 });
    const timer = setTimeout(() => { s.destroy(); done(false); }, 3000);
    // Send nothing at all — this is the abusive case. But DO read: a socket
    // with no 'data' listener stays paused, so the server's FIN is never
    // processed and 'close' would never fire regardless of the server.
    s.resume();
    s.on('close', () => { clearTimeout(timer); done(true); });
    s.on('error', () => { clearTimeout(timer); done(false); });
  });
  srv.stop();

  assert.equal(closedWithin, true,
    `an idle socket was never reclaimed — one host can still hold slots forever. server logs: ${JSON.stringify(logs)}`);
});

test('accepted sockets get TCP keepalive, to catch half-open peers', async () => {
  // A peer whose cable is yanked (or whose NAT entry expires) never sends a
  // FIN, so the read timeout alone would hold the slot for its full duration.
  // setKeepAlive is invisible from the client end, so assert it at the source
  // of truth: the socket method the server calls on accept.
  const net = await import('node:net');
  const { startTelnetServer } = await import('../src/telnet/server');

  const calls: Array<[boolean, number]> = [];
  const original = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function patched(
    this: import('node:net').Socket,
    enable?: boolean,
    delay?: number,
  ) {
    calls.push([enable === true, Number(delay)]);
    return original.call(this, enable as boolean, delay as number);
  } as typeof original;

  try {
    const srv = startTelnetServer({
      data: mockData({ nodes: [mkNode()] }),
      host: '127.0.0.1',
      port: TELNET_TEST_PORT + 2,
      log: () => {},
      signalDisplay: 'margin',
      keepAliveMs: 12_345,
    } as never);

    await new Promise<void>((done) => {
      const s = net.connect({ host: '127.0.0.1', port: TELNET_TEST_PORT + 2 });
      s.on('connect', () => setTimeout(() => { s.destroy(); done(); }, 250));
      s.on('error', () => done());
    });
    srv.stop();
  } finally {
    net.Socket.prototype.setKeepAlive = original;
  }

  assert.ok(
    calls.some(([enabled, delay]) => enabled && delay === 12_345),
    `no accepted socket had keepalive enabled — calls seen: ${JSON.stringify(calls)}`,
  );
});

test('an action failure message is sanitized before it reaches the result card', async () => {
  // session.ts puts ActionResult.message straight onto the screen. The string
  // is whatever an HA service call threw — Home Assistant's, the driver's, or
  // the device's text, none of it ours. v0.24.4 wrapped it, and nothing
  // asserted the wrap: deleting `sanitizeEventText(...)` left the suite green.
  const { createActionRunner } = await import('../src/zwave/zwaveActions');

  // U+009B is the 8-bit CSI and U+009D the 8-bit OSC — xterm.js EXECUTES both.
  const nasty = 'device said \x1b[31mred\x9b2J\x9dtitle\x07 and \n a newline';
  const runner = createActionRunner({
    client: { send: async () => { throw new Error(nasty); } } as never,
    entryId: () => 'entry',
    deviceIdOf: () => 'dev-1',
    pingEntityOf: () => null,
    log: () => {},
    enabled: true,
  } as never);

  // reInterview goes through deviceCmd → client.send, so the thrown text is
  // what the operator would actually see. (ping short-circuits on a missing
  // ping-button entity and never reaches the client.)
  const res = await runner.reInterview(8);
  assert.equal(res.ok, false, 'the throwing call should have failed');
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(res.message),
    `the action-result message carried control bytes: ${JSON.stringify(res.message)}`);
  assert.ok(res.message.includes('device said'),
    `sanitizing must not destroy the operator-useful part of the message. got: ${JSON.stringify(res.message)}`);
});

test('controller SDK / firmware strings are sanitized', async () => {
  const { controllerVersions } = await import('../src/zwave/zwaveData');
  // These come off the wire from the driver and land in the CONTROLLER screen's
  // telemetry row. A test COMMENT claimed this was covered; no assertion did.
  for (const raw of ['7.\x9b2J19', 'v1.0\x00\x07', 'sdk\x9dtitle\x07']) {
    const got = controllerVersions({ sdk_version: raw, firmware_version: raw });
    for (const v of [got.sdkVersion, got.firmwareVersion]) {
      assert.ok(v != null && !/[\x00-\x1f\x7f-\x9f]/.test(v),
        `sanitized version still carries control bytes: ${JSON.stringify(v)}`);
    }
  }
  const absent = controllerVersions({});
  assert.equal(absent.sdkVersion, null, 'a missing version must stay null, not become ""');
  assert.equal(absent.firmwareVersion, null, 'a missing version must stay null, not become ""');
});

test('an ACTIVE operator is never evicted by the idle sweep', async () => {
  // The reclaim must key on INBOUND data. If the sweep ignored `lastRxAt`, a
  // fully-engaged operator would be dropped mid-session every idleTimeoutMs —
  // a far worse bug than the slot exhaustion the sweep exists to prevent.
  const { startTelnetServer } = await import('../src/telnet/server');
  const { connect } = await import('node:net');

  const srv = startTelnetServer({
    data: mockData({ nodes: [mkNode()] }),
    host: '127.0.0.1',
    port: TELNET_TEST_PORT + 3,
    log: () => {},
    signalDisplay: 'margin',
    idleTimeoutMs: 300,
  } as never);

  const survived = await new Promise<boolean>((done) => {
    const s = connect({ host: '127.0.0.1', port: TELNET_TEST_PORT + 3 });
    s.resume();
    // Type something harmless well inside every sweep window.
    const typing = setInterval(() => { if (!s.destroyed) s.write(' '); }, 80);
    const finish = (ok: boolean) => { clearInterval(typing); s.destroy(); done(ok); };
    s.on('close', () => finish(false));   // evicted ⇒ failure
    s.on('error', () => finish(false));
    // Outlast several idle windows.
    setTimeout(() => finish(true), 1200);
  });
  srv.stop();

  assert.equal(survived, true,
    'an actively-typing operator was disconnected — the sweep is ignoring inbound data');
});

/* ── the ingress landing redirect ────────────────────────────────────────
 *
 * The sidebar panel rendered a bare "404: Not Found" inside an otherwise
 * healthy Home Assistant. The panel registration was correct — `get_panels`
 * showed local_zwave_tui the same shape as the working Power panel — and the
 * add-on served every route (/ → 302, /console → 200). The 404 came from the
 * REDIRECT TARGET: HA loads the panel at /api/hassio_ingress/<token>/, and
 * `reply.redirect('/console')` is an absolute path, so the browser threw the
 * prefix away and asked HA itself for /console, which HA does not serve.
 *
 * It looked like a broken panel because the address bar stayed on
 * /local_zwave_tui the whole time — the iframe navigated, not the page.
 *
 * The redirect is built by hand rather than tested through a live Fastify
 * instance so this stays a unit test; the shape below is exactly what
 * index.ts does.
 */

// Import the REAL function. A local re-implementation here would only prove the
// rule is self-consistent, and would leave the mutant for it alive.
const ingressRedirect = ingressRedirectTarget;

test('the landing redirect keeps the ingress prefix', () => {
  assert.equal(
    ingressRedirect('/api/hassio_ingress/10QhLe0v5RyjceI9Gm_rjN7txRGcCDchKw7tpxs1zbw'),
    '/api/hassio_ingress/10QhLe0v5RyjceI9Gm_rjN7txRGcCDchKw7tpxs1zbw/console',
    'dropping the prefix sends the browser to HA’s own /console, which 404s',
  );
});

test('a trailing slash on the ingress path does not double up', () => {
  // HA has sent the path both ways; `//console` is not a path the proxy maps.
  assert.equal(ingressRedirect('/api/hassio_ingress/ABC/'), '/api/hassio_ingress/ABC/console');
  assert.equal(ingressRedirect('/api/hassio_ingress/ABC//'), '/api/hassio_ingress/ABC/console');
});

test('direct (non-ingress) access still lands on /console', () => {
  // Port 8788 reached without HA in front carries no header at all.
  for (const absent of [undefined, null, 123, ['/a', '/b']]) {
    assert.equal(ingressRedirect(absent), '/console', `header ${JSON.stringify(absent)} must degrade to /console`);
  }
});

test('a protocol-relative ingress path cannot become an open redirect', () => {
  // `//evil.com` in a Location sends the browser to ANOTHER ORIGIN. CodeQL did
  // NOT flag this — it flagged the ReDoS beside it — so a green scan was not
  // evidence the input path was safe.
  for (const hostile of ['//evil.com', '///evil.com', '//evil.com/api/hassio_ingress/X']) {
    assert.equal(ingressRedirect(hostile), '/console', `${hostile} must not survive into a Location`);
  }
});

test('CR/LF/backslash in the ingress path is refused, not sanitised', () => {
  for (const bad of ['/api/x\r\nLocation: //evil.com', '/api/x\nSet-Cookie: a=b', '/api\\evil']) {
    assert.equal(ingressRedirect(bad), '/console');
  }
});

test('a non-rooted or over-long path is refused', () => {
  assert.equal(ingressRedirect('api/hassio_ingress/X'), '/console', 'must be rooted');
  assert.equal(ingressRedirect('https://evil.com'), '/console', 'absolute URL is not a path');
  assert.equal(ingressRedirect('/' + 'a'.repeat(300)), '/console', 'over the length cap');
  assert.equal(ingressRedirect('/'.repeat(50)), '/console', 'all-slashes trims to nothing');
});

test('trailing slashes are trimmed within the length cap', () => {
  assert.equal(ingressRedirect('/api/hassio_ingress/ABC' + '/'.repeat(40)), '/api/hassio_ingress/ABC/console');
});

test('a long run of slashes is refused promptly, never backtracked over', () => {
  // The original trimmed with /\/+$/, which CodeQL scored 7.5 for polynomial
  // ReDoS on a user-provided value. Two things now stop that: the length cap
  // rejects the input before any scanning, and the trim itself is a linear
  // charCodeAt walk rather than a regex. This asserts the OBSERVABLE property —
  // a hostile input returns immediately, and returns the safe fallback.
  const t0 = Date.now();
  assert.equal(ingressRedirect('/a' + '/'.repeat(100_000)), '/console', 'over the cap ⇒ fallback');
  const ms = Date.now() - t0;
  assert.ok(ms < 250, `took ${ms}ms — the input is being scanned when it should be rejected`);
});
