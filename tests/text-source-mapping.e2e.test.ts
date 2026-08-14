import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

function find(nodes: CapturedElement[], text: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.text === text) return node;
    const child = find(node.children, text);
    if (child) return child;
  }
}

function findTag(nodes: CapturedElement[], tag: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const child = findTag(node.children, tag);
    if (child) return child;
  }
}

async function setup(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await setup();
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser ? describe : describe.skip;

describeBrowser("DM-2158: source spans survive rendered text changes", () => {
  it("captures expansion and locale casing without indexing past the DOM text", async () => {
    const page = await browser!.newPage({ viewport: { width: 600, height: 180 } });
    try {
      await page.setContent(`<!doctype html><style>body{margin:0;font:20px Arial}.up{text-transform:uppercase}#first::first-line{text-transform:uppercase}</style>
        <div id="de" class="up" lang="de">aßb</div><div id="tr" class="up" lang="tr">iı</div>
        <p id="first">straße stays</p><pre id="tabs" style="tab-size:4">a\tb</pre>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 600, height: 180 });
      const de = find(tree, "ASSB")!.textSegments![0];
      const tr = find(tree, "İI")!.textSegments![0];
      const first = find(tree, "straße stays")!.textSegments![0];
      const tabs = findTag(tree, "pre")!.textSegments!.find((seg) => seg.text.includes("a b"))!;
      expect(de.text).toBe("ASSB");
      expect(de.xOffsets).toBeUndefined();
      expect(tr.text).toBe("İI");
      expect(first.text).toBe("STRASSE STAYS");
      expect(first.xOffsets).toBeUndefined();
      expect(tabs.xOffsets![2] - tabs.xOffsets![0]).toBeGreaterThan(20);
    } finally { await page.close(); }
  });
});
