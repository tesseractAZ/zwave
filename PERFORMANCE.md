# Performance Record (living document)

Measured figures for the Z-Wave TUI add-on: what it costs to run, what it costs
to verify, and what the engine has actually learned on a live mesh.

**Every number here was measured, not estimated.** Where a figure is a single
observation rather than a distribution, it says so. Where something is *not*
measured, it is listed under *Not measured* rather than filled in with a plausible value — the
same rule the screens themselves keep.

Reproduce any of it with the commands given; each section names its own method.

- **Measured at:** v0.63.5, 2026-09-06
- **Reference mesh:** 39 nodes (38 + controller), Zooz ZST39 LR 800-series,
  ~14 days of continuous evidence
- **Host:** Raspberry Pi 5, Home Assistant OS, add-on container
- **Dev machine (build/verify figures):** Apple silicon, Node 26

---

## 1. Runtime footprint

Single sample from `ha apps stats local_zwave_tui`, add-on running normally with
both transports live:

| | measured | what it actually covers |
| --- | --- | --- |
| CPU | 0.02 % | **one instantaneous sample**, not an average |
| Memory | 93.2 MB | the **whole container** — `npm`, the `tsx` loader and the Node server, not the server's own RSS |
| Network, lifetime | 4.1 MB rx · 0.8 MB tx | since container start |

Both figures are honest about their subject and neither supports a stronger
claim. CPU was 0.02 % *at the observed traffic level*; the statistics path is
event-driven and scales with mesh traffic, which was not varied. The memory
figure is container-resident and includes two supervisor processes the server
does not need at runtime — the server's own RSS is not instrumented (§7).

---

## 2. Render cost

The TUI repaints at 1 Hz, so the budget is ~1 000 ms per frame.

Mean over 500 iterations per screen, **a fresh `ViewState` constructed for every
iteration**, on a synthetic 39-node roster:

| screen | 80×24 | 80×60 | 200×24 | 200×60 |
| --- | --- | --- | --- | --- |
| Overview | 385 µs | **412 µs** | 234 µs | 375 µs |
| Topology | 197 µs | 250 µs | 154 µs | 211 µs |
| Detail | 91 µs | 81 µs | 65 µs | 61 µs |
| Heatmap | 83 µs | 53 µs | 52 µs | 51 µs |
| Log | 31 µs | 30 µs | 19 µs | 16 µs |
| Engine | 25 µs | 24 µs | 13 µs | 17 µs |
| Remedy | 18 µs | 15 µs | 13 µs | 15 µs |

Under load — 24 live symptoms, 12 open episodes, a populated efficacy arm, 8
nodes on the auto-ping ladder — the two engine screens grow and the rest do not:

| screen | clean 200×60 | loaded 200×60 |
| --- | --- | --- |
| Remedy | 15 µs | **356 µs** |
| Engine | 17 µs | **217 µs** |
| Overview | 375 µs | 391 µs |

**Worst case measured: ~412 µs, about 0.04 % of the frame budget.** Height moves
Overview more than width does: `renderOverview` caps its window at `H − 5` rows
(`overview.ts:184`), so 80×24 lays out 19 rows and 80×60 all 39.

**Method, and three things it does NOT measure.**

`renderScreen()` is called directly with a synthetic provider, outside the
session and transport layers. That means:

1. **It is not a frame.** `TuiSession.draw()` also runs a roster sort whose
   comparator calls `scoreFor()` twice per comparison (`input.ts:74`), assembles
   the body, and hashes the entire body to decide whether to write at all
   (`session.ts:1107`). At 200×60 that hash walks ~17 KB. Those costs are real,
   per-frame, and excluded here.
