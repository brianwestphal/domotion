/**
 * Blink's **Windows hardcoded per-script fallback stage**, transcribed.
 *
 * On Windows, `FontCache::PlatformFallbackFontForCharacter` does NOT go straight
 * to DirectWrite. It asks a hardcoded table first and only falls through to the
 * API when that table has no usable answer
 * (`third_party/blink/renderer/platform/fonts/win/font_cache_skia_win.cc:286-296`):
 *
 *     const SimpleFontData* hardcoded_list_fallback_font =
 *         GetFallbackFamilyNameFromHardcodedChoices(
 *             font_description, character, fallback_priority_with_emoji_text);
 *     // Fall through to running the API-based fallback.
 *     if (!hardcoded_list_fallback_font) {
 *       return GetDWriteFallbackFamily(font_description, character,
 *                                      fallback_priority_with_emoji_text);
 *     }
 *     return hardcoded_list_fallback_font;
 *
 * So on a machine with a complete font set, whole scripts never reach
 * DirectWrite at all — which means an implementation built only on
 * `IDWriteFontFallback::MapCharacters` answers a question Chrome asks *second*
 * and often never. This module is the first question.
 *
 * Everything here is a transcription, not a derivation. Sources (all read from
 * the local checkout at `external/chromium`, revision `7d859f27`, 2026-06-27,
 * except the two files that checkout omits — noted per-symbol):
 *
 * - `platform/fonts/win/font_fallback_win.cc:119-320` — `InitializeScriptFontMap`,
 *   the 74-entry script→font-list table reproduced as `WIN_SCRIPT_FONT_FAMILIES`.
 * - `platform/fonts/win/font_fallback_win.cc:322-330` — `GetScript`.
 * - `platform/fonts/win/font_fallback_win.cc:332-402` — the emoji + math font lists.
 * - `platform/fonts/win/font_fallback_win.cc:404-440` — `GetFontBasedOnUnicodeBlock`.
 * - `platform/fonts/win/font_fallback_win.cc:459-490` — `GetFontFamilyForScript`
 *   (including the monospace Arabic/Hebrew special case at `:111-117`).
 * - `platform/fonts/win/font_fallback_win.cc:500-607` — `GetFallbackFamily`:
 *   stage order, the full-width-ASCII→Han rule, the BMP-only guard on the script
 *   table, the plane 1/2/3 routing, and the `lucida sans unicode` last resort.
 * - `platform/fonts/win/font_cache_skia_win.cc:160-224` —
 *   `GetFallbackFamilyNameFromHardcodedChoices`: the coverage re-check and the
 *   two pan-Unicode probe lists.
 * - `platform/text/character.cc:321-351` — `Character::GetScriptBasedOnUnicodeBlock`.
 *   NOT in the local checkout (it carries only `platform/fonts/`); read from
 *   chromium.googlesource.com `main` on 2026-07-30.
 * - `platform/text/locale_to_script_mapping.{h,cc}` and `platform/text/layout_locale.cc`
 *   — the Han disambiguation (`ScriptNameToCode`, `ScriptCodeForHanFromRegion`,
 *   `ScriptCodeForHanFromSubtags`, `IsUnambiguousHanScript`, `GetScriptForHan`).
 *   Also absent from the local checkout; same fetch.
 * - `third_party/skia/src/ports/SkFontMgr_win_dw.cpp:381-385, 1057-1067` —
 *   `IsFontPresent`'s `matchFamilyStyle` reduces to an exact
 *   `IDWriteFontCollection::FindFamilyName`, which is precisely the win32 glyph
 *   helper's `family` query. Read from chromium.googlesource.com/skia `main`,
 *   2026-07-30 (the checkout omits `third_party/skia`).
 *
 * ## What is NOT transcribed, and why
 *
 * - `IsFontPresent` is a *host* question, so it arrives as the injected
 *   `isFontPresent` predicate rather than a baked-in filename table. A frozen
 *   table would reintroduce exactly the defect that made the sampled darwin
 *   routing wrong: one machine's font inventory compiled into source.
 * - `FontContainsCharacter` is likewise the caller's job — the fallback-chain
 *   walker already answers coverage with the real font file. This module
 *   therefore returns Blink's ORDERED CANDIDATE LIST and lets the walker apply
 *   the coverage test at each step, which reproduces Blink's control flow
 *   exactly: the script table contributes at most ONE family (the first
 *   installed one), and a coverage miss on it goes to the pan-Unicode list —
 *   NOT to the next entry of the script list.
 *
 * ## ICU script codes as UCD Script-property names
 *
 * Blink keys on `UScriptCode`. `uscript_getScript()` returns the UCD `Script`
 * property, which JavaScript exposes natively as `\p{Script=…}`, so the lookup
 * here is the same property from the same UCD data rather than a re-derivation.
 * Script values are disjoint, so testing candidates in any order is exact.
 * Four `UScriptCode` values in the table are ICU *composite* codes that
 * `uscript_getScript` never returns (`Hrkt`, `Hans`, `Hant`, `Zsym`); they are
 * reachable only through block inference or Han locale disambiguation, and carry
 * their ISO 15924 tags as keys here to keep that distinction visible.
 */

/** A script key: a UCD Script-property long name, or one of the four ICU
 *  composite codes Blink's table also uses (`Hrkt`/`Hans`/`Hant`/`Zsym`). */
export type WinScript = string;

/** ICU composite script codes — never returned by `uscript_getScript`, only by
 *  block inference (`Hrkt`) or Han locale disambiguation (`Hans`/`Hant`).
 *  `Zsym` (`USCRIPT_SYMBOLS`) is unreachable in both, and is transcribed only
 *  so the table is complete. */
