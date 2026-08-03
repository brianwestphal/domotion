// The locale `IDWriteFontFallback::MapCharacters` is asked with, on Windows.
//
// It was a hardcoded `en-us` in the helper's analysis source while Blink
// resolves one per codepoint (`FallbackLocaleForCharacter(...)
// ->LocaleForSkFontMgr()`, `win/font_cache_skia_win.cc:228-240`, Chromium rev
// 7d859f27). That is the Han-unification trap: a unified ideograph legitimately
// resolves to a different face under `ja` than under `zh-Hans`, and a
// locale-blind query answers with DirectWrite's default preference order while
// reporting it as Chrome's pick — a failure that reads as a font-inventory
// problem rather than as a dropped argument.
//
// Two things are checked here, and they fail for different reasons:
//
//  1. The TAG. Blink's reduction is neither the raw CSS `lang` nor its primary
//     subtag: it keeps the script and drops the region. Skia says why at the
//     point it takes the tag (`SkFontMgr_win_dw.cpp:641-643`, rev ebf5052):
//     "DirectWrite supports 'zh-CN' or 'zh-Hans', but 'zh' misses completely and
//     may produce a Japanese font." A truncating implementation is therefore
//     indistinguishable from one that never plumbed the argument at all — which
//     is exactly how the first attempt at the Linux equivalent failed.
//
//  2. The MEMO KEY. The answer is a function of the locale, so a key blind to it
//     serves whichever language asked first to every later caller.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blinkWinFallbackLocale, hanScriptForLocale, localeForSkFontMgr,
} from "./win-font-fallback.js";
import {
  buildFallbackEnvelope, clearGlyphHelperCache, resolveSystemFallbackFonts,
} from "./glyph-helper.js";

/** The host's own locale, which is what `LocaleForHan` falls through to when the
 *  content locale disambiguates nothing. Tests that depend on it say so. */
const hostDisambiguatesHan = (): boolean => {
  try {
    return hanScriptForLocale(new Intl.DateTimeFormat().resolvedOptions().locale) != null;
  } catch {
    return false;
  }
};

describe("localeForSkFontMgr — LayoutLocale::LocaleForSkFontMgr (layout_locale.cc:178-196)", () => {
  it("maps the four CJK scripts to the tags ToSkFontMgrLocale names", () => {
    // `ToSkFontMgrLocale` (layout_locale.cc:163-176) answers for exactly these
    // four UScriptCodes and nothing else.
    expect(localeForSkFontMgr("ja")).toBe("ja");
    expect(localeForSkFontMgr("ko")).toBe("ko");
    expect(localeForSkFontMgr("zh")).toBe("zh-Hans");
    expect(localeForSkFontMgr("zh-TW")).toBe("zh-Hant");
  });

  it("keeps the SCRIPT and drops the region — the whole discriminating signal", () => {
    // `zh-CN` and `zh-TW` must not collapse together, and neither may collapse
    // to bare `zh`, which Skia's own comment says "misses completely and may
    // produce a Japanese font".
    expect(localeForSkFontMgr("zh-CN")).toBe("zh-Hans");
    expect(localeForSkFontMgr("zh-TW")).toBe("zh-Hant");
    expect(localeForSkFontMgr("zh-HK")).toBe("zh-Hant");
    expect(localeForSkFontMgr("zh-Hans-CN")).toBe("zh-Hans");
    expect(localeForSkFontMgr("zh-CN")).not.toBe(localeForSkFontMgr("zh-TW"));
    expect(localeForSkFontMgr("zh-CN")).not.toBe("zh");
  });

  it("reduces a non-CJK tag to language[-Script], the way icu::Locale does", () => {
    expect(localeForSkFontMgr("en-US")).toBe("en");
    expect(localeForSkFontMgr("de")).toBe("de");
    expect(localeForSkFontMgr("sr-Cyrl-RS")).toBe("sr-Cyrl");
    // Blink's own empty-language stand-in (`layout_locale.cc:190`), which is
    // what the two emoji locales are built on.
    expect(localeForSkFontMgr("und-Zsye")).toBe("und-Zsye");
    expect(localeForSkFontMgr("und-Zsym")).toBe("und-Zsym");
  });

  it("accepts ICU's underscore form and survives a malformed tag", () => {
    // "BCP 47 uses '-' as the delimiter but ICU uses '_'" — a tag arriving in
    // either form must reduce identically rather than throwing or widening the
    // query back to no locale.
    expect(localeForSkFontMgr("zh_TW")).toBe("zh-Hant");
    expect(localeForSkFontMgr("en_US")).toBe("en");
    expect(localeForSkFontMgr("!!!")).toBe("und");
  });
});

