import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-ZVQJYP: `outline-style: auto` and the default keyboard focus ring paint
// Blink's two-ring focus ring, not a single outline-width stroke.
const viewport = { x: 0, y: 0, width: 100, height: 100 };
const BOX = "position:absolute;left:20px;top:20px;width:20px;height:20px";
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const cases = [
  { name: "authored auto", css: "outline:2px auto red", bg: "white" },
  { name: "outer ring on black", css: "outline:2px auto red", bg: "black" },
  { name: "keyboard focus", css: "", bg: "white", focus: true },
  { name: "dark color scheme", css: "outline:2px auto red;color-scheme:dark", bg: "black", scheme: "dark" as const },
  {
    name: "border, offset and radius",
    css: "outline:2px auto red;border:2px solid blue;outline-offset:3px;border-radius:6px",
    bg: "black",
  },
  { name: "zero outline-width", css: "outline:0 auto red", bg: "black" },
  { name: "transparent color keeps the outer ring", css: "outline:2px auto transparent", bg: "black" },
  { name: "collapsing negative offset", css: "outline:2px auto red;outline-offset:-10px", bg: "white" },
  { name: "elliptical radius", css: "outline:2px auto red;border-radius:10px/4px", bg: "white" },
  { name: "zoom", css: "outline:2px auto red;zoom:2", bg: "black" },
];

it.each(cases)("matches native paint: $name", async ({ css, bg, focus, scheme }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.emulateMedia({ colorScheme: scheme ?? "light" });
    await page.setContent(
      `<style>body{margin:0;background:${bg}}</style><div tabindex="0" style="${BOX};${css}"></div>`,
    );
    if (focus === true) await page.keyboard.press("Tab");
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent(`<style>body{margin:0;background:${bg}}</style>${elementTreeToSvg(tree, 100, 100)}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let differing = 0;
    for (let i = 0; i < native.length; i++) if (native[i] !== actual[i]) differing++;
    // Both rings are geometric strokes on integer rects; the prior single
    // stroke differed at 208 pixels per case.
    expect(differing).toBe(0);
  } finally {
    await page.close();
    await output.close();
  }
});
