import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HTML = `<!doctype html><style>
  body { margin: 0; }
  #scroller {
    display: flex; overflow-x: auto; width: 320px;
    scroll-marker-group: before;
  }
  #scroller > div { flex: 0 0 300px; }
  #scroller > div::scroll-marker {
    content: attr(data-label);
    padding: 4px 12px;
    margin: 4px;
    font: 600 12px/normal Arial;
    background: rgb(30, 41, 59);
  }
  #scroller::scroll-marker-group {
    display: flex; justify-content: center; gap: 6px; padding: 12px;
  }
</style><div id="scroller"><div data-label="Alpha"></div><div data-label="Beta"></div></div>`;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function nodesWithText(tree: CapturedElement[], text: string): CapturedElement[] {
  const matches: CapturedElement[] = [];
  const visit = (nodes: CapturedElement[]): void => {
    for (const node of nodes) {
      if (node.textSegments?.some((segment) => segment.text === text)) matches.push(node);
      if (node.children) visit(node.children as CapturedElement[]);
      const markerGroup = (node as CapturedElement & { scrollMarkerGroup?: CapturedElement }).scrollMarkerGroup;
      if (markerGroup) visit([markerGroup]);
    }
  };
  visit(tree);
  return matches;
}

describeBrowser("scroll-marker inline layout", () => {
  it("does not turn group gap or inline padding into flex-item width", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 400, height: 180 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const textWidths = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        context.font = "600 12px Arial";
        return [context.measureText("Alpha").width, context.measureText("Beta").width];
      });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 180 });
      const alpha = nodesWithText(tree, "Alpha").at(-1);
      const beta = nodesWithText(tree, "Beta").at(-1);

      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha!.width).toBeCloseTo(textWidths[0], 1);
      expect(beta!.width).toBeCloseTo(textWidths[1], 1);
      expect(beta!.x - (alpha!.x + alpha!.width)).toBeCloseTo(8, 1);
    } finally {
      await page.close();
    }
  }, 60_000);
});
