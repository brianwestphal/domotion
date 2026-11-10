import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import {
  containmentCreatesFixedContainer,
  containmentCreatesStackingContext,
  hasPaintContainment,
} from "./containment.js";
import { establishesStackingContext, isFixedContainingBlock, isOverflowOnlySC } from "./stacking.js";
import { childOverflowClipGeometry } from "./element-tree-to-svg.js";
import { parseOverflowClipMargin, shouldApplyOverflowClipMargin } from "./overflow-clip.js";

describe("native containment eligibility (DM-5YF0BB)", () => {
  it("gates activation on native eligibility instead of manufacturing a context from tokens", () => {
    for (const contain of ["layout", "layout style", "paint", "strict", "content"]) {
      const eligible = { contain, paintOrLayoutContainmentEligible: true };
      const ineligible = { contain, paintOrLayoutContainmentEligible: false };
      expect(containmentCreatesStackingContext(eligible)).toBe(true);
      expect(containmentCreatesFixedContainer(eligible)).toBe(true);
      expect(containmentCreatesStackingContext(ineligible)).toBe(false);
      expect(containmentCreatesFixedContainer(ineligible)).toBe(false);
      expect(hasPaintContainment(ineligible)).toBe(false);
      expect(hasPaintContainment(eligible)).toBe(!contain.startsWith("layout"));
    }
    for (const contain of ["none", "style", "size", "inline-size"]) {
      expect(containmentCreatesStackingContext({ contain, paintOrLayoutContainmentEligible: true })).toBe(false);
    }
  });

  it("preserves each legacy fallback without treating an absent layout fact as authority", () => {
    expect(containmentCreatesStackingContext({ contain: "layout" })).toBe(false);
    expect(containmentCreatesFixedContainer({ contain: "layout" })).toBe(true);
    for (const contain of ["paint", "strict", "content"]) {
      expect(containmentCreatesStackingContext({ contain })).toBe(true);
      expect(hasPaintContainment({ contain })).toBe(true);
    }
  });

  it("keeps eligible layout contexts atomic through overflow and fixed ownership", () => {
    const owner = capturedElement({
      tag: "div",
      styles: capturedStyles({
        contain: "layout",
        paintOrLayoutContainmentEligible: true,
        overflowX: "hidden",
        overflowY: "hidden",
      }),
    });
    expect(establishesStackingContext(owner)).toBe(true);
    expect(isOverflowOnlySC(owner)).toBe(false);
    expect(isFixedContainingBlock(owner)).toBe(true);
    owner.styles.paintOrLayoutContainmentEligible = false;
    expect(isOverflowOnlySC(owner)).toBe(true);
    expect(isFixedContainingBlock(owner)).toBe(false);
    owner.styles.opacity = "0.5";
    expect(establishesStackingContext(owner)).toBe(true);
    expect(isOverflowOnlySC(owner)).toBe(false);
  });

  it("does not leave a paint clip active after native eligibility rejects containment", () => {
    const owner = capturedElement({
      tag: "div",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      styles: capturedStyles({ contain: "paint", paintOrLayoutContainmentEligible: false }),
      children: [capturedElement({ x: 0, y: 0, width: 80, height: 80 })],
    });
    expect(childOverflowClipGeometry(owner)).toBeNull();
    expect(shouldApplyOverflowClipMargin(parseOverflowClipMargin("8px"), owner.styles)).toBe(false);
    owner.styles.paintOrLayoutContainmentEligible = true;
    expect(childOverflowClipGeometry(owner)).not.toBeNull();
    expect(shouldApplyOverflowClipMargin(parseOverflowClipMargin("8px"), owner.styles)).toBe(true);
    owner.styles.contain = "layout";
    expect(childOverflowClipGeometry(owner)).toBeNull();
  });
});
