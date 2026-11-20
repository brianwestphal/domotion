import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { createRasterViewportSpace, mapRectThroughAffine } from "../src/capture/raster-viewport-space.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
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

describeBrowser("transformed flex descendant logical geometry", () => {
  it("keeps live, capture, and emitted geometry source-equivalent across the matrix", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 520, height: 440 } });
    const source = await context.newPage();
    const rendered = await context.newPage();
    const wrapperPairs = new Map<string, Rect[]>();
    try {
      for (const scale of scales)
        for (const origin of origins)
          for (const wrapper of [false, true]) {
            const inner = '<div id="a" data-domotion-anim="a"></div><div id="b" data-domotion-anim="b"></div>';
            await source.setContent(
              `<style>html,body{margin:0}.host{margin:31.25px;width:200px;height:300px;transform:scale(${scale});transform-origin:${origin};display:flex;flex-direction:column;gap:9.625px;padding:10.375px}.host>*,.wrap>*{width:103.375px;height:40.625px}.wrap{display:contents}#a{background:#dc2626;transform:translateY(-5.25px)}#b{background:#3fb950;transform:translateY(10.375px)}</style><div class="host" data-domotion-anim="host">${wrapper ? `<div class="wrap">${inner}</div>` : inner}</div>`,
            );
            const live = (await source.evaluate(() =>
              Object.fromEntries(
                ["a", "b"].map((id) => {
                  const r = document.getElementById(id)!.getBoundingClientRect();
                  return [id, { x: r.x, y: r.y, width: r.width, height: r.height }];
                }),
              ),
            )) as Record<string, Rect>;
            const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: 520, height: 440 });
            // Static transforms are frozen: the captured box is local and the
            // emitted CTM (ancestor and own transforms) maps it to the live rect
            // — plus the paint-only rounding of the host's paint offset. Blink
            // paints a non-translation transform's subtree from its ROUNDED paint
            // offset (ToRoundedVector2d, paint_property_tree_builder.cc:748 at
            // Chromium 7d859f27, with the subpixel accumulation dropped,
            // :652-686), which getBoundingClientRect does not model: the host's
            // 31.25px offset paints 0.25px up and left of the DOM geometry.
            const paintShift = scale === 1 ? 0 : Math.round(31.25) - 31.25;
            const space = createRasterViewportSpace(tree);
            for (const id of ["a", "b"]) {
              const captured = find(tree, id)!;
              const local = { x: captured.x, y: captured.y, width: captured.width, height: captured.height };
              const ctm = space.frozenCtm(captured);
              const mapped = ctm == null ? local : mapRectThroughAffine(local, ctm);
              expect(mapped.x).toBeCloseTo(live[id].x + paintShift, 3);
              expect(mapped.y).toBeCloseTo(live[id].y + paintShift, 3);
              expect(mapped.width).toBeCloseTo(live[id].width, 3);
              expect(mapped.height).toBeCloseTo(live[id].height, 3);
            }
            await rendered.setContent(`<body style="margin:0">${elementTreeToSvg(tree, 520, 440)}</body>`);
            for (const id of ["a", "b"]) {
              const box = await rendered.locator(`.anim-${id}`).boundingBox();
              expect(box).not.toBeNull();
              // The background itself is painted at Blink's pixel-snapped local
              // rect (ToPixelSnappedRect, box_painter_base.cc:1265), recorded as
              // the box's border paint snap; map that rect through the same CTM.
              const captured = find(tree, id)!;
              const snap = captured.borderPaintSnap;
              const left = captured.x + (snap?.left ?? 0),
                top = captured.y + (snap?.top ?? 0);
              const painted = {
                x: left,
                y: top,
                width: captured.x + captured.width + (snap?.right ?? 0) - left,
                height: captured.y + captured.height + (snap?.bottom ?? 0) - top,
              };
              const ctm = space.frozenCtm(captured);
              const expected = ctm == null ? painted : mapRectThroughAffine(painted, ctm);
              // Rect coordinates are written with one decimal (r()), so a
              // painted edge may sit up to 0.05 local px (times the scale) off.
              const quantum = 0.05 * Math.max(1, scale) + 1e-6;
              for (const key of ["x", "y", "width", "height"] as const) {
                expect(Math.abs(box![key] - expected[key]), key).toBeLessThanOrEqual(2 * quantum);
              }
              // …and the snap moves an edge by at most half a local pixel.
              expect(Math.abs(expected.x - (live[id].x + paintShift))).toBeLessThanOrEqual(0.5 * scale + 1e-6);
              expect(Math.abs(expected.y - (live[id].y + paintShift))).toBeLessThanOrEqual(0.5 * scale + 1e-6);
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
          expect(
            Math.abs(moved[0].x - zeroOrigin[0].x) + Math.abs(moved[0].y - zeroOrigin[0].y),
            "ignored origin mutation",
          ).toBeGreaterThan(1);
        }
      }
    } finally {
      await context.close();
    }
  }, 60_000);
});
