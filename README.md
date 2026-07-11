# Z-Wave TUI

A telnet "control-room" terminal UI for the health of a Home Assistant Z-Wave
mesh. It talks to the **Home Assistant Core WebSocket API**, joins the device
and entity registries against the `zwave_js` integration, polls
`zwave_js/network_status`, and renders a dense, **worst-health-first** view of
every node — reachability, signal margin over the live background-noise floor,
routes, TX reliability, and battery — behind a composite health score.

One engine, two front doors:

- **Telnet** on port `2324` — a full-screen terminal on your LAN.
- **Browser console** in the Home Assistant sidebar (HA Ingress) — works inside
  the HA mobile app, no extra ports exposed.

This repo is **also a Home Assistant add-on** — the add-on itself lives in
[`./zwave_tui`](./zwave_tui).

> **Works with any Z-Wave JS network.** Nothing about a specific controller or
> mesh is hard-coded: the `zwave_js` config-entry id is **auto-discovered** at
> startup, and the node roster comes from the device/entity registries — so the
> add-on runs on any Home Assistant install with the Z-Wave JS integration.
> (Developed and tested against a Zooz ZST39 LR 800-series controller on a
> ~39-node mesh.)

## Install on Home Assistant

This is a **Model A** add-on: Home Assistant pulls a **prebuilt multi-arch
image from GHCR**, so installs and updates take seconds, not a local build.

1. **Add the repository.** In Home Assistant go to **Settings → Add-ons →
   Add-on Store**, open the **⋮** menu → **Repositories**, and add:

   ```
   https://github.com/tesseractAZ/zwave
   ```

2. **Install.** **Z-Wave TUI** now appears in the store. Click it → **Install**.
   HA Supervisor pulls the prebuilt image for your CPU arch.
3. **Start.** No configuration is required for a normal install — the add-on
   auto-discovers your `zwave_js` entry. (Optionally adjust the poll intervals
   or the telnet port first.)
4. **Open it.** A **Z-Wave TUI** item appears in the HA sidebar (the browser
   console). For the LAN telnet transport: `nc <homeassistant-IP> 2324`.

### Updating

When `version:` in [`zwave_tui/config.yaml`](./zwave_tui/config.yaml) bumps,
the add-on page surfaces an **Update** button that pulls the new GHCR image.

## Connecting

**Sidebar (recommended).** The **Z-Wave TUI** sidebar item opens the browser
terminal (`/console`), authenticated through your normal HA session.

**Telnet (LAN).**

```bash
nc <homeassistant-IP> 2324
# or
telnet <homeassistant-IP> 2324
```

Access over the HA sidebar is authenticated by Home Assistant. Direct access
(telnet, or the port on the LAN) can be gated with the optional **login gate** —
turn on **Require Login (direct access)** and add **Login Users** (plaintext or
`scrypt:` hashed passwords). See [Authentication](./zwave_tui/DOCS.md) for
details. Or set **Enable Telnet TUI** to off and use only the sidebar console.

## Screens & keys

The **Overview** node list is home; every other screen is an overlay that
dismisses with `q` / `Esc`.

| Screen | What it shows |
| --- | --- |
| **Overview** | Live node table, worst-health-first, with a summary bar and per-node flags. |
| **Detail** | Per-node dossier: identity, live link, LWR/NLWR routes, TX/RX reliability, battery. |
| **Controller** | Node-1 radio health, background-RSSI noise floor, controller counters. |
| **Topology** | Hop-grouped route tree + repeater load + Long-Range star. |
| **Heatmap** | Nodes by HA area, cells graded by SNR-margin bucket. |
| **Log** | Driver events + command outcomes, severity-colored, red-latch-until-ack. |

> All six screens are live as of **v0.2**, and health scores reflect real RSSI /
> route / RTT data from live statistics. A freshly-seen node briefly shows `—`
> in the stat columns until its first reading arrives (a second or two).

Overview keys: `j`/`k` move, `Enter` detail, `/` filter, `s` sort, `t`
margin↔dBm, `1`–`6` jump screens, `c`/`e` Controller/Log, `p` ping (gated),
`q` quit.

Full keybinding and screen documentation is in
[`zwave_tui/DOCS.md`](./zwave_tui/DOCS.md).

## Health score

Composite **0–100** score + letter grade + discrete state, blending weighted
lanes (reachability, signal margin over the live noise floor + SNR, route
quality, TX reliability, interview) with hard gates: **dead → 0**, **unknown**
capped low, a node **asleep within its wake interval is not penalized**, and
**battery is a separate advisory lane** that never drags down the RF score.
Long-Range nodes (id ≥ 256) redistribute route weight into signal + reliability.

Grade bands: **A** ≥ 90, **B** ≥ 80, **C** ≥ 70, **D** ≥ 55, **F** < 55.

Flags: `D` dead · `S` asleep · `W` weak signal · `F` failing TX · `R` route
problem · `I` incomplete interview · `B` battery low (advisory).

## Write actions & safety

v0.1 ships **read-only**. **Enable Write Actions** defaults off — the add-on
only observes the mesh (ping is the sole safe/idempotent probe and is still
gated). When enabled, network-disruptive operations (rebuild-all-routes,
remove-failed-node) additionally require **Confirm Destructive Actions**. If you
expose mesh controls on an untrusted LAN, enable the login gate so actuating the
mesh requires a credential.

## Releasing a new version

Three workflows relay a release end-to-end:

1. **`release.yml`** (manual, `workflow_dispatch`) — bumps `version:` in
   `zwave_tui/config.yaml`, prepends a `## X.Y.Z — DATE` section to
   `zwave_tui/CHANGELOG.md` (no leading `v`), and opens an auto-merge
   `release/vX.Y.Z` PR.
2. **`tag-release.yml`** (on push to `main`, gated on a `Release v…` commit) —
   creates the `vX.Y.Z` tag and dispatches the image build.
3. **`images.yml`** (on the `vX.Y.Z` tag) — builds the `aarch64` and `amd64`
   images natively (no QEMU), pushes them to
   `ghcr.io/tesseractaz/{arch}-zwave-tui:{version}` + `:latest`, and cuts the
   GitHub Release.

`ci.yml` (typecheck + docker smoke build) is the required gate on every PR, and
`codeql.yml` runs the self-contained CodeQL security check.

### First publish — one-time GHCR Private → Public flip

The very first image push creates **two private packages** (one per arch):
`aarch64-zwave-tui` and `amd64-zwave-tui`. Home Assistant pulls anonymously, so
flip **both** packages to **Public** once, under
**github.com/users/tesseractAZ → Packages → each package → Package settings →
Change visibility → Public**. Subsequent releases just push new tags.

## Local development

- `server/` — Fastify + TypeScript backend, run directly with `tsx` (no server
  build step). `npm run typecheck` is the CI gate; `npm start` runs it.
- The browser console (`/console`) vendors xterm.js from `node_modules` — no
  CDN, so it works behind the Ingress token prefix.

## License

MIT — see [LICENSE](./LICENSE).
