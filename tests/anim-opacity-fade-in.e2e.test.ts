import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { composeAnimateConfig, validateAnimateConfig } from "../src/cli/animate.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Intra-frame `opacity` fade-in from a partially-transparent / invisible
// capture, verified on the RASTERIZED composed SVG (not plan math): the
// captured opacity used to be baked onto a wrapper `<g opacity>` that
// multiplied with the animated value (a 0.2-captured element peaked at
// 0.2·1 = 0.2), and `opacity: 0` elements were dropped from the markup
// entirely. Now the animation owns the single opacity channel: at rest
// (before the delay) the SVG paints the keyframes' `from` — matching the
// capture when `from` is the captured value — and at the animation's end the
// element genuinely reaches full brightness.

const W = 240;
const H = 120;

// Three squares on white: `dim` captured at opacity 0.2 (fades 0.2→1),
// `hidden` captured at opacity 0 (fades 0→1), `plain` captured at opacity 0
// with NO animation (must stay dropped from the markup).
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: ${W}px; height: ${H}px; background: #ffffff; }
  div { position: absolute; top: 20px; width: 60px; height: 60px; }
  #dim { left: 20px; background: rgb(255, 0, 0); opacity: 0.2; }
  #hidden { left: 100px; background: rgb(0, 0, 255); opacity: 0; }
  #plain { left: 180px; background: rgb(0, 128, 0); opacity: 0; }
</style></head><body><div id="dim"></div><div id="hidden"></div><div id="plain"></div></body></html>`;

const DIM_PX = { x: 50, y: 50 };    // center of #dim
const HIDDEN_PX = { x: 130, y: 50 }; // center of #hidden

async function samplePixels(page: Page, points: Array<{ x: number; y: number }>): Promise<Array<[number, number, number]>> {
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  return points.map(({ x, y }) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  });
}

/** Seek every CSS animation in the page to `tMs` and pause it. */
async function seekTo(page: Page, tMs: number): Promise<void> {
  await page.evaluate((t: number) => {
    for (const a of document.getAnimations()) {
      a.currentTime = t;
      a.pause();
    }
  }, tMs);
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("intra-frame opacity fade-in from a partially-transparent capture", () => {
  it("rest matches the capture (dim / invisible) and the peak is genuinely bright", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(path.join(tmpdir(), "anim-opacity-"));
    try {
      writeFileSync(path.join(dir, "page.html"), PAGE);
      const cfg = validateAnimateConfig({
        width: W, height: H,
        frames: [{
          input: "page.html",
          duration: 2000,
          animations: [
            { selector: "#dim", property: "opacity", from: "0.2", to: "1", duration: 800, delay: 400 },
            { selector: "#hidden", property: "opacity", from: "0", to: "1", duration: 800, delay: 400 },
          ],
        }],
      });
      const svg = await composeAnimateConfig(browser, cfg, dir, () => {});

      // The invisible-but-animated square's markup EXISTS; the plain
      // opacity:0 square stays dropped; no baked wrapper pins the animated
      // squares (their groups carry the anim class, not a static opacity).
      expect(svg).toContain("rgb(0,0,255)");
      expect(svg).not.toContain("rgb(0,128,0)");

      // Ground truth: Chromium's own paint of the source page.
      const ctx = await browser.newContext({ viewport: { width: W, height: H } });
      const page = await ctx.newPage();
      await page.setContent(PAGE);
      const [captureDim, captureHidden] = await samplePixels(page, [DIM_PX, HIDDEN_PX]);

      // Rasterize the composed SVG (inline, so document.getAnimations() sees
      // the CSS animations) at rest (t=10ms, before the 400ms delay) and at
      // the peak (t=1900ms, after the animation window ends and holds `to`).
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
      await seekTo(page, 10);
      const [restDim, restHidden] = await samplePixels(page, [DIM_PX, HIDDEN_PX]);
      await seekTo(page, 1900);
      const [peakDim, peakHidden] = await samplePixels(page, [DIM_PX, HIDDEN_PX]);
      await ctx.close();

      // Rest state == capture (per-channel tolerance for AA/rounding).
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(restDim[c] - captureDim[c])).toBeLessThanOrEqual(6);
        expect(Math.abs(restHidden[c] - captureHidden[c])).toBeLessThanOrEqual(6);
      }
      // Sanity on what the capture actually looks like: 0.2 red over white
      // ≈ rgb(255, 204, 204); the hidden square's spot is pure white.
      expect(captureDim[1]).toBeGreaterThan(180);
      expect(captureHidden[0]).toBeGreaterThan(245);

      // Peak state: genuinely bright — the dim square reaches ~full red
      // (impossible under the old multiplicative wrapper, which capped it at
      // 0.2 · 1 = the rest state), and the hidden square is ~full blue.
      expect(peakDim[0]).toBeGreaterThan(245);   // R
      expect(peakDim[1]).toBeLessThan(30);       // G — was ~204 at rest
      expect(peakDim[2]).toBeLessThan(30);       // B
      expect(peakHidden[2]).toBeGreaterThan(245); // B
      expect(peakHidden[0]).toBeLessThan(30);     // R — was ~255 (white) at rest
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
