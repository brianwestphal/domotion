/**
 * Blink-owned geometry for a single CSS mask image tile.
 *
 * Chromium 7d859f271c resolves mask layers through
 * BackgroundImageGeometry::CalculateFillTileSize / CalculateRepeatAndPosition:
 * contain/cover first produce a concrete tile from the snapped positioning
 * area, then each mask-position axis resolves its computed <length-percentage>
 * against the remaining (positioning-area - tile) space.  SVG's
 * preserveAspectRatio alignment keywords cannot represent that continuum, so
 * the renderer must hand SVG the final x/y/width/height instead.
 */

export interface MaskIntrinsicSize {
  w: number;
  h: number;
  /** Chromium-measured intrinsic aspect; preserves fractional SVG viewBoxes. */
  ratio?: number;
}

export interface MaskImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LAYOUT_UNIT_SCALE = 64;

/** Blink LayoutUnit(float) truncates to 1/64 CSS px. */
function toLayoutUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value * LAYOUT_UNIT_SCALE) / LAYOUT_UNIT_SCALE;
}

/** LayoutUnit::Round(), whose exact fixed-point expression ties toward +∞. */
function roundLayoutUnit(value: number): number {
  const integer = Math.trunc(value);
  return integer + Math.floor((value - integer) + 0.5);
}

/** PhysicalRect::PixelSnappedSize / SnapSizeToPixel. */
function snappedExtent(start: number, extent: number): number {
  const fraction = start - Math.trunc(start);
  const snapped = roundLayoutUnit(toLayoutUnit(fraction + extent))
    - roundLayoutUnit(toLayoutUnit(fraction));
  // Blink preserves a non-trivial subpixel extent that would otherwise snap
  // to zero. Mask positioning areas in normal captures are positive, but keep
  // the source rule here so zoomed hairline controls do not disappear.
  if (snapped === 0 && Math.abs(extent) > (4 / LAYOUT_UNIT_SCALE)) {
    return extent > 0 ? 1 : -1;
  }
  return snapped;
}

/** Split computed CSS position components without breaking calc(...). */
export function splitMaskPositionComponents(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  const input = value.trim();
  for (let i = 0; i <= input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (i === input.length || (depth === 0 && ch != null && /\s/.test(ch))) {
      if (i > start) out.push(input.slice(start, i));
      while (i + 1 < input.length && /\s/.test(input[i + 1])) i++;
      start = i + 1;
    }
  }
  return out;
}

/**
 * Resolve one computed mask-position axis. Chromium serializes the used
 * longhand as a canonical percentage/px/calc() value (four-value edge syntax
 * is folded into e.g. calc(100% - 13px)). The calc grammar reaching this seam
 * is therefore a linear sum of percentage and px terms.
 */
export function resolveMaskPositionAxis(component: string, freeSpace: number): number {
  const value = component.trim().toLowerCase();
  if (value === "left" || value === "top") return 0;
  if (value === "center") return freeSpace / 2;
  if (value === "right" || value === "bottom") return freeSpace;

  const expression = value.startsWith("calc(") && value.endsWith(")")
    ? value.slice(5, -1).trim()
    : value;
  let resolved = 0;
  let cursor = 0;
  let matched = false;
  // Computed style normalizes absolute lengths to px. Unitless zero is valid;
  // every other unitless non-zero term is rejected below.
  const term = /([+-]?)\s*((?:\d+(?:\.\d+)?|\.\d+))(px|%)?/gy;
  while (cursor < expression.length) {
    while (/\s/.test(expression[cursor] ?? "")) cursor++;
    term.lastIndex = cursor;
    const match = term.exec(expression);
    if (match == null) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    const number = Number.parseFloat(match[2]);
    const unit = match[3] ?? "";
    if (unit === "" && number !== 0) return 0;
    resolved += sign * (unit === "%" ? freeSpace * number / 100 : number);
    matched = true;
    cursor = term.lastIndex;
    while (/\s/.test(expression[cursor] ?? "")) cursor++;
    if (cursor >= expression.length) break;
    // A binary sign is consumed as the next term's prefix. Anything else is
    // outside the computed linear <length-percentage> form.
    if (expression[cursor] !== "+" && expression[cursor] !== "-") return 0;
  }
  return matched ? toLayoutUnit(resolved) : 0;
}

