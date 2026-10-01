import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);

function findByKey(nodes: CapturedElement[], key: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.magicKey === key) return node;
    const child = findByKey(node.children ?? [], key);
    if (child != null) return child;
  }
  return null;
}

function barTop(node: CapturedElement): number {
  const markup = elementTreeToSvgInner([node], 900, 500);
  const bar = /<rect x="[-\d.]+" y="([-\d.]+)" width="[-\d.]+" height="[-\d.]+" fill=/.exec(markup);
  expect(bar, `${node.magicKey}: rendered radical bar`).not.toBeNull();
  return Number(bar![1]);
}

describe.skipIf(!env || !existsSync("/System/Library/Fonts/Supplemental/STIXTwoMath.otf"))(
  "MathML inherited math-style radical capture",
  () => {
    it("carries Chromium's nested and authored styles into the OpenType MATH gap selection", async () => {
      const page = await env!.browser.newPage({ viewport: { width: 900, height: 500 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(`<style>body{margin:20px}math{font-family:'STIX Two Math';font-size:40px}</style>
          <math display="block"><mrow><msqrt id="row" data-magic-key="row"><mi>x</mi></msqrt></mrow></math>
          <math display="block"><mfrac><mrow><msqrt id="fraction" data-magic-key="fraction"><mi>x</mi></msqrt></mrow><mi>y</mi></mfrac></math>
          <math display="block"><mrow style="math-style:compact"><msqrt id="override" data-magic-key="override"><mi>x</mi></msqrt></mrow></math>
          <math><mrow style="math-style:normal"><msqrt id="normal-override" data-magic-key="normal-override"><mi>x</mi></msqrt></mrow></math>`);
        await page.evaluate(() => document.fonts.ready);
        const ids = ["row", "fraction", "override", "normal-override"];
        const browserStyles = await page.evaluate(
          (keys) =>
            Object.fromEntries(keys.map((key) => [key, getComputedStyle(document.getElementById(key)!).mathStyle])),
          ids,
        );
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 900, height: 500 });
        const expected: Record<string, string> = {
          row: "normal",
          fraction: "compact",
          override: "compact",
          "normal-override": "normal",
        };
        for (const id of ids) {
          const node = findByKey(tree, id);
          expect(node, id).not.toBeNull();
          expect(browserStyles[id], `${id}: browser style`).toBe(expected[id]);
          expect(node!.styles.mathStyle, `${id}: captured style`).toBe(browserStyles[id]);
          const actual = barTop(node!);
          const opposite = structuredClone(node!);
          opposite.styles.mathStyle = node!.styles.mathStyle === "normal" ? "compact" : "normal";
          expect(barTop(opposite), `${id}: gap selection changes emitted bar`).not.toBe(actual);
        }
      } finally {
        await page.close();
      }
    });
  },
);
