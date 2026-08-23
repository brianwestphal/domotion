import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/repeating-linear-px-stop-parity.yml", "utf8");

describe("repeating-linear px-stop parity workflow", () => {
  it("runs the logical source and DPR1/2 browser gates on every supported OS", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("borders-backgrounds.test.ts");
    expect(workflow).toContain("repeating-linear-px-stops.e2e.test.ts");
    expect(workflow).not.toMatch(/continue-on-error|tolerance|percentage/i);
  });
});
