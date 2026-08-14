import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-2162: replaced-element sizing is owned by Blink layout. Capture carries
// getBoundingClientRect()'s used border-box through to paintImage; the renderer
// must not recompute flex/grid sizing from the source's intrinsic dimensions.
// Chromium rev 7d859f27 keeps the two concepts separate too:
// `layout_replaced.cc:422-497` computes object-fit inside the already-used
// PhysicalContentBoxRect, and `image_painter.cc:140` paints that result.
const W = 520;
const H = 280;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const SVG = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="red"/></svg>`,
);
const HTML = `<!doctype html><style>
  * { box-sizing: border-box }
  body { margin: 0 }
  #flex { display: flex; gap: 10px; width: 520px; height: 120px }
  #flex img { flex: none; height: 120px; object-fit: cover }
  #one { aspect-ratio: 1 }
  #two { aspect-ratio: 2 / 1 }
  #grid { margin-top: 40px; display: grid; grid-template-columns: 220px; grid-template-rows: 90px }
  #grid img { width: 100%; height: 100%; object-fit: cover }
</style><div id="flex"><img id="one" src="${PNG}"><img id="two" src="${PNG}"></div>
<div id="grid"><img id="grid-img" src="${SVG}"></div>`;

function images(nodes: CapturedElement[]): CapturedElement[] {
  const out: CapturedElement[] = [];
  const walk = (items: CapturedElement[]): void => {
    for (const item of items) {
      if (item.tag === "img") out.push(item);
      walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

async function setup(): Promise<{ browser: Awaited<ReturnType<typeof launchChromium>> } | null> {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-2162: replaced elements retain Blink's flex/grid used size", () => {
  it("passes the captured used boxes unchanged to raster and inline-SVG paint", async () => {
    const page = await env!.browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const captured = images(tree);

      expect(captured).toHaveLength(3);
      expect(captured.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
        { x: 0, y: 0, width: 120, height: 120 },
        { x: 130, y: 0, width: 240, height: 120 },
        { x: 0, y: 160, width: 220, height: 90 },
      ]);

      const output = elementTreeToSvgInner(tree, W, H);
      expect(output).toMatch(/<image\b[^>]*x="0" y="0" width="120" height="120"/);
      expect(output).toMatch(/<image\b[^>]*x="130" y="0" width="240" height="120"/);
      expect(output).toMatch(/<svg\b[^>]*x="0" y="160" width="220" height="90"/);
    } finally {
      await page.close();
    }
  });
});
