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
async function rawPixels(buf: Buffer): Promise<{ data: Buffer; n: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, n: info.width * info.height };
}

/** Ink (darker-than-mid-gray) pixel count + bounding box on the white field. */
async function ink(buf: Buffer): Promise<{ count: number; minX: number; minY: number; maxX: number; maxY: number }> {
  const { data, n } = await rawPixels(buf);
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
/** Intersection-over-union of the two crops' INK masks, optionally shifting
 *  `b` by `dx` (for calibration controls).
 *
 *  DM-1977: a whole-crop pixel diff is the wrong proxy for "the cut is
 *  seamless". The overlay paints glyph PATHS and the page paints NATIVE text —
 *  same outlines, different rasterization — so every glyph edge differs by
 *  construction, and on a thin serif face the edges are a large fraction of the
 *  ink. The residual is therefore platform-dependent antialiasing rather than a
 *  seam, and it exceeded the fixed budget on BOTH platforms. IoU over the ink
 *  masks measures what the assertion actually means: the same glyphs, in the
 *  same place. */
async function inkIoU(a: Buffer, b: Buffer, dx = 0): Promise<number> {
  const [ra, rb] = [await rawPixels(a), await rawPixels(b)];
  const width = CROP.width;
  const isInk = (d: Uint8Array | Uint8ClampedArray, i: number): boolean =>
    (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3 < 128;
  let inter = 0, union = 0;
  for (let i = 0; i < ra.n; i++) {
    const x = i % width, y = Math.floor(i / width);
    const xb = x - dx;
    const A = isInk(ra.data, i);
    const B = xb >= 0 && xb < width ? isInk(rb.data, y * width + xb) : false;
    if (A && B) inter++;
    if (A || B) union++;
  }
  return union === 0 ? 1 : inter / union;
}

async function diffFraction(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = [await rawPixels(a), await rawPixels(b)];
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
    // DM-1977: the seam is checked by ink OVERLAP, not by a whole-crop pixel
    // diff. The two sides are different rasterizations of the same outlines —
    // glyph-path fill vs native text — so every glyph edge differs by
    // construction, and on this face the edges are a large share of the ink.
    // The old `diffFraction < 0.05` was measuring that antialiasing floor and
    // exceeded it on BOTH platforms (macOS 0.0529, Linux 0.0645), so it was not
    // detecting a seam at all.
    //
    // Calibrated against a deliberately-shifted control, which is the failure
    // this assertion exists to catch:
    //
    //           exact   1px shift   2px    3px
    //   macOS   0.614     0.363     0.173  0.123
    //   Linux   0.864     0.393     0.140  0.125
    //
    // 0.5 sits clear of both exact values and clear of every shifted one, so a
    // one-pixel jump at the cut still fails.
    const seamIoU = await inkIoU(beforeCut, afterCut);
    expect(seamIoU, `cut is not seamless — ink overlap ${seamIoU.toFixed(3)}`).toBeGreaterThan(0.5);
  });

  // DM-1796 INVERTED THIS TEST, deliberately. It used to assert the old
  // default — "at frameEnd − 20 the overlay is gone, the crop is blank white" —
  // which reads as documentation but was the bug: the value was on neither side
  // of the handoff for ~120 ms, and every config that didn't know to set
  // `holdToFrameEnd` flashed. The default now holds through the boundary, so
  // the flag is a no-op HERE (it still forces the cut on a non-cut frame).
  it("DM-1796: the default no longer blanks before the boundary — it matches holdToFrameEnd", async () => {
    const { page } = env!;
    const svg = makeSvg(false);
    // The crop that used to be blank white now still carries the typed text …
    const beforeCut = await cropAt(page, svg, FRAME1_MS - 20);
    expect((await ink(beforeCut)).count).toBeGreaterThan(150);
    // … at FULL opacity: pixel-identical to the mid-hold state, no fade begun.
    expect(await diffFraction(await cropAt(page, svg, 1400), beforeCut)).toBeLessThan(0.001);
    // And the whole emitted SVG is now identical to the explicit-flag form.
    expect(svg).toBe(makeSvg(true));
  });
});
