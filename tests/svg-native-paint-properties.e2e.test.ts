import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvg,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function inlineSvg(nodes: readonly CapturedElement[]): string | null {
  for (const node of nodes) {
    if (node.svgContent != null) return node.svgContent;
    const nested = inlineSvg(node.children ?? []);
    if (nested != null) return nested;
  }
  return null;
}

describeBrowser("stylesheet-owned native SVG paint properties (DM-2358)", () => {
  it("bakes markers, non-scaling stroke, and gradient interpolation without taking geometry ownership", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 400, height: 220 } });
    const page = await context.newPage();
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        .gradient{color-interpolation:linearRGB}
        .edge{marker-start:none;marker-mid:none;marker-end:url(#arrow);vector-effect:non-scaling-stroke}
      </style><svg width="320" height="160" viewBox="0 0 320 160">
        <defs>
          <linearGradient id="gradient" class="gradient" color-interpolation="sRGB"><stop stop-color="#f20"/><stop offset="1" stop-color="#04e"/></linearGradient>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#172554"/></marker>
        </defs>
        <path class="edge" marker-end="none" d="M30 80L270 80" fill="none" stroke="url(#gradient)" stroke-width="8" transform="scale(1.15 .8)"/>
      </svg>`);
      const computed = await page.locator(".edge").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          markerEnd: style.getPropertyValue("marker-end"),
          vectorEffect: style.getPropertyValue("vector-effect"),
        };
      });
      expect(computed.markerEnd).toMatch(/^url\(["']?#arrow["']?\)$/);
      expect(computed.vectorEffect).toBe("non-scaling-stroke");

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 220 });
      const markup = inlineSvg(tree);
      expect(markup).not.toBeNull();
      expect(markup).toContain("color-interpolation: linearrgb");
      expect(markup).toMatch(/marker-end: url\((?:&quot;)?#arrow(?:&quot;)?\)/);
      expect(markup).toContain("vector-effect: non-scaling-stroke");

      const output = elementTreeToSvg(tree, 400, 220);
      expect(output).not.toMatch(/marker-end: url\((?:&quot;)?#arrow(?:&quot;)?\)/);
      expect(output).toMatch(/marker-end: url\((?:&quot;)?#[^;)]+arrow(?:&quot;)?\)/);
      expect(output).toContain("vector-effect: non-scaling-stroke");
      expect(output).toContain("color-interpolation: linearrgb");
      expect(output).not.toContain("<image");
    } finally {
      await context.close();
    }
  }, 60_000);
});
