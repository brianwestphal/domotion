// Generate src/render/unicode-font-routing.win32.generated.ts from the
// tests/output/unicode-fonts.win32.json sweep produced by
// `tools/probe-983-sweep.mjs` run on a real Windows host (DirectWrite font
// fallback). For each Unicode block (filename-derived codepoint range), pick
// the font family Chrome chose first on Windows, then resolve that family to a
// C:\Windows\Fonts filename + (for collections) the TTC member's PostScript
// name.
//
// How the JSON was produced (DM-987): the sweep ran under Node + Playwright
// Chromium on a Windows 11 VM, driving `CSS.getPlatformFontsForNode` over the
// 818 per-Unicode-block fixtures (`../html-test/unicode/*.html`). The font
// family names below are exactly what DirectWrite reports through CDP; the
// filenames + PostScript names were read off `C:\Windows\Fonts` and the
// `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` registry on that
// host. Windows 11 ships these faces in fixed locations across editions, so
// the filenames are stable.
//
// Run from the repo root on any host (the Windows paths are emitted as bare
// FILENAMES — `src/render/text-to-path.ts` prefixes them with
// `%WINDIR%\Fonts` via its `win()` helper, so they resolve on a real Windows
// box and stay inert on macOS/Linux):
//
//   node tools/probe-983-genroutes-win32.mjs
//
// Unlike the Linux generator there is no fontconfig discovery fallback — the
// emitted entries carry the exact filename, and `resolveWin32Spec` simply
// checks the file exists.

import { readFileSync, writeFileSync } from "node:fs";

// DirectWrite family name (as reported by `CSS.getPlatformFontsForNode`) →
// { file, postscriptName? }. `file` is the bare name under %WINDIR%\Fonts;
// `postscriptName` selects the member for `.ttc` collections (so fontkit opens
// the right face, not just the first one). Verified on the Windows 11 VM:
// every file below exists in `C:\Windows\Fonts`, and the TTC member names came
// from `fontkit.openSync(...).fonts[*].postscriptName`.
const FAMILY_TO_FILE = {
  // Core Latin / serif / mono / CJK already covered by the hand-coded
  // win32FallbackChain rules, but included so the generated table self-resolves
  // for any block whose hand-coded route happens not to match.
  "Arial":                 { file: "arial.ttf" },
  "Times New Roman":       { file: "times.ttf" },
  "Calibri":               { file: "calibri.ttf" },
  "Tahoma":                { file: "tahoma.ttf" },
  "Segoe UI":              { file: "segoeui.ttf" },
  "Microsoft Sans Serif":  { file: "micross.ttf" },
  "Lucida Sans Unicode":   { file: "l_10646.ttf" },
  // Windows 11's broad variable "last resort" sans — carries the bulk of the
  // symbol / pictograph / less-common-script coverage Chrome falls through to.
  "Sans Serif Collection": { file: "SansSerifCollection.ttf" },
  // CJK collections (the right TTC member matters).
  "Microsoft YaHei":       { file: "msyh.ttc", postscriptName: "MicrosoftYaHei" },
  "SimSun":                { file: "simsun.ttc", postscriptName: "SimSun" },
  // SimSun-ExtB / -ExtG are SEPARATE single-face files (CJK Ext B/C/D/… and
  // the Ext G plane) — the bulk of the rare-ideograph coverage above U+20000.
  "SimSun-ExtB":           { file: "simsunb.ttf" },
  "SimSun-ExtG":           { file: "SimsunExtG.ttf" },
  "Yu Gothic":             { file: "YuGothR.ttc", postscriptName: "YuGothic-Regular" },
  "Yu Gothic UI":          { file: "YuGothR.ttc", postscriptName: "YuGothicUI-Semilight" },
  "MS PGothic":            { file: "msgothic.ttc", postscriptName: "MS-PGothic" },
  "Microsoft JhengHei UI": { file: "msjh.ttc", postscriptName: "MicrosoftJhengHeiUIRegular" },
  "Malgun Gothic":         { file: "malgun.ttf", postscriptName: "MalgunGothic" },
  // Script-specific UI / fallback faces (all single-face .ttf).
  "Nirmala UI":            { file: "Nirmala.ttc", postscriptName: "NirmalaUI" },
  "Leelawadee UI":         { file: "leelawui.ttf" },
  "Segoe UI Symbol":       { file: "seguisym.ttf" },
  // Segoe UI Historic carries the ancient / historic scripts (Old Italic,
  // Gothic, Cuneiform, Egyptian Hieroglyphs, Phoenician, Cypriot, …).
  "Segoe UI Historic":     { file: "seguihis.ttf" },
  "Ebrima":                { file: "ebrima.ttf" },      // Ethiopic, N'Ko, Vai, Osmanya, Tifinagh
  "Gadugi":                { file: "gadugi.ttf" },      // Cherokee, Canadian Aboriginal, Osage
  "Microsoft Yi Baiti":    { file: "msyi.ttf" },        // Yi
  "Myanmar Text":          { file: "mmrtext.ttf" },     // Myanmar
  "Javanese Text":         { file: "javatext.ttf" },    // Javanese
  "Microsoft Himalaya":    { file: "himalaya.ttf" },    // Tibetan
  "Mongolian Baiti":       { file: "monbaiti.ttf" },    // Mongolian
  "Microsoft Tai Le":      { file: "taile.ttf" },        // Tai Le
  "Microsoft New Tai Lue": { file: "ntailu.ttf" },       // New Tai Lue
  "Microsoft PhagsPa":     { file: "phagspa.ttf" },      // Phags-pa
  "MV Boli":               { file: "mvboli.ttf" },       // Thaana
  "Sylfaen":               { file: "sylfaen.ttf" },      // Georgian, Armenian
  "Cambria Math":          { file: "cambria.ttc", postscriptName: "CambriaMath" }, // Math Alphanumeric
  // Color emoji is handled via the raster <image> path (doc 15), not a
  // glyph-path key — skip routing so we don't emit a monochrome face for it.
  "Segoe UI Emoji":        null,
};

