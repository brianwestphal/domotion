/**
 * Renderer-owned geometry facts for viewBox paint suppression (DM-2460).
 *
 * The culler must reason about the SVG this renderer emits, not the source
 * element's HTML border box.  Reference boxes therefore require exact emitted
 * geometry, while visual bounds may be conservative supersets.  Any channel
 * whose emitted ink cannot be bounded from renderer-owned facts is explicit
 * `unknown`; callers must retain that subtree.
 *
 * Blink source contract (repository-pinned Chromium revision):
 * - core/layout/svg/transform_helper.cc:93-149
 * - core/style/computed_style.cc:1372-1490
 * - core/paint/svg_{container,model_object}_painter.cc
 */

import type { CapturedElement } from "../capture/types.js";
import {
  invertSvgAffine,
  multiplySvgAffine,
  type SvgAffineMatrix,
} from "../capture/svg-affine-freeze.js";
import { parseBoxShadow } from "./box-shadow.js";
import { parseCornerRadii } from "./borders.js";
import { parseColor } from "./colors.js";
import {
  capturedBoxRespectsCssOverflow,
  isOverflowReplacedElement,
  isOverflowRespectingReplacedElement,
  overflowClipMarginGeometry,
  usedOverflowClipMargin,
} from "./overflow-clip.js";
import { cssTransformToSvg } from "./transforms.js";

export interface RendererCullBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RendererVisualBounds =
  | { kind: "bounded"; box: RendererCullBox }
  | { kind: "empty" }
  | { kind: "unknown"; reason: string };

export type RendererReferenceBox =
  | { kind: "exact"; box: RendererCullBox }
  | { kind: "empty" }
  | { kind: "unknown"; reason: string };

export interface RendererOwnedCullGeometry {
  /** Visual surface in the generated root SVG's user coordinate system. */
  visualBounds: RendererVisualBounds;
  /** Geometry of the generated animation wrapper before its own transform. */
  referenceBoxes: {
    fillBox: RendererReferenceBox;
    strokeBox: RendererReferenceBox;
    viewBox: RendererReferenceBox;
  };
  /** Static SVG wrapper exists on this element or an emitted ancestor. */
  hasStaticTransformPath: boolean;
  /** A descendant animation can make a container reference box time-varying. */
  referenceBoxMayAnimate: boolean;
  /** Renderer returns after this surface and does not emit captured children. */
  suppressesDescendants: boolean;
}

export interface RendererCullGeometryIndex {
  get(element: CapturedElement): RendererOwnedCullGeometry | undefined;
}

type LocalNodeGeometry = {
  fill: RendererReferenceBox;
  stroke: RendererReferenceBox;
  visual: RendererVisualBounds;
  staticMatrix: SvgAffineMatrix | "identity" | null;
  hasAnimatedDescendant: boolean;
  suppressesDescendants: boolean;
};

type AxisClip = {
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
};

const IDENTITY: SvgAffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function finiteBox(box: RendererCullBox): boolean {
  return Number.isFinite(box.x) && Number.isFinite(box.y)
    && Number.isFinite(box.w) && Number.isFinite(box.h)
    && box.w >= 0 && box.h >= 0;
}

function box(x: number, y: number, w: number, h: number): RendererCullBox | null {
  const value = { x, y, w, h };
  return finiteBox(value) ? value : null;
}

function unionBox(left: RendererCullBox, right: RendererCullBox): RendererCullBox {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.max(left.y + left.h, right.y + right.h);
  return { x, y, w: rightEdge - x, h: bottomEdge - y };
}

function unionVisual(left: RendererVisualBounds, right: RendererVisualBounds): RendererVisualBounds {
  if (left.kind === "unknown") return left;
  if (right.kind === "unknown") return right;
  if (left.kind === "empty") return right;
  if (right.kind === "empty") return left;
  return { kind: "bounded", box: unionBox(left.box, right.box) };
}

function unionReference(left: RendererReferenceBox, right: RendererReferenceBox): RendererReferenceBox {
  if (left.kind === "unknown") return left;
  if (right.kind === "unknown") return right;
  if (left.kind === "empty") return right;
  if (right.kind === "empty") return left;
  return { kind: "exact", box: unionBox(left.box, right.box) };
}

function mapBox(value: RendererCullBox, matrix: SvgAffineMatrix): RendererCullBox | null {
  const points = [
    [value.x, value.y],
    [value.x + value.w, value.y],
    [value.x, value.y + value.h],
    [value.x + value.w, value.y + value.h],
  ] as const;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of points) {
    xs.push(matrix.a * x + matrix.c * y + matrix.e);
    ys.push(matrix.b * x + matrix.d * y + matrix.f);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return box(minX, minY, maxX - minX, maxY - minY);
}

