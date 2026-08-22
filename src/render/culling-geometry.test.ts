import { describe, expect, it } from "vitest";

import type { CapturedElement, CapturedStyles } from "../capture/types.js";
import { buildRendererCullGeometry } from "./culling-geometry.js";

function styles(overrides: Partial<CapturedStyles> = {}): CapturedStyles {
  return {
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    backgroundClip: "border-box",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    borderRadius: "0px",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    borderTopColor: "rgba(0, 0, 0, 0)",
    borderRightColor: "rgba(0, 0, 0, 0)",
    borderBottomColor: "rgba(0, 0, 0, 0)",
    borderLeftColor: "rgba(0, 0, 0, 0)",
    borderCollapse: "separate",
    borderImageSource: "none",
    borderImageSlice: "100%",
    borderImageWidth: "1",
    borderImageOutset: "0px",
    borderImageRepeat: "stretch",
    overflowX: "visible",
    overflowY: "visible",
    scrollbarGutter: "auto",
    scrollWidth: 0,
    scrollHeight: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollTop: 0,
    scrollLeft: 0,
    objectFit: "fill",
    objectPosition: "50% 50%",
    filter: "none",
    backdropFilter: "none",
    mixBlendMode: "normal",
    clipPath: "none",
    mask: "none",
    maskImage: "none",
    maskMode: "match-source",
    maskSize: "auto",
    maskPosition: "0% 0%",
    maskRepeat: "repeat",
    maskComposite: "add",
    listStyleType: "none",
    listStyleImage: "none",
    listStylePosition: "outside",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
    zIndex: "auto",
    position: "static",
    float: "none",
    order: "0",
    flexDirection: "row",
    color: "rgb(0, 0, 0)",
    fontSize: "16px",
    fontFamily: "Arial",
    fontWeight: "400",
    opacity: "1",
    visibility: "visible",
    outlineStyle: "none",
    outlineWidth: "0px",
    outlineColor: "rgb(0, 0, 0)",
    outlineOffset: "0px",
    boxShadow: "none",
    textShadow: "none",
    transform: "none",
    transformOrigin: "50% 50%",
    ...overrides,
  } as CapturedStyles;
}

function el(
  x: number,
  y: number,
  width: number,
  height: number,
  styleOverrides: Partial<CapturedStyles> = {},
  children: CapturedElement[] = [],
): CapturedElement {
  return { tag: "div", text: "", x, y, width, height, styles: styles(styleOverrides), children };
}

