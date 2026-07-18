# Z-Wave TUI — Complete System & Engine Reference

This is the definitive technical reference for the **Z-Wave TUI** Home Assistant add-on: a telnet/xterm control-room TUI plus a learned, **advisory-only** remediation engine for a Z-Wave JS mesh. It documents **every** feature and engine — what each does, its inputs, the exact algorithm and math it computes, how data traces through the pipeline to it and where its output goes, the screens and endpoints it produces, the configuration knobs that tune it, and its edge-case guards.

The add-on is a Node/TypeScript server (`server/`) that talks to Home Assistant's Z-Wave JS integration over the HA Core WebSocket (the node roster, live statistics, and — gated behind a typed CONFIRM — mutating maintenance actions) and, read-only, to the Z-Wave JS **driver** WebSocket (the real background-RSSI noise floor and capability flags that HA does not expose). It persists a per-node evidence time-series on `/data`, learns each node's "normal", detects mesh symptoms, turns them into grounded recommendations, and learns which of those actually help — surfaced across eight terminal screens over a telnet server (`:2324`) and an xterm.js `/console` (HA ingress, `:8788`). **Nothing is ever executed automatically:** every mutating action goes through the operator's type-CONFIRM Actions Menu.

> Every constant, threshold, formula, path, and config key below was written directly from the source. Where a value is a tunable default, that is noted. The engine's design rationale lives in `DESIGN.md` and its Z-Wave protocol research (with citations) in `RESEARCH.md`; for the install quick-start and option list, see `README.md` and the **Configuration, Deployment, Security & Operations** chapter.


## Table of Contents

