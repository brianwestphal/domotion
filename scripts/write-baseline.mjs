#!/usr/bin/env node
// DM-1217: turn a merged visual-test result set (scripts/merge-shard-results.mjs
// output — a plain array) into a committed CI baseline file, the thing
// scripts/diff-against-baseline.mjs diffs future runs against.
//
// The baseline is image-specific by design: the local Mac and the macos-15-arm64
// CI runner rasterize text differently, so each keeps its OWN baseline (the local
// one being the implicit "compare to local Chrome" the demos:test suites already
// do). Refresh a CI baseline only from a run you have reviewed as known-good.
//
// Usage:
//   node scripts/write-baseline.mjs --results <merged-results.json> \
//        --out tests/baselines/<suite>-<os>.json \
//        --suite <unicode|html> --os <macos|linux|windows> \
//        [--image <id>] [--commit <sha>] [--captured-at <iso>]
//
// Date.now()/new Date() are avoided so this stays deterministic under the
// workflow harness; pass --captured-at / --commit explicitly (the workflow and
// run-ci-visual-tests.mjs both do).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const resultsPath = arg("--results");
const outPath = arg("--out");
if (resultsPath == null || outPath == null) {
  console.error("write-baseline: --results <file> and --out <file> are required");
  process.exit(2);
}

const arr = JSON.parse(readFileSync(resultsPath, "utf8"));
if (!Array.isArray(arr)) {
  console.error("write-baseline: --results must be a merged results array");
  process.exit(2);
}

// Keep only the fields the comparator needs (pass/skip + the diff metrics), keyed
// by fixture name so the file is small, stable, and reviewable in a diff.
const fixtures = {};
let passed = 0, failed = 0, skipped = 0;
for (const r of arr.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  if (!r || typeof r.name !== "string") continue;
  fixtures[r.name] = {
    pass: !!r.pass,
    skipped: !!r.skipped,
    diffPct: r.diffPct ?? 0,
    worstTilePct: r.worstTilePct ?? 0,
    regionCount: r.regionCount ?? 0,
  };
  if (r.skipped) skipped++;
  else if (r.pass) passed++;
  else failed++;
}

const doc = {
  meta: {
    suite: arg("--suite", "unknown"),
    os: arg("--os", "unknown"),
    image: arg("--image", null),
    commit: arg("--commit", null),
    capturedAt: arg("--captured-at", null),
    counts: { passed, failed, skipped, total: passed + failed + skipped },
  },
  fixtures,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote baseline ${outPath}: ${passed} passed, ${failed} failed, ${skipped} skipped ` +
  `(${doc.meta.counts.total} fixtures, image=${doc.meta.image ?? "?"})`);
