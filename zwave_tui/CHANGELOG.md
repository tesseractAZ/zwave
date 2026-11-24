# Changelog

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

## 0.79.5

A forward clock step no longer makes a real outage a 90-minute start death, a
waiting node-down dwell that ended no longer comes back after a crash restart,
and a deploy during a Z-Wave JS outage keeps the driver start. A node whose own
device changes in Home Assistant (a replacement by another product, another
product included on its freed id, or a misread hardware id) drops the old
device's dwells, evidence and baselines while the add-on keeps running, and
`/api/health` reports no conclusions before they are judged. The update from
0.79.4 carries no `driverDrop`, which 0.79.4 never wrote: a Z-Wave JS restart
in progress at the update is not read as a driver start. The schema of
`evidence.json` is otherwise unchanged, and a rollback to 0.79.4 ignores
`driverDrop`.

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

### Fixed — a node's device changed in Home Assistant while its id stayed on the roster

- `replace_failed_node` keeps the id on the roster, so the departed-node
  eviction never ran for it, and the failed device's dwells (a raised
  node-down included), evidence, baselines, readings, open episodes and the
  refresh trial's open decision stayed on the id. While the add-on keeps
  running, a registry load that shows the node's own device changed now drops
  them, with a Log line (`node N's device changed in Home Assistant …`, or
  `K in-flight episodes + node N's baselines discarded …` when episodes were
  open): its device id differs from the one the last load that listed it
  recorded, or its hardware id (`<home>-<node>-<manufacturer>:<type>:<id>`)
  does. A hardware id change alone is another product included on a freed id
  inside the 5-minute eviction dwell: Home Assistant gives it back the device
  it deleted at the exclusion. No swap: an id with no record yet (a run's
  first load, a device first seen, an id evicted since the last load), a load
  that lists no own device on the id (the record is kept), a hardware id the
  node already carried since it last left the network (the same hardware
  filed again), and more than max(2, half the mapped nodes) changing at once
  (a registry re-created: one line, nothing dropped). A replace by the same
  product is the same Home Assistant device and keeps its state, and so does
  one by a product the node already carried since it last left the network.
  After an add-on restart before that load nothing is compared, and the old
  state stays.
- A node whose interview misreads its hardware ids in poor RF is filed by
  Home Assistant under a new device, as a replacement by another product is
  (it cannot tell the two apart): that costs the node its baselines and
  evidence once for each misread value while the add-on runs, none when the
  correct read comes before the next load. The correct read that files it
  back is no swap while the add-on runs; an add-on restart between the two
  costs a second reset.
- A node's cached configuration parameters now go with any change of its
  `ready` on the roster and with a swap, also when only the hardware id
  changed (the device id Home Assistant restores kept them before), and an
  answer or a failure for a configuration fetch the cache dropped meanwhile
  (a device change, a departure, a write) is no longer stored as the node's:
  Detail and the Actions menu do not offer a replacement, from the start of
  its interview, the failed product's parameter numbers, and parameters read
  mid-interview are asked again once the node reads ready.
- After a replacement, or another product included on the freed id, the
  node's statistics and status feeds stay bound to the old node (inferred,
  below) until the next rebuild of the feeds (a Home Assistant reconnect, the
  self-heal or a re-arm): until then the new device has no statistics feed
  and its Dead/Alive crossings are not counted. Home Assistant binds each
  feed to the node object it resolved at subscribe time, and a node replaced
  or included is another object there (inferred).
- Registry loads, where a swap shows: besides each Home Assistant
  reconnection, the self-heal and a home-id change, the roster asks for one
  when a node's `ready` goes false→true (Home Assistant files the interviewed
  hardware ids then) or the node is back on the roster ready, when a poll
  succeeds after failed ones with no load since them (an entry reload), at
  the first poll that succeeds after a reconnect, whose own load can run
  before Home Assistant has set zwave_js up again (at most one more load per
  reconnect), once for a roster node with no record of this network, and for
  an evicted id back on the roster; a re-arm for a dead statistics feed with
  no entry reload seen asks for one too. A load the roster asks for runs in
  that poll, before the roster the engine reads is published, so a
  replacement's first reading does not log the failed device's node-down as
  cleared; on a run's first successful poll and on a home-id change the next
  poll's load serves it. The ready, failed-poll and reconnect asks are spaced
  60 s apart: one asked sooner waits for the first poll past it, and the
  engine may read the node first, as it may a replacement that reads Alive
  while still being interviewed (inferred).
- The node's own device (a `zwave_js` identifier exactly `<home>-<node>`)
  stands for the node whatever the list order. An endpoint child, or the
  orphan Home Assistant leaves when an interview reports other hardware ids
  (`<home>-<node>-…`), still maps its entities to the node, and stands for it
  only while the node's own device is not listed. Before, the last device
  listed stood for the node: its name, area and entity list, and the
  `device_id` its subscriptions, configuration parameters and actions use.
- A node's entity list (Detail's LIVE ENTITIES) is its own device's entities
  and its endpoint children's (`parent_device_id`: from Home Assistant 2026.11
  a labelled endpoint's entities are on a child device of the node's own
  device); an orphan's entities, and a child of another device's, are left
  out. Before, it held the entities of the device standing for the node alone.
- Another `zwave_js` config entry is another network, whose `<home>-<node>`
  ids name its own nodes: its devices no longer join this network's nodes (a
  device that lists no entry is kept). And once the network's home id is
  known, only its devices hold a node's slot or join an entity to a node, as a
  controller changed under the same entry leaves the old network's devices
  listed on ids the new network may reuse; while none of that home id's own
  devices is listed, every device is.

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

- 1,853 tests, 84 new; 1,942 mutation-harness entries (18 labelled
  equivalent, 1 of them new): 145 new, 1 retired with the check it covered (a
  stop cleared an open peer close), 20 re-anchored; the full harness kills
  every entry not labelled equivalent.

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

## Older releases

Earlier releases are in the full changelog history on GitHub:
[docs/CHANGELOG-history.md](https://github.com/tesseractAZ/zwave/blob/main/docs/CHANGELOG-history.md)
