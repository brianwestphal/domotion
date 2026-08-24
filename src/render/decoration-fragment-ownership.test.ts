import { describe, expect, it } from "vitest";
import { buildDecorationFragmentRecords, selectDecorationFragment } from "./decoration-fragment-ownership.js";

describe("wrapped decoration fragment ownership", () => {
  const records = buildDecorationFragmentRecords([
    { text: "abc", x: 20, y: 10.25, width: 30, height: 14, baseline: 21.75 },
    { text: "אבג", x: 70, y: 10.25, width: 25, height: 14, baseline: 21.75 },
    { text: "continuation", x: 20, y: 28.5, width: 75, height: 14, baseline: 40.125 },
  ], "horizontal-tb", "ltr", 11)!;

  it("retains ordered line-local offsets, exact baselines, and phase resets", () => {
    expect(records.map(({ fragmentIndex, lineOver, baseline, continuationPhase }) =>
      ({ fragmentIndex, lineOver, baseline, continuationPhase }))).toEqual([
      { fragmentIndex: 0, lineOver: 10.25, baseline: 21.75, continuationPhase: 0 },
      { fragmentIndex: 1, lineOver: 10.25, baseline: 21.75, continuationPhase: 0 },
      { fragmentIndex: 2, lineOver: 28.5, baseline: 40.125, continuationPhase: 0 },
    ]);
    expect(records[0].usedFontAscent).toBe(11);
  });

  it("uses overlap to join bidi fragments without merging their ownership", () => {
    expect(selectDecorationFragment(records, {
      writingMode: "horizontal-tb", inlineStart: 72, inlineEnd: 90,
      lineOver: 10.25, baseline: 21.75,
    }, 14)?.fragmentIndex).toBe(1);
  });

  it("selects the continuation line rather than the nearest DOM fragment", () => {
    expect(selectDecorationFragment(records, {
      writingMode: "horizontal-tb", inlineStart: 25, inlineEnd: 80,
      lineOver: 28.5, baseline: 40.125,
    }, 14)?.fragmentIndex).toBe(2);
  });

  it("fails closed on a genuinely ambiguous duplicate", () => {
    expect(selectDecorationFragment([records[0], { ...records[0], fragmentIndex: 9 }], {
      writingMode: "horizontal-tb", inlineStart: 20, inlineEnd: 50,
      lineOver: 10.25, baseline: 21.75,
    }, 14)).toBeUndefined();
  });

  it("maps vertical fragments in line-relative axes", () => {
    const vertical = buildDecorationFragmentRecords([
      { text: "縦", x: 90.5, y: 12, width: 16, height: 48, baseline: 101.25 },
    ], "vertical-rl", "rtl", 12)!;
    expect(vertical[0]).toMatchObject({ inlineStart: 12, inlineEnd: 60, lineOver: 90.5, baseline: 101.25 });
  });
});
