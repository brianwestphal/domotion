#!/usr/bin/env node
// DM-1216: one-command driver for the sharded visual-tests GitHub Actions
// workflow. Dispatches the run, waits for it, downloads the per-shard artifacts,
// merges them, and prints the pass/fail summary + the local path to the
// failing-fixture diff crops.
//
// Usage:
//   node tools/run-ci-visual-tests.mjs --suite unicode [--os macos] [--shards auto] [--only <filter>] [--ref <branch>]
//
// Policy (see docs/66-ci-visual-tests.md): reach for this only when a run needs
// >50 fixtures; default to macOS; use --os linux / windows only to debug a
// platform-specific issue. The workflow runs against a PUSHED ref, so commit +
// push first — this script refuses to dispatch a ref the remote doesn't have.

import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = "visual-tests.yml";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1); }

const suite = arg("--suite", "unicode");
const os = arg("--os", "macos");
const shards = arg("--shards", "auto");
const only = arg("--only", "");
let ref = arg("--ref", null);

if (!["unicode", "html"].includes(suite)) die(`--suite must be unicode|html (got ${suite})`);
if (!["macos", "linux", "windows", "all"].includes(os)) die(`--os must be macos|linux|windows|all (got ${os})`);

// gh present?
try { sh("gh", ["--version"]); } catch { die("GitHub CLI `gh` not found — install it (https://cli.github.com) and `gh auth login`."); }

// Resolve ref to the current branch and confirm the remote has this exact commit
// (CI runs the pushed ref, NOT your local working tree).
if (ref == null) {
  try { ref = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { die("not in a git repo / cannot resolve current branch"); }
}
const localSha = sh("git", ["rev-parse", "HEAD"]);
let remoteSha = "";
try { remoteSha = sh("git", ["rev-parse", `origin/${ref}`]); } catch { /* branch not on origin */ }
if (remoteSha !== localSha) {
  die(`origin/${ref} ${remoteSha ? `is at ${remoteSha.slice(0, 8)} but HEAD is ${localSha.slice(0, 8)}` : "does not exist"}.\n` +
      `  Push first:  git push -u origin ${ref}\n  (CI runs the pushed ref, not your local changes.)`);
}

console.log(`Dispatching ${WORKFLOW} — ref=${ref} os=${os} suite=${suite} shards=${shards}${only ? ` only=${only}` : ""}`);
const dispatchAt = new Date();
sh("gh", ["workflow", "run", WORKFLOW, "--ref", ref,
  "-f", `os=${os}`, "-f", `suite=${suite}`, "-f", `shards=${shards}`, "-f", `only=${only}`]);

// The dispatched run takes a few seconds to register. Poll for the newest run on
// this ref created at/after dispatch.
async function findRunId() {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    let json;
    try {
      json = sh("gh", ["run", "list", "--workflow", WORKFLOW, "--branch", ref, "-L", "10",
        "--json", "databaseId,createdAt,event,headSha"]);
    } catch { continue; }
    const runs = JSON.parse(json)
      .filter((r) => r.event === "workflow_dispatch" && r.headSha === localSha
        && new Date(r.createdAt).getTime() >= dispatchAt.getTime() - 5000)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (runs.length > 0) return runs[0].databaseId;
    process.stdout.write(".");
  }
  return null;
}

const runId = await findRunId();
if (runId == null) die("could not find the dispatched run — check `gh run list` / Actions tab.");
const url = sh("gh", ["run", "view", String(runId), "--json", "url", "-q", ".url"]);
console.log(`\nRun ${runId}: ${url}\nWatching (this can take a few minutes)…\n`);

// `gh run watch --exit-status` exits non-zero if the run concluded with failure.
// A fidelity diff legitimately fails the test jobs, so we DON'T treat that as
// fatal — we still download + merge + report.
await new Promise((resolve) => {
  const child = execFile("gh", ["run", "watch", String(runId), "--exit-status"], { encoding: "utf8" });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.on("close", () => resolve());
});

