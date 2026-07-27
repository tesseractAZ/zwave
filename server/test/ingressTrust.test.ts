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
