# Changelog

## 0.79.1

One slowdown on a node only the sweep talks to is one `rtt-degraded`
episode, not one every 27 minutes, and one tick's probes no longer go out in
the same millisecond.

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
- While held, the symptom stays shown, with its round trip's age
  (`RTT 378ms · 40m ago`) and a sentence saying it is held. It keeps its
  episode open and can open none, and the refresh trial does not decide on
  it. A slowdown the sweep reads within the hold spends its opening and
  closing bursts, 10 probes, plus any confirmations.

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
- 48 new mutation-harness entries, three of them declared equivalent; 43
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
  install or update, so the badge goes away with this update, not with a
  store reload.

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

## 0.78.1

A new SSH host key is checked to parse back before it is saved.

### Fixed — a first start could fail on the host key it had just made

- ssh2 1.17.0's ed25519 generator strips every leading zero byte from the
  public key, where only the BIT STRING's unused-bits byte should go. The
  1 key in 256 whose public half starts with 0x00 comes out 31 bytes long,
  and ssh2's own parser rejects it (`Malformed OpenSSH private key`):
  10 and 12 of 3,000 generated keys in two measured runs.
- The key was written to `/data/ssh_host_ed25519_key` before its
  fingerprint was taken. On such a start the add-on exited with a `FATAL`
  line before its HTTP console came up, with the malformed key already
  saved; s6 restarted it, and that start replaced the key with a warning
  that clients would see a changed host key, though none had connected.
  Replacing a host key that does not parse took the same 1-in-256 risk.
- `generateHostKey()` parses each generated key back and draws another
  when one does not parse, up to 8 keys. Only a key that parses is
  written (0600, through a rename). Eight unparsable keys in a row stop
  the start with `ssh: none of 8 generated host keys parsed back (…)` and
  write nothing.
- An existing host key that parses is read and kept as before, so an
  installed add-on keeps its fingerprint.

### Tests

- The SSH test files took their host key straight from ssh2's generator,
  so 1 run in 256 failed every test in the file that starts a server, and
  once made the mutation harness report a spurious mapping miss. They now
  take it through `generateHostKey()`.
- New: a generator that returns a malformed key and then a good one
  leaves only the good key on disk and one `generated` line in the log;
  eight malformed keys throw the message above and leave no file; 1,000
  keys from the real generator all parse back.
- 3 new mutation-harness entries (1,617 in all): the retry, the write
  after the parse-back, and the give-up message.

## 0.78.0

`rtt-degraded` no longer fires on one slow round trip, and checks one with a
single probe instead of a 10-probe episode.

### Fixed — one slow round trip is not a slowdown

- The driver's RTT average keeps 0.75 of itself per acknowledged
  transmission, so one frame above the median plus 16 scales lifts it over
  the detector's line (median plus 4 scales) on its own, and a larger one
  keeps it there: a 700 ms frame on 25±8 ms holds it over for six readings.
  In the 13-day reference archive 14 of the 30 `rtt-degraded` episodes were
  one such frame; their verification bursts spent 140 probes measuring a
  normal node.
- A breach now starts only when the average is over the line and the two
  newest raw round trips in the 10-minute lookback are both over the same
  line. Once started, the average alone holds it, as before. Raw round trips
  are recovered per sample from the average and the transmit count, the
  recovery the ledger has scored since 0.74.3; a sample with several
  transmissions is one reading.
- A driver restart's seed is never a round trip: the recovery starts over at
  a sample whose counters reset. Neither is a sample whose transmit count
  moved before its average did, nor a receive-only statistics event keeping
  an old average fresh.
- An average over the line stays out of the baselines whether or not its
  breach has started, as in 0.77.3, when the average alone armed the dwell.
  DETAIL says `the RTT average is over its line with no breach started`.

### Added — one confirmation probe

