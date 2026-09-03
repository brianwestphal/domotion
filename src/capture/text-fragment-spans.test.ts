import { describe, expect, it } from "vitest";
import type { CapturedTextPaintQuad, TextSegment } from "./types.js";
import {
  joinBlinkRangeFragmentsToContentQuads,
  splitTextSegmentsOnFragmentSpans,
  type BlinkRangeFragmentProbe,
} from "./text-fragment-spans.js";

const quad = (x: number, y: number, width: number, height: number): CapturedTextPaintQuad =>
  [x, y, x + width, y, x + width, y + height, x, y + height];

const range = (
  physicalFragmentIndex: number,
  domUtf16Span: [number, number],
  x: number,
  y: number,
  width: number,
  height = 20,
): BlinkRangeFragmentProbe => ({
  physicalFragmentIndex,
  domUtf16Span,
  neutralRangeRect: { x, y, width, height },
});

function mappedSegment(
  text: string,
  domText: string,
  sourceStart: number,
  x = 10,
  role: "ordinary" | "first-letter" = "ordinary",
): TextSegment {
  return {
    text,
    sourceText: domText.slice(sourceStart, sourceStart + text.length),
    sourceMapping: {
      source: "dom-text-utf16-v1",
      sourceTextNodeIndex: 0,
      domText,
      domUtf16Span: [sourceStart, sourceStart + text.length],
      renderedChunks: Array.from({ length: text.length }, (_, index) => ({
        renderedUtf16Span: [index, index + 1],
        domUtf16Span: [sourceStart + index, sourceStart + index + 1],
      })),
      role,
    },
    x,
    y: 10,
    width: text.length * 10,
    height: 20,
    xOffsets: Array.from({ length: text.length }, (_, index) => x + index * 10),
    xAdvances: Array.from({ length: text.length }, () => 10),
    dottedCircleMarks: text.length > 3 ? [3] : undefined,
  };
}

describe("ordered Blink Range FragmentItem join", () => {
  it("joins an exact child-frame translation and retains an unmatched first-letter item", () => {
    const joined = joinBlinkRangeFragmentsToContentQuads(4, [
      range(0, [0, 2], 5, 6, 24, 31),
      range(1, [2, 7], 29, 15, 50),
      range(2, [7, 13], 79, 15, 60),
    ], [
      quad(129, 215, 50, 20),
      quad(179, 215, 60, 20),
    ]);
    expect(joined.failureReason).toBeUndefined();
    expect(joined.fragments).toEqual([
      expect.objectContaining({ physicalFragmentIndex: 0, domUtf16Span: [0, 2], cdpQuadIndex: undefined,
        neutralRangeRect: { x: 105, y: 206, width: 24, height: 31 } }),
      expect.objectContaining({ physicalFragmentIndex: 1, domUtf16Span: [2, 7], cdpQuadIndex: 0,
        neutralRangeRect: { x: 129, y: 215, width: 50, height: 20 } }),
      expect.objectContaining({ physicalFragmentIndex: 2, domUtf16Span: [7, 13], cdpQuadIndex: 1,
        neutralRangeRect: { x: 179, y: 215, width: 60, height: 20 } }),
    ]);
  });

  it("rejects collapsed, reordered, and indistinguishable joins", () => {
    const fragments = [range(0, [0, 3], 10, 10, 30), range(1, [3, 6], 40, 10, 30)];
    expect(joinBlinkRangeFragmentsToContentQuads(0, fragments.slice(0, 1), [
      quad(10, 10, 30, 20), quad(40, 10, 30, 20),
    ]).failureReason).toContain("cardinality");
    expect(joinBlinkRangeFragmentsToContentQuads(0, fragments, [
      quad(40, 10, 30, 20), quad(10, 10, 30, 20),
    ]).failureReason).toContain("do not exactly join");
    expect(joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [0, 1], 10, 10, 30), range(1, [1, 2], 10, 10, 30),
    ], [quad(10, 10, 30, 20)]).failureReason).toContain("ambiguous");
  });
});

