# Z-Wave TUI

A telnet "control-room" terminal UI for the health of your Z-Wave mesh. It
connects to the Home Assistant Core WebSocket API, joins the device and entity
registries against the `zwave_js` integration, and renders a dense,
worst-health-first view of every node — reachability, signal margin over the
live noise floor, routes, TX reliability, and battery — with a composite
health score.

The same TUI is served two ways from one engine:

- **Telnet** on port `2324` for a full-screen terminal on your LAN.
- **Browser console** through the Home Assistant sidebar (HA Ingress), so it
  works inside the HA app with no extra ports opened.

v0.1 is a **read-only monitor**. Mutating actions (heal, rebuild routes,
re-interview, remove-failed) are wired but gated off by default — see
[Write actions & safety](#write-actions--safety).

## Connecting

**Sidebar (recommended).** After you start the add-on, a **Z-Wave TUI** item
appears in the Home Assistant sidebar. It opens the browser terminal
(`/console`) authenticated through your normal HA session — nothing to expose,
works in the HA mobile app.

**Telnet (LAN).** From any machine on the same network:

```bash
nc <homeassistant-IP> 2324
```

or

```bash
telnet <homeassistant-IP> 2324
```

By default the telnet transport has **no authentication** — keep it on a
trusted LAN, or turn on the **login gate** (see [Authentication](#authentication))
to require a username + password. To disable telnet entirely, set **Enable
Telnet TUI** to off and use only the sidebar console.

## Screen map

The **Overview** node list is home. Every other screen is an overlay that pops
over it and dismisses with `q` or `Esc`, preserving your selection.

| Screen | What it shows |
| --- | --- |
| **Overview** | Dense live node-list table sorted worst-health-first, with a summary bar (node counts, flaky count, noise floor) and a per-node flags column. |
| **Detail** | Full per-node dossier: identity, capability, security, live link (status / RTT / RSSI margin / drop %), the LWR and NLWR routes with per-hop RSSI, TX/RX reliability, and the battery lane. |
| **Controller** | Node 1 radio health: home id, RF region, firmware/SDK, primary/SUC/SIS roles, per-channel background-RSSI noise floor, and the controller traffic/timeout counters. |
| **Topology** | Hop-grouped ASCII route tree from each node's last-working route, repeater-load view, and a Long-Range star panel. |
| **Heatmap** | Nodes grouped by HA area, cells graded by SNR-margin bucket against the live noise floor. |
| **Log** | Scrolling stream of driver events (dead / alive / wake / route-change) and operator command outcomes, with severity coloring and a red-latch-until-ack. |

> Note: v0.1 lands the Overview home and the health model. The Detail /
> Controller / Topology / Heatmap / Log overlays fill in over the v0.2–v0.3
> releases.

## Keybindings

**Overview**

| Key | Action |
| --- | --- |
| `j` / `k` or ↓ / ↑ | Move selection |
| `Enter` | Open Detail for the selected node |
| `/` | Filter by name substring |
| `f` | Cycle status filter |
| `s` | Cycle sort key (health / id / name / rssi / seen) |
| `t` | Toggle signal display (margin ↔ dBm) |
| `1`–`6` | Jump to Overview / Detail / Controller / Topology / Heatmap / Log |
| `c` / `e` | Jump to Controller / Log |
| `p` | Ping the selected node (safe; gated) |
| `q` | Quit the session |

**Overlays** — `q` / `Esc` close and return to Overview. `j` / `k` scroll,
`Enter` drills into the focused node where applicable.

## Health score

Each node gets a composite **0–100 score**, a letter **grade**, and a discrete
**state**. The score blends weighted lanes — reachability, signal
(RSSI margin over the live noise floor + SNR), route quality, TX reliability,
and interview completeness — with hard gates:

- A **dead** node scores 0.
- An **unknown** node is capped low until it is interviewed.
- A **sleeping** (FLiRS/battery) node is **not** penalized for being asleep
  within its wake interval.
- **Battery is a separate lane** — a low battery raises a `B` advisory flag but
  never drags down the RF health score.
- **Long-Range** nodes (node id ≥ 256) are scored with route weight
  redistributed into signal + reliability (they are direct-to-controller).

Grade bands: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 55, **F** < 55.

**Flag legend** (single-char, shown in the Overview table):

| Flag | Meaning |
| --- | --- |
| `D` | Dead / unreachable |
| `S` | Asleep |
| `W` | Weak signal (margin under ~7 dB) |
| `F` | Failing TX (dropped + timeouts over ~15%) |
| `R` | Route problem (failed-between / poor route) |
| `I` | Incomplete interview |
| `B` | Battery low (≤ 25%) — advisory only |

## Write actions & safety

v0.1 ships **read-only**. The **Enable Write Actions** option is off, so the
add-on only observes the mesh (ping is the sole safe/idempotent probe and is
still gated behind the same switch).

When you later enable write actions, network-disruptive operations
(rebuild-all-routes, remove-failed-node) additionally require the
**Confirm Destructive Actions** prompt. If you expose the mesh controls on an
untrusted LAN, turn on the **login gate** (below) so actuating the mesh requires
a credential.

## Authentication

The TUI has an optional **login gate** for direct access.

- **Over the Home Assistant sidebar**, you are already authenticated by HA, so
  the console opens straight into the TUI. (Set **Also Require Login via HA
  Sidebar** if you want a second prompt there too.)
- **Direct access** — the telnet port, or hitting `:8788` directly on the LAN —
  is *not* HA-authenticated. Turn on **Require Login (direct access)** and add
  entries to **Login Users** to gate it. With auth on and no users configured,
  direct access is denied (fail-closed).

Each user has a `username` and `password`. The password can be:

- **Plaintext** — masked in the Configuration UI; stored in the add-on's
  `options.json` (root-only on the host). Simplest.
- **A scrypt hash** — `scrypt:<saltHex>:<hashHex>`, so no plaintext is stored.
  Generate one on any machine with Node:

  ```
  node -e "const c=require('crypto');const s=c.randomBytes(16);const p=process.argv[1];console.log('scrypt:'+s.toString('hex')+':'+c.scryptSync(p,s,32).toString('hex'))" 'your-password'
  ```

  Paste the printed `scrypt:...` value as the password.

Passwords are verified with scrypt off the event loop, and a wrong username
costs the same as a wrong password (no user enumeration). After **Max Login
Attempts** failures the connection is dropped, and repeated failures from the
same client trigger an **escalating backoff that persists across reconnects** —
so dropping and reconnecting does not reset the brute-force budget. **Idle
Re-lock** re-prompts a logged-in session after a period of inactivity.

> A plaintext password must not begin with `scrypt:` — that prefix marks a
> pre-hashed value. (Any other plaintext is fine.)

## Options

Every option is documented inline on the add-on **Configuration** tab (labels
and help text). In brief:

- **Log Level** / **Signal Display Unit** — verbosity and default margin/dBm view.
- **Refresh Interval** / **Route Poll Interval** — cheap render/roster cadence
  vs the expensive route/controller-statistics cadence.
- **Enable Telnet TUI** / **Telnet Port** — the LAN telnet transport.
- **Require Login (direct access)** / **Also Require Login via HA Sidebar** /
  **Login Users** / **Max Login Attempts** / **Idle Re-lock** — the login gate
  (see Authentication above).
- **Z-Wave JS Entry ID** — leave blank to auto-discover.
- **Home Assistant WebSocket URL** — leave at the default for a normal install.
- **Enable Write Actions** / **Confirm Destructive Actions** — the safety gates
  above.
