import { chromium } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";

const sizes = [12, 16, 22, 30, 40, 50, 60];
const styles = ["normal", "compact"] as const;
const viewport = { width: 560, height: 760 };

function find(nodes: CapturedElement[], key: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.magicKey === key) return node;
    const child = find(node.children ?? [], key);
    if (child != null) return child;
  }
  return null;
}

function barRows(pixels: Uint8Array, imageWidth: number, right: number, radicalTop: number, baseTop: number): number[] {
  const end = Math.floor(right) - 2;
  const start = end - 15;
  const rows: number[] = [];
  for (let y = Math.floor(radicalTop) - 2; y < Math.ceil(baseTop); y++) {
    let dark = 0;
    for (let x = start; x <= end; x++) {
      const offset = (y * imageWidth + x) * 3;
      if (pixels[offset] < 192 && pixels[offset + 1] < 192 && pixels[offset + 2] < 192) dark++;
    }
    if (dark >= 12) rows.push(y);
  }
  return rows;
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
  "MathML radical positive rule paint on native fonts",
  () => {
    it("matches Chromium's fourteen math-generic bar-row routes, including small rules", async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
        const rows = styles.flatMap((style) =>
          sizes.map(
            (size) =>
              `<math display="block" style="font-family:math;font-size:${size}px;math-style:${style};margin:8px 0"><msqrt id="radical-${style}-${size}" data-magic-key="radical-${style}-${size}"><mi>x</mi><mo>+</mo><mi>y</mi></msqrt></math>`,
          ),
        );
        await page.setContent(
          `<!doctype html><style>html,body{margin:0;width:560px;height:760px;background:white;color:black}body{padding:16px;box-sizing:border-box}</style>${rows.join("")}`,
        );
        await page.evaluate(() => document.fonts.ready);
        const sourcePng = await page.screenshot();
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, ...viewport });
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="760" viewBox="0 0 560 760">${elementTreeToSvgInner(tree, 560, 760)}</svg>`;
        const renderPage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
        await renderPage.setContent(`<!doctype html><style>html,body{margin:0;background:white}</style>${svg}`);
        await renderPage.evaluate(() => document.fonts.ready);
        const renderPng = await renderPage.screenshot();
        const [source, rendered] = await Promise.all(
          [sourcePng, renderPng].map((png) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })),
        );
        for (const style of styles) {
          for (const size of sizes) {
            const id = `radical-${style}-${size}`;
            const node = find(tree, id);
            expect(node, id).not.toBeNull();
            const geometry = await page.evaluate((key) => {
              const radical = document.getElementById(key)!;
              const children = Array.from(radical.children).map((child) => child.getBoundingClientRect());
              return {
                top: radical.getBoundingClientRect().top,
                baseTop: Math.min(...children.map((child) => child.top)),
                right: Math.max(...children.map((child) => child.right)),
              };
            }, id);
            const expected = barRows(source.data, source.info.width, geometry.right, geometry.top, geometry.baseTop);
            const actual = barRows(rendered.data, rendered.info.width, geometry.right, geometry.top, geometry.baseTop);
            if (style === "normal" && size === 16) expect(expected, id).toHaveLength(1);
            if (process.platform === "darwin" && style === "compact" && size === 12)
              expect(expected, id).toHaveLength(1);
            expect(actual, id).toEqual(expected);
          }
        }
      } finally {
        await browser.close();
      }
    }, 60_000);
  },
);
