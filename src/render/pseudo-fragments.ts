/**
 * DM-2468/DM-2459: direct paint consumer for Blink-owned generated pseudos.
 *
 * The capture record already owns anonymous-child boundaries, fragment order,
 * physical baselines/quads, and slice/clone edge ownership.  This module never
 * consults the host text box (or any of the legacy pseudo heuristics).  Invalid
 * records terminate at a non-painting diagnostic marker so stale host anchors
 * cannot silently become geometry again.
 */

import bidiFactory from "bidi-js";
import { capturedFontFamilyCss } from "../font-family-stack.js";
import { resolveCharOrientation } from "../vertical-orientation.js";

import type {
  CapturedElement,
  CapturedPseudoFragmentSet,
  CapturedTextPaintAffine,
} from "../capture/types.js";
import type {
  Point,
  PseudoBoxFragment,
  PseudoTextFragment,
  Rect,
} from "../capture/pseudo-fragment-protocol.js";
import { esc, r } from "./format.js";
import {
  mergeFeatureLists,
  parseFontFeatureSettings,
  parseFontVariationSettings,
  resolveChwsFeature,
  resolveFontVariantFeatures,
} from "./text.js";
import { blinkFontOrientation } from "./vertical-text.js";
import { renderTextAsPath } from "./text-to-path.js";
import { IDENTITY_TEXT_AFFINE, invertTextAffine, serializeTextPaintMatrix, textAffineEquals } from "./text-affine.js";

export type PseudoFragmentPaintSlot =
  | "negative"
  | "before"
  | "after"
  | "positioned"
  | "positive";

export interface PseudoBackgroundPaint {
  record: CapturedPseudoFragmentSet;
  rect: Rect;
  borderRadius: number;
}

export interface RenderPseudoFragmentsOptions {
  indent?: string;
  /** Resolve a captured generated image through the ordinary embed cache. */
  imageHref?: (url: string, width: number, height: number) => string;
  /** Main renderer hook for gradient/url background paint-server allocation. */
  emitBackgroundImage?: (paint: PseudoBackgroundPaint) => string;
  /** Static SVG CTM already surrounding this host's content. */
  emittedCtm?: CapturedTextPaintAffine | null;
}

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const EPSILON = 0.8;
const bidi = bidiFactory();

