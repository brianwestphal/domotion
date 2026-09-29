/**
 * The per-side perceptual digest is computed twice: `perceptualDigest` in Node (side-digest.ts) and a
 * hand-copied `sideDigest` inside the browser comparison source (compare-pngs.ts), which is a
 * `page.evaluate` string with no module scope. Baselines store the browser value and later reports
 * compare it with the Node value, so the two must agree bit for bit — a change to the grid, the
 * levels or the luma weights in only one file would make every stored `expectedDigest` incomparable
 * (the DM-1874 attribution failure). Nothing else ties them together, so this does.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comparePngs } from "./compare-pngs.js";
import { perceptualDigest } from "./side-digest.js";

let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 64, height: 64 } })).newPage();
  await page.setContent("<!doctype html><body></body>");
  dir = mkdtempSync(join(tmpdir(), "digest-parity-"));
});

afterAll(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

/** RGBA pixels with a horizontal ramp, a vertical ramp and varying alpha, so every grid cell differs. */
function rgba(width: number, height: number, seed: number, opaque: boolean): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / Math.max(1, width - 1);
      data[i + 1] = (y * 255) / Math.max(1, height - 1);
      data[i + 2] = (seed * 37 + x * y) % 256;
      data[i + 3] = opaque ? 255 : 40 + ((x + y * 3 + seed) % 216);
    }
  }
  return data;
}

async function writePng(name: string, width: number, height: number, seed: number, opaque: boolean): Promise<string> {
  const path = join(dir, name);
  writeFileSync(
    path,
    await sharp(rgba(width, height, seed, opaque), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
  return path;
}

async function nodeDigest(path: string): Promise<string> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return perceptualDigest(data, info.width, info.height);
}

const SIZES: Array<[number, number]> = [
  [200, 120],
  [203, 117], // neither dimension a multiple of the 16-cell grid
  [17, 31],
  [96, 96],
];

describe("browser sideDigest equals Node perceptualDigest", () => {
  it.each(SIZES)("bit for bit on an opaque %ix%i image pair (what a screenshot is)", async (w, h) => {
    const expectedPath = await writePng(`e-${w}x${h}.png`, w, h, 1, true);
    const actualPath = await writePng(`a-${w}x${h}.png`, w, h, 2, true);
    const result = await comparePngs(page, expectedPath, actualPath, join(dir, `d-${w}x${h}.png`));
    expect(result.expectedDigest).toBe(await nodeDigest(expectedPath));
    expect(result.actualDigest).toBe(await nodeDigest(actualPath));
    expect(result.expectedDigest).not.toBe(result.actualDigest);
    expect(result.expectedDigest).toHaveLength(256);
  });

  it("stays within one quantization level of Node on translucent pixels", async () => {
    // Canvas `getImageData` returns un-premultiplied values that were premultiplied on decode, so
    // semi-transparent input rounds differently from Node's exact straight alpha. A digest is
    // already lossy (16 levels); a cell may land one level over a boundary but never further.
    const expectedPath = await writePng("e-alpha.png", 203, 117, 1, false);
    const actualPath = await writePng("a-alpha.png", 203, 117, 2, false);
    const result = await comparePngs(page, expectedPath, actualPath, join(dir, "d-alpha.png"));
    for (const [browserDigest, path] of [
      [result.expectedDigest ?? "", expectedPath],
      [result.actualDigest ?? "", actualPath],
    ] as const) {
      const nodeSide = await nodeDigest(path);
      let differing = 0;
      for (let i = 0; i < 256; i++) {
        const delta = Math.abs(parseInt(browserDigest[i], 16) - parseInt(nodeSide[i], 16));
        expect(delta).toBeLessThanOrEqual(1);
        if (delta > 0) differing++;
      }
      expect(differing).toBeLessThan(32);
    }
  });
});
