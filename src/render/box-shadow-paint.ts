/**
 * CSS `box-shadow` paint for one border box: outer shadows (painted below the
 * background) and inset shadows (painted above the background, inside the
 * padding box). Shared by the general element renderer and by form-control
 * pseudo boxes (slider track and thumb), which have no captured element of
 * their own but are painted by the same Blink box-shadow code
 * (`BoxPainterBase::PaintNormalBoxShadow` / `PaintInsetBoxShadow`).
 */

import type { CapturedElement } from "../capture/types.js";
import {
  emitGaussianBlurFilter,
  emitShadowMaskBlurFilter,
  emitShadowMaskBlurStages,
  shadowMaskBlurRegion,
} from "./gaussian-blur.js";
import { parseBoxShadow } from "./box-shadow.js";
import { formatNumberLoose, r } from "./format.js";
import { parseColor, colorStr } from "./colors.js";
import {
  authenticBorderPaintSnap,
  constrainCornerRadiiToRect,
  insetCornerRadii,
  outsetCornerRadiiWithCoverageCorrection,
  roundedRectPath,
  roundedRectSvg,
  skRRectSvg,
  skRRectUnderAaClipSvg,
  type CornerRadii,
} from "./borders.js";

/** The id allocator and output arrays the shadow painters write to. */
export interface ShadowPaintCtx {
  svgParts: string[];
  defsParts: string[];
  nextClipId(prefix: string): string;
}

/** The border box, shadow list and border widths a shadow is painted from. */
export interface ShadowBox {
  x: number;
  y: number;
  width: number;
  height: number;
  styles: Pick<
    CapturedElement["styles"],
    "boxShadow" | "borderTopWidth" | "borderRightWidth" | "borderBottomWidth" | "borderLeftWidth"
  > & { backgroundColor?: string; display?: string };
  borderPaintSnap?: CapturedElement["borderPaintSnap"];
}

/** A shadow's source contour: a rectangle and its constrained corner radii. */
export interface ShadowContour {
  x: number;
  y: number;
  width: number;
  height: number;
  corners: CornerRadii;
}

/**
 * The border contour normal shadows are painted from. Blink's
 * `BoxPainterBase::PaintNormalBoxShadow` (core/paint/box_painter_base.cc:294,
 * Chromium 7d859f27) starts from `PixelSnappedContouredBorder`, whose rect is
 * `ToPixelSnappedRect(paint_rect)` in local paint space and whose radii are
 * resolved against the unsnapped size, then constrained to the snapped rect
 * (contoured_border_geometry.cc:136-140, 178-185). The capture authenticates
 * that rect as `borderPaintSnap`; without it the captured geometry is kept.
 */
export function shadowBorderContour(el: ShadowBox, corners: CornerRadii): ShadowContour {
  const snap = authenticBorderPaintSnap(el);
  if (snap == null) return { x: el.x, y: el.y, width: el.width, height: el.height, corners };
  const x = el.x + snap.left,
    y = el.y + snap.top;
  // SnapSizeToPixel (layout_unit.h:805-813) keeps a nonzero size of more than
  // four LayoutUnits at one pixel; the record holds plain edge rounding.
  const snapSize = (snapped: number, size: number) =>
    snapped === 0 && Math.abs(size) > 4 / 64 ? Math.sign(size) : snapped;
  const width = snapSize(el.x + el.width + snap.right - x, el.width),
    height = snapSize(el.y + el.height + snap.bottom - y, el.height);
  return { x, y, width, height, corners: constrainCornerRadiiToRect(corners, width, height) };
}

/**
 * The padding-box contour inset shadows clip to and cut their hole from.
 * `PaintInsetBoxShadowWithBorderRect` uses `PixelSnappedContouredInnerBorder`
 * (box_painter_base.cc:388-405), i.e. `PixelSnappedContouredBorderWithOutsets`
 * with the border widths as integer insets (`PhysicalBoxStrut::FromInts`,
 * contoured_border_geometry.cc:207-255): the inset rect clamps a negative size
 * to zero, rounds its origin, snaps its size allowing zero, and takes the
 * snapped outer contour's radii outset by the same insets
 * (`FloatRoundedRect::Radii::Outset` grows only nonzero components and clamps
 * at zero). Without an authenticated `borderPaintSnap` the captured geometry
 * and float border widths are kept.
 */
