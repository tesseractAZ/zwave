/**
 * Symptom engine (M3, DESIGN.md §3.3) — pure functions that turn evidence +
 * baselines into ranked, provenance-carrying symptoms. Advisory-first: this
 * module only DESCRIBES what it sees; it never acts.
 *
 * Structure (from the design review):
 *  - Every detector always COMPUTES; dwell accumulates continuously and is never
 *    reset by another symptom (detection ≠ advice).
 *  - A correlation LADDER classifies mesh-level events by evidence strength —
 *    controller-degraded > flooding > interference(residual) — and demotes (not
 *    deletes) per-node symptoms under an active mesh event via `subsumedBy`.
 *  - Each symptom carries `basis` (measured vs inferred) so the UI never renders
 *    an inference in the same voice as a measurement.
 *
 * The dwell state that must persist across ticks lives in a caller-owned
 * `SymptomState` map (so this module stays pure); `detectSymptoms` reads and
 * updates it and returns the current symptom list.
 */

import type { NodeSnapshot, ControllerSnapshot, NodeStatus } from '../types';
import { NodeStatus as NS } from '../types';
import type { EvidenceSample, CoarseBucket, ControllerSample, NodeCoverage } from './evidenceStore';
import type { BaselineStore } from './baselines';

export type SymptomKind =
  | 'return-path-degraded'
  | 'chronic-return-path'
  | 'dead-flap'
  | 'quiet-node'
  | 'rate-fallback'
  | 'route-churn'
  | 'rtt-degraded'
  | 'weak-signal'
  | 'chatty-device'
  | 'ghost-suspect'
  | 'controller-degraded'
  | 'edge-cluster'
  | 'mesh-interference';

export type Severity = 'watch' | 'warn' | 'crit';

export interface EvidenceRef {
  label: string;
  value: string;
}

export interface Symptom {
  kind: SymptomKind;
  nodeId: number | null; // null = mesh/controller-scoped
  severity: Severity;
  sinceMs: number; // dwell start (epoch ms)
  basis: 'measured' | 'inferred';
  evidence: EvidenceRef[];
  narrative: string;
  /** id of an active mesh-level event this per-node symptom is demoted under. */
  subsumedBy?: string;
  /** For a multi-node symptom (edge-cluster): the affected member node ids.
   *  `nodeId` is then the SHARED node they depend on (the suspect), not a member. */
  members?: number[];
}

/** Caller-owned dwell state — one entry per (nodeId,kind) currently breaching.
 *  `hits` counts EVALUABLE breaching observations (not wall-clock ticks) so a
 *  "chronic" verdict means the badness was actually seen repeatedly, never just
 *  "first seen N days ago with an unknown quiet middle" (v0.14 review). */
export interface DwellEntry {
  since: number;
  lastSeen: number;
  hits: number;
}
export type SymptomState = Map<string, DwellEntry>;

export interface DetectInput {
  now: number;
  nodes: NodeSnapshot[];
  controller: ControllerSnapshot | null;
  baselines: BaselineStore;
  /** Latest fine sample per node (newest). */
  latest: (nodeId: number) => EvidenceSample | undefined;
  /** Recent fine ring per node (for windowed rates + flaps). */
  recent: (nodeId: number) => EvidenceSample[];
  coarse: (nodeId: number) => CoarseBucket[];
  controllerSamples: () => ControllerSample[];
  coverage: (nodeId: number) => NodeCoverage | null;
  /** Store-level: epoch ms evidence collection began (coverage floor). */
  recordingSince: () => number | null;
  /** Is the noise floor a real measurement (driver-WS) vs the −95 fallback? */
  hasRealNoise: () => boolean;
}

