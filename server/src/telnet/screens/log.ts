/**
 * EVENT & COMMAND LOG overlay — v0.2 stub.
 *
 * v0.2 fills this with the scrolling stream of driver events (dead/alive/wake/
 * route-change) plus operator command outcomes, severity colouring, a
 * red-latch-until-ack rule, follow-tail, and error-only filtering.
 */

import { c } from '../ansi';
import type { ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

export function renderLog(ctx: ScreenCtx): string[] {
  return centeredNotice(ctx.view, 'EVENT & COMMAND LOG', [
    c.yellow('Coming in v0.2'),
    '',
    c.grey('Live driver events + operator command'),
    c.grey('outcomes, severity-coloured with a RED latch.'),
  ]);
}
