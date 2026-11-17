import { describe, expect, it } from "vitest";
import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";
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

// DM-X4W03B: a fixed box escapes an ancestor's overflow clip even when a
// nested opacity or z-index context opened inside that clip, because the clip
// moves inside the context's group.
describe("fixed boxes escaping clips through nested contexts (DM-X4W03B)", () => {
  const base = {
    color: "rgb(0, 0, 0)",
    borderColor: "rgb(0, 0, 0)",
    borderWidth: "0",
    borderRadius: "0",
    fontSize: "16px",
    fontFamily: "sans-serif",
    fontWeight: "400",
    fontStyle: "normal",
    backgroundImage: "none",
    borderTopWidth: "0",
    borderRightWidth: "0",
    borderBottomWidth: "0",
    borderLeftWidth: "0",
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    opacity: "1",
    transform: "none",
    overflowX: "visible",
    overflowY: "visible",
    display: "block",
    position: "static",
    zIndex: "auto",
    filter: "none",
    mixBlendMode: "normal",
    clipPath: "none",
    maskImage: "none",
    boxShadow: "none",
  };
  const box = (
    color: string,
    rect: [number, number, number, number],
    styles: Parameters<typeof capturedStyles>[0],
    children: ReturnType<typeof capturedElement>[] = [],
  ) =>
    capturedElement({
      tag: "div",
      text: "",
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      children,
      styles: capturedStyles({ ...base, backgroundColor: color, ...styles }),
    });
  // Clip-path groups enclosing the first shape filled with `color`.
  const clipDepth = (svg: string, color: string): number => {
    const stack: boolean[] = [];
    for (const match of svg.matchAll(/<g\b[^>]*>|<\/g>|<(?:rect|path)\b[^>]*>/g)) {
      const tag = match[0];
      if (tag === "</g>") stack.pop();
      else if (tag.startsWith("<g")) stack.push(tag.includes("clip-path="));
      else if (tag.includes(color)) return stack.filter(Boolean).length;
    }
    throw new Error(`no shape filled ${color} in ${svg}`);
  };
  const fixed = () => box("rgb(0, 0, 255)", [50, 20, 30, 30], { position: "fixed" });
  const sibling = () => box("rgb(255, 0, 0)", [10, 10, 90, 10], {});
  const clipper = (styles: Parameters<typeof capturedStyles>[0], children: ReturnType<typeof capturedElement>[]) =>
    box("rgba(0, 0, 0, 0)", [10, 10, 40, 40], { overflowX: "hidden", overflowY: "hidden", ...styles }, children);

  it("closes the clip around the fixed box inside a nested opacity context, not around its siblings", () => {
    const svg = elementTreeToSvg(
      [
        clipper({ opacity: "0.5" }, [
          box("rgba(0, 0, 0, 0)", [10, 10, 40, 40], { opacity: "0.5" }, [sibling(), fixed()]),
        ]),
      ],
      100,
      80,
    );
    expect(clipDepth(svg, "rgb(0,0,255)")).toBe(0);
    expect(clipDepth(svg, "rgb(255,0,0)")).toBeGreaterThan(0);
  });

  it("escapes a clip re-applied around a hoisted z-index context", () => {
    const svg = elementTreeToSvg(
      [clipper({}, [box("rgba(0, 0, 0, 0)", [10, 10, 40, 0], { position: "relative", zIndex: "1" }, [fixed()])])],
      100,
      80,
    );
    expect(clipDepth(svg, "rgb(0,0,255)")).toBe(0);
  });

  it("keeps the clip under a blending context, whose group does not commute with it", () => {
    const svg = elementTreeToSvg(
      [
        clipper({ opacity: "0.5" }, [
          box("rgba(0, 0, 0, 0)", [10, 10, 40, 40], { mixBlendMode: "multiply" }, [fixed()]),
        ]),
      ],
      100,
      80,
    );
    expect(clipDepth(svg, "rgb(0,0,255)")).toBeGreaterThan(0);
  });
});
