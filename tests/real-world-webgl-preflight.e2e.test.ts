import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { withTimeout } from "../src/utils/with-timeout.js";
import { resolveVisualOutputRoot } from "./output-directory.mjs";
import { freezeWebGlOutput } from "./real-world-webgl-freeze.js";
import { primeOffscreenCanvases, type CanvasPreflightFailure } from "./real-world-webgl-preflight.js";
import { WEBGL_FIXTURE_LAUNCH_ARGS } from "../src/test-support/webgl-fixture-launch.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ args: [...WEBGL_FIXTURE_LAUNCH_ARGS] });
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const iframeCanvasHtml = `<!doctype html><body style="margin:0"><canvas width="40" height="40"></canvas>
<script>
  const canvas = document.querySelector('canvas');
  window.__preflightEvents = [];
  canvas.addEventListener('webglcontextlost', event => window.__preflightEvents.push({type:event.type,status:event.statusMessage,time:performance.now()}));
  const gl = canvas.getContext('webgl2');
  window.__preflightGl = gl;
  window.__preflightInitial = {lost:gl?.isContextLost() ?? null,time:performance.now()};
  const paint = () => { gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); };
  paint(); setInterval(paint, 10);
</script></body>`;

/** DM-C3HJHY: observe the original context; never create a replacement for diagnostics. */
async function canvasSourceState(canvas: Locator, phase: string) {
  return withTimeout(
    canvas
      .evaluate((element) => {
        const source = element.ownerDocument.defaultView as unknown as Window & {
          __preflightGl: WebGL2RenderingContext | null;
          __preflightInitial: { lost: boolean | null; time: number };
          __preflightEvents: { type: string; status: string; time: number }[];
        };
        return {
          available: source.__preflightGl != null,
          lost: source.__preflightGl?.isContextLost() ?? null,
          initial: source.__preflightInitial,
          events: source.__preflightEvents,
          time: performance.now(),
        };
      })
      .catch((error: unknown) => ({ diagnosticError: String(error) })),
    2_000,
    { diagnosticError: "source context witness exceeded 2000ms" },
  ).then((state) => ({ phase, ...state }));
}

