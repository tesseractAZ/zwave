/**
 * Action catalog + menu model (v0.9) — the single source of truth for what the
 * Actions Menu offers, what each action does, and how dangerous it is.
 *
 * This is a PURE module (no I/O, no session state) so the menu contents, the
 * impact classification, and the context-gating are all unit-testable in
 * isolation. The session (session.ts) owns the transient menu cursor + the
 * type-CONFIRM buffer; the renderer (screens/actionsMenu.ts) draws from these
 * descriptors; the runner (zwave/zwaveActions.ts) executes the `kind`.
 *
 * Impact levels drive both the colour/badge in the UI and the confirm posture:
 *   safe        — harmless / idempotent (ping). Green.
 *   caution     — mutating but recoverable (refresh, re-interview, heal, stop). Yellow.
 *   destructive — disruptive or irreversible (rebuild-all, remove-failed). Red.
 *
 * NOTE: every action launched FROM THE MENU requires the type-CONFIRM step
 * regardless of impact — the menu is the deliberate path. Impact only changes
 * the colour and the wording of the warning. (The `p` ping keyboard shortcut
 * stays immediate for muscle-memory; that path is separate.)
 */

import type { ActionKind } from '../types';

export type ActionScope = 'device' | 'system';
export type ActionImpact = 'safe' | 'caution' | 'destructive';

export interface ActionDescriptor {
  kind: ActionKind;
  /** Short imperative label shown in the menu row + confirm title. */
  label: string;
  /** Device-scoped (needs a target node) vs system/network-wide. */
  scope: ActionScope;
  impact: ActionImpact;
  /** One line: what the action actually does. */
  desc: string;
  /** One line: the consequence / what to expect (shown in the confirm box). */
  impactNote: string;
  /** True when the action requires a target node (device scope). */
  needsNode: boolean;
}

/**
 * The full catalog, in menu order: device actions first (least→most dangerous),
 * then system-wide. The order here is the order rows appear.
 */
export const ACTION_CATALOG: ActionDescriptor[] = [
  {
    kind: 'ping',
    label: 'Ping node',
    scope: 'device',
    impact: 'safe',
    desc: 'Send a reachability ping request to the node.',
    impactNote: "Harmless — no mesh disruption, no data change. NOTE: HA does not return the ping's result, so a success here means the request was SENT, not that the node answered — watch the node's Status / Last-seen right after to see if it replied.",
    needsNode: true,
  },
  {
    kind: 'refreshValues',
    label: 'Refresh values',
    scope: 'device',
    impact: 'caution',
    desc: "Re-read all of the node's current values from the device.",
    impactNote: 'Generates RF traffic to the node. Safe, but can briefly load a busy node.',
    needsNode: true,
  },
  {
    kind: 'reInterview',
    label: 'Re-interview node',
    scope: 'device',
    impact: 'caution',
    desc: "Re-query the node's command classes and capabilities from scratch.",
    impactNote: 'Heavy: minutes on a mains node; a battery/FLiRS node resumes on its next wake and can take hours. Shows incomplete data until it finishes. Not destructive.',
    needsNode: true,
  },
  {
    kind: 'healNode',
    label: 'Rebuild node routes',
    scope: 'device',
    impact: 'caution',
    desc: "Recompute this one node's mesh routes (neighbour re-discovery).",
    impactNote: 'Mutating: this node re-discovers neighbours. Brief disruption to THIS node only.',
    needsNode: true,
  },
  {
    kind: 'removeFailed',
    label: 'Remove failed node',
    scope: 'device',
    impact: 'destructive',
    desc: 'Remove a dead/unreachable node from the mesh.',
    impactNote: 'IRREVERSIBLE. Only works on a node the controller has marked failed. You must re-pair the device to add it back.',
    needsNode: true,
  },
  {
    kind: 'rebuildAll',
    label: 'Rebuild ALL routes',
    scope: 'system',
    impact: 'destructive',
    desc: 'Rebuild mesh routes for every node in the network.',
    impactNote: 'DISRUPTIVE: the whole mesh recomputes routes and is degraded for many minutes. Battery nodes update on their next wake.',
    needsNode: false,
  },
  {
    kind: 'stopRebuild',
    label: 'Stop route rebuild',
    scope: 'system',
    impact: 'caution',
    desc: 'Halt an in-progress network route rebuild.',
    impactNote: 'Corrective: stops a running "Rebuild ALL routes". Safe.',
    needsNode: false,
  },
];

/** Look up a descriptor by kind (never undefined for a known ActionKind). */
export function describeAction(kind: ActionKind): ActionDescriptor | undefined {
  return ACTION_CATALOG.find((d) => d.kind === kind);
}

/** Context that shapes which rows the menu shows and which are actionable. */
export interface MenuContext {
  /** A target node is selected (device actions need one). */
  hasNode: boolean;
  /** A network route rebuild is currently in progress (controller flag). */
  rebuilding: boolean;
}

/** One row in the built menu: a descriptor plus whether it's actionable now. */
export interface MenuItem {
  desc: ActionDescriptor;
  /** Row is visible but not executable (with `reason`). */
  disabled: boolean;
  reason: string | null;
}

/**
 * Build the ordered, context-aware menu.
 *
 * - `rebuildAll` and `stopRebuild` are mutually exclusive: show the START while
 *   idle, the STOP while a rebuild runs. This mirrors the real controller state
 *   so the menu never offers an action that would no-op.
 * - Device actions always appear (so their descriptions are readable), but are
 *   DISABLED with a reason when no node is selected — rather than vanishing.
 */
export function buildMenu(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];
  for (const d of ACTION_CATALOG) {
    if (d.kind === 'stopRebuild' && !ctx.rebuilding) continue;
    if (d.kind === 'rebuildAll' && ctx.rebuilding) continue;
    const disabled = d.needsNode && !ctx.hasNode;
    items.push({ desc: d, disabled, reason: disabled ? 'select a node first (Overview/Detail)' : null });
  }
  return items;
}

/** Clamp a menu cursor into range (empty menu → 0). */
export function clampMenuIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(Math.max(0, index), len - 1);
}

/** The exact string the user must type to arm an action. */
export const CONFIRM_WORD = 'CONFIRM';
