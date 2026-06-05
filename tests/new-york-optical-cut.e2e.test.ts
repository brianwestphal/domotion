import { describe, expect, it } from "vitest";
import { resolveFontKey } from "../src/render/text-to-path.js";
import { resolveInstalledFont } from "../src/render/glyph-helper.js";

// DM-1108: macOS New York optical-size cuts. Unlike SF Pro (one variable file
// whose "SF Pro Text" cut is a CoreText-only named face → DM-1103 pins its
// opsz), New York's cuts ship as SEPARATE static OTFs:
//   New York Small  → NewYorkSmall-Regular.otf
//   New York Medium → NewYorkMedium-Regular.otf
//   New York Large  → NewYorkLarge-Regular.otf
//   New York Extra Large → NewYorkExtraLarge-Regular.otf
// Chrome paints each CSS-named cut from its dedicated OTF. The Small/Large/
// Extra Large names are unambiguous so CoreText's family query already returns
// the right cut, but "New York Medium" collides with the VARIABLE New York
// font's `Medium` *weight* named-instance (PostScript NewYork-Medium) — CoreText
// returns that heavier weight, so an explicit `font-family:"New York Medium"`
// run rendered too bold vs Chrome's lighter optical cut. `matchFamilyNameToKey`
// now resolves "New York Medium" via the cut's unambiguous PostScript name.
//
// macOS + cut-package-gated: the cut OTFs live in /Library/Fonts/ and are part
// of Apple's optional "New York" font download, not stock macOS. The glyph
// helper must also be built (resolveInstalledFont returns null otherwise). When
// the cut isn't resolvable we skip — there's nothing to assert.

const mediumCut = process.platform === "darwin" ? resolveInstalledFont("NewYorkMedium-Regular") : null;
const describeMac = mediumCut != null ? describe : describe.skip;

describeMac("DM-1108: New York optical-size cut routing", () => {
  it('resolves "New York Medium" to the optical cut OTF, not the variable Medium weight', () => {
    // The bug: CoreText's plain family query returns the variable font's
    // Medium WEIGHT (sysfb:NewYork-Medium) which renders too bold.
    expect(resolveFontKey("New York Medium")).toBe("sysfb:NewYorkMedium-Regular");
    expect(resolveFontKey("New York Medium")).not.toBe("sysfb:NewYork-Medium");
  });

  it("resolves the unambiguous Small / Large / Extra Large cuts to their dedicated OTFs", () => {
    // These names don't collide with a weight, so the generic CoreText family
    // query already returns the right cut — assert the routing stays correct.
    expect(resolveFontKey("New York Small")).toBe("sysfb:NewYorkSmall-Regular");
    expect(resolveFontKey("New York Large")).toBe("sysfb:NewYorkLarge-Regular");
    expect(resolveFontKey("New York Extra Large")).toBe("sysfb:NewYorkExtraLarge-Regular");
  });

  it('leaves bare "New York" on the always-present variable font', () => {
    // Bare "New York" is the system serif variable font (/System/Library/Fonts/
    // NewYork.ttf); Chrome paints it from there too. Must NOT be remapped to a cut.
    expect(resolveFontKey("New York")).toBe("sysfb:NewYork-Regular");
  });
});
