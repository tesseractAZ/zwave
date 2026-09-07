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
| Detail | 91 µs | 81 µs | 65 µs | 61 µs |
| Engine | 25 µs | 24 µs | 13 µs | 17 µs |
| Heatmap | 83 µs | 53 µs | 52 µs | 51 µs |
| Log | 31 µs | 30 µs | 19 µs | 16 µs |
| Overview | 385 µs | **412 µs** | 234 µs | 375 µs |
| Remedy | 18 µs | 15 µs | 13 µs | 15 µs |
| Topology | 197 µs | 250 µs | 154 µs | 211 µs |

Under load — 24 live symptoms, 12 open episodes, a populated efficacy arm, 8
nodes on the auto-ping ladder — the two engine screens grow and the rest do not:

| screen | clean 200×60 | loaded 200×60 |
| --- | --- | --- |
| Engine | 17 µs | **217 µs** |
| Overview | 375 µs | 391 µs |
| Remedy | 15 µs | **356 µs** |

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
| Mutation harness | **559 mutants, 821 s wall · 689 s user · 78 s sys** |
| Source | 24 457 lines TypeScript · 18 614 lines of tests |
| Test suite | **1 098 tests, 12.5 s** (`npm test`) |

Latest full run: **551 killed · 0 survived · 8 equivalent · 0 missing ·
0 ambiguous · 0 invalid · 0 relabel.**

### Where the 821 seconds actually go

`node scripts/mutation-check.mjs --profile` reports a per-phase breakdown; the
run below was taken under `/usr/bin/time -l` so the user/sys split is real
rather than inferred.

| phase | wall | share | runs | each |
| --- | ---: | ---: | ---: | ---: |
| baseline typecheck | 0.2 s | 0.0 % | 1 | 0.20 s |
| baseline full suite | 12.5 s | 1.5 % | 1 | 12.5 s |
| per-mutant typecheck | 122.9 s | 15.1 % | 559 | 0.22 s |
| **targeted test runs** | **571.9 s** | **70.2 %** | 558 | **1.02 s** |
| full-suite fallbacks | 107.0 s | 13.1 % | 9 | 11.89 s |
| total | 814.5 s | | | |

### The startup-bound hypothesis is REFUTED

Earlier revisions of this document flagged "startup-bound" as an untested guess
and declined to assert it. Measured, it is wrong:

- **`sys` is 77.8 s — 9.5 % of 821.3 s real.** `user` is 688.8 s, **84 %**.
- The harness now measures its own **process-startup floor** directly, by timing
  one bare invocation of each subprocess: `tsc` 78 ms, `tsx` 70 ms. Against the
  observed counts that is `78 ms × 559 + 70 ms × 567` = **83.3 s, 10.2 %** of the
  run spent before any work begins. Two consecutive runs agreed to within half a
  point, so this is a stable property and not one run's weather.

Two independent measurements agree at ~10 %. The harness is **CPU-bound on real
work**, not on launching processes.

The cost centre is the **targeted test runs: 70 % of the run**, at 1.02 s each
across 558 invocations — of which only ~76 ms is startup. The other ~0.95 s is
`tsx` transpiling the TypeScript afresh **on every single invocation**. So the
lever is not "spawn fewer processes", it is "stop re-transpiling the same
sources 558 times": precompile once and run plain JS, or keep a warm worker.

Two smaller levers, for scale: the per-mutant typecheck is 15.1 % (30 % of which
*is* startup, so an incremental/`--watch` tsc server would help there), and the
full-suite fallbacks are 13.1 % from only **9** runs at 11.9 s each. Fallbacks
are triggered by kill-fast mapping misses, so each one fixed is ~12 s saved;
seven were harvested from the run's own report during v0.64.0, taking the miss
count to **zero** — the fallbacks that remain are mutants no single test file
catches, not mapping errors.

> Caveat on the phase table: it is wall clock measured inside the parent, so a
> child's CPU is charged to nobody. That is exactly why the `time -l` line above
> is quoted beside it — the two together are what make the refutation safe.

