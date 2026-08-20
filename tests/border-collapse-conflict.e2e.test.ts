import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, elementTreeToSvgInner, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1260: CSS 2.1 §17.6.2.1 collapsed-border conflict resolution. Each grid edge
// paints the SINGLE winning border (hidden suppresses; else widest wins; tie →
// style rank; true tie → cell > row > col > table, earlier cell first), and the
// table / row / column-group box borders are folded into one table-owned logical
// edge graph. Capture stores the pixel-snapped physical paint rectangles on the
// table and suppresses every contributing box border.

const W = 360, H = 220;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}` +
  `table{border-collapse:collapse}td{padding:10px 16px;font:14px sans-serif}` +
  `.tbl{border:6px solid rgb(0,128,0)}` +              // table border — loses to cells
  `.a{border:2px solid rgb(0,0,255)}` +                // thin blue
  `.b{border:8px solid rgb(255,0,0)}` +                // thick red — wins width
  `.c{border:4px dashed rgb(255,0,255)}` +             // dashed — loses style to solid
  `</style></head><body><table class="tbl">` +
  `<tr><td class="a">A</td><td class="b">B</td><td class="c">C</td></tr></table></body></html>`;

interface Node { tag?: string; text?: string; styles?: Record<string, string | undefined>; children?: Node[] }
function find(tree: CapturedElement[], pred: (n: Node) => boolean): Node | null {
  let hit: Node | null = null;
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) { if (hit) return; if (pred(n)) { hit = n; return; } if (n.children) visit(n.children); }
  };
  visit(tree as Node[]);
  return hit;
}

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1260: border-collapse conflict resolution", () => {
  it("resolves shared edges to the winner and suppresses structural box borders", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const cellA = find(tree, (n) => n.tag === "td" && /\bA\b/.test(n.text ?? ""));
      const cellB = find(tree, (n) => n.tag === "td" && /\bB\b/.test(n.text ?? ""));
      const table = find(tree, (n) => n.tag === "table");
      expect(cellA, "captured cell A").toBeTruthy();
      expect(cellB, "captured cell B").toBeTruthy();
      expect(table, "captured table").toBeTruthy();

      const rects = (table!.styles as any).collapsedBorderRects as Array<any>;
      // The A|B shared edge: B's 8px red wins over A's 2px blue (width), but the
      // winner is painted once by the table rather than assigned to either cell.
      expect(rects).toContainEqual(expect.objectContaining({ axis: "column", width: 8, style: "solid", color: "rgb(255, 0, 0)" }));
      expect(parseFloat(cellA!.styles!.borderRightWidth ?? "0")).toBe(0);
      expect(parseFloat(cellB!.styles!.borderLeftWidth ?? "0")).toBe(0);

      // A's outer LEFT edge: the table's 6px green border WINS over A's 2px blue
      // (width), demonstrating that structural sources participate in the graph.
      expect(rects).toContainEqual(expect.objectContaining({ axis: "column", width: 6, style: "solid", color: "rgb(0, 128, 0)" }));

      // The table's own box border is suppressed (folded into the cell edges).
      expect(parseFloat(table!.styles!.borderTopWidth ?? "0")).toBe(0);
      expect(table!.styles!.borderTopStyle).toBe("none");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("segments a rowspan edge at each neighbouring cell (DM-2246)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>table{border-collapse:collapse}td{width:60px;height:30px;border:2px solid blue}.r{border-right:6px solid red}.b{border-left:8px dashed green}</style><table><tr><td class="r" rowspan="2">R</td><td>A</td></tr><tr><td class="b">B</td></tr></table>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const table = find(tree, (n) => n.tag === "table")!;
      const right = ((table.styles as any).collapsedBorderRects as Array<any>)
        .filter((rect) => rect.axis === "column" && (rect.color === "rgb(255, 0, 0)" || rect.color === "rgb(0, 128, 0)"));
      expect(right).toHaveLength(2);
      expect(right.map((rect) => [rect.width, rect.style, rect.color])).toEqual([
        [6, "solid", "rgb(255, 0, 0)"],
        [8, "dashed", "rgb(0, 128, 0)"],
      ]);
      const cell = find(tree, (n) => n.tag === "td" && n.text === "R")!;
      expect(parseFloat(cell.styles!.borderRightWidth ?? "1")).toBe(0);
      const svg = elementTreeToSvgInner(tree, W, H);
      expect(svg).toMatch(/width="6"[^>]+fill="rgb\(255,0,0\)"/);
      expect(svg).toMatch(/stroke="rgb\(0,128,0\)" stroke-width="8"/);
    } finally { await page.close(); }
  }, 60_000);

  it("uses physical unequal row-track boundaries for rowspan segments (DM-2252)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>table{border-collapse:collapse}td{width:60px;border:2px solid blue}.r{border-right:6px solid red}.a{height:20px}.b{height:70px;border-left:8px dashed green}</style><table><tr><td class="r" rowspan="2">R</td><td class="a">A</td></tr><tr><td class="b">B</td></tr></table>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const table = find(tree, (n) => n.tag === "table")!;
      const right = ((table.styles as any).collapsedBorderRects as Array<any>)
        .filter((rect) => rect.axis === "column" && (rect.color === "rgb(255, 0, 0)" || rect.color === "rgb(0, 128, 0)"));
      expect(right).toHaveLength(2);
      expect(right[0].height).not.toBe(right[1].height);
      expect(right[0].y + right[0].height).toBe(right[1].y);
    } finally { await page.close(); }
  }, 60_000);

  it("uses physical unequal column-track boundaries for colspan segments (DM-2252)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>table{border-collapse:collapse}td{height:30px;border:2px solid blue}.c{border-bottom:6px solid red}.a{width:25px}.b{width:95px;border-top:8px dashed green}</style><table><tr><td class="c" colspan="2">C</td></tr><tr><td class="a">A</td><td class="b">B</td></tr></table>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const table = find(tree, (n) => n.tag === "table")!;
      const bottom = ((table.styles as any).collapsedBorderRects as Array<any>)
        .filter((rect) => rect.axis === "row" && (rect.color === "rgb(255, 0, 0)" || rect.color === "rgb(0, 128, 0)"));
      expect(bottom).toHaveLength(2);
      expect(bottom[0].width).not.toBe(bottom[1].width);
      expect(bottom[0].x + bottom[0].width).toBe(bottom[1].x);
    } finally { await page.close(); }
  }, 60_000);

  it("maps vertical-rl RTL logical edges to physical table rectangles (DM-2320)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>table{border-collapse:collapse;writing-mode:vertical-rl;direction:rtl}td{width:34px;height:44px;border:2px solid blue}.a{border-right:7px solid red}.b{border-right:5px dashed green}</style><table><tr><td class="a">A</td><td class="b">B</td></tr></table>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      expect(rects.some((rect) => rect.width === 7 && rect.color === "rgb(255, 0, 0)")).toBe(true);
      expect(rects.some((rect) => rect.width === 5 && rect.style === "dashed" && rect.color === "rgb(0, 128, 0)")).toBe(true);
      expect(elementTreeToSvgInner(tree, W, H)).toContain('stroke="rgb(0,128,0)"');
    } finally { await page.close(); }
  }, 60_000);

  it("paints collapsed edges independently in each multicol table fragment (DM-2322)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 800, height: 260 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>body{margin:0}.cols{columns:3;column-fill:auto;width:720px;height:120px}.t{border-collapse:collapse;width:100%}.t td{box-sizing:border-box;height:38px;border:4px solid rgb(0,0,255);padding:0}</style><div class="cols"><table class="t"><tbody>${Array.from({ length: 8 }, (_, i) => `<tr><td>${i}</td></tr>`).join("")}</tbody></table></div>`, { waitUntil: "load" });
      const sourceFragments = await page.locator("table").evaluate((table) => Array.from(table.getClientRects(), (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })));
      expect(sourceFragments.length).toBeGreaterThan(1);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 260 });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      for (const fragment of sourceFragments) {
        expect(rects.some((rect) => rect.x < fragment.right && rect.x + rect.width > fragment.left)).toBe(true);
      }
      // A row break paints one half of the winning edge at the outgoing
      // fragment bottom and the other half at the incoming fragment top.
      expect(sourceFragments.slice(0, -1).every((fragment) => rects.some((rect) => rect.axis === "row" && rect.height === 2 && rect.x < fragment.right && rect.x + rect.width > fragment.left && rect.y > fragment.top))).toBe(true);
      expect(sourceFragments.slice(1).every((fragment) => rects.some((rect) => rect.axis === "row" && rect.height === 2 && rect.y === Math.round(fragment.top)))).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("omits row-axis edges where one table row itself fragments (DM-2322)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 800, height: 260 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>body{margin:0}.cols{columns:3;column-fill:auto;width:720px;height:110px}.t{border-collapse:collapse;width:100%}.t td{border:5px solid rgb(220,0,0);padding:4px}.tall{height:245px}</style><div class="cols"><table class="t"><tbody><tr class="tall"><td>A<br>${"line<br>".repeat(14)}</td></tr><tr><td>B</td></tr></tbody></table></div>`, { waitUntil: "load" });
      const fragments = await page.locator("table").evaluate((table) => Array.from(table.getClientRects(), (rect) => ({ top: Math.round(rect.top), bottom: Math.round(rect.bottom) })));
      expect(fragments.length).toBeGreaterThan(1);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 800, height: 260 });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      expect(rects.some((rect) => rect.axis === "column" && rect.height > 0)).toBe(true);
      // Blink skips the inline edge at both ends of a continued row; there is
      // no synthetic full/half horizontal border at those fragmentainer cuts.
      for (const fragment of fragments.slice(0, -1)) {
        expect(rects.some((rect) => rect.axis === "row" && (rect.y === fragment.bottom || rect.y + rect.height === fragment.bottom))).toBe(false);
      }
    } finally { await page.close(); }
  }, 60_000);

  it("does not invent edges for an empty trailing table fragment or clip outer ink (DM-2322)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 1000, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>body{margin:0}.cols{columns:4;column-fill:auto;width:920px;height:110px}.t{border-collapse:collapse;width:100%}.t td{border:5px solid red;padding:4px}.tall{height:245px}</style><div class="cols"><table class="t"><tbody><tr class="tall"><td>A<br>${"line<br>".repeat(14)}</td></tr><tr><td>B</td></tr></tbody></table></div>`, { waitUntil: "load" });
      const fragments = await page.evaluate(() => {
        const serial = (element: Element) => Array.from(element.getClientRects(), (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
        return { table: serial(document.querySelector("table")!), section: serial(document.querySelector("tbody")!) };
      });
      expect(fragments.table).toHaveLength(4);
      expect(fragments.section).toHaveLength(3);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1000, height: 300 });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      const empty = fragments.table[3];
      expect(rects.some((rect) => rect.x < empty.right && rect.x + rect.width > empty.left)).toBe(false);

      // Blink's table painter owns collapsed-border overflow. A completed
      // edge may extend past its table fragment, so capture must not intersect
      // every generated rectangle with the wrapper's DOMRect.
      const lastPainted = fragments.table[2];
      expect(rects.some((rect) => rect.x < lastPainted.right && rect.x + rect.width > lastPainted.left && rect.y + rect.height > lastPainted.bottom)).toBe(true);
    } finally { await page.close(); }
  }, 60_000);

  it("places repeated headers and footers at each fragment edge (DM-2322)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 1100, height: 260 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>body{margin:0}.cols{columns:5;column-fill:auto;width:1000px;height:140px}.t{border-collapse:collapse;width:100%}th,td{height:30px;padding:0;border:2px solid #2563eb}thead,tfoot{break-inside:avoid}thead th{border-top:6px solid rgb(220,0,0)}tfoot td{border-bottom:8px solid rgb(0,140,0)}</style><div class="cols"><table class="t"><thead><tr><th></th></tr></thead><tbody>${Array.from({ length: 12 }, () => `<tr><td></td></tr>`).join("")}</tbody><tfoot><tr><td></td></tr></tfoot></table></div>`, { waitUntil: "load" });
      const cssom = await page.evaluate(() => {
        const table = document.querySelector("table")!;
        const serial = (el: Element) => Array.from(el.getClientRects(), (rect) => [rect.left, rect.top, rect.right, rect.bottom]);
        return { table: serial(table), head: serial(document.querySelector("thead")!), foot: serial(document.querySelector("tfoot")!) };
      });
      expect(cssom.table.length).toBeGreaterThan(2);
      // Chromium exposes one rect per repeat but aliases their coordinates to
      // the prototype; this is the structural signal capture transcribes.
      expect(cssom.head).toHaveLength(cssom.table.length);
      expect(new Set(cssom.head.map((rect) => rect.join(","))).size).toBe(1);
      expect(cssom.foot).toHaveLength(cssom.table.length);
      expect(new Set(cssom.foot.map((rect) => rect.join(","))).size).toBe(1);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1100, height: 260 });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      for (const fragment of cssom.table) {
        const [left, top, right, bottom] = fragment;
        expect(rects.some((rect) => rect.axis === "row" && rect.color === "rgb(220, 0, 0)" && rect.x < right && rect.x + rect.width > left && rect.y <= Math.round(top + 4))).toBe(true);
        expect(rects.some((rect) => rect.axis === "row" && rect.color === "rgb(0, 140, 0)" && rect.x < right && rect.x + rect.width > left && rect.y + rect.height >= Math.round(bottom - 5))).toBe(true);
      }
    } finally { await page.close(); }
  }, 60_000);

  it("maps fragmented vertical-rl RTL tables through logical block coordinates (DM-2337)", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 1700 }, deviceScaleFactor: 1 });
    try {
      // RTL vertical multicol flows toward negative physical y. The top margin
      // keeps every fragment in the capture viewport without changing its
      // logical block/inline mapping.
      await page.setContent(`<style>body{margin:0}.cols{margin-top:700px;columns:3;column-fill:auto;width:180px;height:900px;writing-mode:vertical-rl;direction:rtl}.t{border-collapse:collapse;writing-mode:vertical-rl;direction:rtl}.t td{box-sizing:border-box;width:46px;height:38px;border:4px solid rgb(0,0,255);padding:0}.t .accent{border-block-start:8px dashed rgb(220,0,0)}</style><div class="cols"><table class="t"><tbody>${Array.from({ length: 20 }, (_, i) => `<tr><td class="${i === 8 ? "accent" : ""}">${i}</td></tr>`).join("")}</tbody></table></div>`, { waitUntil: "load" });
      const fragments = await page.evaluate(() => {
        const serial = (element: Element) => Array.from(element.getClientRects(), (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
        return { table: serial(document.querySelector("table")!), section: serial(document.querySelector("tbody")!) };
      });
      expect(fragments.table.length).toBeGreaterThan(1);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 1700 });
      const table = find(tree, (n) => n.tag === "table")!;
      const rects = (table.styles as any).collapsedBorderRects as Array<any>;
      for (const fragment of fragments.section) {
        expect(rects.some((rect) => rect.x < fragment.right && rect.x + rect.width > fragment.left
          && rect.y < fragment.bottom && rect.y + rect.height > fragment.top)).toBe(true);
      }
      expect(rects.some((rect) => rect.axis === "row" && rect.width === 8
        && rect.style === "dashed" && rect.color === "rgb(220, 0, 0)")).toBe(true);
    } finally { await page.close(); }
  }, 60_000);
});
