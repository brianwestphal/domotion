import { beforeEach, describe, expect, it, vi } from "vitest";

const callGlyphHelper = vi.hoisted(() => vi.fn());

vi.mock("./glyph-helper-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./glyph-helper-transport.js")>()),
  callGlyphHelper,
  isGlyphHelperAvailable: () => true,
}));

import { createGlyphHelperFont } from "./glyph-helper-font.js";

describe("native font probe retry", () => {
  beforeEach(() => callGlyphHelper.mockReset());

  it("does not replace a native font with a cacheable fallback after one transport failure", () => {
    callGlyphHelper
      .mockImplementationOnce(() => {
        throw new Error("transient spawn failure");
      })
      .mockReturnValue({
        results: [
          {
            type: "meta",
            unitsPerEm: 1000,
            ascent: 800,
            descent: -200,
            postscriptName: "PingFangSC-Regular",
          },
        ],
      });

    expect(createGlyphHelperFont({ fontPath: "/fonts/PingFang.ttc" })).not.toBeNull();
    expect(callGlyphHelper).toHaveBeenCalledTimes(2);
  });

  it("retries a transient native shaping failure instead of caching fallback metrics", () => {
    callGlyphHelper
      .mockReturnValueOnce({
        results: [
          {
            type: "meta",
            unitsPerEm: 1000,
            ascent: 800,
            descent: -200,
            postscriptName: "PingFangSC-Regular",
          },
        ],
      })
      .mockReturnValueOnce({
        results: [{ type: "glyphs", glyphs: [{ id: 1, advance: 725, bbox: { x: 0, y: 0, w: 1, h: 1 }, d: "" }] }],
      })
      .mockImplementationOnce(() => {
        throw new Error("transient spawn failure");
      })
      .mockReturnValueOnce({
        results: [{ type: "shape", glyphs: [{ id: 1, cluster: 0, ax: 725, ay: 0, dx: 0, dy: 0, d: "" }] }],
      });

    const font = createGlyphHelperFont({ fontPath: "/fonts/PingFang.ttc" });
    expect(font?.layout("H").positions[0]?.xAdvance).toBe(725);
    expect(callGlyphHelper).toHaveBeenCalledTimes(4);
  });

  it("preserves optional Windows line metrics and leaves older helper fields absent", () => {
    const directWriteMetrics = {
      fontSizePx: 16,
      renderSizePx: 16,
      postscriptName: "Fixture",
      measuringMode: "gdi-classic",
      fontSmoothingEnabled: true,
      unitsPerEm: 1000,
      ascent: 875,
      descent: -250,
      lineGap: 25,
    };
    const meta = { type: "meta", unitsPerEm: 1000, ascent: 800, descent: -200 };
    callGlyphHelper.mockReturnValueOnce({ results: [meta] });
    const old = createGlyphHelperFont({ fontPath: "fixture.ttf", fontSizePx: 16 });
    expect(old?.lineGap).toBeUndefined();
    expect(old?.directWriteMetrics).toBeUndefined();
    callGlyphHelper.mockReturnValueOnce({ results: [{ ...meta, lineGap: 100, directWriteMetrics }] });
    const current = createGlyphHelperFont({ fontPath: "fixture.ttf", fontSizePx: 16 });
    expect(current?.lineGap).toBe(100);
    expect(current?.directWriteMetrics).toEqual(directWriteMetrics);
  });
});
