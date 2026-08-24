import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/text-transform-parity.yml", "utf8");

describe("DM-2546 exact FragmentItem span workflow", () => {
  it("is a required native macOS/Linux/Windows gate", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("needs: parity");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("runs and retains the exact source-span/glyph report", () => {
    expect(workflow).toContain("npm run transform:text-fragment-spans -- --json tests/output/text-fragment-spans-${{ runner.os }}.json");
    expect(workflow).toContain("tests/output/text-fragment-spans-${{ runner.os }}.json");
    expect(workflow).toContain("tools/text-fragment-span-oracle.ts");
    expect(workflow).toContain("src/capture/text-fragment-spans.ts");
    expect(workflow).toContain("if: always()");
  });

  it("does not introduce headed execution or a pixel/tolerance knob", () => {
    expect(workflow).not.toMatch(/--headed\b/);
    expect(workflow).not.toMatch(/fragment-span[^\n]*(?:tolerance|threshold|pixelmatch)/i);
  });
});
