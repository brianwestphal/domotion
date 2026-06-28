import * as fs from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { __bidiMirrorLinesForTest, parseFontFeatureSettings, parseFontVariationSettings, parseTextEmphasisMark, rasterGlyphOverlays, renderSingleLineText, resolveFontVariantFeatures } from "./text.js";
import { setRenderTextMode } from "./text-to-path.js";
import type { CapturedElement } from "../capture/types.js";

// DM-839: embedded-font is the production default render mode, but these tests
// assert the glyph-PATH renderer's `<text transform="scale(...)">` / baseline
// output. Pin paths mode so the path-specific assertions hold.
beforeEach(() => setRenderTextMode("paths"));

describe("BiDi paired-bracket mirroring across wrapped lines (DM-1055)", () => {
  // A `direction: rtl` paragraph whose `(...)` pair soft-wraps so the closing
  // bracket lands alone on the last line. Resolving BiDi per-line sees a lone
  // trailing `)` at an odd embedding level and mirrors it to `(` — but Chrome
  // resolves the WHOLE paragraph, where the pair is level 2 (even) and neither
  // bracket mirrors. The renderer must do the same.
  const full = "rtl: one two three four (English words but RTL ordering)";
  const lines = ["rtl: one two three", "four (English", "words but RTL", "ordering)"];

  it("does not mirror a bracket pair split across wrapped RTL lines", () => {
    const out = __bidiMirrorLinesForTest(full, lines, "rtl");
    expect(out).toEqual(lines); // brackets unchanged — '(' stays '(', ')' stays ')'
  });

  it("resolves split lines identically to the un-wrapped paragraph", () => {
    // The fix's actual goal: wrapping must not change which brackets mirror.
    const split = __bidiMirrorLinesForTest(full, lines, "rtl").join(" ");
    const unwrapped = __bidiMirrorLinesForTest(full, [full], "rtl")[0];
    expect(split).toBe(unwrapped);
  });
});

// Tests that exercise glyph emission via the macOS-only FONT_PATHS map
// (Linux / Windows are roadmap per CLAUDE.md) skip on hosts without
// /System/Library/Fonts/Helvetica.ttc — otherwise renderSingleLineText
// returns an empty string and the per-character assertions assert against
// nothing on Ubuntu CI runners.
const MACOS_FONTS = fs.existsSync("/System/Library/Fonts/Helvetica.ttc");

describe("rasterGlyphOverlays — emoji bitmap sizing (DM-381)", () => {
  // The captured per-char rect spans the line-box height (~lineHeight) and
  // the glyph advance — bigger than what Chrome actually paints, which is
  // the em-square (fontSize × fontSize) anchored to the baseline. The
  // overlay emits the bitmap at em-square size centered in the rect so the
  // <image> dims match Chrome's painted region instead of being stretched
  // out to the full line-box.
  const seg: any = {
    text: "😀",
    x: 347.7, y: 695.4, width: 23, height: 25,
    rasterGlyphs: [{
      charIndex: 0,
      rect: { x: 347.7, y: 695.4, width: 23, height: 25 },
      dataUri: "data:image/png;base64,iVBORw0KGgo="
    }]
  };

  it("emits the bitmap at the captured rect coords + dims (DM-401 / DM-411 / DM-414)", () => {
    // The screenshot was captured from Chrome's actual paint at this rect,
    // so re-embedding at the same coords + dims preserves the painted
    // geometry pixel-for-pixel. Avoid the prior em-square-stretch which
    // squished tall line-box rects horizontally and rendered emojis
    // visibly larger than Chrome's actual paint.
    const out = rasterGlyphOverlays(seg, 22, "ct1");
    expect(out).toContain('x="347.7"');
    expect(out).toContain('y="695.4"');
    expect(out).toContain('width="23"');
    expect(out).toContain('height="25"');
    expect(out).toContain('preserveAspectRatio="none"');
  });

  it("ignores fontSize for sizing — the captured rect dims are authoritative", () => {
    const segWithFs: any = { ...seg, fontSize: 32 };
    const out = rasterGlyphOverlays(segWithFs, 16, "ct1");
    expect(out).toContain('width="23"');
    expect(out).toContain('height="25"');
  });

  it("returns empty when there are no resolved dataUris", () => {
    const empty: any = { ...seg, rasterGlyphs: [{ charIndex: 0, rect: seg.rect, dataUri: undefined }] };
    expect(rasterGlyphOverlays(empty, 22, "ct1")).toBe("");
  });

  it("returns empty when the segment has no rasterGlyphs at all", () => {
    expect(rasterGlyphOverlays({ ...seg, rasterGlyphs: undefined }, 22, "ct1")).toBe("");
  });
});

