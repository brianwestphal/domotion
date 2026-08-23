import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/transformed-flex-geometry-parity.yml", "utf8");
const features = readFileSync("tests/features.ts", "utf8");

describe("transformed flex geometry workflow", () => {
  it("runs exact logical and scored fixture gates on every supported OS", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("transformed-flex-geometry.e2e.test.ts");
    expect(workflow).toContain("transform-scale-flex-descendants");
    expect(workflow).not.toMatch(/continue-on-error|tolerance|threshold/i);
    const fixture = features.slice(features.indexOf('name: "transform-scale-flex-descendants"'), features.indexOf("// DM-589"));
    expect(fixture).not.toContain("relaxedDiffPct");
  });
});
