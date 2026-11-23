import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runOracle } from "../tools/wrapped-decoration-fragment-oracle.js";

describe("wrapped decoration fragment oracle", () => {
  it("installs Chromium for every native runner before the browser assertions", () => {
    const workflow = parse(readFileSync(".github/workflows/wrapped-decoration-fragments.yml", "utf8")) as {
      jobs: { "logical-ownership": { steps: { if?: string; run?: string }[] } };
    };
    const steps = workflow.jobs["logical-ownership"].steps;
    const dependencies = steps.findIndex((step) => step.run === "npm ci");
    const browser = steps.findIndex((step) => step.run?.includes("tests/wrapped-decoration-fragments.e2e.test.ts"));
    expect(dependencies).toBeGreaterThanOrEqual(0);
    expect(browser).toBeGreaterThan(dependencies);
    const setup = steps.slice(dependencies + 1, browser);
    expect(setup).toContainEqual(
      expect.objectContaining({
        if: "runner.os == 'Linux'",
        run: "npx playwright install --with-deps chromium",
      }),
    );
    expect(setup).toContainEqual(
      expect.objectContaining({
        if: "runner.os != 'Linux'",
        run: "npx playwright install chromium",
      }),
    );
  });

  it("keeps every DPR/axis row exact and detects all destructive controls", () => {
    const report = runOracle();
    expect(report.pass).toBe(true);
    expect(report.exactRows).toBe(8);
    expect(report.rows).toBe(8);
    expect(report.mutations).toHaveLength(6);
    expect(report.mutations.every((mutation) => mutation.detected)).toBe(true);
  });
});
