/**
 * Paint planning for Blink-owned author custom scrollbars.
 *
 * Geometry is never reconstructed here. CustomScrollbar and
 * CustomScrollbarTheme already resolved thickness, buttons, margins, track
 * pieces, thumb position, logical side, zoom, and clipping in Chromium; the
 * capture record supplies those final rectangles. This module only preserves
 * Blink's paint order and chooses vector CSS-box paint versus an explicit
 * owner-part raster fallback.
 *
 * Pinned Chromium 7d859f271cbda744098ac69f44978d4edfa62be3:
 * - custom_scrollbar_theme.cc:154-201 (background/buttons/track/pieces/thumb)
 * - custom_scrollbar.cc:463-471 (track-and-buttons before thumb)
 * - scrollable_area_painter.cc:236-253 (horizontal/vertical/corner/resizer)
 */

import type {
  CapturedElement,
  CapturedScrollbar,
  CapturedScrollbarPart,
  CapturedScrollbarPartKind,
  CapturedScrollbarRect,
  CapturedScrollbarSet,
} from "../capture/types.js";
import { esc, r } from "./format.js";

export interface CustomScrollbarVectorPart {
  part: CapturedScrollbarPart;
  orientation: "horizontal" | "vertical" | "corner";
  effectiveZoom: number;
}

export interface CustomScrollbarPaintContext {
  defsParts: string[];
  nextId(prefix: string): string;
  paintVectorPart(item: CustomScrollbarVectorPart, indent: string): string[];
}

const PART_PAINT_ORDER: Readonly<Record<CapturedScrollbarPartKind, number>> = {
  background: 0,
  "back-button": 1,
  "forward-button": 1,
  track: 2,
  "back-track": 3,
  "forward-track": 3,
  thumb: 4,
  corner: 5,
};

function comparePhysicalParts(
  orientation: "horizontal" | "vertical",
  a: CapturedScrollbarPart,
  b: CapturedScrollbarPart,
): number {
  const paintOrder = PART_PAINT_ORDER[a.kind] - PART_PAINT_ORDER[b.kind];
  if (paintOrder !== 0) return paintOrder;
  return orientation === "horizontal" ? a.rect.x - b.rect.x : a.rect.y - b.rect.y;
}

/** Source-order part list for one already-laid-out CustomScrollbar. */
export function orderedCustomScrollbarParts(
  scrollbar: CapturedScrollbar | undefined,
): CapturedScrollbarPart[] {
  if (scrollbar?.route !== "author-custom") return [];
  return [...scrollbar.parts].sort((a, b) => comparePhysicalParts(scrollbar.orientation, a, b));
}

function elementScrollbarSets(el: CapturedElement): CapturedScrollbarSet[] {
  const sets: CapturedScrollbarSet[] = [];
  if (el.scrollbars != null) sets.push(el.scrollbars);
  if (el.rootScrollbars != null && el.rootScrollbars !== el.scrollbars) sets.push(el.rootScrollbars);
  return sets;
}

function clipDef(id: string, rect: CapturedScrollbarRect): string {
  return `<clipPath id="${id}"><rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" /></clipPath>`;
}

function paintItem(
  context: CustomScrollbarPaintContext,
  item: CustomScrollbarVectorPart,
  indent: string,
): string[] {
  const { part } = item;
  const raster = part.raster;
  let body: string[];
  if (raster != null) {
    // Presence selects the explicit owner-only fallback. A failed or proven
    // empty materialization remains fail-closed; never substitute a guessed
    // vector style for a dynamic/unsupported winner.
    if (raster.empty === true || raster.dataUri == null) return [];
    body = [
      `${indent}  <image href="${esc(raster.dataUri)}" x="${r(raster.x)}" y="${r(raster.y)}" width="${r(raster.width)}" height="${r(raster.height)}" preserveAspectRatio="none" />`,
    ];
  } else {
    body = context.paintVectorPart(item, `${indent}  `);
    if (body.length === 0) return [];
  }
  return [
    `${indent}<g data-domotion-scrollbar-part="${part.kind}" data-domotion-scrollbar-axis="${item.orientation}">`,
    ...body,
    `${indent}</g>`,
  ];
}

/**
 * Emit all custom scrollbar sets owned by an element. Native records are
 * deliberately ignored and remain the stock-raster route.
 */
export function paintCustomScrollbars(
  context: CustomScrollbarPaintContext,
  _captureViewport: { w: number; h: number },
  el: CapturedElement,
  indent: string,
): string[] {
  const output: string[] = [];
  for (const set of elementScrollbarSets(el)) {
    if (set.status === "absent" || set.status === "unavailable" || set.overlay === true) continue;
    const items: CustomScrollbarVectorPart[] = [];
    for (const part of orderedCustomScrollbarParts(set.horizontal)) {
      items.push({ part, orientation: "horizontal", effectiveZoom: set.effectiveZoom });
    }
    for (const part of orderedCustomScrollbarParts(set.vertical)) {
      items.push({ part, orientation: "vertical", effectiveZoom: set.effectiveZoom });
    }
    if (set.corner != null && (set.horizontal?.route === "author-custom" || set.vertical?.route === "author-custom")) {
      items.push({ part: set.corner, orientation: "corner", effectiveZoom: set.effectiveZoom });
    }
    if (items.length === 0) continue;

    const clip = set.overflowControlsClip;
    const clipId = clip != null && clip.width > 0 && clip.height > 0
      ? context.nextId("customscrollclip")
      : null;
    if (clipId != null && clip != null) {
      context.defsParts.push(clipDef(clipId, clip));
      output.push(`${indent}<g clip-path="url(#${clipId})" data-domotion-scrollbar-route="author-custom">`);
    } else {
      output.push(`${indent}<g data-domotion-scrollbar-route="author-custom">`);
    }
    for (const item of items) output.push(...paintItem(context, item, `${indent}  `));
    output.push(`${indent}</g>`);
  }
  return output;
}
