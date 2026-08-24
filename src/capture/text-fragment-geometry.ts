/**
 * Source-owned affine text-fragment geometry (DM-2469).
 *
 * Chromium supplies oriented live and all-transform-neutral quads. This file
 * solves their complete signed affine mapping, validates every held-out corner,
 * and correlates each physical protocol fragment with the neutral text segment
 * captured from the same paused frame. It never derives a font-size scalar.
 */

import type {
  CapturedTextPaintAffine,
  CapturedTextPaintGeometry,
  CapturedTextPaintQuad,
  TextSegment,
} from "./types.js";
import {
  asCapturedTextWritingMode,
  buildCapturedTextLineOrigin,
} from "./text-line-origin.js";

export const TEXT_AFFINE_RESIDUAL_EPSILON = 0.05;
export const TEXT_FRAGMENT_CORRELATION_EPSILON = 2;

export interface ProtocolTextNodeGeometry {
  sourceTextNodeIndex: number;
  neutralQuads: CapturedTextPaintQuad[];
  paintQuads: CapturedTextPaintQuad[];
  writingMode: string;
  direction: string;
  transformBox: string;
  transformOrigin: string;
  effectiveZoom: number;
}

export interface TextGeometryBuildResult {
  geometry: CapturedTextPaintGeometry | null;
  failureReason?: string;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function point(quad: CapturedTextPaintQuad, index: number): { x: number; y: number } {
  return { x: quad[index * 2], y: quad[index * 2 + 1] };
}

function quadRect(quad: CapturedTextPaintQuad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function segmentRect(segment: TextSegment): Rect {
  return {
    left: segment.x,
    top: segment.y,
    right: segment.x + segment.width,
    bottom: segment.y + segment.height,
  };
}

function rectEdgeDistance(left: Rect, right: Rect): number {
  return Math.max(
    Math.abs(left.left - right.left),
    Math.abs(left.top - right.top),
    Math.abs(left.right - right.right),
    Math.abs(left.bottom - right.bottom),
  );
}

export function mapTextPaintPoint(
  matrix: CapturedTextPaintAffine,
  source: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: matrix[0] * source.x + matrix[2] * source.y + matrix[4],
    y: matrix[1] * source.x + matrix[3] * source.y + matrix[5],
  };
}

/** Solve the affine mapping from three non-collinear neutral corners. */
export function solveTextPaintAffine(
  neutral: CapturedTextPaintQuad,
  paint: CapturedTextPaintQuad,
): CapturedTextPaintAffine | null {
  const n0 = point(neutral, 0);
  const n1 = point(neutral, 1);
  const n3 = point(neutral, 3);
  const p0 = point(paint, 0);
  const p1 = point(paint, 1);
  const p3 = point(paint, 3);
  const nx1 = n1.x - n0.x;
  const ny1 = n1.y - n0.y;
  const nx2 = n3.x - n0.x;
  const ny2 = n3.y - n0.y;
  const determinant = nx1 * ny2 - nx2 * ny1;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;
  const px1 = p1.x - p0.x;
  const py1 = p1.y - p0.y;
  const px2 = p3.x - p0.x;
  const py2 = p3.y - p0.y;
  const ia = ny2 / determinant;
  const ib = -ny1 / determinant;
  const ic = -nx2 / determinant;
  const id = nx1 / determinant;
  const a = px1 * ia + px2 * ib;
  const c = px1 * ic + px2 * id;
  const b = py1 * ia + py2 * ib;
  const d = py1 * ic + py2 * id;
  const e = p0.x - a * n0.x - c * n0.y;
  const f = p0.y - b * n0.x - d * n0.y;
  const result: CapturedTextPaintAffine = [a, b, c, d, e, f];
  return result.every(Number.isFinite) ? result : null;
}

export function textPaintAffineResidual(
  matrix: CapturedTextPaintAffine,
  neutralQuads: readonly CapturedTextPaintQuad[],
  paintQuads: readonly CapturedTextPaintQuad[],
): number {
  if (neutralQuads.length === 0 || neutralQuads.length !== paintQuads.length) return Infinity;
  let residual = 0;
  for (let fragment = 0; fragment < neutralQuads.length; fragment++) {
    for (let corner = 0; corner < 4; corner++) {
      const expected = point(paintQuads[fragment], corner);
      const actual = mapTextPaintPoint(matrix, point(neutralQuads[fragment], corner));
      residual = Math.max(
        residual,
        Math.abs(actual.x - expected.x),
        Math.abs(actual.y - expected.y),
      );
    }
  }
  return residual;
}

function exactCodeUnitGeometry(segment: TextSegment): { origins: number[]; advances: number[] } | null {
  const origins = segment.verticalWritingMode != null ? segment.yOffsets : segment.xOffsets;
  const explicit = segment.verticalWritingMode != null ? segment.verticalAdvances : segment.xAdvances;
  // These arrays come from the Range/shape probe and are UTF-16 indexed.
  // Repeating a final coordinate or inferring an advance from the fragment
  // AABB would silently turn missing browser facts into synthetic geometry.
  if (origins == null || explicit == null
    || origins.length !== segment.text.length
    || explicit.length !== segment.text.length
    || !origins.every(Number.isFinite)
    || !explicit.every(Number.isFinite)) return null;
  return { origins: [...origins], advances: [...explicit] };
}

/**
 * Correlate neutral capture segments with protocol fragments and build the
 * immutable record consumed by DM-2470. Any count, matrix, or correlation
 * ambiguity fails closed instead of choosing the nearest plausible scalar.
 */
export function buildCapturedTextPaintGeometry(
  segments: readonly TextSegment[],
  elementAscent: number | undefined,
  nodes: readonly ProtocolTextNodeGeometry[],
): TextGeometryBuildResult {
  const measured: Array<{
    node: ProtocolTextNodeGeometry;
    physicalFragmentIndex: number;
    neutralQuad: CapturedTextPaintQuad;
    paintQuad: CapturedTextPaintQuad;
    matrix: CapturedTextPaintAffine;
    residual: number;
  }> = [];

  for (const node of nodes) {
    if (node.neutralQuads.length === 0 || node.neutralQuads.length !== node.paintQuads.length) {
      return { geometry: null, failureReason: "text fragment count changed between neutral and paint spaces" };
    }
    const matrix = solveTextPaintAffine(node.neutralQuads[0], node.paintQuads[0]);
    if (matrix == null) return { geometry: null, failureReason: "text fragment affine matrix is singular or unavailable" };
    const residual = textPaintAffineResidual(matrix, node.neutralQuads, node.paintQuads);
    if (!Number.isFinite(residual) || residual > TEXT_AFFINE_RESIDUAL_EPSILON) {
      return { geometry: null, failureReason: `text paint plane is non-affine (corner residual ${residual})` };
    }
    for (let index = 0; index < node.neutralQuads.length; index++) {
      measured.push({
        node,
        physicalFragmentIndex: index,
        neutralQuad: node.neutralQuads[index],
        paintQuad: node.paintQuads[index],
        matrix,
        residual,
      });
    }
  }

  if (measured.length === 0) return { geometry: null, failureReason: "Chromium exposed no physical text fragment quads" };
  const usedSegments = new Set<number>();
  const fragments: CapturedTextPaintGeometry["fragments"] = [];
  for (const item of measured) {
    const target = quadRect(item.neutralQuad);
    const candidates = segments
      .map((segment, index) => ({ index, distance: rectEdgeDistance(segmentRect(segment), target) }))
      .filter((candidate) => !usedSegments.has(candidate.index))
      .sort((left, right) => left.distance - right.distance);
    const best = candidates[0];
    if (best == null || best.distance > TEXT_FRAGMENT_CORRELATION_EPSILON) {
      return { geometry: null, failureReason: "neutral text segment could not be correlated with its protocol fragment" };
    }
    if (candidates[1] != null && Math.abs(candidates[1].distance - best.distance) < 1e-4) {
      return { geometry: null, failureReason: "neutral text fragment correlation is ambiguous" };
    }
    usedSegments.add(best.index);
    const segment = segments[best.index];
    const vertical = segment.verticalWritingMode != null;
    const shaped = exactCodeUnitGeometry(segment);
    if (shaped == null) {
      return { geometry: null, failureReason: "exact shaped text origins or advances are unavailable" };
    }
    const ascent = segment.fontAscent ?? elementAscent ?? 0;
    const writingMode = asCapturedTextWritingMode(item.node.writingMode);
    if (writingMode == null) {
      return { geometry: null, failureReason: `unsupported text writing mode ${item.node.writingMode}` };
    }
    const lineOrigin = buildCapturedTextLineOrigin({
      fragmentLeft: segment.x,
      fragmentTop: segment.y,
      fragmentWidth: segment.width,
      fragmentHeight: segment.height,
      primaryFontAscent: ascent,
      writingMode,
      effectiveZoom: item.node.effectiveZoom,
    });
    if (lineOrigin == null) {
      return { geometry: null, failureReason: "Blink line-relative text origin is unavailable" };
    }
    const inlineOffset = segment.inlineOffset ?? (vertical
      ? segment.y
      : item.node.direction === "rtl" ? segment.x + segment.width : segment.x);
    fragments.push({
      source: "blink-text-fragment-affine-v2",
      space: "pre-css-transform-viewport",
      textSegmentIndex: best.index,
      sourceTextNodeIndex: item.node.sourceTextNodeIndex,
      physicalFragmentIndex: item.physicalFragmentIndex,
      neutralQuad: item.neutralQuad,
      paintQuad: item.paintQuad,
      paintMatrix: item.matrix,
      affineResidual: item.residual,
      lineOrigin,
      inlineOffset,
      shapedOrigins: shaped.origins,
      shapedAdvances: shaped.advances,
      writingMode: item.node.writingMode,
      direction: item.node.direction,
      transformBox: item.node.transformBox,
      transformOrigin: item.node.transformOrigin,
    });
  }

  fragments.sort((left, right) => left.textSegmentIndex - right.textSegmentIndex);
  return {
    geometry: {
      source: "blink-text-fragment-affine-v2",
      space: "pre-css-transform-viewport",
      fragments,
    },
  };
}
