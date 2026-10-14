# Security Policy

The **Z-Wave TUI** is a Home Assistant add-on that monitors and (with an
explicit opt-in) issues type-confirmed actions against a Z-Wave JS mesh — mesh
maintenance, plus (v0.23) operator **device control** (turning devices on/off,
locking/unlocking, opening/closing) and **configuration writes**. It handles no
personal data and moves no money, but it can read the state of a home's Z-Wave
devices and — when write actions are enabled — actuate them and mutate the mesh,
so its access is treated as privileged.

## Supported versions

Only the **latest released version** is supported. Update to the current release
before reporting an issue.

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private vulnerability
reporting — open the repository's [**Security → Report a vulnerability**](https://github.com/tesseractAZ/zwave/security/advisories/new)
form. Do **not** open a public issue for a security matter.

Include the add-on version, a description, and a reproduction if you have one.
This is a small, single-maintainer hobby project: there is no bug-bounty and no
SLA, and reports are handled on a best-effort basis — but they are read and taken
seriously.

## Security posture (what the add-on already does)

- **Read-only by default.** `write_actions_enabled` defaults **off** — a fresh
  install is a pure monitor and exposes no mutating control.
- **Every mutating action is human-gated.** When write actions are enabled, each
  one — mesh maintenance (ping / refresh / re-interview / rebuild-routes /
  remove-failed), device control (on/off/toggle, open/close, lock/unlock), and
  config writes — still requires the operator to type the literal word
  **CONFIRM**, whether it was chosen from the Actions Menu or armed by a shortcut
  key (`i` re-interview, `h` rebuild one device's routes, `x` remove failed, `R`
  rebuild all). Only the bare `p` ping shortcut runs at once — and `Z` (or `z`)
  on ENGINE, which pauses automatic writes and sends nothing.
  Device control and config writes are operator-initiated only.
- **The engine recommends; two narrow paths act on their own, both opt-in.** The
  engine is advisory by default: it diagnoses, and what it proposes waits for a
  person. The first exception is **auto-ping**, which is *double*-gated —
  `auto_ping_enabled` defaults **off** *and* it independently obeys
  `write_actions_enabled`, so both must be turned on deliberately before it can
  do anything. With both on, a **mains-powered** node still Dead after the dwell
  (`auto_ping_after_min`, skipped when the node went Dead with one of the add-on's
  own sweep or verification probes to it unanswered) is probed with no keypress,
  as is every non-Dead mains-powered node once per `auto_ping_stale_min` (the
  liveness sweep) and a node an open outcome episode needs a verification
  reading from. Two frames can go out this way: Home
  Assistant's ping (the dead-node ladder), and one `zwave_js.refresh_value`
  routed read — a single Get on the node's own switch/light value — which
  follows an unanswered ladder ping (v0.70.0) and is what the liveness sweep and
  the verification probes send (v0.71.0). Those two lanes fall back to the ping
  for a node with no switch/light value to read, or for 30 minutes after its read
  could not be sent. Both transmit, so this is a genuine
  automatic path and is named here as one. Neither commands a device, but they
  have three effects (DOCS §11): a Report that corrects a stale Home Assistant
  state is a state change automations react to; a read that fails over leaves
  the controller on the route that worked; and a device that misses a frame is
  marked Dead, and the driver rejects every command queued to it at that moment.
  It is bounded: `auto_ping_max_attempts` per outage on a widening backoff, a
  15-minute hold after a node is revived from a death on its own probe, and
  suppressed during storms, route rebuilds (whole network, or one device the
  operator is rebuilding or removing), the first 5 minutes after a start (the
  dead-node ladder waits only until the roster is ready), while the controller
  reports its radio off (the nightly NVM backup), and while it is paused.
  Apart from the refresh trial below, nothing else — a full value refresh,
  re-interview, rebuild-routes, remove-failed, device control, config writes —
  has any automatic path whatsoever. Since v0.72.0 that is a decision, not a deferral: no verb passes
  the admission rule (DESIGN §3.5), the automatic set is pinned empty by the
  type checker, and the seven state-changing verbs are in a fixed
  never-automatic set no option or efficacy reading can reach.
