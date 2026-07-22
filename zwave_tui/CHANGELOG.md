# Changelog

## 0.22.0 — 2026-07-21

**Per-device detail: live entity state + configuration parameters** (Phase 2 of
the per-device pass). The Node Detail screen becomes a scrollable, full-screen
dossier that answers "what is this device doing right now, and how is it set up?"

- **LIVE ENTITIES section.** Every Home Assistant entity on the node, joined with
  its **current state** — a light's on/off + dimmer %, a sensor's value + unit, a
  binary_sensor read through its device-class (motion → *detected*, door → *open*),
  climate mode + setpoint/current temp, cover open/closed + position, lock state,
  firmware-update availability, and a button/event's last-fired age. State is
  seeded from `get_states` and kept live by the existing `state_changed`
  subscription (attribute-only changes, like a dimmer level moving, update too).
- **CONFIG PARAMETERS section.** The device's Z-Wave configuration values via
  `zwave_js/get_config_parameters` (lazy per-node fetch, cached): each parameter's
  label, current value + unit, and the **enum meaning** of that value (e.g.
  `LED Indicator  2 · Always off`). Read-only parameters are marked `(ro)`.
  Shows an honest *loading / unavailable / none* line while it resolves.
- **The dossier scrolls.** It's now taller than a terminal, so `↑`/`↓`/`j`/`k`
  scroll (page with `space`/`b`, `g`/`G` for top/bottom) and a `a–b/N` position
  token rides in the title rule. Node stepping moves to `<`/`>` (unshifted `,`/`.`
  aliases); the command bar advertises the real keys.

This release is read-only: it surfaces state + configuration but changes nothing.
Device control (turn on/off, set a parameter) lands next, behind the existing
write-actions + type-CONFIRM safety gate.

## 0.21.0 — 2026-07-18

**Accuracy + dead-command fixes** (from a novel 5-dimension adversarial audit of
the whole TUI). Phase 1 of a larger per-device pass; the remaining phases add
live entity state, config parameters, and device control/testing.

- **Signal cell no longer lies for dead / routed nodes** (accuracy). The Overview
  MARGIN/RSSI cell and the Detail LIVE LINK rows rendered a node's *cached* RSSI
  as a live, health-coloured signal even for a **dead** node (a green "+32 dB"
  beside its ✕) and for a **routed** node (whose `stats.rssi` is the last-hop
  ACK reading, not the device's own). Now a dead/unknown node shows `—` (no live
  reading), and a routed node's value is shown **neutral grey** with a `last-hop`
  note — matching the guards the health score and heatmap already applied.
- **Dead `[⏎] LIST` keycap removed from Detail.** It advertised an action Enter
  never performed there; the command bar now shows the real `J/K NODE` browse
  keys (Q/Esc still back out).
- **Heatmap `[T] UNITS` removed; added to Topology.** The heatmap is dB-margin
  only and ignored the toggle; Topology actually honours dBm↔margin but never
  advertised it — now they match their behaviour.
- **Ping copy is honest.** HA doesn't return a ping's result, so the action
  no longer claims to "confirm reachability" — it says the request was *sent* and
  to watch the node's Status/Last-seen for the reply (catalog + planner copy).
- **FLAGS column never clips.** On 60–73-col terminals the name-flex floor
  overflowed the row and silently cut the D/W/F/R triage flags off the right
  edge; the narrow tier now drops rate/seen/batt instead so FLAGS always fits.

## 0.20.0 — 2026-07-17

**Two engine enhancements (M3 + M6), shipped together.**

**Edge-cluster detector (M3).** A new middle-scale symptom between a per-node
fault and a mesh-wide event: when 2+ nodes that all route through one common
**repeater** are degrading together — while the rest of the mesh is healthy and
that repeater itself looks fine — the shared dependency (its link, power, or
placement) is the likely single cause, not each node individually.

- New `edge-cluster` `SymptomKind`; the `Symptom` gains an optional `members[]`
  for its affected downstream nodes (`nodeId` is then the shared repeater — the
  actionable target). Greedy disjoint clustering, so a node routed through two
  shared repeaters is credited to exactly one cluster.
- Requiring the shared repeater to be **non-degrading** is the sharp signal (a
  failing repeater already shows its own card); the interesting case is the
  *silent* shared dependency. Suppressed while a mesh/controller event owns the
  story.
- Collapses the members' per-node faults under the cluster (mirrors the mesh
  subsumption), so the Remedy screen shows one shared cause, not N scattered
  cards. The planner points at the repeater (inspect / ping); DOCS §9.x notes.

**Longer-horizon noise-floor history (M6).** The interference screen's noise-
floor trend previously spanned only the ~40-min in-memory controller ring. A new
persisted **30-min coarse tier** (mirroring the node coarse tier) now backs a
multi-day floor trend that survives restarts.

- `evidenceStore` gains a controller `CtrlCoarseBucket` ring (mean/min/max of the
  per-sample median floor), folded synchronously in `recordController`, pruned to
  the 14-day horizon, persisted (schema stays v2 — the new key reads defensively,
  so a pre-tier file loads it empty) and **age-judgment-free** (survives boot-
  grace, like the node coarse tier).
