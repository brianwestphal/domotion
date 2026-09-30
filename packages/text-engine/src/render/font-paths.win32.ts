/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveInstalledFont } from "./glyph-helper.js";
import { UNICODE_FONT_FILES_WIN32 } from "./unicode-font-routing.win32.generated.js";
import type { FontPath } from "./font-paths.darwin.js";
import { linuxFontProfile } from "./font-paths.linux.js";
import { LINUX_FONT_PATHS_NOTO } from "./font-paths.linux.js";
import { LINUX_FONT_PATHS } from "./font-paths.linux.js";
import type { DarwinHandleAxis } from "./font-instance.js";

const WINDOWS_FONTS_DIR = `${process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows"}\\Fonts`;

export function win(file: string, postscriptName?: string): FontPath {
  return { path: `${WINDOWS_FONTS_DIR}\\${file}`, postscriptName };
}

export const WIN32_FONT_PATHS: Record<string, FontPath> = {
  "sf-pro": win("segoeui.ttf"),
  "sf-pro-italic": win("segoeuii.ttf"),
  "sf-mono": win("consola.ttf"),
  "sf-mono-italic": win("consolai.ttf"),
  helvetica: win("arial.ttf"),
  "helvetica-bold": win("arialbd.ttf"),
  "helvetica-italic": win("ariali.ttf"),
  "helvetica-bold-italic": win("arialbi.ttf"),
  arial: win("arial.ttf"),
  "arial-bold": win("arialbd.ttf"),
  "arial-italic": win("ariali.ttf"),
  "arial-bold-italic": win("arialbi.ttf"),
  courier: win("cour.ttf"),
  "courier-bold": win("courbd.ttf"),
  "courier-italic": win("couri.ttf"),
  "courier-bold-italic": win("courbi.ttf"),
  // Courier New IS cour.ttf — on Windows the plain-Courier key already points
  // at it (Blink rewrites Courier → Courier New up front there:
  // `AdjustFamilyNameToAvoidUnsupportedFonts`, `alternate_font_family.h:45-52`,
  // rev 7d859f27), so the dedicated key shares the same files.
  "courier-new": win("cour.ttf"),
  "courier-new-bold": win("courbd.ttf"),
  "courier-new-italic": win("couri.ttf"),
  "courier-new-bold-italic": win("courbi.ttf"),
  menlo: win("consola.ttf"),
  "menlo-bold": win("consolab.ttf"),
  "menlo-italic": win("consolai.ttf"),
  "menlo-bold-italic": win("consolaz.ttf"),
  monaco: win("consola.ttf"),
  times: win("times.ttf"),
  "times-bold": win("timesbd.ttf"),
  "times-italic": win("timesi.ttf"),
  "times-bold-italic": win("timesbi.ttf"),
  "times-new-roman": win("times.ttf"),
  "times-new-roman-bold": win("timesbd.ttf"),
  "times-new-roman-italic": win("timesi.ttf"),
  "times-new-roman-bold-italic": win("timesbi.ttf"),
  georgia: win("georgia.ttf"),
  "georgia-bold": win("georgiab.ttf"),
  "georgia-italic": win("georgiai.ttf"),
  "georgia-bold-italic": win("georgiaz.ttf"),
  // CJK: Yu Gothic (ja), Microsoft YaHei (zh), Malgun Gothic (ko). The macOS
  // PingFang/Hiragino logical keys map to the closest DirectWrite face.
  cjk: win("msyh.ttc", "MicrosoftYaHei"),
  "cjk-bold": win("msyhbd.ttc", "MicrosoftYaHei-Bold"),
  "cjk-serif": win("simsun.ttc", "SimSun"),
  "cjk-serif-bold": win("simsun.ttc", "SimSun"),
  // DM-1117: no Hiragino Mincho on Windows — route the explicit-name request to
  // SimSun (the serif CJK DirectWrite face). SimSun ships `trad`, but the
  // Windows chain isn't calibrated yet; the glyph resolves regardless.
  "hiragino-mincho": win("simsun.ttc", "SimSun"),
  "hiragino-mincho-bold": win("simsun.ttc", "SimSun"),
  "pingfang-sc": win("msyh.ttc", "MicrosoftYaHei"),
  "pingfang-sc-bold": win("msyhbd.ttc", "MicrosoftYaHei-Bold"),
  "pingfang-tc": win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-tc-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "pingfang-hk": win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-hk-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "pingfang-mo": win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-mo-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "hiragino-jp": win("YuGothR.ttc", "YuGothic-Regular"),
  "hiragino-jp-bold": win("YuGothB.ttc", "YuGothic-Bold"),
  korean: win("malgun.ttf", "MalgunGothic"),
  "korean-bold": win("malgunbd.ttf", "MalgunGothicBold"),
  // DM-987: the Leelawadee UI Semilight file is `leeluisl.ttf` (PostScript
  // `LeelawadeeUI-Semilight`) — the previous `LeelaUIsl.ttf` / hyphen-less PS
  // name didn't exist on disk, so this key resolved to null. Verified against
  // C:\Windows\Fonts on a Windows 11 host.
  thai: win("leeluisl.ttf", "LeelawadeeUI-Semilight"),
  // Tahoma is what Chromium-on-Windows actually falls back to for Thai under a
  // sans-serif request (painted-font probe, DM-836), so the Thai fallback chain
  // prefers it over Leelawadee UI.
  tahoma: win("tahoma.ttf"),
  // DM-987: Nirmala UI ships as the collection `Nirmala.ttc` (members Nirmala
  // UI / Nirmala Text), NOT `Nirmala.ttf` — the old filename failed existsSync
  // so Devanagari (and all Indic via this key) silently fell through on Windows.
  devanagari: win("Nirmala.ttc", "NirmalaUI"),
  "sf-arabic": win("segoeui.ttf"),
  "sf-hebrew": win("segoeui.ttf"),
  // Segoe UI Symbol covers Geometric Shapes, Misc Symbols, Dingbats, Arrows.
  symbols: win("seguisym.ttf"),
  "zapf-dingbats": win("seguisym.ttf"),
  "lucida-grande": win("arial.ttf"),
  // Cambria Math is the DirectWrite math-coverage font (Math Alpha block).
  "stix-math": win("cambria.ttc", "CambriaMath"),
  // Windows cursive/fantasy generics historically resolve to Comic Sans MS /
  // Impact in Chromium; mirror that for path discovery.
  snell: win("comic.ttf"),
  "apple-chancery": win("comic.ttf"),
  papyrus: win("impact.ttf"),
  // DM-987: per-Unicode-block routes derived from a Chrome CDP
  // `CSS.getPlatformFontsForNode` sweep on a Windows 11 host (DirectWrite).
  // Generated by tools/probe-983-genroutes-win32.mjs from
  // tests/output/unicode-fonts.win32.json. 34 fonts cover 326 blocks; keys are
  // namespaced `u-...` so they can't collide with a hand-coded key above. The
  // generated entries carry bare filenames, prefixed here via `win()` so they
  // honor %WINDIR%. Coverage is dominated by Segoe UI Historic (ancient
  // scripts), SimSun-ExtB/-ExtG (rare CJK ideographs), Sans Serif Collection,
  // and the per-script UI faces (Ebrima / Gadugi / Yi Baiti / Myanmar / …).
  ...Object.fromEntries(
    Object.entries(UNICODE_FONT_FILES_WIN32).map(([key, e]) => [key, win(e.file, e.postscriptName)]),
  ),
};

