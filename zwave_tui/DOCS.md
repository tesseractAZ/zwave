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
| **Detail** | Full per-node dossier: identity, capability, security, live link (status / RTT / RSSI margin / response-timeout %), the LWR and NLWR routes with per-hop RSSI, TX/RX traffic counters, and the battery lane. |
| **Controller** | Node 1 radio health: home id, RF region, firmware/SDK, primary/SUC/SIS roles, per-channel background-RSSI noise floor, and the controller traffic/timeout counters. |
| **Topology** | Hop-grouped ASCII route tree from each node's last-working route, repeater-load view, and a Long-Range star panel. |
| **Heatmap** | Nodes grouped by HA area, cells graded by SNR-margin bucket against the live noise floor. |
| **Activity Log** | Real-time, scrollable stream of everything the mesh does — device value changes (a light toggles, a sensor reads, a lock changes), node status & route changes, `zwave_js` notifications, and operator-action outcomes. Each event is category-tagged; a detail pane shows the selected event's full context and associated device; a date-range filter narrows the window. |

> As of **v0.2** all six screens are live and the stat columns (Margin / Hop /
> Rate / Seen) carry real data from live node + controller statistics.

## Keybindings

**Overview**

| Key | Action |
| --- | --- |
| `j` / `k` or ↓ / ↑ | Move selection |
| `Enter` | Open Detail for the selected node |
| `/` | Filter by name substring (Esc cancels) |
| `s` | Cycle sort key (health / id / name / rssi / seen) |
| `t` | Toggle signal display (margin ↔ dBm) |
| `1`–`6` | Jump to Overview / Detail / Controller / Topology / Heatmap / Log |
| `c` / `e` | Jump to Controller / Log |
| `q` | Quit the session |

**Actions** (only when **Enable Write Actions** is on) — operate on the selected
node unless noted:

| Key | Action |
| --- | --- |
| `p` | **Ping** (safe, idempotent — runs immediately) |
| `i` | **Re-interview** the node (heavy) |
| `h` | **Heal** — rebuild the node's routes |
| `x` | **Remove** a failed node (always confirms) |
| `R` | **Rebuild ALL** routes — disrupts the whole mesh (always confirms) |

Mutating actions prompt `y` to confirm / any other key to cancel; each outcome
is written to the **Log** screen. `Enter` opens Detail (whose footer lists the
per-node actions when write actions are on).

**Activity Log** (screen `6` / `e`)

| Key | Action |
| --- | --- |
| `j` / `k` or ↓ / ↑ | Move the event cursor |
| `space` / `b` | Page down / up |
| `g` / `G` | Jump to newest / oldest |
| `Enter` | Open the selected event's associated device in Detail |
| `d` | Cycle the date filter (all · hour · 24h · today · yesterday · 7 days) |
| `o` | Toggle errors-only |
| `q` / `Esc` | Back to Overview |

**Overlays** — `q` / `Esc` close and return to Overview.

## Health score

Each node gets a composite **0–100 score**, a letter **grade**, and a discrete
**state**. The score blends weighted lanes — reachability, signal
(RSSI margin over the live noise floor + SNR), route quality, response
reliability, and interview completeness — with hard gates:

- A **dead** node scores 0.

> **Response reliability, not "drops".** The reliability lane and the Overview
> **TMO** column measure `timeoutResponse / commandsTX` — the fraction of
> commands whose expected reply never arrived while the node stayed reachable.
> They deliberately do **not** use `commandsDroppedTX`: on the Z-Wave JS driver
> that counter does not track RF acknowledgement failures (those mark the node
> *dead* instead) and is noisy otherwise, so it would both miss real trouble and
> false-alarm. The raw drop counters are still shown on the Detail *Traffic* row
> as context.
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
| `F` | Response timeouts (ACKed Gets with no reply, over ~15%) |
| `R` | Route problem (failed-between / poor route) |
| `L` | High latency (round-trip over ~1 s) — advisory |
| `I` | Incomplete interview |
| `B` | Battery low (≤ 25%) — advisory only |

## Driver telemetry (read-only)

The optional **`driver_ws_url`** setting (Advanced) opens a direct, strictly
read-only connection to the Z-Wave JS driver — the source of diagnostics Home
Assistant does not forward: the **per-channel background-noise floor** (which
turns the NOISE field and every signal margin from an assumption into a
measurement), true last-seen times, and device capability flags.

Safety posture: the connection sends exactly two protocol commands
(`set_api_schema`, `start_listening`) — enforced by a hard-coded allowlist —
and is **never** used to control the mesh; all actions go through Home
Assistant's authenticated API. The driver socket has no authentication of its
own, so the add-on treats it as privileged and never re-exposes it. If the
server is unreachable, speaks an untested schema version, or belongs to a
different Z-Wave network than Home Assistant's, the extra telemetry simply
stays blank and everything else works as before. Leave the setting empty to
disable the connection entirely.

## Write actions & safety

The add-on is **read-only by default** — **Enable Write Actions** is off, so it
only observes the mesh and the `p`/`i`/`h`/`x`/`R` keys do nothing.

Turn **Enable Write Actions** on to unlock the remediation actions (ping,
re-interview, heal/rebuild a node's routes, rebuild all routes, remove a failed
node). Then:

- **Ping** runs immediately (safe, idempotent).
- Every other action prompts a `y`-to-confirm step when **Confirm Destructive
  Actions** is on (the default). **Rebuild ALL routes** and **Remove failed
  node** always confirm regardless — they disrupt the mesh / delete a node.
- Every action's outcome is logged to the **Log** screen.

Because the telnet transport and `/console` are unauthenticated on the LAN,
turn on the **login gate** (below) if you expose the mesh controls off-host, so
actuating the mesh requires a credential.

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
