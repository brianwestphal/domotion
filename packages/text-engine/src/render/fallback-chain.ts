/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { hostPlatform } from "./host-platform.js";
import {
  captureFontFamilyStack,
  capturedFontFamilyHeadIdentity,
  parseCssFontFamilyEntries,
  type BlinkGenericFamily,
} from "../font-family-stack.js";
import { mathAlphaToBase } from "./unicode-classification.js";
import { linuxFallbackChain } from "./fallback-chain.linux.js";
import { win32FallbackChain } from "./fallback-chain.win32.js";
import { darwinFallbackChain } from "./fallback-chain.darwin.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import type { FontInstance } from "./font-instance.js";
import { getFontInstance } from "./font-instance.js";
import { glyphIdForCp } from "./font-instance.js";

/**
 * `css` carries the run's CSS description. It is consulted only where the chain
 * reaches the LIVE per-codepoint system-fallback resolver, whose answer is
 * weight- and style-dependent on macOS: CoreText nominates one face per family
 * and Blink then re-selects the cut within it (see `resolveSystemFallbackFonts`).
 * Omitted → weight 400 / upright / 16 px, which is what the pure family-routing
 * callers (and the calibration unit tests) want.
 */
export function fallbackFontChain(
  codepoint: number,
  primaryKey?: string,
  lang?: string,
  css?: CssFallbackDescription,
): string[] {
  // Platform-aware routing (DM-259 / DM-260). Each platform's Chromium cascades
  // through entirely different faces (CoreText vs fontconfig vs DirectWrite), so
  // each has its own empirically-probed chain.
  // DM-2017: css now reaches Linux too, so `linuxDeferOrStatic`'s probe can
  // match the weight/slant/fontSize/lang the real per-codepoint resolution
  // uses instead of asking a different (weight-400/no-locale) question.
  if (hostPlatform() === "linux") return linuxFallbackChain(codepoint, primaryKey, lang, css);
  // DM-1878: win32 gets the description too. It used to be dropped here, so the
  // nominated family was always instantiated at NORMAL weight — Blink passes the
  // run's `SkiaFontStyle()` and lets DirectWrite pick the cut.
  if (hostPlatform() === "win32") return win32FallbackChain(codepoint, primaryKey, lang, css);
  return darwinFallbackChain(codepoint, primaryKey, lang, css);
}

/** The parts of a run's CSS font description that change which FACE the live
 *  macOS system-fallback resolver answers with. */
export interface CssFallbackDescription {
  weight: number;
  slant: number;
  fontSize: number;
  /** CSS `font-stretch` as a percentage, 100 = `normal`. Optional so existing
   *  callers keep their exact behavior; consulted where Blink's call carries
   *  the width (the Windows family instantiation passes the full
   *  `SkiaFontStyle`, weight-width-slant). */
  stretch?: number;
  /** DM-1985: the run's `font-variant-emoji`. Blink applies
   *  `ApplyFontVariantEmojiOnFallbackPriority` (`harfbuzz_shaper.cc:983-984`)
   *  BEFORE the fallback stage reads the priority, so the override is upstream
   *  of the Windows `kText → kEmojiText` promotion rather than beside it.
   *  Absent = `normal`, and then the codepoint's own segmented priority wins. */
  fontVariantEmoji?: FontVariantEmojiOverride;
  /** Blink's descriptor-wide GenericFamily. This is semantic request state,
   *  not a property of whichever concrete face/key resolved first. */
  genericFamily?: BlinkGenericFamily;
  /** The unresolved serialized CSS family stack from which `genericFamily`
   *  was derived. Kept for platform asks whose identity includes the declared
   *  head even after that head failed to resolve. */
  declaredFamily?: string;
}

export interface FontFallbackSemanticContext {
  declaredFamily?: string;
  genericFamily: BlinkGenericFamily;
}

export function createFontFallbackSemanticContext(declaredFamily?: string): FontFallbackSemanticContext {
  return { declaredFamily, genericFamily: blinkGenericFamilyFromDeclaredStack(declaredFamily) };
}

/**
 * The first family name in Blink's common-Skia last-resort walk.
 *
 * This is a direct transcription of `GetFallbackFontFamily`
 * (`platform/fonts/alternate_font_family.h:107-123`, Chromium rev
 * 7d859f27): only the five legacy CSS generics nominate a family. `none`,
 * `standard`, and `webkit-body` all ask the platform default through an empty
 * family name. `system-ui` and `math` cannot appear in `BlinkGenericFamily` at
 * all; the stack parser leaves the preceding legacy enum in place, or `none`
 * when there was none.
 */
export function skiaLastResortInitialFamily(genericFamily: BlinkGenericFamily): string {
  switch (genericFamily) {
    case "sans-serif":
    case "serif":
    case "monospace":
    case "cursive":
    case "fantasy":
      return genericFamily;
    case "none":
    case "standard":
    case "webkit-body":
      return "";
  }
}

