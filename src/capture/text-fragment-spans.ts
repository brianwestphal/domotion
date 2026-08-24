/**
 * Exact Blink FragmentItem source ownership for ordinary affine text.
 *
 * `Range.getClientRects()` and `DOM.getContentQuads` both traverse the same
 * LayoutText FragmentItems at the pinned Chromium revision.  The browser-side
 * probe recovers each full item's half-open DOM UTF-16 interval; this module
 * performs the ordered, exact rectangle/quad join and splits capture segments
 * on those authored intervals before affine correlation.  No nearest-rect or
 * pixel-tolerance fallback exists here.
 */

import type {
  CapturedDomUtf16Span,
  CapturedTextFragmentSourceSpan,
  CapturedTextPaintQuad,
  TextSegment,
} from "./types.js";

export interface CapturedTextRangeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlinkRangeFragmentProbe {
  physicalFragmentIndex: number;
  domUtf16Span: CapturedDomUtf16Span;
  /** Frame-local, transform-neutral Range rectangle. */
  neutralRangeRect: CapturedTextRangeRect;
}

export interface JoinedTextSourceFragment extends BlinkRangeFragmentProbe {
  sourceTextNodeIndex: number;
  /** Capture-viewport rectangle after the exact frame translation is joined. */
  neutralRangeRect: CapturedTextRangeRect;
  cdpQuadIndex?: number;
}

export interface FragmentJoinResult {
  fragments: JoinedTextSourceFragment[] | null;
  failureReason?: string;
}

export interface FragmentSplitResult {
  segments: TextSegment[] | null;
  sourceFragments: CapturedTextFragmentSourceSpan[];
  /** One entry per source fragment; null is never returned on success. */
  textSegmentIndexBySourceFragment: Array<number | null>;
  failureReason?: string;
}

interface RectEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const SOURCE_PROVENANCE: CapturedTextFragmentSourceSpan["provenance"] = {
  chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
  rangeQuads: "core/layout/layout_text.cc:556-637",
  fragmentOffsets: "core/layout/inline/fragment_item.h:448-451",
  fragmentLocalRect: "core/layout/inline/fragment_item.cc:1217-1241",
  firstLetter: "core/dom/range.cc:1686-1742",
  protocolQuads: "core/inspector/inspector_highlight.cc:1941-1967",
};

function finiteRect(rect: CapturedTextRangeRect): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function quadEdges(quad: CapturedTextPaintQuad): RectEdges {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function rectEdges(rect: CapturedTextRangeRect): RectEdges {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  };
}

function exactTranslatedMatch(
  range: CapturedTextRangeRect,
  quad: RectEdges,
  dx: number,
  dy: number,
): boolean {
  const source = rectEdges(range);
  return source.left + dx === quad.left
    && source.top + dy === quad.top
    && source.right + dx === quad.right
    && source.bottom + dy === quad.bottom;
}

function mappingCount(
  matches: readonly (readonly boolean[])[],
  quadIndex: number,
  minimumRangeIndex: number,
  memo: Map<string, { count: number; path: number[] | null }>,
): { count: number; path: number[] | null } {
  if (quadIndex === matches.length) return { count: 1, path: [] };
  const key = `${quadIndex}:${minimumRangeIndex}`;
  const cached = memo.get(key);
  if (cached != null) return cached;
  let count = 0;
  let path: number[] | null = null;
  for (let rangeIndex = minimumRangeIndex; rangeIndex < matches[quadIndex].length; rangeIndex++) {
    if (!matches[quadIndex][rangeIndex]) continue;
    const tail = mappingCount(matches, quadIndex + 1, rangeIndex + 1, memo);
    if (tail.count === 0) continue;
    if (count === 0 && tail.count === 1 && tail.path != null) path = [rangeIndex, ...tail.path];
    count = Math.min(2, count + tail.count);
    if (count > 1) path = null;
  }
  const result = { count, path };
  memo.set(key, result);
  return result;
}

/**
 * Join ordered Range FragmentItems to ordered protocol quads.  Child-frame
 * Range coordinates differ from root CDP coordinates by one translation; all
 * four edges of every joined item must prove the same exact translation.
 */