export const HRKT: WinScript = "Hrkt"; // USCRIPT_KATAKANA_OR_HIRAGANA
export const HANS: WinScript = "Hans"; // USCRIPT_SIMPLIFIED_HAN
export const HANT: WinScript = "Hant"; // USCRIPT_TRADITIONAL_HAN
export const ZSYM: WinScript = "Zsym"; // USCRIPT_SYMBOLS

/**
 * Stands for "any `UScriptCode` with no `kScriptToFontFamilies` row".
 *
 * The stage never needs the identity of such a script: every branch in
 * `GetFallbackFamily` that reads one tests it against a table key, against
 * `USCRIPT_COMMON`/`USCRIPT_INHERITED`, or against `USCRIPT_HAN`. Collapsing the
 * rest into one value (Tagalog, Balinese, Lepcha, `USCRIPT_UNKNOWN`, …) is
 * therefore behavior-identical, and honest about what is actually distinguished
 * — rather than implying we resolve 200 script codes when only the ones the table
 * keys on can change an answer.
 */
export const UNMAPPED_SCRIPT: WinScript = "Unmapped";

/**
 * The UCD blocks Blink's Windows fallback switches on, and nothing else.
 *
 * `ublock_getCode()` covers every block; the two functions that consult it
 * (`GetFontBasedOnUnicodeBlock`, `Character::GetScriptBasedOnUnicodeBlock`) both
 * `default:` to "no answer", so only the blocks they name can change an outcome.
 * Ranges are the UCD block boundaries, each one cross-checked against this
 * repo's per-Unicode-block fixture corpus (`../html-test/unicode/*.html`, whose
 * file names carry the block range) and the per-block ranges in
 * `unicode-font-routing.win32.generated.ts`.
 */
const enum Block {
  None = 0,
  Greek, // UBLOCK_GREEK — "Greek and Coptic"
  Armenian,
  Arabic,
  Devanagari,
  Kannada,
  Thai,
  Georgian,
  Arrows,
  MathematicalOperators,
  MiscellaneousTechnical,
  GeometricShapes,
  MiscellaneousSymbols,
  Dingbats,
  MiscellaneousMathematicalSymbolsA,
  SupplementalArrowsA,
  SupplementalArrowsB,
  MiscellaneousMathematicalSymbolsB,
  SupplementalMathematicalOperators,
  MiscellaneousSymbolsAndArrows,
  CjkSymbolsAndPunctuation,
  Hiragana,
  Katakana,
  Gothic,
  MathematicalAlphanumericSymbols,
  ArabicMathematicalAlphabeticSymbols,
  PlayingCards,
  EnclosedAlphanumericSupplement,
  MiscellaneousSymbolsAndPictographs,
  Emoticons,
  TransportAndMapSymbols,
  AlchemicalSymbols,
  GeometricShapesExtended,
}

/** `ublock_getCode(cp)`, narrowed to the blocks above. */
function ublockGetCode(cp: number): Block {
  // BMP first — every hot codepoint is here.
  if (cp < 0x10000) {
    if (cp >= 0x0370 && cp <= 0x03FF) return Block.Greek;
    if (cp >= 0x0530 && cp <= 0x058F) return Block.Armenian;
    if (cp >= 0x0600 && cp <= 0x06FF) return Block.Arabic;
    if (cp >= 0x0900 && cp <= 0x097F) return Block.Devanagari;
    if (cp >= 0x0C80 && cp <= 0x0CFF) return Block.Kannada;
    if (cp >= 0x0E00 && cp <= 0x0E7F) return Block.Thai;
    if (cp >= 0x10A0 && cp <= 0x10FF) return Block.Georgian;
    if (cp >= 0x2190 && cp <= 0x21FF) return Block.Arrows;
    if (cp >= 0x2200 && cp <= 0x22FF) return Block.MathematicalOperators;
    if (cp >= 0x2300 && cp <= 0x23FF) return Block.MiscellaneousTechnical;
    if (cp >= 0x25A0 && cp <= 0x25FF) return Block.GeometricShapes;
    if (cp >= 0x2600 && cp <= 0x26FF) return Block.MiscellaneousSymbols;
    if (cp >= 0x2700 && cp <= 0x27BF) return Block.Dingbats;
    if (cp >= 0x27C0 && cp <= 0x27EF) return Block.MiscellaneousMathematicalSymbolsA;
    if (cp >= 0x27F0 && cp <= 0x27FF) return Block.SupplementalArrowsA;
    if (cp >= 0x2900 && cp <= 0x297F) return Block.SupplementalArrowsB;
    if (cp >= 0x2980 && cp <= 0x29FF) return Block.MiscellaneousMathematicalSymbolsB;
    if (cp >= 0x2A00 && cp <= 0x2AFF) return Block.SupplementalMathematicalOperators;
    if (cp >= 0x2B00 && cp <= 0x2BFF) return Block.MiscellaneousSymbolsAndArrows;
    if (cp >= 0x3000 && cp <= 0x303F) return Block.CjkSymbolsAndPunctuation;
    if (cp >= 0x3040 && cp <= 0x309F) return Block.Hiragana;
    if (cp >= 0x30A0 && cp <= 0x30FF) return Block.Katakana;
    return Block.None;
  }
  if (cp >= 0x10330 && cp <= 0x1034F) return Block.Gothic;
  if (cp >= 0x1D400 && cp <= 0x1D7FF) return Block.MathematicalAlphanumericSymbols;
  if (cp >= 0x1EE00 && cp <= 0x1EEFF) return Block.ArabicMathematicalAlphabeticSymbols;
  if (cp >= 0x1F0A0 && cp <= 0x1F0FF) return Block.PlayingCards;
  if (cp >= 0x1F100 && cp <= 0x1F1FF) return Block.EnclosedAlphanumericSupplement;
  if (cp >= 0x1F300 && cp <= 0x1F5FF) return Block.MiscellaneousSymbolsAndPictographs;
  if (cp >= 0x1F600 && cp <= 0x1F64F) return Block.Emoticons;
  if (cp >= 0x1F680 && cp <= 0x1F6FF) return Block.TransportAndMapSymbols;
  if (cp >= 0x1F700 && cp <= 0x1F77F) return Block.AlchemicalSymbols;
  if (cp >= 0x1F780 && cp <= 0x1F7FF) return Block.GeometricShapesExtended;
  return Block.None;
}

