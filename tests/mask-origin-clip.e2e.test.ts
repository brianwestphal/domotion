import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Independent asymmetric alpha sources make both the positioning area and
// the painting-area intersection observable in pixels.
async function alphaPng(width: number, height: number, opaqueWidth: number, opaqueHeight: number): Promise<string> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < opaqueHeight; y++) for (let x = 0; x < opaqueWidth; x++) {
    pixels[(y * width + x) * 4 + 3] = 255;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
const WIDE = await alphaPng(40, 20, 17, 20);
const TALL = await alphaPng(18, 42, 18, 19);

const WIDTH = 640;
const HEIGHT = 430;

function matrixHtml(): string {
  return `<!doctype html><style>
    html,body{margin:0;background:white}
    #stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:white}
    .case{position:absolute;box-sizing:border-box;width:132px;height:104px;
      border-style:solid;border-color:transparent;border-width:4px 7px 9px 11px;
      padding:8px 13px 15px 17px;background:rgb(27,122,224);mask-mode:alpha}
    #contain{left:12px;top:12px;mask-image:url("${WIDE}");mask-size:contain;
      mask-position:100% 50%;mask-repeat:no-repeat;mask-origin:content-box;mask-clip:border-box}
    #cover{left:164px;top:12px;background:rgb(198,57,71);mask-image:url("${TALL}");mask-size:cover;
      mask-position:23% 17%;mask-repeat:no-repeat;mask-origin:border-box;mask-clip:content-box}
    #explicit{left:316px;top:12px;background:rgb(28,153,95);mask-image:url("${WIDE}");mask-size:34px 26px;
      mask-position:calc(25% + 7px) 50%;mask-repeat:no-repeat;mask-origin:padding-box;mask-clip:content-box}
    #repeat{left:468px;top:12px;background:rgb(137,75,204);mask-image:url("${WIDE}");mask-size:29px 17px;
      mask-position:7px 5px;mask-repeat:repeat;mask-origin:content-box;mask-clip:padding-box}
    #same{left:12px;top:146px;background:rgb(227,133,28);mask-image:url("${WIDE}");mask-size:contain;
      mask-position:83% 27%;mask-repeat:no-repeat;mask-origin:padding-box;mask-clip:padding-box}
    #vertical{left:164px;top:146px;background:rgb(31,156,171);writing-mode:vertical-rl;direction:rtl;
      mask-image:url("${TALL}");mask-size:contain;mask-position:calc(25% + 3px) 73%;mask-repeat:no-repeat;
      mask-origin:content-box;mask-clip:border-box}
    #layers{left:316px;top:146px;background:rgb(205,54,159);mask-image:url("${WIDE}"),url("${TALL}");
      mask-size:contain,38px 48px;mask-position:100% 50%,0% 100%;mask-repeat:no-repeat,no-repeat;
      mask-origin:content-box,border-box;mask-clip:border-box,content-box;mask-composite:add,add}
    #zoomed{left:468px;top:146px;background:rgb(74,105,211);zoom:1.25;transform-origin:0 0;
      mask-image:url("${WIDE}");mask-size:contain;mask-position:73% calc(25% + 4px);mask-repeat:no-repeat;
      mask-origin:content-box;mask-clip:padding-box}
    #noclip{left:244px;top:302px;background:rgb(32,142,84);box-shadow:0 0 0 14px rgb(32,142,84);
      mask-image:url("${WIDE}");mask-size:31px 19px;mask-position:3px 7px;mask-repeat:repeat;
      mask-origin:padding-box;mask-clip:no-clip}
  </style><div id="stage">
    <div id="contain" class="case"></div><div id="cover" class="case"></div>
    <div id="explicit" class="case"></div><div id="repeat" class="case"></div>
    <div id="same" class="case"></div><div id="vertical" class="case"></div>
    <div id="layers" class="case"></div><div id="zoomed" class="case"></div>
    <div id="noclip" class="case"></div>
  </div>`;
}

function masked(nodes: CapturedElement[]): CapturedElement[] {
  const result: CapturedElement[] = [];
  for (const node of nodes) {
    if (node.styles.maskImage != null && node.styles.maskImage !== "" && node.styles.maskImage !== "none") result.push(node);
    result.push(...masked(node.children ?? []));
  }
  return result;
}

async function rgb(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function meanAbsoluteError(a: Buffer, b: Buffer): Promise<number> {
  const [aa, bb] = await Promise.all([rgb(a), rgb(b)]);
  expect(bb.data.length).toBe(aa.data.length);
  let sum = 0;
  for (let index = 0; index < aa.data.length; index++) sum += Math.abs(aa.data[index] - bb.data[index]);
  return sum / aa.data.length;
}

function inkBounds(
  image: Awaited<ReturnType<typeof rgb>>,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): [number, number, number, number] | null {
  const pad = 20;
  const x0 = Math.max(0, Math.floor((rect.x - pad) * dpr));
  const y0 = Math.max(0, Math.floor((rect.y - pad) * dpr));
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width + pad) * dpr));
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height + pad) * dpr));
  let minX = x1, minY = y1, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * image.width + x) * 3;
    if (765 - image.data[offset] - image.data[offset + 1] - image.data[offset + 2] <= 35) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : [minX, minY, maxX, maxY];
}

