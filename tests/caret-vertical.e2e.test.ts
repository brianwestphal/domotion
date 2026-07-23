import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { generateAnimatedSvg, resolveTextTrack, resolveCaretPoint, resolveRangeRects, addressableLength } from "../src/animation/index.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Vertical-writing-mode addressing (docs/101): a caret / selection addressed
// into `vertical-rl` / `vertical-lr` / `sideways-rl` text, verified two ways —
//   1. against CHROME's own geometry (collapsed-range caret y down the column
//      and `Range.getClientRects()` for a range), and
//   2. by RASTERIZING the composed animated SVG and scanning the painted ink:
//      the caret must be a HORIZONTAL bar at the resolved column position for
//      several offsets, and the selection sweep must grow DOWNWARD.

const W = 460;
const H = 380;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#ffffff;font:24px "Hiragino Sans","Hiragino Mincho ProN",serif}
  div{position:absolute;top:20px;height:300px;color:#111111}
  #vrl{right:40px;writing-mode:vertical-rl}
  #vlr{right:160px;writing-mode:vertical-lr}
  #side{right:280px;writing-mode:sideways-rl}
  ::selection{background:#3b82f6;color:#ffffff}
</style></head><body>
  <div id="vrl" data-domotion-anim="vrl">縦書きのテスト</div>
  <div id="vlr" data-domotion-anim="vlr">日本語の文章</div>
  <div id="side" data-domotion-anim="side">Sideways text</div>
</body></html>`;

/** Chrome's own collapsed-range caret position for a logical offset. */
async function chromeCaret(page: Page, id: string, offset: number): Promise<{ x: number; y: number; w: number }> {
  return page.evaluate(`(() => {
    var tn = document.getElementById(${JSON.stringify(id)}).firstChild;
    var r = document.createRange(); r.setStart(tn, ${offset}); r.setEnd(tn, ${offset});
    var q = r.getBoundingClientRect();
    return { x: +q.x.toFixed(2), y: +q.y.toFixed(2), w: +q.width.toFixed(2) };
  })()`) as Promise<{ x: number; y: number; w: number }>;
}

/** Chrome's own client rects for a logical range. */
async function chromeRangeRects(page: Page, id: string, start: number, end: number): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
  return page.evaluate(`(() => {
    var tn = document.getElementById(${JSON.stringify(id)}).firstChild;
    var r = document.createRange(); r.setStart(tn, ${start}); r.setEnd(tn, ${end});
    var L = r.getClientRects(); var out = [];
    for (var i = 0; i < L.length; i++) out.push({ x: +L[i].x.toFixed(2), y: +L[i].y.toFixed(2), w: +L[i].width.toFixed(2), h: +L[i].height.toFixed(2) });
    return out;
  })()`) as Promise<Array<{ x: number; y: number; w: number; h: number }>>;
}

/** Bounding box + pixel count of ink matching a color family in a PNG. The
 *  caret paints pure red; the selection is `#3b82f6`, strongly blue-dominant. */
async function scanInk(page: Page, png: Buffer, mode: "red" | "selection"): Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number }> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  const test = mode === "red" ? "r > 180 && gg < 100 && b < 100" : "b > 180 && b - r > 60 && b - gg > 30";
  return page.evaluate(`(async () => {
    var img = new Image();
    await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(dataUri)}; });
    var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0);
    var d = g.getImageData(0, 0, img.width, img.height).data;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
    for (var y = 0; y < img.height; y++) for (var x = 0; x < img.width; x++) {
      var i = (y * img.width + x) * 4;
      var r = d[i], gg = d[i + 1], b = d[i + 2];
      if (${test}) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; n++; }
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, count: n };
  })()`) as Promise<{ minX: number; maxX: number; minY: number; maxY: number; count: number }>;
}