// ---------------------------------------------------------------------------
// InitializeScriptFontMap — font_fallback_win.cc:119-320
//
// Verbatim, including Chromium's own comments where they explain an ordering
// choice, and including `pmingli` (a truncated "pmingliu" in the Traditional Han
// list); a transcription that silently repaired it would stop being one, and the
// entry is inert either way since no such family exists.
// ---------------------------------------------------------------------------

const kArabicFonts = ["Tahoma", "Segoe UI"] as const;
const kArmenianFonts = ["Segoe UI", "Sylfaen"] as const;
const kBengaliFonts = ["Nirmala UI", "Vrinda"] as const;
const kBrahmiFonts = ["Segoe UI Historic"] as const;
const kBrailleFonts = ["Segoe UI Symbol"] as const;
const kBugineseFonts = ["Leelawadee UI"] as const;
const kCanadianAaboriginalFonts = ["Gadugi", "Euphemia"] as const;
const kCarianFonts = ["Segoe UI Historic"] as const;
const kCherokeeFonts = ["Gadugi", "Plantagenet"] as const;
const kCopticFonts = ["Segoe UI Symbol"] as const;
const kCuneiformFonts = ["Segoe UI Historic"] as const;
const kCypriotFonts = ["Segoe UI Historic"] as const;
const kCyrillicFonts = ["Times New Roman"] as const;
const kDeseretFonts = ["Segoe UI Symbol"] as const;
const kDevanagariFonts = ["Nirmala UI", "Mangal"] as const;
const kEgyptianHieroglyphsFonts = ["Segoe UI Historic"] as const;
const kEthiopicFonts = [
  "Nyala", "Abyssinica SIL", "Ethiopia Jiret", "Visual Geez Unicode",
  "GF Zemen Unicode", "Ebrima",
] as const;
const kGeorgianFonts = ["Sylfaen", "Segoe UI"] as const;
const kGlagoliticFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kGothicFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kGreekFonts = ["Times New Roman"] as const;
const kGujaratiFonts = ["Nirmala UI", "Shruti"] as const;
const kGurmukhiFonts = ["Nirmala UI", "Raavi"] as const;
const kHangulFonts = ["Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", "Gulim"] as const;
const kHebrewFonts = ["David", "Segoe UI"] as const;
const kImperialAramaicFonts = ["Segoe UI Historic"] as const;
const kInscriptionalPahlaviFonts = ["Segoe UI Historic"] as const;
const kInscriptionalParthianFonts = ["Segoe UI Historic"] as const;
const kJavaneseFonts = ["Javanese Text"] as const;
const kKannadaFonts = ["Tunga", "Nirmala UI"] as const;
const kKatakanaOrHiraganaFonts = [
  "Noto Sans JP", "Noto Sans CJK JP", "Meiryo",
  "Yu Gothic", "MS PGothic", "Microsoft YaHei",
] as const;
const kKharoshthiFonts = ["Segoe UI Historic"] as const;
// Try Khmer OS before Vista fonts as it goes along better with Latin
// and looks better/larger for the same size.
const kKhmerFonts = ["Leelawadee UI", "Khmer UI", "Khmer OS", "MoolBoran", "DaunPenh"] as const;
const kLaoFonts = [
  "Leelawadee UI", "Lao UI", "DokChampa", "Saysettha OT", "Phetsarath OT", "Code2000",
] as const;
const kLatinFonts = ["Times New Roman"] as const;
const kLisuFonts = ["Segoe UI"] as const;
const kLycianFonts = ["Segoe UI Historic"] as const;
const kLydianFonts = ["Segoe UI Historic"] as const;
const kMalayalamFonts = ["Nirmala UI", "Kartika"] as const;
const kMeroiticCursiveFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kMongolianFonts = ["Mongolian Baiti"] as const;
const kMyanmarFonts = ["Myanmar Text", "Padauk", "Parabaik", "Myanmar3", "Code2000"] as const;
const kNewTaiLueFonts = ["Microsoft New Tai Lue"] as const;
const kNkoFonts = ["Ebrima"] as const;
const kOghamFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kOlChikiFonts = ["Nirmala UI"] as const;
const kOldItalicFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kOldPersianFonts = ["Segoe UI Historic"] as const;
const kOldSouthArabianFonts = ["Segoe UI Historic"] as const;
const kOriyaFonts = ["Kalinga", "ori1Uni", "Lohit Oriya", "Nirmala UI"] as const;
const kOrkhonFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kOsmanyaFonts = ["Ebrima"] as const;
const kPhagsPaFonts = ["Microsoft PhagsPa"] as const;
const kRunicFonts = ["Segoe UI Historic", "Segoe UI Symbol"] as const;
const kShavianFonts = ["Segoe UI Historic"] as const;
const kSimplifiedHanFonts = ["Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "simsun"] as const;
const kSinhalaFonts = ["Iskoola Pota", "AksharUnicode", "Nirmala UI"] as const;
const kSoraSompengFonts = ["Nirmala UI"] as const;
const kSymbolsFonts = ["Segoe UI Symbol"] as const;
const kSyriacFonts = ["Estrangelo Edessa", "Estrangelo Nisibin", "Code2000"] as const;
const kTaiLeFonts = ["Microsoft Tai Le"] as const;
const kTamilFonts = ["Nirmala UI", "Latha"] as const;
const kTeluguFonts = ["Nirmala UI", "Gautami"] as const;
const kThaanaFonts = ["MV Boli"] as const;
const kThaiFonts = ["Tahoma", "Leelawadee UI", "Leelawadee"] as const;
const kTibetanFonts = ["Microsoft Himalaya", "Jomolhari", "Tibetan Machine Uni"] as const;
const kTifinaghFonts = ["Ebrima"] as const;
// `pmingli` is Chromium's own truncation of "pmingliu" — transcribed as written.
const kTraditionalHanFonts = ["Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "pmingli"] as const;
const kVaiFonts = ["Ebrima"] as const;
const kYiFonts = ["Microsoft Yi Baiti", "Nuosu SIL", "Code2000"] as const;

/**
 * `kScriptToFontFamilies` — all 74 entries, in Blink's declaration order.
 * "For the following scripts, multiple fonts may be listed. They are tried in
 * order. The first slot is preferred but the font may not be available, if so
 * the remaining slots are tried in order." (font_fallback_win.cc:120-122)
 */
export const WIN_SCRIPT_FONT_FAMILIES: Readonly<Record<WinScript, readonly string[]>> = {
  Arabic: kArabicFonts,
  Armenian: kArmenianFonts,
  Bengali: kBengaliFonts,
  Brahmi: kBrahmiFonts,
  Braille: kBrailleFonts,
  Buginese: kBugineseFonts,
  Canadian_Aboriginal: kCanadianAaboriginalFonts,
  Carian: kCarianFonts,
  Cherokee: kCherokeeFonts,
  Coptic: kCopticFonts,
  Cuneiform: kCuneiformFonts,
  Cypriot: kCypriotFonts,
  Cyrillic: kCyrillicFonts,
  Deseret: kDeseretFonts,
  Devanagari: kDevanagariFonts,
  Egyptian_Hieroglyphs: kEgyptianHieroglyphsFonts,
  Ethiopic: kEthiopicFonts,
  Georgian: kGeorgianFonts,
  Glagolitic: kGlagoliticFonts,
  Gothic: kGothicFonts,
  Greek: kGreekFonts,
  Gujarati: kGujaratiFonts,
  Gurmukhi: kGurmukhiFonts,
  Hangul: kHangulFonts,
  Hebrew: kHebrewFonts,
  Hiragana: kKatakanaOrHiraganaFonts,
  Imperial_Aramaic: kImperialAramaicFonts,
  Inscriptional_Pahlavi: kInscriptionalPahlaviFonts,
  Inscriptional_Parthian: kInscriptionalParthianFonts,
  Javanese: kJavaneseFonts,
  Kannada: kKannadaFonts,
  Katakana: kKatakanaOrHiraganaFonts,
  [HRKT]: kKatakanaOrHiraganaFonts,
  Kharoshthi: kKharoshthiFonts,
  Khmer: kKhmerFonts,
  Lao: kLaoFonts,
  Latin: kLatinFonts,
  Lisu: kLisuFonts,
  Lycian: kLycianFonts,
  Lydian: kLydianFonts,
  Malayalam: kMalayalamFonts,
  Meetei_Mayek: kSoraSompengFonts, // USCRIPT_MEITEI_MAYEK → kSoraSompengFonts (as in Blink)
  Meroitic_Cursive: kMeroiticCursiveFonts,
  Mongolian: kMongolianFonts,
  Myanmar: kMyanmarFonts,
  New_Tai_Lue: kNewTaiLueFonts,
  Nko: kNkoFonts,
  Ogham: kOghamFonts,
  Ol_Chiki: kOlChikiFonts,
  Old_Italic: kOldItalicFonts,
  Old_Persian: kOldPersianFonts,
  Old_South_Arabian: kOldSouthArabianFonts,
  Oriya: kOriyaFonts,
  Old_Turkic: kOrkhonFonts, // USCRIPT_ORKHON is an alias of USCRIPT_OLD_TURKIC
  Osmanya: kOsmanyaFonts,
  Phags_Pa: kPhagsPaFonts,
  Runic: kRunicFonts,
  Shavian: kShavianFonts,
  [HANS]: kSimplifiedHanFonts,
  Sinhala: kSinhalaFonts,
  Sora_Sompeng: kSoraSompengFonts,
  [ZSYM]: kSymbolsFonts,
  Syriac: kSyriacFonts,
  Tai_Le: kTaiLeFonts,
  Tamil: kTamilFonts,
  Telugu: kTeluguFonts,
  Thaana: kThaanaFonts,
  Thai: kThaiFonts,
  Tibetan: kTibetanFonts,
  Tifinagh: kTifinaghFonts,
  [HANT]: kTraditionalHanFonts,
  Bopomofo: kTraditionalHanFonts,
  Vai: kVaiFonts,
  Yi: kYiFonts,
};

/** `kEmojiFonts` in `AvailableColorEmojiFont` (font_fallback_win.cc:332-343). */
export const WIN_COLOR_EMOJI_FONTS: readonly string[] = ["Segoe UI Emoji", "Segoe UI Symbol"];
/** `kEmojiFonts` in `AvailableMonoEmojiFont` (font_fallback_win.cc:345-356) —
 *  note the reversed preference against the color list. */
export const WIN_MONO_EMOJI_FONTS: readonly string[] = ["Segoe UI Symbol", "Segoe UI Emoji"];
/** `kMathFonts` in `FirstAvailableMathFont` (font_fallback_win.cc:358-369). */
export const WIN_MATH_FONTS: readonly string[] = ["Cambria Math", "Segoe UI Symbol", "Code2000"];

/**
 * `kCjkFonts` — the pan-Unicode probe list `GetFallbackFamilyNameFromHardcodedChoices`
 * walks when the script-table family exists but doesn't cover the codepoint, and
 * the resolved script is still unified Han (font_cache_skia_win.cc:186-196).
 * "Last resort font list : PanUnicode. CJK fonts have a pretty large repertoire."
 */
export const WIN_PAN_UNICODE_CJK_FONTS: readonly string[] = [
  "arial unicode ms", "ms pgothic", "simsun", "gulim", "pmingliu",
  "wenquanyi zen hei", "ar pl shanheisun uni", "ar pl zenkai uni",
  "han nom a", "code2000",
];

/** `kCommonFonts` — the same list for every non-Han script
 *  (font_cache_skia_win.cc:198-204). `dejavu sasns` is Chromium's own typo for
 *  "dejavu sans"; transcribed as written. */
export const WIN_PAN_UNICODE_COMMON_FONTS: readonly string[] = [
  "tahoma", "arial unicode ms", "lucida sans unicode",
  "microsoft sans serif", "palatino linotype",
  "dejavu serif", "dejavu sasns", "freeserif", "freesans", "gentium",
  "gentiumalt", "ms pgothic", "simsun", "gulim", "pmingliu", "code2000",
];

// ---------------------------------------------------------------------------
// Script lookup
// ---------------------------------------------------------------------------

/** Every real Script-property value the table can key on. Composite codes
 *  (`Hrkt`/`Hans`/`Hant`/`Zsym`) are excluded — no codepoint carries them. */
const REAL_SCRIPTS: readonly WinScript[] = Object.keys(WIN_SCRIPT_FONT_FAMILIES)
  .filter((s) => s !== HRKT && s !== HANS && s !== HANT && s !== ZSYM)
  // `Han` is not a table key (only Hans/Hant/Hrkt/Hangul are) but IS what
  // `uscript_getScript` answers for ideographs, and `GetFallbackFamily` branches
  // on it, so it has to be distinguishable.
  .concat(["Han"]);

const SCRIPT_RES: ReadonlyArray<readonly [WinScript, RegExp]> =
  REAL_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")] as const);
const RE_COMMON = /\p{Script=Common}/u;
const RE_INHERITED = /\p{Script=Inherited}/u;
/** `Character::IsEmoji` — "Returns true if the character has a Emoji property"
 *  (`platform/text/character.h:198-200`), i.e. the UCD `Emoji` binary property. */
const RE_EMOJI = /\p{Emoji}/u;

const _scriptCache = new Map<number, WinScript>();

/** `uscript_getScript(cp)`, as the UCD Script-property long name — or
 *  `UNMAPPED_SCRIPT` for any script the table has no row for. */
export function uscriptGetScript(cp: number): WinScript {
  const hit = _scriptCache.get(cp);
  if (hit !== undefined) return hit;
  const ch = String.fromCodePoint(cp);
  let out: WinScript = UNMAPPED_SCRIPT;
  if (RE_COMMON.test(ch)) out = "Common";
  else if (RE_INHERITED.test(ch)) out = "Inherited";
  else {
    for (const [name, re] of SCRIPT_RES) {
      if (re.test(ch)) { out = name; break; }
    }
  }
  _scriptCache.set(cp, out);
  return out;
}

/**
 * `Character::GetScriptBasedOnUnicodeBlock` (character.cc:321-351).
 *
 * "There are a lot of characters in USCRIPT_COMMON that can be covered by fonts
 * for scripts closely related to them."
 */
export function getScriptBasedOnUnicodeBlock(cp: number): WinScript {
  switch (ublockGetCode(cp)) {
    case Block.CjkSymbolsAndPunctuation: return "Han";
    case Block.Hiragana:
    case Block.Katakana: return HRKT;
    case Block.Arabic: return "Arabic";
    case Block.Thai: return "Thai";
    case Block.Greek: return "Greek";
    // For Danda and Double Danda (U+0964, U+0965), use a Devanagari font for now
    // although they're used by other scripts as well. Without a context, we
    // can't do any better.
    case Block.Devanagari: return "Devanagari";
    case Block.Armenian: return "Armenian";
    case Block.Georgian: return "Georgian";
    case Block.Kannada: return "Kannada";
    case Block.Gothic: return "Gothic";
    default: return "Common";
  }
}

/** `GetScript` (font_fallback_win.cc:322-330). */
export function getScript(cp: number): WinScript {
  const script = uscriptGetScript(cp);
  // "If script is invalid, common or inherited or there's an error, infer a
  // script based on the unicode block of a character."
  if (script === "Common" || script === "Inherited") return getScriptBasedOnUnicodeBlock(cp);
  return script;
}

// ---------------------------------------------------------------------------
// Han locale disambiguation
// ---------------------------------------------------------------------------

/** `kScriptNameCodeList`, restricted to the four values `IsUnambiguousHanScript`
 *  accepts (locale_to_script_mapping.cc:43-158). Any other 4ALPHA subtag maps to
 *  a script that fails that test, so the restriction is lossless here. */
const HAN_SCRIPT_SUBTAGS: Readonly<Record<string, WinScript>> = {
  hang: "Hangul", hira: HRKT, kana: HRKT, hrkt: HRKT,
  hans: HANS, hant: HANT, jpan: HRKT, kore: "Hangul",
};

/** `kRegionScriptList` in `ScriptCodeForHanFromRegion`
 *  (locale_to_script_mapping.cc:470-482). */
const HAN_REGION_SUBTAGS: Readonly<Record<string, WinScript>> = {
  hk: HANT, jp: HRKT, kr: "Hangul", mo: HANT, tw: HANT,
};

/** `kLocaleScriptList`, restricted to the entries that yield an unambiguous Han
 *  script (locale_to_script_mapping.cc:164-441). Every other language subtag
 *  maps to a non-Han script, which `IsUnambiguousHanScript` rejects — so for the
 *  Han decision this slice is the whole table. */
const HAN_LANGUAGE_SUBTAGS: Readonly<Record<string, WinScript>> = {
  ja: HRKT, ko: "Hangul",
  zh: HANS,
  // "Encompassed languages within the Chinese macrolanguage."
  cdo: HANS, cjy: HANS, cmn: HANS, cpx: HANS, czh: HANS, czo: HANS,
  gan: HANS, hsn: HANS, mnp: HANS, wuu: HANS,
  hak: HANT, lzh: HANT, nan: HANT, yue: HANT,
  "zh-cdo": HANS, "zh-cjy": HANS, "zh-cmn": HANS, "zh-cpx": HANS,
  "zh-czh": HANS, "zh-czo": HANS, "zh-gan": HANS, "zh-hsn": HANS,
  "zh-mnp": HANS, "zh-wuu": HANS,
  "zh-hak": HANT, "zh-lzh": HANT, "zh-nan": HANT, "zh-yue": HANT,
  // "Chinese with regions."
  "zh-hk": HANT, "zh-mo": HANT, "zh-tw": HANT,
};

/** `IsUnambiguousHanScript` (locale_to_script_mapping.h:48-54). */
function isUnambiguousHanScript(script: WinScript | null): boolean {
  return script === HRKT || script === HANS || script === HANT || script === "Hangul";
}

/** `LocaleToScriptCodeForFontSelection` (locale_to_script_mapping.cc:164-441),
 *  answering only "is this an unambiguous Han script?" — the sole question
 *  `ComputeScriptForHan` asks of it. Null means "not one of the four". */
function localeToHanScript(locale: string): WinScript | null {
  // "BCP 47 uses '-' as the delimiter but ICU uses '_'."
  let tag = locale.replace(/_/g, "-").toLowerCase();
  while (tag !== "") {
    const direct = HAN_LANGUAGE_SUBTAGS[tag];
    if (direct !== undefined) return direct;
    const pos = tag.lastIndexOf("-");
    if (pos === -1) break;
    // script = 4ALPHA
    if (tag.length - (pos + 1) === 4) {
      const code = HAN_SCRIPT_SUBTAGS[tag.slice(pos + 1)];
      if (code !== undefined) return code;
    }
    tag = tag.slice(0, pos);
  }
  return null;
}

/** `ScriptCodeForHanFromSubtags` (locale_to_script_mapping.cc:484-507).
 *  "Some sites emit lang="en-JP" when English is set as the preferred language.
 *  Use script/region subtags of the content locale to pick the fallback font for
 *  unified Han ideographs." */
function scriptCodeForHanFromSubtags(locale: string): WinScript | null {
  const parts = locale.toLowerCase().split("-");
  for (let i = 1; i < parts.length; i++) {
    const sub = parts[i]!;
    if (sub.length === 2) {
      const script = HAN_REGION_SUBTAGS[sub];
      if (script !== undefined) return script;
    } else if (sub.length === 4) {
      const script = HAN_SCRIPT_SUBTAGS[sub];
      if (script !== undefined && isUnambiguousHanScript(script)) return script;
    }
  }
  return null;
}

/**
 * `LayoutLocale::GetScriptForHan()` + `HasScriptForHan()`
 * (layout_locale.cc:198-223), collapsed: returns the unambiguous Han script this
 * locale disambiguates to, or null when it disambiguates nothing (Blink's
 * `has_script_for_han_ == false`, which is what `LocaleForHan` tests).
 */
export function hanScriptForLocale(locale: string | undefined): WinScript | null {
  if (locale == null || locale === "") return null;
  const direct = localeToHanScript(locale);
  if (isUnambiguousHanScript(direct)) return direct;
  const fromSubtags = scriptCodeForHanFromSubtags(locale);
  // `ComputeScriptForHan` falls back to SIMPLIFIED_HAN when the subtags say
  // nothing, but leaves `has_script_for_han_` false — so that default is NOT
  // visible through `LocaleForHan`, and null is the faithful answer here.
  return fromSubtags;
}

/** ICU's process default locale, which is what Blink's `LayoutLocale::GetSystem()`
 *  ultimately reflects (the OS UI language). */
function icuDefaultLocale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "";
  }
}

