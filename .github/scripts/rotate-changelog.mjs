#!/usr/bin/env node
// Keep the shipped changelog small enough for Home Assistant to render.
//
// Home Assistant shows an add-on's whole zwave_tui/CHANGELOG.md in one dialog
// whenever the add-on is up to date: one blocking markdown render, with nothing
// on screen until it finishes. At 384 KB and 140 releases that took a long time
// on slower devices. So the shipped file keeps only the newest releases, under
// BUDGET bytes, and ends with a pointer to docs/CHANGELOG-history.md, which is
// outside the add-on folder and so is never shipped. This script moves the
// oldest release sections into the history until the shipped file fits.
//
// The release workflow runs it after prepending a new section; the changelog
// contract test fails CI when the files are not already rotated.
//
// Usage (from the repository root):
//   node .github/scripts/rotate-changelog.mjs           rotate in place
//   node .github/scripts/rotate-changelog.mjs --check   exit 1 if a rotation is due
import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** UTF-8 bytes the shipped file may hold (title, kept sections and pointer). */
export const BUDGET = 32 * 1024;
export const SHIPPED_PATH = 'zwave_tui/CHANGELOG.md';
export const HISTORY_PATH = 'docs/CHANGELOG-history.md';
export const HISTORY_URL = `https://github.com/tesseractAZ/zwave/blob/main/${HISTORY_PATH}`;
export const TITLE = '# Changelog\n\n';
export const POINTER_HEADING = '## Older releases';
// A "## " heading, so the publish workflow's notes extraction stops before it;
// last in the file, so release.yml's prepend never carries it into a new
// section; an absolute URL, because Home Assistant renders the file in a dialog
// where a relative link resolves to nothing.
export const POINTER = `${POINTER_HEADING}\n\nEarlier releases are in the full changelog history on GitHub:\n[${HISTORY_PATH}](${HISTORY_URL})\n`;
export const HISTORY_TITLE = '# Changelog history\n\nReleases older than the ones in zwave_tui/CHANGELOG.md, newest first. The\nshipped changelog keeps only the newest releases so Home Assistant can render it.\n\n';

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** A file's text before its first "## " heading, and its "## " sections in order. */
export function splitSections(text) {
  const at = text.search(/^## /m);
  if (at < 0) return { head: text, sections: [] };
  const sections = text.slice(at).split(/^(?=## )/m).map((s) => s.replace(/\n*$/, '\n\n'));
  return { head: text.slice(0, at), sections };
}

/**
 * Move the oldest release sections of `shipped` to the top of `history` until
 * `shipped` fits `budget` bytes. The newest section always stays, so a single
 * release larger than the budget is shipped whole. Returns both files and the
 * headings moved (newest first). Rotating an already-rotated pair changes nothing.
 */
export function rotate(shipped, history, budget = BUDGET) {
  const s = splitSections(shipped);
  if (s.head !== TITLE) throw new Error(`${SHIPPED_PATH} must start with "# Changelog" and a blank line`);
  // The pointer counts only as the verbatim last section. A "## Older releases"
  // heading anywhere else, or reworded, is refused — never silently dropped
  // with whatever text sits under it.
  const last = s.sections[s.sections.length - 1];
  const hasPointer = last != null && last.replace(/\n+$/, '\n') === POINTER;
  const versions = hasPointer ? s.sections.slice(0, -1) : s.sections.slice();
  if (versions.some((x) => /^## Older releases\b/.test(x))) {
    throw new Error(`"${POINTER_HEADING}" must appear once, last in ${SHIPPED_PATH}, exactly as the rotation script writes it`);
  }
  const size = (vs) => bytes(TITLE + vs.join('') + POINTER);
  const moved = [];
  while (versions.length > 1 && size(versions) > budget) moved.unshift(versions.pop());
  const h = splitSections(history || HISTORY_TITLE);
  // A history holding only its title was trimmed to one newline when written:
  // the first release moved under it needs the blank line back.
  const head = h.sections.length || moved.length ? h.head.replace(/\n*$/, '\n\n') : h.head;
  return {
    shipped: (TITLE + versions.join('') + POINTER),
    history: (head + moved.join('') + h.sections.join('')).replace(/\n+$/, '\n'),
    moved: moved.map((x) => x.slice(0, x.indexOf('\n'))),
  };
}

// Run only as the entry point, never on import (the tests import rotate()).
// import.meta.url is the real path; argv[1] may run through a symlink.
let isMain = false;
try {
  isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
} catch { /* argv[1] is not a file: imported, not run */ }
if (isMain) {
  const check = process.argv.includes('--check');
  const shipped = readFileSync(SHIPPED_PATH, 'utf8');
  let history = '';
  try {
    history = readFileSync(HISTORY_PATH, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const r = rotate(shipped, history);
  const changed = r.shipped !== shipped || r.history !== history;
  if (check) {
    if (changed) {
      console.error(`${SHIPPED_PATH} needs rotating: run node .github/scripts/rotate-changelog.mjs`);
      process.exit(1);
    }
  } else if (changed) {
    // History first, each through a rename: a failure part-way leaves a moved
    // release in both files (the contract test reports a repeat), never in neither.
    const put = (path, text) => {
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    };
    put(HISTORY_PATH, r.history);
    put(SHIPPED_PATH, r.shipped);
  }
  console.log(`${SHIPPED_PATH}: ${bytes(r.shipped)} bytes (budget ${BUDGET}); moved ${r.moved.length} section(s)${r.moved.length ? `: ${r.moved.join(', ')}` : ''}`);
}
