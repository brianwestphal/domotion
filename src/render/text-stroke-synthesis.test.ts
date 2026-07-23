import { describe, expect, it } from "vitest";

import { resolveFakeBoldTextStroke, skiaFakeBoldStrokeExtraPx } from "./embolden-outline.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// Chrome-on-Linux implements synthetic bold as a STROKE-frame inflation (Skia
// `SkScalerContextRec::useStrokeForFakeBold`, src/core/SkScalerContext.cpp:
// 1019-1041, reached from `SkTypeface_FreeType::onFilterRec`): a
// `-webkit-text-stroke` on a face that lacks the requested weight paints
// `cssWidth + fontSize*(1/24…1/32)` thick, and the fill dilates by half that
// extra. These tests lock the measured model (calibrated in the Playwright
// noble container against WenQuanYi Zen Hei, usWeightClass 500: weight ≤700
// paints a 2px stroke as 2px, weight ≥701 as ~4.25px at 72px) plus the
// platform gating — macOS/Windows synthesize bold without touching stroke
// width, so only `linux` inflates.

describe("skiaFakeBoldStrokeExtraPx (Skia SkTextFormatParams.h interpolation)", () => {
  it("uses textSize/24 at or below 9px", () => {
    expect(skiaFakeBoldStrokeExtraPx(9)).toBeCloseTo(9 / 24, 6);
    expect(skiaFakeBoldStrokeExtraPx(6)).toBeCloseTo(6 / 24, 6);
  });

  it("uses textSize/32 at or above 36px", () => {
    expect(skiaFakeBoldStrokeExtraPx(36)).toBeCloseTo(36 / 32, 6);
    expect(skiaFakeBoldStrokeExtraPx(64)).toBeCloseTo(2, 6);
    expect(skiaFakeBoldStrokeExtraPx(72)).toBeCloseTo(2.25, 6);
  });

  it("interpolates between 9px and 36px", () => {
    // Midpoint of the key range → midpoint of the scale range.
    const mid = skiaFakeBoldStrokeExtraPx(22.5);
    expect(mid).toBeCloseTo(22.5 * (1 / 24 + 1 / 32) / 2, 6);
    // The fixture's 22px callout row: between the endpoints' scales.
    const at22 = skiaFakeBoldStrokeExtraPx(22);
    expect(at22).toBeGreaterThan(22 / 32);
    expect(at22).toBeLessThan(22 / 24);
  });
});

describe("resolveFakeBoldTextStroke", () => {
  const base = { strokeWidthPx: 2, strokeFirst: false, fillIsTransparent: false, fontSizePx: 72 };

  it("linux + face lacks weight + default paint order: stroke inflates by extra, fill stays thin", () => {
    const r = resolveFakeBoldTextStroke({ ...base, faceLacksWeight: true, platform: "linux" });
    expect(r.strokeWidthPx).toBeCloseTo(2 + 2.25, 6);
    expect(r.emboldenFill).toBe(false);
  });

  it("linux + transparent fill (outline-only text): full inflated band, no embolden, even stroke-first", () => {
    const r = resolveFakeBoldTextStroke({ ...base, strokeFirst: true, fillIsTransparent: true, faceLacksWeight: true, platform: "linux" });
    expect(r.strokeWidthPx).toBeCloseTo(4.25, 6);
    expect(r.emboldenFill).toBe(false);
  });

  it("linux + stroke-first + opaque fill: fill emboldens, stroke width stays at the CSS width", () => {
    const r = resolveFakeBoldTextStroke({ ...base, strokeFirst: true, faceLacksWeight: true, platform: "linux" });
    expect(r.strokeWidthPx).toBe(2);
    expect(r.emboldenFill).toBe(true);
  });

  it("face has the weight: no inflation on any platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const r = resolveFakeBoldTextStroke({ ...base, faceLacksWeight: false, platform });
      expect(r.strokeWidthPx).toBe(2);
      expect(r.emboldenFill).toBe(false);
    }
  });

  it("macOS / Windows never inflate stroked runs even when the face lacks the weight", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const r = resolveFakeBoldTextStroke({ ...base, faceLacksWeight: true, platform });
      expect(r.strokeWidthPx).toBe(2);
      expect(r.emboldenFill).toBe(false);
    }
  });

  it("unstroked runs keep the DM-1693 behavior: embolden whenever the face lacks the weight", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(resolveFakeBoldTextStroke({ ...base, strokeWidthPx: 0, faceLacksWeight: true, platform }).emboldenFill).toBe(true);
      expect(resolveFakeBoldTextStroke({ ...base, strokeWidthPx: 0, faceLacksWeight: false, platform }).emboldenFill).toBe(false);
    }
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
