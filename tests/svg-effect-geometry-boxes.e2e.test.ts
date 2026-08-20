import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function svgMarkup(nodes: CapturedElement[]): string[] {
  return nodes.flatMap((node) => [node.svgContent, ...svgMarkup(node.children)].filter((value): value is string => value != null));
}

describeBrowser("SVG effect geometry-box capture (DM-2328)", () => {
  it("bakes stylesheet-owned clip and mask geometry declarations onto cloned SVG children", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 500, height: 220 } });
    const page = await context.newPage();
    try {
      await page.setContent(`<style>
        .clipped { clip-path: circle(20% at 0% 50%) stroke-box }
        .masked { mask-image: linear-gradient(black,transparent); mask-origin: fill-box; mask-clip: stroke-box; mask-size: 50% 100%; mask-repeat: no-repeat }
      </style><svg width="400" height="160" viewBox="0 0 400 160"><rect class="clipped" x="60" y="30" width="80" height="40" fill="blue" stroke="red" stroke-width="20"/><rect class="masked" x="220" y="30" width="80" height="40" fill="green" stroke="black" stroke-width="20"/></svg>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 500, height: 220 });
      const [markup] = svgMarkup(tree);
      expect(markup).toContain("clip-path: circle(20% at 0% 50%) stroke-box");
      // CSSOM may coalesce the longhands into the `mask` shorthand when the
      // cloned outerHTML serializes its style declaration.
      expect(markup).toContain("mask: linear-gradient(");
      expect(markup).toContain("/ 50% 100% no-repeat fill-box stroke-box");
    } finally {
      await context.close();
    }
  }, 60_000);
});
