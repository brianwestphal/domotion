import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// A NON-FLOATED `initial-letter: <size> <sink>` first letter (a raised cap:
// `float: none`, `display: inline`) must be captured at the size and vertical
// position Chromium actually paints it at.
//
// Two things Chromium does NOT report through `getComputedStyle` directly:
//
//  1. SIZE. `getComputedStyle(el, "::first-letter").fontSize` echoes the value
//     the author specified (typically a large `em` fallback for engines without
//     `initial-letter` support) — NOT the size Chromium paints. What it does
//     report faithfully is the pseudo's content box: its `height` is the
//     cap-height Chromium sized the initial letter to, so the effective
//     font-size is `height / capHeightRatio`. An earlier revision divided the
//     pseudo's INK `width` by the canvas ADVANCE width, which under-reports by
//     the side bearings (~1.8% on Georgia, ~7% on Arial).
//
//  2. POSITION. The per-character `Range` rect top is the ASCENT-top of the
//     glyph at that effective size, so `baseline = rangeTop + ascent`. An
//     earlier revision treated the `Range` top as the CAP-top and added
//     `capHeight - ascent`, which painted the cap too HIGH by an amount that
//     grows with the cap size (~4px at `initial-letter: 1`, ~22px at `3`).
//
// The perceptual diff gate scores that shift as a sub-1% "minor" diff on a
// full-page fixture, so assert against Chromium's PAINTED INK directly here.

const W = 760, H = 320;
const INK = { r: 180, g: 83, b: 9 }; // #b45309 — only the raised cap paints this
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0;background:#fff;font-family:Georgia,"Times New Roman",serif;color:#1f2937;line-height:1.65}` +
  `p{margin:0;font-size:17px;width:720px}` +
  `p::first-letter{initial-letter:3 3;-webkit-initial-letter:3 3;` +
  `font-size:2.8em;font-weight:800;line-height:1;color:#b45309}` +
  `</style></head><body>` +
  `<p>The first letter is raised above the baseline but does not sink into the paragraph, ` +
  `which is useful for shorter article openings where a sinking cap would overwhelm the text.</p>` +
  `</body></html>`;

/** Every text segment in the tree, flattened. */
function allSegments(tree: CapturedElement[]): NonNullable<CapturedElement["textSegments"]> {
  const out: NonNullable<CapturedElement["textSegments"]> = [];
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      if (n.textSegments) out.push(...n.textSegments);
      if (n.children) visit(n.children as CapturedElement[]);
    }
  };
  visit(tree);
  return out;
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

describeBrowser("non-floated `initial-letter` raised cap", () => {
  it("captures the effective size and painted baseline Chromium actually uses", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });

      // Ground truth #1 — Chromium's own metrics for the pseudo, plus the
      // font's cap-height / ascent ratios from a 100px canvas probe. Measured
      // on THIS platform's actual font, so the test holds cross-platform.
      const m = await page.evaluate(() => {
        const p = document.querySelector("p")!;
        const fl = getComputedStyle(p, "::first-letter");
        const cv = document.createElement("canvas").getContext("2d")!;
        cv.font = `${fl.fontStyle} ${fl.fontWeight} 100px ${fl.fontFamily}`;
        const h = cv.measureText("H");
        const range = document.createRange();
        range.setStart(p.firstChild!, 0);
        range.setEnd(p.firstChild!, 1);
        return {
          specifiedFontSize: parseFloat(fl.fontSize),
          pseudoHeight: parseFloat(fl.height),
          capRatio: h.actualBoundingBoxAscent / 100,
          pseudoWidth: parseFloat(fl.width),
          glyphInkW100: (() => { const t = cv.measureText("T");
            return (t.actualBoundingBoxLeft || 0) + (t.actualBoundingBoxRight || 0); })(),
          ascentRatio: h.fontBoundingBoxAscent / 100,
          rangeTop: range.getBoundingClientRect().top,
          float: fl.float,
        };
      });
      expect(m.float, "the raised cap is not floated").toBe("none");
      expect(m.capRatio).toBeGreaterThan(0.5);

      // Ground truth #2 — the painted ink. Scan Chromium's own screenshot for
      // the cap's color; nothing else on the page paints it.
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
      let inkTop = Infinity, inkBottom = -Infinity;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * info.channels;
          const dist = Math.abs(data[i] - INK.r) + Math.abs(data[i + 1] - INK.g) + Math.abs(data[i + 2] - INK.b);
          if (dist <= 60) {
            if (y < inkTop) inkTop = y;
            if (y > inkBottom) inkBottom = y;
          }
        }
      }
      expect(inkBottom, "the raised cap painted somewhere").toBeGreaterThan(0);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      // The styled ::first-letter is emitted as its own single-character
      // segment carrying the pseudo's font — the only such segment here.
      const styled = allSegments(tree).filter((s) => s.text.trim().length === 1 && s.fontSize != null);
      expect(styled.length, "one styled ::first-letter segment").toBe(1);
      const seg = styled[0]!;

      // SIZE: the effective size is the pseudo's content height over the
      // font's cap-height ratio — NOT the specified `2.8em`, and not the
      // advance-width quotient that under-reports it.
      // DM-1977: the expected size is the pseudo's content-box INK width over
      // the glyph's ink width at the probe size — a like-for-like ratio.
      //
      // This used to be `pseudoHeight / capRatio`, which assumed Chrome's
      // reported pseudo `height` IS the cap height it sized the glyph to. That
      // holds on macOS/Georgia and fails on Linux: with the stack falling
      // through to Liberation Serif, Chrome reports `height: 69` while painting
      // a 67 px cap, so the height quotient over-sized by ~4% and `fontAscent`,
      // `baseline` and `capTop` all inherited it.
      const expectedFs = 100 * m.pseudoWidth / m.glyphInkW100;
      expect(seg.fontSize!).toBeCloseTo(expectedFs, 0);
      expect(Math.abs(seg.fontSize! - m.specifiedFontSize)).toBeGreaterThan(10);

      // POSITION: the renderer reconstructs the baseline as
      // `seg.y + seg.fontAscent`; for a capital that puts the ink top a
      // cap-height above it. That must land on Chromium's painted cap top.
      // The buggy cap-top-anchored placement missed by ~22px at this size.
      const baseline = seg.y + seg.fontAscent!;
      const renderedCapTop = baseline - seg.fontSize! * m.capRatio;
      expect(Math.abs(renderedCapTop - inkTop)).toBeLessThan(1.5);
      // ...and the baseline itself matches the painted ink bottom (a capital
      // "T" sits on the baseline, so ink bottom == baseline).
      expect(Math.abs(baseline - (inkBottom + 1))).toBeLessThan(1.5);

      // The `Range` rect top is the ascent-top, not the cap-top: the captured
      // segment anchors there directly.
      expect(Math.abs(seg.y - m.rangeTop)).toBeLessThan(1.5);
    } finally {
      await page.close();
    }
  }, 60_000);
});