- **The refresh trial is the second, and it is *triple*-gated (v0.75.0).**
  `refresh_trial_enabled` defaults **off**, and the trial also needs
  `write_actions_enabled` and auto-ping running with its last pass unsuppressed;
  the owner's pause stops it at once. It is the pre-registered experiment of
  DESIGN §3.5: for an eligible `rtt-degraded` episode on a mains node that is
  Alive and that nothing has acted on, a fair coin decides between one
  `zwave_js/refresh_node_values` and nothing. Only a node whose refresh sends
  more than the verification probe's one Get is eligible, so on a mesh of plain
  switches and dimmers the trial sends nothing. The send goes through a handle
  holding that one call and nothing else (origin `trial`, refused at send time
  when paused, when the node is not Alive, or while the Home Assistant socket is
  not authenticated), and the assignment is on disk
  before anything is sent. Limits: one decision per node per 24 h, 2 per hour,
  6 per day, 09:00–20:00 local, one in flight until it is filed 30 minutes
  later, never while an operator action runs or within 10 minutes of one. A node
  that goes Dead within 5 minutes of a send that may have left is excluded for
  7 days, and a second such death within 7 days latches the trial off (raising
  `binary_sensor.zwave_tui_degraded`) until the add-on is started with the
  option off; an unreadable trial file latches it too and is never overwritten.
  A refresh reads every switch, light and sensor value the node has, so like
  the routed read it can correct a stale Home Assistant state, which automations
  react to. Running it admits nothing: refresh keeps all three of its failure
  rows and the automatic set stays empty.
