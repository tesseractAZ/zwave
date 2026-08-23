# Changelog

## 0.37.3 — 2026-08-23

**I made the same error twice: checking the count and never the span.**

v0.37.2 raised `VERIFY_BURST` from 3 to 5 for margin over the verifier's floor.
Production showed that made it worse. Node 26 took **seven probes at a steady
+120 s** and still closed `unverifiable`:

| | |
|---|---|
| effective spacing | 120 s (70 s requested, rounding up to the next 60 s tick) |
| a 5-probe burst spans | **480 s** |
| the window it must fill | **300 s** |

A burst longer than its own window can never fill it: probes 1–2 age out before
4–5 arrive, so the window holds two or three readings no matter how many are
fired. Raising the count stretched the stream. Both times I checked the count
against `MIN_OBS` and never the span against `WINDOW_MS`.

`VERIFY_SPACING_MS` drops to 30 s — below the tick, so the tick is the limiter
and the real spacing is 60 s. A 5-probe burst then spans 240 s inside the 300 s
window, with two readings spare.

**And a second constraint the span check cannot see.** Releasing one node per
tick is FIFO, so each burst stays contiguous — but node B's burst does not
*begin* until node A's five probes finish, five minutes later. A confirmation
burst is timed to land in one specific window; starting it late puts every probe
past the edge. Tight but late is exactly as useless as spread out. Up to four
nodes are now released per tick.

That second one was found by a **surviving mutant**: the contention change
initially had no test that could fail without it, because span alone doesn't
distinguish FIFO from parallel. The mutant surviving is what showed the real
invariant was burst *start* time, not burst span.

Both facts are now stated as arithmetic in the tests, so they survive any later
change to the tick, the window, or the floor.

769 tests. 227 mutation entries.

## 0.37.2 — 2026-08-23

**The diagnostic refuted my hypothesis, and the real cause was simpler.**

v0.37.1 shipped a measurement rather than a fix, on the theory that verification
bursts were being stretched by contention for the one-per-tick queue. The
numbers came back:

    burst start, 3 owed
    +120s, 2 owed
    +120s, 1 owed
    +120s, 2 owed

Intra-burst spacing held at a steady **+120 s** at every contention level
observed, and a node scored `improved` at the *highest* contention seen. The
contention hypothesis is **refuted**. Shipping the FIFO rewrite it implied would
have been effort spent on a story.

**The actual cause is that the burst had no margin.** `VERIFY_BURST` was 3 —
"exactly the verifier's floor, and no more traffic than that requires", which I
wrote myself. But `MIN_OBS = 3` means three readings must all land, all be
sampled, and all carry a non-null RTT inside one 300 s window, from a burst
whose tick-rounded spacing already makes it span 240 s. Lose one probe to
ordinary transient RF — measured at ~2 % on this mesh today — or slip a single
tick, and the window holds 2 of 3 and the verdict fails closed. Choosing exactly
the floor left no room for the ordinary. It is now **5**: margin for one lost
probe plus jitter, at one extra ping per episode boundary.

**The diagnostic was also lying slightly, and is fixed.** It reported time since
the node's previous verification probe regardless of which burst it belonged to,
so the minutes-long pause between an episode's open-burst and its confirm-burst
read as a single stretched burst — indistinguishable from the contention it
existed to test for. A gap longer than a burst's own span is now reported as
`burst start`.

**Also documented: battery/FLiRS nodes can never be verified.** `isPingCandidate`
requires `isListening`, so a sleeping device is never probed by any lane — waking
one every cadence would flatten it. Their episodes therefore close `unverifiable`
by construction, which is neither a fault nor fixable, and which dilutes the
"could not be scored" counter that was built to flag the fixable kind. Confirmed
in production: nodes 60 and 61 have never appeared in a single auto-ping line in
the entire retained buffer, while node 32 — listening — scored `improved`.

767 tests. 225 mutation entries.

## 0.37.1 — 2026-08-23

**A diagnostic, shipped deliberately ahead of a fix.**

Two episodes closed `unverifiable` on quiet-but-alive nodes that had received
**8 and 5 verification probes** — the exact case v0.36.3's burst timing was
meant to solve. RTT readings are not the problem: `rtt-degraded` is the symptom
that fired, and its detector needs a fresh RTT reading to arm.

The leading hypothesis is that burst spacing does not survive contention.
`drainVerifyRequests` hands out **one node per tick globally**, while each
node's burst wants 70-second spacing. With a single node owed a burst the three
probes land ~2 ticks apart and fit inside the 5-minute after-window — which is
what happened when node 6 scored `improved`. With several nodes competing, each
one's probes stretch further apart until the burst can no longer fit the window
it exists to fill. Two individually-correct mechanisms — per-node spacing and a
global rate limit — composing badly, which is the same shape as four earlier
defects this cycle.

**It is not shipped as a fix, because the cause is not confirmed.** The add-on
log carries no timestamps and the decision trace prints only on change, so the
actual inter-probe spacing is unmeasurable from outside. A fix aimed at a
plausible story rather than a demonstrated cause is a guess, and this cycle has
already produced two of those (a retracted DNS root cause, and a power-cycle
recommendation for a node a single ping revived).

The probe line now reads:

    auto-ping: node 11 verification probe (episode evidence, +140s, 2 owed)

— the real gap since that node's previous verification probe, and how many nodes
were dividing the one-per-tick queue. If the gaps stay under ~140s with several
owed, the hypothesis is wrong and the cause is elsewhere; if they stretch with
contention, the fix is FIFO-by-node instead of round-robin, which costs no extra
traffic.

765 tests. 223 mutation entries.

## 0.37.0 — 2026-08-23

**A dead node was invisible, and the sweep was measuring the wrong thing.**

### `node-down` — the ordinary outage now surfaces

`dead-flap` requires three Alive↔Dead transitions, so it only ever fires on a
node that is oscillating. The ordinary outage — node dies, stays dead, gets
probed, comes back — produces one or two, and was therefore invisible to the
symptom engine **entirely**: `grep NodeStatus.Dead src/zwave/symptoms.ts`
returned nothing. A node that was dead for hours never appeared on REMEDY.

`node-down` fires for a mains/listening node the driver has marked Dead past a
dwell. Deadness is a driver *verdict* — `Dead` is set reactively, only when a
transmission fails — which is why it is distinct from `quiet-node`, whose whole
premise is that silence is *not* proof of failure.

**It deliberately opens no outcome episode**, and an adversarial review is why.
The first design gave it an `alive` recovery metric so auto-ping's efficacy
could finally accrue. Two independent reviewers, one of them by executing the
real store, showed that metric was structurally incapable of ever crediting the
action: an episode closes only when the symptom goes absent, `node-down` is
absent exactly when the node stops being Dead, so every closure is a recovery,
both arms saturate at `ok === n`, `baseRate` pins at 1.0, and the Wilson gate
needs 1.05 — which `wilsonLower(n, n)` approaches from below and never reaches
at any n. Shipping it would have been the declared-but-unreachable defect class
this project has spent six releases removing, committed inside the fix for it.

A second problem survives fixing the first: auto-ping is applied non-randomly,
only to outages that already survived its dwell, so a control arm would fill
with fast self-heals and the action arm with hard cases. Any difference would
be selection, not efficacy. DOCS §9.7a records both, and `metricOf` returns
`none` rather than manufacturing a statistic that reads like evidence.

### The liveness sweep now asks EVERY node

Through v0.36 it probed only nodes silent past `staleMs`, on the reasoning that
a talkative device proves itself and costs nothing to skip. True for operations,
fatal for measurement: a reply rate sampled only when a node happens to be
silent describes how talkative it is, not how reachable.

Every listening non-Dead node is now asked on the same cadence, and outcomes are
**persisted per node** — `probesAsked` / `probesAnswered` / `probesSelfProven`
on `NodeCoverage`, surfaced on NODE DETAIL as `81/84 answered (96%) · 22
self-proven`. The cost was measured before the trade was made: on the reference
mesh all 35 candidates were already crossing the threshold, so asking everyone
is barely more traffic than asking the quiet ones.

`probesSelfProven` counts probes where the node had already communicated within
the cadence — a bare ratio cannot tell a device whose own traffic keeps proving
it alive from one whose only evidence is the probe. This measures what the
driver cannot: `Dead` being reactive, a node nobody addresses reads Alive
indefinitely.

### Three bugs the implementation surfaced

- Reading `lastStaleAt` **after** `noteStale` overwrote it compared each node's
  last contact against *now* — nothing is ever newer, so every node reported as
  unheard.
- Treating a never-probed node as self-proven declared a device silent for
  eleven hours to be "confirming itself". The honest test needs no probe history
  at all: did it speak within one sweep interval.
- The trace dedup keyed on the whole line including `stale-due`, which now
  churns every tick as the queue advances — a change-plus-heartbeat trace would
  have become a per-minute drumbeat. It now dedups on the decision's shape.

756 tests. 223 mutation entries.

## 0.36.5 — 2026-08-20

Two refinements to signals this release cycle created, both driven by what the
live mesh actually did rather than by what the design assumed.

**A single lost packet is not a warning.** Measured across ~98 probes: excluding
one genuinely broken node, 2 went unanswered — about 2 %, one each on two
different healthy nodes. Each produced a line textually identical to the
fifteenth consecutive failure of a device that was actually down. Consecutive
misses are now counted (`3rd consecutive miss`), any answer resets the streak so
the ordinal always means "in a row", and severity follows: first miss `info`,
streak `warn`. Nothing is hidden — a first miss is still logged — it is simply
no longer called a warning, because a steady drip of false alarm beside the
genuine article teaches an operator to skim past both.

**One node repeating is not six nodes agreeing.** The outcome arms are marginal
by design, so a single pathological device can saturate one. Within hours of the
ledger first working, one flapping node produced six `no-change` episodes and
pushed the fleet-wide `(rtt-degraded, ping)` arm past `minEpisodes` entirely on
its own. The statistics were honest; the provenance was invisible. `Efficacy`
now carries `nodes`, the count of distinct nodes that fed the arm, and REMEDY
renders it inline: `≈ n=6 · 1 node: not distinguishable from self-healing`. It
is cumulative and deliberately not decayed — it answers how *broad* the evidence
is, which does not narrow with age the way a rate does. A ledger predating the
tracking reports `0`, which renders as nothing rather than a fabricated
"0 nodes".

**Harness hygiene.** The full mutation run surfaced **5 MISSING mutants** whose
anchors this cycle's own releases had edited out from under them — the attempt
cap that became a block in v0.36.4, two remedy notes that gained provenance
here, `verifyDue` becoming a thunk in v0.36.2, and the probe-answer line that
gained the streak. A MISSING mutant is silent rot: it sits in the list looking
like coverage while protecting nothing, and a green suite says nothing about it.
All five repointed and individually verified killing.

747 tests. 214 mutation entries: 210 killed, 0 survived, 0 missing, 4 equivalent.

## 0.36.4 — 2026-08-20

**The engine gave up on a node and never mentioned it.** `maxAttempts` is
documented as "attempts per dead episode, after which we stop and leave it to a
human". It did the stopping. It never did the leaving-it-to-a-human.

The gate was a bare `continue` — no log line, no event — and `attempts` resets
only when a node *leaves* Dead. So a node that stays down is abandoned
permanently and in silence. The last thing an operator sees is a failed probe,
and then the log simply moves on, which reads exactly like recovery.

Observed live: node 23 exhausted 3/3 attempts and auto-ping said nothing for the
**next 80 minutes**. The node was very likely revivable that entire time — it
was eventually recovered by a single manual ping. The operator had no way to
know the engine had quit, and the maintainer (me) read the same silence and
escalated to "this needs a physical power-cycle", which was wrong.

`decideAutoPings` now returns a `gaveUp` lane. The runner announces it at
**error** severity on both destinations — the one auto-ping message that asks
for action rather than reporting activity — once per outage, re-arming on
recovery so a device that dies again is reported again.

This is the fifth defect of the same class found today, and the most consequential:
the engine going quiet at exactly the moment a human is needed. The others hid
data from a screen; this one hid a request for help.

## 0.36.3 — 2026-08-20

**The after-window probes were landing outside the after-window.** v0.36.0
requested the confirmation burst the instant a symptom went absent. `resolve()`
runs `CONFIRM_MS` (10 min) later and cuts a trailing `WINDOW_MS` (5 min)
after-window — so all three readings were roughly eight minutes old by then, and
every one had aged out of the very window it existed to fill.

Caught in production, not by the suite: node 55, a quiet-but-alive node of
exactly the class this release targets, took **four answered verification
probes** and still closed `unverifiable`. The probes worked; they were simply
measured after they had expired.

`confirmBurstDue` now holds the burst until the pending age reaches
`CONFIRM_MS - WINDOW_MS` — the moment the after-window opens — so the whole
burst lands inside the slice that will actually be measured.

**Widening the after-window would have been the wrong repair.** The confirm
dwell exists precisely so that window settles past the recovery transition;
stretching it back across the confirmation period would re-admit the unsettled
readings the dwell is there to exclude. The burst moves, not the window.

Tests state the fix as arithmetic rather than as a constant — every probe of a
due burst must fall within `[resolve - windowMs, resolve]` — so the property
survives any later change to the dwell or the window. Two mutants pin it.

## 0.36.2 — 2026-08-20

**A gated tick was spending the budget it never used.** The runner drained the
outcome ledger's verification queue while *building* the decision input, and
`decideAutoPings` then returned early at any suppressor — so a tick that sent
nothing still consumed a probe from the node's burst. At one tick a minute, a
five-minute boot window could exhaust an entire three-probe burst without a
single packet reaching the mesh, and the episode closed `unverifiable` exactly
as it had before v0.36.0 fixed anything.

