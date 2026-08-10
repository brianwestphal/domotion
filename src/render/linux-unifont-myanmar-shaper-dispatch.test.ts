import { describe, expect, it } from "vitest";
import {
  resolvedFaceNeedsHarfbuzzShaping,
  resolvedFaceUsesDefaultOpenTypeShaper,
} from "./font-resolution.js";

// HarfBuzz rev 4de187d `hb_ot_shaper_categorize` (hb-ot-shaper.hh:247-264):
// Myanmar DFLT/latn/legacy-mymr select DEFAULT; only modern mym2 selects the
// Myanmar shaper. DM-2060 measured noble Unifont as DFLT and Noto as mym2.
describe("Linux Unifont Myanmar GSUB-aware dispatch", () => {
  it("routes measured Unifont U+1000 through HarfBuzz's DFLT → DEFAULT plan", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x1000, "u-unifont", "linux")).toBe(true);
    expect(resolvedFaceNeedsHarfbuzzShaping(0x1000, "u-unifont", "linux")).toBe(true);
  });

  it("keeps a Noto Myanmar mym2 face on the script-specific Myanmar plan", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x1000, "u-noto-sans-myanmar", "linux")).toBe(false);
    // Myanmar is already a script-wide HarfBuzz route; false above means real
    // HarfBuzz sees mym2 and chooses Myanmar, not that shaping returns to fontkit.
    expect(resolvedFaceNeedsHarfbuzzShaping(0x1000, "u-noto-sans-myanmar", "linux")).toBe(true);
  });

  it("does not apply the measured noble face decision cross-platform or cross-script", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x1000, "u-unifont", "darwin")).toBe(false);
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x1780, "u-unifont", "linux")).toBe(false);
  });
});
