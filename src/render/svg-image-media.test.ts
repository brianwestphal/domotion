import { describe, expect, it } from "vitest";

import { evaluateMediaQueryList } from "./svg-image-media.js";

const vp = { w: 200, h: 100 };

describe("evaluateMediaQueryList (the <img> SVG document's media environment)", () => {
  it("decides viewport features against the image viewport, and leaves them undecided without one", () => {
    expect(evaluateMediaQueryList("(min-width: 150px)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(100px < width <= 200px)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(orientation: portrait)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(min-width: 150px)", null)).toBeNull();
    expect(evaluateMediaQueryList("(orientation: landscape)", null)).toBeNull();
  });

  // ResolveColorSchemeForEmbedding hands the image the embedder's scheme; the
  // boolean form is always true (PrefersColorSchemeMediaFeatureEval).
  it("decides prefers-color-scheme from the embedding scheme only when it is known", () => {
    expect(evaluateMediaQueryList("(prefers-color-scheme: dark)", vp, { preferredColorScheme: "dark" })).toBe(true);
    expect(evaluateMediaQueryList("(prefers-color-scheme: dark)", null, { preferredColorScheme: "light" })).toBe(false);
    expect(evaluateMediaQueryList("not (prefers-color-scheme: light)", vp, { preferredColorScheme: "dark" })).toBe(
      true,
    );
    expect(evaluateMediaQueryList("(prefers-color-scheme: dark)", vp)).toBeNull();
    expect(evaluateMediaQueryList("(prefers-color-scheme)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(prefers-color-scheme: dim)", vp, { preferredColorScheme: "dark" })).toBeNull();
  });

  // The image page keeps the Settings defaults: no hover, no pointer
  // (HOVER_TYPE_NONE / POINTER_TYPE_NONE), no contrast or transparency
  // preference, and a 1dppx device pixel ratio.
  it("decides the image page's fixed interaction and display features", () => {
    expect(evaluateMediaQueryList("(hover: hover)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(hover: none)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(hover)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(any-hover: none)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(pointer: fine)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(any-pointer: coarse)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(pointer: none)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(any-pointer)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(prefers-contrast: more)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(prefers-contrast)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(prefers-reduced-transparency: no-preference)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(resolution: 1dppx)", null)).toBe(true);
    expect(evaluateMediaQueryList("(min-resolution: 2dppx)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(max-resolution: 96dpi)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(resolution >= 1.5x)", vp)).toBe(false);
    // dpcm compares at two decimals: 1dppx = 37.795dpcm -> 0.9999... rounds to 1.
    expect(evaluateMediaQueryList("(resolution: 37.8dpcm)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(resolution)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(-webkit-min-device-pixel-ratio: 2)", vp)).toBe(false);
    expect(evaluateMediaQueryList("(-webkit-device-pixel-ratio: 1)", vp)).toBe(true);
    expect(evaluateMediaQueryList("(hover: hover), (min-width: 10px)", vp)).toBe(true);
  });

  it("leaves Settings-derived and unknown features undecided", () => {
    expect(evaluateMediaQueryList("(prefers-reduced-motion: reduce)", vp)).toBeNull();
    expect(evaluateMediaQueryList("(forced-colors: active)", vp)).toBeNull();
    expect(evaluateMediaQueryList("(color-gamut: p3)", vp)).toBeNull();
    expect(evaluateMediaQueryList("(hover: maybe)", vp)).toBeNull();
  });
});
