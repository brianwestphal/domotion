// @ts-nocheck
//
// Projective (3D / perspective) frame state and homography math, extracted from
// the capture script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT
// bundle — self-contained, page globals only, no module-scope closures over the
// orchestrator: everything the orchestrator owns (the CDP-supplied facts, the
// non-affine owner set, the absolute-homography map) is passed in per call.

/** 3×3 homography inverse (row-major); null when singular or non-finite. */
export const invertH = (m) => {
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
export const mulH = (a, b) => [
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
export const homographyForRect = (vp, rect, q) => {
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
export const projectiveFrameStateFor = (args, fact, ownsRasterBoundary) => {
  if (
    typeof args.pqt === "number" &&
    isFinite(args.pqt) &&
    fact != null &&
    fact.influenced === true &&
    fact.computed != null
  ) {
    return {
      source: "chromium-cdp-content-quad-v1",
      sampleTimeMs: args.pqt,
      animationCount: typeof args.pqa === "number" && isFinite(args.pqa) ? args.pqa : 0,
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
export const projectiveTransformFor = (vp, rect, quad, parentAbsolute, backfaceVisibility) => {
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
