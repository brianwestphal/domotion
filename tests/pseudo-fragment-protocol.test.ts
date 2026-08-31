import { describe, expect, it } from "vitest";
import {
  blinkTextPaintBaseline,
  decodePseudoFragmentProtocol,
  generatedImageIntrinsicPaintExceedsSlot,
  protocolRecordErrors,
  type PseudoProtocolInput,
  type Quad,
} from "../tools/pseudo-fragment-protocol.js";

function quad(x: number, y: number, width: number, height: number): Quad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

const edges = { top: 1, right: 1, bottom: 1, left: 1 };
const padding = { top: 2, right: 2, bottom: 2, left: 2 };
const margin = { top: 4, right: 5, bottom: 6, left: 7 };

function mixedInput(): PseudoProtocolInput {
  return {
    hostCorrelationId: "mixed",
    pseudo: "before",
    style: {
      writingMode: "horizontal-tb",
      direction: "ltr",
      boxDecorationBreak: "slice",
      border: edges,
      padding,
      margin,
      primaryFontAscent: 8,
      fontSize: 10,
      lineHeight: 24,
    },
    layoutRows: [
      { layoutIndex: 0, bounds: { x: 17, y: 17, width: 36, height: 36 }, textBoxes: [] },
      {
        layoutIndex: 1,
        bounds: { x: 20, y: 20, width: 10, height: 10 },
        text: "A ",
        textBoxes: [{ bounds: { x: 20, y: 20, width: 10, height: 10 }, startUtf16: 0, lengthUtf16: 2, shapedAdvance: 10 }],
      },
      { layoutIndex: 2, bounds: { x: 30, y: 22, width: 8, height: 6 }, textBoxes: [] },
      {
        layoutIndex: 3,
        bounds: { x: 20, y: 20, width: 30, height: 30 },
        text: "B😀 tail",
        textBoxes: [
          { bounds: { x: 38, y: 20, width: 12, height: 10 }, startUtf16: 0, lengthUtf16: 3, shapedAdvance: 12 },
          { bounds: { x: 20, y: 40, width: 20, height: 10 }, startUtf16: 4, lengthUtf16: 4, shapedAdvance: 20 },
        ],
      },
    ],
    contentQuads: [quad(17, 17, 33, 16), quad(120, 37, 23, 16)],
  };
}

