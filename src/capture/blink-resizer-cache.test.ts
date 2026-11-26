import type { Page } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { measureBlinkPlatformResizer } from "./index.js";

/**
 * `measureBlinkPlatformResizer` caches one PROMISE per page in a WeakMap, so its states are: empty,
 * pending, resolved, and rejected-then-evicted. A real browser cannot be told to fail the probe, so a
 * Page fake drives the transitions; the screenshot is a synthetic 64x64 PNG whose custom-resizer color
 * fills a `corner`-px square, which is exactly what the pixel scan recovers.
 */
const PROBE = 64;

async function cornerPng(corner: number): Promise<Buffer> {
  const raw = Buffer.alloc(PROBE * PROBE * 3);
  for (let y = 0; y < PROBE; y++) {
    for (let x = 0; x < PROBE; x++) {
      const inCorner = x >= PROBE - corner && y >= PROBE - corner;
      const i = (y * PROBE + x) * 3;
      raw[i] = inCorner ? 1 : 255;
      raw[i + 1] = inCorner ? 254 : 0;
      raw[i + 2] = inCorner ? 2 : 253;
    }
  }
  return sharp(raw, { raw: { width: PROBE, height: PROBE, channels: 3 } })
    .png()
    .toBuffer();
}

function fakePage(png: Buffer, control: { failEvaluate: boolean }) {
  const counts = { evaluate: 0, screenshot: 0, newPage: 0 };
  const page = {
    evaluate: async () => {
      counts.evaluate++;
      await Promise.resolve();
      if (control.failEvaluate) throw new Error("probe blocked by CSP");
      return { x: 0, y: 0, scaleFromDIP: 2, probeSize: PROBE, clientWidth: 1024, clientHeight: 768 };
    },
    screenshot: async () => {
      counts.screenshot++;
      return png;
    },
    context: () => ({
      newPage: async () => {
        counts.newPage++;
        throw new Error("no context pages");
      },
      browser: () => null,
    }),
    viewportSize: () => ({ width: 1024, height: 768 }),
  };
  return { page: page as unknown as Page, counts };
}

