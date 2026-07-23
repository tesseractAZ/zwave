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
  the literal word **CONFIRM** (only a bare `p` ping shortcut is immediate). The
  *engine* is **advisory-only**: it recommends, it never executes — there is no
  automatic-remediation path in the shipped build, and device control / config
  writes are operator-initiated only.
- **All mesh mutations ride the Home Assistant WebSocket** (authenticated with
  the Supervisor token). The separate, unauthenticated **driver WebSocket**
  (`ws://core-zwave-js:3000`) is used **strictly read-only**, behind a closed
  two-command allowlist, and is **never proxied or re-exposed** to the TUI,
  ingress, or logs.
- **Trust model.** Access over the Home Assistant sidebar (ingress) is already
  HA-authenticated; direct LAN access to the telnet port and the console is
  gated by an optional login (`auth_enabled`, users with plaintext or
  `scrypt:` passwords) with a shared per-peer backoff that survives reconnects.
  The login gate **fails closed** (denies) when enabled with no users
  configured.
- **Input is sanitized at the boundary.** Device names and externally-sourced
  state strings are stripped of control/ANSI sequences before they reach the
  terminal frame; inbound console WebSocket frames are size-capped.
- **The controller mesh is bound by home id.** Persisted evidence and learned
  state are tagged with the controller's `homeId`; a mismatch on reconnect (a
  stick swap / different NVM) purges the restored state rather than aliasing one
  network's data onto another.

## Scope

In scope: the add-on server (`server/`), its HTTP/console/telnet surfaces, the
action-runner and auth paths. Out of scope: Home Assistant Core, the Z-Wave JS
integration and driver, the Supervisor, and the physical Z-Wave radio — report
those to their respective upstream projects.
