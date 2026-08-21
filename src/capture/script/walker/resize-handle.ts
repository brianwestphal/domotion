// @ts-nocheck
//
// Capture the facts Blink's PaintLayerScrollableArea / ScrollableAreaPainter
// consume for the platform resizer. Geometry is deliberately computed through
// the same source-transcribed helpers the SVG renderer tests and consumes.

import {
  blinkCanResize,
  blinkIsScrollContainer,
  blinkResizerCorner,
  blinkResizerIsOnLogicalLeft,
  blinkResizerThickness,
  blinkUsesCustomResizer,
} from "../../../render/resize-handle.js";

const _layoutReplacedTags = new Set([
  'img', 'video', 'canvas', 'object', 'embed', 'audio', 'iframe',
  'input', 'select',
]);

const _hasAxisScrollbar = (overflow, scrollExtent, clientExtent) => {
  if (overflow === 'scroll') return true;
  return overflow === 'auto' && scrollExtent > clientExtent;
};

export const createResizeHandleHandler = ({
  resolvePseudo,
  normColor,
  effectiveZoomFor,
  themeThickness,
  scaleFromDIP,
  vp,
}) => {
  const captureResizeHandle = (el, cs, tag, rect) => {
    const activation = {
      resize: cs.resize,
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      isLayoutReplaced: _layoutReplacedTags.has(tag),
      isLayoutIFrame: tag === 'iframe',
    };
    if (!blinkCanResize(activation)) return undefined;

    const isScrollContainer = blinkIsScrollContainer(activation);
    const zoom = effectiveZoomFor(el);
    const borderLeft = Math.round((parseFloat(cs.borderLeftWidth) || 0) * zoom);
    const borderRight = Math.round((parseFloat(cs.borderRightWidth) || 0) * zoom);
    const borderBottom = Math.round((parseFloat(cs.borderBottomWidth) || 0) * zoom);
    const hasVertical = isScrollContainer
      && _hasAxisScrollbar(cs.overflowY, el.scrollHeight, el.clientHeight);
    const hasHorizontal = isScrollContainer
      && _hasAxisScrollbar(cs.overflowX, el.scrollWidth, el.clientWidth);

    // Non-overlay bars reduce clientWidth/clientHeight. Overlay bars leave a
    // zero layout gap, in which case Scrollbar::ScrollbarThickness is the page
    // theme thickness measured by the Node-side paint probe.
    const verticalGap = Math.max(0, rect.width - el.clientWidth * zoom - borderLeft - borderRight);
    const horizontalGap = Math.max(
      0,
      rect.height
        - el.clientHeight * zoom
        - Math.round((parseFloat(cs.borderTopWidth) || 0) * zoom)
        - borderBottom,
    );
    const thickness = blinkResizerThickness({
      themeThickness,
      verticalScrollbarThickness: hasVertical
        ? (verticalGap > 0.5 ? Math.round(verticalGap) : themeThickness)
        : null,
      horizontalScrollbarThickness: hasHorizontal
        ? (horizontalGap > 0.5 ? Math.round(horizontalGap) : themeThickness)
        : null,
    });
    const logicalLeft = blinkResizerIsOnLogicalLeft(cs.direction, cs.writingMode);
    const corner = blinkResizerCorner({
      x: rect.left,
      y: rect.top,
      borderBoxWidth: rect.width,
      borderBoxHeight: rect.height,
      borderLeftWidth: borderLeft,
      borderRightWidth: borderRight,
      borderBottomWidth: borderBottom,
      cornerWidth: thickness.width,
      cornerHeight: thickness.height,
      logicalLeft,
    });

    const pseudo = resolvePseudo(el, 'resizer');
    const custom = blinkUsesCustomResizer(true, isScrollContainer, pseudo.matched)
      ? {
          // Authored dimensions are evidence only. Blink overrides the custom
          // layout object's size with CornerRect before ObjectPainter runs.
          authoredWidth: pseudo.width || undefined,
          authoredHeight: pseudo.height || undefined,
          backgroundColor: pseudo.backgroundColor
            ? normColor(pseudo.backgroundColor)
            : undefined,
          backgroundImage: pseudo.backgroundImage || undefined,
          borderRadius: pseudo.borderRadius || undefined,
          border: pseudo.border || undefined,
          boxShadow: pseudo.boxShadow || undefined,
          effectiveZoom: zoom,
        }
      : undefined;

    return {
      x: corner.x - vp.x,
      y: corner.y - vp.y,
      width: corner.width,
      height: corner.height,
      logicalLeft,
      scaleFromDIP,
      hasScrollbar: thickness.hasScrollbar,
      custom,
    };
  };

  return { captureResizeHandle };
};
