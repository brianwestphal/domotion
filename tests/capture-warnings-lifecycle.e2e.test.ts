import { afterAll, describe, expect, it } from "vitest";

import {
  captureElementTreeWithWarnings,
  getLastCaptureWarnings,
  launchChromium,
} from "../src/index.js";
import type { CaptureWarning } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("capture warning lifecycle", () => {
  it("publishes detached immutable snapshots across completed captures", async () => {
    const viewport = { x: 0, y: 0, width: 160, height: 90 };
    const page = await env!.browser.newPage({ viewport });
    try {
      await page.setContent('<canvas width="24" height="24"></canvas>');
      const firstResult = await captureElementTreeWithWarnings(page, "body", viewport);
      expect(firstResult.warnings.length).toBeGreaterThan(0);
      const firstSnapshot = getLastCaptureWarnings();
      expect(firstSnapshot).toEqual(firstResult.warnings);

      const originalDetail = firstSnapshot[0].detail;
      firstResult.warnings[0].detail = "caller mutation";
      firstResult.warnings.push({ selector: "body", feature: "caller", detail: "late" });
      expect(getLastCaptureWarnings()[0].detail).toBe(originalDetail);
      expect(getLastCaptureWarnings()).toHaveLength(firstSnapshot.length);
      expect(() => (firstSnapshot as CaptureWarning[]).push(firstResult.warnings[0])).toThrow(TypeError);

      await page.setContent("<div>plain</div>");
      const secondResult = await captureElementTreeWithWarnings(page, "body", viewport);
      expect(secondResult.warnings).toEqual([]);
      expect(getLastCaptureWarnings()).toEqual([]);
      expect(firstSnapshot[0].detail).toBe(originalDetail);
    } finally {
      await page.close();
    }
  });
});
