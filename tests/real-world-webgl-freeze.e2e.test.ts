import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeWebGlOutput } from "./real-world-webgl-freeze.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

// A WebGL loop that clears the canvas to a color the test controls, and
// draws, on every animation frame, through a reference to the native rAF
// cached before any harness code runs.
const LOOP_PAGE = `<!doctype html><body style="margin:0">
<canvas id="c" width="40" height="40" style="display:block"></canvas>
<script>
  const raf = window.requestAnimationFrame;
  const gl = document.getElementById("c").getContext(location.hash === "#gl1" ? "webgl" : "webgl2");
  window.color_ = [1, 0, 0];
  window.loops_ = 0;
  function loop() {
    window.loops_++;
    gl.clearColor(window.color_[0], window.color_[1], window.color_[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, 0);
    raf(loop);
  }
  raf(loop);
</script></body>`;

async function openLoopPage(variant: "gl1" | "gl2"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 40, height: 40 } });
  await page.goto(`about:blank#${variant}`);
  await page.setContent(LOOP_PAGE);
  await page.waitForFunction(() => (window as unknown as { loops_: number }).loops_ > 2);
  return page;
}

async function centerPixel(page: Page): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: 20, y: 20, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, png.toString("base64"));
}

const setColor = (page: Page, rgb: [number, number, number]): Promise<void> =>
  page.evaluate((c) => void ((window as unknown as { color_: number[] }).color_ = c), rgb);

describe("real-world WebGL freeze", () => {
  for (const variant of ["gl1", "gl2"] as const) {
    it(`keeps the last presented ${variant} frame while the page loop keeps running`, async () => {
      const page = await openLoopPage(variant);
      // The first WebGL context in a fresh browser can take a while to reach
      // the compositor (CI's hosted macOS runner showed a gray placeholder at
      // first), so wait for the first presented frame rather than assume it.
      await expect.poll(() => centerPixel(page), { timeout: 15_000 }).toEqual([255, 0, 0]);

      // Control: without the freeze, the loop repaints the new color.
      await setColor(page, [0, 0, 1]);
      await expect.poll(() => centerPixel(page), { timeout: 15_000 }).toEqual([0, 0, 255]);

      expect(await freezeWebGlOutput(page)).toEqual({ frozenFrames: 1, failedFrames: 0 });
      await setColor(page, [0, 1, 0]);
      const loopsBefore = await page.evaluate(() => (window as unknown as { loops_: number }).loops_);
      await page.waitForTimeout(100);
      // The page's own loop is untouched; only its output stops changing.
      expect(await page.evaluate(() => (window as unknown as { loops_: number }).loops_)).toBeGreaterThan(loopsBefore);
      expect(await centerPixel(page)).toEqual([0, 0, 255]);
      await page.close();
    }, 60_000);
  }

  it("is idempotent and covers every frame of the page", async () => {
    const page = await browser.newPage();
    await page.setContent(`<iframe srcdoc="<canvas></canvas>"></iframe><iframe srcdoc="<p>x</p>"></iframe>`);
    await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2);
    expect(await freezeWebGlOutput(page)).toEqual({ frozenFrames: 3, failedFrames: 0 });
    expect(await freezeWebGlOutput(page)).toEqual({ frozenFrames: 3, failedFrames: 0 });
    for (const frame of page.frames()) {
      const drawArrays = await frame.evaluate(() => WebGL2RenderingContext.prototype.drawArrays.toString());
      expect(drawArrays).not.toContain("[native code]");
    }
    await page.close();
  });
});
