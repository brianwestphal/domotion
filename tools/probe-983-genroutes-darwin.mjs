// Generate src/render/unicode-font-routing.darwin.generated.ts from the
// /tmp/unicode-fonts.darwin.json sweep. For each unicode block (filename-derived
// codepoint range), pick the font family Chrome chose first, then resolve
// that family to an on-disk file path.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SUPPLEMENTAL = "/System/Library/Fonts/Supplemental";
const SYSTEM_FONTS = "/System/Library/Fonts";

// Manual overrides for family names that don't follow the standard
// "NotoSansFooBar-Regular.ttf" pattern, or for non-Noto fonts where the
// path / postscriptName is known.
const FAMILY_TO_PATH = {
  "Arial Unicode MS":     { path: `${SUPPLEMENTAL}/Arial Unicode.ttf` },
  "Apple Symbols":        { path: `${SYSTEM_FONTS}/Apple Symbols.ttf` },
  "SF Pro Text":          { path: `${SYSTEM_FONTS}/SFNS.ttf` },
  "SF Pro":               { path: `${SYSTEM_FONTS}/SFNS.ttf` },
  "Helvetica Neue":       { path: `${SYSTEM_FONTS}/Helvetica.ttc`, postscriptName: "Helvetica" },
  "Helvetica":            { path: `${SYSTEM_FONTS}/Helvetica.ttc`, postscriptName: "Helvetica" },
  "Hiragino Sans GB":     { path: `${SYSTEM_FONTS}/Hiragino Sans GB.ttc`, postscriptName: "HiraginoSansGB-W3" },
  "Hiragino Sans":        { path: `${SYSTEM_FONTS}/ヒラギノ角ゴシック W3.ttc`, postscriptName: "HiraKakuProN-W3" },
  "Hiragino Kaku Gothic ProN": { path: `${SYSTEM_FONTS}/ヒラギノ角ゴシック W3.ttc`, postscriptName: "HiraKakuProN-W3" },
  "Apple Color Emoji":    null, // handled via raster path, not text path
  "Noto Sans KR":         { path: `/Library/Fonts/NotoSansKR-Regular.otf` },
  "Apple SD Gothic Neo":  { path: `${SYSTEM_FONTS}/AppleSDGothicNeo.ttc`, postscriptName: "AppleSDGothicNeo-Regular" },
  "Geeza Pro":            { path: `${SYSTEM_FONTS}/GeezaPro.ttc`, postscriptName: "GeezaPro" },
  "Kefa III":             { path: `${SUPPLEMENTAL}/KefaIII.ttf` },
  "Arial":                { path: `${SUPPLEMENTAL}/Arial.ttf` },
  "Mshtakan":             { path: `${SUPPLEMENTAL}/Mshtakan.ttc`, postscriptName: "Mshtakan" },
  "STIX Two Math":        { path: `${SUPPLEMENTAL}/STIXTwoMath.otf` },
  "Big Caslon":           { path: `${SUPPLEMENTAL}/BigCaslon.ttf` },
  "Euphemia UCAS":        { path: `${SUPPLEMENTAL}/EuphemiaCAS.ttc`, postscriptName: "EuphemiaUCAS" },
  "Heiti SC":             { path: `${SYSTEM_FONTS}/STHeiti Light.ttc`, postscriptName: "STHeitiSC-Light" },
  "Plantagenet Cherokee": { path: `${SUPPLEMENTAL}/PlantagenetCherokee.ttf` },
  "Galvji":               { path: `${SUPPLEMENTAL}/Galvji.ttc`, postscriptName: "Galvji" },
  "Mukta Mahee Regular":  { path: `${SYSTEM_FONTS}/MuktaMahee.ttc`, postscriptName: "MuktaMahee-Regular" },
  "MuktaMahee Regular":   { path: `${SYSTEM_FONTS}/MuktaMahee.ttc`, postscriptName: "MuktaMahee-Regular" },
  "ITF Devanagari":       { path: `${SUPPLEMENTAL}/DevanagariMT.ttc`, postscriptName: "DevanagariMT" },
  "Kohinoor Bangla":      { path: `${SYSTEM_FONTS}/KohinoorBangla.ttc`, postscriptName: "KohinoorBangla-Regular" },
  "Kohinoor Gujarati":    { path: `${SYSTEM_FONTS}/KohinoorGujarati.ttc`, postscriptName: "KohinoorGujarati-Regular" },
  "Kohinoor Telugu":      { path: `${SYSTEM_FONTS}/KohinoorTelugu.ttc`, postscriptName: "KohinoorTelugu-Regular" },
  "Gurmukhi Sangam MN":   { path: `${SUPPLEMENTAL}/Gurmukhi Sangam MN.ttc`, postscriptName: "GurmukhiSangamMN" },
  "Oriya Sangam MN":      { path: `${SUPPLEMENTAL}/Oriya Sangam MN.ttc`, postscriptName: "OriyaSangamMN" },
  "Tamil Sangam MN":      { path: `${SUPPLEMENTAL}/Tamil Sangam MN.ttc`, postscriptName: "TamilSangamMN" },
  "Kannada Sangam MN":    { path: `${SUPPLEMENTAL}/Kannada Sangam MN.ttc`, postscriptName: "KannadaSangamMN" },
  "Sinhala Sangam MN":    { path: `${SUPPLEMENTAL}/Sinhala Sangam MN.ttc`, postscriptName: "SinhalaSangamMN" },
  "Khmer Sangam MN":      { path: `${SUPPLEMENTAL}/Khmer Sangam MN.ttf` },
  "Lao Sangam MN":        { path: `${SUPPLEMENTAL}/Lao Sangam MN.ttf` },
  // DM-983: Grantha lives INSIDE the Tamil Sangam MN .ttc collection as
  // the `GranthaSangamMN-Regular` sub-font — there's no standalone
  // Grantha font file on macOS. The cmap is shared across the .ttc's
  // four sub-fonts but the glyph outlines differ: opening the .ttc and
  // picking the first / Tamil sub-font returns tofu for U+11300+ because
  // their glyph slot points at .notdef in that sub-font. The
  // GranthaSangamMN-Regular sub-font has the real Grantha outlines.
  // The Grantha Sangam MN sub-font inside Tamil Sangam MN.ttc trips a
  // "Not a fixed size" exception in fontkit's `restructure` parser when
  // we extract just that sub-font (TTC sub-extraction + variation-axis
  // handling don't agree on this specific entry). Forcing the CoreText
  // helper sidesteps fontkit entirely and uses macOS's own rendering of
  // the sub-font, which is what Chrome paints.
  "Grantha Sangam MN":    { path: `${SUPPLEMENTAL}/Tamil Sangam MN.ttc`, postscriptName: "GranthaSangamMN-Regular", extractor: "native" },
  ".SF Malayalam":        { path: `${SUPPLEMENTAL}/Malayalam Sangam MN.ttc`, postscriptName: "MalayalamSangamMN" },
  "Malayalam MN":         { path: `${SUPPLEMENTAL}/Malayalam MN.ttc`, postscriptName: "MalayalamMN" },
  "Malayalam Sangam MN":  { path: `${SUPPLEMENTAL}/Malayalam Sangam MN.ttc`, postscriptName: "MalayalamSangamMN" },
  "Myanmar Sangam MN":    { path: `${SUPPLEMENTAL}/Myanmar Sangam MN.ttc`, postscriptName: "MyanmarSangamMN" },
  "Sukhumvit Set":        { path: `${SUPPLEMENTAL}/SukhumvitSet.ttc`, postscriptName: "SukhumvitSet-Text" },
  "Kailasa":              { path: `${SUPPLEMENTAL}/Kailasa.ttc`, postscriptName: "Kailasa" },
  "SF Arabic":            { path: `${SYSTEM_FONTS}/SFArabic.ttf` },
  "SF Compact":           { path: `${SYSTEM_FONTS}/SFCompact.ttf` },
  "Mplus 1p":             null, // not standard on macOS
  "Inter":                null, // not standard on macOS
  "Dela Gothic One":      null,
  "AppleGothic":          { path: `${SUPPLEMENTAL}/AppleGothic.ttf` },
  "蘋方-簡":              null, // ditto — PingFang already mapped via "cjk"
};

