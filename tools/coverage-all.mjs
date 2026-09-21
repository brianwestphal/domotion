#!/usr/bin/env node
/**
 * Merged coverage (DM-1343). `npm run test:coverage` reflects only the vitest
 * unit suite, so the big render modules read as under-covered even though the
 * browser E2Es and bespoke VISUAL suites exercise them hard. This script runs
 * the unit suite, browser E2Es, AND visual suites. Vitest emits Istanbul maps
 * for its Vite-transformed modules, direct tsx runners accumulate raw profiles
 * under `NODE_V8_COVERAGE` for c8, and Playwright's V8 ranges are remapped to
 * the source-mapped browser client entry points. The four maps are merged into
 * the one true number per CLAUDE.md's "merge all coverage" convention.
 *
 *   node tools/coverage-all.mjs            # FAST: unit + browser E2E + features +
 *                                          #   showcase + snapshot-isolation +
 *                                          #   animate-examples
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
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCoverage, formatCoverageSummary } from "./coverage-summary.mjs";
import { coverageCommandExitStatus, normalizeCoverageExitStatus } from "./coverage-exit-status.mjs";
import { mergeCoverageFiles, writeCoverageReports } from "./coverage-map.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PARTS = resolve(ROOT, "coverage/.all-parts");
const TMP = resolve(PARTS, "direct-v8");
const DIRECT_REPORTS = resolve(PARTS, "direct");
const UNIT_REPORTS = resolve(PARTS, "vitest-unit");
const E2E_REPORTS = resolve(PARTS, "vitest-e2e");
const BROWSER_V8 = resolve(PARTS, "browser-v8");
const BROWSER_REPORTS = resolve(PARTS, "browser");
const REPORTS = resolve(ROOT, "coverage/all");
const FULL = process.argv.includes("--full");
const BROWSER_INSTRUMENTATION_OMISSIONS = {};

// Fast suites — always run. Vitest lanes produce their own remapped Istanbul
// JSON; direct tsx lanes run under NODE_V8_COVERAGE and are converted by c8.
const RUNS = [
  {
    label: "unit (vitest, forks)",
    cmd: "npx",
    args: [
      "vitest", "run", "--pool=forks", "--coverage",
      "--coverage.reporter=json", "--coverage.reportOnFailure",
      `--coverage.reportsDirectory=${UNIT_REPORTS}`,
    ],
    vitestCoverage: true,
  },
  {
    label: "browser E2E (vitest, forks, headless)",
    cmd: "npx",
    args: [
      "vitest", "run", "--config", "vitest.e2e.config.ts",
      // This dedicated preference/profile oracle intentionally launches the
      // installed Chrome channel both headed and headless. Its own workflow and
      // npm script remain authoritative; a coverage run must not open a user's
      // real browser.
      "--exclude", "tests/generic-profile-target-oracle.e2e.test.ts",
      "--coverage", "--coverage.reporter=json", "--coverage.reportOnFailure",
      `--coverage.reportsDirectory=${E2E_REPORTS}`,
    ],
    env: {
      DOMOTION_HELPER_NO_SERVE: "1",
      REVIEW_NO_OPEN: "1",
      DOMOTION_BROWSER_COVERAGE: "1",
      DOMOTION_BROWSER_COVERAGE_DIR: BROWSER_V8,
    },
    vitestCoverage: true,
  },
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
  `--reports-dir=${DIRECT_REPORTS}`,
  "--src=src",
  "--include=src/**/*.ts",
  "--include=src/**/*.tsx",
  "--exclude=**/*.test.ts",
  "--exclude=**/*.test.tsx",
  "--exclude=**/*.generated.ts",
  "--exclude=src/capture/script/**",
  "--exclude=src/test-support/**",
  "--exclude=**/*.d.ts",
  "--reporter=json",
];

