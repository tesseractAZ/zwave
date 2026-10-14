/**
 * The CodeQL gate judges the whole codebase on a pull request (v0.76.0).
 *
 * codeql-action v4 makes PR analyses "diff-informed" by default: a result is
 * kept only when its source or sink sits on a changed line, so a PR could pass
 * the gate while main's full scan found the same flaw. codeql.yml turns the
 * mode off, and check-sarif.mjs refuses a SARIF that is still marked with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = resolve(REPO, '.github/scripts/check-sarif.mjs');

const runGate = (sarif: unknown) => {
  const d = mkdtempSync(resolve(tmpdir(), 'zwtui-sarif-'));
  try {
    const p = resolve(d, 'javascript.sarif');
    writeFileSync(p, JSON.stringify(sarif));
    return spawnSync(process.execPath, [GATE, p], { encoding: 'utf8' });
  } finally { rmSync(d, { recursive: true, force: true }); }
};
const run = (properties?: Record<string, unknown>) => ({ tool: { driver: { name: 'CodeQL', rules: [] } }, results: [], ...(properties ? { properties } : {}) });

test('codeql.yml turns diff-informed PR analysis off on the analyze job', () => {
  const yml = readFileSync(resolve(REPO, '.github/workflows/codeql.yml'), 'utf8');
  assert.match(yml, /\n {4}env:\n {6}CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'\n {4}steps:/,
    'a job-level env, exactly "false", ahead of the steps that run init');
});

test('check-sarif refuses a diff-informed SARIF and passes a full or overlay one', () => {
  assert.equal(runGate({ runs: [run()] }).status, 0, 'a full analysis with no findings passes');
  assert.equal(runGate({ runs: [run({ incrementalMode: 'overlay' })] }).status, 0, 'overlay is an incremental build, not a filter');
  for (const mode of ['diff-informed', 'diff-informed,overlay', 'overlay,diff-informed']) {
    const r = runGate({ runs: [run({ incrementalMode: mode })] });
    assert.equal(r.status, 2, `${mode} must be refused`);
    assert.match(r.stderr, /diff-informed analysis/);
  }
});