describe("measureBlinkPlatformResizer promise cache", () => {
  it("recovers the corner size and viewport scale from the probe", async () => {
    const { page } = fakePage(await cornerPng(15), { failEvaluate: false });
    expect(await measureBlinkPlatformResizer(page)).toEqual({ themeThickness: 15, scaleFromDIP: 2 });
  });

  it("shares ONE probe among concurrent first callers, then serves later callers from the cache", async () => {
    const { page, counts } = fakePage(await cornerPng(16), { failEvaluate: false });
    const [a, b] = await Promise.all([measureBlinkPlatformResizer(page), measureBlinkPlatformResizer(page)]);
    expect(a).toEqual(b);
    expect(counts.screenshot).toBe(1);
    const evaluations = counts.evaluate;
    await measureBlinkPlatformResizer(page);
    expect(counts).toMatchObject({ screenshot: 1, evaluate: evaluations });
  });

  it("keeps one entry per page", async () => {
    const control = { failEvaluate: false };
    const small = fakePage(await cornerPng(12), control);
    const large = fakePage(await cornerPng(18), control);
    expect((await measureBlinkPlatformResizer(small.page)).themeThickness).toBe(12);
    expect((await measureBlinkPlatformResizer(large.page)).themeThickness).toBe(18);
  });

  it("evicts a rejected probe: later callers retry rather than replaying the rejection", async () => {
    const control = { failEvaluate: true };
    const { page, counts } = fakePage(await cornerPng(15), control);
    await expect(measureBlinkPlatformResizer(page)).rejects.toThrow("probe blocked by CSP");
    const afterFirst = counts.evaluate;
    expect(counts.newPage).toBe(1); // the isolated-page fallback was attempted, and failed

    control.failEvaluate = false;
    expect(await measureBlinkPlatformResizer(page)).toEqual({ themeThickness: 15, scaleFromDIP: 2 });
    expect(counts.evaluate).toBeGreaterThan(afterFirst);
    expect(counts.screenshot).toBe(1);

    // and the recovered value is now cached
    const evaluations = counts.evaluate;
    await measureBlinkPlatformResizer(page);
    expect(counts.evaluate).toBe(evaluations);
  });

  it("shares one rejection among concurrent callers, and a probe that paints no corner is also evicted", async () => {
    const control = { failEvaluate: false };
    const { page, counts } = fakePage(await cornerPng(0), control);
    const settled = await Promise.allSettled([measureBlinkPlatformResizer(page), measureBlinkPlatformResizer(page)]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(counts.screenshot).toBe(1);
    await expect(measureBlinkPlatformResizer(page)).rejects.toThrow(/painted no custom corner pixels/);
    expect(counts.screenshot).toBe(2);
  });

  it("re-probes in an isolated page widened to the probe box when the viewport is smaller than it", async () => {
    // A 160x60 capture viewport crops the 64px probe's bottom-right corner, which used to scale the
    // recovered height to 12.8 and fail the whole capture (DM-4S0WYN).
    const png = await cornerPng(15);
    const resized: Array<{ width: number; height: number }> = [];
    let isolatedViewport = { width: 160, height: 60 };
    const isolated = {
      evaluate: async () => ({
        x: 0,
        y: 0,
        scaleFromDIP: 3,
        clientWidth: isolatedViewport.width,
        clientHeight: isolatedViewport.height,
        probeSize: PROBE,
      }),
      screenshot: async () => png,
      viewportSize: () => isolatedViewport,
      setViewportSize: async (size: { width: number; height: number }) => {
        resized.push(size);
        isolatedViewport = size;
      },
      close: async () => {},
    };
    let screenshots = 0;
    const page = {
      evaluate: async (fn: unknown) => {
        // the in-page probe returns its viewport; the captured-scale read returns a number
        return String(fn).includes("clientWidth")
          ? { x: 0, y: 0, scaleFromDIP: 2, clientWidth: 160, clientHeight: 60, probeSize: PROBE }
          : 2;
      },
      screenshot: async () => {
        screenshots++;
        return png;
      },
      context: () => ({ newPage: async () => isolated, browser: () => null }),
      viewportSize: () => ({ width: 160, height: 60 }),
    } as unknown as Page;
    const metrics = await measureBlinkPlatformResizer(page);
    expect(metrics).toMatchObject({ themeThickness: 15, scaleFromDIP: 2 });
    // the in-page refusal is retained as a diagnostic, not discarded
    expect(metrics.recoveredFrom).toEqual(expect.any(String));
    expect(screenshots).toBe(0); // the cropped in-page screenshot is never taken
    expect(resized).toEqual([{ width: 160, height: 64 }]);
  });
});

/**
 * The fallback after a failed in-page probe, for a page whose own context refuses newPage (Playwright's
 * Browser.newPage() implicit context). A --single-process Chromium supports one BrowserContext only, so
 * opening the isolated page in a new context crashed or hung the whole browser; there the captured page is
 * re-probed once with a CSP-exempt constructed sheet instead. Multi-process and unknown browsers keep the
 * isolated page in a new context.
 */
describe("measureBlinkPlatformResizer isolated-page fallback by browser process model", () => {
  async function implicitContextPage(commandLine: () => Promise<{ arguments: string[] }>, failures: number) {
    const png = await cornerPng(15);
    const calls = { browserNewPage: 0, cdpSessions: 0, detached: 0, probes: [] as string[] };
    let remainingFailures = failures;
    const isolated = {
      evaluate: async () => ({ x: 0, y: 0, scaleFromDIP: 1, clientWidth: 320, clientHeight: 180, probeSize: PROBE }),
      screenshot: async () => png,
      viewportSize: () => ({ width: 320, height: 180 }),
      close: async () => {},
    };
    const browser = {
      newPage: async () => {
        calls.browserNewPage++;
        return isolated;
      },
    };
    const page = {
      evaluate: async (expression: unknown) => {
        const source = String(expression);
        if (!source.includes("clientWidth")) return source.includes("devicePixelRatio") ? 1 : 2;
        calls.probes.push(source.includes('"constructedSheet":true') ? "constructed" : "element");
        if (remainingFailures-- > 0) throw new Error(`probe failure ${calls.probes.length}`);
        return { x: 0, y: 0, scaleFromDIP: 2, clientWidth: 320, clientHeight: 180, probeSize: PROBE };
      },
      screenshot: async () => png,
      viewportSize: () => ({ width: 320, height: 180 }),
      context: () => ({
        newPage: async () => {
          throw new Error("Please use browser.newContext()");
        },
        browser: () => browser,
        newCDPSession: async () => {
          calls.cdpSessions++;
          return {
            send: async (method: string) => {
              expect(method).toBe("Browser.getBrowserCommandLine");
              return commandLine();
            },
            detach: async () => {
              calls.detached++;
            },
          };
        },
      }),
    };
    return { page: page as unknown as Page, calls };
  }

  const singleProcess = async () => ({ arguments: ["/ms-playwright/chrome-headless-shell", "--single-process"] });
  const multiProcess = async () => ({ arguments: ["/ms-playwright/chrome-headless-shell", "--headless"] });

  it("re-probes the captured page with a constructed sheet instead of opening a second BrowserContext", async () => {
    const { page, calls } = await implicitContextPage(singleProcess, 1);
    expect(await measureBlinkPlatformResizer(page)).toEqual({
      themeThickness: 15,
      scaleFromDIP: 2,
      recoveredFrom: "Error: probe failure 1",
    });
    expect(calls).toMatchObject({ browserNewPage: 0, cdpSessions: 1, detached: 1 });
    expect(calls.probes).toEqual(["element", "constructed"]);
  });

  it("fails explicitly, with the original failure as cause, when the single-process re-probe also fails", async () => {
    const { page, calls } = await implicitContextPage(singleProcess, 2);
    const error = await measureBlinkPlatformResizer(page).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/--single-process browser.*probe failure 1.*retry:.*probe failure 2/);
    expect((error as Error).cause).toEqual(new Error("probe failure 1"));
    expect(calls.browserNewPage).toBe(0);
    expect(calls.probes).toEqual(["element", "constructed"]);
  });

  it("fails with both messages, and the original failure as cause, when the isolated page also fails", async () => {
    const { page } = await implicitContextPage(multiProcess, 1);
    const browser = page.context().browser() as unknown as { newPage: () => Promise<unknown> };
    browser.newPage = async () => ({
      evaluate: async () => {
        throw new Error("isolated failure");
      },
      viewportSize: () => ({ width: 320, height: 180 }),
      close: async () => {},
    });
    const error = await measureBlinkPlatformResizer(page).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("Error: probe failure 1; isolated-page retry: Error: isolated failure");
    expect((error as Error).cause).toEqual(new Error("probe failure 1"));
  });

  it("keeps the isolated page in a new BrowserContext for a multi-process browser", async () => {
    const { page, calls } = await implicitContextPage(multiProcess, 1);
    expect(await measureBlinkPlatformResizer(page)).toEqual({
      themeThickness: 15,
      scaleFromDIP: 2,
      recoveredFrom: "Error: probe failure 1",
    });
    expect(calls.browserNewPage).toBe(1);
    expect(calls.probes).toEqual(["element"]);
  });

  it("treats an unavailable command line as unknown and keeps the multi-process fallback", async () => {
    let refusals = 0;
    const { page, calls } = await implicitContextPage(async () => {
      refusals++;
      throw new Error("Command line not returned because --enable-automation not set.");
    }, 1);
    expect(await measureBlinkPlatformResizer(page)).toMatchObject({ themeThickness: 15, scaleFromDIP: 2 });
    expect(calls.browserNewPage).toBe(1);
    expect(refusals).toBe(1);
  });
});
