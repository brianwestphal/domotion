// Synthetic bold for WEBFONT runs — a different rule from the per-platform
// system-font predicates, and a platform-independent one.
//
// Blink composes it from two files, both read from the local checkout at rev
// 7d859f27 and verified byte-identical at Chromium tag 147.0.7727.15 (the
// version Playwright pins):
//
//   core/css/css_segmented_font_face.cc:116-119
//     SetSyntheticBold(capabilities.weight.maximum < kBoldThreshold &&
//                      request.weight >= kBoldThreshold && SyntheticBoldAllowed())
//   platform/fonts/font_custom_platform_data.cc:129-154, 289-293
//     synthetic_bold = bold;                         // declared descriptor: untouched
//     …auto-descriptor VARIABLE branch only:
//     has_bold_variations = wght_range.maximum > kNormalWeightValue;
//     synthetic_bold = bold && !has_bold_variations && request.weight >= kBoldThreshold;
//     …then finally: synthetic_bold && !base_typeface_->isBold()
//
// The descriptor capabilities — NOT the font's axis range — are what the first
// term reads, and an absent descriptor is [400, 400] (`core/css/font_face.cc:
// 669-672` + the auto branch at 870-873). So an auto-descriptor STATIC face is
// a synthesis candidate at every request ≥ 600, while an auto-descriptor
// VARIABLE face whose wght axis reaches past 400 is exempted.
//
// Measured over CDP + 1x ink at 100px "Hamburgefonstiv" (macOS, Chromium
// 147.0.7727.15). Synthetic bold moves NEITHER the advance NOR the reported
// platform face, so only ink can see it:
//
//   Lexend VF declared `font-weight: 400`, requested 700
//     width 847.000 (same as its 400 control), face Lexend-Regular (same),
//     ink 25951.4 vs 21568.9 → +20.3%
//   Lexend VF declared `font-weight: 100 500`, requested 700
//     wght clamped to 500 AND emboldened: ink 29104.2 vs 24756.2 → +17.6%
//   Static IBM Plex Serif Regular, auto descriptor, requested 700
//     ink 22559.6 vs 17510.0 → +28.8%
//
// …and the negative controls, each of which some plausible-but-wrong rule
// would have gotten wrong:
//
//   Lexend VF auto descriptor, requested 700 → ink 30327.4, identical to the
//     same file declared `font-weight: 700` — the auto-branch exemption.
//   Static serif declared 400, requested 500 → ink 17510.0, identical to its
//     400 control: the webfont threshold is 600, not the 500 the macOS
//     SYSTEM-font rule uses.
//   Arial Bold buffer declared `font-weight: 400`, requested 700 → ink
//     25979.1, identical to its 400 control: `!base_typeface_->isBold()`.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  webfontSyntheticBold, registerWebfont, clearWebfonts, resolveFont,
  type WebfontSynthesisFace,
} from "./font-resolution.js";
import { renderTextAsPath, setRenderTextMode } from "./text-to-path.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss } from "./embedded-font-builder.js";
import { skiaFakeBoldStrokeExtraPx } from "./embolden-outline.js";

const face = (o: Partial<WebfontSynthesisFace>): WebfontSynthesisFace => ({
  declaredWeightCaps: null, wghtAxisMax: null, baseIsBold: false, ...o,
});

