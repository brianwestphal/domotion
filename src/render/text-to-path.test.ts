import * as fs from "fs";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fontkit from "fontkit";
import { __clearGlyphFallbackCaches, __resolveDarwinFontSpecForTest, __resolveFontForCodepointForTest, __resolveFontSpecForTest, cjkTrimShiftFontUnits, clearEmbeddedFonts, clearGlyphDefs, clearWebfonts, commandsFor, complexShaperBaseMarkDecomposition, computeSkipInkGaps, darwinFallbackChain, fallbackFontChain, fontHasOutlineTable, getDecorationMetrics, getEmbeddedFontFaceCss, insertSyntheticDottedCircles, isStrippableOrphanIgnorable, isTrimmableCjkPunct, stripOrphanedDefaultIgnorables, isLeftReorderingMatra, isLegitimatelyInklessCodepoint, isStretchyFenceChar, isTextToPathAvailable, linuxFallbackChain, mathAlphaToBase, measureInkMetrics, pingfangKeyForLang, registerWebfont, renderRadicalGlyph, renderStretchyFenceGlyph, renderTextAsPath, resolveFontKey, resolveFontKeyChain, setRenderTextMode, synthSmallCapsCharScale, usesComplexShaperDottedCircle, win32FallbackChain } from "./text-to-path.js";
import { existsSync } from "node:fs";
import * as fontkit2 from "fontkit";
import { trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { resolveInstalledFont } from "./glyph-helper.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";

// Tests that exercise glyph emission (renderTextAsPath returning markup,
// fontkit-driven small-caps shaping, descender skip-ink probing, ligature
// collapse) assert against the *macOS* painted output specifically (Helvetica
// glyph shapes, Courier metrics, etc.). Cross-platform path discovery
// (DM-258) makes the renderer resolve SOMETHING on Linux/Windows (DejaVu /
// Noto / Arial), but the glyph shapes differ, so these macOS-pinned
// assertions still only hold on darwin. Skip them off-macOS so the suite
// stays green on Ubuntu/Windows runners.
const MACOS_FONTS = fs.existsSync("/System/Library/Fonts/Helvetica.ttc");

// DM-839: embedded-font is the production default render mode, but the tests
// below assert against the glyph-PATH renderer (`<use>`/`<path>` emission,
// baseline/scale math, ligature collapse). Pin paths mode before every test so
// those assertions hold; the two embedded-font tests flip to embedded-font
// within themselves.
beforeEach(() => setRenderTextMode("paths"));

// Pinned mappings for the CSS generic-family keywords. These exist to lock
// the fidelity-critical resolutions Chrome on macOS performs (per Blink's
// font_cache_mac.mm) — substituting any of these silently shifts every
// page's text metrics. See DM-236 (monospace was wrongly routed to SF Mono)
// and SK-1124 (sans-serif was wrongly routed to SF Pro).
describe("resolveFontKey: generic-family resolution", () => {
  it("routes sans-serif to Helvetica, not SF Pro", () => {
    expect(resolveFontKey("sans-serif")).toBe("helvetica");
  });

  it("skips bare ui-sans-serif so it falls through to Times (DM-290)", () => {
    // Empirical Chromium probe at 16px: `ui-sans-serif` paints at 376.38px
    // (UA-default Times metrics), not 410.03px (Helvetica). Like the other
    // ui-* keywords, Chromium-on-macOS doesn't recognize this generic and
    // walks past it to the next family in the stack — or falls through to
    // the Standard Font default if it's the only one. Mapping it to
    // Helvetica painted the 20-font-family fixture's `ui-sans-serif` row
    // with sans-serif glyphs while Chrome paints serifs (DM-290 user note).
    expect(resolveFontKey("ui-sans-serif")).toBe("times");
    expect(resolveFontKey("ui-sans-serif, sans-serif")).toBe("helvetica");
  });

  it("routes monospace to Courier, not SF Mono or Menlo", () => {
    expect(resolveFontKey("monospace")).toBe("courier");
  });

  it("routes an explicitly-named Playfair Display to its own key (DM-1120)", () => {
    // Chrome resolves the installed Playfair Display for the drop-cap; we
    // mirror it so the `B` isn't painted in the Georgia fallback. The route is
    // explicit-name only — a bare `serif` still resolves to Times.
    expect(resolveFontKey("Playfair Display")).toBe("playfair-display");
    expect(resolveFontKey('"Playfair Display", Georgia, serif')).toBe("playfair-display");
    expect(resolveFontKey("serif")).toBe("times");
  });

  it("routes bare ui-monospace / ui-rounded / ui-sans-serif to Times (last-resort fallback)", () => {
    // DM-269: macOS Chrome doesn't recognize ui-monospace / ui-rounded as
    // system fonts — painted T width is 9.77px (Times) and q is 8.0px (Times),
    // not Courier or SF Mono. Chrome falls through to the Standard Font default.
    expect(resolveFontKey("ui-monospace")).toBe("times");
    expect(resolveFontKey("ui-rounded")).toBe("times");
    expect(resolveFontKey("ui-sans-serif")).toBe("times");
  });

  it("falls through ui-monospace when later names in the chain are valid (DM-302)", () => {
    // CSS like `font: ui-monospace, Menlo, Consolas, monospace` is common —
    // the leading ui-monospace is a hint Chrome doesn't recognize on macOS,
    // and Chrome paints Menlo (the next valid name). Pinning to Times on the
    // ui-monospace keyword would make code editors render in a serif face.
    expect(resolveFontKey("ui-monospace, Menlo, Consolas, monospace")).toBe("menlo");
    expect(resolveFontKey("ui-rounded, Helvetica")).toBe("helvetica");
    expect(resolveFontKey("emoji, sans-serif")).toBe("helvetica");
  });

  it("routes serif to Times, not Georgia", () => {
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });

  it("routes system-ui / BlinkMacSystemFont to SF Pro", () => {
    expect(resolveFontKey("system-ui")).toBe("sf-pro");
    expect(resolveFontKey("BlinkMacSystemFont")).toBe("sf-pro");
  });

  it("skips bare -apple-system so the next family in the stack matches (DM-291)", () => {
    // Chromium probe at 18px on "greet": `font-family: -apple-system` alone
    // paints at 35.98px (UA-default Times metrics), `font-family: sans-serif`
    // paints at 41.03px (Helvetica), and `font-family: -apple-system,
    // sans-serif` paints at 41.03px — proving Chrome doesn't recognize
    // -apple-system in this build and falls through to the next family. We
    // mirror that by skipping it; the test fixture pinned this stack and the
    // SF Pro glyphs were ~1px wider than Chrome's Helvetica painted output.
    expect(resolveFontKey("-apple-system")).toBe("times");
    expect(resolveFontKey("-apple-system, sans-serif")).toBe("helvetica");
  });

  it("routes cursive to Apple Chancery (DM-290)", () => {
    // Empirical probe at 16px: Chrome cursive paints at 290.08px which
    // matches Apple Chancery exactly (Snell Roundhand is 263.84px — a
    // ~10% drift if we picked Snell). Author-named "Snell Roundhand" /
    // "Brush Script MT" still get the snell key since those are explicit.
    expect(resolveFontKey("cursive")).toBe("apple-chancery");
    expect(resolveFontKey("Apple Chancery")).toBe("apple-chancery");
    expect(resolveFontKey("Snell Roundhand")).toBe("snell");
    expect(resolveFontKey("Brush Script MT")).toBe("snell");
  });

  it("routes fantasy to Papyrus (DM-290)", () => {
    // Empirical probe at 16px: Chrome fantasy paints at 313.94px which
    // matches Papyrus exactly. Without this mapping the keyword fell
    // through to Times metrics (292.38px), which is ~7% narrower.
    expect(resolveFontKey("fantasy")).toBe("papyrus");
    expect(resolveFontKey("Papyrus")).toBe("papyrus");
  });
});

describe("resolveFontKey: explicit-name resolution", () => {
  it("honors author-named monospace families separately", () => {
    expect(resolveFontKey("Menlo")).toBe("menlo");
    expect(resolveFontKey("Monaco")).toBe("monaco");
    expect(resolveFontKey("Courier")).toBe("courier");
    expect(resolveFontKey("Courier New")).toBe("courier");
    expect(resolveFontKey("SF Mono")).toBe("sf-mono");
  });

  it("honors author-named sans families separately", () => {
    expect(resolveFontKey("Helvetica")).toBe("helvetica");
    // DM-1189: `Helvetica Neue` is its own face (HelveticaNeue.ttc), distinct from
    // plain Helvetica — Chrome's getPlatformFontsForNode confirms it paints from
    // Helvetica Neue, not Helvetica.
    expect(resolveFontKey("Helvetica Neue")).toBe("helvetica-neue");
    expect(resolveFontKey("Arial")).toBe("arial");
  });

  it("resolves named SF Pro Text / Display to their installed OTF, not system SFNS, so two-digit enclosed alphanumerics match Chrome (DM-1127)", () => {
    // The system variable font SFNS.ttf ("SF Pro") carries the SINGLE-digit
    // circled numbers (U+2460–2468) but NOT the two-digit ones (U+2469–2473)
    // or the negative-circled two-digit set (U+24EB–24F4). Chrome resolves the
    // explicitly-named "SF Pro Text" / "SF Pro Display" cuts to their OWN
    // installed OTFs (e.g. /Library/Fonts/SF-Pro-Text-Regular.otf), which DO
    // carry those glyphs. Mapping the name straight to the "sf-pro" SFNS key
    // (the pre-DM-1127 behavior) made those codepoints miss in the primary and
    // fall through to a larger fallback face (Arial Unicode MS's full-em
    // circled numbers), painting a visibly bigger glyph than Chrome's
    // condensed one.
    if (process.platform !== "darwin") {
      // No CoreText helper off macOS — the name approximates to the system cut.
      expect(resolveFontKey("SF Pro Text")).toBe("sf-pro");
      return;
    }
    const otf = resolveInstalledFont("SF Pro Text");
    if (otf == null) {
      // OTF not installed on this host: Chrome can't use it either, so we keep
      // the opsz-pinned "sf-pro" (SFNS) approximation (DM-1103).
      expect(resolveFontKey("SF Pro Text")).toBe("sf-pro");
      return;
    }
    const key = resolveFontKey("SF Pro Text");
    expect(key).toBe(`sysfb:${otf.postscriptName}`);
    // The resolved OTF must cover the two-digit enclosed alphanumerics that
    // SFNS.ttf lacks — that coverage gap was the bug.
    const spec = __resolveFontSpecForTest(key);
    expect(spec).not.toBeNull();
    const font = fontkit.openSync(spec!.path) as unknown as { glyphForCodePoint(cp: number): { id: number } };
    expect(font.glyphForCodePoint(0x2469).id).not.toBe(0); // ⑩ outlined (Enclosed Alphanumerics)
    expect(font.glyphForCodePoint(0x24EB).id).not.toBe(0); // ⑪ negative-circled
    expect(font.glyphForCodePoint(0x3251).id).not.toBe(0); // ㉑ circled 21 (Enclosed CJK — DM-1124)
    expect(font.glyphForCodePoint(0x32BF).id).not.toBe(0); // ㊿ circled 50 (Enclosed CJK — DM-1124)
    // Pin the precondition that made the bug possible: SFNS.ttf genuinely has
    // the single-digit circled numbers but not the two-digit ones (nor the
    // Enclosed-CJK circled 21–50). Guards against "fixing" this by silently
    // repointing the routing at another file.
    const sfns = fontkit.openSync("/System/Library/Fonts/SFNS.ttf") as unknown as { glyphForCodePoint(cp: number): { id: number } };
    expect(sfns.glyphForCodePoint(0x2460).id).not.toBe(0); // single-digit present
    expect(sfns.glyphForCodePoint(0x2469).id).toBe(0);     // two-digit absent
    expect(sfns.glyphForCodePoint(0x3251).id).toBe(0);     // Enclosed-CJK circled 21 absent
  });

  it("honors author-named serif families separately", () => {
    expect(resolveFontKey("Georgia")).toBe("georgia");
    // DM-330: explicit `Times New Roman` → the Microsoft TNR face (thinner
    // em-dash bar, H=122 in Bold), distinct from `Times`/`serif` which
    // resolve to Apple's `Times.ttc` (H=185 in Bold).
    expect(resolveFontKey("Times New Roman")).toBe("times-new-roman");
    expect(resolveFontKey('"Times New Roman"')).toBe("times-new-roman");
    expect(resolveFontKey("Times")).toBe("times");
    expect(resolveFontKey("serif")).toBe("times");
  });

  it("is case-insensitive and strips quotes", () => {
    expect(resolveFontKey("MONOSPACE")).toBe("courier");
    expect(resolveFontKey('"Helvetica Neue"')).toBe("helvetica-neue"); // DM-1189: own face
    expect(resolveFontKey("'SF Mono'")).toBe("sf-mono");
  });

  it("routes Chrome-unrecognized generics (math / emoji / fangsong) to Times", () => {
    // DM-269: probed Chrome on macOS — these paint with Times metrics
    // (q=8.0, T=9.77) when used as the only family. The Standard Font default
    // is Times; per-codepoint fallback then routes the glyphs Times lacks
    // (CJK, math alpha, color emoji) to the right block-specific font.
    // `fantasy` was previously in this list but is mapped to Papyrus
    // (DM-290) — see the dedicated test above.
    expect(resolveFontKey("math")).toBe("times");
    expect(resolveFontKey("emoji")).toBe("times");
    expect(resolveFontKey("fangsong")).toBe("times");
  });
});

// Cross-platform font path discovery (DM-258). The resolver maps each logical
// font key to a real file on disk for the host platform — macOS keeps its
// /System/Library/Fonts paths verbatim, Linux resolves via DejaVu/Noto +
// `fc-match`, Windows via C:\Windows\Fonts. The fallbackFontChain ROUTING is
// still macOS-calibrated (Linux=DM-259, Windows=DM-260); this layer only
// guarantees the primaries resolve to *a* face instead of null.
describe("resolveFontSpec: cross-platform font path discovery (DM-258)", () => {
  it("maps the core logical keys to a spec on every platform", () => {
    for (const key of ["helvetica", "times", "courier", "arial", "georgia", "cjk", "symbols", "stix-math"]) {
      expect(__resolveFontSpecForTest(key), key).not.toBeNull();
    }
  });

  it("returns null for an unmapped logical key so the family chain falls through", () => {
    expect(__resolveFontSpecForTest("definitely-not-a-real-font-key")).toBeNull();
  });

  // The sans-serif primary must resolve to a file that actually exists on the
  // current host — this is the acceptance criterion that fails pre-DM-258 on
  // Linux/Windows (every /System/Library/Fonts path is absent there).
  const sansSpec = __resolveFontSpecForTest("helvetica");
  const SANS_AVAILABLE = sansSpec != null && fs.existsSync(sansSpec.path);

  it.skipIf(!SANS_AVAILABLE)("resolves sans-serif to an on-disk font file", () => {
    expect(fs.existsSync(sansSpec!.path)).toBe(true);
  });

  it.skipIf(!SANS_AVAILABLE)("makes the CSS generics renderable on this platform", () => {
    expect(isTextToPathAvailable("sans-serif")).toBe(true);
    expect(isTextToPathAvailable("serif")).toBe(true);
    expect(isTextToPathAvailable("monospace")).toBe(true);
  });

  if (process.platform === "darwin") {
    it("leaves the macOS paths unchanged — no regression", () => {
      expect(__resolveFontSpecForTest("helvetica")?.path).toBe("/System/Library/Fonts/Helvetica.ttc");
      expect(__resolveFontSpecForTest("courier")?.path).toBe("/System/Library/Fonts/Courier.ttc");
      expect(__resolveFontSpecForTest("times")?.path).toBe("/System/Library/Fonts/Times.ttc");
      // The native-extractor flag survives the resolver indirection (PingFang).
      expect(__resolveFontSpecForTest("pingfang-sc")?.extractor).toBe("native");
    });
  }
});

// DM-887: the probe-then-fallback signal. fontkit can render a font's outlines
// only when it has a glyf / CFF / CFF2 table; PingFang (hvgl-only) has none, so
// it routes to the native helper. The check reads font.directory.tables, since
// the lazily-parsed font.glyf / font['CFF '] accessors are unreliable.
describe("fontHasOutlineTable (helper-fallback probe)", () => {
  it("is true for TrueType (glyf, incl. variable gvar) and PostScript (CFF/CFF2)", () => {
    expect(fontHasOutlineTable({ directory: { tables: { glyf: {}, loca: {}, cmap: {} } } })).toBe(true);
    expect(fontHasOutlineTable({ directory: { tables: { glyf: {}, gvar: {} } } })).toBe(true);
    expect(fontHasOutlineTable({ directory: { tables: { "CFF ": {} } } })).toBe(true);
    expect(fontHasOutlineTable({ directory: { tables: { CFF2: {} } } })).toBe(true);
  });
  it("is false for an hvgl-only font like PingFang (cmap/metrics but no outline table)", () => {
    expect(fontHasOutlineTable({ directory: { tables: { hvgl: {}, cmap: {}, "OS/2": {} } } })).toBe(false);
    expect(fontHasOutlineTable({ directory: { tables: {} } })).toBe(false);
  });
  it("defaults to true when the table directory is unknown — never over-routes a readable font", () => {
    expect(fontHasOutlineTable({})).toBe(true);
    expect(fontHasOutlineTable(null)).toBe(true);
    expect(fontHasOutlineTable({ directory: {} })).toBe(true);
  });
});

// DM-1026: the complex-shaper gate that decides whether an ORPHANED, UNCOVERED
// combining mark gets a synthetic dotted circle (U+25CC), mirroring Chrome's
// HarfBuzz. Font-independent — locks the block table so the crux gating can't
// silently drift (too broad → spurious ◌ on Latin marks; too narrow → missed
// Brahmic blocks). Holds on Linux CI.
describe("usesComplexShaperDottedCircle (tate-chu-yoko-adjacent: dotted-circle gate)", () => {
  it("is true for Brahmic / Indic / SE-Asian complex-shaper blocks", () => {
    expect(usesComplexShaperDottedCircle(0x11A51)).toBe(true); // Soyombo vowel sign
    expect(usesComplexShaperDottedCircle(0x11A01)).toBe(true); // Zanabazar Square
    expect(usesComplexShaperDottedCircle(0x11D3A)).toBe(true); // Masaram Gondi
    expect(usesComplexShaperDottedCircle(0x0903)).toBe(true);  // Devanagari sign visarga
    expect(usesComplexShaperDottedCircle(0x0E31)).toBe(true);  // Thai vowel sign
    expect(usesComplexShaperDottedCircle(0x0F71)).toBe(true);  // Tibetan vowel sign
    expect(usesComplexShaperDottedCircle(0x1789)).toBe(true);  // Khmer
    expect(usesComplexShaperDottedCircle(0xA8E0)).toBe(true);  // Devanagari Extended
    // SMP USE blocks that were previously omitted, so their orphaned no-font
    // marks painted a bare tofu with no leading dotted circle (DM-1097/DM-1100):
    expect(usesComplexShaperDottedCircle(0x113B9)).toBe(true); // Tulu-Tigalari vowel sign
    expect(usesComplexShaperDottedCircle(0x113E1)).toBe(true); // Tulu-Tigalari combining tone
    expect(usesComplexShaperDottedCircle(0x16120)).toBe(true); // Gurung Khema vowel sign
  });
  it("is FALSE for the generic combining-mark blocks (default shaper — Chrome adds NO dotted circle)", () => {
    expect(usesComplexShaperDottedCircle(0x0301)).toBe(false); // Combining acute (Latin)
    expect(usesComplexShaperDottedCircle(0x036F)).toBe(false); // Combining Diacritical Marks
    expect(usesComplexShaperDottedCircle(0x1AB0)).toBe(false); // …-Extended
    expect(usesComplexShaperDottedCircle(0x1DC0)).toBe(false); // …-Supplement
    expect(usesComplexShaperDottedCircle(0x20D0)).toBe(false); // …-for-Symbols
    expect(usesComplexShaperDottedCircle(0xFE20)).toBe(false); // Combining Half Marks
  });
  it("is FALSE for non-mark scripts and base letters", () => {
    expect(usesComplexShaperDottedCircle(0x0041)).toBe(false); // Latin A
    expect(usesComplexShaperDottedCircle(0x4E00)).toBe(false); // CJK 一
    expect(usesComplexShaperDottedCircle(0x0590)).toBe(false); // Hebrew area
  });
});

// DM-1197: the gate that routes a complex-script precomposed letter through real
// HarfBuzz (matching Chrome) instead of macOS CoreText (which recomposes / shapes
// it differently). MUST fire only for USE-shaped scripts — the dedicated Indic /
// Tibetan / Myanmar shapers already match Chrome on the CoreText path, and
// harfbuzzjs can diverge from Chrome for them (it decomposed Tibetan U+0F43 where
// Chrome renders the precomposed glyph, regressing the tibetan fixture).
describe("complexShaperBaseMarkDecomposition (DM-1197 HarfBuzz-rerouting gate)", () => {
  it("returns the NFD base+mark for USE-shaped precomposed letters", () => {
    expect(complexShaperBaseMarkDecomposition(0x110AB)).toBe("\u{110A5}\u{110BA}"); // Kaithi VA = BA + nukta
    expect(complexShaperBaseMarkDecomposition(0x1B06)).not.toBeNull();              // Balinese letter akara tedung
    expect(complexShaperBaseMarkDecomposition(0x11383)).not.toBeNull();            // Tulu-Tigalari
    // every returned decomposition is base-first, mark-last
    for (const cp of [0x110AB, 0x1B06, 0x11383]) {
      const d = complexShaperBaseMarkDecomposition(cp)!;
      const cps = [...d];
      expect(/\p{M}/u.test(cps[0])).toBe(false);
      expect(/\p{M}/u.test(cps[cps.length - 1])).toBe(true);
    }
  });
  it("is NULL for DEDICATED-shaper scripts (CoreText already matches Chrome there)", () => {
    expect(complexShaperBaseMarkDecomposition(0x0F43)).toBeNull(); // Tibetan GHA (regressed before the exclusion)
    expect(complexShaperBaseMarkDecomposition(0x0958)).toBeNull(); // Devanagari QA (Indic shaper)
    expect(complexShaperBaseMarkDecomposition(0x09DC)).toBeNull(); // Bengali RRA
    expect(complexShaperBaseMarkDecomposition(0x1026)).toBeNull(); // Myanmar UU
  });
  it("is NULL for the default shaper's composed Latin/Greek/Cyrillic diacritics", () => {
    expect(complexShaperBaseMarkDecomposition(0x00E9)).toBeNull(); // é (e + combining acute)
    expect(complexShaperBaseMarkDecomposition(0x00F1)).toBeNull(); // ñ
    expect(complexShaperBaseMarkDecomposition(0x0041)).toBeNull(); // plain Latin A — no decomposition
  });
  it("is NULL for an atomic complex-script letter with no canonical decomposition", () => {
    expect(complexShaperBaseMarkDecomposition(0x110A5)).toBeNull(); // Kaithi BA (the base itself)
  });
});

// DM-1215: an ORPHANED complex-script combining mark must be shaped via real
// HarfBuzz so the dotted circle Chrome inserts (and GPOS-positions the mark on)
// is reproduced. fontkit's USE shaping DROPS the ◌ for Adlam / Miao — it emits
// only the bare floating mark — so the renderer routes the orphan cluster through
// the mark's own font as a HarfBuzz instance, which inserts + positions the ◌ like
// Chrome's HarfBuzz. The gate is "no spacing base in the cluster", so a base+mark
// sequence (a real letter then its mark) is NOT rerouted. Verified in embedded
// mode by counting emitted glyphs (one PUA codepoint per shaped glyph).
describe("orphaned complex marks get a HarfBuzz dotted circle (DM-1215)", () => {
  const ADLAM = "/System/Library/Fonts/Supplemental/NotoSansAdlam-Regular.ttf";
  const HAVE_ADLAM = fs.existsSync(ADLAM);
  beforeEach(() => { clearWebfonts(); clearEmbeddedFonts(); setRenderTextMode("embedded-font"); });
  afterEach(() => { setRenderTextMode("paths"); });
  const glyphCount = (out: string): number => {
    let n = 0;
    for (const m of out.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) {
      for (let i = 0; i < m[1].length;) { const cp = m[1].codePointAt(i)!; n++; i += cp > 0xFFFF ? 2 : 1; }
    }
    return n;
  };
  it.skipIf(!HAVE_ADLAM)("inserts the ◌ for an orphaned Adlam mark (2 glyphs: ◌ + mark)", () => {
    const out = renderTextAsPath("\u{1E944}", 0, 0, 32, '"Noto Sans Adlam"', "400", "#000");
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(2); // HarfBuzz-inserted ◌ + the mark (fontkit alone → 1, no ◌)
  });
  it.skipIf(!HAVE_ADLAM)("shares ONE ◌ across an orphaned multi-mark cluster (3 glyphs: ◌ + 2 marks)", () => {
    const out = renderTextAsPath("\u{1E944}\u{1E944}", 0, 0, 32, '"Noto Sans Adlam"', "400", "#000");
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(3);
  });
  it.skipIf(!HAVE_ADLAM)("does NOT insert a ◌ for a based Adlam letter + mark (no orphan → 2 glyphs)", () => {
    const out = renderTextAsPath("\u{1E921}\u{1E944}", 0, 0, 32, '"Noto Sans Adlam"', "400", "#000");
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(2); // base + mark, NO inserted circle (would be 3 if mis-routed)
  });
  it.skipIf(!HAVE_ADLAM)("does NOT insert a ◌ for a bare Adlam base letter (1 glyph)", () => {
    const out = renderTextAsPath("\u{1E921}", 0, 0, 32, '"Noto Sans Adlam"', "400", "#000");
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(1);
  });
});

describe("insertSyntheticDottedCircles: CJK/Hangul tone marks stay bare for HarfBuzz (DM-1229)", () => {
  const AU = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
  const HAVE_AU = fs.existsSync(AU);
  // U+302A–302F are covered by Arial Unicode MS (DM-1174 routes them there). When
  // the capture probe flags one as circled, the covered-centering branch would
  // prepend an explicit "◌" — but real HarfBuzz on the BARE mark already inserts
  // and orders the ◌ the way Chrome paints it ([mark, ◌], dots LEFT of the
  // circle). Prepending "◌" instead yields "◌ + mark" (the reverse). So these
  // marks must pass through UNCHANGED, leaving the DM-1215 HarfBuzz path to do it.
  it.skipIf(!HAVE_AU)("does NOT prepend a ◌ to a probe-flagged tone mark (Arial Unicode primary)", () => {
    for (const cp of [0x302a, 0x302b, 0x302c, 0x302d, 0x302e, 0x302f]) {
      const ch = String.fromCodePoint(cp);
      const { text } = insertSyntheticDottedCircles(ch, undefined, '"Arial Unicode MS"', 400, 32, 0, undefined, undefined, [0]);
      expect(text).toBe(ch); // bare — NOT "◌" + ch (which would be 2 chars / the reversed layout)
    }
  });
});

// DM-1109: the pre-base (left) matra predicate. Unconditional set membership —
// no DOM. The crux is the Vowel_Dependent filter: InPC=Left medial CONSONANTS
// must NOT qualify (they don't pre-base-reorder), only left VOWEL signs do.
describe("isLeftReorderingMatra (pre-base vowel reorder gate)", () => {
  it("matches left VOWEL signs across Brahmic blocks", () => {
    expect(isLeftReorderingMatra(0x093F)).toBe(true);  // Devanagari sign I
    expect(isLeftReorderingMatra(0x113C5)).toBe(true);  // Tulu-Tigalari vowel sign AI (Left)
    expect(isLeftReorderingMatra(0x113C7)).toBe(true);  // Tulu-Tigalari vowel sign OO (Left_And_Right)
    expect(isLeftReorderingMatra(0x11347)).toBe(true);  // Grantha vowel sign EE
    expect(isLeftReorderingMatra(0x119E4)).toBe(true);  // Nandinagari vowel sign prishthamatra E
    expect(isLeftReorderingMatra(0x17BE)).toBe(true);   // Khmer vowel sign OE
  });
  it("does NOT match InPC=Left MEDIAL CONSONANTS (no pre-base reorder)", () => {
    // These are positioned left but are Consonant_Medial, not Vowel_Dependent —
    // Chrome paints them post-base. Including them regressed gurung-khema.
    expect(isLeftReorderingMatra(0x1612A)).toBe(false); // Gurung Khema medial YA
    expect(isLeftReorderingMatra(0x1612B)).toBe(false); // Gurung Khema medial VA
    expect(isLeftReorderingMatra(0x103C)).toBe(false);  // Myanmar consonant sign medial RA
    expect(isLeftReorderingMatra(0x1171E)).toBe(false); // Ahom consonant sign medial RA
    expect(isLeftReorderingMatra(0xA9BF)).toBe(false);  // Javanese consonant sign cakra
  });
  it("does NOT match post-base / above / below marks or plain text", () => {
    expect(isLeftReorderingMatra(0x113C9)).toBe(false); // Tulu-Tigalari AU length mark (Right)
    expect(isLeftReorderingMatra(0x0301)).toBe(false);  // Combining acute
    expect(isLeftReorderingMatra(0x0041)).toBe(false);  // Latin A
  });
});

// DM-1026: the synthetic dotted-circle preprocessing. macOS-gated (needs the
// real font chain to decide coverage). Asserts the FOUR gates compose: a
// no-font Brahmic orphaned mark gets a leading ◌, while a covered Latin mark, a
// mark with a base, and plain text are all left untouched.
const MACOS_FONTS_DC = fs.existsSync("/System/Library/Fonts/Helvetica.ttc");
(MACOS_FONTS_DC ? describe : describe.skip)("insertSyntheticDottedCircles (DM-1026)", () => {
  const fam = '"Arial Unicode MS","Apple Symbols","Noto Sans",sans-serif';
  const run = (text: string, xOffsets?: number[]) =>
    insertSyntheticDottedCircles(text, xOffsets, fam, 400, 32, 0, undefined, undefined);

  it("prepends U+25CC to a lone, uncovered, complex-shaper Brahmic mark", () => {
    const r = run("\u{11A51}"); // Soyombo vowel sign AA — no font covers it
    expect(r.text).toBe("◌\u{11A51}");
  });
  it("shifts a present xOffset so ◌ takes the cell origin and the mark moves right by the ◌ advance", () => {
    const r = run("\u{11A51}", [98.4, 98.4]); // one xOffset per UTF-16 unit
    expect(r.text).toBe("◌\u{11A51}");
    expect(r.xOffsets!.length).toBe(3); // ◌ + surrogate pair
    expect(r.xOffsets![0]).toBeCloseTo(98.4, 3); // ◌ at the captured cell origin
    expect(r.xOffsets![1]).toBeGreaterThan(98.4); // mark displaced right by ◌'s advance
    // The advance must come from the PRIMARY font (Arial Unicode MS ◌ = 0.6em =
    // 19.2px @32), NOT the fallback chain's full-width Hiragino ◌ (32px).
    expect(r.xOffsets![1] - 98.4).toBeCloseTo(19.2, 1);
  });
  it("DM-1109: appends ◌ AFTER a lone left (pre-base) matra so it paints mark-then-circle", () => {
    const r = run("\u{113C5}"); // Tulu-Tigalari VOWEL SIGN AI — uncovered, InPC=Left
    expect(r.text).toBe("\u{113C5}◌"); // mark first, ◌ after (Chrome reorders the matra ahead of its base)
  });
  it("DM-1109: positions the appended ◌ past the mark tofu's advance", () => {
    const r = run("\u{113C5}", [40, 40]); // one xOffset per UTF-16 unit
    expect(r.text).toBe("\u{113C5}◌");
    expect(r.xOffsets!.length).toBe(3); // surrogate pair + ◌
    expect(r.xOffsets![0]).toBeCloseTo(40, 3); // mark at the captured cell origin
    expect(r.xOffsets![1]).toBeCloseTo(40, 3);
    expect(r.xOffsets![2]).toBeGreaterThan(40); // ◌ shifted right past the tofu
  });
  it("DM-1109: still PREPENDS ◌ for a post-base (right) matra in the same block", () => {
    const r = run("\u{113C9}"); // Tulu-Tigalari AU LENGTH MARK — InPC=Right, not reordered
    expect(r.text).toBe("◌\u{113C9}");
  });
  it("does NOT insert ◌ for a generic Latin combining mark (covered + default shaper)", () => {
    const r = run("á"); // a + combining acute — covered, has a base
    expect(r.text).toBe("á");
  });
  it("does NOT insert ◌ for a Brahmic mark that HAS a base in its cluster (not orphaned)", () => {
    // Base letter (Lo) then its mark: HarfBuzz attaches the mark, no dotted circle.
    const r = run("\u{11A50}\u{11A51}");
    expect(r.text).toBe("\u{11A50}\u{11A51}");
  });
  it("is a no-op for plain text with no combining marks", () => {
    const r = run("Hello, world", [0, 1, 2]);
    expect(r.text).toBe("Hello, world");
    expect(r.xOffsets).toEqual([0, 1, 2]);
  });
});

// DM-1158: orphaned, uncovered variation selectors / tags must be HIDDEN (Chrome
// paints nothing), not routed to the CoreText last-resort tofu. The pure range
// predicate is cross-platform; the strip itself is macOS-gated (needs the real
// font chain to confirm the primary lacks the selector).
describe("isStrippableOrphanIgnorable (DM-1158 range predicate)", () => {
  it("flags variation selectors, the supplement block, and language tags", () => {
    for (const cp of [0xFE00, 0xFE0E, 0xFE0F, 0xE0100, 0xE01EF, 0xE0000, 0xE007F]) {
      expect(isStrippableOrphanIgnorable(cp)).toBe(true);
    }
  });
  it("does NOT flag joiners, spaces, or ordinary text (they carry width / shaping meaning)", () => {
    for (const cp of [0x200B, 0x200C, 0x200D, 0x20, 0xA0, 0x41, 0x6F22, 0x0301]) {
      expect(isStrippableOrphanIgnorable(cp)).toBe(false);
    }
  });
});

(MACOS_FONTS_DC ? describe : describe.skip)("stripOrphanedDefaultIgnorables (DM-1158)", () => {
  // Helvetica covers no variation selector, so the primary-uncovered gate fires
  // deterministically (a chain led by a font that DOES cover a given VS — e.g.
  // Noto Sans for U+FE00 — would keep it, which is also correct but font-version
  // dependent, so it's the wrong basis for an assertion).
  const fam = "Helvetica";
  const run = (text: string, xOffsets?: number[]) =>
    stripOrphanedDefaultIgnorables(text, xOffsets, fam, 400, 32, 0, undefined);

  it("drops a lone, uncovered variation selector (Chrome paints nothing)", () => {
    const r = run("︀", [16]);
    expect(r.text).toBe("");
    expect(r.xOffsets).toEqual([]);
  });
  it("drops a leading orphaned selector but keeps the following base + its x", () => {
    // The selector at index 0 is orphaned (no preceding base) → dropped; the
    // 'B' base survives with its captured x.
    const r = run("︀B", [16, 16]);
    expect(r.text).toBe("B");
    expect(r.xOffsets).toEqual([16]);
  });
  it("KEEPS a variation selector that follows a base (variation sequence, not orphaned)", () => {
    const r = run("A︀B", [0, 20, 20]);
    expect(r.text).toBe("A︀B");
  });
  it("KEEPS a variation selector that follows a base (emoji / CJK variation sequence)", () => {
    // ⛹ (U+26F9, emoji-range base) + VS-16: the selector is meaningful here, so
    // it must survive for the downstream emoji-presentation / overlay logic.
    const r = run("\u{26F9}️");
    expect(r.text).toBe("\u{26F9}️");
  });
  it("is a no-op for text with no strippable code points", () => {
    const r = run("Hello", [0, 1, 2, 3, 4]);
    expect(r.text).toBe("Hello");
    expect(r.xOffsets).toEqual([0, 1, 2, 3, 4]);
  });
});

// DM-891: the per-glyph helper fallback (a font fontkit opens but can't decode a
// specific glyph). The crux safety property is the inkless guard — without it,
// "fontkit empty → ask the helper" would fire on the entire inkless codepoint
// set (spaces, format chars, bidi controls, invisible operators), spawning the
// helper / triggering the DM-886 download for ordinary text.
describe("isLegitimatelyInklessCodepoint (per-glyph fallback guard)", () => {
  it("flags control / format / separators / spaces / invisibles (never paint ink)", () => {
    const inkless = [
      0x20, 0x09, 0x0A, 0x0D,                          // space, tab, LF, CR (Cc/Zs)
      0xA0, 0x2000, 0x2009, 0x202F, 0x205F, 0x3000,    // no-break / thin / narrow / math / ideographic spaces (Zs)
      0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF,          // ZWSP / ZWNJ / ZWJ / word-joiner / BOM (Cf)
      0x202A, 0x202B, 0x202C, 0x202D, 0x202E,          // bidi embedding/override (Cf)
      0x2028, 0x2029,                                  // line / paragraph separators (Zl/Zp)
      0x7F, 0x80, 0x9F,                                // DEL + C1 controls (Cc)
      0x2061, 0x2062, 0x2063, 0x2064,                  // invisible math operators
      0xFE00, 0xFE0F, 0xE0101, 0xE0020,                // variation selectors + tags
    ];
    for (const cp of inkless) expect(isLegitimatelyInklessCodepoint(cp)).toBe(true);
  });
  it("does NOT flag inkable glyphs — letters, digits, CJK, combining marks, Math-Alpha", () => {
    const inkable = [0x41, 0x61, 0x30, 0x6F22, 0x4E00, 0x0301, 0x05D0, 0x0E01, 0x1D400];
    for (const cp of inkable) expect(isLegitimatelyInklessCodepoint(cp)).toBe(false);
  });
});

describe("commandsFor (per-glyph fallback routing)", () => {
  beforeEach(() => __clearGlyphFallbackCaches());

  it("returns fontkit's commands verbatim when present (fast path, no helper)", () => {
    const cmds = [{ command: "moveTo", args: [0, 0] }, { command: "lineTo", args: [10, 10] }];
    expect(commandsFor({ path: { commands: cmds }, id: 5, codePoints: [0x41] }, "helvetica", 400, 16, 0)).toBe(cmds);
  });
  it("does not route .notdef (id 0) to the helper", () => {
    expect(commandsFor({ path: { commands: [] }, id: 0, codePoints: [0x41] }, "helvetica", 400, 16, 0)).toEqual([]);
  });
  it("does not route a legitimately-inkless glyph to the helper (no over-fire)", () => {
    // A space glyph: empty outline, cmap-covered (id != 0) — must stay empty.
    expect(commandsFor({ path: { commands: [] }, id: 99, codePoints: [0x20] }, "helvetica", 400, 16, 0)).toEqual([]);
    expect(commandsFor({ path: { commands: [] }, id: 99, codePoints: [0x202F] }, "helvetica", 400, 16, 0)).toEqual([]);
  });
  it("does not route when the glyph has no source codepoints (decomposed/ligature)", () => {
    expect(commandsFor({ path: { commands: [] }, id: 7 }, "helvetica", 400, 16, 0)).toEqual([]);
  });

  // Positive end-to-end: synthesize the (otherwise-nonexistent on macOS)
  // "fontkit returned empty for an inkable glyph" condition and confirm the
  // fallback pulls that glyph's real outline from the native helper. Gated on
  // the macOS in-tree helper + Helvetica.
  const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";
  const HELPER = "tools/macos-glyph-extractor/domotion-glyph-paths";
  const canRunPositive = process.platform === "darwin" && existsSync(HELVETICA) && existsSync(HELPER);
  (canRunPositive ? it : it.skip)("fetches a glyph's outline from the helper when fontkit hands back empty", () => {
    // Real Helvetica glyph id for 'H' (fontkit decodes it fine — we fake the
    // "empty" to exercise the fallback path the same way a partial font would).
    const col = fontkit2.openSync(HELVETICA) as any;
    const f = col.getFont != null ? col.getFont("Helvetica") : col;
    const hId = f.glyphForCodePoint(0x48).id;
    const fallback = commandsFor({ path: { commands: [] }, id: hId, codePoints: [0x48] }, "helvetica", 400, 16, 0);
    expect(fallback.length).toBeGreaterThan(0);            // the helper produced a real outline
    expect(fallback.some((c) => c.command === "moveTo")).toBe(true);
  });
});

// DM-892: the per-glyph helper fallback in EMBEDDED-FONT mode (the production
// default). Where paths-mode emits a `<path>`, embedded mode bakes the glyph
// into a synthesized TTF via `trackGlyphInEmbedFont`. Because the helper returns
// fontkit-shaped PathCommand[] and the builder already converts those into the
// TTF `glyf`, the fix is just routing the embedded glyph loop through
// `commandsFor`. These tests prove the resulting glyf is a real (non-empty)
// contour — i.e. the helper outline actually lands in the embedded font.
describe("embedded-font mode: per-glyph helper fallback (DM-892)", () => {
  beforeEach(() => { __clearGlyphFallbackCaches(); clearEmbeddedFonts(); });
  afterEach(() => { clearEmbeddedFonts(); });

  // Re-parse the single built TTF out of the @font-face CSS and return the
  // glyph fontkit resolves for `pua`.
  function builtGlyphForPua(pua: number): { path: { commands: Array<{ command: string }> } } {
    const css = getEmbeddedFontFaceCss();
    const b64 = /base64,([A-Za-z0-9+/=]+)"\)/.exec(css)?.[1];
    expect(b64).toBeTruthy();
    const ttf = fontkit.create(Buffer.from(b64!, "base64")) as any;
    return ttf.glyphForCodePoint(pua);
  }

  it("converts a helper-supplied outline (fontkit-shaped commands) into a non-empty TTF glyf", () => {
    // A box contour, the shape a helper would hand back for an inkable glyph
    // fontkit couldn't decode. trackGlyphInEmbedFont must bake it into the TTF.
    const helperCmds = [
      { command: "moveTo", args: [100, 0] },
      { command: "lineTo", args: [100, 700] },
      { command: "lineTo", args: [600, 700] },
      { command: "lineTo", args: [600, 0] },
      { command: "closePath", args: [] },
    ];
    const placement = trackGlyphInEmbedFont("dm892-fake|w=400|s=0", 1000, 800, -200, 42, helperCmds, 700);
    expect(placement).not.toBeNull();
    expect(builtGlyphForPua(placement!.puaCodepoint).path.commands.length).toBeGreaterThan(0);
  });

  // End-to-end on macOS: the exact chain a partial font triggers — fontkit
  // returns empty for an inkable glyph, `commandsFor` pulls the helper outline,
  // and it bakes into the embedded TTF as a real contour. Gated like DM-891.
  const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";
  const HELPER = "tools/macos-glyph-extractor/domotion-glyph-paths";
  const canRun = process.platform === "darwin" && existsSync(HELVETICA) && existsSync(HELPER);
  (canRun ? it : it.skip)("bakes the helper outline into the embedded TTF when fontkit hands back empty", () => {
    const col = fontkit2.openSync(HELVETICA) as any;
    const f = col.getFont != null ? col.getFont("Helvetica") : col;
    const h = f.glyphForCodePoint(0x48);
    // Fake the "empty" the same way the paths-mode DM-891 test does, then run
    // the production routing: commandsFor → helper outline → embedded TTF.
    const cmds = commandsFor({ path: { commands: [] }, id: h.id, codePoints: [0x48] }, "helvetica", 400, 16, 0);
    expect(cmds.length).toBeGreaterThan(0);
    const placement = trackGlyphInEmbedFont("dm892-helvetica|w=400|s=0", f.unitsPerEm, f.ascent, f.descent, h.id, cmds, h.advanceWidth);
    expect(placement).not.toBeNull();
    expect(builtGlyphForPua(placement!.puaCodepoint).path.commands.length).toBeGreaterThan(0);
  });
});

// Baseline placement: when CAPTURE_SCRIPT records the browser's
// canvas.measureText().fontBoundingBoxAscent on the element (DM-237), the
// renderer must use that value verbatim instead of computing ascent from
// fontkit's HHEA `font.ascent`. fontkit's HHEA is correct for SF Pro / SF Mono
// (where HHEA = winAscent) but ~5px too small at fontSize=32 for Helvetica
// and the other macOS legacy MS fonts (Arial, Times, Georgia, Menlo, Courier),
// where Chrome reads winAscent. Without the override, headings drift up by an
// amount proportional to font size.
describe("renderTextAsPath: ascentOverride threading", () => {
  // Extract the y-coordinate from the outer translate(x,y) on the returned
  // <g> markup. That y is the baseline anchor — exactly the value affected
  // by the override.
  const baselineY = (markup: string | null): number | null => {
    if (markup == null) return null;
    const m = /transform="translate\([^,]+,([^)]+)\)"/.exec(markup);
    return m != null ? parseFloat(m[1]) : null;
  };

  it.skipIf(!MACOS_FONTS)("uses ascentOverride verbatim for baselineY when provided", () => {
    const top = 100;
    const ascent = 30; // simulates Chrome's fontBoundingBoxAscent for fs=32 Helvetica bold
    const out = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000",
      undefined, undefined, undefined, undefined, ascent);
    expect(baselineY(out)).toBe(top + ascent);
  });

  it.skipIf(!MACOS_FONTS)("falls back to fontkit ascent when no override given", () => {
    const top = 100;
    // No override — falls back to round(font.ascent * scale). The exact value
    // depends on the resolved font; we just assert the answer is *different*
    // from a clearly-wrong override, so the test fails if both branches end
    // up using the same code.
    const native = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000");
    const overridden = renderTextAsPath("Hi", 0, top, 32, "Helvetica", "700", "#000",
      undefined, undefined, undefined, undefined, 30);
    expect(baselineY(native)).not.toBe(baselineY(overridden));
  });

  it.skipIf(!MACOS_FONTS)("scales the override correctly across font sizes", () => {
    // Same font, different sizes → override is applied verbatim, no extra math.
    const a = renderTextAsPath("Hi", 0, 0, 14, "Helvetica", "400", "#000",
      undefined, undefined, undefined, undefined, 13);
    const b = renderTextAsPath("Hi", 0, 0, 50, "Helvetica", "400", "#000",
      undefined, undefined, undefined, undefined, 47);
    expect(baselineY(a)).toBe(13);
    expect(baselineY(b)).toBe(47);
  });
});

