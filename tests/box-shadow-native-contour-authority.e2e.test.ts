import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-H5DDDE: native authority controls, not a claim that the SVG shadow producer
// passes the separately retained strict contour probes.
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
});
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

it.each(["0px", "5px", "8px / 4px", "8px 0 3px 5px"])(
  "native coincident normal shadow paints no pixels for %s",
  async (radius) => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<style>body{margin:0}div{position:absolute;left:20px;top:20px;width:20px;height:20px;border-radius:${radius};box-shadow:0 0 0 red}</style><div></div>`,
      );
      const source = await rgba(await page.screenshot({ omitBackground: true }));
      expect(source).toEqual(Buffer.alloc(100 * 100 * 4));
    } finally {
      await page.close();
    }
  },
);

it("native plain CSS and SVG ellipses share exact coverage without a shadow", async () => {
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
  try {
    await page.setContent(
      "<style>body{margin:0}div{position:absolute;left:24px;top:24px;width:20px;height:20px;border-radius:8px / 4px;background:red}</style><div></div>",
    );
    const css = await rgba(await page.screenshot({ omitBackground: true }));
    await page.setContent(
      '<style>body{margin:0}</style><svg width="100" height="100"><rect x="24" y="24" width="20" height="20" rx="8" ry="4" fill="red"/></svg>',
    );
    expect(await rgba(await page.screenshot({ omitBackground: true }))).toEqual(css);
  } finally {
    await page.close();
  }
});
