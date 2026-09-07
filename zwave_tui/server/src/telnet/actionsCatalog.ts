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

import type { ActionKind, ConfigParam, EntityLiveState, EntityVerb } from '../types';
import { isHighStakes, verbLabel, verbsFor } from '../zwave/entityControl';

export type ActionScope = 'device' | 'system';
export type ActionImpact = 'safe' | 'caution' | 'destructive';

/** Menu grouping — finer than scope so device MAINTENANCE (ping/heal/…) and
 *  device CONTROL (on/off/lock/…) get their own labelled sections (v0.23). */
export type MenuGroup = 'maintenance' | 'control' | 'config' | 'system';

/** What a menu row does when confirmed. Catalog rows carry a kind; the v0.23
 *  device rows carry the concrete entity/verb or config parameter to act on. */
/**
 * The menu's vocabulary is DELIBERATELY WIDER than `ActionKind`.
 *
 * `ActionKind` is the learned-efficacy vocabulary: the outcome ledger keys its
 * action arm on it and `efficacyFor(kind, action)` scores it. The two identity
 * choices are not remediations — they act on the add-on's own persisted state,
 * not on the mesh — so putting them in `ActionKind` would make them scoreable
 * by a ledger that can never observe their effect on a symptom.
 */
export type MenuActionKind = ActionKind | 'identityKeep' | 'identityFresh' | 'identityResume';

/**
 * The mesh-identity answers, as ONE predicate.
 *
 * This list lived in four places by v0.64.1 — the menu gate, the session
 * dispatch, the read-only exemption and the menu footer — and adding
 * `identityResume` updated only three of them. The footer kept saying
 * "⏎ locked · enable write_actions_enabled" over a row Enter actually
 * activates: the exact defect the footer fix existed to remove, reintroduced by
 * a fourth kind the fix could not see.
 */
export type IdentityMenuKind = 'identityKeep' | 'identityFresh' | 'identityResume';

export function isIdentityKind(kind: MenuActionKind): kind is IdentityMenuKind {
  return kind === 'identityKeep' || kind === 'identityFresh' || kind === 'identityResume';
}

export type MenuPayload =
  | { type: 'catalog'; kind: MenuActionKind }
  | { type: 'entity'; entityId: string; entityName: string; domain: string; verb: EntityVerb }
  | { type: 'config'; param: ConfigParam };

