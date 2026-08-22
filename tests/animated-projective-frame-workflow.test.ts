import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/animated-projective-frame-parity.yml", "utf8");

describe("animated projective frame parity workflow", () => {
  it("is a hard native macOS/Linux/Windows matrix", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("crosses DPR 1/2 and uploads the fingerprinted report on failure", () => {
    expect(workflow).toContain("transform:animated-3d-frame-gate -- --dpr 1,2");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("animated-projective-frame-${{ runner.os }}");
    expect(workflow).toContain("tests/output/animated-projective-frame-gate.json");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("gates pull requests and main", () => {
    expect(workflow).toMatch(/on:\s*\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:\s*\n\s*branches: \[main\]/);
  });
});
