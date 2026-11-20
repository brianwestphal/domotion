import { describe, expect, it } from "vitest";
import { checkAndResolveLocale } from "./linux-application-locale.js";

// Chromium's CheckAndResolveLocale over a fake locale-pak inventory.
const paks = new Set(["ja", "zh-TW", "zh-CN", "en-US", "en-GB", "es-419", "pt-PT", "pt-BR", "he"]);
const has = (locale: string) => paks.has(locale);

describe("checkAndResolveLocale", () => {
  it.each([
    ["ja-JP", "ja"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-SG", "zh-CN"],
    ["en-US", "en-US"],
    ["en-AU", "en-GB"],
    ["es-MX", "es-419"],
    ["pt-AO", "pt-PT"],
    ["pt", "pt-BR"],
    ["iw", "he"],
  ])("%s resolves to %s", (locale, expected) => expect(checkAndResolveLocale(locale, has)).toBe(expected));

  it("resolves nothing without locale paks or for a variant", () => {
    expect(checkAndResolveLocale("ja-JP", () => false)).toBeUndefined();
    expect(checkAndResolveLocale("ca-ES@valencia", has)).toBeUndefined();
    expect(checkAndResolveLocale("fa-IR", has)).toBeUndefined();
  });
});
