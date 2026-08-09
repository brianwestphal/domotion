// Per-script generic-family resolution for the capture session.
//
// Blink keys EVERY settings-mapped generic on the run's content script:
// `FontSelector::FamilyNameFromSettings` reads `font_description.GetScript()`
// and consults `settings.<Generic>(script)` (`platform/fonts/
// font_selector.cc:72-91`, rev 7d859f27). The script comes from the element's
// computed locale: `FontDescription::GetScript()` returns
// `LayoutLocale::GetScript()` (`font_description.h:302`), which is
// `LocaleToScriptCodeForFontSelection(locale)` computed at LayoutLocale
// construction (`platform/text/layout_locale.cc:280`). A missing per-script
// entry falls back to the `USCRIPT_COMMON` entry
// (`generic_font_family_settings.cc:105-107`), and a value that is a
// leading-comma list resolves through `FontCache::FirstAvailableOrFirst`
// (`generic_font_family_settings.cc:88-104` → `ui/gfx/font_list.cc:246-  `:
// split on ",", drop empties, first family the font manager has, else the
// first listed).
//
// The per-script VALUES in the capture session are PLAYWRIGHT's: it applies
// its vendored table — including `forScripts` entries on mac and win, none on
// linux — to every non-headful page via CDP `Page.setFontFamilies`
// (`playwright-core/lib/server/chromium/crPage.js:436-437,814-816` +
// `defaultFontFamilies.js`, playwright-core 1.59.1). The browser converts the
// table's ISO 15924 script keys ("jpan", "hang", …) to the same UScriptCode
// space via `ScriptNameToCode` (`platform/text/
// locale_to_script_mapping.cc:43-162`, whose own header comment says the
// aliasing — e.g. "jpan"/"hira"/"kana"/"hrkt" all to
// USCRIPT_KATAKANA_OR_HIRAGANA — exists precisely "for assigning a per-script
// font in Settings"). The browser-side application site (web_view_impl.cc) is
// outside the sparse checkout, so the composed behavior is additionally
// pinned by measurement in the harness's own launch path on macOS:
// `<span lang="ja">` + `font-family: serif` paints Hiragino Mincho ProN,
// ja+sans-serif Hiragino Kaku Gothic ProN, ko standard Apple SD Gothic Neo,
// zh-Hans serif Songti SC — Playwright's mac `forScripts` rows verbatim.
//
// Both Blink tables below are TRANSCRIBED IN FULL (mechanically extracted
// from the checkout at rev 7d859f27), not sampled: the walk in
// `LocaleToScriptCodeForFontSelection` terminates on the FIRST whole-tag
// match or valid 4ALPHA script subtag, so a partial table would mis-walk
// tags like "ru-Latn" (Latin — the script subtag wins over the language row)
// or "hi" (Devanagari — a real match that must stop the walk, not fall
// through to some shorter tag).
//
// `math` never appears here: Playwright's table carries no math key on any
// platform, so the `WebPreferences` constructor's Common-script value is the
// live one (see the math note in `matchFamilyNameToKey`).
//
// Linux deliberately has no entry: Playwright's linux table has no
// `forScripts`, and the DM-2036 container probe confirmed generics do not
// move with lang there — so on Linux the content script must never move a
// generic's family, which this module guarantees by construction (the
// platform lookup misses).

/** UScriptCode names (sans the USCRIPT_ prefix) — only used as opaque keys. */
type ScriptCode = string;

/** `ScriptNameToCode` (`locale_to_script_mapping.cc:43-162`, rev 7d859f27),
 *  transcribed in full. Keys are lower-case ISO 15924 names; values are the
 *  UScriptCode the browser files the per-script setting under. A name absent
 *  here is USCRIPT_INVALID_CODE (the locale walk keeps stripping); "zzzz"
 *  (UNKNOWN) is present but the walk treats it like a miss. */
