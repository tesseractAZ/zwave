import { test } from 'node:test';
import assert from 'node:assert/strict';
import { honestPct, unscoreableReason } from '../src/telnet/ledgerText';
import { CONSOLE_HTML } from '../src/telnet/wsConsole';

test('a share never rounds into a claim: 100% only for all, 0% only for none (v0.74.1)', () => {
  assert.equal(honestPct(474, 475), '>99%', 'one unanswered probe in 475 printed "100%"');
  assert.equal(honestPct(475, 475), '100%');
  assert.equal(honestPct(748, 638906), '<1%', '748 fresh of 638,906 printed "0%"');
  assert.equal(honestPct(0, 10), '0%');
  assert.equal(honestPct(81, 82), '99%');
  assert.equal(honestPct(201, 234), '86%');
  assert.equal(honestPct(1, 100), '1%');
  assert.equal(honestPct(99, 100), '99%');
  assert.equal(honestPct(3, 0), '—');
});

test('every kind that opens no episode has the ledger\'s reason (v0.74.1)', () => {
  for (const k of ['node-down', 'missed-report', 'repeated-frames']) assert.match(String(unscoreableReason(k)), /not measured by the ledger/, k);
  assert.equal(unscoreableReason('rtt-degraded'), null);
});

test('the console\'s connection label leaves the command bar once connected (v0.74.1)', () => {
  // It is fixed over the terminal's last row and covered [Z] PAUSE on ENGINE.
  assert.match(CONSOLE_HTML, /statusEl\.textContent = 'connected';[\s\S]{0,400}statusEl\.style\.display = 'none'/);
  assert.match(CONSOLE_HTML, /statusEl\.style\.display = '';\s*statusEl\.textContent = 'disconnected/, 'and comes back when the link drops');
});
