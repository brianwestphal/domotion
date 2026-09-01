import { describe, expect, it } from "vitest";
// The production coverage orchestrator is plain Node ESM so it can run before
// any TypeScript loader is installed.
// @ts-expect-error The tested .mjs helper intentionally has no declaration file.
import { formatCoverageSummary, summarizeCoverage } from "../tools/coverage-summary.mjs";

function file(statements: number[], branches: number[][], functions: number[]) {
  return {
    statementMap: Object.fromEntries(statements.map((_, index) => [index, { start: { line: index + 1 } }])),
    s: Object.fromEntries(statements.map((value, index) => [index, value])),
    b: Object.fromEntries(branches.map((value, index) => [index, value])),
    f: Object.fromEntries(functions.map((value, index) => [index, value])),
  };
}

describe("merged coverage directory summary (DM-2646)", () => {
  it("aggregates source directories and identifies genuinely low files", () => {
    const summary = summarizeCoverage({
      "/repo/src/capture/a.ts": file([1, 0], [[1, 0]], [1]),
      "/repo/src/capture/b.ts": file([0, 0], [[0, 0]], [0]),
      "/repo/src/render.ts": file([1, 1], [[1, 1]], [1]),
      "/repo/tests/ignored.ts": file([0], [[0]], [0]),
    }, "/repo");

    expect(summary.overall.statements).toMatchObject({ covered: 3, total: 6, pct: 50 });
    expect(summary.directories.map((row: { path: string }) => row.path)).toEqual(["src/(root)", "src/capture"]);
    expect(summary.directories.find((row: { path: string }) => row.path === "src/capture")?.statements)
      .toMatchObject({ covered: 1, total: 4, pct: 25 });
    expect(summary.lowStatementFiles.map((row: { path: string }) => row.path)).toEqual(["src/capture/b.ts"]);
  });

  it("formats an explicit per-directory table and low-file list", () => {
    const summary = summarizeCoverage({
      "/repo/src/cli/a.ts": file([1, 0], [[1, 0]], [0]),
      "/repo/src/scrubber/client.tsx": file([0, 0], [[0]], [0]),
    }, "/repo", {
      "src/scrubber/client.tsx": "executes in Chromium",
    });
    const output = formatCoverageSummary(summary);
    expect(output).toContain("Per-directory merged coverage:");
    expect(output).toContain("src/cli");
    expect(output).toContain("Instrumented files below 50% statement coverage");
    expect(output).not.toContain("src/cli/a.ts"); // exactly 50%, not below
    expect(summary.lowStatementFiles).toEqual([]);
    expect(output).toContain("src/scrubber/client.tsx — executes in Chromium");
  });
});