function finiteRect(rect: Rect | null): rect is Rect {
  return rect != null
    && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function hasDegenerateCssTransform(transform: string): boolean {
  const match = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (match == null) return false;
  const values = match[1].split(",").map(Number);
  return values.length === 6 && values.every(Number.isFinite)
    && Math.abs(values[0] * values[3] - values[1] * values[2]) < 1e-12;
}

/** Source-owned non-paint activation shared by validation and emission. */
export function pseudoFragmentIsUnpainted(record: CapturedPseudoFragmentSet): boolean {
  return record.status === "unpainted"
    || record.paint.visibility === "hidden"
    || record.paint.visibility === "collapse"
    || record.paint.opacity === 0
    // A scale(0) generated indicator still has a real Blink pseudo and an
    // authoritative empty paint result. Its collapsed quad is not a protocol
    // failure and must not reopen compatibility indicator synthesis.
    || hasDegenerateCssTransform(record.paint.transform);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Affine map from the retained local border rect to its physical quad. */
export function pseudoFragmentAffine(box: PseudoBoxFragment): Affine | null {
  const local = box.localBorderRect;
  const quad = box.physicalQuad;
  if (!finiteRect(local) || quad.length !== 4 || !quad.every(finitePoint)) return null;
  const a = (quad[1].x - quad[0].x) / local.width;
  const b = (quad[1].y - quad[0].y) / local.width;
  const c = (quad[3].x - quad[0].x) / local.height;
  const d = (quad[3].y - quad[0].y) / local.height;
  const e = quad[0].x - a * local.x - c * local.y;
  const f = quad[0].y - b * local.x - d * local.y;
  const predicted = { x: quad[0].x + a * local.width + c * local.height, y: quad[0].y + b * local.width + d * local.height };
  if (distance(predicted, quad[2]) > EPSILON || Math.abs(a * d - b * c) < 1e-8) return null;
  return { a, b, c, d, e, f };
}

function matrix(value: Affine): string {
  // Fragment matrices routinely multiply viewport-sized local coordinates.
  // The renderer's ordinary one-decimal geometry formatter is therefore not
  // safe here: rounding a shear coefficient by 0.04 moves a y=1100 fragment
  // by ~44px. Keep the same bounded nine-digit serialization as affine text.
  return serializeTextPaintMatrix([value.a, value.b, value.c, value.d, value.e, value.f]);
}

function capsFeatures(value: string): string[] | undefined {
  if (/\ball-small-caps\b/.test(value)) return ["smcp", "c2sc"];
  if (/\ball-petite-caps\b/.test(value)) return ["pcap", "c2pc"];
  if (/\bsmall-caps\b/.test(value)) return ["smcp"];
  if (/\bpetite-caps\b/.test(value)) return ["pcap"];
  if (/\bunicase\b/.test(value)) return ["unic"];
  if (/\btitling-caps\b/.test(value)) return ["titl"];
  return undefined;
}

function fontFeatures(record: CapturedPseudoFragmentSet): string[] | undefined {
  const typography = record.typography;
  const authored = parseFontFeatureSettings(typography.fontFeatureSettings);
  const variants = resolveFontVariantFeatures(
    typography.fontVariant,
    typography.fontVariant,
    typography.fontVariant,
    typography.letterSpacing,
    undefined,
    typography.fontKerning,
    undefined,
  );
  return mergeFeatureLists(
    mergeFeatureLists(mergeFeatureLists(capsFeatures(typography.fontVariant), variants), authored),
    resolveChwsFeature(authored),
  );
}

function mirrorBidiBrackets(text: string, direction: "ltr" | "rtl"): string {
  if (direction === "ltr" && !/[֐-ࣿיִ-ﻼ]/.test(text)) return text;
  const levels = bidi.getEmbeddingLevels(text, direction).levels;
  let output = "";
  for (let index = 0; index < text.length; index++) {
    const mirrored = levels[index] % 2 === 1 ? bidi.getMirroredCharacter(text[index]) : null;
    output += mirrored ?? text[index];
  }
  return output;
}

function textOptions(record: CapturedPseudoFragmentSet, targetWidth?: number, visualOrder = false) {
  const typography = record.typography;
  const unicodeBidi = record.paint.unicodeBidi;
  return {
    fontSize: typography.paintFontSize,
    fontFamily: capturedFontFamilyCss(typography.fontFamily, typography.fontFamilyStack),
    fontWeight: typography.fontWeight,
    fontStyle: typography.fontStyle,
    fontStretch: typography.fontStretch,
    fontOrientation: blinkFontOrientation(record.writingMode, typography.textOrientation),
    fill: record.paint.color,
    targetWidth,
    ascentOverride: typography.primaryFontAscent,
    features: fontFeatures(record),
    lang: typography.language,
    variationSettings: parseFontVariationSettings(typography.fontVariationSettings),
    bidiOverride: visualOrder
      ? { direction: "ltr" as const, unicodeBidi: "bidi-override" }
      : { direction: record.direction, unicodeBidi },
  };
}

/**
 * Protocol fragments are already ordered left-to-right in Blink visual paint
 * order. Within each retained logical slice, project the UBA result to its
 * visual string once, including paired-bracket mirroring, then ask the text
 * funnel to preserve that order. Merely mirroring the source characters left
 * spaces and RTL letters at logical x positions (`אבג (12) xyz` became
 * `xyz(12אבג )`) even though every fragment boundary was authoritative.
 */
function visualBidiFragment(
  record: CapturedPseudoFragmentSet,
  text: string,
): { text: string; projected: boolean } {
  const override = record.paint.unicodeBidi === "bidi-override"
    || record.paint.unicodeBidi === "isolate-override";
  if (override || (record.direction === "ltr" && !/[֐-ࣿיִ-ﻼ]/.test(text))) {
    return { text: mirrorBidiBrackets(text, record.direction), projected: false };
  }
  const levels = bidi.getEmbeddingLevels(text, record.direction);
  return { text: bidi.getReorderedString(text, levels), projected: true };
}

function wrapMatrix(value: Affine, markup: string): string {
  return `<g transform="${matrix(value)}">${markup}</g>`;
}

function compensateEmittedCtm(markup: string, emittedCtm: CapturedTextPaintAffine | null | undefined): string | null {
  if (emittedCtm === null) return null;
  if (emittedCtm === undefined || textAffineEquals(emittedCtm, IDENTITY_TEXT_AFFINE)) return markup;
  const inverse = invertTextAffine(emittedCtm);
  return inverse == null ? null : `<g transform="${serializeTextPaintMatrix(inverse)}">${markup}</g>`;
}

function baselineMatrix(
  record: CapturedPseudoFragmentSet,
  fragment: PseudoTextFragment,
  boxMatrix: Affine,
): Affine | null {
  const advance = fragment.shapedInlineAdvance;
  if (!(advance > 0) || !finitePoint(fragment.baseline.origin) || !finitePoint(fragment.baseline.end)) return null;
  let a = (fragment.baseline.end.x - fragment.baseline.origin.x) / advance;
  let b = (fragment.baseline.end.y - fragment.baseline.origin.y) / advance;
  let c = boxMatrix.c;
  let d = boxMatrix.d;
  let e = fragment.baseline.origin.x;
  let f = fragment.baseline.origin.y;
  if (record.writingMode === "horizontal-tb") {
    const box = record.boxFragments[fragment.boxFragmentIndex];
    const quad = box?.physicalQuad;
    if (box != null && quad?.length === 4
        && (Math.abs(quad[1].y - quad[0].y) > 1e-5 || Math.abs(quad[3].x - quad[0].x) > 1e-5)) {
      // DOMSnapshot text bounds are post-transform AABBs, so AABB -> quad
      // scaling is not a source paint matrix. Recover both affine axes from
      // the authoritative box quad divided by the logical anonymous-child
      // extents retained in this record: shaped inline advances plus owned
      // edges, and primary ascent+descent plus owned block edges.
      const owned = (side: "top" | "right" | "bottom" | "left"): number =>
        ownsSide(record, box, side) ? record.edges.border[side] + record.edges.padding[side] : 0;
      const siblings = record.fragments
        .filter((candidate) => candidate.boxFragmentIndex === fragment.boxFragmentIndex)
        .sort((left, right) => left.visualOrder - right.visualOrder);
      const inlineAdvanceOf = (candidate: typeof siblings[number]): number =>
        candidate.kind === "text" ? candidate.shapedInlineAdvance : candidate.localRect.width;
      const contentInline = siblings.reduce((sum, candidate) => sum + inlineAdvanceOf(candidate), 0);
      const contentBlock = siblings.reduce((maximum, candidate) => Math.max(maximum,
        candidate.kind === "text"
          ? record.typography.primaryFontAscent + record.typography.primaryFontDescent
          : candidate.localRect.height), 0);
      const logicalInline = owned("left") + contentInline + owned("right");
      const logicalBlock = owned("top") + contentBlock + owned("bottom");
      if (logicalInline > 0 && logicalBlock > 0) {
        a = (quad[1].x - quad[0].x) / logicalInline;
        b = (quad[1].y - quad[0].y) / logicalInline;
        c = (quad[3].x - quad[0].x) / logicalBlock;
        d = (quad[3].y - quad[0].y) / logicalBlock;
        const preceding = siblings.slice(0, siblings.indexOf(fragment)).reduce(
          (sum, candidate) => sum + inlineAdvanceOf(candidate), 0);
        const inlineOffset = owned("left") + preceding;
        const blockOffset = owned("top") + fragment.baseline.ascent;
        e = quad[0].x + a * inlineOffset + c * blockOffset;
        f = quad[0].y + b * inlineOffset + d * blockOffset;
      }
    }
  } else {
    // Blink's clockwise vertical/sideways transform maps glyph-space +y to
    // physical -x.  sideways-lr is the sole counter-clockwise mode.
    const sign = record.writingMode === "sideways-lr" ? 1 : -1;
    c = boxMatrix.a * sign;
    d = boxMatrix.b * sign;
  }
  if (Math.abs(a * d - b * c) < 1e-8) return null;
  return { a, b, c, d, e, f };
}

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  }
  return [...text];
}