/**
 * `LayoutLocale::GetSystem().GetScriptForHan()` — the value
 * `InitializeScriptFontMap` copies into the `USCRIPT_HAN` slot
 * (font_fallback_win.cc:312-319).
 *
 * That call site reads `GetScriptForHan()` **directly**, not through
 * `HasScriptForHan()`, so `ComputeScriptForHan`'s "if the subtags say nothing,
 * Simplified Han" default (layout_locale.cc:205-207) IS visible here — which is
 * why an `en-US` system locale gives the HAN slot the Simplified Han font list.
 */
export function systemHanScript(): WinScript {
  return hanScriptForLocale(icuDefaultLocale()) ?? HANS;
}

/**
 * `LayoutLocale::LocaleForHan(content_locale)->GetScriptForHan()`
 * (layout_locale.cc:226-257), collapsed to what this process can know.
 *
 * Blink tries, in order: the content locale, then the first accept-language that
 * disambiguates, then the default locale, then the system locale — and returns
 * nullptr when NONE of them does, which leaves the script as `USCRIPT_HAN`. The
 * three fallback sources all reduce to the host's locale here (there is no
 * browser accept-languages list in a capture process), so this is content locale
 * then host locale, and null when neither disambiguates.
 *
 * Null is load-bearing rather than a shrug: it is what selects the CJK
 * pan-Unicode probe list over the common one downstream, and it is the state a
 * plain `en-US` host is actually in.
 */
