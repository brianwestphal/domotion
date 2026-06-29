#!/usr/bin/env node
// DM-1217: diff a merged visual-test result set against a COMMITTED CI baseline.
//
// Why this exists: the macOS CI runner (macos-15-arm64, Apple Silicon) rasterizes
// text differently enough from a local Mac that Domotion's locally-calibrated
// output crosses the pass threshold on ~24 otherwise-clean common-text blocks
// (basic-latin, cyrillic, greek, …). So the CI pass/fail COUNT does not transfer
// to the local baseline, and comparing CI's raw count against local is noise.
//
// The fix (the project's two-baseline model): keep one baseline for the local
// Mac (the implicit "compare to local Chrome" the demos:test suites already do)
// and a SEPARATE committed baseline for each CI image. This script answers the
// only question that matters on a CI run: "did this change make anything WORSE
// than the last known-good run on the SAME image?" — regressions vs the baseline,
// not an apples-to-oranges count against a different machine.
//
// Usage:
//   node scripts/diff-against-baseline.mjs --results <merged-results.json> \
//        --baseline tests/baselines/<suite>-<os>.json [--summary <file>] [--strict] [--label <text>]
//
// --results   : a merged results array (scripts/merge-shard-results.mjs output) OR
//               a baseline-wrapper object ({meta, fixtures}); both are accepted.
// --baseline  : the committed CI baseline (baseline-wrapper object). If the file
//               is missing, this prints a "no baseline committed yet" note and
//               exits 0 (so a first run on a new image doesn't hard-fail).
// --strict    : exit 1 when there are regressions or new failing fixtures.
// --summary   : write the Markdown report here (append if it's $GITHUB_STEP_SUMMARY).
// --label     : a short label for the report heading (e.g. "macos / unicode").

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const resultsPath = arg("--results");
const baselinePath = arg("--baseline");
const summaryTarget = arg("--summary", process.env.GITHUB_STEP_SUMMARY ?? null);
const label = arg("--label", "");
const strict = process.argv.includes("--strict");

if (resultsPath == null || baselinePath == null) {
  console.error("diff-against-baseline: --results <file> and --baseline <file> are required");
  process.exit(2);
}

// Normalize any of three shapes into a Map<name, {pass, skipped, diffPct,
// worstTilePct, regionCount}>: a bare merged array, the {meta, fixtures} baseline
// wrapper, or the feature suite's {suite, generatedAt, results: SuiteResult[]}.
function toFixtureMap(parsed) {
  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (r && typeof r.name === "string") map.set(r.name, r);
    }
  } else if (parsed && Array.isArray(parsed.results)) {
    // DM-1405: the feature suite (tests/runner.tsx) writes
    // `{ suite, generatedAt, results: SuiteResult[] }`. Each SuiteResult carries
    // `name`, `pass`, `diffPct`, `worstTilePct`, `regionCount` (+ more) — exactly
    // the fields the baseline diff needs — so consume it directly.
    for (const r of parsed.results) {
      if (r && typeof r.name === "string") map.set(r.name, r);
    }
  } else if (parsed && typeof parsed.fixtures === "object" && parsed.fixtures != null) {
    for (const [name, r] of Object.entries(parsed.fixtures)) map.set(name, { name, ...r });
  }
  return map;
}

const current = toFixtureMap(JSON.parse(readFileSync(resultsPath, "utf8")));

function emit(md) {
  const text = md.join("\n") + "\n";
  if (summaryTarget != null) {
    if (summaryTarget === process.env.GITHUB_STEP_SUMMARY && existsSync(summaryTarget)) appendFileSync(summaryTarget, text);
    else writeFileSync(summaryTarget, text);
    console.log(`Wrote baseline-diff report to ${summaryTarget}`);
  }
  console.log("\n" + text);
}

const heading = `## Baseline diff${label ? ` — ${label}` : ""}`;

