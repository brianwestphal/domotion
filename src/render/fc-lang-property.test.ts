/**
 * DM-1863: the fontconfig `:lang=` fragment for the Linux per-codepoint fallback.
 *
 * Blink passes the content locale on this path — `font_description.LocaleOrDefault()`
 * reaches fontconfig as FC_LANG (`linux/font_cache_linux.cc:88-95`, rev 7d859f27)
 * — and we were dropping it entirely. It decides Han unification: the same
 * unified ideograph legitimately resolves to a different face under `zh-CN` than
 * under `zh-TW`, and a locale-blind query answers with fontconfig's default
 * preference order instead. That failure reads as a missing-font problem rather
 * than a dropped argument, which is why it went unnoticed.
 *
 * The tag form is NOT a detail. Measured against fontconfig on the pinned noble
 * image with Noto CJK installed, so the answer could discriminate at all:
 *
 *     :lang=zh-cn    → Noto Sans CJK SC
 *     :lang=zh-tw    → Noto Sans CJK TC
 *     :lang=zh       → WenQuanYi Zen Hei     ← truncating loses the distinction
 *     :lang=zh-hans  → WenQuanYi Zen Hei     ← script subtags are not understood
 *
 * My first implementation reduced every tag to its primary subtag, on the
 * assumption that a region-qualified tag matches nothing. That assumption was
 * wrong and silently threw away the only part of the tag that discriminates —
 * the probe showed zero movement across every locale, which looked exactly like
 * "the plumbing does not work". These tests pin the corrected behaviour.
 */
import { describe, it, expect } from "vitest";
import { fcLangProperty } from "./font-resolution.js";

describe("fontconfig :lang= fragment (DM-1863)", () => {
  it("keeps the REGION subtag — that is what discriminates Han unification", () => {
    // The core regression guard. `zh-cn` and `zh-tw` select different faces;
    // `zh` selects neither.
    expect(fcLangProperty("zh-CN")).toBe(":lang=zh-cn");
    expect(fcLangProperty("zh-TW")).toBe(":lang=zh-tw");
    expect(fcLangProperty("ja-JP")).toBe(":lang=ja-jp");
  });

  it("lower-cases, since fontconfig tags are matched lower-case", () => {
    expect(fcLangProperty("EN")).toBe(":lang=en");
    expect(fcLangProperty("Zh-Hant-TW")).toBe(":lang=zh-hant-tw");
  });

  it("accepts an underscore-separated POSIX-style locale", () => {
    // `en_US` shows up from environment-derived locales; fontconfig wants hyphens.
    expect(fcLangProperty("EN_us")).toBe(":lang=en-us");
  });

  it("passes a bare language tag through unchanged", () => {
    expect(fcLangProperty("ja")).toBe(":lang=ja");
    expect(fcLangProperty("ko")).toBe(":lang=ko");
  });

  it("emits nothing when there is no locale", () => {
    // Must be the empty string, not `:lang=`: an empty property would match no
    // font and quietly turn every fallback into a miss.
    expect(fcLangProperty(undefined)).toBe("");
    expect(fcLangProperty("")).toBe("");
    expect(fcLangProperty("   ")).toBe("");
  });

  it("rejects anything that could inject pattern syntax", () => {
    // `:` and `,` are meaningful in a fontconfig pattern, so an unvalidated
    // locale would be able to add or replace properties in the query.
    expect(fcLangProperty("bad;inject")).toBe("");
    expect(fcLangProperty("en:weight=200")).toBe("");
    expect(fcLangProperty("a,b")).toBe("");
    expect(fcLangProperty("../etc")).toBe("");
  });

  it("rejects tags that are not shaped like language tags at all", () => {
    expect(fcLangProperty("e")).toBe("");        // too short
    expect(fcLangProperty("english")).toBe("");  // primary subtag is 2-3 chars
    expect(fcLangProperty("123")).toBe("");
  });

  it("does NOT invent a script→region mapping", () => {
    // `zh-Hans` is passed through and simply does not discriminate in fontconfig,
    // which is the same outcome as sending no locale. Translating Hans→cn would
    // be inventing a table rather than transcribing one, and the file that would
    // settle what Chrome does — ui/gfx/font_fallback_linux.cc — is not in the
    // local checkout. Pinned so a later "improvement" is a deliberate decision
    // rather than an accident.
    expect(fcLangProperty("zh-Hans")).toBe(":lang=zh-hans");
    expect(fcLangProperty("zh-Hant")).toBe(":lang=zh-hant");
  });
});
