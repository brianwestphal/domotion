import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const VIEW = { width: 500, height: 300 };

const PAGE_HTML = `<!doctype html><style>
  body { margin: 0; }
  select {
    position: absolute; left: 40px; width: 200px; height: 50px;
    font: 16px/24px Arial; padding: 8px 12px; border: 2px solid #789;
  }
  #native { top: 20px; }
  #base { top: 100px; }
  #none { top: 180px; appearance: none; }
  #base, #base::picker(select) { appearance: base-select; }
</style>
<select id="native"><option>United States</option></select>
<select id="base"><option>United States</option></select>
<select id="none"><option>United States</option></select>`;

const env = await (async () => {
  try {
    return { browser: await launchChromium({ headless: true, args: ["--enable-blink-features=AppearanceBase"] }) };
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

function selects(tree: CapturedElement[]): CapturedElement[] {
  const found: CapturedElement[] = [];
  const walk = (node: CapturedElement): void => {
    if (node.tag === "select") found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of tree) walk(node);
  return found;
}

describeBrowser("closed select display geometry", () => {
  it("captures the UA-shadow text cell for native, base-select, and appearance:none controls", async () => {
    const page = await env!.browser.newPage({ viewport: VIEW });
    try {
      await page.setContent(PAGE_HTML);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, ...VIEW });
      const captured = selects(tree);
      expect(captured).toHaveLength(3);

      for (const select of captured) {
        const geometry = select.styles.selectDisplayTextGeometry;
        expect(geometry, "the closed UA-shadow text range must be retained").toBeDefined();
        // The option glyph cell starts inside the host's border/padding box;
        // this is a live Blink layout fact, not the renderer's old centering
        // approximation. The base route has a distinct UA line box, so this
        // assertion intentionally exercises all three ownership routes.
        expect(geometry!.x).toBeGreaterThan(select.x);
        expect(geometry!.y).toBeGreaterThan(select.y);
        expect(geometry!.y).toBeLessThan(select.y + select.height);
        expect(geometry!.fontAscent).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
