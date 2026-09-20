// A declared family's weight lives in WHICH face the matcher picked — never in
// a CSS-valued `wght` axis pin.
//
// Blink's mac path applies only `opsz` + font-variation-settings on top of the
// matched face (`FontPlatformDataFromCTFont`,
// `font_platform_data_mac.mm:113-208`, identical at tag 147.0.7727.15 and rev
// 7d859f27); only `MatchSystemUIFont` (the `system-ui` face) sets wght/wdth
// variations from CSS values (`font_matcher_mac.mm:540-589`). The
// discriminating family is `Skia` — its wght axis is [0.48 .. 3.2] in
// QuickDraw units, so a CSS-weight pin would clamp every weight to 3.2, the
// Black master. Which named member AppKit exposes has changed across macOS
// releases, so the host matcher is the unit authority and the browser-backed
// E2E test independently verifies the face and advance Chromium paints.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  resolveFontKey, getFontInstance, getFontSourceInfo,
  resolveDarwinAxisLocation, __resolveFaceInfoForFileForTest,
} from "./font-resolution.js";
import { isGlyphHelperAvailable, resolveFamilyStyleMatch } from "./glyph-helper.js";

describe("resolveDarwinAxisLocation with the face's own coordinates", () => {
  const fileAxes = {
    wght: { min: 0.48, default: 1, max: 3.2 },
    wdth: { min: 0.62, default: 1, max: 1.3 },
  };

  it("seeds the face's coordinates and never a CSS-derived wght", () => {
    expect(resolveDarwinAxisLocation(fileAxes, 16, undefined, { wght: 0.48 })).toEqual({ wght: 0.48 });
  });

  it("answers undefined when the face is the default master (no CSS pin fills in)", () => {
    expect(resolveDarwinAxisLocation(fileAxes, 16, undefined, null)).toBeUndefined();
    // A face-own value equal to the default is a no-op location too.
    expect(resolveDarwinAxisLocation(fileAxes, 16, undefined, { wght: 1 })).toBeUndefined();
  });

  it("lets author font-variation-settings override the face's coordinates", () => {
    expect(resolveDarwinAxisLocation(fileAxes, 16, { wght: 2 }, { wght: 0.48 })).toEqual({ wght: 2 });
  });

  it("excludes opsz from the face seed — the specified-size derivation stands", () => {
    const withOpsz = { ...fileAxes, opsz: { min: 17, default: 28, max: 96 } };
    expect(resolveDarwinAxisLocation(withOpsz, 16, undefined, { opsz: 28, wght: 0.48 }))
      .toEqual({ wght: 0.48, opsz: 17 }); // 16 clamps to the axis minimum
  });
});

const SKIA = "/System/Library/Fonts/Supplemental/Skia.ttf";
const describeSkia = process.platform === "darwin" && existsSync(SKIA) && isGlyphHelperAvailable()
  ? describe : describe.skip;

describeSkia("declared `Skia` resolves the face Chrome paints, not the Black master", () => {
  it("uses the live declared-family matcher and never pins a CSS-valued axis", () => {
    for (const weight of [300, 400, 700]) {
      const matched = resolveFamilyStyleMatch("Skia", { weight });
      expect(matched, `native match at ${weight}`).not.toBeNull();
      const font = getFontInstance(resolveFontKey("Skia"), weight, 100, 0);
      expect(font, `font at ${weight}`).not.toBeNull();
      const source = getFontSourceInfo(font);
      expect(font?.instantiatedPostscriptName ?? font?.postscriptName).toBe(matched!.postscriptName);
      expect(source?.path).toBe(SKIA);
      const axis = source?.variationAxes?.wght;
      if (axis != null) {
        expect(axis).toBeGreaterThanOrEqual(0.48);
        expect(axis).toBeLessThanOrEqual(3.2);
        expect(axis).not.toBe(weight);
      }
    }
  });
});

describe("single-file fvar named instances resolve to their coordinates", () => {
  it("the non-collection branch performs the same named-instance lookup as the collection branch", () => {
    if (process.platform !== "darwin") return;
    const SFNS = "/System/Library/Fonts/SFNS.ttf";
    if (!existsSync(SFNS)) return;
    const base = __resolveFaceInfoForFileForTest(SFNS);
    const instances = base.namedInstances ?? [];
    if (instances.length === 0) return; // host's SFNS carries no named psNames
    const inst = instances[0];
    const byName = __resolveFaceInfoForFileForTest(SFNS, inst.postscriptName);
    expect(byName.nameMatched).toBe(true);
    expect(byName.instanceAxes).toEqual(inst.coords);
  });
});