describe("localeForSkFontMgr — against Blink's OWN expectation table", () => {
  // `locale_test_data` from `platform/text/layout_locale_test.cc:60-131`
  // (Chromium rev 7d859f27), reduced to the `sk_font_mgr` column that
  // `LocaleForSkFontMgr` is asserted against there (`:159-160`). Copied row for
  // row rather than sampled: this is upstream's own definition of correct for
  // exactly the function being ported, so anything it covers that we get wrong
  // is a transcription error and not a judgement call.
  const ROWS: ReadonlyArray<readonly [string, string]> = [
    ["ja-JP", "ja"], ["ko-KR", "ko"],
    ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"], ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"], ["zh-SG", "zh-Hans"], ["zh-TW", "zh-Hant"],
    // Encompassed languages within the Chinese macrolanguage; "lang" and
    // "lang-extlang" both work.
    ["nan", "zh-Hant"], ["wuu", "zh-Hans"], ["yue", "zh-Hant"],
    ["zh-nan", "zh-Hant"], ["zh-wuu", "zh-Hans"], ["zh-yue", "zh-Hant"],
    // "Specified scripts is honored."
    ["zh-Hans", "zh-Hans"], ["zh-Hant", "zh-Hant"],
    // "Lowercase scripts should be capitalized."
    ["zh-hans", "zh-Hans"], ["zh-hant", "zh-Hant"],
    // "Script has priority over other subtags."
    ["en-Hans", "zh-Hans"], ["en-Hant", "zh-Hant"],
    ["en-Hans-TW", "zh-Hans"], ["en-Hant-CN", "zh-Hant"],
    ["en-TW-Hans", "zh-Hans"], ["en-CN-Hant", "zh-Hant"],
    ["wuu-Hant", "zh-Hant"], ["yue-Hans", "zh-Hans"],
    ["zh-wuu-Hant", "zh-Hant"], ["zh-yue-Hans", "zh-Hans"],
    // "Lang has priority over region."
    ["ja", "ja"], ["ja-US", "ja"], ["ko", "ko"], ["ko-US", "ko"],
    ["wuu-TW", "zh-Hans"], ["yue-CN", "zh-Hant"],
    ["zh-wuu-TW", "zh-Hans"], ["zh-yue-CN", "zh-Hant"],
    // "Region should not affect script" — these stay Latin, so the tag reduces
    // through ICU rather than through the CJK shortcut.
    ["en-CN", "en"], ["en-HK", "en"], ["en-MO", "en"], ["en-SG", "en"],
    ["en-TW", "en"], ["en-JP", "en"], ["en-KR", "en"],
    // "Multiple regions are invalid, but it can still give hints" — invalid
    // enough that `Intl.Locale` throws where ICU is lenient, so this row also
    // covers the hand reduction.
    ["en-US-JP", "en"],
  ];

  it.each(ROWS)("%s -> %s", (locale, expected) => {
    expect(localeForSkFontMgr(locale)).toBe(expected);
  });
});