function uprightVertical(text: string): boolean {
  // The pseudo protocol exposes grapheme cells rather than Blink's private
  // glyph list. Classify each cell through the same Chromium-pinned property
  // route as ordinary and UA-shadow text; no host Unicode range guesses.
  return resolveCharOrientation(text, "mixed") === "upright";
}

function renderVerticalMixed(
  record: CapturedPseudoFragmentSet,
  fragment: PseudoTextFragment,
  boxMatrix: Affine,
): string {
  const units = graphemes(mirrorBidiBrackets(fragment.text, record.direction));
  if (units.length === 0) return "";
  const allUpright = units.every(uprightVertical);
  const allRotated = units.every((unit) => !uprightVertical(unit));
  if (allRotated) return renderBaselineText(record, fragment, boxMatrix);

  // DOMSnapshot exposes one anonymous text-box row, not Blink's private
  // per-glyph orientation list.  For an upright run we nevertheless retain
  // its exact box and endpoints: divide only the captured inline advance among
  // grapheme cells and shape every cell through the ordinary source-owned font
  // route. Mixed upright/rotated sequences use the same cells, rotating only
  // the characters for which VerticalOrientationIterator says rotated.
  const cell = fragment.protocolInlineAdvance / units.length;
  const pieces: string[] = [];
  let cursor = 0;
  for (const unit of units) {
    const y = fragment.localRect.y + cursor;
    if (uprightVertical(unit)) {
      const x = fragment.localRect.x + (fragment.localRect.width - record.typography.paintFontSize) / 2;
      const opts = textOptions(record);
      pieces.push(renderTextAsPath(unit, x, y, {
        ...opts,
        features: mergeFeatureLists(opts.features, ["vert"]),
      }));
    } else {
      const originX = fragment.localRect.x + fragment.localRect.width - record.typography.primaryFontAscent;
      const originY = y;
      const localRotate: Affine = { a: 0, b: 1, c: -1, d: 0, e: originX, f: originY };
      pieces.push(wrapMatrix(localRotate, renderTextAsPath(unit, 0, -record.typography.primaryFontAscent, textOptions(record, cell))));
    }
    cursor += cell;
  }
  return wrapMatrix(boxMatrix, pieces.join(""));
}

