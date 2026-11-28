# Changelog

## 0.80.0

What the engine already knows reaches the screen where an operator looks for
it, ordered by urgency and whole at 80 columns. The Overview strip counts
critical symptoms; ENGINE ranks its tracked nodes alarm-first, gives a down
driver link's cause and cost rows of their own, and lists confirming episodes
first with their arm kept at 80 columns. Detail labels its probe ratio as
lifetime, shows its page and end keys, and says "RF health nominal" only at a
score of 80 or more. REMEDY counts the nodes too quiet to rate timeouts, says a
learning arm made things worse even with no measured control arm, and renders
its tallies, evidence, titles, headlines and caveats as whole forms. LOG names
an unverifiable closure's subtype beside its verdict and says when a manual
ping was answered. The stored files keep their format.

### Changed — the Overview strip counts critical symptoms

- The roster's `!` mark is per row, so with the default health sort a crit on
  an A-scored node sat below the fold at 80x24 and 120x40 and nothing else on
  the home screen said one existed. The strip carries a red `CRIT N` right
  after `DEAD` while any symptom is critical — the count REMEDY's summary calls
  `N critical`, mesh-wide symptoms included. Inserted, not appended:
  `fieldStrip` sheds from the end, and an appended field was the one dropped
  at 80 columns. Absent at zero, so a healthy strip is unchanged.

### Changed — ENGINE ranks its tracked nodes alarm-first before the 8-row cap

- The auto-ping snapshot lists nodes in id order and ENGINE shows 8. Six
  low-id nodes holding a 24 h own-probe kill and two Dead ones filled the
  list, and a high-id `GAVE UP — needs a human` row fell into `○ 1 more
  tracked node(s)` at every terminal size. The rows are ranked first: a
  give-up (`GAVE UP` or `CANNOT SEND`), then a node Dead now, then a miss
  streak, then the rest, node id breaking ties.

### Changed — a driver link that is not live names its cause and cost on rows of their own

- The client's prose was the label row's second bit, so at 80 columns a link
  that went dormant mid-run read `DRIVER LINK  dormant · +1`. Outside `live`,
  `connecting` and `handshake` the prose has its own row, clipped to whole
  words, and a `dormant`, `backoff` or `stopped` link adds `background RSSI,
  S2-desync and duplicate-frame watches are off`, in shorter whole forms
  where the row is narrow.

### Changed — LEDGER — LIVE lists confirming episodes first and keeps their arm at 80 columns

- Episodes rendered oldest first, six rows: seven chronic episodes hid the one
  in its confirmation window — the one an action now would confound — behind
  a bare `○ 2 more open episode(s)`. Confirming episodes come first, in ledger
  order within each group, and the overflow line counts how many it hides are
  confirming: `○ 2 more open episodes (1 confirming)`.
- The 36-column `confirming — symptom absent, scoring` made the arm bit the one
  shed at 80 columns, so a confounded episode and a clean control point both
  read `· +3`. The long form is used only where the arm bit still fits after
  it; otherwise `confirming` or `degraded` carries the row: `#12
  return-path-degraded  degraded · confounded — neither arm · open 15m · +1`.
- At 60 to about 71 columns, behind a long node id and kind name, the one-word
  form still shed the arm. There the arm takes shorter words — `confounded`,
  `control arm`, and for an action `action: X`, then `X`, then `action` — so
  the rows read apart: `#12 return-path-degraded  degraded · confounded · +2`,
  `#14 chronic-return-path  confirming · control arm · +2` and `#41
  return-path-degraded  confirming · healNode · +2`.

### Changed — Detail labels its probe ratio as lifetime, shows its page and end keys, and says "nominal" only at 80 or more

- The Probes ratio is cumulative, and the only word that said so was the
  pre-0.40.2 caveat three rows below, which retires for a node first seen
  after the epoch. The window rides on the value: `84/98 answered (86%,
  lifetime) · 31 self-proven`, `84/98 (86%, lifetime) +1` at 40 columns.
