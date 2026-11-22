# Changelog

## 0.79.5

A forward clock step no longer makes a real outage a 90-minute start death, a
waiting node-down dwell that ended no longer comes back after a crash restart,
and a deploy during a Z-Wave JS outage keeps the driver start. A node id Home
Assistant files under another device drops the old device's dwells, evidence
and baselines while the add-on keeps running, and `/api/health` reports no
conclusions before they are judged. The update from 0.79.4 carries no
`driverDrop`, which 0.79.4 never wrote: a Z-Wave JS restart in progress at the
update is not read as a driver start. The schema of `evidence.json` is
otherwise unchanged, and a rollback to 0.79.4 ignores `driverDrop`.

### Fixed — a forward clock step could make a real outage a 90-minute start death (0.79.3)

- The host's boot (now minus uptime) was judged on every tick of a death's
  5-minute dwell, so a forward wall-clock step could put it within 10 minutes
  before the death and hold a `node-down` on a node not known to be listening
  back for 90 minutes. The boot is now judged at a death's first Dead reading
  only, where their distance is the host's uptime, and the verdict stays
  both ways; a carried dwell keeps the one taken at its first Dead reading,
  in whichever run first read it (for a dwell 0.79.3 or 0.79.4 wrote, the one
  that version last took). A driver restart seen over the link is still
  judged on every tick: its handshake can come after the first reading.

### Fixed — a waiting node-down dwell that ended could come back after a crash restart (0.79.3)

- Every save, the 15-minute flush included, wrote a node-down still on its
  5-minute dwell, so one that ended after a flush came back after a crash
  restart on the same boot with its old onset, and a node read Dead again
  could be raised at once. Once the engine has taken the restored carry, the
  saves made while the add-on runs write only raised node-downs and start
  deaths; the shutdown save writes the waiting dwells too. A deploy, update or
  restart of this add-on on the same boot keeps a waiting dwell's onset, and
  the next run's first tick takes it off the disk. After a crash restart it
  starts again at the next Dead reading. A raised node-down or a start death
  that ends still reaches disk with the next prompt save, as in 0.79.3.

### Fixed — a clock step back could hold off the prompt save (0.79.3)

- The minute between prompt saves was measured on the wall clock, so a step
  back of X right after a save held the next one off for X + 60 s. It is
  measured on the host's uptime, which a wall-clock step does not move
  (inferred: `os.uptime()` reads `/proc/uptime` on Linux). The first tick's
  write-out of a restored carry no longer starts the minute, so a node-down
  raised in the minute after a deploy is saved at once.

### Fixed — a deploy during a Z-Wave JS outage lost the driver start (0.79.3)

- A link the server ended was held by the driver client alone, and a stop
  cleared it: when the add-on stopped before Z-Wave JS was back, the next
  run's first handshake was no driver start, and a FLiRS node Dead after that
  restart was raised 5 minutes in, not 90. An open link end now survives a
  stop and is carried in `evidence.json` (`driverDrop`, written at every save
  while open); the next run takes it on the same boot within 10 minutes of
  the last save, and its first handshake closes it into a driver start. It
  does not trigger the prompt save, so a crash restart during an outage can
  lose one no save wrote. Before the engine's first tick a save writes the
  driver link's part as this run holds it: a driver restart it saw, else the
  restored one, and the drop as its driver client holds it, so a drop the
  first handshake closed is written as the span it closed, not as open.

### Fixed — another device on a node id that never left the roster

- `replace_failed_node` keeps the id on the roster, so the departed-node
  eviction never ran for it, and the failed device's dwells (a raised
  node-down included), evidence, baselines, readings, open episodes and the
  refresh trial's open decision stayed on the id. At a registry load (each
  Home Assistant reconnection) while the add-on keeps running, a node whose
  own device changed from one to another now loses them, with a Log line; a
  first load, a device first seen or gone, and most of the mesh changing at
  once are no swap. After an add-on restart before that load nothing is
  compared, and the old state stays. A replace by the same product is the
  same Home Assistant device and keeps its state.
