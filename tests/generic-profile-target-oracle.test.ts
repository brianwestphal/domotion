import { describe, expect, it } from "vitest";
import {
  adjudicateOverlay,
  deriveNonInertProfile,
  derivePlaywrightOverlayMask,
  GENERICS,
  runGenericProfileTargetOracle,
  SCRIPTS,
  type ProfileFaceRow,
} from "../tools/generic-profile-target-oracle.js";

const rows = (owner: "Clean" | "Profile"): ProfileFaceRow[] => SCRIPTS.flatMap((script) => GENERICS.map((generic) => ({
  script,
  generic,
  familyName: `${owner}-${script}-${generic}`,
  postScriptName: null,
  glyphCount: 1,
  isCustomFont: false,
})));

const sourceTable = {
  linux: { fontFamilies: { standard: "Linux Standard", fixed: "Linux Fixed" } },
  mac: {
    fontFamilies: { standard: "Mac Standard", sansSerif: "Mac Sans" },
    forScripts: [
      { script: "jpan", fontFamilies: { serif: "Mac Jpan Serif", math: "Mac Jpan Math" } },
      { script: "hang", fontFamilies: { serif: "Mac Hang Serif" } },
    ],
  },
  win: {
    fontFamilies: { fixed: "Win Fixed" },
    forScripts: [{ script: "deva", fontFamilies: { cursive: "Win Deva Cursive" } }],
  },
};

describe("authenticated generic profile/target adjudication", () => {
  it("refuses to launch headed Chrome without an explicit isolated-host opt-in", async () => {
    const report = await runGenericProfileTargetOracle();
    expect(report.verdict).toBe("unavailable");
    expect(report.environment.launches).toEqual([]);
    expect(report.errors).toEqual([
      "Error: headed Chrome is disabled; pass --allow-headed-browser only on an isolated validation host",
    ]);
  });

  it("derives each OS overlay field from Playwright's source structure", () => {
    expect(derivePlaywrightOverlayMask("linux", sourceTable).fields.map(({ script, generic }) => `${script}/${generic}`))
      .toEqual(["Zyyy/standard", "Zyyy/fixed"]);
    expect(derivePlaywrightOverlayMask("mac", sourceTable).fields.map(({ script, generic }) => `${script}/${generic}`))
      .toEqual(["Zyyy/standard", "Zyyy/sansserif", "Jpan/serif", "Jpan/math"]);
    expect(derivePlaywrightOverlayMask("win", sourceTable).fields.map(({ script, generic }) => `${script}/${generic}`))
      .toEqual(["Zyyy/fixed", "Deva/cursive"]);
  });

  it("grades source-masked rows against clean headless and every other row against the profile", () => {
    const profile = rows("Profile");
    const clean = rows("Clean");
    const mask = derivePlaywrightOverlayMask("mac", sourceTable);
    const maskKeys = new Set(mask.fields.map(({ script, generic }) => `${script}/${generic}`));
    const actual = profile.map((row, index) => maskKeys.has(`${row.script}/${row.generic}`) ? clean[index] : row);
    expect(adjudicateOverlay(profile, clean, actual, mask)).toMatchObject({
      expectedRows: 21,
      exactRows: 21,
      sourceMaskFields: mask.fields.length,
      maskedRowsExact: mask.fields.length,
      profileRetainedRows: 21 - mask.fields.length,
      profileRetainedRowsExact: 21 - mask.fields.length,
      mismatches: [],
      pass: true,
    });

    const stale = structuredClone(actual);
    const retained = stale.find((row) => !maskKeys.has(`${row.script}/${row.generic}`))!;
    retained.familyName = `Clean-${retained.script}-${retained.generic}`;
    expect(adjudicateOverlay(profile, clean, stale, mask).pass).toBe(false);
  });

  it("derives all 21 non-inert fields from exact painted face identities", () => {
    const derived = deriveNonInertProfile(rows("Clean"));
    expect(derived.mutation.requiredFieldCount).toBe(21);
    expect(derived.mutation.nonInertFieldCount).toBe(21);
    expect(derived.mutation.fields).toHaveLength(21);
    expect(derived.mutation.fields.every((field) => field.nonInert)).toBe(true);
    expect(Object.values(derived.mutation.distinctRequestedFamiliesByScript).every((count) => count >= 2)).toBe(true);
    expect(derived.mutation.pass).toBe(true);
  });

  it("uses an explicitly authenticated candidate when clean generics collapse to one face", () => {
    const collapsed = rows("Clean").map((row) => row.script === "Deva"
      ? { ...row, familyName: "Nirmala UI", postScriptName: "NirmalaUI" }
      : row);
    const derived = deriveNonInertProfile(collapsed, [
      {
        script: "Deva",
        requestedFamily: "Aparajita",
        familyName: "Aparajita",
        postScriptName: "Aparajita",
        glyphCount: 1,
        isCustomFont: false,
      },
      {
        script: "Deva",
        requestedFamily: "Kokila",
        familyName: "Kokila",
        postScriptName: "Kokila",
        glyphCount: 1,
        isCustomFont: false,
      },
    ]);

    expect(derived.mutation.fields.filter((field) => field.script === "Deva"))
      .toHaveLength(GENERICS.length);
    expect(derived.mutation.fields.filter((field) => field.script === "Deva")
      .every((field) => field.before === "Nirmala UI"
        && ["Aparajita", "Kokila"].includes(field.requested) && field.nonInert))
      .toBe(true);
    expect(derived.mutation.pass).toBe(true);
  });
});
