import { describe, expect, it } from "vitest";

import { resolveFakeBoldTextPaint } from "./embolden-outline.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// Paint-order coverage lives here because this file also owns the captured
// `-webkit-text-stroke` tree controls below. Skia's fill and author stroke are
// separate scaler records; opaque stroke-first synthetic text therefore needs
// two SVG passes over the same source outline on every desktop backend.
describe("synthetic-bold text-stroke paint ordering", () => {
  it("does not make a platform-only exception for author strokes", () => {
    const records = (["darwin", "linux", "win32"] as const).map((platform) =>
      resolveFakeBoldTextPaint({
        strokeWidthPx: 3,
        strokeFirst: true,
        fillIsTransparent: false,
        faceLacksWeight: true,
        fontSizePx: 36,
        platform,
      }));
    for (const record of records) {
      expect(record.stages).toEqual(records[0].stages);
      expect(record.svgPasses).toEqual(records[0].svgPasses);
      expect(record.svgPasses.map((pass) => pass.kind)).toEqual([
        "author-stroke", "synthetic-fill",
      ]);
    }
  });

  it("keeps both paint colours visible for opaque stroke-first", () => {
    const record = resolveFakeBoldTextPaint({
      strokeWidthPx: 3,
      strokeFirst: true,
      fillIsTransparent: false,
      faceLacksWeight: true,
      fontSizePx: 36,
    });
    expect(record.svgPasses[0]).toMatchObject({ fill: "none", stroke: "author" });
    expect(record.svgPasses[1]).toMatchObject({ fill: "source", stroke: "source-fill" });
    expect(record.svgPasses[0].strokeWidthPx).toBeCloseTo(3 + 36 / 32, 8);
    expect(record.svgPasses[1].strokeWidthPx).toBeCloseTo(36 / 32, 8);
  });
});

// ── background-clip:text + -webkit-text-stroke (the gradient-headline stroke) ──
//
// Chrome paints the bg-clip:text gradient as the element's BACKGROUND (clipped
// to the text ink) and then paints the text's own foreground on top — with
// `-webkit-text-fill-color: transparent` that foreground is just the
// `-webkit-text-stroke`. The renderer's mask path used to drop that stroke
// entirely (it only painted the masked gradient rect; the mask copy even
// carried the stroke as a useless luminance-0 ring). Lock the fixed shape:
// a strokeless glyph mask, plus a visible transparent-fill stroke pass painted
// AFTER the masked rect. The `20-deep-text-stroke` html-test fixture is the
// visual gate for the same behavior.

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundClip: "border-box",
  backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(0,0,0)", fontSize: "64px", fontFamily: "sans-serif", fontWeight: "800", fontStyle: "normal",
  lineHeight: "70px", overflowX: "visible", overflowY: "visible", display: "block",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", textShadow: "none", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none",
  opacity: "1", transform: "none", visibility: "visible", position: "static", zIndex: "auto",
} as unknown as CapturedElement["styles"];

function gradientStrokeTree(paintOrder?: string): CapturedElement[] {
  const el: CapturedElement = {
    tag: "p", text: "INK", x: 40, y: 100, width: 400, height: 80, children: [],
    fontAscent: 60,
    styles: {
      ...BASE_STYLES,
      backgroundImage: "linear-gradient(135deg, rgb(236, 72, 153), rgb(109, 40, 217))",
      backgroundClip: "text",
      webkitTextFillColor: "rgba(0, 0, 0, 0)",
      webkitTextStrokeWidth: "2px",
      webkitTextStrokeColor: "rgb(15, 23, 42)",
      ...(paintOrder != null ? { paintOrder } : {}),
    } as CapturedElement["styles"],
  } as CapturedElement;
  return [el];
}

describe("background-clip:text emits the -webkit-text-stroke pass", () => {
  for (const [label, po] of [["paint-order: stroke fill", "stroke fill"], ["default paint order", undefined]] as const) {
    it(`${label}: masked gradient rect first, stroke pass on top, strokeless mask`, () => {
      const svg = elementTreeToSvgInner(gradientStrokeTree(po), 500, 250);

      // The glyph mask exists and its body carries NO stroke — the mask is the
      // pure fill silhouette (the stroke paints visibly, not into the mask).
      const mask = /<mask id="(tbgm[^"]*)"[^>]*>([\s\S]*?)<\/mask>/.exec(svg);
      expect(mask).not.toBeNull();
      expect(mask![2]).not.toContain("stroke=");

      // A masked gradient rect is painted…
      const rectIdx = svg.indexOf(`mask="url(#${mask![1]})"`);
      expect(rectIdx).toBeGreaterThan(-1);

      // …and a transparent-fill stroke pass in the stroke color paints AFTER it
      // (the stroke is the text's foreground: always on top of the background
      // gradient — `paint-order` only sequences the text's own fill vs stroke,
      // and the fill is transparent).
      const strokeIdx = svg.indexOf(`stroke="rgb(15, 23, 42)"`, svg.indexOf("</defs>") >= 0 ? svg.indexOf("</defs>") : 0);
      const visibleStroke = svg.slice(rectIdx);
      expect(visibleStroke).toContain(`stroke="rgb(15, 23, 42)"`);
      expect(strokeIdx).toBeGreaterThan(-1);
    });
  }
});
