// `font-stretch` driving the variable `wdth` axis.
//
// Face selection is only half of `font-stretch`: on a variable face the width
// is an axis. Blink applies it in exactly two places, and the mapping is the
// identity clamped into the axis range:
//
//   - the macOS `system-ui` face: `MatchSystemUIFont` puts the CSS percentage
//     into a CoreText `wdth` variation, clamped to the axis range first
//     (`platform/fonts/mac/font_matcher_mac.mm:540-589` and `:483-538`, rev
//     7d859f27). Measured over CDP at 26px on "Hamburgefonstiv": normal 192.17,
//     50% -> `.SFNS-Regular_wdth320000_…` (0x320000/65536 = 50.0) at 133.52,
//     and 200% -> `wdth960000` = 150.0 — clamped to SF's `wdth` max.
//   - variable webfonts, every platform: `FontCustomPlatformData::
//     GetFontPlatformData` pins `wdth` to the request clamped to the
//     capabilities — the font's own axis range when the @font-face descriptor
//     is auto (`platform/fonts/font_custom_platform_data.cc:155-169`).
//
// A DECLARED family gets neither: `MatchFontFamily` turns the width into the
// condensed/expanded symbolic trait and picks a cut or named instance, with no
// axis applied afterward. Measured on the `Skia` family (which has BOTH
// condensed named instances AND a wdth axis): 50% / 62.5% / 75% all paint
// `Skia-Regular_Condensed` at the same 130.08px — under an axis model those
// three would differ.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { getFontInstance, registerWebfont, clearWebfonts, resolveFont, __darwinSystemUiWdthForTest } from "./font-resolution.js";

const SFNS = "/System/Library/Fonts/SFNS.ttf";
const describeMac = process.platform === "darwin" && existsSync(SFNS) ? describe : describe.skip;

type InstanceView = {
  unitsPerEm: number;
  layout(text: string): { glyphs: Array<{ advanceWidth: number }> };
  _appliedVariationAxes?: Record<string, number>;
} | null;

function advanceOfH(inst: InstanceView): number {
  if (inst == null) return NaN;
  return inst.layout("H").glyphs[0].advanceWidth / inst.unitsPerEm;
}

describe("darwinSystemUiWdth gate", () => {
  it("requests the axis only for the system-ui face keys", () => {
    if (process.platform !== "darwin") return;
    expect(__darwinSystemUiWdthForTest("sf-pro", 50, true)).toBe(50);
    expect(__darwinSystemUiWdthForTest("sf-pro-italic", 125, true)).toBe(125);
    // The same logical keys reached through an author-named family are not the
    // system face and must retain Blink's declared-family cut selection.
    expect(__darwinSystemUiWdthForTest("sf-pro", 50, false)).toBe(100);
    expect(__darwinSystemUiWdthForTest("sf-pro-italic", 125, false)).toBe(100);
    // Declared families keep the trait/cut mechanism — no axis request, even
    // for keys whose file exposes a wdth axis.
    expect(__darwinSystemUiWdthForTest("helvetica-neue", 50, false)).toBe(100);
    expect(__darwinSystemUiWdthForTest("sysfb:Skia-Regular", 50, false)).toBe(100);
    expect(__darwinSystemUiWdthForTest("sf-pro", 100, true)).toBe(100);
  });
});

