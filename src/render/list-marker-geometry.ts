/** Blink list_marker.cc symbol geometry, Chromium rev pinned by the repo. */
export type SymbolMarkerType = "disc" | "circle" | "square" | "disclosure-open" | "disclosure-closed";

export interface SymbolMarkerGeometry {
  markerInlineSize: number;
  inlineOffset: number;
  blockOffset: number;
  inlineSize: number;
  blockSize: number;
  outsideEndMargin: number;
}

export function blinkSymbolMarkerGeometry(
  ascent: number,
  specifiedFontSize: number,
  type: SymbolMarkerType,
): SymbolMarkerGeometry {
  const ascentInt = Math.trunc(ascent);
  const disclosure = type === "disclosure-open" || type === "disclosure-closed";
  if (disclosure) {
    const size = specifiedFontSize * 0.66;
    return {
      markerInlineSize: size,
      inlineOffset: 0,
      blockOffset: ascentInt - size,
      inlineSize: size,
      blockSize: size,
      outsideEndMargin: 8,
    };
  }
  // Preserve C++ integer evaluation order from list_marker.cc.
  const twoThirdsAscent = Math.trunc((ascentInt * 2) / 3);
  const bulletWidth = Math.trunc((twoThirdsAscent + 1) / 2);
  const markerInlineSize = bulletWidth + 2;
  return {
    markerInlineSize,
    inlineOffset: 1,
    blockOffset: Math.trunc((3 * (ascentInt - twoThirdsAscent)) / 2),
    inlineSize: bulletWidth,
    blockSize: bulletWidth,
    outsideEndMargin: twoThirdsAscent + 8 - markerInlineSize,
  };
}

/** Equivalent to Blink's ToPixelSnappedRect: snap both edges, not just size. */
export function pixelSnapRect(x: number, y: number, width: number, height: number) {
  const left = Math.round(x), top = Math.round(y);
  const right = Math.round(x + width), bottom = Math.round(y + height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function disclosureTriangle(
  rect: { x: number; y: number; width: number; height: number },
  type: "disclosure-open" | "disclosure-closed",
  writingMode: string,
  direction: string,
): string {
  let points: Array<[number, number]>;
  if (type === "disclosure-open") {
    if (writingMode === "vertical-rl") points = [[1, 0], [0.14, 0.5], [1, 1]];
    else if (writingMode === "vertical-lr" || writingMode === "sideways-lr") points = [[0, 0], [0.86, 0.5], [0, 1]];
    else points = [[0, 0.07], [0.5, 0.93], [1, 0.07]];
  } else if (writingMode === "sideways-lr") {
    points = [[0, 0.93], [0.5, 0.07], [1, 0.93]];
  } else if (writingMode.startsWith("vertical") || writingMode === "sideways-rl") {
    points = [[0, 0.07], [0.5, 0.93], [1, 0.07]];
  } else if (direction === "rtl") {
    points = [[1, 0], [0.14, 0.5], [1, 1]];
  } else {
    points = [[0, 0], [0.86, 0.5], [0, 1]];
  }
  return points.map(([x, y]) => `${rect.x + x * rect.width},${rect.y + y * rect.height}`).join(" ");
}
