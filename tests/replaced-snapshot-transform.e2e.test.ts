import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  captureElementTree,
  captureElementTreeWithWarnings,
  elementTreeToSvgInner,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

async function colorBounds(
  png: Buffer,
  rgb: [number, number, number],
): Promise<{ minX: number; minY: number; maxX: number; maxY: number; pixels: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (Math.abs(data[offset] - rgb[0]) > 18
          || Math.abs(data[offset + 1] - rgb[1]) > 18
          || Math.abs(data[offset + 2] - rgb[2]) > 18) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels++;
    }
  }
  if (pixels === 0) throw new Error(`color ${rgb.join(",")} was absent`);
  return { minX, minY, maxX, maxY, pixels };
}

function maxBoundsDelta(
  a: Awaited<ReturnType<typeof colorBounds>>,
  b: Awaited<ReturnType<typeof colorBounds>>,
): number {
  return Math.max(
    Math.abs(a.minX - b.minX),
    Math.abs(a.minY - b.minY),
    Math.abs(a.maxX - b.maxX),
    Math.abs(a.maxY - b.maxY),
  );
}

describeBrowser("DM-2380 transformed replaced snapshots", () => {
  it("matches nested affine, off-page, zoom, scroll, and DPR ink without absorbing vector siblings", async () => {
    const width = 380;
    const height = 280;
    const page = await env!.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const rendered = await env!.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white}body{height:1000px}
        .outer{position:absolute;left:8px;top:340px;width:200px;height:130px;zoom:1.1;transform:rotate(11deg);transform-origin:35px 20px}
        .inner{position:absolute;left:-22px;top:18px;transform:scale(1.08,.88) skewX(7deg);transform-origin:15px 12px}
        canvas{display:block;width:130px;height:78px}
        .vector{position:fixed;left:300px;top:20px;width:32px;height:28px;background:rgb(0,187,85)}
      </style><div class="outer"><div class="inner"><canvas id="surface" width="130" height="78"></canvas></div></div><div class="vector"></div>`);
      await page.locator("#surface").evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("2d")!;
        context.fillStyle = "rgb(237,18,52)";
        context.fillRect(0, 0, 37, 78);
        context.fillStyle = "rgb(22,78,232)";
        context.fillRect(37, 0, 93, 78);
      });
      await page.evaluate(() => scrollTo(0, 300));
      const expected = await page.screenshot();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      const nodes = walk(tree);
      const canvas = nodes.find((node) => node.tag === "canvas")!;
      const snapshot = canvas.replacedSnapshot!;

      expect(snapshot.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(snapshot.rasterToOutput).toBeDefined();
      expect(snapshot.rasterToOutput!.cssPerPixelX).toBeCloseTo(0.5, 6);
      expect(snapshot.rasterToOutput!.cssPerPixelY).toBeCloseTo(0.5, 6);
      expect(snapshot.rasterToOutput!.pixelWidth * snapshot.rasterToOutput!.cssPerPixelX)
        .toBeCloseTo(snapshot.width, 6);
      expect(snapshot.rasterToOutput!.pixelHeight * snapshot.rasterToOutput!.cssPerPixelY)
        .toBeCloseTo(snapshot.height, 6);
      expect(snapshot.rasterToOutput!.contentQuad[0]).toBeLessThan(0);
      expect(nodes.filter((node) => node.styles.transform !== "none")).toHaveLength(2);
      expect(await page.evaluate(() => ({
        scrollY,
        outerTransform: getComputedStyle(document.querySelector(".outer")!).transform,
        innerTransform: getComputedStyle(document.querySelector(".inner")!).transform,
        ridCount: document.querySelectorAll("[data-domotion-rid]").length,
        targetCount: document.querySelectorAll("[data-domotion-snapshot-target]").length,
      }))).toMatchObject({
        scrollY: 300,
        outerTransform: expect.stringMatching(/^matrix\(/),
        innerTransform: expect.stringMatching(/^matrix\(/),
        ridCount: 0,
        targetCount: 0,
      });

      const body = elementTreeToSvgInner(tree, width, height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
      expect(occurrences(body, snapshot.dataUri!)).toBe(1);
      expect(body).toContain('fill="rgb(0,187,85)"');
      await rendered.setContent(`<img alt="rendered" style="display:block" src="data:image/svg+xml,${encodeURIComponent(svg)}">`);
      const actual = await rendered.locator("img").screenshot();

      for (const color of [
        [237, 18, 52],
        [22, 78, 232],
      ] as Array<[number, number, number]>) {
        expect(maxBoundsDelta(await colorBounds(expected, color), await colorBounds(actual, color)))
          .toBeLessThanOrEqual(3);
      }
      // This control catches an isolation regression that turns the canvas
      // crop into a larger sibling-composited bitmap.
      expect(maxBoundsDelta(
        await colorBounds(expected, [0, 187, 85]),
        await colorBounds(actual, [0, 187, 85]),
      )).toBe(0);
    } finally {
      await page.close();
      await rendered.close();
    }
  }, 60_000);

  it("samples the local surface before a scrolled ancestor overflow clip applies after rotation", async () => {
    const width = 260;
    const height = 190;
    const page = await env!.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const rendered = await env!.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    try {
      await page.setContent(`<style>
        html,body{margin:0;background:white}
        .clip{position:absolute;left:0;top:35px;width:105px;height:105px;overflow:hidden}
        .surface{position:absolute;left:0;top:12px;width:150px;height:90px;transform:rotate(11deg);transform-origin:25px 20px}
        canvas{display:block;width:150px;height:90px}
      </style><div class="clip"><div class="surface"><canvas width="150" height="90"></canvas></div></div>`);
      await page.locator("canvas").evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("2d")!;
        context.fillStyle = "rgb(237,18,52)";
        context.fillRect(0, 0, 75, 90);
        context.fillStyle = "rgb(22,78,232)";
        context.fillRect(75, 0, 75, 90);
      });
      await page.locator(".clip").evaluate((element) => { element.scrollLeft = 32; });
      const expected = await page.screenshot();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      const nodes = walk(tree);
      const snapshot = nodes.find((node) => node.tag === "canvas")!.replacedSnapshot!;

      expect(snapshot.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(snapshot.rasterToOutput).toBeDefined();
      expect(snapshot.rasterToOutput!.contentQuad[0]).toBeLessThan(0);
      expect(await page.locator(".clip").evaluate((element) => ({
        overflow: getComputedStyle(element).overflow,
        scrollLeft: element.scrollLeft,
        markerCount: document.querySelectorAll("[data-domotion-snapshot-target]").length,
      }))).toEqual({ overflow: "hidden", scrollLeft: 32, markerCount: 0 });

      const body = elementTreeToSvgInner(tree, width, height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
      expect(occurrences(body, snapshot.dataUri!)).toBe(1);
      expect(body).toContain("<clipPath");
      await rendered.setContent(`<img alt="rendered" style="display:block" src="data:image/svg+xml,${encodeURIComponent(svg)}">`);
      const actual = await rendered.locator("img").screenshot();

      // If the ancestor clip remains active while the off-page local surface
      // is translated for sampling, it removes the far blue edge before the
      // renderer rotates and clips the bitmap. That old ordering misses about
      // 50 device pixels here, far outside this independent raster bound.
      for (const color of [
        [237, 18, 52],
        [22, 78, 232],
      ] as Array<[number, number, number]>) {
        expect(maxBoundsDelta(await colorBounds(expected, color), await colorBounds(actual, color)))
          .toBeLessThanOrEqual(3);
      }
    } finally {
      await page.close();
      await rendered.close();
    }
  }, 60_000);

  it("maps a DPR-scaled source crop to live scaled CSS geometry without a one-pixel assumption", async () => {
    const width = 240;
    const height = 170;
    const page = await env!.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    const directory = await mkdtemp(join(tmpdir(), "domotion-dm2380-"));
    const sourcePath = join(directory, "source.png");
    try {
      await page.setContent(`<style>html,body{margin:0;background:white}canvas{position:absolute;left:-12.25px;top:24.5px;width:80px;height:60px;transform:matrix3d(1.5,0,0,0,0,.75,0,0,0,0,1,0,0,0,0,1);transform-origin:0 0}</style><canvas width="80" height="60"></canvas>`);
      await page.locator("canvas").evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("2d")!;
        context.fillStyle = "rgb(237,18,52)";
        context.fillRect(0, 0, 80, 60);
      });
      await writeFile(sourcePath, await page.screenshot());
      const { tree } = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width, height },
        { rasterizeFromImagePath: sourcePath },
      );
      const snapshot = walk(tree).find((node) => node.tag === "canvas")!.replacedSnapshot!;
      const mapping = snapshot.rasterToOutput!;
      const metadata = await sharp(Buffer.from(snapshot.dataUri!.split(",")[1], "base64")).metadata();

      expect(mapping.pixelWidth).toBe(metadata.width);
      expect(mapping.pixelHeight).toBe(metadata.height);
      expect(mapping.cssPerPixelX).toBeCloseTo(0.5, 6);
      expect(mapping.cssPerPixelY).toBeCloseTo(0.5, 6);
      expect(snapshot.x).toBe(0);
      // The live scaled content spans -12.25..107.75 CSS px. The DPR-2
      // source crop starts at pixel 0 and snaps its far edge to pixel 216,
      // hence an exact 108 CSS-px destination (not a 108 bitmap-px guess).
      expect(snapshot.width).toBeCloseTo(108, 6);
      expect(mapping.contentQuad[0]).toBeCloseTo(-12.25, 3);
      expect(mapping.contentQuad[2] - mapping.contentQuad[0]).toBeCloseTo(120, 3);
    } finally {
      await page.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("uses the same content-quad route for transformed video and inaccessible iframe surfaces", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 430, height: 250 }, deviceScaleFactor: 1 });
    const rendered = await env!.browser.newPage({ viewport: { width: 430, height: 250 }, deviceScaleFactor: 1 });
    try {
      const poster = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#ed1234"/></svg>')}`;
      const frame = `data:text/html,${encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;background:#164ee8}</style>')}`;
      await page.setContent(`<style>
        html,body{margin:0;background:white}
        .vc{position:absolute;left:40px;top:50px;width:78px;height:67px;overflow:hidden}
        .v{position:absolute;left:-17px;top:5px;width:100px;height:60px;transform:rotate(-9deg);transform-origin:13px 17px}
        .fc{position:absolute;left:220px;top:45px;width:84px;height:82px;overflow:clip}
        .f{position:absolute;left:-14px;top:4px;width:110px;height:65px;border:0;transform:scale(.9,1.15) skewY(5deg);transform-origin:20px 10px}
      </style><div class="vc"><video class="v" poster="${poster}"></video></div><div class="fc"><iframe class="f" src="${frame}"></iframe></div>`);
      await page.waitForTimeout(100);
      const expected = await page.screenshot();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 430, height: 250 });
      const snapshots: NonNullable<CapturedElement["replacedSnapshot"]>[] = [];
      for (const tag of ["video", "iframe"]) {
        const node = walk(tree).find((candidate) => candidate.tag === tag)!;
        const snapshot = node.replacedSnapshot!;
        snapshots.push(snapshot);
        expect(snapshot.dataUri, tag).toMatch(/^data:image\/png;base64,/);
        expect(snapshot.rasterToOutput, tag).toBeDefined();
        expect(snapshot.rasterToOutput!.contentQuad).toHaveLength(8);
        expect(snapshot.rasterToOutput!.pixelWidth).toBeGreaterThan(50);
        expect(snapshot.rasterToOutput!.pixelHeight).toBeGreaterThan(30);
        expect(snapshot.rasterToOutput!.pixelWidth * snapshot.rasterToOutput!.cssPerPixelX)
          .toBeCloseTo(snapshot.width, 6);
        expect(snapshot.rasterToOutput!.pixelHeight * snapshot.rasterToOutput!.cssPerPixelY)
          .toBeCloseTo(snapshot.height, 6);
      }
      expect(await page.evaluate(() => ({
        videoClip: getComputedStyle(document.querySelector(".vc")!).overflow,
        frameClip: getComputedStyle(document.querySelector(".fc")!).overflow,
      }))).toEqual({ videoClip: "hidden", frameClip: "clip" });

      const body = elementTreeToSvgInner(tree, 430, 250);
      for (const snapshot of snapshots) expect(occurrences(body, snapshot.dataUri!)).toBe(1);
      expect(body).toContain("<clipPath");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="430" height="250"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
      await rendered.setContent(`<img alt="rendered" style="display:block" src="data:image/svg+xml,${encodeURIComponent(svg)}">`);
      const actual = await rendered.locator("img").screenshot();
      for (const color of [
        [237, 18, 52],
        [22, 78, 232],
      ] as Array<[number, number, number]>) {
        expect(maxBoundsDelta(await colorBounds(expected, color), await colorBounds(actual, color)))
          .toBeLessThanOrEqual(3);
      }
    } finally {
      await page.close();
      await rendered.close();
    }
  }, 60_000);

  it("leaves a canvas under projective ownership to the outer Chromium surface exactly once", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>html,body{margin:0}.projective{position:absolute;left:30px;top:30px;width:180px;height:130px;perspective:280px}.plane{width:140px;height:90px;transform:rotateY(31deg)}canvas{width:140px;height:90px}.vector{position:absolute;left:270px;top:30px;width:34px;height:34px;background:rgb(0,187,85)}</style><div class="projective"><div class="plane"><canvas width="140" height="90"></canvas></div></div><div class="vector"></div>`);
      await page.locator("canvas").evaluate((element) => {
        const context = (element as HTMLCanvasElement).getContext("2d")!;
        context.fillStyle = "rgb(237,18,52)";
        context.fillRect(0, 0, 140, 90);
      });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const nodes = walk(tree);
      const owner = nodes.find((node) => node.transformSubtreeRaster?.dataUri != null)!;
      const nested = nodes.find((node) => node.tag === "canvas")!.replacedSnapshot!;
      const svg = elementTreeToSvgInner(tree, 360, 240);

      expect(owner.transformSubtreeRaster!.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(nested.dataUri).toBeUndefined();
      expect(nested.rasterToOutput).toBeUndefined();
      expect(occurrences(svg, owner.transformSubtreeRaster!.dataUri!)).toBe(1);
      expect(svg).toContain('fill="rgb(0,187,85)"');
    } finally {
      await page.close();
    }
  }, 60_000);
});