const SCRIPT_NAME_TO_CODE: ReadonlyMap<string, ScriptCode> = new Map(Object.entries({
  "zyyy": "COMMON", "qaai": "INHERITED", "arab": "ARABIC", "armn": "ARMENIAN",
  "beng": "BENGALI", "bopo": "BOPOMOFO", "cher": "CHEROKEE", "copt": "COPTIC",
  "cyrl": "CYRILLIC", "dsrt": "DESERET", "deva": "DEVANAGARI", "ethi": "ETHIOPIC",
  "geor": "GEORGIAN", "goth": "GOTHIC", "grek": "GREEK", "gujr": "GUJARATI",
  "guru": "GURMUKHI", "hani": "HAN", "hang": "HANGUL", "hebr": "HEBREW",
  "hira": "KATAKANA_OR_HIRAGANA", "knda": "KANNADA", "kana": "KATAKANA_OR_HIRAGANA",
  "khmr": "KHMER", "laoo": "LAO", "latn": "LATIN", "mlym": "MALAYALAM",
  "mong": "MONGOLIAN", "mymr": "MYANMAR", "ogam": "OGHAM", "ital": "OLD_ITALIC",
  "orya": "ORIYA", "runr": "RUNIC", "sinh": "SINHALA", "syrc": "SYRIAC",
  "taml": "TAMIL", "telu": "TELUGU", "thaa": "THAANA", "thai": "THAI",
  "tibt": "TIBETAN", "cans": "CANADIAN_ABORIGINAL", "yiii": "YI", "tglg": "TAGALOG",
  "hano": "HANUNOO", "buhd": "BUHID", "tagb": "TAGBANWA", "brai": "BRAILLE",
  "cprt": "CYPRIOT", "limb": "LIMBU", "linb": "LINEAR_B", "osma": "OSMANYA",
  "shaw": "SHAVIAN", "tale": "TAI_LE", "ugar": "UGARITIC",
  "hrkt": "KATAKANA_OR_HIRAGANA", "bugi": "BUGINESE", "glag": "GLAGOLITIC",
  "khar": "KHAROSHTHI", "sylo": "SYLOTI_NAGRI", "talu": "NEW_TAI_LUE",
  "tfng": "TIFINAGH", "xpeo": "OLD_PERSIAN", "bali": "BALINESE", "batk": "BATAK",
  "blis": "BLISSYMBOLS", "brah": "BRAHMI", "cham": "CHAM", "cirt": "CIRTH",
  "cyrs": "OLD_CHURCH_SLAVONIC_CYRILLIC", "egyd": "DEMOTIC_EGYPTIAN",
  "egyh": "HIERATIC_EGYPTIAN", "egyp": "EGYPTIAN_HIEROGLYPHS", "geok": "KHUTSURI",
  "hans": "SIMPLIFIED_HAN", "hant": "TRADITIONAL_HAN", "hmng": "PAHAWH_HMONG",
  "hung": "OLD_HUNGARIAN", "inds": "HARAPPAN_INDUS", "java": "JAVANESE",
  "kali": "KAYAH_LI", "latf": "LATIN_FRAKTUR", "latg": "LATIN_GAELIC",
  "lepc": "LEPCHA", "lina": "LINEAR_A", "mand": "MANDAEAN",
  "maya": "MAYAN_HIEROGLYPHS", "mero": "MEROITIC", "nkoo": "NKO",
  "orkh": "ORKHON", "perm": "OLD_PERMIC", "phag": "PHAGS_PA", "phnx": "PHOENICIAN",
  "plrd": "PHONETIC_POLLARD", "roro": "RONGORONGO", "sara": "SARATI",
  "syre": "ESTRANGELO_SYRIAC", "syrj": "WESTERN_SYRIAC", "syrn": "EASTERN_SYRIAC",
  "teng": "TENGWAR", "vaii": "VAI", "visp": "VISIBLE_SPEECH", "xsux": "CUNEIFORM",
  "jpan": "KATAKANA_OR_HIRAGANA", "kore": "HANGUL",
  "zxxx": "UNWRITTEN_LANGUAGES", "zzzz": "UNKNOWN",
}));

/** `kLocaleScriptList` (`locale_to_script_mapping.cc:165-441`, rev 7d859f27),
 *  transcribed in full — a whole-tag match on ANY row terminates the walk
 *  with that row's script, so the Latin/Devanagari/… rows are load-bearing
 *  even though only seven scripts have per-script settings entries. */
