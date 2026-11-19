import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";
import { resolveVisualOutputRoot, resolveReviewOutputRoot } from "./output-directory.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(testsDir, "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const temporary = mkdtempSync(join(tmpdir(), "domotion-output-root-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
// A tsx start of the real-world suite that matches no fixture used 0.65-0.89 s
// of CPU, and a plain Node run of the comparison tool 0.05-0.09 s, idle and
// loaded (docs/tool-child-process-test-bounds.md).
const REAL_WORLD_BUDGET_MS = budgetForCpuWork(1_000);
const COMPARE_BUDGET_MS = budgetForCpuWork(100);

describe("visual output root", () => {
  it("keeps the script-anchored default for absent and empty overrides", () => {
    expect(resolveVisualOutputRoot({})).toBe(join(testsDir, "output"));
    expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: "" })).toBe(join(testsDir, "output"));
  });

  it.each(["tests/output-linux", "tests/output-windows", "relative root with spaces"])(
    "resolves relative override %s against the invocation cwd",
    (override) => expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: override })).toBe(resolve(override)),
  );

  it("retains an absolute alternate root", () => {
    expect(resolveVisualOutputRoot({ DOMOTION_OUTPUT_DIR: temporary })).toBe(temporary);
  });

  it("lets the explicit review root win and otherwise follows the suite root", () => {
    const suite = join(temporary, "suite");
    const review = join(temporary, "review");
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite, REVIEW_OUTPUT_DIR: review })).toBe(review);
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite, REVIEW_OUTPUT_DIR: "" })).toBe(suite);
    expect(resolveReviewOutputRoot({ DOMOTION_OUTPUT_DIR: suite })).toBe(suite);
    expect(resolveReviewOutputRoot({})).toBe(join(testsDir, "output"));
  });

  it(
    "the real-world CLI creates the selected suite directory from another cwd",
    async () => {
      const output = join(temporary, "alternate");
      const canonicalManifest = join(testsDir, "output/real-world/results.json");
      const before = existsSync(canonicalManifest) ? readFileSync(canonicalManifest) : undefined;
      const result = await runBoundedChild(
        process.execPath,
        ["--import", tsxLoader, join(testsDir, "real-world.tsx"), "--only", "__no_matching_fixture__"],
        {
          budgetMs: REAL_WORLD_BUDGET_MS,
          cwd: temporary,
          env: { ...process.env, DOMOTION_OUTPUT_DIR: output },
        },
      );
      expect(result.status, describeChild(result)).toBe(0);
      expect(result.stdout).toContain("No jobs matched");
      expect(existsSync(join(output, "real-world"))).toBe(true);
      expect(existsSync(join(output, "results.json"))).toBe(false);
      expect(existsSync(canonicalManifest) ? readFileSync(canonicalManifest) : undefined).toEqual(before);
    },
    testTimeoutFor(REAL_WORLD_BUDGET_MS),
  );

  it(
    "the comparison CLI reads the suite override while explicit paths retain precedence",
    async () => {
      const output = join(temporary, "compare");
      mkdirSync(join(output, "real-world"), { recursive: true });
      const baseline = join(temporary, "baseline.json");
      const explicit = join(temporary, "explicit.json");
      const manifest = (name: string) =>
        JSON.stringify({ results: [{ name, coveragePct: 0, regionCount: 0, verdict: "clean" }] });
      writeFileSync(baseline, JSON.stringify({ results: [] }));
      writeFileSync(join(output, "real-world/results.json"), manifest("suite-root-result"));
      writeFileSync(explicit, manifest("explicit-path-result"));
      const run = async (paths: string[]) => {
        const result = await runBoundedChild(
          process.execPath,
          [join(repo, "tools/compare-real-world-results.mjs"), ...paths],
          { budgetMs: COMPARE_BUDGET_MS, cwd: temporary, env: { ...process.env, DOMOTION_OUTPUT_DIR: output } },
        );
        expect(result.status, describeChild(result)).toBe(0);
        return result.stdout;
      };
      expect(await run([baseline])).toContain("suite-root-result");
      const stdout = await run([baseline, explicit]);
      expect(stdout).toContain("explicit-path-result");
      expect(stdout).not.toContain("suite-root-result");
    },
    testTimeoutFor(COMPARE_BUDGET_MS, COMPARE_BUDGET_MS),
  );
});
