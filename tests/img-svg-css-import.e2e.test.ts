import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { inlineImgSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const externalSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
  <style>@import url("/import.css");</style>
  <rect id="paint" width="40" height="40" fill="green"/>
</svg>`;
const dataSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
  <style>@import url("data:text/css,rect%7Bfill%3Ared%7D");</style>
  <rect width="40" height="40" fill="green"/>
</svg>`;

describe("CSS imports in SVG image resources", () => {
  it("preserves imported layer and condition order for the root font cascade", async () => {
    const imported = `svg { font-size: 30px }`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><style>
      @import url("data:text/css,${encodeURIComponent(imported)}") layer(first) supports(display: block) screen;
      @layer second { svg { font-size: 40px } }
      svg { transform: translate(1em, 0); transform-origin: 0 0 }
    </style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "L-",
      supportsConditions: { "(display: block)": true },
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage({ viewport: { width: 210, height: 100 } });
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img src="data:image/svg+xml,${encodeURIComponent(source)}" width="100" height="100" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
      );
      const pixels = await sharp(await page.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      const color = (x: number): number[] => {
        const at = (10 * pixels.info.width + x) * pixels.info.channels;
        return Array.from(pixels.data.subarray(at, at + 3));
      };
      expect(color(45)).toEqual([255, 0, 0]);
      expect(color(35)).toEqual([255, 255, 255]);
      expect(color(155)).toEqual(color(45));
      expect(color(145)).toEqual(color(35));
    } finally {
      await page.close();
    }
  }, 60_000);

  it("uses a data-imported root font size for an em transform in image mode", async () => {
    const css = `svg { font-size: 30px; transform: translate(1em, 0); transform-origin: 0 0 }`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><style>@import url("data:text/css,${encodeURIComponent(css)}");</style><rect width="20" height="20" fill="red"/></svg>`;
    const inlined = inlineImgSvg(source, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      par: "xMidYMid meet",
      documentViewport: true,
      idPrefix: "P-",
    });
    expect(inlined).not.toBeNull();
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<body style="margin:0;background:white"><img id="image" src="data:image/svg+xml,${encodeURIComponent(source)}" style="position:absolute;left:0;top:0">` +
          `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="position:absolute;left:110px;top:0">${inlined}</svg></body>`,
      );
      const colors = await page.evaluate(async () => {
        const image = document.getElementById("image") as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return [10, 35].map((x) => Array.from(context.getImageData(x, 10, 1, 1).data));
      });
      expect(colors).toEqual([
        [0, 0, 0, 0],
        [255, 0, 0, 255],
      ]);
      const rendered = await page.screenshot();
      const pixels = await sharp(rendered).raw().toBuffer({ resolveWithObject: true });
      const color = (x: number, y: number): number[] => {
        const at = (y * pixels.info.width + x) * pixels.info.channels;
        return Array.from(pixels.data.subarray(at, at + 3));
      };
      expect(color(145, 10)).toEqual(color(35, 10));
      expect(color(120, 10)).toEqual(color(10, 10));
    } finally {
      await page.close();
    }
  }, 60_000);

  it("blocks HTTP and blob imports in image mode but allows data imports", async () => {
    const page = await browser.newPage();
    const inlinedExternal = inlineImgSvg(externalSource, {
      x: 0,
      y: 0,
      w: 40,
      h: 40,
      par: "xMidYMid meet",
      idPrefix: "E-",
    });
    expect(inlinedExternal).not.toBeNull();
    expect(inlinedExternal).not.toContain("@import");
    let cssRequests = 0;
    await page.route("https://domotion.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/import.css") {
        cssRequests++;
        await route.fulfill({ contentType: "text/css", body: "rect { fill: red } svg { font-size: 30px }" });
      } else if (path === "/image.svg") {
        await route.fulfill({ contentType: "image/svg+xml", body: externalSource });
      } else {
        await route.fulfill({
          contentType: "text/html",
          body: `<img id="external" src="/image.svg"><img id="data"><img id="blob"><svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${inlinedExternal}</svg>`,
        });
      }
    });
    try {
      await page.goto("https://domotion.test/");
      await page.evaluate(async (source) => {
        const data = document.getElementById("data") as HTMLImageElement;
        data.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
        const cssUrl = URL.createObjectURL(new Blob(["rect { fill: red }"], { type: "text/css" }));
        const blobSource = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>@import url("${cssUrl}");</style><rect width="40" height="40" fill="green"/></svg>`;
        const blob = document.getElementById("blob") as HTMLImageElement;
        blob.src = `data:image/svg+xml,${encodeURIComponent(blobSource)}`;
        await Promise.all(Array.from(document.images).map((image) => image.decode()));
      }, dataSource);
      const imageColors = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 40;
        canvas.height = 40;
        const context = canvas.getContext("2d")!;
        return ["external", "data", "blob"].map((id) => {
          context.clearRect(0, 0, 40, 40);
          context.drawImage(document.getElementById(id) as HTMLImageElement, 0, 0);
          return Array.from(context.getImageData(20, 20, 1, 1).data).slice(0, 3);
        });
      });
      const imageCssRequests = cssRequests;
      expect(await page.locator("#E-paint").evaluate((rect) => getComputedStyle(rect).fill)).toBe("rgb(0, 128, 0)");
      await page.goto("https://domotion.test/image.svg");
      const documentStyles = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          fill: getComputedStyle(document.querySelector("rect")!).fill,
          fontSize: getComputedStyle(root).fontSize,
        };
      });
      expect(imageColors).toEqual([
        [0, 128, 0],
        [255, 0, 0],
        [0, 128, 0],
      ]);
      expect(imageCssRequests).toBe(0);
      expect(documentStyles).toEqual({ fill: "rgb(255, 0, 0)", fontSize: "30px" });
      expect(cssRequests).toBe(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});