// ── Tunables (documented; ship as constants — shareability rule) ─────────────
const DWELL_MS = 5 * 60_000; // a breach must persist 5 min to surface
const WINDOW_MS = 10 * 60_000; // windowed-rate lookback
const MIN_WINDOW_TX = 20; // minimum successful sends for a rate to be meaningful
const TIMEOUT_RATE_ABS = 0.15; // chronic absolute threshold (health-check rubric)
const TIMEOUT_RATE_MULT = 3; // relative: window rate ≫ this × baseline
const CHRONIC_DAYS_MS = 2 * 24 * 60_000 * 60; // 2 days sustained → chronic
const RTT_Z = 4; // z-score over route-stratified baseline
const WEAK_MARGIN_DB = 7; // direct-node weak-signal margin
const FLAPS_WINDOW = 3; // ≥3 Alive↔Dead transitions in the window
const RX_FLOOD_MULT = 20; // dRx rate orders-of-magnitude over the mesh median
const GHOST_MIN_COVERAGE_MS = 3 * 24 * 60_000 * 60; // ≥3 days observed, zero comms
const CTRL_DEGRADED_ABS = 5; // controller NAK+CAN+timeoutACK per window
const MESH_ACTIVE_FRACTION = 0.35; // fire: ≥35% of ACTIVE nodes degraded
const MESH_RELEASE_FRACTION = 0.2; // hold: stays active until it dips below this (hysteresis)
const MESH_MIN_ACTIVE = 8; // never call it "mesh-wide" on a handful of active nodes
const MESH_MIN_DEGRADED = 3; // and never on a coincidental pair
const CHRONIC_MIN_HITS = 400; // evaluable-bad observations before "chronic" (≫ wall-clock alone)
const EDGE_MIN_MEMBERS = 2; // a shared-repeater cluster needs ≥2 degrading dependents (a single is a per-node symptom)
const EDGE_SUFFIX = ':edge-cluster'; // dwell-key suffix for edge-cluster (for stale-key cleanup)

function key(nodeId: number | null, kind: SymptomKind): string {
  return `${nodeId ?? 'mesh'}:${kind}`;
}

/** Update dwell for a (node,kind) breach; return the dwell-start once it has
 *  persisted ≥ DWELL_MS, else null (still arming). Clears when not breaching. */
function dwell(state: SymptomState, k: string, breaching: boolean, now: number): number | null {
  if (!breaching) {
    state.delete(k);
    return null;
  }
  const e = state.get(k);
  if (!e) {
    state.set(k, { since: now, lastSeen: now, hits: 1 });
    return null;
  }
  e.lastSeen = now;
  e.hits += 1;
  return now - e.since >= DWELL_MS ? e.since : null;
}

/** The newest sample within the window that is FRESH and has a usable value —
 *  so a dwell gated on a per-tick freshness flag isn't reset every non-fresh
 *  tick (v0.14 review: rtt/weak-signal almost never matured). */
function latestFresh<T>(samples: EvidenceSample[], now: number, pick: (s: EvidenceSample) => T | null, windowMs = WINDOW_MS): T | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (now - s.t > windowMs) break;
    if (!s.fresh) continue;
    const v = pick(s);
    if (v != null) return v;
  }
  return null;
}

/** Has the SAME route the node is on now ever been observed at 100k in its
 *  recent history? Only then is a sub-100k reading a REGRESSION rather than the
 *  device/route's capability ceiling (DESIGN §3.3 fail-closed; RESEARCH §2.2). */
function sameRouteRegressed(samples: EvidenceSample[], routeKey: string | null, now: number): boolean {
  if (routeKey == null) return false;
  let sawHundred = false;
  let recentBelow = false;
  for (const s of samples) {
    if (now - s.t > WINDOW_MS * 3) continue; // ~30 min of memory
    if (s.routeKey !== routeKey) continue;
    if (s.rateKbps != null && s.rateKbps >= 100) sawHundred = true;
    if (s.rateKbps != null && s.rateKbps < 100) recentBelow = true;
  }
  return sawHundred && recentBelow;
}

/** Windowed timeout rate over a node's recent fine ring — Σtimeout/Σtx across
 *  valid windows, null when traffic is below the meaningfulness floor. */
