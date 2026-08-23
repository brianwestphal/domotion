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
});
