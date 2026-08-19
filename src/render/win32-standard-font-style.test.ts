/**
 * Windows stage 1 of `PlatformFallbackFontForCharacter`:
 * `FallbackOnStandardFontStyle` — "First try the specified font with standard
 * style & weight" (`win/font_cache_skia_win.cc:270-277`, Chromium rev
 * 7d859f27), running BEFORE the hardcoded per-script table. The shared helper
 * (`skia/font_cache_skia.cc:119-137`) retries the run's own family at normal
 * style and weight and accepts only a face that contains the character, so a
 * family whose bold/italic cut lacks a glyph its regular cut has stays in the
 * family (with synthetic bold/italic) instead of leaving it for whatever the
 * fallback stages prefer.
 *
 * The trigger threshold is `kBoldWeightValue = 700`
 * (`font_selection_types.h:193`) — NOT the `kBoldThreshold = 600` (`:182`)
 * the Linux copy of the stage uses — which is why the 600-weight arm below is
 * load-bearing rather than decorative.
 *
 * Construction: a synthetic multi-cut webfont family (400 = Arial Unicode MS,
 * which covers Armenian; 700 and italic = Verdana, which does not), resolved under a
 * win32 host override with the live resolver toggled off, so the case is
 * decided entirely by the retry stage and no platform helper is consulted.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clearWebfonts,
  getFontInstance,
  glyphIdForCp,
  registerWebfont,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  withSystemFallbackResolution,
} from "./font-resolution.js";
import { withHostPlatform } from "./host-platform.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUMS_PATH = "/Library/Fonts/Arial Unicode.ttf";
const VERDANA_PATH = "/System/Library/Fonts/Supplemental/Verdana.ttf";
const canRun = process.platform === "darwin" && existsSync(AUMS_PATH) && existsSync(VERDANA_PATH);

/** U+0531 ARMENIAN CAPITAL LETTER AYB — in Arial Unicode MS, not Helvetica. */
const AYB = 0x0531;

describe("win32 FallbackOnStandardFontStyle — win/font_cache_skia_win.cc:270-277, kBoldWeightValue=700 (font_selection_types.h:193), rev 7d859f27", () => {
  it.runIf(canRun)("a bold run whose regular cut covers the codepoint stays in the family, and the threshold is 700 — not Linux's 600", () => {
    try {
      registerWebfont("DM1854 Win Std", 400, "normal", readFileSync(AUMS_PATH));
      registerWebfont("DM1854 Win Std", 700, "normal", readFileSync(VERDANA_PATH));
      registerWebfont("DM1854 Win Std", 400, "italic", readFileSync(VERDANA_PATH));
      const family = '"DM1854 Win Std"';
      const key = resolveFontKey(family);
      expect(key.startsWith("webfont:")).toBe(true);
      // Preconditions that make the case discriminate: the requested cut lacks
      // the glyph, the standard cut carries it.
      const bold = resolveFont(family, 700, 16, 0, undefined);
      expect(bold).not.toBeNull();
      expect(glyphIdForCp(bold!, AYB)).toBe(0);
      const regular = getFontInstance(key, 400, 16, 0);
      expect(regular).not.toBeNull();
      expect(glyphIdForCp(regular!, AYB)).not.toBe(0);

      withHostPlatform("win32", () => withSystemFallbackResolution(false, () => {
        // Weight 700: Blink retries the family at standard style, finds the
        // glyph, and returns the family's own face (synthetic bold derives
        // downstream from the requested weight against it).
        const r700 = resolveFontForCodepoint(AYB, bold!, key, 700, 16, 0, undefined, undefined, [key]);
        expect(r700.covered).toBe(true);
        expect(r700.key).toBe(key);
        expect(r700.fontOverride).not.toBeNull();
        expect(glyphIdForCp(r700.fontOverride!, AYB)).not.toBe(0);

        // Weight 600: below kBoldWeightValue, so Blink does NOT retry on
        // Windows (600 is the LINUX threshold, kBoldThreshold). With the
        // retry correctly not firing and nothing else covering the codepoint
        // in this construction, the run stays uncovered.
        const bold600 = resolveFont(family, 600, 16, 0, undefined);
        expect(bold600).not.toBeNull();
        expect(glyphIdForCp(bold600!, AYB)).toBe(0);
        const r600 = resolveFontForCodepoint(AYB, bold600!, key, 600, 16, 0, undefined, undefined, [key]);
        expect(r600.covered).toBe(false);

        // Italic at normal weight triggers the same retry (Style() ==
        // kItalicSlopeValue is the other arm of Blink's condition): the
        // italic cut (registered as Verdana) lacks the glyph, the upright
        // standard cut carries it.
        const italic = resolveFont(family, 400, 16, 1, undefined);
        expect(italic).not.toBeNull();
        expect(glyphIdForCp(italic!, AYB)).toBe(0);
        const rItalic = resolveFontForCodepoint(AYB, italic!, key, 400, 16, 1, undefined, undefined, [key]);
        expect(rItalic.covered).toBe(true);
        expect(rItalic.key).toBe(key);
      }));
    } finally {
      clearWebfonts();
    }
  });
});

describe("win32DeferOrStatic keeps sampled inventory out of supported routing", () => {
  const SRC = readFileSync(path.join(HERE, "font-resolution.ts"), "utf-8");

  const functionBody = (fnName: string): string => {
    const at = SRC.search(new RegExp(`^function ${fnName}\\(`, "m"));
    expect(at, `no top-level function ${fnName}`).toBeGreaterThanOrEqual(0);
    return SRC.slice(at, SRC.indexOf("\n}\n", at));
  };

  it("gates the generated range on both companions and never treats a DirectWrite miss as permission", () => {
    const body = functionBody("win32DeferOrStatic");
    expect(body).toContain("isGlyphHelperAvailable()");
    expect(body).toContain("isIcuHelperAvailable()");
    expect(body).not.toContain("resolveSystemFallbackKeyForCp(");
  });

  it("receives only the degraded fallback candidates from its call site", () => {
    expect(SRC.replace(/\s+/g, " ")).toContain(
      "win32DeferOrStatic([generatedKey])",
    );
  });
});