describe("UTF-16 FragmentItem segment splitting", () => {
  it("splits one mixed-script segment before correlation and rebases shaped/raster indices", () => {
    const domText = "Lat·عر·漢字";
    const segment = mappedSegment(domText, domText, 0);
    segment.rasterGlyphs = [{ charIndex: 7, charLength: 2,
      rect: { x: 80, y: 10, width: 20, height: 20 }, suppressGlyph: true }];
    const joined = joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [0, 4], 10, 10, 40),
      range(1, [4, 7], 50, 10, 30),
      range(2, [7, 9], 80, 10, 20),
    ], [quad(10, 10, 40, 20), quad(50, 10, 30, 20), quad(80, 10, 20, 20)]).fragments!;
    const split = splitTextSegmentsOnFragmentSpans([segment], joined);
    expect(split.failureReason).toBeUndefined();
    expect(split.segments?.map((item) => ({
      text: item.text,
      span: item.sourceMapping?.domUtf16Span,
      xOffsets: item.xOffsets,
      xAdvances: item.xAdvances,
      dotted: item.dottedCircleMarks,
      raster: item.rasterGlyphs?.map((glyph) => [glyph.charIndex, glyph.charLength]),
    }))).toEqual([
      { text: "Lat·", span: [0, 4], xOffsets: [10, 20, 30, 40], xAdvances: [10, 10, 10, 10], dotted: [3], raster: undefined },
      { text: "عر·", span: [4, 7], xOffsets: [50, 60, 70], xAdvances: [10, 10, 10], dotted: [], raster: undefined },
      { text: "漢字", span: [7, 9], xOffsets: [80, 90], xAdvances: [10, 10], dotted: [], raster: [[0, 2]] },
    ]);
    expect(split.sourceFragments.map((item) => item.domUtf16Span)).toEqual([[0, 4], [4, 7], [7, 9]]);
    expect(split.textSegmentIndexBySourceFragment).toEqual([0, 1, 2]);
  });

  it("keeps a dedicated first-letter and removes its suppressed body duplicate", () => {
    const domText = "“Alpha";
    const firstLetter = mappedSegment("“A", domText, 0, 10, "first-letter");
    const body = mappedSegment(domText, domText, 0, 10);
    const joined = joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [0, 2], 10, 2, 25, 32),
      range(1, [2, 6], 35, 10, 40),
    ], [quad(35, 10, 40, 20)]).fragments!;
    const split = splitTextSegmentsOnFragmentSpans([firstLetter, body], joined);
    expect(split.failureReason).toBeUndefined();
    expect(split.segments?.map((segment) => [segment.text, segment.sourceMapping?.role,
      segment.sourceMapping?.domUtf16Span])).toEqual([
      ["“A", "first-letter", [0, 2]],
      ["lpha", "ordinary", [2, 6]],
    ]);
    expect(split.sourceFragments.map((fragment) => [fragment.role, fragment.cdpQuadIndex])).toEqual([
      ["first-letter", undefined], ["ordinary", 0],
    ]);
  });

  it("preserves a length-changing transform chunk and rejects a wrong span split", () => {
    const transformed = mappedSegment("SSa", "ßa", 0);
    transformed.sourceMapping!.domUtf16Span = [0, 2];
    transformed.sourceMapping!.renderedChunks = [
      { renderedUtf16Span: [0, 2], domUtf16Span: [0, 1] },
      { renderedUtf16Span: [2, 3], domUtf16Span: [1, 2] },
    ];
    const correct = joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [0, 1], 10, 10, 20), range(1, [1, 2], 30, 10, 10),
    ], [quad(10, 10, 20, 20), quad(30, 10, 10, 20)]).fragments!;
    expect(splitTextSegmentsOnFragmentSpans([transformed], correct).segments?.map((segment) => segment.text))
      .toEqual(["SS", "a"]);

    const wrong = correct.map((fragment, index) => ({
      ...fragment,
      domUtf16Span: (index === 0 ? [0, 2] : [1, 2]) as [number, number],
    }));
    expect(splitTextSegmentsOnFragmentSpans([transformed], wrong).failureReason)
      .toContain("crosses or ambiguously belongs");
  });

  it("splits one-to-one source chunks across adjacent fallback FragmentItems", () => {
    const mixed = mappedSegment("縦書Affine", "縦書Affine", 0);
    mixed.sourceMapping!.renderedChunks = [{
      renderedUtf16Span: [0, 8],
      domUtf16Span: [0, 8],
    }];
    const joined = joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [0, 2], 10, 10, 20, 40),
      range(1, [2, 8], 10, 50, 20, 120),
    ], [
      quad(10, 10, 20, 40),
      quad(10, 50, 20, 120),
    ]).fragments!;

    const split = splitTextSegmentsOnFragmentSpans([mixed], joined);
    expect(split.failureReason).toBeUndefined();
    expect(split.segments?.map((segment) => [
      segment.text,
      segment.sourceMapping?.domUtf16Span,
      segment.sourceMapping?.renderedChunks,
    ])).toEqual([
      ["縦書", [0, 2], [{ renderedUtf16Span: [0, 2], domUtf16Span: [0, 2] }]],
      ["Affine", [2, 8], [{ renderedUtf16Span: [0, 6], domUtf16Span: [2, 8] }]],
    ]);
  });

  it("fails closed when a sole protocol fragment does not authenticate leading glyph ownership", () => {
    const mixed = mappedSegment("縦書Affine", "縦書Affine", 0);
    mixed.verticalWritingMode = "vertical-rl";
    mixed.sourceMapping!.renderedChunks = Array.from(mixed.text, (_, index) => ({
      renderedUtf16Span: [index, index + 1] as [number, number],
      domUtf16Span: [index, index + 1] as [number, number],
    }));
    const joined = joinBlinkRangeFragmentsToContentQuads(0, [
      range(0, [2, 8], 10, 10, 20, 120),
    ], [quad(10, 10, 20, 120)]).fragments!;

    const split = splitTextSegmentsOnFragmentSpans([mixed], joined);
    expect(split.segments).toBeNull();
    expect(split.failureReason).toContain("crosses or ambiguously belongs");
    expect(split.failureReason).toContain('"domUtf16Span":[2,8]');
  });
});