export interface ActionDescriptor {
  kind: MenuActionKind;
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
    impactNote: 'Mutating: this node re-discovers neighbours. Brief disruption to THIS node only. It also DISCARDS any manually-set priority route for this node — you must set it again afterwards.',
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
    impactNote: 'DISRUPTIVE: the whole mesh recomputes routes and is degraded for many minutes. Battery nodes update on their next wake. It also DISCARDS every manually-set priority route in the mesh.',
    needsNode: false,
  },
  {
    kind: 'identityKeep',
    label: 'Identity: KEEP learning',
    scope: 'system',
    impact: 'caution',
    desc: 'Treat the learning from the previous controller as belonging to this one.',
    impactNote: "Correct when the mesh is PHYSICALLY THE SAME and only its id changed — an NVM backup restored onto replacement hardware. Wrong if this is a different network: the baselines and efficacy rates describe other devices in other rooms, and the engine would invent symptoms against strangers.",
    needsNode: false,
  },
  {
    kind: 'identityResume',
    label: 'Identity: RESUME archived',
    scope: 'system',
    impact: 'caution',
    desc: 'Put back the learning this controller built during a previous stint.',
    impactNote: 'For a stick that has COME BACK. Its own archived baselines and efficacy rates return to service, and whatever the interim controller learned is archived aside in their place. Nothing is deleted either way.',
    needsNode: false,
  },
  {
    kind: 'identityFresh',
    label: 'Identity: START FRESH',
    scope: 'system',
    impact: 'caution',
    desc: 'Archive the previous controller\u2019s learned state and begin learning again.',
    impactNote: 'RECOVERABLE: the previous files are renamed aside on disk (never deleted), so they can be inspected or restored by hand. The engine re-learns from zero, which takes days for baselines and longer for efficacy.',
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
export function describeAction(kind: MenuActionKind): ActionDescriptor | undefined {
  return ACTION_CATALOG.find((d) => d.kind === kind);
}

/**
 * Which menu is being built.
 *
 * The two are kept apart because a single mixed menu was dishonest: its header
 * read "target #8 Kitchen Lamp" and then listed "Rebuild ALL routes" — an
 * action that touches all 39 nodes and has nothing to do with the node named
 * above it. One menu, one scope, one blast radius.
 */
export type MenuScope = 'device' | 'network';

/** Context that shapes which rows the menu shows and which are actionable. */
export interface MenuContext {
  /** Which menu to build — device-scoped, or mesh-wide. */
  scope: MenuScope;
  /** A target node is selected (device actions need one). */
  hasNode: boolean;
  /** The live controller has archived learning from a previous stint, so
   *  RESUME is a real option rather than a row that would fail. */
  identityResumable: boolean;
  /** A mesh-identity decision is awaiting an answer (v0.64.0). Gates the
   *  identity rows the same way `rebuilding` gates stopRebuild.
   *
   *  REQUIRED, not optional: as an optional member the compiler accepted a
   *  call site that never passed it, and the rows were unreachable while every
   *  test and mutant still passed — the v0.33 dead-key shape exactly. */
  identityPending: boolean;
  /**
   * True when the screen HAS a per-node cursor (Overview/Detail/Log/Remedy).
   * The reason a device action is unavailable differs: on those screens the
   * card under the cursor is mesh-scoped, so "pick a node on the Overview"
   * is a false explanation that sends the operator to the wrong screen. The
   * shortcut-key path already distinguishes these; this is its second consumer.
   */
  cursorScreen?: boolean;
  /** A network route rebuild is currently in progress (controller flag). */
  rebuilding: boolean;
}

/** One row in the built menu: a descriptor plus whether it's actionable now.
 *  For v0.23 device-control / config rows the `desc` is SYNTHETIC (built from the
 *  entity/param) so the renderer + confirm box read it uniformly; `payload` says
 *  what to actually do, and `group` places the row under its section heading. */
export interface MenuItem {
  desc: ActionDescriptor;
  group: MenuGroup;
  payload: MenuPayload;
  /** Row is visible but not executable (with `reason`). */
  disabled: boolean;
  reason: string | null;
}

/**
 * Build the ordered, context-aware menu for ONE scope.
 *
 * - The DEVICE menu offers only actions bounded by the selected node. The
 *   NETWORK menu offers only mesh-wide ones. Mixing them put an action with a
 *   39-node blast radius directly under a header naming a single device.
 * - `rebuildAll` and `stopRebuild` are mutually exclusive: show the START while
 *   idle, the STOP while a rebuild runs. This mirrors the real controller state
 *   so the menu never offers an action that would no-op.
 * - Device actions always appear (so their descriptions are readable), but are
 *   DISABLED with a reason when no node is selected — rather than vanishing.
 */
export function buildMenu(ctx: MenuContext): MenuItem[] {
  const want: ActionScope = ctx.scope === 'network' ? 'system' : 'device';
  const items: MenuItem[] = [];
  for (const d of ACTION_CATALOG) {
    if (d.scope !== want) continue;
    if (d.kind === 'stopRebuild' && !ctx.rebuilding) continue;
    // Offered ONLY while a decision is actually pending — like stopRebuild,
    // an action with nothing to act on is a row that can only confuse.
    if (isIdentityKind(d.kind) && !ctx.identityPending) continue;
    // RESUME needs more than a pending decision: it needs this controller to
    // actually have something archived. Offering it otherwise is a row that can
    // only fail, on the screen where the operator is least sure what to press.
    if (d.kind === 'identityResume' && !ctx.identityResumable) continue;
    if (d.kind === 'rebuildAll' && ctx.rebuilding) continue;
    const disabled = d.needsNode && !ctx.hasNode;
    items.push({
      desc: d,
      group: d.scope === 'system' ? 'system' : 'maintenance',
      payload: { type: 'catalog', kind: d.kind },
      disabled,
      reason: disabled
        ? (ctx.cursorScreen
            ? 'the item under the cursor is not tied to a single node'
            : 'select a node first (Overview/Detail)')
        : null,
    });
  }
  return items;
}

/* ── v0.23 device-control + config-edit rows (synthetic descriptors) ──────── */

function entityImpact(domain: string, verb: EntityVerb): ActionImpact {
  if (isHighStakes(domain, verb)) return 'destructive'; // unlock, garage/cover open/toggle
  if (domain === 'lock' || domain === 'cover') return 'caution'; // lock, close
  return 'safe'; // routine light/switch/fan/siren on/off/toggle
}

function entityImpactNote(domain: string, verb: EntityVerb, entityName: string): string {
  const base = `Actuates the physical device "${entityName}".`;
  if (verb === 'unlock') return `${base} UNLOCKS the lock — the door becomes openable.`;
  if (verb === 'lock') return `${base} Locks the door.`;
  if (verb === 'open') return `${base} OPENS it (a garage door / cover will travel).`;
  if (verb === 'close') return `${base} Closes it.`;
  if (verb === 'toggle') return `${base} Flips its current state.`;
  return `${base} No mesh disruption; recoverable — you can set it back.`;
}

/**
 * Build the device-CONTROL rows for a node's entities. One row per (controllable
 * entity, verb). Read-only entities (sensors, buttons, climate, …) contribute
 * nothing. The current live state is appended to the "what it does" line so the
 * operator sees, e.g., that a light is already off before turning it off.
 */
export function buildEntityRows(entities: EntityLiveState[]): MenuItem[] {
  const rows: MenuItem[] = [];
  for (const e of entities) {
    const verbs = verbsFor(e.domain);
    if (verbs.length === 0) continue;
    for (const verb of verbs) {
      const impact = entityImpact(e.domain, verb);
      const stateNote = e.state != null && e.state !== 'unavailable' && e.state !== 'unknown' ? ` (now: ${e.state})` : '';
      rows.push({
        desc: {
          kind: 'controlEntity',
          label: `${verbLabel(verb)} · ${e.name}`,
          scope: 'device',
          impact,
          desc: `${verbLabel(verb)} ${e.name}${stateNote}.`,
          impactNote: entityImpactNote(e.domain, verb, e.name),
          needsNode: true,
        },
        group: 'control',
        payload: { type: 'entity', entityId: e.entityId, entityName: e.name, domain: e.domain, verb },
        disabled: false,
        reason: null,
      });
    }
  }
  return rows;
}

/**
 * Build the CONFIG-edit rows — one per WRITEABLE parameter. Selecting a row opens
 * the value picker (the session), then the type-CONFIRM. Non-writeable params
 * are read-only in the dossier and never appear here.
 */
export function buildConfigRows(params: ConfigParam[]): MenuItem[] {
  const rows: MenuItem[] = [];
  for (const p of params) {
    if (!p.writeable) continue;
    const cur = p.value == null ? '—' : p.valueLabel ? `${p.value} (${p.valueLabel})` : `${p.value}${p.unit ? ' ' + p.unit : ''}`;
    const range = p.states ? 'choose from a list' : p.min != null && p.max != null ? `${p.min}…${p.max}${p.unit ? ' ' + p.unit : ''}` : 'a number';
    rows.push({
      desc: {
        kind: 'setConfigParam',
        label: `Set · ${p.label}`,
        scope: 'device',
        impact: 'caution',
        desc: `Edit "${p.label}" (now ${cur}; ${range}).`,
        impactNote: 'Writes this Z-Wave configuration parameter to the device. Recoverable — you can set it back, but a wrong value can change how the device behaves.',
        needsNode: true,
      },
      group: 'config',
      payload: { type: 'config', param: p },
      disabled: false,
      reason: null,
    });
  }
  return rows;
}

/** Clamp a menu cursor into range (empty menu → 0). */
export function clampMenuIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(Math.max(0, index), len - 1);
}

/** The exact string the user must type to arm an action. */
export const CONFIRM_WORD = 'CONFIRM';
