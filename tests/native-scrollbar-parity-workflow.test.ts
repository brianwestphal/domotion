import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/native-scrollbar-parity.yml", "utf8");

describe("DM-2484 native scrollbar workflow", () => {
  it("collects independent native evidence on all supported desktop platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("evidence: [proposal, validation]");
    expect(workflow).toContain("${{ matrix.evidence }}");
  });

  it("removes the hidden-scrollbar false negative and requests the full Cartesian matrix", () => {
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow).toContain("--zoom 1,1.25,2");
    expect(workflow).toContain("--artifacts");
    expect(workflow).toContain("scrollbars:ownership-audit");
    expect(workflow).toContain("--evidence-role ${{ matrix.evidence }}");
    expect(workflow).toContain("--boot-id");
    expect(workflow).toContain("--runner-image");
  });

  it("uploads every native producer artifact before a separate strict aggregate", () => {
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("native-scrollbar-${{ runner.os }}-${{ matrix.evidence }}");
    expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toContain("scrollbars:parity-gate");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("stays dispatch-only while the known custom/native paint dependencies are red", () => {
    expect(workflow).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n\s*pull_request:/);
    expect(workflow).not.toMatch(/\n\s*push:/);
  });
});
