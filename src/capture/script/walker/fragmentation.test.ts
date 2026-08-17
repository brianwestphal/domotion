import { describe, expect, it } from "vitest";
import { detectInlineFragments } from "./fragmentation.js";

describe("detectInlineFragments", () => {
  it("keeps slice semantics for inline fragments split by block-in-inline layout (DM-2241)", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height,
    });
    const el = {
      getClientRects: () => [
        rect(32, 608, 58, 78),
        rect(32, 668, 760, 38),
        rect(32, 676, 30, 78),
      ],
    };
    const captured: any = {
      styles: {
        backgroundColor: "rgb(248, 250, 252)",
        backgroundImage: "none",
        borderTopWidth: "2px",
        borderRightWidth: "2px",
        borderBottomWidth: "2px",
        borderLeftWidth: "2px",
        boxDecorationBreak: "slice",
      },
    };

    detectInlineFragments(el, { display: "inline" }, { x: 10, y: 20 }, captured);

    expect(captured.inlineFragments).toEqual([
      { x: 22, y: 588, width: 58, height: 78 },
      { x: 22, y: 648, width: 760, height: 38 },
      { x: 22, y: 656, width: 30, height: 78 },
    ]);
    expect(captured.fragmentAxis).toBe("inline");
    expect(captured.styles.boxDecorationBreak).toBe("slice");
  });
});
