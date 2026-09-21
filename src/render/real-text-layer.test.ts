import { describe, expect, it } from "vitest";

import type { CapturedElement, TextSegment } from "../capture/types.js";
import { optimizeSvg } from "../post-processing/optimize.js";
import { wrapSvg } from "./element-tree-to-svg.js";
import { renderRealTextLayer, visualTextSemantics, withRealTextLayerVisualSemantics } from "./real-text-layer.js";

function element(textSegments: TextSegment[], children: CapturedElement[] = []): CapturedElement {
  return {
    tag: "p",
    text: textSegments.map((segment) => segment.text).join(""),
    x: 0,
    y: 0,
    width: 300,
    height: 80,
    textSegments,
    children,
    styles: { fontSize: "20px", fontFamily: "Never Load This Face", fontWeight: "400", direction: "ltr" },
  } as CapturedElement;
}

function mapped(text: string, source: string, node: number, x: number): TextSegment {
  const renderedChunks =
    text === source
      ? (() => {
          const chunks = [];
          let offset = 0;
          for (const char of source) {
            chunks.push({
              renderedUtf16Span: [offset, offset + char.length] as [number, number],
              domUtf16Span: [offset, offset + char.length] as [number, number],
            });
            offset += char.length;
          }
          return chunks;
        })()
      : [
          {
            renderedUtf16Span: [0, text.length] as [number, number],
            domUtf16Span: [0, source.length] as [number, number],
          },
        ];
  return {
    text,
    sourceText: source,
    sourceMapping: {
      source: "dom-text-utf16-v1",
      sourceTextNodeIndex: node,
      domText: source,
      domUtf16Span: [0, source.length],
      renderedChunks,
      role: "ordinary",
    },
    x,
    y: 10,
    width: 80,
    height: 24,
    xOffsets:
      text.length === source.length ? Array.from({ length: text.length }, (_, index) => x + index * 12) : undefined,
    fontAscent: 18,
  };
}

describe("real text layer (DM-1775)", () => {
  it("emits authored strings in source-node order with captured positions", () => {
    const child = element([mapped("middle", "middle", 1, 70)]);
    const root = element([mapped("tail", "tail", 2, 150), mapped("lead", "lead", 0, 10)], [child]);
    const svg = renderRealTextLayer([root]);

    expect(svg).toContain('data-domotion-real-text-layer="true" fill="none" stroke="none"');
    expect(svg.indexOf(">lead</text>")).toBeLessThan(svg.indexOf(">middle</text>"));
    expect(svg.indexOf(">middle</text>")).toBeLessThan(svg.indexOf(">tail</text>"));
    expect(svg).toContain('x="10 22 34 46" y="28"');
    expect(svg).not.toContain("Never Load This Face");
    expect(svg).not.toContain("font-family");
  });

  it("keeps generated runs in stable slots while sorting authored runs", () => {
    const generated: TextSegment = {
      text: "generated",
      x: 90,
      y: 10,
      width: 90,
      height: 24,
      fontAscent: 18,
    };
    const svg = renderRealTextLayer([
      element([mapped("tail", "tail", 2, 190), generated, mapped("lead", "lead", 0, 10)]),
    ]);

    expect(svg.indexOf(">lead</text>")).toBeLessThan(svg.indexOf(">generated</text>"));
    expect(svg.indexOf(">generated</text>")).toBeLessThan(svg.indexOf(">tail</text>"));
  });

  it("keeps authored text for a length-changing text-transform without guessing offsets", () => {
    const svg = renderRealTextLayer([element([mapped("SS", "ß", 0, 20)])]);
    expect(svg).toContain(">ß</text>");
    expect(svg).toContain('x="20"');
    expect(svg).toContain('textLength="80" lengthAdjust="spacingAndGlyphs"');
  });

  it("collapses UTF-16 coordinates to one SVG position per Unicode scalar", () => {
    const segment = mapped("A😀B", "A😀B", 0, 4);
    segment.xOffsets = [4, 16, 16, 40];
    const svg = renderRealTextLayer([element([segment])]);
    expect(svg).toContain('x="4 16 40"');
    expect(svg).toContain(">A😀B</text>");
  });

  it("suppresses duplicate visual-run labels only inside the opt-in scope", () => {
    expect(visualTextSemantics("hello")).toEqual({
      attrs: ' role="img" aria-label="hello"',
      title: "<title>hello</title>",
    });
    expect(withRealTextLayerVisualSemantics(() => visualTextSemantics("hello"))).toEqual({
      attrs: ' aria-hidden="true"',
      title: "",
    });
    expect(visualTextSemantics("hello").attrs).toContain('role="img"');
  });

  it("survives the production optimizer with both no-paint properties intact", () => {
    const inner = renderRealTextLayer([element([mapped("search me", "search me", 0, 10)])]);
    const optimized = optimizeSvg(wrapSvg(inner, 300, 80, { realTextLayer: true }));
    expect(optimized).toContain("data-domotion-real-text-layer");
    expect(optimized).toMatch(/fill="none"/);
    expect(optimized).toMatch(/stroke="none"/);
    expect(optimized).toContain("search me");
  });
});