function localeForHanScript(lang: string | undefined): WinScript | null {
  return hanScriptForLocale(lang) ?? hanScriptForLocale(icuDefaultLocale());
}

// ---------------------------------------------------------------------------
// GetFallbackFamily — font_fallback_win.cc:500-607
// ---------------------------------------------------------------------------

/** `FontFallbackPriority`, narrowed to the three states this stage distinguishes
 *  (`platform/fonts/font_fallback_priority.h:45-53`). */
export type WinFallbackPriority = "text" | "emoji-text" | "emoji-emoji";

/** `FontDescription::GenericFamilyType`, narrowed to the one value that changes
 *  an answer (`FindMonospaceFontForScript`). */
export type WinGenericFamily = "standard" | "monospace";

export interface WinFallbackOptions {
  /** The run's CSS generic family. Only `monospace` changes an outcome. */
  generic?: WinGenericFamily;
  /** The run's content locale (`lang`), for unified-Han disambiguation. */
  lang?: string;
  /** `FontFallbackPriority` for the run + codepoint. */
  priority?: WinFallbackPriority;
}

/** `IsFontPresent` (font_fallback_win.cc:54-59): is `family` an installed font
 *  on this host? Injected rather than tabulated — see the module comment. */
export type IsFontPresent = (family: string) => boolean;