- When the average breaches on one slow round trip with nothing behind it,
  the node is owed one verification-lane probe, logged as
  `verification probe (rtt-degraded confirm, N nodes owed)`. A slow answer
  starts the breach; a normal one ends the question. One slow round trip buys
  at most one probe: no other goes to the node until that round trip has left
  the 10-minute lookback, counted from the round trip, so a probe sent late
  does not hold back the next slow round trip. One the runner never takes
  (refused, withdrawn, absorbed by a burst or dropped by the pause) leaves no
  cooldown; one it takes and then drops (a node Dead at its tick) does. The
  cooldown is not saved, so a round trip restored with the evidence after an
  add-on restart gets no probe (it may already have had one); a newer one is
  asked about as usual. It passes every gate a burst probe does,
  opens no episode, is withdrawn unsent when the node's own traffic answers
  first, never shortens an owed burst, drains after any burst owed on the
  same tick, and is not counted as episode evidence on DETAIL or REMEDY.
- Where no probe can reach the node (a FLiRS or battery node, or an install
  without auto-ping running), the newest round trip alone starts the breach,
  as in 0.77.3, but never after a normal one. That includes the start-up
  window before the driver reports which nodes listen.
- An episode of a route-sensitive kind opens confounded when the add-on's own
  routed read re-routed its node during its dwell or in the detector's
  lookback before it (10 minutes; 30 for `weak-signal`, which reads that far
  on a node too quiet for a rate). The dwell counts from no earlier than five
  minutes before its nominal maturity (its start plus its own dwell; two
  days for `chronic-return-path`). An open held or emitted past that (a mesh
  event, a thin window, a missed pass, a chronic dwell short of its hits)
  keeps everything since, erring toward confounding. An episode re-opened on
  a dwell that already had one counts from the re-open, even when a mesh
  event holds the re-open; a mesh-identity answer forgets those dwells. A
  confirmation's failed-over answer can be the round trip that starts the
  breach, and the guard saw only episodes already open, which also
  let a sweep read failing over during a dwell through. REMEDY's confounded
  row now leads with `credited to neither arm` and says `during or just
  before the episode`.
- The symptom card shows the newest round trips, after the baseline.
- Known cost: slow frames that never land in consecutive pairs are never
  corroborated, strict alternation being the extreme (0.77.3 fired at
  5 minutes). While no probe can go out to a node that could take one (the
  pause, a post-kill hold, a runner suppression, bursts filling every
  verification slot for 10 minutes), a node addressed less than twice in
  10 minutes does not report a slowdown. An answer within 0.2 ms of the
  rounded average does not move it, counts as unanswered, and the node's
  next transmission decides. After a normal answer the average can stay over
  the line until transmissions to the node (its automations, polls or a
  liveness sweep) bring it under, and the node's
  learning stays held until then: one to several 2-hour sweeps on a node
  nothing else addresses, where 0.77.3's false episode cleared it in minutes
  with 10 probes.

### Replay

- A tick-level port of the rule over the 13.1-day archive, the
  confirmation's answer proxied by the frames the node produced next:
  restart-seed episodes 0 of 9 fire, with no probe; one-frame episodes 0 of
  14 fire, with 11–12 confirmations; real slowdowns 5–6 of 7 fire (by the
  normal assumed), 30–40 s later than 0.77.3, with 8 confirmations. The two
  that may not sat at 50–58 ms against a 57–58 ms line, and one of them was
  caught 33 minutes later at 9.6k. Inside the 30 episodes, 11–12
  confirmations replace the 140 burst probes 0.77.3 spent on one-frame
  episodes, and real slowdowns add 8; elsewhere, 0.3–5.3 confirmations a day.
- 31 new tests; 99 new mutation entries, 7 re-anchored.

## 0.77.3

The RTT restart allowance now survives a deploy, and the RTT baseline's
restart hold judges a re-routed node against its own readings.

### Fixed — the restart seed across an add-on restart

- v0.77.1 kept each node's first fresh RTT reading of a driver lifetime, the
  seed the restart allowance is measured from, in memory only. After every
  add-on restart the next fresh reading became the seed, so its excess over
  the node's median counted as restart. The 2 s ceiling caps that once the
  driver has made about 20 transmissions to the node, but on a quiet mesh
  that takes hours, and until then a slowdown first measured on that reading
  was masked and fired from a later one, about one liveness sweep (~2 h)
  later on a sweep-only node. The v0.77.1 comments and DOCS said the ceiling
  always capped it; the morning after a host restart on the reference mesh
  the re-taken seed was the smaller bound on 37 of 38 nodes.
