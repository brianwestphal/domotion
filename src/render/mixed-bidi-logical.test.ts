import { describe, expect, it } from "vitest";
import {
  bidiLevelsFor,
  segmentForShaping,
  type BidiParagraphContext,
} from "./script-segmentation.js";

const FORWARD = "L שָׁלוֹם 123 مَرْحَبًا R";
const REVERSE = "R مَرْحَبًا 321 שָׁלוֹם L";

const rows: Array<{
  id: string;
  text: string;
  context: BidiParagraphContext;
  levels: number[];
  runs: Array<[number, number, number, string, "ltr" | "rtl"]>;
}> = [
  {
    id: "forward-ltr",
    text: FORWARD,
    context: { direction: "ltr", unicodeBidi: "normal" },
    levels: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    runs: [
      [0, 2, 0, "Latin", "ltr"],
      [2, 10, 1, "Hebrew", "rtl"],
      [10, 13, 2, "Common", "ltr"],
      [13, 23, 1, "Arabic", "rtl"],
      [23, 25, 0, "Latin", "ltr"],
    ],
  },
  {
    id: "forward-rtl",
    text: FORWARD,
    context: { direction: "rtl", unicodeBidi: "normal" },
    levels: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    runs: [
      [0, 1, 2, "Latin", "ltr"],
      [1, 10, 1, "Hebrew", "rtl"],
      [10, 13, 2, "Common", "ltr"],
      [13, 24, 1, "Arabic", "rtl"],
      [24, 25, 2, "Latin", "ltr"],
    ],
  },
  {
    id: "reverse-ltr",
    text: REVERSE,
    context: { direction: "ltr", unicodeBidi: "normal" },
    levels: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    runs: [
      [0, 2, 0, "Latin", "ltr"],
      [2, 12, 1, "Arabic", "rtl"],
      [12, 15, 2, "Common", "ltr"],
      [15, 23, 1, "Hebrew", "rtl"],
      [23, 25, 0, "Latin", "ltr"],
    ],
  },
  {
    id: "reverse-rtl",
    text: REVERSE,
    context: { direction: "rtl", unicodeBidi: "normal" },
    levels: [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
    runs: [
      [0, 1, 2, "Latin", "ltr"],
      [1, 12, 1, "Arabic", "rtl"],
      [12, 15, 2, "Common", "ltr"],
      [15, 24, 1, "Hebrew", "rtl"],
      [24, 25, 2, "Latin", "ltr"],
    ],
  },
];

describe("mixed-script paragraph bidi ownership (DM-2524)", () => {
  it.each(rows)("pins exact UAX #9 levels and Blink item records for $id", (row) => {
    const levels = [...bidiLevelsFor(row.text, row.context)!];
    expect(levels).toEqual(row.levels);
    expect(segmentForShaping(row.text, levels).map((segment) => [
      segment.start,
      segment.end,
      levels[segment.start],
      segment.script,
      segment.rtl ? "rtl" : "ltr",
    ])).toEqual(row.runs);
  });

  it.each(rows)("keeps the opposite-base wrong-level mutation active for $id", (row) => {
    const mutated = bidiLevelsFor(row.text, {
      direction: row.context.direction === "ltr" ? "rtl" : "ltr",
      unicodeBidi: row.context.unicodeBidi,
    });
    expect([...mutated!]).not.toEqual(row.levels);
  });

  it("uses first-strong auto for unicode-bidi: plaintext instead of CSS direction", () => {
    const text = "אב L";
    expect([...bidiLevelsFor(text, { direction: "ltr", unicodeBidi: "normal" })!])
      .toEqual([1, 1, 0, 0]);
    expect([...bidiLevelsFor(text, { direction: "ltr", unicodeBidi: "plaintext" })!])
      .toEqual([1, 1, 1, 2]);
  });

  it("retains exact level 2 for Latin embedded in an ordinary RTL paragraph", () => {
    expect([...bidiLevelsFor("Latin", { direction: "rtl", unicodeBidi: "normal" })!])
      .toEqual([2, 2, 2, 2, 2]);
  });
});