export function windowTimeoutRate(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): { rate: number; tx: number } | null {
  let tx = 0;
  let to = 0;
  for (const s of samples) {
    if (now - s.t > windowMs) continue;
    if (s.dTx == null || s.dTimeout == null) continue; // invalid window
    tx += s.dTx;
    to += s.dTimeout;
  }
  if (tx < MIN_WINDOW_TX) return null;
  return { rate: to / tx, tx };
}

/** Count Alive↔Dead flap transitions in the window (event-driven dFlaps). */
function windowFlaps(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): number {
  let f = 0;
  for (const s of samples) if (now - s.t <= windowMs) f += s.dFlaps;
  return f;
}

/** Windowed dRx rate (reports/min) — for chatty-device detection. */
function windowRxRate(samples: EvidenceSample[], now: number, windowMs = WINDOW_MS): number | null {
  let rx = 0;
  let spanMs = 0;
  let first: number | null = null;
  for (const s of samples) {
    if (now - s.t > windowMs) continue;
    if (s.dRx == null) continue;
    rx += s.dRx;
    if (first == null) first = s.t;
    spanMs = s.t - first;
  }
  if (spanMs < 60_000) return null;
  return rx / (spanMs / 60_000);
}

const RATE_LABEL: Record<number, string> = { 1: '9.6k', 2: '40k', 3: '100k', 4: 'LR-100k' };

/** Poisson upper-tail-ish anomaly: is observing ≥ `obs` events surprising under
 *  expected `exp`? Cheap proxy: obs beyond exp by ≥ mult× and ≥ a floor margin. */
function rateAnomalous(windowRate: number, baseRate: number, mult: number): boolean {
  // Guard the near-zero baseline: require an absolute floor too so a baseline of
  // 0.001 doesn't make 0.01 "10× anomalous".
  return windowRate >= Math.max(baseRate * mult, TIMEOUT_RATE_ABS * 0.5) && windowRate > baseRate + 0.02;
}

/**
 * The main entry point. Returns the current symptom list (dwell-gated) and
 * mutates `state` for the next tick. Pure w.r.t. the inputs otherwise.
 */
