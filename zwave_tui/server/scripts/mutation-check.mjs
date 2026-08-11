#!/usr/bin/env node
/**
 * Mutation check — is each behavioural fix actually pinned by a test?
 *
 * WHY THIS EXISTS. Across four adversarial review rounds the recurring failure
 * was not bad fixes, it was tests that PASS FOR A BROKEN IMPLEMENTATION: an
 * assertion comparing a value to itself, a substring the wrong branch also
 * satisfies, a fixture value where the correct and broken code happen to agree,
 * or a test that restates the rule instead of calling the code. Twice a release
 * note claimed "every fix is mutation-verified" when it was not — the claim had
 * been made from having checked *that round's* fixes, not all of them.
 *
 * So the claim is no longer written by hand. Each entry below reverts one fix;
 * the suite must go RED. Anything that stays green is either an untested fix or
 * an EQUIVALENT mutant, and must be labelled as such rather than left silent.
 *
 *   node scripts/mutation-check.mjs           # all
 *   node scripts/mutation-check.mjs --only=heatmap
 *
 * An entry whose `find` text no longer appears reports MISSING — the fix moved
 * or was reworded, and the entry needs updating. That is a failure too: it
 * means this file has drifted from the code it claims to check.
 *
 * COMPLETENESS IS PART OF THE CLAIM. A clean run over an INCOMPLETE list is
 * still misleading — a round-5 self-audit found ten behavioural fixes with no
 * entry here, including three changed files with no coverage at all. When you
 * change behaviour, add the entry in the same commit.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {object} Mutant
 * @property {string} id     short slug (also the --only filter)
 * @property {string} file   path relative to server/
 * @property {string} find   exact source text of the fix
 * @property {string} repl   what the code looked like before it (or a break)
 * @property {string} what   the behaviour that regresses
 * @property {true}  [equivalent]  known-unkillable; see `why`
 * @property {string} [why]  why it cannot be killed today
 */

