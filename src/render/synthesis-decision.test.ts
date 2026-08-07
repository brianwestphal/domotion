/**
 * The shared font-synthesis DECISIONS (DM-1984), and — the part that is easy to
 * lose — the fact that both render modes read them rather than each deriving
 * their own.
 *
 * The predicates were extracted from `renderTextAsEmbedded`, where paths mode
 * could not reach them; that is why paths mode shipped with no synthesis at
 * all. Re-inlining either one, or adding a second derivation at the paths site,
 * is the regression these tests exist to catch — not a hypothetical, since this
 * area has already produced two disagreeing bold rules once.
 */
import { describe, expect, it } from "vitest";
import { withHostPlatform } from "./host-platform.js";
import {
  faceNeedsSyntheticBold, faceNeedsSyntheticOblique, synthesisAllowed, type SynthesisFace,
} from "./synthesis-decision.js";
import { renderTextAsPath, setRenderTextMode, getRenderTextMode } from "./text-to-path.js";
import { clearGlyphDefs, resolveFont } from "./font-resolution.js";

/** A static face declaring weight 400 and NOT declaring itself bold. */
const plain400: SynthesisFace = { naturalWeight: 400, faceIsBoldTrait: false };

describe("synthesisAllowed — absent means `auto`", () => {
  it("permits every kind when the allowance is absent", () => {
    expect(synthesisAllowed(undefined, "weight")).toBe(true);
    expect(synthesisAllowed(undefined, "style")).toBe(true);
    expect(synthesisAllowed(undefined, "smallCaps")).toBe(true);
  });

  it("is per-longhand — one `none` does not veto the others", () => {
    expect(synthesisAllowed({ weight: false }, "weight")).toBe(false);
    expect(synthesisAllowed({ weight: false }, "style")).toBe(true);
  });
});