export function shadowInnerBorderContour(el: ShadowBox, corners: CornerRadii): ShadowContour {
  const width = (value: string | undefined) => parseFloat(value ?? "0") || 0;
  const snap = authenticBorderPaintSnap(el);
  if (snap == null) {
    const l = width(el.styles.borderLeftWidth),
      r = width(el.styles.borderRightWidth),
      t = width(el.styles.borderTopWidth),
      b = width(el.styles.borderBottomWidth);
    return {
      x: el.x + l,
      y: el.y + t,
      width: Math.max(0, el.width - l - r),
      height: Math.max(0, el.height - t - b),
      corners: insetCornerRadii(corners, t, r, b, l),
    };
  }
  const l = Math.trunc(width(el.styles.borderLeftWidth)),
    r = Math.trunc(width(el.styles.borderRightWidth)),
    t = Math.trunc(width(el.styles.borderTopWidth)),
    b = Math.trunc(width(el.styles.borderBottomWidth));
  const outer = shadowBorderContour(el, corners);
  // An integer inset moves an edge by whole pixels, so the snapped inset edge
  // is the snapped outer edge (from the same edge rounding) minus the inset.
  const x = el.x + snap.left + l,
    y = el.y + snap.top + t;
  const innerWidth = el.width - l - r > 0 ? el.x + el.width + snap.right - r - x : 0;
  const innerHeight = el.height - t - b > 0 ? el.y + el.height + snap.bottom - b - y : 0;
  return { x, y, width: innerWidth, height: innerHeight, corners: insetCornerRadii(outer.corners, t, r, b, l) };
}

const shadowShapeNumber = (n: number): string => formatNumberLoose(n, 3);
// Device-snapped pieces sit on 1/64 fractions of the user space.
const devicePieceNumber = (n: number): string => formatNumberLoose(n, 6);

/** An axis-aligned rectangle by its edges. */
export interface EdgeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The user-space position of the device pixel edge a non-antialiased clip
 * puts at user coordinate `u`, given the fractional user→device translation
 * `d`. `SkRasterClip::op` rounds a BW clip's device rect with `SkRect::round`
 * (Skia 62efacd3 SkRasterClip.cpp:170-171), i.e. `floor(x + 0.5)` per edge.
 */
export function deviceRoundedEdge(u: number, d: number): number {
  const device = Math.round((u + d) * 64) / 64;
  return Math.floor(device + 0.5) - d;
}

/** `rect` with each edge moved to the device pixel edge a non-AA clip rounds it to. */
export function deviceRoundedRect(rect: EdgeRect, device: { x: number; y: number }): EdgeRect {
  return {
    left: deviceRoundedEdge(rect.left, device.x),
    top: deviceRoundedEdge(rect.top, device.y),
    right: deviceRoundedEdge(rect.right, device.x),
    bottom: deviceRoundedEdge(rect.bottom, device.y),
  };
}

/**
 * The rectangles Skia fills for an antialiased rect drawn under a BW clip that
 * is the canvas minus `hole` (both in the same space, the hole on device pixel
 * edges). `SkScan::AntiFillRect` walks the clip region's rectangles
 * (`SkRegion::Cliperator`) and fills `antifillrect(piece)` once per piece
 * (Skia 62efacd3 SkScan_Antihair.cpp:784-808). A region minus one rect has a
 * band above, a left and a right span beside, and a band below the hole. The
 * split is not cosmetic: a piece one scanline high takes `do_scanline(...,
 * B - T - 1)` (:664-666), one level below the same row of an unsplit rect.
 * An empty hole leaves the region a rect, and the shape whole.
 */
export function regionBandPieces(shape: EdgeRect, hole: EdgeRect): EdgeRect[] {
  if (hole.left >= hole.right || hole.top >= hole.bottom) return [shape];
  const candidates: EdgeRect[] = [
    { left: shape.left, top: shape.top, right: shape.right, bottom: Math.min(shape.bottom, hole.top) },
    {
      left: shape.left,
      top: Math.max(shape.top, hole.top),
      right: Math.min(shape.right, hole.left),
      bottom: Math.min(shape.bottom, hole.bottom),
    },
    {
      left: Math.max(shape.left, hole.right),
      top: Math.max(shape.top, hole.top),
      right: shape.right,
      bottom: Math.min(shape.bottom, hole.bottom),
    },
    { left: shape.left, top: Math.max(shape.top, hole.bottom), right: shape.right, bottom: shape.bottom },
  ];
  return candidates.filter((piece) => piece.left < piece.right && piece.top < piece.bottom);
}

/**
 * The rect `PaintInsetBoxShadow` fills around the hole before the looper
 * shifts it by the shadow offset (`AreaCastingShadowInHole`,
 * box_painter_base.cc:509-522, Chromium 7d859f27): the bounds outset by the
 * blur radius and by a negative spread, united with that rect moved against
 * the offset. Returned in the shifted (painted) position.
 */
export function insetShadowCastingRect(bounds: EdgeRect, x: number, y: number, blur: number, spread: number): EdgeRect {
  const outset = blur + (spread < 0 ? -spread : 0);
  const left = bounds.left - outset,
    top = bounds.top - outset,
    right = bounds.right + outset,
    bottom = bounds.bottom + outset;
  return {
    left: Math.min(left, left - x) + x,
    top: Math.min(top, top - y) + y,
    right: Math.max(right, right - x) + x,
    bottom: Math.max(bottom, bottom - y) + y,
  };
}

