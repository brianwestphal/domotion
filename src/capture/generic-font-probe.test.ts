import { describe, expect, it } from "vitest";
import { genericFamilyProbeTargets } from "./generic-font-probe.js";

describe("genericFamilyProbeTargets", () => {
  it("covers Common plus every requested script/generic cross product", () => {
    const targets = genericFamilyProbeTargets();
    expect(targets).toHaveLength(6 + 4 * 3);
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);

    const scripted = targets.filter((target) => target.lang != null);
    expect(new Set(scripted.map((target) => target.lang)))
      .toEqual(new Set(["ja", "ko", "zh-Hans", "zh-Hant"]));
    for (const lang of ["ja", "ko", "zh-Hans", "zh-Hant"]) {
      expect(scripted.filter((target) => target.lang === lang).map((target) => target.generic))
        .toEqual(["serif", "sans-serif", "monospace"]);
    }
  });

  it("uses native-script samples and canonical Blink script keys", () => {
    const targets = genericFamilyProbeTargets();
    const sample = (lang: string) => targets.find((target) => target.lang === lang)!;
    expect(sample("ja")).toMatchObject({ text: "日本語", script: "KATAKANA_OR_HIRAGANA" });
    expect(sample("ko")).toMatchObject({ text: "한국어", script: "HANGUL" });
    expect(sample("zh-Hans")).toMatchObject({ text: "简体中文", script: "SIMPLIFIED_HAN" });
    expect(sample("zh-Hant")).toMatchObject({ text: "繁體中文", script: "TRADITIONAL_HAN" });
  });
});
