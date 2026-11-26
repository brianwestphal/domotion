import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import { primeDecodedImageRatios } from "./decoded-image-ratio.js";
import { getLastCaptureWarnings } from "./warnings.js";
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
      let lastTree: CapturedElement[] = [];
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
        lastTree = tree;
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
      // ImagePainter::PaintIntoRect (core/paint/image_painter.cc:205-239,
      // Chromium 7d859f27) draws into ToPixelSnappedRect of the cover rect
      // (y 104.484375 rounds to 104; bottom 629.71875 rounds to 630), not the
      // fractional DOM content box, independent of any paint isolation. The
      // unchanged native-screenshot arm above is the reference: the snapped
      // emission must reproduce it exactly (the fractional one did not).
      expect(emittedImages[1]).toMatch(/ y="104" width="358" height="526"/);
      const meanError = async (tree: CapturedElement[]) => {
        await page.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(tree, 390, 844)}`);
        await page.waitForTimeout(50);
        const [a, b] = await Promise.all(
          [await page.screenshot(), screenshots[0]].map((png) => sharp(png).removeAlpha().raw().toBuffer()),
        );
        let total = 0;
        for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
        return total / a.length;
      };
      const snapped = await meanError(lastTree);
      forEachElement(lastTree, (element) => {
        delete element.imagePaintBasis;
      });
      const fractional = await meanError(lastTree);
      expect(snapped).toBe(0);
      expect(fractional).toBeGreaterThan(0);
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

  describe("responsive natural size for object-fit none and scale-down", () => {
    let uri: string;
    beforeAll(async () => {
      const bytes = await sharp({ create: { width: 396, height: 581, channels: 3, background: "red" } })
        .png()
        .toBuffer();
      uri = `data:image/png;base64,${bytes.toString("base64")}`;
    });
    // Red coverage summed along the middle row and column: the painted object
    // size in fractional pixels, so 389 versus 389.98 is visible.
    const redExtent = async (png: Buffer) => {
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const red = (x: number, y: number) => {
        const o = (y * info.width + x) * 3;
        return Math.max(0, Math.min(1, (data[o] - data[o + 1]) / 255));
      };
      let w = 0;
      let h = 0;
      const my = Math.floor(info.height / 2);
      const mx = Math.floor(info.width / 2);
      for (let x = 0; x < info.width; x++) w += red(x, my);
      for (let y = 0; y < info.height; y++) h += red(mx, y);
      return { w, h };
    };
    const captureImage = async (page: Page) => {
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 800 });
      let image: CapturedElement | undefined;
      forEachElement(tree, (element) => {
        if (element.tag === "img") image = element;
      });
      expect(image).toBeDefined();
      return { tree, image: image!, warnings: [...getLastCaptureWarnings()] };
    };
    const renderExtent = async (generated: Page, tree: CapturedElement[]) => {
      await generated.setContent(`<style>body{margin:0}</style>${elementTreeToSvg(tree, 800, 800)}`);
      await generated.waitForTimeout(50);
      return redExtent(await generated.screenshot());
    };
    const extents = async (page: Page, generated: Page, html: string) => {
      await page.setContent(`<body style="margin:0;background:white">${html}</body>`);
      await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
      const native = await redExtent(await page.screenshot());
      const { tree, image, warnings } = await captureImage(page);
      const captured = { ...image };
      const rendered = await renderExtent(generated, tree);
      // Negative control: the same tree with only the legacy DOM integers.
      delete image.imageLayoutNatural;
      delete image.imageDecodedIntrinsic;
      const legacy = await renderExtent(generated, tree);
      return { native, rendered, legacy, image: captured, warnings };
    };

    it("paints none at Blink's fractional density-corrected natural size", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
      const generated = await browser.newPage({ viewport: { width: 800, height: 800 } });
      try {
        for (const [sizes, dom, natural] of [
          ["390px", { w: 389, h: 572 }, { w: 389.984375, h: 572.1875 }],
          ["358px", { w: 358, h: 525 }, { w: 357.984375, h: 525.234375 }],
          ["389.99px", { w: 389, h: 572 }, { w: 389.96875, h: 572.171875 }],
        ] as const) {
          const { native, rendered, legacy, image, warnings } = await extents(
            page,
            generated,
            `<img srcset="${uri} 396w" sizes="${sizes}" style="display:block;width:700px;height:700px;object-fit:none">`,
          );
          expect(image.imageIntrinsic, sizes).toEqual(dom);
          expect(image.imageLayoutNatural, sizes).toEqual(natural);
          expect(warnings.filter((warning) => warning.feature === "raster-intrinsic-ratio")).toEqual([]);
          // Chromium paints the pixel snap of the fractional object rect
          // (ImagePainter::PaintIntoRect, ToPixelSnappedRect,
          // core/paint/image_painter.cc:205-239, Chromium 7d859f27). The SVG
          // now emits the same snap from the image's local paint basis, so its
          // extents match native rather than the unsnapped natural size.
          expect(Math.abs(rendered.w - native.w), sizes).toBeLessThan(0.05);
          expect(Math.abs(rendered.h - native.h), sizes).toBeLessThan(0.05);
          expect(Math.abs(native.w - natural.w), sizes).toBeLessThan(1);
          expect(Math.abs(native.h - natural.h), sizes).toBeLessThan(1);
          // Negative control: the truncated DOM integers paint a different size.
          expect(Math.abs(legacy.w - native.w) + Math.abs(legacy.h - native.h), sizes).toBeGreaterThan(0.15);
        }
      } finally {
        await generated.close();
        await page.close();
      }
    }, 60_000);

    it("matches Blink's snapped scale-down destination after responsive density reversal (DM-4SA0HW)", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 });
      const generated = await browser.newPage({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 });
      const rgba = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
      const render = async (tree: CapturedElement[]) => {
        await generated.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 800, 800)}`);
        return generated.screenshot();
      };
      try {
        for (const { attrs, style, expected, reverted } of [
          {
            attrs: `srcset="${uri} 396w" sizes="195px"`,
            style: "width:700px;height:700px",
            expected: { w: 396, h: 580 },
            reverted: { w: 396, h: 580.984375 },
          },
          {
            attrs: `srcset="${uri} 396w" sizes="390px"`,
            style: "width:700px;height:700px",
            expected: { w: 396, h: 581 },
            reverted: { w: 396, h: 581 },
          },
          {
            attrs: `srcset="${uri} 396w" sizes="195px"`,
            style: "margin:7.375px;width:234.25px;height:310.375px;object-position:35% 65%",
            expected: undefined,
            reverted: { w: 396, h: 580.984375 },
          },
          {
            attrs: `src="${uri}"`,
            style: "width:700px;height:700px",
            expected: { w: 396, h: 581 },
            reverted: undefined,
          },
        ]) {
          await page.setContent(
            `<body style="margin:0;background:white"><img ${attrs} style="display:block;${style};object-fit:scale-down"></body>`,
          );
          await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
          const native = await page.screenshot();
          const { tree, image } = await captureImage(page);
          expect(image.imageDecodedIntrinsic).toEqual({ w: 396, h: 581 });
          expect(image.imageLayoutNatural).toBeUndefined();
          expect(image.imageScaleDownIntrinsic).toEqual(reverted);
          expect(image.imagePaintBasis).toBeDefined();
          if (expected != null) expect(await redExtent(native)).toEqual(expected);
          const nativeRgba = await rgba(native);
          expect((await rgba(await render(tree))).equals(nativeRgba)).toBe(true);

          if (expected?.h === 580) {
            // Keep the paint-basis snap and remove only the density reversal.
            // The legacy rect adds one full row and changes no other pixel.
            delete image.imageScaleDownIntrinsic;
            const approximated = await render(tree);
            expect(await redExtent(approximated)).toEqual({ w: 396, h: 581 });
            const oldRgba = await rgba(approximated);
            let changed = 0;
            for (let i = 0; i < oldRgba.length; i += 4) {
              if (oldRgba.readUInt32LE(i) !== nativeRgba.readUInt32LE(i)) changed++;
            }
            expect(changed).toBe(396);
          }
        }
      } finally {
        await generated.close();
        await page.close();
      }
    }, 60_000);

    it("declines descriptor replay when response headers own image density", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
      try {
        await page.route("https://example.test/scale-down.png", (route) =>
          route.fulfill({
            contentType: "image/png",
            headers: { "Content-DPR": "2" },
            body: Buffer.from(uri.split(",")[1], "base64"),
          }),
        );
        await page.setContent(
          '<body style="margin:0"><img srcset="https://example.test/scale-down.png 396w" sizes="195px" style="display:block;width:700px;height:700px;object-fit:scale-down"></body>',
        );
        await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        const { image } = await captureImage(page);
        expect(image.imageIntrinsic).toEqual({ w: 198, h: 290 });
        expect(image.imageDecodedIntrinsic).toEqual({ w: 396, h: 581 });
        expect(image.imageScaleDownIntrinsic).toBeUndefined();
      } finally {
        await page.close();
      }
    }, 60_000);

    it("probes only srcset-origin sources and refuses ambiguous or layout-dependent candidates", async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
      try {
        const natural = async (html: string) => {
          await page.setContent(`<body style="margin:0">${html}</body>`);
          await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
          const { image, warnings } = await captureImage(page);
          return {
            natural: image.imageLayoutNatural,
            warnings: warnings
              .filter((warning) => warning.feature === "raster-intrinsic-ratio")
              .map((warning) => warning.detail),
          };
        };
        const fit = `style="width:700px;height:700px;object-fit:none"`;
        // src only: density 1, so the DOM integers are already exact.
        expect(await natural(`<img src="${uri}" ${fit}>`)).toEqual({ natural: undefined, warnings: [] });
        // An x descriptor selected from a <picture> <source>.
        expect(await natural(`<picture><source srcset="${uri} 3x"><img src="data:," ${fit}></picture>`)).toEqual({
          natural: { w: 131.984375, h: 193.65625 },
          warnings: [],
        });
        // The same URL under two different descriptors is ambiguous.
        const ambiguous = await natural(`<img src="${uri}" srcset="${uri} 2x" ${fit}>`);
        expect(ambiguous.natural).toBeUndefined();
        expect(ambiguous.warnings).toEqual([expect.stringContaining("different descriptors")]);
        // sizes=auto depends on the source's own box, which a probe cannot share.
        const auto = await natural(`<img loading="lazy" srcset="${uri} 396w" sizes="auto, 200px" ${fit}>`);
        expect(auto.natural).toBeUndefined();
        expect(auto.warnings).toEqual([expect.stringContaining("sizes=auto")]);
        // Fits other than none never run the probe.
        expect(
          await natural(`<img srcset="${uri} 396w" sizes="390px" style="width:70px;height:70px;object-fit:fill">`),
        ).toEqual({ natural: undefined, warnings: [] });
      } finally {
        await page.close();
      }
    }, 60_000);

    it("neither mutates nor refetches the source and removes its probe host", async () => {
      // A real server, not page.route: request interception disables the
      // caches, so a routed page refetches even what the document's list of
      // available images would reuse.
      let requests = 0;
      const bytes = Buffer.from(uri.split(",")[1], "base64");
      const server = createServer((request, response) => {
        if (request.url === "/a.png") {
          requests++;
          response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
          response.end(bytes);
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<body style="margin:0"><img srcset="/a.png 396w" sizes="390px" style="width:700px;height:700px;object-fit:none"></body>`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
      try {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
        await page.evaluate(() => {
          const records: string[] = [];
          new MutationObserver((list) => {
            for (const record of list)
              if (record.type !== "childList" || record.target !== document.documentElement)
                records.push(`${record.type}:${record.attributeName ?? ""}`);
          }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
          Object.defineProperty(window, "__sourceMutations", { value: records });
        });
        const prime = await primeDecodedImageRatios(page);
        try {
          expect(prime.warnings).toEqual([]);
          const after = await page.evaluate(() => ({
            mutations: (window as Window & { __sourceMutations?: string[] }).__sourceMutations,
            children: document.documentElement.children.length,
            natural: (() => {
              const image = document.images[0];
              return [image.naturalWidth, image.naturalHeight, image.currentSrc];
            })(),
          }));
          expect(after).toEqual({ mutations: [], children: 2, natural: [389, 572, `http://127.0.0.1:${port}/a.png`] });
        } finally {
          await prime.dispose();
        }
        expect(requests).toBe(1);
      } finally {
        await page.close();
        server.close();
      }
    }, 60_000);
  });
});
