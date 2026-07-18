# Learned Remediation Engine — Design

Status: **M1 rev 2 — post design-review.** Reconciled against `RESEARCH.md`
(M0, verified), then adversarially attacked by a 52-agent design review before
implementation (2026-07-16): 39 confirmed + 7 partial findings — 3 blockers —
all folded into this revision. Section references like *(RESEARCH §0)* point at
the load-bearing finding grounding a decision; *(DR)* marks a rule that exists
because the design review proved its absence was exploitable.

## 1. Purpose

Turn the add-on from a *diagnostic console* into a *diagnostic technician*:
detect Z-Wave mesh symptoms from evidence, explain the probable cause with
provenance, recommend (and — behind explicit opt-in — execute) the remediation
with the best measured track record, and verify whether it actually helped.

Design tenets (inherited from the ecoflow-panel engine, battle-tested there):

1. **Advisory first.** The engine earns trust by being right while doing
   nothing. Automated execution is a separately gated, off-by-default final
   step — never the starting posture.
2. **Evidence or silence.** Every symptom carries provenance (which samples,
   which window, which baseline). No fabricated numbers: an unknown renders as
   `—`, never a guess (honest-nulls rule).
3. **Coherence over single signals.** No detector fires off one counter. A
   symptom requires agreeing signals (e.g. timeout-rate ∧ dwell ∧ fresh
   evidence), the lesson of the ecoflow transient-zero SoC cascade.
4. **Measure before/after or it didn't happen.** Every executed action gets a
   before-window snapshot and an after-window verdict. Outcomes feed learning;
   unverifiable actions never count as successes.
5. **Collapse method, never measurement.** If an input becomes unavailable,
   the detector that needs it goes dormant and says so — it does not
   approximate from a different quantity.
6. **Blast-radius discipline.** Per-node cooldowns, global rate limits, no
   network-wide actions on a schedule, no action on stale evidence, and flap
   suppression so the engine can never oscillate a mesh.
7. **Confidence is part of the answer** *(DR)*. Every symptom narrative and
   every plan candidate carries a `basis` label (measured vs inferred vs
   lore); the UI must never render an inference or a construction-class
   heuristic in the same voice as a measurement.

## 2. Where it sits

```
        HA Core WS (zwave_js/*)          driver WS ws://core-zwave-js:3000
        actions + telemetry              READ-ONLY telemetry (v0.13, §2.1)
                 │                                   │
                 └───────────┬───────────────────────┘
                    zwaveData.ts (snapshots, stats + node-status subscriptions)
                             │
        ┌────────────────────┼──────────────────────────────┐
        │                    │                              │
  historyStore.ts   evidenceStore.ts (M2)             health.ts (scores)
  (sparkline rings)  fine ring + coarse tier +              │
        │            event accumulators + coverage          │
        │                    │                              │
        │            baselines.ts (M3)                      │
        │            per-node learned normals (persisted aggregates)
        │                    │
        │            symptoms.ts (M3)
        │            detectors: dwell+hysteresis+provenance+basis
        │                    │
        │            planner.ts (M4)  ←── outcomes.ts (M5, advisory)
        │            symptom → ranked plan    episodes (action AND no-action)
        │                    │                          ▲
        │            executor.ts (DEFERRED — not built)  │
        │            gates, cooldowns  ·  human type-CONFIRM populates ┘
        │                    │  (advisory-only: operator runs actions)
        │                    ▼
        │        zwaveActions.ts (EXISTING chokepoint — unchanged gate)
        │
        └────────────► TUI screens: REMEDY (M4) + INTERFERENCE (M6)
                       + Activity Log lines for every engine event
```

The engine **only** mutates the mesh through the existing `ActionRunner`, and
**all actions ride the HA WS** — the driver WS is never used for anything that
transmits RF or mutates state. `write_actions_enabled=false` hard-disables the
executor exactly as it disables the Actions Menu — one gate, two callers.

### 2.1 Read-only driver-WS evidence client (v0.13) *(DR — pulled forward)*

