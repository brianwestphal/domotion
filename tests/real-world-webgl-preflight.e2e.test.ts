import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
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
  it.each(["same-origin", "cross-origin", "nested", "scaled"])(
    "primes a far-offscreen %s iframe content box",
    async (kind) => {
      const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
      const canvasHtml = `<!doctype html><body style="margin:0"><canvas width="40" height="40"></canvas>
      <script>
        const gl = document.querySelector('canvas').getContext('webgl2');
        const paint = () => { gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); };
        paint(); setInterval(paint, 10);
      </script></body>`;
      try {
        await page.route("https://canvas-frame.test/**", (route) =>
          route.fulfill({ contentType: "text/html", body: canvasHtml }),
        );
        await page.setContent(`<!doctype html><body style="margin:0;height:1800px">
        <iframe id="far" style="position:absolute;left:0;top:1000px;width:80px;height:80px;border:3px solid;padding:5px"></iframe>
        <script>window.ticks=0; function loop(){window.ticks++; requestAnimationFrame(loop)}; requestAnimationFrame(loop)</script>
      </body>`);
        if (kind === "scaled")
          await page.locator("#far").evaluate((el) => {
            (el as HTMLElement).style.transform = "scale(.5)";
            (el as HTMLElement).style.transformOrigin = "top left";
          });
        if (kind === "cross-origin")
          await page.locator("#far").evaluate((el) => {
            (el as HTMLIFrameElement).src = "https://canvas-frame.test/canvas";
          });
        else
          await page.locator("#far").evaluate(
            (el, html) => {
              (el as HTMLIFrameElement).srcdoc = html;
            },
            kind === "nested"
              ? `<body style="margin:0"><iframe id="inner" style="width:50px;height:50px;border:2px solid;padding:3px" srcdoc="${canvasHtml.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body>`
              : canvasHtml,
          );
        const canvas =
          kind === "nested"
            ? page.frameLocator("#far").frameLocator("#inner").locator("canvas")
            : page.frameLocator("#far").locator("canvas");
        await canvas.waitFor();
        await page.waitForFunction(() => (window as unknown as { ticks: number }).ticks > 2);
        await page.evaluate(() => window.scrollTo(0, 123));
        const before = await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])));
        const ticks = await page.evaluate(() => (window as unknown as { ticks: number }).ticks);
        expect(await primeOffscreenCanvases(page)).toEqual({ primed: 1, failed: 0, skipped: 0 });
        expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])))).toEqual(
          before,
        );
        await expect
          .poll(() => page.evaluate(() => (window as unknown as { ticks: number }).ticks))
          .toBeGreaterThan(ticks);
        expect(await freezeWebGlOutput(page)).toMatchObject({ failedFrames: 0 });
        await page.locator("#far").scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        const png = await page.screenshot({
          clip: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, width: 1, height: 1 },
        });
        expect(Array.from(await sharp(png).removeAlpha().raw().toBuffer())).toEqual([255, 0, 0]);
      } finally {
        await page.close();
      }
    },
  );

  it("shares the eight-canvas screenshot budget across the main document and child frames", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(`<body style="margin:0;height:1800px">
        <canvas width="10" height="10" style="position:absolute;top:1200px"></canvas>
        <canvas width="10" height="10" style="position:absolute;top:1300px"></canvas>
        <iframe style="position:absolute;top:1000px;width:80px;height:80px" srcdoc="<body style='margin:0'>${"<canvas width=8 height=8></canvas>".repeat(8)}</body>"></iframe>
      </body>`);
      await page.frameLocator("iframe").locator("canvas").first().waitFor();
      expect(await primeOffscreenCanvases(page)).toEqual({ primed: 8, failed: 0, skipped: 2 });
      expect(await page.evaluate(() => scrollY)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("reports an unsupported rotated frame without inventing a projection", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<body style="height:1800px"><iframe style="position:absolute;top:1000px;transform:rotate(10deg)" srcdoc="<canvas width=40 height=40></canvas>"></iframe></body>`,
      );
      await page.frameLocator("iframe").locator("canvas").waitFor();
      expect(await primeOffscreenCanvases(page)).toEqual({ primed: 0, failed: 0, skipped: 1 });
    } finally {
      await page.close();
    }
  });

  it("retains frame-discovery failures when the screenshot session is unavailable", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<body style="height:1800px"><canvas width=40 height=40 style="position:absolute;top:1000px"></canvas><iframe srcdoc="<canvas width=40 height=40></canvas>"></iframe></body>`,
      );
      await page.frameLocator("iframe").locator("canvas").waitFor();
      const departed = page.frames().find((frame) => frame !== page.mainFrame())!;
      await page.locator("iframe").evaluate((el) => el.remove());
      expect(departed.isDetached()).toBe(true);
      vi.spyOn(page, "frames").mockReturnValue([page.mainFrame(), departed]);
      vi.spyOn(page.context(), "newCDPSession").mockRejectedValue(new Error("session unavailable"));
      expect(await primeOffscreenCanvases(page)).toEqual({ primed: 0, failed: 2, skipped: 0 });
    } finally {
      vi.restoreAllMocks();
      await page.close();
    }
  });

  it("presents an offscreen canvas before freezing without changing scroll or stopping animation", async () => {
    let pixel: [number, number, number] = [0, 0, 0];
    // Hosted macOS Chromium can leave a new WebGL context's composited layer
    // gray even after a successful offscreen screenshot. Retry that compositor
    // startup state on a fresh page, while preserving every preflight and
    // frozen-frame assertion for each attempt.
    for (let attempt = 0; attempt < 3; attempt++) {
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
        expect(await page.evaluate(() => (window as unknown as { loops_: number }).loops_)).toBeGreaterThan(
          loopsBefore,
        );
        expect(await freezeWebGlOutput(page)).toMatchObject({ frozenFrames: 1, failedFrames: 0 });
        await page.evaluate(() => document.getElementById("far")!.scrollIntoView());
        pixel = await centerPixel(page);
        if (pixel[0] !== pixel[1] || pixel[1] !== pixel[2]) break;
      } finally {
        await page.close();
      }
    }
    expect(pixel).toEqual([255, 0, 0]);
  }, 60_000);
});
