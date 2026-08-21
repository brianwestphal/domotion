import { afterAll, describe, expect, it } from "vitest";
import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

function clipBody(svg: string, marker: "ov" | "irc"): string {
  const match = new RegExp(`<clipPath id="[^"]*${marker}[^"]*">([\\s\\S]*?)<\\/clipPath>`).exec(svg);
  expect(match, `${marker} clipPath`).not.toBeNull();
  return match![1];
}

function rectGeometry(markup: string): { x: number; y: number; width: number; height: number } {
  const number = (name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(markup)![1]);
  return { x: number("x"), y: number("y"), width: number("width"), height: number("height") };
}

describeBrowser("DM-2419: Chromium overflow-clip-margin capture oracle", () => {
  it("scales the computed length once under CSS zoom and remains DPR-independent", async () => {
    const rows: Array<{ dpr: number; margin: string; geometry: ReturnType<typeof rectGeometry> }> = [];
    for (const dpr of [1, 2]) {
      const page = await env!.browser.newPage({ viewport: { width: 360, height: 220 }, deviceScaleFactor: dpr });
      try {
        await page.setContent(`<style>html,body{margin:0}#host{
          position:absolute;left:10px;top:12px;box-sizing:border-box;
          width:80px;height:48px;zoom:1.25;border:2px solid black;
          overflow:clip;overflow-clip-margin:border-box 8px
        }#host>i{position:absolute;inset:-30px;background:red}</style>
        <div id="host" data-domotion-anim="host"><i></i></div>`);
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 220 });
        const host = byAnimId(tree, "host")!;
        expect(host).not.toBeNull();
        const svg = elementTreeToSvgInner(tree, 360, 220);
        rows.push({ dpr, margin: host.styles.overflowClipMargin!, geometry: rectGeometry(clipBody(svg, "ov")) });
      } finally {
        await page.close();
      }
    }
    expect(rows[0].margin).toMatch(/border-box/);
    expect(rows[0].margin).toMatch(/10px/); // 8px × effective zoom 1.25
    expect(rows[1].margin).toBe(rows[0].margin);
    expect(rows[1].geometry).toEqual(rows[0].geometry);
  });

  it("retains ref-box-only zero values and rejects a negative declaration in Chromium", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 240 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>html,body{margin:0}.host{position:relative;width:80px;height:40px;border:4px solid black;padding:6px;overflow:clip}.host>i{position:absolute;inset:-20px;background:red}</style>
        <div id="content" class="host" data-domotion-anim="content" style="overflow-clip-margin:content-box"><i></i></div>
        <div id="border" class="host" data-domotion-anim="border" style="overflow-clip-margin:border-box"><i></i></div>
        <div id="negative" class="host" data-domotion-anim="negative" style="overflow-clip-margin:-4px"><i></i></div>`);
      const browserValues = await page.evaluate(() => ({
        supportsNegative: CSS.supports("overflow-clip-margin", "-4px"),
        content: getComputedStyle(document.querySelector("#content")!).overflowClipMargin,
        border: getComputedStyle(document.querySelector("#border")!).overflowClipMargin,
        negative: getComputedStyle(document.querySelector("#negative")!).overflowClipMargin,
      }));
      expect(browserValues.supportsNegative).toBe(false);
      expect(browserValues.content).toContain("content-box");
      expect(browserValues.border).toContain("border-box");
      expect(browserValues.negative).toBe("0px");

      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 240 });
      expect(byAnimId(tree, "content")!.styles.overflowClipMargin).toContain("content-box");
      expect(byAnimId(tree, "border")!.styles.overflowClipMargin).toContain("border-box");
      expect(byAnimId(tree, "negative")!.styles.overflowClipMargin).toBe("0px");
    } finally {
      await page.close();
    }
  });

  it("activates non-visible overflow on a replaced image but not an ordinary scroll container", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 420, height: 220 }, deviceScaleFactor: 1 });
    try {
      const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
      await page.setContent(`<style>html,body{margin:0}.box{
        position:absolute;top:30px;box-sizing:border-box;width:40px;height:30px;
        border:4px solid black;border-radius:12px;overflow:hidden;
        overflow-clip-margin:border-box 6px;object-fit:none
      }</style>
      <img class="box" style="left:30px" data-domotion-anim="replaced" src="${image}">
      <div class="box" style="left:130px" data-domotion-anim="ordinary"><i style="position:absolute;inset:-20px;background:red"></i></div>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 220 });
      const replaced = byAnimId(tree, "replaced")!;
      const ordinary = byAnimId(tree, "ordinary")!;
      expect(replaced.styles.overflowX).toBe("hidden");
      expect(ordinary.styles.overflowX).toBe("hidden");

      const replacedSvg = elementTreeToSvgInner([replaced], 420, 220);
      const ordinarySvg = elementTreeToSvgInner([ordinary], 420, 220);
      expect(rectGeometry(clipBody(replacedSvg, "irc"))).toEqual({ x: 24, y: 24, width: 52, height: 42 });
      // Ordinary overflow:hidden is a scroll-container path: its margin is
      // inactive and the descendant clip stays at the 4px padding edge.
      expect(rectGeometry(clipBody(ordinarySvg, "ov"))).toEqual({ x: 134, y: 34, width: 32, height: 22 });
    } finally {
      await page.close();
    }
  });
});
