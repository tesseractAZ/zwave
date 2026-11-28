# Changelog

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

## 0.79.7

A subscribe Home Assistant answers after the add-on's 10-second timeout is
released on its socket instead of staying live with no handle, an activity
feed the statistics rebuild could not make is subscribed again a minute on
instead of staying dark until the next rebuild, and a status event read
together with a roster poll's answer is no longer replaced by the poll's older
reading. Nothing stored on disk changes.

### Fixed — a subscribe Home Assistant answered after the client's timeout stayed live with no handle

- Home Assistant handles one connection's commands in order, with no cancel,
  and registers a subscription while it handles the subscribe. A subscribe the
  client gave up on at its 10 s reply timeout therefore still registered when
  Home Assistant reached it, under an id the client no longer routed, for the
  life of the socket: a node's statistics or status listener (in 0.79.6 beside
  the one the 60 s retry then made), a second controller feed beside the next
  rebuild's, a `state_changed` feed of the whole house, or a
  `zwave_js_notification` feed. The client now sends `unsubscribe_events` for
  it in the turn the timeout passes, on the same socket, where Home Assistant
  reaches it after the subscribe (`not_found` when the subscribe failed);
  events sent under the id before it lands reach no handler, and a socket that
  has closed, or is closing, takes the subscription with it. Other commands
  are unchanged: an action Home Assistant has not answered in time still reads
  as an unknown outcome.

### Fixed — an activity feed a rebuild could not make stayed dark until the next rebuild (0.8.0)

