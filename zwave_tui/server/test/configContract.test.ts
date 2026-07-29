/**
 * The option → schema → translation → env → config.ts contract.
 *
 * ★ v0.25.0. `config.ts`'s own header says to "keep the two in lock-step —
 *   flipping one without the other makes the knob dead", and nothing enforced
 *   it. Two real defects had already slipped through by v0.24.4:
 *
 *     • `log_level` was declared, translated, exported as LOG_LEVEL and parsed
 *       into `config.logLevel` — and read by no consumer at all.
 *     • `telnet_port` was declared and exported, but the published `ports:`
 *       key is a hard-coded literal, so any non-default value moved only the
 *       in-container bind and silently killed LAN telnet.
 *
 * These tests read the shipped files as DATA. They are deliberately structural
 * rather than behavioural: the failure mode is a key that exists in one file
 * and not another, which no amount of exercising the server can reveal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ADDON = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ADDON, rel), 'utf8');

/** Keys of a top-level `block:` mapping in config.yaml (2-space indented). */
function blockKeys(yaml: string, block: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `${block}:`);
  assert.notEqual(start, -1, `config.yaml has no top-level '${block}:'`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || l.startsWith('  #')) continue;
    if (!l.startsWith('  ')) break; // dedent ⇒ block over
    const m = /^ {2}([a-z_][a-z0-9_]*):/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

test('every option has a schema entry and vice versa', () => {
  const cfg = read('config.yaml');
  const options = blockKeys(cfg, 'options');
  const schema = blockKeys(cfg, 'schema');
  assert.ok(options.length > 0, 'no options parsed — the parser or the file changed shape');
  assert.deepEqual(
    options.filter((k) => !schema.includes(k)),
    [],
    'option(s) with no schema entry — HA will reject the add-on config',
  );
  assert.deepEqual(
    schema.filter((k) => !options.includes(k)),
    [],
    'schema entr(ies) with no default in options',
  );
});

test('every option has a translation label', () => {
  const options = blockKeys(read('config.yaml'), 'options');
  const en = read('translations/en.yaml');
  // Labels live under `configuration:`; `network:` (the ports_description twin)
  // sits alongside it, so scope to the configuration block. Line-based, NOT a
  // regex with `\Z` — JavaScript has no such escape, so `\Z` is a literal "Z"
  // and the capture stopped at the first "Z-Wave" in the file.
  const enLines = en.split('\n');
  const cfgStart = enLines.findIndex((l) => l === 'configuration:');
  assert.notEqual(cfgStart, -1, 'translations/en.yaml has no `configuration:` block');
  const labelled = new Set<string>();
  for (let i = cfgStart + 1; i < enLines.length; i++) {
    const l = enLines[i];
    if (l.trim() === '') continue;
    if (!l.startsWith('  ')) break; // dedent ⇒ block over
    const m = /^ {2}([a-z_][a-z0-9_]*):$/.exec(l);
    if (m) labelled.add(m[1]);
  }
  assert.deepEqual(
    options.filter((k) => !labelled.has(k)),
    [],
    'option(s) with no label in translations/en.yaml — HA shows the raw key',
  );
  assert.deepEqual(
    [...labelled].filter((k) => !options.includes(k)),
    [],
    'translation label(s) for option(s) that no longer exist',
  );
});

test('every option is exported by the run script', () => {
  const options = blockKeys(read('config.yaml'), 'options');
  const run = read('rootfs/etc/services.d/zwave-tui/run');
  // Two legitimate read mechanisms: `bashio::config 'key'` for scalars, and a
  // direct `jq '.key' /data/options.json` for structured options (`users` is a
  // repeatable row, which bashio cannot flatten).
  const missing = options.filter((k) => !run.includes(`'${k}'`) && !run.includes(`.${k}`));
  assert.deepEqual(missing, [], 'option(s) declared but never read by the run script — dead config');
});