// This file is a release oracle, not opportunistic browser coverage: a missing
// Chromium launch must fail the gate instead of turning every row into a skip.
const env = { browser: await launchChromium() };
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);

describe("HTML URL mask-origin/mask-clip Chromium oracle (DM-2472)", () => {
  for (const dpr of [1, 2]) {
    it(`matches distinct boxes, same-box control, layers, no-clip, zoom and writing mode at DPR ${dpr}`, async () => {
      const context = await env.browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const rendered = await context.newPage();
      const mutated = await context.newPage();
      try {
        await source.setContent(matrixHtml(), { waitUntil: "load" });
        await source.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const rects = await source.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".case")).map((element) => {
          const rect = element.getBoundingClientRect();
          return { id: element.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
        const expected = await source.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
        const tree = await captureElementTree(source, "#stage", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
        const cases = masked(tree);
        expect(cases).toHaveLength(9);
        expect(cases.map((element) => element.styles.maskOrigin)).toEqual([
          "content-box", "border-box", "padding-box", "content-box", "padding-box",
          "content-box", "content-box, border-box", "content-box", "padding-box",
        ]);
        expect(cases.map((element) => element.styles.maskClip)).toEqual([
          "border-box", "content-box", "content-box", "padding-box", "padding-box",
          "border-box", "border-box, content-box", "padding-box", "no-clip",
        ]);
        expect(cases[7].styles.maskBoxInsets).toEqual({
          border: { top: 5, right: 8, bottom: 11, left: 13 },
          padding: { top: 10, right: 16.25, bottom: 18.75, left: 21.25 },
        });

        const svg = elementTreeToSvg(tree, WIDTH, HEIGHT);
        expect(svg).toContain('clipPathUnits="userSpaceOnUse"');
        expect(svg).toMatch(/<mask[^>]+ x="0" y="0" width="640" height="430"[^>]+mask-type="alpha"/);
        await rendered.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
        const actual = await rendered.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
        expect(await meanAbsoluteError(expected, actual)).toBeLessThan(3.2);

        const [expectedRgb, actualRgb] = await Promise.all([rgb(expected), rgb(actual)]);
        for (const { id, ...rect } of rects) {
          const expectedBounds = inkBounds(expectedRgb, rect, dpr);
          const actualBounds = inkBounds(actualRgb, rect, dpr);
          expect(expectedBounds, `${id}: Chromium emitted no mask ink`).not.toBeNull();
          expect(actualBounds, `${id}: generated SVG emitted no mask ink`).not.toBeNull();
          const edgeError = Math.max(...actualBounds!.map((value, index) => Math.abs(value - expectedBounds![index])));
          expect(edgeError, `${id}: device-pixel ink bounds diverged ${expectedBounds} vs ${actualBounds}`).toBeLessThanOrEqual(4);
        }

        // Required mutation: collapse every origin to its clip. The same-box
        // negative control remains unchanged, while the distinct-box matrix
        // must become materially worse than the production route.
        const mutantTree = structuredClone(tree);
        for (const element of masked(mutantTree)) element.styles.maskOrigin = element.styles.maskClip;
        const mutantSvg = elementTreeToSvg(mutantTree, WIDTH, HEIGHT);
        await mutated.setContent(`<body style="margin:0;background:white">${mutantSvg}</body>`, { waitUntil: "load" });
        const mutantPng = await mutated.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
        expect(await meanAbsoluteError(expected, mutantPng)).toBeGreaterThan((await meanAbsoluteError(expected, actual)) + 0.8);
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it("preserves distinct boxes across sliced and cloned inline fragments", async () => {
    const context = await env.browser.newContext({ viewport: { width: 360, height: 250 }, deviceScaleFactor: 2 });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(`<!doctype html><style>
        html,body{margin:0;background:white} body{width:150px;font:20px/30px Arial;color:rgb(27,105,210)}
        span{background:rgb(27,105,210);border:3px solid transparent;padding:4px 7px;
          mask-image:url("${WIDE}");mask-size:contain;mask-position:83% 27%;mask-repeat:no-repeat;
          mask-mode:alpha;mask-origin:content-box;mask-clip:border-box}
        #clone{box-decoration-break:clone;-webkit-box-decoration-break:clone}
      </style><div><span id="slice">distinct mask boxes wrapping into a sliced inline strip</span></div>
      <div><span id="clone">distinct mask boxes wrapping into cloned inline fragments</span></div>`, { waitUntil: "load" });
      const expected = await source.screenshot();
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 360, height: 250 });
      const cases = masked(tree);
      expect(cases).toHaveLength(2);
      expect(cases.every((element) => (element.inlineFragments?.length ?? 0) > 1)).toBe(true);
      const svg = elementTreeToSvg(tree, 360, 250);
      expect((svg.match(/clipPathUnits="userSpaceOnUse"/g) ?? []).length)
        .toBeGreaterThanOrEqual(cases[0].inlineFragments!.length + cases[1].inlineFragments!.length);
      await rendered.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
      const actual = await rendered.screenshot();
      expect(await meanAbsoluteError(expected, actual)).toBeLessThan(3.3);
    } finally {
      await context.close();
    }
  }, 60_000);
});