- A rebuild of the statistics feeds whose `state_changed` subscribe failed (no
  answer within the client's 10-second timeout, or a connection closed under
  it) kept its controller and node feeds and logged the failure, and nothing
  made the feed before a Home Assistant reconnect, the self-heal or a re-arm:
  no value or notification rows on the Log screen, Detail's LIVE ENTITIES and
  the device menu's `now:` from the 10-minute full state read, and the pause
  toggle turned on in Home Assistant read only there. The
  `zwave_js_notification` subscribe, in the same try, was not sent, and one
  that failed on its own was dropped without a line while the log named it
  subscribed. Each activity feed is now a try of its own, and one a rebuild
  could not make is subscribed after the first roster poll that succeeds a
  minute after the attempt (on the host's uptime): only the feeds not made,
  one attempt at a time, and again a minute after each that fails; the attempt
  that makes the state feed reads the states again. Each handle it makes is
  kept with the feed set's as it is made, so a re-arm releases it, one begun
  while its second subscribe is out included; one answered after another
  rebuild began, or while a re-arm releases the feed set, is released and not
  kept. It stands aside while a rebuild runs or the feed set is down, but not
  for a re-arm an entry reload latched, which leaves the activity feeds as
  they are. The Log screen reads `activity feed down — its state_changed
  subscribe failed; retried after a minute` until it is made, and the add-on
  log names each failed feed (`activity subscribe failed (state_changed): …`).
  A failure on a connection that is down adds no row, and the feeds after it
  are not tried: the reconnect's rebuild makes them and adds the row.
- A failed activity subscribe does not fail the rebuild: failed, the rebuild
  would run again at every roster poll, making the controller's feed and every
  node's two again each time.

### Fixed — a status event read together with a roster poll's answer was taken as older than the poll's reading (0.79.6)

- Over uncompressed frames the client can hand a status event Home Assistant
  sent right after a `network_status` answer to its handler before the poll
  that awaited the answer resumes, so the poll acted on its older reading
  after the event. A revival read that way, after a poll that reads the node
  Dead, re-subscribed its feeds for nothing; a death read with the first poll
  since the node's status feed answered gave way to that poll's reading, which
  left the death queued when the node revived before the next poll, or had
  the next poll re-subscribe the node for nothing when it stayed dead. Each
  alive, dead, sleep or wake up event now takes an order mark: a node whose
  live status feed heard one after both the poll and the feed were sent is
  neither judged by that poll nor given its reading as a baseline, and every
  other poll's reading is the live feed's baseline (0.79.6: only the first
  poll sent after the feed answered). With permessage-deflate, which the
  client offers, Home Assistant's and the Supervisor's sockets compress every
  frame (inferred from the aiohttp sources), and the poll acted first there.
- A status a node's old status feed hears while the node's own re-subscribe
  releases it (the statistics feed goes first, unless the 60 s retry made it
  after the status feed) is counted once and kept as the newer: through
  0.79.6 a poll that read such a death before the new status feed answered
  counted it again, and the new feed was seeded with the older reading, which
  left the death queued when it heard the revival.
- A status a feed a re-arm is still releasing sets on a node whose rebuild
  status subscribe fails no longer seeds the status feed the 60 s retry makes
  once a roster poll has read the node since: in 0.79.6 the retry's feed kept
  it, and a death it then heard first was not counted.

### Tests

- 1,951 tests, 57 new: 25 in `nodeFeeds.test.ts`, 10 of them pins that pass
  on 0.79.6 too; 16 in `activityFeeds.test.ts`, a model of Home Assistant's
  core event bus; 8 in `haWsClientLateSubscribe.test.ts`, a model of its
  per-connection command order; 3 in `realClient.lateSubscribe.test.ts`, the
  data layer over the real client and a mock Core with node objects
  (`_realHa.ts`, `_realRun.ts`); 2 in `statusOrderRealClient.test.ts` and 2
  in `statusReleaseRealClient.test.ts`, the real client with frames
  uncompressed and compressed; and 1 in `activityFeedsLate.test.ts`. 2,061
  mutation-harness entries (19 labelled equivalent): 56 new, 8 re-anchored,
  and 3 removed with the code they pinned, one of them labelled equivalent.

## 0.79.6

A node replaced with `replace_failed_node`, or included on a freed id, has its
statistics and status feeds made again on its new node object in Home
Assistant, and the 60-second retry of a failed node subscribe now subscribes.
A driver server on another network leaves the driver link stopped, not
reading live, and a stick swap no longer stops the driver link for the rest of
the run as a driver server on another network. Nothing stored on disk changes.

### Fixed — a replaced node's feeds stayed on the failed node until the next rebuild

- Home Assistant binds each node's statistics and status feed to the node
  object it resolves at subscribe time, and a node replaced (by the same
  product or another) or included on a freed id is a new object there, which
  no earlier feed hears. Through 0.79.5 the new device had no statistics feed
  and its Dead/Alive crossings were counted by neither the feed nor the roster
  fallback until a Home Assistant reconnect, the self-heal or a re-arm, while
  Detail's EVIDENCE badges read its feeds live. A node's two feeds are now
  released and made again on their own after the roster poll that reads it not
  ready after it read ready, shows a status change its status feed did not
  deliver (the replacement of a failed node that read not ready; a new status
  feed's baseline is the first poll sent after it answered), shows its device
  changed, or lists it again after a poll found it off the roster (an id back
  with no device as last loaded asks for a registry load). A re-interview of
  the same node is re-subscribed too, as Home Assistant's websocket does not
  tell the two apart: one release and subscribe more.
- A node included after the feed set was built, or an evicted id back on the
  roster, had no feeds until a rebuild either: it is subscribed after the poll
  that lists it. An evicted node's feeds are released at the eviction, and
  feeds a re-arm released are not released again.
- A driver restart costs no per-node re-subscribe: the nodes wait for the
  re-arm its entry reload latches, and a status feed made since the previous
  poll is not judged by a change it may have missed, so a replacement by the
  same product of a failed node that read not ready, landing between the
  node's two subscribes, leaves its statistics feed on the removed node until
  a later interview start, absence or swap re-subscribes it, or the feed set
  is rebuilt. A per-node subscribe that resolves after a re-arm began, or on
  another connection, is released and not kept. Neither a node's own
  re-subscribe nor the retry runs beside a reconnect's rebuild, and a rebuild
  it superseded that fails on the new connection no longer lets a roster poll
  start a second one beside it. Feeds a node's own re-subscribe or the retry
  makes never stamp the fleet's liveness clock, so the dead-feed watchdog and
  `binary_sensor.zwave_tui_degraded` still see the rest of the feed set, the
  controller's included, fall silent.

### Fixed — a failed node subscribe was never retried (0.26.0)

- The 60 s retry passed no list for the handles, and the optional-chained push
  skipped the subscribe with it: a node whose subscribe failed was marked
  subscribed with no feed made, its EVIDENCE badges reading live. The retry
  now subscribes, by the node's device as last loaded, keeps the handles where
  a re-arm releases them, stands aside while a rebuild runs, the feed set is
  down or a node's own re-subscribe is out, and drops from its queue a node
  the roster has shown gone (it is subscribed once it is back) or one with no
  device as last loaded, such as one queued by an old network's device the
  boot load admitted (it is subscribed once a load gives it one).

### Fixed — a driver server on another network could leave the driver link reading live after it was stopped

- When the homeId cross-check proved a mismatch inside the driver's state
  dump (Home Assistant's home id already known when the dump landed, as after
  a home-id change), it stopped the driver client, and the rest of the dump
  then declared the stopped client live: DRIVER LINK read `live` with no
  connection under it, the S2 lane read `refused` (`s2_lane` too), and
  nothing reconnected it until the next home-id change or restart. The
  client now stays `stopped`, beside the homeId mismatch row, and a dump cut
  short by a stop hands on no further node and is not logged as processed. A
  stop from the handshake's home-id callback ends the handshake the same way;
  nothing in the add-on stops the client there today.

### Fixed — a stick swap could stop the driver link for the rest of the run

- A home-id change cycles the driver client, and kept the previous server's
  home id until the new handshake: a read of the cross-check in between (the
  sleeper watch reads it on every call) compared it with the new id, purged
  the driver telemetry and stopped the client for the rest of the run, though
  the driver server had moved to the new network too. The cycle forgets it now.
  A driver link back on the new network before Home Assistant reports the new
  home id still reads as one on another network, telemetry purged and client
  stopped, until the roster poll that reads the new id runs the cycle.

### Tests

- 1,894 tests, 41 new: 34 in `nodeFeeds.test.ts`, a model of Home
  Assistant's node feeds bound to zwave-js-server-python node objects, 4 in
  `driverWsClient.test.ts`, 2 in `zwaveDataChurn.test.ts` and 1 in
  `deviceSwapSim.test.ts`; 2,008 mutation-harness entries (20 labelled
  equivalent, 2 of them new): 66 new, 2 re-anchored.

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