test('every env var the run script exports is consumed by the server', () => {
  const run = read('rootfs/etc/services.d/zwave-tui/run');
  const exported = new Set(
    [...run.matchAll(/^export ([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
  // Read the whole src tree, not just config.ts: a few vars (NODE_ENV) are read
  // by libraries or by other modules directly.
  const src = [
    'server/src/config.ts',
    'server/src/index.ts',
    'server/src/logger.ts',
  ].map(read).join('\n');
  const known = new Set(['NODE_ENV']); // consumed by Node/Fastify, not by us
  const orphans = [...exported].filter(
    (v) => !known.has(v) && !src.includes(`process.env.${v}`),
  );
  assert.deepEqual(
    orphans,
    [],
    'run script exports env var(s) the server never reads — dead plumbing',
  );
});

test('the telnet port the server binds matches the published ports: key', () => {
  // The `ports:` key is the CONTAINER port. If the run script ever exports a
  // TELNET_PORT that differs from it, the published mapping points at nothing
  // and LAN telnet dies with no error anywhere — the exact v0.24.4 defect.
  const cfg = read('config.yaml');
  const published = /^ {2}"(\d+)\/tcp":/m.exec(cfg);
  assert.ok(published, 'no published tcp port found in config.yaml');
  const run = read('rootfs/etc/services.d/zwave-tui/run');
  const bound = /^export TELNET_PORT=(\d+)\s*$/m.exec(run);
  assert.ok(bound, 'run script must export a LITERAL TELNET_PORT (not a bashio option)');
  assert.equal(
    bound[1],
    published[1],
    'the bound telnet port and the published container port disagree',
  );
});

test('log_level actually reaches a consumer', () => {
  // The regression that started this file: parsed, then read by nobody.
  const cfg = read('server/src/config.ts');
  assert.match(cfg, /logLevel: process\.env\.LOG_LEVEL/, 'config.logLevel is gone');
  const index = read('server/src/index.ts');
  assert.match(
    index,
    /createLogger\(config\.logLevel\)/,
    'config.logLevel is parsed but never handed to a logger — dead config again',
  );
});

test('server/package.json version tracks the add-on version', () => {
  // These drifted for 14 releases: package.json still said 0.10.0 while the
  // add-on shipped 0.24.4. Nothing breaks, but every reader of package.json is
  // told the wrong thing, and the release workflow now cross-checks the tag
  // against config.yaml — so this keeps the third copy honest too.
  const cfg = /^version:\s*"?([0-9.]+)"?\s*$/m.exec(read('config.yaml'));
  assert.ok(cfg, 'no version: in config.yaml');
  const pkg = JSON.parse(read('server/package.json')) as { version: string };
  assert.equal(pkg.version, cfg[1], 'server/package.json version has drifted from config.yaml');
});

test('the Node major is the same in dev, CI and the container', () => {
  // These had silently diverged: the container installs Node 22 (alpine 3.21 is
  // the newest Home Assistant base image, and it ships nodejs 22.x), CI pinned
  // 22 — but a developer machine runs whatever is installed, and this suite was
  // being run locally on Node 26. A green local run on a different major than
  // production is a weaker signal than it looks, in exactly the direction that
  // hides problems: newer Node accepts more.
  //
  // `engines` is the single source of truth; .nvmrc and CI must agree with it.
  const pkg = JSON.parse(read('server/package.json')) as { engines?: { node?: string } };
  const range = pkg.engines?.node;
  assert.ok(range, 'server/package.json declares no engines.node');
  const major = /(\d+)/.exec(range)?.[1];
  assert.ok(major, `could not read a major out of engines.node "${range}"`);

  const nvmrc = read('server/.nvmrc').trim();
  assert.equal(nvmrc, major, `.nvmrc (${nvmrc}) disagrees with engines.node (${major})`);

  const ci = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const ciNode = /node-version:\s*'?(\d+)'?/.exec(ci)?.[1];
  assert.equal(ciNode, major,
    `ci.yml node-version (${ciNode}) disagrees with engines.node (${major}) — ` +
    'CI would be testing a different runtime than the add-on ships');

  // The container's Node comes from the HA base image's Alpine version, so a
  // base bump is what moves this. Keep the note beside the assertion.
  const build = read('build.yaml');
  assert.match(build, /base:3\.21/,
    'the HA base image changed — re-check which Node the new Alpine ships and ' +
    'update engines/.nvmrc/ci.yml together (3.21 ships nodejs 22.x)');
});
