import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { captureElementTree, elementTreeToSvgInner, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { _advancedGradientTileCache } from "../src/render/advanced-gradient-raster.js";

async function setup() { try { return { browser: await launchChromium() }; } catch { return null; } }
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function walk(nodes: CapturedElement[]): CapturedElement[] { return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]); }
function png(uri: string): Buffer { return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"); }
function digest(uri: string): string { return createHash("sha256").update(png(uri)).digest("hex"); }
async function pixelSummary(uri: string) {
  const { data, info } = await sharp(png(uri)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0, chromatic = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) opaque++;
    if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 24) chromatic++;
  }
  return { width: info.width, height: info.height, opaque, chromatic };
}

describeBrowser("pixel content at Chromium-owned raster boundaries", () => {
  it("owns only HTML URL-filter graphs containing feConvolveMatrix", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 360, height: 240 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`
        <svg width="0" height="0" style="position:absolute">
          <filter id="emboss" x="-30%" y="-30%" width="160%" height="160%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse">
            <feConvolveMatrix order="3" kernelMatrix="-2 -1 0 -1 1 1 0 1 2" divisor="2" bias="0.08" targetX="0" targetY="2" edgeMode="wrap" preserveAlpha="true"/>
          </filter>
          <filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>
        </svg>
        <div id="conv" style="position:absolute;left:48px;top:42px;width:150px;height:70px;background:#d43;color:white;font:700 24px sans-serif;filter:url(#emboss);clip-path:inset(2px);transform:translate(7px,5px)">Emboss <span style="position:absolute;right:-14px">overflow</span></div>
        <div id="vector" style="position:absolute;left:48px;top:150px;width:100px;height:42px;background:#25c;filter:url(#blur)">vector</div>
      `);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 240 });
      const nodes = walk(tree);
      const convolved = nodes.find((node) => node.urlFilterRaster?.dataUri != null);
      expect(convolved?.urlFilterRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect((await pixelSummary(convolved!.urlFilterRaster!.dataUri!)).opaque).toBeGreaterThan(100);
      expect(nodes.filter((node) => node.urlFilterRaster != null)).toHaveLength(1);
      expect(nodes.find((node) => node.text.includes("vector"))?.urlFilterRaster).toBeUndefined();
      const svg = elementTreeToSvgInner(tree, 360, 240);
      expect(svg).toContain(`href="${convolved!.urlFilterRaster!.dataUri}"`);
      expect(svg).not.toContain("Emboss");
    } finally { await page.close(); }
  }, 60_000);

  it("captures replaced canvas pixels at the used size with live frame colors", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 180 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<canvas id="c" width="120" height="80" style="width:120px;height:80px"></canvas>`);
      await page.locator("#c").evaluate((canvas) => { const c = canvas as HTMLCanvasElement; const x = c.getContext("2d")!; x.fillStyle = "#e22"; x.fillRect(0, 0, 60, 80); x.fillStyle = "#25c"; x.fillRect(60, 0, 60, 80); });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 180 });
      const snapshot = walk(tree).find((node) => node.tag === "canvas")?.replacedSnapshot;
      expect(snapshot?.dataUri).toMatch(/^data:image\/png;base64,/);
      const summary = await pixelSummary(snapshot!.dataUri!);
      expect(summary).toMatchObject({ width: 120, height: 80 });
      expect(summary.opaque).toBe(120 * 80);
      expect(summary.chromatic).toBeGreaterThan(9_000);
      await page.locator("#c").evaluate((canvas) => { const c = canvas as HTMLCanvasElement; const x = c.getContext("2d")!; x.fillStyle = "#2c5"; x.fillRect(0, 0, 120, 80); });
      const nextTree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 180 });
      const next = walk(nextTree).find((node) => node.tag === "canvas")?.replacedSnapshot?.dataUri;
      expect(next).toMatch(/^data:image\/png;base64,/);
      expect(digest(next!)).not.toBe(digest(snapshot!.dataUri!));
    } finally { await page.close(); }
  }, 60_000);

  it("captures native-control chrome with authoritative geometry and nonempty alpha", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 220, height: 160 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<input id="native" type="checkbox" checked style="margin:20px;width:22px;height:22px;accent-color:#d21f5b">`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 220, height: 160 });
      const raster = walk(tree).find((node) => node.nativeControlRaster?.dataUri != null)?.nativeControlRaster;
      expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      const summary = await pixelSummary(raster!.dataUri!);
      expect(summary.width).toBe(Math.max(1, Math.ceil(raster!.width)));
      expect(summary.height).toBe(Math.max(1, Math.ceil(raster!.height)));
      expect(summary.opaque).toBeGreaterThan(0);
      expect(summary.chromatic).toBeGreaterThan(0);
    } finally { await page.close(); }
  }, 60_000);

  it("captures image-replacement sprite pixels without absorbing a vector sibling", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 240, height: 160 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<div id="sprite" aria-label="icon" style="position:absolute;left:20px;top:20px;width:48px;height:36px;text-indent:-9999px;overflow:hidden;white-space:nowrap;background:linear-gradient(90deg,#e22,#25c)">icon</div><div id="vector" style="position:absolute;left:90px;top:20px;width:40px;height:36px;background:#2c5"></div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 240, height: 160 });
      const nodes = walk(tree);
      const sprite = nodes.find((node) => node.replacedSnapshot?.dataUri != null)?.replacedSnapshot;
      expect(sprite?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(await pixelSummary(sprite!.dataUri!)).toMatchObject({ width: 48, height: 36, opaque: 48 * 36 });
      expect(nodes.some((node) => node.x === 90 && node.replacedSnapshot == null && node.styles.backgroundColor === "rgb(34, 204, 85)" )).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("captures unreadable iframe pixels while preserving its used box", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 180 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<iframe id="frame" src="data:text/html,<style>html,body{margin:0;width:100%;height:100%;background:linear-gradient(90deg,%23e22,%2325c)}</style>" style="border:0;width:100px;height:60px"></iframe>`);
      await page.waitForTimeout(100);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 180 });
      const frame = walk(tree).find((node) => node.tag === "iframe")?.replacedSnapshot;
      expect(frame?.dataUri).toMatch(/^data:image\/png;base64,/);
      const summary = await pixelSummary(frame!.dataUri!);
      expect(summary).toMatchObject({ width: 100, height: 60, opaque: 6_000 });
      expect(summary.chromatic).toBeGreaterThan(5_000);
    } finally { await page.close(); }
  }, 60_000);

  it("captures projective subtree pixels instead of flattening them to an affine SVG", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 300, height: 220 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<div style="margin:30px;width:150px;height:110px;perspective:260px"><div style="width:120px;height:90px;background:linear-gradient(90deg,#e22 0 50%,#25c 50%);transform:rotateY(34deg)"></div></div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 300, height: 220 });
      const raster = walk(tree).find((node) => node.transformSubtreeRaster?.dataUri != null)?.transformSubtreeRaster;
      expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
      const summary = await pixelSummary(raster!.dataUri!);
      expect(summary.width).toBeGreaterThan(50);
      expect(summary.height).toBeGreaterThan(50);
      expect(summary.chromatic).toBeGreaterThan(1_000);
    } finally { await page.close(); }
  }, 60_000);

  it("captures color-glyph pixels while an adjacent text glyph remains vector-owned", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 260, height: 150 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<div style="font:48px sans-serif">A😀B</div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 150 });
      const segments = walk(tree).flatMap((node) => node.textSegments ?? []);
      const glyph = segments.flatMap((segment) => segment.rasterGlyphs ?? []).find((entry) => entry.dataUri != null);
      expect(glyph?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect((await pixelSummary(glyph!.dataUri!)).opaque).toBeGreaterThan(100);
      expect(segments.flatMap((segment) => segment.rasterGlyphs ?? []).filter((entry) => entry.dataUri != null)).toHaveLength(1);
      expect(segments.map((segment) => segment.text).join("")).toContain("A😀B");
    } finally { await page.close(); }
  }, 60_000);

  it("replaces stale advanced-gradient cache content with Chromium pixels at the physical tile size", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 260, height: 160 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    try {
      await page.setContent(`<div id="g" style="width:120px;height:90px;background:linear-gradient(90deg in oklab,#e22,#25c);background-size:40px 30px"></div>`);
      const layer = await page.locator("#g").evaluate((element) => getComputedStyle(element).backgroundImage);
      _advancedGradientTileCache.set(layer, new Map([["40x30", "data:image/png;base64,c3RhbGU="]]));
      await captureElementTree(page, "body", { x: 0, y: 0, width: 260, height: 160 });
      const current = _advancedGradientTileCache.get(layer)?.get("40x30");
      expect(current).toMatch(/^data:image\/png;base64,/);
      expect(current).not.toBe("data:image/png;base64,c3RhbGU=");
      const summary = await pixelSummary(current!);
      expect(summary).toMatchObject({ width: 40, height: 30, opaque: 1_200 });
      expect(summary.chromatic).toBeGreaterThan(1_000);
    } finally { _advancedGradientTileCache.clear(); await context.close(); }
  }, 60_000);
});
