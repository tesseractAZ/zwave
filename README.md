# Z-Wave TUI

A telnet **control-room terminal UI** for a Home Assistant Z-Wave JS mesh — and a
**learned, advisory-only remediation engine** that watches that mesh over time,
learns each node's normal, and turns anomalies into grounded, ranked
recommendations. Nothing is ever acted on automatically.

It talks to the **Home Assistant Core WebSocket** (the node roster, live
statistics, and — behind a typed confirmation — maintenance, device-control, and
config-write actions) and, strictly read-only, to the **Z-Wave JS driver WebSocket**
for the real background-noise
floor and capability flags that HA does not expose. It persists a per-node
evidence time-series, scores every node worst-health-first, detects mesh symptoms,
and recommends fixes — across **eight screens**, over a telnet server and a
browser console.

**One engine, two front doors:**

- **Telnet** on port `2324` — a full-screen terminal on your LAN.
- **Browser console** in the Home Assistant sidebar (HA Ingress) — works inside
  the HA mobile app, no extra ports exposed.

The Home Assistant add-on itself lives in [`./zwave_tui`](./zwave_tui); the
Node/TypeScript server is under [`./server`](./server).

> **Works with any Z-Wave JS network.** Nothing about a specific controller or
> mesh is hard-coded: the `zwave_js` config-entry id is **auto-discovered** at
> startup and the node roster comes from the device/entity registries. Developed
> and tested against a Zooz ZST39 LR 800-series controller on a ~39-node mesh.

## The advisory engine

Beyond the live dashboard, the engine runs a pipeline that turns raw statistics
into diagnoses and recommendations — **advisory-only, everything grounded in
measured evidence:**

1. **Evidence store** — a persistent per-node time-series on `/data` (a fine ring
   plus a downsampled multi-day coarse tier), with fabrication guards so a counter
   reset or a quiet window never invents a reading. Survives restarts.
2. **Baselines** — each node's "normal" is learned per time-of-day band across
   several distinct days before its detectors may fire; symptomatic windows are
   quarantined so a fault can't teach the baseline to accept itself.
3. **Symptom detectors** — degraded return path, dead-flapping, rate fallback,
   high RTT, weak signal, a chatty flooder, a suspected ghost, controller
   serial-link strain, and correlation across nodes: an **edge-cluster** (a small
   group sharing one repeater) and a mesh-wide interference event, which *subsume*
   the per-node symptoms beneath them so you see one cause, not N faults.
4. **Planner** — each symptom becomes a ranked set of recommendations: physical
   guidance first (most Z-Wave fixes are physical — move a repeater, power-cycle,
   relocate the stick) plus any safe executable probe. Safety gates fail closed;
   a route rebuild is only ever shown to say *not* to.
5. **Outcome learning** — when a symptom resolves, the engine records whether the
   action beat the mesh's own spontaneous-recovery rate, scored per symptom kind
   by the signal its fix actually moves. It only claims an action "helped" once it
   clears that control arm by a real margin.
6. **Interference watch** — the real 900 MHz noise floor (recovered from the
   driver WebSocket, since HA strips it), controller serial-link health shown
   apart, a diurnal timeout heatmap, and a persisted multi-day noise-floor trend.

