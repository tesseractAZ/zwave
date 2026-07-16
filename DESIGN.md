# Learned Remediation Engine — Design

Status: **M1 — reconciled against `RESEARCH.md` (M0, verified).** Section
references like *(RESEARCH §0)* point at the load-bearing finding that grounds a
decision. The research overturned one assumption in the first draft (the TX-drop
counter — see §3.1) and that correction is now baked in.

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
   symptom requires agreeing signals (e.g. drop-rate ∧ dwell ∧ non-stale
   roster), the lesson of the ecoflow transient-zero SoC cascade.
4. **Measure before/after or it didn't happen.** Every executed action gets a
   before-window snapshot and an after-window verdict. Outcomes feed learning;
   unverifiable actions count as failures, not successes.
5. **Collapse method, never measurement.** If an input becomes unavailable,
   the detector that needs it goes dormant and says so — it does not
   approximate from a different quantity.
6. **Blast-radius discipline.** Per-node cooldowns, global rate limits, no
   network-wide actions on a schedule, no action on stale evidence, and flap
   suppression so the engine can never oscillate a mesh.

## 2. Where it sits

```
                    HA Core WS (zwave_js/*)
                          │
                 zwaveData.ts (snapshots, stats subscriptions)
                          │
        ┌─────────────────┼──────────────────────────────┐
        │                 │                              │
  historyStore.ts   evidenceStore.ts (M2, NEW)     health.ts (scores)
  (sparkline rings)  bounded per-node time-series        │
        │                 │                              │
        │            baselines.ts (M3, NEW)              │
        │            per-node learned normals            │
        │                 │                              │
        │            symptoms.ts (M3, NEW)               │
        │            detectors: dwell+hysteresis+provenance
        │                 │
        │            planner.ts (M4, NEW)  ←── outcomes.ts (M5, NEW)
        │            symptom → ranked plan       (signature×action)→success
        │                 │                          ▲
        │            executor.ts (M4, NEW)           │
        │            gates, cooldowns, before/after ─┘
        │                 │
        │                 ▼
        │        zwaveActions.ts (EXISTING chokepoint — unchanged gate)
        │
        └────────────► TUI screens: REMEDY (M4) + INTERFERENCE (M6)
                       + Activity Log lines for every engine event
```

The engine **only** mutates the mesh through the existing `ActionRunner`.
`write_actions_enabled=false` therefore hard-disables the executor exactly as
it disables the Actions Menu — one gate, two callers.

## 3. Module contracts

### 3.1 `evidenceStore.ts` (M2)

Persistent, bounded, per-node time-series on `/data`, following the
`historyStore.ts` discipline (atomic temp+rename, schema `v`, `savedAt`
staleness cap, host-boot grace for no-RTC clocks).

Per node, ring-buffered samples at the route-poll cadence (default 10 s),
downsampled to a coarse tier for multi-day horizons:

| series | source | why *(RESEARCH ref)* |
| --- | --- | --- |
| `timeoutResponse` Δ | node stats delta / window | **primary degradation signal** — ACKed Get whose report was lost; node stays Alive *(§0)* |
| `statusFlaps` | alive↔dead transitions | **the hard RF-failure event** — a listening node that fails all retries goes DEAD *(§0, §3.7)* |
| `droppedTX` Δ | node stats delta / window | **weak/noisy** — does NOT count RF ACK drops; log in context only, never alarm alone *(§0)* |
| `rtt` | node stats (EMA) | latency trend (≈ health-check latency) |
| `rssi` | node stats (per-command ACK) | signal trend — **branch on `repeaters.length`**: routed ⇒ last-hop RSSI, not the device *(§1.3)*; drop sentinels ≥125 *(§1.11)* |
| `rateKbps` | LWR `protocolDataRate` | rate-fallback flag (rule out 100-series/FLiRS/beam first) *(§2.2)* |
| `routeKey` | hash of LWR repeaters | route-churn / scheme detection *(§2.1)* |
| `routeFailedBetween` | LWR (event-driven) | names the failing hop — **transient, capture on appearance** *(§2.3)* |
| `rxReportRate` | commandsRX delta / window | chatty-device (traffic-hygiene) outlier detection *(§4.7)* |

**Counter discipline** *(§0, §1.11)*: `commandsTX` counts **successful** sends
only, and the counters are **cumulative since driver start**. The store keeps
`(t, counterSnapshot)` pairs and derives per-window deltas with a **reset guard**
(counter went backwards ⇒ driver restarted ⇒ window invalid, skip; never negative
rates). The composite the old TUI shows as "DROP %" is *timeouts-over-successes*,
**not** an attempt-failure rate — the engine surfaces the raw components, not one
misleading %.