// Some blocks report a family under a non-ASCII or alternate name. Normalize
// to the canonical FAMILY_TO_FILE key so they dedup to one routing entry —
// e.g. Chrome reports Microsoft JhengHei by its Chinese name 微軟正黑體 for a
// few blocks; it's the same `msjh.ttc` collection.
const FAMILY_ALIAS = {
  "微軟正黑體": "Microsoft JhengHei UI",
};

const data = JSON.parse(readFileSync("tests/output/unicode-fonts.win32.json", "utf-8"));
const blockToFamilies = data.blockToFamilies;

const ranges = []; // { start, end, family, blockName, fontKey, resolved }
const familyToKey = new Map();
const unresolved = new Set();
const seenRange = new Set(); // dedup [start,end] (some blocks are split across .0/.1 fixtures)

function makeKey(family) {
  if (familyToKey.has(family)) return familyToKey.get(family);
  // Lowercase, dash-separated, prefixed "u-" so it can't clash with a
  // hand-coded key in WIN32_FONT_PATHS.
  const slug = "u-" + family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  familyToKey.set(family, slug);
  return slug;
}

for (const [blockName, families] of Object.entries(blockToFamilies)) {
  const m = /^([0-9A-F]+)-([0-9A-F]+)/.exec(blockName);
  if (m == null) continue;
  const start = parseInt(m[1], 16);
  const end = parseInt(m[2], 16);
  const rangeId = `${start}-${end}`;
  if (seenRange.has(rangeId)) continue; // first fixture for a split block wins
  let primary = families[0];
  if (primary == null) continue;
  primary = FAMILY_ALIAS[primary] ?? primary;
  if (!(primary in FAMILY_TO_FILE)) { unresolved.add(primary); continue; }
  const resolved = FAMILY_TO_FILE[primary];
  if (resolved == null) continue; // intentionally skipped (e.g. color emoji)
  seenRange.add(rangeId);
  ranges.push({ start, end, family: primary, blockName, fontKey: makeKey(primary), resolved });
}

ranges.sort((a, b) => a.start - b.start);

let out = "// AUTO-GENERATED by tools/probe-983-genroutes-win32.mjs — do not edit by hand.\n";
out += "// Source data: tests/output/unicode-fonts.win32.json (produced by\n";
out += "// tools/probe-983-sweep.mjs on a Windows 11 host — see DM-987).\n";
out += "// Maps Unicode blocks to the Windows font family Chrome's DirectWrite\n";
out += "// fallback picks via CDP `CSS.getPlatformFontsForNode`. Consulted by\n";
out += "// `win32FallbackChain` as the final fallback when no hand-coded route\n";
out += "// matches a codepoint. `file` is a bare name under %WINDIR%\\Fonts —\n";
out += "// `src/render/text-to-path.ts` prefixes it via its `win()` helper, so\n";
out += "// these entries honor a non-default WINDIR and stay inert off-Windows.\n";
out += "\n";
out += "export interface Win32UnicodeFontEntry { file: string; postscriptName?: string }\n\n";
out += "export const UNICODE_FONT_FILES_WIN32: Record<string, Win32UnicodeFontEntry> = {\n";
const seenKeys = new Set();
for (const r of ranges) {
  if (seenKeys.has(r.fontKey)) continue;
  seenKeys.add(r.fontKey);
  const psn = r.resolved.postscriptName != null ? `, postscriptName: ${JSON.stringify(r.resolved.postscriptName)}` : "";
  out += `  ${JSON.stringify(r.fontKey)}: { file: ${JSON.stringify(r.resolved.file)}${psn} },\n`;
}
out += "};\n\n";
out += "/** [start, end, fontKey] tuples sorted by start. Probed by binary-searching for the matching range. */\n";
out += "export const UNICODE_FONT_RANGES_WIN32: ReadonlyArray<readonly [number, number, string]> = [\n";
for (const r of ranges) {
  out += `  [0x${r.start.toString(16).toUpperCase()}, 0x${r.end.toString(16).toUpperCase()}, ${JSON.stringify(r.fontKey)}], // ${r.blockName} (${r.family})\n`;
}
out += "];\n";

writeFileSync("src/render/unicode-font-routing.win32.generated.ts", out);

console.log(`Generated ${ranges.length} ranges covering ${seenKeys.size} fonts.`);
if (unresolved.size > 0) {
  console.log(`Unresolved font families (skipped — add a FAMILY_TO_FILE entry to route these):`);
  for (const f of unresolved) console.log(`  - ${JSON.stringify(f)}`);
}
