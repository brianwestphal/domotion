#!/usr/bin/env node
/**
 * Merged coverage (DM-1343). `npm run test:coverage` reflects only the vitest
 * unit suite, so the big render modules read as under-covered even though the
 * bespoke VISUAL suites (standalone tsx harnesses, NOT vitest) exercise them
 * hard. This script runs the unit suite AND the visual suites under one shared
 * `NODE_V8_COVERAGE` dir, then merges them into a single report with `c8` — the
 * one true number per CLAUDE.md's "merge all coverage" convention.
 *
 *   node tools/coverage-all.mjs            # FAST: unit + features + showcase +
 *                                          #   snapshot-isolation + animate-examples
 *   node tools/coverage-all.mjs --full     # FULL: also the broad html-test +
 *                                          #   unicode + real-world sweeps
 *
 * Default (fast) covers the render pipeline broadly in ~minutes. `--full` adds
 * the ~277 external/html-test fixtures, the 331 per-Unicode-block fixtures, and
 * the real-world HAR replays — which push the font/text/render modules much
 * higher (they exercise the fallback chains, shaping, and per-block routing the
 * fast suites barely touch) but take the better part of an hour locally (the
 * same reason CLAUDE.md shards those sweeps on CI). `--full` runs only the
 * sweeps whose fixture checkouts are present, skipping (with a warning) any that
 * aren't cloned. Even `--full` won't reach 100%: platform-specific branches
 * (Linux/Windows font extractors, the `<text>`-fallback path) don't execute on a
 * single macOS run.
 *
 * vitest runs under `--pool=forks` so each test file is a child process that
 * flushes its own V8 profile into the shared dir (the default threads pool
 * shares one isolate and wouldn't dump per-file coverage).
 */
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = resolve(ROOT, "coverage/.v8-all");
const REPORTS = resolve(ROOT, "coverage/all");
const FULL = process.argv.includes("--full");

// Fast suites — always run. Each runs under NODE_V8_COVERAGE=TMP, accumulating
// raw V8 profiles that c8 merges at the end.
const RUNS = [
  { label: "unit (vitest, forks)", cmd: "npx", args: ["vitest", "run", "--pool=forks"] },
  { label: "visual: features", cmd: "npx", args: ["tsx", "tests/features.ts"] },
  { label: "visual: showcase", cmd: "npx", args: ["tsx", "tests/showcase.tsx"] },
  { label: "visual: snapshot-isolation", cmd: "npx", args: ["tsx", "tests/snapshot-isolation.tsx"] },
  { label: "visual: animate-examples", cmd: "npx", args: ["tsx", "tests/animate-examples.tsx"] },
];

// Slow sweeps — only with --full, and only when their fixture checkout exists.
// `needs` is a path (ROOT-relative or absolute) that must exist to run; when it
// doesn't we skip with a warning rather than fail.
const SLOW_RUNS = [
  { label: "visual: html-test (~277 fixtures)", cmd: "npx", args: ["tsx", "tests/html-test-suite.tsx"], needs: "external/html-test" },
  {
    label: "visual: unicode (331 per-block fixtures)", cmd: "npx", args: ["tsx", "tests/html-test-suite.tsx"],
    needs: process.env.HTML_TEST_DIR ?? "../html-test/unicode",
    env: { HTML_TEST_DIR: process.env.HTML_TEST_DIR ?? "../html-test/unicode", HTML_TEST_OUTPUT_DIR: "tests/output/html-test-unicode" },
  },
  { label: "visual: real-world (HAR replays)", cmd: "npx", args: ["tsx", "tests/real-world.tsx"], needs: "tests/cache/real-world" },
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

const runs = [...RUNS];
if (FULL) {
  process.stdout.write("--full: adding the broad sweeps (this takes the better part of an hour)\n");
  for (const r of SLOW_RUNS) {
    const needsPath = resolve(ROOT, r.needs);
    if (existsSync(needsPath)) runs.push(r);
    else process.stdout.write(`  ⚠ skipping ${r.label} — fixtures not found at ${r.needs} (clone it to include)\n`);
  }
} else {
  process.stdout.write("fast mode (default). Use --full to also run the html-test + unicode + real-world sweeps.\n");
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const baseEnv = { ...process.env, NODE_V8_COVERAGE: TMP };

for (const r of runs) run(r.label, r.cmd, r.args, r.env != null ? { ...baseEnv, ...r.env } : baseEnv);

process.stdout.write(`\n▶ merging coverage → ${REPORTS}\n`);
// Report without NODE_V8_COVERAGE in env (don't instrument the reporter itself).
const status = run("c8 report", "npx", REPORT_ARGS, process.env);
process.stdout.write(`\nHTML report: ${REPORTS}/index.html\n`);
process.exit(status ?? 0);
