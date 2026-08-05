// A `font-feature-settings` DISABLE on a webfont run must actually disable the
// feature (DM-1964).
//
// `fontFeatureValueShapingOverride` reroutes a run whose feature list carries a
// disable (`-liga`) or an explicit value (`aalt=2`) through the vendored
// HarfBuzz, because fontkit's `layout(text, features)` is enable-only and cannot
// switch a default-on feature off. It resolved the face through
// `shapingFaceFor(fontKey, …)` — which resolves a font key to a FILE — and a
// webfont registered from an `@font-face` is held only as a Buffer and never
// written to disk. So the reroute declined for every webfont run, the run kept
// its fontkit shaping, and `font-feature-settings: "liga" 0` rendered WITH
// ligatures.
//
// The failure was silent rather than absent, which is what makes it worth a
// test: nothing threw, no glyph was missing, and the output was a plausible
// rendering of a different declaration.
//
// `hb.Blob` takes an ArrayBuffer, so the retained bytes were all HarfBuzz ever
// needed — `registerHbBufferSource` (harfbuzz-shaper.ts) makes them addressable
// through the same `fontPath` plumbing a file uses.
import { readFileSync, existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { clearWebfonts, registerWebfont, resolveFont, fontFeatureValueShapingOverride } from "./font-resolution.js";

/**
 * A SINGLE-FACE ligating font. Both properties are required, and neither is
 * incidental:
 *
 *  - it must ligate, or the disable has nothing to switch off and every
 *    assertion below passes on a font that could not have failed;
 *  - it must not be a `.ttc`, because a buffer carries no name to resolve a
 *    member by — the production path declines a collection outright rather than
 *    assume member 0, so a collection fixture would exercise the refusal
 *    instead of the fix.
 *
 * Every entry is verified to ligate before use rather than trusted, since a
 * host may ship a differently-built copy of any of them.
 */
const CANDIDATES = [
  "/System/Library/Fonts/Supplemental/BigCaslon.ttf",
  "/System/Library/Fonts/Supplemental/Skia.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
  "C:/Windows/Fonts/constan.ttf",
];

/** Forms `ffi` / `ffl` / `fi` / `fl` in any face that carries `liga`. */
const TEXT = "office waffle affix flight";
const DISABLES = ["-liga", "-clig", "-calt"];
const SIZE = 24, WEIGHT = 400;

afterEach(() => { clearWebfonts(); });

/** The first candidate that both parses AND actually ligates on this host. */
function pickLigatingFont(): { path: string; buffer: Buffer } | null {
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue;
    const buffer = readFileSync(path);
    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x74746366) continue; // 'ttcf'
    clearWebfonts();
    registerWebfont("dm1964probe", WEIGHT, "normal", buffer);
    const font = resolveFont("dm1964probe", WEIGHT, SIZE, 0);
    // Ligating means the default shaping produces FEWER glyphs than characters.
    if (font != null && font.layout(TEXT).glyphs.length < TEXT.length) return { path, buffer };
  }
  return null;
}

const fixture = pickLigatingFont();
clearWebfonts();
const itIf = fixture != null ? it : it.skip;

describe("a feature disable on a webfont-buffer run is expressed (DM-1964)", () => {
  const register = (): NonNullable<ReturnType<typeof resolveFont>> => {
    registerWebfont("dm1964", WEIGHT, "normal", fixture!.buffer);
    const font = resolveFont("dm1964", WEIGHT, SIZE, 0);
    expect(font, "the probe webfont must resolve").not.toBeNull();
    return font!;
  };

  itIf("carries the @font-face bytes on the resolved instance", () => {
    // The seam the fix hangs on. Without the buffer travelling with the
    // instance there is nothing for HarfBuzz to open, and every assertion below
    // would be testing the fallback rather than the fix.
    expect(register().webfontBuffer).toBeDefined();
  });

  itIf("shapes MORE glyphs with the ligature features disabled", () => {
    const base = register();
    const ligated = base.layout(TEXT).glyphs.length;
    const disabled = fontFeatureValueShapingOverride(
      base, "dm1964", WEIGHT, SIZE, 0, undefined, DISABLES).layout(TEXT).glyphs.length;

    // The claim. Measured on macOS with BigCaslon: 19 ligated, 26 disabled —
    // 26 being one glyph per character, i.e. every ligature broken up.
    expect(disabled, `${fixture!.path}: ligated ${ligated}, disabled ${disabled}`)
      .toBeGreaterThan(ligated);
    expect(disabled).toBe(TEXT.length);

    // …and the control, so a reroute that disabled ligatures unconditionally
    // (or one that simply shaped differently) fails here rather than looking
    // like the fix.
    const enabled = fontFeatureValueShapingOverride(
      base, "dm1964", WEIGHT, SIZE, 0, undefined, ["+liga"]).layout(TEXT).glyphs.length;
    expect(enabled).toBe(ligated);
  });

  itIf("returns a DISTINCT instance, and a stable one", () => {
    // Two separate claims that the same call covers.
    //
    // Distinct: before the fix the override returned the base unchanged for a
    // webfont, which is the shape of the bug — so `!== base` is the direct
    // non-vacuity check, and it fails on a revert while the glyph counts above
    // would too.
    //
    // Stable: `renderTextAsPath` groups codepoints into runs by comparing font
    // overrides BY IDENTITY, so a fresh proxy per call would end the run at
    // every character and hand a contextual shaper one-character runs. The
    // synthetic buffer id is memoized on buffer identity for exactly this.
    const base = register();
    const a = fontFeatureValueShapingOverride(base, "dm1964", WEIGHT, SIZE, 0, undefined, DISABLES);
    const b = fontFeatureValueShapingOverride(base, "dm1964", WEIGHT, SIZE, 0, undefined, DISABLES);
    expect(a).not.toBe(base);
    expect(a).toBe(b);
  });

  itIf("keeps proxies with different feature lists apart", () => {
    // The memo key carries the feature list; serving one where the other was
    // asked for would shape a disabled run with the enabled plan.
    const base = register();
    const off = fontFeatureValueShapingOverride(base, "dm1964", WEIGHT, SIZE, 0, undefined, DISABLES);
    const on = fontFeatureValueShapingOverride(base, "dm1964", WEIGHT, SIZE, 0, undefined, ["+liga"]);
    expect(off).not.toBe(on);
  });
});