describe("renderSingleLineText — pseudo-only segment positioning (DM-495)", () => {
  // When a host element has no main text and only a positioned ::after / ::before
  // pseudo, the segment carries its own x/y/color/fontSize. Before DM-495 the
  // single-segment path read host-level fields exclusively, so the pseudo's
  // text was emitted at translate(0,0) in the host's color (typically the
  // inherited default black) instead of at the pseudo's anchor in its own
  // CSS-declared color. Capture sets host textLeft/textTop/textWidth from
  // the pseudo seg in this case, and the renderer reads seg.color /
  // seg.fontSize / seg.fontWeight / seg.fontAscent so all per-pseudo
  // overrides flow through.
  const baseStyles = {
    color: "rgb(0,0,0)",
    fontSize: "16px",
    fontFamily: "-apple-system, sans-serif",
    fontWeight: "400",
    fontStyle: "normal",
    direction: "ltr",
    textDecorationLine: "none",
    textDecorationColor: "currentcolor",
    textDecorationStyle: "solid",
  } as any;

  const makeEl = (seg: any): CapturedElement => ({
    tag: "span",
    x: 100, y: 50, width: 200, height: 80,
    textLeft: seg.x, textTop: seg.y, textWidth: seg.width, textHeight: seg.height,
    fontAscent: seg.fontAscent,
    text: seg.text,
    textSegments: [seg],
    styles: baseStyles,
  } as any);

  it.skipIf(!MACOS_FONTS)("renders the pseudo's own color, not the host's color", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    expect(out).toContain('fill="rgb(255, 255, 255)"');
    expect(out).not.toContain('fill="rgb(0,0,0)"');
  });

  it.skipIf(!MACOS_FONTS)("anchors the path at the pseudo's x/y, not at the SVG origin", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    // baselineY = textTop + fontAscent = 56 + 9 = 65
    expect(out).toMatch(/transform="translate\(108,\s*65\)"/);
    expect(out).not.toContain('translate(0,0)');
  });

  it.skipIf(!MACOS_FONTS)("uses the pseudo's fontSize when set, not the host's", () => {
    const seg = {
      text: "T",
      x: 108, y: 56, width: 8, height: 11,
      color: "rgb(255, 255, 255)",
      fontSize: 11,
      fontWeight: "400",
      fontAscent: 9,
    };
    // Host fontSize is 16, pseudo is 11 — output should reflect 11px scale.
    const elWithLargerHost = { ...makeEl(seg), styles: { ...baseStyles, fontSize: "16px" } } as any;
    const outAt11 = renderSingleLineText({
      el: elWithLargerHost,
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(0,0,0)",
    });
    // The inner glyph scale = fontSize / unitsPerEm. For typical fonts (UPM
    // ~2048), 11/2048 ≈ 0.00537; 16/2048 ≈ 0.00781. Spot-check the small one.
    expect(outAt11).toMatch(/scale\(0\.00[0-9]+,/);
    // Negative comparison: the host-fontSize scale shouldn't appear.
    expect(outAt11).not.toContain('scale(0.00781,');
  });

  it("falls back to host fillColor when seg.color is absent", () => {
    const seg = {
      text: "TAG",
      x: 108, y: 56, width: 22, height: 11,
      fontAscent: 9,
    };
    const out = renderSingleLineText({
      el: makeEl(seg),
      idPrefix: "t",
      clipId: "ct0",
      fillColor: "rgb(34, 139, 34)",
    });
    expect(out).toContain('fill="rgb(34, 139, 34)"');
  });
});

