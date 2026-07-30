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
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
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
// The hinting-preserving hb-subset embedded path is DEFAULT-ON in the renderer
// (opt out with DOMOTION_HINTED_SUBSET=0). --no-hinted-subset dispatches the
// svg2ttf-only arm for A/B measurement; --hinted-subset is accepted as a no-op
// for backward compatibility.
const hintedSubset = process.argv.includes("--no-hinted-subset") ? "0" : "";
// DM-1852: the per-codepoint CoreText fallback base — ask CoreText for a
// substitute FROM the run's own primary the way Blink does. DEFAULT-ON in the
// renderer; --no-fallback-base dispatches the old hardcoded-"Helvetica" arm for
// A/B (--fallback-base is accepted as a no-op for backward compatibility).
// Both arms run from the SAME pushed ref so the flag is the only difference —
// diffing an armed run against the committed baseline instead would conflate it
// with whatever landed on main since that baseline was taken.
const fallbackBase = process.argv.includes("--no-fallback-base") ? "0" : "";
// DM-1868: Blink's kSystemFonts order (OS first, static chain as the net).
// DEFAULT-ON in the renderer; --no-live-fallback-first dispatches the old
// static-chain-first arm for A/B (--live-fallback-first is a no-op, kept for
// backward compatibility with the pre-flip A/B invocations).
const liveFallbackFirst = process.argv.includes("--no-live-fallback-first") ? "0" : "";
// DM-1859: a `system-ui` run's per-codepoint cascade is walked from the CoreText
// UI font (`CTFontCreateUIFontForLanguage`), the way `MatchSystemUIFont` builds
// it. DEFAULT-ON in the renderer; --no-system-ui-base dispatches the old
// non-UI-base arm for A/B. Only meaningful with live-fallback-first ON: with the
// static per-block chain answering first, the OS is never asked, so the base it
// would have been asked with cannot matter (measured: 55 rows out of 83,838).
const systemUiBase = process.argv.includes("--no-system-ui-base") ? "0" : "";
let ref = arg("--ref", null);
// DM-1661: by default the review staging is METADATA-ONLY — download just the
// tiny pre-merged `visual-tests-merged` artifact (results-<os>.json) and let the
// review server lazy-fetch image shards on demand. `--eager` restores the old
// behavior: download every shard's images upfront (~GBs) and stage them.
const eager = process.argv.includes("--eager");
// --run-id <id>: skip dispatch/watch and re-stage an ALREADY-COMPLETED run. Use
// when a run finished but this driver gave up downloading (the artifacts finalize
// after `gh run watch` returns and a large multi-shard upload can outlast the
// retry window). Re-stages from the existing artifacts without burning a new run.
const runIdOverride = arg("--run-id", null);

if (!["unicode", "html"].includes(suite)) die(`--suite must be unicode|html (got ${suite})`);
if (!["macos", "linux", "windows", "all"].includes(os)) die(`--os must be macos|linux|windows|all (got ${os})`);

// gh present?
try { sh("gh", ["--version"]); } catch { die("GitHub CLI `gh` not found — install it (https://cli.github.com) and `gh auth login`."); }

