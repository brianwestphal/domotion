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
//        --baseline tests/baselines/<suite>-<os>.json [--summary <file>] [--strict] [--label <text>] [--env <run-env.json>]
//
// --results   : a merged results array (scripts/merge-shard-results.mjs output) OR
//               a baseline-wrapper object ({meta, fixtures}); both are accepted.
// --baseline  : the committed CI baseline (baseline-wrapper object). If the file
//               is missing, this prints a "no baseline committed yet" note and
//               exits 0 (so a first run on a new image doesn't hard-fail).
// --strict    : exit 1 when there are regressions or new failing fixtures.
// --summary   : write the Markdown report here (append if it's $GITHUB_STEP_SUMMARY).
// --label     : a short label for the report heading (e.g. "macos / unicode").
// --env       : this run's environment fingerprint (scripts/run-env.mjs). When it
//               differs from the baseline's, the report says so FIRST — a
//               difference measured across two environments is not evidence about
//               the code, and reading it as one has cost this project five wrong
//               attributions on a single fixture.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

import { envComparability } from "./run-env.mjs";

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

// DM-1926: refuse to grade a result set that is not describing the same corpus.
//
// A comparison of the wrong suite's results against this baseline is not a
// regression report, it is a category error — and it renders as one of the most
// alarming things this script can print ("Dropped: 818"), which reads as though
// the change deleted the fixture corpus. The reverse pairing is worse: a clean
// wrong-run verdict is indistinguishable from a real pass.
//
// It happened by dispatching the unicode and html sweeps seconds apart, which
// made the client-side run lookup attach to the wrong one. That lookup is fixed
// too, but this guard is the one that holds for any cause — a mis-staged
// artifact, a truncated download, a baseline for another suite.
//
// The threshold is deliberately loose. Suites genuinely gain and lose fixtures,
// so a few percent of drift is ordinary; what it must catch is two corpora that
// barely intersect. Measured on the real collision: 0 of 818 baseline fixtures
// present, out of a 295-fixture run.
//
// The size floor is not a fudge to keep a test green. Below a couple of dozen
// fixtures "no overlap" stops being evidence of anything — one renamed fixture
// produces it — and the inputs that small are smoke tests and single-fixture
// probes, where this failing first would mask the error they are actually
// exercising. Real sweeps are 295 (html) and 818 (unicode).
const CORPUS_MIN = 25;
const overlap = [...baseline.keys()].filter((n) => current.has(n)).length;
if (baseline.size >= CORPUS_MIN && current.size >= CORPUS_MIN
    && overlap < Math.min(baseline.size, current.size) * 0.5) {
  console.error(
    `FATAL: this result set does not describe the baseline's corpus — only ${overlap} of `
    + `${baseline.size} baseline fixtures are present (${current.size} in the run).\n`
    + `  Baseline: ${baselinePath}\n`
    + "  Most likely the staged results are from a DIFFERENT suite's run. Re-stage the\n"
    + "  intended run explicitly:  node tools/run-ci-visual-tests.mjs --suite <s> --run-id <id>",
  );
  process.exit(2);
}

const curFails = [...current.values()].filter(isFail).length;
const baseFails = [...baseline.values()].filter(isFail).length;

const md = [heading, ""];
const metaBits = [];
if (meta.image) metaBits.push(`image \`${meta.image}\``);
if (meta.commit) metaBits.push(`baseline commit \`${String(meta.commit).slice(0, 8)}\``);
if (meta.capturedAt) metaBits.push(`captured ${meta.capturedAt}`);
if (metaBits.length) md.push(`Baseline: ${metaBits.join(" · ")}`, "");

// Environment drift comes FIRST, above the counts, because it changes what every
// number below means. `macos-latest` rotating mid-rollout put one shard on macOS
// 26.4 and the rest on 26.5.2; Chrome's fallback for U+2090-U+2093 differs
// between them, so one fixture swung 4x with no code change and was blamed on
// five successive commits. `meta.image` could not see it — `ImageOS` is
// `macOS26` on both.
const envPath = arg("--env", null);
let runEnv = null;
if (envPath != null && existsSync(envPath)) {
  try { runEnv = JSON.parse(readFileSync(envPath, "utf8")); } catch { runEnv = null; }
}
const envReasons = envComparability(runEnv, meta.env ?? null);
if (envReasons.length > 0) {
  md.push(
    "> ⚠️ **This run was measured in a DIFFERENT environment than the baseline.**",
    "> Differences below may be environmental rather than code changes — Chrome's own",
    "> font selection moves with the OS. Re-capture the baseline on the current image",
    "> before attributing anything here to a commit.",
    "",
    ...envReasons.map((r) => `> - ${r}`),
    "",
  );
} else if (runEnv != null && meta.env == null) {
  md.push(
    "> ℹ️ The baseline predates environment recording, so this run and it cannot be",
    "> confirmed comparable. Re-capture the baseline to enable the check.",
    "",
  );
}

