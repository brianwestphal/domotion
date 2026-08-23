import { afterAll, describe, expect, it } from "vitest";

import type { CapturedElement } from "../src/capture/types.js";
import { captureElementTree, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import {
  compareBars,
  decorationOracleScalePlan,
  parseSvgDecorations,
  predictCase,
  svgBarsInWindow,
  type CaseSpec,
  type PageMeasure,
} from "../tools/decoration-oracle.js";

function flatten(elements: readonly CapturedElement[]): CapturedElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("DM-2501 decoration physical-fragment coordinate ownership", () => {
  for (const dpr of [1, 4]) {
    it(`captures and grades one coherent Blink paint state at DPR ${dpr}`, async () => {
      const plan = decorationOracleScalePlan(dpr);
      const context = await env!.browser.newContext({
        viewport: { width: 900, height: 520 },
        deviceScaleFactor: plan.domotionCapture,
      });
      const page = await context.newPage();
      try {
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head>
          <body style="margin:0;background:#fff">
            <div style="margin:120px 24px">
              <span id="target" style="font-family:Helvetica;font-size:12px;color:#000;
                text-decoration-line:underline;text-decoration-style:solid;
                text-decoration-color:#ff0000;text-decoration-skip-ink:none;white-space:pre">nommix unread</span>
            </div>
            <div style="height:220px"></div>
          </body></html>`);
        const measure = await page.evaluate(() => {
          const target = document.querySelector<HTMLElement>("#target")!;
          const rect = target.getClientRects()[0];
          const cs = getComputedStyle(target);
          const context = document.createElement("canvas").getContext("2d")!;
          context.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const metrics = context.measureText("x");
          return {
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            baselineY: rect.y + metrics.fontBoundingBoxAscent,
            ascF: metrics.fontBoundingBoxAscent,
            descF: metrics.fontBoundingBoxDescent,
            fragments: target.getClientRects().length,
            effectiveFontSize: Number.parseFloat(cs.fontSize) * (Number.parseFloat(cs.zoom) || 1),
          } satisfies PageMeasure;
        });

        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 900, height: 520 });
        const target = flatten(tree).find((element) => element.styles.textDecorationLine === "underline");
        expect(target).toBeDefined();
        expect(target!.textSegments).toHaveLength(1);
        expect(target!.textSegments![0].y).toBe(measure.rect.y);
        expect(target!.fontAscent).toBe(measure.ascF);

        const spec: CaseSpec = {
          id: "dm2501", family: "Helvetica", fontSize: 12,
          lines: "underline", style: "solid",
        };
        const predicted = predictCase(spec, measure).bars;
        const parsed = parseSvgDecorations(elementTreeToSvgInner(tree, 900, 520));
        const emitted = svgBarsInWindow(parsed, { top: 0, bottom: 520 });
        expect(compareBars(predicted, emitted, 0.3, "rule", "svg")).toMatchObject({ ok: true });
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
