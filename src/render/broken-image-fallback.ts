/** Hybrid SVG emission for Chromium's HTML broken-image UA fallback. */
import type { CapturedBrokenImageQuad, CapturedElement, TextSegment } from "../capture/types.js";
import { esc, r } from "./format.js";
import { renderMultiSegmentText } from "./text.js";
import { hasVerticalSegments, renderVerticalSegments } from "./vertical-text.js";

export interface BrokenImageFallbackRenderOptions {
  indent: string;
  idPrefix: string;
  nextId(prefix: string): string;
}

export interface BrokenImageFallbackRenderResult {
  /** True means the authoritative record owns this image paint decision. */
  handled: boolean;
  defs: string[];
  svg: string[];
}

function quadPath(quad: CapturedBrokenImageQuad): string {
  return `M${r(quad[0])} ${r(quad[1])}L${r(quad[2])} ${r(quad[3])}L${r(quad[4])} ${r(quad[5])}L${r(quad[6])} ${r(quad[7])}Z`;
}

function sidePolygon(
  outer: CapturedBrokenImageQuad,
  inner: CapturedBrokenImageQuad,
  side: "top" | "right" | "bottom" | "left",
): CapturedBrokenImageQuad {
  if (side === "top") return [outer[0], outer[1], outer[2], outer[3], inner[2], inner[3], inner[0], inner[1]];
  if (side === "right") return [outer[2], outer[3], outer[4], outer[5], inner[4], inner[5], inner[2], inner[3]];
  if (side === "bottom") return [outer[4], outer[5], outer[6], outer[7], inner[6], inner[7], inner[4], inner[5]];
  return [outer[6], outer[7], outer[0], outer[1], inner[0], inner[1], inner[6], inner[7]];
}

function accessibilityAttributes(el: CapturedElement): { attrs: string; title: string } {
  const ax = el.brokenImageFallback?.accessibility;
  if (ax == null || "unavailableReason" in ax) return { attrs: "", title: "" };
  if (ax.ignored) return { attrs: ' aria-hidden="true"', title: "" };
  const name = ax.name ?? "";
  return {
    attrs: ` role="img"${name === "" ? "" : ` aria-label="${esc(name)}"`}`,
    title: name === "" ? "" : `<title>${esc(name)}</title>`,
  };
}

function fallbackTextElement(el: CapturedElement): CapturedElement | null {
  const text = el.brokenImageFallback?.text;
  if (text == null || text.value === "" || text.segments.length === 0) return null;
  const box = text.box ?? {
    x: text.segments[0].x,
    y: text.segments[0].y,
    width: text.segments[0].width,
    height: text.segments[0].height,
  };
  const segments: TextSegment[] = text.segments.map((segment) => ({ ...segment }));
  return {
    ...el,
    tag: "span",
    text: text.value,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    styles: {
      ...el.styles,
      color: text.style.color,
      fontFamily: text.style.fontFamily,
      fontSize: `${text.style.fontSize}px`,
      fontStyle: text.style.fontStyle,
      fontWeight: text.style.fontWeight,
      fontStretch: text.style.fontStretch,
      fontFeatureSettings: text.style.fontFeatureSettings,
      fontVariationSettings: text.style.fontVariationSettings,
      lineHeight: text.style.lineHeight,
      letterSpacing: text.style.letterSpacing,
      textTransform: text.style.textTransform,
      whiteSpace: text.style.whiteSpace,
      direction: text.style.direction,
      writingMode: text.style.writingMode,
      // The captured UA container clip owns overflow for icon and text as one
      // fallback. Do not let the synthetic text carrier mint a second box clip.
      overflowX: "visible",
      overflowY: "visible",
    },
    textSegments: segments,
    textLeft: box.x,
    textTop: box.y,
    textWidth: box.width,
    textHeight: box.height,
    fontAscent: text.fontMetrics.ascent,
    children: [],
    imageSrc: undefined,
    imageBroken: false,
    imageAlt: undefined,
    brokenImageFallback: undefined,
  };
}

function renderFallbackText(
  el: CapturedElement,
  idPrefix: string,
  clipId: string,
): string {
  const textEl = fallbackTextElement(el);
  if (textEl == null || textEl.textSegments == null) return "";
  const fillColor = el.brokenImageFallback!.text!.style.color;
  if (hasVerticalSegments(textEl)) return renderVerticalSegments(textEl, fillColor);
  return renderMultiSegmentText({
    el: textEl,
    idPrefix,
    clipId,
    fillColor,
    overflowClip: false,
  }, textEl.textSegments);
}

