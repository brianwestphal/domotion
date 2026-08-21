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

const HTML = `<!doctype html><style>
  #css-wins { cx: 42px; cy: 24px; r: 11px }
  #vars { --ex: 54px; cx: calc(var(--ex) + 2px); rx: 9px; ry: 6px }
  #path-wins { d: path("M 8 70 L 48 70 L 28 92 Z") }
  #invalid { r: -4px }
  line { x: 99px; y: 88px; width: 77px; height: 66px }
</style><svg id="subject" width="120" height="110" viewBox="0 0 120 110">
  <circle id="attr-only" cx="10%" cy="12" r="7"/>
  <circle id="css-wins" cx="2" cy="3" r="4"/>
  <rect id="inline-wins" x="1" y="2" width="3" height="4" style="x:20px!important;y:30px;width:15px;height:10px"/>
  <ellipse id="vars" cx="3" cy="52" rx="2" ry="2"/>
  <path id="path-wins" d="M 1 70 L 3 70"/>
  <circle id="invalid" cx="82" cy="22" r="8"/>
  <line id="inapplicable" x1="4" y1="102" x2="80" y2="102"/>
  <circle id="animated" cx="96" cy="72" r="5"><animate attributeName="cx" values="96;106;96" dur="10s"/></circle>
</svg>`;

describeBrowser("inline SVG computed geometry capture (DM-2414)", () => {
  it("bakes the computed CSS winner while preserving authored and animated ownership", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 160, height: 130 } });
    const source = await context.newPage();
    const rendered = await context.newPage();
    try {
      await source.setContent(HTML);
      const metrics = await source.locator("#subject").evaluate((svg) => {
        const ids = ["attr-only", "css-wins", "inline-wins", "vars", "path-wins", "invalid"];
        return Object.fromEntries(ids.map((id) => {
          const el = svg.querySelector(`#${id}`)! as SVGGraphicsElement;
          const b = el.getBBox();
          return [id, { x: b.x, y: b.y, width: b.width, height: b.height,
            length: el instanceof SVGPathElement ? el.getTotalLength() : null }];
        }));
      });
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 160, height: 130 });
      const [markup] = svgMarkup(tree);
      expect(markup).toBeTruthy();
      await rendered.setContent(markup!);
      const attrs = await rendered.locator("#subject").evaluate((svg) => {
        const read = (id: string) => Object.fromEntries([...svg.querySelector(`#${id}`)!.attributes].map((a) => [a.name, a.value]));
        return Object.fromEntries(["attr-only", "css-wins", "inline-wins", "vars", "path-wins", "invalid", "inapplicable", "animated"].map((id) => [id, read(id)]));
      });
      expect(attrs["attr-only"].cx).toBe("10%");
      expect(attrs["css-wins"]).toMatchObject({ cx: "42", cy: "24", r: "11" });
      expect(attrs["inline-wins"]).toMatchObject({ x: "20", y: "30", width: "15", height: "10" });
      expect(attrs.vars).toMatchObject({ cx: "56", rx: "9", ry: "6" });
      expect(attrs["path-wins"].d).toContain("M 8 70");
      expect(attrs.invalid.r).toBe("8");
      expect(attrs.inapplicable).not.toHaveProperty("x");
      expect(attrs.inapplicable).not.toHaveProperty("width");
      expect(attrs.animated.cx).toBe("96");
      expect(markup).toContain('attributeName="cx"');

      const capturedMetrics = await rendered.locator("#subject").evaluate((svg) => {
        const ids = ["attr-only", "css-wins", "inline-wins", "vars", "path-wins", "invalid"];
        return Object.fromEntries(ids.map((id) => {
          const el = svg.querySelector(`#${id}`)! as SVGGraphicsElement;
          const b = el.getBBox();
          return [id, { x: b.x, y: b.y, width: b.width, height: b.height,
            length: el instanceof SVGPathElement ? el.getTotalLength() : null }];
        }));
      });
      expect(capturedMetrics).toEqual(metrics);
    } finally {
      await context.close();
    }
  }, 60_000);
});
