import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  captureElementTree,
  elementTreeToSvgInner,
  launchChromium,
  type CapturedElement,
} from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const WIDTH = 560;
const HEIGHT = 280;
const browser = await launchChromium({ headless: true }).catch(() => null);
afterAll(async () => closeBrowserSafely(browser), 15_000);
const describeBrowser = browser == null ? describe.skip : describe;

interface InkBounds { left: number; top: number; right: number; bottom: number; pixels: number }

async function inkBounds(png: Buffer): Promise<InkBounds> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1, pixels = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 3;
      if (data[offset] > 242 && data[offset + 1] > 242 && data[offset + 2] > 242) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y); pixels++;
    }
  }
  return { left, top, right, bottom, pixels };
}

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}

const CASES = [
  { id: "identity-negative", css: "", text: "Identity negative" },
  { id: "translate", css: "transform:translate(17.5px,-8.25px)", text: "Translate affine" },
  { id: "anisotropic", css: "transform:rotate(19deg) scale(-1.3,.7) skewX(11deg)", text: "Signed anisotropic" },
  { id: "skew-reflect", css: "transform:matrix(-1.05,.27,.43,.82,13,-7);transform-origin:73% 18%", text: "Skew reflection" },
  { id: "rtl", css: "direction:rtl;transform:skewY(13deg) scale(.83,1.2)", text: "RTL matrix العربية" },
  { id: "vertical", css: "writing-mode:vertical-rl;height:175px;transform:rotate(11deg) scaleX(-1)", text: "縦書Affine" },
  { id: "vertical-lr", css: "writing-mode:vertical-lr;height:175px;transform:rotate(11deg) scaleX(-1)", text: "縦書左組" },
  { id: "sideways-rl", css: "writing-mode:sideways-rl;height:175px;transform:rotate(11deg) scaleX(-1)", text: "Sideways RL" },
  { id: "sideways-lr", css: "writing-mode:sideways-lr;height:175px;transform:rotate(11deg) scaleX(-1)", text: "Sideways LR" },
  { id: "decorated", css: "transform:rotate(-17deg) scale(1.15,.76);text-decoration:underline wavy;text-shadow:4px 3px 2px #3973db;-webkit-text-stroke:1px #c026d3", text: "Shadow stroke" },
  { id: "wrapped", css: "width:185px;white-space:normal;transform:skewX(16deg) scale(.9,1.12)", text: "Wrapped affine fragments across several physical lines" },
  { id: "zoom-local", outerCss: "zoom:1.35", css: "transform:rotate(23deg) scale(.8,1.1)", text: "Zoom remains local" },
  { id: "content-reference", css: "border:7px solid transparent;padding:9px 21px;transform-box:content-box;transform:rotate(19deg) scale(1.2,.8);transform-origin:100% 0", text: "Content reference" },
  { id: "bitmap-fallback", css: "transform:matrix(.82,.31,-.24,1.14,9,-4)", text: "Affine 🧭 bitmap" },
  { id: "line-clamp", css: "display:-webkit-box;width:210px;white-space:normal;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;transform:rotate(9deg) scale(1.04,.88)", text: "Line clamp affine text continues well beyond the second physical line to retain its generated marker" },
] as const;

describeBrowser("DM-2470 complete affine text paint consumption", () => {
  for (const dpr of [1, 2]) {
    it(`keeps Chromium and SVG text ink bounds aligned across branches at DPR ${dpr}`, async () => {
      const context = await browser!.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: dpr });
      const source = await context.newPage();
      const output = await context.newPage();
      try {
        for (const row of CASES) {
          await source.setContent(`<!doctype html><style>
            html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
            #scene{position:relative;width:100%;height:100%;font:30px/38px Arial,sans-serif}
            #outer{position:absolute;left:176px;top:104px;transform:rotate(7deg) scale(1.08,.92);transform-origin:11px 91%;${"outerCss" in row ? row.outerCss : ""}}
            #target{display:inline-block;color:#151515;white-space:nowrap;transform-origin:13% 82%;${row.css}}
          </style><div id=scene><div id=outer><span id=target>${row.text}</span></div></div>`);
          await source.evaluate(() => document.fonts.ready);
          const tree = await captureElementTree(source, "#scene", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
          const owner = walk(tree).find((element) => element.text.includes(row.text));
          if (row.id === "line-clamp") {
            // CDP does not expose the generated clamp-marker fragment through
            // the ordinary text-fragment protocol. Keep the transformed owner
            // as one source-frame surface instead of reviving scalar geometry.
            expect(walk(tree).some((element) => element.transformSubtreeRaster != null), `${row.id}: fail-closed surface`).toBe(true);
          } else {
            expect(owner?.textPaintGeometry?.neutral, `${row.id}: neutral bundle`).toBeDefined();
            expect(owner?.textPaintGeometry?.fragments.length, `${row.id}: fragment matrix`).toBeGreaterThan(0);
            for (const fragment of owner?.textPaintGeometry?.fragments ?? []) {
              expect(fragment.source, `${row.id}: affine schema`).toBe("blink-text-fragment-affine-v2");
              expect(fragment.lineOrigin.source, `${row.id}: structured line origin`).toBe("blink-text-fragment-line-origin-v1");
              expect(fragment.lineOrigin.primaryFontIntegerAscent, `${row.id}: integer primary ascent`)
                .toBe(Math.round(fragment.lineOrigin.primaryFontIntegerAscent));
              expect(fragment.lineOrigin.effectiveZoom, `${row.id}: neutral zoom`).toBeGreaterThan(0);
              expect(fragment).not.toHaveProperty("baseline");
            }
          }
          const body = elementTreeToSvgInner(tree, WIDTH, HEIGHT);
          expect(body, `${row.id}: scalar wrapper mutation`).not.toMatch(/anisotropicCorrection|cumScale|scale\([^)]*\/[^)]*\)/);
          await output.setContent(`<style>html,body{margin:0;background:white}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${body}</svg>`);
          const [expected, actual] = await Promise.all([
            inkBounds(await source.screenshot({ type: "png" })),
            inkBounds(await output.screenshot({ type: "png" })),
          ]);
          expect(actual.pixels, `${row.id}: SVG emitted ink`).toBeGreaterThan(20 * dpr);
          for (const edge of ["left", "top", "right", "bottom"] as const) {
            expect(Math.abs(actual[edge] - expected[edge]), `${row.id}: ${edge} ink bound`).toBeLessThanOrEqual(4 * dpr);
          }
        }
      } finally {
        await context.close();
      }
    }, 90_000);
  }
});