const dir = mkdtempSync(join(tmpdir(), "visual-tests-"));
console.log(`\nDownloading shard artifacts to ${dir} …`);
// Artifacts finalize AFTER `gh run watch` returns, and large multi-shard
// uploads (5 × ~20 MB) can take a couple of minutes to become downloadable —
// `gh run download` errors until then. Retry over a ~3-minute window (DM-1228:
// a 25 s window was too short and the first --update-baseline runs all gave up
// with valid artifacts sitting on the run). The run may also have genuinely
// failed before any shard uploaded, in which case every attempt errors.
let downloaded = false;
const MAX_ATTEMPTS = 18, RETRY_MS = 10000;
for (let attempt = 0; attempt < MAX_ATTEMPTS && !downloaded; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
  // `gh run download` errors with "file exists" if a prior partial extraction
  // left files behind, so start each attempt from a clean dir.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    sh("gh", ["run", "download", String(runId), "--dir", dir, "--pattern", "results-*"], { stdio: "inherit" });
    downloaded = true;
  } catch { process.stdout.write(`  (artifacts not ready yet, retrying… ${attempt + 1}/${MAX_ATTEMPTS})\n`); }
}
if (!downloaded) die(`no artifacts to download after ~${Math.round(MAX_ATTEMPTS * RETRY_MS / 60000)} min of retries — the run may have failed before any shard finished (see ${url}).`);

console.log(`\nMerging…\n`);
const here = new URL("..", import.meta.url).pathname;
execFileSync("node", [join(here, "scripts/merge-shard-results.mjs"), "--input", dir], { stdio: "inherit" });

// DM-1217: the macOS CI runner (macos-15-arm64) rasterizes text differently
// enough from a local Mac that the raw CI pass/fail COUNT does not transfer — so
// instead of comparing CI to local, diff this run against the committed CI
// baseline (tests/baselines/<suite>-<os>.json) and report regressions only. With
// --update-baseline, (re)write that committed baseline from this run.
const updateBaseline = process.argv.includes("--update-baseline");
console.log(`\nDiffing against committed CI baseline${updateBaseline ? " (and rewriting it)" : ""}…\n`);
execFileSync("node", [join(here, "scripts/ci-baseline-aggregate.mjs"),
  "--input", dir, "--suite", suite, "--commit", localSha, "--out", dir,
  ...(updateBaseline ? ["--update-baseline"] : [])],
  { cwd: here, stdio: "inherit" });
if (updateBaseline) {
  // ci-baseline-aggregate wrote baseline-<suite>-<os>.json into `dir`; move each
  // into the repo's tests/baselines/ so the user can review + commit it.
  for (const name of readdirSync(dir)) {
    const m = new RegExp(`^baseline-${suite}-([a-z0-9]+)\\.json$`, "i").exec(name);
    if (m == null) continue;
    const target = join(here, "tests/baselines", `${suite}-${m[1].toLowerCase()}.json`);
    mkdirSync(join(here, "tests/baselines"), { recursive: true });
    copyFileSync(join(dir, name), target);
    console.log(`  baseline updated: tests/baselines/${suite}-${m[1].toLowerCase()}.json  (review + commit)`);
  }
}

// --review (default ON): stage EACH OS's shard PNGs + .svg + merged results.json
// into its own review SOURCE folder — tests/output/review/ci-<os>/<suiteDir>/ —
// laid out the way tests/review-server.tsx expects. The review UI's source
// toggle (DM-1660: local-macos / ci-macos / ci-linux / ci-windows) then picks
// each up directly; no REVIEW_OUTPUT_DIR needed. `--os all` stages all three.
// Skipped with --no-review.
if (!process.argv.includes("--no-review")) {
  const suiteDir = suite === "unicode" ? "html-test-unicode" : "html-test";
  const osesToStage = os === "all" ? ["macos", "linux", "windows"] : [os];
  const staged = [];
  for (const stageOs of osesToStage) {
    const dest = join(here, "tests/output/review", `ci-${stageOs}`, suiteDir);
    // Fresh snapshot per download so a prior run's (possibly pruned) files don't linger.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    let pngs = 0;
    for (const name of readdirSync(dir)) {
      const m = /^results-([a-z0-9]+)-shard\d+$/i.exec(name);
      if (m == null || m[1].toLowerCase() !== stageOs) continue;
      const shardDir = join(dir, name);
      for (const f of readdirSync(shardDir)) {
        if (f.endsWith(".png") || f.endsWith(".svg")) { copyFileSync(join(shardDir, f), join(dest, f)); pngs++; }
      }
    }
    const mergedJson = join(dir, `results-${stageOs}.json`);
    if (existsSync(mergedJson)) copyFileSync(mergedJson, join(dest, "results.json"));
    if (pngs > 0) { staged.push(stageOs); console.log(`  staged ${pngs} files → tests/output/review/ci-${stageOs}/${suiteDir}/`); }
  }
  if (staged.length > 0) {
    console.log(`\nReview in the local UI (toggle Source → “CI · ${staged.map((o) => o[0].toUpperCase() + o.slice(1)).join("” / “CI · ")}”):`);
    console.log(`  npm run demos:review`);
  }
}
console.log(`\nRaw shard artifacts: ${dir}/results-<os>-shard*/`);
console.log(`Run page: ${url}`);
