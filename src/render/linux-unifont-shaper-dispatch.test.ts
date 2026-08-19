import { describe, expect, it } from "vitest";
import { resolvedFaceNeedsHarfbuzzShaping } from "./font-resolution.js";

// DM-2060 measured these exact noble-profile face+script pairs by reading the
// resolved font's GSUB ScriptList. HarfBuzz rev 4de187d requests the script tag,
// falls back to DFLT, then `hb_ot_shaper_categorize` selects DEFAULT rather than
// USE. The test pins the resolved-face seam, not a second shaper implementation.
describe("Linux Unifont GSUB-aware HarfBuzz dispatch", () => {
  const measured = [
    [0x0F40, "u-unifont"],       // Tibetan
    [0x07CA, "u-unifont"],       // NKo
    [0x0840, "u-unifont"],       // Mandaic
    [0xA840, "u-unifont"],       // Phags-pa
    [0x1B05, "u-unifont"],       // Balinese
    [0xA984, "u-unifont"],       // Javanese
    [0x11083, "u-unifont-upper"], // Kaithi
    [0x11005, "u-unifont-upper"], // Brahmi
    [0x1E900, "u-unifont-upper"], // Adlam
    [0x10A10, "u-unifont-upper"], // Kharoshthi
  ] as const;

  it("routes all ten measured Unifont faces through real HarfBuzz on Linux", () => {
    for (const [cp, key] of measured) expect(resolvedFaceNeedsHarfbuzzShaping(cp, key, "linux")).toBe(true);
  });

  it("still shapes FreeSerif Sinhala, while its GSUB selects sinh → USE", () => {
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0D9A, "u-free-serif", "linux")).toBe(true);
  });

  it("does not confuse universal shaping with the narrower DFLT classification", () => {
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0F40, "u-free-serif", "linux")).toBe(true);
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0F40, "u-unifont", "darwin")).toBe(true);
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0041, "u-unifont", "linux")).toBe(true);
  });
});
