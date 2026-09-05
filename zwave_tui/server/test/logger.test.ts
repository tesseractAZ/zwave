import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, LOG_LEVELS } from '../src/logger';

/* ── v0.50.0: a severity that is unrepresentable is not a severity ────────── */

test('every non-info line CARRIES its severity, so an operator can grep for it', () => {
  // `emit` gated the write on severity and then DISCARDED it, so a warn, an
  // error and an ordinary log() line were byte-identical in journald. The one
  // "node 49 needs a human" ERROR in fifty hours sat at exactly the visual
  // weight of the 941 routine sweep lines around it, and `grep -i error` found
  // nothing.
  const out: string[] = [];
  const log = createLogger('debug', (l) => out.push(l));
  log('routine');
  log.debug('detail');
  log.warn('a warning');
  log.error('a failure');
  assert.deepEqual(out, [
    '[zwave-tui] routine\n',
    '[zwave-tui] DEBUG: detail\n',
    '[zwave-tui] WARNING: a warning\n',
    '[zwave-tui] ERROR: a failure\n',
  ]);
  assert.ok(out.some((l) => /ERROR/.test(l)), 'grep ERROR must find the error');
  assert.ok(!/ERROR|WARNING/.test(out[0]), 'and info stays bare, so existing greps still match');
});

test('the threshold still silences below it — the token is added, not the gate removed', () => {
  const out: string[] = [];
  const log = createLogger('warning', (l) => out.push(l));
  log('routine');
  log.debug('detail');
  log.warn('a warning');
  log.error('a failure');
  assert.deepEqual(out, ['[zwave-tui] WARNING: a warning\n', '[zwave-tui] ERROR: a failure\n']);
});

test('EVERY level the option offers can produce output — none is a silent setting', () => {
  // config.yaml offers seven values. Four of them (`notice`, `warning`,
  // `error`, `fatal`) produced a COMPLETELY EMPTY add-on log on the live
  // system, because `log.error` had zero call sites and both `log.warn` sites
  // were unreachable under the live configuration. An operator following the
  // module's own advice to "turn the volume down" would conclude the add-on
  // had stopped. This pins the SINK's half of that: each level must pass at
  // least its own severity through.
  for (const level of LOG_LEVELS) {
    const out: string[] = [];
    const log = createLogger(level, (l) => out.push(l));
    log.error('a failure');
    if (level === 'fatal') {
      assert.equal(out.length, 0, 'fatal is above error — nothing below it prints');
    } else {
      assert.equal(out.length, 1, `${level}: an error must reach the log`);
      assert.match(out[0], /ERROR: a failure/);
    }
  }
});

test('a FATAL survives EVERY configurable threshold (v0.53.0)', () => {
  // index.ts's `main().catch()` is the one line whose whole job is to explain a
  // crash loop, and it went out through the INFO sink. At `log_level: warning`
  // — the value translations/en.yaml recommends to "quiet routine output" —
  // the add-on log was the s6 restart banner repeating and not one line saying
  // why. `fatal` is the top of the ladder, so the gate in `emit` is false for
  // all seven configurable values.
  for (const level of LOG_LEVELS) {
    const out: string[] = [];
    const log = createLogger(level, (l) => out.push(l));
    log.fatal('bootstrap died');
    assert.deepEqual(out, ['[zwave-tui] FATAL: bootstrap died\n'],
      `${level}: the bootstrap crash cause must still reach the log`);
  }
});
