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
import { mkdtempSync } from "node:fs";
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
// Artifacts finalize a few seconds AFTER `gh run watch` returns, so retry the
// download a handful of times before giving up (the run may also have failed
// before any shard uploaded, in which case there genuinely is nothing).
let downloaded = false;
for (let attempt = 0; attempt < 6 && !downloaded; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 5000));
  try {
    sh("gh", ["run", "download", String(runId), "--dir", dir, "--pattern", "results-*"], { stdio: "inherit" });
    downloaded = true;
  } catch { process.stdout.write(downloaded ? "" : "  (artifacts not ready yet, retrying…)\n"); }
}
if (!downloaded) die(`no artifacts to download after retries — the run may have failed before any shard finished (see ${url}).`);

console.log(`\nMerging…\n`);
const here = new URL("..", import.meta.url).pathname;
execFileSync("node", [join(here, "scripts/merge-shard-results.mjs"), "--input", dir], { stdio: "inherit" });
console.log(`\nDiff crops for failing fixtures (if any) are under: ${dir}/results-<os>-shard*/`);
console.log(`Run page: ${url}`);
