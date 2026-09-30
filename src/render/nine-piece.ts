/** Shared CSS nine-piece geometry for border images and mask borders.
 *
 * Blink sends both properties through NinePieceImagePainter::Paint. In
 * particular it pixel-snaps the destination before NinePieceImageGrid sees
 * either property (Chromium rev 7d859f27, nine_piece_image_painter.cc).
 */

export type NinePieceRepeat = "stretch" | "repeat" | "round" | "space";
export interface NinePieceSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface NinePieceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface NinePieceDestinationGrid extends NinePieceRect, NinePieceSides {}
export interface NinePieceSlot {
  destination: NinePieceRect;
  source: NinePieceRect;
}
export interface NinePieceInputs {
  box: NinePieceRect;
  borderWidths: NinePieceSides;
  sliceRaw: string;
  widthRaw: string;
  outsetRaw: string;
  repeatRaw: string;
  intrinsic?: { width: number; height: number };
  snap?: boolean;
}
export interface ParsedNinePiece {
  grid: NinePieceDestinationGrid;
  sourceWidth: number;
  sourceHeight: number;
  slices: NinePieceSides;
  repeatH: NinePieceRepeat;
  repeatV: NinePieceRepeat;
  fillCenter: boolean;
}

const REPEATS = new Set<NinePieceRepeat>(["stretch", "repeat", "round", "space"]);
const sideTokens = (raw: string): [string | undefined, string | undefined, string | undefined, string | undefined] => {
  const t = raw.trim().split(/\s+/);
  return [t[0], t[1] ?? t[0], t[2] ?? t[0], t[3] ?? t[1] ?? t[0]];
};
const resolveSideTokens = (
  raw: string,
  box: NinePieceRect,
  borderWidths: NinePieceSides,
  resolve: (token: string | undefined, basis: number, borderWidth: number) => number,
): NinePieceSides => {
  const [top, right, bottom, left] = sideTokens(raw);
  return {
    top: resolve(top, box.height, borderWidths.top),
    right: resolve(right, box.width, borderWidths.right),
    bottom: resolve(bottom, box.height, borderWidths.bottom),
    left: resolve(left, box.width, borderWidths.left),
  };
};
const absoluteLength = (token: string): boolean => /(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(token);
const resolveWidth = (token: string | undefined, basis: number, borderWidth: number): number => {
  if (token == null || token === "" || token === "auto") return borderWidth;
  if (/%$/.test(token)) return (parseFloat(token) / 100) * basis;
  if (absoluteLength(token)) return parseFloat(token) || 0;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n * borderWidth : borderWidth;
};
const resolveOutset = (token: string | undefined, basis: number, borderWidth: number): number => {
  if (token == null || token === "") return 0;
  if (/%$/.test(token)) return (parseFloat(token) / 100) * basis;
  if (absoluteLength(token)) return parseFloat(token) || 0;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n * borderWidth : 0;
};
const resolveSlice = (token: string | undefined, basis: number): number => {
  if (token == null || token === "") return 0;
  return /%$/.test(token) ? (parseFloat(token) / 100) * basis : parseFloat(token);
};
const repeat = (token: string | undefined): NinePieceRepeat => {
  const normalized = token?.toLowerCase() as NinePieceRepeat | undefined;
  return normalized != null && REPEATS.has(normalized) ? normalized : "stretch";
};

/** Blink's ToPixelSnappedRect plus NinePieceImageGrid::SnapEdgeWidths. */
export function snapNinePieceDestinationGrid(
  x: number,
  y: number,
  width: number,
  height: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
): NinePieceDestinationGrid {
  const snappedX = Math.round(x);
  const snappedY = Math.round(y);
  const snappedWidth = Math.round(x + width) - snappedX;
  const snappedHeight = Math.round(y + height) - snappedY;
  const snapEdges = (start: number, end: number, extent: number): [number, number] =>
    extent - start - end <= 1 / 64
      ? [Math.round(start), extent - Math.round(start)]
      : [Math.floor(start), Math.floor(end)];
  const [snappedLeft, snappedRight] = snapEdges(left, right, snappedWidth);
  const [snappedTop, snappedBottom] = snapEdges(top, bottom, snappedHeight);
  return {
    x: snappedX,
    y: snappedY,
    width: snappedWidth,
    height: snappedHeight,
    left: snappedLeft,
    right: snappedRight,
    top: snappedTop,
    bottom: snappedBottom,
  };
}

/** Blink NinePieceImagePainter::CalculateSpaceNeeded. */
export function borderImageSpaceTiling(destination: number, tile: number): { spacing: number; period: number } | null {
  const count = Math.floor(destination / tile);
  if (count <= 0) return null;
  const spacing = (destination - tile * count) / (count + 1);
  return { spacing, period: tile + spacing };
}

/** Blink NinePieceImagePainter::ComputeTileParameters for one destination axis. */
export function ninePieceTileAxis(
  destination: number,
  naturalTile: number,
  mode: NinePieceRepeat,
): { tile: number; period: number; phase: number } | null {
  if (destination <= 0 || naturalTile <= 0) return null;
  if (mode === "stretch") return { tile: destination, period: destination, phase: 0 };
  if (mode === "round") {
    const count = Math.max(1, Math.round(destination / naturalTile));
    return { tile: destination / count, period: destination / count, phase: 0 };
  }
  if (mode === "repeat") return { tile: naturalTile, period: naturalTile, phase: (destination - naturalTile) / 2 };
  const tiling = borderImageSpaceTiling(destination, naturalTile);
  return tiling == null ? null : { tile: naturalTile, period: tiling.period, phase: tiling.spacing };
}

export function ninePieceGrid(box: NinePieceRect, widths: NinePieceSides, snap: boolean): NinePieceDestinationGrid {
  return snap
    ? snapNinePieceDestinationGrid(
        box.x,
        box.y,
        box.width,
        box.height,
        widths.left,
        widths.right,
        widths.top,
        widths.bottom,
      )
    : { ...box, ...widths };
}

export function parseNinePieceInputs(input: NinePieceInputs): ParsedNinePiece | null {
  const widths = resolveSideTokens(input.widthRaw, input.box, input.borderWidths, resolveWidth);
  const outsets = resolveSideTokens(input.outsetRaw, input.box, input.borderWidths, resolveOutset);
  const area = {
    x: input.box.x - outsets.left,
    y: input.box.y - outsets.top,
    width: input.box.width + outsets.left + outsets.right,
    height: input.box.height + outsets.top + outsets.bottom,
  };
  const grid = ninePieceGrid(area, widths, input.snap !== false);
  if (grid.width <= 0 || grid.height <= 0) return null;
  const sourceWidth = input.intrinsic?.width ?? grid.width;
  const sourceHeight = input.intrinsic?.height ?? grid.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const [top, right, bottom, left] = sideTokens(input.sliceRaw.replace(/\bfill\b/i, ""));
  const slices = {
    top: resolveSlice(top, sourceHeight),
    right: resolveSlice(right, sourceWidth),
    bottom: resolveSlice(bottom, sourceHeight),
    left: resolveSlice(left, sourceWidth),
  };
  const [rH, rV] = input.repeatRaw.trim().split(/\s+/);
  return {
    grid,
    sourceWidth,
    sourceHeight,
    slices,
    repeatH: repeat(rH),
    repeatV: repeat(rV ?? rH),
    fillCenter: /\bfill\b/i.test(input.sliceRaw),
  };
}

/** One renderer-specific SVG backend; slot selection is identical for all sources. */
export interface NinePieceEmitter {
  stretch(slot: NinePieceSlot): void;
  edge(slot: NinePieceSlot, axis: "x" | "y", mode: Exclude<NinePieceRepeat, "stretch">): void;
  center(
    slot: NinePieceSlot,
    horizontal: NinePieceRepeat,
    vertical: NinePieceRepeat,
    scaleX: number,
    scaleY: number,
  ): void;
}

export function paintNinePiece(input: ParsedNinePiece, emitter: NinePieceEmitter): void {
  const { grid, slices, sourceWidth: sw, sourceHeight: sh, repeatH, repeatV } = input;
  const dx = [grid.x, grid.x + grid.left, grid.x + grid.width - grid.right];
  const dy = [grid.y, grid.y + grid.top, grid.y + grid.height - grid.bottom];
  const dw = [grid.left, dx[2] - dx[1], grid.right];
  const dh = [grid.top, dy[2] - dy[1], grid.bottom];
  const sx = [0, slices.left, sw - slices.right];
  const sy = [0, slices.top, sh - slices.bottom];
  const widths = [slices.left, sw - slices.left - slices.right, slices.right];
  const heights = [slices.top, sh - slices.top - slices.bottom, slices.bottom];
  const slot = (x: number, y: number): NinePieceSlot => ({
    destination: { x: dx[x], y: dy[y], width: dw[x], height: dh[y] },
    source: { x: sx[x], y: sy[y], width: widths[x], height: heights[y] },
  });
  for (const [x, y] of [
    [0, 0],
    [2, 0],
    [0, 2],
    [2, 2],
  ])
    emitter.stretch(slot(x, y));
  for (const y of [0, 2]) {
    const edge = slot(1, y);
    if (repeatH === "stretch") emitter.stretch(edge);
    else emitter.edge(edge, "x", repeatH);
  }
  for (const x of [0, 2]) {
    const edge = slot(x, 1);
    if (repeatV === "stretch") emitter.stretch(edge);
    else emitter.edge(edge, "y", repeatV);
  }
  if (!input.fillCenter) return;
  const middle = slot(1, 1);
  if (repeatH === "stretch" && repeatV === "stretch") emitter.stretch(middle);
  else {
    const scaleX =
      slices.top > 0 && grid.top > 0
        ? grid.top / slices.top
        : slices.bottom > 0 && grid.bottom > 0
          ? grid.bottom / slices.bottom
          : 1;
    const scaleY =
      slices.left > 0 && grid.left > 0
        ? grid.left / slices.left
        : slices.right > 0 && grid.right > 0
          ? grid.right / slices.right
          : 1;
    emitter.center(middle, repeatH, repeatV, scaleX, scaleY);
  }
}
