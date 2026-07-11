import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthPolicy, hashPassword, parseUsers } from '../src/auth/loginPolicy';

test('parseUsers: bad / non-array JSON → []', () => {
  assert.deepEqual(parseUsers(undefined), []);
  assert.deepEqual(parseUsers('not json'), []);
  assert.deepEqual(parseUsers('{"a":1}'), []);
  assert.deepEqual(parseUsers('[1,2,3]'), []);
});

test('parseUsers: keeps entries with a non-empty username', () => {
  const u = parseUsers('[{"username":"a","password":"b"},{"username":"","password":"x"},{"password":"y"}]');
  assert.equal(u.length, 1);
  assert.equal(u[0].username, 'a');
  assert.equal(u[0].password, 'b');
});

test('hashPassword: produces a verifiable scrypt string', async () => {
  const h = hashPassword('hunter2');
  assert.match(h, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
  const p = createAuthPolicy({ enabled: true, requireOnIngress: false, users: [{ username: 'u', password: h }], maxAttempts: 3, idleLockMin: 0 });
  assert.equal(await p.verify('u', 'hunter2'), true);
  assert.equal(await p.verify('u', 'wrong'), false);
});

test('verify: plaintext + scrypt users, wrong password, unknown user', async () => {
  const scrypted = hashPassword('s3cret');
  const p = createAuthPolicy({
    enabled: true, requireOnIngress: false,
    users: [{ username: 'admin', password: 'pw' }, { username: 'ops', password: scrypted }],
    maxAttempts: 3, idleLockMin: 0,
  });
  assert.equal(await p.verify('admin', 'pw'), true);
  assert.equal(await p.verify('admin', 'nope'), false);
  assert.equal(await p.verify('ops', 's3cret'), true);
  assert.equal(await p.verify('ops', 'nope'), false);
  assert.equal(await p.verify('ghost', 'anything'), false);
});

test('policy flags: enabled/requireOnIngress/hasUsers/idleLockMs', () => {
  const p = createAuthPolicy({ enabled: true, requireOnIngress: true, users: [{ username: 'a', password: 'b' }], maxAttempts: 5, idleLockMin: 10 });
  assert.equal(p.enabled, true);
  assert.equal(p.requireOnIngress, true);
  assert.equal(p.hasUsers(), true);
  assert.equal(p.maxAttempts, 5);
  assert.equal(p.idleLockMs, 10 * 60_000);

  const empty = createAuthPolicy({ enabled: true, requireOnIngress: false, users: [], maxAttempts: 3, idleLockMin: 0 });
  assert.equal(empty.hasUsers(), false);
});

test('throttle: escalates past maxAttempts and clears on success', () => {
  const p = createAuthPolicy({ enabled: true, requireOnIngress: false, users: [{ username: 'a', password: 'b' }], maxAttempts: 3, idleLockMin: 0 });
  const peer = '10.0.0.9';
  assert.equal(p.blockedMsFor(peer), 0);
  p.registerFailure(peer); // 1
  p.registerFailure(peer); // 2
  assert.equal(p.blockedMsFor(peer), 0, 'not blocked below maxAttempts');
  p.registerFailure(peer); // 3 → blocked
  assert.ok(p.blockedMsFor(peer) > 0, 'blocked at maxAttempts');
  p.registerSuccess(peer);
  assert.equal(p.blockedMsFor(peer), 0, 'cleared on success');
});

test('throttle is per-peer', () => {
  const p = createAuthPolicy({ enabled: true, requireOnIngress: false, users: [{ username: 'a', password: 'b' }], maxAttempts: 1, idleLockMin: 0 });
  p.registerFailure('peerX');
  assert.ok(p.blockedMsFor('peerX') > 0);
  assert.equal(p.blockedMsFor('peerY'), 0);
});
