// The explicitly-named macOS optical cuts pin a fixed design at every size —
// Blink's outcome by construction, not a special case: the size-derived `opsz`
// clone loop is only reached when the matched typeface reports current
// variation coordinates (`FontPlatformDataFromCTFont` returns the typeface
// untouched on `existing_axes <= 0`, `font_platform_data_mac.mm:155-160`, rev
// 7d859f27), and the static per-cut faces CoreText matches for "SF Pro Text" /
// "SF Pro Display" report none (Skia's `onGetVariationDesignPosition` returns
// -1 without CT variation axes, `62efacd3:src/ports/SkTypeface_mac_ct.cpp:741-757`).
//
// Discriminating measurement (2026-08-08 probe, run advance vs fontkit SFNS
// instances): Chrome "SF Pro Text" at 24/30/48px matches SFNS@opsz17 within
// 0.02px while opsz=size is 9-11% off; "SF Pro Display" at 13/30px matches
// SFNS@opsz28 while opsz=size at 13px would paint the Text design ~11% wide.
import { describe, expect, it } from "vitest";
import { opticalCutOpszFor } from "./font-resolution.js";
import { resolveInstalledFont, isGlyphHelperAvailable } from "./glyph-helper.js";

const sfProInstalled = process.platform === "darwin" && isGlyphHelperAvailable()
  && resolveInstalledFont("SF Pro Text") != null
  && resolveInstalledFont("SF Pro Display") != null;
const describeSfPro = sfProInstalled ? describe : describe.skip;

describeSfPro("opticalCutOpszFor (explicitly-named macOS optical cuts)", () => {
  it("pins the Text cut at the axis floor", () => {
    expect(opticalCutOpszFor('"SF Pro Text", sans-serif')).toBe(17);
  });

  it("pins the Display cut at its own design, not the Text floor", () => {
    // Previously null → the pipeline applied opsz = size, which at 13px is
    // clamped to 17 and paints the TEXT design where Chrome paints Display.
    expect(opticalCutOpszFor('"SF Pro Display", sans-serif')).toBe(28);
  });

  it("keeps the generic SF Pro / system-ui path on opsz = size", () => {
    // There Blink DOES reach the clone loop — the system-ui CTFont carries
    // variation coordinates — so the clamp mechanism applies, not a pin.
    expect(opticalCutOpszFor('"SF Pro", sans-serif')).toBe(null);
    expect(opticalCutOpszFor("system-ui, sans-serif")).toBe(null);
  });

  it("lets the FIRST resolvable name decide, like resolveFontKey's walk", () => {
    expect(opticalCutOpszFor('"DoesNotExist", "SF Pro Display"')).toBe(28);
    expect(opticalCutOpszFor('Helvetica, "SF Pro Text"')).toBe(null);
  });
});
