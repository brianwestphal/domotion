import { afterAll, describe, expect, it } from "vitest";

import type { CapturedElement, TextSegment } from "../src/capture/types.js";
import { launchChromium } from "../src/index.js";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import {
  blinkUsesTextCombine,
  resolveVerticalOrientations,
} from "../src/vertical-orientation.js";

interface Fixture {
  id: string;
  text: string;
  writingMode: "vertical-rl" | "vertical-lr" | "sideways-rl" | "sideways-lr";
  textOrientation: "mixed" | "upright" | "sideways";
  textCombine: "none" | "all";
  lang: string;
}

const fixtures: readonly Fixture[] = [
  { id: "mixed-en", text: "A\u20dd§漢\u{e0101}🂡\u0300", writingMode: "vertical-rl", textOrientation: "mixed", textCombine: "none", lang: "en" },
  { id: "mixed-ja", text: "「漢」A\u20dd", writingMode: "vertical-rl", textOrientation: "mixed", textCombine: "none", lang: "ja" },
  { id: "mixed-ko", text: "한A🂡", writingMode: "vertical-lr", textOrientation: "mixed", textCombine: "none", lang: "ko" },
  { id: "mixed-ar", text: "ب\u0651漢", writingMode: "vertical-rl", textOrientation: "mixed", textCombine: "none", lang: "ar" },
  { id: "supplementary", text: "A\u{30000}\u{e0101}🂡", writingMode: "vertical-lr", textOrientation: "mixed", textCombine: "none", lang: "zh" },
  { id: "upright", text: "Aب漢🂡", writingMode: "vertical-rl", textOrientation: "upright", textCombine: "none", lang: "en" },
  { id: "sideways", text: "漢A🂡", writingMode: "vertical-lr", textOrientation: "sideways", textCombine: "none", lang: "ja" },
  { id: "sideways-rl-all", text: "31漢", writingMode: "sideways-rl", textOrientation: "mixed", textCombine: "all", lang: "ja" },
  { id: "sideways-lr-all", text: "31漢", writingMode: "sideways-lr", textOrientation: "mixed", textCombine: "all", lang: "ja" },
  { id: "combine-rl", text: "31", writingMode: "vertical-rl", textOrientation: "mixed", textCombine: "all", lang: "en" },
  { id: "combine-lr", text: "AB", writingMode: "vertical-lr", textOrientation: "upright", textCombine: "all", lang: "en" },
] as const;

interface LivePoint {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LiveFixture {
  text: string;
  writingMode: string;
  textOrientation: string;
  textCombine: string;
  points: LivePoint[];
}

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function findByAnimId(tree: CapturedElement[], id: string): CapturedElement | null {
  for (const node of tree) {
    if (node.animId === id) return node;
    const child = findByAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

function repeated<T>(points: readonly LivePoint[], value: (point: LivePoint) => T): T[] {
  return points.flatMap((point) => new Array<T>(point.text.length).fill(value(point)));
}

function verticalSegments(node: CapturedElement): TextSegment[] {
  return (node.textSegments ?? []).filter((segment) => segment.verticalWritingMode != null);
}

describeBrowser("Blink-owned vertical orientation capture (DM-2525)", () => {
  it("retains exact Range placement and source orientation across the representative corpus", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 1160, height: 650 } });
    try {
      const markup = fixtures.map((row, index) => {
        const left = 20 + (index % 6) * 185;
        const top = 20 + Math.floor(index / 6) * 300;
        return `<div id="${row.id}" data-domotion-anim="${row.id}" lang="${row.lang}" style="position:absolute;left:${left}px;top:${top}px;height:250px;writing-mode:${row.writingMode};text-orientation:${row.textOrientation};text-combine-upright:${row.textCombine}">${row.text}</div>`;
      }).join("");
      await page.setContent(`<style>html,body{margin:0}.case{}div{font:32px/1.25 Arial,sans-serif;color:#111}</style>${markup}`);

      const live = await page.evaluate((ids): Promise<Record<string, LiveFixture>> => {
        const result: Record<string, LiveFixture> = {};
        for (const id of ids) {
          const element = document.getElementById(id)!;
          const node = element.firstChild!;
          const text = node.textContent ?? "";
          const points: LivePoint[] = [];
          for (let start = 0; start < text.length;) {
            const scalar = String.fromCodePoint(text.codePointAt(start)!);
            const end = start + scalar.length;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            const rect = range.getBoundingClientRect();
            points.push({ text: scalar, start, end, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            start = end;
          }
          const style = getComputedStyle(element);
          result[id] = {
            text,
            writingMode: style.writingMode,
            textOrientation: style.textOrientation,
            textCombine: style.textCombineUpright,
            points,
          };
        }
        return result;
      }, fixtures.map((row) => row.id));

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1160, height: 650 });
      for (const row of fixtures) {
        const node = findByAnimId(tree, row.id);
        expect(node, row.id).not.toBeNull();
        const segments = verticalSegments(node!);
        expect(segments, `${row.id} segment count`).toHaveLength(1);
        const segment = segments[0];
        const source = live[row.id];
        const combine = blinkUsesTextCombine(source.writingMode, source.textCombine);

        expect(segment.text, `${row.id} text`).toBe(source.text);
        expect(segment.verticalWritingMode, `${row.id} writing mode`).toBe(source.writingMode);
        expect(segment.verticalCombineUpright === true, `${row.id} combine ownership`).toBe(combine);

        const minX = Math.min(...source.points.map((point) => point.x));
        const minY = Math.min(...source.points.map((point) => point.y));
        const maxX = Math.max(...source.points.map((point) => point.x + point.width));
        const maxY = Math.max(...source.points.map((point) => point.y + point.height));
        expect({ x: segment.x, y: segment.y, width: segment.width, height: segment.height }, `${row.id} fragment box`)
          .toEqual({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });

        if (combine) {
          expect(segment.verticalCombineXOffsets, `${row.id} combine placement`)
            .toEqual(source.points.map((point) => point.x - minX));
          expect(segment.verticalOrientations, `${row.id} combine has no vertical iterator`).toBeUndefined();
        } else {
          const effective = source.writingMode.startsWith("sideways-") ? "sideways" : source.textOrientation;
          expect(segment.verticalOrientations, `${row.id} orientation array`)
            .toEqual(resolveVerticalOrientations(source.text, effective));
          expect(segment.yOffsets, `${row.id} y placement`).toEqual(repeated(source.points, (point) => point.y));
          expect(segment.verticalAdvances, `${row.id} captured advances`)
            .toEqual(repeated(source.points, (point) => point.height));
        }
      }
    } finally {
      await page.close();
    }
  }, 90_000);
});
