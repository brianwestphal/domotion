import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 380;
const HEIGHT = 170;

async function alphaTile(): Promise<string> {
  const width = 50;
  const height = 30;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < 23; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = 255;
    pixels[offset + 3] = 255;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const TILE = await alphaTile();

function fixture(): string {
  return `<!doctype html><style>
    html,body{margin:0;background:white}
    #stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:white}
    .case{position:absolute;top:20px;box-sizing:border-box;width:160px;height:120px;
      border:10px solid transparent;padding:10px;background:rgb(27,122,224);
      mask-image:url("${TILE}");mask-mode:alpha;mask-size:50px 30px;
      mask-position:25% 75%;mask-origin:content-box;mask-clip:border-box}
    #round{left:10px;mask-repeat:round no-repeat}
    #space{left:200px;mask-repeat:space no-repeat;background:rgb(205,54,159)}
  </style><div id="stage"><div id="round" class="case"></div><div id="space" class="case"></div></div>`;
}

interface RgbImage {
  data: Buffer;
  width: number;
  height: number;
}

async function rgb(png: Buffer): Promise<RgbImage> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function hasInk(image: RgbImage, x: number, y: number): boolean {
  const offset = (y * image.width + x) * 3;
  return 765 - image.data[offset] - image.data[offset + 1] - image.data[offset + 2] > 40;
}

function inkRuns(
  image: RgbImage,
  rect: { x: number; y: number; width: number; height: number },
  cssY: number,
  dpr: number,
): Array<[number, number]> {
  const y = Math.round(cssY * dpr);
  const start = Math.floor(rect.x * dpr);
  const end = Math.ceil((rect.x + rect.width) * dpr);
  const runs: Array<[number, number]> = [];
  let runStart = -1;
  for (let x = start; x < end; x++) {
    const ink = hasInk(image, x, y);
    if (ink && runStart < 0) runStart = x;
    if (!ink && runStart >= 0) {
      runs.push([runStart, x - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push([runStart, end - 1]);
  return runs;
}

function inkCountAtRow(
  image: RgbImage,
  rect: { x: number; y: number; width: number; height: number },
  cssY: number,
  dpr: number,
): number {
  const y = Math.round(cssY * dpr);
  let count = 0;
  for (let x = Math.floor(rect.x * dpr); x < Math.ceil((rect.x + rect.width) * dpr); x++) {
    if (hasInk(image, x, y)) count++;
  }
  return count;
}

function collapsePatternPaintingArea(svg: string): string {
  let patterns = 0;
  const mutated = svg.replace(/<pattern\b[^>]*>[\s\S]*?<\/pattern>/g, (block) => {
    patterns++;
    return block
      .replace(/^<pattern\b[^>]*>/, (tag) => tag
        .replace(/\by="[^"]*"/, 'y="40"')
        .replace(/\bheight="[^"]*"/, 'height="80"'))
      .replace(/<image\b[^>]*>/, (tag) => tag.replace(/\by="[^"]*"/, 'y="37.5"'));
  });
  expect(patterns).toBe(2);
  return mutated;
}

const browser = await launchChromium();
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe("URL mask round/space painting-area ownership (DM-2494)", () => {
  for (const dpr of [1, 2]) {
    it(`matches Blink and rejects the collapsed positioning-area mutation at DPR ${dpr}`, async () => {
      const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const rendered = await context.newPage();
      const mutated = await context.newPage();
      try {
        await source.setContent(fixture(), { waitUntil: "load" });
        const rects = await source.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".case")).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            id: element.id,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            repeat: style.maskRepeat,
            origin: style.maskOrigin,
            clip: style.maskClip,
          };
        }));
        expect(rects.map(({ id, repeat, origin, clip }) => ({ id, repeat, origin, clip }))).toEqual([
          { id: "round", repeat: "round no-repeat", origin: "content-box", clip: "border-box" },
          { id: "space", repeat: "space no-repeat", origin: "content-box", clip: "border-box" },
        ]);

        const expectedPng = await source.screenshot();
        const tree = await captureElementTree(source, "#stage", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
        expect(svg.match(/<pattern\b/g)).toHaveLength(2);
        expect(svg.match(/<pattern\b[^>]*\by="20"[^>]*\bheight="120"/g)).toHaveLength(2);

        await rendered.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
        await mutated.setContent(`<body style="margin:0;background:white">${collapsePatternPaintingArea(svg)}</body>`, { waitUntil: "load" });
        const [actualPng, mutatedPng] = await Promise.all([rendered.screenshot(), mutated.screenshot()]);
        const [expected, actual, wrong] = await Promise.all([rgb(expectedPng), rgb(actualPng), rgb(mutatedPng)]);
        for (const { id, repeat: _repeat, origin: _origin, clip: _clip, ...rect } of rects) {
          const expectedRuns = inkRuns(expected, rect, rect.y + 70, dpr);
          const actualRuns = inkRuns(actual, rect, rect.y + 70, dpr);
          expect(actualRuns, `${id}: source/SVG tile count diverged`).toHaveLength(expectedRuns.length);
          const edgeError = Math.max(...actualRuns.flatMap((run, index) => [
            Math.abs(run[0] - expectedRuns[index][0]),
            Math.abs(run[1] - expectedRuns[index][1]),
          ]));
          expect(edgeError, `${id}: source/SVG tile edges diverged in device pixels`).toBeLessThanOrEqual(1);

          // The retired call gave the pattern the content-box as both origin
          // and paint destination. Its 80px no-repeat cell then wrapped once
          // above the intended 77.5px tile; the border-box-owned cell cannot.
          const topY = rect.y + 4;
          expect(inkCountAtRow(expected, rect, topY, dpr), `${id}: source top control`).toBe(0);
          expect(inkCountAtRow(actual, rect, topY, dpr), `${id}: SVG top control`).toBe(0);
          expect(inkCountAtRow(wrong, rect, topY, dpr), `${id}: collapsed painting-area mutation was vacuous`)
            .toBeGreaterThan(10 * dpr);
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