describe("measureInkMetrics: MathML token ink positioning (DM-832)", () => {
  // The MathML `34-mathml-layout` fixture drifted vertically because token
  // elements (<mo>/<mi>/<mn>/<mtext>) were baseline-positioned with the font
  // ascent, while Chromium sizes each token's box to its glyph ink. These
  // tests lock the ink-metric helper the renderer now uses to split that box.

  it.skipIf(!MACOS_FONTS)("returns ink ascent/descent for an x-height letter", () => {
    const ink = measureInkMetrics("x", 22, "math", "400");
    expect(ink).not.toBeNull();
    expect(ink!.inkAscent).toBeGreaterThan(0);
    // 'x' rests on the baseline — descent is ~0 (sub-px), ascent ≈ x-height.
    expect(ink!.inkDescent).toBeLessThan(1);
    expect(ink!.inkAscent).toBeLessThan(22); // never exceeds the em
  });

  it.skipIf(!MACOS_FONTS)("measures a fallback-routed math operator, not null", () => {
    // ∑ (U+2211) is absent from Times (what `font-family: math` resolves to)
    // and routes to a fallback face. The helper must walk the SAME chain the
    // path emitter uses and still return the fallback glyph's ink — the whole
    // point of the fix. A null here would drop the renderer back to the font
    // ascent and re-introduce the operator drift.
    const ink = measureInkMetrics("∑", 22, "math", "400");
    expect(ink).not.toBeNull();
    expect(ink!.inkAscent).toBeGreaterThan(0);
  });

  it.skipIf(!MACOS_FONTS)("gives a taller ink box to ∑ than to an x-height letter", () => {
    const sum = measureInkMetrics("∑", 22, "math", "400")!;
    const ex = measureInkMetrics("x", 22, "math", "400")!;
    // ∑ spans well above and below the baseline; its total ink height must
    // exceed a lowercase x's. This is the signal that made the operator sit
    // ~5 px low under the old font-ascent baseline.
    expect(sum.inkAscent + sum.inkDescent).toBeGreaterThan(ex.inkAscent + ex.inkDescent);
  });

  it.skipIf(!MACOS_FONTS)("reports a real descent for a descender glyph", () => {
    // 'p' hangs below the baseline; 'o' does not. Descent ordering must hold
    // so the proportional baseline split places descenders correctly.
    const p = measureInkMetrics("p", 22, "math", "400")!;
    const o = measureInkMetrics("o", 22, "math", "400")!;
    expect(p.inkDescent).toBeGreaterThan(o.inkDescent);
  });

  it("returns null when nothing renders an outline", () => {
    // Whitespace shapes to a blank advance with no ink — no usable bbox.
    expect(measureInkMetrics(" ", 22, "math", "400")).toBeNull();
  });
});

