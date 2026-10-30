# Changelog

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
  cooldown; one it takes and then drops (a node Dead at its tick) does. It
  passes every gate a burst probe does,
  opens no episode, is withdrawn unsent when the node's own traffic answers
  first, never shortens an owed burst, drains after any burst owed on the
  same tick, and is not counted as episode evidence on DETAIL or REMEDY.
- Where no probe can reach the node (a FLiRS or battery node, or an install
  without auto-ping running), the newest round trip alone starts the breach,
  as in 0.77.3, but never after a normal one.
- An episode of a route-sensitive kind opens confounded when the add-on's own
  routed read re-routed its node during its dwell or in the detector's
  lookback before it (10 minutes; 30 for `weak-signal`, which reads that far
  on a node too quiet for a rate). The dwell counts from no earlier than five
  minutes before the symptom was first seen: a `chronic-return-path` dwell
  runs for two days, an episode re-opened on an old dwell start counts from
  the symptom's return, and one opened late behind a mesh event keeps its
  whole dwell. A confirmation's failed-over answer can be the round trip that
  starts the breach, and the guard saw only episodes already open, which also
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
- 28 new tests; 84 new mutation entries, 7 re-anchored.

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

## 0.76.0

Ready for the Z-Wave JS driver logging at `verbose`: the driver log stream
pauses and resumes on its own, the S2 count no longer depends on the log level,
the archive keeps what `verbose` adds and cuts raw frames, and finished log days
go into backups.

### Changed — the driver log stream pauses and resumes on its own

- The storm guard used to stop the log subscription until the next reconnect,
  which could be days away. The archive's driver stream and the S2,
  duplicate-frame and RF-off watches then stayed dark, silently. Above 3,000
  lines in a 60 s window it now pauses for 5 min, doubling per consecutive pause
  to an hour, and resumes on its own. A stream that runs an hour without
  tripping starts the ladder again.
- A burst carrying `debug` or `silly` lines takes the full hour at once. A pause
  is judged on the levels the lines carry, and on the reported level only when
  they carry none. A reported change to a quieter level resumes early; a louder
  one never does.
- Lines that arrive while paused are counted, never matched or archived. S2
  samples read unknown, and ENGINE shows `S2 lane storm-paused` with the time it
  resumes. A resume that meets a socket already closing leaves the pause in
  place instead of reading as a refused subscription.
- A radio-off reading taken before a pause keeps its own 2-minute deadline
  instead of being dropped, and a pause never creates one by itself. At
  `verbose` the busiest minute is likeliest inside the nightly NVM backup, the
  very blackout that gate exists for.

### Added — the driver's log level is recorded; a detached feed is noticed

