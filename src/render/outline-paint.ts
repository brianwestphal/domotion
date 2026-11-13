import type { CapturedElement } from "../capture/types.js";
import { colorStr, parseColor } from "./colors.js";
import { r } from "./format.js";
import { renderWarn } from "./render-warn.js";
import { closedDashArray, openDashArray, isThinDotted, DOUBLE_MIN_WIDTH } from "./stroke-style.js";
import { blinkCurvedDashPathLength, parseCornerRadii, roundedRectPath, type CornerRadii } from "./borders.js";
import { BEVEL_PAINT_ORDER, bevelShades, bevelSidePolygons } from "./border-paint.js";

export interface ThinDottedEndpointPlan {
  startDotGrowth: number | null;
  endDotGrowth: number | null;
  lineStart: number;
  lineEnd: number;
}

/**
 * Chromium `EnforceDotsAtEndpoints`, expressed along one increasing axis.
 * The caller supplies the already-rounded integer path length and stroke
 * width used by BoxBorderPainter. A non-null growth means that endpoint dot
 * is painted explicitly; zero is an ordinary width-by-width square.
 */
export function thinDottedEndpointPlan(pathLength: number, width: number): ThinDottedEndpointPlan {
  const length = Math.round(pathLength);
  const w = Math.round(width);
  let startDotGrowth: number | null = null;
  let startLineOffset = 0;
  let endDotGrowth: number | null = null;
  const mod4 = length % 4;
  const mod6 = length % 6;
  if ((w === 1 && length % 2 === 0) || (w === 3 && mod6 === 0)) {
    startDotGrowth = 1;
    startLineOffset = 1;
  }
  if ((w === 2 && (mod4 === 0 || mod4 === 1)) || (w === 3 && (mod6 === 1 || mod6 === 2))) {
    startDotGrowth = 0;
    startLineOffset = -1;
  }
  if ((w === 2 && mod4 === 0) || (w === 3 && mod6 === 1)) endDotGrowth = 0;
  if ((w === 2 && mod4 === 3) || (w === 3 && (mod6 === 4 || mod6 === 5))) {
    startDotGrowth = 0;
    startLineOffset = 1;
  }
  if (w === 3 && mod6 === 5) endDotGrowth = 0;
  else if (w === 3 && mod6 === 0) endDotGrowth = 1;
  return {
    startDotGrowth,
    endDotGrowth,
    lineStart: startDotGrowth == null ? 0 : 2 * w + startLineOffset,
    lineEnd: endDotGrowth == null ? length : length - (w + endDotGrowth + 1),
  };
}

export function paintThinDottedLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: string,
  indent: string,
): string[] {
  const vertical = x1 === x2;
  const w = Math.round(width);
  const length = Math.round(vertical ? y2 - y1 : x2 - x1);
  const plan = thinDottedEndpointPlan(length, w);
  const out: string[] = [];
  if (plan.startDotGrowth != null) {
    out.push(
      vertical
        ? `${indent}<rect x="${r(x1 - w / 2)}" y="${r(y1)}" width="${r(w)}" height="${r(w + plan.startDotGrowth)}" fill="${color}" />`
        : `${indent}<rect x="${r(x1)}" y="${r(y1 - w / 2)}" width="${r(w + plan.startDotGrowth)}" height="${r(w)}" fill="${color}" />`,
    );
  }
  if (plan.endDotGrowth != null) {
    out.push(
      vertical
        ? `${indent}<rect x="${r(x2 - w / 2)}" y="${r(y2 - w - plan.endDotGrowth)}" width="${r(w)}" height="${r(w + plan.endDotGrowth)}" fill="${color}" />`
        : `${indent}<rect x="${r(x2 - w - plan.endDotGrowth)}" y="${r(y2 - w / 2)}" width="${r(w + plan.endDotGrowth)}" height="${r(w)}" fill="${color}" />`,
    );
  }
  // The caller passes the visible centerline (Chromium's integer center path
  // plus DrawLineWithStyle's odd-width 0.5 adjustment). Keeping that boundary
  // here also makes the explicit endpoint rectangles integral for odd widths.
  const sx = vertical ? x1 : x1 + plan.lineStart;
  const sy = vertical ? y1 + plan.lineStart : y1;
  const ex = vertical ? x2 : x1 + plan.lineEnd;
  const ey = vertical ? y1 + plan.lineEnd : y2;
  if (plan.lineEnd >= plan.lineStart) {
    out.push(
      `${indent}<line x1="${r(sx)}" y1="${r(sy)}" x2="${r(ex)}" y2="${r(ey)}" stroke="${color}" stroke-width="${r(w)}" stroke-dasharray="${r(w)} ${r(w)}" />`,
    );
  }
  return out;
}

