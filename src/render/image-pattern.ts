/**
 * Blink-owned CSS image tile geometry lowered to an SVG `<pattern><image>`.
 *
 * This is a direct transcription of the pinned Chromium
 * `BackgroundImageGeometry` sizing/repeat/position pipeline. Geometry is kept
 * in Blink's 1/64 CSS-pixel LayoutUnit domain until it is serialized. Skia is
 * only given the resulting destination, tile size, phase, and repeat spacing;
 * it does not reinterpret CSS background syntax.
 */

import type { CapturedBackgroundImage } from "../capture/types.js";
import { embedResizedDataUri } from "../capture/embed.js";
import { esc } from "./format.js";

const LAYOUT_UNIT_SCALE = 64;

/** Preserve every 1/64 px LayoutUnit; the renderer-wide 0.1 px formatter is
 * intentionally too lossy for tile phase and dependent-axis rounding. */
function layoutNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

type RawLayoutUnit = number;
type AxisRepeat = "repeat" | "no-repeat" | "round" | "space";
type EdgeOrigin = "start" | "end";

export interface BackgroundRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BackgroundNaturalSizing {
  /** False means capture could not observe Blink's natural-sizing facts. */
  known: boolean;
  hasWidth: boolean;
  hasHeight: boolean;
  width: number | null;
  height: number | null;
  ratio: { width: number; height: number } | null;
}

export interface BlinkBackgroundImageGeometryInput {
  positioningArea: BackgroundRect;
  paintingArea: BackgroundRect;
  size: string;
  position: string;
  repeat: string;
  natural: BackgroundNaturalSizing;
  offsetInBackground?: { x: number; y: number };
}

export interface BlinkBackgroundImageGeometry {
  source: "blink-background-image-geometry-v1";
  unsnappedPositioningArea: BackgroundRect;
  snappedPositioningArea: BackgroundRect;
  unsnappedDestination: BackgroundRect;
  snappedDestination: BackgroundRect;
  tileSize: { width: number; height: number };
  phase: { x: number; y: number };
  spacing: { width: number; height: number };
  repeat: { x: AxisRepeat; y: AxisRepeat };
}

interface RawRect {
  x: RawLayoutUnit;
  y: RawLayoutUnit;
  width: RawLayoutUnit;
  height: RawLayoutUnit;
}

interface LengthPercentage {
  percent: number;
  px: number;
}

interface AxisPosition {
  value: LengthPercentage;
  origin: EdgeOrigin;
}

/** Convert CSS px to Blink's integer raw LayoutUnit storage. This is numeric
 * geometry, not Kerf's trusted-markup `raw()` escape hatch. */
function toRawLayoutUnit(value: number): RawLayoutUnit {
  // LayoutUnit(float/double) truncates toward zero to the 1/64 px domain.
  return Math.trunc(value * LAYOUT_UNIT_SCALE);
}

function rawFloor(value: number): RawLayoutUnit {
  return Math.floor(value * LAYOUT_UNIT_SCALE);
}

function cssPx(value: RawLayoutUnit): number {
  return value / LAYOUT_UNIT_SCALE;
}

function roundRaw(value: RawLayoutUnit): number {
  // LayoutUnit::Round(): ties round toward +infinity, including negatives.
  return Math.floor(value / LAYOUT_UNIT_SCALE + 0.5);
}

function divideRaw(value: RawLayoutUnit, divisor: number): RawLayoutUnit {
  return Math.trunc(value / divisor);
}

function mulDivRaw(
  value: RawLayoutUnit,
  multiplier: RawLayoutUnit,
  divisor: RawLayoutUnit,
): RawLayoutUnit {
  return divisor === 0 ? 0 : Math.trunc(value * multiplier / divisor);
}

function snapRect(rect: RawRect): RawRect {
  const x = roundRaw(rect.x);
  const y = roundRaw(rect.y);
  const snapSize = (size: RawLayoutUnit, location: RawLayoutUnit): number => {
    const fraction = location % LAYOUT_UNIT_SCALE;
    let result = roundRaw(fraction + size) - roundRaw(fraction);
    // Blink preserves a nonzero painted extent above four raw LayoutUnits.
    if (result === 0 && Math.abs(size) > 4) result = size > 0 ? 1 : -1;
    return result;
  };
  return {
    x: x * LAYOUT_UNIT_SCALE,
    y: y * LAYOUT_UNIT_SCALE,
    width: snapSize(rect.width, rect.x) * LAYOUT_UNIT_SCALE,
    height: snapSize(rect.height, rect.y) * LAYOUT_UNIT_SCALE,
  };
}

