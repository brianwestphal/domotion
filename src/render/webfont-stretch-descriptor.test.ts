// The `@font-face` `font-stretch` DESCRIPTOR as selection capabilities.
//
// Blink's rule (`FontFace::GetFontSelectionCapabilities`,
// `core/css/font_face.cc:666-…`, identical at tag 147.0.7727.15 and rev
// 7d859f27): a declared descriptor becomes the face's width capabilities —
// a keyword or single percentage is a single-value range, two percentages are
// a range with decreasing endpoints swapped — and an auto/absent descriptor
// SELECTS as normal width while INSTANCING against the font's own wdth axis
// range. Selection checks stretch before style before weight
// (`FontSelectionAlgorithm::IsBetterMatchForRequest`), and instancing clamps
// the request into the DESCRIPTOR range first
// (`FontCustomPlatformData::GetFontPlatformData`,
// `font_custom_platform_data.cc:155-169`) — so a face declared
// `font-stretch: 75%` pins wdth = 75 for EVERY request, normal included.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  parseFontStretchDescriptor, registerWebfont, clearWebfonts, resolveFont,
  __pickWebfontVariantMetaForTest, __pickWebfontVariantMetaForCodepointForTest,
} from "./font-resolution.js";

describe("parseFontStretchDescriptor", () => {
  it("maps keywords to Blink's width constants (font_selection_types.h:221-246)", () => {
    expect(parseFontStretchDescriptor("ultra-condensed")).toEqual([50, 50]);
    expect(parseFontStretchDescriptor("extra-condensed")).toEqual([62.5, 62.5]);
    expect(parseFontStretchDescriptor("condensed")).toEqual([75, 75]);
    expect(parseFontStretchDescriptor("semi-condensed")).toEqual([87.5, 87.5]);
    expect(parseFontStretchDescriptor("normal")).toEqual([100, 100]);
    expect(parseFontStretchDescriptor("semi-expanded")).toEqual([112.5, 112.5]);
    expect(parseFontStretchDescriptor("expanded")).toEqual([125, 125]);
    expect(parseFontStretchDescriptor("extra-expanded")).toEqual([150, 150]);
    expect(parseFontStretchDescriptor("ultra-expanded")).toEqual([200, 200]);
  });

  it("parses single and double percentages, swapping decreasing ranges", () => {
    expect(parseFontStretchDescriptor("75%")).toEqual([75, 75]);
    expect(parseFontStretchDescriptor("50% 100%")).toEqual([50, 100]);
    // css-fonts-4: "User agents must swap the computed value of the startpoint
    // and endpoint of the range in order to forbid decreasing ranges."
    expect(parseFontStretchDescriptor("100% 50%")).toEqual([50, 100]);
    expect(parseFontStretchDescriptor(" 62.5% ")).toEqual([62.5, 62.5]);
  });

  it("treats auto / absent / unparseable as auto capabilities", () => {
    expect(parseFontStretchDescriptor(undefined)).toBeUndefined();
    expect(parseFontStretchDescriptor("")).toBeUndefined();
    expect(parseFontStretchDescriptor("auto")).toBeUndefined();
    expect(parseFontStretchDescriptor("wat")).toBeUndefined();
    expect(parseFontStretchDescriptor("75")).toBeUndefined(); // unitless is invalid CSS here
  });
});

// A real parseable font buffer for registerWebfont — the same approach
// webfont-unicode-range.test.ts uses. Which font it is doesn't matter for
// SELECTION tests; only the declared descriptors do.
const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";
const helveticaBuf = existsSync(HELVETICA) ? readFileSync(HELVETICA) : null;
const describeWithFont = helveticaBuf != null ? describe : describe.skip;

