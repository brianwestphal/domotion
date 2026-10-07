import { describe, expect, it } from "vitest";
import { beginCharacterFallbackDocument, endCharacterFallbackDocument } from "./character-fallback-cache.js";
import { splitTextIntoFontRunsShaped } from "./cluster-fallback.js";
import { resolveFont, resolveFontKey, resolveFontKeyChain } from "./font-resolution.js";

const cps = [0x2f800, 0x2f900, 0x2fa00];

function route(text: string, lang: string, features?: string[]): string[] {
  const family = "system-ui";
  const primary = resolveFont(family, 400, 16, 0, undefined, 100, lang);
  if (primary == null) throw new Error("system-ui primary unavailable");
  return splitTextIntoFontRunsShaped(
    text,
    primary,
    resolveFontKey(family, lang),
    400,
    16,
    0,
    undefined,
    lang,
    resolveFontKeyChain(family, lang),
    true,
    100,
    undefined,
    family,
    { mode: "paths", features },
  ).map((run) => run.fontKey);
}

function face(cp: number, lang: string, size = 16, weight = 400): string {
  const family = "system-ui";
  const primary = resolveFont(family, weight, size, 0, undefined, 100, lang);
  if (primary == null) throw new Error("system-ui primary unavailable");
  const runs = splitTextIntoFontRunsShaped(
    String.fromCodePoint(cp),
    primary,
    resolveFontKey(family, lang),
    weight,
    size,
    0,
    undefined,
    lang,
    resolveFontKeyChain(family, lang),
    true,
    100,
    undefined,
    family,
    { mode: "paths" },
  );
  expect(runs).toHaveLength(1);
  return runs[0].fontKey;
}

describe.runIf(process.platform === "darwin")("mixed-locale primary .notdef shape route", () => {
  it("reuses primary-owned mixed Latin, Han, and space results for the exact text", () => {
    const cp = "\u{2f900}";
    for (const text of [cp + "A", "A" + cp, cp + "一", cp + " ", " " + cp]) {
      beginCharacterFallbackDocument();
      try {
        expect(route(text, "en").every((key) => key === "sf-pro")).toBe(true);
        expect(route(text, "zh-Hans")).toEqual(["sf-pro"]);
      } finally {
        endCharacterFallbackDocument();
      }
    }
  });

  it("does not cache a mixed result with a fallback face or an ineligible shape", () => {
    const cp = "\u{2f900}";
    beginCharacterFallbackDocument();
    try {
      expect(route("一" + cp, "en")).toContain("sysfb:.PingFangUITextSC-Regular");
      expect(route("一" + cp, "zh-Hans")).toContain("sysfb:PingFangSC-Regular");
      expect(route(cp + "A".repeat(29), "en").every((key) => key === "sf-pro")).toBe(true);
      expect(route(cp + "A".repeat(29), "zh-Hans")).toContain("sysfb:PingFangSC-Regular");
      expect(route(cp + "A", "en", ["-liga"]).every((key) => key === "sf-pro")).toBe(true);
      expect(route(cp + "A", "zh-Hans", ["-liga"])).toContain("sysfb:PingFangSC-Regular");
    } finally {
      endCharacterFallbackDocument();
    }
  });

  it("walks fresh, seeded, and different-codepoint transitions", () => {
    beginCharacterFallbackDocument();
    try {
      for (const cp of cps) expect(face(cp, "zh-Hans")).toBe("sysfb:PingFangSC-Regular");
    } finally {
      endCharacterFallbackDocument();
    }

    beginCharacterFallbackDocument();
    try {
      for (const cp of cps) expect(face(cp, "en")).toBe("sf-pro");
      for (const cp of cps) {
        expect(face(cp, "zh-Hans")).toBe("sf-pro");
        expect(face(cp, "zh-Hant")).toBe("sf-pro");
      }
      expect(face(0x2f901, "zh-Hans")).toBe("sysfb:PingFangSC-Regular");
      expect(face(0x2f900, "zh-Hans", 17)).toBe("sysfb:PingFangSC-Regular");
      expect(face(0x2f900, "zh-Hans", 16, 500)).not.toBe("sf-pro");
    } finally {
      endCharacterFallbackDocument();
    }
  });

  it("does not turn an earlier Chinese fallback into a primary cache entry", () => {
    beginCharacterFallbackDocument();
    try {
      expect(face(0x2f900, "zh-Hans")).toBe("sysfb:PingFangSC-Regular");
      expect(face(0x2f900, "en")).toBe("sf-pro");
      expect(face(0x2f900, "zh-Hans")).toBe("sf-pro");
    } finally {
      endCharacterFallbackDocument();
    }
  });
});