/** @type {Mutant[]} */
const MUTANTS = [
  /* ── shared chrome ─────────────────────────────────────────────────── */
  { id: 'cmdbar-whole-caps', file: 'src/telnet/chrome.ts',
    // Faithful revert to the pre-fix behaviour (a bare character clip), NOT a
    // `null &&` short-circuit — that failed to typecheck, so it "killed" by
    // breaking the build rather than by failing an assertion.
    find: "  const whole = fitCaps(caps, budget, '');\n  if (whole != null) return whole;",
    // Guarded so TS cannot prove the rest unreachable (an unconditional return
    // makes the following code `never` and stops it type-checking, which would
    // be a build failure masquerading as a behavioural kill).
    repl: "  if (budget >= 0) return truncate(caps.join(c.grey('   ')), budget);",
    what: 'command bar fits whole keycaps instead of clipping mid-cap' },
  { id: 'cmdbar-keep-last', file: 'src/telnet/chrome.ts',
    find: '    if (dropped.size >= keys.length - 1) break;', repl: '',
    what: 'the bar never sheds its last cap and collapses to an empty row' },
  { id: 'fieldstrip-whole', file: 'src/telnet/chrome.ts',
    find: "    for (const lead of ['  ', ' ']) {", repl: "    for (const lead of []) {",
    what: 'telemetry fields degrade with a disclosed count' },
  { id: 'titlerule-right', file: 'src/telnet/chrome.ts',
    find: '  if (visLen(head) > headMax) head = truncate(head, headMax);', repl: '',
    what: 'the title rule shortens the TITLE and keeps its right-hand status' },
  { id: 'frame-overflow', file: 'src/telnet/chrome.ts',
    find: '  const hidden = Math.max(0, o.body.length - bodyCap);',
    repl: '  const hidden = 0;',
    what: 'frame() discloses body rows it could not fit' },

  /* ── ansi primitives ───────────────────────────────────────────────── */
  { id: 'lr-keep-right', file: 'src/telnet/ansi.ts',
    // Anchored on the keep-right lines themselves so the mutant is WELL-FORMED.
    // The previous repl injected an unmatched brace at end-of-file, so it
    // "killed" by breaking the build rather than by failing an assertion.
    find: "  const rw = visLen(right);\n  if (rw >= width) return truncate(right, width);\n  return truncate(left, Math.max(0, width - rw - 1)) + ' ' + right;",
    repl: "  return truncate(left + ' ' + right, width);",
    what: 'lr() shortens the label and keeps the value' },
  { id: 'ctrl-chars', file: 'src/telnet/ansi.ts',
    find: '    if (IS_CTL.test(s[i])) { i++; continue; }', repl: '',
    what: 'control bytes are stripped before they can break a frame row' },

  /* ── gauges ────────────────────────────────────────────────────────── */
  { id: 'litbars-floor', file: 'src/telnet/gauges.ts',
    find: '  return f <= 0 ? 0 : Math.max(1, Math.round(f * bars));',
    repl: '  return Math.round(f * bars);',
    what: 'a present-but-weak signal never renders as no signal' },
  { id: 'meter-endpoints', file: 'src/telnet/gauges.ts',
    find: '  const filled = f >= 1 ? width : f <= 0 ? 0 : Math.min(width - 1, Math.max(1, Math.round(f * width)));',
    repl: '  const filled = Math.round(f * width);',
    what: 'meter() reserves full/empty for exactly 100%/0%' },
  { id: 'spark-window', file: 'src/telnet/gauges.ts',
    find: '  const lo = opts.min ?? Math.min(...recent);\n  const hi = opts.max ?? Math.max(...recent);\n  const span = hi - lo || 1;\n  // A flat',
    repl: '  const lo = opts.min ?? Math.min(...vals);\n  const hi = opts.max ?? Math.max(...vals);\n  const span = hi - lo || 1;\n  // A flat',
    what: 'the sparkline scales to the samples it draws, not off-screen history' },

  /* ── shared colour bands ───────────────────────────────────────────── */
  { id: 'band-rtt', file: 'src/telnet/bands.ts',
    find: '  if (ms < 500) return c.white;', repl: '  if (ms < 500) return c.yellow;',
    what: 'the RTT band thresholds' },
  { id: 'band-timeout', file: 'src/telnet/bands.ts',
    find: '  if (pct < 3) return c.white;', repl: '  if (pct < 3) return c.yellow;',
    what: 'the response-timeout band thresholds' },
  { id: 'band-margin', file: 'src/telnet/bands.ts',
    find: '  if (db >= WEAK_MARGIN_DB) return c.yellow;',
    repl: '  if (db >= WEAK_MARGIN_DB) return c.red;',
    what: 'the SNR-margin band thresholds' },

  /* ── per-screen honesty ────────────────────────────────────────────── */
  { id: 'overview-dead-grey', file: 'src/telnet/screens/overview.ts',
    find: '  const staleRf = isDead ? c.grey : null;',
    // `false as boolean` defeats narrowing: a plainly-null initialiser makes TS
    // infer `never` at the call sites, so the mutant would fail to compile
    // rather than fail an assertion.
    repl: '  const staleRf = (false as boolean) ? c.grey : null;',
    what: 'a dead node\'s stale RF cells render neutral, not health-green' },
  { id: 'overview-scroll', file: 'src/telnet/screens/overview.ts',
    find: '  view.scroll = start;', repl: '',
    what: 'the Overview writes its clamped scroll window back' },
  { id: 'overview-unknown-mesh', file: 'src/telnet/screens/overview.ts',
    find: '    ? Math.max(0, all.length - dead - flaky - unknown) / all.length',
    repl: '    ? Math.max(0, all.length - dead - flaky) / all.length',
    what: 'never-contacted nodes do not count as healthy in MESH%' },
  { id: 'overview-bars-band', file: 'src/telnet/screens/overview.ts',
    find: '  const bars = signalBars(frac, 4, routed ? c.grey : colorFn);',
    repl: '  const bars = routed ? signalBars(frac, 4, c.grey) : signalBars(frac, 4);',
    what: 'the signal glyph uses the same band function as its number' },
  { id: 'detail-dead-rtt', file: 'src/telnet/screens/detail.ts',
    find: '        : dead(n) ? c.grey(`${rttShown} ms`)', repl: '',
    what: 'the dossier greys a dead node\'s stale RTT' },
  { id: 'detail-dead-route', file: 'src/telnet/screens/detail.ts',
    find: "    bits.push((stale ? c.grey : rate >= 3 ? c.green : rate === 2 ? c.yellow : c.red)(rl));",
    repl: "    bits.push((rate >= 3 ? c.green : rate === 2 ? c.yellow : c.red)(rl));",
    what: 'the dossier greys a dead node\'s stale route rate' },
  { id: 'detail-band', file: 'src/telnet/screens/detail.ts',
    find: '    const tmoColor = dead(n) ? c.grey : timeoutPctColor(pct ?? 0);',
    repl: '    const tmoColor = dead(n) ? c.grey : ((q: number) => (q < 5 ? c.green : q < 15 ? c.yellow : c.red))(pct ?? 0);',
    what: 'the dossier uses the SHARED timeout band, not a private copy' },
  { id: 'topology-scroll-key', file: 'src/telnet/input.ts',
    find: "  if (view.screen === 'topology') {\n    const r = applyTopologyKey(view, ev);\n    if (r) return r;\n  }",
    repl: '', what: 'the Topology route tree scrolls (its bar advertises [↑↓] SCROLL)' },
  { id: 'remedy-cursor-key', file: 'src/telnet/input.ts',
    find: "  if (view.screen === 'remedy') {\n    const r = applyRemedyKey(view, ev, data);\n    if (r) return r;\n  }",
    repl: '', what: 'the Remedy symptom cursor moves (its bar advertises [↑↓] SYMPTOM)' },
  { id: 'key-scope-o', file: 'src/telnet/input.ts',
    find: "    case 'o':\n    case 'O':\n      // The Log owns this key",
    repl: "    case 'o':\n    case 'O':\n      view.errorsOnly = !view.errorsOnly;\n      return REDRAW;\n      // The Log owns this key",
    what: 'the errors-only filter cannot be armed from another screen' },
  { id: 'key-scope-slash', file: 'src/telnet/input.ts',
    find: "      if (view.screen !== 'overview' || !data.ready()) return NOOP;",
    repl: "      if (view.screen !== 'overview') return NOOP;",
    what: '"/" cannot start an invisible capture on the loading card' },
  { id: 'esc-clears-filter', file: 'src/telnet/input.ts',
    find: "    if (view.filter) {\n      view.filter = '';",
    repl: "    if (false) {\n      view.filter = '';",
    what: 'Esc clears a committed filter on the Overview' },
  { id: 'heatmap-area-tier', file: 'src/telnet/screens/heatmap.ts',
    find: '    if (x.deadCount > 0) return x.gradedCount === 0 ? 0 : 1;',
    repl: '    if (x.deadCount > 0 && x.gradedCount === 0) return 0;',
    what: 'an area containing dead nodes outranks every healthy area' },
  { id: 'heatmap-cell-rank', file: 'src/telnet/screens/heatmap.ts',
    find: '      x.dead ? 0 : x.unknown ? 1 : x.margin == null ? 3 : 2;',
    repl: '      x.margin == null ? 1 : 0;',
    what: 'dead/unknown marks survive cell-strip overflow' },
  { id: 'heatmap-routed-grade', file: 'src/telnet/screens/heatmap.ts',
    find: '    const reals = cells.filter((x) => x.margin != null && !x.routed)',
    repl: '    const reals = cells.filter((x) => x.margin != null)',
    what: 'a repeater\'s last-hop reading does not grade the area' },
  { id: 'heatmap-legend-order', file: 'src/telnet/screens/heatmap.ts',
    find: '  for (let n = KEYS.length; n >= 0; n--) {\n    for (let ramp = 14; ramp >= 4; ramp--) {',
    repl: '  for (let ramp = 14; ramp >= 4; ramp--) {\n    for (let n = KEYS.length; n >= 0; n--) {',
    what: 'the legend keeps whole keys in preference to a wide ramp' },
  { id: 'heatmap-legend-band', file: 'src/telnet/screens/heatmap.ts',
    find: '      strip += heatCell(frac, { color: marginColor(frac * MARGIN_FULL) });',
    repl: '      strip += heatCell(frac);',
    what: 'the legend ramp uses the same bands as the cells it explains' },
  { id: 'heatmap-mean-band', file: 'src/telnet/screens/heatmap.ts',
    find: 'meter(marginFrac(a.meanMargin), MEAN_BAR, { color: marginColor(a.meanMargin) })',
    repl: 'meter(marginFrac(a.meanMargin), MEAN_BAR)',
    what: 'the mean-margin meter agrees with the number beside it' },
  { id: 'topology-unknown', file: 'src/telnet/screens/topology.ts',
    find: "  const mark = isDead ? c.red('✕') : isUnknown ? c.grey('○') : asleep ? c.cyan('◐') : c.green('●');",
    repl: "  const mark = stale ? c.red('✕') : asleep ? c.cyan('◐') : c.green('●');",
    what: 'Unknown is marked apart from Dead' },
  { id: 'topology-est-sep', file: 'src/telnet/screens/topology.ts',
    find: "  const est = hasRealNoise ? '' : c.grey(' est');",
    repl: "  const est = hasRealNoise ? '' : c.grey('est');",
    what: 'the estimated-margin marker is separated from its value' },
  { id: 'controller-denominator', file: 'src/telnet/screens/controller.ts',
    find: '  const denom = messages + errors;',
    repl: '  const denom = Math.max(1, messages);',
    what: 'the error rate is a fraction of ATTEMPTS and cannot exceed 100%' },
  { id: 'controller-tmo-cb', file: 'src/telnet/screens/controller.ts',
    find: '    (st.timeoutCallback ?? 0);', repl: '    0;',
    what: 'timeoutCallback counts toward the serial error rate' },
  { id: 'controller-partial', file: 'src/telnet/screens/controller.ts',
    find: "  const partial = st.timeoutCallback == null ? c.grey(' (partial)') : '';",
    repl: "  const partial = '';",
    what: 'an unreported counter is disclosed, not silently treated as zero' },
  { id: 'controller-unknown', file: 'src/telnet/screens/controller.ts',
    find: '    else unknown++;', repl: '    else { /* dropped */ }',
    what: 'the NETWORK HEALTH status tallies sum to the node count' },
  { id: 'controller-pending', file: 'src/telnet/screens/controller.ts',
    find: '    } else pending++; // no route resolved yet — counted, not dropped',
    repl: '    }', what: 'the link tallies sum to the node count' },
  { id: 'controller-labels', file: 'src/telnet/screens/controller.ts',
    find: '    const text = visLen(label) + visLen(value) + 1 <= cellW - 1 ? label : short;',
    repl: '    const text = label;',
    what: 'counter labels stay distinguishable at the narrow floor' },
  { id: 'controller-noise-gauge', file: 'src/telnet/screens/controller.ts',
    find: "        gauge(noiseQuietFrac(r), chBarW, noiseColor(r)(`${r}dBm`), { color: noiseColor(r) }),",
    repl: "        gauge(noiseQuietFrac(r), chBarW, noiseColor(r)(`${r}dBm`)),",
    what: 'the per-channel noise gauge fills with its own band colour' },
  { id: 'remedy-plan-order', file: 'src/telnet/screens/remedy.ts',
    find: '    (a.subsumedBy ? 1 : 0) - (b.subsumedBy ? 1 : 0) ||', repl: '',
    what: 'plan-owning symptoms outrank the ones subsumed beneath them' },
  { id: 'log-sanitize', file: 'src/zwave/zwaveData.ts',
    find: '      text: sanitizeEventText(text),', repl: '      text,',
    what: 'log event text is sanitized at the sink' },

  /* ── actions scoping ───────────────────────────────────────────────── */
  { id: 'menu-scope-split', file: 'src/telnet/actionsCatalog.ts',
    find: '    if (d.scope !== want) continue;', repl: '',
    what: 'device and network menus never mix blast radii' },
  { id: 'menu-scope-screen', file: 'src/telnet/session.ts',
    find: "    if (this.view.screen === 'controller') return 'network';",
    repl: "    if (this.view.screen === 'controller') return 'device';",
    what: 'the Controller screen opens the NETWORK menu' },
  { id: 'menu-title', file: 'src/telnet/screens/actionsMenu.ts',
    find: "  const title = c.cyanB(network ? 'NETWORK ACTIONS' : 'DEVICE ACTIONS');",
    repl: "  const title = c.cyanB('ACTIONS');",
    what: 'the menu header states its blast radius' },
  { id: 'action-refusal', file: 'src/telnet/session.ts',
    find: '      return true;\n    }\n    const nodeId = tgt?.nodeId ?? null;',
    repl: '      return false;\n    }\n    const nodeId = tgt?.nodeId ?? null;',
    what: 'a refused node action consumes the key and reaches the screen' },
  { id: 'remedy-target', file: 'src/telnet/session.ts',
    // Remove the whole branch — the actual pre-fix state. `if (false) {` left
    // the body unreachable and failed to compile.
    find: "    if (this.view.screen === 'remedy') {\n      const list = sortedSymptoms(this.data.symptoms());",
    repl: "    if (this.view.screen === ('never' as typeof this.view.screen)) {\n      const list = sortedSymptoms(this.data.symptoms());",
    what: 'REMEDY acts on the symptom under the cursor, not the Overview\'s' },

  /* ── round-5 self-audit: fixes that had NO entry, so the "0 survived"
     count was true over an INCOMPLETE list. Three changed files (interference,
     login, log) had no coverage here at all. ─────────────────────────────── */
  { id: 'interference-floor-band', file: 'src/telnet/screens/interference.ts',
    find: '    const floorC = iv.noise.floor == null ? c.grey : noiseColor(iv.noise.floor);',
    repl: '    const floorC = nc;',
    what: 'the noise-floor NUMBER uses the shared dBm band, not the engine band colour' },
  { id: 'login-exact-rows', file: 'src/telnet/screens/login.ts',
    find: "  while (out.length < o.rows) out.push('');", repl: '',
    what: 'renderLogin returns EXACTLY view.rows lines like every other path' },
  { id: 'log-keycap-priority', file: 'src/telnet/screens/log.ts',
    find: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE', 2], ['⏎', 'DEVICE', 1], ['M', 'ACK', 5], ['D', 'DATE', 4],\n      ['O', 'ERRORS', 3], ['1-8', 'SCREENS'], ['Q', 'CLOSE'],",
    repl: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE'], ['⏎', 'DEVICE'], ['M', 'ACK'], ['D', 'DATE'],\n      ['O', 'ERRORS'], ['1-8', 'SCREENS'], ['Q', 'CLOSE'],",
    what: "the Log bar sheds its least-useful caps first, not navigation" },
  { id: 'controller-role-collision', file: 'src/telnet/screens/controller.ts',
    find: '  const tight = W < 72;', repl: '  const tight = false;',
    what: 'a controller WITH a SIS never renders identically to one WITHOUT' },
  { id: 'heatmap-devices-label', file: 'src/telnet/screens/heatmap.ts',
    find: "      field('DEVICES', String(totalNodes)),",
    repl: "      field('NODES', String(totalNodes)),",
    what: 'the map does not label a different population with the Overview\'s NODES' },
  { id: 'remedy-advisory-claim', file: 'src/telnet/screens/remedy.ts',
    find: "  return bits.join(c.grey(' · ')) + c.grey('  —  the engine only recommends; you run the actions');",
    repl: "  return bits.join(c.grey(' · ')) + c.grey('  —  advisory only; nothing is acted on');",
    what: 'REMEDY does not claim nothing is acted on while its own bar runs actions' },
  /* ── v0.29 topology: per-hop readings, churn, surplus accounting ────── */
  /* ── route identity: unknown is not a route ─────────────────────────── */
  { id: 'route-unknown-is-direct', file: 'src/zwave/evidenceStore.ts',
    // Restores the exact conflation the second copy of this function had in
    // zwaveData: no LWR data reads as a direct link. A routed node whose `lwr`
    // blinks then scores two route changes for zero re-routing, and route-churn
    // fires at four.
    find: "  if (!lwr) return null;\n  const reps = Array.isArray(lwr.repeaters) ? lwr.repeaters : [];",
    repl: "  if (!lwr) return 'direct';\n  const reps = Array.isArray(lwr.repeaters) ? lwr.repeaters : [];",
    what: 'an absent route reads as UNKNOWN, never as a direct link' },
  { id: 'route-change-null-guard', file: 'src/zwave/evidenceStore.ts',
    // Drops the both-sides-known requirement, so losing sight of a route (and
    // regaining it) each count as a re-route.
    find: '  return a != null && b != null && a !== b;',
    repl: '  return a !== b;',
    what: 'a route change needs BOTH endpoints known, not just a differing key' },
  { id: 'route-metric-unscorable', file: 'src/zwave/outcomes.ts',
    // Puts route-churn back in the never-scorable bucket, where it sat behind a
    // justification ("multi-node or mesh-scoped") that was false for it.
    find: "    case 'route-churn':\n      return 'route'; // LWR re-routes subsiding",
    repl: "    case 'route-churn':\n      return 'none';",
    what: 'route-churn recoveries are measured, not written off as unverifiable' },
  { id: 'route-known-gate', file: 'src/zwave/outcomes.ts',
    // Drops the visibility floor, so a node whose route went dark scores its
    // run of zeros as a cure.
    find: "      if (after.routeKnown < MIN_LIVE) return 'unverifiable';",
    repl: '',
    what: 'a route that went INVISIBLE is unknown, never a settled route' },
  /* ── v0.33: the error-ack latch release ──────────────────────────────── */
  { id: 'ack-writes-latch', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // The pre-v0.33 state: the acked field exists, renders two-tone, and
    // nothing ever sets it — errors latch bold-red forever.
    find: '    if (!ev || ev.severity !== \'error\' || ev.acked) return false;\n    ev.acked = true;',
    repl: '    if (!ev || ev.severity !== \'error\' || ev.acked) return false;',
    what: 'acking an error actually releases its RED latch' },
  { id: 'ack-error-only', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Lets any severity be "acknowledged" — an info event has no latch, and a
    // true return would repaint for nothing.
    find: "    if (!ev || ev.severity !== 'error' || ev.acked) return false;",
    repl: '    if (!ev || ev.acked) return false;',
    what: 'only an ERROR carries a latch to release' },
  { id: 'ack-selected-not-head', file: 'src/telnet/input.ts', tests: ['logNav'],
    // Acks the newest event instead of the one under the cursor — the same
    // target-drift class as the v0.9 menu-target finding.
    find: '      const sel = list[view.logCursor];\n      if (sel && data.ackEvent?.(sel.seq)) return REDRAW;',
    repl: '      const sel = list[0];\n      if (sel && data.ackEvent?.(sel.seq)) return REDRAW;',
    what: 'M acks the SELECTED event, never the newest' },
  /* ── v0.32.1: the 2026-08-05 live-log defects ────────────────────────── */
  { id: 'lastseen-utc', file: 'src/zwave/driverWsClient.ts', tests: ['driverWsClient'],
    // Reverts to parsing a timezone-naked driver timestamp as LOCAL time — the
    // 7-hour skew that made every lastSeen sit in the future and turned the
    // 240-minute liveness probe into an 11-hour one.
    find: "    const t = Date.parse(ISO_NO_OFFSET.test(v) ? v + 'Z' : v);",
    repl: '    const t = Date.parse(v);',
    what: 'a timezone-naked driver timestamp is parsed as UTC, not local' },
  { id: 'teardown-error-listener', file: 'src/zwave/driverWsClient.ts', tests: ['driverWsClient'],
    // Removes the no-op error listener, restoring the crash: terminate() on a
    // CONNECTING socket emits an async unhandled 'error' that killed the
    // process mid-shutdown on 2026-08-05 21:25.
    find: "      ws.on('error', () => { /* teardown: outcome irrelevant */ });",
    repl: '',
    what: 'tearing down a CONNECTING socket cannot crash the process' },
  { id: 'probe-silence-honest', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Reverts the probe log to printing the THRESHOLD as if it were the
    // measurement — the constant "240m" that hid the timezone skew for a day.
    find: "      const silence = decision.stalestMs == null\n        ? 'never (no lastSeen on record)'\n        : `${Math.round(decision.stalestMs / 60_000)}m`;",
    repl: "      const silence = `${Math.round(o.config.staleMs / 60_000)}m`;",
    what: 'the probe line reports measured silence, not the threshold' },
  /* ── auto-ping: the engine's first autonomous write ─────────────────── */
  { id: 'autoping-stdout', file: 'src/zwave/autoPing.ts',
    // Reverts to ring-only logging — the state in which 34 real probes were
    // invisible to anyone reading the add-on log, and the feature was diagnosed
    // as a no-op because the evidence sat behind the login gate.
    find: '      o.log(\'info\', nodeId, msg);\n      o.log2?.(msg);',
    repl: '      o.log(\'info\', nodeId, msg);',
    what: 'an autonomous action reaches the SERVER log, not only the event ring' },
  { id: 'autoping-trace', file: 'src/zwave/autoPing.ts',
    // Reverts to the state the feature was FOUND in: enabled, healthy, and
    // logging nothing — so "nothing to do" and "broken" were byte-identical.
    find: '      o.log(\'info\', null, trace);',
    repl: '',
    what: 'the runner states why it did nothing, not only when it acts' },
  { id: 'autoping-trace-throttle', file: 'src/zwave/autoPing.ts',
    // Without the change/heartbeat gate the trace fires every tick and buries
    // the log it exists to clarify.
    find: '    if (changed || t - lastTraceAt >= TRACE_HEARTBEAT_MS) {',
    repl: '    if (true) {',
    what: 'an unchanged decision is not re-logged every tick' },
  { id: 'stale-rate-limit', file: 'src/zwave/autoPing.ts',
    // 36 mains nodes coming due together would fire 36 probes in one second.
    find: '    if (due.length) stale.push(due[0].id);',
    repl: '    for (const d of due) stale.push(d.id);',
    what: 'at most ONE liveness probe per tick' },
  { id: 'stale-cooldown', file: 'src/zwave/autoPing.ts',
    // An unreachable node never refreshes lastSeen, so without the cooldown it
    // stays permanently due and is re-probed on EVERY tick, forever.
    find: '        const last = input.state.lastStaleAt.get(x.id);\n        return last == null || now - last >= config.staleMs;',
    repl: '        return true;',
    what: 'an unreachable node is probed once per window, not every tick' },
  { id: 'stale-skips-dead', file: 'src/zwave/autoPing.ts',
    // A Dead node belongs to the remediation path, which has its own dwell,
    // backoff and attempt cap. Probing it here would bypass all three.
    find: '      .filter((n) => n.status !== NodeStatus.Dead) // the dead path owns those',
    repl: '      .filter(() => true) // the dead path owns those',
    what: 'the liveness probe leaves Dead nodes to the remediation path' },
  { id: 'stale-window', file: 'src/zwave/autoPing.ts',
    // Dropping the age test probes every node on every tick regardless of when
    // it was last heard from — the opposite of a per-node cadence.
    find: '      .filter((x) => x.seen == null || now - x.seen >= config.staleMs)',
    repl: '      .filter(() => true)',
    what: 'only nodes silent past the window get a liveness probe' },
  { id: 'autoping-master-gate', file: 'src/zwave/autoPing.ts',
    // Firing with write actions off would make the add-on's own read-only claim
    // false — the worst kind of defect here.
    find: "  if (!config.writeActions) return { ...base, suppressed: 'write-actions-off' };",
    repl: '',
    what: 'auto-ping obeys write_actions_enabled, not just its own switch' },
  { id: 'autoping-asleep-guard', file: 'src/zwave/autoPing.ts',
    // Dropping the listening test lets it probe sleeping battery devices, which
    // cannot answer before their wakeup interval and lose charge failing.
    find: '  return !n.isController && n.isListening === true;',
    repl: '  return !n.isController;',
    what: 'auto-ping never touches a sleeping or battery node' },
  { id: 'autoping-storm-guard', file: 'src/zwave/autoPing.ts',
    find: "  if (dead.length >= stormLimit) return { ...base, suppressed: 'storm' };",
    repl: '',
    what: 'a mesh-wide outage suppresses auto-ping instead of flooding the controller' },
  { id: 'autoping-boot-window', file: 'src/zwave/autoPing.ts',
    // Every node reads Dead until the first roster poll lands after a restart.
    find: "  if (booting) return { ...base, suppressed: 'boot-window' };",
    repl: '',
    what: 'auto-ping stays quiet in the post-restart window' },
  { id: 'autoping-dwell', file: 'src/zwave/autoPing.ts',
    find: '    if (started == null || now - started < config.afterMs) continue;',
    repl: '    if (started == null) continue;',
    what: 'auto-ping waits its configured dwell before the first probe' },
  { id: 'autoping-attempt-cap', file: 'src/zwave/autoPing.ts',
    find: '    if (tries >= config.maxAttempts) continue;',
    repl: '',
    what: 'auto-ping stops at the attempt cap instead of retrying forever' },
  { id: 'autoping-episode-reset', file: 'src/zwave/autoPing.ts',
    // Without the clear, a node that recovers keeps its exhausted budget and is
    // never helped again.
    find: '      state.deadSince.delete(n.nodeId);\n      state.attempts.delete(n.nodeId);',
    repl: '      state.deadSince.delete(n.nodeId);',
    what: 'recovery clears the attempt budget so a later failure is helped' },
  { id: 'autoping-storm-floor', file: 'src/zwave/autoPing.ts',
    // Without the absolute floor, one dead node on a 4-node mesh reads as a
    // storm and disables the feature where it is cheapest to act.
    find: '  const stormLimit = Math.max(STORM_MIN_NODES, Math.ceil(listeningNodes.length * STORM_FRACTION));',
    repl: '  const stormLimit = Math.ceil(listeningNodes.length * STORM_FRACTION);',
    what: 'a tiny mesh uses the absolute storm floor, not the bare fraction' },
  { id: 'route-churn-lr-guard', file: 'src/zwave/symptoms.ts',
    // Long-Range holds ONE direct link and has no mesh routes to churn; the
    // planner card says a report there is a data quirk. Without the guard the
    // detector contradicts the card it feeds.
    find: '    if (!node.isLongRange) {\n      const churn = windowRouteChanges(samples, now);',
    repl: '    if (true) {\n      const churn = windowRouteChanges(samples, now);',
    what: 'route-churn never fires for a Long-Range node' },
  { id: 'route-churn-threshold', file: 'src/zwave/symptoms.ts',
    // Dropping the threshold to 1 makes ordinary mesh healing look like a fault.
    find: 'const ROUTE_CHURN_WINDOW = 4; // ≥4 LWR changes in the window',
    repl: 'const ROUTE_CHURN_WINDOW = 1; // ≥4 LWR changes in the window',
    what: 'route-churn ignores ordinary re-routing below its threshold' },
  { id: 'ingress-open-redirect', file: 'src/auth.ts',
    // Drops the protocol-relative guard: `//evil.com` then reaches Location and
    // the browser leaves for another origin.
    find: '  if (header.charCodeAt(0) !== 0x2f || header.charCodeAt(1) === 0x2f) return FALLBACK;',
    repl: '  if (header.charCodeAt(0) !== 0x2f) return FALLBACK;',
    what: 'a protocol-relative ingress path cannot become an open redirect' },
  { id: 'ingress-landing-prefix', file: 'src/auth.ts',
    // Reverts to the absolute-path redirect that made the HA sidebar panel show
    // a bare "404: Not Found": the browser drops the ingress prefix and asks HA
    // itself for /console.
    find: '  let end = header.length;\n  while (end > 0 && header.charCodeAt(end - 1) === 0x2f) end -= 1;\n  return end === 0 ? FALLBACK : `${header.slice(0, end)}/console`;',
    repl: '  return `${header}/console`;',
    what: 'the ingress landing redirect keeps the prefix HA proxied it under' },
  { id: 'ws-stop-error-listener', file: 'src/ha/haWsClient.ts',
    // removeAllListeners() strips the 'error' handler; close() on a CONNECTING
    // socket then emits 'error', and an 'error' event with NO listener is
    // re-thrown by EventEmitter as an UNCAUGHT exception on a later tick —
    // outside the surrounding try. CI caught this crashing a release build.
    find: "        this.ws.on('error', () => {});",
    repl: '',
    what: 'stop() absorbs the close-while-connecting error instead of crashing' },
  { id: 'rssi-domain-rule', file: 'src/zwave/health.ts',
    // Reverts the canonical guard to enumerating the DOCUMENTED markers. That is
    // what every call site did before, and it is why a driver-supplied 0 —
    // observed live on 2026-08-02 — rendered as the strongest link on the mesh.
    find: "  return typeof v === 'number' && Number.isFinite(v) && v < 0 ? v : null;",
    repl: "  return typeof v === 'number' && Number.isFinite(v) && !RSSI_SENTINELS.has(v) ? v : null;",
    what: 'a reading is defined by the domain rule (negative dBm), not a marker list' },
  { id: 'telnet-auth-banner', file: 'src/auth/loginPolicy.ts',
    // The startup line announced "(no auth — trusted LAN only)" on EVERY boot,
    // including one with the login gate on and write actions enabled — a false
    // statement about a security control in the place operators check it.
    find: "  return enabled ? '(login required)' : '(no auth — trusted LAN only)';",
    repl: "  return '(no auth — trusted LAN only)';",
    what: 'the telnet startup banner reports the auth posture actually in force' },
  { id: 'topo-hop-sentinel', file: 'src/telnet/screens/topology.ts',
    // The sentinels are POSITIVE (127/126/125), so passing one through does not
    // merely show a wrong number — it ranks a missing reading as the strongest
    // link on the mesh.
    // Re-anchored in v0.29.2: the guard is now the shared rssiReading() domain
    // rule. The old anchor named RSSI_SENTINELS and went MISSING on the refactor.
    find: "  const v = rssiReading(rssi);\n  if (v == null) return c.grey('—');",
    repl: "  const v = rssi == null ? null : rssi;\n  if (v == null) return c.grey('—');",
    what: 'a per-hop sentinel renders as no-data instead of as a level' },
  { id: 'topo-spine-sentinel', file: 'src/telnet/screens/topology.ts',
    // Re-anchored in v0.29.2 (was RSSI_SENTINELS.has(r)).
    find: '    if (rssiReading(r) != null) { // trap 1',
    repl: '    if (r != null) { // trap 1',
    what: 'sentinels are dropped before the repeater aggregate, not folded in' },
  { id: 'topo-spine-stale', file: 'src/telnet/screens/topology.ts',
    find: '    if (n.status === NodeStatus.Dead || n.status === NodeStatus.Unknown) continue; // trap 2',
    repl: '',
    what: "a dead node's last-seen reading stays out of the live aggregate" },
  { id: 'topo-spine-no-rate', file: 'src/telnet/screens/topology.ts',
    // Re-introduces the per-repeater failure rate the review killed. It is not a
    // per-link quantity: timeoutResponse/commandsTX are per-node LIFETIME totals
    // over every route the node has used, so a node routed via two repeaters
    // charges all of its failures to BOTH, and a repeater that joined the route
    // a minute ago inherits everything from before it was involved.
    find: "  return '  ' + c.grey('· ') + parts.join(c.grey(' · '));",
    repl: "  let tmo = 0, tx = 0;\n  for (const n of ctx.data.nodes()) { tmo += n.stats.timeoutResponse ?? 0; tx += n.stats.commandsTX ?? 0; }\n  parts.push(c.grey('tmo ') + `${((tmo / Math.max(1, tx)) * 100).toFixed(1)}%`);\n  return '  ' + c.grey('· ') + parts.join(c.grey(' · '));",
    what: 'the repeater spine publishes no fabricated per-repeater failure rate' },
  { id: 'topo-chain-marker-priority', file: 'src/telnet/screens/topology.ts',
    // The shipped-then-caught inversion: chains OUTER / markers INNER makes the
    // first fit "widest chain, weakest marker", so a fully annotated chain
    // renders beside a bare ⚠ while the columns to NAME the failed pair sit free.
    find: '  for (const marker of markers) {\n    for (const chain of chains) {',
    repl: '  for (const chain of chains) {\n    for (const marker of markers) {',
    what: 'the failed-pair identity outranks the per-hop readings under width pressure' },
  { id: 'topo-hop-unit', file: 'src/telnet/screens/topology.ts',
    // Detail's idiom is raw dBm; this screen has a unit toggle, so importing it
    // unchanged puts two units on one row.
    // The condition must be one TS cannot fold to a constant, or the margin
    // branch becomes provably unreachable and the file stops compiling — which
    // scores INVALID, not a kill. `view.cols > 0` is always true at runtime and
    // opaque at compile time.
    // Re-anchored in v0.29.2: hopReading now renders the VALIDATED value `v`.
    find: "  if (view.signalDisplay === 'dbm') return (neutral ? c.grey : rssiColor(v))(String(v));",
    repl: "  if (view.cols > 0) return (neutral ? c.grey : rssiColor(v))(String(v));",
    what: 'per-hop readings follow the dBm/margin toggle like the rest of the row' },
  { id: 'topo-chain-budget', file: 'src/telnet/screens/topology.ts',
    // Reverts to letting lr() blind-clip the chain, which cuts from the LEFT and
    // leaves half a failed pair — naming an innocent node.
    find: '  const budget = view.cols - visLen(head) - visLen(right) - 1;\n  return lr(head + chainStr(n, lwr, view, noise, stale || routed, budget), right, view.cols);',
    repl: '  return lr(head + chainStr(n, lwr, view, noise, stale || routed, Number.MAX_SAFE_INTEGER), right, view.cols);',
    what: 'the chain degrades in whole tokens instead of being blind-cut by lr()' },
  { id: 'topo-churn-one-gate', file: 'src/telnet/screens/topology.ts',
    // An earlier version of this mutant added a SECOND width test to the row
    // token and survived — correctly. Below WIDE_COLS the reroute map is never
    // populated at all, so the coupling is structural and a redundant gate is a
    // no-op. What can actually break it is dropping the header span while the
    // rows keep their tokens, leaving counts on screen with nothing to qualify
    // them.
    // `if (false)` makes the block unreachable and TS rejects it, scoring
    // INVALID rather than a kill. `view.rows < 0` is false at runtime and
    // opaque at compile time.
    find: "  if (showChurn && churnSpanMs != null) {",
    repl: "  if (showChurn && churnSpanMs != null && view.rows < 0) {",
    what: 'a reroute count never renders without the observation window beside it' },
  { id: 'topo-panel-surplus', file: 'src/telnet/screens/topology.ts',
    // Unconditional disclosure grew the panel by a line at 80x24 and the tree
    // lost a node row to pay for it.
    find: '  if (canDisclose && shown.length < ranked.length) {',
    repl: '  if (shown.length < ranked.length) {',
    what: 'the "+N more" line is surplus-funded and never costs a node row' },
  { id: 'topology-scroll-clamp', file: 'src/telnet/screens/topology.ts',
    find: '    view.topologyScroll = scroll; // clamp + write back (detail.ts\'s pattern)',
    repl: '',
    what: 'the Topology renderer clamps its scroll and writes the real value back' },
  { id: 'chrome-keys-reserve', file: 'src/telnet/chrome.ts',
    find: '  out.push(commandBar(view, o.keys, o.keysReserve ?? 0));',
    repl: '  out.push(commandBar(view, o.keys));',
    what: 'frame() holds back the columns a caller reserved for its own token' },
  { id: 'overview-unknown-field', file: 'src/telnet/screens/overview.ts',
    find: "    ...(unknown > 0 ? [field('UNKNOWN', String(unknown), c.yellow)] : []),",
    repl: '',
    what: 'never-contacted nodes are surfaced in the telemetry strip' },
  { id: 'detail-dead-timeouts', file: 'src/telnet/screens/detail.ts',
    find: '    const tmoColor = dead(n) ? c.grey : timeoutPctColor(pct ?? 0);',
    repl: '    const tmoColor = timeoutPctColor(pct ?? 0);',
    what: 'the dossier greys a dead node\'s stale timeout rate' },

  /* ── round-5: safety + sort-direction regressions found by review ───── */
  { id: 'remedy-anchor', file: 'src/telnet/screens/remedy.ts',
    find: "    view.remedyAnchorId = sorted[cursor] ? symptomKey(sorted[cursor]) : null;",
    repl: '',
    what: 'the Remedy cursor follows the SYMPTOM across an engine re-sort, not the slot' },
  { id: 'remedy-anchor-resolve', file: 'src/telnet/screens/remedy.ts',
    find: "    const cursor = anchored >= 0\n      ? anchored\n      : Math.max(0, Math.min(view.remedyCursor ?? 0, sorted.length - 1));",
    repl: '    const cursor = Math.max(0, Math.min(view.remedyCursor ?? 0, sorted.length - 1));',
    what: 'the renderer resolves the Remedy cursor by anchor before falling back to the index' },
  { id: 'heatmap-cell-ascending', file: 'src/telnet/screens/heatmap.ts',
    find: '      return a.margin - b.margin;', repl: '      return b.margin - a.margin;',
    what: 'the weakest cell survives overflow truncation (renderCells cuts the TAIL)' },

  /* ── round-5 semantic fixes ───────────────────────────────────────── */
  { id: 'detail-hop-stale', file: 'src/telnet/screens/detail.ts',
    find: '    const hopColor = stale ? c.grey : rssiColor(hop!);',
    repl: '    const hopColor = rssiColor(hop!);',
    what: "a dead node's PER-HOP route readings are greyed like the rest of the row" },
  { id: 'detail-nominal-claim', file: 'src/telnet/screens/detail.ts',
    find: "    if (state === 'unknown') return c.grey(' no measurements yet — nothing to assess');",
    repl: '',
    what: 'a never-contacted node is not reported as "RF health nominal"' },
  { id: 'detail-rtt-rounding', file: 'src/telnet/screens/detail.ts',
    find: '    const rttShown = s.rtt == null ? null : Math.round(s.rtt);',
    repl: '    const rttShown = s.rtt == null ? null : s.rtt;',
    what: 'the dossier bands the DISPLAYED rtt, matching the Overview' },
  { id: 'menu-refusal-reason', file: 'src/telnet/actionsCatalog.ts',
    find: "        ? (ctx.cursorScreen\n            ? 'the item under the cursor is not tied to a single node'\n            : 'select a node first (Overview/Detail)')",
    repl: "        ? 'select a node first (Overview/Detail)'",
    what: 'the menu gives a reason that is TRUE for a cursor-bearing screen' },
  { id: 'notice-detail-cleared', file: 'src/telnet/session.ts',
    find: "    // to a different one. (This edit was clobbered once by a concurrent harness\n    // restore — see the single-runner lock in scripts/mutation-check.mjs.)\n    this.actionNoticeDetail = null;",
    repl: '',
    // NOT equivalent after all. I labelled it so on the reasoning that all six
    // notice sites already settle the detail — but the invariant test scans the
    // source, and removing this clear makes resetActionState's own assignment
    // orphaned, so the test fails. The harness's RELABEL state caught the wrong
    // label, which is exactly what that state is for.
    what: 'a stale notice detail line cannot reappear under the next notice' },
  { id: 'login-narrow', file: 'src/telnet/screens/login.ts',
    find: '  if (o.cols < 20) return narrowLogin(o);\n  const W = o.cols;',
    repl: '  const W = Math.max(20, o.cols);',
    what: 'renderLogin never emits a line wider than the terminal' },
  { id: 'margin-w-flag', file: 'src/telnet/bands.ts',
    find: '  if (db >= WEAK_MARGIN_DB) return c.yellow;\n  if (db >= Math.floor(WEAK_MARGIN_DB / 2)) return c.red;',
    repl: '  if (db >= 10) return c.yellow;\n  if (db >= 5) return c.red;',
    what: 'a red margin always implies the node carries a W flag' },

  /* ── round-5 coverage sweep: behaviours with no entry ─────────────── */
  { id: 'cmdbar-shed-front', file: 'src/telnet/chrome.ts',
    find: '    dropped.add(survivors.shift()!);', repl: '    dropped.add(survivors.pop()!);',
    what: 'the protected caps shed from the FRONT, so [Q] EXIT survives last' },
  { id: 'masthead-link-state', file: 'src/telnet/chrome.ts',
    find: "  return c.red('●') + ' ' + c.red('OFFLINE');",
    repl: "  return c.green('●') + ' ' + c.green('ONLINE');",
    what: 'the masthead reports the link state it was given' },

  /* ── v0.24.1: found by LIVE verification, not by any fixture ────────── */
  { id: 'margin-fractional-floor', file: 'src/telnet/screens/overview.ts',
    // Re-anchored in v0.29.2 (overview now bands the VALIDATED rssiV).
    find: '    const margin = Math.round(rssiV - noise);',
    repl: '    const margin = rssiV - noise;',
    what: 'a fractional noise floor never truncates a margin into a unitless number' },

  /* ── v0.24.3 security posture ──────────────────────────────────────── */
  { id: 'ingress-pin', file: 'src/auth.ts',
    find: '  if (supervisorIps.size === 0) return false; // unresolved ⇒ trust nothing\n  return supervisorIps.has(normalizeIp(ip));',
    repl: "  return /^172\\.30\\.3[23]\\.\\d{1,3}$/.test(normalizeIp(ip));",
    what: 'ingress trust is pinned to the Supervisor, not the whole sibling-add-on bridge' },
  { id: 'blank-password', file: 'src/auth/loginPolicy.ts',
    find: '      if (username.length > 0 && password.length > 0) out.push({ username, password });',
    repl: '      if (username.length > 0) out.push({ username, password });',
    what: 'a blank-password user row is rejected instead of authenticating on ""' },

  /* ── v0.28 review round 1 ─────────────────────────────────────────── */
  { id: 'diurnal-absolute-scale', file: 'src/telnet/screens/interference.ts',
    find: '        max: HEAT_MAX * 100,',
    repl: '        max: Math.max(...rates.map((r) => r ?? 0), 0.1),',
    what: 'the diurnal chart uses the ABSOLUTE HEAT_MAX scale, never normalized-to-peak' },
  { id: 'diurnal-null-not-zero', file: 'src/telnet/screens/interference.ts',
    find: '      const rates = iv.diurnal.map((d) => (d.rate == null ? null : d.rate * 100));',
    repl: '      const rates = iv.diurnal.map((d) => (d.rate == null ? 0 : d.rate * 100));',
    what: 'an UNRATED hour draws the no-data dot, not a measured 0% bar' },
  { id: 'chart-null-gap', file: 'src/telnet/gauges.ts',
    find: "        cells += fromBottom === 0 ? '·' : ' ';",
    repl: "        cells += ' ';",
    what: 'chartRows marks a null sample on the baseline so it reads as no-data' },
  { id: 'ctrl-surplus-rebuild', file: 'src/telnet/screens/controller.ts',
    find: '  const baseline = 26 + (rebuilding ? 5 : 0);',
    repl: '  const baseline = 26;',
    what: 'the surplus baseline counts the conditional REBUILD block, so an addition cannot evict existing content' },
  /* ── v0.28 charts + surplus-funded telemetry ──────────────────────── */
  { id: 'chart-draws-window', file: 'src/telnet/gauges.ts',
    find: '  const lo = opts.min ?? Math.min(...drawn);',
    repl: '  const lo = opts.min ?? Math.min(...values.filter((v) => v != null));',
    what: 'chartRows auto-scales over what is DRAWN, not over samples that scrolled off' },
  { id: 'iv-chart-surplus-gate', file: 'src/telnet/screens/interference.ts',
    find: '      const chartH = surplus >= 12 ? 6 : surplus >= 6 ? 4 : 0;',
    repl: '      const chartH = 6;',
    what: 'the noise chart is surplus-funded — it never appears on a short frame' },
  { id: 'ctrl-rates-surplus-gate', file: 'src/telnet/screens/controller.ts',
    find: '    ...(surplus >= 4 ? [serialRateBlock(ctx, W)] : []),',
    repl: '    ...(serialRateBlock(ctx, W) ? [serialRateBlock(ctx, W)] : []),',
    what: 'RECENT RATES is surplus-funded — an 80x24 frame is unchanged' },
  { id: 'ctrl-mesh-scope', file: 'src/telnet/screens/controller.ts',
    find: '  const mesh = ctx.data.symptoms().filter((s) => s.nodeId == null);',
    repl: '  const mesh = ctx.data.symptoms();',
    what: 'ACTIVE MESH EVENTS shows only NETWORK-scoped symptoms, not per-node ones' },
  /* ── v0.27 review round 1 ─────────────────────────────────────────── */
  { id: 'cfg-params-column-width', file: 'src/telnet/screens/detail.ts',
    find: '      for (const line of columnize(cfg.params, (prm, w) => configParamRow(prm, w), inner)) {',
    repl: '      for (const line of columnize(cfg.params, (prm) => configParamRow(prm, inner), inner)) {',
    what: 'config parameter rows are rendered at their COLUMN width, so values survive' },
  { id: 'columnize-min-col', file: 'src/telnet/screens/detail.ts',
    find: '  const MIN_COL = 56;',
    repl: '  const MIN_COL = 34;',
    what: 'the 80-col terminal stays single-column instead of collapsing names to stubs' },
  { id: 'heatmap-disclosure-budget', file: 'src/zwave/../telnet/screens/heatmap.ts',
    find: '  while (per > 0 && areas.reduce((n, a) => n + Math.min(a.cells.length, per), 0) + mightDisclose(per) > surplus) {',
    repl: '  while (false as boolean) {',
    what: 'the "+N more devices" row is budgeted, so the heatmap never overflows its frame' },
  { id: 'rollup-one-score-colour', file: 'src/telnet/screens/overview.ts',
    find: '      .map((g) => scoreColor(GRADE_FLOOR[g])(`${g} ${grades[g]}`))',
    repl: '      .map((g) => (g === \'D\' ? c.red : scoreColor(GRADE_FLOOR[g]))(`${g} ${grades[g]}`))',
    what: 'the roll-up grades through the roster\'s scoreColor, not a second mapping' },
  /* ── v0.26 review round 2 ─────────────────────────────────────────── */
  { id: 'controller-before-nevermeasured', file: 'src/zwave/health.ts',
    find: '  if (node.isController && (node.status === NodeStatus.Alive || node.status === NodeStatus.Awake)) {',
    repl: '  if (false as boolean) {',
    what: 'the controller branch precedes the never-measured gate (node 1 is A/100, not F/unknown)' },
  { id: 'rtt-no-recency', file: 'src/zwave/symptoms.ts',
    find: '      const b = !!(norm?.ready && obs != null && obs.rtt > norm.median + RTT_Z * norm.scale);',
    repl: '      const b = !!(norm?.ready && obs != null && obs.rtt > norm.median + RTT_Z * norm.scale && now - obs.t <= DWELL_MS);',
    what: 'rtt-degraded still fires for a node that communicates less often than the dwell' },
  { id: 's2-lane-null', file: 'src/zwave/zwaveData.ts',
    find: '      const s2Resyncs = this.driverWs?.s2LaneLive() ? (this.s2Accum.get(n.nodeId) ?? 0) : null;',
    repl: '      const s2Resyncs = this.s2Accum.get(n.nodeId) ?? 0;',
    what: 'a dark S2 log lane records UNKNOWN, not a fabricated zero' },
  { id: 's2-outcome-lane-gate', file: 'src/zwave/outcomes.ts',
    find: "      if (after.s2Known < MIN_LIVE) return 'unverifiable'; // lane dark ⇒ unknown, never \"improved\"",
    repl: '',
    what: 'a switched-off S2 lane cannot score an `improved` recovery verdict' },
  { id: 's2-no-double-count', file: 'src/zwave/driverWsClient.ts',
    find: "  if (msg.includes('re-transmission with SPAN extension')) return null;",
    repl: '',
    what: 'one failed S2 transmission counts once, not twice (retry + drop lines)' },
  { id: 'epoch-standdown-all', file: 'src/zwave/zwaveData.ts',
    find: '      if (this.superseded(epoch)) { await standDown(); return; }\n      void this.fetchEntityStates();',
    repl: '      void this.fetchEntityStates();',
    what: 'a superseded run releases the controller + per-node feeds it created, not just the activity feed' },
  { id: 'outcomes-dirty-gate', file: 'src/zwave/outcomes.ts',
    find: '      if (!dirty) return; // nothing learned since the last write (v0.26)',
    repl: '',
    what: 'an idle outcome store does not rewrite outcomes.json every flush tick' },
  { id: 'flush-cadence-config', file: 'src/config.ts',
    find: '  historyFlushMs: Number(process.env.HISTORY_FLUSH_MS ?? 120_000),',
    repl: '  historyFlushMs: Number(process.env.HISTORY_FLUSH_MS ?? 30_000),',
    what: 'the SD-wear flush cadence is raised at the layer production actually reads' },
  /* ── v0.26: S2-resync watch + assessment fix wave ─────────────────── */
  { id: 's2-matcher', file: 'src/zwave/driverWsClient.ts',
    find: "  if (msg.includes('SPAN extension')) return nodeId;", repl: '',
    what: 'the SPAN-resync log line is attributed to its node (the stock-level S2 family)' },
  { id: 's2-threshold', file: 'src/zwave/symptoms.ts',
    find: 'const S2_ABS = 12;', repl: 'const S2_ABS = 999999;',
    what: 'an S2 resync storm above the absolute threshold surfaces as a symptom' },
  { id: 's2-recency', file: 'src/zwave/symptoms.ts',
    find: 'const b = s2 != null && s2 >= S2_ABS &&\n        hadRecent(samples, now, S2_RECENT_MS, (s) => s.dS2Resync ?? 0);',
    repl: 'const b = s2 != null && s2 >= S2_ABS;',
    what: 'a finished S2 burst de-asserts instead of maturing the dwell off stale evidence' },
  { id: 'deadflap-recency', file: 'src/zwave/symptoms.ts',
    find: 'const b = flaps >= FLAPS_WINDOW && hadRecent(samples, now, DWELL_MS, (s) => s.dFlaps);',
    repl: 'const b = flaps >= FLAPS_WINDOW;',
    what: 'one transient flap burst cannot mature a "persistent" dead-flap symptom' },
  { id: 'wilson-gate', file: 'src/zwave/outcomes.ts',
    find: 'const beats = base != null && wilsonLower(ok, n) >= base + cfg.minEffect;',
    repl: 'const beats = base != null && n > 0 && ok / n >= base + cfg.minEffect;',
    what: 'the "✓ helped" advisory is gated on the Wilson lower bound, not the raw n=4 rate' },
  { id: 'never-measured', file: 'src/zwave/health.ts',
    find: '  if (!stats || neverMeasured) {', repl: '  if (!stats) {',
    what: 'a stats-less Alive node reads unknown, not a fabricated 84/B "ok"' },
  { id: 'bandfrac-floor', file: 'src/telnet/screens/overview.ts',
    find: '  return Math.max(0.02, clamp01(f));', repl: '  return clamp01(f);',
    what: 'a present-but-weak signal always lights ≥1 bar (never renders as absent)' },
  { id: 'backoff-stable', file: 'src/ha/haWsClient.ts',
    find: '    this.stableTimer = setTimeout(() => {\n      this.stableTimer = null;\n      if (this.authenticated) this.reconnectAttempts = 0;\n    }, STABLE_AFTER_MS);\n    this.stableTimer.unref?.();',
    repl: '    this.reconnectAttempts = 0;',
    what: 'a flapping Core does not earn a backoff reset on auth_ok alone' },
  { id: 'lastseen-replay', file: 'src/zwave/zwaveData.ts',
    find: '    const moved =\n      prev != null &&\n      (prev.commandsTX !== counters.tx ||\n        prev.commandsRX !== counters.rx ||\n        prev.commandsDroppedTX !== counters.dropTx ||\n        prev.commandsDroppedRX !== counters.dropRx ||\n        prev.timeoutResponse !== counters.timeout);',
    repl: '    const moved = true;',
    what: 'a subscribe replay does not fabricate "seen 0s ago" for a silent node' },
  { id: 'epoch-guard', file: 'src/zwave/zwaveData.ts',
    // The INNER guard (inside subscribeActivityEvents). The outer one, in
    // subscribeStatistics, only helps a run superseded BEFORE the handoff; a
    // run parked inside the subscribe itself wakes on the new connection and
    // needs this release. zwaveDataChurn.test.ts pins the live-sub count.
    find: '        void sub.unsubscribe().catch(() => {});',
    repl: '',
    what: 'a subscribe run superseded mid-flight RELEASES its zombie activity feed' },
  { id: 'ctrl-misspelled-key', file: 'src/zwave/zwaveData.ts',
    find: '  const tRes = num(e.timout_response) ?? num(e.timeout_response);',
    repl: '  const tRes = num(e.timeout_response);',
    what: "the misspelled 'timout_response' key HA actually sends is accepted" },
  { id: 'ctrl-reject-malformed', file: 'src/zwave/zwaveData.ts',
    find: '  const msgTx = num(e.messages_tx);\n  const msgRx = num(e.messages_rx);',
    repl: '  const msgTx = num(e.messages_tx) ?? 0;\n  const msgRx = num(e.messages_rx) ?? 0;',
    what: 'a malformed controller event is rejected, never coerced to zeros' },
  { id: 'history-dirty-gate', file: 'src/zwave/zwaveData.ts',
    find: '        if (!this.histDirty) return;',
    repl: '',
    what: 'an unchanged history ring is not rewritten to the SD card every flush tick' },
  /* ── v0.24.4 posture audit ─────────────────────────────────────────── */
  { id: 'c1-backstop', file: 'src/telnet/ansi.ts',
    find: "const CTL_RE = /[\\x00-\\x1f\\x7f-\\x9f]/g;\nconst IS_CTL = /[\\x00-\\x1f\\x7f-\\x9f]/;",
    repl: "const CTL_RE = /[\\x00-\\x1f\\x7f]/g;\nconst IS_CTL = /[\\x00-\\x1f\\x7f]/;",
    what: 'the C1 block (8-bit CSI/OSC, which xterm.js executes) cannot reach the wire' },
  { id: 'errmsg-sanitized', file: 'src/zwave/zwaveData.ts',
    find: '  return sanitizeEventText(e instanceof Error ? e.message : String(e));',
    repl: '  return e instanceof Error ? e.message : String(e);',
    what: 'HA/device error text is sanitized at the errMsg chokepoint' },
  { id: 'backoff-reserve', file: 'src/telnet/session.ts',
    find: '    this.auth.registerFailure(this.peer);\n\n    let ok = false;',
    repl: '    let ok = false;',
    what: 'the login attempt is charged BEFORE the async verify, so concurrent submits contend' },
  { id: 'telnet-per-ip', file: 'src/telnet/server.ts',
    find: '    if (sameIp >= MAX_CONNS_PER_IP) {',
    repl: '    if (false as boolean) {',
    what: 'one host cannot take every telnet slot' },
  { id: 'idle-sweep', file: 'src/telnet/server.ts',
    find: '      if (conn.lastRxAt > cutoff) continue;',
    repl: '      if (true) continue;',
    what: 'a socket that has RECEIVED nothing is reclaimed (v0.24.4 used socket.setTimeout, which a WRITE resets — the 1 Hz redraw refreshed it forever and the timeout never fired)' },

  { id: 'idle-rx-stamp', file: 'src/telnet/server.ts',
    find: "    socket.on('data', (d) => { conn.lastRxAt = Date.now(); onData(conn, d as Buffer); });",
    repl: "    socket.on('data', (d) => { onData(conn, d as Buffer); });",
    what: 'inbound data refreshes the idle clock, so an ACTIVE operator is never evicted' },

  { id: 'telnet-keepalive', file: 'src/telnet/server.ts',
    find: '    socket.setKeepAlive(true, keepAliveMs);',
    repl: '    void keepAliveMs;',
    what: 'accepted sockets get TCP keepalive, so a half-open peer that never sends a FIN is detected' },

  { id: 'actions-sanitize', file: 'src/zwave/zwaveActions.ts',
    find: '      const msg = sanitizeEventText(errMsg(e));',
    repl: '      const msg = errMsg(e);',
    what: 'the action-result card sanitizes whatever an HA service call threw' },

  { id: 'sdkversion-sanitize', file: 'src/zwave/zwaveData.ts',
    find: '    sdkVersion: sanitizeStrOrNull(raw.sdk_version),',
    repl: '    sdkVersion: (raw.sdk_version == null ? null : String(raw.sdk_version)),',
    what: 'driver-sourced controller version strings are sanitized before the CONTROLLER screen renders them' },

  { id: 'logconfig-consumed', file: 'src/index.ts',
    find: 'const log = createLogger(config.logLevel);',
    repl: "const log = createLogger('info');",
    what: 'the log_level option actually reaches the logger (it was dead config through v0.24.4)' },

  { id: 'writetoken-gone', file: 'src/auth.ts',
    find: '  return { sameOrigins, corsOriginCallback };',
    // Re-introduce the identifier in a COMPILING way — the source-scan test
    // asserts auth.ts no longer mentions it anywhere outside the docstring.
    repl: '  const tokenEquals = 1;\n  void tokenEquals;\n  return { sameOrigins, corsOriginCallback };',
    what: 'the dead write-token gate stays removed (it authorised nothing while persisting a secret)' },

  /* ── known-EQUIVALENT: cannot be killed under the current design ───── */
  { id: 'menu-network-target', file: 'src/telnet/session.ts',
    find: "    this.menuTarget = scope === 'device' ? (this.actionTargetNode() ?? null) : null;",
    repl: '    this.menuTarget = this.actionTargetNode() ?? null;',
    what: 'a network menu never inherits a device target',
    equivalent: true,
    why: 'no network-scoped screen has a node cursor, so actionTargetNode() is already undefined there. The invariant is pinned in sessionActions.test.ts.' },
  { id: 'menu-reopen-scope', file: 'src/telnet/session.ts',
    find: '    const scope = reopen ?? this.menuScopeForScreen();',
    repl: '    const scope = this.menuScopeForScreen();',
    what: 'cancelling a confirm returns to the menu you were in',
    equivalent: true,
    why: 'the modals swallow every key, so the screen cannot change behind them and re-deriving agrees. The swallow is pinned in sessionActions.test.ts.' },
];