async function setup(): Promise<{ browser: Awaited<ReturnType<typeof launchChromium>> } | null> {
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

describeBrowser("vertical-writing-mode caret + selection addressing (docs/101)", () => {
  it("addresses vertical-rl / vertical-lr / sideways text and matches Chrome's own column geometry", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      clearEmbeddedFonts();
      clearGlyphDefs();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      const cases: Array<{ id: "vrl" | "vlr" | "side"; len: number; mode: string }> = [
        { id: "vrl", len: 7, mode: "vertical-rl" },
        { id: "vlr", len: 6, mode: "vertical-lr" },
        { id: "side", len: 13, mode: "sideways-rl" },
      ];

      for (const c of cases) {
        // Addressable at all (the old engine skipped every vertical segment).
        expect(addressableLength(tree, { animId: c.id }), `${c.id} length`).toBe(c.len);

        // Caret at every logical offset, including end-of-text, matches Chrome's
        // own collapsed-range position down the column.
        for (let o = 0; o <= c.len; o++) {
          const expected = await chromeCaret(page, c.id, o);
          const p = resolveCaretPoint(tree, { animId: c.id }, o);
          expect(p, `${c.id}@${o}`).not.toBeNull();
          expect(p!.vertical, `${c.id}@${o} mode`).toBe(c.mode);
          expect(Math.abs(p!.baselineY - expected.y), `${c.id}@${o} y (ours ${p!.baselineY} vs chrome ${expected.y})`).toBeLessThanOrEqual(1);
          expect(Math.abs(p!.x - expected.x), `${c.id}@${o} column x`).toBeLessThanOrEqual(1);
          expect(Math.abs((p!.columnWidthPx ?? 0) - expected.w), `${c.id}@${o} column width`).toBeLessThanOrEqual(1);
        }
        // The caret marches DOWN the column as the offset grows.
        const ys = Array.from({ length: c.len + 1 }, (_, o) => resolveCaretPoint(tree, { animId: c.id }, o)!.baselineY);
        for (let i = 1; i < ys.length; i++) expect(ys[i], `${c.id} monotonic @${i}`).toBeGreaterThan(ys[i - 1]);

        // A range yields one rect spanning the column and covering the swept
        // stretch, matching Chrome's own client rect.
        const chromeRects = await chromeRangeRects(page, c.id, 1, 4);
        const got = resolveRangeRects(tree, { animId: c.id }, 1, 4)!;
        expect(got.rects, `${c.id} rect count`).toHaveLength(1);
        const r = got.rects[0];
        expect(r.vertical, `${c.id} vertical flag`).toBe(true);
        expect(r.edges, `${c.id} edges`).toHaveLength(3);
        expect(Math.abs(r.x - chromeRects[0].x), `${c.id} rect x`).toBeLessThanOrEqual(1);
        expect(Math.abs(r.width - chromeRects[0].w), `${c.id} rect width`).toBeLessThanOrEqual(1);
        expect(Math.abs(r.y - chromeRects[0].y), `${c.id} rect y`).toBeLessThanOrEqual(1);
        expect(Math.abs(r.height - chromeRects[0].h), `${c.id} rect height (ours ${r.height} vs chrome ${chromeRects[0].h})`).toBeLessThanOrEqual(1.5);
        // Edges step DOWNWARD and the last one is the rect's bottom.
        for (let i = 1; i < r.edges.length; i++) expect(r.edges[i]).toBeGreaterThan(r.edges[i - 1]);
        expect(r.edges[r.edges.length - 1]).toBeCloseTo(r.y + r.height, 5);
      }
    } finally {
      await ctx.close();
    }
  }, 180_000);

  it("rasterizes a horizontal caret at the resolved column position and a selection that grows DOWNWARD", async () => {
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

      const p0 = resolveCaretPoint(tree, { animId: "vrl" }, 0)!;
      const p3 = resolveCaretPoint(tree, { animId: "vrl" }, 3)!;
      const pEnd = resolveCaretPoint(tree, { animId: "vrl" }, 7)!;
      const range = resolveRangeRects(tree, { animId: "vrl" }, 1, 5)!;
      const rect = range.rects[0];
      expect(p3.baselineY).toBeGreaterThan(p0.baselineY);
      expect(pEnd.baselineY).toBeGreaterThan(p3.baselineY);

      const track = resolveTextTrack(tree, {
        target: { animId: "vrl" },
        color: "#ff0000",
        selectionColor: "#3b82f6",
        events: [
          { type: "park", t: 200, charOffset: 0 },
          { type: "move", t: 1200, charOffset: 3 },
          { type: "move", t: 2000, charOffset: 7 },
          { type: "select", t: 2600, charStart: 1, charEnd: 5, sweepMs: 800 },
        ],
      });
      const svg = generateAnimatedSvg({
        width: W, height: H, background: "#ffffff",
        frames: [{ svgContent: frameSvg, duration: 4200 }],
        textTracks: [track],
      });
      expect(svg).toContain('class="text-track"');

      const viewer = await ctx.newPage();
      await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
      await viewer.evaluate(() => document.fonts.ready);
      const shot = async (tMs: number): Promise<Buffer> => {
        await seekTo(viewer, tMs);
        return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };

      // t=400 (blink-on): a HORIZONTAL bar caret — wide across the column,
      // only a couple of pixels tall — parked at offset 0.
      const red400 = await scanInk(viewer, await shot(400), "red");
      expect(red400.count).toBeGreaterThan(10);
      expect(Math.abs(red400.minY - p0.baselineY)).toBeLessThanOrEqual(1.5);
      expect(red400.maxY - red400.minY).toBeLessThanOrEqual(3);          // thin along the column
      expect(red400.maxX - red400.minX).toBeGreaterThan(10);             // wide across it
      expect(Math.abs(red400.minX - p0.x)).toBeLessThanOrEqual(1.5);

      // t=1300 / t=2200: the caret moved DOWN the column, staying in it.
      const red1300 = await scanInk(viewer, await shot(1300), "red");
      expect(Math.abs(red1300.minY - p3.baselineY)).toBeLessThanOrEqual(1.5);
      expect(red1300.minY).toBeGreaterThan(red400.minY + 10);
      expect(Math.abs(red1300.minX - p0.x)).toBeLessThanOrEqual(1.5);
      const red2200 = await scanInk(viewer, await shot(2200), "red");
      expect(Math.abs(red2200.minY - pEnd.baselineY)).toBeLessThanOrEqual(1.5);

      // t=3000 (mid-sweep, 400/800ms): the selection covers the column's width
      // but only part of the range's height, anchored at its TOP.
      const mid = await scanInk(viewer, await shot(3000), "selection");
      expect(mid.count).toBeGreaterThan(50);
      expect(Math.abs(mid.minY - rect.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(mid.minX - rect.x)).toBeLessThanOrEqual(2);
      expect(Math.abs((mid.maxX - mid.minX) - rect.width)).toBeLessThanOrEqual(2);
      const midHeight = mid.maxY - mid.minY;
      expect(midHeight).toBeGreaterThan(2);
      expect(midHeight).toBeLessThan(rect.height - 2);

      // t=3600 (after the sweep): the full covered stretch, grown downward.
      const full = await scanInk(viewer, await shot(3600), "selection");
      expect(full.maxY - full.minY).toBeGreaterThan(midHeight);
      expect(Math.abs(full.minY - rect.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(full.maxY - (rect.y + rect.height))).toBeLessThanOrEqual(2.5);
    } finally {
      await ctx.close();
    }
  }, 180_000);
});
