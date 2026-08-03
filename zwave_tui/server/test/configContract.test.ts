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

test('flush cadences: the SD-wear defaults are the ones production actually gets', () => {
  // THE PRECEDENCE TRAP (v0.26): index.ts passes config.historyFlushMs as
  // opts.historyFlushMs, and zwaveData reads `opts ?? env ?? default` — so opts
  // ALWAYS wins and the constructor's default is dead code in production.
  // Raising only the constructor default left the entire SD-wear fix inert on
  // the one host that matters. Pin the value at the layer that actually
  // decides, AND pin that the two layers still agree.
  const cfg = read('server/src/config.ts');
  assert.match(cfg, /HISTORY_FLUSH_MS \?\? 120_000/, 'config.ts history flush cadence regressed');
  assert.match(cfg, /EVIDENCE_FLUSH_MS \?\? 900_000/, 'config.ts evidence flush cadence regressed');

  const zd = read('server/src/zwave/zwaveData.ts');
  assert.match(zd, /HISTORY_FLUSH_MS \?\? 120_000/, 'zwaveData default drifted from config');
  assert.match(zd, /EVIDENCE_FLUSH_MS \?\? 900_000/, 'zwaveData default drifted from config');

  // And index.ts must still be the thing that forwards them — if that wiring
  // is removed, the two defaults above stop being what production gets.
  const index = read('server/src/index.ts');
  assert.match(index, /historyFlushMs: config\.historyFlushMs/, 'index.ts no longer forwards historyFlushMs');
  assert.match(index, /evidenceFlushMs: config\.evidenceFlushMs/, 'index.ts no longer forwards evidenceFlushMs');
});

/* ── the release relay ───────────────────────────────────────────────────
 *
 * v0.29.2. The pipeline is a RELAY — release.yml opens a PR whose subject
 * starts "Release v"; tag-release.yml matches that subject, reads the version
 * out of config.yaml and dispatches publish-release.yml. Every link is a
 * string match against another file, and none of it was checked.
 *
 * It had already failed silently: v0.29.0 and v0.29.1 both merged to main and
 * sat UNTAGGED because no link existed at all, while `publish-release.yml`
 * waited for a tag that nothing pushed. A broken relay does not error — it
 * just quietly stops releasing, which is the hardest kind of failure to
 * notice. These read the workflows as DATA and pin the joins.
 */

const wf = (name: string): string =>
  readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');

test('tag-release watches the path that actually holds the version', () => {
  const tr = wf('tag-release.yml');
  assert.match(tr, /paths:\s*\n\s*-\s*'zwave_tui\/config\.yaml'/,
    'tag-release.yml watches a path that is not the add-on config — moving or ' +
    'renaming config.yaml would stop every release with no error');
  assert.match(tr, /zwave_tui\/config\.yaml/,
    'tag-release.yml must read the version from the add-on config');
});

test('tag-release keys on the subject release.yml actually writes', () => {
  // If these two strings drift, releases stop happening and nothing fails.
  assert.match(wf('tag-release.yml'), /startsWith\(github\.event\.head_commit\.message,\s*'Release v'\)/);
  assert.match(wf('release.yml'), /git commit -m "Release v\$\{NEXT\}"/,
    'release.yml must write a subject tag-release.yml recognises');
});

test('tag-release dispatches a workflow that exists and takes a version', () => {
  const m = /gh workflow run ([\w.-]+\.yml)/.exec(wf('tag-release.yml'));
  assert.ok(m, 'tag-release.yml dispatches nothing — a tag would be created but no release cut');
  const target = wf(m![1]); // throws if the file is missing
  assert.match(target, /workflow_dispatch:/,
    `${m![1]} has no workflow_dispatch trigger, so the dispatch would fail`);
  assert.match(target, /version:/,
    `${m![1]} does not accept the version input tag-release.yml passes`);
});

test('release.yml bumps BOTH files the version contract pins together', () => {
  // Bumping only config.yaml (which is all the power equivalent needs) would
  // open a release PR that fails its own CI on the version-drift assertion above.
  const r = wf('release.yml');
  assert.match(r, /zwave_tui\/config\.yaml/);
  assert.match(r, /zwave_tui\/server\/package\.json/,
    'release.yml must bump server/package.json too — configContract pins it to config.yaml');
});