/** `FirstAvailableFont` (font_fallback_win.cc:61-70). */
function firstAvailableFont(candidates: readonly string[], isFontPresent: IsFontPresent): string | null {
  for (const family of candidates) {
    if (isFontPresent(family)) return family;
  }
  return null;
}

/** `FindMonospaceFontForScript` (font_fallback_win.cc:111-117). */
function findMonospaceFontForScript(script: WinScript): string | null {
  if (script === "Arabic" || script === "Hebrew") return "courier new";
  return null;
}

/** `GetFontFamilyForScript` (font_fallback_win.cc:459-490). */
function getFontFamilyForScript(
  script: WinScript, generic: WinGenericFamily, isFontPresent: IsFontPresent,
): string | null {
  if (generic === "monospace") {
    const family = findMonospaceFontForScript(script);
    if (family != null) return family;
  }
  const candidates = winScriptCandidates(script);
  if (candidates == null) return null;
  return firstAvailableFont(candidates, isFontPresent);
}

/**
 * The candidate list for a script, including the `USCRIPT_HAN` slot that
 * `InitializeScriptFontMap` fills at init from the SYSTEM locale's Han script
 * (font_fallback_win.cc:312-319):
 *
 *     UScriptCode han_script = LayoutLocale::GetSystem().GetScriptForHan();
 *     const FontMapping& han_mapping = script_font_map[han_script];
 *     if (!han_mapping.candidate_family_names.empty())
 *       script_font_map[USCRIPT_HAN].candidate_family_names =
 *           han_mapping.candidate_family_names;
 *
 * So `USCRIPT_HAN` is not a static row: on a Simplified-Chinese-or-anything-else
 * host it carries the Simplified Han list, on a `zh-TW` host the Traditional Han
 * list, on `ja` the Japanese list.
 */
