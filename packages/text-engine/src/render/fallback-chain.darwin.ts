/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { resolveInstalledFont } from "./glyph-helper.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import type { CssFallbackDescription } from "./fallback-chain.js";
import { isHebrewBlock } from "./font-spec.js";
import { isArabicBlock } from "./font-spec.js";
import { isDevanagariBlock } from "./font-spec.js";
import { isThaiBlock } from "./font-spec.js";
import { isHangulBlock } from "./font-spec.js";
import { isCjkBmpBlock } from "./font-spec.js";
import { pingfangKeyForLang } from "./font-spec.js";
import { isBoxDrawingBlock } from "./font-spec.js";
import { isDingbatsBlock } from "./font-spec.js";
import { isMathAlphanumericBlock } from "./font-spec.js";
import { isSuperSubscriptBlock } from "./font-spec.js";
import { isLetterlikeBlock } from "./font-spec.js";
import { isMathOperatorsBlock } from "./font-spec.js";
import { isPictographResidueBlock } from "./font-spec.js";
import { resolveSystemFallbackKeyForCp } from "./system-fallback-resolver.js";
import { binarySearchRange } from "./fallback-chain.linux.js";

/**
 * macOS (CoreText) fallback chain — reverse-engineered from Chromium-on-macOS
 * painted widths (DM-241 / DM-256 / DM-257 / …). Exported so the macOS-
 * calibration unit tests assert it directly: the suite runs on Linux in CI,
 * where `fallbackFontChain` dispatches to `linuxFallbackChain`, so those tests
 * must call this function (not `fallbackFontChain`) to validate macOS routing
 * regardless of the host platform (DM-842).
 */