/**
 * Raw family questions in Blink's platform last-resort walk, before host font
 * matching or Domotion's logical-key normalization.
 *
 * The common Skia order is transcribed from `font_cache_skia.cc:146-259`;
 * Windows adds its six fixed names and locale-space probe there, while macOS
 * uses the separate `font_cache_mac.mm:376-394` Times/Lucida Grande terminal
 * (Chromium rev 7d859f27). The two unnamed markers are intentionally distinct:
 * the first is the empty family returned by `GetFallbackFontFamily`, and the
 * last is Skia's `legacyMakeTypeface(nullptr, ...)` match-anything query.
 */
export function skiaLastResortFamilyQuestionOrder(
  genericFamily: BlinkGenericFamily,
  platform: NodeJS.Platform = hostPlatform(),
): string[] {
  if (platform === "darwin") return ["Times", "Lucida Grande"];

  const common = [skiaLastResortInitialFamily(genericFamily) || "<unnamed-default>", "Sans", "Arial"];
  if (platform !== "win32") return [...common, "<unnamed>"];

  return [
    ...common,
    "MS UI Gothic",
    "Microsoft Sans Serif",
    "Segoe UI",
    "Calibri",
    "Times New Roman",
    "Courier New",
    "<locale-space-match>",
    "<unnamed>",
  ];
}

/**
 * Existing cross-platform logical key for the source-selected initial family.
 * The keys dispatch through the platform font tables; this is not a sampled
 * family-name table. A null means Blink starts with the unnamed platform
 * default before its explicit Sans/Arial rungs.
 */
export function skiaLastResortInitialKey(genericFamily: BlinkGenericFamily): string | null {
  switch (genericFamily) {
    case "sans-serif":
      return "helvetica";
    case "serif":
      return "times";
    case "monospace":
      return "courier";
    case "cursive":
      return "apple-chancery";
    case "fantasy":
      return "papyrus";
    case "none":
    case "standard":
    case "webkit-body":
      return null;
  }
}

interface DeclaredFamilyToken {
  value: string;
  quoted: boolean;
}

/** Backward-compatible view over the shared CSS-aware family-list parser. */
export function splitDeclaredFontFamily(value: string): DeclaredFamilyToken[] {
  return parseCssFontFamilyEntries(value).map((entry) => ({
    value: entry.name,
    quoted: entry.quoted,
  }));
}

/** Blink reverses the list and sets the descriptor enum once, hence the
 * rightmost enum-bearing legacy generic wins. system-ui and math deliberately
 * do not occupy this enum; quoted generic spellings are named families. */
export function blinkGenericFamilyFromDeclaredStack(value?: string): BlinkGenericFamily {
  return captureFontFamilyStack(value ?? "").genericFamily;
}

/** Stable identity for the declared head consumed by Linux/Windows system
 * fallback. The node kind prevents quoted `"monospace"` from aliasing the
 * monospace generic in the process-global memo. */
export function declaredFamilyHeadIdentity(value?: string): string {
  return capturedFontFamilyHeadIdentity(captureFontFamilyStack(value ?? ""));
}

/** FreeFont sibling key for a given base FreeFont key + bold/italic style. */
function freeFontVariantKey(baseKey: string, bold: boolean, italic: boolean): string {
  if (bold && italic) return `${baseKey}-bold-italic`;
  if (bold) return `${baseKey}-bold`;
  if (italic) return `${baseKey}-italic`;
  return baseKey;
}

/**
 * Math-Alphanumeric decomposition fallback, shared by both run splitters.
 * Call only when NO font in `chain` could render `cp` directly. If `cp` is a
 * synthesizable Math-Alpha symbol, returns the base letter/digit `ch` to
 * render plus the FreeFont sibling key/instance (weight/slant baked into the
 * file, so the resolved outline is already bold/oblique). Returns null when
 * `cp` isn't Math-Alpha or no FreeFont sibling covers the base char — the
 * caller then keeps the pre-existing chain behavior. See mathAlphaToBase.
 */
export function decomposeMathAlphaRun(
  cp: number,
  chain: string[],
  weight: number,
  fontSize: number,
): { key: string; font: FontInstance; ch: string } | null {
  const decomp = mathAlphaToBase(cp);
  if (decomp == null) return null;
  for (const candidate of chain) {
    if (candidate !== "free-sans" && candidate !== "free-serif") continue;
    const vKey = freeFontVariantKey(candidate, decomp.bold, decomp.italic);
    const vFont = getFontInstance(vKey, weight, fontSize, 0);
    if (vFont != null && vFont.glyphForCodePoint != null && glyphIdForCp(vFont, decomp.base) !== 0) {
      return { key: vKey, font: vFont, ch: String.fromCodePoint(decomp.base) };
    }
  }
  return null;
}

