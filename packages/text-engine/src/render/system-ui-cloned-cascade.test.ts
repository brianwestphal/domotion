/** DM-EZJKXN: the author-cloned UI primary is the CoreText cascade base. */
import { describe, expect, it } from "vitest";
import { buildFallbackEnvelope } from "./glyph-helper.js";
import { isGlyphHelperAvailable } from "./glyph-helper-transport.js";
import { clearFontResolutionCaches, getFontInstance } from "./font-resolution.js";
import { __resolveSystemFallbackKeyForCpForTest } from "./system-fallback-resolver.js";

const HIGH = { opsz: 32, wdth: 120, wght: 700 };
const LOW = { opsz: 14, wdth: 80, wght: 300 };

describe("UI clone fallback request envelope", () => {
  const request = {
    weight: 400,
    italic: false,
    fontSize: 26,
    systemUi: true,
    uiClone: { opticalSize: 26, axes: HIGH },
  };

  it("passes the clone location only to the macOS UI base", () => {
    expect(buildFallbackEnvelope(".SFNS-Regular", [0x0900], request, "darwin").fonts[0]?.uiClone).toEqual(
      request.uiClone,
    );
    expect(buildFallbackEnvelope(".SFNS-Regular", [0x0900], request, "linux").fonts[0]?.uiClone).toBeUndefined();
    expect(buildFallbackEnvelope(".SFNS-Regular", [0x0900], request, "win32").fonts).toEqual([]);
    expect(
      buildFallbackEnvelope(".SFNS-Regular", [0x0900], { ...request, systemUi: false }, "darwin").fonts[0]?.uiClone,
    ).toBeUndefined();
  });
});

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("variation-cloned system-ui cascade", () => {
  function face(cp: number, settings?: Record<string, number>): { key: string | null; name: string | null } {
    const key = __resolveSystemFallbackKeyForCpForTest(
      cp,
      400,
      0,
      26,
      "sf-pro",
      true,
      undefined,
      100,
      undefined,
      undefined,
      0,
      0,
      settings,
    );
    return {
      key,
      name:
        key == null
          ? null
          : (getFontInstance(key, 400, 26, 0)?.instantiatedPostscriptName ??
            getFontInstance(key, 400, 26, 0)?.postscriptName ??
            null),
    };
  }

  it("changes the Indic handle state and AppleBraille member only for an effective clone", () => {
    clearFontResolutionCaches();
    expect(face(0x0900).name).toBe(".SFDevanagari-Regular_opsz1A0000_wght");
    expect(face(0x0900, HIGH).name).toBe(".SFDevanagari-Regular");
    expect(face(0x0900, LOW).name).toBe(".SFDevanagari-Regular");
    expect(face(0x2800).name).toBe("AppleBraille");
    expect(face(0x2800, HIGH).name).toBe("AppleBraille-Outline6Dot");
    expect(face(0x2800, LOW).name).toBe("AppleBraille-Outline6Dot");
    // An author value equal to the matched UI handle's current wght=400 is
    // a no-op, so CoreText must keep the original cascade.
    expect(face(0x2800, { wght: 400 }).name).toBe("AppleBraille");
  });

  it("keeps no-clone and clone answers separate in both ask orders", () => {
    for (const settings of [
      [undefined, HIGH, undefined, LOW],
      [LOW, undefined, HIGH, undefined],
    ] as const) {
      clearFontResolutionCaches();
      const actual = settings.map((s) => [face(0x0900, s), face(0x2800, s)]);
      actual.forEach(([indic, braille], index) => {
        const cloned = settings[index] != null;
        expect(indic.name).toBe(cloned ? ".SFDevanagari-Regular" : ".SFDevanagari-Regular_opsz1A0000_wght");
        expect(braille.name).toBe(cloned ? "AppleBraille-Outline6Dot" : "AppleBraille");
      });
      expect(actual[0]?.[0]?.key).not.toBe(actual[1]?.[0]?.key);
    }
  });
});