describe("fallbackFontChain: box-drawing chars in monospace context (DM-780)", () => {
  // Box-drawing block (U+2500..U+259F) inside a <pre> / <code> / monospace
  // primary needs to stay at the monospace cell width to align with the
  // surrounding ASCII chars. Hiragino's em-wide glyphs (1.23× the mono cell)
  // overran the ASCII-art table in 02-text-preformatted's <pre>.
  it("routes box-drawing chars to the monospace primary when one is supplied", () => {
    // Courier (CSS `monospace` keyword on macOS) gets box chars from itself.
    expect(darwinFallbackChain(0x2500, "courier")).toEqual(["courier", "menlo", "hiragino-jp"]);
    expect(darwinFallbackChain(0x252C, "courier")).toEqual(["courier", "menlo", "hiragino-jp"]); // ┬
    expect(darwinFallbackChain(0x2534, "courier")).toEqual(["courier", "menlo", "hiragino-jp"]); // ┴
    expect(darwinFallbackChain(0x253C, "courier")).toEqual(["courier", "menlo", "hiragino-jp"]); // ┼
    // Author-named monospaces.
    expect(darwinFallbackChain(0x2500, "menlo")).toEqual(["menlo", "menlo", "hiragino-jp"]);
    expect(darwinFallbackChain(0x2500, "monaco")).toEqual(["monaco", "menlo", "hiragino-jp"]);
    expect(darwinFallbackChain(0x2500, "sf-mono")).toEqual(["sf-mono", "menlo", "hiragino-jp"]);
  });

  it("keeps Hiragino routing for non-monospace primaries", () => {
    // Helvetica / SF Pro / Times body text: Chrome paints box chars from
    // CoreText's Hiragino fallback at em-width (it's already off the mono
    // cell grid anyway), so hiragino-jp stays first.
    expect(darwinFallbackChain(0x2500)).toEqual(["hiragino-jp", "menlo"]);
    expect(darwinFallbackChain(0x2500, "helvetica")).toEqual(["hiragino-jp", "menlo"]);
    expect(darwinFallbackChain(0x2500, "sf-pro")).toEqual(["hiragino-jp", "menlo"]);
    expect(darwinFallbackChain(0x2500, "times")).toEqual(["hiragino-jp", "menlo"]);
  });
});

