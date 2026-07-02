import { describe, it, expect } from "vitest";
import {
  FORMATS,
  resolveFormat,
  applyFormatSize,
  safeAreaPadding,
  formatNames,
  formatScaleFactor,
  safeAreaGuideSvg,
  ADAPTIVE_REFERENCE,
} from "./formats.js";

describe("resolveFormat — preset lookup (DM-1534)", () => {
  it("resolves each built-in preset to its documented canvas size", () => {
    expect(resolveFormat("reel")).toMatchObject({ width: 1080, height: 1920 });
    expect(resolveFormat("square")).toMatchObject({ width: 1080, height: 1080 });
    expect(resolveFormat("portrait")).toMatchObject({ width: 1080, height: 1350 });
    expect(resolveFormat("landscape")).toMatchObject({ width: 1920, height: 1080 });
  });

  it("treats `story` as an alias of `reel`", () => {
    expect(resolveFormat("story")).toEqual(resolveFormat("reel"));
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveFormat("  REEL ")).toEqual(resolveFormat("reel"));
    expect(resolveFormat("Square")).toEqual(resolveFormat("square"));
  });

  it("exposes preset names + aliases via formatNames()", () => {
    const names = formatNames();
    expect(names).toContain("reel");
    expect(names).toContain("story");
    expect(names).toContain("square");
    expect(names).toContain("portrait");
    expect(names).toContain("landscape");
    // Sorted for stable help/error text.
    expect(names).toEqual([...names].sort());
  });
});

describe("resolveFormat — raw WIDTHxHEIGHT parse (DM-1534)", () => {
  it("parses a raw WxH size", () => {
    expect(resolveFormat("1600x900")).toMatchObject({ width: 1600, height: 900 });
  });

  it("accepts the unicode × separator and surrounding space", () => {
    expect(resolveFormat("800 × 600")).toMatchObject({ width: 800, height: 600 });
  });

  it("throws on a malformed size", () => {
    expect(() => resolveFormat("1600")).toThrow(/unknown format/);
    expect(() => resolveFormat("wide")).toThrow(/unknown format/);
    expect(() => resolveFormat("")).toThrow(/empty value/);
  });

  it("rejects a zero dimension", () => {
    expect(() => resolveFormat("0x600")).toThrow(/positive/);
    expect(() => resolveFormat("600x0")).toThrow(/positive/);
  });

  it("lists the valid presets in the error message", () => {
    expect(() => resolveFormat("nope")).toThrow(/reel/);
    expect(() => resolveFormat("nope")).toThrow(/WIDTHxHEIGHT/);
  });
});

describe("resolveFormat — safe-area inset math (DM-1534)", () => {
  it("reel reserves 12% top / 18% bottom, 6% sides (px of the axis it sits on)", () => {
    // 1080 × 1920: top = 1920*0.12 = 230.4 → 230; bottom = 1920*0.18 = 345.6 → 346;
    // left/right = 1080*0.06 = 64.8 → 65.
    expect(resolveFormat("reel").safeInset).toEqual({ top: 230, right: 65, bottom: 346, left: 65 });
  });

  it("symmetric feed formats use an even ~6% inset per side", () => {
    // 1080 square: 1080*0.06 = 64.8 → 65 on every side.
    expect(resolveFormat("square").safeInset).toEqual({ top: 65, right: 65, bottom: 65, left: 65 });
    // landscape 1920×1080: top/bottom off 1080 → 65; left/right off 1920 → 115.
    expect(resolveFormat("landscape").safeInset).toEqual({ top: 65, right: 115, bottom: 65, left: 115 });
  });

  it("raw WxH gets the default even 6% inset", () => {
    // 1000×1000 → 60 all around (clean rounding).
    expect(resolveFormat("1000x1000").safeInset).toEqual({ top: 60, right: 60, bottom: 60, left: 60 });
  });

  it("inset is always inside the canvas (top+bottom < height, left+right < width)", () => {
    for (const name of Object.keys(FORMATS)) {
      const f = resolveFormat(name);
      expect(f.safeInset.top + f.safeInset.bottom).toBeLessThan(f.height);
      expect(f.safeInset.left + f.safeInset.right).toBeLessThan(f.width);
    }
  });
});

describe("applyFormatSize — precedence (DM-1534)", () => {
  const reel = resolveFormat("reel");

  it("fills width/height from the format when neither is set (format > template default)", () => {
    const raw: Record<string, unknown> = {};
    applyFormatSize(raw, reel);
    expect(raw).toMatchObject({ width: 1080, height: 1920 });
  });

  it("keeps an explicit width/height (explicit --width/--height > format)", () => {
    const raw: Record<string, unknown> = { width: 800, height: 600 };
    applyFormatSize(raw, reel);
    expect(raw).toMatchObject({ width: 800, height: 600 });
  });

  it("lets a format size only the axis the caller didn't pin", () => {
    const raw: Record<string, unknown> = { width: 800 };
    applyFormatSize(raw, reel);
    // explicit width wins; height comes from the format.
    expect(raw).toMatchObject({ width: 800, height: 1920 });
  });

  it("does not clobber other params", () => {
    const raw: Record<string, unknown> = { title: "Hi" };
    applyFormatSize(raw, reel);
    expect(raw.title).toBe("Hi");
  });
});

