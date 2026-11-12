import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-NVVDRB: 3D border shades follow Blink's CalculateInsetOutsetColor
// (core/paint/box_border_painter.cc:616 at 6b5a1b80): Color::Dark() for the
// dark edge, and Color::Light() for the light edge when the color contrasts
// with its dark shade by less than 1.75. Red takes the high-channel shortcut,
// rgb(40,90,200) the plain Dark() path, and #102040 the Light() substitution.

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);
const describeBrowser = env ? describe : describe.skip;

const VIEW = { x: 0, y: 0, width: 100, height: 100 };
// Outer and inner half of each 8px side at its midpoint, clear of the corner joins.
const SAMPLES: Array<[number, number]> = [
  [40, 21],
  [40, 26],
  [58, 40],
  [53, 40],
  [40, 58],
  [40, 53],
  [21, 40],
  [26, 40],
];

async function sampleColors(browser: Browser, html: string): Promise<string[]> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const png = (await page.screenshot({ omitBackground: true })).toString("base64");
    return await page.evaluate(
      async ({ data, samples }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return samples.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).join(","));
      },
      { data: png, samples: SAMPLES },
    );
  } finally {
    await page.close();
  }
}

describeBrowser("3D border shades (DM-NVVDRB)", () => {
  for (const color of ["red", "rgb(40,90,200)", "#102040"]) {
    for (const style of ["groove", "ridge", "inset", "outset"]) {
      it(`matches native ${style} shades for ${color}`, async () => {
        const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:40px;height:40px;box-sizing:border-box;border:8px ${style} ${color}}</style><div id="probe"></div>`;
        const native = await sampleColors(env!.browser, source);
        const page = await env!.browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
        let svg: string;
        try {
          await page.setContent(source, { waitUntil: "load" });
          svg = elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
        } finally {
          await page.close();
        }
        const rendered = await sampleColors(
          env!.browser,
          `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
        );
        expect(rendered).toEqual(native);
      });
    }
  }
});
