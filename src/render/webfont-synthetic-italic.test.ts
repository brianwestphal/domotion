// Synthetic italic for WEBFONT runs — the mirror of
// webfont-synthetic-bold.test.ts, and DM-2016's item 4: the rule existed for
// bold and was absent entirely for italic before this file.
//
// Blink composes it from the same two files as the bold rule, at the
// style/slope counterparts of the same citations, both read from the local
// checkout at rev 7d859f27:
//
//   core/css/css_segmented_font_face.cc:120-123
//     SetSyntheticItalic(capabilities.slope.maximum < kItalicSlopeValue &&
//                        request.slope >= kItalicSlopeValue && SyntheticItalicAllowed())
//   platform/fonts/font_custom_platform_data.cc:130, 188-193, 291-292
//     synthetic_italic = italic;                      // declared descriptor: untouched
//     …auto-descriptor VARIABLE branch only:
//     has_right_slanted_variations = slnt_range.minimum < kNormalSlopeValue;
//     synthetic_italic = italic && !has_right_slanted_variations && request.slope >= kItalicSlopeValue;
//     …then finally: synthetic_italic && !base_typeface_->isItalic()
//
// The descriptor capabilities — NOT the font's axis range — are what the
// first term reads, and an absent descriptor is [0, 0] (`core/css/font_face.cc:
// 776-794` normal_capabilities, kSetFromAuto). So an auto-descriptor STATIC
// face is a synthesis candidate at every request >= 14 (`italic` or any
// `oblique` at/above the sentinel angle), while an auto-descriptor VARIABLE
// face whose slnt axis reaches a right-leaning (OT-negative) coordinate is
// exempted.
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  webfontSyntheticItalic, parseFontStyleDescriptor, registerWebfont, clearWebfonts, resolveFont,
  type WebfontSynthesisFace,
} from "./font-resolution.js";
import { renderTextAsPath, setRenderTextMode } from "./text-to-path.js";
import { clearEmbeddedFontBuilder } from "./embedded-font-builder.js";

const face = (o: Partial<WebfontSynthesisFace>): WebfontSynthesisFace => ({
  declaredWeightCaps: null, wghtAxisMax: null, baseIsBold: false,
  declaredStyleCaps: null, slntAxisMin: null, baseIsItalic: false, ...o,
});

describe("parseFontStyleDescriptor", () => {
  it("maps the keywords per font_face.cc's style section", () => {
    expect(parseFontStyleDescriptor("normal")).toEqual([0, 0]);
    // `italic` and BARE `oblique` (no angle) are both the italic sentinel.
    expect(parseFontStyleDescriptor("italic")).toEqual([14, 14]);
    expect(parseFontStyleDescriptor("oblique")).toEqual([14, 14]);
  });

  it("parses explicit oblique angles, single and ranged, swapping decreasing ranges", () => {
    expect(parseFontStyleDescriptor("oblique 20deg")).toEqual([20, 20]);
    expect(parseFontStyleDescriptor("oblique 14deg")).toEqual([14, 14]); // same as `italic`, numerically
    expect(parseFontStyleDescriptor("oblique 0deg 20deg")).toEqual([0, 20]);
    // css-fonts-4: "User agents must swap the computed value of the startpoint
    // and endpoint of the range in order to forbid decreasing ranges."
    expect(parseFontStyleDescriptor("oblique 20deg 0deg")).toEqual([0, 20]);
    expect(parseFontStyleDescriptor("oblique -10deg 10deg")).toEqual([-10, 10]);
  });

  it("treats auto / absent / unparseable as auto capabilities", () => {
    expect(parseFontStyleDescriptor(undefined)).toBeUndefined();
    expect(parseFontStyleDescriptor("")).toBeUndefined();
    expect(parseFontStyleDescriptor("auto")).toBeUndefined();
    expect(parseFontStyleDescriptor("bolder")).toBeUndefined();
    expect(parseFontStyleDescriptor("oblique NaNdeg")).toBeUndefined();
  });
});

