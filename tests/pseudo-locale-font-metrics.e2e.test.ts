import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const rows = [
  { id: "standard", pseudo: "before" },
  { id: "literal", pseudo: "before" },
  { id: "generic", pseudo: "after" },
  { id: "zoom", pseudo: "before" },
] as const;
const authorFont = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
).toString("base64");
const viewport = { x: 0, y: 0, width: 250, height: 270 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (tree: CapturedElement[]): CapturedElement[] => tree.flatMap((el) => [el, ...flat(el.children)]);

async function fixture(page: Page, opaque: boolean) {
  const literal = await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily);
  const rule = `#literal::before { font-family: ${literal} }`;
  const sheet = "https://fixture-styles.invalid/pseudo-font.css";
  if (opaque) {
    await page.route(sheet, (route) => route.fulfill({ contentType: "text/css", body: rule }));
  }
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>
      @font-face { font-family:"-webkit-body"; src:url(data:font/ttf;base64,${authorFont}) }
      @font-face { font-family:"-webkit-standard"; src:url(data:font/ttf;base64,${authorFont}) }
      body { margin:0; background:white }
      main { padding:8px 0 0 12px }
      .host { font-size:32px; line-height:52px }
      .baseline { display:inline-block; width:0; height:0; vertical-align:baseline }
      #standard::before, #literal::before, #generic::after, #zoom::before { content:"Hg" }
      #generic::after { font-family:serif }
      #zoom { zoom:1.5 }
      ${opaque ? "" : rule}
    </style>${opaque ? `<link rel="stylesheet" href="${sheet}">` : ""}
    <main>${rows.map(({ id }) => `<div id="${id}" lang="ja" class="host"><span class="baseline"></span></div>`).join("")}</main>`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function nativeRows(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    return await Promise.all(
      rows.map(async ({ id, pseudo }) => {
        const selector = `#${id}`;
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: 1 });
        const source = node.pseudoElements?.find((entry) => entry.pseudoType === pseudo);
        expect(source, selector).toBeDefined();
        const [{ fonts }, { model }, baseline] = await Promise.all([
          cdp.send("CSS.getPlatformFontsForNode", { nodeId: source!.nodeId }),
          cdp.send("DOM.getBoxModel", { nodeId: source!.nodeId }),
          page.locator(`${selector} .baseline`).evaluate((mark) => mark.getBoundingClientRect().top),
        ]);
        return {
          fonts: fonts.map((font) => font.postScriptName),
          advance: model.content[2] - model.content[0],
          ascent: baseline - model.content[1],
          descent: model.content[5] - baseline,
          baseline,
        };
      }),
    );
  } finally {
    await cdp.detach();
  }
}

async function pixels(page: Page) {
  return sharp(await screenshotAfterPresentedFrame(page))
    .ensureAlpha()
    .raw()
    .toBuffer();
}

