import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2535 native mixed color-space evidence workflow", () => {
  const workflow = readFileSync(".github/workflows/blend-filter-pixel-stage.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("exposes the focused native-terminal command at DPR 1 and 2", () => {
    expect(pkg.scripts["paint:mixed-color-space-stage"]).toContain("mixed-reference-color-space-oracle.ts");
    expect(workflow).toContain("paint:mixed-color-space-stage");
    expect(workflow).toContain("mixed-color-space-report.json");
    expect(workflow).toContain("mixed-color-space-artifacts");
    expect(workflow).toContain("--dpr 1,2");
  });

  it("keeps one immutable native matrix and no tolerance escape", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).not.toContain("--accept-known-findings");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("DOMOTION_CHROMIUM_REVISION: 7d859f271cbda744098ac69f44978d4edfa62be3");
  });
});