function mapVisual(value: RendererVisualBounds, matrix: SvgAffineMatrix | "identity" | null): RendererVisualBounds {
  if (matrix == null) return { kind: "unknown", reason: "static-transform-unavailable-or-singular" };
  if (matrix === "identity" || value.kind !== "bounded") return value;
  const mapped = mapBox(value.box, matrix);
  return mapped == null
    ? { kind: "unknown", reason: "static-transform-non-finite" }
    : { kind: "bounded", box: mapped };
}

function mapReference(value: RendererReferenceBox, matrix: SvgAffineMatrix | "identity" | null): RendererReferenceBox {
  if (matrix == null) return { kind: "unknown", reason: "static-transform-unavailable-or-singular" };
  if (matrix === "identity" || value.kind !== "exact") return value;
  const mapped = mapBox(value.box, matrix);
  return mapped == null
    ? { kind: "unknown", reason: "static-transform-non-finite" }
    : { kind: "exact", box: mapped };
}

function intersectBoxWithClip(value: RendererCullBox, clip: AxisClip): RendererCullBox | null {
  const minX = Math.max(value.x, clip.minX ?? Number.NEGATIVE_INFINITY);
  const maxX = Math.min(value.x + value.w, clip.maxX ?? Number.POSITIVE_INFINITY);
  const minY = Math.max(value.y, clip.minY ?? Number.NEGATIVE_INFINITY);
  const maxY = Math.min(value.y + value.h, clip.maxY ?? Number.POSITIVE_INFINITY);
  return maxX > minX && maxY > minY ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/** An exact finite clip bounds even otherwise-unknown descendant ink. */
function clipVisual(value: RendererVisualBounds, clip: AxisClip | null): RendererVisualBounds {
  if (clip == null || value.kind === "empty") return value;
  if (value.kind === "unknown") {
    if (clip.minX == null || clip.maxX == null || clip.minY == null || clip.maxY == null) return value;
    const clipped = box(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    return clipped == null || clipped.w === 0 || clipped.h === 0
      ? { kind: "empty" }
      : { kind: "bounded", box: clipped };
  }
  const clipped = intersectBoxWithClip(value.box, clip);
  return clipped == null ? { kind: "empty" } : { kind: "bounded", box: clipped };
}

function intersectClips(left: AxisClip | null, right: AxisClip | null): AxisClip | null {
  if (left == null) return right;
  if (right == null) return left;
  const lower = (a: number | undefined, b: number | undefined): number | undefined =>
    a == null ? b : b == null ? a : Math.max(a, b);
  const upper = (a: number | undefined, b: number | undefined): number | undefined =>
    a == null ? b : b == null ? a : Math.min(a, b);
  return {
    minX: lower(left.minX, right.minX),
    maxX: upper(left.maxX, right.maxX),
    minY: lower(left.minY, right.minY),
    maxY: upper(left.maxY, right.maxY),
  };
}

function mapClip(value: AxisClip, matrix: SvgAffineMatrix): AxisClip | null {
  if (value.minX == null || value.maxX == null || value.minY == null || value.maxY == null) {
    // A one-axis clip under rotation/shear no longer stays axis separable. It
    // cannot safely narrow an unknown surface, so discard only the narrowing.
    if (matrix.b !== 0 || matrix.c !== 0) return null;
    const x0 = value.minX == null ? undefined : matrix.a * value.minX + matrix.e;
    const x1 = value.maxX == null ? undefined : matrix.a * value.maxX + matrix.e;
    const y0 = value.minY == null ? undefined : matrix.d * value.minY + matrix.f;
    const y1 = value.maxY == null ? undefined : matrix.d * value.maxY + matrix.f;
    return {
      minX: x0 == null || x1 == null ? undefined : Math.min(x0, x1),
      maxX: x0 == null || x1 == null ? undefined : Math.max(x0, x1),
      minY: y0 == null || y1 == null ? undefined : Math.min(y0, y1),
      maxY: y0 == null || y1 == null ? undefined : Math.max(y0, y1),
    };
  }
  const mapped = mapBox({
    x: value.minX,
    y: value.minY,
    w: value.maxX - value.minX,
    h: value.maxY - value.minY,
  }, matrix);
  return mapped == null ? null : {
    minX: mapped.x,
    maxX: mapped.x + mapped.w,
    minY: mapped.y,
    maxY: mapped.y + mapped.h,
  };
}

function parseFinitePx(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return 0;
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/i.test(value.trim())) return null;
  const result = Number.parseFloat(value);
  return Number.isFinite(result) ? result : null;
}

function parseOptionalColor(value: string | undefined): ReturnType<typeof parseColor> {
  return value == null || value === "" ? null : parseColor(value);
}

function elementStaticMatrix(el: CapturedElement): SvgAffineMatrix | "identity" | null {
  const projective = el.projectiveTransform;
  if (projective != null) {
    if (projective.length !== 9 || projective.some((value) => !Number.isFinite(value))) return null;
    if (projective[6] !== 0 || projective[7] !== 0 || projective[8] !== 1) return null;
    const matrix = { a: projective[0], b: projective[3], c: projective[1], d: projective[4], e: projective[2], f: projective[5] };
    return invertSvgAffine(matrix) == null ? null : matrix;
  }
  const transform = el.styles.transform;
  if (transform == null || transform === "" || transform === "none") return "identity";
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
  if (matrix3d != null) {
    const values = matrix3d[1].split(",").map((value) => Number.parseFloat(value.trim()));
    // SVG can own only the planar subset. Capture normally promotes a truly
    // projective/3D owner to `transformSubtreeRaster`; if serialized input is
    // missing that surface, retaining is the only sound culling decision.
    const isPlanar = values.length === 16
      && values.every(Number.isFinite)
      && values[2] === 0 && values[3] === 0
      && values[6] === 0 && values[7] === 0
      && values[8] === 0 && values[9] === 0
      && values[10] === 1 && values[11] === 0
      && values[14] === 0 && values[15] === 1;
    if (!isPlanar) return null;
  }
  const origin = (el.styles.transformOrigin ?? "").trim().split(/\s+/);
  const localX = Number.parseFloat(origin[0] ?? "");
  const localY = Number.parseFloat(origin[1] ?? "");
  const originX = el.x + (Number.isFinite(localX) ? localX : el.width / 2);
  const originY = el.y + (Number.isFinite(localY) ? localY : el.height / 2);
  const emitted = cssTransformToSvg(transform, originX, originY);
  if (emitted === "") {
    // cssTransformToSvg deliberately elides an exact identity matrix. It also
    // returns an empty string for unsupported syntax, so recognize identity
    // from the computed matrix grammar rather than treating every empty
    // serialization as safe.
    const matrix2d = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(transform);
    const values = matrix2d != null
      ? matrix2d.slice(1).map(Number)
      : matrix3d != null
        ? matrix3d[1].split(",").map((value) => Number.parseFloat(value.trim()))
        : [];
    const identity = values.length === 6
      ? values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1 && values[4] === 0 && values[5] === 0
      : values.length === 16
        && values.every((value, index) => value === ([0, 5, 10, 15].includes(index) ? 1 : 0));
    return identity ? "identity" : null;
  }

  const translate = (source: string): SvgAffineMatrix | null => {
    const match = /^translate\(\s*([-\d.eE+]+)(?:[ ,]+([-\d.eE+]+))?\s*\)$/.exec(source);
    if (match == null) return null;
    const x = Number(match[1]);
    const y = match[2] == null ? 0 : Number(match[2]);
    return Number.isFinite(x) && Number.isFinite(y) ? { a: 1, b: 0, c: 0, d: 1, e: x, f: y } : null;
  };
  const matrix = (source: string): SvgAffineMatrix | null => {
    const match = /^matrix\(\s*([-\d.eE+]+)[ ,]+([-\d.eE+]+)[ ,]+([-\d.eE+]+)[ ,]+([-\d.eE+]+)[ ,]+([-\d.eE+]+)[ ,]+([-\d.eE+]+)\s*\)$/.exec(source);
    if (match == null) return null;
    const values = match.slice(1).map(Number);
    if (values.some((value) => !Number.isFinite(value))) return null;
    return { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
  };
  const parts = emitted.match(/(?:translate|matrix)\([^)]*\)/g);
  if (parts == null || parts.join(" ") !== emitted) return null;
  let result = IDENTITY;
  for (const part of parts) {
    const operation = part.startsWith("translate") ? translate(part) : matrix(part);
    if (operation == null) return null;
    result = multiplySvgAffine(result, operation);
  }
  if (invertSvgAffine(result) == null) return null;
  return result;
}

function hasVisibleBorder(el: CapturedElement): boolean {
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  return sides.some((side) => {
    const width = parseFinitePx(el.styles[`border${side}Width`]);
    const style = el.styles[`border${side}Style`];
    const color = parseOptionalColor(el.styles[`border${side}Color`]);
    return width != null && width > 0 && style !== "none" && style !== "hidden" && (color == null || color.a > 0.01);
  });
}

function elementPaintsFullBorderBox(el: CapturedElement): boolean {
  const background = parseOptionalColor(el.styles.backgroundColor);
  if (background != null && background.a > 0.01) return true;
  if (el.styles.frostedBgFallback != null) return true;
  return false;
}

function ownGeometry(el: CapturedElement): {
  fill: RendererReferenceBox;
  stroke: RendererReferenceBox;
  visual: RendererVisualBounds;
  atomic: boolean;
  suppressesDescendants: boolean;
} {
  if (el.projectiveHidden === true || (Number.parseFloat(el.styles.opacity) === 0 && !(el.animatedProperties ?? []).includes("opacity"))) {
    return {
      fill: { kind: "empty" }, stroke: { kind: "empty" }, visual: { kind: "empty" },
      atomic: true, suppressesDescendants: true,
    };
  }
  const atomicRaster = el.urlFilterRaster ?? el.transformSubtreeRaster ?? el.nativeControlRaster;
  if (atomicRaster != null) {
    if ("empty" in atomicRaster && atomicRaster.empty === true) {
      return {
        fill: { kind: "empty" }, stroke: { kind: "empty" }, visual: { kind: "empty" },
        atomic: true, suppressesDescendants: true,
      };
    }
    if (atomicRaster.dataUri == null) {
      const unknown = { kind: "unknown" as const, reason: "atomic-raster-unavailable" };
      return { fill: unknown, stroke: unknown, visual: unknown, atomic: true, suppressesDescendants: true };
    }
    // `appendBoxReflection` duplicates the emitted atomic image outside its
    // source wrapper and applies a second matrix (plus an optional mask). The
    // captured raster rectangle therefore does not bound the complete paint,
    // and the two copies do not currently share one animation/reference-box
    // owner. Retain instead of accidentally culling a reflection that enters
    // the viewport while its source stays outside.
    if (el.styles.webkitBoxReflect != null
        && el.styles.webkitBoxReflect !== ""
        && el.styles.webkitBoxReflect !== "none") {
      const unknown = { kind: "unknown" as const, reason: "atomic-raster-reflection-owner" };
      return { fill: unknown, stroke: unknown, visual: unknown, atomic: true, suppressesDescendants: true };
    }
    const rasterBox = box(atomicRaster.x, atomicRaster.y, atomicRaster.width, atomicRaster.height);
    if (rasterBox == null || rasterBox.w === 0 || rasterBox.h === 0) {
      const unknown = { kind: "unknown" as const, reason: "atomic-raster-empty-or-invalid" };
      return { fill: unknown, stroke: unknown, visual: unknown, atomic: true, suppressesDescendants: true };
    }
    return {
      fill: { kind: "exact", box: rasterBox },
      stroke: { kind: "exact", box: rasterBox },
      visual: { kind: "bounded", box: rasterBox },
      atomic: true,
      suppressesDescendants: true,
    };
  }

  let fill: RendererReferenceBox = { kind: "empty" };
  let stroke: RendererReferenceBox = { kind: "empty" };
  let visual: RendererVisualBounds = { kind: "empty" };
  const borderBox = box(el.x, el.y, el.width, el.height);
  if (borderBox == null) {
    const unknown = { kind: "unknown" as const, reason: "element-box-non-finite" };
    return { fill: unknown, stroke: unknown, visual: unknown, atomic: false, suppressesDescendants: false };
  }

  const paintsBorderBox = elementPaintsFullBorderBox(el);
  if (paintsBorderBox) {
    fill = { kind: "exact", box: borderBox };
    stroke = { kind: "exact", box: borderBox };
    visual = { kind: "bounded", box: borderBox };
  }

  const hasBorderPaint = hasVisibleBorder(el)
    || (el.styles.borderImageSource != null
      && el.styles.borderImageSource !== ""
      && el.styles.borderImageSource !== "none");
  if (hasBorderPaint) {
    visual = unionVisual(visual, { kind: "bounded", box: borderBox });
    if (!paintsBorderBox) {
      // Per-side border paths/strokes need not occupy the carrier's full
      // interior bbox (a top-only border is the simplest counterexample).
      const unknown = { kind: "unknown" as const, reason: "border-reference-bounds-unavailable" };
      fill = unknown;
      stroke = unknown;
    }
  }

  const hasBackgroundLayer = el.styles.backgroundImage != null
    && el.styles.backgroundImage !== ""
    && el.styles.backgroundImage !== "none"
    && !/\btext\b/i.test(el.styles.backgroundClip ?? "");
  const hasControlChrome = ["input", "textarea", "select", "button", "progress", "meter"].includes(el.tag);
  const hasScrollableChrome = (
    (el.styles.scrollWidth ?? 0) > (el.styles.clientWidth ?? 0)
      && !["visible", "clip"].includes(el.styles.overflowX ?? "visible")
  ) || (
    (el.styles.scrollHeight ?? 0) > (el.styles.clientHeight ?? 0)
      && !["visible", "clip"].includes(el.styles.overflowY ?? "visible")
  );
  if (hasBackgroundLayer || el.imageSrc != null || hasControlChrome || hasScrollableChrome) {
    // These generated shapes are bounded by the captured border box, but
    // their object geometry can be a content/padding clip, object-fit rect,
    // UA-control part, or scrollbar part. A full border-box paint already
    // fixes the group bbox; otherwise the exact reference remains unknown.
    visual = unionVisual(visual, { kind: "bounded", box: borderBox });
    if (!paintsBorderBox) {
      const unknown = { kind: "unknown" as const, reason: "generated-box-reference-bounds-unavailable" };
      fill = unknown;
      stroke = unknown;
    }
  }

  // DM-2483: stock scrollbar images are emitted at their already-snapped
  // capture-viewport rectangles. In particular, a logical-left scrollbar or
  // clipped root control need not be bounded by this element's captured border
  // box. Union the actual emitted images; retain a partial reservation when a
  // required platform crop is missing instead of culling on a guessed host box.
  const scrollbarSets = [el.scrollbars, el.rootScrollbars]
    .filter((set, index, sets) => set != null && sets.indexOf(set) === index);
  for (const set of scrollbarSets) {
    if (set == null || set.status === "absent") continue;
    const rasters = [
      set.horizontal?.route === "native-raster" ? set.horizontal.nativeRaster : undefined,
      set.vertical?.route === "native-raster" ? set.vertical.nativeRaster : undefined,
      set.nativeCornerRaster,
    ];
    const expectedNative = set.horizontal?.route === "native-raster"
      || set.vertical?.route === "native-raster";
    if (set.status === "partial" && expectedNative && rasters.every((raster) => raster == null)) {
      visual = { kind: "unknown", reason: "native-scrollbar-raster-unavailable" };
      continue;
    }
    for (const raster of rasters) {
      if (raster == null || raster.empty === true) continue;
      if (raster.dataUri == null) {
        visual = { kind: "unknown", reason: "native-scrollbar-raster-unavailable" };
        continue;
      }
      const rasterBox = box(raster.x, raster.y, raster.width, raster.height);
      if (rasterBox == null || rasterBox.w === 0 || rasterBox.h === 0) {
        visual = { kind: "unknown", reason: "native-scrollbar-raster-invalid" };
        continue;
      }
      fill = unionReference(fill, { kind: "exact", box: rasterBox });
      stroke = unionReference(stroke, { kind: "exact", box: rasterBox });
      visual = unionVisual(visual, { kind: "bounded", box: rasterBox });
    }
  }

  if (el.replacedSnapshot != null && el.imageSrc == null) {
    const raster = el.replacedSnapshot;
    if (raster.dataUri == null) {
      visual = { kind: "unknown", reason: "replaced-raster-unavailable" };
    } else {
      const rasterBox = box(raster.x, raster.y, raster.width, raster.height);
      if (rasterBox == null || rasterBox.w === 0 || rasterBox.h === 0) {
        visual = { kind: "unknown", reason: "replaced-raster-empty-or-invalid" };
      } else {
        fill = unionReference(fill, { kind: "exact", box: rasterBox });
        stroke = unionReference(stroke, { kind: "exact", box: rasterBox });
        visual = unionVisual(visual, { kind: "bounded", box: rasterBox });
      }
    }
  }

  for (const shadow of parseBoxShadow(el.styles.boxShadow ?? "none")) {
    if (shadow.inset) {
      // Inset paint is visually clipped to the padding box, but some emitted
      // paths use a deliberately oversized donut before that clip. SVG object
      // bbox semantics for that generated path are not the visual clip box.
      const unknown = { kind: "unknown" as const, reason: "inset-shadow-reference-box-unavailable" };
      fill = unknown;
      stroke = unknown;
      visual = unionVisual(visual, { kind: "bounded", box: borderBox });
      continue;
    }
    const source = box(
      el.x + shadow.x - shadow.spread,
      el.y + shadow.y - shadow.spread,
      el.width + shadow.spread * 2,
      el.height + shadow.spread * 2,
    );
    if (source == null) {
      visual = { kind: "unknown", reason: "box-shadow-non-finite" };
      continue;
    }
    if (source.w <= 0 || source.h <= 0) continue;
    fill = unionReference(fill, { kind: "exact", box: source });
    stroke = unionReference(stroke, { kind: "exact", box: source });
    // The renderer's generated filter is x/y=-50%, width/height=200%.
    const painted = shadow.blur > 0
      ? box(source.x - source.w / 2, source.y - source.h / 2, source.w * 2, source.h * 2)
      : source;
    visual = painted == null
      ? { kind: "unknown", reason: "box-shadow-filter-region-non-finite" }
      : unionVisual(visual, { kind: "bounded", box: painted });
  }

  const outlineWidth = parseFinitePx(el.styles.outlineWidth);
  const outlineOffset = parseFinitePx(el.styles.outlineOffset);
  const outlineStyle = el.styles.outlineStyle ?? "none";
  const outlineColor = parseOptionalColor(el.styles.outlineColor ?? el.styles.color);
  if (outlineWidth == null || outlineOffset == null) {
    visual = { kind: "unknown", reason: "outline-geometry-unavailable" };
  } else if (outlineWidth > 0 && outlineStyle !== "none" && outlineStyle !== "hidden" && (outlineColor == null || outlineColor.a > 0.01)) {
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    const rounded = [corners.tl, corners.tr, corners.br, corners.bl]
      .some((corner) => corner.h !== 0 || corner.v !== 0);
    let center: RendererCullBox;
    let outer: RendererCullBox;
    if (!rounded) {
      const width = Math.round(outlineWidth);
      const outset = Math.round(outlineOffset) + width;
      const left = Math.round(el.x) - outset;
      const top = Math.round(el.y) - outset;
      const right = Math.round(el.x + el.width) + outset;
      const bottom = Math.round(el.y + el.height) + outset;
      center = { x: left + width / 2, y: top + width / 2, w: right - left - width, h: bottom - top - width };
      outer = { x: left, y: top, w: right - left, h: bottom - top };
    } else {
      const inflate = outlineOffset + outlineWidth / 2;
      center = { x: el.x - inflate, y: el.y - inflate, w: el.width + inflate * 2, h: el.height + inflate * 2 };
      outer = { x: center.x - outlineWidth / 2, y: center.y - outlineWidth / 2, w: center.w + outlineWidth, h: center.h + outlineWidth };
    }
    if (!finiteBox(center) || !finiteBox(outer)) {
      const unknown = { kind: "unknown" as const, reason: "outline-geometry-non-finite" };
      fill = unknown;
      stroke = unknown;
      visual = unknown;
    } else {
      fill = unionReference(fill, { kind: "exact", box: center });
      stroke = unionReference(stroke, { kind: "exact", box: outer });
      visual = unionVisual(visual, { kind: "bounded", box: outer });
    }
  }

  if (el.backdropFilterRaster != null) {
    // This partial Chromium surface is emitted before the element's ordinary
    // static/animation wrapper because vector descendants still paint above
    // it. It therefore cannot share one SVG reference box with that wrapper.
    // Keep the whole subtree until the renderer has a single common owner.
    const unknown = { kind: "unknown" as const, reason: "split-backdrop-raster-owner" };
    fill = unknown;
    stroke = unknown;
    visual = unknown;
  }

  const resize = el.resizeHandle;
  if (resize != null) {
    const resizeBox = box(resize.x, resize.y, resize.width, resize.height);
    if (resizeBox == null) visual = { kind: "unknown", reason: "resize-surface-non-finite" };
    else {
      fill = unionReference(fill, { kind: "exact", box: resizeBox });
      stroke = unionReference(stroke, { kind: "exact", box: resizeBox });
      visual = unionVisual(visual, { kind: "bounded", box: resizeBox });
    }
  }

  const nativeDecoration = el.nativeControlDecorationRaster;
  if (nativeDecoration != null && nativeDecoration.empty !== true) {
    if (nativeDecoration.dataUri == null) {
      // The capture reservation suppresses the sampled fallback even when
      // Chromium isolation failed. Retain the element: culling a later-valid
      // source surface from an animated/interpolated frame would turn that
      // fail-closed ownership decision into silent paint loss.
      const unknown = { kind: "unknown" as const, reason: "native-decoration-raster-unavailable" };
      fill = unknown;
      stroke = unknown;
      visual = unknown;
    } else {
      const decorationBox = box(
        nativeDecoration.x,
        nativeDecoration.y,
        nativeDecoration.width,
        nativeDecoration.height,
      );
      if (decorationBox == null || decorationBox.w === 0 || decorationBox.h === 0) {
        const unknown = { kind: "unknown" as const, reason: "native-decoration-raster-invalid" };
        fill = unknown;
        stroke = unknown;
        visual = unknown;
      } else {
        // The transparent guard is still the SVG <image>'s object bounding
        // box. Include it in reference and visual geometry so animation
        // transform-box compensation and viewBox culling share the same
        // emitted owner instead of applying the host transform twice.
        fill = unionReference(fill, { kind: "exact", box: decorationBox });
        stroke = unionReference(stroke, { kind: "exact", box: decorationBox });
        visual = unionVisual(visual, { kind: "bounded", box: decorationBox });
      }
    }
  }

  if ((el.inlineFragments?.length ?? 0) > 1 || el.styles.tableGridRect != null) {
    // The renderer emits fragment/grid-owned shapes rather than the carrier
    // rectangle. Their visual union is contained by the captured union box,
    // but the exact group object/stroke bbox is branch-dependent.
    const unknown = { kind: "unknown" as const, reason: "fragment-reference-box-unavailable" };
    fill = unknown;
    stroke = unknown;
    visual = unionVisual(visual, { kind: "bounded", box: borderBox });
  }

  // These channels produce geometry whose exact emitted object/ink bounds are
  // not available at this preflight boundary.  A finite carrier proxy would
  // reintroduce the bug this module exists to remove.
  const exactTextRaster = el.elementRaster?.dataUri != null
    && el.styles.writingMode != null && el.styles.writingMode !== "horizontal-tb";
  if (exactTextRaster) {
    const raster = el.elementRaster!;
    const rasterBox = box(raster.x, raster.y, raster.width, raster.height);
    if (rasterBox == null || rasterBox.w === 0 || rasterBox.h === 0) {
      visual = { kind: "unknown", reason: "text-raster-empty-or-invalid" };
    } else {
      fill = unionReference(fill, { kind: "exact", box: rasterBox });
      stroke = unionReference(stroke, { kind: "exact", box: rasterBox });
      visual = unionVisual(visual, { kind: "bounded", box: rasterBox });
    }
  }
  const hasText = !exactTextRaster && (el.text !== "" || (el.textSegments?.length ?? 0) > 0 || el.textImageUri != null);
  const hasGeneratedPaint = (el.pseudoBoxes?.length ?? 0) > 0
    || (el.pseudoImages?.length ?? 0) > 0
    || (el.columnRules?.length ?? 0) > 0
    || el.listItemIndex != null
    || el.markerContent != null
    || el.listMarkerIntrinsic != null
    || (el.tag === "summary" && el.styles.summaryMarkerSuppressed !== true)
    || el.styles.detailsContentBox != null
    || el.lineClampTextFragments === true;
  const hasUnknownExpansion = (el.styles.filter != null && el.styles.filter !== "" && el.styles.filter !== "none")
    || (el.styles.textShadow != null && el.styles.textShadow !== "" && el.styles.textShadow !== "none")
    || (el.styles.webkitBoxReflect != null && el.styles.webkitBoxReflect !== "" && el.styles.webkitBoxReflect !== "none")
    || (el.styles.borderImageOutset != null && !/^(?:0(?:px)?)(?:\s+0(?:px)?){0,3}$/.test(el.styles.borderImageOutset.trim()));
  if (hasText || hasGeneratedPaint || hasUnknownExpansion) {
    const reason = hasUnknownExpansion ? "emitted-effect-bounds-unavailable" : "emitted-ink-bounds-unavailable";
    fill = { kind: "unknown", reason };
    stroke = { kind: "unknown", reason };
    visual = { kind: "unknown", reason };
  } else if (el.svgContent != null) {
    // `paintInlineSvg` clips the opaque clone to the replaced-element box, so
    // its visual surface is bounded. Its object/stroke boxes remain content-
    // dependent and cannot be replaced by that clip rectangle.
    visual = unionVisual(visual, { kind: "bounded", box: borderBox });
    fill = { kind: "unknown", reason: "inline-svg-reference-box-unavailable" };
    stroke = { kind: "unknown", reason: "inline-svg-reference-box-unavailable" };
  }

  return {
    fill,
    stroke,
    visual,
    atomic: false,
    suppressesDescendants: el.svgContent != null,
  };
}

function childOverflowClip(el: CapturedElement): AxisClip | null | "unknown" {
  const overflowX = el.styles.overflowX ?? "visible";
  const overflowY = el.styles.overflowY ?? "visible";
  const contain = el.styles.contain ?? "";
  const containClips = /\b(?:paint|strict|content)\b/i.test(contain);
  const clips = overflowX !== "visible" || overflowY !== "visible" || containClips;
  if (!clips || el.tag === "body" || el.children.length === 0) return null;
  const top = parseFinitePx(el.styles.borderTopWidth);
  const right = parseFinitePx(el.styles.borderRightWidth);
  const bottom = parseFinitePx(el.styles.borderBottomWidth);
  const left = parseFinitePx(el.styles.borderLeftWidth);
  const paddingTop = parseFinitePx(el.styles.paddingTop);
  const paddingRight = parseFinitePx(el.styles.paddingRight);
  const paddingBottom = parseFinitePx(el.styles.paddingBottom);
  const paddingLeft = parseFinitePx(el.styles.paddingLeft);
  if ([top, right, bottom, left, paddingTop, paddingRight, paddingBottom, paddingLeft].some((value) => value == null)) return "unknown";

  let x = el.x + left!;
  let y = el.y + top!;
  let width = Math.max(0, el.width - left! - right!);
  let height = Math.max(0, el.height - top! - bottom!);
  const isReplaced = isOverflowReplacedElement(el.tag, el.styles.inputType);
  const usedMargin = usedOverflowClipMargin(el.styles.overflowClipMargin, {
    overflowX,
    overflowY,
    contain,
    isReplaced,
    respectsCssOverflow: isReplaced
      ? isOverflowRespectingReplacedElement(el.tag)
      : capturedBoxRespectsCssOverflow(
        el.tag,
        el.styles.display,
        el.styles.rootOverflowX,
        el.styles.rootOverflowY,
      ),
  });
  if (usedMargin != null) {
    const geometry = overflowClipMarginGeometry(
      { x: el.x, y: el.y, width: el.width, height: el.height },
      { top: top!, right: right!, bottom: bottom!, left: left! },
      { top: paddingTop!, right: paddingRight!, bottom: paddingBottom!, left: paddingLeft! },
      parseCornerRadii(el.styles, el.width, el.height),
      usedMargin,
    );
    x = geometry.x;
    y = geometry.y;
    width = geometry.width;
    height = geometry.height;
  }
  if (el.fieldsetLegendNotch != null) {
    const protrude = y - el.fieldsetLegendNotch.y;
    if (protrude > 0) { y -= protrude; height += protrude; }
  }
  const clip: AxisClip = {};
  const xVisible = !containClips && overflowX === "visible" && overflowY === "clip";
  const yVisible = !containClips && overflowY === "visible" && overflowX === "clip";
  if (!xVisible) { clip.minX = x; clip.maxX = x + width; }
  if (!yVisible) { clip.minY = y; clip.maxY = y + height; }
  return clip;
}

/**
 * Derive the exact/bounded facts consumed by the culler from the renderer's
 * own output branches.  This is intentionally a preflight, not a second DOM
 * capture: unsupported paint stays explicit and cannot silently fall back to
 * the source HTML carrier rectangle.
 */
export function buildRendererCullGeometry(
  tree: CapturedElement | readonly CapturedElement[],
  viewportW: number,
  viewportH: number,
): RendererCullGeometryIndex {
  const roots = Array.isArray(tree) ? tree : [tree];
  const local = new WeakMap<CapturedElement, LocalNodeGeometry>();
  const output = new WeakMap<CapturedElement, RendererOwnedCullGeometry>();
  const viewBox = box(0, 0, viewportW, viewportH);

  const buildLocal = (el: CapturedElement): LocalNodeGeometry => {
    const own = ownGeometry(el);
    const staticMatrix = own.atomic ? "identity" : elementStaticMatrix(el);
    let fill = own.fill;
    let stroke = own.stroke;
    let visual = own.visual;
    let hasAnimatedDescendant = false;
    const overflowClip = own.suppressesDescendants ? null : childOverflowClip(el);
    if (!own.suppressesDescendants) {
      for (const child of el.children) {
        const childLocal = buildLocal(child);
        hasAnimatedDescendant ||= child.animId != null && child.animId !== "" || childLocal.hasAnimatedDescendant;
        fill = unionReference(fill, mapReference(childLocal.fill, childLocal.staticMatrix));
        stroke = unionReference(stroke, mapReference(childLocal.stroke, childLocal.staticMatrix));
        let childVisual = mapVisual(childLocal.visual, childLocal.staticMatrix);
        if (overflowClip === "unknown") childVisual = { kind: "unknown", reason: "overflow-clip-geometry-unavailable" };
        else childVisual = clipVisual(childVisual, overflowClip);
        visual = unionVisual(visual, childVisual);
      }
    }
    const result = {
      fill,
      stroke,
      visual,
      staticMatrix,
      hasAnimatedDescendant,
      suppressesDescendants: own.suppressesDescendants,
    };
    local.set(el, result);
    return result;
  };
  for (const root of roots) buildLocal(root);

  const publish = (
    el: CapturedElement,
    ancestorMatrix: SvgAffineMatrix,
    ancestorClip: AxisClip | null,
    inheritedStatic: boolean,
  ): void => {
    const node = local.get(el)!;
    const matrix = node.staticMatrix === "identity"
      ? ancestorMatrix
      : node.staticMatrix == null
        ? null
        : multiplySvgAffine(ancestorMatrix, node.staticMatrix);
    const hasStatic = inheritedStatic || node.staticMatrix !== "identity";
    let visual: RendererVisualBounds;
    if (matrix == null) visual = { kind: "unknown", reason: "static-transform-unavailable-or-singular" };
    else visual = clipVisual(mapVisual(node.visual, matrix), ancestorClip);
    output.set(el, {
      visualBounds: visual,
      referenceBoxes: {
        fillBox: node.fill,
        strokeBox: node.stroke,
        viewBox: viewBox == null
          ? { kind: "unknown", reason: "svg-viewport-non-finite" }
          : viewportW <= 0 || viewportH <= 0
            ? { kind: "empty" }
            : { kind: "exact", box: viewBox },
      },
      hasStaticTransformPath: hasStatic,
      referenceBoxMayAnimate: node.hasAnimatedDescendant,
      suppressesDescendants: node.suppressesDescendants,
    });

    if (node.suppressesDescendants || matrix == null) return;
    const localClip = childOverflowClip(el);
    const mappedClip = localClip == null || localClip === "unknown" ? null : mapClip(localClip, matrix);
    const childClip = localClip === "unknown" ? ancestorClip : intersectClips(ancestorClip, mappedClip);
    for (const child of el.children) publish(child, matrix, childClip, hasStatic);
  };
  for (const root of roots) publish(root, IDENTITY, null, false);
  return { get: (element) => output.get(element) };
}
