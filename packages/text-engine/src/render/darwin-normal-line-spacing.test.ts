import { afterEach, describe, expect, it, vi } from "vitest";
import { coreTextNormalLineSpacing, darwinNormalLineSpacing } from "./darwin-normal-line-spacing.js";
import { fontSourceMap, type FontInstance } from "./font-instance.js";
import type { CoreTextMetrics, MetaResponse } from "./glyph-helper-outline.js";
import * as transport from "./glyph-helper-transport.js";
import { normalLineSpacing } from "./isolated-primary-font-metrics.js";

const request = { fontSize: 16, postscriptName: "Test-Regular", unitsPerEm: 1000 };
const envelope = (fields: Partial<CoreTextMetrics> = {}): MetaResponse => ({
  unitsPerEm: 1000,
  ascent: 900,
  descent: -200,
  nameMatched: true,
  postscriptName: "Test-Regular",
  coreTextMetrics: {
    fontRef: "normal-line-spacing",
    fontSizePx: 16,
    actualSizePx: 16,
    units: "css-px",
    unitsPerEm: 1000,
    postscriptName: "Test-Regular",
    familyName: "Test",
    nameMatched: true,
    ascent: 14.5,
    descent: 3.25,
    leading: 1.5,
    ...fields,
  },
});
function face(withFileMetrics = false): FontInstance {
  const font = {
    unitsPerEm: 1000,
    ascent: 900,
    descent: -200,
    ...(withFileMetrics ? { lineGap: 100 } : {}),
  } as unknown as FontInstance;
  fontSourceMap.set(font, { path: "/test/font.ttf", postscriptName: "Test-Regular", nameMatched: true, faceIndex: 0 });
  return font;
}
afterEach(() => vi.restoreAllMocks());

describe("CoreText CSS-size normal line spacing (DM-S15JM4)", () => {
  it("rounds the three components separately and applies Blink's native-family ascent hack", () => {
    expect(coreTextNormalLineSpacing(envelope(), request)).toBe(20);
    expect(coreTextNormalLineSpacing(envelope({ familyName: "Helvetica" }), request)).toBe(23);
    expect(coreTextNormalLineSpacing(envelope({ familyName: "Helvetica Neue" }), request)).toBe(20);
    expect(coreTextNormalLineSpacing(envelope({ leading: -0.5 }), request)).toBe(17);
  });
  it.each([
    { fontRef: "another-query" },
    { units: "design-units" },
    { fontSizePx: 17 },
    { actualSizePx: 1000 },
    { unitsPerEm: 2048 },
    { postscriptName: "Substitute-Regular" },
    { nameMatched: false },
    { familyName: "" },
    { ascent: NaN },
    { descent: -1 },
    { leading: Infinity },
    { ascent: 14.5000000001 },
  ])("rejects unauthenticated or wrong-unit metadata %j", (fields) => {
    expect(coreTextNormalLineSpacing(envelope(fields as Partial<CoreTextMetrics>), request)).toBeNull();
  });
  it("requires the actual Float32 size rather than rounding or rescaling design units", () => {
    const fontSize = 16.123456789;
    const metrics = envelope({ fontSizePx: fontSize, actualSizePx: Math.fround(fontSize) });
    expect(coreTextNormalLineSpacing(metrics, { ...request, fontSize })).toBe(20);
    expect(
      coreTextNormalLineSpacing(envelope({ fontSizePx: fontSize, actualSizePx: fontSize }), { ...request, fontSize }),
    ).toBeNull();
    expect(coreTextNormalLineSpacing({ ...metrics, unitsPerEm: 2000 }, { ...request, fontSize })).toBeNull();
  });
  it("rounds tiny CSS layout metrics before the macOS family hack", () => {
    expect(
      coreTextNormalLineSpacing(
        envelope({ ascent: Math.fround(2.49), descent: Math.fround(0.99), leading: 0 }),
        request,
      ),
    ).toBe(3);
    expect(
      coreTextNormalLineSpacing(
        envelope({ familyName: "Times", ascent: Math.fround(2.49), descent: Math.fround(0.99), leading: 0 }),
        request,
      ),
    ).toBe(3);
  });
  it("asks at the actual CSS size and caches only authenticated answers by live face and size", () => {
    vi.spyOn(transport, "isGlyphHelperAvailable").mockReturnValue(true);
    const call = vi.spyOn(transport, "callGlyphHelper").mockImplementation((input) => ({
      results: [
        {
          type: "meta",
          ...envelope({
            fontSizePx: input.queries[0].type === "meta" ? input.queries[0].fontSizePx : 0,
            actualSizePx: input.fonts[0].size,
          }),
        },
      ],
    }));
    const font = face();
    expect(darwinNormalLineSpacing(font, 16)).toBe(20);
    expect(darwinNormalLineSpacing(font, 16)).toBe(20);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].fonts[0].size).toBe(16);
    expect(darwinNormalLineSpacing(font, 20)).toBe(20);
    expect(call.mock.calls[1][0].fonts[0].size).toBe(20);
    expect(call.mock.calls[1][0].queries[0]).toMatchObject({ type: "meta", fontSizePx: 20 });
  });
  it("authenticates the selected physical member when no PS name was requested", () => {
    vi.spyOn(transport, "isGlyphHelperAvailable").mockReturnValue(true);
    const call = vi.spyOn(transport, "callGlyphHelper").mockReturnValue({ results: [{ type: "meta", ...envelope() }] });
    const font = face();
    Object.assign(font, { postscriptName: "Test-Regular" });
    fontSourceMap.set(font, { path: "/test/font.ttf", nameMatched: true, faceIndex: 0 });
    expect(darwinNormalLineSpacing(font, 16)).toBe(20);
    expect(call.mock.calls[0][0].fonts[0].postscriptName).toBe("Test-Regular");
  });
  it("preserves old-helper file fallback and retries a missing optional envelope", () => {
    vi.spyOn(transport, "isGlyphHelperAvailable").mockReturnValue(true);
    const old: MetaResponse = { ...envelope() };
    delete old.coreTextMetrics;
    const call = vi.spyOn(transport, "callGlyphHelper").mockReturnValue({ results: [{ type: "meta", ...old }] });
    const helperOnly = face();
    expect(normalLineSpacing(helperOnly, 16, "darwin")).toBeNull();
    expect(normalLineSpacing(face(true), 16, "darwin")).toBe(19);
    call.mockReturnValue({ results: [{ type: "meta", ...envelope() }] });
    expect(normalLineSpacing(helperOnly, 16, "darwin")).toBe(20);
  });
});