describe("webfontSyntheticBold — the rule", () => {
  it("emboldens a DECLARED-400 variable face at a bold request (the headline case)", () => {
    // caps.max 400 < 600, request 700 ≥ 600, declared → the variable exemption
    // is unreachable, buffer not bold. Chrome pins wght 400 AND emboldens.
    const f = face({ declaredWeightCaps: [400, 400], wghtAxisMax: 900 });
    expect(webfontSyntheticBold(f, 700)).toBe(true);
  });

  it("emboldens a declared range whose maximum stops short of bold", () => {
    // Declared [100, 500]: the request clamps to wght 500 and STILL emboldens,
    // because 500 < kBoldThreshold. Measured ink 29104.2 vs the 500 control's
    // 24756.2.
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [100, 500], wghtAxisMax: 900 }), 700)).toBe(true);
  });

  it("emboldens a static webfont buffer with an auto descriptor", () => {
    // An auto descriptor SELECTS as [400, 400]; a static buffer has no wght
    // axis, so the exemption cannot fire.
    expect(webfontSyntheticBold(face({}), 700)).toBe(true);
  });

  it("exempts an AUTO-descriptor variable face whose wght axis reaches past 400", () => {
    // `has_bold_variations` — the one exemption in the whole rule, and the
    // reason the common Google-Fonts variable face is not double-bolded.
    expect(webfontSyntheticBold(face({ wghtAxisMax: 900 }), 700)).toBe(false);
    expect(webfontSyntheticBold(face({ wghtAxisMax: 500 }), 700)).toBe(false);
    // …but an axis that does NOT reach past normal weight is not exempted:
    // `wght_range.maximum > kNormalWeightValue` is strict.
    expect(webfontSyntheticBold(face({ wghtAxisMax: 400 }), 700)).toBe(true);
    expect(webfontSyntheticBold(face({ wghtAxisMax: 300 }), 700)).toBe(true);
  });

  it("does NOT extend the exemption to a DECLARED descriptor — that is the whole gap", () => {
    // Same file, same axis. Only the descriptor differs, and only the
    // declared one emboldens. Any implementation that keys the exemption on
    // "is this a variable font" rather than on RangeSetFromAuto gets this
    // pair identical, and it is the pair the ticket was filed about.
    expect(webfontSyntheticBold(face({ wghtAxisMax: 900 }), 700)).toBe(false);
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [400, 400], wghtAxisMax: 900 }), 700)).toBe(true);
  });

  it("uses kBoldThreshold = 600, not the macOS system-font rule's 500", () => {
    const f = face({ declaredWeightCaps: [400, 400] });
    expect(webfontSyntheticBold(f, 500)).toBe(false);
    expect(webfontSyntheticBold(f, 599)).toBe(false);
    expect(webfontSyntheticBold(f, 600)).toBe(true);
    expect(webfontSyntheticBold(f, 700)).toBe(true);
  });

  it("does not embolden when the descriptor itself reaches bold", () => {
    // `capabilities.weight.maximum < kBoldThreshold` fails, so `bold` is
    // false before the platform data is ever built.
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [700, 700] }), 700)).toBe(false);
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [100, 900], wghtAxisMax: 900 }), 700)).toBe(false);
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [400, 600] }), 700)).toBe(false);
  });

  it("does not embolden a buffer that already declares itself bold", () => {
    // `synthetic_bold && !base_typeface_->isBold()` — Skia's isBold() is the
    // face's own style weight ≥ 600.
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [400, 400], baseIsBold: true }), 700)).toBe(false);
    // …and the same buffer without the bold flag DOES embolden, so the term
    // is load-bearing rather than incidentally true.
    expect(webfontSyntheticBold(face({ declaredWeightCaps: [400, 400], baseIsBold: false }), 700)).toBe(true);
  });
});

// ── Plumbing: registerWebfont → the picked instance carries the face facts ──

const SERIF = "assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf";
const serifBuf = existsSync(SERIF) ? readFileSync(SERIF) : null;

/** Return a copy of `buf` whose OS/2 `usWeightClass` reads `weight`.
 *  usWeightClass is the third uint16 of the OS/2 table (version at 0,
 *  xAvgCharWidth at 2, usWeightClass at 4), so patching it in place turns a
 *  committed Regular fixture into a "bold buffer" without shipping a second
 *  font file — which is what Skia's `isBold()` reads. */
function withUsWeightClass(buf: Buffer, weight: number): Buffer {
  const out = Buffer.from(buf);
  const numTables = out.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (out.toString("latin1", rec, rec + 4) === "OS/2") {
      out.writeUInt16BE(weight, out.readUInt32BE(rec + 8) + 4);
      return out;
    }
  }
  throw new Error("fixture font has no OS/2 table");
}

const describeWithSerif = serifBuf != null ? describe : describe.skip;

