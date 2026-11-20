/**
 * Tile geometry for SVG-native linear/radial gradient background layers.
 *
 * Blink paints a generated image exactly like a URL image: one tile of
 * `background-size` (the positioning area for `auto`, since a gradient has no
 * natural dimensions), placed by `background-position` and repeated by
 * `background-repeat` (repeat / space / round / no-repeat) across the painting
 * area (`BackgroundImageGeometry`, core/paint/background_image_geometry.cc,
 * Chromium 7d859f27; transcribed in `resolveBlinkBackgroundImageGeometry`).
 * The renderer used to stretch one gradient over the positioning box and pad
 * it to the painting box, ignoring size and repeat.
 */

import { buildLinearGradientDef, buildRadialGradientDef } from "./gradient-defs.js";
import { formatNumberLoose } from "./format.js";
import { resolveBlinkBackgroundImageGeometry, type BackgroundRect } from "./image-pattern.js";

const NO_NATURAL_SIZE = { known: true, hasWidth: false, hasHeight: false, width: null, height: null, ratio: null };
/** Snapping slack: Blink snaps the destination to whole pixels, while the
 * single-gradient path paints the unsnapped box. Sub-pixel placement alone
 * must not switch an ordinary one-tile layer to the pattern path. */
const SINGLE_TILE_EPSILON = 0.5;

function num(value: number): string {
  return formatNumberLoose(value, 6);
}

/** Is the painting extent on one axis covered by the single tile that also
 * coincides with the positioning area (what one stretched gradient paints)? */
function axisIsSingleTile(
  paintStart: number,
  paintLength: number,
  positionStart: number,
  positionLength: number,
  origin: number,
  tileLength: number,
  step: number,
  noRepeat: boolean,
): boolean {
  let start = origin;
  if (!noRepeat && step > 0) start = origin + Math.floor((paintStart + SINGLE_TILE_EPSILON - origin) / step) * step;
  return (
    Math.abs(tileLength - positionLength) <= SINGLE_TILE_EPSILON &&
    Math.abs(start - positionStart) <= SINGLE_TILE_EPSILON &&
    start <= paintStart + SINGLE_TILE_EPSILON &&
    start + tileLength >= paintStart + paintLength - SINGLE_TILE_EPSILON
  );
}

/**
 * Returns a `<pattern>` (preceded by its tile gradient) whose fill paints the
 * gradient layer with Blink's tile geometry, or null when one gradient
 * stretched over the positioning area already paints identically (the
 * byte-stable legacy path) or the geometry cannot be resolved.
 */
export function buildGradientTilePatternDef(input: {
  id: string;
  kind: "linear" | "radial";
  args: string;
  repeating: boolean;
  positioningArea: BackgroundRect;
  paintingArea: BackgroundRect | null;
  size: string;
  position: string;
  repeat: string;
}): string | null {
  const paint = input.paintingArea ?? input.positioningArea;
  const geometry = resolveBlinkBackgroundImageGeometry({
    positioningArea: input.positioningArea,
    paintingArea: paint,
    size: input.size,
    position: input.position,
    repeat: input.repeat,
    natural: NO_NATURAL_SIZE,
  });
  if (geometry == null) return null;
  const tileW = geometry.tileSize.width;
  const tileH = geometry.tileSize.height;
  if (!(tileW > 0) || !(tileH > 0)) return null;
  const noRepeatX = geometry.repeat.x === "no-repeat";
  const noRepeatY = geometry.repeat.y === "no-repeat";
  const originX = geometry.snappedDestination.x + geometry.phase.x;
  const originY = geometry.snappedDestination.y + geometry.phase.y;
  const stepX = tileW + geometry.spacing.width;
  const stepY = tileH + geometry.spacing.height;
  const area = input.positioningArea;
  if (
    axisIsSingleTile(paint.x, paint.width, area.x, area.width, originX, tileW, stepX, noRepeatX) &&
    axisIsSingleTile(paint.y, paint.height, area.y, area.height, originY, tileH, stepY, noRepeatY)
  ) {
    return null;
  }
  // A destination clipped away entirely paints nothing.
  if (geometry.snappedDestination.width <= 0 || geometry.snappedDestination.height <= 0) {
    return `<pattern id="${input.id}" patternUnits="userSpaceOnUse" width="1" height="1" />`;
  }
  const patternX = noRepeatX ? paint.x : originX;
  const patternY = noRepeatY ? paint.y : originY;
  const patternW = noRepeatX ? paint.width : stepX;
  const patternH = noRepeatY ? paint.height : stepY;
  if (!(patternW > 0) || !(patternH > 0)) return null;
  const tileX = noRepeatX ? originX - patternX : 0;
  const tileY = noRepeatY ? originY - patternY : 0;
  const gradientId = `${input.id}t`;
  const gradient =
    input.kind === "linear"
      ? buildLinearGradientDef(gradientId, input.args, input.repeating, tileW, tileH, tileX, tileY)
      : buildRadialGradientDef(gradientId, input.args, input.repeating, tileX, tileY, tileW, tileH, 0, 0);
  if (gradient === "") return null;
  return `${gradient}<pattern id="${input.id}" patternUnits="userSpaceOnUse" x="${num(patternX)}" y="${num(patternY)}" width="${num(patternW)}" height="${num(patternH)}"><rect x="${num(tileX)}" y="${num(tileY)}" width="${num(tileW)}" height="${num(tileH)}" fill="url(#${gradientId})" /></pattern>`;
}