`SURVIVED`, `MISSING`, `AMBIGUOUS` and `INVALID` are all failures. An anchor
pre-flight checks every mutant's target text against its file before any
*mutant's* tests run — it runs after the baseline, so a stale entry costs the
baseline (~12 s) rather than the full 14 minutes. It fired eight times during
the v0.51–v0.64 work, each on an anchor one of my own edits had moved — most
recently on an `AMBIGUOUS(2)`, where a copy-pasted path-splitting helper made
one anchor match two sites. The duplication was the real defect; the harness
found it as a testing problem.

---

## 4. What the engine has learned

Live readings, 2026-09-07 (§4a/§4b describe the mesh these were learned on).

**Baseline coverage**, for the four-hour band current at the time of reading:
`timeouts 38/38 · rtt 21/38 · rssi 21/38` (12:00–16:00 band). Counts are per node, per series, per
band — not a fleet-wide constant. Only `timeoutNormal` and `rttNormal` arm
detectors; **`rssi` is a dossier yardstick and arms none**, so detector coverage
is the first two figures. REMEDY reports this as *partial coverage*, which is a
statement about the instrument, not about health.

**Learned efficacy**, with the decayed weight and node provenance:

| symptom kind | action arm | control (self-heal) |
| --- | --- | --- |
| `rate-fallback` | ping — not distinguishable (n≈12.9, 3 nodes) | 67 % (n≈16.8, 11 nodes) |
| `route-churn` | — | still learning (n≈1.0 of 4) |
| `rtt-degraded` | ping — not distinguishable (n≈17.8, 4 nodes) | 84 % (n≈18.2, 19 nodes, n≈0.7 worse) |

The ledger withholds a benefit claim until the action's Wilson 95 % lower bound
clears the control arm's rate by the minimum effect, on at least `minEpisodes`
decayed episodes. **There is no node-count requirement on the benefit claim** —
the ≥2-node rule gates the *harm* finding. That is why every arm prints its node
count rather than relying on one.

For `rtt-degraded` the verdict is currently arithmetically forced: against an
84 % control arm the bar sits near 87 %, and at n≈17.8 the Wilson lower bound
cannot reach it even on a perfect record. "Not distinguishable" there means the
evidence *cannot* separate the two at this sample size — a stronger and more
useful statement than "the ping did not help".

**Evidence quality**, `rtt-degraded`: 29 unscoreable (thin evidence) · 1
transient blink · 4 undersampled · 11 unprobeable · 1 confounded — counted and
shown rather than folded into a denominator.

**Auto-ping** at the time of reading: `running · candidates 35 · dead 0 ·
sweep-due 0 · verify-owed 0`; dwell 10 min, max 3 per outage, 120 min sweep. No
node is in a dead episode, a miss streak or a launch failure, and **no episodes
are open** — which is the healthy steady state, not an absence of instrument.

**`node-down` is deliberately unscored**: an outage episode ends when the node
returns, so there is no control arm to compare an action against. Reporting a
rate there would be inventing one.

**Noise floor** is in §4b. Worst diurnal hour 22:00: 0.9 % of 451 tx — about 4
timeouts, which at that sample size is not distinguishable from the neighbouring
hours.

---

## 4a. The mesh under measurement

Everything above is the add-on's own cost. This is the network it watches —
read live from the running instance on 2026-09-07, at 200×70 so nothing sheds.

Node names are room names, so what follows is **distributions rather than a
roster**: a public document should not carry a floor plan, and a distribution
answers "is this mesh healthy" better than a list does.

### Composition

| | |
| --- | --- |
| Activity | 328 events in 3 h 48 m (~86/h) |
| Grades | **A 32 (84 %) · B 6 (16 %)** · C/D/F 0 · mean score **96** |
| Links | **24 direct · 14 routed · 0 long-range** |
| Nodes | **39** (controller + 38 end devices) |
| Reroutes | 2 in 3 h 48 m |
| State | 38 alive · 0 dead · 0 asleep · 0 flaky |

