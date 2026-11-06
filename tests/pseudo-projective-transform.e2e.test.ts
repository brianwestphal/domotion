import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

// A perspective transform on a generated pseudo paints a trapezoid that no SVG
// affine can express. It must become one Chromium-owned pseudo surface with a
// named warning; before, the record stayed "exact", the renderer refused its
// non-affine box quad, and the pseudo vanished as an empty group.
describe("projective generated pseudo", () => {
  it("retains one Chromium raster owner instead of an empty pseudo group", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 300, height: 200 } });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0}
        #scene{padding:1px}
        .b{position:relative;width:200px;height:120px;margin:30px;background:#ddd}
        .persp::before{content:'';position:absolute;left:40px;top:20px;width:120px;height:80px;background:#e33;
          transform:perspective(200px) rotateY(50deg)}
        .affine::before{content:'';position:absolute;left:40px;top:20px;width:40px;height:30px;background:#33e;
          transform:rotate(20deg)}
      </style><main id="scene"><div class="b persp"></div><div class="b affine"></div></main>`);
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 300, height: 200 });
      const records = flatten(result.tree).flatMap((element) => element.pseudoFragments ?? []);
      expect(records.map((record) => record.status)).toEqual(["terminal-raster", "exact"]);
      const projective = records[0];
      expect(projective.reason).toContain("not vector-paintable");
      expect(projective.terminalRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(
        result.warnings.filter(
          (warning) =>
            warning.feature === "generated-pseudo-fragment-geometry" && warning.detail.includes("not vector-paintable"),
        ),
      ).toHaveLength(1);

      const svg = elementTreeToSvg(result.tree, 300, 200);
      expect(svg).not.toContain("data-domotion-pseudo-boundary");
      expect(svg.match(/data-domotion-pseudo-owner="chromium-raster"/g)).toHaveLength(1);
      expect(svg).toContain('data-domotion-pseudo-owner="source-fragments"');
    } finally {
      await browser.close();
    }
  }, 60_000);
});
