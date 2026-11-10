import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { elementTreeToSvgInner } from "../render/element-tree-to-svg.js";
import type { CapturedElement } from "./types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

describe("raster intrinsic density provenance (DM-MJAMW0)", () => {
  it("distinguishes integer DOM natural dimensions from unchanged native cover paint", async () => {
    const pixels = Buffer.alloc(396 * 581 * 3);
    for (let y = 0; y < 581; y++) {
      for (let x = 0; x < 396; x++) {
        const offset = (y * 396 + x) * 3;
        pixels[offset] = y % 8 < 4 ? 255 : 0;
        pixels[offset + 1] = x % 8 < 4 ? 255 : 0;
        pixels[offset + 2] = 128;
      }
    }
    const png = await sharp(pixels, { raw: { width: 396, height: 581, channels: 3 } })
      .png()
      .toBuffer();
    const uri = `data:image/png;base64,${png.toString("base64")}`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    try {
      const screenshots: Buffer[] = [];
      const emittedImages: string[] = [];
      const dimensions: { w: number; h: number }[] = [];
      for (const responsive of [false, true]) {
        await page.setContent(
          `<body style="margin:0"><img src="${uri}" ${responsive ? `srcset="${uri} 396w" sizes="390px"` : ""} style="position:absolute;left:16px;top:104.484375px;width:358px;height:525.234375px;object-fit:cover"></body>`,
        );
        await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        screenshots.push(await page.screenshot());
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
        let image: CapturedElement | undefined;
        forEachElement(tree, (element) => {
          if (element.tag === "img") image = element;
        });
        expect(image).toBeDefined();
        expect(image?.imageIntrinsic).toBeDefined();
        dimensions.push(image!.imageIntrinsic!);
        expect(image?.imageDecodedIntrinsic).toEqual({ w: 396, h: 581 });
        emittedImages.push(/<image\b[^>]*>/.exec(elementTreeToSvgInner(tree, 390, 844))?.[0] ?? "");
      }
      expect(dimensions).toEqual([
        { w: 396, h: 581 },
        { w: 389, h: 572 },
      ]);
      // Native cover paint keeps the physical ratio despite integer DOM API truncation.
      // DM-0A2W05 owns replacing those API integers as renderer paint-size authority.
      expect(screenshots[1]).toEqual(screenshots[0]);
      expect(emittedImages[0]).not.toBe("");
      expect(emittedImages[1]).toBe(emittedImages[0]);
      expect(emittedImages[1]).toContain('height="525.2"');
    } finally {
      await page.close();
    }
  }, 60_000);
  it("records the native decoded orientation rather than encoded axis order", async () => {
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      await page.setContent(
        `<img src="data:image/jpeg;base64,${jpeg.toString("base64")}" style="object-fit:contain;width:80px;height:80px">`,
      );
      await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 100, height: 100 });
      let image: CapturedElement | undefined;
      forEachElement(tree, (element) => {
        if (element.tag === "img") image = element;
      });
      expect(image?.imageIntrinsic).toEqual({ w: 20, h: 40 });
      expect(image?.imageDecodedIntrinsic).toEqual({ w: 20, h: 40 });
      const unrotated = await page.locator("img").evaluate((element: HTMLImageElement) => {
        element.style.imageOrientation = "none";
        element.style.width = "auto";
        element.style.height = "auto";
        const box = element.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
        };
      });
      expect(unrotated).toEqual({ width: 40, height: 20, naturalWidth: 20, naturalHeight: 40 });
    } finally {
      await page.close();
    }
  });
});
