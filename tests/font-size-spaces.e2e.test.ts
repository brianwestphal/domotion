import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function findText(nodes: CapturedElement[], text: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.text === text) return node;
    const child = findText(node.children ?? [], text);
    if (child != null) return child;
  }
  return null;
}

describeBrowser("DM-2446: logical, computed, and paint font sizes", () => {
  it("keeps zoom and transform in their correct size spaces", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 500, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>
        .sample { font: 400 13px Arial, sans-serif; position:absolute; left:20px }
        #zoom { top:20px; zoom:2 }
        #transform { top:100px; transform:scale(2); transform-origin:0 0 }
        #cancel { top:190px; zoom:2; transform:scale(.5); transform-origin:0 0 }
        #nestedZoomOuter { zoom:1.25 } #nestedZoom { zoom:1.6 }
        #nestedTransformOuter { transform:scale(1.25);transform-origin:0 0 } #nestedTransform { transform:scale(1.6);transform-origin:0 0 }
        #mixed { zoom:1.5;transform:scale(1.25);transform-origin:0 0 }
        #opticalNone { zoom:2;font-optical-sizing:none }
        #explicitOpsz { zoom:2;font-variation-settings:"opsz" 13 }
      </style><div id="zoom" class="sample">zoom</div><div id="transform" class="sample">transform</div><div id="cancel" class="sample">cancel</div>
      <div id="nestedZoomOuter"><div id="nestedZoom" class="sample">nested-zoom</div></div>
      <div id="nestedTransformOuter"><div id="nestedTransform" class="sample">nested-transform</div></div>
      <div id="mixed" class="sample">mixed</div><div id="opticalNone" class="sample">optical-none</div><div id="explicitOpsz" class="sample">explicit-opsz</div>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 500, height: 300 });
      const zoom = findText(tree, "zoom")!;
      const transform = findText(tree, "transform")!;
      const cancel = findText(tree, "cancel")!;
      const nestedZoom = findText(tree, "nested-zoom")!;
      const nestedTransform = findText(tree, "nested-transform")!;
      const mixed = findText(tree, "mixed")!;
      const opticalNone = findText(tree, "optical-none")!;
      const explicitOpsz = findText(tree, "explicit-opsz")!;

      expect([zoom.styles.fontLogicalSize, zoom.styles.fontComputedSize, zoom.styles.fontSize]).toEqual(["13px", "26.0000px", "26.0000px"]);
      expect([transform.styles.fontLogicalSize, transform.styles.fontComputedSize, transform.styles.fontSize]).toEqual(["13px", "13.0000px", "26.0000px"]);
      expect([cancel.styles.fontLogicalSize, cancel.styles.fontComputedSize, cancel.styles.fontSize]).toEqual(["13px", "26.0000px", "13px"]);
      expect([nestedZoom.styles.fontLogicalSize, nestedZoom.styles.fontComputedSize, nestedZoom.styles.fontSize]).toEqual(["13px", "26.0000px", "26.0000px"]);
      expect([nestedTransform.styles.fontLogicalSize, nestedTransform.styles.fontComputedSize, nestedTransform.styles.fontSize]).toEqual(["13px", "13.0000px", "26.0000px"]);
      expect([mixed.styles.fontLogicalSize, mixed.styles.fontComputedSize, mixed.styles.fontSize]).toEqual(["13px", "19.5000px", "24.3750px"]);
      expect(opticalNone.styles.fontOpticalSizing).toBe("none");
      expect(explicitOpsz.styles.fontVariationSettings).toMatch(/"opsz" 13/);

      const metrics = await page.evaluate(() => {
        const at = (size: number) => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `400 ${size}px Arial, sans-serif`;
          const m = ctx.measureText("Mxgp");
          return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
        };
        return { logical: at(13), mixed: at(19.5), computed: at(26) };
      });
      const ranges = await page.evaluate(() => Object.fromEntries([
        "zoom", "transform", "cancel", "nestedZoom", "nestedTransform", "mixed",
      ].map((id) => {
        const el = document.getElementById(id)!;
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        return [id, { left: rect.left, top: rect.top }];
      })) as Record<string, { left: number; top: number }>);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const paintedFaces: Record<string, string> = {};
      for (const id of ["zoom", "opticalNone", "explicitOpsz"]) {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        paintedFaces[id] = fonts[0]?.postScriptName ?? "";
      }
      expect(paintedFaces.zoom).not.toBe("");
      expect(paintedFaces.opticalNone).toBe(paintedFaces.zoom);
      expect(paintedFaces.explicitOpsz).toBe(paintedFaces.zoom);
      expect(zoom.fontAscent).toBe(metrics.computed.ascent);
      expect(zoom.fontDescent).toBe(metrics.computed.descent);
      expect(transform.fontAscent).toBe(metrics.logical.ascent * 2);
      expect(transform.fontDescent).toBe(metrics.logical.descent * 2);
      expect(cancel.fontAscent).toBe(metrics.computed.ascent * 0.5);
      expect(cancel.fontDescent).toBe(metrics.computed.descent * 0.5);
      expect(nestedZoom.fontAscent).toBe(metrics.computed.ascent);
      expect(nestedTransform.fontAscent).toBe(metrics.logical.ascent * 2);
      const baselineAscents: Record<string, number> = {
        zoom: metrics.computed.ascent,
        transform: metrics.logical.ascent * 2,
        cancel: metrics.computed.ascent * 0.5,
        nestedZoom: metrics.computed.ascent,
        nestedTransform: metrics.logical.ascent * 2,
        mixed: metrics.mixed.ascent * 1.25,
      };
      for (const [id, node] of Object.entries({ zoom, transform, cancel, nestedZoom, nestedTransform, mixed })) {
        expect(node.textLeft).toBeCloseTo(ranges[id].left, 6);
        expect(node.textTop).toBeCloseTo(ranges[id].top, 6);
        if (node.textSegments?.[0].xOffsets?.[0] != null) {
          expect(node.textSegments[0].xOffsets[0]).toBeCloseTo(ranges[id].left, 6);
        }
        expect(node.textTop! + node.fontAscent!).toBeCloseTo(ranges[id].top + baselineAscents[id], 6);
      }
      setRenderTextMode("paths");
      const svg = elementTreeToSvgInner(tree, 500, 300);
      const outlineScale = (label: string) => {
        const match = new RegExp(`aria-label="${label}"[\\s\\S]*?scale\\(([-0-9.]+),`).exec(svg);
        expect(match, label).not.toBeNull();
        return Math.abs(parseFloat(match![1]));
      };
      expect(outlineScale("zoom") / outlineScale("cancel")).toBeCloseTo(2, 3);
      expect(outlineScale("transform")).toBeCloseTo(outlineScale("zoom"), 5);
      expect(outlineScale("mixed") / outlineScale("cancel")).toBeCloseTo(1.875, 2);
    } finally {
      setRenderTextMode("embedded-font");
      await page.close();
    }
  }, 60_000);
});
