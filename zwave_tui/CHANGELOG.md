# Changelog

## 0.9.0 — 2026-07-14

An **Actions Menu** with a deliberate type-`CONFIRM` gate for every command.

- **Press `a`** (from any screen) to open the Actions Menu — a clear, grouped
  layout of every action the add-on can run, each with a colour-coded
  **`SAFE` / `CAUTION` / `DESTRUCTIVE`** badge and a one-line description of
  exactly what it does:
  - **Device actions** (on the selected node): Ping · Refresh values ·
    Re-interview · Rebuild node routes · Remove failed node.
  - **System-wide**: Rebuild ALL routes (or Stop route rebuild while one runs).
- **Type-`CONFIRM` modal** — selecting an action opens a box restating the
  action, its target, and its impact, then requires typing the literal word
  **CONFIRM** to arm it (Enter to execute). Esc cancels back to the menu; a
  wrong or lowercase string won't arm.
- **Read-only by default** — the menu still *opens* so you can read every
  action's impact, but shows a `READ-ONLY` badge and won't execute until
  `write_actions_enabled` is set. (The old `confirm_destructive` option is
  removed — a typed CONFIRM is now always required.)
- **Safety hardening** from a 6-dimension adversarial review: a half-armed
  CONFIRM can no longer survive an idle re-lock / re-login (it's abandoned at
  the auth boundary, so a different operator can't fire it); the menu freezes
  its target node + item list at open, so streaming Log events or a rebuild
  starting mid-menu can't redirect the action under the cursor.
- 22 new tests (**139 total**); `tsc` clean.

## 0.8.0 — 2026-07-14

A real-time **Activity Log** — see everything the mesh does, as it happens.

- **Live activity feed.** The Log screen (press `6` or `e`) now streams *device*
  activity in real time — a light toggles, a sensor reads, a lock changes — on
  top of the existing node status/route changes and operator-action outcomes.
  Device changes come from Home Assistant `state_changed` events, filtered to
  this mesh's entities; `zwave_js` notifications are surfaced too. Each line is
  category-tagged (`val`/`sts`/`rte`/`ntf`/`act`/`sys`).
- **Scroll + detail pane.** Move the cursor with `j`/`k` (or arrows), page with
  `space`/`b`, jump with `g`/`G`. A detail pane shows the selected event in full:
  timestamp, category, severity, the **associated device** (node + area + status),
  the entity, and the old → new value. Press `⏎` to jump straight to that
  device's Node Detail screen.
- **Date filter.** `d` cycles the window: all time · last hour · last 24h ·
  today · yesterday · last 7 days. Combine with `o` (errors only). The active
  filters show in the header. (The log is an in-memory, session-scoped ring of
  the last 2000 events — it isn't persisted across restarts.)
- Chatty numeric telemetry sensors are throttled so one meter can't flood the
  feed; discrete events (motion/lock/switch/…) are never throttled. All
  HA-sourced strings are sanitized before they reach the frame.
- 33 new tests (115 total). Multi-agent adversarial review.

## 0.7.0 — 2026-07-13

Two additions: a rebuild-routes progress indicator and a long-horizon trend.

- **Rebuild-routes indicator.** While a network rebuild is running, the
  Controller screen shows a live banner — a spinner, an indeterminate sweeping
  bar, and **elapsed time** — and the Overview summary bar shows `⟳ rebuilding
  routes 3m12s`. Home Assistant exposes only the `is_rebuilding_routes` boolean
  (no per-node progress), so this reports honest elapsed time, never a
  fabricated percentage. The animation is present only while rebuilding, so the
  idle screen keeps its anti-flicker.
- **Long-horizon RSSI trend.** Alongside the recent RSSI/latency sparklines, the
  Detail screen now shows a coarse **~2 h** signal trend (`Sig 2h`), downsampled
  to one point per minute (120 points). It persists to `/data/history.json`
  next to the fine ring and reloads at boot, so the long trend survives a
  restart too. History file schema is now v2; existing v1 files load unchanged
  (their coarse tier just fills in over time).
- 4 new tests (82 total): two-tier persistence round-trip, v1 back-compat,
  coarse bloat-cap, and the elapsed/spinner helpers. `tsc --noEmit` clean.

## 0.6.0 — 2026-07-13

Firmware-update surfacing — see at a glance which nodes have a Z-Wave firmware
update available (read-only; no update is ever triggered from the TUI).

- **Per-node firmware** on the Detail screen: installed version, and when an
  update is available `5.54 → 5.60 ⬆ update` (or `updating 42%…` while applying).
- **Overview** gains an advisory **`U`** flag (blue) on nodes with an update —
  it never affects the health score (a pending update is maintenance, not a
  fault), exactly like the battery `B` flag.
- **Controller** screen shows a fleet roll-up: `Node FW — N node(s) update
  available` (or `none pending`).
- Reads the `update.*` firmware entities via `get_states` on the same slow
  cadence as battery. A node may expose multiple firmware targets
  (`_firmware` + `_firmware_2`) — they're aggregated (update available if any
  target has one). The add-on/integration `update.*` entities are correctly
  excluded (they aren't on a node device).
- 11 new tests (78 total): firmware aggregation (multi-target, in-progress,
  missing attrs, version coercion) + the advisory `U` flag across node states.

## 0.5.0 — 2026-07-13

Persistent sparkline history — the RSSI/RTT trends now survive a restart.

- **Trends persist across restarts.** The per-node RSSI/RTT sample rings that
  feed the Overview/Detail sparklines were in-memory only, so every add-on
  restart / HA-Core reconnect / power blip wiped them and the graphs came back
  empty for minutes. They now flush to `/data/history.json` every 30s (and on
  shutdown) and reload at boot, so a deploy or restart is visually seamless.
  Dependency-free atomic JSON (temp-file + `rename`) — no `node:sqlite`, no
  native build, portable to any Node.
- **Two staleness guards** so a restored trend is never misleading: a 1h
  wall-clock age cap, plus a host-boot guard that distrusts the snapshot when
  the host has been up < 3min (on a no-RTC Pi the wall clock is pre-NTP right
  after a power loss, so a "fresh"-looking timestamp can be hours stale — the
  monotonic `os.uptime()` is immune). Future-dated snapshots are also dropped.
- **Network-identity guard.** Per-node stats + history are now cleared only when
  the controller `home_id` changes (a stick swap / different NVM backup), not on
  every reconnect — so history survives an HA-Core restart but never aliases one
  physical node's trend onto another after a controller change. (Supersedes the
  0.4.1 "self-heal clears the history ring" behaviour, which wiped trends on
  routine reconnects.)
- 13 new tests (67 total). Reviewed by an adversarial pass; all findings
  addressed or documented.

## 0.4.1 — 2026-07-11

Graphics polish from an adversarial verification (12 confirmed + 3 plausible; no
data or behavior regressions — all color/edge-case fixes).

- **Colors now match their numbers.** The Overview trend sparkline, the Detail
  drop% meter, the Topology route bars (dBm mode), and the Heatmap cells were
  colored by a different band than the value beside them — a healthy node could
  show a red trend, a 20%-drop a green bar. Each now uses the same color band as
  its number, so a green bar always means a healthy number.
- **Gauge robustness.** NaN/Infinity and degenerate inputs could render the
  literal "undefined" (blowing a fixed column to 9 cells) or collapse a bar to
  width 0 — `clamp01` now sanitizes non-finite input and `signalBars` guards
  `bars<=1`. A flat (steady) sparkline reads grey-steady instead of alarming red.
- `brailleSparkline` was vertically inverted (filled top-down); now bottom-up so
  a rising trend rises. Overview trend excludes RSSI sentinels; self-heal clears
  the history ring; Controller drops the redundant Home-ID decimal at 60 cols.
- 4 new edge-case tests (54 total).

## 0.4.0 — 2026-07-11

Terminal graphics — the TUI is now a control-room display.

- New `gauges.ts` graphics library (unit-tested width contracts): block
  **sparklines** + denser braille sparklines, **WiFi-style signal bars**,
  zone-colored **meters**, labeled **gauges**, gradient **heat cells**.
- **Per-node RSSI/RTT history** (rolling rings) drives the sparklines.
- **Overview**: WiFi signal bars in the Signal column, a health micro-gauge by
  each score, a mesh-health meter in the summary, and a right-hand RSSI trend
  sparkline column (wide terminals).
- **Detail**: a health gauge, RSSI + latency sparklines (min…max), an SNR-margin
  meter, a drop% meter, a battery gauge, and per-hop signal bars in the routes.
- **Controller**: a network-health gauge, a reliability meter, and the A–F grade
  histogram as meter bars.
- **Topology**: a hop-distribution histogram, per-node route signal bars, and
  repeater-load meter bars flagging single-points-of-failure.
- **Heatmap**: a real gradient heat-cell grid per area + per-area mean-margin
  meters + a gradient legend.
- All graphics are additive — every measured value is preserved; every screen
  still returns exactly `rows` lines with zero width overflow (agent harnesses:
  300+ geometry checks per screen). 50 tests.

## 0.3.0 — 2026-07-11

Safe remediation actions — the TUI can now *act* on the mesh, not just report.

- **Mutating actions** behind **Enable Write Actions** (default off, so nothing
  changes until you opt in): **ping** (safe/idempotent, runs immediately),
  **re-interview** (`refresh_node_info`), **refresh values**, **heal** a node's
  routes (`rebuild_node_routes`), **rebuild ALL routes**
  (`begin_rebuilding_routes` / `stop`), and **remove a failed node**.
- **Confirmation gate**: non-ping actions prompt `y` to confirm when **Confirm
  Destructive Actions** is on; **rebuild-all** and **remove-failed** always
  confirm regardless (mesh-wide / destructive). Cancelling returns to the screen
  with no side effect.
- **Closed-loop logging**: every action's start + outcome is written to the
  **Log** screen (`ping node 3 → ok`, `rebuild routes node 5 → failed: …`).
- The **Detail** footer lists the per-node actions when write actions are on.
- Command shapes were probed against the live driver (`rebuild_node_routes`,
  not the removed `heal_node`; ping via the `button.*_ping` entity). New tests
  cover the runner (gating + exact command construction) and the session
  confirm/cancel safety gates (41 total).

## 0.2.1 — 2026-07-11

Fixes from an aggressive live verification (14 confirmed findings).

- **Live statistics no longer freeze (was HIGH).** HA delivers the initial
  on-subscribe event with `nodeId` (camelCase) but every subsequent live push
  with `node_id` (snake_case); the handler only accepted `nodeId`, so after the
  first reading every node's stats froze at their subscribe-time values. Now
  accepts both — verified live that a pinged node's stats update again.
- **Health: an alive node no longer decays.** Reachability now follows the
  authoritative alive-poll, so a quiet-but-alive mains node can't drift into a
  false `S` (stale) flag or lose score just because its detailed statistics
  hadn't pushed recently.
- **Battery %** now shown (and the `B` low-battery flag fires) — read from the
  battery-level sensors.
- New **`L` (high latency)** advisory flag for sustained multi-second RTT.
- Route mapping keeps `repeaters`/`repeaterRSSI` index-aligned even if a hop
  fails to resolve; `route_failed_between` guarded.
- Statistics subscriptions re-establish after an entry self-heal (previously
  they'd orphan until a Core-WS reconnect); frozen stats cleared on re-discovery.
- Detail/Controller show a "…N more" marker instead of silently dropping
  sections on a short terminal; Detail drop% clamped to ≤100%.
- Topology labels its per-node dB as the route margin (vs the Overview's node
  RSSI); Log drops the inert follow/pause toggle.
- Sanitize device manufacturer/model/area (were bypassing the label sanitizer).
- `/api/health` reports `lastStatsUpdated`. New tests pin the casing fix +
  route mapping (30 total).

## 0.2.0 — 2026-07-11

Live statistics + the full six-screen interface. The health scores now reflect
real RF conditions instead of a uniform placeholder.

- **Live node + controller statistics**: subscribes to
  `zwave_js/subscribe_node_statistics` and `subscribe_controller_statistics`.
  Subscribing delivers each node's current stats immediately (no pinging), so
  the Overview populates within seconds. Fills the Margin / Hop / Rate / Seen
  columns with real RSSI, route, data-rate, and last-seen data — and the health
  score now spreads across the mesh (e.g. a weak, multi-hop node grades below a
  strong direct one) instead of every node reading the same.
- **Detail** screen: full per-node dossier — identity, security, live link
  (RTT / RSSI / SNR margin / drop%), the LWR + NLWR route chains with per-hop
  RSSI and data rate, TX/RX counters, and power source.
- **Controller** screen: node-1 identity + roles, live traffic counters, and an
  A–F network-health histogram.
- **Topology** screen: nodes grouped by hop count with their repeater chains,
  plus a repeater-load (single-point-of-failure) tally.
- **Signal Heatmap** screen: nodes by area, cells graded by SNR margin,
  worst-area-first.
- **Event & Command Log** screen: node status changes and mesh re-routing,
  severity-coloured.
- Correct field mapping under the hood: HA's snake_case stat fields → the
  internal model, the misspelled `timout_response` controller key, and route
  `repeaters` given as HA device_ids resolved back to Z-Wave node ids.

## 0.1.0 — 2026-07-10

Initial skeleton: a read-only Z-Wave mesh health TUI served over telnet
(`:2324`) and the Home Assistant sidebar (Ingress `/console`).

- Full Home Assistant add-on scaffold — `config.yaml` / `build.yaml` /
  `repository.yaml` / `Dockerfile` / s6 `run` service / AppArmor — building a
  prebuilt multi-arch GHCR image, `init: false`, Ingress-ready.
- HA Core WebSocket client (SUPERVISOR_TOKEN auth) with a subscription event
  demux and auto-reconnect.
- Z-Wave data layer: `zwave_js` entry-id auto-discovery, device + entity
  registry join, and a `network_status` roster poll.
- Telnet TUI + xterm.js browser console sharing one TUI session and data
  provider, with an anti-flicker draw loop.
- Overview node-list home sorted worst-health-first, over a composite health
  model (SNR margin over the live noise floor, Long-Range aware, battery as a
  separate lane, hard gates for dead/unknown/asleep).
- Read-only by default: mutating actions are gated off
  (`write_actions_enabled` defaults false); ping is wired but gated.
- Optional **login gate** for direct (non-ingress) access: users + passwords
  set in the add-on config, plaintext or `scrypt:` hashes. HA-sidebar access is
  trusted (already HA-authenticated). Hardened after an adversarial review —
  async scrypt (never blocks the event loop), startup normalization to scrypt
  (constant-cost verify, no username enumeration), a per-client backoff that
  survives reconnects, and a telnet connection cap. Fails closed when enabled
  with no users configured.
- Portable by design: no controller/mesh specifics hard-coded — the entry id is
  auto-discovered and the roster comes from the registries, so it runs on any
  Home Assistant install with the Z-Wave JS integration.