- The evidence store now saves each node's seed with the counters of its
  newest sample, and carries the seeds over an add-on restart while the
  driver can still be the one that measured them: the host is on the same
  boot (told by when the boot began, which a clock restored behind the save
  cannot fake), the save is under an hour old, and no node's first sample
  after the restart has a counter below its saved one. One driver keeps every
  node's counters, so a single node showing a new driver drops every carried
  seed. A seed that cannot be carried is re-taken from the next fresh
  reading, as before.

### Fixed — the RTT baseline's restart hold

- A route change empties a node's RTT bands, and an empty band's median reads
  0, so the hold counted a re-routed node's whole round trip as restart and
  kept normal readings out of the new band (four of 38 nodes on 10-28). With
  no learned median the seed is now measured against what the driver
  averaged after it, `(rtt − 0.75^(k − k0) × a0) / (1 − 0.75^(k − k0))`: a
  normal seed holds nothing past its own reading, and a large one is held
  while it washes out. An empty band is never ready, so no alarm changes.
- DETAIL's *RTT learning is PAUSED* showed on every node within ~21
  transmissions of a driver restart after each add-on restart (38 of 38 on
  10-28), though nothing was held until the next fresh reading. It now
  reports the verdict on the node's newest RTT reading, for as long as the
  driver lifetime it was judged in lasts.
- The hold judges a reading at the transmission count it was recorded with.
  The roster's copy, polled apart from the statistics feed, could trail it,
  and at the trailing count the 2 s ceiling held a reading the seed allowed.
- A tick on which the settle rule deferred a node folded that node's previous
  sample into its baselines a second time. Each sample is now folded once.

Tests pin these — the seed carried over a restart and not over a host
restart (also with a clock restored behind the save), an hour-old save or
the boot grace, any node's lower counter
dropping every carried seed (taken up or not, and after a live restart), a
carried seed kept through a save before its node samples, a reset, reload
or eviction forgetting it, the fold's yardstick for a band with a median and
for an empty one (a steady node, a washing-out seed, the seed reading
itself), the banner's set, standing, cleared and lapsed verdicts, one fold
per sample, and the recorded count — and 28 new mutants (eight existing ones
re-anchored) show each guard is load-bearing.

## 0.77.2

### Security — dependency updates

- `fastify` 5.12.5 → 5.12.7: a route's headers schema could be bypassed
  through a case-sensitive `propertyNames` keyword.
- `fast-uri` 3.1.8 → 3.1.9 and 4.2.1 → 4.2.3, both reached through the HTTP
  server's schema compilers: scheme spoofing through a percent-encoded scheme,
  host confusion through unchecked WHATWG host canonicalisation, scheme
  injection through an unescaped colon in a reference's first segment, and
  path equivalence in relative-reference normalisation.

No route in the add-on declares a validation or response schema, so none of
these paths is reached. No code change. `npm audit` reports no
vulnerabilities in production dependencies.

## 0.77.1

`rtt-degraded` no longer fires on the round-trip average a Z-Wave JS restart
leaves behind.

### Fixed — `rtt-degraded` after a driver restart

- zwave-js keeps each node's round-trip time as a running average, in memory
  only. A restart seeds it with one measurement from the restart's own burst,
  and every later acknowledged transmission keeps 0.75 of it. On the reference
  mesh most nodes' first reading after a restart was normal, but a few read up
  to about 1.4 s against a 20–60 ms normal, and on quiet nodes that took
  6–12 h to wash out. Every fresh statistics event from such a node re-tripped
  `rtt-degraded`: nine 5–8 min symptoms in the 5 h after the 10-24 restart,
  against 1–7 symptom onsets a day before.
- The detector now subtracts what the restart can still be adding before its
  usual test: the smaller of a fixed ceiling,
  `0.75^(commandsTX − 1) × (2 s − median)`, and the exact share of the first
  fresh reading the add-on saw after the restart,
  `0.75^(commandsTX − k0) × (a0 − median)`. A node whose first reading was
  normal is back at full sensitivity within a few transmissions; a slowdown
  measured after a large seed still fires, with a `restart allowance`
  evidence row. A node with no transmission yet in the new lifetime gets no
  allowance.