test('config.yaml and the publisher agree on the image', () => {
  // v0.29.2 turned on GHCR publishing, so the old assertion here ("this add-on
  // publishes no container image") is no longer the invariant — this is.
  //
  // The dangerous state is a MISMATCH, and it is asymmetric:
  //   • `image:` present with no publisher, or pointing at a name nothing
  //     pushes  ⇒ Supervisor pulls a tag that does not exist and EVERY install
  //     and update fails.
  //   • a publisher with no `image:` key ⇒ harmless. That is the rollout order
  //     on purpose: publish first, verify the packages exist and are public,
  //     THEN point config.yaml at them.
  const code = (name: string): string =>
    wf(name).split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const pub = code('publish-release.yml');
  const declared = /^image:\s*(\S+)/m.exec(read('config.yaml'))?.[1];

  const pushed = [...pub.matchAll(/ghcr\.io\/[^\s:]*\/\$\{\{[^}]*\}\}-([a-z0-9-]+):/g)]
    .map((m) => m[1]);
  if (declared) {
    assert.ok(pushed.length, 'config.yaml declares image: but publish-release.yml pushes nothing');
    const suffix = /\{arch\}-([a-z0-9-]+)\s*$/.exec(declared)?.[1];
    assert.ok(suffix, `image: '${declared}' is not the {arch}-<name> form Supervisor expands`);
    assert.ok(pushed.includes(suffix!),
      `config.yaml pulls '${suffix}' but the workflow pushes ${JSON.stringify([...new Set(pushed)])}`);
  }
  // Whenever it does publish, it needs the scope to do so.
  if (pushed.length) {
    assert.match(pub, /packages:\s*write/,
      'publish-release.yml pushes to GHCR without packages: write');
  }
});

test('every workflow file is structurally parseable YAML', () => {
  // The relay tests above all PASSED against a release.yml that GitHub could
  // not parse at all: an inline multi-line PR body had escaped its `run: |`
  // block, putting prose at column 0. Regex joins prove the links point at each
  // other; they say nothing about whether the file loads. An unparseable
  // workflow does not error loudly — it simply never runs.
  //
  // No YAML dependency here, so this checks the property that actually broke:
  // outside a block scalar, a non-comment line at column 0 must be a `key:`.
  for (const name of ['ci.yml', 'codeql.yml', 'publish-release.yml', 'release.yml', 'tag-release.yml']) {
    const lines = wf(name).split('\n');
    let blockIndent: number | null = null;
    lines.forEach((line, i) => {
      if (!line.trim() || line.trimStart().startsWith('#')) return;
      const indent = line.length - line.trimStart().length;
      if (blockIndent != null) {
        if (indent > blockIndent) return;   // still inside the block scalar
        blockIndent = null;                 // dedented back out
      }
      if (/[|>][-+]?\s*$/.test(line)) { blockIndent = indent; return; }
      if (indent === 0) {
        assert.match(line, /^[A-Za-z_][\w-]*:/,
          `${name}:${i + 1} — column-0 line is not a YAML key: ${JSON.stringify(line.slice(0, 60))}`);
      }
    });
  }
});

test('no workflow uses a floating action tag', () => {
  // dependabot.yml opens with "Every workflow pins its actions by commit SHA
  // rather than by a floating tag" — and nothing enforced it. The two workflows
  // added in v0.29.2 were copied from a sibling repo and arrived on
  // `actions/checkout@v5`: unpinned, AND a different major than the v7.0.1 the
  // rest of the repo runs. A floating tag is the exact supply-chain hole the
  // pinning policy exists to close, and it had landed inside the release
  // machinery itself.
  for (const name of ['ci.yml', 'codeql.yml', 'publish-release.yml', 'release.yml', 'tag-release.yml']) {
    for (const line of wf(name).split('\n')) {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/,
        `${name}: '${m[1]}' is not pinned to a 40-char commit SHA`);
    }
  }
});
