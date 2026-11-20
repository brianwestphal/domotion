import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import type { CapturedElement } from "./types.js";

// DM-GFE90Q: Blink paints a <body> background that transferred to the view
// over the whole canvas, positioned against the root box, beneath the root
// stacking context's negative z-order children. Full-RGBA comparison of the
// rendered SVG against Chromium's own paint, plus a negative control with the
// canvas facts removed.

const W = 120;
const H = 120;
const tilePng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQYlWP4z8CABzGMSjNgCQMAt8pjnanKDKUAAAAASUVORK5CYII=";
// A painted child so a body without its own background still yields a tree.
const block = `<div style="width:10px;height:10px;background:rgb(0,0,0)"></div>`;
const negative = `<div style="position:relative;width:80px;height:80px;margin:10px"><div style="position:absolute;inset:0;background:rgb(128,0,128);z-index:-1"></div></div>`;

let browser: Browser;
let page: Page;
let generated: Page;
beforeAll(async () => {
  browser = await launchChromium();
  page = await browser.newPage({ viewport: { width: W, height: H } });
  generated = await browser.newPage({ viewport: { width: W, height: H } });
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const rgbaPixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
const diffPixels = (a: Buffer, b: Buffer) => {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diff++;
  }
  return diff;
};
const renderRaw = async (tree: CapturedElement[]) => {
  await generated.setContent(`<style>html,body{margin:0;background:white}</style>${elementTreeToSvg(tree, W, H)}`);
  return rgbaPixels(await generated.screenshot());
};
const compare = async (html: string) => {
  await page.setContent(html);
  await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
  const expected = await rgbaPixels(await page.screenshot());
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  const body = tree[0];
  const facts = { transfers: body.backgroundTransfersToView, rootBox: body.documentRootBox };
  const actual = diffPixels(expected, await renderRaw(tree));
  delete body.backgroundTransfersToView;
  delete body.documentRootBox;
  delete body.documentCanvasBackground;
  const legacy = diffPixels(expected, await renderRaw(tree));
  return { actual, legacy, facts };
};

/** Capture a sub-rectangle rooted at `selector`, compared against Chromium's
 * paint of the same clip; the negative arm drops only the canvas record. */
const compareRooted = async (html: string, selector: string, clip: { x: number; y: number; w: number; h: number }) => {
  await page.setContent(html);
  await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
  const expected = await rgbaPixels(
    await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } }),
  );
  const tree = await captureElementTree(page, selector, { x: clip.x, y: clip.y, width: clip.w, height: clip.h });
  const render = async () => {
    await generated.setViewportSize({ width: clip.w, height: clip.h });
    await generated.setContent(
      `<style>html,body{margin:0;background:white}</style>${elementTreeToSvg(tree, clip.w, clip.h)}`,
    );
    const pixels = await rgbaPixels(await generated.screenshot());
    await generated.setViewportSize({ width: W, height: H });
    return pixels;
  };
  const record = tree[0].documentCanvasBackground;
  const actual = diffPixels(expected, await render());
  delete tree[0].documentCanvasBackground;
  const withoutRecord = diffPixels(expected, await render());
  return { actual, withoutRecord, record, rootTag: tree[0].tag };
};

