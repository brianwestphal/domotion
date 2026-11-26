import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Windows fidelity workflow", () => {
  it("runs the CJK context transition file in the browser E2E lane", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const regression = workflow.slice(workflow.indexOf("  regression:"), workflow.indexOf("\n  decoration-geometry:"));
    expect(regression).toContain("Build text engine for browser transition tests");
    expect(regression).toContain(
      "npx vitest run --config vitest.e2e.config.ts tests/windows-system-ui-cjk-context.e2e.test.ts",
    );
  });

  it("requires all three native SVG image font suites and uploads the receipt on failure (DM-MEXH5M)", () => {
    type Step = {
      name?: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: { path?: string; "if-no-files-found"?: string };
      "continue-on-error"?: boolean;
    };
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const { jobs } = parse(workflow) as { jobs: { regression: { "runs-on": string; steps: Step[] } } };
    const { steps } = jobs.regression;
    expect(jobs.regression["runs-on"]).toBe("windows-latest");
    const run = steps.find((step) => step.name === "Verify native SVG image own fonts (DM-MEXH5M)")!;
    const gate = steps.find((step) => step.name === "Require every SVG image own-font assertion")!;
    const upload = steps.find((step) => step.name === "Upload expected/actual/diff PNGs")!;
    const report = "tests/output/svg-image-own-fonts/results.json";
    expect(run.run).toContain("vitest run --config vitest.e2e.config.ts");
    expect(run.run?.match(/tests\/[^\s]+\.e2e\.test\.ts/g)).toEqual([
      "tests/image-svg-font-witness.e2e.test.ts",
      "tests/image-svg-font-conditions.e2e.test.ts",
      "tests/image-svg-own-fonts.e2e.test.ts",
    ]);
    expect(run.run).toContain(`--reporter=json --outputFile=${report}`);
    expect(gate.run).toContain("tools/helper-release-consumer.ts");
    expect(gate.run).toContain(`--browser-results ${report} --minimum-passed 45`);
    expect(steps.indexOf(run)).toBeLessThan(steps.indexOf(gate));
    expect(steps.indexOf(gate)).toBeLessThan(steps.indexOf(upload));
    for (const step of [run, gate, upload]) {
      expect(step.if).toBe("always()");
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
    expect(upload.with?.path?.split(/\s+/)).toContain("tests/output/svg-image-own-fonts/");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("gates the hosted Arm64 family match against its committed fingerprint", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const arm64 = workflow.slice(
      workflow.indexOf("  family-match-arm64-hosted:"),
      workflow.indexOf("\n  glyph-extractor-build:"),
    );
    expect(arm64).toContain("runs-on: windows-11-arm");
    expect(arm64).toContain("npx tsx tools/family-match-conformance-win32.ts\n");
    expect(arm64).toContain("if ($code -eq 3)");
    expect(arm64).toContain("} elseif ($code -ne 0) {");
    expect(arm64).toContain("npx tsx tools/family-match-conformance-win32.ts --write-baseline");
  });
});
