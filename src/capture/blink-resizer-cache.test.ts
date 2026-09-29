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
      return { x: 0, y: 0, scaleFromDIP: 2 };
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
});
