/**
 * A variable face instantiated at a requested `wght` must report the
 * INSTANTIATED position, not the DEFAULT instance's.
 *
 * Chrome has no equivalent gap: `typeface->fontStyle().weight()` and
 * `kCTFontTraitBold` (`mac/font_cache_mac.mm:424-427`, rev 7d859f27) both
 * describe the typeface actually painted. Before this fix, `getFontInstance`
 * read `naturalWeight` from the ORIGINAL fontkit `Font` (its OS/2 table) and
 * `faceIsBoldTrait` from either that same OS/2 bit or a CoreText query keyed
 * by the face's un-instanced PostScript name — both facts about the DEFAULT
 * instance regardless of which `wght` was requested. Measured: `sf-pro`
 * requested at 400, 700 and 900 all reported `naturalWeight: 400,
 * faceIsBoldTrait: false`, the default instance's values every time.
 *
 * This is a DISCRIMINATING regression test — it fails against the pre-fix
 * `getFontInstance` (which reported 400/false uniformly) and passes once the
 * instantiated `wght` coordinate is threaded through, which is exactly what
 * let the dedicated `hasWeightAxis` short-circuit in
 * `faceNeedsSyntheticBold` be deleted (see `synthesis-decision.ts` /
 * `synthesis-decision.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { getFontInstance, resolveFontKey } from "./font-resolution.js";
import { faceNeedsSyntheticBold } from "./synthesis-decision.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

const onDarwin = process.platform === "darwin";
const describeDarwin = onDarwin ? describe : describe.skip;

describeDarwin("sf-pro (macOS system-ui) reports the INSTANTIATED wght, not the default", () => {
  it.each([
    [400, false],
    [700, true],
    [900, true],
  ])("weight %i -> naturalWeight equals the request, faceIsBoldTrait is %s", (weight, expectBold) => {
    const inst = getFontInstance("sf-pro", weight, 16, 0);
    expect(inst).not.toBeNull();
    expect(inst?.naturalWeight).toBe(weight);
    expect(inst?.faceIsBoldTrait).toBe(expectBold);
  });

  it("end-to-end: the corrected reporting alone (no hasWeightAxis short-circuit) is enough for faceNeedsSyntheticBold to say no at every weight", () => {
    for (const weight of [400, 700, 900]) {
      const inst = getFontInstance("sf-pro", weight, 16, 0)!;
      expect(faceNeedsSyntheticBold(inst, weight, undefined)).toBe(false);
    }
  });
});

const SKIA = "/System/Library/Fonts/Supplemental/Skia.ttf";
const describeSkia = onDarwin && existsSync(SKIA) && isGlyphHelperAvailable() ? describe : describe.skip;

describeSkia("a declared family's own named-instance axis coordinates are NOT CSS weight numbers", () => {
  it("Skia's wght axis (QuickDraw units, ~0.48..3.2) never overwrites naturalWeight with a bogus value", () => {
    // Skia routes through the darwin DECLARED-family path (its own face
    // coordinates replace any CSS-derived wght pin), so `hasWeightAxis` is
    // false here and the DM-2023 correction must not fire — the applied
    // coordinate (e.g. ~1.95 for the Bold instance) is not a CSS weight, and
    // writing it into `naturalWeight` would corrupt the field for every
    // reader that expects a 1..1000 CSS-comparable value.
    const at700 = getFontInstance(resolveFontKey("Skia"), 700, 100, 0);
    expect(at700?.hasWeightAxis).not.toBe(true);
    if (at700?.naturalWeight != null) expect(at700.naturalWeight).toBeGreaterThan(3);
  });
});
