// An `@font-face` webfont's embedded-font output must paint exactly what
// Chromium paints for the same DOM text. The embedded subset used to be an
// svg2ttf rebuild of captured outlines, which drops on-curve points near their
// off-curve neighbors' midpoint: DomotionFixtureMono "000" at 20px then differed
// from Chromium at 3 pixels (one per glyph, inside the zero's dot) by 2 levels.
// The subset is now hb-subset from the webfont's own bytes (doc 99).
import { readFileSync } from "node:fs";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, discoverAndRegisterWebfonts, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { clearWebfonts, withRenderTextMode } from "../src/render/font-resolution.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const mono = readFileSync(
  new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url),
);
const W = 80;
const H = 40;
const face = `@font-face{font-family:Face;src:url(data:font/ttf;base64,${mono.toString("base64")});font-display:block}`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterEach(() => clearWebfonts());
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function rgba(png: Buffer): Promise<Buffer> {
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** Differing pixels (any RGBA channel) and the largest channel delta. */
function compare(a: Buffer, b: Buffer): { pixels: number; maxDelta: number } {
  let pixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(a[i + c] - b[i + c]));
    if (delta > 0) pixels++;
    maxDelta = Math.max(maxDelta, delta);
  }
  return { pixels, maxDelta };
}

async function shot(page: Page, html: string): Promise<Buffer> {
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return page.screenshot();
}

async function nativeAndOutput(hinted: boolean): Promise<{ native: Buffer; output: Buffer; svg: string }> {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const previous = process.env.DOMOTION_HINTED_SUBSET;
  try {
    await page.setContent(
      `<style>${face}body{margin:0;background:white}</style><span style="font:20px Face;line-height:1;white-space:pre">000</span>`,
    );
    await page.evaluate(() => document.fonts.load("20px Face", "0"));
    const native = await page.screenshot();
    await discoverAndRegisterWebfonts(page);
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
    if (hinted) delete process.env.DOMOTION_HINTED_SUBSET;
    else process.env.DOMOTION_HINTED_SUBSET = "0";
    const svg = withRenderTextMode("embedded-font", () => elementTreeToSvg(tree, W, H));
    const output = await shot(page, `<body style="margin:0;background:white">${svg}`);
    return { native: await rgba(native), output: await rgba(output), svg };
  } finally {
    if (previous === undefined) delete process.env.DOMOTION_HINTED_SUBSET;
    else process.env.DOMOTION_HINTED_SUBSET = previous;
    await page.close();
  }
}

describe("embedded webfont subset keeps the webfont's own outlines", () => {
  it("paints DomotionFixtureMono '000' exactly as Chromium's DOM text (full RGBA)", async () => {
    const { native, output, svg } = await nativeAndOutput(true);
    expect(svg).toContain('x="0 12 24"');
    expect(compare(native, output)).toEqual({ pixels: 0, maxDelta: 0 });
  });

  it("negative control: the svg2ttf rebuild reproduces the residual this test guards", async () => {
    const { native, output } = await nativeAndOutput(false);
    expect(compare(native, output).pixels).toBeGreaterThan(0);
  });

  it("raster-path control: SVG <text> with the original bytes already equals Chromium's DOM paint", async () => {
    const { native } = await nativeAndOutput(true);
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const control = await shot(
        page,
        `<body style="margin:0;background:white"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><style>${face}</style><rect width="${W}" height="${H}" fill="white"/><text x="0 12 24" y="17" font-family="Face" font-size="20" fill="rgb(0,0,0)">000</text></svg>`,
      );
      expect(compare(native, await rgba(control))).toEqual({ pixels: 0, maxDelta: 0 });
    } finally {
      await page.close();
    }
  });
  it("keeps a shared glyph ID separate across two Unicode ranges of one family (DM-BM3YHZ)", async () => {
    const serif = readFileSync(
      new URL("../packages/text-engine/assets/fonts/fixture/DomotionFixtureSerif-Regular.ttf", import.meta.url),
    );
    const rows = [
      { id: "mono", text: "BBB", face: "JetBrainsMono-Regular", range: "U+0042", bytes: mono },
      { id: "serif", text: "ttt", face: "IBMPlexSerif-Regular", range: "U+0074", bytes: serif },
    ];
    const viewport = { width: 160, height: 96 };
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      const faces = rows
        .map(
          ({ range, bytes }) =>
            `@font-face{font-family:Collision;src:url(data:font/ttf;base64,${bytes.toString("base64")});font-weight:400;font-style:normal;unicode-range:${range}}`,
        )
        .join("");
      const native = await shot(
        page,
        `<!doctype html><meta charset="utf-8"><style>${faces}
          html,body{margin:0;background:white}
          span{position:absolute;left:8px;font:400 20px/28px Collision;font-synthesis:none}
          #mono{top:8px}#serif{top:56px}
        </style>${rows.map(({ id, text }) => `<span id="${id}">${text}</span>`).join("")}`,
      );
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        for (const row of rows) {
          const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${row.id}` });
          const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
          expect(fonts.map((font) => [font.postScriptName, font.glyphCount, font.isCustomFont])).toEqual([
            [row.face, 3, true],
          ]);
        }
      } finally {
        await cdp.detach();
      }

      await discoverAndRegisterWebfonts(page);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, ...viewport });
      resetTextRunProvenance();
      setTextRunProvenanceEnabled(true);
      const svg = elementTreeToSvg(tree, viewport.width, viewport.height, { renderTextMode: "embedded-font" });
      const runs = getTextRunProvenance().runs;
      for (const row of rows) {
        const run = runs.find((candidate) => candidate.emittedText === row.text);
        expect(run?.selected.postscriptName).toBe(row.face);
        // The original glyph IDs collide even though the source outlines differ.
        expect(run?.glyphs.map((glyph) => glyph.id)).toEqual([26, 26, 26]);
      }

      const output = await shot(page, `<!doctype html><body style="margin:0;background:white">${svg}`);
      const families = await Promise.all(
        rows.map(({ text }) => page.locator(`g[aria-label="${text}"] text`).getAttribute("font-family")),
      );
      expect(families.every((family) => /^dmf\d+$/.test(family ?? ""))).toBe(true);
      expect(new Set(families).size).toBe(2);
      expect(compare(await rgba(native), await rgba(output))).toEqual({ pixels: 0, maxDelta: 0 });
    } finally {
      setTextRunProvenanceEnabled(false);
      resetTextRunProvenance();
      await page.close();
    }
  });
});
