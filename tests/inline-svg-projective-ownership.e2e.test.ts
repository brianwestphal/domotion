import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  captureElementTree,
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

function rasterOwners(nodes: CapturedElement[]): CapturedElement[] {
  return walk(nodes).filter((node) => node.transformSubtreeRaster?.dataUri != null);
}

function projectiveOwners(nodes: CapturedElement[]): CapturedElement[] {
  return walk(nodes).filter((node) => node.transformSubtreeRaster != null);
}

function inlineSvg(nodes: CapturedElement[]): CapturedElement | undefined {
  return walk(nodes).find((node) => node.tag === "svg" && node.svgContent != null);
}

async function colorBounds(
  png: Buffer,
  rgb: readonly [number, number, number],
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
      if (Math.abs(data[offset] - rgb[0]) > 20
          || Math.abs(data[offset + 1] - rgb[1]) > 20
          || Math.abs(data[offset + 2] - rgb[2]) > 20) continue;
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

describeBrowser("projective inline SVG raster ownership", () => {
  it("uses measured paint activation and promotes foreignObject paint to one reachable owner", async () => {
    const width = 380;
    const height = 250;
    const cases: Array<{
      id: string;
      markup: string;
      expectedOwnerTag: string | null;
      inlineOwns?: boolean;
      expectedEmpty?: boolean;
    }> = [
      {
        id: "direct-root-projective",
        markup: `<svg style="display:block;width:260px;height:150px;transform:perspective(280px) rotateY(43deg);transform-origin:19% 81%" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg>`,
        expectedOwnerTag: "svg",
        inlineOwns: true,
      },
      {
        id: "direct-root-backface-hidden",
        markup: `<svg style="display:block;width:260px;height:150px;transform:perspective(280px) rotateY(137deg);transform-origin:19% 81%;backface-visibility:hidden" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg>`,
        expectedOwnerTag: "svg",
        inlineOwns: true,
        expectedEmpty: true,
      },
      {
        id: "html-ancestor-projective",
        markup: `<div style="perspective:300px;perspective-origin:82% 17%;transform-style:preserve-3d"><svg style="display:block;width:260px;height:150px;transform:rotateY(39deg) translateZ(17px);transform-origin:23% 77%" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg></div>`,
        expectedOwnerTag: "div",
        inlineOwns: false,
      },
      {
        id: "foreign-object-promotes",
        markup: `<svg style="display:block;width:260px;height:150px" viewBox="0 0 260 150"><foreignObject x="25" y="18" width="180" height="105"><div xmlns="http://www.w3.org/1999/xhtml" style="width:180px;height:105px;perspective:270px;transform-style:preserve-3d"><div style="width:180px;height:105px;background:rgb(211,31,61);transform:rotateY(44deg) translateZ(19px);transform-origin:17% 79%"></div></div></foreignObject></svg>`,
        expectedOwnerTag: "svg",
        inlineOwns: true,
      },
      {
        id: "nested-inline-svg-promotes-to-outer-clone",
        markup: `<svg style="display:block;width:260px;height:150px" viewBox="0 0 260 150"><foreignObject x="10" y="10" width="230" height="130"><div xmlns="http://www.w3.org/1999/xhtml"><svg style="display:block;width:210px;height:115px;transform:perspective(240px) rotateY(41deg);transform-origin:21% 73%" viewBox="0 0 210 115"><rect width="210" height="115" fill="rgb(211,31,61)"/></svg></div></foreignObject></svg>`,
        expectedOwnerTag: "svg",
        inlineOwns: true,
      },
      {
        id: "inert-root-perspective",
        markup: `<svg style="display:block;width:260px;height:150px;perspective:280px;transform-style:preserve-3d" viewBox="0 0 260 150"><g style="transform:rotateY(44deg);transform-box:fill-box;transform-origin:20% 80%"><rect x="20" y="20" width="180" height="95" fill="rgb(211,31,61)"/></g></svg>`,
        expectedOwnerTag: null,
      },
      {
        id: "svg-child-perspective-opacity-flatten",
        markup: `<svg style="display:block;width:260px;height:150px" viewBox="0 0 260 150"><g style="perspective:280px;transform-style:preserve-3d;opacity:.72;overflow:hidden"><rect x="20" y="20" width="180" height="95" style="transform:rotateY(44deg);transform-box:fill-box;transform-origin:20% 80%" fill="rgb(211,31,61)"/></g></svg>`,
        expectedOwnerTag: null,
      },
      {
        id: "html-flat-grouping-flattens",
        markup: `<div style="width:260px;height:150px;perspective:280px;transform-style:preserve-3d"><div style="width:240px;height:130px;transform-style:flat"><svg style="display:block;width:220px;height:115px;transform:rotateY(44deg) translateZ(24px);transform-origin:20% 80%" viewBox="0 0 220 115"><rect width="220" height="115" fill="rgb(211,31,61)"/></svg></div></div>`,
        expectedOwnerTag: null,
      },
      {
        id: "html-opacity-grouping-flattens",
        markup: `<div style="width:260px;height:150px;perspective:280px;transform-style:preserve-3d"><div style="width:240px;height:130px;opacity:.72;transform-style:preserve-3d"><svg style="display:block;width:220px;height:115px;transform:rotateY(44deg) translateZ(24px);transform-origin:20% 80%" viewBox="0 0 220 115"><rect width="220" height="115" fill="rgb(211,31,61)"/></svg></div></div>`,
        expectedOwnerTag: null,
      },
      {
        id: "html-overflow-grouping-flattens",
        markup: `<div style="width:260px;height:150px;perspective:280px;transform-style:preserve-3d"><div style="width:240px;height:130px;overflow:hidden;transform-style:preserve-3d"><svg style="display:block;width:220px;height:115px;transform:rotateY(44deg) translateZ(24px);transform-origin:20% 80%" viewBox="0 0 220 115"><rect width="220" height="115" fill="rgb(211,31,61)"/></svg></div></div>`,
        expectedOwnerTag: null,
      },
      {
        id: "affine-matrix-negative",
        markup: `<svg style="display:block;width:260px;height:150px;transform:matrix(.92,.18,-.11,1.08,9,-6)" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg>`,
        expectedOwnerTag: null,
      },
      {
        id: "orthographic-rotate-y-affine-negative",
        markup: `<svg style="display:block;width:260px;height:150px;transform:rotateY(43deg);transform-origin:19% 81%" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg>`,
        expectedOwnerTag: null,
      },
      {
        id: "planar-matrix3d-negative",
        markup: `<svg style="display:block;width:260px;height:150px;transform:matrix3d(.92,.18,0,0,-.11,1.08,0,0,0,0,1,0,9,-6,0,1)" viewBox="0 0 260 150"><rect width="260" height="150" fill="rgb(211,31,61)"/></svg>`,
        expectedOwnerTag: null,
      },
    ];

    const page = await env!.browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      for (const row of cases) {
        await page.setContent(`<style>html,body{margin:0;background:white}#host{position:absolute;left:55px;top:42px}</style><div id="host">${row.markup}</div>`);
        await page.evaluate(`(() => {
          globalThis.__dmProjectiveSvgHtmlInsertions = [];
          globalThis.__dmProjectiveSvgObserver = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (record.target.namespaceURI === "http://www.w3.org/2000/svg" && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
                globalThis.__dmProjectiveSvgHtmlInsertions.push(node.localName);
              }
            }
          });
          globalThis.__dmProjectiveSvgObserver.observe(document, { childList: true, subtree: true });
        })()`);
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
        const owners = projectiveOwners(tree);
        if (row.expectedOwnerTag == null) {
          expect(owners, row.id).toEqual([]);
        } else {
          expect(owners.map((owner) => owner.tag), row.id).toEqual([row.expectedOwnerTag]);
          expect(owners[0].transformSubtreeRaster?.sourceNodeIndex, row.id).toBeUndefined();
          if (row.expectedEmpty === true) {
            expect(owners[0].transformSubtreeRaster, row.id).toMatchObject({ empty: true });
            expect(owners[0].transformSubtreeRaster?.dataUri, row.id).toBeUndefined();
          }
        }
        if (row.inlineOwns != null) {
          expect(inlineSvg(tree)?.transformSubtreeRaster != null, row.id).toBe(row.inlineOwns);
        }
        expect(await page.evaluate(() => Object.keys(globalThis).some(
          (key) => key.startsWith("__domotionProjectivePaintNodes_"),
        )), row.id).toBe(false);
        expect(await page.evaluate(`(() => {
          globalThis.__dmProjectiveSvgObserver?.disconnect();
          return globalThis.__dmProjectiveSvgHtmlInsertions;
        })()`), row.id).toEqual([]);
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it("matches Chromium ink at DPR 2 with zoom, scroll, clipping, off-bounds paint, and a vector sibling", async () => {
    const width = 420;
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
        html,body{margin:0;background:white}body{height:900px}
        #frame{position:absolute;left:-14px;top:330px;width:340px;height:210px;zoom:1.15;overflow:hidden;opacity:.9;filter:drop-shadow(3px 2px 0 rgba(80,40,160,.6));transform:rotate(4deg);transform-origin:38px 27px}
        #art{display:block;width:300px;height:175px;overflow:hidden;border:5px solid rgb(18,18,24)}
        #fohost{width:190px;height:120px;perspective:260px;perspective-origin:17% 79%;transform-style:preserve-3d}
        #plane{position:relative;left:-28px;top:-9px;width:235px;height:135px;background:rgb(214,28,62);transform:rotateY(46deg) translateZ(23px);transform-origin:21% 76%}
        #plane::after{content:"";position:absolute;right:-35px;bottom:-18px;width:95px;height:72px;background:rgb(31,82,224)}
        #sibling{position:fixed;left:350px;top:28px;width:42px;height:34px;background:rgb(0,181,87)}
      </style><div id="frame"><svg id="art" viewBox="0 0 300 175"><rect x="8" y="9" width="105" height="58" fill="rgb(242,168,24)"/><foreignObject x="102" y="27" width="190" height="120"><div xmlns="http://www.w3.org/1999/xhtml" id="fohost"><div id="plane"></div></div></foreignObject></svg></div><div id="sibling"></div>`);
      await page.evaluate(() => scrollTo(0, 300));
      const expected = await page.screenshot();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width, height });
      const owners = rasterOwners(tree);
      expect(owners).toHaveLength(1);
      expect(owners[0].tag).toBe("svg");
      const raster = owners[0].transformSubtreeRaster!;
      expect(raster.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(raster.sourceNodeIndex).toBeUndefined();

      const rasterPng = Buffer.from(raster.dataUri!.split(",")[1], "base64");
      const rasterInfo = await sharp(rasterPng).metadata();
      expect(rasterInfo.width! / raster.width).toBeCloseTo(2, 1);
      await expect(colorBounds(rasterPng, [0, 181, 87])).rejects.toThrow(/was absent/);

      const body = elementTreeToSvgInner(tree, width, height);
      expect(body.split(raster.dataUri!).length - 1).toBe(1);
      expect(body).toContain('fill="rgb(0,181,87)"');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`;
      await rendered.setContent(`<style>html,body{margin:0}img{display:block;width:${width}px;height:${height}px}</style><img alt="rendered" src="data:image/svg+xml,${encodeURIComponent(svg)}">`);
      await rendered.locator("img").evaluate((image: HTMLImageElement) => image.decode());
      const actual = await rendered.screenshot();

      for (const color of [
        // The first three source colors are inside #frame and therefore
        // composited once at opacity .9 over the page's white canvas.
        [218, 51, 81],
        [53, 99, 227],
        [243, 177, 47],
        [0, 181, 87],
      ] as const) {
        const expectedBounds = await colorBounds(expected, color);
        const actualBounds = await colorBounds(actual, color);
        expect(maxBoundsDelta(expectedBounds, actualBounds), color.join(","))
          .toBeLessThanOrEqual(4);
      }
      expect(await page.evaluate(() => ({
        scrollY,
        ownerProbePresent: Object.keys(globalThis).some(
          (key) => key.startsWith("__domotionProjectivePaintNodes_"),
        ),
        sourceVisibility: ["art", "fohost", "plane", "sibling"].map((id) => {
          const style = document.getElementById(id)!.style;
          return [style.getPropertyValue("visibility"), style.getPropertyPriority("visibility")];
        }),
        frameTransform: getComputedStyle(document.getElementById("frame")!).transform,
      }))).toEqual({
        scrollY: 300,
        ownerProbePresent: false,
        sourceVisibility: [["", ""], ["", ""], ["", ""], ["", ""]],
        frameTransform: expect.stringMatching(/^matrix\(/),
      });
    } finally {
      await page.close();
      await rendered.close();
    }
  }, 60_000);
});
