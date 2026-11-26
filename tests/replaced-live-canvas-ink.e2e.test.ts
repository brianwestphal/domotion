import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, captureElementTreeWithWarnings, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 100, height: 90 };
const integral = {
  frames: "from{transform:scale(1.5,2.5)}to{transform:scale(2.5,3.5)}",
  origin: "0 0",
};
const fractional = {
  frames: "from{transform:matrix(1.25,0,0,1.125,2.125,-2.25)}to{transform:matrix(1.75,0,0,1.375,4.125,-6.25)}",
  origin: "6.5px 8.25px",
};
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function showCanvas(page: Page, { frames, origin } = integral, extra = "", surfaceStyle = "overflow:visible") {
  await page.setContent(`<!doctype html><style>html,body{margin:0}
    #owner{position:absolute;left:20.5px;top:20.25px;width:24px;height:18px;
      transform-origin:${origin};animation:sample 2s -1s linear both paused}
    #surface{position:absolute;display:block;left:3.375px;top:3.375px;width:4px;height:4px;${surfaceStyle}}
    @keyframes sample{${frames}}
    </style><div id=owner><canvas id=surface width=4 height=4></canvas></div>${extra}`);
  await page.evaluate(async () => {
    const canvas = document.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    for (const [index, color] of ["red", "lime", "blue", "yellow"].entries()) {
      context.fillStyle = color;
      context.fillRect((index % 2) * 2, Math.floor(index / 2) * 2, 2, 2);
    }
    await Promise.all(document.getAnimations().map((animation) => animation.ready));
  });
}

function readSourceState(page: Page) {
  return page.evaluate(() => {
    const owner = document.querySelector("#owner")!;
    const canvas = document.querySelector("canvas")!;
    return {
      ownerStyle: owner.getAttribute("style"),
      canvasStyle: canvas.getAttribute("style"),
      transform: getComputedStyle(owner).transform,
      times: owner.getAnimations().map(({ playState, currentTime }) => [playState, currentTime]),
      markers: document.querySelectorAll("[data-domotion-rid], [data-domotion-snapshot-target]").length,
    };
  });
}

async function rgba(page: Page) {
  return sharp(await screenshotAfterPresentedFrame(page, { omitBackground: true }))
    .ensureAlpha()
    .raw()
    .toBuffer();
}

it.each([
  { name: "integral live scale", input: integral, rect: { x: 27, y: 29, width: 8, height: 12 } },
  { name: "fractional live scale and origin", input: fractional, rect: { x: 25, y: 17, width: 7, height: 6 } },
])("preserves every native viewport pixel for $name", async ({ input, rect }) => {
  const page = await browser.newPage({ viewport });
  const rendered = await browser.newPage({ viewport });
  try {
    await showCanvas(page, input);
    const sourceState = await readSourceState(page);
    const expected = await rgba(page);
    const tree = await captureElementTree(page, "body", viewport);
    const owner = tree[0];
    expect(owner.styles.transform).toBe("none");
    const snapshot = owner.children[0].replacedSnapshot!;
    expect(snapshot).toMatchObject(rect);
    expect(snapshot.rasterToOutput).toMatchObject({
      pixelWidth: rect.width,
      pixelHeight: rect.height,
      cssPerPixelX: 1,
      cssPerPixelY: 1,
    });
    expect(await readSourceState(page)).toEqual(sourceState);
    await rendered.setContent(
      `<!doctype html><style>body{margin:0}</style>${elementTreeToSvg(tree, viewport.width, viewport.height)}`,
    );
    const actual = await rgba(rendered);
    const differing = [];
    for (let i = 0; i < expected.length; i += 4) {
      if (actual.subarray(i, i + 4).equals(expected.subarray(i, i + 4))) continue;
      differing.push({
        x: (i / 4) % viewport.width,
        y: Math.floor(i / 4 / viewport.width),
        native: [...expected.subarray(i, i + 4)],
        svg: [...actual.subarray(i, i + 4)],
      });
    }
    expect(differing.slice(0, 8), `${differing.length} differing viewport pixels`).toEqual([]);
  } finally {
    await page.close();
    await rendered.close();
  }
});

it.each(["forced visible sibling", "closed author shadow", "native canvas overflow clip"])(
  "keeps the stock clip with %s",
  async (foreign) => {
    const page = await browser.newPage({ viewport });
    try {
      const extra =
        foreign === "forced visible sibling"
          ? '<div style="position:absolute;left:0;top:0;width:6px;height:6px;background:magenta;visibility:visible!important"></div>'
          : "";
      await showCanvas(page, integral, extra, foreign === "native canvas overflow clip" ? "" : undefined);
      if (foreign === "closed author shadow") {
        await page.evaluate(() =>
          document.querySelector("#owner")!.attachShadow({ mode: "closed" }).append(document.createElement("slot")),
        );
      }
      const sourceState = await readSourceState(page);
      const tree = await captureElementTree(page, "body", viewport);
      expect(tree[0].children[0].replacedSnapshot).toMatchObject({ x: 27, y: 30, width: 9, height: 13 });
      expect(await readSourceState(page)).toEqual(sourceState);
    } finally {
      await page.close();
    }
  },
);

it("refuses to publish a viewport raster after a transient source mutation", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await showCanvas(page);
    const original = await readSourceState(page);
    const screenshot = page.screenshot.bind(page);
    let samples = 0;
    page.screenshot = async (options) => {
      if (options?.caret !== "initial" || options.clip != null) return screenshot(options);
      samples++;
      await page.locator("#owner").evaluate((owner) => owner.setAttribute("data-test-transient", "1"));
      const png = await screenshot(options);
      await page.locator("#owner").evaluate((owner) => owner.removeAttribute("data-test-transient"));
      return png;
    };
    const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", viewport);
    expect(samples).toBe(1);
    expect(tree[0].children[0].replacedSnapshot?.dataUri).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({
        feature: "replaced-element snapshot",
        detail: expect.stringContaining("isolated canvas or viewport changed during paint sampling"),
      }),
    );
    expect(await readSourceState(page)).toEqual(original);
  } finally {
    await page.close();
  }
});