export function joinBlinkRangeFragmentsToContentQuads(
  sourceTextNodeIndex: number,
  rangeFragments: readonly BlinkRangeFragmentProbe[],
  neutralQuads: readonly CapturedTextPaintQuad[],
): FragmentJoinResult {
  if (!Number.isInteger(sourceTextNodeIndex) || sourceTextNodeIndex < 0) {
    return { fragments: null, failureReason: "text source node index is invalid" };
  }
  if (neutralQuads.length === 0 || rangeFragments.length < neutralQuads.length) {
    return { fragments: null, failureReason: "Range FragmentItem/cardinality is smaller than protocol quad cardinality" };
  }
  for (let index = 0; index < rangeFragments.length; index++) {
    const fragment = rangeFragments[index];
    if (fragment.physicalFragmentIndex !== index || !finiteRect(fragment.neutralRangeRect)) {
      return { fragments: null, failureReason: "Range FragmentItem order or rectangle is invalid" };
    }
    const [start, end] = fragment.domUtf16Span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      return { fragments: null, failureReason: "Range FragmentItem UTF-16 span is invalid" };
    }
  }
  if (neutralQuads.some((quad) => quad.length !== 8 || !quad.every(Number.isFinite))) {
    return { fragments: null, failureReason: "protocol text quad is invalid" };
  }

  const quadRects = neutralQuads.map(quadEdges);
  const translations = new Map<string, { dx: number; dy: number }>();
  for (const quad of quadRects) {
    for (const fragment of rangeFragments) {
      const range = rectEdges(fragment.neutralRangeRect);
      if (range.right - range.left !== quad.right - quad.left
        || range.bottom - range.top !== quad.bottom - quad.top) continue;
      const dx = quad.left - range.left;
      const dy = quad.top - range.top;
      translations.set(`${dx}|${dy}`, { dx, dy });
    }
  }

  const accepted = new Map<string, { dx: number; dy: number; path: number[] }>();
  let ambiguousMapping = false;
  for (const translation of translations.values()) {
    const matches = quadRects.map((quad) => rangeFragments.map((fragment) =>
      exactTranslatedMatch(fragment.neutralRangeRect, quad, translation.dx, translation.dy)));
    const mapped = mappingCount(matches, 0, 0, new Map());
    if (mapped.count > 1) ambiguousMapping = true;
    if (mapped.count !== 1 || mapped.path == null) continue;
    const signature = mapped.path.join(",");
    accepted.set(`${translation.dx}|${translation.dy}|${signature}`, {
      ...translation,
      path: mapped.path,
    });
  }
  if (accepted.size !== 1) {
    return {
      fragments: null,
      failureReason: accepted.size === 0 && !ambiguousMapping
        ? "ordered Range FragmentItems do not exactly join protocol quads"
        : "ordered Range FragmentItem/protocol quad join is ambiguous",
    };
  }

  const match = accepted.values().next().value as { dx: number; dy: number; path: number[] };
  const quadByRange = new Map(match.path.map((rangeIndex, quadIndex) => [rangeIndex, quadIndex]));
  return {
    fragments: rangeFragments.map((fragment, rangeIndex) => ({
      ...fragment,
      sourceTextNodeIndex,
      neutralRangeRect: {
        x: fragment.neutralRangeRect.x + match.dx,
        y: fragment.neutralRangeRect.y + match.dy,
        width: fragment.neutralRangeRect.width,
        height: fragment.neutralRangeRect.height,
      },
      cdpQuadIndex: quadByRange.get(rangeIndex),
    })),
  };
}

function spansIntersect(left: CapturedDomUtf16Span, right: CapturedDomUtf16Span): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

function spanContains(outer: CapturedDomUtf16Span, inner: CapturedDomUtf16Span): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

function sliceIndexedArray<T>(
  values: readonly T[] | undefined,
  textLength: number,
  start: number,
  end: number,
): T[] | undefined | null {
  if (values == null) return undefined;
  if (start === 0 && end === textLength) return [...values];
  if (values.length !== textLength) return null;
  return values.slice(start, end);
}

