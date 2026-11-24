import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 100, height: 90 };
const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];
const pixels = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
let browser: Browser;
let png: string;
let alphaPng: string;

beforeAll(async () => {
  browser = await launchChromium();
  const pattern = Array.from(
    { length: 16 },
    (_, index) => colors[Math.floor(index / 8) * 2 + Math.floor((index % 4) / 2)],
  );
  const opaque = await sharp(Buffer.from(pattern.flat()), { raw: { width: 4, height: 4, channels: 3 } })
    .png()
    .toBuffer();
  const alpha = await sharp(Buffer.from(pattern.flatMap((rgb) => [...rgb, 128])), {
    raw: { width: 4, height: 4, channels: 4 },
  })
    .png()
    .toBuffer();
  png = `data:image/png;base64,${opaque.toString("base64")}`;
  alphaPng = `data:image/png;base64,${alpha.toString("base64")}`;
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const integral = "from{transform:scale(1.5,2.5)}to{transform:scale(2.5,3.5)}";
const fractional = "from{transform:scale(1.25,1.125)}to{transform:scale(1.75,1.375)}";
const solidBackground = "background:rgb(28,97,156)";
async function setSource(
  page: Page,
  markup: string,
  { frames = integral, inset = 3.375, origin = "0 0", imageCss = "", ownerCss = "" } = {},
) {
  await page.setContent(`<!doctype html><style>
  html,body{margin:0}
  #owner{position:absolute;left:20.5px;top:20.25px;width:24px;height:18px;transform-origin:${origin};
  animation:sample 2s -1s linear both paused;${ownerCss}}
  @keyframes sample{${frames}}
  #surface{position:absolute;left:${inset}px;top:${inset}px;width:4px;height:4px;display:block;
  overflow:visible;object-fit:fill;${imageCss}}
  </style><div id="owner">${markup}</div>`);
  await page.evaluate(async () => {
    const source = document.querySelector("#surface");
    if (source instanceof HTMLImageElement) await source.decode();
    const owner = document.getElementById("owner")!;
    void getComputedStyle(owner).transform;
    await Promise.all(owner.getAnimations().map((animation) => animation.ready));
  });
}

it.each([
  { mode: "integral scale", frames: integral, inset: 3.375, box: [23.875, 23.625] },
  { mode: "fractional scale", frames: fractional, inset: 4.375, box: [24.875, 24.625] },
  {
    mode: "an aligned solid owner outline",
    frames: fractional,
    inset: 4.375,
    box: [24.875, 24.625],
    ownerCss: `height:16px;${solidBackground};outline:4px solid magenta`,
  },
  {
    mode: "a solid owner background with fractional edges",
    frames: fractional,
    inset: 4.375,
    box: [24.875, 24.625],
    ownerCss: `width:23px;height:17px;${solidBackground}`,
  },
])("paints a source PNG at whole device edges under $mode", async ({ frames, inset, box, ownerCss }) => {
  const source = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await setSource(source, `<img id="surface" src="${png}">`, { frames, inset, ownerCss });
    const evidence = await source.evaluateHandle(() => {
      const owner = document.getElementById("owner")!;
      const image = document.querySelector<HTMLImageElement>("#surface")!;
      let overrides = 0;
      let mutations = 0;
      window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
        construct(constructor, args, newTarget) {
          const effect = Reflect.construct(constructor, args, newTarget) as KeyframeEffect;
          if (effect.target === owner || effect.target === image) overrides++;
          return effect;
        },
      });
      new MutationObserver((records) => {
        mutations += records.length;
      }).observe(owner, { attributes: true, attributeFilter: ["style"], subtree: true });
      return () => ({
        overrides,
        mutations,
        animations: owner
          .getAnimations()
          .map(({ playState, currentTime, playbackRate }) => [playState, currentTime, playbackRate]),
        source: image.currentSrc,
        size: [image.naturalWidth, image.naturalHeight],
      });
    });
    const native = await pixels(await screenshotAfterPresentedFrame(source, { omitBackground: true }));
    const before = await evidence.evaluate((read) => read());
    const tree = await captureElementTree(source, "body", viewport);
    expect(await evidence.evaluate((read) => read())).toEqual(before);
    expect([before.overrides, before.mutations]).toEqual([0, 0]);
    expect(before.source).toBe(png);
    expect(before.size).toEqual([4, 4]);
    const [owner] = tree;
    expect([owner.x, owner.y]).toEqual([20.5, 20.25]);
    expect(owner.styles.transformPaintShift).toEqual([0.5, -0.25]);
    const [image] = owner.children;
    expect([image.x, image.y, image.width, image.height]).toEqual([...box, 4, 4]);
    expect(image.imageSrc).toBe(png);
    expect(image.imageIntrinsic).toEqual({ w: 4, h: 4 });
    expect(image.imagePaintBasis).toMatchObject({ source: "blink-image-paint-basis-v1", width: 4, height: 4 });
    expect(image.replacedSnapshot).toBeUndefined();
    const svg = elementTreeToSvg(tree, viewport.width, viewport.height);
    expect(svg).toContain(`<image href="${png}"`);
    await output.setContent("<!doctype html><style>html,body{margin:0}</style>" + svg);
    expect(await pixels(await output.screenshot({ omitBackground: true }))).toEqual(native);
  } finally {
    await source.close();
    await output.close();
  }
});