- The node's own device (a `zwave_js` identifier exactly `<home>-<node>`)
  stands for the node whatever the list order. An endpoint child, or the
  orphan a replace by another product leaves (`<home>-<node>-…`), still maps
  its entities to the node, and stands for it only while the node's own
  device is not listed. Before, the last device listed stood for the node:
  its name, area and entity list, and the `device_id` its subscriptions,
  configuration parameters and actions use.

### Fixed — `/api/health` before the engine's first tick

- Until the first roster and the engine's first tick after a restart, it
  reported conclusions not yet judged, so a carried node-down read
  `degraded: false` there while Home Assistant was sent nothing. It asks the
  publisher's gate now: until then `conclusionsReady: false` (a new key),
  `degraded: null` and an empty `engine`; after it, the published
  conclusions, Home Assistant's copy up to one 30-second publish behind while
  its posts succeed (longer while it answers slowly or refuses them). `ok` and
  the HTTP status code are unchanged.

### Clarified

- zwave-js-server (checked at source, 3.0.0 and master) ends a client's link
  only when it shuts down or rebuilds a failed driver, or on a message that is
  not JSON, which this client never sends (master also refuses a new
  connection before its handshake while the driver is not ready, which reads
  as nothing here); against it, a network fault is the one link end read as a
  driver start without being one.

### Corrected

- Source comments no longer call the coarse tier the baselines' substrate
  (baselines fold fine samples; it feeds the screens only), and the detection
  engine is no longer handed it: no detector read it.

### Tests

- 1,799 tests, 30 new; 1,866 mutation-harness entries (17 labelled
  equivalent, none added): 69 new, 1 retired with the check it covered (a
  stop cleared an open peer close), 18 re-anchored; the 87 new and
  re-anchored entries are all killed.

## 0.79.4

Documentation only: the option descriptions Home Assistant shows on the
Configuration tab, and every document in the repository, now say what the code
does. Nothing the add-on does has changed.

### Corrected — the option descriptions (English and Spanish)

- **Require login (direct access)** (`auth_enabled`): SSH needs it, and while
  it is off every SSH login is refused. A web-console connection that does not
  come through the HA sidebar (possible only from Home Assistant's internal
  add-on network; port 8788 is not published on the LAN) opens with no login
  while it is off.
- **Max login attempts** (`auth_max_attempts`): the count starts an escalating
  back-off per address (5 s, doubling, up to 5 min), kept across reconnects;
  the description said the connection was dropped, which only the web
  console's login screen does.
- **Idle re-lock** (`auth_idle_lock_min`): it re-locks web-console sessions
  only. A web-console connection idle for 5 minutes is also closed and
  reconnects, so an idle gated session meets the login screen after 5 minutes
  at most. SSH checks the password once, when the connection opens, and closes
  a connection after 30 minutes with no inbound traffic.