/** Resolve the canonical two-axis computed mask-position value. */
export function resolveMaskPosition(
  value: string,
  freeWidth: number,
  freeHeight: number,
): { x: number; y: number } {
  const components = splitMaskPositionComponents(value);
  if (components.length === 0) return { x: 0, y: 0 };

  // getComputedStyle() always gives two canonical components. Keep keyword
  // handling for direct API/unit callers and old serialized captures.
  if (components.length === 1) {
    const only = components[0].toLowerCase();
    if (only === "top" || only === "bottom") {
      return {
        x: freeWidth / 2,
        y: resolveMaskPositionAxis(only, freeHeight),
      };
    }
    return {
      x: resolveMaskPositionAxis(only, freeWidth),
      y: freeHeight / 2,
    };
  }

  let x = components[0];
  let y = components[1];
  if (x === "top" || x === "bottom" || y === "left" || y === "right") {
    [x, y] = [y, x];
  }
  return {
    x: resolveMaskPositionAxis(x, freeWidth),
    y: resolveMaskPositionAxis(y, freeHeight),
  };
}

/**
 * Produce Blink's concrete no-repeat contain/cover tile rectangle.
 *
 * The independent dimension exactly fills the pixel-snapped positioning area.
 * For contain Blink rounds the dependent dimension to an integer CSS pixel to
 * avoid sampling bleed. Cover retains LayoutUnit (1/64 px) precision.
 * Position still resolves against the *unsnapped* positioning extent minus
 * that concrete tile, matching CalculateRepeatAndPosition.
 */
export function resolveMaskContainCoverRect(
  area: MaskImageRect,
  intrinsic: MaskIntrinsicSize,
  sizing: "contain" | "cover",
  position: string,
): MaskImageRect | null {
  if (
    area.width <= 0 || area.height <= 0
    || !Number.isFinite(intrinsic.w) || !Number.isFinite(intrinsic.h)
    || intrinsic.w <= 0 || intrinsic.h <= 0
  ) return null;

  const snappedWidth = snappedExtent(area.x, area.width);
  const snappedHeight = snappedExtent(area.y, area.height);
  if (snappedWidth <= 0 || snappedHeight <= 0) return null;

  const aspectRatio = intrinsic.ratio != null
    && Number.isFinite(intrinsic.ratio)
    && intrinsic.ratio > 0
    ? intrinsic.ratio
    : intrinsic.w / intrinsic.h;
  const constrainedHeight = toLayoutUnit(snappedWidth / aspectRatio);
  const grow = sizing === "cover";
  let tileWidth: number;
  let tileHeight: number;
  if ((grow && constrainedHeight < snappedHeight) || (!grow && constrainedHeight > snappedHeight)) {
    tileWidth = toLayoutUnit(snappedHeight * aspectRatio);
    tileHeight = snappedHeight;
  } else {
    tileWidth = snappedWidth;
    tileHeight = constrainedHeight;
  }

  if (sizing === "contain") {
    if (tileWidth !== snappedWidth) tileWidth = Math.max(1, roundLayoutUnit(tileWidth));
    if (tileHeight !== snappedHeight) tileHeight = Math.max(1, roundLayoutUnit(tileHeight));
  } else {
    if (tileWidth !== snappedWidth) tileWidth = Math.max(1, tileWidth);
    if (tileHeight !== snappedHeight) tileHeight = Math.max(1, tileHeight);
  }

  const offset = resolveMaskPosition(
    position,
    toLayoutUnit(area.width - tileWidth),
    toLayoutUnit(area.height - tileHeight),
  );
  return {
    x: toLayoutUnit(area.x + offset.x),
    y: toLayoutUnit(area.y + offset.y),
    width: tileWidth,
    height: tileHeight,
  };
}
