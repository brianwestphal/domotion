import { describe, expect, it } from "vitest";

import {
  blinkUsesTextCombine,
  blinkVerticalOrientationRuns,
  isMixedVerticalUpright,
  resolveVerticalOrientations,
} from "./vertical-orientation.js";

const oldHandwrittenUpright = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x11ff)
  || (cp >= 0x2e80 && cp <= 0xa4cf)
  || (cp >= 0xac00 && cp <= 0xd7af)
  || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xfe10 && cp <= 0xfe6f)
  || (cp >= 0xff01 && cp <= 0xff60)
  || (cp >= 0x1f200 && cp <= 0x1f2ff)
  || cp >= 0x20000;

function perScalarMutation(text: string): Array<"upright" | "rotated"> {
  const result: Array<"upright" | "rotated"> = [];
  for (const scalar of text) {
    const orientation = isMixedVerticalUpright(scalar.codePointAt(0)) ? "upright" : "rotated";
    result.push(...new Array(scalar.length).fill(orientation));
  }
  return result;
}

describe("Blink vertical orientation ownership (DM-2525)", () => {
  it("transcribes OrientationIterator runs at UTF-16 boundaries", () => {
    expect(blinkVerticalOrientationRuns("A漢🂡", "mixed")).toEqual([
      { start: 0, end: 1, orientation: "rotated" },
      { start: 1, end: 4, orientation: "upright" },
    ]);
    expect(blinkVerticalOrientationRuns("A\u20dd", "mixed")).toEqual([
      { start: 0, end: 2, orientation: "rotated" },
    ]);
    expect(blinkVerticalOrientationRuns("漢\u{e0101}", "mixed")).toEqual([
      { start: 0, end: 3, orientation: "upright" },
    ]);
    expect(blinkVerticalOrientationRuns("\u20dd\u0300ABC\u20dd", "mixed")).toEqual([
      { start: 0, end: 2, orientation: "upright" },
      { start: 2, end: 6, orientation: "rotated" },
    ]);
  });

  it("keeps source properties distinct from Grapheme_Extend inheritance", () => {
    // U+20DD is source-upright but inherits a preceding Latin base's rotation.
    expect(isMixedVerticalUpright(0x20dd)).toBe(true);
    expect(resolveVerticalOrientations("A\u20dd", "mixed")).toEqual(["rotated", "rotated"]);
    // Supplementary IVS U+E0101 is source-rotated but inherits its Han base.
    expect(isMixedVerticalUpright(0xe0101)).toBe(false);
    expect(resolveVerticalOrientations("漢\u{e0101}", "mixed"))
      .toEqual(["upright", "upright", "upright"]);
    // A leading extender establishes its own orientation, exactly as Blink's
    // iterator does before any base exists.
    expect(resolveVerticalOrientations("\u20ddA", "mixed")).toEqual(["upright", "rotated"]);
  });

  it("routes explicit upright and sideways without consulting Unicode", () => {
    const text = "A漢\u{e0101}\u20dd🂡";
    expect(blinkVerticalOrientationRuns(text, "upright")).toEqual([
      { start: 0, end: text.length, orientation: "upright" },
    ]);
    expect(blinkVerticalOrientationRuns(text, "sideways")).toEqual([
      { start: 0, end: text.length, orientation: "rotated" },
    ]);
  });

  it("substitutes U+FFFD for unpaired UTF-16 surrogates like Blink", () => {
    expect(blinkVerticalOrientationRuns("\ud800A\udc00", "mixed")).toEqual([
      { start: 0, end: 1, orientation: "upright" },
      { start: 1, end: 2, orientation: "rotated" },
      { start: 2, end: 3, orientation: "upright" },
    ]);
  });

  it("ports LayoutTextCombine::IsSupportedMode across every writing mode", () => {
    expect(Object.fromEntries([
      "horizontal-tb", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr",
    ].map((writingMode) => [writingMode, blinkUsesTextCombine(writingMode, "all")]))).toEqual({
      "horizontal-tb": false,
      "vertical-rl": true,
      "vertical-lr": true,
      "sideways-rl": false,
      "sideways-lr": false,
    });
    expect(blinkUsesTextCombine("vertical-rl", "none")).toBe(false);
  });

  it("keeps all three required negative mutations active", () => {
    // The retired pseudo range omitted U/Tu/Tr source categories outside its
    // broad CJK blocks.
    for (const cp of [0x00a7, 0x2018, 0x1f0a1]) {
      expect(oldHandwrittenUpright(cp)).not.toBe(isMixedVerticalUpright(cp));
    }
    // Per-scalar classification breaks both directions of extend ownership.
    expect(perScalarMutation("A\u20dd")).not.toEqual(resolveVerticalOrientations("A\u20dd", "mixed"));
    expect(perScalarMutation("漢\u{e0101}"))
      .not.toEqual(resolveVerticalOrientations("漢\u{e0101}", "mixed"));
    // Treating sideways as vertical typographic wrongly activates combine.
    expect(true).not.toBe(blinkUsesTextCombine("sideways-rl", "all"));
  });
});