export function detectSymptoms(input: DetectInput, state: SymptomState): Symptom[] {
  const { now, nodes, baselines } = input;
  const out: Symptom[] = [];
  // Correlation-gate substrate: RAW (pre-dwell) per-node RF degradation, so the
  // mesh gate has its OWN dwell decoupled from per-node dwell (design review:
  // detection ≠ advice; the gate must not wait two stacked dwells to fire).
  const degradingNow = new Map<number, boolean>();
  const markDegrading = (id: number, cond: boolean): void => {
    if (cond) degradingNow.set(id, true);
  };

  // ── controller-degraded (deterministic serial-link evidence) ──────────────
  let controllerEvent: string | null = null;
  {
    const cs = input.controllerSamples();
    const recent = cs.filter((s) => now - s.t <= WINDOW_MS && s.fresh);
    let nak = 0;
    let can = 0;
    let tack = 0;
    let any = false;
    for (const s of recent) {
      if (s.dNak != null) { nak += s.dNak; any = true; }
      if (s.dCan != null) can += s.dCan;
      if (s.dTimeoutAck != null) tack += s.dTimeoutAck;
    }
    const total = nak + can + tack;
    const breaching = any && total >= CTRL_DEGRADED_ABS;
    const since = dwell(state, key(null, 'controller-degraded'), breaching, now);
    if (since != null) {
      controllerEvent = 'ctrl';
      out.push({
        kind: 'controller-degraded', nodeId: null, severity: total >= CTRL_DEGRADED_ABS * 3 ? 'crit' : 'warn',
        sinceMs: since, basis: 'measured',
        evidence: [{ label: 'serial NAK/CAN/tmoACK', value: `${nak}/${can}/${tack} in 10m` }],
        narrative: 'Controller serial link is struggling (host↔stick). Suspect the stick: USB-2 port + a passive extension cable away from USB-3, or relocate it — not a per-node RF fault.',
      });
    }
  }

  // ── per-node detectors ────────────────────────────────────────────────────
  for (const node of nodes) {
    if (node.isController) continue;
    const id = node.nodeId;
    const samples = input.recent(id);
    const last = input.latest(id);
    let breaching = false;

    // dead-flap — the hard RF-failure event, from the event-driven flap counter.
    {
      const flaps = windowFlaps(samples, now);
      const b = flaps >= FLAPS_WINDOW;
      markDegrading(id, b);
      const since = dwell(state, key(id, 'dead-flap'), b, now);
      if (since != null) {
        breaching = true;
        out.push({
          kind: 'dead-flap', nodeId: id, severity: 'crit', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'Alive↔Dead flaps', value: `${flaps} in 10m` }],
          narrative: `${node.name} is flapping between Alive and Dead — a hard link failure. Runbook: ping → power-cycle the device → exclude/re-include. A route rebuild cannot repair a node that can't be reached.`,
        });
      }
    }

    // return-path-degraded (relative) + chronic-return-path (absolute).
    {
      const w = windowTimeoutRate(samples, now);
      const norm = baselines.timeoutNormal(id, now);
      if (w) {
        const relBreach = norm?.ready ? rateAnomalous(w.rate, norm.rate, TIMEOUT_RATE_MULT) : false;
        markDegrading(id, relBreach || w.rate >= TIMEOUT_RATE_ABS);
        const since = dwell(state, key(id, 'return-path-degraded'), relBreach, now);
        if (since != null) {
          breaching = true;
          out.push({
            kind: 'return-path-degraded', nodeId: id, severity: w.rate >= TIMEOUT_RATE_ABS ? 'warn' : 'watch',
            sinceMs: since, basis: 'measured',
            evidence: [
              { label: 'timeout rate (10m)', value: `${(w.rate * 100).toFixed(1)}% of ${w.tx} tx` },
              { label: 'own baseline', value: `${((norm?.rate ?? 0) * 100).toFixed(1)}%` },
            ],
            narrative: `${node.name}'s reply-timeout rate is well above its own normal — a return-path problem: the node acknowledges the request but its report is lost. Typical of a marginal link (distance, an RF-hostile wall) rather than a routing-table issue.`,
          });
        }
        // Chronic-absolute: sustained high rate regardless of baseline. Requires
        // both wall-clock age AND repeated EVALUABLE-bad observations (hits), so
        // a node quiet for 2 days then briefly bad is NOT called "chronic since
        // setup" (v0.14 review). The chronic dwell is only advanced on evaluable
        // windows (this `if (w)` block), so hits accrue only when we can see it.
        const chronicBreach = w.rate >= TIMEOUT_RATE_ABS;
        const ck = key(id, 'chronic-return-path');
        const cSince = dwell(state, ck, chronicBreach, now);
        const cHits = state.get(ck)?.hits ?? 0;
        if (cSince != null && now - cSince >= CHRONIC_DAYS_MS && cHits >= CHRONIC_MIN_HITS) {
          breaching = true;
          out.push({
            kind: 'chronic-return-path', nodeId: id, severity: 'warn', sinceMs: cSince, basis: 'measured',
            evidence: [{ label: 'timeout rate (sustained)', value: `${(w.rate * 100).toFixed(1)}% for ${Math.floor((now - cSince) / 86_400_000)}d` }],
            narrative: `${node.name} has been chronically slow to respond for days — bad since it was set up, not a recent change. Consider repeater coverage or relocating the device.`,
          });
        }
      }
    }

    // rate-fallback — SAME-ROUTE REGRESSION below 100k (a device/route whose
    // ceiling is 40k/9.6k must NOT fire — that's capability, not a fault). We
    // require the current route to have been observed at 100k in recent history
    // (DESIGN §3.3 fail-closed; RESEARCH §2.2). No route memory ⇒ no fire.
    {
      const b = !node.isLongRange && sameRouteRegressed(samples, last?.routeKey ?? null, now);
      markDegrading(id, b);
      const since = dwell(state, key(id, 'rate-fallback'), b, now);
      if (since != null) {
        breaching = true;
        const proto = last?.rateKbps === 9.6 ? 1 : last?.rateKbps === 40 ? 2 : 0;
        out.push({
          kind: 'rate-fallback', nodeId: id, severity: last?.rateKbps === 9.6 ? 'warn' : 'watch',
          sinceMs: since, basis: 'measured',
          evidence: [{ label: 'negotiated rate', value: RATE_LABEL[proto] ?? `${last?.rateKbps}k` }, { label: 'route', value: last?.routeKey ?? '—' }],
          narrative: `${node.name} regressed below 100 kbps on a route that previously sustained it — a degraded link on that path (not a device whose ceiling is 40k/9.6k, which this detector excludes).`,
        });
      }
    }

    // rtt-degraded — route-stratified median ≫ baseline. Uses the newest FRESH
    // RTT in the window (not `last`), so a non-fresh tick doesn't reset the dwell.
    {
      const norm = baselines.rttNormal(id, now);
      const rtt = latestFresh(samples, now, (s) => (s.rtt != null && s.rtt >= 0 ? s.rtt : null));
      const b = !!(norm?.ready && rtt != null && rtt > norm.median + RTT_Z * norm.scale);
      const since = dwell(state, key(id, 'rtt-degraded'), b, now);
      if (since != null) {
        breaching = true;
        out.push({
          kind: 'rtt-degraded', nodeId: id, severity: 'watch', sinceMs: since, basis: 'measured',
          evidence: [{ label: 'RTT', value: `${Math.round(rtt!)}ms` }, { label: 'baseline', value: `${Math.round(norm!.median)}±${Math.round(norm!.scale)}ms` }],
          narrative: `${node.name}'s round-trip time is far above its normal for this route and time of day.`,
        });
      }
    }

    // weak-signal — DIRECT nodes only (a routed node's rssi is its LAST HOP, not
    // the device). Requires timeout CORROBORATION (DESIGN §3.3): a thin margin
    // that isn't actually costing deliveries is not yet a problem. Uses the
    // newest fresh RSSI (dwell-stable). Honest basis: 'measured' only when the
    // noise floor is a real reading; against the −95 fallback it is 'inferred'.
    {
      const routed = (last?.routeKey ?? 'direct') !== 'direct';
      const rssi = latestFresh(samples, now, (s) => s.rssi);
      const floor = representativeFloor(input);
      const margin = rssi != null ? rssi - floor : null;
      const w = windowTimeoutRate(samples, now);
      const timeoutCorrob = w != null && w.rate >= 0.05; // deliveries actually suffering
      const b = !routed && !node.isLongRange && margin != null && margin < WEAK_MARGIN_DB && timeoutCorrob;
      const since = dwell(state, key(id, 'weak-signal'), b, now);
      if (since != null) {
        markDegrading(id, true);
        const realFloor = input.hasRealNoise();
        out.push({
          kind: 'weak-signal', nodeId: id, severity: 'watch', sinceMs: since,
          basis: realFloor ? 'measured' : 'inferred',
          evidence: [
            { label: 'SNR margin', value: `${Math.round(margin!)}dB${realFloor ? '' : ' (vs assumed −95 floor)'}` },
            { label: 'timeouts', value: `${(w!.rate * 100).toFixed(0)}%` },
          ],
          narrative: `${node.name} (direct route) has a thin signal margin over the noise floor and is losing replies — the classic RF-marginal-link pattern for a device far from the controller or behind an RF-hostile wall.`,
        });
      }
    }

    // chatty-device — dRx flood vs the mesh median (computed once below).
    // (breach evaluated in the second pass; see meshRxMedian.)

    // ghost-suspect — coverage-PROVEN, zero comms (destructive rec ⇒ strict).
    // INTENTIONALLY conservative (v0.14 review, accepted): keying on cumulative
    // freshSamples===0 flags only NEVER-communicated dead nodes, so a device
    // that once worked then died is NOT called a ghost here. That is the safe
    // bias — the eventual remediation (remove-failed) is destructive, and a
    // missed ghost costs far less than wrongly recommending removal of a real
    // device. A once-working dead node surfaces as dead-flap / plain-dead instead.
    {
      const cov = input.coverage(id);
      const rec = input.recordingSince();
      const observedMs = cov ? now - cov.firstSeenAt : rec ? now - rec : 0;
      const dead = node.status === NS.Dead;
      const noComms = cov != null && cov.freshSamples === 0;
      const b = dead && noComms && observedMs >= GHOST_MIN_COVERAGE_MS;
      const since = dwell(state, key(id, 'ghost-suspect'), b, now);
      if (since != null) {
        out.push({
          kind: 'ghost-suspect', nodeId: id, severity: 'warn', sinceMs: since, basis: 'inferred',
          evidence: [{ label: 'observed', value: `${Math.floor(observedMs / 86_400_000)}d, 0 successful comms` }],
          narrative: `${node.name} has been dead with no successful communication for days — possibly a ghost (a device removed without exclusion). Removing a failed node is destructive and only succeeds if the controller already considers it failed; verify before confirming.`,
        });
        breaching = true;
      }
    }

    void breaching; // per-node dwell drives emission; the gate uses degradingNow
  }

  // ── chatty-device (needs the mesh median) ─────────────────────────────────
  const rxRates = nodes
    .filter((n) => !n.isController)
    .map((n) => windowRxRate(input.recent(n.nodeId), now))
    .filter((r): r is number => r != null && r > 0)
    .sort((a, b) => a - b);
  const rxMedian = rxRates.length ? rxRates[rxRates.length >> 1] : 0;
  let floodNode: number | null = null;
  for (const node of nodes) {
    if (node.isController) continue;
    const rr = windowRxRate(input.recent(node.nodeId), now);
    const b = rr != null && rxMedian > 0 && rr >= rxMedian * RX_FLOOD_MULT && rr >= 6; // ≥6 reports/min AND ≫ median
    const since = dwell(state, key(node.nodeId, 'chatty-device'), b, now);
    if (since != null) {
      floodNode = node.nodeId;
      out.push({
        kind: 'chatty-device', nodeId: node.nodeId, severity: 'watch', sinceMs: since, basis: 'measured',
        evidence: [{ label: 'report rate', value: `${rr!.toFixed(1)}/min vs mesh ${rxMedian.toFixed(1)}/min` }],
        narrative: `${node.name} is flooding the mesh with reports (orders of magnitude over the median). Tune its reporting thresholds (change-based, not timed) or re-include without S0 — traffic like this degrades everyone.`,
      });
    }
  }

  // ── correlation ladder: is this a MESH-level event? ───────────────────────
  // Breadth over ACTIVE nodes, with hard floors so a coincidental pair on a
  // quiet mesh can't be called mesh-wide (v0.14 review: the K=2 dichotomy), and
  // HYSTERESIS (fire high, release low) so a momentary breadth dip doesn't drop
  // the event — which would regress the Remedy screen to N independent faults.
  const meshKey = key(null, 'mesh-interference');
  const wasMeshActive = state.has(meshKey);
  const activeNodes = nodes.filter((n) => !n.isController && input.recent(n.nodeId).some((s) => now - s.t <= WINDOW_MS && s.dTx != null && s.dTx > 0));
  const degradedActive = activeNodes.filter((n) => degradingNow.get(n.nodeId)).length;
  const frac = activeNodes.length > 0 ? degradedActive / activeNodes.length : 0;
  const threshold = wasMeshActive ? MESH_RELEASE_FRACTION : MESH_ACTIVE_FRACTION;
  const meshBreach =
    activeNodes.length >= MESH_MIN_ACTIVE && degradedActive >= MESH_MIN_DEGRADED && frac >= threshold;
  const meshSince = dwell(state, meshKey, meshBreach && !controllerEvent, now);

  let meshEventId: string | null = controllerEvent;
  if (meshSince != null) {
    meshEventId = 'mesh';
    // Disambiguate: flooding (a chatty offender) vs interference (the residual).
    if (floodNode != null) {
      out.push({
        kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: meshSince, basis: 'measured',
        evidence: [{ label: 'active nodes degraded', value: `${degradedActive}/${activeNodes.length}` }, { label: 'flooding node', value: `#${floodNode}` }],
        narrative: `Many nodes degraded together AND node #${floodNode} is flooding the mesh — the likely cause is that traffic, not RF interference. Fix the chatty device first.`,
      });
    } else {
      out.push({
        kind: 'mesh-interference', nodeId: null, severity: 'warn', sinceMs: meshSince, basis: 'inferred',
        evidence: [{ label: 'active nodes degraded', value: `${degradedActive}/${activeNodes.length} in the same window` }],
        narrative: 'Many nodes degraded together with no controller-serial or flooding cause — likely an RF-environment event (interference). No noise-floor measurement is used to confirm this yet; treat as a lead, not a verdict.',
      });
    }
  }

  // ── edge-cluster: a small correlated subset sharing ONE upstream repeater ──
  // The middle scale between a per-node symptom and a mesh-wide event: when the
  // degradation is NOT mesh-wide but ≥EDGE_MIN_MEMBERS nodes that all route
  // through a COMMON repeater are degrading together — AND that repeater itself
  // looks healthy — the shared dependency (its link, power, or placement) is the
  // single likely cause, not each node individually. Requiring the repeater to be
  // NON-degrading is the sharp signal: a repeater that is itself failing already
  // shows its own card, and the interesting case is the SILENT shared dependency.
  // Suppressed entirely while a mesh/controller event owns the story.
  const edgeReps = new Set<number>(); // repeater ids that head a matured cluster this tick
  const edgeClusters: { rep: number; repName: string; key: string; members: number[]; since: number }[] = [];
  if (!meshEventId) {
    const nodeById = new Map(nodes.map((n) => [n.nodeId, n] as const));
    // repeater id → degrading downstream member node ids that route through it.
    const byRepeater = new Map<number, Set<number>>();
    for (const node of nodes) {
      if (node.isController) continue;
      if (!degradingNow.get(node.nodeId)) continue; // only genuinely-degrading dependents
      const reps = new Set<number>();
      for (const rt of [node.stats.lwr, node.stats.nlwr]) {
        if (rt) for (const r of rt.repeaters) reps.add(r);
      }
      for (const r of reps) {
        if (r === node.nodeId) continue; // never cluster a node under itself
        if (!nodeById.has(r) || nodeById.get(r)!.isController) continue; // head must be a known, non-controller node
        if (degradingNow.get(r)) continue; // ← the head repeater must itself look healthy
        (byRepeater.get(r) ?? byRepeater.set(r, new Set()).get(r)!).add(node.nodeId);
      }
    }
    // Greedy DISJOINT assignment: largest cluster first (tie: repeater id asc), so
    // a node routed through two shared repeaters is credited to exactly ONE
    // cluster — never double-counted, double-subsumed, or double-carded.
    const candidates = [...byRepeater.entries()]
      .filter(([, m]) => m.size >= EDGE_MIN_MEMBERS)
      .sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
    const claimed = new Set<number>();
    for (const [rep, memberSet] of candidates) {
      const members = [...memberSet].filter((m) => !claimed.has(m)).sort((a, b) => a - b);
      if (members.length < EDGE_MIN_MEMBERS) continue; // dropped below quorum after earlier claims
      members.forEach((m) => claimed.add(m));
      const k = key(rep, 'edge-cluster');
      const since = dwell(state, k, true, now);
      edgeReps.add(rep);
      if (since != null) edgeClusters.push({ rep, repName: nodeById.get(rep)?.name ?? `#${rep}`, key: k, members, since });
    }
  }
  // Clear the dwell for any edge-cluster key that lost quorum, vanished, or was
  // superseded by a mesh event this tick — else a stale `since` would let a
  // re-formed cluster mature instantly (and the map would leak keys).
  {
    const stale: string[] = [];
    for (const k of state.keys()) {
      if (k.endsWith(EDGE_SUFFIX) && !edgeReps.has(Number(k.slice(0, -EDGE_SUFFIX.length)))) stale.push(k);
    }
    for (const k of stale) state.delete(k);
  }
  // Emit matured clusters and COLLAPSE their members' per-node RF faults under the
  // cluster (mirrors the mesh subsumption) so the operator sees one shared cause,
  // not N scattered cards. chatty-device is exempt (a flooding member is its own
  // story), as is the head repeater (nodeId), which is never a member.
  for (const { rep, repName, key: clusterKey, members, since } of edgeClusters) {
    out.push({
      kind: 'edge-cluster', nodeId: rep, members, severity: 'warn', sinceMs: since, basis: 'measured',
      evidence: [
        { label: 'shared repeater', value: `#${rep} ${repName}` },
        { label: 'degraded downstream', value: `${members.length} node(s): ${members.map((m) => `#${m}`).join(', ')}` },
      ],
      narrative: `${members.length} nodes that all route through repeater #${rep} (${repName}) are degrading together while the rest of the mesh is healthy, and that repeater itself is not flagged — the shared dependency (its link, power, or placement) is the likely common cause, not each node individually. Check that repeater before touching the downstream devices.`,
    });
    for (const s of out) {
      if (s.nodeId != null && s.kind !== 'chatty-device' && s.kind !== 'edge-cluster' && members.includes(s.nodeId)) {
        s.subsumedBy = clusterKey;
      }
    }
  }

  // Detection ≠ advice: under an active mesh event, DEMOTE per-node symptoms
  // (annotate, never delete) so the operator sees one event, not N faults.
  if (meshEventId) {
    for (const s of out) {
      if (s.nodeId != null && s.kind !== 'chatty-device') s.subsumedBy = meshEventId;
    }
  }

  // Rank: crit > warn > watch, then mesh/controller first, then by dwell age.
  const sevRank: Record<Severity, number> = { crit: 0, warn: 1, watch: 2 };
  out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.nodeId == null ? -1 : 1) - (b.nodeId == null ? -1 : 1) || a.sinceMs - b.sinceMs);
  return out;
}

