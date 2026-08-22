/**
 * Transitional projection of DM-2467 source-owned pseudo records into the
 * legacy renderer fields. New live capture geometry comes only from the
 * protocol record; old serialized trees may continue to carry only the legacy
 * fields. DM-2468 can remove this bridge once it consumes the record directly.
 */

import type { CapturedElement, CapturedPseudoFragmentSet, PseudoBox, TextSegment } from "./types.js";

function pseudoBox(record: CapturedPseudoFragmentSet, index: number): PseudoBox {
  const fragment = record.boxFragments[index];
  const paint = record.paint;
  const vertical = record.writingMode !== "horizontal-tb";
  const inlineStart = !vertical
    ? (record.direction === "rtl" ? "right" : "left")
    : (record.writingMode === "sideways-lr" ? (record.direction === "ltr" ? "bottom" : "top") : (record.direction === "rtl" ? "bottom" : "top"));
  const inlineEnd = inlineStart === "left" ? "right" : inlineStart === "right" ? "left" : inlineStart === "top" ? "bottom" : "top";
  const blockStart = !vertical ? "top" : (record.writingMode === "vertical-rl" || record.writingMode === "sideways-rl" ? "right" : "left");
  const blockEnd = blockStart === "top" ? "bottom" : blockStart === "right" ? "left" : "right";
  const owns = (side: "top" | "right" | "bottom" | "left"): boolean =>
    (side === inlineStart && fragment.edgeOwnership.inlineStart)
    || (side === inlineEnd && fragment.edgeOwnership.inlineEnd)
    || (side === blockStart && fragment.edgeOwnership.blockStart)
    || (side === blockEnd && fragment.edgeOwnership.blockEnd);
  return {
    pseudo: record.pseudo,
    ...fragment.physicalRect,
    backgroundColor: paint.backgroundColor,
    backgroundImage: paint.backgroundImage === "none" ? undefined : paint.backgroundImage,
    backgroundPosition: paint.backgroundPosition,
    backgroundSize: paint.backgroundSize,
    opacity: paint.opacity === 1 ? undefined : paint.opacity,
    borderTopWidth: owns("top") ? record.edges.border.top : 0,
    borderTopColor: paint.borderTopColor,
    borderTopStyle: paint.borderTopStyle,
    borderRightColor: paint.borderRightColor,
    borderRightStyle: paint.borderRightStyle,
    borderRightWidth: owns("right") ? record.edges.border.right : 0,
    borderBottomWidth: owns("bottom") ? record.edges.border.bottom : 0,
    borderBottomColor: paint.borderBottomColor,
    borderBottomStyle: paint.borderBottomStyle,
    borderLeftColor: paint.borderLeftColor,
    borderLeftStyle: paint.borderLeftStyle,
    borderLeftWidth: owns("left") ? record.edges.border.left : 0,
    borderRadius: Number.parseFloat(paint.borderRadius) || 0,
    transform: paint.transform === "none" ? undefined : paint.transform,
    transformOrigin: paint.transformOrigin,
    zIndex: paint.zIndex,
    filter: paint.filter === "none" ? undefined : paint.filter,
  };
}

function textSegment(record: CapturedPseudoFragmentSet, fragmentIndex: number): TextSegment | null {
  const fragment = record.fragments[fragmentIndex];
  if (fragment.kind !== "text") return null;
  const vertical = record.writingMode !== "horizontal-tb";
  const typography = record.typography;
  return {
    text: fragment.text,
    sourceText: fragment.text,
    x: fragment.physicalRect.x,
    y: vertical ? fragment.physicalRect.y : fragment.baseline.origin.y - fragment.baseline.ascent,
    width: fragment.physicalRect.width,
    height: fragment.physicalRect.height,
    shapedWidth: fragment.shapedInlineAdvance,
    baseline: vertical ? fragment.baseline.origin.x : fragment.baseline.origin.y,
    inlineOffset: vertical ? fragment.baseline.origin.y : fragment.baseline.origin.x,
    color: record.paint.color,
    fontSize: typography.paintFontSize,
    fontWeight: typography.fontWeight,
    fontStyle: typography.fontStyle,
    fontFamily: typography.fontFamily,
    fontVariant: typography.fontVariant,
    fontAscent: typography.primaryFontAscent,
    ...(vertical ? {
      verticalWritingMode: record.writingMode,
      yOffsets: [fragment.baseline.origin.y],
      verticalAdvances: [fragment.shapedInlineAdvance],
      verticalNaturalWidths: [fragment.shapedInlineAdvance],
    } : {}),
  };
}

function projectRecord(element: CapturedElement, record: CapturedPseudoFragmentSet): void {
  if (record.status === "terminal-raster") {
    const surface = record.terminalRaster;
    if (surface?.dataUri != null && surface.rect.width > 0 && surface.rect.height > 0) {
      (element.pseudoImages ??= []).push({
        url: surface.dataUri,
        ...surface.rect,
      });
    }
    return;
  }
  if (record.status !== "exact") return;
  const segments = record.fragments
    .map((_, index) => textSegment(record, index))
    .filter((segment): segment is TextSegment => segment != null);
  if (segments.length > 0) {
    const current = element.textSegments ?? [];
    element.textSegments = record.pseudo === "::before" ? [...segments, ...current] : [...current, ...segments];
    const generatedText = record.contentItems.filter((item) => item.kind === "text").map((item) => item.text ?? "").join("");
    element.text = record.pseudo === "::before" ? generatedText + element.text : element.text + generatedText;
  }
  for (const fragment of record.fragments) {
    if (fragment.kind !== "image") continue;
    const item = record.contentItems[fragment.contentItemIndex];
    if (item?.resolvedUrl == null) continue;
    (element.pseudoImages ??= []).push({
      url: item.resolvedUrl,
      ...fragment.physicalRect,
      filter: record.paint.filter === "none" ? undefined : record.paint.filter,
      opacity: record.paint.opacity,
      transform: record.paint.transform === "none" ? undefined : record.paint.transform,
      transformOrigin: record.paint.transformOrigin,
    });
  }
  if (record.boxFragments.length > 0) {
    (element.pseudoBoxes ??= []).push(...record.boxFragments.map((_, index) => pseudoBox(record, index)));
  }
  const allRects = [
    ...segments.map((segment) => ({ x: segment.x, y: segment.y, width: segment.width, height: segment.height })),
    ...record.fragments.filter((fragment) => fragment.kind === "image").map((fragment) => fragment.physicalRect),
  ];
  if (allRects.length > 0 && (element.textSegments?.length ?? 0) === segments.length) {
    const left = Math.min(...allRects.map((rect) => rect.x));
    const top = Math.min(...allRects.map((rect) => rect.y));
    const right = Math.max(...allRects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...allRects.map((rect) => rect.y + rect.height));
    element.textLeft = left;
    element.textTop = top;
    element.textWidth = right - left;
    element.textHeight = bottom - top;
    element.fontAscent = record.typography.primaryFontAscent;
  }
}

/** Apply exact live-record compatibility fields without consulting clones. */
export function projectPseudoFragmentCompatibility(tree: CapturedElement[]): void {
  const visit = (elements: CapturedElement[]): void => {
    for (const element of elements) {
      const records = element.pseudoFragments ?? [];
      for (const record of records.filter((row) => row.pseudo === "::before")) projectRecord(element, record);
      for (const record of records.filter((row) => row.pseudo === "::after")) projectRecord(element, record);
      visit(element.children ?? []);
    }
  };
  visit(tree);
}
