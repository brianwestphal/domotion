import { describe, expect, it } from "vitest";
import { pseudoChildPaintOrder } from "./pseudo-stacking-order.js";

describe("source pseudo/child stack interleaving (DM-XWPSPP)", () => {
  it("puts auto pseudos below positive children while respecting before/after zero ties", () => {
    const before = { pseudo: "::before" as const, paint: {} };
    const after = { pseudo: "::after" as const, paint: {} };
    const order = pseudoChildPaintOrder(
      [
        { child: "zero-first", zIndex: 0 },
        { child: "zero-second", zIndex: 0 },
        { child: "positive", zIndex: 1 },
      ],
      [after, before],
    );
    expect(order.map((entry) => (entry.kind === "child" ? entry.child : entry.record.pseudo))).toEqual([
      "::before",
      "zero-first",
      "zero-second",
      "::after",
      "positive",
    ]);
  });

  it("interleaves numeric positive levels and preserves generated-child tie order", () => {
    const before = { pseudo: "::before" as const, paint: { zIndex: 3 } };
    const after = { pseudo: "::after" as const, paint: { zIndex: 2 } };
    const children = [
      { child: "low", zIndex: 1 },
      { child: "middle", zIndex: 2 },
      { child: "high-first", zIndex: 3 },
      { child: "high-second", zIndex: 3 },
    ];
    const order = pseudoChildPaintOrder(children, [before, after]);
    expect(order.map((entry) => (entry.kind === "child" ? entry.child : entry.record.pseudo))).toEqual([
      "low",
      "middle",
      "::after",
      "::before",
      "high-first",
      "high-second",
    ]);
    expect(order.filter((entry) => entry.kind === "pseudo").map((entry) => entry.record)).toEqual([after, before]);
    expect(children.map((entry) => entry.child)).toEqual(["low", "middle", "high-first", "high-second"]);
  });
});
