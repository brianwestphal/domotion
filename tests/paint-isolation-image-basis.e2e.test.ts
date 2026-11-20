import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Paint isolation (`NeedsIsolationNodes`, Chromium 7d859f27
// core/paint/paint_property_tree_builder.cc:570-589: eligible paint
// containment, or style AND layout containment) rounds the isolating box's
// paint offset and drops the subpixel accumulation beneath it (:744-749), so
// its subtree paints displaced by round(P) - P. `ImagePainter::PaintIntoRect`
// (core/paint/image_painter.cc:205-239) then snaps an image's destination and
// content rectangles in that local space. The capture records the local basis
// separately from the DOM geometry; each case must match native Chromium's
// full RGBA exactly, and removing the basis records must not.
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
let tile = "";
let wide = "";
let zoomed = "";
beforeAll(async () => {
  browser = await launchChromium();
  // Deterministic owned pixels, painted 1:1 so only the destination rectangle
  // (not resampling) decides the result.
  const pixels = (w: number, h: number) => {
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        data[i] = (x * 37 + y * 11) % 256;
        data[i + 1] = (y * 41 + x * 7) % 256;
        data[i + 2] = (x * y * 13) % 256;
        data[i + 3] = 255;
      }
    return sharp(data, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();
  };
  tile = `data:image/png;base64,${(await pixels(20, 20)).toString("base64")}`;
  wide = `data:image/png;base64,${(await pixels(24, 18)).toString("base64")}`;
  // 20 CSS px at zoom 1.25 paints 25 device px.
  zoomed = `data:image/png;base64,${(await pixels(25, 25)).toString("base64")}`;
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
/** Differing pixels (full RGBA) and the first one, for a legible failure. */
const pixelDiff = (a: Buffer, b: Buffer) => {
  let changed = 0;
  let first: { x: number; y: number; a: number[]; b: number[] } | null = null;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
    changed++;
    first ??= {
      x: (i / 4) % viewport.width,
      y: Math.floor(i / 4 / viewport.width),
      a: [...a.subarray(i, i + 4)],
      b: [...b.subarray(i, i + 4)],
    };
  }
  return { changed, first };
};

const img = (src: () => string, style: string) => () =>
  `<img src="${src()}" style="display:block;width:20px;height:20px;${style}">`;

const cases: Array<{ name: string; html: () => string; isolated: boolean; frozenAncestor?: true }> = [
  {
    name: "image at a fractional position without isolation",
    html: () => `<div style="padding:10.4px 0 0 7.3px">${img(() => tile, "")()}</div>`,
    isolated: false,
  },
  {
    name: "image under a style+layout contained parent",
    html: () =>
      `<div style="contain:layout style;margin:5.3px 0 0 6.6px;padding:4.4px 0 0 3.2px">${img(() => tile, "")()}</div>`,
    isolated: true,
  },
  {
    name: "image under a layout-only contained parent",
    html: () =>
      `<div style="contain:layout;margin:5.3px 0 0 6.6px;padding:4.4px 0 0 3.2px">${img(() => tile, "")()}</div>`,
    isolated: false,
  },
  {
    name: "image under nested paint and content containment",
    html: () =>
      `<div style="contain:content;margin:3.3px 0 0 2.7px;padding:2.4px 0 0 1.4px"><div style="contain:paint;padding:4.6px 0 0 5.3px">${img(() => tile, "")()}</div></div>`,
    isolated: true,
  },
  {
    name: "object-fit:none crop under style+layout containment",
    html: () =>
      `<div style="contain:layout style;margin:5.3px 0 0 6.6px;padding:4.4px 0 0 3.2px">${img(() => wide, "width:16px;height:16px;object-fit:none;object-position:3.3px 1.7px")()}</div>`,
    isolated: true,
  },
  {
    name: "isolated image under CSS zoom",
    html: () =>
      `<div style="zoom:1.25"><div style="contain:layout style;margin:4.3px 0 0 5.4px;padding:3.4px 0 0 2.2px">${img(() => zoomed, "width:20px;height:20px")()}</div></div>`,
    isolated: true,
  },
  {
    name: "isolated image under a frozen integral translation",
    frozenAncestor: true,
    html: () =>
      `<div style="transform:translate(2px,1px)"><div style="contain:layout style;margin:5.3px 0 0 6.6px;padding:4.4px 0 0 3.2px">${img(() => tile, "")()}</div></div>`,
    isolated: true,
  },
  {
    name: "isolated image inside an integrally scrolled container",
    html: () =>
      `<div id="scroller" style="overflow:hidden;width:90px;height:90px;margin:1.3px 0 0 2.6px"><div style="height:200px;padding-top:7.4px"><div style="contain:layout style;margin:5.3px 0 0 6.6px;padding:4.4px 0 0 3.2px">${img(() => tile, "")()}</div></div></div><script>document.getElementById("scroller").scrollTop = 3</script>`,
    isolated: true,
  },
];

const stripBasis = (nodes: CapturedElement[]) => {
  for (const node of nodes) {
    delete node.imagePaintBasis;
    delete node.borderPaintSnap;
    stripBasis(node.children);
  }
};
const find = (nodes: CapturedElement[], tag: string): CapturedElement | undefined => {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const found = find(node.children, tag);
    if (found != null) return found;
  }
  return undefined;
};

it.each(cases)("paints native image pixels: $name", async ({ html, isolated, frozenAncestor }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>body{margin:0}</style>${html()}`);
    await page.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const tree = await captureElementTree(page, "body", viewport);
    const image = find(tree, "img");
    expect(image?.imagePaintBasis?.source).toBe("blink-image-paint-basis-v1");
    // The DOM geometry is retained; only the basis carries the paint space.
    const domRect = await page.locator("img").evaluate((node) => node.getBoundingClientRect().toJSON());
    // (A frozen ancestor transform is captured untransformed, then re-applied.)
    if (frozenAncestor !== true) expect(image?.y).toBeCloseTo(domRect.y, 5);
    const shift = image?.imagePaintBasis?.shift ?? { x: 0, y: 0 };
    expect(shift.x !== 0 || shift.y !== 0).toBe(isolated);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(pixelDiff(await rgba(await output.screenshot({ omitBackground: true })), source)).toEqual({
      changed: 0,
      first: null,
    });
    // Negative control: the captured DOM geometry alone does not reproduce it.
    stripBasis(tree);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(pixelDiff(await rgba(await output.screenshot({ omitBackground: true })), source).changed).toBeGreaterThan(0);
  } finally {
    await page.close();
    await output.close();
  }
});

it.each([
  { name: "style+layout containment", contain: "layout style", isolated: true },
  { name: "paint containment", contain: "paint", isolated: true },
  { name: "layout-only containment", contain: "layout", isolated: false },
])("snaps box decorations beneath $name in the isolated paint space", async ({ contain, isolated }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}</style><div style="contain:${contain};margin:5.4px 0 0 6.4px;padding:4.4px 0 0 3.3px;width:60px"><div id="box" style="width:20.3px;height:20.3px;background:red;border:2px solid blue"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const tree = await captureElementTree(page, "body", viewport);
    const findBox = (nodes: CapturedElement[]): CapturedElement | undefined => {
      for (const node of nodes) {
        if (node.styles.backgroundColor === "rgb(255, 0, 0)") return node;
        const found = findBox(node.children);
        if (found != null) return found;
      }
      return undefined;
    };
    const box = findBox(tree);
    expect(box?.borderPaintSnap).toBeDefined();
    expect(box?.borderPaintSnap?.shift != null).toBe(isolated);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(pixelDiff(await rgba(await output.screenshot({ omitBackground: true })), source)).toEqual({
      changed: 0,
      first: null,
    });
    if (isolated) {
      // Negative control: snapping in the unisolated space paints elsewhere.
      if (box?.borderPaintSnap != null) {
        const { shift } = box.borderPaintSnap;
        box.borderPaintSnap = {
          ...box.borderPaintSnap,
          left: box.borderPaintSnap.left - (shift?.x ?? 0),
          right: box.borderPaintSnap.right - (shift?.x ?? 0),
          top: box.borderPaintSnap.top - (shift?.y ?? 0),
          bottom: box.borderPaintSnap.bottom - (shift?.y ?? 0),
        };
        delete box.borderPaintSnap.shift;
      }
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      expect(pixelDiff(await rgba(await output.screenshot({ omitBackground: true })), source).changed).toBeGreaterThan(
        0,
      );
    }
  } finally {
    await page.close();
    await output.close();
  }
});
