import { describe, expect, it } from "vitest";
import {
  collapsedBorderStyle,
  collapsedBorderFragmentLogicalRects,
  collapsedBorderLogicalRects,
  compareCollapsedEdgesForPaint,
  createCollapsedBorderGrid,
  mergeCollapsedBorderBox,
  physicalSidesForTable,
  resolveCollapsedBorderWinner as winner,
  type CollapsedBorderPhysicalSide,
  type CollapsedBorderSource,
} from "./collapsed-border.js";

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

const source = (side: CollapsedBorderPhysicalSide, style: string, w: number, order: number): CollapsedBorderSource => ({
  side, style, w, order, color: `${side}-${order}`,
});

describe("Blink table-level collapsed-border graph (DM-2320)", () => {
  it("maps physical sides through the table writing direction", () => {
    expect(physicalSidesForTable("horizontal-tb", "ltr")).toEqual({
      blockStart: "top", blockEnd: "bottom", inlineStart: "left", inlineEnd: "right",
    });
    expect(physicalSidesForTable("horizontal-tb", "rtl")).toEqual({
      blockStart: "top", blockEnd: "bottom", inlineStart: "right", inlineEnd: "left",
    });
    expect(physicalSidesForTable("vertical-rl", "ltr")).toEqual({
      blockStart: "right", blockEnd: "left", inlineStart: "top", inlineEnd: "bottom",
    });
    expect(physicalSidesForTable("vertical-lr", "rtl")).toEqual({
      blockStart: "left", blockEnd: "right", inlineStart: "bottom", inlineEnd: "top",
    });
  });

  it("normalizes inset/outset before merge and paint precedence", () => {
    expect(collapsedBorderStyle("inset")).toBe("ridge");
    expect(collapsedBorderStyle("outset")).toBe("groove");
    expect(collapsedBorderStyle("double")).toBe("double");
  });

  it("stores one winner per logical grid edge and retains the earlier exact tie", () => {
    const grid = createCollapsedBorderGrid(1, 2);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 1, {
      right: source("right", "solid", 4, 1),
    }, "horizontal-tb", "ltr");
    mergeCollapsedBorderBox(grid, 0, 1, 1, 1, {
      left: source("left", "solid", 4, 2),
    }, "horizontal-tb", "ltr");
    expect(grid.columnAxis[0][1].winner).toMatchObject({ side: "right", order: 1 });
  });

  it("lets later sources replace by hidden, width, then style but not source order", () => {
    const grid = createCollapsedBorderGrid(1, 1);
    const mergeTop = (candidate: CollapsedBorderSource) => mergeCollapsedBorderBox(
      grid, 0, 0, 1, 1, { top: candidate }, "horizontal-tb", "ltr",
    );
    mergeTop(source("top", "solid", 3, 1));
    mergeTop(source("top", "double", 3, 2));
    expect(grid.rowAxis[0][0].winner).toMatchObject({ style: "double", order: 2 });
    mergeTop(source("top", "dotted", 4, 3));
    expect(grid.rowAxis[0][0].winner).toMatchObject({ style: "dotted", order: 3 });
    mergeTop(source("top", "hidden", 1, 4));
    expect(grid.rowAxis[0][0].winner).toMatchObject({ style: "hidden", order: 4 });
    mergeTop(source("top", "double", 99, 5));
    expect(grid.rowAxis[0][0].winner).toMatchObject({ style: "hidden", order: 4 });
  });

  it("marks a spanning cell's unclaimed interior edges do-not-fill", () => {
    const grid = createCollapsedBorderGrid(2, 2);
    mergeCollapsedBorderBox(grid, 0, 0, 2, 2, {
      top: source("top", "solid", 2, 1),
      right: source("right", "solid", 2, 1),
      bottom: source("bottom", "solid", 2, 1),
      left: source("left", "solid", 2, 1),
    }, "horizontal-tb", "ltr", true);
    expect(grid.columnAxis.map((row) => row[1].doNotFill)).toEqual([true, true]);
    expect(grid.rowAxis[1].map((edge) => edge.doNotFill)).toEqual([true, true]);
    expect(grid.rowAxis[0].every((edge) => !edge.doNotFill && edge.winner != null)).toBe(true);
  });

  it("does not let a later structural source fill a span interior", () => {
    const grid = createCollapsedBorderGrid(1, 2);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 2, {}, "horizontal-tb", "ltr", true);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 1, {
      right: source("right", "solid", 8, 9),
    }, "horizontal-tb", "ltr");
    expect(grid.columnAxis[0][1]).toEqual({ winner: null, doNotFill: true });
  });

  it("uses width, style, and box order for paint-joint precedence", () => {
    const edge = (candidate: CollapsedBorderSource | null) => ({ winner: candidate, doNotFill: false });
    expect(compareCollapsedEdgesForPaint(edge(source("top", "solid", 4, 1)), edge(source("left", "double", 3, 0)))).toBe(1);
    expect(compareCollapsedEdgesForPaint(edge(source("top", "dashed", 4, 1)), edge(source("left", "solid", 4, 2)))).toBe(-1);
    expect(compareCollapsedEdgesForPaint(edge(source("top", "solid", 4, 1)), edge(source("left", "solid", 4, 2)))).toBe(1);
  });

  it("extends equal winning edges through joints like ComputeEdgeJoints", () => {
    const grid = createCollapsedBorderGrid(1, 1);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 1, {
      top: source("top", "solid", 4, 1), right: source("right", "solid", 4, 1),
      bottom: source("bottom", "solid", 4, 1), left: source("left", "solid", 4, 1),
    }, "horizontal-tb", "ltr");
    const top = collapsedBorderLogicalRects(grid, [0, 10], [0, 10]).find((rect) => rect.axis === "row" && rect.row === 0)!;
    expect(top).toMatchObject({ inlineStart: -2, inlineSize: 14, blockStart: -2, blockSize: 4 });
  });

  it("retreats a narrower edge from a perpendicular joint winner", () => {
    const grid = createCollapsedBorderGrid(1, 1);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 1, {
      top: source("top", "solid", 2, 1), right: source("right", "solid", 2, 1),
      bottom: source("bottom", "solid", 2, 1), left: source("left", "solid", 8, 1),
    }, "horizontal-tb", "ltr");
    const top = collapsedBorderLogicalRects(grid, [0, 10], [0, 10]).find((rect) => rect.axis === "row" && rect.row === 0)!;
    expect(top.inlineStart).toBe(4);
    expect(top.inlineSize).toBe(7);
  });
});