1. [System Architecture & Data Flow](#1-system-architecture--data-flow)
2. [Z-Wave JS Integration & the Reliability Signal](#2-z-wave-js-integration--the-reliability-signal)
3. [The Control-Room TUI: Screens, Navigation & Rendering](#3-the-control-room-tui-screens-navigation--rendering)
4. [Node Health Scoring](#4-node-health-scoring)
5. [The Evidence Store (M2)](#5-the-evidence-store-m2)
6. [Read-Only Driver-WS Evidence Client (v0.13)](#6-read-only-driver-ws-evidence-client-v013)
7. [Baselines & Symptom Detectors (M3)](#7-baselines--symptom-detectors-m3)
8. [The Remediation Planner (M4)](#8-the-remediation-planner-m4)
9. [The Outcome-Learning Loop (M5)](#9-the-outcome-learning-loop-m5)
10. [The Interference Watch (M6)](#10-the-interference-watch-m6)
11. [Write Actions, Type-CONFIRM Safety & Authentication](#11-write-actions-type-confirm-safety--authentication)
12. [Configuration, Deployment, Security & Operations](#12-configuration-deployment-security--operations)


---

## 1. System Architecture & Data Flow

The Z-Wave TUI add-on is a single Node/TypeScript process (`server/src/index.ts` →
`main()`) that turns Home Assistant's `zwave_js/*` WebSocket surface into a live,
keyboard-driven control-room dashboard — served two ways from one shared data
cache — with a learned, **advisory-only** remediation engine bolted onto the same
evidence pipeline. This chapter traces every byte from the two upstream
WebSocket surfaces down to a rendered ANSI frame, and back up through the single
authenticated path that any mutating action must ride.

The whole shape, verbatim from the `index.ts` file header:

```
   HA Core WS client  ──▶  zwaveData (roster/discovery)  ──▶  TuiDataProvider
                                                              │
                         ┌────────────────────────────────────┤
                         ▼                                    ▼
                  telnet server (:2324)          xterm.js /console (:8788, ingress)
```

One `zwaveData` layer owns the upstream subscriptions and evidence; one shared
`TuiDataProvider` holds the render caches; **both** transports open their own
`TuiSession` over that single provider. Everything the render loop reads is a
cheap cached accessor — the expensive Z-Wave polling and engine recompute happen
on the data layer's own timers, never inside `draw()`.

### 1.1 The seven-stage bootstrap

`main()` wires the process in a fixed order, each stage depending on the one
before it (source: `server/src/index.ts:39-205`):

| # | Stage | Constructor | What it establishes |
| --- | --- | --- | --- |
| 1 | HA Core WS client | `createHaWsClient` | The single authenticated socket to HA Core (`config.haWsUrl`, `SUPERVISOR_TOKEN`). `client.start()` begins connecting; a **no-op** in dev when no token is present. |
| 2 | Z-Wave data layer | `createZwaveData` | Entry-id auto-discovery, registry join, `network_status` roster poll, live statistics subscriptions, the evidence store, and the M3–M6 engine. `zwaveData.start()` kicks the timers. |
| 3 | Source bridge | plain object literal | Adapts `ZwaveData` → the `ZwaveDataSource` interface the provider consumes (`snapshot`, `controller`, `events`, `history`, `symptoms`, `engineStatus`, `efficacyFor`, `interference`, …). |
| 4 | Shared data provider | `createTuiDataProvider` | The per-frame render cache both transports read; owns the fast `refreshMs` recompute timer. Returns `{ provider, stop }`. |
| 4b | Action runner | `createActionRunner` | The mutating-action chokepoint (ping / refresh / re-interview / heal / rebuild / remove), gated by `config.writeActions`; outcomes fold into the M5 learning ledger via `onOutcome`. |
| 5 | Auth | `createAuth` + `createAuthPolicy` | CORS/ws-origin allow-list and the direct-LAN login gate. |
| 6 | HTTP + ingress console | `Fastify` + `registerWsConsole` | The `/console` xterm.js page, `/console/ws` transport, `/`, `/api/version`, `/api/health`. |
| 7 | Telnet transport | `startTelnetServer` | The raw-TCP TUI on `:2324`, opt-in via `telnet_enabled`. |

Stages 1–4 are the data spine; 4b–7 are consumers of it. Note that stage 4
(`provider`) and stage 2 (`zwaveData`) have **independent lifecycles**: whoever
built the provider calls `stopProvider()`, but the underlying data layer is
stopped separately by its owner (`zwaveData.stop()`), which matters for the
shutdown ordering in §1.6.

### 1.2 The two WebSocket surfaces — and why there are two

The add-on talks to two distinct WebSocket servers with deliberately asymmetric
trust. This is the single most important architectural decision in the system.

```
   HA Core WS (zwave_js/*)                 driver WS (ws://core-zwave-js:3000)
   AUTHENTICATED, read + write             UNAUTHENTICATED, strictly read-only
            │                                        │
            └──────────────────┬──────────────────────┘
                          zwaveData.ts
```

**Surface A — HA Core WS** (`server/src/ha/haWsClient.ts`). The single persistent
socket the whole add-on authenticates against with `SUPERVISOR_TOKEN`. It is used
because `zwave_js/*` exposes live push subscriptions (`subscribe_node_statistics`,
`subscribe_controller_statistics`, `subscribe_events`) that the REST API cannot
deliver. Two mechanisms share one socket:

- `send(cmd, timeoutMs)` — request/response. Auto-increments a message id, writes
  `{id, ...cmd}`, resolves on the first matching `{type:'result', id}` frame. It
  cannot see `{type:'event'}` pushes.
- `subscribe(cmd, onEvent)` — allocates an id, registers an event handler in
  `eventHandlers`, then sends the subscribe command under that id. The persistent
  router `handleMessage` demultiplexes every inbound frame: `result` → the pending
  map, `event` → the handler map. Handler registration happens **before** the send
  so no early push is dropped between the result and the first event.

This surface carries everything that is source-of-truth or state-changing: the
`network_status` roster, the device/entity registries, the live node & controller
statistics, the `state_changed` activity feed, **and every mutating action** (via
`zwaveActions` / the `ActionRunner`). All RF-transmitting or mesh-mutating commands
ride this authenticated socket, and only this one.

**Surface B — the read-only driver WS** (`server/src/zwave/driverWsClient.ts`,
shipped v0.13, DESIGN §2.1). Connects to the zwave-js-server the official Z-Wave JS
add-on runs on the HA internal network (`driver_ws_url`, default
`ws://core-zwave-js:3000`). It exists because HA's WS boundary **strips the
diagnostics the engine needs** (RESEARCH §3.2/§3.3): per-channel background RSSI
(the real noise floor — the only path to true SNR margin and interference
detection), node `lastSeen`, and the `isListening`/FLiRS capability flags. HA
alone makes interference monitoring impossible, so the driver WS is a strict
diagnostic superset — but it is unauthenticated, so it is treated as privileged
and locked down hard:

```
DRIVER_WS_ALLOWLIST = Object.freeze(['set_api_schema', 'start_listening'])
DRIVER_SCHEMA_MIN = 32   DRIVER_SCHEMA_MAX = 41
```

- **Closed command allowlist, enforced in code**: `send()` *throws* on anything
  outside the two-command frozen list. No health checks, no pings, no route
  surgery — nothing that transmits RF. (The `extra` object is spread *first* so a
  colliding `extra.command` can never override the checked value — the v0.13
  spread-order bypass fix.)
- **Read-only telemetry only**: the `start_listening` state dump plus
  `statistics updated` events for `backgroundRSSI`, `lastSeen`, and node flags.
  Every other event type — values, notifications, inclusion — is ignored; HA's
  authenticated WS stays the source of truth for all of it.
- **Dormant, never fatal**: an unreachable server, a schema outside 32–41, or a
  homeId mismatch leaves the dependent telemetry `null` and the detectors that
  need it dormant — the add-on never fails to start because of this client
  (tenet 5: *collapse method, never measurement*).
- **Never proxied or re-exposed**: not to the TUI, not to ingress, not verbatim
  to logs (log types/counts, never payloads; `redactUrl`/`safeTag`/`saneNodeId`
  sanitize everything).

| | HA Core WS (Surface A) | Driver WS (Surface B) |
| --- | --- | --- |
| File | `ha/haWsClient.ts` | `zwave/driverWsClient.ts` |
| Auth | `SUPERVISOR_TOKEN` bearer | none (privileged, read-only) |
| Direction | read **and write** | read only (2-command allowlist) |
| Carries | roster, registries, node/ctrl stats, activity, **all actions** | background RSSI, `lastSeen`, `isListening`/FLiRS |
| Failure mode | reconnect w/ backoff; blocks readiness | dormant, dependent detectors go quiet |
| Liveness | WS ping/pong every 30 s | WS ping at ½·`livenessMs`, terminate at `livenessMs` (5 min) |
| Reconnect | `1s·2^n`, cap 30 s, ±20% jitter | `5s·2^n`, cap ~5 min |

**homeId cross-check.** Because a misconfigured `driver_ws_url` could point at a
*different* Z-Wave network, driver telemetry is admitted optimistically at startup
(the driver's fast state dump often lands before HA's first `network_status`), then
purged the instant a mismatch becomes provable. `driverHomeOk()` compares the
driver's handshake `homeId` against HA's `network_status` home id; on a proven
mismatch it latches `driverHomeMismatch`, clears `driverBgRssi` /
`driverLastSeen` / `driverListening`, and stops the client
(`zwaveData.ts:720-734`). This guard gates *every* consumer of driver data — the
noise floor, the FLiRS flags, and the M6 interference view.

### 1.3 `zwaveData` — the roster / discovery / evidence hub

`server/src/zwave/zwaveData.ts` (the `ZwaveDataImpl` class) is the confluence of
both WS surfaces and the substrate for the entire engine. Its startup sequence
(class header + `start()` / `refresh()`):

1. **Resolve the config-entry id.** If `entry_id` was configured it is *seeded*
   (`entrySeeded = true`) and never auto-cleared; otherwise `ensureEntryId()`
   auto-discovers it via `config_entries/get` filtered to `domain === 'zwave_js'`
   (preferring a `state === 'loaded'` entry), which survives an integration
   re-add.
2. **Join the registries once.** `ensureRegistries()` fetches
   `config/device_registry/list` + `config/entity_registry/list`. Z-Wave JS device
   identifiers look like `['zwave_js','<home_id>-<node_id>', …]`, so the node id is
   `Number(identifier.split('-')[1])`; the controller is node 1. This builds the
   `node_id ↔ device_id ↔ entities` maps that `network_status` (numeric ids only)
   cannot provide, plus the ping-button, battery, and firmware-update entity
   indexes.
3. **Poll `network_status`.** Every `refreshMs` (default 2000 ms), `refresh()`
   sends `zwave_js/network_status { entry_id }` — the cheapest complete mesh
   snapshot (roster + the 0..4 status enum, `is_routing`, `is_secure`, `ready`,
   security class, `is_rebuilding_routes`). Each raw node is joined against the
   registry maps into a `NodeSnapshot`; the controller becomes one
   `ControllerSnapshot`. **ANTI-FOOTGUN:** the parameter is `entry_id`, *not*
   `config_entry_id` (the latter rejects with `invalid_format`).

Live statistics arrive **push**, not polled: on every `onReady` (each
authentication) `subscribeStatistics()` re-establishes
`subscribe_controller_statistics` plus, per end node, `subscribe_node_statistics`
(counters) and `subscribe_node_status` (the event-driven flap source), then
`subscribe_events` for `state_changed` + `zwave_js_notification`. Subscriptions
are per-connection and die with the socket, so `onReady` fires on every re-auth to
rebuild them; failed per-node subscriptions are retried on a 60 s timer rather
than fire-and-forgotten (a silent coverage hole is exactly what the ghost detector
must never inherit).

This is where the **load-bearing reliability signal** originates. `onNodeStats`
feeds `statsByNode`, whose `timeoutResponse` and `commandsTX` counters drive the
TUI's reliability metric **TMO = `timeoutResponse / commandsTX`**. Per RESEARCH
§0, `commandsDroppedTX` does **not** count RF ACK failures — those mark a node
**Dead** while the counter stays 0 — so the real RF-failure signals the pipeline
watches are (a) Alive↔Dead status *flaps*, counted event-driven from
`subscribe_node_status` into `flapAccum` (never level-sampled from the roster,
which misses sub-window flaps), and (b) `timeoutResponse`, a Get whose reply never
came while the node stays Alive.

**Resilience & self-heal in the roster loop** (`tick()` / `refresh()`):

- Failures back off `refreshMs · 2^min(errStreak,5)`, clamped to
  `[refreshMs, 30_000]` ms, so a dev instance without a token or an HA restart
  can't spin the socket.
- After **≥3** consecutive failures on an *auto-discovered* (non-seeded) entry,
  the id is presumed stale (integration removed + re-added mints a new
  `entry_id`): `entryId` is nulled, registries + stats subscriptions are dropped,
  and `client.reconnect()` forces a clean re-subscribe. A seeded entry is left
  alone.
- **Network-identity guard**: the per-node caches (stats, sparkline history,
  evidence accumulators, baselines, the M5 ledger, the M6 memo) are all keyed by
  numeric node id. If the controller's `home_id` changes (stick swap / different
  NVM restore) those ids now refer to a *different* physical network, so *every*
  node-keyed cache is cleared and re-discovered — but **not** on a plain reconnect
  where `home_id` is stable (that stability is what lets sparkline/evidence
  persistence survive an HA-Core restart).
- **Departed-node eviction**: a node absent from the roster for **5 minutes** has
  left the network; its evidence and every node-keyed cache entry are evicted so a
  later node-id reuse can't merge two physical devices' histories.

### 1.4 The shared `TuiDataProvider` and the per-frame cached-accessor render model

`server/src/telnet/dataProvider.ts` (`createTuiDataProvider`) is the seam that
**decouples the 1 Hz render tick from the expensive recomputes**. It holds a bank
of `cached*` variables — `cachedNodes`, `cachedById`, `cachedController`,
`cachedEvents`, `cachedScores`, `cachedNoiseFloor`, `cachedHasNoise`,
`cachedLastUpdated`, `cachedReady`, `cachedError` — and refreshes them on a timer,
never inside a screen's `draw()`.

`recompute()` (the fast path) runs `zwaveData.snapshot()` / `.controller()` /
`.events()`, computes the representative noise floor once via
`computeNoiseFloor()` (the **median** of the controller's per-channel background
RSSI, filtering the driver sentinels `{127, 126, 125}` and any non-negative
value; falls back to `DEFAULT_NOISE_FLOOR` when empty), then scores every node
once with `scoreNode(n, noise)`. A read that throws keeps the last-good caches
rather than clobbering them with garbage. `recompute()` is called once
immediately to prime the first frame, then on `setInterval(recompute, refreshMs)`.

The provider's accessors are trivial getters returning the last-cached value —
`nodes: () => cachedNodes`, `scoreFor: (id) => cachedScores.get(id) ?? UNKNOWN_SCORE`,
`noiseFloor: () => cachedNoiseFloor`, and so on. A few pass straight through to the
data layer (`history`, `historyLong`, `interference`). This is the **per-frame
cached-accessor render model**: a `TuiSession.draw()` fired at 1 Hz reads only
these O(1) getters and never recomputes a health score or a noise floor.

The render cadence is layered so a screen is always cheap to draw but never more
than ~1–2 s stale:

| Loop | Cadence | Owner | Work |
| --- | --- | --- | --- |
| Render tick | 1000 ms | each transport (`setInterval(draw, 1000)`) | read cached accessors, hash-diff, emit ANSI |
| Provider recompute | `refreshMs` = 2000 ms | `dataProvider` | re-snapshot roster, rescore nodes, recompute noise floor |
| Roster poll | `refreshMs` = 2000 ms | `zwaveData.tick()` | `network_status` request/response |
| Evidence sample + engine tick | `evidenceSampleMs` (default = `routePollMs` = 10 000 ms) | `zwaveData` | one evidence sample/node, symptom detection, baseline fold |
| Node/controller stats | event-driven push | HA Core WS subscriptions | update `statsByNode` / `ctrlStats` |

One nuance: the provider inherits a generic self-scheduling `routePollMs` loop
from ecoflow-panel, but it only arms when the source exposes a `pollRoutes()`
method. The `ZwaveDataSource` bridge in `index.ts` deliberately does **not**
expose one — `zwaveData` owns its own polling via `tick()`/`scheduleNext()` — so
that loop stays dormant here and the provider runs only the fast `refresh` timer.

Anti-flicker lives one level down, in `TuiSession` (`telnet/session.ts`): each
frame body is hashed (`lastFrameHash`); an identical body is *not* rewritten, and
frames are wrapped in `BEGIN_SYNC`/`END_SYNC` and serialized (`drawing` /
`drawPending`) so a resize can't interleave with the 1 Hz redraw.

### 1.5 The two transports over one session driver

Both transports construct the same `TuiSession` (`telnet/session.ts`), which knows
nothing about sockets — it takes a `write(data)` sink, the shared `data` provider,
and an initial size, and owns view-state, input dispatch (`applyKey`), rendering
(`renderScreen`), and the login gate. The transports differ only in byte framing
and trust:

- **Telnet TUI, `:2324`** (`telnet/server.ts`). A raw `node:net` TCP server
  speaking just enough telnet to force character-at-a-time mode (`IAC WILL ECHO`,
  `WILL/DO SGA`, `DO NAWS`). `parseInput()` strips IAC sequences and emits
  transport-agnostic `SessionEvent`s (arrows via CSI/SS3, NAWS resize, CR/LF,
  Ctrl-C, Tab, Backspace/DEL, printable ASCII), holding back incomplete trailing
  sequences. It enters the alt-screen buffer on connect and restores the primary
  buffer + cursor on exit. It is **unauthenticated** (`trusted: false`) — hence
  only the telnet port is published on the LAN, guarded by the login gate, capped
  at `MAX_TELNET_CONNS = 16`, with a 4096-byte inbound buffer cap to drop runaway
  garbage. Opt-in via `telnet_enabled` (default on unless the run script exports
  `0`).
- **xterm.js `/console`, `:8788` (HA Ingress)** (`telnet/wsConsole.ts`). Registered
  on the Fastify app: `GET /console` serves a self-contained xterm.js page,
  `/console/xterm.js` + `/console/xterm.css` serve the vendored dist from
  `node_modules` (no CDN — offline ethos), and `/console/ws` is the WebSocket
  transport. `parseXtermData()` mirrors the non-IAC half of the telnet parser
  (xterm delivers decoded keys; resize arrives out-of-band as
  `{type:'resize',cols,rows}`). This is the add-on's HA sidebar view: reached
  through the Ingress token prefix, so `ingress_port: 8788` is **not** published
  on the LAN. Guard rails: `MAX_WS_SESSIONS = 16` (excess upgrades accepted then
  closed `1013` "Try Again Later"), `WS_IDLE_TIMEOUT_MS = 5 min` reset on every
  inbound frame, a 64 KiB `maxPayload`, and a cross-origin `Origin` rejection in
  `preValidation` (a *missing* Origin — same-origin fetch, the Ingress iframe,
  curl — still passes).

**Ingress trust.** A `/console/ws` upgrade is treated as pre-authenticated only
when it both carries an `X-Ingress-Path` header *and* originates from the
Supervisor subnet (`isIngressTrusted` in `index.ts`, using `req.ip` — the
unspoofable socket peer, since `trustProxy: false`). A trusted upgrade skips the
login gate unless the policy sets `requireOnIngress`; a direct-LAN upgrade is
gated like telnet.

### 1.6 Startup sequence & graceful shutdown

**Startup** proceeds top-down through §1.1: the HA client starts connecting, the
data layer begins discovery + polling, the provider primes its caches
synchronously (so the very first frame has data, not nulls), then Fastify binds
and — last — the telnet server binds. `main().catch()` logs `FATAL:` and exits 1
on any bootstrap rejection.

**Shutdown** is the reverse, ordered so no consumer reads a half-torn producer
(`index.ts:190-202`). A `closing` guard makes it idempotent across `SIGTERM` /
`SIGINT`:

```
telnet.stop()      // stop accepting/serving TCP sessions
stopProvider()     // clear the fast refresh timer (+ dormant route timer)
zwaveData.stop()   // clear poll/flush/coarse/evidence timers, persist to /data
client.stop()      // reject in-flight requests, close the HA socket
app.close()        // drain Fastify, then process.exit(0)
setTimeout(exit, 3000).unref()   // hard backstop if Fastify hangs
```

`zwaveData.stop()` does the durable work: it folds the pending coarse interval,
then persists both sparkline tiers, the evidence store, the baselines, and the M5
outcomes ledger to `/data` — deliberately writing **no** final evidence sample
(a minutes-stale cache under a fresh timestamp would fabricate a healthy-looking
window). All of the data layer's periodic timers are created with `.unref()` so
they never hold the event loop open at exit.

### 1.7 IPv6 dual-stack bind rationale

Both listeners default their bind host to `::` (`config.host` and
`config.telnet.host`), documented in the `config.ts` header. Node does **not** set
`IPV6_V6ONLY`, so one `::` socket accepts both IPv4 and IPv6. Binding only
`0.0.0.0` silently breaks clients that resolve a hostname to its IPv6 address —
macOS does this by default for `.local` names — because they reach the host's IPv6
stack, find no listener, and get a TCP RST. `::` avoids that whole class of "works
from one machine, RSTs from another" failures. (This is the same dual-stack lesson
recorded for the sibling ecoflow-panel add-on's mDNS/IPv6 trap.)

### 1.8 Where actions and the advisory engine sit

The M3–M6 engine is grafted onto the same evidence pipeline but is **advisory-only
by the owner's decision** (DESIGN §1, tenet 1; RESEARCH §0). `zwaveData` runs the
detectors each evidence tick (`runEngine`), exposes ranked `symptoms()`, engine
readiness, learned `efficacyFor()`, and the M6 `interference()` view up through the
provider to the Remedy and Interference screens — but **nothing auto-executes**.
The designed-but-not-built `executor.ts` / `auto_remediation` / `auto_safe` tiers
appear in the DESIGN §2 diagram marked *DEFERRED — not built*.

Every mutating action instead flows through the one authenticated path: the
human type-CONFIRM Actions Menu → `createActionRunner` (`zwaveActions`) → HA Core
WS. `write_actions_enabled=false` (the default) hard-disables that runner exactly
as it disables the menu — one gate, two callers — and successful outcomes fold
back into the M5 ledger via `onOutcome`. Two consequences worth stating plainly:
the driver WS (Surface B) is **never** used for anything that transmits RF or
mutates state, and a route **rebuild is never a runnable recommendation** — it
can't fix a physical link, it deletes manual priority routes, and it *throws* on
Long-Range nodes — so it exists in the catalog only as a manual, explicitly
confirmed operator action, never as engine advice.

## 2. Z-Wave JS Integration & the Reliability Signal

Everything the TUI knows about the mesh enters through one file — `server/src/zwave/zwaveData.ts` — which turns Home Assistant's `zwave_js/*` WebSocket surface into the cheap, cached `NodeSnapshot[]` / `ControllerSnapshot` that the render loop reads every frame. This chapter documents that boundary: how the add-on finds the Z-Wave integration, how it stitches numeric node ids to HA devices and entities, how it polls the roster and subscribes to live statistics, and — the load-bearing part — *which* of those statistics actually measures RF reliability and why the obvious one (`commandsDroppedTX`) is a trap.

The single public constructor is `createZwaveData(opts)` → `new ZwaveDataImpl(...)`, which calls `.start()` immediately. The consumer never touches HA directly; it calls `snapshot()`, `controller()`, `history()`, `evidence()`, `symptoms()`, and the action resolvers (`deviceIdOf`, `pingEntityOf`).

### 2.1 Startup sequence

`start()` (zwaveData.ts:635) registers an `onReady` handler on the HA WebSocket client and kicks the first `tick()`. The `onReady` handler is the spine of the whole integration's resilience: **every (re)authentication reloads the registry join and re-establishes the statistics subscriptions**, because those subscriptions are per-connection and die when the socket closes.

```
client.onReady(() => {
  this.registriesLoaded = false;     // an HA Core restart can rename/re-area devices
  this.statsSubscribed = false;      // subscriptions are per-connection — re-subscribe
  void this.subscribeStatistics();
});
void this.tick();
```

The ordered pipeline, per `refresh()` (zwaveData.ts:1111):

1. **`ensureEntryId()`** — resolve (or auto-discover) the `zwave_js` config-entry id.
2. **`ensureRegistries()`** — join the device + entity registries once, building the `node_id ↔ device_id ↔ entities` maps.
3. **`subscribeStatistics()`** — if not already live on this connection, open the controller + per-node statistics/status subscriptions.
4. **`zwave_js/network_status {entry_id}`** — the roster poll; build `NodeSnapshot[]` + `ControllerSnapshot`.

`tick()` reschedules itself on success at `refreshMs` and applies exponential backoff on failure (`refreshMs * 2**min(errStreak,5)`, capped at 30 s).

### 2.2 Config-entry auto-discovery

Most `zwave_js/*` commands need a config-entry id, and it is **not** stable across a re-add of the integration. `ensureEntryId()` (zwaveData.ts:1279) resolves it lazily:

```
if (this.entryId) return this.entryId;
const entries = await client.send({ type: 'config_entries/get' });
const zwave  = entries.filter(e => e.domain === 'zwave_js');
const chosen = zwave.find(e => e.state === 'loaded') ?? zwave[0];
this.entryId = chosen?.entry_id ?? null;
```

- The filter is on `domain === 'zwave_js'`; a **`state === 'loaded'`** entry is preferred, falling back to the first match.
- A **seeded** id (from the `entryId` option or `ZWAVE_ENTRY_ID` env) sets `entrySeeded = true` and is used verbatim — never auto-discovered, never cleared.
- **Self-heal** (zwaveData.ts:1085): after `errStreak >= 3` consecutive failures on an *auto-discovered* entry, the id is assumed stale (integration removed + re-added → new `entry_id` + `device_id`s). The layer nulls `entryId`, forces a registry reload, clears the frozen `statsByNode`/`batteryByNode`/`firmwareByNode`, and calls `client.reconnect()` so the old socket's subscriptions are released before re-subscribing. A seeded entry is left untouched by this path. Sparkline history (`histByNode`/`histLongByNode`) is deliberately **not** cleared — it is keyed by Z-Wave node id, which is stable across a config-entry re-discovery.

### 2.3 The device + entity registry join

`network_status` speaks only in numeric node ids. The registry join (`ensureRegistries` → `buildRegistryMaps`, zwaveData.ts:1300) supplies everything else — names, areas, and the entity ids the TUI needs to ping, read battery, and log activity.

**Identifier → node id.** Z-Wave JS device identifiers are tuples shaped `['zwave_js', '<home_id>-<node_id>...']`. `nodeIdOfDevice()` (zwaveData.ts:383) extracts the node id as:

```
Number(identifier[1].split('-')[1])   // '<home_id>-<node_id>' → node_id
```

The controller is **node 1** (`is_controller_node === true || nodeId === 1`; buildNode at zwaveData.ts:1371).

The join builds these maps in one pass over the device + entity registries:

| Map | Key → Value | Used by |
| --- | --- | --- |
| `deviceByNodeId` | node id → `{id, name, area, manufacturer, model}` | `deviceIdOf()`, node names |
| `deviceIdToNodeId` | HA device_id → node id | route-repeater resolution |
| `entitiesByDeviceId` | device_id → `NodeEntity[]` | Detail screen entity list |
| `entityIndex` | entity_id → `{nodeId, name, domain}` | activity-log `state_changed` mapping |
| `pingEntityByNode` | node id → `button.*_ping` entity_id | the **ping** action |
| `batteryEntityToNode` | `sensor.*battery*` → node id | `get_states` battery poll |
| `updateEntitiesByNode` / `updateEntityToNode` | node id ↔ `update.*` entity_ids | firmware-update status |

Only `platform === 'zwave_js'` entities that are **not** `disabled_by` and whose `device_id` resolves to a known node are indexed. Names come from `name_by_user || name` (device) and `original_name ?? name` (entity), and every externally-sourced string is run through `sanitizeLabel()` (zwaveData.ts:353), which strips C0/C1 control bytes (including ESC `0x1b`, so a crafted device name cannot inject ANSI into a TUI frame), folds wide/astral code points to `?`, and caps length at 48. The join is rebuilt fresh on every (re)auth so a removed node leaves no stale mapping.

### 2.4 The `network_status` roster poll

The core poll (zwaveData.ts:1123) is the cheapest complete mesh snapshot:

```
const net = await client.send({
  type: 'zwave_js/network_status',
  entry_id: entryId,          // ← entry_id, NOT config_entry_id
});
```

> **ANTI-FOOTGUN.** `zwave_js/network_status` takes **`entry_id`**, not `config_entry_id`. The latter rejects with `invalid_format`. (HA also accepts `device_id` here, but the TUI always uses the entry-scoped form to get the whole roster in one call. Per RESEARCH.md §3.1, this command *force-refreshes controller state each call* — a real live poll — so it is polled on a cadence, never hammered.)

Each raw node is mapped by `buildNode()` (zwaveData.ts:1367) into a `NodeSnapshot`. The status field is the Z-Wave JS `NodeStatus` enum (types.ts:15):

| value | `NodeStatus` | `statusLabel` |
| --- | --- | --- |
| 0 | `Unknown` | `unknown` |
| 1 | `Asleep` | `asleep` |
| 2 | `Awake` | `awake` |
| 3 | `Dead` | `dead` |
| 4 | `Alive` | `alive` |

`buildNode` reads `ready`, `is_routing`, `is_secure`, `highest_security_class` (mapped via `SECURITY_CLASS_LABEL`), and derives `isLongRange = nodeId >= 256`. Two fields are notably **not** in `network_status` and are filled from side channels: `isListening` (from the driver-WS state dump, else `null` — *not* "listening") and `stats` (from the live subscription cache, else `emptyStats()`).

`buildController()` (zwaveData.ts:1401) constructs the `ControllerSnapshot` from the `controller` object: `home_id`, `sdk_version`, `firmware_version`, `rf_region` (via `RF_REGION_LABEL` — region 9/11 are the Long-Range variants), `is_primary`, `is_suc`, and `is_sis_present` (note the lowercase `sis` in the raw key). It also latches the rebuild-routes clock: on the `is_rebuilding_routes` false→true edge it stamps `rebuildStartedAt = Date.now()` so the UI shows honest elapsed time (HA exposes only the boolean — no per-node progress — so the UI never fabricates a percentage).

**Roster hygiene guards** applied on every poll:

- **Empty/degenerate roster** (`nodes.length === 0` or missing controller) returns `false` (keeps the last-good view, surfaces `lastErr`) rather than wiping the display.
- **Status diff** vs `prevStatus` logs alive/dead/asleep transitions and feeds the flap fallback (§2.6).
- **Departed-node eviction** (zwaveData.ts:1155): a node absent from the roster for **5+ minutes** is treated as removed (excluded / `replace_failed_node`) and its evidence + all node-id-keyed caches are evicted, so node-id reuse can't merge two physical devices' histories.
- **Network-identity guard** (zwaveData.ts:1210): if the controller's `home_id` changes (stick swap / different NVM restore), *every* node-id-keyed cache — stats, sparklines, evidence accumulators, baselines, outcomes, driver telemetry — is dropped and a full reconnect + re-discovery is forced. A plain reconnect keeps `home_id` stable, which is exactly what lets sparkline persistence survive an HA-Core restart.

### 2.5 Live statistics subscriptions

Polling gives the roster; the *statistics* arrive push-driven. `subscribeStatistics()` (zwaveData.ts:1463) is idempotent per connection (guarded by `statsSubscribed`) and opens three kinds of subscription. Subscribing delivers each node's **current** statistics immediately, so the roster fully populates within seconds without any pinging.

**Controller statistics** — one subscription, entry-scoped:

```
zwave_js/subscribe_controller_statistics { entry_id } → onControllerStats
```

`onControllerStats()` (zwaveData.ts:1771) reads the host↔stick serial-link counters. The raw keys are snake_case, and **one is misspelled by HA's dev source**: the response-timeout key arrives as `timout_response` (missing the second `e`). The handler accepts either spelling so an upstream fix can never silently zero the field:

```
const tRes = num(e.timout_response) ?? num(e.timeout_response);
```

The controller counters cached into `ctrlStats` (types.ts:111): `messages_tx/rx`, `messages_dropped_tx/rx`, `nak`, `can`, `timeout_ack`, and `timout_response` → `messagesTX/RX`, `messagesDroppedTX/RX`, `NAK`, `CAN`, `timeoutACK`, `timeoutResponse`. Per RESEARCH.md §2.11 these are *host↔stick* counters, not per-node RF metrics — they measure the serial link, and the engine reads them only for serial-link health.

**Per-node statistics + status** — two subscriptions per end node (node 1 excluded, covered by the controller feed). `subscribeNode()` (zwaveData.ts:1505) is *per-feed idempotent* — a retry re-attempts only the feed that failed, because re-subscribing a live feed leaks a duplicate subscription and double-counts every subsequent event:

```
zwave_js/subscribe_node_statistics { device_id } → onNodeStats
zwave_js/subscribe_node_status     { device_id } → onNodeStatusEvent
```

Failed subscriptions queue in `pendingNodeSubs` and are retried every 60 s (`subRetryTimer`). A silent catch-and-forget hole in coverage is exactly what the symptom engine's ghost detector must never inherit, so which feeds are live is tracked (`statusSubbed`, `statsSubbedNodes`) and surfaced through `evidenceCoverage()`.

`onNodeStats()` (zwaveData.ts:1702) maps the raw event into `NodeStats`. Two subtleties:

- **Node-id key drift.** `statsNodeId()` (zwaveData.ts:1817) accepts **both** `nodeId` (camelCase) and `node_id` (snake_case). HA delivers the *initial* on-subscribe event with `nodeId` but every *subsequent* live push with `node_id`; accepting only one spelling would freeze every node's stats at their subscribe-time values.
- **Counter validation.** `statsCounters()` (zwaveData.ts:1928) requires **all five** cumulative counters (`commands_tx`, `commands_rx`, `commands_dropped_tx`, `commands_dropped_rx`, `timeout_response`) to be finite numbers, else the event is rejected whole. Coercing a missing field to 0 would re-baseline the evidence deltas at zero, and the next real event's cumulative value would then land as one giant fabricated "valid" delta.

The `NodeStats` shape (types.ts:49):

```
interface NodeStats {
  rtt: number | null;                // ms round-trip
  rssi: number | null;               // last dBm (ACK RSSI, at the controller)
  lwr: RouteStat | null;             // last working route
  nlwr: RouteStat | null;            // next-to-last working route
  commandsTX: number;                // successful (OK) sends only
  commandsRX: number;
  commandsDroppedTX: number;         // ← NOT an RF-loss counter (see §2.7)
  commandsDroppedRX: number;
  timeoutResponse: number;           // ← the real reliability signal
  lastSeen: number | null;           // epoch ms (set locally on each stats event)
}
```

`onNodeStats` also latches `routeFailedBetween` into the evidence store the moment it changes (it is transient — overwritten on the next OK transmission), appends non-sentinel RSSI/RTT to the sparkline rings, and counts repeater-chain changes into `routeChangeAccum`.

### 2.6 The status-flap subscription

`zwave_js/subscribe_node_status` is the **event-driven** flap source, and it is separate from the statistics feed for a reason: the 2-second roster poll only sees status transitions that survive a full poll interval, so a sub-2 s Alive→Dead→Alive flap is invisible to it by construction.

`onNodeStatusEvent()` (zwaveData.ts:1562) maps the event name to a status and counts every crossing of the Dead boundary:

```
name === 'dead'    → Dead      name === 'sleep'   → Asleep
name === 'alive'   → Alive     name === 'wake up' → Awake
// 'ready' and unknown events are NOT status transitions
const crossedDead = (prev === Dead) !== (next === Dead);
if (crossedDead) flapAccum[nodeId]++;
```

The event feed is seeded from the roster on subscribe, so the *first* real event (e.g. a genuine Alive→Dead) diffs against known status instead of being swallowed. Nodes **without** a live status feed (subscribe failed, retry pending) fall back to the roster-poll status diff (zwaveData.ts:1148), which counts a Dead-boundary crossing into the same `flapAccum` — the event feed is primary, and `statusSubbed` membership prevents feeding both and double-counting. `flapAccum` and `routeChangeAccum` are drained per evidence sample (§ the evidence chapter) so that sub-window flaps are attributed to the correct window.

### 2.7 The load-bearing signal fact: TMO, not `commandsDroppedTX`

This is the correction that overturns the naïve reliability metric, documented at RESEARCH.md §0 and in the `health.ts` header comment.

**Why `commandsDroppedTX` is the wrong metric.** Reproduced against zwave-js@15.25.3: when a listening node stops ACKing, `SendData` returns `TransmitStatus.NoAck`; the driver retries `attempts.sendData` (default **3**) times, then marks the node **DEAD** (`NodeStatus 3`) and rejects the transaction. Through all of this **`commandsDroppedTX` stays 0** — the singlecast NoAck path *throws* the NOK rather than feeding it back through the message generator, so `onMessageSent` never sees it. NoAck, controller-cannot-send, and Get-timeout each incremented the counter in **none** of the reproduced cases. Worse, it *can* tick up on a premature-response abort that actually **succeeded** (a fast node whose report beats the MAC ACK). So the counter is **near-silent for the RF failure it appears to name, and noisy otherwise** — folding it into a score would both miss real trouble and false-alarm on successes.

**The two signals that are right:**

1. **Alive↔Dead status flaps** (`subscribe_node_status`, §2.6) — a listening node that fails all send retries goes DEAD. This is *the* hard link-failure event. Caveat: dead-marking happens only *when traffic is attempted* — a silent node never goes dead, so absence of dead events ≠ health. In `scoreNode` a currently-dead node is the `D` hard gate (score 0); the flap *rate* is a symptom-engine detector.
2. **`timeoutResponse`** — the node MAC-ACKed a Get (so the RF link up to the ACK demonstrably works) but the expected report never arrived; zwave-js increments this and the node **stays Alive**. It is a return-path / responsiveness problem, and it accrues only for Get-type (response-expecting) traffic.

**The TMO metric.** The one shared definition lives in `responseTimeoutPct()` (health.ts:122):

```
export function responseTimeoutPct(stats: NodeStats): number | null {
  const tx = stats.commandsTX;
  if (tx <= 0) return null;                              // sent nothing yet
  const timeouts = Math.min(stats.timeoutResponse, tx); // clamp
  return Math.min(100, (timeouts / tx) * 100);
}
```

This is **`timeoutResponse / commandsTX`** as a percentage, and it is the single figure used by both the Overview `TMO` column and the Detail "Timeouts" row so a node never shows two numbers for the same thing. `commandsDroppedTX` is deliberately **excluded** from the score; the raw `commandsDroppedTX`/`commandsDroppedRX` counts are still rendered on the Detail TRAFFIC row as honest context, just never folded in.

Two caveats the code encodes honestly:

- **Denominator.** `commandsTX` increments *only on a successful (OK) send*, so this is timeouts-over-successes, not a true attempt-failure rate.
- **Get-only numerator.** Because `timeoutResponse` accrues only for Get-type traffic while `commandsTX` counts all successful sends, TMO is a *conservative under-estimate* for a SET-heavy node — an honest floor, never an over-statement.

`scoreNode()` (health.ts) consumes this as the **Response Reliability** lane (20% of the composite, 30% for Long-Range nodes where the Route weight is redistributed). It raises the `F` (flaky) flag above `TX_ERR_THRESHOLD = 0.15` and floors the lane to zero at `TX_ERR_FLOOR = 0.30`, both computed from `stats.timeoutResponse / stats.commandsTX` — never from the drop counter.

### 2.8 Actions: ping is a button, heal is `rebuild_node_routes`

The mutating surface lives in `zwaveActions.ts` (`createActionRunner`) and is gated by `write_actions_enabled`; every call logs its outcome into the event ring and fires the M5 outcome hook. Two entries matter for this chapter's boundary:

- **Ping** is not a `zwave_js/*` WS command — it is a **button entity press**. `pingEntityOf(nodeId)` resolves the node's discovered `button.*_ping` entity, and the action calls `call_service { domain: 'button', service: 'press', service_data: { entity_id } }` (zwaveActions.ts:68). It is treated as safe/idempotent. (The `zwave_js.ping` HA *service* is deprecated and returns nothing; the raw `invoke_cc_api` NOP-ping can mark a marginal node DEAD, so the button entity is the sanctioned path.)
- **Heal / "rebuild routes"** is `zwave_js/rebuild_node_routes { device_id }` (zwaveActions.ts:76), with the network-wide `begin_rebuilding_routes { entry_id }` / `stop_rebuilding_routes { entry_id }` variants.

Per RESEARCH.md §3.2, through today's HA-WS channel `rebuild_node_routes` and `begin_rebuilding_routes` are the *only* executable route remediations (active health checks, priority routes, neighbors, and background RSSI all require the driver-WS phase). Critically, **a route rebuild is never a runnable recommendation**: it cannot fix a physical link, it deletes manual priority routes, and it throws on Long-Range nodes — so the engine may *recommend* richly while its executable actions stay limited to ping / refresh / re-interview / rebuild / remove-failed, all routed through the human type-CONFIRM Actions Menu (the engine is advisory-only; nothing auto-executes).

### 2.9 Config knobs

The integration boundary is tuned by these options (each falls back to an env var, then a default):

| Option | Env | Default | Effect |
| --- | --- | --- | --- |
| `entryId` | `ZWAVE_ENTRY_ID` | `null` → auto-discover | Seed the config-entry id; when set, disables self-heal re-discovery |
| `refreshMs` | `REFRESH_INTERVAL_MS` | `2000` | `network_status` roster poll cadence; also the flap-fallback resolution |
| `routePollMs` | `ROUTE_POLL_INTERVAL_MS` | `10000` | Evidence sample cadence default (statistics themselves are push-driven, not polled) |
| `driverWsUrl` | `DRIVER_WS_URL` | `null` (disabled) | Read-only driver-WS client for real background RSSI, node `lastSeen`, and listening/FLiRS flags; guarded by a `home_id` cross-check (`driverHomeGuard`) that purges telemetry the moment a mismatch is proven |

Statistics subscriptions are not on a timer at all — they are opened once per connection and re-opened via `onReady` after any (re)auth. The only periodic HA calls are the `refreshMs` roster poll and the slow `get_states` pass (`fetchEntityStates`) that reads battery levels and firmware-update status after each registry (re)load.

## 3. The Control-Room TUI: Screens, Navigation & Rendering

The TUI is the human-facing half of the add-on: an instrument-panel–style console that renders over telnet (raw TCP) or an xterm.js WebSocket, driven by one per-session state machine. This chapter documents the rendering substrate — the eight screens, the key map that moves between them, the shared frame contract every screen wears, the ANSI-aware layout primitives and terminal gauges they draw with, the width-responsive Overview table, and the anti-flicker draw loop that repaints once a second without smearing. Two of the eight screens — **Remedy** and **Interference** — are the front ends of the remediation engine and get their own chapters; here they appear only as members of the registry and targets of the key map.

Everything in this layer is **pure render over cached data**. The screen functions receive a `DataProvider` whose accessors return the last cached values (`server/src/types.ts`, the `DataProvider` interface) and must never recompute Z-Wave state inside `draw()`. The single source of truth for "what nodes, in what order" is `visibleNodes()` in `server/src/telnet/input.ts`; the session computes it once per frame and hands the same array to every screen so a selection index means the same node everywhere.

### 3.1 The screen model & render dispatch

The set of screens is a closed union in `server/src/types.ts`:

```ts
export type ScreenView =
  | 'overview' | 'detail' | 'controller' | 'topology'
  | 'heatmap'  | 'log'    | 'remedy'     | 'interference';

export const SCREENS: ScreenView[] = [
  'overview', 'detail', 'controller', 'topology',
  'heatmap',  'log',    'remedy',     'interference',
];
```

`SCREENS` is ordered so its **array index + 1 is the number key** that jumps to it (see §3.2). `SCREEN_LABEL` in `server/src/telnet/screens/index.ts` maps each id to a human tab label (`overview → 'Overview'`, …).

`renderScreen(ctx: ScreenCtx)` (same file) is a thin dispatcher: a `switch` on `ctx.view.screen` calls the matching `render*` function and returns its `string[]` (one styled string per terminal row). The `default` arm assigns `ctx.view.screen` to a `const _never: never` — an **exhaustiveness guard**: adding a new `ScreenView` without wiring a case fails the typecheck rather than silently falling back.

| # / key | screen | renderer (file) | role |
|---|---|---|---|
| `1` | overview | `screens/overview.ts` | home: worst-health-first node table |
| `2` / `⏎` | detail | `screens/detail.ts` | per-node dossier overlay |
| `3` / `c` | controller | `screens/controller.ts` | controller + whole-mesh roll-up |
| `4` | topology | `screens/topology.ts` | hop-bucketed route tree + repeater load |
| `5` | heatmap | `screens/heatmap.ts` | SNR-margin heat strip by HA area |
| `6` / `e` | log | `screens/log.ts` | live activity stream |
| `7` / `y` | remedy | `screens/remedy.ts` | *(engine — Chapter on Symptoms/Remedy)* |
| `8` / `f` | interference | `screens/interference.ts` | *(engine — Interference chapter)* |

Overview is the **home**; the other seven render as full-frame overlays over it. The context object each renderer consumes is `ScreenCtx` (`types.ts`):

```ts
interface ScreenCtx {
  view: ViewState;              // per-session screen/selection/filter/sort/size
  data: DataProvider;           // cached accessors
  visibleNodes: NodeSnapshot[]; // the ONE sorted+filtered list
  filtering?: boolean;          // '/' capture mode is live (shows the cursor)
  actionsEnabled?: boolean;     // write_actions_enabled → offer the Actions row
}
```

### 3.2 Navigation: the key map

Both transports parse their wire bytes down to the **same** `InputEvent` union and feed them to one binding table, so keys live in exactly one place. The union (`types.ts`):

```ts
type InputEvent =
  | { type: 'char'; ch: string }
  | { type: 'arrow'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'enter' } | { type: 'tab' } | { type: 'escape' } | { type: 'ctrlc' };
```

The telnet parser (`server.ts`, `parseInput`) strips IAC framing, decodes NAWS window-size sub-negotiations into `resize` events, and recognizes a **bare** CSI/SS3 `A/B/C/D` as an arrow (longer sequences — modified arrows, bracketed paste, mouse — are swallowed). The xterm parser (`wsConsole.ts`, `parseXtermData`) mirrors the non-IAC half. Feeding both into `TuiSession.feed()` keeps navigation transport-agnostic.

**Dispatch order.** `TuiSession.feed()` (`session.ts`) gates keys through session-owned modes before the generic map ever sees them: `ctrlc` (universal disconnect) → `denied` → login gate → `/`-filter capture → action-in-flight (swallowed) → pending type-CONFIRM → dismiss action notice → Actions Menu → `a`/`A` open menu → mutating shortcut keys (only when `actions.enabled`) → finally `applyKey(view, ev, data, log)` in `input.ts`. Inside `applyKey`, the **Log screen gets first refusal** via `applyLogKey` (it owns its own cursor and filters), returning `null` to fall through to the generic handler for anything it doesn't claim.

**The generic key map** (`applyKey`):

| Key(s) | Action |
|---|---|
| `1`–`9` | `view.screen = SCREENS[n-1]` when `n-1 < SCREENS.length`; `9` is a no-op (only 8 screens) |
| `c` | jump to **controller** · `e` → **log** · `y` → **remedy** · `f` → **interference** |
| `↑`/`k` | move selection cursor up · `↓`/`j` down (`moveSelection`, clamped to the visible list) |
| `←`/`→` | reserved (no-op) |
| `⏎` (Enter) | drill into **detail** for the selected node (no-op if the list is empty) |
| `Esc` | dismiss any overlay back to **overview**; no-op if already home |
| `q`/`Q` | on an overlay → back to overview; on the overview home → **quit** (`{quit:true}`) |
| `/` | hand control to the session's filter-capture loop (`{filter:'start'}`) |
| `s` | cycle sort key through `SORT_ORDER` and reset selection/scroll to top |
| `t` | toggle `signalDisplay` between `'margin'` and `'dbm'` |
| `o` | toggle the log's `errorsOnly` filter |
| `p` `i` `h` `R` `x` | mutating actions — **no-op with a hint** unless `write_actions_enabled` (see below) |
| `a`/`A` | open the Actions Menu (intercepted by the session, not `applyKey`) |

`SORT_ORDER = ['health', 'id', 'name', 'rssi', 'seen']`. `visibleNodes()` applies the substring filter (over name / id / manufacturer / model / status label) first, then sorts: `health` worst-first by `data.scoreFor().score`, `rssi` weakest-first, `seen` most-stale-first, each with a `nodeId` tiebreak. RSSI sorting/scoring skips the driver sentinels `{127, 126, 125}` — `effectiveRssi()` maps a null or sentinel reading to `-999` so unknown-signal nodes surface at the "weakest" end rather than being treated as strong.

**Mutating keys are recognized but inert when write actions are off.** `applyKey`'s `p/i/h/R/x` case logs *"'x' is a mutating action — enable write_actions_enabled in the add-on config to unlock"* and returns no-redraw, so the muscle-memory is correct even though nothing actuates. When `write_actions_enabled` is set, the session intercepts these **before** `applyKey` and routes them through `beginAction()` → the type-CONFIRM modal. This is the engine's owner-mandated **advisory-only** posture in the UI layer: every mutating path terminates at a human typing the confirm word, never an auto-execution.

**Filter-capture mode** is session-owned (`this.filtering`, not in `ViewState`) so it survives independent of screen state. `handleFilterKey` appends printable chars (`' '..'~'`) to `view.filter`, Backspace/DEL deletes, Enter commits (and clamps the selection), Esc cancels and clears; every mutation resets `view.selected = 0`. While capturing, Overview's `rightStatus` renders a live `FILTER "…"▏` token with a blinking cursor bar.

**The Log screen's private navigation** (`applyLogKey` in `input.ts`) runs a second cursor (`view.logCursor`) over the date/severity-filtered event list: `j/k` or arrows move one row, `space`/`b` page (page size = `logLayout(rows).listRows - 1`), `g` jumps to newest and resumes follow-tail, `G` to oldest, `Enter` opens the associated node's Detail, `o` toggles errors-only, `d` cycles `LOG_RANGE_ORDER` (`all → hour → 24h → today → yesterday → 7d`). The cursor is anchored by the event's stable `seq` (`syncLogCursor`), so new events prepending to the newest-first ring never drift the highlight.

### 3.3 The shared frame() contract

Every content screen wears one frame, produced by `frame(view, data, opts)` in `server/src/telnet/chrome.ts`. Its guarantee is exact: **it returns EXACTLY `view.rows` lines, each ≤ `view.cols` visible columns.** The screen supplies only its body; the frame owns the chrome.

```ts
interface FrameOpts {
  title: string;         // section name in the title rule
  rightStatus?: string;  // far-right token on the rule (count/filter/rebuild)
  telemetry?: string;    // optional labelled strip under the rule
  body: string[];        // styled body lines (padded/clamped to fit)
  keys: ReadonlyArray<readonly [string, string]>; // command-bar keycaps
}
```

Frame layout, top to bottom:

1. **Row 0 — masthead** (`masthead()`): product ident `ZWAVE·JS MESH DIAGNOSTICS` on the left; on the right a link tag, the home id (**only when `cols ≥ 100`**), and a log-correlatable timestamp `YYYY-MM-DD HH:MM:SS`. `lr()` stretches the gap so the right cluster is flush-right.
2. **Row 1 — title rule** (`titleRule()`): `── TITLE ─────…` with `rightStatus` pinned *outside* the cyan rule fill (`fill = cols − visLen(head) − rightW`) so a status token can never be buried by the dashes.
3. **Optional telemetry strip**: `truncate(opts.telemetry, cols)` — a row of `LABEL value` fields (`field()` = grey label + coloured value) joined by a 4-space gutter (`fieldStrip()`).
4. **Body**: padded/clamped into the remaining height. `bodyCap = max(0, rows − top − 1)`, where `top` is the number of chrome rows already pushed (2, or 3 with telemetry) and the `−1` reserves the command bar. Each body line is `truncate(body[i] ?? '', cols)`; short bodies are padded with empty strings.
5. **Last row — command bar** (`commandBar()`): `[K] LABEL` keycaps (cyan bracketed cap, grey label) joined by 3 spaces, truncated to width.

A final `out.slice(0, view.rows)` is a belt-and-suspenders clamp. The **link state** shown in every masthead is derived once by `linkState(data)`: `offline` if `lastError() != null`, `stale` if `lastUpdated()` is null or older than **30 000 ms**, else `online`.

Screens whose bodies can overflow (Detail, Controller, Topology, Heatmap, Log) each compute their own `bodyCap = max(1, H − 3)` and either shed droppable graphics or emit a `…N more` marker rather than letting `frame()` silently clip real data (see §3.7).

### 3.4 ANSI-aware layout primitives

`server/src/telnet/ansi.ts` provides width-correct string ops: SGR colour escapes don't count toward layout width, and only single-cell BMP glyphs are used, so JS `.length` (after stripping escapes) equals on-screen columns.

- `visLen(s)` — visible width, stripping `/\x1b\[[0-9;]*m/g`.
- `truncate(s, width)` — cut to a visible width, **keeping escapes intact and appending `RESET` at the cut**. (This trailing RESET is why the selected Overview row can't embed styled cells — see §3.6.)
- `padEnd` / `padStart` / `center` / `lr(left, right, width)` — all measure with `visLen`, so colour never skews alignment. `lr` truncates the combined string if the two sides can't both fit.
- `bar(frac, width, color)` — a simple filled/empty block meter (superseded on most screens by the richer `meter()` in gauges).

The colour palette is `c.*` — atomic SGR spans that **must not be nested** (an inner RESET would clear the outer):

| Helper | SGR | Semantic use |
|---|---|---|
| `c.red` 91 / `c.green` 92 / `c.yellow` 93 | | fault / ok / warn |
| `c.blue` 94 / `c.cyan` 96 / `c.white` 97 / `c.grey` 90 | | LR / info-structure / value / chrome |
| `c.redB/greenB/yellowB/cyanB/whiteB` | `1,9x` | bold emphasis |
| `c.invert` | 7 | selected menu tab / node row |
| `c.dim` 2 / `c.bold` 1 / `c.label` 96 | | — |

`BOX` supplies the double-line control-room border (`╔╗╚╝║═╠╣`) plus light internal rules (`─│`). The module also defines the terminal-lifecycle escapes the draw loop relies on: `ENTER_ALT_BUFFER`/`EXIT_ALT_BUFFER` (`?1049h/l` — redraws can't smear into scrollback), `BEGIN_SYNC`/`END_SYNC` (`?2026h/l` — synchronized atomic frames; no-ops on terminals that don't recognize them), and `HIDE_CURSOR`, `CURSOR_HOME`, `CLEAR_EOL`, `CLEAR_BELOW`.

### 3.5 Gauges & sparklines

`server/src/telnet/gauges.ts` returns strings of **known visible width** (colour excluded) so callers can place them in fixed columns without ever overflowing. All fractions pass through `clamp01(x)` = non-finite → 0, else clamped to `[0,1]`, which protects the width contract from a NaN input.

- `zoneColor(frac)` — traffic light: `≥0.66 green`, `≥0.33 yellow`, else `red`. This 0.66/0.33 split is the shared threshold the Overview's `bandFrac()` maps signal metrics onto so glyph colour lines up with numeric health bands.
- `vblock(frac)` — one of `▁▂▃▄▅▆▇█` (U+2581..2588), `' '` at ≤0; the Overview score cell's at-a-glance level.
- `sparkline(values, width, {min,max,color})` — one block cell per resampled sample, last-value bucketed to `width`, auto-scaled to the data range. A **flat** (all-equal) series renders as a mid-height grey line (`BLOCKS[3]`) rather than a red row of lowest blocks; colour otherwise tracks the **last** value's position in range. Leading `·` dim dots fill while history is short.
- `brailleSparkline(...)` — 2 samples per cell (2×4 dot matrix, U+2800..), filled bottom-up so a low value is a short mark at the cell bottom (matching the block sparkline, not inverted).
- `signalBars(frac, bars=4, colorOverride?)` — WiFi-style ascending glyphs (`▁▃▅▇` at 4 bars); lit fraction coloured, remainder grey.
- `meter(frac, width, {color, dir})` — horizontal fill bar; `dir:'lowGood'` inverts the colour mapping (used for drop%/error-rate where empty is good).
- `gauge(frac, barWidth, label, opts)` — `[██████░░] label`; total width `barWidth + 3 + label.length`.
- `heatCell(frac, {none, color})` — a single shade block `░▒▓█` whose density tracks the fraction and colour is caller-supplied or `zoneColor`; `none:true` → grey `·` (no reading).
- `spinner(nowMs)` — braille spinner advancing at ~120 ms/frame; `fmtElapsed(ms)` → `45s` / `3m12s` / `1h05m`.

### 3.6 Width-responsive Overview

`renderOverview` (`screens/overview.ts`) is the densest screen and the one that most exploits the width contract. It builds a responsive column set with `layout(W, mode)`, where each `ColSpec` carries `{key, w, align, header}`:

```
add('cursor',1,l) ('id',4,r) ('status',2,l) ('name',16,l→FLEX) ('score',4,r) ('signal',12,r)
MID (W ≥ 104):  + ('rtt',6,r) ('tmo',5,r)
add('hop',4,r)
WIDE (W ≥ 140): + ('route',16,l)
add('rate',5,r) ('seen',5,r) ('batt',4,r) ('flags',9,l)
MID:            + ('trend', wide?16:8, l)
```

The two breakpoints are `MID_COLS = 104` (unlocks RTT · TMO · TREND) and `WIDE_COLS = 140` (adds ROUTE plus a wider name/trend). The **NODE column then flexes** to absorb all remaining width: `name.w = clamp(W − fixed, 14, 40)`, where `fixed` is the sum of every other column plus one space per separator — so the table fills the terminal instead of stranding the right half. Columns join with single-space separators (`joinCells`), right- or left-padded by `padStart`/`padEnd` per the `align` flag.

**The selected-row plain/coloured duality.** A normal row renders each cell with `c.*` colour. The selected row is drawn in inverse video (`c.invert`), and **no embedded SGR/RESET can survive inside the invert** — so every graphic cell is built in two forms of identical visible width: a `colored` string and a `plain` string (ANSI stripped). The selected branch hard-slices each plain cell to its column width *before* `joinCells` so the join can only pad (never call `truncate`, which would inject a RESET that breaks the inverse bar mid-row). This is why the score cell is `vblock + padStart(round(score),3)` (a fractional score is rounded to hold the 4-cell width) and the signal cell caps its dB label at 7 chars.

**Graphic cells sit on top of already-correct data.** The signal column is `signalBars(4) + ' ' + right-aligned dB` where bars and text reflect the *same* quantity: SNR margin (`rssi − noise`) in `margin` mode, RSSI in `dbm` mode, toggled by `t`. `bandFrac(v, yellow, green)` maps a metric onto `zoneColor`'s 0.66/0.33 breakpoints so bar colour lands exactly on the numeric health thresholds (`rssi` band `−88/−70`; `margin` band `5/17`). A right-hand RSSI micro-sparkline (`sparkCell`) only appears on mid+ terminals and is coloured by the last sample's **absolute** band (`rssiColor`) rather than the relative-window default, so a healthy-but-flat node doesn't read red. Missing readings (`rssi` null or sentinel) render blank bars + `—`.

**Column semantics worth noting:** the **TMO** column is `responseTimeoutPct(stats)` = `timeoutResponse / commandsTX` — the real RF-reliability signal — **not** `commandsDroppedTX`, which stays near-zero on RF ACK loss (a lost link marks a node *dead* while the drop counter never moves; RESEARCH.md §0). `RATE` maps `protocolDataRate` via `{1:'9.6k', 2:'40k', 3:'100k', 4:'LR'}`. `ROUTE`/`HOP` read the LWR repeater chain; Long-Range nodes show `·LR` / `direct·LR`.

**Summary telemetry strip** (`telemetryStrip`): `NODES / ONLINE / DEAD / ASLEEP / FLAKY` counts, a `NOISE` field (`—` when `hasRealNoise()` is false), and a `MESH ████░░ NN%` meter where `meshFrac = (total − dead − flaky) / total`. **Right-status** (`rightStatus`) prioritizes: link-lost/roster-stale warning → an animated `⟳ REBUILDING ROUTES` token while `controller.isRebuildingRoutes` → the live filter token → empty.

**Scrolling.** `windowStart(selected, scroll, total, cap)` (exported and reused by the Log screen) computes the first visible index so the cursor stays in view: it clamps `scroll`, pulls the window up if `selected < start`, pushes it down if `selected ≥ start + cap`, and bounds it to `max(0, total − cap)`. Overview's body cap is `max(1, H − 5)` (4 chrome rows + command bar); a `(shown/total)` counter is appended after the command bar and re-truncated to width. Empty/loading states route to `centeredNotice()`, a framed `BOX` card that also backs the other screens' notices.

### 3.7 The other screens at a glance

Each overlay reuses `frame()`, `centeredNotice()`, the `c.*` palette and the gauges, and each guards its own height so real data survives a short terminal.

- **Detail** (`detail.ts`) — a five-section per-node dossier (IDENTITY / LIVE LINK / ROUTES / TRAFFIC + a pinned flag legend). Its distinguishing mechanism is **priority-tagged graphic degradation**: augment rows (health gauge, battery gauge, SNR meter, RSSI/RTT trend sparklines, a ~2 h coarse RSSI trend) are prefixed with a `GMARK` byte + priority (`PRIO.health=1 … PRIO.rssiLong=6`); `dropGraphicsToFit()` sheds the highest-priority-number (least important) graphics first until the body fits, so dossier *values* are never dropped for a decoration. TMO here is the same `responseTimeoutPct`; the raw `commandsDroppedTX/RX` counters live honestly in TRAFFIC. Long-Range nodes show `direct to controller (Long-Range star)` instead of a mesh route.
- **Controller** (`controller.ts`) — node 1 plus a mesh roll-up: IDENTITY (home id in hex+dec, RF region, fw/SDK, primary/SUC/SIS roles), a **rebuild-routes banner present only while rebuilding** (honest elapsed time + an indeterminate sweep bar — HA exposes only the boolean, never a fake %), a TRAFFIC counter grid with a `lowGood` reliability gauge, BACKGROUND RSSI, and a NETWORK HEALTH A–F grade histogram with alive/dead/asleep and direct/routed/LR tallies. The rebuild block being conditional keeps the frame hash static (no flicker) when idle.
- **Topology** (`topology.ts`) — end nodes bucketed by LWR hop count (Direct / 1 / 2 / 3+, plus Long-Range and route-pending groups), an optional hop-distribution histogram (shown only when `bodyCap ≥ 15 && W ≥ 64`), per-node route `signalBars` (only when `W ≥ 72`), and a pinned **Repeater-load panel** where a *full* bar is *bad* (a repeater carrying many nodes is a single point of failure, coloured by load not fill). Overflow collapses to `…N more`; the repeater panel is always kept.
- **Heatmap** (`heatmap.ts`) — nodes grouped by HA area, each drawn as `heatCell`s shaded by SNR margin against `MARGIN_FULL = 25 dB`, areas stacked worst-first. Asleep/dead/unknown nodes and sentinel RSSI read as grey "no reading" (their last RSSI is stale). Each row also carries a mean-margin meter, the worst node, and a count, with widgets dropped outermost-first while ≥ `MIN_CELLS = 3` of heat strip survives.
- **Log** (`log.ts`) — the live activity stream. `logLayout(rows)` splits the frame into a list and an optional detail pane: the detail pane (`LOG_DETAIL_ROWS = 9`) appears only when `rows ≥ LOG_MIN_ROWS_FOR_DETAIL = 22`. Rows are `cursor · time · 3-letter kind tag · #node name · text`, coloured by severity (errors latch bold-red until acked). The list window uses the shared `windowStart`, and navigation/window math live together in `input.ts` so cursor and viewport can never disagree.

### 3.8 The anti-flicker 1 Hz draw loop

Both transports drive the same cadence: `setInterval(() => session.draw(), 1000)` (telnet `server.ts:299`; xterm `wsConsole.ts:391`). Input events call `session.draw()` immediately on `redraw`; the 1 s tick catches live data changes (clocks, spinners, roster refreshes). `TuiSession.draw()` (`session.ts`) makes that repaint flicker-free through four mechanisms:

1. **Frame-hash skip.** `draw()` builds the full frame body once (`HIDE_CURSOR + CURSOR_HOME`, then each line + `CLEAR_EOL`, then a trailing `CLEAR_BELOW`), hashes it with a stable 32-bit **FNV-1a** (`offset 2166136261`, `prime 16777619`, `>>> 0`, `.toString(36)`), and if the hash equals `lastFrameHash` **writes nothing at all** — no terminal work, no flicker. FNV-1a is chosen over `node:crypto` to stay off the hot path for a ~2–4 KB string.
2. **Synchronized atomic frames.** When a write does happen, the body is wrapped in `BEGIN_SYNC … END_SYNC` (mode 2026) so supporting terminals buffer and flip the whole frame atomically; the per-line `CLEAR_EOL` + trailing `CLEAR_BELOW` cover every transition without a blank-and-repaint, and `CURSOR_HOME` avoids scrolling.
3. **Draw serialization.** A `drawing` flag prevents overlapping writes (e.g. a NAWS resize firing mid-frame on top of the periodic redraw). If `draw()` is re-entered while a frame is in flight it sets `drawPending` and bails; the finishing frame honors the pending redraw on the next tick via `setImmediate` (so rapid keypress + interval coincidence doesn't grow the call stack). Input still feels instant.
4. **Forced repaints.** Mode/state transitions that must repaint even if the visible body looks similar set `lastFrameHash = ''` to defeat the skip — a successful login, an action going in-flight, an action outcome card, and the idle re-lock.

`renderLines()` selects what to draw before dispatch: login/denied gate → type-CONFIRM modal → working card → outcome card → Actions Menu → otherwise `renderScreen(ctx)`. It also defensively clamps `view.selected` into the current `visibleNodes` length, since the roster can shrink between frames.

**Resize handling.** `resize(w, h)` clamps to the supported range — **cols `[60, 200]`, rows `[16, 80]`** (the same clamps applied to the initial size in the constructor) — and returns whether the size actually changed so the transport only redraws on a real change. Because every screen respects `view.cols`/`view.rows` through the `frame()` contract and the width-aware primitives, a resize is just a re-render at new dimensions; the responsive Overview layout re-crosses its `MID_COLS`/`WIDE_COLS` breakpoints automatically.

## 4. Node Health Scoring

Every node in the mesh carries a single letter grade — A through F — that answers one question at a glance: *is this node's RF link healthy right now?* That grade, plus a 0–100 score, a 0–10 rating, a discrete `state`, and a set of single-character `flags`, is produced by one pure function, `scoreNode(node, noiseFloor)`, in `server/src/zwave/health.ts`. The render loop calls it every frame through `DataProvider.scoreFor(nodeId)`, so the function is written to be *total*: it never throws and degrades gracefully on null or partial statistics rather than crashing the TUI.

This chapter documents the exact rubric — the hard gates, the five weighted lanes, the routed-node signal neutrality rule, the TMO reliability metric, the flag glyphs, and the advisory flags that deliberately never touch the score — with every constant quoted from source and every default marked as tunable.

### 4.1 What it produces: `HealthResult`

`scoreNode` maps one `NodeSnapshot` (Chapter 3) to a `HealthResult` (`server/src/types.ts`):

```ts
interface HealthResult {
  score: number;   // 0..100
  rating: number;  // 0..10
  grade: string;   // A..F
  state: 'ok' | 'weak' | 'flaky' | 'asleep' | 'dead' | 'unknown';
  flags: string[]; // e.g. ['W','F'] — single-char flags, in documented render order
}
```

- **`score`** — the weighted composite, `clamp`ed to 0–100 and `Math.round`ed to an integer.
- **`rating`** — `clamp(Math.round(score / 10), 0, 10)`; the compact 0–10 form used in dense columns.
- **`grade`** — the A–F band from `gradeFor(score)` (§4.9).
- **`state`** — a one-word status descriptor, chosen first-match-wins (§4.10).
- **`flags`** — glyphs ordered by `orderFlags()` into the canonical `FLAG_ORDER` and de-duplicated (§4.7).

The inputs are the node's `NodeSnapshot` (its `status`, `ready`, `isLongRange`, `isController`, `battery`, `firmware`, and its `stats: NodeStats`) and a scalar `noiseFloor` (dBm) supplied by the caller from `DataProvider.noiseFloor()`.

### 4.2 Pipeline shape: hard gates first, then weighted lanes

`scoreNode` runs in two phases:

1. **Hard gates** — evaluated *before* any lane math. A gate that matches returns immediately (DEAD, missing-stats, controller) or clamps the final score (UNKNOWN). These handle the cases where lane math would be meaningless or misleading.
2. **Weighted RF lanes** — five lanes, each earning a fraction in `[0,1]` of its weight; the weights sum to 100. The composite is `100 × Σ(laneFrac × laneWeight)`.

Two pieces of state are computed once at the top and appended to *every* return path because they are lane-independent advisories, never score inputs:

```ts
const batteryLow =
  node.battery != null &&
  (node.battery.level <= BATTERY_LOW_PCT || node.battery.isLow === true); // → 'B'
const updateAvail = node.firmware?.updateAvailable === true;               // → 'U'
```

### 4.3 Hard gates

| Gate | Condition | Result |
|------|-----------|--------|
| **1 · Dead** | `status === Dead` | `score 0`, `rating 0`, `grade F`, `state 'dead'`, flag `D` (+`B`/`U` if applicable). Nothing else is meaningful once the node is unreachable. |
| **2a · No stats** | `!stats` | `score 10` (≤ `UNKNOWN_SCORE_CAP` by construction), `state 'unknown'`. Flags: `I` if `!node.ready`, plus `B`/`U`. `rating = round(10/10) = 1`, `grade F`. |
| **Controller** | `node.isController && (status Alive \|\| Awake)` | `score 100`, `rating 10`, `grade A`, `state 'ok'` (+`B`/`U`). Node 1 has no upstream link/route to score; its health lives on the Controller screen. |
| **2b · Unknown** | `status === Unknown` | Lane math runs, then `score = Math.min(score, UNKNOWN_SCORE_CAP)` (15). `state` forced to `'unknown'`. |

Two important design choices sit inside these gates:

- **DEAD is the RF-failure gate.** Per the load-bearing fact from `RESEARCH.md §0`, a listening node that stops acknowledging RF is retried by the driver and then marked **Dead** — `commandsDroppedTX` stays 0. So the hard RF-link failure is captured *here*, by the `D` gate, not by any reliability counter. (Alive↔Dead *flapping* over time is a separate signal owned by the symptom engine, Chapter 5.)
- **ASLEEP is not a fault.** A sleeping FLiRS / battery node is *supposed* to be unreachable, so its Reachability lane is credited in full (§4.4) rather than penalised. `isAsleep = status === Asleep`.

### 4.4 The five weighted lanes

Every lane returns a fraction in `[0,1]`; the composite multiplies each by its weight. The default (non-LR) weights and their Long-Range redistribution:

```ts
const w = isLR
  ? { reach: 0.30, signal: 0.35, route: 0.00, tx: 0.30, interview: 0.05 }
  : { reach: 0.30, signal: 0.25, route: 0.20, tx: 0.20, interview: 0.05 };
```

`isLR = node.isLongRange || node.nodeId >= LR_NODE_ID` (`LR_NODE_ID = 256`). Long-Range nodes talk *directly* to the controller in a star topology — mesh routing is meaningless — so the 20% Route weight is redistributed evenly into Signal (25→35%) and Response Reliability (20→30%). Both weight sets sum to exactly 1.00.

#### Lane 1 — Reachability (30%)

Credits how confidently we believe the node is reachable *now*:

```ts
const aliveNow = status === Alive || status === Awake;
if (isAsleep || aliveNow)      reachFrac = 1;      // authoritative alive-poll → full credit
else if (stats.lastSeen == null) reachFrac = 0.5;  // no evidence either way
else {
  const age = Math.max(0, Date.now() - stats.lastSeen);
  reachFrac = age <= REACH_FRESH_MS ? 1
            : clamp((REACH_STALE_MS - age) / (REACH_STALE_MS - REACH_FRESH_MS), 0, 1);
  if (age > STALE_FLAG_MS) flags.add('S');
}
```

The controller's alive-poll (`network_status`) is **authoritative**: an Alive or Awake node earns full reachability credit *regardless of how stale its detailed statistics are*. Detailed `NodeStats` push only on node activity, so a quiet-but-alive mains node must not decay into a false `S` (stale) flag. The `lastSeen`-age decay and the `S` flag are therefore reserved for a node that is **not** confirmed alive — in practice an `Unknown`-status node (Dead is gated, controller and alive/awake are credited). The freshness ramp: full credit up to `REACH_FRESH_MS` (30 min), linearly to zero by `REACH_STALE_MS` (6 h); the `S` flag fires past `STALE_FLAG_MS` (2 h).

#### Lane 2 — Signal (25%, or 35% for LR)

SNR margin of the node's RSSI over the live noise floor:

```ts
const nf = (Number.isFinite(noiseFloor) && noiseFloor < 0 && noiseFloor > -120)
  ? noiseFloor : DEFAULT_NOISE_FLOOR;                 // -95 fallback
const routed = !isLR && (stats.lwr?.repeaters?.length ?? 0) > 0;
const rssi = validRssi(stats.rssi) ?? validRssi(stats.lwr?.rssi ?? null);
if (rssi == null || routed) signalFrac = 0.7;        // neutral, NO W flag
else {
  const margin = rssi - nf;
  signalFrac = linstep(margin, SIGNAL_MARGIN_LO, SIGNAL_MARGIN_HI); // linstep(margin, 0, 14)
  if (margin < WEAK_MARGIN_DB) flags.add('W');       // margin < 7 dB
}
```

The margin window `[0, 14]` dB maps onto `[0, 1]`; the `W` (weak) threshold of 7 dB lands exactly at the midpoint (`signalFrac = 0.5`). The noise floor is validated to a plausible dBm range (`< 0` and `> -120`); anything else falls back to `DEFAULT_NOISE_FLOOR = -95` (a tunable, exported so `dataProvider` and the scorer agree on one value). See §4.5 for the routed-node neutrality rule and §4.11 for sentinel handling.

#### Lane 3 — Route (20%, folded to 0% for LR)

Combines hop count, data rate, and round-trip time, hard-docked when a route reported a failure:

```ts
if (!isLR) {
  const lwr = stats.lwr;
  if (!lwr) routeFrac = 0.7;                          // no route info yet: neutral
  else {
    const hops = Array.isArray(lwr.repeaters) ? lwr.repeaters.length : 0;
    const hopFrac  = clamp(1 - hops * 0.2, 0.2, 1);   // direct → 1, each hop −0.2, floor 0.2
    const rate = lwr.protocolDataRate;
    const rateFrac = rate === 3 || rate === 4 ? 1 : rate === 2 ? 0.6 : rate === 1 ? 0.3 : 0.7;
    const rttFrac  = stats.rtt == null ? 0.7 : 1 - linstep(stats.rtt, RTT_LO_MS, RTT_HI_MS);
    let base = mean([hopFrac, rateFrac, rttFrac]);
    const failed = lwr.routeFailedBetween != null || stats.nlwr?.routeFailedBetween != null;
    if (failed) { base *= 0.4; flags.add('R'); }
    routeFrac = base;
  }
}
```

- **Hop penalty:** each repeater subtracts 0.2 from a base of 1.0, floored at 0.2 (`hopFrac`). A direct route scores 1.0.
- **Data rate** (`protocolDataRate`, from `RouteStat`: `1=9.6k 2=40k 3=100k 4=LR`): 100k/LR → 1.0, 40k → 0.6, 9.6k → 0.3, unknown/null → 0.7 neutral.
- **RTT:** `1 − linstep(rtt, 100, 1000)` — full credit at ≤100 ms, zero by ≥1000 ms; `null` → 0.7 neutral.
- The three sub-fractions are averaged with `mean()`. If **either** the LWR or NLWR route reports a `routeFailedBetween` pair, the averaged base is multiplied by **0.4** and the `R` flag fires.

The Route lane is skipped entirely for LR nodes (`routeFrac` stays 0 but its weight is 0, so it contributes nothing).

**Latency advisory (`L`)** — computed just after the route lane, independent of LR: a sustained round-trip worth surfacing even when the weighted route lane alone can't drop the grade:

```ts
if (stats.rtt != null && stats.rtt > RTT_HI_MS) flags.add('L'); // rtt > 1000 ms
```

#### Lane 4 — Response Reliability (20%, or 30% for LR) — the TMO lane

This is the lane the whole design hinges on. It measures **response timeouts over commands sent** — `timeoutResponse / commandsTX` — and **nothing else**:

```ts
if (stats.commandsTX <= 0) txFrac = 0.85;             // nothing sent yet: benefit of the doubt, no flag
else {
  const errRate = stats.timeoutResponse / stats.commandsTX;
  txFrac = 1 - linstep(errRate, 0, TX_ERR_FLOOR);     // linstep(errRate, 0, 0.3)
  if (errRate > TX_ERR_THRESHOLD) { flags.add('F'); flaky = true; } // errRate > 0.15
}
```

The reliability curve: `txFrac` is 1.0 at zero timeouts, ramps linearly to 0.0 by `TX_ERR_FLOOR = 0.3` (a 30% timeout rate zeroes the lane). The `F` (flaky) flag fires above `TX_ERR_THRESHOLD = 0.15` (15%), and also latches `flaky = true`, which promotes the node's `state` to `'flaky'` (§4.10).

**Why `timeoutResponse`, not `commandsDroppedTX`** (`RESEARCH.md §0`, load-bearing): `commandsDroppedTX` does **not** track RF ACK failures. When a listening node stops acknowledging, the driver retries and marks it Dead (the `D` gate handles that) while the drop counter stays 0 — it was near-silent for `NoAck`, controller-cannot-send, and Get-timeout against zwave-js@15.25.3. It ticks only on a NOK transmit report and can even false-positive on premature-response aborts that actually succeeded. So it is silent for the failure it names and noisy otherwise. `timeoutResponse` is the honest, node-stays-Alive signal: the node MAC-ACKed a Get (the RF link up to the ACK works) but the expected report never arrived — a return-path / responsiveness problem. The raw `commandsDroppedTX` / `commandsDroppedRX` counters are still displayed on the Detail TRAFFIC row as honest context, but never folded into the score.

#### Lane 5 — Interview (5%)

```ts
const interviewFrac = node.ready ? 1 : 0;
if (!node.ready) flags.add('I');
```

A binary lane: 1.0 if the node has completed its Z-Wave interview (`node.ready`), 0.0 otherwise, with the `I` flag.

### 4.5 Routed nodes: RSSI is the last hop, not the device

The most important correctness rule in the Signal lane. `NodeStatistics.rssi` is fed *exclusively* from the RSSI of the node's ACK **as measured at the controller**. For a routed node, that ACK's final hop is repeater→controller — so the value describes the **last hop**, not the end device's link. Scoring the device's "signal" from it, or raising a `W` flag on it, would be confidently wrong.

The guard: `routed = !isLR && (stats.lwr?.repeaters?.length ?? 0) > 0`. When a non-LR node has one or more repeaters in its last working route, the Signal lane returns the **neutral 0.7** and never raises `W`, exactly as when no usable RSSI exists at all. Only **direct** nodes (no repeaters) and LR nodes — whose controller-measured RSSI genuinely *is* the device link — get scored on the SNR margin. This is the source of the "RSSI is neutral for routed nodes" behavior surfaced throughout the TUI.

### 4.6 The shared TMO metric: `responseTimeoutPct()`

The same `timeoutResponse / commandsTX` ratio is exposed to the UI through one exported function so the Overview **TMO** column and the Detail **Timeouts** row can never show two different figures for one node:

```ts
export function responseTimeoutPct(stats: NodeStats): number | null {
  const tx = stats.commandsTX;
  if (tx <= 0) return null;                               // nothing sent yet
  const timeouts = Math.min(stats.timeoutResponse, tx);   // clamp: can't exceed sends
  return Math.min(100, (timeouts / tx) * 100);            // percent, capped at 100
}
```

Two guards worth noting: it clamps `timeoutResponse` to `commandsTX` before dividing (a defensive cap the *lane* math in §4.4 doesn't apply, though `linstep`'s own `[0,1]` clamp makes the outcome equivalent), and it returns `null` — not 0 — when nothing has been sent, so the UI can distinguish "clean" from "no data." A documented caveat: `timeoutResponse` accrues only for Get-type traffic while `commandsTX` counts *all* successful sends, so for a SET-heavy node the rate is a conservative *under*-estimate of the true Get-failure rate — an honest floor, never an over-statement.

### 4.7 Flag glyphs and render order

Flags are collected into a `Set<string>` during scoring and emitted through `orderFlags()`, which walks the canonical order and drops duplicates:

```ts
const FLAG_ORDER = ['D', 'S', 'W', 'F', 'R', 'L', 'I', 'B', 'U'] as const;
```

| Glyph | Name | Fires when | Lane / source | Affects score? |
|-------|------|-----------|---------------|:--------------:|
| **D** | dead | `status === Dead` | Gate 1 | Yes → score 0 |
| **S** | stale | reachability `age > STALE_FLAG_MS` (2 h) on a not-alive node | Reachability | Yes (via reach decay) |
| **W** | weak signal | SNR `margin < WEAK_MARGIN_DB` (7 dB), direct/LR nodes only | Signal | Yes |
| **F** | flaky | timeout `errRate > TX_ERR_THRESHOLD` (0.15) | Response Reliability | Yes |
| **R** | route failed | LWR or NLWR reports a `routeFailedBetween` pair | Route | Yes (base × 0.4) |
| **L** | latency | `rtt > RTT_HI_MS` (1000 ms) | advisory (post-route) | No (surfacing only) |
| **I** | interview incomplete | `!node.ready` | Interview | Yes → lane 0 |
| **B** | battery low | `level <= 25` or `isLow === true` | advisory | **No** |
| **U** | firmware update | `firmware.updateAvailable === true` | advisory | **No** |

`D`, `S`, `W`, `F`, `R`, and `I` are the six lane flags that reflect the score. `L` is a pure advisory: high latency already pulls `rttFrac` down inside the route lane, so `L` exists only to surface a multi-second round-trip that the weighted lane alone might not drag below a grade boundary — it adds no additional penalty. `B` and `U` are the two truly score-independent advisories (§4.8).

### 4.8 Advisory flags that never affect the score: `B` and `U`

Battery and firmware are deliberately **separate, advisory lanes**. They append to *every* return path — including the DEAD, no-stats, and controller gates — but are never folded into the RF score:

- **`B` (battery low):** `node.battery != null && (level <= BATTERY_LOW_PCT || isLow === true)`, with `BATTERY_LOW_PCT = 25`. The rationale from the source header: *a healthy radio on a dying cell is still a healthy radio, and conflating the two hides both problems.* A node with a strong link and a 10%-battery reads grade A with a `B` flag — the operator sees both facts independently. `battery == null` means mains-powered.
- **`U` (firmware update available):** `node.firmware?.updateAvailable === true`. This flags maintenance, never a fault, so like `B` it appends without changing the score. (`node.firmware == null` = no update entity / unknown.)

Because both are computed before Gate 1, even a Dead node correctly shows `D B` or `D U` when applicable.

### 4.9 Grade bands and rating

```ts
function gradeFor(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}
```

| Grade | Score range |
|:-----:|-------------|
| A | 90–100 |
| B | 80–89 |
| C | 70–79 |
| D | 55–69 |
| F | 0–54 |

Note the non-standard boundary: the `D` band is unusually wide (55–69) and `F` begins at 54, not 59 — an intentional choice so that a node has to be genuinely broken (roughly, more than one lane failing) before it reads `F`. The `rating` is a simpler compression: `clamp(Math.round(score / 10), 0, 10)`.

### 4.10 State classification

`state` is a one-word descriptor chosen first-match-wins, *after* the composite is computed:

```ts
const weak = flags.has('W');
if (node.status === NodeStatus.Unknown) state = 'unknown';
else if (flaky) state = 'flaky';
else if (isAsleep) state = 'asleep';
else if (weak) state = 'weak';
else state = 'ok';
```

The precedence is deliberate: an actual problem (`flaky`) outranks the benign `asleep` descriptor, but `asleep` outranks a merely-weak *last-known* signal (a sleeping node's stale RSSI shouldn't read as an active problem). `dead` and (from the gates) `unknown` are set on their own return paths. Note `weak` keys off the `W` flag, so it inherits the routed-node neutrality — a routed node never reads `state: 'weak'`.

### 4.11 The composite formula and numeric helpers

```ts
let score = Math.round(
  100 * ( reachFrac    * w.reach
        + signalFrac   * w.signal
        + routeFrac    * w.route
        + txFrac       * w.tx
        + interviewFrac * w.interview )
);
score = clamp(score, 0, 100);
if (node.status === NodeStatus.Unknown) score = Math.min(score, UNKNOWN_SCORE_CAP); // 15
```

Supporting helpers, all in `health.ts`:

- **`clamp(x, lo, hi)`** — bounds `x` to `[lo, hi]`.
- **`linstep(x, lo, hi)`** — linear ramp, `lo → 0`, `hi → 1`, clamped to `[0,1]`; robust to `lo === hi` (returns `x >= hi ? 1 : 0`).
- **`mean(xs)`** — arithmetic mean, returns 0 on empty (used for the three route sub-fractions).
- **`validRssi(v)`** — returns a finite dBm value, or `null` if absent, non-finite, or a sentinel.

**RSSI sentinels.** The driver uses three RSSI values as sentinels, not real dBm: `RSSI_SENTINELS = {125, 126, 127}` (not-available / saturated / no-signal). `validRssi` excludes them from the margin math rather than treating them as +125 dBm; the Signal lane then falls back to the LWR route RSSI, and failing that to the neutral 0.7.

**Worked example** — a healthy direct mains node: `rssi = -60`, `nf = -95` → `margin = 35` → `signalFrac = 1`; direct route (`hopFrac = 1`), 100k (`rateFrac = 1`), `rtt = 150` (`rttFrac = 1 − 50/900 = 0.944`) → `routeFrac = mean([1, 1, 0.944]) = 0.981`; zero timeouts → `txFrac = 1`; `ready` → `interviewFrac = 1`; alive → `reachFrac = 1`.

```
score = 100 × (1×0.30 + 1×0.25 + 0.981×0.20 + 1×0.20 + 1×0.05)
      = 100 × (0.30 + 0.25 + 0.196 + 0.20 + 0.05)  ≈  99.6  →  round 100  →  grade A
```

### 4.12 Constants and tunables

Every threshold lives at the top of `health.ts`. Those marked *tunable default* are policy knobs a maintainer can adjust; the rest are structural.

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEFAULT_NOISE_FLOOR` | `-95` dBm | Fallback noise floor (exported, shared with `dataProvider`) — *tunable default* |
| `RSSI_SENTINELS` | `{125, 126, 127}` | Driver RSSI sentinels excluded from math |
| `WEAK_MARGIN_DB` | `7` | SNR margin below which `W` fires — *tunable default* |
| `SIGNAL_MARGIN_LO` / `_HI` | `0` / `14` | Margin window mapped to `[0,1]` (W at midpoint) — *tunable default* |
| `TX_ERR_THRESHOLD` | `0.15` | Timeout fraction above which `F` fires — *tunable default* |
| `TX_ERR_FLOOR` | `0.30` | Timeout fraction that zeroes the reliability lane — *tunable default* |
| `BATTERY_LOW_PCT` | `25` | Battery % at/under which `B` fires — *tunable default* |
| `REACH_FRESH_MS` | `1,800,000` (30 min) | Full reachability credit up to this age — *tunable default* |
| `REACH_STALE_MS` | `21,600,000` (6 h) | Reachability decays to 0 by this age — *tunable default* |
| `STALE_FLAG_MS` | `7,200,000` (2 h) | Age past which `S` fires — *tunable default* |
| `RTT_LO_MS` / `_HI_MS` | `100` / `1000` | RTT window; `L` fires above `_HI` — *tunable default* |
| `UNKNOWN_SCORE_CAP` | `15` | Score ceiling for UNKNOWN status |
| `LR_NODE_ID` | `256` | Long-Range node-id threshold (structural) |
| `FLAG_ORDER` | `[D,S,W,F,R,L,I,B,U]` | Canonical flag render order |

These are module-level `const`s, not runtime config options — tuning them is a code change, not an add-on setting.

### 4.13 Edge-case guards and robustness

`scoreNode` is a pure, total function; the render loop depends on it never throwing. The defensive guards, top to bottom:

- **Missing stats** → Gate 2a returns `state 'unknown'`, `score 10` (proven ≤ cap), never touches lane math.
- **Null `lastSeen`** → reachability defaults to 0.5 (no evidence), no `S` flag.
- **Negative clock skew** → `age = Math.max(0, Date.now() - stats.lastSeen)` prevents a future timestamp from producing a negative age.
- **Sentinel / non-finite RSSI** → excluded via `validRssi`; lane falls back to LWR RSSI then to neutral 0.7.
- **Implausible noise floor** → validated to `< 0 && > -120`; else `DEFAULT_NOISE_FLOOR`.
- **Missing / partial route** → `!lwr` yields neutral 0.7; `null` data rate → 0.7; `null` rtt → 0.7.
- **`commandsTX <= 0`** → reliability lane gives benefit of the doubt (0.85), no `F`.
- **`timeoutResponse > commandsTX`** → `responseTimeoutPct` clamps; the lane's `linstep` clamps to `[0,1]`.
- **Non-array `repeaters`** → `Array.isArray(lwr.repeaters) ? … : 0` guards hop counting.
- **`linstep` with `lo === hi`** → returns a clean 0/1 step instead of dividing by zero.
- **Final score** → `clamp(score, 0, 100)` before the UNKNOWN cap.

### 4.14 Data flow: where inputs come from and where the score goes

**In:** `zwave/zwaveData.ts` produces `NodeSnapshot[]` (status, ready, firmware, battery) and populates each node's `stats: NodeStats` from `subscribe_node_statistics` — `rssi`, `lwr`/`nlwr` `RouteStat`s, `commandsTX`, `timeoutResponse`, `lastSeen`, etc. The `noiseFloor` argument comes from `DataProvider.noiseFloor()`, derived from the controller's per-channel `backgroundRSSI` (Chapter 6), with `DataProvider.hasRealNoise()` distinguishing a live reading from the `-95` fallback.

**Out:** the render loop calls `DataProvider.scoreFor(nodeId)` — which caches `scoreNode()` — every frame. The resulting `HealthResult` drives the Overview table (grade, rating, flag column, `state` colour), the Detail screen's per-lane breakdown, the health-based sort key, and feeds the symptom engine's baselines (Chapter 5). Because scoring is a pure function of the cached snapshot, the render path never recomputes it inside `draw()`.

The route rebuild worth restating from the engine's constraints: none of these score signals ever triggers an automatic action. A low grade, an `R` flag, or a `W` flag is surfaced to the operator; any remediation flows through the type-CONFIRM Actions Menu (Chapter 7). In particular a route rebuild is never offered as a fix for a poor Route-lane score — it cannot repair a physical link, it deletes manual priority routes, and it throws on Long-Range nodes.

## 5. The Evidence Store (M2)

The evidence store is the trustworthy time-series substrate the entire remediation engine reads from. Everything downstream — the baseline learner (M3, `baselines.ts`), the symptom detectors (`symptoms.ts`), the interference watch (`interference.ts`), and the outcome verifier (`outcomes.ts`) — consumes rows from this store and nothing else. Its single job is to convert the noisy, cumulative, restart-scarred counters that `zwave-js` emits into a bounded, per-node, on-disk series in which **a number is either true or absent** — never fabricated, never silently zeroed. The implementation lives in `server/src/zwave/evidenceStore.ts`; `DESIGN.md §3.1` is its contract. The header comment states the discipline plainly: `null` means *"cannot know this window" — absence of evidence, never evidence of health.*

The store is created by `createEvidenceStore(opts)` (a closure-based factory, not a class) and wired into the poller in `zwave/zwaveData.ts:577`:

```ts
this.evidenceStore = evPath
  ? createEvidenceStore({ path: evPath, cadenceMs: this.evidenceSampleMs, log: this.log })
  : /* in-memory: null */;
```

When `EVIDENCE_PATH` is unset (bare dev), there is no store at all and the engine stays dormant.

### 5.1 Two tiers, both first-class

The store keeps two independent time horizons per node, and — critically — **staleness is per-tier**:

| Tier | Structure | Horizon | Cap constant | Feeds |
| --- | --- | --- | --- | --- |
| **Fine ring** | one `EvidenceSample` per node per sample tick | ~40 min | `DEFAULT_MAX_SAMPLES = 240` (at the 10 s cadence) | recent-window detectors + the outcome after-window verifier |
| **Coarse tier** | 30-min `CoarseBucket`s per node | 14 days | `DEFAULT_COARSE_HORIZON_MS = 14·24·60·60·1000` | the baseline substrate (bands are multi-hour) |

The two are held in separate maps: `const fine: EvidenceMap = new Map()` and `const coarse = new Map<number, CoarseBucket[]>()`. The fine ring has a **1 h staleness gate** (`DEFAULT_MAX_AGE_MS = 60·60·1000`) that applies *only* to it on load; coarse buckets are pruned individually to the 14-day horizon. A 3-day-old coarse bucket is valid history, not stale state. The load-time reasoning is explicit in the header: *"a daily power blip cannot wipe two weeks of baseline history."* `COARSE_BUCKET_MS = 30·60·1000` is exported because the baseline layer needs the same bucket alignment.

### 5.2 The per-sample shape

Each fine-ring row is an `EvidenceSample`:

```ts
interface EvidenceSample {
  t: number;                       // capture time (epoch ms)
  dTx:      number | null;         // Δ commandsTX      over the window
  dTimeout: number | null;         // Δ timeoutResponse over the window  ← primary RF signal
  dDropTx:  number | null;         // Δ commandsDroppedTX
  dRx:      number | null;         // Δ commandsRX
  dFlaps:        number;           // Alive↔Dead transitions (event-accumulated, always concrete)
  dRouteChanges: number;           // LWR route changes     (event-accumulated, always concrete)
  fresh: boolean;                  // did a stats event actually arrive this window?
  rtt:      number | null;         // driver EMA, rounded to 0.1; meaningful ONLY when fresh
  rssi:     number | null;         // driver EMA, sentinels ≥125 → null; meaningful ONLY when fresh
  rateKbps: number | null;         // LWR protocolDataRate mapped to kbps
  routeKey: string | null;         // 'direct' | 'r5-8-...' — the repeater path
  status: NodeStatus;              // roster level at capture — dwell context, NEVER diffed for flaps
  lastSeen:  number | null;        // driver-WS (v0.13) real last-communication time
  isListening:          boolean | null; // driver-WS (v0.13)
  isFrequentListening:  boolean | null; // driver-WS (v0.13) — FLiRS/beaming vs sleeping-battery
}
```

Two field families carry the design's hardest-won lessons:

- **`dTimeout` is the primary reliability signal, not `dDropTx`.** Per `RESEARCH.md §0`, `commandsDroppedTX` does **not** count RF ACK failures — an RF failure marks the node **DEAD** while that counter stays 0. The real RF-failure signals are (a) `dFlaps` (Alive↔Dead status transitions) and (b) `dTimeout` (a `Get` whose reply never arrived, with the node staying Alive). The TUI's reliability metric is therefore `timeoutResponse/commandsTX` (shown as **TMO**), and `dDropTx` is captured only for completeness.

- **`dFlaps` / `dRouteChanges` are event-accumulated, never level-sampled.** The `status` column is *dwell context only.* Sub-window Alive↔Dead flaps are invisible to level-sampling by construction, so the caller accumulates them from `zwave_js/subscribe_node_status` events (`flapAccum` in `zwaveData.ts:1150` / `:1577`) and from the route-change diff (`routeChangeAccum`, `:1766`), then **drains** them into each sample. The header calls this "the design review's core catch." Because they are drains, `dFlaps` and `dRouteChanges` are always concrete integers, even when the counter deltas are `null`.

`rssi`/`rtt` are re-sampled driver EMAs and carry information **only when `fresh`** — otherwise they are pseudo-replicated identical readings that would collapse downstream MAD (median absolute deviation) to 0. `rssi` is passed through `cleanRssi()`, which nulls the driver sentinels (`RSSI_SENTINEL_MIN = 125`: 125 no-signal, 126 saturated, 127 not-available) and any non-finite value. `rateKbps` maps `lwr.protocolDataRate` through `RATE_KBPS = { 1: 9.6, 2: 40, 3: 100, 4: 100 }` (4 = Long-Range 100k). `routeKey` is `'direct'` when there are no repeaters, else `'r' + repeaters.join('-')`.

### 5.3 Counter discipline (cumulative → delta, four guards)

The `zwave-js` counters are **cumulative since driver start**. `guardedDeltas(prev, cur)` turns two snapshots into a windowed delta and enforces four guards, in order. Any guard tripping returns all four deltas as `null` and flags the window `invalid: true`:

```ts
function guardedDeltas(prev, cur) {
  if (!prev) return { …null, invalid: true };                 // 1. no baseline yet
  const windowMs = cur.t - prev.t;
  if (windowMs <= 0 || windowMs > maxWindowMs)                 // 2. MAX-WINDOW bound
    return { …null, invalid: true };
  if (cur.tx < prev.tx || cur.timeout < prev.timeout ||        // 3. WHOLE-WINDOW invalidation
      cur.dropTx < prev.dropTx || cur.rx < prev.rx)
    return { …null, invalid: true };
  const dTx = cur.tx - prev.tx; /* …etc */
  const cap = (windowMs / 1000) * maxDeltaPerSec;              // 4. PLAUSIBILITY bound
  if (dTx > cap || dTimeout > cap || dDropTx > cap || dRx > cap)
    return { …null, invalid: true };  // logged once via implausibleLogged
  return { dTx, dTimeout, dDropTx, dRx, invalid: false };
}
```

| Guard | Rule | Constant | Rationale |
| --- | --- | --- | --- |
| **Whole-window invalidation** | if **any** of the four counters moved backward, **all** deltas for that sample are null | — | One driver, one restart, one shared lifetime. Per-field nulling let a cross-lifetime delta on one field masquerade as valid. |
| **Max-window bound** | a gap `> 3× cadence` (or `≤ 0`) nulls all deltas and re-baselines | `MAX_WINDOW_CADENCES = 3` → `maxWindowMs = cadenceMs·3` (30 s at 10 s cadence) | Long gaps are not time-attributable. |
| **Plausibility cap** | a delta exceeding `(windowMs/1000)·maxDeltaPerSec` is nulled + logged once | `DEFAULT_MAX_DELTA_PER_SEC = 40` msg/s | Z-Wave's shared bandwidth is ~10–20 msg/s mesh-wide, so 40/s per node is safely impossible. This is the backstop against a fabricated full-lifetime delta. |
| **No baseline** | the first sample after start/reset has no `prev` → null + invalid | — | Nothing to difference against. |

There is a fifth guard **upstream, at the source.** `onNodeStats` (`zwaveData.ts:1702`) runs `statsCounters(e)` and, if any counter field is missing or non-finite, **rejects the whole event** rather than coercing it to 0 — the previous cached stats stay authoritative. The comment names the exact failure this prevents: a coerced-0 snapshot re-baselines the deltas at zero, and the next real cumulative value then lands as "one giant fabricated 'valid' delta." The store's plausibility cap is the second line of defense should such a value ever reach `record()`.

`implausibleLogged` is a process-lifetime latch so the implausibility warning is emitted at most once, not on every poll.

### 5.4 The `fresh` flag (pseudo-replication guard)

`fresh` answers "did a real stats event arrive since the previous sample?" It is computed by the caller in `isFreshSample(prev, stats)` (`zwaveData.ts:1918`) and requires **both** conjuncts:

```ts
function isFreshSample(prev, stats) {
  if (prev == null) return false;                    // first-ever sample is NOT fresh
  const seenAdvanced  = (stats.lastSeen ?? 0) > 0 && stats.lastSeen !== prev.seen;
  const countersMoved = stats.commandsTX !== prev.tx || stats.commandsRX !== prev.rx ||
                        stats.timeoutResponse !== prev.to || stats.commandsDroppedTX !== prev.dr;
  return seenAdvanced && countersMoved;
}
```

The AND is load-bearing: a **(re)subscribe** redelivers the current snapshot under a fresh `lastSeen` while every counter is unchanged. Treating that replay as an observation is the pseudo-replication leak that would drive downstream MAD to 0 and manufacture false confidence. Inside the store, `fresh` gates every re-sampled EMA aggregate — the coarse fold only counts `rssi`/`rtt`/`rate` into a bucket `if (s.fresh && …)`, and `NodeCoverage.freshSamples` counts only genuine observations.

### 5.5 The coarse fold

Every recorded sample is immediately folded into its node's current 30-min bucket by `foldCoarse(nodeId, s, invalid)`. The bucket start is `t0 = Math.floor(s.t / COARSE_BUCKET_MS) * COARSE_BUCKET_MS`. A `CoarseBucket` sums **only valid deltas** and aggregates **only fresh** EMA observations:

```ts
interface CoarseBucket {
  t0: number;                              // aligned bucket start
  n: number; freshN: number; invalidW: number;   // sample / fresh / invalid-window counts
  dTx; dTimeout; dDropTx; dRx;             // Σ of VALID deltas only
  flaps; routeChanges;                     // Σ of the event drains
  rssiN; rssiSum; rssiMin; rssiMax;        // over FRESH rssi only
  rttN; rttSum;                            // over FRESH rtt only
  rateMin;                                 // worst (lowest) negotiated rate seen
}
```

The fold has a **backward-clock-step guard**: if a sample's `t0` lands in an *earlier* bucket than the ring's last (an NTP step-back), it never appends an out-of-order or duplicate `t0`. It searches back up to 4 buckets for an exact `t0` match to fold into; if none is nearby it **drops the fold** (the fine tier has already nulled that sample's deltas anyway). Pruning to the horizon happens cheaply, only when a new bucket is born: `while (ring[0].t0 < s.t - coarseHorizonMs) ring.shift()`.

An all-quiet bucket — no fresh observations, no events, no traffic — is **omitted from disk** by `bucketWorthPersisting(b)`. A missing bucket contributes exactly what it should to a baseline: nothing. On load, `normalizeCoarseRing()` re-sorts by `t0` and **merges duplicate-`t0` buckets**, repairing any ring written by the pre-fix fold after a clock step.

### 5.6 The controller ring (+ reserved background channels)

There is **one** controller ring (`ctrlRing`, capped at `CTRL_MAX_SAMPLES = 240`), not one per node. `recordController(stats, fresh, at, bg)` runs the controller's serial-link counters (`messagesTX`, `messagesDroppedTX`, `NAK`, `CAN`, `timeoutACK`, `timeoutResponse`) through the **same** delta discipline, producing a `ControllerSample`. The plausibility cap is looser here — `ctrlCap = (windowMs/1000) · maxDeltaPerSec · 10` — because the host↔stick serial link carries far more than any single node's RF; a lifetime-sized jump is still orders of magnitude beyond it. Backward-counter and window guards are identical.

The `bg0..bg3` fields hold the **per-channel background RSSI** (the mesh noise floor). They were reserved at M2 and are populated by the v0.13 read-only driver-WS client: the caller only passes `bg` when the reading is fresh (`≤ 90 s` old) and the driver's homeId matches HA's (`driverHomeOk()`); a stale reading is recorded as `null`, not re-used. The interference watch (M6) reads these channels.

### 5.7 Route-failure ring, coverage metadata

`recordRouteFailure(nodeId, between, at)` latches a `routeFailedBetween` event the moment it appears — this datum is transient (overwritten on the next successful transmission), so it must be captured event-driven, never by polling. Each node keeps a small ring capped at `ROUTE_FAIL_RING = 20`; `between` is the `[last-functional, first-non-functional]` node-id pair.

`NodeCoverage` is the metadata that **survives ring eviction and restarts** so that "no evidence rows" is distinguishable from "node never communicated" — the ghost detector depends on this distinction:

```ts
interface NodeCoverage { firstSeenAt: number; samples: number; freshSamples: number; }
```

`registerNode(nodeId)` (called for **every** roster node each tick, even before its first stats event) is idempotent and seeds `firstSeenAt`. Store-level `recordingSince()` records when collection first began. `samples`/`freshSamples` are cumulative and *not* ring-bounded. `evictNode(nodeId)` wipes **all** state for a node that left the network — after `replace_failed_node`, a reused node-id must start from a clean slate, or inherited history would merge two physical devices and pre-satisfy the ghost detector's coverage precondition.

### 5.8 homeId binding + reset-through-to-disk

The persisted envelope carries the controller `homeId`. `bindHomeId(id)` is called on the first poll that reveals the live home id (`zwaveData.ts:1271`). On a mismatch with the loaded/live id it calls `reset()`:

```ts
bindHomeId(id) {
  if (homeId === id) return;
  const conflict = (loadedHomeId != null && loadedHomeId !== id) || (homeId != null && homeId !== id);
  homeId = id; loadedHomeId = id;
  if (conflict) { log('controller home id changed — discarding …'); this.reset(); }
}
```

`reset()` clears every in-memory structure, nulls `since`, and — the key durability guarantee — sets `dirty = true` and **immediately calls `save()`**. A stick swap while the add-on was stopped, followed by a crash before the next scheduled flush, must not resurrect another network's rings under this network's node ids. `load()` performs the same cross-check: a persisted `homeId ≠ live homeId` starts fresh.

### 5.9 Persistence: atomic, columnar, dirty-flagged

The on-disk format (`interface Persisted`, `SCHEMA_V = 2`) is genuinely **columnar** — parallel arrays per field per node (`FineCols`, `CoarseCols`, `CtrlCols`) rather than an array of objects, which keeps the file small and cheap to parse. `save()`:

- is a **no-op when `!dirty`** — avoids SD-card write amplification;
- **prunes again at save time** (`saveCutoff = now() - coarseHorizonMs`) so a node that stopped sampling can't serve beyond-horizon buckets forever, and drops all-quiet buckets via `bucketWorthPersisting`;
- writes **atomically**: `writeFileSync(tmp, …)` then `renameSync(tmp, path)`, where `tmp = ${path}.tmp` — a crash mid-write leaves the old good file intact;
- **never throws** — a failed write is logged and swallowed.

Flushes are driven on a **~5-minute cadence** (`EVIDENCE_FLUSH_MS`, default `300_000`) plus an explicit save on shutdown — not a fixed full-file rewrite every tick.

### 5.10 Load path + host-boot grace

`load()` reconstructs state with a careful ordering the review flagged as "a data-destroyer" if gotten wrong. The pivotal variable is **boot grace**:

```ts
const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs;   // DEFAULT_BOOT_GRACE_MS = 180_000
```

`uptimeMs()` is host uptime (`os.uptime()·1000`). On a no-RTC host, the clock restores *behind* the last flush's `savedAt` after a power blip, so `ageMs = now() - savedAt < 0` is the **normal** post-blip state — it means the clock is bogus *now*, not that the file is bad. Grace is evaluated first, so:

- `savedAt <= 0` (bogus at *save* time) → start fresh unconditionally;
- `!grace && ageMs < 0` (future-dated with a *trusted* clock) → start fresh;
- `fineTooOld = grace || (maxAgeMs > 0 && ageMs > maxAgeMs) || ageMs < 0`.

Under grace or when the fine ring is too old, the store **still loads the coarse tier, coverage metadata, controller ring, and route-failure rings** — dropping *only* the recency-dependent fine ring. Coarse pruning is even skipped under grace (`if (!grace && t0 < cutoff) continue`) because the clock can't be trusted to judge "old." The fine tier is loaded only when `!grace && !fineTooOld`. The controller ring restore was added by the review after it was found to be write-only and silently dropped on every restart. Each loaded field is validated (finite `t`, integer node id > 0, `status` clamped to `0..4` else `NodeStatus.Unknown`), the fine ring is re-bounded to `maxSamples`, and a top-level `try/catch` starts fresh on any parse failure.

### 5.11 Config knobs

| Env / option | Default | Effect |
| --- | --- | --- |
| `EVIDENCE_PATH` → `path` | `null` (in-memory, engine dormant) | on-disk location, e.g. `/data/evidence.json` |
| `EVIDENCE_SAMPLE_MS` → `cadenceMs` | `routePollMs` (falls back to ~2 s `REFRESH_INTERVAL_MS`) | sample cadence; **drives `maxWindowMs = cadenceMs·3`** |
| `EVIDENCE_FLUSH_MS` → `evidenceFlushMs` | `300_000` (5 min) | dirty-flush interval |
| `maxSamples` | `DEFAULT_MAX_SAMPLES = 240` | fine-ring cap per node |
| `maxAgeMs` | `DEFAULT_MAX_AGE_MS = 3_600_000` | **fine-tier-only** staleness; `0` = never |
| `coarseHorizonMs` | `DEFAULT_COARSE_HORIZON_MS = 14 d` | coarse prune horizon |
| `bootGraceMs` | `DEFAULT_BOOT_GRACE_MS = 180_000` | distrust recency while host uptime is below this; `0` = off |
| `maxDeltaPerSec` | `DEFAULT_MAX_DELTA_PER_SEC = 40` | plausibility cap (msg/s) |

Note that `DEFAULT_CADENCE_MS = 10_000` inside the store is the fallback if the caller supplies nothing; in production the caller passes `cadenceMs = evidenceSampleMs`, which resolves to `routePollMs`.

### 5.12 Size budget

The bounds are enforced by test, not asserted. Worst case per node: fine `240 × 10 s` + coarse `672 × 30 min` (14 days), every column at maximal width, serialized ≤ **80 KB/node**. That is ≈ 3 MB for the live 39-node mesh and scales linearly (a 232-node mesh ≈ 19 MB on `/data`). Typical real files run far smaller because sparse/quiet buckets and quiet columns are omitted. A unit test enforces the per-node worst case.

### 5.13 Data flow: how one tick becomes evidence

The producer is `zwaveData.sampleEvidence()` (`zwaveData.ts:741`), fired on `evidenceSampleTimer` every `evidenceSampleMs`:

1. **Wedge guard first.** `if (lastOkAt == null || now - lastOkAt > max(2·refreshMs, 10_000)) return;` — if the roster/stats feed is itself stale, the whole tick is skipped. A gap in the ring is honest; a fabricated healthy window is not.
2. For each roster node: `registerNode(nodeId, now)` (coverage), then look up cached `statsByNode`. **A node with no cached stats is skipped** — fabricating zero counters would poison the delta guards; its flap/route events stay accumulated and drain into its first real sample.
3. Compute `fresh = isFreshSample(prev, stats)`; update the freshness signature; drain and delete `flapAccum` / `routeChangeAccum`.
4. Attach driver-WS telemetry (`lastSeen`, `isListening`, `isFrequentListening`) or `null`.
5. `record(...)` → `guardedDeltas` → push to fine ring (bounded) → `foldCoarse` → bump coverage → `dirty = true`.
6. Controller: `ctrlFresh = ctrlStats !== prevCtrlStatsRef`; attach `bg` RSSI only if `≤ 90 s` fresh and `driverHomeOk()`; `recordController(...)`.
7. `runEngine(now)` — the just-recorded samples are read straight back out via `forNode` / `coarseForNode` / `controllerSamples` / `routeFailures` / `coverage` by `detectSymptoms(...)`, then folded into baselines (quarantining symptomatic nodes so the baseline never chases the pathology).

On shutdown (`zwaveData.ts:1041`) the store is flushed once more. The reader side — `baselines.ts`, `symptoms.ts`, `interference.ts`, `outcomes.ts` — never mutates the store; it only queries the accessor methods, which return the live in-memory arrays (`forNode` returns `fine.get(nodeId) ?? []`).

## 6. Read-Only Driver-WS Evidence Client (v0.13)

The engine's single most valuable diagnostic — the real RF **noise floor** — is one that Home Assistant's WebSocket API refuses to hand over. `driverWsClient.ts` (shipped in v0.13, specified in DESIGN.md §2.1) is the strictly read-only side-channel that recovers it, alongside two other driver-only signals HA drops (per-node `lastSeen` and the `isListening`/FLiRS capability flags). It is the one place in the add-on that talks to a second WebSocket — `ws://core-zwave-js:3000`, the zwave-js-server the official Z-Wave JS add-on hosts on the HA internal network — and it does so under a set of hard, non-negotiable safety constraints because that socket is **unauthenticated and privileged**.

The whole client is a single factory, `createDriverWsClient(opts)`, returning a `DriverWsClient` handle (`start`/`stop`/`state`/`status`/`schema`/`homeId`). It never mutates the mesh, never transmits RF, and can never cause the add-on to fail to start. Every failure mode — unreachable server, wrong schema, wrong network — collapses to **dormancy**: the dependent telemetry stays `null`, the detectors that need it stay dormant and say so, and the rest of the add-on runs exactly as it did before v0.13. This is the design's "collapse method, never measurement" tenet applied to an entire data source.

### 6.1 Why HA WS cannot provide the noise floor

The reason this client exists at all is a specific, verified gap in HA's Z-Wave integration, documented in RESEARCH.md §1.5 and §3.2.

The Z-Wave JS driver *does* measure background RSSI. `ControllerStatistics.backgroundRSSI` holds a per-channel `{average, current}` for channels 0/1 (mandatory) and 2/3 (optional), auto-polled whenever the send queue is idle ≥ 5 s, at most every 30 s, as an EMA with α = 0.9 (RESEARCH §1.5). The Python client library parses it. But HA's `zwave_js` integration (`api.py`) subscribes to controller statistics and **forwards only** `messages_tx/rx`, `dropped_tx/rx`, `nak`, `can`, `timeout_ack`, `timeout_response`, and `timeout_callback`. As RESEARCH §1.5 records it:

> `background_rssi` is silently dropped at HA's WS boundary, even though the python lib parses it. Noise-floor / SNR analysis is impossible through HA today.

RESEARCH §3.2 confirms the same absence for the whole active-diagnostic toolkit (`check_lifeline_health`, `background_rssi`, `get_node_neighbors`, priority routes, etc.): the library implements them, but HA Core never wired them to WS commands. The consequence stated there is decisive — "priority routes, neighbors, and background RSSI require the driver-WS phase." Interference monitoring, a top user priority, is therefore *impossible* through HA alone. The noise floor is not an EMA HA is late in sending; it is a field HA structurally strips. The only way to read it is to connect to the driver's own WebSocket, which is precisely what this client does — and nothing more.

### 6.2 Security posture and the closed command allowlist

Because `ws://core-zwave-js:3000` has **no authentication** (the official add-on declares `ports: 3000/tcp: null`, reachable only by internal DNS — RESEARCH §3.3), anything reachable on it is reachable *unconditionally*, including full route surgery, health checks that flash lights, and destructive node removal. The client's governing rule is therefore that it may issue only passive commands, enforced in code rather than by convention.

The allowlist is a frozen constant:

```ts
export const DRIVER_WS_ALLOWLIST: readonly string[] = Object.freeze([
  'set_api_schema',
  'start_listening',
]);
```

Every outbound frame goes through one `send(command, extra)` chokepoint that throws on anything else:

```ts
function send(command: string, extra: Record<string, unknown> = {}): void {
  if (!DRIVER_WS_ALLOWLIST.includes(command)) {
    throw new Error(`driver-ws: command '${command}' is not on the read-only allowlist`);
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ...extra, command, messageId: `dw-${++msgId}` }));
}
```

Two subtleties are load-bearing:

- **`set_api_schema` and `start_listening` only.** No `ping`, no health check, no route command — nothing that transmits RF. `start_listening` returns the full state dump and then streams passive statistics events; `set_api_schema` merely pins the wire format. All mesh-mutating actions stay on the *authenticated* HA WS through the existing `ActionRunner` chokepoint (DESIGN §2). The driver WS is never used for anything that changes state.
- **Spread order defends the allowlist.** `extra` is spread *first* so the checked `command` and the generated `messageId` always win. A caller (or a future bug) that passed `extra.command = 'remove_failed_node'` alongside an allowlisted `command` cannot smuggle it through — the object literal's own `command` key overwrites the spread. The v0.13 review flagged this precise spread-order bypass; the fix is the field ordering in the `JSON.stringify` payload.

The header comment states the re-exposure rule flatly: nothing received here is ever proxied or re-exposed — not to the TUI transport, not to ingress, not verbatim to logs. Logs carry types and counts, never payloads (§6.6).

### 6.3 Schema negotiation: 32–41, dormant-not-fatal

zwave-js-server pushes a `version` frame on connect: `{type:'version', homeId, driverVersion, serverVersion, minSchemaVersion, maxSchemaVersion}`. The client negotiates a schema version it knows how to parse, within a tested band:

```ts
export const DRIVER_SCHEMA_MIN = 32;
export const DRIVER_SCHEMA_MAX = 41;
```

The floor of 32 is not arbitrary: the driver renamed commands at schema 32 (`heal_node` → `rebuild_node_routes`, RESEARCH §3.3), which is the tested floor for the surrounding engine's vocabulary. The ceiling of 41 is simply the highest schema this client's parsing has been validated against — both are tunable constants, bumped as the parser is re-tested against newer servers.

The `version`-frame handler in `onMessage` computes:

```ts
const negotiated = Math.min(serverMax, DRIVER_SCHEMA_MAX);   // ask for the highest we both grok
if (negotiated < DRIVER_SCHEMA_MIN || serverMin > negotiated) {
  // permanent dormancy — a server's schema range doesn't change mid-life
  teardownSocket();
  setState('dormant', `schema mismatch (server ${serverMin}..${serverMax}, tested ${DRIVER_SCHEMA_MIN}..${DRIVER_SCHEMA_MAX}) — driver telemetry dormant`);
  return;
}
negotiatedSchema = negotiated;
send('set_api_schema', { schemaVersion: negotiated });
send('start_listening');
```

Handshake outcomes:

| condition | result | rationale |
| --- | --- | --- |
| `serverMax <= 0` (no usable range / garbage handshake) | `dormant`, socket torn down | wrong endpoint or malformed peer — not a zwave-js-server we understand |
| `min(serverMax, 41) < 32` | `dormant` | server too old — the renamed commands land at 32, our floor |
| `serverMin > negotiated` | `dormant` | server refuses everything ≤ our ceiling — outside the tested band |
| otherwise | `set_api_schema` + `start_listening`, then `live` | negotiate `min(serverMax, 41)`, refuse below 32 |

Crucially, schema mismatch is **permanent dormancy, not a retried failure**: a running server does not change its schema range mid-life, so retrying would only churn. The `'dormant'` state is a latch — `scheduleReconnect` and `connect` both early-return on it — so a mismatched server is left alone until an explicit fresh `start()` (which clears the latch, e.g. after a config fix + restart). Connection *loss*, by contrast, is transient and *is* retried (§6.5). Dormancy is never fatal to the add-on: the negotiated schema is logged, the dependent telemetry stays `null`, and the interference/quiet-node/capability-dependent detectors report their own dormancy honestly.

### 6.4 Ping/pong liveness — keeping a healthy-but-idle socket alive

A naive "no bytes in N seconds ⇒ reconnect" liveness check would be actively wrong for this data source. A quiet all-battery mesh, or a 500-series controller that never runs `GetBackgroundRSSI`, legitimately sends *no application messages* for long stretches. Killing that healthy socket every `livenessMs` would churn reconnects all night. So liveness is a **WS protocol ping/pong probe**, not application traffic.

`lastMsgAt` is bumped on `open`, on every `message`, and on every `pong`. An interval timer (installed in the `open` handler) runs at a quarter of the timeout and enforces a two-stage rule:

```ts
const livenessMs = opts.livenessMs ?? 5 * 60_000;               // default 5 min
const checkMs = Math.max(250, Math.min(livenessMs / 4, 30_000)); // tick cadence
livenessTimer = setInterval(() => {
  const idle = Date.now() - lastMsgAt;
  if (idle > livenessMs) {                       // neither app-msg NOR pong for a full window
    teardownSocket();
    scheduleReconnect('liveness timeout');       // truly wedged → reconnect
  } else if (idle >= livenessMs / 2 && ws?.readyState === WebSocket.OPEN) {
    ws.ping();                                    // half-interval nudge; the pong resets idle
  }
}, checkMs);
```

The `sock.on('pong', …)` handler resets `lastMsgAt`, so a live-but-idle socket answers the half-interval ping and is kept up. Only a peer that answers *neither* application traffic *nor* pings within the full `livenessMs` is terminated and reconnected. The quarter-interval `checkMs` is deliberate: it guarantees the probe ping (at half the timeout) and its pong land *well* before the terminate threshold. If the check ran at the half-interval, the ping tick and the terminate tick would coincide and a healthy socket's survival would be a coin-flip — the v0.13 review caught exactly this. Every timer is `.unref()`'d so it never holds the event loop open at shutdown.

### 6.5 Connection lifecycle and reconnect backoff

`connect()` tears down any prior socket, opens a new `WebSocket(url, { maxPayload: 32 MiB, handshakeTimeout: 10_000 })`, and wires the `open`/`pong`/`message`/`error`/`close` handlers. The state machine surfaced by `state()`:

```
disabled → (no url; permanently off)
connecting → handshake → live       (happy path)
              │            │
              └── dormant  └── backoff → connecting …   (transient loss, retried)
stopped   (stop() called; a later start() re-establishes)
```

Reconnect uses capped exponential backoff, computed in `scheduleReconnect`:

```ts
const reconnectBaseMs = opts.reconnectBaseMs ?? 5_000;
const reconnectMaxMs = reconnectBaseMs * 60;                // ~5 min at the default base
const delay = Math.min(reconnectBaseMs * 2 ** Math.min(attempts - 1, 10), reconnectMaxMs);
```

Both `reconnectBaseMs` (default 5 s) and `livenessMs` (default 5 min) are constructor-tunable; the add-on constructs the client with defaults. `scheduleReconnect` early-returns when `stopped` or `dormant`, so a stopped or schema-dead client never spins. `attempts` is reset to 0 the moment the state dump processes successfully (the `result` handler that transitions to `live`), so a healthy reconnection starts backoff fresh. `error` is logged (message only) but does not itself schedule a retry — `close` always follows and owns the reconnect, avoiding a double-schedule.

`start()` is idempotent (guards on `started`), clears a `dormant` latch on a deliberate re-establish, and no-ops when `url` is empty. `stop()` sets `stopped`, clears `started` (so a later `start()` can re-establish — restart symmetry), cancels the reconnect timer, tears down the socket, and moves to `stopped` (or `disabled` if there was never a URL).

### 6.6 Payload-safe parsing and logging

The socket is privileged and unauthenticated, so a hostile or buggy server must not be able to flood the logs, forge log lines, or poison the driver maps. Three exported sanitizers enforce this, plus two internal cleaners:

| helper | guards against | behavior |
| --- | --- | --- |
| `redactUrl(url)` | leaking `ws://user:pass@host` credentials to logs | regex-replaces userinfo with `***@` before any URL is logged |
| `safeTag(v, max=40)` | log flooding / forged log lines via attacker-controlled strings | strips control chars `\x00-\x1f\x7f`, truncates to 40; non-strings render as a number or `?` |
| `saneNodeId(v)` | a buggy/hostile server growing the driver maps with junk ids | accepts only an integer in `[1, 4000]`, else `null` — the callback is skipped |
| `cleanDbm(v)` (internal) | RSSI sentinels | rejects non-finite values and anything `≥ RSSI_SENTINEL_MIN (125)` → `null` (the "no reading" sentinel) |
| `parseLastSeen(v)` | mixed serializations | accepts a positive epoch number, or `Date.parse()`'s an ISO string; else `null` |

The connection's `message` handler wraps `JSON.parse` in a try/catch that logs only `'driver-ws: unparseable frame ignored'` — never the payload. Unknown frame types fall through the `onMessage` switch's `default` and are silently ignored, never logged verbatim. `driverVersion`/`serverVersion` reach the log only through `safeTag`. This is the "log types/counts, never payloads" rule made literal.

### 6.7 What it feeds: the four callbacks

`start_listening` returns a `result` frame carrying the full `state` dump (parsed by `onStateDump`), after which `event` frames stream in (parsed by `onEvent`). Both funnel into four typed callbacks:

```ts
interface DriverWsCallbacks {
  onBgRssi?: (channels: BgRssiChannels, at: number) => void;              // controller background RSSI (ch 0..3)
  onNodeLastSeen?: (nodeId: number, lastSeen: number) => void;           // driver-side last communication (epoch ms)
  onNodeFlags?: (nodeId, { isListening, isFrequentListening }) => void;  // capability flags (listening / FLiRS)
  onHomeId?: (homeId: number) => void;                                   // from the version handshake — for cross-check
}
```

**Background RSSI — the real noise floor.** `parseBgRssi(bg)` extracts channels 0–3 from the controller's `statistics.backgroundRSSI` blob. Per channel it prefers the driver's own EMA (`average`) — the canonical floor estimate — and falls back to `current` only when `average` is absent; both pass through `cleanDbm` (sentinel/`≥125` → `null`). It returns `null` unless at least one channel has a finite value, so an all-empty blob never fires the callback. It is seeded once from the state dump (`onStateDump` reads `controller.statistics.backgroundRSSI`) and thereafter refreshed from `controller` `"statistics updated"` events (`onEvent`). The result type `BgRssiChannels = (number | null)[]` deliberately preserves channel *position* — channels 0/1 are mandatory and 2/3 optional-and-trailing (RESEARCH §1.5), so a null gap must not be compacted.

**Node `lastSeen`.** `parseLastSeen(node.statistics.lastSeen)` yields the *real* last-communication epoch — a datum HA's `network_status` does not forward (RESEARCH §3.7 notes `last_seen` "is not forwarded by api.py"). Seeded from each node in the state dump, then advanced by node `"statistics updated"` events. This is what the quiet-node detector needs to distinguish "silent because sleeping" from "silent because gone."

**Capability flags — `isListening` / FLiRS.** From each state-dump node: `isListening` and `isFrequentListening` are read as strict booleans (anything non-boolean → `null`, i.e. "unknown", never a defaulted "listening"). HA's `network_status` omits `is_listening` entirely; before v0.13 the add-on could only infer it from CC info. These flags gate the battery/FLiRS guards and the quiet-node detector (a mains listening node silent past its cadence is a symptom; a FLiRS node within its wake interval is not).

**`homeId`.** Captured from the `version` handshake and passed straight out for the cross-check below.

### 6.8 The homeId cross-check: purge-and-stop on a wrong-network mismatch

`driver_ws_url` is operator-configurable, so it can point at the *wrong* Z-Wave network's server (e.g. a Z-Wave JS UI user with two controllers). If it did, that foreign network's `lastSeen`/`isListening`/noise would be aliased under *this* network's node ids for the life of the process — a silent, corrupting error. The consumer in `zwaveData.ts` guards every driver datum with a cross-check against HA's authoritative `homeId`.

The decision is a pure function, `driverHomeGuard(driverHomeId, haHomeId, latched)`:

```ts
if (latched) return { ok: false, newlyMismatched: false };
if (driverHomeId == null || haHomeId == null) return { ok: true, newlyMismatched: false }; // OPTIMISTIC while unknown
if (driverHomeId === haHomeId)               return { ok: true, newlyMismatched: false };
return { ok: false, newlyMismatched: true };                                               // PROVEN mismatch
```

The policy is **optimistic while either id is unknown** — the driver's fast state dump routinely lands before HA's first `network_status` poll, and dropping that early data would waste it. But because data is admitted during that optimistic window, the moment a mismatch becomes *provable* (both ids known and different) the consumer must scrub everything it let in. `driverHomeOk()` does exactly that on the `newlyMismatched` transition, exactly once:

```ts
this.driverHomeMismatch = true;   // latch — permanent this run
this.driverBgRssi = null;
this.driverLastSeen.clear();
this.driverListening.clear();
this.driverWs?.stop();            // quiesce — stop parsing the foreign event stream entirely
this.log(`driver-ws: server homeId … ≠ HA homeId … — telemetry PURGED + client stopped (check driver_ws_url)`);
```

Two properties matter. First, the four callbacks each begin `if (!this.driverHomeOk()) return;`, so no *further* foreign datum is admitted after the latch. Second, the client is not merely ignored but **stopped**, so it stops parsing the foreign network's stream altogether — belt and suspenders. On a genuine network change (HA's own `home_id` changes), the consumer resets its caches and cycles `driverWs.stop(); driverWs.start()`, letting the fresh handshake re-decide against the new id. The mismatch latch (`driverHomeMismatch`) is per-run and permanent — a misconfigured URL fails safe until the operator fixes it and restarts.

### 6.9 Downstream: staleness gating and the interference surface

The consumer never trusts a driver reading indefinitely. Wherever the noise floor is used, it is **staleness-gated at 90 s** (the driver polls ~every 30 s on idle) and re-checked against `driverHomeOk()`:

- The evidence sampler records the controller's per-channel `bgRssi` only when `now - driverBgRssi.at <= 90_000 && driverHomeOk()`; otherwise it records `null` — an honest unknown, never a re-used stale floor (`recordController(..., bg)`).
- The controller snapshot's `backgroundRSSI` field applies the same 90 s gate and passes the channels through `leadingRun()` (the leading contiguous run of present channels, preserving true channel indices) — a stale or absent reading reverts to `[]`, which the UI renders as "noise —".
- The engine's `hasRealNoise()` predicate uses the identical gate, so the mesh-interference detector knows whether a *measured* floor exists or whether it must fall back to `basis: 'inferred'` (interference-by-exclusion, severity-capped at `warn` — DESIGN §3.3).

The M6 INTERFERENCE screen (`8`/`f`) is the human-facing terminus. `computeInterference` medians the present channels (`medianFloor`, matching the masthead) and classifies the floor with fixed absolute thresholds in `interference.ts`:

```ts
function noiseBand(floor, real) {
  if (!real || floor == null) return 'unknown';
  if (floor <= -98) return 'clean';       // near-radio ideal ≈ -110 dBm
  if (floor <= -88) return 'elevated';
  return 'noisy';
}
```

When the client is absent or dormant, the screen states the gap plainly rather than guessing: *"◷ unavailable — the read-only driver-WS client is not connected. (HA strips backgroundRSSI; set driver_ws_url to enable this.)"* This closes the loop back to §6.1 — the one signal HA structurally cannot provide is the one this screen is built around, and its absence is rendered as an honest null.

### 6.10 Configuration

One config knob controls the entire client:

```yaml
# zwave_tui/config.yaml
options:
  driver_ws_url: ws://core-zwave-js:3000
schema:
  driver_ws_url: "str?"     # NOT url? — voluptuous rejects an empty url? default on Save
```

`str?` (not `url?`) is intentional and commented as such in `config.yaml`: HA's voluptuous `url?` validator rejects an empty default at Save time, and empty is a supported, meaningful value here. The run script (`rootfs/etc/services.d/zwave-tui/run`) exports it verbatim:

```sh
export DRIVER_WS_URL="$(bashio::config 'driver_ws_url')"
```

which `config.ts` reads as `driverWsUrl: process.env.DRIVER_WS_URL || null`. The default `ws://core-zwave-js:3000` matches the official Z-Wave JS add-on's internal DNS name and port; Z-Wave JS UI users point it at their own server's WS port. **Empty disables the client entirely** — `createDriverWsClient` is passed `null`, `state()` is `'disabled'`, and every driver-fed field stays `null`. As the translation copy (`translations/en.yaml`) and the code comments both stress, disabling it costs only the noise floor / true-last-seen / capability flags — "everything else keeps working, and this connection is never used to control the mesh." That single sentence is the whole security contract of the module: read-only, optional, and inert with respect to the mesh.

## 7. Baselines & Symptom Detectors (M3)

M3 is the layer that turns the raw evidence stream (Chapter 6, `evidenceStore.ts`) into *meaning*. It has two halves, each a self-contained module:

- **`server/src/zwave/baselines.ts`** — the learned "normal" for every node. It persists per-node × per-time-of-day statistics so that a relative detector can ask *"is this node worse than its own history?"* rather than guessing at absolute thresholds.
- **`server/src/zwave/symptoms.ts`** — a set of pure detector functions that read live evidence + baselines and emit a ranked list of provenance-carrying `Symptom` rows. It is **advisory-only**: it *describes* what it sees and never acts. Every mutating action still flows through the human type-CONFIRM Actions Menu (Chapter 8/M4).

The two modules are joined by a feedback loop: symptoms decide which nodes are *quarantined*, and baselines refuse to learn from a quarantined node (so the "normal" never chases the pathology). This chapter documents both halves, the exact statistics, every threshold, and the correlation ladder that collapses N per-node faults into one mesh event.

```
EvidenceSample ──▶ baselines.observe()      (learn the normal, unless quarantined)
       │                    │
       │                    ▼
       │            timeoutNormal / rssiNormal / rttNormal
       │                    │
       ▼                    ▼
symptoms.detectSymptoms(evidence, baselines) ──▶ Symptom[]  ──▶ Remedy screen / planner (M4)
       │                                              │
       └───── armingNodes() / symptomaticNodes() ─────┘  (quarantine set feeds back to observe())
```

---

### 7.1 `baselines.ts` — the learned normal

#### 7.1.1 The load-bearing lesson: one statistic does not fit all series

The module header states the design-review rule verbatim: **ONE statistic does not fit all series.** The store keeps *three* kinds of statistic, one per series class, because applying the wrong one manufactures false anomalies:

| Series class | Signals | Statistic kept | Why not the others |
| --- | --- | --- | --- |
| **Counting** | `timeoutResponse` rate (`dTimeout`/`dTx`) | Decayed Poisson rate λ = Σevents / Σtrials | A mostly-zero series has MAD = 0 by construction; median/MAD would make *any* nonzero reading look infinitely anomalous |
| **Continuous** | `rssi`, `rtt` | Median + MAD from a decayed histogram, with a MAD **floor** tied to instrument precision | A degenerate low-dispersion band would otherwise produce an unbounded z-score |
| **Discrete** | `routeKey`, `rateKbps` | *Not stored here* — handled categorically by the detectors (change/dwell) | Location/scale is meaningless on a category |

Note the counting series measures `timeoutResponse`, not `commandsDroppedTX`. Per RESEARCH §0, `commandsDroppedTX` does **not** count RF ACK failures (those mark a node Dead while the counter stays 0); the real return-path signal is `timeoutResponse` — a Get whose reply never came while the node stays Alive. The TUI's reliability metric is `timeoutResponse/commandsTX`.

#### 7.1.2 Time-of-day bands

Interference is diurnal (a baby monitor at night must not poison the daytime baseline), so every statistic is stratified into **6 bands of 4 hours each** (`N_BANDS = 6`):

```ts
export const N_BANDS = 6;
export function bandOf(t: number): number {
  const hour = new Date(t).getHours();               // local wall clock
  return Math.min(N_BANDS - 1, Math.floor(hour / (24 / N_BANDS)));  // 24/6 = 4h per band
}
```

Bands 0–5 map to local hours 0–3, 4–7, 8–11, 12–15, 16–19, 20–23. A pre-NTP boot can misband a few samples; the decay + multi-day graduation absorb that.

#### 7.1.3 The persisted data shapes

Everything is held in a `Map<number, NodeBaseline>` and serialized under a schema-versioned envelope (`SCHEMA_V = 1`):

```ts
interface RateBaseline {   // one per band, for the counting series
  events: number;          // decayed Σ timeouts
  trials: number;          // decayed Σ commandsTX (the confidence denominator)
  obs:    number;          // decayed independent-observation count
  days:   number[];        // distinct calendar-day indices seen (bounded)
}
interface HistBaseline {   // one per band, for each continuous series
  bins:   number[];        // decayed bin counts
  obs:    number;
  days:   number[];
}
interface NodeBaseline {
  timeout: RateBaseline[]; // [band]
  rssi:    HistBaseline[]; // [band]
  rtt:     HistBaseline[]; // [band]
  routeKey: string | null; // the route rssi/rtt were learned under; a change resets them
}
```

**RSSI histogram** — 2 dB bins from −120 to −20 dBm ⇒ `RSSI_NBINS = 50`. `rssiBin()` returns −1 (ignored) for out-of-range readings; `rssiCenter(i) = −120 + i·2 + 1`.

**RTT histogram** — a hand-built log-ish edge set, fine near zero and coarser out to 2 s, plus an `Infinity` overflow bin:

```
edges: 0,10,20,…,100        (step 10)
       125,150,…,500        (step 25)
       600,700,…,2000       (step 100)
       Infinity
```

`rttBin(ms)` finds the first edge the value falls below; `rttCenter(i)` is the bin midpoint (the `Infinity` bin is centered at `edges[i] + 100`).

#### 7.1.4 Counting series — the decayed Poisson rate

`foldRate` decays the accumulators by one observation-step (`DECAY = 0.01`, so effective memory ≈ 1/α = **100 observations**) and adds the new window:

```ts
r.events = r.events * (1 - DECAY) + events;   // events = s.dTimeout
r.trials = r.trials * (1 - DECAY) + trials;   // trials = s.dTx
r.obs    = r.obs    * (1 - DECAY) + 1;
noteDay(r.days, dayIndex(at));
```

Folded only from windows **with traffic** — `observe()` guards `s.dTx != null && s.dTx > 0 && s.dTimeout != null`; a null/zero-tx window carries no rate information. The learned normal is read back via `timeoutNormal()`:

```ts
rate  = trials > 0 ? events / trials : 0;
ready = obs >= MIN_OBS (20) && days.length >= MIN_DAYS (3) && trials > 0;
```

The Poisson *upper-tail* anomaly test is not applied here — it lives in `symptoms.ts` (`rateAnomalous`, §7.2.6). The baseline only supplies the reference rate λ and a confidence denominator (`trials`).

#### 7.1.5 Continuous series — weighted median + MAD with a precision floor

`foldHist` decays every bin then increments the observed one:

```ts
for (let i = 0; i < h.bins.length; i++) h.bins[i] *= (1 - DECAY);
h.bins[bin] += 1;
h.obs = h.obs * (1 - DECAY) + 1;
```

Ingestion is **fresh-only**: `observe()` folds rssi/rtt only when `s.fresh` is true (and `s.rtt >= 0`). A re-sampled driver EMA carries no new information — pseudo-replication would collapse the dispersion. `histStats()` then extracts the normal:

```
median = weighted median of bin centers
MAD    = weighted median of |center − median|
scale  = max(1.4826 · MAD, madFloor)      // 1.4826·MAD ≈ σ for a normal
```

The **MAD floors** are tied to instrument precision (RESEARCH §1.11) so a degenerate low-dispersion band cannot manufacture an unbounded z-score:

```ts
export const RSSI_MAD_FLOOR = 3;  // dB
export const RTT_MAD_FLOOR  = 8;  // ms (~1 EMA step at typical RTTs)
```

`ready = obs >= MIN_OBS && days.length >= MIN_DAYS`. Note `histStats` still returns a `{median, scale}` even when `ready` is false (with `scale = madFloor` on an empty histogram); the *caller* is responsible for checking `norm.ready` before trusting it — which every detector does.

#### 7.1.6 Graduation — honest learning units

A band **graduates** (its detectors may fire) only after it has seen enough *independent* observations across enough *distinct calendar days*:

```ts
const MIN_OBS  = 20;   // decayed independent-observation count
const MIN_DAYS = 3;    // distinct calendar days
const DAYS_RING = 10;  // distinct-day list is capped at 10 (graduation only needs ≥ MIN_DAYS)
```

Days are tracked by `dayIndex(t) = floor(t / 86_400_000)` and de-duplicated by `noteDay`. This is the "honest learning units" rule: 10-second snapshots are ~99% autocorrelated, so a band that has technically accumulated 20 snapshots in one afternoon is **not** graduated — it needs ≥3 distinct days. A dormant band renders as `learning (d/K days)`, never a fabricated prior.

#### 7.1.7 Baseline lifecycle — quarantine, decay, reset, boot-grace

Five lifecycle rules protect the learned normal:

1. **Quarantine.** `observe(nodeId, s, quarantined)` returns immediately if `quarantined` is true — the caller passes the union of `armingNodes()` ∪ `symptomaticNodes()` (§7.4). Windows *inside* an active symptom's dwell — including the pre-emission **arming window** — are excluded so the baseline never ratchets toward the pathology.
2. **Route-change reset.** When `s.routeKey !== n.routeKey`, all rssi/rtt histograms across **every** band are wiped and `routeKey` is re-stamped (a new route legitimately shifts both signals). The timeout-rate baseline is *not* reset by a route change.
3. **Decay.** The `DECAY = 0.01` per-observation factor lets genuine improvements be absorbed slowly rather than never.
4. **Forced resets.** `resetNode(id)` drops one node (re-interview / `replace_failed_node` / node-id reuse); `reset()` drops everything and rewrites disk immediately (controller home-id change).
5. **A permanently-symptomatic node freezes.** Because quarantine blocks learning, a node that never recovers keeps its **last-healthy** normal forever. This is accepted (v0.14 review): it keeps a genuinely-broken node flagged against its own healthy history instead of normalizing the fault. DESIGN's bounded-quarantine / forced re-baseline-after-K-weeks is a documented future refinement, not required for correctness.

**Boot-grace is deliberately a no-op for dropping baselines.** Unlike the fine ring's 1 h staleness cap, baselines are age-judgment-free learned state — a daily power blip must not wipe weeks of learning. `load()` keeps the `bootGraceMs` option (default 180 s) only to *skip the max-age check* when `uptimeMs() < bootGraceMs` (the wall clock is untrusted that early):

```ts
const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs;
if (!grace && maxAgeMs > 0 && savedAt > 0 && now() - savedAt > maxAgeMs) { /* discard */ }
```

`DEFAULT_MAX_AGE_MS` is 30 days (baselines are long-lived; a whole file older than that is discarded). Persistence is an atomic `writeFileSync(tmp)` + `renameSync(tmp, path)`, gated on a `dirty` flag. `load()` sanitizes every restored structure through `coerceNode`/`coerceHist`/`num` (which clamps to finite, ≥ 0), and refuses any file whose `v !== SCHEMA_V`.

**Config knobs (`BaselineStoreOptions`).** `path`, `maxAgeMs` (0 = never expire), `bootGraceMs`, and injectable `now`/`uptimeMs`/`log` for testing. The statistical constants (`N_BANDS`, `MIN_OBS`, `MIN_DAYS`, `DECAY`, `DAYS_RING`, the histogram edges, and the MAD floors) are compile-time constants, not runtime options — the shareability rule keeps them as documented defaults in source.

---

### 7.2 `symptoms.ts` — the detectors

#### 7.2.1 The Symptom shape

Every detector is a pure computation that appends `Symptom` rows to an output list and mutates a caller-owned dwell map. A symptom carries its own provenance so the UI never renders an inference in the same voice as a measurement:

```ts
interface Symptom {
  kind: SymptomKind;
  nodeId: number | null;              // null = mesh/controller-scoped
  severity: 'watch' | 'warn' | 'crit';
  sinceMs: number;                    // dwell start (epoch ms)
  basis: 'measured' | 'inferred';     // observed, or diagnosis-of-exclusion
  evidence: EvidenceRef[];            // {label, value} provenance rows
  narrative: string;                  // one-line technician-grade explanation
  subsumedBy?: string;                // id of the mesh event demoting this row
}
```

Two design invariants govern the whole module:

- **Every detector always computes.** Dwell accumulates continuously and is *never* reset, paused, or suppressed by another symptom (detection ≠ advice).
- **Presentation demotes, never deletes.** Under an active mesh event, per-node symptoms are annotated `subsumedBy` rather than removed.

#### 7.2.2 The dwell model

A breach must *persist* before it surfaces. Dwell state is a `Map<string, DwellEntry>` keyed `"<nodeId|mesh>:<kind>"`:

```ts
interface DwellEntry { since: number; lastSeen: number; hits: number; }
const DWELL_MS = 5 * 60_000;   // 5 min of continuous breach before emission
```

`dwell(state, key, breaching, now)` returns the dwell-start once `now - since >= DWELL_MS`, else `null` (still arming). When `breaching` is false it deletes the entry. Critically, `hits` counts **evaluable breaching observations, not wall-clock ticks** — so a "chronic" verdict means the badness was actually *seen* repeatedly, never "first seen N days ago with an unknown quiet middle" (v0.14 review).

Two helpers keep dwell stable against the freshness flag:

- `latestFresh(samples, now, pick, window)` — scans newest-first, skips non-fresh samples, and returns the first usable value. This is why `rtt-degraded` and `weak-signal` gate on the newest *fresh* reading instead of `last`, so a non-fresh tick doesn't reset the dwell (v0.14 review: those detectors almost never matured before this fix).
- `windowTimeoutRate`, `windowFlaps`, `windowRxRate` — windowed aggregations over the recent fine ring (default `WINDOW_MS = 10 min`).

#### 7.2.3 The 12 `SymptomKind`s

The `SymptomKind` union declares **12** kinds. Ten have live detector bodies in `detectSymptoms`; two (`quiet-node`, `route-churn`) are declared in the union but have **no detector implemented yet** — they are reserved names from the DESIGN table awaiting the driver-WS cadence/route-scheme data:

| # | kind | scope | severity | basis | implemented? |
| --- | --- | --- | --- | --- | --- |
| 1 | `return-path-degraded` | node | watch/warn | measured | yes |
| 2 | `chronic-return-path` | node | warn | measured | yes |
| 3 | `dead-flap` | node | crit | measured | yes |
| 4 | `quiet-node` | node | — | — | **declared, not built** |
| 5 | `rate-fallback` | node | watch/warn | measured | yes |
| 6 | `route-churn` | node | — | — | **declared, not built** |
| 7 | `rtt-degraded` | node | watch | measured | yes |
| 8 | `weak-signal` | node | watch | measured/inferred | yes |
| 9 | `chatty-device` | node | watch | measured | yes |
| 10 | `ghost-suspect` | node | warn | inferred | yes |
| 11 | `controller-degraded` | mesh | warn/crit | measured | yes |
| 12 | `mesh-interference` | mesh | warn | measured/inferred | yes |

#### 7.2.4 Per-node detectors — exact firing conditions

**`dead-flap` — the hard RF-failure event (crit, measured).**
`windowFlaps` sums the event-driven `dFlaps` counter (Alive↔Dead transitions) over the window; fires at `flaps >= FLAPS_WINDOW (3)`. This is the *only* correct way to detect a hard link failure — never by diffing the status column, and never from `commandsDroppedTX` (which stays 0 on RF ACK loss). It calls `markDegrading(id, b)` on the *raw* condition (pre-dwell), feeding the correlation gate.

**`return-path-degraded` — relative timeout breach (watch/warn, measured).**
`windowTimeoutRate` computes Σ`dTimeout`/Σ`dTx` over the window, returning `null` when traffic is below `MIN_WINDOW_TX (20)`. It compares against the node's own graduated `timeoutNormal`:

```ts
relBreach = norm.ready ? rateAnomalous(w.rate, norm.rate, TIMEOUT_RATE_MULT) : false
```

`rateAnomalous` is the Poisson-tail proxy — a multiplicative test with **both** an absolute floor and a minimum additive margin so a near-zero baseline can't manufacture anomalies:

```ts
function rateAnomalous(windowRate, baseRate, mult /* =3 */) {
  return windowRate >= Math.max(baseRate * mult, TIMEOUT_RATE_ABS * 0.5)  // ≥ max(3×base, 0.075)
      && windowRate > baseRate + 0.02;                                    // AND ≥ 2pp over base
}
```

Severity is `warn` if `w.rate >= TIMEOUT_RATE_ABS (0.15)`, else `watch`. `markDegrading` is set on `relBreach || w.rate >= 0.15` (so an absolute-high rate feeds the gate even before its own baseline has graduated).

**`chronic-return-path` — absolute, baseline-independent (warn, measured).**
Nested in the same evaluable-window block, this bridges the gap a compare-to-own-baseline engine cannot see: a node bad *since inclusion*. It fires only when all three hold:

```
w.rate >= TIMEOUT_RATE_ABS (0.15)                    // chronicBreach
AND (now - cSince) >= CHRONIC_DAYS_MS (2 days)        // sustained
AND cHits >= CHRONIC_MIN_HITS (400)                   // actually observed bad 400× of evaluable windows
```

Because its dwell is advanced only inside the `if (w)` (evaluable-window) block, `hits` accrue only when the rate could actually be measured — so a node quiet for two days then briefly bad is **not** called "chronic since setup".

**`rate-fallback` — same-route regression below 100k (watch/warn, measured).**
Fires only on a `!node.isLongRange` node where `sameRouteRegressed` is true. That helper (over ~30 min of memory, `WINDOW_MS * 3`) requires the node's **current** `routeKey` to have been seen at ≥ 100 kbps *and* currently be below 100 kbps:

```ts
return sawHundred && recentBelow;   // no route memory ⇒ no fire (fail-closed)
```

This is the fail-closed rule (DESIGN §3.3, RESEARCH §2.2): a device or route whose ceiling is 40k/9.6k is *capability*, not a fault, and must not fire. Severity is `warn` at 9.6k, else `watch`. Labels come from `RATE_LABEL = {1:'9.6k', 2:'40k', 3:'100k', 4:'LR-100k'}`.

**`rtt-degraded` — route-stratified z-score (watch, measured).**
Uses the route-stratified `rttNormal` and the newest *fresh* RTT in the window:

```ts
b = norm.ready && rtt != null && rtt > norm.median + RTT_Z * norm.scale   // RTT_Z = 4
```

That is a 4-σ upper breach over the median (with `scale` already floored at 8 ms). Notably this detector does **not** call `markDegrading` — an RTT blip alone is deliberately not part of the mesh-interference substrate.

**`weak-signal` — direct nodes only, timeout-corroborated (watch, measured/inferred).**
A routed node's RSSI is its *last hop*, not the device, so this fires only on direct, non-LR nodes. `representativeFloor` picks the controller's measured background RSSI (median of finite values in (−120, 0)) or falls back to **−95 dBm**. The condition:

```ts
routed        = (last.routeKey ?? 'direct') !== 'direct'
margin        = rssi - floor
timeoutCorrob = w != null && w.rate >= 0.05           // deliveries actually suffering
b = !routed && !isLongRange && margin < WEAK_MARGIN_DB (7) && timeoutCorrob
```

The timeout corroboration is required by design: a thin margin that isn't costing deliveries is not yet a problem. **Basis is honest about its floor** — `measured` only when `input.hasRealNoise()` (the driver-WS noise reading, Chapter 6/M2.5) is available; against the −95 fallback the row is `inferred` and the evidence value reads `"… (vs assumed −95 floor)"`. `markDegrading(id, true)` fires only once the symptom matures.

**`ghost-suspect` — coverage-proven, zero comms (warn, inferred).**
Deliberately the most conservative detector, because its eventual remediation (`remove_failed_node`) is destructive. It keys on *cumulative* coverage:

```ts
dead   = node.status === Dead
noComms = cov.freshSamples === 0                        // NEVER communicated
b = dead && noComms && observedMs >= GHOST_MIN_COVERAGE_MS (3 days)
```

Because it requires `freshSamples === 0`, it flags only *never*-communicated dead nodes — a device that once worked then died surfaces as `dead-flap`/plain-dead instead. `observedMs` is measured from the node's `firstSeenAt` (or store `recordingSince` as a floor). A young or wiped store yields no ghost verdict.

**`chatty-device` — flood vs the mesh median (watch, measured).**
Evaluated in a second pass because it needs the fleet median. `windowRxRate` (reports/min over ≥ 1 min of span) is computed for every non-controller node; the median is `rxRates[rxRates.length >> 1]`. A node fires when:

```ts
b = rr >= rxMedian * RX_FLOOD_MULT (20) && rr >= 6   // ≥6 reports/min AND ≫ median
```

The offending node id is captured as `floodNode` for the correlation ladder. `chatty-device` is a *cause hypothesis* and is exempt from `subsumedBy` demotion (§7.5).

#### 7.2.5 `controller-degraded` — the serial-link event (warn/crit, measured)

Evaluated first, from `controllerSamples()` (fresh, in-window). It sums the serial-link counters and compares to an absolute threshold:

```ts
total = Σ dNak + Σ dCan + Σ dTimeoutAck
breaching = any && total >= CTRL_DEGRADED_ABS (5)
severity  = total >= CTRL_DEGRADED_ABS * 3 (15) ? 'crit' : 'warn'
```

This is deterministic host↔stick evidence (not per-node RF), and its narrative points at the stick (USB-2 port, passive extension cable away from USB-3). When it matures it sets `controllerEvent = 'ctrl'`, which becomes the top rung of the correlation ladder — it both *suppresses* the mesh-interference dwell and becomes the `subsumedBy` id for per-node symptoms.

---

### 7.3 The correlation gate — mesh event or N faults?

The gate answers *"is this a mesh-wide RF event, or a coincidental pile of independent faults?"* It runs on a **raw, pre-dwell substrate** (`degradingNow`) so it has its *own* dwell decoupled from per-node dwell — the design-review point that "the gate must not wait two stacked dwells to fire". `degradingNow` is populated by `markDegrading` from `dead-flap`, `return-path-degraded` (relative or absolute), `rate-fallback`, and matured `weak-signal` — deliberately *not* `rtt-degraded`, `ghost-suspect`, or `chatty-device`.

**Breadth over active nodes, with hard floors and hysteresis:**

```ts
activeNodes    = non-controller nodes with a recent sample where dTx > 0 in-window
degradedActive = activeNodes ∩ degradingNow
frac           = degradedActive / activeNodes.length

threshold = wasMeshActive ? MESH_RELEASE_FRACTION (0.20) : MESH_ACTIVE_FRACTION (0.35)   // hysteresis
meshBreach = activeNodes.length >= MESH_MIN_ACTIVE (8)
          && degradedActive   >= MESH_MIN_DEGRADED (3)
          && frac >= threshold
meshSince = dwell(meshKey, meshBreach && !controllerEvent, now)   // ladder rung 1 wins
```

- **Hard floors** (`≥ 8 active`, `≥ 3 degraded`) stop a coincidental pair on a quiet mesh from ever being called "mesh-wide" (v0.14 review: the K=2 dichotomy trap).
- **Hysteresis** — fire at 35% breadth, hold until it dips below 20% — stops a momentary breadth dip from dropping the event and regressing the Remedy screen back to N independent faults. A duty-cycled interferer therefore produces *one* sustained mesh event, not a flapping series.
- **The ladder** — because dwell is fed `meshBreach && !controllerEvent`, an active controller-degraded event completely blocks the mesh-interference dwell (evidence strength: deterministic serial counters outrank inferred breadth).

**Mesh-level disambiguation** (once `meshSince` matures, `meshEventId = 'mesh'`):

- If a `floodNode` is present → `mesh-interference` with `basis: 'measured'`, narrative blaming that chatty device ("fix the chatty device first").
- Otherwise → `mesh-interference` with `basis: 'inferred'`, `severity: 'warn'`, narrative explicitly stating no noise-floor confirmation ("treat as a lead, not a verdict").

---

### 7.4 `subsumedBy` demotion and quarantine feedback

**Demotion (presentation layer).** Once any mesh event id is active (`'ctrl'` or `'mesh'`), every per-node symptom is annotated — never deleted:

```ts
if (meshEventId) for (const s of out)
  if (s.nodeId != null && s.kind !== 'chatty-device') s.subsumedBy = meshEventId;
```

`chatty-device` is exempt (it is the cause hypothesis, not a victim). The operator sees one mesh event with N demoted contributors instead of N loud independent faults.

**Ranking.** The output is sorted `crit > warn > watch`, then mesh/controller-scoped rows first, then by dwell age (`sinceMs`).

**Quarantine (feedback to baselines).** Two exported helpers define which nodes must not be learned from:

- `symptomaticNodes(symptoms)` — node ids with a *surfaced* symptom.
- `armingNodes(state)` — node ids with *any* active dwell entry, matured or not.

`armingNodes` is the load-bearing set (v0.14 review): the DESIGN invariant is that windows *inside* a symptom's dwell are excluded from the baseline, and the 5-minute **arming window** (breach before emission) is exactly "inside the dwell". Folding those bad samples would ratchet the baseline toward the pathology and desensitize the very detector meant to catch it. The caller passes the union of these sets as the `quarantined` flag into `baselines.observe()` — closing the M3 loop.

---

### 7.5 Tunables reference

All `symptoms.ts` thresholds ship as documented compile-time constants (shareability rule — no runtime knobs):

| Constant | Value | Governs |
| --- | --- | --- |
| `DWELL_MS` | 5 min | Continuous breach required before a symptom surfaces |
| `WINDOW_MS` | 10 min | Windowed-rate / flap lookback |
| `MIN_WINDOW_TX` | 20 | Minimum sends for a timeout rate to be meaningful |
| `TIMEOUT_RATE_ABS` | 0.15 | Chronic / absolute timeout-rate threshold |
| `TIMEOUT_RATE_MULT` | 3 | Relative multiplier over own baseline |
| `CHRONIC_DAYS_MS` | 2 days | Sustained duration → chronic |
| `CHRONIC_MIN_HITS` | 400 | Evaluable-bad observations before "chronic" |
| `RTT_Z` | 4 | z-score over route-stratified RTT baseline |
| `WEAK_MARGIN_DB` | 7 | Direct-node weak-signal SNR margin |
| `FLAPS_WINDOW` | 3 | Alive↔Dead transitions/window → dead-flap |
| `RX_FLOOD_MULT` | 20 | dRx rate over the mesh median → chatty |
| `GHOST_MIN_COVERAGE_MS` | 3 days | Observed-with-zero-comms before ghost-suspect |
| `CTRL_DEGRADED_ABS` | 5 | Serial NAK+CAN+timeoutACK per window (×3 = crit) |
| `MESH_ACTIVE_FRACTION` | 0.35 | Mesh gate FIRE fraction |
| `MESH_RELEASE_FRACTION` | 0.20 | Mesh gate RELEASE fraction (hysteresis) |
| `MESH_MIN_ACTIVE` | 8 | Hard floor on active nodes for a mesh event |
| `MESH_MIN_DEGRADED` | 3 | Hard floor on degraded nodes for a mesh event |

Baseline constants (`baselines.ts`): `N_BANDS = 6`, `MIN_OBS = 20`, `MIN_DAYS = 3`, `DECAY = 0.01`, `DAYS_RING = 10`, `RSSI_MAD_FLOOR = 3 dB`, `RTT_MAD_FLOOR = 8 ms`, RSSI bins 2 dB over [−120, −20] (50 bins), the RTT edge set of §7.1.3, `SCHEMA_V = 1`, `DEFAULT_MAX_AGE_MS = 30 days`, `DEFAULT_BOOT_GRACE_MS = 180 s`.

> **Advisory-only, by owner decision.** Nothing in M3 executes. `detectSymptoms` returns a ranked, provenance-carrying description; the planner/executor tiers (`auto_remediation`, `auto_safe`) are designed but not built, and every mutating action still passes through the human type-CONFIRM Actions Menu. In particular, a route rebuild is never a runnable recommendation here — it cannot fix a physical link, it deletes manual priority routes, and it throws on Long-Range nodes.

## 8. The Remediation Planner (M4)

The planner is the engine's *reasoning* layer: given one detected symptom it produces a ranked, grounded list of candidate fixes. It is the M4 milestone (shipped as v0.14's advisory surface), lives in a single pure module `server/src/zwave/planner.ts`, and its output is rendered — and only rendered — by the REMEDY screen (`server/src/telnet/screens/remedy.ts`, reachable with key `7` / `y`). The design of record is DESIGN.md §3.4.

The planner's whole personality is captured by one deliberate design choice: **a candidate's `action` is `ActionKind | null`, and `null` — meaning "there is no software verb for this; here is the physical thing a human must do" — is the common case, not the exception.** Most correct Z-Wave remediations are physical (add a repeater, relocate the controller, power-cycle a device). The planner treats physical guidance as a first-class candidate and treats the executable verbs (`ping`, `refreshValues`, `reInterview`, `healNode`, `removeFailed`) as the minority, each hedged with cost, basis, and gate reasons.

Everything in this chapter is **advisory-only**. `planFor` recommends; nothing here executes. A candidate that carries an `ActionKind` can be run *by the human* through the existing type-CONFIRM Actions Menu (`a`); the executor / `auto_remediation` / `auto_safe` tiers are designed (DESIGN §3.5) but **not built** — the owner chose advisory-only.

### 8.1 Contract: a pure `Symptom → Plan` function

The public surface is two pure functions and three data types. Purity is a stated design property (DESIGN §3.4): the M4 planner has *no history dependency*, so it "can't regress on a cold ledger" and is trivially testable.

```ts
// planner.ts
export function planFor(
  symptom: Symptom,
  node: NodeSnapshot | undefined,   // the symptom's node, or undefined on a roster miss
  ctx: PlanContext,
): Plan;

export function planAll(
  symptoms: Symptom[],
  nodeOf: (id: number) => NodeSnapshot | undefined,
  ctx: PlanContext,
): Plan[];
```

`planFor` is a single `switch (symptom.kind)` over the twelve `SymptomKind`s (§8.4). It never reads a clock, a store, or the network — its only inputs are the symptom, the node snapshot (which may be `undefined`), and the `PlanContext` (the write-actions gate and an optional M5 efficacy lookup). `planAll` is the batch entry point used to plan a whole symptom list; it drops symptoms subsumed under a mesh event (§8.7) before mapping.

Data trace into the planner:

```
detectors (symptoms.ts) ──► DataProvider.symptoms() ──► renderRemedy (remedy.ts)
                                                            │  per symptom:
                                                            └─► planFor(sym, nodeOf(sym.nodeId), {writeActions, efficacyFor})
                                                                    │
                                                                    └─► Plan { headline, candidates[] }  ──► rendered rows
```

Note the REMEDY screen calls `planFor` **per symptom inside the render loop** (`symptomBlock`), not via `planAll`; `planAll` exists as the reusable batch form (e.g. for tests and future non-TUI consumers) and applies the same subsumption filter the render loop applies inline.

### 8.2 Data shapes: `Plan`, `PlanCandidate`, `PlanContext`

```ts
export interface Plan {
  kind: SymptomKind;
  nodeId: number | null;      // copied from the symptom (null = mesh/controller-scoped)
  headline: string;           // one-line lead recommendation
  candidates: PlanCandidate[]; // ranked best-first
}

export interface PlanCandidate {
  action: ActionKind | null;  // executable verb, or null = PHYSICAL guidance
  title: string;              // short recommendation label
  rationale: string;          // grounded prose — NO numeric dB claims (RESEARCH §1.7)
  basis: Basis;               // evidence grade of the recommendation
  cost: Cost;                 // blast radius / reversibility tier
  blocked: string | null;     // terse reason it can't run now (gate/protocol/precondition)
  efficacy?: Efficacy | null; // M5: learned effect vs the no-action arm; null when unknown
}

export interface PlanContext {
  writeActions: boolean;                                       // the write-actions master gate
  efficacyFor?: (kind: SymptomKind, action: ActionKind) => Efficacy | null; // M5 lookup, optional
}
```

`ActionKind` is the exact same mutating-verb union the Actions Menu uses (`types.ts`): `'ping' | 'refreshValues' | 'reInterview' | 'healNode' | 'rebuildAll' | 'stopRebuild' | 'removeFailed'`. A candidate reuses those verbs so that "run it" means the identical human-confirmed path already audited elsewhere — the planner never invents a new execution surface.

The `rationale` templates are hand-authored constant prose. A hard rule from RESEARCH §1.7 governs them: **no numeric dB claims in any rationale** (a lint for this is slated for M7). This is why, for example, the repeater rationale talks about "an RF-hostile wall (metal, foil, stucco-over-lath)" rather than quoting a margin in dB — a stored template can't know the live margin, and a fabricated number would read as a measurement.

### 8.3 The two honesty axes: `basis` and `cost`

Every candidate is tagged on two orthogonal axes so the REMEDY row can tell the operator *how much to trust the advice* and *how much damage running it could do*.

**`basis` — evidence grade of the recommendation** (`type Basis = 'spec' | 'source' | 'empirical' | 'lore' | 'inference' | 'learned'`). This exists specifically so "a lore-grade heuristic never reads like a measurement" (module header).

| basis | meaning | example use in the table |
| --- | --- | --- |
| `spec` | Z-Wave protocol fact | LR-node physical-only advice ("LR talks directly to the controller, no routes") |
| `source` | documented driver / Z-Wave JS behavior | `refreshValues` re-polls without touching routes; `healNode` deletes manual priority routes |
| `empirical` | measured from this mesh | (reserved; not emitted by the M4 table) |
| `lore` | community construction-class heuristic | repeater placement; "firm up the marginal repeater"; power-cycle-first |
| `inference` | reasoned by exclusion, unconfirmed | the RF-survey lead for `mesh-interference` when no flooding cause exists |
| `learned` | from the outcome ledger | (reserved for M5+ reweighting; M4 emits none) |

DESIGN §3.4 records the chaining rule as **worst-of when chained** (the "DR" note): if a recommendation's justification depends on several links, its `basis` is the weakest of them. In the as-built M4 table each candidate is a single grounded statement, so its `basis` is set literally at the call site.

**`cost` — blast radius / reversibility** (`type Cost = 'physical' | 'safe' | 'caution' | 'disruptive' | 'destructive'`). This is the escalation ladder the REMEDY screen colors:

| cost | meaning | render color (`costTag`) |
| --- | --- | --- |
| `physical` | a human hands-on action, no software mutation | `blue` |
| `safe` | non-mutating software probe (e.g. `refreshValues`) | `green` |
| `caution` | a probe with a real side-effect risk (e.g. `ping` can mark a marginal node dead; `reInterview`) | `yellow` |
| `disruptive` | rewrites mesh state (a route rebuild / `healNode`) | `yellow` |
| `destructive` | permanent, unrecoverable (`removeFailed`) | `redB` (bold red) |

The two axes are independent: physical guidance is almost always `basis: lore` / `cost: physical`; the "rebuild — NOT recommended" anti-pattern candidate is `basis: source` (the driver behavior is documented) / `cost: disruptive` and is additionally `blocked`.

### 8.4 The causal table (per `SymptomKind`)

`planFor` maps each symptom kind to an ordered candidate list. The ordering follows the spec-backed remediation ORDER from RESEARCH §4.3 (controller/interference → ghost cleanup → traffic hygiene → repeater/placement → targeted rebuild → mesh-wide rebuild as last resort). Two shared constants back the recurring first-line fix:

- `REPEATER_RATIONALE` — the canonical prose for "add/relocate a repeater": *"A device far from the controller or behind an RF-hostile wall … is an RF edge node. A mains-powered repeater on an interior path — or relocating the controller — is the physically correct fix. A route rebuild cannot repair a marginal link and can make it worse by discarding a working route."*
- `repeaterCandidate()` — returns `{ action: null, title: 'Add/relocate a repeater on an interior path', basis: 'lore', cost: 'physical', blocked: null }` using that rationale.

The full as-built table (LR variants noted separately in §8.5):

| symptom kind | headline gist | candidate 1 | candidate 2 | candidate 3 |
| --- | --- | --- | --- | --- |
| `return-path-degraded`, `chronic-return-path`, `weak-signal`, `rtt-degraded` *(shared arm)* | "Improve the RF path — a repeater or relocation, not a rebuild" | `repeaterCandidate()` — lore / physical | `refreshValues` "Refresh values (re-poll, non-mutating)" — source / **safe**, gated | `healNode` "Rebuild routes — **NOT recommended here**" — source / disruptive, **blocked** `no topology change — won't help` |
| `rate-fallback` | "Route regressed below 100k — repeater/placement" | `repeaterCandidate()` | `healNode` "Rebuild routes (only if a device moved)" — source / disruptive, **blocked** `no topology change` | — |
| `route-churn` | "Route keeps changing — marginal repeater or intermittent interference" | `action: null` "Firm up the marginal repeater on that path" — lore / physical | `healNode` "Rebuild routes — **NOT recommended (will re-churn)**" — source / disruptive, **blocked** `physical-link symptom — won't settle it` | — |
| `dead-flap` | "Reachability runbook — a rebuild cannot repair an unreachable node" | `ping` "Ping the node (confirm reachability)" — source / **safe**, gated w/ probes | `action: null` "Power-cycle the device, then exclude/re-include if it persists" — lore / physical | — |
| `quiet-node` | "Node is quiet — confirm reachability before assuming a fault" | `ping` "Ping (consented reachability check)" — source / **caution**, gated w/ probes | `action: null` "Check it is powered and in range before assuming a fault" — lore / physical | — |
| `chatty-device` | "Tune the device's reporting — it is flooding the mesh" | `action: null` "Reduce its reporting … or re-include without S0" — source / physical | `reInterview` "Re-interview (after changing its config)" — source / **caution**, gated | — |
| `ghost-suspect` | "Possible ghost — verify before the destructive removal" | `removeFailed` "Remove failed node (**DESTRUCTIVE — verify first**)" — source / **destructive**, gated | `action: null` "First confirm the device is truly gone" — lore / physical | — |
| `controller-degraded` | "Controller serial link is struggling — fix the stick side" | `action: null` "USB-2 port + short passive extension, away from USB-3; relocate the stick" — source / physical | — | — |
| `mesh-interference` (`basis: 'inferred'`) | "Correlated mesh degradation — likely RF interference (unconfirmed)" | `action: null` "Survey the RF environment (900 MHz interferers) — measurement needed to confirm" — **inference** / physical | — | — |
| `mesh-interference` (not inferred) | "Correlated mesh degradation — a flooding device is the likely cause" | `action: null` "Fix the flooding device first (see its chatty-device card)" — source / physical | — | — |
| *default (unmapped kind)* | "No specific remediation — see the symptom detail" | `action: null` "Observe" — inference / physical | — | — |

Several load-bearing details of this table honor the RESEARCH ground truth:

- **`return-path-degraded` never recommends a rebuild.** A degraded return path is a *physical* link fault (the node ACKs the request but its report is lost — a `timeoutResponse`, the TMO signal). The rebuild candidate exists **only to say "NOT recommended here"**: it is emitted `blocked` with reason `no topology change — won't help`, so the anti-pattern is visible and argued against rather than silently omitted.
- **`mesh-interference` branches on `symptom.basis`.** The detector emits `basis: 'measured'` and names a flooding node when a chatty offender coincides with the correlated degradation, and `basis: 'inferred'` when no flooding cause can be blamed. The planner reads `symptom.basis === 'inferred'` to choose between "survey the RF environment" (an `inference`-grade lead, explicitly "a lead, not a verdict") and "fix the flooding device first" (a `source`-grade pointer to that device's own `chatty-device` card). This is the only place the planner reads a symptom field other than `kind`/`nodeId`.
- **`quiet-node` always carries a physical next step.** Because its only executable candidate (`ping`) is gated (and blocked entirely when write-actions are off, §8.5), the planner always appends an ungated `action: null` "check it is powered and in range" candidate so a quiet node never renders as a lone blocked ping with no actionable advice. Silence is not proof of failure — "a healthy sleeper can look identical to a dead node until it next reports."
- **`ghost-suspect` leads with the destructive verb but never automates it.** `removeFailed` is `cost: 'destructive'`; its rationale states the removal "only succeeds if the controller already considers it failed — a responding device cannot be removed this way," and that the removal attempt is itself the only in-band verification. The candidate is always gated (§8.5) and, per its rationale, "Never automated."

### 8.5 Hard gates

Three predicates enforce the safety invariants. They run *before* the plan is returned and can either remove candidates entirely (LR) or stamp them `blocked` (executable gates).

**`isLR(node, nodeId)` — Long-Range protocol gate.** Long-Range nodes have *no mesh routing*: route, repeater, and priority-route remediations are invalid, and a route rebuild (`healNode`) actually **throws** on an LR node. So for the RF-path family (`return-path-degraded` and siblings, `rate-fallback`, `route-churn`), when `isLR` is true the planner emits a **physical/antenna-only** candidate (`basis: 'spec'`) and *never* offers a repeater, refresh, or rebuild candidate at all.

The LR test is deliberately conservative about a missing snapshot:

```ts
function isLR(node: NodeSnapshot | undefined, nodeId?: number | null): boolean {
  if (node) return node.isLongRange || node.nodeId >= 256;
  return nodeId != null && nodeId >= 256;   // recover LR from the symptom's own nodeId
}
```

Node ids `>= 256` are Long-Range by protocol, so the symptom's own `nodeId` is an authoritative fallback: even on a roster miss (no `NodeSnapshot`) the planner recovers the LR fact and **never fails open into offering a route/repeater/rebuild candidate for an LR node**. This is the reason a rebuild-throws-on-LR situation can't be reached through the planner — the offending candidates are gone before they could be recommended.

**`isBatteryOrFlirs(node)` — probe-safety predicate.** Battery and FLiRS (non-listening) nodes must not receive test-frame-heavy actions (RESEARCH §4.6):

```ts
function isBatteryOrFlirs(node: NodeSnapshot | undefined): boolean {
  return !!node && (node.battery != null || node.isListening === false);
}
```

**`gateExecutable(node, ctx, {probes})` — the executable gate, FAIL-CLOSED.** Every executable candidate's `blocked` field is the return of this function:

```ts
function gateExecutable(node, ctx, opts = {}): string | null {
  if (!ctx.writeActions) return 'write actions off';
  if (opts.probes) {
    if (node === undefined) return 'node not in roster — probe withheld';
    if (isBatteryOrFlirs(node)) return 'battery/FLiRS — probe skipped';
  }
  return null;
}
```

Three properties matter here:

1. **The write-actions master gate blocks everything executable.** If `ctx.writeActions` is false, every action candidate is `blocked: 'write actions off'` regardless of node type. (This is why `quiet-node`/`dead-flap` need their ungated physical fallback — otherwise, with write-actions off, they'd render an all-blocked plan.)
2. **`{probes: true}` is used for the probes that actually put frames on the air** — `ping` on `dead-flap` and `quiet-node`. For those, an absent snapshot yields `'node not in roster — probe withheld'` and a battery/FLiRS node yields `'battery/FLiRS — probe skipped'`.
3. **The probe gate FAILS CLOSED on a missing node.** When the snapshot is `undefined` — a roster miss where "the symptom outlived the node in the roster" — the planner cannot *prove* the probe is safe, so it withholds it rather than assuming a mains, always-listening node. The default (mains, non-probe) verbs like `refreshValues`/`reInterview`/`removeFailed` call `gateExecutable` without `probes`, so they are gated only by the write-actions master switch.

**Rebuild is only ever a blocked "NOT recommended" candidate.** There is no code path in `planFor` where `healNode` is emitted with `blocked: null`. In every arm that mentions it, the rebuild candidate is either (a) suppressed entirely because the node is LR, or (b) present solely as a caveated anti-pattern with a `blocked` reason — `no topology change — won't help` (return-path), `no topology change` (rate-fallback), or `physical-link symptom — won't settle it` (route-churn). This matches RESEARCH §4.1/§4.2: a rebuild only helps on a genuine topology change (evidence HA's WS cannot provide), it can regress a working route, and it deletes manually-set priority routes.

### 8.6 M5 efficacy hook (present, additive, ranking-neutral)

After the `switch`, `planFor` optionally decorates the *executable* candidates with learned efficacy:

```ts
if (ctx.efficacyFor) {
  for (const c of candidates) {
    if (c.action != null) c.efficacy = ctx.efficacyFor(symptom.kind, c.action);
  }
}
```

`Efficacy` (`types.ts`) carries `{ expectedEfficacy, n, baseRate, beatsSelfHealing, ready }` from the outcome ledger. Physical guidance (`action: null`) is intentionally left un-scored — the ledger can only measure a verb it ran. Two guardrails apply: the loop only touches candidates with a non-null `action`, and the enrichment is **purely additive — the recommendation ORDER is unchanged this milestone**; efficacy is *shown*, not yet used to re-rank. When `ctx.efficacyFor` is absent (advisory reads exactly as M4), candidates carry no efficacy note.

### 8.7 Subsumption and `planAll`

Per DESIGN §3.3, a per-node symptom demoted under an active mesh event carries `subsumedBy` (the mesh event's id) and its recommendation *is* the mesh event's — planning it independently would double-advise. `planAll` filters these out before mapping:

```ts
export function planAll(symptoms, nodeOf, ctx): Plan[] {
  return symptoms
    .filter((s) => s.subsumedBy == null)
    .map((s) => planFor(s, s.nodeId != null ? nodeOf(s.nodeId) : undefined, ctx));
}
```

The REMEDY render enforces the same rule inline (§8.8): a subsumed symptom's row is still shown (with a "· under mesh event" tag) but **carries no plan block**.

### 8.8 The REMEDY render (`remedy.ts`)

`renderRemedy(ctx)` turns `data.symptoms()` into the advisory screen. It is where the plan meets the operator, and it is engineered so the single most important fact — a critical symptom and its honesty tags — can never be pushed off a non-scrolling terminal.

**Severity sort.** Symptoms are sorted worst-first by `bySeverity`, using `SEV_RANK = { crit: 0, warn: 1, watch: 2 }` with newest-breaching (`b.sinceMs - a.sinceMs`) as the tiebreak. This guarantees "a low-severity watch can never bury a critical off the bottom." The right-hand status and a `summaryLine` (`N critical · N warning · N watch  —  advisory only; nothing is acted on`) head the body.

**Per-symptom block (`symptomBlock`).** Each symptom renders as: a header line (`SEV_TAG` + a compact basis **glyph** + kind + who + dwell age), an evidence line (leading with the full `measured`/`inferred` word, then `label value` pairs), one wrapped narrative line, then the plan. The basis glyph — `◆` green for `measured`, `◇` yellow for `inferred` — is placed immediately after the severity tag precisely so it survives truncation at 40 columns; it is "the only measured-vs-inferred guardrail and must never be clipped off the row."

**The plan rows.** Only for a non-subsumed symptom (`sym.subsumedBy == null`), `symptomBlock` calls `planFor` and renders the headline plus up to **three** candidates (`plan.candidates.slice(0, 3)`), each on one line:

- A **marker** encodes runnability: `runnable = cand.action != null && cand.blocked == null`. A runnable executable gets a green `▸`; a blocked executable gets a grey `▸`; physical guidance (`action: null`) gets a grey `·`.
- A `[cost · basis]` tag is appended via `costTag` (§8.3) + the raw basis word.
- When `cand.blocked` is set, the reason is appended inline as ` ⊘ <reason>` in grey.
- **Only the top candidate (`i === 0`) carries a wrapped rationale line**, with a trailing "…" signalling more detail exists — so a screenful of symptoms stays scannable.
- The M5 efficacy note is rendered **only on a runnable candidate**. This is a correctness guard: a blocked or anti-pattern candidate (e.g. the "rebuild — NOT recommended" row) must never carry a green "✓ helped …" note that contradicts the advice. `efficacyNote` itself stays silent (`return null`) until `e.ready`, then shows either a green `✓ helped X% (n=…) vs Y% self-heal` or a grey `≈ n=…: not distinguishable from self-healing` — never a claim while still learning.

**Honest overflow footer.** The screen does not scroll. `renderRemedy` computes `bodyCap = max(0, view.rows - 3)` (frame reserves masthead + title-rule + command-bar) and appends symptom blocks worst-first until the next block would overflow, reserving one line for a footer whenever blocks remain unshown. If any symptom is dropped, it emits a yellow footer — `▾ N more symptom(s) not shown — worst are listed first; widen/heighten the terminal to see all` — and, in the degenerate case where one oversized block already filled the screen, it *trims the body* (`body.length = max(0, bodyCap - 1)`) so the footer is guaranteed to be the last visible line. The design principle: an honest "N more" footer beats silently dropping a critical off the bottom.

**Three distinct empty states.** When `symptoms.length === 0`, the screen never renders a generic "all clear." It reads `data.engineStatus()` and distinguishes: **engine disabled** (`● Engine disabled` — no baselines store configured, nothing is being diagnosed), **still learning** (`◷ Learning — ready/total nodes have a graduated baseline` — detectors may not fire until a node's normal is learned over several distinct days, "by design, not a fault"), and **genuinely healthy** (`✓ All clear — N nodes learned, no symptoms detected`). Rendering these identically would let "learning" masquerade as "healthy," so they are kept separate.

The whole surface reiterates the engine's contract in its own chrome: the summary line ends "advisory only; nothing is acted on," and the key bar offers only screen navigation and `Q` BACK — there is no "run" key on REMEDY. Executable candidates are run, if at all, through the separate Actions Menu with type-CONFIRM.

## 9. The Outcome-Learning Loop (M5)

The remediation engine's fourth stage (evidence → baselines → symptoms → **outcomes**) is a ledger that watches what actually happens to a symptom over time and slowly learns which operator actions earn their keep. It is implemented as a single pure store, `server/src/zwave/outcomes.ts` (`createOutcomeStore`), driven from `runEngine`'s per-tick symptom loop in `server/src/zwave/zwaveData.ts` (`updateEpisodes` / `nodeWindow` / `recordActionOutcome`). The design of record is DESIGN.md §3.6.

Two properties define this milestone and everything below follows from them:

1. **Advisory-only.** Per the owner's decision, the engine executes nothing. There is no `executor.ts` and no `auto_remediation` tier this milestone (DESIGN §3.5). The ledger's "action arm" is therefore not populated by the engine — it is populated by whatever the operator ran through the pre-existing type-CONFIRM Actions Menu (v0.9). The learned numbers flow *back into* the planner as advice; they never trigger anything.
2. **The unit is an episode, not an action.** The ledger records **every** symptom episode whether or not an action was taken. Episodes that resolve untouched are the **control arm** — the spontaneous-recovery base rate the mesh self-heals at. Without that control arm you cannot honestly say an action "helped," because a Z-Wave Plus mesh self-heals via explorer frames on its own (RESEARCH §5; the patio-light switches that healed unaided are the canonical example, and the "regression-to-the-mean trap" the guards below defend against).

### 9.1 Data shapes

```ts
// One symptom's lifecycle on one node (or mesh-scoped).
interface Episode {
  kind: SymptomKind;
  nodeId: number | null;
  band: number;                 // time-of-day context (bandOf(onsetMs); 6×4h, from baselines.ts)
  onsetMs: number;
  before: WindowMetrics | null; // degraded window captured at onset
  action: { kind: ActionKind; atMs: number; refused: boolean } | null;
  resolvedMs: number | null;
  after: WindowMetrics | null;  // settled window captured at resolution
  verdict: Verdict | null;
}

// Every recovery signal over a window of EvidenceSamples, computed kind-agnostically.
interface WindowMetrics {
  samples: number;              // total samples folded
  freshN: number;              // samples that carried a NEW stats event (rssi/rtt/flap denominator)
  // ── timeout family (return-path-degraded, chronic-return-path, quiet-node) ──
  tx: number;                   // Σ dTx (successful commands sent to the node)
  rx: number;                   // Σ dRx
  timeouts: number;             // Σ dTimeout (Get replies that never came — the reliability signal)
  rate: number | null;          // timeouts / tx, or null when tx < minTx (never a fabricated 0/0)
  // ── other recovery signals ──
  flaps: number;                // Σ dFlaps (Alive↔Dead transitions) — dead-flap recovery
  rssiMedian: number | null;    // median of FRESH rssi readings — weak-signal recovery
  rssiN: number;                // COUNT of fresh rssi readings behind rssiMedian (its evidence floor)
  rttMedian: number | null;     // median of FRESH rtt readings — rtt-degraded recovery
  rttN: number;                 // COUNT of fresh rtt readings behind rttMedian (its evidence floor)
  rateKbpsMin: number | null;   // worst FRESH negotiated PHY rate — rate-fallback recovery (null = no fresh reading)
}

// A DECAYED tally — the learned memory (not raw counts).
interface Tally { n: number; ok: number; }

type Verdict = 'improved' | 'no-change' | 'worse' | 'refused-misdiagnosis' | 'unverifiable';
```

A window carries **every** recovery signal, because a symptom's recovery shows up in a *different* signal depending on its kind (§9.4). The timeout family's signal is **timeouts/tx**, consistent with the load-bearing fact that `commandsDroppedTX` does *not* count RF ACK failures — `timeoutResponse` (a `Get` whose reply never arrived, node stays Alive) is the measurable per-command degradation `WindowMetrics.rate` is computed from. RSSI, RTT, and the negotiated PHY rate are all re-sampled from the driver's cached stats, so they are folded **only from `fresh` samples** — a re-read of the same cached value between stats events is not a new observation. Crucially, a *fresh* sample can still carry a **null** rssi/rtt (the no-signal sentinels 125/126/127, or a null rtt), so `freshN` (fresh-sample count) is **not** the count of usable readings; `rssiN`/`rttN` carry the true per-signal observation counts, which is what §9.4's evidence floors gate on. `flaps` is an event-drain count, folded over **all** samples (a flap is concrete whether or not a stats event landed).

`windowMetrics(samples, minTx = 5)` sums `dTx/dRx/dTimeout` and `dFlaps`, and — under the `fresh` gate — medians `rssi`/`rtt` (tracking `rssiN`/`rttN`) and mins `rateKbps`. Below five commands a per-command timeout rate is not meaningful, so `rate` stays `null` rather than manufacturing a value — a `null` rate downstream forces an `unverifiable` verdict, never a false claim. The same fail-closed rule applies to every other metric: a window with no fresh rate reading has `rateKbpsMin == null`, and a median backed by fewer than `MIN_OBS` readings is rejected — both → `unverifiable`, never a verdict fabricated from stale or single-sample data.

### 9.2 The episode lifecycle

Episodes are opened and resolved off the same M3 symptom signal, once per engine tick, by `updateEpisodes(symptoms, now)` (zwaveData.ts). The decision logic is extracted into the pure, unit-testable `planEpisodeLifecycle(symptoms, openEpisodes, pending, now, confirmMs)` so the confirmation-window arithmetic can be tested without the driver.

```
updateEpisodes(symptoms, now):
  CONFIRM_MS = 10 * 60_000                        // 10 minutes
  { toOpen, toResolve } = planEpisodeLifecycle(symptoms, oc.openEpisodes(),
                                               this.pendingResolve, now, CONFIRM_MS)
  for s in toOpen:    oc.open(s.nodeId, s.kind, now, nodeWindow(s.nodeId, now))   // capture BEFORE
  for r in toResolve: oc.resolve(r.nodeId, r.kind, now, nodeWindow(r.nodeId, now)) // capture AFTER
```

Episode key is `${nodeId ?? 'mesh'}:${kind}` — one open episode per key, mirroring the detector lifecycle (`open()` is idempotent: a second `open` on a live key is a no-op).

**Open rule — non-subsumed onset only.** In `planEpisodeLifecycle`, a symptom becomes a `toOpen` candidate only when `s.subsumedBy == null` and no episode is already open for its key. A **subsumed** symptom (one folded under a mesh-wide event) opens *no* episode of its own — its fate belongs to the mesh event, and counting it would pollute the base rate with events that were really one shared cause.

**Resolve rule — the 10-minute confirmation window.** Absence does not resolve an episode immediately; a blink of improvement is not a recovery. The function maintains a mutable `pending: Map<key, firstAbsentMs>`:

```
live = { epKey(s) for every s in symptoms }        // present = live, INCLUDING subsumed
for s in symptoms: pending.delete(epKey(s))         // present again → cancel any pending timer
for ep in openEpisodes:
  if ep.key in live: continue                        // still symptomatic → not resolving
  since = pending.get(ep.key) ?? now
  pending.set(ep.key, since)
  if now - since >= confirmMs:  toResolve += ep;  pending.delete(ep.key)
```

Two subtleties are load-bearing:

- **`live` includes subsumed symptoms.** A symptom that is present but merely *subsumed* is still `live` and must NOT resolve. Subsumption demotes the recommendation; it is not recovery. Only genuine absence starts the resolution timer.
- **The dwell doubles as a settle window.** Waiting 10 minutes of continuous absence means the after-window (`nodeWindow`, last 5 min) is sampled well past the recovery transition, so the "after" metrics reflect the settled state, not the moment of change.

**The before/after windows** come from `nodeWindow(nodeId, now)`: the last 5 minutes (`WINDOW_MS = 5 * 60_000`) of evidence samples for that node, aggregated through `windowMetrics`. A mesh-scoped symptom (`nodeId == null`) has no per-node evidence and yields `null` → the episode can only ever read `unverifiable`, never a fabricated improvement.

### 9.3 The two arms

The ledger keeps two decayed tallies per symptom kind, plus a false-positive counter:

| Structure | Key | Meaning |
|---|---|---|
| `control: Map<SymptomKind, Tally>` | `kind` | Spontaneous-recovery arm — episodes that resolved with **no** action |
| `action: Map<string, Tally>` | `${kind}\|${act}` (`aKey`) | Action arm — episodes attributed to a given `(kind, action)` |
| `fp: Map<SymptomKind, number>` | `kind` | `refused-misdiagnosis` count (detector false positives) |

**Populating the action arm (operator actions).** Because nothing auto-executes, the action arm is fed by the ActionRunner's structured `onOutcome` hook. The wiring is: `createActionRunner.run()` fires `o.onOutcome?.(kind, nodeId, true)` on success / `…, false)` on failure (zwaveActions.ts:56/61) → `index.ts:103` routes it to `zwaveData.recordActionOutcome(kind, nodeId, ok)` → `outcomes.recordAction(...)`. `recordActionOutcome` applies three conservative filters *before* the ledger sees it:

- **Mesh-wide actions dropped.** `nodeId == null` (rebuildAll / stopRebuild) is not attributed — it cannot be credited to any one node's episode without confounding.
- **Only successful actions count.** `if (!ok) return;` A failed action was not "taken."
- **`refused` is always passed as `false` in M5.** The `refused-misdiagnosis` verdict is *reserved*, not auto-detected this milestone (see §9.5).

Inside `recordAction`, attribution is node-scoped, not symptom-scoped — the operator picks an action for a *node*, and any of its active symptoms could be the one it addresses:

```ts
const prefix = `${nodeId ?? 'mesh'}:`;
for (const [k, ep] of open) {
  if (!k.startsWith(prefix)) continue;   // every open episode on this node
  if (skip?.(k)) continue;               // …except ones already recovering on their own
  if (ep.action == null) ep.action = { kind: actionKind, atMs, refused };  // first action wins
}
```

The `skip` predicate is `(key) => this.pendingResolve.has(key)` — an episode whose symptom already went absent (it is in its confirmation window, recovering unaided) is **excluded** from attribution. This is the critical anti-theft guard: an action taken *after* the symptom already cleared must not steal credit for a spontaneous recovery, or the action arm would inflate itself with self-heals. "First action per episode wins" (`ep.action == null`) because a later action cannot be cleanly credited.

**Folding a resolved episode into an arm** happens in `resolve()`, after `computeVerdict`:

```
verdict = computeVerdict(ep)
if verdict == 'refused-misdiagnosis':  fp[kind] += 1                    // detector FP, NEITHER arm
elif verdict == 'unverifiable':        (nothing)                        // honest "couldn't tell"
elif ep.action == null:                control[kind]      = bump(control[kind],      improved)
else:                                  action[kind|act]   = bump(action[kind|act],   improved)
```

### 9.4 The verdict and the statistical-honesty guards

`computeVerdict(ep)` is where the ledger refuses to lie. After the refusal short-circuit and a before/after presence check, it dispatches to the recovery metric that **this symptom's kind actually moves** — because a `weak-signal` fix shows up in RSSI, not in the timeout rate, and scoring every kind by timeouts (the original M5 behaviour, v0.16) meant non-timeout kinds could never register an improvement:

```ts
if (ep.action?.refused) return 'refused-misdiagnosis';
if (!ep.before || !ep.after) return 'unverifiable';
return scoreRecovery(metricOf(ep.kind), ep.before, ep.after, cfg.releaseRate, cfg.minEffect);
```

`metricOf(kind)` maps each kind to the one signal its recovery registers in:

| Metric | Kinds | Recovery signal |
|---|---|---|
| `timeout` | `return-path-degraded`, `chronic-return-path`, `quiet-node` | reply-timeout rate falls |
| `flap` | `dead-flap` | Alive↔Dead transitions stop |
| `rssi` | `weak-signal` | signal strength rises ≥ 4 dB |
| `rtt` | `rtt-degraded` | round-trip time drops ≥ 25% AND ≥ 20 ms |
| `rate` | `rate-fallback` | negotiated PHY rate climbs back to ≥ 100k |
| `none` | `chatty-device`, `ghost-suspect`, `mesh-interference`, … | no per-node recovery window → always `unverifiable` |

`scoreRecovery` holds one branch per metric, and **every branch keeps the same honesty contract**: an evidence-poor or incomparable before/after pair is `unverifiable` (never a fabricated win), a genuine regression is `worse`, and "improvement" always requires a threshold crossing plus a minimum effect size — never a raw count nudging in the right direction.

The tuning constants (all defaults; overridable via `OutcomeStoreOptions`, but the add-on wires only `path` + `log`, so in production these are effectively fixed):

```ts
const DEFAULTS = { releaseRate: 0.075, minEffect: 0.05, minEpisodes: 4, decay: 0.03 };
const MIN_WINDOW_TX = 5;   // timeout metric: both windows must carry ≥5 commands
const TRAFFIC_FACTOR = 3;  // timeout metric: before/after tx must be within 3× of each other
const WORSE_FACTOR = 1.5;  // timeout & rtt: a value that grew past 1.5× the before is a regression
const MIN_OBS = 3;         // rssi/rtt: both medians need ≥3 fresh READINGS (rssiN/rttN), not just fresh samples
const MIN_LIVE = 3;        // flap: the AFTER window needs ≥3 fresh samples proving the node is alive & talking
const RSSI_MIN_GAIN = 4;   // dB gain (or drop) that counts as an rssi improvement (or regression)
const RTT_DROP_FRAC = 0.25; const RTT_MIN_DROP_MS = 20; // rtt improvement needs BOTH
```

Each guard corresponds to a specific way a naïve counter would fool itself:

- **"Success" needs a threshold crossing AND a minimum effect size** — per metric. On the timeout metric, `improved` requires both `after.rate <= releaseRate` (0.075 — mirroring the symptom detectors' release threshold so "resolved" means the same thing here as to the symptom engine) **and** an absolute rate drop `before.rate − after.rate >= minEffect` (0.05). The rtt metric mirrors this with a *fractional* ≥25% drop **and** an absolute ≥20 ms drop (so a 12 ms→9 ms window is not a "win"); the rssi metric needs a ≥4 dB gain; the rate metric needs an actual climb back across the 100k line. A signal merely nudging in the right direction without clearing the bar is `no-change`, not success.

- **Evidence, or it's unverifiable — and each metric gates on evidence of ITS OWN signal.** This is the load-bearing subtlety: `freshN` (fresh-sample count) is **not** a valid evidence floor for rssi/rtt, because a fresh sample routinely carries a null rssi/rtt (the no-signal sentinels), so a median built from a single reading could pass a `freshN ≥ 3` gate. Each branch therefore gates on its own denominator:
    - **timeout** — `comparable(a, b)` gates on TX only: both windows carry ≥ `MIN_WINDOW_TX` (5) commands and are within `TRAFFIC_FACTOR` (3×) of each other. A mesh that went quiet can fake improvement in either direction, because the denominator of a per-command rate collapsing is not a recovery. RX is deliberately **not** gated (a SET-only node legitimately has near-zero unsolicited RX).
    - **rssi / rtt** — both windows need ≥ `MIN_OBS` (3) actual **readings** (`rssiN`/`rttN`), not merely 3 fresh samples. A median backed by fewer readings is `unverifiable`.
    - **rate** — `rateKbpsMin` is folded from **fresh** samples only, so a non-null value already means ≥1 fresh negotiated-rate reading; a quiet after-window (all stale carry-forwards) is `null` → `unverifiable`, never scored from a sticky pre-fix rate.
    - **flap** — flaps are concrete event drains (fresh-independent), so the *before* window needs only prior flapping (`flaps ≥ 1`), **not** a fresh-sample floor a mostly-Dead flapping node rarely meets. The *after* window must instead prove liveness (≥ `MIN_LIVE` fresh samples), so a node that simply went hard-dead — `after.flaps === 0` only because it stopped transitioning — is `unverifiable`, not a fabricated recovery.

- **Regression detection is per-metric too.** Timeout: after-rate past `WORSE_FACTOR` (1.5×) the before *and* still above release → `worse`. RTT: after-median ≥ 1.5× the before → `worse`. RSSI: a ≥4 dB *drop* → `worse`. Flap: *more* flaps after than before → `worse`. Rate: any drop below the before-rate → `worse`. The action (or the interval) made things worse, not neutral.

- **`refused-misdiagnosis` is reserved, keyed to the symptom.** Conceptually a driver refusal (e.g. `remove_failed_node` on a node that actually responds, or a rebuild returning `false`) refutes the *diagnosis*, so it bumps that detector's false-positive tally (`fp`) and NEVER counts as action efficacy. In M5 it is present in the model but **not auto-detected**: `recordActionOutcome` always passes `refused = false`, because the operator-action hook cannot reliably distinguish a genuine driver refusal from a transient WS/connectivity error, and a node-scoped stamp would wrongly mark non-ghost symptoms. That verdict is reserved for a future executor (§3.5) that receives structured driver errors.

- **Per-episode exponential decay.** `bump` discounts all prior history by `keep = 1 − decay = 0.97` on every new episode before adding the new one:

  ```ts
  bump(t, improved) = { n: t.n * 0.97 + 1, ok: t.ok * 0.97 + (improved ? 1 : 0) }
  ```

  Old episodes fade (effective memory ≈ 1/decay ≈ 33 episodes), so a mesh that changed physically eventually forgets stale efficacy. Both `n` and `ok` are floating decayed counts, which is why `Tally` is not an integer pair.

`unverifiable` episodes contribute to **neither** arm — an explicit, honest "we couldn't tell," not a silent zero.

### 9.5 What the planner asks, and what Remedy renders

The learned numbers surface through `efficacyFor(kind, action)`, which returns the `Efficacy` shape (types.ts):

```ts
interface Efficacy {
  expectedEfficacy: number | null; // P(improved | action), but NULL until it beats the control arm
  n: number;                       // decayed episode count backing the estimate
  baseRate: number | null;         // the kind's spontaneous-recovery rate (control arm), for context
  beatsSelfHealing: boolean;       // action rate clears baseRate by minEffect
  ready: boolean;                  // n ≥ minEpisodes — "learning" vs "learned: not distinguishable"
}
```

The computation encodes two more honesty rules:

```ts
efficacyFor(kind, act):
  base = baseRate(kind)                 // control ok/n, or null if control.n < minEpisodes (4)
  t = action[kind|act];  n = t?.n ?? 0;  ok = t?.ok ?? 0
  if (n < minEpisodes) return { expectedEfficacy: null, n, baseRate: base, beatsSelfHealing: false, ready: false }
  rate  = ok / n
  beats = base != null && rate >= base + minEffect     // cannot beat an UNMEASURED base rate
  return { expectedEfficacy: beats ? rate : null, n, baseRate: base, beatsSelfHealing: beats, ready: true }
```

- **`baseRate(kind)` returns `null` until the control arm itself has n ≥ `minEpisodes` (4).** You cannot out-perform a base rate you have not measured, so `beats` requires `base != null`. An action with plenty of attempts but no measured control arm is `ready: true` yet `expectedEfficacy: null` — the planner then says exactly "not distinguishable," never "helped."
- **`expectedEfficacy` stays null until the action beats the control arm** by the minimum effect size (`rate >= base + 0.05`), not merely until minimum-attempts. Note `minEffect` (0.05) does double duty: an *absolute per-command-rate drop* in `computeVerdict`, and a *proportion-of-episodes margin* in `efficacyFor` — different quantities, same conservative constant.

**Planner integration** (`planner.ts`, `planFor`): efficacy is attached only to *executable* candidates — `if (c.action != null) c.efficacy = ctx.efficacyFor(symptom.kind, c.action)`. Physical guidance (no action) gets nothing to score. Critically, this is **purely additive this milestone — recommendation ORDER is unchanged**; efficacy is *shown, not yet used to rank*. A route-rebuild candidate is never a runnable recommendation regardless (it cannot fix a physical link, deletes manual priority routes, and throws on Long-Range nodes), so it never carries a "helped" note.

**Remedy screen** (`telnet/screens/remedy.ts`, `efficacyNote`) renders the note **only on a runnable candidate** (`cand.action != null && cand.blocked == null`) — a blocked or anti-pattern row must never carry a green "✓ helped…" that contradicts the advice:

```
!e || !e.ready         → (nothing)   // still learning: say nothing, honestly
e.expectedEfficacy != null → green "✓ helped 82% (n=6) vs 40% self-heal"
otherwise (ready)      → grey  "≈ n=7: not distinguishable from self-healing"
```

The `vs Y% self-heal` clause is appended only when `baseRate != null`, and `n` is printed right after the headline percent so the trust signal survives 40-column truncation.

The full read path each frame: Remedy `symptomBlock` → `planFor(sym, node, { writeActions, efficacyFor })` → `ctx.efficacyFor` → `DataProvider.efficacyFor` → `zwaveData.efficacyFor` (returns `null` when the ledger is off) → `outcomes.efficacyFor` → `Efficacy` → `efficacyNote`.

### 9.6 Persistence, reset, and edge guards

**Persistence.** The store persists to `OUTCOMES_PATH` (config.ts:97, exported as `/data/outcomes.json`; absent → in-memory only). `save()` is atomic (write `${path}.tmp`, then `renameSync`); `load()` is a no-op if the path is unset/missing and swallows corrupt JSON ("starting fresh"). It is loaded once at startup (`this.outcomes?.load()`), flushed by a 5-minute `setInterval` (`.unref()`'d so it never holds the event loop open), and flushed again on shutdown. The store is only constructed when baselines exist (`this.baselines ? createOutcomeStore(...) : null`) — no baselines, no outcome learning.

`toJSON` writes `{ v: 1, control, action, fp }`. **Open episodes are deliberately NOT persisted** — an episode spanning a restart lost its before-window's continuity and cannot yield an honest verdict, so it re-opens fresh when the symptom is re-detected. `loadJSON` refuses any payload whose `v !== 1` and runs every tally through `validTally` (finite, `n >= 0`, `ok >= 0`, `ok <= n + 1e-9`) before admitting it.

**Network-identity reset.** The learned arms belong to one physical mesh. On a controller `home_id` change (stick swap / different NVM restore), `reset()` wipes open episodes and both arms, and — uniquely — **immediately `save()`s the empty state through to disk**, so a restart cannot reload the old network's learning from `/data`. `pendingResolve` is cleared alongside. This mirrors `baselines.reset()`.

**Node departure.** When a node leaves the roster, any open episodes for it are `abandon()`ed (dropped without a verdict) and their `pendingResolve` timers deleted — the after-window would be empty, and a node-id reuse after `replace_failed_node` must start clean.

**Option hygiene.** `clean()` strips `undefined` keys (and `log`) from the options before the `{ ...DEFAULTS, ...clean(opts) }` spread, so an explicitly-passed `undefined` can never clobber a default with `undefined`.

### 9.7 Known scoping limitations (as-built)

Two deliberate departures a maintainer must know:

- **Timeout-rate-only scoring.** Success is scored solely by the per-command timeout rate — the primary reliability signal, apt for the return-path / timeout family. A symptom kind whose recovery does *not* show up as a timeout-rate change (a purely RSSI-based weak-signal, or a rate-fallback where the node still responds) yields no measurable improvement and simply reads `unverifiable` / `no-change`, accruing no efficacy. That is honest but incomplete; per-kind recovery metrics are a future refinement.

- **Marginal (un-banded) arms — a documented diurnal confound.** Each `Episode` records a `band` (from `bandOf(onsetMs)`, the same 6×4h time-of-day bands as `baselines.ts`), but the arm keys are **marginal**: control by `kind`, action by `${kind}|${act}` — band is *not* in either key. DESIGN §3.6's bullet describing the action arm as keyed by `(kind, action, time-of-day band)` is superseded by this as-built decision: per-band keying would need n ≥ `minEpisodes` across 6 bands to learn anything, and comparing a band-summed action rate against an un-banded base rate is a Simpson's-paradox confound. Both arms are kept marginal on purpose, with the diurnal limitation documented rather than papered over.

## 10. The Interference Watch (M6)

The INTERFERENCE screen is the mesh's RF-environment console: one page that answers "is the 900 MHz band around this controller quiet, is the serial link to the stick healthy, and is anything degrading many nodes at once?" It shipped in **M6 (v0.17)** and is reached with key **`8`** or **`f`** (`i` is already the re-interview action, so interference borrows `f` for "inter**F**erence").

Like every M6 surface it is strictly **read-only and advisory**. Nothing on this screen detects, decides, or acts — it *assembles* what the evidence store, the driver-WS client, and the symptom detectors already measured into one render-ready view. The screen file (`server/src/telnet/screens/interference.ts`) is a **pure renderer**; all the arithmetic lives in a single pure function, `computeInterference()` in `server/src/zwave/interference.ts`, and the heavy part of that computation is memoized one layer below (§10.2).

The whole screen exists because of a load-bearing measurement fact: Home Assistant's WebSocket API **strips `backgroundRSSI`** off controller statistics, so through HA alone there is *no* path to a real noise-floor number. The read-only driver-WS client added in v0.13 reconnects that path. Everything in the top panel of this screen is therefore gated on that client being connected and reporting for the right network.

### 10.1 Anatomy of the screen

`renderInterference(ctx)` reads the pre-computed view once — `const iv = data.interference()` — and emits four labelled panels, top to bottom:

| Panel | Source field | One-line meaning |
| --- | --- | --- |
| **NOISE FLOOR** | `iv.noise` | per-channel 900 MHz background RSSI + a fixed-scale trend spark (driver-measured; lower = quieter) |
| **CONTROLLER SERIAL LINK** | `iv.serial` | host↔stick NAK/CAN/timeout rates, shown *apart* because a serial fault mimics mesh-wide RF trouble |
| **DIURNAL TIMEOUT-RATE HEATMAP** | `iv.diurnal`, `iv.coverageDays` | hour-of-day mesh-wide **raw** timeout rate — deliberately not baseline-relative |
| **CORRELATED DEGRADATION** | `iv.correlated` | the current mesh-interference state from the detector (inferred-by-exclusion) |

The body is built into a `string[]` and handed to `frame(view, data, {...})` with `title: 'INTERFERENCE'`, a `rightStatus`, and the key legend `[['1-8','SCREENS'],['Q','BACK']]`. Because the correlated-degradation panel is the *last* body section and can be clipped on a short terminal, an active event is also mirrored into the never-clipped title rule:

```
right = iv.correlated.active
  ? c.yellowB('⚠ correlated') + c.grey(' · ') + noiseStr   // noiseStr = "clean · -101 dBm" or "noise n/a"
  : noiseStr;
```

### 10.2 Data flow and the memoization boundary

```
driver-WS client ─┐
                  ├─► ZwaveData.interference()  ──►  computeInterference()  ──►  InterferenceView
evidenceStore ────┤    (memoized 10 s, zwaveData.ts:916)   (pure, interference.ts:80)      │
symptom detector ─┘                                                                          ▼
                              DataProvider.interference()  ◄── index.ts:82 / dataProvider.ts:214
                                          │
                                          ▼
                              renderInterference(ctx)  (pure render, ≤ view.cols per line)
```

The expensive step is the diurnal fold: it walks **every non-controller node's coarse-bucket ring** (30-minute buckets over a 14-day horizon — up to ~672 buckets/node, ≈26k buckets across a 39-node mesh). The telnet screen redraws at ~1 Hz, so folding that per frame would be wasteful. The fold is therefore memoized in `ZwaveData.interference()` on the **~10-second sample cadence**:

```ts
// zwaveData.ts:916
interference(): InterferenceView {
  const now = Date.now();
  if (this.lastInterference && now - this.lastInterference.at < 10_000) return this.lastInterference.view;
  const bgChannels =
    this.driverBgRssi && now - this.driverBgRssi.at <= 90_000 && this.driverHomeOk()
      ? this.driverBgRssi.channels
      : null;                                          // ← 90 s driver freshness + homeId guard
  const coarseByNode = new Map<number, CoarseBucket[]>();
  if (this.evidenceStore) {
    for (const n of this.lastNodes) {
      if (n.isController) continue;
      const cb = this.evidenceStore.coarseForNode(n.nodeId);
      if (cb.length) coarseByNode.set(n.nodeId, cb);
    }
  }
  const controllerSamples = this.evidenceStore ? this.evidenceStore.controllerSamples() : [];
  const view = computeInterference({ now, bgChannels, controllerSamples, coarseByNode, symptoms: this.lastSymptoms });
  this.lastInterference = { at: now, view };
  return view;
}
```

So `renderInterference` always renders a view at most 10 s stale, and the fold runs at most once per 10 s regardless of frame rate. The memo is also invalidated wholesale on a network-identity change (the driver-WS `homeId` mismatch purge, zwaveData.ts:~1232 drops `driverBgRssi` so a stranger's telemetry can never leak into this view).

`computeInterference()` takes exactly this shape and returns the render-ready `InterferenceView`:

```ts
interface InterferenceInput {
  now: number;
  bgChannels: (number | null)[] | null;      // current ch0..3 background RSSI, or null when no live reading
  controllerSamples: ControllerSample[];      // the ~40-min controller ring (bg trend + serial rates)
  coarseByNode: Map<number, CoarseBucket[]>;  // per-node 30-min × 14-day buckets → the diurnal heatmap
  symptoms: Symptom[];                         // live symptoms → correlated-degradation state
}
```

```ts
interface InterferenceView {
  noise:  { channels: (number|null)[]; floor: number|null; real: boolean; trend: number[];
            band: 'clean' | 'elevated' | 'noisy' | 'unknown' };
  serial: { nakPerH: number|null; canPerH: number|null; tmoAckPerH: number|null; tmoRespPerH: number|null;
            band: 'healthy' | 'strained' | 'unknown'; spanH: number };
  diurnal: { hour: number; rate: number|null; tx: number }[];   // length 24
  coverageDays: number;
  correlated: { active: boolean; degradedNodes: number; narrative: string };
}
```

Module-level constants in `interference.ts`:

```ts
const HOURS = 24;
const MIN_HOUR_TX = 20;        // below this many TX in an hour, its rate is not meaningful → null
const MIN_SERIAL_SAMPLES = 2;  // need ≥2 controller samples to form any per-hour rate
```

### 10.3 The noise floor — masthead-identical median

**The number.** The representative floor is a **median**, computed identically to the masthead's `computeNoiseFloor` so the two screens can never disagree. `medianFloor(channels)` (interference.ts:70) takes the **leading contiguous run** of channels — the driver's own convention, where a `null` channel *ends* the run — then medians the finite, negative values:

```ts
function leadingRun(channels: (number|null)[]): number[] {   // inlined to avoid a module cycle
  const out = []; for (const ch of channels) { if (ch == null) break; out.push(ch); } return out;
}
function medianFloor(channels) {
  const vals = leadingRun(channels).filter(v => Number.isFinite(v) && v < 0).sort((a,b) => a - b);
  if (!vals.length) return null;
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid-1] + vals[mid]) / 2;   // even → mean of the two middles
}
```

The `< 0` predicate is what rejects the RSSI sentinels (125 = no-signal, 126 = saturated, 127 = not-available) that the driver uses in place of a real dBm. If no channel survives, the floor is `null`.

**Inputs and freshness.** `channels` comes from `input.bgChannels`, which the data layer sets only when the driver-WS reading is **≤ 90 s old AND the driver's `homeId` matches HA's** (`driverHomeOk()`); otherwise it is `null`, and `computeInterference` substitutes `[null,null,null,null]`. So `real = floor != null` — a live, in-network reading — and when it is false the screen prints the honest unavailable message instead of a fabricated dBm:

```
◷ unavailable — the read-only driver-WS client is not connected.
    (HA strips backgroundRSSI; set driver_ws_url to enable this.)
```

**The band.** `noiseBand(floor, real)` classifies the floor with fixed thresholds tuned for 800-series 900 MHz Z-Wave:

| Condition | Band | Colour |
| --- | --- | --- |
| `!real \|\| floor == null` | `unknown` | grey |
| `floor <= -98` | `clean` | green |
| `-98 < floor <= -88` | `elevated` | yellow |
| `floor > -88` | `noisy` | red (bold) |

The interpretive rule-of-thumb (documented in the file header): near **−100 dBm is quiet**, and **≈ −110 dBm is the near-radio ideal**. On the live mesh this reads clean — the measured noise floor logged at **−102 dBm (RF clean)** once the driver-WS path came up in v0.13.

**The trend spark.** The trend is the same per-sample median taken across the controller ring — every `ControllerSample` in `input.controllerSamples` whose `bg0..3` produce a non-null median contributes one point (note: the trend does **not** require `fresh`, unlike the serial rates in §10.4):

```ts
for (const s of input.controllerSamples) {
  const m = medianFloor([s.bg0, s.bg1, s.bg2, s.bg3]);
  if (m != null) trend.push(m);
}
```

The controller ring (`CTRL_MAX_SAMPLES = 240` in evidenceStore.ts, one sample per ~10 s poll) spans roughly **40 minutes** — this is the recent controller ring, deliberately **not** the 14-day coarse tier. The spark is drawn on a **fixed −110..−80 dBm scale**, never auto-scaled:

```ts
const spark = iv.noise.trend.length >= 2
  ? sparkline(iv.noise.trend, Math.min(24, iv.noise.trend.length), { min: -110, max: -80, color: c.cyan })
  : c.grey('· building trend');
```

The fixed window is a correctness choice, not a cosmetic one: an auto-scaled spark over a flat quiet floor would amplify ±1 dB jitter into fake spikes. With the fixed scale a quiet floor reads flat and low, and only a real rise visibly climbs. `sparkline` itself renders a genuinely flat (all-equal) series as a mid-height grey line rather than a red row of minima. With fewer than two points it shows `· building trend`.

### 10.4 Controller serial-link health

A fault on the **host↔stick serial link** (USB contention, a bad extension cable, a flaky port) produces symptoms that look exactly like mesh-wide RF trouble — timeouts and retries across the board. This panel is shown *apart* precisely so an operator doesn't chase RF ghosts when the real problem is the USB stick.

Only **fresh** controller samples are used, and only if there are at least `MIN_SERIAL_SAMPLES` (2) of them. The per-hour rates are computed with an explicit fencepost:

```ts
const cs = input.controllerSamples.filter(s => s.fresh);
let nak=0, can=0, tmoAck=0, tmoResp=0, spanMs=0;
if (cs.length >= MIN_SERIAL_SAMPLES) {
  spanMs = Math.max(0, cs[cs.length-1].t - cs[0].t);
  for (let i = 1; i < cs.length; i++) {                 // sum deltas from the SECOND sample on
    nak += cs[i].dNak ?? 0;  can += cs[i].dCan ?? 0;
    tmoAck += cs[i].dTimeoutAck ?? 0;  tmoResp += cs[i].dTimeoutResponse ?? 0;
  }
}
const spanH = spanMs / 3_600_000;
const perH = x => (spanH > 0 ? x / spanH : null);
```

The fencepost matters: `cs[0]`'s own delta covers the window *before* the span begins (up to `cs[0].t`) and must not be attributed to `[cs[0].t, last]`. Each of `cs[1..last]`'s deltas covers a sub-window strictly inside the span, so summing those and dividing by `spanH` gives an honest per-hour rate. `spanH` (rounded to 0.1 h) is printed so the operator knows how much history backs the numbers.

**What sets "strained."** Only the three genuine serial-fault counters vote:

```ts
let serialBand = 'unknown';
if (spanH > 0) {
  const worst = Math.max(nakPerH ?? 0, canPerH ?? 0, tmoAckPerH ?? 0);   // NAK, CAN, timeout-ACK
  serialBand = worst >= 5 ? 'strained' : 'healthy';                       // ≥ 5 events/hour on any one
}
```

`timeoutResponse` (surfaced as **`reply-tmo`**) is displayed but **deliberately excluded from the band**. This is a direct consequence of the project's load-bearing counter semantics: a `timeoutResponse` is a *per-node* reply timeout — a Get whose answer never came while the node stayed Alive — not a host↔stick serial fault. It is the TUI's genuine RF-reliability signal, so it belongs to the node, not to the serial link. (Correspondingly, `commandsDroppedTX` is not on this panel at all: it does not count RF ACK failures, so it would be noise here.)

The row renders NAK / CAN / tmo-ACK / reply-tmo as `N/h` integers, coloured green when `healthy`, bold yellow when `strained`, grey when `unknown`. With fewer than two fresh samples the band is `unknown` and the panel prints `◷ not enough controller-sample history yet.`

> Note the two independent serial thresholds in the codebase: this screen's `worst >= 5/h` band is *separate* from the `controller-degraded` symptom detector's own absolute thresholds in `symptoms.ts`. This panel is a live gauge; the detector is what actually raises a symptom and drives the correlated-degradation logic in §10.6.

### 10.5 The diurnal timeout-rate heatmap

This is the conceptual centrepiece of M6, and its design is a deliberate rejection of the engine's own baselining. The detectors use **time-of-day-banded baselines**, which are *blind by construction* to recurring diurnal interference — a smart meter that transmits every night at 02:00, or a baby monitor that runs overnight, gets folded into the band's notion of "normal for 02:00" and never trips. This heatmap is the human's window onto exactly that blind spot: the **raw, absolute** mesh-wide timeout rate by hour of day, showing what the bands quietly absorbed.

**The fold.** For every node's coarse bucket, the bucket's timeout and TX deltas are summed into a 24-slot array keyed by the **local** hour of the bucket's start time:

```ts
const toByHour = new Array(24).fill(0), txByHour = new Array(24).fill(0);
let minT0 = Infinity, maxT0 = -Infinity;
for (const buckets of input.coarseByNode.values())
  for (const b of buckets) {
    const h = new Date(b.t0).getHours();               // LOCAL hour-of-day
    if (h < 0 || h >= HOURS) continue;
    toByHour[h] += b.dTimeout;  txByHour[h] += b.dTx;
    if (b.t0 < minT0) minT0 = b.t0;  if (b.t0 > maxT0) maxT0 = b.t0;
  }
const diurnal = toByHour.map((to, hour) => ({
  hour, tx: txByHour[hour],
  rate: txByHour[hour] >= MIN_HOUR_TX ? to / txByHour[hour] : null,   // null when the hour is too quiet
}));
const coverageDays = Number.isFinite(minT0) ? Math.max(0, (maxT0 - minT0) / 86_400_000) : 0;
```

Each hour's `rate` is `timeouts / TX` over all buckets that ever landed in that hour, across the whole 14-day coarse horizon. An hour with fewer than `MIN_HOUR_TX = 20` commands is reported as a **null cell** rather than a noisy fraction over a tiny denominator.

**Absolute scale (the whole point).** The render maps rate onto a fixed **0 → 5 %** ramp, never normalized to the row's own max:

```ts
const HEAT_MAX = 0.05;                                 // 5% per-command timeout; a healthy mesh sits ~2%
function heatFor(rate) {
  if (rate == null) return heatCell(0, { none: true }); // grey '·' for a no-traffic hour
  return heatCell(rate / HEAT_MAX, { color: heatColorFor(rate) });
}
```

A normalized-to-max scale would be, itself, baseline-relative — the exact thing this heatmap exists to avoid. On the absolute scale a genuinely quiet mesh renders uniformly cool, and a persistently hot hour stands out as an *absolute* fact.

`heatCell(frac, {color})` picks a shade block from `['░','▒','▓','█']` by density (`SHADES[min(3, floor(frac*4))]`) and paints it with an explicitly-passed colour. That colour override is load-bearing: `heatCell`'s default `zoneColor` is built for SNR margin (high = good = green), but a timeout *rate* is the opposite polarity (high = bad = red). `heatColorFor` inverts it:

```ts
function heatColorFor(rate) {
  const f = rate / HEAT_MAX;
  if (f >= 0.75) return c.redB;      // ≥ 3.75%
  if (f >= 0.50) return c.yellowB;   // ≥ 2.5%
  if (f >= 0.25) return c.yellow;    // ≥ 1.25%
  return c.green;                     // < 1.25%
}
```

The strip is 24 cells wide, drawn under a fixed hour axis with markers at 0/6/12/18/23 (`hourAxis()`), followed by a **worst-hour** callout: the highest-rated hour, labelled `HH:00` with its percentage in the matching heat colour, plus a plain-language coda — *"a persistently hot hour = recurring interference."*

**Honest coverage states.** The panel refuses to show a heatmap until the coarse tier actually spans the day. `coverageDays` is the wall-clock span between the earliest and latest bucket. If it is `< 0.5` days the whole strip is replaced with `◷ building — needs coarse history across the day (a few days).`; only above that does the strip render. The `n days` label pluralizes at `>= 1.5`. Hours that never cleared `MIN_HOUR_TX` stay as grey `·` cells, so partial coverage is visible rather than papered over.

### 10.6 Correlated degradation — the detector owns the ratio

The bottom panel reports whether the mesh is currently in a **correlated-degradation event**, as judged by the `mesh-interference` symptom detector. `computeInterference` does **not** re-derive the "degraded X of Y active" ratio — a critical piece of discipline, because a separately-computed numerator and denominator can be incoherent (X > Y, or "X of 0"). Instead it reads the detector's own coherent narrative verbatim and only counts distinct nodes for the honest *inactive* label:

```ts
const mesh = input.symptoms.find(s => s.kind === 'mesh-interference');
const degradedNodes = new Set(
  input.symptoms.filter(s => s.nodeId != null && s.kind !== 'controller-degraded').map(s => s.nodeId)
).size;
const correlated = {
  active: mesh != null,
  degradedNodes,
  narrative: mesh
    ? mesh.narrative                                                   // detector's own "X/Y active" text
    : degradedNodes > 0
      ? `${degradedNodes} node${degradedNodes === 1 ? '' : 's'} degraded, but not correlated into a mesh event.`
      : 'No correlated mesh degradation.',
};
```

When a mesh event is live, the detector's narrative carries the coherent ratio it computed under hysteresis (fire-high/release-low over active nodes) — e.g. *"Many nodes degraded together with no controller-serial or flooding cause — likely an RF-environment event…"* — and the screen renders it with a bold-yellow `⚠ correlated mesh degradation` header, word-wrapped to two lines. Note this state is **inferred by exclusion**: the detector's own text is honest that no noise-floor measurement confirms it yet ("treat as a lead, not a verdict"). When no event is active, the panel shows a green `✓` and either the plain count of distinct symptomatic nodes or "No correlated mesh degradation." — never an invented denominator.

### 10.7 Tunables and constants

Every number the Interference Watch uses is a **fixed, tuned constant** — there is no per-screen config surface; the only user knob that changes what this screen can show is `driver_ws_url` (empty disables the noise panel entirely). A maintainer changing behaviour edits these directly:

| Constant | Value | File | Governs |
| --- | --- | --- | --- |
| `noiseBand` clean threshold | `floor <= -98` dBm | interference.ts | green "clean" cutoff |
| `noiseBand` elevated threshold | `-98 < floor <= -88` | interference.ts | yellow "elevated" band |
| spark scale | fixed `min -110`, `max -80` dBm | interference.ts | trend spark axis (anti-jitter) |
| `MIN_SERIAL_SAMPLES` | `2` | interference.ts | min fresh controller samples for any serial rate |
| serial `strained` threshold | `worst >= 5` /h | interference.ts | NAK/CAN/tmo-ACK band cutoff |
| `MIN_HOUR_TX` | `20` | interference.ts | min TX before an hour gets a rate (else null cell) |
| `HOURS` | `24` | interference.ts | heatmap width |
| `HEAT_MAX` | `0.05` (5 %) | screens/interference.ts | absolute heat-scale ceiling |
| `heatColorFor` bands | 0.25 / 0.5 / 0.75 of HEAT_MAX | screens/interference.ts | green→yellow→yellowB→redB |
| building threshold | `coverageDays < 0.5` | screens/interference.ts | "building" vs. render heatmap |
| driver-WS freshness | `<= 90_000` ms | zwaveData.ts | bg reading counts as live |
| view memo TTL | `< 10_000` ms | zwaveData.ts | fold cadence |
| `CTRL_MAX_SAMPLES` | `240` (~40 min @ 10 s) | evidenceStore.ts | controller ring depth (trend + serial) |
| `COARSE_BUCKET_MS` / horizon | `30 min` / `14 days` | evidenceStore.ts | heatmap bucket size + history depth |

### 10.8 Edge-case guards — summary

- **No driver-WS / stale / wrong network** → `bgChannels = null` → `real = false`, `band = unknown`; noise panel prints the honest "unavailable" text with a config hint, never a fabricated dBm. The 90 s freshness bound and the `homeId` guard prevent a stale or cross-network reading from ever showing.
- **RSSI sentinels** (125/126/127) are excluded by the `v < 0` filter in `medianFloor`, so a saturated/no-signal channel can't skew the median.
- **Thin trend** (< 2 points) → `· building trend` instead of a one-bar spark; a flat series renders as a steady grey line, not a red row of minima.
- **Serial link, < 2 fresh samples** → band `unknown`, `◷ not enough controller-sample history yet.` The fencepost drops `cs[0]`'s pre-span delta so rates aren't inflated.
- **`reply-tmo` never sets the serial band** — it's a per-node RF signal (`timeoutResponse`), shown for context only; only NAK/CAN/tmo-ACK vote "strained."
- **Heatmap, thin coverage** (`< 0.5` days) → `◷ building…`; **quiet hours** (`< 20` TX) → grey `·` null cells, never a fraction over a tiny denominator.
- **Absolute scale, explicit inverted colour** — the heatmap is never normalized-to-max (that would reintroduce the baseline-relativity M6 exists to escape), and `heatColorFor` inverts `heatCell`'s SNR-oriented default so a hot hour reads red, not green.
- **Ratio coherence** — the correlated panel reuses the detector's own narrative rather than recomputing a numerator/denominator that could be incoherent; the inactive label falls back to a plain distinct-node count.
- **Cost containment** — the ~26k-bucket fold is memoized 10 s and invalidated on network-identity change, so a 1 Hz redraw never re-folds and a stranger's telemetry can't survive a `homeId` mismatch.

## 11. Write Actions, Type-CONFIRM Safety & Authentication

Every other chapter of this reference describes how the TUI *reads* the mesh. This one describes the only surface that *writes* to it — the seven mutating verbs the operator can request, and the two independent gauntlets each request must clear before a single byte reaches the Z-Wave JS driver:

1. a **master gate** (`write_actions_enabled`) that must be flipped on at all, and
2. a **deliberate, per-action, type-`CONFIRM` modal** that no timer, engine, or streaming event can bypass.

This is the concrete expression of the add-on's founding constraint: **the remediation engine is advisory-only by the owner's decision.** Nothing auto-executes. The M2–M6 engine detects symptoms, learns action efficacy, and (M4) *ranks candidate remedies* — but the act of mutating the mesh always routes through the human-driven Actions Menu described here. The designed-but-unbuilt `executor` / `auto_remediation` / `auto_safe` tiers would have their own gate; today there is no code path from a detector to a WS command. The only trigger is a person typing `CONFIRM` and pressing Enter.

The chapter closes with the **authentication** layer that decides who is allowed to sit at that keyboard in the first place.

### 11.1 Two-layer architecture

The mutating surface is split across four pure-ish modules plus the session state machine, so that *what an action is*, *how dangerous it is*, *how it's confirmed*, and *how it's executed* are each independently testable:

| Concern | File | Owns |
|---|---|---|
| Verb execution (WS command shapes) | `server/src/zwave/zwaveActions.ts` | `createActionRunner` → the `ActionRunner` |
| Catalog + impact classification + menu model | `server/src/telnet/actionsCatalog.ts` | `ACTION_CATALOG`, `buildMenu`, `CONFIRM_WORD` |
| Rendering (menu overlay + confirm modal) | `server/src/telnet/screens/actionsMenu.ts` | `renderActionsMenu`, `renderTypeConfirm` |
| Confirm/menu **state machine** | `server/src/telnet/session.ts` | `TuiSession` — `beginAction`, `openMenu`, `handleTypeConfirmKey`, `executeAction` |
| Login gate (who may connect) | `server/src/auth/loginPolicy.ts` | `createAuthPolicy` → the `AuthPolicy` |
| HTTP/ws origin + write-token | `server/src/auth.ts` | `createAuth` → origin allow-list, `requireWriteAuth` |

`actionsCatalog.ts` is deliberately a **pure module (no I/O, no session state)** — the menu contents, impact tiers, and context-gating are all unit-testable in isolation. The session owns the transient cursor and the type-`CONFIRM` buffer; the renderer only draws descriptors; the runner only executes a `kind`.

### 11.2 The ActionRunner — verbs & WS command shapes

`createActionRunner(o: ActionRunnerOptions)` (in `zwaveActions.ts`) returns an object implementing the `ActionRunner` interface (`server/src/types.ts:342`). Seven verbs, each returning `Promise<ActionResult>` where `ActionResult = { ok: boolean; message: string }`. The exact WS command shapes were **probed against the live driver** and are documented in the file header; they fall into three families:

```
verb            impact       WS command (via HaWsClient.send)
────────────────────────────────────────────────────────────────────────────
ping            safe         call_service button.press { entity_id }   (idempotent)
refreshValues   caution      zwave_js/refresh_node_values { device_id }
reInterview     caution      zwave_js/refresh_node_info   { device_id } (heavy)
healNode        caution      zwave_js/rebuild_node_routes { device_id } (mutating)
rebuildAll      destructive  zwave_js/begin_rebuilding_routes { entry_id } (disruptive)
stopRebuild     caution      zwave_js/stop_rebuilding_routes { entry_id }
removeFailed    destructive  zwave_js/remove_failed_node  { device_id } (destructive)
```

Three helpers build the command envelope and encode the runner's *resolution* responsibilities:

- **`deviceCmd(type, nodeId)`** resolves `nodeId → HA device_id` via the injected `deviceIdOf`. Throws `node ${nodeId} has no device` if unknown. Used by `refreshValues`, `reInterview`, `healNode`, `removeFailed`.
- **`entryCmd(type)`** resolves the current `zwave_js` config-entry id via `entryId()`. Throws `no zwave_js entry` if not yet discovered. Used by `rebuildAll`, `stopRebuild`.
- **`ping`** is the odd one out: it does *not* use a `zwave_js/*` command. It resolves `nodeId → button.*_ping entity_id` via `pingEntityOf` and fires a generic `call_service` on `domain: 'button', service: 'press'`. Throws `node ${n} has no ping button` if the node exposes no ping entity.

These callbacks are wired in `index.ts` (step 4b) against the data layer: `entryId: () => zwaveData.getEntryId()`, `deviceIdOf`, `pingEntityOf`, and the two hooks (`log`, `onOutcome`) described in §11.8.

#### The `run()` wrapper — gate, log, execute, learn

Every verb is a thin call into a shared `run(kind, nodeId, verb, fn)` closure that enforces a fixed lifecycle (`zwaveActions.ts:50`):

```
if (!o.enabled) return { ok:false, message:'write actions are disabled' };   // ← master gate (defence in depth)
log('info', node, `${verb} …`);                                             // start line → event ring
try {
  await fn();
  log('info', node, `${verb} → ok`);
  onOutcome?.(kind, node, true);                                            // M5 hook (success)
  return { ok:true, message:`${verb}: ok` };
} catch (e) {
  log('error', node, `${verb} → failed: ${msg}`);
  onOutcome?.(kind, node, false);                                           // M5 hook (failure)
  return { ok:false, message: msg };
}
```

Two consequences worth stating explicitly:

- The `!o.enabled` check inside `run()` is a **second** guard — the session already refuses to construct actions when disabled, but the runner will not execute even if called directly. Defence in depth.
- Every outcome (start, ok, failed) is written to the **event ring with source `'you'`**, so the Log screen *closes the loop* on a manual action just as it does for engine/system events. Failures carry the underlying error message verbatim (`errMsg` unwraps `Error.message`).

### 11.3 The master gate: `write_actions_enabled`

The runner's `enabled` field is a hard on/off master switch, **defaulting OFF** — v0.1 was a pure read-only monitor.

Trace of the gate:

```
config.yaml       write_actions_enabled: false        (option, bool)
   ↓ s6 run script (bashio::config.true) — NUMERIC convention
env               WRITE_ACTIONS_ENABLED = "1" | "0"
   ↓ config.ts
config.writeActions = process.env.WRITE_ACTIONS_ENABLED === '1'
   ↓ index.ts (createActionRunner … enabled: config.writeActions)
ActionRunner.enabled
```

The env bridge follows the run script's **numeric** boolean convention (`1`/`0`, never the strings `true`/`false`); `config.ts` compares against `'1'`. Flipping one side without the other silently makes the knob dead — a documented footgun.

At the session level, `enabled` drives three behaviours:

- **Shortcut keys** (`p`/`i`/`h`/`x`/`R`) are only routed when `this.actions?.enabled` (`session.ts:412`). In read-only mode they fall through to normal navigation.
- **The Actions Menu (`a`)** opens regardless of `enabled` — it's informational in read-only mode (you can read every impact) — but selecting a row when locked yields an explanatory notice rather than arming anything (`selectMenuItem`, §11.6).
- The menu header renders a `READ-ONLY` (yellow) vs `ARMED` (green) badge from the `locked = !this.actions?.enabled` flag.

`index.ts` logs the posture at boot: `write actions ENABLED (each requires a typed CONFIRM) …` or `write actions disabled (read-only) — set write_actions_enabled to unlock`.

### 11.4 The action catalog & the SAFE / CAUTION / DESTRUCTIVE tiers

`ACTION_CATALOG` (`actionsCatalog.ts:46`) is the single source of truth. It lists the seven descriptors **in menu order — device actions first (least→most dangerous), then system-wide.** Each `ActionDescriptor` carries a `kind`, a `label`, a `scope` (`'device' | 'system'`), an `impact`, a `desc` ("what it does"), an `impactNote` ("what to expect", shown in the confirm box), and `needsNode`.

The three **impact tiers** drive both the UI colour/badge and the confirm posture:

| Tier | Colour | Meaning | Members |
|---|---|---|---|
| `safe` | green | harmless / idempotent | `ping` |
| `caution` | yellow | mutating but recoverable | `refreshValues`, `reInterview`, `healNode`, `stopRebuild` |
| `destructive` | red | disruptive or irreversible | `removeFailed`, `rebuildAll` |

The `impactNote` strings are load-bearing operator guidance, quoted from the catalog:

- **`reInterview`** — *"Heavy: minutes on a mains node; a battery/FLiRS node resumes on its next wake and can take hours. Shows incomplete data until it finishes. Not destructive."*
- **`removeFailed`** — *"IRREVERSIBLE. Only works on a node the controller has marked failed. You must re-pair the device to add it back."*
- **`rebuildAll`** — *"DISRUPTIVE: the whole mesh recomputes routes and is degraded for many minutes. Battery nodes update on their next wake."*

> **Relationship to the M4 planner.** These route-rebuild verbs (`healNode`, `rebuildAll`) exist as *manual* Actions Menu entries, tiered and gated behind type-`CONFIRM`. That is a different thing from a **runnable engine recommendation.** The advisory planner never emits a route rebuild as a runnable candidate — a rebuild cannot fix a physically bad link, it deletes manually-assigned priority routes, and `rebuild_node_routes` *throws* on Long-Range nodes. The catalog offers the verb to a human who has decided to run it; the engine never proposes it as a fix.

`describeAction(kind)` looks a descriptor up by kind (never `undefined` for a known `ActionKind`).

#### Context-gated menu construction

`buildMenu(ctx: MenuContext)` produces the ordered, context-aware `MenuItem[]`. `MenuContext` is `{ hasNode, rebuilding }`:

- **`rebuildAll` and `stopRebuild` are mutually exclusive**: the menu shows `Rebuild ALL routes` while idle and `Stop route rebuild` while a rebuild runs (driven by the controller's `isRebuildingRoutes` flag). This mirrors real controller state so the menu never offers an action that would no-op.
- **Device actions always appear** (so their descriptions stay readable) but are `disabled` with `reason: 'select a node first (Overview/Detail)'` when `!hasNode` — rather than vanishing.

`clampMenuIndex(index, len)` keeps the cursor in range (empty menu → 0).

### 11.5 The Actions Menu overlay & the type-CONFIRM modal (rendering)

`screens/actionsMenu.ts` holds two modal renderers, both honouring the width/height contract (exactly `view.rows` lines, each `≤ view.cols`).

**`renderActionsMenu`** draws the full-frame menu: a header naming the current target (`· target #16 Kitchen`) with a right-aligned `READ-ONLY`/`ARMED` badge (the badge width is reserved *first* so a long target can never truncate the mode flag off a narrow terminal), then rows grouped under `DEVICE ACTIONS` / `SYSTEM-WIDE` headings. Each row is `▶ <label,20> [BADGE,13] — <what it does>`. `LABEL_W = 20`; the badge occupies a fixed 13-cell field (`[DESTRUCTIVE]`) so the description column aligns. A disabled row's `reason` replaces its `desc`. Dimmed styling (`c.grey`) applies when a row is `disabled` **or** the whole menu is `locked`. The footer shows `↑↓ move · ⏎ locked|select · Esc close` and, on the right, either the action count or `enable write_actions_enabled to unlock`.

**`renderTypeConfirm`** draws the deliberate confirm box via `centeredNotice`. It restates label, target, `desc`, and the wrapped `impactNote` (all coloured by impact), then the arming prompt. The title is `⚠  CONFIRM` (destructive) or `CONFIRM`, coloured green/yellow/red by tier. The input field shows the typed buffer plus a cyan block caret `▉`; the instant the buffer **exactly equals** `CONFIRM` it flips to a green `CONFIRM` and the prompt becomes `▶ press Enter to execute`. `Esc = cancel` is always shown.

`CONFIRM_WORD = 'CONFIRM'` (`actionsCatalog.ts:160`) is the exact string the operator must type. It is exported so the session, the renderer, and tests all agree on it.

### 11.6 The confirm state machine (`TuiSession`)

The session drives a strict linear modal flow. State fields (`session.ts`):

```
pendingAction : PendingAction | null   // an action awaiting the typed CONFIRM
confirmBuffer : string                 // what's typed toward CONFIRM
confirmFromMenu : boolean              // reopen the menu on cancel?
actionInFlight : boolean               // a WS call is running
actionNotice : string | null           // "✓ …" / "✗ …" outcome card
menuOpen, menuIndex, menuSnapshot, menuTarget   // frozen menu (§11.7)
```

`feed()` dispatches keys through a **priority ladder** (order matters):
`resize` → `ctrlc` (universal disconnect) → `denied` (any key quits) → `login` gate → `/`-filter capture → **`actionInFlight` (swallow all keys)** → **`pendingAction` (type-CONFIRM capture)** → **`actionNotice` (any key dismisses)** → **`menuOpen` (menu navigation)** → `a` (open menu) → shortcut keys → normal navigation.

#### Entry points → `beginAction`

`beginAction(kind, immediate, node?)` is the **single entry point for both the menu and the shortcut keys** (`session.ts:498`):

- It looks up the descriptor; for device-scoped actions it resolves the target — the **explicit `node`** when the menu supplies its frozen target, otherwise `actionTargetNode()` (the live selection). Returns `false` (no-op) if a device action has no target.
- `actionTargetNode()` is context-sensitive: on the **Log** screen it targets the *highlighted log event's* node (matching what Enter would do), so a key pressed on the Log can't silently actuate the invisible Overview cursor; elsewhere it's the Overview selection.
- **Only a `safe` action fired as `immediate` executes at once.** Everything else — and *everything launched from the menu* — sets `pendingAction` and clears `confirmBuffer`, arming the modal.

Shortcut mapping (`handleActionKey`, only when `enabled`):

| Key | Action | Path |
|---|---|---|
| `p` | `ping` | `immediate=true` → **runs immediately** (safe) |
| `i` | `reInterview` | arms type-CONFIRM |
| `h` | `healNode` | arms type-CONFIRM |
| `x` | `removeFailed` | arms type-CONFIRM |
| `R` | `rebuildAll` | arms type-CONFIRM |

Note there is **no shortcut for `refreshValues` or `stopRebuild`** — those are reachable only through the menu. And `p` is the *only* path that skips confirmation, because a ping is a harmless reachability probe.

#### Type-CONFIRM capture

`handleTypeConfirmKey` (`session.ts:583`) is the arming box:

- `Esc` → `cancelConfirm()`.
- `Enter` → if `confirmBuffer === CONFIRM_WORD`, clear all confirm state and `void executeAction(a)`; **otherwise reset the buffer to empty** so a wrong/partial word must be retyped cleanly (no "almost-armed" state lingers).
- printable chars append, but only while `confirmBuffer.length < CONFIRM_WORD.length` — the buffer can never grow past 7 chars, so overtyping cannot smuggle extra input past the exact-match test. `\x7f`/`\b` backspace one char. Arrows/tab are ignored (you stay in the box).

`cancelConfirm()` drops the pending action; if it came from the menu (`confirmFromMenu`), it **re-opens the menu**, re-snapshotting a fresh target and item list (§11.7).

#### Execute → working → outcome

`executeAction(action)` (`session.ts:624`) sets `actionInFlight`, forces a full repaint (`WORKING` card via `centeredNotice`), then `switch`es on `action.kind` to the matching runner method (node-scoped verbs pass `action.nodeId!`). Any throw is caught into `{ ok:false, message }`. On resolve it clears the in-flight flag and sets `actionNotice` to `✓  <label>` or `✗  <message>`, shown as a `RESULT` card ("press any key to continue · see the Log screen for history"). While in flight, `feed()` **swallows every key** so a second action can't be launched over a running one.

### 11.7 Security guards

The confirm flow is hardened against several concrete attacks and race conditions:

- **Frozen target at menu open.** `openMenu()` captures `menuTarget = actionTargetNode()` and `menuSnapshot = buildMenu(...)` *once*, at the instant the menu opens, and the cursor indexes into that frozen snapshot. Streaming Log events or a rebuild starting/stopping mid-menu therefore **cannot move a row — or the target — out from under the cursor** before the operator selects. `selectMenuItem` passes the frozen `menuTarget` into `beginAction`, so the confirm modal arms against exactly the node the operator saw when they opened the menu, not whatever the live cursor drifted to.

- **Re-lock abandons half-armed actions across the auth boundary.** `resetLogin()` calls `resetActionState()`, which nulls `pendingAction`, clears `confirmBuffer`/`confirmFromMenu`, closes the menu, and drops `actionNotice`. This runs on **both** a fresh login and the **idle re-lock**, so a half-armed *destructive* action can **never survive re-authentication** — a re-authenticated operator must re-open the menu and re-type `CONFIRM` from scratch. `actionInFlight` is deliberately left untouched: an already-dispatched WS command can't be recalled, so its outcome card is simply hidden behind the login screen rather than falsely cancelled.

- **Exact-match arming only.** Because the buffer is length-capped at `CONFIRM_WORD.length` and compared with `===`, the *only* string that arms is the literal `CONFIRM`. A wrong Enter wipes the buffer.

- **Read-only selection is explicit, not silent.** Selecting a menu row while `!actions.enabled` closes the menu and posts `✗ Read-only — set write_actions_enabled in the add-on config to unlock actions.` — a keypress is never silently ignored.

- **In-flight lockout.** All keys are swallowed during `actionInFlight`, preventing double-submission.

- **Menu never offers a no-op.** The `rebuildAll`/`stopRebuild` mutual exclusion tracks live controller state, so the operator can't fire a rebuild-start while one is already running.

### 11.8 The `onOutcome` hook → M5 learning ledger

The runner's optional `onOutcome(kind, nodeId, ok)` fires **after each action resolves** (both success and failure paths of `run()`). It is wired in `index.ts` to `zwaveData.recordActionOutcome`, which attributes the action to the node's open episodes in the M5 outcome ledger.

`recordActionOutcome` (`zwaveData.ts:883`) is deliberately conservative about what becomes learning data:

- **Mesh-wide actions (`nodeId == null`) are dropped.** `rebuildAll`/`stopRebuild` cannot be credited to any single node's episode without confounding, so they are not attributed.
- **Only successful actions become episode data** (`if (!ok) return`). A failed action wasn't really "taken"; and the hook cannot distinguish a genuine driver refusal ("node is not failed") from a transient WS error, so it will **not** infer a `refused-misdiagnosis` verdict from a failure — that verdict is reserved for a future structured-error executor.
- **Actions against an already-recovering symptom are skipped** — `recordAction` is passed a `skip` predicate over `this.pendingResolve`, so an action landing during a symptom's confirmation window isn't credited with a recovery that was happening anyway.

This is the one thread by which manual operator behaviour feeds the learning engine — and it is strictly *observational*: the ledger learns from what the human chose to do; it never chooses.

### 11.9 Authentication — the login gate

Two independent auth mechanisms protect the add-on. Keep them distinct:

1. **The TUI login gate** (`auth/loginPolicy.ts`) — username/password in front of *interactive TUI sessions* (telnet `:2324` and the xterm `/console`). This is the primary subject here.
2. **The HTTP/ws origin + write-token layer** (`auth.ts`, `createAuth`) — CORS origin allow-list, the `/console/ws` upgrade origin check, and `requireWriteAuth` (a Fastify preHandler for future mutating HTTP routes, accepting Supervisor-sourced ingress **or** same-origin **or** the `X-Zwave-Write-Token` header via constant-time compare). v0.1 exposes no mutating HTTP routes, so today this layer only guards CORS + the ws upgrade; **actuating the mesh is gated by `write_actions_enabled` at the action layer, not here.**

#### Trust model — ingress-trusted vs telnet-always-gated

The decisive line is in the `TuiSession` constructor:

```
authRequired = !!auth?.enabled && (!trusted || !!auth?.requireOnIngress)
```

- **HA Ingress (sidebar)** connections are `trusted`. Home Assistant has already authenticated the user; the add-on recognises them by the `X-Ingress-Path` header **and** a Supervisor-subnet source IP. `isIngressTrusted(req) = !!headers['x-ingress-path'] && isSupervisorSource(req.ip)` (`index.ts:130`), where `isSupervisorSource` matches `172.30.32.0/23` (i.e. `172.30.32.*`/`172.30.33.*`, normalising IPv4-mapped IPv6). The header **alone is forgeable** by anything reaching the published LAN port, so the socket-peer pin (`trustProxy: false`, so `req.ip` is unspoofable) is what makes it trustworthy. Trusted connections **skip the login** unless `requireOnIngress` is set.
- **Telnet (`:2324`)** is always constructed with `trusted: false` (`server.ts:278`) — it is direct LAN and never HA-authenticated — so it **always faces the login gate whenever `auth_enabled`.**
- The `/console/ws` transport computes `trusted = isTrusted(req)` per upgrade (`wsConsole.ts:370`).

#### Password handling — scrypt, plaintext, constant cost

`createAuthPolicy(cfg)` normalizes every stored password to canonical `scrypt:<saltHex>:<hashHex>` **at startup** (`normalizeStored` → `hashPassword` with a 16-byte random salt, `SCRYPT_KEYLEN = 32`). Operators may configure either plaintext or a pre-hashed `scrypt:…` string in the `users` list; both end up as scrypt in the in-memory `byName` map.

`verify(username, password)` is engineered against **timing/user-enumeration** attacks:

- It looks up `byName.get(username) ?? dummyHash`, where `dummyHash` is a real scrypt hash of random bytes computed once at construction. A missing username therefore costs **exactly one scrypt**, identical to a hit — response time never reveals whether a username exists.
- The final return is `byName.has(username) && ok`, so the dummy path can never authenticate even on an astronomically unlikely scrypt collision.
- It uses async `crypto.scrypt` (via `scryptAsync`), never `scryptSync`, so credential checking **never blocks the single Node event loop**. The comparison is `timingSafeEqual`.

`parseUsers(json)` tolerates malformed input: non-JSON or non-array → `[]`; each entry needs a non-empty trimmed `username`.

#### Shared per-peer backoff

Brute-force resistance lives in a `throttle` map keyed by **peer IP**, shared across telnet + console so **dropping and reconnecting does not reset the budget**:

- `registerFailure(peer)` increments `fails`. Once `fails >= maxAttempts`, it arms an escalating backoff:

```
over  = fails - maxAttempts
until = now + min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** over)
BACKOFF_BASE_MS = 5_000   BACKOFF_CAP_MS = 300_000
→ 5s, 10s, 20s, 40s, … capped at 5 min
```

- `blockedMsFor(peer)` returns remaining backoff; `submitPassword` refuses **without spending a scrypt** while a peer is blocked.
- `registerSuccess(peer)` clears the record on a good login.
- The map is capped at `MAX_THROTTLE_ENTRIES = 4096`, evicting the oldest key, so a flood of distinct peers can't grow it unbounded.

Two attempt counters coexist: the *shared per-peer* throttle above (survives reconnects), and a *per-session* `loginAttempts` — when the latter reaches `maxAttempts`, the session posts `Too many failed attempts.` and drops the socket via `onClose`. `maxAttempts` is `int(1,10)`, default `3`; sanitized as `max(1, floor(cfg.maxAttempts))`.

#### Idle re-lock

If `auth_idle_lock_min > 0`, an authenticated session with no keystrokes for `idleLockMs = idleLockMin * 60_000` (checked at the top of `draw()`) drops back to the login gate: `mode = 'login'`, `resetLogin()` (which, per §11.7, also abandons any armed action), a full retry budget restored, and the notice `Session locked (idle) — please log in again.` Only sessions that actually passed the gate re-lock; trusted ingress sessions are exempt (`authRequired` is false for them). `idleLockMin` is `int(0,240)`, default `0` (never).

#### Fail-closed when enabled with no users

A dangerous misconfiguration — `auth_enabled: true` but an empty `users` list — is handled **fail-closed**. In the constructor, an `authRequired` connection with `!auth.hasUsers()` is put into `mode = 'denied'` with the message *"No users configured — set the 'users' option in the add-on config."*, and any subsequent key disconnects. The gate refuses access rather than silently allowing it. `index.ts` additionally logs `login gate WARNING: auth_enabled but no users configured — direct LAN access will be denied` at boot. (Trusted ingress connections, being exempt from `authRequired`, still get in — HA already authenticated them.)

The login capture buffers are themselves length-bounded (`loginUser` ≤ 64 chars, `loginPass` ≤ 128) and input is fully ignored while `verifying` is true, so keys can't queue behind an in-flight scrypt.

### 11.10 Configuration knobs

All values are HA add-on options (`zwave_tui/config.yaml`), bridged to env by the s6 `run` script and read in `config.ts`. Booleans use the numeric `1`/`0` convention.

| Option | Type / range | Default | Env var | Effect |
|---|---|---|---|---|
| `write_actions_enabled` | bool | `false` | `WRITE_ACTIONS_ENABLED` | Master gate for all seven verbs; off = read-only monitor |
| `telnet_enabled` | bool | `true` | `TELNET_ENABLED` | Serve the telnet TUI on `:2324` |
| `auth_enabled` | bool | `false` | `AUTH_ENABLED` | Require login on non-ingress (LAN) TUI access |
| `auth_require_on_ingress` | bool | `false` | `AUTH_REQUIRE_ON_INGRESS` | Also require login over the HA sidebar |
| `users` | list of `{username,password}` | `[]` | `ZWAVE_USERS` (compact JSON) | Login credentials; plaintext or `scrypt:salt:hash` |
| `auth_max_attempts` | `int(1,10)` | `3` | `AUTH_MAX_ATTEMPTS` | Failures before backoff / session drop |
| `auth_idle_lock_min` | `int(0,240)` | `0` | `AUTH_IDLE_LOCK_MIN` | Idle minutes before re-lock; `0` = never |

Internal (non-tunable) constants: `CONFIRM_WORD = 'CONFIRM'`; scrypt `SCRYPT_KEYLEN = 32`; backoff `BASE = 5_000 ms`, `CAP = 300_000 ms`; `MAX_THROTTLE_ENTRIES = 4096`; menu `LABEL_W = 20`, badge field 13 cells; view clamps `cols ∈ [60,200]`, `rows ∈ [16,80]`.

### 11.11 Edge-case guard summary

| Guard | Where | Protects against |
|---|---|---|
| `!o.enabled` check inside `run()` | `zwaveActions.ts:51` | Runner executing even if called with write actions off |
| `deviceCmd`/`entryCmd`/ping throw on missing id | `zwaveActions.ts:38–47, 71` | Sending a command with no device/entry/ping target |
| Frozen `menuTarget` + `menuSnapshot` at open | `session.ts:523` | Streaming events / rebuild flips moving a row or target under the cursor |
| `resetActionState()` on login & re-lock | `session.ts:214, 220` | A half-armed destructive action surviving the auth boundary |
| Buffer capped at `CONFIRM_WORD.length`, `===` match | `session.ts:607, 589` | Overtyping past `CONFIRM`; partial/"almost" arming |
| Keys swallowed while `actionInFlight` | `session.ts:380` | Double-submitting an action |
| `rebuildAll`/`stopRebuild` mutual exclusion | `actionsCatalog.ts:145–146` | Offering a no-op action |
| Explicit read-only notice on locked select | `session.ts:566–571` | A keypress being silently ignored |
| `dummyHash` + `byName.has(...) && ok` | `loginPolicy.ts:138, 159` | Username enumeration by timing; collision auth |
| Shared per-peer throttle, capped map | `loginPolicy.ts:167–179` | Reconnect resetting brute-force budget; map growth flood |
| `mode='denied'` when enabled w/o users | `session.ts:190–199` | Silently allowing LAN access on misconfig |
| `X-Ingress-Path` **and** Supervisor-subnet IP | `index.ts:130`, `auth.ts:91` | Forged ingress header from the LAN port |
| Login buffers length-bounded, input ignored while verifying | `session.ts:237, 262, 264` | Buffer abuse; keys racing an in-flight scrypt |

## 12. Configuration, Deployment, Security & Operations

Everything the add-on lets an operator tune, every internal path it writes, how a
release actually reaches the Pi, and the trust boundaries that make an
opt-in mesh-mutating tool safe to run. Four files form the spine of this chapter
and are worth reading together, because they are a single contract split across
three languages:

| File | Role |
| --- | --- |
| `zwave_tui/config.yaml` | The HA add-on manifest: option **defaults** (`options:`) and their **types/validation** (`schema:`). |
| `zwave_tui/translations/en.yaml` | The Configuration-page **labels** (`name`) and **help text** (`description`), keyed by option. |
| `rootfs/etc/services.d/zwave-tui/run` | The s6/bashio **env-bridge**: turns each HA option into an environment variable. |
| `server/src/config.ts` | The **typed consumer**: reads those env vars into the `config` object the rest of the server uses. |

A value is only "wired" when all four agree on it. The header of `config.ts`
states the rule plainly: the boolean knobs follow the run script's *numeric*
convention (`1`/`0`, never `true`/`false`), and "flipping one without the other
makes the knob dead."

### 12.1 The env-bridge and the numeric-bool convention

`config.ts` does not talk to Home Assistant. Under the add-on the environment is
already populated by the `run` script (via `bashio`); `config.ts` only
normalizes env into typed knobs. There is deliberately **no `dotenv` import** —
unlike ecoflow-panel — because under HA the environment is pre-populated and in
bare-metal dev you export the vars yourself.

The load-bearing subtlety is how booleans cross the boundary. A naive
`export FOO=$(bashio::config 'foo')` yields the literal strings `"true"`/
`"false"`; the server would then compare them wrong. So the run script reduces
every bool to `1`/`0` with an explicit `if`:

```bash
if bashio::config.true 'telnet_enabled'; then
  export TELNET_ENABLED=1
else
  export TELNET_ENABLED=0
fi
```

`config.ts` reads that numeric form back — and the **comparison direction is not
uniform**, which encodes each knob's fail-safe posture:

```ts
writeActions:            process.env.WRITE_ACTIONS_ENABLED === '1',     // absent ⇒ OFF (fail-closed)
telnet.enabled:          process.env.TELNET_ENABLED       !== '0',     // absent ⇒ ON  (fail-open)
auth.enabled:            process.env.AUTH_ENABLED          === '1',     // absent ⇒ OFF
auth.requireOnIngress:   process.env.AUTH_REQUIRE_ON_INGRESS === '1',   // absent ⇒ OFF
```

Write-actions and the login gate default **off** when their env var is missing;
telnet defaults **on**. That asymmetry is intentional: a forgotten
`WRITE_ACTIONS_ENABLED` leaves the add-on a read-only monitor, while a forgotten
`TELNET_ENABLED` still serves the TUI. Because the run script *always* exports
`1`/`0` for all four, the code-side default only ever binds in bare-metal dev; in
the add-on the exported value wins. The comment "OMITTING the export entirely
makes the option DEAD (server only ever sees its code default)" is the invariant
that keeps the two ends in lock-step.

### 12.2 Full option reference

The `options:`/`schema:` order in `config.yaml` is also the on-screen order (HA
renders the form by `schema:`), grouped from everyday settings at the top down to
advanced ones. Every option below is a **tunable default** unless noted.

| Option (config.yaml) | Default | Schema | Env var (run script) | config.ts field | Notes |
| --- | --- | --- | --- | --- | --- |
| `signal_display` | `margin` | `list(margin\|dbm)` | `SIGNAL_DISPLAY` | `config.signalDisplay` | Anything not exactly `"dbm"` ⇒ `'margin'`. Live-toggleable in the TUI (`T`). |
| `write_actions_enabled` | `false` | `bool` | `WRITE_ACTIONS_ENABLED` (1/0) | `config.writeActions` | Master gate for all mutating actions. Off ⇒ pure monitor. |
| `telnet_enabled` | `true` | `bool` | `TELNET_ENABLED` (1/0) | `config.telnet.enabled` | Fail-**open** (`!== '0'`). |
| `telnet_port` | `2324` | `port` | `TELNET_PORT` | `config.telnet.port` | The only LAN-published port (see §12.9). |
| `auth_enabled` | `false` | `bool` | `AUTH_ENABLED` (1/0) | `config.auth.enabled` | Gates DIRECT (telnet/`:8788`) access only. |
| `auth_require_on_ingress` | `false` | `bool` | `AUTH_REQUIRE_ON_INGRESS` (1/0) | `config.auth.requireOnIngress` | Also gate the HA-sidebar console. |
| `users` | `[]` | repeatable `{username: str, password: password}` | `ZWAVE_USERS` (JSON) | `config.auth.users` | See §12.2.1 — lifted with `jq`, not `bashio::config`. |
| `auth_max_attempts` | `3` | `int(1,10)` | `AUTH_MAX_ATTEMPTS` | `config.auth.maxAttempts` | Failures before the connection is dropped. |
| `auth_idle_lock_min` | `0` | `int(0,240)` | `AUTH_IDLE_LOCK_MIN` | `config.auth.idleLockMin` | Minutes of no keystrokes ⇒ re-lock; `0` disables. |
| `refresh_interval` | `2` | `int(1,30)` | `REFRESH_INTERVAL_MS` | `config.refreshMs` | **seconds → ms**: run script does `* 1000`. Cheap render/roster cadence. |
| `route_poll_interval` | `10` | `int(5,120)` | `ROUTE_POLL_INTERVAL_MS` | `config.routePollMs` | **seconds → ms**. Expensive route/controller-stats cadence; also the evidence-sample tick. |
| `log_level` | `info` | `list(trace…fatal)` | `LOG_LEVEL` | `config.logLevel` | Surfaced from bashio to the server logger. |
| `zwave_entry_id` | `""` | `str?` | `ZWAVE_ENTRY_ID` | `config.entryId` (`|| null`) | Empty ⇒ auto-discover via `config_entries/get`. |
| `ha_ws_url` | `ws://supervisor/core/websocket` | `str?` | `HA_WS_URL` | `config.haWsUrl` | Override to point at a different Core/driver WS. |
| `driver_ws_url` | `ws://core-zwave-js:3000` | `str?` | `DRIVER_WS_URL` | `config.driverWsUrl` (`|| null`) | **Empty ⇒ disabled.** Strictly read-only telemetry (§12.9). |

Two schema choices are deliberate and marked "do not tidy" in `config.yaml`:

- The URL-ish options use **`str?`, not `url?`**. HA's voluptuous `url?`
  validator rejects an empty string on Save, and both `ha_ws_url` /
  `driver_ws_url` ship either empty or with a `ws://` scheme the runtime
  validates itself. Switching them to `url?` would break the Save button.
- The `users` password field renders `password` (masked) but the stored value may
  be plaintext **or** a `scrypt:<salt>:<hash>` string — the type is intentionally
  permissive so an operator can paste a pre-hash.

`translations/en.yaml` supplies each field's on-screen `name` and `description`.
Its keys must byte-match the `config.yaml` option keys: a typo silently falls
back to the raw KEY with no warning. Port labels are single-sourced from
`config.yaml`'s `ports_description:` (there is no `network:` block in the
translations), and the `2324/tcp` label reads **"Telnet TUI (NO AUTH — keep on a
trusted LAN)."**

#### 12.2.1 The `users` list is lifted differently

`users` is a structured (repeatable) option, so it can't go through
`bashio::config` as a scalar. The run script pulls it straight from the
Supervisor-written options file as compact JSON (bashio bundles `jq`), with an
empty-array fallback:

```bash
export ZWAVE_USERS="$(jq -c '.users // []' /data/options.json 2>/dev/null || echo '[]')"
```

`config.ts` then runs it through `parseUsers(process.env.ZWAVE_USERS)`
(`auth/loginPolicy.ts`), which JSON-parses defensively (any parse failure or
non-array ⇒ `[]`) and keeps only rows with a non-empty `username`.

### 12.3 Internal paths and the `/data` volume

Several paths are **hard-coded in the run script — no user knob** — and point at
the persistent `/data` volume (granted by `map: - data:rw` in `config.yaml`, so
they survive restarts, reconnects, and updates):

```bash
export PORT=8788
export HOST=::
export TELNET_HOST=::
export DB_PATH=/data/zwave.db          # reserved; unused
export HISTORY_PATH=/data/history.json    # v0.5 RSSI/RTT sparkline ring
export EVIDENCE_PATH=/data/evidence.json  # M2 symptom-engine time series
export BASELINES_PATH=/data/baselines.json# M3 learned per-node normals
export OUTCOMES_PATH=/data/outcomes.json  # M5 action-efficacy ledger
```

`config.ts` reads each with the `|| null` idiom, e.g.
`historyPath: process.env.HISTORY_PATH || null`. The semantics of that pattern are
important:

- **Under the add-on**, the path is exported, so each store persists atomically
  (temp-write + rename) to `/data`.
- **In bare-metal dev**, the var is absent ⇒ `null` ⇒ the store runs
  **in-memory only**. The engine still functions; it just forgets across a
  restart.

Flush cadence is fixed in code, not a knob. The relevant defaults in `config.ts`:

```ts
historyFlushMs:  Number(process.env.HISTORY_FLUSH_MS  ?? 30_000),   // 30 s + on shutdown
evidenceFlushMs: Number(process.env.EVIDENCE_FLUSH_MS ?? 300_000),  // 5 min + on shutdown
```

The run script never exports `HISTORY_FLUSH_MS`/`EVIDENCE_FLUSH_MS`, so those
`??` defaults always bind in production. History flushes every 30 s; evidence,
baselines, and outcomes are **dirty-flagged on a ~5-minute cadence plus
shutdown** — chosen (per `DESIGN.md` §3.1) to bound crash-loss without SD-card
write amplification. `DB_PATH` exists but is reserved and currently unused.

`SUPERVISOR_TOKEN` is conspicuously **not** exported: the Supervisor injects it
automatically for add-ons with `homeassistant_api: true`, and the Node process
inherits it. `config.ts` reads it as `supervisorToken: process.env.SUPERVISOR_TOKEN`
— `undefined` in dev, where the WS client no-ops rather than crashing.

#### 12.3.1 Dual-stack bind

`HOST`/`TELNET_HOST` default to `::` so Fastify and the telnet server listen
dual-stack. Node does not set `IPV6_V6ONLY`, so one `::` socket accepts both v4
and v6. The header comment in `config.ts` documents *why* this matters: binding
only `0.0.0.0` silently breaks clients that resolve a hostname to its IPv6
address (macOS does this by default for `.local`) — they reach the host's IPv6
stack with no listener and get a TCP RST. The Dockerfile sets `HOST=0.0.0.0` as
an image-level `ENV`, but the run script overrides it to `::` at start.

### 12.4 Portability and the `DEV_HA_WS_URL` fallback

The add-on is written to run on *any* Z-Wave JS install and to be startable
outside HA for development. Two mechanisms carry that:

**Auto-discovery.** `zwave_entry_id` empty ⇒ `config.entryId` is `null` ⇒ the
data layer auto-discovers the `zwave_js` config-entry via `config_entries/get`.
Nothing about a specific controller or mesh is hard-coded, so the same image runs
on a stranger's network with zero configuration.

**The WS-URL resolution chain.** `config.haWsUrl` resolves in a specific order:

```ts
haWsUrl:
  process.env.HA_WS_URL ??
  (process.env.NODE_ENV !== 'production' ? process.env.DEV_HA_WS_URL : undefined) ??
  'ws://supervisor/core/websocket',
```

- **Add-on runtime:** the run script always exports `HA_WS_URL` (from the option,
  default `ws://supervisor/core/websocket`), so the first branch wins.
- **Bare-metal dev:** the Dockerfile's `NODE_ENV=production` is *not* set, so the
  middle branch activates and `DEV_HA_WS_URL` lets a developer point the data
  layer at a real HA Core over the LAN. `DEV_HA_WS_URL` is **guarded behind the
  non-production check** — it can never take effect inside the shipped container.
- **Last resort:** the Supervisor internal URL.

Local dev needs no build step: `server/` is Fastify + TypeScript run directly
under `tsx` (`npm start`), and `npm run typecheck` is the CI gate.

### 12.5 Container build

The `Dockerfile` is a two-stage build; `build.yaml` supplies the per-arch base:

- **Stage 1 (`serverdeps`)** runs `npm ci` on `node:22-alpine`. `tsx` is a
  **runtime** dependency, not dev-only — there is no compile step, the server
  runs raw TypeScript — so it must never be `--omit=dev`'d away or startup breaks.
- **Stage 2** is `FROM ${BUILD_FROM}` (the HA base image: Alpine + s6-overlay +
  bashio), `apk add nodejs npm ca-certificates tzdata`, copies `server/` +
  `node_modules` + `rootfs/`, and `EXPOSE 8788 2324`.
- `build.yaml` pins `build_from` to `ghcr.io/home-assistant/{arch}-base:3.21`
  (Alpine 3.21 ships Node 22 in `main`). HA Supervisor builds on the target arch,
  so there is no cross-compile / QEMU.
- The build metadata `ARG`s are promoted to `ENV` at the end
  (`ENV BUILD_VERSION=${BUILD_VERSION} …`) so `process.env.BUILD_VERSION` is
  populated at runtime and `/api/version` reports the real release instead of the
  `'0.1.0'` fallback in `config.ts`.

`config.yaml` also carries the non-obvious `init: false`. HA's default
`init: true` wraps the container with Docker's `tini` as PID 1; the HA base image
already ships its own s6 init at `/init`, and with `tini` in front s6-overlay
refuses to start ("can only run as pid 1"). Turning `tini` off lets `/init` (s6)
be PID 1 — mandatory for any add-on on the official HA base images.

### 12.6 The LOCAL add-on deploy model (as actually operated)

The repository is *equipped* as a public "Model A" store add-on — `config.yaml`
carries an `image:` line (`ghcr.io/tesseractaz/{arch}-zwave-tui`),
`repository.yaml` advertises the store, and a three-workflow release pipeline
(§12.7) can push prebuilt GHCR images. That path is documented in `README.md` for
anyone installing from the store.

The owner, however, runs it as a **local add-on** (slug `local_zwave_tui`)
deployed straight to the Pi. Because an add-on manifest with an `image:` key tells
Supervisor to *pull* a prebuilt image, the deploy flow **flattens the repo into
the local add-on folder and strips the `image:` line from `config.yaml`** — with
no `image:`, Supervisor builds the container locally from the `Dockerfile`. The
operational recipe (with its hard-won gotchas):

1. **Typecheck first** — `npm run typecheck` in `server/` (there is no compile
   step to catch errors otherwise).
2. **Copy the tree** to the Pi's local add-on directory. `scp` is unreliable for
   this tree; use a **tar-pipe** instead.
3. **Strip `image:`** from the deployed `config.yaml` so HA builds from source.
4. **Reload + apply**: `/store/reload`, then the add-on `…/update`.
   - **Gotcha:** `…/update` **NO-OPs when the version is unchanged.** To force a
     rebuild at the same `version:`, call `…/rebuild` instead. (`version:` only
     bumps between releases, so intra-version iteration must use `rebuild`.)

This local path is why the store artifacts (`repository.yaml`, the `image:`
line, GHCR) exist but are not the live update mechanism — the `repository.yaml`
comment describes the store's "Update button pulls the new prebuilt GHCR image"
workflow, which the local deploy deliberately bypasses.

### 12.7 Release pipeline and the NO-PUBLISH convention

Three workflows *can* relay a public release end-to-end:

1. **`release.yml`** (`workflow_dispatch`) — bumps `version:` in `config.yaml`,
   prepends a `## X.Y.Z — DATE` section to `CHANGELOG.md`, opens an auto-merge
   `release/vX.Y.Z` PR.
2. **`tag-release.yml`** (push to `main`) — creates the `vX.Y.Z` tag and dispatches
   the image build, **gated on the commit subject**:
   ```yaml
   if: startsWith(github.event.head_commit.message, 'Release v')
   ```
3. **`images.yml`** (on the `vX.Y.Z` tag) — builds `aarch64` + `amd64` natively,
   pushes to `ghcr.io/tesseractaz/{arch}-zwave-tui`, and cuts a GitHub Release.

Because this is a private, single-tenant, locally-deployed add-on, the operating
rule is **NO-PUBLISH**: a squash-merge subject **must start `vX.Y…` and must
never start `Release v`.** Naming merges `vX.Y.Z: …` deliberately keeps
`tag-release.yml`'s `startsWith('Release v')` gate from firing, so **no tag, no
image build, and no GitHub Release are ever produced** — the code lands on `main`
and is deployed by the local path in §12.6 instead. The git history confirms the
convention holds for every merge:

```
ee9f3cd v0.17.0: interference-watch screen (M6) (#21)
47de19a v0.16.0: outcome-learning loop (M5) — advisory-only (#20)
55cb3c3 v0.15.0: remediation planner (M4) — advisory Remedy surface (#19)
…
93d2bb8 v0.2: live statistics + the five detail screens (#3)
```

The always-on gates are `ci.yml` (typecheck + docker smoke build — required on
every PR) and the self-contained `codeql.yml` security check. Green tests plus
adversarial multi-agent review are the merge gate.

### 12.8 Security posture

The add-on handles no personal data and moves no money, but it can read a home's
Z-Wave device state and — with an opt-in — mutate the mesh, so its access is
treated as **privileged**. `SECURITY.md` and the code together define the posture.

**Read-only by default.** `write_actions_enabled` defaults **off**; a fresh
install exposes no mutating control. `homeassistant_api: true` grants the add-on
the Core WS/REST API (via `SUPERVISOR_TOKEN`) needed for `zwave_js/*` reads;
`hassio_api: false` because no Supervisor-level calls are made; `panel_admin:
false`; `host_network: false`.

**Every mutation is human-gated, and the engine is advisory-only.** When write
actions are enabled, each action (ping / refresh / re-interview / rebuild-routes /
remove-failed) still requires the operator to open the Actions Menu and type the
literal word **CONFIRM**. The learned engine **recommends but never executes** —
the executor / `auto_remediation` / `auto_safe` tiers are *designed* (`DESIGN.md`
§3.5) but **not built**; there is no automatic-remediation path in the shipped
build. As a corollary of that design, a **route rebuild is never surfaced as a
runnable engine recommendation**: it cannot fix a physical link, it deletes
manual priority routes, and it *throws* on Long-Range nodes — so the planner's
protocol/topology gates strip it. (The manual `R` "rebuild ALL" key still exists
in the Actions Menu, but only behind the write gate + a mandatory confirm, and
never as engine advice.)

**All mesh mutations ride the HA WebSocket** (Supervisor-token authenticated).
The separate, **unauthenticated driver WebSocket** (`ws://core-zwave-js:3000`) is
used **strictly read-only**, behind a closed command allowlist (`set_api_schema`,
`start_listening` — plus cached route reads per §2.1), and is **never proxied or
re-exposed** to the TUI, ingress, or logs verbatim. Empty `driver_ws_url`
disables it entirely; an unreachable server, an untested schema, or a
different-network home id simply leaves the extra telemetry blank while everything
else works.

**Trust model / ports.** Access over the HA sidebar (ingress) is already
HA-authenticated — the add-on sees an `X-Ingress-Path` header from the Supervisor
network — so it skips the login gate unless `auth_require_on_ingress`. Direct LAN
access is not HA-authenticated: only `2324/tcp` is published on the LAN (labeled
"NO AUTH — keep on a trusted LAN"), and `:8788` is reached **only through HA
Ingress**, never as a mapped host port. The optional login gate (§12.2) covers
direct access and **fails closed** — enabled with no users configured denies all
direct access.

**Auth internals** (`auth/loginPolicy.ts`), hardened after adversarial review:

- Passwords are **normalized to scrypt at startup**, so `verify()` always runs
  exactly one scrypt whether the stored value was plaintext or `scrypt:<salt>:
  <hash>`. A username-miss verifies against a random real `dummyHash`, so a
  missing username costs the same as a wrong password — **no timing-based user
  enumeration**.
- `verify()` is **async** (`crypto.scrypt`, not `scryptSync`), keeping credential
  checks off the single Node event loop.
- A **shared per-peer backoff** escalates across connections: past `maxAttempts`
  it arms `BACKOFF_BASE_MS` (5 s) doubling to `BACKOFF_CAP_MS` (5 min), so
  dropping and reconnecting does not reset the brute-force budget. The throttle
  map is capped at `MAX_THROTTLE_ENTRIES` (4096) so a flood of distinct peers
  can't grow it unbounded. `SCRYPT_KEYLEN` is 32.
- A plaintext password must not begin with `scrypt:` (that prefix marks a
  pre-hashed value); any other plaintext is fine.

**Boundary hygiene.** Device names and externally-sourced state strings are
stripped of control/ANSI sequences before reaching the terminal frame; inbound
console WebSocket frames are size-capped. Persisted evidence and learned state are
tagged with the controller's `homeId`; a mismatch on reconnect (a stick swap /
different NVM) **purges** the restored state rather than aliasing one network's
data onto another (and `reset()` immediately rewrites the on-disk file so a crash
cannot resurrect the old rings).

**Scope.** In scope: the add-on server (`server/`), its HTTP/console/telnet
surfaces, the action-runner, and the auth paths. Out of scope (report upstream):
HA Core, the Z-Wave JS integration and driver, the Supervisor, and the physical
radio.