describe("fallbackFontChain: CJK/Hangul combining tone marks U+302A–U+302F (DM-1174)", () => {
  // Hiragino Sans GB (our `cjk`) does NOT carry U+302A–U+302F (the combining
  // CJK ideographic / Hangul tone marks). Without an Arial-Unicode fallback the
  // chain found no coverage and the orphaned mark dropped to the per-char
  // centering path, which stacked the mark ON the inserted U+25CC dotted circle
  // (the "soccer ball"). The route must append `u-arial-unicode-ms`, which
  // carries these marks AND U+25CC, so the DM-1215 dotted-circle HarfBuzz path
  // resolves coverage and lays the cluster as a spacing glyph like Chrome.
  it("appends Arial Unicode MS for the combining tone marks", () => {
    for (const cp of [0x302a, 0x302b, 0x302c, 0x302d, 0x302e, 0x302f]) {
      expect(darwinFallbackChain(cp)).toEqual(["cjk", "u-arial-unicode-ms"]);
    }
  });

  it("leaves the surrounding CJK Symbols & Punctuation on the plain Hiragino route", () => {
    // The narrow tone-mark window must NOT widen to the rest of the block — the
    // punctuation (、。「」（） …) is what Chrome paints from Hiragino.
    expect(darwinFallbackChain(0x3001)).toEqual(["cjk"]); // 、
    expect(darwinFallbackChain(0x3029)).toEqual(["cjk"]); // just below the window
    expect(darwinFallbackChain(0x3030)).toEqual(["cjk"]); // 〰 just above the window
  });
});

describe("renderRadicalGlyph: MathML msqrt/mroot radical sign (DM-897)", () => {
  // The radical was a uniform-stroke synthesized path that couldn't match the
  // stroke-weight contrast of Chrome's painted √ glyph. renderRadicalGlyph
  // fits the actual U+221A glyph to the captured radical box and extends the
  // overbar across the radicand.
  it.skipIf(!MACOS_FONTS)("emits a glyph <use> plus an overbar rect fitted to the box", () => {
    clearGlyphDefs();
    // x=261, top=680, height=22, width=24 — the √2 box from the fixture.
    const out = renderRadicalGlyph(261, 680, 22, 24, 22, "math", "400", "rgb(0,0,0)");
    expect(out).not.toBeNull();
    // The √ glyph is emitted as a <use> reference inside a scaled group.
    expect(out!).toContain("<use href=");
    expect(out!).toMatch(/scale\([^)]+\)/);
    // The overbar (vinculum) is a separate 1-px rule extending to the right.
    expect(out!).toContain("<rect");
    expect(out!).toContain('height="1"');
  });

  it.skipIf(!MACOS_FONTS)("omits the overbar when the radical box has no width past the glyph", () => {
    clearGlyphDefs();
    // A zero/degenerate width can't host a vinculum extension.
    const out = renderRadicalGlyph(261, 680, 22, 0, 22, "math", "400", "rgb(0,0,0)");
    expect(out).toBeNull(); // width <= 0 short-circuits
  });

  it("returns null for a non-positive box height", () => {
    expect(renderRadicalGlyph(0, 0, 0, 20, 22, "math", "400", "rgb(0,0,0)")).toBeNull();
  });
});

describe("fallbackFontChain: overline / macron over-accents (DM-896)", () => {
  // U+203E OVERLINE is the `<mo>` in a MathML `<mover accent="true">` mean bar
  // (x̄). `font-family: math` resolves to Times, which lacks U+203E, and the
  // General-Punctuation block had no fallback branch — so it painted a .notdef
  // tofu box. Chrome paints it via Helvetica (its U+203E advance matches the
  // captured `<mo>` width exactly), so the chain must lead with helvetica.
  it("routes U+203E overline and U+00AF macron to Helvetica first", () => {
    expect(darwinFallbackChain(0x203E, "times")).toEqual(["helvetica", "symbols"]);
    expect(darwinFallbackChain(0x00AF, "times")).toEqual(["helvetica", "symbols"]);
    // Must not be the empty chain that produced the tofu.
    expect(darwinFallbackChain(0x203E).length).toBeGreaterThan(0);
  });
});

describe("fallbackFontChain: Geometric/Misc Symbols routing (DM-324 / DM-326)", () => {
  // Chrome on macOS paints chars like ◉◌◐◑ (U+25C9..D1) and ☀☁☂☃ (U+2600..03)
  // at em-square width (18px @18px font-size). HiraginoSansGB-W3 (the "cjk"
  // key) lacks these glyphs entirely; HiraKakuProN-W3 (the "hiragino-jp"
  // key, regular Japanese Hiragino Sans) covers them at em-square width.
  // Without hiragino-jp in the chain the renderer falls all the way through
  // to Apple Symbols whose advances are 11-15px — visibly narrower than
  // Chrome's painted output.
  it("routes the U+25A0..25FF and U+2600..26FF blocks through hiragino-jp before symbols", () => {
    // Geometric Shapes block (U+25A0..25FF) — chars Chrome paints at em-square.
    // Note: ■ □ ● ○ ◆ ◇ are individually carved out to LucidaGrande first
    // (DM-349) because Chrome paints those at proportional 9-13px, not em-square.
    //
    // DM-988 routed the WHOLE block hiragino-jp (HiraKakuProN, Japanese) FIRST,
    // not cjk (HiraginoSansGB, Chinese) — GB paints these glyphs at a visibly
    // larger / differently-shaped em-square than ProN. DM-1030 re-verified via
    // CDP CSS.getPlatformFontsForNode at 32px sans-serif: U+25C9 ◉, U+2600 ☀,
    // U+2601 ☁ all return "Hiragino Sans" (= hiragino-jp), so hiragino-jp must
    // lead. `cjk` stays as the secondary for the chars HiraKakuProN lacks.
    expect(darwinFallbackChain(0x25C9)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x25CC)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x25D0)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x25D1)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    // Misc Symbols block (U+2600..26FF).
    expect(darwinFallbackChain(0x2600)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x2601)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x2602)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x2603)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    // Gender signs (U+2640 ♀ / U+2642 ♂) and the rest of the block now share
    // the same hiragino-jp-first chain (the old DM-925 carve-out is subsumed).
    expect(darwinFallbackChain(0x2640)).toEqual(["hiragino-jp", "cjk", "symbols"]);
    expect(darwinFallbackChain(0x26A5)).toEqual(["hiragino-jp", "cjk", "symbols"]);
  });

  it("routes ■ □ ● ○ ◆ ◇ through LucidaGrande (matches Chrome's narrow paint)", () => {
    // DM-349: empirical xOffset capture in 02-text-symbols showed Chrome
    // paints these at LucidaGrande's proportional advance (9.76 / 10.41 /
    // 13.01 / 11.07 px @18px), not at the em-square 18px Hiragino renders.
    // DM-415 / DM-429 verified this is still the closest visible-shape
    // match in our font set (tried SF NS / AppleSDGothicNeo, both produced
    // visibly larger glyphs than Chrome's painted ink).
    expect(darwinFallbackChain(0x25A0)).toEqual(["lucida-grande", "symbols"]); // ■
    expect(darwinFallbackChain(0x25A1)).toEqual(["lucida-grande", "symbols"]); // □
    expect(darwinFallbackChain(0x25CF)).toEqual(["lucida-grande", "symbols"]); // ●
    expect(darwinFallbackChain(0x25CB)).toEqual(["lucida-grande", "symbols"]); // ○
    expect(darwinFallbackChain(0x25C6)).toEqual(["lucida-grande", "symbols"]); // ◆
    expect(darwinFallbackChain(0x25C7)).toEqual(["lucida-grande", "symbols"]); // ◇
  });
});

describe("Primary-aware CJK fallback (DM-333)", () => {
  // CJK characters routing depends on the primary font's broad style: serif
  // primaries (Apple Times / Times New Roman / Georgia, plus the bare
  // generics that resolve to `times`) get serif CJK glyphs (Songti SC Light)
  // matching Chrome's painted output 100% pixel-exact at 16px on `font-
  // family: serif/fangsong/ui-serif`. Non-serif primaries keep the existing
  // HiraginoSansGB-W3 sans CJK route.
  it("returns ['cjk-serif', 'cjk'] when primary is times / times-new-roman / georgia", () => {
    expect(darwinFallbackChain(0x4E00, "times")).toEqual(["cjk-serif", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "times-new-roman")).toEqual(["cjk-serif", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "georgia")).toEqual(["cjk-serif", "cjk"]);
    // Hiragana / Katakana also go through the serif route.
    expect(darwinFallbackChain(0x3042, "times")).toEqual(["cjk-serif", "cjk"]);
    expect(darwinFallbackChain(0x30A2, "times")).toEqual(["cjk-serif", "cjk"]);
    // Hangul does NOT — DM-691 routes it to Apple SD Gothic Neo first
    // because neither HiraginoSansGB nor Songti contains Hangul codepoints.
    expect(darwinFallbackChain(0xAC00, "times")).toEqual(["korean", "cjk"]);
  });
  // DM-1117: an explicitly-named `Hiragino Mincho ProN` routes Han / kana to the
  // Mincho face first (it carries the `trad` / `fwid` / `jp78` East-Asian
  // features Songti lacks), falling back to the generic serif CJK then sans CJK.
  // The generic `serif` keyword still resolves to Songti (the case above).
  it("routes CJK through hiragino-mincho when the family is explicitly named (DM-1117)", () => {
    expect(resolveFontKey("Hiragino Mincho ProN")).toBe("hiragino-mincho");
    expect(resolveFontKey("Hiragino Mincho ProN, serif")).toBe("hiragino-mincho");
    expect(darwinFallbackChain(0x4E00, "hiragino-mincho")).toEqual(["hiragino-mincho", "cjk-serif", "cjk"]);
    expect(darwinFallbackChain(0x3042, "hiragino-mincho")).toEqual(["hiragino-mincho", "cjk-serif", "cjk"]);
    // The bare `serif` generic is unchanged — still Songti, not Mincho.
    expect(darwinFallbackChain(0x4E00, "times")).toEqual(["cjk-serif", "cjk"]);
  });
  it("routes Han Unified Ideographs through pingfang-sc → cjk for non-serif primaries (DM-388)", () => {
    // U+4F60 is in CJK Unified Ideographs (the 你 in 你好). Sans-serif primary
    // routes through PingFang SC (CoreText extractor) first to match what
    // Chrome paints, with HiraginoSansGB-W3 retained as the fontkit-readable
    // safety net for any glyph PingFang lacks. DM-382 / DM-364 / DM-388.
    expect(darwinFallbackChain(0x4F60, "helvetica")).toEqual(["pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "sf-pro")).toEqual(["pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "menlo")).toEqual(["pingfang-sc", "cjk"]);
    // No primaryKey arg → default sans behavior.
    expect(darwinFallbackChain(0x4F60)).toEqual(["pingfang-sc", "cjk"]);
  });
  it("keeps the bare ['cjk'] route for non-Han CJK ranges (Hiragana / Katakana)", () => {
    // PingFang routing applies only to Han Unified Ideographs + Ext A + CJK
    // Compatibility Ideographs. Hiragana (3040..309F) and Katakana
    // (30A0..30FF) are what HiraginoSansGB / Apple's Hiragino chain paints;
    // they don't go through PingFang.
    expect(darwinFallbackChain(0x3042, "helvetica")).toEqual(["cjk"]); // ぁ
    expect(darwinFallbackChain(0x30A2, "helvetica")).toEqual(["cjk"]); // ア
  });
  it("routes Hangul (Syllables + Jamo) through Apple SD Gothic Neo — DM-691", () => {
    // HiraginoSansGB / Songti / PingFang don't contain Hangul codepoints,
    // so the dedicated `korean` route is required to avoid tofu glyphs.
    expect(darwinFallbackChain(0xAC00, "helvetica")).toEqual(["korean", "cjk"]); // 가
    expect(darwinFallbackChain(0xD7A3, "helvetica")).toEqual(["korean", "cjk"]); // 힣
    expect(darwinFallbackChain(0x1100, "helvetica")).toEqual(["korean", "cjk"]); // ᄀ (Jamo)
  });
  it("routes Han through the lang-matching PingFang variant when lang is set (DM-394)", () => {
    // 你 is U+4F60 — Han ideograph.
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-TW")).toEqual(["pingfang-tc", "pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-Hant")).toEqual(["pingfang-tc", "pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-HK")).toEqual(["pingfang-hk", "pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-MO")).toEqual(["pingfang-mo", "pingfang-sc", "cjk"]);
    // zh-Hant-HK: region wins over script.
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-Hant-HK")).toEqual(["pingfang-hk", "pingfang-sc", "cjk"]);
    // Japanese: there's no PingFang JP — routes through Hiragino Kaku.
    expect(darwinFallbackChain(0x4F60, "helvetica", "ja")).toEqual(["hiragino-jp", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "ja-JP")).toEqual(["hiragino-jp", "cjk"]);
    // SC / unspecified / non-CJK lang → default PingFang SC.
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-CN")).toEqual(["pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "zh-Hans")).toEqual(["pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "en-US")).toEqual(["pingfang-sc", "cjk"]);
    expect(darwinFallbackChain(0x4F60, "helvetica", "")).toEqual(["pingfang-sc", "cjk"]);
  });
});

// Primary-only NFD canonical decomposition (DM-1080 / DM-1081). CJK compatibility
// ideographs (U+2F800–2FA1F etc.) have no cmap entry in most faces; Chrome's
// HarfBuzz shapes their canonical (NFD) form, but ONLY within the font already
// selected for the run. An earlier version searched the whole fallback chain for
// the canonical glyph, so it painted real Han where Chrome paints tofu (24 such
// over-render cells on the 2F800 fixture). These guard that the decomposition
// stays pinned to the run's PRIMARY font so it can't silently re-broaden.
describe("resolveFontForCodepoint: primary-only NFD decomposition (DM-1080)", () => {
  it.skipIf(!MACOS_FONTS)("never decomposes a CJK compat ideograph under a Latin primary that can't render the canonical", () => {
    // Helvetica covers neither the literal compat ideograph nor its canonical
    // Han form. Under the old full-chain search the canonical was found in a
    // deep CJK fallback face and decomposed anyway; primary-only must not.
    for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
      const r = __resolveFontForCodepointForTest(cp, "Helvetica");
      expect(r?.decomposed ?? false).toBe(false);
    }
  });

  it.skipIf(!MACOS_FONTS)("only ever resolves a decomposition within the primary font's own key", () => {
    // The defining invariant of the fix: any codepoint that decomposes must
    // resolve to the PRIMARY font's key, never a deeper chain font. A regression
    // to the whole-chain search would surface a chain key here.
    for (const family of ["Helvetica", "Hiragino Sans", "Songti SC"]) {
      const primaryKey = resolveFontKey(family);
      for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
        const r = __resolveFontForCodepointForTest(cp, family);
        if (r?.decomposed) expect(r.key).toBe(primaryKey);
      }
    }
  });

  it.skipIf(!MACOS_FONTS)("still decomposes within a CJK primary that DOES cover the canonical (NFD stays load-bearing)", () => {
    // Removing NFD entirely would tofu these. Hiragino Sans covers the canonical
    // Han of many 2F800 singletons, so decomposition must still fire there.
    let decomposed = 0;
    for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
      if (__resolveFontForCodepointForTest(cp, "Hiragino Sans")?.decomposed) decomposed++;
    }
    expect(decomposed).toBeGreaterThan(0);
  });
});

