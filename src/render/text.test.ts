import * as fs from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { __bidiMirrorLinesForTest, emphasisGraphemeSpans, parseFontFeatureSettings, parseFontVariationSettings, parseTextEmphasisMark, rasterGlyphOverlays, renderSingleLineText, resolveChwsFeature, resolveFontVariantAlternates, resolveFontVariantFeatures } from "./text.js";
import { featureListNeedsHbShaping } from "./font-features.js";
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
    expect(out).not.toMatch(/^<g transform="translate\(0,0\)"/);
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

  it("DM-1960: keeps `off` / `0` entries as HarfBuzz-syntax disables", () => {
    // Blink appends every setting with its value intact (font_features.cc:203-225,
    // rev 7d859f27); a dropped disable rendered `"liga" 0` WITH ligatures.
    expect(parseFontFeatureSettings('"cv11", "kern" 0, "liga" off')).toEqual(["cv11", "-kern", "-liga"]);
    expect(parseFontFeatureSettings('"kern" 0')).toEqual(["-kern"]);
    expect(parseFontFeatureSettings('"dlig" 0, "liga" 0')).toEqual(["-dlig", "-liga"]);
  });

  it("keeps numr/dnom verbatim — Blink passes every setting through unchanged (font_features.cc:203-225)", () => {
    // DM-2048: a previous revision remapped `numr`/`dnom` to `sups`/`subs` as a
    // fitted stand-in for a fontkit limitation (fontkit only fires a font's
    // numr/dnom GSUB lookups inside a `frac` run, so a bare numr was a
    // fontkit no-op). Chrome does not do this — `FontFeatureRange::
    // FromFontDescription` appends every `font-feature-settings` entry
    // verbatim, and `featureListNeedsHbShaping` now routes a run carrying
    // numr/dnom through real HarfBuzz shaping instead (see
    // `font-features.test.ts`), so the stand-in is no longer needed.
    expect(parseFontFeatureSettings('"numr"')).toEqual(["numr"]);
    expect(parseFontFeatureSettings('"dnom"')).toEqual(["dnom"]);
    expect(parseFontFeatureSettings('"numr", "kern"')).toEqual(["numr", "kern"]);
    expect(parseFontFeatureSettings('"tnum", "numr"')).toEqual(["tnum", "numr"]);
    // A disabled numr/dnom still passes through as a HarfBuzz-syntax disable
    // (already true before this change — the remap only applied to the
    // enabled/valued branch).
    expect(parseFontFeatureSettings('"numr" 0')).toEqual(["-numr"]);
  });

  it("DM-1960: keeps explicit values > 1 as HarfBuzz `tag=N` entries", () => {
    // `salt 2` picks alternate #2. Chrome passes the value through to HarfBuzz;
    // the `tag=N` form survives parsing so the HarfBuzz shaping route can honor
    // it (fontkit's projection flattens it back to the bare tag).
    expect(parseFontFeatureSettings('"salt" 2')).toEqual(["salt=2"]);
  });

  it("ignores garbage tokens between valid feature declarations", () => {
    expect(parseFontFeatureSettings(', , "cv11", junk, "ss03"')).toEqual(["cv11", "ss03"]);
  });
});

