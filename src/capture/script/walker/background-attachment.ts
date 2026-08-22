// @ts-nocheck
//
// Blink URL-background attachment ownership, captured while the DOM is live.
// This module runs inside CAPTURE_SCRIPT. Keep it browser-only and dependency
// free: the build step bundles it into one page.evaluate() function.
//
// Chromium 7d859f271cbda744098ac69f44978d4edfa62be3:
// - BoxBackgroundPaintContext::HasBackgroundFixedToViewport walks paint
//   layers up to (but not including) the root layer. An applicable transform
//   or will-change transform makes a non-root `fixed` layer behave as scroll.
// - FixedAttachmentPositioningArea uses LayoutViewport::VisibleContentRect
//   with scrollbars excluded.
// - BoxModelObjectPainter::AdjustRectForScrolledContent subtracts the
//   pixel-snapped scroll offset and sizes the paint rect to ScrollWidth /
//   ScrollHeight plus borders, under an overflow clip.
// - The LayoutView constructor positions canvas backgrounds against the root
//   box's stitched size.

const TRANSFORM_WILL_CHANGE = new Set([
  'transform', 'transform-style', 'perspective', 'translate', 'rotate',
  'scale', 'offset-path', 'offset-position',
]);

const splitLayers = (value) => {
  const out = [];
  let depth = 0;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote !== '') { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
  }
  out.push(value.slice(start).trim());
  return out;
};

const hasAnyTransformWillChange = (style) => {
  if (style.willChange == null || style.willChange === '' || style.willChange === 'auto') return false;
  return style.willChange.split(/[\s,]+/).some((token) => TRANSFORM_WILL_CHANGE.has(token.toLowerCase()));
};

const hasPaintLayerTransform = (style) => {
  if ((style.transform != null && style.transform !== '' && style.transform !== 'none')
      || (style.translate != null && style.translate !== '' && style.translate !== 'none')
      || (style.rotate != null && style.rotate !== '' && style.rotate !== 'none')
      || (style.scale != null && style.scale !== '' && style.scale !== 'none')) return true;
  // ComputedStyle::HasTransform also includes motion-path transforms.
  return style.offsetPath != null && style.offsetPath !== '' && style.offsetPath !== 'none';
};

const isVisibleCanvasBackground = (style) => {
  const image = style.backgroundImage;
  const color = style.backgroundColor;
  return (image != null && image !== '' && image !== 'none')
    || (color != null && color !== '' && color !== 'transparent'
      && color !== 'rgba(0, 0, 0, 0)' && color !== 'rgba(0,0,0,0)');
};

