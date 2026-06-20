#!/usr/bin/env node
// DM-1217: aggregate-job glue for the two-baseline model. Runs AFTER
// merge-shard-results.mjs has written one `results-<os>.json` per OS into the
// shard-artifacts dir. For each OS that ran:
//   - diff the merged run against the committed CI baseline
//     (tests/baselines/<suite>-<os>.json) and append the report to the Step
//     Summary — this is the relative "did anything regress vs the last
//     known-good run on this image?" check that DOES transfer (unlike the raw
//     count vs a local Mac);
//   - when --update-baseline is set, (re)write that committed baseline from this
//     run into <out-dir>/baseline-<suite>-<os>.json for the user to review +
//     commit (we never commit from CI).
//
// Usage:
//   node scripts/ci-baseline-aggregate.mjs --input <shard-artifacts> --suite <s> \
//        [--update-baseline] [--out <dir>] [--commit <sha>] [--captured-at <iso>]

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const input = arg("--input");
const suite = arg("--suite", "unicode");
const outDir = arg("--out", input);
const commit = arg("--commit", null);
const capturedAt = arg("--captured-at", null);
const update = process.argv.includes("--update-baseline");
if (input == null) { console.error("ci-baseline-aggregate: --input <dir> required"); process.exit(2); }

// Discover which OSes produced a merged results-<os>.json.
const oses = readdirSync(input)
  .map((n) => /^results-([a-z0-9]+)\.json$/i.exec(n))
  .filter(Boolean)
  .map((m) => m[1].toLowerCase());

if (oses.length === 0) { console.log("ci-baseline-aggregate: no merged results-<os>.json found; nothing to diff."); process.exit(0); }

// The runner image was recorded by each shard as runner-image.txt; find the
// first one for this OS so the written baseline records which image it came from.
function imageFor(os) {
  for (const name of readdirSync(input)) {
    if (!new RegExp(`^results-${os}-shard\\d+$`, "i").test(name)) continue;
    const p = join(input, name, "runner-image.txt");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  return null;
}

let anyRegression = false;
for (const os of oses) {
  const merged = join(input, `results-${os}.json`);
  const baseline = `tests/baselines/${suite}-${os}.json`;
  console.log(`\n=== baseline diff: ${os} / ${suite} (vs ${baseline}) ===`);
  try {
    execFileSync("node", ["scripts/diff-against-baseline.mjs",
      "--results", merged, "--baseline", baseline, "--label", `${os} / ${suite}`], { stdio: "inherit" });
  } catch (e) {
    if (e.status === 1) anyRegression = true; // diff exits 1 only under --strict; here it won't, so this is defensive
    else throw e;
  }

  if (update) {
    const out = join(outDir, `baseline-${suite}-${os}.json`);
    const image = imageFor(os);
    const a = ["scripts/write-baseline.mjs", "--results", merged, "--out", out, "--suite", suite, "--os", os];
    if (image) a.push("--image", image);
    if (commit) a.push("--commit", commit);
    if (capturedAt) a.push("--captured-at", capturedAt);
    execFileSync("node", a, { stdio: "inherit" });
  }
}

if (anyRegression) process.exit(1);