const LOCALE_TO_SCRIPT: ReadonlyMap<string, ScriptCode> = new Map(Object.entries({
  "aa": "LATIN", "ab": "CYRILLIC", "ady": "CYRILLIC", "aeb": "ARABIC",
  "af": "LATIN", "ak": "LATIN", "am": "ETHIOPIC", "ar": "ARABIC",
  "arq": "ARABIC", "ary": "ARABIC", "arz": "ARABIC", "as": "BENGALI",
  "ast": "LATIN", "av": "CYRILLIC", "ay": "LATIN", "az": "LATIN",
  "azb": "ARABIC", "ba": "CYRILLIC", "bal": "ARABIC", "be": "CYRILLIC",
  "bej": "ARABIC", "bg": "CYRILLIC", "bi": "LATIN", "bn": "BENGALI",
  "bo": "TIBETAN", "bqi": "ARABIC", "brh": "ARABIC", "bs": "LATIN",
  "ca": "LATIN", "ce": "CYRILLIC", "ceb": "LATIN", "ch": "LATIN",
  "chk": "LATIN", "cja": "ARABIC", "cjm": "ARABIC", "ckb": "ARABIC",
  "cs": "LATIN", "cy": "LATIN", "da": "LATIN", "dcc": "ARABIC",
  "de": "LATIN", "doi": "ARABIC", "dv": "THAANA", "dyo": "ARABIC",
  "dz": "TIBETAN", "ee": "LATIN", "efi": "LATIN", "el": "GREEK",
  "en": "LATIN", "es": "LATIN", "et": "LATIN", "eu": "LATIN",
  "fa": "ARABIC", "fi": "LATIN", "fil": "LATIN", "fj": "LATIN",
  "fo": "LATIN", "fr": "LATIN", "fur": "LATIN", "fy": "LATIN",
  "ga": "LATIN", "gaa": "LATIN", "gba": "ARABIC", "gbz": "ARABIC",
  "gd": "LATIN", "gil": "LATIN", "gl": "LATIN", "gjk": "ARABIC",
  "gju": "ARABIC", "glk": "ARABIC", "gn": "LATIN", "gsw": "LATIN",
  "gu": "GUJARATI", "ha": "LATIN", "haw": "LATIN", "haz": "ARABIC",
  "he": "HEBREW", "hi": "DEVANAGARI", "hil": "LATIN", "hnd": "ARABIC",
  "hno": "ARABIC", "ho": "LATIN", "hr": "LATIN", "ht": "LATIN",
  "hu": "LATIN", "hy": "ARMENIAN", "id": "LATIN", "ig": "LATIN",
  "ii": "YI", "ilo": "LATIN", "inh": "CYRILLIC", "is": "LATIN",
  "it": "LATIN", "iu": "CANADIAN_ABORIGINAL", "ja": "KATAKANA_OR_HIRAGANA",
  "jv": "LATIN", "ka": "GEORGIAN", "kaj": "LATIN", "kam": "LATIN",
  "kbd": "CYRILLIC", "kha": "LATIN", "khw": "ARABIC", "kk": "CYRILLIC",
  "kl": "LATIN", "km": "KHMER", "kn": "KANNADA", "ko": "HANGUL",
  "kok": "DEVANAGARI", "kos": "LATIN", "kpe": "LATIN", "krc": "CYRILLIC",
  "ks": "ARABIC", "ku": "ARABIC", "kum": "CYRILLIC", "kvx": "ARABIC",
  "kxp": "ARABIC", "ky": "CYRILLIC", "la": "LATIN", "lah": "ARABIC",
  "lb": "LATIN", "lez": "CYRILLIC", "lki": "ARABIC", "ln": "LATIN",
  "lo": "LAO", "lrc": "ARABIC", "lt": "LATIN", "luz": "ARABIC",
  "lv": "LATIN", "mai": "DEVANAGARI", "mdf": "CYRILLIC", "mfa": "ARABIC",
  "mg": "LATIN", "mh": "LATIN", "mi": "LATIN", "mk": "CYRILLIC",
  "ml": "MALAYALAM", "mn": "CYRILLIC", "mr": "DEVANAGARI", "ms": "LATIN",
  "mt": "LATIN", "mvy": "ARABIC", "my": "MYANMAR", "myv": "CYRILLIC",
  "mzn": "ARABIC", "na": "LATIN", "nb": "LATIN", "ne": "DEVANAGARI",
  "niu": "LATIN", "nl": "LATIN", "nn": "LATIN", "nr": "LATIN",
  "nso": "LATIN", "ny": "LATIN", "oc": "LATIN", "om": "LATIN",
  "or": "ORIYA", "os": "CYRILLIC", "pa": "GURMUKHI", "pag": "LATIN",
  "pap": "LATIN", "pau": "LATIN", "pl": "LATIN", "pon": "LATIN",
  "prd": "ARABIC", "prs": "ARABIC", "ps": "ARABIC", "pt": "LATIN",
  "qu": "LATIN", "rm": "LATIN", "rmt": "ARABIC", "rn": "LATIN",
  "ro": "LATIN", "ru": "CYRILLIC", "rw": "LATIN", "sa": "DEVANAGARI",
  "sah": "CYRILLIC", "sat": "LATIN", "sd": "ARABIC", "sdh": "ARABIC",
  "se": "LATIN", "sg": "LATIN", "shi": "ARABIC", "si": "SINHALA",
  "sid": "LATIN", "sk": "LATIN", "skr": "ARABIC", "sl": "LATIN",
  "sm": "LATIN", "so": "LATIN", "sq": "LATIN", "sr": "CYRILLIC",
  "ss": "LATIN", "st": "LATIN", "su": "LATIN", "sus": "ARABIC",
  "sv": "LATIN", "sw": "LATIN", "swb": "ARABIC", "syr": "ARABIC",
  "ta": "TAMIL", "te": "TELUGU", "tet": "LATIN", "tg": "CYRILLIC",
  "th": "THAI", "ti": "ETHIOPIC", "tig": "ETHIOPIC", "tk": "LATIN",
  "tkl": "LATIN", "tl": "LATIN", "tn": "LATIN", "to": "LATIN",
  "tpi": "LATIN", "tr": "LATIN", "trv": "LATIN", "ts": "LATIN",
  "tt": "CYRILLIC", "ttt": "ARABIC", "tvl": "LATIN", "tw": "LATIN",
  "ty": "LATIN", "tyv": "CYRILLIC", "udm": "CYRILLIC", "ug": "ARABIC",
  "uk": "CYRILLIC", "und": "LATIN", "ur": "ARABIC", "uz": "CYRILLIC",
  "ve": "LATIN", "vi": "LATIN", "wal": "ETHIOPIC", "war": "LATIN",
  "wo": "LATIN", "xh": "LATIN", "yap": "LATIN", "yo": "LATIN",
  "za": "LATIN", "zdj": "ARABIC", "zh": "SIMPLIFIED_HAN", "zu": "LATIN",
  "cdo": "SIMPLIFIED_HAN", "cjy": "SIMPLIFIED_HAN", "cmn": "SIMPLIFIED_HAN",
  "cpx": "SIMPLIFIED_HAN", "czh": "SIMPLIFIED_HAN", "czo": "SIMPLIFIED_HAN",
  "gan": "SIMPLIFIED_HAN", "hsn": "SIMPLIFIED_HAN", "mnp": "SIMPLIFIED_HAN",
  "wuu": "SIMPLIFIED_HAN", "hak": "TRADITIONAL_HAN", "lzh": "TRADITIONAL_HAN",
  "nan": "TRADITIONAL_HAN", "yue": "TRADITIONAL_HAN",
  "zh-cdo": "SIMPLIFIED_HAN", "zh-cjy": "SIMPLIFIED_HAN", "zh-cmn": "SIMPLIFIED_HAN",
  "zh-cpx": "SIMPLIFIED_HAN", "zh-czh": "SIMPLIFIED_HAN", "zh-czo": "SIMPLIFIED_HAN",
  "zh-gan": "SIMPLIFIED_HAN", "zh-hsn": "SIMPLIFIED_HAN", "zh-mnp": "SIMPLIFIED_HAN",
  "zh-wuu": "SIMPLIFIED_HAN", "zh-hak": "TRADITIONAL_HAN", "zh-lzh": "TRADITIONAL_HAN",
  "zh-nan": "TRADITIONAL_HAN", "zh-yue": "TRADITIONAL_HAN",
  "zh-hk": "TRADITIONAL_HAN", "zh-mo": "TRADITIONAL_HAN", "zh-tw": "TRADITIONAL_HAN",
}));