/**
 * Blink's `AdjustedOutlineOffset` (outline_painter.cc:79-82, chromium 6b5a1b80):
 * a negative integer outline-offset may pull each axis of the pixel-snapped
 * rect in by at most half that axis's extent (C++ integer division), so the
 * outline never inverts. `PaintSingleRectOutline` and the right-angle path
 * both receive these per-axis outsets.
 */
export function adjustedOutlineOffset(
  snappedWidth: number,
  snappedHeight: number,
  offset: number,
): { horizontal: number; vertical: number } {
  // `+ 0` folds the -0 a zero extent yields into 0, as C++ integers do.
  return {
    horizontal: Math.max(offset, -Math.trunc(snappedWidth / 2)) + 0,
    vertical: Math.max(offset, -Math.trunc(snappedHeight / 2)) + 0,
  };
}

// Outline paint phase, extracted from elementTreeToSvgInner (DM-1306). Reads only
// el + the resolved borderRadius + indent; appends to no shared state, so it
// returns its <rect>/<line> markup for the caller to push. Behavior-identical.
export function paintOutline(el: CapturedElement, borderRadius: number, indent: string): string[] {
  const out: string[] = [];
  const ow = parseFloat(el.styles.outlineWidth ?? "0") || 0;
  const ostyle = el.styles.outlineStyle ?? "none";
  if (ostyle === "auto" && el.styles.focusRing != null) return paintFocusRing(el, indent);
  if (ow > 0 && ostyle !== "none" && ostyle !== "hidden") {
    const ocolor = parseColor(el.styles.outlineColor ?? el.styles.color);
    // Blink paints an outline edge whenever its color is not fully transparent
    // (BorderEdge::HasVisibleColorAndStyle, core/style/border_edge.cc at
    // 6b5a1b80); a near-zero alpha still quantizes to visible pixels.
    if (ocolor != null && ocolor.a > 0) {
      const offset = parseFloat(el.styles.outlineOffset ?? "0") || 0;
      const snappedLeft = Math.round(el.x);
      const snappedTop = Math.round(el.y);
      const snappedRight = Math.round(el.x + el.width);
      const snappedBottom = Math.round(el.y + el.height);
      // DM-GQJ8C4: clamp a negative offset per axis, as Blink does, instead of
      // letting it invert the outline rect.
      const clamp = adjustedOutlineOffset(snappedRight - snappedLeft, snappedBottom - snappedTop, offset);
      // Outline rect outer edge is at border-box + offset. Stroke is
      // centered, so the rect goes at offset + ow/2 from the border-box.
      const inflateX = clamp.horizontal + ow / 2;
      const inflateY = clamp.vertical + ow / 2;
      const inflate = Math.min(inflateX, inflateY);
      let ox = el.x - inflateX;
      let oy = el.y - inflateY;
      let owd = el.width + inflateX * 2;
      let oh = el.height + inflateY * 2;
      // DM-2324: ComplexOutlinePainter builds its right-angle region from
      // integer gfx::Rects, outsets that region by the integer outline offset
      // and width, then derives the center path.  getBoundingClientRect() is
      // fractional, so retaining its edges here put otherwise-crisp 1--3 px
      // dotted outlines between device pixels under CSS zoom.
      if (borderRadius === 0) {
        const width = Math.round(ow);
        const snappedClamp = adjustedOutlineOffset(
          snappedRight - snappedLeft,
          snappedBottom - snappedTop,
          Math.round(offset),
        );
        const outsetX = snappedClamp.horizontal + width;
        const outsetY = snappedClamp.vertical + width;
        const outerLeft = snappedLeft - outsetX;
        const outerTop = snappedTop - outsetY;
        const outerRight = snappedRight + outsetX;
        const outerBottom = snappedBottom + outsetY;
        ox = outerLeft + width / 2;
        oy = outerTop + width / 2;
        owd = outerRight - outerLeft - width;
        oh = outerBottom - outerTop - width;
      }
      // Outline radius: CSS spec says rounded outlines follow the border
      // radius extended outward by the offset+width. Approximate.
      const oRadius = borderRadius > 0 ? borderRadius + inflate : 0;
      if (ostyle === "double" && ow >= DOUBLE_MIN_WIDTH) {
        // Chromium's PaintDoubleOutline (third_party/blink/renderer/core/
        // paint/outline_painter.cc): stroke_width = round(width / 3).
        // Outer stripe occupies the OUTER `sw` pixels of the outline rect,
        // inner stripe the INNER `sw` pixels, separated by `ow - 2*sw`.
        // The captured `ox / owd` is the centerline rect for a standard
        // ow-wide stroke (outer edge = ox - ow/2). Each stripe is `sw`
        // wide; the outer stripe's centerline sits at `outer_edge + sw/2`,
        // the inner stripe's at `inner_edge - sw/2 = outer_edge + ow -
        // sw/2`. Relative to ox that's −(ow-sw)/2 and +(ow-sw)/2. The
        // earlier formulation positioned both stripes inside the gap zone
        // and the inner stripe outside the border-box, producing one
        // visually-merged stroke. (DM-443.)
        const sw = Math.round(ow / 3);
        const half = (ow - sw) / 2;
        // A zero radius stays square: Blink grows only nonzero radius
        // components (FloatRoundedRect::Radii::Outset, chromium 6b5a1b80).
        const outerR = oRadius > 0 ? Math.max(0, oRadius + half) : 0;
        const innerR = oRadius > 0 ? Math.max(0, oRadius - half) : 0;
        out.push(
          `${indent}<rect x="${r(ox - half)}" y="${r(oy - half)}" width="${r(owd + 2 * half)}" height="${r(oh + 2 * half)}" rx="${r(outerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
        );
        out.push(
          `${indent}<rect x="${r(ox + half)}" y="${r(oy + half)}" width="${r(owd - 2 * half)}" height="${r(oh - 2 * half)}" rx="${r(innerR)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(sw)}" />`,
        );
      } else if ((ostyle === "dashed" || ostyle === "dotted") && oRadius === 0) {
        // DM-910 / DM-911: a single `<rect stroke-dasharray>` runs the
        // dash pattern unbroken across all four corners, so the dashes
        // phase differently from Chrome's outline painter. Chrome paints
        // each side independently and starts a fresh dash at each corner.
        //
        // DM-2660: for a single outline rect, Blink delegates to
        // `BoxBorderPainter::PaintSingleRectOutline`. Its side rectangles run
        // all the way between the OUTER corners; the stroke centerline is only
        // inset perpendicular to the side. The old SVG used the center-path
        // corners on both axes, shortening every side by one outline width.
        // Besides moving the first dash inward, that changed
        // `SelectBestDashGap` (90px vertical side => 4.5px gap instead of the
        // correct 92px side => 3.6px gap in `14-deep-float-bfc`).
        //
        // Reproduce the outer-corner side geometry with the same per-side dash
        // math used for dashed/dotted borders. We only take this path when the
        // outline is NOT rounded (oRadius == 0); for rounded outlines the
        // single-rect emit remains the closest SVG-native fit.
        const thinDotted = ostyle === "dotted" && isThinDotted(ow);
        const linecap = ostyle === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
        const oxR = ox + owd,
          oyB = oy + oh;
        // The single-rect outline paints each side over the pixel-snapped
        // outer rect (BoxBorderPainter's outline constructor, outsets =
        // offset + width), so a side runs exactly from outer corner to outer
        // corner: half the snapped width out from the centerline. The old
        // floor((w + 1) / 2) joint overshot by 0.5px at each end for odd
        // widths, which lengthened a 1px side by 1px and changed the dash fit.
        const halfWidth = Math.round(ow) / 2;
        const sideLeft = ox - halfWidth,
          sideRight = oxR + halfWidth;
        const sideTop = oy - halfWidth,
          sideBottom = oyB + halfWidth;
        const hLen = sideRight - sideLeft,
          vLen = sideBottom - sideTop;
        const hDash = openDashArray(ostyle, ow, hLen);
        const vDash = openDashArray(ostyle, ow, vLen);
        // DrawLineWithStyle sizes thick-dotted intervals from that full length,
        // then moves both endpoints in by width/2 so the round caps stay inside
        // (box_border_painter.cc:529-538, chromium 7d859f27).
        const capInset = ostyle === "dotted" && !thinDotted ? halfWidth : 0;
        const hAttrs = hDash !== "" ? ` stroke-dasharray="${hDash}"` : "";
        const vAttrs = vDash !== "" ? ` stroke-dasharray="${vDash}"` : "";
        // DM-3W427J: a translucent outline is one opacity group whose sides meet
        // at the corners, so BoxBorderPainter::PaintOpacityGroup paints the
        // sides opaque inside BeginLayer(alpha) (chromium 6b5a1b80). Separately
        // translucent side strokes would double-blend where they overlap.
        const layered = ocolor.a < 1;
        const sideColor = colorStr(layered ? { ...ocolor, a: 1 } : ocolor);
        const sideIndent = layered ? `${indent}  ` : indent;
        if (layered) out.push(`${indent}<g opacity="${r(ocolor.a)}">`);
        const strokeAttrs = `stroke="${sideColor}" stroke-width="${r(ow)}"`;
        // Four sides, each starting at its top-left corner so the
        // dash pattern phases identically per side.
        if (thinDotted) {
          const color = sideColor;
          out.push(
            ...paintThinDottedLine(sideLeft, oy, sideRight, oy, ow, color, sideIndent),
            ...paintThinDottedLine(oxR, sideTop, oxR, sideBottom, ow, color, sideIndent),
            ...paintThinDottedLine(sideLeft, oyB, sideRight, oyB, ow, color, sideIndent),
            ...paintThinDottedLine(ox, sideTop, ox, sideBottom, ow, color, sideIndent),
          );
        } else {
          out.push(
            `${sideIndent}<line x1="${r(sideLeft + capInset)}" y1="${r(oy)}" x2="${r(sideRight - capInset)}" y2="${r(oy)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${sideIndent}<line x1="${r(oxR)}" y1="${r(sideTop + capInset)}" x2="${r(oxR)}" y2="${r(sideBottom - capInset)}" ${strokeAttrs}${vAttrs}${linecap} />`,
            `${sideIndent}<line x1="${r(sideLeft + capInset)}" y1="${r(oyB)}" x2="${r(sideRight - capInset)}" y2="${r(oyB)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${sideIndent}<line x1="${r(ox)}" y1="${r(sideTop + capInset)}" x2="${r(ox)}" y2="${r(sideBottom - capInset)}" ${strokeAttrs}${vAttrs}${linecap} />`,
          );
        }
        if (layered) out.push(`${indent}</g>`);
      } else if ((ostyle === "dashed" || ostyle === "dotted") && borderRadius > 0) {
        out.push(...paintCurvedDashedDottedOutline(el, borderRadius, offset, ow, ostyle, colorStr(ocolor), indent));
      } else if (
        (ostyle === "groove" || ostyle === "ridge" || ostyle === "inset" || ostyle === "outset") &&
        Math.round(ow) >= 1 &&
        !hasRoundedCorner(el)
      ) {
        // DM-W1Q7TN: a single-rect outline paints through BoxBorderPainter
        // with the outline style on all four edges (chromium 6b5a1b80), so a
        // 3D style takes the same per-side bevel as a border of the outline's
        // width on its pixel-snapped outer rect.
        const width = Math.round(ow);
        const outer = {
          x: ox - width / 2,
          y: oy - width / 2,
          width: owd + width,
          height: oh + width,
        } as CapturedElement;
        const polygons = bevelSidePolygons(outer, width);
        for (const side of BEVEL_PAINT_ORDER) {
          const shades = bevelShades(ocolor, ostyle, side);
          const shape = polygons[side];
          if (ostyle === "inset" || ostyle === "outset") {
            out.push(`${indent}<polygon points="${shape.full}" fill="${shades.outer}" />`);
          } else {
            out.push(`${indent}<polygon points="${shape.outer}" fill="${shades.outer}" />`);
            out.push(`${indent}<polygon points="${shape.inner}" fill="${shades.inner}" />`);
          }
        }
      } else if (ostyle === "solid" && hasRoundedCorner(el)) {
        out.push(paintSolidContouredOutline(el, offset, ow, colorStr(ocolor), indent));
      } else {
        const perimeter = 2 * (owd + oh - 4 * oRadius) + 2 * Math.PI * oRadius;
        const dash = closedDashArray(ostyle, ow, perimeter);
        const linecap = ostyle === "dotted" && !isThinDotted(ow) ? ` stroke-linecap="round"` : "";
        out.push(
          `${indent}<rect x="${r(ox)}" y="${r(oy)}" width="${r(owd)}" height="${r(oh)}" rx="${r(oRadius)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
        );
      }
    }
  }
  return out;
}

export interface FocusRingStroke {
  /** The stroked rounded rect, centered on the ring. */
  x: number;
  y: number;
  w: number;
  h: number;
  radii: CornerRadii;
  strokeWidth: number;
  color: string;
}

/** SkRRect::setRectRadii: when adjacent radii overflow a side, every radius
 * scales by the smallest side / (sum of its radii). */
function skRRectRadii(w: number, h: number, c: CornerRadii): CornerRadii {
  const scale = Math.min(
    1,
    c.tl.h + c.tr.h > 0 ? w / (c.tl.h + c.tr.h) : 1,
    c.bl.h + c.br.h > 0 ? w / (c.bl.h + c.br.h) : 1,
    c.tl.v + c.bl.v > 0 ? h / (c.tl.v + c.bl.v) : 1,
    c.tr.v + c.br.v > 0 ? h / (c.tr.v + c.br.v) : 1,
  );
  if (scale >= 1) return c;
  const at = (corner: { h: number; v: number }) => ({ h: corner.h * scale, v: corner.v * scale });
  return { tl: at(c.tl), tr: at(c.tr), br: at(c.br), bl: at(c.bl), uniform: c.uniform };
}

/**
 * DM-ZVQJYP: the two strokes of an `outline-style: auto` focus ring, outer
 * ring first (`PaintFocusRing`, core/paint/outline_painter.cc:853-893,
 * chromium 6b5a1b80). Each ring strokes 2W/3 centered on the pixel-snapped
 * border box outset by its offset, per axis clamped like any outline
 * (`ComputeRightAnglePath` / `AdjustedOutlineOffset`). Both share one radii
 * set (`GetFocusRingCornerRadii`, :755-803): an authored border radius grown
 * by the integer outline-offset with every component raised to at least W,
 * otherwise W everywhere. The ring is a single rounded rect, so Skia's
 * radius scale-down applies (`DrawFocusRingRect` → `drawRRect`).
 */
export function focusRingStrokes(el: CapturedElement): FocusRingStroke[] {
  const ring = el.styles.focusRing;
  if (ring == null) return [];
  const left = Math.round(el.x),
    top = Math.round(el.y);
  const width = Math.round(el.x + el.width) - left,
    height = Math.round(el.y + el.height) - top;
  if (width <= 0 || height <= 0) return [];
  const base = parseCornerRadii(el.styles, el.width, el.height);
  const authored = [base.tl, base.tr, base.br, base.bl].some((corner) => corner.h > 0 || corner.v > 0);
  const grow = (corner: { h: number; v: number }) => ({
    h: Math.max(ring.ringWidth, corner.h > 0 ? Math.max(0, corner.h + ring.outlineOffset) : 0),
    v: Math.max(ring.ringWidth, corner.v > 0 ? Math.max(0, corner.v + ring.outlineOffset) : 0),
  });
  const square = { h: ring.ringWidth, v: ring.ringWidth };
  const radii: CornerRadii = authored
    ? { tl: grow(base.tl), tr: grow(base.tr), br: grow(base.br), bl: grow(base.bl), uniform: false }
    : { tl: square, tr: square, br: square, bl: square, uniform: true };
  const strokeWidth = (ring.ringWidth / 3) * 2;
  const at = (offset: number, color: string): FocusRingStroke => {
    const clamp = adjustedOutlineOffset(width, height, offset);
    const w = width + clamp.horizontal * 2,
      h = height + clamp.vertical * 2;
    return {
      x: left - clamp.horizontal,
      y: top - clamp.vertical,
      w,
      h,
      radii: skRRectRadii(w, h, radii),
      strokeWidth,
      color,
    };
  };
  // An offset that collapses the region leaves ComputeRightAnglePath an
  // empty path, so PaintSingleFocusRing paints nothing for that ring.
  return [
    at(ring.ringOffset + Math.ceil(ring.ringWidth / 3), ring.outerColor),
    at(ring.ringOffset, ring.innerColor),
  ].filter((stroke) => stroke.w > 0 && stroke.h > 0);
}

function paintFocusRing(el: CapturedElement, indent: string): string[] {
  const ring = el.styles.focusRing;
  if (ring == null) return [];
  if (ring.nativeAppearance) {
    renderWarn(
      "focus-ring",
      "focus ring on a native-appearance control uses the default ring radius, not the NativeTheme part radius",
    );
  }
  const curvature = parseCornerRadii(el.styles, el.width, el.height).curvature;
  if (curvature != null && Object.values(curvature).some((exponent) => exponent !== 2)) {
    renderWarn("focus-ring", "focus ring with a non-round corner-shape is painted with round corners");
  }
  const out: string[] = [];
  for (const stroke of focusRingStrokes(el)) {
    const color = parseColor(stroke.color);
    if (color == null || color.a <= 0) continue;
    out.push(
      `${indent}<path d="${roundedRectPath(stroke.x, stroke.y, stroke.w, stroke.h, stroke.radii)}" fill="none" stroke="${colorStr(color)}" stroke-width="${r(stroke.strokeWidth)}" />`,
    );
  }
  return out;
}

/** True when any corner is rounded. The caller's scalar radius is the
 * top-left corner only, so this reads all four. */
function hasRoundedCorner(el: CapturedElement): boolean {
  const c = parseCornerRadii(el.styles, el.width, el.height);
  return [c.tl, c.tr, c.br, c.bl].some((corner) => corner.h > 0 || corner.v > 0);
}

/** DM-9X9M8A: a solid rounded single-rect outline with per-corner or elliptical
 * radii. BoxBorderPainter's outline constructor fills between two contours of
 * the pixel-snapped border box (chromium 6b5a1b80,
 * ContouredBorderGeometry::PixelSnappedContouredBorderWithOutsets): the outer
 * one outset by offset + width, the inner one by offset. Both take the border
 * radii resolved against the unsnapped box and constrained, then grow each
 * nonzero radius component by its side's outset
 * (FloatRoundedRect::Radii::Outset, float_rounded_rect.cc:115); a zero
 * component stays square. */
function paintSolidContouredOutline(
  el: CapturedElement,
  offset: number,
  ow: number,
  color: string,
  indent: string,
): string {
  const width = Math.round(ow);
  const left = Math.round(el.x),
    top = Math.round(el.y);
  const right = Math.round(el.x + el.width),
    bottom = Math.round(el.y + el.height);
  const clamp = adjustedOutlineOffset(right - left, bottom - top, Math.round(offset));
  const radii = parseCornerRadii(el.styles, el.width, el.height);
  const contour = (outsetX: number, outsetY: number): string => {
    const grow = (corner: { h: number; v: number }) => ({
      h: corner.h > 0 ? Math.max(0, corner.h + outsetX) : 0,
      v: corner.v > 0 ? Math.max(0, corner.v + outsetY) : 0,
    });
    const grown: CornerRadii = {
      tl: grow(radii.tl),
      tr: grow(radii.tr),
      br: grow(radii.br),
      bl: grow(radii.bl),
      uniform: false,
      curvature: radii.curvature,
    };
    return roundedRectPath(
      left - outsetX,
      top - outsetY,
      right - left + outsetX * 2,
      bottom - top + outsetY * 2,
      grown,
    );
  };
  const outer = contour(clamp.horizontal + width, clamp.vertical + width);
  const inner = contour(clamp.horizontal, clamp.vertical);
  return `${indent}<path d="${outer} ${inner}" fill="${color}" fill-rule="evenodd" />`;
}

/** A rounded dashed/dotted single-rect outline goes through the same
 * DrawCurvedDashedDottedBoxSide as a rounded border (chromium 7d859f27). Its
 * outer contour is the snapped border box outset by offset + width (radii
 * outset by the same amount), its inner contour the box outset by offset, and
 * the stroked centerline sits floor(width / 2) inside the outer contour
 * (CenterOutsets truncates). Dashes are fitted to the truncated Skia length of
 * that centerline; dashes and thin dots stroke at 2.2 × width under a ring
 * mask, round dots at the width itself. */
function paintCurvedDashedDottedOutline(
  el: CapturedElement,
  borderRadius: number,
  offset: number,
  ow: number,
  style: string,
  color: string,
  indent: string,
): string[] {
  const width = Math.round(ow);
  const outset = Math.round(offset) + width;
  const left = Math.round(el.x),
    top = Math.round(el.y);
  const right = Math.round(el.x + el.width),
    bottom = Math.round(el.y + el.height);
  const radiiAt = (o: number) => {
    const c = { h: Math.max(0, borderRadius + o), v: Math.max(0, borderRadius + o) };
    const radii: CornerRadii = { tl: c, tr: c, br: c, bl: c, uniform: true };
    return radii;
  };
  const box = (o: number) => ({
    x: left - o,
    y: top - o,
    w: Math.max(0, right - left + 2 * o),
    h: Math.max(0, bottom - top + 2 * o),
  });
  const outer = box(outset),
    inner = box(outset - width);
  const k = Math.floor(width / 2);
  const center = box(outset - k);
  const centerRadii = radiiAt(outset - k);
  const dash = closedDashArray(style, width, blinkCurvedDashPathLength(center.w, center.h, centerRadii));
  const roundDots = style === "dotted" && !isThinDotted(width);
  const strokeWidth = roundDots ? width : width * 2.2;
  // Derived from the geometry so output stays deterministic; equal ids carry equal masks.
  const maskId = `outline-ring-${outer.x}-${outer.y}-${outer.w}-${outer.h}-${width}-${borderRadius}`.replace(
    /\./g,
    "_",
  );
  const stroke = `<path d="${roundedRectPath(center.x, center.y, center.w, center.h, centerRadii)}" fill="none" stroke="${color}" stroke-width="${r(strokeWidth)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${roundDots ? ` stroke-linecap="round"` : ""} mask="url(#${maskId})" />`;
  // Blink clips the doubled stroke to the outer contour and clips out the
  // inner one (ClipContouredRect / ClipOutContouredRect around
  // DrawCurvedDashedDottedBoxSide, box_border_painter.cc, Chromium 6b5a1b80),
  // i.e. Skia's anti-aliased rounded-rect clips. An even-odd arc-path ring mask
  // covers the curved edges differently; a rounded-rect clipPath plus an inner
  // rounded-rect cut-out matches them (DM-C77Q41). Radii that exceed half a
  // side keep the path ring, whose per-corner clamp a <rect> cannot express.
  const outerRadius = radiiAt(outset).tl.h,
    innerRadius = radiiAt(outset - width).tl.h;
  if (
    outerRadius <= Math.min(outer.w, outer.h) / 2 &&
    innerRadius <= Math.min(inner.w, inner.h) / 2 &&
    inner.w > 0 &&
    inner.h > 0
  ) {
    const rect = (b: typeof outer, radius: number, fill?: string) =>
      `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" rx="${r(radius)}" ry="${r(radius)}"${fill != null ? ` fill="${fill}"` : ""}/>`;
    return [
      `${indent}<clipPath id="${maskId}-outer">${rect(outer, outerRadius)}</clipPath>`,
      `${indent}<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${r(outer.x)}" y="${r(outer.y)}" width="${r(outer.w)}" height="${r(outer.h)}"><rect x="${r(outer.x)}" y="${r(outer.y)}" width="${r(outer.w)}" height="${r(outer.h)}" fill="white"/>${rect(inner, innerRadius, "black")}</mask>`,
      `${indent}<g clip-path="url(#${maskId}-outer)">${stroke}</g>`,
    ];
  }
  const ring = `${roundedRectPath(outer.x, outer.y, outer.w, outer.h, radiiAt(outset))} ${roundedRectPath(inner.x, inner.y, inner.w, inner.h, radiiAt(outset - width))}`;
  return [
    `${indent}<mask id="${maskId}"><path d="${ring}" fill="white" fill-rule="evenodd"/></mask>`,
    `${indent}${stroke}`,
  ];
}
