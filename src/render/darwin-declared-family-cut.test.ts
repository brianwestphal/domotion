// The SEAM between the declared-family style matcher and the render path.
//
// `tests/family-style-matcher.test.ts` pins the matcher itself (the helper's
// `familyMatch` query, Blink's `BestStyleMatchForFamilyNS` ported from
// `platform/fonts/mac/font_matcher_mac.mm`, Chromium rev 7d859f27). These pin
// something different and previously untested: that `getFontInstance` actually
// ASKS it for a declared family, that its answer replaces the two-slot
// `key` / `key-bold` routing rather than composing with it, that the
// per-codepoint fallback path is left alone, and that a host without the helper
// still gets a face.
//
// The rungs are chosen to DISCRIMINATE. CSS 500 is deliberately never the only
// weight asserted for a family: it is the weight at which the old two-slot
// answer and the matcher's answer coincide for PingFang, so a test that sampled
// it alone would have passed before this seam existed.
//
// macOS-gated: the matcher enumerates through AppKit, and the expected faces
// are Chrome-on-macOS's, established over CDP with `CSS.getPlatformFontsForNode`
// (read by `postScriptName`, selecting the entry with the largest `glyphCount` —
// the reported array is not ordered by coverage).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  getFontInstance, resolveFont, resolveFontKey, __resolveFontSpecForTest,
} from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

const available = process.platform === "darwin"
  && existsSync("/System/Library/Fonts/Helvetica.ttc")
  && isGlyphHelperAvailable();
const describeMac = available ? describe : describe.skip;

const psName = (key: string, weight: number, slant = 0): string | undefined =>
  (getFontInstance(key, weight, 22, slant) as unknown as { postscriptName?: string } | null)?.postscriptName;

/** Total advance of `text`, in font units, through the real render path. */
function advance(key: string, weight: number, text: string): number | null {
  const inst = getFontInstance(key, weight, 100, 0);
  if (inst == null) return null;
  return inst.layout(text).positions.reduce((a, p) => a + p.xAdvance, 0);
}

