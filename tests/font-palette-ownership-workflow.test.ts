import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/font-palette-ownership-audit.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2350 cross-platform font-palette investigation workflow", () => {
  it("runs the pinned logical and raster-boundary audit on all three operating systems", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("tests/fixtures/font-palette/**");
    expect(workflow).toContain("Validate source parser and hostile mutations");
    expect(workflow).toContain("Run source-owned DPR1/2 selection and raster-boundary audit");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
    expect(packageJson.scripts?.["fonts:palette-ownership-audit"])
      .toBe("node --import tsx tools/font-palette-ownership-audit.ts");
  });

  it("does not encode a global image percentage or adjustable pixel envelope", () => {
    expect(workflow).not.toMatch(/percentage|tolerance|threshold|continue-on-error/i);
  });
});
