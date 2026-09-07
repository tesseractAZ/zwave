/**
 * The home-id tag: identity survives the gates, and NOTHING is ever deleted.
 *
 * Every test here is a defect an adversarial review found in the first design
 * of this feature. They are written as invariants rather than as unit coverage
 * of the helper, because the helper is trivial and the invariants are not: each
 * one is a path on which a plausible implementation destroys the data the
 * feature exists to keep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHomeTag, tagToWrite, archivePathFor, archiveLiveFile, latestArchiveFor } from '../src/zwave/homeTag';
import { createHistoryStore } from '../src/zwave/historyStore';
import { createBaselineStore } from '../src/zwave/baselines';
import { createOutcomeStore } from '../src/zwave/outcomes';
import { TuiSession } from '../src/telnet/session';
import { CONFIRM_WORD, buildMenu } from '../src/telnet/actionsCatalog';
import { renderActionsMenu } from '../src/telnet/screens/actionsMenu';
import type { ActionRunner, ControllerSnapshot, DataProvider, ViewState } from '../src/types';
import { mockData } from './_logHelpers';
import { buildStates, ENTITY_DEGRADED, ENTITY_ENGINE } from '../src/haStates';

const HOME_A = 3586281591;
const HOME_B = 111222333;

const dir = (): string => mkdtempSync(join(tmpdir(), 'zw-hometag-'));

// ─── readHomeTag: absent means UNKNOWN, never "foreign" ──────────────────────

test('readHomeTag: absent/garbage reads null — an untagged file is adopted, not archived', () => {
  // If any of these read as a number, the upgrade boot archives every existing
  // install's real data and starts them fresh.
  assert.equal(readHomeTag({ v: 1 }), null, 'pre-upgrade file (no homeId)');
  assert.equal(readHomeTag({ homeId: null }), null);
  assert.equal(readHomeTag({ homeId: '3586281591' }), null, 'string is not a tag');
  assert.equal(readHomeTag({ homeId: NaN }), null, 'NaN is not a tag');
  assert.equal(readHomeTag({ homeId: Infinity }), null);
  assert.equal(readHomeTag(null), null);
  assert.equal(readHomeTag('nope'), null);
  assert.equal(readHomeTag({ homeId: HOME_A }), HOME_A, 'positive control');
  assert.equal(readHomeTag({ homeId: 0 }), 0, '0 is a legal id, not absence');
});

test('tagToWrite: an unbound store carries the LOADED tag forward, never null over it', () => {
  // The pre-bind flush window is real (history flushes on a 120s timer). If a
  // save in that window stamps null, the tag erases itself — and by the
  // absent-means-adopt rule the next boot silently adopts a foreign file.
  assert.equal(tagToWrite(null, HOME_A), HOME_A, 'pre-bind save preserves the tag');
  assert.equal(tagToWrite(HOME_B, HOME_A), HOME_B, 'bound id wins once known');
  assert.equal(tagToWrite(null, null), null, 'genuinely fresh install');
  assert.equal(tagToWrite(0, HOME_A), 0, '0 must not fall through ?? to the loaded tag');
});

// ─── archive naming: an archive is never a rename target ─────────────────────

test('archivePathFor: never returns an existing path, so parking cannot clobber', () => {
  const taken = new Set(['/data/outcomes.home-1.json', '/data/outcomes.home-1.2.json']);
  const p = archivePathFor('/data/outcomes.json', 1, (x) => taken.has(x));
  assert.equal(p, '/data/outcomes.home-1.3.json');
  assert.ok(!taken.has(p!), 'the whole point: the target is free');
});

test('archivePathFor: a dot in a PARENT DIRECTORY is not an extension', () => {
  // Naive lastIndexOf('.') would emit "/data/v1.home-7.2/outcomes" — a path
  // into a directory that does not exist, so the rename throws and (before the
  // latch) the next flush would overwrite the file it failed to move.
  assert.equal(archivePathFor('/data/v1.2/outcomes', 7, () => false), '/data/v1.2/outcomes.home-7');
});

test('archivePathFor: returns null rather than inventing a 51st name', () => {
  assert.equal(archivePathFor('/data/o.json', 5, () => true), null);
});

// ─── archiveLiveFile: preserve, and report honestly when it cannot ───────────

test('archiveLiveFile: renames the live file aside and reports success', () => {
  const d = dir();
  const live = join(d, 'outcomes.json');
  writeFileSync(live, '{"v":1,"homeId":1}', 'utf8');
  const msgs: string[] = [];
  assert.equal(archiveLiveFile(live, HOME_A, (m) => msgs.push(m)), true);
  assert.ok(!existsSync(live), 'live file moved');
  assert.equal(readFileSync(join(d, `outcomes.home-${HOME_A}.json`), 'utf8'), '{"v":1,"homeId":1}');
  assert.match(msgs.join('\n'), /kept as/);
});

test('archiveLiveFile: no file to move is SUCCESS, not failure', () => {
  // A fresh install has nothing on disk. Returning false here would latch saves
  // off forever on the first boot and the add-on would never persist anything.
  assert.equal(archiveLiveFile(join(dir(), 'nope.json'), HOME_A, () => {}), true);
});

test('archiveLiveFile: a failed rename returns FALSE so the caller can latch saves off', () => {
  const msgs: string[] = [];
  const ok = archiveLiveFile('/data/outcomes.json', HOME_A, (m) => msgs.push(m), {
    exists: (p) => p === '/data/outcomes.json',
    rename: () => { throw new Error('EACCES'); },
  });
  assert.equal(ok, false);
  assert.match(msgs.join('\n'), /EACCES/);
  assert.match(msgs.join('\n'), /saves disabled/);
});

// ─── THE LINCHPIN: the tag is read past gates that reject the payload ────────

test('historyStore: an AGE-REJECTED file still yields its identity', () => {
  // This is the motivating scenario end to end: powered down, stick swapped,
  // powered back up more than an hour later. history's 1h age gate returns
  // before the payload is read. If the tag is read after that gate it is null,
  // bindHomeId finds no conflict, and the next flush overwrites home A's file.
  const d = dir();
  const path = join(d, 'history.json');
  writeFileSync(path, JSON.stringify({
    v: 2, savedAt: 1_000, homeId: HOME_A, nodes: { '3': { rssi: [-40], rtt: [], crssi: [], crtt: [] } },
  }), 'utf8');

  const msgs: string[] = [];
  const store = createHistoryStore({
    path,
    now: () => 1_000 + 5 * 60 * 60 * 1000, // 5h later ⇒ past the 1h gate
    uptimeMs: () => 99 * 60 * 60 * 1000, // long uptime ⇒ boot grace not in play
    log: Object.assign((m: string) => msgs.push(m), { error: (m: string) => msgs.push(m) }),
  });

  const loaded = store.load();
  assert.equal(loaded.size, 0, 'payload correctly rejected as stale');
  assert.match(msgs.join('\n'), /starting fresh/);

  // ...and yet the identity was still learned, so the swap IS detected:
  assert.equal(store.bindHomeId(HOME_B), true, 'conflict detected past the age gate');
  assert.deepEqual(store.pendingIdentity(), { previous: HOME_A, live: HOME_B, resumable: false });
  assert.ok(existsSync(path), 'NOTHING moved yet — the operator has not been asked');

  assert.equal(store.resolveIdentity('fresh'), true);
  assert.ok(existsSync(join(d, `history.home-${HOME_A}.json`)), 'home A parked, not lost');
  assert.ok(!existsSync(path), 'live path cleared for the new network');
  assert.equal(store.pendingIdentity(), null);
});

test('baselines: a SCHEMA-REJECTED file still yields its identity', () => {
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(path, JSON.stringify({ v: 99, savedAt: 1_000, homeId: HOME_A, nodes: {} }), 'utf8');
  const b = createBaselineStore({ path, now: () => 2_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  b.bindHomeId(HOME_B);
  assert.deepEqual(b.pendingIdentity(), { previous: HOME_A, live: HOME_B, resumable: false }, 'detected past the schema gate');
  assert.equal(b.resolveIdentity('fresh'), true);
  assert.ok(existsSync(join(d, `baselines.home-${HOME_A}.json`)), 'archived on the answer');
});

test('outcomes: a VERSION-REJECTED ledger still yields its identity', () => {
  // outcomes' guard is `if (!o || o.v !== 1) return;` — a SILENT return that
  // still logs the success-shaped "restored 0 kind(s)".
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(path, JSON.stringify({ v: 2, homeId: HOME_A, control: [] }), 'utf8');
  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_B);
  assert.deepEqual(o.pendingIdentity(), { previous: HOME_A, live: HOME_B, resumable: false }, 'detected past the version gate');
  assert.equal(o.resolveIdentity('fresh'), true);
  assert.ok(existsSync(join(d, `outcomes.home-${HOME_A}.json`)), 'archived on the answer');
});

// ─── the upgrade boot and the ordinary cases ─────────────────────────────────

test('an UNTAGGED file is adopted and stamped — the upgrade boot keeps its data', () => {
  // Every existing install has untagged files. Archiving them here would be a
  // data-preserving feature that starts by discarding everyone's live state.
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: 5_000, nodes: {} }), 'utf8');
  const b = createBaselineStore({ path, now: () => 6_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  b.bindHomeId(HOME_A);
  assert.equal(readdirSync(d).filter((f) => f.includes('home-')).length, 0, 'nothing archived');
  b.reset(); // marks dirty (v0.44.0) so save() actually writes
  b.save();
  assert.equal(readHomeTag(JSON.parse(readFileSync(path, 'utf8'))), HOME_A, 'now stamped');
});

test('rebinding the SAME id is a no-op — a reconnect must not archive anything', () => {
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: 5_000, homeId: HOME_A, nodes: {} }), 'utf8');
  const b = createBaselineStore({ path, now: () => 6_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  for (let i = 0; i < 5; i++) b.bindHomeId(HOME_A);
  assert.equal(readdirSync(d).filter((f) => f.includes('home-')).length, 0);
});

test('REPEATED swaps away from one controller keep every generation', () => {
  // The tempting design — one sidecar per home id — overwrites here, and the
  // second swap destroys the older, richer archive.
  const d = dir();
  const path = join(d, 'outcomes.json');
  for (const gen of ['first', 'second', 'third']) {
    writeFileSync(path, JSON.stringify({ v: 1, homeId: HOME_A, gen }), 'utf8');
    assert.equal(archiveLiveFile(path, HOME_A, () => {}), true);
  }
  const kept = readdirSync(d).filter((f) => f.startsWith('outcomes.home-')).sort();
  assert.equal(kept.length, 3, 'all three generations survive');
  const gens = kept.map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')).gen).sort();
  assert.deepEqual(gens, ['first', 'second', 'third']);
});

test('when the archive FAILS, memory is wiped but the disk is left intact', () => {
  // Both halves matter: the engine must stop reading another network's ledger,
  // AND the file that could not be moved must still be there afterwards.
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(path, JSON.stringify({
    v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 9, ok: 4, bad: 1 }]],
  }), 'utf8');
  const before = readFileSync(path, 'utf8');

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  // Fill the counter so no archive name is free — the real EACCES/ENOSPC shape.
  for (let n = 1; n <= 50; n++) {
    writeFileSync(join(d, n === 1 ? `outcomes.home-${HOME_A}.json` : `outcomes.home-${HOME_A}.${n}.json`), 'x', 'utf8');
  }
  o.bindHomeId(HOME_B);
  o.save(); // a routine flush must NOT overwrite what the archive could not move
  assert.equal(readFileSync(path, 'utf8'), before, 'home A ledger untouched on disk');
});

// ─── the operator is ASKED, and only their answer moves anything ─────────────

test('a mismatch DECIDES NOTHING until answered — file intact, engine safe', () => {
  const d = dir();
  const path = join(d, 'outcomes.json');
  const body = JSON.stringify({ v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 9, ok: 4, bad: 1 }]] });
  writeFileSync(path, body, 'utf8');

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_B);

  // Engine safety: the foreign ledger is out of memory immediately...
  assert.equal(o.controlArm('rtt-degraded'), null, 'foreign learning not serving advice');
  // ...but disk is untouched, and a routine flush must not change that.
  o.save();
  assert.equal(readFileSync(path, 'utf8'), body, 'byte-identical while pending');
  assert.equal(readdirSync(d).filter((f) => f.includes('home-')).length, 0, 'nothing archived yet');
});

test("'keep' re-adopts the old learning under the NEW identity (the NVM-restore case)", () => {
  // A restored NVM backup gives a new home id on a physically identical mesh.
  // The learning is not stale — it is exactly right — so 'keep' must return it
  // AND re-stamp, or the same question is asked on every single boot.
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(path, JSON.stringify({
    v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 9, ok: 4, bad: 1 }]],
  }), 'utf8');

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_B);
  assert.equal(o.resolveIdentity('keep'), true);
  assert.equal(o.pendingIdentity(), null);
  assert.ok(o.controlArm('rtt-degraded') != null, 'the old learning is back in service');
  assert.equal(readdirSync(d).filter((f) => f.includes('home-')).length, 0, 'nothing archived on keep');

  o.save();
  assert.equal(readHomeTag(JSON.parse(readFileSync(path, 'utf8'))), HOME_B, 're-stamped to the live id');

  // The decisive part: a RESTART must not re-ask.
  const again = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  again.load();
  again.bindHomeId(HOME_B);
  assert.equal(again.pendingIdentity(), null, 'answered once, not every boot');
});

test("a failed archive leaves the decision PENDING rather than reporting success", () => {
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: 5_000, homeId: HOME_A, nodes: {} }), 'utf8');
  const b = createBaselineStore({ path, now: () => 6_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  b.bindHomeId(HOME_B);
  for (let n = 1; n <= 50; n++) {
    writeFileSync(join(d, n === 1 ? `baselines.home-${HOME_A}.json` : `baselines.home-${HOME_A}.${n}.json`), 'x', 'utf8');
  }
  assert.equal(b.resolveIdentity('fresh'), false, 'refused, not silently "done"');
  assert.notEqual(b.pendingIdentity(), null, 'still pending — the operator can retry');
  assert.ok(existsSync(path), 'and the file it could not move is still there');
});

test('resolveIdentity with nothing pending is a no-op, not a spurious archive', () => {
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(path, JSON.stringify({ v: 1, savedAt: 5_000, homeId: HOME_A, nodes: {} }), 'utf8');
  const b = createBaselineStore({ path, now: () => 6_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  b.bindHomeId(HOME_A); // same id ⇒ no conflict
  assert.equal(b.resolveIdentity('fresh'), false);
  assert.equal(readdirSync(d).filter((f) => f.includes('home-')).length, 0);
});

// ─── the OPERATOR PATH: menu → CONFIRM → resolved ────────────────────────────
// Store-level tests prove the mechanism. This proves it is REACHABLE — the
// defect this project has shipped before is a correct, tested, mutation-proven
// feature that no keypress can get to (v0.33's dead `M` key).

test('the decision is reachable from the network menu and resolves through CONFIRM', () => {
  let pending: { previous: number; live: number } | null = { previous: HOME_A, live: HOME_B };
  const answered: Array<'fresh' | 'keep'> = [];
  // A real controller: the network menu lives on the Controller screen, which
  // will not open a menu while it has nothing to show.
  const ctrl: ControllerSnapshot = {
    homeId: HOME_B, nodeId: 1, sdkVersion: '7.19', firmwareVersion: '1.0', rfRegion: 'USA',
    isPrimary: true, isSUC: true, isSISPresent: true, manufacturer: 'Zooz', model: 'ZST39',
    isRebuildingRoutes: false, rebuildStartedAt: null, firmwareUpdatesAvailable: 0,
    backgroundRSSI: [],
    statistics: { messagesTX: 5, messagesRX: 5, messagesDroppedTX: 0, messagesDroppedRX: 0,
      NAK: 0, CAN: 0, timeoutACK: 0, timeoutResponse: 0, timeoutCallback: 0 },
  };
  const data = {
    ...mockData(),
    controller: () => ctrl,
    pendingIdentity: () => pending,
    resolveIdentityDecision: (c: 'fresh' | 'keep') => { answered.push(c); pending = null; return true; },
  } as DataProvider;

  let last = '';
  const strip = (x: string) => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  // READ-ONLY, in the shape production actually uses: the runner always exists
  // and carries `enabled: false` (index.ts builds it unconditionally). Passing
  // null instead would be a fixture that cannot open the menu at all, and the
  // test would then prove nothing about the read-only path it claims to cover.
  const deny = async () => ({ ok: false, message: 'write actions are disabled' });
  const runner = {
    enabled: false,
    ping: deny, probe: deny, refreshValues: deny, reInterview: deny, healNode: deny,
    rebuildAll: deny, stopRebuild: deny, removeFailed: deny, controlEntity: deny, setConfigParam: deny,
  } as unknown as ActionRunner;
  const s = new TuiSession({ write: (x: string) => { last = x; }, data, actions: runner, log: () => {}, width: 110, height: 34 });
  s.draw();

  // Network actions live on the Controller screen (3); the command bar there
  // reads [A] NETWORK ACTIONS — an UPPERCASE A.
  s.feed([{ type: 'char', ch: '3' }]); s.draw();
  s.feed([{ type: 'char', ch: 'A' }]); s.draw();
  // Scoped to the ROW LABEL, not /identity/i: the Controller screen has its own
  // "IDENTITY" section header, and matching that passed while the menu was
  // still closed — a green assertion proving nothing.
  assert.match(strip(last), /Mesh identity: KEEP/i, 'the pending decision is offered in the menu');

  // Navigate deterministically: ask the catalog where the row is rather than
  // hunting for it, so a menu-order change fails loudly instead of silently
  // arming some other action.
  const rows = buildMenu({ scope: 'network', hasNode: false, rebuilding: false, identityPending: true, identityResumable: true });
  const idx = rows.findIndex((r) => r.desc.kind === 'identityKeep');
  assert.ok(idx >= 0, 'identityKeep is in the network menu');
  for (let i = 0; i < idx; i++) s.feed([{ type: 'arrow', dir: 'down' }]);
  s.feed([{ type: 'enter' }]); s.draw();
  assert.match(strip(last), new RegExp(CONFIRM_WORD), 'the type-CONFIRM box is armed');



  for (const ch of CONFIRM_WORD) s.feed([{ type: 'char', ch }]);
  s.feed([{ type: 'enter' }]); s.draw();

  assert.equal(answered.length, 1, 'CONFIRM actually resolved it — not a dead row');
  assert.equal(pending, null);
});

test('read-only: the footer says SELECT on an identity row, LOCKED on a mesh action', () => {
  // A footer that reads "locked" over a row the operator can actually press is
  // the same defect class as a screen claiming all-clear while a detector is
  // starved — the label describing a rule the code below it does not apply.
  const rows = buildMenu({ scope: 'network', hasNode: false, rebuilding: false, identityPending: true, identityResumable: true });
  const idIdx = rows.findIndex((r) => r.desc.kind === 'identityKeep');
  const meshIdx = rows.findIndex((r) => r.desc.kind === 'rebuildAll');
  assert.ok(idIdx >= 0 && meshIdx >= 0);

  const strip = (x: string) => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const view = { cols: 110, rows: 34 } as ViewState;
  const render = (index: number) => strip(renderActionsMenu(view, {
    items: rows, index, targetLabel: 'whole mesh', locked: true, scope: 'network',
  } as never).join('\n'));

  const onIdentity = render(idIdx);
  assert.match(onIdentity, /⏎ select/, 'answerable in read-only');
  assert.doesNotMatch(onIdentity, /enable write_actions_enabled/, 'no false lock hint');

  const onMesh = render(meshIdx);
  assert.match(onMesh, /⏎ locked/, 'a real mesh action stays locked');
  assert.match(onMesh, /enable write_actions_enabled/, 'and still says why');
});

test('a held decision reaches HOME ASSISTANT, not just the console', () => {
  // The console is not where an operator is at 3am. If the held decision does
  // not raise `degraded`, the only notice of a mesh that has stopped learning
  // is a telnet screen nobody has open — and unlike every other engine state
  // here, this one never clears itself.
  const base = { ...mockData(), pendingIdentity: () => null } as DataProvider;
  const clear = buildStates(base);
  assert.equal(clear.find((x) => x.entity === ENTITY_DEGRADED)?.state, 'off');

  const held = buildStates({
    ...base, pendingIdentity: () => ({ previous: HOME_A, live: HOME_B }),
  } as DataProvider);
  const deg = held.find((x) => x.entity === ENTITY_DEGRADED);
  assert.equal(deg?.state, 'on', 'a held decision is degraded');
  assert.match(String(deg?.attrs.reason), /mesh identity changed/i);
  assert.match(String(deg?.attrs.reason), new RegExp(`${HOME_A}.*${HOME_B}`), 'names both ids');

  const eng = held.find((x) => x.entity === ENTITY_ENGINE);
  assert.equal(eng?.state, 'awaiting-identity-decision', 'and says so in one word');
});

test('a SECOND swap archives under the id the file actually belonged to', () => {
  // Why the re-stamp in resolveIdentity is load-bearing rather than tidy:
  // `tagToWrite` already prefers the bound id, so the SAVE path looks identical
  // without it. What differs is the NEXT swap. Without the re-stamp
  // `loadedHomeId` still holds A after keeping under B, so a later move to C
  // parks the file as `home-A` — a mislabelled archive of B's learning, which
  // is worse than no archive because it reads as authoritative.
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(path, JSON.stringify({
    v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 9, ok: 4, bad: 1 }]],
  }), 'utf8');
  const HOME_C = 999888777;

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_B);
  assert.equal(o.resolveIdentity('keep'), true, 'kept under B');
  o.save();

  o.bindHomeId(HOME_C);
  assert.deepEqual(o.pendingIdentity(), { previous: HOME_B, live: HOME_C, resumable: false }, 'previous is B, not A');
  assert.equal(o.resolveIdentity('fresh'), true);
  assert.ok(existsSync(join(d, `outcomes.home-${HOME_B}.json`)), 'archived as B — whose learning it was');
  assert.ok(!existsSync(join(d, `outcomes.home-${HOME_A}.json`)), 'NOT mislabelled as A');
});

test('OUTCOMES: a failed archive leaves the ledger pending and on disk', () => {
  // The baselines version of this test passed while the outcomes path was
  // unprotected — same invariant, different store, and the ledger is the one
  // holding months of learning. A mutant survived in exactly that gap.
  const d = dir();
  const path = join(d, 'outcomes.json');
  const body = JSON.stringify({ v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 9, ok: 4, bad: 1 }]] });
  writeFileSync(path, body, 'utf8');

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_B);
  for (let n = 1; n <= 50; n++) {
    writeFileSync(join(d, n === 1 ? `outcomes.home-${HOME_A}.json` : `outcomes.home-${HOME_A}.${n}.json`), 'x', 'utf8');
  }
  assert.equal(o.resolveIdentity('fresh'), false, 'refused, not silently "done"');
  assert.notEqual(o.pendingIdentity(), null, 'still pending — the operator can retry');
  o.save();
  assert.equal(readFileSync(path, 'utf8'), body, 'and the ledger it could not move is untouched');
});

// ─── the RETURNING stick ─────────────────────────────────────────────────────

test('a returning stick is offered its OWN archived learning', () => {
  // The full round trip: learn on A, swap to B and start fresh (A is archived),
  // learn on B, then swap back to A. Both other answers are wrong here — `keep`
  // adopts B's learning about different hardware, `fresh` begins from zero while
  // A's own months of learning sit in the same directory.
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(path, JSON.stringify({
    v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 40, ok: 30, bad: 2 }]],
  }), 'utf8');
  const log = Object.assign(() => {}, { error: () => {} });

  // A → B, start fresh: A is parked.
  const onB = createOutcomeStore({ path, log });
  onB.load();
  onB.bindHomeId(HOME_B);
  assert.equal(onB.resolveIdentity('fresh'), true);
  assert.ok(existsSync(join(d, `outcomes.home-${HOME_A}.json`)), 'A archived');

  // B learns something of its own and saves it.
  onB.loadJSON({ v: 1, control: [['rtt-degraded', { n: 3, ok: 1, bad: 0 }]] });
  onB.reset();
  onB.save();

  // B → A: the decision must fire AND advertise that A is resumable.
  const back = createOutcomeStore({ path, log });
  back.load();
  back.bindHomeId(HOME_A);
  const pend = back.pendingIdentity();
  assert.ok(pend, 'a returning stick raises the decision');
  assert.equal(pend!.live, HOME_A);
  assert.equal(pend!.resumable, true, 'and says its own learning is available');

  assert.equal(back.resolveIdentity('resume'), true);
  const arm = back.controlArm('rtt-degraded');
  assert.ok(arm && arm.n > 30, `A's own learning is back in service (n=${arm?.n})`);
  assert.equal(back.pendingIdentity(), null);
});

test('a returning stick is offered RESUME even with nothing live to conflict with', () => {
  // The case a conflict-only test cannot see: swap A→B, never save on B, swap
  // back to A. `loadedHomeId` is null, so there is no tag to disagree with —
  // and A's archive would never be mentioned.
  const d = dir();
  const path = join(d, 'baselines.json');
  writeFileSync(join(d, `baselines.home-${HOME_A}.json`),
    JSON.stringify({ v: 1, savedAt: 5_000, homeId: HOME_A, nodes: {} }), 'utf8');
  assert.ok(!existsSync(path), 'nothing live at all');

  const b = createBaselineStore({ path, now: () => 6_000, uptimeMs: () => 9e9, log: () => {} });
  b.load();
  b.bindHomeId(HOME_A);
  const pend = b.pendingIdentity();
  assert.ok(pend, 'the decision fires with no live file');
  assert.equal(pend!.previous, null, 'there was nothing live — honestly reported as null');
  assert.equal(pend!.resumable, true);
});

test('resume takes the NEWEST generation, not the oldest', () => {
  // archivePathFor always takes the first free name, so `.2` was written after
  // `.1`. Picking the lowest would hand a returning controller its stalest
  // learning while the newer generation sat unused beside it.
  const d = dir();
  const path = join(d, 'outcomes.json');
  writeFileSync(join(d, `outcomes.home-${HOME_A}.json`),
    JSON.stringify({ v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 5, ok: 1, bad: 0 }]] }), 'utf8');
  writeFileSync(join(d, `outcomes.home-${HOME_A}.2.json`),
    JSON.stringify({ v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 50, ok: 40, bad: 1 }]] }), 'utf8');
  assert.equal(latestArchiveFor(path, HOME_A), join(d, `outcomes.home-${HOME_A}.2.json`));

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_A);
  assert.equal(o.resolveIdentity('resume'), true);
  assert.equal(o.controlArm('rtt-degraded')?.n, 50, 'the newer generation');
});

test('resume PARKS what is live before restoring — nothing is traded away', () => {
  const d = dir();
  const path = join(d, 'outcomes.json');
  const bBody = JSON.stringify({ v: 1, homeId: HOME_B, control: [['rtt-degraded', { n: 3, ok: 1, bad: 0 }]] });
  writeFileSync(path, bBody, 'utf8');
  writeFileSync(join(d, `outcomes.home-${HOME_A}.json`),
    JSON.stringify({ v: 1, homeId: HOME_A, control: [['rtt-degraded', { n: 50, ok: 40, bad: 1 }]] }), 'utf8');

  const o = createOutcomeStore({ path, log: Object.assign(() => {}, { error: () => {} }) });
  o.load();
  o.bindHomeId(HOME_A);
  assert.equal(o.resolveIdentity('resume'), true);
  assert.equal(o.controlArm('rtt-degraded')?.n, 50, "A's learning is live");
  assert.equal(readFileSync(join(d, `outcomes.home-${HOME_B}.json`), 'utf8'), bBody, "B's is parked, not lost");
});

test('RESUME is offered only when this controller actually has an archive', () => {
  const withArchive = buildMenu({ scope: 'network', hasNode: false, rebuilding: false, identityPending: true, identityResumable: true })
    .map((i) => i.desc.kind);
  assert.ok(withArchive.includes('identityResume'), 'offered when resumable');

  const without = buildMenu({ scope: 'network', hasNode: false, rebuilding: false, identityPending: true, identityResumable: false })
    .map((i) => i.desc.kind);
  assert.ok(!without.includes('identityResume'), 'a row that could only fail is not shown');
  assert.ok(without.includes('identityFresh') && without.includes('identityKeep'), 'the other two still are');
});
