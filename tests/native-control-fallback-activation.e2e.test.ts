import { afterAll, describe, expect, it } from "vitest";

import {
  captureElementTreeWithWarnings,
  elementTreeToSvgInner,
  launchChromium,
} from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { formControlRenderRoute } from "../src/render/form-controls.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

async function setup() {
  try {
    return { browser: await launchChromium({ args: ["--enable-blink-features=AppearanceBase"] }) };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function byId(tree: CapturedElement[], id: string): CapturedElement {
  const result = walk(tree).find((node) => node.animId === id);
  expect(result, id).toBeDefined();
  return result!;
}

const COMPLETE_NATIVE = [
  "native-checkbox", "native-radio", "native-range", "native-progress",
  "native-meter", "native-date", "native-select",
] as const;

const STRUCTURAL = [
  "author-checkbox", "author-radio", "author-range", "author-progress",
  "author-meter", "native-file", "author-file", "author-date", "author-select",
] as const;

describeBrowser("DM-2458 native-control fallback activation matrix", () => {
  it("keeps native, split, and structural ownership source-complete across platform-sensitive media", async () => {
    const rows = [
      { dpr: 1, scheme: "light" as const, forced: "none" as const, direction: "ltr", zoom: "1" },
      { dpr: 2, scheme: "dark" as const, forced: "none" as const, direction: "rtl", zoom: "1.25" },
      { dpr: 1, scheme: "light" as const, forced: "active" as const, direction: "rtl", zoom: ".85" },
    ];

    for (const row of rows) {
      const viewport = { width: 1120, height: 760 };
      const context = await env!.browser.newContext({
        viewport,
        deviceScaleFactor: row.dpr,
        colorScheme: row.scheme,
        forcedColors: "none",
      });
      const page = await context.newPage();
      try {
        await page.emulateMedia({ forcedColors: row.forced });
        await page.setContent(`<!doctype html><style>
          html,body{margin:0;background:Canvas;color:CanvasText;color-scheme:light dark}
          main{display:grid;grid-template-columns:repeat(4,240px);gap:18px;padding:22px;
            direction:${row.direction};zoom:${row.zoom};font:16px Arial}
          input,select,progress,meter{width:210px;min-height:28px;accent-color:rgb(197,31,102)}
          .check{width:28px;height:28px;margin:0}
          .author-check{appearance:none;border:2px solid rgb(29,94,181);background:rgb(228,241,253)}
          .author-check::before{content:"";display:block;width:12px;height:12px;margin:6px;background:rgb(197,31,102)}
          .author-range{appearance:none;height:32px;background:transparent;border:0}
          .author-range::-webkit-slider-runnable-track{height:8px;background:rgb(21,101,192);border:1px solid rgb(8,48,107);border-radius:4px}
          .author-range::-webkit-slider-thumb{appearance:none;width:22px;height:18px;background:rgb(244,114,182);border:2px solid rgb(131,24,67);border-radius:5px;margin-top:-6px}
          .author-progress,.author-meter{appearance:none;border:3px solid rgb(88,28,135);background:rgb(243,232,255)}
          .author-progress::-webkit-progress-bar{background:rgb(243,232,255);border-radius:6px}
          .author-progress::-webkit-progress-value{background:rgb(126,34,206);border-radius:4px}
          .author-meter::-webkit-meter-bar{background:rgb(243,232,255);border-radius:6px}
          .author-meter::-webkit-meter-optimum-value{background:rgb(126,34,206)}
          .author-file::file-selector-button{background:rgb(30,64,175);color:white;border:2px solid rgb(23,37,84);border-radius:7px}
          .author-date{background:rgb(224,242,254);border:2px solid rgb(3,105,161)}
          .author-select{background:rgb(236,253,245);border:2px solid rgb(4,120,87)}
          #hidden-marker summary{list-style:none}
        </style><main id="scene">
          <input data-domotion-anim="native-checkbox" class="check" type="checkbox" checked disabled>
          <input data-domotion-anim="native-radio" class="check" type="radio" checked>
          <input data-domotion-anim="native-range" type="range" min="0" max="100" value="37">
          <progress data-domotion-anim="native-progress" max="1" value=".42"></progress>
          <meter data-domotion-anim="native-meter" min="0" max="1" low=".3" high=".7" optimum=".5" value=".82"></meter>
          <input data-domotion-anim="native-file" type="file" multiple>
          <input data-domotion-anim="native-date" type="date" value="2026-08-22">
          <select data-domotion-anim="native-select"><option selected>native option</option></select>
          <input data-domotion-anim="author-checkbox" class="check author-check" type="checkbox" checked>
          <input data-domotion-anim="author-radio" class="check author-check" type="radio" checked>
          <input data-domotion-anim="author-range" class="author-range" type="range" min="0" max="100" value="63">
          <progress data-domotion-anim="author-progress" class="author-progress" max="1" value=".58"></progress>
          <meter data-domotion-anim="author-meter" class="author-meter" min="0" max="1" optimum=".5" value=".52"></meter>
          <input data-domotion-anim="author-file" class="author-file" type="file">
          <input data-domotion-anim="author-date" class="author-date" type="date" value="2026-08-22">
          <select data-domotion-anim="author-select" class="author-select"><option selected>structural option</option></select>
          <details open><summary data-domotion-anim="source-marker">source marker</summary><p>content</p></details>
          <details id="hidden-marker" open><summary data-domotion-anim="hidden-marker">hidden marker</summary><p>content</p></details>
        </main>`);

        const capture = await captureElementTreeWithWarnings(
          page, "#scene", { x: 0, y: 0, ...viewport },
        );
        expect(capture.warnings.filter(({ feature }) =>
          feature === "effective-appearance-cascade"
          || feature === "native-control-raster"
          || feature === "native-control-decoration-raster"
        )).toEqual([]);

        for (const id of COMPLETE_NATIVE) {
          const control = byId(capture.tree, id);
          expect(formControlRenderRoute(control), id).toBe("native-raster");
          expect(control.nativeControlRaster?.dataUri, id).toMatch(/^data:image\/png;base64,/);
        }
        for (const id of STRUCTURAL) {
          const control = byId(capture.tree, id);
          expect(formControlRenderRoute(control), id).toBe("structural");
          expect(control.nativeControlRaster, id).toBeUndefined();
        }

        expect(byId(capture.tree, "native-file").nativeControlDecorationRaster?.kinds)
          .toEqual(["file-selector-button"]);
        expect(byId(capture.tree, "author-file").nativeControlDecorationRaster).toBeUndefined();
        expect(byId(capture.tree, "author-date").nativeControlDecorationRaster?.kinds)
          .toEqual(["calendar-picker-indicator"]);
        expect(byId(capture.tree, "author-select").nativeControlDecorationRaster?.kinds)
          .toEqual(["menulist-button-arrow"]);
        expect(byId(capture.tree, "source-marker").summaryMarkerGeometry).toBeDefined();
        expect(byId(capture.tree, "hidden-marker").summaryMarkerGeometry).toBeUndefined();

        const svg = elementTreeToSvgInner(capture.tree, viewport.width, viewport.height);
        expect(svg).not.toContain("rgb(0,117,255)");
        expect(svg).not.toContain("rgb(203,203,203)");
        expect(svg).not.toContain("Choose File</text>");
        expect(svg).toContain("data-domotion-pseudo-owner=\"source-fragments\"");
      } finally {
        await context.close();
      }
    }
  }, 180_000);
});
