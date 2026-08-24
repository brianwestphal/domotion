import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2358/DM-2538 generated SVG effect workflow", () => {
  const workflow = readFileSync(".github/workflows/svg-effect-combinations.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("runs deterministic logical coverage before DPR 1 and 2", () => {
    expect(pkg.scripts["paint:svg-effect-combinations"]).toContain("svg-effect-combination-oracle.ts");
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow.indexOf("Run deterministic corpus and workflow guards"))
      .toBeLessThan(workflow.indexOf("Capture DPR 1/2 native SVG and mutation evidence"));
    expect(workflow).toContain('"tests/svg-effect-combination-workflow.test.ts"');
    expect(workflow).not.toContain("continue-on-error");
  });

  it("records fingerprinted evidence on every supported runner platform", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("if: runner.os == 'Linux'");
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(workflow).toContain("tests/output/svg-effect-combinations/${{ runner.os }}/report.json");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
