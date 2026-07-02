import { describe, it, expect } from "vitest";
import { FORMATS, resolveFormat, applyFormatSize, formatNames } from "./formats.js";

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
