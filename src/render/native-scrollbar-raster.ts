/**
 * Emit same-frame Chromium pixels for platform-native scrollbar owners.
 *
 * The crop coordinates are already physical capture-viewport output geometry.
 * They are intentionally not rebuilt from the host box, scroll range, theme
 * thickness, or CSS transform. Overlay crops are precomposited with their
 * source backdrop; classic strips and the corner use the same lossless route.
 *
 * Pinned Chromium 7d859f271cbda744098ac69f44978d4edfa62be3:
 * `ScrollableAreaPainter::PaintOverflowControls` paints the horizontal axis,
 * vertical axis, scroll corner, then resizer (`scrollable_area_painter.cc`).
 */

import type {
  CapturedElement,
  CapturedNativeScrollbarRaster,
  CapturedScrollbarSet,
} from "../capture/types.js";
import { esc, r } from "./format.js";

type NativeScrollbarAxis = "horizontal" | "vertical" | "corner";

function elementScrollbarSets(el: CapturedElement): CapturedScrollbarSet[] {
  const sets: CapturedScrollbarSet[] = [];
  if (el.scrollbars != null) sets.push(el.scrollbars);
  if (el.rootScrollbars != null && el.rootScrollbars !== el.scrollbars) sets.push(el.rootScrollbars);
  return sets;
}

function paintRaster(
  raster: CapturedNativeScrollbarRaster | undefined,
  axis: NativeScrollbarAxis,
  indent: string,
): string | null {
  // Presence of the native route reserves ownership even on failure. A proven
  // empty faded overlay and an unavailable bitmap both emit no substitute.
  if (raster?.empty === true || raster?.dataUri == null) return null;
  return `${indent}<image data-domotion-scrollbar-part="native-${axis}" href="${esc(raster.dataUri)}" x="${r(raster.x)}" y="${r(raster.y)}" width="${r(raster.width)}" height="${r(raster.height)}" preserveAspectRatio="none" />`;
}

/** Paint native strips in Blink's physical overflow-control order. */
export function paintNativeScrollbarRasters(el: CapturedElement, indent: string): string[] {
  const output: string[] = [];
  for (const set of elementScrollbarSets(el)) {
    if (set.status === "absent" || set.status === "unavailable") continue;
    const horizontal = set.horizontal?.route === "native-raster"
      ? paintRaster(set.horizontal.nativeRaster, "horizontal", `${indent}  `)
      : null;
    const vertical = set.vertical?.route === "native-raster"
      ? paintRaster(set.vertical.nativeRaster, "vertical", `${indent}  `)
      : null;
    const corner = paintRaster(set.nativeCornerRaster, "corner", `${indent}  `);
    const parts = [horizontal, vertical, corner].filter((part): part is string => part != null);
    if (parts.length === 0) continue;
    output.push(`${indent}<g data-domotion-scrollbar-route="native-raster" data-domotion-scrollbar-phase="${set.paintPhase}">`);
    output.push(...parts);
    output.push(`${indent}</g>`);
  }
  return output;
}