// Resolve ref to the current branch and confirm the remote has this exact commit
// (CI runs the pushed ref, NOT your local working tree). Skipped in --run-id mode
// (the run is already done; we're only re-staging its artifacts).
if (ref == null) {
  try { ref = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { die("not in a git repo / cannot resolve current branch"); }
}
const localSha = sh("git", ["rev-parse", "HEAD"]);
if (runIdOverride == null) {
  let remoteSha = "";
  try { remoteSha = sh("git", ["rev-parse", `origin/${ref}`]); } catch { /* branch not on origin */ }
  if (remoteSha !== localSha) {
    die(`origin/${ref} ${remoteSha ? `is at ${remoteSha.slice(0, 8)} but HEAD is ${localSha.slice(0, 8)}` : "does not exist"}.\n` +
        `  Push first:  git push -u origin ${ref}\n  (CI runs the pushed ref, not your local changes.)`);
  }
}

// The dispatched run takes a few seconds to register. Poll for the newest run on
// this ref created at/after dispatch.
async function findRunId(dispatchAt) {
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

let runId;
let url;
if (runIdOverride != null) {
  runId = runIdOverride;
  url = sh("gh", ["run", "view", String(runId), "--json", "url", "-q", ".url"]);
  console.log(`Re-staging existing run ${runId}: ${url}\n(skipping dispatch/watch — downloading finalized artifacts)\n`);
} else {
  console.log(`Dispatching ${WORKFLOW} — ref=${ref} os=${os} suite=${suite} shards=${shards}${only ? ` only=${only}` : ""}${hintedSubset === "0" ? " hinted-subset=OFF" : ""}${fallbackBase === "0" ? " fallback-base=OFF" : ""}${liveFallbackFirst === "0" ? " live-fallback-first=OFF" : ""}${systemUiBase === "0" ? " system-ui-base=OFF" : ""}`);
  const dispatchAt = new Date();
  sh("gh", ["workflow", "run", WORKFLOW, "--ref", ref,
    "-f", `os=${os}`, "-f", `suite=${suite}`, "-f", `shards=${shards}`, "-f", `only=${only}`,
    "-f", `hinted_subset=${hintedSubset}`,
    "-f", `fallback_base=${fallbackBase}`,
    "-f", `live_fallback_first=${liveFallbackFirst}`,
    "-f", `system_ui_base=${systemUiBase}`]);
  runId = await findRunId(dispatchAt);
  if (runId == null) die("could not find the dispatched run — check `gh run list` / Actions tab.");
  url = sh("gh", ["run", "view", String(runId), "--json", "url", "-q", ".url"]);
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
}

const dir = mkdtempSync(join(tmpdir(), "visual-tests-"));
const downloadPattern = eager ? "results-*" : "visual-tests-meta";
console.log(`\nDownloading ${eager ? "shard image artifacts" : "merged metadata (lazy — images fetched on demand in the review UI)"} to ${dir} …`);
// Artifacts finalize AFTER `gh run watch` returns, and large multi-shard
// uploads can take several minutes to become downloadable — `gh run download`
// errors until then. Retry over a ~6-minute window (DM-1228: a 25 s window was
// too short; a 3-min window then also gave up on an `--os all` run whose 116 MB
// `visual-tests-merged` artifact was still uploading — re-stage that run with
// `--run-id <id>` rather than re-dispatching). The run may also have genuinely
// failed before any shard uploaded, in which case every attempt errors.
let downloaded = false;
const MAX_ATTEMPTS = 36, RETRY_MS = 10000;
for (let attempt = 0; attempt < MAX_ATTEMPTS && !downloaded; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
  // `gh run download` errors with "file exists" if a prior partial extraction
  // left files behind, so start each attempt from a clean dir.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    // NOT via sh(): sh() does `.trim()` on the return, but with stdio:"inherit"
    // execFileSync returns null → `.trim()` throws a TypeError the catch below
    // would mis-report as "artifacts not ready" even when the download SUCCEEDED.
    execFileSync("gh", ["run", "download", String(runId), "--dir", dir, "--pattern", downloadPattern], { stdio: "inherit" });
    downloaded = true;
  } catch { process.stdout.write(`  (artifacts not ready yet, retrying… ${attempt + 1}/${MAX_ATTEMPTS})\n`); }
}
if (!downloaded) die(`no artifacts to download after ~${Math.round(MAX_ATTEMPTS * RETRY_MS / 60000)} min of retries — the run may have failed before any shard finished (see ${url}).`);

const here = new URL("..", import.meta.url).pathname;
if (eager) {
  console.log(`\nMerging shards…\n`);
  execFileSync("node", [join(here, "scripts/merge-shard-results.mjs"), "--input", dir], { stdio: "inherit" });
} else {
  // The `visual-tests-meta` artifact carries the SLIM, PNG-free, shard-annotated
  // results-<os>.slim.json (DM-1662). Flatten them to `dir/results-<os>.json` so
  // the baseline diff + staging below find them.
  const metaSub = join(dir, "visual-tests-meta");
  const srcDir = existsSync(metaSub) ? metaSub : dir;
  let found = 0;
  for (const name of readdirSync(srcDir)) {
    const m = /^results-([a-z0-9]+)\.slim\.json$/i.exec(name);
    if (m != null) { copyFileSync(join(srcDir, name), join(dir, `results-${m[1].toLowerCase()}.json`)); found++; }
  }
  if (found === 0) die(`no results-<os>.slim.json in the visual-tests-meta artifact — run ${runId} may not have reached the aggregate job (see ${url}).`);
  console.log(`\nUsing CI slim metadata (${found} OS result set${found === 1 ? "" : "s"}); images fetched lazily on review.\n`);
}

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

// DM-1803: resolve the `domotion-ci-images` branch tip for <suite>-<os>, but
// only return it when that commit's meta.json names THIS run — see the call
// site. Returns null on any doubt (branch absent, gh unavailable, meta
// unreadable, different run), which makes the review server take its existing
// whole-shard fallback instead of serving another run's images.
function resolveImagesSha(ciSuite, stageOs, wantRunId) {
  const CI_IMAGES_REPO = "brianwestphal/domotion-ci-images";
  const gh = (path) => execFileSync("gh", ["api", path, "--jq", ".content"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const sha = execFileSync("gh", ["api",
      `repos/${CI_IMAGES_REPO}/git/refs/heads/${ciSuite}-${stageOs}`, "--jq", ".object.sha"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const meta = JSON.parse(Buffer.from(
      gh(`repos/${CI_IMAGES_REPO}/contents/meta.json?ref=${sha}`), "base64").toString("utf8"));
    return String(meta.runId) === String(wantRunId) ? sha : null;
  } catch { return null; }
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
    const mergedJson = join(dir, `results-${stageOs}.json`);
    if (!existsSync(mergedJson)) continue; // this OS produced no results
    const dest = join(here, "tests/output/review", `ci-${stageOs}`, suiteDir);
    // Fresh snapshot per download so a prior run's cached images/metadata don't linger.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // Metadata (always) + the lazy-fetch pointer so the review server can pull
    // images on demand for THIS run.
    copyFileSync(mergedJson, join(dest, "results.json"));
    // DM-1803: resolve the `domotion-ci-images` commit sha for this run and put
    // it in the pointer. The review server keys its transport off exactly this
    // field: with a `sha` it fetches individual PNGs from the CDN (~0.2-0.7 s
    // cold); without one it falls back to `gh run download` of a WHOLE shard
    // (hundreds of MB), during which every image request 503s and the UI reads
    // "image unavailable". Staging without it therefore DOWNGRADED the source
    // that `/api/refresh-source` (the ↻ button) would have set up correctly —
    // a dispatch made the review experience worse than not dispatching.
    //
    // Only adopt the sha when the branch actually holds THIS run: a partial
    // `--only` dispatch never pushes images, so the branch tip still describes
    // an older run and pointing at it would serve stale pictures under this
    // run's metrics. Verified against the branch's own meta.json rather than
    // assumed from the absence of `--only`, so a skipped or failed push is
    // caught too — omitting the field is safe (it just takes the slow path).
    const imagesSha = resolveImagesSha(suite, stageOs, String(runId));
    writeFileSync(join(dest, ".ci-source.json"), JSON.stringify(
      { runId: String(runId), os: stageOs, suite, ...(imagesSha != null ? { sha: imagesSha } : {}) }, null, 2));
    let pngs = 0;
    if (eager) {
      for (const name of readdirSync(dir)) {
        const m = /^results-([a-z0-9]+)-shard\d+$/i.exec(name);
        if (m == null || m[1].toLowerCase() !== stageOs) continue;
        const shardDir = join(dir, name);
        for (const f of readdirSync(shardDir)) {
          if (f.endsWith(".png") || f.endsWith(".svg")) { copyFileSync(join(shardDir, f), join(dest, f)); pngs++; }
        }
      }
    }
    staged.push(stageOs);
    console.log(`  staged tests/output/review/ci-${stageOs}/${suiteDir}/ — metadata${eager ? ` + ${pngs} images` : " (images fetched lazily on first view)"}`);
  }
  if (staged.length > 0) {
    console.log(`\nReview in the local UI (toggle Source → “CI · ${staged.map((o) => o[0].toUpperCase() + o.slice(1)).join("” / “CI · ")}”):`);
    console.log(`  npm run demos:review`);
  }
}
console.log(`\nRaw shard artifacts: ${dir}/results-<os>-shard*/`);
console.log(`Run page: ${url}`);