- Space/b page and `G` jumps to the end, where EVIDENCE sits below the fold at
  80x24 for every device shape, and the bar named only the one-row scroll. It
  reads `[↑↓] SCROLL [␣/b] PAGE [G] END [< >] NODE [A] ACTIONS [1-9] SCREENS
  [Q] BACK` at 80; narrower, the two are the first caps shed, with `+2`.
- No flag means no lane crossed its own flag threshold, and an unflagged 66/D
  read `RF health nominal` under `SCORE 66 (D)`. Below 80 the legend reads
  `no flag threshold crossed — the score is lost in sub-threshold lanes (see
  RTT/Margin/Timeouts/LWR)`, or a shorter whole form: the route lane's hop
  count and data rate are on the LWR row.

### Changed — REMEDY counts the nodes too quiet to rate timeouts in the learning and partial states

- Both return-path detectors skip a node whose 10-minute window holds under
  20 sends, and the partial state's `timeouts 33/39` read as 33 nodes judged:
  the screen was byte-identical with 0 and with 39 such nodes. In the
  learning and partial states the counts carry `unmeasured N` after
  `timeouts`, and a line after the paragraph says `timeout: N too quiet in 10
  min to rate — the return-path detectors skip them.`, in shorter whole forms
  where the row is narrow.

### Fixed — a learning arm's harm warning was silent with no measured control arm (0.44.0)

- `efficacyNote` returned nothing whenever the kind's self-heal rate was
  unmeasured, before it looked at the attempts or the below-readiness harm
  warning, so an arm tried 2.9 times with every attempt worse read the same
  silence as one never tried. It renders `≈ still learning this action (n≈2.9
  of 4) — self-heal not yet measured — ⚠ every attempt so far made it WORSE
  (too few to be sure)`; nothing only with no attempts and no base rate.
- In both learning ladders the hedge is shed before the warning: at 80
  columns the note reads `≈ still learning this action (n≈2.9 of 4) — ⚠ every
  try made it WORSE` where it read the readiness fraction alone. Where that
  does not fit, a rung that keeps the warning comes ahead of the bare
  fraction: `≈ still learning — ⚠ every try made it WORSE` at 60 columns, and
  `≈ ⚠ every try made it WORSE` at 40. A partial harm sheds the same way, as
  `⚠ n≈1.5 made it worse`.

### Changed — REMEDY's tallies, evidence, titles, headlines and caveats are whole at 80 columns

- Each tally line was one sentence and a blind truncate, ending `weigh the
  evidence a`, `too few readings to ju` and `probe re-` at 80. Each takes the
  longest whole form that fits, clipWords as the floor, and none wraps: the
  screen does not scroll, and a taller card pushes the plan off the frame. The
  owed-probe and cannot-be-probed lines do the same.
