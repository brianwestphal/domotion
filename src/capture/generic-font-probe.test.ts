import { describe, expect, it } from "vitest";
import { genericFamilyProbeTargets, genericProbeArmed } from "./generic-font-probe.js";

describe("genericFamilyProbeTargets", () => {
  it("covers Common plus every requested script/generic cross product", () => {
    const targets = genericFamilyProbeTargets();
    expect(targets).toHaveLength(7 + 7 * 7);
    expect(new Set(targets.map((target) => target.id)).size).toBe(targets.length);

    const scripted = targets.filter((target) => target.lang != null);
    expect(new Set(scripted.map((target) => target.lang)))
      .toEqual(new Set(["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el"]));
    for (const lang of ["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el"]) {
      expect(scripted.filter((target) => target.lang === lang).map((target) => target.generic))
        .toEqual(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);
    }
  });

  it("uses a primary-covered sample and canonical Blink script keys", () => {
    const targets = genericFamilyProbeTargets();
    const sample = (lang: string) => targets.find((target) => target.lang === lang)!;
    expect(sample("ja")).toMatchObject({ text: "A", script: "KATAKANA_OR_HIRAGANA" });
    expect(sample("ko")).toMatchObject({ text: "A", script: "HANGUL" });
    expect(sample("zh-Hans")).toMatchObject({ text: "A", script: "SIMPLIFIED_HAN" });
    expect(sample("zh-Hant")).toMatchObject({ text: "A", script: "TRADITIONAL_HAN" });
    expect(sample("ru")).toMatchObject({ text: "A", script: "CYRILLIC" });
    expect(sample("ar")).toMatchObject({ text: "A", script: "ARABIC" });
    expect(sample("el")).toMatchObject({ text: "A", script: "GREEK" });
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
});