describe("Blink fragmented collapsed-border ownership (DM-2322)", () => {
  const twoRowGrid = () => {
    const grid = createCollapsedBorderGrid(2, 1);
    mergeCollapsedBorderBox(grid, 0, 0, 1, 1, {
      top: source("top", "solid", 4, 1), right: source("right", "solid", 4, 1),
      bottom: source("bottom", "solid", 4, 1), left: source("left", "solid", 4, 1),
    }, "horizontal-tb", "ltr");
    mergeCollapsedBorderBox(grid, 1, 0, 1, 1, {
      top: source("top", "solid", 4, 2), right: source("right", "solid", 4, 2),
      bottom: source("bottom", "solid", 4, 2), left: source("left", "solid", 4, 2),
    }, "horizontal-tb", "ltr");
    return grid;
  };

  it("paints half of an inline border on each side of a row break", () => {
    const grid = twoRowGrid();
    const before = collapsedBorderFragmentLogicalRects(grid, [0, 20], [{
      rowStart: 0, blockLines: [0, 10], hasContentAfter: true,
    }]);
    const after = collapsedBorderFragmentLogicalRects(grid, [0, 20], [{
      rowStart: 1, blockLines: [0, 10], hasContentBefore: true,
    }]);
    const beforeBreak = before.find((rect) => rect.axis === "row" && rect.row === 1)!;
    const afterBreak = after.find((rect) => rect.axis === "row" && rect.row === 1)!;
    expect(beforeBreak).toMatchObject({ blockStart: 8, blockSize: 2 });
    expect(afterBreak).toMatchObject({ blockStart: 0, blockSize: 2 });
  });

  it("omits an inline edge through a fragmented row", () => {
    const grid = twoRowGrid();
    const firstPiece = collapsedBorderFragmentLogicalRects(grid, [0, 20], [{
      rowStart: 0, blockLines: [0, 10], endRowFragmented: true,
    }]);
    const continuation = collapsedBorderFragmentLogicalRects(grid, [0, 20], [{
      rowStart: 0, blockLines: [0, 10], startRowFragmented: true,
    }]);
    expect(firstPiece.some((rect) => rect.axis === "row" && rect.row === 1)).toBe(false);
    expect(continuation.some((rect) => rect.axis === "row" && rect.row === 0)).toBe(false);
    expect(firstPiece.some((rect) => rect.axis === "column" && rect.row === 0)).toBe(true);
    expect(continuation.some((rect) => rect.axis === "column" && rect.row === 0)).toBe(true);
  });

  it("does not double-paint the shared row edge between adjacent sections", () => {
    const grid = twoRowGrid();
    const rects = collapsedBorderFragmentLogicalRects(grid, [0, 20], [
      { rowStart: 0, blockLines: [0, 10] },
      { rowStart: 1, blockLines: [10, 20] },
    ]);
    expect(rects.filter((rect) => rect.axis === "row" && rect.row === 1)).toHaveLength(1);
  });
});
