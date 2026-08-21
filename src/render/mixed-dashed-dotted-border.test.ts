import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll", borderColor: "rgb(248,81,73)",
  borderWidth: "4px", borderStyle: "solid", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "4px", borderRightWidth: "2px", borderBottomWidth: "6px", borderLeftWidth: "8px",
  borderTopColor: "rgb(248,81,73)", borderRightColor: "rgb(210,153,34)", borderBottomColor: "rgb(139,148,158)", borderLeftColor: "rgb(88,166,255)",
  borderTopStyle: "solid", borderRightStyle: "dashed", borderBottomStyle: "dotted", borderLeftStyle: "solid",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none", textDecoration: "none",
  textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)", textDecorationThickness: "auto",
  textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0", verticalAlign: "baseline", direction: "ltr",
  writingMode: "horizontal-tb", textOverflow: "clip", cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)",
  outlineWidth: "0", outlineStyle: "none", outlineOffset: "0", boxShadow: "none", opacity: "1", transform: "none",
  transformOrigin: "50% 50%", visibility: "visible", borderCollapse: "separate", overflowX: "visible", overflowY: "visible",
  scrollbarGutter: "auto", scrollWidth: 100, scrollHeight: 60, clientWidth: 100, clientHeight: 60, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto", maskPosition: "0% 0%",
  maskRepeat: "repeat", maskComposite: "add", listStyleType: "disc", listStyleImage: "none", display: "block",
  listStylePosition: "outside", paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

function render(overrides: Record<string, string>): string {
  const element: CapturedElement = {
    tag: "div", text: "", x: 10, y: 20, width: 100, height: 60, children: [],
    styles: { ...BASE_STYLES, ...overrides } as CapturedElement["styles"],
  };
  return elementTreeToSvgInner([element], 140, 100);
}

function stroke(svg: string, color: string): string {
  const match = svg.split("\n").find(line => line.includes("<line") && line.includes(`stroke="${color}"`));
  expect(match, `stroke ${color}`).toBeDefined();
  return match!;
}

describe("square mixed dashed/dotted border joints (DM-2429)", () => {
  it.each([
    ["right dashed beside wider top/bottom", {}, "rgb(210,153,34)", 'x1="109" y1="20" x2="109" y2="80"'],
    ["top dashed beside wider left/right", { borderTopStyle: "dashed", borderLeftWidth: "12px", borderRightWidth: "10px" }, "rgb(248,81,73)", 'x1="10" y1="22" x2="110" y2="22"'],
    ["bottom dashed with missing neighbors", { borderBottomStyle: "dashed", borderLeftStyle: "none", borderRightStyle: "none" }, "rgb(139,148,158)", 'x1="10" y1="77" x2="110" y2="77"'],
  ])("keeps the full outer-side path for %s", (_name, overrides, color, geometry) => {
    const line = stroke(render(overrides), color);
    expect(line).toContain(geometry);
    expect(line).toContain('clip-path="url(#');
  });

  it("insets thick-dot round-cap endpoints after computing phase from the full side", () => {
    const line = stroke(render({}), "rgb(139,148,158)");
    expect(line).toContain('x1="13" y1="77" x2="107" y2="77"');
    expect(line).toContain('stroke-width="6"');
    expect(line).toContain('stroke-linecap="round"');
    expect(line).toContain('clip-path="url(#');
  });

  it("retains explicit endpoint dots for the thin-dot branch", () => {
    const svg = render({ borderBottomWidth: "3px" });
    const dots = svg.split("\n").filter(line => line.includes("<rect") && line.includes('fill="rgb(139,148,158)"'));
    expect(dots).toHaveLength(1);
    expect(dots[0]).toContain('x="10"');
    expect(dots.every(dot => dot.includes('clip-path="url(#'))).toBe(true);
    const line = stroke(svg, "rgb(139,148,158)");
    expect(line).toContain('x1="17" y1="78.5" x2="110" y2="78.5"');
  });
});

describe("rounded mixed dashed/dotted border paths (DM-2430)", () => {
  const rounded = {
    borderRadius: "18px",
    borderTopLeftRadius: "18px", borderTopRightRadius: "18px",
    borderBottomRightRadius: "18px", borderBottomLeftRadius: "18px",
  };

  it.each([
    ["all corners", rounded],
    ["asymmetric corners", { ...rounded, borderTopRightRadius: "4px", borderBottomLeftRadius: "26px" }],
    ["missing adjacent side", { ...rounded, borderTopStyle: "none" }],
  ])("strokes one closed centerline and clips it to each side: %s", (_name, overrides) => {
    const svg = render(overrides);
    const paths = svg.split("\n").filter(line => line.includes("<path") && line.includes("stroke="));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain('stroke="rgb(210,153,34)"');
    expect(paths[1]).toContain('stroke="rgb(139,148,158)"');
    const d = /\bd="([^"]+)"/.exec(paths[0])?.[1];
    expect(d).toBeTruthy();
    expect(paths[1]).toContain(`d="${d}"`);
    expect(paths.every(path => path.includes('clip-path="url(#bc'))).toBe(true);
    expect(svg).not.toContain('<line x1="109" y1="20"');
  });

  it("keeps logical side thickness while the vector ring owns antialias clipping", () => {
    const svg = render({ ...rounded, borderTopWidth: "12px", borderLeftWidth: "10px" });
    const right = svg.split("\n").find(line => line.includes('<path') && line.includes('stroke="rgb(210,153,34)"'));
    expect(right).toContain('stroke-width="2"');
  });

  it("keeps the closed-path dash plan invariant when side colors and paint order change", () => {
    const first = render(rounded);
    const second = render({ ...rounded, borderRightColor: "rgb(1,2,3)", borderBottomColor: "rgb(4,5,6)" });
    const arrays = (svg: string) => [...svg.matchAll(/<path[^>]+stroke-dasharray="([^"]+)"/g)].map(match => match[1]);
    expect(arrays(second)).toEqual(arrays(first));
  });
});
