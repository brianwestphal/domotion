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
});
