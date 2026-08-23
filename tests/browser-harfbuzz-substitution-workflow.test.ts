import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/browser-harfbuzz-substitution-streams.yml", "utf8");
const oracle = readFileSync("tools/browser-harfbuzz-substitution-oracle.ts", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("browser HarfBuzz substitution-stream workflow", () => {
  it("produces proposal and validation artifacts on every release OS", () => {
    expect(workflow).toContain("[macos-14, ubuntu-24.04, windows-2025]");
    expect(workflow).toContain("evidence: [proposal, validation]");
    expect(workflow).toContain("npx playwright install --with-deps chromium");
    expect(workflow).toContain("npm run fonts:browser-harfbuzz-substitutions");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toMatch(/ratify:\n\s+needs: exact-logical-artifacts/);
    expect(pkg.scripts["fonts:browser-harfbuzz-substitutions"])
      .toBe("node --import tsx tools/browser-harfbuzz-substitution-oracle.ts");
  });

  it("pins source authority and blocks all raster grading until exact logic agrees", () => {
    expect(workflow).toContain("7d859f271cbda744098ac69f44978d4edfa62be3");
    expect(workflow).toContain("4de187dd0a915d13c976fa8bd474c084229f3aab");
    expect(workflow).toContain("62efacd37737505732dbe3d8daa62abd679626a1");
    expect(oracle).toContain('"blocked-until-exact-logical-agreement"');
    expect(oracle).toContain('"not-exposed-by-cdp"');
    expect(oracle).toContain("node_modules/playwright-core/browsers.json");
    expect(oracle).toContain("playwrightChromiumRevision");
    expect(oracle).toContain("wrong-source-fingerprint");
    expect(oracle).toContain("zero-mark-offset");
    expect(workflow).not.toMatch(/screenshot|png|pixel|tolerance|diffPct|threshold/i);
  });

  it("requires one cross-OS logical digest and the complete six-artifact set", () => {
    expect(oracle).toContain('const REQUIRED_OSES = ["Linux", "macOS", "Windows"]');
    expect(oracle).toContain('const REQUIRED_EVIDENCE = ["proposal", "validation"]');
    expect(oracle).toContain("exact logical streams differ across proposal/validation or OS");
    expect(oracle).toContain('"proposal-validation-agreement"');
  });
});
