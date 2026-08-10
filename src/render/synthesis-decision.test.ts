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

  it("uses the bold trait for a native-helper face that reports NO numeric weight (DM-2025)", () => {
    // The macOS PingFang/SF-Compact cuts and the Windows DirectWrite default
    // path are native-helper-backed: `createGlyphHelperFont` reports the
    // CoreText/DirectWrite bold trait at the instantiated axis but never
    // parses an OS/2 weight class, so `naturalWeight` is absent while
    // `faceIsBoldTrait` is present. Blink's macOS/Windows test is the trait
    // bit alone (`mac/font_cache_mac.mm:425-427`,
    // `win/font_cache_skia_win.cc:486-488`), so a non-bold face requested bold
    // MUST synthesize. Before the fix the up-front `naturalWeight == null`
    // bail returned false here, silently disabling synthetic bold for every
    // such face — this asserts the branch now decides on the signal it has.
    const helperNonBold: SynthesisFace = { faceIsBoldTrait: false };
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(helperNonBold, 700, undefined))).toBe(true);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(helperNonBold, 700, undefined))).toBe(true);
    // Just below each platform's threshold, still no synthesis — the trait is
    // consulted but the request isn't bold enough (darwin > 500, win32 >= 600).
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(helperNonBold, 500, undefined))).toBe(false);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(helperNonBold, 599, undefined))).toBe(false);

    // A native-helper face that IS bold (its trait set) must NOT double-bold,
    // whatever the request.
    const helperBold: SynthesisFace = { faceIsBoldTrait: true };
    expect(withHostPlatform("darwin", () => faceNeedsSyntheticBold(helperBold, 900, undefined))).toBe(false);
    expect(withHostPlatform("win32", () => faceNeedsSyntheticBold(helperBold, 900, undefined))).toBe(false);
  });

  it("degrades to no synthesis when a face reports NEITHER trait nor weight", () => {
    // Both signals absent (helper unavailable, no OS/2 read): we cannot tell
    // whether the face is already bold, so we must not synthesize — doing so
    // would double-bold a real Bold face. Preserves the pre-DM-2025 behavior
    // for this specific degenerate case on the threshold platforms.
    const noSignal: SynthesisFace = {};
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticBold(noSignal, 900, undefined))).toBe(false);
    }
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