- **Evidence sample interval** (`route_poll_interval`, renamed from "route
  poll interval"; the option key is unchanged): it is the detection engine's
  tick and polls nothing; it also sets the span of the 240 controller samples
  behind the INTERFERENCE screen's serial-link rates.
- Auto-ping and the refresh trial are the only actions taken without a key
  press, both off by default; auto-ping also starts the liveness sweep, and
  its mesh-wide suppressor counts a quarter of the mains-powered nodes (at
  least 4). The liveness sweep asks at most one node a minute. The log
  archive is read from a shell add-on, not this add-on's SSH. The Core
  WebSocket URL must reach this Home Assistant, since the data layer
  authenticates with this add-on's own Supervisor token.

### Corrected — the documents

A scan of every `.md` file against the code, and four reviews of the corrected
text as a whole, made 289 corrections where the code or another document
contradicted the text, in `DOCS.md`, `README.md`, `DESIGN.md`,
`PERFORMANCE.md`, `SECURITY.md`, `RESEARCH.md` and the option descriptions.
`RESEARCH.md` now marks the parts of its design that are not built (among them
the 0–10 rating and the `backup_nvm` rule). 44 more passages, among them
passages in the older releases in `docs/CHANGELOG-history.md`, are reworded to
the impersonal register.

### Tests

- The pin on the frozen history (`changelogContract.test.ts`) is updated for
  the reworded older releases.

## 0.79.3

A deploy, update or restart of this add-on no longer withdraws a raised
`node-down` or reads as a driver start: raised node-downs and waiting start
deaths outlive the add-on, and only a driver start the add-on can show opens
node-down's start window, where a death waits 90 minutes. The update from
0.79.2 itself carries nothing, since 0.79.2 wrote no carry: a node-down raised
at the update is raised again 5 minutes after it, and so is a FLiRS start
death still waiting at the update.

### Fixed — a restart of this add-on held back a FLiRS node's node-down for 90 minutes (0.79.2)

- 0.79.2 took the driver's start from every driver-WS handshake, this add-on's
  own first one included, and kept its dwell state in memory. After a deploy,
  update or restart, a node auto-ping does not probe that was already Dead,
  its `node-down` raised, read as a new start death: the critical card and
  `binary_sensor.zwave_tui_degraded` cleared and came back 90 minutes later.
  Reproduced through the real data layer; it did not occur on the reference
  mesh, where nothing was Dead at the 0.79.2 deploy.
- Only a known driver start opens the window: the host's boot, as now minus
  uptime on each tick (a start verdict, once taken, stays; a forward clock
  step during a death's 5-minute dwell can still make it one); or a
  driver-WS link this add-on did not end itself followed by a new handshake,
  read as a driver start between the two, with the window running to 10
  minutes after the handshake
  (a network drop, or the server dropping this client, is not told apart from
  a restart); or such a restart carried from the previous run on the same
  boot. The add-on's own first handshake, and a link it ended itself (a
  liveness or handshake timeout, or a malformed frame its WebSocket library
  closes on), are not driver starts. A Z-Wave JS restart the add-on did not
  see keeps the 5-minute dwell.
- A death judged a start death stays one: a later driver restart, or a deploy
  that carries only the newest restart, no longer cuts its 90 minutes to 5.
- Node-down dwells are carried in `evidence.json` (optional `nodeDown` and
  `driverStart` fields; the schema is unchanged) and seeded at the next run's
  first engine tick, for nodes still on the roster. On the same boot every
  dwell is carried: a raised node-down is raised again on that tick, dated
  from the outage, and a start death still waiting keeps its own onset. After
  a host reboot only raised node-downs are carried, without a driver start; a
  dwell still waiting began before that boot's own start, and the next Dead
  reading starts it again, so a FLiRS node's real outage under 5 minutes old
  at a reboot is raised 90 minutes after the reboot's first Dead reading.
- A carried dwell is judged again on that tick: a node that reads Alive,
  Awake or Asleep drops it. A raised node-down is raised at once while the
  node reads Dead. A host without a clock battery that boots behind its last
  save keeps the carry only when the add-on starts within its 180-second boot
  grace (the outage is then dated from the restart); started later, a save
  dated ahead of the clock is discarded, the carry with it.
- Unknown is no reading: a driver restart reads its nodes Unknown for seconds,
  and that no longer ends a node-down dwell or withdraws a raised one. Its
  card counts Dead time only and says the status is Unknown.
- Home Assistant is sent nothing until the engine's first tick after a
  restart, so `binary_sensor.zwave_tui_degraded` is not sent off before a
  carried node-down is raised again.
- A raised node-down, a start death and a newly seen driver restart are saved
  within a minute rather than at the next 15-minute flush, so a power cut or
  crash restart does not lose them, at most one such save a minute. A change
  in the carry saves the store even when no sample was recorded; an unchanged
  carry writes nothing. A carry of another network is not written, also after
  a change of network while running, and a node that leaves the network
  takes its dwells with it.
- Auto-ping's driver-restart burst refusal (0.65.0) still reads every
  handshake: right after this add-on's start no probe has been sent, so it
  withholds nothing there.

### Corrected

- 0.79.2's "a node-down already raised stays raised" held only within one run
  of the add-on. From 0.79.3 it holds across restarts of the add-on and host
  reboots, and through an Unknown reading.

### Tests

- 32 new tests: the start window over a span and its bounds; a start death
  staying one through a later restart; Unknown as no reading; a raised
  node-down carried and raised on the next first tick, clamped or not; a
  start death still waiting across a deploy, with and without a known start;
  a carried dwell judged again; the carry in the evidence store (same boot,
  another boot, boot grace, another network, malformed entries, a carry change
  alone saving the store, the same carry in another order writing nothing);
  the driver link reporting only a link this add-on did not end; and, through
  the real data layer and a mock driver server, a deploy with a raised FLiRS
  node, a deploy with nothing carried, a host reboot with a start death and
  with a raised node-down saved at once, a Z-Wave JS restart seen over the
  link and carried, a wall clock jumping ahead of uptime before and after a
  death's first reading, the default uptime source, a carried node-down that
  ends on the first tick saved at once, the prompt save's spacing, a node that
  left the network, and nothing published before the engine's first tick.
- 70 new mutation-harness entries, none declared equivalent; 4 existing
  entries re-anchored to the rewritten lines, and 1 retired with the check it
  covered (a raised node-down is now raised at once whatever its flags ask
  for, pinned by its own entry).

## 0.79.2

A held `rtt-degraded` breach now ends on two normal round trips, as a breach
starts on two slow ones; an episode is not scored while a probe of its node is
still waiting for its slot; and a FLiRS node read Dead right after a driver
start waits 90 minutes before it is a critical outage.

### Fixed — an episode was scored while a probe of its node waited for its slot (0.79.1)

- Since 0.79.1 one tick's probes leave 10 s apart, the last up to 45 s after
  the tick, and the guard that keeps an episode open until its last probe has
  settled (0.75.3) saw a probe only once it had left. On the reference mesh 2
  of 5 episodes in 21 hours closed on four of their five closing readings, the
  fifth still waiting for its slot.
- A probe's slot now reaches the guard when the probe is pended, kept apart
  from the probe sent before it. A burst probe not yet planned when the window
  ends (a suppressed tick) is not waited for. Attribution still waits for the
  frame to leave.

### Changed — a hold ends on two normal round trips

- In 0.79.1 one round trip under the line ended a held breach. On the
  reference mesh two such reads ended holds on nodes still slow (one measured:
  178 ms against a closing median of 493), the closing burst found each node
  still slow, and a new episode opened minutes later: two slowdowns became
  five episodes and cost 23 and 31 probes.
- Where a hold can still matter (the sweep on, the kept reading inside its
  deadline), one normal round trip now owes one confirmation probe. A slow
  answer keeps the hold; a second normal one ends it. While it is owed the
  breach is not held, so one that never comes lets it go at the window's end,
  as before. Each doubt costs at most one probe per round trip asked about.
- A slow round trip read across a route change (one the driver reports, or
  the add-on's own routed read failing over) no longer refreshes a hold. It owes a
  confirmation, and the reading before it holds to its own deadline
  meanwhile. A 1194 ms read taken as a node re-routed to 100 kbps had carried
  a hold for two more hours; whether the node was still slow, the data cannot
  tell. A slow round trip refreshes the hold only once 15 s old, so a route
  change on the next sample is seen first.
- An average falling to the line still ends a breach at once; in those 21
  hours that split one slowdown.

### Changed — a FLiRS node read Dead right after a driver start

- A node auto-ping does not probe (FLiRS, sleeping, or capability not yet
  known) that reads Dead within 10 minutes of the driver's start must read
  Dead for `NODE_DOWN_START_DWELL_MS` (90 min) before `node-down`. Any other
  death keeps the 5-minute dwell, and a node-down already raised stays raised.
- On the reference mesh one FLiRS motion sensor read Dead after each of four
  driver restarts in eight days and was back 13, 38, 46 and 48 minutes later,
  another once for 9 minutes. Each time `node-down` raised a critical card and
  `binary_sensor.zwave_tui_degraded`.
- The cost: a real outage of such a node right at a driver start is raised
  after 90 minutes instead of 5. Home Assistant's own zwave_js status shows it
  Dead meanwhile.

### Corrected

- 0.79.1's "one episode per slowdown" and "10 probes plus confirmations" held
  only for a slowdown with no reading that ends the hold. Live, 0.79.1 still
  cut burst probes per breach-hour from 22.3 to 4.6, and probes the ceiling
  caused from about 109 to 66 a day.
- A held symptom's round-trip age is on the TUI's card; Home Assistant's
  symptom sensor carries the count and kinds only.

### Tests

- 13 new tests: the hold confirmed both ways (a lone normal round trip owes a
  confirmation, a slow answer keeps the hold, an unanswered doubt lets go, two
  normal round trips release it, two in one tick at once, nothing asked with
  the sweep off), re-route reads (a reported route change, the add-on's own failover,
  the span's bounds, a normal answer ending the doubt), node-down's
  start-scoped dwell and its latch, the settle guard waiting for a planned
  probe kept apart from the sent one, the planned stamp at each slot, and the
  confirmation staying owed through the real engine pass.
- 23 new mutation-harness entries, one declared equivalent; 19 existing
  entries re-anchored to the rewritten lines.

## 0.79.1

One slowdown on a node only the sweep talks to is held as one `rtt-degraded`
episode, not one every 27 minutes, until a reading ends the hold (see 0.79.2),
and one tick's probes no longer go out in the same millisecond.

### Fixed — one slowdown re-opened an episode about every 27 minutes

- RTT is read only when something talks to the node, and a breach was judged
  on its newest reading in a 10-minute window. On a node only the 2-hourly
  liveness sweep talks to, that reading left the window long before the next
  one came, and the symptom cleared as if the node had recovered. The
  episode's confirmation burst then found the node still slow, and a new
  breach started: one slowdown became an episode about every 27 minutes,
  10 probes each.
- In the first 47 hours of 0.79.0 on the reference mesh, 15 of the 22
  `rtt-degraded` episodes were re-opened this way. One 4.75-hour slowdown on
  one node became 10 episodes and 113 probes, and Home Assistant's symptom
  count read 0 for 43 % of it.
- A matured breach with no fresh reading left in the window is now held on
  its last slow round trip, judged against the line of now, for at most the
  configured sweep cadence plus `RTT_HOLD_MARGIN_MS` (30 min) after it. A newer
  slow round trip continues the same breach and episode. A newer normal one
  ends the hold, so the breach clears on the next silence as before and its
  closing burst measures the node.
- Only a slow round trip carries the hold. The driver's average falls by a
  quarter per transmission, so a recovered sweep-only node still reads over
  the line for several sweeps on its average alone, and holding on the
  average would show it degraded for hours.
- Nothing is held with the sweep off, on a node no confirmation probe can
  reach, or on a Dead node, and a breach still arming clears on silence as
  before. A read that comes after the deadline finds the breach let go, and
  the pair rule starts it again.
- While held, the symptom stays shown: on the TUI's card with its round
  trip's age (`RTT 378ms · 40m ago`) and a sentence saying it is held, and in
  Home Assistant's symptom count. It keeps its episode open and can open none,
  and the refresh trial does not decide on it. A slowdown the sweep reads
  within the hold, with no reading that ends it, spends its opening and
  closing bursts, 10 probes, plus any confirmations (corrected in 0.79.2).

### Fixed — a probe sent right behind another node's read measured that node

- A tick sent every probe it owed in the same millisecond. Measured on the
  reference mesh with read-only routed reads: a node that reads about 25 ms
  alone or first read 589–1,214 ms (median about 660; 9 clean trials of 11)
  when its read went out right behind a 9.6 kbps node's, and 24.7–25.6 ms
  when it went 10 s after (5 of 5). At 2 s only 2 of 5 trials gave a clean
  reading, both about 25 ms: too few to judge.
- On 2026-11-17 a direct 100 kbps node was booked `rtt-degraded` twice that
  way: first on a slow frame of its own traffic paired with a confirmation
  sent right behind a 9.6 kbps node's read, then on burst readings taken the
  same way.
- One tick's sends now leave `PROBE_SPACING_MS` (10 s) apart, the step
  shrinking so they all leave within three quarters of the tick. Each probe
  is pended at its slot and noted when it leaves, so its answer is judged
  from then, and the line of one that waits says so (`— waits 10 s for its
  slot`).
- A slot re-checks the gates the decision applied: the autonomy pause, the
  controller's receiver off, an operator action, Home Assistant not ready, a
  route rebuild, a dead-node storm and, for a measurement probe, its node
  gone, Dead or in a post-kill hold. If one is shut the slot sends nothing.
  It is withdrawn with an info line and is not a failed launch: a ladder ping
  gives back its attempt and its backoff, a dead-lane routed read is owed
  again, and no read falls back to the NoOp ping. A verification probe
  withdrawn this way counts as taken, like one dropped at its tick.

### Corrected

- 0.79.0's cost figure was wrong. Its replay charged each ceiling breach one
  5-probe burst, but every episode sends two, and the re-opening above
  multiplied them. Live, the ceiling spent 211 probes in the first 47 hours,
  206 on 5 breaches and 5 confirmations that started none: about 109 a day,
  a quarter of the sweep's probes, not 17 a day and 3.5 %.
- DOCS: the controller's 30-minute background-noise tier has gone above
  −98 dBm (to −95.4) since a rise that began on 2026-11-12; the sentence
  that said it never had is corrected.

### Tests

- 26 new tests: the hold in the detector (13), the hold through the real
  engine pass (one slowdown is one episode: held for 100 minutes, a slow
  sweep read continues it, one normal sweep read ends it within the hour),
  the refresh trial skipping a held breach, probe spacing (10: slots, each
  gate at the slot, a node gone or Dead, a storm, stop, a transport failure
  at a later slot, the step, the ladder's attempt and backoff given back, a
  re-owed dead-lane read, the burst gap between slots, production's default
  timer), and a contract pin that production keeps the default spacing.
- 48 new mutation-harness entries, three of them declared equivalent; 31
  existing entries re-anchored to the rewritten lines.

## 0.79.0

`rtt-degraded` judges a node with no learned RTT normal against a fixed
300 ms ceiling.

### Fixed — re-routing nodes were never judged on round-trip time

- The RTT normal is learned per route. A route change empties the node's six
  time-of-day bands, and a band graduates after about 23 fresh readings:
  about 12 days for a node that only the 2-hourly liveness sweep talks to. A
  node that re-routes even once a week never graduates, and the routed nodes
  re-route the most.
- On the reference mesh (2026-11-13) 23 of 38 nodes had no graduated RTT band,
  17 of the 20 routed ones among them. One node's round trips ran at
  378–525 ms on six consecutive sweeps; it had re-routed 19 times in 14 days
  and was never judged. Between 2026-11-13 and 2026-11-15 more mains nodes
  with no graduated band ran 370–880 ms round trips, one of them 880 and then
  837 ms on consecutive readings, with no verdict.
- Where a confirmation probe can reach the node (a mains ping candidate, with
  the auto-ping runner on), `rtt-degraded` now judges a node whose current
  time-of-day band has not graduated against `RTT_CEILING_MS = 300`. The v0.78.0 start rule is unchanged:
  the average must be over the line and the two newest raw round trips too,
  and a lone slow one owes one confirmation probe. From a 30 ms average that
  takes two round trips at 880 and 837 ms, three at 525 ms or five at 400 ms.
  One frame over about 1.1 s lifts the average over on its own, but a breach
  still needs the confirmation's answer to be slow too.
- For the same nodes a graduated line above 300 ms is capped at it. No learned
  line on the reference mesh is above 124 ms.
- Per-route stratification and the route-change reset are unchanged, and so
  is every verdict against a learned line under the ceiling. A node whose
  average is over the ceiling is held out of its baselines, as a node over a
  learned line already was (v0.78.0).
- After a driver restart, a node whose band has not graduated is judged net
  of its restart seed measured against what the driver averaged after the
  seed, even when the band holds a few readings: their median is not a
  yardstick. A slow node's own slow seed therefore does not hide it for hours,
  and a seed decaying over a healthy link does not put a node over the
  ceiling. For a graduated band the allowance is the v0.77.1 one, unchanged.
- Replayed over 14 days of the reference mesh's coarse tier, the ceiling starts
  37 breaches on 10 mains nodes, and none on the nine nodes that held one
  direct route and a graduated normal throughout. The replay put their cost
  at about 17 probes a day; live it was about 109 a day (corrected in 0.79.1).
- Not covered: a slowdown under 300 ms on a node with no normal, and FLiRS or
  sleeping nodes, which keep the learned-only rule.
- `rtt-degraded` episodes feed the refresh trial, so ceiling breaches on mains
  nodes join its randomized arms from this release.

### Changed — the screens and HA say which line a node is judged against

- The symptom card's yardstick row reads `ceiling 300ms · no normal for this
  band yet` for a ceiling breach, and a capped baseline ends `· capped at
  300ms`. The narrative names the line that was crossed.
- DETAIL's `Norm RTT` row reads `still learning · Nd so far — held to the
  300 ms ceiling meanwhile` where the ceiling applies (`no normal yet — held
  to the 300 ms ceiling meanwhile` for a node the store has never folded), and
  a capped line ends `· line capped at 300 ms`. Under an ungraduated band, a note gives the
  coarse tier's route-change count: `The RTT normal restarts on every route
  change: 12 in the last 7d`.
- REMEDY's coverage counts gain `ceiling-only N`. With any such node, the
  partial-coverage text says a degradation *may go unflagged* (it said
  *would not be flagged*) and names how many the ceiling holds; the learning
  headline reads *no detector has a learned yardstick yet*, and its text says
  the *learned* detectors wait while the ceiling judges anyone.
- `sensor.zwave_tui_engine` gains `rtt_ceiling_only`. `rtt_ready` is
  unchanged; `detectors_total − rtt_ready − rtt_ceiling_only` nodes are not
  judged on RTT.
- `baselines.ts` said a route change resets nothing. It empties the node's
  rssi and rtt bands and keeps its timeout rate; the comment now says so.

### Tests

- symptoms: `rttYardstick` for every basis, the ceiling's start, its
  confirmation, its cap, a FLiRS node outside it, a node the store never
  folded, the learned card's own wording, and the restart seed both ways,
  for an empty band and for one with a few readings.
- zwaveDataChurn: the coverage count and DETAIL's accessor use the
  detector's own reachability rule, for a never-folded node too.
- driverWsClient: both data-provider bridges forward `rttYardstick`.
- detailScreen, remedyScreen and haStates for the rows, counts and attribute,
  and the re-route span either side of 48 h.

## 0.78.3

The app is published as stable.

### Changed — no "Experimental" badge on the app info page

- `config.yaml` declared `stage: experimental`, so Home Assistant showed a
  yellow "Experimental" chip on the app's info page. It now declares
  `stage: stable`, the Supervisor's default, and the chip is gone.
- The Supervisor reads an installed app's stage from the copy it saved at
  install or update, not from the store.

### Tests

- The config contract test pins `stage: stable`.

## 0.78.2

The add-on's config folder is mapped under the map type's current name.

### Fixed — a Supervisor warning at every store reload

- Supervisor 2026.07.1 renamed the `addon_config` map type to
  `app_config`. The old name still works, but the current Supervisor
  logs `App 'Z-Wave TUI' uses legacy map type 'addon_config'; use
  'app_config' instead.` each time it reloads the add-on store: 16 times
  in three days on the reference host.
- `config.yaml` now maps `app_config:rw`. The Supervisor mounts the same
  folder at the same `/config` for both names, so the log archive keeps
  its files, its backups and its path.
- A Supervisor older than 2026.07.1 does not know the new name. From
  2023.12.1 it drops the entry (from 2025.08.3 with a warning), and the
  archive is then written inside the container, which backups miss and
  every stop removes. 2023.12.0 and earlier reject the add-on. The stable
  channel is on 2026.10.5.

### Tests

- The config contract test pins `app_config:rw` and fails on any legacy
  map type (`addon_config`, `all_addon_configs`, `addons`).

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
