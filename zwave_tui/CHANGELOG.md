# Changelog

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
- A burst carrying `debug` or `silly` lines takes the full hour at once. A
  reported change to a quieter level resumes early; a louder one never does.
- Lines that arrive while paused are counted, never matched or archived. S2
  samples read unknown, and ENGINE shows `S2 lane storm-paused` with the time it
  resumes.
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
  event. Once lines at `verbose` or finer have arrived, ten minutes without one
  re-subscribes once, and the lane reads `silent` until a line arrives. It is
  never armed at `info`, where a long silence is normal.
- A node the driver log's node filter leaves out records unknown S2, not 0.

### Changed — the S2 count does not move when the driver logs at verbose

- `s2-desync` counted two families. The incoming one ("cannot decode command")
  streams only at `verbose` and finer, after each driver restart and for every
  out-of-step inbound frame, so raising the level would have raised the count
  against the same absolute threshold and read as a new S2 fault. The detector
  now counts the outgoing retry alone, at every level. History and the evidence
  file keep their meaning; the incoming lines stay in the archive.
- An S2 sample counts only when the lane was watched since before its window
  began, so a window that spans a pause, a re-subscribe or a reconnect reads
  unknown instead of a partial count.
- A 30-min window the lane could not see holds an armed or matured
  `s2-desync` instead of clearing it, for up to one more window.

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
  it cannot parse a frame, and a raw `payload:` or `event parameters:` value,
  get the same cut. The live archive held none of these.
- Every gap in the driver stream is marked with an `[archive]` line: the
  subscription and the level, each pause and resume, a silence re-subscribe, a
  level change, a refusal, the end.

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

## 0.75.2

### Fixed — every noise floor uses one rule for what a reading is

Five places decided whether a background-RSSI value counts toward the noise
floor, and they disagreed. The screens' floor and its "measured" tag, the
Interference floor and the persisted trend kept any negative value; the
weak-signal detector dropped values at or below −120 dBm per channel; the health
score took the screens' floor and fell back to −95 only when that floor itself
was at or below −120; and the detector's "measured" flag only asked whether a
driver sample existed at all. zwave-js stands −128 dBm in for "no signal
detected", so with every channel at that value the screens read
`-128 dBm (measured)`, the health score used −95, and weak-signal labelled its
−95 fallback `measured`. With channels `[-128, -104, -101, -93]` the screens
used −102.5 and the detectors −101.