- The evidence row was one join and a truncate: weak-signal's `failed
  deliveries 13 …` lost its window, and rtt-degraded's restart allowance
  stopped mid-word. Each measurement is a `shedLine` token, dropped whole with
  `+N`, and carried to continuation rows only where not even the first fits.
  The tokens keep the row's `  ·  `, wider than the ` · ` some values carry
  inside themselves (`baseline 38±6ms · capped at 300ms`): `shedLine` takes
  its separator as an argument, and every other caller keeps ` · `.
- Four candidate titles are 70–80 columns before an 8-column indent, so the
  head overflowed and the `+1` disclosing the shed tag went with it — the RF
  survey row ended `measurement needed to` with `[physical · inference]`
  silently gone. Those candidates carry a short title (`Survey the RF
  environment — measurement needed [physical · inference]` at 80), and the
  floor clips the short title to whole words with `+1`. The plan headline
  takes a short form where the planner gives one (edge-cluster's `… check the
  common relay`), with clipWords as the floor.
- The caveat below a candidate is chosen by sentence, not by wrapped line: the
  sentence naming priority routes first, its clause where the sentence is too
  wide, clipWords at `W − 8` as the floor. A wrap had split "priority" from
  "routes" (`…deletes any manually-set priority …` at 80) and the indent ate
  the ` …` at 120; every rebuild card names priority routes at 80 and 120.
- Every empty state's paragraph — disabled, no nodes, learning, partial, and
  the all-clear's `Every node has a graduated timeout and rtt baseline` pair —
  and the two-line ceiling note are kept line for line where they fit and
  re-flowed to whole words where they do not. At 40 columns the all-clear's
  first line read `Every node has a graduated timeout a`; at 60 the disabled
  and no-nodes paragraphs were cut, and the ceiling note ended `slowdown is
  …`. The rssi note takes the longest whole form that fits, and the ✓
  headline sheds to `✓ All clear — N learned, no symptoms.` and then `✓ All
  clear — no symptoms.`, with clipWords as the floor.

### Changed — LOG names an unverifiable closure's subtype beside its verdict

- The ring line carried no subtype — only the container's stdout line tagged a
  transient or undersampled closure — so a structural, by-design or
  cadence-limited closure all read `closed unverifiable (no action)`; and the
  confounded tag sat at the end of the line, where the 80-column list row cut
  it. The qualifier follows the verdict word: `rtt-degraded closed
  unverifiable: transient (no action)`, `: undersampled`, `: unprobeable`, and
  ` (confounded)` on a scored verdict credited to neither arm.

### Changed — LOG says when the operator's ping was answered

- A miss on a manual ping reached LOG and the ENGINE streak; an answer reached
  only the debug log, so `p` reported the ping sent and then nothing. The judge
  books `node N answered your ping (lastSeen advanced)` at info, for the
  manual lane only. With a runner the `p` notice reads `auto-ping judges
  whether it answered — see LOG (e)`, and without one `HA does not return the
  answer — watch its Status / Last-seen`. The Actions-menu CONFIRM note says
  `Where auto-ping runs it judges the answer in LOG; otherwise watch the
  node's Status / Last-seen.`, and the whole note wraps to 6 lines at 80
  columns and 7 at 60, so the box keeps its `type CONFIRM to arm` prompt and
  `Esc = cancel` at 80x16 and 60x18.

### Tests

- 2,018 tests, 23 new: 9 in `remedyScreen.test.ts`, 5 in
  `engineScreen.test.ts`, 3 in `detailScreen.test.ts`, and one each in
  `actionsCatalog.test.ts`, `chrome.test.ts`, `overviewScreen.test.ts`,
  `zwaveDataChurn.test.ts`, `autoPing.test.ts` and `sessionActions.test.ts`;
  2 Probes-row assertions in `detailScreen.test.ts` now expect the lifetime
  label, and the 0.71.0 Ping-note assertion in `actionsCatalog.test.ts`
  expects the shorter note. 2,194 mutation-harness entries (19 labelled
  equivalent): 80 new, and 15 re-anchored to the moved text:
  `engine-confirming-is-labelled`, `engine-confound-outranks-action`,
  `engine-shows-driver-link`, `detail-probes-honest`,
  `baseline-counts-not-clipped`, `caveat-grounded-off-index`,
  `caveat-not-every-candidate`, `remedy-tag-is-all-or-nothing`,
  `confounded-row-names-reroute`, `confounded-row-verdict-first`,
  `remedy-ceiling-note-partial`, `remedy-ceiling-note-learning`,
  `remedy-learning-names-learned-detectors`, `remedy-may-go-unflagged` and
  `remedy-gave-up-whole-forms`.

## 0.79.9

Screens no longer state what the engine never measured. With no auto-ping
runner no verification probe is booked, and REMEDY says none is sent instead
of calling a score pending; with one, REMEDY no longer says the engine only
recommends. A node-down card whose ladder gave up says so, and neither it nor
the summons says the node was not tested after a ping went unanswered; the
quiet-node card and narrative state only what the detector checked, and the
all-clear claims only that no symptom is firing. A driver refusal after a ping
still indicts the detector, and ENGINE shows ghost-suspect's refusals.
Interference names the driver link's state instead of saying to set
`driver_ws_url`, Controller names it beside `not reported by HA`, and the Log
names its in-memory ring wherever the ring does not reach back to the range
start. The stored files keep their format.

### Fixed — verification probes counted as owed, and the score called pending, with no auto-ping runner (0.47.0)

