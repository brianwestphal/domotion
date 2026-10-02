/**
 * DM-SXZDJ7: a `system-ui` primary with explicit `font-variation-settings` is
 * the UI font handle CLONED at the author's axis location — Blink applies the
 * settings after MatchSystemUIFont (`font_platform_data_mac.mm:60-102` +
 * `:167-195`, Chromium rev 7d859f27) — and Chrome reports CoreText's clone
 * name. The instance kept the base `.SFNS-Regular` identity, so every cell on
 * such a stack, painted or `.notdef`, disagreed with Chrome by name alone.
 */
import { describe, expect, it } from "vitest";
import { getFontInstance } from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper-transport.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("system-ui variation clone identity (DM-SXZDJ7)", () => {
  // Both names were reported by Chrome over CDP for these exact stacks.
  it.each([
    [{ opsz: 32, wdth: 120, wght: 700 }, ".SFNS-Regular_wdth780000_opsz200000_GRAD_wght2BC0000"],
    [{ opsz: 14, wdth: 80, wght: 300 }, ".SFNS-Regular_wdth500000_opsz110000_GRAD_wght12C0000"],
  ])("stamps the CoreText clone name for %o at 26 px", (variationSettings, chromeName) => {
    const instance = getFontInstance("sf-pro", 400, 26, 0, variationSettings, 100, true);
    expect(instance?.instantiatedPostscriptName).toBe(chromeName);
  });

  it("keeps the named-family route (no system-ui signal) unclassified", () => {
    // An explicitly-named SF Pro family is not the UI font handle, so this
    // stamp must not reach it.
    const instance = getFontInstance("sf-pro", 400, 26, 0, { opsz: 32, wdth: 120, wght: 700 }, 100, false);
    expect(instance?.instantiatedPostscriptName ?? null).not.toBe(
      ".SFNS-Regular_wdth780000_opsz200000_GRAD_wght2BC0000",
    );
  });

  it("keeps the UI query's own name when there is no author variation", () => {
    expect(getFontInstance("sf-pro", 700, 16, 0, undefined, 100, true)?.instantiatedPostscriptName).toBe(".SFNS-Bold");
  });
});
