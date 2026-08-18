import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvg, parseBoxReflection } from "./element-tree-to-svg.js";

const baseStyles = {
  backgroundColor: "rgb(255,0,0)", backgroundImage: "none", borderWidth: "0", borderColor: "rgb(0,0,0)",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderRadius: "0", color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif",
  fontWeight: "400", fontStyle: "normal", opacity: "1", transform: "none",
  overflowX: "visible", overflowY: "visible", display: "block", position: "static",
  zIndex: "auto", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", boxShadow: "none",
} as unknown as CapturedElement["styles"];

function tree(reflect: string): CapturedElement[] {
  return [{ tag: "div", text: "", x: 10, y: 20, width: 100, height: 50, children: [], styles: { ...baseStyles, webkitBoxReflect: reflect } } as CapturedElement];
}

describe("-webkit-box-reflect vector duplication", () => {
  it("parses directions, signed/percentage offsets, and the computed nine-piece mask suffix", () => {
    expect(parseBoxReflection("below -8px linear-gradient(transparent 30%, black) 0 fill / auto / 0 stretch", 100, 50)).toEqual({
      direction: "below", offset: -8, maskImage: "linear-gradient(transparent 30%, black)",
    });
    expect(parseBoxReflection("left 25%", 80, 40)).toEqual({ direction: "left", offset: 20, maskImage: undefined });
    expect(parseBoxReflection("none", 80, 40)).toBeNull();
  });

  it.each([
    ["below 4px", "matrix(1 0 0 -1 0 144)"],
    ["above 4px", "matrix(1 0 0 -1 0 36)"],
    ["right 4px", "matrix(-1 0 0 1 224 0)"],
    ["left 4px", "matrix(-1 0 0 1 16 0)"],
  ])("duplicates the recursively rendered vector subtree for %s", (value, matrix) => {
    const svg = elementTreeToSvg(tree(value), 260, 180);
    expect(svg).toContain(`transform="${matrix}" aria-hidden="true"`);
    expect(svg.match(/fill="rgb\(255,0,0\)"/g)).toHaveLength(2);
    expect(svg).not.toContain("<image");
  });

  it("applies a computed gradient as an alpha mask to only the reflected copy", () => {
    const svg = elementTreeToSvg(tree("below 0px linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.8)) 0 fill / auto / 0 stretch"), 260, 180);
    expect(svg).toContain('mask-type:alpha');
    expect(svg).toContain('id="reflect-mask');
    expect(svg.match(/fill="rgb\(255,0,0\)"/g)).toHaveLength(2);
  });
});
