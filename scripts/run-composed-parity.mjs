import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "tools/composed-parity-corpus.json"), "utf8"));
const resultPath = resolve(root, "tests/output/composed-parity-results.json");
mkdirSync(dirname(resultPath), { recursive: true });
const results = [];
const browserConditions = new Set();
let failed = false;

for (const fixture of manifest.repositoryFixtures) {
  // A fresh process per composed page is intentional. The corpus crosses
  // global font/image/gradient caches, iframe recursion, and replaced-surface
  // ownership; sharing one renderer session would turn its order into an
  // unrecorded eighth axis and has already exposed a post-gradient iframe
  // stall. The separate live E2E test owns deliberate state transitions.
  writeFileSync(resultPath, "", "utf8");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "tests/composed-parity.ts", "--only", fixture.name, "--workers", "1"],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (child.error != null) {
    console.error(`Unable to run ${fixture.name}: ${child.error.message}`);
    failed = true;
    continue;
  }
  if (child.status !== 0) failed = true;
  try {
    const report = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!Array.isArray(report.results) || report.results.length !== 1 || report.results[0]?.name !== fixture.name) {
      throw new Error("single-fixture result identity mismatch");
    }
    results.push(report.results[0]);
    if (typeof report.browsers === "string") browserConditions.add(report.browsers);
  } catch (error) {
    console.error(`Invalid result for ${fixture.name}: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

writeFileSync(resultPath, JSON.stringify({
  suite: "composed-parity",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  processIsolation: "fresh-process-per-fixture",
  browsers: [...browserConditions],
  corpus: manifest,
  results,
}, null, 2));

if (results.length !== manifest.repositoryFixtures.length || failed) process.exitCode = 1;
