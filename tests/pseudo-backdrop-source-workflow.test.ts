import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/pseudo-backdrop-source-parity.yml", "utf8");

describe("DM-2488 pseudo backdrop source workflow", () => {
  it("runs the immutable DPR1/2 gate on every native runner", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("pseudo:backdrop-source-oracle");
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("uploads the independent source/render/mutation evidence on failure", () => {
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("pseudo-backdrop-source-${{ runner.os }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
  });
});
