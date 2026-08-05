import * as fs from "fs";
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fontkit from "fontkit";
import { glyphIdForCp, __clearGlyphFallbackCaches, __resolveDarwinFontSpecForTest, __resolveFontForCodepointForTest, __resolveFontSpecForTest, cjkTrimShiftFontUnits, clearEmbeddedFonts, clearGlyphDefs, clearWebfonts, commandsFor, complexShaperBaseMarkDecomposition, nfdBaseMarkDecomposition, computeSkipInkGaps, darwinFallbackChain, fallbackFontChain, fontHasOutlineTable, getDecorationMetrics, getEmbeddedFontFaceCss, getFontInstance, insertSyntheticDottedCircles, isStrippableOrphanIgnorable, isTrimmableCjkPunct, stripOrphanedDefaultIgnorables, isLeftReorderingMatra, isLegitimatelyInklessCodepoint, isStretchyFenceChar, isTextToPathAvailable, linuxFallbackChain, mathAlphaToBase, measureInkMetrics, pingfangKeyForLang, registerWebfont, renderRadicalGlyph, renderStretchyFenceGlyph, renderTextAsPath, resolveFontKey, sourceClusterSpan, resolveFontKeyChain, setRenderTextMode, subBoldWeightCutSuffix, synthSmallCapsCharScale, usesComplexShaperDottedCircle, win32FallbackChain, __setWin32FamilyKeyResolverForTest } from "./text-to-path.js";
import { isRtlScriptCodepoint } from "./unicode-classification.js";
import { getGlyphDefs, getSystemFallbackResolution, isNonCharacterCodepoint, isPrivateUseCodepoint, setSystemFallbackResolution, withSystemFallbackResolution, __resolveSystemFallbackKeyForCpForTest } from "./font-resolution.js";
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
// The next three describes pin the CALIBRATED nomination table — the
// platform-blind key model, which on Linux is now the DEGRADE path (no
// helper binary, a helper predating the familyMatch query, or
// DOMOTION_SYSTEM_FALLBACK=0). When the transcribed Linux nomination walk is
// armed, a non-generic name is resolved by asking Blink's matcher instead
// (accepted names register `sysfb:` keys, rejected names are walked past),
// and THOSE semantics are pinned in linux-declared-family-cut.test.ts — so
// these tables are exercised here with the walk disarmed on every platform.
function withNominationWalkDisarmed(): void {
  let prev: boolean;
  beforeAll(() => { prev = getSystemFallbackResolution(); setSystemFallbackResolution(false); });
  afterAll(() => { setSystemFallbackResolution(prev); });
}

