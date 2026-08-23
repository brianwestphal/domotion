import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => { try { return { browser: await launchChromium() }; } catch { return null; } })();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;
const COLORS = new Set(["225,29,72", "37,99,235", "255,255,255"]);

function exactLogicalInteriors(a: Buffer, b: Buffer, width: number) {
  let checked = 0, mismatches = 0;
  for (let pixel = width + 1; pixel < a.length / 4 - width - 1; pixel++) {
    const at = (buffer: Buffer, p: number) => `${buffer[p * 4]},${buffer[p * 4 + 1]},${buffer[p * 4 + 2]}`;
    const source = at(a, pixel), rendered = at(b, pixel);
    if (!COLORS.has(source) || !COLORS.has(rendered)) continue;
    if ([pixel - 1, pixel + 1, pixel - width, pixel + width].some((p) => at(a, p) !== source)) continue;
    checked++;
    if (source !== rendered) mismatches++;
  }
  return { checked, mismatches };
}

describeBrowser("legacy border gradient consumer repeat domains", () => {
  for (const dpr of [1, 2]) it(`matches Chromium logical interiors at DPR ${dpr}`, async () => {
    const context = await env!.browser.newContext({ viewport: { width: 260, height: 180 }, deviceScaleFactor: dpr });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent('<style>html,body{margin:0;background:white}#x{margin:20px;width:180px;height:100px;border:20px solid transparent;border-image:repeating-linear-gradient(90deg,#e11d48 0,#2563eb 240px) 20 fill}</style><div id="x"></div>');
      const sourcePng = await source.screenshot();
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 260, height: 180 });
      const svg = elementTreeToSvg(tree, 260, 180);
      expect(svg).toContain('spreadMethod="repeat"');
      expect(svg).toContain('x2="260"');
      await rendered.setContent(`<body style="margin:0">${svg}</body>`);
      const renderedPng = await rendered.screenshot();
      const [a, b] = await Promise.all([sharp(sourcePng).ensureAlpha().raw().toBuffer(), sharp(renderedPng).ensureAlpha().raw().toBuffer()]);
      const logical = exactLogicalInteriors(a, b, 260 * dpr);
      expect(logical.checked).toBeGreaterThan(5_000 * dpr * dpr);
      expect(logical.mismatches).toBe(0);
    } finally { await context.close(); }
  }, 30_000);
});
