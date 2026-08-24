import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("capture rAF ownership workflow", () => {
  const workflow = readFileSync(".github/workflows/raf-clock-ownership.yml", "utf8");

  it("runs the exact headless logical gate on all supported platforms", () => {
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("tests/raf-clock.e2e.test.ts");
    expect(workflow).toContain('CI: "true"');
    expect(workflow).not.toContain("--headed");
  });
});