export function winScriptCandidates(script: WinScript): readonly string[] | null {
  if (script === "Han") return WIN_SCRIPT_FONT_FAMILIES[systemHanScript()] ?? null;
  return WIN_SCRIPT_FONT_FAMILIES[script] ?? null;
}

/** `GetFontBasedOnUnicodeBlock` (font_fallback_win.cc:404-440). */
function getFontBasedOnUnicodeBlock(cp: number, isFontPresent: IsFontPresent): string | null {
  switch (ublockGetCode(cp)) {
    case Block.Emoticons:
    case Block.EnclosedAlphanumericSupplement:
      // "We call this function only when FallbackPriority is not kEmojiEmoji or
      // kEmojiEmojiWithVS, so we need a text presentation of emoji."
      return firstAvailableFont(WIN_MONO_EMOJI_FONTS, isFontPresent);
    case Block.PlayingCards:
    case Block.MiscellaneousSymbols:
    case Block.MiscellaneousSymbolsAndArrows:
    case Block.MiscellaneousSymbolsAndPictographs:
    case Block.TransportAndMapSymbols:
    case Block.AlchemicalSymbols:
    case Block.Dingbats:
    case Block.Gothic:
      return "Segoe UI Symbol";
    case Block.Arrows:
    case Block.MathematicalOperators:
    case Block.MiscellaneousTechnical:
    case Block.GeometricShapes:
    case Block.MiscellaneousMathematicalSymbolsA:
    case Block.SupplementalArrowsA:
    case Block.SupplementalArrowsB:
    case Block.MiscellaneousMathematicalSymbolsB:
    case Block.SupplementalMathematicalOperators:
    case Block.MathematicalAlphanumericSymbols:
    case Block.ArabicMathematicalAlphabeticSymbols:
    case Block.GeometricShapesExtended:
      return firstAvailableFont(WIN_MATH_FONTS, isFontPresent);
    default:
      return null;
  }
}

/** What `GetFallbackFamily` produces: the single nominated family plus the
 *  `script_out` the caller uses to pick a pan-Unicode probe list. */
export interface WinFallbackFamily {
  family: string;
  /** `script_out`. Null stands for `USCRIPT_INVALID_CODE`, which the emoji and
   *  unicode-block stages assign. */
  script: WinScript | null;
}

/**
 * `GetFallbackFamily` (font_fallback_win.cc:500-607). Always answers — the
 * `lucida sans unicode` last resort is the floor — so the caller's coverage
 * check is what decides whether the answer is used.
 */
