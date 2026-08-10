import { describe, expect, it } from "vitest";
import {
  resolvedFaceNeedsHarfbuzzShaping,
  resolvedFaceUsesDefaultOpenTypeShaper,
} from "./font-resolution.js";

// DM-2060's noble fixture measured the resolved GSUB ScriptList, not merely
// the codepoint: the three generic-family stacks resolve Telugu to Unifont and
// select DFLT; FreeSans / FreeSerif expose tel2. HarfBuzz rev 4de187d maps those
// selected tags to DEFAULT and INDIC respectively.
describe("Linux Unifont Telugu GSUB dispatch", () => {
  it("selects DEFAULT for the resolved Unifont face", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x0C15, "u-unifont", "linux")).toBe(true);
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0C15, "u-unifont", "linux")).toBe(true);
  });

  it("keeps the tel2 control face on the nominal INDIC shaper", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x0C15, "u-free-sans", "linux")).toBe(false);
    // Telugu remains routed through real HarfBuzz for its existing cluster-map
    // fix; HarfBuzz reads FreeSans's tel2 and performs the INDIC dispatch.
    expect(resolvedFaceNeedsHarfbuzzShaping(0x0C15, "u-free-sans", "linux")).toBe(true);
  });

  it("confines the new DEFAULT classification to Linux Telugu Unifont", () => {
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x0C15, "u-unifont", "darwin")).toBe(false);
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x0C15, "u-free-serif", "linux")).toBe(false);
    expect(resolvedFaceUsesDefaultOpenTypeShaper(0x0B95, "u-unifont", "linux")).toBe(false);
  });
});
