import { describe, expect, it } from "vitest";
import { runFeatureTests } from "./runner.js";

describe("feature runner return contract", () => {
  it("returns mixed browser results and failure count without exiting its importer", async () => {
    const previousExitCode = process.exitCode;
    const run = await runFeatureTests([
      { name: "runner-return-pass", html: '<div style="width:60px;height:60px;background:red"></div>' },
      {
        name: "runner-return-fail",
        html: '<div style="width:60px;height:60px;background:red"></div>',
        relaxedDiffPct: -1, // Deliberately fail the visual threshold after the real browser comparison.
      },
    ]);
    expect(run.results.map((result) => [result.name, result.pass])).toEqual([
      ["runner-return-pass", true],
      ["runner-return-fail", false],
    ]);
    expect(run.failed).toBe(1);
    expect(process.exitCode).toBe(previousExitCode);
  }, 120_000);
});