function renderBaselineText(
  record: CapturedPseudoFragmentSet,
  fragment: PseudoTextFragment,
  boxMatrix: Affine,
): string {
  const transform = baselineMatrix(record, fragment, boxMatrix);
  if (transform == null) return "";
  const visual = visualBidiFragment(record, fragment.text);
  const path = renderTextAsPath(
    visual.text,
    0,
    -record.typography.primaryFontAscent,
    textOptions(record, fragment.shapedInlineAdvance, visual.projected),
  );
  return wrapMatrix(transform, path);
}

function renderTextFragment(
  record: CapturedPseudoFragmentSet,
  fragment: PseudoTextFragment,
  boxMatrix: Affine,
): string {
  const sideways = record.writingMode.startsWith("sideways") || record.typography.textOrientation === "sideways";
  if (record.writingMode !== "horizontal-tb" && !sideways) {
    return renderVerticalMixed(record, fragment, boxMatrix);
  }
  return renderBaselineText(record, fragment, boxMatrix);
}

function physicalSides(record: CapturedPseudoFragmentSet): {
  inlineStart: "top" | "right" | "bottom" | "left";
  inlineEnd: "top" | "right" | "bottom" | "left";
  blockStart: "top" | "right" | "bottom" | "left";
  blockEnd: "top" | "right" | "bottom" | "left";
} {
  if (record.writingMode === "horizontal-tb") return {
    inlineStart: record.direction === "ltr" ? "left" : "right",
    inlineEnd: record.direction === "ltr" ? "right" : "left",
    blockStart: "top",
    blockEnd: "bottom",
  };
  const reverseInline = record.writingMode === "sideways-lr" ? record.direction === "ltr" : record.direction === "rtl";
  return {
    inlineStart: reverseInline ? "bottom" : "top",
    inlineEnd: reverseInline ? "top" : "bottom",
    blockStart: record.writingMode === "vertical-rl" || record.writingMode === "sideways-rl" ? "right" : "left",
    blockEnd: record.writingMode === "vertical-rl" || record.writingMode === "sideways-rl" ? "left" : "right",
  };
}

function ownsSide(record: CapturedPseudoFragmentSet, box: PseudoBoxFragment, side: "top" | "right" | "bottom" | "left"): boolean {
  const sides = physicalSides(record);
  return (sides.inlineStart === side && box.edgeOwnership.inlineStart)
    || (sides.inlineEnd === side && box.edgeOwnership.inlineEnd)
    || (sides.blockStart === side && box.edgeOwnership.blockStart)
    || (sides.blockEnd === side && box.edgeOwnership.blockEnd);
}

