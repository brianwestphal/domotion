import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

// Slider track and thumb box-shadows are captured from the real UA-shadow
// pseudo nodes and painted by the general box-shadow painters: an offset +
// blur drop shadow and an inset glow on both pseudos.
describe("range pseudo box-shadow", () => {
  it("captures the track and thumb shadow lists and paints offset, blur and inset", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 80 } });
    try {
      await page.setContent(`<!doctype html><style>body{margin:0}
        input{appearance:none;display:block;width:300px;height:32px;margin:16px 20px}
        input::-webkit-slider-runnable-track{height:12px;border-radius:6px;background:#e2e8f0;
          box-shadow:inset 0 2px 3px rgba(0,0,0,.45),0 3px 0 #94a3b8}
        input::-webkit-slider-thumb{appearance:none;width:24px;height:24px;margin-top:-6px;border-radius:50%;
          background:#2563eb;box-shadow:0 4px 6px rgba(0,0,0,.5),inset 0 -3px 3px rgba(0,0,0,.4)}
      </style><main id="scene"><input type="range" value="30"></main>`);
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 360, height: 80 });
      const input = flatten(result.tree).find((element) => element.tag === "input");
      expect(input?.styles.rangeTrackBoxShadow).toBe(
        "rgba(0, 0, 0, 0.45) 0px 2px 3px 0px inset, rgb(148, 163, 184) 0px 3px 0px 0px",
      );
      expect(input?.styles.rangeThumbBoxShadow).toBe(
        "rgba(0, 0, 0, 0.5) 0px 4px 6px 0px, rgba(0, 0, 0, 0.4) 0px -3px 3px 0px inset",
      );

      const svg = elementTreeToSvg(result.tree, 360, 80);
      // Track outer (solid offset) shadow, thumb outer blur, and two inset donuts.
      expect(svg).toContain('fill="rgb(148,163,184)"');
      expect(svg.match(/fill-rule="evenodd"/g)?.length).toBe(2);
      expect(svg).toMatch(/fill="rgba\(0,0,0,0\.5\)" filter="url\(#/);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