- **One pause stops every autonomous frame (v0.72.0).** `Z` (or `z`) on the ENGINE
  screen, or an `input_boolean.zwave_tui_pause_autonomy` helper created in Home
  Assistant, stops auto-ping's
  three lanes and the refresh trial at once, the dead-node ladder included. It fails closed — an
  unreadable pause file, or a toggle last seen pausing and not yet re-read (or
  missing from Home Assistant's state list), reads as paused. A pause set from
  the TUI is resumed there, behind the typed **CONFIRM**; one set by the toggle
  lifts only when the toggle is turned off or deleted, and a TUI resume leaves
  it in place — unless the toggle has gone missing, when the TUI resume forgets it. The
  add-on only reads the toggle; it creates and writes nothing in Home
  Assistant's configuration.
- **Two kinds of decision are answerable without write actions.**
  `write_actions_enabled` gates mesh mutations. The mesh-identity decision below
  and the pause on automatic writes mutate nothing on the mesh — they answer a
  question about the add-on's own `/data` — so they are offered in read-only
  installs too. Gating it there would leave a read-only
  monitor that swapped a stick held indefinitely: no learned state, the HA
  `degraded` flag latched on, and no reachable way to clear it. It still
  requires the typed **CONFIRM**.
- **All mesh mutations ride the Home Assistant WebSocket** (authenticated with
  the Supervisor token). The separate, unauthenticated **driver WebSocket**
  (`ws://core-zwave-js:3000`) is used **strictly read-only**, behind a closed
  four-command allowlist — `set_api_schema`, `start_listening`, and the
  log-stream pair `start_listening_logs` / `stop_listening_logs` — and is
  **never proxied or re-exposed** to the TUI, ingress, or the add-on's log. The
  one place its log lines are kept is the durable log archive (v0.75.4): local
  daily files in the add-on's own config folder, readable by whoever can read
  that folder (the SSH add-on, for instance), and **redacted before they are
  written**. Since v0.76.0 the finished, gzipped days are included in the
  add-on's Home Assistant backups (today's file is not), so they go wherever
  those backups go, encrypted when the backup is. zwave-js already masks lock user
  codes, admin codes, credentials and PINs in its own lines; the archive cuts
  them again, along with Entry Control keypad event data (which zwave-js masks
  only for Enter), DSKs, key-shaped hex strings, S2 public keys and tokens,
  including where zwave-js's 80-column wrap splits one across two lines. Raw
  Serial API frames (SERIAL entries at `debug`, and the frame dump zwave-js
  writes at `warn` when it cannot parse one) and raw `payload:` / `event
  parameters:` values are cut to their first four bytes and their length, so a
  non-secure frame's plaintext and the S0 key exchanged during an S0
  inclusion do not reach the file through them. The only 128-bit hex values
  kept are the two public S2 entropy inputs `verbose` prints (a Nonce Report's
  receiver entropy, a SPAN extension's sender EI), which travel in clear and
  reveal nothing without the network key. The archive marks each gap in the
  driver stream with an `[archive]` line.
  `log_archive_driver: false` keeps only the add-on's own log; `log_archive_days:
  0` turns the archive off. None of the four
  transmits over RF: the log pair toggles this client's own receive flag and
  nothing more. One cross-client property is worth naming rather than leaving
  implicit — zwave-js-server's log forwarder is a *single global transport*
  whose first subscriber's filter is silently applied to every other client, so
  this client subscribes with **no filter** rather than narrowing a stream the
  operator's own Z-Wave log viewer shares. What the client keeps is narrow.
  From the handshake it keeps the server's home id, cross-checked against Home
  Assistant's, and the driver and server version tags (control characters
  stripped, length capped) for its status line. From the state dump and its events it keeps the controller's
  per-channel background RSSI, each node's `lastSeen` and listening/FLiRS flags,
  and, for sleeping nodes only since v0.73.0, the one value that declares a
  node's report interval (its Wake Up interval, or a Configuration parameter
  labelled as a heartbeat). It keeps that number and nothing else. From the log
  stream it matches three line families locally: an S2 nonce resync attributed
  to a node (v0.26), the controller turning its radio off and on around the
  nightly NVM backup (v0.65.0), and, since v0.74.0, a duplicate S2 frame dropped
  from a node. A match keeps only the node id (or the radio's off/on) and the
  time. The matcher logs and stores none of the line text, and nothing new is
  sent; the archive above is the only place the text is kept. From the state
  dump and the server's `log config updated` event it also keeps the driver's
  log level (one of zwave-js's seven level names; anything else is dropped)
  and the log node filter's node ids (v0.76.0). A storm guard pauses this
  client's subscription above 3,000 lines a minute and resumes it on its own
  (5 minutes, doubling to an hour), and after verbose lines ten minutes
  without one re-subscribes once; both use the same two allowlisted commands,
  and the allowlist itself is unchanged.
- **Trust model.** Access over the Home Assistant sidebar (ingress) is already
  HA-authenticated, and the panel is **admin-only** (`panel_admin: true`) — with
  write actions on, the console can remove a failed node, rebuild every route and
  unlock a lock.
  Ingress trust is **pinned to the address `supervisor` resolves to**, resolved
  once before the server listens, so a *sibling add-on* on the same Supervisor
  bridge cannot forge it; resolution failure **fails closed**. Every session that
  is not genuine ingress — telnet, the only port published on the LAN (`ports:`
  maps 2324 alone), and any console connection from a peer other than the
  Supervisor — is gated by an optional login (`auth_enabled`, users with
  plaintext or `scrypt:` passwords; `auth_require_on_ingress` extends it to
  ingress sessions, and `auth_idle_lock_min` re-locks an idle gated session)
  with a shared per-peer backoff that survives reconnects, charged **before** the
  async verify so concurrent sessions contend for one counter. The login gate
  **fails closed** (denies) when enabled with no users configured, and a row
  with a blank password is rejected rather than becoming an account whose
  password is `""`. Telnet can also be switched off entirely
  (`telnet_enabled: false`), leaving only the console.
- **The telnet listener bounds one host.** A global 16-connection cap, a
  **per-source-IP cap of 4**, reclamation of connections that have *received*
  nothing for 30 minutes, and TCP keepalive for half-open peers. Without the
  per-IP cap and the idle reclaim, a single LAN machine could hold every slot
  indefinitely and deny the TUI to every operator. **A refused connection is
  also reclaimed** — `end()` is only a half-close, so the descriptor stayed the
  server's until the peer closed its own side, and a refused socket joins no
  connection set, meaning neither the active counter nor the idle sweep could
  see it. A peer that never closes pinned one descriptor per refusal, without
  limit, on the exact branch whose job is to shed load.
- **Input is sanitized at the boundary.** Device names and externally-sourced
  state strings — **including error text from Home Assistant, the driver and the
  device**, which reaches the frame on the action-result card and the roster's
  LINK LOST token — are stripped of control/ANSI sequences before they reach the
  terminal frame. The strip covers **C0, DEL and C1 (U+0080–U+009F)**; C1 matters
  because U+009B is an 8-bit CSI and U+009D an 8-bit OSC, and xterm.js executes
  both. Inbound console WebSocket frames are size-capped.
- **What the add-on writes to Home Assistant, and what it does not.** Besides
  mesh actions (the operator's, and auto-ping's ping and routed read), the add-on
  publishes six *diagnostic* states
  over the Core REST API — a degraded flag, a count of nodes needing attention,
  a live symptom count, the engine's own run state, a week's route failures
  ranked by link, and (v0.72.0) one recommendation naming a node, its symptom
  and the first step to try, as free text drawn from the planner. They carry
  node ids and names, counts, symptom kinds, planner text and timestamps; **no
  credentials, no device state, and nothing about the network beyond what the
  TUI already shows an authenticated operator.** A
  held mesh-identity decision raises the same `degraded` flag with the two home
  ids in its `reason` — a home id is a network identifier, not a secret, and it
  is already on the Controller screen. It writes no other entity, and it sends
  no notification: alerting policy is left to the operator's own automations
  rather than hardcoded here.
- **Every persisted measurement and learned store is bound by home id, and a
  change is ASKED, not assumed** (v0.64.0). The evidence envelope carries the
  controller's `homeId` and starts fresh on a mismatch, as it always has — it
  is a rolling measurement window that refills in hours. The three LEARNED
  stores — the outcome ledger, the per-node baselines and the history series —
  now carry the tag too, and
  behave differently on purpose: a mismatch **parks** them. Memory is wiped so
  the engine cannot act on another network's learning, saves are latched off so
  nothing overwrites the file, and the operator is asked to choose: keep the
  existing learning under the new identity (correct for an NVM backup restored
  onto replacement hardware — physically the same mesh, new id), resume this
  controller's own archived learning if it has been here before, or start fresh.
  Nothing is ever deleted: "start fresh" renames the previous network's files
  aside in `/data` as `<name>.home-<id>.json`, and an archive that cannot be
  written leaves the decision pending rather than proceeding. The pause file
  (`/data/autonomy.json`, v0.72.0) carries no home id: a pause only stops sends,
  so it holds across a controller swap.
  <br>
  The prior wording was imprecise in a way worth recording: it said a controller
  swap left the learned stores "stale rather than purged". That was true only of
  a swap performed while the add-on was STOPPED. A swap while it was RUNNING was
  already caught by an in-memory guard in `zwaveData` and did purge all three —
  but that guard is keyed on a value that starts null every boot, so it could
  never fire across a restart, which is the more likely way a stick gets
  swapped.

- **Confined by its own AppArmor profile (v0.74.4).** The Supervisor loads
  `zwave_tui/apparmor.txt` in enforce mode, and the server logs the label it
  runs under at startup (`security: AppArmor local_zwave_tui (enforce)`, or a
  WARNING when the profile is not in force). The profile keeps the blanket
  file, signal and network grants s6-overlay needs, and narrows from there:
  - **Capabilities** are an allow list (chown, dac_override, fowner, fsetid,
    kill, setgid, setuid); every other one is refused, and `net_raw`,
    `setfcap`, `sys_admin`, `sys_module`, `sys_rawio`, `sys_ptrace`,
    `net_admin`, `dac_read_search`, `bpf` and the rest of the dangerous set are
    refused with an audit record.
  - **Shipped code is write-locked** for the container's lifetime: `/init`,
    `/bin`, `/sbin`, `/lib`, `/usr` (Node itself) and `/app` (the add-on's
    TypeScript and `node_modules`) refuse writes, creates, renames, chmod,
    chown and hardlinks, even for root. Reading and executing them is
    unchanged. The add-on's own stores in `/data` stay writable.
  - **Reads refused:** `/etc/shadow` and `/etc/gshadow` (and their backups),
    `/etc/ssh`, firmware and LSM state under `/sys`; `/root` and `/home` are
    refused quietly. No execute is refused anywhere.
  - **Kernel interfaces:** no writes to `/proc/sys`, `/sys` or the sysrq
    trigger; no mount, remount, umount or pivot_root; no tracing of another
    process.
  Refusals are logged to the host's audit journal (`journalctl
  _TRANSPORT=audit` on the host), not to dmesg. A CI job compiles the profile
  on every change, and a test pins these rules.
- **Backup hooks (v0.76.0).** Around each backup of this add-on the Supervisor
  runs `/usr/bin/zwave-tui-backup-hook pre` and `post` inside the container
  (docker exec, as root, confined by the same profile, without a shell). They
  take one word from the Supervisor, plus three path variables used only by
  the tests and never set in the container's environment; they create or
  remove `/tmp/zwave-tui-backup.hold`, read `/data/options.json` to see whether
  the archive is on, append one fixed line to the day's archive file, open no
  socket, and always exit 0. The hooks add two docker exec calls to every
  backup, and an exec-level failure drops the add-on from that backup, a risk
  it did not carry before; the image build runs both once to catch a broken
  hook before release.

## Scope

In scope: the add-on server (`zwave_tui/server/`), its HTTP/console/telnet
surfaces, the action-runner and auth paths, the container definition
(`zwave_tui/Dockerfile`, `zwave_tui/config.yaml`, `zwave_tui/apparmor.txt` and
the s6 run script), and the release workflows that publish the GHCR images
installs pull. Out of scope: Home Assistant Core, the Z-Wave JS
integration and driver, the Supervisor, and the physical Z-Wave radio — report
those to their respective upstream projects.
