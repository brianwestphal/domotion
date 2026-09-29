//
// Projective (3D / perspective) frame state and homography math, extracted from
// the capture script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT
// bundle — self-contained, page globals only, no module-scope closures over the
// orchestrator: everything the orchestrator owns (the CDP-supplied facts, the
// non-affine owner set, the absolute-homography map) is passed in per call.

import type { ProjectivePaintNodeFact } from "../../projective-owner.js";
import type { CaptureScriptArgs } from "../../types.js";

type Matrix3 = number[];
interface Point {
  x: number;
  y: number;
}
interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** The subset of DOMRect the projective math reads. */
interface LayoutRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
type Warn = (selector: string, feature: string, detail: string) => void;

/** 3×3 homography inverse (row-major); null when singular or non-finite. */
export const invertH = (m: Matrix3): Matrix3 | null => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = c * h - b * i,
    C = b * f - c * e;
  const D = f * g - d * i,
    E = a * i - c * g,
    F = c * d - a * f;
  const G = d * h - e * g,
    H = b * g - a * h,
    I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
};

/** 3×3 homography product `a · b` (row-major). */
export const mulH = (a: Matrix3, b: Matrix3): Matrix3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];

/** The homography mapping an element's layout rect (viewport-relative) onto its projected quad. */
export const homographyForRect = (vp: Viewport, rect: LayoutRect, q: Point[]): Matrix3 | null => {
  const x = rect.left - vp.x,
    y = rect.top - vp.y,
    w = rect.width,
    h = rect.height;
  if (w <= 0 || h <= 0) return null;
  const a = (q[1].x - q[0].x) / w,
    d = (q[1].y - q[0].y) / w;
  const b = (q[3].x - q[0].x) / h,
    e = (q[3].y - q[0].y) / h;
  return [a, b, q[0].x - a * x - b * y, d, e, q[0].y - d * x - e * y, 0, 0, 1];
};

/**
 * The CDP-sampled frame state recorded for a projective element, or undefined when the
 * capture carries no sample time or the element has no influenced fact.
 */
export const projectiveFrameStateFor = (
  args: CaptureScriptArgs,
  fact: ProjectivePaintNodeFact | undefined,
  ownsRasterBoundary: boolean,
) => {
  if (
    typeof args.projectiveSampleTimeMs === "number" &&
    isFinite(args.projectiveSampleTimeMs) &&
    fact != null &&
    fact.influenced === true &&
    fact.computed != null
  ) {
    return {
      source: "chromium-cdp-content-quad-v1",
      sampleTimeMs: args.projectiveSampleTimeMs,
      animationCount:
        typeof args.projectiveAnimationCount === "number" && isFinite(args.projectiveAnimationCount)
          ? args.projectiveAnimationCount
          : 0,
      role: fact.role,
      influenced: true,
      contentQuad: fact.quad,
      borderQuad: fact.borderQuad,
      residual: fact.residual,
      nonAffine: fact.nonAffine === true,
      ownsRasterBoundary: ownsRasterBoundary,
      usedPreserve3d: fact.usedPreserve3d,
      groupingReasons: fact.groupingReasons,
      preserve3dLayoutApplicable: fact.preserve3dLayoutApplicable === true,
      computed: fact.computed,
    };
  }
  return undefined;
};

/**
 * The parent-relative projective transform for an element whose quad was projected, plus its
 * absolute homography (which the caller records for the element's children) and whether a
 * back-facing element hides itself. Null when there is no quad, the rect is empty, or the
 * quad degenerates.
 */
export const projectiveTransformFor = (
  vp: Viewport,
  rect: LayoutRect,
  quad: Point[] | undefined,
  parentAbsolute: Matrix3 | undefined,
  backfaceVisibility: string,
) => {
  if (quad == null || !(rect.width > 0 && rect.height > 0)) return null;
  const absolute = homographyForRect(vp, rect, quad);
  if (absolute == null) return null;
  const parentInverse = parentAbsolute != null ? invertH(parentAbsolute) : null;
  const area = (quad[1].x - quad[0].x) * (quad[3].y - quad[0].y) - (quad[1].y - quad[0].y) * (quad[3].x - quad[0].x);
  return {
    transform: parentInverse != null ? mulH(parentInverse, absolute) : absolute,
    absolute,
    hidden: backfaceVisibility === "hidden" && area < 0,
  };
};

