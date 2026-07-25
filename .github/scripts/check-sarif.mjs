#!/usr/bin/env node
// Gate CI on CodeQL findings WITHOUT GitHub Advanced Security.
//
// This private, personal-account repo can't use GitHub's hosted code scanning
// (the Security tab / SARIF upload is a GHAS feature, unavailable here), so the
// CodeQL workflow analyzes locally and hands the SARIF to this script instead of
// uploading it. We print every result grouped by severity and FAIL the job on any
// genuinely actionable finding — an `error`-level result, or a rule whose
// `security-severity` is >= HIGH (7.0). Notes/warnings are surfaced but don't
// break the build (security-extended emits a fair number of low-signal notes).
//
// Usage: node check-sarif.mjs <path-to-sarif> [--fail-threshold <float>]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sarifPath = args.find((a) => !a.startsWith('--'));
const thrIdx = args.indexOf('--fail-threshold');
const FAIL_SEVERITY = thrIdx >= 0 ? Number(args[thrIdx + 1]) : 7.0; // HIGH

if (!sarifPath) {
  console.error('usage: check-sarif.mjs <sarif> [--fail-threshold <float>]');
  process.exit(2);
}

let sarif;
try {
  sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
} catch (e) {
  console.error(`Could not read/parse SARIF at ${sarifPath}: ${e.message}`);
  process.exit(2);
}

const runs = Array.isArray(sarif.runs) ? sarif.runs : [];
let total = 0;
const failing = [];
const byLevel = { error: 0, warning: 0, note: 0, none: 0 };

for (const run of runs) {
  // Build a ruleId -> {level, securitySeverity, name} index.
  //
  // ★ Rules live in tool.EXTENSIONS, not tool.driver. CodeQL emits an EMPTY
  //   `tool.driver.rules` and puts all 103 rule definitions — including the
  //   `security-severity` property this gate keys on — under
  //   `tool.extensions[*].rules`. Reading only the driver meant every lookup
  //   missed, every `sev` was NaN, and the `sev >= 7` half of the fail
  //   condition COULD NEVER FIRE. The gate silently degraded to "fail only on
  //   error-level results" while its own header advertised severity gating.
  //   Caught when enabling the Security-tab upload made GitHub report two
  //   findings as HIGH that this script had just called "no actionable
  //   findings" — the same value at 7.0 judged two different ways.
  //   Driver is still read first so a non-CodeQL SARIF keeps working.
  const ruleMeta = new Map();
  const ruleSources = [
    run?.tool?.driver?.rules ?? [],
    ...(run?.tool?.extensions ?? []).map((e) => e?.rules ?? []),
  ];
  for (const rules of ruleSources) {
    for (const r of rules) {
      ruleMeta.set(r.id, {
        level: r.defaultConfiguration?.level ?? 'warning',
        sev: Number(r.properties?.['security-severity'] ?? NaN),
        name: r.name ?? r.id,
      });
    }
  }
  if (ruleMeta.size === 0 && (run.results ?? []).length > 0) {
    // Results with no rule metadata anywhere: severity gating is impossible,
    // so say so rather than quietly passing on an unenforceable threshold.
    console.error('WARNING: no rule metadata in driver OR extensions — severity gating is INERT for this SARIF.');
  }
  for (const res of run.results ?? []) {
    total += 1;
    const meta = ruleMeta.get(res.ruleId) ?? {};
    const level = res.level ?? meta.level ?? 'warning';
    const sev = Number.isFinite(meta.sev) ? meta.sev : NaN;
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    const loc = res.locations?.[0]?.physicalLocation;
    const where = loc
      ? `${loc.artifactLocation?.uri ?? '?'}:${loc.region?.startLine ?? '?'}`
      : '(no location)';
    const msg = (res.message?.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
    const isFail = level === 'error' || (Number.isFinite(sev) && sev >= FAIL_SEVERITY);
    const line = `  [${level}${Number.isFinite(sev) ? ` sev ${sev}` : ''}] ${res.ruleId} @ ${where}\n      ${msg}`;
    if (isFail) failing.push(line);
    console.log(line);
  }
}

console.log(
  `\nCodeQL results: ${total} total  (error:${byLevel.error} warning:${byLevel.warning} note:${byLevel.note})`
);

if (failing.length) {
  console.error(
    `\n✗ ${failing.length} actionable finding(s) — error-level or security-severity >= ${FAIL_SEVERITY}:`
  );
  for (const f of failing) console.error(f);
  process.exit(1);
}
console.log(`\n✓ No actionable findings (error-level or security-severity >= ${FAIL_SEVERITY}).`);
