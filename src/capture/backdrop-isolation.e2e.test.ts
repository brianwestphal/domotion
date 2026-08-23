import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "./index.js";
import type { CapturedElement, CapturedPseudoFragmentSet } from "./types.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function findBackdropRaster(nodes: CapturedElement[]): NonNullable<CapturedElement["backdropFilterRaster"]> | undefined {
  for (const node of nodes) {
    if (node.backdropFilterRaster != null) return node.backdropFilterRaster;
    const nested = findBackdropRaster(node.children ?? []);
    if (nested != null) return nested;
  }
  return undefined;
}

function findPseudoBackdropRaster(
  nodes: CapturedElement[],
): NonNullable<CapturedPseudoFragmentSet["backdropFilterRaster"]> | undefined {
  for (const node of nodes) {
    for (const record of node.pseudoFragments ?? []) {
      if (record.backdropFilterRaster != null) return record.backdropFilterRaster;
    }
    const nested = findPseudoBackdropRaster(node.children ?? []);
    if (nested != null) return nested;
  }
  return undefined;
}

describeBrowser("backdrop-filter paint-order isolation", () => {
  it("excludes a later overlapping subtree, preserves its backdrop, and restores the live page", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 240, height: 180 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><style>
        * { box-sizing: border-box } html, body { margin: 0; width: 100%; height: 100% }
        body { background: linear-gradient(90deg, #1252a3, #e4b743) }
        #glass { position: absolute; left: 30px; top: 25px; width: 130px; height: 100px;
          background: rgba(255,255,255,.2); backdrop-filter: blur(7px) saturate(1.4) }
        #later { position: absolute; left: 80px; top: 55px; width: 100px; height: 90px; background: #ef2350 }
      </style><div id="glass"><span>sampled backdrop</span></div><div id="later"><span>later paint</span></div>`);

      const { tree, warnings } = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 240, height: 180 },
      );
      const raster = findBackdropRaster(tree);
      expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(warnings.filter((warning) => warning.feature === "backdrop-filter")).toEqual([]);
      expect(await page.locator("#later").evaluate((el) => getComputedStyle(el).visibility)).toBe("visible");
      expect(await page.locator("#glass").getAttribute("data-domotion-backdrop-raster")).toBeNull();

      const clip = { x: raster!.x, y: raster!.y, width: raster!.width, height: raster!.height };
      const withLaterPaint = await page.screenshot({ clip, omitBackground: true, type: "png" });
      await page.locator("#later").evaluate((el) => { (el as HTMLElement).style.visibility = "hidden"; });
      await page.locator("#glass > span").evaluate((el) => { (el as HTMLElement).style.visibility = "hidden"; });
      const expected = await page.screenshot({ clip, omitBackground: true, type: "png" });
      const actual = Buffer.from(raster!.dataUri!.slice("data:image/png;base64,".length), "base64");
      const [actualRaw, expectedRaw, paintedRaw] = await Promise.all([
        sharp(actual).raw().toBuffer(), sharp(expected).raw().toBuffer(), sharp(withLaterPaint).raw().toBuffer(),
      ]);
      const meanDiff = (a: Buffer, b: Buffer) => {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
      };
      expect(meanDiff(actualRaw, expectedRaw)).toBeLessThan(1);
      expect(meanDiff(actualRaw, expectedRaw)).toBeLessThan(meanDiff(actualRaw, paintedRaw) / 10);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("keeps an exact generated-pseudo source surface silent and separate from its host", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 240, height: 180 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><style>
        * { box-sizing: border-box } html, body { margin: 0; width: 100%; height: 100% }
        body { background: linear-gradient(90deg, #174d96, #efbd3c) }
        #host { position: relative; margin: 28px; width: 150px; height: 100px; color: white }
        #host::before { content: ""; position: absolute; inset: 8px; display: block;
          background: rgba(255,255,255,.16); backdrop-filter: blur(6px) saturate(1.3) }
      </style><div id="host">host vectors</div>`);

      const { tree, warnings } = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 240, height: 180 },
      );
      const pseudoRaster = findPseudoBackdropRaster(tree);
      expect(pseudoRaster).toMatchObject({
        isolated: true,
        source: "chromium-prior-parent-device",
      });
      expect(pseudoRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(findBackdropRaster(tree)).toBeUndefined();
      expect(warnings.filter((warning) => warning.feature === "backdrop-filter"
        || warning.feature === "generated-pseudo-backdrop-filter")).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
