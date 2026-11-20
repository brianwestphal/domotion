import type { BoxShadow } from "../render/box-shadow.js";

/** Physical corners as [corner-shape longhand, border-radius longhand]. */
export const CORNER_SHAPE_PROPERTIES = [
  ["corner-top-left-shape", "border-top-left-radius"],
  ["corner-top-right-shape", "border-top-right-radius"],
  ["corner-bottom-right-shape", "border-bottom-right-radius"],
  ["corner-bottom-left-shape", "border-bottom-left-radius"],
] as const;

/** The computed corner-shape of each corner that actually curves, i.e. whose
 * radius is nonzero on both axes; a sharp corner has no curvature to shape.
 * An engine without corner-shape yields "". Pure, so the capture script can
 * call it with `getPropertyValue` reads. */
export function curvedCornerShapes(read: (property: string) => string): string[] {
  const shapes: string[] = [];
  for (const [shapeProperty, radiusProperty] of CORNER_SHAPE_PROPERTIES) {
    const radii = read(radiusProperty)
      .trim()
      .split(/\s+/)
      .map((value) => parseFloat(value) || 0);
    if (radii.length === 0 || radii.some((radius) => radius === 0)) continue;
    shapes.push(read(shapeProperty).trim());
  }
  return shapes;
}

/** Whether a selected root whose only paint is its `box-shadow` list may be
 * captured as its own root (rather than flattened to its children).
 *
 * Blink paints both shadow styles from the same pixel-snapped contour
 * (`BoxPainterBase::PaintNormalBoxShadow` / `PaintInsetBoxShadow`,
 * `core/paint/box_painter_base.cc:283-386, 526-580`, Chromium 7d859f27), and
 * the producer reproduces zero-blur normal shadows byte-exactly for sharp,
 * circular, elliptical and unequal round corners. Admission is limited to the
 * lists whose paint is authenticated:
 *
 * - an inset-only list (the earlier inset admission, kept for compatibility);
 * - any list whose every layer has zero blur, normal and inset mixed.
 *
 * A blurred normal layer stays refused: Blink blurs through an
 * `SkMaskFilter` (analytic `SkBlurMask::BlurRect` for a sharp rect) while the
 * producer uses `feGaussianBlur`, and the sharp case still differs. A blurred
 * inset layer mixed with a normal one is refused for the same reason.
 *
 * A `corner-shape` other than `round` on a curved corner turns the contour
 * into a ContouredRect path (`ContouredRect::GetCornerCurvature`), and a
 * `border-shape` paints the normal shadow from `BorderShapePainter::OuterPath`
 * (`box_painter_base.cc:316-325, 357-367`). The shadow producer draws neither,
 * so a list with a normal layer is refused there. Pass `curvedCornerShapes`
 * of the root and its computed `border-shape` ("" when unsupported). */
export function shadowOnlyRootIsAdmissible(
  shadows: readonly BoxShadow[],
  cornerShapes: readonly string[],
  borderShape: string,
): boolean {
  if (shadows.length === 0) return false;
  if (shadows.every((shadow) => shadow.inset)) return true;
  if (cornerShapes.some((shape) => shape !== "" && shape !== "round")) return false;
  if (borderShape !== "" && borderShape !== "none") return false;
  return shadows.every((shadow) => shadow.blur === 0);
}
