// The `@font-face` `font-weight` DESCRIPTOR as selection capabilities —
// the same Blink rule the `font-stretch` descriptor follows, one axis over.
//
// Blink's rule (`FontFace::GetFontSelectionCapabilities`,
// `core/css/font_face.cc:860-930`, rev 7d859f27): a declared descriptor
// becomes the face's weight capabilities — `normal`/`bold` map to 400/700 as
// single-value ranges, a single number is `[v, v]`, two numbers are a range
// with decreasing endpoints swapped — and an auto/absent descriptor SELECTS
// as normal weight while INSTANCING against the font's own wght axis range.
// Selection scores `FontSelectionAlgorithm::WeightDistance`
// (`font_selection_algorithm.cc:98-135`) against the range, with its 400/500
// search-band rules, after stretch and style (`IsBetterMatchForRequest`
// order). Instancing clamps the request into the DESCRIPTOR range first
// (`FontCustomPlatformData::GetFontPlatformData`,
// `font_custom_platform_data.cc:136-154`) — so a face declared
// `font-weight: 700` pins wght = 700 for EVERY request. Measured over CDP:
// Lexend VF (wght [100..900]) declared 700 and requested at 400 paints
// `Lexend-Bold` (width 886.281 at 100px 'Hamburgefonstiv'), where the
// axis-range clamp the code previously ran would paint `Lexend-Regular`
// (847.000).
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  parseFontWeightDescriptor, registerWebfont, clearWebfonts, resolveFont,
  __pickWebfontVariantMetaForTest, __pickWebfontVariantMetaForCodepointForTest,
} from "./font-resolution.js";

describe("parseFontWeightDescriptor", () => {
  it("maps the keywords per font_face.cc's weight section", () => {
    expect(parseFontWeightDescriptor("normal")).toEqual([400, 400]);
    expect(parseFontWeightDescriptor("bold")).toEqual([700, 700]);
  });

  it("parses single values and ranges, swapping decreasing ranges", () => {
    expect(parseFontWeightDescriptor("700")).toEqual([700, 700]);
    expect(parseFontWeightDescriptor("450.5")).toEqual([450.5, 450.5]);
    expect(parseFontWeightDescriptor("100 900")).toEqual([100, 900]);
    // css-fonts-4: "User agents must swap the computed value of the startpoint
    // and endpoint of the range in order to forbid decreasing ranges."
    expect(parseFontWeightDescriptor("900 100")).toEqual([100, 900]);
    expect(parseFontWeightDescriptor(" 300  500 ")).toEqual([300, 500]);
  });

  it("treats auto / absent / out-of-range / unparseable as auto capabilities", () => {
    expect(parseFontWeightDescriptor(undefined)).toBeUndefined();
    expect(parseFontWeightDescriptor("")).toBeUndefined();
    expect(parseFontWeightDescriptor("auto")).toBeUndefined();
    expect(parseFontWeightDescriptor("bolder")).toBeUndefined(); // not valid in the descriptor
    expect(parseFontWeightDescriptor("0.5")).toBeUndefined();    // below Blink's [1, 1000] check
    expect(parseFontWeightDescriptor("1001")).toBeUndefined();
    expect(parseFontWeightDescriptor("100 2000")).toBeUndefined();
  });
});

// A real parseable font buffer for registerWebfont — the same approach
// webfont-stretch-descriptor.test.ts uses. Which font it is doesn't matter
// for SELECTION tests; only the declared descriptors do.
const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";
const helveticaBuf = existsSync(HELVETICA) ? readFileSync(HELVETICA) : null;
const describeWithFont = helveticaBuf != null ? describe : describe.skip;

