import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10">
  <style>
    rect { fill: green }
    svg:has(+ g) #negative { fill: red }
    svg:has(~ .outside) #negative { fill: orange }
    svg:has(> g) #positive { fill: blue }
    g:has(+ rect) #sibling-positive { fill: purple }
  </style>
  <g><rect id="negative" width="10" height="10"/><rect id="positive" x="10" width="10" height="10"/></g>
  <g><rect id="sibling-positive" x="20" width="10" height="10"/></g><rect x="30" width="1" height="1"/>
</svg>`;

describe("inlined image :has() arguments", () => {
  it("ignores output siblings while retaining image descendants and siblings", async () => {
    const inlined = inlineImgSvg(source, { x: 0, y: 0, w: 90, h: 30, par: "xMidYMid meet", idPrefix: "P-" });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 240, height: 100 } });
    try {
      await page.setContent(
        `<img id="source" src="data:image/svg+xml,${encodeURIComponent(source)}" width="90" height="30">` +
          `<svg id="output" xmlns="http://www.w3.org/2000/svg" width="90" height="30">${inlined}` +
          `<g class="outside"/></svg>`,
      );
      const colors = await page.evaluate(async () => {
        const image = document.getElementById("source") as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 90;
        canvas.height = 30;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 90, 30);
        const sourceColors = [15, 45, 75].map((x) => Array.from(context.getImageData(x, 15, 1, 1).data));
        const outputColors = ["negative", "positive", "sibling-positive"].map(
          (id) => getComputedStyle(document.getElementById(`P-${id}`)!).fill,
        );
        return { sourceColors, outputColors };
      });
      expect(colors.sourceColors).toEqual([
        [0, 128, 0, 255],
        [0, 0, 255, 255],
        [128, 0, 128, 255],
      ]);
      expect(colors.outputColors).toEqual(["rgb(0, 128, 0)", "rgb(0, 0, 255)", "rgb(128, 0, 128)"]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
