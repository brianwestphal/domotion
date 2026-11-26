import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const width = 280;
const rowHeight = 44;
const markerColumnWidth = 60;
const cases = ["inherited", "literal", "generic", "reset"] as const;
const height = rowHeight * cases.length;
const viewport = { x: 0, y: 0, width, height };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

const flat = (tree: CapturedElement[]): CapturedElement[] =>
  tree.flatMap((element) => [element, ...flat(element.children)]);

async function paintedMarkerFaces(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    return await Promise.all(
      cases.map(async (id) => {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
        const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: 1 });
        const marker = node.pseudoElements?.find((pseudo) => pseudo.pseudoType === "marker");
        expect(marker, id).toBeDefined();
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: marker!.nodeId });
        expect(
          fonts.some((font) => font.glyphCount > 0),
          id,
        ).toBe(true);
        return fonts.map((font) => font.postScriptName);
      }),
    );
  } finally {
    await cdp.detach();
  }
}

async function nativeAscents(page: Page) {
  return page.locator("li").evaluateAll((items) =>
    items.map((item) => {
      // Read an ordinary inline glyph box and a baseline-aligned marker with
      // the same intended font description as each source ::marker.
      const probe = document.createElement("p");
      probe.lang = "ja";
      probe.style.cssText = "position:absolute;visibility:hidden;font-size:32px;line-height:44px";
      const family =
        item.id === "inherited" || item.id === "reset" ? "initial" : getComputedStyle(item, "::marker").fontFamily;
      probe.style.fontFamily = family;
      const text = document.createElement("span");
      text.textContent = "Hg";
      const mark = document.createElement("span");
      mark.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      probe.append(text, mark);
      document.body.append(probe);
      const ascent = mark.getBoundingClientRect().top - text.getBoundingClientRect().top;
      probe.remove();
      return ascent;
    }),
  );
}

async function croppedPixels(page: Page, row: number) {
  return sharp(await screenshotAfterPresentedFrame(page))
    .extract({ left: 0, top: row * rowHeight, width: markerColumnWidth, height: rowHeight })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

it("uses the native marker's locale-selected ascent while preserving an opaque literal face", async () => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const generated = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const literal = await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily);
    const opaqueSheet = "https://fixture-styles.invalid/marker.css";
    await page.route(opaqueSheet, (route) =>
      route.fulfill({ contentType: "text/css", body: `#literal::marker { font-family:${literal} }` }),
    );
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <style>
        body { margin:0; background:white }
        ul { margin:0; padding:0 0 0 ${markerColumnWidth}px }
        li { font-size:32px; line-height:${rowHeight}px; list-style-type:square; color:transparent }
        li::marker { color:#d00000 }
        #generic::marker { font-family:serif }
        #reset { font-family:monospace }
        #reset::marker { font-family:initial }
      </style><link rel="stylesheet" href="${opaqueSheet}">
      <ul>${cases.map((id) => `<li id="${id}" lang="ja">Hg</li>`).join("")}</ul>`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
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

    const expectedPixels = await croppedPixels(page, 0);
    expect(expectedPixels.some((channel) => channel !== 255)).toBe(true);
    const faces = await paintedMarkerFaces(page);
    const expected = await nativeAscents(page);
    const tree = await captureElementTree(page, "body", viewport);
    const listItems = flat(tree).filter((element) => element.tag === "li");
    expect(
      listItems.map((item) => item.markerFontAscent),
      JSON.stringify(faces),
    ).toEqual(expected);
    if (process.platform === "darwin") {
      expect(faces).toEqual([["HiraKakuProN-W3"], ["Times-Roman"], ["HiraMinProN-W3"], ["HiraKakuProN-W3"]]);
      expect(expected).toEqual([28, 29, 28, 28]);
    }

    // The inherited marker and its first line have the same primary face.
    // Compare the marker column independently of any consumer text raster.
    const svg = elementTreeToSvg(tree, width, height);
    await generated.setContent(`<body style="margin:0;background:white">${svg}`);
    expect((await croppedPixels(generated, 0)).equals(expectedPixels), JSON.stringify(faces)).toBe(true);
  } finally {
    await generated.close();
    await page.close();
  }
}, 30_000);