describeWithSerif("registered webfont variants carry their synthesis facts", () => {
  beforeEach(() => clearWebfonts());

  it("a static auto-descriptor face reports no axis, not bold, no declared caps", () => {
    registerWebfont("StaticAuto", 400, "normal", serifBuf!);
    const inst = resolveFont("StaticAuto", 700, 24, 0);
    expect(inst?.webfontFace).toEqual({ declaredWeightCaps: null, wghtAxisMax: null, baseIsBold: false });
    expect(webfontSyntheticBold(inst!.webfontFace!, 700)).toBe(true);
    expect(webfontSyntheticBold(inst!.webfontFace!, 400)).toBe(false);
  });

  it("a declared descriptor travels onto the instance", () => {
    registerWebfont("Declared", 400, "normal", serifBuf!, undefined, undefined, "300 500");
    expect(resolveFont("Declared", 700, 24, 0)?.webfontFace?.declaredWeightCaps).toEqual([300, 500]);
  });

  it("reads baseIsBold from the buffer's own OS/2 usWeightClass", () => {
    registerWebfont("BoldBuf", 400, "normal", withUsWeightClass(serifBuf!, 700), undefined, undefined, "400");
    const bold = resolveFont("BoldBuf", 700, 24, 0);
    expect(bold?.webfontFace?.baseIsBold).toBe(true);
    expect(webfontSyntheticBold(bold!.webfontFace!, 700)).toBe(false);
    // 600 is the boundary Skia draws (kSemiBold_Weight), so 599 is not bold.
    clearWebfonts();
    registerWebfont("SemiBuf", 400, "normal", withUsWeightClass(serifBuf!, 599), undefined, undefined, "400");
    expect(resolveFont("SemiBuf", 700, 24, 0)?.webfontFace?.baseIsBold).toBe(false);
  });

  it("a system-font instance carries NO webfontFace, so it keeps the platform rules", () => {
    // The gate in the renderer is `run.font.webfontFace != null`; a resolved
    // system face must not accidentally satisfy it.
    expect(resolveFont("Times", 700, 24, 0)?.webfontFace).toBeUndefined();
  });
});

// The variable half needs a font with a real `wght` axis. The variable-axis
// fixture embeds OpenSans-Regular VF (wght [300, 800]).
const VAR_FIXTURE = "tests/fixtures/variable-axis/variable-axis.html";
const varBuf = (() => {
  if (!existsSync(VAR_FIXTURE)) return null;
  const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(readFileSync(VAR_FIXTURE, "utf8"));
  return m != null ? Buffer.from(m[1], "base64") : null;
})();
const describeWithVar = varBuf != null ? describe : describe.skip;

describeWithVar("variable webfonts: auto exempts, declared does not", () => {
  beforeEach(() => clearWebfonts());

  it("records the wght axis maximum on the quarter grid Blink quantizes to", () => {
    registerWebfont("VarAuto", 400, "normal", varBuf!);
    expect(resolveFont("VarAuto", 700, 24, 0)?.webfontFace?.wghtAxisMax).toBe(800);
  });

  it("the SAME buffer embolden-flips on the descriptor alone", () => {
    registerWebfont("VarAuto", 400, "normal", varBuf!);
    registerWebfont("VarDecl", 400, "normal", varBuf!, undefined, undefined, "400");
    const auto = resolveFont("VarAuto", 700, 24, 0)!;
    const decl = resolveFont("VarDecl", 700, 24, 0)!;
    expect(webfontSyntheticBold(auto.webfontFace!, 700)).toBe(false);
    expect(webfontSyntheticBold(decl.webfontFace!, 700)).toBe(true);
  });

  it("re-picking the same variant at another weight leaves the face facts intact", () => {
    // The facts are stamped onto the instance at pick time; every field is a
    // per-variant constant, so a page mixing weights must not let the last
    // pick rewrite an earlier run's answer.
    registerWebfont("Mixed", 400, "normal", varBuf!, undefined, undefined, "400");
    const at700 = resolveFont("Mixed", 700, 24, 0)!;
    const at400 = resolveFont("Mixed", 400, 24, 0)!;
    expect(webfontSyntheticBold(at700.webfontFace!, 700)).toBe(true);
    expect(webfontSyntheticBold(at400.webfontFace!, 400)).toBe(false);
    // …and asking the FIRST instance again still answers for weight 700.
    expect(webfontSyntheticBold(at700.webfontFace!, 700)).toBe(true);
  });
});

// ── The renderer seam: the emitted subset must actually carry the embolden ──
//
// These are the tests that go red if the rule is computed but never consulted.
// Verified by construction: stubbing the seam's `run.font.webfontFace` to null
// collapses all four cases to "outlines identical", which is the pre-fix
// behavior — a webfont run could not reach the faux-bold bake at all, because
// only the system-font branch set the fields it reads.