- The Interference screen renders a second "days" sparkline under the live
  "trend" one, on the same fixed −110..−80 dBm scale for direct comparison. The
  coarse per-sample floor uses the exact same leading-run `medianFloor` as the
  fine trend, so the two never disagree.

**Adversarial-review hardening** (7-dimension review): the coarse noise-floor
sparkline now **downsamples** the whole retained series into its drawn cells, so
the "days" graphic actually spans its label instead of collapsing to the most-
recent 12 h; and the INTERFERENCE correlated-node count excludes the edge-cluster
head (a *healthy* shared repeater — a suspect, not a degraded node).

Advisory-only throughout. Tests: 320 total (edge-cluster detection + subsumption
+ mesh-suppression; coarse-tier round-trip, back-compat, boot-grace survival;
coarse-trend reduction; downsample-spans-whole-series + degraded-count-excludes-
cluster-head regression tests).

## 0.19.0 — 2026-07-17

**Per-symptom-kind recovery metrics (M5 refinement).** The outcome-learning
ledger now scores each resolved episode by the signal its symptom's fix actually
moves, instead of judging every kind by the reply-timeout rate. A `weak-signal`
recovery shows up in RSSI, a `dead-flap` recovery in the Alive↔Dead flap count,
an `rtt-degraded` recovery in round-trip time, a `rate-fallback` recovery in the
negotiated PHY rate — scoring all of them by timeouts (the original v0.16
behaviour) meant those kinds could essentially never register an improvement, so
their control/action arms stayed empty and unlearnable.

- **`WindowMetrics`** now carries every recovery signal (`flaps`, `rssiMedian`,
  `rttMedian`, `rateKbpsMin`, plus `freshN`) alongside the timeout family, all
  computed kind-agnostically. RSSI/RTT are medianed from **fresh samples only**
  (a redelivered driver EMA carries no new information).
- **`computeVerdict`** dispatches through `metricOf(kind)` → `scoreRecovery`,
  one branch per metric. Every branch keeps the same honesty contract as the
  timeout metric: evidence-poor or incomparable windows are `unverifiable`
  (never a fabricated win), regressions are `worse`, and "improved" always needs
  a threshold crossing **plus** a minimum effect size.
- Kinds with no per-node recovery window (`chatty-device`, `ghost-suspect`,
  `mesh-interference`) map to `none` and remain `unverifiable` by design.
