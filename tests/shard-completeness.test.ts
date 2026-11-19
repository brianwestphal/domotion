/**
 * A merged sweep must be able to tell a complete run from a partial one.
 *
 * The case these pin, verbatim: a 5-way macOS unicode run lost shard 5 entirely.
 * The shard job ran to completion but produced no artifact, the aggregate merged
 * the other four, and the run reported "✅ No regressions vs the CI baseline"
 * over 655 of 818 fixtures. The loss is silent in the direction that matters —
 * the missing shard's failures are not there to be counted, so a regression
 * living in it reads as a clean pass. The 163 lost fixtures were Tibetan,
 * Kannada, Gurmukhi, Arabic Supplement, IPA Extensions: complex-script blocks,
 * i.e. exactly the ones a shaping change is most likely to disturb.
 *
 * It also produced a false A/B. Diffing that run against a complete one showed
 * "2 newly passing, 0 fixtures moved" — both artifacts of comparing only the
 * fixture names present in BOTH runs. The two "newly passing" fixtures were not
 * passing; they were absent.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

const SCRIPT = join(process.cwd(), "scripts/merge-shard-results.mjs");
// Measured inside a loaded full suite (docs/tool-child-process-test-bounds.md):
// the merge script used 0.07-0.09 s of CPU, while each filtered harness start
// (`node --import tsx tests/html-test-suite.tsx`) used 0.67-0.71 s idle and up
// to 1.11 s loaded, and took up to 16.7 s.
const MERGE_BUDGET_MS = budgetForCpuWork(100);
const HARNESS_BUDGET_MS = budgetForCpuWork(1_200);

/** Lay out `<dir>/results-<os>-shard<i>/results.json` the way CI does. */
function shardDir(root: string, os: string, shard: number, fixtures: string[]) {
  const d = join(root, `results-${os}-shard${shard}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "results.json"),
    JSON.stringify(fixtures.map((name) => ({ name, pass: true, skipped: false, diffPct: 0, regionCount: 0 }))),
  );
  writeFileSync(join(d, "run-env.json"), JSON.stringify({ image: "macos26-arm64", platform: "darwin" }));
  return d;
}

/** A successful zero-fixture shard has results.json: [] but may have no run-env. */
function emptyShardDir(root: string, os: string, shard: number) {
  const d = join(root, `results-${os}-shard${shard}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "results.json"), "[]\n");
}

async function runMerge(root: string, expectArg?: string) {
  const args = [SCRIPT, "--input", root, "--out", root, "--summary", join(root, "summary.md")];
  if (expectArg != null) args.push("--expect", expectArg);
  const result = await runBoundedChild(process.execPath, args, { budgetMs: MERGE_BUDGET_MS });
  // A merge that was stopped or never started has no exit code to judge.
  expect(result.error, describeChild(result)).toBeNull();
  return {
    code: result.status ?? 1,
    summary: existsSync(join(root, "summary.md")) ? readFileSync(join(root, "summary.md"), "utf-8") : "",
  };
}

