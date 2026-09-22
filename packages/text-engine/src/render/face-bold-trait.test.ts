import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fontkit from "fontkit";
import { resolveFaceTraitBold, isGlyphHelperAvailable } from "./glyph-helper.js";
import { getFontInstance, resolveFontKey } from "./font-resolution.js";

/**
 * The macOS synthetic-bold rule tests CoreText's `kCTFontTraitBold`
 * (`mac/font_cache_mac.mm:424-427`, rev 7d859f27):
 *
 *     desired_bold = Weight() > 500 && !(traits & kCTFontTraitBold)
 *
 * It was implemented against OS/2 `fsSelection` bit 5 on the stated grounds that
 * the two are "the same fact recorded in two places". They are not, and the
 * difference is not academic: on this host 98 of 669 comparable system faces
 * carry the CoreText trait while the bit says otherwise, so every one of them
 * was painted with synthetic bold on top of an already-bold cut.
 *
 * These tests pin the disagreement itself rather than a rendered result, because
 * the disagreement is the thing that was assumed away.
 */
const TIMES_TTC = "/System/Library/Fonts/Times.ttc";
const MACOS = process.platform === "darwin" && fs.existsSync(TIMES_TTC);
const HELPER = MACOS && isGlyphHelperAvailable();

describe.skipIf(!HELPER)("face BOLD trait: CoreText, not OS/2 fsSelection", () => {
  it("Times.ttc's fsSelection bits are self-contradictory, which is why the bit cannot be trusted", () => {
    const ttc = fontkit.openSync(TIMES_TTC) as unknown as {
      fonts: { postscriptName: string; "OS/2"?: { fsSelection?: unknown; usWeightClass?: number } }[];
    };
    const bits = (ps: string) => {
      const f = ttc.fonts.find((x) => x.postscriptName === ps)!;
      const sel = f["OS/2"]?.fsSelection as Record<string, boolean> | number | undefined;
      return typeof sel === "number"
        ? { bold: (sel & 0x20) !== 0, regular: (sel & 0x40) !== 0, italic: (sel & 0x01) !== 0 }
        : { bold: sel?.bold === true, regular: sel?.regular === true, italic: sel?.italic === true };
    };

    // OpenType makes REGULAR mutually exclusive with BOLD and ITALIC. Every face
    // in this container violates that, which is the tell that the bits are junk
    // here — Bold claims regular-and-not-bold, Italic claims regular-and-italic.
    const bold = bits("Times-Bold");
    expect(bold.regular).toBe(true);
    expect(bold.bold).toBe(false);

    const italic = bits("Times-Italic");
    expect(italic.regular).toBe(true);
    expect(italic.italic).toBe(true);
  });

  it("CoreText reports the trait correctly for the same faces", () => {
    expect(resolveFaceTraitBold("Times-Bold", TIMES_TTC)).toBe(true);
    expect(resolveFaceTraitBold("Times-Roman", TIMES_TTC)).toBe(false);
  });

  // The regression this guards: `serif` at weight 700 resolves Times-Bold, and
  // reading the bit made `weight > 500 && !faceIsBold` fire on it. Every heading
  // in `20-font-style-variant` painted heavier than Chrome (0.0399 -> 0.120,
  // 0 -> 9 diff regions). The instance-level assertion is the one that would
  // have caught it, since that is what the renderer reads.
  it("a serif run at weight 700 gets a face the renderer will NOT embolden", () => {
    const key = resolveFontKey("serif");
    const inst = getFontInstance(key, 700, 32, 0);
    expect(inst).not.toBeNull();
    expect(inst!.postscriptName).toBe("Times-Bold");
    expect(inst!.faceIsBoldTrait).toBe(true);
    // Blink's predicate, evaluated here so the test states the consequence
    // rather than only the input.
    expect(700 > 500 && inst!.faceIsBoldTrait !== true).toBe(false);
  });

  it("...and the regular cut at 400 is still reported as not-bold", () => {
    const inst = getFontInstance(resolveFontKey("serif"), 400, 32, 0);
    expect(inst!.postscriptName).toBe("Times-Roman");
    expect(inst!.faceIsBoldTrait).toBe(false);
  });

  /**
   * CoreText refuses the dot-prefixed system faces and substitutes
   * `TimesNewRomanPSMT` — even when handed the containing file's path. Without
   * the echoed-name check, `.LucidaGrandeUI-Bold` and the `.HiraKakuInterface-W*`
   * family would inherit Times New Roman's `traitBold: false` and start being
   * emboldened: 17 faces made worse by the fix for 98 others. Null here means
   * "no answer", and the caller keeps the fsSelection reading.
   */
  it("returns null rather than a substituted font's answer for a restricted face", () => {
    const lucida = "/System/Library/Fonts/LucidaGrande.ttc";
    if (!fs.existsSync(lucida)) return;
    expect(resolveFaceTraitBold(".LucidaGrandeUI-Bold", lucida)).toBeNull();
    // Asked without a path too — the restriction is on the name, not the route.
    expect(resolveFaceTraitBold(".LucidaGrandeUI-Bold")).toBeNull();
  });

  it("returns null for a face that does not exist at all", () => {
    expect(resolveFaceTraitBold("NoSuchFace-Regular")).toBeNull();
    expect(resolveFaceTraitBold("")).toBeNull();
  });
});