// Map "Noto Sans Foo" → "NotoSansFoo-Regular.ttf" by stripping spaces.
// Manual remaps for names Chrome reports truncated.
const NOTO_NAME_REMAP = {
  "Noto Sans OldSouArab": "OldSouthArabian",
  "Noto Sans OldNorArab": "OldNorthArabian",
  "Noto Sans InsParthi":  "InscriptionalParthian",
  "Noto Sans InsPahlavi": "InscriptionalPahlavi",
  "Noto Sans PsaPahlavi": "PsalterPahlavi",
  "Noto Sans Old Turkic": "OldTurkic",
  "Noto Sans OldHung":    "OldHungarian",
  "Noto Sans HanifiRohg": "HanifiRohingya",
  "Noto Sans SoraSomp":   "SoraSompeng",
  "Noto Sans WarangCiti": "WarangCiti",
  "Noto Sans PauCinHau":  "PauCinHau",
  "Noto Sans EgyptHiero": "EgyptianHieroglyphs",
  "Noto Sans Bassa Vah":  "BassaVah",
  "Noto Sans Pahawh Hmong": "PahawhHmong",
  "Noto Sans Tai Le":     "TaiLe",
  "Noto Sans NewTaiLue":  "NewTaiLue",
  "Noto Sans Tai Tham":   "TaiTham",
  "Noto Sans Tai Viet":   "TaiViet",
  "Noto Sans Ol Chiki":   "OlChiki",
  "Noto Sans Nag Mundari":"NagMundari",
  "Noto Sans Mende Kikakui": "MendeKikakui",
  "Noto Sans Syloti Nagri": "SylotiNagri",
  "Noto Sans PhagsPa":    "PhagsPa",
  "Noto Sans Kayah Li":   "KayahLi",
  "Noto Sans Masaram Gondi": "MasaramGondi",
  "Noto Sans Gunjala Gondi": "GunjalaGondi",
  "Noto Sans NKo":        "NKo",
  "Noto Serif Hmong Nyiakeng": "NyiakengPuachueHmong",
  "Noto Sans Mongolian":  "Mongolian",
  "Noto Sans CaucAlban":  "CaucasianAlbanian",
  "Noto Sans ImpAramaic": "ImperialAramaic",
  "Noto Sans MeeteiMayek": "MeeteiMayek",
  "Noto Sans Old Italic": "OldItalic",
  "Noto Sans OldPersian": "OldPersian",
  "Noto Sans Old Permic": "OldPermic",
  "Noto Sans Linear A":   "LinearA",
  "Noto Sans Linear B":   "LinearB",
  "Noto Serif Yezidi":    "Yezidi",  // sometimes serif
  "Noto Serif Ahom":      "Ahom",
};