describeWithSerif("the emitted run carries the synthetic bold (DM-1970)", () => {
  beforeEach(() => { clearWebfonts(); clearEmbeddedFontBuilder(); });
  afterEach(() => { clearWebfonts(); clearEmbeddedFontBuilder(); setRenderTextMode("embedded-font"); });

  /**
   * The synthetic-bold FRAME width the embedded-font path emits for one short
   * run, or null when it emitted none.
   *
   * DM-1970 moved the observation point. Synthetic bold used to be baked into
   * the subset's outlines, so two renders of the same face differed in their
   * base64 payload if and only if the synthesis fired. It is now Skia's own
   * operation — fill plus a centred frame of `textSize * fakeBoldScale`
   * (`useStrokeForFakeBold`, Skia src/core/SkScalerContext.cpp:1019-1041) — so
   * the subset carries the face's plain outlines and the `<text>` carries the
   * frame.
   *
   * Reading the payload here would now be WORSE than useless: the bytes are
   * identical either way, so a byte comparison cannot fail and would report
   * "no synthesis" and "synthesis" identically. One of the three cases below
   * asserted exactly that equality and had silently become vacuous.
   */
  function strokeWidthFor(family: string, weight: number): number | null {
    clearEmbeddedFontBuilder();
    setRenderTextMode("embedded-font");
    const markup = renderTextAsPath("Hn", 0, 100, {
      fontSize: 100, fontFamily: `"${family}"`, fontWeight: weight, fill: "#000",
    });
    const m = /<text[^>]*\sstroke-width="([\d.]+)"/.exec(markup ?? "");
    return m == null ? null : Number(m[1]);
  }

  /** `skiaFakeBoldStrokeExtraPx(100)` — 100px is at/above the 36px knee, so the
   *  scale is 1/32 and the frame is exactly 3.125px. */
  const EXPECTED_AT_100 = 100 / 32;

  it("a static auto-descriptor face gets a synthetic-bold frame at 700 and none at 400", () => {
    // A static face's outlines are the file's, identical at every requested
    // weight; the synthesis is the frame. Chrome's measured ink for this pair:
    // 22559.6 at 700 vs 17510.0 at 400.
    registerWebfont("SeamAuto", 400, "normal", serifBuf!);
    expect(strokeWidthFor("SeamAuto", 400)).toBeNull();
    expect(strokeWidthFor("SeamAuto", 700)).toBeCloseTo(EXPECTED_AT_100, 2);
  });

  it("…and does NOT at a request below kBoldThreshold", () => {
    registerWebfont("SeamBand", 400, "normal", serifBuf!, undefined, undefined, "400");
    expect(strokeWidthFor("SeamBand", 500)).toBeNull();
    expect(strokeWidthFor("SeamBand", 700)).toBeCloseTo(EXPECTED_AT_100, 2);
  });

  it("…and does NOT for a buffer that declares itself bold", () => {
    registerWebfont("SeamBold", 400, "normal", withUsWeightClass(serifBuf!, 700), undefined, undefined, "400");
    expect(strokeWidthFor("SeamBold", 700)).toBeNull();
  });

  it("scales the frame with text size, as Skia's interpolation does", () => {
    // The half this mechanism replaced had NO size term at all: a constant in
    // design space, so a fixed fraction of the em at every size. Skia's is
    // 1/24 at <=9px through 1/32 at >=36px (src/core/SkTextFormatParams.h:16-29).
    registerWebfont("SeamSize", 400, "normal", serifBuf!);
    const at = (px: number): number | null => {
      clearEmbeddedFontBuilder();
      setRenderTextMode("embedded-font");
      const markup = renderTextAsPath("Hn", 0, px * 2, {
        fontSize: px, fontFamily: `"SeamSize"`, fontWeight: 700, fill: "#000",
      });
      const m = /<text[^>]*\sstroke-width="([\d.]+)"/.exec(markup ?? "");
      return m == null ? null : Number(m[1]);
    };
    // Asserted against the emitted value INCLUDING its 2-decimal rounding,
    // rather than against the raw formula: the rounding is part of the contract
    // (0.375 emits as 0.38), and comparing to the unrounded number just
    // measures how loose the tolerance is.
    for (const px of [9, 12, 24, 36, 48, 100]) {
      const expected = Math.round(skiaFakeBoldStrokeExtraPx(px) * 100) / 100;
      expect(at(px), `${px}px`).toBeCloseTo(expected, 6);
    }
    // …and the point of having a size term at all: the frame is a LARGER
    // fraction of the text at small sizes. A constant design-space strength
    // gets this backwards and leaves body text ~25% too light.
    expect(at(9)! / 9).toBeGreaterThan(at(48)! / 48);
  });
});
