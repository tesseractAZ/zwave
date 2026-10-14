/**
 * The shipped changelog stays small enough for Home Assistant to render, and
 * keeps the shape every reader of it depends on (v0.75.5).
 *
 * Home Assistant renders an add-on's whole CHANGELOG.md in one dialog whenever
 * the add-on is up to date. At 384 KB that dialog took a long time to open. The
 * shipped file now keeps the newest releases under a byte budget; older ones
 * live in docs/CHANGELOG-history.md, outside the add-on folder.
 *
 * Who reads the shipped file, and what each needs:
 * - Home Assistant's update dialog (core hassio/update.py) shows the notes
 *   from the new release down to the installed one when the newest heading is
 *   exactly "## X.Y.Z"; with any other text on that line it shows the whole file.
 * - release.yml rebuilds the file as a new title and section plus
 *   `tail -n +3`, so line 1 is the title and line 2 is blank.
 * - publish-release.yml takes a version's notes up to the next "## " heading,
 *   so a non-version "## " heading inside the window would cut them short.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Rotated { shipped: string; history: string; moved: string[] }
interface RotateModule {
  BUDGET: number;
  SHIPPED_PATH: string;
  HISTORY_PATH: string;
  HISTORY_URL: string;
  TITLE: string;
  POINTER_HEADING: string;
  POINTER: string;
  HISTORY_TITLE: string;
  rotate(shipped: string, history: string, budget?: number): Rotated;
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = resolve(REPO, '.github/scripts/rotate-changelog.mjs');
// A computed specifier: the script is plain JavaScript outside the typed tree.
const R = (await import(pathToFileURL(SCRIPT).href)) as RotateModule;
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');
const shipped = read(R.SHIPPED_PATH);
const history = read(R.HISTORY_PATH);
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const headings = (s: string): string[] => s.match(/^## .*$/gm) ?? [];
const versionOf = (h: string): string | null => /^## (\d+\.\d+\.\d+)\b/.exec(h)?.[1] ?? null;
const cmp = (a: string, b: string): number => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
/** Every release recorded when the history was split (v0.75.5), newest first.
 *  A count would stop guarding at the next release; a list does not. */
const KNOWN = `
  0.75.5 0.75.4 0.75.3 0.75.2 0.75.1 0.75.0 0.74.4 0.74.3 0.74.2 0.74.1 0.74.0 0.73.4 0.73.3 0.73.2
  0.73.1 0.73.0 0.72.1 0.72.0 0.71.0 0.70.0 0.69.0 0.68.1 0.68.0 0.67.0 0.66.1 0.66.0 0.65.0 0.64.7
  0.64.6 0.64.5 0.64.4 0.64.3 0.64.2 0.64.1 0.64.0 0.63.7 0.63.6 0.63.5 0.63.4 0.63.3 0.63.2 0.63.1
  0.63.0 0.62.0 0.61.0 0.60.0 0.59.0 0.58.0 0.57.0 0.56.1 0.56.0 0.55.0 0.54.0 0.53.0 0.52.0 0.51.0
  0.50.0 0.49.1 0.49.0 0.48.1 0.48.0 0.47.0 0.46.0 0.45.0 0.44.0 0.43.1 0.43.0 0.42.0 0.41.2 0.41.1
  0.41.0 0.40.2 0.40.1 0.40.0 0.39.0 0.38.2 0.38.1 0.38.0 0.37.3 0.37.2 0.37.1 0.37.0 0.36.5 0.36.4
  0.36.3 0.36.2 0.36.1 0.36.0 0.35.0 0.34.0 0.33.0 0.32.2 0.32.1 0.32.0 0.31.2 0.31.1 0.31.0 0.30.0
  0.29.5 0.29.4 0.29.3 0.29.2 0.29.1 0.29.0 0.28.0 0.27.0 0.26.1 0.26.0 0.25.1 0.25.0 0.24.4 0.24.3
  0.24.2 0.24.1 0.24.0 0.23.0 0.22.0 0.21.0 0.20.0 0.19.0 0.18.0 0.17.0 0.16.0 0.15.0 0.14.0 0.13.0
  0.12.0 0.11.0 0.10.0 0.9.0 0.8.0 0.7.0 0.6.0 0.5.0 0.4.1 0.4.0 0.3.0 0.2.1 0.2.0 0.1.0
`.trim().split(/\s+/);
/** The history from 0.72.0 down is frozen: rotation only ever adds above it.
 *  SHA-256 of that text pins every older release's body, not just its heading.
 *  A deliberate edit to an old entry updates this pin in the same change. */
const FROZEN_FROM = '## 0.72.0\n';
const FROZEN_SHA256 = '95d75f3058927ae3a736c8997e4587ba1f7cb20b1ab581689818cc5a2100f739';

test('the shipped changelog fits the budget Home Assistant renders quickly', () => {
  const versions = headings(shipped).filter((h) => versionOf(h));
  assert.ok(bytes(shipped) <= R.BUDGET || versions.length === 1,
    `${R.SHIPPED_PATH} is ${bytes(shipped)} bytes, over the ${R.BUDGET}-byte budget: run node .github/scripts/rotate-changelog.mjs`);
  assert.equal(R.BUDGET, 32 * 1024);
});