/**
 * `LocaleToScriptCodeForFontSelection` (`locale_to_script_mapping.cc:164-470`,
 * rev 7d859f27), transcribed: canonicalize '_' to '-', then repeatedly (1)
 * whole-tag match against the locale table — a hit RETURNS its script; (2)
 * strip the last '-'-subtag, and when the stripped subtag is exactly 4
 * letters, look it up as a script name — a valid, non-UNKNOWN hit RETURNS.
 * Exhausted → USCRIPT_COMMON.
 */
/** `ScriptNameToCode` lookup for an ISO 15924 name (lower-cased), or null for
 *  a name Blink returns USCRIPT_INVALID_CODE for. Exported for the
 *  drift-guard test, which converts Playwright's `forScripts` keys the same
 *  way the browser does. */
export function scriptNameToCode(name: string): ScriptCode | null {
  return SCRIPT_NAME_TO_CODE.get(name.toLowerCase()) ?? null;
}

export function localeToScriptCodeForFontSelection(locale: string): ScriptCode {
  let tag = locale.replace(/_/g, "-").toLowerCase();
  while (tag !== "") {
    const hit = LOCALE_TO_SCRIPT.get(tag);
    if (hit != null) return hit;
    const pos = tag.lastIndexOf("-");
    if (pos === -1) break;
    const sub = tag.slice(pos + 1);
    if (sub.length === 4) {
      const code = SCRIPT_NAME_TO_CODE.get(sub);
      if (code != null && code !== "UNKNOWN") return code;
    }
    tag = tag.slice(0, pos);
  }
  return "COMMON";
}

