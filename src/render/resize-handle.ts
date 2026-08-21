/**
 * Blink's resizer activation and platform-paint geometry.
 *
 * Source: Chromium revision 7d859f271c:
 * - layout/layout_box.cc:1589-1594 (CanResize)
 * - style/computed_style.h:1975-1986 (scroll-container overflow values)
 * - paint/paint_layer_scrollable_area.cc:303-337 (CornerRect)
 * - paint/scrollable_area_painter.cc:42-89,112-170 (paint and strokes)
 */

export interface BlinkResizerActivation {
  resize?: string;
  overflowX?: string;
  overflowY?: string;
  isLayoutReplaced?: boolean;
  isLayoutIFrame?: boolean;
}

/** ComputedStyle::IsOverflowValueScrollable: `visible` and `clip` do not qualify. */
export function blinkOverflowValueIsScrollable(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized != null && normalized !== "visible" && normalized !== "clip";
}

/** LayoutObject::IsScrollContainer, including Blink's replaced-layout exclusion. */
export function blinkIsScrollContainer(input: BlinkResizerActivation): boolean {
  return input.isLayoutReplaced !== true
    && (blinkOverflowValueIsScrollable(input.overflowX)
      || blinkOverflowValueIsScrollable(input.overflowY));
}

/** LayoutBox::CanResize: (scroll container OR iframe) AND a non-none used resize. */
export function blinkCanResize(input: BlinkResizerActivation): boolean {
  const resize = input.resize?.trim().toLowerCase();
  return resize != null
    && resize !== "none"
    && (input.isLayoutIFrame === true || blinkIsScrollContainer(input));
}

/** ComputedStyle::ShouldPlaceBlockDirectionScrollbarOnLogicalLeft. */
export function blinkResizerIsOnLogicalLeft(
  direction: string | undefined,
  writingMode: string | undefined,
): boolean {
  return direction?.trim().toLowerCase() === "rtl"
    && (writingMode == null || writingMode.trim().toLowerCase() === "horizontal-tb");
}

export interface BlinkScrollbarThicknessInput {
  /** Page ScrollbarTheme thickness when neither scrollbar exists. */
  themeThickness: number;
  /** Null means the corresponding scrollbar object does not exist. */
  verticalScrollbarThickness: number | null;
  horizontalScrollbarThickness: number | null;
}

export interface BlinkResizerThickness {
  width: number;
  height: number;
  hasScrollbar: boolean;
}

/** PaintLayerScrollableArea::CornerRect's four scrollbar-presence branches. */
export function blinkResizerThickness(input: BlinkScrollbarThicknessInput): BlinkResizerThickness {
  const vertical = input.verticalScrollbarThickness;
  const horizontal = input.horizontalScrollbarThickness;
  if (vertical == null && horizontal == null) {
    return {
      width: input.themeThickness,
      height: input.themeThickness,
      hasScrollbar: false,
    };
  }
  if (vertical != null && horizontal == null) {
    return { width: vertical, height: vertical, hasScrollbar: true };
  }
  if (vertical == null && horizontal != null) {
    return { width: horizontal, height: horizontal, hasScrollbar: true };
  }
  return { width: vertical!, height: horizontal!, hasScrollbar: true };
}

export interface BlinkResizerCornerInput {
  /** Border-box paint offset in the coordinate space used by the SVG. */
  x: number;
  y: number;
  borderBoxWidth: number;
  borderBoxHeight: number;
  borderLeftWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  cornerWidth: number;
  cornerHeight: number;
  logicalLeft: boolean;
}

export interface BlinkResizerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** PhysicalRect::PixelSnappedSize / SnapSizeToPixel. */
export function blinkPixelSnappedSize(size: number, location: number): number {
  let snapped = Math.round(location + size) - Math.round(location);
  // Blink preserves a non-zero layout size once it exceeds 4/64 CSS px.
  if (snapped === 0 && Math.abs(size) > 4 / 64) snapped = size > 0 ? 1 : -1;
  return snapped;
}

/** CornerRect followed by PaintResizer's rounded paint-offset translation. */
export function blinkResizerCorner(input: BlinkResizerCornerInput): BlinkResizerRect {
  const originX = Math.round(input.x);
  const originY = Math.round(input.y);
  const snappedWidth = blinkPixelSnappedSize(input.borderBoxWidth, input.x);
  const snappedHeight = blinkPixelSnappedSize(input.borderBoxHeight, input.y);
  return {
    x: originX + (input.logicalLeft
      ? input.borderLeftWidth
      : snappedWidth - input.cornerWidth - input.borderRightWidth),
    y: originY + snappedHeight - input.cornerHeight - input.borderBottomWidth,
    width: input.cornerWidth,
    height: input.cornerHeight,
  };
}

export interface BlinkResizerPoint {
  x: number;
  y: number;
}

export interface BlinkPlatformResizerStrokes {
  dark: readonly [BlinkResizerPoint, BlinkResizerPoint, BlinkResizerPoint, BlinkResizerPoint];
  light: readonly [BlinkResizerPoint, BlinkResizerPoint, BlinkResizerPoint, BlinkResizerPoint];
  strokeWidth: number;
}

/** ScrollableAreaPainter::DrawPlatformResizerImage, before auto-dark-mode filtering. */
export function blinkPlatformResizerStrokes(
  rect: BlinkResizerRect,
  scaleFromDIP: number,
  logicalLeft: boolean,
): BlinkPlatformResizerStrokes {
  const edgeOffset = Math.ceil(scaleFromDIP);
  const halfWidth = Math.trunc(rect.width / 2);
  const threeQuarterWidth = Math.trunc(rect.width * 3 / 4);
  const halfHeight = Math.trunc(rect.height / 2);
  const threeQuarterHeight = Math.trunc(rect.height * 3 / 4);

  const p0 = {
    x: logicalLeft ? rect.x + edgeOffset : rect.x + rect.width - edgeOffset,
    y: rect.y + halfHeight,
  };
  const p1 = {
    x: logicalLeft ? rect.x + rect.width - halfWidth : rect.x + halfWidth,
    y: rect.y + rect.height - edgeOffset,
  };
  const p2 = { x: p0.x, y: rect.y + threeQuarterHeight };
  const p3 = {
    x: logicalLeft
      ? rect.x + rect.width - threeQuarterWidth
      : rect.x + threeQuarterWidth,
    y: p1.y,
  };

  const horizontalOffset = logicalLeft ? -edgeOffset : edgeOffset;
  return {
    dark: [p0, p1, p2, p3],
    light: [
      { x: p0.x, y: p0.y + edgeOffset },
      { x: p1.x + horizontalOffset, y: p1.y },
      { x: p2.x, y: p2.y + edgeOffset },
      { x: p3.x + horizontalOffset, y: p3.y },
    ],
    strokeWidth: edgeOffset,
  };
}

/** Custom ::-webkit-resizer paint belongs only to a real scroll container. */
export function blinkUsesCustomResizer(
  canResize: boolean,
  isScrollContainer: boolean,
  pseudoRuleMatched: boolean,
): boolean {
  return canResize && isScrollContainer && pseudoRuleMatched;
}
