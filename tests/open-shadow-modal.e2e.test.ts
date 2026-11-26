import sharp from "sharp";
import { afterAll, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const browser = await launchChromium();
afterAll(() => closeBrowserSafely(browser), 15_000);

const viewport = { x: 0, y: 0, width: 240, height: 180 };
const rawPixels = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();

it.each([1, 2])(
  "paints a fixed open-shadow dialog, backdrop, and higher sibling at DPR %i",
  async (deviceScaleFactor) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    try {
      const source = await context.newPage();
      const generated = await context.newPage();
      await source.setContent(`<!doctype html><style>
      html,body{margin:0;background:white}
      #under{position:fixed;inset:0;background:#4c6090}
      #above{position:fixed;left:170px;top:70px;width:8px;height:10px;z-index:40;background:#0a8}
    </style><div id="under"></div><div id="host"></div><div id="above"></div>`);
      await source.locator("#host").evaluate((host) => {
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
        .backdrop{position:fixed;inset:0;z-index:10;background:#ccc;opacity:.5}
        .dialog{position:fixed;top:50%;left:50%;width:124px;height:96px;z-index:20;
          transform:translate(-50%,-50%);transition:all .3s;background:#f7ead6}
        .banner{height:24px;background:#ac2534}
      </style><div class="dialog" role="dialog" aria-modal="true"><div class="banner"></div></div>
      <div class="backdrop"></div>`;
      });
      const sourceState = () =>
        source.locator("#host").evaluate((host) => ({
          liveHeight: host.getBoundingClientRect().height,
          host: host.outerHTML,
          shadow: host.shadowRoot?.innerHTML,
        }));
      const before = await sourceState();
      expect(before.liveHeight).toBe(0);
      const native = await source.screenshot();
      const { data, info } = await sharp(native).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => {
        const offset = (y * deviceScaleFactor * info.width + x * deviceScaleFactor) * 4;
        return [...data.subarray(offset, offset + 3)];
      };
      expect(pixel(8, 8)).toEqual([140, 150, 174]);
      expect(pixel(110, 49)).toEqual([172, 37, 52]);
      expect(pixel(120, 80)).toEqual([247, 234, 214]);
      expect(pixel(173, 75)).toEqual([0, 170, 136]);

      const capture = await captureElementTreeWithWarnings(source, "body", viewport);
      const svg = elementTreeToSvg(capture.tree, viewport.width, viewport.height);
      await generated.setContent(`<style>body{margin:0}</style>${svg}`);
      expect(await rawPixels(await generated.screenshot())).toEqual(data);
      expect(await sourceState()).toEqual(before);
      expect(await rawPixels(await source.screenshot())).toEqual(data);
    } finally {
      await context.close();
    }
  },
);