describeWithFont("weight as a selection axis (Blink's WeightDistance over the descriptor range)", () => {
  beforeEach(() => clearWebfonts());

  it("selects the face whose declared weight range covers the request", () => {
    registerWebfont("part", 300, "normal", helveticaBuf!, undefined, undefined, "100 400");
    registerWebfont("part", 700, "normal", helveticaBuf!, undefined, undefined, "500 900");
    expect(__pickWebfontVariantMetaForTest("part", 300, false)?.weightCaps).toEqual([100, 400]);
    expect(__pickWebfontVariantMetaForTest("part", 700, false)?.weightCaps).toEqual([500, 900]);
  });

  it("a request in the [400, 500] band prefers the nearest face at/under 500 above it", () => {
    // WeightDistance's search band: at request 430, a [500, 500] face (dist
    // 70, minimum ≤ 500) beats a [300, 300] face (dist 500 - 300 = 200).
    registerWebfont("band", 300, "normal", helveticaBuf!, undefined, undefined, "300");
    registerWebfont("band", 500, "normal", helveticaBuf!, undefined, undefined, "500");
    expect(__pickWebfontVariantMetaForTest("band", 430, false)?.weightCaps).toEqual([500, 500]);
    // Outside the band the direction flips: at request 300 the lighter face
    // wins outright (distance 0), and at 700 the bolder one does.
    expect(__pickWebfontVariantMetaForTest("band", 300, false)?.weightCaps).toEqual([300, 300]);
    expect(__pickWebfontVariantMetaForTest("band", 700, false)?.weightCaps).toEqual([500, 500]);
  });

  it("a bold request prefers bolder faces: too-light faces score from the family bounds", () => {
    // Request 700: the [800, 800] face scores 100; the [400, 400] face scores
    // max(request, bounds.max) - 400 = 800 - 400 = 400. The bolder face wins
    // even though |Δweight| is symmetric (300 both ways).
    registerWebfont("boldpref", 400, "normal", helveticaBuf!, undefined, undefined, "400");
    registerWebfont("boldpref", 800, "normal", helveticaBuf!, undefined, undefined, "800");
    expect(__pickWebfontVariantMetaForTest("boldpref", 700, false)?.weightCaps).toEqual([800, 800]);
    // ...and a light request mirrors it: at 200, [100, 100] beats [300, 300]
    // (|Δ| ties at 100 each side, but the lighter face's gap counts directly
    // while the heavier one scores lo - min(request, bounds.min)).
    clearWebfonts();
    registerWebfont("lightpref", 100, "normal", helveticaBuf!, undefined, undefined, "100");
    registerWebfont("lightpref", 300, "normal", helveticaBuf!, undefined, undefined, "300");
    expect(__pickWebfontVariantMetaForTest("lightpref", 200, false)?.weightCaps).toEqual([100, 100]);
  });

  it("an italic mismatch still outranks any weight distance", () => {
    registerWebfont("style", 700, "italic", helveticaBuf!, undefined, undefined, "700");
    registerWebfont("style", 100, "normal", helveticaBuf!, undefined, undefined, "100");
    const picked = __pickWebfontVariantMetaForTest("style", 700, false);
    expect(picked?.italic).toBe(false);
    expect(picked?.weightCaps).toEqual([100, 100]);
  });

  it("auto-descriptor faces select as normal weight [400, 400]", () => {
    registerWebfont("auto", 400, "normal", helveticaBuf!);
    registerWebfont("auto", 700, "normal", helveticaBuf!, undefined, undefined, "700");
    expect(__pickWebfontVariantMetaForTest("auto", 700, false)?.weightCaps).toEqual([700, 700]);
    expect(__pickWebfontVariantMetaForTest("auto", 400, false)?.weightCaps).toBeUndefined();
  });

  it("the per-codepoint pick scores the weight range too, after its unicode-range filter", () => {
    registerWebfont("cp", 400, "normal", helveticaBuf!, [[0x0000, 0x00ff]], undefined, "300 400");
    registerWebfont("cp", 700, "normal", helveticaBuf!, [[0x0000, 0x00ff]], undefined, "600 700");
    expect(__pickWebfontVariantMetaForCodepointForTest("cp", 400, false, 0x41)?.weightCaps).toEqual([300, 400]);
    expect(__pickWebfontVariantMetaForCodepointForTest("cp", 700, false, 0x41)?.weightCaps).toEqual([600, 700]);
  });
});

describe("descriptor capabilities clamp the wght instancing", () => {
  // The fixture's variable font (OpenSans-Regular) declares wght [300, 800].
  const fixture = "tests/fixtures/variable-axis/variable-axis.html";
  const buf = (() => {
    if (!existsSync(fixture)) return null;
    const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(readFileSync(fixture, "utf8"));
    return m != null ? Buffer.from(m[1], "base64") : null;
  })();
  type InstanceView = { _appliedVariationAxes?: Record<string, number> } | null;

  beforeEach(() => clearWebfonts());

  it("a face declared font-weight: 700 pins wght 700 for EVERY request — the Lexend discriminator", () => {
    if (buf == null) return; // fixture not present on this checkout
    registerWebfont("Pinned", 700, "normal", buf, undefined, undefined, "700");
    for (const weight of [400, 700, 900]) {
      const inst = resolveFont("Pinned", weight, 24, 0) as InstanceView;
      expect(inst?._appliedVariationAxes?.wght).toBe(700);
    }
  });

  it("a declared keyword pins too — normal is a declared 400, not auto", () => {
    if (buf == null) return;
    registerWebfont("Kw", 400, "normal", buf, undefined, undefined, "normal");
    // Auto would clamp 700 to the axis range ([300, 800] → 700); the declared
    // normal keyword pins 400 (RangeSetFromAuto vs SetExplicitly).
    const inst = resolveFont("Kw", 700, 24, 0) as InstanceView;
    expect(inst?._appliedVariationAxes?.wght).toBe(400);
  });

  it("a declared range clamps the request into it", () => {
    if (buf == null) return;
    registerWebfont("Ranged", 500, "normal", buf, undefined, undefined, "500 600");
    const at400 = resolveFont("Ranged", 400, 24, 0) as InstanceView;
    const at700 = resolveFont("Ranged", 700, 24, 0) as InstanceView;
    const at550 = resolveFont("Ranged", 550, 24, 0) as InstanceView;
    expect(at400?._appliedVariationAxes?.wght).toBe(500);
    expect(at700?._appliedVariationAxes?.wght).toBe(600);
    expect(at550?._appliedVariationAxes?.wght).toBe(550);
  });

  it("an auto descriptor still clamps to the font's own axis range", () => {
    if (buf == null) return;
    registerWebfont("Auto", 400, "normal", buf);
    const at100 = resolveFont("Auto", 100, 24, 0) as InstanceView;
    const at900 = resolveFont("Auto", 900, 24, 0) as InstanceView;
    expect(at100?._appliedVariationAxes?.wght).toBe(300); // axis minimum
    expect(at900?._appliedVariationAxes?.wght).toBe(800); // axis maximum
  });
});
