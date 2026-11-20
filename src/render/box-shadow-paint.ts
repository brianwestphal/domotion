/**
 * CSS `box-shadow` paint for one border box: outer shadows (painted below the
 * background) and inset shadows (painted above the background, inside the
 * padding box). Shared by the general element renderer and by form-control
 * pseudo boxes (slider track and thumb), which have no captured element of
 * their own but are painted by the same Blink box-shadow code
 * (`BoxPainterBase::PaintNormalBoxShadow` / `PaintInsetBoxShadow`).
 */

import type { CapturedElement } from "../capture/types.js";
import { emitGaussianBlurFilter } from "./gaussian-blur.js";
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

export function paintBoxShadow(ctx: ShadowPaintCtx, el: ShadowBox, sourceCorners: CornerRadii, indent: string): void {
  // A display:contents element has no box for BoxPainterBase to decorate.
  if (el.styles.display === "contents") return;
  const border = shadowBorderContour(el, sourceCorners);
  const corners = border.corners;
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
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
    // Rect inflated by spread and shifted by (x, y).
    const sx = border.x + sh.x - sh.spread;
    const sy = border.y + sh.y - sh.spread;
    const sw = border.width + sh.spread * 2;
    const sh2 = border.height + sh.spread * 2;
    if (sw <= 0 || sh2 <= 0) continue;
    const shadowCorners = normalShadowCorners(corners, sh.spread, border.width, border.height, sw, sh2);
    let filterAttr = "";
    if (sh.blur > 0) {
      const fid = ctx.nextClipId("sh");
      // Filter region needs to extend beyond the shadow rect by enough
      // padding to keep the Gaussian fall-off from clipping. The default
      // filter region adds 50% on each side; primitiveUnits inherits the default
      // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
      ctx.defsParts.push(emitGaussianBlurFilter(fid, sh.blur));
      filterAttr = ` filter="url(#${fid})"`;
    }
    let clipAttr = "";
    const background = el.styles.backgroundColor == null ? null : parseColor(el.styles.backgroundColor);
    if (background != null && background.a < 1) {
      // Blink 147 BoxPainterBase::ClipToBorderEdge excludes the original
      // border contour before normal-shadow paint on a nonopaque background.
      // Clip after filtering, so the blur cannot refill the transparent box.
      // Opaque/unknown backgrounds retain their existing producer path.
      const clipId = ctx.nextClipId("shcut");
      const rounded = [corners.tl, corners.tr, corners.br, corners.bl].some((corner) => corner.h > 0 || corner.v > 0);
      if (rounded) {
        ctx.defsParts.push(
          `<mask id="${clipId}" maskUnits="userSpaceOnUse" x="${r(sx - sw)}" y="${r(sy - sh2)}" width="${r(sw * 3)}" height="${r(sh2 * 3)}" style="mask-type:luminance"><rect x="${r(sx - sw)}" y="${r(sy - sh2)}" width="${r(sw * 3)}" height="${r(sh2 * 3)}" fill="white"/>${roundedRectSvg(border.x, border.y, border.width, border.height, corners, 'fill="black"')}</mask>`,
        );
        clipAttr = ` mask="url(#${clipId})"`;
      } else {
        const outer = `M${r(sx - sw)} ${r(sy - sh2)}h${r(sw * 3)}v${r(sh2 * 3)}h${r(-sw * 3)}Z`;
        const hole = roundedRectPath(border.x, border.y, border.width, border.height, corners);
        ctx.defsParts.push(
          `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><path d="${outer} ${hole}" clip-rule="evenodd"/></clipPath>`,
        );
        clipAttr = ` clip-path="url(#${clipId})"`;
      }
    }
    // The corner-corrected radii are arbitrary floats (2 → 5.504 for a 4px
    // spread); the default one-decimal coordinate format would move the arc
    // by up to 0.05px, so the shadow shape keeps three decimals.
    ctx.svgParts.push(
      `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr}${clipAttr}`, shadowShapeNumber)}`,
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
export function paintInsetBoxShadow(ctx: ShadowPaintCtx, el: ShadowBox, corners: CornerRadii, indent: string): void {
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
  const inner = shadowInnerBorderContour(el, corners);
  const ibLeft = inner.x;
  const ibTop = inner.y;
  const ibW = inner.width;
  const ibH = inner.height;
  const innerCorners = inner.corners;
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
    ctx.defsParts.push(`<clipPath id="${cid}">${roundedRectSvg(ibLeft, ibTop, ibW, ibH, innerCorners, "")}</clipPath>`);

    // Pure-blur-centered inset (x=0, y=0, spread=0, blur>0): the donut
    // has zero area, so use the legacy stroked-rect approach which
    // produces the right soft glow on all sides. Stroke width = blur/2;
    // the Gaussian softens it into Chrome's inset-glow falloff. DM-366.
    if (sh.x === 0 && sh.y === 0 && sh.spread === 0) {
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
    const innerL = ibLeft + sh.x + sh.spread;
    const innerT = ibTop + sh.y + sh.spread;
    const innerW = ibW - 2 * sh.spread;
    const innerH = ibH - 2 * sh.spread;
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
    const outerX = Math.min(ibLeft, innerL) - margin;
    const outerY = Math.min(ibTop, innerT) - margin;
    const outerR = Math.max(ibLeft + ibW, innerL + innerW) + margin;
    const outerB = Math.max(ibTop + ibH, innerT + innerH) + margin;
    const sharp: CornerRadii = {
      tl: { h: 0, v: 0 },
      tr: { h: 0, v: 0 },
      br: { h: 0, v: 0 },
      bl: { h: 0, v: 0 },
      uniform: true,
    };
    const outerD = roundedRectPath(outerX, outerY, outerR - outerX, outerB - outerY, sharp);
    const innerD = roundedRectPath(innerL, innerT, innerW, innerH, innerC);
    ctx.svgParts.push(
      `${indent}<g clip-path="url(#${cid})"><path d="${outerD} ${innerD}" fill="${shadowColor}" fill-rule="evenodd"${filterAttr}/></g>`,
    );
  }
  return;
}
