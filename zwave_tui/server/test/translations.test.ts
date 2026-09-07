/**
 * Every translation file covers every option, exactly.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW STEP. Home Assistant resolves an option's
 * label by key. A key that is missing, misspelled, or left over from a renamed
 * option produces NO warning anywhere — HA silently falls back to rendering the
 * raw key (`auth_idle_lock_min`) as the field label, in one language only. The
 * add-on starts, the form works, every other test passes, and the only symptom
 * is a screen the author does not read.
 *
 * So the failure is invisible exactly where a human check is weakest: adding an
 * option to config.yaml and updating only the language you speak.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ADDON = join(import.meta.dirname, '..', '..');
const TRANSLATIONS = join(ADDON, 'translations');

/** Top-level option keys from config.yaml's `options:` block. */
function configOptionKeys(): string[] {
  const text = readFileSync(join(ADDON, 'config.yaml'), 'utf8');
  const block = /^options:\n([\s\S]*?)^schema:/m.exec(text);
  assert.ok(block, 'config.yaml has an options: block followed by schema:');
  return [...block[1].matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]);
}

/** Option keys under a translation file's `configuration:` block. */
function translationKeys(file: string): string[] {
  const text = readFileSync(join(TRANSLATIONS, file), 'utf8');
  const at = text.indexOf('\nconfiguration:');
  assert.ok(at >= 0, `${file} has a configuration: block`);
  return [...text.slice(at).matchAll(/^ {2}([a-z_][a-z0-9_]*):/gm)].map((m) => m[1]);
}

const files = readdirSync(TRANSLATIONS).filter((f) => f.endsWith('.yaml')).sort();

test('there is at least one translation file, and en.yaml is one of them', () => {
  assert.ok(files.includes('en.yaml'), 'en.yaml is the reference');
});

for (const file of files) {
  test(`${file}: covers every config.yaml option, with nothing extra`, () => {
    const want = configOptionKeys();
    const got = translationKeys(file);
    const missing = want.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !want.includes(k));
    // `missing` renders the raw key as the label; `extra` is dead weight that
    // usually means an option was renamed and one language was not followed.
    assert.deepEqual(missing, [], `${file} is missing keys — HA renders these as raw keys`);
    assert.deepEqual(extra, [], `${file} has keys config.yaml does not declare`);
    assert.equal(new Set(got).size, got.length, `${file} declares a key twice`);
  });

  test(`${file}: every option has a non-empty name and description`, () => {
    const text = readFileSync(join(TRANSLATIONS, file), 'utf8');
    const body = text.slice(text.indexOf('\nconfiguration:'));
    for (const key of translationKeys(file)) {
      // Slice this option's own stanza: from its key to the next key at the
      // same indent (or end of file).
      const start = body.indexOf(`\n  ${key}:`);
      const rest = body.slice(start + 1);
      const nextAt = rest.search(/\n {2}[a-z_][a-z0-9_]*:/);
      const stanza = nextAt >= 0 ? rest.slice(0, nextAt) : rest;
      assert.match(stanza, /\n {4}name: \S/, `${file}/${key} has no name`);
      assert.match(stanza, /\n {4}description: >-\n {6}\S/, `${file}/${key} has no description`);
    }
  });
}

test('non-English files keep the literals an operator must type or match', () => {
  // These are instructions, not prose: translating "CONFIRM" makes the
  // documented keystroke wrong, and translating a config VALUE ("margin") makes
  // the help describe a setting the schema will reject.
  for (const file of files.filter((f) => f !== 'en.yaml')) {
    const text = readFileSync(join(TRANSLATIONS, file), 'utf8');
    for (const literal of ['CONFIRM', 'margin', 'dbm', 'scrypt:', 'ws://supervisor/core/websocket', 'ws://core-zwave-js:3000', 'zwave_js', 'network_status']) {
      assert.ok(text.includes(literal), `${file} lost the literal "${literal}"`);
    }
  }
});

test('translation files never nest option keys (nesting is a silent rename)', () => {
  // An add-on has no options-migration hook, so nesting a key moves the
  // operator's value to a path the schema no longer declares: the login gate
  // silently returns to `false` while write actions stay on. en.yaml carries
  // the long-form warning; this is the enforcement.
  const want = new Set(configOptionKeys());
  for (const file of files) {
    const text = readFileSync(join(TRANSLATIONS, file), 'utf8');
    const body = text.slice(text.indexOf('\nconfiguration:'));
    const deep = [...body.matchAll(/^ {4}([a-z_][a-z0-9_]*):/gm)]
      .map((m) => m[1])
      .filter((k) => k !== 'name' && k !== 'description' && want.has(k));
    assert.deepEqual(deep, [], `${file} nests an option key under another option`);
  }
});