function opaque(color: string): boolean {
  return color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
}

function borderLine(rect: Rect, side: "top" | "right" | "bottom" | "left", width: number, color: string, style: string): string {
  if (!(width > 0) || !opaque(color) || style === "none" || style === "hidden") return "";
  const snappedCenter = (value: number): number => {
    const integralWidth = Math.round(width);
    if (Math.abs(width - integralWidth) > 1e-6) return value;
    return integralWidth % 2 === 1 ? Math.floor(value) + 0.5 : Math.round(value);
  };
  const dash = style === "dashed" ? ` stroke-dasharray="${r(width * 3)},${r(width * 3)}"`
    : style === "dotted" ? ` stroke-dasharray="0,${r(width * 2)}" stroke-linecap="round"` : "";
  if (side === "top") return `<line x1="${r(rect.x)}" y1="${r(snappedCenter(rect.y + width / 2))}" x2="${r(rect.x + rect.width)}" y2="${r(snappedCenter(rect.y + width / 2))}" stroke="${esc(color)}" stroke-width="${r(width)}"${dash}/>`;
  if (side === "right") return `<line x1="${r(snappedCenter(rect.x + rect.width - width / 2))}" y1="${r(rect.y)}" x2="${r(snappedCenter(rect.x + rect.width - width / 2))}" y2="${r(rect.y + rect.height)}" stroke="${esc(color)}" stroke-width="${r(width)}"${dash}/>`;
  if (side === "bottom") return `<line x1="${r(rect.x)}" y1="${r(snappedCenter(rect.y + rect.height - width / 2))}" x2="${r(rect.x + rect.width)}" y2="${r(snappedCenter(rect.y + rect.height - width / 2))}" stroke="${esc(color)}" stroke-width="${r(width)}"${dash}/>`;
  return `<line x1="${r(snappedCenter(rect.x + width / 2))}" y1="${r(rect.y)}" x2="${r(snappedCenter(rect.x + width / 2))}" y2="${r(rect.y + rect.height)}" stroke="${esc(color)}" stroke-width="${r(width)}"${dash}/>`;
}

function roundedUniformBorder(
  record: CapturedPseudoFragmentSet,
  box: PseudoBoxFragment,
  rect: Rect,
  radius: number,
): string | null {
  if (!(radius > 0)) return null;
  const sides = ["top", "right", "bottom", "left"] as const;
  if (!sides.every((side) => ownsSide(record, box, side))) return null;

  const widths = sides.map((side) => record.edges.border[side]);
  const width = widths[0];
  if (!(width > 0) || !widths.every((candidate) => Math.abs(candidate - width) <= 1e-6)) return null;

  const paint = record.paint;
  const colors = [paint.borderTopColor, paint.borderRightColor, paint.borderBottomColor, paint.borderLeftColor];
  const styles = [paint.borderTopStyle, paint.borderRightStyle, paint.borderBottomStyle, paint.borderLeftStyle];
  const color = colors[0];
  // A single inset SVG stroke has the same outer/inner circular contours as
  // Blink's uniform solid rounded border. Mixed edges and dash phase retain
  // the explicit per-side path below.
  if (!opaque(color) || !colors.every((candidate) => candidate === color) || !styles.every((candidate) => candidate === "solid")) return null;

  const inset = width / 2;
  const strokeWidth = Math.max(0, rect.width - width);
  const strokeHeight = Math.max(0, rect.height - width);
  if (!(strokeWidth > 0) || !(strokeHeight > 0)) return "";
  return `<rect x="${r(rect.x + inset)}" y="${r(rect.y + inset)}" width="${r(strokeWidth)}" height="${r(strokeHeight)}" rx="${r(Math.max(0, radius - inset))}" ry="${r(Math.max(0, radius - inset))}" fill="none" stroke="${esc(color)}" stroke-width="${r(width)}"/>`;
}