The design review's data-source comparison was decisive: the driver WS is a
strict diagnostic superset of HA Core WS. Decisive driver-only items:
**background RSSI / noise floor** (the only path to real SNR margin and the
DrZWave jamming recipe — HA's `api.py` verifiably strips it), lifeline/route
**health checks** (the real 0-10 rating, with the only mark-dead-safe ping),
**neighbor tables**, **cached lifeline + priority-route reads** (the documented
pre-rebuild safety check), node `last_seen`, and `isListening`/FLiRS flags.
Interference monitoring — a top user priority — is *impossible* via HA alone.

Therefore a **strictly read-only** driver-WS evidence client is pulled forward
from "phase-2 someday" to **v0.13, before M3's baseline schema freezes**, under
hard conditions:

- **Closed command allowlist**: `initialize`/`set_api_schema`,
  `start_listening` (state + statistics events incl. `backgroundRSSI`),
  `controller.get_known_lifeline_routes`, cached priority-route reads. **NO
  health checks, NO pings, NO route surgery, nothing that transmits RF.**
  Active health checks stay behind the consent/quiet-window machinery M4/M5
  build.
- **All actions stay on HA WS** through M5 (and beyond, until a separate
  design pass).
- Config: `driver_ws_url` defaulting to `ws://core-zwave-js:3000`;
  empty = disabled. Z-Wave JS UI users point it at their server or disable it.
- **Unreachable / schema-mismatch ⇒ dependent detectors go dormant and say
  so** (collapse method, never measurement) — never a startup failure.
- Pin `schemaVersion ≥ 32` (command renames at 32); refuse outside the tested
  range, log the negotiated schema.
- The socket is unauthenticated: treat it as privileged, **never proxy or
  re-expose it** (not to the TUI, not to ingress, not to logs verbatim).

The M2 evidence schema **reserves fields now** for what v0.13 will feed
(per-channel `bgRssi` in controller samples; per-node `lastSeen`,
`isListening`) so the client lands without a schema migration or baseline
re-learn.

## 3. Module contracts

### 3.1 `evidenceStore.ts` (M2 — reworked per DR)

Persistent, bounded, per-node time-series on `/data`, following the
`historyStore.ts` discipline (atomic temp+rename, schema `v`, host-boot grace
for no-RTC clocks) — plus the disciplines the design review proved necessary:

**Two tiers, both M2 exit criteria** *(DR blocker: baselines had no substrate)*:

- **Fine ring**: one sample per node per route-poll tick (default 10 s),
  ~40 min horizon — feeds recent-window detectors and the after-window
  verifier.
- **Coarse tier**: 30-minute buckets × 14 days per node — feeds baselines
  (bands are multi-hour; 30 min resolution is ample). Each bucket: sample
  count, fresh count, invalid-window count, Σ of each valid delta, flap +
  route-change counts, min/sum/max of *fresh* rssi + rtt, min rate. Staleness
  is **per-tier**: the 1 h `maxAge` applies to the fine ring only; coarse
  buckets are pruned individually to the 14-day horizon. A 3-day-old coarse
  bucket is valid history, not stale state. Under **boot-grace** (untrusted
  clock) the coarse tier and coverage metadata still load — only the
  recency-dependent fine ring is discarded; a daily power blip must not wipe
  two weeks of baseline substrate.

**Per-sample shape** (fine tier):

| field | source | why *(ref)* |
| --- | --- | --- |
| `dTx dTimeout dDropTx dRx` | counter deltas w/ guards | rate math; dTimeout is the primary signal *(§0)* |
| `dFlaps` | **event-driven accumulator** from `zwave_js/subscribe_node_status`, drained per sample | the hard RF-failure event — level-sampling misses sub-window flaps *(DR)* |
| `dRouteChanges` | accumulator from the existing route-change diff | route churn *(§2.1)* |
| `fresh` | did a stats event arrive since the previous sample? | pseudo-replication guard: EMAs re-sampled without new events carry no information *(DR)* |
| `rtt`, `rssi` | node stats (EMA; sentinels ≥125 ⇒ null) | trend — **meaningful only when `fresh`** *(§1.11, DR)* |
| `rateKbps`, `routeKey` | LWR | rate-fallback + churn *(§2.2)* |
| `status` | roster level at capture | dwell context only — **never diffed for flaps** *(DR)* |
| `lastSeen`, `bgRssi[ch]`, `isListening` | **reserved** (null until v0.13) | schema stability *(§2.1)* |

Separately, a small per-node **route-failure ring** captures
`routeFailedBetween` event-driven at the moment it appears (it is transient —
overwritten on the next OK transmission, §2.3), never by polling.

**Counter discipline** *(§0, §1.11, DR)*:

- Counters are cumulative since driver start; deltas come from `(t, snapshot)`
  pairs.
- **Whole-window invalidation**: if ANY counter moved backwards, ALL deltas
  for that sample are null — one driver, one restart, one shared lifetime.
  (Per-field nulling let cross-lifetime deltas through.)
- **Max-window bound**: if the gap since the previous sample exceeds ~3× the
  cadence, all deltas null and the window re-baselines — long gaps are not
  time-attributable.
- **Plausibility bound**: a delta exceeding what Z-Wave's shared ~10–20 msg/s
  bandwidth could physically carry in the window ⇒ null + log. This is the
  backstop against fabricated deltas (e.g. a malformed event coerced to 0
  becoming a full-lifetime delta on the next sample).
- **Counters are validated at the source**: `onNodeStats` rejects an event
  whose counter fields are missing/non-finite rather than coercing to 0 — the
  coercion was the fabrication path.
- `null` means "cannot know this window" — absence of evidence, never
  evidence of health.

**Integrity + coverage** *(DR)*:

- The persisted envelope carries the controller **`homeId`**; on the first
  poll that reveals the live home id, a mismatch discards restored evidence
  (and `reset()` immediately rewrites the on-disk file, so a crash cannot
  resurrect the old network's rings).
- **Coverage metadata** that survives ring eviction and restarts: store-level
  `recordingSince`, per-node `firstSampleAt` + cumulative sample/fresh
  counts. "No evidence rows" must be distinguishable from "node never
  communicated" — the ghost detector depends on this (§3.5).
- **Wedge guard**: when the roster/stats feed itself is stale (no successful
  poll within ~2× the refresh cadence), sampling **skips the tick** — a gap in
  the ring is honest; a fabricated healthy window is not. The shutdown flush
  saves but does not synthesize a fresh-timestamped sample from stale caches.
- Per-node statistics subscriptions are **retried** on failure, not
  fire-and-forgotten; subscription state is part of coverage.

**Controller ring** (one, not per-node): controller serial-link stats
(NAK/CAN/timeoutACK/timeoutResponse/messages) through the same delta+guard
path, with reserved per-channel `bgRssi` fields (v0.13) — the interference
watch (M6) and the controller-degraded detector read these.

**Bounds, enforced not asserted** *(DR)*: on-disk format is genuinely columnar
(parallel arrays per field per node); rtt rounded; all-quiet coarse buckets are
omitted (a missing bucket = no fresh observations, which is exactly what it
contributes to a baseline). Honest math (re-measured after the
review caught the first estimate under-populating columns): worst case ≤ 80 KB/
node serialized (fine 240×10 s + coarse 672×30 min, every column at maximal
width), so **≈3 MB for a 39-node mesh, scaling linearly** (a 232-node mesh
≈ 19 MB on /data — bounded and documented, not the old aspirational "1 MB"
which the review showed was arithmetic fiction; typical real files run far
smaller thanks to sparse buckets and quiet columns). A unit test enforces the
per-node worst case. Flushes are dirty-flagged on a ~5-minute
cadence plus shutdown — not a fixed full-file rewrite every 30 s (SD-card write
amplification).

### 3.2 `baselines.ts` (M3 — statistics specified per series, DR)

Per-node learned "normal", split by **time-of-day band** and — for rssi/rtt —
**stratified by `routeKey`** (a route change legitimately shifts both; a
mixture baseline both false-fires on benign re-routes and mask-inflates MAD).
Baselines are **persisted aggregates** (incremental quantile structures per
node × series × band), updated once per aggregation window, in the same
schema-versioned envelope — they must survive restarts and outages; the raw
fine ring's 1 h staleness cap does NOT apply to them.

**The statistic is per-series — one formula does not fit** *(DR)*:

| series class | statistic | degenerate-case rule |
| --- | --- | --- |
| counting (dTimeout, dDropTx, flaps, route changes) | **rate over an aggregation window with a minimum-traffic denominator** (Σd/ΣdTx over ≥T min, ΣdTx ≥ D), tested with a Poisson/binomial tail | mostly-zero series ⇒ MAD is 0 by construction — never use location/scale on counts |
| continuous (rssi, rtt) | median + MAD over **fresh samples only** | **MAD floor tied to instrument precision** (≥3 dB rssi, ≥1 EMA step rtt — §1.11); MAD below floor ⇒ "insufficient dispersion evidence", never infinite precision |
| discrete (rateKbps, routeKey) | categorical change/dwell detection | never location/scale |

**Honest learning units** *(DR)*: minimum-evidence counts **independent
observations** — windows containing actual traffic (`fresh` / dTx > 0), with
coverage across ≥K distinct days per band — never raw 10 s snapshots (which
are ~99% autocorrelated duplicates of driver EMAs). The dormant state renders
as `learning: 3/7 days × active windows`, and detectors stay dormant until
their band graduates.

**Baseline lifecycle** *(DR)*:

- **Quarantine**: windows inside an active symptom's dwell are excluded from
  baseline updates — the baseline must not chase the pathology. Quarantine is
  bounded: after K weeks of continuous symptom, force a logged re-baseline
  rather than diverge forever.
- **Decay**: aggregates decay with a stated half-life so improvements are
  absorbed deliberately, not never.
- **Forced re-baseline triggers**, each logged: routeKey change (for
  rssi/rtt strata), re-interview, `replace_failed_node` (node-id reuse means a
  different physical device), controller home-id change.

**Division of labor — written down** *(DR)*: the health score answers "how is
this node NOW, in absolute terms"; relative detectors answer "did it CHANGE
from its own normal"; the **chronic-absolute detector** (§3.3) bridges the gap
a compare-to-own-baseline engine cannot see — a node that has been bad since
inclusion. All three surface on REMEDY; none substitutes for another.

### 3.3 `symptoms.ts` (M3)

Pure functions `(evidence, baselines) → Symptom[]`. Each symptom:

```ts
interface Symptom {
  kind: SymptomKind;
  nodeId: number | null;        // null = mesh/controller-scoped
  severity: 'watch' | 'warn' | 'crit';
  sinceMs: number;              // dwell start
  evidence: EvidenceRef[];      // provenance: series+window+values
  basis: 'measured' | 'inferred'; // is this observed or a diagnosis-of-exclusion? (DR)
  subsumedBy?: string;          // active mesh-event id demoting (not deleting) this row (DR)
  narrative: string;            // one-line technician-grade explanation
}
```

Initial detector set (thresholds reuse the zwave-js health-check rubric
verbatim where one exists — §3.5):

| kind | fires when (sketch) | confound it must reject *(ref)* |
| --- | --- | --- |
| `return-path-degraded` | windowed per-command timeout **rate** (ΣdTimeout/ΣdTx, min denominator) ≫ own baseline, dwell ≥ D | tiny samples; traffic-volume shifts (rate not count — DR); SET-only nodes *(§0)*; carries a Get-mix caveat until the Supervision question is resolved *(RESEARCH §7)* |
| `chronic-return-path` | per-command timeout rate above the **absolute** health-check-rubric threshold, sustained D days — baseline-independent | the bad-since-inclusion node invisible to relative detectors *(DR)* |
| `dead-flap` | ≥ K transitions/window from the **`dFlaps` event counter** — never from diffing the status column | driver restart (reset guard); silent node ≠ healthy *(§0, DR)* |
| `quiet-node` | mains **listening** node whose last-activity age ≫ its own learned reporting cadence — emits honest "unreachability unknown, no traffic attempted" (state ≠ healthy) | battery/FLiRS within wake interval; nodes with no learned cadence yet *(DR; §3.7)* |
| `rate-fallback` | the **same routeKey** that previously sustained 100k now persistently below 100k — same-route regression needs no capability data *(fail-closed: cross-route comparison excluded until driver-WS capability data exists — DR)* | legacy/FLiRS capability cap; single-exchange retry *(§2.2)* |
| `route-churn` | routeKey churn ≫ baseline + rate/RTT corroboration (**routeSchemeState does not exist on either WS — dropped**; explorer detection only ever as a labelled best-effort log parse) | one legit re-route after topology change *(§2.1, DR)* |
| `rtt-degraded` | RTT median over **fresh** samples ≫ route-stratified baseline, dwell | route change (settle window); EMA lag; wake latency *(§1.11, DR)* |
| `weak-signal` | low RSSI **on a direct (non-routed) node** + timeout corroboration | routed node (RSSI = last hop, not the device) *(§1.3)* |
| `diurnal-degradation` | a node's band median vs its own other-band medians AND vs the mesh same-band norm — persistent night-vs-day asymmetry | time-of-day banding otherwise makes recurring diurnal interference *permanently invisible* — the banding rationale, inverted *(DR)* |
| `chatty-device` | dRx rate ≫ mesh median (orders of magnitude) | normal reporter; S0 3×-airtime *(§4.7)* |
| `ghost-suspect` | requires **proven coverage**: store recording the node ≥N days with live subscriptions, zero successful comms AND zero non-dead status in that span; a young/empty store yields `insufficient history (n/N days)`, never a ghost verdict | rarely-woken battery node; store just wiped; subscription failure *(DR blocker)* |
| `controller-degraded` | rising controller NAK/CAN/timeoutACK (serial link) | one node's RF problem *(§2.11)* |
| `mesh-correlated` | breadth over **nodes-with-observable-traffic-in-window** (≥30–40% of active nodes, never an absolute K), sustained ≥2–3 consecutive windows, or corroborating controller-stats degradation | pipeline artifacts: post-gap windows are invalid for correlation (queued deltas aren't time-attributable); single-window unanimity after silence is evidence about the pipeline, not the mesh *(DR)* |
| `edge-cluster` | a **small correlated subset** with shared-signature evidence: shared repeater/`routeFailedBetween` hop, same-band co-movement, co-onset — the explicit tier between per-node and mesh-level | coincidence (two nodes breaching different metrics at unrelated hours) *(§6, DR)* |

**Detection vs advice — two layers, never conflated** *(DR)*:

- **Detection/evidence**: every detector always computes; dwell accumulates
  from the evidence store continuously and is **never reset, paused, or
  suppressed** by another symptom's state.
- **Advice/presentation**: when a mesh-level event is active, per-node
  symptoms are still emitted but annotated `subsumedBy` — the planner and TUI
  demote them, never delete them. `edge-cluster` reads the evidence store and
  per-node detector state directly, never the post-gate symptom list.

**Mesh-level disambiguation is a ladder, not a label** *(DR)* — evidence
strength first, and never two mesh-scoped symptoms at once:

1. **controller-degraded** (direct serial-link counters — deterministic
   evidence) wins and subsumes mesh-correlated;
2. **flooding** — a `chatty-device` whose dRx outlier onset precedes/coincides
   with the fleet degradation; the chatty symptom is a CAUSE hypothesis and is
   **exempt from suppression by construction**; advice targets the offender;
3. **interference** — the explicit residual, `basis: 'inferred'`, severity
   capped at `warn`, and the narrative must state "no noise-floor measurement
   available (arrives with the driver-WS client)" until v0.13 corroboration
   exists.

The mesh gate has its own dwell plus an RFC-2439-style decaying-penalty hold
with burst-tolerant thresholds *(§5.3)*: a duty-cycled interferer produces ONE
sustained mesh event with a duty-cycle annotation — one Activity Log line at
open, one at close, flap count folded in.

Every RSSI read rejects sentinels ≥125; every counter read honors null
windows; rssi/rtt ingestion uses **fresh samples only**.

### 3.4 `planner.ts` (M4)

`Symptom → Plan` — a pure, ranked list of candidates (as-built, M4):

```ts
interface Plan {
  kind: SymptomKind;
  nodeId: number | null;
  headline: string;                  // one-line lead recommendation
  candidates: Array<{
    action: ActionKind | null;       // existing verb, or null = PHYSICAL guidance (the majority)
    title: string;
    rationale: string;               // grounded in the RESEARCH causal table; NO numeric dB claims
    basis: 'spec' | 'source' | 'empirical' | 'lore' | 'inference' | 'learned'; // worst-of when chained (DR)
    cost: 'physical' | 'safe' | 'caution' | 'disruptive' | 'destructive';
    blocked: string | null;          // terse reason it can't run now (gate, protocol, precondition)
  }>;
}
```

> `expectedEfficacy` and the `OutcomeLedger` input join in M5 (the learned
> reweighting needs the episode ledger + no-action control arm; §3.6). The M4
> planner is pure `Symptom → Plan` — no history dependency, so it is trivially
> testable and can't regress on a cold ledger. Note the added `action: null`
> case: most correct Z-Wave remediations are **physical** (place a repeater,
> move the stick), not executable verbs — so physical guidance is a first-class
> candidate, and the executable actions are the minority.

The REMEDY screen must render `basis` (e.g. *likely — construction-class
heuristic* vs *confirmed — driver behavior*); **no numeric dB claims in any
rationale template** (M7 ships a lint for this). The causal table is
machine-readable and keyed to RESEARCH sections.

| symptom | first-line recommendation | explicitly NOT | why *(ref)* |
| --- | --- | --- | --- |
| return-path-degraded, good RSSI, edge-wall | **repeater placement** (interior path) — basis: lore | rebuild | rebuild can't fix a physically bad link *(§4.1, §6)* |
| rate-fallback (same-route regression) | repeater / relocate | rebuild-first | 9k6 = degraded route, not a routing-table bug *(§2.2)* |
| route-churn **with topology-change evidence** | targeted `rebuild_node_routes` | scheduled/mesh-wide rebuild | rebuild helps *only* on topology change *(§4.1, §4.2)* |
| ghost-suspect (coverage-proven) | `remove_failed_node` — **advise-only, always type-CONFIRM** | rebuild a dead node; any auto path | destructive; the removal attempt is itself the only in-band verification *(§4.4, DR)* |
| chatty-device / flooding | tune reporting / re-include S2 | any RF remedy | traffic floods the mesh; fix the cause *(§4.7)* |
| edge-cluster | shared-path diagnosis: repeater/placement for the cluster | treating as N independent faults, or as mesh-wide | the patio-pair case *(§6, DR)* |
| controller-degraded | USB-2 extension, relocate stick | per-node action | serial-link symptom ⇒ controller side *(§4.5)* |
| mesh-correlated (interference residual) | environment survey; driver-WS noise floor when available | per-node actions | inferred-by-exclusion until measured *(DR)* |
| quiet-node | consented, rate-limited ping (never background) | marking unhealthy outright | absence of traffic ≠ absence of node *(§3.4, DR)* |
| dead-flap | reachability runbook (ping→power-cycle→re-include) | rebuild | a dead node can't be repaired *(§4.4)* |

**Hard gates in the planner**: protocol predicate removes route/repeater/
priority candidates for **LR nodes** (rebuild *throws*); rebuild candidates
require **topology-change evidence** and carry the **"may delete manual
priority routes"** warning until v0.13's cached-route read replaces it with a
real check; learned reweighting only after §3.6's controls are met.

The planner is **pure and always-on** — it powers the advisory REMEDY screen
even when execution is fully disabled.

### 3.5 `executor.ts` (DEFERRED — not built; owner chose advisory-only)

> **As-built status.** M4 shipped the planner (§3.4) + advisory REMEDY surface;
> **M5 (v0.16) shipped the learning loop (§3.6) — also advisory-only.** In
> `advise` mode there is **no new execution path**: the planner surfaces
> recommendations and the human runs the executable ones through the *existing*
> type-CONFIRM Actions Menu (v0.9); the outcome ledger's "action arm" is
> populated by exactly those operator actions. `executor.ts` — the gate-stack
> below — and the `auto_remediation` config knob only earn their existence when
> an **auto** tier drives actions itself. **The owner explicitly chose to keep
> the engine advisory-only, so this module and `auto_remediation` are NOT built**
> and remain a future opt-in; if they are ever built, auto-execution's safety
> must be surfaced and agreed first. The gate-stack below is the design of record
> for that future tier.

The (future) module that would call `ActionRunner` autonomously, behind stacked gates:

1. `write_actions_enabled` (existing master gate).
2. `auto_remediation: list(off|advise|auto_safe)` — default `off`. `advise` =
   plans surface in TUI + log; human executes via type-CONFIRM. **`auto_safe`
   = refresh-class reads only** (`refresh_values`). *(DR blocker resolved:)*
   **`remove_failed_node` is destructive and NEVER auto-tier** — it is
   advise-only behind type-CONFIRM, requires §3.3's coverage-proven ghost
   evidence, and `isFailedNode` is **not queryable via HA WS**: the removal
   attempt is the only in-band verification, which is precisely why it can
   never be automated. A driver refusal (node responded) is recorded as
   **diagnosis refuted**, not action failure (§3.6). `rebuild_node_routes`
   stays NEVER auto-tier; ping is consented + rate-limited, never a background
   poller *(§3.4)*.
3. **Protocol predicate** — LR nodes: route/repeater/priority candidates
   removed *(§1.10)*.
4. **Topology-change precondition** for any rebuild; **empty/degenerate
   node-selection refuses** (Diskerase — §5.2).
5. Per-node cooldown (≤1× / `engine_cooldown_hours`, default 24 h) +
   exponential backoff *(§5.3)*.
6. Global budget: ≤ `engine_max_actions_per_hour` + a daily cap; **one action
   in flight per mesh** *(§3.6)*.
7. Evidence freshness — no action on stale inputs; quiet abort on WS
   wedge/reconnect.
8. **Busy-mesh precondition** — no diagnostic/rebuild while flooding is
   active *(§3.5, §4.7)*.
9. **Battery/FLiRS guard** — no test-frame actions against battery/FLiRS
   nodes; sleeping-node actions queue until wake; their after-windows key off
   the next wake report *(§4.6, §5.5)*.
10. **`backup_nvm` pre-step** before any disruptive action *(§3.8)*.
11. **Act while the user is awake** (quiet *traffic* window ≠ 2 am) *(§5.2)*.

Execution protocol: before-window snapshot → act via ActionRunner → settle →
after-window → `Outcome`. Every step is an Activity Log line (source
`engine`). Rebuilds are observed via `subscribe_rebuild_routes_progress`
(live-probed) — the after-window starts when the rebuild *finishes*. An
after-window without fresh evidence (wedge, no traffic) yields
**`unverifiable`**, never `improved` *(DR)*.

### 3.6 `outcomes.ts` (M5 — episodes, not just actions; DR)

> **As-built (v0.16, advisory-only per the owner's decision).** The ledger is
> `server/src/zwave/outcomes.ts` — a pure store wired into `runEngine`'s symptom
> lifecycle: an episode OPENS when a non-subsumed symptom appears (a subsumed
> one's fate belongs to the mesh event, so counting it would pollute the base
> rate) and RESOLVES only after the symptom has stayed gone through a 10-min
> confirmation window (a blink of improvement is not a recovery, and the dwell
> lets the after-window settle past the transition). The "action arm" is
> populated by operator type-CONFIRM actions via the ActionRunner's `onOutcome`
> hook (attributed to every open episode on the acted node); NO engine-initiated
> execution this milestone. `expectedEfficacy` feeds the planner (§3.4) and the
> Remedy screen renders "✓ helped X% vs Y% self-heal (n)" or "≈ not
> distinguishable from self-healing (n)" — never a claim while `n < min`.

The ledger records **every symptom episode**, action taken or not — the
no-action episodes are the control arm the learned layer cannot be honest
without:

- **Verdicts**: `improved | no-change | worse | refused-misdiagnosis |
  unverifiable`. `refused-misdiagnosis` (a driver refusal — e.g.
  `remove_failed_node` on a node that responds — keyed to the **symptom**,
  raising that detector's false-positive bar without touching action efficacy)
  exists in the model but is **NOT auto-detected in M5**: the operator-action
  hook cannot reliably tell a genuine refusal from a transient WS error, and a
  node-scoped stamp would wrongly mark non-ghost symptoms. Only *successful*
  operator actions are recorded; refusal detection is reserved for a future
  executor (§3.5) that receives structured driver errors. So in M5 an action
  either records a success/failure via the recovery window, or is not attributed.
- **Spontaneous-recovery base rate** per symptom kind, measured from episodes
  that resolved with no action — the control arm. *(As-built:)* it is collected
  by **this ledger once it runs (M5+), advisory-only**, from live operator
  behaviour; the patio-lights-healing-unaided case is exactly this datum. (The
  design originally slated collection for M3's advisory weeks, but the ledger
  itself is M5, so that is where the base rate accrues.)
- **Success** = the symptom's own *per-command rate* (never a count) improved
  past its release threshold in the after-window, **exceeded the base rate by a
  minimum effect size** (and cannot claim to beat a base rate that has not yet
  been measured), and the before/after windows carried **comparable traffic**
  (tx within a factor band, both above a floor) — otherwise `unverifiable`
  *(DR: traffic-mix shifts must not poison stats in either direction)*. The
  "stayed through a confirmation window" requirement is enforced upstream: the
  episode only resolves after the symptom is gone for 10 minutes.
- `expectedEfficacy` stays null until the action **beats the no-action arm**
  — not merely until minimum-attempts — and renders with its n and a
  "not distinguishable from self-healing" state.
- Exponential (per-episode) decay; the action arm is keyed by
  `(symptom.kind, action, time-of-day band)`.

### 3.7 TUI surfaces (M4 advisory + M6 interference)

- **REMEDY screen** (`7`/`y`): symptoms **severity-sorted** (crit→warn→watch,
  recency tiebreak) so the worst are never buried — chronic-absolute rows rank
  alongside anomalies *(DR)*. Each block shows evidence, a one-line narrative
  with `basis`, then the planner's ranked candidates: a marker (▸ executable /
  · physical), title, `[cost · basis]` tag, and — when blocked — a terse inline
  `⊘` reason. Executable candidates are run through the existing Actions Menu +
  type-CONFIRM (no execution from this screen). Subsumed rows render demoted
  under their mesh event and carry **no standalone plan** (the mesh event owns
  the recommendation). The screen does not scroll: it builds worst-first and
  ends with an honest "▾ N more not shown" footer rather than dropping a
  critical silently. Per-candidate learned efficacy annotations shipped in M5
  (v0.16): a runnable candidate shows "✓ helped X% vs Y% self-heal (n)" once the
  action beats the control arm, or "≈ not distinguishable" — never on a blocked
  or anti-pattern candidate.
- **INTERFERENCE screen** (M6, v0.17 — key `8`/`f`): as-built it shows the
  measured per-channel **background-RSSI noise floor** (median = the masthead
  value) + a fixed-scale −110..−80 dBm trend spark; **controller serial-link
  health** (NAK/CAN/timeout-ACK per-hour, shown apart because a serial fault
  mimics mesh-wide RF trouble — reply-timeout is reported but never sets the
  band); a **diurnal (hour-of-day) heatmap of the mesh-wide RAW timeout rate**
  summed across every node's coarse buckets — deliberately **NOT
  baseline-relative** *(DR: banded baselines are blind to recurring diurnal
  interference by construction — the heatmap is the human's view of what the
  bands absorbed)*, absolute-scaled (0→5%) with an honest "building" state until
  the coarse tier spans the day and null (·) cells for no-traffic hours; and the
  current **correlated-degradation** state from the mesh-interference detector.
  The heavy coarse fold is memoized in `data.interference()` (the screen is pure
  render). The edge-cluster detector/view is not built (no edge-cluster detector
  shipped in M3); it remains future work.

## 4. Config surface (additions, all safe-defaulted for strangers' meshes)

```yaml
# auto_remediation: DEFERRED — the executor tier (§3.5) is NOT built (owner chose
#   advisory-only). This knob lands only if/when auto-execution is ever built.
engine_enabled: true          # detectors + advisory always-on compute
driver_ws_url: "ws://core-zwave-js:3000"  # read-only telemetry; empty = disabled (v0.13)
# advanced:
engine_cooldown_hours: 24     # int(1,168) per-node same-action cooldown
engine_max_actions_per_hour: 2  # int(1,10) global engine-initiated cap
```

Everything else (dwell windows, thresholds, bands) ships as tuned constants —
options only for knobs a stranger genuinely needs.

## 5. Milestones

| | ships | proves |
| --- | --- | --- |
| M2 (v0.12) | reworked evidence substrate: fine+coarse tiers, event-driven flaps/route accumulators, freshness, homeId binding, coverage metadata, controller ring, columnar persistence w/ size test | evidence is trustworthy across restarts/resets/wedges — every DR substrate finding closed |
| v0.13 | read-only driver-WS evidence client (§2.1) | noise floor + last_seen + capability flags feed the reserved schema before baselines learn |
| M3 (v0.14) | baselines (per-series statistics) + detectors + REMEDY advisory | symptoms are right — detectors arm only after their bands graduate (days × active windows) |
| M4 (v0.15) | planner (pure, always-on) + advisory REMEDY surface — severity-sorted, cost/basis-tagged candidates, honest overflow; `advise` runs via the existing type-CONFIRM Actions Menu (no new execution path) | recommendations grounded + auditable, with `basis` labels; rebuild never offered as a runnable candidate |
| M5 (v0.16) | episode ledger (`outcomes.ts`) + learned efficacy on the Remedy screen — **advisory-only**: the action arm is populated by operator type-CONFIRM actions; the spontaneous-recovery control arm accrues from untouched recoveries | the loop learns honestly against a no-action control arm; an action is credited only when it beats self-healing by a real margin with comparable traffic |
| ~~executor~~ | `executor.ts` gate-stack + `auto_remediation` (off/advise/auto_safe) — **DEFERRED, not built** (owner chose advisory-only); design of record kept in §3.5 for a future opt-in | — |
| M6 (v0.17) | interference-watch screen (key `8`/`f`): measured noise floor + trend, controller serial-link health, diurnal raw-timeout-rate heatmap, correlated-degradation state | correlated/diurnal interference visible; measured (driver-WS noise floor), not inferred; heatmap raw not baseline-relative |
| M7 (v0.18) | complete `DOCS.md` system & engine reference (12 chapters) + `SECURITY.md` + a printable `.docx`/`.pdf` manual built in CI (`scripts/build-docs-docx.py`). The no-dB-numbers guard already ships as a planner test (`no candidate fabricates a numeric dB claim`); defaults are safe-defaulted for strangers' meshes (read-only, driver-WS empty=disabled) | the whole system is documented from source; the offline manual stays current; safe for other users' meshes |

Each lands as its own `vX.Y`, typecheck+tests+adversarial review, same
pipeline as v0.5–v0.11. **No publish** — private repo, local add-on.
