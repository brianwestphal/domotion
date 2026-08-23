import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/generic-family-semantics-audit.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

describe("generic-family semantic ownership workflow", () => {
  it("runs the logical two-order discriminator on every supported runner OS", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(workflow).toContain("playwright install chromium");
    expect(workflow).toContain("tests/generic-family-semantics-audit.test.ts");
    expect(packageJson.scripts?.["fonts:generic-family-semantics"])
      .toBe("node --import tsx tools/generic-family-semantics-audit.ts");
  });

  it("retains fingerprinted evidence and contains no visual-fitting escape hatch", () => {
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("submodules: recursive");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("generic-family-semantics-${{ runner.os }}.json");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toMatch(/tolerance|threshold|screenshot|continue-on-error/i);
  });
});
