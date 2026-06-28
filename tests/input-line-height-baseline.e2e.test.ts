import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1259: an <input> with an explicit `line-height` TALLER than its font centers
// the single line of value text within the line box (positive half-leading), so
// the baseline sits below the content-box top. The capture folds the half-leading
// into `textTop` (which the renderer treats as the line-box top, baseline =
// textTop + ascent). For `line-height: normal` the half-leading is ~0 and must
// NOT be applied off the 1.2×font-size estimate (that mis-centered every
// field-sizing input — the DM-1259 regression). Deterministic capture-level guard
// — the perceptual diff reads an ~8px-high value as a sub-% diff.

const W = 500, H = 200;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif}` +
  `input{font-size:16px;padding:6px;border:1px solid #ccc;box-sizing:content-box}` +
  `#tall{line-height:35.2px}#norm{line-height:normal}` +
  `</style></head><body>` +
  `<input id="tall" type="text" value="user@example.com">` +
  `<input id="norm" type="text" value="user@example.com">` +
  `</body></html>`;

interface InputNode { tag?: string; text?: string; y?: number; textTop?: number; fontAscent?: number; fontDescent?: number; styles?: { borderTopWidth?: string; paddingTop?: string; lineHeight?: string } }
function inputs(tree: CapturedElement[]): InputNode[] {
  const out: InputNode[] = [];
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      if (n.tag === "input") out.push(n as InputNode);
      if (n.children) visit(n.children as CapturedElement[]);
    }
  };
  visit(tree);
  return out;
}

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1259: input value baseline centers in a tall line-height", () => {
  it("shifts textTop down by the half-leading for an explicit tall line-height, but not for normal", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const found = inputs(tree);
      expect(found.length).toBe(2);
      for (const n of found) {
        const contentTop = (n.y ?? 0) + (parseFloat(n.styles?.borderTopWidth ?? "0") || 0) + (parseFloat(n.styles?.paddingTop ?? "0") || 0);
        const lh = n.styles?.lineHeight ?? "";
        const overTop = (n.textTop ?? 0) - contentTop; // how far the line/text sits below the content-box top
        if (lh.endsWith("px")) {
          // Explicit tall line-height (35.2) vs font height (~18-20): half-leading
          // ≈ (35.2 - fontH)/2 ≈ 7-8px down. Must be clearly positive.
          const fontH = (n.fontAscent ?? 0) + (n.fontDescent ?? 0);
          const expectedHalfLeading = (parseFloat(lh) - fontH) / 2;
          expect(expectedHalfLeading).toBeGreaterThan(5); // sanity on the fixture
          expect(overTop).toBeCloseTo(expectedHalfLeading, 0);
        } else {
          // line-height: normal → no spurious down-shift off the 1.2× estimate.
          expect(Math.abs(overTop)).toBeLessThan(1.5);
        }
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
