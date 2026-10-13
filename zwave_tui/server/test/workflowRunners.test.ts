/**
 * Every job runs on a PINNED runner image, never a moving `-latest` label (v0.75.3).
 *
 * Every job moved to Ubuntu 26.04 in one commit; CodeQL stays on 24.04 (below).
 *
 * `ubuntu-latest` moves to Ubuntu 26.04 in a rollout from 2026-10-19 to 2026-11-19
 * (actions/runner-images#14748). That one move changes python3 and Docker under every
 * job at once, the docs job's apt installs (pandoc and LibreOffice come from the newer
 * archive) and the AppArmor job's apparmor_parser; and during a rollout, jobs of one run
 * can land on different images. So the image moves deliberately, in one commit, like an
 * action pin: any `ubuntu-YY.MM[-arm]` label passes the pin check, and the move is a
 * label change that this file then holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows');
const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
const PINNED = /^ubuntu-\d{2}\.\d{2}(?:-arm)?$/;
const INDIRECT = '${{ matrix.runner }}';

interface Label { file: string; line: number; key: string; value: string }

/** Every `runs-on:` value, and every matrix `runner:` value a `runs-on: ${{ matrix.runner }}` reads. */
function labels(): Label[] {
  const out: Label[] = [];
  for (const file of FILES) {
    readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/).forEach((l, i) => {
      const m = /^\s*(?:-\s+)?(runs-on|runner):\s*(.*?)(?:\s+#.*)?\s*$/.exec(l);
      if (m) out.push({ file, line: i + 1, key: m[1], value: m[2].replace(/^(['"])(.*)\1$/, '$2') });
    });
  }
  return out;
}

test('each job has its own runs-on line, and the reader finds it (a reformat it cannot follow fails here)', () => {
  assert.ok(FILES.length >= 5, `found ${FILES.length} workflows in ${DIR}`);
  for (const file of FILES) {
    const lines = readFileSync(resolve(DIR, file), 'utf8').split(/\r?\n/);
    const start = lines.indexOf('jobs:');
    assert.ok(start >= 0, `${file}: no jobs: block`);
    const jobs = lines.slice(start + 1).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)).length;
    const runsOn = labels().filter((l) => l.file === file && l.key === 'runs-on').length;
    assert.ok(jobs > 0 && runsOn === jobs, `${file}: ${jobs} jobs but ${runsOn} runs-on lines`);
  }
});

test('every runner is a pinned image (ubuntu-YY.MM[-arm]), never a moving -latest label or an expression', () => {
  const all = labels();
  const bad = all.filter((l) => {
    if (PINNED.test(l.value)) return false;
    // `runs-on: ${{ matrix.runner }}` is pinned through its matrix's `runner:` values, checked here too.
    return !(l.key === 'runs-on' && l.value === INDIRECT && all.some((r) => r.file === l.file && r.key === 'runner'));
  });
  assert.deepEqual(bad.map((l) => `${l.file}:${l.line} ${l.key}: ${l.value}`), []);
});

// CodeQL's system requirements (codeql.github.com/docs/codeql-overview/system-requirements)
// list Ubuntu 22.04 and 24.04 on 2026-10-12. codeql.yml is the repository's only CodeQL
// analysis and a required check, so it stays on a listed image while the other workflows
// move on; extend this set in the same commit that moves it, once CodeQL lists 26.04.
const CODEQL_SUPPORTED = new Set(['ubuntu-22.04', 'ubuntu-24.04']);

test('CodeQL runs on an image CodeQL supports; every other job is on Ubuntu 26.04 (native ARM on -arm)', () => {
  const all = labels();
  const codeql = all.filter((l) => l.file === 'codeql.yml' && l.key === 'runs-on');
  assert.ok(codeql.length > 0, 'codeql.yml has a runs-on line');
  assert.deepEqual(codeql.filter((l) => !CODEQL_SUPPORTED.has(l.value)).map((l) => `${l.line} ${l.value}`), []);
  const rest = all.filter((l) => l.file !== 'codeql.yml' && PINNED.test(l.value));
  assert.ok(rest.length >= 11, `${rest.length} pinned labels outside codeql.yml`);
  assert.deepEqual(rest.filter((l) => !/^ubuntu-26\.04(?:-arm)?$/.test(l.value)).map((l) => `${l.file}:${l.line} ${l.value}`), []);
  // Both image builds run natively: each arch's runner matches its platform.
  for (const file of ['ci.yml', 'publish-release.yml']) {
    const txt = readFileSync(resolve(DIR, file), 'utf8');
    assert.match(txt, /arch: aarch64[\s\S]{0,120}?runner: ubuntu-26\.04-arm/, `${file}: aarch64 builds on the native ARM runner`);
    assert.match(txt, /arch: amd64[\s\S]{0,120}?runner: ubuntu-26\.04\b(?!-arm)/, `${file}: amd64 on the x86 runner`);
  }
});
