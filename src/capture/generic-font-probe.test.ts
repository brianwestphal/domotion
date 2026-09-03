import { describe, expect, it } from "vitest";
import {
  deserializeSessionGenericFamilyProbe,
  genericFamilyReplayName,
  genericFamilyProbeTargets,
  genericProbeArmed,
  languagesFromDomSnapshot,
  serializeSessionGenericFamilyProbe,
} from "./generic-font-probe.js";

describe("genericFamilyReplayName", () => {
  const face = { familyName: "Arial", postScriptName: "ArialMT" };

  it("uses family display names for fontconfig and DirectWrite replay", () => {
    expect(genericFamilyReplayName("linux", face)).toBe("Arial");
    expect(genericFamilyReplayName("win32", face)).toBe("Arial");
  });

  it("retains CoreText's exact PostScript member", () => {
    expect(genericFamilyReplayName("darwin", face)).toBe("ArialMT");
    expect(genericFamilyReplayName("darwin", { familyName: "Fallback" })).toBe("Fallback");
  });
});

describe("genericFamilyProbeTargets", () => {
  it("covers Common plus every requested script/generic cross product", () => {
    const targets = genericFamilyProbeTargets();
    expect(targets).toHaveLength(7 + 10 * 7);
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);

    const scripted = targets.filter((target) => target.lang != null);
    expect(new Set(scripted.map((target) => target.lang)))
      .toEqual(new Set(["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el", "en", "he", "hi"]));
    for (const lang of ["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el", "en", "he", "hi"]) {
      expect(scripted.filter((target) => target.lang === lang).map((target) => target.generic))
        .toEqual(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);
    }
  });

  it("uses a primary-covered sample and canonical Blink script keys", () => {
    const targets = genericFamilyProbeTargets();
    const sample = (lang: string) => targets.find((target) => target.lang === lang)!;
    expect(sample("ja")).toMatchObject({ text: "日", script: "KATAKANA_OR_HIRAGANA" });
    expect(sample("ko")).toMatchObject({ text: "한", script: "HANGUL" });
    expect(sample("zh-Hans")).toMatchObject({ text: "汉", script: "SIMPLIFIED_HAN" });
    expect(sample("zh-Hant")).toMatchObject({ text: "漢", script: "TRADITIONAL_HAN" });
    expect(sample("ru")).toMatchObject({ text: "Я", script: "CYRILLIC" });
    expect(sample("ar")).toMatchObject({ text: "ا", script: "ARABIC" });
    expect(sample("el")).toMatchObject({ text: "Ω", script: "GREEK" });
    expect(sample("en")).toMatchObject({ text: "A", script: "LATIN" });
    expect(sample("he")).toMatchObject({ text: "א", script: "HEBREW" });
    expect(sample("hi")).toMatchObject({ text: "अ", script: "DEVANAGARI" });
  });

  it("adds every effective page language once per Blink settings script", () => {
    const targets = genericFamilyProbeTargets(["th", "th-TH", "ka", "bn", ""]);
    const languages = new Set(targets.filter((target) => target.lang != null).map((target) => target.lang));
    expect(languages).toContain("th");
    expect(languages).not.toContain("th-TH");
    expect(languages).toContain("ka");
    expect(languages).toContain("bn");
    expect(targets.find((target) => target.lang === "th")).toMatchObject({ text: "ก", script: "THAI" });
    expect(targets.find((target) => target.lang === "ka")).toMatchObject({ text: "ა", script: "GEORGIAN" });
  });

  it("extracts response and flattened shadow-tree language facts from DOMSnapshot", () => {
    const snapshot = {
      strings: ["th", "lang", "ka", "xml:lang", "hy", "class", "ignored"],
      documents: [{
        contentLanguage: 0,
        nodes: {
          attributes: [[], [1, 2], [3, 4], [5, 6]],
        },
      }],
    };
    expect(languagesFromDomSnapshot(snapshot)).toEqual(["th", "ka", "hy"]);
  });

  it("is on by default and retains an explicit degraded-mode escape hatch", () => {
    const previous = process.env.DOMOTION_GENERIC_PROBE;
    delete process.env.DOMOTION_GENERIC_PROBE;
    expect(genericProbeArmed()).toBe(true);
    process.env.DOMOTION_GENERIC_PROBE = "0";
    expect(genericProbeArmed()).toBe(false);
    if (previous == null) delete process.env.DOMOTION_GENERIC_PROBE;
    else process.env.DOMOTION_GENERIC_PROBE = previous;
  });

  it("round-trips the live maps through the captured-tree JSON record", () => {
    const live = {
      common: new Map([["serif", "SourceSerifPS"]]),
      byScript: new Map([["ARABIC", new Map([["sans-serif", "SourceArabicPS"]])]]),
    };
    const serialized = serializeSessionGenericFamilyProbe(live);
    expect(serialized).toEqual({
      source: "chromium-platform-fonts-v1",
      common: { serif: "SourceSerifPS" },
      byScript: { ARABIC: { "sans-serif": "SourceArabicPS" } },
    });
    const restored = deserializeSessionGenericFamilyProbe(
      JSON.parse(JSON.stringify(serialized)),
    );
    expect([...restored.common]).toEqual([...live.common]);
    expect([...restored.byScript.get("ARABIC")!]).toEqual([...live.byScript.get("ARABIC")!]);
  });
});
