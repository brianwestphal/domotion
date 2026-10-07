import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows fidelity workflow", () => {
  it("runs the CJK context transition file in the browser E2E lane", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const regression = workflow.slice(workflow.indexOf("  regression:"), workflow.indexOf("\n  decoration-geometry:"));
    expect(regression).toContain("Build text engine for CJK context test");
    expect(regression).toContain(
      "npx vitest run --config vitest.e2e.config.ts tests/windows-system-ui-cjk-context.e2e.test.ts",
    );
  });

  it("gates the hosted Arm64 family match against its committed fingerprint", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const arm64 = workflow.slice(
      workflow.indexOf("  family-match-arm64-hosted:"),
      workflow.indexOf("\n  glyph-extractor-build:"),
    );
    expect(arm64).toContain("runs-on: windows-11-arm");
    expect(arm64).toContain("npx tsx tools/family-match-conformance-win32.ts\n");
    expect(arm64).toContain("if ($code -eq 3)");
    expect(arm64).toContain("} elseif ($code -ne 0) {");
    expect(arm64).toContain("npx tsx tools/family-match-conformance-win32.ts --write-baseline");
  });
});
