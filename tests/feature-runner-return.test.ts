import { describe, expect, it } from "vitest";
import { countFeatureFailures } from "./runner.js";

describe("feature suite failure count", () => {
  it("handles empty, passing, and mixed result sequences", () => {
    expect(countFeatureFailures([])).toBe(0);
    expect(countFeatureFailures([{ pass: true }, { pass: true }])).toBe(0);
    expect(countFeatureFailures([{ pass: false }, { pass: true }, { pass: false }])).toBe(2);
  });
});
