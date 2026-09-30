/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { UNICODE_FONT_PATHS } from "./unicode-font-routing.darwin.generated.js";
import type { DarwinHandleAxis } from "./font-instance.js";

/**
 * Italic slant for SF Pro's `slnt` variation axis. SF Pro supports slnt ∈
 * roughly [-10, 0] and exposes no separate italic family, so we drive the
 * axis directly when CSS font-style is italic/oblique. Matches Chrome's
 * synthesis of italic from the variable font. Used as a cache-key component
 * so italic and upright glyphs dedupe separately. See SK-1105.
 */
export const ITALIC_SLNT = -9.99;

export interface FontPath {
  path: string;
  postscriptName?: string;
  /** An author-installed candidate rather than an OS-owned font. Its absence
   *  is a valid host state: Blink's `GetFontData` returns null when platform
   *  matching fails, and `FontFallbackIterator::Next` advances to the next
   *  CSS family (`font_cache.cc:176-190`, `font_fallback_iterator.cc:150-178`,
   *  Chromium rev 7d859f271c). Integrity audits must therefore distinguish
   *  this from a stale path for a font the platform guarantees. */
  optionalInstall?: boolean;
  /** Authoritative physical collection member supplied by the platform font
   * matcher (Linux fontconfig's FC_FILE + FC_INDEX identity). */
  faceIndex?: number;
  extractor?: "fontkit" | "native";
  /** DM-1721: axis location the platform font matcher resolved a VARIABLE face
   *  to (win32 DirectWrite reports this for live-resolver `sysfb:` picks — e.g.
   *  "Segoe UI Variable Text" is pinned at opsz 10.5 at every font size).
   *  When present, the hinted-subset pin adopts these values for the axes CSS
   *  can't derive (opsz etc.) instead of computing them from font size. Absent
   *  for static tables, macOS/Linux resolutions, and older win32 helpers. */
  resolvedAxes?: Record<string, number>;
  /** macOS: the CoreText handle's variation axes + CURRENT position at
   *  resolution time (family or fallback query). This is the FACE the
   *  PostScript name denotes — a named instance or clone ("Skia-Regular_Light"
   *  arrives with wght already at 0.48) — and it is what a declared family's
   *  axis location pins in place of any CSS-derived `wght`: Blink applies only
   *  `opsz` + font-variation-settings on top of the matched face
   *  (font_platform_data_mac.mm:113-208, Chromium tag 147.0.7727.15 and rev
   *  7d859f27 — identical). Absent for static faces, static-table keys, and
   *  helper binaries predating the family-query axis report. */
  ctAxes?: DarwinHandleAxis[];
  /** DM-2017: the fontconfig `FC_WEIGHT` / `FC_SLANT` classification of a face
   *  registered by the Linux `fcfallback` live resolver — see
   *  `FontInstance.linuxFallbackIsBold` / `linuxFallbackIsItalic` for why this
   *  travels separately from the file's own OS/2 trait. Absent for every
   *  other spec (static tables, declared-family matches, other platforms). */
  linuxFallbackIsBold?: boolean;
  linuxFallbackIsItalic?: boolean;
}

// DM-1014: pick the LastResort font Chrome actually paints with on this
// platform. On macOS Chrome's CoreText cascade bottoms out at the on-disk
// `/System/Library/Fonts/LastResort.otf` — a 2.5 KB Apple stub with 7
// glyphs whose ENTIRE cmap maps to glyph #4, a single outlined rectangle.
// Empirically that's exactly what Chrome paints for unmapped codepoints on
// macOS, so we use the system file to keep the placeholder shape byte-
// faithful. Tried bundling Unicode's LastResort-HE (Heads-up Edition, 380
// per-block-frame glyphs) under `assets/fonts/` — that DOES paint richer
// per-block frames, but Chrome on macOS doesn't reach for it, so swapping
// it in regressed pixel diffs ~2 pp on the affected fixtures (Egyptian
// Hieroglyphs Ext-A 4.05 % → 6.45 %, CJK Ext-G 3.99 % → 6.06 %, Sutton
// SignWriting 6.35 % → 7.02 %). Kept the bundled font in `assets/fonts/`
// as a future option for non-macOS platforms where Chrome's fontconfig /
// DirectWrite cascades also bottom out at "nothing" — using LR-HE there
// would AT LEAST emit a visible placeholder rather than empty space, even
// if it doesn't match Chrome's per-platform tofu pixel-for-pixel.
// DM-1980: deliberately NOT `hostPlatform()` — this picks a BUNDLED ASSET
// path, not a routing decision, and the asset that ships with the package
// does not change because we are simulating another OS.
const LAST_RESORT_FONT_PATH =
  process.platform === "darwin"
    ? "/System/Library/Fonts/LastResort.otf"
    : nodePath.resolve(
        nodePath.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "assets",
        "fonts",
        "LastResortHE-Regular.ttf",
      );