describe("resolveFontVariantAlternates (DM-2160)", () => {
  const tables = {
    "source serif pro": {
      stylistic: { fancy: [2] },
      styleset: { display: [1, 3, 100] },
      characterVariant: { open: [4], closed: [7, 3] },
      swash: { ornate: [5] },
      ornaments: { fleurons: [6] },
      annotation: { circled: [8] },
    },
  };

  it("transcribes Blink's category-to-OpenType mapping and value rules", () => {
    expect(resolveFontVariantAlternates(
      "historical-forms stylistic(fancy) styleset(display) character-variant(open closed) swash(ornate) ornaments(fleurons) annotation(circled)",
      "'Source Serif Pro', serif", tables,
    )).toEqual(["swsh=5", "cswh=5", "ornm=6", "nalt=8", "salt=2", "ss01", "ss03", "cv04", "cv07=3", "hist"]);
  });

  it("scopes aliases to the requested family", () => {
    expect(resolveFontVariantAlternates("stylistic(fancy)", "Garamond, serif", tables)).toBeUndefined();
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

  it("maps the ligature enable keywords", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, "discretionary-ligatures")).toEqual(["dlig"]);
    expect(resolveFontVariantFeatures(undefined, undefined, "historical-ligatures")).toEqual(["hlig"]);
    // DM-1963: `contextual` emits NOTHING. calt is on by default in HarfBuzz,
    // and Blink pushes only `no_calt` — there is no enable push in
    // `font_features.cc:79-86`. Emitting `calt` was harmless while nothing could
    // turn it off, and became a direct contradiction once letter-spacing could
    // (which pushes `-calt` in the same list), so it is dropped rather than made
    // conditional.
    expect(resolveFontVariantFeatures(undefined, undefined, "contextual")).toBeUndefined();
  });

  // DM-1963: the two inputs Blink reads that this function used to lack. Both
  // are VETOES that outrank the author's keyword — the disjunction's first term
  // is `letter_spacing`, so no `font-variant-ligatures` value survives it.
  describe("letter-spacing and text-rendering vetoes (DM-1963)", () => {
    const f = (lig: string | undefined, ls?: string, tr?: string): string[] | undefined =>
      resolveFontVariantFeatures(undefined, undefined, lig, ls, tr);

    it("disables liga/clig/calt on any non-zero letter-spacing", () => {
      expect(f(undefined, "2px")).toEqual(["-liga", "-clig", "-calt"]);
      expect(f(undefined, "-0.5px")).toEqual(["-liga", "-clig", "-calt"]);
    });

    it("treats `normal` and an explicit 0 as zero spacing", () => {
      expect(f(undefined, "normal")).toBeUndefined();
      expect(f(undefined, "0px")).toBeUndefined();
      expect(f(undefined)).toBeUndefined();
    });

    it("overrides an explicit enable — the keyword does not survive letter-spacing", () => {
      // The case that makes this a veto rather than a default: the author asked
      // for common ligatures AND Chrome shapes without them.
      expect(f("common-ligatures", "1px")).toEqual(["-liga", "-clig", "-calt"]);
      // …and the enables are suppressed rather than merely outvoted.
      expect(f("discretionary-ligatures historical-ligatures", "1px"))
        .toEqual(["-liga", "-clig", "-calt"]);
      expect(f("discretionary-ligatures historical-ligatures"))
        .toEqual(["dlig", "hlig"]);
    });

    it("matches the keyword CASE-INSENSITIVELY, which is how it actually arrives", () => {
      // The CSS keyword is `optimizeSpeed`, but Chrome's computed style
      // serializes it ALL-LOWERCASE, so this is the spelling capture hands us —
      // verified by dumping the element tree (`styles.textRendering` is
      // `"optimizespeed"`). An exact match against the spec spelling compiles,
      // reads correctly, and silently never fires. It shipped that way for the
      // length of one measurement here: the disable-and-require-movement check
      // showed this arm byte-identical either way while the letter-spacing arm
      // moved 3px, which is the only reason it was caught.
      expect(f(undefined, "normal", "optimizespeed")).toEqual(["-liga", "-clig", "-calt"]);
      expect(f(undefined, "normal", "optimizeSpeed")).toEqual(["-liga", "-clig", "-calt"]);
    });

    it("disables the NORMAL-state features under text-rendering: optimizeSpeed", () => {
      expect(f(undefined, "normal", "optimizeSpeed")).toEqual(["-liga", "-clig", "-calt"]);
      // …but an explicit enable DOES survive optimizeSpeed, unlike
      // letter-spacing: that term only fires in the `normal` state.
      expect(f("common-ligatures contextual", "normal", "optimizeSpeed")).toBeUndefined();
      expect(f("discretionary-ligatures", "normal", "optimizeSpeed"))
        .toEqual(["-liga", "-clig", "dlig", "-calt"]);
    });

    it("leaves the other text-rendering values alone", () => {
      for (const tr of ["auto", "optimizeLegibility", "geometricPrecision"]) {
        expect(f(undefined, "normal", tr)).toBeUndefined();
      }
    });
  });

  it("DM-1960: maps the ligature disable keywords per Blink's feature emission", () => {
    // Transcribed from FontFeatureRange::FromFontDescription,
    // font_features.cc:54-86, rev 7d859f27: common disabled -> liga 0 + clig 0,
    // contextual disabled -> calt 0, `none` -> all three (dlig/hlig are off by
    // default so `none` emits no entry for them).
    expect(resolveFontVariantFeatures(undefined, undefined, "no-common-ligatures")).toEqual(["-liga", "-clig"]);
    expect(resolveFontVariantFeatures(undefined, undefined, "no-contextual")).toEqual(["-calt"]);
    expect(resolveFontVariantFeatures(undefined, undefined, "none")).toEqual(["-liga", "-clig", "-calt"]);
    // The no-* keywords must NOT read as enables (the plain patterns matched
    // inside them — `-` is a word boundary).
    expect(resolveFontVariantFeatures(undefined, undefined, "no-discretionary-ligatures")).toBeUndefined();
    expect(resolveFontVariantFeatures(undefined, undefined, "no-historical-ligatures")).toBeUndefined();
    expect(resolveFontVariantFeatures(undefined, undefined, "no-common-ligatures no-discretionary-ligatures"))
      .toEqual(["-liga", "-clig"]);
  });

  // The upstream shape: `FontFeatureRange::FromFontDescription`,
  // `platform/fonts/shaping/font_features.cc:39-50`, rev 7d859f27 —
  // `kNoneKerning` pushes `-kern` (vertical would push `-vkrn`, unreachable
  // here since vertical writing-mode text is rasterized before this pipeline,
  // `docs/reference/raster-image-fallback-cases.md` E6); `kNormalKerning` and
  // `kAutoKerning` push nothing (kern is on by default in HarfBuzz).
  it("font-kerning: none pushes -kern (font_features.cc:39-50)", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, "none"))
      .toEqual(["-kern"]);
  });

  it("font-kerning: normal / auto push nothing", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, "normal"))
      .toBeUndefined();
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, "auto"))
      .toBeUndefined();
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, undefined))
      .toBeUndefined();
  });

  // `-kern` is a HarfBuzz-only disable — the routing predicate must see it.
  it("font-kerning: none routes the run through HarfBuzz shaping", () => {
    expect(featureListNeedsHbShaping(resolveFontVariantFeatures(
      undefined, undefined, undefined, undefined, undefined, "none"))).toBe(true);
  });

  // `FontFeatureRange::FromFontDescription`, `font_features.cc:230-239`, rev
  // 7d859f27 — `kSubVariantPosition` → `subs`, `kSuperVariantPosition` → `sups`.
  // The two are mutually exclusive (Chrome's computed `font-variant-position`
  // is a single keyword), so only one tag is ever pushed.
  it("font-variant-position maps sub/super to subs/sups (font_features.cc:230-239)", () => {
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, undefined, "sub"))
      .toEqual(["subs"]);
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, undefined, "super"))
      .toEqual(["sups"]);
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, undefined, "normal"))
      .toBeUndefined();
    expect(resolveFontVariantFeatures(undefined, undefined, undefined, undefined, undefined, undefined, undefined))
      .toBeUndefined();
  });
});