// DM-1083: the full-CSS-family-stack resolver. `resolveFontKey` collapses a
// computed `font-family` to one key; `resolveFontKeyChain` keeps the whole
// ordered list of resolvable keys — the set Chrome's FontFallbackIterator walks
// at the kFontFamily stage.
describe("resolveFontKeyChain: full CSS family stack (DM-1083)", () => {
  it("returns every resolvable family in CSS order, with resolveFontKey == chain[0]", () => {
    const chain = resolveFontKeyChain(`"Times New Roman", Georgia, sans-serif`);
    expect(chain).toEqual(["times-new-roman", "georgia", "helvetica"]);
    expect(resolveFontKey(`"Times New Roman", Georgia, sans-serif`)).toBe(chain[0]);
  });

  it("skips unresolved / generic-keyword names Chrome walks past, preserving order", () => {
    // DoesNotExist + the ui-* / -apple-system keywords resolve to nothing and
    // must NOT appear; the real families that follow them keep their order.
    expect(resolveFontKeyChain(`DoesNotExist, -apple-system, ui-monospace, Menlo, monospace`))
      .toEqual(["menlo", "courier"]);
  });

  it("dedupes families that collapse to the same key", () => {
    // serif and Times both map to `times`; the chain holds it once.
    expect(resolveFontKeyChain(`Times, serif`)).toEqual(["times"]);
  });

  it("is empty when nothing in the stack resolves (caller appends its own terminal)", () => {
    expect(resolveFontKeyChain(`-apple-system, ui-sans-serif`)).toEqual([]);
    // …while the first-match resolver still falls back to the Times default.
    expect(resolveFontKey(`-apple-system, ui-sans-serif`)).toBe("times");
  });
});

// DM-1083: the unified family-walk resolver (the shipped resolution path). For a
// cp the primary lacks, it walks the FULL declared stack (literal then in-font
// canonical decomposition per font) before the OS fallback — reaching later
// families a primary-only resolver drops, WITHOUT over-rendering into
// Chrome-unreachable faces. Validated empirically by
// tools/probe-2f800-facewalk.mjs (+cells via Arial Unicode MS decomposition,
// 0 over-paints, on the CJK-compat block).
describe("resolveFontForCodepoint: unified family-walk loop (DM-1083)", () => {
  // The CJK Compatibility Ideographs Supplement fixture's actual glyph-cell stack.
  const FIXTURE_STACK = `"Hiragino Sans","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;

  it.skipIf(!MACOS_FONTS)("covers strictly MORE 2F800 cells than the run's primary font alone supplies", () => {
    // The family-walk's whole point: cells the primary (Hiragino) can't supply
    // get picked up from later-declared families / OS fallback, so total coverage
    // must strictly exceed what resolves to the primary's own key.
    const primaryKey = resolveFontKey(FIXTURE_STACK);
    let covered = 0;
    let primarySupplied = 0;
    for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
      const r = __resolveFontForCodepointForTest(cp, FIXTURE_STACK);
      if (r?.covered) {
        covered++;
        if (r.key === primaryKey) primarySupplied++;
      }
    }
    expect(covered).toBeGreaterThan(primarySupplied);
  });

  it.skipIf(!MACOS_FONTS)("reaches a later-DECLARED family (Arial Unicode MS) via in-font decomposition — the DM-1083 win", () => {
    // The specific mechanism the primary-only resolver dropped: a CJK-compat
    // ideograph's canonical Han is covered by Arial Unicode MS (declared second),
    // reached by walking the stack and decomposing WITHIN that face. This must be
    // a declared family the cascade reaches — not the OS fallback.
    const arialUnicodeKey = resolveFontKey("Arial Unicode MS");
    let viaLaterFamily = 0;
    for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
      const r = __resolveFontForCodepointForTest(cp, FIXTURE_STACK);
      if (r?.covered && r.decomposed && r.key === arialUnicodeKey) viaLaterFamily++;
    }
    expect(viaLaterFamily).toBeGreaterThan(0);
  });

  it.skipIf(!MACOS_FONTS)("preserves the DM-1080 invariant: a Latin-only stack never over-renders a CJK-compat ideograph", () => {
    // The hazard the family-walk must not reintroduce: with no CJK family
    // DECLARED, the canonical Han is unreachable and Chrome paints tofu. The walk
    // only searches the declared stack, so it must stay uncovered here too.
    for (let cp = 0x2F800; cp <= 0x2F8FF; cp++) {
      const r = __resolveFontForCodepointForTest(cp, "Helvetica, Arial, sans-serif");
      // Helvetica/Arial cover neither the literal nor the canonical Han → no
      // declared family can supply it; only the OS fallback (system CJK face)
      // may, which is Chrome's behavior too. The invariant we assert is the
      // narrow DM-1080 one: no DECLARED-stack decomposition into a Latin face.
      if (r?.decomposed) expect(["helvetica", "arial"]).not.toContain(r.key);
    }
  });
});

describe("pingfangKeyForLang BCP-47 mapping (DM-394)", () => {
  it("maps Traditional Chinese region tags to TC", () => {
    expect(pingfangKeyForLang("zh-TW")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-tw")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-Hant")).toBe("pingfang-tc");
    expect(pingfangKeyForLang("zh-Hant-TW")).toBe("pingfang-tc"); // -tw region
  });
  it("maps Hong Kong / Macau region tags to HK / MO", () => {
    expect(pingfangKeyForLang("zh-HK")).toBe("pingfang-hk");
    expect(pingfangKeyForLang("zh-Hant-HK")).toBe("pingfang-hk"); // region beats script
    expect(pingfangKeyForLang("zh-MO")).toBe("pingfang-mo");
  });
  it("maps Japanese tags to hiragino-jp (no PingFang JP exists on macOS)", () => {
    expect(pingfangKeyForLang("ja")).toBe("hiragino-jp");
    expect(pingfangKeyForLang("ja-JP")).toBe("hiragino-jp");
  });
  it("returns null for SC / unspecified / non-CJK / empty (caller falls back to pingfang-sc)", () => {
    expect(pingfangKeyForLang("zh")).toBeNull();
    expect(pingfangKeyForLang("zh-CN")).toBeNull();
    expect(pingfangKeyForLang("zh-Hans")).toBeNull();
    expect(pingfangKeyForLang("zh-SG")).toBeNull(); // Singapore uses simplified
    expect(pingfangKeyForLang("en-US")).toBeNull();
    expect(pingfangKeyForLang("")).toBeNull();
    expect(pingfangKeyForLang(undefined)).toBeNull();
  });
  it("routes the symbol blocks serif-aware for serif primaries (DM-988)", () => {
    // ■ is one of the LucidaGrande-narrow carve-outs (DM-349), so it stays on
    // its dedicated chain regardless of primary.
    expect(darwinFallbackChain(0x25A0, "times")).toEqual(["lucida-grande", "symbols"]);
    // DM-988: for a SERIF primary the Geometric Shapes / Misc Symbols block
    // leads with the SERIF CJK font (cjk-serif = Songti SC) and the serif
    // primary itself, then the sans hiragino-jp / Apple Symbols residue —
    // Chrome's CoreText cascade for serif picks a serif/mincho face for these
    // (CDP at 32px serif: U+25C9 ◉, U+2600 ☀ → "Hiragino Mincho ProN"), so a
    // serif-led chain is correct here vs the sans hiragino-jp-first chain.
    expect(darwinFallbackChain(0x25C9, "times")).toEqual(["cjk-serif", "times", "hiragino-jp", "symbols"]);
    expect(darwinFallbackChain(0x2600, "times")).toEqual(["cjk-serif", "times", "hiragino-jp", "symbols"]);
    // Arrows ← → ↑ ↓ route to LucidaGrande regardless of primary (DM-405 —
    // Chrome paints these via LucidaGrande at every size 12 → 32 px).
    expect(darwinFallbackChain(0x2190, "times")).toEqual(["lucida-grande", "symbols"]);
  });
});

describe("Math Operators primary-font handling (DM-332)", () => {
  // U+2200..22FF math operators: Chrome on macOS paints chars Apple Times has
  // (≥ ≤ ≠ ≈ ± ÷ × − ∑ √ ∫ ∞) AT TIMES'S advance, NOT at Apple Symbols's. The
  // user's reported difference on ≥ traced to our renderer painting Apple
  // Symbols's ≥ glyph (id=599, advance=10.27px, ascending arrows-style shape)
  // while Chrome paints Apple Times's ≥ glyph (id=149, advance=8.78px, flat
  // baseline). Both glyphs share the same codepoint but the visual forms are
  // very different. STIX Two Math (the obvious candidate for `font-family:
  // math`) is NOT what Chrome uses for any of these operators — STIX advances
  // are 11.52px+ across the board, way wider than Chrome's 8.78px painted ≥.
  //
  // The fix is structural: `times` resolves to Apple Times.ttc (DM-330), which
  // has all of these operator glyphs. The renderer's primary-font-first logic
  // then picks them from Apple Times instead of falling through to the symbols
  // chain. So the `fallbackFontChain` for U+2200..22FF stays empty / unchanged
  // — it only fires when the primary lacks the codepoint (∀ ∇ ∂ ∈ ⊂ ∧ etc.).
  it("ui-serif / math / serif resolves to times (Apple Times has the common operators)", () => {
    // `font-family: math` falls through to the Times default (DM-269 +
    // DM-291), so the math-row primary is `times` which is Apple Times.
    expect(resolveFontKey("math")).toBe("times");
    expect(resolveFontKey("serif")).toBe("times");
    expect(resolveFontKey("ui-serif")).toBe("times");
  });
});

describe("fallbackFontChain: Arrows-block routing (DM-296 / DM-369 / DM-405 / DM-441)", () => {
  // ← → ↑ ↓ — Lucida Grande, per CDP `CSS.getPlatformFontsForNode` (DM-405).
  // Chrome paints these chunky filled arrows; Hiragino's thin outline visibly
  // diverges (DM-296 reverted by DM-405).
  it("routes ← → ↑ ↓ to LucidaGrande (matches Chrome's painted glyph shape)", () => {
    expect(darwinFallbackChain(0x2190)).toEqual(["lucida-grande", "symbols"]); // ←
    expect(darwinFallbackChain(0x2192)).toEqual(["lucida-grande", "symbols"]); // →
    expect(darwinFallbackChain(0x2191)).toEqual(["lucida-grande", "symbols"]); // ↑
    expect(darwinFallbackChain(0x2193)).toEqual(["lucida-grande", "symbols"]); // ↓
  });

  // ↗ ↙ — DM-981 re-probed the misc arrows U+2194..U+2199 per-codepoint via
  // CDP at 32px sans-serif and unified them on ["hiragino-jp", "korean",
  // "lucida-grande", "symbols"] (the chain walker picks the first face that
  // carries each glyph). ↗ U+2197 and ↙ U+2199 -> Hiragino Sans (JP) =
  // hiragino-jp. DM-1030 re-verified via CDP: both return "Hiragino Sans".
  // (Lucida Grande lacks ↗ ↙, so it sits later in the chain for ↖ ↘ which it
  // does carry.)
  it("routes ↗ ↙ to Hiragino Sans (JP) per the unified misc-arrows chain", () => {
    expect(darwinFallbackChain(0x2197)).toEqual(["hiragino-jp", "korean", "lucida-grande", "symbols"]); // ↗
    expect(darwinFallbackChain(0x2199)).toEqual(["hiragino-jp", "korean", "lucida-grande", "symbols"]); // ↙
  });

  // ↑ ↓ are not at CJK em-square width and not at Apple Symbols' narrow
  // width either — Chrome paints them via LucidaGrande at 14.19px @22px.
  // DM-369: confirmed via fontkit advance probe (LucidaGrande U+2191 id=926
  // = 14.19px, U+2193 id=928 = 14.19px) matching the bounding box that
  // Range.getBoundingClientRect captures from Chrome.
  it("routes ↑ ↓ to LucidaGrande (matches Chrome's painted width)", () => {
    expect(darwinFallbackChain(0x2191)).toEqual(["lucida-grande", "symbols"]);
    expect(darwinFallbackChain(0x2193)).toEqual(["lucida-grande", "symbols"]);
  });

  // The misc-arrow (U+2194..2199, DM-981) and double-arrow (U+21D0..21D5,
  // DM-978) carve-outs now lead with hiragino-jp — Chrome paints them via
  // Hiragino Sans (JP), not Apple Symbols (whose glyphs are thinner / too
  // narrow). DM-1030 re-verified via CDP at 32px sans-serif: ↔ U+2194,
  // ⇒ U+21D2, ⇔ U+21D4 all return "Hiragino Sans". Apple Symbols stays as the
  // residue fallback at the end of each chain. The double-arrow chain uses
  // `menlo` (not lucida-grande) as the mid-tier because ⇕ U+21D5 -> Menlo.
  it("routes ↔ ⇒ ⇔ to Hiragino Sans, Apple Symbols as residue", () => {
    expect(darwinFallbackChain(0x2194)).toEqual(["hiragino-jp", "korean", "lucida-grande", "symbols"]);
    expect(darwinFallbackChain(0x21D2)).toEqual(["hiragino-jp", "korean", "menlo", "symbols"]);
    expect(darwinFallbackChain(0x21D4)).toEqual(["hiragino-jp", "korean", "menlo", "symbols"]);
  });
});

// DM-1030: well-formedness guard for the darwin chain. The four symbol/arrow
// routing tests above went stale when DM-978 / DM-981 / DM-988 recalibrated the
// chains (the per-codepoint EXPECTATIONS are inherently coupled to Chrome's
// paint and must be re-probed when they change). This guard is the part that
// CAN be checked structurally without a live browser: every key a chain emits
// must resolve to a real on-disk font spec, and the symbol/arrow/geometric
// blocks must never produce an EMPTY chain. A dangling/typo'd key (the silent
// failure mode — the renderer drops to no-font and paints tofu) is caught here
// even when the per-codepoint expectation tests aren't updated.
describe("darwinFallbackChain well-formedness (DM-1030)", () => {
  it("every emitted font key resolves to a real font spec", () => {
    const keys = new Set<string>();
    // Sweep the symbol / arrow / geometric / technical ranges plus a sample of
    // every script block that has a dedicated route.
    for (let cp = 0x2000; cp <= 0x2BFF; cp++) {
      for (const k of darwinFallbackChain(cp)) keys.add(k);
      for (const primary of ["times", "courier"]) for (const k of darwinFallbackChain(cp, primary)) keys.add(k);
    }
    for (const cp of [0x4E00, 0x3041, 0x30A1, 0xAC00, 0x1100, 0x0900, 0x0E00, 0x0600, 0x0590, 0x1D400, 0x20000, 0x2F800]) {
      for (const k of darwinFallbackChain(cp)) keys.add(k);
    }
    // `last-resort` is a synthetic terminal (bundled LastResort font), not a
    // FONT_PATHS entry — exempt it. Every other key must resolve. Resolve against
    // the darwin table directly (not the host-platform resolver) so this guard
    // runs identically on Linux CI — `darwinFallbackChain` emits darwin-only
    // `u-...` routes that `LINUX_FONT_PATHS` deliberately doesn't carry.
    const unresolved = [...keys].filter((k) => k !== "last-resort" && __resolveDarwinFontSpecForTest(k) == null);
    expect(unresolved).toEqual([]);
  });

  it("never returns an empty chain for the symbol / arrow / geometric blocks", () => {
    for (const [lo, hi] of [[0x2190, 0x21FF], [0x2500, 0x25FF], [0x2600, 0x26FF], [0x2700, 0x27BF]]) {
      for (let cp = lo; cp <= hi; cp++) {
        expect(darwinFallbackChain(cp).length).toBeGreaterThan(0);
      }
    }
  });
});

