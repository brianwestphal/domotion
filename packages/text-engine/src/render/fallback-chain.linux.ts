/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_RANGES_NOTO_LINUX } from "./unicode-font-routing.noto-linux.generated.js";
import type { CssFallbackDescription } from "./fallback-chain.js";
import { linuxFontProfile } from "./font-paths.linux.js";
import { isHebrewBlock } from "./font-spec.js";
import { isArabicBlock } from "./font-spec.js";
import { isDevanagariBlock } from "./font-spec.js";
import { isThaiBlock } from "./font-spec.js";
import { isHangulBlock } from "./font-spec.js";
import { isBoxDrawingBlock } from "./font-spec.js";
import { isDingbatsBlock } from "./font-spec.js";
import { linuxDeferOrStatic } from "./font-spec.js";
import { isMathAlphanumericBlock } from "./font-spec.js";
import { isSuperSubscriptBlock } from "./font-spec.js";
import { isLetterlikeBlock } from "./font-spec.js";
import { isMathOperatorsBlock } from "./font-spec.js";
import { isCjkBmpBlock } from "./font-spec.js";
import { isPictographResidueBlock } from "./font-spec.js";

export function linuxFallbackChain(
  codepoint: number,
  primaryKey?: string,
  lang?: string,
  css?: CssFallbackDescription,
): string[] {
  // DM-1404: on a mainstream desktop Noto host, route through the Noto-calibrated
  // per-block table instead of the bare image's WenQuanYi/FreeFont routes.
  if (linuxFontProfile() === "noto") return linuxNotoFallbackChain(codepoint);
  const cp = codepoint;
  // Hebrew — Liberation Sans covers it, so route to the sans key (probe: hebrew
  // → Liberation Sans, i.e. the primary itself when sans-serif).
  if (isHebrewBlock(cp)) return ["helvetica"];
  // Arabic core + presentation forms — FreeSerif (probe: arabic → FreeSerif).
  if (isArabicBlock(cp)) {
    return ["sf-arabic"]; // → FreeSerif on Linux
  }
  // Devanagari — FreeSans (probe: devanagari → FreeSans).
  if (isDevanagariBlock(cp)) return ["devanagari"]; // → FreeSans
  // Thai — Loma (probe: thai → Loma).
  if (isThaiBlock(cp)) return ["thai"];
  // Hangul — WenQuanYi Zen Hei (probe: hangul → WenQuanYi).
  if (isHangulBlock(cp)) return ["cjk"];
  // Box Drawing / Block — mono primary keeps the primary (WenQuanYi Zen Hei
  // Mono covers them at cell width); non-mono falls to Liberation Sans, then CJK
  // (probe: box-drawing mono → WQY Mono; box-drawing-sans → Liberation Sans).
  if (isBoxDrawingBlock(cp)) {
    const monoPrimary =
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono";
    return monoPrimary ? [primaryKey!, "cjk"] : ["helvetica", "cjk"];
  }
  // Dingbats — FreeSans (probe: ✂✈❤ → FreeSans).
  if (isDingbatsBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "free-serif"], primaryKey, lang, css);
  // Chess pieces — FreeSerif (probe: ♔♚ → FreeSerif).
  if (cp >= 0x2654 && cp <= 0x265f) return linuxDeferOrStatic(cp, ["free-serif", "free-sans"], primaryKey, lang, css);
  // Diagonal arrows ↗↙ — WenQuanYi (probe: arrows-diag → WenQuanYi); the rest of
  // the Arrows block → Liberation Sans (probe: ←→↑↓↔ → Liberation Sans).
  if (cp === 0x2197 || cp === 0x2199) return ["cjk", "helvetica"];
  // Arrows: Liberation Sans covers most; for the ones it lacks (↖↘⇄⇒⇦⇧⇨⇩ …)
  // Chrome's fontconfig picks WenQuanYi Zen Hei. Defer the remainder to the live
  // fc-match resolver (2b) instead of the over-covering FreeSans, which
  // intercepted with a font Chrome doesn't use (verified vs getPlatformFontsForNode).
  if (cp >= 0x2190 && cp <= 0x21ff) return ["helvetica"];
  // Geometric Shapes — Liberation Sans, then WenQuanYi for what it lacks
  // (probe: ▲●◆■□○ → Liberation Sans + WenQuanYi).
  if (cp >= 0x25a0 && cp <= 0x25ff) return ["helvetica", "cjk"];
  // Misc Symbols — Liberation Sans + IPAGothic (probe: ☀☂♠♥♦ → Liberation Sans
  // + IPAGothic).
  // Misc Symbols: Liberation Sans for what it covers; the rest Chrome routes to
  // IPAGothic / WenQuanYi via fontconfig. The old static `hiragino-jp` route maps
  // to an IPAGothic path that isn't present on the current Playwright image, so it
  // fell through to FreeSans — a font Chrome doesn't use here. Defer to the fc-match
  // resolver (2b), which picks exactly Chrome's font on this image.
  if (cp >= 0x2600 && cp <= 0x26ff) return ["helvetica"];
  // Mathematical Alphanumeric — FreeSans + FreeSerif (probe: 𝐀𝒜𝕊 → FreeSans/FreeSerif).
  if (isMathAlphanumericBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "free-serif"], primaryKey, lang, css);
  // Superscripts / Subscripts — Liberation Sans + FreeSans (probe: aₙ₁).
  if (isSuperSubscriptBlock(cp)) return ["helvetica", "free-sans"];
  // Letterlike — mostly FreeSans (ℝ™ℕℤ), but some codepoints Chrome routes to
  // WenQuanYi / IPAGothic; defer to fc-match (= Chrome) with FreeSans as the net.
  if (isLetterlikeBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "helvetica"], primaryKey, lang, css);
  // Math Operators — Liberation Sans covers ∑∫≠ etc.; the set-theory / logic
  // operators it lacks (∀∃∅∇∈∉∧∨∪∴ …) Chrome routes to WenQuanYi Zen Hei via
  // fontconfig, NOT FreeSans (verified vs getPlatformFontsForNode). Liberation
  // first, then defer to the fc-match resolver (2b) for the remainder.
  if (isMathOperatorsBlock(cp)) return ["helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation — WenQuanYi Zen Hei (probe:
  // 漢字/あ/ア → WenQuanYi). Japanese-tagged text prefers IPAGothic; left as a
  // refinement (untagged probe resolved to WenQuanYi). DM-259 follow-up.
  if (isCjkBmpBlock(cp)) {
    return ["cjk"];
  }
  // Pictographs / Transport residue not caught by the color-emoji raster path
  // (doc 15) — FreeSans as a monochrome last resort.
  if (isPictographResidueBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans"], primaryKey, lang, css);
  // DM-984: per-Unicode-block fallback derived from a Chrome CDP sweep inside
  // the Playwright Docker container — `CSS.getPlatformFontsForNode` for every
  // block in tools/unicode-fixtures/*.html. Resolved to bare-image paths by
  // tools/probe-983-genroutes-linux.mjs (Unifont / FreeSans / Liberation / etc).
  // Consulted as a LAST resort so the hand-tuned routes above still win where
  // they match.
  // For blocks with no hand-tuned route above, DEFER to the live fc-match
  // resolver (step 2b) rather than the generated DM-984 table. That table was
  // frozen from one Playwright-image CDP sweep and has drifted from the current
  // image (it routed Georgian → Unifont, CJK-Compatibility → FreeSans, where
  // Chrome's fontconfig now picks FreeSans / WenQuanYi / IPAGothic — verified vs
  // getPlatformFontsForNode). fc-match queries the SAME fontconfig Chrome does,
  // so it tracks Chrome's pick by construction (DM-1416). The generated table is
  // kept only as the post-fc-match safety net.
  const generatedKey = lookupLinuxUnicodeFontRange(codepoint);
  return linuxDeferOrStatic(codepoint, generatedKey != null ? [generatedKey] : [], primaryKey, lang, css);
}

/** Binary-search the generated `UNICODE_FONT_RANGES_LINUX` for a codepoint. */
/**
 * Binary-search a sorted `[start, end, key]` range table for the key whose range
 * contains `codepoint`, or null. Shared by the per-platform generated
 * unicode-font-range lookups below (they differ only by the table). DM-1434.
 */
export function binarySearchRange(
  table: ReadonlyArray<readonly [number, number, string]>,
  codepoint: number,
): string | null {
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = table[mid]!;
    if (codepoint < r[0]) hi = mid - 1;
    else if (codepoint > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}

function lookupLinuxUnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_LINUX, codepoint);
}

/**
 * DM-1404: Linux fallback chain for the desktop **Noto profile**. The generated
 * `UNICODE_FONT_RANGES_NOTO_LINUX` table is the full per-block calibration of
 * what Chromium-on-a-Noto-desktop paints (one face per block), so — unlike the
 * bare chain's hand-tuned WenQuanYi/FreeFont routes — the Noto chain just
 * consults that table. The caller has already tried the primary; the DM-1416
 * live `fc-match :charset` resolver is the net after this for any per-codepoint
 * miss the block-level route lacks. Keys are the generated `un-...` ones.
 */
function linuxNotoFallbackChain(codepoint: number): string[] {
  const key = lookupNotoLinuxUnicodeFontRange(codepoint);
  return key != null ? [key] : [];
}

/** Binary-search the generated `UNICODE_FONT_RANGES_NOTO_LINUX` for a codepoint. */
function lookupNotoLinuxUnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_NOTO_LINUX, codepoint);
}