/** Representative noise floor for margin math — the controller's measured floor
 *  if present, else the −95 dBm fallback (matches health.ts). */
function representativeFloor(input: DetectInput): number {
  const bg = input.controller?.backgroundRSSI ?? [];
  const vals = bg.filter((v) => Number.isFinite(v) && v < 0 && v > -120);
  if (vals.length === 0) return -95;
  const sorted = [...vals].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** The set of node ids with an ACTIVE (non-subsumed) symptom — for quarantine
 *  (baselines must not learn while a node is symptomatic). */
export function symptomaticNodes(symptoms: Symptom[]): Set<number> {
  const s = new Set<number>();
  for (const sym of symptoms) if (sym.nodeId != null) s.add(sym.nodeId);
  return s;
}

/**
 * Node ids with ANY active dwell entry — i.e. currently breaching a detector,
 * whether or not it has matured to a surfaced symptom. This is the correct
 * quarantine set (v0.14 review): the DESIGN invariant is that windows INSIDE a
 * symptom's dwell are excluded from the baseline, but the arming window (5 min
 * of breach before emission) is exactly "inside the dwell" — folding those bad
 * samples ratchets the baseline toward the pathology and desensitizes the very
 * detector that would catch it next time.
 */
export function armingNodes(state: SymptomState): Set<number> {
  const s = new Set<number>();
  for (const k of state.keys()) {
    const idPart = k.slice(0, k.indexOf(':'));
    const id = Number(idPart);
    if (Number.isInteger(id) && id > 0) s.add(id);
  }
  return s;
}
