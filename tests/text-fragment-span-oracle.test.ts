import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS,
  TEXT_FRAGMENT_SPAN_CASES,
  TEXT_FRAGMENT_SPAN_SOURCE_PINS,
  validateTextFragmentSpanCorpus,
} from "../tools/text-fragment-span-oracle.js";

describe("Blink FragmentItem UTF-16 span logical oracle", () => {
  it("pins Chromium plus both shaping and paint dependencies", () => {
    expect(TEXT_FRAGMENT_SPAN_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzzPinnedByChromium: "511df88b82e697cd2a0f1f0635787aa0b18bddbb",
      harfbuzzRenderer: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
  });

  it("retains mixed fallback, bidi, ligature, wrap, first-letter, and vertical cases", () => {
    expect(validateTextFragmentSpanCorpus()).toEqual([]);
    expect(TEXT_FRAGMENT_SPAN_CASES.map((test) => [test.id, test.writingMode, test.firstLetter])).toEqual([
      ["mixed-fallback-bidi-ligature-wrap-first-letter", "horizontal-tb", true],
      ["vertical-mixed-fallback-ligature", "vertical-rl", false],
    ]);
  });

  it("requires collapse, reorder, and wrong-span rejection", () => {
    expect(REQUIRED_TEXT_FRAGMENT_SPAN_MUTATIONS).toEqual([
      "collapse-fragments",
      "reorder-fragments",
      "wrong-source-span",
    ]);
  });

  it("is explicitly headless and contains no screenshot or visual-tolerance leg", () => {
    const source = readFileSync("tools/text-fragment-span-oracle.ts", "utf8");
    expect(source).toMatch(/chromium\.launch\(\{ headless: true,/);
    expect(source).not.toMatch(/\.screenshot\s*\(/);
    expect(source).not.toMatch(/pixelmatch|visualTolerance|visualThreshold/);
  });
});