/**
 * An antialiased clip that removes nothing from a shape inside (x, y, w, h):
 * a rounded rect whose 1px corners sit 2px outside the shape's pixel bounds.
 * It exists only so Skia rasterizes the shape the way it does under Blink's
 * AA clip-out (`SkRasterClip` is not BW, so `SkScan::AntiFillPath` passes
 * forceRLE, SkScan_AntiPath.cpp:145-153). A clip containing the whole device
 * would be reduced to BW, which is why it hugs the shape.
 */
function aaRouteClip(ctx: ShadowPaintCtx, x: number, y: number, width: number, height: number): string {
  const id = ctx.nextClipId("shaa");
  const left = Math.floor(x) - 2,
    top = Math.floor(y) - 2;
  const right = Math.ceil(x + width) + 2,
    bottom = Math.ceil(y + height) + 2;
  ctx.defsParts.push(
    `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="1"/></clipPath>`,
  );
  return id;
}

/**
 * A rounded rect filled on Skia's antialiased-clip raster route: an SkRRect
 * that SVG can express (`<rect rx ry>`) or a path is drawn under `aaRouteClip`;
 * unequal round corners are a rect under a CSS `inset()` clip, which is itself
 * the SkRRect rasterized as an AA clip (`skRRectUnderAaClipSvg`).
 */
function aaRouteRRectSvg(
  ctx: ShadowPaintCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  corners: CornerRadii,
  attrs: string,
): string {
  return (
    skRRectUnderAaClipSvg(x, y, width, height, corners, attrs) ??
    skRRectSvg(
      x,
      y,
      width,
      height,
      corners,
      `${attrs} clip-path="url(#${aaRouteClip(ctx, x, y, width, height)})"`,
      shadowShapeNumber,
    )
  );
}

/**
 * Corner radii of a normal shadow's shape. Blink's rounded branch
 * (`PaintNormalBoxShadow`, box_painter_base.cc:371-380, Chromium 7d859f27)
 * calls `ApplySpreadToShadowShape` (:91-97): nothing for a zero spread,
 * otherwise `ContouredRect::OutsetWithCornerCorrection(spread)` then
 * `ConstrainRadii()`. With the stable `ShadowContourFollowsBorder` feature
 * (contoured_rect.cc:93-97) that is `FloatRoundedRect::Radii::
 * OutsetWithCornerCorrectionUsingCoverageFactor` against the border rect's size
 * (float_rounded_rect.cc:168-264): a radius smaller than the spread grows by
 * less than the spread, a zero radius stays sharp, a negative spread shrinks
 * each radius and clamps at zero. The constraint is against the spread rect.
 */
export function normalShadowCorners(
  corners: CornerRadii,
  spread: number,
  borderWidth: number,
  borderHeight: number,
  shadowWidth: number,
  shadowHeight: number,
): CornerRadii {
  if (spread === 0) return corners;
  const outset = outsetCornerRadiiWithCoverageCorrection(
    corners,
    spread,
    spread,
    spread,
    spread,
    borderWidth,
    borderHeight,
  );
  return constrainCornerRadiiToRect(outset, shadowWidth, shadowHeight);
}

