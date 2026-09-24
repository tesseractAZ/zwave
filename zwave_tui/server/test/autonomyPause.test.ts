/**
 * The one pause for every autonomous write (v0.72.0). Every way it can be
 * unsure, it must read as paused — the tests below are the list of those ways.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutonomyPause, PAUSE_ESCALATE_MS, type PauseState } from '../src/zwave/autonomyPause';

function rig(file?: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'pause-'));
  const path = file === null ? null : join(dir, 'autonomy.json');
  if (path && file) writeFileSync(path, file, 'utf8');
  const lines: string[] = [];
  const warns: string[] = [];
  const log = Object.assign((m: string) => { lines.push(m); }, { warn: (m: string) => { warns.push(m); }, error: (m: string) => { lines.push('ERR ' + m); } });
  let t = 1_700_000_000_000;
  const changes: (PauseState | null)[] = [];
  const mk = () => createAutonomyPause({ path, log, now: () => t, onChange: (s) => changes.push(s) });
  return { path, lines, warns, changes, mk, tick: (ms: number) => { t += ms; }, now: () => t };
}

test('a missing file means running', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  assert.equal(p.state(), null);
  assert.equal(r.warns.length, 0);
});

test('a corrupt, unknown-version or wrong-shape file reads as PAUSED, with a WARN (fail closed)', () => {
  for (const body of ['{not json', JSON.stringify({ v: 2, tui: null }), JSON.stringify({ v: 1, tui: 'yes' }),
    JSON.stringify({ v: 1, tui: null, ha: { last: 5 } }), 'null']) {
    const r = rig(body);
    const p = r.mk();
    p.load();
    assert.deepEqual(p.state()?.by, ['tui'], body);
    assert.match(p.state()!.reason, /unreadable/);
    assert.ok(r.warns.some((w) => /paused until resumed/.test(w)), body);
  }
});

test('a TUI pause persists across a restart, and a resume persists too', () => {
  const r = rig();
  const a = r.mk();
  a.load();
  const s = a.pauseTui();
  assert.deepEqual(s.by, ['tui']);
  assert.equal(s.since, r.now());
  r.tick(60_000);
  assert.equal(a.pauseTui().since, s.since, 'idempotent: the original since is kept');
  const b = r.mk();
  b.load();
  assert.deepEqual(b.state()?.by, ['tui'], 'a reload stays paused');
  assert.equal(b.state()?.since, s.since);
  assert.deepEqual(b.resumeTui(), { resumed: true, stillPausedBy: null });
  const c = r.mk();
  c.load();
  assert.equal(c.state(), null, 'the resume was written');
  assert.deepEqual(c.resumeTui(), { resumed: false, stillPausedBy: null });
});

test('the HA toggle: on pauses, off clears, never-seen has no effect, gone is forgotten', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  assert.equal(p.state(), null, 'never seen');
  p.noteHa('on', r.now() - 5_000);
  assert.deepEqual(p.state()?.by, ['ha']);
  assert.equal(p.state()?.since, r.now(), 'aged from when THIS add-on first saw it pausing, not last_changed');
  p.noteHa('off', r.now());
  assert.equal(p.state(), null);
  p.noteHa('unavailable', r.now());
  assert.deepEqual(p.state()?.by, ['ha'], 'seen, then unavailable → paused');
  assert.match(p.state()!.reason, /unavailable/);
  p.noteHa(null, r.now());
  assert.equal(p.state(), null, 'the entity is gone → forgotten');
  assert.equal(JSON.parse(readFileSync(r.path!, 'utf8')).ha, null);
});

test('HA off never lifts the TUI source, and a TUI resume never lifts HA; the union reports both', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  p.pauseTui();
  r.tick(1000);
  p.noteHa('on', r.now());
  assert.deepEqual(p.state()?.by, ['tui', 'ha']);
  assert.equal(p.state()?.since, r.now() - 1000, 'the OLDEST source dates the pause');
  p.noteHa('off', r.now());
  assert.deepEqual(p.state()?.by, ['tui']);
  p.noteHa('on', r.now());
  assert.deepEqual(p.resumeTui(), { resumed: true, stillPausedBy: 'ha' });
  assert.deepEqual(p.state()?.by, ['ha']);
});

test('a toggle last seen ON is paused after a restart until this run reads it; last seen OFF is not', () => {
  const r = rig();
  const a = r.mk();
  a.load();
  a.noteHa('on', r.now());
  const b = r.mk();
  b.load();
  assert.deepEqual(b.state()?.by, ['ha'], 'the state feed has not started: still paused');
  assert.match(b.state()!.reason, /not read yet/);
  b.noteHa('off', r.now());
  assert.equal(b.state(), null);
  const c = r.mk();
  c.load();
  assert.equal(c.state(), null, 'last seen off');
});

test('onChange fires once per transition, and every transition WARNs once', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  p.pauseTui();
  p.pauseTui();
  p.noteHa('on', r.now());
  p.noteHa('on', r.now());
  p.resumeTui();
  p.noteHa('off', r.now());
  p.noteHa('off', r.now());
  assert.deepEqual(r.changes.map((s) => s?.by.join('+') ?? 'running'), ['tui', 'tui+ha', 'ha', 'running']);
  assert.equal(r.warns.length, 4);
  assert.match(r.warns[0], /PAUSED by tui/);
  assert.match(r.warns[3], /RESUMED/);
});

test('a pause escalates only after PAUSE_ESCALATE_MS (v0.72.0)', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  assert.equal(p.overdue(r.now()), false, 'running is never overdue');
  p.pauseTui();
  assert.equal(p.overdue(r.now() + PAUSE_ESCALATE_MS - 1), false);
  assert.equal(p.overdue(r.now() + PAUSE_ESCALATE_MS), true);
});

test('a failed save still pauses in memory, and says so at ERROR', () => {
  const r = rig();
  const p = createAutonomyPause({ path: '/nonexistent-dir/x/autonomy.json', log: Object.assign((m: string) => { r.lines.push(m); }, { error: (m: string) => { r.lines.push('ERR ' + m); } }) });
  p.load();
  assert.deepEqual(p.pauseTui().by, ['tui']);
  assert.ok(r.lines.some((l) => l.startsWith('ERR autonomy: pause file save failed')));
});

test('the HA pause keeps its age through HA restarts, blips and add-on restarts — the 24 h alarm cannot be put off (v0.72.0 review)', () => {
  const r = rig();
  const a = r.mk();
  a.load();
  a.noteHa('on', r.now());
  const since = r.now();
  r.tick(23 * 3_600_000);
  a.noteHa('on', r.now(), { source: 'full' });          // HA Core restarted: a restored `on` with a fresh last_changed
  a.noteHa('unavailable', r.now() + 1);                  // a blip…
  a.noteHa('on', r.now() + 2);                           // …and back
  assert.equal(a.state()?.since, since, 'still the first sighting');
  const b = r.mk();
  b.load();
  b.noteHa('on', r.now() + 3);
  assert.equal(b.state()?.since, since, 'and across an add-on restart');
  r.tick(3_600_000);
  assert.equal(b.overdue(r.now()), true, '24 h after it began, however often HA restamped it');
  b.noteHa('off', r.now());
  b.noteHa('on', r.now() + 1);
  assert.equal(b.state()?.since, r.now(), 'off then on is a new pause');
});

test('a reading older than the one applied is ignored — a snapshot cannot undo a newer event (v0.72.0 review)', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  p.noteHa('on', r.now(), { source: 'event' });
  p.noteHa('off', r.now() - 60_000, { source: 'full' });
  assert.deepEqual(p.state()?.by, ['ha'], 'the stale `off` from the snapshot does not unpause');
});

test('a toggle missing from a full read stays paused if last seen pausing; only a deletion event forgets it (v0.72.0 review)', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  p.noteHa('on', r.now());
  p.noteHa(null, r.now(), { source: 'full' });
  assert.deepEqual(p.state()?.by, ['ha'], 'HA lists input_boolean late at startup — absence is not deletion');
  assert.match(p.state()!.reason, /missing from Home Assistant's states/);
  p.noteHa(null, r.now(), { source: 'event' });
  assert.equal(p.state(), null, 'a state_changed to nothing is a deletion');
  const q = r.mk();
  q.load();
  q.noteHa('off', r.now());
  q.noteHa(null, r.now(), { source: 'full' });
  assert.equal(q.state(), null, 'last seen off: absence changes nothing');
});

test('an unreadable pause file is rewritten valid, so the pause keeps its age across restarts (v0.72.0 review)', () => {
  const r = rig('{not json');
  const a = r.mk();
  a.load();
  const since = a.state()!.since;
  assert.deepEqual(JSON.parse(readFileSync(r.path!, 'utf8')).tui, { since });
  r.tick(3_600_000);
  const b = r.mk();
  b.load();
  assert.equal(b.state()?.since, since);
});

test('a MISSING toggle is named as such, and a TUI resume forgets it — there is no toggle left to turn off (second review)', () => {
  const r = rig();
  const p = r.mk();
  p.load();
  p.noteHa('on', r.now());
  p.noteHa(null, r.now(), { source: 'full' });
  assert.equal(p.state()?.haMissing, true);
  assert.deepEqual(p.resumeTui(), { resumed: true, stillPausedBy: null });
  assert.equal(p.state(), null);
  assert.equal(JSON.parse(readFileSync(r.path!, 'utf8')).ha, null, 'forgotten on disk too');
  const q = r.mk();
  q.load();
  q.noteHa('on', r.now());
  assert.equal(q.state()?.haMissing, undefined, 'a present toggle is not "missing"');
  assert.deepEqual(q.resumeTui(), { resumed: false, stillPausedBy: 'ha' }, 'and a TUI resume does not lift it');
});

test('only a full state list can be stale; a live event is never dropped; order is per connection (second and third review)', () => {
  const r = rig();
  const a = r.mk();
  a.load();
  a.noteHa('off', r.now() + 3_600_000, { source: 'event' }); // an event stamped an hour AHEAD (HA's clock)
  a.noteHa('on', r.now(), { source: 'event' });               // the owner turns the pause on
  assert.deepEqual(a.state()?.by, ['ha'], 'a live event is applied whatever its stamp');
  a.noteHa('off', r.now() - 60_000, { source: 'full' });      // a snapshot older than that event
  assert.deepEqual(a.state()?.by, ['ha'], 'the stale state list does not undo it…');
  assert.ok(r.warns.some((w) => /ignored a state-list reading/.test(w)), '…and says so');
  a.newConnection();
  a.noteHa('off', r.now() - 60_000, { source: 'full' });
  assert.equal(a.state(), null, 'a new connection starts a new order');
  const b = r.mk();
  b.load();                                                   // the persisted `at` is ahead of real time
  b.noteHa('on', r.now(), { source: 'full' });
  assert.deepEqual(b.state()?.by, ['ha'], 'the persisted stamp is never an ordering floor');
});
