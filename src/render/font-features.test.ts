import { describe, expect, it } from "vitest";
import { featureListNeedsHbShaping, fontkitFeatureList } from "./font-features.js";

// A feature list carrying a disable (`-liga`) or an explicit value (`aalt=2`)
// can only be honored by HarfBuzz — fontkit's `layout(text, features)` is
// enable-only — so the list has two projections: the routing predicate and the
// enable-only view. (Companion of the run reroute in text-to-path.ts.)
describe("featureListNeedsHbShaping", () => {
  it("is false for undefined / empty / plain enables", () => {
    expect(featureListNeedsHbShaping(undefined)).toBe(false);
    expect(featureListNeedsHbShaping([])).toBe(false);
    expect(featureListNeedsHbShaping(["liga", "cv11", "smcp"])).toBe(false);
  });

  it("is true when any entry is a disable or carries a value", () => {
    expect(featureListNeedsHbShaping(["-liga"])).toBe(true);
    expect(featureListNeedsHbShaping(["cv11", "-kern"])).toBe(true);
    expect(featureListNeedsHbShaping(["salt=2"])).toBe(true);
  });
});

describe("fontkitFeatureList", () => {
  it("returns the SAME array instance when no projection is needed", () => {
    const list = ["liga", "cv11"];
    expect(fontkitFeatureList(list)).toBe(list);
    expect(fontkitFeatureList(undefined)).toBeUndefined();
  });

  it("drops disables and flattens values to bare tags", () => {
    expect(fontkitFeatureList(["cv11", "-kern", "-liga"])).toEqual(["cv11"]);
    expect(fontkitFeatureList(["salt=2", "tnum"])).toEqual(["salt", "tnum"]);
  });

  it("returns undefined when everything was a disable", () => {
    expect(fontkitFeatureList(["-dlig", "-liga"])).toBeUndefined();
  });
});