describe("webfontSyntheticItalic — the rule", () => {
  it("shears a DECLARED-normal static face at an italic request (the headline case)", () => {
    // caps.max 0 < 14, request 14 >= 14, declared → not exempt, buffer not
    // italic. Chrome shears.
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [0, 0] }), 14)).toBe(true);
  });

  it("shears a static webfont buffer with an auto descriptor", () => {
    // An auto descriptor SELECTS as [0, 0]; a static buffer has no slnt axis,
    // so the exemption cannot fire.
    expect(webfontSyntheticItalic(face({}), 14)).toBe(true);
  });

  it("exempts an AUTO-descriptor variable face whose slnt axis reaches a right-leaning coordinate", () => {
    // `has_right_slanted_variations` — the one exemption in the whole rule.
    // The axis is read in ITS OWN (OpenType) sign convention: negative =
    // right-leaning, the opposite of CSS `oblique <angle>`'s positive-
    // clockwise convention.
    expect(webfontSyntheticItalic(face({ slntAxisMin: -10 }), 14)).toBe(false);
    expect(webfontSyntheticItalic(face({ slntAxisMin: -0.25 }), 14)).toBe(false);
    // …but an axis that does NOT reach a right-leaning coordinate is not
    // exempted: `slnt_range.minimum < kNormalSlopeValue` is strict.
    expect(webfontSyntheticItalic(face({ slntAxisMin: 0 }), 14)).toBe(true);
    expect(webfontSyntheticItalic(face({ slntAxisMin: 5 }), 14)).toBe(true);
  });

  it("does NOT extend the exemption to a DECLARED descriptor — that is the whole gap", () => {
    // Same file, same axis. Only the descriptor differs, and only the
    // declared one shears.
    expect(webfontSyntheticItalic(face({ slntAxisMin: -10 }), 14)).toBe(false);
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [0, 0], slntAxisMin: -10 }), 14)).toBe(true);
  });

  it("uses kItalicSlopeValue = 14 exactly", () => {
    const f = face({ declaredStyleCaps: [0, 0] });
    expect(webfontSyntheticItalic(f, 0)).toBe(false);
    expect(webfontSyntheticItalic(f, 13)).toBe(false);
    expect(webfontSyntheticItalic(f, 14)).toBe(true);
    // …and unlike the SYSTEM-font Windows/Linux rule, the WEBFONT rule is
    // >= 14, not == 14 — an explicit `oblique 30deg` still shears a
    // normal-declared webfont face.
    expect(webfontSyntheticItalic(f, 30)).toBe(true);
  });

  it("does not shear when the descriptor itself already reaches the italic sentinel", () => {
    // `capabilities.slope.maximum < kItalicSlopeValue` fails, so `italic` is
    // false before the platform data is ever built.
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [14, 14] }), 14)).toBe(false);
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [0, 20], slntAxisMin: -10 }), 14)).toBe(false);
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [10, 20] }), 20)).toBe(false);
  });

  it("does not shear a buffer that already declares itself italic", () => {
    // `synthetic_italic && !base_typeface_->isItalic()` — Skia's isItalic()
    // is `fontStyle().slant() != kUpright_Slant`.
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [0, 0], baseIsItalic: true }), 14)).toBe(false);
    // …and the same buffer without the italic flag DOES shear, so the term is
    // load-bearing rather than incidentally true.
    expect(webfontSyntheticItalic(face({ declaredStyleCaps: [0, 0], baseIsItalic: false }), 14)).toBe(true);
  });
});

// ── Plumbing: registerWebfont → the picked instance carries the face facts ──

const SERIF = "assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf";
const serifBuf = existsSync(SERIF) ? readFileSync(SERIF) : null;

/** Return a copy of `buf` whose OS/2 `fsSelection` ITALIC bit (bit 0, byte
 *  offset 62 within the table — version(2) + xAvgCharWidth(2) + …+
 *  sFamilyClass(2) = 32, + panose(10) = 42, + ulCharRange(16) = 58, +
 *  vendorID(4) = 62) reads `italic`. Mirrors `withUsWeightClass` in
 *  webfont-synthetic-bold.test.ts, patching a different OS/2 field so the
 *  committed Regular fixture can stand in for an "italic buffer" without a
 *  second font file. */
function withFsSelectionItalic(buf: Buffer, italic: boolean): Buffer {
  const out = Buffer.from(buf);
  const numTables = out.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (out.toString("latin1", rec, rec + 4) === "OS/2") {
      const tableStart = out.readUInt32BE(rec + 8);
      const fsSelectionOffset = tableStart + 62;
      const current = out.readUInt16BE(fsSelectionOffset);
      out.writeUInt16BE(italic ? (current | 0x01) : (current & ~0x01), fsSelectionOffset);
      return out;
    }
  }
  throw new Error("fixture font has no OS/2 table");
}

const describeWithSerif = serifBuf != null ? describe : describe.skip;

