// A declared family's weight lives in WHICH face the matcher picked — never in
// a CSS-valued `wght` axis pin.
//
// Blink's mac path applies only `opsz` + font-variation-settings on top of the
// matched face (`FontPlatformDataFromCTFont`,
// `font_platform_data_mac.mm:113-208`, identical at tag 147.0.7727.15 and rev
// 7d859f27); only `MatchSystemUIFont` (the `system-ui` face) sets wght/wdth
// variations from CSS values (`font_matcher_mac.mm:540-589`). The
// discriminating family is `Skia` — its wght axis is [0.48 .. 3.2] in
// QuickDraw units, so a CSS-weight pin clamps EVERY weight to 3.2, the Black
// master, where Chrome paints `Skia-Regular` at 400 and the Light/Bold named
// instances at 300/700 (measured over CDP, 100px "Hamburgefonstiv": 783.359 /
// 720.813 / 836.438 — reproduced by the instance coordinates, not by any
// CSS-valued pin).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  resolveFontKey, getFontInstance, getFontSourceInfo,
  resolveDarwinAxisLocation, __resolveFaceInfoForFileForTest,
} from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

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
  it("pins the embedded-subset location to the matched instance's coordinates", () => {
    // CSS 400 → the default instance (wght 1): an empty pin, NOT wght 3.2.
    const at400 = getFontInstance(resolveFontKey("Skia", 400)!, 400, 100, 0);
    const src400 = getFontSourceInfo(at400);
    expect(src400?.variationAxes).toEqual({});

    // CSS 700 → the Bold named instance at wght 1.95 — far below the 3.2 a
    // clamped CSS pin would produce.
    const at700 = getFontInstance(resolveFontKey("Skia", 700)!, 700, 100, 0);
    const wght700 = getFontSourceInfo(at700)?.variationAxes?.wght;
    expect(wght700).toBeGreaterThan(1.5);
    expect(wght700).toBeLessThan(2.5);

    // CSS 300 → the Light instance at wght 0.48.
    const at300 = getFontInstance(resolveFontKey("Skia", 300)!, 300, 100, 0);
    const wght300 = getFontSourceInfo(at300)?.variationAxes?.wght;
    expect(wght300).toBeGreaterThan(0.4);
    expect(wght300).toBeLessThan(0.6);
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
