import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import {
  deserializeSessionGenericFamilyProbe,
  genericFamilyReplayName,
  COMMON_SCRIPT_PROBE_LANG,
  genericFamilyProbeTargets,
  genericProbeArmed,
  languagesFromDomSnapshot,
  probePageGenericFamilies,
  serializeSessionGenericFamilyProbe,
} from "./generic-font-probe.js";
import { localeToScriptCodeForFontSelection } from "../render/generic-script-families.js";

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

    const scripted = targets.filter((target) => target.script != null);
    expect(new Set(scripted.map((target) => target.lang))).toEqual(
      new Set(["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el", "en", "he", "hi"]),
    );
    for (const lang of ["ja", "ko", "zh-Hans", "zh-Hant", "ru", "ar", "el", "en", "he", "hi"]) {
      expect(scripted.filter((target) => target.lang === lang).map((target) => target.generic)).toEqual([
        "standard",
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "math",
      ]);
    }
  });

  it("probes Common under a locale whose Blink font-selection script is Common", () => {
    // Neither "no lang" (inherits the page locale, usually Latin) nor `und`
    // (Latin in Blink's table) reaches the Common settings entry when the
    // Latin entry is populated; the `Zyyy` script subtag does.
    const common = genericFamilyProbeTargets().filter((target) => target.script == null);
    expect(common.map((target) => target.generic)).toEqual([
      "standard",
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "math",
    ]);
    expect(common.every((target) => target.lang === COMMON_SCRIPT_PROBE_LANG)).toBe(true);
    expect(localeToScriptCodeForFontSelection(COMMON_SCRIPT_PROBE_LANG)).toBe("COMMON");
    expect(localeToScriptCodeForFontSelection("und")).toBe("LATIN");
  });

  it("uses an uncovered primary sentinel with each locale's Blink script key", () => {
    const targets = genericFamilyProbeTargets();
    const sample = (lang: string) => targets.find((target) => target.lang === lang)!;
    const sentinel = String.fromCodePoint(0x10ffff);
    expect(targets.filter((target) => target.script != null).every((target) => target.text === sentinel)).toBe(true);
    expect(sample("ja")).toMatchObject({ script: "KATAKANA_OR_HIRAGANA" });
    expect(sample("ko")).toMatchObject({ script: "HANGUL" });
    expect(sample("zh-Hans")).toMatchObject({ script: "SIMPLIFIED_HAN" });
    expect(sample("zh-Hant")).toMatchObject({ script: "TRADITIONAL_HAN" });
    expect(sample("ru")).toMatchObject({ script: "CYRILLIC" });
    expect(sample("ar")).toMatchObject({ script: "ARABIC" });
    expect(sample("el")).toMatchObject({ script: "GREEK" });
    expect(sample("en")).toMatchObject({ script: "LATIN" });
    expect(sample("he")).toMatchObject({ script: "HEBREW" });
    expect(sample("hi")).toMatchObject({ script: "DEVANAGARI" });
  });

  it("adds every effective page language once per Blink settings script", () => {
    const targets = genericFamilyProbeTargets(["th", "th-TH", "ka", "bn", ""]);
    const languages = new Set(targets.filter((target) => target.script != null).map((target) => target.lang));
    expect(languages).toContain("th");
    expect(languages).not.toContain("th-TH");
    expect(languages).toContain("ka");
    expect(languages).toContain("bn");
    expect(targets.find((target) => target.lang === "th")).toMatchObject({
      text: String.fromCodePoint(0x10ffff),
      script: "THAI",
    });
    expect(targets.find((target) => target.lang === "ka")).toMatchObject({
      text: String.fromCodePoint(0x10ffff),
      script: "GEORGIAN",
    });
  });

  it("extracts response and flattened shadow-tree language facts from DOMSnapshot", () => {
    const snapshot = {
      strings: ["th", "lang", "ka", "xml:lang", "hy", "class", "ignored"],
      documents: [
        {
          contentLanguage: 0,
          nodes: {
            attributes: [[], [1, 2], [3, 4], [5, 6]],
          },
        },
      ],
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
    const restored = deserializeSessionGenericFamilyProbe(JSON.parse(JSON.stringify(serialized)));
    expect([...restored.common]).toEqual([...live.common]);
    expect([...restored.byScript.get("ARABIC")!]).toEqual([...live.byScript.get("ARABIC")!]);
  });
});

describe("probePageGenericFamilies failure reporting", () => {
  // The persistent session cache is keyed by Page, so each test uses its own fake.
  const fakePage = (newCDPSession: () => Promise<unknown>, evaluate?: () => Promise<unknown>): Page =>
    ({
      context: () => ({ newCDPSession }),
      once: () => {},
      evaluate: evaluate ?? (async () => undefined),
    }) as unknown as Page;

  it("reports a probe that threw and returns null", async () => {
    const failures: Array<[string, unknown]> = [];
    const page = fakePage(async () => {
      throw new Error("Target page, context or browser has been closed");
    });

    const result = await probePageGenericFamilies(page, (probe, cause) => failures.push([probe, cause]));

    expect(result).toBeNull();
    expect(failures).toEqual([
      ["page generic-family probe", new Error("Target page, context or browser has been closed")],
    ]);
  });

  it("reports failed page-language discovery separately, then the probe failure it led to", async () => {
    const session = {
      send: async (method: string) => {
        if (method === "DOMSnapshot.captureSnapshot") throw new Error("snapshot refused");
        return {};
      },
      detach: async () => {},
    };
    const failures: string[] = [];
    const page = fakePage(
      async () => session,
      async () => {
        throw new Error("evaluate refused");
      },
    );

    const result = await probePageGenericFamilies(page, (probe, cause) =>
      failures.push(`${probe}: ${(cause as Error).message}`),
    );

    expect(result).toBeNull();
    expect(failures).toEqual([
      "page language discovery: snapshot refused",
      "page generic-family probe: evaluate refused",
    ]);
  });

  it("does not require a failure callback", async () => {
    const page = fakePage(async () => {
      throw new Error("closed");
    });
    await expect(probePageGenericFamilies(page)).resolves.toBeNull();
  });
});