That window is the worst possible one to lose: a restart re-detects many
symptoms at once, so episodes cluster precisely there. The same held for a route
rebuild and for a storm.

`verifyDue` is now a **thunk**, resolved past every gate, so the queue is
touched only on a tick that will actually probe.

Both halves of this were individually correct and individually tested — the pure
decision function given a list, and the queue drained in isolation. Only their
join was wrong, which is why nothing caught it until the deployed release was
watched in production. A runner test now pins the invariant across all four
suppressors, and was verified to fail against a hand-applied regression.

## 0.36.1 — 2026-08-20

**A new autonomous write must be greppable.** v0.36.0's verification probes
reached the event ring at info but the server log only at debug, on the
reasoning that three probes per episode boundary would swamp the add-on log.
The arithmetic does not survive contact with the mesh: roughly 60 verification
probes per 39 hours against ~635 existing liveness probes is about a tenth
more, not a flood.

The cost showed up within minutes of deploying v0.36.0 — the release could not
be verified from the container log at all, which is the same shape of failure
`autoPing.ts` already documents one screen above the offending line: auto-ping
was once diagnosed as a no-op purely because its evidence sat somewhere the
diagnosis never looked. That file's own rule is "An autonomous action must be
visible in BOTH", and v0.36.0 broke it in brand-new autonomous-write code.

Verification probes now log to both destinations. The per-probe **answered**
confirmation stays at debug deliberately — several hundred lines a day saying
"as designed" is the noise that trains an operator to stop reading — while the
**unanswered** case, the actual signal, is warn on both. A mutant pins the rule.

## 0.36.0 — 2026-08-20

**The learning loop can finally learn.** A post-deploy audit of v0.35 running on
the live 39-node mesh found the outcome ledger structurally inert: **16 of 16
episodes closed in a 39-hour window scored `unverifiable`**, feeding neither
arm, with the persisted ledger holding one control kind and zero action arms
after months of operation. Nothing was broken in the sense of a bug — every
floor was doing exactly what it was written to do. The gap was between them.

### The asymmetry

| | evidence required |
|---|---|
| Detector (`latestFresh`) | **one** fresh reading |
| Verifier (`MIN_OBS`) | **three** fresh readings in *each* of two 5-minute windows |

A detector allowed to fire on evidence the verifier is forbidden to accept —
on nodes whose sample rate the add-on itself schedules. A quiet node's only
traffic is the liveness probe at 120-minute intervals, roughly 72× short of
three-per-five-minutes, so the verdict was settled before the episode opened.

**No floor was lowered to fix this.** Lowering them would manufacture confident
verdicts out of medians-of-one, which is the fabrication this codebase exists
to refuse. Three changes close the gap by supplying evidence instead:

- **The before-window now spans the breach.** A symptom surfaces at dwell
  maturity, and the dwell equals the lookback — so a trailing window opened at
  emission began exactly where the firing observation ended, and the reading
  that proved the node degraded was excluded from the evidence for its own
  episode. `degradedSpan` runs from one lookback before the breach through to
  emission; every sample in it belongs to the same live symptom.
- **Verification probes** at the two moments a verdict depends on — episode
  open (filling the degraded window while the symptom is live) and symptom
  absence (filling the confirmation window). Three probes, exactly the
  verifier's floor and no more traffic than that requires, spaced 70 s so each
  is a separate observation rather than three packets carrying one reading's
  worth of information. Requests top up, never stack: a symptom that flaps ten
  times still owes one burst. They are cleared by `decideAutoPings` alongside
  the existing lanes, so they pass the **same** gate ladder as every other
  autonomous write — master switch, boot window, rebuild, storm — and a Dead
  node is never verification-probed, because the remediation path owns it with
  its own dwell, backoff and attempt budget.
- **`refineBefore`** folds probe evidence into an open episode's before-window
  each tick *while the symptom is still live*. Strictly-better only, never on a
  scored episode. The live-ness gate is load-bearing: an episode inside its
  confirmation window has already recovered, and folding those readings into
  `before` would quietly compare the node against itself healthy.

### The silence is now legible

`OutcomeStore.unverifiable(kind)` counts every episode the ledger could not
score, and REMEDY renders it per card: `○ 16 past episodes of this kind could
not be scored — too few readings to judge recovery`. An empty efficacy table
reads exactly like a patient one; this is the number that tells an inert ledger
from a patient one. Suppressed at zero, persisted, and absent from pre-v0.36
files without complaint.

### Auto-ping could not tell whether a probe was answered

The ping verb is `call_service button.press`, and HA's zwave_js ping button
awaits `node.async_ping()` — which returns a boolean and raises nothing when
the node stays silent. The service call fulfils either way, so the `.catch`
around it could only ever fire on "no ping button" or a WS transport fault,
never on the outcome auto-ping exists to detect. Both `did not answer` log
lines were unreachable for their stated purpose.

`judgeProbeAnswers` now asks the only question that has an answer: 90 seconds
after a probe, did the node's `lastSeen` advance past the moment we sent it? A
node missing from the roster is judged **neither** way — a roster gap is not
evidence of a failed probe, and calling it one would manufacture exactly the
false alarm this signal exists to avoid.

### Documentation

DOCS §9.7 is new (evidence starvation and the probes); §11.12 documents the
probe-answer truth and the verification lane. The as-built limitations section
had claimed timeout-rate-only scoring with per-kind metrics as "a future
refinement" long after they shipped — corrected in both DOCS and the source
comment an auditor would read to understand the mechanism.

### Guards

729 tests. 203 mutants, 14 new this release covering: the unscoreable counter
(and that counting never promotes an episode into an arm), refineBefore's
strictly-better and never-after-scoring rules, the breach-spanning window, the
verify lane's gate obedience and dead-node exclusion, probe-answer judging in
all three states (answered / silent / roster gap), burst non-stacking and
spacing, the zero-suppressed REMEDY row, and the production bridge forwarding.

## 0.35.0 — 2026-08-17

**Everything the engine already knew, and never said.** An audit of declared-but-
unreachable capability found thirteen items: data the add-on had been computing,
persisting, and in several cases *learning from* for many releases, that no
screen or caller could reach. This release closes all thirteen — each one either
wired to a surface or deleted, with a mutant per behaviour so none of them can
quietly go dead again.

### Wired — four things the engine knew and could not tell you

- **Which LINK broke.** `routeFailedBetween` is transient on the live stats
  object, which is why the evidence store has latched every occurrence to disk
  since v0.13 — and nothing had ever read it back. TOPOLOGY gains a **Route
  failures** panel that tallies by the *pair*, not the reporter: one marginal
  hop that six nodes all witnessed is one row saying six, not six rows saying
  one. `n12 ⇢ n44  6 failures · last 4m ago`. A node-level symptom says "n44 is
  unreliable"; this names the hop to go look at.
- **Whether anyone was listening.** NODE DETAIL gains an **EVIDENCE** section:
  cumulative sample count, the *fresh* share, how long the node has been
  watched, the persisted history span, and a live/down badge per feed. A node
  whose status and stats feeds are both down now says **MONITORING HOLE** —
  because silence from an unwatched node is not health, and every quiet verdict
  elsewhere on that screen silently depends on someone having been listening.
- **The yardstick behind the verdicts.** The same section shows the engine's
  learned RSSI normal (`-62 dBm ±3 dB · 9d`). "Below its own normal" had been an
  unfalsifiable claim on screen — the accusation was visible, the baseline was
  not. An un-graduated band says *still learning* rather than quoting a median
  nobody should act on.
- **When the detector cried wolf.** REMEDY cards now carry the outcome ledger's
  own tally of episodes closed as `refused-misdiagnosis`. It had been counted
  since M5 and shown nowhere, which is a strange omission for an advisory
  engine: the one number that argues *against* the card was the one the card
  would not show. Silent at zero — a clean detector does not boast.

### Fixed — the learning loop could not overturn its own priors

The M5 efficacy note was rendered only on *runnable* candidates, on the sound-
looking grounds that a green "✓ helped" must never sit under advice saying NOT
recommended. That guard is right about the risk and wrong about the remedy:
`route-churn`'s only executable candidate is hardcoded `blocked`, so the
ledger's measurement of that action could never reach the screen at all. The
block reason is `lore`; the ledger is `measured`. Suppressing measurement
because it contradicts a prior is backwards — overturning priors is what the
loop is *for*.

Blocked candidates now report what was measured in a voice that endorses
nothing and judges nothing: `⚠ ledger measured 80% here (n=10) vs 20% self-heal
— the block above still applies`, or, on a null result, `≈ n=12: measured — not
distinguishable from self-healing`. The note deliberately does NOT characterize
the block: `blocked` carries planner advisories, the write-actions master gate,
and hard safety gates alike, and a first draft that appended "the block above
is lore" told the operator a battery/FLiRS safety gate was unfounded folklore —
the pre-merge review caught it, and a mutant now pins the neutral voice.

### Fixed — a removed node's baselines outlived it

`BaselineStore.resetNode()` had no caller; the triggers DOCS listed for it were
aspirational. It is now wired to a successful `removeFailed` via a new
`onNodeRemoved` hook. Once a node leaves the mesh, a later re-include on the
same node id is *different hardware*, and measuring it against the departed
device's normals is how the engine manufactures symptoms out of a device swap.
A **failed** removal fires nothing — the node is still there, and discarding a
live node's learned baselines is the larger harm.

### Also surfaced

- INTERFERENCE adds a companion count to a live correlated event: `meanwhile ·
  N nodes symptomatic across ALL detectors — not necessarily this event`. It
  was computed for every view since M6 and only ever reached the screen through
  the *inactive* narrative, i.e. it went dark at exactly the moment it
  mattered. Deliberately NOT labelled as the event's scope — the count includes
  faults unrelated to the event — and labelled apart from the detector's own
  "degraded X of Y active" ratio so the two numbers cannot read as one
  measurement disagreeing with itself.
- The LOG detail pane leads with the entity's **friendly name**, with the id as
  the secondary — width-gated so the id always survives whole: at 80 columns a
  leading name would push the id past the pane's right-truncate, clipping it
  into a different, plausible id, so when both cannot fit the name yields. The
  name was captured on every value event and discarded at the render, so a pane
  whose whole job is "which thing did this?" answered with a slug.
- NODE DETAIL shows the **HA device id** — the exact string a `device_id:`
  automation target needs, and one HA's own UI makes awkward to copy.
- `/api/health` reports `haError`: the HA socket's *own* last failure. An auth
  rejection or a refused connect leaves the data layer with nothing to say but
  "not ready", so the only line naming the actual cause was the one the endpoint
  did not print.

### Removed — fields that could never be wrong

Four declarations were pure duplicates of something already live, and a
duplicate cannot disagree with its source until someone edits one side:

- `Efficacy.beatsSelfHealing` — was `expectedEfficacy != null` by construction.
- `HealthResult.rating` — was `round(score / 10)`, computed in five places and
  read in none.
- `OutcomeStore.openKeys()` — `openEpisodes()` already carries the keys.
- `NodeEntity.state` — never assigned; live state is `EntityLiveState`.

And three were simply dead: `HaWsClient.registerEventHandler` /
`unregisterEventHandler` (`subscribe()` touches the handler map directly),
`HaWsClient.isConfigured()`, and `ViewState.followTail` (written once at session
construction, read never).

### Pre-merge review round (this release, before it shipped)

A 6-lens adversarial review of the unmerged diff (115 agents; every finding
attacked by three independent refutation lenses) confirmed 9 findings and 6
gaps — all fixed in this same release:

- **The Route-failures panel named zero links at the default terminal.** The
  disclosure arithmetic subtracted the "+N more" row twice, and the pad split
  pins the panel's budget to 3 rows for every leftover-pad size from 3 to 7 —
  i.e. 80×24 — so with two or more failing links it rendered a header and
  "+7 more" above nothing, while evicting stability rows that had been naming
  real nodes. The same off-by-one existed in the stability panel since v0.34.
  Both fixed; a step-1 size sweep now pins the invariant that a disclosure
  line never renders above zero shown items.
- **EVIDENCE feed badges glowed green through an HA-socket outage.** The
  subscription idempotency sets survive a disconnect, so on their own the
  badges meant "a subscribe once succeeded". Now ANDed with the live socket:
  both go dark in an outage — exactly when MONITORING HOLE must be able to
  fire.
- **The departed-node eviction sweep now forgets baselines too** — the
  onNodeRemoved hook only covered removals issued from this TUI; a node
  excluded from HA's own UI kept its dead device's learned normals keyed to a
  reusable node id.
- **Honesty labels**: the fresh share is marked `lifetime` (cumulative — it
  cannot show current staleness); the learned normal is marked `this
  time-of-day band` (the store keeps one per 4-hour band); the History figure
  is marked a `span`, not coverage; zero samples renders a dash, never `0%`.
- The screenshot generator's `as HealthResult` assertion was hiding the
  deleted `rating` field from the very tsconfig gate added to catch it —
  assertion removed, field gone.

### Guards

- The v0.34 **bridge-completeness** test now round-trips every v0.35 member
  through `buildZwaveDataSource` — the object `index.ts` actually builds — so
  the class of defect that shipped a dead `M` key cannot recur on the new ones.
- Mutants added for pair-tallying, failure ranking, both panels' leftover
  funding and their bounded competition for it, both panels' single-subtraction
  disclosure, the monitoring-hole call, the fresh-share tone, the no-samples
  dash, un-graduated baselines and their band label, the socket-gated feed
  badges, the entity-name lead and the id's survival, the blocked ledger voice
  in both directions (endorses nothing, judges nothing), the zero-suppressed
  false-positive line, the companion count, and success-only baseline
  forgetting.

## 0.34.0 — 2026-08-17