export const createBackgroundAttachmentHandler = ({ vp, transformRelatedBoxFor, effectiveZoomFor, scrollbarPropertyKey }) => {
  const fixedToViewport = (el) => {
    const doc = el.ownerDocument;
    const root = doc.documentElement;
    if (el === root) return true;
    for (let current = el; current != null && current !== root; current = current.parentElement) {
      const style = (current.ownerDocument.defaultView || window).getComputedStyle(current);
      // LayoutObject::HasTransformRelatedProperty is false for non-applicable
      // LayoutInline objects. The live fixed-child probe supplies that fact;
      // undefined retains the source-compatible computed-style fallback.
      if (transformRelatedBoxFor(current) === false) continue;
      if (hasPaintLayerTransform(style) || hasAnyTransformWillChange(style)) return false;
    }
    return true;
  };

  const canvasOwner = (doc) => {
    const root = doc.documentElement;
    const body = doc.body;
    if (root != null && isVisibleCanvasBackground((doc.defaultView || window).getComputedStyle(root))) return root;
    return body;
  };

  const overflowClip = (el, rect, border, scaleX, scaleY) => {
    let x = rect.left - vp.x + border.left;
    let y = rect.top - vp.y + border.top;
    let width = Math.max(0, rect.width - border.left - border.right);
    let height = Math.max(0, rect.height - border.top - border.bottom);

    // OverflowClipRect starts at the padding box and excludes real non-overlay
    // scrollbars while retaining unused scrollbar-gutter tracks. The live
    // marker record owns scrollbar existence/side/geometry; never infer a bar
    // merely from scroll range.
    const scrollbarSet = typeof scrollbarPropertyKey === 'string' && scrollbarPropertyKey !== ''
      ? el[scrollbarPropertyKey]
      : undefined;
    if (scrollbarSet != null && scrollbarSet.overlay === false) {
      const vertical = scrollbarSet.vertical && scrollbarSet.vertical.frameRect;
      if (vertical != null) {
        if (scrollbarSet.vertical.logicalSide === 'left') {
          const edge = vertical.x + vertical.width;
          const shrink = Math.max(0, edge - x);
          x += shrink;
          width = Math.max(0, width - shrink);
        } else {
          width = Math.max(0, Math.min(width, vertical.x - x));
        }
      }
      const horizontal = scrollbarSet.horizontal && scrollbarSet.horizontal.frameRect;
      if (horizontal != null) height = Math.max(0, Math.min(height, horizontal.y - y));
    } else if (scrollbarSet == null) {
      // Backward-compatible exactness for platforms with layout scrollbars
      // when the marker prepass is unavailable. client* excludes the used bar;
      // overlay/no-scrollbar paths have no positive gap and keep the full box.
      const clientWidth = Number(el.clientWidth) * scaleX;
      const clientHeight = Number(el.clientHeight) * scaleY;
      if (clientWidth > 0 && width - clientWidth > 0.5) width = clientWidth;
      if (clientHeight > 0 && height - clientHeight > 0.5) height = clientHeight;
    }
    return { x, y, width, height };
  };

  const captureBackgroundAttachment = (el, style, rect, scaleX = 1, scaleY = 1) => {
    const attachments = splitLayers(style.backgroundAttachment || 'scroll');
    const needsFixed = attachments.includes('fixed');
    const needsLocal = attachments.includes('local');
    const doc = el.ownerDocument;
    const root = doc.documentElement;
    const ownsCanvas = el === canvasOwner(doc) && isVisibleCanvasBackground(style);
    if (!needsFixed && !needsLocal && !ownsCanvas) return undefined;

    const zoom = effectiveZoomFor(el);
    const physicalX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : zoom;
    const physicalY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : zoom;
    const border = {
      top: (parseFloat(style.borderTopWidth) || 0) * physicalY,
      right: (parseFloat(style.borderRightWidth) || 0) * physicalX,
      bottom: (parseFloat(style.borderBottomWidth) || 0) * physicalY,
      left: (parseFloat(style.borderLeftWidth) || 0) * physicalX,
    };
    const rootRect = root.getBoundingClientRect();
    const rootZoom = effectiveZoomFor(root);
    const localScrollContainer = ['auto', 'hidden', 'overlay', 'scroll'].includes(style.overflowX)
      || ['auto', 'hidden', 'overlay', 'scroll'].includes(style.overflowY);

    return {
      source: 'blink-box-background-paint-context-v1',
      fixedToViewport: needsFixed ? fixedToViewport(el) : false,
      layoutViewport: {
        x: -vp.x,
        y: -vp.y,
        // Root clientHeight may expose the stitched document height when the
        // root box itself is unconstrained. The layout viewport never exceeds
        // innerWidth/innerHeight; client* is only the scrollbar-excluding cap.
        width: Math.min((doc.defaultView || window).innerWidth, doc.documentElement.clientWidth),
        height: Math.min((doc.defaultView || window).innerHeight, doc.documentElement.clientHeight),
      },
      local: needsLocal ? {
        active: localScrollContainer,
        // ScrollOffsetInt is the physical, pixel-snapped offset. CSSOM scroll
        // positions are zoom-adjusted, so cross that boundary before snapping.
        scrollOffsetX: Math.round(Number(el.scrollLeft || 0) * zoom) * (physicalX / zoom),
        scrollOffsetY: Math.round(Number(el.scrollTop || 0) * zoom) * (physicalY / zoom),
        borderPaintWidth: Number(el.scrollWidth || 0) * physicalX + border.left + border.right,
        borderPaintHeight: Number(el.scrollHeight || 0) * physicalY + border.top + border.bottom,
        overflowClip: overflowClip(el, rect, border, physicalX, physicalY),
      } : undefined,
      canvas: ownsCanvas ? {
        owner: el === root ? 'root' : 'body-propagated',
        positioningRect: {
          x: rootRect.left - vp.x,
          y: rootRect.top - vp.y,
          width: Math.max(rootRect.width, Number(root.scrollWidth || 0) * rootZoom),
          height: Math.max(rootRect.height, Number(root.scrollHeight || 0) * rootZoom),
        },
      } : undefined,
    };
  };

  return { captureBackgroundAttachment };
};