/** @deprecated Single-key wrapper for back-compat — prefer `fallbackFontChain`. */
export function fallbackFontKey(codepoint: number): string | null {
  const chain = fallbackFontChain(codepoint);
  return chain.length > 0 ? chain[0] : null;
}

/**
 * Codepoints Chrome on macOS paints via the color-emoji font (Apple Color
 * Emoji), regardless of any path-font's coverage. Mirrors the predicate in
 * `src/dom-to-svg.ts` (CAPTURE_SCRIPT's `needsRaster`) so the path pipeline
 * can skip emitting the .notdef tofu rectangle for these codepoints — the
 * raster <image> overlay added by the capture layer already covers the
 * visible glyph, and emitting the tofu underneath produces a visible
 * black rectangle around the edges of the emoji where the raster has
 * sub-pixel transparency. (DM-334.)
 */
/**
 * Codepoints in the Unicode Private Use Areas — these are author-assigned
 * (typically icon-font) glyphs. When the host system fonts don't cover the
 * codepoint, fontkit returns a `.notdef` tofu (a striated rectangle). We
 * suppress that emission rather than paint the tofu — a missing icon should
 * read as "nothing" not as a glyph-shaped black blob over surrounding text
 * (apple.com country dropdown checkmark covering the leading 'P' of
 * 'Philippines' — DM-490 / DM-500).
 */
export function isPrivateUseCodepoint(cp: number): boolean {
  // BMP PUA
  if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  // Supplementary PUA-A
  if (cp >= 0xf0000 && cp <= 0xffffd) return true;
  // Supplementary PUA-B
  if (cp >= 0x100000 && cp <= 0x10fffd) return true;
  return false;
}

/**
 * The OTHER half of Blink's no-system-fallback rule. Transcribed from
 * `third_party/blink/renderer/platform/fonts/font_cache.cc:242-244`
 * (rev 7d859f27, 2026-06-27):
 *
 *     if (Character::IsPrivateUse(lookup_char) ||
 *         Character::IsNonCharacter(lookup_char))
 *       return nullptr;
 *
 * `Character::IsNonCharacter` is `U_IS_UNICODE_NONCHAR(c)` (`character.cc:294-296`),
 * i.e. ICU's noncharacter set: U+FDD0..U+FDEF plus the last two codepoints of
 * every plane (U+xFFFE / U+xFFFF). Blink's own comment gives the reason — some
 * of these are encoding-detection sentinels that really do appear on the web,
 * and running fallback for U+FFFE cost a memory regression (crbug.com/862352).
 */
export function isNonCharacterCodepoint(cp: number): boolean {
  if (cp > 0x10ffff) return false;
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  return (cp & 0xfffe) === 0xfffe;
}

/**
 * Sub-bold weight cuts: families whose installed face set carries a face BELOW
 * the regular one, which the plain `weight >= 600 ? bold : regular` split in
 * `getFontInstance` would otherwise hide.
 *
 * Each family lists its extra cuts in ascending order as the inclusive UPPER
 * CSS weight bound that selects it; a request above every listed bound (but
 * still under 600) falls through to the family's regular face. The suffix is
 * appended to the family key to name the `FONT_PATHS` entry —
 * `helvetica` + `light` → `helvetica-light`, and `-italic` on top of that when
 * a slant is requested.
 *
 * DEGRADED TIER ONLY. On an armed host (helper present) the declared-family
 * cut is decided by `darwinPrimaryCutKey` — the ported Blink matcher
 * (`BestStyleMatchForFamilyNS` / `BetterChoiceCT`, tag 147.0.7727.15) — whose
 * answer replaces this table's whether or not it names the base face. This
 * ladder decides only where the matcher cannot run (no helper binary /
 * `DOMOTION_DISABLE_HELPER`), and there it is a SAMPLED approximation, not a
 * transcription: the bounds come from asking Chromium directly over the whole
 * 100…700 range in 10-point steps via the CDP `CSS.getPlatformFontsForNode`
 * command on one Mac: 100-300 → Helvetica-Light, 310-590 → Helvetica,
 * 600-700 → Helvetica-Bold (the armed matcher reproduces exactly this sweep,
 * re-verified 2026-08-08). It matters for the `sans-serif` generic, which
 * Chrome on macOS resolves to Helvetica — so any page setting `font-weight:
 * 100`/`200`/`300` on default sans-serif text was being painted a full cut
 * too heavy.
 *
 * Platform-agnostic by construction: the suffixed key is only adopted when
 * `resolveFontSpec` can resolve it on the host platform, so the Linux
 * (Liberation Sans) and Windows (Arial) mappings for `helvetica` — neither of
 * which ships a light cut — keep falling back to their regular face, which is
 * what Chrome picks there too.
 */
export const SUB_BOLD_WEIGHT_CUTS: Record<string, ReadonlyArray<{ maxWeight: number; suffix: string }>> = {
  helvetica: [{ maxWeight: 300, suffix: "light" }],
};
