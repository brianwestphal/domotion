import { describe, expect, it } from "vitest";
import type { FontInstance } from "./font-instance.js";
import type { DirectWriteFontMetrics } from "./glyph-helper-outline.js";
import { normalLineSpacing } from "./isolated-primary-font-metrics.js";
import { directWriteLineSpacing } from "./windows-font-metrics.js";

const metrics: DirectWriteFontMetrics = {
  fontSizePx: 16,
  renderSizePx: 16,
  postscriptName: "BitmapFixture",
  measuringMode: "gdi-classic",
  fontSmoothingEnabled: true,
  unitsPerEm: 1000,
  ascent: 875,
  descent: -250,
  lineGap: 0,
};

describe("Windows selected DirectWrite line metrics (DM-3ZRKA5)", () => {
  it("uses GDI metrics for a helper-only face without reopening an hhea file", () => {
    const face = {
      unitsPerEm: 1000,
      ascent: 800,
      descent: -200,
      lineGap: 0,
      directory: { tables: {} },
      postscriptName: "BitmapFixture",
      directWriteMetrics: metrics,
    } as unknown as FontInstance;
    expect(normalLineSpacing(face, 16, "win32")).toBe(18);
    expect(normalLineSpacing({ ...face, directWriteMetrics: undefined }, 16, "win32")).toBeNull();
    expect(normalLineSpacing(face, 17, "win32")).toBeNull();
  });

  it("scales at the selected render size rather than the unquantized CSS size", () => {
    const fractional = {
      ...metrics,
      fontSizePx: 15.995,
      renderSizePx: 16,
      unitsPerEm: 2048,
      ascent: 1600,
      descent: -448,
    };
    expect(directWriteLineSpacing(fractional, 15.995, 2048, "BitmapFixture")).toBe(17);
  });

  it("accepts an authoritative native metric with zero descent", () => {
    expect(directWriteLineSpacing({ ...metrics, ascent: 1000, descent: 0 }, 16, 1000)).toBe(16);
  });

  it("rounds a negative half line gap away from zero like Blink lroundf", () => {
    expect(
      directWriteLineSpacing({ ...metrics, unitsPerEm: 2048, ascent: 1600, descent: -448, lineGap: -64 }, 16, 2048),
    ).toBe(16);
  });

  it("keeps SkScalarRoundToScalar's double addition at a below-half descent", () => {
    const size = 15.999999046325684;
    const boundary = { ...metrics, fontSizePx: size, renderSizePx: size, unitsPerEm: 2048, ascent: 640, descent: -64 };
    expect(directWriteLineSpacing(boundary, size, 2048)).toBe(5);
  });

  it.each([
    { fontSizePx: 17 },
    { unitsPerEm: 2048 },
    { postscriptName: "WrongFace" },
    { ascent: Number.NaN },
    { descent: 100 },
    { renderSizePx: Number.POSITIVE_INFINITY },
    { renderSizePx: 0 },
    { lineGap: Number.NaN },
    { renderSizePx: 3e38 },
    { measuringMode: "unsupported" },
  ])("rejects stale or malformed metric evidence %j", (patch) => {
    const malformed = Object.assign({ ...metrics }, patch);
    expect(directWriteLineSpacing(malformed, 16, 1000, "BitmapFixture")).toBeNull();
  });

  it("keeps old-helper and tiny-font fallbacks unresolved", () => {
    expect(directWriteLineSpacing(undefined, 16, 1000)).toBeNull();
    expect(directWriteLineSpacing({ ...metrics, fontSizePx: 1, renderSizePx: 1 }, 1, 1000)).toBeNull();
  });
});