- The level is read from the state dump and from the server's `log config
  updated` event and recorded on the startup line, in the archive and on each
  change. The level actually received is tracked too: the server's log
  forwarder keeps the level it started at, and Z-Wave JS UI changes the
  driver's level without an event.
- A Z-Wave JS UI debug capture detaches the server's log forwarder with no
  event. While lines at `verbose` or finer are arriving, ten minutes without
  any line re-subscribes once, and the lane reads `silent` until a line
  arrives; its watch starts again at that line. The first `info` line more
  than a minute after the last verbose one disarms it. A drop to `info` with no
  event, followed by no line at all, looks the same as a detach and costs one
  re-subscribe.
- An unresolved silence, or an armed watchdog, carries over a reconnect to the
  same network. Home Assistant keeps its log subscription after its debug
  logging is turned off, so a detached forwarder stays detached across the
  reconnect.
- A node the driver log's node filter leaves out records unknown S2, not 0, and
  an empty filter logs no node. The filter follows `log config updated`, and a
  change starts a new S2 window.
- Below `info` the outgoing S2 retry is never written: ENGINE shows
  `S2 lane level` and S2 samples read unknown, and so does the window that
  spans a return to `info`.

### Changed — the S2 count does not move when the driver logs at verbose

- `s2-desync` counted two families. The incoming one ("cannot decode command")
  streams only at `verbose` and finer, after each driver restart and for every
  out-of-step inbound frame, so raising the level would have raised the count
  against the same absolute threshold and read as a new S2 fault. The detector
  now counts the outgoing retry alone, at `info` and finer. History and the
  evidence file keep their meaning; the incoming lines stay in the archive.
- An S2 sample counts only when the lane was watched since before its window
  began, so a window that spans a pause, a re-subscribe or a reconnect reads
  unknown instead of a partial count.
- A lane that goes dark holds a matured `s2-desync` instead of clearing it,
  from the first 5-min slice it partly cannot see, for up to a whole window
  after it last breached; its episode stays open and the activity log does not
  call it cleared. An armed one is dropped. After the hold, while the window is
  still partly unseen, the symptom is judged on recency alone, so a storm still
  under way is not read as cured by a partial count.

### Fixed — log matching at verbose and finer

- Matching no longer depends on where zwave-js's 80-column cut falls; a
  production duplicate-frame line had been split mid-phrase.
- The radio watch reads only the controller's own lines, starting with the
  phrase. At `verbose` and finer a DRIVER dump or a value line could carry a
  node name into it. No miscount was possible at the stock `info` level.
- ENGINE no longer suggests raising the log level when the subscription is
  refused; the server never refuses it for its level.

### Changed — the log archive at verbose and debug

- At `verbose` the archive blanked two public S2 values as if they were keys:
  a Nonce Report's receiver entropy and a SPAN extension's sender EI. Both go
  over the air in clear, and the SPAN is derived from them together with the
  network key, so they are kept, only in place and in the form zwave-js
  writes. Every other 128-bit hex string is still replaced, and so is a
  32-byte S2 public key, which carries the DSK.
- At `debug` zwave-js logs every byte exchanged with the controller; a
  non-secure frame's payload is plaintext, a lock's user code included, and
  during an S0 inclusion the network key travels under a published temporary
  key. A SERIAL entry now keeps only its direction, its length and its first
  four bytes. The frame dump zwave-js writes at `warn` (so at `info` too) when
  it cannot parse a frame, and a raw `payload:`, `event parameters:` or
  `parameters:` value, get the same cut, wraps under the tree's gutter
  included. The controller's `[Notification]` line writes raw parameters at
  `info` for an event with no definition. The live archive held none of these.
- With the Z-Wave JS server in a development or test build, zwave-js also
  prints decrypted S0/S2 plaintext, ciphertext, IVs and auth tags; each is cut
  to its length. The official images run in production mode.
- Control characters other than tab and newline are written as U+FFFD: a
  node's name is decoded as raw bytes and could carry terminal escapes.
- Every gap in the driver stream is marked with an `[archive]` line: the
  subscription and the level, each pause and resume, a silence re-subscribe, a
  level or node-filter change, a refusal, the end.

### Changed — finished log days are backed up

- The archive's finished days (`logs/*.log.gz`) now go into the add-on's
  backups; today's file, still being written, and every temp file stay out
  (`backup_exclude: ["logs/*.log", "*.tmp"]`, was `logs/*`).
- The Supervisor copies a folder file by file, and a file renamed or deleted
  mid-copy leaves the whole add-on, `/data` included, out of that backup;
  Home Assistant 2026.10's backup screen does not report it. New
  `backup_pre`/`backup_post` hooks set and clear a hold in `/tmp`, and while it
  is fresh the archive's housekeeping compresses and deletes nothing. A hold
  60 min or more away from now is ignored and reported once.
- The hooks exit 0 on every path, record `backup started` / `backup finished`
  in the day's archive file while the archive is on, and the image build runs
  both once.
- With `log_archive_days: 0` the files the archive wrote earlier are deleted at
  start and hourly until none is left; otherwise an archive turned off would
  ride along in every later backup.
- A restore brings back the finished days up to the backup and loses
  everything logged after it.
- Expected size: an estimated 2 MB a backup with the driver at `verbose`, from
  earlier Z-Wave JS UI logs, and a few hundred KB at `info`.

### Changed — CI judges a pull request on the whole codebase

- codeql-action v4 makes a pull request's analysis "diff-informed" by default,
  keeping a result only when its source or sink sits on a changed line, so a
  PR could pass while `main`'s full scan found the same flaw. `codeql.yml`
  turns that off, and `check-sarif.mjs` refuses a SARIF marked diff-informed.
- `rotate-changelog.mjs`: a release moved under a history holding only its
  title is set off by a blank line.
- The mutation harness's `--only` takes a comma-separated list, and fails on
  any token that matches nothing.

## 0.75.5

### Fixed — the Changelog dialog in Home Assistant opens quickly

Home Assistant renders an add-on's whole `CHANGELOG.md` whenever the add-on is
up to date: one blocking markdown pass, with nothing on screen until it
finishes. At 384 KB and 140 releases that meant about 4,300 elements, and a long
wait on slower devices. The shipped changelog now keeps only the newest
releases, under 32 KiB. Everything older is in `docs/CHANGELOG-history.md` on
GitHub, linked at the end of the file, and is never shipped with the add-on.

- `.github/scripts/rotate-changelog.mjs` moves the oldest sections into the
  history until the shipped file fits. The release workflow runs it after
  adding a section, and a contract test fails CI when the files are not
  rotated or a release section goes missing from both.
- Release headings are plain `## X.Y.Z`. Home Assistant's update dialog shows
  the notes from the new release down to the installed one when the heading is
  exactly that, and falls back to the whole file otherwise. The documented
  `## X.Y.Z — DATE` form, which `release.yml` also wrote, triggered that
  fallback. Both now use the plain form, the contract test enforces it, and
  `release.yml` demotes a `## ` heading inside its notes to `###`.

## 0.75.4

### Added — a durable log archive, past the host journal

HAOS fixes the host journal at 500 MB (`SystemMaxUse=500M` in a read-only
`/etc/systemd/journald.conf`, with no persisted drop-in), and the busiest writer
on the host decides how far back it reaches: about 41 h on the reference host,
so a review more than a day and a half after the last one loses the gap. The
add-on now keeps its own:

- Every line it logs, and the Z-Wave JS driver's log stream at the driver's own
  level, in daily files in its config folder (`/addon_configs/<slug>/logs` on
  the host, readable over SSH without docker), each line stamped with its UTC
  time. The boot sequence is included, shutdown flushes, and the fatal path
  writes synchronously.
- `log_archive_days` (default 14, `0` = off), `log_archive_max_mb` (default
  200; the oldest whole files go first, today's never) and `log_archive_driver`
  (default on). Finished days are gzipped; the folder is excluded from backups.
- Redacted before anything is written. zwave-js already masks lock user
  codes, admin codes, credentials and PINs in its own lines and skips value
  changes it marks secret; the archive redacts again, for whatever a driver
  version or a line shape lets through. Everything after a user code, admin
  code, credential or admin PIN property is cut. An Entry Control
  notification loses its event data: zwave-js masks it only for Enter and
  cached keys, and a keypad can send the typed PIN with arm and disarm.
  SmartStart DSKs, key-shaped hex strings, JWTs and bearer tokens are
  replaced. zwave-js cuts its text at 80 columns mid-token, so each pattern is
  also matched across those wraps.
- A write that fails part-way resumes at the byte where it stopped, so nothing
  is written twice. Unwritten lines are held one by one (oldest dropped first
  past 1 MiB a stream), the failure is reported once per 10 minutes, and the
  first write that succeeds records exactly how many lines were dropped. A
  removed folder is recreated.
- An uncaught throw or rejection files its stack and writes what is buffered
  before Node exits as before; the shutdown and fatal paths write synchronously
  what a flush had taken but not yet written.
- A line held through a failing write past midnight joins the day already
  compressed as one more gzip member, and a compression a crash interrupted is
  cleared. A file dated after today (a clock that ran ahead) cannot age out, so
  the size cap reaches it last instead of never.
- A restore of the add-on from a backup replaces its config folder, so the
  archive starts empty again.

### Changed — a failed TUI login names the account only when it is one

`auth: login FAILED for "<user>"` logged whatever was typed into the username
field, including a password typed there by mistake, and the archive now keeps
that line for days. A username that is not configured is logged as
`an unknown username`; a configured one is still named.

The driver stream had never been stored; SECURITY and DOCS now say where it is
kept and how it is redacted.

### Changed — CodeQL on Ubuntu 26.04 too

CodeQL's published system requirements still list Ubuntu 22.04 and 24.04 only,
but its analysis runs on 26.04 — this release's own run passed there — so it
moves with every other job. The required check fails closed if a later release
stops working.

### Housekeeping

Four Dependabot updates merged after a fresh run on 26.04: the fastify
plugin/type patch group, `actions/setup-node` 7.1.0, `actions/upload-artifact`
7.0.2 and the CodeQL action group.

## 0.75.3

### Changed — every build and check on a pinned Ubuntu 26.04 image

`ubuntu-latest` moves to Ubuntu 26.04 in a rollout from 2026-10-19 to
2026-11-19. That would change python3, Docker, the docs job's pandoc and
LibreOffice and the AppArmor job's `apparmor_parser` under every job at once,
and could mix images within one run. The move is made deliberately instead:

- Every job in CI, Release, Tag release and Publish release runs on
  `ubuntu-26.04`; both image builds (the CI smoke build and the release images)
  run natively, aarch64 on `ubuntu-26.04-arm`.
- CodeQL stays on `ubuntu-24.04`: its system requirements list Ubuntu 22.04
  and 24.04 only.
- `test/workflowRunners.test.ts` holds the rule: every runner a pinned
  `ubuntu-YY.MM[-arm]` label, CodeQL on a listed image, everything else on
  26.04, the ARM builds native.
- A trial run passed every check on image 20260927.149.1, including the
  AppArmor profile under `apparmor_parser` 5.0.2 and the manual under pandoc
  3.7.0.2.

### Fixed — from the log review of 10-11 07:46Z to 10-13 02:04Z

- **One entry discovery and one registry join per connect.** The boot tick and
  the on-ready callback both asked the moment the socket authenticated, and
  each check set its flag only after its own reply, so every connect fetched
  the config entries and both registries twice. They now share the request in
  flight. Redundant only; present since v0.25.0.
- **An episode is not scored before its last probe settles.** A confirmation
  burst's fifth read can go out a second before the window ends; its missing
  reply reaches the evidence seconds later, so a timed-out read was scored as
  0 of 5 (node 57: `tmo=0.0%`, the read timing out 0.58 s after the verdict).
  An episode now closes only once its node's latest probe has had 30 s to land,
  waiting at most two minutes past the window, and a close that waited keeps the
  after-window's start where it was, so the burst's first read is not aged out
  at slow evidence cadences. On a timeout-scored kind the old cut could turn a
  failed recovery into `improved`.

The review found no regression from v0.75.0–v0.75.2: four clean restarts, no
add-on warning or error in 42 h, 819 probes answered but one, and the only
AppArmor denials the four deliberate probes of the v0.74.4 check.

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