// Resolved-path cache, keyed by logical font key. Holds the platform-specific
// FontPath (or null when the key has no mapping / file on this host). The
// fc-match shell-out on Linux is the main thing this avoids repeating.
export const resolvedSpecCache = new Map<string, FontPath | null>();

// `fc-match` is a synchronous process boundary and the same exact fontconfig
// pattern is reached through multiple logical font keys and render passes. Its
// answer is a pure function of the pattern for the lifetime of one font
// environment, so retain successes and misses alike until the normal font-
// resolution cache boundary clears them.
export const fcMatchCache = new Map<string, { path: string; postscriptName?: string } | null>();

/**
 * Run `fc-match` for a fontconfig pattern and return the resolved file plus
 * its postscript name (for picking the right TTC member). Returns null when
 * fc-match is missing, errors, or resolves to a file that doesn't exist.
 * Only ever called on Linux.
 */
export function fcMatch(pattern: string): { path: string; postscriptName?: string } | null {
  const cached = fcMatchCache.get(pattern);
  if (cached !== undefined) return cached;

  let result: { path: string; postscriptName?: string } | null = null;
  try {
    const out = execFileSync("fc-match", ["-f", "%{file}\t%{postscriptname}", pattern], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out !== "") {
      const [file, postscriptName] = out.split("\t");
      if (file != null && file !== "" && existsSync(file)) {
        result = { path: file, postscriptName: postscriptName || undefined };
      }
    }
  } catch {
    // A missing/timed-out fontconfig executable is a stable miss for this
    // process environment, just like an empty or unusable answer.
  }
  fcMatchCache.set(pattern, result);
  return result;
}

