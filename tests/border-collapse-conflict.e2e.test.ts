import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1260: CSS 2.1 §17.6.2.1 collapsed-border conflict resolution. Each grid edge
// paints the SINGLE winning border (hidden suppresses; else widest wins; tie →
// style rank; true tie → cell > row > col > table, earlier cell first), and the
// table / row / column-group box borders are folded into the cells (their own box
// borders suppressed). The capture resolves this onto the cell sides; assert the
// resolved widths/styles/colors + structural suppression.

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

      // The A|B shared edge: B's 8px red wins over A's 2px blue (width). A paints
      // its RIGHT edge as the winner (8px red); B suppresses its LEFT (A owns it).
      expect(cellA!.styles!.borderRightWidth).toBe("8px");
      expect(cellA!.styles!.borderRightStyle).toBe("solid");
      expect(cellA!.styles!.borderRightColor).toContain("255, 0, 0");
      expect(parseFloat(cellB!.styles!.borderLeftWidth ?? "0")).toBe(0);

      // A's outer LEFT edge: the table's 6px green border WINS over A's 2px blue
      // (width), so the cell paints the table's border there — demonstrating the
      // structural border folded into the cell edge rather than drawn as a box.
      expect(cellA!.styles!.borderLeftWidth).toBe("6px");
      expect(cellA!.styles!.borderLeftColor).toContain("0, 128, 0");

      // The table's own box border is suppressed (folded into the cell edges).
      expect(parseFloat(table!.styles!.borderTopWidth ?? "0")).toBe(0);
      expect(table!.styles!.borderTopStyle).toBe("none");
    } finally {
      await page.close();
    }
  }, 60_000);
});
