import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/generic-family-preference-parity.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2351 generic preference workflow", () => {
  it("runs the exact four-launch logical gate on all native runner platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("playwright install --with-deps chromium chrome");
    expect(workflow).toContain("playwright install chromium");
    expect(workflow).not.toContain("runner.os != 'Linux'\n        run: npx playwright install chromium chrome");
    expect(workflow).toContain("npm run sources:materialize");
    expect(workflow).toContain("tools/macos-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/linux-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/win32-glyph-extractor/build.ps1");
    expect(workflow).toContain("xvfb-run -a npm run fonts:generic-preferences");
    expect(workflow.match(/--allow-headed-browser/g)).toHaveLength(2);
    expect(packageJson.scripts?.["fonts:generic-preferences"])
      .toBe("node --import tsx tools/generic-family-preference-oracle.ts");
    expect(workflow).not.toContain("--allow-missing-full-chrome");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("persists fingerprinted logical evidence even when a native leg fails", () => {
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("submodules: recursive");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("generic-family-preference-${{ runner.os }}.json");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
