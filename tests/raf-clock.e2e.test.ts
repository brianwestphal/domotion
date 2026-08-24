import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import {
  installCaptureRafClock,
  reverifyCaptureRafClock,
  sampleCaptureRafClock,
} from "../src/capture/raf-clock.js";

const browser = await launchChromium({ headless: true, args: ["--site-per-process"] }).catch(() => null);

describe.skipIf(browser == null)("authenticated capture rAF clock", () => {
  afterAll(async () => { await browser?.close(); });

  it("installs before navigation, drains once at one time, and remains stable", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<script>
      globalThis.samples = [];
      requestAnimationFrame(time => samples.push(time));
    </script>`);

    const state = await sampleCaptureRafClock(page, handle, 125);
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({
      requestedTimeMs: 125,
      callbacksExecuted: 1,
      callbacksPending: 0,
      workerConstructionAttempts: 0,
      offscreenTransferAttempts: 0,
    });
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { samples: number[] }).samples)).toEqual([125]);
    await reverifyCaptureRafClock(page, handle, state);
    await context.close();
  });

  it("fails closed on recurring callbacks and worker escape attempts", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<script>
      const loop = () => requestAnimationFrame(loop);
      requestAnimationFrame(loop);
      try { new Worker(URL.createObjectURL(new Blob([''], {type:'text/javascript'}))); } catch {}
    </script>`);
    await expect(sampleCaptureRafClock(page, handle, 10)).rejects.toThrow(/callback bound exceeded/);
    await context.close();
  });

  it("rejects clocks installed after navigation", async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await page.setContent(`<script>requestAnimationFrame(() => {});</script>`);
    const handle = await installCaptureRafClock(context);
    await expect(sampleCaptureRafClock(page, handle, 0)).rejects.toThrow(/not installed before navigation/);
    await context.close();
  });

  it("orders the controlled callback before timeline seek and all capture prepasses", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<style>
      @keyframes move { from { left: 0px } to { left: 100px } }
      #target { position:absolute; animation: move 1s linear both; }
    </style><div id="target">before</div><script>
      requestAnimationFrame(time => { target.textContent = 'frame-' + time; });
    </script>`);
    const captured = await captureElementTreeWithWarnings(
      page,
      "body",
      { x: 0, y: 0, width: 300, height: 100 },
      { animationTimeMs: 250, rafClock: handle },
    );
    expect(captured.rafClockState?.targets[0]).toMatchObject({
      requestedTimeMs: 250,
      callbacksExecuted: 1,
      callbacksPending: 0,
    });
    expect(captured.animationFrameState?.requestedTimeMs).toBe(250);
    expect(await page.locator("#target").textContent()).toBe("frame-250");
    await context.close();
  });

  it("authenticates distinct main/OOPIF targets and rejects target churn", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/child") {
        response.end(`<script>globalThis.samples=[];requestAnimationFrame(t=>samples.push(t))</script>`);
      } else {
        const address = server.address();
        const port = typeof address === "object" && address != null ? address.port : 0;
        response.end(`<script>globalThis.samples=[];requestAnimationFrame(t=>samples.push(t))</script><iframe src="http://localhost:${port}/child"></iframe>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address != null ? address.port : 0;
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator("iframe").waitFor();
    const state = await sampleCaptureRafClock(page, handle, 80);
    expect(state.targets).toHaveLength(2);
    expect(new Set(state.targets.map((target) => target.targetId)).size).toBe(2);
    await page.evaluate((childUrl) => {
      const iframe = document.createElement("iframe");
      iframe.src = childUrl;
      document.body.append(iframe);
    }, `http://localhost:${port}/child?second=1`);
    await expect(reverifyCaptureRafClock(page, handle, state)).rejects.toThrow(/target state changed|target set changed/);
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
