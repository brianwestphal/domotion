import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => { try { return { browser: await launchChromium() }; } catch { return null; } })();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;
const scales = [0.5, 0.69, 1, 1.25];
const origins = ["0 0", "50% 50%", "17px 23px"];

type Rect = { x: number; y: number; width: number; height: number };
function find(tree: CapturedElement[], id: string): CapturedElement | null {
  for (const node of tree) {
    if (node.animId === id) return node;
    const child = find(node.children, id);
    if (child) return child;
  }
  return null;
}
const rounded = (value: number) => Math.round(value * 10) / 10;

describeBrowser("transformed flex descendant logical geometry", () => {
  it("keeps live, capture, and emitted geometry source-equivalent across the matrix", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 520, height: 440 } });
    const source = await context.newPage();
    const rendered = await context.newPage();
    const wrapperPairs = new Map<string, Rect[]>();
    try {
      for (const scale of scales) for (const origin of origins) for (const wrapper of [false, true]) {
        const inner = '<div id="a" data-domotion-anim="a"></div><div id="b" data-domotion-anim="b"></div>';
        await source.setContent(`<style>html,body{margin:0}.host{margin:31.25px;width:200px;height:300px;transform:scale(${scale});transform-origin:${origin};display:flex;flex-direction:column;gap:9.625px;padding:10.375px}.host>*,.wrap>*{width:103.375px;height:40.625px}.wrap{display:contents}#a{background:#dc2626;transform:translateY(-5.25px)}#b{background:#3fb950;transform:translateY(10.375px)}</style><div class="host" data-domotion-anim="host">${wrapper ? `<div class="wrap">${inner}</div>` : inner}</div>`);
        const live = await source.evaluate(() => Object.fromEntries(["a", "b"].map((id) => { const r = document.getElementById(id)!.getBoundingClientRect(); return [id, { x: r.x, y: r.y, width: r.width, height: r.height }]; }))) as Record<string, Rect>;
        const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 520, height: 440 });
        for (const id of ["a", "b"]) {
          const captured = find(tree, id)!;
          expect({ x: captured.x, y: captured.y, width: captured.width, height: captured.height }).toEqual(live[id]);
        }
        await rendered.setContent(`<body style="margin:0">${elementTreeToSvg(tree, 520, 440)}</body>`);
        for (const id of ["a", "b"]) {
          const box = await rendered.locator(`.anim-${id}`).boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeCloseTo(rounded(live[id].x), 1);
          expect(box!.y).toBeCloseTo(rounded(live[id].y), 1);
          expect(box!.width).toBeCloseTo(rounded(live[id].width), 1);
          expect(box!.height).toBeCloseTo(rounded(live[id].height), 1);
        }
        const key = `${scale}/${origin}`;
        const values = wrapperPairs.get(key) ?? [];
        values.push(live.a, live.b);
        wrapperPairs.set(key, values);

        if (scale !== 1) {
          expect(Math.abs(live.a.width - 103.375)).toBeGreaterThan(10); // omitted ancestor scale
          expect(Math.abs(live.a.width * scale - live.a.width)).toBeGreaterThan(10); // doubled scale
        }
        const prematureLocalY = 31.25 + Math.round(10.375 - 5.25) * scale;
        expect(Math.abs(live.a.y - prematureLocalY)).toBeGreaterThan(0.01);
      }
      for (const values of wrapperPairs.values()) {
        expect(values).toHaveLength(4);
        expect(values[0]).toEqual(values[2]);
        expect(values[1]).toEqual(values[3]);
      }
      for (const scale of scales.filter((value) => value !== 1)) {
        const zeroOrigin = wrapperPairs.get(`${scale}/0 0`)!;
        for (const origin of origins.slice(1)) {
          const moved = wrapperPairs.get(`${scale}/${origin}`)!;
          expect(Math.abs(moved[0].x - zeroOrigin[0].x) + Math.abs(moved[0].y - zeroOrigin[0].y), "ignored origin mutation").toBeGreaterThan(1);
        }
      }
    } finally { await context.close(); }
  }, 60_000);
});
