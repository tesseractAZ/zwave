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
    find: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE', 2], ['⏎', 'DEVICE', 1], ['M', 'ACK', 5], ['D', 'DATE', 4],\n      ['O', 'ERRORS', 3], ['1-9', 'SCREENS'], ['Q', 'CLOSE'],",
    repl: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE'], ['⏎', 'DEVICE'], ['M', 'ACK'], ['D', 'DATE'],\n      ['O', 'ERRORS'], ['1-9', 'SCREENS'], ['Q', 'CLOSE'],",
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
    find: "      return side === 'before' ? w.routeChanges >= 1 && w.routeKnown >= 1 : w.routeKnown >= MIN_LIVE && w.freshN >= MIN_LIVE;",
    repl: "      return side === 'before' ? w.routeChanges >= 1 && w.routeKnown >= 1 : w.freshN >= MIN_LIVE;",
    what: 'a route that went INVISIBLE is unknown, never a settled route' },
  /* ── v0.34 audit fixes: span, ranking, and the production bridge ─────── */
  { id: 'stability-span-is-min', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Restores the max-span label: credits every node with the OLDEST node's
    // window, so the claim outruns its weakest evidence — the exact thing the
    // panel's own docstring promises it cannot do.
    find: '  const hours = Math.min(...rows.map((r) => r.hours));',
    repl: '  const hours = Math.max(...rows.map((r) => r.hours));',
    what: 'the measured span is the SHORTEST node window, never the longest' },
  { id: 'stability-rank-by-rate', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Ranks by raw count again: 10 re-routes over 10 days outranks 4 over 2
    // hours, putting the genuinely unstable node second.
    find: '    .sort((a, b) => perDayOf(b) - perDayOf(a) || b.changes - a.changes || a.node.nodeId - b.node.nodeId);',
    repl: '    .sort((a, b) => b.changes - a.changes || a.node.nodeId - b.node.nodeId);',
    what: 'ranking uses the per-day RATE the row displays, not the raw count' },
  { id: 'bridge-forwards-ack', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    // Re-opens the production bridge hole in the very function index.ts calls:
    // the shipped M key silently does nothing while every unit test still
    // passes against its own hand-rolled source.
    find: '    ackEvent: (seq) => zd.ackEvent(seq),',
    repl: '    ackEvent: () => false,',
    what: 'the production bridge forwards ackEvent to the data layer' },
  /* ── v0.34: route stability — measured, leftover-funded ──────────────── */
  { id: 'stability-zero-is-finding', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Renders "every path held" over an EMPTY measurement — the exact
    // confident-zero-over-no-data failure the panel exists to avoid.
    find: '    if (s && s.hours > 0) rows.push({ node: n, changes: s.changes, hours: s.hours });',
    repl: '    if (s) rows.push({ node: n, changes: s.changes, hours: s.hours });',
    what: 'a zero claim requires a non-empty measured window' },
  { id: 'stability-leftover-funded', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Funds the panel unconditionally instead of from leftover pad — on a short
    // frame it then steals rows from a tree that is already scrolling.
    find: '  const stability = stabPad >= 3 ? routeStabilityPanel(view, ctx, endNodes, nameBudget, stabPad) : [];',
    repl: '  const stability = routeStabilityPanel(view, ctx, endNodes, nameBudget, Math.max(3, stabPad));',
    what: 'the stability panel is funded ONLY by rows the tree left blank' },
  { id: 'stability-rank-worst-first', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // DIRECTION (its sibling stability-rank-by-rate pins the METRIC): ranks
    // calmest-first, burying the unstable node under the quiet ones.
    find: '    .sort((a, b) => perDayOf(b) - perDayOf(a) || b.changes - a.changes || a.node.nodeId - b.node.nodeId);',
    repl: '    .sort((a, b) => perDayOf(a) - perDayOf(b) || a.changes - b.changes || a.node.nodeId - b.node.nodeId);',
    what: 'the node that re-routed most ranks FIRST, not last' },
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
    find: '    if (tries >= config.maxAttempts) {',
    repl: '    if (false) {',
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
    find: "      return side === 'before' ? w.s2 >= 1 && w.s2Known >= 1 : w.s2Known >= MIN_LIVE && w.freshN >= MIN_LIVE;",
    repl: "      return side === 'before' ? w.s2 >= 1 && w.s2Known >= 1 : w.freshN >= MIN_LIVE;",
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

  { id: 'verify-probe-visible-in-both', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores v0.36.0's mistake: the probe reaches the event ring but not the
    // container log an operator greps — the exact shape of failure that once had
    // auto-ping itself diagnosed as a no-op, and which made the v0.36.0 deploy
    // unverifiable from outside.
    find: "      const msg = `auto-ping: node ${nodeId} verification probe (episode evidence, ${gap}, ${decision.verifyOwed} owed)`;\n      o.log('info', nodeId, msg);\n      o.log2?.(msg);",
    repl: "      const msg = `auto-ping: node ${nodeId} verification probe (episode evidence, ${gap}, ${decision.verifyOwed} owed)`;\n      o.log('info', nodeId, msg);\n      o.log2?.debug?.(msg);",
    what: 'an autonomous write is visible in BOTH the event ring and the server log' },
  { id: 'verify-drain-past-the-gates', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Re-creates the v0.36.0/.1 seam defect: resolving the ledger's queue BEFORE
    // the suppression ladder consumes a probe from the node's burst on every
    // gated tick without sending one — a 5-minute boot window silently exhausts
    // a whole burst, and that is exactly when episodes cluster.
    find: '  const verifyEntries = (input.verifyDue?.() ?? []).filter((e) => candidates.has(e.id));',
    repl: '  const verifyEntries = (input.verifyDue?.() ?? []).filter(() => true).filter((e) => candidates.has(e.id));',
    what: 'the ledger queue is drained only on a tick that will actually probe',
    equivalent: true,
    why: 'the DRAIN-ORDER invariant cannot be expressed as a single-line substitution here — moving the resolve above the gates requires editing two places at once. It is pinned directly by the runner test "a SUPPRESSED tick does not spend the ledger budget it will not use", which was verified to FAIL against a hand-applied eager-resolve regression.' },
  { id: 'confirm-burst-lands-in-window', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Restores v0.36.0's mistiming: probe the instant the symptom clears, so
    // every reading has aged out of the trailing after-window by the time
    // resolve() cuts it. Observed live on node 55 — four answered probes and
    // still `unverifiable`.
    find: '  return now - pendingSinceMs >= Math.max(0, confirmMs - windowMs);',
    repl: '  return now >= pendingSinceMs;',
    what: 'the after-window burst waits until the window it fills has opened' },
  { id: 'confirm-burst-no-negative-wait', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Drops the clamp: a confirm window shorter than the after-window yields a
    // negative threshold, which is harmless here but would invert if the
    // comparison were ever reordered — the clamp states the intent.
    find: '  return now - pendingSinceMs >= Math.max(0, confirmMs - windowMs);',
    repl: '  return now - pendingSinceMs >= confirmMs - windowMs && confirmMs > windowMs;',
    what: 'a confirm window shorter than the after-window is due immediately, not never' },
  { id: 'giveup-is-announced', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the pre-v0.36.4 silence: the attempt budget is spent and the
    // node stays Dead, and auto-ping simply stops saying anything. Observed
    // live on node 23 — 80 minutes of silence indistinguishable from recovery,
    // during which the node was very likely revivable by a single manual ping.
    find: '      if (!input.state.gaveUpAnnounced.has(n.nodeId)) gaveUp.push(n.nodeId);',
    repl: '      void n;',
    what: 'a node the engine has abandoned is announced, not silently dropped' },
  { id: 'giveup-said-once', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Announces every tick instead of once per outage — a per-minute drumbeat
    // on a node that is going to stay down for hours, which buries the Log
    // screen during exactly the incident an operator is trying to read.
    find: '      if (!input.state.gaveUpAnnounced.has(n.nodeId)) gaveUp.push(n.nodeId);',
    repl: '      gaveUp.push(n.nodeId);',
    what: 'the give-up notice fires once per outage, not every tick' },
  { id: 'giveup-rearms-on-recovery', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // A node that recovers and dies again is never announced a second time,
    // because it is remembered forever as already-reported.
    find: '      state.gaveUpAnnounced.delete(n.nodeId);',
    repl: '      void n;',
    what: 'recovery re-arms the give-up notice for the next outage' },
  /* ── v0.36.5: transient vs persistent, and evidence breadth ─────────── */
  { id: 'miss-streak-is-consecutive', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Never resets on a successful probe, so "3rd miss" comes to mean three
    // since boot rather than three in a row — which is the difference between
    // a failing node and a node that has dropped three packets all year.
    find: '      if (answered) {\n        state.missStreak.delete(nodeId);',
    repl: '      if (answered) {\n        void nodeId;',
    what: 'the miss streak counts CONSECUTIVE failures; one answer resets it' },
  { id: 'first-miss-is-not-a-warning', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Warns on every transient miss again. Measured live at ~2% of probes to
    // healthy nodes, that is a steady drip of false alarm sitting beside the
    // genuine article, which teaches an operator to skim past both.
    find: "      o.log(misses >= 2 ? 'warn' : 'info', nodeId, m);",
    repl: "      o.log('warn', nodeId, m);",
    what: 'a single lost packet is info; a streak is a warning' },
  { id: 'arm-provenance-counts-nodes', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Drops the node set, so `n=6` cannot be told apart from six nodes agreeing
    // — the exact reading that made one flapping device look like fleet-wide
    // evidence.
    find: '        noteNode(armNodes, ak, ep.nodeId);',
    repl: '        void ak;',
    what: 'an action arm records which distinct nodes taught it' },
  { id: 'provenance-silent-when-unknown', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // Renders "0 nodes" on a ledger that predates the tracking — a fabricated
    // claim about evidence breadth where silence is the honest answer.
    find: "  const prov = e.nodes > 0 ? ` · ${e.nodes} node${e.nodes === 1 ? '' : 's'}` : '';",
    repl: "  const prov = ` · ${e.nodes} node${e.nodes === 1 ? '' : 's'}`;",
    what: 'an unknown node count renders as nothing, never as zero nodes' },
  /* ── v0.37: node-down, the ordinary outage ──────────────────────────── */
  { id: 'node-down-fires-on-dead', file: 'src/zwave/symptoms.ts', tests: ['symptoms'],
    // Back to the pre-v0.37 blind spot: `dead-flap` needs THREE transitions, so
    // an ordinary outage (die, stay dead, get probed, come back) surfaced as no
    // symptom at all — invisible on REMEDY and unable to open an M5 episode,
    // which is why auto-ping's own efficacy could never accrue a data point.
    find: '      const b = node.status === NS.Dead;',
    repl: '      const b = false;',
    what: 'a node the driver marked Dead surfaces as a symptom' },
  { id: 'node-down-needs-dead', file: 'src/zwave/symptoms.ts', tests: ['symptoms'],
    // Fires for every node regardless of status — turning every sleeping device
    // into a critical alert and conflating silence with a driver verdict.
    find: '      const b = node.status === NS.Dead;',
    repl: '      const b = true;',
    what: 'node-down fires ONLY for a Dead node, never for a quiet one' },
  /* ── v0.37: the liveness sweep asks everyone ────────────────────────── */
  { id: 'sweep-asks-every-node', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the pre-v0.37 silence filter. Sampling a node only when it
    // happens to be quiet measures how talkative it is, not how reachable —
    // the reply rates stop being comparable between devices, which is the one
    // property that makes them worth persisting.
    find: '      .filter((x) => {\n        const last = input.state.lastStaleAt.get(x.id);\n        return last == null || now - last >= config.staleMs;\n      })',
    repl: '      .filter((x) => x.seen == null || now - x.seen >= config.staleMs)\n      .filter((x) => {\n        const last = input.state.lastStaleAt.get(x.id);\n        return last == null || now - last >= config.staleMs;\n      })',
    what: 'the liveness sweep asks EVERY listening node, not only the quiet ones' },
  { id: 'sweep-cadence-gate-holds', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Drops the only remaining gate: an unreachable node never refreshes
    // lastSeen, stays permanently due, and is re-probed on EVERY tick.
    find: '        const last = input.state.lastStaleAt.get(x.id);\n        return last == null || now - last >= config.staleMs;',
    repl: '        return true;',
    what: 'a node is not re-probed within one cadence interval' },
  { id: 'selfproven-measured-vs-cadence', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // The bug found while building this: comparing against the previous PROBE
    // time after noteStale has overwritten it compares against NOW, and nothing
    // is ever newer — so every node reads as unheard and the distinction the
    // sweep exists to draw disappears.
    find: '      const heardRecently = seenAt != null && t - seenAt < o.config.staleMs;',
    repl: '      const heardRecently = seenAt != null && seenAt > (state.lastStaleAt.get(nodeId) ?? 0);',
    what: 'self-proven is measured against the CADENCE, not against a just-overwritten probe time' },
  { id: 'probe-outcome-is-recorded', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // The rate never accrues: probes fire, outcomes are judged, and nothing is
    // persisted — leaving the same ephemeral log lines v0.36 had.
    find: "      if (lane === 'sweep') o.onProbeResult?.(nodeId, false, self);",
    repl: '      void nodeId;',
    what: 'a missed probe is recorded to the persisted reply rate' },
  { id: 'probe-row-needs-a-sample', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Renders a rate over zero probes — 0 of 0 is an absence of evidence, not a
    // reliability of zero, and printing it as a percentage fabricates a reading.
    find: '      if (cov.probesAsked > 0) {',
    repl: '      if (cov.probesAsked >= 0) {',
    what: 'the probe row appears only when the node has actually been swept' },
  { id: 'probe-rate-toned-by-misses', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Paints every reply rate green, so a node answering 3 of 20 reads as
    // healthy — the same ANSI-blind gap that once let a 5%-fresh feed pass.
    find: '        const tone = pct >= 95 ? c.green : pct >= 75 ? c.yellow : c.red;',
    repl: '        const tone = c.green;',
    what: 'the probe reply rate is toned by how often the node actually answers' },
  { id: 'probe-counts-persist', file: 'src/zwave/evidenceStore.ts', tests: ['evidenceStore'],
    // The counters live only in memory, so every restart wipes the reply rate
    // and it can never describe more than the current uptime.
    find: 'fresh: m.freshSamples, pa: m.probesAsked, pk: m.probesAnswered, ps: m.probesSelfProven };',
    repl: 'fresh: m.freshSamples };',
    what: 'the probe reply rate survives a restart' },
  { id: 'verify-probe-reports-spacing', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Drops the diagnostic that makes a burst measurable. Without the gap the
    // add-on log cannot show whether a burst landed inside its window — it has
    // no timestamps, and the decision trace only prints on change — so the next
    // unverifiable episode is again diagnosed by guesswork.
    find: "      const gap = decision.verifyFirst.includes(nodeId) || sinceMs == null\n        ? 'burst start'\n        : `+${Math.round(sinceMs / 1000)}s`;",
    repl: "      const gap = 'burst start';",
    what: 'a verification probe reports the real gap since the node last got one' },
  { id: 'burst-has-margin-over-floor', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Back to exactly MIN_OBS. Measured in production that leaves no room for
    // the ordinary: three readings must all land, be sampled, and carry a
    // non-null RTT inside one 300s window, from a burst already spanning ~240s.
    // One lost probe (~2% of probes on this mesh) and the verdict fails closed.
    find: 'const VERIFY_BURST = 5;',
    repl: 'const VERIFY_BURST = 3;',
    what: 'a verification burst carries margin over the evidence floor, not exactly it' },
  { id: 'burst-label-follows-queue', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Reverts to a pure clock: the queue's first-of-burst flag is ignored, so a
    // short inter-burst pause prints as spacing again — the exact mislabel that
    // sent an audit down the wrong path twice.
    find: '      const gap = decision.verifyFirst.includes(nodeId) || sinceMs == null',
    repl: '      const gap = sinceMs == null',
    what: 'the burst-start label comes from the queue, never from a clock' },
  { id: 'burst-first-flag-is-truthful', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Flags every hand-out as a burst start, which hides real spacing entirely.
    find: '      const first = st.left === VERIFY_BURST;',
    repl: '      const first = true;',
    what: 'first is true exactly for the first probe of a burst' },
  { id: 'burst-spans-less-than-window', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Restores the 70s request spacing, which rounds UP to the next 60s tick and
    // makes the real gap 120s — so a 5-probe burst spans 480s against a 300s
    // window and the verdict can never see more than two or three of its
    // readings. The count was checked against MIN_OBS twice; the SPAN against
    // WINDOW_MS was checked neither time.
    find: 'const VERIFY_SPACING_MS = 30_000;',
    repl: 'const VERIFY_SPACING_MS = 70_000;',
    what: 'burst spacing is below the tick, so the burst fits inside its window' },
  { id: 'burst-survives-contention', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Back to one node per tick globally: with N nodes owed bursts, each one's
    // probes land N ticks apart and the burst outgrows the window again,
    // undoing the spacing fix by a different route.
    find: '    for (const id of due.slice(0, VERIFY_MAX_PER_TICK)) {',
    repl: '    for (const id of due.slice(0, 1)) {',
    what: 'several nodes may be probed per tick, so contention cannot stretch a burst' },
  /* ── v0.38: quiet-node, and unscoreable-by-design ───────────────────── */
  { id: 'quiet-node-fires', file: 'src/zwave/symptoms.ts', tests: ['symptoms'],
    // Returns the last declared-but-unemitted kind to being unemitted. A mains
    // node whose probes stop landing is invisible until the driver happens to
    // attempt a transmission and fail — which is the gap this kind covers.
    find: '      const b = eligible && seen != null && now - seen >= QUIET_MS;',
    repl: '      const b = false;',
    what: 'a mains node silent past the sweep cadence surfaces as quiet-node' },
  { id: 'quiet-node-spares-sleepers', file: 'src/zwave/symptoms.ts', tests: ['symptoms'],
    // Fires for battery/FLiRS devices, which are silent between wakeups BY
    // DESIGN — turning every sleeping sensor into a standing alert.
    find: '      const eligible = node.isListening === true && node.status !== NS.Dead;',
    repl: '      const eligible = node.status !== NS.Dead;',
    what: 'a sleeping device is never quiet-node, however long it is silent' },
  { id: 'quiet-node-no-lastseen-is-not-silence', file: 'src/zwave/symptoms.ts', tests: ['symptoms'],
    // Treats "never heard from" as proof of silence, so a roster that has just
    // been rebuilt accuses every node at once.
    find: '      const b = eligible && seen != null && now - seen >= QUIET_MS;',
    repl: '      const b = eligible && (seen == null || now - seen >= QUIET_MS);',
    what: 'absence of a lastSeen reading is not evidence of silence' },
  { id: 'unscoreable-split-by-cause', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Back to one counter for two different facts: a permanent, unfixable
    // condition accumulating in the signal built to flag the fixable one.
    find: "      } else if (ep.verdict === 'unverifiable' && ep.unprobeable) {",
    repl: "      } else if (false) {",
    what: 'unscoreable-by-design is counted apart from unscoreable-for-now' },
  { id: 'unprobeable-flag-reaches-ledger', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // The ledger can never tell the two apart, because the one fact it cannot
    // compute for itself never arrives.
    find: '      const unprobeable = r.nodeId != null && !(n != null && isPingCandidate(n));',
    repl: '      const unprobeable = false;',
    what: 'the caller tells the ledger whether the node could be probed at all' },
  /* ── v0.38.1: measurement is not treatment ──────────────────────────── */
  { id: 'probe-verb-never-learns', file: 'src/zwave/zwaveActions.ts', tests: ['zwaveActions'],
    // Restores the audit finding at its root: the measurement probe fires
    // onOutcome and stamps `ping` onto every open episode — not one scoreable
    // "(no action)" closure existed in the entire retained log, the control arm
    // starved, and expectedEfficacy was uncomputable.
    find: "      }, /* learn */ false, /* origin */ 'engine'),",
    repl: "      }, /* learn */ true, /* origin */ 'engine'),",
    what: 'a measurement probe is never attributed to the outcome ledger' },
  { id: 'sweep-lane-uses-probe', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    find: "      settleProbe(o, state, nodeId, t, (o.probe ?? o.ping)(nodeId), () => {\n        if (priorStale == null) state.lastStaleAt.delete(nodeId);",
    repl: "      settleProbe(o, state, nodeId, t, o.ping(nodeId), () => {\n        if (priorStale == null) state.lastStaleAt.delete(nodeId);",
    what: 'the liveness sweep rides the non-learning probe' },
  { id: 'verify-lane-uses-probe', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    find: "      settleProbe(o, state, nodeId, t, (o.probe ?? o.ping)(nodeId), () => {\n        if (priorVerify == null) state.lastVerifyAt.delete(nodeId);",
    repl: "      settleProbe(o, state, nodeId, t, o.ping(nodeId), () => {\n        if (priorVerify == null) state.lastVerifyAt.delete(nodeId);",
    what: 'the verification burst rides the non-learning probe' },
  { id: 'dead-ladder-keeps-learning', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Un-instruments the one autonomous remediation whose attribution justifies
    // this module's autonomy — the opposite failure from the audit finding.
    find: "      // This lane DELIBERATELY keeps the learning verb (v0.38.1): a ping fired",
    repl: "      // This lane DELIBERATELY keeps the learning verb (v0.38.1): a ping fired\n      if (o.probe) { void o.probe(nodeId); continue; }",
    what: 'the dead-node ladder keeps the LEARNING ping' },
  { id: 'unprobeable-opens-no-episode', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Re-opens the churn: a sleeping node's episodes can never verify (node 61
    // alone closed 16 unverifiable in one buffer), and counting a permanent
    // condition as data drains every counter it touches.
    find: '      if (s.nodeId != null) {\n        const node = this.snapshot().find((x) => x.nodeId === s.nodeId);\n        if (!(node && isPingCandidate(node))) continue;\n      }',
    repl: '      void isPingCandidate;',
    what: 'an unprobeable node opens no episode — its windows can never be filled' },
  { id: 'closure-shows-its-arithmetic', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Drops the per-window evidence counts from the closure line. Three
    // rtt-degraded episodes on probed, answering nodes closed unverifiable
    // while rate-fallback scored 6-for-6 under identical probes, and the log
    // could not say WHICH floor failed — a verdict that cannot show its
    // arithmetic invites the next guessed fix.
    find: "      log(`episode ${k} ${ep.verdict}${ep.action ? ' after ' + ep.action.kind : ' (no action)'} [before ${win(ep.before)} | after ${win(ep.after)}]${tag}`);",
    repl: "      log(`episode ${k} ${ep.verdict}${ep.action ? ' after ' + ep.action.kind : ' (no action)'}${tag}`);",
    what: 'an episode closure logs the per-window evidence counts behind its verdict' },
  { id: 'transient-needs-after-evidence', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Classifying on the before-side alone would call a BOTH-sides-starved
    // episode a transient — but an after-side gap is fixable (more probes),
    // and folding it into "unscoreable by design" hides exactly the signal
    // the fixable counter exists to carry.
    find: "        if (laneVisible && !sideFloorMet(m, ep.before, 'before') && sideFloorMet(m, ep.after, 'after')) {",
    repl: "        if (laneVisible && !sideFloorMet(m, ep.before, 'before')) {",
    what: 'a transient requires the after-window to have MET its floor — a starved after-side stays fixable' },
  { id: 'transient-counter-not-conflated', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Re-conflates the split: books the blink against the fixable counter,
    // which is the exact defect the classification exists to fix.
    find: '          unverTransient.set(kind, (unverTransient.get(kind) ?? 0) + 1);',
    repl: '          unver.set(kind, (unver.get(kind) ?? 0) + 1);',
    what: 'a transient blink lands in ITS counter, never the fixable-gap one' },
  { id: 'transient-tag-renders', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Silences the closure-line tag: the counter would still be right but the
    // log — the thing audits read — would stop distinguishing the blink.
    find: "        ? ' (transient — degraded state ended before its evidence floor)'",
    repl: "        ? ''",
    what: 'a transient closure names itself on the closure line' },
  { id: 'rtt-floor-is-three', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Lowers the rtt evidence floor to one reading — a median-of-one would
    // pass as robust, the exact failure MIN_OBS exists to prevent.
    find: '      return w.rttMedian != null && w.rttN >= MIN_OBS;',
    repl: '      return w.rttMedian != null && w.rttN >= 1;',
    what: 'the rtt floor demands MIN_OBS readings a side, not a median-of-one' },
  { id: 'sideFloor-flap-sides-differ', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Swaps the flap metric's asymmetric floors: the before-window needs prior
    // flapping, the after-window needs liveness — reversed, a hard-dead node
    // (0 flaps because 0 transitions) reads as a recovery.
    find: '      return side === \'before\' ? w.flaps >= 1 : w.freshN >= MIN_LIVE;',
    repl: '      return side === \'before\' ? w.freshN >= MIN_LIVE : w.flaps >= 1;',
    what: "the flap floors are side-specific: prior flapping before, liveness after" },
  { id: 'transient-needs-visible-lane', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Drops the route-lane visibility guard from the classification: hours of
    // real churn under a dark LWR lane would book as a "blink" and leave the
    // fixable counter — the false cause the v0.39 review caught pre-release.
    find: "          && (m === 'route' ? ep.before.routeKnown >= 1 : m === 's2' ? ep.before.s2Known >= 1 : true);",
    repl: "          && (m === 'route' ? true : m === 's2' ? ep.before.s2Known >= 1 : true);",
    what: 'a dark measurement lane is a fixable gap, never a transient blink' },
  { id: 'transient-row-above-zero', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // The v0.36 unscoreable row's lesson, applied to the v0.39 row: a zero on
    // every card trains the operator to stop reading the line.
    find: '    if (transient > 0) {',
    repl: '    if (transient >= 0) {',
    what: 'the transient-blink row appears only when there ARE transient blinks' },
  { id: 'bridge-forwards-transient', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    // The v0.33 hole, checked on the v0.39 member: a screen reading an
    // optional member that the production bridge forgot to wire renders a
    // silent 0 with every gate green.
    find: '    unverifiableTransientCount: (k) => zd.unverifiableTransientCount(k),',
    repl: '    unverifiableTransientCount: () => 0,',
    what: 'the production bridge forwards unverifiableTransientCount to the data layer' },
  /* ── v0.40: per-probe judgment, honest self-proven, confound guard, clock trust ── */
  { id: 'probe-judgment-per-probe', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Judges only the newest matured probe — the single-slot disease
    // reintroduced: a dying node's five-probe burst collapses to one miss.
    find: '    const mature = pending.filter((p) => now - p.at >= graceMs);',
    repl: '    const mature = pending.filter((p) => now - p.at >= graceMs).slice(-1);',
    what: 'EVERY matured probe is judged — a burst is five judgments, not one' },
  { id: 'young-probes-stay-pending', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Drops in-flight probes at judgment time: an answer arriving inside the
    // grace would never be judged at all.
    find: '    const young = pending.filter((p) => now - p.at < graceMs);',
    repl: '    const young = pending.filter(() => false);',
    what: 'a probe younger than the answer grace stays pending, never vanishes' },
  { id: 'selfproven-requires-own-voice', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Reverts to the cadence-only definition the audit refuted: the node's
    // answer to OUR previous probe reads as it speaking on its own.
    find: '      const spokeOnItsOwn = seenAt != null && (attributed == null || seenAt > attributed);',
    repl: '      const spokeOnItsOwn = seenAt != null;',
    what: "self-proven means the node spoke PAST our own probe's answer" },
  { id: 'selfproven-strictly-past', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // The boundary case IS the defect: lastSeen exactly equal to our probe's
    // answer is the echo, and >= would bless it.
    find: '      const spokeOnItsOwn = seenAt != null && (attributed == null || seenAt > attributed);',
    repl: '      const spokeOnItsOwn = seenAt != null && (attributed == null || seenAt >= attributed);',
    what: 'a lastSeen equal to our own answer is the echo, not the voice' },
  { id: 'probe-flag-rides-the-probe', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Reports every judgment with a hardcoded flag instead of the probe's own
    // context — the persisted reply-rate dimension goes blind.
    find: '      out.push({ nodeId, answered, misses, self, lane });',
    repl: '      out.push({ nodeId, answered, misses, self: false, lane });',
    what: "each judgment carries ITS probe's self-proven context, not a constant" },
  { id: 'lastprobeseen-recorded', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Never records what our probe put on the record — attribution goes blind
    // and every echo reads as the node's own voice again.
    find: '        if (seen != null) state.lastProbeSeen.set(nodeId, seen);',
    repl: '        void seen;',
    what: 'an answered probe records the lastSeen it produced, for attribution' },
  { id: 'skip-marks-confounded', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // The skip keeps refusing attribution but forgets the confound — the
    // audited false control credit ships again.
    find: '          ep.confounded = true;\n          continue;',
    repl: '          continue;',
    what: 'a confirmation-window action confounds the episode it cannot be credited to' },
  { id: 'confounded-not-control', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Lets confounded closures back into the control arm (ep.transient is
    // never set on a scoreable verdict, so the branch goes dead).
    find: '        if (ep.confounded) {',
    repl: '        if (ep.transient) {',
    what: 'a confounded no-action closure is credited to neither arm' },
  { id: 'markconfounded-sets-flag', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    find: '      const ep = open.get(key(nodeId, kind));\n      if (ep) ep.confounded = true;',
    repl: '      void open.get(key(nodeId, kind));',
    what: 'markConfounded actually marks the open episode' },
  { id: 'dead-marks-confounded', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Deletes the only live feeder of the Dead-transition confound — the
    // guard exists but nothing ever arms it (the v0.33 class).
    find: '        if (flapped || (nd && nd.status === NodeStatus.Dead)) oc.markConfounded(ep.nodeId, ep.kind);',
    repl: '        void nd; void flapped;',
    what: 'a node going Dead mid-episode reaches the ledger as a confound mark' },
  { id: 'confounded-tag-renders', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    find: "          ? ' (confounded — the node died or was remediated mid-episode; credited to neither arm)'",
    repl: "          ? ''",
    what: 'a confounded closure names itself on the closure line' },
  { id: 'confounded-row-above-zero', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    find: '    if (conf > 0) {',
    repl: '    if (conf >= 0) {',
    what: 'the confounded row appears only when there ARE confounded closures' },
  { id: 'bridge-forwards-confounded', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    confoundedCount: (k) => zd.confoundedCount(k),',
    repl: '    confoundedCount: () => 0,',
    what: 'the production bridge forwards confoundedCount to the data layer' },
  { id: 'history-grace-needs-behind-clock', file: 'src/zwave/historyStore.ts', tests: ['historyStore'],
    // Reverts to the uptime-only guard whose premise the power cut falsified:
    // an RTC that carried correct time still loses its data on every blip.
    find: '        if (bootGraceMs > 0 && uptimeMs() < bootGraceMs && !clockCarried) {',
    repl: '        if (bootGraceMs > 0 && uptimeMs() < bootGraceMs) {',
    what: 'early boot trusts a clock that provably carried through the outage' },
  { id: 'history-carried-needs-outage', file: 'src/zwave/historyStore.ts', tests: ['historyStore'],
    // Weakens the proof to "age non-negative" — the file-restored RTC-less
    // clock (age ≈ uptime) would then admit an outage-old ring that these
    // untimestamped sparklines could never self-heal after the NTP step.
    find: '        const clockCarried = savedAt > 0 && ageMs > uptimeMs() + 60_000;',
    repl: '        const clockCarried = savedAt > 0 && ageMs >= 0;',
    what: 'carried means age STRICTLY past this boot, not merely non-negative' },
  { id: 'evidence-grace-needs-behind-clock', file: 'src/zwave/evidenceStore.ts', tests: ['evidenceStore'],
    find: '        const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs && !clockCarried;',
    repl: '        const grace = bootGraceMs > 0 && uptimeMs() < bootGraceMs;',
    what: 'early boot keeps the fine ring for a clock that provably carried' },
  { id: 'evidence-carried-needs-outage', file: 'src/zwave/evidenceStore.ts', tests: ['evidenceStore'],
    find: '        const clockCarried = ageMs > uptimeMs() + 60_000;',
    repl: '        const clockCarried = ageMs >= 0;',
    what: 'carried means age STRICTLY past this boot, not merely non-negative' },
  { id: 'twin-lanes-dedup', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the same-tick twin probes: shared `at`, wrong-lane unpend on a
    // transport failure, one silent instant counted as two misses.
    find: '  const staleDeduped = stale.filter((id) => !verifySet.has(id));',
    repl: '  const staleDeduped = stale;',
    what: 'one measurement probe per node per tick — the verify probe answers the sweep' },
  { id: 'echo-follows-attribution-not-the-clock', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the recency gate on the echo label: one physical situation
    // (a node answering every probe, silent otherwise) splits into two labels
    // on sub-minute scheduling jitter, sticky per node — production node 7
    // read "unheard for 120m" on 8 of 10 sweeps while answering everything.
    find: '      const echoOnly = attributed != null && seenAt != null && seenAt <= attributed;',
    repl: '      const echoOnly = heardRecently && attributed != null && seenAt != null && seenAt <= attributed;',
    what: 'the echo label follows attribution alone, never the threshold boundary' },
  /* ── v0.40.2: a probe that never left is never judged ─────────────────── */
  { id: 'failed-launch-not-judged', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the unreachable-.catch defect: run() RETURNS {ok:false} rather
    // than throwing, so an add-on-side failure (HA WS down, Core restarting,
    // no ping button) is judged a moment later as THE NODE failing to answer —
    // poisoning the persisted reply rate and burning remediation budget.
    find: "      if ((res as { ok?: unknown } | null | undefined)?.ok === false) failed('write refused or transport error');",
    repl: '      void res;',
    what: 'a resolved ok:false withdraws the probe — a packet that never left is never judged' },
  { id: 'failed-launch-refunds-attempt', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Keeps the burnt attempt: an HA restart then spends the 3-attempt budget
    // on packets never transmitted and the ladder abandons a node it never
    // actually probed.
    find: '        if (priorTries == null) state.attempts.delete(nodeId);\n        else state.attempts.set(nodeId, priorTries);',
    repl: '        void priorTries;',
    what: 'a failed launch gives back the dead-ladder attempt it booked' },
  { id: 'refund-restores-pre-attempt', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Captures the counters AFTER noteAttempt, so the "refund" hands back the
    // value the attempt just spent — the exact bug this release's own test
    // caught during development.
    find: '      const priorTries = state.attempts.get(nodeId);\n      const attempt = (state.attempts.get(nodeId) ?? 0) + 1;\n      noteAttempt(state, nodeId, t);',
    repl: '      const attempt = (state.attempts.get(nodeId) ?? 0) + 1;\n      noteAttempt(state, nodeId, t);\n      const priorTries = state.attempts.get(nodeId);',
    what: 'the refund restores the PRE-attempt counter, not the one just spent' },
  { id: 'reply-rate-is-sweep-only', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Folds symptom-correlated verification/dead probes back into the
    // fixed-cadence denominator, destroying the cross-node comparability the
    // v0.37 sweep was rebuilt to provide.
    find: "      if (lane === 'sweep') o.onProbeResult?.(nodeId, false, self);",
    repl: '      o.onProbeResult?.(nodeId, false, self);',
    what: 'only the fixed-cadence sweep feeds the persisted reply rate' },
  { id: 'boot-attribution-not-credited', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the once-per-boot fabrication: 35 nodes credited "on its own"
    // for the PREVIOUS process's probe echoes, into a persisted counter.
    find: '      const selfProven = heardRecently && spokeOnItsOwn && attributed != null;',
    repl: '      const selfProven = heardRecently && spokeOnItsOwn;',
    what: 'unknown attribution is never credited as self-proven' },
  { id: 'boot-attribution-says-so', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    find: '      const attributionUnknown = attributed == null && heardRecently;',
    repl: '      const attributionUnknown = false;',
    what: 'the first sweep of a run says its attribution is unknown' },
  { id: 'judgment-bookkeeping-pruned', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    find: '  for (const id of [...state.missStreak.keys()]) if (!seen.has(id)) state.missStreak.delete(id);',
    repl: '  void seen;',
    what: 'a departed node leaves no miss streak for a re-included id to inherit' },
  { id: 'closure-prints-the-decider', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Back to counts-only: the line then reads identically for improved,
    // no-change and worse, and the resolved episode is never persisted.
    find: "          : `fresh=${w.freshN} rtt=${w.rttN}/${num(w.rttMedian, 'ms')} rssi=${w.rssiN}/${num(w.rssiMedian)} ` +",
    repl: "          : `fresh=${w.freshN} rtt=${w.rttN} rssi=${w.rssiN} ` +",
    what: 'a closure line carries the DECIDING quantity, not only the floors' },
  { id: 'subtick-death-confounds', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Blind again to a Dead excursion that opens and closes between two level
    // samples — while the event-driven counter that saw it is discarded.
    find: '        const flapped = (this.flapsThisTick.get(ep.nodeId) ?? 0) > 0;',
    repl: '        const flapped = false;',
    what: 'a sub-tick death confounds the episode the level sample missed' },
  { id: 'subtick-flaps-are-carried', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Kills the PRODUCER: the guard's branch survives but nothing ever feeds
    // it — the v0.33 dead-path class, one layer down.
    find: '      if (flaps > 0) this.flapsThisTick.set(n.nodeId, flaps);',
    repl: '      void flaps;',
    what: 'the drained flap count is carried to the confound guard' },
  { id: 'subtick-flaps-are-cleared', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Never clears, so one flap confounds every later episode on that node
    // forever — a stuck guard is as dishonest as a blind one.
    find: '    this.flapsThisTick.clear();',
    repl: '    void 0;',
    what: 'the per-tick flap carry is consumed once, not latched forever' },
  { id: 'answered-path-is-sweep-only', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // The ANSWERED half of the lane split — the release's headline invariant
    // was only mutation-covered on the MISS path.
    find: "        if (lane === 'sweep') o.onProbeResult?.(nodeId, true, self);",
    repl: '        o.onProbeResult?.(nodeId, true, self);',
    what: 'an ANSWERED verification probe does not move the comparable reply rate' },
  { id: 'launch-failures-are-bounded', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Removes the launch budget: a persistent launch failure becomes an
    // unbounded once-per-tick ping loop with the give-up unreachable — the
    // exact regression a pre-release review measured at 190 pings/200 min.
    find: "    if ((input.state.launchFailures.get(n.nodeId) ?? 0) >= config.maxAttempts) {",
    repl: '    if (false) {',
    what: 'launches that never leave carry their own bounded budget' },
  { id: 'backoff-defined-at-zero-tries', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // BACKOFF_MS[-1] is undefined and `now - last < undefined` is false, so the
    // throttle silently vanishes for a node whose attempt was refunded.
    find: '    const wait = BACKOFF_MS[Math.max(0, Math.min(tries - 1, BACKOFF_MS.length - 1))];',
    repl: '    const wait = BACKOFF_MS[Math.min(tries - 1, BACKOFF_MS.length - 1)];',
    what: 'the dead-lane backoff is defined even at zero recorded attempts' },
  { id: 'sweep-cadence-refunded', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Keeps the cadence clock a failed launch booked, so the node waits a full
    // staleMs having never actually been asked.
    find: '        if (priorStale == null) state.lastStaleAt.delete(nodeId);\n        else state.lastStaleAt.set(nodeId, priorStale);',
    repl: '        state.lastStaleAt.set(nodeId, t);',
    what: 'a sweep launch that never left gives back the cadence clock it booked' },
  /* ── v0.41: the ENGINE screen — the engine's own runtime, made visible ── */
  { id: 'engine-shows-suppression', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Renders a suppressed engine as running: the operator then hunts a mesh
    // fault while the engine is deliberately standing down.
    find: "    const sup = ap.suppressed === 'none'\n      ? c.green('running')\n      : c.yellow(`suppressed: ${ap.suppressed}`);",
    repl: "    const sup = c.green('running');",
    what: 'ENGINE renders auto-ping suppression, never a blanket "running"' },
  { id: 'engine-off-is-not-empty', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // A disabled feature renders as blank rather than saying it is off — the
    // silence-reads-as-healthy failure this whole screen exists to end.
    find: "    push('  ' + c.grey('◷ off — auto-ping is disabled, or write actions are off. Nothing here probes the mesh.'));",
    repl: '    void 0;',
    what: 'a disabled auto-ping SAYS it is off rather than rendering empty' },
  { id: 'engine-idle-ledger-is-not-absent', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Conflates "no ledger wired" with "ledger has nothing open" — two very
    // different facts that this screen was built to separate.
    find: '  if (open == null) {',
    repl: '  if (open == null || open.length === 0) {',
    what: 'an idle ledger is distinguished from an absent one' },
  { id: 'engine-confirming-is-labelled', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // A node in its confirmation window reads as currently degraded, which is
    // the opposite of true: it has already recovered and is being scored.
    find: "      bits.push(ep.confirming\n        ? c.green('confirming — symptom absent, scoring')\n        : c.yellow('degraded — symptom live'));",
    repl: "      bits.push(c.yellow('degraded — symptom live'));",
    what: 'an episode in its confirmation window is not shown as degraded' },
  { id: 'engine-baserate-carries-its-n', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // The bare rate again — the exact class-D defect the gap analysis raised:
    // a self-heal rate without its n invites overtrust in one episode.
    find: "        c.grey(` (n=${arm.n.toFixed(1)}${provenance(arm.nodes)})`));",
    repl: "        '');",
    what: 'the self-heal base rate always renders with its n' },
  { id: 'engine-confound-outranks-action', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Pushes `confounded` behind the action, where truncation eats it — a
    // clipped confound reads as a clean control point.
    find: "      if (ep.confounded) bits.push(c.grey('confounded \u2014 neither arm'));",
    repl: "      if (false) bits.push(c.grey('confounded \u2014 neither arm'));",
    what: 'a confounded episode says so before it says which action it carried' },
  { id: 'bridge-forwards-autoping-state', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    autoPingState: () => zd.autoPingState(),',
    repl: '    autoPingState: () => null,',
    what: 'the production bridge forwards autoPingState to the data layer' },
  { id: 'bridge-forwards-open-episodes', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    openEpisodes: () => zd.openEpisodes(),',
    repl: '    openEpisodes: () => [],',
    what: 'the production bridge forwards openEpisodes to the data layer' },
  { id: 'bridge-forwards-control-arm', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    controlArm: (k) => zd.controlArm(k),',
    repl: '    controlArm: () => null,',
    what: 'the production bridge forwards controlArm to the data layer' },
  { id: 'open-episode-confirming-joined', file: 'src/zwave/zwaveData.ts', tests: ['engineScreen', 'zwaveDataChurn'],
    // pendingResolve lives here, not in the ledger; dropping the join makes
    // every recovering episode read as currently degraded.
    find: '      confirming: this.pendingResolve.has(ep.key),',
    repl: '      confirming: false,',
    what: 'the confirmation-window flag is joined onto open episodes' },
  { id: 'autoping-snapshot-is-live', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Freezes the snapshot at defaults, so ENGINE renders a permanently idle
    // engine however the real one behaves.
    find: '      suppressed: lastDecision?.suppressed ?? \'none\',',
    repl: "      suppressed: 'none',",
    what: 'the auto-ping snapshot reports the LAST real decision, not a default' },
  { id: 'engine-writes-are-not-yours', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Auto-ping's probes and give-up notices logged as source 'you', so the
    // Log screen rendered every autonomous write as "operator" — the activity
    // log telling the operator they had done what the engine did.
    find: "    this.pushEvent('engine', severity, 'action', nodeId, text);",
    repl: "    this.pushEvent('you', severity, 'action', nodeId, text);",
    what: "an autonomous write is attributed to the ENGINE, never to the operator" },
  { id: 'engine-source-renders-apart', file: 'src/telnet/screens/log.ts', tests: ['renderHonesty'],
    find: "ev.source === 'you' ? c.cyan('operator') : ev.source === 'engine' ? c.yellow('engine (auto)') : c.grey('network')",
    repl: "ev.source === 'net' ? c.grey('network') : c.cyan('operator')",
    what: 'the Log screen renders engine provenance apart from the operator' },
  { id: 'origin-follows-the-caller', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Pins the seam the first cut got wrong: one runner serves the operator's
    // typed CONFIRM and auto-ping's ladder, so a fixed sink attributes engine
    // probes — including the RED-latching failure line — to the human.
    find: "    if (origin === 'engine') this.logEngineAction(severity, nodeId, text);",
    repl: '    if (false) this.logEngineAction(severity, nodeId, text);',
    what: "an action's log provenance follows its CALLER, not the runner" },
  { id: 'probe-is-engine-origin', file: 'src/zwave/zwaveActions.ts', tests: ['zwaveActions'],
    find: "      }, /* learn */ false, /* origin */ 'engine'),",
    repl: '      }, /* learn */ false),',
    what: 'a measurement probe logs as the engine, never as the operator' },
  { id: 'run-carries-the-origin', file: 'src/zwave/zwaveActions.ts', tests: ['zwaveActions'],
    find: "      o.log('error', nodeId, `${verb} → failed: ${msg}`, origin);",
    repl: "      o.log('error', nodeId, `${verb} → failed: ${msg}`);",
    what: "the failure line — the one that latches RED — carries its origin" },
  { id: 'engine-alarms-survive-truncation', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Sorts the two human-summoning alarms last again, where an 80-column
    // terminal drops them while cosmetic context survives.
    find: "        if (n.gaveUp) bits.push(c.red('GAVE UP — needs a human'));",
    repl: '        void 0;',
    what: 'a GAVE UP alarm outranks context and survives a narrow terminal' },
  { id: 'engine-bits-are-whole', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Back to blind clipping: a measured 41% renders as `4`.
    find: '    if (visLen(candidate) + visLen(tail) > width) break;',
    repl: '    if (false) break;',
    what: 'a rendered bit is whole or absent — never a clipped number' },
  { id: 'engine-uncomputed-is-not-zero', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    find: "    const num = (v: number | null): string => (v == null ? c.grey('—') : c.white(String(v)));",
    repl: '    const num = (v: number | null): string => c.white(String(v ?? 0));',
    what: 'a queue a suppressed pass never read renders as —, not as a measured 0' },
  { id: 'suppressed-pass-reports-no-queue', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    find: "      staleDue: lastDecision == null || lastDecision.suppressed !== 'none' ? null : lastDecision.staleDue,",
    repl: '      staleDue: lastDecision?.staleDue ?? null,',
    what: 'a suppressed decision reports its unread queues as null' },
  { id: 'abandoned-node-has-no-next-retry', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    find: '        if (!n.gaveUp && n.nextEligibleMs != null && n.nextEligibleMs > now) {',
    repl: '        if (n.nextEligibleMs != null && n.nextEligibleMs > now) {',
    what: 'a node the ladder abandoned is not promised a next attempt' },
  { id: 'unknown-provenance-is-not-zero', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Efficacy.nodes is 0 when UNKNOWN, not when zero nodes agreed. Beside a
    // positive n, "0 nodes" is a self-contradiction — and it appeared on the
    // live fleet within minutes of the ENGINE screen shipping.
    find: "  return nodes > 0 ? `, ${nodes} node${nodes === 1 ? '' : 's'}` : ', sources not recorded';",
    repl: "  return `, ${nodes} node${nodes === 1 ? '' : 's'}`;",
    what: 'an arm with no recorded provenance says so, never "0 nodes"' },
  /* ── v0.41.2: sampling limits are not brevity ──────────────────────────── */
  { id: 'undersampled-is-not-transient', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Collapses the split again: an echo-only node's episode is forced to the
    // transient branch, asserting "it ended quickly" about a symptom whose
    // duration the engine never measured.
    find: '          if (openMs >= UNDERSAMPLED_AFTER_MS) {',
    repl: '          if (openMs >= Number.MAX_SAFE_INTEGER) {',
    what: 'a long episode with a starved before-window is undersampled, not transient' },
  { id: 'undersampled-needs-real-duration', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Calls every starved episode undersampled, erasing the genuinely brief
    // ones the v0.39 taxonomy was built for.
    find: '          if (openMs >= UNDERSAMPLED_AFTER_MS) {',
    repl: '          if (openMs >= 0) {',
    what: 'a genuinely brief episode is still reported as a transient blink' },
  { id: 'undersampled-tag-renders', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    find: "        ? ' (undersampled — this node reports too rarely to reach the floor, whatever the duration)'",
    repl: "        ? ''",
    what: 'an undersampled closure names itself on the closure line' },
  { id: 'giveup-waits-for-judgment', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the ordering where the ERROR asking for a human is announced
    // one tick BEFORE the final probe it rests on can be judged.
    find: '    if (tries >= config.maxAttempts && (input.state.awaitingAnswer.get(n.nodeId)?.length ?? 0) > 0) continue;',
    repl: '    void 0;',
    what: "a give-up waits for its final probe to be judged — the ERROR follows its evidence" },
  { id: 'bridge-forwards-undersampled', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    unverifiableUndersampledCount: (k) => zd.unverifiableUndersampledCount(k),',
    repl: '    unverifiableUndersampledCount: () => 0,',
    what: 'the production bridge forwards unverifiableUndersampledCount' },
  /* ── v0.42.0: traffic outranks the driver's Dead flag ──────────────────── */
  { id: 'traffic-outranks-the-flag', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Restores the world in which node 49 was declared node-down: the driver's
    // reactive Dead flag alone decides, so a node whose own traffic proves it
    // reachable still burns remediation budget and still summons a human.
    find: '    if (heard != null && now - heard < config.afterMs) {',
    repl: '    if (false) {',
    what: "a node heard from inside the dwell is reachable, whatever the flag says" },
  { id: 'silent-dead-node-still-probed', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // The guard must not swallow the case the ladder exists for — a genuinely
    // silent Dead node must still be remediated.
    find: '    const heard = n.stats?.lastSeen ?? null;',
    repl: '    const heard = now;',
    what: 'a genuinely silent Dead node is still remediated' },
  { id: 'stale-flag-is-announced', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Silently skipping the node is worse than the old behaviour: the operator
    // sees a Dead node the engine never touches and never explains.
    find: '      state.talkingAnnounced.add(nodeId);',
    repl: '      continue;',
    what: 'a Dead-but-talking node is explained, not silently skipped' },
  { id: 'stale-flag-announced-once', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Once per outage, like every other latched notice — otherwise it repeats
    // every tick for as long as the flag stays stale.
    find: '      if (state.talkingAnnounced.has(nodeId)) continue;',
    repl: '      void 0;',
    what: 'the stale-flag notice fires once per outage, not every tick' },
  { id: 'giveup-claims-only-nops', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Back to asserting unreachability from unanswered NOPs — the claim node
    // 49 disproved by answering an ordinary command minutes later.
    find: "        `That means it ignored ${tries} NOP frame${tries === 1 ? '' : 's'}, NOT that it is unreachable: ` +",
    repl: "        `That means it is unreachable: ` +",
    what: 'the give-up reports unanswered NOPs, never unreachability' },
  { id: 'engine-shows-stale-flag', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    find: "        if (n.talkingWhileDead) bits.push(c.yellow('reads Dead but TALKING — stale flag'));",
    repl: '        void 0;',
    what: 'ENGINE shows a node whose Dead flag its own traffic contradicts' },
  /* ── v0.43.0: contracts that lied, and a dead accessor ─────────────────── */
  { id: 'engine-shows-driver-link', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Back to the dead accessor: the driver socket that feeds bgRSSI, S2
    // resync detection and the real lastSeen degrades with no surface saying so.
    find: "    push(c.label('DRIVER LINK') + '  ' + tone(`${st} — ${ws}`));",
    repl: '    void tone;',
    what: 'ENGINE renders the driver-WS lifecycle instead of hiding it' },
  { id: 'driver-link-degraded-stands-out', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    find: "    const tone = st === 'live' ? c.grey : st === 'connecting' || st === 'handshake' ? c.grey : c.yellow;",
    repl: '    const tone = c.grey;',
    what: 'a degraded driver link is coloured apart from a healthy one' },
  { id: 'driver-link-classifies-on-state', file: 'src/telnet/screens/engine.ts', tests: ['engineScreen'],
    // Back to pattern-matching the human sentence, which renders 'not started'
    // and every backoff line as healthy.
    find: "    const st = data.driverWsState?.() ?? 'disabled';",
    repl: "    const st = data.driverWsState?.() === 'live' ? 'live' : 'live';",
    what: 'the link is classified on its STATE enum, not on prose' },
  { id: 'bridge-forwards-driver-state', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    driverWsState: () => zd.driverWsState(),',
    repl: "    driverWsState: () => 'live',",
    what: 'the production bridge forwards driverWsState to the data layer' },
  { id: 'bridge-forwards-driver-status', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    driverWsStatus: () => zd.driverWsStatus(),',
    repl: "    driverWsStatus: () => '',",
    what: 'the production bridge forwards driverWsStatus to the data layer' },
  { id: 'failing-link-survives-a-full-tree', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Back to leftover-only funding: on the reference 39-node mesh the tree
    // fills the body, the pad is 0, and the ONLY panel that names a suspect
    // LINK never renders at any terminal size.
    find: '  const failCap = Math.max(FAIL_GUARANTEE, Math.min(padRows, Math.max(3, Math.floor(padRows / 2))));',
    repl: '  const failCap = Math.min(padRows, Math.max(3, Math.floor(padRows / 2)));',
    what: 'a failing link is guaranteed rows even when the tree fills the body' },
  { id: 'failing-link-renders-when-scrolling', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // The panel was computed and then dropped on the floor in the scrolling
    // branch — the exact branch a 39-node mesh always takes.
    find: '    body.push(...failures);\n  }',
    repl: '  }',
    what: 'the failure panel is appended in the SCROLLING branch, not only the padded one' },
  { id: 'healthy-mesh-pays-nothing', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Makes the guarantee unconditional, so a healthy mesh loses tree rows to
    // an empty panel — the cost the rarity argument exists to avoid.
    find: '  if (byPair.size === 0) return [];',
    repl: '  if (false) return [];',
    what: 'a healthy mesh pays no rows for the failure guarantee' },
  { id: 'unpend-removes-one', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Withdraws the whole pending list on one transport failure — the other
    // probes' owed judgments vanish with it.
    find: '  if (i >= 0) pending.splice(i, 1);',
    repl: '  if (i >= 0) pending.splice(0, pending.length);',
    what: 'a transport failure withdraws only ITS probe, never the siblings' },
  { id: 'deadflap-not-confounded', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Marks dead-flap episodes confounded by their own defining status —
    // structurally starving that control arm forever (v0.40 review, critical).
    find: "        if (ep.kind === 'dead-flap') continue;",
    repl: '        ;',
    what: "Dead status never confounds dead-flap — it is that symptom's own definition" },
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
  /* ── v0.35: route FAILURES — which link broke ────────────────────────── */
  { id: 'failures-tally-by-pair', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // One row per REPORT instead of per pair: a single marginal link that six
    // nodes all witnessed reads as six unrelated one-off failures, which is
    // exactly the aggregation the panel exists to do.
    find: '      if (cur) { cur.n += 1; cur.last = Math.max(cur.last, f.t); }',
    repl: '      if (cur) { cur.last = Math.max(cur.last, f.t); }',
    what: 'failures on one link are summed into ONE row, not scattered per reporter' },
  { id: 'failures-rank-worst-first', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Ranks the least-broken link first, burying the one to go fix.
    find: '  const ranked = [...byPair.values()].sort((x, y) => y.n - x.n || y.last - x.last);',
    repl: '  const ranked = [...byPair.values()].sort((x, y) => x.n - y.n || x.last - y.last);',
    what: 'the link that failed MOST ranks first' },
  /* DELETED v0.43.0: 'failures-leftover-funded' pinned the rule that the
   * failure panel never costs the tree a row. That rule was a deliberate v0.35
   * choice with a consequence nobody measured until an audit did: on the
   * reference 39-node mesh the tree fills the body at every ordinary size, the
   * pad is 0, and the ONLY panel that names a suspect LINK never rendered. The
   * new contract is pinned by 'failing-link-survives-a-full-tree' and
   * 'healthy-mesh-pays-nothing' — an obsolete invariant is deleted, never left
   * to rot into a MISSING anchor. */
  { id: 'failures-bounded-vs-stability', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // Lets failures take the WHOLE pad, starving the stability panel entirely
    // whenever more than a handful of links have ever failed.
    find: '  const failCap = Math.max(FAIL_GUARANTEE, Math.min(padRows, Math.max(3, Math.floor(padRows / 2))));',
    repl: '  const failCap = Math.max(FAIL_GUARANTEE, padRows);',
    what: 'failures claim first but BOUNDED — stability is never evicted' },
  { id: 'bridge-forwards-route-failures', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    // The v0.33 hole re-opened on the v0.35 member: the panel renders in every
    // unit test against its own mock and shows nothing in production.
    find: '    routeFailures: (n) => zd.routeFailures(n),',
    repl: '    routeFailures: () => [],',
    what: 'the production bridge forwards routeFailures to the data layer' },
  { id: 'bridge-forwards-coverage', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    evidenceCoverage: (n) => zd.evidenceCoverage(n),',
    repl: '    evidenceCoverage: () => null,',
    what: 'the production bridge forwards evidenceCoverage to the data layer' },
  { id: 'bridge-forwards-false-positives', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    falsePositives: (k) => zd.falsePositives(k),',
    repl: '    falsePositives: () => 0,',
    what: 'the production bridge forwards falsePositives to the data layer' },
  { id: 'bridge-forwards-rssi-normal', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    find: '    rssiNormal: (n) => zd.rssiNormal(n),',
    repl: '    rssiNormal: () => null,',
    what: 'the production bridge forwards rssiNormal to the data layer' },
  /* ── v0.35: EVIDENCE — what the engine can SEE ───────────────────────── */
  { id: 'evidence-names-monitoring-hole', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Both feeds down renders identically to a genuinely quiet node — the one
    // distinction the whole section exists to draw.
    find: '      if (!cov.statusFeedLive && !cov.statsFeedLive) {',
    repl: '      if (false) {',
    what: 'a node with BOTH feeds down is named a monitoring hole, not health' },
  { id: 'evidence-fresh-share-honest', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Colours a mostly-stale feed green: 5% fresh reads as healthy.
    find: '      const freshTone = pct == null ? c.grey : pct >= 80 ? c.green : pct >= 40 ? c.yellow : c.red;',
    repl: '      const freshTone = c.green;',
    what: 'the fresh-sample share is toned by how stale it actually is' },
  { id: 'baseline-ungraduated-says-so', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Quotes a median from a band that has not graduated — indistinguishable
    // on screen from a learned yardstick, and actionable when it must not be.
    find: '        const band = rn.ready',
    repl: '        const band = rn.days >= 0',
    what: 'an un-graduated baseline says "still learning" instead of quoting a median' },
  { id: 'log-entity-name-leads', file: 'src/telnet/screens/log.ts', tests: ['logScreen'],
    // Back to printing the slug while the captured friendly name goes unused.
    // NOT `false && …`: TS drops flow narrowing inside an unreachable operand,
    // so that form fails to compile (`ev` reverts to `LogEvent | undefined`) —
    // an INVALID mutant that would count as killed while proving nothing.
    // Flipping the threshold keeps every operand reachable and live.
    find: '        ev.entityName.length + 1 + ev.entityId.length + domainTag.length <= W - 10;',
    repl: '        ev.entityName.length + 1 + ev.entityId.length + domainTag.length <= -1;',
    what: 'the log detail pane leads with the entity NAME it captured' },
  { id: 'log-entity-id-survives', file: 'src/telnet/screens/log.ts', tests: ['logScreen'],
    // Drops the width gate: at 80 cols a long name pushes the id past field()'s
    // blind right-truncate, clipping it into a DIFFERENT plausible id — the
    // v0.35 review finding this gate exists to prevent.
    find: "      const nameFits = !!ev.entityName &&\n        ev.entityName.length + 1 + ev.entityId.length + domainTag.length <= W - 10;",
    repl: '      const nameFits = !!ev.entityName;',
    what: 'the entity ID always survives whole — the name yields, never the id' },
  /* ── v0.35 (Z2): the ledger reaches BLOCKED candidates ───────────────── */
  { id: 'ledger-reaches-blocked', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // Restores the pre-v0.35 gate: route-churn's only executable candidate is
    // permanently blocked, so its MEASURED efficacy can never reach the screen
    // and the learning loop can never overturn the hardcoded lore.
    find: '        const note = efficacyNote(cand.efficacy, cand.blocked != null);',
    repl: '        const note = cand.blocked == null ? efficacyNote(cand.efficacy, false) : null;',
    what: 'a blocked candidate still reports what the ledger measured' },
  { id: 'ledger-blocked-never-endorses', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // Drops the blocked framing: a green "✓ helped 80%" now sits directly under
    // advice that says NOT recommended.
    find: "    return blocked\n      ? c.yellow(`⚠ ledger measured ${pct}% here (n=${n}${prov})${base} — the block above still applies`)\n      : c.green(`✓ helped ${pct}% (n=${n}${prov})${base}`);",
    repl: '    return c.green(`✓ helped ${pct}% (n=${n}${prov})${base}`);',
    what: 'a blocked candidate is never endorsed in the voice of a recommendation' },
  { id: 'ledger-never-judges-block', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // Restores the review defect verbatim: `blocked` carries safety and config
    // gates too, and "the block above is lore" told an operator a BATTERY/FLiRS
    // safety gate was unfounded folklore contradicted by measurement.
    find: '      ? c.yellow(`⚠ ledger measured ${pct}% here (n=${n}${prov})${base} — the block above still applies`)',
    repl: '      ? c.yellow(`⚠ ledger measured ${pct}% here (n=${n}${prov})${base}; the block above is lore`)',
    what: 'the note reports measurement without ever characterizing the block' },
  { id: 'false-positives-only-above-zero', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // A clean detector boasts a zero — noise on every card, and it trains the
    // operator to stop reading the line that matters.
    find: '    if (fp > 0) {',
    repl: '    if (fp >= 0) {',
    what: 'the false-positive warning appears only when there ARE false positives' },
  { id: 'correlated-scope-only-when-active', file: 'src/telnet/screens/interference.ts', tests: ['interferenceScreen'],
    // Prints "scope · 0 distinct nodes symptomatic" during a live mesh event.
    find: '    if (iv.correlated.degradedNodes > 0) {',
    repl: '    if (iv.correlated.degradedNodes >= 0) {',
    what: 'the scope line states a real count or says nothing' },
  { id: 'forget-baselines-on-success-only', file: 'src/zwave/zwaveActions.ts', tests: ['zwaveActions'],
    // Discards a LIVE node's learned baselines when the removal failed — the
    // node is still on the mesh and the engine has just been blinded to it.
    find: '      if (res.ok) o.onNodeRemoved?.(n);',
    repl: '      o.onNodeRemoved?.(n);',
    what: 'baselines are forgotten only when the node actually LEFT the mesh' },
  /* ── v0.35 review fixes ──────────────────────────────────────────────── */
  { id: 'failures-disclosure-not-double', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // The shipped-then-caught off-by-one: capacity = budget-2 reserves the
    // disclosure row, slice(capacity-1) reserves it AGAIN — at the pinned
    // budget of 3 (every padRows in 3..7, i.e. the default 80x24) the panel
    // rendered "+7 more" while naming ZERO links.
    find: '  const fitCap = Math.max(1, budget - 1);\n  const canDisclose = ranked.length > fitCap;\n  const shown = canDisclose ? ranked.slice(0, Math.max(1, budget - 2)) : ranked;\n  const lines = [groupHeader(view, \'Route failures\', byPair.size)];',
    repl: '  const fitCap = Math.max(1, budget - 2);\n  const canDisclose = ranked.length > fitCap;\n  const shown = canDisclose ? ranked.slice(0, fitCap - 1) : ranked.slice(0, fitCap);\n  const lines = [groupHeader(view, \'Route failures\', byPair.size)];',
    what: 'the disclosure row is subtracted ONCE — a "+N more" never renders above zero links' },
  { id: 'stability-disclosure-not-double', file: 'src/telnet/screens/topology.ts', tests: ['topologyRoutes'],
    // The same off-by-one in the sibling panel (pre-existing since v0.34; the
    // v0.35 failCap split widened the band it hid in).
    find: '  const fitCap = Math.max(1, budget - 1);\n  const canDisclose = ranked.length > fitCap;\n  const shown = canDisclose ? ranked.slice(0, Math.max(1, budget - 2)) : ranked;\n  const max = perDayOf(ranked[0]);',
    repl: '  const fitCap = Math.max(1, budget - 2);\n  const canDisclose = ranked.length > fitCap;\n  const shown = canDisclose ? ranked.slice(0, fitCap - 1) : ranked.slice(0, fitCap);\n  const max = perDayOf(ranked[0]);',
    what: 'the stability disclosure is subtracted once too — never "+N more" over nothing' },
  { id: 'evidence-no-samples-dash', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Coerces "no measurement" into a confident 0%: zero samples renders
    // "(0% lifetime)" — a fabricated reading over absent data.
    find: '      const pct = cov.samples > 0 ? Math.round((cov.freshSamples / cov.samples) * 100) : null;',
    repl: '      const pct = Math.round((cov.freshSamples / Math.max(1, cov.samples)) * 100);',
    what: 'zero samples is a dash, never a confident 0%' },
  { id: 'coverage-live-requires-socket', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // The review defect: the idempotency sets survive a disconnect, so without
    // the socket AND the badges glow green for the whole outage and the
    // MONITORING HOLE line can never fire during one.
    find: '    const up = this.client.ready();',
    repl: '    const up = true;',
    what: 'a feed badge means subscription AND socket — it goes dark in an outage' },
  { id: 'baseline-band-labelled', file: 'src/telnet/screens/detail.ts', tests: ['detailScreen'],
    // Drops the time-of-day qualifier: the store keeps a normal per 4-hour
    // band, and an unlabelled band-dependent yardstick reads as the baseline
    // contradicting itself across the day.
    find: "            c.grey(` · ${rn.days}d · this time-of-day band`)",
    repl: "            c.grey(` · ${rn.days}d`)",
    what: 'the learned normal SAYS it answers for the current time-of-day band' },
  /* ── v0.36: the learning loop can finally learn ──────────────────────── */
  { id: 'unverifiable-is-counted', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Restores the pre-v0.36 silence: an unscoreable episode vanishes without
    // trace, so an inert ledger and a patient one render identically. On the
    // live mesh that hid 16 discarded episodes out of 16.
    find: '        unver.set(kind, (unver.get(kind) ?? 0) + 1);',
    repl: '        void kind;',
    what: 'an unscoreable episode is COUNTED, so an inert ledger cannot pass for a patient one' },
  { id: 'unverifiable-feeds-no-arm', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // The counter must not become a back door into the control arm: counting an
    // episode is not the same as scoring it, and an unscoreable one is still
    // evidence of nothing.
    // `&& false` no longer compiles here (the v0.39 branch body references
    // `ep`, and TS strips the resolve-head narrowing inside dead code — the
    // v0.35 lesson). The reachable form routes a NO-ACTION unverifiable
    // episode past this branch into the control arm, the exact promotion the
    // invariant forbids.
    find: "      } else if (ep.verdict === 'unverifiable') {",
    repl: "      } else if (ep.verdict === 'unverifiable' && ep.action != null) {",
    what: 'counting an unscoreable episode never promotes it into an arm' },
  { id: 'refine-before-strictly-better', file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    // Lets a POORER window overwrite a richer one — the probes would then be
    // able to make the evidence worse, which is the opposite of the point.
    find: '      const had = ep.before?.freshN ?? -1;\n      if (window.freshN <= had) return false;',
    repl: '      const had = ep.before?.freshN ?? -1;\n      void had;',
    what: 'a refined before-window only ever ADDS readings, never removes them' },
  { id: 'refine-before-not-after-verdict', file: 'src/zwave/outcomes.ts',
    find: '      if (!ep || ep.resolvedMs != null || ep.verdict != null) return false;',
    repl: '      if (!ep) return false;',
    what: 'a scored episode is history — its evidence is never rewritten',
    equivalent: true,
    why: 'resolve() deletes the episode from `open` before setting its verdict, so a resolved episode is never reachable through open.get() and the `!ep` guard alone already refuses it. The clause is defence-in-depth against a future refactor that keeps resolved episodes in the map; the observable invariant is pinned in outcomes.test.ts.' },
  { id: 'before-window-spans-the-breach',
    // Back to anchoring the degraded window at emission: the dwell equals the
    // lookback, so the observation that FIRED the episode falls outside its own
    // before-window and a quiet node scores unverifiable by arithmetic.
    file: 'src/zwave/outcomes.ts', tests: ['outcomes'],
    find: '  const from = Math.min(sinceMs, now) - windowMs;',
    repl: '  const from = now - windowMs;',
    what: 'the degraded window spans the breach that armed the symptom, not just the last 5 minutes' },
  { id: 'verify-obeys-gates', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Routes verification probes around the suppression ladder — they would
    // then fire during a storm, a rebuild, the boot window, or with write
    // actions off, which is a second and less-guarded path to the mesh.
    find: "  const verifyEntries = (input.verifyDue?.() ?? []).filter((e) => candidates.has(e.id));",
    repl: "  const verifyEntries = input.verifyDue?.() ?? [];",
    what: 'a verification probe passes every gate auto-ping itself passes' },
  { id: 'verify-skips-dead-nodes', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Lets the verification lane race the remediation lane on a Dead node,
    // bypassing its dwell, backoff and 3-attempt budget.
    find: '  const candidates = new Set(listeningNodes.filter((n) => n.status !== NodeStatus.Dead).map((n) => n.nodeId));',
    repl: '  const candidates = new Set(listeningNodes.map((n) => n.nodeId));',
    what: 'a DEAD node is probed by the remediation path only, never by verification' },
  { id: 'probe-answer-from-evidence', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Calls every probe answered regardless of whether lastSeen moved —
    // restoring the v0.35 state where an unanswered probe was unobservable.
    find: '    const answered = seen != null && seen >= at;',
    repl: '    const answered = true;',
    what: 'a probe is judged answered only when the node lastSeen actually advanced' },
  { id: 'probe-answer-waits-grace', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Judges a probe before the round trip could possibly have completed, so
    // every probe reads as unanswered.
    find: '    const mature = pending.filter((p) => now - p.at >= graceMs);\n    if (mature.length === 0) continue;',
    repl: '    const mature = pending;\n    if (mature.length === 0) continue;',
    what: 'a probe is judged only after its round trip has had time to complete' },
  { id: 'probe-answer-roster-gap', file: 'src/zwave/autoPing.ts', tests: ['autoPing'],
    // Calls a node missing from the roster a failed probe — manufacturing the
    // false alarm this signal exists to avoid.
    find: '    if (!seenOf.has(nodeId)) continue;',
    repl: '    if (false) continue;',
    what: 'a roster gap is judged NEITHER way, never as a failed probe' },
  { id: 'verify-burst-does-not-stack', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Accumulates instead of topping up: a symptom that flaps ten times would
    // owe thirty probes.
    find: '      left: Math.max(cur?.left ?? 0, VERIFY_BURST),',
    repl: '      left: (cur?.left ?? 0) + VERIFY_BURST,',
    what: 'repeated verification requests top the budget up, never stack it' },
  { id: 'verify-burst-is-spaced', file: 'src/zwave/zwaveData.ts', tests: ['zwaveDataChurn'],
    // Fires the whole burst in one second — three packets carrying one
    // observation's worth of information, at three times the airtime.
    find: '      else this.verifyOwed.set(id, { left, nextAt: now + VERIFY_SPACING_MS });',
    repl: '      else this.verifyOwed.set(id, { left, nextAt: now });',
    what: 'a verification burst is spaced so each probe is a separate reading' },
  { id: 'unscoreable-row-above-zero', file: 'src/telnet/screens/remedy.ts', tests: ['remedyScreen'],
    // A clean ledger boasts a zero on every card, training the operator to stop
    // reading the line that matters.
    find: '    if (unver > 0) {',
    repl: '    if (unver >= 0) {',
    what: 'the unscoreable-episode line appears only when there ARE unscoreable episodes' },
  { id: 'bridge-forwards-unverifiable', file: 'src/telnet/dataProvider.ts', tests: ['driverWsClient'],
    // The v0.33 hole re-opened on the v0.36 member.
    find: '    unverifiableCount: (k) => zd.unverifiableCount(k),',
    repl: '    unverifiableCount: () => 0,',
    what: 'the production bridge forwards unverifiableCount to the data layer' },
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
