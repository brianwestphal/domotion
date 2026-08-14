import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
  type TextSegment,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-2161: Blink's LayoutNG fragment tree is already exposed by CSSOM
// geometry. Range.getClientRects() reports physical text fragments after
// forced column breaks, avoided breaks, and spanner-created column groups.
// Capture must preserve those physical coordinates; Node must not reconstruct
// multicol flow from the union element box.
const W = 700;
const H = 420;
const HTML = `<!doctype html><style>
  * { box-sizing: border-box }
  body { margin: 0; font: 16px/20px Arial, sans-serif }
  p { margin: 0 }
  #forced { width: 600px; height: 120px; columns: 3; column-gap: 30px; column-fill: auto }
  #forced .break { break-before: column }
  #avoid { margin-top: 20px; width: 600px; height: 80px; columns: 2; column-gap: 20px; column-fill: auto }
  #avoid .lead { height: 60px }
  #avoid .keep { height: 40px; break-inside: avoid }
  #spanned { margin-top: 20px; width: 600px; columns: 2; column-gap: 20px }
  #spanned .span { column-span: all; height: 30px }
</style>
<div id="forced"><p id="first">first-column</p><p id="second" class="break">second-column</p><p id="third" class="break">third-column</p></div>
<div id="avoid"><p class="lead">lead-fragment</p><p id="kept" class="keep">kept-fragment</p></div>
<div id="spanned"><p id="before">before-spanner</p><div class="span">full-width-spanner</div><p id="after">after-spanner</p></div>`;

interface Rect { x: number; y: number; width: number; height: number }

function findByText(nodes: CapturedElement[], text: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.text.trim() === text) return node;
    const child = findByText(node.children, text);
    if (child != null) return child;
  }
  return null;
}

function segmentRect(node: CapturedElement): Rect {
  const segment = node.textSegments?.find((s: TextSegment) => s.text.trim() === node.text.trim());
  if (segment == null) throw new Error(`missing text segment for ${node.text}`);
  return { x: segment.x, y: segment.y, width: segment.width, height: segment.height };
}

async function setup(): Promise<{ browser: Awaited<ReturnType<typeof launchChromium>> } | null> {
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-2161: multicol text keeps LayoutNG physical fragment coordinates", () => {
  it("preserves forced breaks, break-inside avoidance, and post-spanner flow", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const ids = ["first", "second", "third", "kept", "before", "after"];
      const chrome = await page.evaluate((wanted) => Object.fromEntries(wanted.map((id) => {
        const element = document.getElementById(id)!;
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = range.getClientRects()[0];
        return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
      })), ids) as Record<string, Rect>;

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const labels: Record<string, string> = {
        first: "first-column", second: "second-column", third: "third-column",
        kept: "kept-fragment", before: "before-spanner", after: "after-spanner",
      };
      for (const id of ids) {
        const captured = findByText(tree, labels[id]);
        expect(captured, id).not.toBeNull();
        const actual = segmentRect(captured!);
        expect(actual.x, `${id} x`).toBeCloseTo(chrome[id].x, 4);
        expect(actual.y, `${id} y`).toBeCloseTo(chrome[id].y, 4);
        expect(actual.width, `${id} width`).toBeCloseTo(chrome[id].width, 4);
        expect(actual.height, `${id} height`).toBeCloseTo(chrome[id].height, 4);
      }

      expect(chrome.second.x).toBeGreaterThan(chrome.first.x + 150);
      expect(chrome.third.x).toBeGreaterThan(chrome.second.x + 150);
      expect(chrome.kept.x).toBeGreaterThan(250);
      expect(chrome.after.x).toBe(chrome.before.x);
      expect(chrome.after.y).toBeGreaterThan(chrome.before.y);

      // The renderer consumes the captured physical x/y values directly. Its
      // embedded text x-list must therefore begin in each LayoutNG column,
      // rather than rebasing every fragment onto the union element origin.
      const output = elementTreeToSvgInner(tree, W, H);
      expect(output).toMatch(/aria-label="first-column"[\s\S]*?<text x="0(?:\s|\")/);
      expect(output).toMatch(/aria-label="second-column"[\s\S]*?<text x="210(?:\s|\")/);
      expect(output).toMatch(/aria-label="third-column"[\s\S]*?<text x="420(?:\s|\")/);
      expect(output).toMatch(/aria-label="kept-fragment"[\s\S]*?<text x="310(?:\s|\")/);
    } finally {
      await page.close();
    }
  });
});