/**
 * Emit only the captured UA fallback. Author host paint/wrappers remain owned
 * by the ordinary element renderer surrounding this result.
 */
export function renderBrokenImageFallback(
  el: CapturedElement,
  options: BrokenImageFallbackRenderOptions,
): BrokenImageFallbackRenderResult {
  const record = el.brokenImageFallback;
  if (el.tag !== "img" || record == null) return { handled: false, defs: [], svg: [] };

  // A decoded primary image continues through ordinary object-fit paint.
  if (record.disposition === "primary" && record.loadState === "loaded") {
    return { handled: false, defs: [], svg: [] };
  }
  const defs: string[] = [];
  const svg: string[] = [];
  const { attrs, title } = accessibilityAttributes(el);
  const prefix = `${options.indent}<g${attrs}>${title}`;
  const suffix = "</g>";

  if (record.captureStatus === "terminal-raster") {
    // DM-2463 classifies this boundary and issues the warning. A terminal
    // payload may be added by capture; without one, fail closed with no UA
    // synthesis rather than resurrecting the fixed mountain/raw-text guess.
    const raster = record.terminalRaster;
    if (raster?.dataUri != null) {
      svg.push(`${prefix}<image href="${esc(raster.dataUri)}" x="${r(raster.rect.x)}" y="${r(raster.rect.y)}" width="${r(raster.rect.width)}" height="${r(raster.rect.height)}" preserveAspectRatio="none"/>${suffix}`);
    }
    return { handled: true, defs, svg };
  }

  if (record.icon?.visible === true && record.icon.raster == null) {
    // Live capture promotes this condition to the classified terminal record.
    // Treat hand-built/older inconsistent records the same way instead of
    // silently emitting a vector-only fallback that claims exact ownership.
    console.warn("[broken-image-fallback] visible Chromium icon has no authoritative raster; failing closed");
    return { handled: true, defs, svg };
  }

  if (record.disposition === "loading" || record.disposition === "collapsed"
      || record.disposition === "primary") {
    return { handled: true, defs, svg };
  }

  const body: string[] = [];
  const container = record.container;
  if (container?.box != null) {
    const sides = ["top", "right", "bottom", "left"] as const;
    for (const side of sides) {
      const width = container.border[side];
      const style = container.border[`${side}Style`];
      if (!(width > 0) || style === "none" || style === "hidden") continue;
      body.push(`<path d="${quadPath(sidePolygon(container.box.border, container.box.padding, side))}" fill="${esc(container.border[`${side}Color`])}"/>`);
    }
  }

  let contentOpen = "";
  let contentClose = "";
  let textClipId = "";
  if (container?.overflowClip != null) {
    textClipId = options.nextId("bifc");
    defs.push(`<clipPath id="${textClipId}"><path d="${quadPath(container.overflowClip)}"/></clipPath>`);
    contentOpen = `<g clip-path="url(#${textClipId})">`;
    contentClose = "</g>";
  } else {
    // renderMultiSegmentText receives a required clip id but does not reference
    // it while overflowClip is false.
    textClipId = options.nextId("bift");
  }

  const content: string[] = [];
  const raster = record.icon?.raster;
  if (record.icon?.visible === true && raster != null) {
    content.push(`<image href="${esc(raster.dataUri)}" x="${r(raster.rect.x)}" y="${r(raster.rect.y)}" width="${r(raster.rect.width)}" height="${r(raster.rect.height)}" preserveAspectRatio="none" data-broken-image-icon="${record.icon.resourceScale}x"/>`);
  }
  const text = renderFallbackText(el, options.idPrefix, textClipId);
  // The captured AX node is authoritative for the replacement. Normal text
  // rendering deliberately retains its own portable SVG semantics, so hide
  // that nested visual subtree and expose exactly the source AX record above.
  if (text !== "") content.push(`<g aria-hidden="true" data-broken-image-text="vector">${text}</g>`);
  if (content.length > 0) body.push(`${contentOpen}${content.join("")}${contentClose}`);
  if (body.length > 0 || title !== "") svg.push(`${prefix}${body.join("")}${suffix}`);
  return { handled: true, defs, svg };
}