test('the files are already rotated — the release workflow and a hand-made release both leave them so', () => {
  const r = R.rotate(shipped, history);
  assert.equal(r.moved.length, 0, `run node .github/scripts/rotate-changelog.mjs (would move ${r.moved.join(', ')})`);
  assert.equal(r.shipped, shipped);
  assert.equal(r.history, history);
});

test('shape: the title, plain release headings, and the pointer last', () => {
  assert.ok(shipped.startsWith('# Changelog\n\n## '), 'line 1 the title, line 2 blank, line 3 the newest section (release.yml keeps two lines)');
  const hs = headings(shipped);
  assert.ok(hs.length >= 2);
  for (const h of hs.slice(0, -1)) {
    assert.match(h, /^## \d+\.\d+\.\d+$/, `"${h}": a release heading is exactly "## X.Y.Z" — any other text makes Home Assistant's update dialog show the whole file, and a non-version heading cuts a release's notes short`);
  }
  assert.equal(hs[hs.length - 1], R.POINTER_HEADING);
  assert.ok(shipped.endsWith(`\n\n${R.POINTER}`), 'the pointer is the last section, verbatim');
});

test('the pointer is an absolute link to a file that exists, outside the add-on folder', () => {
  assert.ok(R.POINTER.includes(`(${R.HISTORY_URL})`));
  assert.ok(R.HISTORY_URL.startsWith('https://github.com/tesseractAZ/zwave/blob/main/'));
  const path = R.HISTORY_URL.slice('https://github.com/tesseractAZ/zwave/blob/main/'.length);
  assert.equal(path, R.HISTORY_PATH);
  assert.ok(existsSync(resolve(REPO, path)), `${path} must exist in the repository`);
  assert.ok(!path.startsWith('zwave_tui/'), 'the history must not ship with the add-on');
  // Home Assistant renders the file in a dialog, where a relative link resolves
  // to nothing: inline, reference-style and HTML links alike.
  const targets = [
    ...[...shipped.matchAll(/\]\(([^)\s]*)[^)]*\)/g)].map((m) => m[1]),
    ...[...shipped.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm)].map((m) => m[1]),
    ...[...shipped.matchAll(/\b(?:href|src)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]),
  ];
  for (const t of targets) assert.match(t, /^(https?:|#)/, `relative link "${t}" in ${R.SHIPPED_PATH}`);
});

test('the newest section is the version Home Assistant runs', () => {
  const v = /^version:\s*"?([^"\s]+)"?/m.exec(read('zwave_tui/config.yaml'))?.[1];
  assert.equal(versionOf(headings(shipped)[0]), v, 'config.yaml\'s version needs its changelog section, newest first');
});

test('no release is lost or repeated: newest first across the shipped file and the history', () => {
  assert.ok(history.startsWith(R.HISTORY_TITLE.trimEnd()), `${R.HISTORY_PATH} keeps its title`);
  const all = [...headings(shipped), ...headings(history)].map(versionOf).filter((v): v is string => v != null);
  assert.equal(new Set(all).size, all.length, 'a release appears once');
  for (let i = 1; i < all.length; i++) assert.ok(cmp(all[i - 1], all[i]) > 0, `${all[i - 1]} then ${all[i]}: not newest first`);
  const have = new Set(all);
  assert.deepEqual(KNOWN.filter((v) => !have.has(v)), [], 'releases recorded at the split are still recorded');
  assert.deepEqual(headings(history).filter((h) => !versionOf(h)), [], 'the history holds only release headings');
});

test('the older history is byte-for-byte what it was at the split', () => {
  const at = history.indexOf(FROZEN_FROM);
  assert.ok(at > 0, `${R.HISTORY_PATH} still holds ${FROZEN_FROM.trim()}`);
  const sum = createHash('sha256').update(history.slice(at), 'utf8').digest('hex');
  assert.equal(sum, FROZEN_SHA256, 'an older release\'s text changed or went missing');
});

test('release.yml writes a plain heading and rotates after prepending', () => {
  const r = read('.github/workflows/release.yml').split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');
  const prepend = r.indexOf("printf '# Changelog\\n\\n## %s\\n\\n%s\\n\\n' \"$NEXT\" \"$body\"");
  assert.ok(prepend >= 0, 'release.yml prepends "## X.Y.Z" with nothing after the version');
  const demote = r.indexOf("body=$(sed -E 's/^## /### /' <<<\"$body\")");
  assert.ok(demote >= 0 && demote < prepend, 'and first demotes any "## " heading in its notes, which would split the release in two');
  const rotateAt = r.indexOf('node .github/scripts/rotate-changelog.mjs');
  assert.ok(rotateAt > prepend, 'and rotates after the prepend, so its release PR passes this test');
  assert.ok(rotateAt < r.indexOf('git add'), 'before staging');
});

