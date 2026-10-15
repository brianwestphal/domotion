import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// CoreText keeps process-wide fallback state. In one Chrome renderer, after a
// system-ui run has laid out U+2200, a system-ui italic run resolves U+1D00
// and U+2300 to the italic UI font's `.notdef`; a fresh renderer paints
// `.LucidaGrandeUI` / `Menlo-Italic`. The persistent glyph helper is a
// long-lived CoreText process with the same carry-over. One Node process that
// renders two captures, each from a fresh Chrome renderer, must therefore not
// answer the second from the first one's CoreText history.
const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

const W = 300;
const H = 120;
const CAPTURE_A = `<div class="t" style="font:16px system-ui">&#x2200;&#x1D00;</div>`;
const CAPTURE_B =
  `<div class="t" style="font:italic 16px system-ui">&#x1D00;</div>` +
  `<div class="t" style="font:italic 16px system-ui">&#x2300;</div>`;

let browser: Browser | null = null;
afterAll(async () => {
  await closeBrowserSafely(browser);
}, 15_000);

/** Capture in a fresh BrowserContext (a fresh renderer) and report Chrome's faces per div. */
async function capture(body: string): Promise<{ tree: CapturedElement[]; chromeFaces: string[] }> {
  browser ??= await launchChromium();
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  try {
    const page = await ctx.newPage();
    await page.setContent(`<html lang="en"><body style="margin:0">${body}</body></html>`);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".t" });
    const chromeFaces: string[] = [];
    for (const nodeId of nodeIds) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      chromeFaces.push(fonts.map((font) => font.postScriptName).join(","));
    }
    return { tree, chromeFaces };
  } finally {
    await ctx.close();
  }
}

function render(tree: CapturedElement[]): string {
  clearEmbeddedFonts();
  clearGlyphDefs();
  return elementTreeToSvg(structuredClone(tree), W, H);
}

const textFamilies = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*font-family="([^"]+)"/g)].map((match) => match[1]);

describeMac("CoreText fallback history across captures", () => {
  it("renders a capture the same whether or not an earlier capture's text was rendered first", async () => {
    const a = await capture(CAPTURE_A);
    const b = await capture(CAPTURE_B);
    // Chrome's fresh renderer paints the two italic runs in two different faces.
    expect(b.chromeFaces).toEqual([".LucidaGrandeUI", "Menlo-Italic"]);

    const alone = render(b.tree);
    expect(new Set(textFamilies(alone)).size).toBe(2);

    render(a.tree);
    expect(render(b.tree)).toBe(alone);
  }, 120_000);
});