function renderBox(
  record: CapturedPseudoFragmentSet,
  box: PseudoBoxFragment,
  boxMatrix: Affine,
  options: RenderPseudoFragmentsOptions,
): string {
  const rect = box.localBorderRect!;
  const paint = record.paint;
  const radius = Math.min(Number.parseFloat(paint.borderRadius) || 0, rect.width / 2, rect.height / 2);
  const radiusAttr = radius > 0 ? ` rx="${r(radius)}" ry="${r(radius)}"` : "";
  const pieces: string[] = [];
  if (opaque(paint.backgroundColor)) {
    pieces.push(`<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}"${radiusAttr} fill="${esc(paint.backgroundColor)}"/>`);
  }
  if (paint.backgroundImage !== "" && paint.backgroundImage !== "none") {
    pieces.push(options.emitBackgroundImage?.({ record, rect, borderRadius: radius }) ?? "");
  }
  const edges = record.edges.border;
  const colors = { top: paint.borderTopColor, right: paint.borderRightColor, bottom: paint.borderBottomColor, left: paint.borderLeftColor };
  const styles = { top: paint.borderTopStyle, right: paint.borderRightStyle, bottom: paint.borderBottomStyle, left: paint.borderLeftStyle };
  const roundedBorder = roundedUniformBorder(record, box, rect, radius);
  if (roundedBorder != null) {
    pieces.push(roundedBorder);
  } else {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (ownsSide(record, box, side)) pieces.push(borderLine(rect, side, edges[side], colors[side], styles[side]));
    }
  }
  return pieces.length === 0 ? "" : wrapMatrix(boxMatrix, pieces.join(""));
}

/** Structural invariants required before an exact record can own paint. */
export function pseudoFragmentRecordErrors(record: CapturedPseudoFragmentSet): string[] {
  if (record.status !== "exact") return [];
  if (pseudoFragmentIsUnpainted(record)) return [];
  const errors: string[] = [];
  const matrices = record.boxFragments.map((box, index) => {
    const value = pseudoFragmentAffine(box);
    if (value == null) errors.push(`box ${index} has collapsed/non-affine geometry`);
    return value;
  });
  const orders = new Set<number>();
  for (let index = 0; index < record.fragments.length; index++) {
    const fragment = record.fragments[index];
    if (fragment.boxFragmentIndex < 0 || matrices[fragment.boxFragmentIndex] == null) errors.push(`fragment ${index} has no paintable box owner`);
    if (!finiteRect(fragment.localRect) || fragment.physicalQuad.length !== 4 || !fragment.physicalQuad.every(finitePoint)) errors.push(`fragment ${index} has invalid geometry`);
    if (!Number.isInteger(fragment.visualOrder) || orders.has(fragment.visualOrder)) errors.push(`fragment ${index} has duplicate/invalid visual order`);
    orders.add(fragment.visualOrder);
    if (fragment.kind === "text" && fragment.text !== "" && baselineMatrix(record, fragment, matrices[fragment.boxFragmentIndex] ?? { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }) == null) {
      errors.push(`fragment ${index} has a collapsed baseline`);
    }
  }
  if ([...orders].sort((a, b) => a - b).some((value, index) => value !== index)) errors.push("visual order is not contiguous");
  return errors;
}

export function pseudoFragmentPaintSlot(record: CapturedPseudoFragmentSet): PseudoFragmentPaintSlot {
  if ((record.paint.zIndex ?? 0) < 0) return "negative";
  if ((record.paint.zIndex ?? 0) > 0) return "positive";
  if (record.paint.position === "absolute" || record.paint.position === "fixed" || record.paint.zIndex === 0) return "positioned";
  // Blink's generated-child order is ::checkmark, ::before, host content,
  // ::after. Checkmark therefore shares the before slot; capture order keeps
  // it ahead of a simultaneously authored ::before record.
  return record.pseudo === "::after" ? "after" : "before";
}

