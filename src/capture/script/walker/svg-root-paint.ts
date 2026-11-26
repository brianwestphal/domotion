import { isPaintedColor } from "../../../utils/transparent-background.js";
import { adoptAuthorShadowContext, type AuthorShadowContextCapability } from "../../author-shadow-context-record.js";
import type { InlineSvgRootRuntime } from "../../inline-svg-root-runtime.js";
import type { CapturedElement } from "../../types.js";
import { hasCapturedPaintTransform, localPaintOffset } from "./border-paint-snap.js";

/**
 * Chromium 147 (6b5a1b80), svg_root_painter.cc:16-60. PixelSnappedSize
 * starts at the local paint offset. With positive integral StitchedSize the
 * snap preserves both dimensions. A fractional stitched size needs the
 * separately witnessed runtime branch and snapped overflow viewport. The
 * cloned SVG supplies LocalToBorderBox's mapping in the original layout size.
 */
export function captureSvgRootPaint(
  el: Element,
  rect: DOMRect,
  capability: AuthorShadowContextCapability | undefined,
  runtime?: InlineSvgRootRuntime,
): CapturedElement["svgRootPaint"] {
  const fractional = !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height);
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
    (fractional &&
      (runtime == null || !Number.isSafeInteger(rect.width * 64) || !Number.isSafeInteger(rect.height * 64))) ||
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
  const x = Math.round(local.x);
  const y = Math.round(local.y);
  const dx = local.shift.x + x - local.x;
  const dy = local.shift.y + y - local.y;
  if (!fractional && dx === 0 && dy === 0) return undefined;
  const snappedWidth = Math.round(local.x + rect.width) - x;
  const snappedHeight = Math.round(local.y + rect.height) - y;
  // The native tiny/empty path has a separate SnapSizeToPixel minimum.
  if (fractional && (snappedWidth <= 0 || snappedHeight <= 0)) return undefined;
  const shrinks = snappedWidth < rect.width || snappedHeight < rect.height;
  if (fractional && shrinks && runtime === "pinned-unknown") return undefined;
  // The light-DOM parent chain cannot expose a closed slotted host. Adopt the
  // particular candidate only once every geometry check has passed.
  if (
    adoptAuthorShadowContext(el, capability, { mode: "inline-svg-roots", purpose: "inline SVG root paint" }) !== "none"
  )
    return undefined;
  const viewport = { dx, dy, width: rect.width, height: rect.height };
  if (!fractional) return { source: "blink-inline-svg-root-paint-v1", ...viewport };
  let scaleX = 1;
  let scaleY = 1;
  if (shrinks && runtime === "shrink") {
    scaleX = Math.fround(snappedWidth / Math.fround(rect.width));
    scaleY = Math.fround(snappedHeight / Math.fround(rect.height));
    const uniform = Math.min(scaleX, scaleY);
    // PhysicalSize::Scale uses LayoutUnit(float), which truncates to its 1/64 grid.
    const scaled = (size: number) => Math.trunc(Math.fround(Math.fround(size) * uniform) * 64) / 64;
    if (snappedWidth - scaled(rect.width) <= 1 && snappedHeight - scaled(rect.height) <= 1) {
      scaleX = scaleY = uniform;
    }
  }
  return {
    source: "blink-inline-svg-root-paint-v2",
    ...viewport,
    scaleX,
    scaleY,
    snappedWidth,
    snappedHeight,
    clip: style.overflowX === "hidden",
  };
}
