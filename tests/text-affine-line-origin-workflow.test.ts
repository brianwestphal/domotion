import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/text-transform-parity.yml", "utf8");

describe("DM-2547 structured affine text line-origin workflow", () => {
  it("is a required native-platform gate", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("needs: parity");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("runs and retains the pinned-source logical report", () => {
    expect(workflow).toContain("npm run sources:materialize");
    expect(workflow).toContain("tools/macos-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/linux-glyph-extractor/build.sh");
    expect(workflow).toContain("tools/win32-glyph-extractor/build.ps1");
    expect(workflow).toContain("npm run transform:text-baseline-protocol -- --json tests/output/text-affine-line-origin-${{ runner.os }}.json");
    expect(workflow).toContain("tests/output/text-affine-line-origin-${{ runner.os }}.json");
    expect(workflow).toContain("tools/text-affine-baseline-protocol-oracle.ts");
    expect(workflow).toContain("src/capture/text-line-origin.ts");
    expect(workflow).toContain("if: always()");
  });

  it("does not introduce headed execution or visual-tolerance knobs", () => {
    expect(workflow).not.toMatch(/--headed\b/);
    expect(workflow).not.toMatch(/line-origin[^\n]*(?:tolerance|threshold|pixelmatch)/i);
  });
});
