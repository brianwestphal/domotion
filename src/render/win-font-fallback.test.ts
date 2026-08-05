import { afterEach, describe, expect, it } from "vitest";
import {
  HANS, HANT, HRKT, UNMAPPED_SCRIPT, ZSYM,
  WIN_MATH_FONTS, WIN_MONO_EMOJI_FONTS, WIN_COLOR_EMOJI_FONTS,
  WIN_PAN_UNICODE_CJK_FONTS, WIN_PAN_UNICODE_COMMON_FONTS,
  WIN_SCRIPT_FONT_FAMILIES,
  __clearWinScriptCacheForTest,
  blinkWinHardcodedFamilies, getFallbackFamily, getScript,
  getScriptBasedOnUnicodeBlock, hanScriptForLocale, uscriptGetScript,
  winFallbackPriorityForTextRun, winScriptCandidates,
} from "./win-font-fallback.js";

/**
 * The transcription of Blink's Windows hardcoded fallback stage
 * (`platform/fonts/win/font_fallback_win.cc` + `font_cache_skia_win.cc`,
 * Chromium rev `7d859f27`).
 *
 * Everything here is host-independent: `IsFontPresent` is injected, so the suite
 * can pose the question against a chosen font inventory instead of whatever the
 * machine happens to have. That is the point — the stage's answer is a function
 * of the inventory, and a test that could only ask one machine would be the same
 * mistake the sampled routing tables made.
 */

/**
 * A **measured** desktop Windows 11 inventory, not a guess: every family named
 * anywhere in Blink's Windows table (101 of them, including the plane-routing and
 * last-resort literals) asked through the win32 helper's DirectWrite
 * `FindFamilyName` — the same call Blink's `IsFontPresent` makes. 34 of the 101
 * exist on a default desktop install.
 *
 * Worth knowing what is NOT here, because each absence is what makes some Blink
 * row fall through: **David** (Hebrew supplemental pack), all eight Noto CJK
 * families, every third-party face in the Ethiopic / Lao / Myanmar / Syriac /
 * Tibetan lists, the legacy Indic faces the Nirmala UI rows supersede (Mangal,
 * Latha, Gautami, Tunga, Shruti, Raavi, Vrinda, Kartika), `code2001`,
 * `code2000`, `arial unicode ms`, and Chromium's truncated `pmingli`.
 *
 * Also note what the lowercase entries prove: `courier new`,
 * `lucida sans unicode`, `simsun-extb`, `simsun-extg`, `pmingliu-extb` all
 * resolve, so Blink's mixed-case literals are safe to pass through
 * case-insensitive Windows family matching verbatim.
 */
const MEASURED_WIN11 = new Set([
  "cambria math", "courier new", "ebrima", "gadugi", "javanese text",
  "leelawadee ui", "lucida sans unicode", "malgun gothic", "microsoft himalaya",
  "microsoft jhenghei", "microsoft new tai lue", "microsoft phagspa",
  "microsoft sans serif", "microsoft tai le", "microsoft yahei",
  "microsoft yi baiti", "mongolian baiti", "ms pgothic", "mv boli",
  "myanmar text", "nirmala ui", "palatino linotype", "pmingliu-extb",
  "segoe ui", "segoe ui emoji", "segoe ui historic", "segoe ui symbol",
  "simsun", "simsun-extb", "simsun-extg", "sylfaen", "tahoma",
  "times new roman", "yu gothic",
]);

/** The same host with the Hebrew supplemental pack, which brings David. This is
 *  the exact machine difference the probed table could not express. */
const WITH_HEBREW_PACK = new Set([...MEASURED_WIN11, "david"]);

const present = (inv: Set<string>) => (family: string) => inv.has(family.toLowerCase());
const stock = present(MEASURED_WIN11);
const nothing = () => false;
const everything = () => true;

afterEach(() => __clearWinScriptCacheForTest());

