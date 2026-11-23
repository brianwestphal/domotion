import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";
import { buildPhaseCases } from "../tools/border-phase-oracle.js";

const sourceCases = buildPhaseCases();
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

it.each([
  { kind: "outline", dsf: 4, zoom: 0.8, phase: 0.75, interval: "8.06142807006836" },
  ...[0, 0.25, 0.5, 0.75].map((phase) => ({ kind: "outline", dsf: 1, zoom: 1, phase, interval: "10.204285621643066" })),
  { kind: "border", dsf: 4, zoom: 0.8, phase: 0.75, interval: "7.759230613708496" },
  { kind: "border", dsf: 1, zoom: 1, phase: 0.75, interval: "9.759230613708496" },
])(
  "matches native wide dotted $kind ink at DSF $dsf, zoom $zoom and phase $phase",
  async ({ kind, dsf, zoom, phase, interval }) => {
    const sample = sourceCases.find(
      (row) => row.kind === kind && row.style === "dotted" && row.width === 5 && row.phase === phase,
    )!;
    // Keep the original phase oracle's screen origin, viewport and SVG image
    // embedding. Capture only this fixture and crop its actual paint rectangle.
    const width = Math.ceil(760 * zoom);
    const height = Math.ceil((18 + Math.ceil(sourceCases.length / 4) * 56 + 20) * zoom);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf });
    try {
      const source = await context.newPage();
      const output = await context.newPage();
      const css = "html,body{margin:0;background:transparent}";
      const paint = kind === "outline" ? "outline:5px dotted #000;outline-offset:3px" : "border:5px dotted #000";
      await source.setContent(`<!doctype html><style>${css}body{zoom:${zoom}}</style>
        <div style="position:absolute;box-sizing:border-box;${paint};left:${sample.x}px;top:${sample.y}px;
          width:${sample.boxWidth}px;height:${sample.boxHeight}px"></div>`);
      const clip = {
        x: Math.floor(sample.x * zoom) - 12,
        y: Math.floor(sample.y * zoom) - 12,
        width: Math.ceil(sample.boxWidth * zoom) + 25,
        height: Math.ceil(sample.boxHeight * zoom) + 25,
      };
      const bytes = async (page: typeof source) =>
        sharp(await screenshotAfterPresentedFrame(page, { omitBackground: true, clip }))
          .ensureAlpha()
          .raw()
          .toBuffer();
      const native = await bytes(source);
      expect(native.some((channel, index) => index % 4 === 3 && channel === 255)).toBe(true);

      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width, height });
      const inner = elementTreeToSvgInner(tree, width, height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${inner}</svg>`;
      await output.setContent(`<style>${css}img{display:block;width:${width}px;height:${height}px}</style><img>`);
      await output.locator("img").evaluate(
        async (image: HTMLImageElement, url) => {
          image.src = url;
          await image.decode();
        },
        "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
      );

      expect((await bytes(output)).equals(native)).toBe(true);
      expect(inner).toContain('stroke-dasharray="0 ' + interval + '" stroke-linecap="round"');
    } finally {
      await context.close();
    }
  },
);
