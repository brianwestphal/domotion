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

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";

import { mergeShardEnvs } from "./run-env.mjs";

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

// Each shard writes `run-env.json` into its own artifact (scripts/run-env.mjs).
// Read it from the SAME directory as that shard's results.json so a shard's
// numbers and the machine that produced them cannot drift apart.
function envBesideResults(resultsPath) {
  const p = join(dirname(resultsPath), "run-env.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// Group fixtures by OS, deduping by fixture name (a shard never overlaps, but be
// defensive against a re-run / double download).
const byOs = new Map();
const envsByOs = new Map();
const stageEvidenceByOs = new Map();
for (const f of files) {
  const os = osFromPath(f);
  let arr;
  try { arr = JSON.parse(readFileSync(f, "utf8")); } catch (e) {
    console.error(`merge-shard-results: skipping unparseable ${f}: ${e.message}`);
    continue;
  }
  if (!Array.isArray(arr)) continue;
  const shard = shardFromPath(f);
  const stageEvidencePath = join(dirname(f), "stage-evidence.json");
  if (shard === 1 && existsSync(stageEvidencePath) && !stageEvidenceByOs.has(os)) stageEvidenceByOs.set(os, stageEvidencePath);
  const env = envBesideResults(f);
  if (env != null) {
    if (!envsByOs.has(os)) envsByOs.set(os, []);
    envsByOs.get(os).push({ shard, env });
  }
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

/**
 * `--expect macos=5,linux=0,windows=0` — the matrix size per OS, so the merge can
 * tell a complete run from a partial one. Entries of 0 mean "this OS was not
 * dispatched" and are dropped rather than treated as a shortfall.
 */
const expectByOs = new Map();
for (const part of (arg("--expect", "") || "").split(",")) {
  const [os, n] = part.split("=");
  const total = Number.parseInt(n, 10);
  if (os && Number.isFinite(total) && total > 0) expectByOs.set(os.trim(), total);
}

const lines = ["## Visual-test results (merged across shards)", ""];
let anyFailed = false;
let anyHeterogeneous = false;
let anyIncomplete = false;

for (const os of [...byOs.keys()].sort()) {
  const results = [...byOs.get(os).values()].sort((a, b) => a.name.localeCompare(b.name));
  // Mirror tests/html-test-suite.tsx:1640-1642 exactly.
  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.length - passed - skipped;
  if (failed > 0) anyFailed = true;

  const outPath = resolve(outDir, `results-${os}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  const stageEvidencePath = stageEvidenceByOs.get(os);
  if (stageEvidencePath != null) copyFileSync(stageEvidencePath, resolve(outDir, `stage-evidence-${os}.json`));

  lines.push(`### ${os}`, "");
  lines.push(`**${passed} passed, ${failed} failed, ${skipped} skipped** out of ${results.length}.`, "");

  // The environment these numbers were measured in, folded across shards. A
  // sweep is only ONE measurement if every shard ran on the same machine spec;
  // when they didn't, say so here rather than letting the merged file imply it.
  const shardEnvs = envsByOs.get(os) ?? [];
  if (shardEnvs.length > 0) {
    const { combined, heterogeneous, conflicts } = mergeShardEnvs(shardEnvs);
    writeFileSync(resolve(outDir, `run-env-${os}.json`), JSON.stringify(combined, null, 2) + "\n");
    if (heterogeneous) {
      anyHeterogeneous = true;
      lines.push(
        `> ⚠️ **This run's shards did NOT all run on the same environment.** The merged`,
        `> numbers above are a blend of ${conflicts[0].values.length}+ machine specs, so a`,
        `> per-fixture difference vs another run may be environmental rather than a code`,
        `> change — and capturing this run as a baseline would bake the mix in.`,
        "",
      );
      for (const c of conflicts) {
        const parts = c.values.map((v) => `\`${v.value}\` (shard${v.shards.length === 1 ? "" : "s"} ${v.shards.join(", ") || "?"})`);
        lines.push(`> - **${c.field}**: ${parts.join(" vs ")}`);
      }
      lines.push("");
      console.error(`merge-shard-results: WARNING ${os} shards disagree on: ${conflicts.map((c) => c.field).join(", ")}`);
    } else {
      const bits = [];
      if (combined.image) bits.push(`image \`${combined.image}\``);
      if (combined.imageVersion) bits.push(`build \`${combined.imageVersion}\``);
      if (combined.osRelease) bits.push(`os \`${combined.osRelease}\``);
      if (combined.fontInventory?.digest) bits.push(`fonts \`${combined.fontInventory.digest}\``);
      if (bits.length) lines.push(`Environment (all ${shardEnvs.length} shard(s) agree): ${bits.join(" · ")}`, "");
    }
  }

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
  // Shard completeness. A merge is only a measurement of the CORPUS if every
  // shard's results reached it — and a lost shard is silent in the direction
  // that matters, because its failures simply are not there to report. Observed:
  // shard 5 of a 5-way macOS unicode run produced no artifact, the aggregate
  // merged the other four, and the run reported "no regressions" over 655 of 818
  // fixtures. The 163 missing ones were Tibetan, Kannada, Gurmukhi, Arabic
  // Supplement, IPA Extensions — complex-script blocks, i.e. the ones a shaping
  // change is most likely to disturb.
  //
  // `--expect` is how the caller states the matrix size. Absent (a local run,
  // or a single unsharded run) the check is skipped rather than guessed at.
  const observed = [...new Set((envsByOs.get(os) ?? []).map((e) => e.shard).filter((s) => s != null))].sort((a, b) => a - b);
  const shardsSeen = new Set((byOs.get(os) ? [...byOs.get(os).values()] : []).map((r) => r.shard).filter((s) => s != null));
  for (const s of shardsSeen) observed.includes(s) || observed.push(s);
  observed.sort((a, b) => a - b);
  const expected = expectByOs.get(os) ?? null;
  const missing = expected == null ? [] : Array.from({ length: expected }, (_, i) => i + 1).filter((s) => !observed.includes(s));
  writeFileSync(resolve(outDir, `shard-completeness-${os}.json`), `${JSON.stringify({
    os, expectedShards: expected, observedShards: observed, missingShards: missing,
    complete: expected == null ? null : missing.length === 0,
    fixtures: results.length,
  }, null, 2)}\n`);

  if (missing.length > 0) {
    anyIncomplete = true;
    lines.push(
      `> 🔴 **INCOMPLETE RUN — ${missing.length} of ${expected} shard(s) are missing from this merge.**`,
      `> Missing shard(s): ${missing.join(", ")}. The ${results.length} fixtures above are the`,
      `> SURVIVORS, not the corpus, and every count derived from them understates the`,
      `> failures — a regression living in a lost shard reads here as "no regressions".`,
      `> Do not compare this run against a baseline or another run.`,
      "",
    );
    console.error(`merge-shard-results: INCOMPLETE ${os} — missing shard(s) ${missing.join(", ")} of ${expected}`);
  }

  console.log(`merged ${os}: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} fixtures`
    + `${expected != null ? `, shards ${observed.length}/${expected}` : ""}) -> ${outPath}`);
}

// An OS that was dispatched but produced NO results at all never enters the loop
// above, so it would otherwise vanish from the summary entirely — the most
// complete form of the same failure, and the quietest.
for (const [os, expected] of expectByOs) {
  if (byOs.has(os)) continue;
  anyIncomplete = true;
  lines.push(
    `### ${os}`, "",
    `> 🔴 **NO RESULTS AT ALL.** ${expected} shard(s) were dispatched and none reached the merge.`,
    "",
  );
  writeFileSync(resolve(outDir, `shard-completeness-${os}.json`), `${JSON.stringify({
    os, expectedShards: expected, observedShards: [],
    missingShards: Array.from({ length: expected }, (_, i) => i + 1),
    complete: false, fixtures: 0,
  }, null, 2)}\n`);
  console.error(`merge-shard-results: INCOMPLETE ${os} — no results at all (expected ${expected} shard(s))`);
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
//
// A heterogeneous run is a separate failure from a fidelity diff: the numbers
// may be perfectly fine, but they are not one measurement. `--strict-env` fails
// on it so a baseline capture can refuse to bake in a blended run, without
// making every ordinary sweep hard-fail during a routine image rotation.
// An INCOMPLETE run fails unconditionally, with no flag to opt out of, because
// it is not a fidelity opinion — it is the merge saying the file it just wrote
// does not describe the corpus. Reporting it and exiting 0 is what let a run
// missing a fifth of its fixtures print "✅ No regressions". Only reachable when
// the caller passed `--expect`; a local or unsharded run is unaffected.
if (anyIncomplete) {
  console.error("merge-shard-results: refusing to report an incomplete run as a measurement");
  process.exit(1);
}
if (process.argv.includes("--strict-env") && anyHeterogeneous) process.exit(1);
if (process.argv.includes("--strict") && anyFailed) process.exit(1);