describe("document canvas background propagation (DM-GFE90Q)", () => {
  it("paints a transferred body background over the whole canvas", async () => {
    const result = await compare(`<style>body{margin:10px;height:50px;background:rgb(0,200,255)}</style>`);
    expect(result.facts.transfers).toBe(true);
    expect(result.facts.rootBox).toMatchObject({ x: 0, y: 0, width: W });
    expect(result.actual).toBe(0);
    expect(result.legacy).toBeGreaterThan(9000);
  }, 60_000);

  it("paints the canvas beneath the root context's negative layers", async () => {
    const result = await compare(`<style>body{margin:0;background:white}</style>${negative}`);
    expect(result.actual).toBe(0);
    expect(result.legacy).toBe(6400);
  }, 60_000);

  it("positions image layers against the root box, tiling the whole canvas", async () => {
    // URL layers already took the root positioning area from the live canvas
    // attachment record; the canvas path must keep that exact and add the
    // missing order beneath negative layers (the legacy box painted over it).
    for (const html of [
      `<style>html{padding:7px;border:3px solid transparent;height:40px}body{margin:10px;height:20px;background:url(${tilePng}) 5px 5px/15px 15px}</style>`,
      `<style>html{padding:7px;border:3px solid transparent}body{margin:10px;height:20px;padding:4px;background:url(${tilePng}) no-repeat content-box 2px 3px}</style>`,
    ]) {
      expect((await compare(html)).actual, html).toBe(0);
      const withNegative = await compare(html.replace("height:20px;", "") + negative);
      expect(withNegative.actual, html).toBe(0);
      expect(withNegative.legacy, html).toBeGreaterThan(0);
    }
  }, 60_000);

  it("leaves non-transferring roots on their existing paths", async () => {
    for (const [html, htmlOwnsCanvas] of [
      // <html> owns the canvas: body keeps its own box background above the
      // negative layer.
      [
        `<style>html{background:rgb(255,255,0)}body{margin:10px;background:white;height:100px}</style><div style="position:relative;width:80px;height:80px"><div style="position:absolute;inset:0 -20px -20px 0;background:rgb(128,0,128);z-index:-1"></div></div>`,
        true,
      ],
      // A translucent <html> color is painted exactly once.
      [`<style>html{background:rgba(255,0,0,0.5)}body{margin:10px;height:50px}</style>${block}`, true],
      // Containment on body stops propagation.
      [`<style>body{margin:10px;height:50px;background:rgb(0,200,255);contain:paint}</style>`, false],
      // No background anywhere.
      [`<style>body{margin:10px}</style>${negative}`, false],
    ] as const) {
      const result = await compare(html);
      expect(result.facts.transfers, html).toBeUndefined();
      expect(result.facts.rootBox != null, html).toBe(htmlOwnsCanvas);
      expect(result.actual, html).toBe(0);
      expect(result.legacy, html).toBe(0);
    }
  }, 60_000);

  it("paints <html>-owned image layers as the canvas", async () => {
    for (const html of [
      // A gradient on a short <html>: the canvas repeats the root-box tile
      // down the whole viewport.
      `<style>html{background:linear-gradient(rgb(255,0,0),rgb(0,0,255));height:60px}body{margin:0}</style>${block}`,
      // URL tiles positioned against an <html> with border and padding, over
      // an <html> color, beneath a real negative layer.
      `<style>html{padding:7px;border:3px solid transparent;background:rgb(255,255,0) url(${tilePng}) 5px 5px/15px 15px}body{margin:10px}</style>${negative}`,
    ]) {
      const result = await compare(html);
      expect(result.facts, html).toMatchObject({ transfers: undefined, rootBox: { x: 0, y: 0, width: W } });
      expect(result.actual, html).toBe(0);
      expect(result.legacy, html).toBeGreaterThan(1000);
    }
  }, 60_000);

  it("paints the canvas around a capture rooted below <body>", async () => {
    const card = `<div class="card" style="margin:30px;width:40px;height:40px;background:rgb(255,255,255)"></div>`;
    for (const html of [
      // Transferred body color and gradient: the clip shows them around the card.
      `<style>body{margin:0;background:rgb(0,200,255)}</style>${card}`,
      `<style>body{margin:0;background:linear-gradient(90deg,rgb(255,0,0),rgb(0,0,255))}</style>${card}`,
      // <html>-owned gradient layer.
      `<style>html{background:linear-gradient(rgb(0,128,0),rgb(255,255,0))}body{margin:0}</style>${card}`,
    ]) {
      // Skia dithers gradients on a 4 x 4 device-space matrix, so the clip
      // origin stays on that grid (a rasterization phase, not geometry).
      const result = await compareRooted(html, ".card", { x: 8, y: 8, w: 80, h: 80 });
      expect(result.rootTag, html).toBe("div");
      expect(result.record?.children, html).toEqual([]);
      expect(result.actual, html).toBe(0);
      expect(result.withoutRecord, html).toBeGreaterThan(1000);
    }
  }, 60_000);
});
