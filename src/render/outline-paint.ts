import type { CapturedElement } from "../capture/types.js";
import { colorStr, parseColor } from "./colors.js";
import { r } from "./format.js";
import { closedDashArray, openDashArray, isThinDotted, DOUBLE_MIN_WIDTH } from "./stroke-style.js";

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

// Outline paint phase, extracted from elementTreeToSvgInner (DM-1306). Reads only
// el + the resolved borderRadius + indent; appends to no shared state, so it
// returns its <rect>/<line> markup for the caller to push. Behavior-identical.
export function paintOutline(el: CapturedElement, borderRadius: number, indent: string): string[] {
  const out: string[] = [];
  const ow = parseFloat(el.styles.outlineWidth ?? "0") || 0;
  const ostyle = el.styles.outlineStyle ?? "none";
  if (ow > 0 && ostyle !== "none" && ostyle !== "hidden") {
    const ocolor = parseColor(el.styles.outlineColor ?? el.styles.color);
    if (ocolor != null && ocolor.a > 0.01) {
      const offset = parseFloat(el.styles.outlineOffset ?? "0") || 0;
      // Outline rect outer edge is at border-box + offset. Stroke is
      // centered, so the rect goes at offset + ow/2 from the border-box.
      const inflate = offset + ow / 2;
      let ox = el.x - inflate;
      let oy = el.y - inflate;
      let owd = el.width + inflate * 2;
      let oh = el.height + inflate * 2;
      // DM-2324: ComplexOutlinePainter builds its right-angle region from
      // integer gfx::Rects, outsets that region by the integer outline offset
      // and width, then derives the center path.  getBoundingClientRect() is
      // fractional, so retaining its edges here put otherwise-crisp 1--3 px
      // dotted outlines between device pixels under CSS zoom.
      if (borderRadius === 0) {
        const width = Math.round(ow);
        const outset = Math.round(offset) + width;
        const outerLeft = Math.round(el.x) - outset;
        const outerTop = Math.round(el.y) - outset;
        const outerRight = Math.round(el.x + el.width) + outset;
        const outerBottom = Math.round(el.y + el.height) + outset;
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
        const outerR = Math.max(0, oRadius + half);
        const innerR = Math.max(0, oRadius - half);
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
        const jointOffset = Math.floor((Math.round(ow) + 1) / 2);
        const sideLeft = ox - jointOffset,
          sideRight = oxR + jointOffset;
        const sideTop = oy - jointOffset,
          sideBottom = oyB + jointOffset;
        const hLen = sideRight - sideLeft,
          vLen = sideBottom - sideTop;
        const hDash = openDashArray(ostyle, ow, hLen);
        const vDash = openDashArray(ostyle, ow, vLen);
        const hAttrs = hDash !== "" ? ` stroke-dasharray="${hDash}"` : "";
        const vAttrs = vDash !== "" ? ` stroke-dasharray="${vDash}"` : "";
        const strokeAttrs = `stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"`;
        // Four sides, each starting at its top-left corner so the
        // dash pattern phases identically per side.
        if (thinDotted) {
          const color = colorStr(ocolor);
          out.push(
            ...paintThinDottedLine(sideLeft, oy, sideRight, oy, ow, color, indent),
            ...paintThinDottedLine(oxR, sideTop, oxR, sideBottom, ow, color, indent),
            ...paintThinDottedLine(sideLeft, oyB, sideRight, oyB, ow, color, indent),
            ...paintThinDottedLine(ox, sideTop, ox, sideBottom, ow, color, indent),
          );
        } else {
          out.push(
            `${indent}<line x1="${r(sideLeft)}" y1="${r(oy)}" x2="${r(sideRight)}" y2="${r(oy)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${indent}<line x1="${r(oxR)}" y1="${r(sideTop)}" x2="${r(oxR)}" y2="${r(sideBottom)}" ${strokeAttrs}${vAttrs}${linecap} />`,
            `${indent}<line x1="${r(sideLeft)}" y1="${r(oyB)}" x2="${r(sideRight)}" y2="${r(oyB)}" ${strokeAttrs}${hAttrs}${linecap} />`,
            `${indent}<line x1="${r(ox)}" y1="${r(sideTop)}" x2="${r(ox)}" y2="${r(sideBottom)}" ${strokeAttrs}${vAttrs}${linecap} />`,
          );
        }
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
