import { describe, expect, it } from "vitest";
import { computedFontLocaleLanguage, fontSelectionLanguage } from "./font-locale.js";

describe("explicit computed font locale (DM-PJG8E9)", () => {
  it.each([
    ['"ja"', "ja"],
    ["'zh-Hant'", "zh-Hant"],
    ['"\\6a a"', "ja"],
    ['""', ""],
    ['"auto"', "auto"],
    ['"ja/*data*/"', "ja/*data*/"],
  ])("decodes the complete CSS string %s", (raw, decoded) => {
    expect(computedFontLocaleLanguage(raw)).toBe(decoded);
  });
  it.each([
    undefined,
    "",
    "auto",
    "initial",
    "ja",
    '"ja", "en"',
    '"ja" extra',
    '"ja\n"',
    '"ja',
    '"' + "j".repeat(4097) + '"',
  ])("refuses unavailable/default/non-string/incomplete locale %s", (raw) =>
    expect(computedFontLocaleLanguage(raw)).toBeUndefined(),
  );
  it("routes explicit CSS locale without changing authored language metadata", () => {
    const styles = { lang: "en", fontLocale: '"ja"' };
    expect(fontSelectionLanguage(styles)).toBe("ja");
    expect(styles.lang).toBe("en");
    expect(fontSelectionLanguage({ language: "en", fontLocale: '"zh-Hant"' })).toBe("zh-Hant");
    expect(fontSelectionLanguage({ lang: "ja", fontLocale: '""' })).toBe("");
  });
  it("retains old capture and auto routes, never inventing a default locale", () => {
    expect(fontSelectionLanguage({ lang: "ja" })).toBe("ja");
    expect(fontSelectionLanguage({ lang: "ja", fontLocale: "auto" })).toBe("ja");
    expect(fontSelectionLanguage({ language: "ko", fontLocale: "auto" })).toBe("ko");
    expect(fontSelectionLanguage({})).toBeUndefined();
  });
});
