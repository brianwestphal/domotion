import { afterAll, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { launchChromium, captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { generateAnimatedSvg, resolveTextTrack, resolveCaretPoint, resolveRangeRects } from "../src/animation/index.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Logical-order addressing over RTL / bidi runs (docs/101), CALIBRATED AGAINST
// CHROME'S OWN SELECTION PAINT rather than hand-derived geometry:
//
//   1. Chrome selects the SAME logical range with its Selection API and we read
//      back `Range.getClientRects()` — the geometry Blink fragments a
//      mixed-direction selection into — plus the ACTUAL painted `::selection`
//      pixel spans from a screenshot.
//   2. `resolveRangeRects` resolves the same range against the captured tree.
//   3. The two rect lists must agree rect-for-rect, and the selection ink our
//      composed animated SVG paints must land on the same pixel spans Chrome's
//      own selection paints.
//
// A logical range over mixed-direction text is visually DISCONTIGUOUS; the
// `ltr-split` case below is exactly that (a Latin piece and a Hebrew piece with
// UNSELECTED Hebrew between them), so a single-rect answer cannot pass.

const W = 640;
const H = 260;

const LINE_TOPS = { ltr: 30, rtl: 100, ar: 170 } as const;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#ffffff;font:24px Helvetica,Arial,sans-serif}
  div{position:absolute;left:20px;color:#111111}
  #ltr{top:${LINE_TOPS.ltr}px;direction:ltr}
  #rtl{top:${LINE_TOPS.rtl}px;direction:rtl}
  #ar{top:${LINE_TOPS.ar}px;direction:rtl}
  ::selection{background:#3b82f6;color:#ffffff}
</style></head><body>
  <div id="ltr" data-domotion-anim="ltr">abc שלום def</div>
  <div id="rtl" data-domotion-anim="rtl">שלום abc עולם</div>
  <div id="ar" data-domotion-anim="ar">مرحبا abc سلام</div>
</body></html>`;

interface ChromeRect { x: number; w: number }

/** Chrome's own geometry for a logical range: the client rects Blink fragments
 *  the selection into (one per bidi level run), left-to-right. */
async function chromeRangeRects(page: Page, id: string, start: number, end: number): Promise<ChromeRect[]> {
  return page.evaluate(`(() => {
    var tn = document.getElementById(${JSON.stringify(id)}).firstChild;
    var r = document.createRange(); r.setStart(tn, ${start}); r.setEnd(tn, ${end});
    var L = r.getClientRects(); var out = [];
    for (var i = 0; i < L.length; i++) out.push({ x: +L[i].x.toFixed(2), w: +L[i].width.toFixed(2) });
    out.sort(function (a, b) { return a.x - b.x; });
    return out;
  })()`) as Promise<ChromeRect[]>;
}

/** Chrome's collapsed-range x for a logical offset (its own caret geometry). */
async function chromeCaretX(page: Page, id: string, offset: number): Promise<number> {
  return page.evaluate(`(() => {
    var tn = document.getElementById(${JSON.stringify(id)}).firstChild;
    var r = document.createRange(); r.setStart(tn, ${offset}); r.setEnd(tn, ${offset});
    return +r.getBoundingClientRect().x.toFixed(2);
  })()`) as Promise<number>;
}

/** Paint the logical range with Chrome's Selection API and screenshot it. */
async function chromeSelectAndShoot(page: Page, id: string, start: number, end: number, top: number): Promise<Buffer> {
  await page.evaluate(`(() => {
    var tn = document.getElementById(${JSON.stringify(id)}).firstChild;
    var r = document.createRange(); r.setStart(tn, ${start}); r.setEnd(tn, ${end});
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return null;
  })()`);
  return page.screenshot({ clip: { x: 0, y: top, width: W, height: 34 } });
}

/** Horizontal pixel spans of selection-blue ink in a PNG band, left-to-right.
 *  `#3b82f6` (Chrome's painted highlight) and `#3b82f6aa` over white (the
 *  track's default translucent fill) are both strongly blue-dominant. */
async function selectionSpans(page: Page, png: Buffer): Promise<Array<[number, number]>> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(`(async () => {
    var img = new Image();
    await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(dataUri)}; });
    var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0);
    var d = g.getImageData(0, 0, img.width, img.height).data;
    var cols = [];
    for (var x = 0; x < img.width; x++) {
      var hit = false;
      for (var y = 0; y < img.height; y++) {
        var i = (y * img.width + x) * 4;
        if (d[i + 2] > 180 && d[i + 2] - d[i] > 60 && d[i + 2] - d[i + 1] > 40) { hit = true; break; }
      }
      cols.push(hit);
    }
    var runs = [], st = -1;
    for (var x = 0; x <= cols.length; x++) {
      if (x < cols.length && cols[x]) { if (st < 0) st = x; }
      else if (st >= 0) { if (x - st > 1) runs.push([st, x]); st = -1; }
    }
    return runs;
  })()`) as Promise<Array<[number, number]>>;
}

/** Merge touching/overlapping spans so a comparison is about the painted INK,
 *  not about where the engine chose to split its rects. */
function mergeSpans(spans: Array<[number, number]>, slack = 2): Array<[number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last != null && s[0] <= last[1] + slack) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
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

describeBrowser("bidi caret + selection addressing, calibrated against Chrome (docs/101)", () => {
  it("resolves logical ranges into the same rects Chrome fragments its own selection into", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      clearEmbeddedFonts();
      clearGlyphDefs();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      // Every case is a bidi boundary crossing: Chrome answers with ONE RECT PER
      // BIDI LEVEL RUN, and so must we.
      const cases: Array<{ id: "ltr" | "rtl" | "ar"; start: number; end: number }> = [
        { id: "ltr", start: 0, end: 4 },   // "abc " — all level 0
        { id: "ltr", start: 2, end: 8 },   // "c " + the whole Hebrew word
        { id: "ltr", start: 2, end: 6 },   // "c " + HALF the Hebrew word — DISCONTIGUOUS
        { id: "ltr", start: 4, end: 12 },  // Hebrew + " def"
        { id: "ltr", start: 0, end: 12 },  // the whole line — three level runs
        { id: "rtl", start: 0, end: 4 },   // "שלום" — level 1
        { id: "rtl", start: 2, end: 8 },   // Hebrew tail + "abc"
        { id: "rtl", start: 4, end: 10 },  // space + "abc" + space + one Hebrew char
        { id: "rtl", start: 0, end: 13 },  // the whole line
        { id: "ar", start: 0, end: 9 },    // Arabic + "abc"
        { id: "ar", start: 3, end: 12 },   // mid-Arabic through mid-Arabic
      ];

      for (const c of cases) {
        const label = `${c.id}[${c.start},${c.end})`;
        const expected = await chromeRangeRects(page, c.id, c.start, c.end);
        const got = resolveRangeRects(tree, { animId: c.id }, c.start, c.end);
        expect(got, label).not.toBeNull();
        const ours = got!.rects
          .map((r) => ({ x: +r.x.toFixed(2), w: +r.width.toFixed(2) }))
          .sort((a, b) => a.x - b.x);
        expect(ours.length, `${label} rect count`).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(Math.abs(ours[i].x - expected[i].x), `${label} rect ${i} x (ours ${ours[i].x} vs chrome ${expected[i].x})`).toBeLessThanOrEqual(1);
          expect(Math.abs(ours[i].w - expected[i].w), `${label} rect ${i} w (ours ${ours[i].w} vs chrome ${expected[i].w})`).toBeLessThanOrEqual(1);
        }
        // Every covered code point contributes exactly one sweep edge.
        expect(got!.charCount, `${label} charCount`).toBe(c.end - c.start);
        expect(got!.rects.reduce((n, r) => n + r.edges.length, 0), `${label} edges`).toBe(c.end - c.start);
      }

      // The discontiguous case is the load-bearing one: a logical range whose
      // painted pieces have UNSELECTED text between them.
      const split = resolveRangeRects(tree, { animId: "ltr" }, 2, 6)!;
      expect(split.rects).toHaveLength(2);
      const [a, b] = [...split.rects].sort((r, s) => r.x - s.x);
      expect(a.x + a.width).toBeLessThan(b.x - 10); // a real gap, not two touching rects
      // The Hebrew piece sweeps RIGHT-to-left in logical order.
      const hebrew = split.rects.find((r) => r.rtl === true)!;
      expect(hebrew.edges[0]).toBeGreaterThan(hebrew.edges[1]);
      expect(hebrew.edges[hebrew.edges.length - 1]).toBeCloseTo(hebrew.x, 1);
    } finally {
      await ctx.close();
    }
  }, 180_000);

  it("places carets on Chrome's own caret x — RTL positions are the character's RIGHT edge", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      clearEmbeddedFonts();
      clearGlyphDefs();
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      // Offsets INSIDE a level run (plus the start / end of the line) have a
      // single unambiguous caret position, and we must reproduce Chrome's.
      // Offsets that land exactly ON a level-run boundary have two legitimate
      // positions under bidi caret affinity (Blink chooses between them in
      // `third_party/blink/renderer/core/editing/bidi_adjustment.cc`); those are
      // asserted separately below.
      const unambiguous: Array<{ id: "ltr" | "rtl"; offsets: number[] }> = [
        { id: "ltr", offsets: [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 12] },
        { id: "rtl", offsets: [0, 1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13] },
      ];
      for (const u of unambiguous) {
        for (const o of u.offsets) {
          const expected = await chromeCaretX(page, u.id, o);
          const p = resolveCaretPoint(tree, { animId: u.id }, o);
          expect(p, `${u.id}@${o}`).not.toBeNull();
          expect(Math.abs(p!.x - expected), `${u.id}@${o} (ours ${p!.x} vs chrome ${expected})`).toBeLessThanOrEqual(1);
        }
      }

      // Inside the Hebrew word of the LTR line the caret marches LEFTWARD as the
      // logical offset grows, and each caret sits on the RIGHT edge of the
      // character it addresses (rtl: true).
      const hebrewCarets = [4, 5, 6, 7].map((o) => resolveCaretPoint(tree, { animId: "ltr" }, o)!);
      for (const p of hebrewCarets) expect(p.rtl).toBe(true);
      for (let i = 1; i < hebrewCarets.length; i++) expect(hebrewCarets[i].x).toBeLessThan(hebrewCarets[i - 1].x);
      // The addressed cell lies to the LEFT of the caret x, and its width is the
      // character's painted advance.
      expect(hebrewCarets[0].cellWidthPx).toBeGreaterThan(4);

      // Boundary offsets: downstream affinity — the leading edge of the
      // character the offset names. Chrome's collapsed-range API reports the
      // OTHER (upstream) side; both are legitimate, and the downstream choice is
      // what keeps a block caret's cell over the addressed character.
      const atBoundary = resolveCaretPoint(tree, { animId: "ltr" }, 4)!;
      const firstHebrewRect = resolveRangeRects(tree, { animId: "ltr" }, 4, 5)!.rects[0];
      expect(atBoundary.x).toBeCloseTo(firstHebrewRect.x + firstHebrewRect.width, 1);
    } finally {
      await ctx.close();
    }
  }, 180_000);

  it("paints selection ink on the same pixels Chrome's own ::selection paints", async () => {
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

      const cases: Array<{ id: "ltr" | "rtl"; start: number; end: number }> = [
        { id: "ltr", start: 2, end: 6 },  // discontiguous
        { id: "rtl", start: 4, end: 10 },
      ];

      // Chrome's painted spans for each case, from its own Selection API.
      const chromePainted: Array<Array<[number, number]>> = [];
      for (const c of cases) {
        const png = await chromeSelectAndShoot(page, c.id, c.start, c.end, LINE_TOPS[c.id]);
        chromePainted.push(mergeSpans(await selectionSpans(page, png)));
      }
      // Two visually separate pieces for the discontiguous logical range.
      expect(chromePainted[0].length).toBe(2);

      // Our SVG: one selection track per case, both fully swept at t=1500.
      const tracks = cases.map((c) => resolveTextTrack(tree, {
        target: { animId: c.id },
        selectionColor: "#3b82f6",
        events: [{ type: "select", t: 0, charStart: c.start, charEnd: c.end, sweepMs: 800 }],
      }));
      const svg = generateAnimatedSvg({
        width: W, height: H, background: "#ffffff",
        frames: [{ svgContent: frameSvg, duration: 3000 }],
        textTracks: tracks,
      });

      const viewer = await ctx.newPage();
      await viewer.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: "domcontentloaded" });
      await viewer.evaluate(() => document.fonts.ready);
      await seekTo(viewer, 1500);

      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const png = await viewer.screenshot({ clip: { x: 0, y: LINE_TOPS[c.id], width: W, height: 34 } });
        const ours = mergeSpans(await selectionSpans(viewer, png));
        const label = `${c.id}[${c.start},${c.end})`;
        expect(ours.length, `${label} span count (ours ${JSON.stringify(ours)} vs chrome ${JSON.stringify(chromePainted[i])})`).toBe(chromePainted[i].length);
        for (let k = 0; k < ours.length; k++) {
          expect(Math.abs(ours[k][0] - chromePainted[i][k][0]), `${label} span ${k} left`).toBeLessThanOrEqual(2);
          expect(Math.abs(ours[k][1] - chromePainted[i][k][1]), `${label} span ${k} right`).toBeLessThanOrEqual(2);
        }
      }

      // Mid-sweep the RTL piece has grown from its RIGHT edge leftward: its ink
      // still touches the range's right edge but not yet its left edge.
      await seekTo(viewer, 200);
      const midPng = await viewer.screenshot({ clip: { x: 0, y: LINE_TOPS.rtl, width: W, height: 34 } });
      const mid = mergeSpans(await selectionSpans(viewer, midPng));
      const full = chromePainted[1];
      expect(mid.length).toBeGreaterThan(0);
      const midRight = Math.max(...mid.map((s) => s[1]));
      const fullRight = Math.max(...full.map((s) => s[1]));
      const midLeft = Math.min(...mid.map((s) => s[0]));
      const fullLeft = Math.min(...full.map((s) => s[0]));
      expect(Math.abs(midRight - fullRight)).toBeLessThanOrEqual(2);
      expect(midLeft).toBeGreaterThan(fullLeft + 4);
    } finally {
      await ctx.close();
    }
  }, 180_000);
});
