import { afterAll, describe, expect, it } from "vitest";

import type { CapturedElement } from "../src/capture/types.js";
import { launchChromium } from "../src/index.js";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import { getRenderTextMode, renderTextAsPath, setRenderTextMode } from "../src/render/text-to-path.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const values = ["normal", "space-all", "trim-start"] as const;

function findByAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const descendant = findByAnimId(node.children ?? [], id);
    if (descendant != null) return descendant;
  }
  return null;
}

let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
if (process.platform === "darwin") {
  try {
    browser = await launchChromium();
  } catch {
    browser = null;
  }
}

afterAll(async () => {
  await closeBrowserSafely(browser ?? undefined);
}, 15_000);

const describeBrowser = browser != null ? describe : describe.skip;

describeBrowser("Han kerning through live CSS capture and path rendering (DM-WED9K9)", () => {
  it("retains the CSS trim value and derives adjacent opening punctuation ink positions", async () => {
    const page = await browser!.newPage({ viewport: { width: 400, height: 200 } });
    const previousMode = getRenderTextMode();
    try {
      await page.setContent(
        `<style>body{margin:0}div{font:16px Hiragino Sans;white-space:pre}</style>` +
          values
            .map(
              (value) =>
                `<div id="${value}" data-domotion-anim="${value}" lang="ja" style="text-spacing-trim:${value}">（「</div>`,
            )
            .join(""),
      );
      const computed = await page.evaluate(
        (ids) => ids.map((id) => getComputedStyle(document.getElementById(id)!).getPropertyValue("text-spacing-trim")),
        values,
      );
      expect(computed).toEqual(values);

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 200 });
      setRenderTextMode("paths");
      for (const value of values) {
        const captured = findByAnimId(tree, value);
        expect(captured, value).not.toBeNull();
        expect(captured!.styles.textSpacingTrim, value).toBe(value);
        const segment = captured!.textSegments?.find((part) => part.text === "（「");
        expect(segment?.xOffsets, value).toHaveLength(2);
        const offsets = segment!.xOffsets!.map((x) => x - segment!.xOffsets![0]);
        const svg = renderTextAsPath("（「", 0, 0, {
          fontFamily: "Hiragino Sans",
          fontSize: 16,
          fontWeight: "400",
          fill: "#000",
          xOffsets: offsets,
          textSpacingTrim: captured!.styles.textSpacingTrim,
          lang: "ja",
        });
        const positions = [...svg.matchAll(/<use\b[^>]*\bx="([^"]+)"/g)].map((match) => Number(match[1]));
        expect(positions, value).toHaveLength(2);
        const scale = 16 / 1000; // Hiragino Sans units per em.
        const inkShift = positions.map((x, index) => x - offsets[index] / scale);
        expect(inkShift, value).toEqual(value === "normal" ? [0, -500] : value === "space-all" ? [0, 0] : [-500, -500]);
      }
    } finally {
      setRenderTextMode(previousMode);
      await page.close();
    }
  });

  it("owns soft-wrap starts and qualifying close ends without trimming a paragraph end", async () => {
    const page = await browser!.newPage({ viewport: { width: 400, height: 300 } });
    const previousMode = getRenderTextMode();
    try {
      await page.setContent(`
        <style>body{margin:0}div{font:16px/1 Hiragino Sans;overflow-wrap:anywhere}</style>
        <div id="wrap-space-first" data-domotion-anim="wrap-space-first" lang="ja" style="width:24px;text-spacing-trim:space-first">あ「い</div>
        <div id="wrap-normal" data-domotion-anim="wrap-normal" lang="ja" style="width:32px;text-spacing-trim:normal">あ「い</div>
        <div id="close-halt" data-domotion-anim="close-halt" lang="ja" style="width:24px;text-spacing-trim:normal">あ）い</div>
        <div id="close-full" data-domotion-anim="close-full" lang="ja" style="width:32px;text-spacing-trim:normal">あ）い</div>
        <div id="paragraph-end" data-domotion-anim="paragraph-end" lang="ja" style="width:48px;text-spacing-trim:normal">あ）</div>
        <div id="hard-break" data-domotion-anim="hard-break" lang="ja" style="white-space:pre-line;text-spacing-trim:space-first">あ\n「い</div>
      `);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 300 });
      const parts = (id: string) => {
        const node = findByAnimId(tree, id);
        expect(node, id).not.toBeNull();
        return node!.textSegments!;
      };
      const spaceFirst = parts("wrap-space-first");
      const normal = parts("wrap-normal");
      expect(spaceFirst.map((part) => part.text)).toEqual(["あ", "「い"]);
      expect(normal.map((part) => part.text)).toEqual(["あ", "「い"]);
      expect(spaceFirst[0].hanKerningLineStart).toBe("paragraph");
      expect(spaceFirst[1].hanKerningLineStart).toBe("wrapped");
      expect(normal[1].hanKerningLineStart).toBe("wrapped");

      setRenderTextMode("paths");
      for (const [segment, policy, expected] of [
        [spaceFirst[1], "space-first", -500],
        [normal[1], "normal", 0],
      ] as const) {
        const offsets = segment.xOffsets!.map((x) => x - segment.xOffsets![0]);
        const svg = renderTextAsPath(segment.text, 0, 0, {
          fontFamily: "Hiragino Sans",
          fontSize: 16,
          fontWeight: "400",
          fill: "#000",
          xOffsets: offsets,
          textSpacingTrim: policy,
          hanKerningLineStart: segment.hanKerningLineStart,
          lang: "ja",
        });
        const firstX = Number(svg.match(/<use\b[^>]*\bx="([^"]+)"/)?.[1]);
        expect(firstX, policy).toBe(expected);
      }

      expect(parts("close-halt").map((part) => part.text)).toEqual(["あ）", "い"]);
      expect(parts("close-halt")[0].hanKerningWrappedEndAdvance).toBe(8);
      expect(parts("close-full").map((part) => part.text)).toEqual(["あ）", "い"]);
      expect(parts("close-full")[0].hanKerningWrappedEndAdvance).toBe(16);
      expect(parts("paragraph-end")).toHaveLength(1);
      expect(parts("paragraph-end")[0].hanKerningWrappedEndAdvance).toBeUndefined();
      expect(parts("hard-break").map((part) => part.text)).toEqual(["あ", "「い"]);
      expect(parts("hard-break")[1].hanKerningLineStart).toBe("fragment");
      expect(parts("hard-break")[0].hanKerningWrappedEndAdvance).toBeUndefined();
    } finally {
      setRenderTextMode(previousMode);
      await page.close();
    }
  });
});