// DM-259 / DM-842: the Linux chain is a separate calibration (Chromium-on-Linux
// in the Playwright noble image — Liberation / WenQuanYi / FreeFont / Loma).
// These test `linuxFallbackChain` directly so they run identically on any host
// (the CI suite runs on Linux, but a dev's macOS run must cover it too).
describe("linuxFallbackChain: Chromium-on-Linux calibration (DM-259)", () => {
  it("routes the symbol/arrow/box blocks to the image's real faces", () => {
    expect(linuxFallbackChain(0x2500, "courier")).toEqual(["courier", "cjk"]);   // box-drawing, mono primary
    expect(linuxFallbackChain(0x2500)).toEqual(["helvetica", "cjk"]);            // box-drawing, sans primary
    expect(linuxFallbackChain(0x25A0)).toEqual(["helvetica", "cjk"]);            // geometric → Liberation Sans
    expect(linuxFallbackChain(0x2190)).toEqual(["helvetica", "free-sans"]);      // ← → Liberation Sans
    expect(linuxFallbackChain(0x2197)).toEqual(["cjk", "helvetica"]);            // ↗ diagonal → WenQuanYi
    expect(linuxFallbackChain(0x2702)).toEqual(["free-sans", "free-serif"]);     // dingbat → FreeSans
    expect(linuxFallbackChain(0x1D400)).toEqual(["free-sans", "free-serif"]);    // Math Alpha → FreeFont
  });

  it("routes CJK / Indic / RTL to the image's lang faces", () => {
    expect(linuxFallbackChain(0x4E00)).toEqual(["cjk"]);          // Han → WenQuanYi
    expect(linuxFallbackChain(0xAC00)).toEqual(["cjk"]);          // Hangul → WenQuanYi
    expect(linuxFallbackChain(0x0628)).toEqual(["sf-arabic"]);    // Arabic → FreeSerif
    expect(linuxFallbackChain(0x0928)).toEqual(["devanagari"]);   // Devanagari → FreeSans
    expect(linuxFallbackChain(0x0E01)).toEqual(["thai"]);         // Thai → Loma
    expect(linuxFallbackChain(0x05D0)).toEqual(["helvetica"]);    // Hebrew → Liberation Sans
  });
});

// These test `win32FallbackChain` directly so they run identically on any host
// (the win32 chain is exercised only on windows-latest CI otherwise). DM-836.
describe("win32FallbackChain: Chromium-on-Windows calibration (DM-836)", () => {
  it("routes symbol/math/geometric/box/arrow blocks to Arial (Chromium paints them there)", () => {
    // Probe-proven: Chromium-on-Windows paints these in Arial itself, not a
    // dedicated symbol face — so `helvetica` (Arial) leads, Segoe UI Symbol /
    // Cambria Math only mop up the residue.
    expect(win32FallbackChain(0x2211)).toEqual(["helvetica", "stix-math"]);   // ∑ math operator
    expect(win32FallbackChain(0x25A0)).toEqual(["helvetica", "symbols"]);     // ■ geometric
    expect(win32FallbackChain(0x2190)).toEqual(["helvetica", "symbols"]);     // ← arrow
    expect(win32FallbackChain(0x2500)).toEqual(["helvetica", "symbols"]);     // ─ box-drawing, sans primary
    expect(win32FallbackChain(0x2500, "menlo")).toEqual(["menlo", "sf-mono"]); // box-drawing, mono primary → Consolas
    expect(win32FallbackChain(0x2702)).toEqual(["symbols"]);                  // ✂ dingbat → Segoe UI Symbol
  });

  it("routes Math-Alphanumeric to Cambria Math", () => {
    expect(win32FallbackChain(0x1D400)).toEqual(["stix-math", "helvetica"]);  // 𝐀 → Cambria Math
  });

  it("routes CJK / Hangul / RTL / Indic / Thai to the Windows system faces", () => {
    expect(win32FallbackChain(0x4E00)).toEqual(["cjk"]);                      // Han → Microsoft YaHei
    expect(win32FallbackChain(0x4E00, undefined, "ja")).toEqual(["hiragino-jp", "cjk"]); // Han, ja → Yu Gothic
    expect(win32FallbackChain(0x4E00, "times")).toEqual(["cjk-serif", "cjk"]); // Han, serif → SimSun
    expect(win32FallbackChain(0xAC00)).toEqual(["korean", "cjk"]);            // Hangul → Malgun Gothic
    expect(win32FallbackChain(0x0628)).toEqual(["sf-arabic"]);               // Arabic → Segoe UI
    expect(win32FallbackChain(0x05D0)).toEqual(["sf-hebrew"]);               // Hebrew → Segoe UI
    expect(win32FallbackChain(0x0928)).toEqual(["devanagari"]);             // Devanagari → Nirmala UI
    expect(win32FallbackChain(0x0E01)).toEqual(["tahoma", "thai"]);         // Thai → Tahoma (painted-font confirmed)
  });
});

// DM-987: the generated Windows per-Unicode-block routing — produced by a Chrome
// CDP `CSS.getPlatformFontsForNode` sweep on a Windows 11 host (DirectWrite),
// resolved to C:\Windows\Fonts faces by tools/probe-983-genroutes-win32.mjs. The
// table is consulted as a LAST resort by `win32FallbackChain`. These tests are
// host-independent (the chain is a pure function; file paths only resolve on a
// real Windows box, validated separately on the VM where each `u-...` key's font
// extracts a real glyph for a codepoint in its block).
describe("win32 generated Unicode-block routing well-formedness (DM-987)", () => {
  it("ranges are sorted by start and non-overlapping", () => {
    for (let i = 1; i < UNICODE_FONT_RANGES_WIN32.length; i++) {
      const prev = UNICODE_FONT_RANGES_WIN32[i - 1]!;
      const cur = UNICODE_FONT_RANGES_WIN32[i]!;
      expect(cur[0]).toBeGreaterThan(prev[1]); // strictly after the previous range's end
      expect(cur[1]).toBeGreaterThanOrEqual(cur[0]); // well-formed [start, end]
    }
  });

  it("every range's fontKey resolves to a file entry, and every file name is non-empty", () => {
    for (const [, , key] of UNICODE_FONT_RANGES_WIN32) {
      const entry = UNICODE_FONT_FILES_WIN32[key];
      expect(entry, `range key ${key} missing from UNICODE_FONT_FILES_WIN32`).toBeDefined();
      expect(entry!.file.length).toBeGreaterThan(0);
    }
  });

  it("win32FallbackChain now routes tail scripts that the hand-coded rules don't cover", () => {
    // Each of these returned [] before DM-987 (no hand-coded rule, no generated
    // table) — i.e. tofu. They now route to the swept DirectWrite face.
    const tail: Array<[number, string]> = [
      [0x1208, "u-ebrima"],              // Ethiopic → Ebrima
      [0x13A0, "u-gadugi"],              // Cherokee → Gadugi
      [0xA000, "u-microsoft-yi-baiti"],  // Yi → Microsoft Yi Baiti
      [0x1000, "u-myanmar-text"],        // Myanmar → Myanmar Text
      [0x0F40, "u-microsoft-himalaya"],  // Tibetan → Microsoft Himalaya
      [0x10300, "u-segoe-ui-historic"],  // Old Italic → Segoe UI Historic
      [0x12000, "u-segoe-ui-historic"],  // Cuneiform → Segoe UI Historic
      [0x20000, "u-simsun-extb"],        // CJK Ext B → SimSun-ExtB
      [0x0780, "u-mv-boli"],             // Thaana → MV Boli
      [0xA840, "u-microsoft-phagspa"],   // Phags-pa → Microsoft PhagsPa
    ];
    for (const [cp, key] of tail) {
      const chain = win32FallbackChain(cp);
      expect(chain.length, `U+${cp.toString(16)} should route, not tofu`).toBeGreaterThan(0);
      expect(chain).toEqual([key]);
    }
  });

  it("hand-coded rules still win over the generated table where they overlap", () => {
    // Han / Hangul / Arabic / Devanagari have dedicated hand-coded routes; the
    // generated last-resort lookup must not override them.
    expect(win32FallbackChain(0x4E00)).toEqual(["cjk"]);        // Han, not a u-... key
    expect(win32FallbackChain(0xAC00)).toEqual(["korean", "cjk"]);
    expect(win32FallbackChain(0x0628)).toEqual(["sf-arabic"]);
    expect(win32FallbackChain(0x0928)).toEqual(["devanagari"]);
  });
});

// DM-842: the public `fallbackFontChain` dispatches by process.platform. Confirm
// it routes to the right per-platform implementation on the current host so the
// platform split itself is regression-guarded.
describe("fallbackFontChain: platform dispatch (DM-842)", () => {
  it("dispatches to the host platform's chain", () => {
    const expected = process.platform === "linux"
      ? linuxFallbackChain(0x2500, "courier")
      : process.platform === "win32"
        ? win32FallbackChain(0x2500, "courier")
        : darwinFallbackChain(0x2500, "courier");
    expect(fallbackFontChain(0x2500, "courier")).toEqual(expected);
  });
});

// Mathematical Alphanumeric Symbols (U+1D400–1D7FF) decomposition. On Linux
// the system math faces lack the U+1D4xx block entirely, so Chromium paints
// these by synthesizing from the base Latin/Greek letter; mathAlphaToBase
// reverses the capture's mathvariant mapping so the renderer can do the same.
// Pure mapping — host-platform-independent.
describe("mathAlphaToBase: Math-Alphanumeric decomposition (DM-838)", () => {
  it("decomposes the Latin italic block (the capture's <mi> mapping)", () => {
    expect(mathAlphaToBase(0x1d434)).toEqual({ base: 0x41, bold: false, italic: true }); // 𝐴 → A
    expect(mathAlphaToBase(0x1d44e)).toEqual({ base: 0x61, bold: false, italic: true }); // 𝑎 → a
    expect(mathAlphaToBase(0x1d467)).toEqual({ base: 0x7a, bold: false, italic: true }); // 𝑧 → z
    // The italic small-h slot is unassigned; the capture emits U+210E (ℎ).
    expect(mathAlphaToBase(0x210e)).toEqual({ base: 0x68, bold: false, italic: true });  // ℎ → h
  });

  it("decomposes the Greek italic block including nabla and symbol variants", () => {
    expect(mathAlphaToBase(0x1d6e2)).toEqual({ base: 0x391, bold: false, italic: true });  // 𝛢 → Α
    expect(mathAlphaToBase(0x1d6fc)).toEqual({ base: 0x3b1, bold: false, italic: true });  // 𝛼 → α
    expect(mathAlphaToBase(0x1d714)).toEqual({ base: 0x3c9, bold: false, italic: true });  // 𝜔 → ω
    expect(mathAlphaToBase(0x1d6fb)).toEqual({ base: 0x2207, bold: false, italic: true }); // 𝛻 → ∇
    expect(mathAlphaToBase(0x1d715)).toEqual({ base: 0x2202, bold: false, italic: true }); // 𝜕 → ∂
    expect(mathAlphaToBase(0x1d716)).toEqual({ base: 0x3f5, bold: false, italic: true });  // 𝜖 → ϵ
    expect(mathAlphaToBase(0x1d71b)).toEqual({ base: 0x3d6, bold: false, italic: true });  // 𝜛 → ϖ
  });

  it("carries the bold / bold-italic / sans-serif style toggles", () => {
    expect(mathAlphaToBase(0x1d400)).toEqual({ base: 0x41, bold: true,  italic: false }); // 𝐀 bold A
    expect(mathAlphaToBase(0x1d468)).toEqual({ base: 0x41, bold: true,  italic: true });  // 𝑨 bold-italic A
    expect(mathAlphaToBase(0x1d5a0)).toEqual({ base: 0x41, bold: false, italic: false }); // 𝖠 sans A
    expect(mathAlphaToBase(0x1d622)).toEqual({ base: 0x61, bold: false, italic: true });  // 𝘢 sans italic a
    expect(mathAlphaToBase(0x1d670)).toEqual({ base: 0x41, bold: false, italic: false }); // 𝙰 mono A
  });

  it("decomposes the bold / sans digit blocks", () => {
    expect(mathAlphaToBase(0x1d7ce)).toEqual({ base: 0x30, bold: true,  italic: false }); // 𝟎 bold 0
    expect(mathAlphaToBase(0x1d7ff)).toEqual({ base: 0x39, bold: false, italic: false }); // 𝟿 mono 9
    expect(mathAlphaToBase(0x1d7e2)).toEqual({ base: 0x30, bold: false, italic: false }); // 𝟢 sans 0
  });

  it("returns null for the script/fraktur/double-struck styles and non-math codepoints", () => {
    expect(mathAlphaToBase(0x1d49c)).toBeNull(); // 𝒜 script A — distinct typeface, not synthesizable
    expect(mathAlphaToBase(0x1d504)).toBeNull(); // 𝔄 fraktur A
    expect(mathAlphaToBase(0x1d538)).toBeNull(); // 𝔸 double-struck A
    expect(mathAlphaToBase(0x1d7d8)).toBeNull(); // 𝟘 double-struck digit 0
    expect(mathAlphaToBase(0x0061)).toBeNull();  // plain 'a'
    expect(mathAlphaToBase(0x1d800)).toBeNull(); // just past the block
  });
});

// MathML stretchy fence operators (DM-874). A `<mo>` whose text is a single
// bracket/paren/brace is painted by Chromium centered on the math axis and
// stretched to wrap its content; renderStretchyFenceGlyph fits the glyph to the
// captured `<mo>` element box instead of placing it on the text baseline.
describe("isStretchyFenceChar: MathML fence detection (DM-874)", () => {
  it("recognizes bracket/paren/brace fence chars", () => {
    for (const c of ["(", ")", "[", "]", "{", "}", "|", "‖", "⌈", "⌋", "⟨", "⟩"]) {
      expect(isStretchyFenceChar(c)).toBe(true);
    }
    expect(isStretchyFenceChar(" ( ")).toBe(true); // trims surrounding whitespace
  });
  it("rejects non-fence operators, letters, and multi-char strings", () => {
    for (const c of ["+", "=", "·", "-", "a", "2", "𝑎", "()", "", "  "]) {
      expect(isStretchyFenceChar(c)).toBe(false);
    }
  });
});

describe("renderStretchyFenceGlyph: fit fence to captured box (DM-874)", () => {
  beforeEach(() => { clearGlyphDefs(); setRenderTextMode("paths"); });

  it("emits a glyph <use> scaled and translated into the captured box", () => {
    const out = renderStretchyFenceGlyph("(", 10, 30, 20, 22, "sans-serif", "400", "rgb(0,0,0)");
    // Skips when the host has no resolvable font for '(' — but every supported
    // platform's sans-serif covers it, so this should render here.
    expect(out).not.toBeNull();
    expect(out).toContain("<use href=");
    expect(out).toMatch(/scale\([-0-9.]+,[-0-9.]+\)/);
    expect(out).toContain('fill="rgb(0,0,0)"');
  });

  it("stretches vertically with the box height (taller box → larger |sy|) while x-scale stays natural", () => {
    const short = renderStretchyFenceGlyph("(", 0, 0, 20, 22, "sans-serif", "400", "#000");
    const tall = renderStretchyFenceGlyph("(", 0, 0, 60, 22, "sans-serif", "400", "#000");
    expect(short).not.toBeNull();
    expect(tall).not.toBeNull();
    const parse = (s: string) => {
      const m = /scale\(([-0-9.]+),([-0-9.]+)\)/.exec(s)!;
      return { sx: parseFloat(m[1]), sy: Math.abs(parseFloat(m[2])) };
    };
    const a = parse(short!);
    const b = parse(tall!);
    // Horizontal scale is the natural fontSize/em — independent of box height.
    expect(a.sx).toBeCloseTo(b.sx, 4);
    // Vertical scale grows ~3x when the box is 3x taller (the stretch).
    expect(b.sy / a.sy).toBeCloseTo(3, 1);
  });

  it("returns null for an empty or zero-height request (caller falls back to baseline text)", () => {
    expect(renderStretchyFenceGlyph("", 0, 0, 20, 22, "sans-serif", "400", "#000")).toBeNull();
    expect(renderStretchyFenceGlyph("(", 0, 0, 0, 22, "sans-serif", "400", "#000")).toBeNull();
  });
});

