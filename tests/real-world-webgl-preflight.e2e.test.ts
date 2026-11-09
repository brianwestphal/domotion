import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeWebGlOutput } from "./real-world-webgl-freeze.js";
import { primeOffscreenCanvases } from "./real-world-webgl-preflight.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function centerPixel(page: Page): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: 20, y: 20, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue] as [number, number, number];
  }, png.toString("base64"));
}

describe("offscreen WebGL preflight", () => {
  it("presents an offscreen canvas before freezing without changing scroll or stopping animation", async () => {
    const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
    try {
      await page.setContent(`<!doctype html><body style="margin:0;height:1200px">
        <canvas id="far" width="40" height="40" style="position:absolute;top:1000px;left:0"></canvas>
        <script>
          const gl = document.getElementById('far').getContext('webgl2');
          window.loops_ = 0;
          function loop() {
            window.loops_++;
            gl.clearColor(1, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
        </script></body>`);
      await page.waitForFunction(() => (window as unknown as { loops_: number }).loops_ > 2);
      await page.evaluate(() => window.scrollTo(0, 123));
      await page.screenshot({ clip: { x: 0, y: 0, width: 40, height: 40 } });
      const loopsBefore = await page.evaluate(() => (window as unknown as { loops_: number }).loops_);
      expect(await primeOffscreenCanvases(page)).toEqual({ primed: 1, failed: 0, skipped: 0 });
      expect(await page.evaluate(() => window.scrollY)).toBe(123);
      expect(await page.evaluate(() => (window as unknown as { loops_: number }).loops_)).toBeGreaterThan(loopsBefore);
      expect(await freezeWebGlOutput(page)).toMatchObject({ frozenFrames: 1, failedFrames: 0 });
      await page.evaluate(() => document.getElementById("far")!.scrollIntoView());
      expect(await centerPixel(page)).toEqual([255, 0, 0]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
