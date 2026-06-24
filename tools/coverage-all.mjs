#!/usr/bin/env node
/**
 * Merged coverage (DM-1343). `npm run test:coverage` reflects only the vitest
 * unit suite, so the big render modules read as under-covered even though the
 * bespoke VISUAL suites (standalone tsx harnesses, NOT vitest) exercise them
 * hard. This script runs the unit suite AND the fast visual suites under one
 * shared `NODE_V8_COVERAGE` dir, then merges them into a single report with
 * `c8` — the one true number per CLAUDE.md's "merge all coverage" convention.
 *
 * It does NOT run the slow/CI-bound html-test or unicode sweeps (those shard on
 * CI); it covers the unit suite + features + showcase + snapshot-isolation +
 * animate-examples, which together hit the render pipeline broadly.
 *
 *   node tools/coverage-all.mjs            # text-summary + html report
 *   node tools/coverage-all.mjs --html-open
 *
 * vitest runs under `--pool=forks` so each test file is a child process that
 * flushes its own V8 profile into the shared dir (the default threads pool
 * shares one isolate and wouldn't dump per-file coverage).
 */
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = resolve(ROOT, "coverage/.v8-all");
const REPORTS = resolve(ROOT, "coverage/all");

// Each entry runs under NODE_V8_COVERAGE=TMP, accumulating raw V8 profiles.
const RUNS = [
  { label: "unit (vitest, forks)", cmd: "npx", args: ["vitest", "run", "--pool=forks"] },
  { label: "visual: features", cmd: "npx", args: ["tsx", "tests/features.ts"] },
  { label: "visual: showcase", cmd: "npx", args: ["tsx", "tests/showcase.tsx"] },
  { label: "visual: snapshot-isolation", cmd: "npx", args: ["tsx", "tests/snapshot-isolation.tsx"] },
  { label: "visual: animate-examples", cmd: "npx", args: ["tsx", "tests/animate-examples.tsx"] },
];

// Mirror the vitest.config.ts coverage include/exclude so the merged number is
// comparable to `npm run test:coverage`.
const REPORT_ARGS = [
  "c8", "report",
  `--temp-directory=${TMP}`,
  `--reports-dir=${REPORTS}`,
  "--all",
  "--src=src",
  "--include=src/**/*.ts",
  "--include=src/**/*.tsx",
  "--exclude=**/*.test.ts",
  "--exclude=**/*.test.tsx",
  "--exclude=**/*.generated.ts",
  "--exclude=src/capture/script/**",
  "--exclude=src/test-support/**",
  "--exclude=**/*.d.ts",
  "--reporter=text-summary",
  "--reporter=html",
];

function run(label, cmd, args, env) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.stdout.write(`  (${label} exited ${r.status} — coverage still collected)\n`);
  return r.status;
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const env = { ...process.env, NODE_V8_COVERAGE: TMP };

for (const { label, cmd, args } of RUNS) run(label, cmd, args, env);

process.stdout.write(`\n▶ merging coverage → ${REPORTS}\n`);
// Report without NODE_V8_COVERAGE in env (don't instrument the reporter itself).
const status = run("c8 report", "npx", REPORT_ARGS, process.env);
process.stdout.write(`\nHTML report: ${REPORTS}/index.html\n`);
process.exit(status ?? 0);
