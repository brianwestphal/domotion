import { describe, expect, it } from "vitest";
import { createEmojiDetect, scanEmojiPresentation } from "./emoji-detect.js";

function rows(text: string): Array<[string, string, boolean]> {
  return scanEmojiPresentation(text).map((span) => [
    text.slice(span.start, span.end), span.presentation, span.hasVs,
  ]);
}

describe("Blink emoji presentation scanner port", () => {
  it("distinguishes lone, paired, and trailing regional indicators", () => {
    expect(rows("🇵")).toEqual([]);
    expect(rows("🇵🇭")).toEqual([["🇵🇭", "emoji", false]]);
    expect(rows("🇵🇭🇺")).toEqual([["🇵🇭", "emoji", false]]);
    expect(rows("🇵🇭🇺🇸")).toEqual([["🇵🇭", "emoji", false], ["🇺🇸", "emoji", false]]);
  });

  it("gives VS15 priority and recognizes only the VS16 keycap grammar", () => {
    expect(rows("5︎⃣")).toEqual([["5︎⃣", "text", true]]);
    expect(rows("5️⃣")).toEqual([["5️⃣", "emoji", true]]);
    expect(rows("5⃣")).toEqual([]);
  });

  it("keeps modifier sequences and rejects a modifier alone", () => {
    expect(rows("👩🏽")).toEqual([["👩🏽", "emoji", false]]);
    expect(rows("🏽")).toEqual([]);
    expect(rows("👩")).toEqual([["👩", "emoji", false]]);
  });

  it("consumes valid ZWJ sequences as one ownership span", () => {
    expect(rows("👩🏽‍💻")).toEqual([["👩🏽‍💻", "emoji", false]]);
    // Ragel routes every ZWJ sequence through emoji_run, even when an element
    // contains VS16; it is not the WithVS priority variant.
    expect(rows("👩️‍💻")).toEqual([["👩️‍💻", "emoji", false]]);
    expect(rows("👩🏽‍A")).toEqual([["👩🏽", "emoji", false]]);
  });

  it("recognizes valid tag sequences and leaves broken tags at TAG_BASE", () => {
    const valid = "🏴\u{E0067}\u{E0062}\u{E007F}";
    const broken = "🏴\u{E0067}";
    expect(rows(valid)).toEqual([[valid, "emoji", false]]);
    expect(rows(broken)).toEqual([["🏴", "emoji", false]]);
  });

  it("lets explicit selectors win over font-variant-emoji", () => {
    const { rasterCandidates } = createEmojiDetect();
    expect(rasterCandidates("❤︎", "emoji")).toMatchObject([{ presentation: "text", hasVs: true }]);
    expect(rasterCandidates("❤️", "text")).toMatchObject([{ presentation: "emoji", hasVs: true }]);
  });

  it("applies the CSS property only to unselected Emoji-property scalars", () => {
    const { rasterCandidates } = createEmojiDetect();
    expect(rasterCandidates("☺", "emoji")).toMatchObject([{ start: 0, end: 1, presentation: "emoji" }]);
    expect(rasterCandidates("😀", "text")).toMatchObject([{ start: 0, end: 2, presentation: "text" }]);
    // Every grapheme is a temporary candidate so arbitrary color symbol
    // webfonts are discoverable; selected-face inspection later prunes this.
    expect(rasterCandidates("←", "emoji")).toMatchObject([{ start: 0, end: 1, presentation: "text" }]);
  });

  it("contains no named glyph or block exceptions", () => {
    const { rasterCandidates } = createEmojiDetect();
    for (const cp of [0x2705, 0x2728, 0x2B50, 0x303D, 0x3297, 0x1F18E, 0x1F201, 0x1F600]) {
      expect(rasterCandidates(String.fromCodePoint(cp)).length, `U+${cp.toString(16)}`).toBeGreaterThan(0);
    }
  });
});