**Route stability, measured.** `route-churn` has carried a detector and a full
planner card since v0.30 and has never once fired on the reference mesh — and
until now nothing could tell whether that meant *the mesh is stable* or *the
detector cannot see*. The evidence was being collected and persisted the whole
time; nothing read it back to a human.

- New `DataProvider.routeStability(nodeId)` sums the SAME `dRouteChanges`
  accumulator the detector reads, over the persisted coarse tier, and reports
  the measured span alongside it so the claim can never outrun its window.
- TOPOLOGY gains a **Route stability** panel:
  `every path held — 38 node(s), 3d measured, zero re-routes`.
  **Zero is a finding, not an empty state** — one confident line rather than 38
  rows each restating "0". When paths HAVE moved it ranks the culprits
  worst-first BY that per-DAY rate — the same number the row displays — because a
  6-hour store and a 6-day store are not comparable by raw count and the
  detector's own threshold is a rate. (Sorting by raw count put 10 re-routes over
  10 days above 4 over 2 hours, i.e. worst-SECOND.)
- An EMPTY measurement renders nothing at all. A confident "every path held"
  over no data would be exactly the fabrication the engine's collapse-method
  discipline exists to prevent; a mutant restores it and dies.
- The panel is **leftover-funded**: it spends only rows the route tree would
  have left blank. When the tree scrolls there is no pad, the panel does not
  exist, and the frame is byte-identical to before — the same rule the repeater
  panel follows since v0.29.

**Also fixes a defect v0.33.0 shipped:** `M` never worked. `ackEvent` was
implemented, wired through `dataProvider.ts`, unit-tested and mutation-proven —
and dead in production, because the running add-on builds its own
`ZwaveDataSource` in `index.ts` and that bridge omitted the method, so
`zwaveData.ackEvent?.(seq) ?? false` returned `false` on every real keypress.
Three things had to line up: the source members were declared OPTIONAL (so the
compiler stayed silent), the tests attached the methods to their own mocks (so
they exercised a path production never uses), and the live check confirmed the
add-on booted rather than that the key worked. `routeStability` was about to
ship through the same hole. The members are now REQUIRED — omitting one is a
compile error — and the bridge is extracted as `buildZwaveDataSource` so a test
can reach the object production actually runs.

Vertical pad at 200x80, measured against the 38-end-node fixture: baseline 32
blank rows; **30 in the zero state** (the panel's most valuable output is one
line, so it can only spend two); **1 when paths have moved**. The panel fills
the screen precisely when it has something to say. The zero-state remainder is
data-limited, not layout-limited: a 39-node mesh does not hold 77 rows of route
facts, and rearranging blocks into columns was tried, measured and reverted in
v0.29 — a sparse screen wants DATA, not furniture.

658 tests; 165 mutants, 0 survived (6 new this release). Render contract verified at
200x80, 160x40, 120x30, 100x24, 80x24 and 64x20.

## 0.33.0 — 2026-08-11

**The error-ack latch is real now.** Since v0.8 the Log screen declared
`acked?: boolean` and rendered errors two-tone (bold-red unacked, plain red
acked) — but nothing ever set the field, so errors latched bold-red forever
and the advertised acknowledgement did not exist (found by the v0.32.1 docs
verification; the README was corrected then, the interaction lands now).

- **`M` on the Log screen acknowledges the selected error**, releasing its RED
  latch to plain red. Keyed by the event's `seq`, so the head-inserting ring
  cannot drift the target under the cursor (the same anchor discipline the log
  cursor itself uses).
- Error-only and once-only **by refusal**: acking a non-error, a repeat, or a
  seq no longer on the ring returns false and the screen does not repaint.
- The latch is **shared**: the ring is one control-room log, so an ack records
  "a human has seen this" for every session — telnet and ingress alike.
- Not a mesh write (no RF, no HA call), so it deliberately sits outside the
  `write_actions_enabled` gate.
- The command bar advertises `[M] ACK` (drop priority 5 — first shed on narrow
  terminals, disclosed in the `+N` counter like every shed cap).

## 0.32.2 — 2026-08-11

- **Liveness probe default halved: 240 → 120 minutes** (`auto_ping_stale_min`).
  With the v0.32.1 timestamp fix proven live (every probe at 120–121 % of the
  threshold, one per node per cycle), the owner chose a two-hour check-in: a
  silently failed mains device is now discovered within two hours instead of
  four. Still self-balancing — a device that reports on its own is never probed
  — and still one probe per tick, stalest first.

## 0.32.1 — 2026-08-10

Three defects found by reading one evening's live log, plus the documentation
debt an adversarial docs audit surfaced.

- **Driver `lastSeen` timestamps are UTC without an offset — parse them that
  way.** zwave-js-server serializes `lastSeen` as an ISO date-time with no
  timezone suffix; `Date.parse` reads such strings as LOCAL time, so on any
  host west of UTC every timestamp landed hours in the future (seven, on the
  reference plant). Computed silence was wrong by that offset everywhere it was
  used — most visibly, the 240-minute liveness probe behaved as an 11-hour one.
  `parseLastSeen` now appends `Z` to offset-less date-times; explicit offsets
  are honoured untouched.
- **Shutdown can no longer crash on a mid-reconnect driver socket.**
  `terminate()` on a CONNECTING WebSocket emits `'error'` asynchronously; with
  listeners already stripped, that became an uncaught exception that killed the
  process mid-shutdown (observed after a watchdog SIGTERM during an HA Core
  restart). `teardownSocket` now parks a no-op error listener first — the same
  fix `haWsClient.stop()` received in v0.29.
- **The liveness-probe log line reports MEASURED silence.** It used to print
  the configured threshold as if it were the measurement, so every probe
  claimed exactly "240m" — a constant that masked the timezone skew for a full
  day. The line now carries the node's actual silence with the threshold
  alongside, so a wrong number can contradict itself in the log.
- Stale-probe cooldown bookkeeping is now swept when a node leaves the roster
  (a small leak, found while pinning the above).
- **Docs:** DOCS.md gains §11.12 — the full auto-ping register section the
  v0.30.0 release owed — and every "nothing auto-executes / advisory-only"
  absolute (intro, §1.8, §3, §11, §12.8, README) is corrected to name the one
  deliberate exception. §12.2 adds the four `auto_ping_*` option rows; §5.2,
  §7.3 and §9.1 catch up to v0.32.0's route-identity and s2-lane fields.
- **Screenshots regenerated** from the current renderer — and the generator's
  output path fixed: it wrote to `zwave_tui/docs/` (which nothing references)
  instead of the repo-root `docs/screenshots/` the README embeds, so a
  "successful" regeneration silently changed nothing.

## 0.32.0 — 2026-08-04

**`route-churn` fired on a definition, not on the mesh.**

The detector shipped in v0.30.0 and has never fired on the reference mesh. Why
it has not fired is still unmeasured — a stable mesh genuinely may not re-route
four times in ten minutes. What the investigation did establish is separate and
worse: the detector's input carried a **false-positive** vector, so the quiet
was not evidence of correctness. The codebase held TWO definitions of the
concept it counts.

`zwaveData` kept a private `routeKey()` that collapsed **"no LWR data"** and
**"direct link"** to the same empty string, while `evidenceStore.routeKeyOf()`
correctly distinguished `null` from `'direct'`. Under the private copy, a routed
node whose `lwr` blinked scored **two** route changes — one when the data
vanished, one when it returned — for a mesh that had re-routed nothing.
`route-churn` fires at four in ten minutes, so two driver hiccups could have lit
up every routed node at once with an entirely fabricated symptom.

The two definitions are now one exported function. `routeKeyOfLwr` returns
`null` for absent statistics, `'direct'` for an empty chain, `'r<a>-<b>'`
otherwise; `isRouteChange` requires both endpoints known and different. A route
that cannot be seen has not moved — `'direct'` is a fact about the mesh, `null`
is a fact about our knowledge of it. This is the discipline `dS2Resync` already
carried, where a dark log lane records `null` rather than a fabricated `0`.

**`route-churn` recoveries are now measured instead of written off.**

The symptom mapped to the `none` recovery metric — permanently `unverifiable` —
justified in a comment as *"multi-node or mesh-scoped"*. That justification was
false for it: `route-churn` is emitted per node, with a `nodeId`, off a per-node
event accumulator, structurally identical to `s2-desync`, which was always
scored. Its remedies being physical is no reason to refuse to measure them;
`weak-signal` and `s2-desync` are physical too.

It now scores on the `route` metric — re-routes subsiding — gated on
`routeKnown`, the count of samples where a route was actually on record. That
gate exists because the route-key fix creates the hole it closes: a node whose
`lwr` goes dark now correctly scores ZERO changes, and without the gate that
clean run of zeros would read as a cure with no evidence behind it. The
after-window additionally requires the node to still be alive, since a node that
stopped talking cannot re-route and has not settled anything.

Six mutants pin this release, all killing: the route-key conflation, the
both-endpoints-known guard, the metric mapping, the visibility floor, and the
two pre-existing detector guards. 640 tests.

**What was measured, and what it does not show.** Polling every node's
last-working-route on the reference mesh — 14 samples over 7.8 minutes, 494
node-transitions — found **zero** re-routes and **zero** visibility blinks. The
mesh is quiet. That does NOT downgrade the defect: an `lwr` blink is least
likely in steady state and most likely at a driver restart or a re-interview,
which is precisely the moment it would hit many nodes at once and manufacture
the mass false positive. A steady-state window cannot sample the failure mode.
It also cannot settle whether four-in-ten-minutes is the right threshold; that
needs the engine's own long-horizon evidence, which now records it correctly.

Documentation: §7.2.3 listed `route-churn` as **declared, not built** two minor
versions after it was built; the recovery-metric table omitted `s2` entirely.
Both corrected, and §7.2.4 gains the detector's firing conditions and the route
identity contract.

## 0.31.2 — 2026-08-04

**Auto-ping was working the whole time. Its evidence was in the wrong place.**

v0.31.1 shipped a decision trace on the belief that auto-ping was a no-op. It was
not. It had been probing correctly since it was enabled:

    34 of 36 ping buttons pressed, at exactly one-minute intervals, all at :19s
    — the one-per-tick rate limit and tick offset, behaving as designed

And it worked. Ten nodes that had been silent for 35.7 HOURS were probed and
ANSWERED; their driver `lastSeen` now carries the probe timestamps
(n17 20:24:19, n24 20:25:19, n23 20:26:19, n49 20:28:19 — consecutive minutes).
The operator's original premise — that a quiet node comes back when pinged — is
confirmed by data.

The defect was observability, and it is real. `logAction()` writes ONLY to the
in-memory event ring behind the login gate (the TUI Log screen); it never touches
stdout. Auto-ping logged exclusively there, so every probe it fired was invisible
to anyone reading the add-on log — which is where an operator looks, and where
the diagnosis looked. The feature was declared broken because its evidence sat
somewhere the investigation never went.

Every autonomous action and every decision trace now goes to BOTH: the event ring
for the Log screen, and the server log for `ha addons logs`. A mutant pins it,
because ring-only logging is precisely the state that produced a confident wrong
conclusion.

Three separate measurement errors this session reached the same shape — a query
truncated by recorder retention read as "no dead episodes", a counter comparison
over an idle mesh read as "inconclusive", and a log grep in the wrong stream read
as "zero probes". In each case the system was fine and the instrument was wrong.

## 0.31.1 — 2026-08-04

**The auto-ping runner now says why it did nothing.**

v0.31.0 shipped enabled, healthy, and doing nothing — and there was no way to
tell that from the outside. The runner spoke only when it ACTED, so "there was
nothing to do" and "this is broken" produced byte-identical logs: an empty one.
Diagnosing it meant reading the source and guessing, and two of those guesses
were wrong.

Found by using it. With `auto_ping_enabled: true` on a live 39-node mesh, zero
probes fired. Forcing `auto_ping_stale_min` down to 2 and leaving it ~11 minutes
still produced zero — while the driver reported node 32 silent for 15.5 HOURS.
The boot log confirmed the runner had started (its config line prints from inside
the start branch), driver-ws was live with a 39-node state dump, statistics were
subscribed, and there were no errors on either boot. Everything observable said
healthy; nothing observable said what the runner was deciding.

Each tick now emits its decision and its inputs:

    auto-ping: candidates=36 dead=0 stale-due=12 stalest=931m -> probing 1
    auto-ping: candidates=36 dead=0 stale-due=0 -> suppressed: boot-window

Emitted on CHANGE, so a transition is never missed, plus a 30-minute heartbeat so
a steady state stays visible — at info level, because an operator should not have
to raise log_level to find out whether an autonomous feature is alive. Every tick
also goes to `log.debug` for real debugging.