describe("faceNeedsSyntheticOblique — platform-dispatched, not one predicate (DM-2016)", () => {
  const upright: SynthesisFace = { resolvedItalicAngle: 0 };
  const ITALIC = 14; // BLINK_ITALIC_SLOPE_VALUE — `italic` / bare `oblique`
  const OBLIQUE_30 = 30; // an explicit `oblique 30deg` request

  describe("macOS — ANY nonzero slope, tested against the CoreText trait", () => {
    // `mac/font_cache_mac.mm:431-436`: desired_italic = Style() (truthy for ANY
    // nonzero slope, not just the italic sentinel); synthetic = desired_italic
    // && !(traits & kCTFontTraitItalic).

    it("shears an upright face for `italic`", () => {
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(upright, ITALIC, undefined))).toBe(true);
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(upright, 0, undefined))).toBe(false);
    });

    it("ALSO shears for an explicit `oblique 30deg` — any nonzero slope counts", () => {
      // The clean divergence from Windows/Linux, and the reason a single
      // predicate cannot be transcribed: macOS's test has no equality check.
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(upright, OBLIQUE_30, undefined))).toBe(true);
    });

    it("asks the face's own ITALIC trait, not the outline heuristic, when the trait is known", () => {
      // A face whose post.italicAngle reads 0 (the heuristic would say
      // "needs a shear") but CoreText's kCTFontTraitItalic says it already
      // leans: the trait wins, mirroring `faceIsBoldTrait`'s
      // "asks the face's own BOLD flag ... not weight" test.
      const trueItalicTrait: SynthesisFace = { resolvedItalicAngle: 0, faceIsItalicTrait: true };
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(trueItalicTrait, ITALIC, undefined))).toBe(false);
      // Inverse: the heuristic would say "already leans" (angle -12°) but the
      // trait explicitly says NOT italic — the trait overrides that too.
      const falseItalicTrait: SynthesisFace = { resolvedItalicAngle: -12, faceIsItalicTrait: false };
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(falseItalicTrait, ITALIC, undefined))).toBe(true);
    });

    it("falls back to the outline heuristic only when the trait is absent", () => {
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique({ resolvedItalicAngle: -12 }, ITALIC, undefined))).toBe(false);
      // The routing flag exists because some `.ttc` members report an angle of
      // 0 despite a visibly slanted outline; shearing those doubled their lean.
      expect(withHostPlatform("darwin",
        () => faceNeedsSyntheticOblique({ resolvedItalicAngle: 0, isRoutedItalicCut: true }, ITALIC, undefined))).toBe(false);
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique({ hasSlantAxis: true }, ITALIC, undefined))).toBe(false);
    });
  });

  describe("Windows / Linux (general path) — EXACTLY kItalicSlopeValue (14), not any nonzero slope", () => {
    // `win/font_cache_skia_win.cc:490-493`, `skia/font_cache_skia.cc:341-345`:
    // both read `Style() == kItalicSlopeValue && !typeface->isItalic()` —
    // byte-identical rules, and an EQUALITY test rather than macOS's truthiness
    // one.

    it("shears an upright face for `italic` (== 14)", () => {
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique(upright, ITALIC, undefined))).toBe(true);
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(upright, ITALIC, undefined))).toBe(true);
    });

    it("does NOT shear for `oblique 30deg` — this is the split the ticket was filed about", () => {
      // The same upright face, the same "italic requested" intent, but a
      // DIFFERENT explicit angle: macOS synthesizes (any nonzero), Windows and
      // Linux do not (not exactly 14). One un-dispatched predicate cannot
      // produce both answers for the same inputs.
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique(upright, OBLIQUE_30, undefined))).toBe(false);
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(upright, OBLIQUE_30, undefined))).toBe(false);
      // …while macOS, from the block above, says true for the identical input.
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(upright, OBLIQUE_30, undefined))).toBe(true);
    });

    it("leaves a face that already leans alone — the outline heuristic, no trait signal here yet", () => {
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique({ resolvedItalicAngle: -12 }, ITALIC, undefined))).toBe(false);
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique({ hasSlantAxis: true }, ITALIC, undefined))).toBe(false);
    });

    it("prefers a native italic trait over the outline heuristic when reported", () => {
      const face: SynthesisFace = { resolvedItalicAngle: 0, faceIsItalicTrait: true };
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique(face, ITALIC, undefined))).toBe(false);
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(face, ITALIC, undefined))).toBe(false);
      const uprightTrait: SynthesisFace = { resolvedItalicAngle: -12, faceIsItalicTrait: false };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(uprightTrait, ITALIC, undefined))).toBe(true);
    });
  });

  it("obeys `font-synthesis-style: none` on every platform", () => {
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticOblique(upright, ITALIC, { style: false }))).toBe(false);
      // …and is not vetoed by the weight longhand.
      expect(withHostPlatform(p, () => faceNeedsSyntheticOblique(upright, ITALIC, { weight: false }))).toBe(true);
    }
  });

  it("routes a webfont run through the DESCRIPTOR rule, ignoring the file — platform-independent", () => {
    // Mirrors `faceNeedsSyntheticBold`'s webfont branch: the decision is made
    // in the CSS layer, so it must not consult the per-platform tests above.
    const webfont: SynthesisFace = {
      webfontFace: {
        declaredWeightCaps: null, wghtAxisMax: null, baseIsBold: false,
        declaredStyleCaps: [0, 0], slntAxisMin: null, baseIsItalic: false,
      },
    };
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticOblique(webfont, ITALIC, undefined))).toBe(true);
      expect(withHostPlatform(p, () => faceNeedsSyntheticOblique(webfont, 0, undefined))).toBe(false);
    }
  });

  it("a webfont declared already-italic does NOT synthesize, even though the general heuristic (which the pre-fix code had no branch to skip) would say yes", () => {
    // No `hasSlantAxis` / `isRoutedItalicCut` / `resolvedItalicAngle` are set
    // on this face, so the outline heuristic alone (what every platform fell
    // back to before this predicate had a `webfontFace` branch at all) reads
    // "does not already lean" and would call for a shear. The webfont
    // DESCRIPTOR says otherwise — `declaredStyleCaps: [14, 14]` means
    // `caps.maximum < kItalicSlopeValue` is false, so Blink's CSS-layer flag
    // never sets in the first place — and that must win.
    const alreadyItalicWebfont: SynthesisFace = {
      webfontFace: {
        declaredWeightCaps: null, wghtAxisMax: null, baseIsBold: false,
        declaredStyleCaps: [14, 14], slntAxisMin: null, baseIsItalic: false,
      },
    };
    for (const p of ["darwin", "win32", "linux"] as const) {
      expect(withHostPlatform(p, () => faceNeedsSyntheticOblique(alreadyItalicWebfont, ITALIC, undefined))).toBe(false);
    }
  });

  describe("a Linux LIVE-FALLBACK pick obeys fontconfig's own is_italic bit (DM-2017)", () => {
    // `linux/font_cache_linux.cc:118-125`: should_set_synthetic_italic =
    // !fallback_font.is_italic && description.Style() == kItalicSlopeValue —
    // an EQUALITY test here too. Mirrors the bold override above; overrides
    // the outline-angle test for this one stage rather than adding to it.

    it("shears a fallback face fontconfig reports as upright", () => {
      const uprightFallback: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      // Note the angle here (-12°) would, under the GENERAL rule, read as
      // "already leans" and skip the shear — proving this is a REPLACEMENT of
      // that test for a fallback pick, not an addition on top of it: Blink
      // trusts fontconfig's classification of the chosen face over the
      // outline's own reported angle at this stage.
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(uprightFallback, ITALIC, undefined))).toBe(true);
    });

    it("leaves a fallback face fontconfig reports as already italic alone", () => {
      // Inverse: angle 0 (would read "needs a shear" under the general rule)
      // but fontconfig says this candidate IS italic — no double-shear.
      const italicFallback: SynthesisFace = { resolvedItalicAngle: 0, linuxFallbackIsItalic: true };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(italicFallback, ITALIC, undefined))).toBe(false);
    });

    it("also requires EXACTLY kItalicSlopeValue, not any nonzero slope", () => {
      // The pre-fix code tested `slant !== 0` even on this branch — an
      // `oblique 30deg` request would have shorn a fallback face fontconfig
      // reports as upright, which Blink's `Style() == kItalicSlopeValue`
      // equality test does not.
      const uprightFallback: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      expect(withHostPlatform("linux", () => faceNeedsSyntheticOblique(uprightFallback, OBLIQUE_30, undefined))).toBe(false);
    });

    it("is Linux-only — darwin and win32 ignore the field entirely", () => {
      // `linuxFallbackIsItalic: false` would, on Linux, force a shear (see the
      // first test above) — but on darwin/win32 the field is not consulted at
      // all, so the outline heuristic alone decides: resolvedItalicAngle -12°
      // already leans, so NO shear on either platform.
      const face: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      expect(withHostPlatform("darwin", () => faceNeedsSyntheticOblique(face, ITALIC, undefined))).toBe(false);
      expect(withHostPlatform("win32", () => faceNeedsSyntheticOblique(face, ITALIC, undefined))).toBe(false);
    });

    it("still obeys `font-synthesis-style: none`", () => {
      const uprightFallback: SynthesisFace = { resolvedItalicAngle: -12, linuxFallbackIsItalic: false };
      expect(withHostPlatform("linux",
        () => faceNeedsSyntheticOblique(uprightFallback, ITALIC, { style: false }))).toBe(false);
    });
  });
});