// DM-564: `font-feature-settings` was captured but never threaded to
// `font.layout()`, so brand fonts that set author features (Inter's `cv11`
// single-story `a`, Geist's `cv09`, etc. via next/font marketing pages) shipped
// the default glyph instead of the intended alternate — the visible "wrong
// font" symptom on framer-mobile-fold.
describe("parseFontFeatureSettings (DM-564)", () => {
  it("returns undefined for normal / empty / null", () => {
    expect(parseFontFeatureSettings(undefined)).toBeUndefined();
    expect(parseFontFeatureSettings("")).toBeUndefined();
    expect(parseFontFeatureSettings("normal")).toBeUndefined();
  });

  it("parses a single quoted feature tag", () => {
    expect(parseFontFeatureSettings('"cv11"')).toEqual(["cv11"]);
    expect(parseFontFeatureSettings("'cv11'")).toEqual(["cv11"]);
  });

  it("parses framer.com's Inter Variable feature stack verbatim", () => {
    // Captured live from www.framer.com body P getComputedStyle().
    expect(parseFontFeatureSettings('"cv01", "cv05", "cv09", "cv11", "ss03", "ss07"'))
      .toEqual(["cv01", "cv05", "cv09", "cv11", "ss03", "ss07"]);
  });

  it("honors `on` / explicit value / `1` as enabled", () => {
    expect(parseFontFeatureSettings('"cv11" on, "kern" 1')).toEqual(["cv11", "kern"]);
  });

  it("drops features with `off` or `0`", () => {
    expect(parseFontFeatureSettings('"cv11", "kern" 0, "liga" off')).toEqual(["cv11"]);
    expect(parseFontFeatureSettings('"kern" 0')).toBeUndefined();
  });

  it("DM-1267: maps numr/dnom to sups/subs (fontkit applies those standalone)", () => {
    // Authors use bare `font-feature-settings: "numr"` as a faux-superscript
    // (Apple's `sup.footnote` footnote numbers). fontkit only fires a font's
    // numr/dnom GSUB lookups inside a `frac` run, so a bare numr is a no-op;
    // sups/subs ARE applied standalone and select near-identical glyphs.
    expect(parseFontFeatureSettings('"numr"')).toEqual(["sups"]);
    expect(parseFontFeatureSettings('"dnom"')).toEqual(["subs"]);
    expect(parseFontFeatureSettings('"numr", "kern"')).toEqual(["sups", "kern"]);
    // Non-mapped tags pass through unchanged alongside.
    expect(parseFontFeatureSettings('"tnum", "numr"')).toEqual(["tnum", "sups"]);
  });

  it("supports stylistic-alternate selectors with numeric index", () => {
    // `salt 2` picks alternate #2; we currently flatten to enabling the tag
    // (fontkit's userFeatures is on/off only). Confirms we still emit the tag.
    expect(parseFontFeatureSettings('"salt" 2')).toEqual(["salt"]);
  });

  it("ignores garbage tokens between valid feature declarations", () => {
    expect(parseFontFeatureSettings(', , "cv11", junk, "ss03"')).toEqual(["cv11", "ss03"]);
  });
});

// DM-1117: font-variant-east-asian / -numeric / -ligatures longhands map to
// OpenType feature tags. Without these, e.g. `font-variant-east-asian:
// traditional` paints the simplified default glyph (国) instead of the
// traditional form (國), and numeric variants ignore old-style / tabular figures.
describe("resolveFontVariantFeatures (DM-1117)", () => {
  it("returns undefined when every longhand is normal / empty", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, undefined)).toBeUndefined();
    expect(resolveFontVariantFeatures("normal", "normal", "normal")).toBeUndefined();
  });

  it("maps east-asian keywords to their OpenType tags", () => {
    expect(resolveFontVariantFeatures("traditional", undefined, undefined)).toEqual(["trad"]);
    expect(resolveFontVariantFeatures("jis78", undefined, undefined)).toEqual(["jp78"]);
    expect(resolveFontVariantFeatures("full-width", undefined, undefined)).toEqual(["fwid"]);
    expect(resolveFontVariantFeatures("proportional-width", undefined, undefined)).toEqual(["pwid"]);
    // Combined keywords (`traditional full-width`) both map.
    expect(resolveFontVariantFeatures("traditional full-width", undefined, undefined)).toEqual(["trad", "fwid"]);
  });

  it("maps numeric keywords to their OpenType tags", () => {
    expect(resolveFontVariantFeatures(undefined, "oldstyle-nums", undefined)).toEqual(["onum"]);
    expect(resolveFontVariantFeatures(undefined, "tabular-nums slashed-zero", undefined)).toEqual(["tnum", "zero"]);
    expect(resolveFontVariantFeatures(undefined, "diagonal-fractions", undefined)).toEqual(["frac"]);
  });

  it("maps the enable-only ligature keywords (disables are a known gap)", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, "discretionary-ligatures")).toEqual(["dlig"]);
    expect(resolveFontVariantFeatures(undefined, undefined, "historical-ligatures")).toEqual(["hlig"]);
    // `no-common-ligatures` can't be expressed in fontkit's enable-only list.
    expect(resolveFontVariantFeatures(undefined, undefined, "no-common-ligatures")).toBeUndefined();
  });
});