describe("blinkWinFallbackLocale — FallbackLocaleForCharacter (font_cache_skia_win.cc:92-118)", () => {
  const HAN = 0x6f22; // U+6F22 漢, a unified ideograph — the whole point of the argument

  it("resolves ONE unified ideograph to three different tags under ja / zh-CN / zh-TW", () => {
    // The discrimination test. If these three ever agree, the argument is not
    // reaching DirectWrite in a form it can act on, and every downstream
    // "conformance stayed flat" reading is measuring nothing.
    const ja = blinkWinFallbackLocale(HAN, "ja-JP");
    const zhCn = blinkWinFallbackLocale(HAN, "zh-CN");
    const zhTw = blinkWinFallbackLocale(HAN, "zh-TW");
    expect([ja, zhCn, zhTw]).toEqual(["ja", "zh-Hans", "zh-Hant"]);
    expect(new Set([ja, zhCn, zhTw]).size).toBe(3);
  });

  it("takes the Han branch from the RAW script, not the block-inferred one", () => {
    // Blink calls `uscript_getScript(codepoint)` directly here, where the
    // hardcoded stage's `GetScript` infers a script for Common/Inherited. U+3001
    // IDEOGRAPHIC COMMA is Script=Common but sits in the CJK Symbols block, so
    // the two disagree on it — and this call site must follow the raw answer.
    expect(blinkWinFallbackLocale(0x3001, "ja-JP")).toBe("ja");
    // ...which for a Common codepoint means the ordinary content-locale branch
    // produced it, not the Han branch. `ko-KR` proves that: the Han branch would
    // answer `ko` too, so use a locale where the two branches differ.
    expect(blinkWinFallbackLocale(0x3001, "de-DE")).toBe("de");
    expect(blinkWinFallbackLocale(HAN, "de-DE")).not.toBe("de");
  });

  it("uses ScriptCodeForHanFromSubtags for a lang that only its region disambiguates", () => {
    // "Some sites emit lang='en-JP' when English is set as the preferred
    // language" (locale_to_script_mapping.cc:484-507).
    expect(blinkWinFallbackLocale(HAN, "en-JP")).toBe("ja");
    expect(blinkWinFallbackLocale(HAN, "en-TW")).toBe("zh-Hant");
  });

  it("falls back to Blink's kChineseSimplified LITERAL when nothing disambiguates", () => {
    // `static const char kChineseSimplified[] = "zh-Hant";`
    // (font_cache_skia_win.cc:153) — the identifier says Simplified and the
    // literal says Hant. We send the literal, because Chrome sends the literal.
    //
    // Only asserted on a host whose own locale disambiguates nothing, which is
    // the state every CI runner and the `LocaleForHan` null path are in.
    if (hostDisambiguatesHan()) return;
    expect(blinkWinFallbackLocale(HAN, "en-US")).toBe("zh-Hant");
    expect(blinkWinFallbackLocale(HAN, undefined)).toBe("zh-Hant");
  });

  it("short-circuits to the emoji locales before the script test", () => {
    // `kColorEmojiLocale` / `kMonoEmojiLocale` (`fonts/font_cache.cc:82-83`).
    // A plain-text run reaching an Emoji codepoint is promoted to kEmojiText
    // (`SystemFallbackEmojiVSSupport` is stable), so the default priority for
    // U+1F600 is the MONO tag, not the color one.
    expect(blinkWinFallbackLocale(0x1f600, "ja-JP")).toBe("und-Zsym");
    expect(blinkWinFallbackLocale(0x1f600, "ja-JP", "emoji-emoji")).toBe("und-Zsye");
    // ...and the branch wins over Han: an emoji-priority run never consults the
    // content locale at all.
    expect(blinkWinFallbackLocale(HAN, "zh-CN", "emoji-emoji")).toBe("und-Zsye");
  });
});

