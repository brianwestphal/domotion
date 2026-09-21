/**
 * DM-DQXZ6K: the viewport→viewBox affine matrix — the reusable core for merging
 * (flattening) a nested `<svg>` into a parent `<g transform="matrix(...)">`
 * instead of emitting a nested `<svg>` element (see doc for the parent
 * investigation "option to merge nested svgs").
 *
 * A nested `<svg>`'s coordinate mapping is fully defined by its placement rect
 * (`x`/`y`/`width`/`height`), its `viewBox`, and `preserveAspectRatio` — and that
 * mapping is ALWAYS an affine transform, so the wrapper can always be replaced by
 * a single `<g transform="matrix(a b c d e f)">`.
 *
 * `computeViewportMatrix` is a direct transcription of Blink's
 * `SVGPreserveAspectRatio::ComputeTransform`
 * (`external/chromium/third_party/blink/renderer/core/svg/svg_preserve_aspect_ratio.cc:305`,
 * chromium rev 7d859f27, 2026-06-27), which Blink reaches from
 * `SVGFitToViewBox::ViewBoxToViewTransform` (`svg_fit_to_view_box.cc:69`). Blink's
 * `ComputeTransform` maps the viewBox into a viewport of size (w, h) at the
 * ORIGIN; the nested `<svg>`'s `x`/`y` placement is a separate outer translate
 * the caller pre-concats (`svg_svg_element.cc:499`), so we fold it into `e`/`f`.
 *
 * Blink returns the identity transform when the viewBox or the viewport is empty
 * (`svg_fit_to_view_box.cc:73`); we return `null` there instead, so a caller can
 * fall back to emitting the nested `<svg>` unchanged (there is no usable
 * coordinate system to flatten into).
 */

/** A 2D affine matrix `[a b c d e f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** A parsed `viewBox` (`min-x min-y width height`). */
export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** The nested `<svg>`'s placement rect in the parent user space (px). */
export interface ViewportPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The 10 `preserveAspectRatio` alignment keywords. */
export type PreserveAspectRatioAlign =
  | "none"
  | "xMinYMin"
  | "xMidYMin"
  | "xMaxYMin"
  | "xMinYMid"
  | "xMidYMid"
  | "xMaxYMid"
  | "xMinYMax"
  | "xMidYMax"
  | "xMaxYMax";

export interface PreserveAspectRatio {
  align: PreserveAspectRatioAlign;
  meetOrSlice: "meet" | "slice";
}

const ALIGN_VALUES = new Set<string>([
  "none",
  "xMinYMin",
  "xMidYMin",
  "xMaxYMin",
  "xMinYMid",
  "xMidYMid",
  "xMaxYMid",
  "xMinYMax",
  "xMidYMax",
  "xMaxYMax",
]);

/** The SVG default when `preserveAspectRatio` is absent or unparseable. */
export const DEFAULT_PRESERVE_ASPECT_RATIO: PreserveAspectRatio = { align: "xMidYMid", meetOrSlice: "meet" };

/**
 * Parse a `preserveAspectRatio` attribute value. Accepts an optional leading
 * `defer` (ignored — it only matters for `<image>` referencing an SVG with its
 * own PAR), then an align keyword, then an optional `meet`/`slice`. Anything
 * missing or unrecognized falls back to the SVG default `xMidYMid meet`.
 */
export function parsePreserveAspectRatio(value: string | null | undefined): PreserveAspectRatio {
  if (value == null) return { ...DEFAULT_PRESERVE_ASPECT_RATIO };
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "");
  let i = 0;
  if (tokens[i] === "defer") i++;
  const alignTok = tokens[i];
  const align: PreserveAspectRatioAlign =
    alignTok != null && ALIGN_VALUES.has(alignTok) ? (alignTok as PreserveAspectRatioAlign) : "xMidYMid";
  i++;
  const msTok = tokens[i];
  const meetOrSlice: "meet" | "slice" = msTok === "slice" ? "slice" : "meet";
  return { align, meetOrSlice };
}

/**
 * Compute the affine matrix that maps `viewBox` coordinates into the placement
 * rect under `preserveAspectRatio` — i.e. exactly what the nested `<svg>`'s
 * viewport does, expressed as a `<g transform="matrix(...)">`. Returns `null`
 * when there is no usable coordinate system (empty viewBox or empty placement),
 * mirroring Blink's identity-transform bail so the caller can keep the nested
 * `<svg>` instead.
 */
export function computeViewportMatrix(
  placement: ViewportPlacement,
  viewBox: ViewBox,
  par: PreserveAspectRatio,
): AffineMatrix | null {
  const lx = viewBox.minX;
  const ly = viewBox.minY;
  const lw = viewBox.width;
  const lh = viewBox.height;
  const pw = placement.w;
  const ph = placement.h;
  // Blink: identity (→ null here) when the viewBox or viewport is empty.
  if (lw <= 0 || lh <= 0 || pw <= 0 || ph <= 0) return null;

  // Blink composes `ScaleNonUniform(sx, sy)` then `Translate(tx, ty)`, i.e. the
  // matrix S·T: a point is translated first, then scaled — so the emitted matrix
  // is { a: sx, d: sy, e: sx·tx, f: sy·ty } (b = c = 0). The placement x/y then
  // adds into e/f (an outer `translate(x, y)` pre-concatenated with this).
  let sx: number;
  let sy: number;
  let tx: number;
  let ty: number;

  if (par.align === "none") {
    sx = pw / lw;
    sy = ph / lh;
    tx = -lx;
    ty = -ly;
  } else {
    const logicalRatio = lw / lh;
    const physicalRatio = pw / ph;
    const heightFitted =
      (logicalRatio < physicalRatio && par.meetOrSlice === "meet") ||
      (logicalRatio >= physicalRatio && par.meetOrSlice === "slice");
    if (heightFitted) {
      // Uniform scale from the HEIGHT; align along X in the leftover width.
      sx = sy = ph / lh;
      ty = -ly;
      const leftoverX = lw - (pw * lh) / ph;
      if (par.align === "xMinYMin" || par.align === "xMinYMid" || par.align === "xMinYMax") {
        tx = -lx;
      } else if (par.align === "xMidYMin" || par.align === "xMidYMid" || par.align === "xMidYMax") {
        tx = -lx - leftoverX / 2;
      } else {
        tx = -lx - leftoverX;
      }
    } else {
      // Uniform scale from the WIDTH; align along Y in the leftover height.
      sx = sy = pw / lw;
      tx = -lx;
      const leftoverY = lh - (ph * lw) / pw;
      if (par.align === "xMinYMin" || par.align === "xMidYMin" || par.align === "xMaxYMin") {
        ty = -ly;
      } else if (par.align === "xMinYMid" || par.align === "xMidYMid" || par.align === "xMaxYMid") {
        ty = -ly - leftoverY / 2;
      } else {
        ty = -ly - leftoverY;
      }
    }
  }

  return {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: sx * tx + placement.x,
    f: sy * ty + placement.y,
  };
}
