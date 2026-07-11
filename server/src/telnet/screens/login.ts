/**
 * Login gate renderer — a centered box drawn before the TUI when the session
 * requires authentication. Pure: takes a plain options object (no session
 * internals), returns the full frame as string[]. The password is shown masked
 * because the session re-renders the whole frame on each keystroke — the
 * transports never echo raw input.
 */

import { c, BOX, center, padEnd } from '../ansi';

export interface LoginViewOptions {
  cols: number;
  rows: number;
  title: string;
  /** Which field currently has focus. */
  stage: 'user' | 'pass';
  username: string;
  /** Number of password characters entered (rendered as bullets). */
  passwordLen: number;
  /** Error/status line under the fields (empty = none). */
  error: string;
  /** Terminal state: no more input accepted, any key disconnects. */
  denied: boolean;
  deniedMsg?: string;
  /** An async credential check is in flight. */
  checking?: boolean;
}

export function renderLogin(o: LoginViewOptions): string[] {
  const W = Math.max(20, o.cols);
  const boxW = Math.min(54, W - 4);
  const innerW = boxW - 2;
  const brow = (s: string): string => BOX.v + padEnd(' ' + s, innerW) + BOX.v;
  const top = BOX.tl + BOX.h.repeat(innerW) + BOX.tr;
  const bot = BOX.bl + BOX.h.repeat(innerW) + BOX.br;

  const inner: string[] = [];
  inner.push('');
  inner.push(center(c.cyanB(o.title), innerW - 1));
  inner.push(center(c.dim('Z-Wave mesh control-room'), innerW - 1));
  inner.push('');

  if (o.denied) {
    inner.push(c.red(o.deniedMsg ?? 'Access denied.'));
    inner.push('');
    inner.push(c.dim('Press any key to disconnect.'));
  } else {
    const userCur = o.stage === 'user' ? c.cyan('▏') : ' ';
    const passCur = o.stage === 'pass' ? c.cyan('▏') : ' ';
    const userLbl = o.stage === 'user' ? c.whiteB('Username:') : c.dim('Username:');
    const passLbl = o.stage === 'pass' ? c.whiteB('Password:') : c.dim('Password:');
    const bullets = '•'.repeat(Math.min(o.passwordLen, Math.max(0, innerW - 14)));
    inner.push(`${userLbl} ${o.username}${userCur}`);
    inner.push(`${passLbl} ${bullets}${passCur}`);
    inner.push('');
    inner.push(o.error ? c.red(o.error) : '');
    inner.push(o.checking ? c.yellow('Checking…') : c.dim('Enter submit · Esc clear · Ctrl-C quit'));
  }
  inner.push('');

  const boxLines = [top, ...inner.map(brow), bot];
  const leftMargin = Math.max(0, Math.floor((W - boxW) / 2));
  const pad = ' '.repeat(leftMargin);
  const framed = boxLines.map((l) => pad + l);

  const topBlank = Math.max(0, Math.floor((o.rows - framed.length) / 2));
  const out: string[] = [];
  for (let i = 0; i < topBlank; i++) out.push('');
  out.push(...framed);
  return out.slice(0, o.rows);
}
