import { afterAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { hoistDuplicateImagePayloads, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * The repeated-raster-payload pass rewrites `<image href="data:…">` into
 * `<use href="#dmiN">`, which is only correct if it PAINTS the same. That is not
 * something markup assertions can establish, and no visual fixture in the
 * regression suites happens to repeat a payload — so this is the guard: rasterize
 * the document before and after the rewrite in real Chromium and require the
 * bytes to be identical.
 *
 * It also pins the two `<use>`-geometry facts the design rests on, by asserting
 * that the tempting shortcuts DO differ:
 *
 *  - `width`/`height` on a `<use>` do not override an `<image>` referent, so one
 *    def cannot serve two sizes.
 *  - `x`/`y` on a `<use>` is a translate, which drags the element's own
 *    `clip-path` with it — so a clip must move to a wrapping `<g>`.
 *
 * If a future refactor "simplifies" either of those, the corresponding
 * expectation flips and this test says so.
 */

async function canLaunch(): Promise<Browser | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}
const browser = await canLaunch();
let page: Page | null = null;
if (browser != null) {
  page = await (await browser.newContext({ viewport: { width: 220, height: 220 }, deviceScaleFactor: 1 })).newPage();
}

afterAll(async () => {
  if (browser != null) await closeBrowserSafely(browser);
});

/** A 4×2 PNG: red top row, blue bottom row — aspect distortion and vertical
 *  flips are both visible, unlike a flat swatch. */
async function stripePng(): Promise<string> {
  const raw = Buffer.alloc(4 * 2 * 3);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 3;
      raw[o] = y === 0 ? 220 : 20;
      raw[o + 1] = 30;
      raw[o + 2] = y === 0 ? 20 : 220;
    }
  }
  const png = await sharp(raw, { raw: { width: 4, height: 2, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** 48×48 noise, so its data URI clears the pass's payload-size floor. */
async function noisePng(): Promise<string> {
  const raw = Buffer.alloc(48 * 48 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  const png = await sharp(raw, { raw: { width: 48, height: 48, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const P = browser != null ? await noisePng() : "";
const Q = browser != null ? await stripePng() : "";

const doc = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">`
  + `<rect width="200" height="200" fill="#fff"/>${body}</svg>`;

async function shoot(svg: string): Promise<Buffer> {
  await page!.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  await page!.waitForTimeout(60);
  return await page!.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } });
}

/** Count of differing raw bytes between two rasterized documents. */
async function rasterDiff(a: string, b: string): Promise<number> {
  const [ra, rb] = [await sharp(await shoot(a)).raw().toBuffer(), await sharp(await shoot(b)).raw().toBuffer()];
  let diff = 0;
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) diff++;
  return diff;
}

const describeBrowser = browser != null ? describe : describe.skip;

describeBrowser("hoisted image payloads paint identically", () => {
  it("a payload repeated at one size, one of them clipped", async () => {
    const input = doc(
      `<defs><clipPath id="c1"><rect x="10" y="110" width="30" height="40"/></clipPath></defs>`
      + `<image href="${P}" x="10" y="10" width="60" height="40" preserveAspectRatio="none"/>`
      + `<image href="${P}" x="100" y="10" width="60" height="40" preserveAspectRatio="none"/>`
      + `<image href="${P}" x="10" y="110" width="60" height="40" preserveAspectRatio="none" clip-path="url(#c1)"/>`,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).not.toBe(input); // the pass actually fired
    expect(await rasterDiff(input, out)).toBe(0);
  }, 60_000);

  it("a payload repeated at two sizes, and with two preserveAspectRatio values", async () => {
    const input = doc(
      `<image href="${Q}" x="10" y="10" width="60" height="40" preserveAspectRatio="none"/>`
      + `<image href="${Q}" x="80" y="10" width="60" height="40" preserveAspectRatio="none"/>`
      + `<image href="${Q}" x="10" y="60" width="30" height="90" preserveAspectRatio="none"/>`
      + `<image href="${Q}" x="50" y="60" width="30" height="90" preserveAspectRatio="none"/>`
      + `<image href="${Q}" x="100" y="60" width="60" height="60" preserveAspectRatio="xMidYMid meet"/>`
      + `<image href="${Q}" x="100" y="130" width="60" height="60" preserveAspectRatio="xMidYMid meet"/>`,
      // The 4×2 stripe makes a wrong size or a wrong fit obvious, not subtle.
    );
    // Q is small; force the pass to consider it so the geometry keying is what's tested.
    const out = hoistDuplicateImagePayloads(input, { minPayloadChars: 8 });
    expect((out.match(/<image id="dmi\d+"/g) ?? []).length).toBe(3); // one def per (size, fit)
    expect(await rasterDiff(input, out)).toBe(0);
  }, 60_000);

  it("payloads inside <pattern>, <mask>, and a nested <svg>", async () => {
    const input = doc(
      `<defs><pattern id="p1" patternUnits="userSpaceOnUse" x="0" y="0" width="20" height="20">`
      + `<image href="${P}" x="0" y="0" width="20" height="20" preserveAspectRatio="none"/></pattern>`
      + `<mask id="m1"><image href="${P}" x="0" y="0" width="80" height="80" preserveAspectRatio="none"/></mask></defs>`
      + `<rect x="0" y="0" width="80" height="60" fill="url(#p1)"/>`
      + `<rect x="90" y="0" width="80" height="80" fill="#333" mask="url(#m1)"/>`
      + `<svg x="0" y="100" width="80" height="80" viewBox="0 0 80 80">`
      + `<image href="${P}" x="0" y="0" width="20" height="20" preserveAspectRatio="none"/></svg>`
      + `<image href="${P}" x="100" y="120" width="60" height="60" preserveAspectRatio="xMidYMid meet"><title>hi</title></image>`
      + `<image href="${P}" x="100" y="150" width="60" height="60" preserveAspectRatio="xMidYMid meet"/>`,
    );
    const out = hoistDuplicateImagePayloads(input);
    expect(out).toContain(`<use href="#dmi`);
    expect(await rasterDiff(input, out)).toBe(0);
  }, 60_000);

  it("proves the shortcuts the design rejects would actually paint wrong", async () => {
    const base = `<defs><image id="d0" width="60" height="40" preserveAspectRatio="none" href="${Q}"/></defs>`;
    // (a) One def, sizes on the <use> — ignored for an <image> referent.
    const inlineSizes = doc(
      `<image href="${Q}" x="10" y="10" width="60" height="40" preserveAspectRatio="none"/>`
      + `<image href="${Q}" x="10" y="80" width="30" height="90" preserveAspectRatio="none"/>`,
    );
    const useSizes = doc(base + `<use href="#d0" x="10" y="10"/><use href="#d0" x="10" y="80" width="30" height="90"/>`);
    expect(await rasterDiff(inlineSizes, useSizes)).toBeGreaterThan(0);

    // (b) clip-path left on the translated <use> — the clip moves with it.
    const clipDefs = `<defs><clipPath id="c1"><rect x="10" y="110" width="30" height="40"/></clipPath></defs>`;
    const inlineClip = doc(clipDefs
      + `<image href="${Q}" x="10" y="110" width="60" height="40" preserveAspectRatio="none" clip-path="url(#c1)"/>`);
    const useClip = doc(clipDefs + base + `<use href="#d0" x="10" y="110" clip-path="url(#c1)"/>`);
    expect(await rasterDiff(inlineClip, useClip)).toBeGreaterThan(0);
    // …and the <g>-wrapped form the pass emits instead is exact.
    const gWrapped = doc(clipDefs + base + `<g clip-path="url(#c1)"><use href="#d0" x="10" y="110"/></g>`);
    expect(await rasterDiff(inlineClip, gWrapped)).toBe(0);
  }, 60_000);
});