export function darwinFallbackChain(
  codepoint: number,
  primaryKey?: string,
  lang?: string,
  css?: CssFallbackDescription,
): string[] {
  // A lone variation selector never leaves the run's primary in Chrome: the
  // shaper replaces default-ignorables with a zero-advance invisible glyph (or
  // deletes them outright) whatever the font's coverage says —
  // `hb_ot_hide_default_ignorables`, hb-ot-shape.cc:824-846 (HarfBuzz rev
  // 4de187d) — so no fallback face is ever painted for U+FE00-FE0F. The
  // generated darwin table nonetheless sampled a `u-noto-sans` route for the
  // block (the sweep recorded a face nomination, not a paint), and that route
  // supplied the static chain's only six system-stage answers over the whole
  // darwin conformance corpus — every one a divergence. No chain: the
  // resolver's uncovered terminal keeps the primary, and orphaned selectors
  // are stripped upstream anyway (`stripOrphanedDefaultIgnorables`).
  if (codepoint >= 0xfe00 && codepoint <= 0xfe0f) return [];
  // When the primary family is a serif (Apple Times / Times New Roman /
  // Georgia — or a bare fangsong/math/ui-serif stack, which is walked past
  // and terminates at the `times` standard-family terminal), CJK fallback
  // should produce SERIF CJK glyphs (Songti SC Light) instead
  // of the default sans-serif Hiragino Sans GB. DM-333. The check is just
  // the resolved key — `times` covers serif/UA-default directly and the
  // walked-past names via `resolveFontKey`'s terminal, not a per-name route
  // (fangsong/math/ui-* return null in `matchFamilyNameToKey`).
  const serifPrimary = primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia";
  // Hebrew (U+0590..05FF) + presentation forms (U+FB1D..FB4F).
  // sf-hebrew before lucida-grande as a probe: SFHebrew layouts "שלום עולם"
  // at 68.62px @16px while LucidaGrande layouts at 75.85px. Captured xs from
  // Chrome's `font-family: sans-serif` paint in 02-text-bidi land at 63.766
  // for ש's ink-left, suggesting a run width around 75 (closer to LucidaGrande
  // — Chrome's Helvetica → Hebrew CoreText fallback). Track DM-347 follow-up.
  if (isHebrewBlock(codepoint)) {
    return ["lucida-grande", "sf-hebrew"];
  }
  // Arabic core block + presentation forms A and B.
  if (isArabicBlock(codepoint)) {
    return ["sf-arabic"];
  }
  // Devanagari (U+0900..097F).
  if (isDevanagariBlock(codepoint)) return ["devanagari"];
  // Thai (U+0E00..0E7F).
  if (isThaiBlock(codepoint)) return ["thai"];
  // Hangul (Korean) — Syllables + Jamo. Route to Apple SD Gothic Neo FIRST
  // because Hiragino Sans GB and PingFang SC don't carry Hangul codepoints;
  // without this branch Korean text falls all the way through to tofu
  // boxes. Keep `cjk` as a final fallback for the rare codepoint Apple SD
  // Gothic Neo lacks. DM-691.
  if (isHangulBlock(codepoint)) {
    return ["korean", "cjk"];
  }
  // CJK: Unified Ideographs + Ext A, Hiragana, Katakana (+ phonetic exts),
  // CJK Symbols & Punctuation. Hangul is handled above.
  if (isCjkBmpBlock(codepoint)) {
    // DM-1174: U+302A–U+302F are combining CJK/Hangul tone marks that Hiragino
    // Sans GB (our `cjk`) does NOT carry. Chrome falls to Arial Unicode MS, which
    // has them AND U+25CC, and lays the orphaned `◌ + mark` cluster as a SPACING
    // glyph to the RIGHT of the dotted circle (verified against Chrome's painted
    // output). Without an Arial-Unicode fallback the chain finds no coverage and
    // the orphaned mark drops to the per-char centering path, which stacked the
    // mark ON the ◌ — the "soccer ball". Routing them here lets the DM-1215
    // dotted-circle HarfBuzz path resolve coverage and reproduce Chrome's spacing
    // layout. (`cjk` stays first so a future Hiragino that gains them still wins.)
    // DM-1850: gated for the same reason `u-noto-sans` is below — a raw key
    // bypasses the installed-family check, so `DOMOTION_HIDE_FAMILIES` cannot
    // hide it and a machine that HAS the font reproduces a different chain than
    // one that does not. Note the very same family IS already gated where it is
    // reached as an author family (`authorFamilyAvailable("Arial Unicode MS")`),
    // so this was the two paths disagreeing about one font.
    if (codepoint >= 0x302a && codepoint <= 0x302f) {
      return generatedRouteUsable("u-arial-unicode-ms") ? ["cjk", "u-arial-unicode-ms"] : ["cjk"];
    }
    // DM-1117: author explicitly named Hiragino Mincho ProN — route its own
    // glyphs first so the `trad` / `fwid` / `jp78` East-Asian features land on a
    // font that carries them (Songti doesn't). Falls back to the generic serif
    // CJK then sans CJK for any codepoint Mincho lacks.
    if (primaryKey === "hiragino-mincho") return ["hiragino-mincho", "cjk-serif", "cjk"];
    // Serif primary → SERIF CJK font first (DM-333). Keep `cjk`
    // (HiraginoSansGB) as a secondary so chars Songti SC Light lacks (a
    // small set in the rare extension blocks) still resolve.
    // For sans-serif primary, route Han Unified Ideographs (and Ext A) through
    // PingFang SC via CoreText first — that's what Chrome actually paints
    // (DM-382). The `cjk` HiraginoSansGB chain stays as the fallback for
    // any codepoint PingFang lacks AND for the Hiragana/Katakana/Hangul/
    // CJK Symbols ranges where Hiragino is what Chrome picks. Bold scope is
    // resolved at `getFontInstance` time: weight ≥ 600 → pingfang-sc-bold.
    if (serifPrimary) return ["cjk-serif", "cjk"];
    const isHan =
      (codepoint >= 0x4e00 && codepoint <= 0x9fff) ||
      (codepoint >= 0x3400 && codepoint <= 0x4dbf) ||
      (codepoint >= 0xf900 && codepoint <= 0xfaff);
    if (!isHan) return ["cjk"];
    // For Han: prefer the lang-matching PingFang variant (or hiragino-jp for
    // Japanese) when lang is set, otherwise fall through to PingFang SC. The
    // bare `cjk` (HiraginoSansGB) stays as the safety net for any glyph
    // PingFang lacks in the rare extension blocks.
    const localeKey = pingfangKeyForLang(lang);
    if (localeKey === "hiragino-jp") return ["hiragino-jp", "cjk"];
    if (localeKey != null) return [localeKey, "pingfang-sc", "cjk"];
    return ["pingfang-sc", "cjk"];
  }
  // CJK supplementary planes — Unified Ideographs Extensions B/C/D/E/F/I
  // (U+20000..U+2EBEF), CJK Compatibility Ideographs Supplement
  // (U+2F800..U+2FA1F), Ext G (U+30000..U+3134F) and Ext H
  // (U+31350..U+323AF). On macOS Chrome reaches Apple's PingFang variants
  // (PingFangSC for Ext B/C/D/E/F/G, PingFangHK for Ext H, PingFangTC for
  // the small set of compat-ideographs additions HK lacks). Probed per-
  // codepoint via CSS.getPlatformFontsForNode: U+305D6 → .PingFangSC-Regular,
  // U+3208E → .PingFangHK-Regular. Without this route the codepoints fall
  // through to the DM-983 generated table — which (because Arial Unicode
  // MS / Noto Sans KR don't carry these blocks) maps to fonts with no
  // glyph and the chain ends at `[]`, rendering nothing for what Chrome
  // paints as a real character. DM-1000 / DM-1011 / DM-1012.
  //
  // `pingfang-hk` is tried before `pingfang-sc` because HK has the broadest
  // coverage of the post-Unicode-13 additions (Apple updates HK first for
  // newly-added codepoints); SC catches the older Ext B/C/D/E/F set; `cjk`
  // (HiraginoSansGB) stays as a safety net; LastResort emits Chrome's
  // block-frame placeholder for the residue PingFang lacks.
  if (
    (codepoint >= 0x20000 && codepoint <= 0x2ebef) ||
    (codepoint >= 0x2f800 && codepoint <= 0x2fa1f) ||
    (codepoint >= 0x30000 && codepoint <= 0x323af)
  ) {
    if (serifPrimary) return ["cjk-serif", "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    const localeKey = pingfangKeyForLang(lang);
    if (localeKey === "hiragino-jp") return ["hiragino-jp", "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    if (localeKey != null) return [localeKey, "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    return ["pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
  }
  // Box Drawing / Block Elements (U+2500..U+259F).
  //
  // When the primary font is MONOSPACE (Courier / Menlo / Monaco / SF Mono),
  // route box-drawing chars to the SAME primary font (with Menlo as a
  // safety net for chars the primary lacks). Chrome paints these chars at
  // monospace cell width — empirically Courier @13px paints `─ │ ┌ ┬ ┼ …`
  // all at 7.827 px, matching `M` / `a` to the sub-px — so the ASCII-art
  // box in `02-text-preformatted.html`'s `<pre>` aligns cleanly. Routing
  // mono primaries through Hiragino's em-wide glyphs (16 px @ 13 px font
  // = 1.23 em) overran the cell and broke the box alignment (DM-780).
  //
  // For non-monospace primaries (Helvetica / Arial / SF Pro body text)
  // Chrome's CoreText fallback for missing box-drawing glyphs lands in
  // Hiragino — those em-wide glyphs are what Chrome actually paints, and
  // they connect seamlessly because the surrounding text isn't on a fixed
  // cell grid anyway. The Helvetica/Menlo split that DM-442 fixed (some
  // box chars in Helvetica, others falling through to Menlo's narrower
  // glyphs and breaking corner joins) is exactly what we want to avoid
  // here too. Menlo stays as the final safety net.
  if (isBoxDrawingBlock(codepoint)) {
    const monoPrimary =
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono";
    if (monoPrimary) return [primaryKey, "menlo", "hiragino-jp"];
    return ["hiragino-jp", "menlo"];
  }
  // U+2713 CHECK MARK (✓) — context-dependent, per CDP CSS.getPlatformFontsForNode
  // at 16px on each generic primary (02-text-symbols rows): sans → Lucida
  // Grande (the DM-980 finding — Zapf's check is visibly thinner at a
  // different angle), serif → Zapf Dingbats, monospace → Menlo. This must sit
  // BEFORE the Dingbats-block return: the earlier DM-980 rule lived after it
  // and was dead code — the block return shadowed it, which is exactly why the
  // fixture's sans ✓ painted the thin Zapf check.
  if (codepoint === 0x2713) {
    const monoPrimary =
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono";
    if (monoPrimary) return ["menlo", "zapf-dingbats", "symbols"];
    if (
      primaryKey === "times" ||
      primaryKey === "times-new-roman" ||
      primaryKey === "georgia" ||
      primaryKey === "palatino"
    ) {
      return ["zapf-dingbats", "symbols"];
    }
    return ["lucida-grande", "zapf-dingbats", "symbols"];
  }
  // Dingbats → Zapf Dingbats. macOS Chrome paints ✂✈✏✔✘✚✦❄❤❶ via Zapf
  // Dingbats; Apple Symbols has the same codepoints but at different (often
  // narrower) widths — empirical match shows Chrome consistently picks Zapf.
  if (isDingbatsBlock(codepoint)) return ["zapf-dingbats", "symbols"];
  // Geometric Shapes (▲△▽★☆♀♂…) and Misc Symbols (☀☁☂♠♥♦…) — Chrome on
  // macOS paints many of these at the CJK em-square width (16px @16px font-
  // size) via Hiragino Sans GB, NOT Apple Symbols (which has them at
  // proportional 9-14px). Try CJK first; fall through to Apple Symbols for
  // the chars Hiragino lacks (☘ ☑ ◇ etc.). DM-256. Insert Japanese Hiragino
  // Sans (HiraKakuProN-W3) between cjk-GB and Apple Symbols — it covers
  // ◉◌◐◑ (DM-324) and ☀☁☂☃ (DM-326) at em-square width when GB doesn't,
  // matching Chrome's 18px paint instead of falling through to Apple
  // Symbols' narrower 11-15px advance.
  // Within Geometric Shapes, the small filled / outline primitives that
  // LucidaGrande carries at narrow proportional advance — ■ □ ● ○ ◆ ◇ —
  // are what Chrome's CoreText cascade for `font-family: sans-serif`
  // (Helvetica) actually picks for those individual codepoints, NOT the
  // CJK/Hiragino em-square glyph that the rest of the block uses. Probed
  // against captured xOffsets in 02-text-symbols (DM-349):
  //   ■ □ : LucidaGrande 9.76px @18px (Hiragino paints 18px → 8px too wide)
  //   ● ○ : LucidaGrande 10.41px @18px (Hiragino 18px too wide)
  //   ◆   : LucidaGrande 13.01px @18px
  //   ◇   : LucidaGrande 11.07px @18px
  // Everything else in 0x25A0..25FF (▲▽◉◌◐◑★…) Chrome paints at em-square
  // via Hiragino — keep those on the existing chain.
  // DM-415 / DM-429: tried routing patterned squares (U+25A3..A8 + U+25C8)
  // to AppleSDGothicNeo and SF NS for the open-shape primitives, but the
  // painted-ink size came out larger than Chrome's actual paint despite the
  // advance widths matching — Chrome uses a font with smaller-ink-in-wider-
  // advance for these. Reverted; the LucidaGrande route remains the closest
  // visible match in our available font set. Tracked further in DM-429.
  if (
    codepoint === 0x25a0 ||
    codepoint === 0x25a1 ||
    codepoint === 0x25cf ||
    codepoint === 0x25cb ||
    codepoint === 0x25c6 ||
    codepoint === 0x25c7
  ) {
    // Context split (CDP per-cp probe on the 02-text-symbols rows): a serif
    // primary pulls these from Times New Roman, a monospace primary from
    // Menlo; the sans path keeps Lucida Grande (sans primaries that carry
    // the glyph themselves — Helvetica has ● — never reach this chain).
    if (
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono"
    ) {
      return ["menlo", "lucida-grande", "symbols"];
    }
    if (
      primaryKey === "times" ||
      primaryKey === "times-new-roman" ||
      primaryKey === "georgia" ||
      primaryKey === "palatino"
    ) {
      return ["times-new-roman", "lucida-grande", "symbols"];
    }
    return ["lucida-grande", "symbols"];
  }
  // DM-925: U+25C8 WHITE DIAMOND CONTAINING SMALL BLACK DIAMOND (◈) —
  // Chrome paints via AppleSDGothicNeo (Korean fallback), not Hiragino
  // Sans GB which has no glyph for it. Probe @18 px: Chrome 15.59 px,
  // AppleSDGothicNeo 15.57 px (match), Apple Symbols 13.91 px (off by
  // 1.68 px). The `korean` key already exists for Hangul routing;
  // reuse it here for this single misc-shapes codepoint.
  if (codepoint === 0x25c8) {
    return ["korean", "symbols"];
  }
  // DM-979: Double-struck Letterlike Symbols U+2115 ℕ, U+211D ℝ, U+2124 ℤ.
  // Chrome routes these to **Menlo** (per `CSS.getPlatformFontsForNode`
  // probe at 32 px sans-serif: all three return Menlo as the sole font,
  // paint width 19.27 px). fontkit confirms Menlo carries the glyphs at
  // 19.27 px @ 32 px exactly; Apple Symbols also has them but at
  // proportional widths (20-26 px), and the existing `[symbols]` route
  // for the Letterlike block would have used those wider glyphs — but
  // even that wasn't happening because earlier in the dispatch the
  // primary font (Helvetica) gets first crack at these codepoints and
  // PAINTS the plain Latin R / N / Z (Helvetica's cmap maps the
  // Letterlike codepoints to the corresponding ASCII glyph, producing
  // "plain R N Z" — DM-979's observed actual). Pre-empting the chain
  // with Menlo here matches Chrome's paint shape AND width.
  if (codepoint === 0x2115 || codepoint === 0x211d || codepoint === 0x2124) {
    return ["menlo", "symbols"];
  }
  // DM-981: U+2135 ℵ (HEBREW LETTER ALEF, used as transfinite cardinal in
  // Letterlike Symbols) — Chrome routes to Lucida Grande (20.64 px @ 32 px).
  // Helvetica primary has no glyph; the existing `[symbols]` fallback hits
  // Apple Symbols at 19.11 px (close but visibly narrower than Chrome's).
  // LucidaGrande matches exactly.
  if (codepoint === 0x2135) {
    return ["lucida-grande", "symbols"];
  }
  // DM-978: Double-headed arrows U+21D0..U+21D5 (⇐⇑⇒⇓⇔⇕). Chrome's
  // per-codepoint font choice (via `CSS.getPlatformFontsForNode` probe
  // at 32 px sans-serif):
  //   ⇐ U+21D0 → Hiragino Sans (JP), 32.00 px
  //   ⇑ U+21D1 → Apple SD Gothic Neo, 27.69 px  (Hiragino lacks the glyph)
  //   ⇒ U+21D2 → Hiragino Sans (JP), 29.31 px
  //   ⇓ U+21D3 → Apple SD Gothic Neo, 27.69 px  (Hiragino lacks the glyph)
  //   ⇔ U+21D4 → Hiragino Sans (JP), 29.31 px
  //   ⇕ U+21D5 → Menlo, 19.27 px               (both Hiragino + ASDGN lack)
  // fontkit advance widths confirm sub-pixel matches for each.
  // A single chain `["hiragino-jp", "korean", "menlo", "symbols"]` lets the
  // renderer walk per codepoint and pick the first font carrying the glyph
  // — same dispatch as `chain.find(hasGlyph)` everywhere else in the
  // renderer. Replaces the previous "fall through to Apple Symbols"
  // residue that produced thinner / lighter strokes than Chrome paints.
  if (codepoint >= 0x21d0 && codepoint <= 0x21d5) {
    return ["hiragino-jp", "korean", "menlo", "symbols"];
  }
  // DM-981: Single-headed misc arrows U+2194..U+2199 (↔ ↕ ↖ ↗ ↘ ↙) —
  // Chrome's per-codepoint CDP probe at 32 px sans-serif:
  //   ↔ U+2194 → Hiragino Sans (JP), 29.31 px
  //   ↕ U+2195 → Apple SD Gothic Neo,  17.64 px
  //   ↖ U+2196 → Lucida Grande,        32.00 px
  //   ↗ U+2197 → Hiragino Sans (JP),  32.00 px
  //   ↘ U+2198 → Lucida Grande,        32.00 px
  //   ↙ U+2199 → Hiragino Sans (JP),  32.00 px
  // The renderer's chain walker picks the first font carrying the glyph,
  // so a unified `["hiragino-jp", "korean", "lucida-grande", "symbols"]`
  // route matches all six per-codepoint choices (the font Chrome picks for
  // each is the first in the chain that has a non-zero glyph for it).
  // Supersedes the earlier U+2197/U+2199 special case at the same
  // codepoints below — keep this branch first to take precedence.
  if (codepoint === 0x2196 || codepoint === 0x2198) {
    // ↖ ↘ — Chrome picks Lucida Grande (CDP per-cp probe); Hiragino Sans DOES
    // carry glyphs for these two (unlike ↗ ↙'s original assumption), so the
    // unified chain below would stop there and paint the wrong arrow shape.
    return ["lucida-grande", "symbols"];
  }
  if (codepoint >= 0x2194 && codepoint <= 0x2199) {
    return ["hiragino-jp", "korean", "lucida-grande", "symbols"];
  }
  // DM-977: Patterned squares U+25A3..U+25A9 (▣ ▤ ▥ ▦ ▧ ▨ ▩) — Chrome
  // paints via AppleSDGothicNeo at sans-serif primary, NOT Hiragino. The
  // earlier DM-415/DM-429 attempt routed these to AppleSDGothicNeo and
  // reverted citing visible ink mismatch — re-verified the routing here
  // via per-codepoint `CSS.getPlatformFontsForNode` probe (each cp
  // returns "Apple SD Gothic Neo" as the sole font, paint width 27.69 px
  // @32 px) and width-matched with fontkit (27.68 px, sub-pixel match).
  // The visible "denser hatching" is exactly AppleSDGothicNeo's glyph —
  // the prior revert misjudged the ink delta against a different probe
  // size. `korean` is the existing key (same font file as U+25C8 above).
  if (codepoint >= 0x25a3 && codepoint <= 0x25a9) {
    return ["korean", "symbols"];
  }
  // DM-925: Gender symbols (U+2640 ♀, U+2641 ♁, U+2642 ♂) — Chrome
  // routes to **Hiragino Sans (Japanese, HiraginoSans-W3)** per
  // CSS.getPlatformFontsForNode probe, NOT Hiragino Sans GB (Chinese,
  // HiraginoSansGB-W3). The two have meaningfully different glyph
  // shapes for ♂: Japanese has the classic up-right diagonal arrow,
  // Chinese variant has a straight-up arrow. Our `cjk` route resolves
  // to GB and produced the wrong-shape glyph. Switch the chain to
  // prefer the Japanese face (`hiragino-jp`) first.
  if (codepoint >= 0x2640 && codepoint <= 0x2642) {
    return ["hiragino-jp", "cjk", "symbols"];
  }
  // Chess pieces ♔..♟ (U+2654..U+265F) — Chrome routes these through Menlo,
  // not Apple Symbols. Verified via CDP CSS.getPlatformFontsForNode at 22px
  // sans-serif: Chrome reports the font as "Menlo" and the captured advance
  // (13.234px @22px) matches Menlo's 13.245px exactly, while Apple Symbols
  // paints them at 17.188/17.284 — ~4px too wide, causing ♚ to overlap ♔
  // in domotion's render. (DM-380)
  if (codepoint >= 0x2654 && codepoint <= 0x265f) {
    return ["menlo", "symbols"];
  }
  if ((codepoint >= 0x25a0 && codepoint <= 0x25ff) || (codepoint >= 0x2600 && codepoint <= 0x26ff)) {
    // DM-988: Chrome's per-codepoint pick varies by primary-font class for
    // these blocks (Geometric Shapes + Misc Symbols). Probed at 18 px:
    //   sans primary: ★ ♥ ♠ ♣ → Hiragino Sans (JP) em-square 18 px
    //   serif primary: ★ → Songti SC (cjk-serif) em-square 18 px,
    //                  ♥ ♠ ♣ → Times New Roman proportional ~10-12 px
    //   mono primary: ★ ♥ ♠ ♣ → Menlo cell-width (~10.84 px @18)
    // The previous unified `["cjk", "hiragino-jp", "symbols"]` chain used
    // HiraginoSansGB (Chinese) first, which paints these glyphs at a
    // visibly larger / differently-shaped em-square than HiraKakuProN
    // (Japanese) — visible diff on `02-text-symbols`'s `.serif` and
    // `.mono` rows where the primary should win. Branch by primary so the
    // chain matches Chrome's per-context pick.
    const monoPrimary =
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono";
    if (monoPrimary) return [primaryKey!, "menlo", "hiragino-jp", "symbols"];
    if (serifPrimary) {
      // Card suits ♠♣♥♦ — a serif primary pulls these from Times New Roman
      // (CDP per-cp probe: ♥ → Times New Roman), while ★ stays on Songti
      // (cjk-serif). The Songti face covers the suits too, so the uniform
      // cjk-serif-first chain painted the wrong (em-square) suit glyphs.
      if (codepoint === 0x2660 || codepoint === 0x2663 || codepoint === 0x2665 || codepoint === 0x2666) {
        return ["times-new-roman", "cjk-serif", "hiragino-jp", "symbols"];
      }
      return ["cjk-serif", primaryKey ?? "times", "hiragino-jp", "symbols"];
    }
    return ["hiragino-jp", "cjk", "symbols"];
  }
  // Arrows: most of the Arrows block (↔↦⇒⇔ …) routes to Apple Symbols
  // below, but specific codepoints split off:
  //   ← → ↗ ↙  — Hiragino W6 at the CJK em-square width (24px @24px), which
  //              is what Chrome paints; Apple Symbols has them at 15-17px,
  //              rendering visibly thinner (DM-296).
  //   ↑ ↓     — LucidaGrande at 14.19px @22px, which matches Chrome's
  //              captured bounding box; Apple Symbols paints them at
  //              9.86/10.28px and Hiragino paints at 22/24px, both wrong
  //              (DM-369).
  // ← → ↑ ↓ — Lucida Grande at every size (12 → 32 px), per CDP
  // `CSS.getPlatformFontsForNode` (DM-405). The painted glyph is the
  // chunkier LucidaGrande arrow; CJK Hiragino's thin outline visibly
  // diverges (DM-296 reverted by DM-405).
  if (codepoint === 0x2190 || codepoint === 0x2192 || codepoint === 0x2191 || codepoint === 0x2193) {
    // Context split (CDP per-cp probe): serif primaries pull ← → from Times
    // New Roman and monospace primaries from Menlo; Lucida Grande remains the
    // sans pick and the fall-through for the arrows those faces lack.
    if (
      primaryKey === "courier" ||
      primaryKey === "courier-new" ||
      primaryKey === "menlo" ||
      primaryKey === "monaco" ||
      primaryKey === "sf-mono"
    ) {
      return ["menlo", "lucida-grande", "symbols"];
    }
    if (
      primaryKey === "times" ||
      primaryKey === "times-new-roman" ||
      primaryKey === "georgia" ||
      primaryKey === "palatino"
    ) {
      return ["times-new-roman", "lucida-grande", "symbols"];
    }
    return ["lucida-grande", "symbols"];
  }
  // ↗ ↙ — Lucida Grande LACKS these codepoints (verified via fontkit
  // `glyphForCodePoint(0x2197).id === 0` on the system .ttc, all four
  // faces). The earlier consolidation onto "lucida-grande" silently fell
  // through to Apple Symbols at ~10 px advance — visibly half the width
  // Chrome paints (16 px at 16 px font). Hiragino Sans GB has them at
  // em-width (adv=1000 / em=1000 → 16 px), matching Chrome's painted
  // advance. (DM-441.)
  if (codepoint === 0x2197 || codepoint === 0x2199) {
    return ["cjk", "hiragino-jp", "symbols"];
  }
  // Mathematical Alphanumeric Symbols (𝐀 𝒜 𝕊 𝟬 𝔄 𝛼 etc.) — Chrome paints
  // via STIX Two Math (the system math-coverage font); Apple Symbols
  // and Hiragino lack these glyphs entirely. DM-257.
  if (isMathAlphanumericBlock(codepoint)) {
    return ["stix-math", "symbols"];
  }
  // DM-807: Superscripts and Subscripts block (U+2070-U+209F). The label
  // glyphs `aₙ` / `a₁` use the Latin subscript letters (U+2090-U+209C)
  // and digit subscripts (U+2080-U+2089). STIX Two Math covers digit
  // sub/super-scripts but LACKS the Latin subscript letters (verified by
  // probe — `STIXTwoMath.glyphForCodePoint(0x2099).id === 0`). SF Pro is
  // the macOS font that DOES cover U+2099 and the Latin subscript range
  // (system-ui pulls in SFNS / SF Pro which has glyphs for these); put
  // it first so `aₙ` paints instead of falling through to .notdef tofu.
  if (isSuperSubscriptBlock(codepoint)) {
    return ["sf-pro", "stix-math", "hiragino-jp", "symbols"];
  }
  // General Punctuation overline / Latin-1 macron (U+203E OVERLINE, U+00AF
  // MACRON). Used as MathML over-accents — `<mover accent="true"><mi>x</mi>
  // <mo>‾</mo></mover>` paints x̄. The `math`→Times primary lacks U+203E
  // (.notdef) and this block had no fallback branch, so the accent painted a
  // .notdef tofu box (DM-811's "black blob"). Chrome paints it via Helvetica:
  // the captured `<mo>‾</mo>` advance is 7.33 px @22 px, matching Helvetica's
  // U+203E advance EXACTLY (STIX 11.26 / Apple Symbols 13.77 are both too
  // wide). Apple Symbols stays as the residue fallback. DM-896.
  if (codepoint === 0x203e || codepoint === 0x00af) {
    return ["helvetica", "symbols"];
  }
  // Letterlike (ℝℕℤℂℚ™), Arrows residue, Math Operators, Misc Technical
  // (⌘ ⌥ ⎘ etc.), Pictographs, Transport. The caller's primary-first check
  // already routes chars Helvetica/Times have (∑∏∫≠≤≥, ™, ●) to the
  // primary; what reaches this fallback is the residue (∀∃∈ ↑↓↔ ⇒⇔ etc.)
  // for which Apple Symbols is the right macOS source. (← → ↗ ↙ branch
  // above to CJK because Hiragino's em-wide glyph matches Chrome and Apple
  // Symbols' is too narrow — DM-296.)
  //
  // DM-959: Misc Technical block (U+2300..U+23FF) added — Chrome paints
  // these via Apple Symbols on macOS (verified empirically for U+2398
  // NEXT PAGE: Chrome advance 14.14 px @24 px, Apple Symbols 14.13 px).
  // Without this route the codepoint fell through to `[]` (no fallback)
  // and the renderer dropped to the primary font, which lacks the glyph
  // entirely and substituted a different symbol shape.
  // DM-1203: U+2215 DIVISION SLASH is an exception inside the math-operators
  // range below. On an SF-Pro / system-ui primary (which lacks it) Chrome
  // resolves it to Helvetica Neue via CTFontCreateForString, NOT Apple Symbols
  // — Apple Symbols' slash sits higher and farther right than Chrome's painted
  // glyph. Returning [] here drops it through to the CoreText system fallback
  // (`resolveSystemFallbackKeyForCp`), which runs the same CTFontCreateForString
  // and lands on the identical Helvetica Neue glyph. (The neighboring division
  // operators ∕-adjacent that Apple Symbols DOES match stay on the symbols rule.)
  if (codepoint === 0x2215) return [];
  if (
    isLetterlikeBlock(codepoint) ||
    (codepoint >= 0x2190 && codepoint <= 0x21ff) || // Arrows residue
    isMathOperatorsBlock(codepoint) ||
    (codepoint >= 0x2300 && codepoint <= 0x23ff) || // Misc Technical
    isPictographResidueBlock(codepoint)
  ) {
    return ["symbols"];
  }
  // DM-983: per-Unicode-block fallback derived from a Chrome CDP sweep —
  // `CSS.getPlatformFontsForNode` for every block in the html-test/unicode
  // fixture set. Probed family names are mapped to on-disk macOS font paths
  // by `tools/probe-983-genroutes.mjs` and serialized into
  // `unicode-font-routing.generated.ts`. Consulted as a LAST resort so all
  // the hand-tuned routes above (which carry per-codepoint width / shape
  // calibration) win for the blocks where Chrome's font choice is already
  // baked in. Adds coverage for scripts / symbol sets that previously fell
  // through to `[]` and rendered as tofu (cuneiform, Egyptian hieroglyphs,
  // most pre-modern scripts, Yi, Vai, Cherokee, Bamum, …).
  // Skip the LastResort tail for codepoints in the broad emoji range —
  // the capture layer attaches a raster `<image>` overlay for those
  // (DM-334) and the renderer expects the chain to end at `[]` so the
  // primary font's `.notdef` rectangle paints behind the overlay. Adding
  // LastResort here would route the emoji into its own font run and
  // trigger the per-codepoint `isEmoji` suppression, which drops the
  // glyph entirely and breaks the expected layout (S, m, i, l, e + the
  // `.notdef` slot).
  const isEmojiCp = (codepoint >= 0x1f300 && codepoint <= 0x1faff) || (codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff);
  const generatedKeyRaw = lookupUnicodeFontRange(codepoint);
  // A generated route whose family isn't installed here names a face Chrome
  // will never pick on this machine. Drop it and ask the OS what Chrome WOULD
  // use — the live CoreText resolver queries the same API Chrome does, so it
  // gives the right answer for whatever font set this machine happens to have.
  //
  // The live key must go at the HEAD rather than simply dropping the route:
  // the static tail ends in `last-resort`, whose LastResort.otf has a
  // block-frame glyph for every codepoint, so it would win and paint tofu.
  // `u-noto-sans` in that tail is itself a non-stock download and is skipped
  // when absent, which is exactly how the chain would reach `last-resort`.
  let generatedKey = generatedKeyRaw;
  let liveOverride: string | null = null;
  // Where the sampled route and the live OS resolver DISAGREE, the live answer
  // wins. The table is a snapshot of one machine's CoreText replies at sweep
  // time; the live resolver asks the same API Chrome asks, on this machine, now
  // — so when they differ it is the table that has drifted. Observed cases:
  // U+1DBB (route "Arial", live and Chrome "Menlo") and U+3251 / U+32D0 (live
  // and Chrome "Hiragino Sans").
  //
  // Measured across the full 818-fixture macOS unicode sweep before landing,
  // because the blast radius is every block: 2 fixtures fixed
  // (1D80-phonetic-extensions-supplement, 3200-enclosed-cjk-letters-and-months),
  // 0 broken, 0 made worse. The route is still what supplies the chain when the
  // two AGREE, and it remains the fallback when the OS has no answer.
  if (generatedKeyRaw != null && generatedRouteUsable(generatedKeyRaw)) {
    const live = resolveSystemFallbackKeyForCp(codepoint, css?.weight, css?.slant, css?.fontSize, primaryKey);
    if (live != null && live !== generatedKeyRaw) liveOverride = live;
  }
  if (generatedKeyRaw != null && liveOverride == null && !generatedRouteUsable(generatedKeyRaw)) {
    liveOverride = resolveSystemFallbackKeyForCp(codepoint, css?.weight, css?.slant, css?.fontSize, primaryKey);
    // If the OS has no answer either, keep the generated route: a face Chrome
    // might not pick still beats a guaranteed `last-resort` tofu.
    generatedKey = liveOverride != null ? null : generatedKeyRaw;
  }
  // DM-1850: `u-noto-sans` is injected into these chains as a RAW KEY, which
  // bypasses the installed-family check every GENERATED route already gets. The
  // consequence is not cosmetic: `DOMOTION_HIDE_FAMILIES` exists so a developer
  // Mac can reproduce a leaner machine's font choices, and it gates
  // `resolveInstalledFont` — so it hides the CSS family "Noto Sans" while these
  // three insertions still resolve straight to the file. A fixture then PASSES
  // locally under the flag and FAILS on the runner, which is exactly the case
  // the flag exists to prevent and which cost a full investigation once.
  //
  // `generatedRouteUsable` is the same predicate, so the raw key now answers to
  // it too. On a machine without Noto Sans this is a no-op (the key resolves to
  // nothing either way); on one with it, the flag finally works.
  const notoUsable = generatedRouteUsable("u-noto-sans");
  const noto: string[] = notoUsable ? ["u-noto-sans"] : [];

  if (liveOverride != null) {
    return isEmojiCp ? [liveOverride, "symbols", ...noto] : [liveOverride, "symbols", ...noto, "last-resort"];
  }
  if (generatedKey != null) {
    // DM-1018: the DM-983 per-block generated table assigns ONE font per
    // block, sampled from the first few cells. Many blocks are heterogeneous
    // — e.g. Latin Extended-D (U+A720–A7FF) samples to Helvetica Neue from
    // its leading modifier letters, but Chrome paints most of the block
    // (Egyptological / Insular / phonetic letters at U+A722+) via Noto Sans.
    // When the sampled font lacks a glyph the chain previously went
    // `[sampledFont, symbols, last-resort]` and bottomed out at the
    // LastResort `?` tofu, even though Noto Sans — which Chrome actually
    // reaches for these — has the glyph. Insert `u-noto-sans` (the basic
    // 4.6k-glyph Noto Sans with broad Latin / Greek / Cyrillic / IPA /
    // phonetic coverage) AFTER `symbols` so Apple Symbols stays the
    // preferred fallback for genuine symbol codepoints (Noto Sans lacks
    // those, so it never wins there) but letter codepoints the sampled
    // font missed resolve to Noto Sans instead of tofu. The chain walker
    // picks the first font whose `glyphForCodePoint(cp).id !== 0`, so a
    // `u-noto-sans` that's also the generatedKey or lacks the glyph is a
    // harmless no-op.
    return isEmojiCp ? [generatedKey, "symbols", ...noto] : [generatedKey, "symbols", ...noto, "last-resort"];
  }
  // No generated-table route matched (rare — the table covers most blocks).
  // Try Noto Sans before LastResort: a codepoint with no block route is
  // usually a letter Chrome resolves via its broad Latin/Greek/Cyrillic
  // cascade, which Noto Sans mirrors. DM-1018.
  if (!isEmojiCp) {
    return [...noto, "last-resort"];
  }
  // Final fallback: Apple LastResort.otf paints the block-frame placeholder
  // glyph (one per Unicode block) for every codepoint — matching what
  // Chrome on macOS paints for entirely-unmappable codepoints (Egyptian
  // Hieroglyphs Extended-A, supplementary-plane symbols no system font
  // carries, etc.). Without this the chain ends at `[]` and the renderer
  // drops to a generic placeholder that doesn't match Chrome's per-block
  // frame paint. DM-998 / DM-999 / DM-1010.
  return isEmojiCp ? [] : ["last-resort"];
}

/** Binary-search the generated `UNICODE_FONT_RANGES` for a codepoint. */
function lookupUnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES, codepoint);
}

/**
 * Is a generated per-block route valid on THIS machine?
 *
 * The DM-983 table records, per Unicode block, the family Chrome's CoreText
 * fallback picked when the table was SAMPLED — on one particular Mac. It is
 * therefore a snapshot of that machine's font inventory, and several of its
 * families are not stock: `SF Pro Text` and `Noto Sans` are separate Apple /
 * Google downloads, and the route for e.g. Cyrillic names `SF Pro Text`.
 *
 * On a machine without that family Chrome cannot pick it either, so neither may
 * we — the whole point of the table is to mirror Chrome, and a route to a font
 * Chrome will never choose is worse than no route at all. Measured on the CI
 * runner: for U+04FA Chrome painted `.New York` while we painted the route's
 * `SFNS.ttf`, across ~26 unicode fixtures that pass on a developer Mac.
 *
 * A file-existence check is NOT sufficient and was the trap here: the route's
 * path `/System/Library/Fonts/SFNS.ttf` exists everywhere. What varies is
 * whether the *family* is installed, which is what decides Chrome's pick — so
 * the check is `resolveInstalledFont(family)`, the same rule the CSS-family
 * path already applies to "SF Pro Text" (DM-1659).
 *
 * Conservative by construction: a route with no recorded family, or one whose
 * family resolves, is kept. Only a positively-absent family is rejected.
 */
function generatedRouteUsable(key: string): boolean {
  const entry = UNICODE_FONT_PATHS[key];
  const family = entry?.family;
  if (family == null || family === "") return true;
  return resolveInstalledFont(family) != null;
}
