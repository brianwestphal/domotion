#!/usr/bin/env node
// DM-1405: seed/refresh a per-OS baseline for the FEATURE visual-regression
// suite (tests/features.ts) from a known-good run's results, so CI can gate the
// suite RELATIVE to it (scripts/diff-against-baseline.mjs --strict) instead of
// on the absolute pass/fail — the same two-baseline model docs/.../tests/baselines
// already uses for the unicode/html sweeps (DM-1217).
//
// Reads the feature suite's `tests/output/features-results.json`
// (`{ suite, generatedAt, results: SuiteResult[] }`) and writes
// `tests/baselines/features-<os>.json` (`{ meta, fixtures }`).
//
// Usage:
//   node scripts/seed-feature-baseline.mjs --os <macos|linux|windows> [--image <id>] \
//        [--results tests/output/features-results.json] [--out tests/baselines/features-<os>.json]
//
// Run it from a reviewed, known-good run (host macOS, or the Linux Docker
// container, or a Windows host) — see tests/baselines/README.md.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const os = arg("--os");
if (os == null) { console.error("seed-feature-baseline: --os <macos|linux|windows> is required"); process.exit(2); }
const resultsPath = arg("--results", "tests/output/features-results.json");
const outPath = arg("--out", `tests/baselines/features-${os}.json`);
const image = arg("--image", os === "macos" ? "macos-local" : os === "linux" ? "playwright-noble" : "windows-local");

let commit = "unknown";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a repo */ }

const doc = JSON.parse(readFileSync(resultsPath, "utf8"));
const results = Array.isArray(doc.results) ? doc.results : Array.isArray(doc) ? doc : [];
if (results.length === 0) { console.error(`seed-feature-baseline: no results in ${resultsPath}`); process.exit(1); }

const fixtures = {};
let pass = 0, fail = 0, skipped = 0;
for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
  fixtures[r.name] = {
    pass: !!r.pass,
    skipped: !!r.skipped,
    diffPct: r.diffPct ?? r.coveragePct ?? 0,
    worstTilePct: r.worstTilePct ?? 0,
    regionCount: r.regionCount ?? 0,
  };
  if (r.skipped) skipped++; else if (r.pass) pass++; else fail++;
}

const baseline = {
  meta: {
    suite: "features",
    os,
    image,
    commit,
    capturedAt: doc.generatedAt ?? null,
    counts: { total: results.length, pass, fail, skipped },
  },
  fixtures,
};

writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");
console.log(`Wrote ${outPath}: ${pass} pass, ${fail} fail, ${skipped} skipped (${results.length} fixtures) @ ${commit.slice(0, 8)}`);
if (fail > 0) {
  console.log("Known-failing fixtures recorded in the baseline (the gate will allow these, block only NEW regressions):");
  for (const [n, f] of Object.entries(fixtures)) if (!f.pass && !f.skipped) console.log(`  - ${n}  diff=${(f.diffPct).toFixed?.(2) ?? f.diffPct}%`);
}
