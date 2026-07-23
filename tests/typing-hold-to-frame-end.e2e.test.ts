import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import type { AnimationOverlay } from "../src/animation/index.js";
import { htmlWrapper, seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * DM-1749 (docs/100 fold-in): `holdToFrameEnd: true` on a typing overlay must
 * hold the typed text at FULL opacity through the frame's end and drop with a
 * hard step cut at the frame boundary — so a next frame carrying the identical
 * page text takes over seamlessly. Verified in the RASTERIZED SVG (the
 * rendered-SVG-is-truth rule): we rasterize the actual animated SVG just before
 * and just after the cut via the same seek machinery `svg-to-image --at` uses.
 */

const W = 360;
const H = 120;
const TEXT = "hello seamless";
const FONT = "'SF Mono', Menlo, Monaco, monospace";
// Overlay baseline at (40, 70); the crop brackets the typed line generously.
const CROP = { x: 30, y: 40, width: 260, height: 50 };
const FRAME1_MS = 2000; // the cut sits here

function makeSvg(holdToFrameEnd: boolean): string {
  const overlay = {
    kind: "typing", text: TEXT, x: 40, y: 70, fontSize: 20, color: "#111111",
    delay: 200, speed: 40, ...(holdToFrameEnd ? { holdToFrameEnd: true } : {}),
  } as unknown as AnimationOverlay;
  return generateAnimatedSvg({
    width: W, height: H,
    frames: [
      { svgContent: `<rect width="${W}" height="${H}" fill="#ffffff"/>`, duration: FRAME1_MS, transition: { type: "cut", duration: 0 }, overlays: [overlay] },
      // Frame 2 carries the IDENTICAL text as real page content at the same
      // baseline / font — the seamless-handoff scenario the flag exists for.
      { svgContent: `<rect width="${W}" height="${H}" fill="#ffffff"/><text x="40" y="70" font-size="20" font-family="${FONT.replace(/'/g, "&#39;")}" fill="#111111">${TEXT}</text>`, duration: 1000, transition: { type: "cut", duration: 0 } },
    ],
  });
}

async function cropAt(page: Page, svg: string, atMs: number): Promise<Buffer> {
  await page.setContent(htmlWrapper(svg, "#ffffff"), { waitUntil: "load" });
  await seekTo(page, atMs);
  return page.screenshot({ type: "png", clip: CROP });
}

/** Raw RGBA pixels of a PNG buffer. */
async function raw(buf: Buffer): Promise<{ data: Buffer; n: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, n: info.width * info.height };
}

/** Ink (darker-than-mid-gray) pixel count + bounding box on the white field. */
async function ink(buf: Buffer): Promise<{ count: number; minX: number; minY: number; maxX: number; maxY: number }> {
  const { data, n } = await raw(buf);
  const width = CROP.width;
  let count = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if ((data[o] + data[o + 1] + data[o + 2]) / 3 < 128) {
      count++;
      const x = i % width, y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, minY, maxX, maxY };
}

/** Fraction of pixels whose max channel delta exceeds 32 (visible change). */
async function diffFraction(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = [await raw(a), await raw(b)];
  expect(ra.n).toBe(rb.n);
  let diff = 0;
  for (let i = 0; i < ra.n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(ra.data[o] - rb.data[o]),
      Math.abs(ra.data[o + 1] - rb.data[o + 1]),
      Math.abs(ra.data[o + 2] - rb.data[o + 2]),
    );
    if (d > 32) diff++;
  }
  return diff / ra.n;
}

async function setup() {
  try {
    const browser = await launchChromium();
    const context = await browser.newContext({ viewport: { width: W, height: H } });
    return { browser, page: await context.newPage() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("typing holdToFrameEnd rasterized handoff (DM-1749)", () => {
  it("holds full opacity to the frame boundary and cuts seamlessly to identical page text", async () => {
    const { page } = env!;
    const svg = makeSvg(true);

    // Typing finishes at 200 + 14×40 = 760 ms; 1400 ms is deep in the hold.
    const held = await cropAt(page, svg, 1400);
    const beforeCut = await cropAt(page, svg, FRAME1_MS - 20);
    const afterCut = await cropAt(page, svg, FRAME1_MS + 20);

    // The overlay text is really there (ink on the white field) …
    const heldInk = await ink(held);
    expect(heldInk.count).toBeGreaterThan(150);
    // … and holds at FULL opacity right up to the frame boundary: 20 ms before
    // the cut is pixel-identical to the mid-hold state (no fade has begun).
    expect(await diffFraction(held, beforeCut)).toBeLessThan(0.001);
    // Just after the cut the frame-2 PAGE text has taken over, pixel-on: the
    // glyph-path overlay and the native text paint the same glyphs at the same
    // baseline. The ink bounding boxes must coincide (no jump, no offset) and
    // the residual pixel diff stays within glyph-edge antialiasing (glyph-path
    // fill vs native text rasterization — same outlines, slightly different AA).
    const before = await ink(beforeCut);
    const after = await ink(afterCut);
    expect(after.count).toBeGreaterThan(150);
    expect(Math.abs(after.minX - before.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.maxX - before.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.minY - before.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.maxY - before.maxY)).toBeLessThanOrEqual(1);
    expect(await diffFraction(beforeCut, afterCut)).toBeLessThan(0.05);
  });

  it("default (no flag) has already faded out just before the boundary", async () => {
    const { page } = env!;
    const svg = makeSvg(false);
    // The default fade starts at frameEnd − 150 and completes by frameEnd − 50,
    // so at frameEnd − 20 the overlay is gone — the crop is blank white.
    const beforeCut = await cropAt(page, svg, FRAME1_MS - 20);
    expect((await ink(beforeCut)).count).toBe(0);
    // Sanity: mid-hold the same SVG shows the typed text.
    expect((await ink(await cropAt(page, svg, 1400))).count).toBeGreaterThan(150);
  });
});