Hop distribution, controller-relative:

| hops | 0 | 1 | 2 | 3+ |
| --- | ---: | ---: | ---: | ---: |
| nodes | **24** | 11 | 2 | 1 |

### Link quality, all 38 end devices

| | min | p10 | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| SNR margin (dB) | 10 | 14 | **29** | 50 | 61 |

| negotiated rate | 100 kbit | 40 kbit | 9.6 kbit |
| --- | ---: | ---: | ---: |
| nodes | **32** | 5 | 1 |

**4 nodes sit below 15 dB of margin; 24 are at 25 dB or better.** The single
9.6 kbit node and the low-margin tail are the mesh's real edges — a node at
9.6 kbit is not merely slower, it occupies the air far longer per frame, which
is why the topology screen shows rate beside margin rather than either alone.

> **A parse that disagreed with the screen was discarded, not published.** A
> first pass over the Overview roster produced hops `0:4, 1:22` and a different
> rate split. The Topology screen's own header says `24 DIRECT`, and the second
> parse reproduces that exactly — so the first was mis-columned and reading a
> subset. The figures above are the ones that agree with the add-on's own
> computed summary.

---

## 4b. The controller link, and the RF floor

These are the two failure modes that **mimic mesh-wide device trouble** and are
therefore reported apart from it: a sick serial link and a noisy band both look
like "every node got worse at once".

### Host ↔ stick (Zooz ZST39 LR · FW 1.70 · SDK 7.24.2 · USA Long Range · primary/SUC/SIS)

| lifetime | | recent (1 h) | |
| --- | ---: | --- | ---: |
| dropped RX | **18** | node reply timeout | 0.0/h |
| dropped TX | 0 | timeout-ACK | 0.0/h |
| messages RX | 10 180 | CAN | 0.0/h |
| messages TX | 7 008 | NAK | 0.0/h |
| NAK · CAN · timeout-ACK · timeout-cb | 0 · 0 · 0 · 0 | | |

**0.10 % lifetime error rate**, entirely the 18 dropped RX frames. Lifetime
totals cannot say whether a fault is *current*, which is why the per-hour rates
are shown beside them rather than instead of them — all four are flat zero.

### Background noise floor (driver-measured, 900 MHz)

| ch0 | ch1 | ch2 | ch3 | median |
| ---: | ---: | ---: | ---: | ---: |
| −98 dBm | −99 dBm | −99 dBm | **−87 dBm** | −98 dBm · *clean* |

14-day span, peak −96 dBm, quietest −100 dBm, from persisted 30-minute buckets
that survive restarts.

**ch3 runs ~11 dB hotter than the other three, persistently.** That is the one
genuinely interesting number on this page: it is not a fault — the median is
clean and no detector is armed by it — but it is a standing asymmetry in the
band, and a node that later degrades on ch3 has a candidate explanation waiting.
The margin reference is the *measured* floor (−98 dBm), not the −95 dBm assumed
fallback, so every margin in §4a is relative to real conditions.

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
> together. The zero was withdrawn rather than published with a story attached.
>
> **Now measured, and the zero is refuted — see §5a.** The cause is also
> understood, and it is instructive: the first re-measurement attempt used
> quiet-detection to separate the opening paint from the steady state, and the
> line never fell quiet, so every steady-state field came back `0`. That is very
> likely the original failure too — *a heuristic that never fired, reported as a
> measured absence*. The replacement uses fixed time windows and no heuristic.

---

## 5a. Per-session bandwidth

Measured against the live add-on (v0.63.7 on the Pi) over a 60 s window after a
10 s warm-up, with the terminal size negotiated over telnet NAWS. No
quiet-detection, no averaging across the opening paint.