describe("faceNeedsSyntheticOblique — geometry: the shear transform itself (paths mode, darwin)", () => {
  // Not pixels — a string check on the emitted transform, per DM-2016's own
  // gating instruction: the decoration-oracle-style guard for a geometry
  // question pixel-diff structurally cannot answer cleanly (rasterization
  // noise). This exercises the REAL parse-to-render path (`fontStyle` string
  // -> `blinkRequestedSlopeDegrees` -> `faceNeedsSyntheticOblique` -> the
  // `<g transform=...>` matrix), not the predicate in isolation.
  const render = (family: string, fontStyle: string, fontSynthesis?: { style?: boolean }): string | null => {
    const prev = getRenderTextMode();
    setRenderTextMode("paths");
    clearGlyphDefs();
    const m = renderTextAsPath("Hag", 0, 100, {
      fontSize: 100, fontFamily: family, fontWeight: "400", fontStyle, fill: "#000",
      ascentOverride: 0, fontSynthesis,
    });
    setRenderTextMode(prev);
    return m;
  };
  const hasShearMatrix = (markup: string | null): boolean => /matrix\(1,0,-?[\d.]+,1,0,0\)/.test(markup ?? "");

  // Keyed on the DECISION, same pattern as the bold frame-placement tests
  // below: a host without a matching upright family skips rather than fails,
  // and a host WITH one fails if the shear ever goes missing.
  const uprightFamily = ["Papyrus", "Comic Sans MS", "system-ui"].find((f) => {
    const face = resolveFont(f, 400, 100, 14);
    return face != null && faceNeedsSyntheticOblique(face, 14, undefined);
  });
  const itIf = uprightFamily != null ? it : it.skip;

  itIf("emits the shear matrix for `italic` on a face with no italic sibling", () => {
    expect(hasShearMatrix(render(uprightFamily!, "italic"))).toBe(true);
  });

  itIf("emits no shear at all for `normal`", () => {
    expect(hasShearMatrix(render(uprightFamily!, "normal"))).toBe(false);
  });

  itIf("`font-synthesis-style: none` suppresses the shear end-to-end", () => {
    expect(hasShearMatrix(render(uprightFamily!, "italic", { style: false }))).toBe(false);
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