// DM-2048: `chws` defaults on whenever `text-spacing-trim: normal` makes
// `ShouldTrimAdjacent` true (`text_spacing_trim.h:23-25`, rev 7d859f27),
// which is unconditional since Domotion never captures another value.
// `FontFeatureRange::FromFontDescription` appends it AFTER walking the
// author's `font-feature-settings`, skipping the default when the author
// already declared `chws` (any value) or a non-zero `halt`/`palt`
// (`platform/fonts/shaping/font_features.cc:197-228`, rev 7d859f27).
describe("resolveChwsFeature (DM-2048, font_features.cc:197-228)", () => {
  it("appends chws when the author set nothing", () => {
    expect(resolveChwsFeature(undefined)).toEqual(["chws"]);
    expect(resolveChwsFeature([])).toEqual(["chws"]);
    expect(resolveChwsFeature(["cv11"])).toEqual(["chws"]);
  });

  it("skips the default when the author already declared chws, at any value", () => {
    expect(resolveChwsFeature(["chws"])).toBeUndefined();
    expect(resolveChwsFeature(["-chws"])).toBeUndefined();
    expect(resolveChwsFeature(["chws=2"])).toBeUndefined();
  });

  it("skips the default when the author set a NON-ZERO halt or palt", () => {
    expect(resolveChwsFeature(["halt"])).toBeUndefined();
    expect(resolveChwsFeature(["palt"])).toBeUndefined();
    expect(resolveChwsFeature(["palt=1"])).toBeUndefined();
  });

  it("does NOT skip the default for a ZERO-value halt/palt — Blink's check is `feature.value &&`", () => {
    // `feature.value && (feature.tag == halt_or_vhal || feature.tag == palt_or_vpal)`
    // — a disabled (0-value) halt/palt does not veto the default chws.
    expect(resolveChwsFeature(["-halt"])).toEqual(["chws"]);
    expect(resolveChwsFeature(["-palt"])).toEqual(["chws"]);
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

describe("emphasisGraphemeSpans (DM-2156)", () => {
  it("keeps combining sequences, surrogate pairs, and ZWJ emoji atomic", () => {
    const spans = emphasisGraphemeSpans("A\u0301😀👩‍💻");
    expect(spans.map((span) => span.text)).toEqual(["A\u0301", "😀", "👩‍💻"]);
    expect(spans.map((span) => [span.start, span.end])).toEqual([[0, 2], [2, 4], [4, 9]]);
  });
});