describe("faceNeedsSyntheticBold — three platform rules, not one", () => {
  // The clean divergence, and the reason a single "Blink rule" cannot be
  // transcribed: weight 600 on a 400 face. macOS (`> 500`) and Windows
  // (`>= 600`) both synthesize; Linux's delta (`> 200 + face weight`) does not,
  // because 600 - 400 is 200 and the comparison is strict.
  it("splits at weight 600 on a 400 face", () => {
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(plain400, 600, undefined))).toBe(true);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(plain400, 600, undefined))).toBe(true);
    expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(plain400, 600, undefined))).toBe(false);
  });

  it("splits again at 550 — macOS synthesizes, Windows does not", () => {
    // macOS's threshold is 500 and Windows' is 600. They are different numbers
    // in Blink (`mac/font_cache_mac.mm:424-427` vs
    // `win/font_cache_skia_win.cc:486-488`), and 550 is the rung that proves
    // the two were not collapsed into one constant.
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(plain400, 550, undefined))).toBe(true);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(plain400, 550, undefined))).toBe(false);
  });

  it("asks the face's own BOLD flag on macOS and Windows, not its weight", () => {
    // A face declaring weight 500 that carries the bold trait: the threshold
    // platforms see a bold face and synthesize nothing, while Linux's delta
    // (800 - 500 = 300 > 200) does. Reading `naturalWeight >= 600` instead of
    // the flag would answer "not bold" here and synthesize on all three.
    const boldTrait500: SynthesisFace = { naturalWeight: 500, faceIsBoldTrait: true };
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(boldTrait500, 800, undefined))).toBe(false);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(boldTrait500, 800, undefined))).toBe(false);
    expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(boldTrait500, 800, undefined))).toBe(true);
  });

  it("falls back to the weight comparison only when the flag is absent", () => {
    const noFlag700: SynthesisFace = { naturalWeight: 700 };
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(noFlag700, 900, undefined))).toBe(false);
  });

  it("a variable face instantiated at the requested weight needs no synthetic bold", () => {
    // DM-2023: once `naturalWeight` / `faceIsBoldTrait` describe the
    // INSTANTIATED variation position — the same fact
    // `typeface->fontStyle().weight()` / `kCTFontTraitBold` describe for
    // Blink — each platform's own test below reaches "not bold" on its own,
    // with no dedicated variable-axis exemption needed. This is the case a
    // prior, now-deleted short-circuit existed to paper over: before the
    // reporting fix, a variable `wght` axis reached the outlines but never
    // the metadata, so `sf-pro` instanced at 700 reported the DEFAULT
    // instance's `naturalWeight: 400, faceIsBoldTrait: false` instead of the
    // instantiated position's.
    const instancedAt700: SynthesisFace = { naturalWeight: 700, faceIsBoldTrait: true };
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticBold(instancedAt700, 700, undefined))).toBe(false);
    }
  });

  it("obeys `font-synthesis-weight: none` on every platform", () => {
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticBold(plain400, 900, { weight: false }))).toBe(false);
    }
  });

  it("routes a webfont run through the DESCRIPTOR rule, ignoring the file", () => {
    // A webfont declared `font-weight: 400` requested at 700 synthesizes even
    // though the file itself is unremarkable, and the rule is platform-
    // independent — the decision is made in the CSS layer.
    const webfont: SynthesisFace = {
      naturalWeight: 400, faceIsBoldTrait: false,
      webfontFace: { declaredWeightCaps: [400, 400], wghtAxisMax: null, baseIsBold: false },
    };
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticBold(webfont, 700, undefined))).toBe(true);
      // …and at 500 it does NOT, because the webfont threshold is 600 — the
      // number macOS's system-font rule (500) would have gotten wrong.
      expect(withHostPlatform(p, () => faceNeedsSyntheticBold(webfont, 500, undefined))).toBe(false);
    }
  });

  describe("a Linux LIVE-FALLBACK pick obeys fontconfig's own is_bold bit, not the delta (DM-2017)", () => {
    // `linux/font_cache_linux.cc:110-117`: should_set_synthetic_bold =
    // !fallback_font.is_bold && description.Weight() >= kBoldThreshold(600).
    // A BINARY test, shaped like the Windows rule, that OVERRIDES whatever the
    // general Linux delta below would have computed for this one stage.

    it("synthesizes bold where the delta rule alone says no — the bug this ticket fixed", () => {
      // naturalWeight 500, requested 700: delta is exactly 200, and the delta
      // rule is a STRICT `>` — so a pure delta test (what shipped before this
      // fix, ignoring the fontconfig bit entirely) answers false here. A bold
      // run over a regular fallback face painted with no synthetic-bold
      // geometry at all: "too light", read as a rasterization gap rather than
      // the missing-logic bug it was.
      const nonBoldFallback: SynthesisFace = { naturalWeight: 500, linuxFallbackIsBold: false };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(nonBoldFallback, 700, undefined))).toBe(true);
      // Control: the SAME face/weight with the field absent (a declared-family
      // or static-chain face, never touched by this fix) still takes the old
      // delta rule and still says no — proving the new branch is additive, not
      // a change to every Linux face.
      const sameFaceNoFlag: SynthesisFace = { naturalWeight: 500 };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(sameFaceNoFlag, 700, undefined))).toBe(false);
    });

    it("suppresses a false-positive the delta rule alone would add", () => {
      // naturalWeight 400, requested 700: delta is 300 > 200, so the OLD Linux
      // rule alone says "synthesize" — but Blink's fallback override reads
      // fontconfig's own is_bold=true here and does not, because the chosen
      // face IS already bold. A regression that ignored the fontconfig bit
      // (or reverted to the delta) would double-embolden this face.
      const boldFallback: SynthesisFace = { naturalWeight: 400, linuxFallbackIsBold: true };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(boldFallback, 700, undefined))).toBe(false);
      const sameFaceNoFlag: SynthesisFace = { naturalWeight: 400 };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(sameFaceNoFlag, 700, undefined))).toBe(true);
    });

    it("uses the exact kBoldThreshold (600), not macOS's 500 or a rounded number", () => {
      const notBold: SynthesisFace = { naturalWeight: 300, linuxFallbackIsBold: false };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(notBold, 599, undefined))).toBe(false);
      expect(withHostPlatform("linux", () => faceNeedsSyntheticBold(notBold, 600, undefined))).toBe(true);
    });

    it("is Linux-only — darwin and win32 ignore the field entirely", () => {
      // The two threshold platforms have their own, already-correct rule
      // (`faceIsBoldTrait`); a fallback-only marker must not leak into them.
      const face: SynthesisFace = { naturalWeight: 500, faceIsBoldTrait: false, linuxFallbackIsBold: true };
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(face, 700, undefined))).toBe(true);
      expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(face, 700, undefined))).toBe(true);
    });

    it("still obeys `font-synthesis-weight: none`", () => {
      const nonBoldFallback: SynthesisFace = { naturalWeight: 500, linuxFallbackIsBold: false };
      expect(withHostPlatform("linux",
        () => faceNeedsSyntheticBold(nonBoldFallback, 700, { weight: false }))).toBe(false);
    });
  });
});

