import { describe, expect, it } from "vitest";
import {
  buildPreferenceMutation,
  logicalProbeTargets,
  type BlinkPreferenceRow,
} from "../tools/generic-family-preference-oracle.js";

const rows = (): BlinkPreferenceRow[] => logicalProbeTargets().map((target, index) => ({
  ...target,
  familyName: index % 2 === 0 ? "Measured Serif" : "Measured Sans",
  postScriptName: index % 2 === 0 ? "MeasuredSerif-Regular" : "MeasuredSans-Regular",
  glyphCount: target.text.length,
  isCustomFont: false,
}));

describe("DM-2351 generic preference oracle contract", () => {
  it("crosses Common and ten settings scripts with system-ui and quoted-literal controls", () => {
    const targets = logicalProbeTargets();
    expect(targets).toHaveLength(99);
    expect(targets.filter((target) => target.generic === "system-ui")).toHaveLength(11);
    expect(targets.filter((target) => target.generic === "system-ui")
      .every((target) => target.text === "Regna" || target.text === "A"))
      .toBe(true);
    expect(targets.filter((target) => target.generic === "quoted-serif")).toHaveLength(11);
    expect(new Set(targets.map((target) => `${target.script ?? "COMMON"}/${target.generic}`)).size)
      .toBe(targets.length);
  });

  it("derives every mutation from observed faces instead of an OS snapshot table", () => {
    const source = rows();
    const plan = buildPreferenceMutation(source);
    expect(Object.keys(plan.fontFamilies).sort()).toEqual([
      "cursive", "fantasy", "fixed", "math", "sansSerif", "serif", "standard",
    ]);
    expect(plan.forScripts).toHaveLength(10);
    expect(Object.keys(plan.expectedFaceByTarget)).toHaveLength(77);
    for (const row of source.filter((item) => item.generic !== "system-ui" && item.generic !== "quoted-serif")) {
      expect(plan.expectedFaceByTarget[`${row.script ?? "COMMON"}/${row.generic}`])
        .not.toBe(row.postScriptName);
    }
  });

  it("derives each script mutation only from faces proven to paint that script", () => {
    const source = rows();
    const hebrew = source.filter((row) =>
      row.script === "HEBREW" && row.generic !== "system-ui" && row.generic !== "quoted-serif");
    hebrew.forEach((row, index) => {
      row.familyName = index % 2 === 0 ? "Hebrew Serif" : "Hebrew Sans";
      row.postScriptName = index % 2 === 0 ? "HebrewSerif-Regular" : "HebrewSans-Regular";
    });
    const plan = buildPreferenceMutation(source);
    const request = plan.forScripts.find((entry) => entry.script === "hebr")!;
    expect(new Set(Object.values(request.fontFamilies))).toEqual(new Set(["Hebrew Serif", "Hebrew Sans"]));
    expect(Object.entries(plan.expectedFaceByTarget)
      .filter(([key]) => key.startsWith("HEBREW/"))
      .every(([, value]) => value.startsWith("Hebrew"))).toBe(true);
  });

  it("fails closed when a script has no proven non-inert alternate face", () => {
    const source = rows();
    for (const row of source.filter((item) => item.script === "DEVANAGARI" && item.generic !== "system-ui" && item.generic !== "quoted-serif")) {
      row.familyName = "Only Devanagari Face";
      row.postScriptName = "OnlyDevanagariFace-Regular";
    }
    expect(() => buildPreferenceMutation(source)).toThrow(/two distinct faces proven to paint DEVANAGARI/);
  });
});
