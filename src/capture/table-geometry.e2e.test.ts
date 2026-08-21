import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "./index.js";
import type { CapturedElement } from "./types.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { r } from "../render/format.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function findTags(nodes: CapturedElement[], tag: string): CapturedElement[] {
  const out: CapturedElement[] = [];
  for (const node of nodes) {
    if (node.tag === tag) out.push(node);
    out.push(...findTags(node.children ?? [], tag));
  }
  return out;
}

const HTML = `<!doctype html><style>
  * { box-sizing: border-box }
  html, body { margin: 0 }
  #root { padding: 12px }
  table { border-spacing: 0; padding: 0; margin: 0 0 16px; width: 120px }
  #top { border: 3px solid rgb(170, 17, 34); background: rgb(17, 34, 51) }
  #bottom { border: 3px solid rgb(187, 34, 51); background: rgb(68, 85, 102) }
  #top caption { caption-side: top; height: 20px; margin-block-end: 7px }
  #bottom caption { caption-side: bottom; height: 18px; margin-block-start: 9px }
  #top td, #bottom td { height: 24px; padding: 0 }
  #empty { border-collapse: separate; empty-cells: hide; width: auto }
  #empty td, #collapsed td { width: 30px; height: 24px; border: 2px solid rgb(1, 2, 3); background: rgb(4, 5, 6) }
  #empty .none { display: none }
  #empty .abs { position: absolute }
  #empty .block { display: block }
  #empty .contents { display: contents }
  #pseudo::before { content: "" }
  #pseudo-abs::before { content: "x"; position: absolute }
  #collapsed { border-collapse: collapse; empty-cells: hide; width: auto }
</style><div id="root">
  <table id="top"><caption>top</caption><tbody><tr><td></td></tr></tbody></table>
  <table id="bottom"><caption>bottom</caption><tbody><tr><td></td></tr></tbody></table>
  <table id="empty"><tbody><tr>
    <td id="plain"></td><td id="space">   </td><td id="nbsp">&nbsp;</td>
    <td id="display-none"><span class="none"></span></td>
    <td id="absolute"><span class="abs"></span></td>
    <td id="block"><span class="block"></span></td>
    <td id="inline"><span></span></td><td id="pseudo"></td>
    <td id="pseudo-abs"></td><td id="contents-empty"><span class="contents"></span></td>
    <td id="contents-inline"><span class="contents"><i></i></span></td>
  </tr></tbody></table>
  <table id="collapsed"><tbody><tr><td></td></tr></tbody></table>
</div>`;

describeBrowser("Blink table-grid and empty-cell fragment ownership (DM-2412)", () => {
  it("captures the exact caption-excluding table box and uses it for box paint", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 500, height: 400 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const expected = await page.evaluate(() => ["top", "bottom"].map((id) => {
        const table = document.getElementById(id)!;
        const section = table.querySelector("tbody")!;
        const tableRect = table.getBoundingClientRect();
        const sectionRect = section.getBoundingClientRect();
        const cs = getComputedStyle(table);
        const borderTop = parseFloat(cs.borderTopWidth);
        const borderBottom = parseFloat(cs.borderBottomWidth);
        return {
          wrapper: { x: tableRect.x, y: tableRect.y, width: tableRect.width, height: tableRect.height },
          grid: {
            x: tableRect.x,
            y: sectionRect.y - borderTop,
            width: tableRect.width,
            height: sectionRect.height + borderTop + borderBottom,
          },
        };
      }));
      const tree = await captureElementTree(page, "#root", { x: 0, y: 0, width: 500, height: 400 });
      const tables = findTags(tree, "table");
      expect(tables).toHaveLength(4);

      for (let i = 0; i < 2; i++) {
        expect(tables[i].styles.tableGridRect).toEqual(expected[i].grid);
        // Disabled-route control: the pre-DM-2412 wrapper geometry is
        // observably different, so this cannot pass without exercising the
        // caption-aware route.
        expect(tables[i].y).toBe(expected[i].wrapper.y);
        expect(tables[i].height).toBe(expected[i].wrapper.height);
        expect(tables[i].styles.tableGridRect).not.toEqual(expected[i].wrapper);
      }

      const svg = elementTreeToSvg(tree, 500, 400, { includeGlyphDefs: false });
      const topGrid = tables[0].styles.tableGridRect!;
      const topPaint = `<rect x="${r(topGrid.x)}" y="${r(topGrid.y)}" width="${r(topGrid.width)}" height="${r(topGrid.height)}" rx="0" fill="rgb(17,34,51)" />`;
      const oldTopPaint = `<rect x="${r(tables[0].x)}" y="${r(tables[0].y)}" width="${r(tables[0].width)}" height="${r(tables[0].height)}" rx="0" fill="rgb(17,34,51)" />`;
      expect(svg).toContain(topPaint);
      expect(svg).not.toContain(oldTopPaint);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("classifies Blink in-flow fragments rather than text/codepoint emptiness", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 500, height: 400 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const legacy = await page.evaluate(() => ["nbsp", "display-none", "absolute"].map((id) => {
        const cell = document.getElementById(id)!;
        return (cell.textContent || "").trim() === "" && cell.children.length === 0;
      }));
      expect(legacy).toEqual([true, false, false]);

      const tree = await captureElementTree(page, "#root", { x: 0, y: 0, width: 500, height: 400 });
      const cells = findTags(tree, "td");
      // First two cells belong to the caption tables. The next eleven are the
      // separate-border matrix; the final cell is the collapse control.
      expect(cells.slice(2, 13).map((cell) => cell.styles.emptyCellsHidden)).toEqual([
        true, true, false, true, true, false, false, false, true, true, false,
      ]);
      expect(cells[13].styles.emptyCellsHidden).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);
});
