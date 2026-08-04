// The SEAM between the Linux declared-family style matcher and the render path.
//
// Sibling of `darwin-declared-family-cut.test.ts`, for entirely different Blink
// code: on Linux the cut of a declared family comes from
// `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev fd139e79, the
// revision Chromium tag 147.0.7727.15 — the build Playwright pins — takes via
// DEPS), reached through `FontCache::CreateTypeface` →
// `skia::DefaultFontMgr()->matchFamilyStyle(...)`. The transcription lives in
// the Linux glyph helper's `familyMatch` query; these tests pin that
// `getFontInstance` actually ASKS it, that its answer replaces the two-slot
// `key` / `key-bold` routing, and that disabling the resolver restores the
// two-slot behavior (the disable-and-require-movement contract).
//
// The rungs are chosen to DISCRIMINATE. CSS 550 is the load-bearing one: the
// two-slot table crosses to bold at 600, while fontconfig's weight scoring
// (CSS 550 → fc 140 via Skia's anchor tables) already prefers Liberation
// Bold there — measured against Chrome over CDP in the pinned Playwright
// noble image (tools/family-match-conformance-linux.ts, 2,292/2,292 rows
// agree, Liberation Sans@550 → LiberationSans-Bold among them). A test that
// sampled only 400/700 would have passed before this seam existed.
//
// Linux-gated AND helper-gated: the faces asserted are the noble image's
// Liberation family, and an older helper binary that predates `familyMatch`
// degrades the seam to the two-slot table by design.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { getFontInstance, resolveFontKey, withSystemFallbackResolution } from "./font-resolution.js";
import { isGlyphHelperAvailable, resolveLinuxFamilyMatch } from "./glyph-helper.js";

const LIBERATION = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf";
const available = process.platform === "linux"
  && existsSync(LIBERATION)
  && isGlyphHelperAvailable()
  // An older helper answers "unknown query type" → null; the seam then
  // legitimately degrades, and there is nothing to pin.
  && resolveLinuxFamilyMatch("Liberation Sans", { weight: 700 }) != null;
const describeLinux = available ? describe : describe.skip;

const psName = (key: string, weight: number, slant = 0): string | undefined =>
  (getFontInstance(key, weight, 22, slant) as unknown as { postscriptName?: string } | null)?.postscriptName;

describeLinux("Linux declared-family cut selection in the render path", () => {
  it("crosses to the bold cut where fontconfig does, not at the table's 600", () => {
    // 550 discriminates: the sibling table answers Regular below 600; the
    // transcribed matcher (and Chrome, measured over CDP) answers Bold.
    expect(psName("arial", 550)).toBe("LiberationSans-Bold");
    expect(psName("helvetica", 550)).toBe("LiberationSans-Bold");
    expect(psName("times-new-roman", 550)).toBe("LiberationSerif-Bold");
  });

  it("keeps the regular cut through the light rungs and 500", () => {
    for (const w of [100, 300, 350, 400, 450, 500]) {
      expect(psName("arial", w), `weight ${w}`).toBe("LiberationSans");
    }
  });

  it("routes italic to a real cut of the family rather than shearing the roman", () => {
    expect(psName("arial", 400, -0.21)).toBe("LiberationSans-Italic");
    expect(psName("arial", 700, -0.21)).toBe("LiberationSans-BoldItalic");
    // …and the upright column is unaffected by having asked for italic.
    expect(psName("arial", 400)).toBe("LiberationSans");
  });

  it("re-cuts an author-declared installed family at the run's weight", () => {
    // The DM-1690 author-family branch resolves `font-family:"Liberation
    // Sans"` to a style-blind `sysfb:` key; recording the declared name is
    // what lets a weight-700 run reach the Bold cut instead of dilating the
    // regular outline.
    const key = resolveFontKey('"Liberation Sans"');
    expect(psName(key, 700)).toBe("LiberationSans-Bold");
    expect(psName(key, 400)).toBe("LiberationSans");
  });

  it("keeps the cuts distinct when weights interleave through the cache", () => {
    const seq: Array<[number, string]> = [
      [700, "LiberationSans-Bold"], [400, "LiberationSans"],
      [550, "LiberationSans-Bold"], [400, "LiberationSans"],
      [700, "LiberationSans-Bold"],
    ];
    for (const [w, want] of seq) expect(psName("arial", w), `weight ${w}`).toBe(want);
  });

  it("moves when the resolver is disabled — the in-the-loop contract", () => {
    // `DOMOTION_SYSTEM_FALLBACK=0` (here: the process-global toggle it feeds)
    // must change the answer at a discriminating rung. An unchanged answer
    // would mean something intercepted ahead of the matcher — the exact
    // failure mode that shipped a resolver returning nothing for weeks on
    // Windows while its flag read "default-on".
    const enabled = psName("arial", 550);
    const disabled = withSystemFallbackResolution(false, () => psName("arial", 550));
    expect(enabled).toBe("LiberationSans-Bold");
    expect(disabled).toBe("LiberationSans");
    expect(enabled).not.toBe(disabled);
  });
});