The underlying cause of the no-op is NOT fixed here, deliberately. The earlier
hypothesis (that `mergedStats` masks staleness by taking the max of a
counter-derived stamp and the driver's own lastSeen) is weakened by the 2-minute
result: if staleness were merely being masked, a 2-minute window should still
have caught nearly every node. Instrument first, then fix what the instrument
shows — shipping a fix now would risk "fixing" the wrong thing and calling it
verified.

## 0.31.0 — 2026-08-03

**A node nobody talks to was never proven alive.**

Z-Wave JS sets `Dead` REACTIVELY — only when a transmission to a node FAILS. It
is not a timeout. A device nobody addresses produces no transmissions, therefore
no failures, therefore reports Alive indefinitely: a mains outlet could be
physically unplugged and still read "Alive" until something happened to reach it.
v0.30.0's auto-ping only helps AFTER a node has been proven dead that way, so for
a device nobody uses the trigger may simply never arrive.

Measured on the live 39-node mesh, and this is what prompted the feature:

    10 of 38 nodes silent for 35.7 HOURS — every one reporting Alive
    (n17 n23 n24 n30 n31 n40 n44 n45 n49 n50, all mains, all status=4)

Their `lastSeen` values cluster within TWO SECONDS of each other at
2026-08-02T15:37 — a batch event (the last controller restart), after which none
of them was ever heard from again.

`auto_ping_stale_min` (default 240) closes it. Each mains node is probed that
long after ITS OWN last contact, so the cadence is self-balancing: a device that
reports on its own keeps resetting its clock and is never probed, while a silent
one is checked every four hours. Silence becomes evidence — the node either
answers (refreshing lastSeen, and its route/RSSI statistics with it) or the send
fails and the driver marks it Dead, at which point v0.30.0's remediation path
takes over with its own dwell, backoff and attempt cap.

Guards, each tested and mutation-covered:

  • ONE probe per tick, stalest first — 36 mains nodes coming due together would
    otherwise fire 36 sends in a single second; ordering stops any node starving
  • one probe per node per window: an unreachable node never refreshes lastSeen,
    so without this it stays permanently "due" and would be re-probed on EVERY
    tick, forever
  • a node with no lastSeen at all is treated as maximally stale — never having
    been heard from is the strongest reason to ask
  • Dead nodes are skipped: they belong to the remediation path, and probing them
    here would bypass its dwell, backoff and cap
  • mains only, and the same storm / boot-window / rebuild / write-actions gates
  • `auto_ping_stale_min: 0` disables it outright

## 0.30.0 — 2026-08-03

**The engine acts for the first time — narrowly, and off by default.**

Everything this engine did until now was advisory: detect, explain, recommend,
and a human presses the key. `auto_ping_enabled` breaks that rule on purpose and
in exactly one place, so the rule stays meaningful everywhere else.

Ping is the right and only candidate: it is already the one action the TUI runs
WITHOUT a typed CONFIRM, because it is idempotent and has nothing to undo. A ping
to a live node is a no-op; to a dead one it is a probe. Nothing here can remove a
node, rewrite a route, or change a device's configuration.

**The 10-minute dwell is measured, not guessed.** Six dead episodes on the live
mesh across three days:

    West Closet Motion      0.8 min  -> self-recovered
    Hallway Closet Motion   1.5 min  -> self-recovered
    Dining Room Lamp        5.0 min  -> self-recovered
    Garage Workroom         5.1 min  -> self-recovered
    Garage Workroom       361.4 min  -> cleared by hand
    Hallway Closet Motion 531.4 min  -> cleared by hand

The distribution has a clean gap: self-healing finishes inside ~5 minutes, while
a stuck node runs SIX TO NINE HOURS. A 10-minute dwell sits in that gap — long
enough never to interrupt the mesh healing itself, short enough to turn a
six-hour outage into a ten-minute one. All four affected nodes are mains-powered
and expose a working ping button, so all four would have been eligible.

That evidence was nearly missed. A 14-day history query returned almost nothing
and was reported as "this mesh never fails" — but the recorder silently DEGRADES
a query whose start predates retention, returning one synthesized row per entity
instead of an error. The tell is cheap: a SHORTER window returning MORE rows
means the longer one is lying (3 days = 534 rows; 7 days = 153).

Whether a ping actually clears those long outages remains unproven, so the
feature instruments itself: every attempt lands in the M5 ledger against the
node's open episode, and `efficacyFor('dead-flap', 'ping')` turns "usually wakes
them up" into a measured recovery rate on REMEDY. If that rate comes back poor,
the honest answer is to switch this off, and the data will say so.

Gates, every one of them tested and mutation-covered:

  • `auto_ping_enabled` — OFF by default
  • obeys `write_actions_enabled` even when its own switch is on: auto-ping is a
    write, and a read-only add-on that pings would be lying
  • MAINS-POWERED nodes only. ASLEEP IS NOT DEAD — battery and FLiRS devices
    sleep by design and answer on their own wakeup; a ping cannot reach one
    before then and spends charge to fail. `isListening === null` means "not
    interviewed", which is not a licence to probe on an assumption
  • 10-minute dwell, then 10/30/60-minute backoff, capped at 3 per outage
  • STORM GUARD: a quarter of the mesh Dead at once is a controller wedge or a
    driver restart, not per-device failure — probing 20 nodes into a struggling
    controller only adds traffic. Absolute floor of 4, so 1-of-4 on a small mesh
    is not a "storm"
  • suppressed in the restart window and while routes are rebuilding
  • recovery clears the attempt budget, so a device that fails again next month
    is helped again rather than inheriting an exhausted one

**Also: `route-churn` finally has a detector.** The SymptomKind, its planner card
and its outcomes handling have existed since the planner was written, but nothing
ever emitted it — `grep "kind: 'route-churn'"` returned 0 — so REMEDY could never
surface route churn and the card was unreachable. The evidence was being
collected the whole time: `dRouteChanges` is an event-accumulator drain on every
sample, exactly like `dFlaps`. Fires at ≥4 LWR changes in 10m with the same dwell
and recency conjunct dead-flap uses, and never for Long-Range nodes — they hold
one direct link with no routes to churn, which the planner card already says.

### What the harness caught (all self-inflicted)

An off-by-one against this file's own docstring: `BACKOFF_MS[tries]` made the
first gap 30 minutes while the ladder documented 10/30/60.

The sleeping-node guard — the most safety-critical one — was **unprotected**, and
it took three rounds to make it testable. The check lived in an `isEligible()`
helper, in the decision filter, AND in `trackEpisodes`; each was individually
sufficient, so removing any one changed nothing observable and no test could pin
it. Duplicated safety checks are not defence in depth: they are three places to
believe a rule is enforced while none of them provably is. Collapsed to one
`isPingCandidate` predicate used by both call sites.

And the first runner test asserted that nothing was pinged after stopping the
handle before its timer could fire — true, and proof of nothing. The runner now
exposes `tick()` so a test drives it deterministically.

## 0.29.5 — 2026-08-03

**Security: `fast-uri` host confusion (2x HIGH, GHSA-7p8r-x3mc-p8w7).**

Dependabot raised two high-severity alerts against `fast-uri`, reachable twice
in the tree: `fastify → @fastify/ajv-compiler → ajv → fast-uri@3.1.4` and
`fastify → fast-json-stringify → fast-uri@4.1.1`. The flaw is host confusion via
a **backslash authority introducer** — a URL parser can be talked into reading a
different host than a reader expects.

That is the same class of bug fixed by hand in v0.29.3, where the ingress
redirect had to start rejecting `\` and `//` prefixes precisely so a header
could not redirect a browser to another origin. Worth noting the app's own guard
was written before the library one surfaced: the validation there does not defer
to `fast-uri` for the security decision.

Patched to 3.1.5 / 4.1.2 via the lockfile only. Fastify itself stays at 5.10.0 —
no runtime or API change — and `npm audit --omit=dev` now reports 0
vulnerabilities.

## 0.29.4 — 2026-08-03

**Home Assistant now pulls a prebuilt image instead of building on your Pi.**

`publish-release.yml` has published multi-arch GHCR images since v0.29.2, but
`config.yaml` deliberately carried no `image:` key while they were still private.
Both packages are public now and were verified anonymously pullable before this
key was added, so Supervisor pulls `ghcr.io/tesseractaz/{arch}-zwave-tui` and an
update takes seconds rather than minutes of on-device npm build.

The ORDER matters and is recorded in config.yaml so a future change keeps it.
The failure is asymmetric: publishing images nobody consumes is harmless, while
declaring `image:` against a package that is missing or private makes Supervisor
pull a tag it cannot fetch and EVERY install and update fails. So: publish, make
public, prove the pull, then point at it.

Verifying that pull took three wrong attempts, all mine, and each one looked
like a broken package:

  • a bare manifest GET returns 401 even for a PUBLIC image — the Registry v2
    flow answers with WWW-Authenticate and expects you to fetch a token. What
    distinguishes public from private is whether an ANONYMOUS token is granted.
  • with a token it returned 404, because the Accept header omitted
    `application/vnd.oci.image.manifest.v1+json`. buildx with provenance:false
    pushes a plain image manifest, not an index, and the registry 404s when it
    cannot satisfy the offered types.
  • the contract test then failed for a fourth reason: its regex matched the
    owner segment with `[^\s:]*`, but `${{ steps.owner.outputs.name }}` contains
    SPACES, so it matched nothing and would have passed vacuously in exactly the
    direction that matters. GitHub expressions are now collapsed before matching,
    and the guard is re-verified against a planted mismatch.

## 0.29.3 — 2026-08-03

**The Home Assistant sidebar panel showed a bare "404: Not Found".**

Everything about it pointed away from the real cause. The panel was registered
correctly — `get_panels` showed `local_zwave_tui` with the same shape as the
working Power panel — and the add-on served every route it should
(`/` → 302, `/console` → 200, `/api/health` → 200). The address bar stayed on
`/local_zwave_tui` throughout, so it read as a broken panel registration.

It was the redirect target. Home Assistant loads an ingress panel at
`/api/hassio_ingress/<token>/`, and the landing route replied
`Location: /console` — an ABSOLUTE path. The browser discards the ingress prefix
and asks Home Assistant itself for `/console`, which HA does not serve. Hence a
404 rendered inside an otherwise-healthy HA, from a redirect that had thrown its
own path away.

The rest of the console page was already ingress-safe — relative asset URLs
(`./console/xterm.js`) and a WebSocket URL derived from `location.pathname`.
This one line was not, and nothing covered it.

The fix reads `X-Ingress-Path` and prefixes the redirect. It lives in
`auth.ts` as `ingressRedirectTarget()` rather than inline at the route, so the
test and the mutant target the SAME code: the first version of the test
re-implemented the rule in the test file, which proves only that the rule is
self-consistent and would have let the mutant survive.

**That header is attacker-controllable, and the first cut of this fix handled it
badly in three ways.** CodeQL's gate caught one — `js/polynomial-redos`,
security-severity 7.5: trailing slashes were trimmed with `/\/+$/`, which
backtracks quadratically on a long run of `/` supplied by the caller. Reviewing
it turned up a worse one the scan did NOT flag: `//evil.com` is a
protocol-relative URL, so `Location: //evil.com/console` would have sent the
browser to another origin — an open redirect, introduced by the fix. A clean
scan is not the same as a safe input path.

The header is now validated rather than sanitised: rooted single slash only
(a second one disqualifies it), no CR/LF/backslash, a 256-character cap, and a
linear `charCodeAt` trim instead of a regex. Anything that does not look like an
ingress path falls back to `/console` — a redirect is not worth guessing at.

Direct (non-ingress) access on :8788 carries no header and still lands on
`/console`.

## 0.29.2 — 2026-08-02

**Release automation, container images, and a crash on shutdown.**

The release pipeline had a missing link, and it was not theoretical: v0.29.0 and
v0.29.1 both merged to main and sat UNTAGGED and unreleased, because
`publish-release.yml` only fires on a pushed tag and nothing pushed one. Tagging
was a manual step that looked automatic. `tag-release.yml` now closes it —
a "Release v…" commit touching config.yaml creates the tag and starts the
release. It dispatches explicitly rather than relying on the tag push, because a
tag pushed with GITHUB_TOKEN does not trigger other workflows; miss that and you
get a tag with no release, which is a silent half-failure. `release.yml` adds the
one-click bump (both version files — the suite pins them together).

`publish-release.yml` now also builds and pushes **multi-arch GHCR images**
(amd64 + aarch64 on native runners), reading BUILD_FROM from build.yaml rather
than a hardcoded matrix so an image can't be built on a different base than a
source install gets. The `.docx`/`.pdf` manual was already attached to every
Release and still is. `image:` is deliberately NOT set in config.yaml yet — see
the note there for why the order matters.

**A crash on shutdown, found by CI failing the v0.29.0 release.** `stop()` called
`removeAllListeners()` and then `close()`; on a socket still CONNECTING, ws emits
'error', and an 'error' event with no listener is re-thrown by EventEmitter as an
uncaught exception on a later tick — outside the try that wrapped the close. So
shutting down while a reconnect was mid-handshake killed the process, which is
exactly the flapping-Core churn this client exists to survive.

Also: seven contract tests now pin the release relay itself — the watched path,
the "Release v" subject shared by two workflows, that the dispatched workflow
exists and takes a version, that both version files move together, that
config.yaml and the publisher agree on the image name, that every workflow
parses, and that no action is on a floating tag. Every one of those joins is a
string match against another file, and none of them was checked before.


**A driver `0` was being drawn as the strongest link on the mesh.**

Found the moment the TUI became reachable for testing. Live on the 39-node
network, node 30 reported `repeaterRSSI [0, 0]` — and Topology rendered it as
`n3(+100)→n5(+100)`, a +100 dB margin on a row whose genuine hops read +14 to
+32. Every real reading on the mesh sits between -68 and -86 dBm; there is
nothing between -67 and -1.

`0` is the driver's other "no reading" placeholder, and it is not in the
documented set (127 not-available / 126 receiver-saturated / 125 no-signal). So
every call site that ENUMERATED those markers let it through, and a positive
value passed to a margin calculation ranks as the best link on the network —
the exact defect the sentinel guard exists to prevent, one value short.

The guard was also duplicated in **seven files**, and only `dataProvider.ts`
had it right: it alone tested `v < 0`. The domain rule had already been
discovered once and never propagated, so the same question — "is this a
reading?" — had two different answers in one codebase. `health.ts` even
documented the correct intent (*"a finite RSSI in real dBm range"*) while
checking only the marker list.

There is now ONE definition, `rssiReading()`, and it tests the DOMAIN RULE
rather than a list: a reading is a finite negative number. A marker list can
only ever be as current as the last driver release; the physics cannot go
stale. Every screen, sort key, history filter and statistic routes through it,
and the six duplicate definitions are deleted.

Beyond Topology, this also fixed: the Overview signal cell, the Heatmap margin,
Detail's per-hop chain and both history sparklines, the health score's RSSI
gate, and the `sort by signal` key — where a `0` sorted as the single strongest
node on the mesh, i.e. the opposite end of the list from where an unknown
belongs.

## 0.29.1 — 2026-08-02

**The startup log told the truth about the telnet listener's auth posture.**

Found while live-verifying 0.29.0: the boot line read

    telnet TUI on :::2324 (no auth — trusted LAN only)

on a deployment where the login gate is ON, required on ingress, with write
actions enabled — and the very next thing that happened was the telnet session
presenting a login prompt. The suffix was a hardcoded string printed on every
boot regardless of the policy handed to the listener two lines earlier, so it
was a false statement about a security control in the one place an operator
goes to check that control. (It was equally uninformative when auth was off:
right by accident, not by derivation.)

Nothing covered it because a log line assembled inline during boot is not
reachable from a unit test. The description is now `describeTelnetAuth()` — a
pure function beside the policy it describes — with a test and a mutant.

## 0.29.0 — 2026-08-02

**Topology draws the per-hop readings it already held, and stops publishing a
number it could not honestly compute.**

The screen's empty space was measured before anything was drawn into it, and the
measurement changed the plan. Topology saturates at 55 rows — beyond that, added
height yields only blank rows — which reads like a vertical problem. It is not
the dominant one. `lr(left, right, cols)` pins a short left block and a short
right block to opposite edges, so at 200 columns every node row carried a
~152-column gutter and ink sat at 30% even at a height where ZERO rows were
blank. Counted another way, the seven full-width rules were drawing more
characters than the data between them.

So the fix is horizontal. `RouteStat.repeaterRSSI[]` — the strength measured AT
each repeater — was already collected, already rendered by Detail, and never
read by the screen whose entire subject is routes. Topology read only
`lwr.rssi`, which is the LAST hop's reading, which is exactly why `nodeLine`
greys it on a routed node: it describes the repeater's link, not the device's.
The per-hop array is the quantity that comment says is missing.

Also new: **observed route churn** (`↻N` per row, `N REROUTES/<span>` in the
header) from the `kind:'route'` events the data layer already emitted; a
**surplus-funded repeater panel** that no longer hides repeaters behind a flat
cap of five; a **name budget** that stops silently shortening long names at 200
columns; and a **REBUILDING** marker, because a route tree drawn while the
controller is rewriting routes is provisional and never said so.

Every addition is surplus-funded: **80×24 is byte-identical to 0.28.0.**

| frame  | 0.28.0 | 0.29.0 |
|--------|--------|--------|
| 80×24  | 991    | **991** (byte-identical) |
| 120×40 | 1830   | **1967** |
| 200×60 | 3269   | **3551** |

### Honesty rules this release had to get right

**Detail's idiom is not portable.** Detail has no unit toggle; this screen does,
and its own rule is that every number on a row shares one unit and one band. A
raw `-93` beside a `+11dB est` cell is two units on one row, so the per-hop
readings follow `signalDisplay`.

**The chain sizes itself.** It cannot be left to `lr()`, which truncates the
LEFT — where the chain lives — and returned `⚠n153↮n1`: half a failed pair,
naming one node and implying another. Each degradation step drops a whole token.

**A count is never shown without its window.** The event ring is bounded and
session-scoped, so an unqualified "0 reroutes" would read as "this mesh is
stable" when it may only mean "this add-on started four minutes ago". Count and
span share one width gate, and the count is never divided into a rate, because
the denominator would just be time-since-boot.

**Sentinels are positive.** 127/126/125 mean "no reading"; treated as levels
they rank as the strongest link on the mesh. They never render as a value and
never enter a statistic.

### What review removed

A first cut published a per-repeater failure rate from
`Σ timeoutResponse / Σ commandsTX` over the repeater's dependents. It is not a
per-link quantity: those are per-node LIFETIME totals covering every route the
node has ever used, so a node routed through two repeaters charged all of its
failures to BOTH, and a repeater that joined a route a minute ago inherited
everything from before it was involved — the same history the `↻` token on that
row attributes elsewhere. The driver exposes no per-link counter, so the rate is
gone rather than approximated. The aggregate now reports `worst -84 n5/8`, with
the sample size beside the population so the claim carries its own weight.

Review also caught the degradation ladder running backwards: chains were tried
outermost and markers innermost, so the first fit was "widest chain, weakest
marker" and a fully annotated chain rendered beside a bare `⚠` while the columns
needed to name the failed pair sat free. Which link failed outranks what the
healthy hops measured.

## 0.28.0 — 2026-08-02

**Two screens now draw data they had already collected.**

The Interference screen holds a 200-bucket six-day noise-floor history and a
24-hour diurnal timeout profile. Both are measured, both are persisted across
restarts, and both were drawn as a single sparkline row — a resolution that
cannot answer the question they are collected for. The Controller screen read
only `controller()`, `nodes()` and `scoreFor()`, leaving the per-hour serial
rates and the engine's mesh-scoped symptoms untouched.

Where rows are genuinely spare, those series are now drawn properly:

| screen | 80x24 | 120x40 | 200x60 |
|---|---|---|---|
| interference | 699c (unchanged) | 762 → **1266c** | 842 → **1693c** |
| controller | 944c (unchanged) | 1414 → **1768c** | 1814 → **2328c** |

*(non-space characters actually drawn, identical fixture)*

`chartRows` in `gauges.ts` renders a series as N rows of block glyphs at
sub-cell resolution. It scales over what is **drawn** — the rule `sparkline`
already followed, so an extreme that has scrolled off cannot flatten the visible
trend — and gives any present reading at least one eighth, so a real sample
never renders as blank space.

The noise chart keeps the fixed −110…−80 scale it shares with the fine trend so
the two stay comparable, and widens to represent more of the retained series
rather than only its newest 24 buckets. The diurnal chart sits above the
existing heat strip on the same 24-hour axis: the strip answers *which* hour is
hot, the chart answers *by how much*. On the Controller, **RECENT RATES** gives
the per-hour view its lifetime counters cannot ("63 reply timeouts" says nothing
about whether the link is failing now), and **ACTIVE MESH EVENTS** surfaces
network-scoped symptoms that a per-node screen structurally cannot show.

**What was tried and rejected.** Laying these screens out in side-by-side
columns was implemented, measured, and reverted. Fixing its truncation bug was
not enough — ink still fell (controller 1814c → 1194c), because these blocks are
gauges, bar rows and field strips *designed* to use width, so narrowing them
costs information whether it is cut or legitimately shrunk. Detail's entity and
parameter lists were the right case for columns in 0.27; these are not. Their
sparseness is vertical, and the answer is more data, not rearranged data.

That ink count is the standing check for this class of change: layout alone
cannot alter it, so a drop means characters were destroyed and a rise means
information was added.

Every addition is surplus-funded and absent below its threshold, so an 80x24
terminal renders byte-identically to 0.27.0.

554 tests, up from 551.

## 0.27.0 — 2026-08-02

**The Configuration page is grouped — without renaming a single option.**

Home Assistant does render nested `schema:` objects as collapsible panels, so
grouping the fourteen options into `display:` / `access:` / `auth:` blocks looked
like the obvious answer. It is unsafe, and the reason is worth stating plainly
because the tidy version is the dangerous one.

An add-on has **no options-migration hook**, so nesting a key is a **rename** —
and no merge strategy saves it, deep or shallow. The operator's value sits at the
old path, which the new schema no longer declares; the new path has never been
written, so it resolves to its default; and the orphaned old key is discarded as
unknown. Checked against a real deployment carrying
`auth_enabled: true`, `auth_require_on_ingress: true` and
`write_actions_enabled: true`, that regrouping would have returned the login gate
to its `false` default while write actions stayed on — an unauthenticated LAN
telnet listener offering lock/unlock and remove-failed-node — and done it
invisibly, since `users` keeps its key so the form still shows populated rows and
the "auth enabled but no users" warning never fires.

Shadow-key migration is worse, not better: `bashio::config.exists` cannot
distinguish a value cleared to `""` from an absent one, and `users` is a
structured list that cannot be shadowed at all, so a restrictive merge locks the
operator out of telnet, the direct port and the sidebar simultaneously.

Structure therefore lives in the **label prefix** — `Display · `, `Access · `,
`Login gate · `, `Advanced · ` — which groups every field visibly with zero
migration risk. The reasoning is recorded in `translations/en.yaml` so a later
release does not rediscover the hazard the hard way.

**The screens now use the frames they are given.**

Measured against a populated 39-node mesh, ink as a fraction of the frame with
fully blank rows counted separately:

| screen | 80x24 | 200x60 before | 200x60 after |
|---|---|---|---|
| Overview | unchanged | 27%, 16 blank | **25%, 0 blank** |
| Heatmap | 16% → **38%** | 4%, 54 blank | **10%, 9 blank** |

* **Overview** — the roster drew every node and then padded the remainder with
  empty strings. A mesh roll-up (status counts, grade distribution, worst-node
  queue) now claims those rows, funded *strictly by surplus*: it is drawn only
  when every node already has a row and rows remain, so it can never push the
  roster into scrolling. The NODE column's cap rose 40 → 64, since the fixed
  columns and separators total 107 and the old cap froze content at 147, leaving
  53 dead columns on every row at 200 wide. 160 columns is now fully used.
* **Heatmap** — structurally one row per *area*, so 38 devices collapsed into
  about eight rows however tall the terminal. Surplus rows now name the devices
  behind each area's grade, weakest first, from readings `groupByArea` already
  computed and discarded.
* **Detail** — its entity and parameter lists are short rows that were drawn one
  per line, wasting width and pushing the rest of the dossier out of the scroll
  window. On a 10-entity, 18-parameter node they fall from 28 rows to 10.

New shared primitives `hstack` and `splitCols` back the column work. `hstack`
guarantees output height equals the tallest column, every row is exactly
Σw + gaps visible columns, and each cell is truncated to its own width before
being padded back — so a long line can never displace its neighbour, and an
ANSI-aware pad keeps a cut cell from leaking colour across a boundary.
`splitCols` returns nothing rather than dividing a frame below a usable pane
width, because density bought by truncating values is not density.

**Nothing here pads.** Blank rows that remain are honest: when every device is
already on screen, or every node grades A and the worst-node list is genuinely
empty, the frame is not filled to hide it. Two proposed additions were dropped
on review — an RF-headroom distribution would have bucketed nodes by a last-hop
ACK reading the Overview already refuses to health-colour, and an extra
command-bar token would have changed what the command bar *drops* at 80 and 120
columns, costing information on small terminals to decorate large ones.

547 tests, up from 542.

## 0.26.1 — 2026-08-01

### Screenshot generator: attribute-safe escaping

The SVG screenshot generator's escape helper handled the markup
metacharacters (`&`, `<`, `>`) but not quotes, while its output is
interpolated into double-quoted attributes (`aria-label`, `<title>`); an
unescaped `"` would terminate the attribute (CodeQL
`js/incomplete-html-attribute-sanitization`). The helper now escapes `"` and
`'` as well. Build-time tooling only — no runtime change.

## 0.26.0 — 2026-08-01

### The S2 SPAN-resync watch — a fault class the counters cannot see

Z-Wave S2 keeps a rolling nonce (the SPAN) in step between controller and
device. When a frame is lost the two sides disagree and the protocol recovers by
resynchronising. An occasional resync is normal. A **storm** of them means the
link is losing frames faster than the recovery absorbs — and it is invisible to
every statistic the add-on has ever collected: the command eventually succeeds,
so `commandsTX` increments, no reply times out, and `commandsDroppedTX` stays
near-silent as always. A secure node can burn airtime on retries while every
screen reads healthy.

It surfaces only in the driver's log stream. So the read-only driver-WS client
now also subscribes to it (`start_listening_logs`, added to the frozen
allowlist — a subscription, not a mutation), matches the node-attributed S2
desync lines, and drains them into the evidence store through the same
event-accumulator discipline as Alive↔Dead flaps. The new `s2-desync` detector
fires on 12+ resyncs in 30 minutes, and its remedy card is blunt about
direction: this is an **RF** fault surfaced through the security layer, so
re-interviewing is offered only as a blocked candidate — it re-reads
capabilities over the same bad link, does not re-key the device or repair SPAN
sync, and on a marginal link often leaves the node half-interviewed.

Three properties of zwave-js-server made naïve log listening unsafe, all
verified in its source and defended against here: the log forwarder is **global
and shared** (the first subscriber's filter wins, and any log-level change drops
the filter entirely — so filtering is done client-side and no filter is
requested); there is **no throttling of any kind**, one message per log line per
client, which at `debug` level is every serial frame (a storm guard stops the
stream above 3000 events/min and continues without the lane); and the stream
follows the **driver's current log level**, which this add-on does not control.

**Coverage is honestly partial.** At the stock `info` level node-zwave-js emits
only the *outgoing* desync pair. The incoming family is `verbose`, so on a
default install this detector sees roughly half the S2 picture. It under-reports
rather than over-reports, and both DOCS §6.11 and §7.2.4 say so.

### Assessment fix wave

A 27-agent adversarial assessment of v0.25.1 against the live 39-node mesh
confirmed 19 findings. The measurement core came through clean — disjoint
counter denominators, RSSI sentinel discipline, last-hop RSSI on routed nodes,
unit-correct RTT, one timeout-% definition, and the exact-rows render contract
all held under attack. What follows is what did not.

**Dwell was not persistence.** Windowed detectors combined a 10–30 minute
lookback with a 5-minute dwell, and because the lookback is longer, one
transient burst kept the breach asserted for the whole lookback — maturing a
"persistent" symptom off evidence that had already stopped. The dwell was armed
by the calendar, not the mesh. Burst-prone detectors now conjoin their windowed
threshold with evidence inside the dwell horizon, so a storm that ends
de-asserts.

**Reconnects fabricated freshness.** `lastSeen` was stamped at event arrival,
and every re-subscribe replays each node's snapshot — so a reconnect reset all
39 nodes to "seen 0s ago" with no RF traffic at all, precisely when an operator
is looking. The evidence path always had the replay rule; the display path now
gets it. A first delivery, which cannot be told from a replay, no longer stamps
anything.

**A superseded subscribe left a zombie feed.** A subscription run parked inside
`state_changed` when the socket died would wake on the *new* connection and land
a duplicate feed beside the live one, double-delivering every activity row and
costing HA a fanout per state change in the whole house until the next
disconnect. Runs are now epoch-pinned and release themselves.

**A flapping Core was rejoined at ~1 s forever.** The backoff reset on
`auth_ok`, which a Core that authenticates then dies satisfies on every cycle.
The reset now requires the connection to survive.

**Battery and firmware were frozen on a stable connection.** Both were fetched
only on (re)subscribe, so on a long-lived healthy connection battery drain past
25% and newly-available firmware updates never reached the roster, the low-
battery gate, or the advisory engine. They now refresh on their own cadence.

**A never-measured node claimed to be fine.** The documented "no statistics ⇒
unknown, ≤15" gate was unreachable — the data layer always substitutes a zeroed
stats object — so a node with no measurements scored **84/B "ok"** and reported
"RF health nominal". The gate now tests the never-measured fingerprint. A cached
RSSI still counts as contact.

**"✓ helped 75% (n=4)" had no sampling-error control.** Near a coin flip at the
minimum sample size. The claim is now gated on the Wilson score lower bound:
*even pessimistically, this beats leaving it alone.*

**Steady-state `/data` writes cut ~3×, against a failing SD card.**
`history.json` was rewritten every 30 seconds with **no dirty gate at all** — a
full-file rewrite whether or not a sample had been added. It now has one, and
its cadence moved to 120 s. `evidence.json` already had a dirty gate (that gate
is *not* new — an earlier draft of this entry said it was, which was wrong); its
cadence moved from 5 to 15 minutes. Both gates are, in honesty, near no-ops in
live steady state: a mesh recording a sample every ~10 s is dirty at almost
every flush, so the real saving is the cadence, and the measured reduction is
about **3×**, not the order of magnitude first claimed. The remaining cost is
dominated by the 14-day coarse tier, which is still rewritten in full on every
flush; compacting that is future work.

`outcomes.json` was found to have **no dirty gate** while its own documentation
claimed one — 288 unconditional full rewrites/day. It now has the same gate as
`baselines.json` and `evidence.json`.

**Render honesty.** The Detail ROUTES row blind-truncated, clipping a 100k rate
to `1` and a −70 dBm route RSSI to `-7` at the documented 80-column default —
plausible, wrong numbers on exactly the rows studied for multi-hop nodes. It now
sheds whole tokens with a disclosed `+N`. The `Sig 2h` trend drew only its
newest ~56 minutes while the label and caption claimed two hours. A dead node's
trend sparklines rendered health-green on Detail while the Overview greyed the
same cell. The Overview's margin bar anchor had drifted from the shared
weak-margin threshold, and the noise floor printed unrounded where every other
surface rounds.

**Two East-Asian-Wide blocks could overflow a row.** The width-fold class missed
Hangul Jamo Extended-A and Vertical Forms. Fixing it exposed that the two call
sites had silently diverged: one range began at U+F900, the other at U+8C48 — a
**homoglyph** that renders identically, so thousands of narrow code points were
being folded to `?` in log text. Both now share one constant written with `\u`
escapes, because that is a divergence review can see.

### Verification

534 tests (up from 521). Two files that had never existed: `haWsClient.test.ts`
— the Core WebSocket client had **no test file at all**, leaving the exact
reconnect path today's zwave-js update exercised entirely unproven — and
`zwaveDataChurn.test.ts`, which drives the replay, epoch and dirty-gate
behaviours through a real reconnect. The controller-statistics mapper, including
its `timout_response` misspelling fallback, was extracted and pinned; it had
zero tests through five releases.

The mutation harness gained **14 entries covering the statistics and learning
engine**, which previously had none — so the standing "83/83 clean" attested the
render layer only. Every new fix is now reverted-and-caught, including the
recency conjunct, the Wilson gate, the replay guard, the zombie-feed release and
the dirty gate.

## 0.25.1 — 2026-07-28

**Dependency and CI maintenance.** No behaviour change to the add-on.

Adding Dependabot in v0.25.0 immediately produced eight pull requests and
exposed two things worth recording:

* `github/codeql-action/{init,autobuild,analyze}` are **one action whose parts
  must move in lockstep**, but Dependabot sees three dependencies and opened a
  separate PR for each. Every one of them left the trio mismatched and CodeQL
  failed with `CodeQL job status was configuration error` — those PRs were not
  risky-but-reviewable, they were unmergeable individually. A `groups:` rule now
  bumps all three together.
* `@types/node` was offered a 22 → 26 major bump. The container installs Node 22
  and CI runs 22, so types for a newer major would let `tsc` accept APIs that do
  not exist at runtime — a green typecheck proving nothing. Major bumps of that
  package are now ignored; it moves when the runtime does.

**The aarch64 smoke build now runs on a native ARM runner.** v0.25.0 added it
correctly but ran it on an x86 runner, so `apk add` and `npm ci` went through
QEMU user-mode emulation: the first real run passed **35 minutes** and was still
going, blocking every PR behind a required check. `ubuntu-24.04-arm` is free for
public repositories, and the same build now completes in about a minute.

**Runtime dependencies bumped** — `@fastify/cors` 10 → 11, `@fastify/compress`
8 → 9, `ws` 8.21.0 → 8.21.1, `tsx` 4.23.0 → 4.23.1. Both Fastify plugin majors
were checked beyond the green suite, because `index.ts` — where plugins are
registered — has no test coverage, so a passing suite would not notice a plugin
that refuses to load. The full stack (compress + cors + websocket, in the order
`index.ts` uses) was registered against the resolved tree on Fastify 5.10.0 and
a request exercised end-to-end: registration succeeds and the CORS header is
still returned.

**`main` is now a protected branch.** The five CI contexts are required,
force-pushes and deletion are blocked, and admin bypass is deliberately left on
so a solo maintainer can still land an urgent fix. v0.25.0 documented, correctly
at the time, that no protection existed; that note is now corrected.

## 0.25.0 — 2026-07-28

**The add-on could not be installed from the store.** `repository.yaml` and the
README both describe adding this repository in Home Assistant and installing
Z-Wave TUI from the Add-on Store. Home Assistant builds an add-on from **its own
directory**, and `zwave_tui/` held only `config.yaml`, `CHANGELOG.md`, `DOCS.md`,
`apparmor.txt` and `translations/` — no `Dockerfile`, no `build.yaml`, no
`server/`, no `rootfs/`. Those sat at the repository root, where a store install
can never reach them; the root `Dockerfile` even does `COPY server/ ./server/`,
confirming it expected the root as its build context. The add-on worked only via
the *local* `/addons` path, whose deploy step happens to flatten the two trees
together. **`Dockerfile`, `build.yaml`, `server/`, `rootfs/` and `.dockerignore`
now live inside `zwave_tui/`,** so the directory is self-contained and the
documented install path builds. CI's smoke build uses `context: ./zwave_tui` —
exactly what Supervisor does — so this stays true.

**The 30-minute idle timeout added in v0.24.4 never fired.** It used
`socket.setTimeout`, and a code comment asserted that this "fires on READ
inactivity, so the server's own 1 Hz redraw does not keep a dead socket alive."
Node does not behave that way: the socket timer is reset by reads **and writes**,
so the redraw refreshed it forever. The feature was inert from the day it
shipped, and the test that covered it only grepped for the source line — from a
branch that never executed. Reclamation is now an explicit sweep over the last
time each connection **received** data, which a write cannot refresh. Both the
reclaim and the TCP keepalive now have behavioural tests, and both are in the
mutation harness.

**`log_level` was dead config.** Declared in `config.yaml`, given a translation,
exported by the run script as `LOG_LEVEL`, parsed into `config.logLevel` — and
read by nobody. Setting it to `warning` to quiet the add-on did nothing at all,
which is worse than not offering the knob. There is now a real levelled sink
(`logger.ts`): the informational stream is suppressed above its threshold while
warnings and errors still surface.

**`telnet_port` silently killed LAN telnet.** The published `ports:` key is the
**container** port and a hard-coded literal, so the option moved only the
in-container bind. Any value but `2324` left the published mapping pointing at
nothing, with no error anywhere. The option is **removed**; the LAN port is
remapped where Home Assistant already offers it, in the add-on's Network panel.

**A contract test now guards the whole option surface** — option ↔ schema ↔
translation ↔ run-script export ↔ `config.ts` consumer, plus bound-port ↔
published-port and `package.json` ↔ `config.yaml` version. `config.ts`'s header
had asked readers to "keep the two in lock-step" for fourteen releases with
nothing enforcing it; both defects above are exactly what it failed to catch.
Writing it immediately surfaced two more: `ha_ws_url` is a **clearable** (`str?`)
option parsed with `??`, so clearing the field to restore the default yielded
`''` rather than the default; and `DB_PATH` / `config.dbPath` was dead plumbing
maintained in three files and consumed by none. Both fixed.

**Documentation had drifted from the code, including on security.** `DOCS.md`
still documented `panel_admin: false`, the deleted `requireWriteAuth` /
`X-Zwave-Write-Token` gate, and ingress trust as the `172.30.32.0/23` subnet
check — i.e. the reference manual described the exact pre-fix posture that
v0.24.3 and v0.24.4 had corrected. Also fixed: the action-failure message is
sanitized, not "verbatim"; there are nine mutating verbs, not seven; the
driver-WS allowlist is exactly two commands; `parseUsers` requires a non-empty
password; three cross-references pointed at sections that do not exist.
`DESIGN.md` claimed the edge-cluster detector was unbuilt (it shipped in
v0.20.0), listed two detectors that were never implemented without saying so,
advertised an `engine_enabled` option that does not exist, and still called the
repository private. `SECURITY.md` gained the admin-only panel, the pinned
ingress trust, the connection caps and the C1 sanitization. The README's test
count and mutation-harness path were wrong, and `server/package.json` had said
`0.10.0` since v0.10.

**CI now builds `aarch64`.** It smoke-built `amd64` only — while `aarch64` is
the sole architecture actually deployed, so an arch-specific regression would
have reached the Pi unseen. `BUILD_FROM` is read from `build.yaml` instead of
being duplicated in the workflow with nothing checking the two agreed.

**Release-workflow hardening.** `${{ inputs.version }}` was interpolated
directly into a `run:` script in a `contents: write` job — expanded as raw text
*before* bash parses the line, and on the line *above* the regex that was
supposed to validate it, so the validation could not protect anything. Only repo
writers can dispatch the workflow, so this was self-inflicted rather than
remotely exploitable; it now goes through the environment. The workflow also
verifies the pushed tag matches `config.yaml`, fails instead of substituting a
placeholder when a CHANGELOG section is missing, only claims `--latest` when the
version really is the newest, no longer reports success on the skip path, and no
longer calls a public Release "private".

Mutation harness: **83 killed, 0 survived, 0 invalid**, over an entry list that
now includes every behavioural change in this release and the four from v0.24.4
that shipped without one.

## 0.24.4 — 2026-07-27

**Security — the remaining findings from the v0.24.3 posture audit.** No
privilege boundary here was as consequential as the ingress bypass v0.24.3
closed; these are the seven that survived refutation alongside it.

**The sidebar panel was visible to every Home Assistant user.** `panel_admin`
was `false`. The console can remove a failed node, rebuild every route, and —
with write actions on — unlock a lock or open a garage door, while the add-on
treats *"arrived via ingress"* as full operator authority. So the only
authorization the mesh-mutating console received was "HA let this browser
through", and that boolean had lowered the bar to non-admin users. It is now
`true`, matching the official Z-Wave JS add-on (`require_admin: true`).

**A dead write-token gate was persisting a live secret.** `requireWriteAuth`,
`tokenEquals` and `loadOrCreateWriteToken` were registered on **zero** routes
and had no callers — there are no mutating HTTP routes; every action goes
through the TUI behind `write_actions_enabled` plus a typed CONFIRM. The
bootstrap nonetheless wrote a long-lived token to `/data` on every boot, and the
module docstring described the gate as protecting "any mutating HTTP command
route". A control that authorises nothing while persisting a secret is worse
than none: it implies a protection that does not exist. Removed, docstring
corrected. **Existing installs may still have a stale
`/data/zwave-write-token.txt` — it authorises nothing and can be deleted.**

**The frame's control-character backstop did not cover C1.** `CTL_RE` matched
`\x00-\x1f` and DEL but not **U+0080–U+009F** — which is exactly the range that
matters, because **U+009B is an 8-bit CSI and U+009D an 8-bit OSC, and xterm.js
on the `/console` path executes both.** The data-boundary sanitizer already
strips `\x7f-\x9f` and names the 8-bit CSI as its reason; the backstop — the
thing meant to catch whatever the boundary missed — did not, so any string
reaching a frame without passing `sanitizeLabel`/`sanitizeEventText` had no
backstop at all. Both `CTL_RE` and `IS_CTL` now cover C1.

**Error text was the one mesh string never sanitized.** `errMsg` returned
Home Assistant, Z-Wave JS driver, and device error strings verbatim, and they
reach the frame in three places: `configuration unavailable: <error>`, the
roster's LINK LOST token, and the action-result card. Every *other* mesh-derived
string is scrubbed at a data boundary. `errMsg` is now itself the chokepoint —
all nine call sites route through it, `lastErr` included — and the action
runner sanitizes what an HA service call threw. The controller's
`sdk_version` and `firmware_version` are sanitized on the same principle.

**The login backoff could be outrun by concurrent submits.** The failure was
counted *after* `await verify()` resolved. `this.verifying` serialises only ONE
session, and the transports allow 16 telnet + 16 ws concurrently, each with its
own flag — so every session that submitted before the first failure landed read
a still-clean counter, and roughly 32 guesses were evaluated with the backoff
contributing nothing regardless of what it was about to become. The attempt is
now charged **before** the await, so concurrent submits contend for one counter;
success clears it immediately.

**One host could take every telnet slot, and quiet sockets never gave theirs
back.** The 16-connection global cap was the only limit, so a single LAN machine
could deny the TUI to every operator. Worse, a peer that connected and sent
nothing — never even negotiating telnet — held its slot **forever**: there was
no read timeout and no keepalive, and the only per-connection timers were the
60 ms ESC flush and the 1 Hz redraw, neither of which reclaims anything. Added a
**per-source-IP cap of 4**, a **30-minute idle timeout** (deliberately generous:
`setTimeout` fires on *read* inactivity, and an operator may watch a screen for a
long time without typing), and **60-second TCP keepalive** to detect half-open
peers that never send a FIN.

Verified by 497 tests and the full mutation harness: **77 killed, 0 survived, 0
invalid**, with the two remaining `equivalent` entries documented and their
invariants pinned by separate tests. The per-IP cap was additionally proven
against a running server — four connections accepted, the fifth and sixth
refused.

## 0.24.3 — 2026-07-25

**Security — the login gate could be bypassed by any sibling add-on.**

An adversarial audit of the add-on's own posture (25 candidate findings, 9
confirmed after refutation) found one HIGH issue, reproduced end-to-end.