/** Render exactly one source-owned record, without any host-derived fallback. */
export function renderPseudoFragmentRecord(
  record: CapturedPseudoFragmentSet,
  options: RenderPseudoFragmentsOptions = {},
): string {
  if (pseudoFragmentIsUnpainted(record)) return "";
  const label = record.contentItems.filter((item) => item.kind === "text").map((item) => item.text ?? "").join("");
  const attrs = `data-domotion-pseudo-source="${record.source}" data-domotion-pseudo="${record.pseudo}"`;
  if (record.status === "terminal-raster") {
    const raster = record.terminalRaster;
    if (raster?.dataUri == null || !(raster.rect.width > 0) || !(raster.rect.height > 0)) return `<g ${attrs} data-domotion-pseudo-boundary="terminal-empty"/>`;
    const rasterMarkup = `<g ${attrs} data-domotion-pseudo-owner="chromium-raster"><image href="${esc(raster.dataUri)}" x="${r(raster.rect.x)}" y="${r(raster.rect.y)}" width="${r(raster.rect.width)}" height="${r(raster.rect.height)}" preserveAspectRatio="none"/></g>`;
    return compensateEmittedCtm(rasterMarkup, options.emittedCtm)
      ?? `<g ${attrs} data-domotion-pseudo-boundary="singular-emitted-ctm"/>`;
  }
  const errors = pseudoFragmentRecordErrors(record);
  if (errors.length > 0) return `<g ${attrs} data-domotion-pseudo-boundary="${esc(errors.join("; "))}"/>`;

  const matrices = record.boxFragments.map((box) => pseudoFragmentAffine(box)!);
  const pieces: string[] = [];
  const backdrop = record.backdropFilterRaster;
  if (backdrop?.dataUri != null && finiteRect(backdrop.rect)) {
    // Skia initializes the pseudo's effect layer from the prior parent device.
    // This viewport-space Chromium crop is therefore the first paint inside
    // the pseudo's captured slot; box/text/image vectors remain direct and
    // retain their existing generated-child order above the boundary.
    pieces.push(`<g data-domotion-pseudo-backdrop-owner="${backdrop.source}"><image href="${esc(backdrop.dataUri)}" x="${r(backdrop.rect.x)}" y="${r(backdrop.rect.y)}" width="${r(backdrop.rect.width)}" height="${r(backdrop.rect.height)}" preserveAspectRatio="none"/></g>`);
  }
  const vectorStart = pieces.length;
  pieces.push(...record.boxFragments.map((box, index) => renderBox(record, box, matrices[index], options)));
  const fragments = [...record.fragments].sort((a, b) => a.visualOrder - b.visualOrder);
  for (const fragment of fragments) {
    const boxMatrix = matrices[fragment.boxFragmentIndex];
    if (fragment.kind === "text") {
      pieces.push(renderTextFragment(record, fragment, boxMatrix));
      continue;
    }
    const item = record.contentItems[fragment.contentItemIndex];
    if (item?.kind !== "image" || item.resolvedUrl == null) continue;
    const href = options.imageHref?.(item.resolvedUrl, fragment.localRect.width, fragment.localRect.height) ?? item.resolvedUrl;
    const image = `<image href="${esc(href)}" x="${r(fragment.localRect.x)}" y="${r(fragment.localRect.y)}" width="${r(fragment.localRect.width)}" height="${r(fragment.localRect.height)}" preserveAspectRatio="xMidYMid meet"/>`;
    pieces.push(wrapMatrix(boxMatrix, image));
  }
  if (vectorStart > 0 && pieces.length > vectorStart) {
    const vectors = pieces.splice(vectorStart);
    pieces.push(`<g data-domotion-pseudo-vector-owner="source-fragments">${vectors.join("")}</g>`);
  }
  const effectAttrs = [
    record.paint.opacity < 1 ? ` opacity="${r(record.paint.opacity)}"` : "",
    record.paint.filter !== "" && record.paint.filter !== "none" ? ` style="${esc(`filter:${record.paint.filter}`)}"` : "",
  ].join("");
  const aria = label === "" ? "" : ` role="img" aria-label="${esc(label)}"`;
  const markup = `<g ${attrs} data-domotion-pseudo-owner="source-fragments"${aria}${effectAttrs}>${pieces.join("")}</g>`;
  return compensateEmittedCtm(markup, options.emittedCtm)
    ?? `<g ${attrs} data-domotion-pseudo-boundary="singular-emitted-ctm"/>`;
}

/** Render only records assigned to one explicit host-paint slot. */
export function renderPseudoFragmentSlot(
  element: Pick<CapturedElement, "pseudoFragments">,
  slot: PseudoFragmentPaintSlot,
  options: RenderPseudoFragmentsOptions = {},
): string[] {
  const indent = options.indent ?? "";
  return (element.pseudoFragments ?? [])
    .filter((record) => pseudoFragmentPaintSlot(record) === slot)
    .map((record) => `${indent}${renderPseudoFragmentRecord(record, options)}`)
    .filter((markup) => markup !== indent);
}