/**
 * The bounding raster surface of an element's whole subtree, clipped to the capture viewport. SVG cannot
 * encode a projective fourth corner or preserve-3d flattening, so the outermost 3D context is one Chromium
 * raster; descendants stay in the tree for metadata and paint ordering.
 */
export const transformSubtreeRasterFor = (
  el: Element,
  rect: LayoutRect,
  vp: Viewport,
  sourceNodeIndex: number | undefined,
) => {
  let _left = rect.left,
    _top = rect.top,
    _right = rect.right,
    _bottom = rect.bottom;
  const _subs = el.getElementsByTagName("*");
  for (let _ri = 0; _ri < _subs.length; _ri++) {
    const _rr = _subs[_ri].getBoundingClientRect();
    if (_rr.width <= 0 || _rr.height <= 0) continue;
    _left = Math.min(_left, _rr.left);
    _top = Math.min(_top, _rr.top);
    _right = Math.max(_right, _rr.right);
    _bottom = Math.max(_bottom, _rr.bottom);
  }
  const _rx = Math.max(vp.x, _left),
    _ry = Math.max(vp.y, _top);
  const _rright = Math.min(vp.x + vp.width, _right),
    _rbottom = Math.min(vp.y + vp.height, _bottom);
  if (_rright > _rx && _rbottom > _ry) {
    return {
      x: _rx - vp.x,
      y: _ry - vp.y,
      width: _rright - _rx,
      height: _rbottom - _ry,
      sourceNodeIndex: sourceNodeIndex,
    };
  }
  return { x: 0, y: 0, width: 0, height: 0, sourceNodeIndex: sourceNodeIndex };
};

/**
 * Decide whether an element's whole subtree must be one Chromium raster surface. SVG cannot encode a
 * projective fourth corner or preserve-3d flattening, so the outermost 3D context is snapshotted once
 * (descendants remain in the tree for metadata and paint ordering). Missing, changing, singular, or
 * projective text-fragment facts are likewise an explicit Chromium surface boundary — never a fall back
 * to the legacy scalar font/rect approximation for that transformed subtree — and are reported.
 * Returns the raster, or undefined when the subtree stays vector.
 */
export const transformSubtreeRasterOwner = ({
  makeRaster,
  ownsRasterBoundary,
  textPaintFact,
  warn,
  selector,
}: {
  makeRaster: () => ReturnType<typeof transformSubtreeRasterFor>;
  ownsRasterBoundary: boolean;
  textPaintFact: { surfaceReason?: string | null } | null | undefined;
  warn: Warn;
  selector: () => string;
}) => {
  let raster: ReturnType<typeof transformSubtreeRasterFor> | undefined;
  if (ownsRasterBoundary) raster = makeRaster();
  if (textPaintFact != null && textPaintFact.surfaceReason != null && raster == null) {
    raster = makeRaster();
    warn(
      selector(),
      "<transform>",
      "Chromium text-fragment geometry unavailable; retained one outer raster surface: " + textPaintFact.surfaceReason,
    );
  }
  return raster;
};

/**
 * The projective facts recorded for one element: the CDP-sampled frame state, the parent-relative
 * transform, and whether a back-facing element hides itself. `recordAbsolute` receives the element's
 * absolute homography so the caller can store it for the element's children.
 */
export const projectiveStateFor = ({
  args,
  vp,
  cs,
  rect,
  fact,
  ownsRasterBoundary,
  quad,
  parentAbsolute,
  recordAbsolute,
}: {
  args: CaptureScriptArgs;
  vp: Viewport;
  cs: { backfaceVisibility: string };
  rect: LayoutRect;
  fact: ProjectivePaintNodeFact | undefined;
  ownsRasterBoundary: boolean;
  quad: Point[] | undefined;
  parentAbsolute: Matrix3 | undefined;
  recordAbsolute: (absolute: Matrix3) => void;
}) => {
  const projectiveFrameState = projectiveFrameStateFor(args, fact, ownsRasterBoundary);
  const projective = projectiveTransformFor(vp, rect, quad, parentAbsolute, cs.backfaceVisibility);
  if (projective != null) recordAbsolute(projective.absolute);
  return {
    projectiveFrameState,
    projectiveTransform: projective != null ? projective.transform : undefined,
    projectiveHidden: projective != null ? projective.hidden : undefined,
  };
};