/** The settings field each CSS generic keyword consults
 *  (`FamilyNameFromSettings`, `font_selector.cc:73-91`, rev 7d859f27),
 *  named as Playwright's `FontFamilies` JSON keys. */
const GENERIC_TO_SETTING: ReadonlyMap<string, PlaywrightSettingKey> = new Map([
  ["serif", "serif"],
  ["sans-serif", "sansSerif"],
  ["monospace", "fixed"],
  ["cursive", "cursive"],
  ["fantasy", "fantasy"],
  ["-webkit-standard", "standard"],
  ["-webkit-body", "standard"],
]);
type PlaywrightSettingKey = "standard" | "fixed" | "serif" | "sansSerif" | "cursive" | "fantasy";

type PerScriptFamilies = ReadonlyMap<ScriptCode, Partial<Record<PlaywrightSettingKey, string>>>;

/**
 * Playwright's `forScripts` tables (`defaultFontFamilies.js`, playwright-core
 * 1.59.1), keyed by the UScriptCode the browser converts each ISO 15924 key
 * to via `ScriptNameToCode` — "jpan" → KATAKANA_OR_HIRAGANA, "hang" → HANGUL,
 * "hans"/"hant" → SIMPLIFIED/TRADITIONAL_HAN, "cyrl"/"arab"/"grek" on win.
 * `src/render/generic-script-families.test.ts` pins this transcription
 * against the INSTALLED playwright-core's file, so a Playwright upgrade that
 * changes the table fails the suite instead of silently drifting.
 *
 * Leading-comma values are first-available lists (see
 * `firstAvailableOrFirst`). The mac jpan `fixed` value is already
 * "Osaka-Mono", so `GenericFontFamilySettings::Fixed`'s macOS Osaka →
 * Osaka-Mono special case (`generic_font_family_settings.cc:147-158`) is
 * inert for it.
 */
