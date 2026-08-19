import { describe, expect, it } from "vitest";

import {
  formatLogicalClassification,
  LOGICAL_CLASSIFICATIONS,
  parseLogicalClassification,
} from "./logical-classification.js";

describe("logical residual classification", () => {
  it.each(Object.keys(LOGICAL_CLASSIFICATIONS))("accepts the documented value %s", (value) => {
    expect(parseLogicalClassification(value)).toBe(value);
  });

  it.each([undefined, null, "", "unclassified", "logical", 1, {}])("rejects invalid input %j", (value) => {
    expect(parseLogicalClassification(value)).toBeNull();
  });

  it("formats the classification as a self-contained ticket statement", () => {
    expect(formatLogicalClassification("paint-compositing")).toBe(
      "**Paint / compositing defect** — Logical geometry agrees, but vector paint, effects, stacking, blending, or compositing differs.",
    );
  });
});
