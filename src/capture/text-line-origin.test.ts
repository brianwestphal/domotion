import { describe, expect, it } from "vitest";

import {
  buildCapturedTextLineOrigin,
  capturedTextLineOriginErrors,
  mapTextLineOriginPoint,
  textLineOriginWritingModeRotation,
  type CapturedTextWritingMode,
} from "./text-line-origin.js";

const modes: CapturedTextWritingMode[] = [
  "horizontal-tb",
  "vertical-rl",
  "vertical-lr",
  "sideways-rl",
  "sideways-lr",
];

describe("Blink structured line-relative text origin", () => {
  it("keeps the rounded containing offset and fractional fragment delta independent", () => {
    const record = buildCapturedTextLineOrigin({
      fragmentLeft: 102.25,
      fragmentTop: 80.375,
      fragmentWidth: 27,
      fragmentHeight: 96,
      primaryFontAscent: 21.625,
      writingMode: "horizontal-tb",
      effectiveZoom: 1.25,
    })!;
    expect(record.roundedContainingPaintOffsetTop).toBe(80);
    expect(record.fragmentRelativeTop).toBe(0.375);
    expect(record.primaryFontIntegerAscent).toBe(22);
    expect(record.lineRelativeTextOrigin).toEqual({ lineLeft: 102.25, lineOver: 102.375 });
    expect(record.physicalBaselinePoint).toEqual({ x: 102.25, y: 102.375 });
    expect(capturedTextLineOriginErrors(record, {
      fragmentLeft: 102.25,
      fragmentTop: 80.375,
      fragmentWidth: 27,
      fragmentHeight: 96,
      writingMode: "horizontal-tb",
      effectiveZoom: 1.25,
    })).toEqual([]);
  });

  it("transcribes all five Blink writing-mode rotations", () => {
    const expected = {
      "horizontal-tb": { matrix: [1, 0, 0, 1, 0, 0], point: { x: 10.25, y: 42.375 } },
      "vertical-rl": { matrix: [0, 1, -1, 0, 70.625, 10.125], point: { x: 28.25, y: 20.375 } },
      "vertical-lr": { matrix: [0, 1, -1, 0, 70.625, 10.125], point: { x: 28.25, y: 20.375 } },
      "sideways-rl": { matrix: [0, 1, -1, 0, 70.625, 10.125], point: { x: 28.25, y: 20.375 } },
      "sideways-lr": { matrix: [0, -1, 1, 0, -10.125, 150.625], point: { x: 32.25, y: 140.375 } },
    } as const;
    for (const writingMode of modes) {
      const record = buildCapturedTextLineOrigin({
        fragmentLeft: 10.25,
        fragmentTop: 20.375,
        fragmentWidth: 40,
        fragmentHeight: 120,
        primaryFontAscent: 22,
        writingMode,
        effectiveZoom: 1,
      })!;
      expect(record.writingModeRotation).toEqual(expected[writingMode].matrix);
      expect(record.physicalBaselinePoint).toEqual(expected[writingMode].point);
      expect(mapTextLineOriginPoint(
        textLineOriginWritingModeRotation(10.25, 20.375, 40, 120, writingMode),
        { x: 10.25, y: 42.375 },
      )).toEqual(expected[writingMode].point);
    }
  });

  it("rejects wrong-plane, wrong-snap, double-zoom, and incomplete provenance mutations", () => {
    const input = {
      fragmentLeft: 102.25,
      fragmentTop: 80.375,
      fragmentWidth: 27,
      fragmentHeight: 96,
      primaryFontAscent: 22,
      writingMode: "vertical-rl" as const,
      effectiveZoom: 1.25,
    };
    const record = buildCapturedTextLineOrigin(input)!;
    const validate = () => capturedTextLineOriginErrors(record, input);
    expect(validate()).toEqual([]);

    record.writingModeRotation = [1, 0, 0, 1, 0, 0];
    expect(validate()).toContain("writing-mode rotation changed");
    record.writingModeRotation = textLineOriginWritingModeRotation(102.25, 80.375, 27, 96, "vertical-rl");

    record.fragmentRelativeTop = 0;
    expect(validate()).toContain("fragment-relative top changed");
    record.fragmentRelativeTop = 0.375;

    record.effectiveZoom *= 1.25;
    expect(validate()).toContain("effective zoom changed planes");
    record.effectiveZoom = 1.25;

    record.provenance.decomposition = "wrong" as typeof record.provenance.decomposition;
    expect(validate()).toContain("line-origin Chromium provenance changed");
  });
});