export const PLAYWRIGHT_PER_SCRIPT_FAMILIES: Partial<Record<string, PerScriptFamilies>> = {
  darwin: new Map<ScriptCode, Partial<Record<PlaywrightSettingKey, string>>>([
    ["KATAKANA_OR_HIRAGANA", { // "jpan"
      standard: "Hiragino Kaku Gothic ProN",
      fixed: "Osaka-Mono",
      serif: "Hiragino Mincho ProN",
      sansSerif: "Hiragino Kaku Gothic ProN",
    }],
    ["HANGUL", { // "hang"
      standard: "Apple SD Gothic Neo",
      serif: "AppleMyungjo",
      sansSerif: "Apple SD Gothic Neo",
    }],
    ["SIMPLIFIED_HAN", { // "hans"
      standard: ",PingFang SC,STHeiti",
      serif: "Songti SC",
      sansSerif: ",PingFang SC,STHeiti",
      cursive: "Kaiti SC",
    }],
    ["TRADITIONAL_HAN", { // "hant"
      standard: ",PingFang TC,Heiti TC",
      serif: "Songti TC",
      sansSerif: ",PingFang TC,Heiti TC",
      cursive: "Kaiti TC",
    }],
  ]),
  win32: new Map<ScriptCode, Partial<Record<PlaywrightSettingKey, string>>>([
    ["CYRILLIC", { // "cyrl"
      standard: "Times New Roman",
      fixed: "Courier New",
      serif: "Times New Roman",
      sansSerif: "Arial",
    }],
    ["ARABIC", { // "arab"
      fixed: "Courier New",
      sansSerif: "Segoe UI",
    }],
    ["GREEK", { // "grek"
      standard: "Times New Roman",
      fixed: "Courier New",
      serif: "Times New Roman",
      sansSerif: "Arial",
    }],
    ["KATAKANA_OR_HIRAGANA", { // "jpan"
      standard: ",Meiryo,Yu Gothic",
      fixed: "MS Gothic",
      serif: ",Yu Mincho,MS PMincho",
      sansSerif: ",Meiryo,Yu Gothic",
    }],
    ["HANGUL", { // "hang"
      standard: "Malgun Gothic",
      fixed: "Gulimche",
      serif: "Batang",
      sansSerif: "Malgun Gothic",
      cursive: "Gungsuh",
    }],
    ["SIMPLIFIED_HAN", { // "hans"
      standard: "Microsoft YaHei",
      fixed: "NSimsun",
      serif: "Simsun",
      sansSerif: "Microsoft YaHei",
      cursive: "KaiTi",
    }],
    ["TRADITIONAL_HAN", { // "hant"
      standard: "Microsoft JhengHei",
      fixed: "MingLiU",
      serif: "PMingLiU",
      sansSerif: "Microsoft JhengHei",
      cursive: "DFKai-SB",
    }],
  ]),
  // linux: intentionally absent — Playwright's linux table has no forScripts.
};

/**
 * The per-script settings VALUE for one generic keyword occurrence, or null
 * when the session's per-script maps carry no entry — in which case Blink
 * falls back to the `USCRIPT_COMMON` entry
 * (`generic_font_family_settings.cc:105-107`), i.e. the caller proceeds to
 * the Common-script generic routes. The value may be a leading-comma
 * first-available list; resolve it with `firstAvailableOrFirst`.
 */
export function perScriptGenericFamily(
  platform: string, lang: string, genericName: string,
): string | null {
  const table = PLAYWRIGHT_PER_SCRIPT_FAMILIES[platform];
  if (table == null) return null;
  const setting = GENERIC_TO_SETTING.get(genericName);
  if (setting == null) return null;
  const entry = table.get(localeToScriptCodeForFontSelection(lang));
  if (entry == null) return null;
  return entry[setting] ?? null;
}

/**
 * `FontCache::FirstAvailableOrFirst` (`platform/fonts/font_cache.cc:220-227`
 * → `ui/gfx/font_list.cc:246-`, rev 7d859f27): split on ",", trim, drop
 * empties; a single name returns as-is; otherwise the first family the host's
 * font system actually has, else the first listed.
 */
export function firstAvailableOrFirst(
  families: string, isAvailable: (family: string) => boolean,
): string {
  const list = families.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  for (const family of list) {
    if (isAvailable(family)) return family;
  }
  return list[0];
}