- `health.ts` now holds the rule: `noiseReading` — finite, negative (0 is the
  driver's "no value yet" seed and its stand-in for saturation) and above
  `NOISE_FLOOR_MIN_DBM = -120` — and `medianNoiseFloor`, the median of the
  readings in the leading run of channels. The screens, the health score, the
  detectors, Interference and the persisted trend all take their floor from it.
- "Measured" now means the floor came from a reading, everywhere: the screens'
  tag, and weak-signal's `basis` and its `(vs assumed −95 floor)` evidence. The
  detectors no longer take a separate `hasRealNoise` from the data layer.
- Interference distinguishes a connected driver with no reading
  (`median — no reading`, naming the stand-ins, whole at 80 columns) from no
  connection at all; it had said the client was not connected.
- Coarse noise-trend buckets folded under the old rule with a stand-in in them
  are dropped on load — a folded sum cannot be un-folded — rather than shown as
  `quietest -128 dBm` beside a live floor that excludes it.
- No change on the reference controller: its four channels read −105 to −94
  dBm, all readings by both the old rules and the new one.

## 0.75.1

### Changed — the live-span count names its nodes

ENGINE's `live ≥10m: a/b scored` bit — the revisit condition of DESIGN §3.5 —
counts episodes, not nodes, and one chronic node whose episode re-arms every
half hour can supply most of it: on the reference mesh one node made 8 of 12
new closures, and the count read past its threshold on the strength of it.

- The ledger's live-span ring now keeps the scored closures live ≥ 10 minutes
  per node, per day, persisted with the ring and aged out with it.
- The count moves to its own row (before the first attributed closure too) and
  names them in the same breath:
  `live ≥10m: 37/45 scored since 09-12 from 4 nodes (node 23: 22)` — how many
  nodes, and the one with the most when it has more than one. Of four forms,
  the longest that fits the width is shown, and every one keeps `from k nodes`,
  so neither the count nor its nodes is ever dropped, down to the narrowest
  session width of 60 columns.
- Per-node counts begin with this release. Until they cover every closure in
  the 30-day window, the bit says how many they cover and since when, to the
  minute of the first closure it attributed
  (`… · 5 since 10-12 14:03 from 2 nodes (node 23: 4)`); with no recorded
  start none is guessed. A day from an older ledger file loads without them; a
  malformed list is ignored, never fatal.

### Fixed — background RSSI outside what a radio can report

- `cleanDbm` had no lower bound. RSSI is a signed byte on the wire (zwave-js
  `parseRSSI`), so a background-RSSI value below -128 dBm now reads as nothing
  rather than as a noise floor.
- An `average` of exactly 0 beside a `current` of NotAvailable is zwave-js's
  "no value yet" seed (`averageRSSI`), not a 0 dBm floor. A trailing run of such
  channels — a long-range channel the controller does not report — is now
  absent and shows `—`, where Controller had drawn a red full-noise gauge. An
  interior one keeps its 0, so the real channels after it survive, and every
  floor already ignores it. A saturated receiver also averages as 0 dBm, but
  its `current` says so (126), and that 0 still shows as a reading.
- Known limitation, documented in DOCS: after a "not available" first poll the
  driver's average decays from that 0 seed over about twenty polls, and those
  negative readings still reach the floor.
- Preventive: the reference controller's four channels read -105 to -94 dBm
  throughout a 13.7-day history, with no value at or above -98 dBm in its
  30-minute tier.

### Docs — an ENGINE screenshot

The Engine screen had no screenshot. The generator now renders one from the
synthetic demo mesh — auto-ping, the refresh trial mid-run with its eligible
nodes, the live ledger, and LEARNED with the live-span count naming its nodes —
and the README gallery shows it. The other ten frames regenerate unchanged.

## 0.75.0

### Added — the pre-registered refresh trial (off by default)

No verb passes the admission rule, and DESIGN §3.5 pre-registered the only
path by which one ever could: a randomized trial with one verdict. This release
builds it for the one candidate kind whose live span supports it,
`refreshValues` on `rtt-degraded` episodes, behind a new option,
`refresh_trial_enabled` (default off). It also needs write actions and auto-ping
running unsuppressed, and the owner's pause stops it at once. Running it admits
nothing: `AutoVerb` stays `never` and refresh keeps all three failure rows.

- **Only nodes whose refresh adds something.** The revisit condition's second
  half — the verb must differ from what the verification lane already sends —
  is checked per node. zwave-js's refresh queries every actuator and sensor CC
  instance; the verification probe sends one Get on the node's switch/light
  value. A node is eligible only when its refresh sends at least two Gets (one,
  if the probe can only ping it), counted from the driver's state dump. On a
  mesh of plain switches and dimmers no node qualifies, ENGINE says
  `eligible nodes: 0 of N mains`, and the trial sends nothing; after 120 days it
  retires as not measurable here.
- **One decision per eligible episode, every limit before the coin.** A live
  `rtt-degraded` episode on a mains node that is Alive, unconfounded, with
  nothing yet acted on it, live 10 minutes from its dwell start and with a
  before-window that can be scored, is eligible — at most one decision per node
  per 24 h, 2 per hour, 6 per day, 09:00–20:00 local, one in flight until filed,
  never while an operator action runs or within 10 minutes of one. A fair coin
  then decides between one `zwave_js/refresh_node_values` and nothing. The
  assignment is written to `/data/refresh_trial.json` before anything is sent.
- **Scored at a fixed horizon, the same in both arms.** The before-window is
  the episode's, frozen at the decision; both arms get a verification burst at
  +20 minutes; the round trips of +20–30 minutes are scored against it by the
  ledger's own rule and the decision is filed at +30. The detector's closure is
  not used, because when an episode closes depends on traffic and the treatment
  supplies traffic. A pause, a route rebuild or an operator action on the node
  (or the whole mesh) inside the window makes a decision unscoreable, as does a
  stall of more than 2 minutes in the engine's tick inside it; one in flight
  across a restart, or whose node leaves, files as lost.
- **Apart from the ledger.** The send carries a new origin, `trial`, through a
  handle holding that one call, refused at send time when paused, when the
  node is not Alive, or while the Home Assistant socket is not authenticated. Trial episodes file into no ledger arm, the send confounds
  every other episode open on the node, and the trial keeps its own undecayed
  counts.
- **Harm, kills and the latch.** A death within 30 minutes of the decision is
  harm in either arm. A death within 5 minutes of a send that may have left
  excludes the node for 7 days, even if a restart in between filed the decision
  as lost; a second within 7 days latches the trial off and raises
  `binary_sensor.zwave_tui_degraded` until the add-on starts with the option
  off. An unreadable trial file latches too, and is never overwritten; a kill
  that cannot be saved latches the run until it is.
- **One verdict**, when both arms reach 30 scoreable decisions, on the first 30
  of each: pass only if the treated success rate's Wilson lower bound is at
  least the held rate + 5 points and treated deaths are at most held deaths + 1.
  Nothing more is sent after it.
- **Where it shows:** a REFRESH TRIAL block on ENGINE (state, why it is waiting,
  the eligible-node count, counts per arm), `refresh_trial` and six counts on
  `sensor.zwave_tui_engine`, and every decision, filing, death, kill, latch and
  verdict in the Log screen and the container log. DOCS §11.14 describes it in
  full; DESIGN §3.5 records where the build sharpens the protocol.

35 tests and 64 mutants pin the protocol, its isolation from the ledger and its
wiring.

## 0.74.4

### Changed — a narrower AppArmor profile, and the server says which one runs

The add-on's AppArmor profile was a blanket grant with a per-path allow list
under it, and a blanket `file,` rule made that list grant nothing. It now
narrows access the way that works under `file,`: with deny rules.

- **Capabilities** are an exact allow list: chown, dac_override, fowner,
  fsetid, kill, setgid, setuid. `dac_read_search`, `sys_chroot` and
  `net_bind_service` are gone (both listeners use unprivileged ports), and
  `net_raw`, `setfcap` and the rest of the dangerous set are refused with an
  audit record.
- **Shipped code is write-locked** for the container's lifetime with `audit
  deny … wl` on `/init`, `/bin`, `/sbin`, `/lib`, `/usr` and `/app`: no
  writes, creates, renames, chmod, chown or hardlinks, even for root. Reading
  and executing are unchanged; the stores in `/data`, tsx's cache in `/tmp`
  and s6's `/run` stay writable, and the PID1 trees are left alone.
- **ptrace** denies only `trace`; the old bare `deny ptrace` also took away
  the read that docker-exec diagnostics use, silently. The redundant per-path
  allow list is gone.
- The header now documents how the Supervisor loads the profile (it renames
  the profile to the add-on's slug; the old "must be `addon_<slug>`" warning
  was wrong), how to validate it with a fresh compile, and how to boot-test it
  against the host's parser before a release.

At startup the server reads the AppArmor label it runs under and logs it
(`security: AppArmor local_zwave_tui (enforce)`), or logs a WARNING when the
profile is not in force: a profile the host parser rejects is otherwise not
reported anywhere.

A CI job compiles the profile on every change. Nine tests pin the label reader
and the profile's invariants: the three blanket grants, the capability list,
the `wl` write-locks, no `wal` mask, no deny on the PID1 trees, `/run`, `/tmp`
or `/data`, and the ptrace rule.

## 0.74.3

### Fixed — rtt verdicts no longer reward traffic

zwave-js keeps a node's `rtt` as a running average (`0.75 × rtt + 0.25 × new`,
once per acknowledged transmission). The ledger scored rtt-degraded episodes on
medians of that average, which forgets a slow command faster the more commands
follow it. Episodes "improved" partly because of how often the node was probed,
and an action that sends many reads, such as a value refresh, would have looked
effective for its traffic alone, the effect a trial of that action would have
measured.

- Each sample now gives the mean raw round trip of the transmissions since the
  previous sample, recovered from the average and the transmit count: `(rtt −
  0.75^k × rtt_prev) / (1 − 0.75^k)` with `k = dTx`.
- A sample with no new transmission adds nothing; before, it counted the same
  average again. An estimate the counters contradict is dropped.
- rtt-degraded tallies learned before this release, in the control arm and in
  each action's arm, were scored on the average and decay out with use.

Two tests and five mutants pin the estimator, its seed and the carry-forward.

## 0.74.2

### Fixed — a lowercase z did not pause

ENGINE's pause key matched only an uppercase `Z`, so a plain `z` did nothing,
although the key exists to be reached for in a hurry and other keys (`a`, `q`)
take either case. It now takes both. Pausing still asks nothing and sends
nothing; resuming stays behind Controller 3 → A and the typed CONFIRM.

One new test and one new mutant pin it; three mutants anchored on the handler
are re-pointed.

## 0.74.1

### Fixed — no share rounds into a claim

DETAIL rounded every share with plain rounding. One unanswered probe in 475
read "474/475 answered (100%)", and 748 fresh samples of 638,906 read "0%".
A shared rule now prints "100%" only when every one counted and "0%" only when
none did; a share that rounds to either end reads ">99%" or "<1%". It applies
to the Probes, Samples and Frame rows, and the same screen's Windows row
already used "<1%". A test that had pinned "999/1000 (100%)" now expects ">99%".

### Fixed — the console's connection label covered the command bar

The web console's "connected" label is fixed over the terminal's last row,
which is the command bar. On ENGINE it covered `[Z] PAUSE`, the key that stops
every autonomous write. It now leaves two seconds after the link is up, and
comes back while the link is down.

### Fixed — ENGINE names every kind it does not score

`missed-report` and `repeated-frames` open no ledger episode, but only
`node-down` had a "not scored by design" row on ENGINE, so the other two were
absent without a word. Each now has a row with its own reason, and the ledger's
reason sentence (shared with REMEDY) covers both.

### Changed — dependency updates

The server dependency updates merged after 0.74.0 (`@fastify/websocket`
11.3.1, `tsx` and two others) ship in this release.

5 new tests and 8 new mutants pin these.

## 0.74.0

### Added — `repeated-frames`: a link that works one way is no longer invisible

A node that does not hear the controller's acknowledgement sends the same frame
again, and the driver drops each S2 copy as a duplicate. On the reference mesh
one dimmer, switched by an automation, repeated one reply 20 times in a minute.
The only trace was a driver log line no surface read.

- The driver-WS client now matches that log line in the stream it already
  receives, and keeps only the node id and the time.
- A burst is 5 or more drops from one node within a minute. The new symptom kind
  `repeated-frames` (watch) fires after the dwell while the node has had two
  bursts in 24 hours, or one of 15 or more, and never on a Dead node.
- Over two measured days that flagged one node. Four other nodes, each with one
  burst of 5–13, were not flagged.
- The plan leads with the physical path, with a direct-link card for a
  Long-Range node. A route rebuild is offered only blocked, because it helps
  only after the path changed, and it deletes priority routes (RESEARCH §4.1).
- It opens no ledger episode: a 24-hour count cannot be scored per sample, and
  an episode would queue verification reads to the node whose link is failing.
- When the driver's log lane is dark, ENGINE says that s2-desync and
  repeated-frames detection are both off.

Drop times are kept in memory only, so a restart starts the count again. The
symptom holds while its bursts stay inside the 24-hour lookback.

5 new tests and 12 new mutants pin these. They cover the hop from the driver's
log line to the bursts accessor, the detector reading that record inside
zwaveData, the episode skip, and the Long-Range card.

## 0.73.4

### Fixed — a FLiRS device read as "unknown"

At the schema this add-on negotiates, zwave-js-server sends a node's FLiRS
flag as its wake-up period (`false`, `"250ms"` or `"1000ms"`), not as a
boolean. The client mapped the string forms to "unknown", so no FLiRS device
was ever recognised as one. The string forms now read as FLiRS.

### Fixed — the missed-report watch no longer clears a symptom with no report

- The one-interval radio-off allowance widened a threshold even when the
  radio-off, a log-stream storm stop or a driver-WS reconnect came after that
  threshold had been crossed. A missed slot on a dead device could then be
  logged `missed-report cleared`, or fall from `warn` to `watch`, with no report
  from the device. A raised severity now holds until the node reports again or
  its declared interval changes.
- A node whose sleep flags are not known yet (before the first driver dump) is
  no longer counted as a sleeper or listed on the SLEEPERS row.
- The narrative names both reasons an extra interval may be allowed. The plan
  card no longer says a sleeping device cannot be asked to report: a FLiRS
  device can be reached at any time.

### Corrected

DOCS §1.2 lists the events the driver-WS client now reads. §7.2.3 counts 16
kinds and lists `missed-report`. The SLEEPERS row is described as naming the
unwatched sleepers that fit the width.

2 new tests and 4 new mutants pin these, with one assertion inverted (unknown
flags are not a sleeper), one test that passed for the wrong reason tightened,
and the production-hop test now carrying the radio-off evidence and a dropped
link.

## 0.73.3

### Security — dependency updates

- `fastify` 5.12.3 → 5.12.5: a Denial of Service through an unhandled
  exception on HTTP/2 trailer responses (the add-on serves HTTP/1).
- `fast-uri` 3.1.7 → 3.1.8 and 4.1.4 → 4.2.1, both reached through the HTTP
  server's schema compilers: inconsistent host case normalisation, and mailto
  header injection, through percent-encoded input.

No code change. `npm audit` reports no vulnerabilities in production
dependencies.

## 0.73.2

### Fixed — a SmartStart provisioning entry was read as a node

Home Assistant lists a device that is provisioned for SmartStart but not yet
included as a `zwave_js` device identified `provision_<DSK>`. The registry join
split every identifier on `-` and took the second block as the node id, so a
provisioned thermostat became "node 40489": the join counted 40 nodes, and the
node-status and statistics subscriptions for it failed as `not_found`. Only an
identifier of the form `<home_id>-<node_id>` (optionally followed by `-…`),
with a node id from 1 to 4000, now names a node.

One new test pins it and two new mutants show both halves are load-bearing.

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
