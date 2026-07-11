/**
 * SIGNAL HEATMAP BY AREA overlay — v0.2 stub.
 *
 * v0.2 fills this with nodes grouped by HA area, each cell graded by
 * SNR-margin bucket over the live noise floor, per-area min/mean margin and
 * worst node, and a legend strip with live bucket counts.
 */

import { c } from '../ansi';
import type { ScreenCtx } from '../../types';
import { centeredNotice } from './overview';

export function renderHeatmap(ctx: ScreenCtx): string[] {
  return centeredNotice(ctx.view, 'SIGNAL HEATMAP BY AREA', [
    c.yellow('Coming in v0.2'),
    '',
    c.grey('Nodes grouped by area, cells graded by'),
    c.grey('SNR-margin over the live noise floor.'),
  ]);
}
