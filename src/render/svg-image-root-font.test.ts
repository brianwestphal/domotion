import { describe, expect, it } from "vitest";

import { imageRootFontMetricUnits, rootLineHeight } from "./svg-image-root-font.js";

const decls = (entries: Record<string, string>) => ({ get: (name: string): string | null => entries[name] ?? null });

describe("rootLineHeight (ComputedLineHeight over ConvertLineHeight)", () => {
  it("resolves numbers, percentages and lengths, and leaves normal unresolved", () => {
    expect(rootLineHeight("1.5", 16)).toBe(24);
    // A number resolves through LayoutUnit (1/64 px, truncated).
    expect(rootLineHeight("1.3", 15)).toBe(Math.trunc(19.5 * 64) / 64);
    // A percentage keeps only its integer part (ClampTo<int>).
    expect(rootLineHeight("150.9%", 20)).toBe(30);
    expect(rootLineHeight("20px", 16)).toBe(20);
    expect(rootLineHeight("2em", 10)).toBe(20);
    expect(rootLineHeight("normal", 16)).toBeNull();
    expect(rootLineHeight(null, 16)).toBeNull();
    expect(rootLineHeight("3ex", 16)).toBeNull();
  });
});

describe("imageRootFontMetricUnits", () => {
  it("keeps geometricPrecision metrics unresolved without losing explicit lh", () => {
    const geometric = { "text-rendering": "geometricPrecision", "font-family": "Arial" };
    expect(imageRootFontMetricUnits(decls(geometric), 16, null)?.("lh")).toBeNull();
    expect(imageRootFontMetricUnits(decls(geometric), 16, null)?.("ex")).toBeNull();
    expect(imageRootFontMetricUnits(decls({ ...geometric, "line-height": "20px" }), 16, null)?.("lh")).toBe(20);
    expect(imageRootFontMetricUnits(decls({ "text-rendering": "auto", "line-height": "20px" }), 16, null)?.("lh")).toBe(
      20,
    );
  });
  it("is null without a known font size or with an unresolved font declaration", () => {
    expect(imageRootFontMetricUnits(decls({}), null, null)).toBeNull();
    expect(imageRootFontMetricUnits(decls({ "font-stretch": "condensed" }), 16, null)).toBeNull();
    expect(imageRootFontMetricUnits(decls({ font: "12px serif" }), 16, null)).toBeNull();
    expect(imageRootFontMetricUnits(decls({ "font-weight": "heavy" }), 16, null)).toBeNull();
  });

  it("resolves lh / rlh from line-height and leaves other units alone", () => {
    const units = imageRootFontMetricUnits(decls({ "line-height": "2" }), 16, null);
    expect(units?.("lh")).toBe(32);
    expect(units?.("rlh")).toBe(32);
    expect(units?.("vw")).toBeNull();
    const normal = imageRootFontMetricUnits(decls({}), 16, null)?.("lh");
    if (process.platform === "darwin") expect(normal).toBeGreaterThan(0);
    else expect(normal).toBeNull();
  });

  it("keeps explicit line height independent of unresolved small-caps glyph metrics", () => {
    const units = imageRootFontMetricUnits(
      decls({ "font-variant-caps": "small-caps", "line-height": "1.5" }),
      24,
      null,
    );
    expect(units?.("lh")).toBe(36);
    expect(units?.("ex")).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("resolves normal lh / rlh from macOS primary-font line spacing", () => {
    const units = imageRootFontMetricUnits(decls({ "font-family": "Arial" }), 16, null);
    expect(units?.("lh")).toBe(18);
    expect(units?.("rlh")).toBe(units?.("lh"));
    expect(imageRootFontMetricUnits(decls({ "font-family": "Arial", "line-height": "normal" }), 16, null)?.("lh")).toBe(
      18,
    );
  });

  it("reads ex / cap / ch / ic from the resolved primary face, scaled to the font size", () => {
    const small = imageRootFontMetricUnits(decls({ "font-family": "serif" }), 10, null);
    const large = imageRootFontMetricUnits(decls({ "font-family": "serif" }), 20, null);
    for (const unit of ["ex", "cap", "ch", "ic"]) {
      const a = small?.(unit);
      const b = large?.(unit);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeCloseTo(2 * (a ?? 0), 6);
      expect(small?.(`r${unit}`)).toBe(a);
    }
  });
});