function resolveFamily(family) {
  if (family in FAMILY_TO_PATH) return FAMILY_TO_PATH[family];
  // Noto Sans / Noto Serif fallback
  let suffix = NOTO_NAME_REMAP[family];
  if (suffix == null) {
    const m = /^Noto (Sans|Serif) (.+)$/.exec(family);
    if (m != null) suffix = m[2].replace(/\s+/g, "");
  }
  if (suffix != null) {
    for (const variant of ["NotoSans", "NotoSerif"]) {
      for (const dir of [SUPPLEMENTAL, SYSTEM_FONTS, "/Library/Fonts"]) {
        for (const ext of ["ttf", "otf"]) {
          const plain = `${dir}/${variant}${suffix}-Regular.${ext}`;
          if (existsSync(plain)) return { path: plain };
          const ttc = `${dir}/${variant}${suffix}.ttc`;
          if (existsSync(ttc)) return { path: ttc };
        }
      }
    }
  }
  // Plain "Noto Sans" with no script suffix (generic Latin / Greek / Cyrillic
  // extensions). Try the bundled-installed copy.
  if (family === "Noto Sans") {
    for (const path of ["/Library/Fonts/NotoSans-Regular.ttf", `${SUPPLEMENTAL}/NotoSans-Regular.ttf`]) {
      if (existsSync(path)) return { path };
    }
  }
  return null;
}

const data = JSON.parse(readFileSync("/tmp/unicode-fonts.darwin.json", "utf-8"));
const blockToFamilies = data.blockToFamilies;

