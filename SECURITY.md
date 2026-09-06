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
  config writes — still requires the operator to open the Actions Menu and type
  the literal word **CONFIRM** (only a bare `p` ping shortcut is immediate).
  Device control and config writes are operator-initiated only.
- **The engine recommends; exactly one narrow path acts on its own.** The engine
  is advisory by default: it diagnoses, and what it proposes waits for a person.
  The single exception is **auto-ping**, which is *double*-gated —
  `auto_ping_enabled` defaults **off** *and* it independently obeys
  `write_actions_enabled`, so both must be turned on deliberately before it can
  do anything. With both on, a **mains-powered** node still Dead after the dwell
  is probed with no keypress, as is a node silent past `auto_ping_stale_min`. A
  ping transmits, so this is a genuine automatic path and is named here as one.
  It is bounded: `auto_ping_max_attempts` per outage on a widening backoff, and
  suppressed during storms, route rebuilds and restarts. Nothing else — refresh,
  re-interview, rebuild-routes, remove-failed, device control, config writes —
  has any automatic path whatsoever.
- **All mesh mutations ride the Home Assistant WebSocket** (authenticated with
  the Supervisor token). The separate, unauthenticated **driver WebSocket**
  (`ws://core-zwave-js:3000`) is used **strictly read-only**, behind a closed
  four-command allowlist — `set_api_schema`, `start_listening`, and the
  log-stream pair `start_listening_logs` / `stop_listening_logs` — and is
  **never proxied or re-exposed** to the TUI, ingress, or logs. None of the four
  transmits over RF: the log pair toggles this client's own receive flag and
  nothing more. One cross-client property is worth naming rather than leaving
  implicit — zwave-js-server's log forwarder is a *single global transport*
  whose first subscriber's filter is silently applied to every other client, so
  this client subscribes with **no filter** rather than narrowing a stream the
  operator's own Z-Wave log viewer shares.
- **Trust model.** Access over the Home Assistant sidebar (ingress) is already
  HA-authenticated, and the panel is **admin-only** (`panel_admin: true`) — the
  console can remove a failed node and, with write actions on, unlock a lock.
  Ingress trust is **pinned to the address `supervisor` resolves to**, resolved
  once before the server listens, so a *sibling add-on* on the same Supervisor
  bridge cannot forge it; resolution failure **fails closed**. Direct LAN access
  to the telnet port and the console is gated by an optional login
  (`auth_enabled`, users with plaintext or `scrypt:` passwords) with a shared
  per-peer backoff that survives reconnects, charged **before** the async verify
  so concurrent sessions contend for one counter. The login gate **fails closed**
  (denies) when enabled with no users configured, and a row with a blank password
  is rejected rather than becoming an account whose password is `""`.
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
  operator-initiated mesh actions, the add-on publishes four *diagnostic* states
  over the Core REST API — a degraded flag, a count of nodes needing attention,
  a live symptom count, and the engine's own run state. They carry node ids,
  counts and symptom kinds; **no credentials, no device state, and nothing about
  the network beyond what the TUI already shows an authenticated operator.** It
  writes no other entity, and it sends no notification: alerting policy is left
  to the operator's own automations rather than hardcoded here.
- **The controller mesh is bound by home id.** The persisted **evidence**
  envelope is tagged with the controller's `homeId`; a mismatch on load (a stick
  swap / a different NVM) starts fresh rather than aliasing one network's data
  onto another, and a driver-versus-Core mismatch purges driver telemetry and
  stops that client. The bound store is the evidence envelope specifically: the
  learned outcome ledger, the per-node baselines and the history series persist
  as separate `/data` files carrying no home-id tag, so after a controller swap
  they are stale rather than purged.

## Scope

In scope: the add-on server (`server/`), its HTTP/console/telnet surfaces, the
action-runner and auth paths. Out of scope: Home Assistant Core, the Z-Wave JS
integration and driver, the Supervisor, and the physical Z-Wave radio — report
those to their respective upstream projects.
