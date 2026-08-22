import { afterAll, describe, expect, it } from "vitest";

import {
  cullElementsOutsideViewBox,
  elementTreeToSvgInner,
  generateAnimatedSvg,
  launchChromium,
  type CapturedElement,
  type IntraFrameAnimation,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const browser = await launchChromium().catch(() => null);
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser == null ? describe.skip : describe;

const WIDTH = 330;
const HEIGHT = 200;

function styles(backgroundColor: string): CapturedElement["styles"] {
  return {
    backgroundColor,
    backgroundImage: "none",
    backgroundClip: "border-box",
    borderColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    color: "rgb(0, 0, 0)",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
    filter: "none",
    backdropFilter: "none",
    mixBlendMode: "normal",
    clipPath: "none",
    mask: "none",
    maskImage: "none",
    boxShadow: "none",
    outlineStyle: "none",
    outlineWidth: "0px",
    outlineOffset: "0px",
    transform: "none",
    transformOrigin: "50% 50%",
  } as CapturedElement["styles"];
}

function discriminatorTree(): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    animId: "glide",
    styles: styles("rgba(0, 0, 0, 0)"),
    children: [{
      tag: "div",
      text: "",
      x: 300,
      y: 100,
      width: 20,
      height: 20,
      styles: styles("rgb(220, 20, 60)"),
      children: [],
    }],
  };
}

const GLIDE: IntraFrameAnimation = {
  animId: "glide",
  property: "transform",
  from: "scale(1)",
  to: "scale(.5)",
  transformOrigin: "100% 100%",
  transformBox: "fill-box",
  duration: 1000,
  easing: "linear",
};

describeBrowser("DM-2460 live Chromium renderer-owned culling discriminator", () => {
  it("uses the generated group fill box at zoom and DPR variants", async () => {
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser!.newContext({
        viewport: { width: 520, height: 320 },
        deviceScaleFactor,
      });
      try {
        for (const zoom of [1, 1.25]) {
          const tree = discriminatorTree();
          const { css } = cullElementsOutsideViewBox(tree, WIDTH, HEIGHT, [GLIDE], 0, 1000);
          // Positive activation: offset descendant owns the generated fill-box.
          // Negative activation: no displayNone or cull class is emitted.
          expect(css).toBe("");
          expect(tree.displayNone).toBeFalsy();
          expect(tree.children[0].displayNone).toBeFalsy();

          const inner = elementTreeToSvgInner([tree], WIDTH, HEIGHT);
          const svg = generateAnimatedSvg({
            width: WIDTH,
            height: HEIGHT,
            frames: [{
              svgContent: inner,
              duration: 1000,
              animations: [GLIDE],
              cullCss: css,
            }],
          });
          const page = await context.newPage();
          try {
            await page.setContent(`<style>html,body{margin:0}svg{display:block;zoom:${zoom}}</style>${svg}`);
            const result = await page.evaluate(async () => {
              for (const animation of document.getAnimations()) {
                animation.pause();
                animation.currentTime = 999.9;
              }
              await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              const owner = document.querySelector<SVGGElement>(".anim-glide")!;
              const painted = owner.querySelector<SVGRectElement>("rect")!;
              const root = document.querySelector<SVGSVGElement>("svg")!;
              const bbox = owner.getBBox();
              const rect = painted.getBoundingClientRect();
              const rootRect = root.getBoundingClientRect();
              return {
                dpr: devicePixelRatio,
                transformBox: getComputedStyle(owner).transformBox,
                bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
                painted: {
                  left: rect.left - rootRect.left,
                  top: rect.top - rootRect.top,
                  right: rect.right - rootRect.left,
                  bottom: rect.bottom - rootRect.top,
                },
                root: { width: rootRect.width, height: rootRect.height },
              };
            });

            expect(result.dpr).toBe(deviceScaleFactor);
            expect(result.transformBox).toBe("fill-box");
            expect(result.bbox.x).toBeCloseTo(300, 4);
            expect(result.bbox.y).toBeCloseTo(100, 4);
            expect(result.bbox.width).toBeCloseTo(20, 4);
            expect(result.bbox.height).toBeCloseTo(20, 4);
            expect(result.root.width).toBeCloseTo(WIDTH * zoom, 3);
            expect(result.root.height).toBeCloseTo(HEIGHT * zoom, 3);
            expect(result.painted.left).toBeCloseTo(310 * zoom, 1);
            expect(result.painted.right).toBeCloseTo(320 * zoom, 1);
            expect(result.painted.top).toBeCloseTo(110 * zoom, 1);
            expect(result.painted.bottom).toBeCloseTo(120 * zoom, 1);
            // Carrier-box mutation: origin (400,200) would paint
            // x=350..360, wholly beyond this 330-wide SVG.
            expect(350 * zoom).toBeGreaterThan(result.root.width);
            expect(result.painted.right).toBeLessThan(result.root.width);
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});
