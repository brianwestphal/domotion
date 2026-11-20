import type { BoxShadow } from "../render/box-shadow.js";
import { parseColor } from "../render/colors.js";
import { blurredNormalShadowRefusal } from "../render/shadow-blur-authority.js";

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

/** Whether every border-radius longhand is zero on both axes, so Blink paints
 * the box's shadows on its sharp, non-antialiased contour. */
export function sharpBorderRadii(read: (property: string) => string): boolean {
  return CORNER_SHAPE_PROPERTIES.every(([, radiusProperty]) =>
    read(radiusProperty)
      .trim()
      .split(/\s+/)
      .every((value) => (parseFloat(value) || 0) === 0),
  );
}

/** The selected root's border box in viewport pixels, and whether its border
 * radii are all zero (`sharpBorderRadii`). */
export interface ShadowRootBox {
  left: number;
  top: number;
  width: number;
  height: number;
  sharp: boolean;
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
 * - a list whose only normal layer is blurred, on a sharp whole-pixel box,
 *   when `blurredNormalShadowRefusal` finds every stage of Skia's mask-filter
 *   blur equal to the producer's (σ ≥ 2 with a box window whose pass rounding
 *   agrees, a shadow rect too small for the analytic `SkBlurMask::BlurRect`
 *   profile, and a color whose channels are 0 or 255; see
 *   `shadow-blur-authority.ts`). Its other layers may be zero-blur insets.
 *
 * Every other blurred normal layer stays refused: a rounded box's
 * antialiased coverage, a large sharp rect's analytic profile, σ < 2's true
 * Gaussian, disagreeing pass rounding, other colors, and overlapping blurred
 * layers (whose legacy-blitter compositing differs from SVG source-over) all
 * differ natively. A blurred inset layer mixed with a normal one is refused
 * too: a rounded box's blurred inset still differs natively (DM-CA3QT6).
 *
 * A `corner-shape` other than `round` on a curved corner turns the contour
 * into a ContouredRect path (`ContouredRect::GetCornerCurvature`), and a
 * `border-shape` paints the normal shadow from `BorderShapePainter::OuterPath`
 * (`box_painter_base.cc:316-325, 357-367`). The inset path carries the same
 * curvature into `ClipContouredRect` and `FillRectWithContouredHole`
 * (`:526-580`) and sends a border-shape to `PaintInsetBoxShadowForBorderShape`
 * (`:397-401`). The shadow producer draws neither, so every list is refused
 * there, inset-only included: a positive inset through a `bevel`, `squircle`
 * or `notch` corner differs natively at 24-54 pixels (DM-0TRG51), while
 * elliptical and unequal round insets are exact. Pass `curvedCornerShapes`
 * of the root, its computed `border-shape` ("" when unsupported) and its box;
 * without the box a blurred normal layer is refused. */
export function shadowOnlyRootIsAdmissible(
  shadows: readonly BoxShadow[],
  cornerShapes: readonly string[],
  borderShape: string,
  box?: ShadowRootBox,
): boolean {
  if (shadows.length === 0) return false;
  if (cornerShapes.some((shape) => shape !== "" && shape !== "round")) return false;
  if (borderShape !== "" && borderShape !== "none") return false;
  if (shadows.every((shadow) => shadow.inset) || shadows.every((shadow) => shadow.blur === 0)) return true;
  const normals = shadows.filter((shadow) => !shadow.inset);
  if (normals.length !== 1 || normals[0].blur === 0 || shadows.some((shadow) => shadow.inset && shadow.blur > 0))
    return false;
  if (box == null || !box.sharp) return false;
  const shadow = normals[0];
  const color = parseColor(shadow.color);
  return (
    color != null &&
    blurredNormalShadowRefusal({
      border: { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height },
      x: shadow.x,
      y: shadow.y,
      blur: shadow.blur,
      spread: shadow.spread,
      color,
    }) == null
  );
}