function run(label, cmd, args, env) {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env, shell: process.platform === "win32" });
  const status = normalizeCoverageExitStatus(r.status);
  if (status !== 0) {
    const reason = r.status == null ? (r.error?.message ?? `terminated by ${r.signal ?? "an unknown signal"}`) : `exited ${r.status}`;
    process.stdout.write(`  (${label} ${reason} — coverage still collected, final command will fail)\n`);
  }
  return status;
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

rmSync(PARTS, { recursive: true, force: true });
rmSync(REPORTS, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(BROWSER_V8, { recursive: true });
// Coverage includes browser E2Es plus several visual runners. Keep every child
// process non-interactive even if an individual command forgets `--no-open`.
const baseEnv = { ...process.env, NODE_V8_COVERAGE: TMP, DOMOTION_NO_OPEN: "1" };

const browserBuildResults = ["review", "scrubber", "studio"].map((client) => ({
  label: `browser coverage bundle: ${client}`,
  status: run(
    `browser coverage bundle: ${client}`,
    "node",
    [`scripts/build-${client}-client.mjs`],
    { ...process.env, DOMOTION_BROWSER_COVERAGE: "1" },
  ),
}));

const suiteResults = [...browserBuildResults, ...runs.map((r) => ({
  label: r.label,
  status: run(
    r.label,
    r.cmd,
    r.args,
    r.vitestCoverage
      ? { ...process.env, ...r.env, DOMOTION_NO_OPEN: "1" }
      : (r.env != null ? { ...baseEnv, ...r.env } : baseEnv),
  ),
}))];

const browserConvertStatus = run(
  "browser V8 coverage → Istanbul",
  "node",
  [
    "tools/browser-coverage-to-istanbul.mjs",
    BROWSER_V8,
    resolve(BROWSER_REPORTS, "coverage-final.json"),
    "--require-client-sources",
  ],
  process.env,
);
for (const client of ["review", "scrubber", "studio"]) {
  const status = run(`restore production bundle: ${client}`, "node", [`scripts/build-${client}-client.mjs`], process.env);
  suiteResults.push({ label: `restore production bundle: ${client}`, status });
}

process.stdout.write(`\n▶ converting direct V8 coverage → ${DIRECT_REPORTS}\n`);
// Report without NODE_V8_COVERAGE in env (don't instrument the reporter itself).
const c8Status = run("c8 report", "npx", REPORT_ARGS, process.env);
let mergeStatus = 1;
try {
  const inputs = [UNIT_REPORTS, E2E_REPORTS, DIRECT_REPORTS, BROWSER_REPORTS]
    .map((directory) => resolve(directory, "coverage-final.json"))
    .filter((path) => existsSync(path));
  if (inputs.length === 0) throw new Error("no constituent coverage maps were produced");
  process.stdout.write(`\n▶ merging ${inputs.length} Istanbul coverage maps → ${REPORTS}\n`);
  writeCoverageReports(mergeCoverageFiles(inputs), REPORTS);
  mergeStatus = 0;
} catch (error) {
  process.stdout.write(`  (coverage merge failed: ${error instanceof Error ? error.message : String(error)})\n`);
}
const coverageJson = resolve(REPORTS, "coverage-final.json");
if (mergeStatus === 0 && existsSync(coverageJson)) {
  const summary = summarizeCoverage(
    JSON.parse(readFileSync(coverageJson, "utf8")),
    ROOT,
    BROWSER_INSTRUMENTATION_OMISSIONS,
  );
  writeFileSync(resolve(REPORTS, "directory-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${formatCoverageSummary(summary)}\n`);
}
process.stdout.write(`\nHTML report: ${REPORTS}/index.html\n`);
const failedSuites = suiteResults.filter((result) => result.status !== 0);
if (failedSuites.length > 0) {
  process.stdout.write(`\nRequired coverage suites failed:\n${failedSuites.map((result) => `  - ${result.label} (exit ${result.status})`).join("\n")}\n`);
}
process.exit(coverageCommandExitStatus(
  suiteResults.map((result) => result.status),
  c8Status !== 0 ? c8Status : browserConvertStatus !== 0 ? browserConvertStatus : mergeStatus,
));
