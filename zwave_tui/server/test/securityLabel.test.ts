import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appArmorLabel, LABEL_PATHS } from '../src/securityLabel';

const reader = (files: Record<string, string>) => (p: string): string => {
  if (!(p in files)) throw new Error('ENOENT');
  return files[p];
};

test('the per-LSM label wins, NULs and whitespace are dropped (v0.74.4)', () => {
  const r = appArmorLabel(reader({ [LABEL_PATHS[0]]: 'local_zwave_tui (enforce)\n\0', [LABEL_PATHS[1]]: 'other (complain)' }));
  assert.deepEqual(r, { label: 'local_zwave_tui (enforce)', enforcing: true });
});

test('falls back to the shared attr file (v0.74.4)', () => {
  assert.deepEqual(appArmorLabel(reader({ [LABEL_PATHS[1]]: 'local_zwave_tui (enforce)\n' })), { label: 'local_zwave_tui (enforce)', enforcing: true });
});

test('complain mode, docker-default in complain, unconfined and unreadable are not enforcing (v0.74.4)', () => {
  assert.equal(appArmorLabel(reader({ [LABEL_PATHS[1]]: 'local_zwave_tui (complain)' })).enforcing, false);
  assert.equal(appArmorLabel(reader({ [LABEL_PATHS[1]]: 'unconfined' })).enforcing, false);
  assert.deepEqual(appArmorLabel(reader({})), { label: 'unknown (not readable)', enforcing: false });
  assert.equal(appArmorLabel(reader({ [LABEL_PATHS[0]]: '', [LABEL_PATHS[1]]: 'docker-default (enforce)' })).label, 'docker-default (enforce)', 'an empty per-LSM file falls through');
});
