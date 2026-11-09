import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FontInstance } from "./font-instance.js";
import type { DirectWriteFontMetrics } from "./glyph-helper-outline.js";

const boundary = vi.hoisted(() => ({ call: vi.fn(), available: vi.fn(), source: vi.fn() }));
vi.mock("./glyph-helper-transport.js", () => ({
  callGlyphHelper: boundary.call,
  isGlyphHelperAvailable: boundary.available,
}));
vi.mock("./font-instance.js", () => ({ getFontSourceInfo: boundary.source }));

import { windowsNativeLineSpacing } from "./windows-font-metrics.js";

const metric = (size: number): DirectWriteFontMetrics => ({
  fontSizePx: size,
  renderSizePx: size,
  postscriptName: "Fixture",
  measuringMode: "natural",
  fontSmoothingEnabled: true,
  unitsPerEm: 1000,
  ascent: 800,
  descent: -200,
  lineGap: 0,
});
const response = (size: number) => ({
  type: "meta",
  nameMatched: true,
  unitsPerEm: 1000,
  postscriptName: "Fixture",
  directWriteMetrics: metric(size),
});
const face = (): FontInstance => ({ unitsPerEm: 1000, postscriptName: "Fixture" }) as unknown as FontInstance;

beforeEach(() => {
  boundary.call.mockReset();
  boundary.available.mockReset().mockReturnValue(true);
  boundary.source.mockReset().mockReturnValue({ nameMatched: true, path: "fixture.ttf", postscriptName: "Fixture" });
});

describe("Windows line metric native query", () => {
  it("does not cache missing old-helper evidence and can recover on a later query", () => {
    const font = face();
    boundary.call
      .mockReturnValueOnce({ results: [{ ...response(16), directWriteMetrics: undefined }] })
      .mockReturnValue({ results: [response(16)] });
    expect(windowsNativeLineSpacing(font, 16)).toBeNull();
    expect(windowsNativeLineSpacing(font, 16)).toBe(16);
    expect(windowsNativeLineSpacing(font, 16)).toBe(16);
    expect(boundary.call).toHaveBeenCalledTimes(2);
    expect(boundary.call.mock.calls[0][0].queries).toEqual([{ type: "meta", fontRef: "primary", fontSizePx: 16 }]);
  });

  it("keeps request sizes isolated when one font object is queried repeatedly", () => {
    const font = face();
    boundary.call.mockReturnValueOnce({ results: [response(16)] }).mockReturnValueOnce({ results: [response(24)] });
    expect(windowsNativeLineSpacing(font, 16)).toBe(16);
    expect(windowsNativeLineSpacing(font, 24)).toBe(24);
    expect(windowsNativeLineSpacing(font, 16)).toBe(16);
    expect(boundary.call).toHaveBeenCalledTimes(2);
  });

  it("uses the opened file face name when a canonical path spec omits it", () => {
    boundary.source.mockReturnValue({ nameMatched: true, path: "fixture.ttf" });
    boundary.call.mockReturnValue({ results: [response(16)] });
    expect(windowsNativeLineSpacing(face(), 16)).toBe(16);
    expect(boundary.call.mock.calls[0][0].fonts[0].postscriptName).toBe("Fixture");
  });

  it.each([{ postscriptName: "Other" }, { unitsPerEm: 2048 }, { nameMatched: false }])(
    "rejects mismatched native face evidence %j",
    (patch) => {
      boundary.call.mockReturnValue({ results: [{ ...response(16), ...patch }] });
      expect(windowsNativeLineSpacing(face(), 16)).toBeNull();
    },
  );

  it("retains fallback when the helper is absent or the query throws", () => {
    boundary.available.mockReturnValue(false);
    expect(windowsNativeLineSpacing(face(), 16)).toBeNull();
    expect(boundary.call).not.toHaveBeenCalled();
    boundary.available.mockReturnValue(true);
    boundary.call.mockImplementation(() => {
      throw new Error("helper unavailable");
    });
    expect(windowsNativeLineSpacing(face(), 16)).toBeNull();
  });
});
