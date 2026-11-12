import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import { trapsFixedDescendants } from "./stacking.js";

// DM-RN0T12: a viewport-fixed box hoists to the document root only past
// ancestors that neither contain it nor form a genuine stacking context.
describe("viewport-fixed hoisting boundaries (DM-RN0T12)", () => {
  const element = (styles: Parameters<typeof capturedStyles>[0]) =>
    capturedElement({ tag: "div", styles: capturedStyles(styles) });

  it("stops at genuine stacking contexts and fixed containing blocks", () => {
    expect(trapsFixedDescendants(element({ opacity: "0.5" }), "block")).toBe(true);
    expect(trapsFixedDescendants(element({ mixBlendMode: "multiply" }), "block")).toBe(true);
    expect(trapsFixedDescendants(element({ isolation: "isolate" }), "block")).toBe(true);
    expect(trapsFixedDescendants(element({ position: "relative", zIndex: "1" }), "block")).toBe(true);
    expect(
      trapsFixedDescendants(element({ transformCreatesSc: true, transform: "matrix(1, 0, 0, 1, 0, 0)" }), "block"),
    ).toBe(true);
  });

  it("passes through ordinary boxes and overflow-only scrollers", () => {
    expect(trapsFixedDescendants(element({}), "block")).toBe(false);
    expect(trapsFixedDescendants(element({ position: "relative" }), "block")).toBe(false);
    expect(trapsFixedDescendants(element({ overflowX: "hidden", overflowY: "hidden" }), "block")).toBe(false);
    // Opacity on an overflow scroller makes it a genuine context again.
    expect(trapsFixedDescendants(element({ overflowX: "auto", overflowY: "auto", opacity: "0.5" }), "block")).toBe(
      true,
    );
  });
});