const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const run = MUTANTS.filter((m) => !only || m.id.includes(only));

// ── #41: a mistyped filter must not report a clean run over zero entries.
if (only && run.length === 0) {
  console.error(`No entry matches --only=${only}. Known ids:\n  ` +
    MUTANTS.map((m) => m.id).join('\n  '));
  process.exit(2);
}

/**
 * Does the mutated tree still COMPILE?
 *
 * A mutant that breaks the build makes every test file fail to load, and the
 * suite goes red for a reason that has nothing to do with the behaviour the
 * entry names. Counting that as "killed" is exactly the vacuous-verification
 * this harness exists to prevent — and it happened: the `lr-keep-right` repl
 * injected an unmatched brace at end-of-file, so it "killed" without any test
 * ever asserting anything about lr(). A mutant must be VALID CODE that is
 * caught by an ASSERTION, or it proves nothing.
 */
// tsc is invoked DIRECTLY rather than through `npm run typecheck`: the npm
// wrapper costs ~0.16s of pure process startup (0.34s vs 0.18s measured), and
// this runs once per mutant — ~24s of the run spent launching a package manager
// to launch a compiler. The flags are kept identical to the npm script so the
// harness and CI check exactly the same thing.
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');
const compiles = () => {
  try {
    execFileSync(TSC, ['--noEmit', '-p', 'tsconfig.test.json'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const TEST_DIR = join(ROOT, 'test');
const allTestFiles = () =>
  readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).sort().map((f) => join(TEST_DIR, f));

/**
 * Run an explicit set of test files.
 *
 * Returns `null` when green, or the set of test files that reported a failure
 * when red. Naming the catcher is what makes a kill-fast mapping miss
 * ACTIONABLE: the run can then print "not caught by X — actually caught by Y"
 * instead of leaving the table to be fixed by guesswork.
 */
const testsFail = (files) => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--test', ...files],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return null; // exit 0 → green
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // Failure stacks point back into the test file that raised them.
    const seen = [...out.matchAll(/test\/([A-Za-z0-9_.-]+)\.test\.ts/g)].map((m) => m[1]);
    return [...new Set(seen)];
  }
};

const suiteFails = () => testsFail(allTestFiles()) != null;

/**
 * KILL-FAST: the cheap test files that most plausibly cover a mutant.
 *
 * A kill is a kill no matter WHICH test catches it, so a red result from a
 * single file is already a final verdict and the other 36 files add nothing. A
 * GREEN result proves nothing, so survival still has to face the whole suite —
 * the `SURVIVED` verdict is never reached by a shortcut.
 *
 * This is a pure latency optimisation with no effect on any verdict. It matters
 * because the suite is startup-bound, not compute-bound: one file runs in
 * ~0.18s while all 37 take ~13s, since each pays the tsx/TypeScript loader cost
 * again. With 151 of 153 mutants killed, nearly every mutant takes the fast
 * path and the full run drops from ~33 minutes to ~2.
 *
 * The mapping is a heuristic (source basename → same-named test file, or an
 * explicit `tests: [...]` on the mutant). A wrong guess costs only time, and
 * the run REPORTS every miss so the mapping can be tightened rather than
 * silently decaying back to full-suite speed.
 */
/**
 * Source file → the test files that actually cover it.
 *
 * The default guess is "same basename", which holds for the engine modules
 * (evidenceStore.ts → evidenceStore.test.ts) but not for the TUI, whose tests
 * are named after what they assert rather than what they import — the screens
 * are covered by renderContract/renderHonesty plus a per-screen file. Without
 * this table 81 of 153 mutants fall straight through to the full suite.
 *
 * A wrong or missing entry costs TIME, never correctness: the full suite still
 * runs whenever the targeted files come back green, and every miss is printed
 * at the end so the table can be corrected instead of quietly rotting.
 */
/**
 * Per-mutant overrides — the test file that PROVABLY catches each one.
 *
 * Harvested, not guessed: the run reports "tried [X] → actually caught by [Y]"
 * for every kill-fast miss, and these are those answers written back. The
 * surprises are the useful part — most of the TUI's safety mutants are caught
 * by `renderHonesty` (a cross-screen invariant suite) and the whole telnet/
 * sanitisation family by `ingressTrust`, which despite its name is the trust-
 * BOUNDARY suite: blank passwords, C1 control bytes, per-host socket caps,
 * idle reclamation. Neither is discoverable from a file name.
 *
 * Stale entries are self-correcting: a wrong name simply fails to catch, the
 * full suite runs, and the miss report names the new catcher.
 */
const MUTANT_TESTS = {
  'litbars-floor': ['renderHonesty'],
  'meter-endpoints': ['renderHonesty'],
  'spark-window': ['renderHonesty'],
  'topology-scroll-key': ['renderHonesty'],
  'remedy-cursor-key': ['renderHonesty'],
  'key-scope-o': ['renderHonesty'],
  'key-scope-slash': ['renderHonesty'],
  'esc-clears-filter': ['renderHonesty'],
  'log-sanitize': ['renderHonesty'],
  'login-exact-rows': ['renderHonesty'],
  'log-keycap-priority': ['renderHonesty'],
  'remedy-anchor': ['sessionActions'],
  'remedy-anchor-resolve': ['sessionActions'],
  'menu-refusal-reason': ['sessionActions'],
  'login-narrow': ['renderHonesty'],
  'blank-password': ['ingressTrust'],
  'chart-null-gap': ['renderHonesty'],
  'chart-draws-window': ['renderHonesty'],
  'c1-backstop': ['ingressTrust'],
  'errmsg-sanitized': ['ingressTrust'],
  'backoff-reserve': ['ingressTrust'],
  'telnet-per-ip': ['ingressTrust'],
  'idle-sweep': ['ingressTrust'],
  'idle-rx-stamp': ['ingressTrust'],
  'telnet-keepalive': ['ingressTrust'],
  'actions-sanitize': ['ingressTrust'],
  'sdkversion-sanitize': ['ingressTrust'],
};

const SOURCE_TESTS = {
  'src/telnet/screens/topology.ts': ['topologyRoutes', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/controller.ts': ['controllerHeatmapScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/heatmap.ts': ['controllerHeatmapScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/detail.ts': ['detailScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/overview.ts': ['overviewScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/remedy.ts': ['remedyScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/login.ts': ['loginPolicy', 'renderContract'],
  'src/telnet/screens/interference.ts': ['interferenceScreen', 'renderContract', 'renderHonesty'],
  'src/telnet/screens/log.ts': ['logScreen', 'logFilter', 'logNav', 'renderContract'],
  'src/telnet/screens/actionsMenu.ts': ['actionsMenuScreen', 'actionsCatalog'],
  'src/telnet/session.ts': ['sessionActions', 'input', 'renderContract'],
  'src/telnet/server.ts': ['sessionActions', 'renderContract'],
  'src/telnet/ansi.ts': ['chrome', 'gauges', 'renderHonesty'],
  'src/telnet/bands.ts': ['gauges', 'renderHonesty', 'chrome'],
  'src/telnet/chrome.ts': ['chrome', 'renderContract', 'renderHonesty'],
  'src/auth.ts': ['ingressTrust', 'loginPolicy'],
  'src/index.ts': ['configContract'],
  'src/config.ts': ['configContract'],
  'src/zwave/zwaveData.ts': ['zwaveData', 'zwaveDataChurn', 'evidenceStore'],
};

const fastTestsFor = (m) => {
  // Normalised: at least one mutant addresses its file through a `..` segment
  // (src/zwave/../telnet/…), which would miss the table on a raw string match.
  const key = normalize(m.file);
  const names = (Array.isArray(m.tests) && m.tests.length ? m.tests : null)
    ?? MUTANT_TESTS[m.id]
    ?? SOURCE_TESTS[key]
    ?? [basename(key).replace(/\.tsx?$/, '')];
  return names.map((n) => join(TEST_DIR, `${n}.test.ts`)).filter((p) => existsSync(p));
};

// BASELINE FIRST. Every verdict below is "the suite went red BECAUSE of the
// mutation" — which is only true if it was green to begin with. On an already
// red suite every entry would report `killed` and the run would exit 0, making
// the published count compatible with a suite that never passes.
process.stdout.write('baseline: ');
if (!compiles()) {
  console.log('TYPECHECK FAILS — fix the tree before running the harness.');
  process.exit(2);
}
if (suiteFails()) {
  console.log('SUITE IS ALREADY RED — every mutant would falsely report "killed".');
  process.exit(2);
}
console.log('green\n');

let killed = 0;
const survived = [];
const equivalent = [];
const missing = [];
const invalid = [];
const relabel = [];
const mappingMisses = []; // kill-fast guessed wrong; only a speed signal, never a verdict

// A mutant left applied is worse than no run at all: it looks like a real
// regression, and if committed it SHIPS one. Three layers, because the first
// two are not enough:
//
//   1. `finally` — covers a normal throw.
//   2. signal handlers — cover Ctrl-C and SIGTERM.
//   3. a SIDECAR FILE — covers SIGKILL, which no handler can catch. A harness
//      killed by a wrapper's hard timeout (this happened, and left a mutation
//      applied in the working tree) leaves the sidecar behind; the next run
//      finds it and restores before doing anything else.
//
// The sidecar is written BEFORE the mutation and removed after the restore, so
// its mere existence means "a mutation may be applied right now".
const SIDECAR = join(ROOT, '.mutation-check-pending.json');

// ── SINGLE RUNNER. Two concurrent harnesses race on the same files: one
// restores what the other just mutated, and the survivor's tree is corrupt.
// (This happened — a second run's recovery clobbered an in-flight mutation and
// left the suite red.) The sidecar records the owning PID; a live owner means
// refuse, a dead one means recover.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const recoverStale = () => {
  if (!existsSync(SIDECAR)) return;
  try {
    const { pid } = JSON.parse(readFileSync(SIDECAR, 'utf8'));
    if (pid && pid !== process.pid && alive(pid)) {
      console.error(`Another mutation-check (pid ${pid}) is running. Wait for it, or kill it first.`);
      console.error('Two runners corrupt each other\'s restores.');
      process.exit(2);
    }
  } catch { /* fall through to the recovery below */ }
  try {
    const { path, text, id } = JSON.parse(readFileSync(SIDECAR, 'utf8'));
    writeFileSync(path, text);
    console.error(`RECOVERED  a previous run was killed while "${id}" was applied — ${path} restored.\n`);
  } catch (e) {
    console.error(`Could not auto-recover ${SIDECAR}: ${String(e)}`);
    console.error('Restore the file it names by hand before trusting any result.');
    process.exit(2);
  }
  rmSync(SIDECAR, { force: true });
};
recoverStale();

// NOTE: there are deliberately NO signal handlers here. The mutation loop is
// fully synchronous (execFileSync blocks the event loop for the whole run), so
// a SIGINT/SIGTERM handler could never be dispatched — it would only LOOK like
// protection. The sidecar above is the real mechanism, and it covers SIGKILL
// too, which no handler can catch.
/** @type {{path: string, text: string} | null} */
let pending = null;
const restore = () => {
  if (pending) {
    writeFileSync(pending.path, pending.text);
    pending = null;
  }
  rmSync(SIDECAR, { force: true });
};

for (const m of run) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.find)) {
    missing.push(m);
    console.log(`MISSING   ${m.id.padEnd(26)} — anchor not found in ${m.file}`);
    continue;
  }
  // Sidecar FIRST: if we are killed between here and the restore, the next run
  // finds this and puts the file back.
  pending = { path, text: original };
  writeFileSync(SIDECAR, JSON.stringify({ id: m.id, path, text: original, pid: process.pid }));
  writeFileSync(path, original.replace(m.find, m.repl));
  let red;
  let valid;
  let missedBy = null; // fast set that failed to catch a mutant the full suite killed
  try {
    valid = compiles();
    if (!valid) {
      red = false;
    } else {
      // Cheap targeted files first — a red here is already a kill.
      const fast = fastTestsFor(m);
      red = fast.length > 0 && testsFail(fast) != null;
      // Green (or nothing to run) proves nothing: SURVIVED must face everything.
      if (!red) {
        const caught = testsFail(allTestFiles());
        red = caught != null;
        if (red && fast.length > 0) {
          missedBy = { tried: fast.map((f) => basename(f, '.test.ts')).join(', '), caughtBy: caught.join(', ') };
        }
      }
    }
  } finally {
    restore();
  }
  if (missedBy) mappingMisses.push({ id: m.id, ...missedBy });
  if (!valid) {
    invalid.push(m);
    console.log(`INVALID   ${m.id.padEnd(26)} — the mutant does not compile; a broken build is not a kill`);
    continue;
  }
  if (red && m.equivalent) {
    // Good news, but the file is now WRONG: something began covering this, so
    // the `equivalent` label and its `why` are stale and must be removed.
    relabel.push(m);
    console.log(`RELABEL   ${m.id.padEnd(26)} — killed, but still marked equivalent; drop the label`);
  } else if (red) {
    killed++;
    console.log(`killed    ${m.id.padEnd(26)} — ${m.what}`);
  } else if (m.equivalent) {
    equivalent.push(m);
    console.log(`EQUIVALENT ${m.id.padEnd(25)} — ${m.why}`);
  } else {
    survived.push(m);
    console.log(`SURVIVED  ${m.id.padEnd(26)} — UNTESTED: ${m.what}`);
  }
}

console.log(`\n${killed} killed · ${survived.length} survived · ${equivalent.length} equivalent · ` +
  `${missing.length} missing · ${invalid.length} invalid · ${relabel.length} relabel`);
if (mappingMisses.length) {
  // NOT a failure — every verdict above is unchanged. It only means these
  // mutants paid for the full suite because their targeted file did not catch
  // them. Add a `tests: [...]` to each and the run gets its speed back.
  console.log(`\n${mappingMisses.length} kill-fast mapping miss(es) — verdicts unaffected, speed lost:`);
  for (const x of mappingMisses) {
    console.log(`  ${x.id.padEnd(26)} tried [${x.tried}] → actually caught by [${x.caughtBy}]`);
  }
}
if (survived.length || missing.length || invalid.length || relabel.length) {
  console.log('\nA SURVIVED entry is a fix no test protects. A MISSING entry means this');
  console.log('file has drifted from the code. An INVALID entry is a mutant that does not');
  console.log('compile — it would be counted as killed while proving nothing. All three');
  console.log('are failures, as is RELABEL (an `equivalent` entry that is now');
  console.log('actually covered): do not claim the release is mutation-checked until clean.');
  process.exit(1);
}
