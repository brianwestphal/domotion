import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const svgData = (width: number, height: number, shape: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shape}</svg>`)}`;

// Deliberately asymmetric alpha makes mask-position observable even for cover
// (an all-opaque cover image would hide every positional error behind the
// positioning-area clip).
const WIDE = svgData(200, 100, '<rect width="86" height="100" fill="black"/>');
const TALL = svgData(100, 200, '<rect width="100" height="76" fill="black"/>');
const ODD = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 7"><rect width="1.2" height="7" fill="black"/></svg>')}`;

function html(zoom: number): string {
  return `<!doctype html><style>
    html,body{margin:0;background:white}
    #stage{position:relative;width:360px;height:360px;background:white}
    .case{position:absolute;width:120px;height:90px;background:rgb(27,122,224);mask-mode:alpha;mask-repeat:no-repeat}
    #percentage{left:10px;top:10px;mask-image:url("${WIDE}");mask-size:contain;mask-position:23% 73%}
    #length{left:150px;top:10px;mask-image:url("${WIDE}");mask-size:contain;mask-position:17px 9px}
    #calculated{left:10px;top:120px;mask-image:url("${TALL}");mask-size:cover;mask-position:17px calc(25% + 7px)}
    #vertical{left:150px;top:120px;writing-mode:vertical-rl;mask-image:url("${WIDE}");mask-size:contain;mask-position:calc(25% + 7px) 73%}
    #layers{left:10px;top:230px;background:rgb(214,57,72);mask-image:url("${WIDE}"),url("${TALL}");mask-size:contain,cover;mask-position:23% 73%,calc(100% - 11px) 25%;mask-repeat:no-repeat,no-repeat}
    #zoomed{left:150px;top:230px;zoom:${zoom};transform-origin:0 0;mask-image:url("${WIDE}");mask-size:contain;mask-position:calc(25% + 7px) calc(75% - 3px)}
    #odd{left:290px;top:10px;width:60px;mask-image:url("${ODD}");mask-size:contain;mask-position:23% 73%}
  </style><div id="stage"><div id="percentage" class="case"></div><div id="length" class="case"></div><div id="calculated" class="case"></div><div id="vertical" class="case"></div><div id="layers" class="case"></div><div id="zoomed" class="case"></div><div id="odd" class="case"></div></div>`;
}

function masked(nodes: CapturedElement[]): CapturedElement[] {
  const out: CapturedElement[] = [];
  for (const node of nodes) {
    if (node.styles.maskImage != null && node.styles.maskImage !== "" && node.styles.maskImage !== "none") out.push(node);
    out.push(...masked(node.children ?? []));
  }
  return out;
}