function intersectRect(left: RawRect, right: RawRect): RawRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.min(left.x + left.width, right.x + right.width);
  const endY = Math.min(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: Math.max(0, endX - x),
    height: Math.max(0, endY - y),
  };
}

function publicRect(rect: RawRect): BackgroundRect {
  return {
    x: cssPx(rect.x),
    y: cssPx(rect.y),
    width: cssPx(rect.width),
    height: cssPx(rect.height),
  };
}

function topLevelTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value.trim()) {
    if (character === "(") depth++;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (current !== "") tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Parse computed px/%/calc() syntax into Blink's affine Length value. */
export function parseBackgroundLength(value: string): LengthPercentage | null {
  let expression = value.trim().toLowerCase();
  if (expression === "0") return { percent: 0, px: 0 };
  if (expression.startsWith("calc(") && expression.endsWith(")")) {
    expression = expression.slice(5, -1).trim();
  }
  const compact = expression.replace(/\s+/g, "");
  const termPattern = /([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%|px)?/iy;
  let percent = 0;
  let px = 0;
  let index = 0;
  while (index < compact.length) {
    termPattern.lastIndex = index;
    const match = termPattern.exec(compact);
    if (match == null || match.index !== index) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    if (match[2] === "%") percent += amount;
    else if (match[2] === "px" || match[2] == null) px += amount;
    else return null;
    index = termPattern.lastIndex;
    if (index < compact.length && compact[index] !== "+" && compact[index] !== "-") return null;
  }
  return { percent, px };
}

function resolveLength(value: LengthPercentage, basis: RawLayoutUnit): RawLayoutUnit {
  // MinimumValueForLength converts the final float result to LayoutUnit once.
  return toRawLayoutUnit(cssPx(basis) * value.percent / 100 + value.px);
}

function parseRepeat(value: string): { x: AxisRepeat; y: AxisRepeat } | null {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens[0] === "repeat-x") return { x: "repeat", y: "no-repeat" };
  if (tokens[0] === "repeat-y") return { x: "no-repeat", y: "repeat" };
  const valid = (token: string | undefined): token is AxisRepeat =>
    token === "repeat" || token === "no-repeat" || token === "round" || token === "space";
  if (!valid(tokens[0])) return null;
  const y = tokens[1] ?? tokens[0];
  return valid(y) ? { x: tokens[0], y } : null;
}

function keywordLength(value: string): LengthPercentage | null {
  if (value === "left" || value === "top") return { percent: 0, px: 0 };
  if (value === "center") return { percent: 50, px: 0 };
  if (value === "right" || value === "bottom") return { percent: 100, px: 0 };
  return parseBackgroundLength(value);
}

function parsePosition(value: string): { x: AxisPosition; y: AxisPosition } | null {
  const tokens = topLevelTokens(value.toLowerCase());
  const center = (): AxisPosition => ({ value: { percent: 50, px: 0 }, origin: "start" });
  const start = (): AxisPosition => ({ value: { percent: 0, px: 0 }, origin: "start" });
  const isHorizontal = (token: string): boolean => token === "left" || token === "right";
  const isVertical = (token: string): boolean => token === "top" || token === "bottom";
  const side = (token: string, offset: string | undefined): AxisPosition | null => {
    const parsed = offset == null ? { percent: 0, px: 0 } : parseBackgroundLength(offset);
    if (parsed == null) return null;
    return { value: parsed, origin: token === "right" || token === "bottom" ? "end" : "start" };
  };

  if (tokens.length === 4) {
    let x: AxisPosition | null = null;
    let y: AxisPosition | null = null;
    for (let index = 0; index < 4; index += 2) {
      if (isHorizontal(tokens[index])) x = side(tokens[index], tokens[index + 1]);
      else if (isVertical(tokens[index])) y = side(tokens[index], tokens[index + 1]);
      else return null;
    }
    return x != null && y != null ? { x, y } : null;
  }
  if (tokens.length === 3) {
    if (isHorizontal(tokens[0]) && isVertical(tokens[2])) {
      const x = side(tokens[0], tokens[1]);
      const y = side(tokens[2], undefined);
      return x != null && y != null ? { x, y } : null;
    }
    if (isVertical(tokens[0]) && isHorizontal(tokens[2])) {
      const y = side(tokens[0], tokens[1]);
      const x = side(tokens[2], undefined);
      return x != null && y != null ? { x, y } : null;
    }
    if (isHorizontal(tokens[0]) && isVertical(tokens[1])) {
      const x = side(tokens[0], undefined);
      const y = side(tokens[1], tokens[2]);
      return x != null && y != null ? { x, y } : null;
    }
    if (isVertical(tokens[0]) && isHorizontal(tokens[1])) {
      const y = side(tokens[0], undefined);
      const x = side(tokens[1], tokens[2]);
      return x != null && y != null ? { x, y } : null;
    }
    return null;
  }
  if (tokens.length === 0) return { x: start(), y: start() };
  if (tokens.length === 1) {
    if (isVertical(tokens[0])) {
      const y = side(tokens[0], undefined);
      return y == null ? null : { x: center(), y };
    }
    const xValue = keywordLength(tokens[0]);
    return xValue == null ? null : { x: { value: xValue, origin: "start" }, y: center() };
  }
  if (tokens.length === 2) {
    if (isVertical(tokens[0]) && !isVertical(tokens[1])) {
      const y = side(tokens[0], undefined);
      const xValue = keywordLength(tokens[1]);
      return y == null || xValue == null ? null : { x: { value: xValue, origin: "start" }, y };
    }
    const xValue = keywordLength(tokens[0]);
    const yValue = keywordLength(tokens[1]);
    return xValue == null || yValue == null
      ? null
      : { x: { value: xValue, origin: "start" }, y: { value: yValue, origin: "start" } };
  }
  return null;
}

function resolvePosition(
  position: AxisPosition,
  available: RawLayoutUnit,
  offset: RawLayoutUnit,
): RawLayoutUnit {
  const edgeRelative = resolveLength(position.value, available);
  const absolute = position.origin === "end" ? available - edgeRelative : edgeRelative;
  return absolute - offset;
}

function ratioRaw(natural: BackgroundNaturalSizing): { width: RawLayoutUnit; height: RawLayoutUnit } | null {
  const ratio = natural.ratio;
  if (ratio == null || ratio.width <= 0 || ratio.height <= 0) return null;
  const width = rawFloor(ratio.width);
  const height = rawFloor(ratio.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function concreteImageSize(
  natural: BackgroundNaturalSizing,
  defaultWidth: RawLayoutUnit,
  defaultHeight: RawLayoutUnit,
): { width: RawLayoutUnit; height: RawLayoutUnit } | null {
  if (!natural.known) return null;
  const ratio = ratioRaw(natural);
  const width = natural.width == null ? null : rawFloor(natural.width);
  const height = natural.height == null ? null : rawFloor(natural.height);
  let resultWidth = defaultWidth;
  let resultHeight = defaultHeight;
  if (natural.hasWidth && width != null && natural.hasHeight && height != null) {
    resultWidth = width;
    resultHeight = height;
  } else if (natural.hasWidth && width != null) {
    resultWidth = width;
    resultHeight = ratio == null ? defaultHeight : mulDivRaw(width, ratio.height, ratio.width);
  } else if (natural.hasHeight && height != null) {
    resultHeight = height;
    resultWidth = ratio == null ? defaultWidth : mulDivRaw(height, ratio.width, ratio.height);
  } else if (ratio != null) {
    const solutionWidth = mulDivRaw(defaultHeight, ratio.width, ratio.height);
    if (solutionWidth <= defaultWidth) resultWidth = solutionWidth;
    else resultHeight = mulDivRaw(defaultWidth, ratio.height, ratio.width);
  }
  return { width: Math.max(0, resultWidth), height: Math.max(0, resultHeight) };
}

function resolveTileSize(
  sizeCss: string,
  natural: BackgroundNaturalSizing,
  unsnappedWidth: RawLayoutUnit,
  unsnappedHeight: RawLayoutUnit,
  snappedWidth: RawLayoutUnit,
  snappedHeight: RawLayoutUnit,
): { width: RawLayoutUnit; height: RawLayoutUnit; autoX: boolean; autoY: boolean } | null {
  const intrinsic = natural.known
    && (natural.hasWidth || natural.hasHeight || ratioRaw(natural) != null);
  const basisWidth = intrinsic ? unsnappedWidth : snappedWidth;
  const basisHeight = intrinsic ? unsnappedHeight : snappedHeight;
  const keyword = sizeCss.trim().toLowerCase();
  const ratio = ratioRaw(natural);
  if (keyword === "contain" || keyword === "cover") {
    if (ratio == null) {
      return { width: snappedWidth, height: snappedHeight, autoX: false, autoY: false };
    }
    let width = snappedWidth;
    let height = mulDivRaw(width, ratio.height, ratio.width);
    const grow = keyword === "cover";
    if ((grow && height < snappedHeight) || (!grow && height > snappedHeight)) {
      height = snappedHeight;
      width = mulDivRaw(height, ratio.width, ratio.height);
    }
    if (keyword === "contain") {
      if (width !== snappedWidth) width = Math.max(LAYOUT_UNIT_SCALE, roundRaw(width) * LAYOUT_UNIT_SCALE);
      if (height !== snappedHeight) height = Math.max(LAYOUT_UNIT_SCALE, roundRaw(height) * LAYOUT_UNIT_SCALE);
    } else {
      if (width !== snappedWidth) width = Math.max(LAYOUT_UNIT_SCALE, width);
      if (height !== snappedHeight) height = Math.max(LAYOUT_UNIT_SCALE, height);
    }
    return { width, height, autoX: false, autoY: false };
  }

  const tokens = topLevelTokens(keyword);
  const widthToken = tokens[0] ?? "auto";
  const heightToken = tokens[1] ?? "auto";
  if (tokens.length > 2) return null;
  const autoX = widthToken === "auto";
  const autoY = heightToken === "auto";
  const widthLength = autoX ? null : parseBackgroundLength(widthToken);
  const heightLength = autoY ? null : parseBackgroundLength(heightToken);
  if ((!autoX && widthLength == null) || (!autoY && heightLength == null)) return null;
  let width = widthLength == null ? basisWidth : resolveLength(widthLength, basisWidth);
  let height = heightLength == null ? basisHeight : resolveLength(heightLength, basisHeight);

  if (autoX && !autoY) {
    if (ratio != null) width = mulDivRaw(height, ratio.width, ratio.height);
    else if (natural.known && natural.hasWidth && natural.width != null) width = rawFloor(natural.width);
    else if (!natural.known) return null;
    else width = basisWidth;
    if (ratio != null && ratio.width >= LAYOUT_UNIT_SCALE && width < LAYOUT_UNIT_SCALE) width = LAYOUT_UNIT_SCALE;
  } else if (!autoX && autoY) {
    if (ratio != null) height = mulDivRaw(width, ratio.height, ratio.width);
    else if (natural.known && natural.hasHeight && natural.height != null) height = rawFloor(natural.height);
    else if (!natural.known) return null;
    else height = basisHeight;
    if (ratio != null && ratio.height >= LAYOUT_UNIT_SCALE && height < LAYOUT_UNIT_SCALE) height = LAYOUT_UNIT_SCALE;
  } else if (autoX && autoY) {
    const concrete = concreteImageSize(natural, basisWidth, basisHeight);
    if (concrete == null) return null;
    width = concrete.width;
    height = concrete.height;
  }
  return { width: Math.max(0, width), height: Math.max(0, height), autoX, autoY };
}

function computeTilePhase(position: RawLayoutUnit, extent: RawLayoutUnit): RawLayoutUnit {
  return extent === 0 ? 0 : extent - (position % extent);
}

function computedPhase(phase: RawLayoutUnit, step: RawLayoutUnit): RawLayoutUnit {
  if (step === 0) return 0;
  const value = (-phase) % step;
  return value === 0 ? 0 : value;
}

/**
 * Compute the exact Blink geometry record. Null is fail-closed: the captured
 * style contained syntax or natural-sizing state this transcription cannot
 * prove equivalent.
 */
export function resolveBlinkBackgroundImageGeometry(
  input: BlinkBackgroundImageGeometryInput,
): BlinkBackgroundImageGeometry | null {
  const parsedRepeat = parseRepeat(input.repeat);
  const position = parsePosition(input.position);
  if (parsedRepeat == null || position == null) return null;

  const unsnappedPositioning: RawRect = {
    x: toRawLayoutUnit(input.positioningArea.x),
    y: toRawLayoutUnit(input.positioningArea.y),
    width: Math.max(0, toRawLayoutUnit(input.positioningArea.width)),
    height: Math.max(0, toRawLayoutUnit(input.positioningArea.height)),
  };
  const unsnappedPainting: RawRect = {
    x: toRawLayoutUnit(input.paintingArea.x),
    y: toRawLayoutUnit(input.paintingArea.y),
    width: Math.max(0, toRawLayoutUnit(input.paintingArea.width)),
    height: Math.max(0, toRawLayoutUnit(input.paintingArea.height)),
  };
  const snappedPositioning = snapRect(unsnappedPositioning);
  const snappedPainting = snapRect(unsnappedPainting);
  let unsnappedDestination = { ...unsnappedPainting };
  let snappedDestination = { ...snappedPainting };
  const unsnappedBoxOffset = {
    x: unsnappedPositioning.x - unsnappedPainting.x,
    y: unsnappedPositioning.y - unsnappedPainting.y,
  };
  const snappedBoxOffset = {
    x: snappedPositioning.x - snappedPainting.x,
    y: snappedPositioning.y - snappedPainting.y,
  };
  const tile = resolveTileSize(
    input.size,
    input.natural,
    unsnappedPositioning.width,
    unsnappedPositioning.height,
    snappedPositioning.width,
    snappedPositioning.height,
  );
  if (tile == null) return null;
  let tileWidth = tile.width;
  let tileHeight = tile.height;
  const offsetX = toRawLayoutUnit(input.offsetInBackground?.x ?? 0);
  const offsetY = toRawLayoutUnit(input.offsetInBackground?.y ?? 0);
  let repeatX = parsedRepeat.x;
  let repeatY = parsedRepeat.y;
  let phaseX = 0;
  let phaseY = 0;
  let spacingWidth = 0;
  let spacingHeight = 0;
  const unsnappedAvailableWidth = unsnappedPositioning.width - tileWidth;
  const unsnappedAvailableHeight = unsnappedPositioning.height - tileHeight;
  const snappedAvailableWidth = snappedPositioning.width - tileWidth;
  const snappedAvailableHeight = snappedPositioning.height - tileHeight;

  if (repeatX === "round" && snappedPositioning.width > 0 && tileWidth > 0) {
    const ratioValue = Math.trunc(LAYOUT_UNIT_SCALE * snappedPositioning.width / tileWidth);
    const count = Math.max(1, roundRaw(ratioValue));
    const roundedWidth = divideRaw(snappedPositioning.width, count);
    if (tile.autoY && repeatY !== "round" && tileWidth > 0) {
      tileHeight = mulDivRaw(roundedWidth, tileHeight, tileWidth);
      if (tileHeight < LAYOUT_UNIT_SCALE && tile.height >= LAYOUT_UNIT_SCALE) tileHeight = LAYOUT_UNIT_SCALE;
    }
    tileWidth = roundedWidth;
    const xOffset = resolvePosition(position.x, snappedAvailableWidth, offsetX);
    phaseX = computeTilePhase(xOffset + unsnappedBoxOffset.x, tileWidth);
    spacingWidth = 0;
    spacingHeight = 0;
  }

  if (repeatY === "round" && snappedPositioning.height > 0 && tileHeight > 0) {
    const ratioValue = Math.trunc(LAYOUT_UNIT_SCALE * snappedPositioning.height / tileHeight);
    const count = Math.max(1, roundRaw(ratioValue));
    const roundedHeight = divideRaw(snappedPositioning.height, count);
    if (tile.autoX && repeatX !== "round" && tileHeight > 0) {
      tileWidth = mulDivRaw(roundedHeight, tileWidth, tileHeight);
      if (tileWidth < LAYOUT_UNIT_SCALE && tile.width >= LAYOUT_UNIT_SCALE) tileWidth = LAYOUT_UNIT_SCALE;
    }
    tileHeight = roundedHeight;
    const yOffset = resolvePosition(position.y, snappedAvailableHeight, offsetY);
    phaseY = computeTilePhase(yOffset + unsnappedBoxOffset.y, tileHeight);
    spacingWidth = 0;
    spacingHeight = 0;
  }

  if (repeatX === "repeat") {
    const xOffset = resolvePosition(position.x, unsnappedAvailableWidth, offsetX);
    phaseX = computeTilePhase(unsnappedBoxOffset.x + xOffset, tileWidth);
    spacingWidth = 0;
  } else if (repeatX === "space" && tileWidth > 0) {
    const count = Math.trunc(snappedPositioning.width / tileWidth);
    if (count > 1) {
      spacingWidth = divideRaw(snappedPositioning.width - count * tileWidth, count - 1);
      phaseX = computeTilePhase(snappedBoxOffset.x, tileWidth + spacingWidth);
    } else {
      repeatX = "no-repeat";
    }
  }
  if (repeatX === "no-repeat") {
    const xOffset = unsnappedBoxOffset.x
      + resolvePosition(position.x, unsnappedAvailableWidth, offsetX);
    const snappedXOffset = snappedBoxOffset.x
      + resolvePosition(position.x, snappedAvailableWidth, offsetX);
    if (xOffset > 0) {
      unsnappedDestination.x += xOffset;
      snappedDestination.x = roundRaw(unsnappedDestination.x) * LAYOUT_UNIT_SCALE;
      unsnappedDestination.width = tileWidth;
      snappedDestination.width = tileWidth;
      phaseX = 0;
    } else {
      phaseX = -xOffset;
      unsnappedDestination.width = Math.max(0, tileWidth + xOffset);
      snappedDestination.width = Math.max(0, tileWidth + snappedXOffset);
    }
    spacingWidth = 0;
  }

  if (repeatY === "repeat") {
    const yOffset = resolvePosition(position.y, unsnappedAvailableHeight, offsetY);
    phaseY = computeTilePhase(unsnappedBoxOffset.y + yOffset, tileHeight);
    spacingHeight = 0;
  } else if (repeatY === "space" && tileHeight > 0) {
    const count = Math.trunc(snappedPositioning.height / tileHeight);
    if (count > 1) {
      spacingHeight = divideRaw(snappedPositioning.height - count * tileHeight, count - 1);
      phaseY = computeTilePhase(snappedBoxOffset.y, tileHeight + spacingHeight);
    } else {
      repeatY = "no-repeat";
    }
  }
  if (repeatY === "no-repeat") {
    const yOffset = unsnappedBoxOffset.y
      + resolvePosition(position.y, unsnappedAvailableHeight, offsetY);
    const snappedYOffset = snappedBoxOffset.y
      + resolvePosition(position.y, snappedAvailableHeight, offsetY);
    if (yOffset > 0) {
      unsnappedDestination.y += yOffset;
      snappedDestination.y = roundRaw(unsnappedDestination.y) * LAYOUT_UNIT_SCALE;
      unsnappedDestination.height = tileHeight;
      snappedDestination.height = tileHeight;
      phaseY = 0;
    } else {
      phaseY = -yOffset;
      unsnappedDestination.height = Math.max(0, tileHeight + yOffset);
      snappedDestination.height = Math.max(0, tileHeight + snappedYOffset);
    }
    spacingHeight = 0;
  }

  unsnappedDestination = intersectRect(unsnappedDestination, unsnappedPainting);
  snappedDestination = snapRect(intersectRect(snappedDestination, unsnappedPainting));
  const finalPhaseX = computedPhase(phaseX, tileWidth + spacingWidth);
  const finalPhaseY = computedPhase(phaseY, tileHeight + spacingHeight);
  return {
    source: "blink-background-image-geometry-v1",
    unsnappedPositioningArea: publicRect(unsnappedPositioning),
    snappedPositioningArea: publicRect(snappedPositioning),
    unsnappedDestination: publicRect(unsnappedDestination),
    snappedDestination: publicRect(snappedDestination),
    tileSize: { width: cssPx(tileWidth), height: cssPx(tileHeight) },
    phase: { x: cssPx(finalPhaseX), y: cssPx(finalPhaseY) },
    spacing: { width: cssPx(spacingWidth), height: cssPx(spacingHeight) },
    repeat: { x: repeatX, y: repeatY },
  };
}

export function capturedBackgroundNaturalSizing(
  selected: CapturedBackgroundImage | null,
  legacyIntrinsic: { w: number; h: number } | null,
): BackgroundNaturalSizing {
  if (selected != null) {
    return {
      known: selected.naturalSizingState === "resolved",
      hasWidth: selected.hasNaturalWidth === true,
      hasHeight: selected.hasNaturalHeight === true,
      width: selected.naturalWidth,
      height: selected.naturalHeight,
      ratio: selected.naturalAspectRatio,
    };
  }
  return legacyIntrinsic == null
    ? { known: true, hasWidth: false, hasHeight: false, width: null, height: null, ratio: null }
    : {
        known: true,
        hasWidth: true,
        hasHeight: true,
        width: legacyIntrinsic.w,
        height: legacyIntrinsic.h,
        ratio: { width: legacyIntrinsic.w, height: legacyIntrinsic.h },
      };
}

/** Blink FillLayer repeats shorter longhand lists from their first entry. */
export function cyclicBackgroundLayer<T>(layers: readonly T[], index: number, fallback: T): T {
  return layers.length === 0 ? fallback : layers[index % layers.length] ?? fallback;
}

/** Compute the tile geometry and emit the exact vector pattern. */
export function buildImagePatternDef(
  id: string,
  href: string,
  elX: number,
  elY: number,
  width: number,
  height: number,
  sizeCss: string,
  posCss: string,
  repeatCss: string,
  intrinsic: { w: number; h: number } | null,
  attachment = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
  selectedImage: CapturedBackgroundImage | null = null,
  paintingArea: BackgroundRect | null = null,
): string {
  const fixed = attachment === "fixed" && fixedViewport != null;
  const positioningArea = fixed
    ? { x: 0, y: 0, width: fixedViewport.w, height: fixedViewport.h }
    : { x: elX, y: elY, width, height };
  const paint = paintingArea ?? { x: elX, y: elY, width, height };
  const geometry = resolveBlinkBackgroundImageGeometry({
    positioningArea,
    paintingArea: paint,
    size: sizeCss,
    position: posCss,
    repeat: repeatCss,
    natural: capturedBackgroundNaturalSizing(selectedImage, intrinsic),
  });
  if (geometry == null || geometry.tileSize.width <= 0 || geometry.tileSize.height <= 0
      || geometry.snappedDestination.width <= 0 || geometry.snappedDestination.height <= 0) {
    return "";
  }

  const noRepeatX = geometry.repeat.x === "no-repeat";
  const noRepeatY = geometry.repeat.y === "no-repeat";
  const patternX = noRepeatX ? paint.x : geometry.snappedDestination.x + geometry.phase.x;
  const patternY = noRepeatY ? paint.y : geometry.snappedDestination.y + geometry.phase.y;
  const patternWidth = noRepeatX ? paint.width : geometry.tileSize.width + geometry.spacing.width;
  const patternHeight = noRepeatY ? paint.height : geometry.tileSize.height + geometry.spacing.height;
  if (patternWidth <= 0 || patternHeight <= 0) return "";
  const imageX = noRepeatX
    ? geometry.snappedDestination.x + geometry.phase.x - patternX
    : 0;
  const imageY = noRepeatY
    ? geometry.snappedDestination.y + geometry.phase.y - patternY
    : 0;
  const embeddedHref = embedResizedDataUri(href, geometry.tileSize.width, geometry.tileSize.height);
  const embeddedKind = /^data:image\/svg\+xml(?:[;,])/i.test(embeddedHref)
    ? "svg"
    : /^data:image\//i.test(embeddedHref) ? "bitmap" : null;
  const imageKind = embeddedKind ?? selectedImage?.decodedImageKind ?? "unknown";
  if (imageKind === "unknown" && selectedImage != null) return "";
  // Blink asks SVGImageForContainer to map the external SVG viewport into the
  // CSS tile; bitmap images instead stretch to both concrete tile axes. The
  // old unconditional `none` lost SVG letterboxing for non-ratio tile sizes.
  const aspect = imageKind === "svg" ? "" : ' preserveAspectRatio="none"';
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${layoutNumber(patternX)}" y="${layoutNumber(patternY)}" width="${layoutNumber(patternWidth)}" height="${layoutNumber(patternHeight)}"><image href="${esc(embeddedHref)}" x="${layoutNumber(imageX)}" y="${layoutNumber(imageY)}" width="${layoutNumber(geometry.tileSize.width)}" height="${layoutNumber(geometry.tileSize.height)}"${aspect} /></pattern>`;
}