// ── rotate() itself ──
const sec = (v: string, body: string): string => `## ${v}\n\n${body}\n\n`;
const file = (...s: string[]): string => R.TITLE + s.join('') + R.POINTER;

test('rotate moves the oldest sections first, newest first into the top of the history', () => {
  const big = 'x'.repeat(400);
  const r = R.rotate(file(sec('1.0.3', big), sec('1.0.2', big), sec('1.0.1', big)), R.HISTORY_TITLE + sec('1.0.0', 'old'), 1000);
  assert.deepEqual(r.moved, ['## 1.0.2', '## 1.0.1']);
  assert.equal(r.shipped, file(sec('1.0.3', big)));
  assert.equal(r.history, R.HISTORY_TITLE + sec('1.0.2', big) + sec('1.0.1', big) + '## 1.0.0\n\nold\n',
    'every moved release keeps its body, newest first, above the older history');
});

test('rotate refuses a pointer heading anywhere but last, rather than dropping its text', () => {
  const stray = R.TITLE + sec('1.0.1', 'a') + `${R.POINTER_HEADING}\n\nnotes someone wrote\n\n` + sec('1.0.0', 'b') + R.POINTER;
  assert.throws(() => R.rotate(stray, ''), /must appear once, last/);
  const reworded = R.TITLE + sec('1.0.0', 'a') + `${R.POINTER_HEADING}\n\nsee elsewhere\n`;
  assert.throws(() => R.rotate(reworded, ''), /must appear once, last/);
});

test('rotate keeps the newest release even when it alone is over the budget', () => {
  const r = R.rotate(file(sec('2.0.0', 'y'.repeat(5000)), sec('1.9.0', 'z')), '', 1000);
  assert.deepEqual(headings(r.shipped), ['## 2.0.0', R.POINTER_HEADING]);
  assert.deepEqual(r.moved, ['## 1.9.0']);
});

test('rotate counts bytes, not characters — an em dash is three', () => {
  const body = '—'.repeat(300); // 300 characters, 900 bytes
  const f = file(sec('1.0.1', body), sec('1.0.0', 'a'));
  const budget = bytes(f) - 1;
  assert.ok(f.length < budget, 'the file is under the budget in characters');
  assert.deepEqual(R.rotate(f, '', budget).moved, ['## 1.0.0'], 'and over it in bytes, so it rotates');
});

test('rotate is a fixed point, and adds the pointer to a file that lacks it', () => {
  const r1 = R.rotate(R.TITLE + sec('1.0.1', 'a') + sec('1.0.0', 'b'), '', 10_000);
  assert.ok(r1.shipped.endsWith(R.POINTER));
  const r2 = R.rotate(r1.shipped, r1.history, 10_000);
  assert.equal(r2.shipped, r1.shipped);
  assert.equal(r2.history, r1.history);
  assert.deepEqual(r2.moved, []);
});

test('rotate refuses a shipped file without the title release.yml keeps', () => {
  assert.throws(() => R.rotate(sec('1.0.0', 'a'), ''), /must start with "# Changelog"/);
});

// ── the command line, as release.yml and a maintainer run it ──
const runCli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const scratch = (): string => {
  const d = mkdtempSync(resolve(tmpdir(), 'zwtui-rotate-'));
  mkdirSync(resolve(d, 'zwave_tui'));
  mkdirSync(resolve(d, 'docs'));
  return d;
};

test('the CLI: --check passes a rotated pair and fails one that needs rotating; a plain run rotates it', () => {
  const d = scratch();
  try {
    cpSync(resolve(REPO, R.SHIPPED_PATH), resolve(d, R.SHIPPED_PATH));
    cpSync(resolve(REPO, R.HISTORY_PATH), resolve(d, R.HISTORY_PATH));
    assert.equal(runCli(d, '--check').status, 0);
    const grown = R.TITLE + sec('9.9.9', 'n'.repeat(R.BUDGET)) + readFileSync(resolve(d, R.SHIPPED_PATH), 'utf8').slice(R.TITLE.length);
    writeFileSync(resolve(d, R.SHIPPED_PATH), grown);
    const c = runCli(d, '--check');
    assert.equal(c.status, 1);
    assert.match(c.stderr, /needs rotating/);
    assert.equal(runCli(d).status, 0);
    const want = R.rotate(grown, history);
    assert.equal(readFileSync(resolve(d, R.SHIPPED_PATH), 'utf8'), want.shipped);
    assert.equal(readFileSync(resolve(d, R.HISTORY_PATH), 'utf8'), want.history);
    assert.equal(runCli(d, '--check').status, 0, 'and the result is rotated');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the CLI starts a missing history with its title', () => {
  const d = scratch();
  try {
    writeFileSync(resolve(d, R.SHIPPED_PATH), file(sec('1.0.1', 'm'.repeat(R.BUDGET)), sec('1.0.0', 'a')));
    assert.equal(runCli(d).status, 0);
    const h = readFileSync(resolve(d, R.HISTORY_PATH), 'utf8');
    assert.ok(h.startsWith(R.HISTORY_TITLE));
    assert.deepEqual(headings(h), ['## 1.0.0']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