describe("ligature handling with captured xOffsets (DM-287 / DM-331)", () => {
  // When font.layout fires ligatures (Helvetica fi/fl, Apple Chancery Th/th),
  // the layout glyph count is shorter than the input text length. The
  // renderer must walk the layout's actual glyph stream — anchoring each
  // cluster at its first codepoint's xOffset — instead of either re-shaping
  // per-char (which loses the ligature glyph) or falling back to native
  // advances (which loses Chrome's captured xOffsets). DM-287 was the
  // original justify-spacing bug; DM-331 was Apple Chancery painting
  // disconnected per-char Th/th instead of the connected ligature glyphs.
  it.skipIf(!MACOS_FONTS)("emits ligature glyphs when font.layout collapses chars (Apple Chancery Th/th)", () => {
    // 43-char text with two Apple Chancery ligatures: Th at start, th in
    // "the lazy". Chrome captures 43 per-char xOffsets but font.layout
    // returns 41 glyphs. Each of the 2 ligature clusters covers 2
    // codepoints; per Chrome each is anchored at the first char's xOffset.
    const text = "The quick brown fox jumps over the lazy dog";
    const xOffsets: number[] = [];
    // Spread chars at 8px each — exact values don't matter for this test, we
    // just need length === text.length so the ligature path activates.
    for (let i = 0; i < text.length; i++) xOffsets.push(i * 8);
    const out = renderTextAsPath(
      text, 0, 0, 16, "cursive", "400", "#000",
      undefined, undefined, xOffsets,
    );
    expect(out).not.toBeNull();
    // Apple Chancery's Th ligature is glyph id=343, th ligature id=338,
    // and per-char e is id=72. We expect to see exactly one <use> referencing
    // each ligature glyph (anchored at xOffsets[0] = 0 and xOffsets[31] =
    // 248 / scale respectively, but we don't pin the exact tx — just that
    // the ligature glyph defs are present).
    const useCount = (out!.match(/<use href="#g\d+"/g) ?? []).length;
    // 43 chars - 8 spaces - 2 ligature collapses (Th, th) = 33 emitted uses.
    expect(useCount).toBe(33);
  });
});

describe("Emoji codepoints suppress .notdef tofu emission (DM-334)", () => {
  // When a codepoint is one Chrome paints via Apple Color Emoji (✨ 😀 🚀
  // 🌟 🎉 etc.), neither Times nor Apple Symbols nor Zapf Dingbats has a
  // glyph in their path tables — they all return id=0 (the hollow-rectangle
  // .notdef tofu). The capture layer screenshots the page and stamps a
  // raster <image> overlay at the emoji's painted rect, so the path
  // pipeline's tofu rectangle is redundant; emitting it leaves a black
  // silhouette around the edges of the emoji where the raster has
  // sub-pixel transparency. Verify that for emoji codepoints the path
  // pipeline emits NO `<use>` element (the only renderable would be the
  // tofu, and that's now suppressed).
  it("emits no <use> for U+2728 ✨ (Dingbats emoji-presentation)", () => {
    // Render just "✨" with a captured xOffset. Primary=Times → no glyph.
    // Chain is ["zapf-dingbats", "symbols"] — neither has ✨, so picked
    // would be the chain's last entry (symbols) producing tofu. With the
    // emoji-codepoint suppression, the markup is empty and
    // renderTextAsPath returns null (no <g> wrapper for empty content).
    const out = renderTextAsPath(
      "✨", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0],
    );
    expect(out).toBeNull();
  });
  it("emits no <use> for U+1F600 😀 / U+1F680 🚀 (main emoji blocks)", () => {
    const out = renderTextAsPath(
      "😀🚀", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0, 0, 18, 18],
    );
    expect(out).toBeNull();
  });
  it.skipIf(!MACOS_FONTS)("emits text-but-no-emoji-tofu in mixed runs (Smile 😀)", () => {
    // Mixed text: "Smile 😀" — the "Smile " chars emit Times glyphs, the
    // 😀 codepoint suppresses its tofu. Without the suppression we'd see
    // 7 <use>s (S, m, i, l, e, space, tofu); with it we see 6 (no tofu).
    const out = renderTextAsPath(
      "Smile 😀", 0, 0, 16, "Times", "400", "#000",
      undefined, undefined, [0, 9, 18, 22, 26, 30, 34, 34],
    );
    expect(out).not.toBeNull();
    const useCount = (out!.match(/<use href="#g\d+"/g) ?? []).length;
    expect(useCount).toBe(6);
  });
});

describe("synthesized small-caps (DM-294)", () => {
  // Helvetica/Arial/SF Pro/Times/Georgia all lack the OpenType `smcp` feature,
  // so `font-variant: small-caps` triggers Chrome's synthesized-small-caps
  // path: lowercase letters render as uppercase glyphs at ~0.7× the font
  // size, while uppercase letters stay at full size. The renderer mirrors
  // this when it sees `features: ['smcp']` and the font lacks the feature.
  it.skipIf(!MACOS_FONTS)("renders lowercase letters as uppercase glyphs at the small-cap scale", () => {
    // Render "abc" at 16px Helvetica with smcp.
    const out = renderTextAsPath(
      "abc", 0, 0, 16, "Helvetica", "400", "#000",
      undefined, undefined, [0, 8, 16], undefined, undefined, ["smcp"],
    );
    expect(out).not.toBeNull();
    // Synth path emits one <g transform="translate(x,0) scale(s,-s)"> per
    // char. With SMALL_CAP_SCALE = 0.7 and 16/2048 unit scale, the per-char
    // scale is 16/2048 * 0.7 ≈ 0.00547. Confirm that we see the small-cap
    // scale on each <g> (not the full-size 0.00781).
    const matches = out!.match(/scale\(([^,]+),/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // Outer scale on the wrapper <g transform="translate(x,baselineY)"> is
    // 1, so we look at the inner per-char scales (4 total: 1 outer + 3 char).
    // Each should be ≈ 0.00547 (small-cap), not 0.00781 (full).
    const charScales = matches.slice(1, 4).map((m) => parseFloat(m.replace(/scale\(/, "")));
    for (const s of charScales) {
      expect(s).toBeCloseTo(16 / 2048 * 0.7, 3);
    }
  });

  it.skipIf(!MACOS_FONTS)("keeps uppercase letters at full size in a smcp run", () => {
    // "ABC" all uppercase — synth path must NOT shrink them.
    const out = renderTextAsPath(
      "ABC", 0, 0, 16, "Helvetica", "400", "#000",
      undefined, undefined, [0, 10, 20], undefined, undefined, ["smcp"],
    );
    expect(out).not.toBeNull();
    const matches = out!.match(/scale\(([^,]+),/g) ?? [];
    const charScales = matches.slice(1, 4).map((m) => parseFloat(m.replace(/scale\(/, "")));
    for (const s of charScales) {
      expect(s).toBeCloseTo(16 / 2048, 3);
    }
  });
});

describe("resolveFontKey: chain walking", () => {
  it("picks the first recognized name in the stack", () => {
    expect(resolveFontKey('"DoesNotExist", monospace')).toBe("courier");
    expect(resolveFontKey("DoesNotExist, Helvetica, sans-serif")).toBe("helvetica");
    expect(resolveFontKey("Menlo, Consolas, monospace")).toBe("menlo");
  });

  it("falls through to Times when nothing matches (Chrome's macOS Standard Font default)", () => {
    // DM-269: probed Chrome — body with no font-family computes to "Times",
    // and elements declaring an unrecognized family chain fall through to
    // the same Standard Font default. Previously this was Helvetica which
    // was wrong for serif default contexts.
    expect(resolveFontKey("Nothing-Installed-1, Nothing-Installed-2")).toBe("times");
    expect(resolveFontKey("")).toBe("times");
  });
});

describe("getDecorationMetrics: Chrome auto-thickness rule (DM-398)", () => {
  // Empirical formula tuned for SVG rasterization (NOT Chromium's source
  // formula `fontSize / 10` — that one is theoretically correct but produces
  // worse visual match against Chrome'\\'s HTML render due to the SVG-vs-HTML
  // rasterization gap documented in DM-418).
  it("uses 1px stroke for body sizes (≤ 19px)", () => {
    expect(getDecorationMetrics("Helvetica", 12, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 14, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 16, "400").underlineThickness).toBe(1);
    expect(getDecorationMetrics("Helvetica", 18, "400").underlineThickness).toBe(1);
  });

  it("bumps to 2px stroke at heading sizes (≥ 20px)", () => {
    expect(getDecorationMetrics("Helvetica", 22, "400").underlineThickness).toBe(2);
    expect(getDecorationMetrics("Helvetica", 24, "400").underlineThickness).toBe(2);
    expect(getDecorationMetrics("Helvetica", 32, "400").underlineThickness).toBe(2);
  });

  it("emits underlineOffsetY = 1.5 × thickness", () => {
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.underlineOffsetY).toBe(1.5);
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.underlineOffsetY).toBe(3);
  });

  it("emits strikeoutOffsetY ≈ fontSize/3 above baseline", () => {
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.strikeoutOffsetY).toBe(Math.round(14 / 3) + 0.5);
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.strikeoutOffsetY).toBe(Math.round(22 / 3) + 1);
  });

  it("emits overlineOffsetY ≈ fontSize above baseline (top of em-box)", () => {
    const m14 = getDecorationMetrics("Helvetica", 14, "400");
    expect(m14.overlineOffsetY).toBe(14 - 0.5);
    const m22 = getDecorationMetrics("Helvetica", 22, "400");
    expect(m22.overlineOffsetY).toBe(22 - 1);
  });

  it("honors explicit text-decoration-thickness length (DM-431)", () => {
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, "5px");
    expect(m.underlineThickness).toBe(5);
    expect(m.underlineOffsetY).toBe(7.5);
    expect(m.strikeoutThickness).toBe(5);
    expect(m.overlineOffsetY).toBe(13.5);
  });

  it("falls back to auto thickness when text-decoration-thickness is 'auto' or 'from-font' (DM-431)", () => {
    const auto = getDecorationMetrics("Helvetica", 16, "400", undefined, "auto");
    expect(auto.underlineThickness).toBe(1);
    const fromFont = getDecorationMetrics("Helvetica", 16, "400", undefined, "from-font");
    expect(fromFont.underlineThickness).toBe(1);
  });

  it("adds explicit text-underline-offset to underlineOffsetY (DM-431)", () => {
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, undefined, "6px");
    expect(m.underlineOffsetY).toBe(7.5);
  });

  it("falls back to auto offset when text-underline-offset is 'auto' (DM-431)", () => {
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, undefined, "auto");
    expect(m.underlineOffsetY).toBe(1.5);
  });

  it("combines explicit thickness + offset overrides (DM-431)", () => {
    const m = getDecorationMetrics("Helvetica", 16, "400", undefined, "5px", "6px");
    expect(m.underlineThickness).toBe(5);
    expect(m.underlineOffsetY).toBe(13.5);
  });
});

describe("computeSkipInkGaps: text-decoration-skip-ink (DM-446)", () => {
  // Underline rect for 18px Helvetica auto thickness sits at +1.5 px from
  // baseline (1.5 * thickness=1). Descender stems on `j p g y` cross this
  // band; ascender-only / x-height-only letters do not.
  const FS = 18;
  const FF = "Helvetica";
  const FW = "400";
  const Y = 1.5;
  const T = 1;

  it.skipIf(!MACOS_FONTS)("produces gaps for descender-bearing glyphs", () => {
    const gaps = computeSkipInkGaps("jumping", FS, FF, FW, undefined, Y, T);
    // 'j', 'p', 'g' all have stems crossing the underline band.
    expect(gaps.length).toBeGreaterThanOrEqual(2);
  });

  it("produces no gaps for ascender-only / x-height-only text", () => {
    const gaps = computeSkipInkGaps("alone", FS, FF, FW, undefined, Y, T);
    expect(gaps).toEqual([]);
  });

  it("merges adjacent / overlapping descender gaps", () => {
    const gaps = computeSkipInkGaps("ggg", FS, FF, FW, undefined, Y, T);
    // Three adjacent 'g' descenders may merge into one gap or stay separate
    // depending on the pad — guarantee non-overlapping output.
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i][0]).toBeGreaterThanOrEqual(gaps[i - 1][1]);
    }
  });

  it("returns empty when font cannot be resolved", () => {
    const gaps = computeSkipInkGaps("test", FS, "NotAFontFamily12345", FW, undefined, Y, T);
    expect(gaps).toEqual([]);
  });

  it("scales gaps when targetWidth diverges from fontkit's layout width", () => {
    const baseline = computeSkipInkGaps("jumping", FS, FF, FW, undefined, Y, T);
    if (baseline.length === 0) return;
    const stretched = computeSkipInkGaps("jumping", FS, FF, FW, undefined, Y, T, undefined, 200);
    // With a stretched targetWidth, the gap centers should shift outward
    // proportionally — at minimum, the rightmost gap moves right.
    const lastBaseline = baseline[baseline.length - 1];
    const lastStretched = stretched[stretched.length - 1];
    expect(lastStretched[1]).toBeGreaterThan(lastBaseline[1]);
  });
});

// DM-564: framer.com (and other Next.js / next/font marketing sites) emit
// `font-family` stacks of the form
//
//     "<Custom Name>", "<Custom Name> Placeholder", sans-serif
//
// where the first family is the real webfont and the "<Custom Name> Placeholder"
// is a synthetic CSS @font-face that re-points a system font (Arial / Helvetica)
// at the real font's metrics so layout doesn't shift between the placeholder
// and the swap-in. When the custom font IS registered via `discoverAndRegister-
// Webfonts`, `resolveFontKey` must return the webfont key — NOT fall through
// to the Placeholder pseudo-family or to the trailing sans-serif fallback.
// A regression here would paint marketing-site body / hero text in Helvetica
// instead of the intended brand font.
describe("resolveFontKey: registered webfonts win over Placeholder + sans-serif fallback (DM-564)", () => {
  // Minimal valid TTF buffer — fontkit fails to `create()` an empty buffer, so
  // we use a real macOS system font as a placeholder. The webfontRegistry
  // doesn't care what the bytes are; it just stores the parsed FontInstance
  // under the declared family key.
  const HELVETICA_PATH = "/System/Library/Fonts/Helvetica.ttc";
  const fontBuf = fs.existsSync(HELVETICA_PATH) ? fs.readFileSync(HELVETICA_PATH) : null;

  beforeEach(() => {
    clearWebfonts();
  });

  it("picks the registered 'Inter Framer Regular' webfont over the Placeholder/sans-serif tail", () => {
    if (fontBuf == null) return; // skip on hosts without Helvetica.ttc (Linux CI — DM-258+)
    registerWebfont("Inter Framer Regular", 400, "normal", fontBuf);
    const family = '"Inter Framer Regular", "Inter Framer Regular Placeholder", sans-serif';
    expect(resolveFontKey(family)).toBe("webfont:inter framer regular");
  });

  it("picks the registered 'GT Walsheim Framer Medium' webfont over the Placeholder/sans-serif tail", () => {
    if (fontBuf == null) return;
    registerWebfont("GT Walsheim Framer Medium", 500, "normal", fontBuf);
    const family = '"GT Walsheim Framer Medium", "GT Walsheim Framer Medium Placeholder", sans-serif';
    expect(resolveFontKey(family)).toBe("webfont:gt walsheim framer medium");
  });

  it("picks the registered 'Inter Variable' webfont (next/font naming convention)", () => {
    if (fontBuf == null) return;
    registerWebfont("Inter Variable", 400, "normal", fontBuf);
    const family = '"Inter Variable", "Inter Variable Placeholder", sans-serif';
    expect(resolveFontKey(family)).toBe("webfont:inter variable");
  });

  it("falls through to sans-serif (helvetica) when neither the custom family nor any later name is a registered webfont", () => {
    // Sanity check: when nothing in the cascade matches a registered webfont
    // we still resolve via the generic-family rules — confirming the
    // webfont-match isn't masking the existing fallback chain.
    expect(resolveFontKey('"Unregistered Custom Font", "Unregistered Custom Font Placeholder", sans-serif')).toBe("helvetica");
  });

  it("picks the registered family when it appears LATER in the cascade than an unregistered first name", () => {
    // Mirrors Chromium's @font-face cascade walk: missing fonts fall through
    // to the next family, and a hit lower in the list still wins.
    if (fontBuf == null) return;
    registerWebfont("Inter Variable", 400, "normal", fontBuf);
    const family = '"Definitely Not Loaded", "Inter Variable", sans-serif';
    expect(resolveFontKey(family)).toBe("webfont:inter variable");
  });
});

