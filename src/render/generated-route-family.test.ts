import { describe, it, expect } from "vitest";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";

// DM-1844. The generated per-block routing table records which family Chrome's
// CoreText fallback picked for each Unicode block — as sampled on ONE Mac. It is
// therefore a snapshot of that machine's font inventory, and several of the
// families in it are not stock (`SF Pro Text` and `Noto Sans` are separate Apple
// / Google downloads). Using a route whose family isn't installed paints a face
// Chrome will never pick on that machine: on the CI runner, U+04FA came out as
// the route's SFNS.ttf while Chrome painted `.New York`.
//
// The runtime gate lives in `generatedRouteUsable` (font-resolution.ts) and keys
// on `entry.family`. These tests protect the DATA that gate depends on — the
// realistic regression is a regeneration that drops the field, which would
// silently disable the gate everywhere rather than fail loudly.

describe("generated darwin route table carries family provenance (DM-1844)", () => {
  it("every routed key exists in the paths table", () => {
    const missing = [...new Set(UNICODE_FONT_RANGES.map(([, , k]) => k))]
      .filter((k) => UNICODE_FONT_PATHS[k] == null);
    expect(missing, `routes reference keys with no path entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("every entry records the family it was sampled from", () => {
    const noFamily = Object.entries(UNICODE_FONT_PATHS)
      .filter(([, v]) => v.family == null || v.family === "")
      .map(([k]) => k);
    expect(
      noFamily,
      "a route with no family bypasses the availability gate and will be used even on a machine "
      + `where Chrome cannot pick it. Missing on: ${noFamily.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the known non-stock families, so the gate has something to reject", () => {
    // Not vacuous: if these ever stop being present the gate is inert and this
    // test says so rather than passing silently.
    expect(UNICODE_FONT_PATHS["u-sf-pro-text"]?.family).toBe("SF Pro Text");
    expect(UNICODE_FONT_PATHS["u-noto-sans"]?.family).toBe("Noto Sans");
  });

  it("families are plausible names, not keys or paths leaked into the field", () => {
    for (const [key, v] of Object.entries(UNICODE_FONT_PATHS)) {
      const fam = v.family;
      if (fam == null) continue;
      expect(fam, `${key}: family looks like a path`).not.toMatch(/[/\\]/);
      expect(fam, `${key}: family looks like a slug key`).not.toMatch(/^u-/);
      expect(fam.trim(), `${key}: family is blank`).not.toBe("");
    }
  });

  it("ranges stay sorted and non-overlapping (the lookup binary-searches them)", () => {
    for (let i = 1; i < UNICODE_FONT_RANGES.length; i++) {
      const [prevLo, prevHi] = UNICODE_FONT_RANGES[i - 1];
      const [lo] = UNICODE_FONT_RANGES[i];
      expect(prevLo).toBeLessThanOrEqual(prevHi);
      expect(lo, `range ${i} starts at or before the previous range's end`).toBeGreaterThan(prevHi);
    }
  });
});
