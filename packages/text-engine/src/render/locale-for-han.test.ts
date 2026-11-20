// `LayoutLocale::LocaleForHan(content_locale)` (platform/text/layout_locale.cc:
// 226-257, Chromium 7d859f27) and the two Windows call sites that consume it:
// `FallbackLocaleForCharacter` (win/font_cache_skia_win.cc:92-121) and
// `GetFallbackFamily` (win/font_fallback_win.cc:540-546).
//
// Steps 1-3 (content locale, first disambiguating accept-language, default
// locale) are a pure function of renderer state the capture authenticates;
// step 4 (`GetSystem()`, ICU's default) is the host's. The scoped context
// carries the steps-1-3 answer from the run's options to both call sites.
import { describe, expect, it } from "vitest";
import {
  HANS,
  HANT,
  HRKT,
  blinkWinFallbackLocale,
  fontLocaleForHanIdentity,
  getFallbackFamily,
  hanScriptForLocale,
  layoutLocaleForHan,
  withFontLocaleForHan,
} from "./win-font-fallback.js";

const HAN = 0x6f22; // 漢, Script=Han
const FULLWIDTH_A = 0xff21; // routed through the Han script by GetFallbackFamily

/** Host ICU decides step 4; assertions that reach it say so. */
const hostDisambiguatesHan = (): boolean => {
  try {
    return hanScriptForLocale(new Intl.DateTimeFormat().resolvedOptions().locale) != null;
  } catch {
    return false;
  }
};

/** The measured families the CJK script lists resolve to on stock Windows 11. */
const stock = (family: string): boolean =>
  ["Yu Gothic", "Malgun Gothic", "Microsoft JhengHei", "Microsoft YaHei", "SimSun"].includes(family);

describe("layoutLocaleForHan — steps 1-3 of LocaleForHan", () => {
  // [content locale, accept-languages, default locale, expected]
  const table: Array<[string | null, string, string, string | null, string]> = [
    // Step 1: a disambiguating content locale wins over everything.
    ["ja", "zh-TW", "ko", "ja", "content locale has a Han script"],
    ["en-JP", "zh-TW", "ko", "en-JP", "content disambiguates through its region subtag"],
    // Step 2: null (`auto`) or non-Han content consults accept-languages next.
    [null, "ja", "en-US", "ja", "auto: accept-language precedes the default"],
    [null, "ja", "zh-TW", "ja", "auto: accept-language beats a Han-disambiguating default"],
    ["en", "ja", "en-US", "ja", "explicit non-Han content still reaches accept-languages"],
    [null, "en-US,de,zh-TW,ja", "en-US", "zh-TW", "the FIRST disambiguating token, not the first token"],
    [null, " en , ko ", "en-US", "ko", "tokens are whitespace-stripped"],
    [null, ",, ,ja", "en-US", "ja", "empty and whitespace-only tokens are skipped"],
    // Step 3: the default locale.
    [null, "", "zh-TW", "zh-TW", "auto: no accept-languages, default disambiguates"],
    ["en", "en-US,fr", "ja", "ja", "explicit non-Han content reaches the default"],
    // Nothing disambiguates: null (step 4 belongs to the consumer).
    [null, "", "en-US", null, "auto on an en-US renderer"],
    ["de", "en-US,fr", "en-US", null, "explicit non-Han with non-Han lists"],
    ["", "", "en", null, "an empty explicit locale disambiguates nothing"],
  ];
  it.each(table)("content=%s accept=%s default=%s → %s (%s)", (content, accept, def, expected) => {
    expect(layoutLocaleForHan(content, accept, def)).toBe(expected);
  });

  it("returns the winning locale STRING, not a script", () => {
    // The DirectWrite call site reduces the locale itself (LocaleForSkFontMgr),
    // so the region-only `en-JP` must survive as `en-JP`.
    expect(layoutLocaleForHan(null, "en-JP", "en-US")).toBe("en-JP");
  });
});

