import { describe, expect, it } from "vitest";
import {
  adjudicateOverlay,
  type ProfileFaceRow,
  type ProfileFonts,
} from "../tools/generic-profile-target-oracle.js";

const generics = ["standard", "fixed", "serif", "sansserif", "cursive", "fantasy", "math"] as const;
const scripts = ["Zyyy", "Jpan", "Deva"] as const;
const profile = Object.fromEntries(generics.map((generic) => [generic,
  Object.fromEntries(scripts.map((script) => [script, `Profile-${script}-${generic}`])),
])) as ProfileFonts;
const clean: ProfileFaceRow[] = scripts.flatMap((script) => generics.map((generic) => ({
  script,
  generic,
  familyName: `Clean-${script}-${generic}`,
  postScriptName: null,
  glyphCount: 1,
  isCustomFont: false,
})));

describe("generic profile/target adjudication", () => {
  it("accepts clean headless settings plus the retained profile Common math field", () => {
    const actual = structuredClone(clean);
    actual.find((row) => row.script === "Zyyy" && row.generic === "math")!.familyName = profile.math.Zyyy;
    expect(adjudicateOverlay(profile, clean, actual)).toEqual({
      headlessMatchesClean: 20,
      profileDiscriminators: 15,
      profileMapRetainedInHeadless: 1,
      pass: true,
    });
  });

  it("rejects a stale profile-owned script row", () => {
    const actual = structuredClone(clean);
    actual.find((row) => row.script === "Zyyy" && row.generic === "math")!.familyName = profile.math.Zyyy;
    actual.find((row) => row.script === "Deva" && row.generic === "serif")!.familyName = profile.serif.Deva;
    expect(adjudicateOverlay(profile, clean, actual).pass).toBe(false);
  });
});
