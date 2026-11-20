/**
 * Viewport placement for Chromium screenshots of frozen-transform content.
 *
 * The capture walk freezes every static planar CSS transform: it records the
 * element's untransformed (local) layout box and the renderer re-applies the
 * transform as an SVG `<g transform>` wrapper. Blink paints box content in that
 * local space and applies the transform afterwards (box decorations are snapped
 * by `ToPixelSnappedRect` on the local paint offset, Chromium 7d859f27
 * `third_party/blink/renderer/core/paint/box_painter_base.cc`), which is why the
 * vector paint matches only under the wrapper model.
 *
 * Node-side raster producers, however, screenshot the live page after the walk,
 * where every transform is painted. A crop taken at the captured local box reads
 * the wrong part of the page as soon as an ancestor (or the element itself) has
 * a frozen transform. This module maps a captured local rectangle through the
 * same static CTM the renderer emits (`buildEmittedTextCtmMap`, own transform
 * included) to the viewport rectangle that actually holds those pixels. The
 * producer crops there and marks the raster `viewportSpace`, and the renderer
 * places the image by inverting the CTM open at its emission point.
 */

import { buildEmittedTextCtmMap, IDENTITY_TEXT_AFFINE, textAffineEquals } from "../render/text-affine.js";
import type { CapturedElement, CapturedTextPaintAffine } from "./types.js";

export interface RasterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned bounds of `rect` mapped through `matrix`. */
export function mapRectThroughAffine(rect: RasterRect, matrix: CapturedTextPaintAffine): RasterRect {
  const corners: Array<[number, number]> = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const mappedX = matrix[0] * x + matrix[2] * y + matrix[4];
    const mappedY = matrix[1] * x + matrix[3] * y + matrix[5];
    minX = Math.min(minX, mappedX);
    minY = Math.min(minY, mappedY);
    maxX = Math.max(maxX, mappedX);
    maxY = Math.max(maxY, mappedY);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface RasterViewportSpace {
  /**
   * The non-identity static CTM that maps `element`'s captured local geometry
   * to the viewport, or null when the element paints untransformed (identity)
   * or under a projective owner (whose own raster path places its surface).
   */
  frozenCtm(element: CapturedElement): CapturedTextPaintAffine | null;
}

export function createRasterViewportSpace(tree: readonly CapturedElement[]): RasterViewportSpace {
  let ctms: ReturnType<typeof buildEmittedTextCtmMap> | undefined;
  return {
    frozenCtm(element) {
      ctms ??= buildEmittedTextCtmMap(tree);
      const ctm = ctms.get(element);
      if (ctm == null || textAffineEquals(ctm, IDENTITY_TEXT_AFFINE)) return null;
      return ctm;
    },
  };
}