export function getFallbackFamily(
  cp: number, opts: WinFallbackOptions, isFontPresent: IsFontPresent,
): WinFallbackFamily {
  const priority = opts.priority ?? "text";
  const generic = opts.generic ?? "standard";

  if (priority === "emoji-emoji") {
    const family = firstAvailableFont(WIN_COLOR_EMOJI_FONTS, isFontPresent);
    if (family != null) return { family, script: null };
  } else if (priority === "emoji-text") {
    const family = firstAvailableFont(WIN_MONO_EMOJI_FONTS, isFontPresent);
    if (family != null) return { family, script: null };
  } else {
    const family = getFontBasedOnUnicodeBlock(cp, isFontPresent);
    if (family != null) return { family, script: null };
  }

  let script = getScript(cp);

  // "For the full-width ASCII characters (U+FF00 - U+FF5E), use the font for Han
  // (determined in a locale-dependent way above). Full-width ASCII characters
  // are rather widely used in Japanese and Chinese documents and they're fully
  // covered by Chinese, Japanese and Korean fonts."
  if (cp > 0xFF00 && cp < 0xFF5F) script = "Han";

  if (script === "Common") script = getScriptBasedOnUnicodeBlock(cp);

  // "For unified-Han scripts, try the lang attribute, system, or
  // accept-languages. If still unknown, USCRIPT_HAN uses UI locale. See
  // initializeScriptFontMap()." — so when nothing disambiguates, the script
  // stays `Han` and the HAN slot (filled from the system locale) answers.
  if (script === "Han") {
    script = localeForHanScript(opts.lang) ?? "Han";
  }

  const scriptOut = script;

  // "TODO(kojii): Limiting GetFontFamilyForScript() only to BMP may need review
  // to match the modern environment. This was done in 2010 for
  // https://bugs.webkit.org/show_bug.cgi?id=35605."
  if (cp <= 0xFFFF) {
    const family = getFontFamilyForScript(script, generic, isFontPresent);
    if (family != null) return { family, script: scriptOut };
  }

  // "Another lame work-around to cover non-BMP characters."
  const plane = cp >> 16;
  if (plane === 1) return { family: "code2001", script: scriptOut };
  if (plane === 2) {
    // "Extension I (category IX) is part of Plane 2: U+2EBF0-U+2EE5F. As per
    // GB18030-2022, these characters must be rendered using simsun-extg."
    if (cp >= 0x2EBF0 && cp <= 0x2EE5F) return { family: "simsun-extg", script: scriptOut };
    // "Use a Traditional Chinese ExtB font if in Traditional Chinese locale.
    // Otherwise, use a Simplified Chinese ExtB font."
    if (icuDefaultLocaleIsTraditionalChinese()) {
      return { family: "pmingliu-extb", script: scriptOut };
    }
    return { family: "simsun-extb", script: scriptOut };
  }
  if (plane === 3) {
    // "Plane 3 includes Extension G (category GX): U+30000-U+3134F and Extension
    // H (category HX): U+31350-U+323AF. Both are required by GB18030-2022 and
    // must be rendered using simsun-extg."
    return { family: "simsun-extg", script: scriptOut };
  }

  return { family: "lucida sans unicode", script: scriptOut };
}

/** `icu::Locale::getDefault() == icu::Locale::getTraditionalChinese()`
 *  (font_fallback_win.cc:585) — an exact `zh_TW` match on ICU's process default
 *  locale, which Node surfaces through `Intl`. */
function icuDefaultLocaleIsTraditionalChinese(): boolean {
  let locale = "";
  try {
    locale = new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch { return false; }
  return /^zh[-_]tw\b/i.test(locale);
}

/**
 * `FontCache::GetFallbackFamilyNameFromHardcodedChoices`
 * (font_cache_skia_win.cc:160-224), as the ordered family list to try.
 *
 * Blink's shape is: take the ONE family `GetFallbackFamily` nominates; if it
 * loads and covers the codepoint, done; otherwise probe a pan-Unicode list;
 * otherwise return null and let DirectWrite answer. Returning the list lets the
 * caller supply `FontContainsCharacter` from the real font file, and reproduces
 * that control flow exactly — in particular the script list contributes at most
 * one entry, so a coverage miss goes to the pan-Unicode probe rather than to the
 * script list's second slot.
 *
 * "Font returned from GetFallbackFamily() may not cover `codepoint` because it's
 * based on script to font mapping. This problem is critical enough for non-Latin
 * scripts (especially Han) to warrant an additional (real coverage) check with
 * FontContainsCharacter()."
 */
export function blinkWinHardcodedFamilies(
  cp: number, opts: WinFallbackOptions, isFontPresent: IsFontPresent,
): string[] {
  const { family, script } = getFallbackFamily(cp, opts, isFontPresent);
  const panUnicode = script === "Han" ? WIN_PAN_UNICODE_CJK_FONTS : WIN_PAN_UNICODE_COMMON_FONTS;
  const out = [family];
  const lead = family.toLowerCase();
  for (const f of panUnicode) {
    // Blink re-probes the nominated family here and gets the same non-covering
    // answer; skipping the duplicate is behavior-identical and one walker step
    // cheaper. Windows family matching is case-insensitive, and the two lists
    // are written in different cases ("Tahoma" vs "tahoma"), so compare folded.
    if (f.toLowerCase() !== lead) out.push(f);
  }
  return out;
}

/**
 * The `FontFallbackPriority` `PlatformFallbackFontForCharacter` actually passes
 * on (font_cache_skia_win.cc:279-284):
 *
 *     if (RuntimeEnabledFeatures::SystemFallbackEmojiVSSupportEnabled() &&
 *         fallback_priority == FontFallbackPriority::kText &&
 *         Character::IsEmoji(character)) {
 *       fallback_priority_with_emoji_text = FontFallbackPriority::kEmojiText;
 *     }
 *
 * `SystemFallbackEmojiVSSupport` is `status: "stable"` in
 * `platform/runtime_enabled_features.json5`, i.e. on by default, so a plain-text
 * run hitting any `\p{Emoji}` codepoint asks for the MONO emoji font.
 */
export function winFallbackPriorityForTextRun(cp: number): WinFallbackPriority {
  return RE_EMOJI.test(String.fromCodePoint(cp)) ? "emoji-text" : "text";
}

/** Test seam: drop the per-codepoint script memo. */
export function __clearWinScriptCacheForTest(): void {
  _scriptCache.clear();
}