function sliceSegment(
  segment: TextSegment,
  renderedStart: number,
  renderedEnd: number,
  fragment: JoinedTextSourceFragment,
  role: "ordinary" | "first-letter",
): { segment: TextSegment | null; failureReason?: string } {
  const mapping = segment.sourceMapping!;
  const partial = renderedStart !== 0 || renderedEnd !== segment.text.length;
  if (partial && (segment.rasterRect != null || segment.rasterDataUri != null
    || segment.colorGlyphIdentities != null)) {
    return { segment: null, failureReason: "segment-level raster/color-glyph ownership crosses a FragmentItem boundary" };
  }
  const indexedKeys = [
    "xOffsets",
    "xAdvances",
    "yOffsets",
    "verticalOrientations",
    "verticalAdvances",
    "verticalNaturalWidths",
  ] as const;
  const indexed: Partial<TextSegment> = {};
  for (const key of indexedKeys) {
    const sliced = sliceIndexedArray(segment[key] as readonly unknown[] | undefined,
      segment.text.length, renderedStart, renderedEnd);
    if (sliced === null) {
      return { segment: null, failureReason: `${key} is not UTF-16 aligned at the FragmentItem boundary` };
    }
    (indexed as Record<string, unknown>)[key] = sliced;
  }

  let combineOffsets = sliceIndexedArray(segment.verticalCombineXOffsets,
    segment.text.length, renderedStart, renderedEnd);
  if (combineOffsets === null) {
    return { segment: null, failureReason: "vertical combine offsets are not UTF-16 aligned at the FragmentItem boundary" };
  }
  if (combineOffsets != null && role === "ordinary") {
    const delta = segment.x - fragment.neutralRangeRect.x;
    combineOffsets = combineOffsets.map((value) => value + delta);
  }

  const rasterGlyphs: NonNullable<TextSegment["rasterGlyphs"]> = [];
  for (const glyph of segment.rasterGlyphs ?? []) {
    const glyphStart = glyph.charIndex;
    const glyphEnd = glyphStart + (glyph.charLength ?? ((segment.text.codePointAt(glyphStart) ?? 0) > 0xFFFF ? 2 : 1));
    if (glyphEnd <= renderedStart || glyphStart >= renderedEnd) continue;
    if (glyphStart < renderedStart || glyphEnd > renderedEnd) {
      return { segment: null, failureReason: "raster glyph cluster crosses a FragmentItem boundary" };
    }
    rasterGlyphs.push({
      ...glyph,
      charIndex: glyphStart - renderedStart,
      rect: { ...glyph.rect },
    });
  }

  const selectedChunks = mapping.renderedChunks
    .filter((chunk) => chunk.renderedUtf16Span[0] >= renderedStart
      && chunk.renderedUtf16Span[1] <= renderedEnd)
    .map((chunk) => ({
      renderedUtf16Span: [
        chunk.renderedUtf16Span[0] - renderedStart,
        chunk.renderedUtf16Span[1] - renderedStart,
      ] as CapturedDomUtf16Span,
      domUtf16Span: [...chunk.domUtf16Span] as CapturedDomUtf16Span,
    }));
  const next: TextSegment = {
    ...segment,
    ...indexed,
    text: segment.text.slice(renderedStart, renderedEnd),
    sourceText: mapping.domText.slice(fragment.domUtf16Span[0], fragment.domUtf16Span[1]),
    sourceMapping: {
      ...mapping,
      domUtf16Span: [...fragment.domUtf16Span],
      renderedChunks: selectedChunks,
      role,
    },
    verticalCombineXOffsets: combineOffsets,
    rasterGlyphs: rasterGlyphs.length > 0 ? rasterGlyphs : undefined,
    dottedCircleMarks: segment.dottedCircleMarks
      ?.filter((index) => index >= renderedStart && index < renderedEnd)
      .map((index) => index - renderedStart),
  };
  if (role === "ordinary") {
    next.x = fragment.neutralRangeRect.x;
    next.y = fragment.neutralRangeRect.y;
    next.width = fragment.neutralRangeRect.width;
    next.height = fragment.neutralRangeRect.height;
    // Recompute from the exact fragment and node direction in the affine
    // builder; retaining the pre-split RTL/end coordinate would be wrong.
    next.inlineOffset = undefined;
  }
  if (next.xAdvances != null) next.shapedWidth = next.xAdvances.reduce((sum, value) => sum + value, 0);
  else if (next.verticalAdvances != null) next.shapedWidth = next.verticalAdvances.reduce((sum, value) => sum + value, 0);
  return { segment: next };
}

function validateMapping(segment: TextSegment): string | undefined {
  const mapping = segment.sourceMapping;
  if (mapping == null) return undefined;
  if (mapping.source !== "dom-text-utf16-v1"
    || !Number.isInteger(mapping.sourceTextNodeIndex) || mapping.sourceTextNodeIndex < 0
    || mapping.renderedChunks.length === 0) return "text segment source mapping is invalid";
  let renderedOffset = 0;
  let minimumSource = Infinity;
  let maximumSource = -Infinity;
  for (const chunk of mapping.renderedChunks) {
    const [renderedStart, renderedEnd] = chunk.renderedUtf16Span;
    const [sourceStart, sourceEnd] = chunk.domUtf16Span;
    if (renderedStart !== renderedOffset || renderedEnd <= renderedStart
      || sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd > mapping.domText.length) {
      return "text segment source chunks are not exact contiguous rendered UTF-16 ranges";
    }
    renderedOffset = renderedEnd;
    minimumSource = Math.min(minimumSource, sourceStart);
    maximumSource = Math.max(maximumSource, sourceEnd);
  }
  if (renderedOffset !== segment.text.length
    || mapping.domUtf16Span[0] !== minimumSource
    || mapping.domUtf16Span[1] !== maximumSource) {
    return "text segment source mapping does not cover its rendered/source envelope";
  }
  return undefined;
}

