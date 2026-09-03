import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/cross-origin-frame-scroll-ownership.yml";
const workflow = readFileSync(workflowPath, "utf8");

describe("DM-2537 three-platform frame/scroll ownership gate", () => {
  it("runs the destructive and live Chromium contracts on every native OS", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("name: ${{ matrix.os }} exact frame/scroll ownership");
    expect(workflow).not.toContain("name: ${{ runner.os }} exact frame/scroll ownership");
    expect(workflow).toContain("src/scroll/frame-scroll-ownership.test.ts");
    expect(workflow).toContain("tests/cross-origin-frame-scroll-workflow.test.ts");
    expect(workflow).toContain("tests/cross-origin-iframe-recursion.e2e.test.ts");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("has no visual-fitting or tolerance escape hatch", () => {
    expect(workflow).not.toMatch(/tolerance|threshold|pixel|baseline|accept-known/i);
  });
});