describeWithFont("stretch as a selection axis (Blink's stretch → style → weight order)", () => {
  beforeEach(() => clearWebfonts());

  it("selects the partition whose declared stretch range covers the request", () => {
    registerWebfont("part", 400, "normal", helveticaBuf!, undefined, "50% 87.5%");
    registerWebfont("part", 400, "normal", helveticaBuf!, undefined, "112.5% 200%");
    expect(__pickWebfontVariantMetaForTest("part", 400, false, 75)?.stretch).toEqual([50, 87.5]);
    expect(__pickWebfontVariantMetaForTest("part", 400, false, 150)?.stretch).toEqual([112.5, 200]);
  });

  it("stretch distance outranks an italic mismatch, per IsBetterMatchForRequest", () => {
    // The italic face declares the condensed width the run asks for; the
    // upright face declares expanded. Blink checks stretch FIRST, so the
    // italic-but-condensed face wins an upright condensed request.
    registerWebfont("order", 400, "italic", helveticaBuf!, undefined, "75%");
    registerWebfont("order", 400, "normal", helveticaBuf!, undefined, "125%");
    const picked = __pickWebfontVariantMetaForTest("order", 400, false, 75);
    expect(picked?.italic).toBe(true);
    expect(picked?.stretch).toEqual([75, 75]);
  });

  it("auto-descriptor faces select as normal width [100, 100]", () => {
    // An auto face IS normal width for selection (RangeSetFromAuto), so at a
    // condensed request the declared-condensed face beats it, and at a normal
    // request the auto face beats the declared-condensed one.
    registerWebfont("auto", 400, "normal", helveticaBuf!);
    registerWebfont("auto", 400, "normal", helveticaBuf!, undefined, "75%");
    expect(__pickWebfontVariantMetaForTest("auto", 400, false, 75)?.stretch).toEqual([75, 75]);
    expect(__pickWebfontVariantMetaForTest("auto", 400, false, 100)?.stretch).toBeUndefined();
  });

  it("the per-codepoint pick scores stretch too, after its unicode-range filter", () => {
    registerWebfont("cp", 400, "normal", helveticaBuf!, [[0x0000, 0x00ff]], "75%");
    registerWebfont("cp", 400, "normal", helveticaBuf!, [[0x0000, 0x00ff]], "125%");
    expect(__pickWebfontVariantMetaForCodepointForTest("cp", 400, false, 0x41, 75)?.stretch).toEqual([75, 75]);
    expect(__pickWebfontVariantMetaForCodepointForTest("cp", 400, false, 0x41, 125)?.stretch).toEqual([125, 125]);
  });
});

describe("descriptor capabilities clamp the wdth instancing", () => {
  const fixture = "tests/fixtures/variable-axis/variable-axis.html";
  const buf = (() => {
    if (!existsSync(fixture)) return null;
    const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(readFileSync(fixture, "utf8"));
    return m != null ? Buffer.from(m[1], "base64") : null;
  })();
  type InstanceView = { _appliedVariationAxes?: Record<string, number> } | null;

  beforeEach(() => clearWebfonts());

  it("a face declared font-stretch: 75% pins wdth 75 for EVERY request, normal included", () => {
    if (buf == null) return; // fixture not present on this checkout
    // The fixture's variable font declares wdth [75, 100]. Declared-descriptor
    // capabilities clamp the request BEFORE the axis range does
    // (`font_custom_platform_data.cc:155-169`), so normal (100), condensed
    // (75), and ultra-expanded (200) all land on wdth = 75.
    registerWebfont("Pinned", 400, "normal", buf, undefined, "75%");
    for (const stretch of [100, 75, 200]) {
      const inst = resolveFont("Pinned", 400, 24, 0, undefined, stretch) as InstanceView;
      expect(inst?._appliedVariationAxes?.wdth).toBe(75);
    }
  });

  it("a declared range clamps the request into it", () => {
    if (buf == null) return;
    registerWebfont("Ranged", 400, "normal", buf, undefined, "87.5% 100%");
    const at75 = resolveFont("Ranged", 400, 24, 0, undefined, 75) as InstanceView;
    const at100 = resolveFont("Ranged", 400, 24, 0, undefined, 100) as InstanceView;
    expect(at75?._appliedVariationAxes?.wdth).toBe(87.5); // 75 clamps up to the range minimum
    expect(at100?._appliedVariationAxes?.wdth).toBe(100);
  });
});
