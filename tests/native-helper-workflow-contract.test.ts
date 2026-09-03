import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflows = [
  "pseudo-fragment-render-parity.yml",
  "url-background-geometry-parity.yml",
  "font-palette-ownership-audit.yml",
  "text-transform-parity.yml",
  "generic-family-semantics-audit.yml",
  "generic-family-preference-parity.yml",
] as const;

describe("native parity workflow helper contract", () => {
  for (const name of workflows) {
    it(`${name} builds the native glyph helper on every graded platform`, () => {
      const workflow = readFileSync(`.github/workflows/${name}`, "utf8");
      expect(workflow).toContain("tools/macos-glyph-extractor/build.sh");
      expect(workflow).toContain("tools/linux-glyph-extractor/build.sh");
      expect(workflow).toContain("tools/win32-glyph-extractor/build.ps1");
    });
  }
});
