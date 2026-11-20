import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-RN0T12: a viewport-fixed box paints inside its nearest genuine stacking
// context, under that context's opacity, blend and clip-path, while escaping
// overflow clips of ancestors that are not its containing block.
const viewport = { x: 0, y: 0, width: 100, height: 80 };
const FIXED = "position:fixed;left:50px;top:20px;width:30px;height:30px;background:rgb(0,0,255)";
const BOX = "margin:10px;width:40px;height:40px";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const cases = [
  { name: "opacity ancestor", body: `<div style="${BOX};opacity:.5"><div style="${FIXED}"></div></div>` },
  {
    name: "nested opacity ancestors",
    body: `<div style="${BOX};opacity:.5"><div style="opacity:.5"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "mix-blend-mode ancestor",
    body: `<div style="${BOX};mix-blend-mode:multiply;background:yellow"><div style="${FIXED}"></div></div>`,
  },
  { name: "clip-path ancestor", body: `<div style="${BOX};clip-path:inset(0)"><div style="${FIXED}"></div></div>` },
  {
    name: "opacity ancestor with overflow clip",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="${FIXED}"><div style="width:10px;height:10px;background:lime"></div></div></div>`,
  },
  {
    name: "overflow clip still clips the context's own text",
    // The text line inside the clip (x 10-49, y 10-29).
    textRect: { left: 10, top: 10, right: 50, bottom: 30 },
    body: `<div style="${BOX};opacity:.5;overflow:hidden;font:20px/20px Arial;white-space:nowrap">WWWWWW<div style="${FIXED}"></div></div>`,
  },
  {
    name: "z-index wrapper bounds the fixed box's z-order",
    body: `<div style="${BOX};position:relative;z-index:1"><div style="${FIXED};z-index:1000"></div></div><div style="position:absolute;z-index:2;left:60px;top:30px;width:30px;height:30px;background:red"></div>`,
  },
  {
    name: "containing block keeps its overflow clip",
    body: `<div style="${BOX};transform:translateX(0);overflow:hidden;opacity:.5"><div style="${FIXED}"></div></div>`,
  },
  {
    name: "overflow-only scroller is escaped",
    body: `<div style="${BOX};overflow:hidden"><div style="${FIXED}"></div></div>`,
  },
  // DM-X4W03B: the clipping context's overflow clip moves inside nested
  // opacity / z-index contexts, so the fixed box still escapes it. Each case
  // kept the clip before (max channel difference 49-200).
  {
    name: "escapes a clip outside a nested opacity context",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="opacity:.5"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "escapes a clip outside two nested opacity contexts",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="opacity:.8"><div style="opacity:.7"><div style="${FIXED}"></div></div></div></div>`,
  },
  {
    name: "escapes a clip re-applied around a hoisted z-index context",
    body: `<div style="${BOX};overflow:hidden;background:rgb(0,160,0)"><div style="position:relative;z-index:1"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "nested context siblings stay clipped",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="opacity:.5"><div style="width:90px;height:10px;background:red"></div><div style="${FIXED}"></div><div style="width:90px;height:10px;background:lime"></div></div></div>`,
  },
  {
    name: "escapes both the nested context's clip and its ancestor's",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="opacity:.5;overflow:hidden;width:30px;height:30px"><div style="width:90px;height:10px;background:red"></div><div style="${FIXED}"></div></div></div>`,
  },
  // DM-V1PPTQ: a blend context with an escaping fixed descendant has no output
  // clip in Blink, so its layer opens outside the ancestor overflow clip and
  // only non-escaping content re-enters it. Each case kept the clip before
  // (max channel difference 100-205).
  {
    name: "escapes a clip outside a nested blend context",
    body: `<div style="${BOX};overflow:hidden;background:rgb(255,255,0)"><div style="mix-blend-mode:multiply"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "escaped fixed box blends with the backdrop behind the clip",
    body: `<div style="position:absolute;left:0;top:0;width:100px;height:80px;background:rgb(200,100,50)"></div><div style="${BOX};position:relative;overflow:hidden"><div style="mix-blend-mode:screen"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "nested blend context siblings stay clipped",
    body: `<div style="${BOX};overflow:hidden;background:rgb(255,255,0)"><div style="mix-blend-mode:multiply"><div style="width:90px;height:10px;background:red"></div><div style="${FIXED}"></div><div style="width:90px;height:10px;background:lime"></div></div></div>`,
  },
  // DM-V1PPTQ negative controls: a mask or clip-path context's MaskClip /
  // ClipPathClip is parented on the ancestor clip and becomes the fixed-position
  // clip, so the fixed box keeps the ancestor's overflow clip natively.
  {
    name: "keeps the clip outside a nested clip-path context",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="clip-path:inset(0 -100px 0 0)"><div style="${FIXED}"></div></div></div>`,
  },
  {
    name: "keeps the clip outside a nested mask context",
    body: `<div style="${BOX};opacity:.5;overflow:hidden"><div style="mask-image:linear-gradient(black,black);mask-size:200px 200px;mask-repeat:no-repeat"><div style="${FIXED}"></div></div></div>`,
  },
];

// DM-X4W03B: on Linux, adding the fixed child composites the opacity context,
// and Chromium then rasterizes the context's own text differently (its native
// text pixels move by up to 39 levels while the SVG's are unchanged; on macOS
// they move by 2). That is the documented native text rasterization floor, not
// effect ownership, so off macOS the text line is excluded from the strict
// comparison. Every other pixel, including the whole clip edge and the escaped
// fixed box, stays within 2 levels.
const textRasterExempt = (textRect: Rect | undefined, x: number, y: number): boolean =>
  process.platform !== "darwin" &&
  textRect != null &&
  x >= textRect.left &&
  x < textRect.right &&
  y >= textRect.top &&
  y < textRect.bottom;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

it.each(cases)("matches native paint: $name", async ({ body, textRect }: { body: string; textRect?: Rect }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0;background:white}</style><div style="width:100px;height:80px;background:rgb(200,200,200)">${body}</div>`,
    );
    const native = await sharp(await page.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 100, 80)}`);
    const actual = await sharp(await output.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer();
    let worst = 0;
    for (let i = 0; i < native.length; i++) {
      const pixel = Math.floor(i / 4);
      if (textRasterExempt(textRect, pixel % viewport.width, Math.floor(pixel / viewport.width))) continue;
      worst = Math.max(worst, Math.abs(native[i] - actual[i]));
    }
    // Text antialiasing is the only residual; effect ownership errors are >= 50.
    expect(worst).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
    await output.close();
  }
});
