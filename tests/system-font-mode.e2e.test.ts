import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

import { captureElementTree, elementTreeToSvg } from "../src/index.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";

// DM-2716: end-to-end gate for `system-font` render mode. Unlike the pixel-
// faithful modes, this emits authored `<text>` painted by the browser's own
// fonts, so the browser-side check is that the text is real, selectable text
// carrying the authored family — not a pixel diff (which this mode does not
// promise).
const WIDTH = 640;
const HEIGHT = 200;
let browser: Browser;
let sourcePage: Page;
let outputPage: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  sourcePage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  outputPage = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
});

afterAll(async () => {
  await browser.close();
});

function render(tree: Awaited<ReturnType<typeof captureElementTree>>, mode: "embedded-font" | "system-font"): string {
  clearGlyphDefs();
  clearEmbeddedFonts();
  return elementTreeToSvg(tree, WIDTH, HEIGHT, { renderTextMode: mode });
}

describe("system-font render mode (DM-2716)", () => {
  it("emits authored, selectable <text> with the source family and no embedding", async () => {
    await sourcePage.setContent(`<!doctype html><style>
      html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#fff;color:#0d1117}
      main{padding:24px;font:600 26px/1.4 'Helvetica Neue',Arial,sans-serif}
    </style><main>Renderable system font text</main>`);
    const tree = await captureElementTree(sourcePage, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });

    const systemFont = render(tree, "system-font");
    const embedded = render(tree, "embedded-font");

    // No embedded subset, no glyph outlines — the consumer's fonts paint it.
    expect(systemFont).toContain("<text ");
    expect(systemFont).toMatch(/font-family="[^"]*Helvetica Neue/);
    expect(systemFont).not.toContain("@font-face");
    expect(systemFont).not.toContain("<path");
    // The mode exists to shrink output where the fonts are known present.
    expect(systemFont.length).toBeLessThan(embedded.length);

    // The <text> is genuine selectable text the browser lays out itself.
    await outputPage.setContent(`<!doctype html><body style="margin:0">${systemFont}</body>`);
    const info = await outputPage.evaluate(() => {
      const t = document.querySelector("svg text");
      if (t == null) return null;
      const family = getComputedStyle(t).fontFamily;
      const range = document.createRange();
      range.selectNodeContents(t);
      return { text: (t.textContent ?? "").trim(), family, selectable: range.toString().length > 0 };
    });
    expect(info).not.toBeNull();
    expect(info!.text.length).toBeGreaterThan(0);
    expect(info!.family).toContain("Helvetica Neue");
    expect(info!.selectable).toBe(true);
  });
});
