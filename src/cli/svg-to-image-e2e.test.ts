import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChromium } from "../index.js";
import { runSvgToImage } from "./svg-to-image-core.js";

// End-to-end coverage for the svg-to-image rasterize path (Playwright
// seek + screenshot / page.pdf), complementing the pure-helper unit tests.
// Needs Chromium only (no ffmpeg), so it runs under the e2e Playwright config.

// A 200×120 static SVG with an opaque red rect — used for geometry + format checks.
const STATIC_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120" width="200" height="120">` +
  `<rect width="200" height="120" fill="#e91e63"/></svg>`;

// A transparent SVG: a small circle, no background — the page must keep its alpha.
const TRANSPARENT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">` +
  `<circle cx="50" cy="50" r="30" fill="#2196f3"/></svg>`;

// A 1s CSS-keyframe slide — seeking to different times must yield different pixels.
const ANIMATED_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">` +
  `<style>@keyframes slide { from { transform: translateX(0) } to { transform: translateX(60px) } }` +
  `.box { animation: slide 1s linear infinite }</style>` +
  `<rect class="box" x="0" y="35" width="30" height="30" fill="#e91e63"/></svg>`;

/** Read a PNG's pixel dimensions from the IHDR chunk (bytes 16–24, big-endian). */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Does this PNG carry an alpha channel? IHDR color type (byte 25): 6 = RGBA, 4 = gray+alpha. */
function pngHasAlpha(buf: Buffer): boolean {
  const colorType = buf.readUInt8(25);
  return colorType === 6 || colorType === 4;
}

describe("svg-to-image end-to-end (Chromium)", () => {
  let dir: string;
  const opts = (input: string, output: string, extra: Record<string, unknown> = {}) => ({
    input,
    output,
    quiet: true,
    log: () => {},
    launchBrowser: () => launchChromium(),
    ...extra,
  });

  function setup(): string {
    dir = mkdtempSync(path.join(tmpdir(), "svg2img-"));
    return dir;
  }

  it("renders a PNG at the SVG's intrinsic size", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.png");
    writeFileSync(input, STATIC_SVG);
    try {
      const res = await runSvgToImage(opts(input, output));
      expect(res.format).toBe("png");
      const buf = readFileSync(output);
      expect(pngSize(buf)).toEqual({ width: 200, height: 120 });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("supersamples raster output by --scale", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out@2x.png");
    writeFileSync(input, STATIC_SVG);
    try {
      await runSvgToImage(opts(input, output, { scale: 2 }));
      expect(pngSize(readFileSync(output))).toEqual({ width: 400, height: 240 });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("contains within --width, preserving aspect ratio", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.png");
    writeFileSync(input, STATIC_SVG);
    try {
      await runSvgToImage(opts(input, output, { width: 100 }));
      expect(pngSize(readFileSync(output))).toEqual({ width: 100, height: 60 });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("keeps alpha for a transparent SVG (default background)", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.png");
    writeFileSync(input, TRANSPARENT_SVG);
    try {
      await runSvgToImage(opts(input, output));
      expect(pngHasAlpha(readFileSync(output))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes a JPEG (magic bytes) when the output is .jpg", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.jpg");
    writeFileSync(input, STATIC_SVG);
    try {
      const res = await runSvgToImage(opts(input, output, { quality: 80 }));
      expect(res.format).toBe("jpeg");
      const buf = readFileSync(output);
      expect(buf.subarray(0, 3).toString("hex")).toBe("ffd8ff"); // JPEG SOI
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes a single-page PDF when the output is .pdf", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.pdf");
    writeFileSync(input, STATIC_SVG);
    try {
      const res = await runSvgToImage(opts(input, output));
      expect(res.format).toBe("pdf");
      const buf = readFileSync(output);
      expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("transcodes to WebP / AVIF / TIFF via sharp (correct magic bytes)", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    writeFileSync(input, STATIC_SVG);
    try {
      // WebP: "RIFF"...."WEBP"
      const webp = path.join(d, "out.webp");
      expect((await runSvgToImage(opts(input, webp))).format).toBe("webp");
      const wb = readFileSync(webp);
      expect(wb.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(wb.subarray(8, 12).toString("latin1")).toBe("WEBP");

      // AVIF: ISOBMFF — "ftyp" box at offset 4.
      const avif = path.join(d, "out.avif");
      expect((await runSvgToImage(opts(input, avif))).format).toBe("avif");
      expect(readFileSync(avif).subarray(4, 8).toString("latin1")).toBe("ftyp");

      // TIFF: "II*\0" (LE) or "MM\0*" (BE).
      const tiff = path.join(d, "out.tiff");
      expect((await runSvgToImage(opts(input, tiff))).format).toBe("tiff");
      const tb = readFileSync(tiff).subarray(0, 4).toString("hex");
      expect(["49492a00", "4d4d002a"]).toContain(tb);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("keeps alpha when transcoding a transparent SVG to WebP", async () => {
    const d = setup();
    const input = path.join(d, "in.svg");
    const output = path.join(d, "out.webp");
    writeFileSync(input, TRANSPARENT_SVG);
    try {
      await runSvgToImage(opts(input, output));
      const sharp = (await import("sharp")).default;
      const meta = await sharp(readFileSync(output)).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.hasAlpha).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("samples distinct frames of an animated SVG via --at", async () => {
    const d = setup();
    const input = path.join(d, "anim.svg");
    const early = path.join(d, "a.png");
    const late = path.join(d, "b.png");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await runSvgToImage(opts(input, early, { atMs: 0 }));
      await runSvgToImage(opts(input, late, { atMs: 500 }));
      const h = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
      expect(h(early)).not.toBe(h(late));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
