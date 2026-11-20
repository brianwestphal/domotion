import { describe, expect, it } from "vitest";
import {
  blurSigmaIsAuthentic,
  blurredNormalShadowRefusal,
  boxWindowRoundingAgrees,
  legacyMaskBlitAlphaTable,
  planGaussBorder,
  shadowColorIsAuthentic,
  shadowMaskBlurStdDeviation,
  sharpRectTakesAnalyticBlur,
  skiaBoxBlurWindow,
} from "./shadow-blur-authority.js";

describe("box blur window (SkBlurEngine::BoxBlurWindow / PlanGauss)", () => {
  it("maps σ to the three-box window and border", () => {
    expect([2, 2.5, 3, 3.5, 4, 5, 6, 7, 7.5, 15].map(skiaBoxBlurWindow)).toEqual([4, 5, 6, 7, 8, 9, 11, 13, 14, 28]);
    expect([4, 5, 7, 8, 28].map(planGaussBorder)).toEqual([5, 6, 9, 11, 41]);
  });

  // Exhaustive over every reachable sum: PlanGauss's `(w·S + 2^31) >> 32`
  // against ScaledDividerU32's `((S + half)·w) >> 32`.
  it("agrees on pass rounding exactly for the windows the measurements show exact", () => {
    const agreeing = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].filter(boxWindowRoundingAgrees);
    expect(agreeing).toEqual([4, 5, 6, 8, 10, 11, 12, 14]);
  });

  it("admits σ ≥ 2 only within the verified agreeing windows", () => {
    expect([3, 4, 5, 6, 7, 8, 10, 12, 14, 15, 16, 30].map(blurSigmaIsAuthentic)).toEqual([
      false, // σ 1.5: small_blur Gaussian vs three-box
      true,
      true,
      true,
      false, // window 7
      true,
      false, // window 9
      true,
      false, // window 13
      true, // window 14
      false, // window 15
      false, // window 28: beyond the verified bound
    ]);
  });

  it("writes σ as half the radius with three decimals", () => {
    expect(shadowMaskBlurStdDeviation(4)).toBe(2);
    expect(shadowMaskBlurStdDeviation(4.5)).toBe(2.25);
    expect(shadowMaskBlurStdDeviation(1.234)).toBe(0.617);
  });
});

describe("legacy ARGB32 mask blit", () => {
  it("tabulates (ca·(aa+1)) >> 8", () => {
    const half = legacyMaskBlitAlphaTable(128);
    expect([half[0], half[1], half[127], half[254], half[255]]).toEqual([0, 1, 64, 127, 128]);
    expect(legacyMaskBlitAlphaTable(255)).toEqual(Array.from({ length: 256 }, (_, aa) => aa));
  });

  it("reproduces only 0/255 color channels", () => {
    expect(shadowColorIsAuthentic({ r: 0, g: 0, b: 0, a: 0.4 })).toBe(true);
    expect(shadowColorIsAuthentic({ r: 255, g: 0, b: 255, a: 1 })).toBe(true);
    expect(shadowColorIsAuthentic({ r: 51, g: 102, b: 153, a: 1 })).toBe(false);
    expect(shadowColorIsAuthentic({ r: 0, g: 0, b: 0, a: 0 })).toBe(false);
  });
});

describe("sharpRectTakesAnalyticBlur (filterRectsToNine)", () => {
  const rect = (size: number) => ({ left: 24, top: 24, right: 24 + size, bottom: 24 + size });
  // Measured natively: at σ 2 a 14px rect is box-blurred and a 16px one takes
  // the analytic profile; at σ 3 the boundary moves to 21px.
  it("matches the native route boundaries", () => {
    expect(sharpRectTakesAnalyticBlur(rect(14), 2)).toBe(false);
    expect(sharpRectTakesAnalyticBlur(rect(15), 2)).toBe(true);
    expect(sharpRectTakesAnalyticBlur(rect(20), 3)).toBe(false);
    expect(sharpRectTakesAnalyticBlur(rect(22), 3)).toBe(true);
    expect(sharpRectTakesAnalyticBlur({ left: 0, top: 0, right: 100, bottom: 10 }, 2)).toBe(false);
  });
});

describe("blurredNormalShadowRefusal", () => {
  const base = {
    border: { left: 20, top: 20, right: 30, bottom: 30 },
    x: 4,
    y: 4,
    blur: 8,
    spread: 0,
    color: { r: 255, g: 0, b: 0, a: 1 },
  };
  it("admits a box-blurred whole-pixel sharp rect with a 0/255 color", () => {
    expect(blurredNormalShadowRefusal(base)).toBeNull();
  });
  it("names the stage that differs", () => {
    expect(blurredNormalShadowRefusal({ ...base, blur: 3 })).toBe("box-window");
    expect(blurredNormalShadowRefusal({ ...base, color: { r: 51, g: 102, b: 153, a: 1 } })).toBe("color");
    expect(blurredNormalShadowRefusal({ ...base, x: 4.5 })).toBe("fractional");
    expect(blurredNormalShadowRefusal({ ...base, spread: -5 })).toBe("empty");
    expect(blurredNormalShadowRefusal({ ...base, blur: 4, border: { left: 20, top: 20, right: 40, bottom: 40 } })).toBe(
      "analytic-rect",
    );
  });
});
