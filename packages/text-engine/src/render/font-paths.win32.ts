/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { existsSync } from "node:fs";
import { UNICODE_FONT_FILES_WIN32 } from "./unicode-font-routing.win32.generated.js";
import type { FontPath } from "./font-paths.darwin.js";

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

export function resolveWin32Spec(key: string): FontPath | null {
  const spec = WIN32_FONT_PATHS[key];
  if (spec == null || !existsSync(spec.path)) return null;
  return spec;
}
