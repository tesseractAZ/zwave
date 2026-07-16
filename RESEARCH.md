# Z-Wave Remediation Engine — Research Ground Truth

Compiled 2026-07-16 for the learned-remediation engine (milestones M2–M7). This
is the **accuracy contract**: every load-bearing design decision must trace to a
claim here, and every claim carries a confidence label and primary source. It
was produced by a 45-agent research + adversarial-verification pass (each
load-bearing claim was re-checked by an independent agent that fetched the cited
source and defaulted to *unsupported* if it couldn't confirm). All 40 verified
load-bearing claims came back **supported or partially-supported-with-a-
correction** — none was refuted — and every correction is folded into the text
below.

Confidence labels:
- **spec** — Silicon Labs / ITU-T G.9959 / RFC primary source
- **source** — zwave-js or HA source code / official docs (the authoritative
  implementation for *this* stack)
- **empirical** — reproduced against zwave-js@15.25.3 (the driver HA add-on
  1.5.0 ships) or live-probed on this installation (HA Core 2026.7.2)
- **lore** — community/vendor guidance, directionally reliable, not spec

Driver pinning: the live HA Z-Wave JS add-on **1.5.0 bundles zwave-js
15.24.2→15.25.0**; empirical tests ran on 15.25.3 (nearest published patch;
the statistics/route increment sites are byte-identical between the two).
Statistics semantics **have changed across major versions** (the drop counter
was only added in 8.8.0) — re-verify §2 on every add-on upgrade.

---

## 0. The single most important correction

> **`commandsDroppedTX` does NOT count RF ACK failures.** *(source + empirical)*

This is the highest-impact finding and it overturns the assumption baked into
the current TUI's `txDropPct`. Reproduced against zwave-js@15.25.3:

- When a listening node stops ACKing, `SendData` returns `TransmitStatus.NoAck`;
  the driver retries `attempts.sendData` (default **3**, empirically confirmed)
  times, then marks the node **DEAD** (`NodeStatus 3`) and rejects the
  transaction. `commandsDroppedTX` **stays 0** and no TX report is emitted.
- The one increment site (`Driver.ts handleSerialAPICommandResult`:
  `isTransmitReport(result) && !result.isOK()`) is only reached when a NOK
  transmit report is fed *back* into the message generator via `.next()`; the
  singlecast NoAck path *throws* the NOK instead, so `onMessageSent` never sees
  it. Reproduced: NoAck, controller-cannot-send (`wasSent=false`), and
  Get-timeout each incremented `commandsDroppedTX` in **none** of the cases.
- It *can* tick up on a premature-response abort that actually **succeeded** (a
  fast node whose report beats the MAC ACK → `SendDataAbort` → NoAck callback,
  but delivery is treated as OK). So the counter is *noisy*, not a clean RF
  signal. (Could not force this in a mock → real-world rate uncertain; treat any
  nonzero value as weak evidence at most.)

**What the counter actually means** (zwave-js 8.8.0 changelog, verbatim):
"updated when an outgoing command **could not be sent** to a node" — a dispatch
failure, and it also fires on `Fail` (jammed RF where the controller couldn't
transmit at all, which usually hits *all* nodes at once), not just per-node
NoAck.

**The reliable RF-failure signals instead are:**
1. **Node status flapping Alive↔Dead** (`subscribe_node_status`) — a listening
   node that fails all send retries goes DEAD; this is *the* hard link-failure
   event. Caveat: dead-marking only happens *when traffic is attempted* — a
   silent node never goes dead, so absence of dead events ≠ health.
2. **`timeoutResponse`** — the node MAC-ACKed a Get but never returned the
   expected report; zwave-js increments it and the node **stays Alive**
   (reproduced: ack-but-no-report → `timeoutResponse=1`, `status=Alive`). The RF
   link is demonstrably up (the ACK arrived); the failure is return-path / node
   responsiveness / rate. **Only accrues for Get-type (response-expecting)
   traffic** — SET-only nodes won't show it.

**Denominator correction:** `commandsTX` increments **only on a successful
(OK) send**. So `(commandsDroppedTX + timeoutResponse) / commandsTX` is
*timeouts-over-successes*, not a true attempt-failure rate. Keep the existing
`tx<=0 ⇒ null` guard. **Re-derive the live symptom:** the two patio-light
switches' "25–33 % TX drop" is almost certainly **`timeoutResponse`-driven**
(ACKed Gets whose reports were lost), *not* ACK-drop-driven — which points at
return-path/route quality, not a dead link.

**Engine consequence:** the classifier must distinguish three states, each with
a different remedy family:
| state | signals | remedy family |
| --- | --- | --- |
| dead/flapping | Alive↔Dead transitions | reachability runbook (ping→power-cycle→re-include); **never** rebuild a node that can't be reached |
| return-path/latency | high `timeoutResponse`, node stays Alive, good RSSI | route quality: repeater/placement; re-interview only for stale-config cases |
| weak signal | low RSSI + drop | placement/repeater; SNR-margin driven |

---

## 1. RF / PHY & the interference landscape

### 1.1 US frequency & rate plan *(spec — G.9959)*
Classic US Z-Wave uses **two frequencies carrying three PHY rates**:
- **908.4 MHz** carries **R1 = 9.6 kbit/s** (FSK + Manchester) and **R2 = 40
  kbit/s** (FSK + NRZ). *(Precision note from verification: R1 = 908.42 MHz, R2
  = 908.40 MHz — often lumped as "908.4"; the two may be the same channel quoted
  at different precision.)*
- **916.0 MHz** carries **R3 = 100 kbit/s** (GFSK, BT = 0.6, NRZ).
- G.9959 **channel configuration 2** = Ch A (R3-only freq) + Ch B (R1+R2 on one
  freq) — defined in **Table 7-2** (RF profiles in 7-1, rates in 7-3, modulation
  in 7-4). The numeric center frequencies are deliberately "outside the scope"
  of G.9959 (regional), hence sourced from Silicon Labs / DrZWave, not the spec.

> **Engine consequence:** 100k lives on a *different frequency* (916 MHz) than
> 40k/9.6k (908.4 MHz). A node stuck below 100k may be suffering
> narrowband/multipath impairment **specific to 916 MHz** while 908.4 is fine —
> rate fallback is evidence about a *frequency*, not only distance.

### 1.2 Receiver-sensitivity ladder *(spec — G.9959 Table 7-8)*
Minimum RX sensitivity (FER < 1 %): **R1 (9.6k) = −95 dBm, R2 (40k) = −92 dBm,
R3 (100k) = −89 dBm** — each rate step down buys ~3 dB. Real 800-series chips
(ZG23/ZST39) beat these (circulating figures −97…−110 dBm; datasheet not fetched
this pass — see gaps) but preserve the ordering.

> **Consequence:** sustained 9.6k means the link repeatedly failed at rates
> needing only ~6 dB more SNR — it lives within a few dB of the floor, *or* the
> 916 MHz channel is impaired. Weight persistent 9k6 on a modern device highly.

### 1.3 What "good RSSI + high drop" really is *(source + inference)*
Two mechanisms, both confirmed in zwave-js source:
- **`NodeStatistics.rssi` is fed *only* from `TXReport.ackRSSI`** ("RSSI of the
  acknowledgement frame") via EMA (`new = 0.75·old + 0.25·sample`) in
  `updateRouteStatistics`. The JSDoc "Average RSSI of frames received by this
  node" **contradicts the implementation and is misleading** — it is the
  *controller* measuring the *node's ACK*. For a **routed** node, that ACK's
  final hop is *repeater→controller*, so the value reflects the **last hop**,
  not the end device.
- **Survivorship bias:** `rssi` only updates when a transmission produced an ACK.
  Failed transmissions contribute no sample, so under bursty loss the RSSI
  statistic averages the *survivors* and stays healthy while failures climb.

> **Consequence:** never gate "link is bad" on RSSI alone, and never dismiss
> high drop because RSSI looks fine. **Branch on `lwr.repeaters.length` before
> interpreting `rssi`.** Treat (good mean RSSI + high drop) as a distinct
> "intermittent impairment" state (burst interference / collisions / fading),
> remedied differently from "weak signal" (low RSSI + high drop).

Documented mechanisms that produce it at 900 MHz indoors: (a) RSSI survivorship;
(b) duty-cycled interferers (AMI meter bursts, LoRa) raising the floor only
intermittently; (c) hidden-node collisions despite CCA; (d) asymmetric ACK loss
(node executes, controller misses the ACK → *duplicate actuations are the tell*);
(e) frequency-selective multipath fades from metal reflectors (916 can fade while
908.4 measures fine).

### 1.4 SNR margin is the real quality metric *(source — zwave-js health check)*
`checkLifelineHealth` computes **`snrMargin`** and the health rating requires
**≥ 17 dB SNR margin** (plus 0 failed pings, latency ≤ 100 ms, powerlevel
headroom ≤ −6 dBm reduction) for ratings 8–10 — mirroring Silicon Labs' PC
Controller IMA tool. **Correction (verification):** the *preferred* computation
is `snrMargin = ackRSSI − measuredNoiseFloor` (from the TX report, keeping the
*worst/minimum* across the 10 pings); `ackRSSI − backgroundRSSI` on the ACK
channel is only the **fallback** path when the TX report lacks a measured noise
floor. The docs label it "dBm" (a slight misnomer; it is a dB margin).

> Observed −70s RSSI against a typical ~−100 dBm floor is **~30 dB margin** —
> further evidence the patio-light drops are **not** steady-state weak signal.

### 1.5 Background RSSI / noise floor *(source)*
`ControllerStatistics.backgroundRSSI` holds per-channel `{average, current}` for
channels 0/1 (mandatory) and 2/3 (optional), plus **one top-level `timestamp`**
(correction: timestamp is *not* per-channel). Docs: values "typically between
−100 and −30 … down to −128 dBm in quiet environments." Healthy US floor ≈
−95…−105 dBm (−110 dBm baseline on 800-series). The driver auto-polls background
RSSI when the send queue is idle ≥ 5 s, at most every 30 s (EMA α = 0.9);
`enable_frequent_rssi_monitoring` raises it to every 2 s.

> **⚠ Blocking gap for interference detection:** the HA
> `subscribe_controller_statistics` event **forwards only** messages_tx/rx,
> dropped_tx/rx, nak, can, timeout_ack, `timout_response` *(misspelled in dev
> source)*, timeout_callback — **`background_rssi` is silently dropped** at
> HA's WS boundary, even though the python lib parses it. **Noise-floor / SNR
> analysis is impossible through HA today.** It is the single strongest argument
> for a future direct driver-WS phase (`ws://core-zwave-js:3000`), or a one-line
> upstream HA PR. Design the noise-monitor interface now; feed it later.

DrZWave's vendor-endorsed jamming recipe (directly usable when we *can* read the
floor): sample background RSSI ~every 30 s; **no fixed threshold works** —
average over long windows for a per-site baseline; declare jamming only when
**delivery failures coincide with an elevated floor**; queue the alert until the
jam clears so it can actually be delivered.

### 1.6 Channel-index mapping is firmware-defined — **do not hardcode** *(lore)*
zwave-js nowhere hardcodes channel-index→frequency. Only **channel 3 = LR
channel on LR regions** is community-confirmed. The assignment of 0/1/2 among
916/908.4-40k/908.4-9.6k was *not* confirmed in any primary source. **The engine
must treat channel indices as opaque per-region labels** — learn the mapping
empirically (correlate `txChannelNo` with `routeSpeed`, driver phase) or leave
channels unlabeled. Hardcoding risks shipping wrong diagnostics to other regions.

### 1.7 Transmit power & the physics of edge nodes *(spec + lore)*
- **Classic US TX power is tiny: ~−1 dBm** (Silicon Labs), under FCC 15.249.
  With ~−95 dBm spec sensitivity, **one 12–23 dB concrete/lath wall consumes a
  huge fraction of the link budget** → "one bad wall" is a plausible *sole*
  cause, and **repeater placement (not route rebuilding) is the physically
  correct fix** for edge nodes.
- **Building attenuation at 900 MHz** *(Digi XST-AN005a, measured)*: glass 6 mm
  0.8 dB, brick 89 mm 3.5 dB, concrete 102 mm 12 dB, **reinforced concrete
  89 mm 27 dB**, concrete 305 mm 35 dB. "Radio waves do not propagate through
  metal"; metal masses act as reflectors producing constructive/destructive
  interference.
- **Stucco over wire lath** (standard Phoenix/SW-US construction) — the live
  symptom's leading explanation *(lore)*: metal lath openings (~2.5–5 cm) are ≪ λ
  (~33 cm at 908 MHz), so the mesh behaves as a partial reflective sheet /
  Faraday cage; booster-industry sources rank it in the 10–40 dB class. **No
  rigorous measured 900 MHz dB figure for stucco-over-lath exists in primary
  literature.** So: use construction-type + mounting-location (exterior wall,
  in-wall metal box) as a **strong prior favoring placement remediation**, but
  **present it as a construction-class effect, never a specific dB number.** An
  indoor switch mounted *in* an exterior stucco wall behaves like an RF edge node
  with a distorted antenna environment.

### 1.8 902–928 MHz interferer census (US) *(source, signatures = lore)*
Shared ISM occupants: utility **AMI/smart meters** (FHSS sweeping the band every
few seconds), **LoRaWAN / Amazon Sidewalk** (long-airtime chirps at 915),
900 MHz cordless phones, analog baby monitors (broadband), RFID, amateur 33 cm.
In **Phoenix specifically**, AMI meters (often on the *same* exterior stucco
walls as the symptomatic switches) and Sidewalk are the highest-prior
interferers. Signature heuristics (AMI = short periodic bursts; LoRa/Sidewalk =
sparse long frames; analog monitor = continuous) are **ranked hypotheses, not
certainties**.

### 1.9 CSMA/CCA & collisions *(spec — G.9959)*
G.9959 mandates CCA before transmit (PHY threshold −80 dBm), ACK-confirmed
delivery, retransmission up to `aMacMaxFrameRetries` *(constant name unverified —
paywalled spec; the IEEE 802.15.4 analog is `macMaxFrameRetries`)* with a
**random backoff**. CCA cannot detect a **hidden node** (audible at the receiver
but not the sender) → collisions at the receiver despite CCA. **Whether US
classic firmware actually does listen-before-talk in practice is disputed** (FCC
15.249 doesn't require it) — see gaps.

> **Consequence:** own-mesh traffic bursts (polling storms, multicast scenes) and
> neighbors' Z-Wave produce drop/latency with healthy RSSI. Before blaming
> external RF, **test whether drops correlate with the site's own command
> bursts** (self-interference), and rate-limit the engine's own probing.

### 1.10 Z-Wave Long Range needs a completely separate rulebook *(spec + source)*
LR (US): DSSS-OQPSK at 100 kbps on 912 MHz (primary) / 920 MHz (backup),
FCC 15.247 up to +30 dBm (shipping parts +14 dBm), **star topology (no
repeaters, no mesh routing)**, up to 4000 nodes, **dynamic per-transmission TX
power**, node IDs ≥ 256. In zwave-js: `rebuildNodeRoutes` **throws** for LR;
network rebuild **skips** LR; `getNodeNeighbors` **throws**; `checkRouteHealth`
**throws**; an LR node's stats are seeded with a synthetic direct
`lwr = {LongRange_100k, repeaters: []}`; `checkLifelineHealth` *works* but
`numNeighbors` is undefined.

> **Consequence (mandatory — this mesh has LR devices):** **every remediation
> rule needs a protocol predicate.** For LR nodes, route rebuild / neighbors /
> repeaters / priority routes are **invalid or meaningless** — the only fixes are
> placement, antenna, and (self-managed) power. Recommending a rebuild for an LR
> node would be a guaranteed, visible accuracy bug on any LR user's mesh.

**LR power-starvation caveat** *(lore — single expert blog, Aug 2025; may be
fixed in later firmware — see gaps):* the zwave-js maintainer found LR's dynamic
power algorithm driving receiver link budgets down to ~2–4 dB, with Classic
beating LR in that deployment. Don't assume LR links are robust "because 30 dBm +
DSSS." (SDK 8.1.0 release notes, June 2026, adjusted the dynamic-TX-power margin
to 6 dBm for headroom.)

### 1.11 Statistics are smoothed & precision-limited *(source)*
`rssi` and `rtt` are EMAs (α = 0.25) → **~4-sample lag**, so they won't show
short interference bursts; keep our own windowed history. Counters are
**cumulative since driver start** and never decay → window/delta them with a
**reset guard** (counter went backwards ⇒ driver restarted ⇒ invalid window).
RSSI has **error sentinels** `NoSignalDetected=125, ReceiverSaturated=126,
NotAvailable=127` — **treat any value ≥ 125 as an error marker, not a
measurement** (a stray 127 corrupts a baseline), exactly as zwave-js's
`isRssiError()` does. Chip RSSI precision is coarse (±2 dB); **don't act on RSSI
deltas < ~3–4 dB.**

---

## 2. Routing mechanics & statistics semantics

*(§0 covers the drop-counter correction — the most load-bearing routing fact.)*

### 2.1 Route resolution order *(spec — Silicon Labs interpretation in the TX report)*
Per `SendData` the 700/800 controller resolves routes internally and reports the
scheme in `TXReport.routeSchemeState`. zwave-js enum `RoutingScheme`:
`Idle, Direct, Priority, LWR, NLWR, Auto, ResortDirect, Explore`. Attempt order:
**Direct / pinned Priority → LWR → NLWR → Auto (controller-calculated) →
Resort-to-Direct → Explorer frame (last resort)**.

- **LWR = Last Working Route** — a successful route is promoted to the top and
  reused until it fails; the old LWR becomes NLWR **only when the repeater set
  changes** (`routeStatisticsEquals` compares repeaters).
- **Explorer frames** *(spec — APL13031)*: when all known routes fail, the node
  floods a network-wide explorer that records its path to the target; the target
  answers on the reverse route, and that becomes the new LWR. This is **how a
  Z-Wave Plus mesh self-heals** without any command. `TransmitOptions.DEFAULT =
  ACK | AutoRoute | Explore`. Explorer delivery **blocks the mesh for seconds**.

> **Consequence:** a node routinely reached by **explorer** (`routeSchemeState =
> Explore`) is in the worst, highest-latency, mesh-loading state — flag it
> distinctly. But **diagnose explorer-reliance passively** — never force
> explorer-heavy probes (`tryReallyHard` ping blocks comms for seconds).

### 2.2 Rate & `protocolDataRate` *(source)*
`updateRouteStatistics` sets `lwr.protocolDataRate = txReport.routeSpeed` on
every TX report. Enum: `9k6=1, 40k=2, 100k=3, LR100k=4`. So a node reading
`protocolDataRate=1` genuinely negotiated 9.6k on its last working route — the
*real* per-route rate, not a nominal cap. **Correction:** `TXReport.ts` has
`routeSpeed`/`routingAttempts`/`routeSchemeState` but **no "speed
modified/reduced" flag** (that earlier sub-claim was wrong). **False positives to
rule out before flagging 9k6:** a **100-series** node/repeater in the path (only
does 9.6k — *not* 200-series, which does 40k), a **FLiRS** destination (may cap
at 40k), or **beam** requirements. Only a **100k-capable path persistently at
9k6** is strong RF-impairment evidence. **The exact 100k→40k→9.6k fallback
*algorithm* is not published in any fetched source** — treat observed 9k6 as a
degradation **flag**, not a claimed mechanism (see gaps).

### 2.3 Per-hop fault localization — free from statistics *(source)*
`RouteStatistics` (lwr/nlwr) carries `rssi` (ACK at controller),
`repeaterRSSI[]` (per-hop), and **`routeFailedBetween`** = `[last-functional
node, first-non-functional node]` — **it names the exact failing hop** — plus
(in the underlying TX report) `failedRouteLastFunctionalNodeId`,
`failedRouteFirstNonFunctionalNodeId`, `txChannelNo`, `ackChannelNo`,
`routeSpeed`, `routingAttempts`, `txPower`, `measuredNoiseFloor`.

> **Consequence:** we can point at a *specific repeater* to blame — but
> `routeFailedBetween` is **transient** (set only after a recent failure,
> overwritten on the next OK TX report), so **capture it event-driven at the
> moment it appears**, not by polling. **⚠ Open probe:** confirm HA's
> `subscribe_node_statistics` event actually serializes the nested `lwr/nlwr`
> objects (repeaterRSSI, routeFailedBetween) — the driver has them and the
> python lib sends them, but HA's event payload field set must be verified live
> before the engine depends on per-hop localization (see gaps §2/§7).

### 2.4 What `rebuild_node_routes` actually does *(source — step by step)*
`controller.rebuildNodeRoutes(nodeId)`: throws for the controller's own node and
for **LR nodes**; pings dead-looking nodes first (`tryReallyHard`) and returns
false if unresponsive; forces `keepAwake` on battery nodes for the whole run;
then runs **4 steps, each retried up to 5×**:
1. `discoverNodeNeighbors` → `RequestNodeNeighborUpdate` (the **node re-scans its
   RF neighbors**); can trigger `AssignSUCReturnRoute`, so the cached SUC return
   route is invalidated.
2. `assignSUCReturnRoutes`.
3. `deleteReturnRoutes` — **deletes ALL return routes** "to get rid of potential
   priority return routes." **A manually-set priority return route is destroyed.**
4. `assignReturnRoutes` to every association destination.

Docs (verbatim): *"Rebuilding routes for a single node will delete existing
priority return routes to end nodes and the SUC. It is recommended to first check
… using `getPriorityReturnRoutesCached` … and asking for confirmation before
proceeding."*

> **Consequence:** rebuild is **not a lightweight nudge** — it deletes/re-assigns
> routes and re-runs neighbor discovery, can take **minutes** on battery nodes
> (waits for wake), and **silently wipes user-set priority routes**. The cached
> priority-route reads are **not exposed via HA WS**, so the engine can't check
> them — it must **warn unconditionally** that a rebuild may delete manual
> routes.

### 2.5 Network-wide `begin_rebuilding_routes` *(source)*
Walks outward from the controller, rebuilding listening nodes one-by-one (full
4-step task each), expanding the frontier by neighbor discovery, then handling
sleeping nodes as they wake. Docs: *"causes a lot of traffic and can take very
long. Degraded performance **must** be expected while this process is active."*
**Asymmetry with per-node rebuild:** the network-wide default **protects**
priority routes (`deletePriorityReturnRoutes=false` → skips those nodes) and
`includeSleeping=true`. HA passes **no options**, so HA users always get the
defaults. `subscribe_rebuild_routes_progress` streams `node_id → pending | done |
failed | skipped` (**live-probed present on HA 2026.7.2**), and `network_status`
exposes `is_rebuilding_routes`.

> **Consequence:** whole-network rebuild is a minutes-to-hours mesh-wide
> operation that degrades everyone — **never** for one or two bad switches;
> reserve it as a manual, explicitly-confirmed action. `skipped` (LR/priority
> nodes) is **expected**, not a failure to score.

### 2.6 "Frequent healing causes churn" — grounded, nuanced *(source + lore)*
zwave-js performs **no automatic/scheduled healing** — on-demand only; the old
"heal" term was renamed "rebuild routes" in **v12** (2023). The churn warning is
mechanism-grounded (each rebuild deletes routes + re-discovers neighbors +,
network-wide, floods traffic and keeps battery nodes awake), and a real
large-mesh heal-timeout bug existed (zwave-js #2533; a 70-node heal stuck >24 h).
**Correction:** there is **no evidence a single well-timed rebuild permanently
harms** a mesh — the harm is transient disruption + loss of manual routes.

### 2.7 Priority routes *(source + lore)*
zwave-js supports `setPriorityRoute` / `removePriorityRoute` / `getPriorityRoute`
/ `assignPriorityReturnRoute`, **none exposed via HA WS** (driver-phase only).
DrZWave: the only sound use is *forcing near-controller nodes to try direct
first*; a **wrong/stale pinned route is actively harmful** (always tried first →
delays). Assigning return routes to a node that already has a priority route can
**change the priority route unexpectedly**. Route pinning is **not a first-line
remedy** and, when ever used, must pin only verified-in-range routes, re-validate
them, and track that any rebuild wipes them.

### 2.8 Return-route storage *(source)*
Each node stores **up to 4 return routes per destination**; `deleteReturnRoutes`
empties all 4; a priority return route is a separate pointer to one of the 4.
Partial assignment clears the rest (assign all needed routes in one call; assign
priority **last** to avoid the documented priority-clobber).

### 2.9 Source routing is controller-owned *(spec)*
The controller computes and caches routes; the sender embeds the route in the
frame; repeaters forward. **A node cannot fix its own routing** — all route
remediation goes through the controller. **Neighbor quality is set at
inclusion/discovery time** and only refreshed by an explicit neighbor update
(step 1 of rebuild) — so a node moved after inclusion, or a mesh that gained/lost
repeaters, has a **stale neighbor map** that only `discoverNodeNeighbors`
refreshes. That is the *one* scenario where rebuild is the targeted fix.

### 2.10 Two retry budgets, and ACK ≠ success *(spec)*
Silicon Labs MAC "3 unsuccessful transmissions → link down" (per-route, MAC
layer) is **distinct** from zwave-js `attempts.sendData=3` (driver re-issues the
whole SendData, each doing full route resolution with its own MAC retries). **One
observed "drop" can be ~3 full route-resolution cycles = many RF transmissions.**
And **an ACK confirms frame integrity, not command execution** — `commandsTX`
counts link delivery, not app-level success; Supervision CC (or a follow-up Get)
is the app-level truth.

### 2.11 Controller counters are host↔stick, not RF *(source)*
`ControllerStatistics` NAK / CAN / timeoutACK / timeoutResponse / timeoutCallback
/ messagesDropped count **USB/serial-link** events, **not** the RF mesh. Rising
values ⇒ a **sick stick / serial / driver wedge** (fix = reconnect/reset the
controller) — a *different* remediation class from node routing, and a common
cause of **many nodes appearing to "drop" at once** → route correlated failure to
**controller recovery**, not per-node rebuilds. *(HA misspells one field
`timout_response`.)*

---

## 3. The programmable surface (live-probed HA 2026.7.2 + code-confirmed)

### 3.1 Full HA `zwave_js/*` WS inventory *(source — api.py, dev)*
**Diagnosis / monitoring:** `network_status` (device_id **or** entry_id; returns
versions, controller info incl. `rf_region`, `supports_long_range`,
`is_rebuilding_routes`, `inclusion_state`, and a `nodes[]` roster; **force-
refreshes controller state each call** — a real live poll, don't hammer it),
`node_status`, `node_metadata`, `node_alerts`, `node_capabilities`,
`subscribe_node_status` (alive/dead/sleep/wake/ready), `subscribe_node_statistics`,
`subscribe_controller_statistics`, `subscribe_log_updates`,
`get_log_config`/`update_log_config`.
**Remediation:** `rebuild_node_routes` {device_id}, `begin_rebuilding_routes` /
`stop_rebuilding_routes` / `subscribe_rebuild_routes_progress` {entry_id},
`refresh_node_info` (re-interview, streams interview events), `refresh_node_values`,
`refresh_node_cc_values` {device_id, command_class_id},
`set`/`get_config_parameters`, `set`/`get_raw_config_parameter`, `invoke_cc_api`.
**Firmware:** abort/is-in-progress/subscribe/get-capabilities + HTTP upload.
**Destructive:** `hard_reset_controller`, `backup_nvm`, `restore_nvm`,
`remove_failed_node`, `replace_failed_node`.
**Nearly all are `@require_admin`.**

**Live-probe results (this installation, HA Core 2026.7.2):** confirmed EXISTS —
`subscribe_node_statistics`, `subscribe_controller_statistics`,
`subscribe_node_status`, `subscribe_log_updates`,
`subscribe_rebuild_routes_progress`, `node_status`, `node_metadata`,
`node_capabilities`, `node_alerts`, `refresh_node_cc_values`,
`get_config_parameters`, `invoke_cc_api`, `hard_reset_controller`, `backup_nvm`,
`restore_nvm`. Confirmed **ABSENT** (`unknown_command`) — see §3.2.

### 3.2 What HA does NOT expose *(source + live-probe)*
**Confirmed absent on HA 2026.7.2:** `check_lifeline_health`, `check_route_health`,
`abort_health_check`, `powerlevel_test`, `background_rssi`, `get`/`set`/
`remove_priority_route`, `get_node_neighbors`, `network_topology`,
`controller_statistics`/`node_statistics` (only the `subscribe_*` variants exist).
The HA client lib `zwave-js-server-python` *implements* `async_check_lifeline_health`,
`async_check_route_health`, `async_test_power_level`, `async_ping`,
`async_get_node_neighbors`, `async_get_known_lifeline_routes` — **HA core simply
never wired them to WS commands** (an upstream PR exposing `check_lifeline_health`
would be small). The `zwave_js.ping` HA *service* exists but is **deprecated** and
returns nothing.

> **Consequence:** through today's HA-WS channel the engine's **only executable
> route remediation is `rebuild_node_routes` (per node) and
> `begin_rebuilding_routes` (whole network)** — both blunt and priority-route-
> destroying — plus `refresh_*` and `remove_failed_node`. **Active health checks,
> priority routes, neighbors, and background RSSI require the driver-WS phase.**
> Design so *recommend* is rich but *execute* is gated to rebuild/refresh/remove-
> failed until that phase lands.

### 3.3 The driver-WS phase-2 unlock *(source)*
`ws://core-zwave-js:3000` (the official add-on declares `ports: 3000/tcp: null` —
reachable by internal DNS `core-zwave-js`, **no authentication**) exposes the full
toolkit: `node.check_lifeline_health` / `check_route_health` / `test_powerlevel` /
`ping` / `check_link_reliability`, `controller.get_background_rssi` /
`get_node_neighbors` / `discover_node_neighbors` / `get_known_lifeline_routes`,
`driver.enable_frequent_rssi_monitoring` / `send_test_frame`, and full route
surgery (`set`/`remove`/`get_priority_route`, `assign`/`delete_return_routes`,
`assign_custom_return_routes`, cached-route queries). **Schema-version pinning
matters** (commands renamed at schema 32: `heal_node`→`rebuild_node_routes`).
Because there is **no auth**, the add-on must treat its own driver-WS access as
privileged and never proxy it to untrusted surfaces; the driver-WS URL must be
**configurable** (Z-Wave JS UI users have a different host/slug).

### 3.4 Active probes available *today* via `invoke_cc_api` — with hazards *(source)*
- **NOP ping:** `invoke_cc_api {command_class: 0, method_name: 'send'}` awaits an
  ACK. **⚠ It can mark a marginal node DEAD** — `changeNodeStatusOnTimeout`
  defaults **true** and `invoke_cc_api` **cannot pass** the
  `changeNodeStatusOnMissingACK:false` that the driver's own health check uses.
  So probing exactly the flaky nodes the engine cares about risks flipping them
  offline (and pollutes the stats being monitored). **Consented, rate-limited
  only — never a background poller on flaky nodes.**
- **Powerlevel CC** (class 115): `startNodeTest` + poll `getNodeTestStatus` is
  reachable, but with S2-desync and dangling-test-state risk the driver otherwise
  manages. **Defer to driver-WS phase**; if ever done via `invoke_cc_api`, always
  finish with `setNormalPowerlevel` and poll coarsely.
- **`check_link_reliability`** (driver WS, undocumented) **physically toggles the
  device** (Basic Set On/Off) — lights flash. **Never auto-run**; explicit
  per-run confirmation naming the device only.

### 3.5 Health-check cost & rating (for a faithful *passive* approximation) *(source)*
`checkLifelineHealth` per round (default **5**, `HealthCheck_Busy` if one is
already running): 10 NOP pings (explorer deliberately excluded), latency =
`txReport ? txTicks·10 : rtt` kept as the **running max** across pings (correction:
not a `max(txTicks·10, rtt)` per-ping formula), `routeChanges` when
`routingAttempts>1`, SNR margin, and — if the node supports Powerlevel CC — a
`discreteLinearSearch` from Normal Power down to −9 dBm reduction (10 test frames
+ 1 s settle per step). **Rating 0–10 rubric** (reuse verbatim so our scores match
Z-Wave JS UI): 10 failed pings→0; 1 failed→max 3; latency ≤50=10/≤100=9/≤250=5/
≤500=4/≤1000=3/>1000=2; neighbors >2 vs ≤2 splits the top band; **min powerlevel
≤ −6 dBm reduction AND SNR margin ≥ 17 dB required for 8–10**; unmeasurable inputs
are *assumed fulfilled*. Cost: a default 5-round check ≈ **1–5+ minutes of near-
continuous airtime per node** — serialize, schedule in quiet windows, **never
fleet-parallel**; results taken under traffic are invalid.

> **Consequence:** implement a **spec-faithful passive approximation** of this
> rating from data HA already delivers (drop/timeout ≈ failed pings, rtt ≈
> latency, LWR changes ≈ routeChanges), and reserve the true active check for the
> driver-WS phase.

### 3.6 Concurrency & connection safety *(source)*
The driver **serializes** all serial-API transactions; **one health check per
node, one network rebuild total, one rebuild task per node** (duplicate requests
return the existing promise). HA disconnects a WS client whose outbound queue
exceeds **4096** pending messages (or sustains 1024 for 10 s) — **39 stats
subscriptions are fine, but the add-on must drain its socket promptly** or lose
telemetry silently. The engine needs a **single global action queue**: at most one
active diagnostic/rebuild in flight mesh-wide, traffic-aware scheduled.
**`@require_admin`:** the add-on's HA connection must be admin-privileged (already
true empirically — it drives `network_status`/rebuild live; not independently
traced in HA's auth source — see gaps).

### 3.7 Other telemetry *(source)*
- `subscribe_node_status` forwards alive/dead/sleep/wake/ready — the real-time
  reachability signal; dead-marking only on attempted traffic (pair with
  last-activity from stats deltas).
- `subscribe_log_updates` streams driver logs (incl. neighbor-list lines and
  per-step rebuild progress) — a **best-effort** enrichment only (log format is
  not an API; `update_log_config` mutates *shared* driver state → always restore).
- Stats event quirks: initial seed uses `nodeId` (camelCase), updates use
  `node_id`; controller events carry `timout_response`. Parse **both** key
  spellings defensively.
- `last_seen` exists in the lib but is **not forwarded** by api.py.

### 3.8 Destructive commands share the channel — deny-by-default *(source)*
`hard_reset_controller` factory-resets the controller; `restore_nvm` hardcodes
`preserveRoutes:false`; remove/replace-failed permanently alter membership — all
admin-gated with **no extra confirmation beyond the WS call**. **The engine's
allowlist must be explicit and closed** (encode read / benign-active / disruptive
/ destructive **tiers in the engine core**, not just UI). `backup_nvm` is a
sensible **automatic pre-step** before any disruptive engine action.

---

## 4. Best practices & remediation efficacy

### 4.1 The load-bearing gate: rebuild helps *only* on topology change *(source)*
zwave-js docs, verbatim: *"Contrary to popular belief, this process does not
magically make the mesh better. If devices have a physically bad connection,
assigning new routes will not help. In fact, it can make the situation worse by
deleting routes that were found to be working and assigning other bad routes."*
It helps when devices are **physically moved** (correction: the docs say *moving*,
not "added/removed" — inclusion already assigns multiple good routes). Modern
Z-Wave Plus meshes **self-heal via explorer frames** (Hubitat: repair is
"generally unnecessary … thanks to explorer frames"; run it only after
adding/removing/moving devices or on an observed problem).

> **This is the engine's most important rule:** only recommend `rebuild_node_routes`
> on **evidence of topology change** (device moved, stale neighbor data, ghost
> removed) — **never** as a response to high drop / weak-link symptoms. For the
> patio-light switches, rebuild is the **wrong** remedy and can regress a
> marginal-but-working LWR.

### 4.2 Scheduled/nightly heals are a retracted anti-pattern *(lore, strongly sourced)*
The driver authors **refused** to implement auto-healing. robertsLando: *"We are
against this kind of approach as it's generally not a good practise."*
AlCalzone: a heal *"would flood the network for a few seconds to minutes in
response to a single device temporarily having a flaky connection. Seems like a
terrible idea."* HA **ran the nightly-auto-heal experiment and retracted it**
(kpine: "in the old days HA would automatically heal every midnight … thought to
be a cause of problems, so the scheduling was disabled"); the modern integration
exposes **no automatable heal service** — a deliberate product decision. openHAB,
Vera, and OZW-era HA (the platforms that *did* auto-heal) are the source of the
"nightly heal broke my mesh" lore. **Fishwaldo's mechanism:** explorer frames let
nodes converge on the most *stable* (not shortest) paths over time; a nightly heal
recomputes shortest paths and *"destroys that intelligence."* His legitimate heal
triggers are exactly four: **(1) add a node, (2) move a node, (3) move the
controller, (4) remove a dead node.**

> **Consequence:** **never** offer a schedule, and actively flag one if the user
> has such an automation. Rebuild is event-triggered, opt-in, cooldown-gated,
> single-node-first. The engine must **re-create the guardrail HA deliberately
> removed** (advise-first, per-action opt-in, no schedules).

### 4.3 The spec-backed remediation order *(source)*
zwave-js first-steps + HA docs converge on: **(1) controller
environment/interference, (2) ghost cleanup, (3) traffic hygiene, (4)
repeater/placement for weak links, (5) targeted per-node rebuild only on topology
change, (6) mesh-wide rebuild as last resort.** Consistency with what users read
elsewhere protects trust when shipping to strangers' meshes.

### 4.4 Ghost/failed nodes — high-value, low-risk remediation *(source + lore)*
Ghosts (failed inclusions, force-removed/factory-reset-without-exclude devices)
remain in the controller's routing tables and **poison routes / cause delays**
(Z-Way: an associated ghost is "always tried first … the result is a delay").
zwave-js: `isFailedNode` → `removeFailedNode` / `replaceFailedNode`; the
controller firmware only removes nodes it has **marked failed** (a responding node
can't be force-removed — protocol behavior, not stated in the cited docs).

> **Consequence:** ghost detection ranks **above** rebuild — real mechanism of
> harm, deterministic low-risk fix (enumerate dead/no-history nodes → verify via
> `isFailedNode` → offer `remove_failed_node`). A targeted rebuild of nodes that
> *had the ghost in their routes* is a legitimate follow-up (topology changed).

### 4.5 Controller placement & USB3 *(source + lore)*
zwave-js/HA/Zooz all: sticks are **prone to USB3 interference** — use a passive
USB-2 extension (< 10 ft), central location, away from metal / server racks.
Expected 800-series background floor ≈ **−110 dBm**; **many nodes degrading
simultaneously, or an elevated floor on all channels ⇒ suspect the controller
side first** and recommend extension/relocation before any per-node action. **A
fleet-wide symptom must suppress per-node remediation.** (This is *not* the fix
for the spatially-isolated two-node patio symptom.)

### 4.6 Repeaters, FLiRS, batteries *(source + lore)*
- **Only mains-powered listening nodes repeat**; batteries add none. neighbors
  "ideally > 2"; the documented fix for persistent weak links is **"add
  additional repeaters."** **Ship no made-up density rule** — no primary
  source supports "one repeater per X ft"; frame placement relationally (between
  controller and weak node, interior wall).
- **FLiRS** (locks, some thermostats) need a **beaming-capable *last* hop** — a
  generic "add any repeater" can be wrong; slow lock response can be protocol-
  inherent beam latency, not a fault.
- **Battery/sleeping "missing" node** decision tree: **last-seen vs configured
  wake-up interval first** (absent < 2× wake-up ⇒ not missing), then battery,
  then wake-up destination, then RF. Any per-node action on a sleeping node
  **queues until next wake** — the executor needs a "pending until wake" state,
  and after-windows for sleeping nodes key off the **next wake report**, not a
  clock.

### 4.7 Traffic hygiene *(source)*
*"Too much RF traffic can be the death of a Z-Wave network."* Polling is a **last
resort** (HA: "poll requests can easily flood your network"). The fix is report
tuning (change-based over timed; sane thresholds). **S0 security triples airtime**
(3 commands/report) — flag S0-secured high-report sensors (re-include S2/none).
S2 steady-state overhead is far lower (docs single out S0; no number found). The
engine should compute per-node RX report rates and **flag outliers (orders of
magnitude above median) as "chatty device — tune reporting"** *before* blaming RF,
and must not run health checks/rebuilds while a chatty device floods the mesh.

### 4.8 TX-power config & escalation tools *(source + lore)*
Controller `rf.txPower.powerlevel`/`measured0dBm` are **driver-level options (Z-Wave
JS UI), not reachable via HA WS**, have regulatory ceilings, and **raising
controller TX does nothing for the node→controller direction** (asymmetry).
`measured0dBm` is a **calibration** value, never a boost. Recommend + link
instructions, never auto-set; don't hardcode Zooz's values. When passive stats +
health checks can't localize a problem, the **honest escalation** is "capture with
a **Zniffer**" (separate dedicated 800-series stick — it's the only per-frame
ground truth) — pretending the add-on sees per-frame behavior it can't would be
false precision.

---

## 5. Prior art & safety patterns for autonomous remediation

### 5.1 Learned remediation has direct prior art — but home meshes lack statistical power *(source)*
**Narya (Microsoft Azure, OSDI '20):** predicts host failures and *"leverages A/B
testing to continually experiment with different mitigation actions, measure the
benefits, and discover optimal actions,"* with a multi-armed-bandit/RL layer
because *"some mitigation action that worked well in the past may no longer be
optimal"* — 26 % VM-interruption reduction over 15 months. **Critical caveat:**
Narya's power comes from *millions* of nodes; **a 39-node home mesh has
essentially no per-mesh statistical power.** So: ship **static, spec-derived
playbooks with outcome *logging* first**; treat learned re-ranking as needing
minimum-evidence thresholds (or opt-in fleet aggregation) before it changes any
recommendation. **No published quantitative before/after study of Z-Wave heal
efficacy exists anywhere** — our outcome ledger would generate data that doesn't
publicly exist, which both argues for conservatism now and makes anonymized
aggregation a genuinely novel future contribution.

### 5.2 Closed-loop safety patterns to adopt *(source)*
- **Canarying (Google SRE):** *"partial and time-limited deployment … and its
  evaluation"* against an untouched control. → **Blast radius = 1 node by
  default**; act on the least-critical qualifying node, evaluate its KPIs vs
  untouched similar nodes, expand only if gated.
- **Rate limits + escalation ladders (Meta FBAR / LinkedIn Nurse):** cap how many
  repairs run at once; failed auto-remediation **escalates to a human ticket**;
  outcomes classified *undiagnosed* / *misdiagnosed* feed learning. → **one
  remediation in flight per mesh**, **bounded attempts per node per window** then
  escalate to a human-facing recommendation with evidence attached; every outcome
  recorded effective/ineffective/undiagnosed (the **misdiagnosis ledger** is what
  keeps the learned layer honest).
- **Bake time + rollback + when to act (AWS Builders' Library):** negative impact
  can be *"slow burning"* → **after-windows must be long** (hours–days for a mesh
  whose battery nodes report rarely); every action needs a rollback story or an
  "irreversible" mark in the approval UI; and **counterintuitively act in
  traffic-quiet windows while the user is awake to notice breakage** — the classic
  2 am maintenance window is the *wrong* default (the nightly-heal precedent
  failed partly for this).
- **Automation maturity (Google SRE):** the **observe → advise → gated-auto →
  auto** ladder maps onto the SRE hierarchy; each stage independently opt-in per
  playbook. **Diskerase lesson:** node-selection must treat empty/degenerate
  selections as **errors** — "rebuild all nodes matching filter" with an empty
  filter must **refuse**, never expand to all 39. *(The named 4-stage ladder is
  vendor phrasing; SRE's hierarchy is the citable analog — see gaps.)*

### 5.3 Flap suppression & remediation storms *(spec + source)*
- **RFC 2439 route-flap damping** is the canonical mechanism: increment a
  figure-of-merit on each event, **decay it exponentially**, act only above a
  **suppress** threshold, re-arm only below a lower **reuse** threshold. Its own
  history is the cautionary tale: **RIPE-378 declared the default thresholds
  harmful** because they trip on **correlated bursts**; **RIPE-580 / RFC 7196**
  rehabilitated it only with **raised thresholds** (suppress ≥ 6000, max penalty
  ≥ 50000). → score each node's symptoms with a decaying penalty and make
  thresholds **deliberately tolerant of short correlated bursts** (interference
  events) so the suppressor doesn't amplify them.
- **Metastable failures (Bronson, HotOS '21):** self-sustaining collapse where
  *recovery mechanisms become the sustaining feedback loop* — retry storms, death
  spirals. AlCalzone described the exact Z-Wave loop: heal traffic degrades the
  mesh → more "dead" symptoms → more healing. → **global action budget** (max N
  actions/mesh/day) + **per-node exponential backoff**, enforced *independently*
  of per-playbook logic, because Z-Wave's ~10–20 msg/s shared bandwidth is exactly
  the constrained system where remediation traffic creates the symptoms it reacts
  to.

### 5.4 Correlated symptoms = one event, not N problems *(source + inference)*
AlCalzone's root-cause list for an unreachable node — *bad controller placement,
bad controller RF (700-series pre-FW 7.17.2), other nodes flooding, external
interference, not enough repeaters* — *"None of that is obvious from just looking
at the 'dead' state."* **Correction:** that these *"all produce simultaneous
multi-node symptoms"* is **our inference**, not his claim (he framed a single
flaky lock). But the inference is sound and matches BGP path-hunting. → **a
correlation gate runs before any per-node playbook:** if ≥ K nodes degrade in the
same window (or controller stats degrade), classify as a **mesh-level event**
(interference / controller / flooding) and **suppress all per-node remediation**.
This directly fits the live symptom — two exterior-wall switches degrading
together in a Phoenix stucco house is plausibly **one RF-environment event**.

### 5.5 Measurement discipline *(source)*
Every surveyed successful system measures before/after and re-decides — none acts
without recorded outcome evaluation. Diagnostics are **themselves invasive**
(health checks invalid under traffic; `tryReallyHard` blocks the mesh for
seconds; powerlevel tests throw on FLiRS/sleeping nodes; one check per node). →
**every engine action (even advised-but-user-executed) gets a ledger row:** before
snapshot, action + params, after-window KPIs (`timeoutResponse`, route changes,
rate fallbacks, status flaps), and a verdict (improved / no-change / **worse** —
the ledger must catch the rebuild-made-it-worse case the docs predict). v1
verification comes from **passive statistics** (HA can't invoke health checks).
Battery/FLiRS invariants: `includeSleeping=false` for engine-initiated network
actions; never queue repeated per-node actions on battery nodes; exclude
FLiRS/sleeping from active link tests; sleeping-node after-windows key off next
wake.

---

## 6. Live symptom — worked diagnosis (patio-light switches)

Applying the corpus to #6 Pool Patio Light (score 65, "DROP 33 %", RTT 189 ms,
via n7 @ 9.6k, F+R flags, RSSI improving) and #3 South Patio Light (77, "DROP
25 %", direct @ 100k, F):

1. **The "DROP %" is `timeoutResponse`-driven, not ACK-drops** (§0) — nodes are
   **Alive**, so the RF link *up to the ACK* works; reports are lost/slow on the
   return path.
2. **Good RSSI (−70s) ⇒ ~30 dB controller-side margin** (§1.4) — **not** steady-
   state weak signal.
3. **#6's 9.6k via repeater n7** (§2.2) = a **degraded/legacy route** — check
   whether n7 or the path is 100-series/FLiRS before calling it RF impairment;
   if n7 is 100k-capable, the 9k6 is genuine impairment on that hop.
4. **Both on exterior stucco/wire-lath walls** (§1.7) = **RF edge nodes** — the
   physically correct fix is **a mains repeater on an interior wall between
   controller and switch**, *not* a rebuild.
5. **They co-degrade** (§5.4) — the correlation gate should consider **one
   RF-environment event** (Phoenix exterior-wall attenuation ± a duty-cycled
   900 MHz interferer like the AMI meter on those same walls, §1.8) over two
   independent node faults.
6. **`rebuild_node_routes` is the wrong first move** (§4.1) — it can regress #3's
   working direct 100k route and won't conjure a repeater that isn't there.
   Correct order: rule out chatty-neighbor flooding → assess repeater coverage on
   the interior path → **recommend repeater placement** → only then, if a better
   route physically exists and neighbor data is stale, a **targeted** rebuild.
7. **Confirm per-hop** (§2.3): capture `routeFailedBetween` event-driven to name
   the exact failing hop; **verify HA serializes lwr/nlwr first** (gap).

---

## 7. Honest gaps (unknowns to close before depending on them)

**Blocking / probe-before-build:**
1. **Does HA's `subscribe_node_statistics` event serialize the nested `lwr/nlwr`
   objects** (protocolDataRate, repeaters, repeaterRSSI, `routeFailedBetween`,
   routeSchemeState), or only flat counters? Per-hop localization (§2.3) and rate
   diagnosis (§2.2) depend on it. **Capture a live event before building M3.**
2. **Background RSSI / SNR is unreachable via HA** (§1.5) — confirmed dropped at
   the WS boundary. Interference detection (M6) is passive-only until a driver-WS
   phase or upstream HA PR. Design the interface; gate SNR features as phase-2.
3. **Priority-route cached reads** (`getPriorityReturnRoutesCached`) are not in
   HA WS → the safe-rebuild precondition can't be checked; **warn
   unconditionally** (§2.4).
4. **`@require_admin` for write commands** is satisfied empirically but not traced
   in HA's Supervisor auth source (§3.6).

**Accuracy caveats (do not overstate):**
5. The exact **100k→40k→9.6k rate-fallback algorithm** is unpublished — 9k6 is a
   **flag, not a mechanism** (§2.2).
6. **`commandsDroppedTX`'s real-world increment rate** is uncertain (couldn't force
   it in a mock) — **log observed increments in context, don't assume a
   definition** (§0).
7. **No measured 900 MHz dB figure** for stucco-over-lath / low-E glass / foil
   insulation — construction-class prior only, never a number (§1.7).
8. **Channel-index→frequency mapping** is firmware-defined — don't hardcode (§1.6).
9. **800-series RX sensitivity per rate** (datasheet not fetched), **INS12712
   RED/YELLOW/GREEN health thresholds** (PDF failed text extraction — re-parse
   with a PDF tool), **whether classic US firmware does LBT/CCA in practice**,
   **Sidewalk's exact channel plan**, and **whether the Aug-2025 LR power-
   starvation flaw persists** in current firmware — all open.
10. The **named observe→advise→gated-auto→auto** ladder is vendor phrasing; cite
    Google SRE's hierarchy as the formal analog (§5.2).

---

## 8. Design constraints this research imposes (the engine's rulebook)

1. **Drop-rate ≠ `commandsDroppedTX`.** Build the classifier on
   `timeoutResponse` + **Alive↔Dead flaps** + route/rate signals; keep the
   `tx≤0 ⇒ null` guard; delta counters with a **restart/reset guard**. *(§0, §1.11)*
2. **Protocol predicate on every rule.** LR nodes: no rebuild / neighbors /
   repeaters / priority routes — physical/power only, and several driver calls
   *throw*. *(§1.10, §2.4)*
3. **Rebuild only on topology-change evidence**, never on weak-link/drop symptoms;
   **never scheduled**; **never network-wide** for a localized problem; **warn it
   deletes manual priority routes**; **never on an unreachable node.** *(§4.1, §4.2, §2.4)*
4. **Correlation gate first.** ≥ K correlated degradations or rising controller
   stats ⇒ mesh-level event ⇒ **suppress per-node remediation**, look at
   controller/interference. *(§5.4, §2.11, §4.5)*
5. **SNR/noise features are phase-2** (HA drops background RSSI). v1 is passive-
   stats only; approximate the health-check rating with the **exact zwave-js
   thresholds** so scores match Z-Wave JS UI. *(§1.5, §3.5)*
6. **Measure before/after or it didn't happen.** Long after-windows (wake-keyed
   for sleeping nodes); ledger every action with an **improved/no-change/worse**
   verdict; the ledger is the audit trail *and* the learned layer's data. *(§5.5, §5.1)*
7. **Blast-radius discipline:** one action in flight per mesh; blast radius = 1
   node; per-node cooldown + global daily budget + exponential backoff; flap
   suppression with **burst-tolerant** thresholds; empty/degenerate node-selection
   **refuses**. *(§5.2, §5.3, §3.6)*
8. **Probing is invasive.** NOP ping via `invoke_cc_api` can mark a flaky node
   **dead** — consented + rate-limited, never a background poller; no active link
   tests on battery/FLiRS; `backup_nvm` before any disruptive action. *(§3.4, §5.5, §3.8)*
9. **Closed, tiered allowlist** (read / benign-active / disruptive / destructive)
   in the engine core — the same channel that rebuilds can factory-reset. *(§3.8)*
10. **Advisory-first, honest nulls, shareable defaults** — the whole program
    earns trust by being right while doing nothing, and ships nothing house-tuned.

---

## 9. References (primary, by domain)

**Specs:** ITU-T G.9959 (2015) `itu.int/rec/T-REC-G.9959-201501-I`; Silicon Labs
APL13031 Networking Basics, INS12712 Network Installation & Maintenance, Z-Wave LR
protocol overview `docs.silabs.com/z-wave/latest/.../04-z-wave-long-range-protocol-overview`,
800-series intro; Digi XST-AN005a Indoor Path Loss; RFC 2439, RFC 7196, RIPE-378,
RIPE-580.

**zwave-js (driver — the authoritative implementation):** `github.com/zwave-js/zwave-js`
— `docs/api/{node,controller,driver}.md`, `docs/troubleshooting/{first-steps,common-issues,zniffer}.md`,
`packages/zwave-js/src/lib/node/{Node,NodeStatistics,HealthCheck}.ts`,
`.../driver/{Driver,Transaction,MessageGenerators}.ts`,
`.../controller/{Controller,ControllerStatistics}.ts`,
`packages/core/src/definitions/{TXReport,Protocol,RoutingScheme,Transmission}.ts`;
CHANGELOG_v12 (heal→rebuild rename); zwave-js-server `src/lib/{node,controller,driver}/command.ts` + README.

**Home Assistant:** `github.com/home-assistant/core` →
`homeassistant/components/zwave_js/api.py` (+ services.py, websocket_api/const.py);
`zwave-js-server-python` node/controller/statistics models; add-on
`home-assistant/addons/zwave_js` config + changelog (1.5.0 → zwave-js 15.24.2–15.25.0);
integration docs `home-assistant.io/integrations/zwave_js`; architecture #81 (Fishwaldo).

**Community / vendor (labelled lore):** DrZWave blog (RF jamming, priority routes,
FLiRS/beaming, mesh); zwave-js-ui #3006/#3253/#4020/#3669/#3681, zwave-js
#2533/#7147; Hubitat repair docs; SmartThings ghost-node & metal-building FAQs;
Z-Way troubleshooting; Zooz ZST39 KB; blog.zwave-js.io "Z-Wave (not so) Long
Range" (2025).

**Prior art / safety:** Narya (Azure, OSDI '20); Google SRE book (automation) &
workbook (canarying); AWS Builders' Library (safe hands-off deployments); Meta
FBAR; LinkedIn Nurse; Bronson et al. metastable failures (HotOS '21).

**Live probes (this installation, HA Core 2026.7.2, 2026-07-16):** command-existence
sweep of `zwave_js/*` (validation-only, nothing executed) —
`scratchpad/zwave-research/live-api-probe.md`. Empirical driver behavior:
zwave-js@15.25.3 + @zwave-js/testing (NoAck→DEAD without incrementing
`commandsDroppedTX`; ack-but-no-report→`timeoutResponse=1`, Alive;
`attempts.sendData===3`).

*Full 114-finding structured corpus (with per-claim confidence, sources, and the
40 adversarial verification verdicts) archived at
`scratchpad/zwave-research/research-result.json`.*
