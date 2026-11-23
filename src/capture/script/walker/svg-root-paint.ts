import { isPaintedColor } from "../../../utils/transparent-background.js";
import { adoptAuthorShadowContext, type AuthorShadowContextCapability } from "../../author-shadow-context-record.js";
import type { CapturedElement } from "../../types.js";
import { hasCapturedPaintTransform, localPaintOffset } from "./border-paint-snap.js";

/**
 * Chromium 147 (6b5a1b80), svg_root_painter.cc:16-60. PixelSnappedSize
 * starts at the local paint offset. With positive integral StitchedSize the
 * snap preserves both dimensions, so neither runtime setting can engage the
 * inline root's shrink adjustment. The cloned SVG supplies LocalToBorderBox's
 * viewBox mapping; this record supplies only the preceding translation.
 */
export function captureSvgRootPaint(
  el: Element,
  rect: DOMRect,
  capability: AuthorShadowContextCapability | undefined,
): CapturedElement["svgRootPaint"] {
  if (
    capability == null ||
    !(el instanceof SVGSVGElement) ||
    el.ownerSVGElement != null ||
    !(el.parentElement instanceof HTMLElement) ||
    el.currentScale !== 1 ||
    el.currentTranslate.x !== 0 ||
    el.currentTranslate.y !== 0 ||
    el.ownerDocument !== document ||
    !(document.documentElement instanceof HTMLHtmlElement) ||
    window !== window.top ||
    ![1, 2].includes(window.devicePixelRatio) ||
    !Number.isSafeInteger(rect.width) ||
    !Number.isSafeInteger(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return undefined;

  // Re-embedding an SVG with insets or a root x/y has additional viewport
  // geometry. A transformed or fragmented ancestor need not paint in the
  // bounding rectangle's axes; fixed/sticky and anchor scrolling have their
  // own translations. Only walk single source boxes in the main HTML document.
  const style = getComputedStyle(el);
  // Its own viewport must be the entire overflow boundary. CSS box-decoration
  // clipping remains with the ordinary renderer for decorated roots.
  if (
    style.overflowX !== style.overflowY ||
    !["hidden", "visible"].includes(style.overflowX) ||
    style.borderRadius !== "0px" ||
    isPaintedColor(style.backgroundColor) ||
    [style.backgroundImage, style.boxShadow, style.outlineStyle, style.filter].some((value) => value !== "none")
  )
    return undefined;
  if (
    [
      style.x,
      style.y,
      style.paddingTop,
      style.paddingRight,
      style.paddingBottom,
      style.paddingLeft,
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ].some((value) => value !== "0px")
  )
    return undefined;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const cs = node === el ? style : getComputedStyle(node);
    if (
      (node !== el && !(node instanceof HTMLElement)) ||
      node.getClientRects().length !== 1 ||
      hasCapturedPaintTransform(node) ||
      [cs.transform, cs.translate, cs.scale, cs.rotate, cs.perspective, cs.offsetPath].some(
        (value) => value !== "none",
      ) ||
      cs.transformStyle !== "flat" ||
      cs.zoom !== "1" ||
      cs.columnCount !== "auto" ||
      cs.columnWidth !== "auto" ||
      cs.position === "sticky" ||
      cs.position === "fixed" ||
      cs.getPropertyValue("position-anchor") !== "none" ||
      node.matches(":modal, :popover-open, :fullscreen") ||
      !Number.isInteger(node.scrollLeft) ||
      !Number.isInteger(node.scrollTop)
    )
      return undefined;
  }
  // localPaintOffset composes eligible isolation resets through the existing
  // native containment probe. Integral scroll translations preserve its phase.
  const local = localPaintOffset(el, rect, true, false, window.devicePixelRatio);
  if (local == null) return undefined;
  const dx = local.shift.x + Math.round(local.x) - local.x;
  const dy = local.shift.y + Math.round(local.y) - local.y;
  if (dx === 0 && dy === 0) return undefined;
  // The light-DOM parent chain cannot expose a closed slotted host. Adopt the
  // particular candidate only once every geometry check has passed.
  if (
    adoptAuthorShadowContext(el, capability, { mode: "inline-svg-roots", purpose: "inline SVG root paint" }) !== "none"
  )
    return undefined;
  return { source: "blink-inline-svg-root-paint-v1", dx, dy, width: rect.width, height: rect.height };
}
