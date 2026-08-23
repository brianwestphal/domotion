import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/vertical-orientation-parity.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2525 three-platform vertical-orientation gate", () => {
  it("runs the pinned source, native ICU, production capture, and mutation contracts", () => {
    expect(workflow).toContain("macos-latest, ubuntu-latest, windows-latest");
    expect(workflow).toContain("d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738");
    expect(workflow).toContain("source/data/unidata/ppucd.txt?format=TEXT");
    expect(workflow).toContain("acquireIcuCompanion");
    expect(workflow).toContain("unicode:vertical-orientation:check");
    expect(workflow).toContain("unicode:vertical-orientation:oracle -- --require-source");
    expect(workflow).toContain("vertical-orientation-capture.e2e.test.ts");
    expect(workflow).toContain("vertical-orientation-${{ runner.os }}.json");
    expect(workflow).not.toContain("continue-on-error");
    expect(packageJson.scripts?.["unicode:vertical-orientation:oracle"])
      .toBe("node --import tsx tools/vertical-orientation-oracle.ts");
  });

  it("contains no visual-fitting escape hatch", () => {
    expect(workflow).not.toMatch(/tolerance|threshold|pixel|screenshot|baseline/i);
    expect(workflow).toContain("if-no-files-found: error");
  });
});
