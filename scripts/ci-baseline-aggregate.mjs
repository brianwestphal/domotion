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

// merge-shard-results.mjs folded the per-shard environments into one record per
// OS. It is null when the shards disagreed, which is deliberate: a run whose
// shards straddled a runner-image rotation is not a single measurement, and
// carrying "whatever shard 1 had" into the baseline is how that mix hides.
function envPathFor(os) {
  const p = join(input, `run-env-${os}.json`);
  return existsSync(p) ? p : null;
}

let anyRegression = false;
for (const os of oses) {
  const merged = join(input, `results-${os}.json`);
  const baseline = `tests/baselines/${suite}-${os}.json`;
  const envPath = envPathFor(os);
  console.log(`\n=== baseline diff: ${os} / ${suite} (vs ${baseline}) ===`);
  try {
    const a = ["scripts/diff-against-baseline.mjs",
      "--results", merged, "--baseline", baseline, "--label", `${os} / ${suite}`];
    if (envPath) a.push("--env", envPath);
    execFileSync("node", a, { stdio: "inherit" });
  } catch (e) {
    if (e.status === 1) anyRegression = true; // diff exits 1 only under --strict; here it won't, so this is defensive
    else throw e;
  }

  if (update) {
    // Absent provenance is a hard error when WRITING a baseline, because a
    // baseline is the one artifact where it matters and the failure is
    // otherwise invisible: `env: null` renders as the same "baseline predates
    // environment recording" notice a genuinely old baseline produces, so the
    // next reader concludes it is merely stale rather than that the guard was
    // removed by the tool meant to install it. Measured once, on the html
    // re-capture: the run's meta came back with env/image/capturedAt all null
    // and nothing warned.
    //
    // Note this is a DIFFERENT condition from the heterogeneity one. There,
    // `merge-shard-results.mjs` deliberately writes a null field because the
    // shards disagreed — a decision it announces. Here the record is missing
    // altogether, which announces nothing.
    if (envPath == null) {
      console.error(
        `\n✖ Refusing to write ${suite}/${os}: no run-env-${os}.json in ${input}.\n`
        + `  A baseline without environment provenance cannot be compared against, and\n`
        + `  reads as an old baseline rather than a broken one. Re-run the sweep on a\n`
        + `  ref whose workflow uploads run-env-*.json in the visual-tests-meta artifact,\n`
        + `  or pass --eager to merge the full shard artifacts locally.\n`);
      process.exit(1);
    }
    const out = join(outDir, `baseline-${suite}-${os}.json`);
    // `imageFor` reads a per-shard `runner-image.txt`, which the slim metadata
    // path does not carry — but the merged env record holds the same value, so
    // fall back to it rather than recording null next to a populated `env`.
    let image = imageFor(os);
    if (image == null) {
      try { image = JSON.parse(readFileSync(envPath, "utf8"))?.image ?? null; } catch { image = null; }
    }
    const a = ["scripts/write-baseline.mjs", "--results", merged, "--out", out, "--suite", suite, "--os", os];
    if (image) a.push("--image", image);
    if (commit) a.push("--commit", commit);
    // When the caller did not supply one, stamp when the baseline was WRITTEN.
    // Not the run's own start time — it is the merge that fixes the contents —
    // but a null here is strictly worse: it makes a fresh baseline look as
    // undated as one from before the field existed.
    a.push("--captured-at", capturedAt ?? new Date().toISOString());
    if (envPath) a.push("--env", envPath);
    execFileSync("node", a, { stdio: "inherit" });
  }
}

if (anyRegression) process.exit(1);
