#!/usr/bin/env node
// DM-1217: turn a merged visual-test result set (scripts/merge-shard-results.mjs
// output — a plain array — or a suite result wrapper into a committed CI
// baseline file, the thing
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
//        [--image <id>] [--commit <sha>] [--captured-at <iso>] [--env <run-env.json>]
//
// `--env` records the environment fingerprint the run was measured in
// (scripts/run-env.mjs). Without it, `--image` alone is too coarse to notice a
// runner-image rotation: `ImageOS` reads `macOS26` both before and after, so two
// different macOS builds — which DO select different fonts — look identical.
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

const parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
const arr = Array.isArray(parsed) ? parsed : parsed?.results;
if (!Array.isArray(arr)) {
  console.error("write-baseline: --results must be an array or an object with a results array");
  process.exit(2);
}

// Keep only the fields the comparator needs (pass/skip + the diff metrics), keyed
// by fixture name so the file is small, stable, and reviewable in a diff.
//
// The attribution fields (perceptual digests, byte hashes, Chrome's painted
// faces) are comparator inputs too: `diff-against-baseline.mjs` reads
// `expectedDigest`/`actualDigest` to say WHICH side moved, and it had been
// reading them from a baseline that never stored them — so every regression
// report printed "—" (unattributable) since the day the mechanism landed.
// Recorded when present; absent fields stay absent so older results files
// still produce a valid (if unattributable) baseline.
const fixtures = {};
let passed = 0, failed = 0, skipped = 0;
for (const r of arr.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  if (!r || typeof r.name !== "string") continue;
  const f = {
    pass: !!r.pass,
    skipped: !!r.skipped,
    diffPct: r.diffPct ?? 0,
    worstTilePct: r.worstTilePct ?? 0,
    regionCount: r.regionCount ?? 0,
  };
  for (const k of ["expectedDigest", "actualDigest", "expectedSha256", "actualSha256", "chromeFaces"]) {
    if (r[k] != null) f[k] = r[k];
  }
  fixtures[r.name] = f;
  if (r.skipped) skipped++;
  else if (r.pass) passed++;
  else failed++;
}

const envPath = arg("--env", null);
let env = null;
if (envPath != null) {
  try { env = JSON.parse(readFileSync(envPath, "utf8")); } catch (e) {
    console.error(`write-baseline: could not read --env ${envPath}: ${e.message}`);
    process.exit(2); // an unreadable env is worse than none: it looks recorded
  }
}

const doc = {
  meta: {
    suite: arg("--suite", "unknown"),
    os: arg("--os", "unknown"),
    image: arg("--image", null),
    commit: arg("--commit", null),
    capturedAt: arg("--captured-at", null),
    env,
    counts: { passed, failed, skipped, total: passed + failed + skipped },
  },
  fixtures,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote baseline ${outPath}: ${passed} passed, ${failed} failed, ${skipped} skipped ` +
  `(${doc.meta.counts.total} fixtures, image=${doc.meta.image ?? "?"})`);
