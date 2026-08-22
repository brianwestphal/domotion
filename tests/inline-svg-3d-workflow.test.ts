import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/inline-svg-3d-parity.yml", "utf8");

describe("inline SVG 3D parity workflow", () => {
  it("runs the hard gate on all supported capture platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("requires both DPRs and the focused production E2E boundary", () => {
    expect(workflow).toContain("transform:inline-svg-3d-audit -- --dpr 1,2");
    expect(workflow).toContain("tests/inline-svg-affine-freeze.e2e.test.ts");
    expect(workflow).toContain("tests/inline-svg-projective-ownership.e2e.test.ts");
  });

  it("uploads one fingerprinted native report even when the gate fails", () => {
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("inline-svg-3d-${{ runner.os }}");
    expect(workflow).toContain("tests/output/inline-svg-3d-gate.json");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("is an enforced pull-request and main-branch gate", () => {
    expect(workflow).toMatch(/on:\s*\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:\s*\n\s*branches: \[main\]/);
  });
});