describeWithSerif("registered webfont variants carry their synthesis facts", () => {
  beforeEach(() => clearWebfonts());

  it("a static auto-descriptor face reports no axis, not italic, no declared caps", () => {
    registerWebfont("StaticAutoItalic", 400, "normal", serifBuf!);
    const inst = resolveFont("StaticAutoItalic", 400, 24, 0);
    expect(inst?.webfontFace?.declaredStyleCaps).toBeNull();
    expect(inst?.webfontFace?.slntAxisMin).toBeNull();
    expect(inst?.webfontFace?.baseIsItalic).toBe(false);
    expect(webfontSyntheticItalic(inst!.webfontFace!, 14)).toBe(true);
    expect(webfontSyntheticItalic(inst!.webfontFace!, 0)).toBe(false);
  });

  it("a declared `italic` style descriptor travels onto the instance", () => {
    // `styleDesc` (the 8th arg) is the RAW descriptor — see its doc comment
    // for why it must be passed separately from `style` (the 3rd arg, already
    // defaulted to "normal" for selection purposes and unable to distinguish
    // "declared normal" from "no descriptor at all").
    registerWebfont("DeclaredItalic", 400, "italic", serifBuf!, undefined, undefined, undefined, "italic");
    expect(resolveFont("DeclaredItalic", 400, 24, -1)?.webfontFace?.declaredStyleCaps).toEqual([14, 14]);
  });

  it("a declared explicit oblique-angle descriptor travels onto the instance", () => {
    registerWebfont("DeclaredOblique", 400, "oblique 20deg", serifBuf!, undefined, undefined, undefined, "oblique 20deg");
    expect(resolveFont("DeclaredOblique", 400, 24, -1)?.webfontFace?.declaredStyleCaps).toEqual([20, 20]);
  });

  it("an EXPLICIT `normal` descriptor is NOT the same as an absent one — the whole reason `styleDesc` exists", () => {
    // Same `style` ("normal") as the auto-descriptor test above, but this
    // time the raw descriptor is explicitly "normal" rather than omitted.
    // Both select identically (`style` is "normal" either way), but only the
    // OMITTED one is eligible for the variable-slnt-axis exemption —
    // `IsRangeSetFromAuto()` is false for an explicit descriptor of ANY kind,
    // including `normal`.
    registerWebfont("ExplicitNormal", 400, "normal", serifBuf!, undefined, undefined, undefined, "normal");
    const inst = resolveFont("ExplicitNormal", 400, 24, 0);
    expect(inst?.webfontFace?.declaredStyleCaps).toEqual([0, 0]);
  });

  it("reads baseIsItalic from the buffer's own OS/2 fsSelection ITALIC bit", () => {
    registerWebfont("ItalicBuf", 400, "italic", withFsSelectionItalic(serifBuf!, true));
    const italic = resolveFont("ItalicBuf", 400, 24, -1);
    expect(italic?.webfontFace?.baseIsItalic).toBe(true);
    expect(webfontSyntheticItalic(italic!.webfontFace!, 14)).toBe(false);
    // The same fixture with the bit explicitly cleared reports NOT italic —
    // proving the read is the bit, not a fixed answer for this file.
    clearWebfonts();
    registerWebfont("UprightBuf", 400, "normal", withFsSelectionItalic(serifBuf!, false));
    const upright = resolveFont("UprightBuf", 400, 24, 0);
    expect(upright?.webfontFace?.baseIsItalic).toBe(false);
    expect(webfontSyntheticItalic(upright!.webfontFace!, 14)).toBe(true);
  });

  it("a system-font instance carries NO webfontFace, so it keeps the platform rules", () => {
    expect(resolveFont("Times", 400, 24, -1)?.webfontFace).toBeUndefined();
  });
});

// ── The renderer seam: the emitted markup must actually carry the shear ──
//
// Geometry, not pixels — per DM-2016's own gating instruction. These go red
// if the rule is computed but never consulted (the exact gap item 4 filed:
// `faceNeedsSyntheticOblique` had no `webfontFace` branch at all).

describeWithSerif("the emitted run carries the synthetic italic shear (DM-2016 item 4)", () => {
  beforeEach(() => { clearWebfonts(); clearEmbeddedFontBuilder(); });

  function shearFor(family: string, fontStyle: string): string | null {
    setRenderTextMode("paths");
    const markup = renderTextAsPath("Hag", 0, 100, {
      fontSize: 100, fontFamily: `"${family}"`, fontWeight: 400, fontStyle, fill: "#000",
    });
    const m = /matrix\(1,0,(-?[\d.]+),1,0,0\)/.exec(markup ?? "");
    return m == null ? null : m[1];
  }

  it("shears a static auto-descriptor face requested italic, and not requested normal", () => {
    registerWebfont("SeamItalic", 400, "normal", serifBuf!);
    expect(shearFor("SeamItalic", "normal")).toBeNull();
    expect(shearFor("SeamItalic", "italic")).not.toBeNull();
  });

  it("…and does NOT for a buffer that already declares itself italic", () => {
    registerWebfont("SeamAlreadyItalic", 400, "italic", withFsSelectionItalic(serifBuf!, true));
    expect(shearFor("SeamAlreadyItalic", "italic")).toBeNull();
  });

  it("…and does NOT for an explicit `oblique 10deg` against a declared `oblique 0deg 20deg` range", () => {
    // The declared range's maximum (20) is NOT below kItalicSlopeValue (14),
    // so `italic` is false before the platform data is built — the face is
    // treated as covering the request by its own descriptor.
    registerWebfont("SeamRangeCovers", 400, "oblique 0deg 20deg", serifBuf!, undefined, undefined, undefined, "oblique 0deg 20deg");
    expect(shearFor("SeamRangeCovers", "oblique 10deg")).toBeNull();
  });
});