- The RTT baseline no longer learns a reading the restart can still move by
  more than 8 ms, by the same bound. Until now those readings were kept out
  only while they tripped `rtt-degraded`. DETAIL says when this pauses RTT
  learning: *RTT learning is PAUSED — the driver restarted N tx ago*.

Tests pin these — the seed's exact weight, no allowance before the first
transmission, the first reading's bound and its cap, a seed-sized reading that
neither fires nor arms, a normal first reading that restores full sensitivity,
new excess under a large seed that still fires, the allowance subtracted to
the millisecond, the store keeping each lifetime's first fresh reading, and
the baseline holding out the RTT reading on a copy, against the band's own
median, and nothing else — and 33 new mutants (one existing mutant
re-anchored) show each guard is load-bearing.

Two older checks a mutant slipped past are tightened: the auto-ping wiring
check reads only auto-ping's own options (the refresh trial's copy has its
own check and mutant), and zero samples must show the fresh share as a bare
dash.

### Documented

- The README's verification figures are corrected: 1,632 tests, and 1,487
  mutants in the harness, 13 of them labelled equivalent.

## 0.77.0

The LAN terminal is SSH: telnet is removed.

### Changed — SSH replaces telnet on port 2324

- The full-screen TUI is served over SSH on the same port, 2324, so nothing
  changes on the LAN side: `ssh -p 2324 <user>@<host>`. Telnet sent the login
  and everything on screen in clear text.
- Logins are password only, using the login gate's existing users
  (`auth_enabled`, `users`) and its per-address backoff after
  `auth_max_attempts`. With the gate off, or no user configured, every login is
  refused, and the add-on log says why. Usernames and passwords are never
  logged.
- The host key (ed25519) is generated on first start in `/data` and kept; its
  fingerprint is on the startup log line, to compare with what `ssh` shows on
  the first connection.
- Each connection gets one terminal. The window size comes from the SSH client
  and follows resizes; exec and subsystems (sftp) are refused. The connection
  caps (16, 4 per address), keep-alive and the 30-minute idle reclaim carry
  over.
- The option `telnet_enabled` is now `ssh_enabled` (on by default).
- The sidebar console is unchanged.

## 0.76.1

Follow-ups from a 6.35 h trial of the Z-Wave JS driver at `verbose`: the driver
log lane is visible to automations, the long-term evidence says when S2 was
blind, and the engine sensor no longer reads 0 of 0 at boot.

### Added — the driver log lane on the engine sensor

- `sensor.zwave_tui_engine` gains `driver_log_level`, `s2_lane` (`live`,
  `pending`, `storm-paused`, `silent`, `refused`, `level`, `down`, `disabled`)
  and `silence_watchdog` (`armed`, `disarmed`). `/api/health` carries them
  too. Until now the lane's state was shown only on the login-gated ENGINE
  screen.
- The silence watchdog writes one add-on log line when it arms or disarms. It
  arms only while `verbose` lines arrive, and arming wrote nothing, so whether
  it had armed could not be shown.

### Added — long-term evidence counts the S2 samples it could see

- Each 30-min evidence bucket now counts its known S2 samples (`s2N`) beside
  the resync sum, so 0 resyncs over 0 known samples reads blind rather than
  clean once the 40-min fine ring has rolled over. A bucket saved before
  0.76.1 reads unknown.

### Fixed — the engine sensor at boot

- Nothing is published to Home Assistant before the first roster load. With
  no node loaded every count was 0, and the engine sensor read "0 unmeasured
  of 0" for about 30 s at each start.

### Documented — what `verbose` costs here

- The cost is the host journal, not the archive. The Z-Wave JS app writes
  every driver entry to the journal, which is capped at 500 MB. The trial
  measured about 5,600 more journal data objects an hour at `verbose`, which
  would leave permanent `verbose` about 4 h above a 36 h journal floor on a
  typical day. `info` stays the permanent level; `verbose` is set at runtime
  for bounded investigations.
- The archive at `verbose` is about 3.3 MB a day raw and 181–195 KB gzipped.
- The storm guard counts driver entries, not printed lines: the nightly NVM
  backup was 1,335 entries (5,271 lines) in its busiest 60 s, 44.5 % of the
  limit. Restart, re-interview, heal, inclusion and reconnect bursts are
  still unmeasured at `verbose`.

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