describe("faceNeedsSyntheticOblique", () => {
  const upright: SynthesisFace = { resolvedItalicAngle: 0 };

  it("shears an upright face when a slant is requested", () => {
    expect(faceNeedsSyntheticOblique(upright, -1, undefined)).toBe(true);
    expect(faceNeedsSyntheticOblique(upright, 0, undefined)).toBe(false);
  });

  it("leaves a face that already leans alone — by angle OR by routing", () => {
    expect(faceNeedsSyntheticOblique({ resolvedItalicAngle: -12 }, -1, undefined)).toBe(false);
    // The routing flag exists because some `.ttc` members report an angle of 0
    // despite a visibly slanted outline; shearing those doubled their lean.
    expect(faceNeedsSyntheticOblique({ resolvedItalicAngle: 0, isRoutedItalicCut: true }, -1, undefined)).toBe(false);
    expect(faceNeedsSyntheticOblique({ hasSlantAxis: true }, -1, undefined)).toBe(false);
  });

  it("obeys `font-synthesis-style: none`", () => {
    expect(faceNeedsSyntheticOblique(upright, -1, { style: false })).toBe(false);
    // …and is not vetoed by the weight longhand.
    expect(faceNeedsSyntheticOblique(upright, -1, { weight: false })).toBe(true);
  });

  describe("a Linux LIVE-FALLBACK pick obeys fontconfig's own is_italic bit (DM-2017)", () => {
    // `linux/font_cache_linux.cc:118-125`: should_set_synthetic_italic =
    // !fallback_font.is_italic && description.Style() == kItalicSlopeValue.
    // Mirrors the bold override above; overrides the outline-angle test for
    // this one stage rather than adding to it.

    it("shears a fallback face fontconfig reports as upright", () => {
      const uprightFallback: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      // Note the angle here (-12°) would, under the GENERAL rule, read as
      // "already leans" and skip the shear — proving this is a REPLACEMENT of
      // that test for a fallback pick, not an addition on top of it: Blink
      // trusts fontconfig's classification of the chosen face over the
      // outline's own reported angle at this stage.
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(uprightFallback, -1, undefined))).toBe(true);
    });

    it("leaves a fallback face fontconfig reports as already italic alone", () => {
      // Inverse: angle 0 (would read "needs a shear" under the general rule)
      // but fontconfig says this candidate IS italic — no double-shear.
      const italicFallback: SynthesisFace = { resolvedItalicAngle: 0, linuxFallbackIsItalic: true };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(italicFallback, -1, undefined))).toBe(false);
    });

    it("is Linux-only — darwin and win32 ignore the field entirely", () => {
      const face: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(face, -1, undefined))).toBe(false);
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique(face, -1, undefined))).toBe(false);
    });

    it("still obeys `font-synthesis-style: none`", () => {
      const uprightFallback: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      expect(withHostPlatform("linux",
        () => faceNeedsSyntheticOblique(uprightFallback, -1, { style: false }))).toBe(false);
    });
  });
});

/**
 * Where the frame is PLACED in paths mode. The measurement that settled it, on
 * a mixed Latin+CJK line at weight 700 with a Papyrus primary (no bold cut) and
 * a Hiragino fallback (which HAS one), best-shift IoU against Chrome:
 *
 *   per-run frame      0.9286
 *   plain control      0.8736
 *   no synthesis       0.8882   <- what paths mode shipped as
 *   OUTER-group frame  0.6997   <- worse than doing nothing
 *
 * The outer-group version loses because the fallback run already routes to a
 * real bold cut and needs no frame; giving it one closes the counters of glyphs
 * whose perimeter dwarfs the Latin run's. So this is not a stylistic preference
 * about where an attribute lives — it is the difference between an improvement
 * and a regression, and it is worth a test that says so.
 */
describe("paths mode puts the frame on the per-run group, not the outer one", () => {
  const render = (family: string, weight: number): string | null => {
    const prev = getRenderTextMode();
    setRenderTextMode("paths");
    clearGlyphDefs();
    const m = renderTextAsPath("Hag", 0, 100, {
      fontSize: 100, fontFamily: family, fontWeight: String(weight), fill: "#000", ascentOverride: 0,
    });
    setRenderTextMode(prev);
    return m;
  };
  /** The outer group is the one carrying `translate(`; the run groups carry `scale(`. */
  const outerGroup = (markup: string): string => markup.slice(0, markup.indexOf(">") + 1);

  // Keyed on the DECISION rather than on a family name, so a host without the
  // font skips instead of failing — and so a host WITH it fails if the frame
  // ever goes missing.
  const family = ["Papyrus", "system-ui", "Comic Sans MS"].find((f) => {
    const face = resolveFont(f, 700, 100, 0);
    return face != null && faceNeedsSyntheticBold(face, 700, undefined);
  });
  const itIf = family != null ? it : it.skip;

  itIf("emits the frame on a scaled run group and leaves the outer group clean", () => {
    const bold = render(family!, 700)!;
    expect(bold).toContain("stroke-width=");
    expect(outerGroup(bold), "the outer group must not carry the frame").not.toContain("stroke");
    expect(bold.slice(outerGroup(bold).length)).toContain("stroke=");
  });

  itIf("emits no frame at all when the predicate says no", () => {
    // Same family, weight 400: nothing to synthesize, so nothing is emitted —
    // which is also what makes the bold assertion above non-vacuous.
    expect(render(family!, 400)!).not.toContain("stroke");
  });
});
