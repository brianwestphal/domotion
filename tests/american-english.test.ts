import { describe, expect, it } from "vitest";
import { americanEnglishFindings, isAmericanEnglishCheckPath } from "../scripts/american-english.mjs";

describe("American-English prose check", () => {
  it("reports authored British spellings with locations and original casing", () => {
    expect(americanEnglishFindings("src/example.ts", "Color.\nBehaviour-identical and RASTERISED."))
      .toEqual([
        { path: "src/example.ts", line: 2, column: 1, spelling: "Behaviour" },
        { path: "src/example.ts", line: 2, column: 25, spelling: "RASTERISED" },
      ]);
  });

  it("excludes generated and vendored paths", () => {
    expect(isAmericanEnglishCheckPath("src/capture/script.generated.ts")).toBe(false);
    expect(isAmericanEnglishCheckPath("vendor/example.ts")).toBe(false);
    expect(isAmericanEnglishCheckPath(".pr-notes/notes/example.sarif")).toBe(false);
    expect(isAmericanEnglishCheckPath("docs/index.json")).toBe(false);
  });

  it("preserves required API, CSS, and quoted-spec literals", () => {
    expect(americanEnglishFindings("site/scripts/generate-fidelity-proof.mjs", "png({ colours: 256 })"))
      .toEqual([]);
    expect(americanEnglishFindings("src/render/colors.ts", "grey: gray"))
      .toEqual([]);
    expect(americanEnglishFindings(
      "docs/reference/raster-image-fallback-cases.md",
      'The spec says "rasterise the target element\'s paint".',
    )).toEqual([]);
  });
});