async function reportWebGlFailure(page: Page, kind: string, states: unknown[]) {
  const startup = await withTimeout(
    (async () => {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const version = await cdp.send("Browser.getVersion");
        const { gpu } = await cdp.send("SystemInfo.getInfo");
        const aux: Record<string, unknown> = gpu.auxAttributes ?? {};
        return {
          version,
          features: gpu.featureStatus,
          attributes: Object.fromEntries(
            [
              "glImplementationParts",
              "glRenderer",
              "glResetNotificationStrategy",
              "processCrashCount",
              "passthroughCmdDecoder",
            ].map((key) => [key, aux[key]]),
          ),
        };
      } finally {
        await cdp.detach();
      }
    })().catch((error: unknown) => ({ diagnosticError: String(error) })),
    2_000,
    { diagnosticError: "GPU startup witness exceeded 2000ms" },
  );
  // Only an already failed fixture saves this later source frame. It is problem
  // evidence, not a replacement reference or a reason to relax the assertion.
  const source = await withTimeout(
    page.screenshot({ timeout: 2_000 }).catch(() => null),
    2_000,
    null,
  );
  const payload = { kind, states, startup, sourceMoment: "after fixture failure" };
  const directory = join(resolveVisualOutputRoot(), "webgl-startup-e2e");
  mkdirSync(directory, { recursive: true });
  const basename = `${kind}-${Date.now()}`;
  if (source != null) writeFileSync(join(directory, `${basename}-source.png`), source);
  writeFileSync(join(directory, `${basename}.json`), JSON.stringify(payload, null, 2));
  console.warn("WebGL source/startup witnesses:", JSON.stringify(payload));
}

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
      const canvasHtml = iframeCanvasHtml;
      const states: unknown[] = [];
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
        states.push(await canvasSourceState(canvas, "before warmup"));
        await page.waitForFunction(() => (window as unknown as { ticks: number }).ticks > 2);
        await page.evaluate(() => window.scrollTo(0, 123));
        const before = await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])));
        const ticks = await page.evaluate(() => (window as unknown as { ticks: number }).ticks);
        states.push(await canvasSourceState(canvas, "before offscreen presentation"));
        expect(await primeOffscreenCanvases(page)).toEqual({ primed: 1, failed: 0, skipped: 0 });
        expect(await Promise.all(page.frames().map((frame) => frame.evaluate(() => [scrollX, scrollY])))).toEqual(
          before,
        );
        await expect
          .poll(() => page.evaluate(() => (window as unknown as { ticks: number }).ticks))
          .toBeGreaterThan(ticks);
        states.push(await canvasSourceState(canvas, "before freeze"));
        expect(await freezeWebGlOutput(page)).toMatchObject({ failedFrames: 0 });
        states.push(await canvasSourceState(canvas, "after freeze, before screenshot"));
        await page.locator("#far").scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        const png = await page.screenshot({
          clip: { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, width: 1, height: 1 },
        });
        states.push(await canvasSourceState(canvas, "after screenshot"));
        expect(Array.from(await sharp(png).removeAlpha().raw().toBuffer())).toEqual([255, 0, 0]);
      } catch (error) {
        await reportWebGlFailure(page, kind, states).catch((diagnosticError: unknown) =>
          console.warn("WebGL failure diagnostics unavailable:", String(diagnosticError)),
        );
        throw error;
      } finally {
        await page.close();
      }
    },
  );

  it("records source context loss before presentation without substituting a fresh context", async () => {
    const page = await browser.newPage();
    const directory = mkdtempSync(join(tmpdir(), "webgl-loss-witness-"));
    const priorOutput = process.env["DOMOTION_OUTPUT_DIR"];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env["DOMOTION_OUTPUT_DIR"] = directory;
    try {
      await page.setContent(iframeCanvasHtml);
      const canvas = page.locator("canvas");
      expect(await canvasSourceState(canvas, "healthy source")).toMatchObject({ available: true, lost: false });
      expect(
        await canvas.evaluate((element) => {
          const source = element.ownerDocument.defaultView as unknown as Window & {
            __preflightGl: WebGL2RenderingContext;
          };
          const extension = source.__preflightGl.getExtension("WEBGL_lose_context");
          extension?.loseContext();
          return extension != null;
        }),
      ).toBe(true);
      await expect
        .poll(async () => canvasSourceState(canvas, "before presentation"))
        .toMatchObject({
          phase: "before presentation",
          available: true,
          lost: true,
          initial: { lost: false },
          events: [{ type: "webglcontextlost", status: expect.any(String), time: expect.any(Number) }],
        });
      const lost = await canvasSourceState(canvas, "before presentation");
      await reportWebGlFailure(page, "controlled-loss", [lost]);
      const files = readdirSync(join(directory, "webgl-startup-e2e"));
      expect(files.some((name) => name.endsWith("-source.png"))).toBe(true);
      const payload: unknown = JSON.parse(
        readFileSync(
          join(
            directory,
            "webgl-startup-e2e",
            files.find((name) => name.endsWith(".json"))!,
          ),
          "utf8",
        ),
      );
      expect(payload).toMatchObject({
        kind: "controlled-loss",
        states: [{ lost: true, initial: { lost: false } }],
        startup: { version: { revision: expect.any(String) } },
        sourceMoment: "after fixture failure",
      });
      expect(await canvasSourceState(canvas, "after reporting")).toMatchObject({
        lost: true,
        initial: { lost: false },
      });
    } finally {
      warning.mockRestore();
      if (priorOutput == null) delete process.env["DOMOTION_OUTPUT_DIR"];
      else process.env["DOMOTION_OUTPUT_DIR"] = priorOutput;
      await page.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares the eight-canvas screenshot budget across the main document and child frames", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(`<body style="margin:0;height:1800px">
        <canvas width="10" height="10" style="position:absolute;top:1200px"></canvas>
        <canvas width="10" height="10" style="position:absolute;top:1300px"></canvas>
        <iframe style="position:absolute;top:1000px;width:80px;height:80px" srcdoc="<body style='margin:0'>${"<canvas width=8 height=8></canvas>".repeat(8)}</body>"></iframe>
      </body>`);
      await page.frameLocator("iframe").locator("canvas").first().waitFor();
      const failures: CanvasPreflightFailure[] = [];
      const result = await primeOffscreenCanvases(page, (failure) => {
        failures.push(failure);
        console.warn(
          "Canvas preflight failure:",
          JSON.stringify({ phase: failure.phase, error: String(failure.error) }),
        );
      });
      // Preserve strict counters and the original protocol error in failures.
      // The existing named one-shot retry can recognize an actual empty-surface
      // error; an unexplained count or persistent failure still fails the test.
      expect(result, failures.map((failure) => `${failure.phase}: ${String(failure.error)}`).join("\n")).toEqual({
        primed: 8,
        failed: 0,
        skipped: 2,
      });
      expect(await page.evaluate(() => scrollY)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("reports a degenerate frame without inventing a projection", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<body style="height:1800px"><iframe style="position:absolute;top:1000px;transform:scaleX(0)" srcdoc="<canvas width=40 height=40></canvas>"></iframe></body>`,
      );
      await page.frameLocator("iframe").locator("canvas").waitFor();
      expect(await primeOffscreenCanvases(page)).toEqual({ primed: 0, failed: 0, skipped: 1 });
    } finally {
      await page.close();
    }
  });

  it("retains exact screenshot failures without changing failed capture counters", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<body style="height:1800px"><canvas width=10 height=10 style="position:absolute;top:1200px"></canvas></body>`,
      );
      const session = await page.context().newCDPSession(page);
      const error = new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(session);
      vi.spyOn(session, "send").mockRejectedValue(error);
      const failures: CanvasPreflightFailure[] = [];
      expect(await primeOffscreenCanvases(page, (failure) => failures.push(failure))).toEqual({
        primed: 0,
        failed: 1,
        skipped: 0,
      });
      expect(failures).toEqual([{ phase: "capture", error }]);
    } finally {
      vi.restoreAllMocks();
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