const ranges = []; // { startHex, endHex, family, blockName, fontKey }
const familyToKey = new Map();
const unresolved = new Set();
let keySerial = 0;

function makeKey(family) {
  if (familyToKey.has(family)) return familyToKey.get(family);
  // Lowercase, dash-separated, prefixed with "u-" to avoid clashing with hand-coded keys.
  const slug = "u-" + family.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  familyToKey.set(family, slug);
  return slug;
}

for (const [blockName, families] of Object.entries(blockToFamilies)) {
  const m = /^([0-9A-F]+)-([0-9A-F]+)/.exec(blockName);
  if (m == null) continue;
  const start = parseInt(m[1], 16);
  const end = parseInt(m[2], 16);
  const primary = families[0];
  if (primary == null) continue;
  const resolved = resolveFamily(primary);
  if (resolved == null) {
    unresolved.add(primary);
    continue;
  }
  ranges.push({ start, end, family: primary, blockName, fontKey: makeKey(primary), resolved });
}

ranges.sort((a, b) => a.start - b.start);

// Build the generated TS source.
const keyToResolved = new Map();
for (const r of ranges) keyToResolved.set(r.fontKey, r.resolved);

let out = "// AUTO-GENERATED by tools/probe-983-genroutes.mjs — do not edit by hand.\n";
out += "// Source data: /tmp/unicode-fonts.darwin.json (produced by tools/probe-983-sweep.mjs).\n";
out += "// Maps Unicode blocks to the macOS font family Chrome's CoreText fallback\n";
out += "// picks via CDP `CSS.getPlatformFontsForNode`. Consulted by\n";
out += "// `darwinFallbackChain` as the final fallback when no hand-coded route\n";
out += "// matches a given codepoint.\n";
out += "\n";
out += "export interface UnicodeFontEntry { path: string; postscriptName?: string }\n\n";
out += "export const UNICODE_FONT_PATHS: Record<string, UnicodeFontEntry> = {\n";
const seenKeys = new Set();
for (const r of ranges) {
  if (seenKeys.has(r.fontKey)) continue;
  seenKeys.add(r.fontKey);
  const psn = r.resolved.postscriptName != null ? `, postscriptName: ${JSON.stringify(r.resolved.postscriptName)}` : "";
  out += `  ${JSON.stringify(r.fontKey)}: { path: ${JSON.stringify(r.resolved.path)}${psn} },\n`;
}
out += "};\n\n";
out += "/** [start, end, fontKey] tuples sorted by start. Probed by binary-searching for the matching range. */\n";
out += "export const UNICODE_FONT_RANGES: ReadonlyArray<readonly [number, number, string]> = [\n";
for (const r of ranges) {
  out += `  [0x${r.start.toString(16).toUpperCase()}, 0x${r.end.toString(16).toUpperCase()}, ${JSON.stringify(r.fontKey)}], // ${r.blockName} (${r.family})\n`;
}
out += "];\n";

// Probe each font in a subprocess — some macOS Sangam MN fonts have GSUB
// tables fontkit can't parse and CRASH the Node process with "invalid
// array length" inside ArrayPrototypeSplice. We can't try/catch that.
// Mark crashers with `extractor: "native"` so the renderer routes them
// through the macOS CoreText glyph-helper instead.
import { spawnSync } from "node:child_process";
// Put the probe in tools/ so node can resolve "fontkit" against this
// project's node_modules.
const probeScriptPath = "tools/_probe-font-layout.mjs";
writeFileSync(probeScriptPath, `
import * as fontkit from "fontkit";
const [path, psn, startHex, endHex] = JSON.parse(process.argv[2]);
const f = fontkit.openSync(path);
const font = psn != null && f.getFont != null ? f.getFont(psn) : f;
const start = parseInt(startHex, 16);
const end = parseInt(endHex, 16);
// Probe EVERY codepoint in the range. Some macOS Sangam MN fonts have
// GSUB tables that fontkit's parser blows up on for SPECIFIC codepoints
// (e.g. U+0A01 in Gurmukhi crashes with "invalid array length" in
// ArrayPrototypeSplice). Skipping codepoints — even sampling per 1/16 —
// can miss the crashers, so walk the whole block. The probe runs once
// per font in the generator; runtime cost is amortised over many sweeps.
for (let cp = start; cp <= end; cp++) {
  font.layout(String.fromCodePoint(cp));
}
console.log("OK");
`);

