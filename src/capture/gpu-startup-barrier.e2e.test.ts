import { describe, expect, it } from "vitest";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { launchChromium } from "./index.js";

// Without the GPU startup barrier, the first page of a freshly launched
// browser lost a canvas drawn at load in 20–70% of launches on macOS (runs of
// 10 and 20 launches): the context was lost about 35 ms into the document and
// Chromium painted the broken-canvas placeholder, then a cleared canvas. Ten
// launches miss a regression at a 30% loss rate with probability below 3%.
const LAUNCHES = 10;

describe("launchChromium GPU startup barrier", () => {
  it("keeps a canvas drawn at load on the first page of each fresh browser", async () => {
    const outcomes: unknown[] = [];
    for (let launch = 0; launch < LAUNCHES; launch++) {
      const browser = await launchChromium();
      try {
        const page = await browser.newPage({ viewport: { width: 120, height: 120 } });
        await page.setContent(`<canvas width="100" height="100"></canvas><script>
            const canvas = document.querySelector("canvas");
            window.__lost = 0;
            canvas.addEventListener("contextlost", () => window.__lost++);
            const context = canvas.getContext("2d");
            context.fillStyle = "rgb(0,80,240)";
            context.fillRect(0, 0, 100, 100);
          </script>`);
        // Unpatched loss arrives about 35 ms in and restoration about 500 ms in.
        await page.waitForTimeout(700);
        outcomes.push(
          await page.evaluate(() => {
            const context = document.querySelector("canvas")!.getContext("2d")!;
            return {
              lost: (window as unknown as { __lost: number }).__lost,
              center: [...context.getImageData(50, 50, 1, 1).data],
            };
          }),
        );
      } finally {
        await closeBrowserSafely(browser);
      }
    }
    expect(outcomes).toEqual(Array.from({ length: LAUNCHES }, () => ({ lost: 0, center: [0, 80, 240, 255] })));
  }, 60_000);
});