describe("DM-2466 pseudo protocol decoder", () => {
  it("distinguishes generated-image intrinsic paint from its pseudo layout slot", () => {
    expect(generatedImageIntrinsicPaintExceedsSlot({
      contentBoxWidth: 24,
      contentBoxHeight: 24,
      naturalSizes: [{ width: 128, height: 128 }],
    })).toBe(true);
    expect(generatedImageIntrinsicPaintExceedsSlot({
      contentBoxWidth: 24,
      contentBoxHeight: 24,
      naturalSizes: [{ width: 24, height: 24 }],
    })).toBe(false);
    expect(generatedImageIntrinsicPaintExceedsSlot({
      contentBoxWidth: null,
      contentBoxHeight: null,
      naturalSizes: [{ width: 128, height: 128 }, null],
    })).toBe(false);
  });

  it("retains content-item boundaries, UTF-16 slices, visual order, image rows, and fragmentainer translations", () => {
    const input = mixedInput();
    const record = decodePseudoFragmentProtocol(input);
    expect(record.status).toBe("exact");
    expect(record.contentItems.map((item) => item.kind)).toEqual(["text", "image", "text"]);
    expect(record.fragments.map((fragment) => fragment.kind)).toEqual(["text", "image", "text", "text"]);
    expect(record.fragments.map((fragment) => fragment.contentItemIndex)).toEqual([0, 1, 2, 2]);
    expect(record.fragments.map((fragment) => fragment.visualOrder)).toEqual([0, 1, 2, 3]);
    const text = record.fragments.filter((fragment) => fragment.kind === "text");
    expect(text.map((fragment) => [fragment.sourceStartUtf16, fragment.sourceEndUtf16, fragment.text])).toEqual([
      [0, 2, "A "],
      [0, 3, "B😀"],
      [4, 8, "tail"],
    ]);
    expect(record.boxFragments[0].edgeOwnership).toEqual({ inlineStart: true, inlineEnd: false, blockStart: true, blockEnd: true });
    expect(record.boxFragments[1].edgeOwnership).toEqual({ inlineStart: false, inlineEnd: true, blockStart: true, blockEnd: true });
    expect(record.boxFragments[0].fragmentainerTranslation).toEqual({ x: 0, y: 0 });
    expect(record.boxFragments[1].fragmentainerTranslation).toEqual({ x: 100, y: 0 });
    expect(protocolRecordErrors(input, record)).toEqual([]);
  });

  it("keeps DOMSnapshot's visual bidi order instead of sorting UTF-16 offsets", () => {
    const input: PseudoProtocolInput = {
      ...mixedInput(),
      hostCorrelationId: "bidi",
      layoutRows: [
        { layoutIndex: 0, bounds: { x: 10, y: 10, width: 84, height: 16 }, textBoxes: [] },
        {
          layoutIndex: 1,
          bounds: { x: 13, y: 13, width: 78, height: 10 },
          text: "LTR xyz אבג",
          textBoxes: [
            { bounds: { x: 13, y: 13, width: 31, height: 10 }, startUtf16: 7, lengthUtf16: 4 },
            { bounds: { x: 44, y: 13, width: 47, height: 10 }, startUtf16: 0, lengthUtf16: 7 },
          ],
        },
      ],
      contentQuads: [quad(10, 10, 84, 16)],
    };
    const record = decodePseudoFragmentProtocol(input);
    expect(record.status).toBe("exact");
    expect(record.fragments.filter((fragment) => fragment.kind === "text").map((fragment) => fragment.sourceStartUtf16)).toEqual([7, 0]);
    expect(protocolRecordErrors(input, record)).toEqual([]);
  });

  it("transcribes TextFragmentPainter's clockwise and counter-clockwise writing transforms", () => {
    expect(blinkTextPaintBaseline({ x: 10, y: 20, width: 12, height: 40 }, "horizontal-tb", 9, 30)).toEqual({
      origin: { x: 10, y: 29 }, end: { x: 40, y: 29 },
    });
    expect(blinkTextPaintBaseline({ x: 10, y: 20, width: 12, height: 40 }, "vertical-rl", 9, 30)).toEqual({
      origin: { x: 13, y: 20 }, end: { x: 13, y: 50 },
    });
    expect(blinkTextPaintBaseline({ x: 10, y: 20, width: 12, height: 40 }, "sideways-lr", 9, 30)).toEqual({
      origin: { x: 19, y: 60 }, end: { x: 19, y: 30 },
    });
  });

  it("fails closed for unavailable, unpainted, and cardinality-ambiguous protocol rows", () => {
    expect(decodePseudoFragmentProtocol({ ...mixedInput(), protocolAvailable: false }).status).toBe("protocol-unavailable");
    expect(decodePseudoFragmentProtocol({ ...mixedInput(), layoutRows: [], contentQuads: [] }).status).toBe("unpainted");
    const ambiguous = decodePseudoFragmentProtocol({ ...mixedInput(), contentQuads: [mixedInput().contentQuads[0]] });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.fragments).toEqual([]);
  });

  it("rejects all ten forbidden structural mutations", () => {
    const input = mixedInput();
    const pristine = decodePseudoFragmentProtocol(input);
    expect(protocolRecordErrors(input, pristine)).toEqual([]);

    const mutationErrors = (mutate: (record: typeof pristine) => void) => {
      const record = structuredClone(pristine);
      mutate(record);
      return protocolRecordErrors(input, record);
    };
    const firstTextIndex = pristine.fragments.findIndex((fragment) => fragment.kind === "text");

    expect(mutationErrors((record) => {
      const fragment = record.fragments[firstTextIndex];
      if (fragment.kind === "text") fragment.baseline.origin.y = fragment.localRect.y + (24 - 10) / 2;
    })).not.toEqual([]); // font-size half-leading
    expect(mutationErrors((record) => {
      const fragment = record.fragments[firstTextIndex];
      if (fragment.kind === "text") fragment.baseline.origin.y += 7;
    })).not.toEqual([]); // host baseline copy
    expect(mutationErrors((record) => { record.fragments.splice(2, 1); })).not.toEqual([]); // fragment union
    expect(mutationErrors((record) => { [record.fragments[0], record.fragments[2]] = [record.fragments[2], record.fragments[0]]; })).not.toEqual([]); // logical reorder
    expect(mutationErrors((record) => { record.boxFragments[1].fragmentainerTranslation = { x: 0, y: 0 }; })).not.toEqual([]); // dropped fragmentainer translation
    expect(mutationErrors((record) => { record.fragments.forEach((fragment) => { fragment.contentItemIndex = 0; }); })).not.toEqual([]); // concatenated content items
    expect(mutationErrors((record) => { record.boxFragments[0].edgeOwnership.inlineEnd = true; })).not.toEqual([]); // wrong slice edges
    const verticalInput: PseudoProtocolInput = {
      ...input,
      hostCorrelationId: "vertical-mutation",
      style: { ...input.style, writingMode: "vertical-rl" },
      layoutRows: [
        { layoutIndex: 0, bounds: { x: 10, y: 10, width: 16, height: 34 }, textBoxes: [] },
        { layoutIndex: 1, bounds: { x: 13, y: 13, width: 10, height: 28 }, text: "vertical", textBoxes: [
          { bounds: { x: 13, y: 13, width: 10, height: 28 }, startUtf16: 0, lengthUtf16: 8, shapedAdvance: 28 },
        ] },
      ],
      contentQuads: [quad(10, 10, 16, 34)],
    };
    const vertical = decodePseudoFragmentProtocol(verticalInput);
    const verticalText = vertical.fragments.find((fragment) => fragment.kind === "text");
    if (verticalText?.kind === "text") verticalText.baseline.origin = { x: verticalText.localRect.x, y: verticalText.localRect.y + 8 };
    expect(protocolRecordErrors(verticalInput, vertical)).not.toEqual([]); // universal horizontal baseline
    expect(mutationErrors((record) => {
      const astral = record.fragments.find((fragment) => fragment.kind === "text" && fragment.text.includes("😀"));
      if (astral?.kind === "text") astral.sourceEndUtf16--;
    })).not.toEqual([]); // codepoint offsets
    expect(mutationErrors((record) => { record.fragments.splice(1, 1); })).not.toEqual([]); // dropped anonymous image row
  });
});
