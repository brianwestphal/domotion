import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/sfns-outline-parity.yml", "utf8");
const collector = readFileSync("tools/sfns-mask-baseline-oracle.ts", "utf8");

describe("SFNS exact outline workflow (DM-2567)", () => {
  it("runs proposal and validation as separate macOS matrix jobs", () => {
    expect(workflow).toContain("arm: [proposal, validation]");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("--arm ${{ matrix.arm }}");
    expect(workflow).toContain("needs: collect");
  });

  it("builds and authenticates the CoreText helper before collection", () => {
    expect(workflow).toContain("bash tools/macos-glyph-extractor/build.sh");
    expect(collector).toContain("resolvedGlyphHelperPathForEvidence");
    expect(collector).toContain("helperSha256");
    expect(collector).toContain("requires the native glyph helper (fail closed)");
  });

  it("launches only an explicit headless browser and applies an exact equality gate", () => {
    expect(collector).toContain("launchChromium({ headless: true })");
    expect(collector).not.toMatch(/headless:\s*false/);
    expect(workflow).toContain("fonts:sfns-outline:adjudicate");
    expect(workflow).toContain("--proposal evidence/proposal/report.json");
    expect(workflow).toContain("--validation evidence/validation/report.json");
  });
});
