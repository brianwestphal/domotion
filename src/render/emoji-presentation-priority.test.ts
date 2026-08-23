import { describe, expect, it } from "vitest";

import {
  applyFontVariantEmojiToPriority,
  sourcePriorityItems,
} from "./emoji-presentation-priority.js";
import { bidiLevelsFor, needsSegmentation, segmentForShaping } from "./script-segmentation.js";

const FIXTURE = "Status: done ✓ and flagged ✗ with emphasis ❗ nearby.";

describe("Blink SymbolsIterator shaping-item ownership", () => {
  it("intersects the exact failing source ranges with one inherited Latin script run", () => {
    expect(segmentForShaping(FIXTURE, bidiLevelsFor(FIXTURE))).toEqual([
      { start: 0, end: 43, script: "Latin", rtl: false, sourcePriority: "text" },
      { start: 43, end: 44, script: "Latin", rtl: false, sourcePriority: "emoji" },
      { start: 44, end: 52, script: "Latin", rtl: false, sourcePriority: "text" },
    ]);
  });

  it("preserves script state across priority boundaries before intersecting bidi", () => {
    expect(segmentForShaping("A❗B")).toEqual([
      { start: 0, end: 1, script: "Latin", rtl: false, sourcePriority: "text" },
      { start: 1, end: 2, script: "Latin", rtl: false, sourcePriority: "emoji" },
      { start: 2, end: 3, script: "Latin", rtl: false, sourcePriority: "text" },
    ]);

    const mixed = "A❗مرحبا";
    expect(segmentForShaping(mixed, bidiLevelsFor(mixed))).toEqual([
      { start: 0, end: 1, script: "Latin", rtl: false, sourcePriority: "text" },
      { start: 1, end: 2, script: "Latin", rtl: false, sourcePriority: "emoji" },
      { start: 2, end: 7, script: "Arabic", rtl: true, sourcePriority: "text" },
    ]);
  });

  it("keeps astral source boundaries on UTF-16 codepoint edges", () => {
    expect(segmentForShaping("A😀B")).toEqual([
      { start: 0, end: 1, script: "Latin", rtl: false, sourcePriority: "text" },
      { start: 1, end: 3, script: "Latin", rtl: false, sourcePriority: "emoji" },
      { start: 3, end: 4, script: "Latin", rtl: false, sourcePriority: "text" },
    ]);
  });

  it("coalesces adjacent equal source states and preserves all four priorities", () => {
    expect(sourcePriorityItems("⌚⌛")).toEqual([
      { start: 0, end: 2, text: "⌚⌛", priority: "emoji" },
    ]);
    expect(sourcePriorityItems("☃︎☔️")).toEqual([
      { start: 0, end: 2, text: "☃︎", priority: "text-vs" },
      { start: 2, end: 4, text: "☔️", priority: "emoji-vs" },
    ]);
    expect(sourcePriorityItems("A\ufe0f")).toEqual([
      { start: 0, end: 2, text: "A\ufe0f", priority: "text" },
    ]);
  });

  it("applies CSS after source segmentation and never overrides selector states", () => {
    expect(applyFontVariantEmojiToPriority("text", "emoji")).toBe("emoji");
    expect(applyFontVariantEmojiToPriority("emoji", "text")).toBe("text");
    expect(applyFontVariantEmojiToPriority("text-vs", "emoji")).toBe("text-vs");
    expect(applyFontVariantEmojiToPriority("emoji-vs", "text")).toBe("emoji-vs");

    // Source ranges are independent of CSS and therefore remain three items
    // even when an override makes every effective priority equal.
    expect(sourcePriorityItems("A❗B")).toHaveLength(3);
  });

  it("makes source-priority transitions visible to the segmentation fast path", () => {
    expect(needsSegmentation("ordinary Latin")).toBe(false);
    expect(needsSegmentation("A❗B")).toBe(true);
  });
});
