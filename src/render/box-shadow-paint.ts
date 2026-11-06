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
import { r } from "./format.js";
import { parseColor, colorStr } from "./colors.js";
import {
  insetCornerRadii,
  outsetCornerRadiiForShadow,
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
  >;
}

export function paintBoxShadow(ctx: ShadowPaintCtx, el: ShadowBox, corners: CornerRadii, indent: string): void {
  const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
  for (let si = shadows.length - 1; si >= 0; si--) {
    const sh = shadows[si];
    if (sh.inset) continue;
    // Negative spread is allowed: per CSS Backgrounds 3 §6.4 the shadow
    // shape's width/height = box + 2*spread (so spread < 0 shrinks the
    // shadow). Chromium's `BoxShadowData::ApplyToBoxOuter` shrinks the
    // outer rect by `-spread` on each side and zero-clamps the result.
    // Rect inflated by spread and shifted by (x, y).
    const sx = el.x + sh.x - sh.spread;
    const sy = el.y + sh.y - sh.spread;
    const sw = el.width + sh.spread * 2;
    const sh2 = el.height + sh.spread * 2;
    if (sw <= 0 || sh2 <= 0) continue;
    // Outer shadow corners per CSS Backgrounds 3 §6.4 / Chromium
    // `FloatRoundedRect::Outset`: a non-zero source corner grows by
    // `spread`; a zero source corner STAYS sharp. The naive grow-all
    // path produced visibly rounded corners on the concentric-outline
    // pattern (box-shadow: 0 0 0 Npx on a 0-radius box).
    const shadowCorners = outsetCornerRadiiForShadow(corners, sh.spread);
    let filterAttr = "";
    if (sh.blur > 0) {
      const fid = ctx.nextClipId("sh");
      // Filter region needs to extend beyond the shadow rect by enough
      // padding to keep the Gaussian fall-off from clipping. Use a
      // generous 200% on each side; primitiveUnits inherits the default
      // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
      ctx.defsParts.push(emitGaussianBlurFilter(fid, sh.blur));
      filterAttr = ` filter="url(#${fid})"`;
    }
    ctx.svgParts.push(
      `${indent}${roundedRectSvg(sx, sy, sw, sh2, shadowCorners, `fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr}`)}`,
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
  const sbwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const sbwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const sbwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const sbwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const ibLeft = el.x + sbwL;
  const ibTop = el.y + sbwT;
  const ibW = Math.max(0, el.width - sbwL - sbwR);
  const ibH = Math.max(0, el.height - sbwT - sbwB);
  const innerCorners = insetCornerRadii(corners, sbwT, sbwR, sbwB, sbwL);
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