/** The physical sides of a box fragment its decorations include. */
export interface ShadowSides {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/**
 * One fragment of a fragmented box (a wrapped inline's line box): the sides
 * Blink's `SidesToInclude()` keeps for it, and the user→device translation of
 * the box it belongs to (a fragment's own size never matches the box's
 * `borderPaintSnap` record).
 */
export interface ShadowFragment {
  sides: ShadowSides;
  device?: { x: number; y: number };
}

type ShadowLayer = ReturnType<typeof parseBoxShadow>[number];

const includesAllSides = (sides: ShadowSides | undefined): boolean =>
  sides == null || (sides.top && sides.right && sides.bottom && sides.left);

/**
 * `AdjustRectForSideClipping` (box_painter_base.cc:225-250, Chromium
 * 7d859f27): a fragment's shadow (or inset hole) rect is stretched past each
 * excluded side by the offset and blur, so that side shows neither a shadow
 * edge nor its blur.
 */
export function adjustRectForSideClipping(rect: EdgeRect, sh: ShadowLayer, sides: ShadowSides): EdgeRect {
  return {
    left: sides.left ? rect.left : rect.left - (Math.max(sh.x, 0) + sh.blur),
    top: sides.top ? rect.top : rect.top - (Math.max(sh.y, 0) + sh.blur),
    right: sides.right ? rect.right : rect.right + (sh.blur - Math.min(sh.x, 0)),
    bottom: sides.bottom ? rect.bottom : rect.bottom + (sh.blur - Math.min(sh.y, 0)),
  };
}

/**
 * The rect `ClipToSides` keeps (box_painter_base.cc:200-223): the border rect
 * outset by `ShadowData::RectOutsets()` (`ceil(3σ) + spread ∓ offset`, σ half
 * the blur radius, shadow_data.cc:32-43) on included sides and not at all on
 * excluded ones. Blink applies it with the non-antialiased `Clip(RectF)`.
 */
export function sideClipKeepRect(border: EdgeRect, sh: ShadowLayer, sides: ShadowSides): EdgeRect {
  const blurAndSpread = Math.ceil(3 * (sh.blur / 2)) + sh.spread;
  return {
    left: border.left - (sides.left ? blurAndSpread - sh.x : 0),
    top: border.top - (sides.top ? blurAndSpread - sh.y : 0),
    right: border.right + (sides.right ? blurAndSpread + sh.x : 0),
    bottom: border.bottom + (sides.bottom ? blurAndSpread + sh.y : 0),
  };
}

export function paintBoxShadow(
  ctx: ShadowPaintCtx,
  el: ShadowBox,
  sourceCorners: CornerRadii,
  indent: string,
  fragment?: ShadowFragment,
): void {
  // A display:contents element has no box for BoxPainterBase to decorate.
  if (el.styles.display === "contents") return;
  const border = shadowBorderContour(el, sourceCorners);
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
  const sides = fragment == null || includesAllSides(fragment.sides) ? null : fragment.sides;
  const borderRect = {
    left: border.x,
    top: border.y,
    right: border.x + border.width,
    bottom: border.y + border.height,
  };
  const device = authenticBorderPaintSnap(el)?.device ?? fragment?.device;
  for (let si = shadows.length - 1; si >= 0; si--) {
    const sh = shadows[si];
    if (sh.inset) continue;
    // Blink clips normal shadow paint outside the source border contour. With
    // no offset, blur or spread, the shadow and excluded contour coincide:
    // their geometric difference is empty, including antialiased corners.
    // Multiplying separately rasterized contour/inverse-mask alpha would leave
    // A*(1-A) coverage at those edges (DM-09GQAV).
    if (sh.x === 0 && sh.y === 0 && sh.spread === 0 && sh.blur === 0) continue;
    // Negative spread is allowed: per CSS Backgrounds 3 §6.4 the shadow
    // shape's width/height = box + 2*spread (so spread < 0 shrinks the
    // shadow). Chromium's `BoxShadowData::ApplyToBoxOuter` shrinks the
    // outer rect by `-spread` on each side and zero-clamps the result.
    if (border.width + sh.spread * 2 <= 0 || border.height + sh.spread * 2 <= 0) continue;
    // A fragment that excludes sides paints under ClipToSides and stretches
    // its fill rect past those sides first (PaintNormalBoxShadow,
    // box_painter_base.cc:334-341).
    const fill = sides == null ? borderRect : adjustRectForSideClipping(borderRect, sh, sides);
    const keep = sides == null ? null : sideClipKeepRect(borderRect, sh, sides);
    const layerStart = ctx.svgParts.length;
    try {
      paintNormalShadowLayer(ctx, el, border, sh, fill, device, indent);
    } finally {
      if (keep != null && ctx.svgParts.length > layerStart) {
        const k = device == null ? keep : deviceRoundedRect(keep, device);
        const keepId = ctx.nextClipId("shside");
        const n = devicePieceNumber;
        ctx.defsParts.push(
          `<clipPath id="${keepId}" clipPathUnits="userSpaceOnUse"><rect x="${n(k.left)}" y="${n(k.top)}" width="${n(k.right - k.left)}" height="${n(k.bottom - k.top)}"/></clipPath>`,
        );
        ctx.svgParts.splice(layerStart, 0, `${indent}<g clip-path="url(#${keepId})">`);
        ctx.svgParts.push(`${indent}</g>`);
      }
    }
  }
}

/** One normal shadow layer of `paintBoxShadow`, painted from its fill rect. */
function paintNormalShadowLayer(
  ctx: ShadowPaintCtx,
  el: ShadowBox,
  border: ShadowContour,
  sh: ShadowLayer,
  fillRect: EdgeRect,
  device: { x: number; y: number } | undefined,
  indent: string,
): void {
  const corners = border.corners;
  // Rect inflated by spread and shifted by (x, y).
  {
    const sx = fillRect.left + sh.x - sh.spread;
    const sy = fillRect.top + sh.y - sh.spread;
    const sw = fillRect.right - fillRect.left + sh.spread * 2;
    const sh2 = fillRect.bottom - fillRect.top + sh.spread * 2;
    if (sw <= 0 || sh2 <= 0) return;
    const shadowCorners = normalShadowCorners(corners, sh.spread, border.width, border.height, sw, sh2);
    // A blurred shadow reaches ceil(3σ) past its shape (`SkBlurImageFilter`
    // kernelBounds, Skia 62efacd3), so its knockout region must cover that.
    // The zero-blur knockout keeps its historical 3x shape rect.
    const reach = sh.blur > 0 ? Math.ceil(1.5 * sh.blur) + 2 : 0;
    const ko = {
      x: r(sx - sw - reach),
      y: r(sy - sh2 - reach),
      w: r(sw * 3 + 2 * reach),
      h: r(sh2 * 3 + 2 * reach),
      back: r(-(sw * 3 + 2 * reach)),
    };
    const shadowColor = parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 };
    // Blink blurs the shape's coverage mask and blits the shadow color through
    // it (DrawLooperBuilder::AddShadow); the filter does the same from the
    // black shape's alpha (`emitShadowMaskBlurFilter`).
    const blurRegion = shadowMaskBlurRegion(sx, sy, sw, sh2, sh.blur);
    const blurFilterAttr = (): string => {
      if (sh.blur <= 0) return "";
      const fid = ctx.nextClipId("sh");
      ctx.defsParts.push(emitShadowMaskBlurFilter(fid, sh.blur, shadowColor, blurRegion));
      return ` filter="url(#${fid})"`;
    };
    let clipAttr = "";
    let knockoutMask: string | undefined;
    const background = el.styles.backgroundColor == null ? null : parseColor(el.styles.backgroundColor);
    const roundedBorder = [corners.tl, corners.tr, corners.br, corners.bl].some(
      (corner) => corner.h > 0 || corner.v > 0,
    );
    // A sharp box's ClipToBorderEdge is `GraphicsContext::ClipOut(RectF)`, a
    // NON-antialiased difference clip (graphics_context.h:384-386, Chromium
    // 7d859f27; box_painter_base.cc:189-196): Skia rounds its device rect to
    // whole pixels and the shadow rect is filled region piece by region piece.
    // That needs the user→device translation; without it the antialiased
    // producer below is kept.
    if (!roundedBorder && background != null && device != null && (sh.blur === 0 || background.a < 1)) {
      // An opaque box clips out its contour inset by one pixel, and nothing
      // when that is empty (box_painter_base.cc:180-196).
      const inset = background.a >= 1 ? 1 : 0;
      const clipOut = {
        left: border.x + inset,
        top: border.y + inset,
        right: border.x + border.width - inset,
        bottom: border.y + border.height - inset,
      };
      const hole =
        clipOut.right > clipOut.left && clipOut.bottom > clipOut.top ? deviceRoundedRect(clipOut, device) : null;
      const shape = { left: sx, top: sy, right: sx + sw, bottom: sy + sh2 };
      const fill = sh.blur > 0 ? 'fill="black"' : `fill="${colorStr(shadowColor)}"`;
      if (sh.blur === 0) {
        for (const piece of hole == null ? [shape] : regionBandPieces(shape, hole)) {
          const n = devicePieceNumber;
          ctx.svgParts.push(
            `${indent}<rect x="${n(piece.left)}" y="${n(piece.top)}" width="${n(piece.right - piece.left)}" height="${n(piece.bottom - piece.top)}" ${fill}/>`,
          );
        }
        return;
      }
      // A blurred shadow is a mask-filter blit, which a region clip does not
      // split; an antialiased clip on whole device pixels has the same 0/1
      // coverage as the BW one.
      let snappedClip = "";
      if (hole != null) {
        const clipId = ctx.nextClipId("shcut");
        const n = devicePieceNumber;
        ctx.defsParts.push(
          `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="M${ko.x} ${ko.y}h${ko.w}v${ko.h}h${ko.back}Z M${n(hole.left)} ${n(hole.top)}H${n(hole.right)}V${n(hole.bottom)}H${n(hole.left)}Z" clip-rule="evenodd"/></clipPath>`,
        );
        snappedClip = ` clip-path="url(#${clipId})"`;
      }
      ctx.svgParts.push(
        `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `${fill}${blurFilterAttr()}${snappedClip}`, shadowShapeNumber)}`,
      );
      return;
    }
    // On an opaque background Blink clips out the contour inset by 1px
    // (ClipToBorderEdge, box_painter_base.cc:185-187) and skips an empty one.
    // That only reaches visible pixels at a rounded corner, where the inset
    // contour still crosses the background's antialiased edge. Sharp opaque
    // boxes and blurred shadows (no native control for the mask-filter route
    // yet) keep the unclipped producer.
    const opaqueRoundedClip =
      sh.blur === 0 &&
      background != null &&
      background.a >= 1 &&
      roundedBorder &&
      border.width > 2 &&
      border.height > 2;
    if (opaqueRoundedClip) {
      const clipId = ctx.nextClipId("shcut");
      const contour = { x: border.x + 1, y: border.y + 1, width: border.width - 2, height: border.height - 2 };
      const contourCorners = insetCornerRadii(corners, 1, 1, 1, 1);
      const contourShape = aaRouteRRectSvg(
        ctx,
        contour.x,
        contour.y,
        contour.width,
        contour.height,
        contourCorners,
        'fill="black"',
      );
      ctx.defsParts.push(
        `<mask id="${clipId}" maskUnits="userSpaceOnUse" x="${ko.x}" y="${ko.y}" width="${ko.w}" height="${ko.h}" style="mask-type:luminance"><rect x="${ko.x}" y="${ko.y}" width="${ko.w}" height="${ko.h}" fill="white"/>${contourShape}</mask>`,
      );
      clipAttr = ` mask="url(#${clipId})"`;
    }
    if (background != null && background.a < 1) {
      // Blink 147 BoxPainterBase::ClipToBorderEdge excludes the original
      // border contour before normal-shadow paint on a nonopaque background.
      // Clip after filtering, so the blur cannot refill the transparent box.
      const clipId = ctx.nextClipId("shcut");
      if (roundedBorder) {
        // Blink builds this clip as an SkAAClip, whose path coverage comes from
        // the run-based accumulator (SkAAClip::setPath → AntiFillPath forceRLE);
        // draw the mask's contour under an AA clip so it takes the same route.
        const contour = aaRouteRRectSvg(ctx, border.x, border.y, border.width, border.height, corners, 'fill="black"');
        ctx.defsParts.push(
          `<mask id="${clipId}" maskUnits="userSpaceOnUse" x="${ko.x}" y="${ko.y}" width="${ko.w}" height="${ko.h}" style="mask-type:luminance"><rect x="${ko.x}" y="${ko.y}" width="${ko.w}" height="${ko.h}" fill="white"/>${contour}</mask>`,
        );
        // `SkAAClipBlitter::blitMask` merges the clip's coverage into a blurred
        // shadow's mask before the color blit (SkAAClip.cpp:1806, Skia
        // 62efacd3), so for a blur the mask sits between the filter stages.
        if (sh.blur > 0) knockoutMask = clipId;
        else clipAttr = ` mask="url(#${clipId})"`;
      } else {
        const outer = `M${ko.x} ${ko.y}h${ko.w}v${ko.h}h${ko.back}Z`;
        const hole = roundedRectPath(border.x, border.y, border.width, border.height, corners);
        ctx.defsParts.push(
          `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${outer} ${hole}" clip-rule="evenodd"/></clipPath>`,
        );
        clipAttr = ` clip-path="url(#${clipId})"`;
      }
    }
    const fill = sh.blur > 0 ? 'fill="black"' : `fill="${colorStr(shadowColor)}"`;
    // Blink draws a rounded box's shadow under ClipOutContouredRect, an
    // antialiased clip (ClipToBorderEdge, box_painter_base.cc:175-198), unless
    // the inset-by-1 contour of an opaque box is empty. Under an AA clip Skia's
    // CPU rasterizer fills paths with the run-based accumulator
    // (SkScan::AntiFillPath forceRLE, SkScan_AntiPath.cpp:145-153;
    // SkScan_AAAPath.cpp:1736-1739) instead of the mask accumulator, which
    // changes edge coverage by a few levels. The knockout itself is the mask
    // above; reproduce the raster route with an AA clip whose rounded edge sits
    // 2px outside the shadow shape, so it never removes coverage. A blurred
    // shadow takes the mask-filter path instead and is left alone.
    const rasterUnderAaClip =
      sh.blur === 0 &&
      background != null &&
      [corners.tl, corners.tr, corners.br, corners.bl].some((corner) => corner.h > 0 || corner.v > 0) &&
      (background.a < 1 || (border.width > 2 && border.height > 2));
    // The corner-corrected radii are arbitrary floats (2 → 5.504 for a 4px
    // spread); the default one-decimal coordinate format would move the arc
    // by up to 0.05px, so the shadow shape keeps three decimals.
    if (rasterUnderAaClip) {
      const shape = aaRouteRRectSvg(ctx, sx, sy, sw, sh2, shadowCorners, fill);
      ctx.svgParts.push(clipAttr === "" ? `${indent}${shape}` : `${indent}<g${clipAttr}>${shape}</g>`);
      return;
    }
    if (knockoutMask != null) {
      const ids = { blur: ctx.nextClipId("sh"), blit: ctx.nextClipId("sh") };
      ctx.defsParts.push(emitShadowMaskBlurStages(ids, sh.blur, shadowColor, blurRegion));
      const shape = skRRectSvg(sx, sy, sw, sh2, shadowCorners, `${fill} filter="url(#${ids.blur})"`, shadowShapeNumber);
      ctx.svgParts.push(`${indent}<g filter="url(#${ids.blit})"><g mask="url(#${knockoutMask})">${shape}</g></g>`);
      return;
    }
    ctx.svgParts.push(
      // A blurred shape is the SkRRect Blink fills into the mask; four equal
      // elliptical corners stay one `<rect rx ry>` (`skRRectSvg`).
      `${indent}${(sh.blur > 0 ? skRRectSvg : roundedRectSvg)(sx, sy, sw, sh2, shadowCorners, `${fill}${blurFilterAttr()}${clipAttr}`, shadowShapeNumber)}`,
    );
  }
  return;
}