describe("safeAreaPadding — content within safe area (DM-1537)", () => {
  const defaults = { top: 48, right: 48, bottom: 48, left: 48 };

  it("returns the defaults unchanged when no inset (byte-identical default output)", () => {
    expect(safeAreaPadding(defaults)).toBe("48px 48px 48px 48px");
  });

  it("takes the per-side MAX of default and safe inset", () => {
    // reel inset {230,65,346,65}: top/bottom exceed 48 → inset wins; sides 65 > 48 → inset wins.
    expect(safeAreaPadding(defaults, resolveFormat("reel").safeInset)).toBe("230px 65px 346px 65px");
  });

  it("keeps the larger default where the inset is smaller", () => {
    // A tiny inset per side stays below the 48px default → default wins on every side.
    expect(safeAreaPadding(defaults, { top: 10, right: 10, bottom: 10, left: 10 })).toBe("48px 48px 48px 48px");
  });

  it("mixes per side (default on one axis, inset on another)", () => {
    expect(safeAreaPadding({ top: 0, right: 0, bottom: 0, left: 0 }, { top: 100, right: 0, bottom: 200, left: 0 }))
      .toBe("100px 0px 200px 0px");
  });
});

describe("formatScaleFactor — adaptive per-ratio type scaling (DM-1541)", () => {
  it("returns exactly 1 with no safeInset (byte-identical default output)", () => {
    expect(formatScaleFactor(1080, 1920, undefined)).toBe(1);
    expect(formatScaleFactor(999, 12345, undefined)).toBe(1);
  });

  it("scales UP for a 9:16 reel — bigger relative type improves legibility", () => {
    const reel = resolveFormat("reel");
    const sf = formatScaleFactor(reel.width, reel.height, reel.safeInset);
    // Larger usable area than the 1280×720 reference box → factor > 1.
    expect(sf).toBeGreaterThan(1.3);
    expect(sf).toBeLessThan(1.85);
  });

  it("is the sqrt of the usable-area ratio vs the reference box", () => {
    const reel = resolveFormat("reel");
    const contentW = reel.width - reel.safeInset.left - reel.safeInset.right;
    const contentH = reel.height - reel.safeInset.top - reel.safeInset.bottom;
    const refW = ADAPTIVE_REFERENCE.width - 2 * ADAPTIVE_REFERENCE.inset;
    const refH = ADAPTIVE_REFERENCE.height - 2 * ADAPTIVE_REFERENCE.inset;
    const expected = Math.sqrt((contentW * contentH) / (refW * refH));
    expect(formatScaleFactor(reel.width, reel.height, reel.safeInset)).toBeCloseTo(expected, 6);
  });

  it("clamps a pathologically small canvas to the floor", () => {
    // A 100×100 canvas with a tiny inset is far under the reference → clamp at min.
    expect(formatScaleFactor(100, 100, { top: 6, right: 6, bottom: 6, left: 6 })).toBe(0.75);
  });

  it("clamps a pathologically large canvas to the ceiling", () => {
    expect(formatScaleFactor(8000, 8000, { top: 0, right: 0, bottom: 0, left: 0 })).toBe(1.85);
  });

  it("honors caller-supplied min/max overrides", () => {
    expect(formatScaleFactor(8000, 8000, { top: 0, right: 0, bottom: 0, left: 0 }, { max: 1.2 })).toBe(1.2);
    expect(formatScaleFactor(100, 100, { top: 6, right: 6, bottom: 6, left: 6 }, { min: 0.9 })).toBe(0.9);
  });
});

describe("safeAreaGuideSvg — informational overlay (DM-1538)", () => {
  const inset = { top: 230, right: 65, bottom: 346, left: 65 };

  it("draws the dashed rect at the resolved inset, sized to the safe area", () => {
    const g = safeAreaGuideSvg(1080, 1920, inset);
    // x=left, y=top, w=width-left-right, h=height-top-bottom.
    expect(g).toContain('x="65"');
    expect(g).toContain('y="230"');
    expect(g).toContain('width="950"'); // 1080 - 65 - 65
    expect(g).toContain('height="1344"'); // 1920 - 230 - 346
    expect(g).toContain("stroke-dasharray");
  });

  it("is a single non-interactive, tagged group (nests cleanly, doesn't capture clicks)", () => {
    const g = safeAreaGuideSvg(1080, 1920, inset);
    expect(g.startsWith('<g data-domotion-safe-guide="1" pointer-events="none">')).toBe(true);
    expect(g.endsWith("</g>")).toBe(true);
  });

  it("clamps a degenerate (over-inset) safe area to a non-negative box", () => {
    const g = safeAreaGuideSvg(100, 100, { top: 80, right: 80, bottom: 80, left: 80 });
    expect(g).toContain('width="0"');
    expect(g).toContain('height="0"');
  });
});