describe("resolveFontKey: generic-family resolution", () => {
  withNominationWalkDisarmed();
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

  it("routes system-ui / BlinkMacSystemFont to SF Pro (Linux: the fontconfig default, matching Chrome)", () => {
    // Chrome-on-Linux has no `system-ui` family — Blink configures `sans-serif`
    // but never `system-ui`, so the keyword resolves through fontconfig's raw
    // default (WenQuanYi Zen Hei on the Playwright noble image, DejaVu Sans on a
    // stock GitHub runner; verified via getPlatformFontsForNode — DM-1681). The
    // key is therefore a dynamic `sysfb:` registration carrying the HOST's
    // fontconfig answer, deliberately not a face frozen here — asserting a
    // literal face name would re-freeze one machine's inventory into the test.
    // With the live resolver off, the documented fallback is the macOS mapping.
    if (process.platform === "linux" && getSystemFallbackResolution()) {
      expect(resolveFontKey("system-ui")).toMatch(/^sysfb:/);
      withSystemFallbackResolution(false, () => {
        expect(resolveFontKey("system-ui")).toBe("sf-pro");
      });
    } else {
      expect(resolveFontKey("system-ui")).toBe("sf-pro");
    }
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
  withNominationWalkDisarmed();
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

  it("resolves named SF Pro Text / Display to the system SFNS cut for shape fidelity, with the standalone OTF as a per-codepoint coverage fallback (DM-1659, reversing DM-1127)", () => {
    // DM-1659: Chrome→CoreText paints "SF Pro Text" / "SF Pro Display" from the
    // SYSTEM font SFNS.ttf, NOT the standalone /Library/Fonts/SF-Pro-*.otf. The two
    // files share Text-cut METRICS (identical advances) but differ in glyph DESIGN:
    // e.g. the '!' dot is a squat rectangle in SFNS (what Chrome shows) vs a round
    // circle in the OTF; accent and terminal shapes differ across the board.
    // Verified via CDP getPlatformFontsForNode + native CoreText rasterization of
    // both files. So the family resolves to the "sf-pro" (SFNS) key for shape
    // fidelity — reversing DM-1127, which preferred the OTF wholesale on the FALSE
    // assumption it's "the same font Chrome uses".
    //
    // The mapping holds ONLY where the named family actually resolves on THIS
    // host. Everywhere else — a macOS install without Apple's SF Pro download,
    // and every Linux/Windows host — Chrome cannot resolve the name and falls
    // THROUGH the stack: a bare "SF Pro Text" lands on the standard-font
    // default (verified on the Playwright noble image via
    // getPlatformFontsForNode: Liberation Serif, our `times` key) and a stacked
    // one lands on the next family (same probe: Liberation Sans for
    // `"SF Pro Text", sans-serif`, our `helvetica` key).
    if (resolveInstalledFont("SF Pro Text") != null) {
      expect(resolveFontKey("SF Pro Text")).toBe("sf-pro");
      expect(resolveFontKey("SF Pro Display")).toBe("sf-pro");
    } else {
      expect(resolveFontKey("SF Pro Text")).toBe("times");
      expect(resolveFontKey('"SF Pro Text", sans-serif')).toBe("helvetica");
    }

    if (process.platform !== "darwin") return; // no CoreText helper off macOS
    // Per-codepoint: SFNS-covered glyphs stay on SFNS (correct SHAPE) — the '!' and
    // the single-digit circled numbers SFNS.ttf carries.
    expect(__resolveFontForCodepointForTest(0x21, "SF Pro Text")?.key).toBe("sf-pro");   // '!'
    expect(__resolveFontForCodepointForTest(0x2460, "SF Pro Text")?.key).toBe("sf-pro"); // ① single-circled
    // ... but SFNS-gap glyphs fall to the standalone OTF (correct COVERAGE), because
    // Chrome's CoreText cascades there for them (still reporting "SF Pro Text").
    const otf = resolveInstalledFont("SF Pro Text");
    if (otf != null) {
      const otfKey = `sysfb:${otf.postscriptName}`;
      expect(__resolveFontForCodepointForTest(0x2469, "SF Pro Text")?.key).toBe(otfKey); // ⑩ two-digit
      expect(__resolveFontForCodepointForTest(0x24EB, "SF Pro Text")?.key).toBe(otfKey); // ⑪ negative-circled two-digit
      const font = fontkit.openSync(__resolveFontSpecForTest(otfKey)!.path) as unknown as { glyphForCodePoint(cp: number): { id: number } };
      expect(font.glyphForCodePoint(0x2469).id).not.toBe(0); // the OTF genuinely covers it
    }
    // Precondition (guards against "fixing" this by repointing routing at another
    // file): SFNS.ttf genuinely has the single-digit circled numbers but not the
    // two-digit ones.
    const sfns = fontkit.openSync("/System/Library/Fonts/SFNS.ttf") as unknown as { glyphForCodePoint(cp: number): { id: number } };
    expect(sfns.glyphForCodePoint(0x2460).id).not.toBe(0); // single-digit present
    expect(sfns.glyphForCodePoint(0x2469).id).toBe(0);     // two-digit absent
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

// Weight -> face routing. `getFontInstance` used to collapse every CSS weight
// under 600 onto a family's REGULAR face, which silently discarded the lighter
// and heavier cuts some families ship. All the expectations below come from
// asking Chromium itself which face it painted, over the whole 100..900 range
// in 10-point steps, via the CDP `CSS.getPlatformFontsForNode` command.
describe("weight -> face routing: sub-bold cuts", () => {
  // Pure key math — no font files involved, so it holds on every platform.
  it("maps Helvetica's CSS weights onto its light cut at 300 and below", () => {
    expect(subBoldWeightCutSuffix("helvetica", 100)).toBe("light");
    expect(subBoldWeightCutSuffix("helvetica", 200)).toBe("light");
    expect(subBoldWeightCutSuffix("helvetica", 300)).toBe("light");
    // Above the cut, the family's regular face is the right pick.
    expect(subBoldWeightCutSuffix("helvetica", 310)).toBeNull();
    expect(subBoldWeightCutSuffix("helvetica", 400)).toBeNull();
    expect(subBoldWeightCutSuffix("helvetica", 590)).toBeNull();
  });

  it("defers to the existing bold routing at 600 and above", () => {
    expect(subBoldWeightCutSuffix("helvetica", 600)).toBeNull();
    expect(subBoldWeightCutSuffix("helvetica", 700)).toBeNull();
    expect(subBoldWeightCutSuffix("helvetica", 900)).toBeNull();
  });

  it("returns null for families that ship no cut below regular", () => {
    // Arial, Times, Georgia, Courier and Menlo are regular/bold-only on macOS —
    // Chrome paints their regular face for every weight under 600.
    for (const key of ["arial", "times", "georgia", "courier", "menlo", "helvetica-neue"]) {
      expect(subBoldWeightCutSuffix(key, 100), key).toBeNull();
      expect(subBoldWeightCutSuffix(key, 300), key).toBeNull();
    }
    expect(subBoldWeightCutSuffix("definitely-not-a-real-font-key", 100)).toBeNull();
  });

  const psName = (key: string, weight: number, slant = 0): string | undefined =>
    (getFontInstance(key, weight, 22, slant) as unknown as { postscriptName?: string } | null)?.postscriptName;

  if (MACOS_FONTS) {
    // Helvetica is the `sans-serif` generic on macOS, so this ladder governs
    // default body text. It now comes from the declared-family style matcher
    // (Blink's `BestStyleMatchForFamilyNS` / `BetterChoiceCT`,
    // `platform/fonts/mac/font_matcher_mac.mm` at Chromium tag 147.0.7727.15 —
    // the build Playwright pins) rather than the family's own cut table.
    //
    // At all nine canonical CSS weights this reproduces Chrome exactly,
    // measured over CDP: Light at 100-300, Helvetica at 400-500, Bold at
    // 600-900.
    it("resolves Helvetica's full weight ladder through the declared-family matcher", () => {
      const ladder: Array<[number, string]> = [
        [100, "Helvetica-Light"], [200, "Helvetica-Light"], [300, "Helvetica-Light"],
        [400, "Helvetica"], [500, "Helvetica"],
        [600, "Helvetica-Bold"], [700, "Helvetica-Bold"],
        [800, "Helvetica-Bold"], [900, "Helvetica-Bold"],
      ];
      for (const [w, expected] of ladder) expect(psName("helvetica", w), `weight ${w}`).toBe(expected);
    });

    // The rungs BETWEEN the canonical weights used to diverge from the
    // shipping Chrome, because the port transcribed the local checkout (rev
    // 7d859f27), whose directional `BetterWeightMatch` rewrite landed AFTER
    // the branch point of the Chrome build Playwright pins (147.0.7727.15).
    // Reading `font_matcher_mac.mm` at that tag settled it: the shipping
    // `BetterChoiceCT` (:172-220) is nearest-CSS-weight with a
    // further-from-500 tie-break, and the bold trait sits IN the
    // trait-precedence loop, so 305-399 and 501-599 both paint plain
    // Helvetica (Light is AppKit weight 3 -> CSS 200, so 400 is nearer above
    // 300; Bold's unwanted bold trait loses before weight is compared below
    // 600). The helper now transcribes the 147 comparator and agrees with
    // Chrome over CDP at every one of these rungs.
    it("matches the shipping Chrome at the intermediate weights", () => {
      expect(psName("helvetica", 350)).toBe("Helvetica");       // nearest: 400
      expect(psName("helvetica", 590)).toBe("Helvetica");       // bold trait unwanted below 600
      expect(psName("helvetica", 300)).toBe("Helvetica-Light"); // 200 vs 400 tie -> further from 500
    });

    it("resolves Helvetica's oblique column in lockstep with the upright one", () => {
      expect(psName("helvetica", 100, -0.2)).toBe("Helvetica-LightOblique");
      expect(psName("helvetica", 300, -0.2)).toBe("Helvetica-LightOblique");
      expect(psName("helvetica", 400, -0.2)).toBe("Helvetica-Oblique");
      expect(psName("helvetica", 700, -0.2)).toBe("Helvetica-BoldOblique");
    });

    // The instance cache is keyed on the RESOLVED face, so walking back and
    // forth across a cut boundary must keep handing back distinct faces — a
    // cache key that dropped the cut would serve the first-seen face forever.
    it("keeps the cuts distinct when weights interleave through the cache", () => {
      const seq = [100, 400, 100, 700, 300, 400, 300];
      const want = [
        "Helvetica-Light", "Helvetica", "Helvetica-Light", "Helvetica-Bold",
        "Helvetica-Light", "Helvetica", "Helvetica-Light",
      ];
      expect(seq.map((w) => psName("helvetica", w))).toEqual(want);
    });

    // Lucida Grande is the macOS fallback for arrows, Hebrew and check marks;
    // Chrome crosses to its bold cut at 450, so an arrow inside a bold heading
    // is painted bold. Measured: 100-440 -> LucidaGrande, 450-900 -> Bold.
    it("crosses Lucida Grande over to its bold cut at 450", () => {
      expect(psName("lucida-grande", 400)).toBe("LucidaGrande");
      expect(psName("lucida-grande", 440)).toBe("LucidaGrande");
      expect(psName("lucida-grande", 450)).toBe("LucidaGrande-Bold");
      expect(psName("lucida-grande", 700)).toBe("LucidaGrande-Bold");
    });

    // Faux-italic guard. `post.italicAngle` is 0 on Helvetica-LightOblique and
    // HelveticaNeue-BoldItalic even though both outlines lean ~12°, so the
    // angle alone would shear an already-oblique face a second time. The
    // routing decision is the reliable signal.
    it("flags a routed italic cut even when the face under-reports its angle", () => {
      const lightOblique = getFontInstance("helvetica", 100, 22, -0.2);
      expect(lightOblique?.isRoutedItalicCut).toBe(true);
      expect(Math.abs(lightOblique?.resolvedItalicAngle ?? 0)).toBeLessThan(1);

      const neueBoldItalic = getFontInstance("helvetica-neue", 700, 22, -0.2);
      expect(neueBoldItalic?.isRoutedItalicCut).toBe(true);
      expect(Math.abs(neueBoldItalic?.resolvedItalicAngle ?? 0)).toBeLessThan(1);
    });

    it("leaves upright faces unflagged so they still get a synthetic oblique", () => {
      expect(getFontInstance("helvetica", 400, 22, 0)?.isRoutedItalicCut).toBe(false);
      expect(getFontInstance("lucida-grande", 400, 22, 0)?.isRoutedItalicCut).toBe(false);
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

// NFD-decomposed negated arrows: Chrome-on-Linux paints U+21AE ↮ / U+21CE ⇎ /
// U+219A ↚ / U+219B ↛ as TWO Liberation Sans glyphs (CDP getPlatformFontsForNode:
// glyphCount 2) — HarfBuzz's normalizer (hb-ot-shape-normalize.cc) decomposes a
// codepoint the current font's cmap lacks and shapes the pieces in that same
// font: base arrow + the zero-advance U+0338 combining long solidus placed
// naively at the pen (Liberation has no GPOS mark anchors on arrow bases). It
// never reaches the fontconfig per-char fallback that would find FreeSans's
// PRECOMPOSED ↮ (slash centered — visibly different). `nfdBaseMarkDecomposition`
// is the script-agnostic classifier behind the Linux-only resolver branch that
// mirrors this.
describe("nfdBaseMarkDecomposition (Chrome-on-Linux negated-arrow decomposition)", () => {
  it("returns the base+mark NFD pair for the negated arrows", () => {
    expect(nfdBaseMarkDecomposition(0x21AE)).toBe("\u2194\u0338"); // ↮ = ↔ + combining long solidus
    expect(nfdBaseMarkDecomposition(0x21CE)).toBe("\u21D4\u0338"); // ⇎ = ⇔ + combining long solidus
    expect(nfdBaseMarkDecomposition(0x219A)).toBe("\u2190\u0338"); // ↚ = ← + combining long solidus
    expect(nfdBaseMarkDecomposition(0x219B)).toBe("\u2192\u0338"); // ↛ = → + combining long solidus
    expect(nfdBaseMarkDecomposition(0x2260)).toBe("\u003D\u0338"); // ≠ = = + combining long solidus
  });
  it("returns base+mark pairs for Latin diacritics too (fired only when a font lacks the composed glyph)", () => {
    expect(nfdBaseMarkDecomposition(0x00E9)).toBe("\u0065\u0301"); // é
  });
  it("is NULL for singletons, atomic codepoints, marks, and Hangul base+jamo", () => {
    expect(nfdBaseMarkDecomposition(0x2F800)).toBeNull(); // CJK-compat singleton → U+4E3D (handled by the singleton step)
    expect(nfdBaseMarkDecomposition(0x2190)).toBeNull();  // plain ← — no decomposition
    expect(nfdBaseMarkDecomposition(0x0338)).toBeNull();  // the combining mark itself
    expect(nfdBaseMarkDecomposition(0xAC00)).toBeNull();  // 가 — jamo pieces are Lo, not M
  });
  // The resolver branch is NOT platform-gated — HarfBuzz normalization is engine
  // behavior, not a platform quirk. What keeps the negated arrows on their
  // composed route on macOS is the every-piece-covered guard, not a platform
  // check: macOS Helvetica lacks the U+2194 base piece (the misc arrows route to
  // Hiragino per the darwin chain), so the guard fails and Chrome-on-macOS
  // likewise paints Apple Symbols' composed glyph, which we already match
  // pixel-exactly.
  if (process.platform === "linux") {
    it("[linux] resolves the negated arrows to a DECOMPOSED run in the declared cascade, not the fc-match composed glyph", () => {
      for (const cp of [0x21AE, 0x21CE, 0x219A, 0x219B]) {
        const r = __resolveFontForCodepointForTest(cp, "sans-serif");
        expect(r).not.toBeNull();
        // Liberation Sans (the `sans-serif` primary) covers ↔/⇔/←/→ + U+0338,
        // so the walk must stop there with a HarfBuzz-shaped decomposed run —
        // NOT fall through to the fc-match system fallback (sysfb:FreeSans /
        // sysfb:FreeSerif), whose precomposed glyph Chrome never paints.
        expect(r!.covered).toBe(true);
        expect(r!.decomposed).toBe(true);
        expect(r!.key).toBe("helvetica");
      }
    });
  } else {
    it("[non-linux] keeps the negated arrows on the calibrated composed route (no decomposition)", () => {
      const r = __resolveFontForCodepointForTest(0x21AE, "sans-serif");
      expect(r).not.toBeNull();
      expect(r!.decomposed).toBe(false);
    });
  }

  // The guard above is what holds the arrows back on macOS, so pin its
  // precondition explicitly — otherwise a future repoint of `sans-serif` to a
  // face that DOES carry U+2194 would silently start decomposing them and the
  // test above would still read as "correct by platform".
  if (MACOS_FONTS) {
    it("[macos] Helvetica genuinely lacks the U+2194 base piece (why the arrows don't decompose here)", () => {
      const helv = getFontInstance("helvetica", 400, 32)!;
      expect(glyphIdForCp(helv, 0x2194)).toBe(0);
    });
  }
});

// A stock macOS install has neither Apple's downloadable "SF Pro Text" nor
// Google's "Noto Sans", so the unicode fixtures' font stacks fall through to
// Arial Unicode MS. Arial Unicode MS carries no PRECOMPOSED glyph for the
// grave/diaeresis Cyrillic letters or a swathe of Latin Extended-B, but it does
// cover every piece of their canonical NFD — and HarfBuzz's normalizer
// (hb-ot-shape-normalize.cc, decompose_current_character) decomposes exactly
// there and shapes the pieces IN THAT SAME FONT. Chrome proves it: CDP
// getPlatformFontsForNode reports "Arial Unicode MS" with glyphCount 2 for these
// (3 for the two-mark U+0230/U+0231). Rejecting the font on missing composed
// coverage walked us on to Helvetica's precomposed glyph, whose accent sits at a
// visibly different height — the stock-macOS "accent marks in the wrong place"
// that a developer Mac cannot reproduce, because there SF Pro Text covers them
// and the walk never reaches Arial Unicode MS.
if (process.platform === "darwin" && existsSync("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")) {
  describe("[macos] stock-install accents decompose in Arial Unicode MS, as Chrome does", () => {
    const STACK = '"Arial Unicode MS", sans-serif';
    // The six Cyrillic + a spread of the Latin Extended-B codepoints the
    // stock-macOS runner reported as mispositioned.
    const CPS = [0x0400, 0x040D, 0x0450, 0x045D, 0x04EC, 0x04ED, 0x01F8, 0x0218, 0x021A, 0x0226, 0x0230];

    it("routes them to Arial Unicode MS as a DECOMPOSED run, not on to Helvetica's precomposed glyph", () => {
      for (const cp of CPS) {
        const r = __resolveFontForCodepointForTest(cp, STACK);
        expect(r, `U+${cp.toString(16)}`).not.toBeNull();
        expect(r!.covered, `U+${cp.toString(16)} covered`).toBe(true);
        expect(r!.decomposed, `U+${cp.toString(16)} decomposed`).toBe(true);
        expect(r!.key, `U+${cp.toString(16)} key`).toBe("u-arial-unicode-ms");
      }
    });

    it("preconditions: Arial Unicode MS lacks the composed glyph but covers every NFD piece", () => {
      const aum = getFontInstance("u-arial-unicode-ms", 400, 32)!;
      for (const cp of CPS) {
        expect(glyphIdForCp(aum, cp), `composed U+${cp.toString(16)}`).toBe(0);
        const nfd = nfdBaseMarkDecomposition(cp);
        expect(nfd, `nfd U+${cp.toString(16)}`).not.toBeNull();
        for (const piece of [...nfd!]) {
          expect(glyphIdForCp(aum, piece.codePointAt(0)!), `piece U+${piece.codePointAt(0)!.toString(16)}`).not.toBe(0);
        }
      }
    });

    it("leaves a codepoint Arial Unicode MS DOES carry composed on the literal fast path", () => {
      // Ё / Й are precomposed in Arial Unicode MS, so Chrome paints one glyph
      // and so must we — the decomposition branch must not steal these.
      for (const cp of [0x0401, 0x0419]) {
        const r = __resolveFontForCodepointForTest(cp, STACK);
        expect(r!.decomposed, `U+${cp.toString(16)}`).toBe(false);
        expect(r!.key).toBe("u-arial-unicode-ms");
      }
    });
  });
}

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
    const out = renderTextAsPath("\u{1E944}", 0, 0, { fontSize: 32, fontFamily: '"Noto Sans Adlam"', fontWeight: "400", fill: "#000" });
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(2); // HarfBuzz-inserted ◌ + the mark (fontkit alone → 1, no ◌)
  });
  it.skipIf(!HAVE_ADLAM)("shares ONE ◌ across an orphaned multi-mark cluster (3 glyphs: ◌ + 2 marks)", () => {
    const out = renderTextAsPath("\u{1E944}\u{1E944}", 0, 0, { fontSize: 32, fontFamily: '"Noto Sans Adlam"', fontWeight: "400", fill: "#000" });
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(3);
  });
  it.skipIf(!HAVE_ADLAM)("does NOT insert a ◌ for a based Adlam letter + mark (no orphan → 2 glyphs)", () => {
    const out = renderTextAsPath("\u{1E921}\u{1E944}", 0, 0, { fontSize: 32, fontFamily: '"Noto Sans Adlam"', fontWeight: "400", fill: "#000" });
    expect(out).not.toBeNull();
    expect(glyphCount(out!)).toBe(2); // base + mark, NO inserted circle (would be 3 if mis-routed)
  });
  it.skipIf(!HAVE_ADLAM)("does NOT insert a ◌ for a bare Adlam base letter (1 glyph)", () => {
    const out = renderTextAsPath("\u{1E921}", 0, 0, { fontSize: 32, fontFamily: '"Noto Sans Adlam"', fontWeight: "400", fill: "#000" });
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
  it("DM-1215: an orphaned RTL-SMP-script mark paints mark-then-circle (tofu LEFT, ◌ RIGHT)", () => {
    // Sogdian COMBINING DOT BELOW U+10F46 — no font covers it. Chrome lays the
    // cell out right-to-left, so the .notdef tofu sits LEFT and the synthetic ◌
    // sits to its right. The capture probe flags index 0 (dottedCircleMarks).
    const r = insertSyntheticDottedCircles("\u{10F46}", undefined, fam, 400, 32, 0, undefined, undefined, [0]);
    expect(r.text).toBe("\u{10F46}◌"); // mark FIRST, ◌ after — NOT "◌ mark"
  });
  it("DM-1215: positions the appended ◌ past the RTL mark tofu's advance", () => {
    const r = insertSyntheticDottedCircles("\u{10F46}", [674.39, 674.39], fam, 400, 32, 0, undefined, undefined, [0]);
    expect(r.text).toBe("\u{10F46}◌");
    expect(r.xOffsets!.length).toBe(3); // surrogate pair + ◌
    expect(r.xOffsets![0]).toBeCloseTo(674.39, 3); // mark at the captured cell origin
    expect(r.xOffsets![1]).toBeCloseTo(674.39, 3);
    // ◌ shifted right by the mark tofu's advance so it clears the box rather than
    // overlapping it (the bug DM-1255/1261/1262/1265/1272/1273 reported).
    expect(r.xOffsets![2]).toBeGreaterThan(674.39 + 16);
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

describe("stripOrphanedDefaultIgnorables (DM-1158)", () => {
  // Font-independent by design (DM-1835): HarfBuzz hides default-ignorables
  // after shaping regardless of cmap coverage, so neither the family nor the
  // installed font set may change the answer. That also makes these assertions
  // deterministic on any machine — no MACOS_FONTS_DC gate needed.
  const run = (text: string, xOffsets?: number[]) =>
    stripOrphanedDefaultIgnorables(text, xOffsets);

  it("drops a lone variation selector (Chrome paints nothing)", () => {
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

  // DM-1835: the regression that motivated dropping the coverage gate. U+FE0F is
  // in Apple Color Emoji's cmap (a zero-advance, outline-less glyph), so the old
  // "only strip what the primary font does NOT cover" rule kept it — and the
  // variation-selector fixture painted a tofu box where Chrome paints nothing.
  it("drops a LONE U+FE0F even though emoji fonts map it in their cmap", () => {
    const r = run("️", [16]);
    expect(r.text).toBe("");
    expect(r.xOffsets).toEqual([]);
  });
  it("drops every orphaned selector in the FE00-FE0F block", () => {
    for (let cp = 0xFE00; cp <= 0xFE0F; cp++) {
      expect(run(String.fromCodePoint(cp), [16]).text).toBe("");
    }
  });
  it("drops orphaned supplement selectors and language tags", () => {
    expect(run("\u{E0100}", [16, 16]).text).toBe("");
    expect(run("\u{E0041}", [16, 16]).text).toBe("");
  });
  it("still keeps U+FE0F after an emoji base regardless of coverage", () => {
    // The emoji-presentation sequence must survive intact for the downstream
    // raster-overlay path; only the ORPHANED case is Chrome-invisible.
    expect(run("\u{1F600}️").text).toBe("\u{1F600}️");
  });
  it("resets the cluster base across whitespace, so a post-space selector is orphaned again", () => {
    const r = run("A ️", [0, 10, 20]);
    expect(r.text).toBe("A ");
    expect(r.xOffsets).toEqual([0, 10]);
  });
  it("drops a run of consecutive orphaned selectors", () => {
    const r = run("︀️︁B", [0, 0, 0, 12]);
    expect(r.text).toBe("B");
    expect(r.xOffsets).toEqual([12]);
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
    const out = renderTextAsPath("Hi", 0, top,
      { fontSize: 32, fontFamily: "Helvetica", fontWeight: "700", fill: "#000", ascentOverride: ascent });
    expect(baselineY(out)).toBe(top + ascent);
  });

  it.skipIf(!MACOS_FONTS)("falls back to fontkit ascent when no override given", () => {
    const top = 100;
    // No override — falls back to round(font.ascent * scale). The exact value
    // depends on the resolved font; we just assert the answer is *different*
    // from a clearly-wrong override, so the test fails if both branches end
    // up using the same code.
    const native = renderTextAsPath("Hi", 0, top, { fontSize: 32, fontFamily: "Helvetica", fontWeight: "700", fill: "#000" });
    const overridden = renderTextAsPath("Hi", 0, top,
      { fontSize: 32, fontFamily: "Helvetica", fontWeight: "700", fill: "#000", ascentOverride: 30 });
    expect(baselineY(native)).not.toBe(baselineY(overridden));
  });

  it.skipIf(!MACOS_FONTS)("scales the override correctly across font sizes", () => {
    // Same font, different sizes → override is applied verbatim, no extra math.
    const a = renderTextAsPath("Hi", 0, 0,
      { fontSize: 14, fontFamily: "Helvetica", fontWeight: "400", fill: "#000", ascentOverride: 13 });
    const b = renderTextAsPath("Hi", 0, 0,
      { fontSize: 50, fontFamily: "Helvetica", fontWeight: "400", fill: "#000", ascentOverride: 47 });
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
    const ink = measureInkMetrics("x", { fontSize: 22, fontFamily: "math", fontWeight: "400" });
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
    const ink = measureInkMetrics("∑", { fontSize: 22, fontFamily: "math", fontWeight: "400" });
    expect(ink).not.toBeNull();
    expect(ink!.inkAscent).toBeGreaterThan(0);
  });

  it.skipIf(!MACOS_FONTS)("gives a taller ink box to ∑ than to an x-height letter", () => {
    const sum = measureInkMetrics("∑", { fontSize: 22, fontFamily: "math", fontWeight: "400" })!;
    const ex = measureInkMetrics("x", { fontSize: 22, fontFamily: "math", fontWeight: "400" })!;
    // ∑ spans well above and below the baseline; its total ink height must
    // exceed a lowercase x's. This is the signal that made the operator sit
    // ~5 px low under the old font-ascent baseline.
    expect(sum.inkAscent + sum.inkDescent).toBeGreaterThan(ex.inkAscent + ex.inkDescent);
  });

  it.skipIf(!MACOS_FONTS)("reports a real descent for a descender glyph", () => {
    // 'p' hangs below the baseline; 'o' does not. Descent ordering must hold
    // so the proportional baseline split places descenders correctly.
    const p = measureInkMetrics("p", { fontSize: 22, fontFamily: "math", fontWeight: "400" })!;
    const o = measureInkMetrics("o", { fontSize: 22, fontFamily: "math", fontWeight: "400" })!;
    expect(p.inkDescent).toBeGreaterThan(o.inkDescent);
  });

  it("returns null when nothing renders an outline", () => {
    // Whitespace shapes to a blank advance with no ink — no usable bbox.
    expect(measureInkMetrics(" ", { fontSize: 22, fontFamily: "math", fontWeight: "400" })).toBeNull();
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
    // DM-1850: the append is gated on the family actually resolving on THIS
    // host (`generatedRouteUsable` → the helper's installed-family probe). On a
    // macOS font host the font is stock and the route appends; where it does
    // not resolve (Linux CI, a hidden-family run, no helper binary) the chain
    // stays ["cjk"] and the tone marks defer to the live per-codepoint
    // resolver — matching Chrome, which cannot fall back to an absent font
    // either.
    const expected = resolveInstalledFont("Arial Unicode MS") != null
      ? ["cjk", "u-arial-unicode-ms"]
      : ["cjk"];
    for (const cp of [0x302a, 0x302b, 0x302c, 0x302d, 0x302e, 0x302f]) {
      expect(darwinFallbackChain(cp)).toEqual(expected);
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
    const out = renderRadicalGlyph(261, 680, 22, 24, { fontSize: 22, fontFamily: "math", fontWeight: "400" }, "rgb(0,0,0)");
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
    const out = renderRadicalGlyph(261, 680, 22, 0, { fontSize: 22, fontFamily: "math", fontWeight: "400" }, "rgb(0,0,0)");
    expect(out).toBeNull(); // width <= 0 short-circuits
  });

  it("returns null for a non-positive box height", () => {
    expect(renderRadicalGlyph(0, 0, 0, 20, { fontSize: 22, fontFamily: "math", fontWeight: "400" }, "rgb(0,0,0)")).toBeNull();
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
  withNominationWalkDisarmed();
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
  withNominationWalkDisarmed();
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
    // ■ is one of the LucidaGrande-narrow carve-outs (DM-349) — but the
    // carve-out is now context-aware: a SERIF primary pulls the basic shapes
    // from Times New Roman first (CDP per-cp probe on 02-text-symbols: serif
    // ● → "Times New Roman"), falling through to the LucidaGrande chain for
    // any of the six the face lacks. Sans primaries keep the original chain.
    expect(darwinFallbackChain(0x25A0, "times")).toEqual(["times-new-roman", "lucida-grande", "symbols"]);
    expect(darwinFallbackChain(0x25A0, "helvetica")).toEqual(["lucida-grande", "symbols"]);
    expect(darwinFallbackChain(0x25CF, "courier")).toEqual(["menlo", "lucida-grande", "symbols"]);
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
    // serif primaries now pull ← → from Times New Roman first (CDP per-cp
    // probe on 02-text-symbols: serif → → "Times New Roman").
    expect(darwinFallbackChain(0x2190, "times")).toEqual(["times-new-roman", "lucida-grande", "symbols"]);
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
  // Split into two, because the two properties want opposite setups and running
  // them together made the guard fail for neither reason.
  //
  // It timed out on CI's `ubuntu-latest` at 30s (58s observed) while passing in
  // ~150ms on macOS and in the pinned noble container. The sweep is 3,072
  // codepoints x 3 primaries, and with the live resolver in the loop each one
  // can reach fontconfig over a CLI — so the cost is a function of the host, not
  // of the code under test. A structural guard that a barer machine cannot
  // afford to run is a guard that silently stops guarding.
  it("every emitted STATIC key resolves to a real font spec", () => {
    // Resolver OFF: this is the structural half, and the static chain is the
    // thing being checked. Turning it off makes the sweep pure table lookups —
    // fast and identical on every platform, which is what this guard is for.
    withSystemFallbackResolution(false, () => {
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
      // FONT_PATHS entry — exempt it. Every other key must resolve. Resolve
      // against the darwin table directly (not the host-platform resolver) so
      // this runs identically on Linux CI — `darwinFallbackChain` emits
      // darwin-only `u-...` routes that `LINUX_FONT_PATHS` deliberately lacks.
      const unresolved = [...keys].filter((k) =>
        k !== "last-resort" && !k.startsWith("sysfb:") && __resolveDarwinFontSpecForTest(k) == null);
      expect(unresolved, "a dangling/typo'd key paints tofu at runtime").toEqual([]);
    });
    // Explicit, generous timeout rather than a smaller sweep. Turning the live
    // resolver off removed one source of cost but not the other: building a
    // chain still probes whether each candidate FAMILY is installed, and on a
    // host where that reaches fontconfig over a CLI, 3,072 codepoints x 3
    // primaries is legitimately slow — 58s observed on CI's ubuntu-latest
    // against ~150ms on macOS.
    //
    // Exhaustiveness over the symbol/arrow/geometric ranges is the whole point
    // of this guard: it catches a dangling key that the per-codepoint
    // expectation tests miss, and a sampled version would catch it only by
    // luck. So the slow host gets more time rather than a weaker check.
  }, 180_000);

  it("registers every LIVE-resolver key it emits, so none is dangling", () => {
    // Resolver ON, but a sample rather than a sweep. The property is "a `sysfb:`
    // key is registered into the dynamic registry at the moment
    // `resolveSystemFallbackKeyForCp` returns it" — that is per-key and does not
    // need 3,072 codepoints to demonstrate. Sampling one per block it routes
    // keeps the live path exercised without making the cost a function of how
    // slow this host's fontconfig is.
    //
    // Deliberately NOT checked against the darwin table: which `sysfb:` keys
    // appear depends on the host's installed fonts, so table-checking them would
    // fail on any machine whose CoreText/fontconfig answers differ from the
    // calibration Mac — the opposite of what this is for.
    const keys = new Set<string>();
    for (const cp of [0x2190, 0x2500, 0x25A0, 0x2600, 0x2700, 0x2A00,
                      0x4E00, 0x3041, 0x30A1, 0xAC00, 0x0900, 0x0E00, 0x0600, 0x0590]) {
      for (const k of darwinFallbackChain(cp)) keys.add(k);
    }
    const sysfb = [...keys].filter((k) => k.startsWith("sysfb:"));
    const danglingDynamic = sysfb.filter((k) => __resolveFontSpecForTest(k) == null);
    expect(danglingDynamic, "live-resolver keys must be registered when emitted").toEqual([]);
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
    // The dingbat / chess / math-alphanumeric / letterlike routes DEFER to the
    // live fc-match resolver when it can cover the codepoint on a Linux host
    // (`linuxDeferOrStatic`, DM-1416) — the deferral returns an EMPTY chain so
    // the per-codepoint resolver, which queries the same fontconfig Chrome
    // does, makes the pick (verified on the noble image: Chrome paints ✂ from
    // FreeSans, and fc-match hands the resolver that same face). The static
    // routes asserted here are the resolver-off safety net, which is exactly
    // the calibration this test pins — so pin them with the resolver toggled
    // off, which also makes the assertions hold identically on every host.
    withSystemFallbackResolution(false, () => {
      expect(linuxFallbackChain(0x2500, "courier")).toEqual(["courier", "cjk"]);   // box-drawing, mono primary
      expect(linuxFallbackChain(0x2500)).toEqual(["helvetica", "cjk"]);            // box-drawing, sans primary
      expect(linuxFallbackChain(0x25A0)).toEqual(["helvetica", "cjk"]);            // geometric → Liberation Sans
      // ← → Liberation Sans; the arrows Liberation lacks (↖↘⇄…) defer to the
      // fc-match resolver, which picks Chrome's WenQuanYi (was a wrong static
      // FreeSans route — verified vs getPlatformFontsForNode).
      expect(linuxFallbackChain(0x2190)).toEqual(["helvetica"]);
      expect(linuxFallbackChain(0x2197)).toEqual(["cjk", "helvetica"]);            // ↗ diagonal → WenQuanYi
      expect(linuxFallbackChain(0x2702)).toEqual(["free-sans", "free-serif"]);     // dingbat → FreeSans
      expect(linuxFallbackChain(0x1D400)).toEqual(["free-sans", "free-serif"]);    // Math Alpha → FreeFont
    });
    // Production shape on a Linux host: with the resolver on, the deferring
    // routes hand the codepoint to fc-match exactly when it covers — an empty
    // chain — and keep the static net otherwise.
    if (process.platform === "linux" && getSystemFallbackResolution()) {
      for (const cp of [0x2702, 0x1D400]) {
        const expected = __resolveSystemFallbackKeyForCpForTest(cp) != null
          ? [] : ["free-sans", "free-serif"];
        expect(linuxFallbackChain(cp)).toEqual(expected);
      }
    }
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

// DM-1864: `win32FallbackChain` is now a thin adapter over the transcribed Blink
// stage, and its family→key step needs DirectWrite — so the calibration
// assertions live in `win-font-fallback.test.ts`, driven against synthetic font
// inventories. What stays here is the adapter's own contract, which IS
// host-independent once the family resolver is injected.
describe("win32FallbackChain: adapter over Blink's hardcoded Windows stage (DM-1864)", () => {
  afterEach(() => __setWin32FamilyKeyResolverForTest(null));

  /**
   * The measured desktop-Windows-11 inventory (see the fuller note in
   * `win-font-fallback.test.ts`): the 34 of Blink's 101 named families that a
   * default install actually has, per the win32 helper's DirectWrite
   * `FindFamilyName` — the call Blink's `IsFontPresent` makes.
   */
  const MEASURED_WIN11 = new Set([
    "cambria math", "courier new", "ebrima", "gadugi", "javanese text",
    "leelawadee ui", "lucida sans unicode", "malgun gothic", "microsoft himalaya",
    "microsoft jhenghei", "microsoft new tai lue", "microsoft phagspa",
    "microsoft sans serif", "microsoft tai le", "microsoft yahei",
    "microsoft yi baiti", "mongolian baiti", "ms pgothic", "mv boli",
    "myanmar text", "nirmala ui", "palatino linotype", "pmingliu-extb",
    "segoe ui", "segoe ui emoji", "segoe ui historic", "segoe ui symbol",
    "simsun", "simsun-extb", "simsun-extg", "sylfaen", "tahoma",
    "times new roman", "yu gothic",
  ]);

  const injectInventory = (present: Set<string>): void =>
    __setWin32FamilyKeyResolverForTest((family) =>
      present.has(family.toLowerCase()) ? `winfam:${family}` : null);

  it("emits the ONE family Blink nominates, then the pan-Unicode probe list", () => {
    injectInventory(MEASURED_WIN11);
    // Georgian: `kGeorgianFonts` = {Sylfaen, Segoe UI}. Sylfaen is installed, so it
    // is the single nomination — the second slot must NOT appear, because Blink
    // goes to the pan-Unicode list on a coverage miss, not to the script list's
    // next slot.
    const georgian = win32FallbackChain(0x10D0);
    expect(georgian[0]).toBe("winfam:Sylfaen");
    expect(georgian[1]).toBe("winfam:tahoma"); // head of kCommonFonts
    expect(georgian).not.toContain("winfam:Segoe UI");
  });

  it("routes Arabic + monospace to Courier New only for the monospace generic", () => {
    injectInventory(MEASURED_WIN11);
    // `FindMonospaceFontForScript` (Arabic/Hebrew + kMonospaceFamily). The
    // `monospace` generic resolves to the `courier` key on Windows.
    expect(win32FallbackChain(0x0628, "courier")[0]).toBe("winfam:courier new");
    // Any other primary is kStandardFamily → the Arabic script list (Tahoma first).
    expect(win32FallbackChain(0x0628, "helvetica")[0]).toBe("winfam:Tahoma");
    expect(win32FallbackChain(0x0628)[0]).toBe("winfam:Tahoma");
  });

  it("carries the generated per-block net only behind the live DirectWrite resolver", () => {
    // Off-Windows `win32DeferOrStatic` never defers, so the generated key is the
    // tail of the chain — the net for a host with no helper binary.
    injectInventory(MEASURED_WIN11);
    const chain = win32FallbackChain(0x1208); // Ethiopic — generated route: Ebrima
    expect(chain[chain.length - 1]).toBe("u-ebrima");
  });

  it("degrades to the generated net alone when no family is installed", () => {
    // `IsFontPresent` false for everything: `GetFallbackFamily` still returns
    // `lucida sans unicode`, but that family doesn't resolve either, so the whole
    // Blink stage contributes nothing and only the net remains.
    injectInventory(new Set());
    expect(win32FallbackChain(0x1208)).toEqual(["u-ebrima"]);
    expect(win32FallbackChain(0x05D0)).toEqual(["u-arial"]);
  });

  it("re-reads the inventory when it changes (no stale presence cache)", () => {
    // Transition: a host WITH the Hebrew pack (David), then the same process asked
    // about a default host without it, then back. The family→key cache must not
    // serve the first answer to the second — the injected-resolver seam clears it,
    // and the real resolver's cache is only ever populated from one host.
    const withDavid = new Set([...MEASURED_WIN11, "david"]);
    injectInventory(withDavid);
    expect(win32FallbackChain(0x05D0)[0]).toBe("winfam:David");
    injectInventory(MEASURED_WIN11);
    expect(win32FallbackChain(0x05D0)[0]).toBe("winfam:Segoe UI");
    injectInventory(withDavid);
    expect(win32FallbackChain(0x05D0)[0]).toBe("winfam:David");
  });

  // DM-1878: the cut inside the nominated family comes from the run's style,
  // because on Windows DirectWrite picks it INSIDE the family lookup — Blink's
  // `GetFontPlatformData(font_description, create_by_family)` →
  // `matchFamilyStyle(name, font_description.SkiaFontStyle())` →
  // `GetFirstMatchingFont(weight, stretch, style)`. There is no second in-family
  // re-selection step on Windows the way macOS has one, so a style dropped here
  // is a bold run painting the regular face: 222,874 of the first Windows
  // conformance baseline's 259,152 mismatches were same-family-wrong-cut.
  //
  // The paired requirement is that PRESENCE stays style-blind — Blink's
  // `IsFontPresent` is `matchFamilyStyle(name, SkFontStyle())` with the DEFAULT
  // style (`win/font_fallback_win.cc:54-59`), since a bold run does not change
  // whether a family is installed. Two calls, same API, different arguments;
  // collapsing them either way is the bug.
  describe("the run's style selects the cut, and only for selection (DM-1878)", () => {
    /** Record every (family, css) the chain asks about, in order. */
    const record = (): Array<{ family: string; css?: { weight: number; slant: number } }> => {
      const calls: Array<{ family: string; css?: { weight: number; slant: number } }> = [];
      __setWin32FamilyKeyResolverForTest((family, css) => {
        calls.push({ family, css: css == null ? undefined : { weight: css.weight, slant: css.slant } });
        if (!MEASURED_WIN11.has(family.toLowerCase())) return null;
        // Stand in for DirectWrite's cut selection: name the face, not the family.
        const cut = css == null ? "" : css.weight >= 600 ? "-Bold" : "";
        return `winfam:${family}${cut}`;
      });
      return calls;
    };

    // These drive `win32FallbackChain` directly rather than through
    // `fallbackFontChain`, which dispatches on `process.platform` and so cannot
    // reach the win32 branch from a macOS run — the same reason
    // `__resolveDarwinFontSpecForTest` exists. The dispatcher's one-line
    // forwarding is covered by the Windows CI unit job.
    it("asks with NO style while probing presence, and WITH the style when selecting", () => {
      const calls = record();
      win32FallbackChain(0x10D0, "helvetica", undefined, { weight: 700, slant: 0, fontSize: 20 });
      // Blink's stage probes candidate families first (`IsFontPresent`), then
      // instantiates the one it nominated.
      expect(calls.some((c) => c.css === undefined), "no style-blind presence probe happened").toBe(true);
      const selecting = calls.filter((c) => c.css !== undefined);
      expect(selecting.length, "the nominated family was never asked with the run's style").toBeGreaterThan(0);
      for (const c of selecting) expect(c.css).toEqual({ weight: 700, slant: 0 });
    });

    it("resolves a different cut for a bold run than for a regular one", () => {
      record();
      const regular = win32FallbackChain(0x10D0, "helvetica", undefined, { weight: 400, slant: 0, fontSize: 20 });
      const bold = win32FallbackChain(0x10D0, "helvetica", undefined, { weight: 700, slant: 0, fontSize: 20 });
      expect(regular[0]).toBe("winfam:Sylfaen");
      expect(bold[0]).toBe("winfam:Sylfaen-Bold");
      // The cut rides in the KEY, so the two runs cannot collide in any
      // downstream per-key cache or dynamic-spec registration.
      expect(bold[0]).not.toBe(regular[0]);
    });

    it("carries an italic + heavy description through unchanged", () => {
      // The description already existed on `fallbackFontChain` but was forwarded
      // ONLY to darwin — win32 dropped it, which is how the style never arrived.
      const calls = record();
      win32FallbackChain(0x10D0, "helvetica", undefined, { weight: 900, slant: 1, fontSize: 13 });
      const selecting = calls.filter((c) => c.css !== undefined);
      expect(selecting.length).toBeGreaterThan(0);
      for (const c of selecting) expect(c.css).toEqual({ weight: 900, slant: 1 });
    });

    it("still resolves when the caller has no description to offer", () => {
      // Callers without a style (the dotted-circle probe, the well-formedness
      // guards) must keep working — they get the family's default face, which is
      // exactly what the pre-change behavior was.
      const calls = record();
      const chain = win32FallbackChain(0x10D0, "helvetica");
      expect(chain[0]).toBe("winfam:Sylfaen");
      expect(calls.every((c) => c.css === undefined)).toBe(true);
    });
  });

  it("never emits a duplicate key, and never an empty-string key", () => {
    injectInventory(MEASURED_WIN11);
    for (const cp of [0x0041, 0x0628, 0x05D0, 0x0E01, 0x4E00, 0xAC00, 0x2211,
      0x2500, 0x2702, 0x1D400, 0x1F600, 0x10330, 0x2EBF0, 0x30000, 0xFF01]) {
      const chain = win32FallbackChain(cp);
      expect(new Set(chain).size, `duplicate key for U+${cp.toString(16)}`).toBe(chain.length);
      for (const k of chain) expect(k.length).toBeGreaterThan(0);
    }
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

  it("stays the tail of the chain, so every script still routes rather than tofuing", () => {
    // The generated table is the net BEHIND Blink's stage and the live
    // DirectWrite resolver (DM-1864), so on a host where no family resolves it is
    // the whole chain — which is what keeps these tail scripts off tofu when no
    // helper binary is available.
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
      expect(chain[chain.length - 1]).toBe(key);
    }
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
    const out = renderStretchyFenceGlyph("(", 10, 30, 20, { fontSize: 22, fontFamily: "sans-serif", fontWeight: "400" }, "rgb(0,0,0)");
    // Skips when the host has no resolvable font for '(' — but every supported
    // platform's sans-serif covers it, so this should render here.
    expect(out).not.toBeNull();
    expect(out).toContain("<use href=");
    expect(out).toMatch(/scale\([-0-9.]+,[-0-9.]+\)/);
    expect(out).toContain('fill="rgb(0,0,0)"');
  });

  it("stretches vertically with the box height (taller box → larger |sy|) while x-scale stays natural", () => {
    const short = renderStretchyFenceGlyph("(", 0, 0, 20, { fontSize: 22, fontFamily: "sans-serif", fontWeight: "400" }, "#000");
    const tall = renderStretchyFenceGlyph("(", 0, 0, 60, { fontSize: 22, fontFamily: "sans-serif", fontWeight: "400" }, "#000");
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
    expect(renderStretchyFenceGlyph("", 0, 0, 20, { fontSize: 22, fontFamily: "sans-serif", fontWeight: "400" }, "#000")).toBeNull();
    expect(renderStretchyFenceGlyph("(", 0, 0, 0, { fontSize: 22, fontFamily: "sans-serif", fontWeight: "400" }, "#000")).toBeNull();
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
    const out = renderTextAsPath(text, 0, 0,
      { fontSize: 16, fontFamily: "cursive", fontWeight: "400", fill: "#000", xOffsets });
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
    const out = renderTextAsPath("✨", 0, 0,
      { fontSize: 16, fontFamily: "Times", fontWeight: "400", fill: "#000", xOffsets: [0] });
    expect(out).toBeNull();
  });
  it("emits no <use> for U+1F600 😀 / U+1F680 🚀 (main emoji blocks)", () => {
    const out = renderTextAsPath("😀🚀", 0, 0,
      { fontSize: 16, fontFamily: "Times", fontWeight: "400", fill: "#000", xOffsets: [0, 0, 18, 18] });
    expect(out).toBeNull();
  });
  it.skipIf(!MACOS_FONTS)("emits text-but-no-emoji-tofu in mixed runs (Smile 😀)", () => {
    // Mixed text: "Smile 😀" — the "Smile " chars emit Times glyphs, the
    // 😀 codepoint suppresses its tofu. Without the suppression we'd see
    // 7 <use>s (S, m, i, l, e, space, tofu); with it we see 6 (no tofu).
    const out = renderTextAsPath("Smile 😀", 0, 0,
      { fontSize: 16, fontFamily: "Times", fontWeight: "400", fill: "#000", xOffsets: [0, 9, 18, 22, 26, 30, 34, 34] });
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
    const out = renderTextAsPath("abc", 0, 0, {
      fontSize: 16, fontFamily: "Helvetica", fontWeight: "400", fill: "#000",
      xOffsets: [0, 8, 16], features: ["smcp"],
    });
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
    const out = renderTextAsPath("ABC", 0, 0, {
      fontSize: 16, fontFamily: "Helvetica", fontWeight: "400", fill: "#000",
      xOffsets: [0, 10, 20], features: ["smcp"],
    });
    expect(out).not.toBeNull();
    const matches = out!.match(/scale\(([^,]+),/g) ?? [];
    const charScales = matches.slice(1, 4).map((m) => parseFloat(m.replace(/scale\(/, "")));
    for (const s of charScales) {
      expect(s).toBeCloseTo(16 / 2048, 3);
    }
  });
});

describe("resolveFontKey: chain walking", () => {
  withNominationWalkDisarmed();
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
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 12, fontWeight: "400" }).underlineThickness).toBe(1);
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 14, fontWeight: "400" }).underlineThickness).toBe(1);
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }).underlineThickness).toBe(1);
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 18, fontWeight: "400" }).underlineThickness).toBe(1);
  });

  it("bumps to 2px stroke at heading sizes (≥ 20px)", () => {
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 22, fontWeight: "400" }).underlineThickness).toBe(2);
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 24, fontWeight: "400" }).underlineThickness).toBe(2);
    expect(getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 32, fontWeight: "400" }).underlineThickness).toBe(2);
  });

  it("emits underlineOffsetY = 1.5 × thickness", () => {
    const m14 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 14, fontWeight: "400" });
    expect(m14.underlineOffsetY).toBe(1.5);
    const m22 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 22, fontWeight: "400" });
    expect(m22.underlineOffsetY).toBe(3);
  });

  it("emits strikeoutOffsetY ≈ fontSize/3 above baseline", () => {
    const m14 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 14, fontWeight: "400" });
    expect(m14.strikeoutOffsetY).toBe(Math.round(14 / 3) + 0.5);
    const m22 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 22, fontWeight: "400" });
    expect(m22.strikeoutOffsetY).toBe(Math.round(22 / 3) + 1);
  });

  it("emits overlineOffsetY ≈ fontSize above baseline (top of em-box)", () => {
    const m14 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 14, fontWeight: "400" });
    expect(m14.overlineOffsetY).toBe(14 - 0.5);
    const m22 = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 22, fontWeight: "400" });
    expect(m22.overlineOffsetY).toBe(22 - 1);
  });

  it("honors explicit text-decoration-thickness length (DM-431)", () => {
    const m = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { thicknessOverride: "5px" });
    expect(m.underlineThickness).toBe(5);
    expect(m.underlineOffsetY).toBe(7.5);
    expect(m.strikeoutThickness).toBe(5);
    expect(m.overlineOffsetY).toBe(13.5);
  });

  it("falls back to auto thickness when text-decoration-thickness is 'auto' or 'from-font' (DM-431)", () => {
    const auto = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { thicknessOverride: "auto" });
    expect(auto.underlineThickness).toBe(1);
    const fromFont = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { thicknessOverride: "from-font" });
    expect(fromFont.underlineThickness).toBe(1);
  });

  it("adds explicit text-underline-offset to underlineOffsetY (DM-431)", () => {
    const m = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { underlineOffsetCss: "6px" });
    expect(m.underlineOffsetY).toBe(7.5);
  });

  it("falls back to auto offset when text-underline-offset is 'auto' (DM-431)", () => {
    const m = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { underlineOffsetCss: "auto" });
    expect(m.underlineOffsetY).toBe(1.5);
  });

  it("combines explicit thickness + offset overrides (DM-431)", () => {
    const m = getDecorationMetrics({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400" }, { thicknessOverride: "5px", underlineOffsetCss: "6px" });
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
    const gaps = computeSkipInkGaps("jumping", { fontSize: FS, fontFamily: FF, fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T });
    // 'j', 'p', 'g' all have stems crossing the underline band.
    expect(gaps.length).toBeGreaterThanOrEqual(2);
  });

  it("produces no gaps for ascender-only / x-height-only text", () => {
    const gaps = computeSkipInkGaps("alone", { fontSize: FS, fontFamily: FF, fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T });
    expect(gaps).toEqual([]);
  });

  it("merges adjacent / overlapping descender gaps", () => {
    const gaps = computeSkipInkGaps("ggg", { fontSize: FS, fontFamily: FF, fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T });
    // Three adjacent 'g' descenders may merge into one gap or stay separate
    // depending on the pad — guarantee non-overlapping output.
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i][0]).toBeGreaterThanOrEqual(gaps[i - 1][1]);
    }
  });

  it("returns empty when font cannot be resolved", () => {
    const gaps = computeSkipInkGaps("test", { fontSize: FS, fontFamily: "NotAFontFamily12345", fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T });
    expect(gaps).toEqual([]);
  });

  it("scales gaps when targetWidth diverges from fontkit's layout width", () => {
    const baseline = computeSkipInkGaps("jumping", { fontSize: FS, fontFamily: FF, fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T });
    if (baseline.length === 0) return;
    const stretched = computeSkipInkGaps("jumping", { fontSize: FS, fontFamily: FF, fontWeight: FW }, { decorationCenterYRel: Y, decorationThickness: T, targetWidth: 200 });
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
    const out = renderTextAsPath("Hi", 0, 0, { fontSize: 24, fontFamily: "SFTest", fontWeight: "500", fill: "#000" });
    expect(out).not.toBeNull();
    expect(out!).toContain('font-weight="500"');
    expect(out!).not.toContain('font-weight="100"');
  });

  it("omits font-weight when captured weight is 400 (CSS default)", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 100, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, { fontSize: 24, fontFamily: "SFTest", fontWeight: "400", fill: "#000" });
    expect(out).not.toBeNull();
    expect(out!).not.toContain("font-weight=");
  });

  it("emits the captured font-style, not the @font-face declared italic", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    // Page applies italic via CSS; engine synthesizes from upright variant.
    const out = renderTextAsPath("Hi", 0, 0,
      { fontSize: 24, fontFamily: "SFTest", fontWeight: "400", fill: "#000", fontStyle: "italic" });
    expect(out).not.toBeNull();
    expect(out!).toContain('font-style="italic"');
  });

  it("forwards font-variation-settings onto the <text> style attribute", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, {
      fontSize: 24, fontFamily: "SFTest", fontWeight: "400", fill: "#000",
      variationSettings: { wght: 540, opsz: 32 },
    });
    expect(out).not.toBeNull();
    expect(out!).toMatch(/style="font-variation-settings: 'wght' 540, 'opsz' 32"/);
  });

  it("omits style attribute when no variation-settings were captured", () => {
    if (fontBuf == null) return;
    registerWebfont("SFTest", 400, "normal", fontBuf);
    const out = renderTextAsPath("Hi", 0, 0, { fontSize: 24, fontFamily: "SFTest", fontWeight: "400", fill: "#000" });
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
    const out = renderTextAsPath("Hello", 0, 0, { fontSize: 24, fontFamily: "CustomFontA", fontWeight: "400", fill: "#000" });
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
    const out = renderTextAsPath("Hi!", 0, 0, { fontSize: 24, fontFamily: "CustomFontB", fontWeight: "400", fill: "#000" });
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
    const out = renderTextAsPath("AB", 0, 0, { fontSize: 24, fontFamily: "CustomFontE", fontWeight: "400", fill: "#000" });
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
    renderTextAsPath("AB", 0, 0, { fontSize: 24, fontFamily: "CustomFontC", fontWeight: "400", fill: "#000" });
    // Same family, distinct axes tuple → second entry.
    renderTextAsPath("CD", 0, 0, {
      fontSize: 24, fontFamily: "CustomFontC", fontWeight: "400", fill: "#000",
      variationSettings: { wght: 540 },
    });
    // Same family, third distinct axes tuple → third entry.
    renderTextAsPath("EF", 0, 0, {
      fontSize: 24, fontFamily: "CustomFontC", fontWeight: "400", fill: "#000",
      variationSettings: { wght: 100 },
    });
    const css = getEmbeddedFontFaceCss();
    const faceCount = (css.match(/@font-face/g) ?? []).length;
    expect(faceCount).toBe(3);
  });

  it("the same (font, axes) combo across calls shares one @font-face entry", async () => {
    if (fontBuf == null) return;
    registerWebfont("CustomFontD", 400, "normal", fontBuf);
    renderTextAsPath("AB", 0, 0, { fontSize: 24, fontFamily: "CustomFontD", fontWeight: "400", fill: "#000" });
    renderTextAsPath("CD", 0, 0, { fontSize: 24, fontFamily: "CustomFontD", fontWeight: "400", fill: "#000" });
    renderTextAsPath("EF", 0, 0, { fontSize: 24, fontFamily: "CustomFontD", fontWeight: "400", fill: "#000" });
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

describe("glyphIdForCp (DM-1712 null-safety)", () => {
  // Minimal FontInstance stub — only glyphForCodePoint matters here.
  const stub = (ret: { id: number } | null) =>
    ({ glyphForCodePoint: () => ret } as unknown as Parameters<typeof glyphIdForCp>[0]);

  it("returns the glyph id when the font resolves a glyph", () => {
    expect(glyphIdForCp(stub({ id: 42 }), 0x41)).toBe(42);
    expect(glyphIdForCp(stub({ id: 0 }), 0x41)).toBe(0);
  });

  it("coalesces a null return to 0 (.notdef / uncovered) instead of throwing", () => {
    // fontkit can hand back null for an unmapped codepoint (color-font /
    // missing-script cps on Linux/Windows); the coverage checks treat 0 as
    // "not covered", so the fallback chain is probed rather than crashing.
    expect(() => glyphIdForCp(stub(null), 0x2b50)).not.toThrow();
    expect(glyphIdForCp(stub(null), 0x2b50)).toBe(0);
  });
});

// A shaped glyph's UTF-16 source span must be measured against the SOURCE
// TEXT, never against the glyph's own `codePoints`.
//
// fontkit memoizes Glyph objects by glyph id, so a glyph reached from more than
// one source codepoint reports the codePoints of whichever codepoint FIRST
// materialized it. `.notdef` (id 0) is the acute case: every codepoint no font
// in the chain covers shares one Glyph, so once a BMP codepoint has missed, a
// later ASTRAL miss still reports the BMP one. A span derived from that counts
// 1 code unit where the surrogate pair consumed 2, the emitter's cursor lands
// mid-pair, and every later glyph in the run reads the wrong captured x — the
// synthetic dotted circle after an orphaned astral mark collapsed onto the
// mark's tofu instead of sitting beside it.
//
// Order-dependent by construction, which is why it only ever reproduced in a
// multi-fixture sweep: rendered alone, a fixture's first miss IS the astral one
// and the stale value happens to be right.
describe("sourceClusterSpan (shared-Glyph codePoints aliasing)", () => {
  it("measures an astral cluster as 2 code units even when the glyph claims BMP", () => {
    // The failing shape: source is a surrogate pair, the shared `.notdef`
    // reports one BMP codepoint. One source codepoint consumed → span 2.
    expect(sourceClusterSpan("\u{10F46}◌", 0, 1, false)).toBe(2);
  });

  it("measures a BMP cluster as 1 code unit", () => {
    expect(sourceClusterSpan("ු◌", 0, 1, false)).toBe(1);
    expect(sourceClusterSpan("abc", 1, 1, false)).toBe(1);
  });

  it("sums a multi-codepoint (ligature) cluster from the text's own widths", () => {
    expect(sourceClusterSpan("fi!", 0, 2, false)).toBe(2);                 // 2 BMP
    expect(sourceClusterSpan("\u{10F46}\u{10F47}", 0, 2, false)).toBe(4);  // 2 astral
    expect(sourceClusterSpan("a\u{10F46}", 0, 2, false)).toBe(3);          // mixed
  });

  it("walks backwards for an RTL run, whose cursor sits at the cluster END", () => {
    // Cursor at end of "𐽆" (2 units): one source codepoint back → span 2.
    expect(sourceClusterSpan("\u{10F46}", 2, 1, true)).toBe(2);
    expect(sourceClusterSpan("ab", 2, 1, true)).toBe(1);
    expect(sourceClusterSpan("a\u{10F46}", 3, 2, true)).toBe(3);
  });

  it("always advances the cursor, even past the end of the text", () => {
    // A zero span would spin the emitter's walk forever.
    expect(sourceClusterSpan("ab", 2, 1, false)).toBe(1);
    expect(sourceClusterSpan("ab", 0, 1, true)).toBe(1);
    expect(sourceClusterSpan("", 0, 3, false)).toBe(1);
  });
});

// The aliasing itself, pinned against real fontkit so the fix stays anchored to
// the library behavior that motivates it rather than to our own stub.
(MACOS_FONTS ? describe : describe.skip)("fontkit shares one .notdef Glyph across uncovered codepoints", () => {
  it("reports the FIRST miss's codePoints for a later astral miss", () => {
    const font = fontkit.openSync("/System/Library/Fonts/Supplemental/Arial Unicode.ttf") as unknown as {
      layout: (t: string) => { glyphs: Array<{ id: number; codePoints?: number[] }> };
    };
    // A BMP codepoint Arial Unicode MS lacks materializes `.notdef` first.
    const bmp = font.layout("ࡰ").glyphs[0];
    expect(bmp.id).toBe(0);
    // An ASTRAL miss now hands back that same cached Glyph — still BMP
    // codePoints, so a span derived from it would be 1 instead of 2.
    const astral = font.layout("\u{10F46}").glyphs[0];
    expect(astral.id).toBe(0);
    expect(astral.codePoints?.[0]).toBe(0x870);
    expect(sourceClusterSpan("\u{10F46}", 0, 1, false)).toBe(2);
  });
});

// The static per-block chain names a FAMILY; which CUT of it Chrome paints is
// CoreText's nearest-weight match, not a two-slot regular/bold split. Every
// expectation is Chrome's own answer, read off CDP
// `CSS.getPlatformFontsForNode` at that CSS weight.
const macCutHelper = process.platform === "darwin"
  && existsSync("tools/macos-glyph-extractor/domotion-glyph-paths");

(macCutHelper ? describe : describe.skip)("static fallback chain — in-family cut selection", () => {
  const at = (cp: number, family: string, weight: number): string =>
    (__resolveFontForCodepointForTest(cp, family, weight, 16)?.key ?? "-").replace("sysfb:", "");

  it("walks Songti SC's four cuts for Han under a serif primary", () => {
    // `cjk-serif` IS STSongti-SC-Light, so 100-300 keep the base key.
    if (at(0x4F60, "Times", 300) !== "cjk-serif") return; // Songti absent
    expect(at(0x4F60, "Times", 400)).toBe("STSongti-SC-Regular");
    expect(at(0x4F60, "Times", 449)).toBe("STSongti-SC-Regular");
    expect(at(0x4F60, "Times", 450)).toBe("STSongti-SC-Bold");
    expect(at(0x4F60, "Times", 700)).toBe("STSongti-SC-Bold");
    expect(at(0x4F60, "Times", 900)).toBe("STSongti-SC-Black");
  });

  it("walks Apple SD Gothic Neo's full ladder for Hangul", () => {
    if (at(0xAC00, "sans-serif", 400) !== "korean") return; // face absent
    expect(at(0xAC00, "sans-serif", 100)).toBe("AppleSDGothicNeo-Thin");
    expect(at(0xAC00, "sans-serif", 500)).toBe("AppleSDGothicNeo-Medium");
    expect(at(0xAC00, "sans-serif", 600)).toBe("AppleSDGothicNeo-SemiBold");
    expect(at(0xAC00, "sans-serif", 700)).toBe("AppleSDGothicNeo-Bold");
  });

  // Blink buckets the CSS weight with `(weight - 50) / 100` integer division
  // before handing CoreText a weight trait, so every crossover lands on a
  // xx50 boundary rather than on a round hundred. Chrome measured at
  // 449 → LucidaGrande, 450 → LucidaGrande-Bold, and Songti moves at the same
  // point — a curve fit sampled at multiples of 100 could not have found this.
  it("crosses to the bold cut at the xx50 bucket boundary, like Blink", () => {
    if (at(0x05D0, "sans-serif", 400) !== "lucida-grande") return; // face absent
    expect(at(0x05D0, "sans-serif", 449)).toBe("lucida-grande");
    expect(at(0x05D0, "sans-serif", 450)).toBe("LucidaGrande-Bold");
  });

  // Chrome's own answer for Thai, read off CDP `CSS.getPlatformFontsForNode` on
  // macOS: a `sans-serif` run paints the PUBLIC `Thonburi` family (`Thonburi` /
  // `Thonburi-Bold`), while only a `system-ui` run paints the hidden
  // `.ThonburiUI` cut — the UI font's own cascade is what reaches it.
  //
  // The static chain's `thai` key hardcoded the hidden `.ThonburiUI-Regular` for
  // EVERY stack, so it gave the system-ui answer to all of them and was wrong on
  // both assertions below. This test used to pin that wrong answer, which is the
  // sampled-table failure mode in miniature: the expectation was our table's
  // output rather than Chrome's. Asking the OS first splits the two stacks apart,
  // because the cascade base differs between them.
  it("paints the public Thai family for a sans-serif run, like Chrome", () => {
    if (at(0x0E01, "sans-serif", 400) === "-") return;
    expect(at(0x0E01, "sans-serif", 400)).toBe("Thonburi");
    expect(at(0x0E01, "sans-serif", 700)).toBe("Thonburi-Bold");
  });

  // Regression pin for a silent corruption: CoreText refuses to resolve Apple's
  // hidden `.`-prefixed faces BY NAME and hands back Times New Roman without
  // erroring, so asking for `.ThonburiUI-Regular`'s family by name walked Times'
  // cascade and answered with an unrelated family. The cascade base must be
  // opened from its FILE.
  //
  // Asserted as a property rather than one exact face, because which Thai face is
  // correct now depends on the stack (see above) — but NO stack may ever leave
  // the Thai family. A Times/Helvetica answer here is the corruption returning.
  it("keeps a Thai run inside a Thai family, never Times", () => {
    for (const weight of [400, 700]) {
      const key = at(0x0E01, "sans-serif", weight);
      if (key === "-") continue;
      expect(key).toMatch(/Thonburi|^thai$/);
    }
  });
});

// DM-1849 — the REMAINING `glyph.codePoints` reads, audited after DM-1804 fixed
// the two source-span walks it had proven defects for.
//
// Same hazard throughout: fontkit memoizes one `Glyph` per glyph id, so any
// decision about WHICH character a glyph stands for must read the source text.
// `.notdef` (id 0) is the acute case — every uncovered codepoint in a font
// shares one instance whose `codePoints` is whichever codepoint materialized it
// first in the process. That is process-global state, so none of these
// reproduce in a single-fixture run: the first miss is then the fixture's own.
describe("codePoints aliasing — the audited sites (DM-1849)", () => {
  // `computeSkipInkGaps` walked a char cursor by summing `cp > 0xFFFF ? 2 : 1`
  // over each glyph's `codePoints` — a THIRD source-span walk of exactly the
  // kind DM-1804 fixed, missed because it lives in the decoration path rather
  // than the emitter. With a shared `.notdef` reporting BMP, an astral character
  // advanced the cursor by 1 instead of 2 and every later glyph in the run read
  // the wrong captured x, misplacing skip-ink gaps from that point on.
  //
  // Driven through the real function: the assertion is that an astral source
  // character does not desynchronize the cursor, which shows up as gaps that
  // stay inside the run's own width.
  (MACOS_FONTS ? it : it.skip)("keeps the skip-ink cursor aligned across an astral character", () => {
    const text = "a\u{10F46}b";
    const gaps = computeSkipInkGaps(text, { fontSize: 32, fontFamily: "Times", fontWeight: 400, fontStyle: "normal" }, { decorationCenterYRel: 0, decorationThickness: 1 });
    // Never throws, and every gap is a finite ordered interval — a cursor that
    // walked off the text produced NaN/reversed pairs here.
    for (const [lo, hi] of gaps) {
      expect(Number.isFinite(lo)).toBe(true);
      expect(Number.isFinite(hi)).toBe(true);
      expect(hi).toBeGreaterThanOrEqual(lo);
    }
  });

  // The span helper is what both walks now share, so pin the astral case for the
  // decoration path's indices specifically (cursor mid-string, not at 0).
  it("measures an astral cluster from a mid-string cursor", () => {
    // "a𐽆b" — cursor at 1 sits on the surrogate pair; one source codepoint → 2.
    expect(sourceClusterSpan("a\u{10F46}b", 1, 1, false)).toBe(2);
    // ...and the character after it is BMP again.
    expect(sourceClusterSpan("a\u{10F46}b", 3, 1, false)).toBe(1);
  });

  // These two predicates are the gate on Blink's no-system-fallback rule
  // (`platform/fonts/font_cache.cc:242-244`, rev 7d859f27): a private-use or
  // noncharacter codepoint never reaches per-codepoint font fallback at all, so
  // the run stays on its primary and paints that font's `.notdef`.
  it("classifies private-use source characters independently of any glyph", () => {
    // The three PUA ranges — `Character::IsPrivateUse` is general category Co.
    expect(isPrivateUseCodepoint(0xE000)).toBe(true);
    expect(isPrivateUseCodepoint(0xF8FF)).toBe(true);
    expect(isPrivateUseCodepoint(0xF0000)).toBe(true);
    expect(isPrivateUseCodepoint(0x10FFFD)).toBe(true);
    // A real script character must NOT be gated — one landing in this predicate
    // is how a legitimate system fallback would silently stop being asked for.
    expect(isPrivateUseCodepoint(0x0870)).toBe(false);
    expect(isPrivateUseCodepoint(0x10F46)).toBe(false);
  });

  // `Character::IsNonCharacter` is ICU's `U_IS_UNICODE_NONCHAR` (`character.cc:294`).
  it("classifies noncharacters the way U_IS_UNICODE_NONCHAR does", () => {
    // The contiguous Arabic-Presentation-Forms-A block of 32.
    expect(isNonCharacterCodepoint(0xFDD0)).toBe(true);
    expect(isNonCharacterCodepoint(0xFDEF)).toBe(true);
    // ...and the last two codepoints of EVERY plane, not just the BMP. Blink
    // names U+FFFE specifically (it appears on real pages as an encoding
    // sentinel, and running fallback for it cost a memory regression).
    expect(isNonCharacterCodepoint(0xFFFE)).toBe(true);
    expect(isNonCharacterCodepoint(0xFFFF)).toBe(true);
    expect(isNonCharacterCodepoint(0x1FFFE)).toBe(true);
    expect(isNonCharacterCodepoint(0x10FFFF)).toBe(true);
    // Immediately outside the FDD0..FDEF window, both sides.
    expect(isNonCharacterCodepoint(0xFDCF)).toBe(false);
    expect(isNonCharacterCodepoint(0xFDF0)).toBe(false);
    // Ordinary characters, including one whose low bits look close.
    expect(isNonCharacterCodepoint(0x0041)).toBe(false);
    expect(isNonCharacterCodepoint(0xFFFD)).toBe(false);  // REPLACEMENT CHARACTER
    expect(isNonCharacterCodepoint(0x1FFFD)).toBe(false);
    // Out of range entirely.
    expect(isNonCharacterCodepoint(0x110000)).toBe(false);
  });

  // The behavioural half: the resolver must not hand these codepoints to a
  // system-fallback face. Pinned with the exact codepoints upstream's own
  // `FontCacheTest.NoFallbackForPrivateUseArea` asserts null for
  // (`font_cache_test.cc:44-61`), so a future change to our fallback ordering
  // is measured against Chromium's list rather than against ours.
  //
  // U+100000 is the discriminating one and the reason this test exists: macOS
  // CoreText answers `SFCompact-Regular` for it (Apple keeps SF Symbols in
  // plane 16), so a resolver that simply asks the OS gets a real, plausible,
  // WRONG face — and it renders as a glyph rather than as a tofu, which is why
  // no pixel threshold flagged it. The rest of the list would pass against a
  // resolver that merely fails to find anything.
  it("performs no system fallback for private-use or noncharacter codepoints", () => {
    // The contract is "stays on the declared PRIMARY", whatever key the
    // nomination stage produced for it — the static `helvetica` key on
    // macOS / disarmed hosts, a `sysfb:` registration where the Linux
    // nomination walk accepted the name — so assert against the resolver's
    // own primary rather than a literal spelling.
    const primaryKey = resolveFontKey("Helvetica, sans-serif");
    for (const cp of [0xE000, 0xE401, 0xE402, 0xE403, 0xF0000, 0xFAAAA, 0x100000, 0x10AAAA,
      0xFDD0, 0xFFFE, 0xFFFF, 0x10FFFF]) {
      const r = __resolveFontForCodepointForTest(cp, "Helvetica, sans-serif");
      expect(r, `U+${cp.toString(16)}`).not.toBeNull();
      // `covered: false` is the kOutOfLuck terminal — the caller then paints the
      // primary's `.notdef`, which is what Chrome paints.
      expect(r!.covered, `U+${cp.toString(16)} must not be covered`).toBe(false);
      // Never a live system-fallback face, and never the LastResort tail.
      expect(r!.key, `U+${cp.toString(16)} key`).toBe(primaryKey);
    }
  });

  // The other side of the same rule, so the gate can't be "fixed" by disabling
  // fallback wholesale: U+F8FF is private-use AND macOS Helvetica has a real
  // glyph for it (the Apple logo). Blink skips only the SYSTEM-fallback stage;
  // the declared families are still walked, so this one must still be covered.
  it("still paints a private-use codepoint the DECLARED family covers", () => {
    // The declared-family walk is the same on every platform; what differs is
    // the face the `helvetica` key opens. macOS Helvetica genuinely carries
    // U+F8FF (the Apple logo), so the walk covers it there; Liberation Sans —
    // the key's Linux face — does not, so Blink's skip-system-fallback rule
    // makes the primary's `.notdef` the correct paint (verified on the noble
    // image via getPlatformFontsForNode: Chrome reports Liberation Sans, the
    // primary itself, for U+F8FF). Either way the key must stay on the
    // declared primary — never a system-fallback face, never the LastResort
    // tail — and `covered` must equal what the declared face's cmap says.
    const primaryKey = resolveFontKey("Helvetica, sans-serif");
    const face = getFontInstance(primaryKey, 400, 16, 0);
    const declaredFaceCovers = face != null && glyphIdForCp(face, 0xF8FF) !== 0;
    // Keep the positive branch discriminating where it can be: on a macOS font
    // host the declared family must genuinely cover (if this ever flips, the
    // codepoint no longer tests the declared-family walk — re-pick it).
    if (MACOS_FONTS) expect(declaredFaceCovers).toBe(true);
    const r = __resolveFontForCodepointForTest(0xF8FF, "Helvetica, sans-serif");
    expect(r).not.toBeNull();
    expect(r!.covered).toBe(declaredFaceCovers);
    expect(r!.key).toBe(primaryKey);
  });

  // The RENDER half of the same rule, which the resolver assertions above
  // cannot reach: the resolver already answered `helvetica`/uncovered for
  // U+E000, and the glyph-path emitter then overrode that terminal with the
  // fallback chain's LAST entry — LastResort, whose cmap covers every codepoint
  // — so the run painted a rounded box with a `?` in it, 2253/2048 em wide
  // against Helvetica's 1298. Since the ADVANCE came from the capture and was
  // Chrome's, the extra ink ran over the following character.
  //
  // Asserted against the outline's own coordinate extremes rather than a
  // literal `d`, so the path serializer stays free to change: Helvetica's
  // `.notdef` is a hollow rect spanning y 0..1469, LastResort's descends to
  // -200 and reaches 2047 — no threshold needed to tell them apart.
  it.skipIf(!MACOS_FONTS)("paints the PRIMARY font's .notdef for an uncovered private-use codepoint", () => {
    clearGlyphDefs();
    setRenderTextMode("paths");
    const out = renderTextAsPath("\u{E000}", 0, 0, { fontSize: 32, fontFamily: "Helvetica", fontWeight: "400", fill: "#000" });
    expect(out).not.toBeNull();

    const defs = getGlyphDefs();
    const ds = [...defs.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    expect(ds.length).toBe(1);
    const nums = ds[0].match(/-?\d+(?:\.\d+)?/g)!.map(Number);

    type Bbox = { minX: number; minY: number; maxX: number; maxY: number };
    const ttc = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc") as unknown as {
      fonts: { postscriptName: string; getGlyph(id: number): { bbox: Bbox } }[];
    };
    const helvetica = ttc.fonts.find((f) => f.postscriptName === "Helvetica")!;
    const notdef = helvetica.getGlyph(0);
    expect(Math.min(...nums)).toBe(Math.min(notdef.bbox.minX, notdef.bbox.minY));
    expect(Math.max(...nums)).toBe(Math.max(notdef.bbox.maxX, notdef.bbox.maxY));
  });

  // RTL detection compared the first glyph's codepoint against the run's last
  // character. When the first glyph is `.notdef` that comparison is against
  // process-global state, and it breaks BOTH ways: a stale value equal to the
  // run's last char fakes RTL on an LTR run, and a genuinely RTL run whose
  // first glyph is tofu gets walked LTR. The fallback is the run's own script.
  // `isRtlScriptCodepoint` is SMP-ONLY — the table behind it is literally
  // `RTL_SMP_SCRIPT_RANGES`. Pinned here because it reads like a general RTL
  // predicate and is not one: reaching for it as the fallback in the RTL
  // detection above would have walked BMP Hebrew and Arabic — the common case —
  // as LTR, while looking like a fix. Anything needing a general answer wants
  // bidi-js (`_RTL_RE` / `getEmbeddingLevels` in text.ts), not this.
  it("is SMP-only, and must not be used as a general RTL test", () => {
    expect(isRtlScriptCodepoint(0x10F46)).toBe(true);  // Sogdian — in range
    expect(isRtlScriptCodepoint(0x1E900)).toBe(true);  // Adlam
    expect(isRtlScriptCodepoint(0x05D0)).toBe(false);  // Hebrew alef — BMP, NOT covered
    expect(isRtlScriptCodepoint(0x0627)).toBe(false);  // Arabic alef — BMP, NOT covered
    expect(isRtlScriptCodepoint(0x0041)).toBe(false);  // Latin A
  });
});
