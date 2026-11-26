import { chromium } from "@playwright/test";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

// Slider track and thumb box-shadows are captured from the real UA-shadow
// pseudo nodes and painted by the general box-shadow painters: an offset +
// blur drop shadow and an inset glow on both pseudos.
describe("range pseudo box-shadow", () => {
  it("captures the track and thumb shadow lists and paints offset, blur and inset", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 80 } });
    try {
      await page.setContent(`<!doctype html><style>body{margin:0}
        input{appearance:none;display:block;width:300px;height:32px;margin:16px 20px}
        input::-webkit-slider-runnable-track{height:12px;border-radius:6px;background:#e2e8f0;
          box-shadow:inset 0 2px 3px rgba(0,0,0,.45),0 3px 0 #94a3b8}
        input::-webkit-slider-thumb{appearance:none;width:24px;height:24px;margin-top:-6px;border-radius:50%;
          background:#2563eb;box-shadow:0 4px 6px rgba(0,0,0,.5),inset 0 -3px 3px rgba(0,0,0,.4)}
      </style><main id="scene"><input type="range" value="30"></main>`);
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 360, height: 80 });
      const input = flatten(result.tree).find((element) => element.tag === "input");
      expect(input?.styles.rangeTrackBoxShadow).toBe(
        "rgba(0, 0, 0, 0.45) 0px 2px 3px 0px inset, rgb(148, 163, 184) 0px 3px 0px 0px",
      );
      expect(input?.styles.rangeThumbBoxShadow).toBe(
        "rgba(0, 0, 0, 0.5) 0px 4px 6px 0px, rgba(0, 0, 0, 0.4) 0px -3px 3px 0px inset",
      );

      const svg = elementTreeToSvg(result.tree, 360, 80);
      // Track outer (solid offset) shadow, thumb outer blur, and two inset donuts.
      expect(svg).toContain('fill="rgb(148,163,184)"');
      expect(svg.match(/fill-rule="evenodd"/g)?.length).toBe(2);
      // The thumb's blurred outer shadow is a black shape whose mask-blit
      // filter writes the 50% alpha table (DM-RRWR8E).
      expect(svg).toMatch(/fill="black" filter="url\(#/);
      expect(svg).toMatch(/<feFuncA type="discrete" tableValues="0\.0020 0\.0059 /);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it.each([
    { ancestor: 1, track: 1, thumb: 1, value: 50, trackHeight: "10px", thumbWidth: "14px", red: 4, blue: -4 },
    { ancestor: 1.25, track: 1, thumb: 1, value: 50, trackHeight: "12.5px", thumbWidth: "17.5px", red: 5, blue: -5 },
    { ancestor: 2, track: 1, thumb: 1, value: 30, trackHeight: "20px", thumbWidth: "28px", red: 8, blue: -8 },
    { ancestor: 2, track: 0.75, thumb: 4 / 3, value: 30, trackHeight: "15px", thumbWidth: "28px", red: 6, blue: -8 },
  ])(
    "matches native part and shadow pixels at zoom $ancestor / $track / $thumb",
    async (fixture) => {
      const browser = await chromium.launch({ headless: true });
      const viewport = { x: 0, y: 0, width: 370, height: 100 };
      const page = await browser.newPage({ viewport });
      const base = "<!doctype html><style>body{margin:0;background:white}</style>";
      const pixels = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
      try {
        await page.setContent(`${base}<style>
        main{zoom:${fixture.ancestor}}
        input{appearance:none;display:block;position:absolute;left:20px;top:10px;
          margin:0;width:140px;height:24px;border:0;padding:0}
        input::-webkit-slider-runnable-track{zoom:${fixture.track};height:10px;
          background:#242424;box-shadow:0 4px 0 red}
        input::-webkit-slider-thumb{zoom:${fixture.thumb};appearance:none;width:14px;height:10px;
          background:#555;box-shadow:0 -4px 0 rgb(0,80,255)}
      </style><main><input type="range" value="${fixture.value}"></main>`);
        const native = await pixels(await page.screenshot());
        const result = await captureElementTreeWithWarnings(page, "body", viewport);
        const input = flatten(result.tree).find((element) => element.tag === "input");
        expect(result.warnings).toEqual([]);
        expect(input).toMatchObject({
          x: 20 * fixture.ancestor,
          y: 10 * fixture.ancestor,
          width: 140 * fixture.ancestor,
          height: 24 * fixture.ancestor,
          styles: {
            rangeTrackHeight: fixture.trackHeight,
            rangeThumbWidth: fixture.thumbWidth,
            rangeTrackBoxShadow: `rgb(255, 0, 0) 0px ${fixture.red}px 0px 0px`,
            rangeThumbBoxShadow: `rgb(0, 80, 255) 0px ${fixture.blue}px 0px 0px`,
          },
        });
        expect(input?.styles.rangePartGeometry != null).toBe(fixture.ancestor !== 1);
        if (fixture.ancestor === 2 && fixture.track === 1) {
          let redPixels = 0;
          for (let i = 0; i < native.length; i += 4) {
            if (native[i] === 255 && native[i + 1] === 0 && native[i + 2] === 0) redPixels++;
          }
          expect(redPixels).toBe(2240);
          expect(native.subarray(4 * (54 * viewport.width + 40), 4 * (54 * viewport.width + 40) + 4)).toEqual(
            Buffer.from([255, 0, 0, 255]),
          );
        }
        const svg = elementTreeToSvg(result.tree, viewport.width, viewport.height);
        expect(svg).not.toContain("<image");
        await page.setContent(base + svg);
        const captured = await pixels(await page.screenshot());
        expect(captured.equals(native)).toBe(true);
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});
