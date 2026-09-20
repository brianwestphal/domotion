import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mergeCoverageMaps } from "../tools/coverage-map.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("merged Vitest coverage", () => {
  it("includes execution from a Vite-transformed TypeScript module", () => {
    const reportsDirectory = mkdtempSync(join(tmpdir(), "domotion-vitest-coverage-"));
    temporaryDirectories.push(reportsDirectory);
    const config = resolve("tests/fixtures/vitest-coverage/vitest.config.ts");
    const result = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "--config",
        config,
        "--coverage",
        `--coverage.reportsDirectory=${reportsDirectory}`,
        "--coverage.reporter=json",
      ],
      { cwd: resolve("."), encoding: "utf8", shell: process.platform === "win32" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const vitestCoverage = JSON.parse(readFileSync(join(reportsDirectory, "coverage-final.json"), "utf8"));
    const merged = mergeCoverageMaps([vitestCoverage]);
    const transformedPath = merged.files().find((path) => path.endsWith("/transformed-module.ts"));

    expect(transformedPath).toBeDefined();
    expect(merged.fileCoverageFor(transformedPath!).toSummary().statements.covered).toBeGreaterThan(0);
  });
});