- **Per-signal evidence floors** (adversarial-review hardening). Each metric now
  gates on evidence of *its own* signal, not a shared fresh-sample count — a
  fresh sample routinely carries a null rssi/rtt (no-signal sentinels), so the
  old `freshN` gate could let a median-of-one pass as robust:
  - `rssi`/`rtt` gate on `rssiN`/`rttN` — the count of actual readings behind the
    median — needing ≥ `MIN_OBS` (3), so a single noisy reading can't drive a
    verdict.
  - `rateKbps` is now folded from **fresh** samples only (matching the evidence
    store's own coarse tier), so a quiet after-window of stale carry-forwards is
    `unverifiable` instead of being scored from a sticky pre-fix rate.
  - `flap` drops the before-window fresh floor (a mostly-Dead flapping node is
    legitimately fresh-poor) and instead requires the *after* window to prove
    liveness, so a node that went hard-dead isn't mistaken for a recovery.
- Robustness: `windowMetrics` now guards `dFlaps` (like its `dTx`/`dRx` siblings)
  so a legacy evidence sample reloaded from disk after an upgrade folds to 0
  rather than poisoning the flap aggregate with `NaN`.
- Documentation: `zwave_tui/DOCS.md` §9.1/§9.4 updated to describe the per-kind
  dispatch and its per-signal evidence floors; tests extended to 36 outcomes
  cases (309 total), including regression tests for each floor.

## 0.18.0 — 2026-07-17

**The complete manual (M7).** The add-on's **Documentation** tab is now a full
system & engine reference — twelve chapters covering every screen, the health
score, the whole learned-remediation engine (evidence store → baselines →
symptom detectors → advisory planner → outcome-learning → interference watch),
the write-action safety model, and configuration/deployment. Everything is
written from the source with real constants, thresholds, and formulas.

- **`zwave_tui/DOCS.md`** rewritten as the complete reference (was a short
  operator card).
- **`SECURITY.md`** added — the security posture and how to report an issue.
- **Downloadable manual**: CI now assembles README + SECURITY + DOCS into a
  single printable **`.docx`** (editable) and **`.pdf`** (opens anywhere) on
  every change, so the offline manual is always current and a docs change that
  breaks conversion fails the check. Built with `scripts/build-docs-docx.py`.

No runtime behavior changed in this release — it is documentation and tooling.

## 0.17.0 — 2026-07-17

**See the airwaves (M6).** A new **Interference** screen (press **8** or **f**)
puts the mesh's RF environment on one page:

- **Noise floor** — the per-channel 900 MHz background RSSI the radio measures
  (Home Assistant hides it; the add-on's read-only driver link surfaces it),
  with a recent trend spark. Lower is quieter; around −110 dBm is the near-radio
  ideal. Your mesh currently sits near −102 dBm — clean.
- **Controller serial link** — the host↔stick NAK/CAN/timeout rates, shown
  *separately* because a flaky USB/serial link looks exactly like mesh-wide RF
  trouble and needs the opposite fix (move the stick, not the nodes).
- **Diurnal heatmap** — the mesh-wide reply-timeout rate by hour of day, drawn
  as raw rates (never smoothed against a baseline — the whole point is to reveal
  a recurring, time-of-day interferer like a smart meter or baby monitor that a
  time-banded baseline would quietly absorb). A persistently hot hour stands out.
- **Correlated degradation** — whether several nodes are struggling *together*
  right now (the signature of an environmental cause rather than one bad node).

Everything is honest about missing data: no driver link → the noise floor reads
"unavailable" rather than a fabricated number; too little history → the heatmap
says "building" instead of showing fake zeros.

## 0.16.0 — 2026-07-17

**The engine starts *learning* (M5).** The Remedy screen's recommendations now
carry an evidence-backed efficacy note: after you run an action through the
Actions Menu, the add-on watches whether the symptom actually recovered — and,
crucially, compares that against how often the same kind of symptom recovers on
its own with *no* action. Advisory-only: nothing is executed automatically; the
learning only makes the advice more honest.

- **Outcome ledger** (`outcomes.ts`) — records every symptom *episode*, whether
  or not you acted on it. Symptoms that recover untouched form the
  **spontaneous-recovery control arm**; actions are credited only when they beat
  that base rate by a real margin.
- **Honest by construction.** An action counts as a success only if the node's
  own per-command reliability improved past its release threshold *and* by a
  minimum effect size — a count dropping isn't enough. The before/after windows
  must carry comparable traffic, or the episode is scored *unverifiable* (a mesh
  that went quiet can't fake a win in either direction). A recovery is only
  credited after it *holds* through a 10-minute confirmation window.
- **What you'll see.** Under an executable recommendation: `✓ helped 86% vs 19%
  self-heal (n=7)` once an action is proven to beat self-healing, or `≈ not
  distinguishable from self-healing (n=8)` when the data says it isn't — and
  nothing at all until there's enough evidence to have an opinion.
- **Still advisory-only.** Per the owner's decision, the engine never actuates
  the mesh on its own; every action still goes through the typed CONFIRM. The
  learning is persisted to `/data` and survives restarts.

## 0.15.0 — 2026-07-17

**The engine starts recommending (M4).** The **Remedy** screen (press **7** or
**y**) now shows, under each symptom, a ranked list of *what to do about it* —
still advisory-first: it recommends, it never acts. Executable steps run through
the existing Actions Menu with its typed CONFIRM; nothing is executed from the
Remedy screen.

- **Remediation planner** (`planner.ts`) — a pure `Symptom → Plan` mapping built
  from the research causal table. Each recommendation carries a **basis** label
  (spec / source / lore / inference) so a rule-of-thumb never reads like a
  measurement, and a **cost** tier (physical / safe / caution / disruptive /
  destructive). Crucially, most correct Z-Wave fixes are *physical* — place a
  repeater, move the stick, power-cycle a device — so **physical guidance is a
  first-class recommendation**, and the executable actions are the minority.
- **A route rebuild is never offered as a runnable fix.** Where a rebuild might
  be tempting (a weak link, a churning route) it appears only as an explicit
  *NOT recommended* entry with the reason — a rebuild can't repair a physically
  marginal link and deletes any manual priority routes. This is enforced by a
  test, not just a convention.
- **Protocol-aware.** Long-Range nodes (no mesh routing) get only physical /
  antenna guidance — never a route, repeater, or rebuild suggestion (a rebuild
  throws on them). Ping/probe steps are withheld from battery/FLiRS nodes.
- **Honest surface.** Symptoms are shown worst-first (critical before warning
  before watch), each recommendation is grounded with a one-line rationale, and
  when more symptoms exist than fit the screen it says so ("▾ N more not shown")
  rather than dropping one silently. Symptoms demoted under a mesh event carry no
  standalone plan — the mesh event owns the recommendation.
- The `auto_remediation` config knob and the auto-execution gate-stack move to
  M5, where auto-execution is actually built and its safety surfaced explicitly.

## 0.14.0 — 2026-07-17

**The engine starts diagnosing (M3).** The add-on now learns each node's normal
and surfaces anomalies on a new **Remedy** screen — advisory-first: it explains
what it sees and why, and recommends nothing to *do* yet (that is the next
milestone). Press **7** or **y** to open it.

- **Learned baselines** (`baselines.ts`) — per node, per time-of-day band, the
  statistic that fits each signal: a decayed Poisson **rate** for counting
  series (reply timeouts), and **median + MAD** for continuous ones (RSSI, RTT)
  with a precision floor so a tight cluster can never manufacture a false
  anomaly. A band only "graduates" (its detectors may fire) after enough
  independent observations across several distinct days — never off a handful of
  autocorrelated samples. Baselines persist and, unlike the recent-evidence ring,
  survive a power blip; a symptomatic node is *quarantined* from its own baseline
  so the normal never chases the pathology; a route change resets the RSSI/RTT
  normals.
- **Symptom detectors** (`symptoms.ts`) — pure functions over evidence +
  baselines: return-path-degraded (relative and a baseline-independent chronic
  variant), dead-flap, rate-fallback, RTT-degraded, weak-signal (direct nodes
  only — a routed node's RSSI is its last hop, not the device), chatty-device,
  ghost-suspect (only with proven multi-day coverage), controller-degraded, and
  a **correlation gate** that classifies a mesh-wide event (interference vs a
  flooding device) and *demotes* per-node symptoms under it rather than listing
  N faults. Every symptom carries a **basis** label (measured vs inferred), its
  evidence, and a dwell timer (a breach must persist 5 minutes to surface).
- **Remedy screen** + Activity-Log lines (kind `sym`) for every new symptom, so
  the whole engine remains auditable from the existing Log.
- Nothing is acted on: this milestone is for *validating* that the detections
  are right before any remediation is wired.
- A 5-dimension adversarial review of the diagnosis core found 13 issues (2 high),
  all fixed with regression tests: rate-fallback now requires a *same-route
  regression* (a 40k-only device no longer flags forever); the baseline
  quarantine covers the pre-symptom arming window (bad samples no longer ratchet
  a node's own "normal" toward its fault); RTT/weak-signal use the newest *fresh*
  sample so their timers don't reset every quiet tick; "chronic" now requires
  repeated observation, not just wall-clock age; the mesh-event gate got hard
  floors + hysteresis so a coincidental pair can't read as mesh-wide and a
  momentary dip doesn't drop the event; weak-signal is honestly labelled
  *inferred* against the fallback floor; and the Remedy empty state now tells
  "engine off" from "still learning" from "all healthy".

## 0.13.0 — 2026-07-16

**Real noise-floor measurement** — a strictly READ-ONLY connection to the
Z-Wave JS driver restores the diagnostics Home Assistant strips at its
WebSocket boundary.

- **New advanced option `driver_ws_url`** (default `ws://core-zwave-js:3000`,
  matching the official Z-Wave JS add-on; empty disables it; Z-Wave JS UI
  users point it at their server). The connection is passive telemetry only:
  a hard-coded command allowlist (`set_api_schema`, `start_listening`) is
  enforced in code and proven by test — no pings, no health checks, no route
  surgery, nothing that transmits RF. All mesh actions stay on the
  authenticated HA WebSocket, and the unauthenticated driver socket is never
  proxied or re-exposed.
- **The noise floor is now measured, not assumed.** The per-channel
  background RSSI feeds the Controller screen (per-channel values +
  "(measured)" tag), the Overview NOISE field, and the health score's
  SNR-margin math — replacing the −95 dBm fallback with the driver's real
  floor. Readings are staleness-gated (a floor older than 90 s reverts to
  "—", never a re-used stale value).
- **Evidence enrichment**: controller evidence samples now carry the
  per-channel floor (the interference watch's substrate); node samples carry
  the driver's true `lastSeen`; and node capability flags
  (listening / FLiRS) — which HA omits entirely — now populate both the
  evidence schema and the node dossier.
- **Fails soft by design**: unreachable server, schema outside the tested
  range (32–41), or a homeId that doesn't match Home Assistant's (a
  misconfigured URL pointing at a different network) all leave the dependent
  telemetry honestly null — the add-on runs exactly as before. Capped-backoff
  reconnect + a WS ping/pong liveness probe handle driver restarts without
  churning a healthy-but-idle socket.
- A 4-dimension adversarial review of this release found 1 high-severity issue
  and several hardening items, all fixed with regression tests: the homeId
  cross-check had a startup-race window (the driver's fast state dump could
  land before HA's homeId was known) where wrong-network data was admitted and
  never purged — now the first proven mismatch purges the cached telemetry AND
  stops the client; the client is restartable; the allowlist is spread-order
  safe; server-sent strings and the configured URL are sanitized/redacted in
  logs; node ids from the driver are range-validated; per-channel noise keeps
  its channel index; and the FLiRS capability flag is now recorded in the
  evidence schema.

## 0.12.0 — 2026-07-16

The remediation engine's evidence substrate (M2), rebuilt to close every
substrate finding from a 52-agent adversarial design review (39 confirmed + 7
partial findings against `DESIGN.md`/the first M2 draft — 3 blockers). No
user-visible screens change yet; this release makes the data the future
symptom engine will reason from trustworthy.

- **Two evidence tiers**: a fine ring (10 s samples, ~40 min) plus a NEW
  30-minute coarse tier spanning 14 days — the substrate baselines actually
  need (the review's first blocker: 40 minutes of history cannot feed
  time-of-day baselines). Staleness is per-tier, and a host power blip
  (boot-grace) no longer wipes the coarse history.
- **Event-driven flap counting**: the add-on now subscribes to
  `zwave_js/subscribe_node_status` (per node, with retry + a roster-diff
  fallback) and folds Alive↔Dead transition COUNTS into each sample — the
  review proved sub-10 s flaps were structurally invisible to level-sampling,
  and flapping is the hard RF-failure signal.
- **Freshness provenance**: each sample records whether a statistics event
  actually arrived in its window. Driver-side EMAs re-sampled without new
  events are pseudo-replication (they collapse dispersion estimates to zero
  downstream); wedged feeds now produce honest ring gaps instead of
  fabricated healthy windows, and shutdown no longer synthesizes a final
  sample from stale caches.
- **Delta guards hardened**: whole-window invalidation (ANY backwards counter
  nulls the whole sample), a max-window bound (long gaps are not
  time-attributable), and a physical-plausibility cap (a delta the RF could
  not carry is rejected). Malformed statistics events are now REJECTED at the
  source instead of coerced to zero — the coercion path could fabricate a
  full-lifetime delta as one "valid" window.
- **Network identity + coverage**: the evidence file is bound to the
  controller home id (a stick swap while stopped discards the old network's
  evidence, durably); coverage metadata (recording-since, per-node
  first-seen + cumulative counts) survives ring eviction so "no data" is
  distinguishable from "node never communicated" — the precondition the
  future ghost detector requires.
- **Controller serial-link evidence ring** and event-latched
  `routeFailedBetween` capture (it is transient — polling misses it).
- **Persistence is genuinely columnar** with a dirty flag and a 5-minute
  flush (was a full rewrite every 30 s), and a unit test now ENFORCES the
  per-node size budget.
- **Health score fix**: a routed node's RSSI describes its last hop into the
  controller, not the device — the Signal lane now scores routed nodes
  neutral and never raises the weak-signal flag from last-hop RSSI.
- `DESIGN.md` rev 2 (every review finding folded in, including the decision
  to pull a strictly read-only driver-WS telemetry client forward to v0.13)
  and `RESEARCH.md` gains three review-surfaced open questions (Supervision
  SETs vs `timeoutResponse`; `routeSchemeState` unavailable on either WS;
  the `TransmitStatus.Fail` counter path).
- A second adversarial review of this release's own diff found 27 more
  defects (1 high: the future-dated check ran before boot-grace, wiping the
  coarse tier on exactly the power-blip reboot it exists to survive) — all
  fixed with regression tests: controller-ring restore on load, backward-
  clock-safe coarse folding, per-feed subscription retry (no duplicate
  subscriptions), roster-seeded flap counting (first event no longer
  swallowed), departed-node eviction (node-id reuse starts clean),
  re-subscribe redeliveries no longer count as fresh observations, and a
  genuinely worst-case size-budget test (honest bound: ≤80 KB/node).

## 0.11.0 — 2026-07-16

Correct the TX-reliability metric so it measures the failure it names. Grounded
in a deep, cited protocol study (`RESEARCH.md`); the counter's near-silence was
reproduced against zwave-js 15.25.3.

- **Overview `DROP` → `TMO` (response-timeout %), reframed onto the right
  signal.** The metric was `(commandsDroppedTX + timeoutResponse) / commandsTX`.
  But `commandsDroppedTX` does **not** track RF acknowledgement failures — when a
  listening node stops acknowledging, the driver retries and marks it **dead**
  (the `D` gate), and the drop counter stays 0; it can also false-positive on fast
  nodes whose report beats the MAC ACK. So the old figure was near-silent for the
  loss it appeared to show and noisy otherwise. The column, the Detail row, and
  the health lane now use **`timeoutResponse / commandsTX`** only: the fraction of
  commands whose expected reply never came back while the node stayed reachable —
  a genuine return-path / responsiveness signal.
- **Detail:** the `Drop` row is now **`Timeouts`** (timeout count of TX); the raw
  `dropped tx/rx` counters remain on the *Traffic* row as honest context.
- **`F` flag** re-labelled *response timeouts* (was *flaky/failed TX*); its
  trigger is unchanged (>~15%), now driven purely by `timeoutResponse`.
- **Tests:** regression guards in `health.test.ts` and `overviewScreen.test.ts`
  lock in that a node with a high `commandsDroppedTX` but zero response timeouts
  reads **healthy** — the metric can never again be inflated by the wrong counter.
- No behavior change to any mesh action; display + scoring semantics only.

## 0.10.0 — 2026-07-16

A full visual redesign into a formal **diagnostic-console** aesthetic — one
cohesive instrument across every screen.

- **Shared console frame** (`chrome.ts`) on every screen:
  - a **system masthead** — product ident · live link state (`● ONLINE` /
    `STALE` / `OFFLINE`) · home id · timestamp;
  - a **titled section rule** naming the active screen with a right-hand status
    token (counts / filter / rebuild);
  - **labelled telemetry** with units and semantic color; and
  - a **keycap command bar** (`[A] ACTIONS  [/] FILTER  [Q] EXIT`).
- **Overview now fills the width.** The node table is width-responsive: on wider
  terminals the NODE column expands to full device names and new **RTT · DROP% ·
  ROUTE** columns (plus a wider signal-trend sparkline) appear — more diagnostic
  telemetry per row instead of a stranded right half.
- **Every screen reskinned** — Overview, Detail, Controller, Topology, Heatmap,
  and the Activity Log all wear the same frame, with uppercase section labels,
  aligned columns, and disciplined color (green ok · amber weak · red fault ·
  cyan asleep · blue long-range · grey chrome). Detail's identity/status/score
  moved into the title rule; its dossier is unchanged.
- No data was dropped or altered — this is presentation only.
- **Configuration tab** reordered and clarified: leads with the settings you
  actually touch (display unit, the write-actions gate), groups the login gate,
  and flags the advanced options; every field keeps its help text and a tailored
  input (dropdown / toggle / validated number / masked password / repeatable
  users list).
- A 4-dimension adversarial review confirmed 10 findings, all fixed: the Overview
  command bar could overrun the width when the roster scrolled; RTT rendered
  unrounded (overflowing its column); the Overview DROP% and Detail Drop% used
  different formulas (now one shared `txDropPct`); the FLAGS column was one cell
  short of the 9 possible flags; and Detail/Controller could silently clip
  content on very short terminals (now show a "…more" marker). `tsc` clean;
  147 tests (incl. Overview width + inverse-video-safety and `chrome.ts`
  width/height contracts at 40→200 cols).

## 0.9.0 — 2026-07-14

An **Actions Menu** with a deliberate type-`CONFIRM` gate for every command.

- **Press `a`** (from any screen) to open the Actions Menu — a clear, grouped
  layout of every action the add-on can run, each with a colour-coded
  **`SAFE` / `CAUTION` / `DESTRUCTIVE`** badge and a one-line description of
  exactly what it does:
  - **Device actions** (on the selected node): Ping · Refresh values ·
    Re-interview · Rebuild node routes · Remove failed node.
  - **System-wide**: Rebuild ALL routes (or Stop route rebuild while one runs).
- **Type-`CONFIRM` modal** — selecting an action opens a box restating the
  action, its target, and its impact, then requires typing the literal word
  **CONFIRM** to arm it (Enter to execute). Esc cancels back to the menu; a
  wrong or lowercase string won't arm.
- **Read-only by default** — the menu still *opens* so you can read every
  action's impact, but shows a `READ-ONLY` badge and won't execute until
  `write_actions_enabled` is set. (The old `confirm_destructive` option is
  removed — a typed CONFIRM is now always required.)
- **Safety hardening** from a 6-dimension adversarial review: a half-armed
  CONFIRM can no longer survive an idle re-lock / re-login (it's abandoned at
  the auth boundary, so a different operator can't fire it); the menu freezes
  its target node + item list at open, so streaming Log events or a rebuild
  starting mid-menu can't redirect the action under the cursor.
- 22 new tests (**139 total**); `tsc` clean.

## 0.8.0 — 2026-07-14

A real-time **Activity Log** — see everything the mesh does, as it happens.

- **Live activity feed.** The Log screen (press `6` or `e`) now streams *device*
  activity in real time — a light toggles, a sensor reads, a lock changes — on
  top of the existing node status/route changes and operator-action outcomes.
  Device changes come from Home Assistant `state_changed` events, filtered to
  this mesh's entities; `zwave_js` notifications are surfaced too. Each line is
  category-tagged (`val`/`sts`/`rte`/`ntf`/`act`/`sys`).
- **Scroll + detail pane.** Move the cursor with `j`/`k` (or arrows), page with
  `space`/`b`, jump with `g`/`G`. A detail pane shows the selected event in full:
  timestamp, category, severity, the **associated device** (node + area + status),
  the entity, and the old → new value. Press `⏎` to jump straight to that
  device's Node Detail screen.
- **Date filter.** `d` cycles the window: all time · last hour · last 24h ·
  today · yesterday · last 7 days. Combine with `o` (errors only). The active
  filters show in the header. (The log is an in-memory, session-scoped ring of
  the last 2000 events — it isn't persisted across restarts.)
- Chatty numeric telemetry sensors are throttled so one meter can't flood the
  feed; discrete events (motion/lock/switch/…) are never throttled. All
  HA-sourced strings are sanitized before they reach the frame.
- 33 new tests (115 total). Multi-agent adversarial review.

## 0.7.0 — 2026-07-13

Two additions: a rebuild-routes progress indicator and a long-horizon trend.

- **Rebuild-routes indicator.** While a network rebuild is running, the
  Controller screen shows a live banner — a spinner, an indeterminate sweeping
  bar, and **elapsed time** — and the Overview summary bar shows `⟳ rebuilding
  routes 3m12s`. Home Assistant exposes only the `is_rebuilding_routes` boolean
  (no per-node progress), so this reports honest elapsed time, never a
  fabricated percentage. The animation is present only while rebuilding, so the
  idle screen keeps its anti-flicker.
- **Long-horizon RSSI trend.** Alongside the recent RSSI/latency sparklines, the
  Detail screen now shows a coarse **~2 h** signal trend (`Sig 2h`), downsampled
  to one point per minute (120 points). It persists to `/data/history.json`
  next to the fine ring and reloads at boot, so the long trend survives a
  restart too. History file schema is now v2; existing v1 files load unchanged
  (their coarse tier just fills in over time).
- 4 new tests (82 total): two-tier persistence round-trip, v1 back-compat,
  coarse bloat-cap, and the elapsed/spinner helpers. `tsc --noEmit` clean.

## 0.6.0 — 2026-07-13

Firmware-update surfacing — see at a glance which nodes have a Z-Wave firmware
update available (read-only; no update is ever triggered from the TUI).

- **Per-node firmware** on the Detail screen: installed version, and when an
  update is available `5.54 → 5.60 ⬆ update` (or `updating 42%…` while applying).
- **Overview** gains an advisory **`U`** flag (blue) on nodes with an update —
  it never affects the health score (a pending update is maintenance, not a
  fault), exactly like the battery `B` flag.
- **Controller** screen shows a fleet roll-up: `Node FW — N node(s) update
  available` (or `none pending`).
- Reads the `update.*` firmware entities via `get_states` on the same slow
  cadence as battery. A node may expose multiple firmware targets
  (`_firmware` + `_firmware_2`) — they're aggregated (update available if any
  target has one). The add-on/integration `update.*` entities are correctly
  excluded (they aren't on a node device).
- 11 new tests (78 total): firmware aggregation (multi-target, in-progress,
  missing attrs, version coercion) + the advisory `U` flag across node states.

## 0.5.0 — 2026-07-13

Persistent sparkline history — the RSSI/RTT trends now survive a restart.

- **Trends persist across restarts.** The per-node RSSI/RTT sample rings that
  feed the Overview/Detail sparklines were in-memory only, so every add-on
  restart / HA-Core reconnect / power blip wiped them and the graphs came back
  empty for minutes. They now flush to `/data/history.json` every 30s (and on
  shutdown) and reload at boot, so a deploy or restart is visually seamless.
  Dependency-free atomic JSON (temp-file + `rename`) — no `node:sqlite`, no
  native build, portable to any Node.
- **Two staleness guards** so a restored trend is never misleading: a 1h
  wall-clock age cap, plus a host-boot guard that distrusts the snapshot when
  the host has been up < 3min (on a no-RTC Pi the wall clock is pre-NTP right
  after a power loss, so a "fresh"-looking timestamp can be hours stale — the
  monotonic `os.uptime()` is immune). Future-dated snapshots are also dropped.
- **Network-identity guard.** Per-node stats + history are now cleared only when
  the controller `home_id` changes (a stick swap / different NVM backup), not on
  every reconnect — so history survives an HA-Core restart but never aliases one
  physical node's trend onto another after a controller change. (Supersedes the
  0.4.1 "self-heal clears the history ring" behaviour, which wiped trends on
  routine reconnects.)
- 13 new tests (67 total). Reviewed by an adversarial pass; all findings
  addressed or documented.

## 0.4.1 — 2026-07-11

Graphics polish from an adversarial verification (12 confirmed + 3 plausible; no
data or behavior regressions — all color/edge-case fixes).

- **Colors now match their numbers.** The Overview trend sparkline, the Detail
  drop% meter, the Topology route bars (dBm mode), and the Heatmap cells were
  colored by a different band than the value beside them — a healthy node could
  show a red trend, a 20%-drop a green bar. Each now uses the same color band as
  its number, so a green bar always means a healthy number.
- **Gauge robustness.** NaN/Infinity and degenerate inputs could render the
  literal "undefined" (blowing a fixed column to 9 cells) or collapse a bar to
  width 0 — `clamp01` now sanitizes non-finite input and `signalBars` guards
  `bars<=1`. A flat (steady) sparkline reads grey-steady instead of alarming red.
- `brailleSparkline` was vertically inverted (filled top-down); now bottom-up so
  a rising trend rises. Overview trend excludes RSSI sentinels; self-heal clears
  the history ring; Controller drops the redundant Home-ID decimal at 60 cols.
- 4 new edge-case tests (54 total).

## 0.4.0 — 2026-07-11

Terminal graphics — the TUI is now a control-room display.

- New `gauges.ts` graphics library (unit-tested width contracts): block
  **sparklines** + denser braille sparklines, **WiFi-style signal bars**,
  zone-colored **meters**, labeled **gauges**, gradient **heat cells**.
- **Per-node RSSI/RTT history** (rolling rings) drives the sparklines.
- **Overview**: WiFi signal bars in the Signal column, a health micro-gauge by
  each score, a mesh-health meter in the summary, and a right-hand RSSI trend
  sparkline column (wide terminals).
- **Detail**: a health gauge, RSSI + latency sparklines (min…max), an SNR-margin
  meter, a drop% meter, a battery gauge, and per-hop signal bars in the routes.
- **Controller**: a network-health gauge, a reliability meter, and the A–F grade
  histogram as meter bars.
- **Topology**: a hop-distribution histogram, per-node route signal bars, and
  repeater-load meter bars flagging single-points-of-failure.
- **Heatmap**: a real gradient heat-cell grid per area + per-area mean-margin
  meters + a gradient legend.
- All graphics are additive — every measured value is preserved; every screen
  still returns exactly `rows` lines with zero width overflow (agent harnesses:
  300+ geometry checks per screen). 50 tests.

## 0.3.0 — 2026-07-11

Safe remediation actions — the TUI can now *act* on the mesh, not just report.

- **Mutating actions** behind **Enable Write Actions** (default off, so nothing
  changes until you opt in): **ping** (safe/idempotent, runs immediately),
  **re-interview** (`refresh_node_info`), **refresh values**, **heal** a node's
  routes (`rebuild_node_routes`), **rebuild ALL routes**
  (`begin_rebuilding_routes` / `stop`), and **remove a failed node**.
- **Confirmation gate**: non-ping actions prompt `y` to confirm when **Confirm
  Destructive Actions** is on; **rebuild-all** and **remove-failed** always
  confirm regardless (mesh-wide / destructive). Cancelling returns to the screen
  with no side effect.
- **Closed-loop logging**: every action's start + outcome is written to the
  **Log** screen (`ping node 3 → ok`, `rebuild routes node 5 → failed: …`).
- The **Detail** footer lists the per-node actions when write actions are on.
- Command shapes were probed against the live driver (`rebuild_node_routes`,
  not the removed `heal_node`; ping via the `button.*_ping` entity). New tests
  cover the runner (gating + exact command construction) and the session
  confirm/cancel safety gates (41 total).

## 0.2.1 — 2026-07-11

Fixes from an aggressive live verification (14 confirmed findings).

- **Live statistics no longer freeze (was HIGH).** HA delivers the initial
  on-subscribe event with `nodeId` (camelCase) but every subsequent live push
  with `node_id` (snake_case); the handler only accepted `nodeId`, so after the
  first reading every node's stats froze at their subscribe-time values. Now
  accepts both — verified live that a pinged node's stats update again.
- **Health: an alive node no longer decays.** Reachability now follows the
  authoritative alive-poll, so a quiet-but-alive mains node can't drift into a
  false `S` (stale) flag or lose score just because its detailed statistics
  hadn't pushed recently.
- **Battery %** now shown (and the `B` low-battery flag fires) — read from the
  battery-level sensors.
- New **`L` (high latency)** advisory flag for sustained multi-second RTT.
- Route mapping keeps `repeaters`/`repeaterRSSI` index-aligned even if a hop
  fails to resolve; `route_failed_between` guarded.
- Statistics subscriptions re-establish after an entry self-heal (previously
  they'd orphan until a Core-WS reconnect); frozen stats cleared on re-discovery.
- Detail/Controller show a "…N more" marker instead of silently dropping
  sections on a short terminal; Detail drop% clamped to ≤100%.
- Topology labels its per-node dB as the route margin (vs the Overview's node
  RSSI); Log drops the inert follow/pause toggle.
- Sanitize device manufacturer/model/area (were bypassing the label sanitizer).
- `/api/health` reports `lastStatsUpdated`. New tests pin the casing fix +
  route mapping (30 total).

## 0.2.0 — 2026-07-11

Live statistics + the full six-screen interface. The health scores now reflect
real RF conditions instead of a uniform placeholder.

- **Live node + controller statistics**: subscribes to
  `zwave_js/subscribe_node_statistics` and `subscribe_controller_statistics`.
  Subscribing delivers each node's current stats immediately (no pinging), so
  the Overview populates within seconds. Fills the Margin / Hop / Rate / Seen
  columns with real RSSI, route, data-rate, and last-seen data — and the health
  score now spreads across the mesh (e.g. a weak, multi-hop node grades below a
  strong direct one) instead of every node reading the same.
- **Detail** screen: full per-node dossier — identity, security, live link
  (RTT / RSSI / SNR margin / drop%), the LWR + NLWR route chains with per-hop
  RSSI and data rate, TX/RX counters, and power source.
- **Controller** screen: node-1 identity + roles, live traffic counters, and an
  A–F network-health histogram.
- **Topology** screen: nodes grouped by hop count with their repeater chains,
  plus a repeater-load (single-point-of-failure) tally.
- **Signal Heatmap** screen: nodes by area, cells graded by SNR margin,
  worst-area-first.
- **Event & Command Log** screen: node status changes and mesh re-routing,
  severity-coloured.
- Correct field mapping under the hood: HA's snake_case stat fields → the
  internal model, the misspelled `timout_response` controller key, and route
  `repeaters` given as HA device_ids resolved back to Z-Wave node ids.

## 0.1.0 — 2026-07-10

Initial skeleton: a read-only Z-Wave mesh health TUI served over telnet
(`:2324`) and the Home Assistant sidebar (Ingress `/console`).

- Full Home Assistant add-on scaffold — `config.yaml` / `build.yaml` /
  `repository.yaml` / `Dockerfile` / s6 `run` service / AppArmor — building a
  prebuilt multi-arch GHCR image, `init: false`, Ingress-ready.
- HA Core WebSocket client (SUPERVISOR_TOKEN auth) with a subscription event
  demux and auto-reconnect.
- Z-Wave data layer: `zwave_js` entry-id auto-discovery, device + entity
  registry join, and a `network_status` roster poll.
- Telnet TUI + xterm.js browser console sharing one TUI session and data
  provider, with an anti-flicker draw loop.
- Overview node-list home sorted worst-health-first, over a composite health
  model (SNR margin over the live noise floor, Long-Range aware, battery as a
  separate lane, hard gates for dead/unknown/asleep).
- Read-only by default: mutating actions are gated off
  (`write_actions_enabled` defaults false); ping is wired but gated.
- Optional **login gate** for direct (non-ingress) access: users + passwords
  set in the add-on config, plaintext or `scrypt:` hashes. HA-sidebar access is
  trusted (already HA-authenticated). Hardened after an adversarial review —
  async scrypt (never blocks the event loop), startup normalization to scrypt
  (constant-cost verify, no username enumeration), a per-client backoff that
  survives reconnects, and a telnet connection cap. Fails closed when enabled
  with no users configured.
- Portable by design: no controller/mesh specifics hard-coded — the entry id is
  auto-discovered and the roster comes from the registries, so it runs on any
  Home Assistant install with the Z-Wave JS integration.