| terminal | opening paint | median | p95 | **steady** |
| --- | ---: | ---: | ---: | ---: |
| 80 × 24 | 50.0 KB | 4 994 B/s | 9 988 B/s | **4.96 KB/s** |
| 200 × 60 | 179.0 KB | 17 395 B/s | 31 875 B/s | **17.22 KB/s** |

The 200×60 figure **confirms** the ~17 KB/s this document already carried. Only
the 80×24 zero was wrong.

### It is not a rate — it is the frame size

At both sizes the maximum second is **exactly twice the median**, with a
scattering of zero-seconds. That is not burstiness: it is a whole-frame redraw
on a 1 Hz timer, sampled by a 1 s clock that drifts against it, so occasionally
two frames land in one bucket and occasionally none. `telnet/server.ts:419`
confirms it in one line:

```js
conn.timer = setInterval(() => session.draw(), 1000);
```

So per-session bandwidth is not an empirical rate to be sampled; it is
`frame_bytes × 1 Hz` — about 4 994 B per frame at 80×24 and 17 395 B at 200×60
(≈2.6 and ≈1.45 bytes per cell, the difference being ANSI colour runs amortised
over more cells).

A short run that happens to align with the redraw clock shows this with no noise
at all — min, median, p95 and max all identical:

```
$ node scripts/bw-probe.mjs <pi> 2324 80 24 3 8
{"steadyBytesPerSec":4994,"medianBytesPerSec":4994,
 "minBytesPerSec":4994,"maxBytesPerSec":4994,"zeroSeconds":0}
```

Zero variance across eight seconds is not a smooth average of a bursty stream;
it is one constant-size frame per second.

Against the 32-session policy cap that is ~550 KB/s worst case, ≈4.4 Mbit/s.
This was never a capacity question, and re-measuring it was about **correcting a
published number**, not about finding a limit.

> Reproduce: `scripts/bw-probe.mjs <host> 2324 <cols> <rows> <warm-s> <meas-s>`.
> It negotiates NAWS, discards the warm-up window, and prints the per-second
> series so the 2× peaks are visible rather than asserted.

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

- ~~**Where the harness's 836 s goes.**~~ **MEASURED in v0.64.0 — see §3.**
  `--profile` now reports the phase breakdown on any run. The result overturned
  the standing guess: the harness is CPU-bound on `tsx` transpilation (69 % of
  the run), not startup-bound (~9 % by two independent measurements).
- ~~**Per-session bandwidth.**~~ **MEASURED in v0.64.0 — see §5a.** 4.96 KB/s at
  80×24 and 17.22 KB/s at 200×60. The withdrawn zero is refuted and its cause
  identified; the 17 KB/s figure this document already carried is confirmed.

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
| 2026-09-07 | v0.64.0 | §3 phase profile measured (`--profile` + `time -l`) — **"startup-bound" refuted**: 70 % is `tsx` re-transpilation, ~10 % is spawn; §5a added — per-session bandwidth measured and the withdrawn 0 KB/s refuted, with its cause identified; §4a/§4b added — the mesh itself: composition, links, margins, controller frames, RF floor; §4 refreshed; every table sorted for lookup |
| 2026-09-06 | v0.63.6 | README's summary contradicted this document — the retracted 249 µs and "93 MB resident" were still quoted there |
| 2026-09-06 | v0.63.5 | interference fold miss measured (0.87 ms, 0.09 % of budget) and time-to-useful-frame measured (no gap after listening); §7 triaged from 10 items to 2 worth measuring, 5 deliberately not, and 1 that was never a gap |
| 2026-09-06 | v0.63.4 | **substantial correction after an adversarial audit** — render figures re-measured with a fresh `ViewState` (Overview 80×24 was understated 3.5×), Interference/Controller withdrawn as unmeasured, two cold-start figures and the bandwidth row retracted with their causes, §1/§3 claims scoped to what the samples support, §7 expanded from 4 items to 10 |
| 2026-09-06 | v0.63.3 | first record: runtime footprint, render benchmark, verification cost, live engine figures |