it("uses the native generated fragment's locale-selected ascent and advance", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const generated = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await fixture(page, true);
    const loaded = await page.evaluate(async () => {
      const names = ["-webkit-body", "-webkit-standard"];
      const faces = await Promise.all(names.map((family) => document.fonts.load(`32px "${family}"`, "Hg")));
      return faces.map((rows) => rows.map((face) => face.status));
    });
    expect(loaded).toEqual([["loaded"], ["loaded"]]);
    expect(
      await page.evaluate(() => {
        try {
          void document.styleSheets[1].cssRules;
          return false;
        } catch (error) {
          return error instanceof DOMException && error.name === "SecurityError";
        }
      }),
    ).toBe(true);
    const sourcePixels = await pixels(page);
    expect(sourcePixels.some((channel) => channel !== 255)).toBe(true);
    const native = await nativeRows(page);
    const tree = await captureElementTree(page, "body", viewport);
    const fragments = flat(tree).flatMap((el) => el.pseudoFragments ?? []);
    expect(fragments).toHaveLength(rows.length);
    for (const [index, record] of fragments.entries()) {
      const expected = native[index];
      const message = JSON.stringify({ source: rows[index], expected });
      expect(record.status, message).toBe("exact");
      expect(
        record.typography.resolvedFonts.map((font) => font.postScriptName),
        message,
      ).toEqual(expected.fonts);
      const text = record.fragments.find((fragment) => fragment.kind === "text");
      expect(text, message).toMatchObject({
        text: "Hg",
        protocolInlineAdvance: expected.advance,
        baseline: { ascent: expected.ascent, origin: { y: expected.baseline } },
      });
      expect(Math.abs(text!.shapedInlineAdvance - expected.advance), message).toBeLessThanOrEqual(1 / 64);
      expect(record.typography.primaryFontDescent, message).toBe(expected.descent);
    }
    expect(fragments.map((record) => record.typography.fontFamilyStack?.genericFamily)).toEqual([
      "standard",
      "none",
      "serif",
      "standard",
    ]);
    if (process.platform === "darwin") {
      expect(native.map((record) => record.fonts)).toEqual([
        ["HiraKakuProN-W3"],
        ["Times-Roman"],
        ["HiraMinProN-W3"],
        ["HiraKakuProN-W3"],
      ]);
      expect(native.map((record) => record.advance)).toEqual([45.421875, 39.109375, 42.5625, 68.125]);
      const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, viewport.width, viewport.height));
      await generated.setContent(`<body style="margin:0;background:white">${svg}`);
      await generated.evaluate(() => document.fonts.ready.then(() => undefined));
      expect((await pixels(generated)).equals(sourcePixels)).toBe(true);
    }
  } finally {
    await generated.close();
    await page.close();
  }
}, 30_000);

it("keeps native standard and literal metrics distinct in the compatibility walker", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await fixture(page, false);
    const native = await nativeRows(page);
    const { tree } = (await page.evaluate(
      `(${CAPTURE_SCRIPT})(${JSON.stringify({ selector: "body", viewport })})`,
    )) as { tree: CapturedElement[] };
    const captured = flat(tree)
      .flatMap((el) => el.textSegments ?? [])
      .filter((segment) => segment.text === "Hg");
    for (const index of [0, 1, 2]) {
      expect(captured[index], rows[index].id).toMatchObject({
        width: native[index].advance,
        fontAscent: native[index].ascent,
      });
    }
  } finally {
    await page.close();
  }
}, 30_000);

it("retains the prior literal metric when raw compatibility cannot inspect the author rule", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await fixture(page, true);
    const [, literal] = await nativeRows(page);
    const { tree } = (await page.evaluate(
      `(${CAPTURE_SCRIPT})(${JSON.stringify({ selector: "body", viewport })})`,
    )) as { tree: CapturedElement[] };
    const captured = flat(tree)
      .flatMap((el) => el.textSegments ?? [])
      .filter((segment) => segment.text === "Hg");
    expect(captured[1]).toMatchObject({ width: literal.advance, fontAscent: literal.ascent });
  } finally {
    await page.close();
  }
}, 30_000);

it("retains Chromium paint when the locale probe cannot reproduce the source font box", async () => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body { margin:0; background:white }
      div { font-size:30px; line-height:60px }
      div::before { content:"Hg"; font-size-adjust:0.9 }
    </style><div lang="ja"></div>`);
    const source = await pixels(page);
    const tree = await captureElementTree(page, "body", viewport);
    const fragments = flat(tree).flatMap((el) => el.pseudoFragments ?? []);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      status: "terminal-raster",
      reason: "locale-selected pseudo typography did not reproduce the source font box",
    });
    expect(fragments[0].terminalRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
    const svg = elementTreeToSvg(tree, viewport.width, viewport.height);
    await page.setContent(`<body style="margin:0;background:white">${svg}`);
    expect((await pixels(page)).equals(source)).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);
