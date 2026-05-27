import { describe, expect, it, beforeEach } from "vitest";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";

// A small deterministic glyph outline (a triangle) to register.
const TRI = [
  { command: "moveTo" as const, args: [100, 0] },
  { command: "lineTo" as const, args: [500, 0] },
  { command: "lineTo" as const, args: [300, 700] },
  { command: "closePath" as const, args: [] },
];

function buildOnceCss(): string {
  clearEmbeddedFontBuilder();
  trackGlyphInEmbedFont("det-test|w=400|s=0", 1000, 800, -200, 42, TRI, 600);
  return getBuiltEmbeddedFontFaceCss();
}

/** Extract + base64-decode the first embedded font from the @font-face CSS. */
function decodeFirstFont(css: string): Buffer {
  const m = /data:font\/ttf;base64,([A-Za-z0-9+/=]+)/.exec(css);
  if (m == null) throw new Error("no embedded font data: URI found");
  return Buffer.from(m[1], "base64");
}

describe("embedded-font-builder determinism (DM-902)", () => {
  beforeEach(() => clearEmbeddedFontBuilder());

  it("produces byte-identical @font-face output across builds of the same glyphs", () => {
    // Without the head-timestamp strip, opentype.js stamps the build time into
    // head.created/modified (+ checksums), so two builds of identical glyphs
    // differ — which broke the animate golden suite and reproducible builds.
    const a = buildOnceCss();
    const b = buildOnceCss();
    expect(a).toBe(b);
    expect(a).toContain("data:font/ttf;base64,");
  });

  it("zeroes the head table's created/modified timestamps and checkSumAdjustment", () => {
    const bytes = decodeFirstFont(buildOnceCss());
    // Walk the sfnt table directory to the `head` record.
    const numTables = bytes.readUInt16BE(4);
    let headOff = -1;
    let dirChecksum = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (bytes.toString("ascii", rec, rec + 4) === "head") {
        dirChecksum = bytes.readUInt32BE(rec + 4);
        headOff = bytes.readUInt32BE(rec + 8);
        break;
      }
    }
    expect(headOff).toBeGreaterThan(0);
    expect(dirChecksum).toBe(0);                       // directory per-table head checksum
    expect(bytes.readUInt32BE(headOff + 8)).toBe(0);   // checkSumAdjustment
    // created (8 bytes @ +20) and modified (8 bytes @ +28) all zero.
    for (let o = headOff + 20; o < headOff + 36; o++) expect(bytes[o]).toBe(0);
  });
});
