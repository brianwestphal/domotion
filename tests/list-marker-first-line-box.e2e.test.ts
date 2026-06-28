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
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const lis = listItems(tree);
      expect(lis.length, "captured two list items").toBe(2);

      const [emojiLi, plainLi] = lis;
      // Both li's must carry the first line-box height (~18px at font-size 16).
      expect(emojiLi.markerFirstLineHeight).toBeGreaterThan(14);
      expect(plainLi.markerFirstLineHeight).toBeGreaterThan(14);
      // The emoji `::after` extends above the text and raises the li border box,
      // so the FIRST TEXT LINE sits below the li top — dy must be clearly > 0.
      // This is the signal the marker positioning needs to drop the disc to the
      // text line instead of the raised li top.
      expect(emojiLi.markerFirstLineDy ?? 0).toBeGreaterThan(2);
      // The plain li's text starts at the li top — dy ≈ 0.
      expect(Math.abs(plainLi.markerFirstLineDy ?? 0)).toBeLessThan(1.5);
    } finally {
      await page.close();
    }
  }, 60_000);
});
