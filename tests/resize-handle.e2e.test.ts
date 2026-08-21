import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { measureBlinkPlatformResizer } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

async function colorBounds(
  png: Buffer,
  cssWidth: number,
  rgb: readonly [number, number, number],
): Promise<{ x: number; y: number; width: number; height: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2]) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  expect(maxX).toBeGreaterThanOrEqual(minX);
  const density = info.width / cssWidth;
  return {
    x: minX / density,
    y: minY / density,
    width: (maxX - minX + 1) / density,
    height: (maxY - minY + 1) / density,
  };
}

describeBrowser("DM-2418: Blink platform resizer capture and paint", () => {
  it("uses exact overflow/replaced/iframe activation and custom-pseudo ownership", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 900, height: 650 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>
        html,body{margin:0}.box{position:absolute;box-sizing:border-box;width:110px;height:74px;resize:both;border:2px solid #222}
        #none{left:10px;top:10px;overflow:auto;resize:none}
        #visible{left:130px;top:10px;overflow:visible}
        #clip{left:250px;top:10px;overflow:clip}
        #auto{left:370px;top:10px;overflow-x:auto;overflow-y:clip}
        #hidden{left:490px;top:10px;overflow-x:clip;overflow-y:hidden}
        #custom{left:610px;top:10px;overflow:hidden;direction:rtl}
        #custom::-webkit-resizer{width:4px;height:30px;background:rgb(1,254,2);border-radius:25%}
        #vertical-rtl{left:10px;top:100px;overflow:hidden;direction:rtl;writing-mode:vertical-rl}
        textarea{left:130px;top:100px;overflow:auto}
        iframe{left:250px;top:100px;overflow:hidden}
        iframe::-webkit-resizer{background:rgb(1,254,2)}
      </style>
      <div id="none" class="box" data-domotion-anim="none"></div>
      <div id="visible" class="box" data-domotion-anim="visible"></div>
      <div id="clip" class="box" data-domotion-anim="clip"></div>
      <div id="auto" class="box" data-domotion-anim="auto"><i style="display:block;width:220px;height:20px"></i></div>
      <div id="hidden" class="box" data-domotion-anim="hidden"></div>
      <div id="custom" class="box" data-domotion-anim="custom"></div>
      <div id="vertical-rtl" class="box" data-domotion-anim="vertical-rtl"></div>
      <textarea class="box" data-domotion-anim="textarea"></textarea>
      <iframe class="box" data-domotion-anim="iframe" srcdoc="<!doctype html><body></body>"></iframe>`);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 900, height: 650 });
      for (const id of ["none", "visible", "clip"]) expect(byAnimId(tree, id)!.resizeHandle, id).toBeUndefined();
      for (const id of ["auto", "hidden", "textarea", "iframe"]) expect(byAnimId(tree, id)!.resizeHandle, id).toBeDefined();

      const custom = byAnimId(tree, "custom")!.resizeHandle!;
      expect(custom.logicalLeft).toBe(true);
      expect(custom.custom).toMatchObject({
        authoredWidth: "4px",
        authoredHeight: "30px",
        backgroundColor: "rgb(1, 254, 2)",
      });
      expect(custom.width).not.toBe(4);
      expect(custom.height).not.toBe(30);
      expect(byAnimId(tree, "vertical-rtl")!.resizeHandle!.logicalLeft).toBe(false);
      // Iframe CanResize is the explicit source exception, but custom resizer
      // style creation is gated on IsScrollContainer and therefore absent.
      expect(byAnimId(tree, "iframe")!.resizeHandle!.custom).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it("matches Chromium's custom-corner pixels across CSS zoom and DPR", async () => {
    const rows: Array<{ dpr: number; theme: number; captured: { x: number; y: number; width: number; height: number }; browser: { x: number; y: number; width: number; height: number } }> = [];
    for (const dpr of [1, 2]) {
      const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 }, deviceScaleFactor: dpr });
      try {
        await page.setContent(`<style>html,body{margin:0;background:white}#custom{
          position:absolute;left:20px;top:24px;box-sizing:border-box;width:100px;height:70px;
          zoom:1.25;resize:both;overflow:hidden;direction:rtl;
          border-style:solid;border-width:2px 7px 5px 3px;border-color:black
        }#custom::-webkit-resizer{width:4px;height:30px;background:rgb(1,254,2)}</style>
        <div id="custom" data-domotion-anim="custom"></div>`);
        const expectedPng = await page.screenshot({ type: "png" });
        const metrics = await measureBlinkPlatformResizer(page);
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 240 });
        const handle = byAnimId(tree, "custom")!.resizeHandle!;
        rows.push({
          dpr,
          theme: metrics.themeThickness,
          captured: { x: handle.x, y: handle.y, width: handle.width, height: handle.height },
          browser: await colorBounds(expectedPng, 360, [1, 254, 2]),
        });
      } finally {
        await page.close();
      }
    }
    for (const row of rows) {
      expect(row.captured.x).toBeCloseTo(row.browser.x, 0);
      expect(row.captured.y).toBeCloseTo(row.browser.y, 0);
      expect(row.captured.width).toBeCloseTo(row.browser.width, 0);
      expect(row.captured.height).toBeCloseTo(row.browser.height, 0);
      expect(row.captured.width).toBe(row.theme);
    }
    expect(rows[1].theme).toBe(rows[0].theme);
    expect(rows[1].captured).toEqual(rows[0].captured);
    expect(rows[1].browser).toEqual(rows[0].browser);
  });

  it("measures the platform theme when strict CSP blocks the in-page probe", async () => {
    // Browser.newPage() intentionally exercises Playwright's owned-context
    // path: a fallback page cannot be opened through page.context().newPage().
    const page = await env!.browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 2 });
    try {
      await page.setContent(`<meta http-equiv="Content-Security-Policy" content="style-src 'none'">
        <main id="sentinel">strict page</main>`);
      const metrics = await measureBlinkPlatformResizer(page);
      expect(metrics.themeThickness).toBeGreaterThan(0);
      expect(metrics.scaleFromDIP).toBeGreaterThan(0);
      expect(await page.locator("#sentinel").textContent()).toBe("strict page");
      expect(await page.locator("[data-domotion-resizer-probe]").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("emits source platform paths, the scrollbar-only frame, and custom paint", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 520, height: 260 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>html,body{margin:0}.box{
        position:absolute;box-sizing:border-box;top:20px;width:110px;height:80px;
        resize:both;border:3px solid #222
      }#quiet{left:20px;overflow:hidden}#bars{left:150px;overflow:auto}
      #custom{left:280px;overflow:hidden}#custom::-webkit-resizer{background:rgb(1,254,2)}</style>
      <div id="quiet" class="box" data-domotion-anim="quiet"></div>
      <div id="bars" class="box" data-domotion-anim="bars"><i style="display:block;width:300px;height:220px"></i></div>
      <div id="custom" class="box" data-domotion-anim="custom"></div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 520, height: 260 });
      const quiet = byAnimId(tree, "quiet")!;
      const bars = byAnimId(tree, "bars")!;
      const custom = byAnimId(tree, "custom")!;
      expect(quiet.resizeHandle!.hasScrollbar).toBe(false);
      expect(bars.resizeHandle!.hasScrollbar).toBe(true);

      const quietSvg = elementTreeToSvgInner([quiet], 520, 260);
      const barsSvg = elementTreeToSvgInner([bars], 520, 260);
      const customSvg = elementTreeToSvgInner([custom], 520, 260);
      expect(quietSvg.match(/stroke-opacity="0\.6"/g)).toHaveLength(2);
      expect(quietSvg).not.toContain("rgb(217,217,217)");
      expect(barsSvg.match(/stroke-opacity="0\.6"/g)).toHaveLength(2);
      expect(barsSvg).toContain("rgb(217,217,217)");
      expect(customSvg).toContain('fill="rgb(1,254,2)"');
      expect(customSvg).not.toContain('stroke-opacity="0.6"');
    } finally {
      await page.close();
    }
  });
});