`isSupervisorSource()` tested membership of the whole **172.30.32.0/23** hassio
bridge — which is where every *sibling add-on container* lives, not just the
Supervisor. Ingress trust is composed as:

```js
!!req.headers['x-ingress-path'] && isSupervisorSource(req.ip)
```

Because `:8788` is ingress-only (deliberately not in `ports:`), **every peer
able to open that socket was already inside the /23** — so the second term was
always true on every reachable path and the whole expression reduced to *"did
the client send a header it chooses."* A control that could not fire.

With `auth_enabled: true` and the shipped `auth_require_on_ingress: false`, any
sibling add-on — or an SSRF/RCE in a third-party one — got a **login-free
operator session** on `/console/ws`: the full node roster, device and area
names, live entity states, and with write actions on, the Actions Menu
including lock/unlock and remove-failed-node. Such sessions were also exempt
from the idle re-lock.

Ingress trust is now **pinned to the address `supervisor` actually resolves
to**, checked once at startup before the server listens. Resolution failure
**fails closed** — nothing is treated as ingress and the operator simply logs
in. Verified against this system's real neighbours: the Supervisor stays
trusted, `mosquitto`, `core_zwave_js`, `ecoflow_panel` and `budget` all lose
the bypass.

**A user row with a blank password authenticated.** `parseUsers` required a
non-empty *username* but never checked the password, so `{username: "op",
password: ""}` became a real account whose password was `""` — and because
`hasUsers()` then returned true, the fail-closed "no users configured" branch
did not fire either. The operator saw a login gate and believed they were
protected. Such rows are now dropped, which makes `hasUsers()` false and fails
closed.

