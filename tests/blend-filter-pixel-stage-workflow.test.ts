import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2360 all-platform named-pixel workflow", () => {
  const workflow = readFileSync(".github/workflows/blend-filter-pixel-stage.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("exposes the focused source-stage command and both DPRs", () => {
    expect(pkg.scripts["paint:blend-filter-stage"]).toContain("blend-filter-pixel-stage-oracle.ts");
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow).toContain("--accept-known-findings");
    expect(workflow).toContain('"tests/blend-filter-pixel-stage-workflow.test.ts"');
  });

  it("records immutable evidence independently on all native runner platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("if: runner.os == 'Linux'");
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(workflow).toContain("tests/output/blend-filter/${{ runner.os }}/report.json");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("continue-on-error");
  });
});