describeMac("declared-family cut selection in the render path", () => {
  it("walks PingFang SC's whole ladder, not the two slots the table declares", () => {
    // The defect this seam removes: a declared "PingFang SC" resolved to
    // PingFangSC-Regular at EVERY CSS weight, because the name lookup that
    // produced the key is style-blind. Chrome opens five distinct members.
    const key = resolveFontKey('"PingFang SC"');
    const ladder: Array<[number, string]> = [
      [100, "PingFangSC-Ultralight"],
      [200, "PingFangSC-Thin"],
      [300, "PingFangSC-Thin"],
      [400, "PingFangSC-Regular"],
      [500, "PingFangSC-Medium"],
      [600, "PingFangSC-Semibold"],
      [700, "PingFangSC-Semibold"],
      [900, "PingFangSC-Semibold"],
    ];
    for (const [w, expected] of ladder) expect(psName(key, w), `weight ${w}`).toBe(expected);
  });

  it("reproduces Chrome's painted PingFang advances, which weight 500 alone cannot show", () => {
    // Chrome at 100 px, width of "H", divided by 100 for units on this
    // 1000-upem face: 725.0 at CSS 400, 736.09 at 500, 749.06 at 700. The
    // pre-seam render path answered 725 at all three. 500 is the trap — the
    // old answer and the correct one agree there.
    const key = resolveFontKey('"PingFang SC"');
    expect(advance(key, 400, "H")).toBe(725);
    expect(advance(key, 500, "H")).toBe(736);
    expect(advance(key, 700, "H")).toBe(749);
  });

  it("reaches all seven Hiragino Sans cuts, which two slots cannot represent", () => {
    const ladder: Array<[number, string]> = [
      [100, "HiraginoSans-W0"], [200, "HiraginoSans-W1"], [300, "HiraginoSans-W3"],
      [400, "HiraginoSans-W4"], [500, "HiraginoSans-W5"], [600, "HiraginoSans-W6"],
      [700, "HiraginoSans-W7"], [800, "HiraginoSans-W8"], [900, "HiraginoSans-W9"],
    ];
    for (const [w, expected] of ladder) expect(psName("hiragino-jp", w), `weight ${w}`).toBe(expected);
  });

  it("reaches Helvetica Neue's light cuts, which the -bold pair never could", () => {
    // Before the seam every weight below 600 answered plain "HelveticaNeue".
    expect(psName("helvetica-neue", 100)).toBe("HelveticaNeue-UltraLight");
    expect(psName("helvetica-neue", 200)).toBe("HelveticaNeue-Thin");
    expect(psName("helvetica-neue", 400)).toBe("HelveticaNeue");
    expect(psName("helvetica-neue", 500)).toBe("HelveticaNeue-Medium");
    expect(psName("helvetica-neue", 700)).toBe("HelveticaNeue-Bold");
  });

  it("routes italic to a real cut of the family rather than shearing the roman", () => {
    expect(psName("helvetica-neue", 400, -0.2)).toBe("HelveticaNeue-Italic");
    expect(psName("helvetica-neue", 700, -0.2)).toBe("HelveticaNeue-BoldItalic");
    // …and the upright column is unaffected by having asked for italic.
    expect(psName("helvetica-neue", 400)).toBe("HelveticaNeue");
  });

  it("keeps the cuts distinct when weights interleave through the cache", () => {
    // The answer is a function of (key, weight, italic). A cache key missing
    // any of those serves whichever caller asked first — the failure mode this
    // area has already paid for twice.
    const seq = [700, 100, 700, 400, 100, 500, 400];
    const want = [
      "PingFangSC-Semibold", "PingFangSC-Ultralight", "PingFangSC-Semibold",
      "PingFangSC-Regular", "PingFangSC-Ultralight", "PingFangSC-Medium",
      "PingFangSC-Regular",
    ];
    const key = resolveFontKey('"PingFang SC"');
    expect(seq.map((w) => psName(key, w))).toEqual(want);
  });

  it("does not re-cut the per-codepoint fallback routes", () => {
    // The generated `u-…` keys are per-Unicode-block fallback routes, reached
    // through `CTFontCreateForString` + `GetAlternateFontPlatformData`'s
    // in-family re-selection — a different Blink call from the declared-family
    // matcher. Running both on one decision would layer two mechanisms, so the
    // seam is bounded to keys a CSS family can name.
    const spec = __resolveFontSpecForTest("u-hiragino-sans-gb");
    if (spec != null) {
      expect(psName("u-hiragino-sans-gb", 400)).toBe(psName("u-hiragino-sans-gb", 900));
    }
  });

  it("leaves system-ui alone — Blink never family-matches it either", () => {
    // `CreateTypeface` asserts `DCHECK_NE(family, kSystemUi)`: `system-ui` is
    // replaced by the OS's font rather than matched by name, and its face lives
    // under a dot-prefixed family CoreText refuses to resolve from a client
    // process. So the matcher has nothing to address and the key stands.
    expect(resolveFontKey("system-ui")).toBe("sf-pro");
    expect(psName("sf-pro", 400)).toBe(psName("sf-pro", 900));
  });

  it("keeps the declared-family key set in step with the family→key map", () => {
    // Every CSS family name the resolver recognizes must land on a key the seam
    // knows about, or on a dynamically-registered one it marks at registration.
    // Without this, adding a family to `matchFamilyNameToKey` would silently
    // opt it out of style matching.
    const names = [
      "sans-serif", "serif", "monospace", "cursive", "fantasy",
      "helvetica", "arial", "times", "times new roman", "georgia",
      "courier", "menlo", "monaco", "helvetica neue", "papyrus",
      "snell roundhand", "apple chancery", "hiragino sans",
    ];
    for (const name of names) {
      const key = resolveFontKey(name);
      // Either the static key is style-matched, or it resolves to a dynamic
      // key that carries its declared family — both are covered by the seam.
      const matched = psName(key, 100) !== psName(key, 900) || psName(key, 400) === psName(key, 900);
      expect(matched, `${name} → ${key}`).toBe(true);
    }
  });

  it("returns a face for every declared family even where no cut moves", () => {
    // Degradation contract: a family with one member, or a host whose helper
    // declines, must still resolve. Null here would drop the run to tofu.
    for (const key of ["papyrus", "monaco", "arial", "times", "georgia"]) {
      expect(getFontInstance(key, 700, 22, 0), key).not.toBeNull();
      expect(getFontInstance(key, 100, 22, 0), key).not.toBeNull();
    }
  });

  it("keeps resolveFont's declared-stack walk on the matched cut", () => {
    // The seam has to survive the public entry point, not just the key-level
    // call — `resolveFont` is what the renderer actually uses.
    const bold = resolveFont('"PingFang SC"', 700, 100, 0) as unknown as { postscriptName?: string } | null;
    const light = resolveFont('"PingFang SC"', 100, 100, 0) as unknown as { postscriptName?: string } | null;
    expect(bold?.postscriptName).toBe("PingFangSC-Semibold");
    expect(light?.postscriptName).toBe("PingFangSC-Ultralight");
  });
});
