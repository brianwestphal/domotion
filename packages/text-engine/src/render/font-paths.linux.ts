/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { UNICODE_FONT_PATHS_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_PATHS_NOTO_LINUX } from "./unicode-font-routing.noto-linux.generated.js";
import { fcMatch } from "./font-paths.win32.js";

// ── Cross-platform font path discovery (DM-258) ──
//
// FONT_PATHS above is the `darwin` table — its paths and the long
// calibration comments are specific to Chromium-on-macOS's CoreText
// fallback. Linux (fontconfig) and Windows (DirectWrite) ship an entirely
// different font set, so the SAME logical keys (`helvetica`, `times`,
// `courier`, `cjk`, `symbols`, …) resolve to different files there. The
// tables below map those keys per platform; everything downstream of
// `resolveFontSpec` (the weight/slant variant logic, the native-helper route,
// `fontkit.openSync`) is unchanged.
//
// SCOPE NOTE: this is *path discovery only*. The `fallbackFontChain` routing
// — which logical key handles which Unicode block — stays calibrated to
// macOS until per-platform calibration lands (Linux: DM-259, Windows:
// DM-260). So on Linux/Windows the primary families resolve to real fonts
// (no more universal .notdef tofu) but symbol / CJK / RTL block coverage is
// not yet platform-faithful. The point of this layer is only that
// `getFontInstance("helvetica")` returns *a* sans-serif face instead of null.

/**
 * A Linux font entry. `fcMatch` is a fontconfig pattern resolved via
 * `fc-match` — robust across distro path conventions (Debian's
 * `/usr/share/fonts/truetype/...` vs Arch/Fedora layouts). `path` is an
 * optional canonical hint tried first when it exists on disk; when it
 * doesn't, we fall through to `fc-match`. `postscriptName` selects the TTC
 * member for collection files (Noto CJK).
 */
interface LinuxFontPath {
  fcMatch?: string;
  path?: string;
  postscriptName?: string;
  extractor?: "fontkit" | "native";
}

const LIB = "/usr/share/fonts/truetype/liberation";

const FREEFONT = "/usr/share/fonts/truetype/freefont";

const WQY = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

// DM-1404: mainstream desktop-Linux Noto install locations (fonts-noto-core /
// fonts-noto-cjk). Used by the Noto profile overlay below.
const NOTO = "/usr/share/fonts/truetype/noto";

const NOTO_CJK = "/usr/share/fonts/opentype/noto";

