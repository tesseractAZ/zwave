/**
 * CONTROLLER & NETWORK overlay — v0.2 stub.
 *
 * v0.2 fills this with node-1 radio health (Zooz ZST39 LR), per-channel
 * background-RSSI noise floor with a jam flag, the controller traffic/timeout
 * counters, the network health distribution, and network-wide operations.
 */

import { c } from '../ansi';
import type { ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

export function renderController(ctx: ScreenCtx): string[] {
  return centeredNotice(ctx.view, 'CONTROLLER & NETWORK', [
    c.yellow('Coming in v0.2'),
    '',
    c.grey('Controller radio health, background-RSSI'),
    c.grey('noise floor, traffic counters, network ops.'),
  ]);
}