describe("the helper envelope", () => {
  it("carries the locale into the fallback query", () => {
    const env = buildFallbackEnvelope("Helvetica", [0x6f22], {
      weight: 400, italic: false, fontSize: 16, locale: "zh-Hant",
    }, "win32");
    expect(env.queries[0]).toMatchObject({ type: "fallback", locale: "zh-Hant" });
  });

  it("omits the field entirely when there is no locale to send", () => {
    // Absent must mean "the helper keeps its own default", not "an empty locale
    // name" — DirectWrite treats those differently, and an older Node side
    // against a newer helper has to degrade to the previous behavior.
    const env = buildFallbackEnvelope("Helvetica", [0x6f22], {
      weight: 400, italic: false, fontSize: 16,
    }, "win32");
    expect(env.queries[0]).not.toHaveProperty("locale");
    const empty = buildFallbackEnvelope("Helvetica", [0x6f22], {
      weight: 400, italic: false, fontSize: 16, locale: "",
    }, "win32");
    expect(empty.queries[0]).not.toHaveProperty("locale");
  });
});

// The memo key, driven through a fake helper that answers with the locale it was
// asked with. The real helper cannot demonstrate this: two locales may legitimately
// agree on a given host's font inventory, and an agreement is exactly what a blind
// key also produces.
describe("the per-codepoint fallback memo", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "domotion-fblocale-"));
    const p = join(dir, "fake-helper");
    writeFileSync(p, [
      "#!/usr/bin/env node",
      "function answer(req) {",
      "  const q = (req.queries && req.queries[0]) || {};",
      '  const loc = q.locale || "<none>";',
      "  const fonts = (q.cps || []).map((cp) => ({",
      "    cp, found: true,",
      "    postscriptName: `PS-${loc}`, familyName: `Fam-${loc}`, path: `/fake/${loc}.ttf`,",
      "  }));",
      '  return JSON.stringify({ results: [{ type: "fallback", fonts }] });',
      "}",
      'let buf = "";',
      'process.stdin.on("data", (c) => {',
      '  buf += c.toString("utf-8");',
      "  let i;",
      '  while ((i = buf.indexOf("\\n")) >= 0) {',
      "    const line = buf.slice(0, i);",
      "    buf = buf.slice(i + 1);",
      '    if (line.trim()) process.stdout.write(answer(JSON.parse(line)) + "\\n");',
      "  }",
      "});",
      'process.stdin.on("end", () => { if (buf.trim()) process.stdout.write(answer(JSON.parse(buf))); });',
    ].join("\n"));
    chmodSync(p, 0o755);
    process.env.DOMOTION_HELPER_PATH = p;
    clearGlyphHelperCache();
  });
  afterAll(() => {
    delete process.env.DOMOTION_HELPER_PATH;
    clearGlyphHelperCache();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => { clearGlyphHelperCache(); });

  const ask = (cp: number, locale?: string): string | null =>
    resolveSystemFallbackFonts([cp], "Helvetica", {
      weight: 400, italic: false, fontSize: 16, ...(locale != null ? { locale } : {}),
    }).get(cp)?.postscriptName ?? null;

  it("does not serve the first locale's answer to the next locale", () => {
    // The defect this guards is silent: on a multilingual page the second
    // language simply gets the first one's face, and the page still renders.
    const cp = 0x6f22;
    expect(ask(cp, "ja")).toBe("PS-ja");
    expect(ask(cp, "zh-Hans")).toBe("PS-zh-Hans");
    expect(ask(cp, "zh-Hant")).toBe("PS-zh-Hant");
    // ...and re-asking still hits the memo rather than drifting.
    expect(ask(cp, "ja")).toBe("PS-ja");
  });

  it("keeps a locale-bearing request distinct from a locale-less one", () => {
    // `undefined` is a third state, not a synonym for any tag: it means "the
    // helper's own default", which is a real locale on the DirectWrite side.
    const cp = 0x6f23;
    expect(ask(cp, undefined)).toBe("PS-<none>");
    expect(ask(cp, "ja")).toBe("PS-ja");
    expect(ask(cp, undefined)).toBe("PS-<none>");
  });
});