export function resolveLinuxSpec(key: string): FontPath | null {
  // DM-1404: on a desktop Noto host, the primary-key overlay wins for the keys
  // that differ from the bare image (sans/serif/mono primaries + CJK). Only when
  // the overlay's on-disk file actually exists; otherwise fall through so a host
  // with a partial Noto install still resolves via the bare table / fc-match.
  if (linuxFontProfile() === "noto") {
    const noto = LINUX_FONT_PATHS_NOTO[key];
    if (noto != null && noto.path != null && existsSync(noto.path)) {
      return { path: noto.path, postscriptName: noto.postscriptName, extractor: noto.extractor };
    }
  }
  const entry = LINUX_FONT_PATHS[key];
  if (entry == null) return null;
  // Canonical path first when it exists, then fontconfig discovery (entries
  // generated from the per-block sweep — DM-984 — have no `fcMatch` because
  // their absolute path is the answer; only the hand-coded entries carry one).
  if (entry.path != null && existsSync(entry.path)) {
    return { path: entry.path, postscriptName: entry.postscriptName, extractor: entry.extractor };
  }
  if (entry.fcMatch == null) return null;
  const matched = fcMatch(entry.fcMatch);
  if (matched == null) return null;
  return {
    path: matched.path,
    postscriptName: entry.postscriptName ?? matched.postscriptName,
    extractor: entry.extractor,
  };
}

export function resolveWin32Spec(key: string): FontPath | null {
  const spec = WIN32_FONT_PATHS[key];
  if (spec == null || !existsSync(spec.path)) return null;
  return spec;
}

/**
 * Resolve a logical font key to a concrete on-disk spec for the current
 * platform (DM-258). On macOS this is the unchanged `FONT_PATHS[key]` lookup —
 * file existence is still handled downstream by `fontkit.openSync` / the
 * glyph helper, preserving the family-chain fall-through for fonts that
 * aren't installed (e.g. Source Serif Pro). On Linux / Windows it consults
 * the per-platform tables above, verifying the file exists (and using
 * `fc-match` discovery on Linux). Results are cached per key.
 */
// DM-1018: dynamic font specs registered at runtime by the CoreText system-
// fallback resolver (`resolveSystemFallbackKeyForCp`). Keyed `sysfb:<psName>`.
// These point at on-disk fonts CTFontCreateForString picked that aren't in the
// static FONT_PATHS table (e.g. Mplus 1p for Kana Supplement). Checked by
// resolveFontSpec before the platform tables so the dynamic key resolves.
export const dynamicSystemFontPaths = new Map<string, FontPath>();

/** DM-1018: register a CoreText-resolved on-disk font under a `sysfb:<psName>`
 *  key so getFontInstance / resolveFontSpec can open it. `extractor: native`
 *  routes through the CoreText helper (handles hvgl / GSUB-crashing faces and
 *  the `.notdef` extraction), and the path lets the helper open the exact file
 *  CoreText chose. No-op if already registered. */
export function registerDynamicSystemFont(
  key: string,
  path: string,
  postscriptName: string,
  extractor: "fontkit" | "native" = "native",
  resolvedAxes?: Record<string, number>,
  ctAxes?: DarwinHandleAxis[],
  /** DM-2017: fontconfig's own bold/italic classification of this face, from
   *  the Linux `fcfallback` live resolver only — see
   *  `FontPath.linuxFallbackIsBold` / `linuxFallbackIsItalic`. */
  linuxFallbackIsBold?: boolean,
  linuxFallbackIsItalic?: boolean,
  faceIndex?: number,
): void {
  if (dynamicSystemFontPaths.has(key)) return;
  dynamicSystemFontPaths.set(key, {
    path,
    postscriptName,
    extractor,
    resolvedAxes,
    ctAxes,
    linuxFallbackIsBold,
    linuxFallbackIsItalic,
    faceIndex,
  });
  resolvedSpecCache.delete(key); // in case a prior null was cached
}

/**
 * Relocate a table entry whose declared file is not on this host.
 *
 * The path tables hardcode where a system font lived when the entry was
 * written, and the OS moves them: on current macOS all eight PingFang keys
 * declare `/System/Library/Fonts/PingFang.ttc`, which no longer exists — the
 * faces now ship inside `FontServices.framework/…/Reserved/PingFangUI.ttc`.
 * Nothing looked broken because those entries are `extractor: "native"`, so the
 * helper opens them by PostScript name through CoreText and the declared path
 * is never dereferenced on the happy path. But `resolveFontSpec(key).path` is
 * read directly elsewhere — the embedded-subset builder reads those bytes, and
 * mistaking the base entry for the rendered face was the conformance oracle's
 * own instrument bug — so a path that cannot be opened is a live hazard, not
 * cosmetic.
 *
 * Rather than swap one machine's literal for another's, ask the OS: when the
 * declared file is absent and we know the PostScript name, take the path
 * CoreText reports for that face. Self-healing across OS relocations, and it
 * keeps the table honest about what it actually points at.
 *
 * No-op where it cannot help: platforms without the native helper get `null`
 * from `resolveInstalledFont` and keep the declared entry unchanged, which is
 * exactly the previous behavior.
 */
export function relocateMissingSpec(spec: FontPath | null): FontPath | null {
  if (spec?.path == null || spec.path === "" || spec.postscriptName == null) return spec;
  if (existsSync(spec.path)) return spec;
  const installed = resolveInstalledFont(spec.postscriptName);
  if (installed?.path == null || !existsSync(installed.path)) return spec;
  return { ...spec, path: installed.path };
}