/** Split every source-mapped segment exactly once per joined FragmentItem. */
export function splitTextSegmentsOnFragmentSpans(
  segments: readonly TextSegment[],
  joinedFragments: readonly JoinedTextSourceFragment[],
): FragmentSplitResult {
  const finalSources: CapturedTextFragmentSourceSpan[] = joinedFragments.map((fragment) => ({
    source: "blink-range-fragment-utf16-v1",
    sourceTextNodeIndex: fragment.sourceTextNodeIndex,
    physicalFragmentIndex: fragment.physicalFragmentIndex,
    domUtf16Span: [...fragment.domUtf16Span],
    neutralRangeRect: { ...fragment.neutralRangeRect },
    cdpQuadIndex: fragment.cdpQuadIndex,
    role: fragment.cdpQuadIndex == null ? "first-letter" : "ordinary",
    provenance: { ...SOURCE_PROVENANCE },
  }));
  const textSegmentIndexBySourceFragment: Array<number | null> = finalSources.map(() => null);
  const output: TextSegment[] = [];

  for (const segment of segments) {
    const mappingFailure = validateMapping(segment);
    if (mappingFailure != null) {
      return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment, failureReason: mappingFailure };
    }
    const mapping = segment.sourceMapping;
    if (mapping == null) {
      output.push(segment);
      continue;
    }
    const candidates = finalSources
      .map((fragment, sourceFragmentIndex) => ({ fragment, sourceFragmentIndex }))
      .filter(({ fragment }) => fragment.sourceTextNodeIndex === mapping.sourceTextNodeIndex);
    if (candidates.length === 0) {
      return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
        failureReason: "text segment source node has no Range FragmentItems" };
    }

    const chunksByFragment = new Map<number, typeof mapping.renderedChunks>();
    for (const chunk of mapping.renderedChunks) {
      const containing = candidates.filter(({ fragment }) => spanContains(fragment.domUtf16Span, chunk.domUtf16Span));
      const intersecting = candidates.filter(({ fragment }) => spansIntersect(fragment.domUtf16Span, chunk.domUtf16Span));
      if (containing.length !== 1 || intersecting.length !== 1) {
        return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
          failureReason: "a rendered source chunk crosses or ambiguously belongs to FragmentItem spans" };
      }
      const owner = containing[0];
      if (owner.fragment.role !== mapping.role) {
        // The ordinary body duplicate under a styled ::first-letter is
        // intentionally discarded; the dedicated first-letter segment owns it.
        if (mapping.role === "ordinary" && owner.fragment.role === "first-letter") continue;
        return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
          failureReason: "styled first-letter/source FragmentItem ownership disagrees" };
      }
      const list = chunksByFragment.get(owner.sourceFragmentIndex) ?? [];
      list.push(chunk);
      chunksByFragment.set(owner.sourceFragmentIndex, list);
    }

    for (const [sourceFragmentIndex, chunks] of [...chunksByFragment].sort((left, right) =>
      left[1][0].renderedUtf16Span[0] - right[1][0].renderedUtf16Span[0])) {
      const renderedStart = chunks[0].renderedUtf16Span[0];
      const renderedEnd = chunks[chunks.length - 1].renderedUtf16Span[1];
      const selected = mapping.renderedChunks.filter((chunk) =>
        chunk.renderedUtf16Span[0] >= renderedStart && chunk.renderedUtf16Span[1] <= renderedEnd);
      if (selected.length !== chunks.length) {
        return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
          failureReason: "one FragmentItem maps to non-contiguous rendered text" };
      }
      const source = joinedFragments[sourceFragmentIndex];
      const sliced = sliceSegment(segment, renderedStart, renderedEnd, source, finalSources[sourceFragmentIndex].role);
      if (sliced.segment == null) {
        return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
          failureReason: sliced.failureReason ?? "text segment could not be split on FragmentItem span" };
      }
      if (textSegmentIndexBySourceFragment[sourceFragmentIndex] != null) {
        return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
          failureReason: "one FragmentItem maps to more than one text segment" };
      }
      textSegmentIndexBySourceFragment[sourceFragmentIndex] = output.length;
      output.push(sliced.segment);
    }
  }

  if (textSegmentIndexBySourceFragment.some((index) => index == null)) {
    return { segments: null, sourceFragments: finalSources, textSegmentIndexBySourceFragment,
      failureReason: "a Range FragmentItem has no exact text segment owner" };
  }
  return { segments: output, sourceFragments: finalSources, textSegmentIndexBySourceFragment };
}
