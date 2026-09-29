import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { installCaptureRafClock, reverifyCaptureRafClock, sampleCaptureRafClock } from "../src/capture/raf-clock.js";

const browser = await launchChromium({ headless: true, args: ["--site-per-process"] }).catch(() => null);

describe.skipIf(browser == null)("authenticated capture rAF clock", () => {
  afterAll(async () => {
    await browser?.close();
  });

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

  it("does not run a queued callback that was cancelled before the drain", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<script>
      globalThis.ran = [];
      const keep = requestAnimationFrame(() => ran.push('keep'));
      const drop = requestAnimationFrame(() => ran.push('drop'));
      cancelAnimationFrame(drop);
      cancelAnimationFrame(9999); // an id that was never issued is a no-op
      cancelAnimationFrame(drop); // cancelling twice is a no-op
    </script>`);
    const state = await sampleCaptureRafClock(page, handle, 40);
    expect(state.targets[0]).toMatchObject({ callbacksExecuted: 1, callbacksPending: 0 });
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { ran: string[] }).ran)).toEqual(["keep"]);
    await context.close();
  });

  it("runs a rAF requested DURING the drain at the same time, and counts it against the bound", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    const chain = `<script>
      globalThis.times = [];
      requestAnimationFrame(t1 => {
        times.push(t1);
        requestAnimationFrame(t2 => {
          times.push(t2);
          requestAnimationFrame(t3 => times.push(t3));
        });
      });
    </script>`;
    await page.setContent(chain);
    const state = await sampleCaptureRafClock(page, handle, 75, 3);
    expect(state.targets[0]).toMatchObject({ callbacksExecuted: 3, callbacksPending: 0 });
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { times: number[] }).times)).toEqual([
      75, 75, 75,
    ]);
    await context.close();

    // One less than the chain needs: the third (innermost) request exhausts the remaining budget.
    const tight = await browser!.newContext();
    const tightHandle = await installCaptureRafClock(tight);
    const tightPage = await tight.newPage();
    await tightPage.setContent(chain);
    await expect(sampleCaptureRafClock(tightPage, tightHandle, 75, 2)).rejects.toThrow(/callback bound exceeded/);
    await tight.close();
  });

  it("lets callbacksExecuted grow between prepasses, but not the worker-attempt count", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<script>requestAnimationFrame(() => {});</script>`);
    const state = await sampleCaptureRafClock(page, handle, 5);
    expect(state.targets[0].callbacksExecuted).toBe(1);

    // After the drain the clock is frozen at 5 ms, so a late rAF runs immediately and bumps the counter.
    await page.evaluate(() => requestAnimationFrame(() => {}));
    await reverifyCaptureRafClock(page, handle, state);
    const grown = await sampleCaptureRafClock(page, handle, 5);
    expect(grown.targets[0].callbacksExecuted).toBeGreaterThan(state.targets[0].callbacksExecuted);

    // The counter may not SHRINK relative to the expectation (a page reload would reset it).
    const shrunk = {
      ...grown,
      targets: grown.targets.map((t) => ({ ...t, callbacksExecuted: t.callbacksExecuted + 100 })),
    };
    await expect(reverifyCaptureRafClock(page, handle, shrunk)).rejects.toThrow(/changed between prepasses/);

    // A blocked Worker attempt between prepasses IS a change.
    await page.evaluate(() => {
      try {
        new Worker("data:text/javascript,");
      } catch {
        /* blocked by the shim, which counts the attempt */
      }
    });
    await expect(reverifyCaptureRafClock(page, handle, grown)).rejects.toThrow(/changed between prepasses/);
    await context.close();
  });

  it("counts blocked Worker, SharedWorker and OffscreenCanvas attempts and reports NotSupportedError", async () => {
    const context = await browser!.newContext();
    const handle = await installCaptureRafClock(context);
    const page = await context.newPage();
    await page.setContent(`<canvas id="c"></canvas><script>requestAnimationFrame(() => {});</script>`);
    const errors = await page.evaluate(() => {
      const attempt = (fn: () => unknown): string => {
        try {
          fn();
          return "no throw";
        } catch (error) {
          return (error as Error).name;
        }
      };
      return [
        attempt(() => new Worker("data:text/javascript,")),
        attempt(() => new SharedWorker("data:text/javascript,")),
        attempt(() => (document.getElementById("c") as HTMLCanvasElement).transferControlToOffscreen()),
      ];
    });
    expect(errors).toEqual(["NotSupportedError", "NotSupportedError", "NotSupportedError"]);
    const state = await sampleCaptureRafClock(page, handle, 1);
    expect(state.targets[0]).toMatchObject({ workerConstructionAttempts: 2, offscreenTransferAttempts: 1 });
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
        response.end(
          `<script>globalThis.samples=[];requestAnimationFrame(t=>samples.push(t))</script><iframe src="http://localhost:${port}/child"></iframe>`,
        );
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
    await expect(reverifyCaptureRafClock(page, handle, state)).rejects.toThrow(
      /target state changed|target set changed/,
    );
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