// ── DM-655: embedded-font emission carries the *captured* weight / style /
// variation-settings, not the @font-face descriptor values ─────────────
//
// The first cut of the embedded-font path emitted the picked variant's
// declared @font-face descriptors as the `<text>` font-weight / font-style.
// For a variable font registered as `font-weight: 100 900`, that collapsed
// to weight=100 — so every run rendered hairline regardless of the page's
// computed font-weight. Same for variation-settings: the captured
// `font-variation-settings` was dropped, so wght/opsz/slnt axis state was
// always at the variable font's default. These tests pin the fix.
describe("renderTextAsPath: embedded-font emission carries captured weight/style/variation-settings", () => {
  // Use a real single-font TTF (not a TTC). SFNS.ttf is a variable font on
  // macOS — its bytes parse straight into one fontkit Font instance, which
  // the embedded-font path can call glyphForCodePoint / layout on. Helvetica.ttc
  // would parse to a TTCFont wrapper that lacks those glyph methods.
  const SFNS_PATH = "/System/Library/Fonts/SFNS.ttf";
  const fontBuf = fs.existsSync(SFNS_PATH) ? fs.readFileSync(SFNS_PATH) : null;

  beforeEach(() => {
    clearWebfonts();
    clearEmbeddedFonts();
    setRenderTextMode("embedded-font");
  });

  afterEach(() => {
    setRenderTextMode("paths");
  });

  it("emits the captured font-weight, not the @font-face declared variant weight", () => {
    if (fontBuf == null) return;
    // Register a 'variable' webfont as parseWeightDescriptor("100 900") = 100
    // would: a single variant at the start of the declared weight range.
    registerWebfont("SFTest", 100, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, 24, "SFTest", "500", "#000");
    expect(out).not.toBeNull();
    expect(out!).toContain('font-weight="500"');
    expect(out!).not.toContain('font-weight="100"');
  });

  it("omits font-weight when captured weight is 400 (CSS default)", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 100, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, 24, "SFTest", "400", "#000");
    expect(out).not.toBeNull();
    expect(out!).not.toContain("font-weight=");
  });

  it("emits the captured font-style, not the @font-face declared italic", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    // Page applies italic via CSS; engine synthesizes from upright variant.
    const out = renderTextAsPath("Hi", 0, 0, 24, "SFTest", "400", "#000",
      undefined, undefined, undefined, "italic");
    expect(out).not.toBeNull();
    expect(out!).toContain('font-style="italic"');
  });

  it("forwards font-variation-settings onto the <text> style attribute", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, 24, "SFTest", "400", "#000",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { wght: 540, opsz: 32 });
    expect(out).not.toBeNull();
    expect(out!).toMatch(/style="font-variation-settings: 'wght' 540, 'opsz' 32"/);
  });

  it("omits style attribute when no variation-settings were captured", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, 24, "SFTest", "400", "#000");
    expect(out).not.toBeNull();
    expect(out!).not.toContain("font-variation-settings");
    expect(out!).not.toContain('style="');
  });
});

// ── DM-655: embedded-font mode emits <text> against custom-built TTFs that
// contain the exact shaped glyphs the run uses. Tests below validate
// the custom-TTF pipeline: text emits as PUA codepoints, the @font-face
// data: URL parses back as a valid TTF, the cmap maps PUA codepoints to
// glyph ids, and the glyph outlines match what fontkit gave us for the
// source font. ────────────────────────────────────────────────────────
describe("renderTextAsPath: embedded-font emits custom-built TTFs (DM-655)", () => {
  const SFNS_PATH = "/System/Library/Fonts/SFNS.ttf";
  const fontBuf = fs.existsSync(SFNS_PATH) ? fs.readFileSync(SFNS_PATH) : null;

  beforeEach(() => {
    clearWebfonts();
    clearEmbeddedFonts();
    setRenderTextMode("embedded-font");
  });

  afterEach(() => {
    setRenderTextMode("paths");
  });

  // Extract all PUA codepoints out of the <text> bodies in a render output.
  // DM-841: glyphs are positioned via the <text> `x` list (one value per
  // glyph), so the body is the PUA stream — one PUA codepoint per shaped glyph.
  function puaCodepointsFromMarkup(out: string): number[] {
    const cps: number[] = [];
    const re = /<text[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(out)) != null) {
      for (let i = 0; i < m[1].length; ) {
        const cp = m[1].codePointAt(i)!;
        cps.push(cp);
        i += cp > 0xFFFF ? 2 : 1;
      }
    }
    return cps;
  }

  it("emits <text> with PUA codepoints in the body (not the original text)", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontA", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hello", 0, 0, 24, "CustomFontA", "400", "#000");
    expect(out).not.toBeNull();
    // The literal "Hello" must NOT appear in any <text> body — only in
    // the accessibility title/aria-label.
    const bodyMatches = [...out!.matchAll(/<text[^>]*>([^<]*)<\/text>/g)];
    expect(bodyMatches.length).toBeGreaterThan(0);
    for (const m of bodyMatches) {
      expect(m[1]).not.toContain("Hello");
      for (let i = 0; i < m[1].length; ) {
        const cp = m[1].codePointAt(i)!;
        expect(cp).toBeGreaterThanOrEqual(0xE000);
        expect(cp).toBeLessThanOrEqual(0xF8FF);
        i += cp > 0xFFFF ? 2 : 1;
      }
    }
    // Accessible label preserves the original text.
    expect(out!).toContain('aria-label="Hello"');
    expect(out!).toContain("<title>Hello</title>");
  });

  it("emitted @font-face data: URI parses as a valid TTF with the registered PUA codepoints", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontB", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hi!", 0, 0, 24, "CustomFontB", "400", "#000");
    expect(out).not.toBeNull();
    const css = getEmbeddedFontFaceCss();
    expect(css).toContain("@font-face");
    expect(css).toContain('src: url("data:font/ttf;base64,');
    const b64Match = /base64,([A-Za-z0-9+/=]+)"\)/.exec(css);
    expect(b64Match).not.toBeNull();
    const ttf = Buffer.from(b64Match![1], "base64");
    const reparsed = fontkit.create(ttf) as any;
    expect(reparsed.numGlyphs).toBeGreaterThan(1); // notdef + per-shaped-glyph
    const cps = puaCodepointsFromMarkup(out!);
    expect(cps.length).toBeGreaterThan(0);
    for (const cp of cps) {
      const glyph = reparsed.glyphForCodePoint(cp);
      expect(glyph.id).not.toBe(0); // 0 = .notdef → reparsed cmap missing this PUA
      expect(glyph.path.commands.length).toBeGreaterThan(0); // real outline present
    }
  });

  it("positions each shaped glyph via the <text> x list for sub-pixel-accurate placement (DM-841)", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontE", 400, "normal", fontBuf);
    const out = renderTextAsPath("AB", 0, 0, 24, "CustomFontE", "400", "#000");
    expect(out).not.toBeNull();
    // Two shaped glyphs → a single <text> with a 2-value `x` list and a
    // 2-codepoint PUA body (no per-glyph <tspan> wrappers).
    expect(out!).not.toContain("<tspan");
    const m = /<text x="([\d.\- ]+)"[^>]*>([^<]+)<\/text>/.exec(out!);
    expect(m).not.toBeNull();
    const xs = m![1].trim().split(/\s+/).map(Number);
    expect(xs.length).toBe(2);
    // Glyph x's must be monotonic-increasing (text flows L→R).
    expect(xs[1]).toBeGreaterThan(xs[0]);
    // Body is exactly two PUA codepoints (one per glyph).
    const bodyCps = [...m![2]].map((c) => c.codePointAt(0)!);
    expect(bodyCps.length).toBe(2);
    for (const cp of bodyCps) {
      expect(cp).toBeGreaterThanOrEqual(0xE000);
      expect(cp).toBeLessThanOrEqual(0xF8FF);
    }
  });

  it("each unique (font, axes) combo gets its own custom @font-face entry", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontC", 400, "normal", fontBuf);
    // Same family, no axes → one entry.
    renderTextAsPath("AB", 0, 0, 24, "CustomFontC", "400", "#000");
    // Same family, distinct axes tuple → second entry.
    renderTextAsPath("CD", 0, 0, 24, "CustomFontC", "400", "#000",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { wght: 540 });
    // Same family, third distinct axes tuple → third entry.
    renderTextAsPath("EF", 0, 0, 24, "CustomFontC", "400", "#000",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { wght: 100 });
    const css = getEmbeddedFontFaceCss();
    const faceCount = (css.match(/@font-face/g) ?? []).length;
    expect(faceCount).toBe(3);
  });

  it("the same (font, axes) combo across calls shares one @font-face entry", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontD", 400, "normal", fontBuf);
    renderTextAsPath("AB", 0, 0, 24, "CustomFontD", "400", "#000");
    renderTextAsPath("CD", 0, 0, 24, "CustomFontD", "400", "#000");
    renderTextAsPath("EF", 0, 0, 24, "CustomFontD", "400", "#000");
    const css = getEmbeddedFontFaceCss();
    const faceCount = (css.match(/@font-face/g) ?? []).length;
    expect(faceCount).toBe(1);
  });
});

describe("synthSmallCapsCharScale — synthesized font-variant-caps per-char scale (DM-1116)", () => {
  const S = 0.7; // SMALL_CAP_SCALE
  // Scale args by caps mode (null = that case class isn't synthesized):
  //   small-caps      → lower S, upper null
  //   all-small-caps  → lower S, upper S
  //   unicase         → lower null, upper S
  describe("small-caps (smcp): only lowercase letters shrink + up-case", () => {
    it("up-cases + scales a lowercase letter", () => {
      expect(synthSmallCapsCharScale("a", S, null)).toEqual({ scale: S, upcase: true });
    });
    it("leaves uppercase letters, digits, and punctuation at full size", () => {
      expect(synthSmallCapsCharScale("A", S, null)).toEqual({ scale: 1, upcase: false });
      expect(synthSmallCapsCharScale("5", S, null)).toEqual({ scale: 1, upcase: false });
      expect(synthSmallCapsCharScale("-", S, null)).toEqual({ scale: 1, upcase: false });
      expect(synthSmallCapsCharScale(":", S, null)).toEqual({ scale: 1, upcase: false });
    });
  });

  describe("all-small-caps (smcp+c2sc): EVERYTHING shrinks", () => {
    it("scales lowercase (up-cased), uppercase, digits, AND punctuation/symbols", () => {
      expect(synthSmallCapsCharScale("a", S, S)).toEqual({ scale: S, upcase: true });
      expect(synthSmallCapsCharScale("A", S, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale("5", S, S)).toEqual({ scale: S, upcase: false });
      // the regression: hyphen + colon must shrink with the rest of the run.
      expect(synthSmallCapsCharScale("-", S, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale(":", S, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale("&", S, S)).toEqual({ scale: S, upcase: false });
    });
  });

  describe("unicase (unic): lowercase stays normal; same-case chars shrink", () => {
    it("keeps lowercase letters full and un-cased", () => {
      expect(synthSmallCapsCharScale("a", null, S)).toEqual({ scale: 1, upcase: false });
    });
    it("shrinks uppercase letters, digits, AND punctuation (no case change)", () => {
      expect(synthSmallCapsCharScale("A", null, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale("5", null, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale("-", null, S)).toEqual({ scale: S, upcase: false });
      expect(synthSmallCapsCharScale(":", null, S)).toEqual({ scale: S, upcase: false });
    });
  });

  it("treats a multi-char fold (ß→SS) as same-case so per-char scale arrays stay aligned", () => {
    // ß is lowercase but up-cases to 2 chars; classifying it as same-case avoids
    // a length mismatch between shaping text and the per-char scale array.
    expect(synthSmallCapsCharScale("ß", S, S)).toEqual({ scale: S, upcase: false });
  });

  it("is a no-op when neither scale is set (no synthesis active)", () => {
    expect(synthSmallCapsCharScale("a", null, null)).toEqual({ scale: 1, upcase: false });
    expect(synthSmallCapsCharScale("-", null, null)).toEqual({ scale: 1, upcase: false });
  });
});

describe("text-spacing-trim: fullwidth-punctuation ink shift (DM-1184)", () => {
  // A minimal FontInstance whose `halt` feature mirrors a real CJK font:
  // halves the advance (1000 → 500) and shifts OPENING punctuation ink left
  // (xOffset −500) while leaving CLOSING punctuation (xOffset 0).
  function fakeFont(haltXOffset: number): Parameters<typeof cjkTrimShiftFontUnits>[0] {
    return {
      unitsPerEm: 1000,
      layout(_text: string, features?: string[]) {
        const halt = features != null && features.includes("halt");
        return {
          glyphs: [{ id: 7, path: { commands: [] }, advanceWidth: halt ? 500 : 1000 }],
          positions: [{ xAdvance: halt ? 500 : 1000, yAdvance: 0, xOffset: halt ? haltXOffset : 0, yOffset: 0 }],
        };
      },
    } as unknown as Parameters<typeof cjkTrimShiftFontUnits>[0];
  }
  const glyph = { id: 7, advanceWidth: 1000, path: { commands: [] } };

  it("scopes the punctuation gate to CJK fullwidth blocks", () => {
    expect(isTrimmableCjkPunct(0x300C)).toBe(true);  // 「 LEFT CORNER BRACKET
    expect(isTrimmableCjkPunct(0x300D)).toBe(true);  // 」 RIGHT CORNER BRACKET
    expect(isTrimmableCjkPunct(0xFF08)).toBe(true);  // （ FULLWIDTH LEFT PAREN
    expect(isTrimmableCjkPunct(0x3002)).toBe(true);  // 。 IDEOGRAPHIC FULL STOP
    expect(isTrimmableCjkPunct(0x3042)).toBe(false); // あ HIRAGANA (not punctuation)
    expect(isTrimmableCjkPunct(0x6587)).toBe(false); // 文 ideograph
    expect(isTrimmableCjkPunct(0x0041)).toBe(false); // Latin A
  });

  it("shifts a TRIMMED opening bracket left by the halt xOffset", () => {
    // fontSize 16, em 1000 → scale 0.016; full advance = 16px, trimmed = 8px.
    const shift = cjkTrimShiftFontUnits(fakeFont(-500), "k-open", glyph, 0x300C, 8, 16, 0.016);
    expect(shift).toBe(-500); // font units: opening ink moves left half an em
  });

  it("leaves a TRIMMED closing bracket unshifted (its ink is already left-aligned)", () => {
    const shift = cjkTrimShiftFontUnits(fakeFont(0), "k-close", glyph, 0x300D, 8, 16, 0.016);
    expect(shift).toBe(0);
  });

  it("does NOT shift an UNTRIMMED opening bracket (full-em captured advance)", () => {
    // capturedAdv 16 ≈ full advance → not trimmed → no shift even for opening.
    const shift = cjkTrimShiftFontUnits(fakeFont(-500), "k-open2", glyph, 0xFF08, 16, 16, 0.016);
    expect(shift).toBe(0);
  });

  it("falls back to ink geometry when the font can't report halt (ink in right half ⇒ opening)", () => {
    // A font whose halt layout doesn't narrow the glyph (no half-width form):
    // classify opening (ink centered in the RIGHT half of the em box) and shift
    // left by the trimmed amount; here trim = (16−8)/0.016 = 500 font units.
    const noHaltFont = {
      unitsPerEm: 1000,
      layout: () => ({ glyphs: [{ id: 7, path: { commands: [] }, advanceWidth: 1000 }], positions: [{ xAdvance: 1000, yAdvance: 0, xOffset: 0, yOffset: 0 }] }),
    } as unknown as Parameters<typeof cjkTrimShiftFontUnits>[0];
    const openingGlyph = { id: 7, advanceWidth: 1000, path: { commands: [{ command: "moveTo", args: [700, 100] }, { command: "lineTo", args: [950, 800] }] } };
    const shift = cjkTrimShiftFontUnits(noHaltFont, "k-nohalt", openingGlyph, 0x300C, 8, 16, 0.016);
    expect(shift).toBe(-500);
  });

  // DM-1223: the contextual cases (`」「` adjacent brackets, line-leading `「`)
  // need no special code — the shift is a pure function of the glyph + the
  // captured advance, NOT the preceding char. Chrome's contextual trim decision
  // is already encoded in the captured xOffsets; this just re-aligns the trimmed
  // glyph's ink. So a closing `」` (full advance, no trim) and the adjacent
  // opening `「` (captured half, trimmed) are each handled per-glyph — exactly
  // the same shift that fixed `（「` (DM-1184) lands `」「` and line-leading `「`.
  // (Verified ink-identical to Chrome at both residual regions of
  // 20-deep-hanging-punctuation: the remaining diff is glyph-AA, not position.)
  it("handles the 」「 adjacent-bracket boundary per-glyph (DM-1223)", () => {
    // `」` stays full-width (Chrome doesn't trim a closing bracket here) → no shift.
    expect(cjkTrimShiftFontUnits(fakeFont(0), "j-close", glyph, 0x300D, 16, 16, 0.016)).toBe(0);
    // The immediately-following `「` is trimmed to half regardless of the `」`
    // before it → the same left halt shift as in `（「`.
    expect(cjkTrimShiftFontUnits(fakeFont(-500), "k-open", glyph, 0x300C, 8, 16, 0.016)).toBe(-500);
  });
});