- Only the auto-ping runner drains the verification queue, and it is started
  only with auto-ping and write actions both on, both off by default. Every
  episode on a listening node still booked a five-probe burst, so REMEDY's
  card read `N verification probes still owed — the score is pending, not
  absent` and DETAIL `N verification probes owed — episode evidence is not yet
  confirmed for this node` (0.62.0) for probes nothing would send. No probe is
  booked with no runner now, and a card of a kind with a recovery metric reads
  `○ auto-ping is off — no verification probes are sent; any score must come
  from the node’s other traffic`, in whole shorter forms at 60 and 40 columns:
  each kind's evidence floor counts readings of its own signal from any
  traffic, not only probe replies, so an episode of a kind with a recovery
  metric can still be scored. A card of a kind whose metric is `none`
  (`ghost-suspect`, `chatty-device`, `edge-cluster`) gets no such line.

### Fixed — REMEDY said the engine only recommends while auto-ping could write on its own (0.30.0)

- The summary line ended `the engine only recommends; you run the actions`
  and the all-clear `advisory-first, nothing is acted on` whatever the add-on
  ran, while auto-ping's ladder, sweep and verification probes and the
  refresh trial write with no keypress. With an auto-ping runner they read
  `the engine can also write on its own; see ENGINE` (the pointer shed, then
  the clause, whole, where the row is narrow) and `New symptoms surface here;
  the engine can also write on its own (ENGINE).`: a capability, true while
  auto-ping is paused or suppressed. Without one the all-clear keeps its
  words, shortened whole to `New symptoms surface here; nothing is acted on.`
  and `Advisory-first: nothing is acted on.` where the row is narrow, and the
  summary's tail sheds the same way, to `the engine only recommends` and then
  whole: cut blind, the all-clear ended `surface here — adv` at 40 columns and
  one warning's row `you run the acti` at 60.

### Fixed — a node-down card kept "a ping often revives it" after the ladder gave up (0.37.0)

