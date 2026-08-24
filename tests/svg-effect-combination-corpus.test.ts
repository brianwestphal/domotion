import { describe, expect, it } from "vitest";
import {
  SVG_EFFECT_CASES,
  SVG_EFFECT_DIMENSIONS,
  SVG_EFFECT_SOURCE_DECISIONS,
  SVG_EFFECT_VIEWPORT,
  buildSvgEffectCombinationHtml,
  generateSvgEffectCombinations,
  svgEffectHigherOrderCoverage,
  svgEffectPairCoverage,
  validateSvgEffectCombinationCorpus,
} from "../tools/svg-effect-combination-corpus.js";

describe("generated SVG effect combination corpus (DM-2358)", () => {
  it("is deterministic and covers every pair of source-owned class inputs", () => {
    expect(generateSvgEffectCombinations()).toEqual(SVG_EFFECT_CASES);
    expect(SVG_EFFECT_CASES).toHaveLength(37);
    expect(svgEffectPairCoverage(SVG_EFFECT_CASES)).toEqual({
      expectedPairs: 1088,
      coveredPairs: 1088,
      missingPairs: [],
    });
    expect(svgEffectHigherOrderCoverage(SVG_EFFECT_CASES)).toEqual({
      expectedTargetedTriples: 83,
      coveredTargetedTriples: 83,
      missingTargetedTriples: [],
    });
    expect(validateSvgEffectCombinationCorpus()).toEqual([]);

    for (const dimension of SVG_EFFECT_DIMENSIONS) {
      expect(new Set(SVG_EFFECT_CASES.map((test) => test.values[dimension.name])))
        .toEqual(new Set(dimension.values));
    }
    expect(Object.values(SVG_EFFECT_SOURCE_DECISIONS)).toHaveLength(11);
  });

  it("emits native SVG owners and never invents the invalid URL-plus-box grammar", () => {
    const html = buildSvgEffectCombinationHtml();
    expect(SVG_EFFECT_VIEWPORT).toEqual({ width: 720, height: 1500 });
    expect(html.match(/data-effect-case=/g)).toHaveLength(SVG_EFFECT_CASES.length);
    expect(html).toContain('gradientUnits="objectBoundingBox"');
    expect(html).toContain('gradientUnits="userSpaceOnUse"');
    expect(html).toContain('clipPathUnits="objectBoundingBox"');
    expect(html).toContain('clipPathUnits="userSpaceOnUse"');
    expect(html).toContain('maskUnits="objectBoundingBox"');
    expect(html).toContain('maskContentUnits="userSpaceOnUse"');
    expect(html).toContain('marker-start:url("#marker-');
    expect(html).toContain("vector-effect:non-scaling-stroke");
    expect(html).toContain("color-interpolation:linearRGB");
    expect(html).toContain('filter:url("#filter-');
    expect(html).toContain("transform:perspective(520px) rotateY(9deg)");
    expect(html).toContain("mask-composite:exclude,add");
    expect(html).not.toMatch(/clip-path\s*:\s*url\([^;]+\)\s+(?:fill|stroke|view)-box/);
  });
});
