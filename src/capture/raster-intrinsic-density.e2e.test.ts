import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { elementTreeToSvg, elementTreeToSvgInner } from "../render/element-tree-to-svg.js";
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
  it("paints image-orientation:none from the stored pixel grid only for access-allowed images (DM-JPDMRD)", async () => {
    // Stored 40x20 grid, left red and right blue, tagged EXIF orientation 6.
    const half = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    const stored = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
      .composite([{ input: half, left: 20, top: 0 }])
      .png()
      .toBuffer();
    const points = [
      [5, 5],
      [35, 5],
      [5, 35],
      [35, 35],
      [60, 10],
      [10, 60],
    ];
    const sample = async (bytes: Buffer) => {
      const data = await sharp(bytes).removeAlpha().raw().toBuffer();
      return points.map(([x, y]) => [...data.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)].map((v) => v > 128));
    };
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    const generated = await browser.newPage({ viewport: { width: 100, height: 100 } });
    try {
      // DM-4G5NX9: sharp writes the AVIF orientation as an `irot` property,
      // which Blink maps to the same decoder orientation as EXIF.
      for (const format of ["jpeg", "png", "avif"] as const) {
        const bytes = await sharp(stored)
          .toFormat(format, format === "avif" ? { lossless: true } : { quality: 100 })
          .withMetadata({ orientation: 6 })
          .toBuffer();
        for (const orientation of ["none", "from-image"]) {
          for (const style of ["", "width:80px;height:80px;object-fit:contain", "width:80px;height:40px"]) {
            await page.setContent(
              `<style>body{margin:0;background:white}</style><div id=r style="width:100px;height:100px"><img src="data:image/${format};base64,${bytes.toString("base64")}" style="image-orientation:${orientation};${style}"></div>`,
            );
            await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
            const tree = await captureElementTree(page, "#r", { x: 0, y: 0, width: 100, height: 100 });
            let image: CapturedElement | undefined;
            forEachElement(tree, (element) => {
              if (element.tag === "img") image = element;
            });
            expect(image?.imageOrientationNone).toBe(orientation === "none" ? true : undefined);
            await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(tree, 100, 100)}`);
            await generated.waitForTimeout(50);
            expect(await sample(await generated.screenshot()), `${format} ${orientation} ${style}`).toEqual(
              await sample(await page.screenshot()),
            );
          }
        }
      }

      // DM-FPTFZB: a mirrored AVIF (EXIF orientations 2, 4, 5 and 7 become an
      // `imir`, plus `irot` for 5 and 7) keeps its mirror in the bytes and is
      // flipped back by the painter. Quadrants differ on both axes.
      const quadrant = (background: string) =>
        sharp({ create: { width: 20, height: 10, channels: 3, background } })
          .png()
          .toBuffer();
      const asymmetric = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
        .composite([
          { input: await quadrant("blue"), left: 20, top: 0 },
          { input: await quadrant("lime"), left: 0, top: 10 },
          { input: await quadrant("white"), left: 20, top: 10 },
        ])
        .png()
        .toBuffer();
      const grid = async (bytes: Buffer) => {
        const data = await sharp(bytes).removeAlpha().raw().toBuffer();
        const cells: string[] = [];
        for (let y = 2; y < 80; y += 5)
          for (let x = 2; x < 80; x += 5)
            cells.push(
              [...data.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)].map((v) => (v > 128 ? 1 : 0)).join(""),
            );
        return cells.join(" ");
      };
      for (const exif of [2, 4, 5, 7]) {
        const bytes = await sharp(asymmetric).avif({ lossless: true }).withMetadata({ orientation: exif }).toBuffer();
        for (const orientation of ["none", "from-image"]) {
          for (const style of ["", "width:80px;height:80px;object-fit:contain;object-position:left top"]) {
            await page.setContent(
              `<style>body{margin:0;background:white}</style><div id=r style="width:100px;height:100px"><img src="data:image/avif;base64,${bytes.toString("base64")}" style="image-orientation:${orientation};${style}"></div>`,
            );
            await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
            const tree = await captureElementTree(page, "#r", { x: 0, y: 0, width: 100, height: 100 });
            await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(tree, 100, 100)}`);
            await generated.waitForTimeout(50);
            expect(await grid(await generated.screenshot()), `avif ${exif} ${orientation} ${style}`).toEqual(
              await grid(await page.screenshot()),
            );
          }
        }
      }

      // A CORS-tainted bitmap keeps its EXIF orientation in Chromium
      // (ImageResourceContent::ForceOrientationIfNecessary).
      const jpeg = await sharp(stored).jpeg().withMetadata({ orientation: 6 }).toBuffer();
      await page.route("http://image.test/**", (route) =>
        route.fulfill({
          contentType: "image/jpeg",
          body: jpeg,
          headers: route.request().url().includes("cors") ? { "access-control-allow-origin": "*" } : {},
        }),
      );
      await page.route("http://page.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<style>body{margin:0}</style><div id=r><img id=tainted src="http://image.test/a.jpg" style="image-orientation:none"><img id=cors crossorigin=anonymous src="http://image.test/cors.jpg" style="image-orientation:none"></div>`,
        }),
      );
      await page.goto("http://page.test/");
      await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
      const sizes = await page.evaluate(() =>
        Array.from(document.images, (image) => [
          image.getBoundingClientRect().width,
          image.getBoundingClientRect().height,
        ]),
      );
      expect(sizes).toEqual([
        [20, 40],
        [40, 20],
      ]);
      const tree = await captureElementTree(page, "#r", { x: 0, y: 0, width: 100, height: 100 });
      const flags: Array<true | undefined> = [];
      forEachElement(tree, (element) => {
        if (element.tag === "img") flags.push(element.imageOrientationNone);
      });
      expect(flags).toEqual([undefined, true]);
    } finally {
      await generated.close();
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
