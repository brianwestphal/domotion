import { describe, expect, it } from "vitest";
import { focusRingCornerSource } from "./focus-ring.js";

// DM-7FBK91: the cascade-origin inputs of GetFocusRingCornerRadii
// (core/paint/outline_painter.cc:755-803, chromium 6b5a1b80).
const facts = (hasAuthorBorder = false, hasAuthorBorderRadius = false) => ({
  available: true,
  hasAuthorBorder,
  hasAuthorBorderRadius,
});

describe("focusRingCornerSource", () => {
  it("treats any radius of an element outside the control pre-pass as authored", () => {
    expect(focusRingCornerSource(false, "none", undefined, 1)).toEqual({ borderRadiusEligible: true });
  });

  it("maps unstyled effective appearances to NativeThemeBase parts", () => {
    for (const [appearance, part] of [
      ["checkbox", "checkbox"],
      ["push-button", "push-button"],
      ["square-button", "push-button"],
      ["button", "push-button"],
      ["textfield", "text-field"],
      ["textarea", "text-field"],
      ["searchfield", "text-field"],
    ] as const) {
      expect(focusRingCornerSource(true, appearance, facts(), 1)).toEqual({
        borderRadiusEligible: false,
        nativePart: part,
        nativePartRadius: 2,
      });
    }
    expect(focusRingCornerSource(true, "radio", facts(), 2)).toEqual({
      borderRadiusEligible: false,
      nativePart: "radio",
    });
  });

  it("zooms fixed part radii like a border width", () => {
    expect(focusRingCornerSource(true, "checkbox", facts(), 1.75).nativePartRadius).toBe(3);
    expect(focusRingCornerSource(true, "checkbox", facts(), 0.25).nativePartRadius).toBe(1);
  });

  it("drops the part for an author border or a part-less appearance", () => {
    expect(focusRingCornerSource(true, "checkbox", facts(true, false), 1)).toEqual({ borderRadiusEligible: false });
    expect(focusRingCornerSource(true, "checkbox", facts(true, true), 1)).toEqual({ borderRadiusEligible: true });
    expect(focusRingCornerSource(true, "menulist", facts(), 1)).toEqual({ borderRadiusEligible: false });
    expect(focusRingCornerSource(true, "none", facts(), 1)).toEqual({ borderRadiusEligible: false });
  });

  it("admits the radius branch for a base effective appearance", () => {
    expect(focusRingCornerSource(true, "base-select", facts(), 1).borderRadiusEligible).toBe(true);
  });

  it("marks a control without cascade-origin facts unresolved", () => {
    expect(focusRingCornerSource(true, null, facts(), 1)).toEqual({ borderRadiusEligible: true, unresolved: true });
    expect(focusRingCornerSource(true, "checkbox", { ...facts(), available: false }, 1).unresolved).toBe(true);
    expect(focusRingCornerSource(true, "checkbox", undefined, 1).unresolved).toBe(true);
  });
});