describe("shard completeness", () => {
  it(
    "the real filtered harness emits [] only for a successful empty stride",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      const fixtures = join(root, "fixtures");
      mkdirSync(fixtures);
      for (const i of [1, 2, 3]) writeFileSync(join(fixtures, `fx-${i}.html`), `<p>${i}</p>`);
      const output = join(root, "empty-output");
      const run = (only: string, outputDir: string) =>
        runBoundedChild(process.execPath, ["--import", "tsx", "tests/html-test-suite.tsx", "--only", only], {
          budgetMs: HARNESS_BUDGET_MS,
          cwd: process.cwd(),
          env: { ...process.env, HTML_TEST_DIR: fixtures, HTML_TEST_OUTPUT_DIR: outputDir, HTML_TEST_SHARD: "4/5" },
        });
      const empty = await run("fx-", output);
      expect(empty.status, describeChild(empty)).toBe(0);
      expect(JSON.parse(readFileSync(join(output, "results.json"), "utf8"))).toEqual([]);

      const invalidOutput = join(root, "invalid-output");
      const invalid = await run("absent", invalidOutput);
      expect(invalid.status, describeChild(invalid)).toBe(2);
      expect(existsSync(join(invalidOutput, "results.json"))).toBe(false);
    },
    testTimeoutFor(HARNESS_BUDGET_MS, HARNESS_BUDGET_MS),
  );

  it(
    "FAILS the merge when a shard is missing, instead of reporting the survivors",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2, 3, 4]) shardDir(root, "macos", i, [`fx-${i}a`, `fx-${i}b`]);
      // shard 5 dispatched, never arrived — the observed case.
      const { code, summary } = await runMerge(root, "macos=5");

      expect(code, "an incomplete merge must exit non-zero").not.toBe(0);
      expect(summary).toContain("INCOMPLETE RUN");
      expect(summary).toContain("Missing shard(s): 5");

      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c.complete).toBe(false);
      expect(c.expectedShards).toBe(5);
      expect(c.missingShards).toEqual([5]);
      // The count that would otherwise have been quoted as the corpus.
      expect(c.fixtures).toBe(8);
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "passes a complete run and records it as complete",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2, 3, 4, 5]) shardDir(root, "macos", i, [`fx-${i}`]);
      const { code } = await runMerge(root, "macos=5");
      expect(code).toBe(0);
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c.complete).toBe(true);
      expect(c.missingShards).toEqual([]);
      expect(c.observedShards).toEqual([1, 2, 3, 4, 5]);
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "counts successful empty filtered shards without inventing fixture rows",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2, 3]) shardDir(root, "macos", i, [`fx-${i}`]);
      emptyShardDir(root, "macos", 4);
      emptyShardDir(root, "macos", 5);
      const { code, summary } = await runMerge(root, "macos=5");
      expect(code).toBe(0);
      expect(summary).toContain("3 passed, 0 failed, 0 skipped");
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c).toMatchObject({ complete: true, fixtures: 3, observedShards: [1, 2, 3, 4, 5], missingShards: [] });
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "still rejects a missing shard next to a successful empty one",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2, 3]) shardDir(root, "macos", i, [`fx-${i}`]);
      emptyShardDir(root, "macos", 4);
      const { code } = await runMerge(root, "macos=5");
      expect(code).not.toBe(0);
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c).toMatchObject({ complete: false, observedShards: [1, 2, 3, 4], missingShards: [5] });
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "does not count an invalid results file as a completion signal",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2, 3]) shardDir(root, "macos", i, [`fx-${i}`]);
      emptyShardDir(root, "macos", 4);
      const invalid = join(root, "results-macos-shard5");
      mkdirSync(invalid);
      writeFileSync(join(invalid, "results.json"), "{}\n");
      const { code } = await runMerge(root, "macos=5");
      expect(code).not.toBe(0);
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c).toMatchObject({ complete: false, missingShards: [5] });
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "catches the loudest-but-quietest case: an OS dispatched that produced NOTHING",
    async () => {
      // This one never enters the per-OS merge loop at all, so without an explicit
      // sweep over the expected set it vanishes from the summary rather than
      // reporting zero.
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2]) shardDir(root, "macos", i, [`fx-${i}`]);
      const { code, summary } = await runMerge(root, "macos=2,linux=3");
      expect(code).not.toBe(0);
      expect(summary).toContain("NO RESULTS AT ALL");
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-linux.json"), "utf-8"));
      expect(c.complete).toBe(false);
      expect(c.observedShards).toEqual([]);
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "treats an OS expecting 0 shards as not dispatched, not as a shortfall",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 2]) shardDir(root, "macos", i, [`fx-${i}`]);
      const { code } = await runMerge(root, "macos=2,linux=0,windows=0");
      expect(code).toBe(0);
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );

  it(
    "skips the check entirely when --expect is absent, so a local run is unaffected",
    async () => {
      // A local or unsharded run has no matrix size to compare against. Guessing
      // one from the observed shards would make the check vacuous — it would
      // always pass — so it is skipped and said to be skipped (`complete: null`).
      const root = mkdtempSync(join(tmpdir(), "shardc-"));
      for (const i of [1, 3]) shardDir(root, "macos", i, [`fx-${i}`]);
      const { code } = await runMerge(root);
      expect(code).toBe(0);
      const c = JSON.parse(readFileSync(join(root, "shard-completeness-macos.json"), "utf-8"));
      expect(c.complete).toBeNull();
      expect(c.expectedShards).toBeNull();
    },
    testTimeoutFor(MERGE_BUDGET_MS),
  );
});
