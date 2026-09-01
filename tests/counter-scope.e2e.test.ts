import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

function segmentTexts(nodes: CapturedElement[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    for (const seg of node.textSegments ?? []) out.push(seg.text);
    for (const record of node.pseudoFragments ?? []) {
      const generated = record.contentItems
        .filter((item) => item.kind === "text")
        .map((item) => item.text ?? "")
        .join("");
      if (generated !== "") out.push(generated);
    }
    out.push(...segmentTexts(node.children));
  }
  return out;
}

async function setup(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await setup();
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser ? describe : describe.skip;

describeBrowser("DM-2157: CSS counter scope follows tree order", () => {
  it("carries counters across siblings and processes generated pseudos in order", async () => {
    const page = await browser!.newPage({ viewport: { width: 600, height: 220 } });
    try {
      await page.setContent(`<!doctype html><style>
        body { counter-reset: section }
        .item { counter-increment: section }
        .item::before { content: "B" counter(section) " "; }
        #pseudo::before { counter-increment: section; content: "P" counter(section) " "; }
        #pseudo::after { counter-increment: section; content: "A" counter(section); }
        #nested { counter-reset: section 8 }
        #nested::before { content: "N" counters(section, ".") " "; }
      </style><div class="item">one</div><div class="item">two</div>
      <div id="pseudo">middle</div><div id="nested">nested</div><div class="item">three</div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 600, height: 220 });
      const text = segmentTexts(tree).join("|");
      expect(text).toContain("B1 ");
      expect(text).toContain("B2 ");
      expect(text).toContain("P3 ");
      expect(text).toContain("A4");
      expect(text).toContain("N4.8 ");
      expect(text).toContain("B5 ");
    } finally { await page.close(); }
  });
});
