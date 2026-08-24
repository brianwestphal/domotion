import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/font-palette-ownership-audit.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2510/DM-2534 cross-platform font-palette paint workflow", () => {
  it("runs the pinned strict static and dynamic COLRv0/COLRv1 paint gate on all three operating systems", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("tests/fixtures/font-palette/**");
    expect(workflow).toContain("Validate source parsers and hostile mutations");
    expect(workflow).toContain("Run strict source-owned DPR1/2 static and dynamic COLRv0/COLRv1 paint gate");
    expect(workflow).toContain("tests/font-palette-dynamic-gate.test.ts");
    expect(workflow).toContain("tools/font-palette-dynamic-gate.ts");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
    expect(packageJson.scripts?.["fonts:palette-ownership-audit"])
      .toBe("node --import tsx tools/font-palette-ownership-audit.ts");
    expect(packageJson.scripts?.["fonts:palette-paint-gate"])
      .toBe("node --import tsx tools/font-palette-paint-gate.ts");
  });

  it("does not encode a global image percentage or adjustable pixel envelope", () => {
    expect(workflow).not.toMatch(/percentage|tolerance|threshold|continue-on-error/i);
  });
});