Neither path had **any** test. Both now do, and both are in the mutation
harness. 492 tests.

### What the audit did NOT find

Reported for completeness, since a clean result is only meaningful if the
attempt was real. These controls were each driven with input that should be
rejected, and each rejected it: the `/console/ws` Origin gate, the WebSocket
session cap and 64 KiB payload limit, the telnet connection cap, write-token
file mode 0600 and its constant-time compare, the `write_actions_enabled` gate
(refuses even when the ActionRunner is called directly), the typed-CONFIRM
requirement, the scrypt verify, the resize clamp, the login field caps, and the
ANSI-stripping sanitizers — which held against CSI, 8-bit C1, OSC 52 clipboard,
OSC title, newline and CR injection from a device-controlled node name. The
`/console` page contains no dynamic interpolation at all, so HTML injection
there is structurally impossible.

## 0.24.2 — 2026-07-24

**Security: all four dependency advisories cleared, and one dependency dropped.**

GitHub reported two high-severity Dependabot alerts (both `fast-uri`
GHSA-v2hh-gcrm-f6hx). `npm audit` found **four**:

| package | severity | issue |
| --- | --- | --- |
| `@fastify/static` | **high** | route-guard bypass via path traversal (CWE-22) |
| `@fastify/static` | moderate | authorization bypass via non-canonical path (CWE-180) |
| `find-my-way` | high | DDoS with HTTP/2 (CWE-1321) |
| `brace-expansion` | high | DoS via unbounded expansion (CWE-400/770) |
| `fast-uri` ×2 | high | host confusion via literal-backslash authority (CWE-436) |