describeMac("system-ui wdth axis (macOS)", () => {
  it("keeps system-ui CSS weight axes separate from named-family cuts", () => {
    const systemLight = resolveFont("system-ui", 300, 26, 0) as InstanceView;
    const systemBold = resolveFont("system-ui", 700, 26, 0) as InstanceView;
    expect(systemLight?._appliedVariationAxes?.wght).toBe(300);
    expect(systemBold?._appliedVariationAxes?.wght).toBe(700);

    const expected: Record<string, [string, string]> = {
      "SF Pro": ["SFPro-Thin", "SFPro-Bold"],
      "SF Pro Text": ["SFProText-Thin", "SFProText-Bold"],
      "SF Pro Display": ["SFProDisplay-Thin", "SFProDisplay-Bold"],
    };
    for (const [family, [lightName, boldName]] of Object.entries(expected)) {
      const light = resolveFont(`"${family}"`, 300, 26, 0) as (InstanceView & { postscriptName?: string; instantiatedPostscriptName?: string });
      const bold = resolveFont(`"${family}"`, 700, 26, 0) as (InstanceView & { postscriptName?: string; instantiatedPostscriptName?: string });
      // These public families are optional downloads. Assert exact Chromium
      // identities when present; on a stock host the route still remains
      // declared (the pure provenance gate above covers that invariant).
      const lightResolved = light?.instantiatedPostscriptName ?? light?.postscriptName;
      const boldResolved = bold?.instantiatedPostscriptName ?? bold?.postscriptName;
      if (lightResolved?.startsWith(family.replaceAll(" ", "")) === true) {
        expect(lightResolved, family).toBe(lightName);
        expect(boldResolved, family).toBe(boldName);
      }
    }
  });

  it("does not leak the system axis into explicitly named SF families", () => {
    const system = resolveFont("system-ui", 400, 26, 0, undefined, 50) as InstanceView;
    expect(system?._appliedVariationAxes?.wdth).toBe(50);

    for (const family of ["SF Pro", "SF Pro Text", "SF Pro Display"]) {
      const named = resolveFont(`"${family}"`, 400, 26, 0, undefined, 50) as InstanceView;
      expect(named, family).not.toBeNull();
      expect(named!._appliedVariationAxes?.wdth, family).not.toBe(50);
    }
  });

  it("narrows the SF face at font-stretch 50% and records the axis location", () => {
    const normal = getFontInstance("sf-pro", 400, 26, 0, undefined, 100, true) as InstanceView;
    const condensed = getFontInstance("sf-pro", 400, 26, 0, undefined, 50, true) as InstanceView;
    expect(normal).not.toBeNull();
    expect(condensed).not.toBeNull();
    expect(advanceOfH(condensed)).toBeLessThan(advanceOfH(normal));
    expect(condensed!._appliedVariationAxes?.wdth).toBe(50);
    // The normal-width instance carries no wdth pin at all.
    expect(normal!._appliedVariationAxes?.wdth).toBeUndefined();
  });

  it("clamps 200% to the axis maximum, as both Blink and Skia do", () => {
    // SFNS.ttf's wdth axis is [30, 150]; Blink clamps the request into the
    // range before applying (`ClampVariationValuesToFontAcceptableRange`), and
    // Skia clamps again in `ctvariation_from_SkFontArguments` (SkTPin,
    // `src/ports/SkTypeface_mac_ct.cpp:1147`, rev ebf5052) — so 200% and 150%
    // are the same instance.
    const at200 = getFontInstance("sf-pro", 400, 26, 0, undefined, 200, true) as InstanceView;
    const at150 = getFontInstance("sf-pro", 400, 26, 0, undefined, 150, true) as InstanceView;
    expect(at200!._appliedVariationAxes?.wdth).toBe(150);
    expect(advanceOfH(at200)).toBe(advanceOfH(at150));
    expect(advanceOfH(at200)).toBeGreaterThan(advanceOfH(getFontInstance("sf-pro", 400, 26, 0, undefined, 100, true) as InstanceView));
  });

  it("keeps distinct stretches as distinct cached instances", () => {
    const a = getFontInstance("sf-pro", 400, 26, 0, undefined, 50, true) as InstanceView;
    const b = getFontInstance("sf-pro", 400, 26, 0, undefined, 75, true) as InstanceView;
    expect(a!._appliedVariationAxes?.wdth).toBe(50);
    expect(b!._appliedVariationAxes?.wdth).toBe(75);
    expect(advanceOfH(a)).toBeLessThan(advanceOfH(b));
  });
});

describe("variable webfont wdth axis", () => {
  const fixture = "tests/fixtures/variable-axis/variable-axis.html";
  const buf = (() => {
    if (!existsSync(fixture)) return null;
    const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(readFileSync(fixture, "utf8"));
    return m != null ? Buffer.from(m[1], "base64") : null;
  })();

  beforeEach(() => clearWebfonts());

  it("pins wdth from font-stretch, clamped to the font's own axis range", () => {
    if (buf == null) return; // fixture not present on this checkout
    // The fixture's Open Sans variable declares wdth [75, 100].
    registerWebfont("WdthTest", 400, "normal", buf);
    const normal = resolveFont("WdthTest", 400, 24, 0) as InstanceView;
    const at75 = resolveFont("WdthTest", 400, 24, 0, undefined, 75) as InstanceView;
    // 50% clamps to the axis minimum (75), so the two are the same instance —
    // Blink's set-from-auto capabilities clamp (`font_custom_platform_data.cc:160-169`).
    const at50 = resolveFont("WdthTest", 400, 24, 0, undefined, 50) as InstanceView;
    expect(advanceOfH(at75)).toBeLessThan(advanceOfH(normal));
    expect(at75!._appliedVariationAxes?.wdth).toBe(75);
    expect(at50!._appliedVariationAxes?.wdth).toBe(75);
    expect(advanceOfH(at50)).toBe(advanceOfH(at75));
  });
});
