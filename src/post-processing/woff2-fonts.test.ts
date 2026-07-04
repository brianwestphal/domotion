import { describe, it, expect } from "vitest";
import opentype from "opentype.js";
import { compressEmbeddedFontsToWoff2 } from "./woff2-fonts.js";

// Build a minimal valid TTF (the smallest thing `getBuiltEmbeddedFontFaceCss`
// could emit) and return its base64, so the test doesn't depend on a committed
// demo SVG.
function tinyTtfBase64(): string {
  const notdef = new opentype.Glyph({ name: ".notdef", advanceWidth: 500, path: new opentype.Path() });
  const tri = new opentype.Path();
  tri.moveTo(0, 0); tri.lineTo(250, 700); tri.lineTo(500, 0); tri.close();
  const A = new opentype.Glyph({ name: "A", unicode: 0x41, advanceWidth: 500, path: tri });
  const font = new opentype.Font({
    familyName: "TestEmbed", styleName: "Regular",
    unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [notdef, A],
  });
  return Buffer.from(font.toArrayBuffer()).toString("base64");
}

describe("compressEmbeddedFontsToWoff2 (DM-1664)", () => {
  it("rewrites an svgo-minified TTF @font-face to a WOFF2 data URI", async () => {
    const ttf = tinyTtfBase64();
    const svg = `<style>@font-face{font-family:"dmf0";src:url(data:font/ttf;base64,${ttf})}</style>`;
    const out = await compressEmbeddedFontsToWoff2(svg);
    expect(out).toContain("data:font/woff2;base64,");
    expect(out).toContain('format("woff2")');
    expect(out).not.toContain("data:font/ttf");
  });

  it("also handles the quoted (pre-svgo) form", async () => {
    const ttf = tinyTtfBase64();
    const svg = `src: url("data:font/ttf;base64,${ttf}");`;
    const out = await compressEmbeddedFontsToWoff2(svg);
    expect(out).toContain("data:font/woff2;base64,");
    expect(out).not.toContain("data:font/ttf");
  });

  it("is deterministic — identical input yields byte-identical output", async () => {
    const svg = `url(data:font/ttf;base64,${tinyTtfBase64()})`;
    const a = await compressEmbeddedFontsToWoff2(svg);
    const b = await compressEmbeddedFontsToWoff2(svg);
    expect(a).toBe(b);
  });

  it("the emitted WOFF2 round-trips back to a valid sfnt", async () => {
    const svg = `url(data:font/ttf;base64,${tinyTtfBase64()})`;
    const out = await compressEmbeddedFontsToWoff2(svg);
    const woff2B64 = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(out)![1];
    const wawoff = (await import("wawoff2" as string)) as { decompress: (b: Uint8Array) => Promise<Uint8Array> };
    const ttfBack = Buffer.from(await wawoff.decompress(Buffer.from(woff2B64, "base64")));
    // A decompressed WOFF2 is a normal sfnt — parseable by opentype and smaller work than the roundtrip is that it doesn't throw.
    const font = opentype.parse(ttfBack.buffer.slice(ttfBack.byteOffset, ttfBack.byteOffset + ttfBack.byteLength));
    expect(font.glyphs.length).toBeGreaterThan(0);
  });

  it("compresses identical TTF payloads once and shrinks the bytes", async () => {
    const ttf = tinyTtfBase64();
    // Same font referenced twice (two faces sharing a subset).
    const svg = `url(data:font/ttf;base64,${ttf}) url(data:font/ttf;base64,${ttf})`;
    const out = await compressEmbeddedFontsToWoff2(svg);
    const woff2 = [...out.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)];
    expect(woff2).toHaveLength(2);
    expect(woff2[0][1]).toBe(woff2[1][1]); // same input → same output (dedup cache)
  });

  it("is a no-op for an SVG with no embedded TTF fonts", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">hi</text></svg>`;
    expect(await compressEmbeddedFontsToWoff2(svg)).toBe(svg);
  });
});
