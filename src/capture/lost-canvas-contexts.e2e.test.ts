import { chromium, type Browser, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { awaitGpuFeatureInfo } from "./gpu-startup-barrier.js";
import { captureElementTreeWithWarnings, launchChromium } from "./index.js";
import { LOST_CANVAS_CONTEXT_FEATURE } from "./lost-canvas-contexts.js";

const VIEWPORT = { x: 0, y: 0, width: 120, height: 120 };

async function lostCanvasWarnings(page: Page): Promise<string[]> {
  const { warnings } = await captureElementTreeWithWarnings(page, "body", VIEWPORT);
  return warnings.filter((warning) => warning.feature === LOST_CANVAS_CONTEXT_FEATURE).map((w) => w.selector);
}

/** A WebGL canvas drawn once at load. Unlike 2D, Chromium does not restore a
 * lost WebGL context unless the page asks, so the loss is still observable
 * when the capture runs. */
const WEBGL_AT_LOAD = `<style>body{margin:0}canvas{display:block}</style><canvas id="drawn" width="100" height="100"></canvas><script>
  const gl = document.getElementById("drawn").getContext("webgl");
  gl.clearColor(0, 0.3, 0.9, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
</script>`;

/** Open the first page of a fresh browser, load the canvas fixture, and report
 * whether the canvas lost its context and which canvases capture warned about. */
async function firstPageLoss(browser: Browser): Promise<{ lost: boolean; warned: string[] }> {
  const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
  await page.setContent(WEBGL_AT_LOAD);
  // Unpatched loss arrives about 35 ms into the document.
  await page.waitForTimeout(300);
  const lost = await page.evaluate(() =>
    (document.getElementById("drawn") as HTMLCanvasElement).getContext("webgl")!.isContextLost(),
  );
  return { lost, warned: await lostCanvasWarnings(page) };
}

describe("lost canvas context capture warning", () => {
  it("warns for a canvas whose context is lost, without creating contexts on other canvases", async () => {
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
      await page.setContent(`<style>body{margin:0}canvas{display:block;width:20px;height:20px}</style>
        <canvas id="lost"></canvas><canvas class="healthy gl"></canvas><canvas class="flat"></canvas><canvas id="blank"></canvas>`);
      await page.evaluate(async () => {
        const lost = (document.getElementById("lost") as HTMLCanvasElement).getContext("webgl")!;
        lost.getExtension("WEBGL_lose_context")!.loseContext();
        const healthy = (document.querySelector(".healthy") as HTMLCanvasElement).getContext("webgl2")!;
        healthy.clear(0x4000);
        const flat = (document.querySelector(".flat") as HTMLCanvasElement).getContext("2d")!;
        flat.fillRect(0, 0, 5, 5);
        // Pages keep their contexts; the capture can only see a context whose
        // script object is still alive (see warnLostCanvasContexts).
        (window as unknown as { contexts: unknown[] }).contexts = [lost, healthy, flat];
        // The loss event is dispatched asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(await lostCanvasWarnings(page)).toEqual(["canvas#lost"]);
      // Capture only enumerated existing contexts: the context-less canvas can
      // still get a WebGL context, which a probing getContext("2d") would prevent.
      expect(
        await page.evaluate(() => (document.getElementById("blank") as HTMLCanvasElement).getContext("webgl") != null),
      ).toBe(true);
    } finally {
      await closeBrowserSafely(browser);
    }
  }, 60_000);

  // Negative control for the GPU startup barrier on the path the warning
  // covers: a browser launched without it. The loss was measured only on macOS
  // (WebGL first-page loss in 17 of 30 fresh launches); stop at the first one.
  it.skipIf(process.platform !== "darwin")(
    "reports the GPU startup loss on an unprotected browser, and the exported barrier prevents it",
    async () => {
      const MAX_UNPROTECTED = 20;
      let unprotected: { lost: boolean; warned: string[] } | undefined;
      let launches = 0;
      while (launches < MAX_UNPROTECTED && unprotected?.lost !== true) {
        launches++;
        const browser = await chromium.launch();
        try {
          unprotected = await firstPageLoss(browser);
        } finally {
          await closeBrowserSafely(browser);
        }
        // Detection must agree with the page's own state on every launch.
        expect(unprotected.warned).toEqual(unprotected.lost ? ["canvas#drawn"] : []);
      }
      // The loss is a race whose rate depends on the host's GPU startup, so a
      // runner that never loses the canvas is not a failure; the detection
      // check above has still run on every launch.
      if (unprotected?.lost !== true) {
        console.warn(`lost-canvas negative control: no first-page loss in ${launches} unprotected launches`);
      }

      const PROTECTED = 6;
      const outcomes: Array<{ lost: boolean; warned: string[] }> = [];
      for (let launch = 0; launch < PROTECTED; launch++) {
        const browser = await chromium.launch();
        try {
          await awaitGpuFeatureInfo(browser);
          outcomes.push(await firstPageLoss(browser));
        } finally {
          await closeBrowserSafely(browser);
        }
      }
      expect(outcomes).toEqual(Array.from({ length: PROTECTED }, () => ({ lost: false, warned: [] })));
    },
    180_000,
  );
});