describe("withFontLocaleForHan — the request-scoped answer", () => {
  it("restores the enclosing context, including after a throw", () => {
    expect(fontLocaleForHanIdentity()).toBe("");
    withFontLocaleForHan("ja", () => {
      expect(fontLocaleForHanIdentity()).toBe("ja");
      withFontLocaleForHan(null, () => expect(fontLocaleForHanIdentity()).toBe("\u0000"));
      // undefined inherits rather than resetting to the legacy route.
      withFontLocaleForHan(undefined, () => expect(fontLocaleForHanIdentity()).toBe("ja"));
      expect(fontLocaleForHanIdentity()).toBe("ja");
      expect(() =>
        withFontLocaleForHan("ko", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(fontLocaleForHanIdentity()).toBe("ja");
    });
    expect(fontLocaleForHanIdentity()).toBe("");
  });

  it("keeps null (none disambiguates) distinct from absent (legacy) and from any tag", () => {
    const ids = new Set([
      fontLocaleForHanIdentity(),
      withFontLocaleForHan(null, fontLocaleForHanIdentity),
      withFontLocaleForHan("ja", fontLocaleForHanIdentity),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe("FallbackLocaleForCharacter under the captured context", () => {
  it("auto content with --accept-lang=ja answers ja where the legacy route answered the default", () => {
    // Legacy: `lang` arrives as the default (en-US) and nothing disambiguates.
    if (!hostDisambiguatesHan()) expect(blinkWinFallbackLocale(HAN, "en-US")).toBe("zh-Hant");
    // Captured: LocaleForHan(null) took the accept-language at step 2.
    expect(withFontLocaleForHan("ja", () => blinkWinFallbackLocale(HAN, "en-US"))).toBe("ja");
  });

  it("the captured answer overrides a non-Han content lang (steps 2-3 were skipped before)", () => {
    expect(withFontLocaleForHan("zh-TW", () => blinkWinFallbackLocale(HAN, "en"))).toBe("zh-Hant");
  });

  it("null falls to the system locale, then to the kChineseSimplified literal", () => {
    if (hostDisambiguatesHan()) return;
    // A captured null must NOT re-read the passed lang as a content locale: the
    // capture already decided step 1 (here lang is a stale Han tag on purpose).
    expect(withFontLocaleForHan(null, () => blinkWinFallbackLocale(HAN, "ja"))).toBe("zh-Hant");
  });

  it("leaves the non-Han branch on LocaleOrDefault (the passed lang)", () => {
    // `font_description.Locale() ? ... : GetDefault()` — no LocaleForHan there.
    expect(withFontLocaleForHan("ja", () => blinkWinFallbackLocale(0x0041, "de-DE"))).toBe("de");
  });

  it("sends the captured locale's own SkFontMgr tag", () => {
    expect(withFontLocaleForHan("en-JP", () => blinkWinFallbackLocale(HAN, "en-US"))).toBe("en");
  });
});

describe("GetFallbackFamily under the captured context", () => {
  it("routes unified Han and full-width ASCII through LocaleForHan's answer", () => {
    for (const cp of [HAN, FULLWIDTH_A]) {
      const run = (ctx: string | null) => withFontLocaleForHan(ctx, () => getFallbackFamily(cp, { lang: "en" }, stock));
      expect(run("ja")).toEqual({ family: "Yu Gothic", script: HRKT });
      expect(run("zh-TW")).toEqual({ family: "Microsoft JhengHei", script: HANT });
      expect(run("zh-CN")).toEqual({ family: "Microsoft YaHei", script: HANS });
    }
  });

  it("a captured null leaves the script as Han when the host disambiguates nothing", () => {
    if (hostDisambiguatesHan()) return;
    // Legacy would have read lang="ja" as the content locale.
    expect(getFallbackFamily(HAN, { lang: "ja" }, stock).script).toBe(HRKT);
    expect(withFontLocaleForHan(null, () => getFallbackFamily(HAN, { lang: "ja" }, stock)).script).toBe("Han");
  });
});