// DM-578: variable-font axes set via CSS `font-variation-settings` must
// override the CSS-weight / font-size-derived defaults. Without parsing the
// declaration, Inter Variable / Geist / Roboto Flex etc. render at the
// default instance (e.g. wght=400, opsz=fontSize) even when the page asked
// for wght=450, opsz=30 — visible as slightly wrong stem thickness and
// glyph spacing on framer.com / vercel.com / other next/font marketing pages.
describe("parseFontVariationSettings (DM-578)", () => {
  it("returns undefined for normal / empty / null", () => {
    expect(parseFontVariationSettings(undefined)).toBeUndefined();
    expect(parseFontVariationSettings("")).toBeUndefined();
    expect(parseFontVariationSettings("normal")).toBeUndefined();
  });

  it("parses a single axis declaration", () => {
    expect(parseFontVariationSettings('"wght" 450')).toEqual({ wght: 450 });
  });

  it("parses framer.com body P verbatim", () => {
    // Captured live from www.framer.com body P `font-variation-settings`.
    expect(parseFontVariationSettings('"opsz" 30, "wght" 450'))
      .toEqual({ opsz: 30, wght: 450 });
  });

  it("parses fractional axis values", () => {
    expect(parseFontVariationSettings('"wght" 437.5, "slnt" -9.99'))
      .toEqual({ wght: 437.5, slnt: -9.99 });
  });

  it("parses negative slant values", () => {
    expect(parseFontVariationSettings('"slnt" -10')).toEqual({ slnt: -10 });
  });

  it("supports both single and double quotes around tags", () => {
    expect(parseFontVariationSettings(`'wght' 450, "opsz" 16`))
      .toEqual({ wght: 450, opsz: 16 });
  });

  it("handles custom axis tags (e.g. Recursive's CASL, MONO, CRSV)", () => {
    expect(parseFontVariationSettings('"CASL" 0.5, "MONO" 1, "CRSV" 0.5'))
      .toEqual({ CASL: 0.5, MONO: 1, CRSV: 0.5 });
  });
});

describe("parseTextEmphasisMark (DM-920)", () => {
  it("returns null for none / empty / undefined", () => {
    expect(parseTextEmphasisMark(undefined)).toBeNull();
    expect(parseTextEmphasisMark("")).toBeNull();
    expect(parseTextEmphasisMark("none")).toBeNull();
  });

  it("uses the literal <string> form verbatim", () => {
    expect(parseTextEmphasisMark('"★"')).toBe("★");
    expect(parseTextEmphasisMark("'·'")).toBe("·");
  });

  it("maps filled shape keywords to their solid glyphs (filled is the default)", () => {
    expect(parseTextEmphasisMark("dot")).toBe("•");
    expect(parseTextEmphasisMark("filled dot")).toBe("•");
    expect(parseTextEmphasisMark("circle")).toBe("●");
    expect(parseTextEmphasisMark("double-circle")).toBe("◉");
    expect(parseTextEmphasisMark("triangle")).toBe("▲");
    expect(parseTextEmphasisMark("sesame")).toBe("﹅");
  });

  it("maps open shape keywords to their hollow glyphs", () => {
    expect(parseTextEmphasisMark("open dot")).toBe("◦");
    expect(parseTextEmphasisMark("open circle")).toBe("○");
    expect(parseTextEmphasisMark("open double-circle")).toBe("◎");
    expect(parseTextEmphasisMark("open triangle")).toBe("△");
    expect(parseTextEmphasisMark("open sesame")).toBe("﹆");
  });

  it("returns null when no shape keyword is present", () => {
    expect(parseTextEmphasisMark("filled")).toBeNull();
    expect(parseTextEmphasisMark("open")).toBeNull();
  });
});
