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

// DM-7NN5E6: a focus ring around a wrapped inline element outlines the union
// of its line fragments with corner-rounded right angles, not its bounding
// box. Text is transparent so only the ring is compared.
it.each([
  { name: "two lines", width: 70, text: "bb cc dd ee" },
  { name: "three lines", width: 60, text: "bb cc dd ee gg hh" },
])("matches native paint for a wrapped inline ring: $name", async ({ width, text }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0;background:white}</style><div style="margin:10px;width:${width}px;font:14px/20px Arial;color:transparent">a <span style="outline:2px auto red">${text}</span> f</div>`,
    );
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 100, 100)}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let differing = 0;
    for (let i = 0; i < native.length; i++) if (native[i] !== actual[i]) differing++;
    // The bounding-box ring differed at 380 (two lines) and 708 (three lines).
    expect(differing).toBe(0);
  } finally {
    await page.close();
    await output.close();
  }
});

// DM-9JNAVF / DM-EQ1MPF / DM-BK59F6: a wrapped inline's square outline, in
// any style, is ComplexOutlinePainter's ring around the union of its line
// fragments, not around its bounding box.
it.each([
  { name: "solid, two lines", width: 70, outline: "2px solid red", text: "bb cc dd ee" },
  {
    name: "solid with offset, three lines",
    width: 60,
    outline: "3px solid blue;outline-offset:1px",
    text: "bb cc dd ee gg hh",
  },
  { name: "double, two lines", width: 70, outline: "6px double green", text: "bb cc dd ee" },
  { name: "dashed 2px, two lines", width: 70, outline: "2px dashed red", text: "bb cc dd ee" },
  { name: "dashed 3px, three lines", width: 60, outline: "3px dashed blue", text: "bb cc dd ee gg hh" },
  { name: "dotted 1px, two lines", width: 70, outline: "1px dotted red", text: "bb cc dd ee" },
  { name: "dotted 2px, two lines", width: 70, outline: "2px dotted red", text: "bb cc dd ee" },
  // Round-dot edge anti-aliasing differs by at most 4 levels.
  { name: "dotted 5px, two lines", width: 70, outline: "5px dotted green", text: "bb cc dd ee", tolerance: 4 },
  // DM-BK59F6: 3D styles stroke per-edge shades in non-AA miter clips.
  { name: "inset 4px", width: 70, outline: "4px inset red", text: "bb cc dd ee" },
  { name: "outset 7px", width: 70, outline: "7px outset rgb(10,200,90)", text: "bb cc dd ee" },
  { name: "groove 6px, three lines", width: 60, outline: "6px groove blue", text: "bb cc dd ee gg hh" },
  { name: "ridge 5px", width: 70, outline: "5px ridge green", text: "bb cc dd ee" },
  { name: "groove 1px paints solid", width: 70, outline: "1px groove red", text: "bb cc dd ee" },
  { name: "translucent ridge", width: 70, outline: "4px ridge rgba(255,0,0,0.5)", text: "bb cc dd ee", tolerance: 1 },
  // DM-QKCK1K: rounded contours (AddCornerRadiiToPath). Curved edges differ
  // only in anti-aliasing; round dots drift sub-pixel along the arcs, where
  // Skia measures the conic and SVG its arc.
  { name: "rounded solid", width: 70, outline: "3px solid red;border-radius:6px", text: "bb cc dd ee", tolerance: 8 },
  {
    name: "rounded solid with offset",
    width: 70,
    outline: "2px solid blue;border-radius:4px;outline-offset:2px",
    text: "bb cc dd ee",
    tolerance: 8,
  },
  {
    name: "rounded double",
    width: 70,
    outline: "6px double green;border-radius:5px",
    text: "bb cc dd ee",
    tolerance: 10,
  },
  {
    name: "rounded per-corner",
    width: 70,
    outline: "4px solid red;border-radius:8px 2px",
    text: "bb cc dd ee",
    tolerance: 12,
  },
  { name: "rounded dashed", width: 70, outline: "2px dashed red;border-radius:6px", text: "bb cc dd ee", tolerance: 4 },
  {
    name: "rounded thin dotted",
    width: 70,
    outline: "3px dotted blue;border-radius:5px",
    text: "bb cc dd ee",
    tolerance: 4,
  },
  {
    name: "rounded round dots",
    width: 70,
    outline: "5px dotted green;border-radius:7px",
    text: "bb cc dd ee",
    tolerance: 80,
  },
  // The alpha layer quantizes 0.5 one level apart (126 vs 127).
  { name: "translucent dashed", width: 70, outline: "4px dashed rgba(255,0,0,0.5)", text: "bb cc dd ee", tolerance: 1 },
])("matches native paint for a wrapped inline outline: $name", async ({ width, outline, text, tolerance = 0 }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0;background:white}</style><div style="margin:10px;width:${width}px;font:14px/20px Arial;color:transparent">a <span style="outline:${outline}">${text}</span> f</div>`,
    );
    const native = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    const tree = await captureElementTree(page, "body", viewport);
    await output.setContent(`<style>body{margin:0;background:white}</style>${elementTreeToSvg(tree, 100, 100)}`);
    const actual = await sharp(await output.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer();
    let differing = 0;
    for (let i = 0; i < native.length; i++) if (Math.abs(native[i]! - actual[i]!) > tolerance) differing++;
    // The bounding-box outline differed at 292-672 pixels (DM-9JNAVF), and a
    // 2px dashed one at 298 (DM-EQ1MPF).
    expect(differing).toBe(0);
  } finally {
    await page.close();
    await output.close();
  }
});