if (!existsSync(baselinePath)) {
  emit([
    heading, "",
    `⚠️ No committed CI baseline at \`${baselinePath}\`.`,
    "",
    "This is a *relative* check (regressions vs the last known-good run on the same",
    "image); without a baseline there is nothing to diff against. Establish one from",
    "a known-good run:",
    "",
    "```sh",
    "node tools/run-ci-visual-tests.mjs --suite <suite> --update-baseline",
    "```",
  ]);
  process.exit(0); // first run on a new image must not hard-fail
}

const baselineDoc = JSON.parse(readFileSync(baselinePath, "utf8"));
const baseline = toFixtureMap(baselineDoc);
const meta = (baselineDoc && baselineDoc.meta) || {};

const isFail = (r) => r != null && !r.pass && !r.skipped;

const regressions = []; // passed/skipped in baseline, fails now
const fixes = [];       // failed in baseline, passes now
const newFixtures = []; // in current, not in baseline
const dropped = [];     // in baseline, not in current

for (const [name, cur] of current) {
  const base = baseline.get(name);
  if (base == null) { newFixtures.push({ name, cur }); continue; }
  if (isFail(cur) && !isFail(base)) regressions.push({ name, cur, base });
  else if (!isFail(cur) && isFail(base)) fixes.push({ name, cur, base });
}
for (const [name, base] of baseline) {
  if (!current.has(name)) dropped.push({ name, base });
}

const newFailing = newFixtures.filter((f) => isFail(f.cur));

const curFails = [...current.values()].filter(isFail).length;
const baseFails = [...baseline.values()].filter(isFail).length;

const md = [heading, ""];
const metaBits = [];
if (meta.image) metaBits.push(`image \`${meta.image}\``);
if (meta.commit) metaBits.push(`baseline commit \`${String(meta.commit).slice(0, 8)}\``);
if (meta.capturedAt) metaBits.push(`captured ${meta.capturedAt}`);
if (metaBits.length) md.push(`Baseline: ${metaBits.join(" · ")}`, "");

md.push(`**${curFails} failing now vs ${baseFails} in baseline.** ` +
  `${regressions.length} regression(s), ${fixes.length} fix(es), ` +
  `${newFailing.length} new failing fixture(s), ${dropped.length} dropped.`, "");

function table(title, rows, withBase) {
  if (rows.length === 0) return;
  md.push(`### ${title} (${rows.length})`, "");
  md.push(withBase
    ? "| fixture | diff% now | worstTile% now | diff% base | worstTile% base |"
    : "| fixture | diff% | worstTile% | regions |");
  md.push(withBase ? "|---|---|---|---|---|" : "|---|---|---|---|");
  for (const { name, cur, base } of rows) {
    const cd = (cur?.diffPct ?? 0).toFixed(3);
    const cw = (cur?.worstTilePct ?? 0).toFixed(2);
    if (withBase) {
      const bd = (base?.diffPct ?? 0).toFixed(3);
      const bw = (base?.worstTilePct ?? 0).toFixed(2);
      md.push(`| ${name} | ${cd} | ${cw} | ${bd} | ${bw} |`);
    } else {
      const reg = cur?.regionCount ?? "?";
      md.push(`| ${name} | ${cd} | ${cw} | ${reg} |`);
    }
  }
  md.push("");
}

table("🔴 Regressions vs baseline", regressions, true);
table("🆕 New failing fixtures (not in baseline)", newFailing.map((f) => ({ name: f.name, cur: f.cur })), false);
table("🟢 Newly passing vs baseline", fixes, true);

if (dropped.length) {
  md.push(`### Dropped (in baseline, not in this run): ${dropped.length}`, "",
    "_" + dropped.slice(0, 20).map((d) => d.name).join(", ") + (dropped.length > 20 ? ", …" : "") + "_", "");
}

if (regressions.length === 0 && newFailing.length === 0) {
  md.push("✅ **No regressions vs the CI baseline.**", "");
}

emit(md);

if (strict && (regressions.length > 0 || newFailing.length > 0)) process.exit(1);
