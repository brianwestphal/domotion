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
import { blinkAlternateFamilyName, getFontInstance, resolveFontKey, withSystemFallbackResolution } from "./font-resolution.js";
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

describeLinux("Linux declared-family NOMINATION walk (Blink's stack walk, transcribed)", () => {
  // These pin the nomination stage against what Chrome-on-noble actually
  // PAINTS, measured over CDP (tools/probe-1955-declared-walk.mjs run
  // in the pinned Playwright noble image): declared "Courier New"/"Courier"
  // paint Liberation Mono — via the metric-equivalence class and the
  // Courier → Courier New alias — NOT the WenQuanYi face the `monospace`
  // generic maps to; rejected names ("Menlo", "Consolas", "Helvetica Neue")
  // are walked PAST, so a bare stack of them lands on the `-webkit-standard`
  // stand-in (Liberation Serif), while a `…, monospace` stack still reaches
  // the generic's calibrated WenQuanYi route.
  it("nominates the metric-class face for a declared Courier New", () => {
    const key = resolveFontKey('"Courier New"');
    expect(key.startsWith("sysfb:")).toBe(true);
    expect(psName(key, 400)).toBe("LiberationMono");
    expect(psName(key, 550)).toBe("LiberationMono-Bold");
  });

  it("reaches the same face for bare Courier through Blink's alias retry", () => {
    const key = resolveFontKey("Courier");
    expect(psName(key, 400)).toBe("LiberationMono");
    expect(psName(key, 700)).toBe("LiberationMono-Bold");
  });

  it("walks past a rejected name instead of pinning its calibrated table face", () => {
    // Chrome-on-noble paints bare-"Menlo" / bare-"Consolas" stacks in
    // Liberation Serif (the family rejects, the stack exhausts, and the
    // `-webkit-standard` browser setting nominates "Times New Roman"). The
    // armed nomination walk asks fontconfig for that terminal too, so its
    // externally visible key is the exact `sysfb:` face rather than the
    // degraded table's logical `times` key. Assert the selected face, then
    // disable the mechanism to prove the old key is only the fallback arm.
    const menlo = resolveFontKey("Menlo");
    const consolas = resolveFontKey("Consolas");
    expect(menlo.startsWith("sysfb:")).toBe(true);
    expect(consolas.startsWith("sysfb:")).toBe(true);
    expect(psName(menlo, 550)).toBe("LiberationSerif-Bold");
    expect(psName(consolas, 400)).toBe("LiberationSerif");
    expect(withSystemFallbackResolution(false, () => resolveFontKey("Menlo"))).toBe("times");
  });

  it("keeps the generic keywords on their calibrated (un-transcribed) routes", () => {
    // `monospace` is a settings-mapped generic — its concrete family is a
    // browser-side value, NOT walkable from the renderer checkout — and
    // measured on noble it paints WenQuanYi Zen Hei Mono, which only the
    // calibrated route supplies in the degraded arm. With the matcher armed,
    // the browser setting's concrete family is resolved to its exact `sysfb:`
    // face; disabling it restores the calibrated logical key. Both select the
    // same PostScript face on the pinned image.
    const key = resolveFontKey("Menlo, monospace");
    expect(key.startsWith("sysfb:")).toBe(true);
    expect(psName(key, 400)).toBe("WenQuanYiZenHeiMono");
    expect(withSystemFallbackResolution(false, () => resolveFontKey("Menlo, monospace"))).toBe("courier");
  });

  it("accepts Helvetica through the Arial alias onto Liberation Sans", () => {
    const key = resolveFontKey("Helvetica");
    expect(psName(key, 400)).toBe("LiberationSans");
    expect(psName(key, 550)).toBe("LiberationSans-Bold");
  });

  it("disabling the resolver restores the calibrated static nomination", () => {
    // In-the-loop check for the WALK itself (not just the cut matcher): with
    // the flag off, "Courier New" must fall back to the static `courier-new`
    // key — the dedicated Liberation Mono metric-class route, the same face
    // the armed walk nominates (Chrome resolves the name directly; the
    // Courier alias is a lookup-failure retry only).
    const enabled = resolveFontKey('"Courier New"');
    const disabled = withSystemFallbackResolution(false, () => resolveFontKey('"Courier New"'));
    expect(enabled.startsWith("sysfb:")).toBe(true);
    expect(disabled).toBe("courier-new");
  });
});

// Pure transcription — runs on every platform (no helper, no fonts involved).
describe("blinkAlternateFamilyName (alternate_font_family.h:74-105, tag 147.0.7727.15)", () => {
  it("carries exactly Blink's six aliases, both directions where Blink has them", () => {
    expect(blinkAlternateFamilyName("Courier")).toBe("Courier New");
    expect(blinkAlternateFamilyName("Courier New")).toBe("Courier"); // !IS_WIN branch
    expect(blinkAlternateFamilyName("Times")).toBe("Times New Roman");
    expect(blinkAlternateFamilyName("Times New Roman")).toBe("Times");
    expect(blinkAlternateFamilyName("Arial")).toBe("Helvetica");
    expect(blinkAlternateFamilyName("Helvetica")).toBe("Arial");
  });

  it("compares ASCII-case-insensitively, like EqualIgnoringAsciiCase", () => {
    expect(blinkAlternateFamilyName("courier NEW")).toBe("Courier");
    expect(blinkAlternateFamilyName("HELVETICA")).toBe("Arial");
  });

  it("aliases nothing else", () => {
    for (const name of ["Georgia", "Menlo", "Consolas", "Helvetica Neue", "sans-serif", ""]) {
      expect(blinkAlternateFamilyName(name), name).toBeNull();
    }
  });
});