async function meanAbsoluteError(aPng: Buffer, bPng: Buffer): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(aPng).removeAlpha().raw().toBuffer(),
    sharp(bPng).removeAlpha().raw().toBuffer(),
  ]);
  expect(b.length).toBe(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

interface DecodedRgb {
  data: Buffer;
  width: number;
  height: number;
}

async function decodeRgb(png: Buffer): Promise<DecodedRgb> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function coloredInkBounds(
  image: DecodedRgb,
  rect: { x: number; y: number; width: number; height: number },
  dpr: number,
): [number, number, number, number] | null {
  const x0 = Math.max(0, Math.floor(rect.x * dpr) - 2);
  const y0 = Math.max(0, Math.floor(rect.y * dpr) - 2);
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.width) * dpr) + 2);
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.height) * dpr) + 2);
  let minX = x1;
  let minY = y1;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * image.width + x) * 3;
    // Both source and SVG pages have an opaque white backdrop. A channel-sum
    // threshold retains antialiased colored edge pixels without keying to any
    // authored mask position or expected bucket.
    if (765 - image.data[offset] - image.data[offset + 1] - image.data[offset + 2] <= 30) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : [minX, minY, maxX, maxY];
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("arbitrary contain/cover mask-position Chromium oracle (DM-2379)", () => {
  for (const row of [
    { dpr: 1, zoom: 1 },
    { dpr: 2, zoom: 1.25 },
  ]) {
    it(`matches independent Chromium pixels at DPR ${row.dpr}, zoom ${row.zoom}`, async () => {
      const context = await env!.browser.newContext({ viewport: { width: 380, height: 380 }, deviceScaleFactor: row.dpr });
      const source = await context.newPage();
      const rendered = await context.newPage();
      try {
        await source.setContent(html(row.zoom), { waitUntil: "load" });
        await source.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const caseRects = await source.evaluate(() => [
          "percentage", "length", "calculated", "vertical", "layers", "zoomed", "odd",
        ].map((id) => {
          const rect = document.getElementById(id)!.getBoundingClientRect();
          return { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }));
        const expected = await source.screenshot({ clip: { x: 0, y: 0, width: 380, height: 380 } });
        const tree = await captureElementTree(source, "#stage", { x: 0, y: 0, width: 380, height: 380 });
        const cases = masked(tree);
        expect(cases).toHaveLength(7);
        expect(cases.map((element) => element.styles.maskIntrinsic?.map((intrinsic) => intrinsic == null ? null : { w: intrinsic.w, h: intrinsic.h }))).toEqual([
          [{ w: 200, h: 100 }],
          [{ w: 200, h: 100 }],
          [{ w: 100, h: 200 }],
          [{ w: 200, h: 100 }],
          [{ w: 200, h: 100 }, { w: 100, h: 200 }],
          [{ w: 200, h: 100 }],
          [{ w: 64, h: 150 }],
        ]);
        expect(cases[6].styles.maskIntrinsic![0]!.ratio).toBeCloseTo(3 / 7, 6);
        // px terms cross effective zoom once; percentage terms remain deferred.
        expect(cases[5].styles.maskPosition).toBe(row.zoom === 1
          ? "calc(25% + 7px) calc(75% - 3px)"
          : "calc(25% + 8.75px) calc(75% - 3.75px)");

        const svg = elementTreeToSvg(tree, 380, 380);
        expect(svg).toContain('preserveAspectRatio="none"');
        // Retired-quantization control: no contain/cover layer may delegate
        // arbitrary placement to SVG Min/Mid/Max alignment.
        expect(svg).not.toMatch(/preserveAspectRatio="x(?:Min|Mid|Max)Y(?:Min|Mid|Max) (?:meet|slice)"/);
        await rendered.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
        const actual = await rendered.screenshot({ clip: { x: 0, y: 0, width: 380, height: 380 } });
        expect(await meanAbsoluteError(expected, actual)).toBeLessThan(2.4);
        const [expectedRgb, actualRgb] = await Promise.all([decodeRgb(expected), decodeRgb(actual)]);
        for (const { id, ...rect } of caseRects) {
          const expectedBounds = coloredInkBounds(expectedRgb, rect, row.dpr);
          const actualBounds = coloredInkBounds(actualRgb, rect, row.dpr);
          expect(actualBounds, `${id}: SVG emitted no colored mask ink`).not.toBeNull();
          expect(expectedBounds, `${id}: Chromium emitted no colored mask ink`).not.toBeNull();
          const edgeError = Math.max(...actualBounds!.map((value, index) => Math.abs(value - expectedBounds![index])));
          expect(edgeError, `${id}: colored ink bounds diverged in device pixels`).toBeLessThanOrEqual(3);
        }
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it("keeps explicit sizing off the intrinsic route and removes capture probes", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 180, height: 140 }, deviceScaleFactor: 1 });
    const source = await context.newPage();
    try {
      await source.setContent(`<style>
        body{margin:0}
        #explicit{width:120px;height:90px;background:#16834a;mask-mode:alpha;mask-repeat:no-repeat;
          mask-image:url("${WIDE}");mask-size:40px 30px;mask-position:17px 9px}
      </style><div id="explicit"></div>`, { waitUntil: "load" });
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 180, height: 140 });
      const cases = masked(tree);
      expect(cases).toHaveLength(1);
      expect(cases[0].styles.maskIntrinsic).toEqual([null]);
      expect(await source.evaluate(() => ({
        hostProbe: "__domotionMaskIntrinsicTargets" in globalThis,
        elementProbe: "__domotionMaskIntrinsic" in document.querySelector("#explicit")!,
      }))).toEqual({ hostProbe: false, elementProbe: false });
    } finally {
      await context.close();
    }
  }, 60_000);

  it("emits a continuous clipped strip for slice and per-fragment tiles for clone", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 360, height: 220 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const rendered = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0;width:150px;font:20px/28px Arial;color:rgb(32,95,210)}
        span{mask-image:url("${WIDE}");mask-size:contain;mask-position:23% 73%;mask-repeat:no-repeat;mask-mode:alpha}
        #clone{box-decoration-break:clone;-webkit-box-decoration-break:clone}
      </style><div><span id="slice">wrapping inline fragment strip geometry</span></div><div><span id="clone">wrapping inline fragment clone geometry</span></div>`, { waitUntil: "load" });
      const expected = await page.screenshot();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 220 });
      const cases = masked(tree);
      expect(cases).toHaveLength(2);
      expect(cases[0].inlineFragments!.length).toBeGreaterThan(1);
      expect(cases[1].inlineFragments!.length).toBeGreaterThan(1);
      const svg = elementTreeToSvg(tree, 360, 220);
      expect((svg.match(/id="[^" ]*fc\d+-\d+"/g) ?? []).length)
        .toBe(cases[0].inlineFragments!.length + cases[1].inlineFragments!.length);
      expect(svg).toContain('clip-path="url(#');
      await rendered.setContent(`<body style="margin:0;background:white">${svg}</body>`, { waitUntil: "load" });
      const actual = await rendered.screenshot();
      expect(await meanAbsoluteError(expected, actual)).toBeLessThan(2.4);
    } finally {
      await context.close();
    }
  }, 60_000);
});