// Inset box-shadow paint, extracted from renderElement (DM-1306) — the inset
// counterpart to paintBoxShadow. Per CSS Backgrounds 3 6.4 / Chromium
// BoxPainterBase::PaintInsetBoxShadow: the shadow shape is the padding box
// shifted by (x, y) and inset by spread, painted as an even-odd donut clipped to
// the padding box (a stroked-rect glow for the pure-blur-centered case). Mints a
// filter + clip id per shadow, so clipIdx is threaded in and the advanced value
// returned. Returns { svg, defs, clipIdx }.
export function paintInsetBoxShadow(
  ctx: ShadowPaintCtx,
  el: ShadowBox,
  corners: CornerRadii,
  indent: string,
  fragment?: ShadowFragment,
): void {
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
  const sides = fragment == null || includesAllSides(fragment.sides) ? null : fragment.sides;
  // A fragment's inner border drops the border widths of its excluded sides
  // (`PixelSnappedContouredInnerBorder(style, rect, sides)`,
  // box_painter_base.cc:388-405, contoured_border_geometry.cc:207-255).
  const box: ShadowBox =
    sides == null
      ? el
      : {
          ...el,
          styles: {
            ...el.styles,
            borderTopWidth: sides.top ? el.styles.borderTopWidth : "0px",
            borderRightWidth: sides.right ? el.styles.borderRightWidth : "0px",
            borderBottomWidth: sides.bottom ? el.styles.borderBottomWidth : "0px",
            borderLeftWidth: sides.left ? el.styles.borderLeftWidth : "0px",
          },
        };
  const inner = shadowInnerBorderContour(box, corners);
  const ibLeft = inner.x;
  const ibTop = inner.y;
  const ibW = inner.width;
  const ibH = inner.height;
  const innerCorners = inner.corners;
  const innerRounded = [innerCorners.tl, innerCorners.tr, innerCorners.br, innerCorners.bl].some(
    (corner) => corner.h > 0 || corner.v > 0,
  );
  const device = authenticBorderPaintSnap(el)?.device ?? fragment?.device;
  // DM-699: CSS Backgrounds 3 §6.4 stacks shadows with the FIRST shadow
  // ON TOP. The outer-shadow loop above already iterates in reverse so
  // the topmost CSS shadow emits last; this inset loop was iterating
  // FORWARD, so e.g. `box-shadow: inset 0 0 0 8px #b45309, inset 0 6px
  // 24px rgba(0,0,0,.4)` (brown ring on top of a dark glow) painted the
  // brown ring FIRST and the dark glow LAST — the glow then ended up on
  // top, darkening the brown ring at the top of the box.
  for (let si = shadows.length - 1; si >= 0; si--) {
    const sh = shadows[si];
    if (!sh.inset) continue;
    // Blink has no blur/spread early-out (BoxPainterBase::PaintInsetBoxShadow,
    // core/paint/box_painter_base.cc:526-571, Chromium 7d859f27): it clips to
    // the padding box and draws the hole shifted by the offset, so an
    // offset-only inset (`inset 0 -3px 0 …`) paints a hard crescent. Only an
    // all-zero shadow has an empty paint, because its hole is the clip.
    if (sh.x === 0 && sh.y === 0 && sh.spread === 0 && sh.blur === 0) continue;
    if (ibW <= 0 || ibH <= 0) continue;

    const shadowColor = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
    let filterAttr = "";
    if (sh.blur > 0) {
      const fid = ctx.nextClipId("ish");
      ctx.defsParts.push(emitGaussianBlurFilter(fid, sh.blur));
      filterAttr = ` filter="url(#${fid})"`;
    }
    const cid = ctx.nextClipId("ishc");
    // A sharp padding box is `context.Clip(bounds.Rect())`, a non-antialiased
    // clip (box_painter_base.cc:560-564, graphics_context.h:377-394, Chromium
    // 7d859f27) whose device rect Skia rounds to whole pixels. Placed on whole
    // device pixels, the SVG's antialiased rect clip is reduced to the same BW
    // clip (`nearly_integral`, Skia 62efacd3 SkRasterClip.cpp:161-167).
    const sharpBounds = !innerRounded;
    const snappedBounds =
      sharpBounds && device != null
        ? deviceRoundedRect({ left: ibLeft, top: ibTop, right: ibLeft + ibW, bottom: ibTop + ibH }, device)
        : null;
    ctx.defsParts.push(
      snappedBounds == null
        ? `<clipPath id="${cid}">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, "")}</clipPath>`
        : `<clipPath id="${cid}"><rect x="${devicePieceNumber(snappedBounds.left)}" y="${devicePieceNumber(snappedBounds.top)}" width="${devicePieceNumber(snappedBounds.right - snappedBounds.left)}" height="${devicePieceNumber(snappedBounds.bottom - snappedBounds.top)}"/></clipPath>`,
    );

    // Pure-blur-centered inset (x=0, y=0, spread=0, blur>0): the donut
    // has zero area, so use the legacy stroked-rect approach which
    // produces the right soft glow on all sides. Stroke width = blur/2;
    // the Gaussian softens it into Chrome's inset-glow falloff. DM-366.
    if (sides == null && sh.x === 0 && sh.y === 0 && sh.spread === 0) {
      const ringWidth = Math.max(sh.blur / 2, 1);
      ctx.svgParts.push(
        `${indent}<g clip-path="url(#${cid})">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, `fill="none" stroke="${shadowColor}" stroke-width="${r(ringWidth)}"${filterAttr}`)}</g>`,
      );
      continue;
    }

    // Donut path: outer subpath = padding box expanded by a margin
    // sized to contain the blur halo + spread; inner subpath = padding
    // box shifted by (sh.x, sh.y) and inset by sh.spread on each side.
    // Even-odd fill paints the frame between the two subpaths with the
    // shadow color; blur softens; the clip-path keeps the result inside
    // the padding box.
    // A fragment stretches the hole past its excluded sides
    // (AdjustRectForSideClipping, box_painter_base.cc:542-543).
    const holeBase =
      sides == null
        ? { left: ibLeft, top: ibTop, right: ibLeft + ibW, bottom: ibTop + ibH }
        : adjustRectForSideClipping({ left: ibLeft, top: ibTop, right: ibLeft + ibW, bottom: ibTop + ibH }, sh, sides);
    const innerL = holeBase.left + sh.x + sh.spread;
    const innerT = holeBase.top + sh.y + sh.spread;
    const innerW = holeBase.right - holeBase.left - 2 * sh.spread;
    const innerH = holeBase.bottom - holeBase.top - 2 * sh.spread;
    if (innerW <= 0 || innerH <= 0) {
      // Shadow shape collapsed: per spec the entire padding box fills
      // with shadow color (with blur halo) — emit a solid rect.
      ctx.svgParts.push(
        `${indent}<g clip-path="url(#${cid})">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, `fill="${shadowColor}"${filterAttr}`)}</g>`,
      );
      continue;
    }
    const innerC = insetCornerRadii(innerCorners, sh.spread, sh.spread, sh.spread, sh.spread);
    const margin = Math.max(Math.abs(sh.x), Math.abs(sh.y), sh.spread, sh.blur, 1) * 4;
    let outerX = Math.min(ibLeft, innerL) - margin;
    let outerY = Math.min(ibTop, innerT) - margin;
    let outerR = Math.max(ibLeft + ibW, innerL + innerW) + margin;
    let outerB = Math.max(ibTop + ibH, innerT + innerH) + margin;
    if (sharpBounds && sh.blur === 0) {
      // Blink fills `AreaCastingShadowInHole` around the hole (a rect with a
      // contoured hole, box_painter_base.cc:571-576). Its outer edge meets the
      // padding box wherever the offset does not move it, so its coverage is
      // visible where the rounded clip edge falls outside; and a path that
      // fits Skia's 32px mask accumulator (`MaskAdditiveBlitter::
      // CanHandleRect`) takes a different coverage route than a wider one.
      // A blurred shadow keeps the padded rect: its mask-filter route has no
      // native control here yet.
      const casting = insetShadowCastingRect(
        { left: ibLeft, top: ibTop, right: ibLeft + ibW, bottom: ibTop + ibH },
        sh.x,
        sh.y,
        sh.blur,
        sh.spread,
      );
      outerX = casting.left;
      outerY = casting.top;
      outerR = casting.right;
      outerB = casting.bottom;
    }
    const sharp: CornerRadii = {
      tl: { h: 0, v: 0 },
      tr: { h: 0, v: 0 },
      br: { h: 0, v: 0 },
      bl: { h: 0, v: 0 },
      uniform: true,
    };
    const pathNumber = sharpBounds && sh.blur === 0 ? devicePieceNumber : r;
    const outerD = roundedRectPath(outerX, outerY, outerR - outerX, outerB - outerY, sharp, pathNumber);
    const innerD = roundedRectPath(innerL, innerT, innerW, innerH, innerC, pathNumber);
    ctx.svgParts.push(
      `${indent}<g clip-path="url(#${cid})"><path d="${outerD} ${innerD}" fill="${shadowColor}" fill-rule="evenodd"${filterAttr}/></g>`,
    );
  }
  return;
}
