import { describe, expect, it } from "vitest";
import { resolveCollapsedBorderWinner as winner } from "./collapsed-border.js";

const b = (style: string, w: number, source: string) => ({ style, w, source });

describe("Blink collapsed-border precedence (DM-2245)", () => {
  it("lets hidden suppress every visible width and ignores none", () => {
    expect(winner([b("solid", 40, "cell"), b("hidden", 1, "row")])).toEqual({ hidden: true });
    expect((winner([b("none", 99, "cell"), b("solid", 2, "table")]) as any)?.source).toBe("table");
  });
  it("compares width before style, then uses Blink's style enum", () => {
    expect((winner([b("double", 2, "cell"), b("dotted", 3, "row")]) as any)?.source).toBe("row");
    expect((winner([b("dashed", 4, "row"), b("solid", 4, "section")]) as any)?.source).toBe("section");
  });
  it("retains the first merge source and directional cell on exact ties", () => {
    const sources = ["earlier-cell", "later-cell", "row", "row-group", "column", "column-group", "table"];
    expect((winner(sources.map((source) => b("solid", 8, source))) as any)?.source).toBe("earlier-cell");
  });
});
