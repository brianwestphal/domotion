import { describe, expect, it } from "vitest";
import { parseUnicodeRangeDescriptor } from "./capture/index.js";

// DM-517: webfont registration honors the `@font-face { unicode-range: ... }`
// descriptor. This file covers the capture-side descriptor parser; how the
// engine's webfont registry honors the parsed ranges (variant preference,
// per-codepoint partition routing, local-alias scoring) is tested in
// packages/text-engine/src/render/webfont-unicode-range.test.ts.

describe("parseUnicodeRangeDescriptor", () => {
  it("returns undefined for empty / whitespace input", () => {
    expect(parseUnicodeRangeDescriptor("")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("   ")).toBeUndefined();
  });

  it("parses single codepoints (U+26)", () => {
    expect(parseUnicodeRangeDescriptor("U+26")).toEqual([[0x26, 0x26]]);
  });

  it("parses interval forms (U+0-7F)", () => {
    expect(parseUnicodeRangeDescriptor("U+0-7F")).toEqual([[0x0, 0x7f]]);
    expect(parseUnicodeRangeDescriptor("U+0000-00FF")).toEqual([[0x0, 0xff]]);
  });

  it("parses wildcard forms (U+4??)", () => {
    expect(parseUnicodeRangeDescriptor("U+4??")).toEqual([[0x400, 0x4ff]]);
    expect(parseUnicodeRangeDescriptor("U+1F??")).toEqual([[0x1f00, 0x1fff]]);
  });

  it("parses comma-separated mixed forms (real Google Fonts Cyrillic partition)", () => {
    const ranges = parseUnicodeRangeDescriptor("U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116");
    expect(ranges).toEqual([
      [0x0301, 0x0301],
      [0x0400, 0x045f],
      [0x0490, 0x0491],
      [0x04b0, 0x04b1],
      [0x2116, 0x2116],
    ]);
  });

  it("is case-insensitive on the U+ prefix", () => {
    expect(parseUnicodeRangeDescriptor("u+0-7f")).toEqual([[0x0, 0x7f]]);
  });
});