describe("renderer-owned viewBox-culling geometry", () => {
  it("uses generated descendant geometry for a transparent carrier fill box", () => {
    const child = el(300, 100, 20, 20, { backgroundColor: "rgb(220, 20, 60)" });
    const carrier = el(0, 0, 400, 200, {}, [child]);
    const facts = buildRendererCullGeometry(carrier, 800, 600).get(carrier)!;
    expect(facts.referenceBoxes.fillBox).toEqual({
      kind: "exact",
      box: { x: 300, y: 100, w: 20, h: 20 },
    });
    expect(facts.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 300, y: 100, w: 20, h: 20 },
    });
  });

  it("keeps fill, stroke, and visual surfaces distinct", () => {
    const target = el(300, 100, 20, 20, {
      backgroundColor: "rgb(20, 100, 220)",
      outlineStyle: "solid",
      outlineWidth: "4px",
      outlineOffset: "2px",
      outlineColor: "rgb(0, 0, 0)",
      boxShadow: "rgb(0, 0, 0) 10px 0px 4px 2px",
    });
    const facts = buildRendererCullGeometry(target, 800, 600).get(target)!;
    expect(facts.referenceBoxes.fillBox).toEqual({
      kind: "exact",
      box: { x: 296, y: 96, w: 36, h: 28 },
    });
    expect(facts.referenceBoxes.strokeBox).toEqual({
      kind: "exact",
      box: { x: 294, y: 94, w: 38, h: 32 },
    });
    expect(facts.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 294, y: 86, w: 50, h: 48 },
    });
    expect(facts.referenceBoxes.viewBox).toEqual({
      kind: "exact",
      box: { x: 0, y: 0, w: 800, h: 600 },
    });
  });

  it("clips overflow-visible descendant paint at the emitted child clip", () => {
    const child = el(750, 20, 200, 30, { backgroundColor: "red" });
    const parent = el(900, 0, 100, 100, {
      overflowX: "hidden",
      overflowY: "hidden",
      backgroundColor: "blue",
    }, [child]);
    const facts = buildRendererCullGeometry(parent, 800, 600).get(parent)!;
    expect(facts.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 900, y: 0, w: 100, h: 100 },
    });
    // Reference boxes ignore clips, matching SVG getBBox/ObjectBoundingBox.
    expect(facts.referenceBoxes.fillBox).toEqual({
      kind: "exact",
      box: { x: 750, y: 0, w: 250, h: 100 },
    });
  });

  it("maps a frozen static rotation before making a static cull decision", () => {
    const target = el(900, 100, 200, 80, {
      backgroundColor: "red",
      transform: "matrix(-1, 0, 0, -1, 0, 0)",
      transformOrigin: "0px 0px",
    });
    const facts = buildRendererCullGeometry(target, 800, 600).get(target)!;
    expect(facts.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 700, y: 20, w: 200, h: 80 },
    });
    expect(facts.hasStaticTransformPath).toBe(true);
  });

  it("accepts only the planar matrix3d subset and elides an exact identity", () => {
    const affine3d = el(10, 20, 30, 40, {
      backgroundColor: "red",
      transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 60, 0, 1)",
      transformOrigin: "0px 0px",
    });
    const projective3d = el(10, 20, 30, 40, {
      backgroundColor: "red",
      transform: "matrix3d(1, 0, 0, 0.001, 0, 1, 0, 0, 0, 0, 1, 0, 50, 60, 0, 1)",
      transformOrigin: "0px 0px",
    });
    const identity = el(10, 20, 30, 40, {
      backgroundColor: "red",
      transform: "matrix(1, 0, 0, 1, 0, 0)",
    });
    const index = buildRendererCullGeometry([affine3d, projective3d, identity], 800, 600);
    expect(index.get(affine3d)!.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 60, y: 80, w: 30, h: 40 },
    });
    expect(index.get(projective3d)!.visualBounds.kind).toBe("unknown");
    expect(index.get(identity)!.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 10, y: 20, w: 30, h: 40 },
    });
    expect(index.get(identity)!.hasStaticTransformPath).toBe(false);
  });

  it("uses exact emitted raster rectangles, independent of DPR metadata", () => {
    const target = el(900, 10, 400, 200);
    target.replacedSnapshot = {
      x: 120,
      y: 40,
      width: 80,
      height: 30,
      rid: "r0",
      dataUri: "data:image/png;base64,AA==",
      rasterToOutput: {
        contentQuad: [120, 40, 200, 40, 200, 70, 120, 70],
        pixelWidth: 160,
        pixelHeight: 60,
        cssPerPixelX: 0.5,
        cssPerPixelY: 0.5,
      },
    };
    const facts = buildRendererCullGeometry(target, 800, 600).get(target)!;
    expect(facts.visualBounds).toEqual({ kind: "bounded", box: { x: 120, y: 40, w: 80, h: 30 } });
  });

  it("retains an atomic raster whose separately emitted reflection can enter", () => {
    const target = el(900, 10, 100, 40, { webkitBoxReflect: "left 200px" });
    target.transformSubtreeRaster = {
      x: 900,
      y: 10,
      width: 100,
      height: 40,
      dataUri: "data:image/png;base64,AA==",
    };
    const facts = buildRendererCullGeometry(target, 800, 600).get(target)!;
    expect(facts.visualBounds).toEqual({
      kind: "unknown",
      reason: "atomic-raster-reflection-owner",
    });
  });

  it("retains unknown ink, empty facts, and singular static transforms", () => {
    const text = el(900, 0, 100, 20);
    text.text = "glyph ink";
    const singular = el(900, 0, 100, 20, {
      backgroundColor: "red",
      transform: "matrix(0, 0, 0, 1, 0, 0)",
    });
    const empty = el(900, 0, 100, 20);
    const index = buildRendererCullGeometry([text, singular, empty], 800, 600);
    expect(index.get(text)!.visualBounds.kind).toBe("unknown");
    expect(index.get(singular)!.visualBounds.kind).toBe("unknown");
    expect(index.get(empty)!.visualBounds.kind).toBe("empty");
  });

  it("keeps split backdrop surfaces and a collapsed unknown clip fail-closed", () => {
    const backdrop = el(900, 0, 100, 20, { backgroundColor: "red" });
    backdrop.backdropFilterRaster = {
      x: 900, y: 0, width: 100, height: 20, dataUri: "data:image/png;base64,AA==",
    };
    const unknownChild = el(900, 0, 100, 20);
    unknownChild.text = "unknown ink";
    const zeroClip = el(900, 0, 0, 0, {
      overflowX: "hidden",
      overflowY: "hidden",
    }, [unknownChild]);
    const index = buildRendererCullGeometry([backdrop, zeroClip], 800, 600);
    expect(index.get(backdrop)!.visualBounds).toEqual({
      kind: "unknown",
      reason: "split-backdrop-raster-owner",
    });
    expect(index.get(zeroClip)!.visualBounds).toEqual({ kind: "empty" });
  });

  it("does not turn nested one-axis clips into a finite two-axis proof", () => {
    const text = el(900, 20, 100, 20);
    text.text = "unknown horizontal ink";
    const inner = el(900, 0, 100, 100, {
      overflowX: "visible",
      overflowY: "clip",
    }, [text]);
    const outer = el(900, 0, 100, 100, {
      overflowX: "visible",
      overflowY: "clip",
    }, [inner]);
    const index = buildRendererCullGeometry(outer, 800, 600);
    expect(index.get(text)!.visualBounds.kind).toBe("unknown");
    expect(index.get(inner)!.visualBounds.kind).toBe("unknown");
    expect(index.get(outer)!.visualBounds.kind).toBe("unknown");
  });

  it("separates bounded visual chrome from unavailable exact reference geometry", () => {
    const control = el(20, 30, 100, 40);
    control.tag = "input";
    const inset = el(200, 30, 100, 40, {
      backgroundColor: "red",
      boxShadow: "inset 4px 0 8px 2px black",
    });
    const fragmented = el(400, 30, 180, 80, { backgroundColor: "red" });
    fragmented.inlineFragments = [
      { x: 400, y: 30, width: 120, height: 30 },
      { x: 400, y: 60, width: 80, height: 30 },
    ];
    const index = buildRendererCullGeometry([control, inset, fragmented], 800, 600);
    expect(index.get(control)!.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 20, y: 30, w: 100, h: 40 },
    });
    expect(index.get(control)!.referenceBoxes.fillBox.kind).toBe("unknown");
    expect(index.get(inset)!.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 200, y: 30, w: 100, h: 40 },
    });
    expect(index.get(inset)!.referenceBoxes.fillBox.kind).toBe("unknown");
    expect(index.get(fragmented)!.referenceBoxes.fillBox.kind).toBe("unknown");
  });

  it("unions materialized partial-native ink and retains an unavailable reservation", () => {
    const materialized = el(20, 30, 100, 40);
    materialized.tag = "select";
    materialized.nativeControlDecorationRaster = {
      x: 19,
      y: 29,
      width: 102,
      height: 42,
      kinds: ["menulist-button-arrow"],
      dataUri: "data:image/png;base64,AA==",
    };
    const missing = el(220, 30, 100, 40);
    missing.tag = "input";
    missing.nativeControlDecorationRaster = {
      x: 219,
      y: 29,
      width: 102,
      height: 42,
      kinds: ["search-cancel-button"],
    };
    const index = buildRendererCullGeometry([materialized, missing], 800, 600);
    expect(index.get(materialized)!.visualBounds).toEqual({
      kind: "bounded",
      box: { x: 19, y: 29, w: 102, h: 42 },
    });
    expect(index.get(missing)!.visualBounds).toEqual({
      kind: "unknown",
      reason: "native-decoration-raster-unavailable",
    });
  });
});
