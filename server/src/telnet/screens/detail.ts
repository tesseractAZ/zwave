/**
 * NODE DETAIL overlay — v0.2 stub.
 *
 * v0.2 fills this with the full per-node dossier: identity/capability/security,
 * live link (rtt/rssi/drop%), the LWR + NLWR route chains with per-hop RSSI,
 * TX/RX reliability, the battery lane, and the per-node action console.
 */

import { c } from '../ansi';
import type { ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

export function renderDetail(ctx: ScreenCtx): string[] {
  const n = ctx.visibleNodes[ctx.view.selected];
  const who = n ? `[${n.nodeId}] ${n.name}` : 'no node selected';
  return centeredNotice(ctx.view, 'NODE DETAIL', [
    c.grey(who),
    '',
    c.yellow('Coming in v0.2'),
    '',
    c.grey('Full per-node dossier: identity, live link,'),
    c.grey('LWR/NLWR routes, TX/RX reliability, battery.'),
  ]);
}
