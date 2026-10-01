import { afterAll, describe, expect, it } from "vitest";
import {
  resetGeneration,
  getTextRunProvenance,
  resetTextRunProvenance,
  setTextRunProvenanceEnabled,
} from "@domotion/text-engine/testing";
import { launchChromium } from "../src/index.js";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-2619: focused production-pipeline coverage for the two platform findings
// from 32-real-world-multilingual-messages. The Arabic assertion catches the
// embedded emitter re-anchoring every connected glyph at a per-character Range
// rect; the code assertion compares the renderer's selected face to Chromium's
// own node-level paint report, so a Windows monospace run cannot silently drift
// to a different family and be dismissed as raster noise.

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-2619 multilingual message shaping", () => {
  it("keeps native advances inside the macOS Arabic cursive word", async () => {
    if (process.platform !== "darwin") return;
    const page = await env!.browser.newPage({ viewport: { width: 600, height: 180 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
        #message { font-size: 13px; line-height: 1.45; }
      </style><div id="message" dir="rtl" lang="ar">يظهر الآن بشكل صحيح.</div>`);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#message" });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      await cdp.detach();
      const painted = fonts.filter((font) => font.glyphCount > 0).sort((a, b) => b.glyphCount - a.glyphCount);
      expect(painted.length).toBeGreaterThan(0);
      expect(painted[0].glyphCount).toBeGreaterThan(painted[1]?.glyphCount ?? 0);
      const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 600, height: 180 });
      resetGeneration();
      resetTextRunProvenance();
      setRenderTextMode("embedded-font");
      setTextRunProvenanceEnabled(true);
      const svg = elementTreeToSvg(capture.tree, 600, 180);
      const evidence = getTextRunProvenance();

      const run = evidence.runs.find((candidate) => candidate.emittedText === "يظهر");
      expect(run).toBeDefined();
      expect(run!.request).toMatchObject({ script: "Arab", direction: "rtl", fontSizePx: 13 });
      expect(run!.selected).toMatchObject({ postscriptName: painted[0].postScriptName, shapesWithHarfbuzz: true });
      const baseGlyphIndices = run!.glyphs.flatMap((glyph, index) => (glyph.xAdvance > 0 ? [index] : []));
      expect(baseGlyphIndices.map((index) => run!.glyphs[index].cluster)).toEqual([3, 2, 1, 0]);

      const group = /<g role="img" aria-label="يظهر الآن بشكل صحيح\.">(.*?)<\/g>/s.exec(svg)?.[1];
      expect(group).toBeDefined();
      const firstXList = /<text x="([^"]+)"/.exec(group!)?.[1].split(/\s+/).map(Number);
      expect(firstXList).toHaveLength(run!.glyphs.length);

      // The exact em size and mark count are font-version-owned. For base
      // glyphs, each emitted pen delta must use one common scale times the
      // preceding shaped advance. Zero-advance marks carry their own offsets.
      const advanceScales = baseGlyphIndices.slice(1).map((index, position) => {
        const previous = baseGlyphIndices[position];
        return (firstXList![index] - firstXList![previous]) / run!.glyphs[previous].xAdvance;
      });
      expect(Math.max(...advanceScales) - Math.min(...advanceScales)).toBeLessThan(0.0001);
    } finally {
      setTextRunProvenanceEnabled(false);
      setRenderTextMode("paths");
      await page.close();
    }
  }, 60_000);

  it.runIf(process.platform === "win32")(
    "selects the same Windows message code face Chromium paints",
    async () => {
      const page = await env!.browser.newPage({ viewport: { width: 360, height: 120 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; font-size: 13px; }
        code { font: .92em ui-monospace, SFMono-Regular, Menlo, monospace; }
      </style><div lang="ja"><code id="code">header-v3</code></div>`);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#code" });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        await cdp.detach();
        const painted = fonts.filter((font) => font.glyphCount > 0);
        expect(painted).toHaveLength(1);

        const capture = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 360, height: 120 });
        const flatten = (nodes: CapturedElement[]): CapturedElement[] =>
          nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
        const capturedCode = flatten(capture.tree)
          .flatMap((node) => node.textSegments ?? [])
          .find((segment) => segment.text === "header-v3");
        expect(capturedCode?.xOffsets).toHaveLength(9);
        resetGeneration();
        resetTextRunProvenance();
        setRenderTextMode("embedded-font");
        setTextRunProvenanceEnabled(true);
        const svg = elementTreeToSvg(capture.tree, 360, 120);
        const run = getTextRunProvenance().runs.find((candidate) => candidate.emittedText === "header-v3");
        expect(run).toBeDefined();
        expect(run!.selected.postscriptName).toBe(painted[0].postScriptName);
        expect(run!.selected.sourcePath).toEqual(expect.any(String));
        expect(run!.glyphs).toHaveLength(9);
        expect(run!.glyphs.map((glyph) => glyph.cluster)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        expect(run!.glyphs.every((glyph) => glyph.xAdvance > 0)).toBe(true);

        const group = /<g role="img" aria-label="header-v3">(.*?)<\/g>/s.exec(svg)?.[1];
        const emittedX = /<text x="([^"]+)"/
          .exec(group ?? "")?.[1]
          .split(/\s+/)
          .map(Number);
        const roundedCapturedX = capturedCode!.xOffsets!.map((value) => Math.round(value * 100) / 100);
        expect(emittedX).toEqual(roundedCapturedX);
      } finally {
        setTextRunProvenanceEnabled(false);
        setRenderTextMode("paths");
        await page.close();
      }
    },
    60_000,
  );
});
