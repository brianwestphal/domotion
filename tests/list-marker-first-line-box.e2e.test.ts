import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1270: a list marker (disc / number) must align to the FIRST line of text,
// not to the li's border-box top or a `line-height` guess. When a tall inline on
// the first line (e.g. an emoji `::after` that extends ABOVE the text) raises the
// li's border box, the text line sits BELOW the li top — so a marker centered on
// `el.y + line-height/2` paints ~5px too high. The capture pass records the li's
// first line-box (offset from the li top + its height) so the renderer centers
// the marker on the text line wherever it actually sits.
//
// Deterministic capture-level guard: the perceptual diff gate reads the ~5px
// marker shift as a "minor" sub-3% diff, so assert the captured first-line-box
// metrics directly.

const W = 360, H = 160;
// First li: a tall emoji `::after` raises the li box above the text line.
// Second li: plain text — the text line starts at the li top (dy ≈ 0).
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0}ul{font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:normal}` +
  `a{color:#1d4ed8;text-decoration:none}a[href$=".pdf"]::after{content:" 📄"}` +
  `</style></head><body><ul>` +
  `<li><a href="report.pdf">Has a tall emoji</a></li>` +
  `<li>Plain text item</li>` +
  `</ul></body></html>`;

interface LiNode { styles?: { display?: string }; markerFirstLineDy?: number; markerFirstLineHeight?: number; text?: string }
function listItems(tree: CapturedElement[]): LiNode[] {
  const out: LiNode[] = [];
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      if ((n.styles?.display ?? "").includes("list-item")) out.push(n as LiNode);
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

describeBrowser("DM-1270: list marker aligns to the first text line, not the li box top", () => {
  it("captures the first line-box offset so an emoji-raised li doesn't mis-place the marker", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });

      // DM-1422: derive the EXPECTED first-line-box offset from Chromium's actual
      // layout on THIS platform, rather than hardcoding a macOS-specific `> 2`.
      // For each li, measure the first text line's top relative to the li's
      // border-box top via Range.getClientRects()[0] — exactly what the marker
      // must align to. Whether the emoji `::after` raises the line (Apple Color
      // Emoji on macOS does; Noto Color Emoji on the Playwright Linux image does
      // not) then falls out of Chromium's own paint, so the test validates the
      // DM-1270 capture against ground truth on every platform.
      const measured = await page.evaluate(() => {
        const out: { dy: number; height: number }[] = [];
        for (const li of Array.from(document.querySelectorAll("li"))) {
          const liTop = li.getBoundingClientRect().top;
          const range = document.createRange();
          range.selectNodeContents(li);
          const rects = range.getClientRects();
          const first = rects[0];
          out.push(first
            ? { dy: first.top - liTop, height: first.height }
            : { dy: 0, height: 0 });
        }
        return out;
      });

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const lis = listItems(tree);
      expect(lis.length, "captured two list items").toBe(2);
      expect(measured.length, "measured two list items").toBe(2);

      const [emojiLi, plainLi] = lis;
      const [emojiM, plainM] = measured;

      // Both li's first line-box height matches Chromium's (~18px at font-size 16).
      expect(emojiLi.markerFirstLineHeight).toBeGreaterThan(14);
      expect(plainLi.markerFirstLineHeight).toBeGreaterThan(14);
      expect(Math.abs((emojiLi.markerFirstLineHeight ?? 0) - emojiM.height)).toBeLessThan(2);
      expect(Math.abs((plainLi.markerFirstLineHeight ?? 0) - plainM.height)).toBeLessThan(2);

      // The captured first-line-box offset must match Chromium's actual layout
      // (within sub-pixel tolerance) — cross-platform. On a platform whose emoji
      // raises the line this is clearly > 0 (the DM-1270 signal that drops the
      // marker to the text line); where it doesn't, both are ≈ 0 and still agree.
      expect(Math.abs((emojiLi.markerFirstLineDy ?? 0) - emojiM.dy)).toBeLessThan(1.5);
      expect(Math.abs((plainLi.markerFirstLineDy ?? 0) - plainM.dy)).toBeLessThan(1.5);
      // The plain li's text starts at the li top — Chromium lays it flush.
      expect(Math.abs(plainM.dy)).toBeLessThan(1.5);
    } finally {
      await page.close();
    }
  }, 60_000);
});
