# Performance Record (living document)

Measured figures for the Z-Wave TUI add-on: what it costs to run, what it costs
to verify, and what the engine has actually learned on a live mesh.

**Every number here was measured, not estimated.** Where a figure is a single
observation rather than a distribution, it says so. Where something is *not*
measured, it is listed in §6 rather than filled in with a plausible value — the
same rule the screens themselves keep.

Reproduce any of it with the commands given; each section names its own method.

- **Measured at:** v0.63.2, 2026-09-06
- **Reference mesh:** 39 nodes (38 + controller), Zooz ZST39 LR 800-series,
  ~14 days of continuous evidence
- **Host:** Raspberry Pi 5, Home Assistant OS, add-on container
- **Dev machine (build/verify figures):** Apple silicon, Node 26

---

## 1. Runtime footprint

From `ha apps stats local_zwave_tui`, add-on running normally with both
transports live and one telnet session attached:

| | measured |
| --- | --- |
| CPU | **0.02 %** |
| Memory | **93.2 MB** (1.2 % of the host's 7 952 MB) |
| Network, lifetime | 4.1 MB rx · 0.8 MB tx |

The process is a long-running Node server holding an evidence ring, a baseline
store and an outcome ledger in memory; the memory figure is steady-state, not a
cold-start reading. CPU is essentially idle between the 1 Hz redraw and the
statistics subscription — the engine's per-tick work is bounded by node count,
not by traffic.

**Method.** `ha apps stats local_zwave_tui --raw-json` on the host.

---

## 2. Render cost

The TUI repaints once a second. The budget is therefore ~1 000 ms per frame, and
the interesting question is not whether rendering is fast enough but by how much
— because the draw path is pure and re-runs entirely on every frame.

Mean over 500 iterations per screen, after a warm-up pass, on a synthetic
39-node roster:

| screen | 80×24 | 200×60 |
| --- | --- | --- |
| Overview | 109 µs | 249 µs |
| Detail | 39 µs | 43 µs |
| Controller | 35 µs | 44 µs |
| Topology | 106 µs | 120 µs |
| Heatmap | 46 µs | 28 µs |
| Log | 16 µs | 11 µs |
| Remedy | 11 µs | 10 µs |
| Interference | 23 µs | 21 µs |
| Engine | 15 µs | 10 µs |

The worst case is **Overview at 200×60: 249 µs**, about **0.025 % of the frame
budget**. Overview and Topology dominate because both iterate the whole roster —
Overview lays out 39 rows across up to twelve columns, Topology walks the hop
tree — while the overlay screens render one node or one summary.

Heatmap, Log and Engine are *faster* at the larger size, which looks wrong and
is not: at 80 columns those screens do additional shedding work (choosing among
ladder forms, measuring what fits) that the wider frame skips.

**Method.** `renderScreen()` called directly with a fixed provider, outside the
session and transport layers, so the figure is the draw path alone and excludes
socket writes. The benchmark is not committed — it is a one-file script using
the same public entry point the session uses; the fixture shape is in this
document's history.

---

## 3. Verification cost

The release gate is not the test suite alone. Both must be clean.

| | measured |
| --- | --- |
| Test suite | **1 061 tests, 11.4 s** (`npm test`) |
| Mutation harness | **541 mutants, 836 s wall / 621 s CPU** (`node scripts/mutation-check.mjs`) |
| Source | 24 457 lines TypeScript |
| Tests | 18 614 lines |

Latest full run: **533 killed · 0 survived · 8 equivalent · 0 missing ·
0 ambiguous · 0 invalid · 0 relabel.**

The harness runs ~73× longer than the suite because each mutant re-runs tests in
a child process. It is **startup-bound, not CPU-bound** — note wall 836 s against
user 621 s — which is why the kill-fast selection (run only the test files that
provably catch a given mutant, fall back to the full suite when they come back
green) is worth its bookkeeping.

`SURVIVED`, `MISSING`, `AMBIGUOUS` and `INVALID` are all failures, not warnings.
An anchor pre-flight checks every mutant's target text against its file *before*
any test runs, so a stale entry costs a second rather than the full 14 minutes —
it fired six times during the v0.51–v0.63 work, each time on an anchor one of my
own edits had moved.

**Method.** `/usr/bin/time -p` around each command, cold, nothing else running.

---

## 4. What the engine has learned

The most meaningful performance figures are the ones the engine measured about
the mesh rather than about itself. Live readings, taken 2026-09-06:

**Detector coverage** — `timeouts 38/38 · rtt 22/38 · rssi 22/38`. Timeout
baselines have graduated for every node; the continuous series have not, and
structurally may not: baselines reset on a route change, and a repeater-routed
node must hold one route for roughly two weeks to graduate a single band. The
screen reports this as *partial coverage*, not as health (see §6).

**Learned efficacy**, with the decayed weight `n` and the node count behind each:

| symptom kind | action arm | control (self-heal) |
| --- | --- | --- |
| `rtt-degraded` | ping — not distinguishable (n≈17.8, 4 nodes) | 82 % (n≈17.3, 18 nodes, n≈0.8 worse) |
| `rate-fallback` | ping — not distinguishable (n≈12.9, 3 nodes) | 67 % (n≈16.8, 11 nodes) |
| `route-churn` | — | still learning (n≈1.0 of 4) |

**Read the "not distinguishable" rows as the system working.** The ledger will
not credit an action until its Wilson lower bound clears the control arm's own
rate by a real margin across at least two nodes. On this mesh a ping has not
beaten spontaneous recovery for either kind — so the engine says so, rather than
claiming an efficacy it has not earned.

**Evidence quality**, `rtt-degraded`: 28 unscoreable (thin evidence) · 1
transient blink · 4 undersampled · 11 unprobeable · 1 confounded. These are
counted and shown rather than folded into the denominator, because an episode
that could not be scored is different from one scored as a failure.

**Auto-ping**, at the time of reading: `running · candidates 35 · dead 0 ·
sweep-due 0 · verify-owed 0`, dwell 10 min, max 3 attempts per outage, 120 min
liveness sweep.

**Noise floor:** −99 dBm measured (not assumed), 14-day span, peak −94 dBm,
quietest −100 dBm. Worst diurnal hour 22:00 at 0.9 % of 451 tx.

---

## 5. Publishing cadence

| | measured |
| --- | --- |
| HA state re-publish | every **30 s** (four entities) |
| Release image build (CI, multi-arch) | ~**90 s** after the tag |
| Add-on update on the host | one supervisor reload round, seconds |

The 30 s state cadence is also the self-heal window: the entities are unmanaged
(REST-created, no device, no `unique_id`) and do not survive a Home Assistant
Core restart, so re-publishing is what restores them.

---

## 6. Not measured — and why it is listed rather than filled in

- **Cold-start time to first useful frame.** Not instrumented. The boot log
  gives ordering, not durations.
- **Evidence-store size on disk.** The `/data` volume is add-on-private and was
  not reachable from the host shell during this pass; the size budget is
  *designed* (fine ring bounded in samples, coarse tier at a 14-day horizon) but
  the on-disk figure here would be a guess.
- **Render cost under a symptom load.** The §2 figures use a clean roster.
  REMEDY and ENGINE both grow with open symptoms and episodes, so their real
  worst case is above the number given.
- **Throughput limits.** No load test exists. The per-IP telnet cap (4) and
  global cap (16) bound concurrency by policy, not by measured capacity.
- **Whether the rtt/rssi coverage ceiling can be raised.** Measured at 22/38 and
  understood (route churn resets continuous baselines); five redesigns were
  evaluated and rejected, each with a concrete false-symptom scenario. The
  ceiling is a property of the mesh, not a defect to be tuned away.

---

## 7. History

| date | version | what changed |
| --- | --- | --- |
| 2026-09-06 | v0.63.2 | first record: runtime footprint, render benchmark, verification cost, live engine figures |
