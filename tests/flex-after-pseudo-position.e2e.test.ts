import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1256: an in-flow `::after` on a flex host with `justify-content:
// space-between` (or flex-end / end / right) is the LAST flex item, pushed to the
// flex line's end — the content-right edge (LTR). The capture anchored it with a
// legacy `elLeft + rect.width - 2·padR` heuristic that double-counts padding-left
// and overshoots ~border+padding px past the content edge (the `<details>`
// accordion `summary::after` "+" disclosure marker rendered ~8px too far right).
// The capture now anchors the marker's right edge at the content-right edge.
// Deterministic capture-level guard — the perceptual diff reads an ~8px marker
// shift amid lots of text as a single sub-% region.

const W = 600, H = 200;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui,sans-serif}` +
  `summary{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border:1px solid #ccc;list-style:none}` +
  `summary::after{content:"+";font-size:20px;color:#475569}` +
  `</style></head><body><details><summary>Section title</summary><div>body</div></details></body></html>`;

const BOX_HTML =
  `<!doctype html><style>body{margin:0}.host{display:flex;align-items:center;justify-content:space-between;` +
  `width:300px;height:48px;padding:0 18px;border:2px solid #ccc}.host::after{content:"";display:block;` +
  `width:8px;height:8px;border-top:2px solid;border-right:2px solid}</style>` +
  `<div class="host">Account</div>`;

function findSummaryAfter(tree: CapturedElement[]) {
  let hit: { rect: { x: number; width: number }; el: CapturedElement } | null = null;
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      if (n.tag === "summary") {
        const record = n.pseudoFragments?.find((entry) => entry.pseudo === "::after");
        const fragment = record?.fragments.find((entry) => entry.kind === "text" && entry.text.includes("+"));
        if (fragment?.kind === "text") { hit = { rect: fragment.physicalRect, el: n }; return; }
      }
      if (n.children) visit(n.children as CapturedElement[]);
      if (hit) return;
    }
  };
  visit(tree);
  return hit;
}

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1256: flex space-between ::after is anchored at the content-right edge", () => {
  it("places the summary::after marker just inside the content-right edge, not past it", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const hit = findSummaryAfter(tree);
      expect(hit, "captured the summary::after marker").not.toBeNull();
      const { rect, el } = hit!;
      const borderR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
      const contentRight = el.x + el.width - borderR - padR;
      // The marker's RIGHT edge (text-left + its advance) must land at the
      // content-right edge — that's where flex space-between pushes the last item.
      // The legacy heuristic overshot it past the content edge.
      const markerRight = rect.x + rect.width;
      expect(markerRight).toBeCloseTo(contentRight, 0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("places an empty border-box ::after at the same flex-end anchor", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(BOX_HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const host = tree[0];
      const box = host.pseudoFragments?.find((record) => record.pseudo === "::after")?.boxFragments[0]?.physicalRect;
      expect(box).toBeDefined();
      expect(box!.x + box!.width).toBeCloseTo(320, 0); // 340 border-box right − 2 border − 18 padding
      expect(box!.y).toBeCloseTo(21, 0); // centered 10px border-box in the 48px content box
    } finally {
      await page.close();
    }
  }, 60_000);
});