md.push(`**${curFails} failing now vs ${baseFails} in baseline.** ` +
  `${regressions.length} regression(s), ${fixes.length} fix(es), ` +
  `${newFailing.length} new failing fixture(s), ${dropped.length} dropped.`, "");

function table(title, rows, withBase) {
  if (rows.length === 0) return;
  md.push(`### ${title} (${rows.length})`, "");
  md.push(withBase
    ? "| fixture | moved | diff% now | worstTile% now | diff% base | worstTile% base |"
    : "| fixture | diff% | worstTile% | regions |");
  md.push(withBase ? "|---|---|---|---|---|---|" : "|---|---|---|---|");
  for (const { name, cur, base } of rows) {
    const cd = (cur?.diffPct ?? 0).toFixed(3);
    const cw = (cur?.worstTilePct ?? 0).toFixed(2);
    if (withBase) {
      const bd = (base?.diffPct ?? 0).toFixed(3);
      const bw = (base?.worstTilePct ?? 0).toFixed(2);
      md.push(`| ${name} | ${movedLabel(cur, base)} | ${cd} | ${cw} | ${bd} | ${bw} |`);
    } else {
      const reg = cur?.regionCount ?? "?";
      md.push(`| ${name} | ${cd} | ${cw} | ${reg} |`);
    }
  }
  md.push("");
}

// DM-1874: which SIDE moved.
//
// The stored number is the distance between Chrome's expected.png and our
// actual — it rises when EITHER moves, and the report could not say which. One
// investigation was spent bisecting a "regression" that turned out to be Chrome
// painting U+2090–U+2093 from a different face on one CI run: our output was
// unchanged, Chrome's differed by 607 px.
//
// The digests are deliberately lossy (see src/review/side-digest.ts) because CI
// raster is not bit-stable — the same commit differed by 280 px of antialiasing
// between two runs, so a content hash would report "changed" every time and
// classify nothing.
// Byte hashes upgrade attribution where they exist (recorded per side since the
// bimodal-fixture investigation; mirrors `attributeMovementWithBytes` in
// src/review/side-digest.ts, which plain-node scripts cannot import — keep the
// two in agreement). The rule that matters: **a byte-identical side is
// exonerated outright.** The metric is a pure function of the two images, so if
// one input's bytes did not change, the movement can only have come from the
// other side — even when that other side's change sits below the perceptual
// digest's floor. That exact case pinned a Chrome-side flip on a CI runner:
// expected.png differed across two runs of one commit, actual.png was
// byte-identical, and all four perceptual digests were EQUAL. Digest-only
// attribution printed "unattributed" for it.
function movedLabel(cur, base) {
  const eb = base?.expectedDigest, ea = cur?.expectedDigest;
  const ab = base?.actualDigest, aa = cur?.actualDigest;
  const ebs = base?.expectedSha256, eas = cur?.expectedSha256;
  const abs = base?.actualSha256, aas = cur?.actualSha256;
  const expBytesSame = !!ebs && !!eas && ebs === eas;
  const actBytesSame = !!abs && !!aas && abs === aas;
  if (expBytesSame && actBytesSame) return "neither ✓ (both byte-identical — suspect the comparator)";
  if (expBytesSame) return "renderer ✓ (expected byte-identical)";
  if (actBytesSame) return "**oracle** ✓ (actual byte-identical)";
  // No side proven unchanged — fall back to the lossy digests.
  // A missing digest on either side means an older baseline, or the byte-equal
  // fast path which records none. Report that as unknown rather than guessing —
  // manufacturing confidence here is the exact failure this exists to remove.
  if (!eb || !ea || !ab || !aa) return "—";
  const expMoved = eb !== ea;
  const actMoved = ab !== aa;
  if (expMoved && actMoved) return "both";
  if (expMoved) return "**oracle**";
  if (actMoved) return "renderer";
  // Neither DIGEST moved yet the metric did. Two readings stay open, and for a
  // small movement the second is likelier: a comparator that is not a pure
  // function of the two images, OR a real change below the digest's sensitivity
  // floor (measured: an AA-magnitude move worth ~0.007 diffPct registers as zero
  // cells — see src/review/side-digest.ts). This label means "could not
  // attribute", NOT "the images are identical".
  return "⚠︎ unattributed";
}

const oracleSide = regressions.filter((r) => movedLabel(r.cur, r.base).startsWith("**oracle**"));
if (oracleSide.length > 0) {
  md.push(
    `> **${oracleSide.length} of ${regressions.length} regression(s) are ORACLE-SIDE** — Chrome's expected.png`
    + " moved and our output did not, so these are not code regressions. Re-capturing the baseline is the fix;"
    + " bisecting is not.", "",
    "_" + oracleSide.map((r) => r.name).join(", ") + "_", "",
  );
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
