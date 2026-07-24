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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    find: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE', 2], ['⏎', 'DEVICE', 1], ['D', 'DATE', 4],\n      ['O', 'ERRORS', 3], ['1-8', 'SCREENS'], ['Q', 'CLOSE'],",
    repl: "      ['↑↓', 'MOVE'], ['␣/b', 'PAGE'], ['⏎', 'DEVICE'], ['D', 'DATE'],\n      ['O', 'ERRORS'], ['1-8', 'SCREENS'], ['Q', 'CLOSE'],",
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
const compiles = () => {
  try {
    execFileSync('npm', ['run', 'typecheck'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const suiteFails = () => {
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return false; // exit 0 → all green → mutant SURVIVED
  } catch {
    return true;
  }
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
  try {
    valid = compiles();
    red = valid ? suiteFails() : false;
  } finally {
    restore();
  }
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
if (survived.length || missing.length || invalid.length || relabel.length) {
  console.log('\nA SURVIVED entry is a fix no test protects. A MISSING entry means this');
  console.log('file has drifted from the code. An INVALID entry is a mutant that does not');
  console.log('compile — it would be counted as killed while proving nothing. All three');
  console.log('are failures, as is RELABEL (an `equivalent` entry that is now');
  console.log('actually covered): do not claim the release is mutation-checked until clean.');
  process.exit(1);
}
