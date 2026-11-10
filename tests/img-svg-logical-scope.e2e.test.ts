import type { Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { resolveImageNamespace } from "../src/render/svg-image-namespace.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10">
  <style>
    rect { fill: green }
    .nth:nth-child(1 of body rect) { fill: purple }
    .is:is(body rect) { fill: red }
    .not:not(body rect) { fill: blue }
    .where:where(body rect) { fill: orange }
  </style>
  <rect id="nth" class="nth" width="10" height="10"/>
  <rect id="is" class="is" x="10" width="10" height="10"/>
  <rect id="not" class="not" x="20" width="10" height="10"/>
  <rect id="where" class="where" x="30" width="10" height="10"/>
</svg>`;

describe("inlined image logical selector lists", () => {
  it("cannot use the output body as an ancestor inside a nested selector", async () => {
    const inlined = inlineImgSvg(source, { x: 0, y: 0, w: 120, h: 30, par: "xMidYMid meet", idPrefix: "P-" });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 240, height: 100 } });
    try {
      await page.setContent(
        `<body><img id="source" src="data:image/svg+xml,${encodeURIComponent(source)}" width="120" height="30">` +
          `<svg id="output" xmlns="http://www.w3.org/2000/svg" width="120" height="30">${inlined}</svg></body>`,
      );
      const colors = await page.evaluate(async (sourcePrefix) => {
        const image = document.getElementById("source") as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 30;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 120, 30);
        const sourceColors = [15, 45, 75, 105].map((x) => Array.from(context.getImageData(x, 15, 1, 1).data));
        const outputColors = ["nth", "is", "not", "where"].map(
          (id) => getComputedStyle(document.getElementById(`${sourcePrefix}${id}`)!).fill,
        );
        return { sourceColors, outputColors };
      }, resolveImageNamespace("P-").sourcePrefix);
      expect(colors.sourceColors).toEqual([
        [0, 128, 0, 255],
        [0, 128, 0, 255],
        [0, 0, 255, 255],
        [0, 128, 0, 255],
      ]);
      expect(colors.outputColors).toEqual(["rgb(0, 128, 0)", "rgb(0, 128, 0)", "rgb(0, 0, 255)", "rgb(0, 128, 0)"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("preserves ID selectors followed by pseudos, including an escaped colon", async () => {
    const idSource = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10">
      <style>
        rect { fill: green }
        #plain:not(body rect) { fill: blue }
        #escaped\\:name:is(rect) { fill: red }
      </style>
      <rect id="plain" width="10" height="10"/>
      <rect id="escaped:name" x="10" width="10" height="10"/>
    </svg>`;
    const inlined = inlineImgSvg(idSource, { x: 0, y: 0, w: 120, h: 60, par: "xMidYMid meet", idPrefix: "P-" });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 240, height: 150 } });
    try {
      await page.setContent(
        `<body><img id="source" src="data:image/svg+xml,${encodeURIComponent(idSource)}" width="120" height="60">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">${inlined}</svg></body>`,
      );
      const colors = await page.evaluate(async (sourcePrefix) => {
        const image = document.getElementById("source") as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 60;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, 120, 60);
        const sourceColors = [30, 90].map((x) => Array.from(context.getImageData(x, 30, 1, 1).data));
        const outputColors = ["plain", "escaped:name"].map(
          (id) => getComputedStyle(document.getElementById(`${sourcePrefix}${id}`)!).fill,
        );
        return { sourceColors, outputColors };
      }, resolveImageNamespace("P-").sourcePrefix);
      expect(colors.sourceColors).toEqual([
        [0, 0, 255, 255],
        [255, 0, 0, 255],
      ]);
      expect(colors.outputColors).toEqual(["rgb(0, 0, 255)", "rgb(255, 0, 0)"]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
