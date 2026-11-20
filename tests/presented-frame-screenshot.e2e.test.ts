import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import {
  screenshotAfterPresentedFrame,
  waitForPresentedFrame,
} from "../src/test-support/presented-frame-screenshot.js";

// The first capture of a freshly launched browser is the case that hosted
// runners failed with an empty surface copy, so each test launches its own.
describe("presented-frame screenshot against real Chromium", () => {
  it("captures the first frame of a fresh DPR 4 browser at the device size", async () => {
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width: 90, height: 420 }, deviceScaleFactor: 4 });
      await page.setContent(
        "<style>html,body{margin:0;background:#fff}</style><div style='width:30px;height:30px;background:#000'></div>",
      );
      const png = await screenshotAfterPresentedFrame(page);
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([360, 1680]);
      expect([...data.subarray(0, 3)]).toEqual([0, 0, 0]);
      const outside = (200 * info.width + 200) * info.channels;
      expect([...data.subarray(outside, outside + 3)]).toEqual([255, 255, 255]);
    } finally {
      await closeBrowserSafely(browser);
    }
  }, 60_000);

  it("reports a presented frame for a visible page", async () => {
    const browser = await launchChromium();
    try {
      const page = await browser.newPage();
      await page.setContent("<p>frame</p>");
      const wait = await waitForPresentedFrame(page, 5_000);
      expect(wait.presented).toBe(true);
      expect(wait.waitMs).toBeLessThan(5_000);
    } finally {
      await closeBrowserSafely(browser);
    }
  }, 60_000);
});