- The planner's headline is true before auto-ping's ladder runs and false once
  it has spent its attempts; the recommendation sensor has led a summons with
  what the ladder did since 0.72.1, and REMEDY did not. A node-down card whose
  ladder gave up now leads with the sensor's words: `Node is DOWN — auto-ping
  gave up after N unanswered attempts`, or that its pings could not be sent,
  and with shorter whole forms of them where they do not fit. At 40 columns
  those are `DOWN — auto-ping gave up (N tries)` (or without the count where
  it does not fit), `DOWN — N unanswered, then unsent` once a ping went
  unanswered, and `DOWN — auto-ping pings not sent` only where none left.

### Fixed — a summons said the node was not tested after its pings had gone unanswered (0.72.1)

- `sensor.zwave_tui_recommendation` led the summons of a ladder whose
  launches ran out with `auto-ping could not send its pings, so the node
  itself was not tested`, whatever had gone before. A failed launch gives its
  attempt back, and the launch-failure count is cleared only by a recovery or
  the node's departure, so the launches can run out after a ping left and went
  unanswered: that ping tested the node. With `attempts` above 0 the sensor's
  headline, and the REMEDY card's, reads `Node is DOWN — auto-ping could not
  send its pings after N unanswered attempts`; `not tested` stays for a ladder
  none of whose pings left.

### Fixed — the quiet-node card said no traffic was attempted, and its narrative cited a sweep that was not running (0.38.0)

- The ping card's grounding line read `but no traffic was attempted`, while
  with the sweep on every mains node is asked once a cadence and quiet-node
  fires only after three of them. It reads `yet it is not marked Dead`, the
  detector's own test. The narrative named the liveness sweep's cadence with
  no sweep running and said the driver `still reports it Alive` of a node the
  detector also admits when Unknown: the sweep is named only when one runs,
  and it says the driver has not marked the node Dead.

### Fixed — the all-clear said no node is anomalous where no detector could judge one (0.14.0)

- `and none is currently anomalous` followed a branch that checks only that no
  symptom is firing, on a fleet where a node whose 10-minute window holds
  fewer than 20 sends is skipped by both return-path detectors. It reads `and
  no symptom is firing`, and such nodes are counted beneath it with no verdict
  word beside the ✓: `(N of T: too little traffic in 10 min to rate
  timeouts.)`.

### Fixed — ENGINE never showed a refusal of ghost-suspect, the one kind a refusal indicts (0.41.0)

- LEARNED iterated only the scored kinds, which never held `ghost-suspect`, so
  its refusal tally reached REMEDY's card and no ENGINE row, while two code
  comments said two screens showed it. A kind outside the scored set that a
  refusal can indict, derived from the planner's own table, gets two rows of
  its own when its tally is above zero: `ghost-suspect` and `○ N refused as
  misdiagnosis`, whole at 40 columns. The `n≈` legend renders only where a
  LEARNED row shows a weight, so a block of refusal or unscoreable tallies
  alone no longer explains a notation it does not show, and at 40 columns it
  is a whole form, `n≈ decays, caps ~33; nodes cumulative`.

### Fixed — a driver refusal after a ping on the same episode was dropped (0.43.1)

- First action per episode wins the attribution, so a ping before `x` — the
  operator's, or the ladder's, which starts again with the add-on and pings a
  Dead mains ghost after its dwell — took the stamp, and the refused
  `removeFailed` that followed filed nothing. A refusal claims no credit: it
  now replaces an unrefused stamp on the episodes in its scope
  (`ghost-suspect`, whose metric is `none`, so the stamp it replaces scored
  nothing; a test holds every kind a refusal can indict to that metric). A
  later success still takes no earlier action's credit, and a second refusal
  keeps the first.

### Fixed — Interference said to set `driver_ws_url` in every driver-link state (0.17.0)

- With no fresh background-RSSI reading the screen printed `◷ unavailable —
  the read-only driver-WS client is not connected.` and `(HA strips
  backgroundRSSI; set driver_ws_url to enable this.)` whether the link was
  live, connecting, retrying, dormant, stopped or absent, though the option
  ships set. It names the state now: `not configured` and the hint only when
  the option is empty; `no background-RSSI reading from the driver in 90 s`
  for a live link; the link connecting, starting up, retrying, dormant or
  stopped `(see ENGINE)`, with `(check driver_ws_url.)` below a link that is
  retrying or stopped; and a homeId mismatch on a row of its own, its advice
  moved to the next row where the fault does not fit, and the fault wrapped at
  its ` — ` onto the rows below where it still does not, as at 40 columns.
  Every other line has whole forms for 60 and 40 columns.
- The Controller's empty per-channel row read `not reported by HA`, true and
  silent about the driver link that would carry the reading (0.13.0). The
  link's state rides beside it as one whole token, shed with `+1` where the
  row has no room; a live link is only named there (`see INTERFERENCE`),
  because that row is also empty when a reading lacks channel 0. The head
  has a whole short form, `per-channel floor: not from HA`, taken where only
  it carries the token or leaves room for the `+1`: cut blind at 40 columns,
  the long head lost its last word, `HA`.

### Fixed — the Log blamed the filters over an in-memory ring that did not reach back to the range (0.41.0)

- The disclosure that the ring is in memory only rendered for the yesterday,
  24-hour and seven-day ranges alone, so an empty ring — after a restart, or
  with Home Assistant unreachable at boot — left today, the last hour and an
  errors-only all-time list saying only that no event matched the filters. It
  renders wherever the ring does not reach back to the range start, and not
  where it covers the whole range.

### Tests

- 1,995 tests, 23 new: 8 in `remedyScreen.test.ts`, 3 in
  `zwaveDataChurn.test.ts` and 3 in `interferenceScreen.test.ts`, 2 each in
  `engineScreen.test.ts` and `outcomes.test.ts`, and one each in
  `planner.test.ts`, `symptoms.test.ts`, `recommendation.test.ts`,
  `controllerHeatmapScreen.test.ts` and `logScreen.test.ts`; 18 fixtures in
  `zwaveDataChurn.test.ts` and 1 in `remedyScreen.test.ts` that use the
  verification queue now model a running auto-ping, the 18 with one complete
  snapshot. 2,114 mutation-harness entries (19 labelled equivalent): 47 new,
  and 2 re-anchored to whole-form text: `remedy-advisory-claim` and
  `legend-only-with-a-weight`.

## 0.79.8

Each node's Dead and alive crossings are counted against one status that every
observation moves, whichever status feed or roster poll made it, so a change
made while the connection to Home Assistant was down, a replacement of a failed
node and a Dead node a restarted driver reads Alive are counted, and a crossing
a status feed counted is not counted again after a reconnect, a re-arm, a failed
status subscribe or a driver restart. A node evicted from the roster no longer leaves
deaths queued for the auto-ping runner, a re-interview or a failed-node removal
no longer leaves a subscription on the connection, and a state read no longer
waits on a connection that is down. Nothing stored on disk changes.

### Fixed — Dead crossings counted twice, or not at all, around reconnects, re-arms and replacements (0.12.0)

- Each status feed counted against a status of its own, seeded from the
  roster's last reading, and the roster counted only a node with no live
  status feed. A status change made while the connection was down, or before a
  new feed's listener was attached, reached no feed and was counted only by a
  roster poll that read it before the node's new status feed answered. A
  crossing a live feed counted after the last reading was counted again by the
  first poll that read it after a reconnect's teardown, a re-arm or a status
  subscribe that failed took the node out of the feeds' set, a revival as well
  as a death. A status event read together with its own feed's subscribe
  answer, or heard by a feed a re-arm was still releasing, counted nothing.
  A replacement of a failed node by one that reads Alive was not counted for a
  node whose status feed was live, so the failed node's death stayed queued
  for the auto-ping runner, and a Dead node a restarted driver read Unknown
  kept its death queued when it was read Alive, and had a second death queued
  when it was read Dead again. Every status event, on any of the node's feeds, and every
  roster reading not overtaken by a status event heard since the poll was sent,
  now moves one counted status per node, kept across reconnects, re-arms, a
  node's own re-subscribe and failed subscribes; a crossing from it is counted
  once, whichever source saw it. An Unknown reading never replaces a known
  status: a restarted driver reads a node it has not yet heard from Unknown,
  which says nothing about the Dead boundary, so the node's next known status
  counts against its last; a node first read Unknown and then Dead still counts
  its death. The status carried past a node's own
  re-subscribe (0.79.7) and the new feed's seed are gone with it.
- A roster poll that shows another network (a home id change) counts nothing
  against this network's statuses: through 0.79.7 it counted a crossing for a
  node without a live status feed, and a death read there reached the refresh
  trial's kill check, which the network reset does not undo.

### Fixed — deaths queued for an evicted node were never cleared or dropped (0.71.0)

- A node off the roster for five minutes is evicted; a death still queued for
  the auto-ping runner stayed queued, and the revival of a node later included
  on the id handed it over as that node's. The eviction now drops it; a death
  its revival had cleared stays for the runner's next drain.

### Fixed — a re-interview or a failed-node removal left a subscription on the connection (0.3.0)

- Home Assistant registers `zwave_js/refresh_node_info` and
  `zwave_js/remove_failed_node` as subscriptions on the connection before it
  awaits the driver, and keeps them after it answers (an error answer drops
  only their listeners), so each one sent left a subscription live for the
  life of the socket, a re-interview's forwarding every later interview of the
  node. Both now go through `sendSubscription()`, which releases the id on the
  same socket once any answer arrives, or at the reply timeout while the
  driver may still be working. The answer and a timeout read as before: a
  removal Home Assistant has not answered in 3 minutes is still an unknown
  outcome.

### Fixed — a state read started on a connection that was down (0.79.7)

- A rebuild, or an activity-feed retry that had made the state feed, whose
  next activity subscribe failed with the connection down still read the
  states, which waited 10 s for a socket and then logged `entity states fetch
  failed`, or ran on the reconnect's socket beside its rebuild's own read. It
  is no longer started then; the reconnect's rebuild reads the states.

### Tests

- 1,972 tests, 21 new: 13 in `nodeFeeds.test.ts`, 4 in
  `haWsClientSubscriptionCommands.test.ts`, a model of Home Assistant's
  subscription commands over a real socket, 2 in `zwaveActions.test.ts` and 2
  in `activityFeeds.test.ts`; 5 earlier tests assert the true counts where
  they had pinned the old ones. 2,067 mutation-harness entries (19 labelled
  equivalent): 25 new, 5 re-anchored, and 19 removed with the code they pinned.

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
