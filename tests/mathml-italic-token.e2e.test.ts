import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import {
  getTextRunProvenance,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
afterEach(() => {
  setTextRunProvenanceEnabled(false);
  setRenderTextMode("embedded-font");
});
const describeBrowser = env ? describe : describe.skip;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

const cp = (text: string) => text.codePointAt(0)!;
const italicCorrectionFont = readFileSync(new URL("./fixtures/fonts/largeop-italic-correction.woff.base64", import.meta.url), "utf8").trim();

describeBrowser("DM-2441: MathML italic-token logical oracle", () => {
  it("joins Blink math-auto geometry and face identity to helper shaping evidence", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 720, height: 320 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>
        @font-face { font-family: ItalicCorrectionMath; src: url(data:font/woff;base64,${italicCorrectionFont}) format("woff"); }
        body { margin: 20px; }
        math { font-size: 32px; margin-right: 28px; }
        #script-base { font-family: ItalicCorrectionMath; }
      </style>
      <math><mi id="ascii" data-domotion-anim="ascii">a</mi></math>
      <math><mi id="greek" data-domotion-anim="greek">α</mi></math>
      <math><mi id="exceptional-h" data-domotion-anim="exceptional-h">h</mi></math>
      <math><mi id="supplementary" data-domotion-anim="supplementary">𝑎</mi></math>
      <math><mi id="normal" data-domotion-anim="normal" mathvariant="normal">a</mi></math>
      <math><mi id="css-italic" data-domotion-anim="css-italic" style="font-style:italic">b</mi></math>
      <div>
        <math display="block"><msubsup><mo id="script-base" largeop="true" movablelimits="false">⫿</mo><mi id="sub-script">x</mi><mi id="sup-script" data-domotion-anim="sup-script">x</mi></msubsup></math>
      </div>`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);

      const sourceRows = await page.evaluate(() => {
        const ids = ["ascii", "greek", "exceptional-h", "supplementary", "normal", "css-italic", "sup-script"];
        const geometry = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const r = range.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, textTransform: cs.textTransform, fontStyle: cs.fontStyle };
        };
        return Object.fromEntries(ids.map((id) => {
          const el = document.getElementById(id)!;
          return [id, { source: el.textContent!, ...geometry(el) }];
        }).concat([["script-control", {
          base: geometry(document.getElementById("script-base")!),
          sup: geometry(document.getElementById("sup-script")!),
          sub: geometry(document.getElementById("sub-script")!),
        }]]));
      }) as Record<string, any>;

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const cdpFaces: Record<string, string> = {};
      for (const id of ["ascii", "greek", "exceptional-h", "supplementary", "normal", "css-italic", "sup-script"]) {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        cdpFaces[id] = fonts[0]?.postScriptName ?? "";
      }

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 720, height: 320 });
      const expected: Record<string, string> = {
        ascii: "𝑎", greek: "𝛼", "exceptional-h": "ℎ", supplementary: "𝑎",
        normal: "a", "css-italic": "𝑏", "sup-script": "𝑥",
      };
      for (const [id, transformed] of Object.entries(expected)) {
        const node = byAnimId(tree, id)!;
        expect(node, id).not.toBeNull();
        expect(cp(sourceRows[id].source)).toBeGreaterThan(0);
        expect(node.styles.textTransform).toBe(sourceRows[id].textTransform);
        expect(node.text.trim()).toBe(transformed);
        expect(node.textLeft).toBeCloseTo(sourceRows[id].left, 5);
        expect(node.textTop).toBeCloseTo(sourceRows[id].top, 5);
        expect(cdpFaces[id], id).not.toBe("");

        resetTextRunProvenance();
        setTextRunProvenanceEnabled(true);
        setRenderTextMode("paths");
        elementTreeToSvgInner([node], 720, 320);
        const runs = getTextRunProvenance().runs.filter((run) => run.sourceText === transformed);
        expect(runs, id).toHaveLength(1);
        const run = runs[0]!;
        expect(run.selected.postscriptName, id).toBe(cdpFaces[id]);
        expect(run.glyphs, id).toHaveLength(1);
        expect(run.glyphs[0]!.id).toBeGreaterThan(0);
        expect(run.glyphs[0]!.xAdvance).toBeGreaterThan(0);
        expect(run.glyphs[0]!.xOffset).toBeTypeOf("number");
        expect(run.glyphs[0]!.yOffset).toBeTypeOf("number");
        expect(Math.round(node.textTop! + node.fontAscent!)).toBeGreaterThan(sourceRows[id].top);
      }

      expect(sourceRows.ascii.textTransform).toBe("math-auto");
      expect(sourceRows.normal.textTransform).toBe("none");
      expect(sourceRows["css-italic"].fontStyle).toBe("italic");
      expect(cp(sourceRows.supplementary.source)).toBe(0x1d44e);

      // Blink subtracts the base MATH italic correction from the subscript
      // offset while the superscript remains at the post-base origin. Equal
      // script strings make ordinary shaping/spacing a neutral control.
      const sc = sourceRows["script-control"];
      expect(sc.sup.left).toBeGreaterThan(sc.sub.left + 0.1);
    } finally {
      await page.close();
    }
  }, 60_000);
});
