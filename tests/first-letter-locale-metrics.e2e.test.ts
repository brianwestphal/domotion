import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const cases = ["standard", "literal", "serif", "zoom", "serifZoom"] as const;
const viewport = { x: 0, y: 0, width: 330, height: 330 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((node) => [node, ...flat(node.children)]);

async function paintedFaces(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    return await Promise.all(
      cases.map(async (id) => {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        return Object.fromEntries(fonts.map((font) => [font.postScriptName, font.glyphCount]));
      }),
    );
  } finally {
    await cdp.detach();
  }
}

async function nativeBoxes(page: Page) {
  return page.locator("p").evaluateAll((paragraphs) =>
    paragraphs.map((p) => {
      const range = document.createRange();
      const text = p.firstChild!;
      const bounds = (start: number) => {
        range.setStart(text, start);
        range.setEnd(text, start + 1);
        const { x, y, width, height } = range.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        letter: bounds(0),
        body: bounds(1),
        baseline: p.querySelector(".baseline")!.getBoundingClientRect().top,
      };
    }),
  );
}

async function letterInk(page: Page): Promise<Buffer> {
  const pixels = await sharp(await screenshotAfterPresentedFrame(page))
    .ensureAlpha()
    .raw()
    .toBuffer();
  const result = Buffer.alloc(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    // The authored letter is red and all remaining body text is black.
    if (pixels[i] > pixels[i + 1] && pixels[i] > pixels[i + 2]) pixels.copy(result, i, i, i + 4);
  }
  return result;
}

it("captures the native inline first-letter ascent without borrowing the literal Times metrics", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const generated = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    const literal = await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily);
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:0; padding-left:16px; background:white }
      p { margin:0; font-size:16px; line-height:44px }
      p::first-letter { font-size:32px; color:rgb(160,0,0) }
      #literal::first-letter { font-family:${literal} }
      #serif::first-letter, #serifZoom::first-letter { font-family:serif }
      #zoom, #serifZoom { zoom:1.5 }
      .baseline { display:inline-block; width:0; height:0; vertical-align:baseline }
    </style>${cases.map((id) => `<p id="${id}" lang="ja">Hg<span class="baseline"></span></p>`).join("")}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const nativeInk = await letterInk(page);
    expect(nativeInk.some((value) => value !== 0)).toBe(true);
    const faces = await paintedFaces(page);
    const native = await nativeBoxes(page);
    const tree = await captureElementTree(page, "body", viewport);
    const paragraphs = flat(tree).filter((node) => node.tag === "p");
    expect(paragraphs).toHaveLength(cases.length);
    for (const [index, id] of cases.entries()) {
      const row = paragraphs[index];
      const [first, suppressed] = row.textSegments!;
      const body = row.textSegments!.find((seg) => seg.text === "g");
      const { letter, body: bodyBox, baseline } = native[index];
      const diagnostic = JSON.stringify({ id, faces: faces[index], letter, bodyBox, baseline });
      expect(first, diagnostic).toMatchObject({
        text: "H",
        ...letter,
        fontSize: id === "zoom" || id === "serifZoom" ? 48 : 32,
        fontAscent: baseline - letter.y,
      });
      expect(suppressed.rasterGlyphs, diagnostic).toMatchObject([{ suppressGlyph: true }]);
      expect(body, diagnostic).toMatchObject(bodyBox);
      expect(body!.fontAscent, diagnostic).toBeUndefined();
      expect(body!.y + row.fontAscent!, diagnostic).toBe(baseline);
    }
    expect(paragraphs.map((row) => row.textSegments?.[0].fontFamilyStack?.genericFamily)).toEqual([
      "standard",
      "none",
      "serif",
      "standard",
      "serif",
    ]);
    if (process.platform === "darwin") {
      expect(faces).toEqual([
        { "HiraKakuProN-W3": 2 },
        { "HiraKakuProN-W3": 1, "Times-Roman": 1 },
        { "HiraKakuProN-W3": 1, "HiraMinProN-W3": 1 },
        { "HiraKakuProN-W3": 2 },
        { "HiraKakuProN-W3": 1, "HiraMinProN-W3": 1 },
      ]);
      expect(native.map(({ baseline, letter }) => baseline - letter.y)).toEqual([28, 29, 28, 42, 42]);
      const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, viewport.width, viewport.height));
      await generated.setContent(`<body style="margin:0;background:white">${svg}`);
      await generated.evaluate(() => document.fonts.ready.then(() => undefined));
      expect((await letterInk(generated)).equals(nativeInk)).toBe(true);
    }
  } finally {
    await generated.close();
    await page.close();
  }
}, 30_000);
