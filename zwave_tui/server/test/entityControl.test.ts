import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveService, verbsFor, isControllable, verbLabel, isHighStakes } from '../src/zwave/entityControl';

test('verbsFor: controllable domains offer domain-appropriate verbs; others none', () => {
  assert.deepEqual(verbsFor('light'), ['on', 'off', 'toggle']);
  assert.deepEqual(verbsFor('cover'), ['open', 'close', 'toggle']);
  assert.deepEqual(verbsFor('lock'), ['lock', 'unlock']);
  assert.deepEqual(verbsFor('sensor'), []);
  assert.deepEqual(verbsFor('climate'), []); // not yet controllable
  assert.equal(isControllable('light'), true);
  assert.equal(isControllable('binary_sensor'), false);
});

test('resolveService maps (domain, verb) → the correct HA service', () => {
  assert.deepEqual(resolveService('light', 'on'), { domain: 'homeassistant', service: 'turn_on' });
  assert.deepEqual(resolveService('switch', 'off'), { domain: 'homeassistant', service: 'turn_off' });
  assert.deepEqual(resolveService('fan', 'toggle'), { domain: 'homeassistant', service: 'toggle' });
  // covers use their own domain services (open/close/toggle)
  assert.deepEqual(resolveService('cover', 'open'), { domain: 'cover', service: 'open_cover' });
  assert.deepEqual(resolveService('cover', 'close'), { domain: 'cover', service: 'close_cover' });
  assert.deepEqual(resolveService('cover', 'toggle'), { domain: 'cover', service: 'toggle' });
  // locks
  assert.deepEqual(resolveService('lock', 'lock'), { domain: 'lock', service: 'lock' });
  assert.deepEqual(resolveService('lock', 'unlock'), { domain: 'lock', service: 'unlock' });
});

test('resolveService rejects a verb not valid for the domain (null, never a bad call)', () => {
  assert.equal(resolveService('lock', 'on'), null); // a lock has no turn_on
  assert.equal(resolveService('light', 'open'), null); // a light does not open
  assert.equal(resolveService('sensor', 'on'), null); // not controllable at all
  assert.equal(resolveService('cover', 'lock'), null);
});

test('verbLabel is a human imperative for every verb', () => {
  assert.equal(verbLabel('on'), 'Turn On');
  assert.equal(verbLabel('off'), 'Turn Off');
  assert.equal(verbLabel('toggle'), 'Toggle');
  assert.equal(verbLabel('lock'), 'Lock');
  assert.equal(verbLabel('unlock'), 'Unlock');
  assert.equal(verbLabel('open'), 'Open');
  assert.equal(verbLabel('close'), 'Close');
});

test('isHighStakes flags unlock + garage/cover open/toggle, not routine on/off', () => {
  assert.equal(isHighStakes('lock', 'unlock'), true);
  assert.equal(isHighStakes('lock', 'lock'), false);
  assert.equal(isHighStakes('cover', 'open'), true);
  assert.equal(isHighStakes('cover', 'toggle'), true);
  assert.equal(isHighStakes('cover', 'close'), false);
  assert.equal(isHighStakes('light', 'on'), false);
  assert.equal(isHighStakes('switch', 'off'), false);
});