**`@fastify/static` is removed entirely** — it was declared in `package.json`
and never imported anywhere in the source. The browser console serves its
vendored xterm.js assets through its own explicit routes, so the dependency
carrying the worst advisory was pure dead weight. That is a removal, not a
version bump: the vulnerable code is no longer shipped at all.

The rest are transitive through Fastify's schema machinery and are resolved by
a lockfile update — `fast-uri` 3.1.3→3.1.4 and 4.1.0→4.1.1, `find-my-way`
→9.7.0, `brace-expansion` patched. No direct dependency changed version, so
there is no behavioural risk beyond the removal above.

Verified end-to-end after the removal: the server boots and `/console`,
`/console/xterm.js` and `/console/xterm.css` all return 200. `npm audit`
reports **0 vulnerabilities**. 488 tests pass.

## 0.24.1 — 2026-07-24

**A truncation defect the release itself was about, found by verifying v0.24.0
on the live mesh.** The driver's real background-noise floor is *fractional*
(−95.062 dBm), so the SNR margin computed as `rssi − noise` produced
`+35.062dB` — nine characters, which the signal cell's defensive seven-char cap
then sliced to `+35.062`, **amputating the unit** and leaving a bare number that
reads as an exact measurement.

Every synthetic fixture used a whole-number floor, so no test, no screenshot and
no review round could see it — it took a real 39-node mesh. The margin is now
rounded before formatting at all five sites that compute it (Overview, the
Detail dossier's RSSI row and SNR meter, and both Topology cells), and a
regression test pins a fractional floor across all three screens.

## 0.24.0 — 2026-07-23

### Actions are scoped to what you are looking at

The Actions Menu mixed two blast radii under one header. It read
`ACTIONS · target #8 Kitchen Lamp` and then listed **Rebuild ALL routes** — an
action that touches every node in the mesh — directly beneath the name of a
single device. Same defect family as the rest of this release: the screen said
one thing and meant another.

- **`a` on Overview / Detail / Remedy / Log opens DEVICE ACTIONS**, headed with
  the target node and containing only actions bounded by it: maintenance (ping,
  refresh, re-interview, rebuild *this node's* routes, remove-failed), DEVICE
  CONTROLS, and CONFIGURATION.
- **`a` on Controller opens NETWORK ACTIONS**, headed `whole mesh` with no
  device target, containing the mesh-wide operations (rebuild all routes / stop
  a running rebuild). The Controller screen is already the network view, and its
  command bar now advertises `[A] NETWORK ACTIONS`.
- **Anywhere else `a` names where the actions live** instead of opening an empty
  or mis-scoped menu.

Tests assert the separation in both directions — no mesh-wide row can appear in a
device menu and no device row in the network menu, in any context — plus that
every catalog action stays reachable from exactly one menu, so nothing is
stranded or duplicated.

## (earlier in 0.24.0) — 2026-07-22

**Render-honesty pass.** A full audit of every screen and overlay — 11 surfaces
plus 4 cross-cutting sweeps — found that the TUI's failure mode under a narrow
or short terminal was not "degrade gracefully" but "degrade into something that
looks like a different, wrong reading". This release fixes that class of defect
wherever it appeared.

### Controls never lie about themselves

- **The command bar fits whole keycaps.** It used to cut at the character level,
  so at the default 80-column terminal the Overview rendered a dangling `[` where
  `[T] UNITS` should be and dropped `[Q] EXIT` entirely — the exit key, invisible.
  The bar now tightens its gutter, then sheds whole caps worst-first, and
  discloses the count as `+N`. `[Q]` and `[1-8]` are protected and survive to the
  narrowest width. Same fix on the Log, Detail and Topology bars.
- **The uppercase keycaps are actually bound.** `[S] SORT`, `[T] UNITS`,
  `[D] DATE` and `[O] ERRORS` were advertised in uppercase but only the lowercase
  key was handled, so pressing exactly what the bar printed did nothing.
- **`o` no longer reaches across screens.** It toggled the Log's errors-only
  filter from *any* screen, so an idle press on the Overview silently hid events
  on a screen the operator was not looking at. It is now scoped to the Log.
- **`/` cannot start an invisible filter capture.** Off the Overview there is no
  prompt and no echo, yet the capture swallowed every subsequent keystroke —
  including the `[Q] BACK` the operator pressed to escape, which could strand
  them on a chromeless notice box. `/` is now a no-op outside the Overview.
- **Empty states keep their chrome.** "No nodes", "no node selected",
  "controller not loaded" and the loading cards drew as a bare centred box with
  no command bar and no way out. They now carry an exit bar and, where a filter
  caused the emptiness, say so.

### Measurements are not invented

- **Counters are compacted, not clipped.** A seven-figure controller frame count
  was character-truncated into a five-figure number that looked exact and was
  wrong by two orders of magnitude. Large counters now render `1.2M`.
- **Telemetry fields and values survive.** `fieldStrip` drops whole fields with a
  `+N` marker instead of slicing a value (`NOISE -9` read as a real measurement);
  `lr()` now shortens the label and keeps the value; `titleRule` shortens the
  title and keeps its right-hand status token.
- **A dead node stops looking healthy.** Overview, Topology and the Heatmap
  painted a `✕ dead` node's last-known RTT, data rate and signal in full health
  green. Those readings are history, so they now render neutral. Asleep nodes get
  their own marker instead of being indistinguishable from alive ones.
- **A repeater's link no longer grades the device behind it.** On a multi-hop
  route the reported RSSI is the *last hop's* ACK — the repeater's signal, not the
  node's. It was health-coloured on Topology and, worse, set the grade for a whole
  Heatmap area. It is now shown neutral, excluded from area min/mean, and the
  area's node count reads `4/12n` so the denominator is visible.
- **An assumed noise floor is labelled.** With no real floor from the driver the
  SNR margin is computed against an assumed −95 dBm. Overview now heads the column
  `MARGIN~` and reports `NOISE −95 dBm assumed`; the Heatmap says
  `margins estimated`; Topology marks each reading `est`.
- **The reliability bar fills with reliability.** It was filled with the *error*
  fraction, so a flawless link drained the bar to empty. Its denominator also
  double-counted errors already included in the message totals.
- **Sparklines scale to what they draw.** Auto-scaling ran over the whole series
  while only the last `width` samples were plotted, so a spike that had long
  scrolled off flattened the visible trend to a dead line. A perfectly steady
  braille sparkline also rendered red (critical) purely for being flat.
- **Gauges reserve saturation for the endpoints.** `meter()` rounded, so 94% read
  as complete and 5% as nothing; a signal below an eighth of a bar rendered
  identically to no signal at all.
- **Overflowing screens say so.** `frame()` silently discarded body rows that did
  not fit — the Interference screen's correlated-degradation block and the
  Controller's network-health roll-up could vanish, reading as "nothing to
  report". Overflow now states how many lines are hidden.

### Navigation reaches what the screen promises

- **Remedy actions target the symptom you are looking at.** Remedy names a node
  on every card and offers runnable recommendations for it, but `a` and `p` fell
  through to the *Overview* cursor — so pressing `p` on a "dead-flap #83" card
  pinged whatever unrelated node happened to be selected on another screen, with
  no CONFIRM box (`p` is the one immediate action). Remedy now has its own
  symptom cursor (`↑↓`/`j`/`k`), it is drawn with a `▶` marker, it is what the
  action keys target, and `[↑↓] SYMPTOM` / `[A] ACTIONS` are advertised.
- **Remedy ranks actionable cards first.** A subsumed symptom renders without a
  recommendation because its owning mesh event carries the fix — but mesh
  interference is always `warn` while the `dead-flap` symptoms under it are
  always `crit`, so severity-only ranking floated four recommendation-less
  criticals above the one actionable card and pushed *that* card into "1 more
  symptom not shown". Plan-owners now sort first.
- **The Topology route tree scrolls.** It is ordered shallowest-first and was
  windowed from index 0, so on a real mesh it always kept the many healthy
  "direct" rows and always cut the deep-hop, Long-Range and route-pending
  groups — precisely the anomalies the screen exists to show — with no key bound
  to reach them. It now scrolls (`↑↓`/`j`/`k`, space/`b`, `g`/`G`) and reports
  its position. The old "taller terminal shows all" hint was false: 39 nodes need
  roughly 45 lines.

### Consistency

- **One value, one colour.** Every screen carried its own copy of the RTT,
  timeout-rate, RSSI, SNR-margin and noise-floor thresholds, and the copies had
  drifted: 600 ms RTT was yellow on the Overview and red on the Detail dossier; a
  4% timeout rate was yellow on one and green on the other. All of them now come
  from a single `bands.ts`.
- **Overview scrolling sticks.** The clamped window was never written back, so
  the cursor snapped to the bottom row on every redraw. The scroll counter also
  reported the window *size* (which never changed) rather than the position — it
  now reads `(12–28/39)`.

### Robustness

- **Log event text is sanitized at the sink.** Action-failure text is built from
  whatever a Home Assistant service call throws; a newline in it split one log row
  into two and broke the exact-rows render contract.
- **Width maths ignores control bytes.** `visLen`/`truncate` counted them as
  visible columns and passed them through to the wire.

### Caught by the adversarial review of this release

An adversarial review of the diff above found 19 confirmed defects — most of them
introduced *by* it. They are fixed here, and the fixes are mutation-tested.

- **The reliability denominator change was a regression, and is reverted.**
  zwave-js's `messagesTX` counts messages *successfully sent*; NAK, CAN, the
  timeouts and the dropped counters are **disjoint** failure tallies, not a
  subset of it. Dividing failures by successes yields *odds*, not a rate — it
  overstated every value and could exceed 100%, which the newly added `clamp01`
  was silently hiding. The denominator is once again successes + failures. A
  link with failures and no successes now reads 100%, and an idle link reports
  `— no frames yet` instead of a full green bar labelled "0.0% errors".
- **`[Esc] CLEAR` was itself a false keycap.** The new empty-roster card
  advertised it, but Esc only cleared a filter *during* the `/` capture — after
  Enter it was inert. Esc now clears a committed filter on the Overview.
- **`/` could still start an invisible capture.** The new guard tested the
  screen, but the Overview renders a centred card (with no prompt) while the
  roster is loading. `/` is now refused there, and the empty-roster card — where
  `/` is still legal — echoes the capture with a caret and an apply/cancel hint.
- **Uppercase `[O]` skipped the Log's cursor reset** that lowercase `o` performs,
  so the filter changed under a stale selection. Both now take one path.
- **`Unknown` is no longer painted as `dead`** on the Heatmap and Topology.
  Unknown means "not yet contacted" and is also the fallback when HA omits a
  status; the Overview always kept them apart, so two screens disagreed with a
  third. Unknown now has its own `○`.
- **The selected Overview row showed fewer signal bars** than the same node
  unselected: the weak-signal floor was added to `signalBars` but not to its
  plain, inverse-video twin. Both now share one `litBars()`.
- **Signal bars and their number could disagree** — the glyph used a
  two-threshold ramp while the label had moved to the four-band `marginColor`,
  so between 5 and 10 dB yellow bars sat beside a red number. The glyph is now
  coloured by the label's own band function.
- **The heat legend silently lost its newest key.** It gained two entries but
  kept a width budget encoding the old fixed cost, so `✕ dead` was always
  clipped. The legend now fits itself, dropping whole keys before it will cut a
  label in half.

**Five of the release's own tests were weak, and are rewritten.** The band test
compared a value to itself; the dead-node test put the node on the *selected*
row, which renders without colour at all, so it could not fail for any
implementation; the two `signalBars` assertions were byte-identical and admitted
a "light every bar" mutant; the `fieldStrip` assertion never fired. Each now pins
exact thresholds, lit-bar counts and whole-field output, and carries a control
assertion proving the fixture reaches the code path under test. The Controller
and Heatmap renderers had **no** coverage at all and now have eleven cases.

### And by the round-2 review of those fixes

A second adversarial pass over the round-1 fixes confirmed 29 more — again mostly
self-inflicted. The pattern repeated exactly: **splitting `dead` from `unknown`
fixed the glyphs but broke a second consumer of the same field**, so an area with
two dead nodes and one unknown one sank from the top of the worst-first map to
below every healthy area. Also fixed: the heat legend searched ramp-width before
key count, so at the stock 80-column terminal it dropped `✕ dead` while leaving
seven columns unused; its ramp was coloured by a different band function than the
cells it explains, and never drew the map's most alarming colour at all; dead and
unknown cells sank to the tail of each area's strip, making them the first marks
discarded on overflow; `timeoutCallback` — a failure counter HA does forward —
was dropped at the data boundary, so a callback-timeout wedge rendered as a full
green bar; the capture card replaced the reason the roster was empty instead of
joining it, and blamed a whitespace-only filter that excludes nothing; `Esc
cancel` named an action Esc does not perform; and `Unknown` had no bucket in the
Controller roll-up or the Overview mesh percentage, so nodes the controller has
never heard from counted as healthy.

Five more tests were too weak to catch their own fix.

### And by the round-3 review of *those* fixes

**Correction.** The round-2 notes above claimed the suite was "verified by
mutation — reverting each fix individually makes a named test fail". That was
not true: three of the `unknown`-accounting fixes had no test at all and reverted
with the suite green. The claim was made from having mutation-tested *some* of
the release, not all of it. Every fix in v0.24 has now actually been checked this
way, one at a time.

Round 3 confirmed 39 more findings. The recurring failure repeated a third time,
one layer further out: the heatmap's "area where nothing answers" predicate had
been keyed on `dead`, then on `dead || unknown` — and a single **asleep** or
**routed** node still flipped it false and sank the mesh's only dead room to the
bottom of a map labelled *sorted worst-first*. It is now an explicit four-tier
rank rather than a boolean, so a state nobody anticipated cannot silently rescue
an area. Also fixed:

- The `timeout cb` counter was **wired to `timeoutACK`** — it displayed another
  field's value under its own label.
- At 60 columns `messages TX` / `messages RX` both clipped to `messages`, so two
  cells showed different numbers under the same label. Labels are responsive now.
- The Controller's link tallies dropped every node whose route had not resolved,
  so a second line that reads as a partition did not sum either.
- A `timeoutCallback` HA never sent was summed as zero. Unreported is not zero;
  the rate now says `(partial)`.
- `p` — the one action that runs with **no CONFIRM box** — still targeted the
  invisible Overview cursor from Topology, Heatmap, Controller and Interference.
  Node actions are refused on screens with no node cursor, and the refusal is
  shown **on screen** (the previous message went only to the server log, which
  the operator at the terminal never sees).
- The legend shed `✕ dead` first because keys are dropped from the end and it was
  last; the mean-margin meter, the Detail per-hop bars and the Controller's noise
  gauges were each coloured by a different band function than the number beside
  them; `+25dBest` had no separator; and the title rule advertised a
  whitespace-only filter as active.

### And by the round-4 review — including a correction about these notes

**The mutation-verification claim in these notes was wrong twice.** Round 2 said
"verified by mutation"; round 3 corrected that and then asserted "every v0.24 fix
has now actually been checked, one at a time". That was also false — nine fixes
reverted with the whole suite green, among them the Remedy action-targeting fix,
which is the one that stops `p` (no CONFIRM box) acting on an invisible node.
Both times the claim was written from having checked *that round's* fixes and
then generalised to the release.

So the claim is no longer written by hand. **`server/scripts/mutation-check.mjs`**
is committed: one entry per behavioural fix, each reverting it and requiring the
suite to go red. Anything that survives is reported as an untested fix; anything
whose anchor has moved reports `MISSING`, because that means the file has drifted
from the code it claims to check. Two entries are labelled `equivalent` with a
written reason — they cannot be killed under the current design, and the
invariant that makes them equivalent is itself pinned by a test.

Round 4 confirmed 73 findings. The live defects it caught:

- **The Detail dossier was the FOURTH consumer** of "a dead node's telemetry is
  history". Overview, Topology and the Heatmap all got it; the one screen you
  open to diagnose a dead node did not, so it reported `RTT 20 ms`, `Timeouts
  0.0%` and a green route two rows above its own `RSSI —`.
- **The action refusal never reached the terminal.** It returned "not handled",
  so the key fell through and both suppressed the redraw and logged *"enable
  write_actions_enabled"* while write actions were enabled. It also gave a false
  reason on Log and Remedy, which *do* have cursors — the real cause there is
  that the card under the cursor is mesh-scoped.
- **REMEDY printed "advisory only; nothing is acted on"** on a screen whose own
  command bar runs actions. The true claim is about the engine, and now says so.
- The Controller's `margin ref` gauge missed the noise-band fix; at 60 columns a
  controller **with** a SIS and one **without** rendered byte-identically; the
  Heatmap's `NODES` counted a different population than the Overview's `NODES`
  (now `DEVICES`); and `renderLogin` was the only render path that could return
  fewer than `rows` lines.

One reviewer finding was **rejected**: the Interference diurnal ramp was said to
contradict the shared timeout band. It does not — that cell is a mesh-wide
*hourly aggregate*, where 5% is severe, not one node's lifetime percentage. The
distinction is now documented rather than unified away.

**431 → 469 tests**, and the fixtures that could not distinguish a broken
implementation were rebuilt around values that actually discriminate — several
tests were passing only because the correct and broken code agreed at the exact
number chosen (`meter` needed 0.96/0.04, not 0.94/0.05; the μ-meter needed +9 dB,
the one margin where the two colour functions disagree).

### And by the round-5 review, which attacked the harness itself

Round 5 was pointed at the thing now backing every claim: a clean run over an
INCOMPLETE or DISHONEST list is still misleading. It confirmed 75 findings, and
the most valuable were about the harness.

**Four entries were killing by failing to compile.** A mutant that breaks the
build makes every test file fail to *load*, so the suite goes red for a reason
unrelated to the behaviour the entry names — a vacuous check inside the tool
built to eliminate vacuous checks. The harness now **typechecks the mutant
first** and reports `INVALID` if it does not compile. (Reviewers found one;
the gate found four. Two needed care: TypeScript narrows a naive mutant to
`never`, so a bare `null` and an unconditional early `return` both break the
build for reasons that have nothing to do with behaviour.)

**Ten fixes had no entry at all**, including three changed files — Interference,
login and Log — with no coverage whatsoever. So the previously published
"47 killed / 0 survived" was overstated in both directions at once.

Three more integrity holes, all fixed:

- **No baseline check.** On an already-red suite every entry would report
  `killed` and the run would exit 0 — the count was compatible with a suite that
  never passes. There is a gate now.
- **The signal handlers could never fire.** The loop is synchronous, so
  `execFileSync` blocks the event loop for the whole run; they were decoration.
  Removed, with a comment saying so. A crash-recovery sidecar written *before*
  each mutation is the real mechanism, and it survives SIGKILL.
- **Two concurrent runs corrupted each other** — one restored what the other had
  just mutated. The sidecar now records the owning PID and a second run refuses.

Also: a mistyped `--only` reported a clean run over zero entries, and a killed
`equivalent` entry was silently counted as an ordinary kill instead of flagging
that its label had gone stale.

### Live defects round 5 found

- **The heatmap cell sort was descending.** Introduced with the rank tiers in
  round 3, and directly contrary to the comment above it: since the strip
  truncates its tail, overflow dropped exactly the weak links the sort exists to
  preserve. A room with thirty strong nodes and one at −93 dBm hid the −93.
- **The Remedy cursor was an unanchored index.** The engine re-sorts its symptom
  list every poll, so between the frame the operator read and the key they
  pressed, a different node could slide into that slot — re-aiming `p`, which
  runs with **no CONFIRM box**. It now anchors to the symptom's `(nodeId, kind)`
  identity, written back by the renderer from the card it actually drew.
- **The dead-node rule had a fifth consumer**: `pushRoute` threaded its `stale`
  flag into the rate and route RSSI but never passed it to `routeChain`, so a
  dead node's per-hop readings stayed green inside a row greyed around them.
- **A never-contacted node reported "RF health nominal"** — no measurements
  means no flags, and the empty-flag branch read that absence as health, under a
  title rule saying `UNKNOWN · SCORE —`.
- **`renderLogin` floored its layout at 20 columns** and emitted 18-column rows
  into an 8-column terminal. It now degrades to plain text below the floor.
- **The margin band and the `W` flag had drifted apart** — 7–9 dB rendered red
  on three screens while the score and the flag legend called it fine. Rather
  than pick a new number, `bands.ts` now **derives** its red cut from
  `health.ts`'s `WEAK_MARGIN_DB`, so the two cannot diverge again.

Plus: the Actions Menu was a second consumer of the refusal explanation and
still sent Log/Remedy operators to the wrong screen; `actionNoticeDetail`
survived `resetActionState`, so one action's explanation could reappear under
another's; and Detail banded raw RTT while the Overview banded the rounded
value, so one reading could print `100 ms` in two colours.

Reproduce the current state with `node scripts/mutation-check.mjs`. It prints
its own verdict; the number is not copied here by hand, because twice a
hand-copied claim about this exact thing turned out to be false.

Width sweeps from 60 to 200 columns assert that no screen ever ends a row
mid-keycap or loses its exit key.

## 0.23.0 — 2026-07-21

**Device control + configuration writes** (Phase 3 of the per-device pass — the
"test the devices" ask). The TUI can now actuate devices and change their Z-Wave
configuration, all behind the existing `write_actions_enabled` master switch AND
the type-CONFIRM step. Nothing actuates in read-only mode.

- **Device controls in the Actions Menu.** Open the menu (`a`) on a node and, below
  the mesh-maintenance actions, a **DEVICE CONTROLS** group lists every controllable
  entity with domain-appropriate verbs — lights/switches/fans **Turn On / Off /
  Toggle**, covers/garage doors **Open / Close / Toggle**, locks **Lock / Unlock**.
  Each row shows the device's live state ("now: on") and an impact badge; the
  high-stakes ones (unlock a lock, open a garage) are flagged **DESTRUCTIVE** and,
  like every menu action, require typing CONFIRM.
- **Configuration writes.** A **CONFIGURATION** group lists the node's *writeable*
  parameters. Selecting one opens a value picker — enum parameters offer their
  named options (↑↓ to choose); numeric parameters accept a typed value bounded by
  the parameter's min/max — then the usual CONFIRM box. On success the dossier's
  CONFIG PARAMETERS section re-reads the device so the new value shows.
- **Safety.** Device control and config writes are operator actions, never mesh
  remediation — they are never attributed to the learning ledger. The service
  mapping refuses any verb a domain doesn't support, so a bad call can't be formed.

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