**Read-only by default; nothing auto-executes.** Every mesh-mutating action is
human-gated behind a typed `CONFIRM` (see [Write actions & safety](#write-actions--safety)).

## Screens & keys

The **Overview** node list is home; every other screen is an overlay that
dismisses with `q` / `Esc`.

| # | Screen | What it shows |
| --- | --- | --- |
| 1 | **Overview** | Live node table, worst-health-first, summary bar + per-node flags. |
| 2 | **Detail** | Scrollable per-node dossier: identity, live link, **live entity state** (is the light on? sensor values, lock state, climate mode…), the device's **Z-Wave configuration parameters**, LWR/NLWR routes, TX/RX reliability, battery, firmware. |
| 3 | **Controller** | Node-1 radio health, background-RSSI noise floor, controller counters, rebuild progress. |
| 4 | **Topology** | Hop-grouped route tree + repeater load + Long-Range star. |
| 5 | **Heatmap** | Nodes by HA area, cells graded by SNR-margin bucket. |
| 6 | **Log** | Driver/value/notification events + command outcomes; scroll, filter, red-latch-until-ack. |
| 7 | **Remedy** | The engine's diagnoses + ranked recommendations, with learned "helped X%" efficacy. |
| 8 | **Interference** | Noise floor + recent/multi-day trend, serial-link health, diurnal timeout heatmap. |

**Keys.** `1`–`8` jump to a screen (`c` Controller, `e` Log, `y` Remedy, `f`
Interference are shortcuts too). On Overview: `j`/`k` move, `Enter` detail, `/`
filter, `s` sort, `t` margin↔dBm. `a` opens the **Actions Menu**; `p` pings the
selected node (gated); `q` quits.

Full keybinding and screen documentation is in
[`zwave_tui/DOCS.md`](./zwave_tui/DOCS.md) — the complete System & Engine
Reference (also attached to each [release](https://github.com/tesseractAZ/zwave/releases)
as `.docx` + `.pdf`).

## Health score

A composite **0–100** score + letter grade + discrete state, blending weighted
lanes — reachability, signal margin over the *live* noise floor + SNR, route
quality, TX reliability, interview — with hard gates: **dead → 0**, **unknown**
capped low, a node **asleep within its wake interval is not penalized**, and
**battery is a separate advisory lane** that never drags down the RF score.
Long-Range nodes (id ≥ 256) redistribute route weight into signal + reliability.
The TX-reliability signal is the reply-timeout rate (`timeoutResponse / commandsTX`),
not `commandsDroppedTX` — which does not count RF ACK failures.

Grade bands: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 55, **F** < 55.

Flags: `D` dead · `S` stale · `W` weak signal · `F` response timeouts · `R` route
problem · `L` high latency · `I` incomplete interview · `B` battery low ·
`U` firmware update available (advisory — never affects the score).

## Write actions & safety

**Read-only by default.** **Enable Write Actions** is off, so the add-on only
observes. Turn it on to unlock actions on the selected node. Press **`a`** to open
the **Actions Menu**, which groups:

- **Mesh maintenance** — ping, refresh values, re-interview, rebuild-routes,
  remove-failed — plus mesh-wide rebuild.
- **Device controls** — turn a light / switch / fan **on · off · toggle**, **open
  / close** a cover or garage door, **lock / unlock** a lock.
- **Configuration** — edit a writeable Z-Wave parameter through a bounded value
  picker (enum options or a min/max-checked number).

Every row is badged **SAFE / CAUTION / DESTRUCTIVE** (unlocking a lock or opening a
garage is DESTRUCTIVE), and selecting any of them opens a modal that requires you
to type the literal word **`CONFIRM`** before it runs (only a bare `p` ping stays
immediate). Every outcome is logged. The *engine* never executes anything itself —
it only recommends; device control and config writes are **operator** actions, and
are never fed to the learning ledger. If you expose the LAN telnet port on an
untrusted network, enable the optional **login gate** (plaintext or `scrypt:`
passwords, with a per-peer backoff); the sidebar console is already HA-authenticated.

## Install

**Requires** Home Assistant OS or Supervised, with the **Z-Wave JS** integration
already set up.

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
   and add this repository:
   ```
   https://github.com/tesseractAZ/zwave
   ```
2. Install **Z-Wave TUI** from the store. There is **no prebuilt image** — Supervisor
   builds the add-on on your own device from the `Dockerfile`, so the **first install
   takes a few minutes** (later updates are quicker). Nothing is pulled from a
   container registry.
3. Start it. **No configuration is required:** the add-on auto-discovers your
   `zwave_js` config entry and builds the node roster from the device/entity
   registries.
4. Open **Z-Wave TUI** in the HA sidebar, or connect over LAN telnet:
   ```bash
   nc <homeassistant-ip> 2324
   ```

Optional: turn on **Enable Write Actions** to unlock the gated actions (see
[Write actions & safety](#write-actions--safety)), and the **login gate** if you
expose the telnet port on a network you don't fully trust.

> **Developing against a clone?** You can also run it as a *local* add-on: copy the
> add-on files to `/addons/zwave_tui` on the HA host, reload the store, and install
> `local_zwave_tui`. That's the workflow the maintainer uses for fast iteration.

## Releasing a new version

*(Maintainer notes.)* This add-on is built from source and publishes **no**
container image. A release is a versioned record plus the downloadable manual.
To cut one:

1. Bump `version:` in `zwave_tui/config.yaml` and add a `## X.Y.Z — DATE` section
   to `zwave_tui/CHANGELOG.md`, then merge that to `main` (a normal `vX.Y…` PR
   subject — CI gates it).
2. Push the tag at the merge commit:
   ```bash
   git tag v0.23.0 <merge-sha> && git push origin v0.23.0
   ```
3. **`publish-release.yml`** (on the `vX.Y.Z` tag) runs the server tests, builds
   the printable manual (`.docx` + `.pdf`), and cuts a **GitHub Release**
   with the CHANGELOG notes and the manual attached. No GHCR image is pushed.

`ci.yml` (typecheck + tests + docs build + docker smoke build) is the required
gate on every PR; `codeql.yml` runs the self-contained CodeQL security check.

## Local development

- `server/` — TypeScript backend run directly with `tsx` (no build step).
  `npm test` runs the suite (380+ node:test cases); `npm run typecheck` is the CI
  gate; `npm start` runs the server.
- The browser console (`/console`) vendors xterm.js from `node_modules` — no CDN,
  so it works behind the Ingress token prefix.

## License

MIT © 2026 Eric Paschal — see [LICENSE](./LICENSE).
