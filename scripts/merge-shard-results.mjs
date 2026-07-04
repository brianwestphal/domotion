#!/usr/bin/env node
// DM-1216: merge the per-shard `results.json` files produced by the sharded
// visual-tests GitHub Actions workflow (or local shard runs) into one merged
// result per OS, and emit a Markdown summary.
//
// `gh run download` lays each uploaded artifact into its own subdir, so the
// input tree looks like:
//   <input>/results-macos-shard1/results.json
//   <input>/results-macos-shard2/results.json
//   <input>/results-linux-shard1/results.json
//   ...
// We group by the `<os>` parsed from the `results-<os>-shard<i>` dir name,
// concat each group's `results` arrays, recompute passed/failed/skipped exactly
// the way the harness does (tests/html-test-suite.tsx), write
// `<out>/results-<os>.json`, and print a Markdown summary (to --summary, or
// $GITHUB_STEP_SUMMARY when set, else stdout).
//
// Usage:
//   node scripts/merge-shard-results.mjs --input <dir> [--out <dir>] [--summary <file>]

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const inputDir = arg("--input");
if (inputDir == null) {
  console.error("merge-shard-results: --input <dir> is required");
  process.exit(2);
}
const outDir = arg("--out", inputDir);
const summaryTarget = arg("--summary", process.env.GITHUB_STEP_SUMMARY ?? null);

// Recursively collect every results.json under the input tree.
function findResultsJson(dir) {
  const found = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return found; }
  for (const name of entries) {
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) found.push(...findResultsJson(full));
    else if (name === "results.json") found.push(full);
  }
  return found;
}

// Parse `<os>` out of a `results-<os>-shard<i>` ancestor dir; default "results".
function osFromPath(p) {
  let d = dirname(p);
  while (d !== "/" && d !== "." && d.length > 0) {
    const m = /^results-([a-z0-9]+)-shard\d+$/i.exec(basename(d));
    if (m != null) return m[1].toLowerCase();
    d = dirname(d);
  }
  return "results";
}

// DM-1661: parse the shard `<i>` out of the same ancestor dir, so each merged
// result carries which shard artifact its images live in — the lazy review
// server uses this to fetch just that shard on demand instead of everything.
function shardFromPath(p) {
  let d = dirname(p);
  while (d !== "/" && d !== "." && d.length > 0) {
    const m = /^results-[a-z0-9]+-shard(\d+)$/i.exec(basename(d));
    if (m != null) return Number(m[1]);
    d = dirname(d);
  }
  return null;
}

const files = findResultsJson(inputDir);
if (files.length === 0) {
  console.error(`merge-shard-results: no results.json found under ${inputDir}`);
  process.exit(1);
}

// Group fixtures by OS, deduping by fixture name (a shard never overlaps, but be
// defensive against a re-run / double download).
const byOs = new Map();
for (const f of files) {
  const os = osFromPath(f);
  let arr;
  try { arr = JSON.parse(readFileSync(f, "utf8")); } catch (e) {
    console.error(`merge-shard-results: skipping unparseable ${f}: ${e.message}`);
    continue;
  }
  if (!Array.isArray(arr)) continue;
  const shard = shardFromPath(f);
  if (!byOs.has(os)) byOs.set(os, new Map());
  const seen = byOs.get(os);
  for (const r of arr) {
    // DM-1661: stamp the shard so the lazy review server can locate this
    // fixture's image artifact. Local single-run (no shard dir) leaves it null.
    if (r && typeof r.name === "string" && !seen.has(r.name)) {
      if (shard != null) r.shard = shard;
      seen.set(r.name, r);
    }
  }
}

const lines = ["## Visual-test results (merged across shards)", ""];
let anyFailed = false;

for (const os of [...byOs.keys()].sort()) {
  const results = [...byOs.get(os).values()].sort((a, b) => a.name.localeCompare(b.name));
  // Mirror tests/html-test-suite.tsx:1640-1642 exactly.
  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  if (failed > 0) anyFailed = true;

  const outPath = resolve(outDir, `results-${os}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  lines.push(`### ${os}`, "");
  lines.push(`**${passed} passed, ${failed} failed, ${skipped} skipped** out of ${results.length}.`, "");

  const fails = results
    .filter((r) => !r.pass && !r.skipped)
    .sort((a, b) => (b.diffPct ?? 0) - (a.diffPct ?? 0));
  if (fails.length > 0) {
    lines.push("| fixture | diff% | worstTile% | regions |", "|---|---|---|---|");
    for (const r of fails) {
      const diff = (r.diffPct ?? 0).toFixed(3);
      const wt = (r.worstTilePct ?? 0).toFixed(2);
      const reg = r.regionCount ?? (Array.isArray(r.regions) ? r.regions.length : "?");
      lines.push(`| ${r.name} | ${diff} | ${wt} | ${reg} |`);
    }
    lines.push("");
  }
  console.log(`merged ${os}: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} fixtures) -> ${outPath}`);
}

const summary = lines.join("\n") + "\n";
if (summaryTarget != null) {
  // $GITHUB_STEP_SUMMARY is append-only; a plain --summary path is overwritten.
  if (summaryTarget === process.env.GITHUB_STEP_SUMMARY && existsSync(summaryTarget)) {
    appendFileSync(summaryTarget, summary);
  } else {
    writeFileSync(summaryTarget, summary);
  }
  console.log(`\nWrote Markdown summary to ${summaryTarget}`);
} else {
  console.log("\n" + summary);
}

// Report-only by default (don't fail CI on a fidelity diff in a manual run); a
// caller that wants a hard gate can check the exit code with --strict.
if (process.argv.includes("--strict") && anyFailed) process.exit(1);
