import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { animateGoldensEquivalent } from "./animate-golden-compare.js";

async function rasterSvg(pixels: number[]): Promise<string> {
  const png = await sharp(Buffer.from(pixels), {
    raw: { width: pixels.length / 3, height: 1, channels: 3 },
  })
    .png()
    .toBuffer();
  return `<svg><image href="data:image/png;base64,${png.toString("base64")}"/></svg>`;
}

describe("animate golden comparison", () => {
  it("accepts the measured two-pixel, one-channel-step Chromium raster floor", async () => {
    const golden = await rasterSvg([10, 10, 10, 20, 20, 20]);
    const actual = await rasterSvg([11, 10, 10, 20, 19, 20]);
    await expect(animateGoldensEquivalent(golden, actual)).resolves.toBe(true);
  });

  it("rejects more than two changed raster pixels", async () => {
    const golden = await rasterSvg([10, 10, 10, 20, 20, 20, 30, 30, 30]);
    const actual = await rasterSvg([11, 10, 10, 21, 20, 20, 31, 30, 30]);
    await expect(animateGoldensEquivalent(golden, actual)).resolves.toBe(false);
  });

  it("rejects a raster channel delta above one", async () => {
    const golden = await rasterSvg([10, 10, 10]);
    const actual = await rasterSvg([12, 10, 10]);
    await expect(animateGoldensEquivalent(golden, actual)).resolves.toBe(false);
  });

  it("rejects SVG markup drift even when raster payloads match", async () => {
    const golden = await rasterSvg([10, 10, 10]);
    await expect(animateGoldensEquivalent(golden, golden.replace("<svg>", '<svg viewBox="0 0 1 1">'))).resolves.toBe(
      false,
    );
  });
});
