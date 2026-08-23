import { describe, expect, it } from "vitest";

import {
  EMOJI_OWNERSHIP_FIXTURE,
  EMOJI_OWNERSHIP_HELPER_DIGESTS,
  EMOJI_OWNERSHIP_ROUTE_CASES,
  EMOJI_OWNERSHIP_SOURCE_PINS,
  buildEmojiOwnershipAudit,
  sourcePriorityItems,
  structuralOwnershipEvidence,
} from "../tools/emoji-presentation-ownership-audit.js";

describe("DM-2502 emoji presentation ownership investigation", () => {
  it("pins the exact Chromium/HarfBuzz/Skia/ICU source handoff", () => {
    expect(EMOJI_OWNERSHIP_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
      icu: "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738",
    });
    expect(EMOJI_OWNERSHIP_HELPER_DIGESTS).toEqual({
      glyph: "68546de5c29a60efbe1bdb86e61d14d9ba10f00020c5b50583f5bc336718c250",
      icuExecutable: "dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf",
      icuData: "9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe",
    });
  });

  it("derives Blink's exact source-priority items for the failing line", () => {
    expect(EMOJI_OWNERSHIP_FIXTURE).toHaveLength(52);
    expect(sourcePriorityItems(EMOJI_OWNERSHIP_FIXTURE)).toEqual([
      { start: 0, end: 43, text: "Status: done ✓ and flagged ✗ with emphasis ", priority: "text" },
      { start: 43, end: 44, text: "❗", priority: "emoji" },
      { start: 44, end: 52, text: " nearby.", priority: "text" },
    ]);
  });

  it("proves the current script-only itemizer omits both U+2757 boundaries", () => {
    const evidence = structuralOwnershipEvidence();
    expect(evidence.currentSegments).toEqual([
      { start: 0, end: 52, script: "Latin", rtl: false },
    ]);
    expect(evidence.missingSourceBoundaries).toEqual([43, 44]);
    expect(evidence.rootCausePresent).toBe(true);
  });

  it("retains source VS15/VS16 states and order/declared-family controls", () => {
    expect(sourcePriorityItems("❗\ufe0e")).toEqual([
      { start: 0, end: 2, text: "❗\ufe0e", priority: "text-vs" },
    ]);
    expect(sourcePriorityItems("❗\ufe0f")).toEqual([
      { start: 0, end: 2, text: "❗\ufe0f", priority: "emoji-vs" },
    ]);
    expect(EMOJI_OWNERSHIP_ROUTE_CASES.map((row) => row.id)).toEqual([
      "fixture-order",
      "text-before-emoji",
      "emoji-before-text",
      "explicit-vs16",
      "explicit-vs15",
      "text-negative",
      "css-text-negative",
      "declared-face-precedes-priority",
      "declared-face-css-emoji",
    ]);
  });

  it("reports the source gap without pretending a non-arm64 host is native proof", () => {
    const report = buildEmojiOwnershipAudit();
    expect(report.structural.rootCausePresent).toBe(true);
    expect(report.checks.sourceMarksU2757EmojiPresentation).toBe(true);
    if (process.platform === "linux" && process.arch === "arm64") {
      expect(report.verdict).toBe("confirmed-missing-symbols-item-boundary");
      expect(report.routes).toHaveLength(EMOJI_OWNERSHIP_ROUTE_CASES.length);
    } else {
      expect(report.verdict).toBe("source-gap-confirmed-native-inapplicable");
      expect(report.routes).toEqual([]);
    }
  });
});