describe("InitializeScriptFontMap: the table itself", () => {
  it("carries all 74 script→font-list entries", () => {
    // `kScriptToFontFamilies` has exactly 74 rows (font_fallback_win.cc:235-309).
    expect(Object.keys(WIN_SCRIPT_FONT_FAMILIES).length).toBe(74);
  });

  it("reproduces the multi-slot lists verbatim, in Blink's order", () => {
    expect(WIN_SCRIPT_FONT_FAMILIES.Arabic).toEqual(["Tahoma", "Segoe UI"]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Hebrew).toEqual(["David", "Segoe UI"]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Thai).toEqual(["Tahoma", "Leelawadee UI", "Leelawadee"]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Devanagari).toEqual(["Nirmala UI", "Mangal"]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Hangul)
      .toEqual(["Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic", "Gulim"]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Ethiopic).toEqual([
      "Nyala", "Abyssinica SIL", "Ethiopia Jiret", "Visual Geez Unicode",
      "GF Zemen Unicode", "Ebrima",
    ]);
    expect(WIN_SCRIPT_FONT_FAMILIES[HANS])
      .toEqual(["Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "simsun"]);
    // `pmingli` is Chromium's own truncation of "pmingliu" — a transcription that
    // repaired it would stop being one.
    expect(WIN_SCRIPT_FONT_FAMILIES[HANT])
      .toEqual(["Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", "pmingli"]);
    expect(WIN_SCRIPT_FONT_FAMILIES[HRKT]).toEqual([
      "Noto Sans JP", "Noto Sans CJK JP", "Meiryo",
      "Yu Gothic", "MS PGothic", "Microsoft YaHei",
    ]);
  });

  it("shares the lists Blink shares", () => {
    // Hiragana / Katakana / Hrkt all point at kKatakanaOrHiraganaFonts; Bopomofo
    // shares the Traditional Han list; Meetei Mayek shares kSoraSompengFonts.
    expect(WIN_SCRIPT_FONT_FAMILIES.Hiragana).toBe(WIN_SCRIPT_FONT_FAMILIES.Katakana);
    expect(WIN_SCRIPT_FONT_FAMILIES.Katakana).toBe(WIN_SCRIPT_FONT_FAMILIES[HRKT]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Bopomofo).toBe(WIN_SCRIPT_FONT_FAMILIES[HANT]);
    expect(WIN_SCRIPT_FONT_FAMILIES.Meetei_Mayek).toBe(WIN_SCRIPT_FONT_FAMILIES.Sora_Sompeng);
  });

  it("keeps the emoji lists in their opposite preferences", () => {
    // The color list prefers Segoe UI Emoji; the mono list prefers Segoe UI Symbol
    // (font_fallback_win.cc:332-356). Collapsing them would silently change which
    // face a text-presentation emoji lands in.
    expect(WIN_COLOR_EMOJI_FONTS).toEqual(["Segoe UI Emoji", "Segoe UI Symbol"]);
    expect(WIN_MONO_EMOJI_FONTS).toEqual(["Segoe UI Symbol", "Segoe UI Emoji"]);
    expect(WIN_MATH_FONTS).toEqual(["Cambria Math", "Segoe UI Symbol", "Code2000"]);
  });

  it("keeps the two pan-Unicode probe lists distinct", () => {
    expect(WIN_PAN_UNICODE_CJK_FONTS[0]).toBe("arial unicode ms");
    expect(WIN_PAN_UNICODE_COMMON_FONTS[0]).toBe("tahoma");
    expect(WIN_PAN_UNICODE_CJK_FONTS).not.toEqual(WIN_PAN_UNICODE_COMMON_FONTS);
  });

  it("exposes USCRIPT_SYMBOLS even though no codepoint can reach it", () => {
    // `Zsym` is an ICU composite code `uscript_getScript` never returns and block
    // inference never produces — transcribed for completeness, and pinned so a
    // later reader doesn't "clean up" a row that Blink has.
    expect(WIN_SCRIPT_FONT_FAMILIES[ZSYM]).toEqual(["Segoe UI Symbol"]);
  });
});

describe("uscript_getScript / GetScript", () => {
  it("answers the UCD Script property", () => {
    expect(uscriptGetScript(0x0041)).toBe("Latin");
    expect(uscriptGetScript(0x0628)).toBe("Arabic");
    expect(uscriptGetScript(0x05D0)).toBe("Hebrew");
    expect(uscriptGetScript(0x4E00)).toBe("Han");
    expect(uscriptGetScript(0x3042)).toBe("Hiragana");
    expect(uscriptGetScript(0x30A2)).toBe("Katakana");
    expect(uscriptGetScript(0x10C00)).toBe("Old_Turkic"); // USCRIPT_ORKHON's alias
    expect(uscriptGetScript(0xABC0)).toBe("Meetei_Mayek");
  });

  it("reports Common / Inherited, which is what triggers block inference", () => {
    expect(uscriptGetScript(0x2211)).toBe("Common");    // ∑
    expect(uscriptGetScript(0x0300)).toBe("Inherited"); // combining grave
  });

  it("infers a script from the block for Common / Inherited codepoints", () => {
    // Character::GetScriptBasedOnUnicodeBlock (character.cc:321-351).
    expect(getScript(0x3001)).toBe("Han");   // CJK Symbols & Punctuation, Script=Common
    expect(getScript(0x30FC)).toBe(HRKT);    // Katakana block, Script=Common
    expect(getScript(0x0964)).toBe("Devanagari"); // Danda, Script=Common
    expect(getScript(0x0374)).toBe("Greek"); // Greek numeral sign, Script=Common
    expect(getScript(0x10341)).toBe("Gothic"); // Gothic block
  });

  it("leaves an un-inferable Common codepoint as Common", () => {
    expect(getScriptBasedOnUnicodeBlock(0x2211)).toBe("Common");
    expect(getScript(0x2211)).toBe("Common");
  });

  it("memoizes per codepoint without changing the answer", () => {
    // The cache is the one piece of state in the module; a stale or cross-wired
    // entry would silently re-route a whole script.
    const first = uscriptGetScript(0x0628);
    expect(uscriptGetScript(0x0628)).toBe(first);
    __clearWinScriptCacheForTest();
    expect(uscriptGetScript(0x0628)).toBe(first);
    // Interleave two codepoints that must not share an entry.
    expect(uscriptGetScript(0x0627)).toBe("Arabic");
    expect(uscriptGetScript(0x05D0)).toBe("Hebrew");
    expect(uscriptGetScript(0x0627)).toBe("Arabic");
  });
});

describe("GetFallbackFamily: stage order", () => {
  it("puts the color emoji font first for an emoji-presentation run", () => {
    expect(getFallbackFamily(0x1F600, { priority: "emoji-emoji" }, stock).family)
      .toBe("Segoe UI Emoji");
  });

  it("puts the MONO emoji font first for a text-presentation run", () => {
    expect(getFallbackFamily(0x1F600, { priority: "emoji-text" }, stock).family)
      .toBe("Segoe UI Symbol");
  });

  it("falls to the next emoji slot when the preferred one is absent", () => {
    const noEmojiFont = new Set(MEASURED_WIN11);
    noEmojiFont.delete("segoe ui emoji");
    expect(getFallbackFamily(0x1F600, { priority: "emoji-emoji" }, present(noEmojiFont)).family)
      .toBe("Segoe UI Symbol");
  });

  it("consults the unicode-block specials before the per-script table", () => {
    // Math blocks → FirstAvailableMathFont; symbol blocks → the Segoe UI Symbol
    // literal (font_fallback_win.cc:404-440). All of these are Script=Common, so
    // the script table would otherwise have nothing to say.
    for (const cp of [0x2190, 0x2211, 0x2300, 0x25A0, 0x27C0, 0x27F0, 0x2900,
      0x2980, 0x2A00, 0x1D400, 0x1EE00, 0x1F780]) {
      expect(getFallbackFamily(cp, {}, stock).family, `U+${cp.toString(16)}`)
        .toBe("Cambria Math");
    }
    for (const cp of [0x1F0A0, 0x2600, 0x2B00, 0x1F300, 0x1F680, 0x1F700, 0x2702, 0x10330]) {
      expect(getFallbackFamily(cp, {}, stock).family, `U+${cp.toString(16)}`)
        .toBe("Segoe UI Symbol");
    }
    // Emoticons / Enclosed Alphanumeric Supplement route through the MONO emoji
    // list even at plain-text priority.
    expect(getFallbackFamily(0x1F100, {}, stock).family).toBe("Segoe UI Symbol");
  });

  it("assigns USCRIPT_INVALID_CODE (null script) in the emoji + block stages", () => {
    // `script_out` selects the pan-Unicode probe list downstream, and the early
    // stages deliberately leave it invalid.
    expect(getFallbackFamily(0x2211, {}, stock).script).toBeNull();
    expect(getFallbackFamily(0x1F600, { priority: "emoji-text" }, stock).script).toBeNull();
    expect(getFallbackFamily(0x0628, {}, stock).script).toBe("Arabic");
  });

  it("routes full-width ASCII (U+FF01–U+FF5E) through the Han font", () => {
    // font_fallback_win.cc:529-534. U+FF00 and U+FF5F are excluded by the strict
    // comparison, which the transcription must not widen.
    expect(getFallbackFamily(0xFF01, {}, stock).family).toBe("Microsoft YaHei");
    expect(getFallbackFamily(0xFF5E, {}, stock).family).toBe("Microsoft YaHei");
    expect(getFallbackFamily(0xFF00, {}, stock).family).not.toBe("Microsoft YaHei");
    expect(getFallbackFamily(0xFF5F, {}, stock).family).not.toBe("Microsoft YaHei");
  });

  it("applies FindMonospaceFontForScript to Arabic and Hebrew only", () => {
    expect(getFallbackFamily(0x0628, { generic: "monospace" }, stock).family).toBe("courier new");
    expect(getFallbackFamily(0x05D0, { generic: "monospace" }, stock).family).toBe("courier new");
    // Any other script ignores the generic.
    expect(getFallbackFamily(0x0E01, { generic: "monospace" }, stock).family).toBe("Tahoma");
    expect(getFallbackFamily(0x0628, { generic: "standard" }, stock).family).toBe("Tahoma");
  });

  it("skips the per-script table entirely for non-BMP codepoints", () => {
    // "Limiting GetFontFamilyForScript() only to BMP" (font_fallback_win.cc:551-559)
    // — so a supplementary-plane script with a table entry still gets plane
    // routing, not its entry. Cuneiform's entry is Segoe UI Historic; U+12000 is
    // plane 1, so Blink answers code2001 instead.
    expect(WIN_SCRIPT_FONT_FAMILIES.Cuneiform).toEqual(["Segoe UI Historic"]);
    expect(getFallbackFamily(0x12000, {}, everything).family).toBe("code2001");
  });

  it("routes the supplementary planes exactly as GB18030-2022 requires", () => {
    expect(getFallbackFamily(0x1D2C0, {}, everything).family).toBe("code2001"); // plane 1
    expect(getFallbackFamily(0x20000, {}, everything).family).toBe("simsun-extb"); // plane 2
    expect(getFallbackFamily(0x2EBF0, {}, everything).family).toBe("simsun-extg"); // Ext I
    expect(getFallbackFamily(0x2EE5F, {}, everything).family).toBe("simsun-extg");
    expect(getFallbackFamily(0x2EBEF, {}, everything).family).toBe("simsun-extb"); // just below
    expect(getFallbackFamily(0x30000, {}, everything).family).toBe("simsun-extg"); // plane 3
    expect(getFallbackFamily(0x323AF, {}, everything).family).toBe("simsun-extg");
  });

  it("lands on lucida sans unicode when nothing else applies", () => {
    // A BMP codepoint whose script has no table entry (U+1700 is Script=Tagalog)
    // and whose block is not special — plane 0, so no plane routing either.
    expect(getScript(0x1700)).toBe(UNMAPPED_SCRIPT);
    expect(WIN_SCRIPT_FONT_FAMILIES.Tagalog).toBeUndefined();
    expect(winScriptCandidates(UNMAPPED_SCRIPT)).toBeNull();
    expect(getFallbackFamily(0x1700, {}, everything).family).toBe("lucida sans unicode");
  });

  it("falls past a script list whose every slot is missing", () => {
    // `FirstAvailableFont` returns null → `GetFontFamilyForScript` null → the
    // last resort. Not the script list's first slot regardless of installation.
    expect(getFallbackFamily(0x0628, {}, nothing).family).toBe("lucida sans unicode");
    expect(getFallbackFamily(0x0E01, {}, nothing).family).toBe("lucida sans unicode");
  });
});

describe("GetFallbackFamily: font inventory changes the answer", () => {
  it("prefers Noto CJK over the Microsoft faces when it is installed", () => {
    // The Hangul / Han / Japanese lists all lead with Noto. A host with Noto CJK
    // therefore gets a different face than a stock one — which is exactly why
    // baking an inventory into source is the defect being removed here.
    const withNoto = new Set([...MEASURED_WIN11, "noto sans kr", "noto sans sc", "noto sans jp"]);
    expect(getFallbackFamily(0xAC00, {}, stock).family).toBe("Malgun Gothic");
    expect(getFallbackFamily(0xAC00, {}, present(withNoto)).family).toBe("Noto Sans KR");
    expect(getFallbackFamily(0x4E00, {}, present(withNoto)).family).toBe("Noto Sans SC");
    expect(getFallbackFamily(0x3042, {}, present(withNoto)).family).toBe("Noto Sans JP");
  });

  it("walks the six-slot Ethiopic list to its last entry on a default host", () => {
    // Nyala and the four third-party faces ahead of Ebrima are all absent from the
    // measured inventory, so the list walks all the way to slot 6. A host with
    // Nyala (the Amharic supplemental pack) gets a different face.
    expect(getFallbackFamily(0x1208, {}, stock).family).toBe("Ebrima");
    const withNyala = new Set([...MEASURED_WIN11, "nyala"]);
    expect(getFallbackFamily(0x1208, {}, present(withNyala)).family).toBe("Nyala");
  });

  it("nominates David for Hebrew once the Hebrew pack is installed", () => {
    // The single sharpest illustration of why `IsFontPresent` must be ASKED. Blink
    // leads the Hebrew row with David; a default desktop Windows 11 does not have
    // it (measured), so the answer is Segoe UI — which is what the probed table
    // recorded, and it happened to agree only because the probe host lacked the
    // pack. Install the pack and the two answers diverge, with no font-set
    // explanation available from a frozen table.
    expect(getFallbackFamily(0x05D0, {}, stock).family).toBe("Segoe UI");
    expect(getFallbackFamily(0x05D0, {}, present(WITH_HEBREW_PACK)).family).toBe("David");
  });

  it("prefers Khmer OS over the Vista fonts, per Blink's own comment", () => {
    const withKhmerOs = new Set([...MEASURED_WIN11, "khmer os", "daunpenh"]);
    // Leelawadee UI leads the list on a stock host…
    expect(getFallbackFamily(0x1780, {}, stock).family).toBe("Leelawadee UI");
    // …and Khmer OS still sits ahead of DaunPenh when Leelawadee UI is gone.
    const noLeela = new Set(withKhmerOs);
    noLeela.delete("leelawadee ui");
    expect(getFallbackFamily(0x1780, {}, present(noLeela)).family).toBe("Khmer OS");
  });
});

describe("Han locale disambiguation", () => {
  it("reads the four unambiguous Han scripts out of a locale", () => {
    expect(hanScriptForLocale("ja")).toBe(HRKT);
    expect(hanScriptForLocale("ja-JP")).toBe(HRKT);
    expect(hanScriptForLocale("ko")).toBe("Hangul");
    expect(hanScriptForLocale("zh")).toBe(HANS);
    expect(hanScriptForLocale("zh-CN")).toBe(HANS);
    expect(hanScriptForLocale("zh-TW")).toBe(HANT);
    expect(hanScriptForLocale("zh-HK")).toBe(HANT);
    expect(hanScriptForLocale("yue")).toBe(HANT);
    expect(hanScriptForLocale("zh-Hant")).toBe(HANT);
    expect(hanScriptForLocale("zh-Hans")).toBe(HANS);
  });

  it("uses ICU's underscore delimiter as well as BCP 47's hyphen", () => {
    expect(hanScriptForLocale("zh_TW")).toBe(HANT);
  });

  it("mines a region subtag out of a non-Han language, per Blink's en-JP note", () => {
    // "Some sites emit lang='en-JP' when English is set as the preferred language."
    expect(hanScriptForLocale("en-JP")).toBe(HRKT);
    expect(hanScriptForLocale("en-TW")).toBe(HANT);
    expect(hanScriptForLocale("en-KR")).toBe("Hangul");
  });

  it("returns null for a locale that disambiguates nothing", () => {
    // Null is load-bearing: it is what leaves the script as USCRIPT_HAN, which in
    // turn selects the CJK pan-Unicode probe list.
    expect(hanScriptForLocale("en")).toBeNull();
    expect(hanScriptForLocale("en-US")).toBeNull();
    expect(hanScriptForLocale("de-DE")).toBeNull();
    expect(hanScriptForLocale(undefined)).toBeNull();
    expect(hanScriptForLocale("")).toBeNull();
  });

  it("routes Han to the lang-derived list when the content locale says so", () => {
    // Meiryo leads the Japanese list but is absent from the measured inventory, so
    // the walk lands on Yu Gothic.
    expect(getFallbackFamily(0x4E00, { lang: "ja" }, stock).family).toBe("Yu Gothic");
    expect(getFallbackFamily(0x4E00, { lang: "ko" }, stock).family).toBe("Malgun Gothic");
    expect(getFallbackFamily(0x4E00, { lang: "zh-TW" }, stock).family).toBe("Microsoft JhengHei");
    expect(getFallbackFamily(0x4E00, { lang: "zh-CN" }, stock).family).toBe("Microsoft YaHei");
  });

  it("fills the USCRIPT_HAN slot from the system locale", () => {
    // InitializeScriptFontMap copies GetSystem().GetScriptForHan()'s list into the
    // HAN slot, and that call reads GetScriptForHan() directly — so its
    // "Simplified Han if still ambiguous" default IS visible, which is why an
    // en-US host answers Han with the Simplified Han list.
    expect(winScriptCandidates("Han")).toEqual(WIN_SCRIPT_FONT_FAMILIES[HANS]);
  });
});

describe("GetFallbackFamilyNameFromHardcodedChoices: the candidate list", () => {
  it("emits exactly one script-table family, then the pan-Unicode probe list", () => {
    // Hebrew on a host WITH David: the first installed slot is David, and the
    // script list's SECOND slot (Segoe UI) must not appear — Blink goes to the
    // pan-Unicode list on a coverage miss, not to the next script slot.
    const chain = blinkWinHardcodedFamilies(0x05D0, {}, present(WITH_HEBREW_PACK));
    expect(chain[0]).toBe("David");
    expect(chain).not.toContain("Segoe UI");
    expect(chain.slice(1)).toEqual(WIN_PAN_UNICODE_COMMON_FONTS);
  });

  it("selects the CJK probe list only while the script is still unified Han", () => {
    // No locale disambiguates → script stays Han → kCjkFonts.
    const han = blinkWinHardcodedFamilies(0x4E00, {}, stock);
    expect(han[0]).toBe("Microsoft YaHei");
    expect(han).toContain("wenquanyi zen hei"); // CJK-list marker
    expect(han).not.toContain("palatino linotype"); // common-list marker
    // A locale that disambiguates replaces the script → kCommonFonts.
    const ja = blinkWinHardcodedFamilies(0x4E00, { lang: "ja" }, stock);
    expect(ja[0]).toBe("Yu Gothic");
    expect(ja).toContain("palatino linotype");
    expect(ja).not.toContain("wenquanyi zen hei");
  });

  it("does not repeat the nominated family inside the probe list", () => {
    // Thai nominates Tahoma, which also heads kCommonFonts. Re-probing it would
    // get the same non-covering answer, so it appears once.
    const thai = blinkWinHardcodedFamilies(0x0E01, {}, stock);
    expect(thai[0]).toBe("Tahoma");
    expect(thai.filter((f) => f.toLowerCase() === "tahoma").length).toBe(1);
  });

  it("still yields a list when nothing at all is installed", () => {
    // GetFallbackFamily never returns null; the caller's coverage check is what
    // discards a family. So the list is the last resort plus the probe list.
    expect(blinkWinHardcodedFamilies(0x0628, {}, nothing)[0]).toBe("lucida sans unicode");
  });
});

describe("FontFallbackPriority for a plain-text run", () => {
  it("escalates any Emoji codepoint to text-presentation emoji", () => {
    // SystemFallbackEmojiVSSupport is status:"stable" in
    // runtime_enabled_features.json5, so this branch is on by default.
    expect(winFallbackPriorityForTextRun(0x1F600)).toBe("emoji-text");
    expect(winFallbackPriorityForTextRun(0x2600)).toBe("emoji-text"); // ☀ has Emoji=Yes
    expect(winFallbackPriorityForTextRun(0x0023)).toBe("emoji-text"); // # keycap base
  });

  it("leaves a non-emoji codepoint at plain text", () => {
    expect(winFallbackPriorityForTextRun(0x0041)).toBe("text");
    expect(winFallbackPriorityForTextRun(0x4E00)).toBe("text");
    expect(winFallbackPriorityForTextRun(0x2211)).toBe("text");
  });

  it("means an emoji codepoint bypasses the unicode-block stage", () => {
    // U+1F0A0 PLAYING CARD BACK is in the Playing Cards block (→ the Segoe UI
    // Symbol literal) but is not Emoji, so it takes the block route; U+1F3B4
    // PLAYING CARD is Emoji, so the priority escalation answers first. Both land
    // on Segoe UI Symbol on a stock host, but through different stages — and the
    // stages diverge as soon as Segoe UI Symbol is absent.
    const noSymbol = new Set(MEASURED_WIN11);
    noSymbol.delete("segoe ui symbol");
    expect(winFallbackPriorityForTextRun(0x1F0A0)).toBe("text");
    expect(getFallbackFamily(0x1F0A0, { priority: "text" }, present(noSymbol)).family)
      .toBe("Segoe UI Symbol"); // the block stage returns the literal unconditionally
    expect(winFallbackPriorityForTextRun(0x1F3B4)).toBe("emoji-text");
    expect(getFallbackFamily(0x1F3B4, { priority: "emoji-text" }, present(noSymbol)).family)
      .toBe("Segoe UI Emoji"); // FirstAvailableFont walks to the second slot
  });
});

/**
 * The `kText → kEmojiText` promotion is GUARDED on the priority already being
 * `kText`, and applying it unconditionally inverts the emoji-presentation set
 * (DM-1985).
 *
 * `winFallbackPriorityForTextRun` transcribes only the promotion — its name says
 * "ForTextRun" — so the guard has to live at the call site, which is
 * `win32FallbackChain` in `font-resolution.ts`. It did not, and every
 * emoji-presentation codepoint took the mono arm: measured against Chrome on the
 * Windows VM, 😀 🚀 ⭐ and U+1F46A all resolved Segoe UI Symbol where Chrome
 * paints Segoe UI Emoji. Fixing it took the `font-variant-emoji` probe from
 * 31/39 to 35/39 agreeing.
 *
 * These cases pin the promotion itself; the guard is covered by the resolver
 * tests, which is where it lives.
 */
describe("winFallbackPriorityForTextRun promotes only what Blink promotes (DM-1985)", () => {
  it("promotes an emoji codepoint reached as plain text", () => {
    // U+00A9 © is `\p{Emoji}` with TEXT presentation by default, so a text run
    // containing it is exactly the case the promotion exists for.
    expect(winFallbackPriorityForTextRun(0x00a9)).toBe("emoji-text");
    expect(winFallbackPriorityForTextRun(0x2122)).toBe("emoji-text");
  });

  it("leaves a non-emoji codepoint as text", () => {
    // The control: a promotion that fired for everything would satisfy the
    // assertion above.
    expect(winFallbackPriorityForTextRun(0x0041)).toBe("text");
    expect(winFallbackPriorityForTextRun(0x4e00)).toBe("text");
  });

  it("says emoji-text for a LONE regional indicator", () => {
    // Not emoji-presentation (Blink's segmenter returns REGIONAL_INDICATOR
    // before it reaches the emoji-presentation arm), so it arrives as kText and
    // IS promoted — and Chrome agrees: it answers Segoe UI Symbol for U+1F1FA.
    expect(winFallbackPriorityForTextRun(0x1f1fa)).toBe("emoji-text");
  });
});
