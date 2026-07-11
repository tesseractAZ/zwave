/**
 * TOPOLOGY / ROUTES overlay — v0.2 stub.
 *
 * v0.2 fills this with the hop-grouped ASCII route tree built from each node's
 * LWR, repeater-load inversion (who-repeats-for-whom), NLWR-divergence badges,
 * routeFailedBetween warnings, and the Long-Range star panel.
 */

import { c } from '../ansi';
import type { ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

export function renderTopology(ctx: ScreenCtx): string[] {
  return centeredNotice(ctx.view, 'TOPOLOGY / ROUTES', [
    c.yellow('Coming in v0.2'),
    '',
    c.grey('Hop-grouped mesh route tree, repeater load,'),
    c.grey('LR-star view, and route-failure badges.'),
  ]);
}