export const FONT_PATHS: Record<string, FontPath> = {
  "sf-pro": { path: "/System/Library/Fonts/SFNS.ttf" },
  // SF Pro ships its italic as a sibling file, not as a variable `slnt` axis
  // on SFNS.ttf — so for CSS font-style:italic / oblique we switch to this
  // font instead of trying to drive a nonexistent axis. See SK-1105.
  "sf-pro-italic": { path: "/System/Library/Fonts/SFNSItalic.ttf" },
  "sf-mono": { path: "/System/Library/Fonts/SFNSMono.ttf" },
  "sf-mono-italic": { path: "/System/Library/Fonts/SFNSMonoItalic.ttf" },
  // Chrome on macOS resolves the CSS `monospace` generic keyword to Courier
  // (per Blink's third_party/blink/renderer/platform/fonts/mac
  // font_cache_mac.mm — kMonospaceFamily → kCourier), NOT SF Mono or Menlo.
  // SF Mono is ~3% wider than Courier at the same em size and has a 2px
  // taller ascent at 13px (rounded), so substituting it for `monospace`
  // misaligns `<code>` baselines against the surrounding sans-serif text.
  // Courier.ttc is a collection: weight × slant variants picked by
  // postscriptName in getFontInstance.
  courier: { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier" },
  "courier-bold": { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Bold" },
  "courier-italic": { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Oblique" },
  "courier-bold-italic": { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-BoldOblique" },
  // `Courier New` is its own installed face (macOS Supplemental), resolved
  // directly by Chrome when CSS names it; the Courier alias is strictly a
  // lookup-failure retry (`font_platform_data_cache.cc:74-105`, rev 7d859f27).
  // Same four-sibling shape as the `times-new-roman*` keys above.
  "courier-new": { path: "/System/Library/Fonts/Supplemental/Courier New.ttf" },
  "courier-new-bold": { path: "/System/Library/Fonts/Supplemental/Courier New Bold.ttf" },
  "courier-new-italic": { path: "/System/Library/Fonts/Supplemental/Courier New Italic.ttf" },
  "courier-new-bold-italic": { path: "/System/Library/Fonts/Supplemental/Courier New Bold Italic.ttf" },
  // Author-named monospace families. Menlo and Monaco both ship as system
  // fonts with their own metrics — different from Courier and SF Mono — so
  // when an author explicitly requests them we should honor that rather than
  // substitute one mono for another.
  menlo: { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Regular" },
  "menlo-bold": { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Bold" },
  "menlo-italic": { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Italic" },
  "menlo-bold-italic": { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-BoldItalic" },
  monaco: { path: "/System/Library/Fonts/Monaco.ttf" },
  // Chrome on macOS uses Geeza Pro for the Arabic block, NOT SF Arabic. SF
  // Arabic glyphs are wider (~29.7px for بحرم at 16px) while Geeza Pro
  // matches Chrome's painted width (~27.6px) — DM-270 probe. SF Arabic was
  // designed for Apple system UI and isn't what Chrome's CoreText fallback
  // picks for `Times` body text.
  "sf-arabic": { path: "/System/Library/Fonts/GeezaPro.ttc", postscriptName: "GeezaPro" },
  "sf-hebrew": { path: "/System/Library/Fonts/SFHebrew.ttf" },
  // Hiragino Sans GB ships W3 (regular) and W6 (bold) as separate sub-fonts in
  // the same TTC; the file doesn't expose a usable wght axis (DM-256), so the
  // bold variant is selected by postscriptName at the spec level — same
  // pattern as helvetica/times/georgia. The advance widths are identical
  // between W3/W6 (24px @24px font-size for em-square glyphs) but the stem
  // thickness differs, so headings using cjk-block fallback chars (← → ▲ ☀)
  // need W6 to match Chrome's painted weight.
  //
  // PingFang SC: what Chrome on macOS actually paints unmarked Han ideographs
  // (漢 字 北 京 東 明 日 …) through, NOT HiraginoSansGB. Verified via CDP
  // `CSS.getPlatformFontsForNode` against the 02-text-ruby fixture: every Han
  // codepoint resolves to "蘋方-簡" (PingFang SC). PingFang stores its outlines
  // in Apple's proprietary `hvgl` table — fontkit's outline parser doesn't
  // read that, so we route extraction through the CoreText helper
  // (`packages/text-engine/tools/macos-glyph-extractor/`). HiraginoSansGB stays as the secondary
  // route via `cjk` for any glyph PingFang lacks. DM-382 / DM-364 / DM-385 /
  // DM-388.
  "pingfang-sc": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangSC-Regular",
    extractor: "native",
  },
  "pingfang-sc-bold": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangSC-Medium",
    extractor: "native",
  },
  // Per-locale PingFang variants (DM-394). Apple ships the same `hvgl`-only
  // PingFang.ttc with regional faces for Traditional Chinese, Hong Kong, and
  // Macau. Chrome routes by computed `lang`: zh-TW / zh-Hant → TC, zh-HK → HK,
  // zh-MO → MO. There is no `PingFangJP-Regular` postscriptName on macOS;
  // Japanese text routes through `hiragino-jp` (HiraKakuProN) instead.
  "pingfang-tc": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangTC-Regular",
    extractor: "native",
  },
  "pingfang-tc-bold": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangTC-Medium",
    extractor: "native",
  },
  "pingfang-hk": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangHK-Regular",
    extractor: "native",
  },
  "pingfang-hk-bold": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangHK-Medium",
    extractor: "native",
  },
  "pingfang-mo": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangMO-Regular",
    extractor: "native",
  },
  "pingfang-mo-bold": {
    path: "/System/Library/Fonts/PingFang.ttc",
    postscriptName: "PingFangMO-Medium",
    extractor: "native",
  },
  cjk: { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W3" },
  "cjk-bold": { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W6" },
  // Songti SC Light (postscriptName STSongti-SC-Light) is what Chrome on
  // macOS picks for CJK chars when the primary is a SERIF family —
  // `font-family: serif` / `Times` resolve to the `times` key directly, and a
  // bare `ui-serif` / `fangsong` / `math` / UA-default stack lands on the same
  // key via the standard-family TERMINAL (those names are walked past, not
  // routed). Empirical pixel probe at 16px against `font-
  // family: serif` rendering "你好世界" shows STSongti-SC-Light produces
  // a 100.000% pixel match — neither HiraginoSansGB-W3 (90.20%) nor
  // Songti SC Regular (90.23%) matches. DM-333. Same em-square advance
  // (16px @16px) as the sans-serif `cjk` route, so layout is unaffected;
  // only the visible glyph shape (stroke contrast / Mincho-style shapes)
  // changes when the primary is serif.
  "cjk-serif": { path: "/System/Library/Fonts/Supplemental/Songti.ttc", postscriptName: "STSongti-SC-Light" },
  "cjk-serif-bold": { path: "/System/Library/Fonts/Supplemental/Songti.ttc", postscriptName: "STSongti-SC-Bold" },
  // Hiragino Mincho ProN — the Japanese serif (明朝) family. Routed ONLY when an
  // author NAMES it explicitly (`font-family: "Hiragino Mincho ProN"`), not for
  // the generic `serif` keyword (that stays Songti, DM-333). Unlike Songti it
  // carries the East-Asian OpenType features `trad` / `jp78` / `fwid` / `pwid`,
  // so `font-variant-east-asian: traditional` substitutes the traditional form
  // (国→國) and `full-width` substitutes the full-width Latin forms — neither of
  // which Songti can do. W3 is regular, W6 the bold pair. DM-1117.
  "hiragino-mincho": { path: "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", postscriptName: "HiraMinProN-W3" },
  "hiragino-mincho-bold": { path: "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", postscriptName: "HiraMinProN-W6" },
  // Hiragino Sans (the Japanese family, not GB) covers a much wider set of
  // Geometric Shapes and Misc Symbols at em-square width — ◉◌◐◑ ☀☁☂☃ etc. —
  // that the GB family lacks. Chrome on macOS routes these chars here when
  // the primary Helvetica/Times/etc. doesn't have them and HiraginoSansGB
  // doesn't either, painting at 18px em-square; Apple Symbols' versions are
  // proportional 11-15px so falling all the way through to "symbols" left
  // them visibly narrower than Chrome (DM-324 / DM-326). The TTC ships W3..W9
  // sub-fonts; W3 is the regular weight, W6 is the bold pair to match the
  // existing cjk → cjk-bold weight swap.
  // Chrome resolves `font-family:"Hiragino Sans"` to the HiraginoSans-W* cut
  // whose OS/2.usWeightClass EXACTLY matches the CSS weight — measured over
  // 100..900 with CDP getPlatformFontsForNode: 100→W0 200→W1 300→W3 400→W4
  // 500→W5 600→W6 700→W7 800→W8 900→W9. (W2 exists at usWeightClass 250 and is
  // never selected, because no CSS weight lands there.) The base key is W4, the
  // weight-400 cut — NOT HiraKakuProN-W3, which is a different family
  // (Hiragino Kaku Gothic ProN) that merely shares the W3 .ttc container.
  "hiragino-jp": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc", postscriptName: "HiraginoSans-W4" },
  "hiragino-jp-bold": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", postscriptName: "HiraginoSans-W6" },
  "hiragino-jp-w0": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W0.ttc", postscriptName: "HiraginoSans-W0" },
  "hiragino-jp-w1": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W1.ttc", postscriptName: "HiraginoSans-W1" },
  "hiragino-jp-w3": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", postscriptName: "HiraginoSans-W3" },
  "hiragino-jp-w4": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc", postscriptName: "HiraginoSans-W4" },
  "hiragino-jp-w5": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc", postscriptName: "HiraginoSans-W5" },
  "hiragino-jp-w6": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", postscriptName: "HiraginoSans-W6" },
  "hiragino-jp-w7": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W7.ttc", postscriptName: "HiraginoSans-W7" },
  "hiragino-jp-w8": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc", postscriptName: "HiraginoSans-W8" },
  "hiragino-jp-w9": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W9.ttc", postscriptName: "HiraginoSans-W9" },
  // Korean Hangul (U+AC00..D7AF Syllables, U+1100..11FF Jamo). Chrome on
  // macOS paints Hangul via Apple SD Gothic Neo — neither Hiragino Sans GB
  // (the `cjk` chain) nor PingFang SC includes Hangul codepoints, so a
  // missing dedicated route leaves Korean text as tofu boxes. DM-691.
  korean: { path: "/System/Library/Fonts/AppleSDGothicNeo.ttc", postscriptName: "AppleSDGothicNeo-Regular" },
  "korean-bold": { path: "/System/Library/Fonts/AppleSDGothicNeo.ttc", postscriptName: "AppleSDGothicNeo-Bold" },
  thai: { path: "/System/Library/Fonts/ThonburiUI.ttc", postscriptName: ".ThonburiUI-Regular" },
  devanagari: { path: "/System/Library/Fonts/Kohinoor.ttc", postscriptName: "KohinoorDevanagari-Regular" },
  symbols: { path: "/System/Library/Fonts/Apple Symbols.ttf" },
  // The absolute final fallback Chrome reaches when no font in the cascade
  // has a glyph for a codepoint. It contains one "block-frame" glyph per
  // Unicode block (SMP gets stacked horizontal stripes, Egyptian Hieroglyphs
  // gets an empty rectangle, CJK ranges get a hex-numbered tofu, etc.), so
  // painting a codepoint via LastResort matches what Chrome paints for
  // anything otherwise unmappable. DM-998 / DM-999 / DM-1010.
  //
  // DM-1014: bundle Unicode's LastResort-HE (Heads-up Edition) font under
  // `packages/text-engine/assets/fonts/LastResortHE-Regular.ttf` so we ship the same per-block-
  // frame glyphs Chrome uses, regardless of host OS. The macOS on-disk
  // `/System/Library/Fonts/LastResort.otf` is a 2.5 KB stub with 7 glyphs
  // (every codepoint cmap-maps to glyph #4, a single rectangle-with-?);
  // bundling LR-HE gives us 380 distinct block-frame glyphs. SIL Open Font
  // License 1.1 — `assets/fonts/LICENSE-last-resort-font.txt` ships
  // alongside the binary per the OFL attribution clause.
  "last-resort": { path: LAST_RESORT_FONT_PATH },
  // Chrome on macOS routes a handful of arrow codepoints (↑ ↓) to LucidaGrande
  // rather than Apple Symbols — Apple Symbols' ↑ ↓ are 9.86/10.28px wide
  // @22px while LucidaGrande's are 14.19/14.19px, and Chrome's captured
  // bounding box matches LucidaGrande to within 0.01px. DM-369. Other arrows
  // (↔ ⇒ ⇔ etc.) stay on Apple Symbols because LucidaGrande lacks those
  // glyphs.
  "lucida-grande": { path: "/System/Library/Fonts/LucidaGrande.ttc", postscriptName: "LucidaGrande" },
  // LucidaGrande.ttc's bold member. Chrome switches the whole family over to it
  // from CSS weight 450 up — an ↑ or ✓ falling back to Lucida Grande inside a
  // bold heading is painted BOLD, not regular. Measured over 100…900 in
  // 10-point steps with `CSS.getPlatformFontsForNode` (Chromium on macOS) for
  // arrow / Hebrew / check-mark codepoints alike: 100-440 → LucidaGrande,
  // 450-900 → LucidaGrande-Bold. The 450 boundary is the platform matcher's,
  // not the CSS font-matching walk's — the two faces declare
  // `OS/2.usWeightClass` 500 and 600, which the spec algorithm would split at a
  // different point.
  "lucida-grande-bold": { path: "/System/Library/Fonts/LucidaGrande.ttc", postscriptName: "LucidaGrande-Bold" },
  // Chrome on macOS routes Dingbats (U+2700-27BF: ✂✈✏✔✘✚✦❄❤❶ etc.) to
  // Zapf Dingbats, NOT Apple Symbols. Apple Symbols' glyphs at the same
  // codepoints exist but have different (narrower, often slightly different
  // shape) widths — verified empirically per DM-241 follow-up: every dingbat
  // tested matched Zapf Dingbats' natural advance, none matched Apple Symbols'.
  "zapf-dingbats": { path: "/System/Library/Fonts/ZapfDingbats.ttf" },
  // Mathematical Alphanumeric Symbols (U+1D400-1D7FF: 𝐀 𝒜 𝕊 𝟬 𝔄 𝛼 etc.)
  // — Chrome paints these via STIX Two Math, the math-coverage font Apple
  // ships in Supplemental. Verified empirically (DM-257): every Math Alpha
  // char tested matched STIXTwoMath's natural advance to within 0.05px,
  // while Apple Symbols and Helvetica lack these glyphs entirely (would
  // render as .notdef tofu).
  "stix-math": { path: "/System/Library/Fonts/Supplemental/STIXTwoMath.otf" },
  // Chrome on macOS resolves the CSS `sans-serif` generic keyword to
  // Helvetica (per Blink's third_party/blink/renderer/platform/fonts/mac
  // font_cache_mac.mm). This is critical for fidelity — SF Pro has different
  // glyph shapes and metrics, so substituting it for `sans-serif` produces
  // visible drift on every page that uses the default. Helvetica.ttc is a
  // collection: pick weight × slant variants by postscriptName in
  // getFontInstance.
  helvetica: { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica" },
  // DM-1189 / DM-1199 / DM-1196 / DM-1183: the REAL Helvetica Neue, distinct
  // from Helvetica.ttc above (and from the mislabeled generated `u-helvetica-
  // neue` key, which also points at Helvetica.ttc). On an SF-Pro / system-ui
  // primary, Blink's CoreText fallback resolves a cluster of letterlike / math /
  // archaic-Latin / Cyrillic codepoints the primary lacks (ℓ ℮ ŉ Ѫ Ƣ ∕) to THIS
  // face — BEFORE it reaches the declared `sans-serif`→Helvetica generic — so the
  // glyphs differ from what Domotion's declared-family walk picks. Routed in
  // resolveFontForCodepoint for the sf-pro primary case.
  "helvetica-neue": { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue" },
  "helvetica-neue-bold": { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue-Bold" },
  "helvetica-neue-italic": { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue-Italic" },
  "helvetica-neue-bold-italic": {
    path: "/System/Library/Fonts/HelveticaNeue.ttc",
    postscriptName: "HelveticaNeue-BoldItalic",
  },
  "helvetica-bold": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Bold" },
  "helvetica-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Oblique" },
  "helvetica-bold-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-BoldOblique" },
  // Helvetica.ttc also carries a LIGHT cut (`OS/2.usWeightClass` 300) that the
  // regular/bold pair above hides. Chrome picks it for every CSS weight ≤ 300 —
  // measured over the whole 100…700 range with `CSS.getPlatformFontsForNode`
  // (Chromium on macOS): 100-300 → Helvetica-Light, 310-590 → Helvetica,
  // 600-700 → Helvetica-Bold, with the oblique column parallel. Routed by
  // `subBoldWeightCutSuffix` in getFontInstance.
  "helvetica-light": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Light" },
  "helvetica-light-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-LightOblique" },
  // Arial ships as separate weight/style files in macOS Supplemental.
  arial: { path: "/System/Library/Fonts/Supplemental/Arial.ttf" },
  "arial-bold": { path: "/System/Library/Fonts/Supplemental/Arial Bold.ttf" },
  "arial-italic": { path: "/System/Library/Fonts/Supplemental/Arial Italic.ttf" },
  "arial-bold-italic": { path: "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf" },
  // Generic serif. Chrome on macOS resolves `font-family: serif`, bare
  // `Times`, `ui-serif`, and the UA-default body/h1 (when no font-family is
  // set) to Apple's `Times.ttc` — NOT to Times New Roman. The two faces have
  // identical advance widths for every glyph tested (so layout is unchanged)
  // but visibly different outlines: Apple Times has bolder em-dash / en-dash
  // bars (H=185 units in Bold vs TNR's 122) and slightly taller caps. The
  // h1 default font-weight: bold made the em-dash mismatch the most visible
  // case (DM-330). Author-named "Times New Roman" still routes to the
  // separate `times-new-roman*` keys below so explicit requests are honored.
  times: { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Roman" },
  "times-bold": { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Bold" },
  "times-italic": { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Italic" },
  "times-bold-italic": { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-BoldItalic" },
  // Times New Roman (the Microsoft face shipped in Supplemental on macOS) is
  // what Chrome picks when CSS specifies `font-family: "Times New Roman"`
  // explicitly — same advance metrics as Apple's Times above but a thinner
  // em-dash / en-dash and shorter caps.
  "times-new-roman": { path: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
  "times-new-roman-bold": { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf" },
  "times-new-roman-italic": { path: "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf" },
  "times-new-roman-bold-italic": { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf" },
  georgia: { path: "/System/Library/Fonts/Supplemental/Georgia.ttf" },
  "georgia-bold": { path: "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" },
  "georgia-italic": { path: "/System/Library/Fonts/Supplemental/Georgia Italic.ttf" },
  "georgia-bold-italic": { path: "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf" },
  // Source Serif Pro — Adobe's open-source serif, often installed in
  // `/Library/Fonts/` rather than as a base macOS face. Chrome picks it up
  // when CSS specifies `font-family: 'Source Serif Pro'` AND the file is
  // present; otherwise Chrome falls through to the next family in the
  // stack. Domotion mirrors that: when the path doesn't exist on this
  // host, `resolveFont` returns null for the SSP key and the family-chain
  // walks to the next entry (typically `serif` → Times). DM-804.
  "source-serif-pro": { path: "/Library/Fonts/SourceSerifPro-Regular.ttf", optionalInstall: true },
  "source-serif-pro-bold": { path: "/Library/Fonts/SourceSerifPro-Bold.ttf", optionalInstall: true },
  "source-serif-pro-italic": { path: "/Library/Fonts/SourceSerifPro-Italic.ttf", optionalInstall: true },
  "source-serif-pro-bold-italic": { path: "/Library/Fonts/SourceSerifPro-BoldItalic.ttf", optionalInstall: true },
  // Playfair Display — a high-contrast display serif (Google Fonts), commonly
  // installed under `/Library/Fonts/` for drop caps / headings. Same
  // present-or-fall-through contract as Source Serif Pro: Chrome on macOS picks
  // it up when CSS names it AND the file is on disk (verified via
  // `CSS.getPlatformFontsForNode` on the `24-deep-initial-letter` drop cap —
  // Chrome paints the `B` from PlayfairDisplay-Regular, with Georgia for the
  // body), otherwise it falls through to the next family (Georgia / serif).
  // When the path is absent, `resolveFont` returns null and the family chain
  // walks on, matching Chrome's fallback on a host without Playfair. DM-1120.
  "playfair-display": { path: "/Library/Fonts/PlayfairDisplay-Regular.ttf", optionalInstall: true },
  "playfair-display-bold": { path: "/Library/Fonts/PlayfairDisplay-Bold.ttf", optionalInstall: true },
  "playfair-display-italic": { path: "/Library/Fonts/PlayfairDisplay-Italic.ttf", optionalInstall: true },
  "playfair-display-bold-italic": { path: "/Library/Fonts/PlayfairDisplay-BoldItalic.ttf", optionalInstall: true },
  // Generic cursive — Chrome on macOS resolves `cursive` to Apple Chancery
  // (NOT Snell Roundhand). Empirical probe at 16px on the sample "The quick
  // brown fox jumps over the lazy dog": Chrome cursive = 290.08px, Apple
  // Chancery = 290.08px, Snell Roundhand = 263.84px. SnellRoundhand stays in
  // FONT_PATHS for `font-family: "Snell Roundhand"` author requests.
  snell: { path: "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", postscriptName: "SnellRoundhand" },
  "apple-chancery": { path: "/System/Library/Fonts/Supplemental/Apple Chancery.ttf" },
  // Generic fantasy — Chrome on macOS resolves `fantasy` to Papyrus.
  // Empirical probe at 16px: Chrome fantasy = 313.94px, Papyrus = 313.94px,
  // Impact = 286.03px (a common other "fantasy" candidate, but not what
  // Chrome picks). Papyrus.ttc ships W3 + Condensed sub-fonts; the default
  // (no postscriptName) picks the Regular member.
  papyrus: { path: "/System/Library/Fonts/Supplemental/Papyrus.ttc", postscriptName: "Papyrus" },
  // DM-983: per-Unicode-block routes for codepoints that don't match any
  // hand-coded rule in `darwinFallbackChain` below. Generated from a
  // `CSS.getPlatformFontsForNode` sweep across every block in
  // `../html-test/unicode/*.html` (see `tools/probe-983-genroutes.mjs`).
  // 142 fonts, 319 block routes. Each entry's key is namespaced under
  // `u-...` so it can't collide with a hand-coded key here.
  ...UNICODE_FONT_PATHS,
  // DM-1924: name the member this key means, because opening a COLLECTION by
  // path alone selects member 0 and that is the vendor's ordering, not a face
  // any routing table meant. `NotoSansMyanmar.ttc` carries 18 members and member
  // 0 is **Black**, so every Myanmar run painted at weight 900 whatever the CSS
  // asked for — and nothing downstream could notice, since `postscriptName` and
  // `naturalWeight` both came back undefined on the instance. Chrome, asked over
  // CDP, answers `NotoSansMyanmar-Regular` at weight 400: U+1000 advance 1124,
  // against Black's 1121.
  //
  // Same defect this repo already fixed once for `NotoSansArmenian.ttc`, whose
  // member 0 is also Black. Members 9-17 here are Zawgyi, a non-Unicode Myanmar
  // encoding, so a fix by member INDEX rather than by name would have traded a
  // weight error for mojibake.
  //
  // Overridden here rather than edited into the generated table, which says not
  // to edit it by hand and would lose this on the next sweep. The generator is
  // what should learn to emit a name. The spread above comes first, so this wins.
  // `family` is deliberately absent: it is not part of `FontPath`, and
  // `generatedRouteUsable` reads it from `UNICODE_FONT_PATHS` directly.
  //
  // Weight 400 only. Chrome answers `NotoSansMyanmar-Bold` at 700, so this family
  // has a ladder inside the container that one pinned member cannot serve; at 700
  // the renderer now synthesizes bold over Regular instead of taking the Bold
  // member. Still strictly better than Black at every weight, and the ladder
  // belongs with the per-family weight-ladder work.
  //
  // The SIBLING renames this started as — the SF faces and the other Noto
  // variable files — are NOT here. They measured as pure improvements in
  // isolation (by-name equals HarfBuzz exactly where by-path does not) and are
  // inert locally, yet the branch carrying them regressed a fixture on CI by 30x
  // worst tile, reproducibly, against a control ref run twice. Until that is
  // explained they stay out; see the ticket.
  "u-noto-sans-myanmar": {
    path: "/System/Library/Fonts/NotoSansMyanmar.ttc",
    postscriptName: "NotoSansMyanmar-Regular",
    extractor: "native" as const,
  },
};
