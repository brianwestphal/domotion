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

  // DM-CAGCSM: an rtl run's captured origin x is its visual-LEFT edge, so the
  // emitted `<text>` must pair `direction="rtl"` with `text-anchor="end"` — the
  // default start-anchor would place the run's RIGHT edge at its left edge and
  // shift the whole run left by its width (overlapping its neighbour). This pins
  // the anchor and checks the run renders on the right side of an rtl paragraph.
  it("anchors an rtl run with text-anchor=end so it does not shift left off its origin", async () => {
    await sourcePage.setContent(`<!doctype html><style>
      html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#fff;color:#111}
      p{font:24px/1.4 Arial,sans-serif;padding:20px}
    </style><p dir="rtl">שלום עולם ABC</p>`);
    const tree = await captureElementTree(sourcePage, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const svg = render(tree, "system-font");

    // Every emitted rtl <text> pairs direction=rtl with text-anchor=end.
    const rtlTexts = [...svg.matchAll(/<text\b([^>]*)>/g)].map((m) => m[1]).filter((a) => /direction="rtl"/.test(a));
    expect(rtlTexts.length).toBeGreaterThan(0);
    for (const attrs of rtlTexts) expect(attrs).toMatch(/text-anchor="end"/);

    // Rendered, the rtl run sits on the RIGHT of the paragraph (its rightmost
    // glyph is well past centre), not collapsed onto the left edge.
    await outputPage.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`);
    const rightEdge = await outputPage.evaluate((w) => {
      let maxRight = 0;
      for (const t of document.querySelectorAll("svg text")) {
        maxRight = Math.max(maxRight, t.getBoundingClientRect().right);
      }
      return { maxRight, w };
    }, WIDTH);
    expect(rightEdge.maxRight).toBeGreaterThan(WIDTH / 2);
  });

  // DM-ZDDJAG: a vertical writing-mode run is emitted as ONE authored <text>
  // with writing-mode + text-orientation (not per-char), so the browser lays out
  // the column and rotates sideways glyphs itself — a real, selectable vertical run.
  it("emits a vertical run as one <text> with writing-mode/text-orientation", async () => {
    await sourcePage.setContent(`<!doctype html><meta charset="utf8"><style>
      html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#fff;color:#111}
      .v{writing-mode:vertical-rl;text-orientation:sideways;font:24px/1.4 sans-serif;height:${HEIGHT - 20}px;padding:10px}
    </style><div class="v">Sideways</div>`);
    const tree = await captureElementTree(sourcePage, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const svg = render(tree, "system-font");

    // One <text> for the run, carrying the vertical writing-mode + orientation.
    const texts = svg.match(/<text\b/g) ?? [];
    expect(texts.length).toBe(1);
    expect(svg).toMatch(/writing-mode:\s*vertical-rl/);
    expect(svg).toMatch(/text-orientation:\s*sideways/);
    expect(svg).toContain("Sideways");

    // Rendered, the run is a VERTICAL column: taller than it is wide, and
    // selectable as one string.
    await outputPage.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`);
    const info = await outputPage.evaluate(() => {
      const t = document.querySelector("svg text")!;
      const r = t.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(t);
      return { w: r.width, h: r.height, selected: range.toString().trim() };
    });
    expect(info.h).toBeGreaterThan(info.w); // a vertical column
    expect(info.selected).toBe("Sideways"); // one selectable run
  });
});