**Reachability caveats, from the live probe (HA 2026.7.2)** *(§3.2, §3.3, §7)*:
neighbor tables, **background RSSI/SNR**, lifeline/route health checks, and
priority routes are **not exposed** by HA Core WS — driver-WS-only
(`ws://core-zwave-js:3000`), deferred to a later phase. So **SNR/noise features
are phase-2**; M2–M6 build on passive stats only. `invoke_cc_api` *is* reachable
but a NOP ping through it **can mark a flaky node DEAD** (can't pass
`changeNodeStatusOnMissingACK:false`) — consented + rate-limited, never a
background poller *(§3.4)*. **Open probe before M3:** confirm HA's node-statistics
event actually serializes the nested `lwr/nlwr` objects *(§7 #1)*.

Controller-level series (one, not per-node): controller stats deltas
(NAK/CAN/timeouts), plus `bgRssi` per channel if available — the
interference watch (M6) reads these.

Bounds: fixed ring sizes chosen so worst-case file size stays < ~1 MB for a
232-node mesh; save cadence piggybacks on the existing debounced saver.

### 3.2 `baselines.ts` (M3)

Per-node learned "normal" for each series: robust location/scale
(median + MAD, not mean/σ — drop distributions are heavy-tailed), split by
**time-of-day band** (interference is diurnal; a baby monitor at night must
not poison the daytime baseline). Minimum-evidence rule: no baseline until
N windows observed; detectors that compare-to-baseline stay dormant and say
`learning (n/N)` — never compare against a fabricated prior.

### 3.3 `symptoms.ts` (M3)

Pure functions `(evidence, baselines) → Symptom[]`. Each symptom:

```ts
interface Symptom {
  kind: SymptomKind;            // e.g. 'drop-anomaly', 'route-churn', ...
  nodeId: number | null;        // null = mesh/controller-scoped
  severity: 'watch' | 'warn' | 'crit';
  sinceMs: number;              // dwell start
  evidence: EvidenceRef[];      // provenance: series+window+values
  narrative: string;            // one-line technician-grade explanation
}
```

Initial detector set (thresholds reuse the zwave-js health-check rubric verbatim
where one exists — §3.5, so our scores match Z-Wave JS UI):

| kind | fires when (sketch) | confound it must reject *(RESEARCH ref)* |
| --- | --- | --- |
| `return-path-degraded` | windowed `timeoutResponse` rate ≫ own baseline, dwell ≥ D, min Get traffic | tiny-sample spikes; SET-only nodes (never accrue) *(§0)* |
| `dead-flap` | ≥ K alive↔dead transitions/window | driver restart (reset guard); silent node ≠ healthy *(§0, §3.7)* |
| `rate-fallback` | sustained LWR < 100k where baseline was 100k **and** no 100-series/FLiRS/beam hop in path | legacy/FLiRS capability cap; single-exchange retry *(§2.2)* |
| `route-churn` | distinct routeKeys/window ≫ baseline, or `routeSchemeState=Explore` | one legit re-route after topology change *(§2.1)* |
| `rtt-degraded` | RTT median ≫ baseline with dwell | asleep/FLiRS wake latency; EMA lag *(§1.11)* |
| `weak-signal` | low RSSI **on a direct (non-routed) node** + drop/timeout | routed node (RSSI = last hop, not device) *(§1.3)* |
| `chatty-device` | `rxReportRate` ≫ mesh median (orders of magnitude) | normal reporter; S0 3×-airtime inflation *(§4.7)* |
| `ghost-suspect` | node failed/dead with no successful-comms history | asleep battery within 2× wake interval *(§4.4, §4.6)* |
| `controller-degraded` | rising controller NAK/CAN/timeoutACK (serial link) | one node's RF problem *(§2.11)* |
| `mesh-correlated` | ≥ M nodes degrade in the SAME window (the correlation gate) | N coincidental independent faults *(§5.4)* |
| `edge-cluster` | persistent degradation on nodes that co-move with each other but not the mesh | coincidence — requires sustained correlation *(§6)* |

**The correlation gate runs first** *(§5.4)*: if `mesh-correlated` or
`controller-degraded` fires, **per-node symptoms are suppressed** and the engine
reports a single mesh-level event (interference / controller / flooding) — never
N independent node problems. Dwell + hysteresis on every detector (fire after
sustained breach, clear only below a lower release threshold). All detectors gate
on **evidence freshness**: stale roster or WS-reconnect windows produce no new
symptom state (restart-continuation suppression, as in ecoflow). Every RSSI read
rejects sentinels ≥ 125 and every counter read applies the reset guard.

### 3.4 `planner.ts` (M4)

`(Symptom, OutcomeLedger) → Plan` — a ranked list of candidate actions with
expected efficacy and cost:

```ts
interface Plan {
  symptom: Symptom;
  candidates: Array<{
    action: ActionKind;              // from actionsCatalog — no new verbs
    rationale: string;               // grounded in RESEARCH.md causal table
    expectedEfficacy: number | null; // learned; null until enough outcomes (honest null)
    cost: 'safe' | 'caution' | 'disruptive';
    blocked?: string;                // why it can't run now (cooldown, gate, stale)
  }>;
}
```

The symptom→action causal table is grounded in RESEARCH and ordered by the
spec-backed remediation sequence *(§4.3)*: **controller/interference → ghost
cleanup → traffic hygiene → repeater/placement → targeted rebuild (topology
change only) → mesh-wide rebuild (last resort)**. Key priors:

| symptom | first-line recommendation | explicitly NOT | why *(RESEARCH ref)* |
| --- | --- | --- | --- |
| return-path-degraded, good RSSI, edge-wall | **repeater placement** (interior path) | rebuild | rebuild can't fix a physically bad link and can regress a working LWR *(§4.1, §6)* |
| rate-fallback (100k-capable path) | repeater / relocate | rebuild-first | 9k6 = degraded route, not a routing-table bug *(§2.2)* |
| route-churn **with topology-change evidence** | targeted `rebuild_node_routes` | scheduled/mesh-wide rebuild | rebuild helps *only* on topology change *(§4.1, §4.2)* |
| ghost-suspect | `remove_failed_node` (verify `isFailedNode`) | rebuild a dead node | ghosts poison routes; unreachable nodes can't be rebuilt *(§4.4, §4.6)* |
| chatty-device | tune reporting / re-include S2 | any RF remedy | traffic floods the mesh; fix the cause *(§4.7)* |
| controller-degraded / mesh-correlated | USB-2 extension, relocate stick, check interference | per-node action | fleet symptom ⇒ controller side *(§4.5, §5.4)* |
| dead-flap | reachability runbook (ping→power-cycle→re-include) | rebuild | rebuild's first step queries the node — a dead node can't be repaired *(§4.4)* |

**Hard gates in the planner** *(§8)*: a **protocol predicate** removes all
route/repeater/priority candidates for **LR nodes** (rebuild *throws* on them);
rebuild candidates require **topology-change evidence** and carry the
**"may delete manual priority routes"** warning unconditionally (HA can't read
cached priority routes). Learned outcomes reweight priors per mesh *(§3.6)*, gated
by minimum-evidence (a 39-node mesh has almost no statistical power — §5.1).

The planner is **pure and always-on** — it powers the advisory REMEDY screen even
when execution is fully disabled.

### 3.5 `executor.ts` (M4)

The only module that calls `ActionRunner`, behind stacked gates:

1. `write_actions_enabled` (existing master gate).
2. `auto_remediation: list(off|advise|auto_safe)` — new option, default `off`.
   `advise` = plans surface in TUI + log; human executes via the Actions Menu
   type-CONFIRM path. `auto_safe` = engine may auto-execute **SAFE-tier only**.
   **Tiering, fixed by research** *(§3.8, §4.1, §5.5)*: **`rebuild_node_routes`
   is disruptive and priority-route-destroying — it is NEVER auto-tier**, on any
   setting; likewise anything network-wide or destructive. `refresh_values` /
   `remove_failed_node`(verified ghost) may be `auto_safe`; even a NOP **ping is
   NOT background-safe** (it can flip a marginal node to DEAD — §3.4), so it is
   consented + rate-limited, not an idle poller.
3. **Protocol predicate** — LR nodes: route/repeater/priority candidates removed
   (they *throw*) *(§1.10)*.
4. **Topology-change precondition** for any rebuild candidate; **empty/degenerate
   node-selection refuses** (Diskerase lesson — §5.2).
5. Per-node cooldown (same action ≤ 1× / `engine_cooldown_hours`, default 24 h)
   + **exponential backoff** per node *(§5.3)*.
6. Global budget: ≤ `engine_max_actions_per_hour` mesh-wide **and** a daily cap;
   **one action in flight per mesh** (the driver serializes anyway — §3.6).
7. Evidence freshness — no action on stale inputs; **quiet abort** on any WS
   wedge/reconnect *(restart-continuation)*.
8. **Busy-mesh precondition** — no diagnostic/rebuild while a chatty device or
   command burst floods the mesh (results would be invalid anyway — §3.5, §4.7).
9. **Battery/FLiRS guard** — no test-frame/active-link action against battery or
   FLiRS nodes; per-node actions on sleeping nodes **queue until next wake**, and
   their after-windows key off the next wake report, not a clock *(§4.6, §5.5)*.
10. **`backup_nvm` pre-step** before any disruptive action *(§3.8)*.
11. **Act while the user is awake** (quiet *traffic* window ≠ 2 am) so breakage is
    noticed — the nightly-heal precedent failed partly on this *(§5.2)*.

Execution protocol: snapshot before-window stats → act via ActionRunner →
wait settle period → measure after-window → emit `Outcome`. Every step is a
line in the Activity Log (source `engine`), so the existing Log screen is the
complete audit trail for free. Route rebuilds are observed (not
fire-and-forget) via `zwave_js/subscribe_rebuild_routes_progress`
(live-probed present on HA 2026.7.2) — the after-window starts when the
rebuild *finishes*, not when it's requested.

### 3.6 `outcomes.ts` (M5)

Ledger of `(symptomSignature × action) → {attempts, successes, lastAt}` with
exponential decay (old outcomes fade; a mesh changes when furniture moves).
Success = the symptom's own metric improved past its release threshold in the
after-window *and stayed there* through a confirmation window (no
regression-flap). Persisted in the evidence store file, same schema-versioned
envelope. Minimum-attempts rule before `expectedEfficacy` is non-null.

Signature = `(symptom.kind, coarse context)` — context bands, not raw node
ids, so learning transfers across similar nodes but a pathological node can't
poison the global prior. **Ship static spec-derived playbooks first, learn
second** *(§5.1)*: a 39-node mesh has almost no statistical power, and no public
Z-Wave heal-efficacy data exists to calibrate against — so learned re-ranking
only overrides a prior once minimum-attempts is met, and the honest verdict set
is `improved | no-change | worse` (the ledger must catch the rebuild-made-it-
worse case the docs predict — §4.1).

### 3.7 TUI surfaces (M4 advisory + M6 interference)

- **REMEDY screen** (`E` key): symptom list ranked by severity — each row
  expandable to evidence, causal narrative, candidate actions with learned
  efficacy, and (when actionable) a jump into the existing type-CONFIRM
  modal. Uses `chrome.ts frame()` like every other screen.
- **INTERFERENCE screen** (M6): correlated-degradation matrix, time-of-day
  degradation heatmap per node band, the edge-cluster view (nodes whose symptoms
  co-move — the patio-lights pattern), and controller serial-link health. Read-
  only. **Background-RSSI/noise-floor trend is phase-2-gated** — HA drops
  `background_rssi` at its WS boundary *(§1.5, §7)*, so M6 v1 infers interference
  from correlated timeout/rate/status signals; a real noise floor arrives only
  with the driver-WS phase or an upstream HA PR.

## 4. Config surface (additions, all safe-defaulted for strangers' meshes)

```yaml
auto_remediation: off        # off | advise | auto_safe   (list())
engine_enabled: true          # detectors + advisory always-on compute
# advanced:
engine_cooldown_hours: 24     # int(1,168) per-node same-action cooldown
engine_max_actions_per_hour: 2  # int(1,10) global engine-initiated cap
```

Everything else (dwell windows, thresholds) ships as tuned constants —
options only for the knobs a stranger genuinely needs (shareability rule:
nothing house-tuned in defaults).

## 5. Milestones

| | ships | proves |
| --- | --- | --- |
| M2 | evidenceStore + counter-delta discipline + tests | evidence is trustworthy across restarts/resets |
| M3 | baselines + detectors + REMEDY advisory screen | symptoms are right (weeks of advisory validation) |
| M4 | planner + executor in `advise` mode + gates | recommendations are grounded + auditable |
| M5 | outcome ledger + learned efficacy + `auto_safe` | the loop actually learns; automation stays inside SAFE tier |
| M6 | interference watch screen | correlated/diurnal interference is visible |
| M7 | docs + defaults audit | safe for other users' meshes |

Each lands as its own `vX.Y` (v0.11+), typecheck+tests+adversarial review,
same pipeline as v0.5–v0.10. **No publish** — private repo, local add-on.