const fontkitCrashers = new Set();
for (const [fontKey, resolved] of keyToResolved) {
  // Pick a sample codepoint from a range that uses this font.
  const sampleRange = ranges.find(r => r.fontKey === fontKey);
  const r = spawnSync(
    "node",
    [probeScriptPath, JSON.stringify([resolved.path, resolved.postscriptName ?? null, sampleRange.start.toString(16), sampleRange.end.toString(16)])],
    { encoding: "utf8", timeout: 8000 },
  );
  const ok = r.status === 0 && r.stdout.includes("OK");
  if (!ok) fontkitCrashers.add(fontKey);
}

// Re-emit with extractor: "native" on the crashers.
out = "// AUTO-GENERATED by tools/probe-983-genroutes.mjs — do not edit by hand.\n";
out += "// Source data: /tmp/unicode-fonts.darwin.json (produced by tools/probe-983-sweep.mjs).\n";
out += "// Maps Unicode blocks to the macOS font family Chrome's CoreText fallback\n";
out += "// picks via CDP `CSS.getPlatformFontsForNode`. Consulted by\n";
out += "// `darwinFallbackChain` as the final fallback when no hand-coded route\n";
out += "// matches a given codepoint. Fonts marked `extractor: \"native\"` here\n";
out += "// crash fontkit (\"invalid array length\" in ArrayPrototypeSplice during\n";
out += "// GSUB shaping — verified per-font by spawnSync probe in the generator);\n";
out += "// the renderer routes them through the macOS CoreText glyph-helper.\n";
out += "\n";
out += "export interface UnicodeFontEntry { path: string; postscriptName?: string; extractor?: \"fontkit\" | \"native\" }\n\n";
out += "export const UNICODE_FONT_PATHS: Record<string, UnicodeFontEntry> = {\n";
seenKeys.clear();
for (const r of ranges) {
  if (seenKeys.has(r.fontKey)) continue;
  seenKeys.add(r.fontKey);
  const psn = r.resolved.postscriptName != null ? `, postscriptName: ${JSON.stringify(r.resolved.postscriptName)}` : "";
  // Either the per-codepoint subprocess probe crashed (auto-detected),
  // or the resolver pre-marked it (Grantha — sub-font extraction trips
  // "Not a fixed size" in fontkit's restructure parser).
  const forceNative = fontkitCrashers.has(r.fontKey) || r.resolved.extractor === "native";
  const ext = forceNative ? `, extractor: "native" as const` : "";
  out += `  ${JSON.stringify(r.fontKey)}: { path: ${JSON.stringify(r.resolved.path)}${psn}${ext} },\n`;
}
out += "};\n\n";
out += "/** [start, end, fontKey] tuples sorted by start. Probed by binary-searching for the matching range. */\n";
out += "export const UNICODE_FONT_RANGES: ReadonlyArray<readonly [number, number, string]> = [\n";
for (const r of ranges) {
  out += `  [0x${r.start.toString(16).toUpperCase()}, 0x${r.end.toString(16).toUpperCase()}, ${JSON.stringify(r.fontKey)}], // ${r.blockName} (${r.family})\n`;
}
out += "];\n";

writeFileSync("src/render/unicode-font-routing.darwin.generated.ts", out);

console.log(`Generated ${ranges.length} ranges covering ${seenKeys.size} fonts.`);
console.log(`Unresolved font families (no on-disk path mapped — blocks skipped):`);
for (const f of unresolved) console.log(`  - ${JSON.stringify(f)}`);

let missing = 0;
for (const [key, r] of keyToResolved) {
  if (!existsSync(r.path)) {
    console.log(`  MISSING: ${key} → ${r.path}`);
    missing++;
  }
}
console.log(`\n${missing} paths missing on this system; ${keyToResolved.size - missing} verified.`);
console.log(`${fontkitCrashers.size} fontkit-crashing fonts marked extractor:"native" — routed through the CoreText glyph-helper:`);
for (const k of fontkitCrashers) console.log(`  - ${k}`);