it.each([
  {
    mode: "an owner reflection",
    ownerCss: "height:10px;-webkit-box-reflect:below 2px",
    paintRegion: { left: 0, top: 45, width: 100, height: 45 },
  },
  {
    mode: "an image reflection",
    imageCss: "-webkit-box-reflect:below 2px",
    paintRegion: { left: 0, top: 45, width: 100, height: 45 },
  },
  {
    mode: "a fractional owner outline with an aligned image",
    ownerCss: `height:16px;${solidBackground};outline:1px solid magenta`,
    frames: fractional,
    inset: 4.375,
    paintRegion: { left: 19, top: 19, width: 39, height: 1 },
  },
])("keeps the live rect when native Chromium paints $mode", async ({ paintRegion, ...settings }) => {
  const page = await browser.newPage({ viewport });
  try {
    await setSource(page, `<img id="surface" src="${png}">`, settings);
    const native = await screenshotAfterPresentedFrame(page, { omitBackground: true });
    const extraPaint = await sharp(native).extract(paintRegion).ensureAlpha().raw().toBuffer();
    expect(extraPaint.some((value, index) => index % 4 === 3 && value !== 0)).toBe(true);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(owner.styles.transform).toBe("none");
    expect(owner.children[0].imageSrc).toBe(png);
    expect(owner.children[0].imagePaintBasis).toBeUndefined();
  } finally {
    await page.close();
  }
});

it("keeps CSS generated owner content outside the source-image wrapper", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await setSource(page, `<img id="surface" src="${png}">`, { ownerCss: `content:url("${png}")` });
    expect(await page.locator("#surface").evaluate((image) => image.getClientRects().length)).toBe(0);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(owner.styles.transform).toBe("none");
  } finally {
    await page.close();
  }
});

it.each([
  { mode: "half-pixel projection", origin: "6.5px 8.25px" },
  { mode: "non-intrinsic destination", imageCss: "width:5px" },
  { mode: "nondefault object position", imageCss: "object-position:2px 3px" },
  { mode: "clipped overflow", imageCss: "overflow:clip" },
  { mode: "alpha source", useAlpha: true },
  { mode: "responsive source", responsive: true },
])("keeps the live rect for an unqualified image with $mode", async ({ origin, imageCss, useAlpha, responsive }) => {
  const page = await browser.newPage({ viewport });
  try {
    const source = useAlpha ? alphaPng : png;
    await setSource(page, `<img id="surface" src="${source}" ${responsive ? `srcset="${source} 1x"` : ""}>`, {
      origin,
      imageCss,
    });
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(owner.styles.transform).toBe("none");
    expect(owner.styles.transformPaintShift).toBeUndefined();
    expect(owner.children[0].imageSrc).toBe(source);
  } finally {
    await page.close();
  }
});

it("keeps a viewport screenshot producer outside the live local wrapper", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await setSource(page, '<canvas id="surface" width="4" height="4"></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#surface")!;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "red";
      context.fillRect(0, 0, 4, 4);
    });
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(owner.styles.transform).toBe("none");
    const [canvas] = owner.children;
    expect(canvas.replacedSnapshot?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(canvas.replacedSnapshot?.rasterToOutput).toMatchObject({
      pixelWidth: 9,
      pixelHeight: 13,
      cssPerPixelX: 1,
      cssPerPixelY: 1,
    });
  } finally {
    await page.close();
  }
});
