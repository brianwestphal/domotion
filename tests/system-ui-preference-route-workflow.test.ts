import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/system-ui-preference-route.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2504 system-ui preference route workflow", () => {
  it("runs the exact native helper and four-launch gate on all supported platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("playwright install --with-deps chromium chrome");
    expect(workflow).toContain("playwright install chromium chrome");
    expect(workflow).toContain("tools/macos-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/linux-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/win32-glyph-extractor/build.ps1");
    expect(workflow).toContain("xvfb-run -a npm run fonts:system-ui-preferences");
    expect(workflow).toContain("--allow-system-preference-mutation");
    expect(packageJson.scripts?.["fonts:system-ui-preferences"])
      .toBe("node --import tsx tools/system-ui-preference-route-oracle.ts");
  });

  it("retains source and inventory evidence from every native leg", () => {
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("submodules: recursive");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("system-ui-preference-route-${{ runner.os }}.json");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("continue-on-error");
  });
});