// Linux font map — calibrated to what Chromium-on-Linux actually PAINTS in the
// Playwright `*-noble` CI image (DM-259), measured via CDP
// `CSS.getPlatformFontsForNode` (tools/probe-fallbacks-linux.mjs). That image
// has NO DejaVu and NO Noto (except Color Emoji) — the real faces are:
//   sans-serif → Liberation Sans     serif → Liberation Serif
//   monospace  → WenQuanYi Zen Hei Mono   (its fontconfig monospace alias)
//   CJK (Han/Kana/Hangul) → WenQuanYi Zen Hei
//   Arabic → FreeSerif   Devanagari → FreeSans   Thai → Loma   Japanese → IPAGothic
//   symbol/geometric/arrows → Liberation Sans;  dingbats/letterlike/math → FreeSans/FreeSerif
//   emoji → Noto Color Emoji (raster path — doc 15, not a glyph-path key)
// `fc-match` stays the discovery fallback for other distros (Fedora/Arch); the
// canonical paths below short-circuit it in the CI image. NOTE: this baseline
// is the bare Playwright image (option A); if CI later `apt install`s Noto
// (option B), the CJK/symbol routing must be re-probed. See doc 42.
export const LINUX_FONT_PATHS: Record<string, LinuxFontPath> = {
  // system-ui → sans (Liberation Sans).
  "sf-pro": { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "sf-pro-italic": { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  // sans-serif primary → Liberation Sans (probe: latin-sans).
  helvetica: { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "helvetica-bold": { fcMatch: "Liberation Sans:bold", path: `${LIB}/LiberationSans-Bold.ttf` },
  "helvetica-italic": { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  "helvetica-bold-italic": { fcMatch: "Liberation Sans:bold:italic", path: `${LIB}/LiberationSans-BoldItalic.ttf` },
  arial: { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "arial-bold": { fcMatch: "Liberation Sans:bold", path: `${LIB}/LiberationSans-Bold.ttf` },
  "arial-italic": { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  "arial-bold-italic": { fcMatch: "Liberation Sans:bold:italic", path: `${LIB}/LiberationSans-BoldItalic.ttf` },
  "lucida-grande": { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  // monospace primary → WenQuanYi Zen Hei Mono (probe: latin-mono — this image's
  // fontconfig resolves the `monospace` generic there, not to Liberation Mono).
  // No separate bold/italic faces in the TTC.
  courier: { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-bold": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-italic": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-bold-italic": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  // A declared `Courier New` resolves through fontconfig's metric-equivalence
  // class to Liberation Mono on the noble image (measured over CDP,
  // tools/probe-1955-declared-walk.mjs) — the same shape as the
  // `times-new-roman*` → Liberation Serif entries below. The live nomination
  // walk answers this when armed; these entries keep the disarmed static
  // route on the face Chrome actually paints.
  "courier-new": { fcMatch: "Liberation Mono", path: `${LIB}/LiberationMono-Regular.ttf` },
  "courier-new-bold": { fcMatch: "Liberation Mono:bold", path: `${LIB}/LiberationMono-Bold.ttf` },
  "courier-new-italic": { fcMatch: "Liberation Mono:italic", path: `${LIB}/LiberationMono-Italic.ttf` },
  "courier-new-bold-italic": { fcMatch: "Liberation Mono:bold:italic", path: `${LIB}/LiberationMono-BoldItalic.ttf` },
  menlo: { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-bold": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-italic": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-bold-italic": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  monaco: { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "sf-mono": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "sf-mono-italic": { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  // serif primary → Liberation Serif (probe: latin-serif).
  times: { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "times-bold": { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "times-italic": { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "times-bold-italic": { fcMatch: "Liberation Serif:bold:italic", path: `${LIB}/LiberationSerif-BoldItalic.ttf` },
  "times-new-roman": { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "times-new-roman-bold": { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "times-new-roman-italic": { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "times-new-roman-bold-italic": {
    fcMatch: "Liberation Serif:bold:italic",
    path: `${LIB}/LiberationSerif-BoldItalic.ttf`,
  },
  georgia: { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "georgia-bold": { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "georgia-italic": { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "georgia-bold-italic": { fcMatch: "Liberation Serif:bold:italic", path: `${LIB}/LiberationSerif-BoldItalic.ttf` },
  // FreeFont — Chromium's per-script fallback in this image for several blocks.
  "free-sans": { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "free-serif": { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  // FreeFont bold / oblique siblings. Used by the Math-Alphanumeric
  // decomposition fallback (mathAlphaToBase): Chromium-on-Linux paints
  // 𝑎/𝛼/𝐀 by synthesizing from the base Latin/Greek letters in the
  // already-italic FreeSansOblique face (FreeSans's cmap has no U+1D4xx),
  // so when a Math-Alpha codepoint resolves to .notdef across the chain we
  // render the base letter in the matching weight/slant FreeFont file. The
  // distinct key disambiguates the glyph-dedup cache from the upright face.
  // (FreeSans names its slanted face "Oblique"; FreeSerif names it "Italic".)
  "free-sans-bold": { fcMatch: "FreeSans:bold", path: `${FREEFONT}/FreeSansBold.ttf` },
  "free-sans-italic": { fcMatch: "FreeSans:italic", path: `${FREEFONT}/FreeSansOblique.ttf` },
  "free-sans-bold-italic": { fcMatch: "FreeSans:bold:italic", path: `${FREEFONT}/FreeSansBoldOblique.ttf` },
  "free-serif-bold": { fcMatch: "FreeSerif:bold", path: `${FREEFONT}/FreeSerifBold.ttf` },
  "free-serif-italic": { fcMatch: "FreeSerif:italic", path: `${FREEFONT}/FreeSerifItalic.ttf` },
  "free-serif-bold-italic": { fcMatch: "FreeSerif:bold:italic", path: `${FREEFONT}/FreeSerifBoldItalic.ttf` },
  // CJK — WenQuanYi Zen Hei (single weight; bold/serif map to the same face).
  // The macOS PingFang/Hiragino/Apple-SD logical keys all collapse here on
  // Linux. `hiragino-jp` → IPAGothic (what Chromium picks for lang=ja).
  cjk: { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-serif": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-serif-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  // DM-1117: no Hiragino Mincho on Linux — collapse the explicit-name route to
  // the serif CJK face this image ships. The `trad`/`fwid` substitutions won't
  // fire here (WenQuanYi lacks those GSUB features), a known platform gap on the
  // not-yet-calibrated Linux chain; the glyph still resolves.
  "hiragino-mincho": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "hiragino-mincho-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-sc": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-sc-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-tc": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-tc-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-hk": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-hk-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-mo": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-mo-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  korean: { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "korean-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "hiragino-jp": { fcMatch: "IPAGothic", path: "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf" },
  "hiragino-jp-bold": { fcMatch: "IPAGothic", path: "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf" },
  // Indic / RTL / Thai — Chromium's lang-fallback faces in this image.
  thai: { fcMatch: "Loma", path: "/usr/share/fonts/opentype/tlwg/Loma.otf" },
  devanagari: { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "sf-arabic": { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  "sf-hebrew": { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  // Symbol blocks — FreeFont carries the dingbat/letterlike/math glyphs.
  symbols: { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "zapf-dingbats": { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "stix-math": { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  // cursive / fantasy. Asking fontconfig for its own `cursive` / `fantasy`
  // aliases is the intuitive move and it is the WRONG QUESTION: Blink never
  // asks fontconfig for these. `FontSelector::FamilyNameFromSettings` maps the
  // generic to a browser-side settings value — `settings.Cursive(script)` /
  // `settings.Fantasy(script)` (`platform/fonts/font_selector.cc:80-83`, rev
  // 7d859f27). In the capture session those settings are PLAYWRIGHT's: it
  // applies "Comic Sans MS" / "Impact" via CDP `Page.setFontFamilies`
  // (`playwright-core/lib/server/chromium/defaultFontFamilies.js`, 1.59.1 —
  // same values as `chrome/app/resources/locale_settings_linux.grd`, rev
  // 7d859f27, the table's upstream provenance) — and
  // that value goes through the family matcher's acceptance filter
  // (`SkFontConfigInterfaceDirect::MatchFont`, Skia rev 62efacd3:553-590),
  // which REJECTS the WenQuanYi substitute fontconfig offers for it, so the
  // family is unavailable and the run terminates at the standard family
  // ("Times New Roman" → Liberation Serif on this image).
  //
  // When the live resolver is ARMED, `matchFamilyNameToKey` runs exactly that
  // mechanism (`LINUX_GENERIC_FAMILY_DEFAULTS` + the nomination walk) and
  // these keys are never produced for the generics. The entries below are the
  // DISARMED net (no helper / DOMOTION_SYSTEM_FALLBACK=0), carrying the
  // measured outcome directly.
  //
  // Measured in the pinned noble image (Chromium 147.0.7727.0, CDP
  // `CSS.getPlatformFontsForNode`): Chrome answers **Liberation Serif** for
  // both generics. fontconfig's aliases answer WenQuanYi Zen Hei, and that gap
  // cost 448,990 mismatches — 63.5% of the platform's entire full-corpus
  // mismatch mass — because the generic is the run's PRIMARY, so one wrong
  // answer applies to every codepoint the stack touches.
  //
  // `snell` keeps the fontconfig alias: it is an author-NAMED family, not a
  // settings-mapped generic, so Blink resolves it through the normal family
  // matcher and a substitute is the right behavior.
  snell: { fcMatch: "cursive" },
  "apple-chancery": { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  papyrus: { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  // source-serif-pro intentionally omitted — when fontconfig has no match it
  // resolves to a generic, which would mask the "not installed → fall through
  // the family chain" behavior. Returning null lets the chain walk on, same
  // as the macOS `/Library/Fonts/SourceSerifPro-*` absent case.
  // DM-984: per-Unicode-block routes derived from a Chrome CDP sweep of the
  // bare Playwright Docker image. Generated by tools/probe-983-genroutes-linux.mjs
  // from a tools/probe-983-sweep.mjs run inside the same container CI uses.
  // 9 fonts cover 326/330 blocks; keys are namespaced `u-...` so they can't
  // collide with a hand-coded key here. Coverage is dominated by Unifont /
  // Unifont Upper — Chrome's "last resort" pixel-art glyphs for codepoints
  // no covering font has — because the bare image ships a minimal font set.
  ...UNICODE_FONT_PATHS_LINUX,
  // DM-1404: per-block routes for the desktop-Linux Noto profile, keys
  // namespaced `un-...` (vs the bare `u-...`) so the two never collide. Their
  // absolute paths only exist on a Noto host, so they no-op on the bare image
  // (resolveLinuxSpec checks existence). Emitted by `linuxNotoFallbackChain`
  // when `linuxFontProfile() === "noto"`.
  ...UNICODE_FONT_PATHS_NOTO_LINUX,
};

// DM-1404: desktop-Linux **Noto profile** primary-key overlay. The bare
// LINUX_FONT_PATHS above is calibrated to the Playwright `*-noble` image
// (Liberation sans/serif + WenQuanYi mono/CJK). A mainstream desktop-Linux host
// with the Noto family installed resolves the generic primaries to Noto instead
// — verified in the calibration env (tools/calibrate-linux-noto-profile.sh):
// `fc-match sans-serif/serif/monospace` → Noto Sans / Noto Serif / Noto Mono,
// and untagged CJK → NotoSansCJK (jp member). `resolveLinuxSpec` consults this
// overlay FIRST when `linuxFontProfile() === "noto"`; only keys that DIFFER from
// the bare table need entries. Per-block fallback for everything else flows
// through `UNICODE_FONT_PATHS_NOTO_LINUX` (the generated `un-...` table).
export const LINUX_FONT_PATHS_NOTO: Record<string, LinuxFontPath> = (() => {
  const sans = (s: string): LinuxFontPath => ({ path: `${NOTO}/NotoSans-${s}.ttf` });
  const serif = (s: string): LinuxFontPath => ({ path: `${NOTO}/NotoSerif-${s}.ttf` });
  const mono: LinuxFontPath = { path: `${NOTO}/NotoMono-Regular.ttf` }; // fontconfig `monospace` pick; single weight
  const cjk: LinuxFontPath = { path: `${NOTO_CJK}/NotoSansCJK-Regular.ttc`, postscriptName: "NotoSansCJKjp-Regular" };
  const cjkBold: LinuxFontPath = { path: `${NOTO_CJK}/NotoSansCJK-Bold.ttc`, postscriptName: "NotoSansCJKjp-Bold" };
  const cjkSerif: LinuxFontPath = {
    path: `${NOTO_CJK}/NotoSerifCJK-Regular.ttc`,
    postscriptName: "NotoSerifCJKjp-Regular",
  };
  const t: Record<string, LinuxFontPath> = {};
  // sans-serif primaries → Noto Sans (Regular/Bold/Italic/BoldItalic).
  for (const k of ["sf-pro", "helvetica", "arial", "lucida-grande"]) {
    t[k] = sans("Regular");
    t[`${k}-bold`] = sans("Bold");
    t[`${k}-italic`] = sans("Italic");
    t[`${k}-bold-italic`] = sans("BoldItalic");
  }
  t["sf-pro-italic"] = sans("Italic");
  // serif primaries → Noto Serif.
  for (const k of ["times", "times-new-roman", "georgia"]) {
    t[k] = serif("Regular");
    t[`${k}-bold`] = serif("Bold");
    t[`${k}-italic`] = serif("Italic");
    t[`${k}-bold-italic`] = serif("BoldItalic");
  }
  // monospace primaries → Noto Mono (single weight — no italic/bold faces, like
  // the bare profile's WenQuanYi Mono collapse).
  for (const k of ["courier", "courier-new", "menlo", "monaco", "sf-mono"]) {
    t[k] = mono;
    t[`${k}-bold`] = mono;
    t[`${k}-italic`] = mono;
    t[`${k}-bold-italic`] = mono;
  }
  // CJK logical keys (used when CSS names a CJK family directly, e.g. PingFang
  // SC → `cjk`, Hiragino → `hiragino-jp`, Apple SD Gothic → `korean`).
  for (const k of ["cjk", "korean", "hiragino-jp", "hiragino-gb", "hiragino-sans"]) t[k] = cjk;
  t["cjk-bold"] = cjkBold;
  t["cjk-serif"] = cjkSerif;
  // FreeFont logical keys (bare profile's symbol/letterlike/math routes) → Noto Sans/Serif.
  t["free-sans"] = sans("Regular");
  t["free-serif"] = serif("Regular");
  return t;
})();

// DM-1404: which Linux font profile is active — the bare Playwright-image set
// or a mainstream desktop Noto install. Detection follows fontconfig's ACTUAL
// pick for a Han codepoint (U+4E00): that is exactly what Chromium-on-this-host
// paints (both go through fontconfig), so the static routing matches Chromium by
// construction. Noto desktop → NotoSansCJK; bare image → WenQuanYi → "bare".
// `DOMOTION_LINUX_FONT_PROFILE=noto|bare` forces it (CI baseline agreement / tests).
// Memoized; `__resetLinuxFontProfileForTest()` clears it.
let _linuxFontProfile: "noto" | "bare" | null = null;

export function linuxFontProfile(): "noto" | "bare" {
  if (_linuxFontProfile != null) return _linuxFontProfile;
  const forced = process.env.DOMOTION_LINUX_FONT_PROFILE;
  if (forced === "noto" || forced === "bare") return (_linuxFontProfile = forced);
  const m = fcMatch("sans-serif:charset=4e00");
  return (_linuxFontProfile = m != null && /noto/i.test(m.path) ? "noto" : "bare");
}

/** Test-only: clear the memoized Linux font profile (DM-1404). */
export function __resetLinuxFontProfileForTest(): void {
  _linuxFontProfile = null;
}

/** Test-only: read the detected Linux font profile (DM-1404). */
export function __linuxFontProfileForTest(): "noto" | "bare" {
  return linuxFontProfile();
}

// Windows system fonts live in %WINDIR%\Fonts (almost always C:\Windows\Fonts).
// Paths are stable across Windows 10/11, so unlike Linux we hardcode filenames
// and check existence rather than shelling out. Generic mappings follow
// Chromium-on-Windows defaults (sans → Arial, serif → Times New Roman, mono →
// Courier New); CJK / symbol / math / Indic route to the DirectWrite system
// faces. Exact per-block calibration is DM-260.