2. **Interference and Controller are omitted from the tables above**, because
   both are dominated by `data.interference()` rather than by rendering. In
   production that is a **10-second TTL memo** over every node's coarse buckets
   (`zwaveData.ts:1608`, whose own comment says the fold "must NOT run per render
   frame"), and the benchmark's provider is a stub returning a literal — so those
   two screens' render figures would measure neither the memo nor the fold.

   The **fold itself is now measured** against a realistic bucket set (38 nodes ×
   672 half-hour buckets over 14 days, plus the controller ring — 26 208
   buckets): **0.87 ms per miss**, 30 iterations. At a 1 Hz redraw and a 10 s TTL
   that is one frame in ten paying **0.09 % of the frame budget**. The memo is
   justified caution rather than a live hazard, and the comment's warning holds
   without the cost being operator-visible.
3. **The draw path is not pure.** `renderOverview` writes `view.scroll`,
   `renderLog` writes `view.logCursor`. An earlier revision of this section reused
   one `ViewState` across all 500 iterations and so measured the already-converged
   path — it reported Overview at 80×24 as 109 µs against the 385 µs above, a
   3.5× understatement. Constructing a fresh state per iteration is what the
   figures above do.

---

## 3. Verification cost

| | measured |
| --- | --- |
| Test suite | **1 061 tests, 11.4 s** (`npm test`) |
| Mutation harness | **541 mutants, 836 s wall / 621 s user** |
| Source | 24 457 lines TypeScript · Tests | 18 614 lines |

Latest full run: **533 killed · 0 survived · 8 equivalent · 0 missing ·
0 ambiguous · 0 invalid · 0 relabel.**

836 s over 541 mutants is **~1.55 s each**, against a full suite of 11.4 s — so
most mutants are plainly not paying for the whole suite. That is the kill-fast
selection working: run only the test files that provably catch a given mutant,
and fall back to the full suite only when they come back green. Each mutant also
pays a typecheck, which the per-mutant figure includes.

> The `sys` time was not captured on that run, so this document does **not**
> claim the harness is startup-bound rather than CPU-bound — that inference needs
> a breakdown this measurement cannot give (§7).

`SURVIVED`, `MISSING`, `AMBIGUOUS` and `INVALID` are all failures. An anchor
pre-flight checks every mutant's target text against its file before any
*mutant's* tests run — it runs after the baseline, so a stale entry costs the
baseline (~12 s) rather than the full 14 minutes. It fired six times during the
v0.51–v0.63 work, each on an anchor one of my own edits had moved.

---

## 4. What the engine has learned

Live readings, 2026-09-06.

**Baseline coverage**, for the four-hour band current at the time of reading:
`timeouts 38/38 · rtt 22/38 · rssi 22/38`. Counts are per node, per series, per
band — not a fleet-wide constant. Only `timeoutNormal` and `rttNormal` arm
detectors; **`rssi` is a dossier yardstick and arms none**, so detector coverage
is the first two figures. REMEDY reports this as *partial coverage*, which is a
statement about the instrument, not about health.

**Learned efficacy**, with the decayed weight and node provenance:

| symptom kind | action arm | control (self-heal) |
| --- | --- | --- |
| `rtt-degraded` | ping — not distinguishable (n≈17.8, 4 nodes) | 82 % (n≈17.3, 18 nodes, n≈0.8 worse) |
| `rate-fallback` | ping — not distinguishable (n≈12.9, 3 nodes) | 67 % (n≈16.8, 11 nodes) |
| `route-churn` | — | still learning (n≈1.0 of 4) |

The ledger withholds a benefit claim until the action's Wilson 95 % lower bound
clears the control arm's rate by the minimum effect, on at least `minEpisodes`
decayed episodes. **There is no node-count requirement on the benefit claim** —
the ≥2-node rule gates the *harm* finding. That is why every arm prints its node
count rather than relying on one.

For `rtt-degraded` the verdict is currently arithmetically forced: against an
82 % control arm the bar sits near 87 %, and at n≈17.8 the Wilson lower bound
cannot reach it even on a perfect record. "Not distinguishable" there means the
evidence *cannot* separate the two at this sample size — a stronger and more
useful statement than "the ping did not help".

**Evidence quality**, `rtt-degraded`: 28 unscoreable (thin evidence) · 1
transient blink · 4 undersampled · 11 unprobeable · 1 confounded — counted and
shown rather than folded into a denominator.

**Auto-ping** at the time of reading: `running · candidates 35 · dead 0 ·
sweep-due 0 · verify-owed 0`; dwell 10 min, max 3 per outage, 120 min sweep.

**Noise floor:** −99 dBm measured, 14-day span, peak −94 dBm, quietest −100 dBm.
Worst diurnal hour 22:00: 0.9 % of 451 tx — about 4 timeouts, which at that
sample size is not distinguishable from the neighbouring hours.

---

## 5. Cold start

Measured by restarting the add-on and polling from a second machine, **n=1**,
poll interval 250 ms:

| milestone | measured | poll granularity |
| --- | --- | --- |
| telnet accepting connections again | **+5.8 s** | 250 ms |
| first frame with a **populated roster** | **same moment** (+8.0 s on a coarser 300 ms/2.2 s sampler) | 300 ms |

The second row is the number an operator experiences, and the finding is that
there is no gap: the persisted stores restore *before* the listener opens, so the
add-on never serves a half-ready screen. The two runs differ (5.8 s vs 8.0 s)
because the second sampler holds each connection open for 2.2 s to read a whole
frame; the useful conclusion is the absence of a gap, not the absolute figure.

Within that window the process restores three persisted stores and the outcome
ledger, opens both transports, and connects the driver-WS. The engine then
reports `suppressed: boot-window` for some minutes by design — the roster reads
every node as Dead until the first poll lands, so the ladder stands down rather
than probing the whole mesh on every restart.

> **Two retractions, both my own measurement error.**
>
> An earlier revision reported a second milestone, "first Home Assistant state
> write, +6.8 s". It is removed. The first attempt polled `last_changed`, which
> advances only on a *value* change; the correction polled `last_updated` — but
> Home Assistant drops a byte-identical republish, so that field does not
> advance on the add-on's own repeat writes either. **Both figures described the
> polling method, not the add-on.** Timing the genuine first write needs either
> `force_update` on the POST or the add-on's own log line, and neither was done.
>
> The same revision reported **0 KB/s of per-session bandwidth at 80×24**, and
> explained it by the masthead shedding its clock at that width. The repo's own
> test asserts the opposite — `test/chrome.test.ts:172`, *"80 cols keeps the
> clock"* — and `chrome.ts:86` sheds the home id first. So the explanation was
> false, built on a misread capture in which the command bar and masthead ran
> together. The zero itself is unexplained and is therefore withdrawn rather
> than published with a story attached. Per-session bandwidth is in §7.

---

## 6. Publishing cadence

| | measured |
| --- | --- |
| HA state re-publish | every **30 s** (four entities) |
| Release image build (CI, multi-arch) | ~**90 s** after the tag |

The 30 s cadence is also the self-heal window: the entities are unmanaged
(REST-created, no device, no `unique_id`) and do not survive a Home Assistant
Core restart, so re-publishing is what restores them.

---

## 7. Not measured — and why most of it does not need to be

Everything below could be measured. The question this section asks of each is
whether the number would **change a decision** — and for most of it the answer is
no, so it is recorded as a known gap rather than carried as pending work.

**Worth measuring if the cost is ever felt:**

- **Where the harness's 836 s goes** — baseline, 542 typechecks, targeted runs,
  full-suite fallbacks. This is the one item with a real ongoing cost: the
  harness gates every release and was run ~15 times in a single working session.
  A per-phase breakdown is what an optimisation attempt would start from.
  Without `sys` time it also means "startup-bound" stays a hypothesis (§3).
- **Per-session bandwidth.** The one attempt produced a 0 KB/s reading at 80×24
  that the code contradicts, and it was withdrawn (§5). Re-measuring is about
  correcting a published claim rather than about capacity — 17 KB/s at 200×60
  against a 32-session policy cap is not a limit anyone will meet.

**Known, and deliberately not measured** — the figure would not change anything
at these magnitudes:

- **A whole frame.** §2 measures `renderScreen` only; the roster sort, body
  assembly and frame hash are per-frame and excluded. The worst measured
  component is 412 µs against a 1 000 ms budget, so even a threefold miss leaves
  the conclusion intact.
- **The server's own memory,** as distinct from the container's 93.2 MB (which
  includes `npm` and the `tsx` loader) — on a host with 7 952 MB.
- **CPU over an interval and under varied mesh traffic,** as distinct from one
  0.02 % sample.
- **Uncompressed `/data` size.** Compressed it is under 5 KB (the Supervisor's
  per-add-on backup figure rounds to 0.00 MB; the enclosing 0.14 MB archive is
  mostly metadata). Columnar numeric JSON compresses by an unknown factor, so
  this does not bound the uncompressed size — but nothing about a store this
  small changes a decision. (The backup made for it was deleted afterwards.)
- **Throughput.** The per-IP telnet cap (4), global telnet cap (16) and separate
  `/console/ws` cap (16) bound concurrency by policy at 32 simultaneously-drawing
  sessions. That is a limit, not a measured capacity, and one operator will not
  approach it.

**Not a gap at all:** the rtt baseline ceiling of 22/38 is *measured and
understood* — route churn resets continuous baselines, and a repeater-routed node
must hold one route for roughly two weeks to graduate a band. Five redesigns were
evaluated and rejected, each with a concrete false-symptom scenario. It was
previously listed here, which wrongly implied open work.

---

## 8. History

| date | version | what changed |
| --- | --- | --- |
| 2026-09-06 | v0.63.5 | interference fold miss measured (0.87 ms, 0.09 % of budget) and time-to-useful-frame measured (no gap after listening); §7 triaged from 10 items to 2 worth measuring, 5 deliberately not, and 1 that was never a gap |
| 2026-09-06 | v0.63.4 | **substantial correction after an adversarial audit** — render figures re-measured with a fresh `ViewState` (Overview 80×24 was understated 3.5×), Interference/Controller withdrawn as unmeasured, two cold-start figures and the bandwidth row retracted with their causes, §1/§3 claims scoped to what the samples support, §7 expanded from 4 items to 10 |
| 2026-09-06 | v0.63.3 | first record: runtime footprint, render benchmark, verification cost, live engine figures |
