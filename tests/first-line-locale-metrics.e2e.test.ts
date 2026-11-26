import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const cases = ["standard", "literal", "serif", "reset", "zoom", "literal-only", "plain"] as const;
const viewport = { x: 0, y: 0, width: 250, height: 690 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((node) => [node, ...flat(node.children)]);

async function sourceFontFaces(page: Page) {
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

async function nativeLines(page: Page) {
  return page.locator("p").evaluateAll((paragraphs) =>
    paragraphs.map((paragraph) => {
      const range = document.createRange();
      const text = Array.from(paragraph.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
      const baselineMarkers = paragraph.querySelectorAll(".baseline");
      return text.map((node, index) => {
        range.selectNodeContents(node);
        const bounds = range.getBoundingClientRect();
        const baseline = baselineMarkers[index].getBoundingClientRect().top;
        return {
          y: bounds.top,
          width: bounds.width,
          height: bounds.height,
          ascent: baseline - bounds.top,
          descent: bounds.bottom - baseline,
          baseline,
        };
      });
    }),
  );
}

async function pixels(page: Page) {
  return sharp(await screenshotAfterPresentedFrame(page))
    .ensureAlpha()
    .raw()
    .toBuffer();
}

it("binds direct first-line metrics and effective family to Chromium's first visual line", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const generated = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    const initialFamily = await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily);
    const stylesheet = "https://fixture-styles.invalid/first-line.css";
    await page.route(stylesheet, (route) =>
      route.fulfill({
        contentType: "text/css",
        body: `#literal::first-line, #literal-only::first-line { font-family:${initialFamily} }`,
      }),
    );
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <link rel="stylesheet" href="${stylesheet}">
      <style>
        body { margin:0; padding:0 0 0 12px; background:white }
        p { margin:0; font-size:16px; line-height:44px }
        .tall::first-line { font-size:32px }
        #serif::first-line { font-family:serif }
        #reset { font-family:${initialFamily} }
        #reset::first-line { font-family:initial }
        #zoom { zoom:1.5 }
        .baseline { display:inline-block; width:0; height:0; vertical-align:baseline }
      </style>${cases.map((id) => `<p id="${id}" lang="ja" class="${id === "plain" || id === "literal-only" ? "" : "tall"}">Hg<span class="baseline"></span><br>Hg<span class="baseline"></span></p>`).join("")}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(
      await page.evaluate(() => {
        try {
          void document.styleSheets[0].cssRules;
          return false;
        } catch (error) {
          return error instanceof DOMException && error.name === "SecurityError";
        }
      }),
    ).toBe(true);

    const original = await pixels(page);
    const source = await nativeLines(page);
    const faces = await sourceFontFaces(page);
    const tree = await captureElementTree(page, "body", viewport);
    const paragraphs = flat(tree).filter((node) => node.tag === "p");
    expect(paragraphs).toHaveLength(cases.length);
    for (const [i, id] of cases.entries()) {
      const paragraph = paragraphs[i];
      const [first, second] = paragraph.textSegments!;
      const [nativeFirst, nativeSecond] = source[i];
      const witness = JSON.stringify({ id, faces: faces[i], nativeFirst, nativeSecond });
      expect([first.y, first.width, first.height], witness).toEqual([
        nativeFirst.y,
        nativeFirst.width,
        nativeFirst.height,
      ]);
      expect(first.y + (first.fontAscent ?? paragraph.fontAscent!), witness).toBe(nativeFirst.baseline);
      expect(second.y + (second.fontAscent ?? paragraph.fontAscent!), witness).toBe(nativeSecond.baseline);
      if (id !== "plain") {
        expect(first.fontAscent, witness).toBe(nativeFirst.ascent);
        expect(first.height - first.fontAscent!, witness).toBe(nativeFirst.descent);
      } else {
        expect(first.fontAscent, witness).toBeUndefined();
      }
      expect(second.fontFamilyStack, witness).toBeUndefined();
      expect(second.fontAscent, witness).toBeUndefined();
    }
    expect(paragraphs.map((node) => node.textSegments?.[0].fontFamilyStack?.genericFamily)).toEqual([
      undefined,
      "none",
      "serif",
      "standard",
      undefined,
      "none",
      undefined,
    ]);

    if (process.platform === "darwin") {
      expect(faces).toEqual([
        { "HiraKakuProN-W3": 4 },
        { "HiraKakuProN-W3": 2, "Times-Roman": 2 },
        { "HiraKakuProN-W3": 2, "HiraMinProN-W3": 2 },
        { "HiraKakuProN-W3": 2, "Times-Roman": 2 },
        { "HiraKakuProN-W3": 4 },
        { "HiraKakuProN-W3": 2, "Times-Roman": 2 },
        { "HiraKakuProN-W3": 4 },
      ]);
      expect(source.map(([first]) => first.ascent)).toEqual([28, 29, 28, 28, 42, 14, 14]);
      const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, viewport.width, viewport.height));
      await generated.setContent(`<body style="margin:0;background:white">${svg}`);
      await generated.evaluate(() => document.fonts.ready.then(() => undefined));
      const rendered = await pixels(generated);
      for (const [index, id] of cases.entries()) {
        if (id === "plain" || id === "literal-only") continue;
        const [first] = source[index];
        const start = Math.floor(first.y) * viewport.width * 4;
        const end = Math.ceil(first.y + first.height) * viewport.width * 4;
        expect(rendered.subarray(start, end).equals(original.subarray(start, end)), id).toBe(true);
      }
    }
  } finally {
    await generated.close();
    await page.close();
  }
}, 30_000);

it("qualifies a soft-wrapped source line and leaves a later direct row outside the metric proof", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:0 }
      p,article { margin:0; font-size:16px; line-height:44px }
      p { width:49px }
      p::first-line, article::first-line { font-size:32px }
    </style><p lang="ja">Hg Hg</p><article lang="ja"><div>Hg</div>Hg</article>`);
    const [wrapped, later] = await page.locator("p,article").evaluateAll((owners) =>
      owners.map((owner) => {
        const range = document.createRange();
        range.selectNodeContents(owner.lastChild!);
        return Array.from(range.getClientRects(), ({ top, height }) => ({ top, height }));
      }),
    );
    expect(wrapped).toHaveLength(2);
    expect(later).toHaveLength(1);
    const tree = flat(await captureElementTree(page, "body", viewport));
    const paragraph = tree.find((node) => node.tag === "p")!;
    const article = tree.find((node) => node.tag === "article")!;
    const [first, second] = paragraph.textSegments!;
    expect(first).toMatchObject({ y: wrapped[0].top, height: wrapped[0].height, fontSize: 32 });
    expect(first.fontAscent).toBeGreaterThan(paragraph.fontAscent!);
    expect(second).toMatchObject({ y: wrapped[1].top, height: wrapped[1].height });
    expect(second.fontAscent).toBeUndefined();
    expect(article.textSegments?.[0]).toMatchObject({ y: later[0].top, height: later[0].height });
    expect(article.textSegments?.[0].fontAscent).toBeUndefined();
  } finally {
    await page.close();
  }
}, 30_000);
