import { describe, expect, it } from "vitest";
import { isShapingTransparentControl } from "./text-segments.js";

describe("shaping-transparent format controls", () => {
  it("classifies joiners without a script or codepoint-pair exception", () => {
    expect(isShapingTransparentControl("\u200D")).toBe(true);
    expect(isShapingTransparentControl("\u200C")).toBe(true);
  });

  it("does not classify marks or ordinary letters as transparent controls", () => {
    expect(isShapingTransparentControl("\u0BC6")).toBe(false);
    expect(isShapingTransparentControl("\u200E")).toBe(false); // LRM is Cf, but not a shaping joiner
    expect(isShapingTransparentControl("A")).toBe(false);
    expect(isShapingTransparentControl("\u{11A84}")).toBe(false);
  });
});
