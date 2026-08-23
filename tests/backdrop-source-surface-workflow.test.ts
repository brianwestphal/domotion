import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/backdrop-source-surface-parity.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("ordinary backdrop source-surface workflow", () => {
  it("runs the strict unchanged-threshold DPR1/2 gate on every native runner", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("paint:backdrop-source-audit");
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(packageJson.scripts?.["paint:backdrop-source-audit"]).toContain("--strict");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("uploads the independent source/render/mutation evidence even on failure", () => {
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("backdrop-source-${{ runner.os }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
  });
});
