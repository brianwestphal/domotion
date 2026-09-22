import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { resolveFaceTraitItalic, isGlyphHelperAvailable } from "./glyph-helper.js";
import { getFontInstance, resolveFontKey } from "./font-resolution.js";

/**
 * The mirror of `face-bold-trait.test.ts`, for the italic style bit.
 *
 * The macOS synthetic-oblique rule tests CoreText's `kCTFontTraitItalic`
 * (`mac/font_cache_mac.mm:431-436`, rev 7d859f27):
 *
 *     desired_italic = Style();  // ANY nonzero slope
 *     synthetic = desired_italic && !(traits & kCTFontTraitItalic)
 *
 * `traitItalic` was already reported by the native helper's `meta` query
 * before this file's change (`main.swift`, `MetaResponse.traitItalic` in
 * `glyph-helper.ts`) but `createGlyphHelperFont`'s returned object read only
 * `traitBold`, dropping `traitItalic` on the floor — the exact shape of gap
 * this file's `resolveFaceTraitItalic` (and the wiring into
 * `FontInstance.faceIsItalicTrait`) closes.
 *
 * Unlike the bold trait's Times.ttc case, this host's Times.ttc OS/2
 * `fsSelection` ITALIC bit (bit 0) agrees with CoreText for every member —
 * measured directly (`Times-Roman`/`Times-Bold`: bit clear, CoreText false;
 * `Times-Italic`/`Times-BoldItalic`: bit set, CoreText true) — so this suite
 * pins CORRECTNESS and the null-safety contract rather than a disagreement;
 * `faceNeedsSyntheticOblique`'s own tests (`synthesis-decision.test.ts`) pin
 * the "trait wins over the outline heuristic" behavior with a constructed
 * `SynthesisFace`, the same pattern `face-bold-trait.test.ts`'s
 * `boldTrait500` case uses.
 */
const TIMES_TTC = "/System/Library/Fonts/Times.ttc";
const MACOS = process.platform === "darwin" && fs.existsSync(TIMES_TTC);
const HELPER = MACOS && isGlyphHelperAvailable();

describe.skipIf(!HELPER)("face ITALIC trait: CoreText kCTFontTraitItalic", () => {
  it("CoreText reports the trait correctly for Times.ttc's four members", () => {
    expect(resolveFaceTraitItalic("Times-Roman", TIMES_TTC)).toBe(false);
    expect(resolveFaceTraitItalic("Times-Bold", TIMES_TTC)).toBe(false);
    expect(resolveFaceTraitItalic("Times-Italic", TIMES_TTC)).toBe(true);
    expect(resolveFaceTraitItalic("Times-BoldItalic", TIMES_TTC)).toBe(true);
  });

  it("an italic run over `serif` resolves a face the renderer will NOT shear again", () => {
    const key = resolveFontKey("serif");
    const inst = getFontInstance(key, 400, 32, -1); // slant != 0 routes to the italic cut
    expect(inst).not.toBeNull();
    expect(inst!.postscriptName).toBe("Times-Italic");
    expect(inst!.faceIsItalicTrait).toBe(true);
  });

  it("...and the upright cut is still reported as not-italic", () => {
    const inst = getFontInstance(resolveFontKey("serif"), 400, 32, 0);
    expect(inst!.postscriptName).toBe("Times-Roman");
    expect(inst!.faceIsItalicTrait).toBe(false);
  });

  /**
   * CoreText refuses the dot-prefixed system faces and substitutes
   * `TimesNewRomanPSMT` — even when handed the containing file's path. Same
   * restriction `resolveFaceTraitBold` guards against; the mirror needs the
   * identical guard or the same 17-face regression class reopens for italic.
   */
  it("returns null rather than a substituted font's answer for a restricted face", () => {
    const lucida = "/System/Library/Fonts/LucidaGrande.ttc";
    if (!fs.existsSync(lucida)) return;
    expect(resolveFaceTraitItalic(".LucidaGrandeUI-Bold", lucida)).toBeNull();
    // Asked without a path too — the restriction is on the name, not the route.
    expect(resolveFaceTraitItalic(".LucidaGrandeUI-Bold")).toBeNull();
  });

  it("returns null for a face that does not exist at all", () => {
    expect(resolveFaceTraitItalic("NoSuchFace-Regular")).toBeNull();
    expect(resolveFaceTraitItalic("")).toBeNull();
  });
});
