import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { generateAnimatedSvg, resolveTextTrack, resolveCaretPoint, resolveRangeRects } from "../src/animation/index.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Caret + selection track e2e (docs/101): capture a REAL page, resolve caret /
// range addresses against the captured tree, compose via generateAnimatedSvg,
// then RASTERIZE the actual animated SVG at chosen times (the
// verify-the-rendered-SVG rule) and assert the caret ink lands at the resolved
// x positions (±1.5px, subpixel AA) and the selection sweep rect grows.

const W = 600;
const H = 200;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#ffffff;font:24px Helvetica,Arial,sans-serif}
  #line{position:absolute;left:40px;top:50px;color:#111111}
  #field{position:absolute;left:40px;top:120px;width:220px;font:18px Helvetica,Arial,sans-serif;padding:4px 8px}
</style></head><body>
  <div id="line" data-domotion-anim="line">Hello world</div>
  <input id="field" data-domotion-anim="field" value="abc">
</body></html>`;

/** Scan a screenshot (PNG buffer) for pixels matching a color family and
 *  return their bounding box + count. Decoding happens in-page via canvas
 *  (the compare-pngs pattern — Node has no PNG decoder dependency). */
async function scanInk(
  page: Page,
  png: Buffer,
  mode: "red" | "magenta" | "selection",
): Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number }> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (args: { dataUri: string; mode: string }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = args.dataUri;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let hit = false;
        if (args.mode === "red") hit = r > 180 && g < 100 && b < 100;
        else if (args.mode === "magenta") hit = r > 180 && b > 180 && g < 100;
        // #3b82f6 at ~2/3 alpha over white ≈ rgb(134, 176, 250): strongly
        // blue-dominant, clearly bluer than the near-neutral text/borders.
        else hit = b > 200 && b - r > 60 && b - g > 30;
        if (hit) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    return { minX, maxX, minY, maxY, count };
  }, { dataUri, mode });
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("caret + selection track e2e (docs/101)", () => {
  it("parks, moves, sweeps a selection, and hides — verified by rasterizing the composed SVG", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      clearEmbeddedFonts();
      clearGlyphDefs();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const frameSvg = elementTreeToSvgInner(tree, W, H);

      // Resolve the geometry the assertions will check against — Chromium's
      // captured painted x, not a font-metrics model.
      const p0 = resolveCaretPoint(tree, { animId: "line" }, 0)!;
      const p6 = resolveCaretPoint(tree, { animId: "line" }, 6)!; // before 'w'
      const pField = resolveCaretPoint(tree, { animId: "field" }, 3)!; // after 'abc'
      const range = resolveRangeRects(tree, { animId: "line" }, 0, 5)!; // "Hello"
      expect(p0).not.toBeNull();
      expect(p6.x).toBeGreaterThan(p0.x);
      const helloRect = range.rects[0];

      // Track 1 (red caret on the heading): park → move → hide.
      const lineTrack = resolveTextTrack(tree, {
        target: { animId: "line" },
        color: "#ff0000",
        events: [
          { type: "park", t: 200, charOffset: 0 },
          { type: "move", t: 1200, charOffset: 6 },
          { type: "select", t: 2200, charStart: 0, charEnd: 5, sweepMs: 600 },
          { type: "hide", t: 3500 },
        ],
      });
      // Track 2 (magenta caret parked in the FORM FIELD — the non-editing use).
      const fieldTrack = resolveTextTrack(tree, {
        target: { animId: "field" },
        color: "#ff00ff",
        events: [{ type: "park", t: 200, charOffset: 3 }],
      });

      const svg = generateAnimatedSvg({
        width: W, height: H,
        background: "#ffffff",
        frames: [{ svgContent: frameSvg, duration: 4000 }],
        textTracks: [lineTrack, fieldTrack],
      });
      expect(svg).toContain('class="text-track"');

      // Rasterize the ACTUAL SVG: inline it, pause + seek all animations, shoot.
      const viewer = await ctx.newPage();
      await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
      await viewer.evaluate(() => document.fonts.ready);
      const shot = async (tMs: number): Promise<Buffer> => {
        await seekTo(viewer, tMs);
        return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };

      // t=400 (blink-on phase): red caret parked at offset 0 — ink at p0.x ±1.5.
      const at400 = await shot(400);
      const red400 = await scanInk(viewer, at400, "red");
      expect(red400.count).toBeGreaterThan(5);
      expect(Math.abs(red400.minX - p0.x)).toBeLessThanOrEqual(1.5);
      // Bar caret is 2px wide.
      expect(red400.maxX - red400.minX).toBeLessThanOrEqual(3);
      // Vertically spans the font box around the baseline.
      expect(red400.minY).toBeGreaterThanOrEqual(Math.floor(p0.baselineY - p0.ascentPx) - 2);
      expect(red400.maxY).toBeLessThanOrEqual(Math.ceil(p0.baselineY + p0.descentPx) + 2);

      // The magenta field caret is parked after "abc" at the same time.
      const mag400 = await scanInk(viewer, at400, "magenta");
      expect(mag400.count).toBeGreaterThan(3);
      expect(Math.abs(mag400.minX - pField.x)).toBeLessThanOrEqual(1.5);

      // t=1300: the red caret moved to offset 6 (before 'w').
      const at1300 = await shot(1300);
      const red1300 = await scanInk(viewer, at1300, "red");
      expect(red1300.count).toBeGreaterThan(5);
      expect(Math.abs(red1300.minX - p6.x)).toBeLessThanOrEqual(1.5);

      // t=2500 (mid-sweep, 300/600ms): the selection rect is partially grown.
      const at2500 = await scanInk(viewer, await shot(2500), "selection");
      expect(at2500.count).toBeGreaterThan(20);
      expect(Math.abs(at2500.minX - helloRect.x)).toBeLessThanOrEqual(2);
      const midWidth = at2500.maxX - at2500.minX;
      expect(midWidth).toBeGreaterThan(2);
      expect(midWidth).toBeLessThan(helloRect.width - 2);

      // t=3000 (after the sweep): full "Hello" span.
      const at3000 = await scanInk(viewer, await shot(3000), "selection");
      const fullWidth = at3000.maxX - at3000.minX;
      expect(fullWidth).toBeGreaterThan(midWidth);
      expect(Math.abs(at3000.minX - helloRect.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(at3000.maxX - (helloRect.x + helloRect.width))).toBeLessThanOrEqual(2.5);

      // t=3800: the red caret is hidden (no red ink); the selection holds.
      const at3800png = await shot(3800);
      const red3800 = await scanInk(viewer, at3800png, "red");
      expect(red3800.count).toBe(0);
      const sel3800 = await scanInk(viewer, at3800png, "selection");
      expect(sel3800.count).toBeGreaterThan(20);
    } finally {
      await ctx.close();
    }
  }, 120_000);
});
