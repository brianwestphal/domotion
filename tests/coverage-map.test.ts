import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeCoverageMaps } from "../tools/coverage-map.mjs";
import { budgetForCpuWork, describeChild, runBoundedChild, testTimeoutFor } from "./bounded-child.js";

const temporaryDirectories: string[] = [];
// The nested coverage run (the Vitest CLI plus its test worker) used 0.54 s of
// CPU idle and up to 0.83 s inside a loaded suite, where it took up to 21 s
// (docs/tool-child-process-test-bounds.md).
const COVERAGE_RUN_BUDGET_MS = budgetForCpuWork(900, 2);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("merged Vitest coverage", () => {
  it(
    "includes execution from a Vite-transformed TypeScript module",
    async () => {
      const reportsDirectory = mkdtempSync(join(tmpdir(), "domotion-vitest-coverage-"));
      temporaryDirectories.push(reportsDirectory);
      const config = resolve("tests/fixtures/vitest-coverage/vitest.config.ts");
      // The Vitest CLI runs directly under this Node, so no shell or `npx`
      // wrapper is needed on any platform.
      const result = await runBoundedChild(
        process.execPath,
        [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          config,
          "--coverage",
          `--coverage.reportsDirectory=${reportsDirectory}`,
          "--coverage.reporter=json",
        ],
        { budgetMs: COVERAGE_RUN_BUDGET_MS, cwd: resolve(".") },
      );

      expect(result.status, describeChild(result)).toBe(0);
      const vitestCoverage = JSON.parse(readFileSync(join(reportsDirectory, "coverage-final.json"), "utf8"));
      const merged = mergeCoverageMaps([vitestCoverage]);
      const transformedPath = merged.files().find((path) => path.endsWith("/transformed-module.ts"));

      expect(transformedPath).toBeDefined();
      expect(merged.fileCoverageFor(transformedPath!).toSummary().statements.covered).toBeGreaterThan(0);
    },
    testTimeoutFor(COVERAGE_RUN_BUDGET_MS),
  );
});
